import test from "node:test";
import assert from "node:assert/strict";
import { assignLegacyBlocks, blockInRange, workBlocksForSession } from "../src/work-blocks.js";

function message(id, timestamp, role = "user", content = id) {
  return { type: "message", id, timestamp, message: { role, content, stopReason: "stop" } };
}

function blocks(entries, timeZone = "UTC") {
  return workBlocksForSession({ header: { id: "night-worker", cwd: "/work/demo" }, entries }, timeZone);
}

test("10pm to 2am stays one work block, then a rested next-day return starts a continuation", () => {
  const result = blocks([
    message("start", "2026-10-01T02:00:00Z"),
    message("working", "2026-10-01T04:00:00Z", "assistant"),
    message("late", "2026-10-01T06:00:00Z"),
    message("done", "2026-10-01T06:10:00Z", "assistant"),
    message("resume", "2026-10-01T15:00:00Z"),
  ], "America/Toronto");
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(({ date, time }) => [date, time]), [["2026-09-30", "22:00"], ["2026-10-01", "11:00"]]);
  assert.deepEqual(result[0].activityDates, ["2026-09-30", "2026-10-01"]);
  assert.equal(result[1].previousBlockId, result[0].blockId);
  assert.equal(result[1].events[0].text, "resume");
  assert.ok(result[1].context.some((event) => event.text === "done"));
});

test("both a later local date and at least four hours of inactivity are required", () => {
  for (const [start, resume, count] of [
    ["2026-09-30T08:00:00Z", "2026-09-30T18:00:00Z", 1],
    ["2026-09-30T23:00:00Z", "2026-10-01T02:59:59Z", 1],
    ["2026-09-30T23:00:00Z", "2026-10-01T03:00:00Z", 2],
    ["2026-09-30T23:00:00Z", "2026-10-02T00:00:00Z", 2],
  ]) {
    assert.equal(blocks([message("start", start), message("resume", resume)]).length, count);
  }
});

test("assistant and even filtered tool-result activity prevent false inactivity gaps", () => {
  for (const role of ["assistant", "toolResult", "bashExecution"]) {
    const result = blocks([
      message("start", "2026-09-30T22:00:00Z"),
      message("ongoing", "2026-10-01T01:30:00Z", role),
      message("resume", "2026-10-01T02:00:00Z"),
    ]);
    assert.equal(result.length, 1, role);
  }
});

