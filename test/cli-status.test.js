import test from "node:test";
import assert from "node:assert/strict";
import { statusPrefix, statusPrefixWidth, STATUS_WIDTH } from "../src/cli-status.js";

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
