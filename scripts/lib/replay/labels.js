'use strict';

/**
 * Labels from a replay run (the reasoning-trader design's stage 2,
 * "Actions"): every decision the reasoning model made at a decision time, per
 * symbol, mapped to the student's action space, with the gate's answer and the
 * trade's outcome. Model-neutral: it reads only what every replay writes.
 *
 * Read (all local, the run dir and its run home, <runDir>/../..):
 *   <runDir>/manifest.json, <runDir>/<day>.jsonl   the decision times (store.js)
 *   <runDir>/autotrader.json                         the runner config (timeframe, symbols)
 *   <home>/logs/cycles/<day>/*.json                  each cycle's context (positions, what fired) and transcript
 *   <home>/logs/gate-log.jsonl                       every order call the gate judged (hook and gateway)
 *   <home>/logs/scans-<day>.jsonl                    every scanned bar: what fired
 *   <home>/bars/<SYM>-<tf>m.json, <home>/bars-scratch/<SYM>-<tf>m*.json   bars, for ATR
 *
 * One label per decision time and symbol (one with symbol null when a line
 * names none), in time order:
 *   decision  flat | in-trade (a trade or manage cycle ran for the symbol: the teacher decided),
 *             no-cycle (a trade time with no cycle for it: not a teacher decision),
 *             housekeeping (premarket, end of day)
 *   teacher   { action: none | long | short (flat), hold | tighten | exit (in a trade), setup,
 *               stop: { ticks, points, atr, multiple (nearest of STOP_ATR_MULTIPLES), ratio },
 *               size: { contracts, riskUsd, budgetUsd, step (nearest of SIZE_STEPS), ratio }, orders }
 *   gate      { decision: allowed | refused | none | not-logged, checks } of the order behind the action
 *   outcome   the round trip the action opened (flat) or was in (in a trade), from the broker's fills
 *   clone     { ok, reasons }: what the student can't express (limit or stop entries, a target other
 *             than the strategy's own exit as order_plan places it (teacher.target.from), several
 *             entries, adds, partial exits, unknown arguments, an unmapped stop) stays out of cloning
 *   counterfactuals / counterfactual   what each candidate's own trade would have done (counterfactual.js:
 *             the backtester's fills and exits walked forward on the bars) on a skipped label or a no-cycle
 *             bar, or the same fields from the real fills of a taken entry; `counterfactual` is the
 *             primary one (the backtester's pick: the first candidate with a stop distance)
 *
 * Orders: the gate's log holds every place_order and modify_order (hook and gateway) and every
 * cancel_order and partial_close_position (gateway); close_position isn't gated, so an exit by it is
 * seen only in a transcript the cycle log parses (Claude stream-json, Codex --json, Qwen JSON).
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
const { tradingDayKey, tradingDayStart, sessionMinuteOf, MARKET_OPEN_MIN, MARKET_CLOSE_MIN } = require('../trading/clock');
const { parseStandardName } = require('../broker/translator');
const { toolCalls } = require('../cycle-log');
const ind = require('../trading/indicators');
const { readRun, readLines } = require('./store');
const { targetFor } = require('../trading/order-plan');
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
const ATR_PERIOD = 20; // the RL observation's ATR (rl/observation.js atr20)
const ATR_WINDOW = 100; // closed bars the ATR is computed over: a fixed window, so older bars never change it
const ORDER_TOOL = /(?:^|__)(place_order|modify_order|cancel_order|close_position|partial_close_position)$/;
const SETUP = /^\s*setup:([a-z0-9][a-z0-9_-]*)(?:\s+(long|short|buy|sell))?\b/i;
const SIDE = { long: 'buy', buy: 'buy', short: 'sell', sell: 'sell' };
const GATE_SLACK_MS = 2000;

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const round = (x, d = 4) => (x === null ? null : Number(x.toFixed(d)));
const familyOfId = id => (id ? familyRoot((parseStandardName(String(id)) || { root: String(id).toUpperCase() }).root) : null);
const nearest = (x, set) => set.reduce((best, s) => (Math.abs(s - x) < Math.abs(best - x) ? s : best), set[0]);
const toolName = name => (ORDER_TOOL.exec(String(name || '')) || [])[1] || null;
// The hook (place_order and modify_order) logs no tool name: an entry names a contract and a rationale, a modify neither.
const gateTool = e => toolName(e.tool) || (e.source === 'hook' ? (e.contractId || e.rationale ? 'place_order' : 'modify_order') : null);
const sideOf = s => {
  const v = String(s ?? '').toLowerCase();
  return v === '0' || v === 'buy' || v === 'bid' ? 'buy' : v === '1' || v === 'sell' || v === 'ask' ? 'sell' : null;
};
const sign = side => (side === 'buy' ? 1 : side === 'sell' ? -1 : 0);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

/**
 * A contract's tick specs (tickSize, tickValue) from its standard name (MNQ, NQ:2026-03), else the
 * fallback's (the label's symbol). The one place specs are looked up, so another source can replace it.
 */
