'use strict';

/**
 * The read report: how often the head trader's STATE read (trading/state-read.js, recorded per cycle by cycle-log.js)
 * agrees with the bar briefing's own label, per field and per frame, over a run. Read only; it measures, it decides
 * nothing. Agreement, not accuracy: the label can be stale (its own last break against it), so a disagreement can be
 * the better read; the read-by-fact table shows each case.
 *
 * Per field: stated (cycles whose read states it), match, mismatch, unknown (and why: state-read.js), n = match +
 * mismatch, days (trading days with n), agreement = match / n, and its interval from resampling whole trading days (a
 * day's cycles count together: they share one market), at the experience index's level, seed and repetitions
 * (config/training.json experienceIndex); fewer than two days: none. The confusion table counts each read word
 * against the code's fact (the day field: the briefing's day type as written; none: the briefing had none).
 *
 *   runCycles(runDir)        a replay run's trade cycles: [{ day, at, stateRead }] (its store lines' last trade cycle)
 *   homeCycles(home)         a run home's trade cycles from its cycle logs (logs/cycles-<day>.jsonl)
 *   tally(cycles)            { cycles, status: { read, none, unparsable, conflicting, unrecorded, error }, byOutcome (the
 *                            status by the cycle result's outcome word: a managed cycle ends before step 3), fields }
 *   renderReads(tally)       the report as text
 */

const fs = require('fs');
const path = require('path');
const { REGISTRY } = require('../trading/state-read');
const { streamFor, pick, quantile, round4 } = require('../prop/stats');

const EI = require('../tunables').training().experienceIndex; // config/training.json: the day resampling's level, seed, reps
const STATUSES = ['read', 'none', 'unparsable', 'conflicting'];

/** A replay run's trade cycles, each with the state record its cycle log kept (null before the record). */
function runCycles(runDir) {
  const { readRun } = require('../replay/store');
  const { days } = readRun(runDir);
  return Object.keys(days).sort().flatMap(day => days[day]
    .filter(r => r && r.kind === 'trade' && Array.isArray(r.cycles))
    .map(r => {
      const c = r.cycles.filter(x => x && x.action === 'trade').pop() || null;
      return { day, at: r.t, result: c && typeof c.result === 'string' ? c.result : null, stateRead: c && c.stateRead && typeof c.stateRead === 'object' ? c.stateRead : null };
    }));
}

