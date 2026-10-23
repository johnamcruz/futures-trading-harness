'use strict';

/**
 * A finished replay run's experience log (experience-log.js), read from what the run wrote: the store lines (each
 * trade cycle that ran, the fills, the gate's refusals), the trade_lifecycle records in the run home
 * (lifecycle-record.js), the gateway's stamps on the entries it placed (entry-orders.json), and the replayed bars
 * (the run's own bars files, or --bars data as the labels read it).
 * Written to <run home>/experience/decisions.jsonl, never the repository.
 *
 * Only a learning run that passed the gate (learning/run-gate.js, <run home>/learning-run.json) has one: its window
 * and its look were decided before its first cycle. A run declared not learning, or started before the gate, is
 * refused, so it never teaches. A run on a reasoning-fix look keeps its decisions with their outcomes hidden.
 *
 *   runDecisions(runDir, { root, barsFiles, now })        the run's decisions and what they were read from, nothing written;
 *                                                          each tagged with the run's exit as its manifest recorded
 *                                                          it at seed time (manifestExit), its passes' counterfactuals
 *                                                          held under it: never the repository's exit when it is read
 *   runExit(root, env)                                     the exit the harness manages composed trades by now (the
 *                                                          driver records it in a new run's manifest)
 *   manifestExit(manifest)                                 a run's recorded exit ({ mode, plan, hash }); a run started
 *                                                          before the record: its brackets, hash null (untagged)
 *   plannedExit(run, { root, env })                        the exit a replay run trades: its manifest's once started,
 *                                                          else the one its seed will record (the preflight's)
 *   writeRunExperience(runDir, { root, barsFiles, now })   { file, added, kept, decisions, role, hidden }
 *   experienceLine(result)                                 the CLI's one line
 */

const fs = require('fs');
const path = require('path');
const { readRun } = require('../replay/store');
const { entryOrders } = require('../harness-run');
const labels = require('../replay/labels');
const { specFor, familyRoot } = require('../trading/contracts');
const { readRecords } = require('./lifecycle-record');
const { buildDecisions, appendDecisions, logFile, legsOf, BRACKETS, exitHash, exitRecord } = require('./experience-log');
const { roleOf } = require('./splits');
const { readLearningRun } = require('./run-gate');
const { curatedLog } = require('./experience-index');

const ENTRY_TOOL = /(?:^|__)place_order$/;

/**
 * A finished run's decisions, built from what it wrote (the module header), nothing appended: { dir, home, manifest,
 * days (the store's, by day), dayKeys, gate (learning-run.json, or null), cfg, tfMs, decisions, barsFor, trips (every
 * round trip leg of the run's fills, credited to a record or not) }. The
 * experience log and the prop Monte Carlo (prop/model-stream.js) read a run through this one function. Throws on an
 * unfinished run or one with no days.
 */
/**
 * The exit the run's composed trades are managed by (evaluator.js composedExit, as the runner manages them): its plan
 * for the counterfactuals and its mode for each line's tag. Read from the harness's strategies (`root`, else this one).
 */
function runExit(root, env = process.env) {
  const { loadStrategies, composedExit } = require('../trading/strategies');
  const strategies = loadStrategies(root || path.resolve(__dirname, '..', '..', '..'), env).strategies;
  const composed = strategies.find(s => s.valid && s.signal === 'composed');
  return composed ? composedExit(composed, strategies) : BRACKETS;
}

/**
 * The run's exit as its manifest recorded it at seed time ({ mode, plan, hash }), its hash checked. A run started
 * before the record: its brackets (the experience log's counterfactual then), with no hash: its lines are untagged.
 */
function manifestExit(manifest) {
  const e = manifest && manifest.exit;
  if (e === undefined || e === null) return { ...BRACKETS, hash: null };
  if (!e || typeof e !== 'object' || typeof e.mode !== 'string' || e.hash !== exitHash(e)) {
    throw new Error(`run ${manifest.runId}: its manifest's exit plan doesn't match its hash: the run's exit can't be told`);
  }
  return { mode: e.mode, plan: e.plan || null, hash: e.hash };
}

