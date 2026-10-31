'use strict';

/**
 * The size translation, the one place a prop entry's size is set (the owner, 2026-10-23: "default contract sizing is in
 * one place"; the size the model states is a suggestion, translated at entry to the correct size). The rule (entryPlan,
 * the owner, 2026-10-30: "Our stop is $300 per trade so sizing should be based on that"): the size is the most
 * micro-equivalents whose all-in risk (the stop plus the rulebook's stop_slippage_ticks at the tick value, plus the
 * account's fees both ways) fits the composed strategy's risk.max_risk_usd (with the rulebook's sizing.healthy_risk_usd
 * in its place while the attempt is healthy, when that is on: riskCapOf). Every other limit only lowers it: the
 * rulebook's size budget (the cushion share, cap_usd, the drawdown halving, the verdict's multiplier: combine.contractPlan),
 * the room to the floor and the daily limit, the verdict's own size, near the target the floor, the account's max
 * contracts and the broker's max order size. It trades in the selected contract; with none (auto: the simulators) as
 * minis only when whole minis carry the same micro-equivalents within the cap, else micros. Never under the floor (under
 * it: the floor stretch below, else a skip) and never a tighter stop (the stop is the record's). The suggestion never
 * changes the result; it is kept beside it.
 *
 * The floor stretch (owner-approved 2026-10-24, so a setup isn't missed; its dollars are the rulebook's): where the composed
 * cap alone fits fewer than the floor at the stop, the order is exactly the floor when the floor risks at most the
 * rulebook's sizing.floor_stretch_max_usd all in, the attempt is healthy (attemptHealth: no deficit, no loss
 * today) and every other limit (the verdict, the size budget, the broker's max) allows the floor; else a skip
 * as before. Never more than the floor on it. The simulators (entryPlan), compose_check (noSizeFits) and the gate's
 * [max-risk] (stretchedEntry) apply the same rule (floorStretch), and the same healthy cap (riskCapOf).
 *
 * order_plan (trading/lifecycle-order.js composedOrder) builds the order at it, and the gate's composed-reads check
 * (trading/lifecycle-gate.js composedRefusal, from order-gate.js) accepts exactly it (or phase 2's smaller cut), from the
 * same records: the same function on the same inputs. Outside an attempt nothing is translated.
 *
 *   translateSize({ suggested, home, root, policy, account, verdict, capUsd, perContract, specOf, selected, orderMax })
 *       { size, contract, suggested, reason, stretched? } or { skip: true, size: 0, contract: null, suggested, reason }
 *   translatorFor({ home, root, policy, account, strategy, verdict, specOf, selected, orderMax })
 *       (plan, spec, suggested) -> translateSize(...) for a compose record's plan (its stop ticks, the contract's tick value)
 *   entryPlan(contractPlanArgs, { limits: { capUsd, orderMax, sizeMax }, healthyUsd, stretchUsd, state, nearTargetUsd })
 *       the rule: { root, size, riskPerContract } or null (a skip). translateSize, the simulators (prop/attempts.js
 *       defaultSize, the backtester) and the goal regression's sizing check all size by it
 *   riskCapOf({ capUsd, healthyUsd, state })   the per-trade cap: risk.max_risk_usd, or healthy_risk_usd while healthy
 *   floorFit({ capUsd, floor, stopTicks, tickValue, slipTicks, feePerSide, stretchUsd })
 *       { fits, floor, perContract, capSize, maxStopTicks, (with a stretch) stretchFits, maxStretchTicks } | null
 *   noSizeFits({ policy, account, capUsd, stop, spec, root, strategy, specOf, home })   { problem, hint } | null (compose_check)
 *   attemptHealth(state)   { healthy: true } | { healthy: false, why }
 *   floorStretch({ floor, perContract, capUsd, stretchUsd, allows, state })   null | { size, risk } | { why }
 *   stretchedEntry({ home, policy, account, root, size, perContract, capUsd, specOf })   null | { ok, why } (the gate)
 */

const prop = require('../trading/prop-state');
const combine = require('../trading/combine');
const { MIN_STOP_SLIPPAGE_TICKS } = combine;
const { feePerSide: feePerSideOf } = require('../trading/accounts');

