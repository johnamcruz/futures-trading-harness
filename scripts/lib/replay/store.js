'use strict';

/**
 * A replay run's records, local and never in the repository (a live session's are the same,
 * in <FTH_HOME>/sessions/<trading day>/: session/live.js):
 *
 *   <run home>/replay/<run id>/manifest.json     the run: id, source (replay or live), config hash, harness command,
 *       broker, window, created, the last decision time done, the days done, and finished (true once
 *       every decision time of the window ran: driver.js), and the versions of the agent that made its decisions
 *       (fingerprints, versions: session/record.js)
 *   <run home>/replay/<run id>/<trading day>.jsonl   one line per decision time:
 *       { v, t, day, kind, asked, ran: [{ action, ok, timedOut, result, symbols }], step: { code, timedOut },
 *         cycles: [{ action, at, ok, timedOut, durationMs, result, promptHash, promptChars, skills,
 *                    tools, orders, missingSkills, file }],
 *         refusals: [{ ts, source, tool, contractId, checks }],
 *         trades: [fills the broker reports in (since, t], with every field it sends], since }
 *       A replayed decision whose cycle failed is a line with `retried: true` (the attempt), and the time runs
 *       again (driver.js): the attempt never counts as recorded (resume runs the time again), the manifest
 *       says so while it is due (`cycleRetry: { t, day, kind, tries }`), and readRun folds the attempts into
 *       the line that follows at that time (`retries`), so a time is one decision however often it ran.
 *
 * Resume: a re-run skips the days done and, inside a day left unfinished, every
 * decision time up to the last one recorded (the replay broker's clock only
 * moves forward). A run whose config hash differs is refused: a changed
 * config, harness or model is a new run id.
 *
 *   openRun(paths, { runId, hash, info, now })     the manifest (created, or checked on resume)
 *   lastRecorded(manifest, recorded)                the last time recorded (ms)
 *   remaining(manifest, points, recorded)           points still to run, in order (recorded: recordedTimes(runDir))
 *   appendRecord(paths, manifest, rec)              write a line, then the manifest's progress
 *   appendAttempt(paths, manifest, rec, tries)      a failed attempt's line (retried: true); the manifest's cycleRetry
 *   setTrades(paths, day, t, trades, since)         a line's fills, set after the fact (a live session's retried read)
 *   markDayDone(paths, manifest, day)
 *   readRun(runDir)                                 { manifest, days: { day: [records] } }, attempts folded
 *   cycleLogsSince(home, sinceMs) / refusalsSince(home, sinceMs)   what a step wrote to the run home's logs
 *   cycleSummary(line)                              a cycle log line as the store keeps it
 *   parseStep(output)                               the step's "REPLAY STEP {json}" line, or null
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../harness-run');
const { gateLogPath } = require('../trading/check-order');

const VERSION = 1;

function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_err) {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_err) { /* a torn last line: skipped */ }
  }
  return out;
}

function openRun(paths, { runId, hash, info = {}, now = new Date() }) {
  const existing = readJson(paths.manifest, null);
  if (existing === null && fs.existsSync(paths.manifest)) throw new Error(`${paths.manifest} is unreadable: fix or remove the run`);
  if (existing) {
    if (existing.runId !== runId) throw new Error(`${paths.manifest} belongs to run ${existing.runId}, not ${runId}`);
    if (existing.hash !== hash) {
      throw new Error(`run ${runId} was started with another config, harness or model (config hash ${existing.hash.slice(0, 12)}, now ${hash.slice(0, 12)}): use a new runId for the changed run`);
    }
    return existing;
  }
  const manifest = { v: VERSION, runId, hash, ...info, createdAt: now.toISOString(), lastT: null, daysDone: [] };
  writeJsonAtomic(paths.manifest, manifest);
  return manifest;
}

/** The last time recorded (ms, -Infinity for none): the manifest's, or a line written just before a stop kept the manifest from saying so. */
function lastRecorded(manifest, recorded = new Set()) {
  let last = manifest.lastT ? Date.parse(manifest.lastT) : -Infinity;
  for (const t of recorded) if (Number.isFinite(Date.parse(t))) last = Math.max(last, Date.parse(t)); // a loop: a long run has too many times to spread
  return last;
}

function remaining(manifest, points, recorded = new Set()) {
  const done = new Set(manifest.daysDone || []);
  const last = lastRecorded(manifest, recorded);
  return points.filter(p => !done.has(p.day) && p.t.getTime() > last);
}

/** Every decision time already in the run's day files. */
function recordedTimes(runDir) {
  const out = new Set();
  let files;
  try { files = fs.readdirSync(runDir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)); } catch (_err) { return out; }
  for (const f of files) for (const l of readLines(path.join(runDir, f))) if (l.t && !l.retried) out.add(l.t);
  return out;
}

const dayFile = (runDir, day) => path.join(runDir, `${day}.jsonl`);

function appendRecord(paths, manifest, rec) {
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.appendFileSync(dayFile(paths.runDir, rec.day), `${JSON.stringify({ v: VERSION, ...rec })}\n`);
  manifest.lastT = rec.t;
  delete manifest.cycleRetry; // the time this line records ran: no attempt of it is due any more
  writeJsonAtomic(paths.manifest, manifest);
}

/** A failed attempt at a decision time: its line (retried: true), never its progress; the time is due again. */
function appendAttempt(paths, manifest, rec, tries) {
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.appendFileSync(dayFile(paths.runDir, rec.day), `${JSON.stringify({ v: VERSION, ...rec, retried: true })}\n`);
  manifest.cycleRetry = { t: rec.t, day: rec.day, kind: rec.kind, tries };
  writeJsonAtomic(paths.manifest, manifest);
}

