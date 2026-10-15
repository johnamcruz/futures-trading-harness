'use strict';

/**
 * The model's own recent decisions, as the cycle prompt shows them (autotrader.js historyText): one compact line
 * per decision, with what happened since, so the next cycle can see a run of misses or stops, not only what it
 * said. The runner records an entry after each trade cycle (runner.js state.history, kept across restarts):
 *
 *   decisionEntry({ at, symbols, result, items, entries, lanes, output, cycle, cached })   the state.history entry: its
 *       result line plus the facts at the decision: the symbol and lane, the bar and its close (the price), the
 *       tick, the action (entered, skipped, vetoed, managed, no-trade, flattened, blocked, planned, error), and the
 *       setup's strategy, side and stop distance (1R) when there is one. `items`: the cycle's { symbol, minutes,
 *       tickSize, bar: { t, c }, scan, verdicts }; `entries`: the journal read after the cycle (the entry it placed,
 *       if any; an item's `composed`: the compose records on its bar, lifecycle-runner.js recordSummary, whose latest
 *       OK one is its setup, trade_lifecycle); `output`: the cycle's transcript. A no-trade with a setup on the table is `vetoed` when the cycle's
 *       phase-2 report (roles-ran.js round and latestPhase2: the latest phase-2 call as the gate finds it, never phase 1;
 *       `cycle` and `cached`: the cycle kind and the roles served from the cache) is a veto (verdictOf) naming its setup
 *       (or, naming none of the cycle's setups, its symbol); else
 *       `skipped`: the model's own pass, a good decision when its counterfactual lost. A transcript
 *       with no such report (a harness whose transcript doesn't show the roles' reports) is a pass, as before.
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
 *   - an entered trade: its real position (withPositions; never the decision's price, never a guess), matched by
 *     family as the runner manages positions: while the broker lists it, "open from <fill>, now +xR" (the open
 *     trade's own R: fill and initial risk); once it is gone, "closed +xR" from its closing fills (matched exactly:
 *     contract, side, size, after it opened), else "closed about +xR (the runner's exit, at the bar close)" from the
 *     runner's own exit record of that exact position (contract, side, opening time) when it closed the whole entry
 *     (its size: none after a scale-out), else "closed, outcome
 *     unknown", winners and losers alike: a closed trade's R is never inferred from bars (stops trail, fills slip,
 *     reads fail). Never seen open: its fills, else the runner's exit of a position opened in its window, else
 *     "outcome unknown". A decision's window runs from when it was made to when the next one on its family and side
 *     was: a position opened in it is that decision's only; one added to by another decision (a scale-in) is
 *     unknown. When the account's positions could not be read, "position state unavailable", never a stale value.
 * Only bars of the decision's trading day and contract count (the runner flattens at end of day; a roll changes
 * the prices); a decision from an earlier trading day carries its date. A setup is named only on a decision about
 * one (entered, skipped, vetoed, planned); a manage, flatten or block names the symbol its reason names. An executed cycle
 * whose journal could not be read names no setup ("details unavailable"): it is not guessed from the scan.
 * An entry from before these fields (only { at, symbols, result }) renders with what it has.
 *
 *   withPositions(history, { trades, known, now, exits, fills })   the entered entries with their real position:
 *       `trades` the open trades (open-trades.js), `known` whether the account's positions were read this cycle (a
 *       failed read closes nothing), `exits` the runner's own exit records (exitRecords), `fills` the account's
 *       fills (search_trades) since fillsNeededSince(history, now), or null when not read.
 *   exitRecords(runnerExits, runnerCloses) / appendExit(runnerExits, record)   the runner's exit records: one per
 *       position, append-only, the last EXITS_KEPT (the older one-per-contract runnerCloses read safely).
 */

const { et } = require('./session-context');
const { entryTime, contractRoot } = require('./journal');
const { tradingDayKey } = require('./clock');
const { familyRoot } = require('./contracts');

