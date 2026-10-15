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
 *                     bars, its worst never shallower than the adverse path's (the fill's own bar included), used only
 *                     when a stop fault is injected; null without the bars;
 *   path, pathEnds, swingPath, ownExit   what a policy exit re-exits it on (attempts.js exitAs, mode target,
 *                     target_then_trail or trail; exitPaths): the price path to the day's end from the fill's bar, its
 *                     bars' close times, the structure trail's swing levels, the bracket's target; nulls without bars;
 *   day, seq          the session day it settled (experience-log.js settledDay) and its order within it, by its fill;
 *   r                 gross R: the price move from the fill to the exit over the stop distance, before fees (the
 *                     stream's `rBasis`); layer 2 settles net dollars (fees per contract), and its expectancy cuts are
 *                     on the same gross basis (attempts.js expectancyR: move over stop);
 *   facts             the record's context (regime, volatility, window, biasSide, alignment, dayType), its skill
 *                     signature, exploratory, frame, and its curated list when the run tagged one (`list`).
 *   actions, sizeFraction, hold   the model's risk actions on the entry (prop/risk-actions.js): `size-down` (its
 *                     filled size under the ceiling of the verdict it was sized under: the policy's verdicts file, matched
 *                     by bar, side and market; sizeFraction the share), `early-exit` (closed before its stop, its target and
 *                     end of day; `hold` is the same position held to its bracket: the real fill's price and time, the
 *                     stop and target placed from that price, walked on the run's bars by experience-log.js bracketExit,
 *                     the fill's own bar read after the fill by the worse-is-taken rule). An exit the runner's trail made
 *                     is counted as early too: nothing recorded tells a trailed stop from a tightened one or a manual close.
 * Each day also lists the model's passes on valid composed setups as the trades they would have been (`passed`: the
 * limitOutcome counterfactual the experience log keeps; `day-stop` when an entry of that day had already closed at a net
 * loss, fees included, and the model entered nothing later that day; else `pass`); the score never takes them.
 * Every session day the run replayed is a day of the stream: a day the model passed (passes, plain passes, refusals)
 * is a no-trade day, with its count of the model's passes (`passes`, for the risk attribution). A day's regime is
 * trade-stream.js dayRegimes on the run's bars (its range against the days before it, as the mechanical stream
 * computed it) for the regime-matched bootstrap joins; a day without bars takes the volatility its first composed
 * record read, else 'normal'.
 *
 * An entered decision without a settled outcome (still open, fills unreadable, no stop distance, no contract spec) is
 * left out and listed in `excluded` with why, and so is a round trip of the run's fills that no record placed (a fill
 * after its record expired, a second fill on one record: `trips`, matched to the entered decisions by side, family
 * and opening time); a real score refuses a stream with any (prop/model-score.js), since a dropped loss would flatter
 * it. Trades open at the same time (a scale-in leg, two markets) are listed in `overlaps`: layer 2 settles each trade
 * alone against the account, so their combined drawdown is not seen, and a real score refuses them too. A run whose
 * outcomes are hidden (a reasoning-fix look) has no stream.
 *
 *   modelStream({ decisions, dayKeys, barsFor, tfMs, eod, specOf, regimes, trips, eodOf, verdictOf })   the stream (pure)
 *   readModelStream(runDir, { root, barsFiles })   { stream, run: { runId, from, to, learning, role, look, hideOutcomes,
 *                                                  practice, ledger } } from a finished run
 */

const { SLIPPAGE_TICKS } = require('../replay/counterfactual');
const { specFor, familyRoot } = require('../trading/contracts');
const { noStopPath, dayRegimes, pricePath, pathEnds, swingPath } = require('./trade-stream');
const { runDecisions } = require('../learning/run-experience');
const { parseAt } = require('../autotrader');
const { bracketExit } = require('../learning/experience-log');
const { eodOf } = require('../replay/labels');
const { readVerdicts } = require('../trading/prop-state');

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

/**
 * A filled trade's path in ticks (see the header): the move, the adverse path, the overshoot of a stop exit, the
 * no-stop path. From the fill and exit prices and times given (real fills, or the limitOutcome counterfactual's).
 */
