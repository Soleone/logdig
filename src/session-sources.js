import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { claudeSessionFromJsonl, withoutSharedRecords } from "./claude-transcript.js";
import { sessionFromJsonl } from "./transcript.js";

// A codec reads one folder of saved coding-agent sessions and returns the session
// shape the journal pipeline uses: { header, entries, sourcePath }. Adding another
// tool's history means adding a codec here; the summary and daily-note steps stay the same.
// `agent` is written to each note's front matter so the source stays visible.
export const SESSION_CODECS = [
  {
    agent: "pi",
    directorySetting: "sessionDirectory",
    parse: sessionFromJsonl,
    missingWarning: (directory) => `Pi history folder not found: ${directory}. Start a saved Pi session or check the history path with 'logdig init'.`,
  },
  {
    agent: "claude-code",
    directorySetting: "claudeSessionDirectory",
    parse: claudeSessionFromJsonl,
    collapse: withoutSharedRecords,
    missingWarning: (directory) => `Claude Code history folder not found: ${directory}. Check it with 'logdig config', or set it to off.`,
  },
];

// The Claude Code folder to read, or undefined when it is off or absent. An explicit folder is returned
// even if missing, so the user hears about it. The default folder is skipped silently when absent.
export async function claudeHistoryDirectory(settings, { env = process.env } = {}) {
  if (settings.claudeSessionDirectory === false) return undefined;
  if (settings.claudeSessionDirectory) return settings.claudeSessionDirectory;
  const directory = path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects");
  try {
    return (await stat(directory)).isDirectory() ? directory : undefined;
  } catch {
    return undefined;
  }
}
