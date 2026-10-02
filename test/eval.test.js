import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveSessionSummary } from "../src/journal.js";
import { sessionFromJsonl } from "../src/transcript.js";
import { workBlocksForSession } from "../src/work-blocks.js";
import { ARMS, PROMPT_ARMS, aggregateUsage, blindCandidates, digest, evaluationReport, freezeEvaluation, generateCase, judgeEvaluation, judgePrompt, loadEvaluation, runEvaluation, validateJudgment } from "../scripts/eval.js";

const summary = { small: "Fixed parser; tests passed.", medium: "Goal: fix parser. Status: tests passed.", large: "2026-01-01 12:01 Fixed parser; tests passed." };
const usage = { input: 100, output: 20, cacheRead: 5, cost: { total: 0.01 } };
const evidence = { header: { id: "test-session", cwd: "/work/demo" }, project: "demo", date: "2026-01-01", timezone: "UTC", context: [], events: [{ sessionId: "test-session", project: "demo", date: "2026-01-01", time: "12:01", kind: "assistant outcome", text: "Fixed parser; tests passed." }] };

function judgmentFor(candidates, checklist = []) {
  const scores = { accuracy: 5, coverage: 5, status: 5, usefulness: 5, chronology: 5 };
  return { candidates: candidates.map(({ label }) => ({ label, layers: { small: { ...scores, chronology: null }, medium: { ...scores, chronology: null }, large: { ...scores } }, issues: [], checks: checklist.map((_, index) => ({ index: index + 1, status: "covered", explanation: "The candidate preserves the source fact." })) })),
    pairs: candidates.flatMap((left, index) => candidates.slice(index + 1).map((right) => ({ left: left.label, right: right.label, winner: "tie", reason: "Equivalent factual coverage." }))), summary: "Equivalent results." };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-eval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { sessionDirectory: path.join(root, "history"), cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), timeZone: "UTC", piCommand: "fake-pi" };
  await mkdir(settings.sessionDirectory);
  await mkdir(settings.dailyDirectory);
  const rows = [
    { type: "session", id: "test-session", timestamp: "2026-01-01T12:00:00Z", cwd: "/work/demo" },
    { type: "message", id: "user-1", timestamp: "2026-01-01T12:00:00Z", message: { role: "user", content: "Fix the parser" } },
    { type: "message", id: "assistant-1", timestamp: "2026-01-01T12:01:00Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Fixed parser; tests passed." }] } },
  ];
  const text = rows.map(JSON.stringify).join("\n");
  const sourcePath = path.join(settings.sessionDirectory, "test.jsonl");
  await writeFile(sourcePath, text);
  const block = workBlocksForSession(sessionFromJsonl(text, sourcePath), "UTC")[0];
  await saveSessionSummary({ cachePolicy: { model: "Pi default" }, modelLabel: "Pi startup default", complete: async () => ({ text: JSON.stringify(summary) }) }, settings.cacheDirectory, block);
  return { root, settings, directory: path.join(root, "evaluation"), selection: { settings, baselineAttribution: "Historical model unknown", cases: [{ id: "parser", sessionId: "test-session", blockId: block.blockId, reason: "Short parser fix" }] } };
}

test("eval runs full production extraction per model and records metrics", async () => {
  const long = { ...evidence, events: Array.from({ length: 24 }, () => ({ ...evidence.events[0], text: "Detailed event. ".repeat(100) })) };
  const persisted = [];
  const client = { complete: async (prompt) => ({ text: JSON.stringify(prompt.includes("Extract a compact factual timeline") ? { timeline: "12:01 Fixed parser; tests passed." } : summary), usages: [usage], provider: "test", model: "fake" }) };
  const result = await generateCase(client, long, async (request) => persisted.push(structuredClone(request)));
  assert.equal(result.status, "completed");
  assert.deepEqual(result.summary, summary);
  assert.ok(result.requests.length > 2);
  assert.equal(persisted.length, result.requests.length);
  assert.ok(persisted[0].prompt.includes("Extract a compact factual timeline"));
  assert.ok(persisted.at(-1).prompt.includes("timeline"));
  assert.equal(result.metrics.inputTokens, result.requests.length * 100);
  assert.equal(result.metrics.costUsd, result.requests.length * 0.01);
  assert.equal(result.metrics.outputTokens, result.requests.length * 20);
});

test("eval preserves invalid JSON output and its billed usage before parsing", async () => {
  const persisted = [];
  const result = await generateCase({ complete: async () => ({ text: "not JSON", usages: [usage] }) }, evidence, async (request) => persisted.push(request));
  assert.equal(result.status, "failed");
  assert.match(result.error, /JSON object/);
  assert.equal(persisted[0].text, "not JSON");
  assert.equal(result.metrics.costUsd, 0.01);
  assert.deepEqual(aggregateUsage([]), {});
  const rejected = await generateCase({ complete: async () => { throw new Error("quota exceeded"); } }, evidence);
  assert.equal(rejected.requests[0].error, "quota exceeded");
  assert.equal(rejected.metrics.costUsd, undefined);
});

