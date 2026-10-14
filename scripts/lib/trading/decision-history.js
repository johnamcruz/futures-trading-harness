'use strict';

/**
 * The model's own recent decisions, as the cycle prompt shows them (autotrader.js historyText): one compact line
 * per decision, with what happened since, so the next cycle can see a run of misses or stops, not only what it
 * said. The runner records an entry after each trade cycle (runner.js state.history, kept across restarts):
 *
 *   decisionEntry({ at, symbols, result, items, entries, lanes })   the state.history entry for a cycle: its
 *       result line plus the facts at the decision: the symbol and lane, the bar and its close (the price), the
 *       tick, the action (entered, skipped, managed, no-trade, flattened, blocked, planned, error), and the setup's
 *       strategy, side and stop distance (1R) when there is one. `items`: the cycle's { symbol, minutes, tickSize,
 *       bar: { t, c }, scan, verdicts }; `entries`: the journal read after the cycle (the entry it placed, if any).
 *   historyLines(history, market)   the lines, oldest first; consecutive identical no-trades collapse into one
 *       ("10:03-10:18 MNQ 3m no-trade ×6 @21500.25: nothing fired; since -4t").
 *   marketOf(items, timeframe)      the bars the outcomes read: per symbol and lane, its closed bars and the close
 *       of this cycle's bar (asOf).
 *   parseResult(result)             { word, reason } of a result line ("CYCLE RESULT: no-trade - nothing fired").
 *
 * What happened since is read only from bars that had closed by this cycle's bar (no look-ahead: a bar closing
 * after `asOf` is never read, whatever the list holds), so replay and live show the same text for the same bars:
 *   - the ticks moved from the decision's price to the last closed bar's close;
 *   - a skipped, no-trade or planned setup with a stop: whether price would have reached +1R or -1R from the
 *     decision's price first (a bar reaching both counts as -1R, the stop first), or neither yet;
 *   - an entered trade: its real position, never the decision's price (withPositions): while the broker lists it,
 *     "open from <fill>, now +xR" (the open trade's own R: fill and initial risk); once it is gone, "closed" with the
 *     R of the runner's own exit, else of the working stop or target a bar reached after it was last seen open
 *     (from the fill), else no R; "no position seen" while none was matched.
 * Only bars of the decision's trading day and contract count (the runner flattens at end of day; a roll changes
 * the prices); a decision from an earlier trading day carries its date. A setup is named only on a decision about
 * one (entered, skipped, planned); a manage, flatten or block names the symbol its reason names. An executed cycle
 * whose journal could not be read names no setup ("details unavailable"): it is not guessed from the scan.
 * An entry from before these fields (only { at, symbols, result }) renders with what it has.
 *
 *   withPositions(history, { trades, known, now, market, closes })   the entered entries with their real position:
 *       `trades` the open trades (open-trades.js), `known` whether the account's positions were read this cycle (a
 *       failed read closes nothing), `closes` the runner's own exits ({ [contractId]: { at, r } }).
 */

const { et } = require('./session-context');
const { entryTime, contractRoot } = require('./journal');
const { tradingDayKey } = require('./clock');

// The result line's outcome word (autotrader.js CYCLE_OUTCOMES) -> the action the history names.
const ACTIONS = { 'no-trade': 'no-trade', planned: 'planned', executed: 'entered', managed: 'managed', flattened: 'flattened', blocked: 'blocked', error: 'error' };
// The actions whose setup was not taken: what it would have done is the counterfactual.
const NOT_TAKEN = new Set(['skipped', 'no-trade', 'planned']);
const REASON_CHARS = 100;
const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;
const SETUP_TAG = /^\s*setup:([a-z0-9][a-z0-9_-]*)\b/i;
const SIDE_WORD = /^\s*setup:[a-z0-9_-]+\s+(long|short|buy|sell)\b/i;

const num = x => Number(Number(x).toFixed(4));
const hhmm = t => (Number.isFinite(Date.parse(t)) ? et(t).replace(' ET', '') : '?');

