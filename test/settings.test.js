import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { environmentOverrides, loadSettings, saveSettings, settingsFilePath, validateSettings } from "../src/settings.js";

test("settings use the standard per-machine config location for each OS", () => {
  assert.equal(
    settingsFilePath({ platform: "linux", env: { XDG_CONFIG_HOME: "/cfg" }, home: "/home/person" }),
    "/cfg/logdig/settings.json",
  );
  assert.equal(
    settingsFilePath({ platform: "darwin", env: {}, home: "/Users/person" }),
    "/Users/person/Library/Application Support/LogDig/settings.json",
  );
  assert.equal(
    settingsFilePath({ platform: "win32", env: { APPDATA: "C:\\Users\\person\\AppData\\Roaming" }, home: "C:\\Users\\person" }),
    path.join("C:\\Users\\person\\AppData\\Roaming", "LogDig", "settings.json"),
  );
});

test("new settings default to Projects while saved headings and overrides remain explicit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-project-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "settings.json");
  const initial = await loadSettings({ filePath, env: {}, home: root });
  assert.equal(initial.dailyHeader, "# Projects");
  const required = { cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), timeZone: "UTC" };
  await saveSettings(required, filePath);
  assert.equal((await loadSettings({ filePath, env: {}, home: root })).dailyHeader, "# Projects");
  await saveSettings({ ...required, dailyHeader: "# Log" }, filePath);
  assert.equal((await loadSettings({ filePath, env: {}, home: root })).dailyHeader, "# Log");
  assert.equal((await loadSettings({ filePath, env: { PI_JOURNAL_DAILY_HEADER: "## Custom" }, home: root })).dailyHeader, "## Custom");
});

test("settings round-trip without storing credentials and environment values override them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-settings-"));
  const filePath = path.join(root, "config", "settings.json");
  const env = {};
  try {
    await saveSettings({
      cacheDirectory: path.join(root, "cache"),
      dailyDirectory: path.join(root, "daily"),
      dailyHeader: "# Log",
      dailySummary: "medium",
      timeZone: "UTC",
      sessionDirectory: path.join(root, "sessions"),
      piCommand: "pi",
      autoCapture: true,
      model: "openai/gpt-4.1",
      apiKey: "must-not-be-saved",
    }, filePath);

    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /apiKey|must-not-be-saved/);
    const settings = await loadSettings({ filePath, env, home: root });
    assert.equal(settings.cacheDirectory, path.join(root, "cache"));
    assert.equal(settings.dailySummary, "medium");
    assert.equal(settings.model, "openai/gpt-4.1");
    assert.equal(settings.autoCapture, true);

    const overridden = await loadSettings({
      filePath,
      env: {
        PI_JOURNAL_DAILY_SUMMARY: "LARGE",
        PI_JOURNAL_DAILY_DIR: path.join(root, "other-daily"),
        PI_JOURNAL_AUTO: "0",
      },
      home: root,
    });
    assert.equal(overridden.dailySummary, "large");
    assert.equal(overridden.dailyDirectory, path.join(root, "other-daily"));
    assert.equal(overridden.autoCapture, false);
    const blankAutoOverride = await loadSettings({ filePath, env: { PI_JOURNAL_AUTO: "" }, home: root });
    assert.equal(blankAutoOverride.autoCapture, false);
    assert.deepEqual(environmentOverrides({ PI_JOURNAL_AUTO: "", PI_JOURNAL_DIR: "" }), ["PI_JOURNAL_AUTO"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("thinking levels round-trip, normalize, and allow independent environment overrides", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-thinking-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "settings.json");
  const settings = await loadSettings({ filePath, env: {}, home: root });
  assert.equal(settings.thinkingLevel, undefined);
  const required = { ...settings, cacheDirectory: path.join(root, "cache"), dailyDirectory: path.join(root, "daily"), model: "test/fake" };
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    await saveSettings({ ...required, thinkingLevel: ` ${level.toUpperCase()} ` }, filePath);
    assert.equal((await loadSettings({ filePath, env: {}, home: root })).thinkingLevel, level);
  }
  const overridden = await loadSettings({ filePath, env: { PI_JOURNAL_THINKING: "OFF" }, home: root });
  assert.equal(overridden.thinkingLevel, "off");
  assert.equal(overridden.model, "test/fake");
  assert.deepEqual(environmentOverrides({ PI_JOURNAL_THINKING: "max" }), ["PI_JOURNAL_THINKING"]);
  const cleared = await loadSettings({ filePath, env: { PI_JOURNAL_THINKING: "default" }, home: root });
  assert.equal(cleared.thinkingLevel, undefined);
  assert.equal((await loadSettings({ filePath, env: {}, home: root })).thinkingLevel, "max");
  await saveSettings({ ...required, thinkingLevel: " DEFAULT " }, filePath);
  assert.doesNotMatch(await readFile(filePath, "utf8"), /thinkingLevel/);
  for (const invalid of ["", "ultra", "max\nhigh", null, true, 0, {}]) {
    assert.throws(() => validateSettings({ ...required, thinkingLevel: invalid }), /thinkingLevel/);
  }
});

test("settings reject invalid summary levels, headings, and model references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-invalid-settings-"));
  const filePath = path.join(root, "settings.json");
  const required = {
    cacheDirectory: path.join(root, "cache"),
    dailyDirectory: path.join(root, "daily"),
    timeZone: "UTC",
    sessionDirectory: path.join(root, "sessions"),
  };
  try {
    await assert.rejects(saveSettings({ ...required, dailySummary: "tiny" }, filePath), /dailySummary/);
    await assert.rejects(saveSettings({ ...required, dailyHeader: "Log" }, filePath), /dailyHeader/);
    await assert.rejects(saveSettings({ ...required, model: "gpt-4.1" }, filePath), /provider\/model/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
