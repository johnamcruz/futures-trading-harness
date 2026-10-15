'use strict';

/**
 * The experience index (the composed-entry design, section 4.3): code's record of the experience log
 * (experience-log.js), per signature and context, which experience_lookup shows the model. Built between sessions,
 * never by the runner; frozen per run (pinIndex: the run home holds its own copy and its hash).
 *
 * Walk-forward: the index keeps each cell's decisions as rows ([day, R, entered, regime]), not finished statistics,
 * and every statistic is computed for a day (cellStats `before`): only from trading days strictly before it. A
 * practice run in 2022 is shown what happened before its bar's session, never after, though the index spans
 * 2020-2024. The examples are kept with their days and filtered the same way.
 *
 * Cells, for each signature kind (skill, read) and each decision:
 *   <kind>|<signature>|*                   the signature in any context
 *   <kind>|<signature>|<key>=<value>       one context key at a time (CONTEXT_KEYS)
 *   <kind>|<signature>|<the full context>  every key, `regime=..;volatility=..;...`
 * Per cell, at a day: n (decisions with an R), entries and passes apart, unfilled (no R), distinct days, wins, the win
 * rate and the mean R each with a 90% interval from resampling whole trading days (a day's cluster counts once;
 * every cell is one of many, so an interval describes and never proves), first and last day seen, the split by year
 * and by regime, and `shifted` when the latest year, itself at least MIN_N decisions over MIN_DAYS days, has the
 * other sign from the whole. A cell under MIN_N decisions or MIN_DAYS distinct days (D16) shows its counts and
 * `too few samples (n=7, 3 days)`, no rate or mean.
 *
 * Shuffled (the paired replay's third arm): `shuffle` (a seed) permutes the cells' rows across cells and the
 * examples across signatures, so the record shows numbers that belong to other combinations; it is part of the hash.
 *
 * No leakage: an index is built only from practice-train decisions (learning/splits.js), the day recomputed from
 * the decision's bar (its cycle for a plain pass), never the line's own label, and the day its outcome came (its
 * exit's session) practice-train too. Rows are dated by the later of the two (knownDay). A decision counts once (by
 * its id); the same log given twice (its sha256) is refused.
 *
 *   buildIndex(decisions, { runs, seed, reps, shuffle, now })   the index document, with its hash and its `exit` (the one
 *                                       exit mode its decisions were scored under; decisions under two are refused)
 *   cellStats(rows, { before, seed, reps, key })   the statistics of a cell's rows before a day (null: every row)
 *   cellAt(index, key, before)          cellStats of an index's cell, or null when the cell has no rows
 *   examplesBefore(index, skillSig, before)   the examples before a day, latest first
 *   indexHash(doc), writeIndex(dir, doc), readIndex(file)
 *   pinIndex(runHome, file)             the run's own frozen copy (pinned.json); a run keeps the index it pinned
 *   armOf(file)                         the arm a run pinning it is (with:<hash>, shuffled:<hash>; no file: without)
 *   loadPinned(home)                    the pinned index, its hash checked; null when none is pinned or the run is
 *                                       declared not learning
 *   cellKey(kind, sig, ctx), contextKey(ctx), decisionDay(d), knownDay(d)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { streamFor, pick, quantile, round4 } = require('../prop/stats');
const { roleOf, sessionDate } = require('./splits');
const { CONTEXT_KEYS } = require('./lifecycle-record');

const VERSION = 2;
const MIN_N = 20;
const MIN_DAYS = 10;
const LEVEL = 0.9;
const KINDS = Object.freeze(['skill', 'read']);
const PINNED = 'pinned.json';
/** Examples kept per skill signature and month (the latest of each), so a lookup on any day finds some before it. */
const EXAMPLES_PER_MONTH = 4;
const WHY_CHARS = 160;

const ctxVal = (ctx, k) => (ctx && ctx[k] !== null && ctx[k] !== undefined ? ctx[k] : '-');
const contextKey = ctx => CONTEXT_KEYS.map(k => `${k}=${ctxVal(ctx, k)}`).join(';');
const cellKey = (kind, sig, ctx = '*') => `${kind}|${sig}|${ctx}`;
const hasR = d => d.outcome && Number.isFinite(d.outcome.R);

/** A decision's trading day, from its bar (its cycle for a plain pass); its own `day` only when it has neither. */
function decisionDay(d) {
  const t = Date.parse(d.bar || d.cycleAt || '');
  return Number.isFinite(t) ? sessionDate(t) : d.day;
}

