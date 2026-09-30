import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { appendDailyEntry, inspectDailyEntry, inspectSessionSummary, saveSessionSummary } from "./journal.js";
import { eventsForSession, fingerprintSession, sessionFromJsonl } from "./transcript.js";

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
        pending.push(fullPath);
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
      session.fingerprint = fingerprintSession(session);
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

export async function writeSessions(modelClient, sessions, settings, range = {}) {
  let summariesCreated = 0;
  let summariesReused = 0;
  let entriesAppended = 0;
  let entriesSkipped = 0;
  let sessionsSkipped = 0;
  const dates = new Set();
  const dailyPaths = new Set();
  const errors = [];

  for (const [index, session] of sessions.entries()) {
    const progress = { index: index + 1, total: sessions.length, sessionId: session.header.id };
    try {
      const events = eventsForSession(session, settings.timeZone);
      const lastUserEvent = events.findLast((event) => event.kind === "user intent");
      const closingEvent = lastUserEvent || events.at(-1);
      if (!closingEvent || (range.firstDate && (closingEvent.date < range.firstDate || closingEvent.date > range.lastDate))) {
        sessionsSkipped++;
        range.onProgress?.({ ...progress, phase: "skipped", status: closingEvent ? "outside date range" : "no journalable events" });
        continue;
      }

      const journalSession = {
        ...session,
        date: closingEvent.date,
        time: closingEvent.time,
        timezone: settings.timeZone,
        project: events[0].project || "unknown project",
        events,
        sourceFingerprint: session.fingerprint || fingerprintSession(session),
      };
      Object.assign(progress, { project: journalSession.project, date: journalSession.date, time: journalSession.time });
      range.onProgress?.({ ...progress, phase: "checking", status: "checking saved summary" });
      const cached = range.dryRun
        ? await inspectSessionSummary(modelClient, settings.cacheDirectory, journalSession)
        : await saveSessionSummary(modelClient, settings.cacheDirectory, journalSession, {
          onGenerate: () => range.onProgress?.({ ...progress, phase: "summarizing", status: "summarizing with Pi; large sessions may take a few minutes" }),
        });
      if (cached.reused) summariesReused++;
      else summariesCreated++;

      const entry = {
        date: journalSession.date,
        time: journalSession.time,
        project: journalSession.project,
        sessionId: journalSession.header.id,
        cacheFingerprint: cached.cacheFingerprint,
        summaryLevel: settings.dailySummary,
        summary: cached.summary?.[settings.dailySummary],
      };
      const dailyEntry = range.dryRun
        ? await inspectDailyEntry(settings.dailyDirectory, settings.dailyHeader, entry)
        : await appendDailyEntry(settings.dailyDirectory, settings.dailyHeader, entry);
      if (dailyEntry.appended) entriesAppended++;
      else entriesSkipped++;
      dates.add(journalSession.date);
      dailyPaths.add(dailyEntry.dailyPath);
      range.onProgress?.({
        ...progress,
        phase: "complete",
        sessionPath: cached.sessionPath,
        dailyPath: dailyEntry.dailyPath,
        status: range.dryRun
          ? `${cached.reused ? "would reuse summary" : "would summarize with Pi"}, ${dailyEntry.appended ? "would append entry" : "entry already present"}`
          : `${cached.reused ? "summary reused" : "summary created"}, ${dailyEntry.appended ? "entry appended" : "entry already present"}`,
      });
    } catch (error) {
      errors.push(`${session.header.id}: ${error.message}`);
      range.onProgress?.({ ...progress, phase: "error", error: error.message });
    }
  }

  return { summariesCreated, summariesReused, entriesAppended, entriesSkipped, sessionsSkipped, dates: [...dates].sort(), dailyPaths: [...dailyPaths].sort(), errors };
}

export function parseBackfillArgument(argument = "") {
  const value = argument.trim().toLowerCase() || "3";
  if (value === "all") return { all: true };
  const days = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("Usage: logdig backfill [number-of-days|all]. Choose 1 to 3650 days, or 'all'.");
  }
  return { days };
}
