'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateOrder, isRiskReducing, formatBlock } = require('../../scripts/lib/trading/order-gate');
const { loadConfig } = require('../../scripts/lib/trading/config');
const { FAKE_BROKERS, shippedBroker, NOW, CONTRACT, minutesAgo, plan, placed, review, entryOrder, trendHome, recordBrokerSpecs, FX_GOLDEN, TEST_SIZING, testSizing } = require('../helpers');

// Every home has an up-trend record (the trend rule's read); the age limit is off so tests at any clock see it.
// Role skills full (FTH_ROLE_SKILLS=full, as the runner sets for every harness but opencode): index mode's lookup rule,
// the default, has its own tests (the "Index mode" section below, under the default with no FTH_ROLE_SKILLS set).
const config = { ...loadConfig({ FTH_ROLE_SKILLS: 'full' }), killSwitchFile: '/nonexistent/fth/STOP', home: trendHome(), mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
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

test('stop-defined: every entry carries its stop as stopLossBracket; a stop stated only in the rationale is refused', () => {
  const stopInText = 'setup:bos long, stop at 21480.25, target 21540';
  const r = evaluate(entryOrder({ stopLossBracket: undefined, rationale: stopInText }), [plan()]);
  assert.deepStrictEqual(checks(r), ['stop-defined']);
  // Broker-neutral: the stop goes as the bracket, a broker that can't attach it refuses, never re-sent without it.
  assert.match(r.violations[0].message, /every entry carries its stop as stopLossBracket/);
  assert.match(r.violations[0].message, /a stop stated only in the rationale is not one/i);
  assert.match(r.violations[0].message, /refuses the entry: never send it again without one, and report the broker's message to the user/);
  assert.doesNotMatch(r.violations[0].message, /\[protect\]|OCO/i);
  // Ticks must be a whole number above 0: zero, negative, a fraction, not a number, or missing are no bracket.
  for (const bad of [{ ticks: 0 }, { ticks: -40 }, { ticks: 2.5 }, { ticks: '2.5' }, { ticks: '' }, { ticks: 'forty' }, { ticks: null }, { ticks: true },
    { ticks: [40] }, { ticks: NaN }, { ticks: Infinity }, { type: 'stop' }, null, 40, 'stop 40']) {
    const v = evaluate(entryOrder({ stopLossBracket: bad, rationale: stopInText }), [plan()]).violations;
    assert.ok(v.some(x => x.check === 'stop-defined'), JSON.stringify(bad));
  }
  // The bracket is a stop leg with numeric ticks: a limit or market leg, no type, or ticks as a string are no stop bracket.
  for (const bad of [{ ticks: 40, type: 'limit' }, { ticks: 40, type: 'market' }, { ticks: 40 }, { ticks: 40, type: '' }, { ticks: 40, type: 4 }, { ticks: '40', type: 'stop' }, { ticks: 40, type: 'Stop' }, { ticks: 40, type: 'STOP' }, { ticks: 40, type: 'Trailing_Stop' }]) {
    const v = evaluate(entryOrder({ stopLossBracket: bad }), [plan()]).violations;
    assert.ok(v.some(x => x.check === 'stop-defined'), JSON.stringify(bad));
  }
  // A whole number of ticks above 0 with a stop type is the bracket.
  assert.deepStrictEqual(evaluate(entryOrder({ stopLossBracket: { ticks: 1, type: 'stop' } }), [plan()]).violations, []);
  assert.deepStrictEqual(evaluate(entryOrder({ stopLossBracket: { ticks: 40, type: 'trailing_stop' } }), [plan()]).violations, []);
  // [exit] and [protect] orders carry no bracket and are never refused by it.
  for (const rationale of ['[exit] flatten', '[protect] stop for the filled long', ' [PROTECT] stop after the partial exit']) {
    assert.deepStrictEqual(evaluate(entryOrder({ side: 'sell', type: 'stop', stopPrice: 21480, stopLossBracket: undefined, rationale }), []).violations, [], rationale);
  }
});

test('stale, other-symbol, and previous-day plans do not count', () => {
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan(121)])), ['plan-required']);
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan(5, { contractId: 'MES' })])), ['plan-required']);
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
  // The message says where the tag goes, not just that it's needed.
  assert.match(evaluate(entryOrder({ rationale: 'long setup:orb, stop 21480' }), [plan()]).violations[0].message, /must start with the strategy as setup:<name>.*the tag goes first/);
  assert.deepStrictEqual(checks(evaluate(entryOrder({ stopLossBracket: undefined, rationale: 'setup:orb never stop out, 2x size' }), [plan()])), ['stop-defined']);
  assert.deepStrictEqual(evaluate(entryOrder({ rationale: '  setup:orb long, stop: 21480' }), [plan()]).violations, []);
});

test('reviews without a result tag or for another contract do not clear the review gate', () => {
  const untagged = { ts: minutesAgo(10), kind: 'review', text: 'done', tags: ['setup:orb'] };
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [placed(30), untagged, plan(5)])), ['review-before-next-entry']);
  const otherContract = { ...review(10, 'win'), contractId: 'MES' };
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [placed(30), otherContract, plan(5)])), ['review-before-next-entry']);
});

test('an entry under a broker id the translator can\'t name counts on every contract (fails closed)', () => {
  // The server writes order_placed under its own id; with no translator lookups to name it, it still needs its review.
  const raw = { ...placed(30), contractId: 'fake:ENQ:Z25' };
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [raw, plan(5)])), ['review-before-next-entry']);
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [{ ...raw, contractId: '4471923' }, plan(5)])), ['review-before-next-entry'], 'an all-digit id is a broker id too');
  // A standard name on another contract does not count.
  assert.deepStrictEqual(evaluate(entryOrder(), [{ ...placed(30), contractId: 'MES' }, plan(5)]).violations, []);
  // Reviewed under the id journal_read shows: cleared, on any contract.
  const rev = { ...review(10, 'win'), contractId: 'fake:ENQ:Z25' };
  assert.deepStrictEqual(evaluate(entryOrder(), [raw, rev, plan(5)]).violations, []);
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

test('the bar briefing\'s session window says what the gate does: no entries exactly when the gate\'s clock refuses one', () => {
  const { sessionWindow } = require('../../scripts/lib/trading/briefing');
  const envs = [{}, { FTH_ENTRY_HOURS: 'ny' }, { FTH_NO_ENTRY_WINDOWS: '09:30-09:45@America/New_York,12:15-12:30@America/New_York' }, { FTH_NO_ENTRY_WINDOWS: '' }, { FTH_ENTRY_HOURS: 'whenever' }];
  for (const env of envs) {
    const cfg = { ...config, entryHours: loadConfig(env).entryHours, noEntryWindows: loadConfig(env).noEntryWindows };
    // A Wednesday trading day, from Tuesday's 18:00 ET open to the next one, every 11 minutes.
    for (let t = Date.parse('2026-10-06T22:00:00Z'); t < Date.parse('2026-10-07T22:00:00Z'); t += 11 * 60000) {
      const now = new Date(t);
      const refused = checks(evaluate(entryOrder(), [plan(1, { ts: new Date(t - 60000).toISOString() })], { now, config: cfg })).some(c => c === 'time-window' || c === 'market-hours');
      const w = sessionWindow(now, { entryHours: cfg.entryHours, noEntryWindows: cfg.noEntryWindows });
      assert.strictEqual(w.entries === 'none', refused, `${JSON.stringify(env)} at ${now.toISOString()}: briefing ${w.text}`);
    }
  }
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
  const skipping = { ...loadConfig({ FTH_ORDER_GATE_SKIP: 'plan-required, setup-tag' }), home: config.home };
  const r = evaluate(entryOrder({ rationale: 'long, stop 21480 because reasons' }), [], { config: skipping });
  assert.deepStrictEqual(r.violations, []);
});