function pathOf({ side, entryPrice, exitPrice, entryTime, exitTime, risk, tick, bars, tfMs, eod }) {
  const s = side === 'long' ? 1 : -1;
  const stopTicks = Math.round(risk / tick);
  const moveTicks = round6((s * (exitPrice - entryPrice)) / tick);
  const stopPx = entryPrice - s * risk;
  // The deepest a working bracket lets the trade go: its stop, filled with the expected slippage, or the exit when worse.
  const floor = Math.min(moveTicks, -(stopTicks + SLIPPAGE_TICKS));
  const stopped = s * (exitPrice - stopPx) <= 1e-9;
  const entryMs = Date.parse(entryTime);
  const exitMs = Date.parse(exitTime);
  const fromBars = Number.isFinite(entryMs) && Number.isFinite(exitMs) && bars.length ? adversePath(bars, { entryMs, exitMs, tfMs, side, entry: entryPrice, tick, floor }) : null;
  let troughTicks = fromBars || (floor < 0 ? [floor] : []);
  const last = troughTicks.length ? troughTicks[troughTicks.length - 1] : 0;
  if (moveTicks < Math.min(0, last)) troughTicks = [...troughTicks, moveTicks];
  const path = Number.isFinite(entryMs) && bars.length ? noStopPath({ bars, tickSize: tick }, { direction: side, entryTime, entry: entryPrice }, { tfMs, eod }) : null;
  // noStopPath starts at the first bar opening after the fill; the fill's own bar, unclamped (no stop was working): the worse.
  const fillBar = path && fromBars ? adversePath(bars, { entryMs, exitMs: entryMs, tfMs, side, entry: entryPrice, tick, floor: -Infinity }) || [] : [];
  const noStop = path ? { ...path, worstTicks: Math.min(path.worstTicks, ...troughTicks, ...fillBar) } : null;
  return {
    stopTicks, moveTicks, troughTicks, adverse: fromBars ? 'bars' : 'bound', stopped, noStop, entryMs, exitMs,
    overshootTicks: stopped ? Math.max(0, round6((s * (stopPx - exitPrice)) / tick - SLIPPAGE_TICKS)) : null,
  };
}

/** The run's bars as a book for trade-stream.js's paths, one per bars list (its swing levels computed once). */
const books = new WeakMap();
function bookOf(bars, tick) {
  if (!books.has(bars)) books.set(bars, new Map());
  const m = books.get(bars);
  // swingSeries reads each bar's time (`t`); the run's bars carry `ms`, a time file's may lack `t`.
  if (!m.has(tick)) m.set(tick, { bars: bars.map(x => (x.t ? x : { ...x, t: new Date(x.ms).toISOString() })), tickSize: tick });
  return m.get(tick);
}

/**
 * The paths a policy exit re-exits the trade on (prop/attempts.js exitAs, as trade-stream.js records them): the price
 * path from the fill's bar to the end of its day (pricePath), when each of those bars closes (pathEnds) and the
 * structure trail's swing levels along it (swingPath), and its own exit: the bracket's target in ticks from the fill
 * (the record's target distance; no trail of its own). A fill inside a bar starts the path at that bar, read by the
 * worse-is-taken rule: its open is the fill, its adverse extreme the whole bar's, its favourable only its close (a high
 * before the fill never reaches a target or a trail). Nulls without the bars.
 */
function exitPaths({ side, entryPrice, entryTime, tick, bars, tfMs, eod, targetDist }) {
  const entryMs = Date.parse(entryTime);
  const ownExit = { targetTicks: targetDist > 0 ? round6(targetDist / tick) : null, trailActivateR: null, trailGivebackR: null };
  const i = Number.isFinite(entryMs) ? bars.findIndex(b => b.ms + tfMs > entryMs) : -1;
  if (i < 0) return { path: null, pathEnds: null, swingPath: null, ownExit };
  const book = bookOf(bars, tick);
  const t = { direction: side, entry: entryPrice, entryTime: new Date(bars[i].ms).toISOString() };
  const path = pricePath(book, t, { tfMs, eod });
  if (path && bars[i].ms < entryMs) path[0] = [0, Math.min(0, path[0][1]), Math.max(0, path[0][3]), path[0][3]];
  return { path, pathEnds: pathEnds(book, t, { tfMs, eod }), swingPath: swingPath(book, t, { tfMs, eod }), ownExit };
}

function factsOf(d) {
  const facts = Object.fromEntries(CONTEXT.map(k => [k, d.context ? d.context[k] ?? null : null]));
  return { ...facts, skill: d.signatures ? d.signatures.skill : null, exploratory: Boolean(d.exploratory), frame: d.frame || null, list: d.list ?? null };
}

