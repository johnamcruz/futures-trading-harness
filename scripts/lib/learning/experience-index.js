'use strict';

/**
 * The experience index (the composed-entry design, section 4.3): code's record of the experience log
 * (experience-log.js), per signature and context, which experience_lookup shows the model. Built between sessions,
 * never by the runner; frozen per run (pinIndex: the run home holds its own copy and its hash).
 *
 * Walk-forward: the index keeps each cell's decisions as rows (ROW: [day, R, entered, regime, maeR, mfeR, curated, weight]),
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
 * other sign from the whole; the median MAE and MFE in R (the worst and best move while held: the fills', or the
 * counterfactual's) with their counts and day-bootstrap intervals, each only from at least MIN_N decisions over MIN_DAYS
 * days that have one (a line without them, written before they were recorded, counts in neither). Dated like R, by
 * knownDay: an excursion is known only at the trade's exit. A cell under MIN_N decisions or MIN_DAYS distinct days
 * (D16) shows its counts and `too few samples (n=7, 3 days)`, no rate, mean or median.
 *
 * Shuffled (the paired replay's third arm): `shuffle` (a seed) permutes the cells' rows across cells and the
 * examples across signatures, so the record shows numbers that belong to other combinations; it is part of the hash.
 *
 * Curated runs, weighted to natural rates: a curated run's moments are picked outcome-balanced (learning/curated-lists.js:
 * winners and losers kept level), so as they stand its win rate, mean R and MAE/MFE are the list's mix, not the
 * market's. Its decisions (tagged `curated` by run-experience.js, or every line of a log whose run home pinned a curated
 * list) carry the inverse-probability weight of their moment's list and standard outcome (learning/curated-weights.js:
 * the build CLI's --lists document); every other decision weighs 1. The rates, means and medians and their day
 * bootstraps are weighted, and MIN_N applies to the effective n (Kish). A curated decision without a weight (its
 * document not given, built before it recorded the candidates' outcomes, or no single moment holding it) is counted,
 * never rated. Each row's `curated` and `weight` columns, each cell's counts, each example's flag and the index's
 * `curated` and `curatedUnweighted` totals say so.
 *
 * No leakage: an index is built only from practice-train decisions (learning/splits.js), the day recomputed from
 * the decision's bar (its cycle for a plain pass), never the line's own label, and the day its outcome came (its
 * exit's session) practice-train too. Rows are dated by the later of the two (knownDay). A decision counts once (by
 * its id); the same log given twice (its sha256) is refused.
 *
 *   buildIndex(decisions, { runs, seed, reps, shuffle, now })   the index document, with its hash, its `exit` and
 *                                       `exitPlan` (the one exit plan its decisions were scored under, its mode and
 *                                       hash; decisions under two plans are refused)
 *   cellStats(rows, { before, seed, reps, key })   the statistics of a cell's rows before a day (null: every row)
 *   cellAt(index, key, before)          cellStats of an index's cell, or null when the cell has no rows
 *   examplesBefore(index, skillSig, before)   the examples before a day, latest first
 *   indexHash(doc), writeIndex(dir, doc), readIndex(file)
 *   pinIndex(runHome, file)             the run's own frozen copy (pinned.json); a run keeps the index it pinned
 *   armOf(file)                         the arm a run pinning it is (with:<hash>, shuffled:<hash>; no file: without)
 *   loadPinned(home)                    the pinned index, its hash checked; null when none is pinned or the run is
 *                                       declared not learning
 *   cellKey(kind, sig, ctx), contextKey(ctx), decisionDay(d), knownDay(d)
 *   curatedLog(file)                    whether an experience log's run home pinned a curated list (a broken pin: yes)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { streamFor, pick, quantile, round4 } = require('../prop/stats');
const { roleOf, sessionDate } = require('./splits');
const { CONTEXT_KEYS } = require('./lifecycle-record');

// 3: rows carry the decision's maeR and mfeR (a version-2 row has neither: refused, rebuilt).
const VERSION = 3;
const EI = require('../tunables').training().experienceIndex; // config/training.json experienceIndex (minN, minDays and level only rise)
const MIN_N = EI.minN;
const MIN_DAYS = EI.minDays;
const LEVEL = EI.level;
const KINDS = Object.freeze(['skill', 'read']);
/** A cell row's columns; the excursions' by name, so no index is a bare number. */
const ROW = Object.freeze(['day', 'R', 'entered', 'regime', 'maeR', 'mfeR', 'curated', 'weight']);
const MAE = ROW.indexOf('maeR');
const MFE = ROW.indexOf('mfeR');
const CURATED = ROW.indexOf('curated');
const WEIGHT = ROW.indexOf('weight');
const PINNED = 'pinned.json';
/** Examples kept per skill signature and month (the latest of each), so a lookup on any day finds some before it. */
const EXAMPLES_PER_MONTH = EI.examplesPerMonth;
const WHY_CHARS = EI.whyChars;

