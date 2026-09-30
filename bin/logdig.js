#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectSessions, parseBackfillArgument, writeSessions } from "../src/session-runner.js";
import { createPiModelClient } from "../src/pi-client.js";
import { spawnPiProcess } from "../src/pi-process.js";
import { environmentOverrides, loadSettings, validateSettings } from "../src/settings.js";
import { checkDirectory } from "../src/directories.js";
import { configureLogDig } from "../src/setup.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const relativeEntry = path.relative(process.cwd(), fileURLToPath(import.meta.url)).split(path.sep).join("/");
const entryArgument = relativeEntry.startsWith(".") ? relativeEntry : `./${relativeEntry}`;
const commandName = path.basename(process.argv[1] || "") === "logdig"
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
      await runPiCommand(settings.piCommand, ["install", packageRoot], { inherit: true, timeoutMs: 120_000 });
      console.log("Pi extension installed. Restart Pi or run /reload to load /journal.");
    } catch (error) {
      throw new Error(`Your settings are saved, but the extension could not be installed: ${error.message}. Run '${commandName} pi-install' when Pi is available.`);
    }
  } else {
    console.log(`Pi integration is optional. You can add it later with: ${commandName} pi-install`);
    if (settings.autoCapture) console.warn(`Automatic capture needs the Pi extension installed. To enable it, run '${commandName} pi-install'.`);
  }
}

