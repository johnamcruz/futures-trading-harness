'use strict';

/**
 * The read audit (docs/TRAINING.md, "The read audit"): per decision, three columns side by side, and the decision sorted
 * by them. A measurement only: nothing that decides (the gate, compose_check, sizing, the stop, the exits, the runner,
 * the briefing, a prompt, a skill) reads it; the model is asked nothing.
 *
 *   1 READ      what the model read: its closed-form STATE line (trading/state-read.js), as its cycle log recorded it
 *   2 STATE     what the market was doing: the cycle bar's briefing labels the read was scored against at that bar, and
 *               their context (stateFacts: the day so far, the regime), as recorded at the cycle; built from the bars up
 *               to that bar only, never rebuilt here
 *   3 OUTCOME   what happened next (hindsight, never an input to a read): an entry's exact recorded trade R (the
 *               scorecard's per-trade R on its decision record, trade.r); a pass's forward move for the side its own read
 *               points to (both sides when the read has none) over config/analysis.json readAudit.forwardBars base bars
 *               strictly after the cycle bar, in R of a standard stop of readAudit.stopAtr x ATR(20) at the cycle bar
 *               (Wilder's over the bars up to and including the cycle bar, as labels.js atrAt). From the cycle bar's close: a bar reaching the
 *               stop is -1R (stop first, even when it closes back), else the last bar's close; fewer bars and no stop:
 *               unknown
 *
 * The read's side: long when its own 4h and 1h are both up, short when both down, else none.
 * The scored fields: 4h, 1h, 15m and frames (against the labels). frames-own (the read against itself) and the day so
 * far (no day field in the read: #323) are reported beside, never scored here. Unknown is never a mismatch.
 *
 * The classes (CLASSES), for a decision with a read, at least one scored field, and an outcome:
 *   misread        a scored field mismatches its label
 *   acted-wrong    read right, and an entry contradicts the read's own words (CONSISTENCY)
 *   market-turned  read right, consistent, the trade at or past the stop (R <= -1)
 *   small-loss     read right, consistent, between the stop and 0 (a scratch or a partial loss): its own row
 *   breakeven      read right, consistent, the trade exactly 0R: its own row (neither a loss nor a win)
 *   acted-right    read right, consistent, the trade positive
 *   passed         read right, a no-trade (never acted wrong in v1): reported with its forward move
 * Else unscorable, with why (no record, no line, no scored field, no fill, no decision record, no forward bars yet), and
 * a cycle in a trade is no entry or pass decision (in-trade, counted apart).
 *
 * The consistency table (CONSISTENCY): the trend rule (mtf.js: never against a trending 4h or 1h; both ranging, only the
 * 15m trend's way; no trend on any, no side) held to the read's own words, not the labels. Transition, unknown and an
 * unstated frame say no trend it can be held to.
 *
 *   FIELDS, CLASSES, CONSISTENCY
 *   readSide(read)                        'long' | 'short' | null
 *   inconsistencies(read, side)           the CONSISTENCY keys an entry on that side breaks
 *   forwardMove({ bars, cycleT, side, forwardBars, stopAtr })   { R, stopped, stop, bars, why }
 *   auditDecision({ day, t, symbol, stateRead, decision, orders, result, bars, cfg, barClose, tfMs })   one row (barClose,
 *                                         tfMs: the cycle's base bar close and timeframe, to refuse another lane's record)
 *   summarize(rows)                       the report: per class, by field, by day so far, misread fields, entry losers
 *   renderAudit(summary)                  the report as text
 *   loadDecisions(paths)                  decision records (<run>-decisions.json, scorecard.jsonl) by key
 *   replayDirs(target)                    the replay run dirs under a run home, a runs folder or a replay run dir
 *   runRows(target, { decisions, cfg, days, barsFiles })   { runId, rows } of one run; barsFiles { SYMBOL: data file }
 *                                         (the data the run replayed, the scorecard's --bars): the bars the outcome
 *                                         reads, for a forward window past the run's own archive (a short run's last bars)
 */