test("blind judge receives no model labels and exact source citations are checked", () => {
  const candidates = blindCandidates("test", ARMS.map(({ id }) => ({ id, summary })));
  const prompt = judgePrompt(evidence, candidates);
  for (const arm of ARMS) assert.ok(!prompt.includes(arm.id) && !prompt.includes(arm.model));
  const valid = judgmentFor(candidates);
  valid.candidates[0].issues.push({ layer: "small", severity: "minor", claim: "Missing a detail", evidenceId: "E1", quote: "tests passed", explanation: "Source confirms the tests." });
  assert.equal(validateJudgment(valid, evidence, candidates), valid);
  const invalid = structuredClone(valid);
  invalid.candidates[0].issues[0].quote = "tests failed";
  assert.throws(() => validateJudgment(invalid, evidence, candidates), /exact evidence citation/);
  const reversed = blindCandidates("test", ARMS.map(({ id }) => ({ id, summary })), 2);
  assert.deepEqual(reversed.map(({ id }) => id), candidates.map(({ id }) => id).reverse());
});

test("judge schema rejects duplicate/missing pairs, labels, and invalid scores", () => {
  const candidates = blindCandidates("test", ARMS.map(({ id }) => ({ id, summary })));
  const wrongPairs = judgmentFor(candidates);
  wrongPairs.pairs[2] = wrongPairs.pairs[0];
  assert.throws(() => validateJudgment(wrongPairs, evidence, candidates), /Duplicate judge pair/);
  const wrongLabels = judgmentFor(candidates);
  wrongLabels.candidates[2].label = "A";
  assert.throws(() => validateJudgment(wrongLabels, evidence, candidates), /every candidate/);
  const wrongScore = judgmentFor(candidates);
  wrongScore.candidates[0].layers.large.accuracy = 6;
  assert.throws(() => validateJudgment(wrongScore, evidence, candidates), /Invalid/);
});

test("freeze snapshots only processed evidence and verifies baseline freshness", async (t) => {
  const f = await fixture(t);
  const manifest = await freezeEvaluation(f.selection, f.directory, { piVersion: "test" });
  assert.equal(manifest.cases.length, 1);
  assert.equal(manifest.cases[0].historical.model, "Pi startup default");
  const loaded = await loadEvaluation(f.directory);
  assert.equal(loaded.cases[0].evidence.entries, undefined);
  assert.equal(loaded.cases[0].evidence.header.id, "test-session");
  const baselinePath = path.join(f.directory, "cases", "parser-historical.md");
  await writeFile(baselinePath, "modified");
  await assert.rejects(loadEvaluation(f.directory), /frozen evidence or baseline changed/);
});

test("freeze refuses vault/history/repo overlap and duplicate slugs without writes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(freezeEvaluation(f.selection, path.join(f.settings.cacheDirectory, "eval")), /protected location/);
  await assert.rejects(freezeEvaluation(f.selection, f.root), /protected location/);
  await assert.rejects(freezeEvaluation({ ...f.selection, cases: [f.selection.cases[0], f.selection.cases[0]] }, f.directory), /unique lowercase slugs/);
  await assert.rejects(readFile(path.join(f.directory, "manifest.json")), { code: "ENOENT" });
});

test("generation/judging resume, preserve vault, and report paired outcomes", async (t) => {
  const f = await fixture(t);
  await freezeEvaluation(f.selection, f.directory);
  const cachedPath = path.join(f.settings.cacheDirectory, "Sessions", "test-session.md");
  const before = await readFile(cachedPath, "utf8");
  let calls = 0;
  const factory = (settings) => ({ complete: async (prompt) => {
    calls++;
    const text = prompt.startsWith("Evaluate anonymous") ? JSON.stringify(judgmentFor(JSON.parse(prompt.split("\n\n").at(-1)).candidates)) : JSON.stringify(summary);
    return { text, provider: "openai-codex", model: settings.model.split("/")[1], usages: [usage] };
  } });
  await runEvaluation(f.directory, undefined, factory);
  assert.equal(calls, 3);
  await runEvaluation(f.directory, undefined, factory);
  assert.equal(calls, 3);
  await judgeEvaluation(f.directory, factory);
  assert.equal(calls, 5);
  await judgeEvaluation(f.directory, factory);
  assert.equal(calls, 5);
  const report = await evaluationReport(f.directory);
  assert.equal(report.runs.length, 3);
  assert.ok(report.runs.every((run) => run.status === "completed"));
  assert.equal(report.comparisons.length, 6);
  assert.ok(report.comparisons.every((pair) => pair.outcome === "tie"));
  assert.equal(await readFile(cachedPath, "utf8"), before);
});

