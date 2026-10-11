'use strict';

/**
 * A replay run's records, local and never in the repository:
 *
 *   <run home>/replay/<run id>/manifest.json     the run: id, config hash, harness command,
 *       broker, window, created, the last decision time done, and the days done
 *   <run home>/replay/<run id>/<trading day>.jsonl   one line per decision time:
 *       { v, t, day, kind, asked, ran: [{ action, ok, timedOut, result, symbols }], step: { code, timedOut },
 *         cycles: [{ action, at, ok, timedOut, durationMs, result, promptHash, promptChars, skills,
 *                    tools, orders, missingSkills, file }],
 *         refusals: [{ ts, source, tool, contractId, checks }],
 *         trades: [fills the broker reports in (since, t], with every field it sends], since }
 *
 * Resume: a re-run skips the days done and, inside a day left unfinished, every
 * decision time up to the last one recorded (the replay broker's clock only
 * moves forward). A run whose config hash differs is refused: a changed
 * config, harness or model is a new run id.
 *
 *   openRun(paths, { runId, hash, info, now })     the manifest (created, or checked on resume)
 *   remaining(manifest, points, recorded)           points still to run, in order (recorded: recordedTimes(runDir))
 *   appendRecord(paths, manifest, rec)              write a line, then the manifest's progress
 *   markDayDone(paths, manifest, day)
 *   readRun(runDir)                                 { manifest, days: { day: [records] } }
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

function remaining(manifest, points, recorded = new Set()) {
  const done = new Set(manifest.daysDone || []);
  // The last time recorded: the manifest's, or a line written just before a stop kept the manifest from saying so.
  let last = manifest.lastT ? Date.parse(manifest.lastT) : -Infinity;
  for (const t of recorded) last = Math.max(last, Date.parse(t)); // a loop: a long run has too many times to spread
  return points.filter(p => !done.has(p.day) && p.t.getTime() > last);
}

/** Every decision time already in the run's day files. */
function recordedTimes(runDir) {
  const out = new Set();
  let files;
  try { files = fs.readdirSync(runDir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)); } catch (_err) { return out; }
  for (const f of files) for (const l of readLines(path.join(runDir, f))) if (l.t) out.add(l.t);
  return out;
}

const dayFile = (runDir, day) => path.join(runDir, `${day}.jsonl`);

function appendRecord(paths, manifest, rec) {
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.appendFileSync(dayFile(paths.runDir, rec.day), `${JSON.stringify({ v: VERSION, ...rec })}\n`);
  manifest.lastT = rec.t;
  writeJsonAtomic(paths.manifest, manifest);
}

function markDayDone(paths, manifest, day) {
  if (!manifest.daysDone.includes(day)) manifest.daysDone.push(day);
  writeJsonAtomic(paths.manifest, manifest);
}

function readRun(runDir) {
  const manifest = readJson(path.join(runDir, 'manifest.json'), null);
  if (!manifest) throw new Error(`${runDir}: no replay run here (no manifest.json)`);
  const days = {};
  for (const f of fs.readdirSync(runDir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) days[f.slice(0, 10)] = readLines(path.join(runDir, f));
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
  };
}

/** Cycle log lines (logs/cycles-<day>.jsonl, wall-clock days) written at or after sinceMs. */
function cycleLogsSince(home, sinceMs) {
  const dir = path.join(home, 'logs');
  let files;
  try { files = fs.readdirSync(dir).filter(n => /^cycles-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort(); } catch (_err) { return []; }
  // Only files written since then (each step reads one or two, not the whole run's).
  files = files.filter(f => { try { return fs.statSync(path.join(dir, f)).mtimeMs >= sinceMs - 1000; } catch (_err) { return false; } });
  return files.flatMap(f => readLines(path.join(dir, f))).filter(l => Date.parse(l.at) >= sinceMs);
}

/** The gate's refusals (hook and gateway) logged at or after sinceMs. */
function refusalsSince(home, sinceMs) {
  return readLines(gateLogPath({ FTH_HOME: home }))
    .filter(e => e.decision === 'blocked' && Date.parse(e.ts) >= sinceMs)
    .map(e => ({ ts: e.ts, source: e.source || null, tool: e.tool || null, contractId: e.contractId || null, checks: (e.violations || []).map(v => v.check) }));
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

module.exports = { VERSION, openRun, remaining, recordedTimes, touchedSince, appendRecord, markDayDone, readRun, readLines, dayFile, cycleSummary, cycleLogsSince, refusalsSince, parseStep, promptHash };