/**
 * The day a decision's outcome is known: the later of its own session and its exit's (a position carried into a later
 * session settles there), recomputed from its outcome, never the line's label. Rows and examples are dated by it, so
 * a walk-forward statistic never counts a trade whose outcome came on or after the day it is shown on.
 */
function knownDay(d) {
  const day = decisionDay(d);
  const t = d.outcome && d.outcome.exitTime ? Date.parse(d.outcome.exitTime) : NaN;
  if (!Number.isFinite(t)) return day;
  const exit = sessionDate(t - 1);
  return exit > day ? exit : day;
}

/** Ratio statistics over resampled whole days: { lo, hi } of sum(num) / sum(den) at LEVEL. */
function dayBootstrap(days, num, den, { reps, rand }) {
  const D = days.length;
  const ratios = new Array(reps);
  for (let r = 0; r < reps; r += 1) {
    let s = 0;
    let c = 0;
    for (let k = 0; k < D; k += 1) {
      const j = pick(rand, D);
      s += num[j];
      c += den[j];
    }
    ratios[r] = s / c;
  }
  ratios.sort((a, b) => a - b);
  const tail = (1 - LEVEL) / 2;
  return { lo: round4(quantile(ratios, tail)), hi: round4(quantile(ratios, 1 - tail)) };
}

const sumBy = (rows, f) => {
  const g = {};
  for (const r of rows) {
    const k = f(r);
    g[k] = g[k] || { n: 0, sum: 0, days: new Set() };
    g[k].n += 1;
    g[k].sum += r[1];
    g[k].days.add(r[0]);
  }
  return g;
};

/** A cell's statistics from its rows ([day, R, entered, regime]) on days strictly before `before` (null: all). */
function cellStats(rows, { before = null, seed = 1, reps = 2000, key = '' } = {}) {
  const seen = (rows || []).filter(r => before === null || r[0] < before);
  const withR = seen.filter(r => Number.isFinite(r[1]));
  const n = withR.length;
  const byDay = new Map();
  for (const r of withR) {
    const x = byDay.get(r[0]) || { sum: 0, n: 0, wins: 0 };
    x.sum += r[1];
    x.n += 1;
    x.wins += r[1] > 0 ? 1 : 0;
    byDay.set(r[0], x);
  }
  const days = [...new Set(seen.map(r => r[0]))].sort();
  const wins = withR.filter(r => r[1] > 0).length;
  const years = sumBy(withR, r => r[0].slice(0, 4));
  const fmt = g => Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, { n: v.n, meanR: round4(v.sum / v.n) }]));
  const cell = {
    n, entries: withR.filter(r => r[2] === 1).length, passes: withR.filter(r => r[2] !== 1).length, unfilled: seen.length - n,
    days: byDay.size, wins, firstSeen: days[0] || null, lastSeen: days[days.length - 1] || null,
    byYear: fmt(years), byRegime: fmt(sumBy(withR, r => r[3] || '-')), before,
  };
  if (n < MIN_N || byDay.size < MIN_DAYS) return { ...cell, enough: false, note: `too few samples (n=${n}, ${byDay.size} days)`, winRate: null, meanR: null, shifted: false, latestYear: null };
  const mean = withR.reduce((a, r) => a + r[1], 0) / n;
  const list = [...byDay.values()];
  const rand = streamFor(seed, `${key}|${before}`);
  const meanR = { mean: round4(mean), ...dayBootstrap(list, list.map(d => d.sum), list.map(d => d.n), { reps, rand }), level: LEVEL, by: 'day' };
  const winRate = { rate: round4(wins / n), ...dayBootstrap(list, list.map(d => d.wins), list.map(d => d.n), { reps, rand }), level: LEVEL, by: 'day' };
  const ys = Object.keys(years).sort();
  const y = ys.length > 1 ? years[ys[ys.length - 1]] : null;
  const latestYear = y ? { year: ys[ys.length - 1], n: y.n, days: y.days.size, meanR: round4(y.sum / y.n) } : null;
  const shifted = Boolean(latestYear && latestYear.n >= MIN_N && latestYear.days >= MIN_DAYS && latestYear.meanR !== 0 && mean !== 0 && Math.sign(latestYear.meanR) !== Math.sign(mean));
  return { ...cell, enough: true, note: null, winRate, meanR, shifted, latestYear };
}

const cellAt = (index, key, before = null) => (index.cells[key] ? cellStats(index.cells[key], { before, seed: index.seed, reps: index.reps, key }) : null);

/** The examples of a skill signature on days strictly before `before`, latest first. */
const examplesBefore = (index, sig, before = null) => ((index.examples || {})[sig] || []).filter(e => before === null || e.day < before);

