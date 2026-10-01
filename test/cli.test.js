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
  for (const args of [[], ["--help"], ["init", "--help"], ["backfill", "--help"], ["status", "--help"]]) {
    const result = await runCli(args, w.env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /backfill 1 --dry-run/);
    assert.match(result.stdout, /status \[N\|all\] \[--json\]/);
    assert.match(result.stdout, /no install needed/);
    assert.doesNotMatch(result.stdout, /Daily-notes folder \[/);
  }
  await assert.rejects(readFile(w.filePath), { code: "ENOENT" });
  assert.deepEqual(await calls(w.callsPath), []);
});

test("setup explains choices and recovers locally from invalid paths, headings, summaries, timezone, model, thinking, concurrency, and yes/no input", async (t) => {
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
    "ultra", "MAX",
    "0", "1.5", "2",
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
  assert.equal(saved.thinkingLevel, "max");
  assert.equal(saved.concurrency, 2);
  assert.match(result.stdout, /Parallel sessions:\s+2/);
  assert.match(result.stdout, /Thinking:\s+max/);
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
  const checkLines = result.stdout.split("\n").filter((line) => /^(?:OK    |WARN  |FIX   )/.test(line));
  const detailColumns = checkLines.map((line) => {
    const colon = line.indexOf(":");
    return colon + 1 + line.slice(colon + 1).match(/^ */)[0].length;
  });
  const settingsLine = result.stdout.split("\n").find((line) => line.startsWith("OK    Settings:"));
  const settingsColon = settingsLine.indexOf(":");
  detailColumns.push(settingsColon + 1 + settingsLine.slice(settingsColon + 1).match(/^ */)[0].length);
  assert.equal(new Set(detailColumns).size, 1);
  assert.match(result.stdout, /^OK    Summary cache:/m);
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
  assert.match(result.stdout, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} · demo-project/);
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

test("status reports new, logged, and stale work blocks without writes or model calls", async (t) => {
  const w = await workspace(t);
  const date = await addSession(w.settings);
  const missing = await runCli(["status", "1", "--json"], w.env);
  assert.equal(missing.code, 0, missing.stderr);
  const missingReport = JSON.parse(missing.stdout);
  assert.deepEqual(missingReport.totals, {
    scanned: 1, eligible: 1, logged: 0, stale: 0, new: 1, needsSummarizing: 1, skipped: 0, errors: 0,
  });
  assert.equal(missingReport.sessions[0].status, "new");
  assert.equal(missingReport.sessions[0].summaryStatus, "needs-summarizing");
  assert.match(missingReport.sessions[0].blockId, /^[a-f0-9]{64}$/);
  assert.deepEqual(await calls(w.callsPath), []);
  await assert.rejects(readdir(w.settings.cacheDirectory), { code: "ENOENT" });
  await assert.rejects(readdir(w.settings.dailyDirectory), { code: "ENOENT" });

  const saved = await runCli(["backfill", "1"], w.env);
  assert.equal(saved.code, 0, saved.stderr);
  const current = await runCli(["status", "1"], w.env);
  assert.equal(current.code, 0, current.stderr);
  assert.match(current.stdout, /1 work block: 1 logged, 0 stale, 0 new/);
  assert.match(current.stdout, /Everything in this timeframe is current/);

  const sessionPath = path.join(w.settings.sessionDirectory, "demo-session.jsonl");
  const originalSession = await readFile(sessionPath, "utf8");
  const changedTimestamp = Date.now();
  await writeFile(sessionPath, `${originalSession.trimEnd()}\n${JSON.stringify({
    type: "message",
    timestamp: changedTimestamp,
    message: { role: "user", content: "Also record this follow-up." },
  })}\n`);
  const dailyPath = path.join(w.settings.dailyDirectory, `${date}.md`);
  const dailyBefore = await readFile(dailyPath, "utf8");
  const changed = await runCli(["status", "1", "--json"], w.env);
  assert.equal(changed.code, 0, changed.stderr);
  const changedReport = JSON.parse(changed.stdout);
  assert.equal(changedReport.sessions[0].status, "stale");
  assert.match(changedReport.sessions[0].reason, /evidence or generation policy changed/);
  assert.equal(changedReport.sessions[0].summaryStatus, "needs-summarizing");
  assert.equal(await readFile(dailyPath, "utf8"), dailyBefore);
  assert.equal((await calls(w.callsPath)).length, 1);
});

test("CLI status distinguishes overnight stale work from a new continuation and ignores bookkeeping changes", async (t) => {
  const w = await workspace(t);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  await addSession(w.settings, { timestamp: Date.parse(`${yesterday}T22:00:00Z`) });
  assert.equal((await runCli(["backfill", "all"], w.env)).code, 0);
  const dailyPath = path.join(w.settings.dailyDirectory, `${yesterday}.md`);
  const before = await readFile(dailyPath, "utf8");
  const sessionPath = path.join(w.settings.sessionDirectory, "demo-session.jsonl");
  const original = await readFile(sessionPath, "utf8");
  const updated = [
    { type: "message", id: "overnight-result", timestamp: `${today}T02:00:00Z`, message: { role: "assistant", content: "Finished overnight.", stopReason: "stop" } },
    { type: "message", id: "resume", timestamp: `${today}T11:00:00Z`, message: { role: "user", content: "Start the next stage." } },
  ];
  await writeFile(sessionPath, `${original}\n${updated.map(JSON.stringify).join("\n")}\n`);
  const status = await runCli(["status", "1", "--json"], w.env);
  assert.equal(status.code, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.deepEqual(report.sessions.map((block) => [block.date, block.status]), [[yesterday, "stale"], [today, "new"]]);
  assert.equal(new Set(report.sessions.map((block) => block.blockId)).size, 2);
  assert.equal(report.totals.needsSummarizing, 2);
  assert.equal((await calls(w.callsPath)).length, 1);
  assert.equal(await readFile(dailyPath, "utf8"), before);
  assert.equal((await runCli(["backfill", "1"], w.env)).code, 0);
  const logged = await runCli(["status", "1"], w.env);
  assert.match(logged.stdout, /2 work blocks: 2 logged, 0 stale, 0 new/);
  assert.match(logged.stdout, /Summaries: 2 reusable, 0 work blocks need summarizing/);
  const laterDaily = await readFile(path.join(w.settings.dailyDirectory, `${today}.md`), "utf8");
  const continuation = laterDaily.match(/Continues \[\[([a-f0-9]{64})\|previous entry\]\]/)[1];
  await readFile(path.join(w.settings.cacheDirectory, "Entries", `${continuation}.md`));
  const beforeMetadata = await readFile(sessionPath, "utf8");
  await writeFile(sessionPath, `${beforeMetadata}${JSON.stringify({ type: "session_info", timestamp: `${today}T12:00:00Z`, name: "Renamed" })}\n`);
  const unchanged = JSON.parse((await runCli(["status", "1", "--json"], w.env)).stdout);
  assert.equal(unchanged.totals.logged, 2);
  assert.equal(unchanged.totals.needsSummarizing, 0);
  assert.equal((await calls(w.callsPath)).length, 3);
});

test("CLI status and preview expose missing continuation prerequisites without generating or writing summaries", async (t) => {
  const w = await workspace(t);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  await addSession(w.settings, { timestamp: Date.parse(`${yesterday}T22:00:00Z`) });
  const sessionPath = path.join(w.settings.sessionDirectory, "demo-session.jsonl");
  const original = await readFile(sessionPath, "utf8");
  await writeFile(sessionPath, `${original}\n${JSON.stringify({ type: "message", id: "resume", timestamp: `${today}T11:00:00Z`, message: { role: "user", content: "Continue." } })}\n`);
  const report = JSON.parse((await runCli(["status", "1", "--json"], w.env)).stdout);
  assert.deepEqual(report.sessions.map((block) => block.prerequisite), [true, false]);
  assert.equal(report.totals.new, 2);
  const status = await runCli(["status", "1"], w.env);
  assert.match(status.stdout, /Includes 1 earlier block needed for continuation links/);
  const preview = await runCli(["backfill", "1", "--dry-run"], w.env);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /Includes this earlier block to establish the continuation link/);
  assert.match(preview.stdout, /Would create 2 summaries/);
  assert.deepEqual(await calls(w.callsPath), []);
  await assert.rejects(readdir(w.settings.cacheDirectory), { code: "ENOENT" });
  await assert.rejects(readdir(w.settings.dailyDirectory), { code: "ENOENT" });
});

test("status reports malformed history as incomplete JSON and validates its arguments", async (t) => {
  const w = await workspace(t);
  await writeFile(path.join(w.settings.sessionDirectory, "broken.jsonl"), "not json");
  const result = await runCli(["status", "all", "--json"], w.env);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.match(report.warnings[0], /invalid JSON/);
  assert.equal(report.totals.errors, 0);
  for (const args of [["status", "0"], ["status", "1", "2"], ["status", "1", "--unknown"]]) {
    const invalid = await runCli(args, w.env);
    assert.equal(invalid.code, 1, args.join(" "));
    assert.match(invalid.stderr, /Usage: .*status|Unknown status argument/);
  }
  assert.deepEqual(await calls(w.callsPath), []);
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
  assert.match(first.stdout, /\[1\/1\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} · demo-project · SUMMARIZING/);
  assert.match(first.stdout, /\[1\/1\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} · demo-project · SAVED/);
  assert.doesNotMatch(first.stdout, /large sessions may take a few minutes/);
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

test("CLI backfill progress lists skipped sessions and uses date-first one-word statuses", async (t) => {
  const w = await workspace(t);
  await addSession(w.settings, { id: "outside-range", timestamp: Date.now() - 5 * 86400000 });
  await addSession(w.settings, { id: "in-range" });

  const result = await runCli(["backfill", "1", "--dry-run"], w.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^\[1\/2\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} · demo-project · SKIPPED$/m);
  assert.match(result.stdout, /^\[2\/2\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} · demo-project · CHECKING$/m);
  assert.match(result.stdout, /^\[2\/2\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} · demo-project · PREVIEW$/m);
});

test("CLI backfill updates an evolving session row and keeps a hand-edited blurb", async (t) => {
  const w = await workspace(t);
  const date = await addSession(w.settings);
  const first = await runCli(["backfill", "1"], w.env);
  assert.equal(first.code, 0, first.stderr);
  const dailyPath = path.join(w.settings.dailyDirectory, `${date}.md`);
  const initialDaily = await readFile(dailyPath, "utf8");
  const firstId = initialDaily.match(/\[\[([a-f0-9]{64})\|/)[1];
  const firstSnapshotPath = path.join(w.settings.cacheDirectory, "Entries", `${firstId}.md`);
  const firstSnapshot = await readFile(firstSnapshotPath, "utf8");
  await writeFile(dailyPath, initialDaily.replace("Improved the demo and verified its tests.", "My edited summary."));

  const sessionPath = path.join(w.settings.sessionDirectory, "demo-session.jsonl");
  const followup = JSON.stringify({
    type: "message",
    timestamp: Date.now(),
    message: { role: "user", content: "Add a follow-up to this same session." },
  });
  await writeFile(sessionPath, `${(await readFile(sessionPath, "utf8")).trimEnd()}\n${followup}\n`);
  const updated = await runCli(["backfill", "1"], w.env);
  assert.equal(updated.code, 0, updated.stderr);
  assert.match(updated.stdout, /updated 1 entry/);
  const daily = await readFile(dailyPath, "utf8");
  const ids = [...daily.matchAll(/\[\[([a-f0-9]{64})\|\d{2}:\d{2}\]\]/g)].map((match) => match[1]);
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], firstId);
  assert.match(daily, /My edited summary\./);
  assert.equal(await readFile(firstSnapshotPath, "utf8"), firstSnapshot);
  assert.equal((await calls(w.callsPath)).length, 2);
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

test("CLI thinking overrides are validated, previewed, passed to Pi, and do not change saved settings", async (t) => {
  const w = await workspace(t);
  await addSession(w.settings);
  await saveSettings({ ...w.settings, thinkingLevel: "high" }, w.filePath);
  for (const args of [["--thinking="], ["--thinking"], ["--thinking", "--dry-run"], ["--thinking", "ultra"]]) {
    const invalid = await runCli(["backfill", "1", ...args], w.env);
    assert.equal(invalid.code, 1, args.join(" "));
    assert.match(invalid.stderr, /thinkingLevel|--thinking requires/);
  }
  const preview = await runCli(["backfill", "1", "--dry-run", "--model", "test/other", "--thinking", "MAX"], w.env);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /Model: test\/other/);
  assert.match(preview.stdout, /Thinking: max/);
  assert.match(preview.stdout, /When you're ready: .* --model test\/other --thinking max/);
  assert.deepEqual(await calls(w.callsPath), []);
  const actual = await runCli(["backfill", "1", "--model=test/other", "--thinking=max"], w.env);
  assert.equal(actual.code, 0, actual.stderr);
  const [args] = await calls(w.callsPath);
  assert.equal(args[args.indexOf("--model") + 1], "test/other");
  assert.equal(args[args.indexOf("--thinking") + 1], "max");
  const saved = await loadSettings({ filePath: w.filePath, env: {} });
  assert.equal(saved.model, "test/fake");
  assert.equal(saved.thinkingLevel, "high");
});

test("thinking settings affect cache freshness, status, environment reporting, and can be cleared for one run", async (t) => {
  const w = await workspace(t);
  await addSession(w.settings);
  assert.equal((await runCli(["backfill", "1"], w.env)).code, 0);
  await saveSettings({ ...w.settings, thinkingLevel: "max" }, w.filePath);
  const report = JSON.parse((await runCli(["status", "1", "--json"], w.env)).stdout);
  assert.equal(report.totals.stale, 1);
  assert.equal(report.totals.needsSummarizing, 1);
  const preview = await runCli(["backfill", "1", "--dry-run"], w.env);
  assert.match(preview.stdout, /Thinking: max/);
  assert.match(preview.stdout, /Would create 1 summary, reuse 0/);
  const cleared = await runCli(["backfill", "1", "--dry-run", "--thinking", "default"], w.env);
  assert.match(cleared.stdout, /Thinking: Pi startup default/);
  assert.match(cleared.stdout, /Would create 0 summaries, reuse 1/);
  assert.match(cleared.stdout, /When you're ready: .* --thinking default/);
  const actual = await runCli(["backfill", "1", "--thinking=default", "--model=test/other"], w.env);
  assert.equal(actual.code, 0, actual.stderr);
  assert.equal((await calls(w.callsPath))[1].includes("--thinking"), false);
  const env = { ...w.env, PI_JOURNAL_THINKING: "off" };
  const config = await runCli(["config"], env);
  assert.match(config.stdout, /"thinkingLevel": "off"/);
  assert.match(config.stdout, /Environment overrides: PI_JOURNAL_THINKING/);
  const doctor = await runCli(["doctor"], env);
  assert.match(doctor.stdout, /Thinking: off/);
  const overridden = await runCli(["backfill", "1"], env);
  assert.equal(overridden.code, 0, overridden.stderr);
  const args = (await calls(w.callsPath)).at(-1);
  assert.equal(args[args.indexOf("--thinking") + 1], "off");
  const repeated = await runCli(["backfill", "1"], env);
  assert.match(repeated.stdout, /0 summaries created, 1 reused/);
  assert.equal((await loadSettings({ filePath: w.filePath, env: {} })).thinkingLevel, "max");
});

test("saved concurrency is shown by config and backfill without changing settings", async (t) => {
  const w = await workspace(t);
  await addSession(w.settings);
  await saveSettings({ ...w.settings, concurrency: 2 }, w.filePath);
  const before = await readFile(w.filePath, "utf8");
  const config = await runCli(["config"], w.env);
  assert.equal(config.code, 0, config.stderr);
  assert.match(config.stdout, /"concurrency": 2/);
  const preview = await runCli(["backfill", "1", "--dry-run"], w.env);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /Parallel sessions: 2/);
  assert.equal(await readFile(w.filePath, "utf8"), before);
  assert.deepEqual(await calls(w.callsPath), []);
  await assert.rejects(readdir(w.settings.dailyDirectory), { code: "ENOENT" });
});

test("setup can clear a saved thinking override without changing the selected model", async (t) => {
  const w = await workspace(t);
  await saveSettings({ ...w.settings, thinkingLevel: "max" }, w.filePath);
  const input = ["", "", "", "", "", "yes", "", "", "", "default", "", "no", "no", "yes"].join("\n") + "\n";
  const result = await runCli(["init"], w.env, { input });
  assert.equal(result.code, 0, result.stderr);
  const saved = await loadSettings({ filePath: w.filePath, env: {} });
  assert.equal(saved.thinkingLevel, undefined);
  assert.equal(saved.model, "test/fake");
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
