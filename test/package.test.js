import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function runNpm(args, options) {
  return process.env.npm_execpath
    ? exec(process.execPath, [process.env.npm_execpath, ...args], options)
    : exec("npm", args, { ...options, shell: process.platform === "win32" });
}

test("npm tarball installs a working PATH command without runtime dependencies", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logdig-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // npm publish --dry-run forwards its npm_config_* options into lifecycle tests.
  const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")));
  const options = { cwd: packageRoot, env: npmEnv, timeout: 30_000, maxBuffer: 1024 * 1024 };
  const { stdout } = await runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", root], options);
  const [packed] = JSON.parse(stdout);
  const files = packed.files.map(({ path: filePath }) => filePath);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));

  assert.equal(packed.name, "logdig");
  assert.equal(packed.version, manifest.version);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.dependencies ?? {}, {});
  for (const filePath of ["package.json", "README.md", "QUICKSTART.md", "docs/usage.md", "LICENSE", "bin/logdig.js", ...manifest.pi.extensions]) {
    assert.ok(files.includes(filePath.replace(/^\.\//, "")), `Missing ${filePath}`);
  }
  for (const filePath of await readdir(path.join(packageRoot, "src"))) {
    assert.ok(files.includes(`src/${filePath}`), `Missing src/${filePath}`);
  }
  assert.ok(files.every((filePath) => /^(bin\/|src\/|docs\/usage\.md$|package\.json$|README\.md$|QUICKSTART\.md$|LICENSE$)/.test(filePath)), "Unexpected files in npm package");
  assert.equal(packed.bundled.length, 0);

  const prefix = path.join(root, "global");
  await runNpm([
    "install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    path.join(root, packed.filename),
  ], options);
  const binDirectory = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    key.toUpperCase() !== "PATH" && !key.startsWith("PI_JOURNAL_") && !key.startsWith("LOGDIG_") && !key.startsWith("PI_CODING_AGENT_"),
  ));
  Object.assign(env, {
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
    LOGDIG_CONFIG_PATH: path.join(root, "settings.json"),
  });
  const cliOptions = { cwd: root, env, timeout: 10_000, shell: process.platform === "win32" };
  for (const flag of ["--version", "-v"]) {
    const result = await exec("logdig", [flag], cliOptions);
    assert.equal(result.stdout.trim(), manifest.version);
    assert.equal(result.stderr, "");
  }
  const help = await exec("logdig", ["--help"], cliOptions);
  assert.match(help.stdout, /npm install -g logdig/);
  assert.match(help.stdout, /  logdig init/);
  assert.doesNotMatch(help.stdout, /node .*bin\/logdig\.js|from this checkout/);
  const installedCli = path.join(prefix, process.platform === "win32" ? "" : "lib", "node_modules", "logdig", "bin", "logdig.js");
  const directHelp = await exec(process.execPath, [installedCli, "--help"], { ...cliOptions, shell: false });
  assert.match(directHelp.stdout, /  logdig init/);
  assert.doesNotMatch(directHelp.stdout, /from this checkout/);
  await assert.rejects(exec("logdig", ["backfill", "1", "--dry-run"], cliOptions), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Run 'logdig init' first/);
    return true;
  });
  await assert.rejects(readFile(env.LOGDIG_CONFIG_PATH), { code: "ENOENT" });
});
