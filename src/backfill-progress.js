import { stripVTControlCharacters } from "node:util";
import { progressStatus } from "./cli-status.js";

function cleanText(value) {
  return stripVTControlCharacters(String(value ?? "")).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function fitLiveLine(line, columns) {
  const limit = Math.max(0, columns - 1);
  let width = 0;
  let fitted = "";
  for (const token of line.match(/\x1b\[[0-9;]*m|./gu) || []) {
    if (token.startsWith("\x1b[")) {
      fitted += token;
      continue;
    }
    // Conservatively allow two cells for non-ASCII text so panel rows never wrap.
    const cells = token.codePointAt(0) > 127 ? 2 : 1;
    if (width + cells > limit) break;
    width += cells;
    fitted += token;
  }
  return fitted + (line.includes("\x1b[") ? "\x1b[0m" : "");
}

export function createBackfillProgress({ total, concurrency, dryRun = false, stream = process.stdout, term = process.env.TERM, icons, noColor }) {
  const live = stream.isTTY && term !== "dumb" && !dryRun;
  const statusOptions = { isTTY: stream.isTTY, term, icons, noColor, pad: true };
  const sessions = Array.from({ length: total }, () => ({ lines: [], complete: false, failed: false }));
  let nextResult = 0;
  let completed = 0;
  let panelRows = 0;
  let refreshTimer;
  let closed = false;

  function clearPanel() {
    if (!panelRows) return;
    stream.write("\r" + "\x1b[1A\x1b[2K\r".repeat(panelRows));
    panelRows = 0;
  }

  function sessionLabel(event, status = event.status, elapsed = "") {
    const position = `${String(event.index).padStart(String(total).length, "0")}/${total}`;
    const timestamp = `${cleanText(event.date)}${event.time ? ` ${cleanText(event.time)}` : ""}`.padEnd(16);
    return `[${position}] ${timestamp} · ${progressStatus(status, statusOptions)} · ${cleanText(event.project) || "session"} (${cleanText(event.sessionId).slice(-8)})${elapsed ? ` · ${elapsed}` : ""}`;
  }

  function renderPanel() {
    if (!live || closed) return;
    clearPanel();
    const pending = sessions.slice(nextResult).filter((session) => session.event);
    const waiting = pending.filter((session) => session.complete);
    const active = pending.filter((session) => !session.complete);
    if (active.length && !refreshTimer) {
      refreshTimer = setInterval(renderPanel, 1000);
      refreshTimer.unref();
    } else if (!active.length && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    if (!pending.length) return;
    const queued = total - completed - active.length;
    const overhead = 1 + Number(active.length > 0) + Number(waiting.length > 0);
    const capacity = Math.max(0, Math.min(concurrency, (stream.rows || 24) - 2 - overhead));
    const lines = [`Progress: ${completed}/${total} complete · ${active.length} active · ${queued} queued`];
    if (active.length) {
      const hidden = Math.max(0, active.length - capacity);
      lines.push(`Active sessions (stage elapsed${hidden ? `; ${hidden} not shown` : ""}):`);
      for (const session of active.slice(0, capacity)) {
        const seconds = Math.max(0, Math.floor((Date.now() - session.stageStartedAt) / 1000));
        const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
        lines.push(sessionLabel(session.event, session.event.status, elapsed));
      }
    }
    if (waiting.length) {
      const blocker = String(nextResult + 1).padStart(String(total).length, "0");
      const failed = waiting.filter((session) => session.failed).length;
      lines.push(`${waiting.length} finished session${waiting.length === 1 ? "" : "s"} waiting to print after #${blocker}.${failed ? ` ${failed} with errors.` : ""}`);
    }
    stream.write(lines.map((line) => fitLiveLine(line, stream.columns || 80)).join("\n") + "\n");
    panelRows = lines.length;
  }

  function onProgress(event) {
    if (closed) return;
    const session = sessions[event.index - 1];
    const previous = session.event;
    if (!previous || previous.phase !== event.phase || previous.blockId !== event.blockId || previous.date !== event.date || previous.time !== event.time) {
      session.stageStartedAt = Date.now();
    }
    session.event = event;
    if (event.phase === "error") session.failed = true;
    if (["complete", "skipped", "error"].includes(event.phase)) {
      const detail = event.error || event.reason;
      session.lines.push(`${sessionLabel(event)}${event.prerequisite ? " · prerequisite" : ""}${detail ? `: ${cleanText(detail)}` : ""}`);
      if (dryRun && event.dailyPath) {
        session.lines.push(`  Daily note: ${cleanText(event.dailyPath)}`, `  Full summary: ${cleanText(event.sessionPath)}`);
        if (event.prerequisite) session.lines.push("  Includes this earlier block to establish the continuation link.");
      }
    } else if (!live && event.phase === "summarizing") {
      stream.write(`Active ${sessionLabel(event)}\n`);
    }
    renderPanel();
  }

  function onSessionComplete({ index }) {
    if (closed) return;
    const session = sessions[index - 1];
    session.complete = true;
    completed++;
    clearPanel();
    if (!live && !dryRun && index - 1 > nextResult) {
      const blocker = String(nextResult + 1).padStart(String(total).length, "0");
      stream.write(`Finished ${sessionLabel(session.event, session.failed ? "FAILED" : "DONE")} (waiting to print after #${blocker}; processing continues)\n`);
    }
    while (sessions[nextResult]?.complete) {
      const { lines } = sessions[nextResult];
      if (lines.length) stream.write(lines.join("\n") + "\n");
      lines.length = 0;
      nextResult++;
    }
    renderPanel();
  }

  function close() {
    if (closed) return;
    clearPanel();
    closed = true;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    if (live) stream.removeListener("resize", renderPanel);
  }

  if (live) stream.on("resize", renderPanel);
  return { onProgress, onSessionComplete, close };
}
