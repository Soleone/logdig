// Runs in the page before mounting: adds the sample Pi sessions, dated relative to today so `logdig backfill`
// (last 3 days) finds them, and a handwritten daily note that LogDig must leave alone.
export default function seed(files, now = Date.now()) {
  const sessions = JSON.parse(files[".demo"].directory["sessions.json"].file.contents);
  const day = (offset) => new Date(now + offset * 86400000).toISOString().slice(0, 10);
  const folders = {};
  for (const [index, session] of sessions.entries()) {
    const start = new Date(`${day(session.day)}T${session.time}:00Z`);
    const at = (minutes) => new Date(start.getTime() + minutes * 60000).toISOString();
    const id = `demo-${String(index + 1).padStart(2, "0")}`;
    const records = [
      { type: "session", version: 3, id, cwd: `/home/demo/src/${session.project}`, timestamp: at(0) },
      { type: "message", id: `${id}-user`, timestamp: at(0), message: { role: "user", content: session.ask } },
      { type: "message", id: `${id}-assistant`, timestamp: at(18), message: { role: "assistant", content: `${session.detail} ${session.small}` } },
    ];
    const folder = (folders[`--home-demo-src-${session.project}--`] ??= { directory: {} }).directory;
    folder[`${at(0).replace(/[:.]/g, "-")}_${id}.jsonl`] = { file: { contents: records.map((record) => JSON.stringify(record)).join("\n") + "\n" } };
  }
  return {
    ".pi": { directory: { agent: { directory: { sessions: { directory: folders } } } } },
    vault: { directory: { Daily: { directory: { [`${day(-1)}.md`]: { file: { contents: "# Log\n\nCoffee, a walk, then a few good hours of building.\n" } } } } } },
  };
}
