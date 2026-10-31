'use strict';

/**
 * One tier 2 day as its own process (tests/goal/tier2.goal.js runs several at once): the fixture's session through the
 * live path with the mock policy (tests/fixtures/goal-world.js), written as JSON for scripts/lib/eval/goal-path.js.
 * A break (tests/goal/breaks.js) is preloaded by the caller (--require, FTH_GOAL_BREAK).
 *
 *   node tests/goal/tier2-day.js '{"day":"2021-05-26","out":"<file>"}'   (latencyMs: the order-latency self-test's
 *                                  injected stub; fault: a broker fault, goal-world.js FAULTS)
 */

const fs = require('fs');
const path = require('path');
const GC = require('../../scripts/lib/eval/goal-check');
const GF = require('../../scripts/lib/eval/goal-fixture');
const GT = require('../../scripts/lib/eval/goal-trades');
const GM = require('../../scripts/lib/eval/goal-metrics');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const { tradingDayKey } = require('../../scripts/lib/trading/clock');
const GW = require('../fixtures/goal-world');

const ROOT = path.resolve(__dirname, '..', '..');
/** The weekday before a session date (the state days' previous close). */
const prevSession = d => { let t = Date.parse(`${d}T12:00:00Z`); do { t -= 86400000; } while ([0, 6].includes(new Date(t).getUTCDay())); return new Date(t).toISOString().slice(0, 10); };
const KEEP = new Set(['position_managed', 'stop_moved', 'close_recorded', 'eod', 'exit', 'flatten', 'entry_skipped']);

async function main() {
  const { day, out, latencyMs = 0, fault = null, state = null, probe = false } = JSON.parse(process.argv[2]);
  const t0 = Date.now();
  // The fixture set (FTH_GOAL_FIXTURE: ci, the committed slice, or real, the local one), the synthetic days with it.
  const set = GC.fixtureSet(GC.kindOf());
  if (set.missing) throw new Error(set.missing);
  const found = GC.blockOf(set, day);
  if (!found) throw new Error(`${day}: not a fixture session`);
  const { block, doc } = found;
  const bars = GF.decodeBars(block.bars);
  const P = GT.shippedOf(ROOT, {});
  const account = accountNamed(ROOT, P.policy.account, {});
  // The mechanical tier's trades that day (its first entry is what tier 2 should fill) and the day's trend legs.
  const mechanical = GT.blockTrades(bars, [day], P, { symbol: doc.symbol }).trades;
  const legs = GM.trendLegs(bars, [day], { session: P.session, minutes: doc.minutes });
  const w = GW.dayWorld(bars.filter(b => tradingDayKey(new Date(Date.parse(b.t))) <= day), day, { account, fault, probe, state: state ? { ...state, prevDay: prevSession(day) } : null });
  try {
    const r = await GW.runDay(w, { breaks: { latencyMs } });
    const a = GW.artifacts(w);
    const result = {
      day, label: block.labels ? block.labels[day] : null, scenario: block.scenario || null, ms: Date.now() - t0, passes: r.passes, tick: require('../../scripts/lib/trading/contracts').tickOf(doc.symbol),
      decisions: r.decisions.map(({ reads, ...d }) => ({ ...d, reads: (reads || []).map(x => x.read) })),
      events: r.events.filter(e => KEEP.has(e.kind)), logs: r.logs.filter(l => /^(warn|error)/.test(l)),
      ...a, legs, mechanical: mechanical.slice(0, 1), blown: Boolean(a.attempt && a.attempt.snapshot && a.attempt.snapshot.summary && a.attempt.snapshot.summary.status === 'blown'),
    };
    fs.writeFileSync(out, JSON.stringify(result));
  } finally {
    fs.rmSync(w.home, { recursive: true, force: true });
  }
}

main().catch(err => { process.stderr.write(`${err.stack || err.message}\n`); process.exit(1); });
