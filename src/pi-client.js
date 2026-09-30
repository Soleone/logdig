import os from "node:os";
import { JOURNAL_SYSTEM_PROMPT } from "./journal.js";
import { spawnPiProcess } from "./pi-process.js";

const MODEL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_STDOUT = 2_000_000;
const MAX_STDERR = 16_000;

function appendTail(current, chunk, limit) {
  const text = current + chunk.toString("utf8");
  return text.length > limit ? text.slice(-limit) : text;
}

function piArguments(settings) {
  const args = [
    "--print",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--system-prompt",
    JOURNAL_SYSTEM_PROMPT,
  ];
  if (settings.model) args.push("--model", settings.model);
  args.push("--", "Use the journal request and evidence supplied on standard input. Return the requested JSON only.");
  return args;
}

function runPiPrompt(prompt, settings, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnPiProcess(settings.piCommand || "pi", piArguments(settings), {
      cwd: os.tmpdir(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    }, { spawnProcess });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Pi summarization timed out after ${MODEL_TIMEOUT_MS / 1000} seconds`));
    }, MODEL_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_STDOUT) {
        child.kill("SIGTERM");
        finish(new Error("Pi summarization output exceeded the size limit"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk, MAX_STDERR);
    });
    child.once("error", (error) => {
      finish(new Error(`Could not start Pi at '${settings.piCommand || "pi"}': ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (code === 0) return finish(undefined, stdout.trim());
      const detail = stderr.trim();
      finish(new Error(`Pi summarization failed${signal ? ` (${signal})` : ` with exit code ${code}`}${detail ? `: ${detail}` : ""}`));
    });
    child.stdin.once("error", (error) => {
      if (error.code !== "EPIPE") finish(error);
    });
    child.stdin.end(prompt);
  });
}

export function createPiModelClient(settings, options = {}) {
  return {
    modelLabel: settings.model || "Pi startup default",
    cacheKey: settings.model || "Pi default",
    complete: (prompt) => runPiPrompt(prompt, settings, options.spawnProcess),
  };
}
