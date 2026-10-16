'use strict';

/**
 * The experience log (the composed-entry design, section 4.2): one record per decision of a run, the trade_lifecycle
 * record (lifecycle-record.js) joined with its outcome, appended under the run home, never the repository, and never
 * read in the session that wrote it. Written after the run's days are done (the replay's finish, or
 * `replay.js experience`).
 *
 * A decision is a cycle, root and side with an ok record (the latest ok record of that side in the cycle, or the record
 * the gate stamped on the order that filled): `entered` when a round trip is attributed to it, else `refused` when the
 * gate refused an entry order in that cycle (a refusal without a side goes to the cycle's latest ok record), else
 * `passed`. A cycle with no ok record is
 * a plain pass (`none`, no signature; `checked` counts the records it tried). The cycles come from the run's store
 * lines (each trade cycle that ran), so a bar the model found nothing on is counted too.
 *
 * Outcome, in R of the bracket (sign x (exit - fill) / the record's stop distance; the brackets are placed from the fill):
 *   entered  the real round trip from the replay broker's fills (size-weighted entry and exit prices);
 *   passed, refused   the counterfactual of the same order on the bars after the decision (limitOutcome): a limit at
 *            the entry reference, filled at it or better (a bar opening through it fills at its open) on the first
 *            bar that trades it before the record expires, else `unfilled` (R null); then the record's stop and
 *            target, the stop checked first on every bar (a bar touching both is a loss) and alone on the fill bar,
 *            the stop filled SLIPPAGE_TICKS worse (the backtester's market-stop slippage), the target at its price,
 *            out at the close of the bar that reaches end of day or the last bar of the trading day; under the run's
 *            exit (`exit`: evaluator.js composedExit, the one the runner manages its composed trades by): past the
 *            target trailed, not closed (target_then_trail), or an R trail, as the runner's rule per closed bar.
 * Each line holds the run's exit mode (`exit`: brackets, target_then_trail, ...) and the hash of its exit plan
 * (`exitPlan`: exitHash of the mode and its parameters, as the run's manifest recorded them at seed time; null for a
 * run started before the record): an index never mixes two plans (experience-index.js).
 * Grade: an entry's result (win, loss, scratch); a pass whose counterfactual lost is a `good-pass`, one that would
 * have won a `missed-win`, unfilled or flat a `neutral-pass`; a gate refusal apart (refused-would-lose, refused-would-win,
 * refused-neutral), never counted as the model's pass. A round trip belongs to the record the gateway stamped on its
 * opening order at placement (entry-orders.json composed.record, by the fill's order id); without a stamp, to the latest
 * ok record at or before its opening fill whose order could have filled it (side, root, before the record expired).
 *
 * The line (VERSION 2): { v, id, runId, root, contract, lane, cycleAt, bar, day, role, decision, refusal, side,
 *   exploratory, verified, checked, reads, signatures, context, plan, outcome: { source, filled, entryPrice,
 *   exitPrice, entryTime (the opening fill's time, or the counterfactual fill bar's; lines written before it lack it),
 *   size (fills only: the contracts opened), exitTime, exitReason, R, maeR, mfeR (the worst and best move while held,
 *   in R; null unknown; lines written before them lack them) }, and `curated: true` on a curated run's lines
 *   (run-experience.js: outcome-balanced, the experience index labels them), grade, settledDay (the later of its bar's session and its exit's: the index
 *   dates it so), frame (default: 1h bias, 15m reaction, 3m confirmation reads; else other: frameOf), writtenAt }. A round trip is split into legs, one per opening fill (legsOf). `role` is the bar's learning role (learning/splits.js);
 *   `id` is stable, so a log written twice for a run keeps each decision once (appendDecisions).
 *
 *   limitOutcome({ bars, tfMs, side, entry, stop, target, fromMs, expiresMs, eodMs, tick, plan })   the counterfactual
 *   buildDecisions({ cycles, records, trips, stamps, gateRefusals, barsFor, tickOf, eodOf, runId, now, exit })   the lines
 *                                         (`exit`: { plan, mode, hash } the run's exit, BRACKETS by default)
 *   exitRecord(exit), exitHash(exit)      an exit as a manifest records it ({ mode, plan, hash }), its hash
 *   appendDecisions(file, lines)          append the lines whose id isn't in the file yet; { added, kept }
 *   readDecisions(file)                   every line, [] without a file
 *   logFile(runHome)                      <run home>/experience/decisions.jsonl
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SLIPPAGE_TICKS } = require('../replay/counterfactual');
const { tradingDayKey } = require('../trading/clock');
const { familyRoot } = require('../trading/contracts');
const { roleOf } = require('./splits');
const { formOf } = require('./lifecycle-record');
const { afterTargetStep, swingSeries } = require('../trading/exit-trail');
const { trailStep } = require('../trading/trail');

// 2: decisions per cycle, root and side, trades by the gateway's stamp (a version-1 line's id may name another record).
const VERSION = 2;
/** The exit of a run whose composed trades keep their brackets (no policy lists the strategy: evaluator.js composedExit). */
const BRACKETS = Object.freeze({ plan: null, mode: 'brackets' });