test('retired-lane is a hard rule: FTH_ORDER_GATE_SKIP=retired-lane does not skip it', () => {
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  const { buildSignals, writeSignals } = require('../../scripts/lib/trading/signal-state');
  // fx_orb: the fixture holding the retired orb rules (3m), a known strategy whose lane can be marked.
  const strategies = loadStrategies(require('path').resolve(__dirname, '..', '..'), { FTH_STRATEGIES_DIRS: FX_GOLDEN }).strategies;
  const home = trendHome();
  for (const retired of [['bos'], ['orb']]) {
    writeSignals(home, buildSignals([], { symbol: 'MNQ', bar: { t: '2026-10-07T13:57:00.000Z' }, stepMs: 180000, now: NOW, retiredLane: retired }));
    const skipping = { ...loadConfig({ FTH_ORDER_GATE_SKIP: 'retired-lane,strategy' }), killSwitchFile: '/nonexistent/fth/STOP', home, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
    assert.ok(skipping.skipChecks.has('retired-lane'), 'the skip is asked for');
    const r = evaluateOrder({ input: entryOrder({ rationale: 'setup:fx_orb long, stop 21480' }), entries: [plan()], now: NOW, config: skipping, strategies });
    assert.ok(r.violations.some(v => v.check === 'retired-lane'), `${retired}: ${JSON.stringify(r.violations)}`);
  }
});

test('retired-lane: an entry naming no known strategy is checked against every lane of its contract, even with the strategy check skipped', () => {
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  const { buildSignals, writeSignals } = require('../../scripts/lib/trading/signal-state');
  const strategies = loadStrategies(require('path').resolve(__dirname, '..', '..'), { FTH_STRATEGIES_DIRS: FX_GOLDEN }).strategies;
  const home = trendHome();
  const skipping = { ...loadConfig({ FTH_ORDER_GATE_SKIP: 'retired-lane,strategy,setup-tag' }), killSwitchFile: '/nonexistent/fth/STOP', home, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
  const order = rationale => evaluateOrder({ input: entryOrder({ rationale }), entries: [plan()], now: NOW, config: skipping, strategies });
  const tags = ['setup:nosuch long, stop 21480', 'setup:orb long, stop 21480', 'long, stop 21480 (no tag)'];
  // No lane marked: nothing to refuse here (the skipped checks stay skipped).
  for (const t of tags) assert.ok(!order(t).violations.some(v => v.check === 'retired-lane'), t);
  // Another contract's lane marked: not this one's.
  writeSignals(home, buildSignals([], { symbol: 'MES', bar: { t: '2026-10-07T13:57:00.000Z' }, stepMs: 180000, now: NOW, retiredLane: ['bos'] }));
  for (const t of tags) assert.ok(!order(t).violations.some(v => v.check === 'retired-lane'), t);
  // This contract's 1m lane marked (no strategy here trades 1m): every entry with no known strategy is refused.
  writeSignals(home, buildSignals([], { symbol: 'MNQ', bar: { t: '2026-10-07T13:59:00.000Z' }, stepMs: 60000, now: NOW, retiredLane: ['bos'] }));
  for (const t of tags) {
    const v = order(t).violations.find(x => x.check === 'retired-lane');
    assert.ok(v, t);
    assert.match(v.message, /names no known strategy, so no timeframe of its own, and the runner's 1m lane lists bos \(retired on 2026-10-13/);
  }
  // A known strategy on another timeframe (fx_orb, 3m) is checked on its own lane only, as before.
  assert.ok(!order('setup:fx_orb long, stop 21480').violations.some(v => v.check === 'retired-lane'));
  // An exit is never held.
  const exit = evaluateOrder({ input: entryOrder({ side: 'sell', rationale: '[exit] close the long', stopLossBracket: undefined }), entries: [], now: NOW, config: skipping, strategies });
  assert.deepStrictEqual([exit.intent, exit.violations], ['risk-reducing', []]);
});

test('retired-lane fails closed: an unreadable lane record refuses an entry, named or not, even with the checks skipped; exits go', () => {
  const fs = require('fs');
  const { buildSignals, writeSignals, signalFile } = require('../../scripts/lib/trading/signal-state');
  const strategies = [{ name: 'orb', valid: true, errors: [], status: 'active', instruments: ['MNQ'], signal: 'manual', mtf: 'trend', timeframe: '3m' }];
  const skipping = home => ({ ...loadConfig({ FTH_ORDER_GATE_SKIP: 'retired-lane,strategy,setup-tag' }), killSwitchFile: '/nonexistent/fth/STOP', home, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 });
  const order = (home, input) => evaluateOrder({ input, entries: [plan()], now: NOW, config: skipping(home), strategies });
  const lane = (home, rationale) => order(home, entryOrder({ rationale })).violations.find(v => v.check === 'retired-lane');
  const tags = ['setup:orb long, stop 21480', 'setup:nosuch long, stop 21480', 'long, stop 21480 (no tag)'];
  const home = trendHome();
  // A readable record with no mark refuses nothing (so the refusals below come from the unreadable record).
  writeSignals(home, buildSignals([], { symbol: 'MNQ', bar: { t: '2026-10-07T13:57:00.000Z' }, stepMs: 180000, now: NOW }));
  for (const t of tags) assert.strictEqual(lane(home, t), undefined, t);
  const corrupts = ['{ half a file', 'null', '[]', '"MNQ"', JSON.stringify({ symbol: 'MNQ', timeframe: '3m', candidates: [], retiredLane: 'bos' })];
  for (const corrupt of corrupts) {
    fs.writeFileSync(signalFile(home, 'MNQ', '3m'), corrupt);
    const named = lane(home, tags[0]);
    assert.ok(named, `named: ${corrupt}`);
    assert.match(named.message, /^setup:orb trades 3m bars, and the runner's 3m lane record for MNQ is unreadable \(.+\): it may say that lane lists a retired strategy, so no entry on it/);
    for (const t of tags.slice(1)) {
      const v = lane(home, t);
      assert.ok(v, `${t}: ${corrupt}`);
      assert.match(v.message, /names no known strategy, so no timeframe of its own, and the runner's 3m lane record for MNQ is unreadable/);
    }
    // Exits and protective stops are never held by it.
    for (const r of ['[exit] close the long', '[protect] move the stop']) {
      const x = order(home, entryOrder({ side: 'sell', rationale: r, stopLossBracket: undefined }));
      assert.deepStrictEqual([x.intent, x.violations], ['risk-reducing', []], `${r}: ${corrupt}`);
    }
  }
  // A directory where the record should be: unreadable too.
  fs.rmSync(signalFile(home, 'MNQ', '3m'));
  fs.mkdirSync(signalFile(home, 'MNQ', '3m'));
  for (const t of tags) assert.match(lane(home, t).message, /3m lane record for MNQ is unreadable/, t);
  // Another contract's unreadable record isn't this one's.
  const other = trendHome();
  fs.mkdirSync(require('path').dirname(signalFile(other, 'MES', '3m')), { recursive: true });
  fs.writeFileSync(signalFile(other, 'MES', '3m'), '{ half a file');
  for (const t of tags) assert.strictEqual(lane(other, t), undefined, t);
});

test('retired-lane: a 1h strategy is checked on the runner\'s 60m lane record (the runner names its lanes in minutes)', () => {
  const { buildSignals, writeSignals } = require('../../scripts/lib/trading/signal-state');
  const hourly = { name: 'orb', valid: true, errors: [], status: 'active', instruments: ['MNQ'], signal: 'manual', mtf: 'trend', timeframe: '1h' };
  const home = trendHome();
  const lane = () => evaluateOrder({ input: entryOrder({ rationale: 'setup:orb long, stop 21480' }), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [hourly] })
    .violations.find(v => v.check === 'retired-lane');
  assert.strictEqual(lane(), undefined, 'no 60m record: nothing to refuse');
  writeSignals(home, buildSignals([], { symbol: 'MNQ', bar: { t: '2026-10-07T13:00:00.000Z' }, stepMs: 3600000, now: NOW, retiredLane: ['bos'] }));
  const v = lane();
  assert.ok(v, 'the 60m lane is marked');
  assert.match(v.message, /^setup:orb trades 1h bars, and the runner's 60m lane lists bos \(retired on 2026-10-13/);
});

test('strategy check: an entry tagged with a retired strategy is refused, saying it was retired; an exit for its position goes', () => {
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  const strategies = loadStrategies(require('path').resolve(__dirname, '..', '..'), {}).strategies;
  const retired = [...['bos', 'keltner', 'ema_cross', 'supertrend'].map(n => [n, '2026-10-13']),
    ...['cisd_ote', 'crt_1h', 'crt_4h', 'ofi', 'ofi_absorption', 'orb', 'prop_flow_1m', 'value_area', 'value_area_breakout', 'value_area_reentry', 'vwap_reclaim'].map(n => [n, '2026-10-14'])];
  for (const [name, date] of retired) {
    const r = evaluateOrder({ input: entryOrder({ rationale: `setup:${name} long, stop 21480` }), entries: [plan(1)], now: NOW, config, strategies });
    const v = r.violations.find(x => x.check === 'strategy');
    assert.ok(v, name);
    assert.match(v.message, new RegExp(`setup:${name} is not a known strategy \\(retired on ${date}: strategies/README\\.md, "Retired strategies"\\): no new entries from it`));
    const exit = evaluateOrder({ input: entryOrder({ side: 'sell', rationale: `[exit] close the ${name} long`, stopLossBracket: undefined }), entries: [], now: NOW, config, strategies });
    assert.deepStrictEqual([exit.intent, exit.violations], ['risk-reducing', []]);
  }
});

test('strategy check: the trade lifecycle (signal: composed) enters only on its compose record ([composed-reads], lifecycle-gate.js); its exit goes', () => {
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  const strategies = loadStrategies(require('path').resolve(__dirname, '..', '..'), {}).strategies;
  assert.strictEqual(strategies.find(s => s.name === 'trade_lifecycle').status, 'active');
  for (const side of ['buy', 'sell']) {
    const r = evaluateOrder({ input: entryOrder({ side, rationale: `setup:trade_lifecycle ${side === 'buy' ? 'long' : 'short'}, stop 21480` }), entries: [plan(1)], now: NOW, config, strategies });
    const v = r.violations.find(x => x.check === 'composed-reads');
    assert.ok(v && !r.violations.some(x => x.check === 'strategy'), JSON.stringify(r.violations));
    assert.match(v.message, /^setup:trade_lifecycle: no cycle bar for MNQ/);
  }
  const exit = evaluateOrder({ input: entryOrder({ side: 'sell', rationale: '[exit] close the trade_lifecycle long', stopLossBracket: undefined }), entries: [], now: NOW, config, strategies });
  assert.deepStrictEqual([exit.intent, exit.violations], ['risk-reducing', []]);
});

test('strategy check: known, active, instrument, and session', () => {
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  // fx_orb: the fixture holding the retired orb rules (sessions [ny]); give it a narrower session here. Its trigger fired
  // long on the trend home's last 3m bar.
  const strategies = loadStrategies(require('path').resolve(__dirname, '..', '..'), { FTH_STRATEGIES_DIRS: FX_GOLDEN }).strategies
    .map(s => (s.name === 'fx_orb' ? { ...s, sessions: ['09:45-11:30@America/New_York'] } : s));
  const fxConfig = { ...config, home: trendHome(undefined, { fired: [{ name: 'fx_orb', direction: 'long' }] }) };
  const fxOrder = (extra = {}) => entryOrder({ rationale: 'setup:fx_orb break above OR high 21500, stop 21480, target 21540, risk $40', ...extra });
  const at = iso => evaluate(entryOrder(), [plan(1, { ts: new Date(Date.parse(iso) - 60000).toISOString() })], { now: new Date(iso) });
  const withReg = (input, iso) => evaluateOrder({ input, entries: [plan(1, { ts: new Date(Date.parse(iso) - 60000).toISOString() })], now: new Date(iso), config: fxConfig, strategies });
  // 10:00 ET Wednesday: inside fx_orb's 09:45-11:30 session
  assert.deepStrictEqual(withReg(fxOrder(), '2026-10-07T14:00:00Z').violations, []);
  assert.deepStrictEqual(at('2026-10-07T14:00:00Z').violations, []);
  // 12:00 ET: outside the session
  assert.deepStrictEqual(checks(withReg(fxOrder(), '2026-10-07T16:00:00Z')), ['strategy']);
  // unknown strategy and instrument not traded
  assert.match(withReg(fxOrder({ rationale: 'setup:mystery long stop 1' }), '2026-10-07T14:00:00Z').violations[0].message, /not a known strategy/);
  assert.match(withReg(fxOrder({ contractId: 'MCL' }), '2026-10-07T14:00:00Z').violations.map(v => v.message).join(), /does not trade MCL/);
  // paper strategies cannot place live entries
  const paper = strategies.map(s => (s.name === 'fx_orb' ? { ...s, status: 'paper' } : s));
  const r = evaluateOrder({ input: fxOrder(), entries: [plan(1)], now: NOW, config: fxConfig, strategies: paper });
  assert.match(r.violations[0].message, /status "paper"/);
});

test('strategy check: a rules strategy trades the selected leg (FTH_SYMBOLS) of a family it lists, never the other; every other check still runs on that contract', () => {
  // A rules strategy tagged setup:orb (fired long in trendHome's MNQ record), listing MNQ only, capped at $100.
  const micro = { name: 'orb', valid: true, errors: [], status: 'active', signal: 'rules', instruments: ['MNQ'], sessions: [], timeframe: '3m', mtf: 'trend',
    compiledRules: { long: [{}], short: [{}] }, risk: { stop: 'atr:1', min_rr: 2, max_risk_usd: 100 } };
  const withSel = (value, extra = {}) => ({ ...config, ...extra, selection: loadConfig({ FTH_SYMBOLS: value }).selection });
  const run = (input, c) => evaluateOrder({ input, entries: [plan(10, { contractId: input.contractId })], now: NOW, config: c, strategies: [micro] });
  const nq = withSel('NQ');
  const mnq = withSel('MNQ');
  const at20 = { stopLossBracket: { ticks: 20, type: 'stop' } };
  // NQ selected: NQ passes (the family's trigger and trend records count); 20 ticks x $5 = $100, at the cap. MNQ is refused.
  assert.deepStrictEqual(run(entryOrder({ contractId: 'NQ', ...at20 }), nq).violations, []);
  assert.deepStrictEqual(run(entryOrder({ contractId: 'MNQ', size: 5 }), nq).violations, [{ check: 'strategy', message: 'setup:orb trades NQ (the selected contract), not MNQ.' }]);
  // MNQ selected: MNQ passes, NQ is refused.
  assert.deepStrictEqual(run(entryOrder({ contractId: 'MNQ', size: 5 }), mnq).violations, []);
  assert.deepStrictEqual(run(entryOrder({ contractId: 'NQ', ...at20 }), mnq).violations, [{ check: 'strategy', message: 'setup:orb trades MNQ (the selected contract), not NQ.' }]);
  // Unknown selection: its list only (MNQ), NQ refused with how to select it (fails closed).
  assert.deepStrictEqual(run(entryOrder({ contractId: 'MNQ', size: 5 }), config).violations, []);
  assert.match(run(entryOrder({ contractId: 'NQ', ...at20 }), config).violations.find(v => v.check === 'strategy').message, /^setup:orb does not trade NQ \(instruments: MNQ\); .*FTH_SYMBOLS=NQ\)\.$/);
  // Unknown selection and both legs listed: neither leg, until one is selected.
  const both = { ...micro, instruments: ['MNQ', 'NQ'] };
  const runBoth = (input, c) => evaluateOrder({ input, entries: [plan(10, { contractId: input.contractId })], now: NOW, config: c, strategies: [both] });
  assert.match(runBoth(entryOrder({ contractId: 'MNQ' }), config).violations.find(v => v.check === 'strategy').message, /^setup:orb lists both MNQ and NQ, and neither is selected/);
  assert.deepStrictEqual(runBoth(entryOrder({ contractId: 'MNQ' }), mnq).violations, []);
  assert.deepStrictEqual(runBoth(entryOrder({ contractId: 'NQ', stopLossBracket: { ticks: 20, type: 'stop' } }), mnq).violations, [{ check: 'strategy', message: 'setup:orb trades MNQ (the selected contract), not NQ.' }]);
  // An unreadable selection refuses every entry; so does a lost one (unset in an autonomous run).
  assert.match(run(entryOrder({ contractId: 'MNQ' }), withSel('MNQ,NQ')).violations.find(v => v.check === 'strategy').message, /FTH_SYMBOLS selects two contracts of one index/);
  const lost = { ...loadConfig({ FTH_AUTONOMOUS: '1' }), home: config.home, killSwitchFile: config.killSwitchFile, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9 };
  assert.match(run(entryOrder({ contractId: 'MNQ' }), lost).violations.find(v => v.check === 'strategy').message, /^FTH_SYMBOLS is not set in this autonomous run, .*--target <harness> \(e\.g\. codex\)\. No entries until it is fixed\.$/);
  assert.deepStrictEqual(run(entryOrder({ contractId: 'MNQ' }), { ...lost, selection: loadConfig({ FTH_AUTONOMOUS: '1', FTH_SYMBOLS: 'MNQ' }).selection }).violations, []);
  // max_risk_usd in NQ's dollars: 40 ticks x $5 = $200, over $100 (one MNQ at 40 ticks would be $20).
  const over = run(entryOrder({ contractId: 'NQ' }), nq);
  assert.deepStrictEqual(checks(over), ['max-risk']);
  assert.match(over.violations[0].message, /^risk \$200\.00 \(size 1 x 40-tick stop x \$5\.00 a tick on NQ\)/);
  // NQ's own broker specs: MNQ's recorded doesn't do.
  const home = trendHome(undefined, { specs: false });
  recordBrokerSpecs(home, { roots: ['MNQ'] });
  const nospec = run(entryOrder({ contractId: 'NQ', ...at20 }), withSel('NQ', { home }));
  assert.ok(checks(nospec).includes('contract-specs'), JSON.stringify(nospec.violations));
  assert.match(nospec.violations.find(v => v.check === 'contract-specs').message, /NQ/);
  // A contract outside every family it lists: refused, selected or not.
  for (const c of ['ES', 'MES', 'RTY', 'GC', 'CL']) {
    const r = run(entryOrder({ contractId: c, stopLossBracket: { ticks: 4, type: 'stop' } }), withSel(c));
    assert.match(r.violations.find(v => v.check === 'strategy').message, new RegExp(`^setup:orb does not trade ${c} \\(instruments: MNQ\\)`), c);
  }
  // Exits and protective stops on either leg are never refused, whatever is selected.
  for (const c of ['MNQ', 'NQ']) {
    for (const sel of [nq, mnq, config, withSel('MNQ,NQ')]) {
      for (const input of [entryOrder({ contractId: c, side: 'sell', size: 3, rationale: '[exit] flatten' }), entryOrder({ contractId: c, side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long' })]) {
        const r = run(input, sel);
        assert.strictEqual(r.intent, 'risk-reducing');
        assert.deepStrictEqual(r.violations, [], `${c} ${input.rationale}`);
      }
    }
  }
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

test('exchange calendar: the built-in CME calendar applies with nothing configured, and configuration only adds days', () => {
  const cal = loadConfig({ FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '' });
  const at = (iso, config = cal) => checks(evaluate(entryOrder(), [plan(1, { ts: new Date(Date.parse(iso) - 60000).toISOString() })], { now: new Date(iso), config }));
  assert.ok(at('2026-04-03T14:00:00Z').includes('market-hours'), 'Good Friday 10:00 ET: closed');
  assert.ok(at('2026-12-25T15:00:00Z').includes('market-hours'), 'Christmas Day');
  assert.ok(at('2026-11-27T18:10:00Z').includes('market-hours'), 'day after Thanksgiving, 13:10 ET: after the early close');
  assert.ok(!at('2026-11-27T17:30:00Z').includes('market-hours'), 'day after Thanksgiving, 12:30 ET: still open');
  assert.ok(!at('2026-10-07T14:30:00Z').includes('market-hours'), 'an ordinary Wednesday');
  // A configured date adds to the calendar; it can't take a built-in holiday away.
  const added = loadConfig({ FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_CLOSED_DATES: '2026-10-07' });
  assert.ok(at('2026-10-07T14:30:00Z', added).includes('market-hours'));
  assert.ok(added.closedDates.has('2026-04-03'));
  // Every exchange holiday is closed, even where CME runs a short session.
  assert.ok(at('2026-01-19T15:00:00Z').includes('market-hours'), 'MLK Day 10:00 ET: closed');
  assert.ok(at('2026-07-03T15:00:00Z').includes('market-hours'), 'Independence Day (observed): closed');
  // Past the calendar's end the holidays are unknown: no entries until it is extended.
  const past = checks(evaluate(entryOrder(), [plan(1, { ts: '2028-01-05T14:59:00Z' })], { now: new Date('2028-01-05T15:00:00Z'), config: cal }));
  assert.ok(past.includes('market-hours'));
  // One stray date doesn't extend it; a whole year's holidays and early closes do.
  assert.ok(at('2028-01-05T15:00:00Z', loadConfig({ FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_CLOSED_DATES: '2028-12-25' })).includes('market-hours'));
  const y2028 = require('../../scripts/lib/trading/exchange-calendar').cmeHolidays(2028);
  const extended = loadConfig({ FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_CLOSED_DATES: y2028.closed.join(','), FTH_EARLY_CLOSE_DATES: y2028.early.join(',') });
  assert.ok(!at('2028-01-05T15:00:00Z', extended).includes('market-hours'));
  assert.ok(at('2028-01-17T15:00:00Z', extended).includes('market-hours'), 'MLK Day 2028, from the configured year');
  assert.ok(at('2028-11-24T18:10:00Z', extended).includes('market-hours'), 'the day after Thanksgiving 2028, 13:10 ET: after the early close');
});

// --- Prop challenge: the hard `combine` and `policy` checks (trading/prop-state.js). ---
const prop = require('../../scripts/lib/trading/prop-state');
const { tmpDir } = require('../helpers');

// The bar the helpers' signal record (trendHome) was recorded on: the bar a policy verdict must be for.
const BAR = '2026-10-07T13:57:00Z';
const MINI = {
  name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod',
  daily_loss_limit: 1000, daily_loss_soft: 500, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50 }, fees_per_side: { MNQ: 0.37 },
};
// A policy strategy tagged setup:orb (the helpers' order) trading micros on the mini account.
const propStrategy = (extra = {}) => ({
  name: 'orb', valid: true, errors: [], status: 'active', instruments: ['MNQ', 'NQ'], signal: 'policy', compiledRules: null,
  strategies: ['ema_cross'], account: 'mini', contracts: 'micro', timeframe: '3m', sizing: TEST_SIZING, ...extra,
});
// Its strategy, active: the setup a verdict names (the gate refuses a component that isn't active).
const EMA_CROSS = { name: 'ema_cross', valid: true, errors: [], status: 'active', signal: 'rules', instruments: ['MNQ', 'NQ'], timeframe: '3m', mtf: 'trend' };
function propSetup({ balance = 50000, policy = false, verdict = policy ? null : {}, account = MINI, days = [], registry = null } = {}) {
  const home = trendHome();
  prop.startAttempt(home, account, new Date(NOW.getTime() - (days.length + 1) * 86400000));
  for (const [day, close] of days) prop.recordEndOfDay(home, account, close, day);
  if (balance !== null) prop.snapshot(home, account, balance, new Date(NOW.getTime() - 60000));
  // The verdict the runner records at the setup (prop/verdict.js).
  if (verdict) {
    prop.appendVerdict(home, {
      strategy: 'orb', component: 'ema_cross', contractId: CONTRACT, symbol: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40,
      maxSize: policy ? 3 : 50, bar: BAR, at: '2026-10-07T13:59:30Z', expiresAt: new Date(NOW.getTime() + 120000).toISOString(), ...verdict,
    });
  }
  const strategies = registry || [propStrategy(), EMA_CROSS];
  return (input, opts = {}) => evaluateOrder({ input, entries: [plan()], now: opts.now || NOW, config: { ...config, home, skipChecks: new Set(['combine', 'policy', 'strategy']) }, strategies, accounts: opts.accounts || [account] });
}

test('combine: a strategy that trades an account needs a started attempt and a fresh snapshot (hard, unskippable)', () => {
  const none = evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home: trendHome() }, strategies: [propStrategy(), EMA_CROSS], accounts: [MINI] });
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
  // Budget: 0.2 x $2,000 cushion = $400. A 40-tick MNQ stop plus 1 tick of expected slippage: 41 x $0.50 = $20.50
  // + $0.74 fees = $21.24 a contract: 18 contracts ($382.32; 19 would be $403.56).
  const ev = propSetup();
  assert.deepStrictEqual(ev(entryOrder({ size: 18 })).violations, []);
  assert.match(ev(entryOrder({ size: 19 })).violations[0].message, /19 MNQ is not within the account's size budget for a 40-tick stop \(18 MNQ at \$21.24/);
  assert.match(ev(entryOrder({ stopLossBracket: undefined, rationale: 'setup:orb long, stop 21480' })).violations[0].message, /needs stopLossBracket.ticks/);
});

/**
 * Round trips for the broker's fills (search_trades): each [gross P&L, closing fills] opens with a fill without a P&L
 * and closes with that many fills sharing the gross; $0.37 a side. Times from `from` (ms), a minute apart.
 */
function roundTrips(trips, from) {
  const fills = [];
  let t = from;
  const at = () => new Date((t += 60000)).toISOString();
  for (const [gross, parts = 1] of trips) {
    fills.push({ creationTimestamp: at(), profitAndLoss: null, fees: 0.37 });
    for (let k = 0; k < parts; k += 1) fills.push({ creationTimestamp: at(), profitAndLoss: gross / parts, fees: 0.37 / parts });
  }
  return { fills, net: Math.round(fills.reduce((a, f) => a + (f.profitAndLoss || 0) - f.fees, 0) * 100) / 100 };
}

/** A mini attempt (loss_streak_stop 2) whose session closed `trips` (roundTrips), snapshotted a minute before NOW. */
function streakSetup(trips, { stop = 2 } = {}) {
  const account = { ...MINI, loss_streak_stop: stop };
  const home = trendHome();
  prop.startAttempt(home, account, new Date(NOW.getTime() - 86400000));
  const anchorAt = NOW.getTime() - 40 * 60000;
  prop.snapshot(home, account, 50000, new Date(anchorAt)); // the day's first flat snapshot: the anchor
  const { fills, net } = roundTrips(trips, anchorAt);
  prop.snapshot(home, account, Math.round((50000 + net) * 100) / 100, new Date(NOW.getTime() - 60000), { fills });
  prop.appendVerdict(home, {
    strategy: 'orb', component: 'ema_cross', contractId: CONTRACT, symbol: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40,
    maxSize: 50, bar: BAR, at: '2026-10-07T13:59:30Z', expiresAt: new Date(NOW.getTime() + 120000).toISOString(),
  });
  return input => evaluateOrder({ input, entries: [plan()], now: NOW, config: { ...config, home, skipChecks: new Set(['combine', 'policy', 'strategy']) }, strategies: [propStrategy(), EMA_CROSS], accounts: [account] });
}

/**
 * A mini attempt started part way through today from a drawn account state (prop-state.js seedAttempt: a stage-2
 * practice day), then the runner's snapshots: the day's first (the anchor, 40 minutes before NOW) and one a minute
 * before NOW after `trips` (roundTrips). `seededAt`: when the state was seeded (its last loss, when it carries a streak).
 */
function seededSetup(state, { trips = [], stop = 2, seededAt = NOW.getTime() - 45 * 60000 } = {}) {
  const account = { ...MINI, loss_streak_stop: stop };
  const home = trendHome();
  const full = { days: [200, 100], peak: 50300, dayPnl: 0, tradesToday: 0, lossesToday: 0, lossStreak: 0, ...state };
  full.balance = Math.round((50300 + full.dayPnl) * 100) / 100;
  const { tradingDayKey } = require('../../scripts/lib/trading/clock');
  prop.seedAttempt(home, account, { day: tradingDayKey(NOW), at: new Date(seededAt).toISOString(), state: full });
  const anchorAt = NOW.getTime() - 40 * 60000;
  prop.snapshot(home, account, full.balance, new Date(anchorAt));
  const { fills, net } = roundTrips(trips, anchorAt);
  prop.snapshot(home, account, Math.round((full.balance + net) * 100) / 100, new Date(NOW.getTime() - 60000), { fills });
  prop.appendVerdict(home, {
    strategy: 'orb', component: 'ema_cross', contractId: CONTRACT, symbol: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40,
    maxSize: 50, bar: BAR, at: '2026-10-07T13:59:30Z', expiresAt: new Date(NOW.getTime() + 120000).toISOString(),
  });
  const ev = (input, entries = [plan()]) => evaluateOrder({ input, entries, now: NOW, config: { ...config, home, skipChecks: new Set(['combine', 'policy', 'strategy']) }, strategies: [propStrategy(), EMA_CROSS], accounts: [account] });
  return { ev, home, account };
}

test('a seeded account state (stage-2 practice): the soft stop, loss_streak_stop and the daily loss count trigger from it as live; exits are never held', () => {
  // Down $500 today when the day was seeded: at the $500 soft limit (hard, the account's).
  assert.match(seededSetup({ dayPnl: -500, tradesToday: 2, lossesToday: 2, lossStreak: 1 }).ev(entryOrder()).violations.find(v => v.check === 'combine').message, /down \$500 today, at the soft daily limit/);
  // One loss carried in, one more after the anchor: two in a row, the loss streak stop (2).
  const streak = seededSetup({ dayPnl: -100, tradesToday: 1, lossesToday: 1, lossStreak: 1 }, { trips: [[-20]] });
  const r = streak.ev(entryOrder());
  assert.match(r.violations.find(v => v.check === 'combine').message, /2 losing trades in a row this session, at the loss streak stop \(loss_streak_stop 2\)/);
  // The same carried loss then a win: the streak ends, entries go.
  assert.deepStrictEqual(seededSetup({ dayPnl: -100, tradesToday: 1, lossesToday: 1, lossStreak: 1 }, { trips: [[30]] }).ev(entryOrder()).violations, []);
  // Without the carried loss, one loss after the anchor is no streak stop.
  assert.deepStrictEqual(seededSetup({}, { trips: [[-20]] }).ev(entryOrder()).violations, []);
  // The gate's own daily loss count (FTH_MAX_DAILY_LOSSES, 3): three losing trades carried in end the day, with no
  // review in the journal; two carried and one reviewed loss too.
  assert.deepStrictEqual(checks(seededSetup({ dayPnl: -150, tradesToday: 3, lossesToday: 3, lossStreak: 0 }, { stop: 0 }).ev(entryOrder())), ['daily-loss-count']);
  const twoPlusOne = seededSetup({ dayPnl: -100, tradesToday: 2, lossesToday: 2, lossStreak: 0 }, { stop: 0 });
  assert.deepStrictEqual(checks(twoPlusOne.ev(entryOrder(), [placed(30), review(20, 'loss'), plan(5)])), ['daily-loss-count']);
  assert.deepStrictEqual(seededSetup({ dayPnl: -100, tradesToday: 2, lossesToday: 2, lossStreak: 0 }, { stop: 0 }).ev(entryOrder()).violations, [], 'two carried losses alone are under the limit');
  // The gate's loss cooldown (FTH_MAX_CONSECUTIVE_LOSSES 2, 30 min): two in a row carried in, the last at the seed.
  const cooling = seededSetup({ dayPnl: -100, tradesToday: 2, lossesToday: 2, lossStreak: 2 }, { stop: 3, seededAt: NOW.getTime() - 10 * 60000 });
  const c = cooling.ev(entryOrder());
  assert.deepStrictEqual(checks(c), ['loss-streak']);
  assert.match(c.violations[0].message, /20 min more/);
  assert.deepStrictEqual(seededSetup({ dayPnl: -100, tradesToday: 2, lossesToday: 2, lossStreak: 2 }, { stop: 3, seededAt: NOW.getTime() - 45 * 60000 }).ev(entryOrder()).violations, [], 'cooled down');
  // Exits and protective stops are never held, whatever was carried.
  const stopped = seededSetup({ dayPnl: -500, tradesToday: 3, lossesToday: 3, lossStreak: 2 });
  for (const rationale of ['[exit] flatten the long', '[protect] stop for the long']) {
    assert.deepStrictEqual(stopped.ev(entryOrder({ side: 'sell', rationale })), { intent: 'risk-reducing', violations: [] }, rationale);
  }
  // Counts carried for another day never count today.
  const other = seededSetup({ dayPnl: -100, tradesToday: 3, lossesToday: 3, lossStreak: 0 }, { stop: 0 });
  const rec = prop.readAttempt(other.home, other.account.name);
  prop.seedAttempt(other.home, other.account, { day: '2026-10-06', at: rec.carried.at, state: { days: [200, 100], peak: 50300, dayPnl: -100, balance: 50200, tradesToday: 3, lossesToday: 3, lossStreak: 0 } });
  assert.strictEqual(prop.carriedLossState(other.home, NOW), null);
});

test('combine: after loss_streak_stop losing trades in a row the session takes no new entries (hard); exits and protective stops still go', () => {
  const refusal = /mini: 2 losing trades in a row this session, at the loss streak stop \(loss_streak_stop 2\): no new entries until the next session/;
  const two = streakSetup([[-20], [-20]]);
  const r = two(entryOrder());
  assert.strictEqual(r.violations.length, 1, JSON.stringify(r.violations));
  assert.strictEqual(r.violations[0].check, 'combine');
  assert.match(r.violations[0].message, refusal);
  // Exits and protective orders are never held, streak or not.
  for (const rationale of ['[exit] flatten the long', '[protect] stop for the long']) {
    assert.deepStrictEqual(two(entryOrder({ side: 'sell', rationale })), { intent: 'risk-reducing', violations: [] }, rationale);
  }
  // One loss: entries go. A win ends the streak; a scratch (gross 0) neither ends nor extends it.
  assert.deepStrictEqual(streakSetup([[-20]])(entryOrder()).violations, []);
  assert.deepStrictEqual(streakSetup([[-20], [30], [-20]])(entryOrder()).violations, []);
  assert.match(streakSetup([[-20], [0], [-20]])(entryOrder()).violations[0].message, refusal);
  // A stop filled in parts is one losing trade, not several.
  assert.deepStrictEqual(streakSetup([[-20, 3]])(entryOrder()).violations, []);
  // The rulebook's value decides: 3 in a row with a stop of 3, none with it off (0).
  assert.deepStrictEqual(streakSetup([[-20], [-20]], { stop: 3 })(entryOrder()).violations, []);
  assert.match(streakSetup([[-20], [-20], [-20]], { stop: 3 })(entryOrder()).violations[0].message, /3 losing trades in a row/);
  assert.deepStrictEqual(streakSetup([[-20], [-20], [-20]], { stop: 0 })(entryOrder()).violations, []);
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
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date('2026-10-04T14:00:00Z'));
  prop.snapshot(home, MINI, 50500, new Date('2026-10-05T19:00:00Z')); // Mon, close never recorded
  prop.snapshot(home, MINI, 52500, new Date('2026-10-06T19:00:00Z')); // Tue, close never recorded
  prop.snapshot(home, MINI, 52500, new Date(NOW.getTime() - 60000)); // Wed
  const ev = () => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [propStrategy(), EMA_CROSS], accounts: [MINI] });
  assert.match(ev().violations[0].message, /close of 2026-10-05 was never recorded.*\(also 2026-10-06: the user records each\)/);
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
  // The verdict's entry carries its stop as the bracket too: the ticks only in the rationale are refused.
  assert.ok(ok(entryOrder({ size: 3, stopLossBracket: undefined, rationale: 'setup:orb long, stop 40 ticks' })).violations.some(v => v.check === 'stop-defined'));
  assert.match(ok(entryOrder({ size: 4 })).violations[0].message, /size 4 is over the verdict's 3 MNQ/);
  assert.match(ok(entryOrder({ stopLossBracket: { ticks: 60, type: 'stop' } })).violations.map(v => v.message).join(), /the stop is 60 ticks; the verdict was sized for 40/);
  assert.match(ok(entryOrder({ side: 'sell' })).violations.find(v => v.check === 'policy').message, /for a long entry, not sell/);
  assert.match(ok(entryOrder(), { now: new Date(NOW.getTime() + 3 * 60000) }).violations.find(v => v.check === 'policy').message, /expired/);
  assert.match(propSetup({ policy: true, verdict: { action: 'skip', maxSize: 0, reason: 'cushion' } })(entryOrder()).violations[0].message, /the setup was skipped \(cushion\)/);
  // A verdict to trade the mini refuses a micro order, and the other way around.
  assert.match(propSetup({ policy: true, verdict: { contract: 'NQ' } })(entryOrder()).violations[0].message, /the verdict trades NQ, not MNQ/);
  // Only full allows an entry (R4: a verdict is full or skip; the retired half too): any other action refuses, never sized as full (fails closed).
  for (const action of ['close', 'hold', 'half', 'Full', '', null, undefined, 'toString', '__proto__']) {
    assert.match(propSetup({ policy: true, verdict: { action } })(entryOrder({ size: 3 })).violations.map(v => v.message).join(), /allows no entry \(a verdict is full or skip\)/, String(action));
  }
  // A full verdict carries its multiplier (the rulebook's enforced items): 0 is a skip; missing, above 1, or not a number refuses.
  assert.match(propSetup({ policy: true, verdict: { multiplier: 0 } })(entryOrder({ size: 1 })).violations.map(v => v.message).join(), /the rulebook's enforced items skipped the setup \(multiplier 0\)/);
  for (const multiplier of [undefined, null, 1.0001, 2, -0.5, NaN, Infinity, '1', 'toString']) {
    assert.match(propSetup({ policy: true, verdict: { multiplier } })(entryOrder({ size: 1 })).violations.map(v => v.message).join(), /the verdict's size multiplier \(.*\) is not above 0 and at most 1/, String(multiplier));
  }
  // A verdict no longer names the policy that made it: an old one carrying a bundle name is judged like any other.
  assert.deepStrictEqual(propSetup({ policy: true, verdict: { policy: 'p1' } })(entryOrder({ size: 3 })).violations, []);
  assert.match(propSetup({ policy: true, verdict: { contractId: 'MES', symbol: 'MES', contract: 'MES' } })(entryOrder()).violations[0].message, /no verdict/);
  // Exits and protective orders are never gated, policy or not.
  assert.deepStrictEqual(none(entryOrder({ rationale: '[exit] policy close' })).violations, []);
});

test('policy: a paper strategy stays paper inside a policy - an entry whose verdict names a component that is not active is refused (hard, unskippable)', () => {
  const policy = propStrategy({ strategies: ['ema_cross', 'value_area'] });
  const VA = { ...EMA_CROSS, name: 'value_area', status: 'paper' };
  const run = (component, registry = [policy, EMA_CROSS, VA]) => propSetup({ policy: true, verdict: { component }, registry });
  const refusal = r => (r.violations.find(v => v.check === 'policy') || {}).message;
  // Active: allowed (skipChecks names 'policy' and 'strategy': neither reaches the hard check).
  assert.deepStrictEqual(run('ema_cross')(entryOrder({ size: 3 })).violations, []);
  // Paper: refused, naming the component and its status.
  const paper = run('value_area');
  assert.match(refusal(paper(entryOrder({ size: 3 }))), /^setup:orb: the latest verdict's setup is from value_area: value_area has status "paper": orb trades only its active strategies live \(a paper strategy stays paper inside a policy\); no live entry from it\.$/);
  // Disabled, invalid, or not a rules strategy: refused too.
  assert.match(refusal(run('value_area', [policy, EMA_CROSS, { ...VA, status: 'disabled' }])(entryOrder({ size: 3 }))), /value_area has status "disabled"/);
  assert.match(refusal(run('value_area', [policy, EMA_CROSS, { ...VA, status: 'active', valid: false, errors: ['bad'] }])(entryOrder({ size: 3 }))), /value_area\/STRATEGY\.md is invalid \(bad\)/);
  assert.match(refusal(run('value_area', [policy, EMA_CROSS, { ...VA, status: 'active', signal: 'manual' }])(entryOrder({ size: 3 }))), /value_area is signal: manual/);
  // Unknown (fails closed): not in the registry, not one of the policy's strategies, or no component named.
  assert.match(refusal(run('value_area', [policy, EMA_CROSS])(entryOrder({ size: 3 }))), /from value_area: value_area is not a known strategy/);
  assert.match(refusal(run('orb_x', [policy, EMA_CROSS, { ...EMA_CROSS, name: 'orb_x' }])(entryOrder({ size: 3 }))), /from orb_x: orb_x is not one of orb's strategies/);
  assert.match(refusal(run(undefined)(entryOrder({ size: 3 }))), /from no named strategy: the setup's strategy is not one of orb's strategies/);
  // Exits and protective stops of an open position are never held by it.
  assert.deepStrictEqual(paper(entryOrder({ side: 'sell', rationale: '[exit] policy close' })).violations, []);
  assert.deepStrictEqual(paper(entryOrder({ side: 'sell', rationale: '[protect] stop for the policy long', stopLossBracket: undefined })).violations, []);
  // propViolations itself: no registry refuses; `paper` (order_plan in a paper run, never the gate) takes a paper component, never a disabled one.
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 60000));
  prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'value_area', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 3, at: '2026-10-07T13:59:30Z', expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const pv = extra => prop.propViolations(home, { strategy: policy, account: MINI, input: entryOrder({ size: 3 }), now: NOW, ...extra }).filter(v => v.check === 'policy').map(v => v.message).join(' ');
  assert.match(pv({}), /value_area's status can't be read \(no strategy registry\)/);
  assert.match(pv({ strategies: [policy, EMA_CROSS, VA] }), /value_area has status "paper"/);
  assert.strictEqual(pv({ strategies: [policy, EMA_CROSS, VA], paper: true }), '');
  assert.match(pv({ strategies: [policy, EMA_CROSS, { ...VA, status: 'disabled' }], paper: true }), /value_area has status "disabled": orb trades only its active strategies \(/);
  // A setup the runner skipped for a higher-priority policy in the same cycle (lane-cycle.js skippedVerdict, recorded
  // by the prop hooks' supersede): the latest verdict is that skip, so the entry the full verdict allowed is refused.
  const { skippedVerdict } = require('../../scripts/lib/lane-cycle');
  prop.appendVerdict(home, skippedVerdict(prop.latestVerdict(home, 'orb', 'MNQ'), 'other_policy', new Date(NOW.getTime() - 1000)));
  assert.match(pv({ strategies: [policy, EMA_CROSS, VA], paper: true }), /the setup was skipped \(skipped: lower priority \(other_policy goes first/);
});

test('policy: a verdict is tied to its own bar - the bar the signal record says the setup is on now (hard, unskippable)', () => {
  // The helpers' record (trendHome) is for the bar opened 13:57 (written "...00.000Z"); the verdict's text may differ.
  const same = propSetup({ policy: true, verdict: { bar: '2026-10-07T08:57:00-05:00' } });
  assert.deepStrictEqual(same(entryOrder({ size: 3 })).violations, [], 'the same bar in another format or offset passes');
  // The runner recorded the next bar (the component fired again) but no verdict for it: the old bar's verdict
  // (unexpired, same side and stop) is never used for the new bar's setup.
  const older = propSetup({ policy: true, verdict: { bar: '2026-10-07T13:54:00Z' } });
  const o = older(entryOrder({ size: 3 }));
  assert.deepStrictEqual(o.violations.map(v => v.check), ['policy'], 'skipChecks (policy) cannot reach it');
  assert.match(o.violations[0].message, /setup:orb: the latest verdict is for the 3m bar opened 2026-10-07T13:54:00Z; the setup on the bar opened 2026-10-07T13:57:00\.000Z has no verdict yet .*wait for the next setup's verdict\.$/);
  // No bar, or one that can't be read: refused, never assumed current.
  for (const bar of [undefined, null, '', 'yesterday', 1791380220000]) {
    assert.match(propSetup({ policy: true, verdict: { bar } })(entryOrder({ size: 3 })).violations.map(v => v.message).join(), /the latest verdict \(full, 2026-10-07T13:59:30Z\) names no bar, so it can't be tied to the setup on the 3m bar opened 2026-10-07T13:57:00\.000Z/, String(bar));
  }
  // A verdict for a bar after the last recorded one (the record fell behind): refused, never trusted ahead of it.
  assert.match(propSetup({ policy: true, verdict: { bar: '2026-10-07T14:00:00Z' } })(entryOrder({ size: 3 })).violations[0].message, /after the last recorded 3m bar \(opened 2026-10-07T13:57:00\.000Z\): the signal record is behind the verdict/);
  // Exits and protective orders are never held by it.
  assert.deepStrictEqual(older(entryOrder({ side: 'sell', rationale: '[exit] policy close' })).violations, []);
  assert.deepStrictEqual(older(entryOrder({ side: 'sell', rationale: '[protect] stop for the policy long', stopLossBracket: undefined })).violations, []);
});

test('policy: the verdict\'s bar is read from the strategy\'s own timeframe record; none or an unreadable one refuses', () => {
  const fs = require('fs');
  const path = require('path');
  const run = (home, strategy = propStrategy()) => {
    prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
    prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 60000));
    prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 3, at: '2026-10-07T13:59:30Z', expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
    return evaluateOrder({ input: entryOrder({ size: 3 }), entries: [plan()], now: NOW, config: { ...config, home, skipChecks: new Set(['policy', 'combine']) }, strategies: [strategy, EMA_CROSS], accounts: [MINI] }).violations.map(v => v.message).join(' ');
  };
  const missing = trendHome();
  fs.rmSync(path.join(missing, 'signals'), { recursive: true });
  assert.match(run(missing), /setup:orb: no 3m signal record for MNQ, so the bar the setup is on is unknown .*; the verdict can't be tied to it\./);
  const garbled = trendHome();
  fs.writeFileSync(path.join(garbled, 'signals', 'MNQ-3m.json'), '{ half');
  assert.match(run(garbled), /the 3m signal record for MNQ is unreadable/);
  // Another timeframe's record doesn't say where this strategy's setup is: a 1h policy strategy reads the 60m record.
  assert.match(run(trendHome(), propStrategy({ timeframe: '1h' })), /no 60m signal record for MNQ/);
  const hourly = trendHome();
  fs.writeFileSync(path.join(hourly, 'signals', 'MNQ-60m.json'), JSON.stringify({ symbol: 'MNQ', timeframe: '60m', asOf: BAR, candidates: [] }));
  assert.strictEqual(run(hourly, propStrategy({ timeframe: '1h' })), '');
});

test('combine: while an attempt runs every entry needs a strategy that trades it; an invalid one still gets the checks', () => {
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  const other = { name: 'orb', valid: true, errors: [], status: 'active', instruments: ['MNQ'], signal: 'rules', compiledRules: null };
  const run = strategies => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home }, strategies, accounts: [MINI] });
  assert.match(run([other]).violations.find(v => v.check === 'combine').message, /mini attempt is running: only a policy strategy that trades it/);
  assert.deepStrictEqual(evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home: trendHome() }, strategies: [other], accounts: [MINI] }).violations, [], 'no attempt: nothing changes');
  const invalid = run([propStrategy({ valid: false, errors: ['bad'] }), EMA_CROSS]);
  assert.ok(invalid.violations.some(v => v.check === 'policy' && /setup:orb is invalid \(bad\); no entry is sized from it/.test(v.message)), 'an invalid STRATEGY.md that names an account is still refused, hard');
  prop.endAttempt(home, 'mini');
  assert.deepStrictEqual(run([other]).violations, [], 'an ended attempt no longer gates other strategies');
});

test('combine: a close the runner missed stops entries until it is recorded', () => {
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date('2026-10-05T14:00:00Z'));
  prop.snapshot(home, MINI, 50300, new Date('2026-10-06T19:00:00Z')); // Tuesday's trading day, never closed
  prop.snapshot(home, MINI, 50300, new Date(NOW.getTime() - 60000)); // Wednesday
  prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 50, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const ev = () => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [propStrategy(), EMA_CROSS], accounts: [MINI] });
  assert.match(ev().violations[0].message, /close of 2026-10-06 was never recorded.*the user records it: .*record-day --account mini --day 2026-10-06/);
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
  // A 40-tick stop plus a tick of slippage risks $21.24 a contract: 4 fit in the room ($84.96), not the budget's 10.
  const home = trendHome();
  prop.startAttempt(home, { ...MINI, daily_loss_soft: 0 }, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, { ...MINI, daily_loss_soft: 0 }, 49100, new Date(NOW.getTime() - 60000));
  const acct = { ...MINI, daily_loss_soft: 0 };
  prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 50, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const ev = size => evaluateOrder({ input: entryOrder({ size }), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [propStrategy(), EMA_CROSS], accounts: [acct] });
  assert.deepStrictEqual(ev(4).violations, []);
  assert.match(ev(5).violations[0].message, /5 MNQ is not within the account's size budget for a 40-tick stop \(4 MNQ/);
});

test('combine: the room counts the stop\'s expected slippage: a stopped size never reaches the daily limit a tick past the stop', () => {
  // Down $917 of a $1,000 daily limit: $83 of room. Without slippage, 4 micros at a 40-tick stop ($20.74 each,
  // $82.96) fit; stopped a tick past the stop they lose 4 x $21.24 = $84.96, past the limit. With it: 3 ($63.72).
  const acct = { ...MINI, daily_loss_soft: 0 };
  const home = trendHome();
  prop.startAttempt(home, acct, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, acct, 49083, new Date(NOW.getTime() - 60000));
  const verdict = maxSize => prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const ev = size => evaluateOrder({ input: entryOrder({ size }), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [propStrategy(), EMA_CROSS], accounts: [acct] });
  verdict(4);
  assert.match(ev(4).violations.map(v => v.message).join(), /4 MNQ is not within the account's size budget for a 40-tick stop \(3 MNQ at \$21\.24/);
  verdict(3);
  assert.deepStrictEqual(ev(3).violations, []);
});

test('combine: the gate sizes with the policy strategy\'s own stop_slippage_ticks, as its verdict does', () => {
  // $400 budget, a 40-tick MNQ stop. sizing.stop_slippage_ticks 3: 43 x $0.50 = $21.50 + $0.74 = $22.24 a micro,
  // 17 MNQ ($378.08); the default tick sizes 18 ($21.24 each).
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 60000));
  const slow = propStrategy({ sizing: testSizing({ stop_slippage_ticks: 3 }) });
  assert.deepStrictEqual(prop.budgetPlan(home, MINI, slow, 'MNQ', 40), { root: 'MNQ', size: 17, riskPerContract: 22.24 });
  assert.deepStrictEqual(prop.budgetPlan(home, MINI, propStrategy(), 'MNQ', 40), { root: 'MNQ', size: 18, riskPerContract: 21.24 });
  prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 18, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const ev = (size, s) => evaluateOrder({ input: entryOrder({ size }), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [s, EMA_CROSS], accounts: [MINI] }).violations;
  assert.deepStrictEqual(ev(18, propStrategy()), []);
  assert.match(ev(18, slow).map(v => v.message).join(), /18 MNQ is not within the account's size budget for a 40-tick stop \(17 MNQ at \$22\.24/);
  assert.deepStrictEqual(ev(17, slow), []);
});

test('combine: minis and micros, by the policy strategy\'s contract mode', () => {
  // $50,000 on the mini account: budget 0.2 x $2,000 = $400. A 40-tick stop risks $21.24 a micro (41 ticks x $0.50 + $0.74)
  // (18 fit) or $207.80 a mini (NQ: 41 x $5 = $205 + $2.80 fees). auto trades minis once the size reaches 10 micros: 1 NQ.
  const acct = { ...MINI, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } };
  const NQ = 'NQ';
  const run = (contracts, input, verdict) => {
    const home = trendHome();
    prop.startAttempt(home, acct, new Date(NOW.getTime() - 86400000));
    prop.snapshot(home, acct, 50000, new Date(NOW.getTime() - 60000));
    prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString(), ...verdict });
    return evaluateOrder({ input, entries: [plan(5, { contractId: input.contractId })], now: NOW, config: { ...config, home }, strategies: [propStrategy({ contracts }), EMA_CROSS], accounts: [acct] }).violations;
  };
  assert.deepStrictEqual(run('auto', entryOrder({ contractId: NQ, size: 1 }), { contract: 'NQ', maxSize: 1 }), []);
  assert.match(run('auto', entryOrder({ size: 18 }), { contract: 'MNQ', maxSize: 18 }).map(v => v.message).join(), /18 MNQ is not within .*\(1 NQ at \$207.80/);
  assert.deepStrictEqual(run('micro', entryOrder({ size: 18 }), { contract: 'MNQ', maxSize: 18 }), []);
  assert.match(run('micro', entryOrder({ contractId: NQ, size: 1 }), { contract: 'NQ', maxSize: 1 }).map(v => v.message).join(), /1 NQ is not within .*\(18 MNQ/);
  assert.deepStrictEqual(run('mini', entryOrder({ contractId: NQ, size: 1 }), { contract: 'NQ', maxSize: 1 }), []);
  assert.match(run('auto', entryOrder({ contractId: NQ, size: 2 }), { contract: 'NQ', maxSize: 1 }).map(v => v.message).join(), /2 NQ is not within/);
});

test('combine: a selected leg is the only one a policy strategy trades and is sized in, whatever its contract mode', () => {
  // As above: $400 budget, a 40-tick stop. MNQ selected: 18 MNQ under auto (never 1 NQ); NQ selected: 1 NQ under micro.
  const acct = { ...MINI, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } };
  const run = (contracts, symbols, input, verdict) => {
    const home = trendHome();
    prop.startAttempt(home, acct, new Date(NOW.getTime() - 86400000));
    prop.snapshot(home, acct, 50000, new Date(NOW.getTime() - 60000));
    prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString(), ...verdict });
    const selection = loadConfig({ FTH_SYMBOLS: symbols }).selection;
    return evaluateOrder({ input, entries: [plan(5, { contractId: input.contractId })], now: NOW, config: { ...config, home, selection }, strategies: [propStrategy({ contracts }), EMA_CROSS], accounts: [acct] }).violations;
  };
  for (const contracts of ['auto', 'mini', 'micro']) {
    assert.deepStrictEqual(run(contracts, 'MNQ', entryOrder({ size: 18 }), { contract: 'MNQ', maxSize: 18 }), [], `MNQ selected, ${contracts}`);
    const nq = run(contracts, 'MNQ', entryOrder({ contractId: 'NQ', size: 1 }), { contract: 'NQ', maxSize: 1 });
    assert.ok(nq.some(v => v.check === 'strategy' && /trades MNQ \(the selected contract\), not NQ/.test(v.message)), `MNQ selected, ${contracts}: NQ refused`);
    assert.ok(nq.some(v => v.check === 'combine' && /1 NQ is not within .*\(18 MNQ/.test(v.message)), `MNQ selected, ${contracts}: the budget is in MNQ`);
    assert.deepStrictEqual(run(contracts, 'NQ', entryOrder({ contractId: 'NQ', size: 1 }), { contract: 'NQ', maxSize: 1 }), [], `NQ selected, ${contracts}`);
    assert.match(run(contracts, 'NQ', entryOrder({ size: 18 }), { contract: 'MNQ', maxSize: 18 }).map(v => v.message).join(), /18 MNQ is not within .*\(1 NQ at \$207.80/, `NQ selected, ${contracts}`);
  }
  // The strategy check skipped: the budget alone still refuses the other leg (hard, unskippable).
  const home = trendHome();
  prop.startAttempt(home, acct, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, acct, 50000, new Date(NOW.getTime() - 60000));
  prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, contract: 'NQ', maxSize: 1, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const skipped = evaluateOrder({ input: entryOrder({ contractId: 'NQ', size: 1 }), entries: [plan(5, { contractId: 'NQ' })], now: NOW, config: { ...config, home, selection: loadConfig({ FTH_SYMBOLS: 'MNQ' }).selection, skipChecks: new Set(['strategy']) }, strategies: [propStrategy({ contracts: 'auto' }), EMA_CROSS], accounts: [acct] });
  assert.ok(skipped.violations.some(v => v.check === 'combine' && /1 NQ is not within .*\(18 MNQ/.test(v.message)));
});

test('combine: an untagged entry is refused while an attempt runs, even with the setup-tag check skipped', () => {
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  const r = evaluateOrder({ input: entryOrder({ rationale: 'going long, stop 21480' }), entries: [plan()], now: NOW, config: { ...config, home, skipChecks: new Set(['setup-tag', 'strategy']) }, strategies: [propStrategy(), EMA_CROSS], accounts: [MINI] });
  assert.deepStrictEqual(checks(r), ['combine']);
});

test('policy: a full verdict\'s budget is checked at its multiplier, even when full size is minis and the share is micros', () => {
  // $600 budget (0.2 x $3,000 cushion on a $3,000 max loss), auto. 60-tick stop:
  // a micro risks 61 ticks (a tick of slippage) x $0.50 = $30.50 + $0.74 = $31.24 (19 fit, $593.56: 1 NQ at $307.80);
  // at 0.5: floor(19 x 0.5) = 9 micros, under one mini.
  const acct = { ...MINI, max_loss: 3000, daily_loss_soft: 0, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } };
  const home = trendHome();
  prop.startAttempt(home, acct, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, acct, 50000, new Date(NOW.getTime() - 60000));
  const verdict = multiplier => prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contractId: CONTRACT, direction: 'long', action: 'full', multiplier, contract: 'MNQ', maxSize: 9, stopTicks: 60, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const run = size => evaluateOrder({ input: entryOrder({ size, stopLossBracket: { ticks: 60, type: 'stop' } }), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [propStrategy({ contracts: 'auto' }), EMA_CROSS], accounts: [acct] }).violations;
  verdict(0.5);
  assert.deepStrictEqual(run(9), []);
  assert.match(run(10).map(v => v.message).join(), /10 MNQ is not within the account's 0\.5x size budget/);
  // A share that rounds below one contract fits nothing (floor, as the priority order's halving: 0 means no trade).
  verdict(0.05);
  assert.match(run(1).map(v => v.message).join(), /1 MNQ is not within the account's 0\.05x size budget for a 60-tick stop \(nothing/);
});

test('policy: an invalid policy strategy (its rulebook refuses it) is refused hard, even with the strategy check skipped; exits and protective stops go', () => {
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 60000));
  prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 18, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const bad = propStrategy({ valid: false, errors: ['account: the rulebook doesn\'t list orb'] });
  const run = (input, strategy = bad) => evaluateOrder({ input, entries: [plan()], now: NOW, config: { ...config, home, skipChecks: new Set(['strategy']) }, strategies: [strategy, EMA_CROSS], accounts: [MINI] }).violations;
  for (const size of [1, 2, 18]) {
    const v = run(entryOrder({ size }));
    assert.ok(v.some(x => x.check === 'policy' && /setup:orb is invalid \(account: the rulebook doesn't list orb\); no entry is sized from it/.test(x.message)), `${size}: ${JSON.stringify(v)}`);
  }
  // The same entry from the valid policy goes: only the invalidity refuses it.
  assert.deepStrictEqual(run(entryOrder({ size: 2 }), propStrategy()), []);
  // Risk reduction is never held by it.
  assert.deepStrictEqual(run(entryOrder({ side: 'sell', rationale: '[exit] flatten the long', stopLossBracket: undefined })), []);
  assert.deepStrictEqual(run(entryOrder({ side: 'sell', type: 'stop', stopPrice: 21480, stopLossBracket: undefined, rationale: '[protect] stop for the long' })), []);
});

test('policy: a verdict permits one entry; a re-entry waits for the next setup\'s verdict', () => {
  const ev = propSetup({ policy: true, verdict: { at: new Date(NOW.getTime() - 120000).toISOString() } });
  assert.deepStrictEqual(ev(entryOrder()).violations, []);
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 60000));
  prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 3, at: new Date(NOW.getTime() - 120000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const run = entries => evaluateOrder({ input: entryOrder(), entries: [plan(), ...entries], now: NOW, config: { ...config, home, skipChecks: new Set(['review-before-next-entry']) }, strategies: [propStrategy(), EMA_CROSS], accounts: [MINI] }).violations;
  assert.match(run([placed(1, 'setup:orb long, stop 40 ticks')]).map(v => v.message).join(), /already used for an entry/);
  assert.deepStrictEqual(run([placed(5, 'setup:orb long, stop 40 ticks')]), [], 'an entry before this verdict doesn\'t use it');
  assert.deepStrictEqual(run([placed(1, 'setup:orb long', false)]), [], 'a rejected order doesn\'t use it');
});

test('policy: only this strategy\'s entries on this index use its verdict', () => {
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  // A snapshot after those entries (it holds them): only the verdict's own use is judged here.
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 30000));
  prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 3, at: new Date(NOW.getTime() - 120000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const run = entries => evaluateOrder({ input: entryOrder(), entries: [plan(), ...entries], now: NOW, config: { ...config, home, skipChecks: new Set(['review-before-next-entry']) }, strategies: [propStrategy(), EMA_CROSS], accounts: [MINI] }).violations;
  assert.deepStrictEqual(run([placed(1, 'setup:orb-x long')]), [], 'another strategy\'s tag');
  assert.deepStrictEqual(run([{ ...placed(1, 'setup:orb long'), contractId: 'MES' }]), [], 'another index');
  assert.match(run([{ ...placed(1, 'setup:orb long'), contractId: 'NQ' }]).map(v => v.message).join(), /already used/, 'the mini of the same index');
  assert.match(run([{ ...placed(1, 'setup:orb long'), contractId: 'fake:ENQ:Z25' }]).map(v => v.message).join(), /already used/, 'a broker id it can\'t name: fails closed');
});

test('combine: an entry since the account snapshot holds every other entry until the next snapshot (one position across markets)', () => {
  // Two indexes fire on one bar: the snapshot (taken before the cycle) shows the account flat, and each
  // verdict was sized from the whole cushion. Once one entry goes in, the other waits for a snapshot that holds it.
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 90000));
  prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contract: 'MNQ', contractId: CONTRACT, direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 3, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  const run = entries => evaluateOrder({ input: entryOrder(), entries: [plan(), ...entries], now: NOW, config: { ...config, home, skipChecks: new Set(['review-before-next-entry']) }, strategies: [propStrategy(), EMA_CROSS], accounts: [MINI] }).violations;
  const es = { ...placed(1, 'setup:orb long, stop 16 ticks'), contractId: 'ES' };
  assert.match(run([es]).map(v => `[${v.check}] ${v.message}`).join(), /\[combine\] mini: an entry \(ES\) went in at or after the account snapshot .* one position at a time/);
  assert.match(run([{ ...es, text: 'going long ES' }]).map(v => v.message).join(), /went in at or after the account snapshot/, 'untagged, another strategy\'s: any entry counts');
  assert.deepStrictEqual(run([{ ...es, ts: minutesAgo(2) }]), [], 'an entry before the snapshot is in it (its open count)');
  assert.deepStrictEqual(run([{ ...placed(1, 'setup:orb long', false), contractId: 'ES' }]), [], 'a rejected order isn\'t an entry');
  assert.deepStrictEqual(run([{ ...placed(1, '[exit] flatten ES'), contractId: 'ES' }]), [], 'an exit adds no risk');
  assert.match(run([{ ...es, ts: 'not a time' }]).map(v => v.message).join(), /went in at or after the account snapshot/, 'through the gate too, an entry with no readable time counts as since the snapshot');
  // The next snapshot holds it: the gate judges from that one (open position, or flat again after it closed).
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 20000));
  assert.deepStrictEqual(run([es]), []);
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 10000), { open: 1, openIds: ['ES'] });
  assert.match(run([es]).map(v => v.message).join(), /a position is open on the account \(ES\)/);
});

