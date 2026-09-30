import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendDailyEntry, dailyEntryId, inspectDailyEntry, parseSessionNote } from "../src/journal.js";
import { writeSessions } from "../src/session-runner.js";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const daily = path.join(root, "daily");
  const cache = path.join(root, "cache");
  const sessionPath = path.join(cache, "Sessions", "one.md");
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, "Full summary.\n");
  const entry = { date: "2026-09-28", time: "09:00", project: "demo", sessionId: "one", cacheFingerprint: "cache-one", summaryLevel: "small", summary: "Made progress.", sessionPath };
  return { root, daily, cache, entry };
}

test("timestamp links open immutable three-layer snapshots as a session changes", async (t) => {
  const { daily, cache } = await workspace(t);
  const settings = { cacheDirectory: cache, dailyDirectory: daily, dailyHeader: "# Log", dailySummary: "small", timeZone: "UTC" };
  const session = {
    header: { id: "versioned", cwd: "/work/demo" },
    entries: [{ type: "message", timestamp: "2026-09-28T09:00:00Z", message: { role: "user", content: "First change." } }],
  };
  let calls = 0;
  const model = { complete: async () => {
    calls++;
    return JSON.stringify({ small: `Change ${calls}.`, medium: `Details ${calls}.`, large: `Timeline ${calls}.` });
  } };
  assert.deepEqual((await writeSessions(model, [session], settings)).errors, []);
  const dailyPath = path.join(daily, "2026-09-28.md");
  const firstId = (await readFile(dailyPath, "utf8")).match(/\[\[([a-f0-9]{64})\|09:00\]\]/)[1];
  const firstPath = path.join(cache, "Entries", `${firstId}.md`);
  const original = await readFile(firstPath, "utf8");
  assert.deepEqual(parseSessionNote(original).summary, { small: "Change 1.", medium: "Details 1.", large: "Timeline 1." });

  session.entries.push({ type: "message", timestamp: "2026-09-28T10:00:00Z", message: { role: "user", content: "Second change." } });
  assert.deepEqual((await writeSessions(model, [session], settings)).errors, []);
  const dailyText = await readFile(dailyPath, "utf8");
  const ids = [...dailyText.matchAll(/\[\[([a-f0-9]{64})\|\d{2}:\d{2}\]\]/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(await readFile(firstPath, "utf8"), original);
  const latest = await readFile(path.join(cache, "Entries", `${ids[1]}.md`), "utf8");
  assert.equal(parseSessionNote(latest).summary.small, "Change 2.");
  assert.equal(latest, await readFile(path.join(cache, "Sessions", "versioned.md"), "utf8"));
  assert.equal((await writeSessions(model, [session], settings, { dryRun: true })).entriesSkipped, 1);
  assert.equal((await writeSessions(model, [session], settings)).entriesSkipped, 1);
  assert.equal(calls, 2);
  assert.equal(await readFile(dailyPath, "utf8"), dailyText);
  assert.equal((await readdir(path.join(cache, "Entries"))).length, 2);
});

test("older project-name links still deduplicate without rewriting the entry", async (t) => {
  const { daily, entry } = await workspace(t);
  await mkdir(daily);
  const id = dailyEntryId(entry, "# Log");
  const original = `# Log\n\n**09:00 · [[${id}|demo]]**\n\nMade progress.\n`;
  const dailyPath = path.join(daily, `${entry.date}.md`);
  await writeFile(dailyPath, original);
  assert.equal((await inspectDailyEntry(daily, "# Log", entry)).appended, false);
  assert.equal((await appendDailyEntry(daily, "# Log", entry)).appended, false);
  assert.equal(await readFile(dailyPath, "utf8"), original);
});

test("legacy comments still deduplicate and preserve insertion boundaries alongside linked entries", async (t) => {
  const { daily, entry } = await workspace(t);
  await mkdir(daily);
  const id = dailyEntryId(entry, "# Log");
  const legacy = `# Log\n\n<!-- logdig:${id}:start -->\n**09:00 · demo**\n\n## Nested\n\n\`\`\`md\n# Still generated\n\n<!-- logdig:${id}:end -->\n\n# Personal\n\nUntouched.\n`;
  const dailyPath = path.join(daily, `${entry.date}.md`);
  await writeFile(dailyPath, legacy);
  assert.equal((await appendDailyEntry(daily, "# Log", entry)).appended, false);
  assert.equal(await readFile(dailyPath, "utf8"), legacy);
  await appendDailyEntry(daily, "# Log", { ...entry, sessionId: "two", time: "10:00" });
  await appendDailyEntry(daily, "# Log", { ...entry, sessionId: "three", time: "11:00" });
  const updated = await readFile(dailyPath, "utf8");
  assert.ok(updated.indexOf("|10:00]]**") > updated.indexOf(`logdig:${id}:end`));
  assert.ok(updated.indexOf("|11:00]]**") > updated.indexOf("|10:00]]**"));
  assert.ok(updated.indexOf("|11:00]]**") < updated.indexOf("# Personal\n\nUntouched."));
});

test("daily headings, unclosed code fences, and project punctuation cannot break grouped entries", async (t) => {
  const { daily, entry } = await workspace(t);
  await mkdir(daily);
  const dailyPath = path.join(daily, `${entry.date}.md`);
  await writeFile(dailyPath, "# Log\n\nHandwritten.\n\n# Personal\n\nUntouched.\n");
  await appendDailyEntry(daily, "# Log", { ...entry, project: "a[b]|c\nd", summary: "# Goal\n\n```md\n## Example\nText." });
  await appendDailyEntry(daily, "# Log", { ...entry, sessionId: "two", time: "10:00" });
  const updated = await readFile(dailyPath, "utf8");
  assert.ok(updated.includes("## a&#91;b&#93;&#124;c d\n"));
  assert.ok(updated.includes("\\# Goal"));
  assert.ok(updated.includes("\\## Example"));
  assert.ok(!updated.includes("```"));
  assert.ok(updated.indexOf("|10:00]]**") < updated.indexOf("# Personal\n\nUntouched."));
});

test("inspection creates no snapshots and failed snapshot writes do not add broken links", async (t) => {
  const { daily, cache, entry } = await workspace(t);
  assert.equal((await inspectDailyEntry(daily, "# Log", entry)).appended, true);
  await assert.rejects(readdir(daily), { code: "ENOENT" });
  await assert.rejects(readdir(path.join(cache, "Entries")), { code: "ENOENT" });
  await assert.rejects(appendDailyEntry(daily, "# Log", { ...entry, sessionPath: path.join(cache, "Sessions", "missing.md") }), { code: "ENOENT" });
  await assert.rejects(readdir(daily), { code: "ENOENT" });
  await assert.rejects(readdir(path.join(cache, "Entries")), { code: "ENOENT" });
});

test("entry identity preserves summary-level and heading version behavior", async (t) => {
  const { daily, entry } = await workspace(t);
  const ids = new Set();
  for (const [heading, summaryLevel] of [["# Log", "small"], ["# Log", "medium"], ["## Log", "small"]]) {
    const version = { ...entry, summaryLevel };
    ids.add(dailyEntryId(version, heading));
    assert.equal((await appendDailyEntry(daily, heading, version)).appended, true);
    assert.equal((await inspectDailyEntry(daily, heading, version)).appended, false);
  }
  assert.equal(ids.size, 3);
});
