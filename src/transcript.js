import { createHash } from "node:crypto";
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

export function fingerprintSession(session) {
  return createHash("sha256")
    .update(JSON.stringify([session.header, session.entries]))
    .digest("hex");
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

function timestampOf(entry) {
  const value = entry.timestamp ?? entry.message?.timestamp;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function localParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
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

function eventFor(entry, timeZone, toolCalls) {
  const timestamp = timestampOf(entry);
  if (timestamp === undefined) return undefined;
  const { date, time } = localParts(timestamp, timeZone);
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

export function eventsForSession(session, timeZone) {
  const events = [];
  const toolCalls = new Map();
  const cwd = session.header.cwd || "";
  const project = (cwd ? path.basename(cwd) : "").replace(/^\d{4}-\d{2}-\d{2}-(?=.)/, "") || "unknown project";

  for (const entry of session.entries) {
    const generated = eventFor(entry, timeZone, toolCalls);
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


