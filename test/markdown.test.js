import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendDailyEntry, parseSessionNote, renderSessionNote } from "../src/journal.js";

async function dailyFolder(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-markdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const daily = path.join(root, "daily");
  await mkdir(daily);
  return daily;
}

const entry = {
  date: "2026-09-28", time: "09:00", project: "demo", sessionId: "one", cacheFingerprint: "cache-one", summaryLevel: "small", summary: "Made a useful change.",
};

test("daily insertion ignores headings in frontmatter and fenced code, including fenced headings in generated summaries", async (t) => {
  const daily = await dailyFolder(t);
  const filePath = path.join(daily, `${entry.date}.md`);
  const prefix = "---\nexample: |\n# Log\n---\n\n# My day\n\n```markdown\n# Log\n```\n\n~~~\n# Log\n~~~\n\n";
  const original = prefix + "# Log   \n\nMy own words.\n\n# Personal\n\nKeep this section.\n";
  await writeFile(filePath, original);
  await appendDailyEntry(daily, "# Log", { ...entry, summary: "A code example:\n\n```markdown\n# Personal\n```" });
  await appendDailyEntry(daily, "# Log", { ...entry, sessionId: "two", cacheFingerprint: "cache-two", time: "10:00" });
  const updated = await readFile(filePath, "utf8");
  assert.ok(updated.startsWith(prefix + "# Log   \n\nMy own words."));
  assert.ok(updated.includes("# Personal\n\nKeep this section."));
  assert.ok(updated.indexOf("**09:00 · demo**") > prefix.length);
  assert.ok(updated.indexOf("**10:00 · demo**") > updated.indexOf("**09:00 · demo**"));
  assert.ok(updated.indexOf("**10:00 · demo**") < updated.indexOf("# Personal\n\nKeep this section."));
});

test("a heading only present in a code example is not used as the insertion point", async (t) => {
  const daily = await dailyFolder(t);
  const filePath = path.join(daily, `${entry.date}.md`);
  const original = "# My day\n\nExample:\n\n```md\n# Log\n```\n\nHandwritten ending.\n";
  await writeFile(filePath, original);
  await appendDailyEntry(daily, "# Log", entry);
  const updated = await readFile(filePath, "utf8");
  assert.ok(updated.startsWith(original));
  assert.match(updated.slice(original.length), /^\n# Log\n\n<!-- logdig:/);
});

test("cached summary layers round-trip without treating nested or fenced headings as layer boundaries", () => {
  const summary = {
    small: "A brief summary.",
    medium: "## Small\nA small step.\n\n```markdown\n# Large\n```\n\nMore progress.",
    large: "A detailed account.\n\n# Small\nThis heading belongs to the account.",
  };
  const session = { header: { id: "markdown-session" }, date: "2026-09-28", time: "09:00", timezone: "UTC", project: "demo", sourceFingerprint: "source" };
  assert.deepEqual(parseSessionNote(renderSessionNote(session, summary, "cache", "test/fake")).summary, summary);
});