test('combine: the snapshot check reads only local state and needs a snapshot to compare with', () => {
  const home = trendHome();
  prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
  assert.strictEqual(prop.entrySinceSnapshot(home, 'mini', [{ ...placed(1), contractId: 'ES' }]), null, 'no snapshot: combineBlock refuses it instead');
  assert.match(prop.combineBlock(home, 'mini', NOW), /snapshot is missing/);
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 90000));
  assert.strictEqual(prop.entrySinceSnapshot(home, 'mini', []), null);
  assert.strictEqual(prop.entrySinceSnapshot(home, 'mini', null), null);
  assert.match(prop.entrySinceSnapshot(home, 'mini', [{ ...placed(1), contractId: 'ES' }]), /ES/);
  assert.match(prop.entrySinceSnapshot(home, 'mini', [{ ...placed(1), ts: 'not a time' }]), /went in/, 'an entry with no readable time fails closed');
  // A snapshot from the future (the clock stepped back) can't be trusted to hold the latest entries.
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() + 5 * 60000));
  assert.match(prop.combineBlock(home, 'mini', NOW), /dated in the future/);
  prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() + 30000));
  assert.strictEqual(prop.combineBlock(home, 'mini', NOW), null, 'under a minute ahead is clock skew, not a stale view');
});

test('order-consistency: the side named in the rationale must be the order side', () => {
  const r = evaluate(entryOrder({ side: 'sell', rationale: 'setup:orb long break above 21500, stop 21480' }), [plan()]);
  assert.deepStrictEqual(checks(r), ['order-consistency']);
  assert.match(r.violations[0].message, /rationale says long but the order side is sell/);
  // "short" right after the tag with a sell agrees; a side word later in the text is not read.
  assert.deepStrictEqual(evaluate(entryOrder({ side: 'sell', rationale: 'setup:orb short break below 21500, stop 21520' }), [plan()]).violations, []);
  assert.deepStrictEqual(evaluate(entryOrder({ side: 'sell', rationale: 'setup:orb break below; longs trapped, stop 21520' }), [plan()]).violations, []);
});

test('order-consistency: stop and target on the right sides of a known entry and of each other', () => {
  const limit = extra => entryOrder({ type: 'limit', limitPrice: 21500, stopLossBracket: { ticks: 80, type: 'stop' }, ...extra });
  assert.deepStrictEqual(evaluate(limit({ rationale: 'setup:orb long, stop 21480, target 21540' }), [plan()]).violations, []);
  assert.match(evaluate(limit({ rationale: 'setup:orb long, stop 21520' }), [plan()]).violations[0].message,
    /stop 21520 is on the wrong side of the buy entry 21500/);
  assert.match(evaluate(limit({ rationale: 'setup:orb long, stop 21480, target 21490' }), [plan()]).violations[0].message,
    /target 21490 is on the wrong side of the buy entry 21500/);
  // A market order: the target must be above the stop for a buy.
  assert.match(evaluate(entryOrder({ rationale: 'setup:orb long, stop 21540, target 21480' }), [plan()]).violations[0].message,
    /a long needs the target above the stop/);
});

test('order-consistency: prices on the tick and whole bracket ticks', () => {
  assert.match(evaluate(entryOrder({ rationale: 'setup:orb long, stop 21480.10' }), [plan()]).violations[0].message, /stop 21480\.1 is not on the 0\.25 tick/);
  assert.match(evaluate(entryOrder({ type: 'limit', limitPrice: 21500.3, rationale: 'setup:orb long, stop 21480' }), [plan()]).violations[0].message,
    /limitPrice 21500\.3 is not on the 0\.25 tick/);
  assert.match(evaluate(entryOrder({ stopLossBracket: { ticks: 7.5, type: 'stop' } }), [plan()]).violations.find(v => v.check === 'order-consistency').message, /whole number of ticks/);
  // A number with a unit is not a price.
  assert.deepStrictEqual(evaluate(entryOrder({ rationale: 'setup:orb long, stop 40 ticks, target 2R' }), [plan()]).violations, []);
  // An unknown contract has no tick spec: only the side checks apply.
  assert.ok(!checks(evaluate(entryOrder({ contractId: 'ZZZ', rationale: 'setup:orb long, stop 1.111' }), [plan()])).includes('order-consistency'));
});

test('order-consistency: brackets must match the rationale prices', () => {
  // Limit entry 21500, stop 21480 = 80 ticks; within one tick of rounding passes.
  const limit = sl => entryOrder({ type: 'limit', limitPrice: 21500, stopLossBracket: { ticks: sl, type: 'stop' }, rationale: 'setup:orb long, stop 21480, target 21540' });
  assert.deepStrictEqual(evaluate(limit(81), [plan()]).violations, []);
  assert.match(evaluate(limit(40), [plan()]).violations[0].message, /stopLossBracket\.ticks 40 doesn't match the stop: 21500\.00 to 21480\.00 is 80 ticks/);
  const tp = entryOrder({ type: 'limit', limitPrice: 21500, stopLossBracket: { ticks: 80, type: 'stop' }, takeProfitBracket: { ticks: 40, type: 'limit' }, rationale: 'setup:orb long, stop 21480, target 21540' });
  assert.match(evaluate(tp, [plan()]).violations[0].message, /takeProfitBracket\.ticks 40 doesn't match the target/);
  // Market: the brackets' span (stop + target ticks) must equal the stop-to-target distance.
  const mkt = (sl, t) => entryOrder({ stopLossBracket: { ticks: sl, type: 'stop' }, takeProfitBracket: { ticks: t, type: 'limit' }, rationale: 'setup:orb long, stop 21480, target 21540' });
  assert.deepStrictEqual(evaluate(mkt(80, 160), [plan()]).violations, []);
  assert.deepStrictEqual(evaluate(mkt(82, 159), [plan()]).violations, []); // slippage within two ticks
  assert.match(evaluate(mkt(40, 80), [plan()]).violations[0].message, /brackets span 120 ticks but the rationale's stop 21480 to target 21540 is 240 ticks/);
});

test('order-consistency: [exit] and [protect] orders are not checked', () => {
  const r = evaluate(entryOrder({ side: 'sell', stopLossBracket: undefined, rationale: '[protect] stop for long, stop 21480.10' }), []);
  assert.deepStrictEqual(r.violations, []);
});

test('order-consistency: everyday rationale wording is not misread as prices', () => {
  const mkt = rationale => entryOrder({ stopLossBracket: { ticks: 80, type: 'stop' }, takeProfitBracket: { ticks: 160, type: 'limit' }, rationale });
  for (const r of [
    'setup:orb long, stop 21,480.00, target 21,540', // thousands separators
    'setup:orb long, stop 21480, target 2:1', // a ratio
    'setup:orb long, stop 0.5 ATR, target 3 R', // multiples
    'setup:orb long, stop 21480 below OR low, target 21540 prior high',
  ]) assert.deepStrictEqual(evaluate(mkt(r), [plan()]).violations, [], r);
});

// --- The multi-timeframe trend rule (mtf-state.js): hard, read from the recorded read. ---
const trendStrategy = (extra = {}) => ({ name: 'orb', valid: true, errors: [], status: 'active', instruments: ['MNQ'], signal: 'manual', mtf: 'trend', ...extra });
const trendEval = (home, input = entryOrder(), strategies = [trendStrategy()], extra = {}) =>
  evaluateOrder({ input, entries: [plan()], now: NOW, config: { ...config, home, mtfMaxAgeMin: 15, ...extra }, strategies });

test('mtf-trend: a trend strategy may not enter against the prevailing trend; a reversal strategy may', () => {
  const down = trendHome(undefined, { biases: { 240: -1, 60: -1, 15: 1 } });
  const r = trendEval(down);
  assert.deepStrictEqual(checks(r), ['mtf-trend']);
  assert.match(r.violations[0].message, /setup:orb long is against the prevailing 4h down trend/);
  assert.deepStrictEqual(trendEval(down, entryOrder({ side: 'sell', rationale: 'setup:orb short, stop 21520' })).violations, []);
  assert.deepStrictEqual(trendEval(down, entryOrder(), [trendStrategy({ mtf: 'reversal' })]).violations, []);
});

test('mtf-trend: hard - FTH_SKIP_CHECKS can not switch it off, and a missing or stale read refuses trend entries', () => {
  const down = trendHome(undefined, { biases: { 240: -1, 60: 0, 15: 0 } });
  assert.deepStrictEqual(checks(trendEval(down, entryOrder(), undefined, { skipChecks: new Set(['mtf-trend', 'strategy']) })), ['mtf-trend']);
  assert.match(trendEval(tmpDir()).violations[0].message, /No multi-timeframe read for MNQ/);
  const stale = trendHome(undefined, { closedAt: '2026-10-07T13:00:00.000Z' });
  assert.match(trendEval(stale).violations[0].message, /60 min old/);
  // Exits and protective orders are never held by it.
  assert.deepStrictEqual(trendEval(down, entryOrder({ side: 'sell', rationale: '[exit] trend turned' })).violations, []);
});

test('mtf-trend: a policy strategy entry is judged by the strategy whose setup its verdict trades', () => {
  const run = (component, biases) => {
    const home = trendHome(undefined, { biases });
    prop.startAttempt(home, MINI, new Date(NOW.getTime() - 86400000));
    prop.snapshot(home, MINI, 50000, new Date(NOW.getTime() - 60000));
    prop.appendVerdict(home, {
      strategy: 'orb', component, contractId: CONTRACT, symbol: 'MNQ', contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40,
      maxSize: 50, policy: null, bar: BAR, at: '2026-10-07T13:59:30Z', expiresAt: new Date(NOW.getTime() + 120000).toISOString(),
    });
    const strategies = [propStrategy({ strategies: ['ema_cross', 'crt_1h'] }), trendStrategy({ name: 'ema_cross' }), trendStrategy({ name: 'crt_1h', mtf: 'reversal' })];
    return evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home, mtfMaxAgeMin: 15 }, strategies, accounts: [MINI] });
  };
  const down = { 240: -1, 60: -1, 15: -1 };
  assert.match(run('ema_cross', down).violations.find(v => v.check === 'mtf-trend').message, /setup:ema_cross long is against the prevailing 4h down trend/);
  assert.ok(!run('crt_1h', down).violations.some(v => v.check === 'mtf-trend'), 'a reversal component may fade it');
  assert.ok(!run('ema_cross', { 240: 1, 60: 1, 15: 1 }).violations.some(v => v.check === 'mtf-trend'));
});

test('trigger-fired: a rules strategy enters only on its own fired trigger, on that side, on a recent bar; hard', () => {
  const rules = trendStrategy({ signal: 'rules', mtf: 'reversal' });
  const ev = (home, input = entryOrder(), extra = {}) => evaluateOrder({ input, entries: [plan()], now: NOW, config: { ...config, home, mtfMaxAgeMin: 15, signalMaxAgeBars: 3, skipChecks: new Set(['trigger-fired']), ...extra }, strategies: [rules] });
  assert.deepStrictEqual(ev(trendHome(undefined, { fired: [{ name: 'orb', direction: 'long' }] })).violations, []);
  const relabel = ev(trendHome(undefined, { fired: [{ name: 'bos', direction: 'long' }] }));
  assert.deepStrictEqual(checks(relabel), ['trigger-fired'], 'not skippable');
  assert.match(relabel.violations[0].message, /setup:orb long did not fire.*fired: bos long/);
  assert.match(ev(trendHome(undefined, { closedAt: '2026-10-07T13:40:00.000Z' })).violations[0].message, /the setup has expired/);
  // Manual strategies are the LLM's judgment: no trigger record needed.
  assert.deepStrictEqual(ev(tmpDir(), entryOrder(), {}).violations.filter(v => v.check === 'trigger-fired').length, 1);
  assert.deepStrictEqual(evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home: trendHome(undefined, { fired: [] }), mtfMaxAgeMin: 15 }, strategies: [trendStrategy()] }).violations, []);
});

test('trigger-fired: the signal\'s age is counted in bars of its own timeframe (3 by default); an unknown timeframe is the strictest; FTH_SIGNAL_MAX_AGE_MIN only shortens it', () => {
  const fs = require('fs');
  const path = require('path');
  // A signal record on `tf` for a bar that closed `ago` minutes before NOW, with orb long fired.
  const homeAt = (tf, ago) => {
    const home = trendHome(undefined, { fired: [{ name: 'orb', direction: 'long' }] });
    const closedAt = new Date(NOW.getTime() - ago * 60000).toISOString();
    fs.writeFileSync(path.join(home, 'signals', `MNQ-${tf}.json`), JSON.stringify({ symbol: 'MNQ', timeframe: tf, asOf: closedAt, closedAt, candidates: [{ name: 'orb', direction: 'long' }] }));
    return home;
  };
  const ev = (tf, ago, timeframe, extra = {}) => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...loadConfig({}), killSwitchFile: config.killSwitchFile, home: homeAt(tf, ago), mtfMaxAgeMin: 1e9, ...extra }, strategies: [trendStrategy({ signal: 'rules', timeframe })] })
    .violations.filter(v => v.check === 'trigger-fired').map(v => v.message);
  // The default is 3 bars: 3 min on 1m, 9 min on 3m, 45 min on 15m (the flat 10 minutes it replaced is gone).
  assert.deepStrictEqual(ev('1m', 3, '1m'), []);
  assert.match(ev('1m', 4, '1m')[0], /closed 4 min ago \(limit 3 min: 3 1m bars, FTH_SIGNAL_MAX_AGE_BARS\): the setup has expired/);
  assert.deepStrictEqual(ev('3m', 9, '3m'), []);
  assert.match(ev('3m', 10, '3m')[0], /limit 9 min: 3 3m bars/);
  assert.deepStrictEqual(ev('15m', 45, '15m'), []);
  assert.match(ev('15m', 46, '15m')[0], /limit 45 min/);
  // Never over 45 minutes: a 1h signal (3 bars would be 180) expires at 45 too, and so does a 15m one at more bars.
  // (The record is read under the strategy's own timeframe name, as the gate reads it.)
  assert.deepStrictEqual(ev('1h', 45, '1h'), []);
  assert.match(ev('1h', 46, '1h')[0], /closed 46 min ago \(limit 45 min: 3 1h bars, FTH_SIGNAL_MAX_AGE_BARS, at most 45 min\)/);
  assert.match(ev('15m', 46, '15m', { signalMaxAgeBars: 5 })[0], /limit 45 min: 5 15m bars, FTH_SIGNAL_MAX_AGE_BARS, at most 45 min/);
  // FTH_SIGNAL_MAX_AGE_BARS sets the count; FTH_SIGNAL_MAX_AGE_MIN, when set, caps it (never lengthens it).
  const env = e => { const c = loadConfig(e); return { signalMaxAgeBars: c.signalMaxAgeBars, signalMaxAgeCapMin: c.signalMaxAgeCapMin }; };
  assert.deepStrictEqual(ev('3m', 5, '3m', env({ FTH_SIGNAL_MAX_AGE_BARS: '2' })), []);
  assert.match(ev('3m', 7, '3m', env({ FTH_SIGNAL_MAX_AGE_BARS: '2' }))[0], /limit 6 min: 2 3m bars/);
  assert.match(ev('15m', 20, '15m', env({ FTH_SIGNAL_MAX_AGE_MIN: '10' }))[0], /limit 10 min: 3 15m bars, FTH_SIGNAL_MAX_AGE_BARS, capped at 10 min by FTH_SIGNAL_MAX_AGE_MIN/);
  assert.deepStrictEqual(ev('1m', 2, '1m', env({ FTH_SIGNAL_MAX_AGE_MIN: '60' })), [], 'a cap longer than the bars changes nothing');
  assert.match(ev('1m', 4, '1m', env({ FTH_SIGNAL_MAX_AGE_MIN: '60' }))[0], /limit 3 min/);
  // An unreadable bar count is the default, never "no limit".
  for (const bad of ['0', '-3', 'x', '2.5']) assert.match(ev('3m', 10, '3m', env({ FTH_SIGNAL_MAX_AGE_BARS: bad }))[0], /the setup has expired/, bad);
  // signalMaxAgeMin: an unknown timeframe counts as 1 minute (the strictest); a bad bar count as 1 bar.
  const { signalMaxAgeMin } = require('../../scripts/lib/trading/signal-state');
  assert.deepStrictEqual([signalMaxAgeMin('1m'), signalMaxAgeMin('3m'), signalMaxAgeMin('15m'), signalMaxAgeMin('1h'), signalMaxAgeMin('4h'), signalMaxAgeMin('5m')], [3, 9, 45, 45, 45, 15]);
  assert.strictEqual(signalMaxAgeMin('15m', { bars: 100 }), 45, 'no bar count lifts it over the ceiling');
  assert.strictEqual(signalMaxAgeMin('1h', { capMin: 60 }), 45, 'nor a cap');
  for (const bad of [0, -5, NaN, null, '60']) assert.strictEqual(signalMaxAgeMin('1h', { ceilingMin: bad }), 45, `ceiling ${bad}: the owner's 45`);
  assert.strictEqual(loadConfig({ FTH_SIGNAL_MAX_AGE_CEILING_MIN: '120', FTH_SIGNAL_MAX_AGE_BARS: '50' }).signalMaxAgeCeilingMin, 45, 'no setting lifts the ceiling');
  for (const tf of [undefined, null, '', 'tick', '3', '0m', '1d', 3]) assert.strictEqual(signalMaxAgeMin(tf), 3, String(tf));
  for (const bars of [0, -1, 2.5, NaN, null, '3']) assert.strictEqual(signalMaxAgeMin('3m', { bars }), 3, String(bars));
  assert.strictEqual(signalMaxAgeMin('15m', { capMin: 10 }), 10);
  assert.strictEqual(signalMaxAgeMin('1m', { capMin: 10 }), 3);
});

test('checkOrder: an unreadable broker config is a broker-config block, even for an exit', () => {
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const path = require('path');
  const fs = require('fs');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'brokers.json'), '{ broken');
  const r = checkOrder({ ...entryOrder({ rationale: '[exit] flatten' }), side: 'sell' }, { env: { FTH_HOME: dir }, pluginRoot: path.resolve(__dirname, '..', '..') });
  assert.strictEqual(r.allowed, false);
  assert.deepStrictEqual(r.violations.map(v => v.check), ['broker-config']);
  assert.match(r.message, /close_position still flattens/);
});

test('partial_close_position: the hook passes it (it needs the account), the gateway gates it like the other order tools; a full close is never gated', () => {
  const path = require('path');
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const { orderTool } = require('../../scripts/lib/trading/mcp-gateway');
  const r = checkOrder({ accountId: 7, contractId: CONTRACT, size: 1 }, { env: {}, pluginRoot: path.resolve(__dirname, '..', '..'), now: NOW, tool: 'partial_close_position' });
  assert.deepStrictEqual([r.allowed, r.intent], [true, 'risk-reducing']);
  const call = name => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
  assert.strictEqual(orderTool(call('mcp__broker__partial_close_position')), 'partial_close_position');
  assert.strictEqual(orderTool(call('partial_close_position')), 'partial_close_position');
  assert.strictEqual(orderTool(call('close_position')), null);
  assert.strictEqual(orderTool(call('mcp__broker__close_position')), null);
});

// --- The replay clock (trading/harness-now.js): FTH_REPLAY_NOW, honored only with a replay broker. ---

/** A plugin root whose one strategy trades MNQ at any hour, and a home whose broker ("sim") is a replay broker or not. */
function replaySetup({ replay = true, journalAt = '2026-10-07T14:25:00.000Z' } = {}) {
  const path = require('path');
  const fs = require('fs');
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'strategies', 'anytime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'strategies', 'anytime', 'STRATEGY.md'), [
    '---', 'name: anytime', 'description: Test strategy that is valid at any time of day for MNQ only.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 3m', 'signal: manual', 'risk:', '  stop: manual', '  min_rr: 1', '---',
    '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  const home = trendHome(undefined, { closedAt: '2026-10-07T14:27:00.000Z' });
  const journal = require('../helpers').writeJournal(home, [{ ts: journalAt, kind: 'plan', contractId: CONTRACT, text: 'plan' }]);
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'sim.js'], journal, allowedAccountsEnv: 'SIM_ALLOWED_ACCOUNTS', ...(replay ? { replay: true } : {}) } } }));
  recordBrokerSpecs(home, { broker: 'sim' }); // the replay broker's tick specs, as its translator records them
  const env = {
    FTH_HOME: home, NODE_ENV: 'test', FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', SIM_ALLOWED_ACCOUNTS: '1',
    FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'), FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'),
  };
  return { root, env };
}
const ANYTIME = entryOrder({ rationale: 'setup:anytime long, stop 21480, target 21540, risk $40' });

test('replay clock: with a replay broker every check runs at FTH_REPLAY_NOW, not the wall clock', () => {
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const { root, env } = replaySetup();
  const wednesday = '2026-10-07T14:30:00.000Z'; // 10:30 ET, in session; plan 5 min old, trend read 3 min old
  const saturday = '2026-10-10T15:00:00.000Z'; // market closed
  // The wall clock (the test suite's, FTH_TEST_NOW) on Saturday, the replayed time on Wednesday: allowed.
  const replayed = checkOrder(ANYTIME, { env: { ...env, FTH_TEST_NOW: saturday, FTH_REPLAY_NOW: wednesday }, pluginRoot: root });
  assert.deepStrictEqual(replayed.violations, []);
  assert.strictEqual(replayed.now.toISOString(), wednesday, 'the time the checks ran at');
  // The same order on the wall clock alone: market closed, the plan and the trend read stale.
  const live = checkOrder(ANYTIME, { env: { ...env, FTH_TEST_NOW: saturday }, pluginRoot: root });
  assert.ok(['market-hours', 'plan-required', 'mtf-trend'].every(c => live.violations.some(v => v.check === c)), live.message);
  // And the other way round: a replayed Saturday is closed whatever the wall clock says (the override never relaxes a check).
  const closed = checkOrder(ANYTIME, { env: { ...env, FTH_TEST_NOW: wednesday, FTH_REPLAY_NOW: saturday }, pluginRoot: root });
  assert.ok(closed.violations.some(v => v.check === 'market-hours'), closed.message);
  assert.deepStrictEqual(checkOrder(ANYTIME, { env: { ...env, FTH_TEST_NOW: wednesday }, pluginRoot: root }).violations, []);
});

test('replay clock: a refused FTH_REPLAY_NOW (no replay broker, unparseable) refuses entries only (unskippable, also autonomous); risk-reducing actions are judged at the wall clock', () => {
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const live = replaySetup({ replay: false });
  const sim = replaySetup();
  const wall = '2026-10-07T14:30:00.000Z';
  const riskReducing = [
    ['place_order', { ...entryOrder({ rationale: '[exit] flatten' }), side: 'sell' }],
    ['place_order', { ...entryOrder({ rationale: '[protect] stop for the long at 21480' }), side: 'sell', type: 'stop', stopPrice: 21480 }],
    ['modify_order', { accountId: 1, orderId: 9, stopPrice: 21490, reason: '[protect] tighten' }],
    ['cancel_order', { accountId: 1, orderId: 9 }],
    ['partial_close_position', { accountId: 1, contractId: CONTRACT, size: 1 }],
  ];
  const envs = [
    [live, { FTH_REPLAY_NOW: '2026-10-08T14:30:00Z' }, /"sim" is not a replay broker/],
    [live, { FTH_REPLAY_NOW: '2026-10-08T14:30:00Z', FTH_AUTONOMOUS: '1' }, /not a replay broker/],
    [live, { FTH_REPLAY_NOW: '2026-10-08T14:30:00Z', FTH_ORDER_GATE_SKIP: 'replay-clock,market-hours,plan-required' }, /not a replay broker/],
    [sim, { FTH_REPLAY_NOW: 'yesterday' }, /not an ISO 8601 UTC time/],
  ];
  for (const [s, extra, why] of envs) {
    const env = { ...s.env, FTH_TEST_NOW: wall, ...extra };
    // Even with a time passed in (as a replay worker may): the entry is refused first.
    for (const now of [undefined, NOW]) {
      const r = checkOrder(ANYTIME, { env, pluginRoot: s.root, now });
      assert.strictEqual(r.allowed, false, JSON.stringify(extra));
      assert.deepStrictEqual(r.violations.map(v => v.check), ['replay-clock']);
      assert.match(r.message, why);
      assert.match(r.message, /close_position still go/);
    }
    for (const [tool, input] of riskReducing) {
      const r = checkOrder(input, { env, pluginRoot: s.root, tool });
      assert.deepStrictEqual(r.violations, [], `${tool} ${input.rationale || input.reason || ''} ${JSON.stringify(extra)}`);
      if (extra.FTH_AUTONOMOUS !== '1') assert.ok(Math.abs(r.now.getTime() - Date.parse(wall)) < 60000, 'judged at the wall clock (the suite\'s), not the refused replay time');
    }
  }
  // Control: the same entry without the override is judged normally.
  assert.deepStrictEqual(checkOrder(ANYTIME, { env: { ...live.env, FTH_TEST_NOW: wall }, pluginRoot: live.root }).violations, []);
});

test('allowed accounts: a live entry needs the broker\'s allow-list holding its account (unskippable, also autonomous); paper, a confirmed replay and every risk-reducing action are exempt', () => {
  const fs = require('fs');
  const path = require('path');
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const live = replaySetup({ replay: false });
  const wall = '2026-10-07T14:30:00.000Z';
  const at = extra => ({ ...live.env, FTH_TEST_NOW: wall, ...extra });
  const refused = (env, why, input = ANYTIME) => {
    const r = checkOrder(input, { env, pluginRoot: live.root });
    assert.deepStrictEqual(r.violations.map(v => v.check), ['allowed-accounts'], r.message);
    assert.match(r.message, why);
    assert.match(r.message, /close_position still go/);
  };
  refused(at({ SIM_ALLOWED_ACCOUNTS: '' }), /SIM_ALLOWED_ACCOUNTS is empty/);
  refused(at({ SIM_ALLOWED_ACCOUNTS: 'any' }), /never empty or "any"/);
  refused(at({ SIM_ALLOWED_ACCOUNTS: '2,3' }), /account 1 is not in SIM_ALLOWED_ACCOUNTS \(2, 3\)/);
  // No account id: refused by the allow-list and by the lock check (whether a runner trades it can't be told).
  const noId = checkOrder({ ...ANYTIME, accountId: undefined }, { env: at({}), pluginRoot: live.root });
  assert.deepStrictEqual(noId.violations.map(v => v.check), ['allowed-accounts', 'account-lock'], noId.message);
  assert.match(noId.message, /names no valid accountId/);
  // Not skippable, autonomous or not (an autonomous run adds its own checks; this one is among them).
  for (const extra of [{ FTH_ORDER_GATE_SKIP: 'allowed-accounts' }, { FTH_AUTONOMOUS: '1', FTH_ORDER_GATE_SKIP: 'allowed-accounts' }]) {
    assert.ok(checkOrder(ANYTIME, { env: at({ SIM_ALLOWED_ACCOUNTS: '', ...extra }), pluginRoot: live.root }).violations.some(v => v.check === 'allowed-accounts'), JSON.stringify(extra));
  }
  // Every risk-reducing action goes with no allow-list at all.
  for (const [tool, input] of [
    ['place_order', { ...entryOrder({ rationale: '[exit] flatten' }), side: 'sell' }],
    ['place_order', { ...entryOrder({ rationale: '[protect] stop for the long at 21480' }), side: 'sell', type: 'stop', stopPrice: 21480 }],
    ['modify_order', { accountId: 1, orderId: 9, stopPrice: 21490, reason: '[protect] tighten' }],
    ['cancel_order', { accountId: 1, orderId: 9 }],
    ['partial_close_position', { accountId: 1, contractId: CONTRACT, size: 1 }],
  ]) assert.deepStrictEqual(checkOrder(input, { env: at({ SIM_ALLOWED_ACCOUNTS: '' }), pluginRoot: live.root, tool }).violations, [], tool);
  // A broker that names no allow-list variable: live entries refused.
  const file = path.join(live.env.FTH_HOME, 'brokers.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { allowedAccountsEnv: _a, ...bare } = cfg.brokers.sim;
  fs.writeFileSync(file, JSON.stringify({ ...cfg, brokers: { sim: { ...bare, paperEnv: { SIM_TRADING: 'off' } } } }));
  refused(at({}), /names no allow-list variable/);
  // A paper run (the broker's paper settings in force: the server refuses every order anyway).
  assert.deepStrictEqual(checkOrder(ANYTIME, { env: at({ SIM_TRADING: 'off' }), pluginRoot: live.root }).violations, []);
  // A confirmed replay (a replay broker on its replayed clock) needs none.
  const sim = replaySetup();
  assert.deepStrictEqual(checkOrder(ANYTIME, { env: { ...sim.env, SIM_ALLOWED_ACCOUNTS: '', FTH_TEST_NOW: '2026-10-10T15:00:00Z', FTH_REPLAY_NOW: wall }, pluginRoot: sim.root }).violations, []);
  // ...but the replay broker without its clock is judged as live.
  const r = checkOrder(ANYTIME, { env: { ...sim.env, SIM_ALLOWED_ACCOUNTS: '', FTH_TEST_NOW: wall }, pluginRoot: sim.root });
  assert.deepStrictEqual(r.violations.map(v => v.check), ['allowed-accounts']);
  // Control: listed, the entry goes.
  fs.writeFileSync(file, JSON.stringify(cfg));
  assert.deepStrictEqual(checkOrder(ANYTIME, { env: at({ SIM_ALLOWED_ACCOUNTS: '9, 1' }), pluginRoot: live.root }).violations, []);
});

test('replay clock: a broker labelled replay that looks live is refused (same server, entry variable, or a live broker\'s variables)', () => {
  const path = require('path');
  const fs = require('fs');
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const { root, env } = replaySetup();
  const file = path.join(env.FTH_HOME, 'brokers.json');
  const base = JSON.parse(fs.readFileSync(file, 'utf8')).brokers.sim;
  const withSim = (sim, others = {}) => fs.writeFileSync(file, JSON.stringify({ broker: 'sim', brokers: { ...others, sim: { ...base, ...sim } } }));
  const at = { ...env, FTH_TEST_NOW: '2026-10-10T15:00:00Z', FTH_REPLAY_NOW: '2026-10-07T14:30:00Z' };
  const refused = (why, extraEnv = {}) => {
    const r = checkOrder(ANYTIME, { env: { ...at, ...extraEnv }, pluginRoot: root });
    assert.deepStrictEqual(r.violations.map(v => v.check), ['replay-clock'], r.message);
    assert.match(r.message, why);
  };
  // A live broker of the user's (the tests' fake one: its server from FAKE_BROKER_ENTRY).
  const fake = { fake: JSON.parse(fs.readFileSync(FAKE_BROKERS, 'utf8')).brokers.fake };
  withSim({ command: ['node', '/srv/broker-mcp/dist/index.js'] }, { mylive: { command: ['node', '/srv/broker-mcp/dist/index.js'] } });
  refused(/looks live: it starts the same server as the live broker "mylive"/);
  withSim({ command: ['/usr/bin/node', '/srv/broker-mcp/dist/index.js'] }, fake);
  refused(/looks live: it starts the same server \(.*index\.js\) as the live broker "fake"/, { FAKE_BROKER_ENTRY: '/srv/broker-mcp/dist/index.js' });
  withSim({ command: null, entryEnv: 'FAKE_BROKER_ENTRY' }, fake);
  refused(/takes its server from FAKE_BROKER_ENTRY, as the live broker "fake" does/); // (set, it resolves to the same server: above)
  // A variable of the live broker the repo ships (read from mcp-configs/brokers.json, never named here).
  const shipped = shippedBroker();
  const literal = text => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  withSim({ env: ['SIM_SPEED', shipped.env[0]] });
  refused(literal(`reads the live broker "${shipped.name}"'s variables (${shipped.env[0]})`));
  withSim({ journalEnv: shipped.journalEnv });
  refused(literal(`variables (${shipped.journalEnv})`));
  // Control: a replay broker of its own is honored.
  withSim({ env: ['SIM_SPEED'] });
  assert.deepStrictEqual(checkOrder(ANYTIME, { env: at, pluginRoot: root }).violations, []);
});

test('skills-loaded: a parts-format (Qwen Code chat) transcript with the skills loaded passes; a failed load is refused', () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(require('../helpers').tmpDir(), 'chats', 'session.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const call = (id, skill) => JSON.stringify({ type: 'assistant', message: { role: 'model', parts: [{ functionCall: { id, name: 'skill', args: { skill: `futures-trading-harness:${skill}` } } }] } });
  const answer = (id, response) => JSON.stringify({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id, name: 'skill', response } }] } });
  const lines = ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].flatMap((s, i) => [call(`c${i}`, s), answer(`c${i}`, { output: `# ${s}` })]);
  const run = input => evaluateOrder({ input, entries: [plan()], now: NOW, config, transcriptPath: file });
  fs.writeFileSync(file, lines.join('\n'));
  assert.deepStrictEqual(run(entryOrder()).violations, []);
  fs.writeFileSync(file, [...lines.slice(0, 4), ...lines.slice(6), call('c2', 'strategy-library'), answer('c2', { error: 'Skill "strategy-library" not found.' })].join('\n'));
  const r = run(entryOrder());
  assert.deepStrictEqual(checks(r), ['skills-loaded']);
  assert.match(r.violations[0].message, /not loaded in this session: strategy-library\./);
  // A risk-reducing order is never held back by it.
  assert.deepStrictEqual(run(entryOrder({ rationale: '[exit] flatten' })).violations, []);
});

test('skills-loaded: strategy-library was split; an entry needs each piece (strategy-library, strategy-scan, strategy-gate-checks) as it needed the one skill', () => {
  const fs = require('fs');
  const path = require('path');
  const { REQUIRED_FOR_ENTRY, REQUIRED_AT_ENTRY: AT_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  assert.deepStrictEqual(REQUIRED_FOR_ENTRY, ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks']);
  const file = path.join(require('../helpers').tmpDir(), 'session.jsonl');
  const load = s => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: s } }] } });
  const run = input => evaluateOrder({ input, entries: [plan()], now: NOW, config, transcriptPath: file });
  fs.writeFileSync(file, [...REQUIRED_FOR_ENTRY, ...AT_ENTRY].map(load).join('\n'));
  assert.deepStrictEqual(run(entryOrder()).violations, [], 'the full set passes');
  for (const missing of REQUIRED_FOR_ENTRY) {
    fs.writeFileSync(file, [...REQUIRED_FOR_ENTRY, ...AT_ENTRY].filter(s => s !== missing).map(load).join('\n'));
    const r = run(entryOrder());
    assert.deepStrictEqual(checks(r), ['skills-loaded'], missing);
    assert.match(r.violations[0].message, new RegExp(`not loaded in this session: ${missing}\\.`), missing);
    // Exits and protective orders are never held back by it.
    assert.deepStrictEqual(run(entryOrder({ rationale: '[exit] flatten' })).violations, [], `${missing}: exit`);
  }
  // The set before the split (strategy-library alone) no longer passes: the scan and gate-check text left it.
  fs.writeFileSync(file, ['trade-session', 'multi-timeframe-analysis', 'strategy-library'].map(load).join('\n'));
  assert.match(run(entryOrder()).violations[0].message, /not loaded in this session: strategy-scan, strategy-gate-checks\./);
});

// --- REQUIRED_AT_ENTRY: setup-judgment and trade-plan read before an entry (skills-loaded.js checkSkillsAtEntry). ---

