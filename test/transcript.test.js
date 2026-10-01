import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eventsForSession, redactAndClip, sessionFromJsonl, sessionMetrics } from "../src/transcript.js";

function message(id, parentId, timestamp, role, content, extra = {}) {
  return {
    id,
    parentId,
    timestamp,
    type: "message",
    message: { role, content, timestamp: Date.parse(timestamp), ...extra },
  };
}

test("session parsing retains activity from alternate branches", () => {
  const source = [
    { type: "session", version: 2, id: "s1", cwd: "/work/demo" },
    { type: "message", id: "root", parentId: null, message: { role: "user", content: "start" } },
    { type: "message", id: "first", parentId: "root", message: { role: "assistant", content: "explored first path" } },
    { type: "message", id: "second", parentId: "root", message: { role: "user", content: "tried another path" } },
  ].map((record) => JSON.stringify(record)).join("\n");

  assert.deepEqual(sessionFromJsonl(source).entries.map((entry) => entry.id), ["root", "first", "second"]);
});

test("legacy linear sessions without entry IDs keep their ordered history", () => {
  const source = [
    { type: "session", version: 1, id: "legacy", cwd: "/work/demo" },
    { type: "message", timestamp: "2026-09-27T12:00:00.000Z", message: { role: "user", content: "first" } },
    { type: "message", timestamp: "2026-09-27T12:01:00.000Z", message: { role: "assistant", content: "second" } },
  ].map((record) => JSON.stringify(record)).join("\n");
  assert.equal(sessionFromJsonl(source).entries.length, 2);
});

test("session metrics aggregate billed usage across all recorded entry types without double-counting", () => {
  const usage = (input, output, cacheRead, cacheWrite, cost) => ({ input, output, cacheRead, cacheWrite, cost: { total: cost } });
  const session = {
    header: { timestamp: "2026-09-28T09:00:00Z" },
    entries: [
      { type: "message", timestamp: "2026-09-28T09:01:00Z", message: { role: "assistant", usage: usage(100, 20, 400, 5, 0.25) } },
      { type: "message", timestamp: "2026-09-28T09:02:00Z", message: { role: "toolResult", usage: usage(30, 10, 100, 0, 0.125) } },
      { type: "usage", timestamp: "2026-09-28T09:03:00Z", kind: "future-kind", usage: usage(4, 1, 40, 0, 0.01) },
      { type: "compaction", timestamp: "2026-09-28T09:04:00Z", usage: usage(2, 8, 60, 0, 0.015) },
      { type: "branch_summary", timestamp: "2026-09-28T09:05:00Z", usage: usage(1, 5, 20, 0, 0.02) },
      { type: "message", timestamp: "2026-09-28T09:06:00Z", message: { role: "user", usage: usage(999, 999, 999, 999, 99) } },
    ],
  };
  assert.deepEqual(sessionMetrics(session), {
    startedAt: "2026-09-28T09:00:00.000Z", endedAt: "2026-09-28T09:06:00.000Z", durationSeconds: 360,
    costUsd: 0.42, cacheReadTokens: 620, inputTokens: 137, outputTokens: 44, cacheWriteTokens: 5,
  });
});

test("unknown or malformed usage is omitted rather than displayed as zero", () => {
  assert.deepEqual(sessionMetrics({ header: {}, entries: [] }), {});
  assert.deepEqual(sessionMetrics({
    header: { timestamp: "2026-09-28T09:00:00Z" },
    entries: [{ type: "message", timestamp: "2026-09-28T09:00:30Z", message: { role: "assistant", usage: { input: NaN, cost: { total: -1 } } } }],
  }), { startedAt: "2026-09-28T09:00:00.000Z", endedAt: "2026-09-28T09:00:30.000Z", durationSeconds: 30 });
});

