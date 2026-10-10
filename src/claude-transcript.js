// Claude Code transcripts have their own record shapes, so this codec converts
// them into the Pi session shape that transcript.js and work-blocks.js read.
// Claude Code writes one record per content block, so one API message can span
// several records that share message.id. Those records are folded together here.

const TOOL_NAMES = new Map([
  ["Bash", "bash"],
  ["Read", "read"],
  ["Grep", "grep"],
  ["Glob", "find"],
  ["LS", "ls"],
  ["Edit", "edit"],
  ["MultiEdit", "edit"],
  ["NotebookEdit", "edit"],
  ["Write", "write"],
  ["WebSearch", "web_search"],
  ["WebFetch", "fetch_content"],
]);

const STOP_REASONS = new Map([
  ["end_turn", "stop"],
  ["stop_sequence", "stop"],
  ["max_tokens", "length"],
  ["tool_use", "toolUse"],
]);

function parseRecords(text) {
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Claude Code may still be writing the last line of an active session.
    }
  }
  return records;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function userText(text) {
  // Slash commands are stored as XML-like envelopes; keep the command and its arguments.
  const command = text.match(/^<command-name>([^<]*)<\/command-name>/);
  if (!command) return text;
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  return [command[1], args?.[1].trim()].filter(Boolean).join(" ");
}

function isLocalCommandOutput(text) {
  return /^<local-command-(?:stdout|stderr)>/.test(text.trim());
}

function toolName(name = "") {
  return TOOL_NAMES.get(name) || name.toLowerCase();
}

function toolArguments(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const { file_path: filePath, notebook_path: notebookPath, ...rest } = input;
  const path = filePath ?? notebookPath;
  return path === undefined ? rest : { ...rest, path };
}

function usageOf(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  };
}

function userEntry(id, timestamp, text) {
  return { type: "message", id, timestamp, message: { role: "user", content: text } };
}

function addUserEntries(record, entries, toolNames) {
  const { uuid, timestamp, message } = record;
  if (record.isCompactSummary) {
    entries.push({ type: "compaction", id: uuid, timestamp, summary: textOf(message.content) });
    return;
  }
  if (typeof message.content === "string") {
    if (!message.content.trim() || isLocalCommandOutput(message.content)) return;
    entries.push(userEntry(uuid, timestamp, userText(message.content)));
    return;
  }
  if (!Array.isArray(message.content)) return;

  const prompt = [];
  message.content.forEach((block, index) => {
    if (block?.type === "tool_result") {
      entries.push({
        type: "message",
        id: `${uuid}:${index}`,
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: block.tool_use_id,
          toolName: toolNames.get(block.tool_use_id),
          content: [{ type: "text", text: textOf(block.content) }],
          isError: block.is_error === true,
        },
      });
    } else if (block?.type === "text" || block?.type === "image") {
      prompt.push(block);
    }
  });

  const text = textOf(prompt);
  if (text || prompt.some((block) => block.type === "image")) {
    entries.push(userEntry(uuid, timestamp, text ? userText(text) : ""));
  }
}

function addAssistantEntry(record, entries, messages, toolNames) {
  const { uuid, timestamp, message } = record;
  const key = message.id || uuid;
  let entry = messages.get(key);
  if (!entry) {
    // Usage repeats on every record of the same message, so it is counted once.
    entry = {
      type: "message",
      id: uuid,
      timestamp,
      message: { role: "assistant", content: [], usage: usageOf(message.usage) },
    };
    messages.set(key, entry);
    entries.push(entry);
  }

  // The stop reason arrives on the last record of the message.
  const stopReason = STOP_REASONS.get(message.stop_reason);
  if (stopReason) entry.message.stopReason = stopReason;

  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const block of blocks) {
    if (block?.type === "text" && block.text?.trim()) {
      entry.message.content.push({ type: "text", text: block.text });
    } else if (block?.type === "tool_use") {
      const name = toolName(block.name);
      toolNames.set(block.id, name);
      entry.message.content.push({ type: "toolCall", id: block.id, name, arguments: toolArguments(block.input) });
    }
  }
}

export function claudeSessionFromJsonl(text, sourcePath = "<session>") {
  const records = parseRecords(text);
  const id = records.find((record) => typeof record.sessionId === "string")?.sessionId;
  if (!id) throw new Error(`${sourcePath}: missing Claude Code session id`);

  const header = {
    type: "session",
    id,
    cwd: records.find((record) => typeof record.cwd === "string")?.cwd || "",
    timestamp: records.find((record) => typeof record.timestamp === "string")?.timestamp,
  };

  const entries = [];
  const messages = new Map();
  const toolNames = new Map();
  for (const record of records) {
    // Subagent and meta records are not the user's own conversation.
    if (record.isSidechain || record.isMeta || !record.message) continue;
    if (record.type === "user") addUserEntries(record, entries, toolNames);
    else if (record.type === "assistant") addAssistantEntry(record, entries, messages, toolNames);
  }

  return { header, entries, sourcePath };
}

// A resumed Claude Code session copies its earlier records into a new file, so
// the same record can appear in two sessions. Keep each record once, in the
// earlier session. Sessions must be sorted by end time before calling this.
export function withoutSharedRecords(sessions) {
  const seen = new Set();
  return sessions.map((session) => ({
    ...session,
    entries: session.entries.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    }),
  }));
}