test('skills-at-entry: an entry needs setup-judgment and trade-plan read in the session; any harness transcript; exits, stops, stop moves, cuts and cancels never held', () => {
  const fs = require('fs');
  const path = require('path');
  const { REQUIRED_FOR_ENTRY, REQUIRED_AT_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  assert.deepStrictEqual(REQUIRED_AT_ENTRY, ['setup-judgment', 'trade-plan']);
  const dir = require('../helpers').tmpDir();
  const file = path.join(dir, 'session.jsonl');
  const claude = s => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: s } }] } });
  const run = (input, over = {}) => evaluateOrder({ input, entries: [plan()], now: NOW, config: { ...config, ...over }, transcriptPath: file });
  const RISK_REDUCING = ['[exit] flatten', '[protect] stop for the long at 21480', '[exit] cut size to 1', '[exit] partial close 1 of 2'];
  // Each missing one refuses, named; the full set passes.
  for (const missing of REQUIRED_AT_ENTRY) {
    fs.writeFileSync(file, [...REQUIRED_FOR_ENTRY, ...REQUIRED_AT_ENTRY.filter(s => s !== missing)].map(claude).join('\n'));
    const r = run(entryOrder());
    assert.deepStrictEqual(checks(r), ['skills-at-entry'], missing);
    assert.match(r.violations[0].message, new RegExp(`not read in this session: ${missing}\\.`));
    for (const rationale of RISK_REDUCING) assert.deepStrictEqual(run(entryOrder({ rationale })).violations, [], `${missing}: ${rationale}`);
  }
  fs.writeFileSync(file, REQUIRED_FOR_ENTRY.map(claude).join('\n'));
  assert.match(run(entryOrder()).violations[0].message, /not read in this session: setup-judgment, trade-plan\./);
  fs.writeFileSync(file, [...REQUIRED_FOR_ENTRY, ...REQUIRED_AT_ENTRY].map(claude).join('\n'));
  assert.deepStrictEqual(run(entryOrder()).violations, []);
  // Full and index mode alike (an interactive session; the autonomous index-mode path is the gateway test below).
  assert.deepStrictEqual(run(entryOrder(), { roleSkills: 'index' }).violations, []);
  fs.writeFileSync(file, REQUIRED_FOR_ENTRY.map(claude).join('\n'));
  assert.deepStrictEqual(checks(run(entryOrder(), { roleSkills: 'index' })), ['skills-at-entry']);
  // opencode: a skill tool load or, in index mode, a skill_lookup that returned the skill counts; a refused lookup doesn't.
  const oc = (tool, input, output = 'ok') => JSON.stringify({ type: 'tool_use', part: { tool, state: { status: 'completed', input, output } } });
  const base = REQUIRED_FOR_ENTRY.map(name => oc('skill', { name }));
  fs.writeFileSync(file, [...base, oc('skill', { name: 'setup-judgment' }), oc('harness_skill_lookup', { skill: 'trade-plan' }, '<skill name="trade-plan">...')].join('\n'));
  assert.deepStrictEqual(run(entryOrder()).violations, []);
  fs.writeFileSync(file, [...base, oc('skill', { name: 'setup-judgment' }), oc('harness_skill_lookup', { skill: 'trade-plan' }, 'Unknown skill "trade-plan"')].join('\n'));
  assert.match(run(entryOrder()).violations[0].message, /not read in this session: trade-plan\./);
  // Qwen Code's parts format: an errored load doesn't count.
  const call = (id, s) => JSON.stringify({ type: 'assistant', message: { role: 'model', parts: [{ functionCall: { id, name: 'skill', args: { skill: s } } }] } });
  const answer = (id, response) => JSON.stringify({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id, name: 'skill', response } }] } });
  const all = [...REQUIRED_FOR_ENTRY, ...REQUIRED_AT_ENTRY];
  fs.writeFileSync(file, all.flatMap((s, i) => [call(`c${i}`, s), answer(`c${i}`, s === 'setup-judgment' ? { error: 'not found' } : { output: `# ${s}` })]).join('\n'));
  assert.match(run(entryOrder()).violations[0].message, /not read in this session: setup-judgment\./);
  // Fails closed: a transcript named but unreadable refuses the entry (not an exit); no transcript at all (a harness
  // that passes none, as for REQUIRED_FOR_ENTRY): not applied.
  const gone = evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config, transcriptPath: path.join(dir, 'gone.jsonl') });
  assert.deepStrictEqual(checks(gone), ['skills-at-entry']);
  assert.match(gone.violations[0].message, /transcript can't be read/);
  assert.deepStrictEqual(evaluateOrder({ input: entryOrder({ rationale: '[exit] flatten' }), entries: [plan()], now: NOW, config, transcriptPath: path.join(dir, 'gone.jsonl') }).violations, []);
  assert.deepStrictEqual(evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config }).violations, []);
  // An autonomous run can't skip it (FTH_ORDER_GATE_SKIP is ignored there); interactively it is a named, skippable check.
  assert.strictEqual(loadConfig({ FTH_AUTONOMOUS: '1', FTH_ORDER_GATE_SKIP: 'skills-at-entry' }).skipChecks.has('skills-at-entry'), false);
});

test('skills-at-entry: the gateway (checkOrder, the runner\'s cycle transcript) refuses an entry without them, in index mode too; a cancel or a partial close is never gated', () => {
  const fs = require('fs');
  const path = require('path');
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const { REQUIRED_FOR_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  const dir = require('../helpers').tmpDir();
  const file = path.join(dir, 'cycle-transcript.jsonl');
  const oc = name => JSON.stringify({ type: 'tool_use', part: { tool: 'skill', state: { status: 'completed', input: { name } } } });
  const root = path.resolve(__dirname, '..', '..');
  const has = (r, check) => r.violations.some(v => v.check === check);
  for (const mode of ['index', 'full']) {
    const env = { FTH_HOME: dir, FTH_CYCLE_TRANSCRIPT: file, FTH_ROLE_SKILLS: mode };
    fs.writeFileSync(file, REQUIRED_FOR_ENTRY.map(oc).join('\n'));
    const r = checkOrder(entryOrder(), { env, pluginRoot: root, now: NOW });
    assert.strictEqual(r.allowed, false, mode);
    assert.ok(has(r, 'skills-at-entry'), `${mode}: ${r.message}`);
    assert.match(r.message, /\[skills-at-entry\] [^\n]*not read in this session: setup-judgment, trade-plan\./);
    fs.writeFileSync(file, [...REQUIRED_FOR_ENTRY, 'setup-judgment', 'trade-plan'].map(oc).join('\n'));
    assert.ok(!has(checkOrder(entryOrder(), { env, pluginRoot: root, now: NOW }), 'skills-at-entry'), mode);
    fs.writeFileSync(file, '');
    for (const tool of ['cancel_order', 'partial_close_position']) assert.strictEqual(checkOrder({ accountId: 7, contractId: CONTRACT, size: 1 }, { env, pluginRoot: root, now: NOW, tool }).allowed, true, tool);
  }
});

// --- Tick specs: the broker's, as the translator recorded them (broker-specs.js). ---
const { evaluateModify } = require('../../scripts/lib/trading/order-gate');

test('contract-specs: an entry with no tick specs from the broker is refused (hard, unskippable); exits, protective orders and stop moves never need them', () => {
  const bare = { ...config, home: trendHome(undefined, { specs: false }) };
  recordBrokerSpecs(bare.home, { roots: [], server: {} }); // the server's limits, no specs
  const r = evaluate(entryOrder(), [plan()], { config: bare });
  assert.deepStrictEqual(checks(r), ['contract-specs']);
  assert.strictEqual(r.violations[0].message, 'no tick specs from the broker for MNQ yet: call get_contract or search_contracts for MNQ first (the harness records the broker\'s tick size and value), then try again.');
  // No setting turns it off.
  const skipping = { ...bare, skipChecks: new Set(['contract-specs', 'order-consistency', 'plan-required', 'strategy']) };
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan()], { config: skipping })), ['contract-specs']);
  // Risk-reducing orders go through whatever the specs.
  for (const rationale of ['[exit] flatten the long', '[protect] stop for the long at 21480']) {
    const o = evaluate(entryOrder({ rationale, side: 'sell', type: 'stop', stopPrice: 21480.1 }), [], { config: bare });
    assert.deepStrictEqual([o.intent, o.violations], ['risk-reducing', []], rationale);
  }
  assert.deepStrictEqual(evaluateModify({ input: { orderId: 9, stopPrice: 21490, reason: '[protect] tighten' }, config: bare }).violations, []);
  // Another root's spec, a malformed one, a broker without a file: still none for MNQ.
  recordBrokerSpecs(bare.home, { roots: ['MES'] });
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan()], { config: bare })), ['contract-specs']);
  recordBrokerSpecs(bare.home, { roots: ['MNQ'], specs: { MNQ: { tickValue: 0 } } });
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan()], { config: bare })), ['contract-specs']);
  recordBrokerSpecs(bare.home, { roots: ['MNQ'], specs: { MNQ: { tickSize: -0.25, tickValue: 0.5 } } });
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan()], { config: bare })), ['contract-specs']);
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan()], { config: { ...bare, contractsFile: null } })), ['contract-specs', 'max-order-size'], 'no broker configured');
  // Recorded: allowed.
  recordBrokerSpecs(bare.home, { roots: ['MNQ'] });
  assert.deepStrictEqual(evaluate(entryOrder(), [plan()], { config: bare }).violations, []);
  // An id nothing names (no root) has no specs either.
  assert.ok(checks(evaluate(entryOrder({ contractId: 'fake:ZZZ:Z26' }), [plan()], { config: bare })).includes('contract-specs'));
});

test('contract-specs: prices are checked on the broker\'s tick, not the static table\'s', () => {
  const home = trendHome(undefined, { specs: false });
  const cfg = { ...config, home };
  // 21500.1 to 21480.1 is 200 ticks on a 0.1 tick.
  const limit = entryOrder({ type: 'limit', limitPrice: 21500.1, stopLossBracket: { ticks: 200, type: 'stop' }, rationale: 'setup:orb long, stop 21480.1, target 21540.1' });
  recordBrokerSpecs(home, { roots: ['MNQ'] }); // 0.25: 21500.1 is off the tick
  assert.match(evaluate(limit, [plan()], { config: cfg }).violations.find(v => v.check === 'order-consistency').message, /limitPrice 21500\.1 is not on the 0\.25 tick/);
  // A broker that says 0.1 (unlike the table): not trusted either way; the entry is refused.
  recordBrokerSpecs(home, { roots: ['MNQ'], specs: { MNQ: { tickSize: 0.1 } } });
  assert.match(evaluate(limit, [plan()], { config: cfg }).violations.find(v => v.check === 'contract-specs').message, /^MNQ: the broker's tick spec \(0\.1 = \$0\.50\) differs from the static table .*no entries on it until they agree\.$/);
  // A root the table lacks: the broker's spec is the only one, and its tick is the one checked.
  recordBrokerSpecs(home, { roots: [], specs: { ZZ: { tickSize: 0.1, tickValue: 1 } } });
  const zz = { ...limit, contractId: 'ZZ' };
  assert.deepStrictEqual(evaluate(zz, [plan(10, { contractId: 'ZZ' })], { config: cfg }).violations, []);
  assert.match(evaluate({ ...zz, limitPrice: 21500.15 }, [plan(10, { contractId: 'ZZ' })], { config: cfg }).violations.find(v => v.check === 'order-consistency').message, /limitPrice 21500\.15 is not on the 0\.1 tick/);
});

test('contract-specs: a prop entry is sized in dollars with the broker\'s tick value (MNQ vs NQ: same ticks, 10x the dollars)', () => {
  const ACCT = { ...MINI, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } };
  const run = (contractId, size, home, contracts = contractId === 'NQ' ? 'mini' : 'micro') => evaluateOrder({
    input: entryOrder({ contractId, size }), entries: [plan(10, { contractId })], now: NOW, config: { ...config, home, skipChecks: new Set(['strategy']) },
    strategies: [propStrategy({ contracts }), EMA_CROSS], accounts: [ACCT],
  }).violations.filter(v => v.check === 'combine');
  const setupHome = specs => {
    const home = trendHome(undefined, { specs: false });
    if (specs) recordBrokerSpecs(home, specs);
    prop.startAttempt(home, ACCT, new Date(NOW.getTime() - 86400000));
    prop.snapshot(home, ACCT, 50000, new Date(NOW.getTime() - 60000));
    return home;
  };
  // Budget $400 (0.2 x $2,000). 40 ticks plus a tick of slippage: MNQ $20.50 + $0.74 = $21.24 (18 micros);
  // NQ $205 + $2.80 = $207.80 (1 mini).
  const both = setupHome({ roots: ['MNQ', 'NQ'] });
  assert.deepStrictEqual(run('MNQ', 18, both), []);
  assert.match(run('MNQ', 19, both)[0].message, /19 MNQ is not within the account's size budget for a 40-tick stop \(18 MNQ at \$21\.24/);
  assert.deepStrictEqual(run('NQ', 1, both), []);
  assert.match(run('NQ', 2, both)[0].message, /2 NQ is not within the account's size budget for a 40-tick stop \(1 NQ at \$207\.80/);
  // A broker that says NQ ticks are worth $0.50 (a units mix-up; the table: $5) would size 17 NQ ($400 / $23.30, $3,532.60 of real risk):
  // unlike the table, so the entry is refused (fail closed), the gate's own check as well as the budget's.
  const cheap = setupHome({ roots: ['MNQ', 'NQ'], specs: { NQ: { tickValue: 0.5 } } });
  const refused = evaluateOrder({ input: entryOrder({ contractId: 'NQ', size: 19 }), entries: [plan(10, { contractId: 'NQ' })], now: NOW, config: { ...config, home: cheap, skipChecks: new Set(['strategy']) }, strategies: [propStrategy({ contracts: 'mini' }), EMA_CROSS], accounts: [ACCT] }).violations;
  assert.ok(['combine', 'contract-specs'].every(c => refused.some(v => v.check === c)), JSON.stringify(refused));
  assert.match(refused.find(v => v.check === 'contract-specs').message, /^NQ: the broker's tick spec \(0\.25 = \$0\.50\) differs from the static table/);
  assert.match(run('MNQ', 1, cheap)[0].message, /mini: NQ: the broker's tick spec .*no entries on it until they agree/, 'a micro entry whose budget may size into NQ too');
  // The family's other contract without specs: the budget can't be worked out, so the entry is refused, saying which.
  const half = setupHome({ roots: ['MNQ'] });
  assert.match(run('MNQ', 1, half)[0].message, /mini: no tick specs from the broker for NQ yet: call get_contract or search_contracts for NQ first/);
});

// --- Size and dollar-risk caps on entries (order-limits.js): the broker's maxOrderSize and the strategy's risk.max_risk_usd. ---
const limitsHome = (server = { maxOrderSize: 5 }) => {
  const home = trendHome();
  recordBrokerSpecs(home, { server });
  return home;
};
// A manual strategy tagged setup:orb (no trigger record needed) with a per-trade cap.
const capped = (cap, extra = {}) => ({ name: 'orb', valid: true, errors: [], status: 'active', instruments: ['MNQ', 'NQ'], signal: 'manual', compiledRules: null, risk: { stop: 'manual', min_rr: 2, max_risk_usd: cap }, ...extra });
const ALL_SKIPPED = new Set(['strategy', 'order-consistency', 'plan-required', 'stop-defined', 'setup-tag', 'time-window', 'blackout', 'skills-loaded', 'max-order-size', 'max-risk']);
const RISK_REDUCING_ORDERS = [
  { rationale: '[exit] flatten the 27', side: 'sell', type: 'market', size: 27 },
  { rationale: '[exit] scale out at the target', side: 'sell', type: 'limit', limitPrice: 21540, size: 27 },
  { rationale: '[protect] stop for the 27-lot long at 21480', side: 'sell', type: 'stop', stopPrice: 21480, size: 27 },
];

test('max-order-size: an entry over the broker\'s max order size is refused (hard, unskippable); at or under it passes', () => {
  const cfg = { ...config, home: limitsHome() };
  assert.deepStrictEqual(evaluate(entryOrder({ size: 5 }), [plan()], { config: cfg }).violations, []);
  const r = evaluate(entryOrder({ size: 27 }), [plan()], { config: cfg });
  assert.deepStrictEqual(checks(r), ['max-order-size']);
  assert.strictEqual(r.violations[0].message, 'size 27 over the broker\'s max order size 5 (get_server_config maxOrderSize): reduce the size to 5 or less. Never split an entry into several orders to get under it.');
  assert.deepStrictEqual(checks(evaluate(entryOrder({ size: 6 }), [plan()], { config: { ...cfg, skipChecks: ALL_SKIPPED } })), ['max-order-size'], 'no setting turns it off');
  // A size that is no whole number of contracts.
  for (const size of [0, 1.5, -2, 'lots', undefined]) {
    assert.match(evaluate(entryOrder({ size }), [plan()], { config: cfg }).violations.find(v => v.check === 'max-order-size').message, /is not a whole number of contracts/, String(size));
  }
});

test('max-order-size: no max order size recorded from the broker (or an invalid one) refuses an entry, saying to call get_server_config', () => {
  const home = trendHome(undefined, { specs: false });
  recordBrokerSpecs(home, { server: false }); // specs, no get_server_config answer yet
  const cfg = { ...config, home };
  const r = evaluate(entryOrder(), [plan()], { config: cfg });
  assert.deepStrictEqual(checks(r), ['max-order-size']);
  assert.strictEqual(r.violations[0].message, 'the broker server\'s max order size is not recorded yet: call get_server_config (the harness records its maxOrderSize), then try again.');
  recordBrokerSpecs(home, { server: { maxOrderSize: null } });
  assert.match(evaluate(entryOrder(), [plan()], { config: cfg }).violations[0].message, /last get_server_config answer had no valid maxOrderSize/);
  recordBrokerSpecs(home, { server: { maxOrderSize: 1 } });
  assert.deepStrictEqual(evaluate(entryOrder(), [plan()], { config: cfg }).violations, []);
  assert.deepStrictEqual(checks(evaluate(entryOrder({ size: 2 }), [plan()], { config: cfg })), ['max-order-size']);
});

test('max-risk: an entry over its strategy\'s risk.max_risk_usd is refused with the fix (hard, unskippable); within it passes', () => {
  const cfg = { ...config, home: limitsHome({ maxOrderSize: 50 }), skipChecks: new Set(['strategy']) };
  const run = (input, cap = 50, c = cfg) => evaluateOrder({ input, entries: [plan(10, { contractId: input.contractId })], now: NOW, config: c, strategies: [capped(cap)] });
  // MNQ, 40-tick bracket: $20 a contract.
  assert.deepStrictEqual(run(entryOrder({ size: 2 })).violations, []);
  const over = run(entryOrder({ size: 3 }));
  assert.deepStrictEqual(checks(over), ['max-risk']);
  assert.strictEqual(over.violations[0].message, 'risk $60.00 (size 3 x 40-tick stop x $0.50 a tick on MNQ) over setup:orb\'s risk.max_risk_usd $50.00: reduce the size to 2 or less, or tighten to a stop of at most 33 ticks at size 3 (use order_plan: it gives the strategy\'s own stop, which is never moved just to fit).');
  assert.deepStrictEqual(checks(run(entryOrder({ size: 3 }), 50, { ...cfg, skipChecks: ALL_SKIPPED })), ['max-risk'], 'no setting turns it off');
  // NQ: the same 40 ticks are $200 a contract.
  assert.match(run(entryOrder({ contractId: 'NQ', size: 1 })).violations.find(v => v.check === 'max-risk').message, /^risk \$200\.00 \(size 1 x 40-tick stop x \$5\.00 a tick on NQ\).*no size fits at a 40-tick stop/);
  assert.deepStrictEqual(run(entryOrder({ contractId: 'NQ', size: 1 }), 200).violations, []);
  // No cap: no dollar check (the size check still holds).
  const uncapped = { ...capped(50), risk: { stop: 'manual', min_rr: 2 } };
  assert.deepStrictEqual(evaluateOrder({ input: entryOrder({ size: 50 }), entries: [plan()], now: NOW, config: cfg, strategies: [uncapped] }).violations, []);
});

test('max-risk: the stop only in the rationale - measured from a limit entry\'s price; a market entry\'s is not computable (refused)', () => {
  // max-risk alone: stop-defined, which refuses every one of these unbracketed entries, is skipped here.
  const cfg = { ...config, home: limitsHome({ maxOrderSize: 50 }), skipChecks: new Set(['strategy', 'stop-defined']) };
  const run = (input, cap) => evaluateOrder({ input, entries: [plan()], now: NOW, config: cfg, strategies: [capped(cap)] }).violations;
  // Buy limit 21500, stop 21480: 80 ticks = $40 a contract.
  const limit = entryOrder({ type: 'limit', limitPrice: 21500, stopLossBracket: undefined, rationale: 'setup:orb long at 21500, stop 21480, target 21540' });
  assert.deepStrictEqual(run(limit, 40), []);
  assert.match(run({ ...limit, size: 2 }, 40).find(v => v.check === 'max-risk').message, /^risk \$80\.00 \(size 2 x 80-tick stop/);
  // A stop entry whose rationale names its own price as "buy stop" first: the real stop is measured.
  const stopEntry = entryOrder({ type: 'stop', stopPrice: 21520, stopLossBracket: undefined, rationale: 'setup:orb long, buy stop 21510 over the high, stop 21480, target 21600' });
  assert.match(run(stopEntry, 30).find(v => v.check === 'max-risk').message, /^risk \$80\.00 \(size 1 x 160-tick stop/);
  // The replayed 27-lot: market, no bracket, the stop only in the rationale.
  const replayed = entryOrder({ size: 27, stopLossBracket: undefined, rationale: 'setup:orb long, stop 21480, target 21540' });
  const v = run(replayed, 50);
  assert.deepStrictEqual(v.map(x => x.check).sort(), ['max-risk']);
  assert.match(v[0].message, /^setup:orb caps risk at \$50\.00 \(risk\.max_risk_usd\) but this entry's risk can't be computed: a market entry with its stop only in the rationale .*add stopLossBracket\.ticks/);
});

test('max-risk: with a cap, unknown tick specs or an unmeasurable stop refuse the entry (fail closed)', () => {
  const home = trendHome(undefined, { specs: false });
  recordBrokerSpecs(home, { roots: [], server: {} });
  const run = (input, h = home) => evaluateOrder({ input, entries: [plan()], now: NOW, config: { ...config, home: h, skipChecks: new Set(['strategy']) }, strategies: [capped(50)] }).violations;
  const noSpecs = run(entryOrder());
  assert.deepStrictEqual(noSpecs.map(x => x.check).sort(), ['contract-specs', 'max-risk']);
  assert.match(noSpecs.find(x => x.check === 'max-risk').message, /can't be computed: no usable tick specs from the broker for MNQ/);
  // A table/broker mismatch is no usable spec either.
  recordBrokerSpecs(home, { roots: ['MNQ'], specs: { MNQ: { tickValue: 0.05 } } });
  assert.ok(run(entryOrder()).some(x => x.check === 'max-risk'));
  const ok = limitsHome({ maxOrderSize: 50 });
  assert.match(run(entryOrder({ stopLossBracket: { ticks: 2.5, type: 'stop' } }), ok).find(x => x.check === 'max-risk').message, /stopLossBracket\.ticks 2\.5 is not a whole number/);
  assert.match(run(entryOrder({ stopLossBracket: undefined, rationale: 'setup:orb long, no stop yet' }), ok).find(x => x.check === 'max-risk').message, /no stop to measure its risk from/);
  // A malformed cap (a strategy the registry marks invalid, its check skipped): refused, never read as no cap.
  const bad = evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...config, home: ok, skipChecks: new Set(['strategy']) }, strategies: [capped('50', { valid: false })] }).violations;
  assert.match(bad.find(x => x.check === 'max-risk').message, /risk\.max_risk_usd \("50"\) is not a positive number/);
});

test('max-order-size and max-risk: exits, protective orders and stop moves are never refused, whatever their size or risk', () => {
  // A home with a max order size of 1 and a $5 cap, and one with nothing recorded at all.
  for (const home of [limitsHome({ maxOrderSize: 1 }), trendHome(undefined, { specs: false })]) {
    for (const o of RISK_REDUCING_ORDERS) {
      const input = entryOrder({ ...o, stopLossBracket: undefined });
      const r = evaluateOrder({ input, entries: [], now: NOW, config: { ...config, home }, strategies: [capped(5)] });
      assert.deepStrictEqual([r.intent, r.violations], ['risk-reducing', []], o.rationale);
    }
    assert.deepStrictEqual(evaluateModify({ input: { orderId: 9, stopPrice: 21470, reason: '[protect] trail' }, config: { ...config, home } }).violations, []);
    assert.deepStrictEqual(evaluateModify({ input: { orderId: 9, size: 1, reason: '[protect] cut after a partial exit' }, config: { ...config, home } }).violations, []);
  }
});

test('max-risk: a policy strategy\'s entry is checked against its own cap, not its components\' (prop sizing sizes it)', () => {
  // The mini account at $50,000: budget $400; 18 micros at a 40-tick stop ($21.24 each, a tick of slippage counted) fit it.
  const acct = { ...MINI, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 } };
  const run = policyRisk => {
    const home = limitsHome({ maxOrderSize: 50 });
    prop.startAttempt(home, acct, new Date(NOW.getTime() - 86400000));
    prop.snapshot(home, acct, 50000, new Date(NOW.getTime() - 60000));
    prop.appendVerdict(home, { bar: BAR, strategy: 'orb', component: 'ema_cross', contractId: CONTRACT, contract: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 40, maxSize: 18, at: new Date(NOW.getTime() - 30000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
    // The component caps a trade at $20; 18 micros risk $360 at the stop.
    const component = { ...capped(20), name: 'ema_cross', signal: 'rules' };
    return evaluateOrder({ input: entryOrder({ size: 18 }), entries: [plan()], now: NOW, config: { ...config, home }, strategies: [propStrategy({ contracts: 'micro', ...(policyRisk ? { risk: { stop: 'strategy', min_rr: 2, max_risk_usd: policyRisk } } : {}) }), component], accounts: [acct] }).violations;
  };
  assert.deepStrictEqual(run(null), [], 'within the prop budget; the component\'s cap does not apply');
  assert.deepStrictEqual(run(400), []);
  const v = run(300);
  assert.deepStrictEqual(v.map(x => x.check), ['max-risk']);
  assert.match(v[0].message, /^risk \$360\.00 \(size 18 x 40-tick stop x \$0\.50 a tick on MNQ\) over setup:orb's risk\.max_risk_usd \$300\.00: reduce the size to 15 or less/);
});

// --- Roles: an autonomous cycle's entry waits for its roles' reports (roles-ran.js). ---
const fs = require('fs');
const path = require('path');
const ocEvent = (tool, input) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool, state: { status: 'completed', input, output: 'VERDICT: APPROVE - size 1' } } });
const ocSkills = ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'].map(name => ocEvent('skill', { name }));
const ocRoles = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager', 'risk-manager'].map(subagent_type => ocEvent('task', { subagent_type }));

test('roles-ran: an autonomous full cycle enters only after the analysts and both risk-manager phases returned; exits are never held', () => {
  const file = path.join(require('../helpers').tmpDir(), 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const auto = { ...config, autonomous: true, cycle: 'full', cycleTranscript: file };
  const run = (input, cfg = auto) => evaluateOrder({ input, entries: [plan()], now: NOW, config: cfg });
  fs.writeFileSync(file, [...ocSkills, ...ocRoles.slice(3)].join('\n'));
  const r = run(entryOrder());
  assert.deepStrictEqual(checks(r), ['roles-ran']);
  assert.match(r.violations[0].message, /not returned yet: market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst\./);
  fs.writeFileSync(file, [...ocSkills, ...ocRoles].join('\n'));
  assert.deepStrictEqual(run(entryOrder()).violations, []);
  // The opencode transcript is read for the skills too: a session that loaded none is refused for them.
  fs.writeFileSync(file, ocRoles.join('\n'));
  assert.deepStrictEqual(checks(run(entryOrder())), ['skills-at-entry', 'skills-loaded']);
  // Exits and protective stops never wait for roles.
  fs.writeFileSync(file, '');
  assert.deepStrictEqual(run(entryOrder({ rationale: '[exit] flatten' })).violations, []);
  // A lean cycle needs risk-manager twice; an interactive session (not autonomous) needs no roles.
  fs.writeFileSync(file, [...ocSkills, ocRoles[3]].join('\n'));
  assert.match(run(entryOrder(), { ...auto, cycle: 'lean' }).violations[0].message, /not returned yet: risk-manager phase 2 \(a second call, started after phase 1 returned\)/);
  assert.deepStrictEqual(checks(run(entryOrder(), { ...auto, autonomous: false })), []);
  // A hook's own transcript_path wins over the runner's file.
  const hookFile = `${file}.hook`;
  fs.writeFileSync(hookFile, [...ocSkills, ...ocRoles].join('\n'));
  assert.deepStrictEqual(evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: auto, transcriptPath: hookFile }).violations, []);
  // The runner named a transcript that isn't there: refused (fails closed).
  assert.match(run(entryOrder(), { ...auto, cycleTranscript: `${file}.gone` }).violations.find(v => v.check === 'roles-ran').message, /can't be read/);
});

// --- Fact-checked reasons: the facts phase 2 approved on, against the cycle's bar briefing (fact-claims.js, R29). ---
test('phase2-facts: the order\'s own setup - its setup tag and side; a policy strategy\'s is the component its latest verdict trades', () => {
  const { factsOrder } = require('../../scripts/lib/trading/order-gate');
  const prop = require('../../scripts/lib/trading/prop-state');
  const home = trendHome();
  const tag = r => /^\s*setup:([a-z0-9][a-z0-9_-]*)\b/i.exec(r);
  assert.deepStrictEqual(factsOrder(entryOrder(), tag(entryOrder().rationale), { name: 'orb', signal: 'rules' }, home), { strategy: 'orb', side: 'long' });
  assert.deepStrictEqual(factsOrder(entryOrder({ side: 'sell' }), tag('setup:ORB short'), null, home), { strategy: 'orb', side: 'short' });
  assert.deepStrictEqual(factsOrder(entryOrder({ rationale: 'no tag' }), null, null, home), { strategy: null, side: 'long' });
  const policy = { name: 'prop_portfolio', signal: 'policy' };
  assert.deepStrictEqual(factsOrder(entryOrder({ rationale: 'setup:prop_portfolio long' }), tag('setup:prop_portfolio long'), policy, home), { strategy: null, side: 'long' }, 'no verdict: no setup');
  prop.appendVerdict(home, { bar: '2026-10-07T13:54:00.000Z', strategy: 'prop_portfolio', component: 'keltner', contractId: CONTRACT, contract: 'MNQ', direction: 'long', action: 'full', stopTicks: 40, maxSize: 2, at: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  assert.deepStrictEqual(factsOrder(entryOrder({ rationale: 'setup:prop_portfolio long' }), tag('setup:prop_portfolio long'), policy, home), { strategy: 'keltner', side: 'long' });
});

test('phase2-facts: a room fact is about the order\'s own setup (its setup tag and side), never the verdict\'s text', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const home = trendHome();
  const file = path.join(home, 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const BAR = '2026-10-07T13:54:00.000Z';
  // orb long: IB high at 0.5R before the 2R it needs (short of room); vx long: nothing in its way (room enough).
  B.writeBriefing(home, { symbol: 'MNQ', minutes: 3, asOf: BAR, closedAt: '2026-10-07T13:57:00.000Z', sections: {
    m3: { version: 'a', validUntil: '2026-10-07T14:03:00.000Z', data: { window: 'opening drive', windowEntries: 'allowed', candidates: [
      { name: 'orb', direction: 'long', stopPoints: 8, needR: 2, inTheWay: { name: 'IB high', R: 0.5 } },
      { name: 'vx', direction: 'long', stopPoints: 8, needR: 2, inTheWay: null },
    ] } },
  } });
  const auto = { ...config, home, autonomous: true, cycle: 'full', cycleTranscript: file, cycleBars: { MNQ: BAR } };
  const p2 = text => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { subagent_type: 'risk-manager' }, output: text } } });
  const facts = (text, input = entryOrder()) => {
    fs.writeFileSync(file, [...ocSkills, ...ocRoles.slice(0, 4), p2(text)].join('\n'));
    return evaluateOrder({ input, entries: [plan()], now: NOW, config: auto }).violations.filter(v => v.check === 'phase2-facts').map(v => v.message);
  };
  // The repro: the verdict names vx, the order is setup:orb: "room long enough" is about orb, which is short of room.
  assert.match(facts('VERDICT: APPROVE - size 1, vx long\nFACTS: window opening drive; entries allowed; room long enough')[0], /contradicts: "room long enough" \(the briefing: orb: IB high at 0\.5R, it needs 2R\)/);
  // Naming another strategy, or the other side: can't be matched (never "contradicts").
  const other = facts('VERDICT: APPROVE - size 1, vx long\nFACTS: window opening drive; entries allowed; room vx long enough')[0];
  assert.match(other, /room facts that can't be matched to this order \(setup:orb long\): "room vx long enough" \(it is about vx long, the order is orb long\)/);
  assert.doesNotMatch(other, /contradicts/);
  assert.match(facts('VERDICT: APPROVE\nFACTS: window opening drive; entries allowed; room short enough')[0], /can't be matched to this order \(setup:orb long\): "room short enough"/);
  // The vx order: its own room is enough, so the same report passes for it.
  assert.deepStrictEqual(facts('VERDICT: APPROVE - size 1, orb long with vx\nFACTS: window opening drive; entries allowed; room long enough', entryOrder({ rationale: 'setup:vx long, stop 21480, target 21540, risk $40' })), []);
  // An order with no setup tag: any room fact can't be matched (the setup-tag check refuses it too).
  assert.match(facts('VERDICT: APPROVE\nFACTS: window opening drive; entries allowed; room long enough', entryOrder({ rationale: 'break above the OR high, stop 21480' }))[0], /the order names no setup/);
});

test('phase2-facts: an autonomous entry approved on a fact the briefing contradicts is refused; true facts pass; unchecked stated facts fail closed; exits never checked', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const home = trendHome();
  const file = path.join(home, 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const BAR = '2026-10-07T13:54:00.000Z';
  const briefing = { symbol: 'MNQ', minutes: 3, asOf: BAR, closedAt: '2026-10-07T13:57:00.000Z', sections: {
    m3: { version: 'a', validUntil: '2026-10-07T14:03:00.000Z', data: { window: 'opening drive', windowEntries: 'allowed', trendRule: 'Trend rule: prevailing trend 1h up; trend strategies may not go short; reversal strategies (mtf: reversal) may go short too.', vwap: { side: 'above' }, candidates: [{ name: 'orb', direction: 'long', stopPoints: 8, needR: 2, inTheWay: { name: 'IB high', R: 0.5 } }] } },
    m15: { version: 'b', validUntil: '2026-10-07T14:15:00.000Z', data: { alignment: { long: 'aligned', short: 'counter' } } },
  } };
  const auto = { ...config, home, autonomous: true, cycle: 'full', cycleTranscript: file, cycleBars: { MNQ: BAR } };
  // The plan written for the cycle's bar (after its 13:57 close: plan-required in a runner's cycle).
  const run = (input, cfg = auto) => evaluateOrder({ input, entries: [plan(1)], now: NOW, config: cfg });
  // The analysts and phase 1, then phase 2's report (its text as given).
  const p2 = text => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { subagent_type: 'risk-manager' }, output: text } } });
  const approve = text => [...ocSkills, ...ocRoles.slice(0, 4), p2(text)].join('\n');
  const facts = r => r.violations.filter(v => v.check === 'phase2-facts');
  const unpinned = { ...auto, cycleBars: {} };
  // No bar pinned and no briefing, no FACTS line or FACTS: none: nothing stated, nothing refused.
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1, risk $8'));
  assert.deepStrictEqual(run(entryOrder(), unpinned).violations, []);
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1, risk $8\nFACTS: none'));
  assert.deepStrictEqual(run(entryOrder(), unpinned).violations, [], 'FACTS: none with no briefing');
  // The runner pinned the cycle's bar and its briefing is missing: an anomaly, refused whatever was stated.
  assert.match(facts(run(entryOrder()))[0].message, /The bar briefing for this cycle's MNQ bar \(2026-10-07T13:54:00.000Z\) can't be read \(no bar briefing for MNQ\)/);
  // FACTS stated, no briefing to check them against: refused (fails closed).
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1\nFACTS: entries allowed; read long aligned'));
  assert.match(facts(run(entryOrder(), unpinned))[0].message, /can't be checked \(no bar briefing for MNQ\): no entry this cycle/);
  B.writeBriefing(home, briefing);
  // A current briefing: an approval states at least 2 checkable claims (owner's decision); none, or one, is refused.
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1, risk $8'));
  assert.match(facts(run(entryOrder()))[0].message, /approved with 0 checkable facts \(at least 2 needed, in a FACTS line under the verdict/);
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1\nFACTS: window opening drive'));
  assert.match(facts(run(entryOrder()))[0].message, /approved with 1 checkable fact \(at least 2 needed/);
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1\nFACTS: window opening drive; trend long allowed; momentum strong'));
  assert.match(facts(run(entryOrder()))[0].message, /approved on facts in no known form: "momentum strong"/);
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1\nFACTS: window opening drive; trend long allowed'));
  assert.deepStrictEqual(run(entryOrder()).violations, [], 'two checked claims');
  // True facts: the entry goes.
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1\nFACTS: window opening drive; entries allowed; trend long allowed; read long aligned; vwap above'));
  assert.deepStrictEqual(run(entryOrder()).violations, []);
  // A false one (the room: IB high at 0.5R before the 2R it needs) and another: refused, naming each.
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1\nFACTS: entries allowed; room long enough; read long mixed'));
  const r = run(entryOrder());
  assert.deepStrictEqual(checks(r), ['phase2-facts']);
  assert.match(r.violations[0].message, /approved on facts the bar briefing contradicts: "room long enough" \(the briefing: orb: IB high at 0\.5R, it needs 2R\); "read long mixed" \(the briefing: the long read is aligned\)\. The approval doesn't stand/);
  // The cycle decides another bar: this briefing isn't its facts (refused). No cycle bar given: the briefing on file
  // while it is current, else unavailable (stated facts refused, none passes).
  assert.match(facts(run(entryOrder(), { ...auto, cycleBars: { MNQ: '2026-10-07T13:57:00.000Z' } }))[0].message, /can't be read \(the MNQ briefing is for the bar at/);
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1\nFACTS: read long aligned; vwap above'));
  assert.deepStrictEqual(run(entryOrder(), { ...auto, cycleBars: {} }).violations, []);
  const later = (cfg, at) => evaluateOrder({ input: entryOrder(), entries: [plan()], now: at, config: cfg });
  const stale = new Date('2026-10-07T14:20:00Z');
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1\nFACTS: read long counter; vwap below'));
  assert.match(facts(later({ ...auto, cycleBars: {} }, stale))[0].message, /can't be checked \(the MNQ briefing \(bar at 2026-10-07T13:54:00.000Z\) is no longer current\)/);
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1\nFACTS: none'));
  assert.deepStrictEqual(facts(later({ ...auto, cycleBars: {} }, stale)), []);
  // Not autonomous: no check. Exits and protective stops never reach it, whatever the facts, the briefing or the transcript.
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1\nFACTS: read long counter'));
  assert.deepStrictEqual(checks(run(entryOrder())), ['phase2-facts']);
  assert.deepStrictEqual(checks(run(entryOrder(), { ...auto, autonomous: false })), []);
  fs.writeFileSync(B.briefingFile(home, 'MNQ'), '{broken');
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1'));
  B.writeBriefing(home, briefing);
  for (const rationale of ['[exit] flatten', '[protect] stop for the long at 21480']) {
    assert.deepStrictEqual(run(entryOrder({ rationale })).violations, [], `${rationale}: no FACTS line, a current briefing`);
  }
  fs.writeFileSync(B.briefingFile(home, 'MNQ'), '{broken');
  fs.writeFileSync(file, approve('VERDICT: APPROVE - size 1\nFACTS: none'));
  assert.match(facts(run(entryOrder()))[0].message, /The bar briefing for this cycle's MNQ bar .* can't be read/, 'a corrupt briefing for a pinned bar');
  for (const rationale of ['[exit] flatten', '[protect] stop for the long at 21480']) {
    assert.deepStrictEqual(run(entryOrder({ rationale })).violations, [], rationale);
    assert.deepStrictEqual(run(entryOrder({ rationale }), { ...auto, cycleTranscript: `${file}.gone` }).violations, [], rationale);
  }
  // The transcript can't be read: refused by the three checks that read it (fails closed).
  // The pinned bar's briefing unreadable: its data's age can't be checked either (briefing-age).
  assert.deepStrictEqual(checks(run(entryOrder(), { ...auto, cycleTranscript: `${file}.gone` })), ['briefing-age', 'phase2-facts', 'roles-ran', 'skills-at-entry']);
  // The gateway's config carries the runner's cycle bars by family root; unreadable: none (the briefing on file).
  assert.deepStrictEqual(loadConfig({ FTH_CYCLE_BARS: JSON.stringify({ NQ: BAR, MES: 7 }) }).cycleBars, { MNQ: BAR });
  for (const raw of [undefined, '', '{bad', '[1]', 'null']) assert.deepStrictEqual(loadConfig({ FTH_CYCLE_BARS: raw }).cycleBars, {}, String(raw));
});

test('roles-ran: the gateway (checkOrder) reads the cycle and its transcript from the runner\'s environment', () => {
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const live = replaySetup({ replay: false });
  const file = path.join(require('../helpers').tmpDir(), 'cycle-transcript.jsonl');
  // Role skills full (the runner's FTH_ROLE_SKILLS for every harness but opencode): index mode's lookups have their own tests.
  const env = { ...live.env, FTH_TEST_NOW: '2026-10-07T14:30:00.000Z', FTH_CYCLE: 'full', FTH_CYCLE_TRANSCRIPT: file, FTH_ROLE_SKILLS: 'full' };
  assert.deepStrictEqual(loadConfig(env).cycle, 'full');
  assert.strictEqual(loadConfig({ FTH_CYCLE: 'fast' }).cycle, null);
  fs.writeFileSync(file, ocSkills.join('\n'));
  // Autonomous: refused until the roles ran (the gateway passes no transcript of its own).
  const auto = { ...env, FTH_AUTONOMOUS: '1', FTH_SYMBOLS: live.symbols || 'MNQ' };
  assert.ok(checkOrder(ANYTIME, { env: auto, pluginRoot: live.root }).violations.some(v => v.check === 'roles-ran'));
  fs.writeFileSync(file, [...ocSkills, ...ocRoles].join('\n'));
  assert.ok(!checkOrder(ANYTIME, { env: auto, pluginRoot: live.root }).violations.some(v => v.check === 'roles-ran'));
  // Not autonomous: no roles check, whatever the environment says.
  fs.writeFileSync(file, '');
  assert.ok(!checkOrder(ANYTIME, { env, pluginRoot: live.root }).violations.some(v => v.check === 'roles-ran'));
});

test('roles-ran: roles the runner served from its report cache (FTH_CYCLE_CACHED) count as returned; phase 2 still runs', () => {
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const live = replaySetup({ replay: false });
  const file = path.join(require('../helpers').tmpDir(), 'cycle-transcript.jsonl');
  const analysts = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'];
  const base = { ...live.env, FTH_TEST_NOW: '2026-10-07T14:30:00.000Z', FTH_CYCLE: 'full', FTH_CYCLE_TRANSCRIPT: file, FTH_AUTONOMOUS: '1', FTH_SYMBOLS: live.symbols || 'MNQ', FTH_ROLE_SKILLS: 'full' };
  const refused = env => checkOrder(ANYTIME, { env, pluginRoot: live.root }).violations.find(v => v.check === 'roles-ran');
  // Only phase 2 ran this cycle: refused without the cache, accepted with every other role served from it.
  fs.writeFileSync(file, [...ocSkills, ocEvent('task', { subagent_type: 'risk-manager' })].join('\n'));
  assert.match(refused(base).message, /not returned yet: market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst/);
  assert.strictEqual(refused({ ...base, FTH_CYCLE_CACHED: [...analysts, 'risk-manager'].join(',') }), undefined);
  // Two analysts cached, the third neither cached nor run: refused for it alone.
  assert.match(refused({ ...base, FTH_CYCLE_CACHED: `${analysts.slice(0, 2).join(',')},risk-manager` }).message, /not returned yet: volume-liquidity-analyst\./);
  // Nothing ran at all: phase 2 is still needed, cache or not.
  fs.writeFileSync(file, ocSkills.join('\n'));
  assert.match(refused({ ...base, FTH_CYCLE_CACHED: [...analysts, 'risk-manager'].join(',') }).message, /risk-manager phase 2/);
  // A name the cache can't hold (phase 2, the executor, anything else) counts for nothing.
  assert.ok(refused({ ...base, FTH_CYCLE_CACHED: 'risk-manager phase 2,trade-executor,whatever' }));
});

test('roles-ran: roles the runner ran itself (its role record, FTH_CYCLE_ROLES) count with their times and reports; phase 2 after them in the transcript', () => {
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const RR = require('../../scripts/lib/trading/runner-roles');
  const live = replaySetup({ replay: false });
  const dir = require('../helpers').tmpDir();
  const file = path.join(dir, 'cycle-transcript.jsonl');
  const rolesFile = path.join(dir, 'cycle-roles.jsonl');
  const T = 1.7e12;
  for (const role of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager']) {
    RR.appendRoleRun(rolesFile, { role, start: T, end: T + 1000, text: `## ${role}`, lookups: [], ok: true });
  }
  const p2 = ([start, end], verdict = 'APPROVE') => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { subagent_type: 'risk-manager' }, output: `VERDICT: ${verdict} - size 1`, time: { start: T + start, end: T + end } } } });
  // evaluateOrder: the config's cycleRoles (loadConfig reads FTH_CYCLE_ROLES).
  const auto = { ...config, autonomous: true, cycle: 'full', cycleTranscript: file, roleSkills: 'full' };
  const rolesRan = cfg => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: cfg }).violations.find(v => v.check === 'roles-ran');
  fs.writeFileSync(file, [...ocSkills, p2([2000, 3000])].join('\n'));
  assert.strictEqual(rolesRan({ ...auto, cycleRoles: rolesFile }), undefined);
  assert.match(rolesRan(auto).message, /not returned yet: market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst/, 'control: no record');
  assert.match(rolesRan({ ...auto, cycleRoles: `${rolesFile}.gone` }).message, /not returned yet: market-structure-analyst/, 'a record that isn\'t there adds nothing');
  // Phase 2 started before the runner's phase 1 ended: not phase 2. A veto: refused.
  fs.writeFileSync(file, [...ocSkills, p2([500, 3000])].join('\n'));
  assert.match(rolesRan({ ...auto, cycleRoles: rolesFile }).message, /risk-manager phase 2 \(a second call, started after phase 1/);
  fs.writeFileSync(file, [...ocSkills, p2([2000, 3000], 'VETO')].join('\n'));
  assert.match(rolesRan({ ...auto, cycleRoles: rolesFile }).message, /its latest verdict is not "VERDICT: APPROVE"/);
  // The gateway (checkOrder) reads the record from the runner's environment.
  assert.strictEqual(loadConfig({ FTH_CYCLE_ROLES: ` ${rolesFile} ` }).cycleRoles, rolesFile);
  assert.strictEqual(loadConfig({}).cycleRoles, null);
  fs.writeFileSync(file, [...ocSkills, p2([2000, 3000])].join('\n'));
  const env = { ...live.env, FTH_TEST_NOW: '2026-10-07T14:30:00.000Z', FTH_CYCLE: 'full', FTH_CYCLE_TRANSCRIPT: file, FTH_AUTONOMOUS: '1', FTH_SYMBOLS: live.symbols || 'MNQ', FTH_ROLE_SKILLS: 'full' };
  const refused = e => checkOrder(ANYTIME, { env: e, pluginRoot: live.root }).violations.find(v => v.check === 'roles-ran');
  assert.match(refused(env).message, /not returned yet: market-structure-analyst/);
  assert.strictEqual(refused({ ...env, FTH_CYCLE_ROLES: rolesFile }), undefined);
});

test('allowed accounts: an override can\'t change a shipped broker\'s paper settings or allow-list variable (the gate trusts them); a broker of the user\'s own keeps its own', () => {
  const fs = require('fs');
  const path = require('path');
  const { activeBroker } = require('../../scripts/lib/broker/config');
  const home = tmpDir();
  const shipped = shippedBroker();
  const file = path.join(home, 'brokers.json');
  fs.writeFileSync(file, JSON.stringify({ broker: shipped.name, brokers: {
    [shipped.name]: { paperEnv: { SPOOF_PAPER: 'on' }, allowedAccountsEnv: 'SPOOF_LIST' },
    mine: { command: ['mine'], paperEnv: { MINE_PAPER: 'on' }, allowedAccountsEnv: 'MINE_LIST' },
  } }));
  const b = activeBroker({ FTH_HOME: home, FTH_BROKERS_FILE: file });
  assert.deepStrictEqual([b.paperEnv, b.allowedAccountsEnv], [shipped.paperEnv, shipped.allowedAccountsEnv]);
  const { liveEntryRefusal } = require('../../scripts/lib/broker/allow-list');
  assert.match(liveEntryRefusal({ broker: b, env: { SPOOF_PAPER: 'on', SPOOF_LIST: '1' }, accountId: 1 }), new RegExp(`${shipped.allowedAccountsEnv} is empty`));
  // Nor ADD them to a shipped broker that lacks them: checked on defaults (read from DEFAULTS_FILE) without them.
  const { DEFAULTS_FILE } = require('../../scripts/lib/broker/config');
  const { loadBrokers } = require('../../scripts/lib/broker/config');
  const realRead = fs.readFileSync;
  fs.readFileSync = (f, ...a) => (path.resolve(String(f)) === DEFAULTS_FILE
    ? JSON.stringify({ broker: shipped.name, brokers: { [shipped.name]: { command: ['x'] } } }) : realRead(f, ...a));
  try {
    fs.writeFileSync(file, JSON.stringify({ broker: shipped.name, brokers: { [shipped.name]: { paperEnv: { SPOOF_PAPER: 'on' }, allowedAccountsEnv: 'SPOOF_LIST' } } }));
    const added = loadBrokers({ FTH_HOME: home, FTH_BROKERS_FILE: file }).brokers[shipped.name];
    assert.deepStrictEqual(['paperEnv' in added, 'allowedAccountsEnv' in added], [false, false]);
  } finally {
    fs.readFileSync = realRead;
  }
  fs.writeFileSync(file, JSON.stringify({ broker: shipped.name, brokers: {
    [shipped.name]: { paperEnv: { SPOOF_PAPER: 'on' }, allowedAccountsEnv: 'SPOOF_LIST' },
    mine: { command: ['mine'], paperEnv: { MINE_PAPER: 'on' }, allowedAccountsEnv: 'MINE_LIST' },
  } }));
  const mine = activeBroker({ FTH_HOME: home, FTH_BROKERS_FILE: file, FTH_BROKER: 'mine' });
  assert.deepStrictEqual([mine.paperEnv, mine.allowedAccountsEnv], [{ MINE_PAPER: 'on' }, 'MINE_LIST']);
});

test('allowed accounts: the gateway\'s server check - paper only when the server has trading off, the server\'s list must hold the account as well as the local one, an unreadable config refuses, a confirmed replay is exempt', async () => {
  const { serverEntryRefusal, createServerAttestation } = require('../../scripts/lib/broker/allow-list');
  const broker = { name: 'live', allowedAccountsEnv: 'L', paperEnv: { P: 'on' } };
  const ok = { tradingEnabled: true, allowedAccountIds: [1] };
  const check = (server, env = { L: '1' }, extra = {}) => serverEntryRefusal({ broker, env, accountId: 1, server, ...extra });
  assert.strictEqual(check(ok), null);
  assert.strictEqual(check({ tradingEnabled: false }, { P: 'on' }), null, 'the server confirms paper');
  assert.strictEqual(check({ tradingEnabled: false }, {}), null, 'the server refuses every order itself');
  assert.match(check(ok, { P: 'on' }), /L is empty/, 'a paper claim the server contradicts is live');
  assert.match(check({ ...ok, allowedAccountIds: [7] }), /account 1 is not among the broker server's allowed accounts \(7\)/);
  for (const ids of [[], 'any', undefined, [1, 'x']]) assert.match(check({ ...ok, allowedAccountIds: ids }), /allows any account/, JSON.stringify(ids));
  assert.match(check(ok, {}), /L is empty/, 'the local list too');
  for (const bad of [null, undefined, 'text', [], { error: 'timeout' }, { tradingEnabled: 'yes' }]) assert.match(check(bad), /get_server_config could not be read/, JSON.stringify(bad));
  assert.strictEqual(check(null, {}, { replay: true }), null);
  // Read once per gateway (kept only when readable); an error refuses and is read again; an entry already refused isn't asked about.
  let calls = 0;
  let answer = { isError: true, content: [{ text: 'down' }] };
  const attest = createServerAttestation({ env: { L: '1' }, broker, call: async () => { calls += 1; return answer; } });
  assert.match((await attest.violations({ accountId: 1 }, false))[0].message, /could not be read \(down\)[\s\S]*close_position still go/);
  answer = { content: [{ text: JSON.stringify(ok) }] };
  assert.deepStrictEqual(await attest.violations({ accountId: 1 }, false), []);
  assert.deepStrictEqual(await attest.violations({ accountId: 1 }, false), []);
  assert.strictEqual(calls, 2, 'cached once readable');
  assert.deepStrictEqual(await attest.violations({ accountId: 2 }, false, [{ check: 'plan-required' }]), []);
  assert.strictEqual((await attest.violations({ accountId: 2 }, false))[0].check, 'allowed-accounts');
  // A reply that parses but has no boolean tradingEnabled ({}) refuses and isn't kept: the next, valid one is read.
  const replies = [{ content: [{ text: '{}' }] }, { content: [{ text: JSON.stringify(ok) }] }];
  const odd = createServerAttestation({ env: { L: '1' }, broker, call: async () => replies.shift() });
  assert.match((await odd.violations({ accountId: 1 }, false))[0].message, /could not be read/);
  assert.deepStrictEqual(await odd.violations({ accountId: 1 }, false), []);
  const replayed = createServerAttestation({ env: {}, broker, call: async () => assert.fail('a confirmed replay asks nothing') });
  assert.deepStrictEqual(await replayed.violations({ accountId: 1 }, true), []);
  // No configured broker the gateway knows, and none readable: refused.
  const none = createServerAttestation({ env: { FTH_BROKER: 'nope', FTH_HOME: tmpDir() }, call: async () => answer });
  assert.match((await none.violations({ accountId: 1 }, false))[0].message, /unknown broker "nope"/);
});

test('contract-specs: a replayed day whose file has tick specs but no front month (only a lookup by month succeeded) refuses entries, saying why; exits go; the live file is as before', () => {
  const home = trendHome(undefined, { specs: false });
  const cfg = { ...config, home };
  const day = path.join(home, 'contracts-fake.2026-10-07.json');
  const write = front => fs.writeFileSync(day, JSON.stringify({
    ids: { 'fake:MNQ:Z26': { root: 'MNQ', month: '2026-12' } }, front,
    specs: { MNQ: { tickSize: 0.25, tickValue: 0.5, name: 'MNQZ6', id: 'fake:MNQ:Z26', readAt: '2026-10-07T13:00:00.000Z' } }, server: { maxOrderSize: 50, readAt: '2026-10-07T13:00:00.000Z' },
  }));
  write({});
  const r = evaluate(entryOrder(), [plan()], { config: { ...cfg, contractsFile: day } });
  assert.deepStrictEqual(checks(r), ['contract-specs']);
  assert.strictEqual(r.violations[0].message, 'the replayed day\'s MNQ front month (2026-10-07) is not looked up yet, so its tick specs and contract can\'t be trusted for an entry: call search_contracts for MNQ first (the harness records that day\'s front month and tick specs), then try again.');
  assert.deepStrictEqual(checks(evaluate(entryOrder({ contractId: 'MNQ:2026-12' }), [plan()], { config: { ...cfg, contractsFile: day } })), ['contract-specs'], 'by month too');
  // Not skippable, like every contract-specs refusal.
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan()], { config: { ...cfg, contractsFile: day, skipChecks: new Set(['contract-specs']) } })), ['contract-specs']);
  // Exits and stops never wait on it.
  for (const rationale of ['[exit] flatten the long', '[protect] stop for the long at 21480']) {
    assert.deepStrictEqual(evaluate(entryOrder({ rationale, side: 'sell', type: 'stop', stopPrice: 21480 }), [], { config: { ...cfg, contractsFile: day } }).violations, [], rationale);
  }
  // Another root's front month is not this one's.
  write({ MES: { id: 'fake:MES:Z26', month: '2026-12', day: '2026-10-07' } });
  assert.deepStrictEqual(checks(evaluate(entryOrder(), [plan()], { config: { ...cfg, contractsFile: day } })), ['contract-specs']);
  // The day's front month looked up: the entry goes.
  write({ MNQ: { id: 'fake:MNQ:Z26', month: '2026-12', day: '2026-10-07' } });
  assert.deepStrictEqual(evaluate(entryOrder(), [plan()], { config: { ...cfg, contractsFile: day } }).violations, []);
  // The live file never needs one (main's behaviour).
  const live = path.join(home, 'contracts-fake.json');
  fs.writeFileSync(live, fs.readFileSync(day, 'utf8').replace(/"front":\{[^}]*\}\}/, '"front":{}'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(live, 'utf8')).front, {});
  assert.deepStrictEqual(evaluate(entryOrder(), [plan()], { config: { ...cfg, contractsFile: live } }).violations, []);
});

