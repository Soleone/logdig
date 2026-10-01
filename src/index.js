import { randomUUID } from "node:crypto";
import path from "node:path";
import { JOURNAL_SYSTEM_PROMPT, summaryCachePolicy } from "./journal.js";
import { collectSessions, parseBackfillArgument, writeSessions } from "./session-runner.js";
import { loadSettings } from "./settings.js";
import { progressStatus } from "./cli-status.js";

function requireJournalSettings(settings) {
  if (!settings.cacheDirectory) throw new Error("Run 'logdig init' or set PI_JOURNAL_DIR to a LogDig cache folder");
  if (!settings.dailyDirectory) throw new Error("Run 'logdig init' or set PI_JOURNAL_DAILY_DIR to your daily-notes folder");
  return settings;
}

async function journalSettings() {
  return requireJournalSettings(await loadSettings());
}

function currentSession(ctx) {
  const header = ctx.sessionManager.getHeader();
  if (!header) return undefined;
  const session = {
    header,
    entries: ctx.sessionManager.getEntries(),
    sourcePath: ctx.sessionManager.getSessionFile() || "active Pi session",
  };
  return session;
}

function extensionModelClient(ctx, settings) {
  let model = ctx.model;
  if (settings.model) {
    const slash = settings.model.indexOf("/");
    model = ctx.modelRegistry.find(settings.model.slice(0, slash), settings.model.slice(slash + 1));
    if (!model) throw new Error(`Pi does not have model '${settings.model}' available`);
  }

  return {
    modelLabel: model ? `${model.provider}/${model.id}` : "Pi current model",
    cachePolicy: summaryCachePolicy(settings),
    complete: async (prompt) => {
      if (!model) throw new Error("Pi has no active model for journal generation");
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        throw new Error(`No configured authentication for ${model.provider}/${model.id}. Run /login in Pi, then try /journal again`);
      }
      const context = {
        systemPrompt: JOURNAL_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      };
      const options = { sessionId: randomUUID(), cacheRetention: "none", signal: ctx.signal };
      // Preserve existing provider defaults unless LogDig explicitly selects thinking.
      if (settings.thinkingLevel === undefined) return ctx.modelRegistry.complete(model, context, options);
      return ctx.modelRegistry.streamSimple(model, context, {
        ...options,
        reasoning: settings.thinkingLevel === "off" ? undefined : settings.thinkingLevel,
      }).result();
    },
  };
}

