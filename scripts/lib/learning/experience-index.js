'use strict';

/**
 * The experience index (the composed-entry design, section 4.3): code's statistics over the experience log
 * (experience-log.js), per signature and context, which experience_lookup shows the model. Built between sessions,
 * never by the runner; frozen per run (pinIndex: the run home holds its own copy and its hash).
 *
 * Cells, for each signature kind (skill, read) and each decision with an outcome R:
 *   <kind>|<signature>|*                   the signature in any context
 *   <kind>|<signature>|<key>=<value>       one context key at a time (CONTEXT_KEYS)
 *   <kind>|<signature>|<the full context>  every key, `regime=..;volatility=..;...`
 * Per skill signature it also keeps its latest EXAMPLES_PER_SIGNATURE decisions with an outcome (examples), compact.
 * Per cell: n (decisions with an R), entries and passes apart, unfilled (passes whose limit never traded: no R),
 * distinct days, wins, the win rate with a 90% Wilson interval (prop/stats.js wilson), the mean R with a 90% interval
 * from resampling whole trading days (a day's cluster counts once), first and last day seen, the split by year and
 * by regime, and `shifted` when the latest year's mean has the other sign from the whole. A cell under MIN_N
 * decisions or MIN_DAYS distinct days (D16) shows its counts and `too few samples (n=7, 3 days)`, no rate or mean.
 *
 * No leakage: an index is built only from practice-train decisions (learning/splits.js, the day recomputed, never
 * the line's own label): a decision from practice-validate, test or final, or outside the schedule, refuses the build.
 *
 *   buildIndex(decisions, { runs, seed, reps, now })   the index document, with its hash
 *   indexHash(doc)                    sha256 of the document without builtAt and hash
 *   writeIndex(dir, doc)              <dir>/index-<hash 16>.json; the file
 *   readIndex(file)                   the document, its hash checked (throws on a changed file)
 *   pinIndex(runHome, file)           copies the index into <run home>/experience/ and pins it (pinned.json); { file, hash }
 *   loadPinned(home)                  the pinned index, its hash checked; null when none is pinned
 *   cellKey(kind, sig, ctx), contextKey(ctx)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { wilson, streamFor, pick, quantile, round4 } = require('../prop/stats');
const { roleOf } = require('./splits');
const { CONTEXT_KEYS } = require('./lifecycle-record');

const VERSION = 1;
const MIN_N = 20;
const MIN_DAYS = 10;
const LEVEL = 0.9;
const KINDS = Object.freeze(['skill', 'read']);
const PINNED = 'pinned.json';
/** Past decisions kept per skill signature, the latest, for the lookup's similar decisions. */
const EXAMPLES_PER_SIGNATURE = 12;
const WHY_CHARS = 160;

const ctxVal = (ctx, k) => (ctx && ctx[k] !== null && ctx[k] !== undefined ? ctx[k] : '-');
const contextKey = ctx => CONTEXT_KEYS.map(k => `${k}=${ctxVal(ctx, k)}`).join(';');
const cellKey = (kind, sig, ctx = '*') => `${kind}|${sig}|${ctx}`;

/** The mean of R over resampled whole days: { mean, lo, hi } at LEVEL. */
function dayBootstrap(days, { reps, rand }) {
  const sums = days.map(d => d.sum);
  const counts = days.map(d => d.n);
  const D = days.length;
  const means = new Array(reps);
  for (let r = 0; r < reps; r += 1) {
    let s = 0;
    let c = 0;
    for (let k = 0; k < D; k += 1) {
      const j = pick(rand, D);
      s += sums[j];
      c += counts[j];
    }
    means[r] = s / c;
  }
  means.sort((a, b) => a - b);
  const tail = (1 - LEVEL) / 2;
  return { lo: round4(quantile(means, tail)), hi: round4(quantile(means, 1 - tail)) };
}

function stats(key, list, { seed, reps }) {
  const withR = list.filter(d => d.outcome && Number.isFinite(d.outcome.R));
  const n = withR.length;
  const byDay = new Map();
  for (const d of withR) {
    const x = byDay.get(d.day) || { sum: 0, n: 0 };
    x.sum += d.outcome.R;
    x.n += 1;
    byDay.set(d.day, x);
  }
  const daysSeen = [...new Set(list.map(d => d.day))].sort();
  const wins = withR.filter(d => d.outcome.R > 0).length;
  const group = f => {
    const g = {};
    for (const d of withR) {
      const k = f(d);
      g[k] = g[k] || { n: 0, sum: 0 };
      g[k].n += 1;
      g[k].sum += d.outcome.R;
    }
    return Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, { n: v.n, meanR: round4(v.sum / v.n) }]));
  };
  const byYear = group(d => d.day.slice(0, 4));
  const cell = {
    n, entries: withR.filter(d => d.decision === 'entered').length, passes: withR.filter(d => d.decision !== 'entered').length,
    unfilled: list.length - n, days: byDay.size, wins,
    firstSeen: daysSeen[0] || null, lastSeen: daysSeen[daysSeen.length - 1] || null,
    byYear, byRegime: group(d => (d.context && d.context.regime) || '-'),
  };
  if (n < MIN_N || byDay.size < MIN_DAYS) return { ...cell, enough: false, note: `too few samples (n=${n}, ${byDay.size} days)`, winRate: null, meanR: null };
  const mean = withR.reduce((a, d) => a + d.outcome.R, 0) / n;
  const w = wilson(wins, n, LEVEL);
  const years = Object.keys(byYear);
  const latest = byYear[years[years.length - 1]];
  const shifted = years.length > 1 && latest.meanR !== 0 && mean !== 0 && Math.sign(latest.meanR) !== Math.sign(mean);
  return {
    ...cell, enough: true, note: null,
    winRate: { rate: w.rate, lo: w.lo, hi: w.hi, level: LEVEL },
    meanR: { mean: round4(mean), ...dayBootstrap([...byDay.values()], { reps, rand: streamFor(seed, key) }), level: LEVEL, by: 'day' },
    shifted,
  };
}

