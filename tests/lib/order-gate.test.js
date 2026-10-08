'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateOrder, isRiskReducing, formatBlock } = require('../../scripts/lib/trading/order-gate');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { NOW, CONTRACT, minutesAgo, plan, placed, review, entryOrder } = require('../helpers');

const config = { ...loadConfig({}), killSwitchFile: '/nonexistent/fth/STOP' };
const checks = r => r.violations.map(v => v.check).sort();
const evaluate = (input, entries, opts = {}) =>
  evaluateOrder({ input, entries, now: opts.now || NOW, config: opts.config || config, blackouts: opts.blackouts });

test('a planned, tagged, stopped entry passes', () => {
  const r = evaluate(entryOrder(), [plan()]);
  assert.strictEqual(r.intent, 'entry');
  assert.deepStrictEqual(r.violations, []);
});

test('[exit] and [protect] orders are never gated', () => {
  assert.strictEqual(isRiskReducing('  [EXIT] target hit'), true);
  assert.strictEqual(isRiskReducing('exit soon [exit]'), false);
  const r = evaluate(entryOrder({ rationale: '[protect] stop for filled ORB long at 21480', stopLossBracket: undefined }), []);
  assert.strictEqual(r.intent, 'risk-reducing');
  assert.deepStrictEqual(r.violations, []);
});

test('entry needs a setup tag, a stop, and a fresh plan', () => {
  const r = evaluate(entryOrder({ rationale: 'looks strong, going long here', stopLossBracket: undefined }), []);
  assert.deepStrictEqual(checks(r), ['plan-required', 'setup-tag', 'stop-defined']);
});

test('stop stated in the rationale satisfies stop-defined', () => {
  const r = evaluate(entryOrder({ stopLossBracket: undefined, rationale: 'setup:bos long, stop at 21480.25, target 21540' }), [plan()]);
  assert.deepStrictEqual(r.violations, []);
});

test('stale, other-symbol, and previous-day plans do not count', () => {
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan(121)])), ['plan-required']);
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan(5, { contractId: 'CON.F.US.MES.Z26' })])), ['plan-required']);
  // NOW is 09:00 CT; 17 hours ago is before the 17:00 CT trading-day start
  const big = { ...config, planMaxAgeMin: 24 * 60 };
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan(17 * 60)], { config: big })), ['plan-required']);
});

test('a plan must name the contract with contractId; text mentions do not count', () => {
  const p = { ts: minutesAgo(5), kind: 'plan', text: 'MNQ: ORB long above 21500' };
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [p])), ['plan-required']);
});

test('setup tag must open the rationale and the stop must be a number after "stop"', () => {
  assert.deepStrictEqual(checks(evaluate(entryOrder({ rationale: 'this is not setup:orb, stop 21480' }), [plan()])), ['setup-tag']);
  assert.deepStrictEqual(checks(evaluate(entryOrder({ stopLossBracket: undefined, rationale: 'setup:orb never stop out, 2x size' }), [plan()])), ['stop-defined']);
  assert.deepStrictEqual(evaluate(entryOrder({ stopLossBracket: undefined, rationale: '  setup:orb long, stop: 21480' }), [plan()]).violations, []);
});

test('reviews without a result tag or for another contract do not clear the review gate', () => {
  const untagged = { ts: minutesAgo(10), kind: 'review', text: 'done', tags: ['setup:orb'] };
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [placed(30), untagged, plan(5)])), ['review-before-next-entry']);
  const otherContract = { ...review(10, 'win'), contractId: 'CON.F.US.MES.Z26' };
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [placed(30), otherContract, plan(5)])), ['review-before-next-entry']);
});

test('paper mode and a truncated journal window block entries; autonomous mode ignores skip lists', () => {
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan()], { config: { ...config, paper: true } })), ['paper-mode']);
  const r = evaluateOrder({ input: entryOrder(), entries: [plan(5)], now: NOW, config, journalTruncated: true });
  assert.deepStrictEqual(r.violations.map(v => v.check), ['journal-window']);
  assert.strictEqual(loadConfig({ FTH_AUTONOMOUS: '1', FTH_ORDER_GATE_SKIP: 'plan-required' }).skipChecks.size, 0);
});

