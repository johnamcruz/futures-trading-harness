'use strict';

/**
 * The A/B comparison of two finished replay runs (scripts/ab-compare.js): a skill or rulebook change is kept only when
 * two replays of the same moments, with the same seed, show it measurably better. The training loop's paired test
 * (train/paired.js pairUp and judge) on two operator runs. A report, never a gate: nothing here refuses a run's start.
 *
 * Setup: every replay run records its setup at its fresh start (`recordSetup`, through learning/run-pins.js pinForRun):
 * <run dir>/setup.json, bound to the run by its config hash (the manifest's); a resume only notes its code, and a run
 * whose code changed mid-run is never compared. It holds the setup's hashes (replay/config.js setupHash, setupBase, setupFixed),
 * its look's arm (lookArm), and the parts compared:
 *   pinned     stage, list (the curated list's fingerprint and list, or the window without one), seed (practice's),
 *              market (symbols and timeframe), data (a digest of the replay broker's entry and settings, never a
 *              credential: replay/config.js runSettings), index (the experience index pinned, or `without`)
 *   documents  harness (the documents the cycles read) and skills digests
 *   code       the scripts' digest
 *   config     every other setting, one field each (cfg.<key>, practice.<key>, gate.<variable>, everyNth, premarket,
 *              endOfDay, prop, latency, library, libraryDisplay, and the window with a list)
 *
 * compareSetups refuses unless every pinned part is the same, the code is the same, and the setups differ in one
 * thing: the documents, or exactly one config field the operator declares (`field`; a library-display pair, the same
 * setupBase with another setupHash, is looks.js's own pair and needs no declaration). Identical setups are refused.
 *
 * Looks (learning/looks.js, run-gate.js): a run on a held-back window (practice-validate, test, final) is read only
 * through its recorded look: its learning decision (learning-run.json) and its line in the ledger, naming its setup.
 * No look is taken or spent here. A reasoning-fix look hides its outcomes: every outcome measure (R, the Monte Carlo)
 * is hidden for the pair when either run hides them.
 *
 * Measures, paired by (root, bar) through pairUp, B minus A, each with a paired bootstrap interval (90%, seeded):
 *   r-decision   realized R per decision (an entry's R, a pass 0)              interval verdict
 *   r-trade      R per trade, both runs entered                               interval verdict
 *   reads        correct-read rate (reads verified true), decisions both read  judge (McNemar)
 *   process      the scorecard's categories (scorecard.jsonl, by root and time) judge (McNemar), each category apart
 *   entries      entries taken against passed                                  descriptive
 *   skills       per skill used, correct and missed (learning/skill-usage.js, when present)   descriptive
 *   mc           stage 2: the 30-day Monte Carlo paired difference (prop/model-score.js pairRuns, when present)
 * An interval verdict needs DECISION_RULE.minPairs pairs and an interval clear of 0. The result: "B worse" when any
 * measure is, "B better" when one is and none is worse, else "no significant difference".
 *
 *   setupRecord(run, { env }), recordSetup(run, { env, fresh })   the record (written at a fresh start to <run dir>/setup.json;
 *                                       a resume notes its code); a path-valued setting is kept as its digest
 *   compareSetups(a, b, { field })      { ok, refusals, differs }
 *   readSide(dir, { env })              a run's dir, manifest, setup, look, decisions and scorecard records
 *   checkLooks(a, b, { env })           { refusals, hide, roles }
 *   compareRuns(a, b, { metrics, field, env, deps })   the report
 *   reportText(r)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { setupHash, setupBase, setupFixed, lookArm, runSettings, configHash } = require('../replay/config');
const { treeDigest, HARNESS_DIRS, CODE_DIRS } = require('../session/record');
const { CATEGORIES } = require('../replay/scorecard');
const { pairUp, judge, mcnemar, DECISION_RULE } = require('./paired');
const { readLearningRun } = require('../learning/run-gate');
const { ledgerPath } = require('../learning/looks');
const { readLedger } = require('../prop/ledger-file');
const { touchesHeldBack } = require('../learning/splits');
const { readDecisions, logFile } = require('../learning/experience-log');
const { familyRoot } = require('../trading/contracts');
const { streamFor, pick, quantile, round4 } = require('../prop/stats');
const { CREDENTIAL } = require('../broker/config');

const SETUP_FILE = 'setup.json';
const PINNED = Object.freeze(['stage', 'list', 'seed', 'market', 'data', 'index']);
const METRICS = Object.freeze(['r-decision', 'r-trade', 'reads', 'process', 'entries', 'skills', 'mc']);
const FAILURES = Object.freeze(CATEGORIES.filter(c => c !== 'right' && c !== 'unchecked'));
const LEVEL = 0.9;
const REPS = 2000;
const BETTER = 'B better';
const WORSE = 'B worse';
const NONE = 'no significant difference';

const sha = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** A value that names a path (a *_DIRS, *_DIR, *_FILE or *_PATH setting, or any absolute or ~/ path in it): kept as its digest, never the path. */
const PATHY = /(?:_DIRS|_DIR|_FILE|_PATH)$/;
const valueOf = (k, v) => {
  const j = JSON.stringify(v);
  return PATHY.test(k) || /(?:^|["\s,:=])(?:\/|~\/)/.test(j) ? `sha256:${sha(j).slice(0, 16)}` : j;
};
const flat = (prefix, obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined).map(([k, v]) => [`${prefix}.${k}`, valueOf(k, v)]));

/** The run's setup record (see the head), from its resolved config (replay/config.js resolveReplay). */
function setupRecord(run, { env = process.env } = {}) {
  const { gate, brokerEntry, brokerSettings } = runSettings(run, env);
  const { dataDir: _d, workdir: _w, symbols, timeframe, ...cfg } = run.cfg || {};
  const { seed = null, ...practice } = run.practice || {};
  const window = `${run.start.toISOString()}..${run.end.toISOString()}`;
  const arm = lookArm(run);
  const library = run.setupLibrary ? require('../learning/setup-library').readLibrary(run.setupLibrary).hash.slice(0, 16) : null;
  const digest = dirs => (run.root ? treeDigest(run.root, dirs) : null);
  return {
    // configHash: the run's own hash (its manifest's), so the record is bound to the run that wrote it.
    v: 1, runId: run.runId, configHash: configHash(run, env), setup: setupHash(run), base: setupBase(run), fixed: setupFixed(run), arm,
    pinned: {
      stage: run.stage === undefined ? null : run.stage,
      list: run.curated ? `${run.curated.fingerprint}:${run.curated.list}` : `window ${window}`,
      seed, market: JSON.stringify({ symbols: symbols || null, timeframe: timeframe || null }),
      data: sha({ broker: run.broker, brokerEntry, brokerSettings }), index: arm.replace(/\+library:.*$/, ''),
    },
    documents: { harness: digest(HARNESS_DIRS), skills: digest(['skills']) },
    code: digest(CODE_DIRS),
    config: {
      ...flat('cfg', cfg), ...flat('practice', practice), ...flat('gate', gate),
      everyNth: JSON.stringify(run.everyNth), premarket: JSON.stringify(run.premarket), endOfDay: JSON.stringify(run.endOfDay),
      prop: JSON.stringify(run.prop || null), latency: JSON.stringify(run.latency === true), library: JSON.stringify(library),
      libraryDisplay: JSON.stringify(Boolean(run.setupLibrary && run.libraryDisplay === true)),
      ...(run.curated ? { window: JSON.stringify(window) } : {}),
    },
  };
}

function writeRecord(file, rec) {
  fs.writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(rec, null, 2)}\n`);
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
  return rec;
}

/**
 * Written only at a run's fresh start. A resume never writes one (a run started without it stays without it, and is
 * never compared); it notes the code it resumed on (`resumes`), and a code change since the start marks the run
 * (`codeChanged`: never compared, its decisions came from two versions of the code).
 */
function recordSetup(run, { env = process.env, fresh, now = new Date() } = {}) {
  if (typeof fresh !== 'boolean') throw new Error('recordSetup: whether the run is fresh (seedRunHome)');
  const file = path.join(run.paths.runDir, SETUP_FILE);
  if (fresh) {
    fs.mkdirSync(run.paths.runDir, { recursive: true });
    return writeRecord(file, setupRecord(run, { env }));
  }
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return null; }
  const code = run.root ? treeDigest(run.root, CODE_DIRS) : null;
  const resumes = [...(Array.isArray(rec.resumes) ? rec.resumes : []), { at: now.toISOString(), code }];
  return writeRecord(file, { ...rec, resumes, codeChanged: rec.codeChanged === true || code !== rec.code });
}

/** Refusals when a run's setup record isn't its own (another run's, another config hash than its manifest's) or its code changed mid-run. */
function boundRefusals(side) {
  const s = side.setup;
  const out = [];
  if (s.runId !== side.runId) out.push(`run ${side.runId}: its setup record is run ${s.runId}'s`);
  if (!s.configHash || s.configHash !== side.manifest.hash) out.push(`run ${side.runId}: its setup record (config ${short(s.configHash)}) is not the run's own (manifest ${short(side.manifest.hash)})`);
  if (s.codeChanged === true || (s.resumes || []).some(r => r.code !== s.code)) out.push(`run ${side.runId}: code changed mid-run (a resume ran on other code than its start): its decisions came from two versions`);
  return out;
}

