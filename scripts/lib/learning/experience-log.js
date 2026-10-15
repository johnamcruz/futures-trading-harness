'use strict';

/**
 * The experience log (the composed-entry design, section 4.2): one record per decision of a run, the trade_lifecycle
 * record (lifecycle-record.js) joined with its outcome, appended under the run home, never the repository, and never
 * read in the session that wrote it. Written after the run's days are done (the replay's finish, or
 * `replay.js experience`).
 *
 * A decision is a cycle with an ok record for the root (the latest ok record of that cycle, the one order_plan plans
 * from): `entered` when an opening fill of that side on the root came between the record and its expiry, else
 * `refused` when the gate refused an entry order in that cycle, else `passed`. A cycle with no ok record is
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
 *            out at the close of the bar that reaches end of day or the last bar of the trading day.
 * Grade: an entry's result (win, loss, scratch); a pass whose counterfactual lost is a `good-pass`, one that would
 * have won a `missed-win`, unfilled or flat a `neutral-pass`; a gate refusal apart (refused-would-lose, refused-would-win,
 * refused-neutral), never counted as the model's pass. A round trip belongs to the latest ok record at or before its
 * opening fill whose order could have filled it (side, root, before the record expired).
 *
 * The line (VERSION 1): { v, id, runId, root, contract, lane, cycleAt, bar, day, role, decision, refusal, side,
 *   exploratory, verified, checked, reads, signatures, context, plan, outcome: { source, filled, entryPrice,
 *   exitPrice, entryTime (the opening fill's time, or the counterfactual fill bar's; lines written before it lack it),
 *   size (fills only: the contracts opened), exitTime, exitReason, R }, grade, settledDay (the later of its bar's session and its exit's: the index
 *   dates it so), frame (default: 1h bias, 15m reaction, 3m confirmation reads; else other: frameOf), writtenAt }. A round trip is split into legs, one per opening fill (legsOf). `role` is the bar's learning role (learning/splits.js);
 *   `id` is stable, so a log written twice for a run keeps each decision once (appendDecisions).
 *
 *   limitOutcome({ bars, tfMs, side, entry, stop, target, fromMs, expiresMs, eodMs, tick })   the counterfactual
 *   buildDecisions({ cycles, records, trips, gateRefusals, barsFor, tickOf, eodOf, runId, now })   the lines
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

const VERSION = 1;
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
function limitOutcome({ bars, tfMs, side, entry, stop, target, fromMs, expiresMs, eodMs = Infinity, tick }) {
  const none = (reason, extra = {}) => ({ source: 'counterfactual', filled: false, entryPrice: null, exitPrice: null, exitTime: null, exitReason: reason, R: null, ...extra });
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
  const x = bracketExit({ bars, i, partial: true, tfMs, side, fill, risk, targetDist, eodMs, tick });
  if (!x) return { ...none('the bars end before the exit'), filled: true, entryPrice: fill };
  return {
    source: 'counterfactual', filled: true, entryPrice: fill, entryTime: fillAt, exitPrice: x.exitPrice, exitTime: new Date(x.exitMs).toISOString(), exitReason: x.reason,
    R: round((s * (x.exitPrice - fill)) / risk),
  };
}

/**
 * A filled position held to its bracket on the bars from bar i: the stop and the target placed `risk` and `targetDist`
 * from the fill price `fill` (the real fill, or a counterfactual's), never from another price. `partial`: the fill fell
 * inside bar i; on that bar only what follows the fill counts, and its OHLC can't tell what that was, so the worse is
 * taken: the stop is hit when the bar reaches it (filled at the stop with the expected slippage, never at the bar's
 * open, which came before the fill) and the target never is. Every later bar: the stop first (the stop's fill, or the
 * open when the bar gapped through it), then the target, then the end of day (the session's change, or the bar closing
 * at eodMs). Returns { exitPrice, exitMs (the exit bar's close), reason: stop | target | eod }, or null when the bars
 * end first.
 */