const usd = x => `$${Number(x).toFixed(2)}`;

/**
 * The limits over the rulebook's sizing, as [size, why] pairs: the composed strategy's risk.max_risk_usd at a contract's
 * all-in risk (`perContract`: its stop ticks plus the rulebook's stop_slippage_ticks, times its tick value, plus the
 * account's fees both ways: the cost contractPlan counts, allInRisk; the owner: "we make sure our risk is good by
 * calculating tick cost") and the broker's max order size (none known: no limit).
 */
function capsOf({ capUsd, perContract, orderMax = null, capName = 'risk.max_risk_usd' }) {
  return [
    ...(capUsd > 0 && perContract > 0 ? [[Math.floor(capUsd / perContract + 1e-9), `${capName} ${usd(capUsd)} at ${usd(perContract)} a contract all in`]] : []),
    ...(Number.isInteger(orderMax) && orderMax >= 1 ? [[orderMax, `the broker's max order size ${orderMax}`]] : []),
  ];
}

/**
 * Whether an attempt is healthy enough for the floor stretch (the rulebook's definition, accounts/<name>/RULEBOOK.md
 * "The floor stretch"; the owner, 2026-10-24: "balance >= attempt start AND no loss yet this session. One loss today
 * drops back to the $300 cap for the rest of the day"): its balance at or above the attempt's starting balance (no
 * deficit), and no losing trade this trading day (`lossesToday` 0: a loss then a win the same day keeps it off; a new
 * day starts at 0). `state`: { balance, start, lossesToday } (live: the attempt snapshot's state and its day's counts,
 * which the runner writes from the broker's balance and closing fills, liveState; the simulators: their own). Anything
 * unreadable is not healthy (fails closed). { healthy: true } or { healthy: false, why }.
 */
function attemptHealth(state) {
  const no = why => ({ healthy: false, why });
  if (!state || typeof state !== 'object') return no('the attempt state is unreadable');
  const { balance, start, lossesToday } = state;
  const num = x => typeof x === 'number' && Number.isFinite(x);
  if (!num(balance) || !num(start)) return no('the balance or the attempt\'s starting balance is unreadable');
  if (!(Number.isInteger(lossesToday) && lossesToday >= 0)) return no('today\'s losing trades are unreadable');
  if (balance < start) return no(`the balance ${usd(balance)} is under the attempt's starting ${usd(start)}`);
  if (lossesToday > 0) return no(`${lossesToday} losing trade${lossesToday === 1 ? '' : 's'} today: the cap holds for the rest of the day`);
  return { healthy: true };
}

/**
 * The floor stretch on one size: `floor` (in the order's own contracts) at `perContract` all in, where the composed cap
 * (`capUsd`) fits fewer than it. null: no stretch in question (the rulebook's off, a stretch not above the cap, or the
 * cap fits the floor: sized as before); { size: floor, risk }: exactly the floor goes; { why }: it doesn't (a skip as
 * before). `allows`: the fewest every other limit allows (the verdict, the size budget, the broker's max; Infinity:
 * none checked here). `state`: the combine state attemptHealth reads.
 */
function floorStretch({ floor, perContract, capUsd, stretchUsd, allows = Infinity, state }) {
  if (!(Number.isInteger(floor) && floor >= 1) || !(perContract > 0) || !(capUsd > 0) || !(stretchUsd > capUsd)) return null;
  if (Math.floor(capUsd / perContract + 1e-9) >= floor) return null;
  const risk = Math.round(floor * perContract * 100) / 100;
  if (!(floor * perContract <= stretchUsd + 1e-9)) return { why: `the floor of ${floor} at ${usd(perContract)} all in is ${usd(risk)}, over the floor stretch's ${usd(stretchUsd)} too (sizing.floor_stretch_max_usd)` };
  if (!(allows >= floor)) return { why: `the floor stretch never goes past another limit (they allow ${allows})` };
  const h = attemptHealth(state);
  if (!h.healthy) return { why: `the floor stretch to ${usd(stretchUsd)} applies only while the attempt is healthy (no deficit, no loss today): ${h.why}` };
  return { size: floor, risk };
}

