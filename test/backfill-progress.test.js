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

test("live panel separates active workers from finished sessions waiting to print", () => {
  const { stream, progress } = fixture();
  progress.onProgress(event(1));
  progress.onProgress(event(2));
  assert.match(stream.screen(), /Progress: 0\/2 complete · 2 active · 0 queued/);
  assert.match(stream.screen(), /Active sessions \(stage elapsed\):/);
  assert.match(stream.screen(), /SUMMARIZING · 00m 00s · project-1 \(ession-1\)/);
  assert.match(stream.screen(), /SUMMARIZING · 00m 00s · project-2 \(ession-2\)/);
  progress.onProgress(event(2, "UPDATED"));
  progress.onSessionComplete({ index: 2 });
  assert.match(stream.screen(), /Progress: 1\/2 complete · 1 active · 0 queued/);
  assert.match(stream.screen(), /1 finished session waiting to print after #1\./);
  assert.doesNotMatch(stream.screen(), /DONE|UPDATED|project-2|ordered output/);
  progress.onProgress(event(1, "SAVED"));
  progress.onSessionComplete({ index: 1 });
  assert.equal(stream.screen(), "[1/2] 2026-10-01 12:00 · SAVED       · project-1 (ession-1)\n[2/2] 2026-10-01 12:00 · UPDATED     · project-2 (ession-2)");
  assert.match(stream.output, /\x1b\[1A\x1b\[2K/);
  progress.close();
});

test("panel shows queued work and no buffered result rows", () => {
  const { stream, progress } = fixture({ total: 8, concurrency: 4 });
  progress.onProgress(event(1));
  for (let index = 2; index <= 5; index++) {
    progress.onProgress(event(index, "CURRENT"));
    progress.onSessionComplete({ index });
  }
  progress.onProgress(event(6));
  progress.onProgress(event(7));
  const lines = stream.screen().split("\n");
  assert.equal(lines.length, 6);
  assert.match(lines[0], /Progress: 4\/8 complete · 3 active · 1 queued/);
  for (const index of [1, 6, 7]) assert.ok(lines.some((line) => line.includes(`SUMMARIZING · 00m 00s · project-${index} (ession-${index})`)));
  assert.match(lines.at(-1), /4 finished sessions waiting to print after #1\./);
  assert.doesNotMatch(stream.screen(), /DONE|project-[2-5]/);
  progress.close();
});

test("finishing the blocker prints through the next unfinished session", () => {
  const { stream, progress } = fixture({ total: 30, concurrency: 8 });
  progress.onProgress(event(1));
  progress.onProgress(event(7));
  for (const index of [2, 3, 4, 5, 6, 8]) {
    progress.onProgress(event(index, "SAVED"));
    progress.onSessionComplete({ index });
  }
  assert.match(stream.screen(), /6 finished sessions waiting to print after #01\./);
  progress.onProgress(event(1, "SAVED"));
  progress.onSessionComplete({ index: 1 });
  const printed = stream.screen().split("\n").filter((line) => line.includes("SAVED"));
  assert.deepEqual(printed.map((line) => line.slice(0, 8)), ["[01/30] ", "[02/30] ", "[03/30] ", "[04/30] ", "[05/30] ", "[06/30] "]);
  assert.match(stream.screen(), /Progress: 7\/30 complete · 1 active · 22 queued/);
  assert.match(stream.screen(), /1 finished session waiting to print after #07\./);
  assert.doesNotMatch(stream.screen(), /project-8/);
  progress.close();
});

test("elapsed times refresh while the model is silent, reset for a new stage, and stop on close", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const { stream, progress } = fixture();
  progress.onProgress(event(1, "CHECKING", { phase: "checking" }));
  t.mock.timers.tick(2000);
  assert.match(stream.screen(), /CHECKING\s+· 00m 02s · project-1 \(ession-1\)/);
  progress.onProgress(event(1));
  assert.match(stream.screen(), /SUMMARIZING · 00m 00s · project-1 \(ession-1\)/);
  t.mock.timers.tick(62000);
  assert.match(stream.screen(), /SUMMARIZING · 01m 02s · project-1 \(ession-1\)/);
  progress.onProgress(event(1));
  assert.match(stream.screen(), /SUMMARIZING · 01m 02s · project-1 \(ession-1\)/);
  progress.onProgress(event(1, "SUMMARIZING", { blockId: "next-block" }));
  assert.match(stream.screen(), /SUMMARIZING · 00m 00s · project-1 \(ession-1\)/);
  progress.close();
  const output = stream.output;
  t.mock.timers.tick(5000);
  assert.equal(stream.output, output);
  assert.equal(stream.screen(), "");
});

test("zero-padded elapsed timers keep project labels aligned", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const { stream, progress } = fixture();
  progress.onProgress(event(1));
  t.mock.timers.tick(59000);
  progress.onProgress(event(2));
  t.mock.timers.tick(2000);

  const rows = stream.screen().split("\n").filter((line) => line.includes("project-"));
  assert.match(rows[0], /01m 01s · project-1 \(ession-1\)$/);
  assert.match(rows[1], /00m 02s · project-2 \(ession-2\)$/);
  assert.equal(rows[0].indexOf("project-1"), rows[1].indexOf("project-2"));
  progress.close();
});

test("finishing all sessions stops timed redraws before close", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const { stream, progress } = fixture({ total: 1, concurrency: 1 });
  progress.onProgress(event(1));
  progress.onProgress(event(1, "SAVED"));
  progress.onSessionComplete({ index: 1 });
  const output = stream.output;
  t.mock.timers.tick(5000);
  assert.equal(stream.output, output);
  progress.close();
});

test("short terminals bound active rows and report workers not shown", () => {
  const { stream, progress } = fixture({ total: 10, concurrency: 8, stream: { rows: 8 } });
  for (let index = 1; index <= 7; index++) progress.onProgress(event(index));
  progress.onProgress(event(9, "SAVED"));
  progress.onSessionComplete({ index: 9 });
  progress.onProgress(event(8));
  assert.equal(stream.screen().split("\n").length, 6);
  assert.match(stream.screen(), /Progress: 1\/10 complete · 8 active · 1 queued/);
  assert.match(stream.screen(), /Active sessions \(stage elapsed; 5 not shown\):/);
  assert.match(stream.screen(), /1 finished session waiting to print after #01\./);
  stream.rows = 24;
  stream.emit("resize");
  assert.match(stream.screen(), /project-8/);
  assert.doesNotMatch(stream.screen(), /not shown/);
  progress.close();
});

test("a resumed session only finishes after its last block and preserves both dated results", () => {
  const { stream, progress } = fixture({ total: 1, concurrency: 1 });
  progress.onProgress(event(1, "SAVED", { date: "2026-09-30" }));
  assert.match(stream.screen(), /Progress: 0\/1 complete · 1 active · 0 queued/);
  progress.onProgress(event(1));
  assert.match(stream.screen(), /2026-10-01.*SUMMARIZING/);
  assert.doesNotMatch(stream.screen(), /2026-09-30|DONE/);
  progress.onProgress(event(1, "UPDATED"));
  progress.onSessionComplete({ index: 1 });
  assert.match(stream.screen(), /2026-09-30.*SAVED.*\n.*2026-10-01.*UPDATED/);
  assert.doesNotMatch(stream.screen(), /Progress:|SUMMARIZING|Active sessions/);
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
  assert.doesNotMatch(stream.screen(), /Progress:/);
  progress.close();
});

test("buffered sessions with errors stay visible even if a later block succeeds", () => {
  const { stream, progress } = fixture();
  progress.onProgress(event(1));
  progress.onProgress(event(2, "FAILED", { phase: "error", error: "failed earlier block" }));
  progress.onProgress(event(2, "SAVED"));
  progress.onSessionComplete({ index: 2 });
  assert.match(stream.screen(), /1 finished session waiting to print after #1\. 1 with errors\./);
  assert.doesNotMatch(stream.screen(), /DONE|project-2/);
  progress.close();
});

for (const options of [{ stream: { isTTY: false } }, { term: "dumb" }]) {
  test(`plain logs show active and finished work without cursor controls (${JSON.stringify(options)})`, () => {
    const { stream, progress } = fixture(options);
    progress.onProgress(event(1));
    progress.onProgress(event(2, "CURRENT"));
    progress.onSessionComplete({ index: 2 });
    assert.match(stream.output, /^Active \[1\/2\].*SUMMARIZING/m);
    assert.match(stream.output, /Finished \[2\/2\].*DONE.*waiting to print after #1; processing continues/);
    progress.onProgress(event(1, "SAVED"));
    progress.onSessionComplete({ index: 1 });
    assert.match(stream.output, /\n\[1\/2\].*SAVED.*\n\[2\/2\].*CURRENT/);
    assert.doesNotMatch(stream.output, /\x1b|Progress:|stage elapsed/);
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
  assert.doesNotMatch(stream.output, /\x1b|Active |Finished |Progress:/);
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
