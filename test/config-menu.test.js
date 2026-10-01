import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { editConfig } from "../src/config-menu.js";
import { loadSettings, saveSettings } from "../src/settings.js";

async function workspace(t, { configured = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-config-menu-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "config", "settings.json");
  const settings = {
    dailyDirectory: path.join(root, "daily"), cacheDirectory: path.join(root, "cache"),
    sessionDirectory: path.join(root, "sessions"), dailyHeader: "# Projects",
    dailyHeaderAnchor: "# Log", dailySummary: "small", timeZone: "UTC", piCommand: "pi",
    model: "test/fake", thinkingLevel: "max", concurrency: 4, autoCapture: false,
  };
  if (configured) await saveSettings(settings, filePath);
  return { root, filePath, settings, env: { LOGDIG_CONFIG_PATH: filePath } };
}

async function menu(w, lines, { env = {}, onOutput } = {}) {
  const input = new PassThrough();
  let text = "";
  const output = new Writable({
    write(chunk, encoding, callback) {
      text += chunk;
      onOutput?.(String(chunk), input);
      callback();
    },
  });
  if (lines !== null) input.end(lines.join("\n") + "\n");
  try {
    await editConfig("logdig", { input, output, env: { ...w.env, ...env } });
    return text;
  } finally {
    input.destroy();
    output.destroy();
  }
}

async function saved(w) {
  return loadSettings({ filePath: w.filePath, env: {} });
}

test("config lists aligned numbered settings, supports numbers above nine, saves and redisplays", async (t) => {
  const w = await workspace(t);
  const text = await menu(w, ["11", "2", "12", "yes", "Q"]);
  const settings = await saved(w);
  assert.equal(settings.concurrency, 2);
  assert.equal(settings.autoCapture, true);
  assert.match(text, /11\. Maximum parallel sessions\s+4/);
  assert.match(text, /11\. Maximum parallel sessions\s+2/);
  assert.match(text, /12\. Automatic capture\s+yes/);
  assert.match(text, /Available values: yes, no/);
  assert.match(text, /Maximum parallel sessions saved: 2/);
  assert.match(text, /logdig pi-install/);
  assert.equal(text.match(/LogDig settings/g).length, 3);
  const rows = text.split("\n").filter((line) => /^\s+\d+\./.test(line)).slice(0, 12);
  const valueColumns = rows.map((line) => line.length - line.match(/^\s+\d+\. (.*?\S) {2,}(\S.*)$/)[2].length);
  assert.equal(new Set(valueColumns).size, 1);
  assert.doesNotMatch(text, /\u001b|\uf00c/);
  await assert.rejects(readdir(w.settings.dailyDirectory), { code: "ENOENT" });
  await assert.rejects(readdir(w.settings.cacheDirectory), { code: "ENOENT" });
});

test("names and keys select settings; ambiguous names and invalid numbers do not change anything", async (t) => {
  const w = await workspace(t);
  const text = await menu(w, ["summary", "0", "13", "bogus", "ThinkingLevel", "off", "parallel", "1", "q"]);
  assert.match(text, /Please be more specific: 2\. Summary cache folder; 5\. Daily summary length/);
  assert.match(text, /Choose a number from 1 to 12/);
  assert.match(text, /Available values: default, off, minimal, low, medium, high, xhigh, max/);
  assert.equal((await saved(w)).thinkingLevel, "off");
  assert.equal((await saved(w)).concurrency, 1);
});

test("invalid values retry only the selected field and choices are shown before prompting", async (t) => {
  const w = await workspace(t);
  const text = await menu(w, ["5", "tiny", "MEDIUM", "11", "0", "1.5", "3", "12", "later", "no", "q"]);
  assert.match(text, /dailySummary must be small, medium, or large/);
  assert.match(text, /concurrency must be a positive integer/);
  assert.match(text, /Please enter yes or no/);
  assert.ok(text.indexOf("Available values: small, medium, large") < text.indexOf("New value [small]"));
  assert.equal(text.match(/LogDig settings/g).length, 4);
  const settings = await saved(w);
  assert.equal(settings.dailySummary, "medium");
  assert.equal(settings.concurrency, 3);
  assert.equal(settings.autoCapture, false);
});

