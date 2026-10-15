'use strict';

/**
 * Labels from a replay run (the reasoning-trader design's stage 2,
 * "Actions"): every decision the reasoning model made at a decision time, per
 * symbol, mapped to the mechanical action space (entry side, stop in ATRs, size
 * as a share of the budget), with the gate's answer and the
 * trade's outcome. Model-neutral: it reads only what every replay writes.
 *
 * Read (all local, the run dir and its run home, <runDir>/../..):
 *   <runDir>/manifest.json, <runDir>/<day>.jsonl   the decision times (store.js)
 *   <runDir>/autotrader.json                         the runner config (timeframe, symbols)
 *   <home>/logs/cycles/<day>/*.json                  each cycle's context (positions, what fired) and transcript
 *   <home>/logs/gate-log.jsonl                       every order call the gate judged (hook and gateway)
 *   <home>/logs/scans-<day>.jsonl                    every scanned bar: what fired
 *   <home>/bars/<SYM>-<tf>m.json, <home>/bars-scratch/<SYM>-<tf>m*.json   bars, for ATR
 *   <runDir>/bars-<day>.jsonl.gz                     the bars the session archived (session/bars-archive.js)
 *
 * One label per decision time and symbol (one with symbol null when a line
 * names none), in time order:
 *   decision  flat | in-trade (a trade or manage cycle ran for the symbol: the teacher decided),
 *             no-cycle (a trade time with no cycle for it: not a teacher decision), kill-switch (a trade
 *             time while the run's kill switch was on: no cycle could run),
 *             housekeeping (premarket, end of day)
 *   teacher   { action: none | long | short (flat), hold | tighten | exit (in a trade), setup,
 *               stop: { ticks, points, atr, multiple (nearest of STOP_ATR_MULTIPLES), ratio },
 *               size: { contracts, riskUsd, budgetUsd, step (nearest of SIZE_STEPS), ratio }, orders }
 *   gate      { decision: allowed | refused | none | not-logged, checks } of the order behind the action
 *   outcome   the round trip the action opened (flat) or was in (in a trade), from the broker's fills
 *   clone     { ok, reasons }: what the mechanical action space can't express (limit or stop entries, a target other
 *             than the strategy's own exit as order_plan places it (teacher.target.from), several
 *             entries, adds, partial exits, unknown arguments, an unmapped stop); the skip and hold
 *             counts read its reasons (NOT_A_SKIP). A composed entry's limit at its OK compose record's entry, and
 *             that record's target (target.from 'record'), are its plan's own: never a reason (composedPlan)
 *   values / valuesAbsent / valuesError / archivedBar / archiveError   the broker field values the strategies the
 *             scan ran read on the decision bar, as the decision line recorded them ({ strategy: { path: value |
 *             null } }; R35), and that bar as the session archived it, every field kept (joined by symbol,
 *             contract, timeframe and barT). values null means: valuesAbsent, a line from before lines carried
 *             values; valuesError, taking them failed (the line's error); neither, no scan of that bar. archiveError:
 *             the day's archive can't be read, or this bar's archiving failed (the line's error); archivePruned: retention
 *             removed the day's archive (its marker left in its place); archivedBar null
 *   counterfactuals / counterfactual   what each candidate's own trade would have done (counterfactual.js:
 *             the backtester's fills and exits walked forward on the bars) on a skipped label or a no-cycle
 *             bar, or the same fields from the real fills of a taken entry; `counterfactual` is the
 *             primary one (the backtester's pick: the first candidate with a stop distance)
 *
 * Orders: the gate's log holds every place_order and modify_order (hook and gateway) and every
 * cancel_order and partial_close_position (gateway); close_position isn't gated ('ungated'), so an exit
 * by it is seen only in a transcript the cycle log parses (Claude stream-json, Codex --json, Qwen JSON,
 * opencode JSON).
 *
 * No lookahead: the stop's ATR uses only bars closed at or before t, the
 * candidates only scans logged at or before t, the position what the cycle's
 * context showed (else the fills through t). Outcomes and counterfactuals are,
 * by design, what came after, and only ever in `outcome`, `counterfactual` and
 * `counterfactuals`. Deterministic: the same files give the same labels.
 *
 *   labelRun(runDir, { budgetUsd, strategies, outcomeBars })   { labels, summary }
 *   writeLabels(runDir, { root, budgetUsd, strategies, barsFiles })   writes <runDir>/labels.jsonl and labels-summary.json; { file, summary }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../harness-run');
const { gateLogPath } = require('../trading/check-order');
const { STOP_PRICE, isRiskReducing } = require('../trading/order-gate');
const { specFor, familyRoot } = require('../trading/contracts');
const { brokerSpecFor, specMismatch } = require('../trading/broker-specs');
const { tradingDayKey, tradingDayStart, sessionMinuteOf, MARKET_OPEN_MIN, MARKET_CLOSE_MIN } = require('../trading/clock');
const { parseStandardName, readCache } = require('../broker/translator');
const { toolCalls } = require('../cycle-log');
const ind = require('../trading/indicators');
const { readRun, readLines } = require('./store');
const { versionAt } = require('../session/record');
const { archivedBars, archiveFile, wasPruned } = require('../session/bars-archive');
const { targetFor } = require('../trading/order-plan');
const { STRATEGY: COMPOSED } = require('../trading/trade-lifecycle');
const { exitPlan } = require('../trading/evaluator');
const { simulate, fromFills } = require('./counterfactual');
const { loadBars: loadDataBars, barMinutes, aggregate } = require('../backtest/data');
const { endOfDayAt } = require('../autotrader');
const { expandHome } = require('../paths');

const VERSION = 1;
const STOP_ATR_MULTIPLES = [0.5, 0.75, 1, 1.5, 2, 3];
// A stop further than this from every multiple is out of range (unmapped), never snapped to the end bucket.
const STOP_ATR_RANGE = [0.375, 4.5];
const SIZE_STEPS = [0.25, 0.5, 0.75, 1];
const ATR_PERIOD = 20; // the market features' ATR (trading/market-features.js atr20)
const ORDER_TOOL = /(?:^|__)(place_order|modify_order|cancel_order|close_position|partial_close_position)$/;
const SETUP = /^\s*setup:([a-z0-9][a-z0-9_-]*)(?:\s+(long|short|buy|sell))?\b/i;
const SIDE = { long: 'buy', buy: 'buy', short: 'sell', sell: 'sell' };
const GATE_SLACK_MS = 2000;
// Order tools neither the hook nor the gateway gates (mcp-gateway.js ORDER_TOOL): risk-reducing, never logged.
const UNGATED = new Set(['close_position']);
// A flat label with one of these reasons is no skip (nor a stand-aside, nor a hold in a trade): the teacher
// touched an order, or what it did is unknown.
const NOT_A_SKIP = new Set(['order cancel', 'working-order change', 'exit while flat', 'unattributed order', 'no cycle log', 'cycle failed', 'cycle timed out', 'working order', 'manage-only', 'paper mode', 'policy screen failed']);

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const round = (x, d = 4) => (x === null ? null : Number(x.toFixed(d)));
/**
 * The run's translator cache, read once: the broker's files in the run home (contracts-<broker>.json and, under the
 * replay clock, one per replayed day: broker/config.js contractsCacheFiles), or one file given. { root(id) } a
 * broker id's standard root (any file: ids never change), { spec(root, day) } the broker spec recorded for a root
 * (broker-specs.js brokerSpecFor): the one the trade's own replayed day recorded (`day`, YYYY-MM-DD), else the
 * live file's, else the latest day's that has one.
 */
function translatorCache(files) {
  const list = Array.isArray(files) ? files : [files];
  const ids = Object.assign({}, ...list.map(f => readCache(f).ids));
  const dayOf = f => (/\.(\d{4}-\d{2}-\d{2})\.json$/.exec(path.basename(String(f))) || [])[1] || null;
  const live = list.filter(f => !dayOf(f));
  const days = list.filter(dayOf).sort((a, b) => (dayOf(a) < dayOf(b) ? -1 : 1));
  const specs = new Map();
  const specIn = (f, root) => {
    const k = `${f}|${root}`;
    if (!specs.has(k)) specs.set(k, brokerSpecFor(f, root));
    return specs.get(k);
  };
  return {
    root: id => (Object.prototype.hasOwnProperty.call(ids, String(id ?? '')) && isObj(ids[String(id)]) ? ids[String(id)].root || null : null),
    spec: (root, day = null) => {
      const own = day ? days.filter(f => dayOf(f) === day) : [];
      return [...own, ...live, ...days.slice().reverse()].map(f => specIn(f, root)).find(Boolean) || null;
    },
  };
}

/**
 * A contract's family root (MNQ for MNQ, NQ, NQ:2026-03): a broker's own id (BT.MNQ, which the translator
 * passes through) through the run's translator cache (`cache`, translatorCache), else its standard
 * name, else the id itself upper-cased (a family no symbol has).
 */
const familyOfId = (id, cache = null) => {
  if (!id) return null;
  const known = cache ? cache.root(String(id)) : null;
  return familyRoot(known || (parseStandardName(String(id)) || { root: String(id).toUpperCase() }).root);
};
const nearest = (x, set) => set.reduce((best, s) => (Math.abs(s - x) < Math.abs(best - x) ? s : best), set[0]);
const toolName = name => (ORDER_TOOL.exec(String(name || '')) || [])[1] || null;
// The hook (place_order and modify_order) logs no tool name: an entry names a contract and a rationale, a modify neither.
const gateTool = e => toolName(e.tool) || (e.source === 'hook' ? (e.contractId || e.rationale ? 'place_order' : 'modify_order') : null);
const sideOf = s => {
  const v = String(s ?? '').toLowerCase();
  return v === '0' || v === 'buy' || v === 'bid' ? 'buy' : v === '1' || v === 'sell' || v === 'ask' ? 'sell' : null;
};
const sign = side => (side === 'buy' ? 1 : side === 'sell' ? -1 : 0);

/**
 * A contract's tick specs { tickSize, tickValue, source } from its standard name (MNQ, NQ:2026-03), else
 * the fallback's (the label's symbol): the broker's, as the run recorded them (`specsFile`, the run home's
 * contracts-<broker>.json through translatorCache: what the run's gate and sizing traded with; `day`, the trading day
 * it traded on, picks that day's), else the static table ('table').
 * The one place specs are looked up.
 */
