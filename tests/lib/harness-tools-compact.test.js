'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { scanSummary, whyNot, recentLines } = require('../../scripts/lib/harness-tools/compact');
const strategies = require('../../scripts/lib/harness-tools/strategies');
const marketSnapshot = require('../../scripts/lib/harness-tools/market-snapshot');

const ROOT = path.resolve(__dirname, '..', '..');
const CSV = path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv');

const mtf = { style: 'trend', frames: { '4h': 'up', '1h': 'up', '15m': 'down' }, prevailing: '4h up', ready: true, longAllowed: true, shortAllowed: false };
const rules = (long, short) => ({ long: long.map(([rule, ok]) => ({ rule, ok })), short: short.map(([rule, ok]) => ({ rule, ok })) });
const RESULTS = [
  { name: 'orb', status: 'active', timeframe: '3m', inSession: true, regime: 'trend-up', regimes: null, inRegime: true, signal: 'rules', direction: 'long', filtersFailed: [], candidate: true, entryRef: 21503.25, stopDistance: 5.25, minRR: 1.5,
    exit: { targetR: 1.5, target: null, trailActivateR: null, trailGivebackR: null, maxBars: null }, mtf, rules: rules([['close crosses_above or_high', true]], [['close crosses_below or_low', false]]), confluence: { with: ['ema_cross'], against: [] } },
  { name: 'ema_cross', status: 'paper', timeframe: '3m', inSession: true, regime: 'trend-up', inRegime: true, signal: 'rules', direction: 'long', filtersFailed: [], candidate: true, entryRef: 21503.25, stopDistance: 6, minRR: 2,
    exit: { targetR: null, target: null, trailActivateR: 2, trailGivebackR: 0.5, maxBars: 40 }, mtf, confluence: { with: ['orb'], against: ['keltner', 'bos'] } },
  { name: 'keltner', status: 'active', timeframe: '3m', inSession: true, regime: 'trend-up', inRegime: true, signal: 'rules', direction: 'short', filtersFailed: ['mtf: against the prevailing 4h up trend'], candidate: false, entryRef: 21503.25, stopDistance: 4, minRR: 2, exit: {}, mtf },
  { name: 'bos', status: 'active', timeframe: '3m', inSession: true, regime: 'trend-up', inRegime: true, signal: 'rules', direction: null, filtersFailed: [], candidate: false, entryRef: 21503.25, stopDistance: null, minRR: 1.5, exit: {}, mtf,
    rules: rules([['close crosses_above swing_high', false], ['atr(20) > 0', true]], [['close crosses_below swing_low', false], [`x${'y'.repeat(200)}`, false]]) },
  { name: 'crt_1h', status: 'paper', timeframe: '3m', inSession: false, regime: 'trend-up', regimes: ['range'], inRegime: false, signal: 'rules', direction: null, filtersFailed: [], candidate: false, exit: {}, mtf,
    rules: rules([], [['crt_dir(60) < 0', false]]), detail: { 'crt(60)': { reason: 'not_reclaimed', why: 'the close is not back inside the previous candle\'s range' } } },
  { name: 'vwap_reclaim', status: 'active', timeframe: '3m', inSession: false, regime: 'range', regimes: ['trend'], inRegime: false, signal: 'rules', direction: 'long', filtersFailed: ['VWAP distance 3.67 ATR > 1.5'], candidate: false, exit: {}, mtf },
  { name: 'value_area', status: 'active', timeframe: '3m', inSession: true, signal: 'manual', candidate: true, note: 'evaluate the trigger from STRATEGY.md',
    mtf: { ...mtf, ready: false, longAllowed: false, shortAllowed: false, reason: '4h: not enough candles for a trend' } },
  { name: 'session_fade', status: 'active', timeframe: '3m', inSession: false, inRegime: true, signal: 'manual', candidate: false, mtf },
  { name: 'prop_portfolio', status: 'paper', signal: 'policy', candidate: false, note: 'a policy strategy: the runner screens the setups of orb, bos' },
  { name: 'broken', status: 'active', error: 'unknown series foo', candidate: false },
];