// The result line's outcome word (autotrader.js CYCLE_OUTCOMES) -> the action the history names.
const ACTIONS = { 'no-trade': 'no-trade', planned: 'planned', executed: 'entered', managed: 'managed', flattened: 'flattened', blocked: 'blocked', error: 'error' };
// The actions whose setup was not taken: what it would have done is the counterfactual.
const NOT_TAKEN = new Set(['skipped', 'vetoed', 'no-trade', 'planned']);
const REASON_CHARS = require('../tunables').runner().prompt.reasonChars; // config/runner.json prompt
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
  // The model's own composed trade (trade_lifecycle): its latest OK compose record on the bar (lifecycle-runner.js
  // recordSummary), its stop and target as distances from the bar's close (the record's entry price).
  const rec = (Array.isArray(item.composed) ? item.composed : []).filter(x => x && x.ok).at(-1);
  const close = Number(item.bar && item.bar.c);
  if (rec) return { setup: 'trade_lifecycle', side: rec.side, stop: Number.isFinite(rec.stop) && Number.isFinite(close) ? num(Math.abs(close - rec.stop)) : null, target: Number.isFinite(rec.target) && Number.isFinite(close) ? num(Math.abs(rec.target - close)) : null, why: null };
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
  return { root: e.contractId ? contractRoot(e.contractId) : null, setup: SETUP_TAG.exec(text)[1], side: sideOf(word) || sideOf(req.side), ticks: ticks(req.stopLossBracket), targetTicks: ticks(req.takeProfitBracket), orderId: e.data.result.orderId ?? e.orderId ?? null, size: Number(req.size) > 0 ? Number(req.size) : null };
}

const wordIn = (text, w) => Boolean(w) && new RegExp(`(^|[^A-Za-z0-9_])${String(w).replace(/[^A-Za-z0-9_-]/g, '')}(?![A-Za-z0-9_])`, 'i').test(text);

/**
 * Whether the cycle's phase-2 report vetoed this decision's setup (roles-ran.js: the round's phase-2 calls as the gate
 * finds them, `cycle` and the roles served from the cache `cached` deciding which risk-manager call is phase 2, never
 * phase 1; the latest of them, latestPhase2; its verdict, verdictOf). Several setups on the table (several symbols or
 * lanes): the veto is this decision's only when the report names its setup, or, naming none of the cycle's setups, its
 * symbol; a veto of another setup leaves the model's own pass on this one a pass. Never throws.
 */
function vetoedIn(output, { cycle = 'full', cached = [], setup, symbol, setups = [] } = {}) {
  if (!output) return false;
  try {
    const { roleCalls, round, latestPhase2, verdictOf } = require('./roles-ran');
    const last = latestPhase2(round(roleCalls(output), cycle, cached).p2);
    if (!last || verdictOf(last.text) !== 'VETO') return false;
    return setups.some(s => wordIn(last.text, s)) ? wordIn(last.text, setup) : wordIn(last.text, symbol);
  } catch (_err) {
    return false;
  }
}