/** JSON with every object's keys sorted: one text per value, whatever order its keys were built in. */
const stable = v => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v === undefined ? null : v));
/** The hash of an exit plan (its mode and parameters): what each experience line and an index name it by. */
const exitHash = exit => crypto.createHash('sha256').update(stable({ mode: exit.mode, plan: exit.plan || null })).digest('hex');
/** An exit as a run's manifest records it at seed time (replay/driver.js): { mode, plan, hash }. */
const exitRecord = exit => ({ mode: exit.mode, plan: exit.plan || null, hash: exitHash(exit) });
const round = (x, d = 4) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const sgn = side => (side === 'long' ? 1 : side === 'short' ? -1 : 0);

/** First index with ms >= t. */
function lowerBound(bars, t) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ms < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const resultOf = R => (R === null ? null : R > 0 ? 'win' : R < 0 ? 'loss' : 'scratch');

/** The record's limit order on the bars after the decision (see the head). */
function limitOutcome({ bars, tfMs, side, entry, stop, target, fromMs, expiresMs, eodMs = Infinity, tick, plan = null }) {
  const none = (reason, extra = {}) => ({ source: 'counterfactual', filled: false, entryPrice: null, exitPrice: null, exitTime: null, exitReason: reason, R: null, maeR: null, mfeR: null, ...extra });
  const s = sgn(side);
  if (!s || ![entry, stop].every(Number.isFinite) || !(tick > 0)) return none('no plan');
  if (sgn(side) * (entry - stop) <= 0) return none('stop on the wrong side');
  const end = Number.isFinite(expiresMs) ? expiresMs : fromMs + tfMs;
  let i = lowerBound(bars, fromMs);
  if (i >= bars.length) return none('no bars after the decision');
  const day = tradingDayKey(new Date(bars[i].ms));
  let fill = null;
  for (; i < bars.length && bars[i].ms < end; i += 1) {
    const b = bars[i];
    if (tradingDayKey(new Date(b.ms)) !== day || b.ms + tfMs > eodMs) return none('unfilled');
    if (s > 0 ? b.l <= entry : b.h >= entry) { fill = s > 0 ? Math.min(entry, b.o) : Math.max(entry, b.o); break; }
  }
  if (fill === null) return none('unfilled');
  // The brackets are in ticks from the fill (section 3.4): the record's distances, placed from the fill price.
  const risk = Math.abs(entry - stop);
  const fillAt = new Date(bars[i].ms).toISOString();
  // The fill is inside bar i (at its open or past it): bar i is the fill bar, read by bracketExit's worse-is-taken rule.
  const targetDist = Number.isFinite(target) && s * (target - entry) > 0 ? Math.abs(target - entry) : null;
  const x = bracketExit({ bars, i, partial: true, tfMs, side, fill, risk, targetDist, eodMs, tick, plan, swingAt: swingsFor(bars, plan) });
  if (!x) return { ...none('the bars end before the exit'), filled: true, entryPrice: fill };
  return {
    source: 'counterfactual', filled: true, entryPrice: fill, entryTime: fillAt, exitPrice: x.exitPrice, exitTime: new Date(x.exitMs).toISOString(), exitReason: x.reason,
    R: round((s * (x.exitPrice - fill)) / risk), maeR: x.maeR, mfeR: x.mfeR,
  };
}

