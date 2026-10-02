import { EventEmitter } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { collectSessions, writeSessions } from "../src/session-runner.js";
import { createBackfillProgress } from "../src/backfill-progress.js";
import { parseSessionNote } from "../src/journal.js";

export const DEMO_DATE = "2026-10-01";
const PROJECTS = [
  ["atlas", "I added keyboard navigation to the command palette.", "Mapped arrow keys and Enter to the existing command actions; added a focused regression test."],
  ["atlas", "I fixed a stale search result after switching workspaces.", "Reset the search state at the workspace boundary and checked the empty-result case."],
  ["fieldnotes", "I made daily-note links easier to scan.", "Kept timestamps inline and removed redundant labels from the journal view."],
  ["relay", "I traced a reconnect loop to an expired token.", "Found the retry loop. The refresh-path fix is still pending."],
  ["atlas", "I tightened the export dialog and its error copy.", "Simplified the options and made the failure message point to a retry."],
  ["fieldnotes", "I preserved handwritten entries during import.", "Changed the importer to update only its own generated section."],
  ["relay", "I added a regression test for interrupted uploads.", "Covered a connection closing between chunks; verified the retry keeps its offset."],
  ["atlas", "I reduced duplicate requests in the activity feed.", "Reused the in-flight fetch instead of starting another on focus."],
  ["fieldnotes", "I checked how overnight work appears in the journal.", "Kept continuous work on its starting date and reviewed the next-day continuation."],
  ["relay", "I documented the remaining reconnect work.", "Wrote a handoff with the failing case and the next verification step."],
];
// A slower first response makes out-of-order completion visible without a speed claim.
const DELAYS = [6200, 2500, 3300, 4200, 2600, 3200, 2400, 3400, 2800, 2600];