function contractSpec(contractId, fallback = null, specsFile = null, day = null) {
  const rootOf = id => (id ? (specsFile && specsFile.root(String(id))) || (parseStandardName(String(id)) || { root: String(id).toUpperCase() }).root : null);
  for (const root of [rootOf(contractId), rootOf(fallback)].filter(Boolean)) {
    const broker = specsFile ? specsFile.spec(root, day) : null;
    const table = specFor(root);
    // As live (broker-specs.js brokerSpecs): a broker spec unlike the static table can't be trusted (live
    // refuses entries on it); measured with the table, flagged.
    if (broker && table && specMismatch(root, broker)) return { ...table, source: 'mismatch' };
    if (broker) return { tickSize: broker.tickSize, tickValue: broker.tickValue, feesPerSide: broker.feesPerSide, source: 'broker' };
    if (table) return { ...table, source: 'table' };
  }
  return null;
}

/** Every line of the run's day files that isn't JSON (a torn write), by count. */
function tornLines(runDir) {
  let n = 0;
  for (const f of fs.readdirSync(runDir).filter(x => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x))) {
    for (const line of fs.readFileSync(path.join(runDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { JSON.parse(line); } catch (_err) { n += 1; }
    }
  }
  return n;
}

/** Bars for a symbol at the runner's timeframe from the run home (the runner's file first), sorted, one per time. */
function loadBars(home, symbol, tf) {
  if (!symbol || !tf) return [];
  const byT = new Map();
  const add = file => {
    const doc = readJson(file, null);
    const bars = Array.isArray(doc) ? doc : doc && Array.isArray(doc.bars) ? doc.bars : [];
    for (const b of bars) {
      if (b && Number.isFinite(Date.parse(b.t)) && [b.h, b.l, b.c].every(Number.isFinite) && !byT.has(Date.parse(b.t))) byT.set(Date.parse(b.t), b);
    }
  };
  add(path.join(home, 'bars', `${symbol}-${tf}m.json`));
  const scratch = path.join(home, 'bars-scratch');
  let names = [];
  try { names = fs.readdirSync(scratch).filter(n => n === `${symbol}-${tf}m.json` || n.startsWith(`${symbol}-${tf}m-`)).sort(); } catch (_err) { /* none */ }
  for (const n of names) add(path.join(scratch, n));
  return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([ms, b]) => ({ ...b, ms }));
}

/**
 * ATR(20) on the bars closed at or before t (ms), or null: Wilder's, over every such bar, as the market
 * features compute it (trading/market-features.js atr20), so a label's multiple is the backtester's.
 */