test('no new entries in the opening 5 minutes of New York, into the close, or after it', () => {
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan(1, { ts: '2026-10-07T13:31:00Z' })], { now: new Date('2026-10-07T13:32:00Z') })), ['time-window']);
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan(1, { ts: '2026-10-07T19:49:00Z' })], { now: new Date('2026-10-07T19:50:00Z') })), ['time-window']);
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan(1, { ts: '2026-10-07T20:04:00Z' })], { now: new Date('2026-10-07T20:05:00Z') })), ['market-hours']);
});

test('invalid window config blocks (fail closed)', () => {
  const bad = { ...config, noEntryWindows: 'whenever' };
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan()], { config: bad })), ['time-window']);
  const none = { ...config, noEntryWindows: '' };
  assert.deepStrictEqual(evaluate(entryOrder(), [plan()], { config: none }).violations, []);
});

test('a blackout entry without a valid start and end blocks instead of being skipped', () => {
  const r = evaluate(entryOrder(), [plan()], { blackouts: { items: [{ start: 'Oct 8 8:30 ET', end: 'later' }] } });
  assert.deepStrictEqual(checks(r), ['blackout']);
});

test('news blackouts block entries; broken blackout file blocks too', () => {
  const items = [{ start: minutesAgo(5), end: minutesAgo(-10), reason: 'CPI' }];
  const r = evaluate(entryOrder(), [plan()], { blackouts: { items } });
  assert.deepStrictEqual(checks(r), ['blackout']);
  assert.match(r.violations[0].message, /CPI/);
  const past = [{ start: minutesAgo(30), end: minutesAgo(20) }];
  assert.deepStrictEqual(evaluate(entryOrder(), [plan()], { blackouts: { items: past } }).violations, []);
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan()], { blackouts: { items: [], error: 'invalid JSON' } })), ['blackout']);
});

test('two losses in a row start a cooldown; a win resets the streak', () => {
  const journal = [plan(100), placed(90), review(80, 'loss'), placed(70), review(20, 'loss'), plan(5)];
  const r = evaluate(entryOrder(), journal);
  assert.deepStrictEqual(checks(r), ['loss-streak']);
  assert.match(r.violations[0].message, /10 min more/);
  const cooled = [plan(100), placed(90), review(80, 'loss'), placed(70), review(31, 'loss'), plan(5)];
  assert.deepStrictEqual(evaluate(entryOrder(), cooled).violations, []);
  const reset = [plan(100), placed(90), review(80, 'loss'), placed(70), review(60, 'win'), placed(50), review(20, 'loss'), plan(5)];
  assert.deepStrictEqual(evaluate(entryOrder(), reset).violations, []);
});

test('three losing trades end the trading day', () => {
  const journal = [placed(200), review(190, 'loss'), placed(180), review(170, 'win'), placed(160), review(150, 'loss'),
    placed(140), review(130, 'win'), placed(120), review(100, 'loss'), plan(5)];
  assert.deepStrictEqual(checks(evaluate(entryOrder(), journal)), ['daily-loss-count']);
});

test('an unreviewed entry blocks the next entry; failed and exit orders do not count', () => {
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [placed(30), plan(5)])), ['review-before-next-entry']);
  assert.deepStrictEqual(evaluate(entryOrder(), [placed(30, 'setup:orb x stop 1', false), plan(5)]).violations, []);
  assert.deepStrictEqual(evaluate(entryOrder(), [placed(30, '[exit] flatten'), plan(5)]).violations, []);
  assert.deepStrictEqual(evaluate(entryOrder(), [placed(30), review(10, 'nofill'), plan(5)]).violations, []);
});

test('paper reviews do not count as live reviews or losses', () => {
  const paperLoss = (m) => ({ ...review(m, 'loss'), tags: ['result:loss', 'setup:orb', 'paper'] });
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [placed(30), paperLoss(10), plan(5)])), ['review-before-next-entry']);
  assert.deepStrictEqual(evaluate(entryOrder(), [paperLoss(25), paperLoss(10), plan(5)]).violations, []);
});

test('max entries per trading day', () => {
  const journal = [];
  for (let i = 0; i < 6; i += 1) journal.push(placed(300 - i * 40), review(290 - i * 40, i % 2 ? 'win' : 'scratch'));
  journal.push(plan(5));
  assert.deepStrictEqual(checks(evaluate(entryOrder(), journal)), ['max-entries']);
  assert.deepStrictEqual(evaluate(entryOrder(), journal, { config: { ...config, maxEntriesPerDay: 0 } }).violations, []);
});