/** Throws unless every decision's day (recomputed from its bar) is practice-train. */
function assertPracticeTrain(decisions) {
  const bad = new Map();
  for (const d of decisions) {
    // Its own day and the day its outcome came: both practice-train.
    for (const day of new Set([decisionDay(d), knownDay(d)])) {
      let role;
      try { role = roleOf(day); } catch (_err) { role = 'no role'; }
      if (role !== 'practice-train') { bad.set(role, (bad.get(role) || 0) + 1); break; }
    }
  }
  if (bad.size) throw new Error(`index refused (leakage): ${[...bad].map(([r, k]) => `${k} decision(s) in ${r}`).join(', ')}; an index is built from practice-train months only`);
}

function examplesOf(scored) {
  const by = new Map();
  const withR = scored.filter(hasR).map(d => ({ d, day: knownDay(d) }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : String(a.d.id).localeCompare(String(b.d.id))));
  for (const { d, day } of withR) {
    const k = d.signatures.skill;
    if (!by.has(k)) by.set(k, []);
    const list = by.get(k);
    if (list.filter(e => e.day.slice(0, 7) === day.slice(0, 7)).length >= EXAMPLES_PER_MONTH) continue;
    list.push({
      day, decision: d.decision, side: d.side || null, context: d.context || null,
      reads: (Array.isArray(d.reads) ? d.reads : []).map(r => ({ step: r.step, skill: r.skill, read: r.read, why: r.why ? String(r.why).slice(0, WHY_CHARS) : null })),
      R: d.outcome.R, grade: d.grade || null,
    });
  }
  return Object.fromEntries([...by].sort((a, b) => a[0].localeCompare(b[0])));
}

/** A seeded permutation of a list's items. */
function permuted(list, rand) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = pick(rand, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function indexHash(doc) {
  const { builtAt: _b, hash: _h, ...rest } = doc;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/**
 * The one exit mode the decisions were scored under (experience-log.js: each line's `exit`; null for lines written
 * before the tag). Outcomes under two exits measure two trade streams: an index of both is refused.
 */
function exitOf(decisions) {
  const modes = [...new Set(decisions.map(d => (typeof d.exit === 'string' && d.exit ? d.exit : null)))];
  if (modes.length > 1) {
    const n = m => decisions.filter(d => (d.exit || null) === m).length;
    throw new Error(`index refused: its decisions were scored under different exits (${modes.map(m => `${m || 'untagged (written before the exit tag)'}: ${n(m)}`).join(', ')}); build it from runs under one exit`);
  }
  return modes.length ? modes[0] : null;
}

/**
 * The index of these decisions (lines of experience logs). `runs`: [{ runId, file, sha256 }] the logs read, for the
 * manifest. Plain passes (no signature) count in `plainPasses` only. `shuffle`: a seed for the shuffled arm.
 */
function buildIndex(decisions, { runs = [], seed = 1, reps = 2000, shuffle = null, now = new Date() } = {}) {
  if (shuffle !== null && !Number.isInteger(shuffle)) throw new Error('shuffle: a whole-number seed');
  if (decisions.some(d => d && !d.bar && !d.cycleAt && !d.day)) throw new Error('index refused: a decision without its bar or day can\'t be placed in the split');
  // The same log twice would count every decision twice: refused; a decision in two logs counts once (its id).
  const hashes = runs.map(r => r.sha256).filter(Boolean);
  if (new Set(hashes).size !== hashes.length) throw new Error('index refused: the same experience log given twice (its sha256 repeats)');
  const ids = new Set();
  decisions = decisions.filter(d => !d || !d.id || (ids.has(d.id) ? false : (ids.add(d.id), true)));
  assertPracticeTrain(decisions.filter(Boolean));
  const exit = exitOf(decisions.filter(Boolean));
  const scored = decisions.filter(d => d && d.signatures && d.signatures.skill && d.decision !== 'none' && !d.hidden);
  let cells = {};
  const add = (k, row) => { (cells[k] = cells[k] || []).push(row); };
  for (const d of scored) {
    const row = [knownDay(d), hasR(d) ? d.outcome.R : null, d.decision === 'entered' ? 1 : 0, (d.context && d.context.regime) || '-'];
    for (const kind of KINDS) {
      const sig = d.signatures[kind];
      if (!sig) continue;
      add(cellKey(kind, sig), row);
      for (const k of CONTEXT_KEYS) add(cellKey(kind, sig, `${k}=${ctxVal(d.context, k)}`), row);
      add(cellKey(kind, sig, contextKey(d.context)), row);
    }
  }
  const keys = Object.keys(cells).sort();
  for (const k of keys) cells[k].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let examples = examplesOf(scored);
  if (shuffle !== null) {
    const rand = streamFor(shuffle, 'shuffle');
    const rows = permuted(keys.map(k => cells[k]), rand);
    cells = Object.fromEntries(keys.map((k, i) => [k, rows[i]]));
    const sigs = Object.keys(examples);
    const lists = permuted(sigs.map(s => examples[s]), rand);
    examples = Object.fromEntries(sigs.map((s, i) => [s, lists[i]]));
  } else cells = Object.fromEntries(keys.map(k => [k, cells[k]]));
  const days = [...new Set(scored.map(knownDay))].sort();
  const doc = {
    v: VERSION, builtAt: now.toISOString(), minN: MIN_N, minDays: MIN_DAYS, level: LEVEL, seed, reps, shuffle, walkForward: true, exit,
    runs: runs.map(r => ({ runId: r.runId || null, file: r.file ? path.basename(r.file) : null, sha256: r.sha256 || null })),
    roles: ['practice-train'], months: { from: days[0] || null, to: days[days.length - 1] || null },
    decisions: scored.length, plainPasses: decisions.filter(d => d && d.decision === 'none').length, cells, examples,
  };
  return { ...doc, hash: indexHash(doc) };
}

function writeIndex(dir, doc) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `index-${doc.hash.slice(0, 16)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

function readIndex(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || typeof doc !== 'object' || typeof doc.hash !== 'string') throw new Error(`${file}: not an experience index`);
  if (doc.v !== VERSION || doc.walkForward !== true) throw new Error(`${file}: an index of version ${doc.v}, not ${VERSION} (walk-forward): rebuild it`);
  if (indexHash(doc) !== doc.hash) throw new Error(`${file}: its content doesn't match its hash (changed after it was built)`);
  return doc;
}

/** The run's learning decision (learning/run-gate.js), read here without a dependency loop. */
function learningRun(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'learning-run.json'), 'utf8')); } catch (_err) { return null; }
}

