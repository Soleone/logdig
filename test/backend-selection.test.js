import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandAvailable } from "../src/command-process.js";
import { claudeHistoryDirectory } from "../src/session-sources.js";
import { resolveSummaryBackend } from "../src/summary-backends.js";
import { saveSettings } from "../src/settings.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "logdig.js");

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: packageRoot, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`CLI timed out: ${args.join(" ")}`)); }, 20_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end();
  });
}

test("the Claude Code folder is found automatically when it exists, and off or explicit folders win", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-claude-folder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: path.join(root, "config") };

  assert.equal(await claudeHistoryDirectory({}, { env }), undefined, "absent default folder is skipped silently");
  await mkdir(path.join(root, "config", "projects"), { recursive: true });
  assert.equal(await claudeHistoryDirectory({}, { env }), path.join(root, "config", "projects"));
  assert.equal(await claudeHistoryDirectory({ claudeSessionDirectory: false }, { env }), undefined);
  assert.equal(await claudeHistoryDirectory({ claudeSessionDirectory: path.join(root, "elsewhere") }, { env }), path.join(root, "elsewhere"), "explicit folders are used even when missing, so the user hears about it");
});

test("auto uses Pi when Pi is installed, Claude Code when only it is, and pinned backends never change", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-resolve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = path.join(root, "installed");
  await writeFile(installed, "#!/bin/sh\n");
  await chmod(installed, 0o755);
  const missing = path.join(root, "missing");

  assert.equal(await resolveSummaryBackend({ summaryBackend: "auto", piCommand: installed, claudeCommand: installed }), "pi");
  assert.equal(await resolveSummaryBackend({ summaryBackend: "auto", piCommand: missing, claudeCommand: installed }), "claude");
  assert.equal(await resolveSummaryBackend({ summaryBackend: "auto", piCommand: missing, claudeCommand: missing }), "pi", "with neither installed, Pi's existing error still explains what to do");
  assert.equal(await resolveSummaryBackend({ summaryBackend: "claude", piCommand: installed, claudeCommand: missing }), "claude");
});

test("command availability checks executable paths and bare names on PATH", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tool = path.join(root, "tool");
  await writeFile(tool, "#!/bin/sh\n");
  await chmod(tool, 0o755);
  await writeFile(path.join(root, "notexecutable"), "text");

  assert.equal(await commandAvailable(tool), true);
  assert.equal(await commandAvailable(path.join(root, "absent")), false);
  assert.equal(await commandAvailable("tool", { env: { PATH: root }, platform: "linux" }), true);
  assert.equal(await commandAvailable("notexecutable", { env: { PATH: root }, platform: "linux" }), false);
});

test("one backfill summarizes Pi and Claude Code sessions together with no backend setting", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-mixed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const callsPath = path.join(root, "pi-calls.txt");
  const fakePi = path.join(root, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(callsPath)}, "call\\n");
  const summary = { small: "Summary from the shared pipeline.", medium: "## Outcome\\nDone.\\n\\n## Detail\\nRan.", large: "## Work log\\nRan.\\n\\n## Result\\nDone." };
  const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify(summary) }], provider: "fake", model: "fake", stopReason: "stop" };
  process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n" + JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`);
  await chmod(fakePi, 0o755);

  const now = Date.now();
  const piFolder = path.join(root, "pi-sessions", "--work-pi-demo--");
  await mkdir(piFolder, { recursive: true });
  await writeFile(path.join(piFolder, "pi-session.jsonl"), [
    { type: "session", version: 3, id: "pi-session", cwd: "/work/pi-demo", timestamp: new Date(now - 60_000).toISOString() },
    { type: "message", timestamp: now - 60_000, message: { role: "user", content: "Fix the Pi parser" } },
  ].map((record) => JSON.stringify(record)).join("\n"));

  const claudeFolder = path.join(root, "claude-config", "projects", "-work-claude-demo");
  await mkdir(claudeFolder, { recursive: true });
  await writeFile(path.join(claudeFolder, "claude-session.jsonl"), [
    { type: "user", uuid: "u1", sessionId: "claude-session", cwd: "/work/claude-demo", timestamp: new Date(now - 60_000).toISOString(), message: { role: "user", content: "Add the Claude history" } },
    { type: "assistant", uuid: "a1", sessionId: "claude-session", cwd: "/work/claude-demo", timestamp: new Date(now - 50_000).toISOString(), message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Added it." }], usage: { input_tokens: 5, output_tokens: 3 }, stop_reason: "end_turn" } },
  ].map((record) => JSON.stringify(record)).join("\n"));

  const filePath = path.join(root, "settings.json");
  // Only the commands and folders are set. The backend, the Claude folder, and the models stay at their defaults.
  await saveSettings({
    cacheDirectory: path.join(root, "vault", "LogDig"), dailyDirectory: path.join(root, "vault", "Daily"), timeZone: "UTC",
    sessionDirectory: path.join(root, "pi-sessions"), piCommand: fakePi, claudeCommand: path.join(root, "no-claude"),
  }, filePath);

  const result = await runCli(["backfill", "3"], { ...process.env, LOGDIG_CONFIG_PATH: filePath, CLAUDE_CONFIG_DIR: path.join(root, "claude-config") });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Saved: 2 summaries created/);
  assert.equal((await readFile(callsPath, "utf8")).split("\n").filter(Boolean).length, 2, "both sources go through Pi when it is installed");

  const notes = await readdir(path.join(root, "vault", "LogDig", "Sessions"));
  const frontmatters = await Promise.all(notes.map((name) => readFile(path.join(root, "vault", "LogDig", "Sessions", name), "utf8")));
  assert.ok(frontmatters.some((text) => /^agent: pi$/m.test(text) && /^type: "pi-session-journal"$/m.test(text)));
  assert.ok(frontmatters.some((text) => /^agent: claude-code$/m.test(text) && /^type: "claude-code-session-journal"$/m.test(text)));

  const daily = await readFile(path.join(root, "vault", "Daily", (await readdir(path.join(root, "vault", "Daily")))[0]), "utf8");
  assert.match(daily, /## pi-demo/);
  assert.match(daily, /## claude-demo/);
});
