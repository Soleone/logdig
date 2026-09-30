import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createPiModelClient } from "../src/pi-client.js";

function fakeSpawn({ output = "{\"ok\":true}", exitCode = 0, stderr = "" } = {}) {
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
        if (output) child.stdout.end(output);
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
  const fake = fakeSpawn({ output: "  {\"small\":\"done\"}  " });
  const client = createPiModelClient({ piCommand: "pi-test", model: "openai/gpt-4.1" }, { spawnProcess: fake.spawnProcess });
  const result = await client.complete("redacted journal prompt");
  const launch = fake.getLaunch();

  assert.equal(result, "{\"small\":\"done\"}");
  assert.equal(launch.command, "pi-test");
  assert.ok(launch.args.includes("--print"));
  assert.ok(launch.args.includes("--no-session"));
  assert.ok(launch.args.includes("--no-tools"));
  assert.ok(launch.args.includes("--no-extensions"));
  assert.ok(launch.args.includes("--no-context-files"));
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "openai/gpt-4.1");
  assert.ok(launch.args.includes("--"));
  assert.equal(fake.getInput(), "redacted journal prompt");
  assert.equal(client.modelLabel, "openai/gpt-4.1");
});

test("Pi client leaves model selection to Pi when no override is configured", async () => {
  const fake = fakeSpawn();
  const client = createPiModelClient({ piCommand: "pi" }, { spawnProcess: fake.spawnProcess });
  await client.complete("prompt");
  assert.equal(fake.getLaunch().args.includes("--model"), false);
  assert.equal(client.modelLabel, "Pi startup default");
});

test("Pi client returns a useful error when the subprocess fails", async () => {
  const fake = fakeSpawn({ output: "", exitCode: 1, stderr: "not authenticated" });
  const client = createPiModelClient({ piCommand: "pi" }, { spawnProcess: fake.spawnProcess });
  await assert.rejects(client.complete("prompt"), /Pi summarization failed with exit code 1: not authenticated/);
});
