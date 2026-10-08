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

// --- Prop challenge: the hard `combine` and `policy` checks (trading/prop-state.js). ---
const prop = require('../../scripts/lib/trading/prop-state');
const { tmpDir } = require('../helpers');

const MINI = {
  name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod',
  daily_loss_limit: 1000, daily_loss_soft: 500, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50 }, fees_per_side: { MNQ: 0.37 },
};
// A policy strategy tagged setup:orb (the helpers' order) trading micros on the mini account.
const propStrategy = (extra = {}) => ({
  name: 'orb', valid: true, errors: [], status: 'active', instruments: ['MNQ', 'NQ'], signal: 'policy', compiledRules: null,
  strategies: ['ema_cross'], account: 'mini', contracts: 'micro', ...extra,
});
function propSetup({ balance = 50000, policy = false, verdict = policy ? null : {}, account = MINI, days = [] } = {}) {
  const home = tmpDir();
  prop.startAttempt(home, account, new Date(NOW.getTime() - (days.length + 1) * 86400000));
  for (const [day, close] of days) prop.recordEndOfDay(home, account, close, day);
  if (balance !== null) prop.snapshot(home, account, balance, new Date(NOW.getTime() - 60000));
  // The verdict the runner records at the setup (without a bundle: the sizing's own).
  if (verdict) {
    prop.appendVerdict(home, {
      strategy: 'orb', component: 'ema_cross', contractId: CONTRACT, symbol: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', stopTicks: 40,
      maxSize: policy ? 3 : 50, policy: policy ? 'p1' : null, bar: '2026-10-07T13:57:00Z', at: '2026-10-07T13:59:30Z', expiresAt: new Date(NOW.getTime() + 120000).toISOString(), ...verdict,
    });
  }
  const strategies = [propStrategy(policy ? { policy: { bundle: 'p1' } } : {})];
  return (input, opts = {}) => evaluateOrder({ input, entries: [plan()], now: opts.now || NOW, config: { ...config, home, skipChecks: new Set(['combine', 'policy', 'strategy']) }, strategies, accounts: opts.accounts || [account] });
}

test('combine: a strategy that trades an account needs a started attempt and a fresh snapshot (hard, unskippable)', () => {
  const none = evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home: tmpDir() }, strategies: [propStrategy()], accounts: [MINI] });
  assert.match(none.violations.find(v => v.check === 'combine').message, /no mini attempt is started/);
  const noSnapshot = propSetup({ balance: null });
  assert.match(noSnapshot(entryOrder()).violations[0].message, /snapshot is missing or older/);
  const fresh = propSetup();
  assert.deepStrictEqual(fresh(entryOrder()).violations, [], 'skipChecks cannot reach it, and a fresh in-budget entry passes');
  const stale = fresh(entryOrder(), { now: new Date(NOW.getTime() + 11 * 60000) });
  assert.match(stale.violations[0].message, /older than 10 minutes/);
  assert.match(fresh(entryOrder(), { accounts: [] }).violations[0].message, /not found/);
});

