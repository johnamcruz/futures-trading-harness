'use strict';

/**
 * order_plan for a composed trade (the composed-entry design section 3.5): the order the model's compose record gives,
 * for this cycle's bar and side: a limit at the record's entry reference, the brackets from the record's stop and
 * target (trade-lifecycle.js planOf, worked out again from the re-checked reads), and the size the model stated, checked
 * against the ceiling code sets. A calculator: it never picks or sizes up, and it refuses (with the reason) what the
 * gate would refuse, running the gate's own composed-reads check on the exact arguments.
 *
 * The ceiling:
 *   - outside a prop attempt: the composed strategy's risk.max_risk_usd (size x stop ticks x tick value);
 *   - in an attempt: the lower of that cap and the policy's verdict on the record (prop/composed-verdict.js,
 *     recorded once per record) and the size budget now; the order goes under the policy's tag on the verdict's
 *     contract, which must be the record's (a size is a number of its own contract).
 * A stated size over the ceiling is refused, never cut: the model composes again at or below it.
 *
 *   composedOrder({ home, root, side, now, cycleBars, strategy, strategies, accounts, specOf, accountId, selected })
 *       { args, line, plan, policy, account, verdict } or throws the refusal
 */

const { familyRoot } = require('./contracts');
const { briefingFor } = require('./fact-claims');
const { composedRefusal, recordsAt } = require('./lifecycle-gate');
const prop = require('./prop-state');
const { composedVerdict } = require('../prop/composed-verdict');

const fmt = (x, tick) => Number(x).toFixed((String(tick).split('.')[1] || '').length);
const usd = x => `$${Number(x).toFixed(2)}`;

/** The policy that trades the composed strategy in a running attempt, or null; throws when an attempt runs without one. */
function attemptPolicy(home, strategy, strategies, root) {
  const running = prop.runningAttempts(home);
  if (!running.length) return null;
  const p = (strategies || []).find(s => s.valid && s.signal === 'policy' && running.includes(s.account) && (s.strategies || []).includes(strategy.name)
    && s.instruments.some(x => familyRoot(x) === familyRoot(root)));
  if (!p) throw new Error(`a ${running.join(', ')} attempt is running and no policy strategy that trades it lists ${strategy.name}: no entry`);
  return p;
}

