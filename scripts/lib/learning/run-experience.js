'use strict';

/**
 * A finished replay run's experience log (experience-log.js), read from what the run wrote: the store lines (each
 * trade cycle that ran, the fills, the gate's refusals), the trade_lifecycle records in the run home
 * (lifecycle-record.js), and the replayed bars (the run's own bars files, or --bars data as the labels read it).
 * Written to <run home>/experience/decisions.jsonl, never the repository.
 *
 * Only a learning run that passed the gate (learning/run-gate.js, <run home>/learning-run.json) has one: its window
 * and its look were decided before its first cycle. A run declared not learning, or started before the gate, is
 * refused, so it never teaches. A run on a reasoning-fix look keeps its decisions with their outcomes hidden.
 *
 *   runDecisions(runDir, { root, barsFiles, now })        the run's decisions and what they were read from, nothing written
 *   writeRunExperience(runDir, { root, barsFiles, now })   { file, added, kept, decisions, role, hidden }
 *   experienceLine(result)                                 the CLI's one line
 */

const path = require('path');
const { readRun } = require('../replay/store');
const labels = require('../replay/labels');
const { specFor, familyRoot } = require('../trading/contracts');
const { readRecords } = require('./lifecycle-record');
const { buildDecisions, appendDecisions, logFile, legsOf } = require('./experience-log');
const { roleOf } = require('./splits');
const { readLearningRun } = require('./run-gate');

const ENTRY_TOOL = /(?:^|__)place_order$/;

/**
 * A finished run's decisions, built from what it wrote (the module header), nothing appended: { dir, home, manifest,
 * days (the store's, by day), dayKeys, gate (learning-run.json, or null), cfg, tfMs, decisions, barsFor, trips (every
 * round trip leg of the run's fills, credited to a record or not) }. The
 * experience log and the prop Monte Carlo (prop/model-stream.js) read a run through this one function. Throws on an
 * unfinished run or one with no days.
 */
function runDecisions(runDir, { root = null, barsFiles = {}, now = new Date() } = {}) {
  const dir = labels.realDir(runDir);
  const home = path.resolve(dir, '..', '..');
  if (root && labels.inside(home, root)) throw new Error(`${home} is inside the repository (${root}): a run's records live in its run home`);
  const { manifest, days } = readRun(dir);
  // The run record keeps the gate's decision (run-gate.js); a run home's copy only for a run started before it did.
  const gate = readLearningRun(dir) || readLearningRun(home);
  const why = labels.unfinishedWhy(manifest, days);
  if (why) throw new Error(`run ${manifest.runId} is not finished (${why}): its decisions hold outcomes, read after the run's last day`);
  const dayKeys = Object.keys(days).sort();
  if (!dayKeys.length) throw new Error(`run ${manifest.runId} has no days`);
  const cfg = labels.configsOf(dir, manifest)(null);
  const tf = Number(cfg.timeframe) || null;
  const tfMs = tf ? tf * 60000 : 0;
  const roots = (Array.isArray(cfg.symbols) ? cfg.symbols : []).map(familyRoot);
  const lines = dayKeys.flatMap(d => days[d]).filter(r => r && Number.isFinite(Date.parse(r.t))).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const cycles = lines.filter(r => r.kind === 'trade' && Array.isArray(r.cycles) && r.cycles.length).map(r => ({ at: r.t, roots }));
  const gateRefusals = lines.flatMap(r => (Array.isArray(r.refusals) ? r.refusals : [])
    .filter(x => x && ENTRY_TOOL.test(String(x.tool || '')))
    .map(x => ({ cycleAt: r.t, root: null, check: (x.checks || []).join(',') || 'refused' })));
  const cache = labels.translatorCache(require('../broker/config').contractsCacheFiles(manifest.broker || '', { FTH_HOME: home }));
  const trips = legsOf(labels.roundTrips(labels.allFills(lines), cache));
  const outcomeBars = labels.outcomeBarsFor(dir, barsFiles);
  const bars = new Map();
  const barsFor = r => {
    if (!bars.has(r)) bars.set(r, labels.outcomeFor(outcomeBars, r, tf) || labels.loadBars(home, r, tf));
    return bars.get(r);
  };
  const decisions = buildDecisions({
    cycles, records: readRecords(home, { runId: manifest.runId }), trips, gateRefusals, barsFor, tfMs,
    tickOf: r => (specFor(r) ? specFor(r).tickSize : null), eodOf: ms => labels.eodOf(cfg, ms), runId: manifest.runId, now,
  });
  return { dir, home, manifest, days, dayKeys, gate, cfg, tfMs, decisions, barsFor, trips };
}

function writeRunExperience(runDir, { root = null, barsFiles = {}, now = new Date() } = {}) {
  const run = runDecisions(runDir, { root, barsFiles, now });
  const { manifest, gate, dayKeys, home } = run;
  if (!gate || gate.learning !== true) throw new Error(`run ${manifest.runId} is ${gate ? 'declared not learning' : 'not a learning run (no learning-run.json: started before the gate)'}: no experience log`);
  const outside = dayKeys.filter(d => roleOf(d) !== gate.role);
  if (outside.length) throw new Error(`run ${manifest.runId} started in ${gate.role} but holds ${outside[0]} (${roleOf(outside[0])})`);
  let { decisions } = run;
  // A reasoning-fix look: the decisions without what came after them.
  if (gate.hideOutcomes) decisions = decisions.map(d => ({ ...d, outcome: null, grade: null, hidden: true }));
  const file = logFile(home);
  const { added, kept } = appendDecisions(file, decisions);
  return { file, added, kept, decisions, role: gate.role, hidden: Boolean(gate.hideOutcomes) };
}

const experienceLine = r => `experience: ${r.added} decision(s) added, ${r.kept} already logged (${r.role}${r.hidden ? ', outcomes hidden: a reasoning-fix look' : ''}) in ${r.file}`;

module.exports = { runDecisions, writeRunExperience, experienceLine };