function bracketExit({ bars, i, partial = false, tfMs, side, fill, risk, targetDist = null, eodMs = Infinity, tick }) {
  const s = sgn(side);
  if (!s || !(i >= 0 && i < bars.length) || !Number.isFinite(fill) || !(risk > 0) || !(tick > 0)) return null;
  const day = tradingDayKey(new Date(bars[i].ms));
  const stopPx = fill - s * risk;
  const targetPx = targetDist > 0 ? fill + s * targetDist : null;
  const stopFill = stopPx - s * SLIPPAGE_TICKS * tick;
  const out = (price, bar, reason) => ({ exitPrice: price, exitMs: bar.ms + tfMs, reason });
  let last = bars[i];
  for (let j = i; j < bars.length; j += 1) {
    const b = bars[j];
    const fillBar = partial && j === i;
    if (tradingDayKey(new Date(b.ms)) !== day) return out(last.c, last, 'eod');
    if (s > 0 ? b.l <= stopPx : b.h >= stopPx) return out(fillBar ? stopFill : s > 0 ? Math.min(stopFill, b.o) : Math.max(stopFill, b.o), b, 'stop');
    if (!fillBar && targetPx !== null && (s > 0 ? b.h >= targetPx : b.l <= targetPx)) return out(targetPx, b, 'target');
    if (b.ms + tfMs >= eodMs) return out(b.c, b, 'eod');
    last = b;
  }
  return null;
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

/** A round trip's real outcome in R of the record's stop. */
function tripOutcome(trip, plan, side) {
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
  return {
    source: 'fills', filled: true, entryPrice: round(entryPrice, 6), exitPrice: round(exitPrice, 6),
    entryTime: Number.isFinite(trip.openMs) ? new Date(trip.openMs).toISOString() : null,
    size: trip.opens.reduce((a, f) => a + (Math.abs(Number(f.size)) || 1), 0),
    exitTime: closed ? new Date(trip.closeMs).toISOString() : null, exitReason: closed ? 'closed' : 'open',
    R: closed && risk ? round((s * (exitPrice - entryPrice)) / risk) : null,
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
 * @param gateRefusals [{ cycleAt (ISO), root or null, check }] the gate's refusals of an entry order in a cycle (the store line's refusals)
 * @param barsFor (root) -> bars sorted, each { ms, o, h, l, c }; tfMs the bar length
 * @param tickOf (root) -> tick size; eodOf (ms) -> that trading day's end of day (ms)
 */
function buildDecisions({ cycles = [], records = [], trips = [], gateRefusals = [], barsFor = () => [], tfMs = 0, tickOf = () => null, eodOf = () => Infinity, runId = null, now = new Date() }) {
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
  // Each cycle and root with its records and its latest ok record (the one order_plan plans from).
  const slots = [];
  for (const c of cycles) {
    const at = Date.parse(c.at);
    if (!Number.isFinite(at)) continue;
    for (const root of c.roots || []) {
      const recs = (byCycle.get(`${at}|${root}`) || []).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const ok = recs.filter(r => r.ok).pop() || null;
      slots.push({ at, root, recs, ok, fromMs: ok ? Date.parse(ok.at) : null, expiresMs: ok ? (ok.expiresAt ? Date.parse(ok.expiresAt) : Date.parse(ok.at) + tfMs) : null });
    }
  }
  // A round trip belongs to the latest ok record at or before its opening fill whose order could have filled it (its
  // side and root, the fill before the record expired), never to an earlier one still open: each record at most one.
  const tripOf = new Map();
  for (const t of trips.filter(x => x.openMs !== null).sort((a, b) => a.openMs - b.openMs)) {
    const want = s => (s.ok.side === 'long' ? 'buy' : 'sell') === t.side;
    const owner = slots.filter(s => s.ok && !tripOf.has(s) && want(s) && (!t.family || t.family === familyRoot(s.root)) && s.fromMs <= t.openMs && t.openMs <= s.expiresMs)
      .sort((a, b) => b.fromMs - a.fromMs)[0];
    if (owner) tripOf.set(owner, t);
  }
  const out = [];
  for (const slot of slots) {
    const { at, root, recs, ok, fromMs, expiresMs } = slot;
    const base = { v: VERSION, runId, root, lane: ok ? ok.lane : null, cycleAt: new Date(at).toISOString(), checked: recs.length, writtenAt: now.toISOString() };
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
      outcome = tripOutcome(trip, ok.plan, ok.side);
    } else {
      const refused = gateRefusals.find(g => Date.parse(g.cycleAt) === at && (!g.root || familyRoot(g.root) === familyRoot(root)));
      if (refused) { decision = 'refused'; refusal = refused.check || 'refused'; }
      outcome = limitOutcome({ bars: barsFor(root), tfMs, side: ok.side, entry: ok.plan.entry, stop: ok.plan.stop, target: ok.plan.target, fromMs, expiresMs, eodMs: eodOf(fromMs), tick: tickOf(root) });
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

/** Append-only: lines whose id the file holds already are kept as written, never replaced. */
function appendDecisions(file, lines) {
  const have = new Set(readDecisions(file).map(d => d.id));
  const fresh = lines.filter(l => !have.has(l.id));
  if (fresh.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.appendFileSync(file, `${old && !old.endsWith('\n') ? '\n' : ''}${fresh.map(l => `${JSON.stringify(l)}\n`).join('')}`);
  }
  return { added: fresh.length, kept: lines.length - fresh.length };
}

module.exports = { VERSION, FRAME, limitOutcome, bracketExit, tripOutcome, legsOf, settledDay, frameOf, buildDecisions, appendDecisions, readDecisions, logFile, gradeOf };