function terminalCapture() {
  const stream = new EventEmitter();
  Object.assign(stream, { isTTY: true, columns: 82, rows: 24 });
  const started = performance.now();
  const frames = [];
  const chunks = [];
  const lines = [""];
  let row = 0;
  let column = 0;
  stream.write = (chunk) => {
    chunks.push(chunk);
    for (const token of chunk.match(/\x1b\[[0-9;]*[A-Za-z]|[^\x1b]/gu) || []) {
      if (token === "\x1b[1A") row = Math.max(0, row - 1);
      else if (token === "\x1b[2K") lines[row] = "";
      else if (token.startsWith("\x1b[")) continue;
      else if (token === "\r") column = 0;
      else if (token === "\n") { row++; column = 0; lines[row] ??= ""; }
      else {
        lines[row] ??= "";
        lines[row] = lines[row].padEnd(column, " ").slice(0, column) + token + lines[row].slice(column + 1);
        column++;
      }
    }
    frames.push({ ms: Math.round(performance.now() - started), lines: lines.slice() });
  };
  return { stream, frames, chunks };
}

export async function createDemo({ outputDirectory, delayScale = 1 } = {}) {
  if (!Number.isFinite(delayScale) || delayScale < 0) throw new Error("delayScale must be non-negative");
  const root = outputDirectory ? path.resolve(outputDirectory) : await mkdtemp(path.join(os.tmpdir(), "logdig-demo-"));
  // Caller-supplied directories must be new: never reset an existing vault or capture.
  if (outputDirectory) await mkdir(root);
  const settings = {
    sessionDirectory: path.join(root, "history"), cacheDirectory: path.join(root, "vault", "LogDig"),
    dailyDirectory: path.join(root, "vault", "Daily"), dailyHeader: "# Projects", dailySummary: "small",
    timeZone: "UTC", concurrency: 4, piCommand: "not-used", autoCapture: false,
  };
  await mkdir(settings.sessionDirectory, { recursive: true });
  await mkdir(settings.dailyDirectory, { recursive: true });
  const dailyPath = path.join(settings.dailyDirectory, `${DEMO_DATE}.md`);
  const personalNote = "# Log\n\nCoffee, a walk, then a few good hours of building.\n";
  await writeFile(dailyPath, personalNote);
  for (const [index, [project, small, detail]] of PROJECTS.entries()) {
    const timestamp = `${DEMO_DATE}T${String(9 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}:00Z`;
    const records = [
      { type: "session", version: 3, id: `demo-session-${String(index + 1).padStart(2, "0")}`, cwd: `/demo/${project}`, timestamp },
      { type: "message", id: `demo-user-${index}`, timestamp, message: { role: "user", content: `Demo case ${index + 1}: ${detail}` } },
      { type: "message", id: `demo-assistant-${index}`, timestamp: new Date(Date.parse(timestamp) + 60000).toISOString(), message: { role: "assistant", content: small } },
    ];
    await writeFile(path.join(settings.sessionDirectory, `${index + 1}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  }
  const found = await collectSessions({ sessionDirectory: settings.sessionDirectory, timeZone: "UTC" });
  if (found.warnings.length || found.sessions.length !== 10) throw new Error("Synthetic history did not scan cleanly");
  const capture = terminalCapture();
  capture.stream.write("10 saved Pi sessions · 4 parallel sessions\n\n");
  const progress = createBackfillProgress({ total: 10, concurrency: 4, stream: capture.stream, term: "xterm", icons: false, noColor: true });
  let active = 0;
  let peakConcurrency = 0;
  let modelCalls = 0;
  let releaseFirstWave;
  const firstWave = new Promise((resolve) => { releaseFirstWave = resolve; });
  const model = { complete: async (prompt) => {
    const index = Number(prompt.match(/Demo case (\d+):/)?.[1]) - 1;
    if (!PROJECTS[index]) throw new Error("Unexpected model request in synthetic demo");
    modelCalls++;
    peakConcurrency = Math.max(peakConcurrency, ++active);
    if (modelCalls === 4) releaseFirstWave();
    try {
      // Hold the first wave together even when tests use zero-length delays.
      if (modelCalls <= 4) await firstWave;
      await new Promise((resolve) => setTimeout(resolve, DELAYS[index] * delayScale));
      const [, small, detail] = PROJECTS[index];
      return JSON.stringify({ small, medium: `## Outcome\n${small}\n\n## Detail\n${detail}`, large: `## Work log\n${detail}\n\n## Result\n${small}\n\nSynthetic session and canned summary for the LogDig demo.` });
    } finally { active--; }
  } };
  let result;
  try {
    result = await writeSessions(model, found.sessions, settings, { onProgress: progress.onProgress, onSessionComplete: progress.onSessionComplete });
  } finally { progress.close(); }
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  if (result.entriesAppended !== 10 || peakConcurrency !== 4) throw new Error("Demo did not produce ten entries with four parallel sessions");
  capture.stream.write("\nSaved 10 work blocks. Your handwritten note stays.\n");
  const dailyMarkdown = await readFile(dailyPath, "utf8");
  const repeated = await writeSessions(model, found.sessions, settings);
  if (repeated.errors.length || repeated.entriesSkipped !== 10 || modelCalls !== 10 || await readFile(dailyPath, "utf8") !== dailyMarkdown) {
    throw new Error("Unchanged demo rerun failed the cache/preservation check");
  }
  const summaries = await Promise.all(result.sessionResults.map(async (entry) => ({
    ...entry, layers: parseSessionNote(await readFile(entry.sessionPath, "utf8")).summary,
  })));
  const recording = {
    synthetic: true, date: DEMO_DATE, concurrency: 4, peakConcurrency, modelCalls,
    durationMs: capture.frames.at(-1).ms, frames: capture.frames, dailyMarkdown, summaries,
    verification: { entries: 10, summariesReused: repeated.summariesReused, handwrittenNotePreserved: dailyMarkdown.startsWith(personalNote) },
  };
  await writeFile(path.join(root, "recording.json"), JSON.stringify(recording, null, 2) + "\n");
  await writeFile(path.join(root, "terminal.ansi"), capture.chunks.join(""));
  const template = await readFile(new URL("../docs/launch/artboard.html", import.meta.url), "utf8");
  const payload = JSON.stringify(recording).replaceAll("<", "\\u003c");
  await writeFile(path.join(root, "index.html"), template.replace("/* RECORDING */ null", payload));
  for (const name of ["Lato-Bold.ttf", "Lato-Regular.ttf", "Lato-LICENSE.txt"]) {
    await copyFile(new URL(`../docs/launch/${name}`, import.meta.url), path.join(root, name));
  }
  return { root, recording };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) console.log("node scripts/demo.js [NEW_OUTPUT_DIRECTORY]\nTen synthetic sessions, four parallel workers, no Pi or provider calls. Output defaults to a new temporary directory.");
  else createDemo({ outputDirectory: process.argv[2] }).then(({ root }) => console.log(root)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
