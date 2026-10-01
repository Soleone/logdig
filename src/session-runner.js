import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { appendDailyEntry, dailyEntryId, inspectDailyEntry, inspectSessionSummary, listJournaledSessions, saveSessionSummary } from "./journal.js";
import { sessionFromJsonl, sessionMetrics } from "./transcript.js";
import { DEFAULT_CONCURRENCY } from "./settings.js";
import { assignLegacyBlocks, blockInRange, workBlocksForSession } from "./work-blocks.js";

function localDate(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date, amount) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return shifted.toISOString().slice(0, 10);
}

function sessionEndTime(session) {
  for (let index = session.entries.length - 1; index >= 0; index--) {
    const entry = session.entries[index];
    const value = entry.timestamp ?? entry.message?.timestamp;
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const headerTime = Date.parse(session.header.timestamp || "");
  return Number.isFinite(headerTime) ? headerTime : 0;
}

async function findSessionFiles(root) {
  const files = [];
  const warnings = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        if (directory === root) warnings.push(`Pi history folder not found: ${root}. Start a saved Pi session or check the history path with 'logdig init'.`);
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "subagent-artifacts") pending.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== "session.jsonl") {
        files.push(fullPath);
      }
    }
  }

  return { files, warnings };
}

export async function collectSessions({ sessionDirectory, timeZone, days, currentSession }) {
  const { files, warnings } = await findSessionFiles(sessionDirectory);
  const currentId = currentSession?.header.id;
  const currentPath = currentSession?.sourcePath;
  const today = localDate(Date.now(), timeZone);
  const firstDate = days ? shiftDate(today, 1 - days) : undefined;
  const modifiedAfter = days ? Date.now() - (days + 1) * 86400000 : undefined;
  const sessions = [];
  const seen = new Set();

  for (const file of files) {
    if (file === currentPath) continue;

    try {
      const fileStat = await stat(file);
      if (modifiedAfter && fileStat.mtimeMs < modifiedAfter) continue;
      const session = sessionFromJsonl(await readFile(file, "utf8"), file);
      if (session.header.id === currentId || seen.has(session.header.id)) continue;
      seen.add(session.header.id);
      sessions.push(session);
    } catch (error) {
      warnings.push(`${path.basename(file)}: ${error.message}`);
    }
  }

  if (currentSession && !seen.has(currentSession.header.id)) sessions.push(currentSession);
  sessions.sort((left, right) => sessionEndTime(left) - sessionEndTime(right) || left.header.id.localeCompare(right.header.id));
  return { sessions, warnings, firstDate, lastDate: today };
}

function selectedBlockIndexes(blocks, versions, range) {
  const selected = new Set(blocks.flatMap((block, index) => blockInRange(block, range) ? [index] : []));
  // A continuation must link to a real snapshot, not a predicted filename.
  for (let index = blocks.length - 1; index > 0; index--) {
    if (selected.has(index) && !versions.some((version) => version.blockId === blocks[index - 1].blockId && version.summary)) {
      selected.add(index - 1);
    }
  }
  return selected;
}

async function precedingSnapshot(modelClient, previous, versions, settings) {
  const snapshots = versions.filter((version) => version.blockId === previous.blockId && version.summary);
  if (!snapshots.length) throw new Error("preceding work block has no saved snapshot; fix its error and retry");
  const cached = await inspectSessionSummary(modelClient, settings.cacheDirectory, previous);
  const expectedId = dailyEntryId({
    sessionId: previous.header.id,
    blockId: previous.blockId,
    cacheFingerprint: cached.cacheFingerprint,
    continuationOf: cached.continuationOf,
    summaryLevel: settings.dailySummary,
  }, settings.dailyHeader);
  return (snapshots.find((snapshot) => snapshot.id === expectedId) || snapshots[0]).id;
}

