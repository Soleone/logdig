import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, saveSettings } from "../src/settings.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(packageRoot, "bin", "logdig.js");

async function workspace(t, { configured = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "config", "settings.json");
  const sessionDirectory = path.join(root, "pi", "sessions");
  const callsPath = path.join(root, "pi-calls.jsonl");
  await mkdir(sessionDirectory, { recursive: true });
  const fakeScript = path.join(root, "fake-pi.mjs");
  await writeFile(fakeScript, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) console.log("test-pi 1.0");
else if (args[0] === "install" || args[0] === "remove") console.log("Extension " + args[0]);
else {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  if (process.env.LOGDIG_TEST_MODEL_ERROR) {
    console.error("No authentication configured; open Pi and run /login");
    process.exitCode = 1;
  } else {
    const text = JSON.stringify({ small: "Improved the demo and verified its tests.", medium: "## Goal\\nImprove the demo.\\n\\n## Status\\nTests passed.", large: "Reviewed the demo, made the change, and ran its tests." });
    const usage = { input: 120, output: 30, cacheRead: 450, cacheWrite: 0, cost: { total: 0.025 } };
    for (const event of [
      { type: "session", id: "fake-run" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage, stopReason: "stop" } },
      { type: "agent_settled" },
    ]) console.log(JSON.stringify(event));
  }
}
`, { mode: 0o755 });
  let piCommand = fakeScript;
  if (process.platform === "win32") {
    piCommand = path.join(root, "fake-pi.cmd");
    await writeFile(piCommand, `@"${process.execPath}" "${fakeScript}" %*\r\n`);
  }
  const settings = {
    cacheDirectory: path.join(root, "vault", "LogDig"),
    dailyDirectory: path.join(root, "vault", "Daily Notes"),
    dailyHeader: "# Projects",
    dailySummary: "small",
    timeZone: "UTC",
    sessionDirectory,
    piCommand,
    model: "test/fake",
    autoCapture: false,
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("PI_JOURNAL_") && !key.startsWith("LOGDIG_") && key !== "PI_CODING_AGENT_SESSION_DIR",
  ));
  Object.assign(env, { LOGDIG_CONFIG_PATH: filePath, PI_CODING_AGENT_DIR: path.join(root, "pi"), PI_OFFLINE: "1" });
  if (configured) await saveSettings(settings, filePath);
  else env.PI_JOURNAL_PI_COMMAND = piCommand;
  return { root, env, filePath, settings, callsPath };
}

function runCli(args, env, { input = "", onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: packageRoot, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`CLI timed out: ${args.join(" ")}`)); }, 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; onOutput?.(stdout, child); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    if (input !== null) child.stdin.end(input);
  });
}

async function addSession(settings, { id = "demo-session", timestamp = Date.now() - 5_000 } = {}) {
  const records = [
    { type: "session", version: 3, id, cwd: "/work/demo-project", timestamp: new Date(timestamp).toISOString() },
    { type: "message", timestamp, message: { role: "user", content: "Make this nicer. api_key=private-value" } },
    { type: "message", timestamp: timestamp + 1_000, message: { role: "assistant", content: "Improved it and tests passed.", stopReason: "stop" } },
  ];
  await writeFile(path.join(settings.sessionDirectory, `${id}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n"));
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function calls(callsPath) {
  try {
    return (await readFile(callsPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("CLI help and subcommand help work before setup without writing settings", async (t) => {
  const w = await workspace(t, { configured: false });
  for (const args of [[], ["--help"], ["init", "--help"], ["backfill", "--help"]]) {
    const result = await runCli(args, w.env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /backfill 1 --dry-run/);
    assert.match(result.stdout, /no install needed/);
    assert.doesNotMatch(result.stdout, /Daily-notes folder \[/);
  }
  await assert.rejects(readFile(w.filePath), { code: "ENOENT" });
  assert.deepEqual(await calls(w.callsPath), []);
});

test("setup explains choices and recovers locally from invalid paths, headings, summaries, timezone, model, and yes/no input", async (t) => {
  const w = await workspace(t, { configured: false });
  const notAFolder = path.join(w.root, "a-file.md");
  await writeFile(notAFolder, "keep this");
  const input = [
    notAFolder, w.settings.dailyDirectory,
    w.settings.cacheDirectory,
    "Log", "## Log",
    "tiny", "MEDIUM",
    "Not/A_Timezone", "UTC",
    "maybe", "yes",
    notAFolder, w.settings.sessionDirectory,
    w.settings.piCommand,
    "invalid-model", "test/fake",
    "later", "no",
    "no",
    "yes",
  ].join("\n") + "\n";
  const result = await runCli(["init"], w.env, { input });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Let's try that again/);
  assert.match(result.stdout, /Ready to save/);
  assert.match(result.stdout, /Heading for journal entries \[# Projects\]/);
  assert.match(result.stdout, /grouped by project, then by time/);
  assert.match(result.stdout, /No history is summarized/);
  assert.match(result.stderr, /Environment overrides are active/);
  const saved = await loadSettings({ filePath: w.filePath, env: {}, home: w.root });
  assert.equal(saved.dailyHeader, "## Log");
  assert.equal(saved.dailySummary, "medium");
  assert.equal(saved.timeZone, "UTC");
  assert.equal(saved.model, "test/fake");
  assert.equal(saved.autoCapture, false);
  assert.equal(await readFile(notAFolder, "utf8"), "keep this");
  await assert.rejects(readdir(w.settings.cacheDirectory), { code: "ENOENT" });
  await assert.rejects(readdir(w.settings.dailyDirectory), { code: "ENOENT" });
  assert.deepEqual(await calls(w.callsPath), []);
});

test("declining setup confirmation preserves the existing settings byte for byte", async (t) => {
  const w = await workspace(t);
  const before = await readFile(w.filePath, "utf8");
  const input = ["", "", "", "", "", "no", "no", "no", "no"].join("\n") + "\n";
  const result = await runCli(["init"], w.env, { input });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /settings were not changed/);
  assert.equal(await readFile(w.filePath, "utf8"), before);
  assert.deepEqual(await calls(w.callsPath), []);
});

test("ending setup input early does not overwrite settings", async (t) => {
  const w = await workspace(t);
  const before = await readFile(w.filePath, "utf8");
  const result = await runCli(["init"], w.env, { input: "\n" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Setup ended early.*settings were not changed/);
  assert.equal(await readFile(w.filePath, "utf8"), before);
});

test("Ctrl+C cancels setup cleanly with no saved settings", { skip: process.platform === "win32" }, async (t) => {
  const w = await workspace(t, { configured: false });
  let interrupted = false;
  const result = await runCli(["init"], w.env, {
    input: null,
    onOutput: (output, child) => {
      if (!interrupted && output.includes("Daily-notes folder")) {
        interrupted = true;
        child.kill("SIGINT");
      }
    },
  });
  assert.equal(result.code, 130, result.stderr);
  assert.match(result.stderr, /Setup cancelled.*settings were not changed/);
  await assert.rejects(readFile(w.filePath), { code: "ENOENT" });
});

test("doctor reports every broken path and missing Pi in one pass", async (t) => {
  const w = await workspace(t);
  const file = path.join(w.root, "not-a-folder");
  await writeFile(file, "keep this");
  await saveSettings({ ...w.settings, cacheDirectory: file, dailyDirectory: file, piCommand: path.join(w.root, "missing-pi") }, w.filePath);
  const result = await runCli(["doctor"], w.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /FIX   Summary cache/);
  assert.match(result.stderr, /FIX   Daily notes/);
  assert.match(result.stderr, /FIX   Pi/);
  assert.match(result.stderr, /3 things to fix/);
  assert.equal(await readFile(file, "utf8"), "keep this");
});

test("doctor validates missing folders through their parents without creating them or requesting a model", async (t) => {
  const w = await workspace(t);
  const result = await runCli(["doctor"], w.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /will be created on a real backfill/);
  assert.match(result.stdout, /Checks passed/);
  assert.deepEqual((await calls(w.callsPath)).map((args) => args[0]), ["--version"]);
  await assert.rejects(readdir(w.settings.dailyDirectory), { code: "ENOENT" });
});

test("a dry run reports project, date, output file, and new summaries without calling Pi or writing anything", async (t) => {
  const w = await workspace(t);
  await addSession(w.settings);
  const before = await readFile(w.filePath, "utf8");
  const result = await runCli(["backfill", "1", "--dry-run"], w.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Dry run: no model requests, no file changes/);
  assert.match(result.stdout, /demo-project · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(result.stdout, /Daily note: .*Daily Notes/);
  assert.match(result.stdout, /Full summary: .*Sessions.*demo-session\.md/);
  assert.match(result.stdout, /Would create 1 summary, reuse 0, append 1 daily entry/);
  assert.match(result.stdout, /When you're ready: node \.\/bin\/logdig\.js backfill 1/);
  assert.doesNotMatch(result.stdout, /private-value|Make this nicer/);
  assert.deepEqual(await calls(w.callsPath), []);
  assert.equal(await readFile(w.filePath, "utf8"), before);
  await assert.rejects(readdir(w.settings.cacheDirectory), { code: "ENOENT" });
  await assert.rejects(readdir(w.settings.dailyDirectory), { code: "ENOENT" });
});

test("real CLI backfill preserves handwritten notes, gives progress, and repeats without duplicate entries or model calls", async (t) => {
  const w = await workspace(t);
  const date = await addSession(w.settings);
  const dailyPath = path.join(w.settings.dailyDirectory, `${date}.md`);
  const original = "# My day\n\nPersonal writing stays here.\n\n# Log\n\nA handwritten log.\n\n# Tomorrow\n\nDon't lose this.\n";
  await mkdir(w.settings.dailyDirectory, { recursive: true });
  await writeFile(dailyPath, original);
  const first = await runCli(["backfill", "1"], w.env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /demo-project.*summarizing with Pi/);
  assert.match(first.stdout, /Saved: 1 summary created/);
  const daily = await readFile(dailyPath, "utf8");
  for (const text of ["Personal writing stays here.", "A handwritten log.", "# Tomorrow\n\nDon't lose this."]) assert.ok(daily.includes(text));
  assert.equal((daily.match(/\[\[[a-f0-9]{64}\|/g) || []).length, 1);
  const entryId = daily.match(/\[\[([a-f0-9]{64})\|/)[1];
  const snapshot = await readFile(path.join(w.settings.cacheDirectory, "Entries", `${entryId}.md`), "utf8");
  const cache = await readFile(path.join(w.settings.cacheDirectory, "Sessions", "demo-session.md"), "utf8");
  for (const heading of ["# Small", "# Medium", "# Large"]) assert.ok(cache.includes(heading));
  assert.match(cache, /^logUsage: "\$0\.03 ⚡450 ↑120 ↓30 · \d+s"$/m);
  assert.equal(snapshot, cache);
  const second = await runCli(["backfill", "1"], w.env);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /0 summaries created, 1 reused.*1 already present/);
  const preview = await runCli(["backfill", "1", "--dry-run"], w.env);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /Would create 0 summaries, reuse 1, append 0 daily entries; 1 already present/);
  assert.equal(await readFile(dailyPath, "utf8"), daily);
  assert.equal(await readFile(path.join(w.settings.cacheDirectory, "Sessions", "demo-session.md"), "utf8"), cache);
  assert.equal(await readFile(path.join(w.settings.cacheDirectory, "Entries", `${entryId}.md`), "utf8"), snapshot);
  assert.equal((await calls(w.callsPath)).length, 1);
});

test("model failure is visible, exits nonzero, and explains how to retry without touching daily notes", async (t) => {
  const w = await workspace(t);
  await addSession(w.settings);
  const result = await runCli(["backfill", "1"], { ...w.env, LOGDIG_TEST_MODEL_ERROR: "1" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\/login/);
  assert.match(result.stderr, /rerun the same command to retry/);
  await assert.rejects(readdir(w.settings.dailyDirectory), { code: "ENOENT" });
});

test("empty history is reassuring, while missing or corrupt history reports a failure", async (t) => {
  const w = await workspace(t);
  const empty = await runCli(["backfill", "1", "--dry-run"], w.env);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /No saved sessions found/);
  await writeFile(path.join(w.settings.sessionDirectory, "broken.jsonl"), "not json");
  const corrupt = await runCli(["backfill", "1", "--dry-run"], w.env);
  assert.equal(corrupt.code, 1);
  assert.match(corrupt.stderr, /invalid JSON/);
  await rm(w.settings.sessionDirectory, { recursive: true });
  const missing = await runCli(["backfill", "1", "--dry-run"], w.env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /history folder not found/);
  assert.deepEqual(await calls(w.callsPath), []);
});

test("an out-of-range session never makes a model request and explains how to widen the preview", async (t) => {
  const w = await workspace(t);
  await addSession(w.settings, { timestamp: Date.now() - 7 * 86400_000 });
  const result = await runCli(["backfill", "1", "--dry-run"], w.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 session skipped/);
  assert.match(result.stdout, /Nothing to journal in this range/);
  assert.deepEqual(await calls(w.callsPath), []);
});

test("backfill validates empty model options and strict day counts, and other commands reject accidental arguments", async (t) => {
  const w = await workspace(t);
  for (const args of [["backfill", "--model="], ["backfill", "--model", "--dry-run"], ["backfill", "0x10"], ["backfill", "1e2"], ["backfill", "--dr-run"], ["init", "unexpected"]]) {
    const result = await runCli(args, w.env);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, /provider\/model|Choose 1 to 3650|Unknown backfill argument|does not accept arguments/);
  }
  assert.deepEqual(await calls(w.callsPath), []);
});

test("--model default clears a configured override for one run and keeps the correct ready-to-run hint", async (t) => {
  const w = await workspace(t);
  await addSession(w.settings);
  const preview = await runCli(["backfill", "1", "--dry-run", "--model", "default"], w.env);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /Model: Pi startup default/);
  assert.match(preview.stdout, /When you're ready: node \.\/bin\/logdig\.js backfill 1 --model default/);
  const actual = await runCli(["backfill", "1", "--model=default"], w.env);
  assert.equal(actual.code, 0, actual.stderr);
  assert.ok(!(await calls(w.callsPath))[0].includes("--model"));
  assert.equal((await loadSettings({ filePath: w.filePath, env: {} })).model, "test/fake");
});
