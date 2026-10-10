import test from "node:test";
import assert from "node:assert/strict";
import { claudeSessionFromJsonl, withoutSharedRecords } from "../src/claude-transcript.js";
import { eventsForSession, sessionMetrics } from "../src/transcript.js";
import { workBlocksForSession } from "../src/work-blocks.js";

const usage = (input, output, cacheRead, cacheWrite) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

function record(fields) {
  return JSON.stringify({ sessionId: "claude-1", cwd: "/work/demo", isSidechain: false, ...fields });
}

const transcript = [
  record({ type: "mode", mode: "normal" }),
  record({ type: "user", uuid: "u1", timestamp: "2026-09-28T09:00:00.000Z", message: { role: "user", content: "Fix the login bug" } }),
  // One API message arrives as several records: thinking, then a tool call. Usage is the same on each.
  record({ type: "assistant", uuid: "a1", timestamp: "2026-09-28T09:00:05.000Z", message: { id: "msg-1", role: "assistant", content: [{ type: "thinking", thinking: "private" }], usage: usage(100, 20, 400, 5), stop_reason: null } }),
  record({ type: "assistant", uuid: "a2", timestamp: "2026-09-28T09:00:06.000Z", message: { id: "msg-1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }], usage: usage(100, 20, 400, 5), stop_reason: "tool_use" } }),
  record({ type: "user", uuid: "u2", timestamp: "2026-09-28T09:00:07.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "1 failing test" }], is_error: true }] } }),
  record({ type: "assistant", uuid: "a3", timestamp: "2026-09-28T09:00:08.000Z", message: { id: "msg-2", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/work/demo/login.js", old_string: "a", new_string: "b" } }], usage: usage(50, 10, 0, 0), stop_reason: "tool_use" } }),
  record({ type: "user", uuid: "u3", timestamp: "2026-09-28T09:00:09.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok", is_error: false }] } }),
  record({ type: "assistant", uuid: "a4", timestamp: "2026-09-28T09:00:10.000Z", message: { id: "msg-3", role: "assistant", content: [{ type: "text", text: "Fixed the login redirect." }], usage: usage(60, 30, 0, 0), stop_reason: "end_turn" } }),
  record({ type: "assistant", uuid: "side", isSidechain: true, timestamp: "2026-09-28T09:00:11.000Z", message: { id: "msg-side", role: "assistant", content: [{ type: "text", text: "subagent chatter" }], usage: usage(999, 999, 0, 0) } }),
  record({ type: "user", uuid: "meta", isMeta: true, timestamp: "2026-09-28T09:00:12.000Z", message: { role: "user", content: "<local-command-caveat>ignore me</local-command-caveat>" } }),
  record({ type: "user", uuid: "cmd", timestamp: "2026-09-28T09:00:13.000Z", message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>" } }),
  '{"type":"assistant","uuid":"half-written',
].join("\n");

test("Claude Code transcripts become Pi-shaped sessions with folded messages and normalized tools", () => {
  const session = claudeSessionFromJsonl(transcript, "claude.jsonl");

  assert.equal(session.header.id, "claude-1");
  assert.equal(session.header.cwd, "/work/demo");
  assert.deepEqual(session.entries.map((entry) => entry.id), ["u1", "a1", "u2:0", "a3", "u3:0", "a4", "cmd"]);

  const [, firstAssistant, , editAssistant] = session.entries;
  assert.deepEqual(firstAssistant.message.content, [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } }]);
  assert.deepEqual(editAssistant.message.content[0].arguments, { old_string: "a", new_string: "b", path: "/work/demo/login.js" });
  assert.equal(session.entries[2].message.toolName, "bash");
  assert.equal(session.entries[2].message.isError, true);
  assert.equal(session.entries[5].message.stopReason, "stop");
  assert.equal(session.entries[6].message.content, "/model opus");
});

test("usage is counted once per API message, and sidechain or meta records are ignored", () => {
  const metrics = sessionMetrics(claudeSessionFromJsonl(transcript, "claude.jsonl"));
  assert.equal(metrics.inputTokens, 210);
  assert.equal(metrics.outputTokens, 60);
  assert.equal(metrics.cacheReadTokens, 400);
  assert.equal(metrics.cacheWriteTokens, 5);
});

test("Claude sessions flow through the existing work-block and event pipeline", () => {
  const [block] = workBlocksForSession(claudeSessionFromJsonl(transcript, "claude.jsonl"), "UTC");
  assert.equal(block.project, "demo");
  assert.deepEqual(block.events.map((event) => event.kind), [
    "user intent",
    "action: bash",
    "error: bash",
    "action: edit",
    "result: edit",
    "assistant outcome",
    "user intent",
  ]);
  assert.equal(block.events[1].text, "npm test");
});

test("a partly written final line does not stop an active session from being read", () => {
  assert.doesNotThrow(() => claudeSessionFromJsonl(transcript, "claude.jsonl"));
});

test("a file without a Claude Code session id is rejected with its path", () => {
  assert.throws(() => claudeSessionFromJsonl('{"type":"user"}', "orphan.jsonl"), /orphan\.jsonl: missing Claude Code session id/);
});

test("a resumed session keeps each shared record in the earlier session only", () => {
  const earlier = claudeSessionFromJsonl([
    record({ type: "user", uuid: "shared", timestamp: "2026-09-28T09:00:00.000Z", message: { role: "user", content: "start" } }),
  ].join("\n"), "earlier.jsonl");
  const resumed = claudeSessionFromJsonl([
    record({ sessionId: "claude-2", type: "user", uuid: "shared", timestamp: "2026-09-28T09:00:00.000Z", message: { role: "user", content: "start" } }),
    record({ sessionId: "claude-2", type: "user", uuid: "new", timestamp: "2026-09-28T10:00:00.000Z", message: { role: "user", content: "continue" } }),
  ].join("\n"), "resumed.jsonl");

  const [kept, trimmed] = withoutSharedRecords([earlier, resumed]);
  assert.deepEqual(kept.entries.map((entry) => entry.id), ["shared"]);
  assert.deepEqual(trimmed.entries.map((entry) => entry.id), ["new"]);
});
