import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendDailyEntry, dailyEntryId, inspectSessionSummary, parseSessionNote, renderSessionNote, saveSessionSummary, summaryCachePolicy } from "../src/journal.js";
import { writeSessions } from "../src/session-runner.js";
import { workBlocksForSession } from "../src/work-blocks.js";

function message(id, timestamp, role = "user", content = id) {
  return { type: "message", id, timestamp, message: { role, content, stopReason: "stop" } };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-blocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), dailyHeader: "# Projects", dailySummary: "small", timeZone: "UTC" };
  const session = { header: { type: "session", id: "multi-day", cwd: "/work/demo", timestamp: "2026-09-30T21:59:00Z" }, entries: [message("start", "2026-09-30T22:00:00Z", "user", "Investigate cache behavior."), message("outcome", "2026-10-01T02:00:00Z", "assistant", "Identified the issue.")] };
  const prompts = [];
  const model = { cachePolicy: { model: "test/fake" }, complete: async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ small: `Summary ${prompts.length}.`, medium: `Details ${prompts.length}.`, large: `Timeline ${prompts.length}.` });
  } };
  return { root, settings, session, model, prompts, dailyPath: (date) => path.join(settings.dailyDirectory, `${date}.md`) };
}

function entryId(markdown) {
  return markdown.match(/\*\*\[\[([a-f0-9]{64})\|\d{2}:\d{2}\]\]\*\*/)[1];
}

