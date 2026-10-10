import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { editConfig } from "../src/config-menu.js";
import { collectSessions } from "../src/session-runner.js";
import { environmentOverrides, loadSettings, saveSettings } from "../src/settings.js";

function claudeSession(sessionId, timestamp) {
  return [
    { type: "mode", mode: "normal", sessionId },
    { type: "user", uuid: `${sessionId}-user`, sessionId, cwd: "/work/demo", timestamp, message: { role: "user", content: "Record this work" } },
  ].map((record) => JSON.stringify(record)).join("\n");
}

test("Claude Code history is read only when its folder is configured, and subagent transcripts are skipped", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-claude-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const piSessions = path.join(root, "pi-sessions");
  const claudeProjects = path.join(root, "claude", "projects");
  const projectPath = path.join(claudeProjects, "-work-demo");
  await mkdir(piSessions);
  await mkdir(path.join(projectPath, "claude-session", "subagents"), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(path.join(projectPath, "claude-session.jsonl"), claudeSession("claude-session", now));
  await writeFile(path.join(projectPath, "claude-session", "subagents", "agent-1.jsonl"), claudeSession("subagent-session", now));

  const off = await collectSessions({ sessionDirectory: piSessions, timeZone: "UTC" });
  assert.deepEqual(off.sessions.map((session) => session.header.id), []);

  const on = await collectSessions({ sessionDirectory: piSessions, claudeSessionDirectory: claudeProjects, timeZone: "UTC" });
  assert.deepEqual(on.sessions.map((session) => session.header.id), ["claude-session"]);
  assert.deepEqual(on.warnings, []);
});

test("a missing Claude Code folder gets its own warning instead of the Pi one", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-claude-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const piSessions = path.join(root, "pi-sessions");
  await mkdir(piSessions);
  const missing = path.join(root, "nowhere");

  const result = await collectSessions({ sessionDirectory: piSessions, claudeSessionDirectory: missing, timeZone: "UTC" });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^Claude Code history folder not found: .*nowhere\. Check it with 'logdig config', or set it to off\./);
});

test("the Claude Code folder is saved, expanded, and can be set from the environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-claude-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "settings.json");
  const required = { cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), timeZone: "UTC" };

  assert.equal((await loadSettings({ filePath, env: {}, home: root })).claudeSessionDirectory, undefined);
  await saveSettings({ ...required, claudeSessionDirectory: path.join(root, "claude", "projects") }, filePath);
  assert.equal((await loadSettings({ filePath, env: {}, home: root })).claudeSessionDirectory, path.join(root, "claude", "projects"));

  const fromEnvironment = await loadSettings({ filePath, env: { PI_JOURNAL_CLAUDE_SESSION_DIR: path.join(root, "other") }, home: root });
  assert.equal(fromEnvironment.claudeSessionDirectory, path.join(root, "other"));
  assert.deepEqual(environmentOverrides({ PI_JOURNAL_CLAUDE_SESSION_DIR: "/x" }), ["PI_JOURNAL_CLAUDE_SESSION_DIR"]);
});

test("typing off in the config menu turns Claude Code history off, and auto restores the default", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-claude-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "settings.json");
  const required = { cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), timeZone: "UTC" };
  await saveSettings({ ...required, claudeSessionDirectory: path.join(root, "claude") }, filePath);

  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  input.end(["claudeSessionDirectory", "off", "q"].join("\n") + "\n");
  await editConfig("logdig", { input, output, env: { LOGDIG_CONFIG_PATH: filePath } });

  assert.equal((await loadSettings({ filePath, env: {} })).claudeSessionDirectory, false);

  const restore = new PassThrough();
  restore.end(["claudeSessionDirectory", "auto", "q"].join("\n") + "\n");
  await editConfig("logdig", { input: restore, output, env: { LOGDIG_CONFIG_PATH: filePath } });
  assert.equal((await loadSettings({ filePath, env: {} })).claudeSessionDirectory, undefined);
});