function atrAt(bars, tfMs, t) {
  let hi = -1;
  for (let lo = 0, top = bars.length - 1; lo <= top;) {
    const mid = (lo + top) >> 1;
    if (bars[mid].ms + tfMs <= t) { hi = mid; lo = mid + 1; } else top = mid - 1;
  }
  if (hi + 1 < ATR_PERIOD) return null;
  const a = ind.atr(bars.slice(0, hi + 1), ATR_PERIOD);
  const v = a[a.length - 1];
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The cycle file of a summary, read from the run home (its logs/cycles/ path re-based there), never from elsewhere. */
function cycleFile(home, file) {
  if (!file) return null;
  const s = String(file).split(path.sep).join('/');
  const i = s.lastIndexOf('logs/cycles/');
  const doc = i === -1 ? null : readJson(path.join(home, s.slice(i)), null);
  return isObj(doc) ? doc : null;
}

const relCycle = (home, file) => {
  if (!file) return null;
  const s = String(file).split(path.sep).join('/');
  const i = s.lastIndexOf('logs/cycles/');
  return i === -1 ? path.basename(s) : s.slice(i);
};

/**
 * Round trips from the broker's fills (store lines' trades), per contract family: an opening fill
 * (profitAndLoss null) opens or adds; a closing fill closes; done when the closed size reaches the
 * opened size. A closing fill with nothing open (a position from before the run) is a round trip
 * whose opening is unknown.
 */
function roundTrips(fills, cache = null) {
  const open = new Map();
  const out = [];
  for (const f of fills) {
    const fam = familyOfId(f.contractId, cache);
    const size = Math.abs(Number(f.size)) || 1;
    if (f.profitAndLoss === null || f.profitAndLoss === undefined) {
      let rt = open.get(fam);
      if (!rt) {
        rt = { family: fam, contractId: f.contractId, side: sideOf(f.side ?? f.sideName), openMs: f.ms, opens: [], closes: [], openSize: 0, closedSize: 0, closeMs: null };
        open.set(fam, rt);
        out.push(rt);
      }
      rt.opens.push(f);
      rt.openSize += size;
      continue;
    }
    let rt = open.get(fam);
    if (!rt) {
      const s = sideOf(f.side ?? f.sideName);
      rt = { family: fam, contractId: f.contractId, side: s ? (s === 'buy' ? 'sell' : 'buy') : null, openMs: null, opens: [], closes: [], openSize: size, closedSize: 0, closeMs: null };
      out.push(rt);
    }
    rt.closes.push(f);
    rt.closedSize += size;
    if (rt.closedSize >= rt.openSize) {
      rt.closeMs = f.ms;
      open.delete(fam);
    } else open.set(fam, rt);
  }
  return out;
}

/** The outcome of a round trip: P&L, R from the initial stop, MAE/MFE in R (the broker's when it sends them). */
function outcomeOf(rt, stopTicks, specsFile = null) {
  if (!rt) return null;
  const first = rt.opens[0] || null;
  const entry = first && first.entry && typeof first.entry === 'object' ? first.entry : {};
  const spec = contractSpec(rt.contractId, null, specsFile, num(rt.openMs ?? rt.closeMs) !== null ? tradingDayKey(new Date(rt.openMs ?? rt.closeMs)) : null) || {};
  const ticks = num(entry.stopTicks) || num(stopTicks);
  const tickValue = num(entry.tickValue) || num(spec.tickValue);
  const risk = ticks && tickValue ? ticks * tickValue * (rt.openSize || 1) : null;
  const pnl = rt.closes.reduce((a, f) => a + (Number(f.profitAndLoss) || 0), 0);
  const fees = [...rt.opens, ...rt.closes].reduce((a, f) => a + (Number(f.fees) || 0), 0);
  const rts = rt.closes.map(f => (f.roundTrip && typeof f.roundTrip === 'object' ? f.roundTrip : null)).filter(Boolean);
  const one = rts.length === 1 && rt.closes.length === 1 ? rts[0] : null;
  const last = rt.closes[rt.closes.length - 1] || null;
  const closed = rt.closeMs !== null;
  const net = closed ? (one && num(one.net) !== null ? one.net : pnl - fees) : null;
  const r = closed ? (one && num(one.r) !== null ? one.r : risk ? pnl / risk : null) : null;
  const pick = key => (one && num(one[key]) !== null ? one[key] : last && num(last[key]) !== null ? last[key] : null);
  return {
    filled: true, openKnown: Boolean(first), entryTime: first ? first.creationTimestamp : null, entryPrice: first ? num(Number(first.price)) : null,
    side: rt.side, size: rt.openSize, setup: entry.setup || null,
    exitTime: closed ? last.creationTimestamp : null, exitPrice: closed ? num(Number(last.price)) : null,
    exitReason: closed ? (one && one.reason) || null : null,
    pnl: closed ? round(pnl, 2) : null, fees: round(fees, 2), net: round(net, 2), r: round(r),
    maeR: closed ? round(pick('maeR')) : null, mfeR: closed ? round(pick('mfeR')) : null,
    result: !closed ? 'open' : net > 0 ? 'win' : net < 0 ? 'loss' : 'scratch',
  };
}

/** An order the teacher sent, from the gate's record and (when the transcript names it) its arguments. */
function normalizeOrder(tool, args, gate) {
  const a = args || {};
  const rationale = String(a.rationale ?? (gate && gate.rationale) ?? '');
  const m = SETUP.exec(rationale);
  const side = sideOf(a.side) || (m && m[2] ? SIDE[m[2].toLowerCase()] : null);
  const stop = STOP_PRICE.exec(rationale);
  return {
    tool, contractId: a.contractId ?? (gate && gate.contractId) ?? null, side,
    type: a.type !== undefined ? String(a.type).toLowerCase() : null, size: num(Number(a.size)) || null,
    stopTicks: a.stopLossBracket && num(Number(a.stopLossBracket.ticks)) > 0 ? Number(a.stopLossBracket.ticks) : null,
    targetTicks: a.takeProfitBracket && num(Number(a.takeProfitBracket.ticks)) > 0 ? Number(a.takeProfitBracket.ticks) : null,
    limitPrice: num(Number(a.limitPrice ?? NaN)), stopPrice: num(Number(a.stopPrice ?? NaN)), trailPrice: num(Number(a.trailPrice ?? NaN)),
    rationaleStop: stop ? Number(stop[1].replace(/,/g, '')) : null,
    setup: m ? m[1].toLowerCase() : null, riskReducing: isRiskReducing(rationale), rationale: rationale || null,
    argsKnown: Boolean(args),
    broker: { decision: 'unknown', orderId: null, reason: null },
    gate: gate ? { decision: gate.decision === 'allowed' ? 'allowed' : 'refused', source: gate.source || null, checks: (gate.violations || []).map(v => v.check) }
      // close_position is never gated (it only reduces risk): no record is expected.
      : { decision: UNGATED.has(tool) ? 'ungated' : 'not-logged', source: null, checks: [] },
    orderId: a.orderId !== undefined && a.orderId !== null ? a.orderId : null,
  };
}

const PAIR_MS = 1000;
// The order tracker's own refusals after the gate allowed the call (order-tracker.js beforeSend,
// order-markers.js prepareSend), told from the gate's own order-pending (markers.pendingMessage) by message.
const TRACKER_REFUSAL = /^(customTag .* is in use by an order of unknown outcome|The gateway could not record the order before sending it|place_order needs an accountId)/;
/**
 * One place_order can leave two gateway records: allowed by the gate, then blocked when the gateway's
 * order tracker refuses to send it (mcp-gateway.js). Such a pair (same tool, contract and rationale,
 * the block the tracker's own refusal, within PAIR_MS) is one refused order: the allowed record is dropped.
 * Any other block after an allowed record is another call (a retry), kept.
 */
function collapsePairs(records) {
  const drop = new Set();
  records.forEach((b, i) => {
    const vs = Array.isArray(b.violations) ? b.violations.filter(isObj) : [];
    if (b.source !== 'gateway' || b.decision !== 'blocked' || vs.length !== 1 || !TRACKER_REFUSAL.test(String(vs[0].message || ''))) return;
    for (let j = i - 1; j >= 0; j -= 1) {
      const a = records[j];
      if (drop.has(a) || a.source !== 'gateway' || a.decision !== 'allowed') continue;
      if (gateTool(a) === gateTool(b) && String(a.contractId ?? '') === String(b.contractId ?? '') && String(a.rationale ?? '') === String(b.rationale ?? '') && b.ms - a.ms <= PAIR_MS) {
        drop.add(a);
        break;
      }
    }
  });
  return records.filter(r => !drop.has(r));
}

/** A cycle's order calls: the gate's records in its window, joined in order to the transcript's calls. */
function cycleOrders(c, doc, gateLog, untilMs) {
  // The cycle's own window: from its start (the gate can't judge its calls before), to its end plus a
  // little slack for the log write, never into the next cycle's.
  const from = Date.parse(c.at);
  const to = Math.min(Number.isFinite(c.durationMs) ? from + c.durationMs + GATE_SLACK_MS : Infinity, untilMs);
  const gates = collapsePairs(gateLog.filter(e => gateTool(e) && e.ms >= from && e.ms < to));
  for (const e of gateLog) if (e.ms >= from && e.ms < to) e.inCycle = true;
  const calls = doc ? toolCalls(doc.transcript || '').filter(x => toolName(x.name) && !x.stopped).map((x, at) => ({ tool: toolName(x.name), input: x.input, failed: Boolean(x.failed), error: x.error || '', used: false, at })) : [];
  const out = gates.map(g => {
    const tool = gateTool(g);
    const call = calls.find(x => !x.used && x.tool === tool && String(x.input.rationale ?? '') === String(g.rationale ?? '')
      && (!x.input.contractId || !g.contractId || String(x.input.contractId) === String(g.contractId)));
    if (call) call.used = true;
    return { order: { ...normalizeOrder(tool, call ? call.input : null, g), callFailed: Boolean(call && call.failed), callError: call && call.failed ? call.error || '' : null }, at: call ? call.at : null };
  });
  // A call no gate record names (close_position, ungated) goes in transcript order: before the first gated
  // order the transcript shows after it, so "the last" exit is the last the teacher sent.
  for (const x of calls.filter(y => !y.used)) {
    const i = out.findIndex(e => e.at !== null && e.at > x.at);
    const item = { order: { ...normalizeOrder(x.tool, x.input, null), callFailed: Boolean(x.failed), callError: x.failed ? x.error || '' : null }, at: x.at };
    if (i === -1) out.push(item); else out.splice(i, 0, item);
  }
  return out.map(e => e.order);
}

/** The position in a family at t: from the cycle's context (what the teacher saw), else the fills through t. */
function positionAt(fam, ctx, fills, t, cache = null) {
  const acct = ctx && ctx.account;
  if (acct && Array.isArray(acct.positions)) {
    const net = acct.positions.filter(p => familyOfId(p.contractId, cache) === fam)
      .reduce((n, p) => n + (p.side === 'long' ? 1 : p.side === 'short' ? -1 : 0) * (Math.abs(Number(p.size)) || 1), 0);
    return { side: net > 0 ? 'long' : net < 0 ? 'short' : null, size: Math.abs(net), source: 'context' };
  }
  // Fills alone: opening fills add their side, closing fills take it off; a position from before the run is unseen.
  let net = 0;
  for (const f of fills) {
    if (f.ms > t || familyOfId(f.contractId, cache) !== fam) continue;
    const size = Math.abs(Number(f.size)) || 1;
    const s = sign(sideOf(f.side ?? f.sideName));
    net += f.profitAndLoss === null || f.profitAndLoss === undefined ? s * size : (net !== 0 ? s * Math.min(size, Math.abs(net)) : 0);
  }
  return { side: net > 0 ? 'long' : net < 0 ? 'short' : null, size: Math.abs(net), source: 'fills' };
}

/**
 * The budget a new trade may risk: the caller's (--budget). A prop attempt's budget (combine.budget) needs
 * the attempt's whole state at t (peak, days, sessions left, daily limit) and the policy strategy's sizing,
 * which the run doesn't record per decision, so without --budget the size step is unknown (null, counted).
 */
function budgetFor(budgetUsd) {
  return num(budgetUsd) > 0 ? budgetUsd : null;
}

/**
 * The runner's line for a symbol whose policy screen failed (runner.js policyFailed): "<SYMBOL> policy screen
 * (<why>): no verdict, so no entry for <a, b | its strategies> this bar". { names } the strategies that lost
 * their entry, names null when the line doesn't name them; null when the screen didn't fail.
 */
const SCREEN_NAMES = ': no verdict, so no entry for ';
function screenFailed(ctx, symbol) {
  const line = symbol && ctx && Array.isArray(ctx.unavailable) ? ctx.unavailable.map(String).find(u => u.startsWith(`${symbol} policy screen (`)) : null;
  if (!line) return null;
  const i = line.lastIndexOf(SCREEN_NAMES);
  const list = i !== -1 && line.endsWith(' this bar') ? line.slice(i + SCREEN_NAMES.length, -' this bar'.length) : '';
  const names = list && list !== 'its strategies' ? list.split(', ').map(x => x.trim()).filter(Boolean) : [];
  return { names: names.length ? names : null };
}

/** Who refused an order: 'gate', 'broker', or null (it went through, or its fate is unknown). */
const refusedBy = o => (o.gate.decision === 'refused' ? 'gate' : o.broker && o.broker.decision === 'refused' ? o.broker.by || 'broker' : null);
// A call another PreToolUse hook blocked (not the order gate's: it logs its own) never reached the broker.
const HOOK_BLOCK = /\bhook\b/i;
// The client gave up waiting (the broker may still have acted): the outcome is unknown, not a refusal.
const CLIENT_TIMEOUT = /\btimed out\b|\btimeout\b/i;
// A closing fill a bracket made (the backtester's round-trip reason): not a close the teacher sent.
const BRACKET_EXIT = /^(stop|target|trail)$/i;
const failedCall = o => (!HOOK_BLOCK.test(o.callError || '') && CLIENT_TIMEOUT.test(o.callError || '') ? { decision: 'unknown', orderId: null, reason: o.callError, timeout: true } : callRefusal(o));
// A gated tool's call with no gate record never reached the gateway (which logs every call it judges): the
// client refused it (a permission denial, a server not connected), not the broker.
const callRefusal = o => ({ decision: 'refused', orderId: null, reason: o.callError || 'the call returned an error',
  ...(HOOK_BLOCK.test(o.callError || '') ? { by: 'hook' } : o.gate.decision === 'not-logged' ? { by: 'client' } : {}) });

/**
 * The entry order a flat decision counts (of its place_order entries): the last the broker accepted, else the last the
 * gate let through and the broker didn't refuse, else the last sent; null for none.
 */
function countedEntry(orders) {
  const entries = (orders || []).filter(o => isObj(o) && o.tool === 'place_order' && !o.riskReducing);
  const through = entries.filter(x => !isObj(x.gate) || !refusedBy(x));
  const accepted = through.filter(x => x.broker && x.broker.decision === 'accepted');
  return accepted.length ? accepted[accepted.length - 1] : through.length ? through[through.length - 1] : entries[entries.length - 1] || null;
}

/** The teacher's action for one symbol from its orders, and what the mechanical action space can't express. */
function teacherAction(orders, inTrade) {
  const reasons = [];
  const entries = orders.filter(o => o.tool === 'place_order' && !o.riskReducing);
  const cancels = orders.filter(o => o.tool === 'cancel_order');
  if (cancels.length) reasons.push('order cancel');
  if (!inTrade) {
    // Flat, a modify moves a working order (a resting entry): a decision the mechanical action space can't express, never a skip.
    if (orders.some(o => o.tool === 'modify_order')) reasons.push('working-order change');
    // Flat, an exit or a protective order (the teacher saw a position the account read didn't): no skip.
    if (orders.some(o => o.tool === 'close_position' || o.tool === 'partial_close_position' || (o.tool === 'place_order' && o.riskReducing))) reasons.push('exit while flat');
    if (!entries.length) return { action: 'none', order: null, reasons, priorRefusals: 0 };
    // The entry that counts: the last one the broker accepted, else the last one the gate let through and
    // the broker didn't refuse, else the last one sent. Refused tries before it (by the gate or the broker)
    // are one decision with it, counted in priorRefusals; only several entries that went through are "several".
    const through = entries.filter(x => !refusedBy(x));
    const o = countedEntry(entries);
    const priorRefusals = entries.filter(x => x !== o && refusedBy(x)).length;
    if (through.length > 1) reasons.push('several entries');
    if (!o.argsKnown) reasons.push('order arguments unknown');
    else if (o.type !== 'market') reasons.push(`${o.type || 'unknown'} entry`);
    if (o.targetTicks) reasons.push('explicit target');
    if (!o.side) reasons.push('direction unknown');
    return { action: o.side === 'buy' ? 'long' : o.side === 'sell' ? 'short' : null, order: o, reasons, priorRefusals };
  }
  if (entries.length) reasons.push('entry while in a trade');
  const exits = orders.filter(o => o.tool === 'close_position' || o.tool === 'partial_close_position' || (o.tool === 'place_order' && /^\s*\[exit\]/i.test(o.rationale || '')));
  // As for entries: the last one that went through (a refused try, then a retry, is one decision), else the last sent.
  const pick = list => {
    const through = list.filter(x => !refusedBy(x));
    const o = through.length ? through[through.length - 1] : list[list.length - 1];
    return { o, priorRefusals: list.filter(x => x !== o && refusedBy(x)).length };
  };
  if (exits.length) {
    if (exits.some(o => o.tool === 'partial_close_position')) reasons.push('partial exit');
    const { o, priorRefusals } = pick(exits);
    return { action: 'exit', order: o, reasons, priorRefusals };
  }
  const tightens = orders.filter(o => (o.tool === 'modify_order' && (!o.argsKnown || o.stopPrice !== null || o.trailPrice !== null))
    || (o.tool === 'place_order' && /^\s*\[protect\]/i.test(o.rationale || '')));
  if (tightens.length) {
    if (tightens.some(o => !o.argsKnown)) reasons.push('order arguments unknown');
    // Never widen a stop (rules/trading/risk-management.md): against the working stop the teacher saw.
    // Step by step: each modify against the stop the one before it left (one refused leaves it as it was).
    let stop = inTrade.side && Number.isFinite(inTrade.stop) ? inTrade.stop : null;
    for (const o of tightens.filter(x => x.tool === 'modify_order' && x.argsKnown)) {
      const next = o.stopPrice ?? o.trailPrice;
      if (stop === null || next === null) reasons.push('stop change unknown');
      else if ((inTrade.side === 'long' ? 1 : -1) * (next - stop) < 0) reasons.push('stop widened');
      if (next !== null && !refusedBy(o)) stop = next;
    }
    const { o, priorRefusals } = pick(tightens);
    return { action: 'tighten', order: o, reasons, priorRefusals };
  }
  if (orders.some(o => o.tool === 'modify_order')) reasons.push('target change');
  return { action: 'hold', order: null, reasons };
}

/**
 * The setup tags a composed entry on a symbol's bar goes under (the gate's composedName): the composed strategy, each
 * strategy of signal composed, and each policy whose latest verdict on that bar and family trades a composed component.
 */
function composedTagsAt(strategies, verdicts, symbol, barT) {
  const valid = (strategies || []).filter(s => isObj(s) && s.name && s.valid !== false);
  const names = new Set([COMPOSED, ...valid.filter(s => s.signal === 'composed').map(s => s.name)]);
  const policies = new Set(valid.filter(s => s.signal === 'policy').map(s => s.name));
  const bar = Date.parse(barT);
  const fam = familyOfId(symbol);
  const latest = new Map();
  for (const v of verdicts || []) {
    if (isObj(v) && policies.has(v.strategy) && Number.isFinite(bar) && Date.parse(v.bar) === bar && fam && familyOfId(v.symbol || v.contract) === fam) latest.set(v.strategy, v);
  }
  return new Set([...names, ...[...latest.values()].filter(v => names.has(v.component)).map(v => v.strategy)]);
}

/**
 * A composed entry's own plan (the composed-entry design, section 5): the cycle's latest compose record (the cycle log's
 * `composed`, lifecycle-runner.js recordSummary) on the entry's family, bar and side, when OK, for an order under a
 * composed tag (trade_lifecycle, or a strategy or policy composedSetups names), on the record's contract. `limit`: the
 * order is a limit at the record's entry price or better for its side (as the gate allows it); `target`: its target bracket is the record's target ticks. Each is then the plan's own, never a
 * clone reason. null when the order is no composed entry or no OK record backs it.
 */
function composedPlan(o, side, records, { fam, barT, tags, root = null }) {
  if (!o || (o.setup !== COMPOSED && !tags.has(o.setup)) || (side !== 'long' && side !== 'short')) return null;
  const bar = Date.parse(barT);
  // The bar exactly, as the gate's recordsAt: a record with none (a refused call) is on no bar.
  const mine = (Array.isArray(records) ? records : []).filter(r => isObj(r) && r.side === side
    && (!r.symbol || familyOfId(r.symbol) === fam) && Number.isFinite(bar) && Date.parse(r.bar) === bar);
  const rec = mine[mine.length - 1];
  // The latest on the family and side is the one the gate judges; on another contract of the family it backs nothing.
  const sym = rec ? rec.symbol || rec.contract : null;
  if (!rec || rec.ok !== true || (root && String(sym || '').toUpperCase() !== root)) return null;
  const tick = num(rec.tick);
  const entry = num(rec.entry);
  const target = num(rec.target);
  // At the record's entry or better for the side (the gate's limitRefusal): a long's at or below it, a short's at or above.
  const atOrBetter = p => p !== null && entry !== null && (side === 'long' ? p <= entry + 1e-9 : p >= entry - 1e-9);
  const targetTicks = entry !== null && target !== null && tick > 0 ? Math.round(Math.abs(target - entry) / tick) : null;
  return { record: rec.id || null, limit: o.type === 'limit' && atOrBetter(o.limitPrice), target: o.targetTicks !== null && o.targetTicks === targetTicks };
}

/** The stop of an entry in ticks, points and the nearest ATR multiple (ATR from bars closed by t). */
function stopOf(o, spec, refPrice, atr) {
  if (!o) return null;
  const tick = spec && spec.tickSize;
  let points = null;
  let ticks = null;
  if (o.stopTicks && tick) { ticks = o.stopTicks; points = ticks * tick; } else if (o.rationaleStop !== null) {
    const ref = o.type === 'limit' && o.limitPrice !== null ? o.limitPrice : o.type === 'stop' && o.stopPrice !== null ? o.stopPrice : refPrice;
    const dist = ref !== null ? (ref - o.rationaleStop) * sign(o.side) : null;
    if (dist > 0 && tick) { points = dist; ticks = Math.round(dist / tick); }
  }
  const ratio = points !== null && atr ? points / atr : null;
  const outOfRange = ratio !== null && (ratio < STOP_ATR_RANGE[0] || ratio > STOP_ATR_RANGE[1]);
  return { ticks, points: round(points), atr: round(atr), ratio: round(ratio), multiple: ratio === null || outOfRange ? null : nearest(ratio, STOP_ATR_MULTIPLES), outOfRange };
}

function sizeOf(o, spec, stop, budget) {
  if (!o) return null;
  const riskUsd = o.size && stop && stop.ticks && spec ? o.size * stop.ticks * spec.tickValue : null;
  const ratio = riskUsd !== null && budget ? riskUsd / budget : null;
  return { contracts: o.size, riskUsd: round(riskUsd, 2), budgetUsd: budget, ratio: round(ratio), step: ratio === null ? null : nearest(ratio, SIZE_STEPS), overBudget: ratio !== null && ratio > 1 };
}

/** Fills from every line, in time order, once each (voided ones dropped). */
function allFills(lines) {
  const seen = new Set();
  const out = [];
  for (const rec of lines) {
    for (const f of Array.isArray(rec.trades) ? rec.trades : []) {
      if (!f || f.voided || !Number.isFinite(Date.parse(f.creationTimestamp))) continue;
      const key = f.id !== undefined && f.id !== null ? `id:${f.id}` : JSON.stringify(f);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...f, ms: Date.parse(f.creationTimestamp) });
    }
  }
  return out.sort((a, b) => a.ms - b.ms || String(a.id ?? '').localeCompare(String(b.id ?? ''), 'en', { numeric: true }));
}

