import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const READ_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
]);

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "git"]);
const SECRET_PATTERNS = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]"],
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|secret|credential)\s*[:=]\s*["']?)[^\s"']+/gi, "$1[REDACTED]"],
];

export function parseSessionJsonl(text, sourcePath = "<session>") {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error(`${sourcePath}: empty session file`);

  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${sourcePath}:${index + 1}: invalid JSON`);
    }
  });

  const [header, ...entries] = records;
  if (header.type !== "session" || typeof header.id !== "string") {
    throw new Error(`${sourcePath}: missing Pi session header`);
  }

  return { header, entries, sourcePath };
}

export function sessionFromJsonl(text, sourcePath = "<session>") {
  return parseSessionJsonl(text, sourcePath);
}

export function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function redactAndClip(value, maxLength = 1800) {
  let text = String(value ?? "").replaceAll("\0", "");
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[truncated]`;
}

export function timestampOf(entry) {
  const value = entry.timestamp ?? entry.message?.timestamp;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function sessionMetrics(session) {
  const metrics = {};
  const fields = ["input", "output", "cacheRead", "cacheWrite"];
  const totals = Object.fromEntries(fields.map((field) => [field, 0]));
  let cost = 0;
  let hasCost = false;
  const recorded = new Set();
  const started = timestampOf(session.header);
  let first = started;
  let last = started;

  for (const entry of session.entries || []) {
    const time = timestampOf(entry);
    if (time !== undefined) {
      first = Math.min(first ?? time, time);
      last = Math.max(last ?? time, time);
    }
    const usage = entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
      ? entry.usage
      : entry.type === "message" && ["assistant", "toolResult"].includes(entry.message?.role) ? entry.message.usage : undefined;
    if (!usage || typeof usage !== "object") continue;
    for (const field of fields) {
      if (!Number.isFinite(usage[field]) || usage[field] < 0) continue;
      totals[field] += usage[field];
      recorded.add(field);
    }
    if (Number.isFinite(usage.cost?.total) && usage.cost.total >= 0) {
      cost += usage.cost.total;
      hasCost = true;
    }
  }

  if (first !== undefined) metrics.startedAt = new Date(first).toISOString();
  if (last !== undefined) metrics.endedAt = new Date(last).toISOString();
  if (first !== undefined && last !== undefined) metrics.durationSeconds = Math.round((last - first) / 1000);
  if (hasCost) metrics.costUsd = Number(cost.toFixed(6));
  for (const [field, key] of [["cacheRead", "cacheReadTokens"], ["input", "inputTokens"], ["output", "outputTokens"], ["cacheWrite", "cacheWriteTokens"]]) {
    if (recorded.has(field)) metrics[key] = totals[field];
  }
  return metrics;
}

export function localTimeFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function localParts(timestamp, formatter) {
  const parts = formatter.formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function commandIsNoteworthy(command) {
  return /\b(test|build|lint|typecheck|check|git\s+(?:diff|status|log|add|commit|switch|checkout)|npm|pnpm|yarn|bun|cargo|pytest|vitest|wrangler|deploy|curl|rm\s|mv\s|cp\s)/i.test(command);
}

function selectedToolArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  if (name === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    return commandIsNoteworthy(command) ? redactAndClip(command, 360) : "";
  }

  const selected = Object.entries(args).filter(([key]) =>
    /^(?:path|file|files|filePath|cwd|name|subject|action|status|query|id|url)$/i.test(key),
  );
  if (selected.length === 0) return "";

  return selected
    .map(([key, value]) => `${key}=${redactAndClip(Array.isArray(value) ? value.join(", ") : value, 160)}`)
    .join(" ");
}

function noteworthyToolCall(name, args) {
  if (READ_TOOLS.has(name)) return false;
  if (name === "bash") return Boolean(selectedToolArguments(name, args));
  return true;
}

function outputExcerpt(content, limit = 420) {
  const text = redactAndClip(textContent(content), limit + 80);
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 24) / 2);
  return `${text.slice(0, half)}\n[…output clipped…]\n${text.slice(-half)}`;
}

