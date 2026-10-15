'use strict';

/**
 * The composed entry's cycle for the scripted model (scripted-model.js) in the decision-path world
 * (decision-path.js): the round, the lookups the bar requires, compose_check on the reads, the plan, phase 2 and the
 * executor's order, every piece the gate reads. A scenario is { side, skill, reads: [[step, skill, read], ...] }; its
 * reads are TRUE at the bar it is played on. Used by the skill scenarios (tests/e2e/skill-scenarios-e2e.test.js) and the
 * pipeline smoke test (scripted-opencode.js).
 */

const path = require('path');
const D = require('./decision-path');
const { parseRead } = require('../../scripts/lib/trading/composed-reads');
const { requiredFor, needed } = require('../../scripts/lib/trading/skill-lookups');

const TICK = 0.25;

const asReads = list => list.map(([step, skill, read]) => ({ step, skill, read, why: `the ${skill} read` }));
const priceOf = read => Number(parseRead(read).price);

/** Phase-2 FACTS true by the briefing (D.trueFacts), less any the briefing has no value for (an early bar's prior value). */
const facts = w => D.trueFacts(w).filter(f => !/ (null|undefined)$/.test(f)).join('; ');

/** The bar's required lookups for each role, as the gate computes them from the briefing the runner wrote. */
function roleLookups(w) {
  const req = requiredFor(D.ROOT);
  return Object.fromEntries(Object.keys(D.REQUIRED_LOOKUPS).map(role => [role, needed(role, req, D.m3Of(w)).map(r => r.skill)]));
}

/** The head trader's lookups for its composed reads (skills-loaded.js SITUATIONAL, composed): the gate's own list. */
function headLookups(reads) {
  const rels = new Set(reads.map(([, , r]) => parseRead(r)).filter(p => p.kind === 'relation').map(p => p.rel));
  return ['confluence-counting', 'invalidation', ...(rels.has('rejected') ? ['rejection'] : []), ...(rels.has('broke') ? ['breakout'] : [])];
}

/** The place_order a composed trade sends: a limit at the reference with the plan's ticks (`plan`: { ref, stopTicks, targetTicks }). */
const orderOf = (side, size, plan) => ({
  accountId: 7, contractId: 'MNQ', side: side === 'long' ? 'buy' : 'sell', type: 'limit', limitPrice: plan.ref, size,
  stopLossBracket: { ticks: plan.stopTicks, type: 'stop' }, takeProfitBracket: { ticks: plan.targetTicks, type: 'limit' },
  rationale: `setup:trade_lifecycle ${side}, composed from its reads`,
});

/** The plan the reads name, worked out here (D3: the stop one tick beyond its level; the target at its level). */
function expectedPlan(reads, side, ref) {
  const stopLevel = priceOf(reads.find(r => r[0] === 'stop')[2]);
  const target = priceOf(reads.find(r => r[0] === 'target')[2]);
  const stop = side === 'long' ? stopLevel - TICK : stopLevel + TICK;
  return { ref, stop, target, stopTicks: Math.round(Math.abs(ref - stop) / TICK), targetTicks: Math.round(Math.abs(target - ref) / TICK) };
}

/** The composed cycle on the scenario's bar: the round, the lookups, compose_check, the plan, phase 2, the executor. */
function composedCycle(w, s, { reads = s.reads, size = 1, result = null, order = null, rationale = null, policy = null } = {}) {
  return () => [
    ...D.roundSteps(w, { lookups: roleLookups(w) }),
    ...D.entryLoads(w).map(x => ({ load: x })),
    ...headLookups(reads).map(x => ({ lookup: x })),
    { harness: 'compose_check', args: { symbol: 'MNQ', side: s.side, reads: asReads(reads), size } },
    // Inside a policy (an account's attempt): order_plan sizes the record into the policy's verdict, which the gate reads.
    ...(policy ? [{ harness: 'order_plan', args: ctx => ({ bars: path.join(ctx.env.FTH_BARS_DIR, 'MNQ-3m.json'), symbol: 'MNQ', strategy: policy, side: s.side, accountId: 7 }) }] : []),
    { broker: 'journal_add', args: { kind: 'plan', contractId: 'MNQ', tags: ['setup:trade_lifecycle', 'MNQ'], text: `composed ${s.side}, the ${s.skill} read` } },
    { role: 'risk-manager', lookups: [], report: () => `Phase 2 on the trade_lifecycle ${s.side} plan for MNQ.\nVERDICT: APPROVE - size ${size}\nFACTS: ${facts(w)}` },
    { executor: [{ broker: 'place_order', args: () => order || { ...orderOf(s.side, size, expectedPlan(s.reads, s.side, D.m3Of(w).price)), ...(rationale ? { rationale } : {}) } }] },
    { result: result || `CYCLE RESULT: executed - trade_lifecycle ${s.side} MNQ ${size}` },
  ];
}


module.exports = { TICK, asReads, priceOf, facts, roleLookups, headLookups, orderOf, expectedPlan, composedCycle };
