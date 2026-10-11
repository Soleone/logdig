#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { listJournaledSessions, summaryCachePolicy } from "../src/journal.js";
import { collectSessions, parseBackfillArgument, writeSessions } from "../src/session-runner.js";
import { createSummaryClient, resolveSummaryBackend, summaryBackendFor } from "../src/summary-backends.js";
import { claudeHistoryDirectory } from "../src/session-sources.js";
import { spawnCommand } from "../src/command-process.js";
import { environmentOverrides, loadSettings, validateSettings } from "../src/settings.js";
import { checkDirectory } from "../src/directories.js";
import { configureLogDig } from "../src/setup.js";
import { editConfig } from "../src/config-menu.js";
import { statusPrefix, statusPrefixWidth } from "../src/cli-status.js";
import { createBackfillProgress } from "../src/backfill-progress.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const relativeEntry = path.relative(process.cwd(), fileURLToPath(import.meta.url)).split(path.sep).join("/");
const entryArgument = relativeEntry.startsWith(".") ? relativeEntry : `./${relativeEntry}`;
const installedPackage = path.basename(path.dirname(path.resolve(packageRoot))) === "node_modules";
const commandName = installedPackage || path.basename(process.argv[1] || "") === "logdig"
  ? "logdig"
  : `node ${/\s/.test(entryArgument) ? JSON.stringify(entryArgument) : entryArgument}`;

function requireJournalPaths(settings) {
  if (!settings.cacheDirectory || !settings.dailyDirectory) {
    throw new Error(`Run '${commandName} init' first, or set PI_JOURNAL_DIR and PI_JOURNAL_DAILY_DIR. Settings file: ${settings.filePath}`);
  }
}

async function init() {
  const configured = await configureLogDig(await loadSettings(), commandName);
  if (!configured) return;
  const { settings, installExtension } = configured;
  if (installExtension) {
    try {
      await runCommand(settings.piCommand, ["install", packageRoot], { inherit: true, timeoutMs: 120_000 });
      console.log("Pi extension installed. Restart Pi or run /reload to load /journal.");
    } catch (error) {
      throw new Error(`Your settings are saved, but the extension could not be installed: ${error.message}. Run '${commandName} pi-install' when Pi is available.`);
    }
  } else {
    console.log(`Pi integration is optional. You can add it later with: ${commandName} pi-install`);
    if (settings.autoCapture) console.warn(`Automatic capture needs the Pi extension installed. To enable it, run '${commandName} pi-install'.`);
  }
}