/**
 * A filled position held to its bracket on the bars from bar i: the stop and the target placed `risk` and `targetDist`
 * from the fill price `fill` (the real fill, or a counterfactual's), never from another price. `partial`: the fill fell
 * inside bar i; on that bar only what follows the fill counts, and its OHLC can't tell what that was, so the worse is
 * taken: the stop is hit when the bar reaches it (filled at the stop with the expected slippage, never at the bar's
 * open, which came before the fill) and the target never is. Every later bar: the stop first (the stop's fill, or the
 * open when the bar gapped through it), then the target, then the end of day (the session's change, or the bar closing
 * at eodMs). Returns { exitPrice, exitMs (the exit bar's close), reason: stop | target | eod, maeR, mfeR }, or null when
 * the bars end first. maeR (<= 0) and mfeR (>= 0): the worst and best move from the fill while held, in R of `risk`, the
 * worse taken as above: the fill bar's adverse extreme counts and its favorable one doesn't; a stop bar counts its stop
 * fill alone, a target bar its target and its adverse extreme; every other bar held both extremes; the exit price too.
 */
function bracketExit({ bars, i, partial = false, tfMs, side, fill, risk, targetDist = null, eodMs = Infinity, tick, plan = null, swingAt = null }) {
  const s = sgn(side);
  if (!s || !(i >= 0 && i < bars.length) || !Number.isFinite(fill) || !(risk > 0) || !(tick > 0)) return null;
  const day = tradingDayKey(new Date(bars[i].ms));
  // The exit the trade is managed by (`plan`, evaluator.js composedExit): past the target trailed, not closed (exit mode
  // target_then_trail: exit-trail.js), or an R trail (trail.js); else the brackets alone. The runner's rule, per bar.
  const after = plan && plan.afterTarget ? plan.afterTarget : null;
  const trails = Boolean(plan) && plan.trailActivateR !== null && plan.trailActivateR !== undefined;
  const initial = fill - s * risk;
  let stopPx = initial;
  let peakR = 0;
  let armed = false;
  const targetPx = targetDist > 0 ? fill + s * targetDist : null;
  let adv = 0;
  let fav = 0;
  const move = px => s * (px - fill);
  const out = (price, bar, reason) => {
    adv = Math.min(adv, move(price));
    fav = Math.max(fav, move(price));
    return { exitPrice: price, exitMs: bar.ms + tfMs, reason, maeR: round(adv / risk), mfeR: round(fav / risk) };
  };
  let last = bars[i];
  for (let j = i; j < bars.length; j += 1) {
    const b = bars[j];
    const fillBar = partial && j === i;
    if (tradingDayKey(new Date(b.ms)) !== day) return out(last.c, last, 'eod');
    const stopFill = stopPx - s * SLIPPAGE_TICKS * tick;
    if (s > 0 ? b.l <= stopPx : b.h >= stopPx) return out(fillBar ? stopFill : s > 0 ? Math.min(stopFill, b.o) : Math.max(stopFill, b.o), b, stopPx === initial ? 'stop' : 'trail');
    adv = Math.min(adv, move(s > 0 ? b.l : b.h));
    if (!fillBar && !after && targetPx !== null && (s > 0 ? b.h >= targetPx : b.l <= targetPx)) return out(targetPx, b, 'target');
    if (!fillBar) fav = Math.max(fav, move(s > 0 ? b.h : b.l));
    // The trail on this closed bar (the fill bar's prices after the fill can't be told: none, the worse taken).
    if (!fillBar && (after || trails)) {
      const t = { sign: s, entry: fill, risk, stop: stopPx, peakR, armed, target: targetPx };
      const step = after ? afterTargetStep(t, b, plan, tick, swingAt ? swingAt(j, s) : null) : trailStep(t, b, plan, tick);
      peakR = step.peakR;
      armed = Boolean(step.armed);
      if (step.close) return out(step.close.price, b, 'trail');
      stopPx = step.stop;
    }
    if (b.ms + tfMs >= eodMs) return out(b.c, b, 'eod');
    last = b;
  }
  return null;
}

