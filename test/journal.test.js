import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { enrichSessionNote, formatUsage, inspectSessionSummary, JOURNAL_SYSTEM_PROMPT, parseSessionNote, renderSessionNote, saveSessionSummary, summarizeSession } from "../src/journal.js";

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
  assert.equal(parsed.model, "test/fake");
  assert.equal(parsed.sourceFingerprint, "source-123");
  assert.equal(parsed.cacheFingerprint, "cache-123");
  assert.equal(parsed.summaryVersion, "work-block-layers-v3");
  assert.deepEqual(parsed.summary, summary);
  assert.match(markdown, /^# Small/m);
  assert.match(markdown, /^# Medium/m);
  assert.match(markdown, /^# Large/m);
});

test("session and LogDig usage render as separate compact frontmatter strings", () => {
  const withUsage = {
    ...session,
    header: { ...session.header, timestamp: "2026-09-27T12:00:00Z" },
    entries: [{ type: "message", timestamp: "2026-09-27T12:01:25Z", message: { role: "assistant", usage: {
      input: 164000, output: 33000, cacheRead: 4800000, cacheWrite: 1000, cost: { total: 1.13 },
    } } }],
  };
  const logMetrics = { costUsd: 0.023, cacheReadTokens: 3000, inputTokens: 1200, outputTokens: 200, durationSeconds: 11 };
  const markdown = renderSessionNote(withUsage, summary, "cache-123", "test/fake", logMetrics);
  const note = parseSessionNote(markdown);
  assert.equal(note.sessionUsage, "$1.13 ⚡4.8M ↑164k ↓33k · 1m 25s");
  assert.equal(note.logUsage, "$0.02 ⚡3k ↑1.2k ↓200 · 11s");
  assert.equal(note.costUsd, undefined);
  assert.deepEqual(note.summary, summary);
  assert.equal(formatUsage({ costUsd: 3.73, cacheReadTokens: 12200000, inputTokens: 747000, outputTokens: 62000 }), "$3.73 ⚡12.2M ↑747k ↓62k");
  assert.equal(formatUsage({ costUsd: 0.0001, durationSeconds: 2 }), "$0.0001 · 2s");
  const oldNote = renderSessionNote(session, summary, "cache-123", "test/fake")
    .replace("model: \"test/fake\"", "model: \"test/fake\"\ncostUsd: 1.13\ncacheReadTokens: 4800000\ninputTokens: 164000\noutputTokens: 33000\ndurationSeconds: 85");
  const enriched = enrichSessionNote(oldNote, session.sourceFingerprint, {});
  assert.equal(parseSessionNote(enriched).sessionUsage, "$1.13 ⚡4.8M ↑164k ↓33k · 1m 25s");
  assert.equal(parseSessionNote(enriched).costUsd, undefined);
  assert.deepEqual(parseSessionNote(enriched).summary, summary);
  assert.equal(enrichSessionNote(enriched, session.sourceFingerprint, {}), enriched);
  assert.equal(enrichSessionNote(oldNote, "different source", {}), oldNote);
});

test("generated frontmatter appends an explicit thinking level to the model label", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-thinking-frontmatter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelClient = {
    modelLabel: "test/fake",
    cachePolicy: { model: "test/fake", thinkingLevel: "high" },
    complete: async () => JSON.stringify(summary),
  };

  const result = await saveSessionSummary(modelClient, root, session);
  const note = parseSessionNote(await readFile(result.sessionPath, "utf8"));
  assert.equal(note.model, "test/fake:high");
});

test("large session evidence is summarized in bounded chunks before final layers", async (t) => {
  let calls = 0;
  const modelClient = {
    modelLabel: "test/fake",
    complete: async (prompt) => {
      calls++;
      const result = prompt.includes("Extract a compact factual timeline")
        ? { timeline: "- [2026-09-27 09:00] Reviewed work and recorded the result." }
        : summary;
      return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(result) }], usage: {
        input: 100, output: 20, cacheRead: 400, cacheWrite: 0, cost: { total: 0.01 },
      } };
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

  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-chunk-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await saveSessionSummary(modelClient, root, longSession);
  assert.deepEqual(result.summary, summary);
  assert.ok(calls > 2, `expected chunk calls plus a final call, got ${calls}`);
  const note = parseSessionNote(await readFile(result.sessionPath, "utf8"));
  assert.ok(note.logUsage.startsWith(`${formatUsage({ costUsd: calls * 0.01, cacheReadTokens: 400 * calls, inputTokens: 100 * calls, outputTokens: 20 * calls })} · `));
  await saveSessionSummary(modelClient, root, longSession);
  assert.ok(calls > 2);
  assert.equal(parseSessionNote(await readFile(result.sessionPath, "utf8")).logUsage, note.logUsage);
});

