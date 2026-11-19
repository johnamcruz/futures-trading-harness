'use strict';

/**
 * P1, the SELECTION scorecard (the owner, 2026-11-18: select profitable trend-continuation opportunities from
 * structurally valid pullbacks), after the run only (never shown to the model): every candidate by the model's decision x
 * one ruler's R and points. Pure: the caller hands the rows (selection-run.js reads them from a run).
 *
 *   pickTable(rows, { reps, seed, ci })   the table (below)
 *   intervalOf(values, ci)                a two-sided `ci` interval of bootstrap values: [the (1-ci)/2 and (1+ci)/2 quantiles]
 */

const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/**
 * The pick table: every candidate once, by the model's decision x its outcome on ONE ruler (selection-run.js rulerOf: the
 * shipped trail from the scored bar's close, the printed structural stop; a limit that never fills is no trade, 0R).
 *   took            an MTF entry order placed for it (the gate's stamp), scored at the bar the order was placed on
 *   enterNoOrder    the model said ENTER and no order went (a refused compose or order): counted apart, never a take
 *   waited          a WAIT still open when the run ended
 *   passed          a PASS, or a WAIT the candidate outlived only to void or expire
 *   unlabelled      no SELECTION line: counted apart (in neither took nor passed)
 * Per state: n, mean, median and total R and points, the mean's by-session bootstrap interval (`ci`, `reps`, `seed`:
 * config's); took minus passed (the mean difference, R and points, with its by-session interval); unfilled (rows whose
 * limit never filled, scored 0R). Pure; the caller hands the rows.
 *   rows [{ key, day, state, outcome: { R, points, filled } | null }]
 */
const { rng } = require('../prop/stats'); // the seeded source the evaluator's bootstraps use (mulberry32)
const meanOf = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const medianOf = xs => { if (!xs.length) return null; const a = xs.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const quant = (xs, q) => { const a = xs.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))] : null; };
function intervalOf(values, ci) {
  const lo = Math.round(((1 - ci) / 2) * 1e9) / 1e9; // 0.05, never 0.04999...: the quantile's index is exact
  return values.length ? [r2(quant(values, lo)), r2(quant(values, 1 - lo))] : null;
}
function bootDays(days, stat, { reps, seed, ci }) {
  const keys = [...days.keys()];
  if (!keys.length) return null;
  const r = rng(seed);
  const out = [];
  for (let b = 0; b < reps; b += 1) {
    const draw = [];
    for (let k = 0; k < keys.length; k += 1) draw.push(days.get(keys[Math.floor(r() * keys.length)]));
    const v = stat(draw);
    if (Number.isFinite(v)) out.push(v);
  }
  return intervalOf(out, ci);
}
function pickTable(rows, { reps, seed, ci } = {}) {
  if (!(reps > 0) || !(ci > 0 && ci < 1) || !Number.isInteger(seed)) throw new Error('pickTable: reps, seed and ci are required (config: replay.selection)');
  const scored = rows.filter(x => x.outcome && Number.isFinite(x.outcome.R));
  const byState = st => scored.filter(x => x.state === st);
  const daysOf = xs => { const m = new Map(); for (const x of xs) { if (!m.has(x.day)) m.set(x.day, []); m.get(x.day).push(x); } return m; };
  const cell = xs => {
    const R = xs.map(x => x.outcome.R);
    const P = xs.map(x => x.outcome.points);
    return { n: xs.length, meanR: r2(meanOf(R)), medianR: r2(medianOf(R)), totalR: r2(R.reduce((a, b) => a + b, 0)), meanPts: r2(meanOf(P)), medianPts: r2(medianOf(P)), totalPts: r2(P.reduce((a, b) => a + b, 0)),
      meanRci: bootDays(daysOf(xs), d => meanOf(d.flat().map(x => x.outcome.R)), { reps, seed, ci }) };
  };
  const states = Object.fromEntries(['took', 'enterNoOrder', 'waited', 'passed'].map(st => [st, cell(byState(st))]));
  // Took minus passed, resampled by session (a session's candidates move together).
  const tp = scored.filter(x => x.state === 'took' || x.state === 'passed');
  const diff = (d, k) => { const all = d.flat(); const t = all.filter(x => x.state === 'took').map(x => x.outcome[k]); const q = all.filter(x => x.state === 'passed').map(x => x.outcome[k]); return t.length && q.length ? meanOf(t) - meanOf(q) : NaN; };
  const days = daysOf(tp);
  const d0 = k => { const v = diff([tp], k); return Number.isFinite(v) ? r2(v) : null; };
  return {
    candidates: rows.length, scored: scored.length, unlabelled: rows.filter(x => x.state === 'unlabelled').length, unfilled: scored.filter(x => x.outcome.filled === false).length, states,
    tookMinusPassed: { R: d0('R'), Rci: bootDays(days, d => diff(d, 'R'), { reps, seed, ci }), points: d0('points'), pointsCi: bootDays(days, d => diff(d, 'points'), { reps, seed, ci }) },
  };
}

module.exports = { pickTable, intervalOf };
