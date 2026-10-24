'use strict';

/**
 * The prop verdict on a composed trade (the composed-entry design section 3.7): a policy strategy (prop_portfolio)
 * whose component is the composed strategy (trade_lifecycle) sizes the model's compose record as it sizes a scan's
 * setup: decideSetup (prop/verdict.js) with the record's side as the direction and its stop (the plan's ticks) as the
 * stop distance, so the budget (a share of the cushion above the floor), the rulebook's multiplier and the
 * one-entry-per-verdict rule apply unchanged. Recorded once per record, at the record's bar, with `record: <id>`, so
 * the gate ties the entry to it. The verdict is the ceiling, and in an attempt the record's size is set from it
 * (trading/lifecycle-order.js attemptSizing: the model's stated size is a suggestion). A sized verdict expires with
 * its record (record.expiresAt).
 *
 *   sizeComposed({ home, policy, component, account, record, plan, briefing, root, contractId, spec, specOf, now })
 *       the verdict on a plan, not recorded (record: { bar, side }; compose_check sizes the record before it exists)
 *   composedVerdict({ ...the same, record: the compose record })
 *       the verdict (the one already recorded for this record when there is one), appended to the verdicts file
 */

const state = require('../trading/prop-state');
const { decideSetup } = require('./verdict');

function sizeComposed({ home, policy, component, account, record, plan, briefing, root, contractId = root, spec, specOf, now = new Date() }) {
  const r = state.readAttempt(home, account.name);
  const bar = briefing && briefing.sections && briefing.sections.m3 && briefing.sections.m3.data ? briefing.sections.m3.data.bar : null;
  if (!r || !r.snapshot || !bar) {
    const reason = !r ? `no ${account.name} attempt` : !r.snapshot ? `no ${account.name} snapshot to size from` : 'no bar in the briefing';
    return { at: now.toISOString(), strategy: policy.name, component, symbol: root, contractId, bar: record.bar, direction: record.side, action: 'skip', multiplier: 0, maxSize: 0, contract: null, reason, expiresAt: now.toISOString() };
  }
  const cs = state.stateFrom(account, r, r.snapshot.balance);
  return decideSetup({
    account, cs, strategy: policy, component, symbol: root, contractId, rawBars: [{ t: record.bar, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v ?? 0 }], spec,
    scan: { direction: record.side, stopDistance: plan.stop.ticks * spec.tickSize }, now, specOf, selected: [root],
  });
}

function composedVerdict(args) {
  const { home, policy, record, root } = args;
  const prior = state.latestVerdict(home, policy.name, root);
  if (prior && prior.record === record.id) return prior;
  const verdict = sizeComposed(args);
  // A sized verdict lasts as long as the record it sized (the strategy's valid_bars, not decideSetup's one bar): the
  // entry the record allows is never refused for a verdict that ran out first. A skip stays expired at once.
  const until = Date.parse(record.expiresAt);
  const out = { ...verdict, record: record.id, ...(verdict.action !== 'skip' && Number.isFinite(until) ? { expiresAt: new Date(until).toISOString() } : {}) };
  state.appendVerdict(home, out);
  return out;
}

module.exports = { sizeComposed, composedVerdict };