function eventFor(entry, formatter, toolCalls) {
  const timestamp = timestampOf(entry);
  if (timestamp === undefined) return undefined;
  const { date, time } = localParts(timestamp, formatter);
  const message = entry.message;

  if (entry.type === "compaction" || entry.type === "branch_summary") {
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    if (!summary.trim()) return undefined;
    return { date, time, kind: entry.type === "compaction" ? "context summary" : "branch summary", text: redactAndClip(summary, 1400) };
  }

  if (entry.type !== "message" || !message) return undefined;
  const { role, content } = message;

  if (role === "user") {
    const text = textContent(content);
    return {
      date,
      time,
      kind: "user intent",
      text: text ? redactAndClip(text) : "non-text user input (payload omitted)",
    };
  }

  if (role === "assistant") {
    const blocks = Array.isArray(content) ? content : [];
    const calls = blocks.filter((block) => block?.type === "toolCall");
    const text = textContent(content);
    const events = [];

    if (text && ["stop", "length", "error", "aborted"].includes(message.stopReason)) {
      events.push({ date, time, kind: "assistant outcome", text: redactAndClip(text) });
    }

    for (const call of calls) {
      if (!noteworthyToolCall(call.name, call.arguments)) continue;
      toolCalls.set(call.id, { name: call.name, command: selectedToolArguments(call.name, call.arguments) });
      const details = selectedToolArguments(call.name, call.arguments);
      events.push({
        date,
        time,
        kind: `action: ${call.name}`,
        text: details || "tool was used",
      });
    }
    return events.length > 0 ? events : undefined;
  }

  if (role === "toolResult") {
    const call = toolCalls.get(message.toolCallId);
    const toolName = message.toolName || call?.name || "tool";
    const shouldInclude = message.isError || EDIT_TOOLS.has(toolName) || (toolName === "bash" && call?.command);
    if (!shouldInclude) return undefined;
    const output = outputExcerpt(content);
    if (!output) return undefined;
    return {
      date,
      time,
      kind: message.isError ? `error: ${toolName}` : `result: ${toolName}`,
      text: output,
    };
  }

  if (role === "bashExecution") {
    const command = typeof message.command === "string" ? message.command : "";
    if (!commandIsNoteworthy(command)) return undefined;
    const output = outputExcerpt(message.output || "", 360);
    return {
      date,
      time,
      kind: `shell: ${message.exitCode === 0 ? "success" : "exit " + message.exitCode}`,
      text: `${redactAndClip(command, 240)}${output ? `\n${output}` : ""}`,
    };
  }

  return undefined;
}

const PROJECT_NAME_CACHE = new Map();

function cleanProjectName(name) {
  return name.replace(/^\d{4}-\d{2}-\d{2}-(?=.)/, "");
}

function commonGitDirectory(gitDir) {
  try {
    const commonDir = readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    return commonDir ? path.resolve(gitDir, commonDir) : undefined;
  } catch {
    const segments = gitDir.split(path.sep);
    const worktreesIndex = segments.lastIndexOf("worktrees");
    return worktreesIndex >= 0 ? segments.slice(0, worktreesIndex).join(path.sep) : undefined;
  }
}

function projectNameFromGitMarker(directory) {
  try {
    const gitMarker = path.join(directory, ".git");
    const markerStat = statSync(gitMarker);
    if (markerStat.isDirectory()) return cleanProjectName(path.basename(directory)) || undefined;
    if (!markerStat.isFile()) return undefined;

    const gitDirMatch = readFileSync(gitMarker, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
    if (!gitDirMatch) return undefined;
    const commonDir = commonGitDirectory(path.resolve(directory, gitDirMatch[1]));
    return commonDir ? cleanProjectName(path.basename(path.dirname(commonDir))) || undefined : undefined;
  } catch {
    // Project names are best-effort when historical checkout metadata is missing.
    return undefined;
  }
}

function projectNameFromCwd(cwd) {
  if (!cwd) return "unknown project";
  const resolved = path.resolve(cwd);
  if (PROJECT_NAME_CACHE.has(resolved)) return PROJECT_NAME_CACHE.get(resolved);

  let directory = resolved;
  while (true) {
    const project = projectNameFromGitMarker(directory);
    if (project) {
      PROJECT_NAME_CACHE.set(resolved, project);
      return project;
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  // Keep historical sessions grouped when a worktree's checkout has been removed.
  const segments = resolved.split(path.sep);
  const worktreesIndex = segments.lastIndexOf("worktrees");
  const dotWorktreesIndex = segments.lastIndexOf(".worktrees");
  let fallback = path.basename(resolved);
  if (worktreesIndex >= 0) {
    fallback = segments.length > worktreesIndex + 2
      ? segments[worktreesIndex + 1]
      : segments[worktreesIndex - 1] || fallback;
  } else if (dotWorktreesIndex > 0) {
    fallback = segments[dotWorktreesIndex - 1];
  }
  const name = cleanProjectName(fallback) || "unknown project";
  PROJECT_NAME_CACHE.set(resolved, name);
  return name;
}

export function eventsForSession(session, timeZone, extraction = { formatter: localTimeFormatter(timeZone), toolCalls: new Map() }) {
  const events = [];
  const { formatter, toolCalls } = extraction;
  const cwd = session.header.cwd || "";
  const project = projectNameFromCwd(cwd);

  for (const entry of session.entries) {
    const generated = eventFor(entry, formatter, toolCalls);
    if (!generated) continue;
    for (const event of Array.isArray(generated) ? generated : [generated]) {
      events.push({
        ...event,
        sessionId: session.header.id,
        project,
        cwd,
      });
    }
  }

  return events;
}