/**
 * The attempt's health state as the runner last wrote it: its snapshot's combine state, with `lossesToday` from the
 * snapshot's day counts (prop-state.js dayCounts: the losing trades closed this trading day, the carried ones
 * included) when they are for the snapshot's own day; else left out (unreadable: not healthy). null with no snapshot.
 */
function liveState(home, account) {
  const r = account && home ? prop.readAttempt(home, account.name) : null;
  const s = r && r.snapshot;
  if (!s || !s.state) return null;
  const c = s.counts && s.counts.day === s.day ? s.counts : null;
  return { ...s.state, lossesToday: c ? c.losses : undefined };
}

/** The policy's floor stretch in dollars (its rulebook's sizing.floor_stretch_max_usd; `off` reads as 0: none). */
const stretchOf = policy => (policy && policy.sizing && Number.isFinite(policy.sizing.floor_stretch_max_usd) ? policy.sizing.floor_stretch_max_usd : 0);

/**
 * The simulator's size (prop/attempts.js defaultSize, the backtester): a contractPlan result (the budget at the
 * verdict's multiplier, the floor inside it) limited as translateSize limits a live entry, by capsOf on the plan's
 * own contract at its all-in risk (the plan's riskPerContract: the stop, the slippage ticks and the fees, as live), then
 * held to the floor again (micro-equivalents: a mini counts as `ratio`), with the floor stretch as live (floorStretch:
 * `stretchUsd`, the rulebook's sizing.floor_stretch_max_usd; `state`, the simulated attempt's combine state with its lossesToday; the
 * budget's size and the broker's max its other limits), and near the target (`nearTargetUsd`, the rulebook's
 * sizing.near_target_usd: combine.nearTarget on `state`) at most the floor, as live. The plan, smaller, or null (under
 * the floor: a skip).
 * limits: { capUsd, orderMax }.
 */
function limitPlan(plan, { limits = null, minContracts = 1, ratio, miniRoot = null, stretchUsd = null, state = null, nearTargetUsd = 0 }) {
  if (!plan) return plan;
  const each = plan.root === miniRoot ? ratio : 1;
  // Near the target (the rulebook's sizing.near_target_usd, combine.nearTarget on the attempt's state): the floor, never more.
  const top = combine.nearTarget(state, { near_target_usd: nearTargetUsd }) ? Math.min(plan.size, Math.ceil(minContracts / each)) : plan.size;
  if (!limits) return top === plan.size ? plan : { ...plan, size: top };
  const caps = capsOf({ capUsd: limits.capUsd, perContract: plan.riskPerContract, orderMax: limits.orderMax });
  const size = Math.min(top, ...caps.map(c => c[0]));
  if (size >= 1 && size * each >= minContracts) return size === plan.size ? plan : { ...plan, size };
  const others = Math.min(top, ...(Number.isInteger(limits.orderMax) && limits.orderMax >= 1 ? [limits.orderMax] : []));
  const st = floorStretch({ floor: Math.ceil(minContracts / each), perContract: plan.riskPerContract, capUsd: limits.capUsd, stretchUsd, allows: others, state });
  return st && st.size ? { ...plan, size: st.size } : null;
}

/** The policy's healthy cap in dollars (its rulebook's sizing.healthy_risk_usd; `off` reads as 0: none). */
const healthyOf = policy => (policy && policy.sizing && Number.isFinite(policy.sizing.healthy_risk_usd) ? policy.sizing.healthy_risk_usd : 0);

/**
 * The per-trade cap in dollars all in: the composed strategy's risk.max_risk_usd (`capUsd`), or the rulebook's
 * sizing.healthy_risk_usd (`healthyUsd`, 0: off) in its place while the attempt is healthy (attemptHealth on `state`),
 * never lower than the composed cap. { capUsd, healthy: true when the healthy cap is the one in force }.
 */
function riskCapOf({ capUsd, healthyUsd = 0, state = null }) {
  if (capUsd > 0 && healthyUsd > capUsd && attemptHealth(state).healthy) return { capUsd: healthyUsd, healthy: true };
  return { capUsd, healthy: false };
}