test('whyNot: one line for why a result is not a candidate; nothing for a candidate', () => {
  const by = Object.fromEntries(RESULTS.map(r => [r.name, whyNot(r)]));
  assert.strictEqual(by.orb, '');
  assert.strictEqual(by.ema_cross, '');
  assert.strictEqual(by.keltner, 'failed: mtf: against the prevailing 4h up trend');
  assert.match(by.bos, /^no rule set fired \(long: close crosses_above swing_high; short: close crosses_below swing_low, xy{98}…\)$/, 'the rules that did not hold, a long one cut');
  assert.strictEqual(by.crt_1h, 'no rule set fired (short: crt_dir(60) < 0); the close is not back inside the previous candle\'s range; outside its sessions; regime trend-up not in its regimes (range)');
  assert.strictEqual(by.vwap_reclaim, 'outside its sessions; regime range not in its regimes (trend); failed: VWAP distance 3.67 ATR > 1.5');
  assert.strictEqual(by.value_area, 'manual: in session; evaluate its trigger from STRATEGY.md');
  assert.strictEqual(by.session_fade, 'manual; outside its sessions');
  assert.strictEqual(by.prop_portfolio, 'a policy strategy: the runner screens the setups of orb, bos');
  assert.strictEqual(by.broken, 'error: unknown series foo');
  assert.strictEqual(whyNot({ name: 'x', signal: 'rules', direction: 'long', candidate: false, inSession: true, inRegime: null, filtersFailed: [] }), 'not a candidate', 'never blank for a non-candidate');
});

test('scanSummary: the bar and trend, the candidates first with what a plan needs, then one line per strategy', () => {
  const text = scanSummary(RESULTS, { symbol: 'MNQ', bar: '2026-10-07T14:00:00.000Z' });
  const lines = text.trimEnd().split('\n');
  assert.strictEqual(lines[0], 'Scan of MNQ on the last closed bar (opened 2026-10-07T14:00:00.000Z): 10 strategies, 3 candidates. Regime trend-up. Trend 4h up, 1h up, 15m down, prevailing 4h up.');
  assert.strictEqual(lines[1], 'Candidates:');
  // Distances in points and in ticks for the symbol (a stop rounded away from the entry, a target toward it), with a contract's dollars.
  assert.strictEqual(lines[2], '  orb long | active, 3m, rules, mtf trend | entryRef 21503.25, stop 5.25 pts = 21 ticks ($10.50/MNQ contract), target 1.5R = 31 ticks ($15.50/MNQ contract), minRR 1.5, exit: target 1.5R | with: ema_cross; against: none');
  assert.strictEqual(lines[3], '  ema_cross long | paper (plan only: the gate refuses a live entry), 3m, rules, mtf trend | entryRef 21503.25, stop 6 pts = 24 ticks ($12.00/MNQ contract), minRR 2, exit: trail from 2R giving back 0.5R, at most 40 bars | with: orb; against: keltner, bos');
  assert.strictEqual(lines[4], '  value_area (manual: evaluate its trigger from STRATEGY.md) | active, 3m, manual, mtf trend | trend rule: long no, short no (4h: not enough candles for a trend)');
  assert.strictEqual(lines[5], 'Exact order numbers (stop and target prices and ticks, size, $ risk, place_order arguments) for a strategy and side you choose: order_plan.');
  lines.splice(5, 1);
  // A manual candidate says which sides the trend rule leaves open, so no plan takes a side the gate refuses.
  assert.match(scanSummary([{ name: 'm', status: 'active', timeframe: '3m', signal: 'manual', candidate: true, mtf }]), /\n {2}m \(manual: [^)]*\) \| active, 3m, manual, mtf trend \| trend rule: long ok, short no\n/);
  assert.match(scanSummary([{ name: 'm', status: 'active', signal: 'manual', candidate: true }]), /\| trend rule: unknown\n/);
  assert.strictEqual(lines[5], 'Every strategy (name | status | timeframe | direction | candidate | why not):');
  assert.strictEqual(lines.length, 6 + RESULTS.length + 1, 'one line per strategy, then how to get more');
  assert.strictEqual(lines[6], '  orb | active | 3m | long | yes | -');
  assert.strictEqual(lines[8], '  keltner | active | 3m | short | no | failed: mtf: against the prevailing 4h up trend');
  assert.strictEqual(lines[14], '  prop_portfolio | paper | - | - | no | a policy strategy: the runner screens the setups of orb, bos');
  assert.match(lines.at(-1), /name; every strategy's \(large\): detail true/);
  // Nothing fired, nothing scanned.
  assert.match(scanSummary([RESULTS[2]], {}), /^Scan: 1 strategies, 0 candidates\. Regime trend-up\. .*\nCandidates: none\.\n/);
  assert.match(scanSummary([], { symbol: 'MES' }), /^Scan of MES: 0 strategies, 0 candidates\.\nCandidates: none\.\nEvery strategy/);
  assert.match(scanSummary(null), /0 strategies/);
});

