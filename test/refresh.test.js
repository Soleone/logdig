import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

test("backfill --force regenerates the selected days; plain reruns and thinking changes keep saved summaries", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const callsPath = path.join(root, "calls.txt");
  const fakePi = path.join(root, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(callsPath)}, "call\\n");
  const summary = { small: "Refreshed summary.", medium: "## Outcome\\nDone.\\n\\n## Detail\\nRan.", large: "## Work log\\nRan.\\n\\n## Result\\nDone." };
  const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify(summary) }], provider: "fake", model: "fake", stopReason: "stop" };
  process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n" + JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`);
  await chmod(fakePi, 0o755);

  const sessions = path.join(root, "pi-sessions", "--work-demo--");
  await mkdir(sessions, { recursive: true });
  const now = Date.now();
  await writeFile(path.join(sessions, "demo.jsonl"), [
    { type: "session", version: 3, id: "demo-session", cwd: "/work/demo", timestamp: new Date(now - 60_000).toISOString() },
    { type: "message", timestamp: now - 60_000, message: { role: "user", content: "Refresh me" } },
  ].map((record) => JSON.stringify(record)).join("\n"));

  const filePath = path.join(root, "settings.json");
  await saveSettings({
    cacheDirectory: path.join(root, "vault", "LogDig"), dailyDirectory: path.join(root, "vault", "Daily"), timeZone: "UTC",
    sessionDirectory: path.join(root, "pi-sessions"), claudeSessionDirectory: false, piCommand: fakePi, summaryBackend: "pi",
  }, filePath);
  const env = { ...process.env, LOGDIG_CONFIG_PATH: filePath };

  assert.equal((await runCli(["backfill", "3"], env)).code, 0);
  const rerun = await runCli(["backfill", "3", "--dry-run"], env);
  assert.match(rerun.stdout, /Would create 0 summaries, reuse 1/);

  const thinking = await runCli(["backfill", "3", "--dry-run", "--thinking", "low"], env);
  assert.equal(thinking.code, 0, thinking.stderr);
  assert.match(thinking.stdout, /Would create 0 summaries, reuse 1/);

  const forced = await runCli(["backfill", "3", "--dry-run", "--force"], env);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /Would create 1 summary, reuse 0/);

  const saved = await runCli(["backfill", "3", "--force"], env);
  assert.equal(saved.code, 0, saved.stderr);
  assert.match(saved.stdout, /Saved: 1 summary created/);
});