/**
 * The rule (the header): the size from the cap down. `args`: combine.contractPlan's (the size budget's dollars, the
 * room, the stop, the legs, the mode, the guard, the verdict's multiplier, the ratio, the slippage, the floor); `opts`:
 * { limits: { capUsd (the composed cap), orderMax (the broker's), sizeMax (the verdict's own size) } | null,
 * healthyUsd, stretchUsd, state (the combine state with lossesToday: the health), nearTargetUsd }.
 *   1. the cap (riskCapOf): the most contracts of a leg whose all-in risk fits it (capsOf);
 *   2. lowered by the size budget in that leg (combine.contractPlan with a floor of 1: the budget, the room, the guard,
 *      the multiplier, the account's max), the verdict's size, the broker's max, near the target the floor;
 *   3. the leg: the selected one (mode micro or mini); auto: minis only when whole minis carry the micro-equivalents the
 *      micros would (the same size within the cap), else micros;
 *   4. under the floor (min_contracts, micro-equivalents): the floor stretch (floorStretch: exactly the floor, within
 *      sizing.floor_stretch_max_usd, while healthy, every other limit allowing it), else null.
 * No limits (no composed cap): the size budget's plan alone (contractPlan), as before.
 */
function entryPlan(args, opts = {}) {
  const floor = args.minContracts;
  if (!(Number.isInteger(floor) && floor >= 1)) return null;
  const limits = opts.limits || null;
  if (!limits) return limitPlan(combine.contractPlan(args), { ...opts, minContracts: floor, ratio: args.ratio, miniRoot: args.legs && args.legs.mini ? args.legs.mini.root : null });
  const mode = args.mode || 'auto';
  const legs = args.legs || {};
  const miniRoot = legs.mini ? legs.mini.root : null;
  const { capUsd } = riskCapOf({ capUsd: limits.capUsd, healthyUsd: opts.healthyUsd || 0, state: opts.state });
  const near = combine.nearTarget(opts.state, { near_target_usd: opts.nearTargetUsd });
  // The size budget's plan in a leg, with a floor of 1 (the floor is step 4's): its size only ever lowers the cap's.
  const budgetIn = m => combine.contractPlan({ ...args, mode: m, minContracts: 1 });
  const lowered = p => {
    const each = p.root === miniRoot ? args.ratio : 1;
    const caps = capsOf({ capUsd, perContract: p.riskPerContract, orderMax: limits.orderMax });
    const others = [p.size, ...(Number.isInteger(limits.sizeMax) && limits.sizeMax >= 0 ? [limits.sizeMax] : []), ...(near ? [Math.ceil(floor / each)] : [])];
    return { plan: p, each, size: Math.min(...others, ...caps.map(c => c[0])), allows: Math.min(...others, ...(Number.isInteger(limits.orderMax) && limits.orderMax >= 1 ? [limits.orderMax] : [])) };
  };
  let pick;
  if (mode !== 'auto' || !legs.mini || !legs.micro) { const p = budgetIn(mode); pick = p ? lowered(p) : null; } else {
    const mi = budgetIn('micro');
    const mn = budgetIn('mini');
    const a = mi && mi.root === legs.micro.root ? lowered(mi) : null;
    const b = mn && mn.root === miniRoot ? lowered(mn) : null;
    pick = b && b.size >= 1 && (!a || b.size * args.ratio === a.size) ? b : a || b;
  }
  if (!pick) return null;
  if (pick.size >= 1 && pick.size * pick.each >= floor) return { ...pick.plan, size: pick.size };
  const st = floorStretch({ floor: Math.ceil(floor / pick.each), perContract: pick.plan.riskPerContract, capUsd, stretchUsd: opts.stretchUsd, allows: pick.allows, state: opts.state });
  return st && st.size ? { ...pick.plan, size: st.size } : null;
}

