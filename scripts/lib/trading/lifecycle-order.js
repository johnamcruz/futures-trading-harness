'use strict';

/**
 * order_plan for a composed trade (the composed-entry design section 3.5): the order the model's compose record gives,
 * for this cycle's bar and side: a limit at the record's entry reference, the brackets from the record's stop and
 * target (trade-lifecycle.js planOf, worked out again from the re-checked reads), and its size. A calculator: it never
 * picks, and it refuses (with the reason) what the gate would refuse, running the gate's own composed-reads check on
 * the exact arguments.
 *
 * The size:
 *   - outside a prop attempt: the record's, at most the composed strategy's risk.max_risk_usd (size x stop ticks x
 *     tick value); a stated size over it is refused, never cut: the model composes again at or below it;
 *   - in an attempt: the record's size is a suggestion, translated to the correct size (prop/size-translate.js, the one
 *     place: the policy's verdict on the record, recorded once per record by prop/composed-verdict.js, the size budget
 *     now, that cap and the broker's max order size, from the account rulebook's sizing). A translation that skips (the
 *     verdict's skip, a size under the floor min_contracts) is no order. The order goes under the policy's tag on the
 *     verdict's contract, which must be the record's.
 * Phase 2's cut (`approved`, the runner's entry: its approved size; or `size`, outside an attempt a whole size from 1 to
 * the record's) makes the order exactly the smaller; the brackets are the record's, the risk worked out for the size
 * ordered (the gate's composed-reads takes exactly that). In an attempt a cut under the floor is no trade.
 *
 *   composedOrder({ home, root, side, now, cycleBars, strategy, strategies, accounts, specOf, accountId, selected, size, approved, orderMax })
 *       { args, line, plan, policy, account, verdict } or throws the refusal (plan: suggestedSize and translatedSize in an attempt)
 */

const { familyRoot } = require('./contracts');
const { briefingFor } = require('./fact-claims');
const { composedRefusal, recordsAt } = require('./lifecycle-gate');
const { entryRuleOf } = require('./entry-rule');
const prop = require('./prop-state');
const { composedVerdict } = require('../prop/composed-verdict');
const { translatorFor } = require('../prop/size-translate');

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

