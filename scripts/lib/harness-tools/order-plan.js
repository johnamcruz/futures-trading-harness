'use strict';

/**
 * The order_plan operation (scripts/strategies.js plan): the order for a
 * strategy that is a candidate on the last closed bar of a bars file, at the
 * harness clock, ready for place_order. Read-only: it never places an order;
 * the order gate still checks every number it gives.
 *
 *   plan { file, symbol, strategy, side, accountId }   strategy and side: the caller's choice (both required)
 *
 * A calculator, not a decision: the caller picks the strategy and the side
 * (from the skills and STRATEGY.md) and decides whether to trade; order_plan
 * only works out the numbers, showing its working, and refuses (with the
 * reason) a strategy that isn't a candidate now or a side its rules didn't
 * fire. It never picks, ranks, or advises.
 *
 * A rules strategy: its current scan candidate (the same scan as
 * strategies_scan), the stop from its distance (trading/order-plan.js), size
 * 1 (no account budget sizes a rules strategy; position-sizing's size-1
 * rule), refused when one contract risks more than its risk.max_risk_usd, and
 * refused while a prop attempt runs (only its policy strategy may enter).
 * A policy strategy: its live verdict (contract, side, stop ticks, at most its
 * size), capped by the attempt's size budget now (prop-state.js budgetPlan,
 * as the gate checks it), on the verdict's setup, which must still be its
 * component's candidate on the bar, and on the verdict's own bar (the last
 * closed bar of the bars given, compared as the gate compares it with the
 * signal record's last bar: signal-state.js sameBar).
 *
 * Tick specs are the broker's (trading/broker-specs.js), as the gate checks
 * them: none recorded for the contract (or, for a policy strategy, either
 * contract of its family) is a refusal saying to fetch the contract first.
 */

const { readBarsArg } = require('../backtest/data');
const { loadStrategies, scan, rootRefusal } = require('../trading/strategies');
const { selectedSymbols } = require('../trading/contracts');
const { loadAccounts } = require('../trading/accounts');
const { exitPlan, timeframeMs } = require('../trading/evaluator');
const { normalizeBars } = require('../trading/indicators');
const { loadConfig } = require('../trading/config');
const { liveSpecs, whyNoSpec } = require('../trading/broker-specs');
const prop = require('../trading/prop-state');
const { stopTicks, buildPlan } = require('../trading/order-plan');
const { resolveJournalPath, readJournal, entriesSince } = require('../trading/journal');
const { tradingDayStart } = require('../trading/clock');
const { FUTURE_TOLERANCE_MIN, sameBar } = require('../trading/signal-state');
const { harnessHome } = require('../paths');
const { context, say } = require('./cli');
const { whyNot } = require('./compact');

const SIDES = { long: 'long', buy: 'long', short: 'short', sell: 'short' };

/** The scan result of `name`, a candidate on the side asked, or a refusal. */
function candidateOf(results, name, root, want) {
  const r = results.find(x => x.name === name);
  if (!r) throw new Error(`${name} was not scanned on ${root} (disabled, or it doesn't trade ${root}); no order`);
  if (r.error) throw new Error(`${name} could not be scanned: ${r.error}`);
  if (!r.candidate || !r.direction) throw new Error(`${name} is not a candidate on the last closed bar (${whyNot(r) || 'no side'}); no order`);
  if (want !== r.direction) throw new Error(`${name} fired ${r.direction} on the last closed bar, not ${want}: the other side is not its setup; no order`);
  return r;
}

function rulesPlan(c, s, { results, root, want, home, specOf }) {
  if (s.signal !== 'rules') throw new Error(`${s.name} is a ${s.signal} strategy: order_plan plans a rules strategy's candidate or a policy strategy's verdict`);
  const running = prop.runningAttempts(home);
  if (running.length) {
    throw new Error(`a ${running.join(', ')} attempt is running: only the policy strategy that trades it may enter (order_plan with that strategy's name, for its verdict)`);
  }
  const r = candidateOf(results, s.name, root, want);
  const spec = specOf(root);
  if (!spec) throw new Error(`${whyNoSpec(specOf, root)}; no order`);
  const stop = stopTicks(r.stopDistance, spec.tickSize);
  if (!stop) throw new Error(`${s.name} has no stop distance on this bar (risk.stop ${JSON.stringify(s.risk.stop)}): its stop comes from STRATEGY.md, not from order_plan`);
  const perContract = stop * spec.tickValue;
  const cap = s.risk.max_risk_usd;
  if (cap !== undefined && perContract > cap) {
    throw new Error(`one ${root} at a ${stop}-tick stop risks $${perContract.toFixed(2)}, over ${s.name}'s risk.max_risk_usd $${cap}: no size fits (the stop is the strategy's and is never shrunk to fit)`);
  }
  return {
    name: s.name, side: r.direction, contract: root, spec, entryRef: r.entryRef, stop, stopDistance: r.stopDistance,
    exit: r.exit, targetDistance: r.targetDistance ?? null, minRR: s.risk.min_rr, size: 1,
    sizeWhy: 'the minimum; no account budget sizes a rules strategy (position-sizing: size 1 until the setup has 30+ reviewed trades)',
    notes: s.status === 'active' ? [] : [`status ${s.status}: plan only, the gate refuses a live entry`],
  };
}

