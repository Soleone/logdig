import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendDailyEntry, saveSessionSummary } from "../src/journal.js";

const layers = {
  small: "Worked on the journal prototype and verified the parser.",
  medium: "- **Goal:** Build the journal.\n- **Progress:** Parser works.\n- **Status:** In progress.",
  large: "2026-09-27 09:00 Reviewed session history.\n\n2026-09-27 09:30 Implemented and tested the journal parser.",
};

function modelContext() {
  let calls = 0;
  return {
    modelClient: {
      modelLabel: "test/fake",
      complete: async () => {
        calls++;
        return JSON.stringify(layers);
      },
    },
    calls: () => calls,
  };
}

function session(id, project, time, sourceFingerprint) {
  return {
    header: { id, cwd: `/work/${project}` },
    project,
    date: "2026-09-27",
    time,
    timezone: "America/New_York",
    sourceFingerprint,
    events: [{
      date: "2026-09-27",
      time,
      project,
      sessionId: id,
      kind: "user intent",
      text: "Build a journal",
    }],
  };
}

test("default model caches remain compatible while explicit model choices get separate summaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-model-cache-"));
  const { modelClient, calls } = modelContext();
  const first = session("session-model", "alpha", "09:00", "same-source");
  try {
    const initial = await saveSessionSummary({ ...modelClient, cacheKey: "Pi default" }, root, first);
    assert.equal(initial.reused, false);
    const selected = { ...modelClient, modelLabel: "test/other", cacheKey: "test/other" };
    const switched = await saveSessionSummary(selected, root, first);
    assert.equal(switched.reused, false);
    const repeated = await saveSessionSummary(selected, root, first);
    assert.equal(repeated.reused, true);
    assert.equal(calls(), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session summaries are cached once and appended without replacing journal content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-test-"));
  const cacheDirectory = path.join(root, "LogDig");
  const dailyDirectory = path.join(root, "Existing Journals");
  await mkdir(dailyDirectory, { recursive: true });
  const dailyPath = path.join(dailyDirectory, "2026-09-27.md");
  const original = "# 2026-09-27\n\nOriginal journal intro.\n\n# Log\n\nHandwritten note stays here.\n\n# Other\n\nDo not move this section.\n";
  await writeFile(dailyPath, original, "utf8");
  const { modelClient, calls } = modelContext();

  try {
    const first = session("session-one", "alpha", "09:00", "first-source");
    const firstCache = await saveSessionSummary(modelClient, cacheDirectory, first);
    assert.equal(firstCache.reused, false);
    assert.equal(calls(), 1);
    assert.match(firstCache.sessionPath, /LogDig\/Sessions\/session-one\.md$/);

    const firstEntry = await appendDailyEntry(dailyDirectory, "# Log", {
      date: first.date,
      time: first.time,
      project: first.project,
      sessionId: first.header.id,
      cacheFingerprint: firstCache.cacheFingerprint,
      sessionPath: firstCache.sessionPath,
      summaryLevel: "small",
      summary: firstCache.summary.small,
    });
    assert.equal(firstEntry.appended, true);

    const repeatedCache = await saveSessionSummary(modelClient, cacheDirectory, first);
    assert.equal(repeatedCache.reused, true);
    assert.equal(calls(), 1);
    const repeatedEntry = await appendDailyEntry(dailyDirectory, "# Log", {
      date: first.date,
      time: first.time,
      project: first.project,
      sessionId: first.header.id,
      cacheFingerprint: repeatedCache.cacheFingerprint,
      sessionPath: repeatedCache.sessionPath,
      summaryLevel: "small",
      summary: repeatedCache.summary.small,
    });
    assert.equal(repeatedEntry.appended, false);

    const second = session("session-two", "beta", "10:15", "second-source");
    const secondCache = await saveSessionSummary(modelClient, cacheDirectory, second);
    assert.equal(secondCache.reused, false);
    assert.equal(calls(), 2);
    await appendDailyEntry(dailyDirectory, "# Log", {
      date: second.date,
      time: second.time,
      project: second.project,
      sessionId: second.header.id,
      cacheFingerprint: secondCache.cacheFingerprint,
      sessionPath: secondCache.sessionPath,
      summaryLevel: "medium",
      summary: secondCache.summary.medium,
    });

    const daily = await readFile(dailyPath, "utf8");
    assert.ok(daily.startsWith(original.slice(0, original.indexOf("# Other"))));
    assert.ok(daily.includes("Original journal intro."));
    assert.ok(daily.includes("Handwritten note stays here."));
    assert.ok(daily.includes("# Other\n\nDo not move this section."));
    assert.ok(daily.indexOf("|09:00]]**") < daily.indexOf("|10:15]]**"));
    assert.ok(daily.includes("## alpha\n"));
    assert.ok(daily.includes("## beta\n"));
    assert.ok(daily.includes(layers.small));
    assert.ok(daily.includes("**Goal:** Build the journal."));
    assert.equal((daily.match(/\[\[[a-f0-9]{64}\|/g) || []).length, 2);
    assert.ok(!daily.includes("<!-- logdig:"));
    assert.equal(await readFile(firstEntry.entryPath, "utf8"), await readFile(firstCache.sessionPath, "utf8"));

    const newDay = await appendDailyEntry(dailyDirectory, "# Pi Log", {
      date: "2026-09-28",
      time: "08:30",
      project: "gamma",
      sessionId: "session-three",
      cacheFingerprint: "third-cache",
      sessionPath: firstCache.sessionPath,
      summaryLevel: "small",
      summary: "A new day entry.",
    });
    const newDayNote = await readFile(path.join(dailyDirectory, "2026-09-28.md"), "utf8");
    assert.equal(newDay.appended, true);
    assert.ok(newDayNote.startsWith("# Pi Log\n\n"));
    assert.match(newDayNote, /## gamma\n\n\*\*\[\[[a-f0-9]{64}\|08:30\]\]\*\*/);
    assert.equal(await readFile(path.join(cacheDirectory, "Sessions", "session-one.md"), "utf8").then((text) => text.includes("# Large")), true);

    const customHeader = "## Log";
    const customDailyPath = path.join(dailyDirectory, "2026-09-29.md");
    await writeFile(customDailyPath, "# 2026-09-29\n\n## Log\n\nManual section.\n\n## More\n\nKeep this too.\n", "utf8");
    for (const [sessionId, time, summaryLevel, text] of [
      ["delta", "08:00", "medium", "## Goal\nKeep this heading inside the generated entry."],
      ["epsilon", "09:00", "small", layers.small],
    ]) {
      await appendDailyEntry(dailyDirectory, customHeader, {
        date: "2026-09-29",
        time,
        project: sessionId,
        sessionId,
        cacheFingerprint: `cache-${sessionId}`,
        sessionPath: firstCache.sessionPath,
        summaryLevel,
        summary: text,
      });
    }
    const customDaily = await readFile(customDailyPath, "utf8");
    assert.ok(customDaily.indexOf("|08:00]]**") < customDaily.indexOf("|09:00]]**"));
    assert.ok(customDaily.includes("### delta\n"));
    assert.ok(customDaily.includes("### epsilon\n"));
    assert.ok(customDaily.includes("## Goal"));
    assert.ok(customDaily.includes("Manual section."));
    assert.ok(customDaily.includes("## More\n\nKeep this too."));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
