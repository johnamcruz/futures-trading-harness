'use strict';

/**
 * P1, the SELECTION scorecard (the owner, 2026-11-18: select profitable trend-continuation opportunities from
 * structurally valid pullbacks), after the run only (never shown to the model). Primary: pickTable (every candidate by the
 * model's decision x one ruler's R and points). Secondary: the legs table (score): the run's trend legs and how its MTF
 * entries entered and rode them. Pure: the caller hands the rows, the legs (eval/goal-metrics.js trendLegs on the run's
 * served bars, reused: legsFrom), the entries and the picks (selection-run.js reads them from a run).
 *
 *   legs     [{ id, day, side, start, end, from, to, points }]: a trend leg (from its start to its extreme at `end`)
 *   entries  [{ at, side, rank, entry, exit, exitAt, exitBy ('trail' | 'stop' | 'model' | 'runner' | 'open'), r, peakR }]
 *   picks    [{ at, side, rank, model, took }]: each cycle's chosen MTF candidate the 1h's way, taken or passed
 *
 * A leg counts at minLegR or more: its points over refRiskPts (the run's reference 1R). An entry enters the leg its way
 * whose span holds its time. Measures (shares of the leg's points, side-aware, rounded to 2):
 *   (1) entered, atFirst (its entry's rank is 1), entryLag ((entry - from) / points)
 *   (2) banked ((exit - entry) / points) and lost: beforeEntry (the lag), and the rest after the exit: shakenOut (a stop or
 *       trail exit before the leg's extreme), modelEarly (the model's exit before it), givenBack (an exit after it: the
 *       extreme to the exit). An entry still open: banked null, nothing split.
 *   (3) falseFirsts: rank #1 entries inside no counted leg their way: { n, r }
 *   (4) passedFirsts: counted legs no entry entered, with a rank #1 pick their way inside the span not taken
 *   (5) pickTable: every pick, took or passed, x a counted leg its way holding the pick's time (came) or none
 *   (6) headline: { legs, enteredAtFirst, bankedShare (the mean banked of the entered legs), trades, rPerTrade (every
 *       entry with an R), passRate (picks passed / picks), blows (the caller's) }
 *
 *   legsFrom(trendLegs)          goal-metrics.js trendLegs' legs as this module reads them (id = day|side|start)
 *   score({ legs, entries, picks, refRiskPts, minLegR, blows })   the scorecard (above)
 *   pickTable(rows, { reps, seed, ci })   the SELECTION scorecard, primary (below)
 *   paired(a, b)                 two runs' scorecards side by side: delta (a's headline minus b's), onlyA, onlyB (legs one
 *                                entered at #1 and the other did not)
 */

const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const ms = iso => Date.parse(iso);
const sgn = side => (side === 'short' ? -1 : 1);
const inSpan = (at, g) => ms(at) >= ms(g.start) && ms(at) <= ms(g.end);

function legsFrom(trendLegs) {
  return (trendLegs || []).map(g => ({ id: `${g.day}|${g.side}|${g.start}`, day: g.day, side: g.side, start: g.start, end: g.end, from: g.from, to: g.to, points: Math.abs(g.to - g.from) }));
}

function rideOf(g, e) {
  const s = sgn(g.side);
  const share = x => r2((s * x) / g.points);
  const out = { entered: true, atFirst: e.rank === 1, entryLag: share(e.entry - g.from), banked: null, lost: null };
  if (!Number.isFinite(e.exit) || e.exitBy === 'open') return out;
  out.banked = share(e.exit - e.entry);
  const rest = share(g.to - e.exit);
  const after = ms(e.exitAt) > ms(g.end);
  out.lost = { beforeEntry: out.entryLag, shakenOut: !after && e.exitBy !== 'model' ? rest : 0, givenBack: after ? rest : 0, modelEarly: !after && e.exitBy === 'model' ? rest : 0 };
  return out;
}