test('FTH_ORDER_GATE_SKIP turns off named checks only', () => {
  const skipping = loadConfig({ FTH_ORDER_GATE_SKIP: 'plan-required, setup-tag' });
  const r = evaluate(entryOrder({ rationale: 'long, stop 21480 because reasons' }), [], { config: skipping });
  assert.deepStrictEqual(r.violations, []);
});

test('strategy check: known, active, instrument, and session', () => {
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  // The bundled orb has no session gate (as in algoTraderBot); give it one here.
  const strategies = loadStrategies(require('path').resolve(__dirname, '..', '..'), {}).strategies
    .map(s => (s.name === 'orb' ? { ...s, sessions: ['09:45-11:30@America/New_York'] } : s));
  const at = iso => evaluate(entryOrder(), [plan(1, { ts: new Date(Date.parse(iso) - 60000).toISOString() })], { now: new Date(iso) });
  const withReg = (input, iso) => evaluateOrder({ input, entries: [plan(1, { ts: new Date(Date.parse(iso) - 60000).toISOString() })], now: new Date(iso), config, strategies });
  // 10:00 ET Wednesday: inside orb's 09:45-11:30 session
  assert.deepStrictEqual(withReg(entryOrder(), '2026-10-07T14:00:00Z').violations, []);
  assert.deepStrictEqual(at('2026-10-07T14:00:00Z').violations, []);
  // 12:00 ET: outside the session
  assert.deepStrictEqual(checks(withReg(entryOrder(), '2026-10-07T16:00:00Z')), ['strategy']);
  // unknown strategy and instrument not traded
  assert.match(withReg(entryOrder({ rationale: 'setup:mystery long stop 1' }), '2026-10-07T14:00:00Z').violations[0].message, /not a known strategy/);
  assert.match(withReg(entryOrder({ contractId: 'CON.F.US.MCL.Z26' }), '2026-10-07T14:00:00Z').violations.map(v => v.message).join(), /does not trade MCL/);
  // paper strategies cannot place live entries
  const paper = strategies.map(s => (s.name === 'orb' ? { ...s, status: 'paper' } : s));
  const r = evaluateOrder({ input: entryOrder(), entries: [plan(1)], now: NOW, config, strategies: paper });
  assert.match(r.violations[0].message, /status "paper"/);
});

test('kill switch blocks entries but not exits', () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(require('../helpers').tmpDir(), 'STOP');
  fs.writeFileSync(file, '');
  const on = { ...config, killSwitchFile: file };
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan()], { config: on })), ['kill-switch']);
  assert.deepStrictEqual(evaluate(entryOrder({ rationale: '[exit] flatten' }), [], { config: on }).violations, []);
});

test('formatBlock lists every violation', () => {
  const text = formatBlock([{ check: 'a', message: 'one' }, { check: 'b', message: 'two' }]);
  assert.match(text, /^Blocked by trading harness/);
  assert.match(text, /- \[a\] one\n- \[b\] two/);
  assert.ok(CONTRACT);
});

test('modify_order size changes need an [exit]/[protect] reason (the gateway then checks it is a decrease)', () => {
  const { evaluateModify } = require('../../scripts/lib/trading/order-gate');
  const cfg = loadConfig({});
  assert.deepStrictEqual(evaluateModify({ input: { orderId: 1, size: 1 }, config: cfg }).violations.map(v => v.check), ['modify-size']);
  assert.deepStrictEqual(evaluateModify({ input: { orderId: 1, size: 1, reason: '[protect] cut the stop to 1 after scaling out' }, config: cfg }).violations, []);
});

