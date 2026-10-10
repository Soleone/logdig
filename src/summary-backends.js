import { commandAvailable } from "./command-process.js";
import { createClaudeModelClient } from "./claude-client.js";
import { createPiModelClient } from "./pi-client.js";

// A backend turns a journal prompt into a model reply. Every backend returns the same client
// shape, { modelLabel, cachePolicy, complete(prompt) }, so the journal code never checks which one ran.
const BACKENDS = {
  pi: {
    label: "Pi",
    commandSetting: "piCommand",
    versionArgs: ["--version", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--offline"],
    defaultModelLabel: "Pi startup default",
    modelHint: "provider/model",
    authHint: "If it fails, open Pi and run /login.",
    createClient: createPiModelClient,
  },
  claude: {
    label: "Claude Code",
    commandSetting: "claudeCommand",
    versionArgs: ["--version"],
    defaultModelLabel: "Claude Code default",
    modelHint: "a Claude Code alias such as haiku or sonnet, or a full model name",
    authHint: "If it fails, start 'claude', run /login, then retry.",
    createClient: createClaudeModelClient,
  },
};

// "auto" is a setting, not a backend. It is resolved to one of the backends above before any summary runs.
const AUTO = {
  label: "auto (Pi if installed, otherwise Claude Code)",
  defaultModelLabel: "Pi or Claude Code default",
  modelHint: "provider/model for Pi, or a Claude Code alias such as haiku",
};

// Describes the chosen backend for display. Pass a resolved backend name when it is known.
export function summaryBackendFor(settings) {
  const name = settings.summaryBackend || "auto";
  return name === "auto" ? AUTO : BACKENDS[name];
}

// Pi wins when it is installed, so existing Pi setups keep their behavior. Claude Code is the fallback.
export async function resolveSummaryBackend(settings) {
  if (settings.summaryBackend && settings.summaryBackend !== "auto") return settings.summaryBackend;
  if (await commandAvailable(settings.piCommand || "pi")) return "pi";
  if (await commandAvailable(settings.claudeCommand || "claude")) return "claude";
  return "pi";
}

export function createSummaryClient(settings, options) {
  const backend = BACKENDS[settings.summaryBackend];
  if (!backend) throw new Error("The summary backend must be resolved before summaries start");
  return backend.createClient(settings, options);
}
