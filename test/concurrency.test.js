import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeSessions } from "../src/session-runner.js";
import { loadSettings, saveSettings, validateSettings } from "../src/settings.js";
import { parseSessionNote } from "../src/journal.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function session(id, date = "2026-10-01", hour = 12) {
  const timestamp = `${date}T${String(hour).padStart(2, "0")}:00:00Z`;
  return {
    header: { id, cwd: "/work/demo", timestamp },
    entries: [{ type: "message", id: `${id}-${date}-user`, timestamp, message: { role: "user", content: `Record ${id}` } }],
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-concurrency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = {
    cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"),
    dailyHeader: "# Projects", dailySummary: "small", timeZone: "UTC", piCommand: "pi",
  };
  return { root, settings };
}

const layers = JSON.stringify({ small: "Summary.", medium: "Progress.", large: "Timeline." });

test("concurrency defaults, saved values, and validation", async (t) => {
  const { root, settings } = await fixture(t);
  const filePath = path.join(root, "settings.json");
  assert.equal((await loadSettings({ filePath, env: {} })).concurrency, 4);
  // Older settings files do not contain a concurrency setting.
  await writeFile(filePath, JSON.stringify(settings));
  assert.equal((await loadSettings({ filePath, env: {} })).concurrency, 4);
  await saveSettings(settings, filePath);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).concurrency, 4);
  await saveSettings({ ...settings, concurrency: 2 }, filePath);
  assert.equal((await loadSettings({ filePath, env: {} })).concurrency, 2);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).concurrency, 2);
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, null, true, {}, "", "0", "-1", "1.5", "1e2", "0x4", "four"]) {
    assert.throws(() => validateSettings({ ...settings, concurrency: invalid }), /concurrency/, String(invalid));
  }
});

for (const [concurrency, expected] of [[undefined, 4], [1, 1], [2, 2], [20, 7]]) {
  test(`session concurrency ${concurrency ?? "default"} is bounded, preserves shared notes, and reports in input order`, { timeout: 10_000 }, async (t) => {
    const { settings } = await fixture(t);
    if (concurrency !== undefined) settings.concurrency = concurrency;
    const sessions = Array.from({ length: 7 }, (_, index) => session(`session-${index}`, "2026-10-01", 12 + index));
    const started = deferred();
    const release = deferred();
    const releaseFirst = deferred();
    t.after(() => { release.resolve(); releaseFirst.resolve(); });
    let active = 0;
    let peak = 0;
    let calls = 0;
    const callsBySession = new Map();
    const completed = [];
    const sessionsCompleted = [];
    const model = { complete: async (prompt) => {
      const id = prompt.match(/Record (session-\d+)/)[1];
      callsBySession.set(id, (callsBySession.get(id) || 0) + 1);
      const call = ++calls;
      peak = Math.max(peak, ++active);
      if (calls === expected) started.resolve();
      await release.promise;
      if (call === 1 && expected > 1) await releaseFirst.promise;
      active--;
      return layers;
    } };
    await mkdir(settings.dailyDirectory);
    const dailyPath = path.join(settings.dailyDirectory, "2026-10-01.md");
    await writeFile(dailyPath, "# Personal\n\nKeep my writing.\n");
    const pending = writeSessions(model, sessions, settings, {
      onProgress: (event) => {
        if (event.phase !== "complete") return;
        completed.push(event.index);
        if (completed.length === sessions.length - 1) releaseFirst.resolve();
      },
      onSessionComplete: (event) => sessionsCompleted.push(event.index),
    });
    await started.promise;
    assert.equal(active, expected);
    assert.equal(calls, expected);
    release.resolve();
    const result = await pending;
    assert.equal(peak, expected);
    assert.deepEqual([...sessionsCompleted].sort((left, right) => left - right), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(calls, sessions.length);
    assert.deepEqual([...callsBySession.entries()].sort(), sessions.map((item) => [item.header.id, 1]));
    assert.deepEqual(result.errors, []);
    assert.equal(result.summariesCreated, sessions.length);
    assert.equal(result.entriesAppended, sessions.length);
    assert.deepEqual(result.sessionResults.map((entry) => entry.sessionId), sessions.map((item) => item.header.id));
    if (expected > 1) {
      assert.notEqual(completed[0], 1);
      assert.equal(completed.at(-1), 1);
    }
    const markdown = await readFile(dailyPath, "utf8");
    assert.match(markdown, /Keep my writing\./);
    assert.equal((markdown.match(/\*\*\[\[/g) || []).length, sessions.length);
    const times = [...markdown.matchAll(/\|([0-9]{2}:00)\]\]\*\*/g)].map((match) => match[1]);
    assert.deepEqual(times, ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]);
    assert.equal((await readdir(path.join(settings.cacheDirectory, "Sessions"))).length, sessions.length);
    assert.equal((await readdir(path.join(settings.cacheDirectory, "Entries"))).length, sessions.length);
    const repeated = await writeSessions(model, sessions, { ...settings, concurrency: 1 });
    assert.deepEqual(repeated.errors, []);
    assert.equal(repeated.entriesSkipped, sessions.length);
    assert.equal(repeated.summariesReused, sessions.length);
    assert.equal(calls, sessions.length);
    assert.equal(await readFile(dailyPath, "utf8"), markdown);
  });
}