function translateSize({ suggested = null, home, root, policy, account, verdict, capUsd, perContract, specOf, selected = null, orderMax = null }) {
  const skip = reason => ({ skip: true, size: 0, contract: null, suggested, reason });
  const name = policy ? policy.name : 'the policy';
  if (!policy || !account || !account.valid) return skip(`${name} has no valid account to size from: no size`);
  if (!verdict) return skip(`${name} has no verdict on this record: no size`);
  // The broker server's tick specs only (the caller's specOf: docs/BROKER-MCP-INTERFACE.md "Tick specs"), never the table.
  if (typeof specOf !== 'function') return skip(`${name}: no broker tick specs to size from: no size`);
  if (verdict.action !== 'full' || !(verdict.maxSize >= 1)) return skip(`${name} skipped the setup${verdict.reason ? ` (${verdict.reason})` : ''}`);
  const m = prop.verdictMultiplier(verdict);
  if (m === null) return skip(`${name}'s verdict carries no size multiplier above 0 and at most 1: no size`);
  if (verdict.contract !== root) return skip(`${name}'s verdict trades ${verdict.contract}, not ${root}: a size is a number of its own contract`);
  if (!(capUsd > 0) || !(perContract > 0)) return skip('the composed strategy states no risk.max_risk_usd, or the stop has no risk: no size');
  // Sized in the verdict's own contract (the runner's verdict is the run's contract: selected [root]); with none selected,
  // never a mini the entry doesn't trade that the cap would then price out (the owner, 2026-10-30).
  const b = prop.budgetPlan(home, account, policy, verdict.contract, verdict.stopTicks, m, specOf, selected || [verdict.contract]);
  if (b.error) return skip(`${account.name}: ${b.error}`);
  if (b.root !== verdict.contract || !(b.size >= 1)) return skip(`${account.name}: the size budget now allows nothing at a ${verdict.stopTicks}-tick stop${b.floor ? ` (${b.floor})` : ''}`);
  const others = [
    [verdict.maxSize, `the verdict's ${verdict.maxSize}`],
    [b.size, `the size budget's ${b.size}`],
  ];
  // Near the target (owner-approved 2026-10-28): the floor, never more (the rulebook's sizing.near_target_usd at or
  // above what a pass still needs, from the attempt's snapshot: combine.nearTarget). It only ever lowers the size.
  const near = combine.nearTarget(liveState(home, account), policy && policy.sizing) ? prop.minContractsIn(policy, account, root, specOf) : null;
  if (Number.isInteger(near)) others.push([near, `near the target: the floor (sizing.near_target_usd ${usd(policy.sizing.near_target_usd)})`]);
  // The per-trade cap (riskCapOf): the composed cap, or the rulebook's healthy cap while the attempt is healthy.
  const rc = riskCapOf({ capUsd, healthyUsd: healthyOf(policy), state: liveState(home, account) });
  const caps = [...others, ...capsOf({ capUsd: rc.capUsd, perContract, orderMax, capName: rc.healthy ? 'sizing.healthy_risk_usd (the attempt healthy)' : undefined })];
  const size = Math.min(...caps.map(c => c[0]));
  const binds = caps.filter(c => c[0] === size).map(c => c[1]).join(', ');
  const floor = prop.minContractsRefusal(policy, account, root, size, specOf);
  if (!floor) return { size, contract: root, suggested, reason: `the rulebook's size at this stop: ${size} ${root} (${binds})` };
  // Under the floor: the floor stretch, where the composed cap is what keeps the floor out (every other limit, the
  // broker's max among them, must allow the floor).
  const allows = Math.min(...others.map(c => c[0]), ...(Number.isInteger(orderMax) && orderMax >= 1 ? [orderMax] : []));
  const st = floorStretch({ floor: prop.minContractsIn(policy, account, root, specOf), perContract, capUsd: rc.capUsd, stretchUsd: stretchOf(policy), allows, state: liveState(home, account) });
  if (st && st.size) {
    return { size: st.size, contract: root, suggested, stretched: true, reason: `the rulebook's size at this stop: ${st.size} ${root} (the floor, stretched: ${usd(st.risk)} all in, over risk.max_risk_usd ${usd(rc.capUsd)}, within sizing.floor_stretch_max_usd ${usd(stretchOf(policy))}, the attempt healthy)` };
  }
  return skip(`${floor} (the correct size at this stop is ${size}: ${binds}${st && st.why ? `; ${st.why}` : ''})`);
}

