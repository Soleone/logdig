import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import journalExtension from "../src/index.js";
import { saveSettings } from "../src/settings.js";

const response = { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ small: "Made progress.", medium: "Goal and progress.", large: "A short timeline." }) }] };

async function extensionFixture(t, settingsPatch = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-extension-"));
  const settings = {
    cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), dailyHeader: "# Log", dailySummary: "small", timeZone: "UTC", sessionDirectory: path.join(root, "history"), autoCapture: false,
    ...settingsPatch,
  };
  await mkdir(settings.sessionDirectory, { recursive: true });
  const filePath = path.join(root, "settings.json");
  await saveSettings(settings, filePath);
  const keys = ["LOGDIG_CONFIG_PATH", "PI_CODING_AGENT_SESSION_DIR", "PI_JOURNAL_DIR", "PI_JOURNAL_DAILY_DIR", "PI_JOURNAL_DAILY_HEADER", "PI_JOURNAL_DAILY_SUMMARY", "PI_JOURNAL_TIMEZONE", "PI_JOURNAL_MODEL", "PI_JOURNAL_THINKING", "PI_JOURNAL_AUTO", "PI_JOURNAL_PI_COMMAND"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.LOGDIG_CONFIG_PATH = filePath;
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  });
  let command;
  let shutdown;
  journalExtension({
    registerCommand: (_name, definition) => { command = definition.handler; },
    on: (_name, handler) => { shutdown = handler; },
  });
  const notifications = [];
  const statuses = [];
  const model = { calls: 0, requests: [], complete: async () => response };
  const entries = [{ type: "message", timestamp: Date.now(), message: { role: "user", content: "Improve this project." } }];
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
    model: { provider: "test", id: "fake" },
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => true,
      complete: async (...args) => {
        model.calls++;
        model.requests.push({ method: "complete", args });
        return model.complete(...args);
      },
      streamSimple: (...args) => {
        model.calls++;
        model.requests.push({ method: "streamSimple", args });
        return { result: () => model.complete(...args) };
      },
    },
    sessionManager: {
      getHeader: () => ({ type: "session", id: "current-session", cwd: "/work/demo" }),
      getEntries: () => entries,
      getSessionFile: () => undefined,
    },
  };
  return { root, settings, ctx, entries, model, command, shutdown, notifications, statuses };
}

test("journal passes every explicit thinking level through provider-neutral requests", async (t) => {
  for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    await t.test(thinkingLevel, async (t) => {
      const f = await extensionFixture(t, { thinkingLevel });
      const signal = new AbortController().signal;
      f.ctx.signal = signal;
      await f.command("", f.ctx);
      assert.equal(f.notifications.at(-1).level, "success");
      assert.equal(f.model.calls, 1);
      const { method, args: [model, context, options] } = f.model.requests[0];
      assert.equal(method, "streamSimple");
      assert.equal(model, f.ctx.model);
      assert.equal(options.reasoning, thinkingLevel === "off" ? undefined : thinkingLevel);
      assert.equal(options.signal, signal);
      assert.equal(options.cacheRetention, "none");
      assert.ok(options.sessionId);
      assert.match(context.systemPrompt, /Do not invent/);
      assert.equal(context.messages[0].role, "user");
      await f.command("", f.ctx);
      assert.equal(f.model.calls, 1);
    });
  }
});

test("configured thinking and model apply to chunk extraction, final synthesis, backfill, and shutdown", async (t) => {
  const f = await extensionFixture(t, { model: "test/cheap", thinkingLevel: "max", autoCapture: true });
  const selected = { provider: "test", id: "cheap" };
  f.ctx.modelRegistry.find = (provider, id) => {
    assert.equal(provider, "test");
    assert.equal(id, "cheap");
    return selected;
  };
  const started = Date.now();
  for (let index = 0; index < 12; index++) {
    f.entries.push({ type: "message", timestamp: started + index * 1000, message: { role: "user", content: `Stage ${index}: ${"Detailed project work. ".repeat(110)}` } });
  }
  f.model.complete = async (_model, context) => context.messages[0].content[0].text.includes("Extract a compact factual timeline")
    ? { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ timeline: "12:00 Made progress; next steps remain." }) }] }
    : response;
  await f.command("backfill 1 --dry-run", f.ctx);
  assert.equal(f.model.calls, 0);
  assert.match(f.notifications.at(-1).message, /would create 1 summary/);
  await f.command("backfill 1", f.ctx);
  assert.equal(f.notifications.at(-1).level, "success");
  assert.ok(f.model.calls >= 3);
  assert.match(f.model.requests[0].args[1].messages[0].content[0].text, /Extract a compact factual timeline/);
  assert.match(f.model.requests.at(-1).args[1].messages[0].content[0].text, /Write three journal layers/);
  const count = f.model.calls;
  await f.command("", f.ctx);
  assert.equal(f.model.calls, count);
  f.entries.push({ type: "message", timestamp: started + 13_000, message: { role: "user", content: "Record the follow-up." } });
  await f.shutdown({}, f.ctx);
  assert.ok(f.model.calls > count);
  for (const { method, args: [model, _context, options] } of f.model.requests) {
    assert.equal(method, "streamSimple");
    assert.equal(model, selected);
    assert.equal(options.reasoning, "max");
  }
  await saveSettings({ ...f.settings, thinkingLevel: "high" }, path.join(f.root, "settings.json"));
  await f.command("backfill 1 --dry-run", f.ctx);
  assert.match(f.notifications.at(-1).message, /would create 1 summary/);
});