const ctxVal = (ctx, k) => (ctx && ctx[k] !== null && ctx[k] !== undefined ? ctx[k] : '-');
const contextKey = ctx => CONTEXT_KEYS.map(k => `${k}=${ctxVal(ctx, k)}`).join(';');
const cellKey = (kind, sig, ctx = '*') => `${kind}|${sig}|${ctx}`;
const hasR = d => d.outcome && Number.isFinite(d.outcome.R);
/** A decision's weight: 1, or a curated one's natural-rate weight (curated-weights.js; none given: null, never rated). */
const weightFor = d => (d.curated !== true ? 1 : Number.isFinite(d.weight) && d.weight >= 0 ? d.weight : null);
/** An outcome's maeR or mfeR when it has one (a number), else null: never invented. */
const excursion = (d, k) => (hasR(d) && Number.isFinite(d.outcome[k]) ? d.outcome[k] : null);

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

/** A row's weight: its `weight` column (null: a curated decision counted, never rated); a row without one weighs 1. */
const weightOf = r => (r.length > WEIGHT ? r[WEIGHT] : 1);
const rated = r => Number.isFinite(weightOf(r));
/** The effective sample size of weights (Kish: (sum w)^2 / sum w^2): their count when every weight is 1. */
const effective = ws => {
  const s = ws.reduce((a, w) => a + w, 0);
  const q = ws.reduce((a, w) => a + w * w, 0);
  return q > 0 ? (s * s) / q : 0;
};

const sumBy = (rows, f) => {
  const g = {};
  for (const r of rows) {
    const k = f(r);
    g[k] = g[k] || { n: 0, sum: 0, w: 0, ws: [], days: new Set() };
    g[k].n += 1;
    g[k].sum += weightOf(r) * r[1];
    g[k].w += weightOf(r);
    g[k].ws.push(weightOf(r));
    g[k].days.add(r[0]);
  }
  return g;
};

/**
 * The weighted median (the first value whose cumulative weight passes half: stats.js median's upper middle when every
 * weight is 1) of the rated rows' column k (MAE, MFE), its count, effective n and distinct days, and its interval at
 * LEVEL from resampling whole days (as dayBootstrap: a day's cluster counts once); the median and its interval only from
 * an effective n of at least MIN_N over MIN_DAYS days. Each resample's median by summing weights on ranks (no sort per draw).
 */
function medianOf(rows, k, { reps, rand }) {
  const vals = rows.filter(r => Number.isFinite(r[k]) && rated(r));
  const dayList = [...new Set(vals.map(r => r[0]))];
  const nEff = effective(vals.map(weightOf));
  const out = { n: rows.filter(r => Number.isFinite(r[k])).length, nEff: round4(nEff), days: dayList.length, median: null, lo: null, hi: null };
  if (nEff < MIN_N || dayList.length < MIN_DAYS) return out;
  const order = vals.map((r, i) => i).sort((a, b) => vals[a][k] - vals[b][k]);
  const sorted = order.map(i => vals[i][k]);
  const wSorted = order.map(i => weightOf(vals[i]));
  const rank = new Array(vals.length);
  order.forEach((i, j) => { rank[i] = j; });
  const ranksOf = new Map(dayList.map(d => [d, []]));
  vals.forEach((r, i) => ranksOf.get(r[0]).push(rank[i]));
  const byDay = dayList.map(d => ranksOf.get(d));
  const at = (mass, totalW) => {
    let c = 0;
    let m = 0;
    while (m < mass.length - 1 && c + mass[m] <= totalW / 2) { c += mass[m]; m += 1; }
    return sorted[m];
  };
  const mass = new Float64Array(sorted.length);
  const meds = new Array(reps);
  for (let q = 0; q < reps; q += 1) {
    mass.fill(0);
    let totalW = 0;
    for (let j = 0; j < byDay.length; j += 1) {
      for (const x of byDay[pick(rand, byDay.length)]) { mass[x] += wSorted[x]; totalW += wSorted[x]; }
    }
    meds[q] = at(mass, totalW);
  }
  meds.sort((a, b) => a - b);
  const tail = (1 - LEVEL) / 2;
  return { ...out, median: round4(at(wSorted, wSorted.reduce((a, w) => a + w, 0))), lo: round4(quantile(meds, tail)), hi: round4(quantile(meds, 1 - tail)), level: LEVEL, by: 'day' };
}

