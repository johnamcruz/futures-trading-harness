'use strict';

/**
 * Account-aware order checks, run by the MCP gateway, which can ask projectx-mcp
 * for the live account state. These checks don't trust the model's labels
 * or its self-graded reviews:
 *
 * - `[exit]` / `[protect]` orders must actually reduce the open position:
 *   opposite side, size within the position, and resting protective orders
 *   (stops, limits) never stacking beyond it.
 * - Entries are refused while a position in the contract is open (no adds,
 *   no flips disguised as entries), or while orders are working in it.
 * - A protective stop may only be moved closer to the market, never away.
 * - Loss streak and daily loss count come from real closing fills
 *   (profitAndLoss), not from journal tags.
 */

const { contractRoot } = require('./journal');
const { isRiskReducing } = require('./order-gate');
const { normalizeBars } = require('./indicators');
const { classifyRegime, regimeFits } = require('./regime');

const POSITION_SIGN = { 1: 1, 2: -1 };
const STOP_TYPES = new Set([3, 4, 5]); // stop_limit, stop, trailing_stop
const LIMIT_TYPES = new Set([1, 6, 7]); // limit, join_bid, join_ask (all rest in the book)
const ORDER_TYPE_IDS = { limit: 1, market: 2, stop: 4, trailing_stop: 5, join_bid: 6, join_ask: 7 };
const SIDE_SIGN = { buy: 1, sell: -1 };