test("project-only relabeling reuses summaries, preserves link IDs, and moves daily entries", async (t) => {
  const f = await fixture(t);
  f.session.header.cwd = path.join(f.root, ".herdr", "worktrees", "tasks", "two");
  const [currentBlock] = workBlocksForSession(f.session, f.settings.timeZone);
  assert.equal(currentBlock.project, "tasks");
  const legacyBlock = {
    ...currentBlock,
    project: "two",
    events: currentBlock.events.map((event) => ({ ...event, project: "two" })),
    context: currentBlock.context.map((event) => ({ ...event, project: "two" })),
  };
  const cached = await saveSessionSummary(f.model, f.settings.cacheDirectory, legacyBlock);
  assert.equal(cached.reused, false);
  const oldEntry = {
    date: legacyBlock.date,
    time: legacyBlock.time,
    project: "two",
    sessionId: legacyBlock.header.id,
    blockId: legacyBlock.blockId,
    blockStart: legacyBlock.blockStart,
    cacheFingerprint: cached.cacheFingerprint,
    sessionPath: cached.sessionPath,
    sourceFingerprint: cached.sourceFingerprint,
    metrics: {},
    summaryLevel: f.settings.dailySummary,
    summary: cached.summary.small,
  };
  const first = await appendDailyEntry(f.settings.dailyDirectory, f.settings.dailyHeader, oldEntry);
  const originalId = dailyEntryId(oldEntry, f.settings.dailyHeader);
  assert.match(await readFile(first.dailyPath, "utf8"), /^## two$/m);

  const migrated = await writeSessions(f.model, [f.session], f.settings);
  assert.deepEqual(migrated.errors, []);
  assert.equal(migrated.summariesCreated, 0);
  assert.equal(migrated.summariesReused, 1);
  assert.equal(migrated.entriesUpdated, 1);
  assert.equal(f.prompts.length, 1);

  const daily = await readFile(first.dailyPath, "utf8");
  assert.match(daily, /^## tasks$/m);
  assert.doesNotMatch(daily, /^## two$/m);
  assert.equal(entryId(daily), originalId);
  assert.match(daily, /Summary 1\./);
  const snapshot = parseSessionNote(await readFile(path.join(f.settings.cacheDirectory, "Entries", `${originalId}.md`), "utf8"));
  assert.equal(snapshot.project, "tasks");

  const repeated = await writeSessions(f.model, [f.session], f.settings);
  assert.deepEqual(repeated.errors, []);
  assert.equal(repeated.entriesSkipped, 1);
  assert.equal(repeated.summariesReused, 1);
  assert.equal(f.prompts.length, 1);
  assert.equal(await readFile(first.dailyPath, "utf8"), daily);
});

test("continuation creates a separate daily entry, preserves earlier notes, and links the original snapshot", async (t) => {
  const f = await fixture(t);
  const first = await writeSessions(f.model, [f.session], f.settings);
  assert.deepEqual(first.errors, []);
  const earlierDaily = await readFile(f.dailyPath("2026-09-30"), "utf8");
  const earlierId = entryId(earlierDaily);
  const earlierSnapshot = await readFile(path.join(f.settings.cacheDirectory, "Entries", `${earlierId}.md`), "utf8");
  f.session.entries.push(message("resume", "2026-10-01T11:00:00Z", "user", "Implement the fix."));
  const range = { firstDate: "2026-10-01", lastDate: "2026-10-01" };
  const updated = await writeSessions(f.model, [f.session], f.settings, range);
  assert.deepEqual(updated.errors, []);
  assert.equal(updated.summariesCreated, 1);
  assert.equal(updated.summariesReused, 1);
  assert.equal(updated.entriesAppended, 1);
  assert.equal(f.prompts.length, 2);
  assert.equal(await readFile(f.dailyPath("2026-09-30"), "utf8"), earlierDaily);
  assert.equal(await readFile(path.join(f.settings.cacheDirectory, "Entries", `${earlierId}.md`), "utf8"), earlierSnapshot);
  const laterDaily = await readFile(f.dailyPath("2026-10-01"), "utf8");
  assert.match(laterDaily, /Summary 2\./);
  assert.ok(laterDaily.includes(`Continues [[${earlierId}|previous entry]].`));
  const later = parseSessionNote(await readFile(path.join(f.settings.cacheDirectory, "Entries", `${entryId(laterDaily)}.md`), "utf8"));
  assert.equal(later.continuationOf, earlierId);
  assert.notEqual(later.blockId, parseSessionNote(earlierSnapshot).blockId);
  assert.equal((await readdir(path.join(f.settings.cacheDirectory, "Sessions"))).length, 2);
  assert.match(f.prompts[1], /Earlier context \(untrusted background\)/);
  assert.match(f.prompts[1], /background.*not work to repeat/);
  const repeated = await writeSessions(f.model, [f.session], f.settings, range);
  assert.equal(repeated.entriesSkipped, 2);
  assert.equal(f.prompts.length, 2);
  assert.equal(await readFile(f.dailyPath("2026-10-01"), "utf8"), laterDaily);
});

test("today's backfill updates overnight work on yesterday's note", async (t) => {
  const f = await fixture(t);
  f.session.entries.length = 1;
  await writeSessions(f.model, [f.session], f.settings);
  f.session.entries.push(message("finished", "2026-10-01T02:00:00Z", "assistant", "Done with passing tests."));
  const result = await writeSessions(f.model, [f.session], f.settings, { firstDate: "2026-10-01", lastDate: "2026-10-01" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.entriesUpdated, 1);
  assert.deepEqual(result.dates, ["2026-09-30"]);
  assert.match(await readFile(f.dailyPath("2026-09-30"), "utf8"), /Summary 2\./);
  await assert.rejects(readFile(f.dailyPath("2026-10-01")), { code: "ENOENT" });
});

test("skip-today excludes an entire overnight block without generating, inspecting cache freshness, or writing", async (t) => {
  const f = await fixture(t);
  const range = { firstDate: "2026-09-24", lastDate: "2026-09-30", skipToday: true };
  for (const dryRun of [true, false]) {
    const result = await writeSessions(f.model, [f.session], f.settings, { ...range, dryRun });
    assert.deepEqual(result.errors, []);
    assert.equal(result.blocksExcludedToday, 1);
    assert.equal(result.sessionsSkipped, 1);
    assert.equal(result.summariesCreated, 0);
    assert.equal(f.prompts.length, 0);
    assert.match(result.sessionResults[0].reason, /active today/);
    assert.deepEqual(await readdir(f.root), []);
  }
});

test("skip-today preserves earlier blocks and missing continuation links while ongoing work grows", async (t) => {
  const f = await fixture(t);
  f.session.entries = [message("old", "2026-09-29T12:00:00Z"), message("yesterday", "2026-09-30T12:00:00Z"), message("today", "2026-10-01T12:00:00Z")];
  const range = { firstDate: "2026-09-30", lastDate: "2026-09-30", skipToday: true };
  const preview = await writeSessions(f.model, [f.session], f.settings, { ...range, dryRun: true });
  assert.equal(preview.blocksExcludedToday, 1);
  assert.deepEqual(preview.sessionResults.map((block) => [block.date, block.prerequisite]), [["2026-09-29", true], ["2026-09-30", false]]);
  assert.deepEqual(await readdir(f.root), []);
  const saved = await writeSessions(f.model, [f.session], f.settings, range);
  assert.deepEqual(saved.errors, []);
  assert.equal(f.prompts.length, 2);
  assert.equal(saved.blocksExcludedToday, 1);
  assert.ok(f.prompts.every((prompt) => !prompt.includes('"text":"today"')));
  const snapshot = parseSessionNote(await readFile(path.join(f.settings.cacheDirectory, "Entries", `${saved.sessionResults[1].continuationOf}.md`), "utf8"));
  assert.equal(snapshot.blockId, saved.sessionResults[0].blockId);
  const before = await readFile(f.dailyPath("2026-09-30"), "utf8");
  f.session.entries.push(message("ongoing", "2026-10-01T12:01:00Z"));
  const widened = await writeSessions(f.model, [f.session], f.settings, { ...range, firstDate: "2026-09-17" });
  assert.deepEqual(widened.errors, []);
  assert.equal(widened.summariesReused, 2);
  assert.equal(f.prompts.length, 2);
  assert.equal(await readFile(f.dailyPath("2026-09-30"), "utf8"), before);
  await assert.rejects(readFile(f.dailyPath("2026-10-01")), { code: "ENOENT" });
  assert.equal((await readdir(path.join(f.settings.cacheDirectory, "Sessions"))).length, 2);
});

test("skip-today leaves an existing overnight summary and daily note untouched", async (t) => {
  const f = await fixture(t);
  await writeSessions(f.model, [f.session], f.settings);
  const daily = await readFile(f.dailyPath("2026-09-30"), "utf8");
  const cachePath = path.join(f.settings.cacheDirectory, "Sessions", "multi-day.md");
  const cache = await readFile(cachePath, "utf8");
  f.session.entries.push(message("ongoing", "2026-10-01T02:01:00Z", "assistant"));
  const result = await writeSessions(f.model, [f.session], f.settings, { lastDate: "2026-09-30", skipToday: true });
  assert.equal(result.blocksExcludedToday, 1);
  assert.equal(f.prompts.length, 1);
  assert.equal(await readFile(cachePath, "utf8"), cache);
  assert.equal(await readFile(f.dailyPath("2026-09-30"), "utf8"), daily);
});

test("later work does not invalidate closed earlier blocks outside the requested activity range", async (t) => {
  const f = await fixture(t);
  f.session.entries = [message("start", "2026-09-30T22:00:00Z"), message("done", "2026-09-30T23:00:00Z", "assistant")];
  await writeSessions(f.model, [f.session], f.settings);
  f.session.entries.push(message("resume", "2026-10-01T11:00:00Z"));
  const result = await writeSessions(f.model, [f.session], f.settings, { firstDate: "2026-10-01", lastDate: "2026-10-01" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.sessionResults.length, 1);
  assert.equal(result.summariesCreated, 1);
  assert.equal(result.summariesReused, 0);
  assert.equal(f.prompts.length, 2);
  const repeated = await writeSessions(f.model, [f.session], f.settings, { firstDate: "2026-10-01", lastDate: "2026-10-01" });
  assert.equal(repeated.entriesSkipped, 1);
  assert.equal(f.prompts.length, 2);
});

test("unlogged predecessor blocks are explicit prerequisites, and dry-run predictions do not write anything", async (t) => {
  const f = await fixture(t);
  f.session.entries = [message("start", "2026-09-29T22:00:00Z"), message("next", "2026-09-30T11:00:00Z"), message("resume", "2026-10-01T11:00:00Z")];
  const range = { firstDate: "2026-10-01", lastDate: "2026-10-01" };
  const preview = await writeSessions(f.model, [f.session], f.settings, { ...range, dryRun: true });
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.summariesCreated, 3);
  assert.deepEqual(preview.sessionResults.map((block) => block.prerequisite), [true, true, false]);
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(await readdir(f.root), []);
  const saved = await writeSessions(f.model, [f.session], f.settings, range);
  assert.deepEqual(saved.errors, []);
  assert.equal(saved.summariesCreated, 3);
  assert.deepEqual(saved.sessionResults.map((block) => block.continuationOf), preview.sessionResults.map((block) => block.continuationOf));
  for (const block of saved.sessionResults.slice(1)) {
    await readFile(path.join(f.settings.cacheDirectory, "Entries", `${block.continuationOf}.md`));
  }
});

test("renames, model switches, labels, system prompts, and extension state do not regenerate summaries", async (t) => {
  const f = await fixture(t);
  await writeSessions(f.model, [f.session], f.settings);
  const before = await readFile(f.dailyPath("2026-09-30"), "utf8");
  for (const entry of [
    { type: "session_info", name: "New name" },
    { type: "model_change", provider: "other", modelId: "model" },
    { type: "thinking_level_change", thinkingLevel: "high" },
    { type: "label", label: "checkpoint" },
    { type: "custom", customType: "state", data: { counter: 1 } },
    { type: "message", message: { role: "system", content: "Updated tools" } },
  ]) {
    f.session.entries.push({ ...entry, timestamp: "2026-10-01T08:00:00Z" });
    const result = await writeSessions(f.model, [f.session], f.settings);
    assert.deepEqual(result.errors, []);
    assert.equal(result.summariesReused, 1);
    assert.equal(result.entriesSkipped, 1);
  }
  assert.equal(f.prompts.length, 1);
  assert.equal(await readFile(f.dailyPath("2026-09-30"), "utf8"), before);
  const metadataOnly = await writeSessions(f.model, [f.session], f.settings, { dryRun: true, firstDate: "2026-10-02", lastDate: "2026-10-02" });
  assert.equal(metadataOnly.sessionsSkipped, 1);
});

test("usage totals refresh without model requests or daily blurb edits", async (t) => {
  const f = await fixture(t);
  await writeSessions(f.model, [f.session], f.settings);
  const before = await readFile(f.dailyPath("2026-09-30"), "utf8");
  f.session.entries.push({ type: "usage", timestamp: "2026-10-01T02:01:00Z", usage: { input: 20, output: 10, cacheRead: 100, cost: { total: 0.25 } } });
  const updated = await writeSessions(f.model, [f.session], f.settings);
  assert.deepEqual(updated.errors, []);
  assert.equal(updated.summariesReused, 1);
  assert.equal(updated.entriesSkipped, 1);
  assert.equal(f.prompts.length, 1);
  assert.equal(await readFile(f.dailyPath("2026-09-30"), "utf8"), before);
  for (const file of [path.join(f.settings.cacheDirectory, "Sessions", "multi-day.md"), path.join(f.settings.cacheDirectory, "Entries", `${entryId(before)}.md`)]) {
    assert.match(parseSessionNote(await readFile(file, "utf8")).sessionUsage, /^\$0\.25 ⚡100 ↑20 ↓10/);
  }
});

test("model policy is order-independent and thinking levels invalidate only summary freshness", async (t) => {
  const f = await fixture(t);
  await writeSessions(f.model, [f.session], f.settings);
  const block = workBlocksForSession(f.session, f.settings.timeZone)[0];
  const initial = await inspectSessionSummary(f.model, f.settings.cacheDirectory, block);
  assert.deepEqual(summaryCachePolicy({}), { model: "Pi default" });
  const withEffort = { ...f.model, cachePolicy: summaryCachePolicy({ model: "test/fake", thinkingLevel: "high" }) };
  const effort = await inspectSessionSummary(withEffort, f.settings.cacheDirectory, block);
  const reordered = await inspectSessionSummary({ ...f.model, cachePolicy: { thinkingLevel: "high", model: "test/fake" } }, f.settings.cacheDirectory, block);
  assert.notEqual(initial.cacheFingerprint, effort.cacheFingerprint);
  assert.equal(effort.cacheFingerprint, reordered.cacheFingerprint);
  assert.equal(initial.sourceFingerprint, effort.sourceFingerprint);
  const updated = await writeSessions(withEffort, [f.session], f.settings);
  assert.equal(updated.summariesCreated, 1);
  assert.equal(updated.entriesUpdated, 1);
  assert.equal(updated.sessionResults[0].blockId, block.blockId);
  assert.equal((await writeSessions(withEffort, [f.session], f.settings)).summariesReused, 1);
  const max = { ...f.model, cachePolicy: summaryCachePolicy({ model: "test/fake", thinkingLevel: "max" }) };
  const changed = await inspectSessionSummary(max, f.settings.cacheDirectory, block);
  assert.equal(changed.reused, false);
  assert.equal(changed.sourceFingerprint, initial.sourceFingerprint);
});

test("continuation updates preserve edited blurbs without duplicating generated continuation links", async (t) => {
  const f = await fixture(t);
  f.session.entries.push(message("resume", "2026-10-01T11:00:00Z"));
  await writeSessions(f.model, [f.session], f.settings);
  const earlier = await readFile(f.dailyPath("2026-09-30"), "utf8");
  const later = await readFile(f.dailyPath("2026-10-01"), "utf8");
  await writeFile(f.dailyPath("2026-10-01"), later.replace("Summary 2.", "My edited continuation."));
  f.session.entries.push(message("more", "2026-10-01T12:00:00Z"));
  const result = await writeSessions(f.model, [f.session], f.settings);
  assert.deepEqual(result.errors, []);
  assert.equal(result.entriesUpdated, 1);
  const updated = await readFile(f.dailyPath("2026-10-01"), "utf8");
  assert.match(updated, /My edited continuation\./);
  assert.equal((updated.match(/Continues \[\[/g) || []).length, 1);
  assert.equal(await readFile(f.dailyPath("2026-09-30"), "utf8"), earlier);
});

test("legacy overnight rows migrate to the starting day, preserving snapshots and manual writing", async (t) => {
  const f = await fixture(t);
  const legacySummary = { small: "Old whole-session summary.", medium: "Old details.", large: "Old timeline." };
  const legacyPath = path.join(f.settings.cacheDirectory, "Sessions", "multi-day.md");
  await mkdir(path.dirname(legacyPath), { recursive: true });
  const legacy = renderSessionNote({ ...f.session, date: "2026-10-01", time: "02:00", timezone: "UTC", project: "demo", sourceFingerprint: "old-raw-hash" }, legacySummary, "old-cache", "test/fake")
    .replace('summaryVersion: "work-block-layers-v2"', 'summaryVersion: "session-layers-v2"');
  await writeFile(legacyPath, legacy);
  const old = await appendDailyEntry(f.settings.dailyDirectory, f.settings.dailyHeader, {
    date: "2026-10-01", time: "02:00", sessionId: f.session.header.id, project: "demo", cacheFingerprint: "old-cache", summaryLevel: "small", summary: legacySummary.small, sessionPath: legacyPath,
  });
  const original = await readFile(old.entryPath, "utf8");
  const oldDaily = await readFile(f.dailyPath("2026-10-01"), "utf8");
  await writeFile(f.dailyPath("2026-10-01"), `# Personal\n\nKeep my writing.\n\n${oldDaily.replace(legacySummary.small, "Hand-edited legacy blurb.")}`);
  const preview = await writeSessions(f.model, [f.session], f.settings, { dryRun: true });
  assert.equal(preview.entriesUpdated, 1);
  assert.equal(f.prompts.length, 0);
  const migrated = await writeSessions(f.model, [f.session], f.settings);
  assert.deepEqual(migrated.errors, []);
  assert.equal(migrated.entriesUpdated, 1);
  assert.match(await readFile(f.dailyPath("2026-09-30"), "utf8"), /Hand-edited legacy blurb\./);
  const cleaned = await readFile(f.dailyPath("2026-10-01"), "utf8");
  assert.match(cleaned, /Keep my writing\./);
  assert.doesNotMatch(cleaned, /\*\*\[\[/);
  assert.equal(await readFile(old.entryPath, "utf8"), original);
  assert.equal((await writeSessions(f.model, [f.session], f.settings)).entriesSkipped, 1);
  assert.equal(f.prompts.length, 1);
  f.session.entries.push(message("more", "2026-10-01T03:00:00Z"));
  const evolved = await writeSessions(f.model, [f.session], f.settings, { dryRun: true });
  assert.equal(evolved.entriesUpdated, 1);
  assert.equal(evolved.sessionResults[0].legacyEntry, false);
});

test("a missing snapshot is repaired from cache before a continuation can link to it", async (t) => {
  const f = await fixture(t);
  await writeSessions(f.model, [f.session], f.settings);
  const original = await readFile(f.dailyPath("2026-09-30"), "utf8");
  const id = entryId(original);
  const snapshot = path.join(f.settings.cacheDirectory, "Entries", `${id}.md`);
  await rm(snapshot);
  f.session.entries.push(message("resume", "2026-10-01T11:00:00Z"));
  const result = await writeSessions(f.model, [f.session], f.settings);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summariesReused, 1);
  assert.equal(f.prompts.length, 2);
  await readFile(snapshot);
  assert.equal(result.sessionResults[1].continuationOf, id);
});

test("timezone changes that merge blocks remove obsolete rows without deleting their snapshots", async (t) => {
  const f = await fixture(t);
  f.session.entries = [message("start", "2026-10-01T22:00:00Z"), message("resume", "2026-10-02T02:00:00Z")];
  const original = await writeSessions(f.model, [f.session], f.settings);
  assert.deepEqual(original.errors, []);
  assert.equal(original.entriesAppended, 2);
  const later = await readFile(f.dailyPath("2026-10-02"), "utf8");
  const snapshotPath = path.join(f.settings.cacheDirectory, "Entries", `${entryId(later)}.md`);
  const snapshot = await readFile(snapshotPath, "utf8");
  const changed = await writeSessions(f.model, [f.session], { ...f.settings, timeZone: "America/Toronto" });
  assert.deepEqual(changed.errors, []);
  assert.equal(changed.entriesUpdated, 1);
  assert.equal(changed.sessionResults.length, 1);
  assert.doesNotMatch(await readFile(f.dailyPath("2026-10-02"), "utf8"), /\*\*\[\[/);
  assert.equal(await readFile(snapshotPath, "utf8"), snapshot);
  const repeated = await writeSessions(f.model, [f.session], { ...f.settings, timeZone: "America/Toronto" });
  assert.equal(repeated.entriesSkipped, 1);
  assert.equal(f.prompts.length, 3);
});

test("failed predecessor generation blocks broken continuation links and retry continues safely", async (t) => {
  const f = await fixture(t);
  f.session.entries.push(message("resume", "2026-10-01T11:00:00Z"));
  const failure = await writeSessions({ ...f.model, complete: async () => { throw new Error("quota exceeded"); } }, [f.session], f.settings);
  assert.equal(failure.errors.length, 2);
  assert.match(failure.errors[1], /preceding work block has no saved snapshot/);
  await assert.rejects(readdir(f.settings.dailyDirectory), { code: "ENOENT" });
  const retry = await writeSessions(f.model, [f.session], f.settings);
  assert.deepEqual(retry.errors, []);
  assert.equal(retry.entriesAppended, 2);
});