export async function writeSessions(modelClient, sessions, settings, range = {}) {
  let summariesCreated = 0;
  let summariesReused = 0;
  let entriesAppended = 0;
  let entriesUpdated = 0;
  let entriesSkipped = 0;
  let sessionsSkipped = 0;
  const dates = new Set();
  const dailyPaths = new Set();
  const results = sessions.map(() => ({ errors: [], sessionResults: [] }));
  const journaledEntries = range.journaledEntries || await listJournaledSessions(settings.cacheDirectory);
  let dailyWrites = Promise.resolve();
  const writeDailyEntry = (entry) => {
    // Entry migration can touch multiple dates, so serialize all daily-note read/modify/writes.
    const pending = dailyWrites.then(() => appendDailyEntry(settings.dailyDirectory, settings.dailyHeader, entry, journaledEntries));
    // The caller reports a failed write; it must not poison later queued writes.
    dailyWrites = pending.catch(() => {});
    return pending;
  };

  async function writeSession(session, index) {
    const { errors, sessionResults } = results[index];
    const progress = { index: index + 1, total: sessions.length, sessionId: session.header.id };
    let blocks;
    try {
      blocks = workBlocksForSession(session, settings.timeZone);
    } catch (error) {
      errors.push(`${session.header.id}: ${error.message}`);
      sessionResults.push({ sessionId: session.header.id, status: "error", error: error.message });
      range.onProgress?.({ ...progress, phase: "error", status: "FAILED", error: error.message });
      return;
    }
    const versions = journaledEntries.get(session.header.id) || [];
    journaledEntries.set(session.header.id, versions);
    assignLegacyBlocks(versions, blocks);
    const selected = selectedBlockIndexes(blocks, versions, range);
    if (!selected.size) {
      sessionsSkipped++;
      const reason = blocks.length ? "outside date range" : "no journalable events";
      const latestBlock = blocks.at(-1);
      sessionResults.push({ sessionId: session.header.id, status: "skipped", reason });
      range.onProgress?.({
        ...progress,
        ...(latestBlock && { project: latestBlock.project, date: latestBlock.date, time: latestBlock.time }),
        phase: "skipped",
        status: "SKIPPED",
      });
      return;
    }

    const plannedSnapshots = new Map();
    for (const [blockIndex, block] of blocks.entries()) {
      if (!selected.has(blockIndex)) continue;
      const blockProgress = { ...progress, blockId: block.blockId, project: block.project, date: block.date, time: block.time };
      try {
        const previous = blocks[blockIndex - 1];
        const continuationOf = previous
          ? plannedSnapshots.get(previous.blockId) || await precedingSnapshot(modelClient, previous, versions, settings)
          : undefined;
        const journalBlock = { ...block, continuationOf };
        const prerequisite = !blockInRange(block, range);
        range.onProgress?.({ ...blockProgress, phase: "checking", status: "CHECKING" });
        const cached = range.dryRun
          ? await inspectSessionSummary(modelClient, settings.cacheDirectory, journalBlock)
          : await saveSessionSummary(modelClient, settings.cacheDirectory, journalBlock, {
            onGenerate: () => range.onProgress?.({ ...blockProgress, phase: "summarizing", status: "SUMMARIZING" }),
          });
        if (cached.reused) summariesReused++;
        else summariesCreated++;

        const entry = {
          date: block.date,
          time: block.time,
          project: block.project,
          sessionId: session.header.id,
          blockId: block.blockId,
          blockStart: block.blockStart,
          continuationOf,
          cacheFingerprint: cached.cacheFingerprint,
          sessionPath: cached.sessionPath,
          sourceFingerprint: cached.sourceFingerprint,
          metrics: sessionMetrics(block),
          summaryLevel: settings.dailySummary,
          summary: cached.summary?.[settings.dailySummary],
        };
        const dailyEntry = range.dryRun
          ? await inspectDailyEntry(settings.dailyDirectory, settings.dailyHeader, entry, journaledEntries)
          : await writeDailyEntry(entry);
        if (dailyEntry.updated) entriesUpdated++;
        else if (dailyEntry.appended) entriesAppended++;
        else entriesSkipped++;
        const entryId = dailyEntryId(entry, settings.dailyHeader);
        plannedSnapshots.set(block.blockId, entryId);
        sessionResults.push({
          sessionId: session.header.id,
          blockId: block.blockId,
          project: block.project,
          date: block.date,
          time: block.time,
          activityDates: block.activityDates,
          prerequisite,
          continuationOf,
          entryPresent: !dailyEntry.appended && !dailyEntry.updated,
          entryUpdated: Boolean(dailyEntry.updated),
          legacyEntry: dailyEntry.legacyEntry,
          summaryReused: cached.reused,
          sourceFingerprint: cached.sourceFingerprint,
          cacheFingerprint: cached.cacheFingerprint,
          sessionPath: cached.sessionPath,
          dailyPath: dailyEntry.dailyPath,
        });
        // Dry-run predictions stay in plannedSnapshots, never in the real index.
        if (!range.dryRun && !versions.some((version) => version.id === entryId)) {
          versions.push({ ...entry, id: entryId, summary: cached.summary });
        }
        dates.add(block.date);
        dailyPaths.add(dailyEntry.dailyPath);
        range.onProgress?.({
          ...blockProgress,
          phase: "complete",
          prerequisite,
          sessionPath: cached.sessionPath,
          dailyPath: dailyEntry.dailyPath,
          status: range.dryRun ? "PREVIEW" : dailyEntry.updated ? "UPDATED" : dailyEntry.appended ? "SAVED" : "CURRENT",
        });
      } catch (error) {
        errors.push(`${session.header.id}: ${block.date} ${block.time}: ${error.message}`);
        sessionResults.push({ sessionId: session.header.id, blockId: block.blockId, status: "error", error: error.message });
        range.onProgress?.({ ...blockProgress, phase: "error", status: "FAILED", error: error.message });
      }
    }
  }

  let nextIndex = 0;
  const concurrency = Math.min(settings.concurrency ?? DEFAULT_CONCURRENCY, sessions.length);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < sessions.length) {
      const index = nextIndex++;
      await writeSession(sessions[index], index);
    }
  }));

  return {
    summariesCreated, summariesReused, entriesAppended, entriesUpdated, entriesSkipped, sessionsSkipped,
    dates: [...dates].sort(), dailyPaths: [...dailyPaths].sort(),
    errors: results.flatMap((result) => result.errors),
    sessionResults: results.flatMap((result) => result.sessionResults),
  };
}

export function parseBackfillArgument(argument = "", command = "backfill") {
  const value = argument.trim().toLowerCase() || "3";
  if (value === "all") return { all: true };
  const days = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error(`Usage: logdig ${command} [number-of-days|all]. Choose 1 to 3650 days, or 'all'.`);
  }
  return { days };
}