function runCommand(command, args, { cwd = process.cwd(), inherit = false, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, {
      cwd,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdoutText = "";
    let stderrText = "";
    if (!inherit) {
      child.stdout.on("data", (chunk) => { stdoutText += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderrText += chunk.toString("utf8"); });
    }
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`'${command}' did not respond within ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start '${command}': ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout: stdoutText.trim(), stderr: stderrText.trim() });
      else reject(new Error(`${command} failed${signal ? ` (${signal})` : ` with exit code ${code}`}${stderrText ? `: ${stderrText.trim()}` : ""}`));
    });
  });
}

async function showConfig() {
  if (process.stdin.isTTY && process.stdout.isTTY) return editConfig(commandName);
  const settings = await loadSettings();
  const { filePath, configured, ...values } = settings;
  console.log(`Settings: ${filePath}${configured ? "" : " (not created yet)"}`);
  console.log(JSON.stringify(values, null, 2));
  const overrides = environmentOverrides();
  if (overrides.length) console.log(`Environment overrides: ${overrides.join(", ")}`);
}

async function doctor() {
  const settings = await loadSettings();
  const backendName = await resolveSummaryBackend(settings);
  const backend = summaryBackendFor({ summaryBackend: backendName });
  const claudeDirectory = await claudeHistoryDirectory(settings);
  let issues = 0;
  let warnings = 0;
  const checks = [
    ["Session history", settings.sessionDirectory, false],
    ...(claudeDirectory ? [["Claude Code history", claudeDirectory, false]] : []),
    ["Summary cache", settings.cacheDirectory, true],
    ["Daily notes", settings.dailyDirectory, true],
  ];
  const statusWidth = statusPrefixWidth();
  const labelWidth = Math.max(...checks.map(([label]) => label.length), backend.label.length, "Claude Code history".length);
  const valueColumn = statusWidth + labelWidth + 2;
  const formatLabel = (label, prefixWidth = statusWidth) => `${label}:${" ".repeat(valueColumn - prefixWidth - label.length - 1)}`;

  console.log(`${statusPrefix("ok")}${formatLabel("Settings")}${settings.filePath}${settings.configured ? " (saved)" : " (not saved; using defaults/environment)"}`);
  const overrides = environmentOverrides();
  if (overrides.length) console.log(`Environment overrides: ${overrides.join(", ")}`);

  for (const [label, directory, writable] of checks) {
    if (!directory) {
      console.error(`${statusPrefix("error")}${formatLabel(label)}not configured. Run '${commandName} init' to choose a folder.`);
      issues++;
      continue;
    }
    try {
      const result = await checkDirectory(directory, { writable, allowMissing: writable });
      console.log(`${statusPrefix("ok")}${formatLabel(label)}${directory}${result.exists ? "" : " (will be created on a real backfill)"}`);
    } catch (error) {
      if ((label === "Session history" || label === "Claude Code history") && error.code === "ENOENT") {
        const hint = label === "Session history"
          ? `Start a saved Pi session, or choose its location with '${commandName} init'.`
          : `Check the folder with '${commandName} config', or set it to off.`;
        console.warn(`${statusPrefix("warning")}${formatLabel(label)}${directory} (not found yet). ${hint}`);
        warnings++;
      } else {
        console.error(`${statusPrefix("error")}${formatLabel(label)}${directory} (${error.message}). Check folder permissions or choose another folder with '${commandName} init'.`);
        issues++;
      }
    }
  }

  if (!claudeDirectory && settings.claudeSessionDirectory !== false) {
    console.log(`${statusPrefix("ok")}${formatLabel("Claude Code history")}none found, so skipped`);
  } else if (settings.claudeSessionDirectory === false) {
    console.log(`${statusPrefix("ok")}${formatLabel("Claude Code history")}off`);
  }
  try {
    const version = await runCommand(settings[backend.commandSetting], backend.versionArgs);
    console.log(`${statusPrefix("ok")}${formatLabel(backend.label)}${version.stdout || version.stderr || "available"}`);
  } catch (error) {
    console.error(`${statusPrefix("error")}${formatLabel(backend.label)}${error.message}. Install ${backend.label} or set its executable in '${commandName} init' (advanced settings).`);
    issues++;
  }
  console.log(`\nSummary backend: ${backendName}${settings.summaryBackend === "auto" ? " (auto)" : ""}`);
  console.log(`Summary model: ${settings.model || backend.defaultModelLabel}`);
  console.log(`Thinking: ${settings.thinkingLevel || backend.defaultModelLabel}`);
  console.log(`Parallel sessions: ${settings.concurrency}`);
  console.log(`Authentication is checked only when you request a summary. ${backend.authHint}`);
  if (issues) {
    console.error(`\n${issues} thing${issues === 1 ? "" : "s"} to fix. Address the FIX lines above, then run '${commandName} doctor' again.`);
    process.exitCode = 1;
  } else {
    console.log(`\nChecks passed${warnings ? ` with ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}. Next: ${commandName} backfill 1 --dry-run`);
  }
}

async function backfill(args) {
  const settings = await loadSettings();
  let daysArgument;
  let dryRun = false;
  let skipToday = false;
  let force = false;
  let selectedAgent;
  let selectedModel = settings.model;
  let selectedThinking = settings.thinkingLevel;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--skip-today") {
      skipToday = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--agent") {
      selectedAgent = args[++index];
      if (!selectedAgent || selectedAgent.startsWith("-")) throw new Error("--agent requires auto, pi, or claude");
    } else if (arg.startsWith("--agent=")) {
      selectedAgent = arg.slice("--agent=".length);
    } else if (arg === "--model" || arg === "-m") {
      selectedModel = args[++index];
      const hint = summaryBackendFor({ summaryBackend: selectedAgent || settings.summaryBackend });
      if (!selectedModel || selectedModel.startsWith("-")) throw new Error(`--model requires ${hint.modelHint}, or 'default' for ${hint.label}'s default model`);
    } else if (arg.startsWith("--model=")) {
      selectedModel = arg.slice("--model=".length);
    } else if (arg === "--thinking") {
      selectedThinking = args[++index];
      if (!selectedThinking || selectedThinking.startsWith("-")) throw new Error("--thinking requires default, off, minimal, low, medium, high, xhigh, or max");
    } else if (arg.startsWith("--thinking=")) {
      selectedThinking = arg.slice("--thinking=".length);
    } else if (!arg.startsWith("-") && daysArgument === undefined) {
      daysArgument = arg;
    } else {
      throw new Error(`Unknown backfill argument: ${arg}. Run '${commandName} backfill --help'.`);
    }
  }
  // --agent chooses Pi or Claude Code for this run only. The saved summaryBackend is left unchanged.
  if (selectedAgent !== undefined) {
    selectedAgent = selectedAgent.trim().toLowerCase();
    if (!["auto", "pi", "claude"].includes(selectedAgent)) throw new Error("--agent requires auto, pi, or claude");
  }
  const backendName = await resolveSummaryBackend({ ...settings, summaryBackend: selectedAgent || settings.summaryBackend });
  const backend = summaryBackendFor({ summaryBackend: backendName });
  selectedModel = selectedModel?.trim().toLowerCase() === "default" ? undefined : selectedModel;
  const generationSettings = validateSettings({ ...settings, summaryBackend: backendName, model: selectedModel, thinkingLevel: selectedThinking });
  selectedModel = generationSettings.model;
  selectedThinking = generationSettings.thinkingLevel;
  const range = parseBackfillArgument(daysArgument);
  requireJournalPaths(settings);

  console.log(`${dryRun ? "Preview" : "Backfill"}: ${range.all ? "all saved sessions" : `last ${range.days}${skipToday ? " complete" : ""} day${range.days === 1 ? "" : "s"}`} (${settings.timeZone})${skipToday ? " · skipping today" : ""}`);
  console.log(`Daily notes: ${settings.dailyDirectory} (${settings.dailyHeader}, ${settings.dailySummary})`);
  console.log(`Summary cache: ${path.join(settings.cacheDirectory, "Sessions")}`);
  console.log(`Agent: ${backend.label}${selectedAgent ? " (from --agent)" : ""}`);
  console.log(`Model: ${selectedModel || backend.defaultModelLabel}`);
  console.log(`Thinking: ${selectedThinking || backend.defaultModelLabel}`);
  console.log(`Parallel sessions: ${settings.concurrency}`);
  console.log(force
    ? "Existing summaries: rewritten for the selected days (--force)."
    : "Existing summaries: kept. Only missing summaries need model requests.");
  console.log(dryRun
    ? "Dry run: no model requests, no file changes, and no folders created."
    : `Selected, redacted history is sent to your ${backend.label} model for missing summaries; provider charges may apply.`);
  const found = await collectSessions({ sessionDirectory: settings.sessionDirectory, claudeSessionDirectory: await claudeHistoryDirectory(settings), timeZone: settings.timeZone, days: range.days, skipToday });
  console.log(`\nFound ${found.sessions.length} saved session${found.sessions.length === 1 ? "" : "s"}${found.firstDate ? ` to check for ${found.firstDate} through ${found.lastDate}` : skipToday ? ` to check through ${found.lastDate}` : ""}.`);
  if (found.sessions.length === 0) {
    console.log(`No saved sessions found. History folder: ${settings.sessionDirectory}`);
    console.log(`If you have saved history elsewhere, choose it in '${commandName} init' (advanced settings). Otherwise, start a Pi or Claude Code session first.`);
    if (found.warnings.length) {
      console.warn(found.warnings.join("\n"));
      process.exitCode = 1;
    }
    return;
  }

  console.log("Results are shown in session order; processing remains parallel.");
  console.log("One result per work period; resumed sessions may have multiple dated rows.");
  if (!dryRun) console.log("Summarizing may take a few minutes. Finished results wait to print until earlier sessions finish; other sessions keep processing.");
  console.log();
  const progress = createBackfillProgress({ total: found.sessions.length, concurrency: settings.concurrency, dryRun });
  const interrupt = () => { cleanupProgress(); process.kill(process.pid, "SIGINT"); };
  const terminate = () => { cleanupProgress(); process.kill(process.pid, "SIGTERM"); };
  function cleanupProgress() {
    progress.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  let result;
  try {
    result = await writeSessions(createSummaryClient(generationSettings), found.sessions, settings, {
      ...found, dryRun, force, onProgress: progress.onProgress, onSessionComplete: progress.onSessionComplete,
    });
  } finally {
    cleanupProgress();
  }
  const summaryCount = `${result.summariesCreated} ${result.summariesCreated === 1 ? "summary" : "summaries"}`;
  const entryCount = `${result.entriesAppended} daily ${result.entriesAppended === 1 ? "entry" : "entries"}`;
  const updateCount = `${result.entriesUpdated} ${result.entriesUpdated === 1 ? "entry" : "entries"}`;
  const checkedBlocks = result.sessionResults.filter((entry) => entry.blockId);
  const checkedSessions = new Set(checkedBlocks.map((entry) => entry.sessionId)).size;
  console.log(`\nChecked: ${checkedBlocks.length} work block${checkedBlocks.length === 1 ? "" : "s"} across ${checkedSessions} session${checkedSessions === 1 ? "" : "s"}.`);
  console.log(dryRun
    ? `Would create ${summaryCount}, reuse ${result.summariesReused}, append ${entryCount}; ${result.entriesSkipped} already present; update ${updateCount}.`
    : `Saved: ${summaryCount} created, ${result.summariesReused} reused, appended ${entryCount}; ${result.entriesSkipped} already present; updated ${updateCount}.`);
  if (result.sessionsSkipped) console.log(`${result.sessionsSkipped} session${result.sessionsSkipped === 1 ? "" : "s"} skipped (outside the date range or without journalable messages${skipToday ? ", or active today" : ""}).`);
  if (skipToday) console.log(`${result.blocksExcludedToday} work period${result.blocksExcludedToday === 1 ? "" : "s"} excluded because of activity today (--skip-today).`);
  if (result.dates.length) {
    console.log(`Daily-note dates: ${result.dates.join(", ")}`);
    if (dryRun && result.summariesCreated) console.log(`${result.summariesCreated} work block${result.summariesCreated === 1 ? "" : "s"} would need summarizing. Large blocks may require multiple model requests each.`);
    if (!result.summariesCreated && !result.errors.length) console.log("These unchanged work blocks need no model requests.");
  } else if (!result.errors.length) {
    console.log(`Nothing to journal in this range. Try '${commandName} backfill 7${skipToday ? " --skip-today" : ""} --dry-run' or '${commandName} backfill all${skipToday ? " --skip-today" : ""} --dry-run'.`);
  }
  const warnings = [...found.warnings, ...result.errors];
  if (warnings.length) {
    console.warn(warnings.join("\n"));
    console.warn(dryRun ? "Preview incomplete. Fix the issues above, then preview again." : "Some sessions could not be saved. Successful summaries are cached. Fix the issues above and rerun the same command to retry.");
    process.exitCode = 1;
  } else if (dryRun && result.dates.length) {
    console.log(`\nWhen you're ready: ${commandName} backfill ${range.all ? "all" : range.days}${skipToday ? " --skip-today" : ""}${force ? " --force" : ""}${selectedAgent ? ` --agent ${selectedAgent}` : ""}${selectedModel ? ` --model ${selectedModel}` : settings.model ? " --model default" : ""}${selectedThinking ? ` --thinking ${selectedThinking}` : settings.thinkingLevel ? " --thinking default" : ""}`);
  }
}