const short = x => (x === null || x === undefined ? 'none' : /^[0-9a-f]{40,}$/.test(String(x)) ? String(x).slice(0, 12) : String(x));
/** A config value as printed: a setting whose name looks like a credential never is. */
const shown = (k, v) => (CREDENTIAL.test(k.split('.').pop()) ? '(redacted)' : v === undefined ? '(unset)' : String(v).length > 60 ? `${String(v).slice(0, 57)}...` : String(v));

function compareSetups(a, b, { field = null } = {}) {
  const refusals = [];
  const differs = [];
  for (const k of PINNED) if (a.pinned[k] !== b.pinned[k]) refusals.push(`${k} differs (${short(a.pinned[k])} vs ${short(b.pinned[k])}): the runs must share it`);
  const docs = ['harness', 'skills'].filter(k => a.documents[k] !== b.documents[k]);
  for (const k of docs) differs.push(`${k} digest ${short(a.documents[k])} vs ${short(b.documents[k])}`);
  if (a.code !== b.code) {
    differs.push(`code digest ${short(a.code)} vs ${short(b.code)}`);
    refusals.push('the code (scripts/) differs too: an A/B changes the documents or one config field, on the same code');
  }
  const fields = [...new Set([...Object.keys(a.config), ...Object.keys(b.config)])].sort().filter(k => a.config[k] !== b.config[k]);
  for (const k of fields) differs.push(`${k}: ${shown(k, a.config[k])} vs ${shown(k, b.config[k])}`);
  // looks.js's library-display pair: the same setup without the display (setupBase), another setup.
  const displayPair = a.base === b.base && a.setup !== b.setup && fields.length === 1 && fields[0] === 'libraryDisplay';
  if (!docs.length && !fields.length && a.code === b.code) refusals.push(`the setups are identical (setup ${short(a.setup)}): nothing differs to compare`);
  else if (docs.length && fields.length) refusals.push(`the documents (${docs.join(', ')}) and config (${fields.join(', ')}) both differ: an A/B changes one thing`);
  else if (fields.length > 1) refusals.push(`${fields.length} config fields differ (${fields.join(', ')}): an A/B changes one`);
  else if (fields.length === 1 && !field && !displayPair) refusals.push(`config field ${fields[0]} differs: declare it (--field ${fields[0]}) to compare on it`);
  else if (fields.length === 1 && field && field !== fields[0]) refusals.push(`the declared field ${field} is not the one that differs (${fields[0]})`);
  else if (!fields.length && field) refusals.push(`the declared field ${field} does not differ${docs.length ? ` (the ${docs.join(' and ')} digests do)` : ''}`);
  return { ok: refusals.length === 0, refusals, differs };
}