/**
 * Pin an index for a run: its own copy in the run home, frozen by its hash. Every statistic it shows is walk-forward
 * (before the bar's session), so an index spanning the run's own months shows only their past. A run keeps the index
 * it pinned (another hash is refused); a run declared not learning is refused.
 */
/** A run's arm (learning/looks.js) from the index it will pin: with:<hash 16>, shuffled:<hash 16>, or without (none). */
function armOf(file) {
  if (!file) return 'without';
  const doc = readIndex(file);
  return `${doc.shuffle === null || doc.shuffle === undefined ? 'with' : 'shuffled'}:${doc.hash.slice(0, 16)}`;
}

function pinIndex(runHome, file) {
  const doc = readIndex(file);
  const run = learningRun(runHome);
  if (run && run.learning === false) throw new Error('this run is declared not learning: no experience index');
  const dir = path.join(runHome, 'experience');
  let pinned = null;
  try { pinned = JSON.parse(fs.readFileSync(path.join(dir, PINNED), 'utf8')); } catch (_err) { /* none yet */ }
  if (pinned && pinned.hash !== doc.hash) throw new Error(`this run pinned index ${String(pinned.hash).slice(0, 16)}; a run keeps its index (start another runId for ${doc.hash.slice(0, 16)})`);
  const copy = writeIndex(dir, doc);
  fs.writeFileSync(path.join(dir, PINNED), `${JSON.stringify({ file: path.basename(copy), hash: doc.hash, walkForward: true, shuffle: doc.shuffle })}\n`);
  return { file: copy, hash: doc.hash };
}

/** The run's pinned index (hash checked), or null when none is pinned or the run is declared not learning. */
function loadPinned(home) {
  const run = learningRun(home);
  if (run && run.learning === false) return null;
  const dir = path.join(home, 'experience');
  let pin;
  try { pin = JSON.parse(fs.readFileSync(path.join(dir, PINNED), 'utf8')); } catch (_err) { return null; }
  if (!pin || !/^index-[0-9a-f]{16}\.json$/.test(String(pin.file))) throw new Error('the pinned index is not an index file');
  const doc = readIndex(path.join(dir, pin.file));
  if (doc.hash !== pin.hash) throw new Error(`the pinned index's hash ${String(pin.hash).slice(0, 16)} is not its file's ${doc.hash.slice(0, 16)}`);
  return doc;
}

module.exports = {
  VERSION, MIN_N, MIN_DAYS, LEVEL, KINDS, buildIndex, cellStats, cellAt, examplesBefore, indexHash, writeIndex, readIndex, pinIndex, loadPinned, armOf,
  cellKey, contextKey, decisionDay, knownDay, assertPracticeTrain, exitOf,
};