/** A trade that closed at a net loss per contract: its move in dollars less both sides' fees (attempts.js counts net). */
const netLoss = t => t.moveTicks * t.tickValue - 2 * t.feesPerSide < 0;
/** An entered decision's fill time (ms), else its cycle's. */
const entryMsOf = e => { const f = Date.parse(e.outcome && e.outcome.entryTime); return Number.isFinite(f) ? f : Date.parse(e.cycleAt); };


function tradeOf(d, { barsFor, tfMs, eod, specOf, eodOf, verdictOf }) {
  const o = d.outcome || {};
  const spec = specOf(familyRoot(d.root) || d.root);
  const risk = d.plan && Number.isFinite(d.plan.entry) && Number.isFinite(d.plan.stop) ? Math.abs(d.plan.entry - d.plan.stop) : NaN;
  const why = !spec || !(spec.tickSize > 0) ? `no contract spec for ${d.root}`
    : o.source !== 'fills' ? 'no fills for the entry'
      : !Number.isFinite(o.entryPrice) || !Number.isFinite(o.exitPrice) ? `not closed (${o.exitReason || 'no exit'})`
        : !(risk > 0) ? 'no stop distance in the record' : null;
  if (why) return { excluded: { id: d.id, root: d.root, bar: d.bar, why } };
  const tick = spec.tickSize;
  const bars = barsFor(d.root) || [];
  const p = pathOf({ side: d.side, entryPrice: o.entryPrice, exitPrice: o.exitPrice, entryTime: o.entryTime, exitTime: o.exitTime, risk, tick, bars, tfMs, eod });
  const s = d.side === 'long' ? 1 : -1;
  // The model's risk actions on an entry (prop/risk-actions.js): a size under the verdict's ceiling, an exit before the
  // stop or the target (and before end of day), with the hold-to-bracket counterfactual by limitOutcome's rule.
  const actions = [];
  const v = verdictOf(d);
  const sizeFraction = v && v.maxSize > 0 && o.size > 0 ? Math.min(1, o.size / v.maxSize) : null;
  if (sizeFraction !== null && sizeFraction < 1) actions.push('size-down');
  const dist = Number.isFinite(d.plan.target) ? Math.abs(d.plan.target - d.plan.entry) : null;
  const atTarget = dist !== null && s * (o.exitPrice - (o.entryPrice + s * dist)) >= -1e-9;
  const eodMs = Number.isFinite(p.entryMs) ? eodOf(p.entryMs) : Infinity;
  let hold = null;
  if (!p.stopped && !atTarget && Number.isFinite(p.exitMs) && p.exitMs + tfMs < eodMs && Number.isFinite(p.entryMs) && bars.length) {
    // The same position held: from the real fill (its price and time), the bracket placed from that price (bracketExit;
    // the fill's own bar read after the fill by the worse-is-taken rule), never a re-fill at another price.
    const i = bars.findIndex(b => b.ms + tfMs > p.entryMs);
    const x = i >= 0 ? bracketExit({ bars, i, partial: bars[i].ms < p.entryMs, tfMs, side: d.side, fill: o.entryPrice, risk, targetDist: dist, eodMs, tick }) : null;
    if (x) {
      const exitTime = new Date(x.exitMs).toISOString();
      const h = pathOf({ side: d.side, entryPrice: o.entryPrice, exitPrice: x.exitPrice, entryTime: o.entryTime, exitTime, risk, tick, bars, tfMs, eod });
      const { entryMs: _e, exitMs: _x, stopped: _s, ...rest } = h;
      hold = { ...rest, r: Math.round(((s * (x.exitPrice - o.entryPrice)) / risk) * 1e4) / 1e4, exitTime, reason: `hold (${x.reason})` };
      actions.push('early-exit');
    }
  }
  const { stopped, entryMs, exitMs, ...path } = p;
  const paths = exitPaths({ side: d.side, entryPrice: o.entryPrice, entryTime: o.entryTime, tick, bars, tfMs, eod, targetDist: dist });
  return {
    trade: {
      id: d.id, day: d.settledDay || d.day, symbol: familyRoot(d.root) || d.root, contract: d.contract || null, strategy: 'trade_lifecycle', direction: d.side,
      bar: d.bar, entryTime: o.entryTime || null, exitTime: o.exitTime || null, reason: stopped ? 'stop' : o.exitReason || 'closed',
      tickSize: tick, tickValue: spec.tickValue, feesPerSide: spec.feesPerSide ?? 0.37, ...path, ...paths, r: o.R,
      facts: factsOf(d), actions, sizeFraction, hold, entryMs, exitMs,
    },
  };
}

