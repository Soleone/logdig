import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDemo, DEMO_DATE } from "../scripts/demo.js";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-demo-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("launch demo uses ten synthetic sessions, real parallel writes, and a no-request rerun", { timeout: 10_000 }, async (t) => {
  const parent = await workspace(t);
  const { root, recording } = await createDemo({ outputDirectory: path.join(parent, "capture"), delayScale: 0 });
  assert.equal(recording.synthetic, true);
  assert.equal(recording.modelCalls, 10);
  assert.equal(recording.peakConcurrency, 4);
  assert.deepEqual(recording.verification, { entries: 10, summariesReused: 10, handwrittenNotePreserved: true });
  assert.equal((await readdir(path.join(root, "history"))).length, 10);
  assert.equal((await readdir(path.join(root, "vault", "LogDig", "Sessions"))).length, 10);
  assert.equal((await readdir(path.join(root, "vault", "LogDig", "Entries"))).length, 10);
  const daily = await readFile(path.join(root, "vault", "Daily", `${DEMO_DATE}.md`), "utf8");
  assert.equal((daily.match(/\*\*\[\[/g) || []).length, 10);
  for (const project of ["atlas", "fieldnotes", "relay"]) assert.match(daily, new RegExp(`## ${project}`));
  assert.ok(recording.frames.some((frame) => frame.lines.some((line) => line.includes("4 active"))));
  assert.ok(recording.frames.at(-1).lines.some((line) => line.includes("Saved 10 work blocks")));
  assert.ok(recording.frames.every((frame) => frame.lines.every((line) => !line.includes("\x1b"))));
  assert.equal(recording.summaries.length, 10);
  for (const summary of recording.summaries) {
    for (const level of ["small", "medium", "large"]) assert.ok(summary.layers[level]);
  }
  const html = await readFile(path.join(root, "index.html"), "utf8");
  assert.ok(!html.includes("/* RECORDING */ null"));
  assert.match(html, /Synthetic sessions \+ canned responses/);
  assert.ok((await readFile(path.join(root, "Lato-Bold.ttf"))).length > 0);
});

test("demo refuses existing output directories, including a symlink to one", async (t) => {
  const root = await workspace(t);
  const marker = path.join(root, "keep.md");
  await writeFile(marker, "Do not touch");
  await assert.rejects(createDemo({ outputDirectory: root, delayScale: 0 }), { code: "EEXIST" });
  assert.equal(await readFile(marker, "utf8"), "Do not touch");
  const alias = path.join(root, "alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createDemo({ outputDirectory: alias, delayScale: 0 }), { code: "EEXIST" });
});

test("demo rejects invalid delays before creating output", async (t) => {
  const root = await workspace(t);
  const outputDirectory = path.join(root, "capture");
  for (const delayScale of [-1, NaN, Infinity]) await assert.rejects(createDemo({ outputDirectory, delayScale }), /non-negative/);
  assert.deepEqual(await readdir(root), []);
});