/** { word, reason }: the outcome word when it is one of ACTIONS' keys (null otherwise) and the reason after it. */
function parseResult(result) {
  const text = String(result || '').replace(/\s+/g, ' ').trim();
  const m = /^CYCLE RESULT:[\s*_`]*([A-Za-z-]+)[*_`]*(?![A-Za-z0-9-])\s*[:,.]?\s*(?:-\s*)?(.*)$/.exec(text);
  const word = m ? m[1].toLowerCase() : null;
  if (word && Object.prototype.hasOwnProperty.call(ACTIONS, word)) return { word, reason: m[2].trim() };
  return { word: null, reason: text.replace(/^CYCLE RESULT:\s*/, '') || 'no result' };
}

/** The setup on the table on an item's bar: a policy's verdict (an entry first), else the first rules strategy that fired. */
function setupOf(item) {
  const tick = Number(item.tickSize);
  const verdicts = Array.isArray(item.verdicts) ? item.verdicts.filter(Boolean) : [];
  const v = verdicts.find(x => x.action !== 'skip') || verdicts[0];
  if (v && v.strategy && v.direction) {
    return { setup: v.strategy, side: v.direction, stop: Number(v.stopTicks) > 0 && tick > 0 ? num(v.stopTicks * tick) : null, target: null, why: v.action === 'skip' ? v.reason || null : null };
  }
  const r = (Array.isArray(item.scan) ? item.scan : []).find(x => x && x.candidate && x.direction && x.signal === 'rules');
  return r ? { setup: r.name, side: r.direction, stop: Number(r.stopDistance) > 0 ? num(r.stopDistance) : null, target: Number(r.targetDistance) > 0 ? num(r.targetDistance) : null, why: null } : null;
}

// An order's side as the interface's place_order takes it ('buy' | 'sell') or as a broker records it (0 buy, 1 sell).
const sideOf = s => (s === 0 || /^(buy|long)$/i.test(String(s)) ? 'long' : s === 1 || /^(sell|short)$/i.test(String(s)) ? 'short' : null);

/**
 * The entry order the cycle placed (the broker's order_placed journal entry): the first at or after the cycle's
 * start (`startMs`), else the last at or after its bar's close (`sinceMs`; a broker's replay clock may stamp that):
 * never one an earlier cycle that ran past the bar's close placed before this one started.
 */
function placedSince(entries, sinceMs, startMs = sinceMs) {
  const all = (entries || []).filter(x => x && x.kind === 'order_placed' && x.data && x.data.result && x.data.result.success === true
    && !RISK_REDUCING.test(String(x.text || '')) && SETUP_TAG.test(String(x.text || '')) && entryTime(x) >= sinceMs);
  const e = all.find(x => entryTime(x) >= startMs) || all[all.length - 1];
  if (!e) return null;
  const text = String(e.text || '');
  const req = (e.data && e.data.request) || {};
  const word = (SIDE_WORD.exec(text) || [])[1];
  const ticks = b => { const n = b && Number(b.ticks); return n > 0 ? n : null; };
  return { root: e.contractId ? contractRoot(e.contractId) : null, setup: SETUP_TAG.exec(text)[1], side: sideOf(word) || sideOf(req.side), ticks: ticks(req.stopLossBracket), targetTicks: ticks(req.takeProfitBracket) };
}