test('combine: the account blocks entries at the soft daily limit and sizes from the cushion for the order\'s stop', () => {
  // Down $600 today: past the $500 soft limit.
  assert.match(propSetup({ balance: 49400 })(entryOrder()).violations[0].message, /soft daily limit/);
  // Budget: 0.2 x $2,000 cushion = $400. 40-tick MNQ stop = $20 + $0.74 fees = $20.74 a contract: 19 contracts.
  const ev = propSetup();
  assert.deepStrictEqual(ev(entryOrder({ size: 19 })).violations, []);
  assert.match(ev(entryOrder({ size: 20 })).violations[0].message, /20 MNQ is not within the account's size budget for a 40-tick stop \(19 MNQ at \$20.74/);
  assert.match(ev(entryOrder({ stopLossBracket: undefined, rationale: 'setup:orb long, stop 21480' })).violations[0].message, /needs stopLossBracket.ticks/);
});

test('combine: at the profit target the gate stops entries only once today\'s close would pass (consistency)', () => {
  const consistent = { ...MINI, consistency_pct: 50 };
  // $2,500 yesterday, +$600 today: $3,100 profit, but the best day is over 50% of it. Entries go on.
  const lopsided = propSetup({ account: consistent, days: [['2026-10-06', 52500]], balance: 53100 });
  assert.deepStrictEqual(lopsided(entryOrder()).violations, []);
  // $1,000, $1,000, then +$1,100 today: the close passes, so entries stop.
  const spread = propSetup({ account: consistent, days: [['2026-10-05', 51000], ['2026-10-06', 52000]], balance: 53100 });
  assert.match(spread(entryOrder()).violations[0].message, /at the profit target: no new entries/);
  // $1,000 yesterday, +$2,100 today: today is the best day, so more today can't meet consistency.
  const record = propSetup({ account: consistent, days: [['2026-10-06', 51000]], balance: 53100 });
  assert.match(record(entryOrder()).violations[0].message, /today the best day \(\$2100\).*entries resume next session/);
});

test('combine: a live attempt never times out on its sessions, and a finished one says how to end it', () => {
  // `sessions` (2 here) bounds training attempts, not the firm's: day 3 still trades.
  const short = { ...MINI, sessions: 2 };
  const days = [['2026-10-04', 50100], ['2026-10-05', 50200], ['2026-10-06', 50300]];
  assert.deepStrictEqual(propSetup({ account: short, days, balance: 50300 })(entryOrder()).violations, []);
  // Passed ($3,100 profit, no consistency rule): refused, with the command that ends the attempt.
  const passed = propSetup({ days: [['2026-10-06', 53100]], balance: 53100 });
  assert.match(passed(entryOrder()).violations[0].message, /the challenge is passed.*node scripts\/combine.js stop --account mini/);
});

test('combine: every missed close is flagged, not only the first, so the floor is never left stale', () => {
  const home = tmpDir();
  prop.startAttempt(home, MINI, new Date('2026-10-04T14:00:00Z'));
  prop.snapshot(home, MINI, 50500, new Date('2026-10-05T19:00:00Z')); // Mon, close never recorded
  prop.snapshot(home, MINI, 52500, new Date('2026-10-06T19:00:00Z')); // Tue, close never recorded
  prop.snapshot(home, MINI, 52500, new Date(NOW.getTime() - 60000)); // Wed
  const ev = () => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [propStrategy()], accounts: [MINI] });
  assert.match(ev().violations[0].message, /close of 2026-10-05 was never recorded.*\(also 2026-10-06: record each\)/);
  prop.recordEndOfDay(home, MINI, 50500, '2026-10-05');
  assert.match(ev().violations[0].message, /close of 2026-10-06 was never recorded/, 'recording the first one alone does not clear the block');
  prop.recordEndOfDay(home, MINI, 52500, '2026-10-06');
  prop.snapshot(home, MINI, 52500, new Date(NOW.getTime() - 60000));
  assert.ok(!ev().violations.some(v => /never recorded/.test(v.message)));
  // The floor now trails Tue's $52,500 close: $50,500 (locked at the start: $50,000).
  assert.strictEqual(prop.readAttempt(home, MINI.name).snapshot.state.floor, 50000);
});

test('policy: an entry needs a fresh verdict for this contract and side, at no more than its size', () => {
  const none = propSetup({ policy: true });
  assert.match(none(entryOrder()).violations.find(v => v.check === 'policy').message, /no verdict for MNQ/);
  const ok = propSetup({ policy: true, verdict: {} });
  assert.deepStrictEqual(ok(entryOrder({ size: 3 })).violations, []);
  assert.match(ok(entryOrder({ size: 4 })).violations[0].message, /size 4 is over the verdict's 3 MNQ/);
  assert.match(ok(entryOrder({ stopLossBracket: { ticks: 60, type: 'stop' } })).violations.map(v => v.message).join(), /the stop is 60 ticks; the verdict was sized for 40/);
  assert.match(ok(entryOrder({ side: 'sell' })).violations[0].message, /for a long entry, not sell/);
  assert.match(ok(entryOrder(), { now: new Date(NOW.getTime() + 3 * 60000) }).violations.find(v => v.check === 'policy').message, /expired/);
  assert.match(propSetup({ policy: true, verdict: { action: 'skip', maxSize: 0, reason: 'cushion' } })(entryOrder()).violations[0].message, /the setup was skipped \(cushion\)/);
  // A verdict to trade the mini refuses a micro order, and the other way around.
  assert.match(propSetup({ policy: true, verdict: { contract: 'NQ' } })(entryOrder()).violations[0].message, /the verdict trades NQ, not MNQ/);
  assert.match(propSetup({ policy: true, verdict: { policy: 'other' } })(entryOrder()).violations[0].message, /came from other/);
  assert.match(propSetup({ policy: true, verdict: { contractId: 'CON.F.US.MES.Z26', symbol: 'MES', contract: 'MES' } })(entryOrder()).violations[0].message, /no verdict/);
  // Exits and protective orders are never gated, policy or not.
  assert.deepStrictEqual(none(entryOrder({ rationale: '[exit] policy close' })).violations, []);
});

test('combine: while an attempt runs every entry needs a strategy that trades it; an invalid one still gets the checks', () => {
  const home = tmpDir();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  const other = { name: 'orb', valid: true, errors: [], status: 'active', instruments: ['MNQ'], signal: 'rules', compiledRules: null };
  const run = strategies => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home }, strategies, accounts: [MINI] });
  assert.match(run([other]).violations.find(v => v.check === 'combine').message, /mini attempt is running: only a policy strategy that trades it/);
  assert.deepStrictEqual(evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home: tmpDir() }, strategies: [other], accounts: [MINI] }).violations, [], 'no attempt: nothing changes');
  const invalid = run([propStrategy({ valid: false, errors: ['bad'] })]);
  assert.ok(invalid.violations.some(v => v.check === 'combine'), 'an invalid STRATEGY.md that names an account is still checked');
  prop.endAttempt(home, 'mini');
  assert.deepStrictEqual(run([other]).violations, [], 'an ended attempt no longer gates other strategies');
});