/**
 * A cell's statistics from its rows (ROW) on days strictly before `before` (null: all). The rates, means and medians are
 * weighted (a curated decision by its natural-rate weight, every other 1: curated-weights.js) and need an effective n
 * (`nEff`) of MIN_N; `n` counts every decision with an R, `curated` how many of them are curated runs', `unweighted`
 * how many of those had no weight (counted, never rated).
 */
function cellStats(rows, { before = null, seed = EI.seed, reps = EI.reps, key = '' } = {}) {
  const seen = (rows || []).filter(r => before === null || r[0] < before);
  const withR = seen.filter(r => Number.isFinite(r[1]));
  const n = withR.length;
  const used = withR.filter(rated);
  const byDay = new Map();
  for (const r of used) {
    const w = weightOf(r);
    const x = byDay.get(r[0]) || { sum: 0, n: 0, wins: 0 };
    x.sum += w * r[1];
    x.n += w;
    x.wins += r[1] > 0 ? w : 0;
    byDay.set(r[0], x);
  }
  const days = [...new Set(seen.map(r => r[0]))].sort();
  const wins = withR.filter(r => r[1] > 0).length;
  const nEff = effective(used.map(weightOf));
  const weighted = used.some(r => weightOf(r) !== 1) || used.length < n;
  const years = sumBy(used, r => r[0].slice(0, 4));
  const fmt = g => Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, { n: v.n, meanR: round4(v.sum / v.w) }]));
  const cell = {
    n, nEff: round4(nEff), weighted, entries: withR.filter(r => r[2] === 1).length, passes: withR.filter(r => r[2] !== 1).length, unfilled: seen.length - n,
    curated: withR.filter(r => r[CURATED] === 1).length, unweighted: n - used.length, days: byDay.size, wins, firstSeen: days[0] || null, lastSeen: days[days.length - 1] || null,
    byYear: fmt(years), byRegime: fmt(sumBy(used, r => r[3] || '-')), before,
  };
  const counted = k => {
    const v = withR.filter(r => Number.isFinite(r[k]));
    return { n: v.length, nEff: round4(effective(v.filter(rated).map(weightOf))), days: new Set(v.filter(rated).map(r => r[0])).size, median: null, lo: null, hi: null };
  };
  if (nEff < MIN_N || byDay.size < MIN_DAYS) {
    const note = weighted ? `too few samples (n=${n}, n_eff ${nEff.toFixed(1)}, ${byDay.size} days)` : `too few samples (n=${n}, ${byDay.size} days)`;
    return { ...cell, enough: false, note, winRate: null, meanR: null, shifted: false, latestYear: null, mae: counted(MAE), mfe: counted(MFE) };
  }
  const list = [...byDay.values()];
  const wsum = list.reduce((a, d) => a + d.n, 0);
  const mean = list.reduce((a, d) => a + d.sum, 0) / wsum;
  const rand = streamFor(seed, `${key}|${before}`);
  const meanR = { mean: round4(mean), ...dayBootstrap(list, list.map(d => d.sum), list.map(d => d.n), { reps, rand }), level: LEVEL, by: 'day' };
  const winRate = { rate: round4(list.reduce((a, d) => a + d.wins, 0) / wsum), ...dayBootstrap(list, list.map(d => d.wins), list.map(d => d.n), { reps, rand }), level: LEVEL, by: 'day' };
  const ys = Object.keys(years).sort();
  const y = ys.length > 1 ? years[ys[ys.length - 1]] : null;
  const latestYear = y ? { year: ys[ys.length - 1], n: y.n, nEff: round4(effective(y.ws)), days: y.days.size, meanR: round4(y.sum / y.w) } : null;
  const shifted = Boolean(latestYear && latestYear.nEff >= MIN_N && latestYear.days >= MIN_DAYS && latestYear.meanR !== 0 && mean !== 0 && Math.sign(latestYear.meanR) !== Math.sign(mean));
  // Drawn after the win rate's and the mean's, from the same stream: their intervals are unchanged by these.
  const mae = medianOf(withR, MAE, { reps, rand });
  const mfe = medianOf(withR, MFE, { reps, rand });
  return { ...cell, enough: true, note: null, winRate, meanR, shifted, latestYear, mae, mfe };
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
      R: d.outcome.R, maeR: excursion(d, 'maeR'), mfeR: excursion(d, 'mfeR'), grade: d.grade || null, curated: d.curated === true,
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
 * The one exit plan the decisions were scored under (experience-log.js: each line's `exitPlan`, the hash of the run's
 * exit as its manifest recorded it at seed time, and its mode `exit`; a line without a plan hash, written before the
 * record, is untagged). Outcomes under two plans (two modes, or one mode with other parameters) measure two trade
 * streams: an index of both is refused. { mode, plan } (the hash), nulls for none.
 */