/**
 * A pass the model made on a valid composed setup, as the trade it would have been (the experience log's limitOutcome
 * counterfactual: the record's limit, stop and target from the fill), never taken by the score: prop/risk-actions.js
 * scores standing down against taking it. `day-stop` when an entry of that day had already closed at a net loss before it
 * and none followed it (modelStream).
 */
function passOf(d, { barsFor, tfMs, eod, specOf }, lossBefore) {
  const o = d.outcome || {};
  const spec = specOf(familyRoot(d.root) || d.root);
  const risk = d.plan && Number.isFinite(d.plan.entry) && Number.isFinite(d.plan.stop) ? Math.abs(d.plan.entry - d.plan.stop) : NaN;
  if (!spec || !(spec.tickSize > 0) || !o.filled || !Number.isFinite(o.exitPrice) || !(risk > 0)) return null;
  const bars = barsFor(d.root) || [];
  const p = pathOf({ side: d.side, entryPrice: o.entryPrice, exitPrice: o.exitPrice, entryTime: o.entryTime, exitTime: o.exitTime, risk, tick: spec.tickSize, bars, tfMs, eod });
  const { stopped, entryMs: _e, exitMs: _x, ...path } = p;
  const dist = Number.isFinite(d.plan.target) ? Math.abs(d.plan.target - d.plan.entry) : null;
  const paths = exitPaths({ side: d.side, entryPrice: o.entryPrice, entryTime: o.entryTime, tick: spec.tickSize, bars, tfMs, eod, targetDist: dist });
  return {
    id: d.id, day: d.settledDay || d.day, symbol: familyRoot(d.root) || d.root, strategy: 'trade_lifecycle', direction: d.side, bar: d.bar,
    entryTime: o.entryTime || null, exitTime: o.exitTime || null, reason: stopped ? 'stop' : o.exitReason, tickSize: spec.tickSize, tickValue: spec.tickValue,
    feesPerSide: spec.feesPerSide ?? 0.37, ...path, ...paths, r: o.R, facts: factsOf(d), actions: [lossBefore ? 'day-stop' : 'pass'], counterfactual: true,
  };
}

/**
 * The stream from a run's decisions (experience-log.js buildDecisions lines). dayKeys: every session day the run
 * replayed; barsFor(root): the run's bars ({ ms, o, h, l, c }, sorted); tfMs: the bar length; eod: the runner's end
 * of day (autotrader parseAt), or null (to the trading day's end); specOf(root): the contract spec (tickSize,
 * tickValue, feesPerSide).
 */