/** The state.history entry for a cycle (see the module comment). */
function decisionEntry({ at, symbols = [], result = null, items = [], entries = [], lanes = null, journalFailed = false }) {
  const base = { at, symbols, result, ...(Array.isArray(lanes) && lanes.length ? { lanes } : {}) };
  const list = (items || []).filter(x => x && x.bar && x.bar.t);
  if (!list.length) return base;
  const { word, reason } = parseResult(result);
  const closeOf = x => Date.parse(x.bar.t) + (Number(x.minutes) || 0) * 60000;
  // The order this cycle placed: journaled after its bar closed (a broker's replay clock may stamp the bar's close).
  const placed = word === 'executed' ? placedSince(entries, Math.min(...list.map(closeOf)), Date.parse(at)) : null;
  const rootOf = x => { try { return contractRoot(x.contractId || x.bar.contractId || x.symbol); } catch (_err) { return String(x.symbol).toUpperCase(); } };
  const action0 = word ? ACTIONS[word] : null;
  // A setup belongs to a decision about one: an entry, a skip (a no-trade or a plan with a setup on the table).
  const aboutSetup = action0 === 'entered' || action0 === 'no-trade' || action0 === 'planned';
  // The decision's item: the one the placed order is on; for a setup decision the first with a setup; else the one
  // the reason names; else the first.
  const named = list.find(x => new RegExp(`\\b${String(x.symbol).replace(/[^A-Za-z0-9]/g, '')}\\b`, 'i').test(reason));
  const item = (placed && placed.root && list.find(x => rootOf(x) === placed.root))
    || (aboutSetup && ((named && setupOf(named) ? named : null) || list.find(x => setupOf(x)))) || named || list[0];
  // An entry whose order can't be read (the journal failed): its setup is not guessed from the scan.
  const unknown = action0 === 'entered' && journalFailed;
  const setup = aboutSetup && !unknown ? setupOf(item) : null;
  const tick = Number(item.tickSize) > 0 ? Number(item.tickSize) : null;
  const action = action0 === 'no-trade' && setup ? 'skipped' : action0;
  const same = setup && placed && setup.setup === placed.setup;
  const facts = placed
    ? { setup: placed.setup, side: placed.side || (same ? setup.side : null), stop: placed.ticks && tick ? num(placed.ticks * tick) : same ? setup.stop : null, target: placed.targetTicks && tick ? num(placed.targetTicks * tick) : same ? setup.target : null }
    : setup ? { setup: setup.setup, side: setup.side, stop: setup.stop, target: setup.target } : {};
  const why = setup && setup.why ? { why: String(setup.why) } : {};
  const contract = item.contractId || item.bar.contractId || null;
  return {
    ...base, symbol: item.symbol, tf: Number(item.minutes) || null, bar: item.bar.t, price: Number(item.bar.c), tick, ...(contract ? { contract } : {}), action,
    ...Object.fromEntries(Object.entries(facts).filter(([, x]) => x !== null && x !== undefined)), ...why,
    ...(unknown ? { details: 'unavailable' } : {}),
  };
}

/** Per symbol and lane, the closed bars the outcomes may read and this cycle's bar close: [{ symbol, minutes, bars, asOf }]. */
function marketOf(items, timeframe) {
  return (items || []).filter(x => x && x.bar && x.bar.t).map(x => {
    const minutes = Number(x.minutes) || Number(timeframe) || null;
    return { symbol: x.symbol, minutes, bars: x.bars || x.bar.recent || [], asOf: minutes ? Date.parse(x.bar.t) + minutes * 60000 : NaN, contractId: x.contractId || x.bar.contractId || null };
  });
}

/**
 * What happened since entry `e` (not an entry's R: tradeText), from market `m`'s bars closed by m.asOf:
 * '' when nothing can be said.
 */
function outcome(e, m) {
  if (!m || !Number.isFinite(e.price) || !(e.tick > 0) || !e.bar || !(m.minutes > 0) || !Number.isFinite(m.asOf)) return '';
  // Another contract (a roll since): its prices are not this decision's.
  if (e.contract && m.contractId && e.contract !== m.contractId) return '';
  const step = m.minutes * 60000;
  const from = Date.parse(e.bar) + (Number(e.tf) || m.minutes) * 60000;
  const until = m.asOf;
  // The decision's trading day only (the runner flattens at its end of day).
  const day = Number.isFinite(from) ? tradingDayKey(new Date(Date.parse(e.bar))) : null;
  const after = (Array.isArray(m.bars) ? m.bars : []).filter(b => {
    const t = b && Date.parse(b.t);
    return Number.isFinite(t) && t >= from && t + step <= until && tradingDayKey(new Date(t)) === day && [b.h, b.l, b.c].every(x => Number.isFinite(Number(x)));
  });
  if (!after.length) return '';
  const last = Number(after[after.length - 1].c);
  const ticks = Math.round((last - e.price) / e.tick);
  const out = [`since ${ticks > 0 ? '+' : ''}${ticks}t`];
  const sign = e.side === 'long' ? 1 : e.side === 'short' ? -1 : 0;
  const R = Number(e.stop);
  if (sign && R > 0) {
    // +1R / -1R for the setup's side: above the price for a long's +1R and a short's -1R, below for the others.
    const hit = (b, r) => { const level = e.price + sign * r * R; return sign * r > 0 ? Number(b.h) >= level : Number(b.l) <= level; };
    if (NOT_TAKEN.has(e.action)) {
      const first = after.find(b => hit(b, 1) || hit(b, -1));
      out.push(!first ? 'neither +1R nor -1R yet' : hit(first, -1) ? 'would hit -1R first' : 'would hit +1R first');
    }
  }
  return out.join(', ');
}