test('market hours are a hard rule: entries only in the 18:00-16:00 ET session, Sunday evening to Friday, whatever the config', () => {
  const open = loadConfig({ FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_ORDER_GATE_SKIP: 'time-window,market-hours' });
  const at = iso => checks(evaluate(entryOrder(), [plan(1, { ts: new Date(Date.parse(iso) - 60000).toISOString() })], { now: new Date(iso), config: open }));
  const blocked = (iso, why) => assert.ok(at(iso).includes('market-hours'), why);
  const allowed = (iso, why) => assert.ok(!at(iso).includes('market-hours'), why);
  allowed('2026-10-07T13:29:00Z', 'Wed 09:29 ET (London)');
  allowed('2026-10-07T19:59:00Z', 'Wed 15:59 ET');
  blocked('2026-10-07T20:00:00Z', 'Wed 16:00 ET: the close');
  blocked('2026-10-07T21:59:00Z', 'Wed 17:59 ET: the break');
  allowed('2026-10-07T22:00:00Z', 'Wed 18:00 ET: the open');
  allowed('2026-10-08T02:00:00Z', 'Wed 22:00 ET (Asia)');
  blocked('2026-10-09T22:30:00Z', 'Fri 18:30 ET: weekend');
  blocked('2026-10-10T14:30:00Z', 'Saturday');
  blocked('2026-10-11T21:30:00Z', 'Sun 17:30 ET');
  allowed('2026-10-11T22:30:00Z', 'Sun 18:30 ET');
  const exit = evaluate(entryOrder({ side: 'sell', rationale: '[exit] flatten' }), [], { now: new Date('2026-10-10T14:30:00Z'), config: open });
  assert.deepStrictEqual(exit.violations, [], 'exits are always allowed');
});

test('FTH_ENTRY_HOURS narrows entries (default: the whole session; named sessions work)', () => {
  const at = (iso, env = {}) => evaluate(entryOrder(), [plan(1, { ts: new Date(Date.parse(iso) - 60000).toISOString() })], { now: new Date(iso), config: loadConfig(env) });
  assert.ok(!checks(at('2026-10-07T07:00:00Z')).includes('time-window'), '03:00 ET is in the session by default');
  assert.ok(checks(at('2026-10-07T07:00:00Z', { FTH_ENTRY_HOURS: 'ny' })).includes('time-window'), 'ny only: 03:00 ET refused');
  assert.ok(!checks(at('2026-10-07T14:00:00Z', { FTH_ENTRY_HOURS: 'ny' })).includes('time-window'), 'ny only: 10:00 ET');
  assert.ok(!checks(at('2026-10-07T07:00:00Z', { FTH_ENTRY_HOURS: 'london' })).includes('time-window'), 'london: 03:00 ET');
  const { evaluateModify } = require('../../scripts/lib/trading/order-gate');
  assert.deepStrictEqual(evaluateModify({ input: { orderId: 1, size: 50.5, reason: '[protect] x' }, config: loadConfig({}) }).violations.map(v => v.check), ['modify-size']);
});

test('exchange calendar: holidays have no session, early closes end entries at 13:00 ET', () => {
  const cal = loadConfig({ FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_CLOSED_DATES: '2026-12-25', FTH_EARLY_CLOSE_DATES: '2026-11-27' });
  const at = iso => checks(evaluate(entryOrder(), [plan(1, { ts: new Date(Date.parse(iso) - 60000).toISOString() })], { now: new Date(iso), config: cal }));
  assert.ok(at('2026-12-25T15:00:00Z').includes('market-hours'), 'Christmas Day 10:00 ET');
  assert.ok(at('2026-12-25T02:00:00Z').includes('market-hours'), 'Christmas Eve 21:00 ET belongs to the closed day');
  assert.ok(!at('2026-11-27T17:59:00Z').includes('market-hours'), 'early close: 12:59 ET');
  assert.ok(at('2026-11-27T18:00:00Z').includes('market-hours'), 'early close: 13:00 ET');
});

test('the test clock (FTH_TEST_NOW) works only under the test suite, never in autonomous runs', () => {
  const { gateNow } = require('../../scripts/lib/trading/config');
  const far = '2020-01-01T00:00:00Z';
  const near = t => Math.abs(t.getTime() - Date.now()) < 60000;
  assert.ok(near(gateNow({ FTH_TEST_NOW: far })), 'ignored without NODE_ENV=test');
  assert.ok(near(gateNow({ FTH_TEST_NOW: far, NODE_ENV: 'test', FTH_AUTONOMOUS: '1' })), 'ignored in autonomous runs');
  assert.ok(!near(gateNow({ FTH_TEST_NOW: far, NODE_ENV: 'test' })));
});