function notify(ctx, message, level = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

function journalProgress(ctx) {
  return ({ index, total, sessionId, project, date, time, status }) => {
    const label = `${date ? `${date}${time ? ` ${time}` : ""} · ` : ""}${project || sessionId}`;
    const message = `LogDig [${index}/${total}] ${label} · ${progressStatus(status || "CHECKING")}`;
    if (ctx.hasUI) ctx.ui.setStatus?.("logdig", message);
    else console.log(message);
  };
}

async function runBackfill(ctx, argument) {
  const settings = await journalSettings();
  const args = argument.split(/\s+/).filter(Boolean);
  const dryRun = args.includes("--dry-run");
  const rangeArgs = args.filter((arg) => arg !== "--dry-run");
  if (rangeArgs.length > 1) throw new Error("Usage: /journal backfill [number-of-days|all] [--dry-run]");
  const range = parseBackfillArgument(rangeArgs[0]);
  notify(ctx, dryRun ? "LogDig preview: no model requests or file changes." : "LogDig: checking recent sessions. Only new or changed summaries need model requests.");
  const found = await collectSessions({
    sessionDirectory: settings.sessionDirectory,
    timeZone: settings.timeZone,
    days: range.days,
    currentSession: currentSession(ctx),
  });
  const client = dryRun ? { cachePolicy: summaryCachePolicy(settings) } : extensionModelClient(ctx, settings);
  const result = await writeSessions(client, found.sessions, settings, { ...found, dryRun, onProgress: journalProgress(ctx) });
  const warnings = [...found.warnings, ...result.errors];
  const summaryCount = `${result.summariesCreated} ${result.summariesCreated === 1 ? "summary" : "summaries"}`;
  const entryCount = `${result.entriesAppended} daily ${result.entriesAppended === 1 ? "entry" : "entries"}`;
  const updateCount = `${result.entriesUpdated} ${result.entriesUpdated === 1 ? "entry" : "entries"}`;
  const summary = dryRun
    ? `LogDig preview: would create ${summaryCount}, reuse ${result.summariesReused}, append ${entryCount}; ${result.entriesSkipped} already present; update ${updateCount}.`
    : `LogDig: ${summaryCount} created, ${result.summariesReused} reused, appended ${entryCount}; ${result.entriesSkipped} already present; updated ${updateCount}.`;
  const details = warnings.length
    ? `\n${warnings.slice(0, 3).join("\n")}${warnings.length > 3 ? `\n${warnings.length - 3} more warnings in the console.` : ""}\nFix the issues and rerun; successful summaries are cached.`
    : result.dates.length ? `\nDaily notes: ${settings.dailyDirectory} (${result.dates.join(", ")})` : "\nNothing to journal in this range. Try /journal backfill 7 --dry-run.";
  notify(ctx, summary + details, warnings.length ? "warning" : dryRun || !result.dates.length ? "info" : "success");
  if (warnings.length) {
    console.warn(warnings.join("\n"));
    if (!ctx.hasUI) process.exitCode = 1;
  }
}

function helpText() {
  return [
    "/journal                 summarize and log the current session",
    "/journal backfill [N]    process sessions active in the last N days (default 3)",
    "/journal backfill all    process every discoverable Pi session",
    "/journal backfill 1 --dry-run    preview without model requests or file changes",
    "",
    "Configure with 'logdig init' or, from a checkout, 'node ./bin/logdig.js init'.",
    "Automatic capture is opt-in. Full summaries live in your configured cache.",
  ].join("\n");
}

export default function (pi) {
  let saving = false;
  pi.registerCommand("journal", {
    description: "Cache layered session summaries and keep Obsidian journal entries current",
    handler: async (argument, ctx) => {
      const [command, ...rest] = argument.trim().split(/\s+/).filter(Boolean);
      if (["help", "--help", "-h"].includes(command)) {
        notify(ctx, helpText());
        return;
      }
      if (saving) {
        notify(ctx, "LogDig is already saving. Please let this run finish before starting another.", "info");
        return;
      }
      saving = true;
      try {
        if (command === "backfill") {
          await runBackfill(ctx, rest.join(" "));
          return;
        }
        if ((command && command !== "current") || rest.length) {
          notify(ctx, helpText(), "warning");
          return;
        }

        const settings = await journalSettings();
        const session = currentSession(ctx);
        if (!session) throw new Error("No active Pi session is available");
        const result = await writeSessions(extensionModelClient(ctx, settings), [session], settings, { onProgress: journalProgress(ctx) });
        if (result.errors.length) throw new Error(result.errors.join("; "));
        if (!result.dailyPaths.length) {
          notify(ctx, "Nothing to journal yet. Send a message to Pi, then run /journal.");
        } else {
          const saved = result.entriesAppended || result.entriesUpdated;
          notify(ctx, `${saved ? `Saved ${settings.dailySummary} summary` : "Already in your journal"}: ${result.dailyPaths.join(", ")}\nFull summaries: ${path.join(settings.cacheDirectory, "Sessions")}`, "success");
        }
      } catch (error) {
        notify(ctx, `LogDig could not save: ${error.message}`, "error");
        if (!ctx.hasUI) process.exitCode = 1;
      } finally {
        saving = false;
        if (ctx.hasUI) ctx.ui.setStatus?.("logdig", undefined);
      }
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (saving) return;
    saving = true;
    try {
      const savedSettings = await loadSettings();
      if (!savedSettings.autoCapture) return;
      const settings = requireJournalSettings(savedSettings);
      notify(ctx, "LogDig: capturing recent sessions before shutdown. New summaries may take a few minutes.");
      const found = await collectSessions({
        sessionDirectory: settings.sessionDirectory,
        timeZone: settings.timeZone,
        days: 2,
        currentSession: currentSession(ctx),
      });
      const result = await writeSessions(extensionModelClient(ctx, settings), found.sessions, settings, { ...found, onProgress: journalProgress(ctx) });
      const warnings = [...found.warnings, ...result.errors];
      if (warnings.length) console.error(`LogDig automatic capture needs attention:\n${warnings.join("\n")}\nRun 'logdig doctor', then retry with 'logdig backfill 3'.`);
    } catch (error) {
      console.error(`LogDig could not capture recent sessions: ${error.message}. Run 'logdig doctor' to check your setup.`);
    } finally {
      saving = false;
      if (ctx.hasUI) ctx.ui.setStatus?.("logdig", undefined);
    }
  });
}
