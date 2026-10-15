'use strict';

/**
 * The model's replay trades as a trade stream: the evaluator's layer-2 input (prop/attempts.js, prop/evaluator.js) built
 * from what a replay run filled, in place of trade-stream.js's scan for the composed trade (docs/COMPOSED-ENTRY.md,
 * phase B "attempts from replay fills"). One adapter for every run: a full-day run (practice, validate, test, final) and
 * a curated or setup-focused practice run read the same way; only the score's label and weights differ
 * (prop/model-score.js, prop/natural-rate.js).
 *
 * Source: the run's own records through learning/run-experience.js runDecisions (the store lines' trade cycles and the
 * replay broker's fills, the trade_lifecycle records, the run's bars), the one function the experience log is written
 * by. Each `entered` decision (an opening fill credited to an ok record) is one trade:
 *   moveTicks, r      from the replay broker's fills only (the experience log's outcome, source `fills`: size-weighted
 *                     entry and exit prices), never re-derived from bars;
 *   stopTicks         the record's stop distance (the bracket is placed that far from the fill), in ticks;
 *   troughTicks       the adverse path, each deeper trough in ticks from the fill, read on the run's own bars from the
 *                     fill's bar to the exit's (those two bars whole: the side of the fill a low fell on is unknown,
 *                     so the worse is taken), never deeper than the stop's fill (the bracket was working) unless the
 *                     exit itself was; without those bars, one trough at the stop's fill (`adverse: 'bound'`), the
 *                     worst a working bracket allows (fails closed: a guess never flatters an attempt);
 *   overshootTicks    a stop exit (the exit at or past the bracket's stop): ticks past the stop beyond the expected
 *                     slippage (SLIPPAGE_TICKS), resampled by the bootstrap; null for any other exit (a trailed stop's
 *                     level isn't recorded, so its overshoot isn't known);
 *   noStop            the worst move and the last close to the day's end (trade-stream.js noStopPath) on the run's own
 *                     bars, used only when a stop fault is injected; null without the bars;
 *   day, seq          the session day it settled (experience-log.js settledDay) and its order within it, by its fill;
 *   r                 gross R: the price move from the fill to the exit over the stop distance, before fees (the
 *                     stream's `rBasis`); layer 2 settles net dollars (fees per contract), and its expectancy cuts are
 *                     on the same gross basis (attempts.js expectancyR: move over stop);
 *   facts             the record's context (regime, volatility, window, biasSide, alignment, dayType), its skill
 *                     signature, exploratory, frame, and its curated list when the run tagged one (`list`).
 * Every session day the run replayed is a day of the stream: a day the model passed (passes, plain passes, refusals)
 * is a no-trade day, with its count of the model's passes (`passes`, for the risk attribution). A day's regime is
 * trade-stream.js dayRegimes on the run's bars (its range against the days before it, as the mechanical stream
 * computed it) for the regime-matched bootstrap joins; a day without bars takes the volatility its first composed
 * record read, else 'normal'.
 *
 * An entered decision without a settled outcome (still open, fills unreadable, no stop distance, no contract spec) is
 * left out and listed in `excluded` with why; a real score refuses a stream with any (prop/model-score.js), since a
 * dropped loss would flatter it. A run whose outcomes are hidden (a reasoning-fix look) has no stream.
 *
 *   modelStream({ decisions, dayKeys, barsFor, tfMs, eod, specOf })   the stream (pure)
 *   readModelStream(runDir, { root, barsFiles })   { stream, run: { runId, from, to, learning, role, look, hideOutcomes,
 *                                                  practice, ledger } } from a finished run
 */

const { SLIPPAGE_TICKS } = require('../replay/counterfactual');
const { specFor, familyRoot } = require('../trading/contracts');
const { noStopPath, dayRegimes } = require('./trade-stream');
const { runDecisions } = require('../learning/run-experience');
const { parseAt } = require('../autotrader');

const round6 = x => Math.round(x * 1e6) / 1e6;
const CONTEXT = ['regime', 'volatility', 'window', 'biasSide', 'alignment', 'dayType'];