/** Per bars list and swing timeframe, its swing series once (exit-trail.js swingSeries: causal, bar j from bars 0..j). */
const SWINGS = new WeakMap();
/** A structure trail's swing at bar j for side s (a long's swing low, a short's high), or null when the plan has none. */
function swingsFor(bars, plan) {
  const a = plan && plan.afterTarget;
  if (!a || a.trailBy !== 'structure' || !a.swingMinutes || !Array.isArray(bars)) return null;
  if (!SWINGS.has(bars)) SWINGS.set(bars, new Map());
  const byTf = SWINGS.get(bars);
  if (!byTf.has(a.swingMinutes)) byTf.set(a.swingMinutes, swingSeries(bars, a.swingMinutes));
  const sw = byTf.get(a.swingMinutes);
  return (j, s) => { const v = (s > 0 ? sw.low : sw.high)[j]; return Number.isFinite(v) ? v : null; };
}

/**
 * The owner's default frame (the scorecard tag `frame`): a 1h bias read, a 15m reaction read at the setup step and a
 * 3m confirmation read at the entry step. A composed decision with all three is `default`; any other is `other`.
 * A read's timeframe is the first word of its normalized form (lifecycle-record.js formOf: the checker's, so `15-min ...`
 * is 15m and `60 min up` is 1h). Reaction then confirmation (the entry's candle closing after the setup's) is part of
 * the checker's ok since #176, and only ok records are decisions; a record written before it can't be told apart.
 */
const FRAME = Object.freeze([['bias', '1h'], ['setup', '15m'], ['entry', '3m']]);
const tfOf = read => {
  const w = String(read || '').trim().toLowerCase().split(/\s+/)[0];
  return w === '60m' ? '1h' : w;
};
const frameOf = reads => (FRAME.every(([step, tf]) => (reads || []).some(r => r && r.step === step && tfOf(formOf(r)) === tf)) ? 'default' : 'other');

/**
 * A round trip split by its opening fills: one leg per fill (its own time and price, the trip's exit), so an add
 * (a scale-in) is credited to the record that placed it, never folded into the first entry's.
 */
function legsOf(trips) {
  return trips.flatMap(t => (t.opens.length > 1 ? t.opens.map(f => ({ ...t, openMs: Number.isFinite(f.ms) ? f.ms : Date.parse(f.creationTimestamp), opens: [f] })) : [t]));
}

/** The later of a decision's session and its exit's (a trade settled in a later session is dated by it). */
function settledDay(day, outcome) {
  const t = outcome && outcome.exitTime ? Date.parse(outcome.exitTime) : NaN;
  if (!Number.isFinite(t)) return day;
  const exit = tradingDayKey(new Date(t - 1));
  return exit > day ? exit : day;
}

/**
 * A round trip's real outcome in R of the record's stop. maeR and mfeR (closed, with the run's bars): the worst and best
 * move from the entry over the bars wholly inside the trade (opening at or after the fill, closing by the exit: an edge
 * bar's extremes may fall outside it) and the exit price (replay/counterfactual.js fromFills' rule); else null.
 */