const fmtR = v => { const x = Math.round(Number(v) * 10) / 10; return `${x > 0 ? '+' : ''}${x}R`; };

/** An entered trade's real position (withPositions), never measured from the decision's price. */
function tradeText(e) {
  const t = e.trade;
  if (!t) return 'no position seen';
  if (t.state === 'open') return `open from ${num(t.fill)}${Number.isFinite(t.rNow) ? `, now ${fmtR(t.rNow)}` : ''}`;
  return `closed${Number.isFinite(t.r) ? ` ${fmtR(t.r)}` : ''}${t.how ? ` ${t.how}` : ''}`;
}

const rootOfId = id => { try { return contractRoot(id); } catch (_err) { return String(id || '').toUpperCase(); } };

/**
 * How a position last seen open (`tr`) closed by `nowMs`: the runner's own exit (`closes`), else the first bar,
 * closed after it was last seen and by now, through its working stop (first) or target, from the fill.
 */
function closedTrade(tr, m, closes, nowMs) {
  const seen = Date.parse(tr.seenAt);
  const own = closes && tr.contractId ? closes[tr.contractId] : null;
  if (own && Date.parse(own.at) > seen && Date.parse(own.at) <= nowMs && Number.isFinite(own.r)) return { ...tr, state: 'closed', r: own.r, how: 'by the runner\'s exit' };
  const sign = tr.side === 'long' ? 1 : tr.side === 'short' ? -1 : 0;
  const R = Number(tr.risk);
  const done = (px, how) => ({ ...tr, state: 'closed', r: sign && R > 0 ? Math.round(sign * (px - tr.fill) / R * 100) / 100 : null, how });
  if (m && m.minutes > 0 && sign) {
    const step = m.minutes * 60000;
    const until = Math.min(nowMs, Number.isFinite(m.asOf) ? m.asOf : nowMs);
    for (const b of (Array.isArray(m.bars) ? m.bars : [])) {
      const t = b && Date.parse(b.t);
      if (!Number.isFinite(t) || t + step <= seen || t + step > until) continue;
      if (Number.isFinite(tr.stop) && (sign > 0 ? Number(b.l) <= tr.stop : Number(b.h) >= tr.stop)) return done(tr.stop, 'at its stop');
      if (Number.isFinite(tr.target) && (sign > 0 ? Number(b.h) >= tr.target : Number(b.l) <= tr.target)) return done(tr.target, 'at its target');
    }
  }
  return { ...tr, state: 'closed', r: null, how: null };
}

/** The entered entries with their real position (see the module comment); the history is otherwise unchanged. */
function withPositions(history, { trades = [], known = false, now, market = [], closes = {} } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const list = (history || []).slice();
  const open = (trades || []).filter(t => t && t.contractId && Number.isFinite(Number(t.entry)))
    .sort((a, b) => (Date.parse(b.openedAt) || 0) - (Date.parse(a.openedAt) || 0));
  const claimed = new Set();
  // Newest decision first: each open trade belongs to the latest entry on its root and side opened since it.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const h = list[i];
    if (!h || h.action !== 'entered' || !h.bar || (h.trade && h.trade.state === 'closed')) continue;
    const root = rootOfId(h.contract || h.symbol);
    const t = open.find(x => !claimed.has(x) && rootOfId(x.contractId) === root && (!h.side || x.side === h.side)
      && (!x.openedAt || Date.parse(x.openedAt) >= Date.parse(h.bar))
      && (!h.trade || !h.trade.openedAt || !x.openedAt || x.openedAt === h.trade.openedAt));
    if (t) {
      claimed.add(t);
      list[i] = { ...h, trade: { state: 'open', contractId: t.contractId, side: t.side, fill: Number(t.entry), risk: t.risk, stop: t.stop, target: t.target, rNow: t.rNow, openedAt: t.openedAt || null, seenAt: new Date(nowMs).toISOString() } };
    } else if (h.trade && h.trade.state === 'open' && known) {
      list[i] = { ...h, trade: closedTrade(h.trade, marketFor(h, market), closes, nowMs) };
    }
  }
  return list;
}

