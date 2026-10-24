'use strict';

/**
 * The size translation, the one place a prop entry's size is set (the owner, 2026-10-23: "default contract sizing is in
 * one place"; the size the model states is a suggestion, translated at entry to the correct size). In a running attempt
 * a composed trade's order is sized here from the account rulebook's sizing alone: the policy's verdict on the record
 * (combine.contractPlan on the attempt's budget, room, cushion_frac, cap, multiplier, slippage and min_contracts, in the
 * selected or micro/mini/auto contract), the size budget now (the same contractPlan on the latest snapshot), the
 * composed strategy's risk.max_risk_usd, the account's max (inside contractPlan) and the broker's max order size. The
 * correct size is the largest all of them allow: never above any of them, never under the floor (under it: a skip), and
 * never a tighter stop (the stop is the record's). The suggestion never changes the result; it is kept beside it.
 *
 * order_plan (trading/lifecycle-order.js composedOrder) builds the order at it, and the gate's composed-reads check
 * (trading/lifecycle-gate.js composedRefusal, from order-gate.js) accepts exactly it (or phase 2's smaller cut), from the
 * same records: the same function on the same inputs. Outside an attempt nothing is translated.
 *
 *   translateSize({ suggested, home, root, policy, account, verdict, capUsd, perContract, specOf, selected, orderMax })
 *       { size, contract, suggested, reason } or { skip: true, size: 0, contract: null, suggested, reason }
 *   translatorFor({ home, root, policy, account, strategy, verdict, specOf, selected, orderMax })
 *       (plan, spec, suggested) -> translateSize(...) for a compose record's plan (its stop ticks, the contract's tick value)
 */

const prop = require('../trading/prop-state');
const { MIN_STOP_SLIPPAGE_TICKS } = require('../trading/combine');
const { feePerSide: feePerSideOf } = require('../trading/accounts');

const usd = x => `$${Number(x).toFixed(2)}`;

/**
 * The limits over the rulebook's sizing, as [size, why] pairs: the composed strategy's risk.max_risk_usd at a contract's
 * all-in risk (`perContract`: its stop ticks plus the rulebook's stop_slippage_ticks, times its tick value, plus the
 * account's fees both ways: the cost contractPlan counts, allInRisk; the owner: "we make sure our risk is good by
 * calculating tick cost") and the broker's max order size (none known: no limit).
 */
function capsOf({ capUsd, perContract, orderMax = null }) {
  return [
    ...(capUsd > 0 && perContract > 0 ? [[Math.floor(capUsd / perContract + 1e-9), `risk.max_risk_usd ${usd(capUsd)} at ${usd(perContract)} a contract all in`]] : []),
    ...(Number.isInteger(orderMax) && orderMax >= 1 ? [[orderMax, `the broker's max order size ${orderMax}`]] : []),
  ];
}

/**
 * The simulator's size (prop/attempts.js defaultSize, the backtester): a contractPlan result (the budget at the
 * verdict's multiplier, the floor inside it) limited as translateSize limits a live entry, by capsOf on the plan's
 * own contract at its all-in risk (the plan's riskPerContract: the stop, the slippage ticks and the fees, as live), then
 * held to the floor again (micro-equivalents: a mini counts as `ratio`). The plan, smaller, or null (under the floor: a
 * skip). limits: { capUsd, orderMax }.
 */
function limitPlan(plan, { limits = null, minContracts = 1, ratio, miniRoot = null }) {
  if (!plan || !limits) return plan;
  const caps = capsOf({ capUsd: limits.capUsd, perContract: plan.riskPerContract, orderMax: limits.orderMax });
  const size = Math.min(plan.size, ...caps.map(c => c[0]));
  if (!(size >= 1) || size * (plan.root === miniRoot ? ratio : 1) < minContracts) return null;
  return size === plan.size ? plan : { ...plan, size };
}

function translateSize({ suggested = null, home, root, policy, account, verdict, capUsd, perContract, specOf, selected = null, orderMax = null }) {
  const skip = reason => ({ skip: true, size: 0, contract: null, suggested, reason });
  const name = policy ? policy.name : 'the policy';
  if (!policy || !account || !account.valid) return skip(`${name} has no valid account to size from: no size`);
  if (!verdict) return skip(`${name} has no verdict on this record: no size`);
  if (verdict.action !== 'full' || !(verdict.maxSize >= 1)) return skip(`${name} skipped the setup${verdict.reason ? ` (${verdict.reason})` : ''}`);
  const m = prop.verdictMultiplier(verdict);
  if (m === null) return skip(`${name}'s verdict carries no size multiplier above 0 and at most 1: no size`);
  if (verdict.contract !== root) return skip(`${name}'s verdict trades ${verdict.contract}, not ${root}: a size is a number of its own contract`);
  if (!(capUsd > 0) || !(perContract > 0)) return skip('the composed strategy states no risk.max_risk_usd, or the stop has no risk: no size');
  const b = prop.budgetPlan(home, account, policy, verdict.contract, verdict.stopTicks, m, specOf, selected);
  if (b.error) return skip(`${account.name}: ${b.error}`);
  if (b.root !== verdict.contract || !(b.size >= 1)) return skip(`${account.name}: the size budget now allows nothing at a ${verdict.stopTicks}-tick stop${b.floor ? ` (${b.floor})` : ''}`);
  const caps = [
    [verdict.maxSize, `the verdict's ${verdict.maxSize}`],
    [b.size, `the size budget's ${b.size}`],
    ...capsOf({ capUsd, perContract, orderMax }),
  ];
  const size = Math.min(...caps.map(c => c[0]));
  const binds = caps.filter(c => c[0] === size).map(c => c[1]).join(', ');
  const floor = prop.minContractsRefusal(policy, account, root, size, specOf);
  if (floor) return skip(`${floor} (the correct size at this stop is ${size}: ${binds})`);
  return { size, contract: root, suggested, reason: `the rulebook's size at this stop: ${size} ${root} (${binds})` };
}

/**
 * A contract's all-in risk at a stop (as combine.contractPlan prices one): the stop's ticks plus the expected slippage
 * (the rulebook's stop_slippage_ticks, never under its floor) times the tick value, plus the account's fee both ways.
 * NaN without a fee (none is assumed).
 */
function allInRisk({ stopTicks, tickValue, slipTicks, feePerSide }) {
  const slip = Math.max(MIN_STOP_SLIPPAGE_TICKS, Number(slipTicks) || 0);
  return typeof feePerSide === 'number' && Number.isFinite(feePerSide) ? (stopTicks + slip) * tickValue + 2 * feePerSide : NaN;
}

function translatorFor({ home, root, policy, account, strategy, verdict, specOf, selected = null, orderMax = null }) {
  return (plan, spec, suggested = null) => translateSize({
    suggested, home, root, policy, account, verdict, capUsd: strategy && strategy.risk ? strategy.risk.max_risk_usd : null,
    perContract: plan && plan.stop && spec && account ? allInRisk({ stopTicks: plan.stop.ticks, tickValue: spec.tickValue, slipTicks: policy && policy.sizing ? policy.sizing.stop_slippage_ticks : null, feePerSide: feePerSideOf(account, root) }) : null,
    specOf, selected, orderMax,
  });
}

module.exports = { translateSize, translatorFor, capsOf, limitPlan, allInRisk };
