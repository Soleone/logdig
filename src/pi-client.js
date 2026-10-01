import os from "node:os";
import { JOURNAL_SYSTEM_PROMPT, summaryCachePolicy } from "./journal.js";
import { spawnPiProcess } from "./pi-process.js";

const MODEL_TIMEOUT_MS = 5 * 60 * 1000;
const THINKING_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_STDOUT = 2_000_000;
const MAX_STDERR = 16_000;

function appendTail(current, chunk, limit) {
  const text = current + chunk.toString("utf8");
  return text.length > limit ? text.slice(-limit) : text;
}

function piArguments(settings) {
  const args = [
    "--mode", "json",
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
  if (settings.thinkingLevel !== undefined) args.push("--thinking", settings.thinkingLevel);
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
    const decoder = new TextDecoder();
    let buffer = "";
    let outputLength = 0;
    let stderr = "";
    let settled = false;
    let agentSettled = false;
    let finalMessage;
    const usages = [];

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };

    const timeoutMs = settings.thinkingLevel && settings.thinkingLevel !== "off" ? THINKING_TIMEOUT_MS : MODEL_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Pi summarization timed out after ${timeoutMs / 1000} seconds`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      outputLength += chunk.length;
      if (outputLength > MAX_STDOUT) {
        child.kill("SIGTERM");
        finish(new Error("Pi summarization output exceeded the size limit"));
        return;
      }
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          child.kill("SIGTERM");
          finish(new Error("Pi summarization returned invalid JSON events"));
          return;
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          finalMessage = event.message;
          if (event.message.usage) usages.push(event.message.usage);
        }
        if (event.type === "compaction_end" && event.result?.usage) usages.push(event.result.usage);
        if (event.type === "agent_settled") agentSettled = true;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk, MAX_STDERR);
    });
    child.once("error", (error) => {
      finish(new Error(`Could not start Pi at '${settings.piCommand || "pi"}': ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      buffer += decoder.decode();
      if (code !== 0) {
        const detail = stderr.trim();
        finish(new Error(`Pi summarization failed${signal ? ` (${signal})` : ` with exit code ${code}`}${detail ? `: ${detail}` : ""}`));
        return;
      }
      if (!agentSettled || !finalMessage || buffer.trim()) {
        finish(new Error("Pi summarization returned incomplete JSON events"));
        return;
      }
      if (["error", "aborted"].includes(finalMessage.stopReason)) {
        finish(new Error(finalMessage.errorMessage || `Pi summarization ${finalMessage.stopReason}`));
        return;
      }
      const text = (finalMessage.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
      finish(undefined, { text, usages });
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
    cachePolicy: summaryCachePolicy(settings),
    complete: (prompt) => runPiPrompt(prompt, settings, options.spawnProcess),
  };
}