test("tool results retain their call evidence even when a deferred call crosses a block boundary", () => {
  const result = blocks([
    message("start", "2026-09-30T22:00:00Z"),
    { type: "message", id: "call", timestamp: "2026-09-30T22:01:00Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "test-call", name: "bash", arguments: { command: "npm test" } }] } },
    message("resume", "2026-10-01T11:00:00Z"),
    { type: "message", id: "result", timestamp: "2026-10-01T11:01:00Z", message: { role: "toolResult", toolName: "bash", toolCallId: "test-call", content: "Tests passed." } },
  ]);
  assert.equal(result.length, 2);
  assert.ok(result[1].events.some((event) => event.kind === "result: bash" && event.text === "Tests passed."));
});

test("bookkeeping activity does not conceal an inactivity gap or change block identity", () => {
  const entries = [message("start", "2026-09-30T22:00:00Z"), message("resume", "2026-10-01T10:00:00Z")];
  const original = blocks(entries);
  const withMetadata = blocks([
    entries[0],
    { type: "session_info", timestamp: "2026-10-01T09:59:00Z", name: "Renamed" },
    { type: "custom", timestamp: "2026-10-01T09:59:30Z", data: { internal: true } },
    entries[1],
  ]);
  assert.deepEqual(withMetadata.map((block) => block.blockId), original.map((block) => block.blockId));
  assert.deepEqual(withMetadata.map((block) => block.events), original.map((block) => block.events));
});

test("assistant completion after midnight never starts a block without a new user message", () => {
  const result = blocks([message("start", "2026-09-30T22:00:00Z"), message("done", "2026-10-01T06:00:00Z", "assistant")]);
  assert.equal(result.length, 1);
  assert.equal(result[0].date, "2026-09-30");
  assert.equal(blockInRange(result[0], { firstDate: "2026-10-01", lastDate: "2026-10-01" }), true);
  assert.equal(blockInRange(result[0], { firstDate: "2026-10-02", lastDate: "2026-10-02" }), false);
});

test("skip-today excludes overnight activity, including filtered tool results, but not bookkeeping", () => {
  const range = { firstDate: "2026-09-24", lastDate: "2026-09-30", skipToday: true };
  for (const role of ["user", "assistant", "toolResult", "bashExecution"]) {
    const [block] = blocks([message("start", "2026-09-30T22:00:00Z"), message("overnight", "2026-10-01T00:01:00Z", role, "")]);
    assert.equal(blockInRange(block, range), false, role);
    assert.equal(blockInRange(block, { ...range, firstDate: undefined }), false, `all: ${role}`);
    assert.equal(blockInRange(block, { ...range, skipToday: false }), true, `normal: ${role}`);
  }
  const [past] = blocks([message("start", "2026-09-30T22:00:00Z"), { type: "session_info", timestamp: "2026-10-01T00:01:00Z", name: "Renamed" }]);
  assert.equal(blockInRange(past, range), true);
});

test("the inactivity clock uses elapsed time across DST, not wall-clock subtraction", () => {
  const result = blocks([
    message("start", "2026-10-31T23:30:00-04:00"),
    message("resume", "2026-11-01T02:30:00-05:00"),
  ], "America/Toronto");
  assert.equal(result.length, 2);
});

test("legacy sessions without entry IDs have stable block identities when metadata is appended", () => {
  const entries = [message(undefined, "2026-09-30T22:00:00Z", "user", "Start"), message(undefined, "2026-10-01T10:00:00Z", "user", "Continue")];
  const original = blocks(entries);
  const updated = blocks([...entries, { type: "usage", timestamp: "2026-10-01T10:01:00Z" }]);
  assert.deepEqual(updated.map((block) => block.blockId), original.map((block) => block.blockId));
});

test("earlier context is bounded and later blocks never change earlier evidence", () => {
  const entries = Array.from({ length: 30 }, (_, index) => message(`event-${index}`, `2026-09-30T22:${String(index).padStart(2, "0")}:00Z`, "user", "x".repeat(1700)));
  const first = blocks(entries)[0];
  const result = blocks([...entries, message("resume", "2026-10-01T10:00:00Z")]);
  assert.equal(result[0].blockId, first.blockId);
  assert.deepEqual(result[0].events, first.events);
  assert.ok(result[1].context.length > 0);
  assert.ok(result[1].context.length <= 6);
  assert.ok(JSON.stringify(result[1].context).length <= 3202);
});

test("context-summary-only history remains journalable without needing a user message", () => {
  const result = blocks([{ type: "compaction", id: "context", timestamp: "2026-09-30T22:00:00Z", summary: "Earlier work made progress." }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].events[0].kind, "context summary");
  assert.equal(result[0].date, "2026-09-30");
});

test("legacy snapshots map to the block containing their old journal timestamp", () => {
  const result = blocks([message("start", "2026-09-30T22:00:00Z"), message("late", "2026-10-01T00:10:00Z"), message("resume", "2026-10-01T10:00:00Z")]);
  const versions = [{ date: "2026-10-01", time: "00:10" }, { date: "2026-10-01", time: "10:00" }, { date: "2026-09-30", time: "22:00", blockId: result[0].blockId }];
  assignLegacyBlocks(versions, result);
  assert.equal(versions[0].blockId, result[0].blockId);
  assert.equal(versions[1].blockId, result[1].blockId);
  assert.equal(versions[2].blockId, result[0].blockId);
  assert.equal(versions[2].legacy, undefined);
  assert.equal(versions[0].legacy, true);
});