function tripOutcome(trip, plan, side, { bars = [], tfMs = 0 } = {}) {
  const s = sgn(side);
  const avg = fs2 => {
    const size = fs2.reduce((a, f) => a + (Math.abs(Number(f.size)) || 1), 0);
    return size ? fs2.reduce((a, f) => a + Number(f.price) * (Math.abs(Number(f.size)) || 1), 0) / size : null;
  };
  const entryPrice = avg(trip.opens);
  const closed = trip.closeMs !== null && trip.closes.length;
  const exitPrice = closed ? avg(trip.closes) : null;
  // R in the bracket's risk: the record's stop distance, which the bracket places from the fill.
  const risk = Number.isFinite(plan.stop) && Number.isFinite(plan.entry) ? Math.abs(plan.entry - plan.stop) : null;
  let maeR = null;
  let mfeR = null;
  if (closed && risk && Number.isFinite(entryPrice) && Number.isFinite(exitPrice) && Number.isFinite(trip.openMs) && tfMs > 0 && Array.isArray(bars) && bars.length) {
    let adv = Math.min(0, s * (exitPrice - entryPrice));
    let fav = Math.max(0, s * (exitPrice - entryPrice));
    for (const b of bars) {
      if (b.ms < trip.openMs || b.ms + tfMs > trip.closeMs) continue;
      adv = Math.min(adv, s * ((s > 0 ? b.l : b.h) - entryPrice));
      fav = Math.max(fav, s * ((s > 0 ? b.h : b.l) - entryPrice));
    }
    maeR = round(adv / risk);
    mfeR = round(fav / risk);
  }
  return {
    source: 'fills', filled: true, entryPrice: round(entryPrice, 6), exitPrice: round(exitPrice, 6),
    entryTime: Number.isFinite(trip.openMs) ? new Date(trip.openMs).toISOString() : null,
    size: trip.opens.reduce((a, f) => a + (Math.abs(Number(f.size)) || 1), 0),
    exitTime: closed ? new Date(trip.closeMs).toISOString() : null, exitReason: closed ? 'closed' : 'open',
    R: closed && risk ? round((s * (exitPrice - entryPrice)) / risk) : null, maeR, mfeR,
  };
}

function gradeOf(decision, outcome) {
  if (decision === 'none') return null;
  const R = outcome ? outcome.R : null;
  if (decision === 'entered') return resultOf(R);
  // The gate's refusal is not the model's pass: graded apart, so pass quality is the model's own.
  if (decision === 'refused') return R === null || R === 0 ? 'refused-neutral' : R < 0 ? 'refused-would-lose' : 'refused-would-win';
  if (R === null || R === 0) return 'neutral-pass';
  return R < 0 ? 'good-pass' : 'missed-win';
}

const idOf = parts => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 20);

/**
 * The run's decisions.
 * @param cycles [{ at (ISO, the cycle's decision time), roots: [ROOT] }] each trade cycle that ran, in time order
 * @param records the trade_lifecycle records (lifecycle-record.js), any order
 * @param trips round trips from the run's fills (replay/labels.js roundTrips): { family, side: buy|sell, openMs, closeMs, opens, closes }
 * @param stamps { orderId: record id } the gateway's stamp on each composed entry it placed (entry-orders.json composed.record)
 * @param gateRefusals [{ cycleAt (ISO), root or null, check }] the gate's refusals of an entry order in a cycle (the store line's refusals)
 * @param barsFor (root) -> bars sorted, each { ms, o, h, l, c }; tfMs the bar length
 * @param tickOf (root) -> tick size; eodOf (ms) -> that trading day's end of day (ms)
 */