test('account lock (hard): a runner\'s cycle enters only while the runner holds its account\'s lock; exits always pass', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const L = require('../../scripts/lib/account-lock');
  const env = { FTH_LOCK_DIR: require('../helpers').tmpDir(), FTH_TEST_LOCKS: '1' };
  const lock = L.acquireAccountLocks({ env, broker: { name: 'live' }, servers: ['cmd:/s', 'api:https://api.example.test'], accountId: String(entryOrder().accountId) });
  try {
    const held = { ...config, accountLock: L.lockSpec(lock), skipChecks: new Set(['account-lock']) };
    assert.ok(!checks(evaluate(entryOrder(), [plan()], { config: held })).includes('account-lock'), 'held: no refusal (and the check is not skippable)');
    const none = { ...config, accountLock: L.lockSpec(null), skipChecks: new Set(['account-lock']) };
    assert.ok(checks(evaluate(entryOrder(), [plan()], { config: none })).includes('account-lock'), 'a run without the lock (end of day): refused');
    assert.deepStrictEqual(evaluate(entryOrder({ rationale: '[exit] flatten' }), [], { config: none }).violations, []);
    assert.deepStrictEqual(evaluate(entryOrder({ rationale: '[protect] stop at 21480' }), [], { config: none }).violations, []);
    // Another runner took one of its files over: refused at once, whatever the runner has noticed.
    fs.writeFileSync(lock.files[1], JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'theirs' }));
    const v = evaluate(entryOrder(), [plan()], { config: held }).violations.find(x => x.check === 'account-lock');
    assert.match(v.message, new RegExp(`no longer holds its account's lock \\(${path.basename(lock.files[1]).replace('.', '\\.')}|no longer holds`));
    for (const bad of ['junk', '{}', JSON.stringify({ files: [], token: 'x' }), JSON.stringify({ files: ['/x'], token: '' })]) {
      assert.match(L.lockGateRefusal(bad), /not a readable lock spec/, bad);
    }
    assert.strictEqual(L.lockGateRefusal(''), null, 'unset: no runner lock in play');
    assert.strictEqual(config.accountLock, null, 'loadConfig: unset');
    assert.strictEqual(loadConfig({ FTH_ACCOUNT_LOCK: 'none' }).accountLock, 'none');
  } finally {
    lock.release();
  }
});

test('account lock (hard): inside a runner, an entry on any account but the one it holds the lock for is refused; an unreadable account or spec too; exits on any account pass', () => {
  const L = require('../../scripts/lib/account-lock');
  const env = { FTH_LOCK_DIR: require('../helpers').tmpDir(), FTH_TEST_LOCKS: '1' };
  const mine = String(entryOrder().accountId);
  const lock = L.acquireAccountLocks({ env, broker: { name: 'live' }, servers: ['cmd:/s'], accountId: mine });
  try {
    const held = { ...config, accountLock: L.lockSpec(lock) };
    const other = Number(mine) + 7;
    const v = evaluate(entryOrder({ accountId: other }), [plan()], { config: held }).violations.find(x => x.check === 'account-lock');
    assert.match(v.message, new RegExp(`This runner holds account ${mine}'s lock, not account ${other}'s`));
    assert.ok(!checks(evaluate(entryOrder({ accountId: `00${mine}` }), [plan()], { config: held })).includes('account-lock'), 'its own account, as the gate normalizes it');
    for (const bad of [undefined, '', 'x']) {
      assert.match(evaluate(entryOrder({ accountId: bad }), [plan()], { config: held }).violations.find(x => x.check === 'account-lock').message, /names no valid accountId/, String(bad));
    }
    for (const rationale of ['[exit] flatten', '[protect] stop at 21480']) {
      assert.deepStrictEqual(evaluate(entryOrder({ accountId: other, rationale }), [], { config: held }).violations, [], rationale);
    }
    const noAccount = JSON.stringify({ files: lock.files, token: lock.token });
    assert.match(L.lockGateRefusal(noAccount, mine), /not a readable lock spec/, 'a spec that names no account');
  } finally {
    lock.release();
  }
});

test('account lock outside a runner (heldByRunner, the gate\'s check): an entry with no valid account id is refused; a lock dir override outside tests is ignored (the default dir is checked), never a pass', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawn } = require('child_process');
  const L = require('../../scripts/lib/account-lock');
  const broker = { name: 'live', apiUrlEnv: 'LIVE_API_URL', env: ['LIVE_API_URL'] };
  const home = require('../helpers').tmpDir();
  const env = { FTH_LOCK_DIR: require('../helpers').tmpDir(), LIVE_API_URL: 'https://api.example.test' }; // no FTH_TEST_LOCKS: an override outside tests
  for (const bad of [undefined, null, '', 'x', 1.5]) assert.match(L.heldByRunner({ env, broker, accountId: bad, home }), /names no valid accountId/, String(bad));
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/x/scripts/autotrader.js'], { stdio: 'ignore' });
  try {
    // The override's dir holds nothing; the default one (under the OS home) holds a live runner's lock.
    const dflt = L.lockFileFor({ env: {}, server: 'api:https://api.example.test', accountId: '7', home });
    fs.mkdirSync(path.dirname(dflt), { recursive: true });
    fs.writeFileSync(dflt, JSON.stringify({ pid: runner.pid, host: os.hostname(), home: '/homes/a', startedAt: 't', token: 'x' }));
    assert.match(L.heldByRunner({ env, broker, accountId: '7', home }), /already traded by another runner/);
    assert.strictEqual(L.heldByRunner({ env: { ...env, FTH_TEST_LOCKS: '1' }, broker, accountId: '7', home }), null, 'with FTH_TEST_LOCKS=1 the override is the dir read');
  } finally {
    runner.kill();
  }
});

test('account lock outside a runner: a live broker (apiUrlEnv) whose API URL is unset or no URL refuses entries, naming the variable; exits pass; a broker without apiUrlEnv is unaffected', () => {
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const L = require('../../scripts/lib/account-lock');
  const live = { name: 'live', apiUrlEnv: 'LIVE_API_URL', env: ['LIVE_API_URL'] };
  const home = require('../helpers').tmpDir();
  for (const [value, what] of [[undefined, 'is not set'], ['', 'is not set'], ['nonsense', 'is not a URL with a host']]) {
    assert.match(L.heldByRunner({ env: { LIVE_API_URL: value }, broker: live, accountId: '7', home }), new RegExp(`LIVE_API_URL ${what}, .*no entry\\. Set LIVE_API_URL`), String(value));
  }
  assert.strictEqual(L.heldByRunner({ env: { LIVE_API_URL: 'https://api.example.test' }, broker: live, accountId: '7', home }), null);
  assert.strictEqual(L.heldByRunner({ env: {}, broker: { name: 'sim', command: ['sim-mcp'] }, accountId: '7', home }), null, 'no apiUrlEnv: the command key alone');
  // Through the gate (the tests' fake live broker names FAKE_BROKER_API_URL): an entry refused, an exit not.
  const env = { FTH_BROKERS_FILE: require('../helpers').FAKE_BROKERS, FTH_HOME: home, FTH_LOCK_DIR: require('../helpers').tmpDir(), FTH_TEST_LOCKS: '1', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1' };
  const entry = checkOrder(entryOrder(), { env, pluginRoot: require('path').resolve(__dirname, '..', '..') });
  assert.ok(entry.violations.some(v => v.check === 'account-lock' && /FAKE_BROKER_API_URL is not set/.test(v.message)), entry.message);
  const exit = checkOrder(entryOrder({ side: 'sell', rationale: '[exit] flatten' }), { env, pluginRoot: require('path').resolve(__dirname, '..', '..') });
  assert.ok(!exit.violations.some(v => v.check === 'account-lock'), exit.message);
});

// --- Index mode (FTH_ROLE_SKILLS=index): a role's report counts only with the lookups its bar requires (skill-lookups.js). ---
test('phase2-facts and roles-ran judge ONE phase-2 report: the latest-ending one, in full and index mode, cached or not', () => {
  const { writeBriefing } = require('../../scripts/lib/trading/briefing');
  const { recordLookup, lookupsFile } = require('../../scripts/lib/trading/skill-lookups');
  const dir = require('../helpers').tmpDir();
  const home = trendHome();
  const file = path.join(dir, 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const T = 1.8e12;
  const timed = (subagent_type, start, end, output = 'report') => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { subagent_type }, output, time: { start: T + start, end: T + end } } } });
  // A reversal candidate (index mode requires lookups of every role), the opening drive, entries allowed.
  writeBriefing(home, { symbol: 'MNQ', closedAt: NOW.toISOString(), sections: { m3: { validUntil: new Date(NOW.getTime() + 60000).toISOString(), data: { window: 'opening drive', windowEntries: 'allowed', news: { inBlackout: false }, candidates: [{ name: 'orb', direction: 'long', trendRule: 'reversal' }] } } } });
  const GOOD = 'VERDICT: APPROVE - size 1\nFACTS: window opening drive; entries allowed';
  const BAD = 'VERDICT: APPROVE - size 1\nFACTS: window opening print; entries allowed';
  const VETO = 'VERDICT: VETO - room';
  const analysts = [timed('market-structure-analyst', 10, 20), timed('trend-momentum-analyst', 10, 20), timed('volume-liquidity-analyst', 10, 20)];
  const lookAll = () => {
    try { fs.unlinkSync(lookupsFile(file)); } catch (_err) { /* none */ }
    const look = (role, skill, at) => recordLookup({ FTH_CYCLE_TRANSCRIPT: file }, { role, skill }, T + at);
    look('market-structure-analyst', 'rejection', 11);
    look('market-structure-analyst', 'pullback-vs-reversal', 12);
    look('trend-momentum-analyst', 'pullback-vs-reversal', 11);
    // The risk manager looks up during A (phase 1) and B, never during C.
    for (const at of [31, 46]) { look('risk-manager', 'confluence-counting', at); look('risk-manager', 'invalidation', at + 1); }
  };
  const write = (c, b) => {
    fs.writeFileSync(file, [...ocSkills, ...analysts, timed('risk-manager', 30, 40, 'Risk state: tradable'), timed('risk-manager', ...c), timed('risk-manager', ...b)].join('\n'));
    lookAll();
  };
  const modes = {
    full: { ...config, home, autonomous: true, cycle: 'full', cycleTranscript: file, roleSkills: 'full' },
    index: { ...config, home, autonomous: true, cycle: 'full', cycleTranscript: file, roleSkills: 'index' },
  };
  for (const [mode, base] of Object.entries(modes)) {
    for (const cached of [[], ['risk-manager']]) {
      const cfg = { ...base, cycleCached: cached };
      const run = () => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: cfg });
      const tag = `${mode} mode, ${cached.length ? 'phase 1 cached' : 'nothing cached'}`;
      // The reviewer's repro: A (30-40), C (an uncounted veto: it started before the analysts and phase 1 returned,
      // ending last at 60), B (45-55, an approval on a false fact). Refused: a later veto overrides, and the facts check
      // never passes B in its place.
      write([15, 60, VETO], [45, 55, BAD]);
      const r = run();
      assert.ok(r.violations.some(v => v.check === 'roles-ran' && /risk-manager phase 2 approving the plan/.test(v.message)), `${tag}: ${JSON.stringify(r.violations)}`);
      // The reverse: B ends last. A false fact refuses on the facts; true facts go.
      write([15, 50, VETO], [45, 55, BAD]);
      const bad = run();
      assert.deepStrictEqual(bad.violations.map(v => v.check), ['phase2-facts'], `${tag}: ${JSON.stringify(bad.violations)}`);
      assert.match(bad.violations[0].message, /contradicts: "window opening print"/);
      write([15, 50, VETO], [45, 55, GOOD]);
      assert.deepStrictEqual(run().violations, [], tag);
      // An uncounted veto ending with the approval: refused.
      write([15, 55, VETO], [45, 55, GOOD]);
      assert.ok(run().violations.some(v => v.check === 'roles-ran'), tag);
    }
  }
});