function score({ legs = [], entries = [], picks = [], refRiskPts, minLegR, blows = null } = {}) {
  if (!(refRiskPts > 0) || !Number.isFinite(minLegR)) throw new Error('selection-score: refRiskPts and minLegR are required (the legs table)');
  const counted = legs.filter(g => g.points / refRiskPts >= minLegR - 1e-9);
  const legOf = x => counted.find(g => g.side === x.side && inSpan(x.at, g)) || null;
  const out = counted.map(g => {
    const e = entries.filter(x => x.side === g.side && inSpan(x.at, g)).sort((a, b) => ms(a.at) - ms(b.at))[0];
    return { id: g.id, side: g.side, points: g.points, r: r2(g.points / refRiskPts), ...(e ? rideOf(g, e) : { entered: false, atFirst: false, entryLag: null, banked: null, lost: null }) };
  });
  const firsts = entries.filter(e => e.rank === 1 && !legOf(e));
  const passed = counted.filter(g => !out.find(x => x.id === g.id).entered && picks.some(p => p.side === g.side && p.rank === 1 && !p.took && inSpan(p.at, g)));
  const table = { tookTrend: 0, tookNone: 0, passedTrend: 0, passedNone: 0 };
  for (const p of picks) table[`${p.took ? 'took' : 'passed'}${legOf(p) ? 'Trend' : 'None'}`] += 1;
  const banked = out.filter(x => x.entered && x.banked !== null).map(x => x.banked);
  const rs = entries.map(e => e.r).filter(Number.isFinite);
  return {
    legs: out,
    falseFirsts: { n: firsts.length, r: r2(firsts.map(e => e.r).filter(Number.isFinite).reduce((a, b) => a + b, 0)) },
    passedFirsts: passed.map(g => ({ id: g.id, side: g.side, r: r2(g.points / refRiskPts) })),
    pickTable: table,
    headline: {
      legs: counted.length, enteredAtFirst: out.filter(x => x.atFirst).length, bankedShare: banked.length ? r2(banked.reduce((a, b) => a + b, 0) / banked.length) : null,
      trades: entries.length, rPerTrade: rs.length ? r2(rs.reduce((a, b) => a + b, 0) / rs.length) : null, passRate: picks.length ? r2(picks.filter(p => !p.took).length / picks.length) : null, blows,
    },
  };
}

/**
 * The SELECTION scorecard (the owner, 2026-11-18: select profitable continuation opportunities from structurally valid
 * candidates), the primary table: every candidate once, by the model's decision (took, waited: a WAIT still open when the
 * run ended; passed: a PASS, or a WAIT the candidate outlived only to void or expire) x its outcome on ONE ruler (the
 * shipped trail from the first printed bar's close, the structural stop: `outcome` { R, points } or null). Per state: n,
 * mean, median and total R and points, the mean's by-session bootstrap interval (`ci`, `reps`, `seed`: config's); and
 * took minus passed (the mean difference, R and points, its by-session interval). Pure; the caller hands the rows.
 *   rows [{ key, day, state: 'took' | 'waited' | 'passed' | 'unlabelled', outcome: { R, points } | null }]
 */
const { rng } = require('../prop/stats'); // the seeded source the evaluator's bootstraps use (mulberry32)
const meanOf = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const medianOf = xs => { if (!xs.length) return null; const a = xs.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const quant = (xs, q) => { const a = xs.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))] : null; };
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
  const lo = (1 - ci) / 2;
  return out.length ? [r2(quant(out, lo)), r2(quant(out, 1 - lo))] : null;
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
  const states = Object.fromEntries(['took', 'waited', 'passed'].map(st => [st, cell(byState(st))]));
  // Took minus passed, resampled by session (a session's candidates move together).
  const tp = scored.filter(x => x.state === 'took' || x.state === 'passed');
  const diff = (d, k) => { const all = d.flat(); const t = all.filter(x => x.state === 'took').map(x => x.outcome[k]); const q = all.filter(x => x.state === 'passed').map(x => x.outcome[k]); return t.length && q.length ? meanOf(t) - meanOf(q) : NaN; };
  const days = daysOf(tp);
  const d0 = k => { const v = diff([tp], k); return Number.isFinite(v) ? r2(v) : null; };
  return {
    candidates: rows.length, scored: scored.length, unlabelled: rows.filter(x => x.state === 'unlabelled').length, states,
    tookMinusPassed: { R: d0('R'), Rci: bootDays(days, d => diff(d, 'R'), { reps, seed, ci }), points: d0('points'), pointsCi: bootDays(days, d => diff(d, 'points'), { reps, seed, ci }) },
  };
}

function paired(a, b) {
  const delta = Object.fromEntries(Object.keys(a.headline).map(k => [k, Number.isFinite(a.headline[k]) && Number.isFinite(b.headline[k]) ? r2(a.headline[k] - b.headline[k]) : null]));
  const first = s => new Set(s.legs.filter(x => x.atFirst).map(x => x.id));
  const A = first(a);
  const B = first(b);
  return { a: a.headline, b: b.headline, delta, onlyA: [...A].filter(x => !B.has(x)), onlyB: [...B].filter(x => !A.has(x)) };
}

module.exports = { legsFrom, score, paired, pickTable };
