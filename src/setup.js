import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { checkDirectory } from "./directories.js";
import { environmentOverrides, saveSettings, validateSettings } from "./settings.js";
import { summaryBackendFor } from "./summary-backends.js";

function yesNo(value) {
  if (/^(y|yes)$/i.test(value)) return true;
  if (/^(n|no)$/i.test(value)) return false;
  throw new Error("Please enter yes or no");
}

export async function configureLogDig(settings, commandName = "logdig") {
  console.log([
    "LogDig setup",
    "A small work journal from your Pi and Claude Code sessions, in the notes you already use.",
    "",
    "Press Enter to keep a default. Ctrl+C leaves your settings unchanged.",
    "No history is summarized and no daily notes are written during setup.",
    `Settings: ${settings.filePath}`,
    "",
  ].join("\n"));
  const overrides = environmentOverrides();
  if (overrides.length) {
    console.warn(`Environment overrides are active: ${overrides.join(", ")}. They will still take precedence over saved settings.`);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const answers = rl[Symbol.asyncIterator]();
  let interrupted = false;
  const cancel = () => { interrupted = true; rl.close(); };
  rl.on("SIGINT", cancel);
  process.once("SIGINT", cancel);
  let nextSettings;
  let installExtension;

  try {
    const ask = async (label, defaultValue, parse = (value) => value) => {
      while (true) {
        stdout.write(`${label}${defaultValue ? ` [${defaultValue}]` : ""}: `);
        const answer = await answers.next();
        if (interrupted) {
          const error = new Error("Setup cancelled. Your settings were not changed.");
          error.code = "LOGDIG_SETUP_CANCELLED";
          throw error;
        }
        if (answer.done) throw new Error(`Setup ended early. Your settings were not changed. Run '${commandName} init' to try again.`);
        try {
          return await parse(answer.value.trim() || defaultValue || "");
        } catch (error) {
          console.log(`  ${error.message}. Let's try that again.`);
        }
      }
    };
    const field = (key, value) => validateSettings({ ...settings, [key]: value })[key];
    const folder = async (key, value, writable) => {
      const directory = field(key, value);
      await checkDirectory(directory, { writable, allowMissing: true });
      return directory;
    };

    console.log("1. Your notes");
    console.log("Choose the folder holding YYYY-MM-DD.md daily notes, not the vault root unless your notes live there.");
    const dailyDirectory = await ask("Daily-notes folder", settings.dailyDirectory || path.join(homedir(), "Obsidian", "Daily"),
      (value) => folder("dailyDirectory", value, true));
    console.log("The cache keeps all three summary lengths. Put it inside your vault to browse it in Obsidian.");
    const cacheDirectory = await ask("Summary cache folder", settings.cacheDirectory || path.join(path.dirname(dailyDirectory), "LogDig"),
      (value) => folder("cacheDirectory", value, true));
    console.log("Entries are grouped by project, then by time, under this heading. Use # Projects to keep your personal log separate.");
    const dailyHeader = await ask("Heading for journal entries", settings.dailyHeader, (value) => field("dailyHeader", value));
    console.log("Create that section after an anchor's full section, before the next same-level or higher-level heading. Blank or missing anchors append at the end; existing sections stay in place.");
    const dailyHeaderAnchor = await ask("Anchor heading (e.g. # Log), or 'none'", settings.dailyHeaderAnchor || "none",
      (value) => field("dailyHeaderAnchor", value.toLowerCase() === "none" ? "" : value));
    console.log("Small: a few sentences. Medium: goal, progress, and next steps. Large: a short timeline.");
    const dailySummary = await ask("Daily summary (small/medium/large)", settings.dailySummary, (value) => field("dailySummary", value));
    const timeZone = await ask("Timezone", settings.timeZone, (value) => field("timeZone", value));

    console.log("\n2. Summaries and privacy");
    console.log("Claude Code sessions are included automatically when ~/.claude/projects exists. Turn them off in 'config' if you don't want them.");
    console.log("auto summarizes with Pi when it is installed, and with Claude Code otherwise. Choose pi or claude to pin one.");
    const previousBackend = settings.summaryBackend || "auto";
    const summaryBackend = await ask("Summarize with (auto/pi/claude)", previousBackend,
      (value) => validateSettings({ ...settings, summaryBackend: value, model: undefined, thinkingLevel: undefined }).summaryBackend);
    if (summaryBackend !== previousBackend) {
      // Model and thinking names differ between backends, so the old overrides are cleared.
      settings = { ...settings, summaryBackend, model: undefined, thinkingLevel: undefined };
      console.log("Model and thinking were reset for the new backend. Set them in advanced settings if you want overrides.");
    }
    const backend = summaryBackendFor(settings);
    console.log(`History: ${settings.sessionDirectory}`);
    console.log(`Model: ${settings.model || (summaryBackend === "pi" ? "Pi's default (your active model for /journal)" : backend.defaultModelLabel)}`);
    console.log(`Thinking: ${settings.thinkingLevel || "default (no LogDig override)"}`);
    console.log(`Parallel sessions: ${settings.concurrency}`);
    const advanced = await ask(`Change history folder, ${backend.label} command, model, thinking level, or concurrency? (yes/no)`, "no", yesNo);
    let { sessionDirectory, piCommand, claudeCommand, model, thinkingLevel, concurrency } = settings;
    if (advanced) {
      sessionDirectory = await ask("Pi session-history folder", sessionDirectory,
        (value) => folder("sessionDirectory", value, false));
      if (summaryBackend !== "claude") {
        piCommand = await ask("Pi executable", piCommand, (value) => field("piCommand", value));
      }
      if (summaryBackend !== "pi") {
        claudeCommand = await ask("Claude Code command", claudeCommand, (value) => field("claudeCommand", value));
      }
      model = await ask(`Model (${backend.modelHint}), or 'default'`, model || "default",
        (value) => value.toLowerCase() === "default" ? undefined : field("model", value));
      console.log("More thinking can help distinguish attempts from outcomes, but takes longer and may cost more. Support depends on the model.");
      const thinkingChoices = summaryBackend === "claude" ? "default/low/medium/high/xhigh/max" : "default/off/minimal/low/medium/high/xhigh/max";
      thinkingLevel = await ask(`Thinking level (${thinkingChoices})`, thinkingLevel || "default",
        (value) => field("thinkingLevel", value));
      console.log("Independent sessions run in parallel. Use 1 for sequential processing or to reduce provider rate-limit pressure.");
      concurrency = await ask("Maximum parallel sessions", concurrency, (value) => field("concurrency", value));
    }
    console.log(`Summarizing sends selected, redacted history to your ${backend.label} model. Provider charges may apply.`);
    console.log(`Common secrets are redacted, but this is not a complete secret scanner. ${backend.label} keeps your credentials.`);
    console.log("Automatic capture may delay shutdown. Leave it off until you've tried a manual run.");
    const autoCapture = await ask("Capture on Pi shutdown? (yes/no)", settings.autoCapture ? "yes" : "no", yesNo);
    installExtension = await ask("Install the Pi extension for /journal? (yes/no)", "no", yesNo);

    nextSettings = { ...settings, cacheDirectory, dailyDirectory, dailyHeader, dailyHeaderAnchor, dailySummary, timeZone, sessionDirectory, summaryBackend, piCommand, claudeCommand, model, thinkingLevel, concurrency, autoCapture };
    console.log([
      "",
      "Ready to save",
      `  Daily notes: ${dailyDirectory}/YYYY-MM-DD.md`,
      `  Heading:     ${dailyHeader}`,
      `  Anchor:      ${dailyHeaderAnchor || "none (append at end)"}`,
      `  Summary:     ${dailySummary}, in ${timeZone}`,
      `  Cache:       ${path.join(cacheDirectory, "Sessions")}`,
      `  History:     ${sessionDirectory}`,
      `  Summaries:   ${summaryBackend === "auto" ? `${backend.label}` : `${backend.label} (${summaryBackend === "claude" ? claudeCommand : piCommand})`}`,
      `  Model:       ${model || backend.defaultModelLabel}`,
      `  Thinking:    ${thinkingLevel || "default (no LogDig override)"}`,
      `  Parallel sessions: ${concurrency}`,
      `  Auto-capture: ${autoCapture ? "on" : "off"}`,
      `  Extension:   ${installExtension ? "install now" : "leave unchanged"}`,
      "Missing note and cache folders will be created on your first real backfill.",
    ].join("\n"));
    if (!await ask("Save these settings? (yes/no)", "yes", yesNo)) {
      console.log("Setup cancelled. Your settings were not changed.");
      return undefined;
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    rl.close();
  }

  const configPath = await saveSettings(nextSettings, settings.filePath);
  console.log(`\nSaved settings: ${configPath}`);
  console.log(`Next: ${commandName} doctor, then ${commandName} backfill 1 --dry-run. Preview is free and changes nothing.`);
  return { settings: nextSettings, installExtension };
}