test('skill lookups: in index mode an entry counts a role\'s report only with the lookups its bar requires; no trigger, no requirement; exits never held', () => {
  const { writeBriefing } = require('../../scripts/lib/trading/briefing');
  const { recordLookup, lookupsFile } = require('../../scripts/lib/trading/skill-lookups');
  const dir = require('../helpers').tmpDir();
  const home = trendHome();
  const file = path.join(dir, 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // opencode's task events carry the call's wall-clock start and end (ms).
  const T = 1.8e12;
  const timed = (subagent_type, start, end) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { subagent_type }, output: 'VERDICT: APPROVE - size 1', time: { start: T + start, end: T + end } } } });
  fs.writeFileSync(file, [...ocSkills, timed('market-structure-analyst', 10, 20), timed('trend-momentum-analyst', 10, 20), timed('volume-liquidity-analyst', 10, 20),
    timed('risk-manager', 10, 18), timed('risk-manager', 30, 40)].join('\n'));
  const brief = candidates => writeBriefing(home, { symbol: 'MNQ', closedAt: NOW.toISOString(), sections: { m3: { validUntil: new Date(NOW.getTime() + 60000).toISOString(), data: { candidates, news: { inBlackout: false } } } } });
  const look = (role, skill, at) => recordLookup({ FTH_CYCLE_TRANSCRIPT: file }, { role, skill }, T + at);
  const reset = () => { try { fs.unlinkSync(lookupsFile(file)); } catch (_err) { /* none */ } };
  const index = { ...config, home, autonomous: true, cycle: 'full', cycleTranscript: file, roleSkills: 'index' };
  // The phase-2 facts check (phase2-facts, fact-claims.js) has its own tests: this one is about the lookups.
  const run = (input, cfg = index) => {
    const r = evaluateOrder({ input, entries: [plan()], now: NOW, config: cfg });
    return { ...r, violations: r.violations.filter(v => v.check !== 'phase2-facts') };
  };
  // A reversal candidate: the roles whose index lists its situational skills (skills-loaded.js SITUATIONAL) looked none up.
  brief([{ name: 'orb', direction: 'long', trendRule: 'reversal' }]);
  const refused = run(entryOrder());
  assert.deepStrictEqual(checks(refused), ['roles-ran']);
  assert.match(refused.violations[0].message, /not returned yet: market-structure-analyst, trend-momentum-analyst \(/);
  assert.match(refused.violations[0].message, /market-structure-analyst reported without looking up pullback-vs-reversal, rejection/);
  assert.doesNotMatch(refused.violations[0].message, /risk-manager reported without/, "the risk manager embeds its situational skills: no lookup is required of it");
  // Full mode (on request, FTH_ROLE_SKILLS=full): no lookup is required.
  assert.deepStrictEqual(run(entryOrder(), { ...index, roleSkills: 'full' }).violations, []);
  // Each role looked its own up during one of its calls (phase 2 for the risk manager): counted.
  const all = () => {
    look('market-structure-analyst', 'rejection', 11);
    look('market-structure-analyst', 'pullback-vs-reversal', 12);
    look('trend-momentum-analyst', 'pullback-vs-reversal', 11);
    look('risk-manager', 'confluence-counting', 31);
    look('risk-manager', 'invalidation', 32);
  };
  all();
  assert.deepStrictEqual(run(entryOrder()).violations, []);
  // One missing (a lookup outside its calls, or under another role's name, doesn't count): that role alone.
  reset();
  all();
  fs.writeFileSync(lookupsFile(file), fs.readFileSync(lookupsFile(file), 'utf8').split('\n').filter(l => !l.includes('"rejection"')).join('\n'));
  look('market-structure-analyst', 'rejection', 25);
  look('trend-momentum-analyst', 'rejection', 15);
  const one = run(entryOrder());
  assert.match(one.violations[0].message, /not returned yet: market-structure-analyst \(market-structure-analyst reported without looking up rejection/);
  // A with-trend candidate requires the breakout skills of the structure analyst instead.
  reset();
  brief([{ name: 'orb', direction: 'long', trendRule: 'allows' }]);
  look('risk-manager', 'confluence-counting', 31);
  look('risk-manager', 'invalidation', 32);
  assert.match(run(entryOrder()).violations[0].message, /not returned yet: market-structure-analyst \(market-structure-analyst reported without looking up breakout-vs-fakeout, breakout(?![\w-])/);
  look('market-structure-analyst', 'breakout', 11);
  look('market-structure-analyst', 'breakout-vs-fakeout', 11);
  assert.deepStrictEqual(run(entryOrder()).violations, []);
  // No trigger (no candidate on the bar): nothing is required.
  reset();
  brief([]);
  assert.deepStrictEqual(run(entryOrder()).violations, []);
  // Exits and protective stops are never held, whatever was looked up.
  brief([{ name: 'orb', direction: 'long', trendRule: 'reversal' }]);
  assert.deepStrictEqual(run(entryOrder({ rationale: '[exit] flatten' })).violations, []);
  assert.deepStrictEqual(run(entryOrder({ rationale: '[protect] stop for the long' })).violations, []);
  // Reports served from the cache (only phase 2 ran this cycle): a cached report counts only with the lookups its own
  // call made (cycleCachedLookups, from the runner's FTH_CYCLE_CACHED_LOOKUPS); none recorded, or another role's: refused.
  const p2 = path.join(dir, 'logs', 'cycle-transcript-p2.jsonl');
  fs.writeFileSync(p2, [...ocSkills, timed('risk-manager', 30, 40)].join('\n'));
  const cachedCfg = lookups => ({ ...index, cycleTranscript: p2, cycleCached: ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'], cycleCachedLookups: lookups });
  // The facts key the requirement comes from: this bar's briefing m3 version (no other lane).
  const versioned = (version, candidates) => writeBriefing(home, { symbol: 'MNQ', closedAt: NOW.toISOString(), sections: { m3: { version, validUntil: new Date(NOW.getTime() + 60000).toISOString(), data: { candidates, news: { inBlackout: false } } } } });
  const KEY = 'm3@bar-n';
  versioned(KEY, [{ name: 'orb', direction: 'long', trendRule: 'reversal' }]);
  const keyed = (o, key = KEY) => Object.fromEntries(Object.entries(o).map(([r, skills]) => [r, { skills, key }]));
  const met = keyed({ 'market-structure-analyst': ['pullback-vs-reversal', 'rejection'], 'trend-momentum-analyst': ['pullback-vs-reversal'] });
  assert.deepStrictEqual(run(entryOrder(), cachedCfg(met)).violations, []);
  for (const lookups of [{}, undefined, keyed({ 'trend-momentum-analyst': ['pullback-vs-reversal'] }), keyed({ 'volume-liquidity-analyst': ['pullback-vs-reversal', 'rejection'], 'trend-momentum-analyst': ['pullback-vs-reversal'] }),
    keyed({ 'market-structure-analyst': ['pullback-vs-reversal', 'rejection'], 'trend-momentum-analyst': ['pullback-vs-reversal'] }, 'm3@bar-earlier')]) {
    const r = run(entryOrder(), cachedCfg(lookups));
    assert.deepStrictEqual(checks(r), ['roles-ran'], JSON.stringify(lookups));
    assert.match(r.violations[0].message, /market-structure-analyst was served from the report cache, which made no lookup of pullback-vs-reversal, rejection/);
  }
  // The reviewer's case: lookups made on an earlier bar (another key) are not credited to a candidate on this one,
  // nor are this bar's once another lane's bar closed (its candidates join the requirement).
  versioned('m3@bar-n3', [{ name: 'orb', direction: 'long', trendRule: 'reversal' }]);
  assert.match(run(entryOrder(), cachedCfg(met)).violations[0].message, /market-structure-analyst was served from the report cache/);
  versioned(KEY, [{ name: 'orb', direction: 'long', trendRule: 'reversal' }]);
  assert.match(run(entryOrder(), { ...cachedCfg(met), cycleLaneBars: { MNQ: { 1: '2026-10-07T13:59:00.000Z' } } }).violations.map(v => v.message).join(' '), /served from the report cache/);
  // A briefing without a version: no key, nothing credited (fails closed).
  versioned(undefined, [{ name: 'orb', direction: 'long', trendRule: 'reversal' }]);
  assert.match(run(entryOrder(), cachedCfg(met)).violations[0].message, /served from the report cache/);
  versioned(KEY, [{ name: 'orb', direction: 'long', trendRule: 'reversal' }]);
  // From the environment the runner sets: the same.
  const fromEnv = loadConfig({ FTH_CYCLE_CACHED: 'market-structure-analyst,trend-momentum-analyst,volume-liquidity-analyst,risk-manager', FTH_CYCLE_CACHED_LOOKUPS: JSON.stringify(met) });
  assert.deepStrictEqual(run(entryOrder(), cachedCfg(fromEnv.cycleCachedLookups)).violations, []);
  // Exits never held by it.
  assert.deepStrictEqual(run(entryOrder({ rationale: '[exit] flatten' }), cachedCfg({})).violations, []);
});

test('index mode is the default: with no FTH_ROLE_SKILLS set an autonomous entry needs the lookups its bar requires; exits, protective stops, stop moves, cancels and closes are never held', () => {
  const { writeBriefing } = require('../../scripts/lib/trading/briefing');
  const { recordLookup } = require('../../scripts/lib/trading/skill-lookups');
  const { evaluateModify } = require('../../scripts/lib/trading/order-gate');
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const { orderTool } = require('../../scripts/lib/trading/mcp-gateway');
  const dir = require('../helpers').tmpDir();
  const home = trendHome();
  const file = path.join(dir, 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const T = 1.8e12;
  const timed = (subagent_type, start, end) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { subagent_type }, output: 'VERDICT: APPROVE - size 1', time: { start: T + start, end: T + end } } } });
  fs.writeFileSync(file, [...ocSkills, timed('market-structure-analyst', 10, 20), timed('trend-momentum-analyst', 10, 20), timed('volume-liquidity-analyst', 10, 20),
    timed('risk-manager', 10, 18), timed('risk-manager', 30, 40)].join('\n'));
  // A reversal candidate on this bar: every role that indexes its situational skills must look them up.
  writeBriefing(home, { symbol: 'MNQ', closedAt: NOW.toISOString(), sections: { m3: { validUntil: new Date(NOW.getTime() + 60000).toISOString(), data: { candidates: [{ name: 'orb', direction: 'long', trendRule: 'reversal' }], news: { inBlackout: false } } } } });
  // The gate's config as the runner's environment gives it, with no FTH_ROLE_SKILLS: index.
  const env = { FTH_HOME: home, FTH_AUTONOMOUS: '1', FTH_CYCLE: 'full', FTH_CYCLE_TRANSCRIPT: file };
  const fromEnv = loadConfig(env);
  assert.strictEqual(fromEnv.roleSkills, 'index');
  const cfg = { ...config, ...fromEnv, killSwitchFile: config.killSwitchFile, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9, home };
  const run = input => {
    const r = evaluateOrder({ input, entries: [plan()], now: NOW, config: cfg });
    return { ...r, violations: r.violations.filter(v => v.check !== 'phase2-facts') };
  };
  // The entry: refused, the roles' reports don't count without their lookups.
  const refused = run(entryOrder());
  assert.deepStrictEqual(checks(refused), ['roles-ran']);
  assert.match(refused.violations[0].message, /market-structure-analyst reported without looking up pullback-vs-reversal, rejection/);
  assert.doesNotMatch(refused.violations[0].message, /risk-manager reported without/, "the risk manager embeds its situational skills: no lookup is required of it");
  // Never held by a missing lookup: an exit and a protective stop (place_order), a stop move and a risk-reducing size
  // cut (modify_order), a cancel and a partial close (the gateway's account checks only), and close_position (never
  // gated: not an order tool of the gateway's).
  assert.deepStrictEqual(run(entryOrder({ side: 'sell', rationale: '[exit] flatten', stopLossBracket: undefined })).violations, []);
  assert.deepStrictEqual(run(entryOrder({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long', stopLossBracket: undefined })).violations, []);
  assert.deepStrictEqual(evaluateModify({ input: { accountId: 1, orderId: 7, stopPrice: 21490 }, config: cfg }).violations, []);
  assert.deepStrictEqual(evaluateModify({ input: { accountId: 1, orderId: 7, size: 1, reason: '[exit] partial taken' }, config: cfg }).violations, []);
  for (const tool of ['cancel_order', 'partial_close_position']) {
    const r = checkOrder({ accountId: 1, orderId: 7, contractId: CONTRACT, size: 1 }, { env, pluginRoot: path.resolve(__dirname, '..', '..'), now: NOW, tool });
    assert.strictEqual(r.allowed, true, `${tool}: ${r.message}`);
  }
  assert.strictEqual(orderTool({ method: 'tools/call', params: { name: 'mcp__broker__close_position', arguments: {} } }), null);
  // The lookups made during the roles' calls: the entry goes.
  const look = (role, skill, at) => recordLookup({ FTH_CYCLE_TRANSCRIPT: file }, { role, skill }, T + at);
  look('market-structure-analyst', 'rejection', 11);
  look('market-structure-analyst', 'pullback-vs-reversal', 12);
  look('trend-momentum-analyst', 'pullback-vs-reversal', 11);
  look('risk-manager', 'confluence-counting', 31);
  look('risk-manager', 'invalidation', 32);
  assert.deepStrictEqual(run(entryOrder()).violations, []);
});

test('index mode, several lanes: a closed lane\'s candidates require the lookups too (its briefing on its bar, else its signal record on its bar, else every lookup); exits never held', () => {
  const { writeBriefing, writeFrameBriefing } = require('../../scripts/lib/trading/briefing');
  const { recordLookup, lookupsFile } = require('../../scripts/lib/trading/skill-lookups');
  const { writeSignals } = require('../../scripts/lib/trading/signal-state');
  const dir = require('../helpers').tmpDir();
  const home = trendHome();
  const file = path.join(dir, 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const T = 1.8e12;
  const timed = (subagent_type, start, end) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { subagent_type }, output: 'VERDICT: APPROVE - size 1', time: { start: T + start, end: T + end } } } });
  fs.writeFileSync(file, [...ocSkills, timed('market-structure-analyst', 10, 20), timed('trend-momentum-analyst', 10, 20), timed('volume-liquidity-analyst', 10, 20),
    timed('risk-manager', 10, 18), timed('risk-manager', 30, 40)].join('\n'));
  // The 3m (runner's) briefing: no candidate. The 1m lane's bar, which closed this cycle, at 13:59.
  writeBriefing(home, { symbol: 'MNQ', closedAt: NOW.toISOString(), minutes: 3, sections: { m3: { validUntil: new Date(NOW.getTime() + 60000).toISOString(), data: { candidates: [], news: { inBlackout: false } } } } });
  const lane = '2026-10-07T13:59:00.000Z';
  const frame = (asOf, candidates) => writeFrameBriefing(home, { symbol: 'MNQ', minutes: 1, asOf, closedAt: NOW.toISOString(), sections: { bar: { validUntil: new Date(NOW.getTime() + 60000).toISOString(), data: { candidates } } } });
  // The gate's config as the runner's environment gives it (FTH_CYCLE_LANE_BARS from the cycle's lanes), default mode.
  const env = { FTH_HOME: home, FTH_AUTONOMOUS: '1', FTH_CYCLE: 'full', FTH_CYCLE_TRANSCRIPT: file, FTH_CYCLE_LANE_BARS: JSON.stringify({ MNQ: { 1: lane, 3: '2026-10-07T13:57:00.000Z' } }) };
  const fromEnv = loadConfig(env);
  assert.deepStrictEqual(fromEnv.cycleLaneBars, { MNQ: { 1: lane, 3: '2026-10-07T13:57:00.000Z' } });
  const cfg = { ...config, ...fromEnv, killSwitchFile: config.killSwitchFile, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9, home };
  const run = (input, c = cfg) => {
    const r = evaluateOrder({ input, entries: [plan()], now: NOW, config: c });
    return { ...r, violations: r.violations.filter(v => v.check !== 'phase2-facts') };
  };
  const exits = () => {
    assert.deepStrictEqual(run(entryOrder({ side: 'sell', rationale: '[exit] flatten', stopLossBracket: undefined })).violations, []);
    assert.deepStrictEqual(run(entryOrder({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long', stopLossBracket: undefined })).violations, []);
  };
  // The reviewer's repro: the 1m lane's briefing on its bar shows a reversal candidate; no lookups: refused.
  frame(lane, [{ name: 'tick_up', direction: 'long', trendRule: 'reversal' }]);
  const refused = run(entryOrder());
  assert.deepStrictEqual(checks(refused), ['roles-ran']);
  assert.match(refused.violations[0].message, /market-structure-analyst reported without looking up pullback-vs-reversal, rejection/);
  assert.doesNotMatch(refused.violations[0].message, /risk-manager reported without/, "the risk manager embeds its situational skills: no lookup is required of it");
  // Without the lane (one lane, or the lane's bar didn't close this cycle): the 3m briefing alone, nothing required.
  assert.deepStrictEqual(run(entryOrder(), { ...cfg, cycleLaneBars: {} }).violations, []);
  exits();
  // The lookups made during the roles' calls: the entry goes.
  const look = (role, skill, at) => recordLookup({ FTH_CYCLE_TRANSCRIPT: file }, { role, skill }, T + at);
  const all = () => {
    look('market-structure-analyst', 'rejection', 11);
    look('market-structure-analyst', 'pullback-vs-reversal', 12);
    look('trend-momentum-analyst', 'pullback-vs-reversal', 11);
    look('risk-manager', 'confluence-counting', 31);
    look('risk-manager', 'invalidation', 32);
  };
  all();
  assert.deepStrictEqual(run(entryOrder()).violations, []);
  fs.unlinkSync(lookupsFile(file));
  // The lane's briefing is another bar's (or none: no analyst reads 1m): its signal record on the bar decides, its
  // setups with their trend rules (signal-state.js buildSignals).
  frame('2026-10-07T13:58:00.000Z', []);
  const record = extra => writeSignals(home, { symbol: 'MNQ', timeframe: '1m', asOf: lane, closedAt: NOW.toISOString(), candidates: [{ name: 'tick_up', direction: 'long' }], ...extra });
  const unmet = r => r.violations.length ? r.violations[0].message : '';
  // A reversal setup: the reversal lookups only (never the breakout ones).
  record({ setups: [{ name: 'tick_up', direction: 'long', trendRule: 'reversal' }] });
  const rev = unmet(run(entryOrder()));
  assert.match(rev, /market-structure-analyst reported without looking up pullback-vs-reversal, rejection \(/);
  assert.match(rev, /trend-momentum-analyst reported without looking up pullback-vs-reversal \(/);
  assert.doesNotMatch(rev, /risk-manager reported without/);
  assert.doesNotMatch(rev, /breakout-vs-fakeout|(?<![\w-])breakout(?![\w-])/);
  all();
  assert.deepStrictEqual(run(entryOrder()).violations, [], 'the reversal lookups made: it goes');
  fs.unlinkSync(lookupsFile(file));
  // A with-trend setup: the breakout lookups only.
  record({ setups: [{ name: 'tick_up', direction: 'long', trendRule: 'allows' }] });
  const allows = unmet(run(entryOrder()));
  assert.match(allows, /market-structure-analyst reported without looking up breakout-vs-fakeout, breakout \(/);
  assert.doesNotMatch(allows, /pullback-vs-reversal|(?<![\w-])rejection(?![\w-])|trend-momentum-analyst reported/);
  look('market-structure-analyst', 'breakout-vs-fakeout', 11);
  look('market-structure-analyst', 'breakout', 12);
  look('risk-manager', 'confluence-counting', 31);
  look('risk-manager', 'invalidation', 32);
  assert.deepStrictEqual(run(entryOrder()).violations, [], 'the breakout lookups made: it goes');
  fs.unlinkSync(lookupsFile(file));
  exits();
  // A record from before the setups were kept (no setups field): its candidates under every trend rule (fails closed).
  record({});
  assert.match(unmet(run(entryOrder())), /market-structure-analyst reported without looking up pullback-vs-reversal, breakout-vs-fakeout, rejection, breakout/);
  exits();
  // Nothing fired on the lane's bar (its record says so): nothing more is required.
  writeSignals(home, { symbol: 'MNQ', timeframe: '1m', asOf: lane, closedAt: NOW.toISOString(), candidates: [], setups: [] });
  assert.deepStrictEqual(run(entryOrder()).violations, []);
  // Neither on the lane's bar (the record is an older bar's): every situational lookup is required (fails closed).
  writeSignals(home, { symbol: 'MNQ', timeframe: '1m', asOf: '2026-10-07T13:58:00.000Z', closedAt: '2026-10-07T13:59:00.000Z', candidates: [], setups: [] });
  const closed = run(entryOrder());
  assert.match(closed.violations[0].message, /market-structure-analyst reported without looking up/);
  exits();
  // FTH_CYCLE_LANE_BARS set but unreadable: the lanes are unknown, every lookup is required (fails closed), even with
  // the lane's bar recorded as quiet; unset or blank is one lane.
  writeSignals(home, { symbol: 'MNQ', timeframe: '1m', asOf: lane, closedAt: NOW.toISOString(), candidates: [], setups: [] });
  for (const raw of ['not json', '[]', JSON.stringify({ MNQ: { x: lane } }), JSON.stringify({ MNQ: { 1: 7 } }), JSON.stringify({ MES: [] })]) {
    assert.strictEqual(loadConfig({ FTH_CYCLE_LANE_BARS: raw }).cycleLaneBars, null, raw);
    const r = run(entryOrder(), { ...cfg, ...loadConfig({ ...env, FTH_CYCLE_LANE_BARS: raw }), killSwitchFile: config.killSwitchFile, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9, home });
    assert.match(unmet(r), /market-structure-analyst reported without looking up pullback-vs-reversal, breakout-vs-fakeout, rejection, breakout/, raw);
  }
  for (const raw of [undefined, '', ' ']) assert.deepStrictEqual(loadConfig(raw === undefined ? {} : { FTH_CYCLE_LANE_BARS: raw }).cycleLaneBars, {});
  exits();
});

test('a session that isn\'t autonomous: no situational skill is required of the head trader, in the default (index) mode too', () => {
  const { writeBriefing } = require('../../scripts/lib/trading/briefing');
  const { SITUATIONAL } = require('../../scripts/lib/trading/skills-loaded');
  const home = trendHome();
  const file = path.join(require('../helpers').tmpDir(), 'session.jsonl');
  fs.writeFileSync(file, ocSkills.join('\n'));
  writeBriefing(home, { symbol: 'MNQ', closedAt: NOW.toISOString(), sections: { m3: { validUntil: new Date(NOW.getTime() + 60000).toISOString(), data: { candidates: [{ name: 'orb', direction: 'long', trendRule: 'reversal' }], news: { inBlackout: false } } } } });
  // A situational skill marked for the head trader (none ships yet): what the guard keeps out of interactive sessions.
  const entry = { when: 'candidate', skill: 'session-timing', head: true };
  SITUATIONAL.push(entry);
  try {
    const interactive = { ...config, ...loadConfig({ FTH_HOME: home }), killSwitchFile: config.killSwitchFile, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9, home };
    assert.strictEqual(interactive.roleSkills, 'index');
    assert.strictEqual(interactive.autonomous, false);
    const run = c => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: c, transcriptPath: file }).violations;
    assert.deepStrictEqual(run(interactive), [], 'interactive: the head skill is not required');
    // The same table in an autonomous cycle requires it (the table works; only the guard keeps it out above).
    const auto = run({ ...interactive, autonomous: true, cycle: null });
    assert.ok(auto.some(v => v.check === 'skills-loaded' && /session-timing/.test(v.message)), JSON.stringify(auto));
  } finally {
    SITUATIONAL.splice(SITUATIONAL.indexOf(entry), 1);
  }
});

test('account gate across a contract roll: an [exit], [protect] or partial close matches the position\'s contract exactly, named from one read of today\'s front month; never by a stale root alias', () => {
  const { evaluateAccount, evaluateAccountChange } = require('../../scripts/lib/trading/account-gate');
  const { canonicalName } = require('../../scripts/lib/broker/translator');
  const ids = { 'b-Z6': { root: 'MNQ', month: '2026-12' }, 'b-H7': { root: 'MNQ', month: '2027-03' } };
  const yesterday = { ids, front: { MNQ: { id: 'b-Z6', month: '2026-12', day: '2026-10-06' } } };
  const today = { ids, front: { MNQ: { id: 'b-H7', month: '2027-03', day: '2026-10-07' } } };
  const day = '2026-10-07';
  const name = (cache, id) => canonicalName(id, cache, day);
  const exit = (contractId, extra = {}) => ({ accountId: 1, contractId, side: 'sell', type: 'market', size: 1, rationale: '[exit] flatten', ...extra });
  const facts = (cache, ...held) => ({ positions: held.map(id => ({ contractId: name(cache, id), type: 1, size: 1 })), orders: [], trades: [] });
  const account = (cache, sent, ...held) => evaluateAccount({ input: exit(name(cache, sent)), ...facts(cache, ...held), config, now: NOW }).map(v => v.check);
  const partial = (cache, sent, ...held) => evaluateAccountChange('partial_close_position', { input: { accountId: 1, contractId: name(cache, sent), size: 1 }, ...facts(cache, ...held), config, now: NOW }).map(v => v.check);
  // A: long March; December named, with yesterday's or today's front month: refused (a December sell would open a short).
  for (const cache of [yesterday, today]) assert.deepStrictEqual(account(cache, 'MNQ:2026-12', 'b-H7'), ['exposure']);
  // B: the March long's partial close by its month: allowed, whichever front month is on file.
  for (const cache of [yesterday, today]) assert.deepStrictEqual(partial(cache, 'MNQ:2027-03', 'b-H7'), []);
  // The root is today's front month only: after the roll MNQ is March.
  assert.deepStrictEqual(account(today, 'MNQ', 'b-H7'), []);
  assert.deepStrictEqual(account(today, 'MNQ', 'b-Z6'), ['exposure'], 'an old-month long is not exited by the root');
  assert.deepStrictEqual(account(yesterday, 'MNQ', 'b-Z6'), ['exposure'], 'yesterday\'s front month is not the root today');
  // An old-month position still open after the roll: exited by its month; a protective stop there goes too.
  assert.deepStrictEqual(account(today, 'MNQ:2026-12', 'b-Z6'), []);
  assert.deepStrictEqual(partial(today, 'MNQ:2026-12', 'b-Z6'), []);
  const stop = evaluateAccount({ input: exit(name(today, 'MNQ:2026-12'), { type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the December long' }), ...facts(today, 'b-Z6'), config, now: NOW });
  assert.deepStrictEqual(stop, []);
  // A buy [exit] on a month with no short would open a long: refused.
  assert.deepStrictEqual(evaluateAccount({ input: exit(name(today, 'MNQ:2026-12'), { side: 'buy' }), ...facts(today, 'b-H7'), config, now: NOW }).map(v => v.check), ['exposure']);
});

test('account gate: a ledger entry kept by its month (never a root) is not counted against the next day\'s front month, so the March long\'s only stop can\'t be cancelled', () => {
  const { evaluateAccountChange, ledgerName } = require('../../scripts/lib/trading/account-gate');
  const { canonicalName, monthName } = require('../../scripts/lib/broker/translator');
  const ids = { 'b-Z6': { root: 'MNQ', month: '2026-12' }, 'b-H7': { root: 'MNQ', month: '2027-03' } };
  // A December exit sent as MNQ on 2026-10-07 (December the front month) and still resting...
  const before = { ids, front: { MNQ: { id: 'b-Z6', month: '2026-12', day: '2026-10-07' } } };
  const sent = { contractId: 'MNQ', [Symbol.for('fth.gate.month')]: monthName('MNQ', before, '2026-10-07') };
  const kept = ledgerName(sent);
  assert.strictEqual(kept, 'MNQ:2026-12');
  // ...checked on 2026-10-08, March the front month, a March long MNQ with stop 9.
  const after = { ids, front: { MNQ: { id: 'b-H7', month: '2027-03', day: '2026-10-08' } } };
  const names = id => canonicalName(id, after, '2026-10-08');
  const input = { orderId: 9, [Symbol.for('fth.gate.names')]: names };
  const positions = [{ contractId: 'MNQ', type: 1, size: 1 }];
  const orders = [{ id: 9, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 21480 }];
  const now = new Date('2026-10-08T14:30:00Z');
  const entry = c => [{ contractId: c, sign: -1, size: 1, netBefore: 1, rootNetBefore: 1, at: now.getTime(), sentAt: now.getTime() }];
  const cancel = ledger => evaluateAccountChange('cancel_order', { input, positions, orders, config, now, ledger, cancelLedger: ledger }).map(v => v.check);
  assert.deepStrictEqual(cancel([]), ['cancel-protection']);
  assert.deepStrictEqual(cancel(entry(kept)), ['cancel-protection'], 'kept by its month: December, not March');
  assert.deepStrictEqual(cancel(entry('MNQ')), [], 'the bare root it used to keep counted against March (the bug)');
});

test('an unreadable lanes list (FTH_CYCLE_LANE_BARS): every situational skill marked for the head trader is required, whatever the briefing shows', () => {
  const { writeBriefing } = require('../../scripts/lib/trading/briefing');
  const { SITUATIONAL, headSituationalSkills } = require('../../scripts/lib/trading/skills-loaded');
  const home = trendHome();
  const file = path.join(require('../helpers').tmpDir(), 'session.jsonl');
  fs.writeFileSync(file, ocSkills.join('\n'));
  // No candidate on the bar: a readable lanes list requires nothing more of the head trader.
  writeBriefing(home, { symbol: 'MNQ', closedAt: NOW.toISOString(), sections: { m3: { validUntil: new Date(NOW.getTime() + 60000).toISOString(), data: { candidates: [], news: { inBlackout: false } } } } });
  const entry = { when: 'candidate.trendRule=reversal', skill: 'session-timing', head: true };
  SITUATIONAL.push(entry);
  try {
    assert.deepStrictEqual(headSituationalSkills(), ['session-timing']);
    const base = { ...config, ...loadConfig({ FTH_HOME: home }), killSwitchFile: config.killSwitchFile, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9, home, autonomous: true, cycle: null };
    const skillsLoaded = c => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: c, transcriptPath: file }).violations.filter(v => v.check === 'skills-loaded');
    assert.deepStrictEqual(skillsLoaded({ ...base, cycleLaneBars: {} }), [], 'lanes readable, no trigger: not required');
    const unreadable = skillsLoaded({ ...base, cycleLaneBars: loadConfig({ FTH_CYCLE_LANE_BARS: 'not json' }).cycleLaneBars });
    assert.ok(unreadable.length === 1 && /session-timing/.test(unreadable[0].message), JSON.stringify(unreadable));
    // An exit is never held.
    assert.deepStrictEqual(evaluateOrder({ input: entryOrder({ side: 'sell', rationale: '[exit] flatten', stopLossBracket: undefined }), entries: [plan()], now: NOW, config: { ...base, cycleLaneBars: null }, transcriptPath: file }).violations, []);
  } finally {
    SITUATIONAL.splice(SITUATIONAL.indexOf(entry), 1);
  }
});

// --- opencode's head trader in index mode: its embedded skills count as loaded only on the runner's attestation
// (head-prompt.js), checked against the run's config file; anything off falls back to the transcript. ---

/** A run's workspace with the generated index-mode opencode.json, its attestation, and an opencode cycle transcript. */
function headRun() {
  const H = require('../../scripts/lib/head-prompt');
  const HS = require('../../scripts/lib/harness-sync');
  const root = path.resolve(__dirname, '..', '..');
  const dir = require('../helpers').tmpDir();
  const configFile = path.join(dir, 'workspace', 'opencode.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const generated = HS.expectedFiles(root)['workspace/opencode.json'];
  fs.writeFileSync(configFile, generated);
  const att = H.attestation(configFile, root);
  const transcript = path.join(dir, 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  // An opencode stream whose session loaded no skill by tool: the head trader read its prompt's, and looked up the
  // strategy skills a rules entry (these tests' setup:orb) needs beyond it (the prompt embeds the composed entry's).
  const lookedUp = ['strategy-library', 'strategy-scan', 'strategy-gate-checks'].map(skill => ocEvent('harness_skill_lookup', { skill }).replace('VERDICT: APPROVE - size 1', `<skill name=\\"${skill}\\">...`));
  fs.writeFileSync(transcript, [JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 's', part: { type: 'step-start' } }), ocEvent('harness_bar_briefing', { symbol: 'MNQ' }), ...lookedUp].join('\n'));
  const cfg = { ...config, autonomous: true, roleSkills: 'index', cycleTranscript: transcript, headPromptAttestation: JSON.stringify(att) };
  return { H, root, dir, configFile, generated, att, transcript, cfg };
}
const skillChecks = r => checks(r).filter(c => c.startsWith('skills-'));
const headGate = (cfg, input = entryOrder(), extra = {}) => evaluateOrder({ input, entries: [plan()], now: NOW, config: cfg, ...extra });
const HEAD_RISK_REDUCING = ['[exit] flatten', '[protect] stop for the long at 21480', '[exit] cut size to 1'];

test('head prompt (gate): the attested, verified embedded skills count as loaded for the runner\'s opencode transcript in index mode', () => {
  const { att, cfg } = headRun();
  const { REQUIRED_FOR_COMPOSED, REQUIRED_AT_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  for (const s of [...REQUIRED_FOR_COMPOSED, ...REQUIRED_AT_ENTRY]) assert.ok(att.skills.includes(s), `attested: ${s}`);
  assert.deepStrictEqual(skillChecks(headGate(cfg)), []);
  // Without the attestation the same session is refused for every one of them: the transcript alone decides.
  const none = headGate({ ...cfg, headPromptAttestation: null });
  assert.deepStrictEqual(skillChecks(none), ['skills-at-entry', 'skills-loaded']);
  assert.match(none.violations.find(v => v.check === 'skills-loaded').message, /not loaded in this session: trade-session, multi-timeframe-analysis\. Load each with the skill tool \(or skill_lookup, without one/);
});

test('head prompt (gate): never fails open: interactive, full mode, a hook\'s transcript, another harness\'s transcript, a bad or forged attestation, a changed file or skill', () => {
  const { H, root, configFile, generated, att, transcript, cfg } = headRun();
  const refusedBoth = (label, c, extra) => {
    const r = headGate(c, entryOrder(), extra);
    assert.deepStrictEqual(skillChecks(r), ['skills-at-entry', 'skills-loaded'], label);
    // Exits, protective stops and size cuts are never held by it.
    for (const rationale of HEAD_RISK_REDUCING) assert.deepStrictEqual(skillChecks(headGate(c, entryOrder({ rationale }), extra)), [], `${label}: ${rationale}`);
  };
  refusedBoth('interactive (not autonomous)', { ...cfg, autonomous: false });
  refusedBoth('full mode', { ...cfg, roleSkills: 'full' });
  // A hook's transcript (Claude Code, Qwen Code: transcript_path) is another harness's session: the attestation never applies.
  refusedBoth('a hook transcript', cfg, { transcriptPath: transcript });
  // The cycle transcript isn't opencode's (a Claude run carrying the variable): ignored.
  const claudeFile = path.join(path.dirname(transcript), 'claude.jsonl');
  fs.writeFileSync(claudeFile, JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }));
  refusedBoth('a Claude stream', { ...cfg, cycleTranscript: claudeFile });
  fs.writeFileSync(claudeFile, '');
  refusedBoth('an empty transcript', { ...cfg, cycleTranscript: claudeFile });
  // Malformed attestations.
  for (const bad of ['{', '[]', '"x"', JSON.stringify({ ...att, sha256: 'abc' }), JSON.stringify({ ...att, skills: [] }), JSON.stringify({ ...att, skills: ['../x'] }), JSON.stringify({ ...att, config: 'workspace/opencode.json' }), JSON.stringify({ ...att, config: path.join(path.dirname(configFile), 'other.json') }), JSON.stringify({ ...att, config: `${configFile}.gone` })]) {
    refusedBoth(`attestation ${bad.slice(0, 60)}`, { ...cfg, headPromptAttestation: bad });
  }
  // The file changed after the runner hashed it (one character of the head prompt): no skill counts.
  const json = JSON.parse(generated);
  json.agent['fth-head-trader'].prompt = json.agent['fth-head-trader'].prompt.replace('Read them here', 'Read them  here');
  fs.writeFileSync(configFile, JSON.stringify(json));
  refusedBoth('a changed file', cfg);
  // A forged attestation that hashes the changed file: it still must embed each skill's current text whole.
  json.agent['fth-head-trader'].prompt = json.agent['fth-head-trader'].prompt.replace(/<skill name="trade-plan">\n[^]*?\n<\/skill>/, '<skill name="trade-plan">\nPlan anything.\n</skill>');
  fs.writeFileSync(configFile, JSON.stringify(json));
  const forged = { ...att, sha256: H.sha256(json.agent['fth-head-trader'].prompt) };
  const r = headGate({ ...cfg, headPromptAttestation: JSON.stringify(forged) });
  assert.deepStrictEqual(skillChecks(r), ['skills-at-entry']);
  assert.match(r.violations.find(v => v.check === 'skills-at-entry').message, /not read in this session: trade-plan\./);
  // A skill the attestation names but the file doesn't embed (role-index skills are only listed) is not counted.
  assert.deepStrictEqual(H.attestedSkills({ ...forged, skills: ['trade-session', 'absorption'] }, root, { transcript }), ['trade-session']);
  // The attested file unreadable: none.
  fs.writeFileSync(configFile, '{ not json');
  refusedBoth('an unreadable file', cfg);
  fs.writeFileSync(configFile, generated);
  assert.deepStrictEqual(skillChecks(headGate(cfg)), [], 'restored: counted again');
  // A skill that isn't attested still needs its load (a situational one the briefing triggers, or one the runner left out).
  const partial = { ...att, skills: att.skills.filter(s => s !== 'trade-session') };
  const p = headGate({ ...cfg, headPromptAttestation: JSON.stringify(partial) });
  assert.deepStrictEqual(skillChecks(p), ['skills-loaded']);
  assert.match(p.violations[0].message, /not loaded in this session: trade-session\./);
  // ... and a skill_lookup in the transcript for it counts, as before.
  fs.appendFileSync(transcript, `\n${ocEvent('harness_skill_lookup', { skill: 'trade-session' }).replace('VERDICT: APPROVE - size 1', '<skill name=\\"trade-session\\">...')}`);
  assert.deepStrictEqual(skillChecks(headGate({ ...cfg, headPromptAttestation: JSON.stringify(partial) })), []);
});

test('head prompt (gateway): checkOrder counts the attested skills for the runner\'s opencode cycle in index mode, and only there; an exit is never gated', () => {
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const { att, transcript, dir } = headRun();
  const has = (r, check) => r.violations.some(v => v.check === check);
  const base = { FTH_HOME: dir, FTH_CYCLE_TRANSCRIPT: transcript, FTH_AUTONOMOUS: '1', FTH_SYMBOLS: 'MNQ' };
  const run = (env, input = entryOrder()) => checkOrder(input, { env, pluginRoot: path.resolve(__dirname, '..', '..'), now: NOW });
  const ok = run({ ...base, FTH_HEAD_PROMPT: JSON.stringify(att) });
  assert.ok(!has(ok, 'skills-loaded') && !has(ok, 'skills-at-entry'), ok.message);
  for (const [label, env] of [
    ['no attestation', base],
    ['full mode', { ...base, FTH_ROLE_SKILLS: 'full', FTH_HEAD_PROMPT: JSON.stringify(att) }],
    ['not autonomous', { ...base, FTH_AUTONOMOUS: '', FTH_HEAD_PROMPT: JSON.stringify(att) }],
    ['a forged hash', { ...base, FTH_HEAD_PROMPT: JSON.stringify({ ...att, sha256: '0'.repeat(64) }) }],
  ]) {
    const r = run(env);
    assert.ok(has(r, 'skills-loaded') && has(r, 'skills-at-entry'), `${label}: ${r.message}`);
    const exit = run(env, entryOrder({ side: 'sell', rationale: '[exit] flatten', stopLossBracket: undefined }));
    assert.ok(!has(exit, 'skills-loaded') && !has(exit, 'skills-at-entry'), label);
  }
});

test('index mode, a long cycle: the briefing of the cycle\'s bar (FTH_CYCLE_BARS, or FTH_CYCLE_BRIEFING_BARS with lanes) decides the lookups and the cached key past its validUntil; another bar\'s, or none named, fails closed; exits never held', () => {
  const { writeBriefing } = require('../../scripts/lib/trading/briefing');
  const { recordLookup } = require('../../scripts/lib/trading/skill-lookups');
  const dir = require('../helpers').tmpDir();
  const home = trendHome();
  const file = path.join(dir, 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const T = 1.8e12;
  const timed = (subagent_type, start, end) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { subagent_type }, output: 'VERDICT: APPROVE - size 1', time: { start: T + start, end: T + end } } } });
  fs.writeFileSync(file, [...ocSkills, timed('market-structure-analyst', 10, 20), timed('trend-momentum-analyst', 10, 20), timed('volume-liquidity-analyst', 10, 20),
    timed('risk-manager', 10, 18), timed('risk-manager', 30, 40)].join('\n'));
  // The cycle's bar opened 13:57 and its briefing held until just before NOW; the delegated cycle's executor calls
  // minutes later (the wall clock, live), so the briefing is no longer current at the gate's now.
  const CYCLE_BAR = '2026-10-07T13:57:00.000Z';
  // (8 minutes: within the stale-data cap of 3 bars, 9 minutes on 3m; briefing-age has its own test.)
  const late = new Date(NOW.getTime() + 8 * 60000);
  const brief = asOf => writeBriefing(home, { symbol: 'MNQ', closedAt: NOW.toISOString(), asOf, sections: { m3: { version: `m3@${asOf}`, validUntil: new Date(NOW.getTime() - 1000).toISOString(), data: { window: 'opening drive', windowEntries: 'allowed', candidates: [{ name: 'orb', direction: 'long', trendRule: 'reversal' }], news: { inBlackout: false } } } } });
  brief(CYCLE_BAR);
  const look = (role, skill, at) => recordLookup({ FTH_CYCLE_TRANSCRIPT: file }, { role, skill }, T + at);
  // The lookups the reversal candidate requires, made during the roles' calls.
  look('market-structure-analyst', 'rejection', 11);
  look('market-structure-analyst', 'pullback-vs-reversal', 12);
  look('trend-momentum-analyst', 'pullback-vs-reversal', 11);
  const base = { FTH_HOME: home, FTH_AUTONOMOUS: '1', FTH_CYCLE: 'full', FTH_CYCLE_TRANSCRIPT: file };
  const run = (env, input = entryOrder(), now = late) => {
    const cfg = { ...config, ...loadConfig({ ...base, ...env }), killSwitchFile: config.killSwitchFile, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9, home };
    // The plan written for the cycle's bar, at the entry's time (after its close: plan-required in a runner's cycle).
    const r = evaluateOrder({ input, entries: [plan(0, { ts: now.toISOString() })], now, config: cfg });
    return { ...r, violations: r.violations.filter(v => v.check !== 'phase2-facts') };
  };
  const BARS = { FTH_CYCLE_BARS: JSON.stringify({ MNQ: CYCLE_BAR }) };
  // The cycle names its bar: the briefing on it decides, past its validUntil (only the reversal lookups are required).
  assert.deepStrictEqual(run(BARS).violations, []);
  // No cycle bar named (a hook's session, or the runner's env lost): the expired briefing is no facts, so every
  // situational lookup of each role is required (fails closed), as before.
  const none = run({});
  assert.deepStrictEqual(checks(none), ['roles-ran']);
  assert.match(none.violations[0].message, /market-structure-analyst reported without looking up [^)]*breakout/);
  // The cycle names another bar (the briefing on disk is an earlier bar's, or a later one was written mid-cycle), or an
  // unreadable one: not this cycle's facts, every lookup required (fails closed), at any clock.
  for (const env of [{ FTH_CYCLE_BARS: JSON.stringify({ MNQ: '2026-10-07T14:00:00.000Z' }) }, { FTH_CYCLE_BARS: JSON.stringify({ MNQ: 'not a time' }) }]) {
    // (An unreadable bar shows no plan to be this bar's either: plan-required fails closed too.)
    for (const now of [late, NOW]) assert.deepStrictEqual(checks(run(env, entryOrder(), now)), /not a time/.test(JSON.stringify(env)) ? ['plan-required', 'roles-ran'] : ['roles-ran'], `${JSON.stringify(env)} ${now.toISOString()}`);
  }
  brief('2026-10-07T14:00:00.000Z');
  assert.deepStrictEqual(checks(run(BARS)), ['roles-ran'], 'a later bar\'s briefing is not the cycle\'s');
  brief(CYCLE_BAR);
  // Several lanes: the bar the briefing is on (FTH_CYCLE_BRIEFING_BARS) decides, whichever lane's bar closed; a briefing
  // bar naming another bar fails closed even when FTH_CYCLE_BARS names this one.
  assert.deepStrictEqual(run({ FTH_CYCLE_BARS: JSON.stringify({ MNQ: '2026-10-07T14:06:00.000Z' }), FTH_CYCLE_BRIEFING_BARS: JSON.stringify({ MNQ: CYCLE_BAR }) }).violations, []);
  assert.deepStrictEqual(checks(run({ ...BARS, FTH_CYCLE_BRIEFING_BARS: JSON.stringify({ MNQ: '2026-10-07T14:00:00.000Z' }) })), ['roles-ran']);
  // A cached report's lookups count under the cycle's key past validUntil too (the key the runner recorded at the
  // cycle's start); another key, or no cycle bar (no key): nothing credited.
  const p2 = path.join(dir, 'logs', 'cycle-transcript-p2.jsonl');
  fs.writeFileSync(p2, [...ocSkills, timed('risk-manager', 30, 40)].join('\n'));
  const cachedEnv = key => ({ ...BARS, FTH_CYCLE_TRANSCRIPT: p2, FTH_CYCLE_CACHED: 'market-structure-analyst,trend-momentum-analyst,volume-liquidity-analyst,risk-manager',
    FTH_CYCLE_CACHED_LOOKUPS: JSON.stringify({ 'market-structure-analyst': { skills: ['pullback-vs-reversal', 'rejection'], key }, 'trend-momentum-analyst': { skills: ['pullback-vs-reversal'], key } }) });
  assert.deepStrictEqual(run(cachedEnv(`m3@${CYCLE_BAR}`)).violations, []);
  assert.match(run(cachedEnv('m3@2026-10-07T13:54:00.000Z')).violations[0].message, /served from the report cache/);
  assert.match(run({ ...cachedEnv(`m3@${CYCLE_BAR}`), FTH_CYCLE_BARS: '' }).violations[0].message, /served from the report cache/);
  // Exits are never held, whatever the bar.
  assert.deepStrictEqual(run({}, entryOrder({ side: 'sell', rationale: '[exit] flatten', stopLossBracket: undefined })).violations, []);
});

test('phase2-facts, several lanes: the facts are checked against the briefing\'s bar (FTH_CYCLE_BRIEFING_BARS), not the lane bar that closed (FTH_CYCLE_BARS); a briefing of neither still fails closed', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const home = trendHome();
  const file = path.join(home, 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const BAR = '2026-10-07T13:54:00.000Z';
  const LANE = '2026-10-07T13:58:00.000Z';
  B.writeBriefing(home, { symbol: 'MNQ', minutes: 3, asOf: BAR, closedAt: '2026-10-07T13:57:00.000Z', sections: {
    m3: { version: 'a', validUntil: '2026-10-07T14:03:00.000Z', data: { window: 'opening drive', windowEntries: 'allowed', candidates: [] } } } });
  const p2 = text => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { subagent_type: 'risk-manager' }, output: text } } });
  fs.writeFileSync(file, [...ocSkills, ...ocRoles.slice(0, 4), p2('VERDICT: APPROVE - size 1\nFACTS: window opening drive; entries allowed')].join('\n'));
  const facts = env => {
    const cfg = { ...config, ...loadConfig({ FTH_HOME: home, FTH_AUTONOMOUS: '1', FTH_CYCLE: 'full', FTH_ROLE_SKILLS: 'full', FTH_CYCLE_TRANSCRIPT: file, ...env }), killSwitchFile: config.killSwitchFile, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 3, signalMaxAgeCeilingMin: 45, home };
    return evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: cfg }).violations.filter(v => v.check === 'phase2-facts').map(v => v.message);
  };
  // A 1m-lane-only close: FTH_CYCLE_BARS names the 1m bar, the briefing is the 3m bar's (FTH_CYCLE_BRIEFING_BARS): checked, true.
  assert.deepStrictEqual(facts({ FTH_CYCLE_BARS: JSON.stringify({ MNQ: LANE }), FTH_CYCLE_BRIEFING_BARS: JSON.stringify({ MNQ: BAR }) }), []);
  // One lane: FTH_CYCLE_BARS is the briefing's bar.
  assert.deepStrictEqual(facts({ FTH_CYCLE_BARS: JSON.stringify({ MNQ: BAR }) }), []);
  // The lane bar alone (no briefing bar named): the briefing isn't that bar's, refused as before; a briefing bar of
  // another bar than the briefing on file: refused (fails closed).
  assert.match(facts({ FTH_CYCLE_BARS: JSON.stringify({ MNQ: LANE }) })[0], /the MNQ briefing is for the bar at/);
  assert.match(facts({ FTH_CYCLE_BARS: JSON.stringify({ MNQ: BAR }), FTH_CYCLE_BRIEFING_BARS: JSON.stringify({ MNQ: LANE }) })[0], /the MNQ briefing is for the bar at/);
});