function modelStream({ decisions = [], dayKeys = [], barsFor = () => [], tfMs, eod = null, specOf = specFor, regimes = null, trips = null, eodOf = () => Infinity, verdictOf = () => null }) {
  const started = Date.now();
  if (!(tfMs > 0)) throw new Error('tfMs: the run\'s bar length in ms');
  if (decisions.some(d => d && d.hidden)) throw new Error('the run\'s outcomes are hidden (a reasoning-fix look): no trade stream');
  const trades = [];
  const excluded = [];
  for (const d of decisions) {
    if (!d || d.decision !== 'entered') continue;
    const r = tradeOf(d, { barsFor, tfMs, eod, specOf, eodOf, verdictOf });
    if (r.excluded) excluded.push(r.excluded);
    else trades.push(r.trade);
  }
  // Round trips of the run's fills no record placed: each entered decision credits the leg that opened at its entry.
  if (Array.isArray(trips)) {
    // Counted, not a set: two legs opening at one instant are two fills, and one entered decision credits one leg.
    const credited = new Map();
    for (const d of decisions.filter(x => x && x.decision === 'entered' && x.outcome && x.outcome.entryTime)) {
      const k = `${familyRoot(d.root) || d.root}|${d.side === 'long' ? 'buy' : 'sell'}|${Date.parse(d.outcome.entryTime)}`;
      credited.set(k, (credited.get(k) || 0) + 1);
    }
    for (const t of trips) {
      const k = `${t.family}|${t.side}|${t.openMs}`;
      if (Number.isFinite(t.openMs) && credited.get(k) > 0) { credited.set(k, credited.get(k) - 1); continue; }
      excluded.push({ id: null, root: t.family || null, bar: new Date(t.openMs).toISOString(), why: 'a fill no record placed' });
    }
  }
  // Trades open at the same time: settled one by one, their combined drawdown unseen.
  const overlaps = [];
  const timed = trades.filter(t => Number.isFinite(t.entryMs) && Number.isFinite(t.exitMs)).sort((a, b) => a.entryMs - b.entryMs);
  for (let i = 1; i < timed.length; i += 1) {
    const open = timed.slice(0, i).filter(p => p.exitMs > timed[i].entryMs);
    for (const p of open) overlaps.push({ a: p.id, b: timed[i].id, at: timed[i].entryTime });
  }
  const keys = [...new Set([...dayKeys, ...trades.map(t => t.day), ...decisions.filter(d => d && d.decision === 'passed').map(d => d.settledDay || d.day)])].sort();
  const byDay = new Map(keys.map(k => [k, []]));
  for (const t of trades) byDay.get(t.day).push(t);
  const regimeOf = new Map();
  const passesOn = new Map();
  const passedOn = new Map();
  for (const d of decisions) {
    if (!d || d.decision !== 'passed') continue;
    passesOn.set(d.day, (passesOn.get(d.day) || 0) + 1);
    // Standing down for the day: a pass after an entry of the day closed at a net loss (fees in, as attempts.js counts a
    // loss: a scratch that pays its fees is one), with no entry later that day. A pass followed by an entry is a pass.
    const cycle = Date.parse(d.cycleAt);
    const lossBefore = trades.some(t => t.day === d.day && netLoss(t) && Number.isFinite(t.exitMs) && t.exitMs <= cycle);
    const enteredLater = decisions.some(e => e && e.decision === 'entered' && e.day === d.day && entryMsOf(e) > cycle);
    const c = passOf(d, { barsFor, tfMs, eod, specOf }, lossBefore && !enteredLater);
    if (!c) continue;
    if (!passedOn.has(c.day)) passedOn.set(c.day, []);
    passedOn.get(c.day).push(c);
  }
  for (const d of decisions) {
    if (!d || d.decision === 'none' || regimeOf.has(d.day)) continue;
    const v = d.context && d.context.volatility;
    if (v) regimeOf.set(d.day, String(v));
  }
  const days = keys.map(day => {
    const list = byDay.get(day).sort((a, b) => (a.entryMs - b.entryMs) || String(a.id).localeCompare(String(b.id)));
    return { day, regime: (regimes && regimes.get(day)) || regimeOf.get(day) || 'normal', passes: passesOn.get(day) || 0, passed: passedOn.get(day) || [], trades: list.map((t, seq) => { const { entryMs: _m, exitMs: _x, ...rest } = t; return Object.assign(rest, { seq }); }) };
  });
  const all = days.flatMap(d => d.trades);
  return {
    source: 'model', rBasis: 'gross', days, trades: all, excluded, overlaps, fieldBranch: [], entryDelayMs: null, slippageTicks: SLIPPAGE_TICKS, timeframe: tfMs / 60000,
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
  // The verdict each entry was sized under (the policy's ceiling, prop-state's verdicts file): the bar, side and market.
  const verdicts = readVerdicts(r.home).filter(v => v && v.action === 'full');
  const verdictOf = d => verdicts.filter(v => v.bar === d.bar && v.direction === d.side && (familyRoot(v.symbol) || v.symbol) === (familyRoot(d.root) || d.root)).pop() || null;
  const stream = modelStream({
    decisions: r.decisions, dayKeys: r.dayKeys, barsFor: r.barsFor, tfMs: r.tfMs, eod, regimes, trips: r.trips, eodOf: ms => eodOf(r.cfg, ms), verdictOf,
  });
  return {
    stream,
    run: {
      runId: r.manifest.runId, from: r.dayKeys[0], to: nextDay(r.dayKeys[r.dayKeys.length - 1]), learning: Boolean(gate && gate.learning === true),
      role: gate ? gate.role || null : null, look: gate ? gate.look || null : null, hideOutcomes: Boolean(gate && gate.hideOutcomes),
      practice: gate ? gate.practice || null : null, ledger: gate ? gate.ledger || null : null, home: r.home, dir: r.dir,
    },
  };
}

module.exports = { modelStream, readModelStream, adversePath, exitPaths };
