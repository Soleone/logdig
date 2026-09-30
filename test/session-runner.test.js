import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectSessions, parseBackfillArgument, writeSessions } from "../src/session-runner.js";
import { sessionFromJsonl } from "../src/transcript.js";

function sessionFile(id, timestamp) {
  return [
    { type: "session", version: 3, id, cwd: "/work/demo", timestamp: new Date(timestamp).toISOString() },
    {
      type: "message",
      id: `${id}-user`,
      parentId: null,
      timestamp,
      message: { role: "user", content: "Record this work", timestamp },
    },
  ].map((record) => JSON.stringify(record)).join("\n");
}

test("saved sessions are processed chronologically, not by filesystem name order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-history-"));
  const sessionsPath = path.join(root, "sessions");
  await mkdir(sessionsPath);
  try {
    await writeFile(path.join(sessionsPath, "a-later.jsonl"), sessionFile("later", Date.now() - 1_000));
    await writeFile(path.join(sessionsPath, "z-earlier.jsonl"), sessionFile("earlier", Date.now() - 10_000));
    const result = await collectSessions({ sessionDirectory: sessionsPath, timeZone: "UTC" });
    assert.deepEqual(result.sessions.map((session) => session.header.id), ["earlier", "later"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backfill range accepts day counts and all", () => {
  assert.deepEqual(parseBackfillArgument("7"), { days: 7 });
  assert.deepEqual(parseBackfillArgument("all"), { all: true });
  assert.throws(() => parseBackfillArgument("0"), /Usage: logdig backfill/);
  assert.deepEqual(parseBackfillArgument(), { days: 3 });
  assert.deepEqual(parseBackfillArgument(" ALL "), { all: true });
  for (const invalid of ["1e2", "0x10", "1.5", "-1", "3651", "yes"]) {
    assert.throws(() => parseBackfillArgument(invalid), /Choose 1 to 3650/, invalid);
  }
});

test("preview uses the last user timestamp, skips empty and out-of-range sessions, and makes no writes or model requests", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), dailyHeader: "# Log", dailySummary: "small", timeZone: "America/New_York" };
  const session = sessionFromJsonl(sessionFile("in-range", Date.parse("2026-09-28T03:00:00Z")));
  session.entries.push({ type: "message", timestamp: "2026-09-28T05:00:00Z", message: { role: "assistant", content: "Finished", stopReason: "stop" } });
  const old = sessionFromJsonl(sessionFile("old", Date.parse("2026-09-25T12:00:00Z")));
  const empty = { header: { id: "empty" }, entries: [] };
  const progress = [];
  const result = await writeSessions({ complete: () => assert.fail("preview must not call a model") }, [empty, old, session], settings, {
    dryRun: true, firstDate: "2026-09-27", lastDate: "2026-09-27", onProgress: (event) => progress.push(event),
  });
  assert.equal(result.summariesCreated, 1);
  assert.equal(result.entriesAppended, 1);
  assert.equal(result.sessionsSkipped, 2);
  assert.deepEqual(result.dates, ["2026-09-27"]);
  assert.deepEqual(result.dailyPaths, [path.join(settings.dailyDirectory, "2026-09-27.md")]);
  assert.equal(progress.at(-1).time, "23:00");
  assert.equal(progress.at(-1).project, "demo");
  assert.deepEqual(await readdir(root), []);
});

test("one malformed session does not prevent the remaining sessions from being saved", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), dailyHeader: "# Log", dailySummary: "small", timeZone: "UTC" };
  const invalid = { header: { id: "invalid" }, entries: [{ type: "message", timestamp: Number.MAX_VALUE, message: { role: "user", content: "invalid timestamp" } }] };
  const valid = sessionFromJsonl(sessionFile("valid", Date.now()));
  let calls = 0;
  const result = await writeSessions({ complete: async () => { calls++; return JSON.stringify({ small: "Summary.", medium: "Progress.", large: "Timeline." }); } }, [invalid, valid], settings);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /invalid:/);
  assert.equal(result.entriesAppended, 1);
  assert.equal(calls, 1);
});

test("missing saved history gives a useful warning while still including the active session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-missing-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentSession = sessionFromJsonl(sessionFile("live", Date.now()));
  const result = await collectSessions({ sessionDirectory: path.join(root, "missing"), timeZone: "UTC", currentSession });
  assert.deepEqual(result.sessions.map((session) => session.header.id), ["live"]);
  assert.match(result.warnings[0], /history folder not found.*logdig init/);
});
