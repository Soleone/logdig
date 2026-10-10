// A stand-in for Pi: answers LogDig's summary requests with canned summaries instead of calling a model.
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("demo stand-in for Pi (canned summaries, no model)");
  process.exit(0);
}
if (["install", "remove"].includes(args[0])) {
  console.log("This demo has no Pi to change; nothing was installed.");
  process.exit(0);
}

const sessions = JSON.parse(await readFile(new URL("./sessions.json", import.meta.url), "utf8"));
// Events rather than a top-level for-await, which the sandbox's module loader rejects.
const prompt = await new Promise((resolve) => {
  let text = "";
  process.stdin.on("data", (chunk) => { text += chunk; });
  process.stdin.on("end", () => resolve(text));
});

const session = sessions.find((candidate) => prompt.includes(candidate.ask));
const small = session?.small ?? "Worked on the project in this session.";
const detail = session?.detail ?? "A session this demo has no canned summary for.";
const summary = {
  small,
  medium: `## Outcome\n${small}\n\n## Detail\n${detail}`,
  large: `## Work log\n${detail}\n\n## Result\n${small}\n\nSynthetic session and canned summary for the LogDig browser demo.`,
};

// Uneven delays so sessions finish out of order, like real model calls.
await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 2800));
const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify(summary) }], provider: "demo", model: "canned", stopReason: "stop" };
process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n${JSON.stringify({ type: "agent_settled" })}\n`);