const fs = require('fs');
const path = require('path');
const { streamFor, round4 } = require('../prop/stats');
const { dayBootstrap } = require('./experience-index');
const { ATR_PERIOD, loadBars, outcomeBarsFrom } = require('../replay/labels');
const ind = require('../trading/indicators');

const EI = require('../tunables').training().experienceIndex; // config/training.json: the day resampling's level, seed, reps, minimums
const CFG = require('../tunables').analysis().readAudit; // config/analysis.json: the forward window and the standard stop

const FIELDS = Object.freeze(['4h', '1h', '15m', 'frames']);
const CLASSES = Object.freeze([
  ['misread', 'misread: a scored field mismatches the briefing\'s label'],
  ['acted-wrong', 'read right / acted wrong: the entry contradicts the read\'s own words'],
  ['market-turned', 'read right / market turned: consistent, the trade at or past the stop'],
  ['small-loss', 'read right / small loss: consistent, between the stop and 0'],
  ['breakeven', 'read right / breakeven: consistent, the trade exactly 0R'],
  ['acted-right', 'read right / acted right: consistent, the trade positive'],
  ['passed', 'read right / passed: a no-trade, with its forward move'],
].map(([key, says]) => Object.freeze({ key, says })));
const ENTRY_CLASSES = ['misread', 'acted-wrong', 'market-turned', 'small-loss'];
const OPP = { long: 'down', short: 'up' };
const frameOf = (read, k) => (read && read.frames && typeof read.frames[k] === 'string' ? read.frames[k] : null);
const CONSISTENCY = Object.freeze([
  { key: 'counter-own-htf', says: 'the read\'s own 4h or 1h trends against the entry (the trend rule: never against a trending 4h or 1h)', broken: (r, s) => frameOf(r, '4h') === OPP[s] || frameOf(r, '1h') === OPP[s] },
  { key: 'counter-own-15m', says: 'the read\'s own 4h and 1h range and its 15m trends against the entry (both ranging: only the 15m trend\'s way)', broken: (r, s) => frameOf(r, '4h') === 'range' && frameOf(r, '1h') === 'range' && frameOf(r, '15m') === OPP[s] },
  { key: 'no-own-side', says: 'the read\'s own 4h, 1h and 15m all range (no trend on any: no side)', broken: r => ['4h', '1h', '15m'].every(k => frameOf(r, k) === 'range') },
].map(Object.freeze));

const { MINUTE } = require('../backtest/data'); // ms in a minute
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const fin = Number.isFinite;
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return null; } };

function readSide(read) {
  const a = frameOf(read, '4h');
  return a && a === frameOf(read, '1h') ? { up: 'long', down: 'short' }[a] || null : null;
}

const inconsistencies = (read, side) => (OPP[side] ? CONSISTENCY.filter(c => c.broken(read, side)).map(c => c.key) : []);

const TIMED = new WeakMap(); // an array of bars -> its timed, sorted copy (a run's bars are read once, not per decision)
function timed(bars) {
  if (!Array.isArray(bars)) return [];
  if (!TIMED.has(bars)) {
    TIMED.set(bars, bars.filter(b => isObj(b)).map(b => (fin(b.ms) ? b : { ...b, ms: Date.parse(b.t) }))
      .filter(b => fin(b.ms) && [b.h, b.l, b.c].every(fin)).sort((a, b) => a.ms - b.ms));
  }
  return TIMED.get(bars);
}
/** Wilder's ATR(20) at each bar (labels.js atrAt's: the bars up to and including it; none before the period), once a list. */
const ATRS = new WeakMap();
function atrAtIndex(list, i) {
  if (!ATRS.has(list)) ATRS.set(list, ind.atr(list, ATR_PERIOD));
  const v = ATRS.get(list)[i]; // NaN before the period's first value (indicators.js rma)
  return fin(v) && v > 0 ? v : null;
}
/** The index of the bar opening at ms in sorted bars, or -1. */
function indexAt(list, ms) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].ms === ms) return mid;
    if (list[mid].ms < ms) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