test('scanSummary: units per instrument - MES $1.25 a tick, a level target floored, no made-up ticks without specs', () => {
  const r = { ...RESULTS[0], stopDistance: 8.4579, targetDistance: 12.6, exit: { targetR: null, target: 'level' } };
  assert.match(scanSummary([r], { symbol: 'MES' }), /entryRef 21503\.25, stop 8\.4579 pts = 34 ticks \(\$42\.50\/MES contract\), target 12\.6 pts = 50 ticks \(\$62\.50\/MES contract\), minRR/);
  assert.match(scanSummary([r], { symbol: 'MNQ' }), /stop 8\.4579 pts = 34 ticks \(\$17\.00\/MNQ contract\), target 12\.6 pts = 50 ticks \(\$25\.00\/MNQ contract\)/);
  assert.match(scanSummary([r], { symbol: 'ZZZ' }), /stop 8\.4579 pts, target 12\.6 pts, no tick specs for ZZZ, minRR/);
  assert.match(scanSummary([{ ...r, targetDistance: null }], { symbol: 'MNQ' }), /target none on this bar/);
  // No rules candidate (only a manual one): no order_plan line.
  assert.doesNotMatch(scanSummary([RESULTS[6]], { symbol: 'MNQ' }), /order_plan/);
});

test('recentLines: one line per bar, oldest first, none where nothing fired', () => {
  assert.strictEqual(recentLines([{ bar: '2026-10-07T13:57:00.000Z', fired: [] }, { bar: '2026-10-07T14:00:00.000Z', fired: ['orb long', 'ema_cross long'] }], { symbol: 'MNQ' }),
    'What fired on MNQ on each of the last 2 closed bars (bar open time, oldest first):\n  2026-10-07T13:57:00.000Z none\n  2026-10-07T14:00:00.000Z orb long, ema_cross long\n');
  assert.strictEqual(recentLines([]), 'What fired on each of the last 0 closed bars (bar open time, oldest first):\n');
});

test('the operations: the scripts\' full forms by default, the tools\' compact forms on request', () => {
  const ctx = { root: ROOT, env: {}, now: () => new Date('2026-10-07T14:03:30Z') };
  const full = strategies.scan({ file: CSV, symbol: 'MNQ' }, ctx).text;
  const results = JSON.parse(full);
  assert.ok(full.startsWith('[\n  {'), 'the script prints the pretty JSON');
  const summary = strategies.scan({ file: CSV, symbol: 'mnq', view: 'summary' }, ctx).text;
  assert.ok(summary.startsWith('Scan of MNQ on the last closed bar (opened '), summary.slice(0, 80));
  assert.ok(summary.length < full.length / 3, `${summary.length} vs ${full.length}`);
  for (const r of results) assert.ok(summary.includes(`\n  ${r.name} | `), r.name);
  const name = results.find(r => r.signal === 'rules').name;
  assert.deepStrictEqual(JSON.parse(strategies.scan({ file: CSV, symbol: 'MNQ', view: 'one', name }, ctx).text), results.find(r => r.name === name));
  assert.throws(() => strategies.scan({ file: CSV, symbol: 'MNQ', view: 'one', name: 'nope' }, ctx), /no scan result for "nope" \(scanned: .*orb/);
  // recent: JSON by default (the script), lines on request.
  const rows = JSON.parse(strategies.recent({ file: CSV, symbol: 'MNQ', count: 3 }, ctx).text);
  assert.strictEqual(strategies.recent({ file: CSV, symbol: 'mnq', count: 3, format: 'lines' }, ctx).text, recentLines(rows, { symbol: 'MNQ' }));
  // list json and the snapshot: the same JSON, on one line.
  const list = strategies.list({ json: true }, ctx).text;
  assert.deepStrictEqual(JSON.parse(strategies.list({ json: true, compact: true }, ctx).text), JSON.parse(list));
  assert.strictEqual(strategies.list({ json: true, compact: true }, ctx).text.split('\n').length, 2);
  assert.strictEqual(strategies.list({ compact: true }, ctx).text, strategies.list({}, ctx).text, 'the text list is already compact');
  const snap = marketSnapshot.snapshot({ file: CSV }).text;
  const one = marketSnapshot.snapshot({ file: CSV, compact: true }).text;
  assert.deepStrictEqual(JSON.parse(one), JSON.parse(snap));
  assert.ok(snap.split('\n').length > 50 && one.split('\n').length === 2);
});
