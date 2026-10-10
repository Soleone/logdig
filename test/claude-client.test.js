import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import { PassThrough } from "node:stream";
import { JOURNAL_SYSTEM_PROMPT } from "../src/journal.js";
import { claudeArguments, createClaudeModelClient } from "../src/claude-client.js";

function envelope(result = '{"small":"done"}', overrides = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    total_cost_usd: 0.0042,
    usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 60, cache_creation_input_tokens: 7 },
    modelUsage: { "claude-haiku-5-5": { inputTokens: 12 } },
    ...overrides,
  });
}

function fakeSpawn({ output = envelope(), exitCode = 0, stderr = "", error } = {}) {
  let launch;
  let input = "";
  const spawnProcess = (command, args, options) => {
    launch = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.on("data", (chunk) => { input += chunk.toString("utf8"); });
    child.stdin.once("finish", () => {
      queueMicrotask(() => {
        if (error) {
          child.emit("error", Object.assign(new Error(error), { code: "ENOENT" }));
          return;
        }
        child.stdout.end(output);
        child.stderr.end(stderr);
        child.emit("close", exitCode, null);
      });
    });
    return child;
  };
  return { spawnProcess, getLaunch: () => launch, getInput: () => input };
}

test("Claude Code arguments make a one-shot, no-tools request that leaves no transcript", () => {
  const args = claudeArguments({ model: "haiku", thinkingLevel: "high" });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.ok(args.includes("--print"));
  assert.equal(flag("--output-format"), "json");
  assert.ok(args.includes("--no-session-persistence"), "summary calls must not become journal input");
  assert.equal(flag("--tools"), "", "summaries get no tools");
  assert.ok(args.includes("--disable-slash-commands"));
  assert.equal(flag("--setting-sources"), "project,local", "user hooks and settings stay out of summary calls");
  assert.equal(flag("--system-prompt"), JOURNAL_SYSTEM_PROMPT);
  assert.equal(flag("--model"), "haiku");
  assert.equal(flag("--effort"), "high");
});

test("Claude Code arguments omit overrides that were not chosen", () => {
  const args = claudeArguments({});
  assert.equal(args.includes("--model"), false);
  assert.equal(args.includes("--effort"), false);
});

test("Claude Code client sends the prompt on stdin and normalizes the reply and usage", async () => {
  const fake = fakeSpawn({ output: envelope('  {"small":"done"}  ') });
  const client = createClaudeModelClient({ claudeCommand: "claude-test", model: "haiku" }, { spawnProcess: fake.spawnProcess });

  const reply = await client.complete("journal evidence");

  assert.equal(fake.getLaunch().command, "claude-test");
  assert.equal(fake.getLaunch().options.cwd, os.tmpdir());
  assert.equal(fake.getInput(), "journal evidence");
  assert.equal(reply.text, '{"small":"done"}');
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.model, "claude-haiku-5-5");
  assert.deepEqual(reply.usages, [{
    input: 12, output: 4, cacheRead: 60, cacheWrite: 7, cost: { total: 0.0042 },
  }]);
  assert.equal(client.modelLabel, "haiku");
  assert.deepEqual(client.cachePolicy, { model: "haiku" });
});

test("Claude Code client labels its default model distinctly from Pi's", () => {
  const client = createClaudeModelClient({});
  assert.equal(client.modelLabel, "Claude Code default");
  assert.deepEqual(client.cachePolicy, { model: "Claude Code default" });
});

test("a failed Claude Code call reports its API status and message even with a non-zero exit", async () => {
  const fake = fakeSpawn({
    output: envelope("Rate limit reached", { subtype: "error_during_execution", is_error: true, api_error_status: 429 }),
    exitCode: 1,
  });
  const client = createClaudeModelClient({}, { spawnProcess: fake.spawnProcess });
  await assert.rejects(client.complete("prompt"), /Claude Code summarization error_during_execution \(API status 429\): Rate limit reached/);
});

test("non-zero exits without a JSON reply show stderr", async () => {
  const fake = fakeSpawn({ output: "", exitCode: 2, stderr: "not logged in" });
  const client = createClaudeModelClient({}, { spawnProcess: fake.spawnProcess });
  await assert.rejects(client.complete("prompt"), /failed with exit code 2: not logged in/);
});

test("a successful exit with unreadable output is an invalid reply", async () => {
  const fake = fakeSpawn({ output: "not json" });
  const client = createClaudeModelClient({}, { spawnProcess: fake.spawnProcess });
  await assert.rejects(client.complete("prompt"), /returned invalid JSON/);
});

test("a missing Claude Code command is reported by name", async () => {
  const fake = fakeSpawn({ error: "spawn claude-missing ENOENT" });
  const client = createClaudeModelClient({ claudeCommand: "claude-missing" }, { spawnProcess: fake.spawnProcess });
  await assert.rejects(client.complete("prompt"), /Could not start Claude Code at 'claude-missing'/);
});
