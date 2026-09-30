import test from "node:test";
import assert from "node:assert/strict";
import { parseSessionNote, renderSessionNote, summarizeSession } from "../src/journal.js";

const session = {
  header: { id: "01-session", cwd: "/work/demo" },
  project: "demo",
  date: "2026-09-27",
  time: "10:25",
  timezone: "America/New_York",
  sourceFingerprint: "source-123",
  events: [],
};
const summary = {
  small: "Fixed the parser test and confirmed the suite passes.",
  medium: "## Goal\nFix the parser test.\n\n## Progress\nUpdated the parser.\n\n## Status\nDone, tests passed.",
  large: "2026-09-27 09:10 Started with a failing parser test.\n\n2026-09-27 10:25 The test passed after the fix.",
};

test("session cache stores all three layers and round-trips its metadata", () => {
  const markdown = renderSessionNote(session, summary, "cache-123", "test/fake");
  const parsed = parseSessionNote(markdown);

  assert.equal(parsed.date, "2026-09-27");
  assert.equal(parsed.time, "10:25");
  assert.equal(parsed.sessionId, "01-session");
  assert.equal(parsed.project, "demo");
  assert.equal(parsed.sourceFingerprint, "source-123");
  assert.equal(parsed.cacheFingerprint, "cache-123");
  assert.deepEqual(parsed.summary, summary);
  assert.match(markdown, /^# Small/m);
  assert.match(markdown, /^# Medium/m);
  assert.match(markdown, /^# Large/m);
});

test("large session evidence is summarized in bounded chunks before final layers", async () => {
  let calls = 0;
  const modelClient = {
    modelLabel: "test/fake",
    complete: async (prompt) => {
      calls++;
      const result = prompt.includes("Extract a compact factual timeline")
        ? { timeline: "- [2026-09-27 09:00] Reviewed work and recorded the result." }
        : summary;
      return JSON.stringify(result);
    },
  };
  const longSession = {
    ...session,
    events: Array.from({ length: 24 }, (_, index) => ({
      date: "2026-09-27",
      time: `09:${String(index).padStart(2, "0")}`,
      project: "demo",
      sessionId: "session-large",
      kind: "user intent",
      text: `${index}: ${"detailed session evidence ".repeat(50)}`,
    })),
  };

  const result = await summarizeSession(modelClient, longSession);
  assert.deepEqual(result, summary);
  assert.ok(calls > 2, `expected chunk calls plus a final call, got ${calls}`);
});