test("Enter keeps values; q at either prompt and end of input do not write settings", async (t) => {
  const w = await workspace(t);
  const before = await readFile(w.filePath, "utf8");
  for (const lines of [["", "q"], ["10", "", "q"], ["10", "q"], ["10"], []]) {
    await menu(w, lines);
    assert.equal(await readFile(w.filePath, "utf8"), before);
  }
});

test("default and none clear optional overrides while ordinary edits preserve other settings", async (t) => {
  const w = await workspace(t);
  await menu(w, ["9", "DEFAULT", "10", "default", "4", "none", "3", "## Work", "q"]);
  const settings = await saved(w);
  assert.equal(settings.model, undefined);
  assert.equal(settings.thinkingLevel, undefined);
  assert.equal(settings.dailyHeaderAnchor, "");
  assert.equal(settings.dailyHeader, "## Work");
  assert.equal(settings.dailyDirectory, w.settings.dailyDirectory);
  assert.equal(settings.concurrency, 4);
  assert.equal(settings.timeZone, "UTC");
  const raw = await readFile(w.filePath, "utf8");
  assert.doesNotMatch(raw, /"model"|"thinkingLevel"/);
});

test("environment overrides are labeled but never copied into saved settings", async (t) => {
  const w = await workspace(t);
  const env = { PI_JOURNAL_THINKING: "off", PI_JOURNAL_AUTO: "1", PI_JOURNAL_DAILY_HEADER_ANCHOR: "" };
  const text = await menu(w, ["11", "2", "10", "low", "q"], { env });
  assert.match(text, /Thinking level\s+max/);
  assert.match(text, /PI_JOURNAL_THINKING="off" \(saved changes will not override it\)/);
  assert.match(text, /PI_JOURNAL_AUTO="1"/);
  assert.match(text, /PI_JOURNAL_DAILY_HEADER_ANCHOR=""/);
  const settings = await saved(w);
  assert.equal(settings.thinkingLevel, "low");
  assert.equal(settings.autoCapture, false);
  assert.equal(settings.dailyHeaderAnchor, "# Log");
  const effective = await loadSettings({ env: { ...w.env, ...env } });
  assert.equal(effective.thinkingLevel, "off");
  assert.equal(effective.autoCapture, true);
  assert.equal(effective.dailyHeaderAnchor, "");
});

test("folders, headings, models, and timezones use existing validation without creating folders", async (t) => {
  const w = await workspace(t);
  const notAFolder = path.join(w.root, "file.md");
  await writeFile(notAFolder, "keep this");
  const directory = path.join(w.root, "new-daily");
  const text = await menu(w, ["1", notAFolder, directory, "3", "Work", "## Work", "6", "Invalid/Zone", "UTC", "9", "invalid", "test/new", "q"]);
  assert.match(text, /Not a folder/);
  assert.match(text, /dailyHeader must be one Markdown heading/);
  assert.match(text, /Invalid timeZone/);
  assert.match(text, /model must use provider\/model format/);
  assert.equal((await saved(w)).dailyDirectory, directory);
  assert.equal((await saved(w)).model, "test/new");
  assert.equal(await readFile(notAFolder, "utf8"), "keep this");
  await assert.rejects(readdir(directory), { code: "ENOENT" });
});

test("unconfigured users are directed to init without saving defaults or environment values", async (t) => {
  const w = await workspace(t, { configured: false });
  const text = await menu(w, [], { env: { PI_JOURNAL_AUTO: "1" } });
  assert.match(text, /Run 'logdig init' first/);
  assert.match(text, /Automatic capture\s+no/);
  await assert.rejects(readFile(w.filePath), { code: "ENOENT" });
});

test("Ctrl+C closes the menu, retains completed saves, and removes its signal listener", async (t) => {
  const w = await workspace(t);
  const listenerCount = process.listenerCount("SIGINT");
  let choices = 0;
  await assert.rejects(menu(w, null, {
    onOutput(chunk, input) {
      if (chunk.includes("Choose a setting")) {
        choices++;
        setImmediate(() => choices === 1 ? input.write("11\n") : process.emit("SIGINT"));
      } else if (chunk.includes("New value")) setImmediate(() => input.write("2\n"));
    },
  }), { code: "LOGDIG_CONFIG_CANCELLED" });
  assert.equal((await saved(w)).concurrency, 2);
  assert.equal(process.listenerCount("SIGINT"), listenerCount);
});