test("parallel sessions retain sequential work blocks and real continuation snapshots", async (t) => {
  const { settings } = await fixture(t);
  const sessions = [session("first"), session("second")];
  for (const item of sessions) item.entries.push(...session(item.header.id, "2026-10-02").entries);
  let calls = 0;
  const progress = [];
  const result = await writeSessions({ complete: async () => { calls++; return layers; } }, sessions, settings, {
    onProgress: (event) => progress.push(event),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(calls, 4);
  assert.equal(result.entriesAppended, 4);
  for (const id of ["first", "second"]) {
    const events = progress.filter((event) => event.sessionId === id);
    assert.deepEqual(events.map((event) => [event.blockIndex, event.blockTotal, event.status]), [
      [1, 2, "CHECKING"], [1, 2, "SUMMARIZING"], [1, 2, "SAVED"],
      [2, 2, "CHECKING"], [2, 2, "SUMMARIZING"], [2, 2, "SAVED"],
    ]);
    assert.equal(new Set(events.map((event) => event.index)).size, 1);
    assert.equal(new Set(events.map((event) => event.blockId)).size, 2);
    const [earlier, later] = result.sessionResults.filter((entry) => entry.sessionId === id);
    assert.equal(earlier.continuationOf, undefined);
    const snapshot = parseSessionNote(await readFile(path.join(settings.cacheDirectory, "Entries", `${later.continuationOf}.md`), "utf8"));
    assert.equal(snapshot.sessionId, id);
    assert.equal(snapshot.blockId, earlier.blockId);
  }
});

test("a failed queued daily-note write does not poison other session writes and can be retried from cache", async (t) => {
  const { settings } = await fixture(t);
  const blockedPath = path.join(settings.dailyDirectory, "2026-10-01.md");
  await mkdir(blockedPath, { recursive: true });
  const sessions = [session("blocked"), session("valid", "2026-10-02")];
  let calls = 0;
  const failedWrite = deferred();
  const model = { complete: async (prompt) => {
    calls++;
    if (prompt.includes("Record valid")) await failedWrite.promise;
    return layers;
  } };
  const result = await writeSessions(model, sessions, settings, {
    onProgress: (event) => { if (event.phase === "error") failedWrite.resolve(); },
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^blocked:/);
  assert.equal(result.entriesAppended, 1);
  assert.equal(calls, 2);
  await readFile(path.join(settings.dailyDirectory, "2026-10-02.md"));
  await rm(blockedPath, { recursive: true });
  const retried = await writeSessions(model, sessions, settings);
  assert.deepEqual(retried.errors, []);
  assert.equal(retried.summariesReused, 2);
  assert.equal(retried.entriesAppended, 1);
  assert.equal(retried.entriesSkipped, 1);
  assert.equal(calls, 2);
});

test("model failures do not stop queued sessions and errors retain input order", async (t) => {
  const { settings } = await fixture(t);
  settings.concurrency = 2;
  const releaseFirst = deferred();
  const sessions = Array.from({ length: 5 }, (_, index) => session(`session-${index}`));
  const result = await writeSessions({ complete: async (prompt) => {
    if (prompt.includes("Record session-0")) {
      await releaseFirst.promise;
      throw new Error("first failure");
    }
    if (prompt.includes("Record session-1")) {
      releaseFirst.resolve();
      throw new Error("second failure");
    }
    return layers;
  } }, sessions, settings);
  assert.equal(result.entriesAppended, 3);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /^session-0:.*first failure/);
  assert.match(result.errors[1], /^session-1:.*second failure/);
  assert.deepEqual(result.sessionResults.map((entry) => entry.sessionId), sessions.map((item) => item.header.id));
});

test("empty parallel input needs no model calls or writes", async (t) => {
  const { root, settings } = await fixture(t);
  const result = await writeSessions({ complete: () => assert.fail("no sessions") }, [], settings);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.sessionResults, []);
  assert.deepEqual(await readdir(root), []);
});