function composedOrder({ home, root, side, now = new Date(), cycleBars = {}, strategy, strategies = [], accounts = [], specOf, accountId = null, selected = null, paper = false }) {
  const cycleBar = (cycleBars || {})[familyRoot(root)] || null;
  if (!cycleBar) throw new Error(`no cycle bar for ${familyRoot(root)} (FTH_CYCLE_BARS): a composed trade is planned only in the runner's cycle, on its bar`);
  const got = briefingFor(home, root, { cycleBar, now });
  if (!got.briefing) throw new Error(`the cycle bar's briefing can't be read (${got.why})`);
  const mine = recordsAt(home, root, cycleBar).filter(r => r.side === side);
  if (!mine.length) throw new Error(`no compose record for the ${familyRoot(root)} ${side} on the bar opened ${cycleBar}: compose_check first`);
  const rec = mine[mine.length - 1];
  const held = rec.plan && typeof rec.plan === 'object' ? rec.plan : {};
  const stated = Number.isInteger(held.size) && held.size >= 1 ? held.size : null;
  if (stated === null) throw new Error('the compose record states no size: compose again with your size');
  const policy = attemptPolicy(home, strategy, strategies, root);
  const spec = specOf(root);
  if (!spec) throw new Error(`no tick specs for ${root}; no order`);
  const sign = side === 'long' ? 1 : -1;
  const draft = { ...(Number.isInteger(accountId) ? { accountId } : {}), contractId: root, side: sign > 0 ? 'buy' : 'sell', type: 'limit', size: stated };
  const first = composedRefusal({ name: strategy.name, strategy, home, root, input: { ...draft, limitPrice: held.entry && held.entry.price, stopLossBracket: { ticks: held.stop && held.stop.ticks, type: 'stop' }, takeProfitBracket: { ticks: held.target && held.target.ticks, type: 'limit' } }, now, cycleBars, entries: [], specOf });
  if (first.message) throw new Error(`the order gate would refuse it: [composed-reads] ${first.message}`);
  const p = first.plan;
  const tick = spec.tickSize;
  const perContract = p.stop.ticks * spec.tickValue;
  let contract = root;
  let ceiling;
  let ceilingWhy;
  let verdict = null;
  let account = null;
  if (policy) {
    account = accounts.find(a => a.name === policy.account && a.valid);
    if (!account) throw new Error(`${policy.name} trades account "${policy.account}", which is not found or invalid`);
    const block = prop.combineBlock(home, account.name, now);
    if (block) throw new Error(`${account.name}: ${block}`);
    verdict = composedVerdict({ home, policy, component: strategy.name, account, record: rec, plan: p, briefing: got.briefing, root, contractId: root, spec, specOf, now });
    if (verdict.action !== 'full' || !(verdict.maxSize >= 1)) throw new Error(`${policy.name} skipped the composed setup${verdict.reason ? ` (${verdict.reason})` : ''}; no order`);
    if (verdict.contract !== root) throw new Error(`${policy.name}'s verdict trades ${verdict.contract}, not ${root}, the record's contract: a stated size is a number of its own contract; compose on ${verdict.contract}`);
    contract = verdict.contract;
  }
  // The strategy's dollar cap is the hard ceiling, inside an attempt too (the owner's $300); the verdict and the budget
  // lower it there, never raise it.
  const cap = strategy.risk && strategy.risk.max_risk_usd;
  if (!(cap > 0)) throw new Error(`${strategy.name} states no risk.max_risk_usd; no order`);
  const capSize = Math.floor(cap / perContract + 1e-9);
  ceiling = capSize;
  ceilingWhy = `${strategy.name}'s risk.max_risk_usd ${usd(cap)} at ${usd(perContract)} a contract`;
  if (verdict) {
    const b = prop.budgetPlan(home, account, policy, verdict.contract, verdict.stopTicks, prop.verdictMultiplier(verdict) ?? 1, specOf, selected);
    if (b.error) throw new Error(`${account.name}: ${b.error}`);
    const prop0 = Math.min(verdict.maxSize, b.root === verdict.contract ? b.size : 0);
    if (prop0 < ceiling) {
      ceiling = prop0;
      ceilingWhy = `${policy.name}'s verdict (${verdict.maxSize} ${verdict.contract}) and the size budget now, under the ${usd(cap)} cap`;
    }
  }
  if (stated > ceiling) throw new Error(`your stated size ${stated} is over the ceiling ${ceiling} (${ceilingWhy}): compose again at ${ceiling} or less${ceiling < 1 ? ' (none fits: pass)' : ''}; the size is never cut for you`);
  const tag = policy ? `setup:${policy.name} ${side} ${strategy.name}` : `setup:${strategy.name} ${side}`;
  const risk = perContract * stated;
  const rationale = `${tag} limit ${fmt(p.entry.price, tick)} (the record's entry price), stop ${fmt(p.stop.price, tick)} (${p.stop.ticks} ticks, one beyond ${fmt(p.stop.level, tick)}), target ${fmt(p.target.price, tick)} (${p.target.ticks} ticks, ${p.rr}R), ${stated} ${contract} risks ${usd(risk)}, record ${rec.id}`;
  const args = { ...draft, contractId: contract, limitPrice: p.entry.price, stopLossBracket: { ticks: p.stop.ticks, type: 'stop' }, takeProfitBracket: { ticks: p.target.ticks, type: 'limit' }, rationale };
  const line = [
    `${strategy.name} ${side}: ${stated} ${contract} limit at ${fmt(p.entry.price, tick)} (the record's entry price, valid until ${rec.expiresAt})`,
    `stop ${fmt(p.stop.price, tick)}: ${p.stop.ticks} ticks, stopLossBracket.ticks ${p.stop.ticks}`,
    `target ${fmt(p.target.price, tick)}: ${p.target.ticks} ticks (${p.rr}R), takeProfitBracket.ticks ${p.target.ticks}`,
    `risk ${usd(risk)} = ${stated} x ${p.stop.ticks} ticks x ${usd(spec.tickValue)}/tick (before fees)`,
    `size ${stated}: yours, at or under the ceiling ${ceiling} (${ceilingWhy})`,
    ...(strategy.status === 'active' ? [] : [`status ${strategy.status}: plan only, the gate refuses an entry`]),
    ...(paper ? ['paper run: plan only'] : []),
  ].join(' | ');
  return { args, line, plan: { strategy: strategy.name, side, contract, size: stated, entry: p.entry.price, stopPrice: p.stop.price, stopTicks: p.stop.ticks, targetPrice: p.target.price, targetTicks: p.target.ticks, riskUsd: Number(risk.toFixed(2)), record: rec.id }, policy, account, verdict };
}

module.exports = { composedOrder, attemptPolicy };
