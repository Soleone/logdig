import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendDailyEntry, inspectDailyEntry } from "../src/journal.js";
import { writeSessions } from "../src/session-runner.js";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const daily = path.join(root, "daily");
  const sessionPath = path.join(root, "cache", "Sessions", "one.md");
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await mkdir(daily);
  await writeFile(sessionPath, "Full summary.\n");
  const date = "2026-09-28";
  const entry = { date, time: "11:00", project: "alpha", sessionId: "one", cacheFingerprint: "cache-one", summaryLevel: "small", summary: "Made progress.", sessionPath };
  return { daily, entry, dailyPath: path.join(daily, `${date}.md`) };
}

test("a singleton puts its timestamp inline and repeat saves leave the note unchanged", async (t) => {
  const { daily, entry, dailyPath } = await workspace(t);
  const summary = "First paragraph.\n\nSecond paragraph stays separate.";
  const version = { ...entry, summary };
  await appendDailyEntry(daily, "# Projects", version);
  const text = await readFile(dailyPath, "utf8");
  assert.match(text, /^# Projects\n\n## alpha\n\n\*\*\[\[[a-f0-9]{64}\|11:00\]\]\*\*: First paragraph\.\n\nSecond paragraph stays separate\.\n$/);
  assert.equal((await inspectDailyEntry(daily, "# Projects", version)).appended, false);
  assert.equal((await appendDailyEntry(daily, "# Projects", version)).appended, false);
  assert.equal(await readFile(dailyPath, "utf8"), text);
});

test("multiple entries keep timestamps inline without changing edited summaries or neighbors", async (t) => {
  for (const time of ["09:00", "12:00"]) {
    const { daily, entry, dailyPath } = await workspace(t);
    const personal = "# Log\n\nMy personal log.\n\n";
    const tasks = "# Tasks\n\nKeep my tasks.\n";
    await writeFile(dailyPath, `${personal}# Projects\n\n${tasks}`);
    await appendDailyEntry(daily, "# Projects", { ...entry, summary: "Original paragraph.\n\nSecond paragraph." });
    await appendDailyEntry(daily, "# Projects", { ...entry, sessionId: "beta", project: "beta", time: "15:00", summary: "Beta summary." });
    const first = await readFile(dailyPath, "utf8");
    const beta = first.slice(first.indexOf("## beta"));
    await writeFile(dailyPath, first.replace("Original paragraph.", "Human-edited paragraph."));
    await appendDailyEntry(daily, "# Projects", { ...entry, sessionId: "second", time, summary: "New alpha summary." });
    const updated = await readFile(dailyPath, "utf8");
    assert.ok(updated.startsWith(personal));
    assert.equal(updated.slice(updated.indexOf("## beta")), beta);
    const alpha = updated.slice(updated.indexOf("## alpha"), updated.indexOf("## beta"));
    assert.equal((alpha.match(/^\*\*\[\[[a-f0-9]{64}\|\d{2}:\d{2}\]\]\*\*: /gm) || []).length, 2);
    assert.ok(!/^\*\*\[\[.*\]\]\*\*\n\n/m.test(alpha));
    assert.ok(alpha.includes("|11:00]]**: Human-edited paragraph.\n\nSecond paragraph."));
    const times = [...alpha.matchAll(/\[\[[a-f0-9]{64}\|(\d{2}:\d{2})\]\]/g)].map((match) => match[1]);
    assert.deepEqual(times, ["11:00", time].sort());
    assert.equal((await inspectDailyEntry(daily, "# Projects", entry)).appended, false);
    assert.equal((await inspectDailyEntry(daily, "# Projects", { ...entry, sessionId: "second", time })).appended, false);
  }
});

test("try directories for the same project share a cleanly named group", async (t) => {
  const { daily, entry, dailyPath } = await workspace(t);
  const settings = { cacheDirectory: path.dirname(path.dirname(entry.sessionPath)), dailyDirectory: daily, dailyHeader: "# Projects", dailySummary: "small", timeZone: "UTC" };
  const sessions = ["2026-01-17-learn", "2026-09-27-learn"].map((directory, index) => ({
    header: { id: `try-${index}`, cwd: `/work/${directory}` },
    entries: [{ type: "message", timestamp: new Date(Date.UTC(2026, 8, 28, 9 + index)).toISOString(), message: { role: "user", content: "Made progress." } }],
  }));
  const model = { complete: async () => JSON.stringify({ small: "Made progress.", medium: "Details.", large: "Timeline." }) };
  const result = await writeSessions(model, sessions, settings);
  assert.deepEqual(result.errors, []);
  assert.equal(result.entriesAppended, 2);
  const text = await readFile(dailyPath, "utf8");
  assert.equal((text.match(/^## learn$/gm) || []).length, 1);
  assert.ok(!text.includes("## 2026-"));
  assert.ok(text.includes("|09:00]]**"));
  assert.ok(text.includes("|10:00]]**"));
  assert.equal((await writeSessions(model, sessions, settings)).entriesSkipped, 2);
});

test("interleaved projects form one group each and older backfills sort within their project", async (t) => {
  const { daily, entry, dailyPath } = await workspace(t);
  const personal = "# Log\n\n- 10:00 My personal log.\n\n";
  const tasks = "# Tasks\n\nKeep these tasks.\n";
  await writeFile(dailyPath, `${personal}# Projects\n\nProject introduction.\n\n${tasks}`);
  for (const [sessionId, project, time] of [["one", "alpha", "11:00"], ["two", "beta", "10:00"], ["three", "alpha", "09:00"], ["four", "alpha", "10:00"], ["five", "beta", "08:00"]]) {
    const version = { ...entry, sessionId, project, time, summary: `${project} at ${time}.` };
    assert.equal((await appendDailyEntry(daily, "# Projects", version)).appended, true);
    assert.equal((await inspectDailyEntry(daily, "# Projects", version)).appended, false);
  }
  const text = await readFile(dailyPath, "utf8");
  assert.ok(text.startsWith(personal + "# Projects\n\nProject introduction."));
  assert.ok(text.endsWith(tasks));
  assert.equal((text.match(/^## alpha$/gm) || []).length, 1);
  assert.equal((text.match(/^## beta$/gm) || []).length, 1);
  const alpha = text.slice(text.indexOf("## alpha"), text.indexOf("## beta"));
  assert.deepEqual([...alpha.matchAll(/\[\[[a-f0-9]{64}\|(\d{2}:\d{2})\]\]/g)].map((match) => match[1]), ["09:00", "10:00", "11:00"]);
  const beta = text.slice(text.indexOf("## beta"), text.indexOf("# Tasks"));
  assert.deepEqual([...beta.matchAll(/\[\[[a-f0-9]{64}\|(\d{2}:\d{2})\]\]/g)].map((match) => match[1]), ["08:00", "10:00"]);
  assert.ok(!text.includes("<!-- logdig:"));
});

test("entry and next project heading have exactly one blank line even after older excess spacing", async (t) => {
  const { daily, entry, dailyPath } = await workspace(t);
  await appendDailyEntry(daily, "# Projects", entry);
  const first = await readFile(dailyPath, "utf8");
  await writeFile(dailyPath, first + "\n\n\n");
  await appendDailyEntry(daily, "# Projects", { ...entry, sessionId: "two", project: "beta", time: "12:00" });
  const updated = await readFile(dailyPath, "utf8");
  assert.match(updated, /Made progress\.\n\n## beta\n\n\*\*\[\[[a-f0-9]{64}\|12:00\]\]\*\*: Made progress\./);
  assert.doesNotMatch(updated, /\n{3,}## beta/);
});

test("group discovery ignores frontmatter, code examples, and other sections", async (t) => {
  const { daily, entry, dailyPath } = await workspace(t);
  const prefix = "---\nexample: |\n# Projects\n## alpha\n---\n\n# Log\n\n```md\n# Projects\n## alpha\n```\n\n";
  const original = prefix + "# Projects\n\n```md\n## alpha\n```\n\n## beta\n\nHandwritten beta context.\n\n# Tasks\n\n## alpha\n\nTask context.\n";
  await writeFile(dailyPath, original);
  await appendDailyEntry(daily, "# Projects", entry);
  await appendDailyEntry(daily, "# Projects", { ...entry, sessionId: "two", time: "09:00" });
  await appendDailyEntry(daily, "# Projects", { ...entry, sessionId: "three", project: "beta", time: "10:00" });
  const text = await readFile(dailyPath, "utf8");
  assert.ok(text.startsWith(prefix));
  assert.ok(text.includes("## beta\n\nHandwritten beta context."));
  assert.ok(text.endsWith("# Tasks\n\n## alpha\n\nTask context.\n"));
  const projects = text.slice(prefix.length, text.indexOf("# Tasks"));
  assert.equal((projects.match(/^## alpha$/gm) || []).length, 2); // One code example, one actual group.
  assert.ok(projects.indexOf("|09:00]]**") < projects.indexOf("|11:00]]**"));
  assert.ok(projects.indexOf("|10:00]]**") < projects.lastIndexOf("## alpha"));
});

test("same-time entries stay stable and special project names reuse their group", async (t) => {
  const { daily, entry, dailyPath } = await workspace(t);
  for (const sessionId of ["one", "two", "three"]) {
    await appendDailyEntry(daily, "# Projects", { ...entry, sessionId, project: "a[b]|c", summary: sessionId });
  }
  const text = await readFile(dailyPath, "utf8");
  assert.equal((text.match(/^## a&#91;b&#93;&#124;c$/gm) || []).length, 1);
  assert.ok(text.indexOf("|11:00]]**: one") < text.indexOf("|11:00]]**: two"));
  assert.ok(text.indexOf("|11:00]]**: two") < text.indexOf("|11:00]]**: three"));
});

test("level-six custom sections use bold project labels without breaking Markdown headings", async (t) => {
  const { daily, entry, dailyPath } = await workspace(t);
  const heading = "###### Projects";
  for (const [sessionId, project, time] of [["one", "alpha", "11:00"], ["two", "beta", "10:00"], ["three", "alpha", "09:00"]]) {
    await appendDailyEntry(daily, heading, { ...entry, sessionId, project, time });
  }
  const text = await readFile(dailyPath, "utf8");
  assert.ok(text.startsWith(heading + "\n\n**Project: alpha**"));
  assert.equal((text.match(/^\*\*Project: alpha\*\*$/gm) || []).length, 1);
  assert.ok(text.indexOf("|09:00]]**") < text.indexOf("|11:00]]**"));
  assert.ok(text.indexOf("|11:00]]**") < text.indexOf("**Project: beta**"));
  assert.ok(!text.includes("#######"));
});
