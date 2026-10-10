import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_CONCURRENCY = 4;

const SUMMARY_BACKENDS = ["auto", "pi", "claude"];
// Claude Code's --effort levels; "default" means no LogDig override.
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODEL_PATTERN = /^[A-Za-z0-9][\w.:[\]-]*$/;

const ENVIRONMENT_SETTINGS = [
  ["PI_JOURNAL_SUMMARY_BACKEND", "summaryBackend"],
  ["PI_JOURNAL_CLAUDE_COMMAND", "claudeCommand"],
  ["PI_JOURNAL_DIR", "cacheDirectory"],
  ["PI_JOURNAL_DAILY_DIR", "dailyDirectory"],
  ["PI_JOURNAL_DAILY_HEADER", "dailyHeader"],
  ["PI_JOURNAL_DAILY_HEADER_ANCHOR", "dailyHeaderAnchor"],
  ["PI_JOURNAL_DAILY_SUMMARY", "dailySummary"],
  ["PI_JOURNAL_TIMEZONE", "timeZone"],
  ["PI_JOURNAL_MODEL", "model"],
  ["PI_JOURNAL_THINKING", "thinkingLevel"],
  ["PI_JOURNAL_PI_COMMAND", "piCommand"],
  ["PI_CODING_AGENT_SESSION_DIR", "sessionDirectory"],
  ["PI_JOURNAL_CLAUDE_SESSION_DIR", "claudeSessionDirectory"],
];

function expandPath(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return path.resolve(value);
}

export function settingsFilePath({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.LOGDIG_CONFIG_PATH) return expandPath(env.LOGDIG_CONFIG_PATH, home);

  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "LogDig", "settings.json");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "LogDig", "settings.json");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "logdig", "settings.json");
}

function defaults({ env = process.env, home = homedir() } = {}) {
  const agentDirectory = env.PI_CODING_AGENT_DIR || env.PI || path.join(home, ".pi", "agent");
  return {
    version: 1,
    cacheDirectory: undefined,
    dailyDirectory: undefined,
    dailyHeader: "# Projects",
    dailyHeaderAnchor: "",
    dailySummary: "small",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    sessionDirectory: path.join(expandPath(agentDirectory, home), "sessions"),
    claudeSessionDirectory: undefined,
    summaryBackend: "auto",
    piCommand: "pi",
    claudeCommand: "claude",
    concurrency: DEFAULT_CONCURRENCY,
    autoCapture: false,
  };
}