function exitOf(decisions) {
  const planOf = d => (typeof d.exitPlan === 'string' && d.exitPlan ? d.exitPlan : null);
  const plans = [...new Set(decisions.map(planOf))];
  const name = p => {
    const d = decisions.find(x => planOf(x) === p);
    return p ? `${(d && d.exit) || 'unknown'} ${p.slice(0, 12)}` : 'untagged (written before the exit plan was recorded)';
  };
  if (plans.length > 1) {
    const n = p => decisions.filter(d => planOf(d) === p).length;
    throw new Error(`index refused: its decisions were scored under different exit plans (${plans.map(p => `${name(p)}: ${n(p)}`).join(', ')}); build it from runs under one exit plan`);
  }
  const plan = plans.length ? plans[0] : null;
  // Untagged lines (a run started before the record): no plan to name, whatever mode a line says.
  if (plan === null) return { mode: null, plan: null };
  const modes = [...new Set(decisions.filter(d => planOf(d) === plan).map(d => (typeof d.exit === 'string' && d.exit ? d.exit : null)))];
  if (modes.length > 1) throw new Error(`index refused: one exit plan under two modes (${modes.join(', ')}): its lines were edited`);
  return { mode: modes.length ? modes[0] : null, plan };
}

/**
 * The index of these decisions (lines of experience logs). `runs`: [{ runId, file, sha256 }] the logs read, for the
 * manifest. Plain passes (no signature) count in `plainPasses` only. `shuffle`: a seed for the shuffled arm.
 */
function buildIndex(decisions, { runs = [], seed = EI.seed, reps = EI.reps, shuffle = null, now = new Date() } = {}) {
  if (shuffle !== null && !Number.isInteger(shuffle)) throw new Error('shuffle: a whole-number seed');
  if (decisions.some(d => d && !d.bar && !d.cycleAt && !d.day)) throw new Error('index refused: a decision without its bar or day can\'t be placed in the split');
  // The same log twice would count every decision twice: refused; a decision in two logs counts once (its id).
  const hashes = runs.map(r => r.sha256).filter(Boolean);
  if (new Set(hashes).size !== hashes.length) throw new Error('index refused: the same experience log given twice (its sha256 repeats)');
  const ids = new Set();
  decisions = decisions.filter(d => !d || !d.id || (ids.has(d.id) ? false : (ids.add(d.id), true)));
  assertPracticeTrain(decisions.filter(Boolean));
  const { mode: exit, plan: exitPlan } = exitOf(decisions.filter(Boolean));
  const scored = decisions.filter(d => d && d.signatures && d.signatures.skill && d.decision !== 'none' && !d.hidden);
  let cells = {};
  const add = (k, row) => { (cells[k] = cells[k] || []).push(row); };
  for (const d of scored) {
    const row = [knownDay(d), hasR(d) ? d.outcome.R : null, d.decision === 'entered' ? 1 : 0, (d.context && d.context.regime) || '-', excursion(d, 'maeR'), excursion(d, 'mfeR'), d.curated === true ? 1 : 0, weightFor(d)];
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
    v: VERSION, builtAt: now.toISOString(), minN: MIN_N, minDays: MIN_DAYS, level: LEVEL, seed, reps, shuffle, walkForward: true, exit, exitPlan,
    runs: runs.map(r => ({ runId: r.runId || null, file: r.file ? path.basename(r.file) : null, sha256: r.sha256 || null })),
    roles: ['practice-train'], months: { from: days[0] || null, to: days[days.length - 1] || null },
    decisions: scored.length, plainPasses: decisions.filter(d => d && d.decision === 'none').length, curated: scored.filter(d => d.curated === true).length, curatedUnweighted: scored.filter(d => d.curated === true && weightFor(d) === null).length, cells, examples,
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

/** Whether an experience log (<run home>/experience/decisions.jsonl) is a curated run's: its home pinned a curated list. */
function curatedLog(file) {
  const { loadPinnedCurated } = require('./curated-lists');
  try { return Boolean(loadPinnedCurated(path.resolve(path.dirname(file), '..'))); } catch (_err) { return true; }
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
  cellKey, contextKey, decisionDay, knownDay, assertPracticeTrain, exitOf, curatedLog,
};