function buildDecisions({ cycles = [], records = [], trips = [], stamps = {}, gateRefusals = [], barsFor = () => [], tfMs = 0, tickOf = () => null, eodOf = () => Infinity, runId = null, now = new Date(), exit = BRACKETS }) {
  const times = cycles.map(c => Date.parse(c.at)).filter(Number.isFinite).sort((a, b) => a - b);
  const marks = times.map(t => ({ ms: t }));
  const cycleOf = ms => { const k = lowerBound(marks, ms + 1) - 1; return k >= 0 ? times[k] : null; };
  // Records by (cycle, root): the cycle is the latest cycle at or before the record.
  const byCycle = new Map();
  for (const r of records) {
    const c = cycleOf(Date.parse(r.at));
    if (c === null) continue;
    const k = `${c}|${r.root}`;
    if (!byCycle.has(k)) byCycle.set(k, []);
    byCycle.get(k).push(r);
  }
  // Each cycle, root and side with its records and its latest ok record of that side (a compose of the other side
  // later in the cycle never replaces it); a cycle and root with no ok record on either side is one plain pass.
  const spanOf = ok => ({ fromMs: Date.parse(ok.at), expiresMs: ok.expiresAt ? Date.parse(ok.expiresAt) : Date.parse(ok.at) + tfMs });
  const slots = [];
  for (const c of cycles) {
    const at = Date.parse(c.at);
    if (!Number.isFinite(at)) continue;
    for (const root of c.roots || []) {
      const recs = (byCycle.get(`${at}|${root}`) || []).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const oks = recs.filter(r => r.ok);
      if (!oks.length) { slots.push({ at, root, recs, ok: null, fromMs: null, expiresMs: null, latest: true }); continue; }
      const last = oks[oks.length - 1];
      const sided = new Set(oks.map(r => r.side));
      for (const side of ['long', 'short']) {
        const mine = oks.filter(r => r.side === side);
        if (!mine.length) continue;
        const ok = mine[mine.length - 1];
        // `checked`: the side's records; the cycle's latest slot also counts those of a side with no ok record.
        const counted = recs.filter(r => r.side === side || (ok === last && !sided.has(r.side)));
        slots.push({ at, root, side, recs: counted, oks: mine, ok, ...spanOf(ok), latest: ok === last });
      }
    }
  }
  const tripOf = new Map();
  const want = (s, t) => (s.side === 'long' ? 'buy' : 'sell') === t.side && (!t.family || t.family === familyRoot(s.root));
  // A round trip belongs first to the record the gate judged: the gateway's stamp at placement (entry-orders.json
  // composed.record, by the opening fill's order id). Its slot then speaks for that record, whatever was composed
  // after it in the cycle; the legs of one stamped order (its partial fills) are one trade. A stamp that can't be
  // this trade's (its record composed after the fill, another side or root, or its slot holding another order's
  // trade) is ignored: the time window decides, and a trade no free slot covers has no decision line (a second order
  // on one record: the gate's one entry per bar and side keeps a gated run from it).
  const orderOf = t => {
    const f = (t.opens || []).find(x => x && x.orderId !== undefined && x.orderId !== null);
    return f ? String(f.orderId) : null;
  };
  const unstamped = [];
  for (const t of trips.filter(x => x.openMs !== null).sort((a, b) => a.openMs - b.openMs)) {
    const order = orderOf(t);
    const id = order !== null && stamps[order] !== undefined && stamps[order] !== null ? String(stamps[order]) : null;
    const slot = id ? slots.find(s => s.ok && want(s, t) && s.oks.some(r => r.id === id && Date.parse(r.at) <= t.openMs)) : null;
    const had = slot ? tripOf.get(slot) : null;
    if (!slot || (had && had.order !== order)) { unstamped.push(t); continue; }
    if (!had) Object.assign(slot, { ok: slot.oks.find(r => r.id === id) }, spanOf(slot.oks.find(r => r.id === id)));
    tripOf.set(slot, had ? { ...had, opens: [...had.opens, ...t.opens], openMs: Math.min(had.openMs, t.openMs) } : { ...t, order });
  }
  // Without a stamp: the latest ok record at or before its opening fill whose order could have filled it (its side
  // and root, the fill before the record expired), never an earlier one still open: each record at most one.
  // A slot's earlier record of the same side counts too (a re-compose after the fill never hides the record before it).
  for (const t of unstamped) {
    const fits = slots.filter(s => s.ok && !tripOf.has(s) && want(s, t)).flatMap(s => s.oks.map(r => ({ s, r, ...spanOf(r) })))
      .filter(x => x.fromMs <= t.openMs && t.openMs <= x.expiresMs).sort((a, b) => b.fromMs - a.fromMs);
    if (!fits.length) continue;
    const { s, r } = fits[0];
    Object.assign(s, { ok: r }, spanOf(r));
    tripOf.set(s, t);
  }
  const out = [];
  for (const slot of slots) {
    const { at, root, recs, ok, fromMs, expiresMs } = slot;
    const base = { v: VERSION, runId, root, lane: ok ? ok.lane : null, cycleAt: new Date(at).toISOString(), checked: recs.length, exit: exit.mode, exitPlan: exit.hash || null, writtenAt: now.toISOString() };
    if (!ok) {
      const day = tradingDayKey(new Date(at));
      out.push({ ...base, id: idOf([runId, root, base.cycleAt, 'none']), contract: null, bar: null, day, role: safeRole(at), decision: 'none', refusal: null, side: null, frame: null,
        exploratory: false, verified: false, reads: [], signatures: { skill: null, read: null }, context: null, plan: null, outcome: null, grade: null });
      continue;
    }
    const trip = tripOf.get(slot) || null;
    let decision = 'passed';
    let refusal = null;
    let outcome;
    if (trip) {
      decision = 'entered';
      outcome = tripOutcome(trip, ok.plan, ok.side, { bars: barsFor(root), tfMs });
    } else {
      // A refusal names no side: it stays with the cycle's latest ok record (the one order_plan plans from).
      const refused = slot.latest && gateRefusals.find(g => Date.parse(g.cycleAt) === at && (!g.root || familyRoot(g.root) === familyRoot(root)));
      if (refused) { decision = 'refused'; refusal = refused.check || 'refused'; }
      outcome = limitOutcome({ bars: barsFor(root), tfMs, side: ok.side, entry: ok.plan.entry, stop: ok.plan.stop, target: ok.plan.target, fromMs, expiresMs, eodMs: eodOf(fromMs), tick: tickOf(root), plan: exit.plan });
    }
    out.push({
      ...base, id: idOf([runId, root, base.cycleAt, ok.bar, ok.side, ok.signatures.read]), contract: ok.contract, bar: ok.bar, day: tradingDayKey(new Date(Date.parse(ok.bar))),
      role: safeRole(Date.parse(ok.bar)), decision, refusal, side: ok.side, exploratory: ok.exploratory, verified: ok.ok,
      reads: ok.reads, signatures: ok.signatures, context: ok.context, plan: { ...ok.plan, expiresAt: ok.expiresAt }, outcome, grade: gradeOf(decision, outcome),
      settledDay: settledDay(tradingDayKey(new Date(Date.parse(ok.bar))), outcome), frame: frameOf(ok.reads),
    });
  }
  return out;
}

