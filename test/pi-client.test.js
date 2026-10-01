import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createPiModelClient } from "../src/pi-client.js";

function jsonOutput(text, usage = { input: 12, output: 4, cacheRead: 60, cacheWrite: 0, cost: { total: 0.01 } }, stopReason = "stop") {
  return [
    { type: "session", id: "test" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage, stopReason } },
    { type: "agent_settled" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function fakeSpawn({ output = jsonOutput('{"ok":true}'), exitCode = 0, stderr = "" } = {}) {
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
        if (Array.isArray(output)) {
          for (const chunk of output) child.stdout.write(chunk);
          child.stdout.end();
        } else if (output) child.stdout.end(output);
        else child.stdout.end();
        if (stderr) child.stderr.end(stderr);
        else child.stderr.end();
        child.emit("close", exitCode, null);
      });
    });
    return child;
  };
  return { spawnProcess, getLaunch: () => launch, getInput: () => input };
}

test("Pi client makes a one-shot, no-tools, no-session request and honors model overrides", async () => {
  const fake = fakeSpawn({ output: jsonOutput('  {"small":"done"}  ') });
  const client = createPiModelClient({ piCommand: "pi-test", model: "openai/gpt-4.1" }, { spawnProcess: fake.spawnProcess });
  const result = await client.complete("redacted journal prompt");
  const launch = fake.getLaunch();

  assert.equal(result.text, '{"small":"done"}');
  assert.equal(result.usages.length, 1);
  assert.equal(result.usages[0].cacheRead, 60);
  assert.equal(launch.command, "pi-test");
  assert.deepEqual(launch.args.slice(0, 2), ["--mode", "json"]);
  assert.ok(launch.args.includes("--no-session"));
  assert.ok(launch.args.includes("--no-tools"));
  assert.ok(launch.args.includes("--no-extensions"));
  assert.ok(launch.args.includes("--no-context-files"));
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "openai/gpt-4.1");
  assert.ok(launch.args.includes("--"));
  assert.equal(fake.getInput(), "redacted journal prompt");
  assert.equal(client.modelLabel, "openai/gpt-4.1");
  assert.deepEqual(client.cachePolicy, { model: "openai/gpt-4.1" });
});

test("Pi client leaves model selection to Pi when no override is configured", async () => {
  const fake = fakeSpawn();
  const client = createPiModelClient({ piCommand: "pi" }, { spawnProcess: fake.spawnProcess });
  await client.complete("prompt");
  assert.equal(fake.getLaunch().args.includes("--model"), false);
  assert.equal(client.modelLabel, "Pi startup default");
  assert.deepEqual(client.cachePolicy, { model: "Pi default" });
});

test("Pi client aggregates completed responses and rejects failed JSON runs", async () => {
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, cost: { total: 0.02 } };
  const output = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "previous" }], usage, stopReason: "stop" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"small":"done"}' }], usage, stopReason: "stop" } },
    { type: "agent_settled" },
  ].map(JSON.stringify).join("\n") + "\n";
  const good = fakeSpawn({ output });
  const result = await createPiModelClient({ piCommand: "pi" }, { spawnProcess: good.spawnProcess }).complete("prompt");
  assert.equal(result.text, '{"small":"done"}');
  assert.equal(result.usages.length, 2);
  const error = fakeSpawn({ output: jsonOutput("", usage, "error") });
  await assert.rejects(createPiModelClient({ piCommand: "pi" }, { spawnProcess: error.spawnProcess }).complete("prompt"), /Pi summarization error/);
  const incomplete = fakeSpawn({ output: output.replace('{"type":"agent_settled"}\n', "") });
  await assert.rejects(createPiModelClient({ piCommand: "pi" }, { spawnProcess: incomplete.spawnProcess }).complete("prompt"), /incomplete JSON events/);
});

test("Pi client handles JSON lines split across UTF-8 byte boundaries", async () => {
  const bytes = Buffer.from(jsonOutput('{"small":"café"}'));
  const accent = bytes.indexOf(Buffer.from("é"));
  const fake = fakeSpawn({ output: [bytes.subarray(0, accent + 1), bytes.subarray(accent + 1)] });
  const result = await createPiModelClient({ piCommand: "pi" }, { spawnProcess: fake.spawnProcess }).complete("prompt");
  assert.equal(result.text, '{"small":"café"}');
});

test("Pi client returns a useful error when the subprocess fails", async () => {
  const fake = fakeSpawn({ output: "", exitCode: 1, stderr: "not authenticated" });
  const client = createPiModelClient({ piCommand: "pi" }, { spawnProcess: fake.spawnProcess });
  await assert.rejects(client.complete("prompt"), /Pi summarization failed with exit code 1: not authenticated/);
});