/** The state.history entry for a cycle (see the module comment). */
function decisionEntry({ at, symbols = [], result = null, items = [], entries = [], lanes = null, journalFailed = false, positions = null, output = '', cycle = 'full', cached = [] }) {
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
  // A setup not taken: the risk manager's veto, or the model's own pass.
  const vetoed = () => vetoedIn(output, { cycle, cached, setup: setup.setup, symbol: item.symbol, setups: list.map(setupOf).filter(Boolean).map(s => s.setup) });
  const action = action0 === 'no-trade' && setup ? (vetoed() ? 'vetoed' : 'skipped') : action0;
  const same = setup && placed && setup.setup === placed.setup;
  const facts = placed
    ? { setup: placed.setup, side: placed.side || (same ? setup.side : null), stop: placed.ticks && tick ? num(placed.ticks * tick) : same ? setup.stop : null, target: placed.targetTicks && tick ? num(placed.targetTicks * tick) : same ? setup.target : null }
    // An entry with no order of its own: its setup, side and stop are not guessed from the scan.
    : setup && action0 !== 'entered' ? { setup: setup.setup, side: setup.side, stop: setup.stop, target: setup.target } : {};
  const why = setup && setup.why ? { why: String(setup.why) } : {};
  const contract = item.contractId || item.bar.contractId || null;
  // The compose records on the bar (the composed-entry design section 5): the one this decision is about (its side),
  // with its reads, each check, the signatures and the stated size; and how many compose_check calls the bar had.
  const recs = Array.isArray(item.composed) ? item.composed.filter(Boolean) : [];
  // The order's own record (the gateway stamped it at placement: item.composedOrders, order id -> record id) when it
  // placed one; else the latest for the decision's side.
  const own = placed && item.composedOrders && placed.orderId !== null && placed.orderId !== undefined ? item.composedOrders[String(placed.orderId)] : null;
  const chosen = (own && recs.find(x => x.id === own)) || recs.filter(x => !facts.side || x.side === facts.side).at(-1) || null;
  return {
    ...base, symbol: item.symbol, tf: Number(item.minutes) || null, bar: item.bar.t, price: Number(item.bar.c), tick, ...(contract ? { contract } : {}), action,
    ...Object.fromEntries(Object.entries(facts).filter(([, x]) => x !== null && x !== undefined)), ...why,
    ...(unknown ? { details: 'unavailable' } : {}),
    ...(chosen ? { composed: chosen, composeCalls: recs.length } : {}),
    ...(placed && placed.orderId !== null && placed.orderId !== undefined ? { orderId: placed.orderId } : {}),
    // Its entry order's size: a runner exit record is its R only when it closed all of it.
    ...(placed && placed.size ? { entrySize: placed.size } : {}),
    // "executed" with no successful entry order of its own in the journal (refused, or never placed): nothing is
    // credited to it ("no order of its own seen").
    ...(action === 'entered' && !placed && !journalFailed ? { noOrder: true } : {}),
    // Flat on its family when the cycle began (any position of any kind on it is not flat): its fills can be told apart.
    ...(Array.isArray(positions) && action === 'entered' && placed ? { flatAt: !positions.some(p => p && Number(p.size) > 0 && famOfId(p.contractId) === famOfId(contract || item.symbol)) } : {}),
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

/**
 * An entered trade's real position (withPositions), never measured from the decision's price, and never a guess:
 * closed with the R of its closing fills, or about the R of the runner's exit at its bar's close, else "closed,
 * outcome unknown"; a position the account read couldn't show is "state unavailable", a fill never seen
 * "outcome unknown".
 */
function tradeText(e) {
  const t = e.trade;
  if (t && t.state === 'closed') {
    if (!Number.isFinite(t.r)) return 'closed, outcome unknown';
    return t.how === 'runner' ? `closed about ${fmtR(t.r)} (the runner's exit, at the bar close)` : `closed ${fmtR(t.r)}`;
  }
  if (e.noOrder) return 'no order of its own seen: outcome unknown';
  if (e.positionRead === false) return 'position state unavailable';
  if (!t) return 'no position seen yet';
  if (t.state === 'open') return `open from ${num(t.fill)}${Number.isFinite(t.rNow) ? `, now ${fmtR(t.rNow)}` : ''}`;
  return 'no open position seen: outcome unknown';
}

// A contract's family, as the runner manages positions (runner.js famOf): a micro and its mini are one family.
const famOfId = id => { try { return familyRoot(contractRoot(id)); } catch (_err) { return String(id || '').toUpperCase(); } };

/** How many of the runner's exit records it keeps (runner.js runnerExits): enough for a day's history. */
const EXITS_KEPT = require('../tunables').runner().prompt.exitsKept;

/**
 * The runner's exit records as a list [{ contractId, side, openedAt, at, r }]: `runnerExits` (append-only, one
 * per position) and the older `runnerCloses` ({ [contractId]: { at, r, openedAt?, side? } }, one per contract),
 * read safely: a record without its position's side and opening time names no position, so it credits none.
 */
function exitRecords(runnerExits, runnerCloses) {
  const list = Array.isArray(runnerExits) ? runnerExits.filter(x => x && typeof x === 'object') : [];
  const old = runnerCloses && typeof runnerCloses === 'object' && !Array.isArray(runnerCloses)
    ? Object.entries(runnerCloses).filter(([, c]) => c && typeof c === 'object').map(([contractId, c]) => ({ contractId, ...c })) : [];
  return [...list, ...old];
}

/** Appends a runner exit record (one per position), keeping the last EXITS_KEPT. */
function appendExit(runnerExits, record) {
  return [...(Array.isArray(runnerExits) ? runnerExits : []), record].slice(-EXITS_KEPT);
}

// The record is this exact position's: its contract, side and opening time (a missing time is NaN: never equal).
// The record closed the decision's whole entry (its closed size equals the entry order's size): a record of a
// position partly closed before (a scale-out the history never saw) covers only the rest, so it is not the R.
const wholeExit = (c, h) => Number(c.size) > 0 && Number(c.size) === Number(h.entrySize);

const isPosition = (c, tr) => c.contractId === tr.contractId && c.side === tr.side
  && Date.parse(c.openedAt) === Date.parse(tr.openedAt);

// A fill's side (broker MCP interface: 0 buy, 1 sell) for a position's side: the opening side, or the closing one.
const OPEN_SIDE = { long: 0, short: 1 };
const CLOSE_SIDE = { long: 1, short: 0 };
const fillTime = f => Date.parse(f && f.creationTimestamp);
const usable = f => f && typeof f === 'object' && f.voided !== true && Number.isFinite(fillTime(f)) && Number(f.size) > 0 && Number.isFinite(Number(f.price));
const isClosing = f => f.profitAndLoss !== null && f.profitAndLoss !== undefined;
// A position with another order's fills in it (a scale-in, a manual add): no one decision's R.
const MIXED = 'mixed';
// How many fills reads a decision never seen open waits through before its outcome is final (unknown).
const UNSEEN_READS = require('../tunables').runner().prompt.unseenReads;

/**
 * The plan's 1R for a decision: its own stop distance (the entry order's stop bracket, or the setup's), else the
 * risk an open trade showed from its initial stop when first seen (open-trades.js; never one measured to a working,
 * possibly trailed, stop). Frozen once known; null when not known (its R is then unknown).
 */
function planRisk(h, prev, t) {
  if (Number(h.stop) > 0) return Number(h.stop);
  if (prev && Number(prev.risk) > 0) return Number(prev.risk);
  const fromWorking = t && Array.isArray(t.notes) && t.notes.some(n => /risk from the working stop/.test(n));
  return t && !fromWorking && Number(t.risk) > 0 ? Number(t.risk) : null;
}

/**
 * The decision's own position in the account's fills, from when it was made: the account was flat on its family
 * then (h.flatAt, read at its cycle's start); the first fill on the family after that opens it on its side, by its
 * own entry order (its id, from the successful order_placed; none: no fills are ever credited to it), within its
 * window (`until`); every opening fill after it is that same order's (another order's
 * fill is a scale-in or a manual add: MIXED); then fills of the closing side on that contract that add up to it
 * (closing it whoever sent them: the position is closed). Returns { contractId, size, fill, openedAt, exit, closedAt }
 * (exit null while not closed), MIXED, or null when it can't be told (not flat, a foreign fill first, another
 * contract of the family moving, a close larger than it).
 */
function ownTrade(h, fills, nowMs, until = Infinity) {
  const from = Date.parse(h.at);
  // Only a decision with its own successful order (its id): another order's fills are never credited to it.
  if (!Array.isArray(fills) || h.flatAt !== true || !(h.side in OPEN_SIDE) || !Number.isFinite(from) || h.orderId === undefined || h.orderId === null) return null;
  const fam = famOfId(h.contract || h.symbol);
  const list = fills.filter(f => usable(f) && famOfId(f.contractId) === fam && fillTime(f) >= from && fillTime(f) <= nowMs)
    .sort((a, b) => fillTime(a) - fillTime(b));
  const first = list[0];
  if (!first) return null;
  // Its own order opens it, inside its window (from when it was made to when the next decision on its family and
  // side was: defense in depth).
  if (String(first.orderId) !== String(h.orderId) || fillTime(first) >= until) return null;
  let size = 0;
  let notional = 0;
  let closed = 0;
  let closeNotional = 0;
  for (const f of list) {
    if (f.contractId !== first.contractId) return null;
    const n = Number(f.size);
    if (!isClosing(f) && Number(f.side) === OPEN_SIDE[h.side]) {
      if (closed > 0 || String(f.orderId) !== String(first.orderId)) return MIXED;
      size += n;
      notional += n * Number(f.price);
    } else if (isClosing(f) && Number(f.side) === CLOSE_SIDE[h.side]) {
      if (closed + n > size) return null;
      closed += n;
      closeNotional += n * Number(f.price);
      if (closed === size) return { contractId: first.contractId, size, fill: notional / size, openedAt: first.creationTimestamp, exit: closeNotional / size, closedAt: f.creationTimestamp };
    } else {
      return null;
    }
  }
  return { contractId: first.contractId, size, fill: notional / size, openedAt: first.creationTimestamp, exit: null, closedAt: null };
}

const rOf = (side, fill, exit, risk) => {
  const sign = side === 'long' ? 1 : side === 'short' ? -1 : 0;
  return sign && Number(risk) > 0 && Number.isFinite(Number(fill)) && Number.isFinite(Number(exit)) ? Math.round(sign * (Number(exit) - Number(fill)) / Number(risk) * 100) / 100 : null;
};

/**
 * A decision's position seen open (`tr`) and gone by `nowMs`: closed with the R of its own closing fills (ownTrade:
 * the same contract, opened at least at the size seen; after a scale-out every close counts, size-weighted: the R
 * per contract), from the plan's risk; else, unless it scaled out (the record is one close's), about the R of the
 * runner's own exit record of this exact position (at its bar's close); else with its outcome unknown, final once a
 * fills read couldn't tell it.
 */
function closedTrade(h, tr, exits, fills, nowMs, until = Infinity) {
  const own = tr.mixed ? MIXED : ownTrade(h, fills, nowMs, until);
  if (own === MIXED) return { ...tr, state: 'closed', r: null, how: null, mixed: true };
  const r = own && own.exit !== null && own.contractId === tr.contractId && own.size >= Number(tr.size) ? rOf(tr.side, own.fill, own.exit, tr.risk) : null;
  if (r !== null) return { ...tr, state: 'closed', r, how: 'fills' };
  const rec = tr.scaledOut ? null : exits.find(c => isPosition(c, tr) && wholeExit(c, h) && Date.parse(c.at) <= nowMs && Number.isFinite(c.r));
  if (rec) return { ...tr, state: 'closed', r: rec.r, how: 'runner' };
  return { ...tr, state: 'closed', r: null, how: null, ...(Array.isArray(fills) ? { final: true } : {}) };
}

/**
 * The earliest decision time of an entered decision of the cycle's trading day whose outcome is still to be read
 * (open, gone with no R yet and no fills read since, or never seen and still waiting): the runner reads the fills
 * since then (once a cycle), else null.
 */
function fillsNeededSince(history, now) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const day = Number.isFinite(nowMs) ? tradingDayKey(new Date(nowMs)) : null;
  const done = t => t && (t.final || t.mixed || (t.state === 'closed' && Number.isFinite(t.r)));
  const open = (history || []).filter(h => h && h.action === 'entered' && !h.noOrder && Number.isFinite(Date.parse(h.at)) && tradingDayKey(new Date(Date.parse(h.at))) === day && !done(h.trade));
  return open.length ? Math.min(...open.map(h => Date.parse(h.at))) : null;
}

/**
 * The entered entries with their real position (see the module comment); the history is otherwise unchanged.
 * `known` false (the account's positions couldn't be read): nothing is matched or closed, and every entry still
 * open reads "position state unavailable" until a read succeeds. `exits`: exitRecords; `fills`: the account's
 * fills since the earliest unresolved decision (fillsNeededSince), or null when not read.
 */
function withPositions(history, { trades = [], known = false, now, exits = [], fills = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const records = Array.isArray(exits) ? exits.filter(x => x && typeof x === 'object') : [];
  const list = (history || []).slice();
  const open = (trades || []).filter(t => t && t.contractId && Number.isFinite(Number(t.entry)))
    .sort((a, b) => (Date.parse(b.openedAt) || 0) - (Date.parse(a.openedAt) || 0));
  const claimed = new Set();
  const famOfEntry = h => famOfId(h.contract || h.symbol);
  // Each decision's window: from when it was made (its cycle's time; the order goes in during that cycle) to when
  // the next decision on the family and side (or of an unknown side) was made. A position or exit opened in it is
  // this decision's and no other's (the windows of one family and side never overlap).
  const nextAt = i => {
    const fam = famOfEntry(list[i]);
    const side = list[i].side;
    const x = list.slice(i + 1).find(y => y && y.action === 'entered' && Number.isFinite(Date.parse(y.at)) && famOfEntry(y) === fam && (!side || !y.side || y.side === side));
    return x ? Date.parse(x.at) : Infinity;
  };
  // Newest decision first: each open trade belongs to the decision whose window it opened in.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const h = list[i];
    if (!h || h.action !== 'entered' || h.noOrder || !Number.isFinite(Date.parse(h.at)) || (h.trade && (h.trade.state === 'closed' || h.trade.final))) continue;
    if (!known) { list[i] = { ...h, positionRead: false }; continue; }
    const fam = famOfEntry(h);
    const from = Date.parse(h.at);
    const until = nextAt(i);
    const t = open.find(x => !claimed.has(x) && famOfId(x.contractId) === fam && (!h.side || x.side === h.side)
      && (!x.openedAt || (Date.parse(x.openedAt) >= from && Date.parse(x.openedAt) < until))
      && (!h.trade || !h.trade.openedAt || !x.openedAt || x.openedAt === h.trade.openedAt));
    const { positionRead: _read, ...rest } = h;
    if (t) {
      claimed.add(t);
      const prev = h.trade && h.trade.state === 'open' ? h.trade : null;
      // A size that grew while open: another order's fills in it (a scale-in or a foreign add): mixed. One that
      // shrank (a scale-out, a partial close) is still its own: its fills tell its R; the runner's exit record (of
      // one close) can't.
      const last = prev ? Number(prev.cur ?? prev.size) : NaN;
      const mixed = Boolean(prev && (prev.mixed || (Number.isFinite(last) && Number(t.size) > last)));
      const scaledOut = Boolean(prev && (prev.scaledOut || (Number.isFinite(last) && Number(t.size) < last)));
      const risk = planRisk(h, prev, prev ? null : t);
      const fill = Number(t.entry);
      list[i] = { ...rest, trade: { state: 'open', contractId: t.contractId, side: t.side, size: prev && Number.isFinite(Number(prev.size)) ? Number(prev.size) : Number(t.size), fill, risk, stop: t.stop, target: t.target, rNow: Number.isFinite(Number(t.last)) && t.last !== null ? rOf(t.side, fill, t.last, risk) : null, cur: Number(t.size), openedAt: t.openedAt || null, seenAt: new Date(nowMs).toISOString(), ...(mixed ? { mixed: true } : {}), ...(scaledOut ? { scaledOut: true } : {}) } };
    } else if (h.trade && h.trade.state === 'open') {
      list[i] = { ...rest, trade: closedTrade(h, h.trade, records, fills, nowMs, until) };
    } else {
      // Never seen open: its own fills (ownTrade, closed), else about the R of the runner's exit record of a position
      // opened in its window (the runner closed it between cycles), else its outcome is unknown (a fill stopped out
      // between cycles, or not filled yet), final after UNSEEN_READS fills reads that couldn't tell it.
      const own = ownTrade(h, fills, nowMs, until);
      if (own === MIXED) { list[i] = { ...rest, trade: { state: 'closed', r: null, how: null, mixed: true } }; continue; }
      const r = own && own.exit !== null ? rOf(h.side, own.fill, own.exit, planRisk(h, null, null)) : null;
      const rec = records.find(c => famOfId(c.contractId) === fam && wholeExit(c, h) && Number.isFinite(c.r) && c.side && (!h.side || c.side === h.side)
        && Date.parse(c.openedAt) >= from && Date.parse(c.openedAt) < until && Date.parse(c.at) <= nowMs);
      const reads = ((h.trade && h.trade.reads) || 0) + (Array.isArray(fills) ? 1 : 0);
      list[i] = { ...rest, trade: r !== null ? { state: 'closed', contractId: own.contractId, side: h.side, size: own.size, fill: own.fill, openedAt: own.openedAt, r, how: 'fills' }
        : rec ? { state: 'closed', contractId: rec.contractId, side: rec.side, r: rec.r, openedAt: rec.openedAt, how: 'runner' }
          : { state: 'unknown', reads, ...(reads >= UNSEEN_READS ? { final: true } : {}) } };
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

module.exports = { ACTIONS, EXITS_KEPT, parseResult, decisionEntry, marketOf, outcome, historyLines, withPositions, exitRecords, appendExit, ownTrade, fillsNeededSince, UNSEEN_READS };