function readText(file) {
  try {
    return file ? fs.readFileSync(file, 'utf8') : null;
  } catch (_err) {
    return null;
  }
}

/** sha256 of the strategies the counterfactuals used: each one's file, else its object (name order). */
function hashStrategies(strategies) {
  const h = crypto.createHash('sha256');
  for (const x of [...(strategies || [])].filter(y => y && y.name).sort((a, b) => a.name.localeCompare(b.name))) {
    const text = readText(x.file);
    h.update(`${x.name}\n${text ?? JSON.stringify({ risk: x.risk, exit: x.exit, signal: x.signal })}\n`);
  }
  return h.digest('hex');
}

/** The target ticks order_plan places for a strategy's setup with this stop, or null (none, or no level distance). */
function plannedTarget(strategy, stopTicks, targetDistance, tickSize) {
  try {
    return targetFor(exitPlan(strategy), stopTicks, targetDistance, tickSize).ticks;
  } catch (_err) {
    return null;
  }
}

/** The end of day (ms) of t's trading day, as the runner and the replay schedule place it. */
function eodOf(cfg, t) {
  const c = { eodAt: '15:50@America/New_York', earlyCloseEodAt: null, ...cfg, earlyCloseDates: Array.isArray(cfg.earlyCloseDates) ? cfg.earlyCloseDates : [] };
  const start = tradingDayStart(new Date(t));
  const at = endOfDayAt(c, new Date(start.getTime() + 12 * 3600000));
  return at ? start.getTime() + sessionMinuteOf(at, start) * 60000 : start.getTime() + (MARKET_CLOSE_MIN - MARKET_OPEN_MIN + 24 * 60) * 60000;
}

/**
 * The runner config in force at each decision time: a live session restarted on another config names each
 * version's file (manifest.versions[].config, session/live.js); a run without them has one, autotrader.json.
 */
function configsOf(dir, manifest) {
  const base = readJson(path.join(dir, 'autotrader.json'), {}) || {};
  if (!(Array.isArray(manifest.versions) && manifest.versions.some(v => v && v.config))) return () => base;
  const files = new Map();
  return t => {
    const v = versionAt(manifest, t);
    const name = v && typeof v.config === 'string' ? v.config : null;
    if (!name || name === 'autotrader.json' || !/^autotrader-[A-Za-z0-9-]+\.json$/.test(name)) return base;
    if (!files.has(name)) files.set(name, readJson(path.join(dir, name), null) || base);
    return files.get(name);
  };
}

/** Why a run isn't finished (a step pending, a day not done), or null. */
function unfinishedWhy(manifest, days) {
  const open = Object.keys(days).filter(d => !(manifest.daysDone || []).includes(d));
  if (manifest.pending) return `a step at ${manifest.pending.t} was interrupted`;
  // A decision time whose cycle failed, still to run again (replay/driver.js).
  if (manifest.cycleRetry) return `the cycle at ${manifest.cycleRetry.t} failed and that time is still to run again`;
  // A live session whose end-of-day fills read failed (session/live.js): the runner retries it.
  if (manifest.fillsPending) return `the day's fills are not recorded yet (the broker's read at ${manifest.fillsPending.t} failed; the runner retries it)`;
  if (open.length) return `day ${open[0]} is not done`;
  // The driver marks a run finished when it ran every decision time to the run's end (driver.js): a stop
  // at a day's boundary (--max-cycles, the kill switch, the error limit) leaves every day done but not the run.
  return manifest.finished === true ? null : 'the driver has not finished the run (it stopped before the run\'s end)';
}

