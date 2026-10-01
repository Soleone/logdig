import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { checkDirectory } from "./directories.js";
import { environmentOverrideFor, loadSettings, saveSettings, validateSettings } from "./settings.js";
import { statusPrefix } from "./cli-status.js";

const fields = [
  { key: "dailyDirectory", label: "Daily-notes folder", folder: "write",
    hint: "The folder holding YYYY-MM-DD.md notes, not the vault root." },
  { key: "cacheDirectory", label: "Summary cache folder", folder: "write",
    hint: "Keeps all three summary lengths. Put it inside your vault to browse them in Obsidian." },
  { key: "dailyHeader", label: "Journal heading",
    hint: "One Markdown heading, including its # level, for example # Projects." },
  { key: "dailyHeaderAnchor", label: "Anchor heading", empty: "none",
    hint: "Create the journal section after this heading's full section. Type none to append at the end. Existing sections stay in place." },
  { key: "dailySummary", label: "Daily summary length", choices: ["small", "medium", "large"],
    hint: "Small: a few sentences. Medium: goal, progress, and next steps. Large: a short timeline." },
  { key: "timeZone", label: "Timezone",
    hint: "Determines journal dates and times, for example Europe/Berlin or UTC." },
  { key: "sessionDirectory", label: "Pi session-history folder", folder: "read",
    hint: "The folder containing saved Pi sessions. Missing folders are allowed." },
  { key: "piCommand", label: "Pi executable",
    hint: "A command on your PATH, such as pi, or a full executable path." },
  { key: "model", label: "Summary model", empty: "default",
    hint: "Use provider/model, or type default to remove the LogDig override. Changing the model can require new summaries." },
  { key: "thinkingLevel", label: "Thinking level", empty: "default",
    choices: ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
    hint: "More thinking may take longer and cost more. Model support varies. Default removes the LogDig override." },
  { key: "concurrency", label: "Maximum parallel sessions",
    hint: "A positive integer. Use 1 for sequential processing or to reduce rate-limit pressure." },
  { key: "autoCapture", label: "Automatic capture", choices: ["yes", "no"],
    hint: "Capture on Pi shutdown. Requires the Pi extension; sends selected, redacted history to your model, may incur charges, and can delay shutdown. Redaction is not a complete secret scanner." },
];

function displayValue(field, value) {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value || field.empty || "not configured");
}

export async function editConfig(commandName = "logdig", { input = stdin, output = stdout, env = process.env } = {}) {
  let settings = await loadSettings({ env, applyEnvironment: false });
  const print = (text = "") => output.write(`${text}\n`);
  const labelWidth = Math.max(...fields.map((field) => field.label.length));
  const showMenu = () => {
    print("\nLogDig settings");
    print(`Settings: ${settings.filePath}`);
    print("Values below are saved preferences (or defaults). Environment overrides take precedence.");
    print();
    fields.forEach((field, index) => {
      const variable = environmentOverrideFor(field.key, env);
      print(`  ${String(index + 1).padStart(2)}. ${field.label.padEnd(labelWidth)}  ${displayValue(field, settings[field.key])}`);
      if (variable) print(`      Override: ${variable}=${JSON.stringify(env[variable])} (saved changes will not override it)`);
    });
    print("\nChanges save immediately. No summaries or daily notes are written here.");
  };
  showMenu();
  if (!settings.dailyDirectory || !settings.cacheDirectory) {
    print(`\nRun '${commandName} init' first to configure your notes and cache folders.`);
    return;
  }

  const rl = createInterface({ input, output, terminal: Boolean(output.isTTY) && env.TERM !== "dumb" });
  const answers = rl[Symbol.asyncIterator]();
  let interrupted = false;
  const cancel = () => { interrupted = true; rl.close(); };
  rl.on("SIGINT", cancel);
  process.once("SIGINT", cancel);
  const checkInterrupted = () => {
    if (!interrupted) return;
    const error = new Error("Configuration cancelled. Previously saved changes are kept.");
    error.code = "LOGDIG_CONFIG_CANCELLED";
    throw error;
  };
  const ask = async (prompt) => {
    rl.setPrompt(prompt);
    rl.prompt();
    const answer = await answers.next();
    checkInterrupted();
    return answer.done ? "q" : answer.value.trim();
  };

  try {
    while (true) {
      const selection = await ask("\nChoose a setting by number or name (q to quit): ");
      if (selection.toLowerCase() === "q") break;
      if (!selection) continue;
      const matches = /^\d+$/.test(selection)
        ? fields.filter((_, index) => index + 1 === Number(selection))
        : fields.filter((field) => `${field.label} ${field.key}`.toLowerCase().includes(selection.toLowerCase()));
      if (matches.length !== 1) {
        print(matches.length
          ? `Please be more specific: ${matches.map((field) => `${fields.indexOf(field) + 1}. ${field.label}`).join("; ")}.`
          : `Choose a number from 1 to ${fields.length}, a setting name, or q.`);
        continue;
      }
      const field = matches[0];
      print(`\n${field.label}`);
      print(field.hint);
      if (field.choices) print(`Available values: ${field.choices.join(", ")}`);
      print("Enter keeps the current value. q quits without changing this field.");
      while (true) {
        const value = await ask(`New value [${displayValue(field, settings[field.key])}]: `);
        if (value.toLowerCase() === "q") return;
        if (!value) {
          print("Kept the current value.");
          break;
        }
        let nextSettings;
        try {
          let parsed = value;
          if (field.key === "autoCapture") {
            if (!/^(yes|no|y|n)$/i.test(value)) throw new Error("Please enter yes or no");
            parsed = /^(yes|y)$/i.test(value);
          } else if (field.key === "model" && value.toLowerCase() === "default") parsed = undefined;
          else if (field.key === "dailyHeaderAnchor" && value.toLowerCase() === "none") parsed = "";
          nextSettings = validateSettings({ ...settings, [field.key]: parsed });
          if (field.folder) await checkDirectory(nextSettings[field.key], { writable: field.folder === "write", allowMissing: true });
        } catch (error) {
          print(`  ${error.message}. Let's try that again.`);
          continue;
        }
        checkInterrupted();
        await saveSettings(nextSettings, settings.filePath);
        settings = nextSettings;
        print(`\n${statusPrefix("ok", { isTTY: output.isTTY, term: env.TERM, icons: env.LOGDIG_ICONS !== "0", noColor: env.NO_COLOR !== undefined })}${field.label} saved: ${displayValue(field, settings[field.key])}`);
        if (field.key === "autoCapture" && settings.autoCapture) print(`If the Pi extension is not installed, run '${commandName} pi-install'.`);
        break;
      }
      showMenu();
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    rl.close();
  }
}
