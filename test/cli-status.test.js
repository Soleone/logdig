import test from "node:test";
import assert from "node:assert/strict";
import { progressStatus, statusPrefix, statusPrefixWidth, STATUS_WIDTH } from "../src/cli-status.js";

test("interactive CLI status markers use colored Nerd Font icons", () => {
  assert.equal(statusPrefix("ok", { isTTY: true, term: "xterm-256color" }), "\u001b[32m\uf00c\u001b[0m ");
  assert.equal(statusPrefix("warning", { isTTY: true, term: "xterm-256color" }), "\u001b[33m\uf071\u001b[0m ");
  assert.equal(statusPrefix("error", { isTTY: true, term: "xterm-256color" }), "\u001b[31m\uf00d\u001b[0m ");
  assert.equal(statusPrefixWidth({ isTTY: true, term: "xterm-256color" }), 2);
  assert.equal(STATUS_WIDTH, 6);
});

test("CLI status markers stay readable without a Nerd Font or color", () => {
  assert.equal(statusPrefix("ok", { isTTY: false }), "OK    ");
  assert.equal(statusPrefix("warning", { isTTY: true, term: "dumb" }), "WARN  ");
  assert.equal(statusPrefix("error", { isTTY: true, icons: false }), "FIX   ");
  assert.equal(statusPrefix("ok", { isTTY: true, term: "xterm", noColor: true }), "\uf00c ");
  assert.equal(statusPrefixWidth({ isTTY: false }), 6);
});

test("backfill progress uses colored Nerd Font icons in terminals", () => {
  assert.equal(progressStatus("CHECKING", { isTTY: true, term: "xterm-256color" }), "\u001b[36m\uf002\u001b[0m CHECKING");
  assert.equal(progressStatus("SAVED", { isTTY: true, term: "xterm-256color" }), "\u001b[32m\uf00c\u001b[0m SAVED");
  assert.equal(progressStatus("FAILED", { isTTY: true, term: "xterm-256color" }), "\u001b[31m\uf00d\u001b[0m FAILED");
});

test("padded progress statuses align with and without terminal icons and color", () => {
  for (const options of [
    { isTTY: false }, { isTTY: true, term: "xterm" },
    { isTTY: true, term: "xterm", noColor: true }, { isTTY: true, icons: false },
  ]) {
    const statuses = ["CHECKING", "SUMMARIZING", "SAVED", "UPDATED", "CURRENT", "DONE", "SKIPPED", "FAILED", "PREVIEW"];
    const rendered = statuses.map((status) => progressStatus(status, { ...options, pad: true }).replace(/\u001b\[[0-9;]*m/g, ""));
    assert.equal(new Set(rendered.map((text) => text.length)).size, 1);
    for (const [index, status] of statuses.entries()) assert.ok(rendered[index].endsWith(status.padEnd(11)));
  }
});

test("backfill progress keeps one-word labels without Nerd Fonts or color", () => {
  assert.equal(progressStatus("SUMMARIZING", { isTTY: false }), "SUMMARIZING");
  assert.equal(progressStatus("SKIPPED", { isTTY: true, term: "dumb" }), "SKIPPED");
  assert.equal(progressStatus("PREVIEW", { isTTY: true, term: "xterm", noColor: true }), "\uf06e PREVIEW");
  assert.equal(progressStatus("UPDATED", { isTTY: true, term: "xterm", icons: false }), "UPDATED");
  assert.throws(() => progressStatus("UNKNOWN", { isTTY: false }), /Unknown progress status/);
});