function policyPlan(c, s, { results, root, want, home, now, lastBar, specOf, selected }) {
  const v = prop.latestVerdict(home, s.name, root);
  if (!v) throw new Error(`${s.name} has no verdict for ${root}: the runner records one at each setup of ${(s.strategies || []).join(', ')}; no order`);
  if (!(Date.parse(v.expiresAt) > now.getTime())) throw new Error(`${s.name}'s latest verdict (${v.bar}) expired at ${v.expiresAt}; no order`);
  if (v.action === 'skip' || !(v.maxSize >= 1)) throw new Error(`${s.name} skipped the setup${v.reason ? ` (${v.reason})` : ''}; no order`);
  if (!Object.hasOwn(prop.ENTRY_FRACTIONS, v.action)) throw new Error(`${s.name}'s verdict action ${JSON.stringify(v.action)} allows no entry (only ${Object.keys(prop.ENTRY_FRACTIONS).join(' or ')}); no order`);
  if (want !== v.direction) throw new Error(`${s.name}'s verdict is for a ${v.direction} entry, not ${want}; no order`);
  // The verdict's stop ticks were sized on its own bar: never paired with another bar's entry.
  if (!sameBar(v.bar, lastBar)) {
    throw new Error(`${s.name}'s verdict is for the bar opened ${v.bar}, not the last closed bar of these bars (opened ${lastBar}): plan it on bars ending at the verdict's bar; no order`);
  }
  const r = candidateOf(results, v.component, root, v.direction);
  const account = loadAccounts(c.root, c.env).accounts.find(a => a.name === s.account);
  if (!account || !account.valid) throw new Error(`${s.name} trades account "${s.account}", which is ${account ? 'invalid' : 'not found'}`);
  const block = prop.combineBlock(home, account.name, now);
  if (block) throw new Error(`${account.name}: ${block}`);
  const b = prop.budgetPlan(home, account, s, v.contract, v.stopTicks, prop.ENTRY_FRACTIONS[v.action], specOf, selected);
  if (b.error) throw new Error(`${account.name}: ${b.error}`);
  if (b.root !== v.contract || !(b.size >= 1)) throw new Error(`${account.name}: the size budget now allows ${b.root ? `${b.size} ${b.root}` : 'nothing'} at a ${v.stopTicks}-tick stop, not ${v.contract}; no order`);
  const size = Math.min(v.maxSize, b.size);
  return {
    account,
    name: s.name, side: v.direction, contract: v.contract, spec: specOf(v.contract), entryRef: r.entryRef, stop: v.stopTicks, stopDistance: null,
    exit: exitPlan(s), targetDistance: null, size,
    sizeWhy: `the verdict's ${v.action} size ${v.maxSize}${size < v.maxSize ? `, cut to the size budget now (${b.size})` : ''}, for ${v.component}'s setup; the stop is the verdict's ${v.stopTicks} ticks`,
    notes: s.status === 'active' ? [] : [`status ${s.status}: plan only, the gate refuses a live entry`],
  };
}

/**
 * The bars must be the strategy's own and current, as the gate's trigger record is: bars on its
 * timeframe (the step between the last bars, as scan's record measures it), the last one closed at
 * the harness clock (within the gate's FUTURE_TOLERANCE_MIN for a broker clock ahead of it) and no
 * older than the gate's signal age (FTH_SIGNAL_MAX_AGE_MIN). Returns the last bar's open time; else a refusal.
 */