test("generation rejects mismatched actual models and preserves failed artifacts", async (t) => {
  const f = await fixture(t);
  await freezeEvaluation(f.selection, f.directory);
  const factory = () => ({ complete: async () => ({ text: JSON.stringify(summary), provider: "wrong", model: "wrong", usages: [usage] }) });
  await assert.rejects(runEvaluation(f.directory, "luna-max", factory), /does not match/);
  await assert.rejects(runEvaluation(f.directory, "luna-max", factory), /Prior failed run/);
  const result = JSON.parse(await readFile(path.join(f.directory, "runs", "parser-luna-max.json"), "utf8"));
  assert.equal(result.status, "failed");
  assert.equal(result.metrics.costUsd, 0.01);
});

test("checklist judging rejects missing fact assessments and distinguishes attribution from invention", () => {
  const checklist = [{ fact: "Tests reported passing.", evidenceId: "E1", quote: "tests passed" }];
  const candidates = blindCandidates("checklist", ARMS.map(({ id }) => ({ id, summary })));
  const prompt = judgePrompt(evidence, candidates, checklist);
  assert.match(prompt, /at most minor, never invented tests or a critical hallucination/);
  assert.match(prompt, /do not require every detail in small/);
  const value = judgmentFor(candidates, checklist);
  assert.equal(validateJudgment(value, evidence, candidates, checklist), value);
  value.candidates[0].checks = [];
  assert.throws(() => validateJudgment(value, evidence, candidates, checklist), /each checklist fact/);
});

test("replay uses exact frozen inputs and archived max outputs despite pipeline and live-history changes", async (t) => {
  const f = await fixture(t);
  await freezeEvaluation(f.selection, f.directory);
  const factory = (settings) => ({ complete: async (prompt) => {
    let text = JSON.stringify(summary);
    if (prompt.startsWith("Evaluate anonymous")) {
      const panel = JSON.parse(prompt.split("\n\n").at(-1));
      text = JSON.stringify(judgmentFor(panel.candidates, panel.checklist));
    }
    return { text, provider: "openai-codex", model: settings.model.split("/")[1], usages: [usage] };
  } });
  await runEvaluation(f.directory, undefined, factory);
  const sourceManifestPath = path.join(f.directory, "manifest.json");
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  const archivePath = path.join(f.directory, "pipeline", "src__journal.js");
  const archivedCode = (await readFile(archivePath, "utf8")) + "\n// Previous prompt revision fixture\n";
  await writeFile(archivePath, archivedCode);
  sourceManifest.pipelineHashes["src/journal.js"] = digest(archivedCode);
  await writeFile(sourceManifestPath, JSON.stringify(sourceManifest));
  await assert.rejects(loadEvaluation(f.directory), /pipeline changed/);
  const frozen = await loadEvaluation(f.directory, { archived: true });
  const event = frozen.cases[0].evidence.events.at(-1);
  await writeFile(path.join(f.directory, "manual-checklist.json"), JSON.stringify({ cases: { parser: [{ fact: "Tests reported passing.", evidenceId: `E${frozen.cases[0].evidence.events.length}`, quote: "tests passed" }] } }));
  assert.match(event.text, /tests passed/);
  await rm(f.settings.sessionDirectory, { recursive: true });
  const replayDirectory = path.join(f.root, "replay");
  const manifest = await freezeEvaluation({ settings: f.settings, replayFrom: f.directory }, replayDirectory);
  assert.deepEqual(manifest.arms, PROMPT_ARMS);
  assert.equal(manifest.cases[0].evidenceHash, sourceManifest.cases[0].evidenceHash);
  assert.equal(manifest.cases[0].checklist.length, 1);
  const replay = await loadEvaluation(replayDirectory);
  assert.deepEqual(replay.cases[0].evidence, frozen.cases[0].evidence);
  assert.deepEqual(replay.cases[0].referenceResult.summary, summary);
  await runEvaluation(replayDirectory, undefined, factory);
  await judgeEvaluation(replayDirectory, factory);
  const report = await evaluationReport(replayDirectory);
  assert.equal(report.runs.length, 3);
  assert.equal(report.comparisons.length, 3);
  assert.equal(report.runs[0].arm, "old-luna-max");
  assert.equal(report.runs[0].source, "prior-run");
  assert.deepEqual(report.judgments[0].mapping && Object.values(report.judgments[0].mapping).sort(), ["old-luna-max", "revised-max", "revised-medium"]);
  const referencePath = path.join(replayDirectory, "references", manifest.cases[0].reference.fileName);
  await writeFile(referencePath, "modified");
  await assert.rejects(loadEvaluation(replayDirectory), /reference run changed/);
});

test("archived replay checks reject modified evidence and pipeline artifacts", async (t) => {
  const f = await fixture(t);
  await freezeEvaluation(f.selection, f.directory);
  await writeFile(path.join(f.directory, "pipeline", "src__journal.js"), "modified");
  await assert.rejects(loadEvaluation(f.directory, { archived: true }), /Archived pipeline changed/);
});
