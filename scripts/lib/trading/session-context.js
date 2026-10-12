'use strict';

/**
 * Session context for the cycle prompt, from local state only:
 *
 *   et / etStamp      times as the model reads them: New York time ("10:33 ET",
 *                     "2026-10-08 10:33:20 ET"), the clock the strategies,
 *                     sessions, and bars use
 *   premarketPlan     today's premarket game plan for a symbol: the journal's
 *                     latest note tagged premarket and the symbol, written in
 *                     this trading day (since 18:00 ET)
 *   newsLine          the news blackouts (scripts/blackouts.js): one in force
 *                     now, else the next one today, else that none is recorded
 *   unreviewedLine    today's closed entries with no review yet, per symbol (the gate refuses the next
 *                     entry on that root until each is reviewed: order-gate review-before-next-entry)
 */

const { zonedParts, tradingDayKey } = require('./clock');
const { entryTime, hasTag, entriesSince, contractRoot, mayBeRoot } = require('./journal');
const { tradingDayStart } = require('./clock');

const pad = n => String(n).padStart(2, '0');
const parts = t => zonedParts(new Date(t), 'America/New_York');

/** "10:33 ET" */
const et = t => { const p = parts(t); return `${pad(p.hour)}:${pad(p.minute)} ET`; };
/** "2026-10-08 10:33:20 ET" */
const etStamp = t => { const p = parts(t); return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ET`; };

const PLAN_CHARS = 400;

/** One line: today's premarket plan for `symbol`, or that there is none. */
function premarketPlan(entries, symbol, now) {
  const day = tradingDayKey(now);
  const notes = entries.filter(e => e.kind === 'note' && hasTag(e, 'premarket') && hasTag(e, String(symbol).toLowerCase())
    && Number.isFinite(entryTime(e)) && entryTime(e) <= now.getTime() && tradingDayKey(new Date(entryTime(e))) === day);
  if (!notes.length) return `${symbol}: no premarket plan in the journal for today.`;
  const n = notes[notes.length - 1];
  const text = String(n.text || '').replace(/\s+/g, ' ').trim();
  return `${symbol} premarket plan (${et(entryTime(n))}): ${text.length > PLAN_CHARS ? `${text.slice(0, PLAN_CHARS - 1)}…` : text}`;
}

/**
 * One line on the news blackouts: { items, error } as check-order.js
 * readBlackouts returns them. The gate refuses entries inside a window, and
 * all entries while the file is unreadable.
 */
function newsLine(blackouts, now) {
  if (blackouts && blackouts.error) return `News blackouts: the file is unreadable (${blackouts.error}); the order gate refuses every entry until it is fixed.`;
  const t = now.getTime();
  const day = tradingDayKey(now);
  const items = ((blackouts && blackouts.items) || []).filter(b => b && Number.isFinite(Date.parse(b.start)) && Number.isFinite(Date.parse(b.end)));
  const why = b => (b.reason ? `${b.reason} ` : '');
  const active = items.find(b => Date.parse(b.start) <= t && t < Date.parse(b.end));
  if (active) return `News blackout in force: ${why(active)}until ${et(active.end)} (no entries; manage open trades).`;
  const next = items.filter(b => Date.parse(b.start) > t && tradingDayKey(new Date(b.start)) === day).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  if (next) {
    const mins = Math.round((Date.parse(next.start) - t) / 60000);
    return `Next news blackout: ${why(next)}${et(next.start).replace(' ET', '')}-${et(next.end)}, in ${mins} min (no entries in it; a trade open then rides through it).`;
  }
  return 'No news blackout recorded for the rest of today.';
}

/**
 * The symbols with today's entries still unreviewed once nothing is left working on them (no position, no working
 * order), as one prompt line (null: none, or the positions unknown).
 * Counted as the gate counts them (order-gate successfulEntries against liveReviews, per contract root).
 */
function unreviewedLine(symbols, entries, positions, now, orders = []) {
  const { successfulEntries, liveReviews } = require('./order-gate');
  // Positions unknown (the account read failed): an open trade can't be told from a closed one, so say nothing.
  if (!Array.isArray(positions)) return null;
  const day = entriesSince(entries || [], tradingDayStart(now));
  // Still being managed: an open position, or a working order (an entry not filled yet, or its stop) on the root.
  const open = new Set([...positions.filter(p => p && p.size), ...(orders || []).filter(o => o && o.contractId)].map(p => contractRoot(p.contractId)));
  const out = [];
  for (const sym of symbols) {
    const root = contractRoot(sym);
    if ([...open].some(r => mayBeRoot(r, root) || mayBeRoot(root, r))) continue; // still being managed
    const n = successfulEntries(day).filter(e => mayBeRoot(e.contractId, root)).length - liveReviews(day, root).length;
    if (n > 0) out.push(`${sym}: ${n} closed entr${n === 1 ? 'y' : 'ies'} today with no review`);
  }
  return out.length ? `Unreviewed: ${out.join('; ')}. Run trade-review (the trade-reviewer role) first: the gate refuses a new entry on that symbol until each is reviewed.` : null;
}

module.exports = { et, etStamp, premarketPlan, newsLine, unreviewedLine, PLAN_CHARS };
