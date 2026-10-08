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
 *   no flips disguised as entries).
 * - Loss streak and daily loss count come from real closing fills
 *   (profitAndLoss), not from journal tags.
 */

const { contractRoot } = require('./journal');
const { isRiskReducing } = require('./order-gate');

const POSITION_SIGN = { 1: 1, 2: -1 };
const STOP_TYPES = new Set([3, 4, 5]); // stop_limit, stop, trailing_stop
const LIMIT_TYPES = new Set([1]);
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

function netPosition(positions, contractId) {
  return (positions || [])
    .filter(p => p.contractId === contractId)
    .reduce((n, p) => n + (POSITION_SIGN[p.type] || 0) * Number(p.size || 0), 0);
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
  return (orders || [])
    .filter(o => o.contractId === contractId && types.has(Number(o.type)))
    .filter(o => (Number(o.side) === 0 ? 1 : -1) === sideSign)
    .reduce((n, o) => n + Number(o.size || 0), 0);
}

/**
 * Returns violations [{check, message}] for a place_order given live facts
 * { positions, orders, trades } from projectx-mcp.
 */
function evaluateAccount({ input = {}, positions = [], orders = [], trades = [], now = new Date(), config }) {
  const skip = (config && config.skipChecks) || new Set();
  const violations = [];
  const add = (check, message) => {
    if (message && !skip.has(check)) violations.push({ check, message });
  };

  const sideSign = SIDE_SIGN[String(input.side || '').toLowerCase()];
  const size = Number(input.size);
  const net = netPosition(positions, input.contractId);
  const root = contractRoot(input.contractId);

  if (isRiskReducing(input.rationale)) {
    if (net === 0) {
      add('exposure', `[exit]/[protect] order but there is no open ${root} position; it would open one. Label entries setup:<name>.`);
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
    return violations;
  }

  add('position-open', net !== 0
    ? `A ${root} position is open (net ${net}). Manage it; new entries wait until it is flat. To reduce, use an [exit] order.`
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

module.exports = { parseToolJson, netPosition, closingFills, fillLossState, evaluateAccount };