/**
 * The gate's read of the floor stretch on an entry over the composed cap (order-gate.js [max-risk]): null when no
 * stretch is in question (the rulebook's off or not above the cap, the cap fits the floor, no floor): the cap binds as
 * before; { ok: true } when `size` is exactly the floor and floorStretch allows it now (its cost, the attempt's health
 * from its snapshot); else { ok: false, why }. With the rulebook's healthy cap on (sizing.healthy_risk_usd above the
 * composed cap), any size within it all in is { ok: true } while the attempt is healthy (riskCapOf), and only the floor
 * stretch above it after that. The verdict, the budget and the broker's max are the gate's own checks.
 */
function stretchedEntry({ home, policy, account, root, size, perContract, capUsd, specOf }) {
  // Only a policy on a valid account in a running attempt: anything else is no stretch (the cap binds as before).
  if (!policy || !account || account.valid === false || !home || typeof specOf !== 'function' || !prop.readAttempt(home, account.name)) return null;
  // The healthy cap (riskCapOf): while the attempt is healthy any size within sizing.healthy_risk_usd all in goes (the
  // translation sizes to it; [composed-reads] holds the size to the translated one).
  const hc = healthyOf(policy);
  if (hc > capUsd && perContract > 0 && Number.isInteger(Number(size)) && Number(size) >= 1) {
    const rc = riskCapOf({ capUsd, healthyUsd: hc, state: liveState(home, account) });
    if (rc.healthy && Number(size) * perContract <= hc + 1e-9) return { ok: true };
    if (rc.healthy) capUsd = hc; // over the healthy cap: only the floor stretch above it may go
  }
  const floor = prop.minContractsIn(policy, account, root, specOf);
  const stretchUsd = stretchOf(policy);
  if (!Number.isInteger(floor) || !(capUsd > 0) || !(perContract > 0) || !(stretchUsd > capUsd)) return null;
  if (Math.floor(capUsd / perContract + 1e-9) >= floor) return null;
  if (size !== floor) return { ok: false, why: `only exactly the floor of ${floor} ${root} may go over the cap, up to sizing.floor_stretch_max_usd ${usd(stretchUsd)} while the attempt is healthy` };
  const st = floorStretch({ floor, perContract, capUsd, stretchUsd, state: liveState(home, account) });
  return st && st.size ? { ok: true } : { ok: false, why: st ? st.why : 'no floor stretch' };
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

/**
 * Whether the rulebook's floor (`floor`, in the order's own contracts: prop-state.js minContractsIn) fits under the
 * composed cap at a stop, counted as translateSize counts it (capsOf at allInRisk): { fits, floor, perContract, capSize,
 * maxStopTicks: the widest whole-tick stop whose floor still fits, 0 for none }, and with a floor stretch above the cap
 * (`stretchUsd`) { stretchFits: the floor within it at this stop, maxStretchTicks: the widest stop within it }, or null
 * when it can't be priced (no cap, floor, tick value or fee). compose_check's "no size fits" refusal (harness-tools/compose.js).
 */
function floorFit({ capUsd, floor, stopTicks, tickValue, slipTicks, feePerSide, stretchUsd = null }) {
  const at = t => allInRisk({ stopTicks: t, tickValue, slipTicks, feePerSide });
  const sizeAt = t => { const c = capsOf({ capUsd, perContract: at(t) }); return c.length ? c[0][0] : 0; };
  const perContract = at(stopTicks);
  if (!(capUsd > 0) || !(Number.isInteger(floor) && floor >= 1) || !(tickValue > 0) || !(perContract > 0)) return null;
  // The widest stop: allInRisk is linear in the ticks (at(0) + ticks x tickValue), so the floor fits up to this tick
  // count (the parity test holds it to translateSize's own count, stop by stop).
  const widest = usdCap => Math.floor((usdCap / floor - at(0)) / tickValue + 1e-9);
  const capSize = sizeAt(stopTicks);
  const out = { fits: capSize >= floor, floor, perContract, capSize, maxStopTicks: Math.max(0, widest(capUsd)) };
  return stretchUsd > capUsd ? { ...out, stretchFits: floor * perContract <= stretchUsd + 1e-9, maxStretchTicks: Math.max(0, widest(stretchUsd)) } : out;
}

const money = x => (Number.isInteger(x) ? `$${x}` : usd(x));

/**
 * compose_check's "no size fits" (owner-approved 2026-10-24): in a running attempt, the floor of the policy's rulebook
 * (sizing.min_contracts, in the order's own contracts) at the record's stop, all in as translateSize counts it
 * (floorFit), over the composed strategy's risk.max_risk_usd, and not within the floor stretch (its cost over
 * sizing.floor_stretch_max_usd, or the attempt in `home` not healthy now: floorStretch): order_plan could only skip
 * the record. { problem, hint } (the hint names the widest stop that fits the cap, in ticks and points of the order's
 * own contract, and with a stretch the widest within it, only while the attempt is healthy; none at or over the
 * record's minimum stop: skip), or null (the floor fits, the stretch takes it, or it can't be priced). `stop`: the
 * plan's { ticks, floorTicks }.
 */
function noSizeFits({ policy, account, capUsd, stop, spec, root, strategy, specOf, home = null }) {
  if (!policy || !account || !stop || !spec || typeof specOf !== 'function') return null;
  const stretchUsd = stretchOf(policy);
  // The per-trade cap in force (riskCapOf): the healthy cap while the attempt is healthy, else the composed cap.
  capUsd = riskCapOf({ capUsd, healthyUsd: healthyOf(policy), state: liveState(home, account) }).capUsd;
  const fit = floorFit({ capUsd, floor: prop.minContractsIn(policy, account, root, specOf), stopTicks: stop.ticks, tickValue: spec.tickValue,
    slipTicks: policy.sizing ? policy.sizing.stop_slippage_ticks : null, feePerSide: feePerSideOf(account, root), stretchUsd });
  if (!fit || fit.fits) return null;
  const st = floorStretch({ floor: fit.floor, perContract: fit.perContract, capUsd, stretchUsd, state: liveState(home, account) });
  if (st && st.size) return null;
  const n = `${fit.floor} ${root}`;
  const max = fit.maxStopTicks;
  const minStop = Number.isInteger(stop.floorTicks) ? stop.floorTicks : 1;
  const points = t => Number((t * spec.tickSize).toFixed(6));
  // With a stretch: the widest stop within it, which applies only while the attempt is healthy (never a stop to widen to).
  const also = st ? `; the floor at up to ${money(stretchUsd)} (a stop of ${fit.maxStretchTicks} ticks, ${points(fit.maxStretchTicks)} points, or less) only while the attempt is healthy (no deficit, no loss today)` : '';
  return {
    problem: `no size fits: the floor of ${n} (${policy.name}'s rulebook, sizing.min_contracts) at ${usd(fit.perContract)} a contract all in (the ${stop.ticks}-tick stop with its slippage, and fees both ways) is ${usd(fit.floor * fit.perContract)}, over ${strategy}'s risk.max_risk_usd ${money(capUsd)}${st ? `; ${st.why}` : ''}`,
    hint: max >= minStop
      ? `size: no size fits: ${n} need a stop of ${max} ticks (${points(max)} points) or less under the ${money(capUsd)} cap${also}; use a closer structural stop or skip`
      : `size: no size fits: ${n} fit under the ${money(capUsd)} cap only at a stop of ${max} ticks or less, under the minimum stop of ${minStop}${also}: skip`,
  };
}

function translatorFor({ home, root, policy, account, strategy, verdict, specOf, selected = null, orderMax = null }) {
  return (plan, spec, suggested = null) => translateSize({
    suggested, home, root, policy, account, verdict, capUsd: strategy && strategy.risk ? strategy.risk.max_risk_usd : null,
    perContract: plan && plan.stop && spec && account ? allInRisk({ stopTicks: plan.stop.ticks, tickValue: spec.tickValue, slipTicks: policy && policy.sizing ? policy.sizing.stop_slippage_ticks : null, feePerSide: feePerSideOf(account, root) }) : null,
    specOf, selected, orderMax,
  });
}

module.exports = { translateSize, translatorFor, capsOf, limitPlan, entryPlan, riskCapOf, allInRisk, floorFit, noSizeFits, attemptHealth, floorStretch, stretchedEntry };