test("default thinking preserves existing provider requests instead of inheriting session effort", async (t) => {
  const f = await extensionFixture(t, { thinkingLevel: "default" });
  await f.command("", f.ctx);
  assert.equal(f.model.requests[0].method, "complete");
  assert.equal(Object.hasOwn(f.model.requests[0].args[2], "reasoning"), false);
});

test("an empty active session gets a useful next step, not a false save success", async (t) => {
  const f = await extensionFixture(t);
  f.entries.length = 0;
  await f.command("", f.ctx);
  assert.match(f.notifications.at(-1).message, /Nothing to journal yet.*Send a message/);
  assert.equal(f.notifications.at(-1).level, "info");
  assert.equal(f.model.calls, 0);
  assert.deepEqual(f.statuses.at(-1), { key: "logdig", text: undefined });
  await assert.rejects(readdir(f.settings.dailyDirectory), { code: "ENOENT" });
});

test("headless Pi backfill reports warning failures with a nonzero exit status", async (t) => {
  const f = await extensionFixture(t);
  f.ctx.hasUI = false;
  f.entries.length = 0;
  await writeFile(path.join(f.settings.sessionDirectory, "broken.jsonl"), "invalid json");
  const logs = [];
  const warnings = [];
  const previousLog = console.log;
  const previousWarn = console.warn;
  const previousExitCode = process.exitCode;
  console.log = (message) => logs.push(message);
  console.warn = (message) => warnings.push(message);
  try {
    await f.command("backfill 1 --dry-run", f.ctx);
    assert.equal(process.exitCode, 1);
    assert.match(warnings.join("\n"), /invalid JSON/);
    assert.match(logs.join("\n"), /Fix the issues and rerun/);
    assert.equal(f.model.calls, 0);
  } finally {
    console.log = previousLog;
    console.warn = previousWarn;
    process.exitCode = previousExitCode;
  }
});

test("Pi backfill preview works even without the configured model and never changes files", async (t) => {
  const f = await extensionFixture(t, { model: "not-installed/model" });
  f.ctx.model = undefined;
  await f.command("backfill 1 --dry-run", f.ctx);
  assert.match(f.notifications.at(-1).message, /preview: would create 1 summary/);
  assert.equal(f.notifications.at(-1).level, "info");
  assert.equal(f.model.calls, 0);
  assert.ok(f.statuses.some(({ text }) => text?.includes("demo")));
  assert.equal(f.statuses.at(-1).text, undefined);
  await assert.rejects(readdir(f.settings.cacheDirectory), { code: "ENOENT" });
  await assert.rejects(readdir(f.settings.dailyDirectory), { code: "ENOENT" });
});

test("authentication failure is actionable, clears progress, and allows a subsequent successful retry", async (t) => {
  const f = await extensionFixture(t);
  f.ctx.modelRegistry.hasConfiguredAuth = () => false;
  await f.command("", f.ctx);
  assert.equal(f.notifications.at(-1).level, "error");
  assert.match(f.notifications.at(-1).message, /Run \/login/);
  assert.equal(f.statuses.at(-1).text, undefined);
  assert.equal(f.model.calls, 0);
  f.ctx.modelRegistry.hasConfiguredAuth = () => true;
  await f.command("", f.ctx);
  assert.equal(f.notifications.at(-1).level, "success");
  assert.match(f.notifications.at(-1).message, /Saved small summary: .*\.md/);
  assert.match(f.notifications.at(-1).message, /Full summaries:/);
  assert.equal(f.model.calls, 1);
});

test("the Pi extension shows progress before the model completes and prevents overlapping saves", async (t) => {
  const f = await extensionFixture(t);
  let release;
  let started;
  const modelPending = new Promise((resolve) => { release = resolve; });
  const progressStarted = new Promise((resolve) => { started = resolve; });
  f.model.complete = () => modelPending;
  f.ctx.ui.setStatus = (key, text) => {
    f.statuses.push({ key, text });
    if (text?.includes("SUMMARIZING")) started();
  };
  const first = f.command("", f.ctx);
  try {
    await progressStarted;
    await f.command("", f.ctx);
    assert.match(f.notifications.at(-1).message, /already saving/);
    await f.shutdown({}, f.ctx);
    assert.equal(f.model.calls, 1);
  } finally {
    release(response);
    await first;
  }
  assert.equal(f.notifications.at(-1).level, "success");
  assert.ok(f.statuses.some(({ text }) => /\[1\/1\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} · demo · SUMMARIZING/.test(text || "")));
  assert.equal(f.statuses.at(-1).text, undefined);
});

test("shutdown capture reports per-session failures instead of silently swallowing them", async (t) => {
  const f = await extensionFixture(t, { autoCapture: true });
  f.model.complete = async () => ({ stopReason: "error", errorMessage: "quota exceeded", content: [] });
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    await f.shutdown({}, f.ctx);
  } finally {
    console.error = original;
  }
  assert.match(errors.join("\n"), /automatic capture needs attention.*\ncurrent-session: .*quota exceeded/);
  assert.match(errors.join("\n"), /logdig doctor/);
  assert.equal(f.statuses.at(-1).text, undefined);
  await assert.rejects(readdir(f.settings.dailyDirectory), { code: "ENOENT" });
});
