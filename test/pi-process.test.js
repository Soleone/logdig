import test from "node:test";
import assert from "node:assert/strict";
import { spawnPiProcess } from "../src/pi-process.js";

test("Pi process launcher wraps Windows batch commands and quotes each argument", () => {
  let launch;
  spawnPiProcess("C:\\Program Files\\Pi\\pi.cmd", ["--print", "journal system prompt"], { stdio: "pipe" }, {
    platform: "win32",
    spawnProcess: (...args) => { launch = args; return "child"; },
  });

  assert.equal(launch[0], "cmd.exe");
  assert.deepEqual(launch[1].slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.equal(launch[1][4], '""C:\\Program Files\\Pi\\pi.cmd" "--print" "journal system prompt""');
  assert.equal(launch[2].windowsVerbatimArguments, true);
  assert.equal(launch[2].stdio, "pipe");
});

test("Pi process launcher rejects Windows command text that could escape argument quoting", () => {
  assert.throws(() => spawnPiProcess("pi", ["--model", "provider/model%PATH%"], {}, {
    platform: "win32",
    spawnProcess: () => assert.fail("unsafe command should not spawn"),
  }), /percent signs/);
});

test("Pi process launcher passes native argument arrays through on other platforms", () => {
  const args = ["--print", "prompt with spaces"];
  let launch;
  const result = spawnPiProcess("pi", args, { stdio: "pipe" }, {
    platform: "linux",
    spawnProcess: (...values) => { launch = values; return "child"; },
  });
  assert.equal(result, "child");
  assert.deepEqual(launch, ["pi", args, { stdio: "pipe" }]);
});