export function validateSettings(settings, { requirePaths = false, home = homedir() } = {}) {
  if (settings.version !== undefined && settings.version !== 1) throw new Error(`Unsupported settings version: ${settings.version}`);
  if (requirePaths && !settings.cacheDirectory) throw new Error("Set cacheDirectory to a LogDig save folder");
  if (requirePaths && !settings.dailyDirectory) throw new Error("Set dailyDirectory to the folder containing YYYY-MM-DD.md notes");
  if (settings.dailySummary !== undefined) {
    if (typeof settings.dailySummary !== "string" || !settings.dailySummary.trim()) throw new Error("dailySummary must be small, medium, or large");
    settings.dailySummary = settings.dailySummary.trim().toLowerCase();
    if (!["small", "medium", "large"].includes(settings.dailySummary)) throw new Error("dailySummary must be small, medium, or large");
  }
  if (typeof settings.dailyHeader !== "string" || !settings.dailyHeader.trim()) {
    throw new Error("dailyHeader must be one Markdown heading, such as '# Projects'");
  }
  settings.dailyHeader = settings.dailyHeader.trim();
  if (!/^#{1,6}\s+[^\r\n]+$/.test(settings.dailyHeader)) {
    throw new Error("dailyHeader must be one Markdown heading, such as '# Projects'");
  }
  settings.dailyHeaderAnchor ??= "";
  if (typeof settings.dailyHeaderAnchor !== "string") {
    throw new Error("dailyHeaderAnchor must be blank or one Markdown heading, such as '# Log'");
  }
  settings.dailyHeaderAnchor = settings.dailyHeaderAnchor.trim();
  if (settings.dailyHeaderAnchor && !/^#{1,6}\s+[^\r\n]+$/.test(settings.dailyHeaderAnchor)) {
    throw new Error("dailyHeaderAnchor must be blank or one Markdown heading, such as '# Log'");
  }
  if (typeof settings.timeZone !== "string" || !settings.timeZone.trim()) throw new Error("timeZone must be a valid timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: settings.timeZone });
  } catch {
    throw new Error(`Invalid timeZone: ${settings.timeZone}`);
  }
  for (const key of ["cacheDirectory", "dailyDirectory", "sessionDirectory"]) {
    if (settings[key] !== undefined && (typeof settings[key] !== "string" || !settings[key].trim())) {
      throw new Error(`${key} must be a non-empty path`);
    }
    if (settings[key]) settings[key] = expandPath(settings[key].trim(), home);
  }
  // undefined finds Claude Code's default folder when it exists; false turns Claude Code history off.
  if (settings.claudeSessionDirectory !== undefined && settings.claudeSessionDirectory !== false) {
    if (typeof settings.claudeSessionDirectory !== "string" || !settings.claudeSessionDirectory.trim()) {
      throw new Error("claudeSessionDirectory must be a non-empty path, or false to turn Claude Code history off");
    }
    settings.claudeSessionDirectory = expandPath(settings.claudeSessionDirectory.trim(), home);
  }
  if (settings.summaryBackend !== undefined) {
    const backend = typeof settings.summaryBackend === "string" ? settings.summaryBackend.trim().toLowerCase() : "";
    if (!SUMMARY_BACKENDS.includes(backend)) throw new Error("summaryBackend must be auto, pi, or claude");
    settings.summaryBackend = backend;
  }
  // "auto" decides the backend when a summary starts, so a model is checked against its own format for now.
  const claude = settings.summaryBackend === "claude";
  const claudeModel = claude || (settings.summaryBackend === "auto" && !String(settings.model).includes("/"));
  if (settings.model !== undefined) {
    if (claudeModel) {
      if (typeof settings.model !== "string" || !CLAUDE_MODEL_PATTERN.test(settings.model.trim())) {
        throw new Error("model must be a Claude Code alias such as haiku or sonnet, or a full model name");
      }
      settings.model = settings.model.trim();
    } else {
      if (typeof settings.model !== "string" || /[\r\n]/.test(settings.model)) throw new Error("model must use provider/model format");
      settings.model = settings.model.trim();
      const separator = settings.model.indexOf("/");
      if (separator < 1 || separator === settings.model.length - 1) throw new Error("model must use provider/model format");
      const provider = settings.model.slice(0, separator).trim();
      const modelId = settings.model.slice(separator + 1).trim();
      if (!provider || !modelId) throw new Error("model must use provider/model format");
      settings.model = `${provider}/${modelId}`;
    }
  }
  if (settings.thinkingLevel !== undefined) {
    if (typeof settings.thinkingLevel !== "string") throw new Error("thinkingLevel must be default, off, minimal, low, medium, high, xhigh, or max");
    const level = settings.thinkingLevel.trim().toLowerCase();
    if (!["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
      throw new Error("thinkingLevel must be default, off, minimal, low, medium, high, xhigh, or max");
    }
    if (claude && level !== "default" && !CLAUDE_EFFORT_LEVELS.includes(level)) {
      throw new Error("With Claude Code, thinkingLevel must be default, low, medium, high, xhigh, or max");
    }
    settings.thinkingLevel = level === "default" ? undefined : level;
  }
  if (settings.concurrency !== undefined) {
    if (typeof settings.concurrency === "string" && /^\d+$/.test(settings.concurrency.trim())) {
      settings.concurrency = Number(settings.concurrency.trim());
    }
    if (!Number.isSafeInteger(settings.concurrency) || settings.concurrency < 1) {
      throw new Error("concurrency must be a positive integer (1 runs sessions sequentially)");
    }
  }
  if (settings.autoCapture !== undefined && typeof settings.autoCapture !== "boolean") {
    throw new Error("autoCapture must be a boolean");
  }
  settings.claudeCommand ??= "claude";
  for (const key of ["piCommand", "claudeCommand"]) {
    const command = settings[key];
    if (typeof command !== "string" || !command.trim() || /[\r\n]/.test(command)) {
      throw new Error(`${key} must be a command or executable path`);
    }
    settings[key] = command.trim();
    if (settings[key] === "~" || settings[key].startsWith("~/")) {
      settings[key] = expandPath(settings[key], home);
    } else if (settings[key].includes("/") || settings[key].includes("\\")) {
      settings[key] = path.resolve(settings[key]);
    }
  }
  return settings;
}

export function environmentOverrides(env = process.env) {
  return [...ENVIRONMENT_SETTINGS.map(([variable]) => variable), "PI_JOURNAL_AUTO"]
    .filter((variable) => env[variable] !== undefined && (env[variable] !== "" || variable === "PI_JOURNAL_AUTO" || variable === "PI_JOURNAL_DAILY_HEADER_ANCHOR"));
}

export function environmentOverrideFor(key, env = process.env) {
  const variable = [...ENVIRONMENT_SETTINGS, ["PI_JOURNAL_AUTO", "autoCapture"]]
    .find(([, setting]) => setting === key)?.[0];
  return environmentOverrides(env).includes(variable) ? variable : undefined;
}

export async function loadSettings(options = {}) {
  const env = options.env || process.env;
  const home = options.home || homedir();
  const filePath = options.filePath || settingsFilePath({ platform: options.platform, env, home });
  let stored = {};
  let configured = false;

  try {
    stored = JSON.parse(await readFile(filePath, "utf8"));
    configured = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Could not read LogDig settings at ${filePath}: ${error.message}`);
  }

  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error(`LogDig settings at ${filePath} must contain a JSON object`);
  }

  const settings = { ...defaults({ env, home }), ...stored };
  if (options.applyEnvironment !== false) {
    for (const [variable, key] of ENVIRONMENT_SETTINGS) {
      if (env[variable] !== undefined && (env[variable] !== "" || key === "dailyHeaderAnchor")) settings[key] = env[variable];
    }
    if (env.PI_JOURNAL_AUTO !== undefined) settings.autoCapture = env.PI_JOURNAL_AUTO === "1" || env.PI_JOURNAL_AUTO === "true";
  }
  validateSettings(settings);
  return { ...settings, filePath, configured };
}

export async function saveSettings(settings, filePath = settings.filePath || settingsFilePath()) {
  const persisted = {
    version: 1,
    cacheDirectory: settings.cacheDirectory,
    dailyDirectory: settings.dailyDirectory,
    dailyHeader: settings.dailyHeader || "# Projects",
    dailyHeaderAnchor: settings.dailyHeaderAnchor ?? "",
    dailySummary: settings.dailySummary || "small",
    timeZone: settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    sessionDirectory: settings.sessionDirectory,
    claudeSessionDirectory: settings.claudeSessionDirectory,
    summaryBackend: settings.summaryBackend || "auto",
    piCommand: settings.piCommand || "pi",
    claudeCommand: settings.claudeCommand || "claude",
    concurrency: settings.concurrency ?? DEFAULT_CONCURRENCY,
    autoCapture: settings.autoCapture === true,
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.thinkingLevel !== undefined ? { thinkingLevel: settings.thinkingLevel } : {}),
  };
  validateSettings(persisted, { requirePaths: true });

  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
  return filePath;
}
