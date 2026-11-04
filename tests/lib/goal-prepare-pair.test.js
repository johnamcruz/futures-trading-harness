'use strict';

// Tier 2's prepare-ahead comparison (tests/goal/prepare-pair.js): "on" against "off" on the same day, the old path's
// trades, order calls, gate decisions, compose records and cycle results. The same day is no problem; any change in
// any one of them is a problem naming it (the check can fail); only run-local values are ignored.

const test = require('node:test');
const assert = require('node:assert');
const P = require('../goal/prepare-pair');

const day = () => ({
  day: '2021-05-26', tick: 0.25, decisions: [], events: [], snaps: [], sent: [], legs: [], mechanical: [], fills: [], orders: [], attempt: null,
  calls: [{ tool: 'place_order', args: { side: 'buy', size: 3 } }],
  gate: [{ ts: '2026-11-04T00:00:00Z', cycle: 'aaaaaaaaaaaaaaaa', source: 'gateway', tool: 'place_order', decision: 'allowed', violations: [], side: 'buy', size: 3, type: 'market', rationale: 'setup:prop_portfolio long' }],
  records: [{ id: 'r1', at: '2021-05-26T14:03:02.000Z', ok: true, side: 'long', cycleBar: '2021-05-26T14:00:00.000Z', plan: { entry: 1 }, problems: [] }],
  cycles: [{ at: 'x', result: 'CYCLE RESULT: planned - trade_lifecycle long 3' }],
});

test('prepare pair: the same day is no problem; run-local values (the gate\'s stamp and cycle id, a record\'s id) never are', () => {
  const on = day();
  on.gate[0].ts = '2026-11-05T00:00:00Z';
  on.gate[0].cycle = 'bbbbbbbbbbbbbbbb';
  on.records[0].id = 'r2';
  on.cycles[0].at = 'y';
  const off = day();
  off.calls[0].args.rationale = 'setup:prop_portfolio long, record 0717d27ef846e411';
  on.calls[0].args.rationale = 'setup:prop_portfolio long, record 761cd0bd21bcbfc3';
  off.calls[0].args.customTag = 'fth-9101973fab256e69';
  on.calls[0].args.customTag = 'fth-0a3367534d830f34';
  off.gate[0].rationale = off.calls[0].args.rationale;
  on.gate[0].rationale = on.calls[0].args.rationale;
  assert.deepStrictEqual(P.pairProblems(off, on), []);
  // Anything else in the rationale still counts.
  on.calls[0].args.rationale = 'setup:prop_portfolio short, record 761cd0bd21bcbfc3';
  assert.strictEqual(P.pairProblems(off, on).length, 1);
});

test('prepare pair: the check can fail: an order, a gate decision, a compose record, a cycle result that differs is named', () => {
  const cases = {
    calls: x => { x.calls[0].args.size = 4; },
    gate: x => { x.gate[0].decision = 'blocked'; x.gate[0].violations = [{ check: 'composed-reads' }]; },
    records: x => { x.records.push({ ...x.records[0], at: 'later' }); },
    results: x => { x.cycles[0].result = 'CYCLE RESULT: no-trade - the plan said pass'; },
  };
  for (const [field, f] of Object.entries(cases)) {
    const on = day();
    f(on);
    const p = P.pairProblems(day(), on);
    assert.strictEqual(p.length, 1, field);
    assert.match(p[0], new RegExp(`^2021-05-26: ${field} differ`), field);
  }
});

test('prepare pair: the off runs, each made once (asked for at once by tests running side by side, they share one run), keyed by the days and the world\'s options; "on" runs go as asked', async () => {
  const calls = [];
  const runDays = async (days, o) => { calls.push({ days, claude: o.claude }); await new Promise(r => setTimeout(r, 5)); return days.map(d => ({ day: d, k: JSON.stringify(o.claude) })); };
  const R = P.pairRuns({ runDays, dir: '/x' });
  const [a, b, c] = await Promise.all([R.offFor(['d1']), R.offFor(['d1']), R.offFor(['d1'], { fault: 'pnl-change' })]);
  assert.strictEqual(a, b, 'one run shared');
  assert.deepStrictEqual(Object.keys(a), ['d1']);
  assert.strictEqual(c.d1.k, JSON.stringify({ on: false, fault: 'pnl-change' }));
  assert.deepStrictEqual(calls.map(x => [x.days, x.claude]), [[['d1'], { on: false }], [['d1'], { on: false, fault: 'pnl-change' }]], 'two off runs, never a third');
  await R.offFor(['d1']);
  assert.strictEqual(calls.length, 2);
  // "on": never memoised (each test's own world).
  await R.onOf(['d1'], { fault: 'x' });
  await R.onOf(['d1'], { fault: 'x' });
  assert.deepStrictEqual(calls.slice(2).map(x => x.claude), [{ prepareAhead: 'on', fault: 'x' }, { prepareAhead: 'on', fault: 'x' }]);
  // The pair and the sums.
  assert.deepStrictEqual(R.sum([{ prepare: { made: 2 } }, { prepare: { made: 3 } }], 'made'), 5);
});