function contractSpec(contractId, fallback = null) {
  const root = contractId ? (parseStandardName(String(contractId)) || {}).root : null;
  return (root && specFor(root)) || (fallback ? specFor((parseStandardName(String(fallback)) || {}).root || fallback) : null);
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

/** ATR(20) over the last ATR_WINDOW bars closed at or before t (ms), or null. */
function atrAt(bars, tfMs, t) {
  let hi = -1;
  for (let lo = 0, top = bars.length - 1; lo <= top;) {
    const mid = (lo + top) >> 1;
    if (bars[mid].ms + tfMs <= t) { hi = mid; lo = mid + 1; } else top = mid - 1;
  }
  if (hi + 1 < ATR_PERIOD) return null;
  const a = ind.atr(bars.slice(Math.max(0, hi + 1 - ATR_WINDOW), hi + 1), ATR_PERIOD);
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
function roundTrips(fills) {
  const open = new Map();
  const out = [];
  for (const f of fills) {
    const fam = familyOfId(f.contractId);
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
function outcomeOf(rt, stopTicks) {
  if (!rt) return null;
  const first = rt.opens[0] || null;
  const entry = first && first.entry && typeof first.entry === 'object' ? first.entry : {};
  const spec = contractSpec(rt.contractId) || {};
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
    gate: gate ? { decision: gate.decision === 'allowed' ? 'allowed' : 'refused', source: gate.source || null, checks: (gate.violations || []).map(v => v.check) } : { decision: 'not-logged', source: null, checks: [] },
  };
}

const PAIR_MS = 5000;
/**
 * One place_order can leave two gateway records: allowed by the gate, then blocked when the gateway's
 * order tracker refuses to send it (mcp-gateway.js). Such a pair (same tool, contract and rationale,
 * the block within PAIR_MS) is one refused order: the allowed record is dropped.
 */
function collapsePairs(records) {
  const drop = new Set();
  records.forEach((b, i) => {
    if (b.source !== 'gateway' || b.decision !== 'blocked') return;
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
  const calls = doc ? toolCalls(doc.transcript || '').filter(x => toolName(x.name)).map(x => ({ tool: toolName(x.name), input: x.input, used: false })) : [];
  const out = gates.map(g => {
    const tool = gateTool(g);
    const call = calls.find(x => !x.used && x.tool === tool && String(x.input.rationale ?? '') === String(g.rationale ?? '')
      && (!x.input.contractId || !g.contractId || String(x.input.contractId) === String(g.contractId)));
    if (call) call.used = true;
    return normalizeOrder(tool, call ? call.input : null, g);
  });
  for (const x of calls.filter(y => !y.used)) out.push(normalizeOrder(x.tool, x.input, null));
  return out;
}

/** The position in a family at t: from the cycle's context (what the teacher saw), else the fills through t. */
function positionAt(fam, ctx, fills, t) {
  const acct = ctx && ctx.account;
  if (acct && Array.isArray(acct.positions)) {
    const net = acct.positions.filter(p => familyOfId(p.contractId) === fam)
      .reduce((n, p) => n + (p.side === 'long' ? 1 : p.side === 'short' ? -1 : 0) * (Math.abs(Number(p.size)) || 1), 0);
    return { side: net > 0 ? 'long' : net < 0 ? 'short' : null, size: Math.abs(net), source: 'context' };
  }
  // Fills alone: opening fills add their side, closing fills take it off; a position from before the run is unseen.
  let net = 0;
  for (const f of fills) {
    if (f.ms > t || familyOfId(f.contractId) !== fam) continue;
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

/** Who refused an order: 'gate', 'broker', or null (it went through, or its fate is unknown). */
const refusedBy = o => (o.gate.decision === 'refused' ? 'gate' : o.broker && o.broker.decision === 'refused' ? 'broker' : null);

/** The teacher's action for one symbol from its orders, and what keeps it out of cloning. */
function teacherAction(orders, inTrade) {
  const reasons = [];
  const entries = orders.filter(o => o.tool === 'place_order' && !o.riskReducing);
  const cancels = orders.filter(o => o.tool === 'cancel_order');
  if (cancels.length) reasons.push('order cancel');
  if (!inTrade) {
    if (!entries.length) return { action: 'none', order: null, reasons, priorRefusals: 0 };
    // The entry that counts: the last one the broker accepted, else the last one the gate let through and
    // the broker didn't refuse, else the last one sent. Refused tries before it (by the gate or the broker)
    // are one decision with it, counted in priorRefusals; only several entries that went through are "several".
    const through = entries.filter(x => !refusedBy(x));
    const accepted = through.filter(x => x.broker && x.broker.decision === 'accepted');
    const o = accepted.length ? accepted[accepted.length - 1] : through.length ? through[through.length - 1] : entries[entries.length - 1];
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
  if (exits.length) {
    if (exits.some(o => o.tool === 'partial_close_position')) reasons.push('partial exit');
    return { action: 'exit', order: exits[0], reasons };
  }
  const tightens = orders.filter(o => (o.tool === 'modify_order' && (!o.argsKnown || o.stopPrice !== null || o.trailPrice !== null))
    || (o.tool === 'place_order' && /^\s*\[protect\]/i.test(o.rationale || '')));
  if (tightens.length) {
    if (tightens.some(o => !o.argsKnown)) reasons.push('order arguments unknown');
    return { action: 'tighten', order: tightens[0], reasons };
  }
  if (orders.some(o => o.tool === 'modify_order')) reasons.push('target change');
  return { action: 'hold', order: null, reasons };
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
 * @param opts.budgetUsd the dollars a trade may risk (size steps); else an active prop attempt's
 * @param opts.strategies loaded STRATEGY.md objects (their exits, for the counterfactuals)
 * @param opts.outcomeBars { SYMBOL: bars } to walk counterfactuals on (the data the run replayed);
 *   else the run home's bars. Never read for anything at decision time.
 */
/** Why a run isn't finished (a step pending, a day not done), or null. */
function unfinishedWhy(manifest, days) {
  const open = Object.keys(days).filter(d => !(manifest.daysDone || []).includes(d));
  if (manifest.pending) return `a step at ${manifest.pending.t} was interrupted`;
  return open.length ? `day ${open[0]} is not done` : null;
}

/**
 * The broker's own record of each order (the replay broker's journal, BROKER-MCP-INTERFACE: order_placed
 * with its result, order_blocked by its guardrails), at the replayed time: [{ ms, rationale, accepted, orderId, reason }].
 */
function brokerOrders(file) {
  return readLines(file).filter(isObj).filter(e => e.kind === 'order_placed' || e.kind === 'order_blocked').map(e => {
    const result = isObj(e.data) && isObj(e.data.result) ? e.data.result : {};
    const text = String(e.text || '');
    const cut = text.indexOf(' | rationale: ');
    const placed = e.kind === 'order_placed';
    return {
      ms: Date.parse(e.ts), rationale: placed ? text : cut === -1 ? null : text.slice(cut + ' | rationale: '.length),
      accepted: placed && result.success === true, orderId: placed && result.orderId !== undefined ? result.orderId : null,
      reason: placed ? (result.success === true ? null : result.errorMessage || result.errorName || 'refused') : (cut === -1 ? text : text.slice(0, cut)),
    };
  }).filter(e => Number.isFinite(e.ms));
}

/**
 * @param opts.unfinished label a run that isn't finished (writeLabels allows it only into a folder outside the run home)
 */
function labelRun(runDir, { budgetUsd = null, strategies = [], outcomeBars = null, unfinished = false } = {}) {
  const dir = path.resolve(runDir);
  const { manifest, days } = readRun(dir);
  // Labels hold what came after each decision (outcomes, counterfactuals). A run that will go on would let
  // its teacher read them on resume (the run home is its harness home): only a finished run is labelled in place.
  const why = unfinishedWhy(manifest, days);
  if (why && !unfinished) {
    throw new Error(`run ${manifest.runId} is not finished (${why}): run it to its end first, or write the labels outside the run home with --out <dir> (labels hold what came after each decision, which a resumed teacher could read)`);
  }
  const home = path.resolve(dir, '..', '..');
  const cfg = readJson(path.join(dir, 'autotrader.json'), {}) || {};
  const tf = Number(cfg.timeframe) || null;
  const tfMs = tf ? tf * 60000 : 0;
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
  const barsFor = sym => {
    if (!barsBySym.has(sym)) barsBySym.set(sym, loadBars(home, sym, tf));
    return barsBySym.get(sym);
  };
  const fills = allFills(lines);
  const trips = roundTrips(fills);
  const cycleStarts = lines.flatMap(r => (r.cycles || []).map(c => Date.parse(c.at))).filter(Number.isFinite).sort((a, b) => a - b);
  const journal = brokerOrders(path.join(dir, 'broker', 'journal.jsonl'));
  const journalUsed = new Set();
  const lineTimes = lines.map(r => Date.parse(r.t));

  // Pass 1: every decision's orders and action.
  const drafts = [];
  for (const [li, rec] of lines.entries()) {
    const t = Date.parse(rec.t);
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
      tradeCycles.push({ c, ctx, failed, orders: Number.isFinite(start) ? cycleOrders(c, doc, gateLog, until) : [], result: c.result || (ran && ran.result) || null, symbols: ctx && Array.isArray(ctx.symbols) ? objs(ctx.symbols).map(s => s.symbol) : null });
    }
    // A cycle that ran with no cycle log line: a decision whose orders are unknown.
    const ranTrade = (rec.ran || []).filter(x => x.action === 'trade' || x.action === 'manage');
    for (const x of ranTrade.slice(tradeCycles.length)) {
      const failed = x.timedOut ? 'cycle timed out' : x.ok === false ? 'cycle failed' : null;
      tradeCycles.push({ c: null, ctx: null, failed, orders: [], unknown: true, result: x.result || null, symbols: Array.isArray(x.symbols) ? x.symbols : null });
    }
    const syms = [...new Set([
      ...(rec.bars || []).map(b => b && b.symbol), ...ranTrade.flatMap(x => x.symbols || []), ...tradeCycles.flatMap(x => x.symbols || []),
    ].filter(Boolean))].sort();
    if (!syms.length && Array.isArray(cfg.symbols)) syms.push(...[...cfg.symbols].sort());
    if (!syms.length) syms.push(null);
    const famsInLine = syms.map(s => familyOfId(s));
    for (const symbol of syms) {
      const fam = familyOfId(symbol);
      const cyc = tradeCycles.find(x => !x.symbols || !symbol || x.symbols.includes(symbol)) || null;
      const ctxSym = cyc && cyc.ctx && Array.isArray(cyc.ctx.symbols) ? cyc.ctx.symbols.find(s => s.symbol === symbol) : null;
      const barRec = (rec.bars || []).find(b => b && b.symbol === symbol);
      const barT = (ctxSym && ctxSym.bar && ctxSym.bar.t) || (barRec && barRec.lastBarT) || null;
      const scanList = (scans.get(`${symbol}|${barT}`) || []).filter(s => Date.parse(s.at) <= t);
      const scan = scanList[scanList.length - 1] || null;
      const fired = scan ? (scan.results || []).filter(r => r.candidate && r.direction) : [];
      const candidates = fired.map(r => ({ name: r.name, direction: r.direction }));
      const refPrice = scan && scan.bar && num(scan.bar.c) !== null ? scan.bar.c : ctxSym && ctxSym.bar && num(ctxSym.bar.c) !== null ? ctxSym.bar.c : null;
      const isTradeTime = rec.kind === 'trade';
      const signal = { close: scan && scan.bar && num(scan.bar.c) !== null ? scan.bar.c : null, fired };
      const draft = { rec, t, symbol, fam, barT, candidates, refPrice, signal, cyc, ctx: cyc && cyc.ctx };
      if (!isTradeTime) draft.decision = 'housekeeping';
      else if (!cyc) draft.decision = 'no-cycle';
      else {
        const mine = cyc.orders.filter(o => {
          const of = familyOfId(o.contractId);
          if (of) return of === fam;
          return famsInLine.length === 1; // no contract named (modify, cancel): the cycle's only symbol
        });
        const pos = positionAt(fam, cyc.ctx, fills, t);
        draft.position = pos;
        draft.decision = pos.side ? 'in-trade' : 'flat';
        draft.orders = mine;
        // What the broker did with each entry the gate let through: its journal at the replayed time
        // (from t to the next decision time), matched by rationale, in order.
        for (const o of mine.filter(x => x.tool === 'place_order' && x.gate.decision === 'allowed')) {
          const j = journal.find(e => !journalUsed.has(e) && e.ms >= t && e.ms < nextT && e.rationale !== null && e.rationale === o.rationale);
          if (!j) continue;
          journalUsed.add(j);
          o.broker = { decision: j.accepted ? 'accepted' : 'refused', orderId: j.orderId, reason: j.reason };
        }
        draft.act = teacherAction(mine, Boolean(pos.side));
        if (cyc.unknown) draft.act.reasons.push('no cycle log');
        // A failed or timed-out cycle's silence is no decision: never a skip, never cloned.
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
  const takenEntries = drafts.filter(d => d.decision === 'flat' && d.act && d.act.order && !refusedBy(d.act.order) && d.act.order.side);
  // The broker's order id first (its journal names it, its fills carry it), then the time rule.
  for (const rt of trips.filter(x => x.openMs !== null && x.opens[0].orderId !== undefined && x.opens[0].orderId !== null)) {
    const d = takenEntries.find(x => !entryOf.has(x) && x.act.order.broker.orderId !== null && String(x.act.order.broker.orderId) === String(rt.opens[0].orderId)
      && x.fam === rt.family && x.t <= rt.openMs);
    if (d) entryOf.set(d, rt);
  }
  const joined = new Set(entryOf.values());
  for (const rt of trips.filter(x => x.openMs !== null && !joined.has(x))) {
    const cands = takenEntries.filter(d => !entryOf.has(d) && d.fam === rt.family && d.act.order.side === rt.side && d.t <= rt.openMs
      && tradingDayKey(new Date(d.t)) === tradingDayKey(new Date(rt.openMs)));
    if (cands.length) entryOf.set(cands[cands.length - 1], rt);
  }
  const matchedTrips = new Set(entryOf.values());

  // Counterfactuals walk forward on future bars (by design): only ever written into outcome fields.
  const futureBars = sym => (outcomeBars && Array.isArray(outcomeBars[sym]) ? outcomeBars[sym] : barsFor(sym));
  const byName = new Map((strategies || []).filter(x => x && x.name && x.valid !== false).map(x => [x.name, x]));
  const simulated = (d, spec) => d.signal.fired.map(r => simulate({
    bars: futureBars(d.symbol), tfMs, signalMs: Date.parse(d.barT), signalClose: d.signal.close, direction: r.direction,
    stopDistance: num(r.stopDistance), targetDistance: num(r.targetDistance), strategy: byName.get(r.name) || null, spec, eodMs: eodOf(cfg, d.t),
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
  const labels = [];
  for (const d of drafts) {
    const { rec } = d;
    const spec = specFor(d.symbol) || (d.fam ? specFor(d.fam) : null);
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
      const ospec = isEntry ? contractSpec(o.contractId, d.symbol) : spec;
      const atr = isEntry ? atrAt(barsFor(d.symbol), tfMs, d.t) : null;
      const stop = isEntry ? stopOf(o, ospec, d.refPrice, atr) : null;
      const size = isEntry ? sizeOf(o, ospec, stop, budgetFor(budgetUsd)) : null;
      // A target bracket is the strategy's own exit when it is what order_plan places for the setup
      // (the env applies the strategy's exit); any other target is the teacher's, which the student can't express.
      let target = null;
      if (isEntry && o.targetTicks) {
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
        const by = refusedBy(o);
        gate = { decision: by ? 'refused' : 'allowed', by, checks: o.gate.checks, ...(by === 'broker' ? { brokerReason: o.broker.reason } : {}) };
      }
      reasons.push(...d.act.reasons.filter(r => !(r === 'explicit target' && target && target.from === 'strategy')));
      if (isEntry && !stop.points) reasons.push('no stop');
      else if (isEntry && stop.outOfRange) reasons.push('stop out of ATR range');
      else if (isEntry && stop.multiple === null) reasons.push('stop not mapped to ATR');
      if (d.decision === 'in-trade') {
        const open = trips.find(x => x.family === d.fam && (x.openMs === null || x.openMs <= d.t) && (x.closeMs === null || x.closeMs >= d.t)) || null;
        outcome = open ? outcomeOf(open, null) : null;
      } else if (isEntry) outcome = gate.decision === 'allowed' ? (rt ? outcomeOf(rt, stop && stop.ticks) : { filled: false, result: 'unfilled' }) : { filled: false, result: 'refused' };
      counterfactualFor = isEntry ? (gate.decision === 'allowed' ? 'taken' : 'refused intent') : d.decision === 'flat' && d.act.action === 'none' ? 'skip' : null;
      if (isEntry && gate.decision === 'allowed') {
        counterfactuals = [fromFills(outcome, { stopPoints: stop && stop.points, targetTicks: o.targetTicks, spec: ospec, bars: futureBars(d.symbol), tfMs, strategy: o.setup, direction: d.act.action })];
      } else if (d.decision === 'flat' && (counterfactualFor === 'skip' || counterfactualFor === 'refused intent') && d.candidates.length && !d.cyc.failed) {
        // A skip, or an intent refused (by the gate or the broker): what the candidates would have done.
        counterfactuals = simulated(d, spec);
      }
    } else if (d.decision === 'no-cycle') {
      reasons.push('no cycle');
      counterfactualFor = 'no cycle';
      if (d.candidates.length && d.barT) counterfactuals = simulated(d, spec);
    }
    else reasons.push('not a trade decision');
    if (rec.interrupted) reasons.push('interrupted');
    const cyc = d.cyc && d.cyc.c;
    const promptHash = cyc ? cyc.promptHash || null : null;
    labels.push({
      v: VERSION,
      key: crypto.createHash('sha256').update(`${manifest.runId}|${rec.t}|${d.symbol}|${promptHash}`).digest('hex').slice(0, 24),
      runId: manifest.runId, t: rec.t, day: rec.day, kind: rec.kind, symbol: d.symbol, barT: d.barT,
      decision: d.decision, interrupted: Boolean(rec.interrupted), cycleFailed: d.cyc ? d.cyc.failed : null, position: d.position || null,
      candidates: d.candidates, teacher, gate, outcome,
      counterfactual: counterfactuals.length ? pickCounterfactual(d, counterfactuals) : null, counterfactuals, counterfactualFor: counterfactuals.length ? counterfactualFor : null,
      clone: { ok: Boolean(teacher) && reasons.length === 0, reasons: [...new Set(reasons)] },
      result: d.cyc ? d.cyc.result : ((rec.ran || [])[0] || {}).result || null,
      provenance: { harness: manifest.harness || null, model: manifest.model || null, configHash: manifest.hash || null, strategiesHash, promptHash, cycleFile: cyc ? relCycle(home, cyc.file) : null },
    });
  }
  const summary = summarize(labels, {
    runId: manifest.runId, strategiesHash, unfinished: why, torn: tornLines(dir), unattributedOrders: unattributed.size,
    // Order records the gate made outside every trade cycle (the runner's own, or a cycle with no log line).
    gateRecordsOutsideCycles: gateLog.filter(e => gateTool(e) && !e.inCycle).length,
    fillsUnread: lines.filter(r => r.trades && !Array.isArray(r.trades)).length,
    unmatchedOpenings: trips.filter(x => x.openMs !== null && !matchedTrips.has(x)).length,
  });
  return { labels, summary };
}

function summarize(labels, extra) {
  const n = f => labels.filter(f).length;
  const decision = l => l.decision === 'flat' || l.decision === 'in-trade';
  const entry = l => l.decision === 'flat' && (l.teacher.action === 'long' || l.teacher.action === 'short');
  const taken = l => entry(l) && l.gate.decision === 'allowed';
  const decisions = n(decision);
  const cloneable = n(l => decision(l) && l.clone.ok);
  const skipped = l => l.decision === 'flat' && !l.cycleFailed && l.teacher.action === 'none' && l.candidates.length > 0;
  const cf = (f, result) => n(l => f(l) && l.counterfactual && l.counterfactual.result === result);
  const noCycleCands = l => l.decision === 'no-cycle' && l.candidates.length > 0;
  const refusedIntent = l => entry(l) && l.gate.decision === 'refused';
  return {
    v: VERSION, runId: extra.runId, strategiesHash: extra.strategiesHash, labels: labels.length, decisions,
    flat: n(l => l.decision === 'flat'), inTrade: n(l => l.decision === 'in-trade'),
    entries: n(entry), taken: n(taken), refused: n(l => decision(l) && l.gate.decision === 'refused'),
    skipped: n(skipped),
    standAside: n(l => l.decision === 'flat' && !l.cycleFailed && l.teacher.action === 'none' && !l.candidates.length),
    holds: n(l => decision(l) && l.teacher.action === 'hold'), tightens: n(l => decision(l) && l.teacher.action === 'tighten'), exits: n(l => decision(l) && l.teacher.action === 'exit'),
    wins: n(l => taken(l) && l.outcome && l.outcome.result === 'win'), losses: n(l => taken(l) && l.outcome && l.outcome.result === 'loss'),
    scratches: n(l => taken(l) && l.outcome && l.outcome.result === 'scratch'), unfilled: n(l => taken(l) && l.outcome && l.outcome.result === 'unfilled'),
    open: n(l => taken(l) && l.outcome && l.outcome.result === 'open'),
    cloneable, uncloneable: decisions - cloneable, coverage: decisions ? round(cloneable / decisions) : null,
    unmapped: n(l => entry(l) && l.teacher.stop && l.teacher.stop.points && l.teacher.stop.multiple === null),
    unfinished: extra.unfinished,
    unsized: n(l => entry(l) && l.teacher.size && l.teacher.size.step === null),
    noCycle: n(l => l.decision === 'no-cycle'), noCycleWithCandidates: n(l => l.decision === 'no-cycle' && l.candidates.length > 0),
    housekeeping: n(l => l.decision === 'housekeeping'), interrupted: n(l => l.interrupted),
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
      try { return path.join(fs.realpathSync(dir), rest); } catch (_err) { if (dir === path.dirname(dir)) return abs; }
    }
  };
  const rel = path.relative(real(root), real(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
  return aggregate(bars, { unit: 2, unitNumber: tf, nowMs: Infinity }).map(b => ({ ...b, ms: Date.parse(b.t) }));
}

/** @param opts.barsFiles { SYMBOL: file } the data the run replayed, for the counterfactuals */
/**
 * @param opts.barsFiles { SYMBOL: file } the data the run replayed, for the counterfactuals
 * @param opts.outDir where to write (default the run dir); required for an unfinished run, and then
 *   outside the run home (its teacher, on resume, must not read what came after its decisions)
 */
function writeLabels(runDir, { root = null, budgetUsd = null, strategies = [], barsFiles = {}, outDir = null } = {}) {
  const dir = path.resolve(runDir);
  const out = outDir ? path.resolve(expandHome(outDir)) : dir;
  const home = path.resolve(dir, '..', '..');
  if (root && (inside(dir, root) || inside(out, root))) throw new Error(`${inside(out, root) ? out : dir} is inside the repository (${root}): labels are written to the run's own folder or --out, never the repository`);
  if (outDir && inside(out, home)) throw new Error(`--out ${out} is inside the run home (${home}): write the labels of an unfinished run outside it`);
  const tf = Number((readJson(path.join(dir, 'autotrader.json'), {}) || {}).timeframe) || null;
  if (Object.keys(barsFiles).length && !tf) throw new Error(`${dir}: no runner timeframe (autotrader.json) to read the bars at`);
  const outcomeBars = Object.fromEntries(Object.entries(barsFiles).map(([sym, f]) => [sym, outcomeBarsFrom(f, tf)]));
  const { labels, summary } = labelRun(dir, { budgetUsd, strategies, outcomeBars: Object.keys(outcomeBars).length ? outcomeBars : null, unfinished: Boolean(outDir) });
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'labels.jsonl');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, labels.map(l => `${JSON.stringify(l)}\n`).join(''));
  fs.renameSync(tmp, file);
  writeJsonAtomic(path.join(out, 'labels-summary.json'), summary);
  return { file, summary };
}

const SUMMARY_KEYS = ['labels', 'decisions', 'taken', 'skipped', 'refused', 'wins', 'losses', 'uncloneable', 'unmapped', 'unsized', 'noCycle', 'noCycleWithCandidates', 'interrupted', 'coverage',
  'takenWon', 'takenLost', 'skippedWouldWin', 'skippedWouldLose', 'refusedWouldWin', 'refusedWouldLose', 'noCycleWouldWin', 'noCycleWouldLose', 'unsimulated', 'brokerRefused', 'priorRefusals', 'cycleFailed'];
const summaryText = s => `${SUMMARY_KEYS.map(k => `${k} ${s[k] === null ? '-' : s[k]}`).join(', ')}\n${Object.keys(s.uncloneableBy).length ? `uncloneable by reason: ${Object.entries(s.uncloneableBy).map(([k, v]) => `${k} ${v}`).join(', ')}\n` : ''}`;

module.exports = { VERSION, STOP_ATR_MULTIPLES, STOP_ATR_RANGE, SIZE_STEPS, ATR_PERIOD, ATR_WINDOW, labelRun, writeLabels, summaryText, roundTrips, outcomeOf, atrAt, teacherAction, stopOf, sizeOf, collapsePairs, brokerOrders, contractSpec };