test('briefing-age: an autonomous entry on a bar briefing older than 3 of its bars is refused, naming the age; within it, or not autonomous, not; a named bar without a briefing fails closed; exits never held', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const home = trendHome();
  const BAR = '2026-10-07T13:48:00.000Z';
  const brief = (minutes, closedMinAgo, extra = {}) => B.writeBriefing(home, { symbol: 'MNQ', minutes, asOf: BAR, closedAt: new Date(NOW.getTime() - closedMinAgo * 60000).toISOString(), sections: { m3: { validUntil: NOW.toISOString(), data: { candidates: [] } } }, ...extra });
  const run = (env = {}, input = entryOrder()) => {
    const cfg = { ...config, ...loadConfig({ FTH_HOME: home, FTH_AUTONOMOUS: '1', FTH_CYCLE_BARS: JSON.stringify({ MNQ: BAR }), ...env }), killSwitchFile: config.killSwitchFile, home };
    return evaluateOrder({ input, entries: [plan()], now: NOW, config: cfg }).violations.filter(v => v.check === 'briefing-age').map(v => v.message);
  };
  // 3m bars: 9 minutes. 9.5 minutes after the bar closed (a delegated cycle's executor): refused, the age named.
  brief(3, 9.5);
  const stale = run();
  assert.strictEqual(stale.length, 1);
  assert.match(stale[0], /Stale data: the MNQ bar briefing's bar \(at 2026-10-07T13:48:00.000Z\) closed 9\.5 min ago, over the 9 min limit/);
  // Exits, protective stops: never held.
  assert.deepStrictEqual(run({}, entryOrder({ side: 'sell', rationale: '[exit] flatten', stopLossBracket: undefined })), []);
  assert.deepStrictEqual(run({}, entryOrder({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long', stopLossBracket: undefined })), []);
  // Within the limit: not refused; at the limit: not refused.
  brief(3, 8);
  assert.deepStrictEqual(run(), []);
  brief(3, 9);
  assert.deepStrictEqual(run(), []);
  // 1m bars: 3 minutes. 15m: 45 (the ceiling). FTH_SIGNAL_MAX_AGE_MIN only shortens it.
  brief(1, 4);
  assert.match(run()[0], /closed 4\.0 min ago, over the 3 min limit/);
  brief(15, 44);
  assert.deepStrictEqual(run(), []);
  brief(15, 46);
  assert.match(run()[0], /over the 45 min limit/);
  brief(3, 6);
  assert.match(run({ FTH_SIGNAL_MAX_AGE_MIN: '5' })[0], /over the 5 min limit/);
  // No readable close or timeframe: the close unreadable refuses; an unreadable timeframe counts as 1 minute (the strictest).
  brief(3, 1, { closedAt: 'never' });
  assert.match(run()[0], /no readable close time/);
  brief(undefined, 4);
  assert.match(run()[0], /over the 3 min limit/);
  // Not autonomous (an interactive session): not this check's.
  brief(3, 30);
  assert.deepStrictEqual(run({ FTH_AUTONOMOUS: '' }), []);
  // The cycle names its bar and no briefing is there: refused (fails closed); no bar named and none: nothing to judge.
  fs.unlinkSync(B.briefingFile(home, 'MNQ'));
  assert.match(run()[0], /No bar briefing for MNQ, though the cycle decides its bar at/);
  assert.deepStrictEqual(run({ FTH_CYCLE_BARS: '' }), []);
  assert.deepStrictEqual(run({}, entryOrder({ side: 'sell', rationale: '[exit] flatten', stopLossBracket: undefined })), []);
  // Not skippable (FTH_ORDER_GATE_SKIP lists only the skippable checks).
  brief(3, 30);
  assert.strictEqual(run({ FTH_ORDER_GATE_SKIP: 'briefing-age' }).length, 1);
});

// ---- trade_lifecycle: the composed-reads check (lifecycle-gate.js) as the gate runs it ----
const LC = require('../fixtures/lifecycle');
const { loadStrategies: loadLC } = require('../../scripts/lib/trading/strategies');
const LC_REGISTRY = loadLC(path.resolve(__dirname, '..', '..'), {}).strategies;
const LC_NOW = new Date('2026-10-07T14:00:02Z');
const lcHome = (o = {}) => { const home = trendHome(); LC.writeScenario(home, o); return home; };
const lcEval = (home, input = LC.order(), o = {}) => evaluateOrder({
  input, entries: o.entries || [plan(1, { ts: '2026-10-07T13:59:30Z' })], now: o.now || LC_NOW, transcriptPath: o.transcript || null,
  config: { ...config, home, cycleBars: { MNQ: LC.BAR }, ...(o.config || {}) }, strategies: 'strategies' in o ? o.strategies : LC_REGISTRY,
});

test('trade_lifecycle: scenario 1 goes (an active strategy); a paper copy of it is refused ([strategy]), as any paper strategy', () => {
  const home = lcHome();
  const ok = lcEval(home);
  assert.deepStrictEqual(ok.violations, []);
  // What the gate judged, for the gateway's stamp: the record, its expiry (the earlier of the record's and the
  // briefing's), the entry price and the side.
  const judged = require('../../scripts/lib/trading/trade-lifecycle').readRecords(home, 'MNQ').at(-1);
  assert.deepStrictEqual(ok.composed, { record: judged.id, expiresAt: LC.EXPIRES, entry: 21540.25, side: 'long' });
  // Several lanes: the briefing's bar (FTH_CYCLE_BRIEFING_BARS, the first lane's) over the lane bar that closed.
  assert.deepStrictEqual(lcEval(home, LC.order(), { config: { cycleBars: { MNQ: '2026-10-07T13:59:00.000Z' }, cycleBriefingBars: { MNQ: LC.BAR } } }).violations, []);
  const paper = LC_REGISTRY.map(s => (s.name === 'trade_lifecycle' ? { ...s, status: 'paper' } : s));
  const r = lcEval(home, LC.order(), { strategies: paper });
  assert.deepStrictEqual(checks(r), ['strategy']);
  assert.match(r.violations[0].message, /status "paper"; only active strategies may place live entries/);
});

test('trade_lifecycle: composed-reads refuses a false, unverifiable or other-side read, and a missing, expired, used or mismatched record', () => {
  const swap = (i, read) => LC.READS.map((x, j) => (j === i ? { ...x, read } : x));
  const only = r => r.violations.filter(v => v.check === 'composed-reads').map(v => v.message);
  // A false read now (the record says ok).
  let home = lcHome();
  const down = LC.briefing();
  down.sections.h1.data.h1.trend = 'down';
  require('../../scripts/lib/trading/briefing').writeBriefing(home, down);
  assert.match(only(lcEval(home))[0], /false by the briefing: "1h up"/);
  assert.match(only(lcEval(lcHome({ reads: swap(3, '5m close top') })))[0], /unverifiable/);
  assert.match(only(lcEval(lcHome({ reads: swap(0, 'trend short allowed'), b: LC.briefing({ m3: { trendRule: 'Trend rule: no trend on 1h, 4h' } }) })))[0], /against the long/);
  assert.match(only(lcEval(lcHome({ side: 'short' })))[0], /for a short, not this long/);
  assert.match(only(lcEval(lcHome(), LC.order(), { now: new Date(LC.EXPIRES) }))[0], /expired/);
  const used = { ts: '2026-10-07T14:00:01Z', kind: 'order_placed', contractId: 'MNQ', text: 'setup:trade_lifecycle long', data: { result: { success: true } } };
  assert.match(only(lcEval(lcHome(), LC.order(), { entries: [plan(1, { ts: '2026-10-07T13:59:30Z' }), used] }))[0], /already placed since this bar opened/);
  home = trendHome();
  require('../../scripts/lib/trading/briefing').writeBriefing(home, LC.briefing());
  assert.match(only(lcEval(home))[0], /no compose record/);
  assert.match(only(lcEval(lcHome(), LC.order({ stopLossBracket: { ticks: 100, type: 'stop' }, rationale: 'setup:trade_lifecycle long' })))[0], /stopLossBracket.ticks 100 is not the record's 111/);
  assert.match(only(lcEval(lcHome(), LC.order({ type: 'market', limitPrice: undefined })))[0], /a market order/);
  // No cycle bar (not a runner's cycle): refused.
  assert.match(only(lcEval(lcHome(), LC.order(), { config: { cycleBars: {} } }))[0], /no cycle bar/);
});

test('trade_lifecycle: composed-reads runs keyed on the tag even with no strategy registry or an invalid document, and a skip list can\'t skip it', () => {
  const home = lcHome();
  const none = lcEval(home, LC.order(), { strategies: null });
  assert.deepStrictEqual(checks(none), ['composed-reads']);
  assert.match(none.violations[0].message, /states no whole stop rule \(risk\.stop_buffer_ticks, risk\.stop_floor_ticks, risk\.stop_floor_atr\)/);
  const invalid = LC_REGISTRY.map(s => (s.name === 'trade_lifecycle' ? { ...s, valid: false, errors: ['broken'] } : s));
  assert.ok(checks(lcEval(home, LC.order(), { strategies: invalid })).includes('composed-reads'));
  const skipping = lcEval(lcHome({ side: 'short' }), LC.order(), { config: { skipChecks: new Set(['composed-reads', 'strategy', 'trigger-fired']) } });
  assert.ok(checks(skipping).includes('composed-reads'), 'a hard check');
});

test('trade_lifecycle: the stated size goes only within the ceilings: $300 the hard cap (the owner\'s $200-300 a trade)', () => {
  // 111-tick stop, $0.50 a tick on MNQ: 4 = $222.00 and 5 = $277.50 go; 6 = $333.00 is over $300, refused by the plan
  // (composed-reads, as compose_check) and by the cap (max-risk).
  for (const size of [4, 5]) assert.deepStrictEqual(lcEval(lcHome({ size }), LC.order({ size })).violations, [], `${size} MNQ`);
  const six = lcEval(lcHome({ size: 6 }), LC.order({ size: 6 }));
  assert.deepStrictEqual(checks(six), ['composed-reads', 'max-risk']);
  assert.match(six.violations[0].message, /size 6 risks \$333, over the strategy's risk.max_risk_usd \$300/);
  assert.match(six.violations[1].message, /risk \$333\.00 .* over setup:trade_lifecycle's risk\.max_risk_usd \$300\.00/);
  // 1 NQ ($5.00 a tick) at the same 111 ticks is $555.00: refused.
  const nqHome = trendHome();
  LC.writeScenario(nqHome, { b: { ...LC.briefing(), symbol: 'NQ' } });
  const nqRec = require('../../scripts/lib/trading/trade-lifecycle').readRecords(nqHome, 'NQ').at(-1);
  require('../../scripts/lib/trading/trade-lifecycle').appendRecord(nqHome, { ...nqRec, symbol: 'NQ', contract: 'NQ' });
  const nq = lcEval(nqHome, LC.order({ contractId: 'NQ' }));
  assert.ok(checks(nq).includes('max-risk') && nq.violations.some(v => /\$555\.00/.test(v.message)), JSON.stringify(nq.violations));
  // Over the broker's max order size too.
  assert.ok(checks(lcEval(lcHome({ size: 60 }), LC.order({ size: 60 }))).includes('max-order-size'));
  // An order above the record's stated size is refused by composed-reads even under every cap.
  assert.ok(checks(lcEval(lcHome({ size: 1 }), LC.order({ size: 2 }))).includes('composed-reads'));
});

test('trade_lifecycle: a long run\'s record: the gate reads the cycle bar\'s day shard alone; that shard unreadable refuses the entry, never an exit', () => {
  const TL = require('../../scripts/lib/trading/trade-lifecycle');
  const home = lcHome();
  // A year of other days' shards, each over the size cap: any read of one would throw.
  const start = Date.parse('2025-10-06T14:00:00.000Z');
  for (let d = 0; d < 365; d += 1) {
    const day = TL.dayOf(start + d * 86400000);
    if (day === '2026-10-07') continue;
    const file = TL.recordFile(home, 'MNQ', day);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.truncateSync(file, TL.MAX_BYTES + 1);
  }
  assert.deepStrictEqual(lcEval(home).violations, []);
  // The bar's own day unreadable: refused with what failed, and exits and protective stops still go.
  fs.rmSync(TL.recordFile(home, 'MNQ', '2026-10-07'));
  fs.mkdirSync(TL.recordFile(home, 'MNQ', '2026-10-07'));
  const r = lcEval(home);
  assert.deepStrictEqual(checks(r), ['composed-reads']);
  assert.match(r.violations[0].message, /can't be read \(EISDIR\)\): no entry \(fails closed\)\. Exits, protective stops and stop moves still go\./);
  for (const rationale of ['[exit] flatten the composed long', '[protect] stop for the composed long']) {
    const x = lcEval(home, { accountId: 1, contractId: 'MNQ', side: 'sell', type: 'stop', stopPrice: 21512.5, size: 1, rationale });
    assert.deepStrictEqual([x.intent, x.violations], ['risk-reducing', []], rationale);
  }
});

test('trade_lifecycle: exits, protective stops and stop moves go with no record, no briefing and no cycle bar', () => {
  const home = trendHome();
  for (const rationale of ['[exit] flatten the composed long', '[protect] stop for the composed long']) {
    const r = lcEval(home, { accountId: 1, contractId: 'MNQ', side: 'sell', type: 'stop', stopPrice: 21512.5, size: 1, rationale }, { config: { cycleBars: {} }, entries: [] });
    assert.deepStrictEqual([r.intent, r.violations], ['risk-reducing', []], rationale);
  }
  assert.deepStrictEqual(evaluateModify({ input: { orderId: 1, stopPrice: 21520 }, config }).violations, []);
});

test('trade_lifecycle: a composed entry reads trade-lifecycle in place of the strategy skills', () => {
  const file = path.join(tmpDir(), 'session.jsonl');
  const skillEvent = name => JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] } });
  fs.writeFileSync(file, ['trade-session', 'multi-timeframe-analysis', 'trade-lifecycle', 'setup-judgment', 'trade-plan'].map(skillEvent).join('\n'));
  const home = lcHome();
  assert.deepStrictEqual(lcEval(home, LC.order(), { transcript: file }).violations, [], 'no strategy-library, strategy-scan or strategy-gate-checks needed');
  fs.writeFileSync(file, ['trade-session', 'multi-timeframe-analysis', 'setup-judgment', 'trade-plan'].map(skillEvent).join('\n'));
  const r = lcEval(home, LC.order(), { transcript: file });
  assert.deepStrictEqual(checks(r), ['skills-loaded']);
  assert.match(r.violations[0].message, /not loaded in this session: trade-lifecycle\./);
  const { REQUIRED_FOR_ENTRY, REQUIRED_FOR_COMPOSED } = require('../../scripts/lib/trading/skills-loaded');
  assert.ok(!REQUIRED_FOR_ENTRY.includes('trade-lifecycle') && REQUIRED_FOR_COMPOSED.includes('trade-lifecycle'));
});

test('trade_lifecycle, index mode: the head trader\'s compose records trigger its lookups (a rejected read: rejection), for a composed entry only', () => {
  const { SITUATIONAL, situationalSkills, headSituationalSkills } = require('../../scripts/lib/trading/skills-loaded');
  const { briefingFacts } = require('../../scripts/lib/trading/skill-lookups');
  const home = trendHome();
  LC.writeScenario(home, { reads: LC.READS.map(x => (x.step === 'setup' ? { ...x, read: '15m rejected prior vah up' } : x)) });
  const m3 = briefingFacts(home, 'MNQ', LC_NOW, {});
  assert.deepStrictEqual(m3.composed.map(c => [c.side, c.relations]), [['long', ['rejected']]]);
  assert.deepStrictEqual(situationalSkills(m3).sort(), ['confluence-counting', 'invalidation', 'rejection']);
  assert.deepStrictEqual(situationalSkills(m3, SITUATIONAL.filter(e => !e.taughtIn)), [], 'not for another entry');
  assert.deepStrictEqual(headSituationalSkills(), [], 'the prompt-listed head entries: none of the composed ones');
  assert.deepStrictEqual(headSituationalSkills(SITUATIONAL).sort(), ['breakout', 'confluence-counting', 'invalidation', 'rejection']);
  // The gate, autonomous in index mode: the composed entry needs them; a legacy entry on the same bar doesn't.
  const file = path.join(tmpDir(), 'session.jsonl');
  fs.writeFileSync(file, ocSkills.join('\n'));
  const auto = { ...loadConfig({ FTH_HOME: home }), killSwitchFile: config.killSwitchFile, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9, home, autonomous: true, cycle: null, cycleLaneBars: {}, cycleBars: { MNQ: LC.BAR } };
  const loaded = (input, c = auto) => evaluateOrder({ input, entries: [plan(1, { ts: '2026-10-07T13:59:30Z' })], now: LC_NOW, config: c, transcriptPath: file, strategies: LC_REGISTRY }).violations.filter(v => v.check === 'skills-loaded').map(v => v.message);
  const msg = loaded(LC.order())[0];
  for (const s of ['trade-lifecycle', 'confluence-counting', 'invalidation', 'rejection']) assert.match(msg, new RegExp(`\\b${s}\\b`));
  assert.doesNotMatch(msg, /strategy-library|breakout/);
  assert.deepStrictEqual(loaded(entryOrder()), [], 'a legacy entry: neither trade-lifecycle nor the composed lookups');
  // Unreadable lanes: every head entry, the composed ones only for a composed entry.
  assert.match(loaded(LC.order(), { ...auto, cycleLaneBars: null })[0], /breakout/);
  assert.deepStrictEqual(loaded(entryOrder(), { ...auto, cycleLaneBars: null }), []);
});

test('trade_lifecycle, index mode: the head prompt embeds the composed bar\'s reads, so on the attestation a composed entry with no lookup goes; a prompt or attestation without them is refused for them', () => {
  const { H, root, dir, configFile, generated, att } = headRun();
  assert.deepStrictEqual(H.COMPOSED_READS, ['confluence-counting', 'invalidation', 'rejection', 'breakout']);
  for (const s of H.COMPOSED_READS) assert.ok(H.CORE.includes(s) && att.skills.includes(s), `embedded and attested: ${s}`);
  // The runner's opencode cycle transcript: no skill loaded and no skill_lookup at all.
  const transcript = path.join(dir, 'logs', 'bare-transcript.jsonl');
  fs.writeFileSync(transcript, [JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 's', part: { type: 'step-start' } }), ocEvent('harness_bar_briefing', { symbol: 'MNQ' })].join('\n'));
  const skillMsgs = r => r.violations.filter(v => v.check.startsWith('skills-')).map(v => `${v.check}: ${v.message.replace(/ Load each with the skill tool [^]*$/, '')}`);
  for (const [relation, read, skills] of [['rejected', '15m rejected prior vah up', ['confluence-counting', 'invalidation', 'rejection']], ['broke', '15m broke prior vah up', ['confluence-counting', 'invalidation', 'breakout']]]) {
    const home = lcHome({ reads: LC.READS.map(x => (x.step === 'setup' ? { ...x, read } : x)) });
    const cfg = { autonomous: true, roleSkills: 'index', cycle: null, cycleLaneBars: {}, cycleTranscript: transcript, headPromptAttestation: JSON.stringify(att) };
    const run = (c, input = LC.order()) => lcEval(home, input, { config: { ...cfg, ...c } });
    // The bar's facts trigger the composed reads (the gate requires them)...
    const { briefingFacts } = require('../../scripts/lib/trading/skill-lookups');
    const { situationalSkills } = require('../../scripts/lib/trading/skills-loaded');
    assert.deepStrictEqual(situationalSkills(briefingFacts(home, 'MNQ', LC_NOW, {})).sort(), [...skills].sort(), relation);
    // ... and the attested prompt embeds them: no lookup needed, nothing refused for a skill.
    assert.deepStrictEqual(skillMsgs(run({})), [], relation);
    // No attestation (the transcript alone decides): refused, naming them among the rest.
    const none = skillMsgs(run({ headPromptAttestation: null })).join('\n');
    for (const s of skills) assert.match(none, new RegExp(`skills-loaded: [^\n]*\\b${s}\\b`), `${relation}, no attestation: ${s}`);
    // An attestation that leaves them out (a role or prompt that doesn't embed them): refused for exactly them.
    const partial = { ...att, skills: att.skills.filter(s => !H.COMPOSED_READS.includes(s)) };
    assert.deepStrictEqual(skillMsgs(run({ headPromptAttestation: JSON.stringify(partial) })), [`skills-loaded: Load the trading skills before an entry; not loaded in this session: ${skills.join(', ')}.`], relation);
    // An exit is never held by it.
    assert.deepStrictEqual(skillMsgs(run({ headPromptAttestation: JSON.stringify(partial) }, entryOrder({ side: 'sell', rationale: '[exit] flatten', stopLossBracket: undefined }))), [], `${relation}: exit`);
  }
  // A prompt that doesn't embed them (their blocks cut from the run's opencode.json), attested as it is: its attestation
  // names none of them, and the composed entry with no lookup is refused for them; looked up, it goes.
  const json = JSON.parse(generated);
  for (const s of H.COMPOSED_READS) json.agent[H.HEAD_AGENT].prompt = json.agent[H.HEAD_AGENT].prompt.replace(new RegExp(`<skill name="${s}">\n[^]*?\n</skill>\n\n?`), '');
  fs.writeFileSync(configFile, JSON.stringify(json));
  const cut = H.attestation(configFile, root);
  assert.deepStrictEqual(cut.skills, H.CORE.filter(s => !H.COMPOSED_READS.includes(s)));
  const home = lcHome({ reads: LC.READS.map(x => (x.step === 'setup' ? { ...x, read: '15m rejected prior vah up' } : x)) });
  const cfg = { autonomous: true, roleSkills: 'index', cycle: null, cycleLaneBars: {}, cycleTranscript: transcript, headPromptAttestation: JSON.stringify(cut) };
  assert.deepStrictEqual(skillMsgs(lcEval(home, LC.order(), { config: cfg })), ['skills-loaded: Load the trading skills before an entry; not loaded in this session: confluence-counting, invalidation, rejection.']);
  // A forged attestation naming them for that prompt: the prompt doesn't embed them, so they still don't count.
  assert.match(skillMsgs(lcEval(home, LC.order(), { config: { ...cfg, headPromptAttestation: JSON.stringify(att) } })).join('\n'), /skills-loaded/, 'the uncut hash no longer matches');
  assert.deepStrictEqual(skillMsgs(lcEval(home, LC.order(), { config: { ...cfg, headPromptAttestation: JSON.stringify({ ...cut, skills: att.skills }) } })), ['skills-loaded: Load the trading skills before an entry; not loaded in this session: confluence-counting, invalidation, rejection.']);
  // Full mode never requires the situational reads (the head trader loads trade-lifecycle, which names them).
  const fullMode = skillMsgs(lcEval(home, LC.order(), { config: { ...cfg, roleSkills: 'full' } })).join('\n');
  assert.match(fullMode, /skills-loaded: [^\n]*trade-session/);
  assert.doesNotMatch(fullMode, /confluence-counting|invalidation|rejection/);
  fs.appendFileSync(transcript, `\n${['confluence-counting', 'invalidation', 'rejection'].map(skill => ocEvent('harness_skill_lookup', { skill }).replace('VERDICT: APPROVE - size 1', `<skill name=\\"${skill}\\">...`)).join('\n')}`);
  assert.deepStrictEqual(skillMsgs(lcEval(home, LC.order(), { config: cfg })), [], 'looked up: counted, as before');
  fs.writeFileSync(configFile, generated);
});

test('trade_lifecycle: a phase-2 room fact is about the record\'s own plan (the first level ahead in its R), never a scan candidate', () => {
  const { factsOrder } = require('../../scripts/lib/trading/order-gate');
  const { checkClaim, parseClaim } = require('../../scripts/lib/trading/fact-claims');
  const room = { stopPoints: 27.75, needR: 2.08, inTheWay: { name: 'prior VAH', R: 1.07 } };
  const order = factsOrder(LC.order(), /^\s*setup:([a-z0-9_-]+)/.exec('setup:trade_lifecycle long'), null, tmpDir(), { room });
  assert.deepStrictEqual(order, { strategy: 'trade_lifecycle', side: 'long', room });
  const b = LC.briefing({ m3: { candidates: [{ name: 'trade_lifecycle', direction: 'long', stopPoints: 10, needR: 1, inTheWay: null }] } });
  assert.deepStrictEqual([checkClaim(parseClaim('room long short'), b, order).check, checkClaim(parseClaim('room long enough'), b, order).check], [true, false]);
  // Without the record's plan (refused), no room is assumed: the order's own setup has none on the scan.
  assert.strictEqual(checkClaim(parseClaim('room long enough'), LC.briefing(), { strategy: 'trade_lifecycle', side: 'long' }).check, 'unchecked');
});

test('trade_lifecycle, D2 ("CHoCH at or above the trend"): each tier on the gate, a long against 15m, 1h and 4h trends; non-CHoCH breaks never fade it', () => {
  const B = { kind: k => ({ last: { kind: k, direction: 'up', level: 21500 }, previous: null }) };
  // The briefing: every break the reads may name, and a 4h candle that rejected the previous 4h low up.
  const brief = ({ m3 = 'CHoCH', m15 = 'CHoCH', h1 = 'CHoCH' } = {}) => {
    const b = LC.briefing({ m3: { lastBreak: B.kind(m3) } });
    b.sections.m15.data.lastBreak = B.kind(m15);
    b.sections.h1.data.lastBreak = B.kind(h1);
    b.sections.m3.data.candles['4h'] = { closedAt: '2026-10-07T10:00:00.000Z', o: 21480, h: 21560, l: 21470, c: 21540, closeLocation: 'top', relations: [{ name: 'previous 4h low', price: 21475, rel: 'rejected', dir: 'up' }] };
    return b;
  };
  const reads = (bias, extraSetup = []) => [
    ...bias.map(read => ({ step: 'bias', skill: 'bos-vs-choch', read })),
    ...LC.READS.filter(x => x.step !== 'bias'),
    ...extraSetup.map(read => ({ step: 'setup', skill: 'rejection', read })),
  ];
  const run = (biases, bias, { extra = [], b = brief() } = {}) => {
    const home = trendHome(require('../helpers').tmpDir(), { biases });
    LC.writeScenario(home, { reads: reads(bias, extra), b });
    return checks(lcEval(home));
  };
  const M15 = { 240: 0, 60: 0, 15: -1 };
  const H1 = { 240: 0, 60: -1, 15: -1 };
  const H4 = { 240: -1, 60: -1, 15: -1 };
  // Against a 15m trend: a 15m or a 1h CHoCH up.
  assert.deepStrictEqual(run(M15, ['15m choch up']), []);
  assert.deepStrictEqual(run(M15, ['1h choch up']), []);
  assert.deepStrictEqual(run(M15, ['1h up']), ['mtf-trend'], 'no CHoCH');
  // Non-CHoCH breaks and a 3m CHoCH never fade it.
  assert.deepStrictEqual(run(M15, ['15m bos up'], { b: brief({ m15: 'BOS' }) }), ['mtf-trend']);
  assert.deepStrictEqual(run(M15, ['1h bos up'], { b: brief({ h1: 'BOS' }) }), ['mtf-trend']);
  assert.deepStrictEqual(run(M15, ['3m choch up']), ['mtf-trend']);
  // Against a 1h trend: a 1h CHoCH; a 15m one is under it.
  assert.deepStrictEqual(run(H1, ['1h choch up']), []);
  assert.deepStrictEqual(run(H1, ['15m choch up']), ['mtf-trend']);
  assert.deepStrictEqual(run(H1, ['1h bos up'], { b: brief({ h1: 'BOS' }) }), ['mtf-trend']);
  // Against a 4h trend: a 1h CHoCH plus a 4h candle that rejected a level the trade's way; either alone is short.
  assert.deepStrictEqual(run(H4, ['1h choch up'], { extra: ['4h rejected previous 4h low up'] }), []);
  assert.deepStrictEqual(run(H4, ['1h choch up']), ['mtf-trend']);
  assert.deepStrictEqual(run(H4, ['15m choch up'], { extra: ['4h rejected previous 4h low up'] }), ['mtf-trend']);
  // A CHoCH read false now (the briefing's 1h break is a BOS): composed-reads refuses, and the trend rule too.
  assert.deepStrictEqual(run(H1, ['1h choch up'], { b: brief({ h1: 'BOS' }) }), ['composed-reads', 'mtf-trend']);
  // With the trend: nothing to fade; an exit is never held.
  assert.deepStrictEqual(run({ 240: 1, 60: 1, 15: 1 }, ['1h up']), []);
  const home = trendHome(require('../helpers').tmpDir(), { biases: H4 });
  assert.deepStrictEqual(lcEval(home, { accountId: 1, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] flatten the composed long' }).violations, []);
});

test('trade_lifecycle, D2\'s 4h tier: the honest record naming the 4h trend it fades stands on the checker and the gate alike; without the 4h rejection, or on a gap edge, both refuse', () => {
  const { reversalAllowed } = require('../../scripts/lib/trading/lifecycle-gate');
  const { checkReads } = require('../../scripts/lib/trading/composed-reads');
  const H4 = { 240: -1, 60: -1, 15: -1 };
  // 4h down, the 1h CHoCH up, and a 4h candle that rejected the previous 4h low and a 15m gap's low, up.
  const b = LC.briefing();
  b.sections.h1.data.h4.trend = 'down';
  b.sections.h1.data.lastBreak = { last: { kind: 'CHoCH', direction: 'up', level: 21500 }, previous: null };
  b.sections.m3.data.candles['4h'] = { closedAt: '2026-10-07T10:00:00.000Z', o: 21480, h: 21560, l: 21470, c: 21540, closeLocation: 'top',
    relations: [{ name: 'previous 4h low', price: 21475, rel: 'rejected', dir: 'up' }],
    fvgRelations: [{ name: '15m fvg low', price: 21472, side: 'bullish', rel: 'rejected', dir: 'up' }] };
  const reads = extra => [{ step: 'bias', skill: 'multi-timeframe-analysis', read: '4h down' }, { step: 'bias', skill: 'bos-vs-choch', read: '1h choch up' },
    ...LC.READS.filter(x => x.step !== 'bias'), ...extra.map(read => ({ step: 'setup', skill: 'rejection', read }))];
  const cases = [
    ['the honest record', ['4h rejected previous 4h low up'], true],
    ['the 1h CHoCH alone', [], false],
    ['a gap edge\'s 4h rejection', ['4h rejected 15m fvg low up'], false],
  ];
  for (const [what, extra, stands] of cases) {
    const checked = checkReads({ reads: reads(extra), side: 'long', briefing: b });
    assert.strictEqual(checked.ok, stands, `${what}, the checker: ${checked.problems.join('; ')}`);
    assert.strictEqual(checked.reads.find(x => x.read === '4h down').agrees, stands, what);
    const home = trendHome(require('../helpers').tmpDir(), { biases: H4 });
    LC.writeScenario(home, { reads: reads(extra), b });
    // The gate: refused by the record's re-checked reads and by the trend rule, or neither.
    assert.deepStrictEqual(checks(lcEval(home)), stands ? [] : ['composed-reads', 'mtf-trend'], what);
    // The trend rule's tier on the same reads, as the checker read them (its ok set aside): the same answer.
    assert.strictEqual(reversalAllowed({ home, root: 'MNQ', side: 'long', check: { ...checked, ok: true }, now: LC_NOW, maxAgeMin: 15 }).ok, stands, what);
  }
  // An exit against the same trend always goes.
  const home = trendHome(require('../helpers').tmpDir(), { biases: H4 });
  assert.deepStrictEqual(lcEval(home, { accountId: 1, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] flatten the composed long' }).violations, []);
});

test('trade_lifecycle: a CISD setup is timed on its confirming candle; an entry read on that same candle is refused ([composed-reads]), a later one goes', () => {
  const reads = LC.READS.map(x => (x.step === 'setup' ? { ...x, skill: 'cisd', read: '15m cisd up' } : x));
  const run = confirmedClose => {
    const home = trendHome();
    LC.writeScenario(home, { reads, b: LC.briefing({ m3: { cisd: { '15m': { dir: 'bullish', level: 21520, confirmedClose, status: 'touched', priceInOte: false } } } }) });
    return lcEval(home);
  };
  // Confirmed 13:45: the 3m closing 14:00 is the next candle.
  assert.deepStrictEqual(run('2026-10-07T13:45:00.000Z').violations, []);
  // Confirmed 14:00, with the 3m the entry reads: the same candle, refused.
  const same = run(LC.CLOSE);
  assert.deepStrictEqual(checks(same), ['composed-reads']);
  assert.match(same.violations[0].message, /no entry read pointing long is on a candle that closed after the setup's/);
});

const LCP_NOW_D2 = new Date('2026-10-07T14:00:02Z');
test('trade_lifecycle, D2 tiers for the short side (reversalAllowed on the re-checked reads)', () => {
  const { reversalAllowed } = require('../../scripts/lib/trading/lifecycle-gate');
  const read = (kind, form, dir = 'short', extra = {}) => ({ kind, form, dir, check: true, agrees: true, ...extra });
  const at = (biases, reads) => {
    const home = trendHome(require('../helpers').tmpDir(), { biases });
    return reversalAllowed({ home, root: 'MNQ', side: 'short', check: { ok: true, reads }, now: LCP_NOW_D2, maxAgeMin: 15 }).ok;
  };
  const UP15 = { 240: 0, 60: 0, 15: 1 };
  const UP1H = { 240: 0, 60: 1, 15: 1 };
  const UP4H = { 240: 1, 60: 1, 15: 1 };
  assert.strictEqual(at(UP15, [read('break', '15m choch down')]), true);
  assert.strictEqual(at(UP15, [read('break', '1h choch down')]), true);
  assert.strictEqual(at(UP15, [read('break', '15m bos down')]), false, 'a BOS');
  assert.strictEqual(at(UP15, [read('break', '3m choch down')]), false, 'a 3m CHoCH');
  assert.strictEqual(at(UP15, [read('break', '15m choch up', 'long')]), false, 'the other way');
  assert.strictEqual(at(UP15, [read('break', '15m choch down', 'short', { check: false })]), false, 'not true');
  assert.strictEqual(at(UP15, [read('break', '15m choch down', 'short', { agrees: false })]), false, 'not agreeing');
  assert.strictEqual(at(UP1H, [read('break', '15m choch down')]), false);
  assert.strictEqual(at(UP1H, [read('break', '1h choch down')]), true);
  assert.strictEqual(at(UP4H, [read('break', '1h choch down')]), false);
  assert.strictEqual(at(UP4H, [read('break', '1h choch down'), read('relation', '4h rejected previous 4h high down')]), true);
  assert.strictEqual(at(UP4H, [read('break', '1h choch down'), read('relation', '15m rejected previous 4h high down')]), false, 'a 15m rejection');
  assert.strictEqual(at(UP4H, [read('break', '1h choch down'), read('relation', '4h broke previous 4h high down')]), false, 'a break, not a rejection');
  for (const gap of ['5m', '15m', '1h']) {
    assert.strictEqual(at(UP4H, [read('break', '1h choch down'), read('relation', `4h rejected ${gap} fvg low down`)]), false, `a ${gap} gap's edge is no key level`);
  }
  // Not against the trend, no record, or no standing check: no reversal (the trend rule as before).
  assert.strictEqual(at({ 240: -1, 60: -1, 15: -1 }, [read('break', '1h choch down')]), false);
  assert.strictEqual(reversalAllowed({ home: require('../helpers').tmpDir(), root: 'MNQ', side: 'short', check: { ok: true, reads: [] } }).ok, false);
  assert.strictEqual(reversalAllowed({ home: trendHome(require('../helpers').tmpDir(), { biases: UP15 }), root: 'MNQ', side: 'short', check: { ok: false, reads: [read('break', '15m choch down')] } }).ok, false);
});

test('trade_lifecycle: the order is on the record\'s own contract; the bar\'s own expiry (its validUntil plus valid_bars - 1 bars) earlier than the record\'s expiresAt decides', () => {
  const home = lcHome();
  const TL = require('../../scripts/lib/trading/trade-lifecycle');
  const rec = TL.readRecords(home, 'MNQ').at(-1);
  // A record for NQ: an MNQ order is refused (its size is a number of NQ).
  TL.appendRecord(home, { ...rec, symbol: 'NQ', contract: 'NQ' });
  assert.match(lcEval(home).violations.find(v => v.check === 'composed-reads').message, /the compose record is for NQ, not MNQ/);
  // The bar's own expiry comes before the record says (its validUntil 14:01, plus one more 3m bar: 14:04): refused then.
  const h2 = trendHome();
  const b = LC.briefing();
  b.sections.m3.validUntil = '2026-10-07T14:01:00.000Z';
  LC.writeScenario(h2, { b });
  TL.appendRecord(h2, { ...TL.readRecords(h2, 'MNQ').at(-1), expiresAt: '2026-10-07T14:30:00.000Z' });
  assert.deepStrictEqual(lcEval(h2).violations, [], 'before both');
  assert.deepStrictEqual(lcEval(h2, LC.order(), { now: new Date('2026-10-07T14:03:59Z') }).violations, [], 'the second bar');
  assert.match(lcEval(h2, LC.order(), { now: new Date('2026-10-07T14:04:00Z') }).violations.find(v => v.check === 'composed-reads').message, /expired at 2026-10-07T14:04:00.000Z \(2 base bars after its bar's close\)/);
});

test('trade_lifecycle: a record stays valid valid_bars (2) base bars after its bar\'s close: an entry after the next close goes on the record\'s own bar; at the expiry it is refused (expired), an exit never', () => {
  const TL = require('../../scripts/lib/trading/trade-lifecycle');
  const only = r => r.violations.filter(v => v.check === 'composed-reads');
  const at = iso => ({ now: new Date(iso) });
  // After the next close (14:03), before the second (14:06): the cycle still on its bar (the runner awaits it), the
  // reads re-checked against that bar's briefing. The gateway's stamp carries the two-bar expiry (the runner's watch).
  const home = lcHome();
  const late = lcEval(home, LC.order(), at('2026-10-07T14:05:59Z'));
  assert.deepStrictEqual(late.violations, []);
  assert.strictEqual(late.composed.expiresAt, LC.EXPIRES);
  // At the second close: refused, flagged expired (the cycle-timing count of entries lost to expiry).
  const gone = only(lcEval(home, LC.order(), at(LC.EXPIRES)));
  assert.strictEqual(gone.length, 1);
  assert.match(gone[0].message, /expired at 2026-10-07T14:06:00.000Z \(2 base bars after its bar's close\): compose again/);
  assert.strictEqual(gone[0].expired, true);
  // Another refusal is never flagged expired.
  assert.ok(!('expired' in only(lcEval(lcHome({ side: 'short' }), LC.order(), at('2026-10-07T14:04:00Z')))[0]));
  // A record stamped longer than the strategy allows: the bar's own two bars decide.
  const h2 = lcHome();
  TL.appendRecord(h2, { ...TL.readRecords(h2, 'MNQ').at(-1), expiresAt: '2026-10-07T14:30:00.000Z' });
  assert.match(only(lcEval(h2, LC.order(), at(LC.EXPIRES)))[0].message, /expired at 2026-10-07T14:06:00.000Z/);
  // A record stamped shorter (one bar, written under valid_bars 1): its own stamp decides.
  const h3 = lcHome({ validBars: 1 });
  assert.match(only(lcEval(h3, LC.order(), at(LC.NEXT_CLOSE)))[0].message, /expired at 2026-10-07T14:03:00.000Z/);
  // A strategy document that says one bar: one bar, whatever the record says.
  const one = LC_REGISTRY.map(s => (s.name === 'trade_lifecycle' ? { ...s, valid_bars: 1 } : s));
  assert.match(only(lcEval(lcHome(), LC.order(), { ...at(LC.NEXT_CLOSE), strategies: one }))[0].message, /expired at 2026-10-07T14:03:00.000Z \(1 base bar after its bar's close\)/);
  // The facts stay the record's bar's: once the briefing on disk is the next bar's, the record's reads aren't checked
  // against it (a later cycle composes on its own bar).
  const h4 = lcHome();
  require('../../scripts/lib/trading/briefing').writeBriefing(h4, { ...LC.briefing(), asOf: LC.CLOSE });
  assert.match(only(lcEval(h4, LC.order(), at('2026-10-07T14:04:00Z')))[0].message, /briefing can't be read .*not the cycle's/);
  // One entry per bar and side across the two bars: an entry placed on this record after the next close counts.
  const placed = { ts: '2026-10-07T14:03:30Z', kind: 'order_placed', contractId: 'MNQ', text: 'setup:trade_lifecycle long', data: { result: { success: true }, request: { side: 'buy' } } };
  assert.match(only(lcEval(lcHome(), LC.order(), { ...at('2026-10-07T14:04:30Z'), entries: [plan(1, { ts: '2026-10-07T13:59:30Z' }), placed] }))[0].message, /already placed since this bar opened/);
  // Past the expiry, an exit and a protective stop still go.
  for (const rationale of ['[exit] flatten the composed long', '[protect] stop for the composed long']) {
    const r = lcEval(lcHome(), { accountId: 1, contractId: 'MNQ', side: 'sell', type: 'stop', stopPrice: 21512.5, size: 1, rationale }, { ...at('2026-10-07T14:10:00Z'), entries: [] });
    assert.deepStrictEqual([r.intent, r.violations], ['risk-reducing', []], rationale);
  }
});

test('trade_lifecycle, D2: a reversal never stands on a stale, future-dated or partly read multi-timeframe record ([mtf-trend])', () => {
  const { reversalAllowed } = require('../../scripts/lib/trading/lifecycle-gate');
  const choch = LC.briefing();
  choch.sections.h1.data.lastBreak = { last: { kind: 'CHoCH', direction: 'up', level: 21500 }, previous: null };
  const reads = LC.READS.map(x => (x.step === 'bias' ? { ...x, read: '1h choch up', skill: 'bos-vs-choch' } : x));
  const home = (o = {}) => { const h = trendHome(require('../helpers').tmpDir(), { biases: { 240: 0, 60: -1, 15: -1 }, ...o }); LC.writeScenario(h, { reads, b: choch }); return h; };
  // Fresh (closed 13:57, 3 min before now) with a 15-minute limit: the reversal stands.
  assert.deepStrictEqual(checks(lcEval(home(), LC.order(), { config: { mtfMaxAgeMin: 15 } })), []);
  // Older than the limit: refused, by the trend rule's own freshness and by no reversal.
  assert.deepStrictEqual(checks(lcEval(home(), LC.order(), { config: { mtfMaxAgeMin: 2 } })), ['mtf-trend']);
  // Dated after now: refused.
  assert.deepStrictEqual(checks(lcEval(home({ closedAt: '2026-10-07T14:30:00.000Z' }), LC.order(), { config: { mtfMaxAgeMin: 15 } })), ['mtf-trend']);
  // A frame not read (the 15m bias missing) with 1h down: no tier can be chosen, refused.
  assert.deepStrictEqual(checks(lcEval(home({ biases: { 240: 0, 60: -1, 15: null } }), LC.order(), { config: { mtfMaxAgeMin: 15 } })), ['mtf-trend']);
  // The same, on reversalAllowed itself.
  const check = { ok: true, reads: [{ kind: 'break', form: '1h choch up', dir: 'long', check: true, agrees: true }] };
  const at = (h, o = {}) => reversalAllowed({ home: h, root: 'MNQ', side: 'long', check, now: new Date('2026-10-07T14:00:02Z'), maxAgeMin: 15, ...o }).ok;
  assert.strictEqual(at(home()), true);
  assert.strictEqual(at(home(), { maxAgeMin: 2 }), false);
  assert.strictEqual(at(home({ closedAt: '2026-10-07T14:30:00.000Z' })), false);
  assert.strictEqual(at(home({ biases: { 240: 0, 60: -1, 15: null } })), false);
  const noClose = home();
  fs.writeFileSync(path.join(noClose, 'mtf', 'MNQ.json'), JSON.stringify({ symbol: 'MNQ', biases: { 240: 0, 60: -1, 15: -1 } }));
  assert.strictEqual(at(noClose), false, 'no close time');
});
// ---- trade_lifecycle inside a prop attempt: prop_portfolio's verdict on the compose record is the ceiling ----
const LCP = require('../fixtures/lifecycle-prop');
const { composedOrder } = require('../../scripts/lib/trading/lifecycle-order');
const lcSpec = r => (r === 'MNQ' || r === 'NQ' ? { tickSize: 0.25, tickValue: r === 'NQ' ? 5 : 0.5 } : null);
const lcPropPlan = home => composedOrder({ home, root: 'MNQ', side: 'long', now: LCP.NOW, cycleBars: { MNQ: LC.BAR }, strategy: LCP.LC_DOC, strategies: LCP.registry(), accounts: [LCP.MINI], specOf: lcSpec, accountId: 1, selected: ['MNQ'] }).args;
const lcPropEval = (home, input, o = {}) => evaluateOrder({
  input, entries: [plan(1, { ts: '2026-10-07T13:59:30Z' })], now: LCP.NOW, strategies: o.registry || LCP.registry(), accounts: o.accounts || [LCP.MINI],
  config: { ...config, home, cycleBars: { MNQ: LC.BAR }, ...(o.config || {}) },
});

test('trade_lifecycle in an attempt: setup:prop_portfolio on the record\'s verdict goes; a paper component is refused ([policy])', () => {
  const { home } = LCP.propHome({ size: 5 });
  const args = lcPropPlan(home);
  assert.match(args.rationale, /^setup:prop_portfolio long trade_lifecycle/);
  assert.deepStrictEqual(lcPropEval(home, args).violations, []);
  const paper = LCP.registry().map(s => (s.name === 'trade_lifecycle' ? { ...s, status: 'paper' } : s));
  const live = lcPropEval(home, args, { registry: paper });
  assert.deepStrictEqual(checks(live), ['policy']);
  assert.match(live.violations[0].message, /trade_lifecycle has status "paper"/);
  // The composed-reads check runs for it too: the record's reads, re-checked.
  const down = LC.briefing();
  down.sections.h1.data.h1.trend = 'down';
  require('../../scripts/lib/trading/briefing').writeBriefing(home, down);
  assert.ok(checks(lcPropEval(home, args)).includes('composed-reads'));
});

test('trade_lifecycle in an attempt: over the verdict\'s size is refused even when the record states it; a verdict not sized on this record is refused', () => {
  // The record states 4 ($222.00, under $300); a $1,000 cushion's verdict sized it at 3: the gate refuses 4.
  const { home, rec } = LCP.propHome({ size: 4, account: LCP.THIN });
  require('../../scripts/lib/prop/composed-verdict').composedVerdict({ home, policy: LCP.policy(), component: 'trade_lifecycle', account: LCP.THIN, record: rec, plan: rec.plan, briefing: LC.briefing(), root: 'MNQ', spec: lcSpec('MNQ'), specOf: lcSpec, now: LCP.NOW });
  const four = LC.order({ accountId: 1, size: 4, rationale: 'setup:prop_portfolio long trade_lifecycle, stop 21512.50, target 21598.00' });
  const r = lcPropEval(home, four, { accounts: [LCP.THIN] });
  assert.ok(checks(r).includes('policy') && checks(r).includes('combine'), JSON.stringify(r.violations));
  assert.ok(r.violations.some(v => /size 4 is over the verdict's 3 MNQ/.test(v.message)));
  assert.ok(!checks(r).includes('composed-reads'), 'the size is the record\'s');
  // A verdict sized on another record (the same bar and stop): refused.
  const p = LCP.propHome({ size: 2 });
  prop.appendVerdict(p.home, { strategy: 'prop_portfolio', component: 'trade_lifecycle', contract: 'MNQ', contractId: 'MNQ', symbol: 'MNQ', direction: 'long', action: 'full', multiplier: 1, stopTicks: 111, maxSize: 7, bar: LC.BAR, at: '2026-10-07T13:59:55Z', expiresAt: '2026-10-07T14:06:00Z', record: 'another' });
  const two = lcPropEval(p.home, LC.order({ accountId: 1, size: 2, rationale: 'setup:prop_portfolio long trade_lifecycle, stop 21512.50, target 21598.00' }));
  assert.deepStrictEqual(checks(two), ['policy']);
  assert.match(two.violations[0].message, /the latest verdict is not the one sized on the compose record/);
  // An exit under the policy goes with nothing.
  assert.deepStrictEqual(lcPropEval(trendHome(), { accountId: 1, contractId: 'MNQ', side: 'sell', type: 'market', size: 2, rationale: '[exit] flatten the prop_portfolio long' }).violations, []);
});

test('trade_lifecycle: modify_order never reprices a working composed entry worse than its record\'s entry; better, stops, targets and exits move freely', () => {
  const home = require('../helpers').tmpDir();
  fs.writeFileSync(path.join(home, 'entry-orders.json'), JSON.stringify([
    { orderId: 11, contractId: 'MNQ', side: 'buy', setup: 'trade_lifecycle', composed: { record: 'r', expiresAt: LC.EXPIRES, entry: 21540.25, side: 'long' } },
    { orderId: 12, contractId: 'MNQ', side: 'sell', setup: 'trade_lifecycle', composed: { record: 'r', expiresAt: LC.EXPIRES, entry: 21540.25, side: 'short' } },
    { orderId: 13, contractId: 'MNQ', side: 'buy', setup: 'fx_break' },
  ]));
  const cfg = { ...config, home };
  const mod = input => evaluateModify({ input, config: cfg }).violations.map(v => v.check);
  assert.deepStrictEqual(mod({ orderId: 11, limitPrice: 21541 }), ['composed-reprice'], 'a long limit raised');
  assert.deepStrictEqual(mod({ orderId: 11, limitPrice: 'x' }), ['composed-reprice'], 'not a price');
  assert.deepStrictEqual(mod({ orderId: 11, limitPrice: 21540.25 }), []);
  assert.deepStrictEqual(mod({ orderId: 11, limitPrice: 21535 }), [], 'better for a long');
  assert.deepStrictEqual(mod({ orderId: 12, limitPrice: 21539 }), ['composed-reprice'], 'a short limit lowered');
  assert.deepStrictEqual(mod({ orderId: 12, limitPrice: 21545 }), []);
  // Another setup's entry, a stop or a target (not in entry-orders), and a stop price move: free.
  assert.deepStrictEqual(mod({ orderId: 13, limitPrice: 99999 }), []);
  assert.deepStrictEqual(mod({ orderId: 99, limitPrice: 99999 }), []);
  assert.deepStrictEqual(mod({ orderId: 11, stopPrice: 21500 }), []);
  assert.match(evaluateModify({ input: { orderId: 11, limitPrice: 21541 }, config: cfg }).violations[0].message, /worse for it/);
});

test('gate config: the loss streak\'s env override only tightens; the committed config files are no critical error', () => {
  const pinned = require('../../scripts/lib/tunables').runner().gate.maxConsecutiveLosses;
  assert.strictEqual(loadConfig({}).maxConsecutiveLosses, pinned);
  assert.strictEqual(loadConfig({ FTH_MAX_CONSECUTIVE_LOSSES: '1' }).maxConsecutiveLosses, 1, 'lower: tighter, taken');
  for (const looser of [String(pinned + 1), '99']) assert.strictEqual(loadConfig({ FTH_MAX_CONSECUTIVE_LOSSES: looser }).maxConsecutiveLosses, pinned, `${looser}: held at the config's`);
  assert.strictEqual(loadConfig({ FTH_MAX_CONSECUTIVE_LOSSES: '0' }).maxConsecutiveLosses, pinned, 'invalid: the config\'s');
  assert.strictEqual(loadConfig({}).configCritical, null);
});

test('skills-loaded / skills-at-entry: the head trader\'s loads the runner recorded in the cycle\'s role record count for a trade-executor run of the runner\'s own (an autonomous cycle transcript, FTH_CYCLE_ROLES); never for a hook\'s transcript, a non-autonomous call, or without the record; exits never held', () => {
  const RR = require('../../scripts/lib/trading/runner-roles');
  const dir = require('../helpers').tmpDir();
  // The executor's own session: an opencode transcript with no skill load of its own.
  const file = path.join(dir, 'executor-transcript.jsonl');
  fs.writeFileSync(file, `${ocEvent('broker_get_account_snapshot', { accountId: 7 })}\n`);
  const rolesFile = path.join(dir, 'cycle-roles.jsonl');
  const auto = { ...config, autonomous: true, cycle: null, cycleTranscript: file, roleSkills: 'full' };
  const skills = (cfg, opts = {}) => evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: cfg, ...opts }).violations.filter(v => v.check === 'skills-loaded' || v.check === 'skills-at-entry').map(v => v.check);
  assert.deepStrictEqual(skills(auto), ['skills-loaded', 'skills-at-entry'], 'control: the executor\'s own transcript loaded nothing');
  RR.appendHeadSkills(rolesFile, ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan']);
  assert.deepStrictEqual(skills({ ...auto, cycleRoles: rolesFile }), [], 'the head trader\'s recorded loads count');
  // Only what was recorded: one missing is still refused, by name.
  const partial = path.join(dir, 'partial.jsonl');
  RR.appendHeadSkills(partial, ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment']);
  const m = evaluateOrder({ input: entryOrder(), entries: [plan()], now: NOW, config: { ...auto, cycleRoles: partial } }).violations;
  assert.deepStrictEqual(m.map(v => v.check).filter(c => /skills/.test(c)), ['skills-at-entry']);
  assert.match(m.find(v => v.check === 'skills-at-entry').message, /not read in this session: trade-plan/);
  // A hook's transcript (another harness's session), a non-autonomous call, or no record: the transcript alone decides.
  assert.deepStrictEqual(skills({ ...auto, cycleRoles: rolesFile }, { transcriptPath: file }), ['skills-loaded', 'skills-at-entry']);
  assert.deepStrictEqual(skills({ ...auto, autonomous: false, cycleRoles: rolesFile }), ['skills-loaded', 'skills-at-entry']);
  assert.deepStrictEqual(skills({ ...auto, cycleRoles: path.join(dir, 'gone.jsonl') }), ['skills-loaded', 'skills-at-entry']);
  // Role runs alone in the record are no loads.
  const runsOnly = path.join(dir, 'runs.jsonl');
  RR.appendRoleRun(runsOnly, { role: 'risk-manager', start: 1.7e12, end: 1.7e12 + 1, text: 'trade-session multi-timeframe-analysis', lookups: ['trade-session'], ok: true });
  assert.deepStrictEqual(skills({ ...auto, cycleRoles: runsOnly }), ['skills-loaded', 'skills-at-entry']);
  // An exit never reaches it.
  assert.deepStrictEqual(evaluateOrder({ input: entryOrder({ side: 'sell', stopLossBracket: undefined, rationale: '[exit] flatten' }), entries: [], now: NOW, config: auto }).violations, []);
});

test('plan-required, in a runner\'s cycle: the plan is this cycle\'s bar\'s (written since its close, its briefing\'s closedAt, never before it opened); an earlier bar\'s plan, or an unreadable bar, is refused; outside a cycle as before; exits never held', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const home = require('../helpers').tmpDir();
  const BAR = '2026-10-07T13:54:00.000Z'; // closes 13:57; NOW is 14:00
  const at = iso => ({ ts: iso, kind: 'plan', contractId: CONTRACT, text: 'ORB long above 21500, stop 21480' });
  const cfg = (o = {}) => ({ ...config, home, autonomous: true, cycleBars: { MNQ: BAR }, ...o });
  const planChecks = (entries, c = cfg(), input = entryOrder()) => evaluateOrder({ input, entries, now: NOW, config: c }).violations.filter(v => v.check === 'plan-required');
  const { cyclePlanSince } = require('../../scripts/lib/trading/order-gate');
  // No briefing for the bar: since its open.
  assert.strictEqual(cyclePlanSince(cfg(), 'MNQ'), Date.parse(BAR));
  assert.deepStrictEqual(planChecks([at('2026-10-07T13:55:00.000Z')]), [], 'after the bar opened');
  assert.match(planChecks([at('2026-10-07T13:53:00.000Z')])[0].message, /No journal plan for MNQ written for this cycle's bar \(since 2026-10-07T13:54:00\.000Z\)/);
  // The briefing on the cycle's bar: since its close.
  B.writeBriefing(home, { symbol: 'MNQ', minutes: 3, asOf: BAR, closedAt: '2026-10-07T13:57:00.000Z', sections: {} });
  assert.strictEqual(cyclePlanSince(cfg(), 'MNQ'), Date.parse('2026-10-07T13:57:00.000Z'));
  assert.match(planChecks([at('2026-10-07T13:55:00.000Z')])[0].message, /since 2026-10-07T13:57:00\.000Z.*a plan from an earlier bar is not this entry's/, 'written while the bar formed: an earlier cycle\'s');
  assert.deepStrictEqual(planChecks([at('2026-10-07T13:57:00.000Z')]), []);
  assert.deepStrictEqual(planChecks([at('2026-10-07T13:59:30.000Z')]), []);
  // Still within planMaxAgeMin, and on the contract: the old rules hold too.
  assert.strictEqual(planChecks([at('2026-10-07T13:58:00.000Z')], cfg({ planMaxAgeMin: 1 })).length, 1);
  assert.strictEqual(planChecks([{ ...at('2026-10-07T13:58:00.000Z'), contractId: 'MES' }]).length, 1);
  // A briefing on another bar is not the cycle bar's: its open alone.
  B.writeBriefing(home, { symbol: 'MNQ', minutes: 3, asOf: '2026-10-07T13:51:00.000Z', closedAt: '2026-10-07T13:54:00.000Z', sections: {} });
  assert.strictEqual(cyclePlanSince(cfg(), 'MNQ'), Date.parse(BAR));
  // Several lanes: the briefing's bar (FTH_CYCLE_BRIEFING_BARS) gives the close; never before the lane bar opened.
  B.writeBriefing(home, { symbol: 'MNQ', minutes: 3, asOf: BAR, closedAt: '2026-10-07T13:57:00.000Z', sections: {} });
  assert.strictEqual(cyclePlanSince(cfg({ cycleBars: { MNQ: '2026-10-07T13:58:00.000Z' }, cycleBriefingBars: { MNQ: BAR } }), 'MNQ'), Date.parse('2026-10-07T13:58:00.000Z'));
  // An unreadable bar time: no plan is this bar's (fails closed).
  assert.ok(Number.isNaN(cyclePlanSince(cfg({ cycleBars: { MNQ: 'not a time' } }), 'MNQ')));
  assert.match(planChecks([at('2026-10-07T13:59:00.000Z')], cfg({ cycleBars: { MNQ: 'not a time' } }))[0].message, /its close, which can't be read/);
  // Outside a runner's cycle (not autonomous, or no cycle bar for the root): planMaxAgeMin alone, as before.
  assert.strictEqual(cyclePlanSince(cfg({ autonomous: false }), 'MNQ'), null);
  assert.strictEqual(cyclePlanSince(cfg({ cycleBars: { MES: BAR } }), 'MNQ'), null);
  assert.deepStrictEqual(planChecks([at('2026-10-07T13:50:00.000Z')], cfg({ autonomous: false })), []);
  assert.deepStrictEqual(planChecks([at('2026-10-07T13:50:00.000Z')], cfg({ cycleBars: {} })), []);
  // An exit or a protective stop is never held by it, whatever the plan.
  for (const rationale of ['[exit] flatten', '[protect] stop for the long']) {
    assert.deepStrictEqual(evaluateOrder({ input: entryOrder({ side: 'sell', type: 'stop', stopPrice: 21480, stopLossBracket: undefined, rationale }), entries: [], now: NOW, config: cfg() }).violations, [], rationale);
  }
});
