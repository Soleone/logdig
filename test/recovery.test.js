import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeSessions } from "../src/session-runner.js";

test("a failed daily-note write keeps the successful summary and reuses it on retry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), dailyHeader: "# Log", dailySummary: "small", timeZone: "UTC" };
  await writeFile(settings.dailyDirectory, "This file must not be overwritten.");
  const session = {
    header: { type: "session", id: "recoverable", cwd: "/work/demo" },
    entries: [{ type: "message", timestamp: "2026-09-28T12:00:00Z", message: { role: "user", content: "Record this progress." } }],
  };
  let calls = 0;
  const model = { complete: async () => { calls++; return JSON.stringify({ small: "Made progress.", medium: "A little more detail.", large: "A short timeline." }); } };
  const first = await writeSessions(model, [session], settings);
  assert.equal(first.summariesCreated, 1);
  assert.equal(first.entriesAppended, 0);
  assert.equal(first.errors.length, 1);
  assert.equal(calls, 1);
  assert.equal(await readFile(settings.dailyDirectory, "utf8"), "This file must not be overwritten.");
  const cachePath = path.join(settings.cacheDirectory, "Sessions", "recoverable.md");
  const cached = await readFile(cachePath, "utf8");

  await rm(settings.dailyDirectory);
  const retry = await writeSessions(model, [session], settings);
  assert.equal(retry.summariesCreated, 0);
  assert.equal(retry.summariesReused, 1);
  assert.equal(retry.entriesAppended, 1);
  assert.deepEqual(retry.errors, []);
  assert.equal(calls, 1);
  assert.equal(await readFile(cachePath, "utf8"), cached);
  assert.match(await readFile(path.join(settings.dailyDirectory, "2026-09-28.md"), "utf8"), /Made progress/);
});
