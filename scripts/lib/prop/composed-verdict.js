'use strict';

/**
 * The prop verdict on a composed trade (the composed-entry design section 3.7): a policy strategy (prop_portfolio)
 * whose component is the composed strategy (trade_lifecycle) sizes the model's compose record as it sizes a scan's
 * setup: decideSetup (prop/verdict.js) with the record's side as the direction and its stop (the plan's ticks) as the
 * stop distance, so the budget (a share of the cushion above the floor), the rulebook's multiplier and the
 * one-entry-per-verdict rule apply unchanged. Recorded once per record, at the record's bar, with `record: <id>`, so
 * the gate ties the entry to it. The verdict is the ceiling: the model's stated size goes at or below it.
 *
 *   composedVerdict({ home, policy, component, account, record, plan, briefing, root, contractId, spec, specOf, now })
 *       the verdict (the one already recorded for this record when there is one), appended to the verdicts file
 */

const state = require('../trading/prop-state');
const { decideSetup } = require('./verdict');

function composedVerdict({ home, policy, component, account, record, plan, briefing, root, contractId = root, spec, specOf, now = new Date() }) {
  const prior = state.latestVerdict(home, policy.name, root);
  if (prior && prior.record === record.id) return prior;
  const r = state.readAttempt(home, account.name);
  const bar = briefing && briefing.sections && briefing.sections.m3 && briefing.sections.m3.data ? briefing.sections.m3.data.bar : null;
  let verdict;
  if (!r || !r.snapshot || !bar) {
    const reason = !r ? `no ${account.name} attempt` : !r.snapshot ? `no ${account.name} snapshot to size from` : 'no bar in the briefing';
    verdict = { at: now.toISOString(), strategy: policy.name, component, symbol: root, contractId, bar: record.bar, direction: record.side, action: 'skip', multiplier: 0, maxSize: 0, contract: null, reason, expiresAt: now.toISOString() };
  } else {
    const cs = state.stateFrom(account, r, r.snapshot.balance);
    verdict = decideSetup({
      account, cs, strategy: policy, component, symbol: root, contractId, rawBars: [{ t: record.bar, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v ?? 0 }], spec,
      scan: { direction: record.side, stopDistance: plan.stop.ticks * spec.tickSize }, now, specOf, selected: [root],
    });
  }
  const out = { ...verdict, record: record.id };
  state.appendVerdict(home, out);
  return out;
}

module.exports = { composedVerdict };