function runPiCommand(command, args, { cwd = process.cwd(), inherit = false, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnPiProcess(command, args, {
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
  const settings = await loadSettings();
  const { filePath, configured, ...values } = settings;
  console.log(`Settings: ${filePath}${configured ? "" : " (not created yet)"}`);
  console.log(JSON.stringify(values, null, 2));
  const overrides = environmentOverrides();
  if (overrides.length) console.log(`Environment overrides: ${overrides.join(", ")}`);
}

async function doctor() {
  const settings = await loadSettings();
  let issues = 0;
  let warnings = 0;
  console.log("LogDig checkup (no model requests or file changes)\n");
  console.log(`Settings: ${settings.filePath}${settings.configured ? " (saved)" : " (not saved; using defaults/environment)"}`);
  const overrides = environmentOverrides();
  if (overrides.length) console.log(`Environment overrides: ${overrides.join(", ")}`);

  for (const [label, directory, writable] of [
    ["Session history", settings.sessionDirectory, false],
    ["Summary cache", settings.cacheDirectory, true],
    ["Daily notes", settings.dailyDirectory, true],
  ]) {
    if (!directory) {
      console.error(`FIX   ${label}: not configured. Run '${commandName} init' to choose a folder.`);
      issues++;
      continue;
    }
    try {
      const result = await checkDirectory(directory, { writable, allowMissing: writable });
      console.log(`OK    ${label}: ${directory}${result.exists ? "" : " (will be created on a real backfill)"}`);
    } catch (error) {
      if (label === "Session history" && error.code === "ENOENT") {
        console.warn(`WARN  ${label}: ${directory} (not found yet). Start a saved Pi session, or choose its location with '${commandName} init'.`);
        warnings++;
      } else {
        console.error(`FIX   ${label}: ${directory} (${error.message}). Check folder permissions or choose another folder with '${commandName} init'.`);
        issues++;
      }
    }
  }

  try {
    const pi = await runPiCommand(settings.piCommand, ["--version", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--offline"]);
    console.log(`OK    Pi: ${pi.stdout || pi.stderr || "available"}`);
  } catch (error) {
    console.error(`FIX   Pi: ${error.message}. Install Pi or set its executable in '${commandName} init' (advanced settings).`);
    issues++;
  }
  console.log(`\nSummary model: ${settings.model || "Pi startup default"}`);
  console.log("Authentication is checked only when you request a summary. If it fails, open Pi and run /login.");
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
  let selectedModel = settings.model;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--model" || arg === "-m") {
      selectedModel = args[++index];
      if (!selectedModel || selectedModel.startsWith("-")) throw new Error("--model requires provider/model, or 'default' to use Pi's startup model");
    } else if (arg.startsWith("--model=")) {
      selectedModel = arg.slice("--model=".length);
    } else if (!arg.startsWith("-") && daysArgument === undefined) {
      daysArgument = arg;
    } else {
      throw new Error(`Unknown backfill argument: ${arg}. Run '${commandName} backfill --help'.`);
    }
  }
  selectedModel = selectedModel?.trim().toLowerCase() === "default" ? undefined : selectedModel;
  selectedModel = validateSettings({ ...settings, model: selectedModel }).model;
  const range = parseBackfillArgument(daysArgument);
  requireJournalPaths(settings);

  console.log(`${dryRun ? "Preview" : "Backfill"}: ${range.all ? "all saved sessions" : `last ${range.days} day${range.days === 1 ? "" : "s"}`} (${settings.timeZone})`);
  console.log(`Daily notes: ${settings.dailyDirectory} (${settings.dailyHeader}, ${settings.dailySummary})`);
  console.log(`Summary cache: ${path.join(settings.cacheDirectory, "Sessions")}`);
  console.log(`Model: ${selectedModel || "Pi startup default"}`);
  console.log(dryRun
    ? "Dry run: no model requests, no file changes, and no folders created."
    : "Only new or changed sessions need model requests. Selected, redacted history is sent to Pi's model; provider charges may apply.");
  const found = await collectSessions({ sessionDirectory: settings.sessionDirectory, timeZone: settings.timeZone, days: range.days });
  console.log(`\nFound ${found.sessions.length} saved Pi session${found.sessions.length === 1 ? "" : "s"}${found.firstDate ? ` to check for ${found.firstDate} through ${found.lastDate}` : ""}.`);
  if (found.sessions.length === 0) {
    console.log(`No saved sessions found. History folder: ${settings.sessionDirectory}`);
    console.log(`If you have saved history elsewhere, choose it in '${commandName} init' (advanced settings). Otherwise, start a Pi session first.`);
    if (found.warnings.length) {
      console.warn(found.warnings.join("\n"));
      process.exitCode = 1;
    }
    return;
  }

  const modelClient = createPiModelClient({ ...settings, model: selectedModel });
  const result = await writeSessions(modelClient, found.sessions, settings, {
    ...found,
    dryRun,
    onProgress: ({ index, total, sessionId, project, date, time, status, error, phase, sessionPath, dailyPath }) => {
      if (["checking", "skipped"].includes(phase)) return;
      console.log(`[${index}/${total}] ${project || sessionId}${date ? ` · ${date} ${time}` : ""}: ${error || status}`);
      if (dryRun && dailyPath) {
        console.log(`  Daily note: ${dailyPath}`);
        console.log(`  Full summary: ${sessionPath}`);
      }
    },
  });
  const summaryCount = `${result.summariesCreated} ${result.summariesCreated === 1 ? "summary" : "summaries"}`;
  const entryCount = `${result.entriesAppended} daily ${result.entriesAppended === 1 ? "entry" : "entries"}`;
  console.log(dryRun
    ? `\nWould create ${summaryCount}, reuse ${result.summariesReused}, append ${entryCount}; ${result.entriesSkipped} already present.`
    : `\nSaved: ${summaryCount} created, ${result.summariesReused} reused, ${entryCount} appended; ${result.entriesSkipped} already present.`);
  if (result.sessionsSkipped) console.log(`${result.sessionsSkipped} session${result.sessionsSkipped === 1 ? "" : "s"} skipped (outside the date range or without journalable messages).`);
  if (result.dates.length) {
    console.log(`Daily-note dates: ${result.dates.join(", ")}`);
    if (dryRun && result.summariesCreated) console.log(`${result.summariesCreated} session${result.summariesCreated === 1 ? "" : "s"} would need model requests. Large sessions may require multiple requests each.`);
    if (!result.summariesCreated && !result.errors.length) console.log("These unchanged sessions need no model requests.");
  } else if (!result.errors.length) {
    console.log(`Nothing to journal in this range. Try '${commandName} backfill 7 --dry-run' or '${commandName} backfill all --dry-run'.`);
  }
  const warnings = [...found.warnings, ...result.errors];
  if (warnings.length) {
    console.warn(warnings.join("\n"));
    console.warn(dryRun ? "Preview incomplete. Fix the issues above, then preview again." : "Some sessions could not be saved. Successful summaries are cached. Fix the issues above and rerun the same command to retry.");
    process.exitCode = 1;
  } else if (dryRun && result.dates.length) {
    console.log(`\nWhen you're ready: ${commandName} backfill ${range.all ? "all" : range.days}${selectedModel ? ` --model ${selectedModel}` : settings.model ? " --model default" : ""}`);
  }
}

function helpText() {
  return [
    "LogDig: a little work journal from your Pi sessions.",
    "",
    "Start here, from this checkout (no install needed):",
    "  node ./bin/logdig.js init",
    "  node ./bin/logdig.js doctor",
    "  node ./bin/logdig.js backfill 1 --dry-run",
    "",
    "Commands (use 'logdig' after npm link):",
    "  logdig init                         guided setup; nothing is summarized",
    "  logdig doctor                       check paths and Pi without a model request",
    "  logdig config                       show settings and active environment overrides",
    "  logdig backfill [N|all] [--dry-run] [--model provider/model|default]",
    "                                      journal saved sessions (default: last 3 days)",
    "  logdig pi-install | pi-uninstall     add or remove /journal integration",
    "",
    "Preview first: --dry-run shows dates, files, and cache hits. It never calls Pi",
    "or writes files. Remove --dry-run when you're ready to summarize.",
    "",
    "Real backfill uses Pi's startup model and existing authentication. Tools,",
    "extensions, project context, and session saving are disabled for model requests.",
    "Use --model default to ignore a saved model override for one run.",
    "More help: README.md and QUICKSTART.md",
  ].join("\n");
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  const commands = ["init", "config", "doctor", "backfill", "pi-install", "pi-uninstall", "help", "--help", "-h"];
  if (!commands.includes(command)) throw new Error(`Unknown command: ${command}. Run '${commandName} help'.`);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return;
  }
  if (command !== "backfill" && args.length) throw new Error(`'${command}' does not accept arguments. Run '${commandName} help'.`);
  switch (command) {
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
    case "pi-install": {
      const settings = await loadSettings();
      await runPiCommand(settings.piCommand, ["install", packageRoot], { inherit: true, timeoutMs: 120_000 });
      console.log("Pi extension installed. Restart Pi or run /reload to load /journal.");
      break;
    }
    case "pi-uninstall": {
      const settings = await loadSettings();
      await runPiCommand(settings.piCommand, ["remove", packageRoot], { inherit: true, timeoutMs: 120_000 });
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
  process.exitCode = error.code === "LOGDIG_SETUP_CANCELLED" ? 130 : 1;
});
