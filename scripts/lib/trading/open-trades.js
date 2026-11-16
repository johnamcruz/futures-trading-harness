'use strict';

/**
 * The state of each open trade, so a cycle that manages a position starts
 * from the facts instead of rebuilding them: the setup it was entered on, the
 * initial risk, the working stop and target, where it stands in R now, its
 * best and worst excursion so far (MFE / MAE), and how long it has been held.
 *
 * Sources, all local or already read by the runner: the broker's open
 * positions and working orders (broker MCP interface: position type 1 long / 2 short,
 * averagePrice, creationTimestamp; order type 1 limit, 3 stop-limit, 4 stop,
 * 5 trailing stop, side 0 buy / 1 sell, limitPrice, stopPrice), the journal's
 * order_placed entry for the entry (its rationale names the setup and the
 * stop, as the trade-executor writes it), and the closed bars since the fill.
 * Each line ends with the trade's read facts (trade-read.js: failed extreme,
 * pushes, pullback depth, VWAP and EMA20, structure, displacement and
 * compression against, the HTF bias then and now), for the pullback-vs-reversal
 * read of an open trade.
 */

const { contractRoot, entryTime } = require('./journal');
const { heldFor: heldOf, positionKey, positionRead, positionLine } = require('./position-read');
const { tradeRead, tradeReadLine } = require('./trade-read');
const { manageRead, manageReadLine } = require('./manage-read');
const { levelOnTick } = require('./contracts');
// The gate's reading of "stop <price>": a unit (40 ticks, 2R) is not a price; thousands separators are.
const { STOP_PRICE } = require('./order-gate');

const STOP_TYPES = new Set([3, 4, 5]);
const clamp = (f, x) => (x === null ? null : f(0, x));
const LIMIT_TYPE = 1;
const MATCH_MS = require('../tunables').runner().session.entryMatchMs; // the entry's order_placed is at most this before the position opened (config/runner.json)
const GRACE_MS = require('../tunables').runner().runner.fillGraceMs; // the runner's bar rule: a bar that opened this before the fill counts

/** The entry's order_placed journal entry for a position: the last successful one on its contract before it opened. */
function entryOrder(entries, position) {
  const opened = Date.parse(position.creationTimestamp);
  const root = contractRoot(position.contractId);
  const cands = entries.filter(e => e.kind === 'order_placed' && e.data && e.data.result && e.data.result.success === true
    && /\bsetup:[a-z0-9_-]+/i.test(String(e.text || ''))
    && (e.contractId === position.contractId || (e.contractId && contractRoot(e.contractId) === root)));
  const before = cands.filter(e => !Number.isFinite(opened) || (entryTime(e) <= opened + 60000 && entryTime(e) >= opened - MATCH_MS));
  return before.length ? before[before.length - 1] : null;
}

/**
 * The open trades: [{ contractId, side, sign, size, entry, averagePrice, openedAt, setup, initialStop, risk, riskFrom,
 * stop, stops, target, last, rNow, mfeR, maeR, barsHeld, from, held, position, notes }].
 * `barsFor(position)`: the closed bars of its contract ({ t, o, h, l, c }), or null.
 * One R basis (position-read.js): `heldFor(position)` the runner's held trade for it (state.trails), used when it is the
 * position's and current (`lastBarFor(position)`: the last closed bar's time; undefined: no bar this pass, the held
 * trade as of its last bar): its entry and 1R are the trade's, every R here and in the reads is in them; else the
 * journal's planned stop, else the working stop. `from`: the first bar counted, the runner's rule (a bar that opened at
 * most graceMs before the fill). `stop`: the working stop (the one nearest the entry, as before); `stops`: every one.
 * `position`: the Position line's facts (position-read.js positionRead), or { unavailable }.
 */