/** A cycle result line's outcome word (no-trade, managed, executed, planned...), or 'unknown'. */
const outcomeOf = result => ((/CYCLE RESULT:[\s*_`]*([a-z][a-z-]*)/i.exec(String(result || '')) || [])[1] || 'unknown').toLowerCase();

/** A run home's trade cycles from its cycle logs (live or replay), dated by each log's own trading day. */
function homeCycles(home) {
  const dir = path.join(home, 'logs');
  const LOG = /^cycles-(\d{4}-\d{2}-\d{2})\.jsonl$/;
  const files = fs.readdirSync(dir).filter(f => LOG.test(f)).sort();
  return files.flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(l => l.trim()).flatMap(l => {
    try { return [JSON.parse(l)]; } catch (_err) { return []; }
  }).filter(x => x && x.action === 'trade').map(x => ({ day: LOG.exec(f)[1], at: x.cycleAt || x.at, result: typeof x.result === 'string' ? x.result : null, stateRead: x.stateRead && typeof x.stateRead === 'object' ? x.stateRead : null })));
}

/** sum(num) / sum(den) over whole days resampled: { lo, hi } at the level, or nulls with fewer than two days. */
function dayInterval(days, key) {
  if (days.length <= 1) return { lo: null, hi: null };
  const rand = streamFor(EI.seed, `read-accuracy|${key}`);
  const ratios = [];
  for (let r = 0; r < EI.reps; r += 1) {
    let s = 0;
    let c = 0;
    for (let k = 0; k < days.length; k += 1) {
      const d = days[pick(rand, days.length)];
      s += d.match;
      c += d.n;
    }
    ratios.push(s / c);
  }
  ratios.sort((a, b) => a - b);
  const tail = (1 - EI.level) / 2;
  return { lo: round4(quantile(ratios, tail)), hi: round4(quantile(ratios, 1 - tail)) };
}

function tally(cycles) {
  const status = { ...Object.fromEntries(STATUSES.map(s => [s, 0])), unrecorded: 0, error: 0 };
  const acc = Object.fromEntries(REGISTRY.map(e => [e.key, { stated: 0, match: 0, mismatch: 0, unknown: 0, unknownWhy: {}, confusion: {}, byDay: new Map() }]));
  // The status by the cycle's outcome: a managed cycle never reaches step 3, so its line's absence reads apart.
  const byOutcome = {};
  for (const c of cycles) {
    const s = c && c.stateRead;
    const kind = !s ? 'unrecorded' : s.error || !STATUSES.includes(s.status) ? 'error' : s.status;
    const o = outcomeOf(c && c.result);
    byOutcome[o] = byOutcome[o] || {};
    byOutcome[o][kind] = (byOutcome[o][kind] || 0) + 1;
    status[kind] += 1;
    if (!STATUSES.includes(kind)) continue;
    for (const [key, f] of Object.entries(s.fields || {})) {
      const a = acc[key];
      if (!a || !f || !['match', 'mismatch', 'unknown'].includes(f.result)) continue;
      a.stated += 1;
      a[f.result] += 1;
      if (f.result === 'unknown') a.unknownWhy[f.why || 'unknown'] = (a.unknownWhy[f.why || 'unknown'] || 0) + 1;
      const fact = f.dayType !== undefined ? f.dayType || 'none' : f.fact || 'none';
      a.confusion[f.read] = a.confusion[f.read] || {};
      a.confusion[f.read][fact] = (a.confusion[f.read][fact] || 0) + 1;
      if (f.result !== 'unknown') {
        const d = a.byDay.get(c.day) || { match: 0, n: 0 };
        d.n += 1;
        if (f.result === 'match') d.match += 1;
        a.byDay.set(c.day, d);
      }
    }
  }
  const fields = {};
  for (const [key, a] of Object.entries(acc)) {
    const n = a.match + a.mismatch;
    const { byDay, ...rest } = a;
    fields[key] = { ...rest, n, days: byDay.size, agreement: n ? round4(a.match / n) : null, ...dayInterval([...byDay.values()], key), level: EI.level };
  }
  return { cycles: cycles.length, status, byOutcome, fields };
}

const pct = x => (x === null ? '-' : x.toLocaleString('en-US', { style: 'percent' }));

function renderReads(t) {
  const s = t.status;
  const out = [
    `STATE reads over ${t.cycles} trade cycles: read ${s.read}, no state line ${s.none}, unparsable ${s.unparsable}, conflicting ${s.conflicting}, no state record ${s.unrecorded}${s.error ? `, record error ${s.error}` : ''}`,
    `By outcome: ${Object.entries(t.byOutcome || {}).map(([o, k]) => `${o} (${Object.entries(k).map(([x, n]) => `${x} ${n}`).join(', ')})`).join('; ')}`,
    `Per field, agreement with the briefing's label (match/n, day-clustered ${pct(EI.level)} interval); unknown is never a mismatch:`,
  ];
  for (const [key, f] of Object.entries(t.fields)) {
    const ci = f.lo === null ? 'no interval (under two days)' : `[${pct(f.lo)}, ${pct(f.hi)}]`;
    out.push(`  ${key}  ${f.match}/${f.n}  ${pct(f.agreement)}  ${ci}  days ${f.days}, stated ${f.stated}, unknown ${f.unknown}`);
    for (const [why, k] of Object.entries(f.unknownWhy)) out.push(`      unknown ${k}: ${why}`);
    for (const [read, facts] of Object.entries(f.confusion)) out.push(`      read ${read}: ${Object.entries(facts).map(([x, k]) => `${x} ${k}`).join(', ')}`);
  }
  return out.join('\n');
}

module.exports = { runCycles, homeCycles, tally, renderReads };