function safeRole(ms) {
  try { return roleOf(ms); } catch (_err) { return null; }
}

const logFile = runHome => path.join(runHome, 'experience', 'decisions.jsonl');

function readDecisions(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_err) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); if (d && d.id) out.push(d); } catch (_err) { /* a torn line */ }
  }
  return out;
}

/**
 * Append-only: lines whose id the file holds already are kept as written, never replaced. A run whose lines the file
 * holds from another version is refused (their ids may name other records, so a trade would count twice); delete
 * that run's lines and write it again.
 */
function appendDecisions(file, lines) {
  const old = readDecisions(file);
  const runs = new Set(lines.map(l => l.runId));
  const stale = old.find(d => runs.has(d.runId) && Number.isInteger(d.v) && d.v !== VERSION);
  if (stale) throw new Error(`${file}: run ${stale.runId}'s decisions were written by experience log version ${stale.v}, not ${VERSION}: delete that run's lines and write them again`);
  const have = new Set(old.map(d => d.id));
  const fresh = lines.filter(l => !have.has(l.id));
  if (fresh.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.appendFileSync(file, `${old && !old.endsWith('\n') ? '\n' : ''}${fresh.map(l => `${JSON.stringify(l)}\n`).join('')}`);
  }
  return { added: fresh.length, kept: lines.length - fresh.length };
}

module.exports = { VERSION, BRACKETS, exitHash, exitRecord, FRAME, limitOutcome, bracketExit, tripOutcome, legsOf, settledDay, frameOf, buildDecisions, appendDecisions, readDecisions, logFile, gradeOf };