test("final prompt requests a first-person diary and current-block dates without importing background dates", async () => {
  let prompt;
  await summarizeSession({ complete: async (value) => { prompt = value; return JSON.stringify(summary); } }, {
    ...session,
    context: [{ date: "2026-09-25", text: "Earlier implementation and checks." }],
    events: [{ date: "2026-09-27", time: "10:25", project: "demo", sessionId: "01-session", kind: "assistant outcome", text: "Checks reported passing." }],
  });
  assert.match(prompt, /all three layers as the user's personal diary: use 'I', never 'the user'/);
  assert.match(prompt, /use 'we' only when it clarifies collaboration with the agent/);
  assert.match(prompt, /Known local work-block dates: 2026-09-27\./);
  assert.doesNotMatch(prompt, /Known local work-block dates:.*2026-09-25/);
  assert.match(prompt, /completed commits versus edits still awaiting commit/);
  assert.match(prompt, /running tests is not editing test files/);
  assert.match(prompt, /briefly attribute it as reported/);
  assert.match(prompt, /Avoid repetitive hedging/);
});

test("chunked prompts preserve date changes even if the model digest loses dates", async () => {
  const prompts = [];
  const events = Array.from({ length: 24 }, (_, index) => ({
    date: index < 12 ? "2026-09-27" : "2026-09-28", time: index < 12 ? "23:50" : "00:10",
    project: "demo", sessionId: "overnight", kind: "assistant outcome", text: "Detailed evidence. ".repeat(100),
  }));
  await summarizeSession({ complete: async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify(prompt.includes("Extract a compact factual timeline") ? { timeline: "23:50 Work started; 00:10 tests reported passing." } : summary);
  } }, { ...session, events });
  assert.ok(prompts.length > 2);
  for (const prompt of prompts.slice(0, -1)) {
    assert.match(prompt, /YYYY-MM-DD HH:mm/);
    assert.match(prompt, /Retain the source date on each bullet/);
    assert.match(prompt, /completed commits versus edits awaiting commit/);
  }
  assert.match(prompts.at(-1), /all three layers as the user's personal diary: use 'I', never 'the user'/);
  assert.match(prompts.at(-1), /use 'we' only when it clarifies collaboration with the agent/);
  assert.match(prompts.at(-1), /Known local work-block dates: 2026-09-27, 2026-09-28\./);
  assert.match(prompts.at(-1), /attached to the action or result they record/);
});

test("prompt-version changes invalidate old summaries without changing source identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-prompt-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = { cachePolicy: { model: "Pi default" }, complete: async () => JSON.stringify(summary) };
  const current = await saveSessionSummary(client, root, session);
  const oldFingerprint = createHash("sha256").update(JSON.stringify([
    "work-block-layers-v2", JOURNAL_SYSTEM_PROMPT, 16000, current.sourceFingerprint, [["model", "Pi default"]],
  ])).digest("hex");
  const markdown = (await readFile(current.sessionPath, "utf8"))
    .replace(`cacheFingerprint: "${current.cacheFingerprint}"`, `cacheFingerprint: "${oldFingerprint}"`)
    .replace('summaryVersion: "work-block-layers-v3"', 'summaryVersion: "work-block-layers-v2"');
  await writeFile(current.sessionPath, markdown);
  const inspected = await inspectSessionSummary(client, root, session);
  assert.equal(inspected.reused, false);
  assert.equal(inspected.sourceFingerprint, current.sourceFingerprint);
  assert.notEqual(inspected.cacheFingerprint, oldFingerprint);
});