/** Throws unless every decision's day is practice-train (recomputed from its bar's session). */
function assertPracticeTrain(decisions) {
  const bad = new Map();
  for (const d of decisions) {
    let role;
    try { role = roleOf(d.day); } catch (_err) { role = 'no role'; }
    if (role !== 'practice-train') bad.set(role, (bad.get(role) || 0) + 1);
  }
  if (bad.size) throw new Error(`index refused (leakage): ${[...bad].map(([r, k]) => `${k} decision(s) in ${r}`).join(', ')}; an index is built from practice-train months only`);
}

/**
 * The latest decisions with an outcome per skill signature (EXAMPLES_PER_SIGNATURE), compact: { day, decision, side,
 * context, reads: [{ step, skill, read, why }], R, grade }. What experience_lookup shows as similar past decisions.
 */
function examplesOf(scored) {
  const by = new Map();
  const withR = scored.filter(d => d.outcome && Number.isFinite(d.outcome.R)).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : String(a.id).localeCompare(String(b.id))));
  for (const d of withR) {
    const k = d.signatures.skill;
    if (!by.has(k)) by.set(k, []);
    const list = by.get(k);
    if (list.length >= EXAMPLES_PER_SIGNATURE) continue;
    list.push({
      day: d.day, decision: d.decision, side: d.side || null, context: d.context || null,
      reads: (Array.isArray(d.reads) ? d.reads : []).map(r => ({ step: r.step, skill: r.skill, read: r.read, why: r.why ? String(r.why).slice(0, WHY_CHARS) : null })),
      R: d.outcome.R, grade: d.grade || null,
    });
  }
  return Object.fromEntries([...by].sort((a, b) => a[0].localeCompare(b[0])));
}

function indexHash(doc) {
  const { builtAt: _b, hash: _h, ...rest } = doc;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/**
 * The index of these decisions (lines of experience logs). `runs`: [{ runId, file, sha256 }] the logs read, for the
 * manifest. Plain passes (no signature) count in `plainPasses` only.
 */
function buildIndex(decisions, { runs = [], seed = 1, reps = 2000, now = new Date() } = {}) {
  const scored = decisions.filter(d => d && d.signatures && d.signatures.skill && d.decision !== 'none');
  assertPracticeTrain(decisions.filter(d => d && d.day));
  if (decisions.some(d => d && !d.day && d.decision !== 'none')) throw new Error('index refused: a decision without its day can\'t be placed in the split');
  const groups = new Map();
  const add = (k, d) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); };
  for (const d of scored) {
    for (const kind of KINDS) {
      const sig = d.signatures[kind];
      if (!sig) continue;
      add(cellKey(kind, sig), d);
      for (const k of CONTEXT_KEYS) add(cellKey(kind, sig, `${k}=${ctxVal(d.context, k)}`), d);
      add(cellKey(kind, sig, contextKey(d.context)), d);
    }
  }
  const cells = {};
  for (const k of [...groups.keys()].sort()) cells[k] = stats(k, groups.get(k), { seed, reps });
  const days = [...new Set(scored.map(d => d.day))].sort();
  const doc = {
    v: VERSION, builtAt: now.toISOString(), minN: MIN_N, minDays: MIN_DAYS, level: LEVEL, seed, reps,
    runs: runs.map(r => ({ runId: r.runId || null, file: r.file ? path.basename(r.file) : null, sha256: r.sha256 || null })),
    roles: ['practice-train'], months: { from: days[0] || null, to: days[days.length - 1] || null },
    decisions: scored.length, plainPasses: decisions.filter(d => d && d.decision === 'none').length, cells, examples: examplesOf(scored),
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
  if (indexHash(doc) !== doc.hash) throw new Error(`${file}: its content doesn't match its hash (changed after it was built)`);
  return doc;
}

/** Pin an index for a run: its own copy in the run home, frozen by its hash. */
function pinIndex(runHome, file) {
  const doc = readIndex(file);
  const dir = path.join(runHome, 'experience');
  const copy = writeIndex(dir, doc);
  fs.writeFileSync(path.join(dir, PINNED), `${JSON.stringify({ file: path.basename(copy), hash: doc.hash })}\n`);
  return { file: copy, hash: doc.hash };
}

/** The run's pinned index (hash checked), or null when none is pinned. Throws on a pin that doesn't hold. */
function loadPinned(home) {
  const dir = path.join(home, 'experience');
  let pin;
  try { pin = JSON.parse(fs.readFileSync(path.join(dir, PINNED), 'utf8')); } catch (_err) { return null; }
  if (!pin || !/^index-[0-9a-f]{16}\.json$/.test(String(pin.file))) throw new Error('the pinned index is not an index file');
  const doc = readIndex(path.join(dir, pin.file));
  if (doc.hash !== pin.hash) throw new Error(`the pinned index's hash ${String(pin.hash).slice(0, 16)} is not its file's ${doc.hash.slice(0, 16)}`);
  return doc;
}

module.exports = { VERSION, MIN_N, MIN_DAYS, LEVEL, KINDS, buildIndex, indexHash, writeIndex, readIndex, pinIndex, loadPinned, cellKey, contextKey, assertPracticeTrain };