/**
 * The broker's own record of each order (the replay broker's journal, BROKER-MCP-INTERFACE: order_placed
 * with its result, order_blocked by its guardrails), at the replayed time: [{ ms, family, rationale, accepted, orderId, reason }].
 * The journal names the broker's own contract id: its family comes from the run home's translator cache
 * (or a standard name), null when unknown.
 */
function brokerOrders(file, familyOfBrokerId = () => null) {
  return readLines(file).filter(isObj).filter(e => e.kind === 'order_placed' || e.kind === 'order_blocked').map(e => {
    const result = isObj(e.data) && isObj(e.data.result) ? e.data.result : {};
    const text = String(e.text || '');
    const cut = text.indexOf(' | rationale: ');
    const placed = e.kind === 'order_placed';
    return {
      ms: Date.parse(e.ts), family: familyOfBrokerId(e.contractId), rationale: placed ? text : cut === -1 ? null : text.slice(cut + ' | rationale: '.length),
      accepted: placed && result.success === true, orderId: placed && result.orderId !== undefined ? result.orderId : null,
      reason: placed ? (result.success === true ? null : result.errorMessage || result.errorName || 'refused') : (cut === -1 ? text : text.slice(0, cut)),
    };
  }).filter(e => Number.isFinite(e.ms));
}

/** A run dir as stored (symlinks resolved), so its run home is the real one two levels up. */
function realDir(runDir) {
  try {
    return fs.realpathSync.native(path.resolve(runDir));
  } catch (_err) {
    return path.resolve(runDir);
  }
}

/**
 * @param opts.budgetUsd the dollars a trade may risk (size steps); null: the step is unknown
 * @param opts.strategies loaded STRATEGY.md objects (their exits, for the counterfactuals)
 * @param opts.outcomeBars { SYMBOL: bars } the data the run replayed: the counterfactuals walk it, the stop's
 *   ATR reads its bars closed by t; else the run home's bars
 * @param opts.barsSource { SYMBOL: sha256 } of the --bars files, for provenance (else 'run home')
 * @param opts.unfinished label a run that isn't finished (writeLabels allows it only into a folder outside the run home)
 */
