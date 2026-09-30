import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import journalExtension from "../src/index.js";
import { saveSettings } from "../src/settings.js";

const environmentKeys = [
  "LOGDIG_CONFIG_PATH",
  "PI_JOURNAL_MODEL",
  "PI_JOURNAL_PI_COMMAND",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_JOURNAL_DIR",
  "PI_JOURNAL_DAILY_DIR",
  "PI_JOURNAL_DAILY_HEADER",
  "PI_JOURNAL_DAILY_SUMMARY",
  "PI_JOURNAL_TIMEZONE",
  "PI_JOURNAL_AUTO",
];

test("journal command appends the chosen layer under the configured header at the last user time", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-command-test-"));
  const cacheDirectory = path.join(root, "LogDig");
  const dailyDirectory = path.join(root, "My Daily Notes");
  await mkdir(dailyDirectory, { recursive: true });
  await writeFile(path.join(dailyDirectory, "2026-09-28.md"), "# 2026-09-28\n\nMy existing note.\n\n# Log\n\nHandwritten content.\n", "utf8");
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  Object.assign(process.env, {
    LOGDIG_CONFIG_PATH: path.join(root, "settings.json"),
    PI_JOURNAL_DIR: cacheDirectory,
    PI_JOURNAL_DAILY_DIR: dailyDirectory,
    PI_JOURNAL_DAILY_HEADER: "# Log",
    PI_JOURNAL_DAILY_SUMMARY: "medium",
    PI_JOURNAL_TIMEZONE: "America/New_York",
  });

  let command;
  let modelCalls = 0;
  const notifications = [];
  const header = { type: "session", id: "session-one", cwd: "/work/example-project" };
  const entries = [
    {
      type: "message",
      id: "user-one",
      parentId: null,
      timestamp: "2026-09-28T02:01:00.000Z",
      message: { role: "user", content: "Start the work" },
    },
    {
      type: "message",
      id: "assistant-one",
      parentId: "user-one",
      timestamp: "2026-09-28T02:02:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Started." }], stopReason: "stop" },
    },
    {
      type: "message",
      id: "user-two",
      parentId: "assistant-one",
      timestamp: "2026-09-28T04:01:00.000Z",
      message: { role: "user", content: "Finish and report" },
    },
    {
      type: "message",
      id: "assistant-two",
      parentId: "user-two",
      timestamp: "2026-09-28T04:02:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Finished." }], stopReason: "stop" },
    },
  ];
  const layers = {
    small: "Short layer should not be inserted.",
    medium: "- **Goal:** Finish the task.\n- **Status:** Done.",
    large: "Long layer should remain cached but not be inserted.",
  };
  const pi = {
    registerCommand: (_name, definition) => { command = definition.handler; },
    on: () => {},
  };
  journalExtension(pi);
  const ctx = {
    hasUI: true,
    ui: { notify: (message) => notifications.push(message) },
    sessionManager: {
      getHeader: () => header,
      getEntries: () => entries,
      getSessionFile: () => undefined,
    },
    model: { provider: "test", id: "fake" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async () => {
        modelCalls++;
        return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(layers) }], usage: {
          input: 70, output: 10, cacheRead: 300, cacheWrite: 0, cost: { total: 0.03 },
        } };
      },
    },
  };

  try {
    await command("", ctx);
    assert.match(notifications.at(-1), /2026-09-28/);
    assert.equal(modelCalls, 1);

    const daily = await readFile(path.join(dailyDirectory, "2026-09-28.md"), "utf8");
    assert.ok(daily.includes("My existing note."));
    assert.ok(daily.includes("Handwritten content."));
    assert.match(daily, /## example-project\n\n\*\*\[\[[a-f0-9]{64}\|00:01\]\]\*\*/);
    assert.ok(daily.includes("- **Goal:** Finish the task."));
    assert.ok(!daily.includes("Short layer should not be inserted."));
    assert.ok(!daily.includes("Long layer should remain cached"));
    const id = daily.match(/\[\[([a-f0-9]{64})\|00:01\]\]/)[1];
    const detailed = await readFile(path.join(cacheDirectory, "Entries", `${id}.md`), "utf8");
    assert.match(detailed, /^logUsage: "\$0\.03 ⚡300 ↑70 ↓10 · \d+s"$/m);

    await command("", ctx);
    assert.equal(modelCalls, 1);
    const repeated = await readFile(path.join(dailyDirectory, "2026-09-28.md"), "utf8");
    assert.equal((repeated.match(/\[\[[a-f0-9]{64}\|/g) || []).length, 1);
    assert.deepEqual(await readdir(path.join(cacheDirectory, "Sessions")), ["session-one.md"]);
  } finally {
    for (const key of environmentKeys) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});