/** A run dir: the one given (it holds manifest.json), or the one run under a run home's replay/. */
function runDirOf(p) {
  const abs = path.resolve(p);
  if (fs.existsSync(path.join(abs, 'manifest.json'))) return abs;
  let names = [];
  try { names = fs.readdirSync(path.join(abs, 'replay')).filter(n => fs.existsSync(path.join(abs, 'replay', n, 'manifest.json'))); } catch (_err) { /* none */ }
  if (names.length !== 1) throw new Error(`${p}: ${names.length ? `holds ${names.length} runs; give the run dir` : 'not a replay run home or run dir (no manifest.json)'}`);
  return path.join(abs, 'replay', names[0]);
}

const jsonLines = file => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch (_err) { return []; } });
  } catch (_err) {
    return null;
  }
};

function readSide(dir) {
  const runDir = runDirOf(dir);
  const home = path.resolve(runDir, '..', '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  let setup = null;
  try { setup = JSON.parse(fs.readFileSync(path.join(runDir, SETUP_FILE), 'utf8')); } catch (_err) { /* none recorded */ }
  const decisions = fs.existsSync(logFile(home)) ? readDecisions(logFile(home)).filter(d => !d.runId || d.runId === manifest.runId) : null;
  return { runDir, home, runId: manifest.runId, manifest, setup, gate: readLearningRun(runDir) || readLearningRun(home), decisions, scorecard: jsonLines(path.join(runDir, 'scorecard.jsonl')) };
}

/** One run's look: refusals when a held-back run has none, or its look is not the ledger's for this run and setup. */
function lookOf(side, env) {
  const out = [];
  const g = side.gate;
  let held = true;
  try { held = touchesHeldBack(new Date(side.manifest.start), new Date(side.manifest.end)); } catch (_err) { /* an unreadable window: held back, to be safe */ }
  if (!g || !g.look) {
    if (held) out.push(`run ${side.runId} holds held-back days (practice-validate, test or final) ${g ? 'without a look' : 'and no learning decision (learning-run.json)'}: a held-back window is read only through its look`);
    return { refusals: out, role: g ? g.role : null, hide: Boolean(g && g.hideOutcomes), look: null };
  }
  const file = g.ledger || ledgerPath(env);
  let ledger = [];
  try { ledger = readLedger(file); } catch (err) { out.push(`run ${side.runId}: its look's ledger can't be read (${err.message})`); }
  const line = ledger.find(e => e && e.kind !== 'result' && e.evaluation === g.look.evaluation && e.runId === side.runId && e.purpose === g.look.purpose);
  if (!out.length && !line) out.push(`run ${side.runId}: its ${g.look.purpose} look (evaluation ${g.look.evaluation}) is not in the ledger: no comparison outside a recorded look`);
  else if (line && side.setup && ((line.config && line.config !== side.setup.setup) || (line.setup && line.setup !== side.setup.fixed))) out.push(`run ${side.runId}: its look names setup ${short(line.config)}, not the one it recorded (${short(side.setup.setup)})`);
  return { refusals: out, role: g.role, hide: g.hideOutcomes === true, look: g.look };
}

function checkLooks(a, b, { env = process.env } = {}) {
  const la = lookOf(a, env);
  const lb = lookOf(b, env);
  const refusals = [...la.refusals, ...lb.refusals];
  if (la.role !== lb.role) refusals.push(`the runs lie in different windows (${la.role || 'none'} vs ${lb.role || 'none'})`);
  return { refusals, hide: la.hide || lb.hide, a: la, b: lb };
}

/** The mean of B minus A over pairs and its seeded percentile bootstrap interval. */
function pairedInterval(diffs, label) {
  const n = diffs.length;
  if (!n) return { n, diff: null, lo: null, hi: null };
  const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
  if (n < 2) return { n, diff: round4(mean(diffs)), lo: null, hi: null };
  const rand = streamFor(1, `ab:${label}`);
  const means = Array.from({ length: REPS }, () => { let s = 0; for (let i = 0; i < n; i += 1) s += diffs[pick(rand, n)]; return s / n; }).sort((x, y) => x - y);
  return { n, diff: round4(mean(diffs)), lo: round4(quantile(means, (1 - LEVEL) / 2)), hi: round4(quantile(means, 1 - (1 - LEVEL) / 2)) };
}

const intervalVerdict = iv => (iv.n < DECISION_RULE.minPairs ? `${NONE} (${iv.n} pairs, under ${DECISION_RULE.minPairs})` : iv.lo > 0 ? BETTER : iv.hi < 0 ? WORSE : NONE);

/** judge()'s verdict as better, worse (a harm past the tolerance or significant, or a blow) or neither. */
function judgeVerdict(pairs, targets) {
  const v = judge({ pairs, targets, failures: targets });
  if (v.verdict === 'kept') return { verdict: BETTER, why: v.reasons[0] };
  const t = v.tests;
  const harm = Object.entries(t.harm).find(([, h]) => h.c - h.b > t.harmTolerance || (h.n >= DECISION_RULE.minDiscordant && h.pWorse <= DECISION_RULE.alpha));
  if (harm || t.blows) return { verdict: WORSE, why: v.reasons[0] };
  return { verdict: NONE, why: v.reasons[0] };
}

const isR = x => typeof x === 'number' && Number.isFinite(x);

/** The experience log's lines by (root, bar): one decision each (an entry split into legs: their mean R). */
function decisionsByKey(decisions) {
  const m = new Map();
  for (const d of decisions || []) {
    if (!d || !d.root || !d.bar) continue;
    const k = `${d.root}|${d.bar}`;
    const x = m.get(k) || { key: k, composed: false, entered: false, legs: [], reads: null };
    if (d.decision && d.decision !== 'none') x.composed = true;
    if (d.decision === 'entered') { x.entered = true; x.legs.push(d.outcome && isR(d.outcome.R) ? d.outcome.R : null); }
    if (!x.reads && Array.isArray(d.reads) && d.reads.length) x.reads = d.reads;
    m.set(k, x);
  }
  for (const x of m.values()) x.R = x.entered ? (x.legs.every(isR) ? x.legs.reduce((s, r) => s + r, 0) / x.legs.length : null) : 0;
  return m;
}

/** pairUp over records of one category each; returns the pairs and B/A values by key for the keys both have. */
function paired(ma, mb, cat) {
  const recs = m => [...m.values()].map(x => ({ key: x.key, repeat: 0, category: cat(x), blow: false }));
  return pairUp(recs(ma), recs(mb));
}

const row = (measure, n, a, b, iv, verdict, test) => ({ measure, n, a: round4(a), b: round4(b), diff: iv.diff, lo: iv.lo, hi: iv.hi, verdict, test });
const avg = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function rRows(ma, mb, metrics) {
  const out = [];
  const keys = [...ma.keys()].filter(k => mb.has(k));
  if (metrics.includes('r-decision')) {
    const both = keys.filter(k => isR(ma.get(k).R) && isR(mb.get(k).R));
    const iv = pairedInterval(both.map(k => mb.get(k).R - ma.get(k).R), 'r-decision');
    out.push(row('R per decision (realized; a pass 0)', both.length, avg(both.map(k => ma.get(k).R)), avg(both.map(k => mb.get(k).R)), iv, intervalVerdict(iv), 'paired interval'));
  }
  if (metrics.includes('r-trade')) {
    const both = keys.filter(k => ma.get(k).entered && mb.get(k).entered && isR(ma.get(k).R) && isR(mb.get(k).R));
    const iv = pairedInterval(both.map(k => mb.get(k).R - ma.get(k).R), 'r-trade');
    out.push(row('R per trade (both entered)', both.length, avg(both.map(k => ma.get(k).R)), avg(both.map(k => mb.get(k).R)), iv, intervalVerdict(iv), 'paired interval'));
  }
  return out;
}

const readShare = x => x.reads.filter(r => r.check === 'true' || r.check === true).length / x.reads.length;

function readsRow(ma, mb) {
  const keys = [...ma.keys()].filter(k => ma.get(k).reads && mb.has(k) && mb.get(k).reads);
  const only = m => new Map(keys.map(k => [k, m.get(k)]));
  const pairs = paired(only(ma), only(mb), x => (readShare(x) === 1 ? 'right' : 'false read'));
  const iv = pairedInterval(keys.map(k => readShare(mb.get(k)) - readShare(ma.get(k))), 'reads');
  const j = judgeVerdict(pairs, ['false read']);
  return row('correct-read rate (decisions both read on)', keys.length, avg(keys.map(k => readShare(ma.get(k)))), avg(keys.map(k => readShare(mb.get(k)))), iv, j.verdict, `judge: ${j.why}`);
}

function entriesRow(ma, mb) {
  const keys = [...ma.keys()].filter(k => ma.get(k).composed && mb.has(k) && mb.get(k).composed);
  const e = (m, k) => (m.get(k).entered ? 1 : 0);
  const more = keys.filter(k => e(mb, k) > e(ma, k)).length;
  const fewer = keys.filter(k => e(mb, k) < e(ma, k)).length;
  const iv = pairedInterval(keys.map(k => e(mb, k) - e(ma, k)), 'entries');
  const p = Math.min(mcnemar(more, fewer), mcnemar(fewer, more));
  const verdict = p <= DECISION_RULE.alpha && more !== fewer ? `B enters ${more > fewer ? 'more' : 'less'} (descriptive)` : 'descriptive';
  return row(`entry rate (taken of composed; B took ${more} A passed, ${fewer} the reverse)`, keys.length, avg(keys.map(k => e(ma, k))), avg(keys.map(k => e(mb, k))), iv, verdict, `McNemar p ${round4(p)}`);
}

/** The scorecard's records by root and decision time. */
function scoreRecords(records) {
  return (records || []).filter(r => r && r.t && r.symbol && r.category).map(r => ({ key: `${familyRoot(String(r.symbol))}|${r.t}`, repeat: 0, category: r.category, blow: false }));
}

function processRows(sa, sb) {
  const pairs = pairUp(scoreRecords(sa), scoreRecords(sb));
  const judged = pairs.filter(p => !p.base.implicit && p.base.category !== 'unchecked');
  const right = c => (c.category === 'right' ? 1 : 0);
  const iv = pairedInterval(judged.map(p => right(p.cand) - right(p.base)), 'process');
  const v = judge({ pairs, targets: FAILURES, failures: FAILURES });
  const j = judgeVerdict(pairs, FAILURES);
  const out = [row('process adherence (scorecard right)', judged.length, avg(judged.map(p => right(p.base))), avg(judged.map(p => right(p.cand))), iv, j.verdict, `judge: ${j.why}`)];
  for (const [k, h] of Object.entries(v.tests.harm)) {
    if (!h.b && !h.c) continue;
    out.push({ measure: `  ${k}: fixed ${h.b}, broken ${h.c}`, n: judged.length, a: null, b: null, diff: null, lo: null, hi: null, verdict: h.n >= DECISION_RULE.minDiscordant && h.pWorse <= DECISION_RULE.alpha ? 'more failures (descriptive)' : h.n >= DECISION_RULE.minDiscordant && h.pBetter <= DECISION_RULE.alpha ? 'fewer failures (descriptive)' : 'descriptive', test: `McNemar p better ${h.pBetter}, worse ${h.pWorse}` });
  }
  return out;
}

/** Per skill, B minus A: used (of available), correct (of reads) and missed. Descriptive. */
function skillRows(ua, ub) {
  const by = u => new Map((u.skills || []).map(s => [s.skill, s]));
  const [a, b] = [by(ua), by(ub)];
  const z = { usedRate: null, correctRate: null, missed: 0, used: 0, available: 0, correct: 0, reads: 0 };
  return [...new Set([...a.keys(), ...b.keys()])].sort().map(k => {
    const x = a.get(k) || z;
    const y = b.get(k) || z;
    const d = (p, q) => (p === null || q === null ? '-' : `${q - p > 0 ? '+' : ''}${round4(q - p)}`);
    return { measure: `  skill ${k}: used ${d(x.usedRate, y.usedRate)}, correct ${d(x.correctRate, y.correctRate)}, missed ${d(x.missed, y.missed)}`, n: null, a: null, b: null, diff: null, lo: null, hi: null, verdict: 'descriptive', test: `used ${x.used}/${x.available} -> ${y.used}/${y.available}, correct ${x.correct}/${x.reads} -> ${y.correct}/${y.reads}` };
  });
}

/** The default skill-usage reader: the run's report (learning/skill-usage.js readSkillUsage). */
const defaultSkillUsage = () => dir => require('../learning/skill-usage').readSkillUsage(dir); // lazy: only a skills row loads it

/** The default paired Monte Carlo: prop/model-score.js pairRuns when this branch has it, else null (N/A). */
function defaultMc({ root, env, account }) {
  let m;
  try { m = require('../prop/model-score'); } catch (_err) { return null; }
  if (typeof m.pairRuns !== 'function') return null;
  return (a, b) => {
    const { loadAccounts, accountNamed } = require('../trading/accounts');
    const { strategies } = require('../trading/strategies').loadStrategies(root, env);
    let runner = {};
    try { runner = JSON.parse(fs.readFileSync(path.join(a.runDir, 'autotrader.json'), 'utf8')) || {}; } catch (_err) { /* none */ }
    const p = m.resolveAccount({ override: account, runnerAccount: runner.account, strategies, accounts: loadAccounts(root, env).accounts });
    if (!p.name) throw new Error(p.why);
    const acc = accountNamed(root, p.name, env);
    return m.pairRuns(a.runDir, b.runDir, { root, env, account: acc, policy: m.policyFor ? m.policyFor(strategies, acc.name) : null });
  };
}

/** pairRuns' result (A minus B) as rows of B minus A. */
function mcRows(r) {
  const neg = x => (x === null || x === undefined ? null : round4(-x));
  const iv = i => ({ diff: neg(i.diff), lo: neg(i.hi), hi: neg(i.lo) });
  const d = r.diff.resampled;
  const v = r.verdict === 'A better' ? WORSE : r.verdict === 'B better' ? BETTER : NONE;
  const one = (measure, i, a, b, verdict) => ({ measure, n: i.n === undefined ? null : i.n, a: round4(a), b: round4(b), ...iv(i), verdict, test: 'paired Monte Carlo (resampled paths)' });
  return [
    one('MC pass within 30 days', d.passRate, r.a.resampled.passRate, r.b.resampled.passRate, v),
    one('MC blow rate', d.blowRate, r.a.resampled.blowRate, r.b.resampled.blowRate, v),
    one('MC median days to pass', d.medianDaysToPass, r.a.resampled.medianDaysToPass, r.b.resampled.medianDaysToPass, 'descriptive'),
  ];
}

const na = (measure, why) => ({ measure, n: null, a: null, b: null, diff: null, lo: null, hi: null, verdict: 'N/A', test: why });

/**
 * The comparison of two run dirs (or homes): refused (with what differs) unless their setups pair and their looks
 * allow it; else the rows and the one-line result. deps: { skillUsage(dir), mc(sideA, sideB) } (tests), defaults above.
 */
function compareRuns(dirA, dirB, { metrics = METRICS, field = null, env = process.env, root = null, account = null, deps = {} } = {}) {
  const unknown = metrics.filter(m => !METRICS.includes(m));
  if (unknown.length) throw new Error(`--metric: one of ${METRICS.join(', ')}; not ${unknown.join(', ')}`);
  const a = readSide(dirA);
  const b = readSide(dirB);
  const head = { a: a.runId, b: b.runId };
  const refusals = [];
  for (const s of [a, b]) {
    if (s.manifest.finished !== true) refusals.push(`run ${s.runId} is not finished: compare finished runs`);
    if (!s.setup) refusals.push(`run ${s.runId} has no setup record (${SETUP_FILE}: written only at a run's fresh start, since the A/B comparison; a run started before it, even if resumed since, has none); its setup can't be checked`);
    else refusals.push(...boundRefusals(s));
  }
  const setups = a.setup && b.setup ? compareSetups(a.setup, b.setup, { field }) : { refusals: [], differs: [] };
  const looks = checkLooks(a, b, { env });
  refusals.push(...setups.refusals, ...looks.refusals);
  if (refusals.length) return { ...head, refused: true, refusals, differs: setups.differs };
  const rows = [];
  const hidden = 'hidden: a reasoning-fix look hides outcomes';
  const ma = decisionsByKey(a.decisions);
  const mb = decisionsByKey(b.decisions);
  const logs = a.decisions && b.decisions;
  for (const m of ['r-decision', 'r-trade'].filter(x => metrics.includes(x))) {
    if (looks.hide) rows.push(na(m === 'r-decision' ? 'R per decision' : 'R per trade', hidden));
    else if (!logs) rows.push(na(m, 'no experience log on both runs (replay.js experience)'));
    else rows.push(...rRows(ma, mb, [m]));
  }
  if (metrics.includes('reads')) rows.push(logs ? readsRow(ma, mb) : na('correct-read rate', 'no experience log on both runs'));
  if (metrics.includes('process')) rows.push(...(a.scorecard && b.scorecard ? processRows(a.scorecard, b.scorecard) : [na('process adherence', 'no scorecard.jsonl in both run dirs (replay.js scorecard)')]));
  if (metrics.includes('entries')) rows.push(logs ? entriesRow(ma, mb) : na('entry rate', 'no experience log on both runs'));
  if (metrics.includes('skills')) {
    const usage = deps.skillUsage === undefined ? defaultSkillUsage() : deps.skillUsage;
    if (!usage) rows.push(na('skill usage', 'no skill-usage reader given'));
    else {
      try { rows.push(...skillRows(usage(a.runDir), usage(b.runDir))); } catch (err) { rows.push(na('skill usage', err.message)); }
    }
  }
  if (metrics.includes('mc')) {
    const stage = a.setup.pinned.stage;
    const mc = deps.mc === undefined ? defaultMc({ root, env, account }) : deps.mc;
    if (stage !== 2) rows.push(na('30-day Monte Carlo', `stage 2 runs only (stage ${stage === null ? 'none' : stage})`));
    else if (looks.hide) rows.push(na('30-day Monte Carlo', hidden));
    else if (!mc) rows.push(na('30-day Monte Carlo', 'the paired Monte Carlo (prop/model-score.js pairRuns) is not on this branch'));
    else {
      try { rows.push(...mcRows(mc(a, b))); } catch (err) { rows.push(na('30-day Monte Carlo', err.message)); }
    }
  }
  const verdicts = rows.map(r => r.verdict);
  const result = verdicts.includes(WORSE) ? WORSE : verdicts.includes(BETTER) ? BETTER : NONE;
  return { ...head, refused: false, differs: setups.differs, looks: { a: looks.a.look, b: looks.b.look, hidden: looks.hide }, rows, result };
}

const f = x => (x === null || x === undefined ? '-' : String(x));

function reportText(r) {
  const lines = [`A/B compare: A ${r.a} vs B ${r.b} (B minus A)`];
  if (r.differs && r.differs.length) lines.push(`differs: ${r.differs.join('; ')}`);
  if (r.refused) return `${[...lines, 'refused:', ...r.refusals.map(x => `- ${x}`)].join('\n')}\n`;
  const look = l => (l ? `${l.purpose} look ${l.evaluation}` : 'no look');
  lines.push(`looks: A ${look(r.looks.a)}, B ${look(r.looks.b)}${r.looks.hidden ? ' (outcomes hidden)' : ''}`);
  lines.push('| measure | n | A | B | B - A [90%] | verdict | test |', '|---|---|---|---|---|---|---|');
  for (const x of r.rows) lines.push(`| ${x.measure} | ${f(x.n)} | ${f(x.a)} | ${f(x.b)} | ${x.diff === null || x.diff === undefined ? '-' : `${x.diff} [${f(x.lo)}, ${f(x.hi)}]`} | ${x.verdict} | ${x.test} |`);
  lines.push(`Result: ${r.result}`);
  return `${lines.join('\n')}\n`;
}

module.exports = { SETUP_FILE, PINNED, METRICS, BETTER, WORSE, NONE, setupRecord, recordSetup, compareSetups, readSide, checkLooks, pairedInterval, decisionsByKey, skillRows, compareRuns, reportText };
