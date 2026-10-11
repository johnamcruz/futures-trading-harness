'use strict';

/**
 * The order gate's size and dollar-risk caps on an entry (a risk-increasing
 * place_order). The gate calls them for entries only: [exit] and [protect]
 * orders, close_position, partial_close_position, cancels and stop moves are
 * never checked here, whatever their size.
 *
 *   checkOrderSize(input, limit)        size a whole number of 1 or more, and at most the broker
 *                                       server's maxOrderSize (broker-specs.js brokerOrderLimit:
 *                                       its get_server_config answer, recorded locally); none
 *                                       recorded is a refusal (fail closed). Message or null.
 *   entryStopTicks(input, stopPrice, spec)
 *                                       the entry's stop in ticks: { ticks } or { why }. From
 *                                       stopLossBracket.ticks, or from the rationale's stop price
 *                                       measured from a limit or stop entry's own price (a tick
 *                                       part counts as a whole tick); with both, the larger.
 *   checkRiskLimit({ input, stopPrice, strategy, specOf })
 *                                       risk = size x stop ticks x tick value (the broker's spec)
 *                                       over the named strategy's risk.max_risk_usd, or a cap set
 *                                       and the risk not computable: a message; else null. For a
 *                                       policy strategy's entry the cap is the policy strategy's
 *                                       own (its components' caps don't apply: prop sizing sizes it).
 */

const { contractRoot } = require('./journal');

const EPS = 1e-9;
const money = x => `$${Number(x).toFixed(2)}`;
const wholeSize = size => {
  const n = typeof size === 'number' || (typeof size === 'string' && size.trim() !== '') ? Number(size) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
};

function checkOrderSize(input, limit) {
  const size = wholeSize(input.size);
  if (size === null) return `size ${JSON.stringify(input.size)} is not a whole number of contracts, 1 or more.`;
  if (!limit || !(Number.isInteger(limit.maxOrderSize) && limit.maxOrderSize >= 1)) {
    return `${(limit && limit.why) || 'the broker server\'s max order size is not recorded yet: call get_server_config, then try again'}.`;
  }
  if (size > limit.maxOrderSize) {
    return `size ${size} over the broker's max order size ${limit.maxOrderSize} (get_server_config maxOrderSize): reduce the size to ${limit.maxOrderSize} or less. Never split an entry into several orders to get under it.`;
  }
  return null;
}

function entryStopTicks(input, stopPrice, spec) {
  if (!spec) return { why: `no usable tick specs from the broker for ${contractRoot(input.contractId) || 'this contract'}` };
  const b = input.stopLossBracket;
  const hasBracket = b && b.ticks !== undefined && b.ticks !== null;
  const bracket = hasBracket ? Number(b.ticks) : null;
  if (hasBracket && !(Number.isInteger(bracket) && bracket > 0)) return { why: `stopLossBracket.ticks ${JSON.stringify(b.ticks)} is not a whole number of ticks above 0` };
  const type = String(input.type || '').toLowerCase();
  const field = type === 'limit' ? 'limitPrice' : type === 'stop' ? 'stopPrice' : null;
  const entry = field && input[field] !== undefined && input[field] !== null && input[field] !== '' ? Number(input[field]) : null;
  const stop = stopPrice === null || stopPrice === undefined ? null : Number(stopPrice);
  let fromText = null;
  if (entry !== null && stop !== null) {
    if (!Number.isFinite(entry) || !Number.isFinite(stop)) return { why: `the entry ${input[field]} or the stop ${stopPrice} is not a price` };
    const sign = { buy: 1, sell: -1 }[String(input.side || '').toLowerCase()];
    if (!sign || Math.sign(entry - stop) !== sign) {
      if (!hasBracket) return { why: `the stop ${stop} is not on the losing side of the ${input.side || 'unsided'} entry ${entry}` };
    } else {
      // A distance off the tick counts as the next whole tick: risk is never under-counted.
      fromText = Math.ceil(Math.abs(entry - stop) / spec.tickSize - EPS);
    }
  }
  if (hasBracket) return { ticks: Math.max(bracket, fromText || 0) };
  if (fromText) return { ticks: fromText };
  if (stop !== null) {
    return { why: `a ${type || 'market'} entry with its stop only in the rationale has no entry price to measure the stop from: add stopLossBracket.ticks (order_plan gives them), or enter with a limit or stop order at a price` };
  }
  return { why: 'the entry has no stop to measure its risk from: add stopLossBracket.ticks (order_plan gives them)' };
}

function checkRiskLimit({ input, stopPrice = null, strategy, specOf }) {
  const risk = strategy && strategy.risk && typeof strategy.risk === 'object' ? strategy.risk : null;
  if (!risk || risk.max_risk_usd === undefined) return null;
  const cap = risk.max_risk_usd;
  const who = `setup:${strategy.name}`;
  if (!(typeof cap === 'number' && Number.isFinite(cap) && cap > 0)) {
    return `${who}'s risk.max_risk_usd (${JSON.stringify(cap)}) is not a positive number, so the entry's risk can't be checked: fix its STRATEGY.md.`;
  }
  const size = wholeSize(input.size);
  if (size === null) return `${who} caps risk at ${money(cap)} (risk.max_risk_usd) but the size ${JSON.stringify(input.size)} is not a whole number of contracts, so the risk can't be computed.`;
  const root = contractRoot(input.contractId);
  const spec = typeof specOf === 'function' ? specOf(root) : null;
  const st = entryStopTicks(input, stopPrice, spec);
  if (st.why) return `${who} caps risk at ${money(cap)} (risk.max_risk_usd) but this entry's risk can't be computed: ${st.why}.`;
  const perContract = st.ticks * spec.tickValue;
  const total = size * perContract;
  if (total <= cap + EPS) return null;
  const maxSize = Math.floor(cap / perContract + EPS);
  const maxTicks = Math.floor(cap / (size * spec.tickValue) + EPS);
  const fixes = [
    maxSize >= 1 ? `reduce the size to ${maxSize} or less` : `no size fits at a ${st.ticks}-tick stop (one ${root} risks ${money(perContract)})`,
    maxTicks >= 1 ? `tighten to a stop of at most ${maxTicks} ticks at size ${size}` : null,
  ].filter(Boolean);
  return `risk ${money(total)} (size ${size} x ${st.ticks}-tick stop x ${money(spec.tickValue)} a tick on ${root}) over ${who}'s risk.max_risk_usd ${money(cap)}: ${fixes.join(', or ')} (use order_plan: it gives the strategy's own stop, which is never moved just to fit).`;
}

module.exports = { checkOrderSize, entryStopTicks, checkRiskLimit };