function composedOrder({ home, root, side, now = new Date(), cycleBars = {}, strategy, strategies = [], accounts = [], specOf, accountId = null, selected = null, paper = false, size = null, approved = null, orderMax = null }) {
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
  const whole = x => x === null || x === undefined || (Number.isInteger(x) && x >= 1);
  if (!whole(approved)) throw new Error(`approved ${JSON.stringify(approved)}: phase 2's approved size is a whole number of 1 or more; no order`);
  const policy = attemptPolicy(home, strategy, strategies, root);
  // Outside an attempt a cut (`size`) is a whole size from 1 to the record's, never more; in one, `size` caps as phase 2's
  // approved size does (the size is the translation's, which the record's suggestion never sets).
  if (size !== null && size !== undefined && !(Number.isInteger(size) && size >= 1 && (policy || size <= stated))) throw new Error(`size ${JSON.stringify(size)}: a cut is a whole size from 1 to the record's ${stated}; no order`);
  const spec = specOf(root);
  if (!spec) throw new Error(`no tick specs for ${root}; no order`);
  const sign = side === 'long' ? 1 : -1;
  const brackets = { limitPrice: held.entry && held.entry.price, stopLossBracket: { ticks: held.stop && held.stop.ticks, type: 'stop' }, takeProfitBracket: { ticks: held.target && held.target.ticks, type: 'limit' } };
  const draft = { ...(Number.isInteger(accountId) ? { accountId } : {}), contractId: root, side: sign > 0 ? 'buy' : 'sell', type: 'limit' };
  // The reads and the plan as the gate re-checks them, at the record's own size (its plan stands as written).
  // The policy's entry rule (entry-rule.js), as the gate's re-check holds it.
  const entryRule = policy ? entryRuleOf(policy.entry) : null;
  const first = composedRefusal({ name: strategy.name, strategy, home, root, input: { ...draft, size: stated, ...brackets }, now, cycleBars, entries: [], specOf, attempt: Boolean(policy), entryRule });
  if (first.message) throw new Error(`the order gate would refuse it: [composed-reads] ${first.message}`);
  const p = first.plan;
  const tick = spec.tickSize;
  const perContract = p.stop.ticks * spec.tickValue;
  const cap = strategy.risk && strategy.risk.max_risk_usd;
  if (!(cap > 0)) throw new Error(`${strategy.name} states no risk.max_risk_usd; no order`);
  const capOf = Math.floor(cap / perContract + 1e-9);
  const capWhy = `${strategy.name}'s risk.max_risk_usd ${usd(cap)} at ${usd(perContract)} a contract`;
  let base = stated;
  let baseWhy = null;
  let translated = null;
  let verdict = null;
  let account = null;
  let translate = null;
  if (policy) {
    account = accounts.find(a => a.name === policy.account && a.valid);
    if (!account) throw new Error(`${policy.name} trades account "${policy.account}", which is not found or invalid`);
    const block = prop.combineBlock(home, account.name, now);
    if (block) throw new Error(`${account.name}: ${block}`);
    verdict = composedVerdict({ home, policy, component: strategy.name, account, record: rec, plan: p, briefing: got.briefing, root, contractId: root, spec, specOf, now });
    // The size translation (prop/size-translate.js): the rulebook's correct size, whatever the record suggests.
    translate = translatorFor({ home, root, policy, account, strategy, verdict, specOf, selected, orderMax });
    const t = translate(p, spec, stated);
    if (t.skip) throw new Error(`${t.reason.startsWith('setup:') ? '[min-contracts] ' : ''}${t.reason}; no order (the record suggested ${stated})`);
    translated = t.size;
    base = t.size;
    baseWhy = t.reason;
  } else {
    if (stated > capOf) throw new Error(`your stated size ${stated} is over the ceiling ${capOf} (${capWhy}): compose again at ${capOf} or less${capOf < 1 ? ' (none fits: pass)' : ''}; the size is never cut for you`);
  }
  // Phase 2's cut (the runner's entry: its approved size; `size` too): exactly the smaller, never more than the base.
  const caps = [approved, size].filter(x => Number.isInteger(x));
  const ordered = Math.min(base, ...caps);
  const cutWhy = ordered < base ? `phase 2 cut ${policy ? 'the translated' : "the record's"} ${base}` : null;
  // The floor: a cut under it is no trade, never sized up.
  const floor = policy ? prop.minContractsRefusal(policy, account, root, ordered, specOf) : null;
  if (floor) throw new Error(`[min-contracts] ${floor}${cutWhy ? ` (${cutWhy} to ${ordered}: no trade)` : ''}`);
  if (policy || cutWhy) {
    // The gate's own composed-reads check on the exact size: the same translation, the cut, nothing else.
    const again = composedRefusal({ name: strategy.name, strategy, home, root, input: { ...draft, size: ordered, ...brackets }, now, cycleBars, entries: [], specOf, approvedSize: cutWhy ? ordered : null, translate, entryRule });
    if (again.message) throw new Error(`the order gate would refuse it: [composed-reads] ${again.message}`);
  }
  const tag = policy ? `setup:${policy.name} ${side} ${strategy.name}` : `setup:${strategy.name} ${side}`;
  const risk = perContract * ordered;
  const rationale = `${tag} limit ${fmt(p.entry.price, tick)} (the record's entry price), stop ${fmt(p.stop.price, tick)} (${p.stop.ticks} ticks, one beyond ${fmt(p.stop.level, tick)}), target ${fmt(p.target.price, tick)} (${p.target.ticks} ticks, ${p.rr}R), ${ordered} ${root} risks ${usd(risk)}, record ${rec.id}`;
  const args = { ...draft, size: ordered, contractId: root, limitPrice: p.entry.price, stopLossBracket: { ticks: p.stop.ticks, type: 'stop' }, takeProfitBracket: { ticks: p.target.ticks, type: 'limit' }, rationale };
  const sizeLine = policy
    ? `size ${ordered}: ${cutWhy ? `${cutWhy}; ` : ''}${baseWhy}; the record suggested ${stated}`
    : cutWhy ? `size ${ordered}: ${cutWhy} (yours ${stated}, at or under the ceiling ${capOf}: ${capWhy})` : `size ${stated}: yours, at or under the ceiling ${capOf} (${capWhy})`;
  const line = [
    `${strategy.name} ${side}: ${ordered} ${root} limit at ${fmt(p.entry.price, tick)} (the record's entry price, valid until ${rec.expiresAt})`,
    `stop ${fmt(p.stop.price, tick)}: ${p.stop.ticks} ticks, stopLossBracket.ticks ${p.stop.ticks}`,
    `target ${fmt(p.target.price, tick)}: ${p.target.ticks} ticks (${p.rr}R), takeProfitBracket.ticks ${p.target.ticks}`,
    `risk ${usd(risk)} = ${ordered} x ${p.stop.ticks} ticks x ${usd(spec.tickValue)}/tick (before fees)`,
    sizeLine,
    ...(strategy.status === 'active' ? [] : [`status ${strategy.status}: plan only, the gate refuses an entry`]),
    ...(paper ? ['paper run: plan only'] : []),
  ].join(' | ');
  const sizes = policy ? { suggestedSize: stated, translatedSize: translated, minContracts: prop.minContractsIn(policy, account, root, specOf), translation: baseWhy } : {};
  return { args, line, plan: { strategy: strategy.name, side, contract: root, size: ordered, ...(cutWhy ? { recordSize: base } : {}), ...sizes, entry: p.entry.price, stopPrice: p.stop.price, stopTicks: p.stop.ticks, targetPrice: p.target.price, targetTicks: p.target.ticks, riskUsd: Number(risk.toFixed(2)), record: rec.id }, policy, account, verdict };
}

module.exports = { composedOrder, attemptPolicy };