function labelRun(runDir, { budgetUsd = null, strategies = [], outcomeBars = null, unfinished = false, barsSource = null, log = msg => process.stderr.write(`[labels] ${msg}\n`) } = {}) {
  const dir = realDir(runDir);
  const { manifest, days } = readRun(dir);
  // Labels hold what came after each decision (outcomes, counterfactuals). A run that will go on would let
  // its teacher read them on resume (the run home is its harness home): only a finished run is labelled in place.
  const why = unfinishedWhy(manifest, days);
  if (why && !unfinished) {
    throw new Error(`run ${manifest.runId} is not finished (${why}): run it to its end first, or write the labels outside the run home with --out <dir> (labels hold what came after each decision, which a resumed teacher could read)`);
  }
  const home = path.resolve(dir, '..', '..');
  // The runner config at each line's time (its timeframe, paper mode and symbols): a live session's can change mid-day.
  const cfgAt = configsOf(dir, manifest);
  const tfOf = c => Number(c.timeframe) || null;
  const tfMsOf = c => (tfOf(c) ? tfOf(c) * 60000 : 0);
  // A strategy's status: the scan's, else the caller's strategies' (unknown: kept).
  const statusOf = new Map((strategies || []).filter(x => x && x.name).map(x => [x.name, x.status]));
  const tradeable = (r, c) => {
    const status = r.status ?? statusOf.get(r.name);
    return Boolean(c.paper) || status === undefined || status === null || status === 'active';
  };
  // Malformed lines (null, arrays, numbers) are skipped wherever a record is read.
  const objs = xs => (Array.isArray(xs) ? xs.filter(isObj) : []);
  const lines = Object.keys(days).sort().flatMap(d => days[d]).filter(r => isObj(r) && Number.isFinite(Date.parse(r.t)))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    .map(r => ({ ...r, cycles: objs(r.cycles), ran: objs(r.ran), bars: objs(r.bars) }));
  const gateLog = readLines(gateLogPath({ FTH_HOME: home })).filter(isObj).map(e => ({ ...e, ms: Date.parse(e.ts) })).filter(e => Number.isFinite(e.ms));
  const scans = new Map();
  let scanFiles = [];
  try { scanFiles = fs.readdirSync(path.join(home, 'logs')).filter(n => /^scans-.*\.jsonl$/.test(n)).sort(); } catch (_err) { /* none */ }
  for (const f of scanFiles) {
    for (const s of readLines(path.join(home, 'logs', f))) {
      if (!isObj(s) || !isObj(s.bar) || !s.symbol) continue;
      const k = `${s.symbol}|${s.bar.t}`;
      if (!scans.has(k)) scans.set(k, []);
      scans.get(k).push(s);
    }
  }
  const barsBySym = new Map();
  const barsFor = (sym, tf) => {
    const k = `${sym}|${tf}`;
    if (!barsBySym.has(k)) barsBySym.set(k, loadBars(home, sym, tf));
    return barsBySym.get(k);
  };
  const fills = allFills(lines);
  const cycleStarts = lines.flatMap(r => (r.cycles || []).map(c => Date.parse(c.at))).filter(Number.isFinite).sort((a, b) => a - b);
  const contractCache = translatorCache(require('../broker/config').contractsCacheFiles(manifest.broker || '', { FTH_HOME: home }));
  const trips = roundTrips(fills, contractCache);
  const journal = brokerOrders(path.join(dir, 'broker', 'journal.jsonl'), id => {
    const root = id ? contractCache.root(id) || (parseStandardName(String(id)) || {}).root : null;
    return root ? familyRoot(root) : null;
  });
  const journalUsed = new Set();
  const lineTimes = lines.map(r => Date.parse(r.t));
  // The bars the session archived (R35), by symbol, timeframe and time.
  const archived = archivedBars(dir, { log });
  /** The line's values entry for the symbol's decision bar (its strategies' values and contract), or null. */
  const recordedValues = (rec, symbol, barT) => {
    if (!Array.isArray(rec.values)) return null;
    const v = rec.values.find(x => isObj(x) && x.symbol === symbol && (!barT || !x.barT || x.barT === barT));
    return v && isObj(v.strategies) ? v : null;
  };

  // Pass 1: every decision's orders and action.
  const drafts = [];
  for (const [li, rec] of lines.entries()) {
    const t = Date.parse(rec.t);
    const cfg = cfgAt(rec.t);
    const nextT = lineTimes.find((x, k) => k > li && x > t) ?? Infinity;
    const tradeCycles = [];
    for (const [i, c] of (rec.cycles || []).entries()) {
      if (c.action !== 'trade' && c.action !== 'manage') continue;
      const doc = cycleFile(home, c.file);
      const ctx = doc && doc.context ? doc.context : null;
      const start = Date.parse(c.at);
      const until = cycleStarts.find(x => x > start) ?? Infinity;
      const ran = (rec.ran || []).filter(x => x.action === c.action)[(rec.cycles || []).slice(0, i).filter(x => x.action === c.action).length] || null;
      const failed = c.timedOut || (ran && ran.timedOut) ? 'cycle timed out' : c.ok === false || (ran && ran.ok === false) ? 'cycle failed' : null;
      tradeCycles.push({ c, ctx, failed, action: c.action, orders: Number.isFinite(start) ? cycleOrders(c, doc, gateLog, until) : [], result: c.result || (ran && ran.result) || null, symbols: ctx && Array.isArray(ctx.symbols) ? objs(ctx.symbols).map(s => s.symbol) : null, composed: doc ? objs(doc.composed) : [] });
    }
    // A cycle that ran with no cycle log line: a decision whose orders are unknown.
    const ranTrade = (rec.ran || []).filter(x => x.action === 'trade' || x.action === 'manage');
    for (const x of ranTrade.slice(tradeCycles.length)) {
      const failed = x.timedOut ? 'cycle timed out' : x.ok === false ? 'cycle failed' : null;
      tradeCycles.push({ c: null, ctx: null, failed, action: x.action, orders: [], unknown: true, result: x.result || null, symbols: Array.isArray(x.symbols) ? x.symbols : null });
    }
    const syms = [...new Set([
      ...(rec.bars || []).map(b => b && b.symbol), ...ranTrade.flatMap(x => x.symbols || []), ...tradeCycles.flatMap(x => x.symbols || []),
    ].filter(Boolean))].sort();
    if (!syms.length && Array.isArray(cfg.symbols)) syms.push(...[...cfg.symbols].sort());
    if (!syms.length) syms.push(null);
    const famsInLine = syms.map(s => familyOfId(s));
    for (const symbol of syms) {
      const fam = familyOfId(symbol);
      // A failed attempt's cycle that sent orders (store.js foldAttempts) is the one that acted at this time.
      const forSym = x => !x.symbols || !symbol || x.symbols.includes(symbol);
      const cyc = tradeCycles.find(x => forSym(x) && x.c && x.c.attempt && x.orders.length) || tradeCycles.find(x => forSym(x) && !(x.c && x.c.attempt)) || tradeCycles.find(forSym) || null;
      const ctxSym = cyc && cyc.ctx && Array.isArray(cyc.ctx.symbols) ? cyc.ctx.symbols.find(s => s.symbol === symbol) : null;
      const barRec = (rec.bars || []).find(b => b && b.symbol === symbol);
      const barT = (ctxSym && ctxSym.bar && ctxSym.bar.t) || (barRec && barRec.lastBarT) || null;
      const scanList = (scans.get(`${symbol}|${barT}`) || []).filter(s => Date.parse(s.at) <= t);
      const scan = scanList[scanList.length - 1] || null;
      // What the teacher could trade: a strategy whose status isn't active (paper) can't place a live entry
      // (the gate refuses it; the runner starts no cycle for it) unless the run is in paper mode. A bar no
      // cycle ran on where the runner's own scan decided not to run (decision.run false) has none.
      const runnerPassed = !cyc && isObj(scan && scan.decision) && scan.decision.run === false;
      // The policy's screen failed this cycle: the strategies it owns had no verdict (the gate refuses them).
      const screen = cyc ? screenFailed(cyc.ctx, symbol) : null;
      const fired = scan && !runnerPassed ? objs(scan.results).filter(r => r.candidate && r.direction && tradeable(r, cfg) && !(screen && screen.names && screen.names.includes(r.name))) : [];
      const candidates = fired.map(r => ({ name: r.name, direction: r.direction }));
      const refPrice = scan && scan.bar && num(scan.bar.c) !== null ? scan.bar.c : ctxSym && ctxSym.bar && num(ctxSym.bar.c) !== null ? ctxSym.bar.c : null;
      const isTradeTime = rec.kind === 'trade';
      const signal = { close: scan && scan.bar && num(scan.bar.c) !== null ? scan.bar.c : null, fired };
      const draft = { rec, t, symbol, fam, barT, candidates, refPrice, signal, cyc, ctx: cyc && cyc.ctx, cfg };
      if (!isTradeTime) draft.decision = 'housekeeping';
      // The run's kill switch was on (the runner starts no trade cycle): its own kind, no teacher decision.
      else if (!cyc) draft.decision = rec.killSwitch ? 'kill-switch' : 'no-cycle';
      else {
        // An order naming no contract (modify, cancel): its order id's contract (the broker's journal), else
        // the line's only symbol; with several symbols and no id to resolve, every label of the cycle says so.
        const familyOf = o => familyOfId(o.contractId, contractCache) || (o.orderId !== null ? (journal.find(e => e.orderId !== null && String(e.orderId) === String(o.orderId) && e.ms <= t) || {}).family || null : null);
        const mine = cyc.orders.filter(o => {
          const of = familyOf(o);
          if (of) return of === fam;
          return famsInLine.length === 1;
        });
        // An order no symbol of the line can take: none named and several symbols, or a family the line hasn't
        // (another market, a mistyped id): every label of the cycle says so, never a clean skip or hold.
        const unresolved = cyc.orders.some(o => {
          const f = familyOf(o);
          return f ? !famsInLine.includes(f) : famsInLine.length > 1;
        });
        const pos = positionAt(fam, cyc.ctx, fills, t, contractCache);
        draft.position = pos;
        draft.decision = pos.side ? 'in-trade' : 'flat';
        draft.orders = mine;
        // What the broker did with each entry the gate let through: its journal at the replayed time
        // (from t to the next decision time), matched by rationale, in order.
        for (const o of mine.filter(x => x.gate.decision !== 'refused')) {
          if (o.tool !== 'place_order' || o.gate.decision !== 'allowed') {
            // Not an entry the broker journals. A call that came back an error never changed the account,
            // unless the client timed out (the broker may have acted): then an exit the fills show (a closing
            // fill on its contract by the next decision, not a bracket's own) went through; else it is unknown.
            if (!o.callFailed) continue;
            const exit = o.tool === 'close_position' || o.tool === 'partial_close_position' || (o.tool === 'place_order' && o.riskReducing);
            const fate = failedCall(o);
            const closed = exit && fate.timeout && fills.some(f => familyOfId(f.contractId, contractCache) === fam && f.ms > t && f.ms <= nextT
              && f.profitAndLoss !== null && f.profitAndLoss !== undefined && !BRACKET_EXIT.test(String((isObj(f.roundTrip) && f.roundTrip.reason) || f.exitReason || '')));
            o.broker = closed ? { decision: 'accepted', orderId: null, reason: null, seen: 'fills' } : fate;
            continue;
          }
          const j = journal.find(e => !journalUsed.has(e) && e.ms >= t && e.ms < nextT && e.rationale !== null && e.rationale === o.rationale
            && (e.family === null || e.family === familyOfId(o.contractId, contractCache)));
          if (j) {
            journalUsed.add(j);
            o.broker = { decision: j.accepted ? 'accepted' : 'refused', orderId: j.orderId, reason: j.reason };
          } else if (o.callFailed) {
            // No journal record, and the call came back an error (a broker refusal sets isError; so does a
            // server that rejected its arguments): it never became an order, unless the client timed out.
            o.broker = failedCall(o);
          }
        }
        // In a trade: its side and the working stop the cycle's context showed (open-trades.js), for a modify.
        const open = pos.side ? objs(cyc.ctx && cyc.ctx.openTrades).find(x => familyOfId(x.contractId, contractCache) === fam) : null;
        draft.act = teacherAction(mine, pos.side ? { side: pos.side, stop: open && Number.isFinite(open.stop) ? open.stop : null } : false);
        if (cyc.unknown) draft.act.reasons.push('no cycle log');
        if (!pos.side) {
          const acct = cyc.ctx && isObj(cyc.ctx.account) ? cyc.ctx.account : null;
          // Flat with a resting order (the runner ran the cycle for it): the decision is about that order, never a
          // skip. The count is the account's: while another family holds a position (this one is flat) its brackets explain it.
          const elsewhere = acct && objs(acct.positions).length > 0;
          if (acct && Number(acct.workingOrders) > 0 && !elsewhere) draft.act.reasons.push('working order');
          // A manage-only cycle (the day's cycle cap reached): no new entry was allowed, so standing aside is no skip.
          if (cyc.action === 'manage') draft.act.reasons.push('manage-only');
          // Paper mode: the gate refuses every live entry (the teacher journals plans), so no flat decision is a skip.
          if (cfg.paper) draft.act.reasons.push('paper mode');
          // The policy's screen failed (runner.js policyFailed): its strategies had no verdict and the gate refused their entries.
          // Only when the line doesn't name them (their candidates are dropped above); plain strategies still trade.
          if (screen && !screen.names) draft.act.reasons.push('policy screen failed');
        }
        if (unresolved) draft.act.reasons.push('unattributed order');
        // A failed or timed-out cycle's silence is no decision: never a skip, never cloneable.
        if (cyc.failed) draft.act.reasons.push(cyc.failed);
      }
      drafts.push(draft);
    }
  }
  const attributed = new Set(drafts.flatMap(d => d.orders || []));
  const unattributed = new Set();
  for (const d of drafts) if (d.cyc) for (const o of d.cyc.orders) if (!attributed.has(o)) unattributed.add(o);

  // Pass 2: each allowed entry gets the round trip that opened after it on its family and side, the
  // same trading day (the latest entry before an opening takes it: a market order fills first).
  const entryOf = new Map();
  const takenEntries = drafts.filter(d => d.decision === 'flat' && d.act && d.act.order && d.act.order.gate.decision === 'allowed' && !refusedBy(d.act.order) && d.act.order.side);
  // The broker's order id first (its journal names it, its fills carry it), then the time rule.
  for (const rt of trips.filter(x => x.openMs !== null && x.opens[0].orderId !== undefined && x.opens[0].orderId !== null)) {
    const d = takenEntries.find(x => !entryOf.has(x) && x.act.order.broker.orderId !== null && String(x.act.order.broker.orderId) === String(rt.opens[0].orderId)
      && x.fam === rt.family && x.t <= rt.openMs);
    if (d) entryOf.set(d, rt);
  }
  const joined = new Set(entryOf.values());
  for (const rt of trips.filter(x => x.openMs !== null && !joined.has(x))) {
    // Only an entry whose broker order id is unknown: one with a known id took its own opening (or none).
    const cands = takenEntries.filter(d => !entryOf.has(d) && d.act.order.broker.orderId === null && d.fam === rt.family && d.act.order.side === rt.side && d.t <= rt.openMs
      && tradingDayKey(new Date(d.t)) === tradingDayKey(new Date(rt.openMs)));
    if (cands.length) entryOf.set(cands[cands.length - 1], rt);
  }
  const matchedTrips = new Set(entryOf.values());

  // The data the run replayed (--bars), else the run home's bars. Counterfactuals walk forward on them
  // (by design, only into outcome fields); the stop's ATR reads only the bars closed by t.
  const futureBars = d => outcomeFor(outcomeBars, d.symbol, tfOf(d.cfg)) || barsFor(d.symbol, tfOf(d.cfg));
  const byName = new Map((strategies || []).filter(x => x && x.name && x.valid !== false).map(x => [x.name, x]));
  const simulated = (d, spec) => d.signal.fired.map(r => simulate({
    bars: futureBars(d), tfMs: tfMsOf(d.cfg), signalMs: Date.parse(d.barT), signalClose: d.signal.close, direction: r.direction,
    stopDistance: num(r.stopDistance), targetDistance: num(r.targetDistance), strategy: byName.get(r.name) || null, spec, eodMs: eodOf(d.cfg, d.t),
  }));
  // The one that stands for the label: a taken trade's own; a refused intent's candidate (its setup and side);
  // else the backtester's pick: the first candidate, in scan order, with a stop distance.
  const pickCounterfactual = (d, list) => {
    if (list.length === 1 || list[0].source === 'fills') return list[0];
    const o = d.act && d.act.order;
    const own = o ? d.signal.fired.findIndex(r => r.name === o.setup && r.direction === d.act.action) : -1;
    return list[own !== -1 ? own : Math.max(0, d.signal.fired.findIndex(r => num(r.stopDistance) > 0))] || null;
  };

  const strategiesHash = hashStrategies(strategies);
  const policyVerdicts = readLines(path.join(home, 'policy-verdicts.jsonl')).filter(isObj);
  const labels = [];
  for (const d of drafts) {
    const { rec } = d;
    const tday = tradingDayKey(new Date(d.t)); // the replayed trading day: its own cache file's spec
    const spec = contractSpec(d.symbol, d.fam, contractCache, tday);
    let usedSpec = spec;
    let teacher = null;
    let gate = { decision: 'none', checks: [] };
    let outcome = null;
    let counterfactuals = [];
    let counterfactualFor = null;
    const reasons = [];
    if (d.act) {
      const o = d.act.order;
      const isEntry = d.decision === 'flat' && o;
      const rt = isEntry ? entryOf.get(d) || null : null;
      // Decision-time fields read only the order and what was there at t (never its fill).
      const ospec = isEntry ? contractSpec(o.contractId, d.symbol, contractCache, tday) : spec;
      usedSpec = ospec;
      if (ospec && ospec.source === 'mismatch') reasons.push('broker spec mismatch');
      // ATR from the replayed data when given (--bars), else the run home's: bars closed by t either way.
      const atr = isEntry ? atrAt(futureBars(d), tfMsOf(d.cfg), d.t) : null;
      const stop = isEntry ? stopOf(o, ospec, d.refPrice, atr) : null;
      const size = isEntry ? sizeOf(o, ospec, stop, budgetFor(budgetUsd)) : null;
      // A target bracket is the strategy's own exit when it is what order_plan places for the setup
      // (the backtester applies the strategy's exit); any other target is the teacher's, which the mechanical action space can't express.
      let target = null;
      // A composed entry's limit at its record's entry and its record's target are its plan's own (section 5).
      const plan = isEntry ? composedPlan(o, d.act.action, d.cyc && d.cyc.composed, { fam: d.fam, barT: d.barT, tags: composedTagsAt(strategies, policyVerdicts, d.symbol, d.barT), root: o.contractId ? contractCache.root(String(o.contractId)) || (parseStandardName(String(o.contractId)) || { root: String(o.contractId).toUpperCase() }).root : null }) : null;
      if (isEntry && o.targetTicks && plan && plan.target) target = { ticks: o.targetTicks, from: 'record' };
      else if (isEntry && o.targetTicks) {
        const strat = byName.get(o.setup);
        const fired = d.signal.fired.find(r => r.name === o.setup) || {};
        const planned = strat && stop && stop.ticks && ospec ? plannedTarget(strat, stop.ticks, num(fired.targetDistance), ospec.tickSize) : null;
        target = { ticks: o.targetTicks, from: planned === o.targetTicks ? 'strategy' : 'teacher' };
      }
      teacher = {
        action: d.act.action, setup: o ? o.setup : null, stop, size, target, priorRefusals: d.act.priorRefusals || 0,
        orders: d.orders.map(({ argsKnown, ...rest }) => ({ ...rest, argsKnown })),
      };
      if (o) {
        // A client timeout with nothing to show (an entry no fill joined): what the broker did is unknown.
        if (o.broker && o.broker.timeout && !rt) reasons.push('outcome unknown: client timeout');
        const by = refusedBy(o);
        // An order the gate never logged (a call the transcript shows but no gate record): neither allowed nor refused.
        gate = { decision: by ? 'refused' : o.gate.decision === 'allowed' ? 'allowed' : o.gate.decision, by, checks: o.gate.checks, ...(by === 'broker' || by === 'hook' || by === 'client' ? { brokerReason: o.broker.reason } : {}) };
        if (o.gate.decision === 'not-logged') reasons.push('no gate record');
      }
      reasons.push(...d.act.reasons.filter(r => !(r === 'explicit target' && target && (target.from === 'strategy' || target.from === 'record'))
        && !(r === 'limit entry' && plan && plan.limit)));
      if (isEntry && !stop.points) reasons.push('no stop');
      else if (isEntry && stop.outOfRange) reasons.push('stop out of ATR range');
      else if (isEntry && stop.multiple === null) reasons.push('stop not mapped to ATR');
      if (d.decision === 'in-trade') {
        const open = trips.find(x => x.family === d.fam && (x.openMs === null || x.openMs <= d.t) && (x.closeMs === null || x.closeMs >= d.t)) || null;
        outcome = open ? outcomeOf(open, null, contractCache) : null;
      } else if (isEntry) {
        // Allowed, no fill: unfilled, unless the call timed out (it may have been placed, or not): unknown, never taken.
        outcome = gate.decision === 'allowed' ? (rt ? outcomeOf(rt, stop && stop.ticks, contractCache) : o.broker && o.broker.timeout ? { filled: null, result: 'unknown' } : { filled: false, result: 'unfilled' })
          : { filled: false, result: gate.decision === 'refused' ? 'refused' : 'not logged' };
      }
      // A skip: flat, nothing sent, no working order touched (a cancel or a modify is a decision of its own).
      const skip = d.decision === 'flat' && d.act.action === 'none' && !d.act.reasons.some(r => NOT_A_SKIP.has(r));
      counterfactualFor = isEntry ? (outcome.result === 'unknown' ? 'outcome unknown' : { allowed: 'taken', refused: 'refused intent' }[gate.decision] || null) : skip ? 'skip' : null;
      if (isEntry && gate.decision === 'allowed') {
        counterfactuals = [fromFills(outcome, { stopPoints: stop && stop.points, targetTicks: o.targetTicks, spec: ospec, bars: futureBars(d), tfMs: tfMsOf(d.cfg), strategy: o.setup, direction: d.act.action })];
      } else if (d.decision === 'flat' && (counterfactualFor === 'skip' || counterfactualFor === 'refused intent') && d.candidates.length && !d.cyc.failed) {
        // A skip, or an intent refused (by the gate or the broker): what the candidates would have done.
        counterfactuals = simulated(d, spec);
      }
    } else if (d.decision === 'no-cycle') {
      reasons.push('no cycle');
      counterfactualFor = 'no cycle';
      // A candidate's flat entry only while flat (the fills through t; no cycle context to read).
      d.position = positionAt(d.fam, null, fills, d.t, contractCache);
      if (d.candidates.length && d.barT && !d.position.side) counterfactuals = simulated(d, spec);
    }
    else if (d.decision === 'kill-switch') reasons.push('kill switch on');
    else reasons.push('not a trade decision');
    if (rec.interrupted) reasons.push('interrupted');
    if (rec.failedAttemptOrders || (d.cyc && d.cyc.c && d.cyc.c.attempt && d.cyc.orders.length)) reasons.push('orders from a failed attempt');
    const cyc = d.cyc && d.cyc.c;
    const promptHash = cyc ? cyc.promptHash || null : null;
    const entry = recordedValues(rec, d.symbol, d.barT);
    // What the line says went wrong for this symbol's bar: its values or its archiving.
    const symErrors = (Array.isArray(rec.errors) ? rec.errors : []).map(String).filter(e => d.symbol && e.startsWith(`${d.symbol}: `));
    const valuesAbsent = !Array.isArray(rec.values);
    const valuesError = !entry && !valuesAbsent ? symErrors.find(e => /no field values recorded|strategy scan failed/.test(e)) || null : null;
    const archiveError = archived.errors[rec.day] || symErrors.find(e => /could not archive the bars/.test(e)) || null;
    // Retention removed the day's archive (a live home's oldest days): pruned, not a bar that was never archived.
    const archivePruned = Boolean(rec.day) && !fs.existsSync(archiveFile(dir, rec.day)) && wasPruned(dir, rec.day);
    const values = entry ? entry.strategies : null;
    // By contract when the line names it (a roll mid-day archives the new contract's window at the same times).
    const archivedBar = d.barT && tfOf(d.cfg) ? archived.get(d.symbol, entry ? entry.contractId : null, tfOf(d.cfg), d.barT) : null;
    labels.push({
      v: VERSION,
      key: crypto.createHash('sha256').update(`${manifest.runId}|${rec.t}|${d.symbol}|${promptHash}`).digest('hex').slice(0, 24),
      runId: manifest.runId, t: rec.t, day: rec.day, kind: rec.kind, symbol: d.symbol, barT: d.barT,
      decision: d.decision, interrupted: Boolean(rec.interrupted), cycleFailed: d.cyc ? d.cyc.failed : null, position: d.position || null,
      candidates: d.candidates, values, valuesAbsent, valuesError, archivedBar, archiveError, archivePruned, teacher, gate, outcome,
      counterfactual: counterfactuals.length ? pickCounterfactual(d, counterfactuals) : null, counterfactuals, counterfactualFor: counterfactuals.length ? counterfactualFor : null,
      clone: { ok: Boolean(teacher) && reasons.length === 0, reasons: [...new Set(reasons)] },
      result: d.cyc ? d.cyc.result : ((rec.ran || [])[0] || {}).result || null,
      provenance: { harness: manifest.harness || null, model: manifest.model || null, configHash: manifest.hash || null, strategiesHash, bars: barsSource || 'run home', specs: usedSpec ? usedSpec.source : null, promptHash, cycleFile: cyc ? relCycle(home, cyc.file) : null },
    });
  }
  const summary = summarize(labels, {
    runId: manifest.runId, strategiesHash, unfinished: why, torn: tornLines(dir), unattributedOrders: unattributed.size,
    // Order records the gate made outside every trade cycle (the runner's own, or a cycle with no log line).
    gateRecordsOutsideCycles: gateLog.filter(e => gateTool(e) && !e.inCycle).length,
    // A failed read, and an interrupted last line (its fills would have gone to a next line that never came).
    fillsUnread: lines.filter(r => r.trades && !Array.isArray(r.trades)).length + (lines.length && lines[lines.length - 1].interrupted && lines[lines.length - 1].trades === null ? 1 : 0),
    unmatchedOpenings: trips.filter(x => x.openMs !== null && !matchedTrips.has(x)).length,
  });
  return { labels, summary };
}