function forwardMove({ bars, cycleT, side, forwardBars = CFG.forwardBars, stopAtr = CFG.stopAtr }) {
  const out = (why, extra = {}) => ({ R: null, stopped: null, stop: null, bars: 0, why, ...extra });
  const list = timed(bars);
  const at = Date.parse(cycleT);
  const i = indexAt(list, at);
  if (i < 0) return out('the cycle bar is not in the bars archive (another symbol or timeframe?)');
  const atr = atrAtIndex(list, i);
  if (!atr) return out('no ATR at the cycle bar (too few bars before it)');
  const stop = round4(stopAtr * atr);
  const entry = list[i].c;
  const dir = side === 'long' ? 1 : -1;
  const after = list.slice(i + 1, i + 1 + forwardBars);
  for (let k = 0; k < after.length; k += 1) {
    const b = after[k];
    if (side === 'long' ? b.l <= entry - stop : b.h >= entry + stop) return { R: -1, stopped: true, stop, bars: k + 1, why: null };
  }
  if (after.length < forwardBars) return out(`no forward bars yet (${after.length} of ${forwardBars})`, { stop });
  return { R: round4((dir * (after[after.length - 1].c - entry)) / stop), stopped: false, stop, bars: after.length, why: null };
}

const outcomeWord = result => ((/CYCLE RESULT:[\s*_`]*([a-z][a-z-]*)/i.exec(String(result || '')) || [])[1] || '').toLowerCase();

/** The decision's kind and side: its record's when joined, else the cycle's own (a managed result, an allowed order). */
function kindOf({ decision, orders, result }) {
  if (isObj(decision)) {
    if (decision.inTrade === true || decision.decision === 'in-trade') return { kind: 'in-trade', side: null };
    const a = isObj(decision.actual) ? decision.actual.action : null;
    return a === 'long' || a === 'short' ? { kind: 'entry', side: a } : { kind: 'pass', side: null };
  }
  if (outcomeWord(result) === 'managed') return { kind: 'in-trade', side: null };
  const o = (Array.isArray(orders) ? orders : []).find(x => isObj(x) && x.gate === 'allowed' && (x.side === 'buy' || x.side === 'sell'));
  return o ? { kind: 'entry', side: o.side === 'buy' ? 'long' : 'short' } : { kind: 'pass', side: null };
}

/** Column 1: the read as recorded. */
const readColumn = s => (isObj(s) && isObj(s.read) ? { status: s.status, frames: { ...s.read.frames }, agree: s.read.agree ?? null } : isObj(s) ? { status: s.error ? 'error' : s.status || null, frames: null, agree: null } : null);
/** Column 2: the labels it was scored against at its bar, and their context, as recorded. */
function stateColumn(s) {
  if (!isObj(s) || !isObj(s.fields)) return null;
  const fields = {};
  for (const k of [...FIELDS, 'frames-own']) {
    const f = s.fields[k];
    if (isObj(f)) fields[k] = { read: f.read ?? null, fact: f.fact ?? null, result: f.result || null };
  }
  const f = isObj(s.facts) ? s.facts : {};
  return { fields, facts: { frames: f.frames || null, daySoFar: f.daySoFar ?? null, dayType: f.dayType ?? null, regime: f.regime ?? null, trendRule: f.trendRule ?? null } };
}

/** Column 3, OUTCOME: hindsight. */
function outcomeColumn({ kind, side, decision, read, bars, cycleT, cfg }) {
  if (kind === 'in-trade') return null;
  if (kind === 'entry') {
    const tr = isObj(decision) ? decision.trade : undefined;
    if (isObj(tr) && fin(tr.r)) return { basis: 'trade', side, R: tr.r, stopped: tr.r <= -1, why: null };
    return { basis: 'trade', side, R: null, stopped: null, why: isObj(decision) ? 'entry not filled (no trade on its decision record)' : 'no decision record (the trade R is read only from it)' };
  }
  const rs = readSide(read);
  const fm = s => forwardMove({ bars, cycleT, side: s, forwardBars: cfg.forwardBars, stopAtr: cfg.stopAtr });
  if (rs) { const f = fm(rs); return { basis: 'forward', side: rs, R: f.R, stopped: f.stopped, stop: f.stop, why: f.why }; }
  const [l, s] = [fm('long'), fm('short')];
  return { basis: 'forward', side: null, R: null, long: l.R, short: s.R, stop: l.stop, why: l.R === null || s.R === null ? l.why || s.why : null };
}

function unscorableWhy(row, s, { barClose, tfMs }) {
  if (!isObj(s)) return 'no state record';
  if (s.error) return 'state record error';
  if (s.status !== 'read') return s.status === 'none' ? 'no STATE line (status none)' : `STATE line ${s.status || 'unrecorded'}`;
  // The record's bar must be the cycle's base bar (its close the cycle's bar close): another lane's or timeframe's bar
  // would be measured against the wrong bars, so it is counted apart, never scored.
  const close = Date.parse(barClose);
  if (s.bar && fin(close) && fin(tfMs) && tfMs > 0 && Date.parse(s.bar) + tfMs !== close) return 'the state record\'s bar is not the cycle\'s base bar (another lane or timeframe)';
  if (!row.scored.length) return 'no scored field (every stated field unknown)';
  return row.outcome.why || null;
}

function auditDecision({ day, t, symbol, stateRead = null, decision = null, orders = [], result = null, bars = [], cfg = CFG, barClose = null, tfMs = null }) {
  const { kind, side } = kindOf({ decision, orders, result });
  const s = isObj(stateRead) ? stateRead : null;
  const state = stateColumn(s);
  const fields = state ? state.fields : {};
  const read = s && isObj(s.read) ? s.read : null;
  const cycleT = (s && s.bar) || (isObj(decision) && decision.barT) || null;
  const row = {
    day, t, symbol, bar: cycleT, kind, side, joined: isObj(decision),
    read: readColumn(s), state,
    scored: FIELDS.filter(k => isObj(fields[k]) && (fields[k].result === 'match' || fields[k].result === 'mismatch')),
    misread: FIELDS.filter(k => isObj(fields[k]) && fields[k].result === 'mismatch'),
    broken: kind === 'entry' ? inconsistencies(read, side) : [],
    outcome: outcomeColumn({ kind, side, decision, read, bars, cycleT, cfg }),
    class: null, unscorable: null,
  };
  if (kind === 'in-trade') return row;
  row.unscorable = unscorableWhy(row, s, { barClose, tfMs });
  if (row.unscorable) return row;
  const R = row.outcome.R;
  if (row.misread.length) row.class = 'misread';
  else if (kind === 'pass') row.class = 'passed';
  else if (row.broken.length) row.class = 'acted-wrong';
  else row.class = R <= -1 ? 'market-turned' : R > 0 ? 'acted-right' : R === 0 ? 'breakeven' : 'small-loss';
  return row;
}

// ---- The report ----

/** sum(num) / sum(den) over whole days resampled: the experience index's own day bootstrap, at its level and reps. */
const dayInterval = (days, key) => dayBootstrap(days, days.map(d => d.num), days.map(d => d.den), { reps: EI.reps, rand: streamFor(EI.seed, `read-audit|${key}`) });
const byDay = (rows, num, den) => {
  const m = new Map();
  for (const r of rows) { const d = m.get(r.day) || { num: 0, den: 0 }; d.num += num(r); d.den += den(r); m.set(r.day, d); }
  return m;
};
const interval = (rows, n, num, den, key) => {
  const days = byDay(rows, num, den);
  return n < EI.minN || days.size < EI.minDays ? { lo: null, hi: null, tooFew: true } : dayInterval([...days.values()], key);
};
const sumR = rows => (rows.length ? round4(rows.reduce((a, r) => a + r.outcome.R, 0)) : null);

/** A cell: n, net and mean R (known R only, unknown never 0), its interval, and without its best day. */
function cell(rows, key) {
  const known = rows.filter(r => r.outcome && fin(r.outcome.R));
  const days = byDay(known, r => r.outcome.R, () => 1);
  const best = [...days.entries()].sort((a, b) => b[1].num - a[1].num || (a[0] < b[0] ? -1 : 1))[0];
  const rest = best ? known.filter(r => r.day !== best[0]) : [];
  const out = {
    n: rows.length, knownR: known.length, netR: sumR(known), meanR: known.length ? round4(sumR(known) / known.length) : null,
    ...interval(known, known.length, r => r.outcome.R, () => 1, key),
    withoutBest: best ? { day: best[0], n: rows.filter(r => r.day !== best[0]).length, netR: sumR(rest) } : null,
  };
  const noSide = rows.filter(r => r.kind === 'pass' && r.outcome && r.outcome.side === null);
  // Each side summed over its known moves only (unknown never 0), its known n beside the cell's n.
  const sideOf = k => { const v = noSide.map(r => r.outcome[k]).filter(fin); return [v.length, v.length ? round4(v.reduce((a, x) => a + x, 0)) : null]; };
  if (noSide.length) { const [kl, l] = sideOf('long'); const [ks, sh] = sideOf('short'); out.noSide = { n: noSide.length, knownLong: kl, longR: l, knownShort: ks, shortR: sh }; }
  return out;
}
const split = (rows, key) => ({ n: rows.length, entries: cell(rows.filter(r => r.kind === 'entry'), `${key}|entries`), passes: cell(rows.filter(r => r.kind === 'pass'), `${key}|passes`) });
const tallyOf = (rows, keyOf) => rows.reduce((m, r) => { const k = keyOf(r); m[k] = (m[k] || 0) + 1; return m; }, {});

function summarize(rows) {
  const considered = rows.filter(r => r.kind !== 'in-trade');
  const scorable = considered.filter(r => r.class);
  const un = considered.filter(r => !r.class);
  const classes = {};
  for (const { key } of CLASSES) {
    const mine = scorable.filter(r => r.class === key);
    classes[key] = { ...split(mine, key), share: scorable.length ? round4(mine.length / scorable.length) : null, days: new Set(mine.map(r => r.day)).size,
      ...interval(scorable, scorable.length, r => (r.class === key ? 1 : 0), () => 1, `${key}|share`) };
  }
  const byField = {};
  for (const f of FIELDS) {
    const bucket = r => { const x = r.state && r.state.fields[f]; return x ? x.result : 'unstated'; };
    byField[f] = Object.fromEntries(['match', 'mismatch', 'unknown', 'unstated'].map(b => [b, split(scorable.filter(r => bucket(r) === b), `${f}|${b}`)]));
  }
  const loserOf = r => r.kind === 'entry' && r.outcome && fin(r.outcome.R) && r.outcome.R < 0;
  const losers = considered.filter(loserOf);
  const misreadFields = FIELDS.map(f => {
    const on = scorable.filter(r => r.misread.includes(f));
    const e = on.filter(r => r.kind === 'entry');
    return { field: f, entries: { n: e.length, netR: sumR(e.filter(r => fin(r.outcome.R))), losers: e.filter(loserOf).length }, passes: { n: on.length - e.length, netR: sumR(on.filter(r => r.kind === 'pass' && fin(r.outcome.R))) } };
  }).sort((a, b) => (a.entries.netR ?? Infinity) - (b.entries.netR ?? Infinity) || (a.passes.netR ?? Infinity) - (b.passes.netR ?? Infinity));
  return {
    decisions: rows.length, inTrade: rows.length - considered.length, considered: considered.length, scorable: scorable.length,
    level: EI.level, cfg: { forwardBars: CFG.forwardBars, stopAtr: CFG.stopAtr },
    unjoined: { entries: considered.filter(r => r.kind === 'entry' && !r.joined).length, passes: considered.filter(r => r.kind === 'pass' && !r.joined).length },
    unscorable: { n: un.length, entries: un.filter(r => r.kind === 'entry').length, passes: un.filter(r => r.kind === 'pass').length, why: tallyOf(un, r => r.unscorable), outcome: split(un, 'unscorable') },
    classes, byField,
    framesOwn: tallyOf(scorable, r => (r.state && r.state.fields['frames-own'] ? r.state.fields['frames-own'].result : 'unstated')),
    byDayState: scorable.reduce((m, r) => { const k = (r.state && (r.state.facts.daySoFar || r.state.facts.dayType)) || 'none'; m[k] = m[k] || {}; m[k][r.class] = (m[k][r.class] || 0) + 1; return m; }, {}),
    misreadFields,
    entryLosers: { n: losers.length, byClass: Object.fromEntries(ENTRY_CLASSES.map(c => [c, losers.filter(r => r.class === c).length])), unscorable: tallyOf(losers.filter(r => !r.class), r => r.unscorable) },
  };
}

const pct = x => (x === null || x === undefined ? '-' : x.toLocaleString('en-US', { style: 'percent' }));
const rr = x => (x === null || x === undefined ? '-' : `${x > 0 ? '+' : ''}${x}R`);
const ci = c => (c.tooFew ? 'too few for an interval' : c.lo === null ? 'no interval' : `[${c.lo}, ${c.hi}]`);
const cellText = c => `n ${c.n}, R known ${c.knownR}, net ${rr(c.netR)}, mean ${rr(c.meanR)} ${ci(c)}${c.withoutBest ? `; without best day ${c.withoutBest.day}: n ${c.withoutBest.n}, net ${rr(c.withoutBest.netR)}` : ''}${c.noSide ? `; no read side n ${c.noSide.n}: long ${rr(c.noSide.longR)} (known ${c.noSide.knownLong}), short ${rr(c.noSide.shortR)} (known ${c.noSide.knownShort})` : ''}`;

function renderAudit(s) {
  const out = [
    `Read audit over ${s.decisions} trade cycles: ${s.inTrade} in a trade (not an entry or pass), ${s.considered} decisions, ${s.scorable} scorable, ${s.unscorable.n} unscorable (entries ${s.unscorable.entries}, passes ${s.unscorable.passes})`,
    `  unscorable why: ${Object.entries(s.unscorable.why).map(([w, n]) => `${w} ${n}`).join('; ') || 'none'}`,
    `  unscorable OUTCOME (no read to class them by): entries ${cellText(s.unscorable.outcome.entries)}`,
    `                                                 passes  ${cellText(s.unscorable.outcome.passes)}`,
    `  no decision record joined: entries ${s.unjoined.entries}, passes ${s.unjoined.passes}`,
    `OUTCOME is hindsight: an entry's exact recorded trade R; a pass's forward move over ${s.cfg.forwardBars} bars after the cycle bar in R of a ${s.cfg.stopAtr} x ATR(20) stop. Intervals day-clustered at ${pct(s.level)}.`,
    'Per class (share of scorable, then entries and passes apart):',
  ];
  for (const { key, says } of CLASSES) {
    const c = s.classes[key];
    out.push(`  ${says}: n ${c.n} (${pct(c.share)} ${ci(c)}, days ${c.days})`, `      entries ${cellText(c.entries)}`, `      passes  ${cellText(c.passes)}`);
  }
  out.push('By field (scorable decisions by the field\'s result; unknown is never a mismatch):');
  for (const [f, b] of Object.entries(s.byField)) out.push(`  ${f}  ${Object.entries(b).map(([k, x]) => `${k} n ${x.n} (entries ${x.entries.n} net ${rr(x.entries.netR)}, passes ${x.passes.n} net ${rr(x.passes.netR)})`).join('; ')}`);
  out.push(`  frames-own (the read against itself, not scored here): ${Object.entries(s.framesOwn).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  out.push(`By the day so far at the bar (context, not scored): ${Object.entries(s.byDayState).map(([d, m]) => `${d} (${Object.entries(m).map(([k, n]) => `${k} ${n}`).join(', ')})`).join('; ') || 'none'}`);
  out.push('Misread fields by R lost (entries\' trade R; passes\' forward R apart):');
  for (const m of s.misreadFields) out.push(`  ${m.field}  entries n ${m.entries.n}, net ${rr(m.entries.netR)}, losers ${m.entries.losers}; passes n ${m.passes.n}, forward net ${rr(m.passes.netR)}`);
  const l = s.entryLosers;
  out.push(`Entry losers (trade R < 0): n ${l.n}: ${Object.entries(l.byClass).map(([k, n]) => `${k} ${n}`).join(', ')}; unscorable ${Object.entries(l.unscorable).map(([k, n]) => `${k} ${n}`).join(', ') || '0'}`);
  return out.join('\n');
}

// ---- The run ----

function loadDecisions(paths) {
  const byKey = new Map();
  const add = r => { if (!isObj(r)) return; const k = r.key || `${r.t}|${r.symbol}`; byKey.set(k, [...(byKey.get(k) || []), r]); };
  const file = f => {
    if (/\.jsonl$/.test(f)) fs.readFileSync(f, 'utf8').split('\n').filter(x => x.trim()).forEach(x => { try { add(JSON.parse(x)); } catch (_err) { /* a torn line */ } });
    else { const doc = readJson(f); (Array.isArray(doc) ? doc : []).forEach(add); }
  };
  for (const p of paths) {
    if (fs.statSync(p).isDirectory()) fs.readdirSync(p).filter(n => /-decisions\.json$|^scorecard\.jsonl$/.test(n)).sort().forEach(n => file(path.join(p, n)));
    else file(p);
  }
  return byKey;
}

/** The record for a key in this run: one stamped with this run first (its id, or the id without the loop's prefix). */
function joinOf(byKey, key, runId) {
  const list = (byKey && byKey.get(key)) || [];
  return list.find(r => r.run && (r.run === runId || runId.endsWith(`-${r.run}`))) || list.find(r => !r.run) || null;
}

const hasManifest = d => fs.existsSync(path.join(d, 'manifest.json'));
const subdirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(d, e.name)).sort(); } catch (_err) { return []; } };
function replayDirs(target) {
  if (hasManifest(target)) return [target];
  const own = subdirs(path.join(target, 'replay')).filter(hasManifest);
  return own.length ? own : subdirs(target).flatMap(h => subdirs(path.join(h, 'replay')).filter(hasManifest));
}

