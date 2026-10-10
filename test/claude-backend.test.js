import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, saveSettings, validateSettings } from "../src/settings.js";

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

const base = { cacheDirectory: "/cache", dailyDirectory: "/daily", dailyHeader: "# Projects", piCommand: "pi", timeZone: "UTC" };

test("each summary backend validates its own model and effort formats", () => {
  assert.equal(validateSettings({ ...base, summaryBackend: "claude", model: " haiku " }).model, "haiku");
  assert.equal(validateSettings({ ...base, summaryBackend: "claude", model: "claude-haiku-5-5" }).model, "claude-haiku-5-5");
  assert.throws(() => validateSettings({ ...base, summaryBackend: "claude", model: "openai/gpt-4.1" }), /Claude Code alias such as haiku/);
  assert.throws(() => validateSettings({ ...base, summaryBackend: "claude", model: "--tools" }), /Claude Code alias such as haiku/);
  assert.throws(() => validateSettings({ ...base, summaryBackend: "claude", thinkingLevel: "off" }), /With Claude Code, thinkingLevel/);
  assert.equal(validateSettings({ ...base, summaryBackend: "claude", thinkingLevel: "MAX" }).thinkingLevel, "max");
  assert.throws(() => validateSettings({ ...base, summaryBackend: "pi", model: "haiku" }), /provider\/model format/);
  assert.equal(validateSettings({ ...base, summaryBackend: "pi", model: "openai/gpt-4.1" }).model, "openai/gpt-4.1");
  assert.equal(validateSettings({ ...base, summaryBackend: "Claude" }).summaryBackend, "claude");
  assert.throws(() => validateSettings({ ...base, summaryBackend: "gemini" }), /summaryBackend must be auto, pi, or claude/);
  // auto cannot know the backend yet, so a model is accepted in either format and checked again when summaries start.
  assert.equal(validateSettings({ ...base, summaryBackend: "auto", model: "haiku" }).model, "haiku");
  assert.equal(validateSettings({ ...base, summaryBackend: "auto", model: "openai/gpt-4.1" }).model, "openai/gpt-4.1");
});

test("summaries default to auto, and the Claude Code command can come from the environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-backend-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "settings.json");

  const defaults = await loadSettings({ filePath, env: {}, home: root });
  assert.equal(defaults.summaryBackend, "auto");
  assert.equal(defaults.claudeCommand, "claude");

  const fromEnvironment = await loadSettings({
    filePath, env: { PI_JOURNAL_SUMMARY_BACKEND: "claude", PI_JOURNAL_CLAUDE_COMMAND: "/opt/claude" }, home: root,
  });
  assert.equal(fromEnvironment.summaryBackend, "claude");
  assert.equal(fromEnvironment.claudeCommand, "/opt/claude");

  await saveSettings({ ...base, cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), summaryBackend: "claude", model: "sonnet" }, filePath);
  const saved = await loadSettings({ filePath, env: {}, home: root });
  assert.equal(saved.summaryBackend, "claude");
  assert.equal(saved.model, "sonnet");
});

test("doctor checks only the chosen backend's command", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-backend-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeClaude = path.join(root, "fake-claude");
  await writeFile(fakeClaude, "#!/bin/sh\necho '9.9.9 (Claude Code)'\n");
  await chmod(fakeClaude, 0o755);
  const filePath = path.join(root, "settings.json");
  await mkdir(path.join(root, "sessions"));
  await saveSettings({
    cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), timeZone: "UTC",
    sessionDirectory: path.join(root, "sessions"), summaryBackend: "claude", claudeCommand: fakeClaude, piCommand: path.join(root, "no-pi"),
  }, filePath);

  const result = await runCli(["doctor"], { ...process.env, LOGDIG_CONFIG_PATH: filePath });

  assert.match(result.stdout, /Claude Code:\s+9\.9\.9 \(Claude Code\)/);
  assert.doesNotMatch(result.stdout + result.stderr, /Pi:\s/);
  assert.match(result.stdout, /Authentication is checked only when you request a summary\. If it fails, start 'claude'/);
});

test("a Claude-only backfill summarizes Claude Code sessions with the claude command", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-claude-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const argsPath = path.join(root, "claude-args.json");
  const fakeClaude = path.join(root, "fake-claude.mjs");
  await writeFile(fakeClaude, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const summary = { small: "Worked on the Claude backend.", medium: "## Outcome\\nWorked on it.\\n\\n## Detail\\nRan tests.", large: "## Work log\\nRan tests.\\n\\n## Result\\nDone." };
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(summary), total_cost_usd: 0.002, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: { "claude-haiku-5-5": {} } }));
});
`);
  await chmod(fakeClaude, 0o755);

  const claudeProjects = path.join(root, "claude", "projects", "-work-claude-demo");
  await mkdir(claudeProjects, { recursive: true });
  const now = Date.now();
  const sessionId = "claude-only-session";
  await writeFile(path.join(claudeProjects, `${sessionId}.jsonl`), [
    { type: "user", uuid: "u1", sessionId, cwd: "/work/claude-demo", timestamp: new Date(now - 60_000).toISOString(), message: { role: "user", content: "Add the Claude backend" } },
    { type: "assistant", uuid: "a1", sessionId, cwd: "/work/claude-demo", timestamp: new Date(now - 50_000).toISOString(), message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Added it and ran the tests." }], usage: { input_tokens: 5, output_tokens: 6 }, stop_reason: "end_turn" } },
  ].map((record) => JSON.stringify(record)).join("\n"));

  await mkdir(path.join(root, "pi-empty"));
  const filePath = path.join(root, "settings.json");
  await saveSettings({
    cacheDirectory: path.join(root, "vault", "LogDig"), dailyDirectory: path.join(root, "vault", "Daily"), timeZone: "UTC",
    sessionDirectory: path.join(root, "pi-empty"), claudeSessionDirectory: path.join(root, "claude", "projects"),
    summaryBackend: "claude", claudeCommand: fakeClaude, model: "haiku", thinkingLevel: "high",
    piCommand: path.join(root, "no-pi"),
  }, filePath);
  const env = { ...process.env, LOGDIG_CONFIG_PATH: filePath };

  const first = await runCli(["backfill", "3"], env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Saved: 1 summary created/);
  assert.doesNotMatch(first.stdout + first.stderr, /Pi/);

  const args = JSON.parse(await readFile(argsPath, "utf8"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.equal(args[args.indexOf("--effort") + 1], "high");

  const [note] = await readdir(path.join(root, "vault", "Daily"));
  const daily = await readFile(path.join(root, "vault", "Daily", note), "utf8");
  assert.match(daily, /## claude-demo/);
  assert.match(daily, /Worked on the Claude backend\./);

  const second = await runCli(["backfill", "3"], env);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Saved: 0 summaries created, 1 reused/);
});