test('combine: a close the runner missed stops entries until it is recorded', () => {
  const home = tmpDir();
  prop.startAttempt(home, MINI, new Date('2026-10-05T14:00:00Z'));
  prop.snapshot(home, MINI, 50300, new Date('2026-10-06T19:00:00Z')); // Tuesday's trading day, never closed
  prop.snapshot(home, MINI, 50300, new Date(NOW.getTime() - 60000)); // Wednesday
  prop.appendVerdict(home, { strategy: 'orb', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', stopTicks: 40, maxSize: 50, policy: null, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const ev = () => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [propStrategy()], accounts: [MINI] });
  assert.match(ev().violations[0].message, /close of 2026-10-06 was never recorded.*record-day --account mini --day 2026-10-06/);
  prop.recordEndOfDay(home, MINI, 50300, '2026-10-06');
  prop.snapshot(home, MINI, 50300, new Date(NOW.getTime() - 30000));
  assert.deepStrictEqual(ev().violations, []);
  assert.throws(() => prop.recordEndOfDay(home, MINI, 50999, '2026-10-06'), /already recorded at \$50300/);
  assert.throws(() => prop.recordEndOfDay(home, MINI, 50999, '2026-10-01'), /before the attempt started/);
  // A close recorded after a later day still goes in order, and the later day's P&L is recomputed.
  prop.recordEndOfDay(home, MINI, 50600, '2026-10-08');
  prop.recordEndOfDay(home, MINI, 50100, '2026-10-07');
  assert.deepStrictEqual(prop.readAttempt(home, 'mini').days, [
    { day: '2026-10-06', balance: 50300, pnl: 300 }, { day: '2026-10-07', balance: 50100, pnl: -200 }, { day: '2026-10-08', balance: 50600, pnl: 500 },
  ]);
});

test('combine: a size never risks the room to the daily limit, whatever the budget or guard', () => {
  // Down $900 of a $1,000 daily limit (soft limit off): $100 of room. Budget 0.2 x $1,100 cushion = $220.
  // A 40-tick stop risks $20.74 a contract: 4 fit in the room ($82.96), not the budget's 10.
  const home = tmpDir();
  prop.startAttempt(home, { ...MINI, daily_loss_soft: 0 }, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, { ...MINI, daily_loss_soft: 0 }, 49100, new Date(NOW.getTime() - 60000));
  const acct = { ...MINI, daily_loss_soft: 0 };
  prop.appendVerdict(home, { strategy: 'orb', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', stopTicks: 40, maxSize: 50, policy: null, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const ev = size => evaluateOrder({ input: entryOrder({ size }), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [propStrategy()], accounts: [acct] });
  assert.deepStrictEqual(ev(4).violations, []);
  assert.match(ev(5).violations[0].message, /5 MNQ is not within the account's size budget for a 40-tick stop \(4 MNQ/);
});

test('combine: minis and micros, by the policy strategy\'s contract mode', () => {
  // $50,000 on the mini account: budget 0.2 x $2,000 = $400. A 40-tick stop risks $20.74 a micro
  // (19 fit) or $202.80 a mini (NQ: $200 + $2.80 fees). auto trades minis once the size reaches 10 micros: 1 NQ.
  const acct = { ...MINI, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } };
  const NQ = 'CON.F.US.ENQ.Z26';
  const run = (contracts, input, verdict) => {
    const home = tmpDir();
    prop.startAttempt(home, acct, new Date(NOW.getTime() - 86400000));
    prop.snapshot(home, acct, 50000, new Date(NOW.getTime() - 60000));
    prop.appendVerdict(home, { strategy: 'orb', contractId: CONTRACT, direction: 'long', action: 'full', stopTicks: 40, policy: null, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString(), ...verdict });
    return evaluateOrder({ input, entries: [plan(5, { contractId: input.contractId })], now: NOW, config: { ...config, home }, strategies: [propStrategy({ contracts })], accounts: [acct] }).violations;
  };
  assert.deepStrictEqual(run('auto', entryOrder({ contractId: NQ, size: 1 }), { contract: 'NQ', maxSize: 1 }), []);
  assert.match(run('auto', entryOrder({ size: 19 }), { contract: 'MNQ', maxSize: 19 }).map(v => v.message).join(), /19 MNQ is not within .*\(1 NQ at \$202.80/);
  assert.deepStrictEqual(run('micro', entryOrder({ size: 19 }), { contract: 'MNQ', maxSize: 19 }), []);
  assert.match(run('micro', entryOrder({ contractId: NQ, size: 1 }), { contract: 'NQ', maxSize: 1 }).map(v => v.message).join(), /1 NQ is not within .*\(19 MNQ/);
  assert.deepStrictEqual(run('mini', entryOrder({ contractId: NQ, size: 1 }), { contract: 'NQ', maxSize: 1 }), []);
  assert.match(run('auto', entryOrder({ contractId: NQ, size: 2 }), { contract: 'NQ', maxSize: 1 }).map(v => v.message).join(), /2 NQ is not within/);
});

test('combine: an untagged entry is refused while an attempt runs, even with the setup-tag check skipped', () => {
  const home = tmpDir();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  const r = evaluateOrder({ input: entryOrder({ rationale: 'going long, stop 21480' }), entries: [plan()], now: NOW, config: { ...config, home, skipChecks: new Set(['setup-tag', 'strategy']) }, strategies: [propStrategy()], accounts: [MINI] });
  assert.deepStrictEqual(checks(r), ['combine']);
});

test('policy: a half verdict is checked at half size, even when full size is minis and half is micros', () => {
  // $600 budget (0.2 x $3,000 cushion on a $3,000 max loss), auto. 60-tick stop:
  // a micro risks $30 + $0.74 = $30.74 (19 fit: 1 NQ at $302.80); half: 9 micros, under one mini.
  const acct = { ...MINI, max_loss: 3000, daily_loss_soft: 0, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } };
  const home = tmpDir();
  prop.startAttempt(home, acct, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, acct, 50000, new Date(NOW.getTime() - 60000));
  prop.appendVerdict(home, { strategy: 'orb', contractId: CONTRACT, direction: 'long', action: 'half', contract: 'MNQ', maxSize: 9, stopTicks: 60, policy: 'p1', at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const run = size => evaluateOrder({ input: entryOrder({ size, stopLossBracket: { ticks: 60, type: 'stop' } }), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [propStrategy({ contracts: 'auto', policy: { bundle: 'p1' } })], accounts: [acct] }).violations;
  assert.deepStrictEqual(run(9), []);
  assert.match(run(10).map(v => v.message).join(), /10 MNQ is not within the account's half-size size budget/);
});

test('policy: a verdict permits one entry; a re-entry waits for the next setup\'s verdict', () => {
  const ev = propSetup({ policy: true, verdict: { at: new Date(NOW.getTime() - 120000).toISOString() } });
  assert.deepStrictEqual(ev(entryOrder()).violations, []);
  const home = tmpDir();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 60000));
  prop.appendVerdict(home, { strategy: 'orb', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', stopTicks: 40, maxSize: 3, policy: 'p1', at: new Date(NOW.getTime() - 120000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const run = entries => evaluateOrder({ input: entryOrder(), entries: [plan(), ...entries], now: NOW, config: { ...config, home, skipChecks: new Set(['review-before-next-entry']) }, strategies: [propStrategy({ policy: { bundle: 'p1' } })], accounts: [MINI] }).violations;
  assert.match(run([placed(1, 'setup:orb long, stop 40 ticks')]).map(v => v.message).join(), /already used for an entry/);
  assert.deepStrictEqual(run([placed(5, 'setup:orb long, stop 40 ticks')]), [], 'an entry before this verdict doesn\'t use it');
  assert.deepStrictEqual(run([placed(1, 'setup:orb long', false)]), [], 'a rejected order doesn\'t use it');
});

test('policy: only this strategy\'s entries on this index use its verdict', () => {
  const home = tmpDir();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 60000));
  prop.appendVerdict(home, { strategy: 'orb', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', stopTicks: 40, maxSize: 3, policy: null, at: new Date(NOW.getTime() - 120000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const run = entries => evaluateOrder({ input: entryOrder(), entries: [plan(), ...entries], now: NOW, config: { ...config, home, skipChecks: new Set(['review-before-next-entry']) }, strategies: [propStrategy()], accounts: [MINI] }).violations;
  assert.deepStrictEqual(run([placed(1, 'setup:orb-x long')]), [], 'another strategy\'s tag');
  assert.deepStrictEqual(run([{ ...placed(1, 'setup:orb long'), contractId: 'CON.F.US.MES.Z26' }]), [], 'another index');
  assert.match(run([{ ...placed(1, 'setup:orb long'), contractId: 'CON.F.US.ENQ.Z26' }]).map(v => v.message).join(), /already used/, 'the mini of the same index');
});