/** The adverse path in ticks from the fill: each deeper trough, never below `floor` (see the header). */
function adversePath(bars, { entryMs, exitMs, tfMs, side, entry, tick, floor }) {
  const s = side === 'long' ? 1 : -1;
  const out = [];
  let worst = 0;
  let seen = 0;
  for (const b of bars) {
    if (b.ms + tfMs <= entryMs) continue;
    if (b.ms > exitMs) break;
    seen += 1;
    const adverse = Math.max(floor, round6((s * ((s > 0 ? b.l : b.h) - entry)) / tick));
    if (adverse < worst) { worst = adverse; out.push(adverse); }
  }
  return seen ? out : null;
}

function tradeOf(d, { barsFor, tfMs, eod, specOf }) {
  const o = d.outcome || {};
  const spec = specOf(familyRoot(d.root) || d.root);
  const risk = d.plan && Number.isFinite(d.plan.entry) && Number.isFinite(d.plan.stop) ? Math.abs(d.plan.entry - d.plan.stop) : NaN;
  const why = !spec || !(spec.tickSize > 0) ? `no contract spec for ${d.root}`
    : o.source !== 'fills' ? 'no fills for the entry'
      : !Number.isFinite(o.entryPrice) || !Number.isFinite(o.exitPrice) ? `not closed (${o.exitReason || 'no exit'})`
        : !(risk > 0) ? 'no stop distance in the record' : null;
  if (why) return { excluded: { id: d.id, root: d.root, bar: d.bar, why } };
  const s = d.side === 'long' ? 1 : -1;
  const tick = spec.tickSize;
  const stopTicks = Math.round(risk / tick);
  const moveTicks = round6((s * (o.exitPrice - o.entryPrice)) / tick);
  const stopPx = o.entryPrice - s * risk;
  // The deepest a working bracket lets the trade go: its stop, filled with the expected slippage, or the exit when worse.
  const floor = Math.min(moveTicks, -(stopTicks + SLIPPAGE_TICKS));
  const stopped = s * (o.exitPrice - stopPx) <= 1e-9;
  const entryMs = Date.parse(o.entryTime);
  const exitMs = Date.parse(o.exitTime);
  const bars = barsFor(d.root) || [];
  const fromBars = Number.isFinite(entryMs) && Number.isFinite(exitMs) && bars.length ? adversePath(bars, { entryMs, exitMs, tfMs, side: d.side, entry: o.entryPrice, tick, floor }) : null;
  let troughTicks = fromBars || (floor < 0 ? [floor] : []);
  const last = troughTicks.length ? troughTicks[troughTicks.length - 1] : 0;
  if (moveTicks < Math.min(0, last)) troughTicks = [...troughTicks, moveTicks];
  const noStop = Number.isFinite(entryMs) && bars.length
    ? noStopPath({ bars, tickSize: tick }, { direction: d.side, entryTime: o.entryTime, entry: o.entryPrice }, { tfMs, eod }) : null;
  const facts = Object.fromEntries(CONTEXT.map(k => [k, d.context ? d.context[k] ?? null : null]));
  return {
    trade: {
      id: d.id, day: d.settledDay || d.day, symbol: familyRoot(d.root) || d.root, contract: d.contract || null, strategy: 'trade_lifecycle', direction: d.side,
      bar: d.bar, entryTime: o.entryTime || null, exitTime: o.exitTime || null, reason: stopped ? 'stop' : o.exitReason || 'closed',
      tickSize: tick, tickValue: spec.tickValue, feesPerSide: spec.feesPerSide ?? 0.37,
      stopTicks, moveTicks, r: o.R, troughTicks, adverse: fromBars ? 'bars' : 'bound',
      overshootTicks: stopped ? Math.max(0, round6((s * (stopPx - o.exitPrice)) / tick - SLIPPAGE_TICKS)) : null,
      noStop, facts: { ...facts, skill: d.signatures ? d.signatures.skill : null, exploratory: Boolean(d.exploratory), frame: d.frame || null, list: d.list ?? null },
      entryMs,
    },
  };
}

/**
 * The stream from a run's decisions (experience-log.js buildDecisions lines). dayKeys: every session day the run
 * replayed; barsFor(root): the run's bars ({ ms, o, h, l, c }, sorted); tfMs: the bar length; eod: the runner's end
 * of day (autotrader parseAt), or null (to the trading day's end); specOf(root): the contract spec (tickSize,
 * tickValue, feesPerSide).
 */
