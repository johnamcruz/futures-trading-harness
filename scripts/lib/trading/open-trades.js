'use strict';

/**
 * The state of each open trade, so a cycle that manages a position starts
 * from the facts instead of rebuilding them: the setup it was entered on, the
 * initial risk, the working stop and target, where it stands in R now, its
 * best and worst excursion so far (MFE / MAE), and how long it has been held.
 *
 * Sources, all local or already read by the runner: the broker's open
 * positions and working orders (ProjectX: position type 1 long / 2 short,
 * averagePrice, creationTimestamp; order type 1 limit, 3 stop-limit, 4 stop,
 * 5 trailing stop, side 0 buy / 1 sell, limitPrice, stopPrice), the journal's
 * order_placed entry for the entry (its rationale names the setup and the
 * stop, as the trade-executor writes it), and the closed bars since the fill.
 */

const { contractRoot, entryTime } = require('./journal');

const STOP_TYPES = new Set([3, 4, 5]);
const LIMIT_TYPE = 1;
const MATCH_MS = 5 * 60000; // the entry's order_placed is at most this before the position opened

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
 * The open trades: [{ contractId, side, sign, size, entry, openedAt, setup,
 * initialStop, risk, stop, target, last, rNow, mfeR, maeR, barsHeld, notes }].
 * `barsFor(position)`: the closed bars of its contract ({ t, o, h, l, c }), or null.
 */
function openTrades({ positions = [], orders = [], entries = [], barsFor = () => null, stepMs = 180000 }) {
  return positions.filter(p => Number(p.size) > 0 && (p.type === 1 || p.type === 2)).map(p => {
    const sign = p.type === 1 ? 1 : -1;
    const entry = Number(p.averagePrice);
    const exitSide = sign > 0 ? 1 : 0;
    const mine = orders.filter(o => o.contractId === p.contractId && o.side === exitSide);
    const nearest = list => list.sort((a, b) => Math.abs(a.px - entry) - Math.abs(b.px - entry))[0];
    const stopO = nearest(mine.filter(o => STOP_TYPES.has(o.type) && Number.isFinite(Number(o.stopPrice))).map(o => ({ px: Number(o.stopPrice) })));
    const targetO = nearest(mine.filter(o => o.type === LIMIT_TYPE && Number.isFinite(Number(o.limitPrice))).map(o => ({ px: Number(o.limitPrice) })));
    const placed = entryOrder(entries, p);
    const text = placed ? String(placed.text || '') : '';
    const setup = (/\bsetup:([a-z0-9_-]+)/i.exec(text) || [])[1] || null;
    const planned = Number((/\bstop\s+(\d+(?:\.\d+)?)/i.exec(text) || [])[1]);
    const notes = [];
    // The initial stop: the one the entry was planned with (on the right side of the entry), else the working stop.
    let initialStop = Number.isFinite(planned) && sign * (entry - planned) > 0 ? planned : null;
    if (initialStop === null && stopO && sign * (entry - stopO.px) > 0) { initialStop = stopO.px; notes.push('initial stop unknown: risk from the working stop'); }
    if (!stopO) notes.push('NO working stop');
    const risk = initialStop !== null ? Math.abs(entry - initialStop) : null;
    const opened = Date.parse(p.creationTimestamp);
    // Bars that opened at or after the fill (the fill's own bar is partly before it).
    const bars = (barsFor(p) || []).filter(b => !Number.isFinite(opened) || Date.parse(b.t) >= opened);
    const R = x => (risk > 0 ? Math.round(((sign * (x - entry)) / risk) * 100) / 100 : null);
    const last = bars.length ? bars[bars.length - 1].c : null;
    return {
      contractId: p.contractId, side: sign > 0 ? 'long' : 'short', sign, size: Number(p.size), entry,
      openedAt: Number.isFinite(opened) ? new Date(opened).toISOString() : null, setup, initialStop, risk,
      stop: stopO ? stopO.px : null, target: targetO ? targetO.px : null, last,
      rNow: last !== null ? R(last) : null,
      mfeR: bars.length ? R(sign > 0 ? Math.max(...bars.map(b => b.h)) : Math.min(...bars.map(b => b.l))) : null,
      maeR: bars.length ? R(sign > 0 ? Math.min(...bars.map(b => b.l)) : Math.max(...bars.map(b => b.h))) : null,
      barsHeld: Number.isFinite(opened) ? bars.length : null, stepMs, notes,
    };
  });
}

/** One sentence per open trade, for the prompt. */
function describeOpenTrade(t, { round = x => Math.round(x * 100) / 100, tickSize = null, et = null } = {}) {
  const r = x => (x === null || x === undefined ? '?' : round(x));
  const sR = x => (x === null || x === undefined ? '?' : `${x >= 0 ? '+' : ''}${x}R`);
  const R = x => (t.risk > 0 && x !== null ? Math.round(((t.sign * (x - t.entry)) / t.risk) * 100) / 100 : null);
  const since = t.openedAt ? ` since ${et ? et(t.openedAt) : t.openedAt}` : '';
  const held = t.barsHeld !== null ? `, ${t.barsHeld} bar${t.barsHeld === 1 ? '' : 's'} closed since` : '';
  const risk = t.risk !== null ? `initial stop ${r(t.initialStop)}: risk ${r(t.risk)} points${tickSize ? ` = ${Math.round(t.risk / tickSize)} ticks` : ''}` : 'initial risk unknown';
  const stop = t.stop !== null ? `working stop ${r(t.stop)} (${sR(R(t.stop))})` : 'NO working stop';
  const target = t.target !== null ? `, target ${r(t.target)} (${sR(R(t.target))})` : ', no target order';
  const now = t.last === null ? '; no closed bar since the fill yet'
    : t.rNow === null ? `; last close ${r(t.last)} (no R without an initial risk)`
      : `; now ${sR(t.rNow)} at ${r(t.last)}, best ${sR(t.mfeR)}, worst ${sR(t.maeR)}`;
  const notes = t.notes.filter(n => n !== 'NO working stop');
  return `Open trade ${t.contractId} ${t.side} ${t.size} @ ${r(t.entry)}${since}${held} (${t.setup ? `setup:${t.setup}` : 'setup unknown: no order_placed entry with a setup tag'}): ${risk}; ${stop}${target}${now}${notes.length ? ` (${notes.join('; ')})` : ''}.`;
}

module.exports = { STOP_TYPES, entryOrder, openTrades, describeOpenTrade };