function checkBars(bars, timeframe, now, env) {
  const norm = normalizeBars(bars);
  const want = timeframeMs(timeframe);
  const diffs = norm.slice(-50).map((b, i, a) => (i ? Date.parse(b.t) - Date.parse(a[i - 1].t) : Infinity)).filter(d => d > 0 && Number.isFinite(d));
  const step = diffs.length ? Math.min(...diffs) : NaN;
  if (!(step === want)) throw new Error(`the bars are ${Number.isFinite(step) ? `${step / 60000}-minute` : 'of an unknown timeframe'}; the strategy trades ${timeframe} bars: plan it on its own timeframe's bars`);
  const closedAt = Date.parse(norm[norm.length - 1].t) + step;
  const maxAgeMin = loadConfig(env).signalMaxAgeMin;
  // A close up to the gate's tolerance after the harness clock is the broker's clock running ahead (signal-state.js).
  if (closedAt - now.getTime() > FUTURE_TOLERANCE_MIN * 60000) {
    throw new Error(`the last bar closes at ${new Date(closedAt).toISOString()}, more than ${FUTURE_TOLERANCE_MIN} min after the harness clock (${now.toISOString()}): it hasn't closed`);
  }
  if (now.getTime() - closedAt > maxAgeMin * 60000) throw new Error(`the last bar closed at ${new Date(closedAt).toISOString()}, more than ${maxAgeMin} min before the harness clock (${now.toISOString()}): fetch current bars`);
  return norm[norm.length - 1].t;
}

function plan({ file, symbol, strategy: name, side, accountId } = {}, ctx) {
  const c = context(ctx);
  const root = String(symbol || '').toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(root)) throw new Error(say(c, '--symbol <ROOT>: a contract root, e.g. MNQ', 'symbol: a contract root, e.g. MNQ'));
  if (!file) throw new Error('plan needs a bars file');
  const want = SIDES[String(side ?? '').toLowerCase()];
  if (!want) throw new Error(say(c, `--side long|short: the side you chose (got ${side ?? 'none'})`, `side: long or short, the side you chose (got ${side ?? 'none'})`));
  if (accountId !== undefined && accountId !== null && !(Number.isInteger(accountId) && accountId >= 1)) throw new Error(`accountId: the broker account's id, a whole number (got ${accountId})`);
  const { strategies } = loadStrategies(c.root, c.env);
  const s = strategies.find(x => x.name === name);
  if (!s) throw new Error(`unknown strategy "${name}" (known: ${strategies.map(x => x.name).join(', ')})`);
  if (!s.valid) throw new Error(`strategies/${name}/STRATEGY.md is invalid (${s.errors[0]})`);
  // The leg the user selected (FTH_SYMBOLS), as the gate checks it.
  const selected = selectedSymbols(c.env);
  const notTraded = rootRefusal(s, root, selected);
  if (notTraded) throw new Error(`${name} ${notTraded}`);
  const now = c.now(); // the harness clock: a replay broker's replayed time, else the wall clock
  const bars = readBarsArg(file);
  const lastBar = checkBars(bars, s.timeframe, now, c.env);
  const results = scan(strategies, bars, { symbol: root, now, selected });
  const inputs = { results, root, want, home: harnessHome(c.env), now, lastBar, specOf: liveSpecs(c.env), selected };
  const p = s.signal === 'policy' ? policyPlan(c, s, inputs) : rulesPlan(c, s, inputs);
  const { plan: out, args, line } = buildPlan({ ...p, accountId });
  if (s.signal === 'policy') {
    // The gate's own prop checks on these exact arguments (an entry since the snapshot, the verdict
    // already used, the budget): a plan it would refuse is refused here, with its reason.
    const journal = readJournal(resolveJournalPath(c.env));
    // A paper run (FTH_PAPER=1) plans a paper component's setup too (plan only: the gate refuses every live entry).
    const found = prop.propViolations(inputs.home, { strategy: s, account: p.account, input: args, now, entries: entriesSince(journal, tradingDayStart(now)), journal, specOf: inputs.specOf, selected, strategies, paper: c.env.FTH_PAPER === '1' });
    if (found.length) throw new Error(`the order gate would refuse this entry: ${found.map(v => `[${v.check}] ${v.message}`).join(' ')}`);
  }
  const account = Number.isInteger(accountId) ? '' : ' (add "accountId": the account\'s id)';
  return { text: `${line}\nplace_order arguments${account}: ${JSON.stringify(args)}\n`, plan: out, args };
}

const OPS = { plan };

module.exports = { OPS, plan, candidateOf, checkBars };