const dataBars = new Map(); // file|tf -> bars, read once a process
const dataOf = (file, tf) => { const k = `${file}|${tf}`; if (!dataBars.has(k)) dataBars.set(k, outcomeBarsFrom(file, tf)); return dataBars.get(k); };

function runRows(target, { decisions = null, cfg = CFG, days = null, barsFiles = {} } = {}) {
  const dir = replayDirs(target)[0];
  if (!dir) throw new Error(`${target}: no replay run (manifest.json) here`);
  const home = path.resolve(dir, '..', '..');
  const { readRun } = require('../replay/store');
  const run = readRun(dir);
  const runId = run.manifest.runId || path.basename(dir);
  const at = readJson(path.join(dir, 'autotrader.json')) || {};
  const tf = Number(at.timeframe) || null;
  const barsOf = new Map();
  const rows = [];
  for (const day of Object.keys(run.days).sort().filter(d => !days || days.includes(d))) {
    for (const line of run.days[day]) {
      if (!isObj(line) || line.kind !== 'trade' || !Array.isArray(line.cycles)) continue;
      const c = line.cycles.filter(x => isObj(x) && x.action === 'trade').pop();
      if (!c) continue;
      const sr = isObj(c.stateRead) ? c.stateRead : null;
      const ran = (Array.isArray(line.ran) ? line.ran : []).find(x => isObj(x) && Array.isArray(x.symbols));
      const symbol = (sr && sr.symbol) || (ran && ran.symbols[0]) || (Array.isArray(at.symbols) ? at.symbols[0] : null);
      if (!barsOf.has(symbol)) barsOf.set(symbol, isObj(barsFiles) && barsFiles[symbol] ? dataOf(barsFiles[symbol], tf) : loadBars(home, symbol, tf));
      rows.push(auditDecision({ day, t: line.t, symbol, stateRead: sr, decision: joinOf(decisions, `${line.t}|${symbol}`, runId), orders: c.orders, result: c.result, bars: barsOf.get(symbol), cfg,
        barClose: isObj(c.timing) ? c.timing.barClose : null, tfMs: tf ? tf * MINUTE : null }));
    }
  }
  return { runId, rows };
}

module.exports = { FIELDS, CLASSES, CONSISTENCY, readSide, inconsistencies, forwardMove, auditDecision, summarize, renderAudit, loadDecisions, replayDirs, runRows };