/** The market an entry's outcome reads: its symbol's lane, else any lane of the symbol. */
const marketFor = (e, market) => {
  const own = (market || []).filter(m => m.symbol === e.symbol);
  return own.find(m => m.minutes === e.tf) || own[0] || null;
};

/** One line per decision, oldest first (see the module comment). */
function historyLines(history, market = []) {
  const list = (history || []).filter(h => h && typeof h === 'object');
  const rows = list.map(h => {
    const { word, reason } = parseResult(h.result);
    const action = h.action || (word ? ACTIONS[word] : null);
    // The lane: the lanes the cycle covered (several lanes), else the decision's bar's.
    const sym = `${h.symbol || (Array.isArray(h.symbols) ? h.symbols.join(',') : String(h.symbols || '?'))}${Array.isArray(h.lanes) && h.lanes.length ? ` ${h.lanes.join('+')}` : h.tf ? ` ${h.tf}m` : ''}`;
    const text = String(reason || h.why || '').replace(/\.$/, '');
    const why = text.length > REASON_CHARS ? `${text.slice(0, REASON_CHARS - 1)}…` : text;
    // An entered trade: the ticks since the decision, then its real position (never R from the decision's price).
    const since = [outcome(h, marketFor(h, market)), h.action === 'entered' && h.bar ? tradeText(h) : ''].filter(Boolean).join(', ');
    const what = [action, h.setup, h.side, h.details === 'unavailable' ? '(details unavailable)' : ''].filter(Boolean).join(' ');
    return { h, action, sym, why, what, since };
  });
  // Consecutive identical no-trades (same symbol, lane and reason): one line, the first one's price and outcome.
  const runs = [];
  for (const r of rows) {
    const last = runs[runs.length - 1];
    const dayOf = x => { const ms = Date.parse(x); return Number.isFinite(ms) ? tradingDayKey(new Date(ms)) : null; };
    if (last && r.action === 'no-trade' && last.first.action === 'no-trade' && last.first.sym === r.sym && last.first.why === r.why && dayOf(last.to) === dayOf(r.h.at)) { last.n += 1; last.to = r.h.at; } else runs.push({ first: r, n: 1, to: r.h.at });
  }
  // A decision from an earlier trading day than this cycle's carries its date ("10-12 15:48").
  const asOfs = (market || []).map(m => m && m.asOf).filter(Number.isFinite);
  const today = asOfs.length ? tradingDayKey(new Date(Math.max(...asOfs))) : null;
  const stamp = t => {
    const ms = Date.parse(t);
    if (!today || !Number.isFinite(ms)) return hhmm(t);
    const d = tradingDayKey(new Date(ms));
    return d === today ? hhmm(t) : `${d.slice(5)} ${hhmm(t)}`;
  };
  return runs.map(({ first: r, n, to }) => {
    const when = n > 1 ? `${stamp(r.h.at)}-${hhmm(to)}` : stamp(r.h.at);
    const px = Number.isFinite(r.h.price) ? ` @${num(r.h.price)}` : '';
    return `${when} ${r.sym}${r.what ? ` ${r.what}` : ''}${n > 1 ? ` ×${n}` : ''}${px}${r.why ? `: ${r.why}` : ''}${r.since ? `; ${r.since}` : ''}`;
  });
}

module.exports = { ACTIONS, parseResult, decisionEntry, marketOf, outcome, historyLines, withPositions };