function openTrades({ positions = [], orders = [], entries = [], barsFor = () => null, stepMs = require('../tunables').runner().bars.timeframe * 60000, heldFor = () => null, lastBarFor = () => undefined, tickFor = () => null, graceMs = GRACE_MS }) {
  return positions.filter(p => Number(p.size) > 0 && (p.type === 1 || p.type === 2)).map(p => {
    const sign = p.type === 1 ? 1 : -1;
    const averagePrice = Number(p.averagePrice);
    const h = heldOf(heldFor(p), { key: positionKey(p), lastBarT: lastBarFor(p) });
    const held = h.held && h.held.risk > 0 && Number.isFinite(h.held.entry) ? h.held : null;
    const entry = held ? held.entry : averagePrice;
    const exitSide = sign > 0 ? 1 : 0;
    const mine = orders.filter(o => o.contractId === p.contractId && o.side === exitSide);
    const nearest = list => list.sort((a, b) => Math.abs(a.px - entry) - Math.abs(b.px - entry))[0];
    const stopList = mine.filter(o => STOP_TYPES.has(o.type) && Number.isFinite(Number(o.stopPrice))).map(o => ({ px: Number(o.stopPrice) }));
    const stopO = nearest([...stopList]);
    const targetO = nearest(mine.filter(o => o.type === LIMIT_TYPE && Number.isFinite(Number(o.limitPrice))).map(o => ({ px: Number(o.limitPrice) })));
    const placed = entryOrder(entries, p);
    const text = placed ? String(placed.text || '') : '';
    const setup = (/\bsetup:([a-z0-9_-]+)/i.exec(text) || [])[1] || null;
    const m = STOP_PRICE.exec(text);
    const planned = m ? Number(m[1].replace(/,/g, '')) : NaN;
    const notes = [];
    // The initial stop: the runner's held trade's (its entry less 1R); else the one the entry was planned with (on the
    // right side of the entry), else the working stop.
    let initialStop = held ? entry - sign * held.risk : Number.isFinite(planned) && sign * (entry - planned) > 0 ? planned : null;
    let riskFrom = held ? 'runner' : initialStop !== null ? 'journal' : null;
    if (initialStop === null && stopO && sign * (entry - stopO.px) > 0) { initialStop = stopO.px; riskFrom = 'working'; notes.push('initial stop unknown: risk from the working stop'); }
    if (!stopO) notes.push('NO working stop');
    const risk = held ? held.risk : initialStop !== null ? Math.abs(entry - initialStop) : null;
    const opened = Date.parse(p.creationTimestamp);
    // The runner's bar rule: bars that opened at or after the fill less the grace (a market fill seconds into a bar
    // counts that bar, as the runner's trail and the backtest do). No bars at all (its contract had no bar this cycle) is
    // not the same as no bar since the fill.
    const from = Number.isFinite(opened) ? opened - graceMs : null;
    const raw = barsFor(p);
    const bars = (raw || []).filter(b => from === null || Date.parse(b.t) >= from);
    const R = x => (risk > 0 ? Math.round(((sign * (x - entry)) / risk) * 100) / 100 : null);
    const last = bars.length ? bars[bars.length - 1].c : null;
    const t = {
      contractId: p.contractId, side: sign > 0 ? 'long' : 'short', sign, size: Number(p.size), entry, averagePrice,
      openedAt: Number.isFinite(opened) ? new Date(opened).toISOString() : null, setup, initialStop, risk, riskFrom,
      stop: stopO ? stopO.px : null, stops: stopList.map(x => x.px), target: targetO ? targetO.px : null, last,
      rNow: last !== null ? R(last) : null,
      // MFE never under 0, MAE never above it (the extremes of closed bars from the entry).
      mfeR: bars.length ? clamp(Math.max, R(sign > 0 ? Math.max(...bars.map(b => b.h)) : Math.min(...bars.map(b => b.l)))) : null,
      maeR: bars.length ? clamp(Math.min, R(sign > 0 ? Math.min(...bars.map(b => b.l)) : Math.max(...bars.map(b => b.h)))) : null,
      barsHeld: raw && Number.isFinite(opened) ? bars.length : null, noBars: !raw, stepMs, from: from === null ? null : new Date(from).toISOString(), held: Boolean(held), notes,
    };
    t.position = positionRead(t, { held, why: h.why || null, asOf: h.asOf || null, bars: raw ? bars : null, tick: tickFor(p), graceMs });
    // One basis: the held trade's numbers for the fields too.
    if (held && !t.position.unavailable) Object.assign(t, { last: t.position.last, rNow: t.position.nowR, mfeR: t.position.mfeR, maeR: t.position.maeR });
    return t;
  });
}

/**
 * The open trade's read facts as one line (trade-read.js) and its manage read (manage-read.js: the levels its STOP line
 * is set from), from its contract's closed bars (`base`-minute bars); a failure is said in the line, never dropped.
 */