function modelStream({ decisions = [], dayKeys = [], barsFor = () => [], tfMs, eod = null, specOf = specFor, regimes = null }) {
  const started = Date.now();
  if (!(tfMs > 0)) throw new Error('tfMs: the run\'s bar length in ms');
  if (decisions.some(d => d && d.hidden)) throw new Error('the run\'s outcomes are hidden (a reasoning-fix look): no trade stream');
  const trades = [];
  const excluded = [];
  for (const d of decisions) {
    if (!d || d.decision !== 'entered') continue;
    const r = tradeOf(d, { barsFor, tfMs, eod, specOf });
    if (r.excluded) excluded.push(r.excluded);
    else trades.push(r.trade);
  }
  const keys = [...new Set([...dayKeys, ...trades.map(t => t.day)])].sort();
  const byDay = new Map(keys.map(k => [k, []]));
  for (const t of trades) byDay.get(t.day).push(t);
  const regimeOf = new Map();
  const passesOn = new Map();
  for (const d of decisions) if (d && d.decision === 'passed') passesOn.set(d.day, (passesOn.get(d.day) || 0) + 1);
  for (const d of decisions) {
    if (!d || d.decision === 'none' || regimeOf.has(d.day)) continue;
    const v = d.context && d.context.volatility;
    if (v) regimeOf.set(d.day, String(v));
  }
  const days = keys.map(day => {
    const list = byDay.get(day).sort((a, b) => (a.entryMs - b.entryMs) || String(a.id).localeCompare(String(b.id)));
    return { day, regime: (regimes && regimes.get(day)) || regimeOf.get(day) || 'normal', passes: passesOn.get(day) || 0, trades: list.map((t, seq) => { const { entryMs: _m, ...rest } = t; return Object.assign(rest, { seq }); }) };
  });
  const all = days.flatMap(d => d.trades);
  return {
    source: 'model', rBasis: 'gross', days, trades: all, excluded, fieldBranch: [], entryDelayMs: null, slippageTicks: SLIPPAGE_TICKS, timeframe: tfMs / 60000,
    noStop: { known: all.filter(t => t.noStop).length, missing: all.filter(t => !t.noStop).length },
    adverse: { bars: all.filter(t => t.adverse === 'bars').length, bound: all.filter(t => t.adverse === 'bound').length },
    decisions: { total: decisions.length, entered: decisions.filter(d => d && d.decision === 'entered').length },
    runtimeMs: Date.now() - started,
  };
}

const nextDay = iso => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** A finished run's stream and what its score is checked against (prop/evaluator.js checkModelWindow). */
function readModelStream(runDir, { root = null, barsFiles = {} } = {}) {
  const r = runDecisions(runDir, { root, barsFiles });
  const gate = r.gate || null;
  if (gate && gate.hideOutcomes) throw new Error(`run ${r.manifest.runId} is a reasoning-fix look: its outcomes are hidden, so it has no trade stream`);
  const eod = r.cfg && r.cfg.eodAt ? parseAt(r.cfg.eodAt) : null;
  // The day regimes on the first symbol's bars (the regime-matched joins), as the mechanical stream's.
  const roots = [...new Set(r.decisions.filter(d => d && d.root).map(d => d.root))];
  const first = (Array.isArray(r.cfg.symbols) && r.cfg.symbols[0] ? familyRoot(r.cfg.symbols[0]) : null) || roots[0] || null;
  const bars = first ? r.barsFor(first) || [] : [];
  const regimes = bars.length && r.tfMs ? dayRegimes(bars, r.tfMs) : null;
  const stream = modelStream({ decisions: r.decisions, dayKeys: r.dayKeys, barsFor: r.barsFor, tfMs: r.tfMs, eod, regimes });
  return {
    stream,
    run: {
      runId: r.manifest.runId, from: r.dayKeys[0], to: nextDay(r.dayKeys[r.dayKeys.length - 1]), learning: Boolean(gate && gate.learning === true),
      role: gate ? gate.role || null : null, look: gate ? gate.look || null : null, hideOutcomes: Boolean(gate && gate.hideOutcomes),
      practice: gate ? gate.practice || null : null, ledger: gate ? gate.ledger || null : null, home: r.home, dir: r.dir,
    },
  };
}

module.exports = { modelStream, readModelStream, adversePath };