/** The exit a replay run trades: its manifest's once the run has started (a resume), else what its seed will record. */
function plannedExit(run, { root = null, env = process.env } = {}) {
  const file = run && run.paths && run.paths.manifest;
  let manifest;
  try { manifest = file ? JSON.parse(require('fs').readFileSync(file, 'utf8')) : null; } catch (_err) { manifest = null; }
  return manifest ? manifestExit(manifest) : exitRecord(runExit(root, env));
}

/**
 * The head trader's delivery keys a run was made under (autotrader.js headDeliveryOf: HEAD_DELIVERY_KEYS present and
 * truthy), from its setup record and every runner config it ran with (autotrader.json and any later version a resume
 * recorded in its manifest), or null when none is on. A run under two (a resume that changed one) throws: its decisions
 * can't be given one delivery. Every learning record built from the run's decisions carries it, so key-on decisions are
 * never pooled with key-off ones (the experience index, the risk record, the decision dataset refuse a mix).
 */
function runDelivery(dir, manifest = null) {
  const { headDeliveryOf } = require('../autotrader');
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_err) { return null; } };
  const setup = read('setup.json');
  const names = ['autotrader.json', ...((manifest && Array.isArray(manifest.versions) ? manifest.versions : []).map(v => v && v.config).filter(n => typeof n === 'string' && /^autotrader-[A-Za-z0-9-]+\.json$/.test(n)))];
  const per = [...new Set(names.map((n, i) => headDeliveryOf(i === 0 ? setup : null, read(n)) || 'none'))];
  if (per.length > 1) throw new Error(`run ${(manifest && manifest.runId) || dir} ran under ${per.length} head trader deliveries (${per.join(' | ')}): its decisions can't be given one`);
  return per[0] === 'none' ? null : per[0];
}

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
  // The gateway's stamp on each composed entry it placed: the record it judged, by order id (the run home's
  // entry-orders.json), so a trade is credited to that record, never to one composed after it.
  const stamps = Object.fromEntries(entryOrders(home).filter(e => e.composed && e.composed.record).map(e => [String(e.orderId), String(e.composed.record)]));
  const trips = legsOf(labels.roundTrips(labels.allFills(lines), cache));
  const outcomeBars = labels.outcomeBarsFor(dir, barsFiles);
  const bars = new Map();
  const barsFor = r => {
    if (!bars.has(r)) bars.set(r, labels.outcomeFor(outcomeBars, r, tf) || labels.loadBars(home, r, tf));
    return bars.get(r);
  };
  const decisions = buildDecisions({
    cycles, records: readRecords(home, { runId: manifest.runId }), trips, stamps, gateRefusals, barsFor, tfMs,
    tickOf: r => (specFor(r) ? specFor(r).tickSize : null), eodOf: ms => labels.eodOf(cfg, ms), runId: manifest.runId, now, exit: manifestExit(manifest),
  });
  // The head trader's delivery keys the run was made under (runDelivery), on each decision only when one is on.
  const delivery = runDelivery(dir, manifest);
  return { dir, home, manifest, days, dayKeys, gate, cfg, tfMs, decisions: delivery ? decisions.map(d => ({ ...d, delivery })) : decisions, delivery, barsFor, trips };
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
  // A curated run's moments are outcome-balanced: tagged, so the experience index weighs them (curated-weights.js).
  if (curatedLog(logFile(home))) decisions = decisions.map(d => ({ ...d, curated: true }));
  const file = logFile(home);
  const { added, kept } = appendDecisions(file, decisions);
  return { file, added, kept, decisions, role: gate.role, hidden: Boolean(gate.hideOutcomes) };
}

const experienceLine = r => `experience: ${r.added} decision(s) added, ${r.kept} already logged (${r.role}${r.hidden ? ', outcomes hidden: a reasoning-fix look' : ''}) in ${r.file}`;

module.exports = { runDelivery, runDecisions, writeRunExperience, experienceLine, runExit, manifestExit, plannedExit };