function parseStatusArguments(args) {
  let rangeArgument;
  let json = false;
  let skipToday = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--skip-today") {
      skipToday = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown status argument: ${arg}. Run '${commandName} status --help'.`);
    } else if (rangeArgument !== undefined) {
      throw new Error(`Usage: ${commandName} status [number-of-days|all] [--json] [--skip-today]`);
    } else {
      rangeArgument = arg;
    }
  }
  return { range: parseBackfillArgument(rangeArgument, "status"), json, skipToday };
}

async function status(args) {
  const { range, json, skipToday } = parseStatusArguments(args);
  const settings = await loadSettings();
  requireJournalPaths(settings);
  const found = await collectSessions({
    sessionDirectory: settings.sessionDirectory,
    claudeSessionDirectory: await claudeHistoryDirectory(settings),
    timeZone: settings.timeZone,
    days: range.days,
    skipToday,
  });
  const previousEntries = await listJournaledSessions(settings.cacheDirectory);
  const inspection = await writeSessions(
    { cachePolicy: summaryCachePolicy(settings) },
    found.sessions,
    settings,
    { ...found, dryRun: true, journaledEntries: previousEntries },
  );
  const sessions = inspection.sessionResults
    .filter((session) => !["skipped", "error"].includes(session.status))
    .map((session) => {
      const previous = (previousEntries.get(session.sessionId) || []).filter((entry) => entry.blockId === session.blockId);
      const status = session.entryPresent ? "logged" : previous.length ? "stale" : "new";
      return {
        sessionId: session.sessionId,
        blockId: session.blockId,
        project: session.project,
        date: session.date,
        time: session.time,
        activityDates: session.activityDates,
        prerequisite: session.prerequisite,
        ...(session.continuationOf ? { continuationOf: session.continuationOf } : {}),
        status,
        ...(status === "stale" ? {
          reason: session.legacyEntry ? "previous entry needs work-block migration" : "previous journal entry is not current",
        } : {}),
        summaryStatus: session.summaryReused ? "reusable" : "needs-summarizing",
        dailyPath: session.dailyPath,
      };
    });
  const stale = sessions.filter((session) => session.status === "stale").length;
  const newCount = sessions.filter((session) => session.status === "new").length;
  const needsSummarizing = sessions.filter((session) => session.summaryStatus === "needs-summarizing").length;
  const warnings = [...found.warnings, ...inspection.errors];
  const report = {
    timeframe: {
      kind: range.all ? "all" : "days",
      ...(range.days ? { days: range.days } : {}),
      firstDate: found.firstDate || null,
      lastDate: found.lastDate,
      timeZone: settings.timeZone,
      ...(skipToday ? { skipToday: true } : {}),
    },
    totals: {
      scanned: found.sessions.length,
      eligible: sessions.length,
      logged: sessions.filter((session) => session.status === "logged").length,
      stale,
      new: newCount,
      needsSummarizing,
      skipped: inspection.sessionsSkipped,
      errors: inspection.errors.length,
      ...(skipToday ? { excludedToday: inspection.blocksExcludedToday } : {}),
    },
    sessions,
    warnings,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const label = range.all ? "all saved sessions" : `last ${range.days}${skipToday ? " complete" : ""} calendar day${range.days === 1 ? "" : "s"}`;
    console.log(`LogDig status: activity in ${label} (${settings.timeZone})${found.firstDate ? ` · ${found.firstDate} through ${found.lastDate}` : skipToday ? ` · through ${found.lastDate}` : ""}${skipToday ? " · skipping today" : ""}`);
    if (skipToday) console.log(`${inspection.blocksExcludedToday} work period${inspection.blocksExcludedToday === 1 ? "" : "s"} excluded because of activity today (--skip-today).`);
    console.log(`${report.totals.eligible} work block${report.totals.eligible === 1 ? "" : "s"}: ${report.totals.logged} logged, ${stale} stale, ${newCount} new.`);
    console.log(`Summaries: ${report.totals.eligible - needsSummarizing} reusable, ${needsSummarizing} work block${needsSummarizing === 1 ? " needs" : "s need"} summarizing.`);
    const prerequisites = sessions.filter((session) => session.prerequisite).length;
    if (prerequisites) console.log(`Includes ${prerequisites} earlier block${prerequisites === 1 ? "" : "s"} needed for continuation links.`);
    const attention = sessions.filter((session) => session.status !== "logged" || session.summaryStatus !== "reusable");
    if (attention.length) {
      console.log("\nNeeds attention:");
      for (const session of attention) {
        const state = session.status + (session.reason ? `: ${session.reason}` : "");
        const summary = session.summaryStatus === "reusable" ? "summary reusable" : "needs summarizing";
        console.log(`- ${session.date} ${session.time} · ${session.project} · ${state}; ${summary} (${session.sessionId})`);
        console.log(`  Daily note: ${session.dailyPath}`);
      }
    } else if (!sessions.length) {
      console.log("No journalable work blocks found in this timeframe.");
    } else {
      console.log("Everything in this timeframe is current.");
    }
    if (newCount || stale || needsSummarizing) {
      console.log(`\nTo update the journal: ${commandName} backfill ${range.all ? "all" : range.days}${skipToday ? " --skip-today" : ""}`);
    }
  }

  if (warnings.length) {
    if (!json) console.error(`Status may be incomplete:\n${warnings.join("\n")}`);
    process.exitCode = 1;
  }
}

function helpText() {
  return [
    "LogDig: a little work journal from your Pi sessions.",
    "",
    commandName === "logdig" ? "Start here:" : "Start here, from this checkout (no install needed):",
    `  ${commandName} init`,
    `  ${commandName} doctor`,
    `  ${commandName} backfill 1 --dry-run`,
    "",
    "Commands (install with 'npm install -g logdig', or use 'npm link' in a checkout):",
    "  logdig init                         guided setup; nothing is summarized",
    "  logdig doctor                       check paths and Pi without a model request",
    "  logdig config                       edit numbered settings; q quits (redirected: read-only)",
    "  logdig backfill [N|all] [--dry-run] [--skip-today] [--force]",
    "                                      saves missing summaries; existing ones are kept",
    "                                      --force rewrites saved summaries for the selected days",
    "                                      [--agent auto|pi|claude]",
    "                                      --agent picks Pi or Claude Code for this run only",
    "                                      [--model provider/model|default]",
    "                                      [--thinking default|off|minimal|low|medium|high|xhigh|max]",
    "                                      journal saved sessions (default: last 3 days)",
    "  logdig status [N|all] [--json] [--skip-today]",
    "                                      show journal coverage (default: last 3 days; read-only)",
    "  logdig pi-install | pi-uninstall     add or remove /journal integration",
    "  logdig --version                    show the installed version",
    "",
    "Preview first: --dry-run shows dates, files, and cache hits. It never calls a model",
    "or writes files. Remove --dry-run when you're ready to summarize.",
    "--skip-today selects N complete calendar days ending yesterday, or all past work.",
    "Work periods with activity today are excluded entirely, including overnight work.",
    "",
    "Real backfill uses the summary backend's default model (Pi unless changed) and its",
    "existing authentication. Tools, extensions, project context, and session saving are",
    "disabled for model requests.",
    "Use --model default or --thinking default to ignore that saved override for one run.",
    "More thinking may improve accuracy, but can increase latency and token cost.",
    "More help: README.md and QUICKSTART.md",
  ].join("\n");
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  const commands = ["init", "config", "doctor", "backfill", "status", "pi-install", "pi-uninstall", "help", "--help", "-h", "--version", "-v"];
  if (!commands.includes(command)) throw new Error(`Unknown command: ${command}. Run '${commandName} help'.`);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return;
  }
  if (!["backfill", "status"].includes(command) && args.length) throw new Error(`'${command}' does not accept arguments. Run '${commandName} help'.`);
  switch (command) {
    case "--version":
    case "-v": {
      const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
      console.log(version);
      break;
    }
    case "init":
      await init();
      break;
    case "config":
      await showConfig();
      break;
    case "doctor":
      await doctor();
      break;
    case "backfill":
      await backfill(args);
      break;
    case "status":
      await status(args);
      break;
    case "pi-install": {
      const settings = await loadSettings();
      await runCommand(settings.piCommand, ["install", packageRoot], { inherit: true, timeoutMs: 120_000 });
      console.log("Pi extension installed. Restart Pi or run /reload to load /journal.");
      break;
    }
    case "pi-uninstall": {
      const settings = await loadSettings();
      await runCommand(settings.piCommand, ["remove", packageRoot], { inherit: true, timeoutMs: 120_000 });
      console.log("Pi extension removed.");
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(helpText());
      break;
  }
}

main().catch((error) => {
  console.error(`logdig: ${error.message}`);
  process.exitCode = ["LOGDIG_SETUP_CANCELLED", "LOGDIG_CONFIG_CANCELLED"].includes(error.code) ? 130 : 1;
});