function tradeReadText(t, { bars, base, tickSize = null, exit = null }) {
  try {
    const level = tickSize ? x => levelOnTick(x, tickSize) : undefined;
    // One basis with the Position line: the same first bar (the runner's rule) and, held by the runner, its best price.
    const best = t.position && t.position.basis === 'held' && Number.isFinite(t.position.best) ? t.position.best : null;
    const from = t.from || null;
    const read = tradeReadLine(tradeRead({ side: t.side, entry: t.entry, openedAt: t.openedAt, bars, base, tick: tickSize, exit, from, best }), level ? { level } : {});
    // The levels the managed cycle's STOP line is set from (manage-read.js); a failure is said, never dropped.
    let manage;
    try {
      manage = manageReadLine(manageRead({ side: t.side, entry: t.entry, risk: t.risk, stop: t.stop, openedAt: t.openedAt, bars, base, tick: tickSize, exit, from, best }), level ? { level } : {});
    } catch (err) {
      manage = `Manage read: unavailable (${err.message}).`;
    }
    return `${read} ${manage}`;
  } catch (err) {
    return `Trade read: unavailable (${err.message}).`;
  }
}

/**
 * One open trade for the prompt: its Position line (position-read.js; `Position: unavailable (...)` when it can't be
 * stated) first, then one sentence (`read`: its trade read line, appended). Total: never throws (a failure is said).
 */
function describeOpenTrade(t, { round = x => Math.round(x * 100) / 100, tickSize = null, et = null, history = null, read = null } = {}) {
  let position;
  try {
    position = positionLine(t && t.position, { level: tickSize ? x => levelOnTick(x, tickSize) : x => round(x) });
  } catch (err) {
    position = `Position: unavailable (${err.message}).`;
  }
  try {
    const r = x => (x === null || x === undefined ? '?' : round(x));
    const sR = x => (x === null || x === undefined ? '?' : `${x >= 0 ? '+' : ''}${x}R`);
    const R = x => (t.risk > 0 && x !== null ? Math.round(((t.sign * (x - t.entry)) / t.risk) * 100) / 100 : null);
    const since = t.openedAt ? ` since ${et ? et(t.openedAt) : t.openedAt}` : '';
    const held = t.barsHeld !== null ? `, ${t.barsHeld} bar${t.barsHeld === 1 ? '' : 's'} closed since` : '';
    const fromWorking = t.notes.includes('initial stop unknown: risk from the working stop');
    const pts = t.risk !== null ? `${r(t.risk)} points${tickSize ? ` = ${Math.round(t.risk / tickSize)} ticks` : ''}` : null;
    const risk = t.risk === null ? 'initial risk unknown'
      : fromWorking ? `risk ${pts}, measured to the working stop (the initial stop is unknown)` : `initial stop ${r(t.initialStop)}: risk ${pts}`;
    const stop = t.stop !== null ? `working stop ${r(t.stop)} (${sR(R(t.stop))})` : 'NO working stop';
    const target = t.target !== null ? `, target ${r(t.target)} (${sR(R(t.target))})` : ', no target order';
    // Now, best and worst are the Position line's (one basis); a contract with no bar this cycle is said here.
    const now = t.noBars ? '; no bars for this contract this cycle (read get_bars or the quote)' : '';
    const notes = t.notes.filter(n => n !== 'NO working stop' && n !== 'initial stop unknown: risk from the working stop');
    // `history`: how the strategy's past trades moved (track-record.js excursionNote), to judge this one by.
    return `${position} Open trade ${t.contractId} ${t.side} ${t.size} @ ${r(t.entry)}${since}${held} (${t.setup ? `setup:${t.setup}` : 'setup unknown: no order_placed entry with a setup tag'}): ${risk}; ${stop}${target}${now}${notes.length ? ` (${notes.join('; ')})` : ''}.${history ? ` ${history}.` : ''}${read ? ` ${read}` : ''}`;
  } catch (err) {
    return `${position} Open trade ${t && t.contractId ? t.contractId : '?'}: details unavailable (${err.message}).`;
  }
}

module.exports = { STOP_TYPES, entryOrder, openTrades, describeOpenTrade, tradeReadText };