/** Parse a tools/call result whose first text content is JSON. Throws on error results. */
function parseToolJson(result, tool) {
  if (!result || result.isError) {
    const text = result && result.content && result.content[0] ? result.content[0].text : 'no result';
    throw new Error(`${tool} failed: ${String(text).slice(0, 200)}`);
  }
  const text = result.content && result.content[0] && result.content[0].text;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${tool} returned non-JSON content`, { cause: err });
  }
}

/** Net position across every contract month of the same root (MNQ.Z26 and MNQ.H27 both count). */
function netPosition(positions, contractId) {
  const root = contractRoot(contractId);
  return positions
    .filter(p => contractRoot(p.contractId) === root)
    .reduce((n, p) => {
      const sign = POSITION_SIGN[p.type];
      if (sign === undefined) throw new Error(`position with unknown type ${JSON.stringify(p.type)}`);
      return n + sign * Number(p.size || 0);
    }, 0);
}

/**
 * Market orders the gateway let through recently that the account may not
 * show yet. Each ledger entry is { contractId, sign, size, netBefore, at } and
 * lives for ttlMs. Together, the live entries for a root project the net the
 * account will show once all of them fill: the oldest entry's net before it
 * was sent plus every entry's change. Returns { projected, pending }, where
 * pending is true while the observed net hasn't reached the projection.
 */
function pendingState(ledger, contractId, observed, now, ttlMs = 30000) {
  const root = contractRoot(contractId);
  const live = (ledger || [])
    .filter(e => contractRoot(e.contractId) === root && now.getTime() - e.at < ttlMs)
    .sort((a, b) => a.at - b.at);
  if (live.length === 0) return { projected: observed, pending: false };
  const projected = live[0].netBefore + live.reduce((n, e) => n + e.sign * e.size, 0);
  return { projected, pending: projected !== observed };
}

/** Net change still expected from recent market orders (projected minus observed). */
function pendingNet(ledger, contractId, observed, now, ttlMs = 30000) {
  return pendingState(ledger, contractId, observed, now, ttlMs).projected - observed;
}

/** Closing fills of the trading day in time order: [{ pnl, ts }]. */
function closingFills(trades) {
  return (trades || [])
    .filter(t => t && t.profitAndLoss !== null && t.profitAndLoss !== undefined && !t.voided)
    .map(t => ({ pnl: Number(t.profitAndLoss), ts: Date.parse(t.creationTimestamp) }))
    .filter(f => Number.isFinite(f.pnl))
    .sort((a, b) => a.ts - b.ts);
}

function fillLossState(trades) {
  let streak = 0;
  let losses = 0;
  let lastLossTs = null;
  for (const f of closingFills(trades)) {
    if (f.pnl < 0) {
      streak += 1;
      losses += 1;
      lastLossTs = f.ts;
    } else if (f.pnl > 0) {
      streak = 0;
    }
  }
  return { streak, losses, lastLossTs };
}

function restingSize(orders, contractId, sideSign, types) {
  const root = contractRoot(contractId);
  return orders
    .filter(o => contractRoot(o.contractId) === root && types.has(Number(o.type)))
    .filter(o => (Number(o.side) === 0 ? 1 : -1) === sideSign)
    .reduce((n, o) => n + Number(o.size || 0), 0);
}

/**
 * Returns violations [{check, message}] for a place_order given live facts
 * { positions, orders, trades } from projectx-mcp.
 */
function evaluateAccount({ input = {}, positions, orders, trades, now = new Date(), config, ledger = [] }) {
  // Missing or malformed account data must block, never read as "flat".
  for (const [name, v] of Object.entries({ positions, orders, trades })) {
    if (!Array.isArray(v)) throw new Error(`${name} from the server is not a list`);
  }
  const skip = (config && config.skipChecks) || new Set();
  const violations = [];
  const add = (check, message) => {
    if (message && !skip.has(check)) violations.push({ check, message });
  };

  const sideSign = SIDE_SIGN[String(input.side || '').toLowerCase()];
  const size = Number(input.size);
  const observed = netPosition(positions, input.contractId);
  // Orders sent moments ago that the account doesn't show yet.
  const { projected } = pendingState(ledger, input.contractId, observed, now);
  const root = contractRoot(input.contractId);

  if (isRiskReducing(input.rationale)) {
    // Must reduce both the position the account shows and the one it will
    // show once recent orders fill, whichever way the fills land.
    for (const net of observed === projected ? [observed] : [observed, projected]) {
      const before = violations.length;
      if (net === 0) {
        add('exposure', `[exit]/[protect] order but there is no open ${root} position${net === observed ? '' : ' once recent orders fill'}; it would open one. Label entries setup:<name>.`);
      } else if (sideSign !== -Math.sign(net)) {
        add('exposure', `[exit]/[protect] order is on the same side as the open ${root} position (net ${net}); it would add exposure.`);
      } else if (!(size > 0) || size > Math.abs(net)) {
        add('exposure', `[exit]/[protect] size ${input.size} exceeds the open ${root} position (${Math.abs(net)}).`);
      } else {
        const typeId = ORDER_TYPE_IDS[String(input.type || '').toLowerCase()];
        const group = STOP_TYPES.has(typeId) ? STOP_TYPES : LIMIT_TYPES.has(typeId) ? LIMIT_TYPES : null;
        if (group && restingSize(orders, input.contractId, sideSign, group) + size > Math.abs(net)) {
          add('exposure', `Resting ${group === STOP_TYPES ? 'stop' : 'limit'} orders plus this one would exceed the open ${root} position (${Math.abs(net)}); they could fill into a new position.`);
        }
      }
      if (violations.length > before) break;
    }
    return violations;
  }

  const net = observed !== 0 ? observed : projected;
  add('position-open', net !== 0
    ? `A ${root} position is open${observed === 0 ? ' or about to be (a recent order has not shown up yet)' : ''} (net ${net}). Manage it; new entries wait until it is flat. To reduce, use an [exit] order.`
    : null);
  const working = net === 0 ? orders.filter(o => contractRoot(o.contractId) === root) : [];
  add('working-orders', working.length
    ? `${working.length} ${root} order${working.length === 1 ? ' is' : 's are'} working while flat (${working.map(o => o.id).join(', ')}). `
      + 'Cancel leftovers (stops or targets of a closed trade) or let a pending entry work; one entry at a time.'
    : null);

  const { streak, losses, lastLossTs } = fillLossState(trades);
  if (streak >= config.maxConsecutiveLosses && lastLossTs !== null) {
    const remaining = lastLossTs + config.lossCooldownMin * 60000 - now.getTime();
    add('loss-streak', remaining > 0
      ? `${streak} losing closes in a row (from fills). Cooling down for ${Math.ceil(remaining / 60000)} min more.`
      : null);
  }
  add('daily-loss-count', losses >= config.maxDailyLosses
    ? `${losses} losing closes this trading day (from fills; limit ${config.maxDailyLosses}). Done until 17:00 CT.`
    : null);
  return violations;
}

/**
 * cancel_order may not remove the last protective stop of an open position
 * (move it with modify_order instead, or close the position first).
 */
function evaluateCancel({ input = {}, positions, orders, config }) {
  for (const [name, v] of Object.entries({ positions, orders })) {
    if (!Array.isArray(v)) throw new Error(`${name} from the server is not a list`);
  }
  const skip = (config && config.skipChecks) || new Set();
  if (skip.has('cancel-protection')) return [];
  const order = orders.find(o => Number(o.id) === Number(input.orderId));
  if (!order || !STOP_TYPES.has(Number(order.type))) return [];
  const net = netPosition(positions, order.contractId);
  const orderSign = Number(order.side) === 0 ? 1 : -1;
  if (net === 0 || orderSign !== -Math.sign(net)) return [];
  const otherStops = restingSize(orders.filter(o => o !== order), order.contractId, orderSign, STOP_TYPES);
  if (otherStops >= Math.abs(net)) return [];
  return [{ check: 'cancel-protection', message: `Order ${order.id} is the protective stop for the open ${contractRoot(order.contractId)} position (net ${net}). Move it with modify_order, or close the position first ([exit]).` }];
}

/**
 * modify_order may move a protective stop (a stop on the opposite side of an
 * open position) only toward the market: tightening risk, never widening it
 * or parking it where it can't trigger.
 */
function evaluateModifyAccount({ input = {}, positions, orders, config }) {
  for (const [name, v] of Object.entries({ positions, orders })) {
    if (!Array.isArray(v)) throw new Error(`${name} from the server is not a list`);
  }
  const skip = (config && config.skipChecks) || new Set();
  if (skip.has('modify-protection')) return [];
  const order = orders.find(o => Number(o.id) === Number(input.orderId));
  if (!order || !STOP_TYPES.has(Number(order.type))) return [];
  const net = netPosition(positions, order.contractId);
  const orderSign = Number(order.side) === 0 ? 1 : -1;
  if (net === 0 || orderSign !== -Math.sign(net)) return [];
  const raw = input.stopPrice ?? input.trailPrice;
  if (raw === undefined || raw === null) return [];
  const level = Number(raw);
  const old = order.stopPrice === null || order.stopPrice === undefined ? NaN : Number(order.stopPrice);
  const root = contractRoot(order.contractId);
  if (!Number.isFinite(level) || !Number.isFinite(old)) {
    return [{ check: 'modify-protection', message: `Can't tell where the protective stop ${order.id} for the open ${root} position is; it can't be moved. Close the position ([exit]) instead.` }];
  }
  const widens = net > 0 ? level < old : level > old;
  return widens
    ? [{ check: 'modify-protection', message: `Order ${order.id} protects the open ${root} position (net ${net}); move it toward the market only (now ${old}, asked ${level}). To take more risk, don't; to get out, use an [exit] order.` }]
    : [];
}