function summarize(labels, extra) {
  const n = f => labels.filter(f).length;
  const decision = l => l.decision === 'flat' || l.decision === 'in-trade';
  const entry = l => l.decision === 'flat' && (l.teacher.action === 'long' || l.teacher.action === 'short');
  // An allowed entry whose outcome is unknown (a client timeout, nothing to show) is not taken: counted apart.
  const allowedEntry = l => entry(l) && l.gate.decision === 'allowed';
  const taken = l => allowedEntry(l) && !(l.outcome && l.outcome.result === 'unknown');
  const decisions = n(decision);
  const cloneable = n(l => decision(l) && l.clone.ok);
  const touched = l => l.clone.reasons.some(r => NOT_A_SKIP.has(r));
  const skipped = l => l.decision === 'flat' && !l.cycleFailed && !touched(l) && l.teacher.action === 'none' && l.candidates.length > 0;
  const cf = (f, result) => n(l => f(l) && l.counterfactual && l.counterfactual.result === result);
  const noCycleCands = l => l.decision === 'no-cycle' && l.candidates.length > 0;
  const refusedIntent = l => entry(l) && l.gate.decision === 'refused';
  return {
    v: VERSION, runId: extra.runId, strategiesHash: extra.strategiesHash, labels: labels.length, decisions,
    flat: n(l => l.decision === 'flat'), inTrade: n(l => l.decision === 'in-trade'),
    entries: n(entry), taken: n(taken), unknownOutcome: n(l => allowedEntry(l) && l.outcome && l.outcome.result === 'unknown'), refused: n(l => decision(l) && l.gate.decision === 'refused'),
    skipped: n(skipped),
    standAside: n(l => l.decision === 'flat' && !l.cycleFailed && !touched(l) && l.teacher.action === 'none' && !l.candidates.length),
    holds: n(l => decision(l) && !touched(l) && l.teacher.action === 'hold'), tightens: n(l => decision(l) && l.teacher.action === 'tighten'), exits: n(l => decision(l) && l.teacher.action === 'exit'),
    wins: n(l => taken(l) && l.outcome && l.outcome.result === 'win'), losses: n(l => taken(l) && l.outcome && l.outcome.result === 'loss'),
    scratches: n(l => taken(l) && l.outcome && l.outcome.result === 'scratch'), unfilled: n(l => taken(l) && l.outcome && l.outcome.result === 'unfilled'),
    open: n(l => taken(l) && l.outcome && l.outcome.result === 'open'),
    cloneable, uncloneable: decisions - cloneable, coverage: decisions ? round(cloneable / decisions) : null,
    unmapped: n(l => entry(l) && l.teacher.stop && l.teacher.stop.points && l.teacher.stop.multiple === null),
    unfinished: extra.unfinished,
    unsized: n(l => entry(l) && l.teacher.size && l.teacher.size.step === null),
    noCycle: n(l => l.decision === 'no-cycle'), noCycleWithCandidates: n(l => l.decision === 'no-cycle' && l.candidates.length > 0),
    housekeeping: n(l => l.decision === 'housekeeping'), killSwitch: n(l => l.decision === 'kill-switch'), interrupted: n(l => l.interrupted),
    // Counterfactuals (by each label's primary candidate): a skilful skip avoided a loser, an overly cautious one missed a winner.
    takenWon: cf(taken, 'win'), takenLost: cf(taken, 'loss'),
    skippedWouldWin: cf(skipped, 'win'), skippedWouldLose: cf(skipped, 'loss'), skippedNoTrade: cf(skipped, 'no-trade'),
    skippedUnsimulated: n(l => skipped(l) && l.counterfactual && !l.counterfactual.simulated),
    refusedWouldWin: cf(refusedIntent, 'win'), refusedWouldLose: cf(refusedIntent, 'loss'),
    brokerRefused: n(l => decision(l) && l.gate.by === 'broker'), priorRefusals: labels.reduce((a, l) => a + ((l.teacher && l.teacher.priorRefusals) || 0), 0),
    stopOutOfRange: n(l => entry(l) && l.teacher.stop && l.teacher.stop.outOfRange),
    noCycleWouldWin: cf(noCycleCands, 'win'), noCycleWouldLose: cf(noCycleCands, 'loss'),
    noCycleUnsimulated: n(l => noCycleCands(l) && (!l.counterfactual || !l.counterfactual.simulated)),
    unsimulated: labels.flatMap(l => l.counterfactuals).filter(c => c.source === 'simulated' && !c.simulated).length,
    unsimulatedBy: labels.flatMap(l => l.counterfactuals).filter(c => c.source === 'simulated' && !c.simulated).map(c => c.reason).sort()
      .reduce((m, r) => ({ ...m, [r]: (m[r] || 0) + 1 }), {}),
    cycleFailed: n(l => decision(l) && l.cycleFailed), gateRecordsOutsideCycles: extra.gateRecordsOutsideCycles,
    torn: extra.torn, unattributedOrders: extra.unattributedOrders, fillsUnread: extra.fillsUnread, unmatchedOpenings: extra.unmatchedOpenings,
    uncloneableBy: labels.filter(l => decision(l) && !l.clone.ok).flatMap(l => l.clone.reasons).sort()
      .reduce((m, r) => ({ ...m, [r]: (m[r] || 0) + 1 }), {}),
  };
}

