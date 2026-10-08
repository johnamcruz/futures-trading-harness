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

/** Net position in exactly this contract month. */
function contractNet(positions, contractId) {
  return positions
    .filter(p => p.contractId === contractId)
    .reduce((n, p) => {
      const sign = POSITION_SIGN[p.type];
      if (sign === undefined) throw new Error(`position with unknown type ${JSON.stringify(p.type)}`);
      return n + sign * Number(p.size || 0);
    }, 0);
}

/** Open positions in any month of the contract's root (a long and a short in two months don't make it flat). */
function openPositions(positions, contractId) {
  const root = contractRoot(contractId);
  return positions.filter(p => contractRoot(p.contractId) === root && Number(p.size || 0) > 0);
}

/**
 * Market orders the gateway let through recently that the account may not
 * show yet. Each ledger entry is { contractId, sign, size, netBefore, at } and
 * lives for ttlMs. Together, the live entries for a root project the net the
 * account will show once all of them fill: the oldest entry's net before it
 * was sent plus every entry's change. Returns { projected, pending }, where
 * pending is true while the observed net hasn't reached the projection.
 */
function pendingState(ledger, contractId, observed, now, ttlMs = 30000, { exact = false } = {}) {
  const root = contractRoot(contractId);
  const live = (ledger || [])
    .filter(e => (exact ? e.contractId === contractId : contractRoot(e.contractId) === root) && now.getTime() - e.at < ttlMs)
    .sort((a, b) => a.at - b.at);
  if (live.length === 0) return { projected: observed, pending: false };
  const anchor = exact ? live[0].netBefore : (live[0].rootNetBefore ?? live[0].netBefore);
  const projected = anchor + live.reduce((n, e) => n + e.sign * e.size, 0);
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

/** Size of resting orders of `types` on this side, in exactly this contract month. */
function restingSize(orders, contractId, sideSign, types) {
  return orders
    .filter(o => o.contractId === contractId && types.has(Number(o.type)))
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
  const root = contractRoot(input.contractId);

  if (isRiskReducing(input.rationale)) {
    // An exit reduces the position in its own contract month: the position
    // the account shows and the one it will show once recent orders fill.
    const observed = contractNet(positions, input.contractId);
    const { projected } = pendingState(ledger, input.contractId, observed, now, undefined, { exact: true });
    const elsewhere = observed === 0 ? openPositions(positions, input.contractId).map(p => p.contractId) : [];
    for (const net of observed === projected ? [observed] : [observed, projected]) {
      const before = violations.length;
      if (net === 0) {
        add('exposure', elsewhere.length
          ? `[exit]/[protect] order on ${input.contractId}, but the open ${root} position is in ${elsewhere.join(', ')}; send the exit for that contract.`
          : `[exit]/[protect] order but there is no open ${input.contractId} position${net === observed ? '' : ' once recent orders fill'}; it would open one. Label entries setup:<name>.`);
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

  // Entries: flat means no position in any month of the root, and nothing
  // sent moments ago that hasn't shown up yet.
  const open = openPositions(positions, input.contractId);
  const rootNet = netPosition(positions, input.contractId);
  const { projected } = pendingState(ledger, input.contractId, rootNet, now);
  const busy = open.length > 0 || projected !== rootNet || projected !== 0;
  add('position-open', busy
    ? (open.length
      ? `A ${root} position is open (${open.map(p => `${p.contractId} ${POSITION_SIGN[p.type] > 0 ? 'long' : 'short'} ${p.size}`).join(', ')}). Manage it; new entries wait until it is flat. To reduce, use an [exit] order.`
      : `A ${root} position is about to open (a recent order has not shown up yet, net ${projected}). New entries wait until it is flat.`)
    : null);
  const working = busy ? [] : orders.filter(o => contractRoot(o.contractId) === root);
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
  const net = contractNet(positions, order.contractId);
  const orderSign = Number(order.side) === 0 ? 1 : -1;
  if (net === 0 || orderSign !== -Math.sign(net)) return [];
  const otherStops = restingSize(orders.filter(o => o !== order), order.contractId, orderSign, STOP_TYPES);
  if (otherStops >= Math.abs(net)) return [];
  return [{ check: 'cancel-protection', message: `Order ${order.id} is the protective stop for the open ${contractRoot(order.contractId)} position (net ${net}). Move it with modify_order, or close the position first ([exit]).` }];
}

/**
 * modify_order checks that need the account. An order "works" an open
 * position when it sits on the opposite side of a position in its own
 * contract month (a protective stop or a target).
 * - size: only a decrease; a protective stop's cut must leave the stops
 *   covering the position (cut it after a partial exit, not before);
 * - price: only orders that work an open position may be repriced (moving
 *   an entry or a leftover order would open a trade past the entry checks:
 *   cancel it and place a new order through the gate), and a protective
 *   stop only toward the market, checking every price field given.
 */
function evaluateModifyAccount({ input = {}, positions, orders, config }) {
  for (const [name, v] of Object.entries({ positions, orders })) {
    if (!Array.isArray(v)) throw new Error(`${name} from the server is not a list`);
  }
  const skip = (config && config.skipChecks) || new Set();
  const violations = [];
  const add = (check, message) => { if (!skip.has(check)) violations.push({ check, message }); };
  const order = orders.find(o => Number(o.id) === Number(input.orderId));
  if (!order) {
    add('modify-protection', `Order ${input.orderId} is not working, so the change can't be checked. Check list_open_orders; cancel and re-place through the gate if needed.`);
    return violations;
  }
  const net = contractNet(positions, order.contractId);
  const orderSign = Number(order.side) === 0 ? 1 : -1;
  const works = net !== 0 && orderSign === -Math.sign(net);
  const isStop = STOP_TYPES.has(Number(order.type));
  const root = contractRoot(order.contractId);

  if (input.size !== undefined && input.size !== null) {
    const size = Number(input.size);
    if (!(Number.isInteger(size) && size >= 1 && size < Number(order.size))) {
      add('modify-size', `modify_order may only reduce an order's size (order ${order.id} is ${order.size}, asked ${input.size}). To add, place a new order through the gate.`);
    } else if (works && isStop) {
      const others = restingSize(orders.filter(o => o !== order), order.contractId, orderSign, STOP_TYPES);
      if (size + others < Math.abs(net)) {
        add('modify-size', `Cutting stop ${order.id} to ${size} would leave ${Math.abs(net) - size - others} of the open ${root} position (net ${net}) without a stop. Reduce the position first ([exit] or partial_close_position), then cut the stop.`);
      }
    }
  }

  const fields = ['limitPrice', 'stopPrice', 'trailPrice'].filter(f => input[f] !== undefined && input[f] !== null);
  if (!fields.length) return violations;
  if (!works) {
    add('modify-entry', `Order ${order.id} doesn't work an open ${order.contractId} position (it is an entry or a leftover), so repricing it could open a trade without the entry checks. Cancel it and place a new order through the gate.`);
    return violations;
  }
  if (!isStop) return violations;
  const old = order.stopPrice === null || order.stopPrice === undefined ? NaN : Number(order.stopPrice);
  for (const field of fields.filter(f => f !== 'limitPrice')) {
    const level = Number(input[field]);
    if (!Number.isFinite(level) || !Number.isFinite(old)) {
      add('modify-protection', `Can't tell where the protective stop ${order.id} for the open ${root} position is; it can't be moved. Close the position ([exit]) instead.`);
      break;
    }
    if (net > 0 ? level < old : level > old) {
      add('modify-protection', `Order ${order.id} protects the open ${root} position (net ${net}); move it toward the market only (now ${old}, asked ${field} ${level}). To take more risk, don't; to get out, use an [exit] order.`);
      break;
    }
  }
  return violations;
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
  parseToolJson, netPosition, contractNet, openPositions, pendingState, pendingNet, closingFills, fillLossState, evaluateAccount, evaluateCancel,
  evaluateModifyAccount, barsRequest, regimeGatedStrategy, regimeViolation, STOP_TYPES,
};