const SETUP = /^\s*setup:([a-z0-9][a-z0-9_-]*)\b/i;

/** get_bars arguments for a strategy timeframe such as 3m, 1h, 1d. */
function barsRequest(contractId, timeframe) {
  const m = /^(\d+)(m|h|d)$/.exec(String(timeframe || ''));
  if (!m) return null;
  const unit = { m: 'minute', h: 'hour', d: 'day' }[m[2]];
  return { contractId, unit, unitNumber: Number(m[1]), limit: 300, includePartialBar: false };
}

/**
 * The strategy an entry names, when that strategy asks for its regime to be
 * enforced (regime_gate: true). Returns null when no regime check applies.
 */
function regimeGatedStrategy(input, strategies) {
  if (isRiskReducing(input.rationale)) return null;
  const m = SETUP.exec(String(input.rationale || ''));
  const s = m && (strategies || []).find(x => x.name === m[1].toLowerCase());
  return s && s.valid && s.regime_gate === true && Array.isArray(s.regimes) ? s : null;
}

/** Violation when the live regime (from get_bars) doesn't fit the strategy's regimes. */
function regimeViolation(strategy, bars, config) {
  const skip = (config && config.skipChecks) || new Set();
  if (skip.has('regime')) return [];
  const regime = classifyRegime(normalizeBars(bars));
  if (regimeFits(strategy.regimes, regime)) return [];
  const now = regime ? `${regime.primary}, ${regime.volatility} volatility` : 'unknown (not enough bars)';
  return [{ check: 'regime', message: `setup:${strategy.name} trades only in ${strategy.regimes.join(', ')}; the ${strategy.timeframe} regime is ${now}.` }];
}

module.exports = {
  parseToolJson, netPosition, pendingState, pendingNet, closingFills, fillLossState, evaluateAccount, evaluateCancel,
  evaluateModifyAccount, barsRequest, regimeGatedStrategy, regimeViolation, STOP_TYPES,
};