test("session event extraction groups by local date and keeps evidence, not thinking", () => {
  const session = {
    header: { type: "session", id: "session-1", cwd: "/work/demo" },
    entries: [
      message("u1", null, "2026-09-28T02:01:00.000Z", "user", [{ type: "text", text: "Fix the failing test" }]),
      message("a1", "u1", "2026-09-28T02:02:00.000Z", "assistant", [
        { type: "thinking", thinking: "private reasoning" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pnpm test" } },
      ], { stopReason: "toolUse" }),
      message("t1", "a1", "2026-09-28T02:03:00.000Z", "toolResult", [{ type: "text", text: "4 tests passed" }], {
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
      }),
      message("a2", "t1", "2026-09-28T02:04:00.000Z", "assistant", [{ type: "text", text: "The test now passes." }], {
        stopReason: "stop",
      }),
    ],
  };

  const events = eventsForSession(session, "America/New_York");
  assert.ok(events.every((event) => event.date === "2026-09-27"));
  assert.deepEqual(events.map((event) => event.kind), [
    "user intent",
    "action: bash",
    "result: bash",
    "assistant outcome",
  ]);
  assert.ok(events.every((event) => event.project === "demo"));
  assert.ok(!JSON.stringify(events).includes("private reasoning"));
});

test("try directory dates are removed from project labels without changing source paths", () => {
  for (const [cwd, project] of [
    ["/work/2026-01-17-learn", "learn"],
    ["/work/2026-09-27-logdig", "logdig"],
    ["/work/2026-01-17-my-project", "my-project"],
    ["/work/plain-project", "plain-project"],
    ["/work/my-2026-01-17-project", "my-2026-01-17-project"],
    ["/work/2026-01-17", "2026-01-17"],
    ["/work/2026-01-17-", "2026-01-17-"],
    ["/", "unknown project"],
    ["", "unknown project"],
  ]) {
    const session = {
      header: { id: "try-session", cwd },
      entries: [message("u1", null, "2026-09-28T12:00:00Z", "user", "Made progress.")],
    };
    const events = eventsForSession(session, "UTC");
    assert.equal(events[0].project, project);
    assert.equal(events[0].cwd, cwd);
    assert.equal(session.header.cwd, cwd);
  }
});

test("worktree projects resolve to the common repository name", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-worktree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "pi-tasks");
  const worktree = path.join(root, "worktrees", "tasks", "two");
  const gitDir = path.join(projectRoot, ".git", "worktrees", "two");
  await mkdir(worktree, { recursive: true });
  await mkdir(gitDir, { recursive: true });
  await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  await writeFile(path.join(gitDir, "commondir"), "../..\n");

  const session = {
    header: { id: "worktree-session", cwd: worktree },
    entries: [message("u1", null, "2026-09-28T12:00:00Z", "user", "Made progress.")],
  };
  const events = eventsForSession(session, "UTC");
  assert.equal(events[0].project, "pi-tasks");
  assert.equal(events[0].cwd, worktree);
});

test("Herdr worktree paths retain the project name when the checkout is gone", () => {
  const session = {
    header: { id: "removed-worktree", cwd: "/home/user/.herdr/worktrees/tasks/two" },
    entries: [message("u1", null, "2026-09-28T12:00:00Z", "user", "Made progress.")],
  };
  assert.equal(eventsForSession(session, "UTC")[0].project, "tasks");
});

test("sessionFromJsonl parses the header and preserves the file's append order", () => {
  const source = [
    { type: "session", id: "s1", cwd: "/work/demo" },
    { type: "message", id: "a", parentId: null, timestamp: "2026-09-27T12:00:00.000Z", message: { role: "user", content: "first" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2026-09-27T12:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "discarded" }] } },
    { type: "message", id: "c", parentId: "a", timestamp: "2026-09-27T12:02:00.000Z", message: { role: "user", content: "active branch" } },
  ].map((record) => JSON.stringify(record)).join("\n");

  const parsed = sessionFromJsonl(source);
  assert.equal(parsed.header.id, "s1");
  assert.deepEqual(parsed.entries.map((entry) => entry.id), ["a", "b", "c"]);
});

test("session events preserve order across local-date boundaries for journal timestamps", () => {
  const session = {
    header: { id: "session-cross-day", cwd: "/work/demo" },
    entries: [
      message("u1", null, "2026-09-28T02:01:00.000Z", "user", "First-day request"),
      message("a1", "u1", "2026-09-28T02:02:00.000Z", "assistant", "First-day outcome", { stopReason: "stop" }),
      message("u2", "a1", "2026-09-28T04:01:00.000Z", "user", "Next-day request"),
    ],
  };

  const events = eventsForSession(session, "America/New_York");
  assert.deepEqual(events.map(({ date, time, kind }) => [date, time, kind]), [
    ["2026-09-27", "22:01", "user intent"],
    ["2026-09-27", "22:02", "assistant outcome"],
    ["2026-09-28", "00:01", "user intent"],
  ]);
});

test("non-text user messages still provide a journal timestamp without including payloads", () => {
  const session = {
    header: { id: "session-image", cwd: "/work/demo" },
    entries: [message("image-prompt", null, "2026-09-28T04:01:00.000Z", "user", [
      { type: "image", data: "private-image-payload" },
    ])],
  };

  const events = eventsForSession(session, "America/New_York");
  assert.equal(events[0].date, "2026-09-28");
  assert.equal(events[0].time, "00:01");
  assert.equal(events[0].text, "non-text user input (payload omitted)");
  assert.ok(!JSON.stringify(events).includes("private-image-payload"));
});

test("redaction removes common credentials before evidence is sent to a model", () => {
  const result = redactAndClip("sk-abcdefghijklmnopqr Bearer abc.def api_key=hidden-value", 200);
  assert.ok(result.includes("sk-[REDACTED]") === false);
  assert.ok(result.includes("[REDACTED]"));
  assert.ok(!result.includes("hidden-value"));
  assert.ok(!result.includes("Bearer abc.def"));
});

test("redactAndClip bounds long session content", () => {
  const result = redactAndClip("x".repeat(20), 8);
  assert.equal(result, "xxxxxxxx\n[truncated]");
});
