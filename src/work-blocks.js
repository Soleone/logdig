import { createHash } from "node:crypto";
import { eventsForSession, localParts, localTimeFormatter, timestampOf } from "./transcript.js";

const CONTINUATION_GAP_MS = 4 * 60 * 60 * 1000;
const CONTEXT_LIMIT = 3200;
const CONTEXT_EVENTS = 6;
const ACTIVITY_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);

function precedingContext(events) {
  const context = [];
  let size = 0;
  for (let index = events.length - 1; index >= 0 && context.length < CONTEXT_EVENTS; index--) {
    const event = events[index];
    const length = JSON.stringify(event).length;
    if (size + length > CONTEXT_LIMIT) break;
    context.unshift(event);
    size += length;
  }
  return context;
}

export function workBlocksForSession(session, timeZone) {
  const formatter = localTimeFormatter(timeZone);
  const blocks = [];
  let current;
  let lastActivity;
  let userIndex = 0;
  const pending = [];

  for (const entry of session.entries) {
    const contextSummary = ["compaction", "branch_summary"].includes(entry.type) && typeof entry.summary === "string" && entry.summary.trim();
    const activity = (entry.type === "message" && ACTIVITY_ROLES.has(entry.message?.role)) || contextSummary;
    const timestamp = activity ? timestampOf(entry) : undefined;
    if (timestamp !== undefined) {
      const { date, time } = localParts(timestamp, formatter);
      const user = entry.message?.role === "user";
      if (user) userIndex++;
      if (!current || (user && date > current.date && timestamp - lastActivity >= CONTINUATION_GAP_MS)) {
        const blockId = createHash("sha256")
          .update(JSON.stringify([session.header.id, entry.id || [timestamp, userIndex]]))
          .digest("hex");
        current = {
          ...session,
          header: blocks.length ? { ...session.header, timestamp: new Date(timestamp).toISOString() } : session.header,
          entries: blocks.length ? [] : pending.splice(0),
          blockId,
          blockStart: new Date(timestamp).toISOString(),
          date,
          time,
          timezone: timeZone,
          activityDates: new Set(),
        };
        blocks.push(current);
      }
      current.activityDates.add(date);
      lastActivity = Math.max(lastActivity ?? timestamp, timestamp);
    }
    if (current) current.entries.push(entry);
    else pending.push(entry);
  }

  const journalable = [];
  const extraction = { formatter, toolCalls: new Map() };
  for (const block of blocks) {
    const events = eventsForSession(block, timeZone, extraction);
    if (!events.length) continue;
    const previous = journalable.at(-1);
    journalable.push({
      ...block,
      blockIndex: journalable.length,
      project: events[0].project,
      events,
      context: previous ? precedingContext(previous.events) : [],
      previousBlockId: previous?.blockId,
      activityDates: [...block.activityDates],
    });
  }
  return journalable;
}

export function blockInRange(block, range) {
  // Never create a partial summary of a work period that continues into today.
  if (range.skipToday && block.activityDates.some((date) => date > range.lastDate)) return false;
  return !range.firstDate || block.activityDates.some((date) => date >= range.firstDate && date <= range.lastDate);
}

// Legacy entries used their last user timestamp. Blocks that disappear after a
// timezone change also need reassignment, without altering their linked notes.
export function assignLegacyBlocks(versions, blocks) {
  if (!blocks.length) return;
  const currentIds = new Set(blocks.map((block) => block.blockId));
  for (const version of versions) {
    if (currentIds.has(version.blockId)) continue;
    const anchor = `${version.date} ${version.time}`;
    const block = blocks.findLast((candidate) => version.blockStart
      ? candidate.blockStart <= version.blockStart
      : `${candidate.date} ${candidate.time}` <= anchor) || blocks[0];
    version.blockId = block.blockId;
    version.legacy = true;
  }
}
