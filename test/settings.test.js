import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { environmentOverrides, loadSettings, saveSettings, settingsFilePath } from "../src/settings.js";

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
