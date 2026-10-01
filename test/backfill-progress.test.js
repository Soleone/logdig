import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { createBackfillProgress } from "../src/backfill-progress.js";

class Terminal extends EventEmitter {
  isTTY = true;
  columns = 160;
  rows = 24;
  output = "";
  lines = [""];
  row = 0;
  column = 0;

  write(text) {
    this.output += text;
    for (const token of text.match(/\x1b\[[0-9;]*[AKm]|./gsu) || []) {
      if (token === "\x1b[1A") this.row--;
      else if (token === "\x1b[2K") this.lines[this.row] = "";
      else if (token.startsWith("\x1b[")) continue;
      else if (token === "\r") this.column = 0;
      else if (token === "\n") { this.row++; this.column = 0; }
      else {
        const line = (this.lines[this.row] || "").padEnd(this.column);
        this.lines[this.row] = line.slice(0, this.column) + token + line.slice(this.column + token.length);
        this.column += token.length;
      }
    }
  }

  screen() {
    return this.lines.map((line) => line.trimEnd()).filter(Boolean).join("\n");
  }
}

function event(index, status = "SUMMARIZING", extra = {}) {
  return {
    index, sessionId: `session-${index}`, date: "2026-10-01", time: "12:00", project: `project-${index}`,
    status, phase: status === "SUMMARIZING" ? "summarizing" : "complete", ...extra,
  };
}

function fixture(options = {}) {
  const stream = new Terminal();
  const { stream: streamOptions, ...progressOptions } = options;
  Object.assign(stream, streamOptions);
  const progress = createBackfillProgress({ total: 2, concurrency: 2, stream, term: "xterm", icons: false, ...progressOptions });
  return { stream, progress };
}

test("live rows change in place from active to waiting, then become ordered permanent results", () => {
  const { stream, progress } = fixture();
  progress.onProgress(event(1));
  progress.onProgress(event(2));
  assert.match(stream.screen(), /Completed: 0\/2 sessions/);
  assert.match(stream.screen(), /SUMMARIZING · project-1/);
  assert.match(stream.screen(), /SUMMARIZING · project-2/);
  progress.onProgress(event(2, "UPDATED"));
  progress.onSessionComplete({ index: 2 });
  assert.match(stream.screen(), /Completed: 1\/2 sessions · 1 awaiting ordered output/);
  assert.match(stream.screen(), /DONE\s+· project-2/);
  assert.doesNotMatch(stream.screen(), /UPDATED/);
  progress.onProgress(event(1, "SAVED"));
  progress.onSessionComplete({ index: 1 });
  assert.equal(stream.screen(), "[1/2] 2026-10-01 12:00 · SAVED       · project-1 (ession-1)\n[2/2] 2026-10-01 12:00 · UPDATED     · project-2 (ession-2)");
  assert.match(stream.output, /\x1b\[1A\x1b\[2K/);
  progress.close();
});

test("panel remains bounded and prioritizes active workers over buffered completions", () => {
  const { stream, progress } = fixture({ total: 8, concurrency: 4 });
  progress.onProgress(event(1));
  for (let index = 2; index <= 5; index++) {
    progress.onProgress(event(index, "CURRENT"));
    progress.onSessionComplete({ index });
  }
  progress.onProgress(event(6));
  progress.onProgress(event(7));
  const lines = stream.screen().split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[0], /Completed: 4\/8 sessions · 4 awaiting ordered output/);
  for (const index of [1, 6, 7]) assert.ok(lines.some((line) => line.includes(`SUMMARIZING · project-${index}`)));
  assert.equal(lines.filter((line) => line.includes("DONE")).length, 1);
  progress.close();
});

test("a resumed session only finishes after its last block and preserves both dated results", () => {
  const { stream, progress } = fixture({ total: 1, concurrency: 1 });
  progress.onProgress(event(1, "SAVED", { date: "2026-09-30" }));
  assert.match(stream.screen(), /Completed: 0\/1 sessions/);
  progress.onProgress(event(1));
  assert.match(stream.screen(), /2026-10-01.*SUMMARIZING/);
  assert.doesNotMatch(stream.screen(), /2026-09-30|DONE/);
  progress.onProgress(event(1, "UPDATED"));
  progress.onSessionComplete({ index: 1 });
  assert.match(stream.screen(), /2026-09-30.*SAVED.*\n.*2026-10-01.*UPDATED/);
  assert.doesNotMatch(stream.screen(), /Completed:|SUMMARIZING/);
  progress.close();
});

test("failures and skipped sessions advance ordered results without leaving a panel", () => {
  const { stream, progress } = fixture();
  progress.onProgress(event(1));
  progress.onProgress(event(2, "SKIPPED", { phase: "skipped", reason: "outside date range" }));
  progress.onSessionComplete({ index: 2 });
  progress.onProgress(event(1, "FAILED", { phase: "error", error: "model failed" }));
  progress.onSessionComplete({ index: 1 });
  assert.match(stream.screen(), /^\[1\/2\].*FAILED.*model failed\n\[2\/2\].*SKIPPED.*outside date range$/);
  assert.doesNotMatch(stream.screen(), /Completed:/);
  progress.close();
});

test("a failed block remains visibly failed while its session waits, even if a later block succeeds", () => {
  const { stream, progress } = fixture();
  progress.onProgress(event(1));
  progress.onProgress(event(2, "FAILED", { phase: "error", error: "failed earlier block" }));
  progress.onProgress(event(2, "SAVED"));
  progress.onSessionComplete({ index: 2 });
  assert.match(stream.screen(), /FAILED\s+· project-2/);
  assert.doesNotMatch(stream.screen(), /DONE/);
  progress.close();
});

for (const options of [{ stream: { isTTY: false } }, { term: "dumb" }]) {
  test(`plain logs show active and finished work without cursor controls (${JSON.stringify(options)})`, () => {
    const { stream, progress } = fixture(options);
    progress.onProgress(event(1));
    progress.onProgress(event(2, "CURRENT"));
    progress.onSessionComplete({ index: 2 });
    assert.match(stream.output, /^Active \[1\/2\].*SUMMARIZING/m);
    assert.match(stream.output, /Finished \[2\/2\].*DONE.*waiting for earlier results/);
    progress.onProgress(event(1, "SAVED"));
    progress.onSessionComplete({ index: 1 });
    assert.match(stream.output, /\n\[1\/2\].*SAVED.*\n\[2\/2\].*CURRENT/);
    assert.doesNotMatch(stream.output, /\x1b|Completed:/);
    progress.close();
  });
}

test("preview output remains static and its paths stay with the ordered result", () => {
  const { stream, progress } = fixture({ dryRun: true });
  progress.onProgress(event(2, "PREVIEW", { dailyPath: "/daily/2.md", sessionPath: "/cache/2.md", prerequisite: true }));
  progress.onSessionComplete({ index: 2 });
  assert.equal(stream.output, "");
  progress.onProgress(event(1, "SKIPPED", { phase: "skipped" }));
  progress.onSessionComplete({ index: 1 });
  assert.match(stream.output, /\[1\/2\].*SKIPPED.*\n\[2\/2\].*PREVIEW.*prerequisite\n  Daily note: \/daily\/2.md\n  Full summary: \/cache\/2.md/);
  assert.doesNotMatch(stream.output, /\x1b|Active |Finished |Completed:/);
  progress.close();
});

test("narrow panels clip rows, sanitize terminal controls, and leave no resize listener after cleanup", () => {
  const { stream, progress } = fixture({ stream: { columns: 50, rows: 5 }, icons: true });
  progress.onProgress(event(1, "SUMMARIZING", { project: "项目".repeat(50) + "\x1b[2J\nmalicious" }));
  assert.doesNotMatch(stream.output, /\x1b\[2J|malicious/);
  for (const line of stripVTControlCharacters(stream.output).split("\n")) {
    const cells = [...line].reduce((width, char) => width + (char.codePointAt(0) > 127 ? 2 : 1), 0);
    assert.ok(cells < stream.columns, line);
  }
  assert.equal(stream.listenerCount("resize"), 1);
  stream.columns = 70;
  stream.emit("resize");
  assert.match(stream.screen(), /SUMMARIZING/);
  progress.close();
  assert.equal(stream.screen(), "");
  assert.equal(stream.listenerCount("resize"), 0);
  const output = stream.output;
  progress.close();
  progress.onProgress(event(2));
  progress.onSessionComplete({ index: 2 });
  stream.emit("resize");
  assert.equal(stream.output, output);
});