/** Whether `dir` is `root` or inside it (symlinks followed where they exist). */
function inside(dir, root) {
  // The nearest existing ancestor resolved (symlinks, /var -> /private/var), the rest joined on.
  const real = p => {
    const abs = path.resolve(p);
    for (let dir = abs, rest = ''; ; rest = path.join(path.basename(dir), rest), dir = path.dirname(dir)) {
      // .native: the name as stored, letter case included (a case-insensitive volume reaches one folder by many spellings).
      try { return path.join(fs.realpathSync.native(dir), rest); } catch (_err) { if (dir === path.dirname(dir)) return abs; }
    }
  };
  const rel = path.relative(real(root), real(dir));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Bars from a data file (the backtester's formats, backtest/data.js) at the run's timeframe: one-minute
 * bars are aggregated; any other bar size must be the run's.
 */
function outcomeBarsFrom(file, tf) {
  const bars = loadDataBars(path.resolve(expandHome(file)));
  const m = bars.length > 1 ? barMinutes(bars) : tf;
  if (m === tf) return bars;
  if (m !== 1) throw new Error(`${file}: ${m}-minute bars; the run trades ${tf}-minute bars (give one-minute bars or the run's)`);
  // Outcomes read prices only: the broker's own fields, which the harness can't combine, are dropped here on purpose.
  return aggregate(bars, { unit: 2, unitNumber: tf, nowMs: Infinity, extraFields: 'drop' }).map(b => ({ ...b, ms: Date.parse(b.t) }));
}

/** Every timeframe the run's lines were decided at: its first config's and each version's (configsOf). */
function timeframesOf(dir) {
  const manifest = readJson(path.join(dir, 'manifest.json'), {}) || {};
  const at = configsOf(dir, manifest);
  const times = [null, ...(Array.isArray(manifest.versions) ? manifest.versions.map(v => v && v.since) : [])];
  return [...new Set(times.map(t => Number(at(t).timeframe) || null).filter(Boolean))].sort((a, b) => a - b);
}

/**
 * The --bars data at every timeframe the run used, { byTf: { tf: { SYMBOL: bars } } } (null without files): a
 * session restarted on another timeframe reads each line's bars at its own (one-minute data aggregates to each).
 */
function outcomeBarsFor(dir, barsFiles) {
  if (!Object.keys(barsFiles).length) return null;
  const tfs = timeframesOf(dir);
  if (!tfs.length) throw new Error(`${dir}: no runner timeframe (autotrader.json) to read the bars at`);
  return { byTf: Object.fromEntries(tfs.map(tf => [tf, Object.fromEntries(Object.entries(barsFiles).map(([sym, f]) => [sym, outcomeBarsFrom(f, tf)]))])) };
}

/** A symbol's --bars data at a line's timeframe ({ byTf } from outcomeBarsFor, or { SYMBOL: bars }), else null. */
function outcomeFor(outcomeBars, sym, tf) {
  if (!outcomeBars) return null;
  const set = outcomeBars.byTf ? outcomeBars.byTf[tf] : outcomeBars;
  return set && Array.isArray(set[sym]) ? set[sym] : null;
}

/**
 * @param opts.barsFiles { SYMBOL: file } the data the run replayed, for the counterfactuals
 * @param opts.outDir where to write (default the run dir); required for an unfinished run, and then
 *   outside the run home (its teacher, on resume, must not read what came after its decisions)
 */
function writeLabels(runDir, { root = null, budgetUsd = null, strategies = [], barsFiles = {}, outDir = null } = {}) {
  const dir = realDir(runDir);
  const out = outDir ? path.resolve(expandHome(outDir)) : dir;
  const home = path.resolve(dir, '..', '..');
  if (root && (inside(dir, root) || inside(out, root))) throw new Error(`${inside(out, root) ? out : dir} is inside the repository (${root}): labels are written to the run's own folder or --out, never the repository`);
  if (outDir && inside(out, home)) throw new Error(`--out ${out} is inside the run home (${home}): write the labels of an unfinished run outside it`);
  const outcomeBars = outcomeBarsFor(dir, barsFiles);
  // Which data the labels read (--bars): each file's sha256, for the labels' provenance.
  const barsSource = Object.keys(barsFiles).length ? Object.fromEntries(Object.entries(barsFiles).sort().map(([sym, f]) => [sym, crypto.createHash('sha256').update(fs.readFileSync(path.resolve(expandHome(f)))).digest('hex')])) : null;
  const { labels, summary } = labelRun(dir, { budgetUsd, strategies, outcomeBars, unfinished: Boolean(outDir), barsSource });
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'labels.jsonl');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, labels.map(l => `${JSON.stringify(l)}\n`).join(''));
  fs.renameSync(tmp, file);
  writeJsonAtomic(path.join(out, 'labels-summary.json'), summary);
  return { file, summary };
}

const SUMMARY_KEYS = ['labels', 'decisions', 'taken', 'unknownOutcome', 'skipped', 'refused', 'wins', 'losses', 'uncloneable', 'unmapped', 'unsized', 'noCycle', 'noCycleWithCandidates', 'interrupted', 'coverage',
  'takenWon', 'takenLost', 'skippedWouldWin', 'skippedWouldLose', 'refusedWouldWin', 'refusedWouldLose', 'noCycleWouldWin', 'noCycleWouldLose', 'unsimulated', 'brokerRefused', 'priorRefusals', 'cycleFailed', 'unattributedOrders', 'unmatchedOpenings'];
const summaryText = s => `${SUMMARY_KEYS.map(k => `${k} ${s[k] === null ? '-' : s[k]}`).join(', ')}\n${Object.keys(s.uncloneableBy).length ? `uncloneable by reason: ${Object.entries(s.uncloneableBy).map(([k, v]) => `${k} ${v}`).join(', ')}\n` : ''}`;

module.exports = {
  VERSION, STOP_ATR_MULTIPLES, STOP_ATR_RANGE, SIZE_STEPS, ATR_PERIOD, labelRun, composedTagsAt, countedEntry, writeLabels, summaryText, roundTrips, outcomeOf, atrAt, teacherAction, stopOf, sizeOf, collapsePairs, brokerOrders, contractSpec,
  // The same fills, bars, specs and paths the labels read.
  allFills, translatorCache, loadBars, outcomeBarsFrom, inside, realDir, unfinishedWhy, configsOf, timeframesOf, outcomeBarsFor, outcomeFor, eodOf,
};
