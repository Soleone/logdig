import os from "node:os";
import { JOURNAL_SYSTEM_PROMPT, summaryCachePolicy } from "./journal.js";
import { spawnCommand } from "./command-process.js";

const MODEL_TIMEOUT_MS = 5 * 60 * 1000;
const THINKING_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_STDOUT = 2_000_000;
const MAX_STDERR = 16_000;

function appendTail(current, chunk, limit) {
  const text = current + chunk.toString("utf8");
  return text.length > limit ? text.slice(-limit) : text;
}

export function claudeArguments(settings) {
  // One-shot and isolated. No tools, no saved transcript (LogDig reads transcripts, so a saved
  // summary call would be journaled as work), and no user hooks or slash commands.
  const args = [
    "--print",
    "--output-format", "json",
    "--no-session-persistence",
    "--tools", "",
    "--disable-slash-commands",
    "--setting-sources", "project,local",
    "--system-prompt", JOURNAL_SYSTEM_PROMPT,
  ];
  if (settings.model) args.push("--model", settings.model);
  if (settings.thinkingLevel !== undefined) args.push("--effort", settings.thinkingLevel);
  return args;
}

function usageOf(envelope) {
  const usage = envelope.usage || {};
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
    // Claude Code reports a list-price estimate, not a billed amount.
    cost: { total: envelope.total_cost_usd },
  };
}

function runClaudePrompt(prompt, settings, spawnProcess) {
  return new Promise((resolve, reject) => {
    const command = settings.claudeCommand || "claude";
    const child = spawnCommand(command, claudeArguments(settings), {
      cwd: os.tmpdir(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    }, { spawnProcess });
    const decoder = new TextDecoder();
    let output = "";
    let stderr = "";
    let settled = false;

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
      finish(new Error(`Claude Code summarization timed out after ${timeoutMs / 1000} seconds`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += decoder.decode(chunk, { stream: true });
      if (output.length > MAX_STDOUT) {
        child.kill("SIGTERM");
        finish(new Error("Claude Code summarization output exceeded the size limit"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk, MAX_STDERR);
    });
    child.once("error", (error) => {
      finish(new Error(`Could not start Claude Code at '${command}': ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      output += decoder.decode();
      // A failed call can exit non-zero while still printing its JSON error, so read that first.
      let envelope;
      try {
        envelope = JSON.parse(output);
      } catch {
        envelope = undefined;
      }
      if (envelope && (envelope.is_error || envelope.subtype !== "success")) {
        const status = envelope.api_error_status ? ` (API status ${envelope.api_error_status})` : "";
        const detail = String(envelope.result || "").slice(0, 500);
        finish(new Error(`Claude Code summarization ${envelope.subtype || "failed"}${status}${detail ? `: ${detail}` : ""}`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim();
        finish(new Error(`Claude Code summarization failed${signal ? ` (${signal})` : ` with exit code ${code}`}${detail ? `: ${detail}` : ""}`));
        return;
      }
      if (!envelope) {
        finish(new Error("Claude Code summarization returned invalid JSON"));
        return;
      }
      finish(undefined, {
        text: String(envelope.result || "").trim(),
        usages: [usageOf(envelope)],
        provider: "anthropic",
        model: Object.keys(envelope.modelUsage || {})[0] || settings.model,
      });
    });
    child.stdin.once("error", (error) => {
      if (error.code !== "EPIPE") finish(error);
    });
    child.stdin.end(prompt);
  });
}

export function createClaudeModelClient(settings, options = {}) {
  return {
    modelLabel: settings.model || "Claude Code default",
    cachePolicy: summaryCachePolicy({ ...settings, summaryBackend: "claude" }),
    complete: (prompt) => runClaudePrompt(prompt, settings, options.spawnProcess),
  };
}