/**
 * A day's lines with each failed attempt folded into the line that followed at its time (`retries`); one still
 * due is left out. The attempts' cycles join the line's (after its own, marked `attempt: true`), so an order a
 * failed attempt sent is read at its decision time and in its own cycle's window, never an earlier one's; a line
 * with such an order is tagged `failedAttemptOrders: true` (training data leaves it out).
 */
function foldAttempts(lines) {
  const out = [];
  let attempts = [];
  for (const l of lines) {
    if (l && l.retried) {
      attempts = attempts.length && attempts[0].t !== l.t ? [l] : [...attempts, l];
      continue;
    }
    const mine = attempts.filter(a => l && a.t === l.t);
    if (mine.length) {
      const extra = mine.flatMap(a => (Array.isArray(a.cycles) ? a.cycles : []).map(c => ({ ...c, attempt: true })));
      const sent = extra.some(c => Array.isArray(c.orders) && c.orders.length > 0);
      out.push({ ...l, cycles: [...(Array.isArray(l.cycles) ? l.cycles : []), ...extra], retries: mine, ...(sent ? { failedAttemptOrders: true } : {}) });
    } else out.push(l);
    attempts = [];
  }
  return out;
}

/**
 * A line's fills set after the fact (a live session's end-of-day read that failed and was retried):
 * the day file rewritten whole (written to a temporary file, then renamed), every other line as it was.
 * False when no line has time t.
 */
function setTrades(paths, day, t, trades, since) {
  const file = dayFile(paths.runDir, day);
  let found = false;
  const text = fs.readFileSync(file, 'utf8').split('\n').map(line => {
    let rec;
    try { rec = JSON.parse(line); } catch (_err) { return line; }
    if (!rec || rec.t !== t || rec.retried) return line;
    found = true;
    return JSON.stringify({ ...rec, trades, since });
  }).join('\n');
  if (!found) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return true;
}

function markDayDone(paths, manifest, day) {
  if (!manifest.daysDone.includes(day)) manifest.daysDone.push(day);
  writeJsonAtomic(paths.manifest, manifest);
}

function readRun(runDir) {
  const manifest = readJson(path.join(runDir, 'manifest.json'), null);
  if (!manifest) throw new Error(`${runDir}: no replay run here (no manifest.json)`);
  const days = {};
  for (const f of fs.readdirSync(runDir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) days[f.slice(0, 10)] = foldAttempts(readLines(path.join(runDir, f)));
  return { manifest, days };
}

/** sha256 of a cycle's prompt, from its cycle file. */
function promptHash(file) {
  const rec = readJson(file, null);
  return rec && typeof rec.prompt === 'string' ? crypto.createHash('sha256').update(rec.prompt).digest('hex') : null;
}

function cycleSummary(line) {
  return {
    action: line.action, at: line.at, ok: line.ok, timedOut: line.timedOut, durationMs: line.durationMs, result: line.result,
    promptHash: line.file ? promptHash(line.file) : null, promptChars: line.promptChars, skills: line.skills || [], tools: line.tools || {},
    orders: line.orders || [], missingSkills: line.missingSkills || [], file: line.file || null,
    // When it acted against its bar (cycle-timing.js), for the report's setup timing.
    ...(line.timing && typeof line.timing === 'object' ? { timing: line.timing } : {}),
  };
}

/** Cycle log lines (logs/cycles-<day>.jsonl, the cycle's own trading day: the replay clock's in a replay) whose wall-clock `at` is at or after sinceMs. */
function cycleLogsSince(home, sinceMs) {
  const dir = path.join(home, 'logs');
  let files;
  try { files = fs.readdirSync(dir).filter(n => /^cycles-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort(); } catch (_err) { return []; }
  // Only files written since then (each step reads one or two, not the whole run's).
  files = files.filter(f => { try { return fs.statSync(path.join(dir, f)).mtimeMs >= sinceMs - 1000; } catch (_err) { return false; } });
  return files.flatMap(f => readLines(path.join(dir, f))).filter(l => Date.parse(l.at) >= sinceMs);
}

/** A gate log entry as a line's refusal. */
const toRefusal = e => ({ ts: e.ts, source: e.source || null, tool: e.tool || null, contractId: e.contractId || null, checks: (e.violations || []).map(v => v.check) });

/** The gate's refusals (hook and gateway) logged at or after sinceMs (the home's gate log, read whole). */
function refusalsSince(home, sinceMs) {
  return readLines(gateLogPath({ FTH_HOME: home })).filter(e => e && e.decision === 'blocked' && Date.parse(e.ts) >= sinceMs).map(toRefusal);
}

/**
 * Whether a step may have acted since sinceMs: a cycle log, any gate decision
 * (an allowed order, a runner close or cancel through the gateway), or the
 * runner's state saved.
 */
function touchedSince(home, sinceMs) {
  if (cycleLogsSince(home, sinceMs).length) return true;
  if (readLines(gateLogPath({ FTH_HOME: home })).some(e => Date.parse(e.ts) >= sinceMs)) return true;
  try {
    return fs.statSync(path.join(home, 'autotrader-state.json')).mtimeMs >= sinceMs - 1000; // filesystems with whole-second times
  } catch (_err) {
    return false;
  }
}

function parseStep(output) {
  const lines = String(output || '').split('\n').filter(l => l.startsWith('REPLAY STEP '));
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1].slice('REPLAY STEP '.length));
  } catch (_err) {
    return null;
  }
}

module.exports = { VERSION, openRun, lastRecorded, remaining, recordedTimes, touchedSince, appendRecord, appendAttempt, foldAttempts, setTrades, markDayDone, toRefusal, readRun, readLines, dayFile, cycleSummary, cycleLogsSince, refusalsSince, parseStep, promptHash };
