'use strict';

// What the model is shown, fixed at its source: a candidate's target as its own side's, the VWAP
// crosses labeled by their VWAP (the session count is the regime's), fair value gaps open or partly
// filled (with the part still unfilled), and the volume profile's levels on the contract's tick.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tickOf, onTick } = require('../../scripts/lib/trading/contracts');
const { sideTarget } = require('../../scripts/lib/trading/order-plan');
const { scanSummary } = require('../../scripts/lib/harness-tools/compact');
const { snapshot, fairValueGaps } = require('../../scripts/lib/trading/market-snapshot');
const { classifyRegime } = require('../../scripts/lib/trading/regime');
const B = require('../../scripts/lib/trading/briefing');
const { parseArgv } = require('../../scripts/lib/harness-tools/market-snapshot');
const { readBarsArg } = require('../../scripts/lib/backtest/data');

const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const onGrid = (x, tick) => Math.abs(x / tick - Math.round(x / tick)) < 1e-9;

test('onTick and tickOf: a price on the contract\'s tick, by its standard name; unchanged without a tick', () => {
  assert.strictEqual(onTick(27246.54, 0.25), 27246.5);
  assert.strictEqual(onTick(27414.32375, 0.25), 27414.25);
  assert.strictEqual(onTick(27455.855, 0.25), 27455.75);
  assert.strictEqual(onTick(2283.14, 0.1), 2283.1);
  assert.strictEqual(onTick(31.2374, 0.005), 31.235);
  assert.strictEqual(onTick(12.3456, null), 12.3456);
  assert.strictEqual(onTick(NaN, 0.25), null);
  assert.strictEqual(tickOf('MNQ'), 0.25);
  assert.strictEqual(tickOf('NQ:2026-03'), 0.25);
  assert.strictEqual(tickOf('M2K'), 0.1);
  assert.strictEqual(tickOf('ZZZ'), null);
  assert.strictEqual(tickOf(''), null);
});

test('sideTarget: a per-side target gives the side\'s own formula; a single one is both sides\'', () => {
  const both = { long: 'prior_vah - close', short: 'close - prior_val' };
  assert.strictEqual(sideTarget(both, 'short'), 'close - prior_val');
  assert.strictEqual(sideTarget(both, 'long'), 'prior_vah - close');
  assert.strictEqual(sideTarget(both, null), null);
  assert.strictEqual(sideTarget({ long: 'x' }, 'short'), null);
  assert.strictEqual(sideTarget('crt_target(60)', 'long'), 'crt_target(60)');
  assert.strictEqual(sideTarget(null, 'long'), null);
});

test('the compact scan renders a per-side target as the fired side\'s level, never [object Object]', () => {
  const r = {
    name: 'value_area', direction: 'short', candidate: true, status: 'active', timeframe: '3m', signal: 'rules',
    entryRef: 27394.25, stopDistance: 28, targetDistance: 147.5, minRR: 2,
    exit: { targetR: null, target: { long: 'prior_vah - close', short: 'close - prior_val' }, maxBars: 40 },
    confluence: { with: [], against: [] },
  };
  const text = scanSummary([r], { symbol: 'MNQ' });
  assert.doesNotMatch(text, /object Object/);
  assert.match(text, /exit: target level close - prior_val, at most 40 bars/);
  assert.doesNotMatch(text, /prior_vah/);
  const r2 = { ...r, direction: 'long', exit: { targetR: 2, target: null, maxBars: null } };
  assert.match(scanSummary([r2], { symbol: 'MNQ' }), /exit: target 2R/);
});

test('fairValueGaps: open (not traded back into), partly filled (the unfilled part), filled (dropped)', () => {
  const t = k => new Date(Date.UTC(2026, 9, 7, 14, 3 * k)).toISOString();
  const bar = (k, l, h) => ({ t: t(k), o: l, h, l, c: h, v: 1 });
  // A bullish gap 10-12 (bar 0 high 10, bar 2 low 12).
  const base = [bar(0, 9, 10), bar(1, 10, 13), bar(2, 12, 14)];
  assert.deepStrictEqual(fairValueGaps([...base, bar(3, 12.5, 15)]).open.map(g => [g.low, g.high]), [[10, 12]]);
  const partly = fairValueGaps([...base, bar(3, 11, 15)]);
  assert.deepStrictEqual(partly.open, []);
  assert.deepStrictEqual(partly.partly.map(g => [g.side, g.low, g.high, g.gapLow, g.gapHigh]), [['bullish', 10, 11, 10, 12]]);
  const filled = fairValueGaps([...base, bar(3, 9.75, 15)]);
  assert.deepStrictEqual([filled.open, filled.partly], [[], []]);
  // A bearish gap 12-14 (bar 0 low 14, bar 2 high 12), traded up into 13: 13-14 still unfilled.
  const down = [bar(0, 14, 15), bar(1, 11, 14.5), bar(2, 10, 12), bar(3, 10, 13)];
  assert.deepStrictEqual(fairValueGaps(down).partly.map(g => [g.side, g.low, g.high, g.gapLow, g.gapHigh]), [['bearish', 13, 14, 12, 14]]);
});

test('the snapshot\'s session VWAP crosses are the regime\'s own count, labeled by their VWAP', () => {
  for (const n of [600, 900, 1300]) {
    const bars = BARS.slice(0, n);
    const s = snapshot({ bars });
    const reg = classifyRegime(bars);
    assert.strictEqual(s.regime.metrics.sessionVwapCrosses, s.vwap.sessionCrossesLast30, `bar ${n}`);
    assert.strictEqual(reg.metrics.sessionVwapCrosses, s.vwap.sessionCrossesLast30);
    assert.ok(!('vwapCrosses' in s.regime.metrics), 'no unlabeled count');
    assert.ok(Number.isInteger(s.vwap.rthCrossesLast30));
  }
});

test('the briefing labels each crosses count by its VWAP and states the session one is the regime\'s', () => {
  const b = B.buildBriefing({ symbol: 'NQ', bars: BARS.slice(0, 1300), minutes: 3 });
  const vw = b.sections.m3.data.vwap;
  assert.ok(!('crossesLast30' in vw));
  assert.strictEqual(vw.sessionCrossesLast30, b.sections.m3.data.regime.metrics.sessionVwapCrosses);
  const text = B.renderBriefing(b, { now: new Date(b.closedAt) });
  assert.match(text, /Closes crossing a VWAP in the last 30 bars: the RTH VWAP \d+, the session VWAP \d+ \(the regime's count\)/);
});

test('the volume profile\'s levels come on the contract\'s tick with one; two decimals without', () => {
  const bars = BARS.slice(0, 1300);
  const s = snapshot({ bars, tickSize: 0.25 });
  for (const kind of ['priorRth', 'session']) {
    const p = s.volumeProfile[kind];
    for (const x of [p.poc, p.vah, p.val, p.low, p.high, ...p.hvn, ...p.lvn, p.hvnAbove, p.hvnBelow, p.lvnAbove, p.lvnBelow].filter(v => v !== null)) {
      assert.ok(onGrid(x, 0.25), `${kind} ${x}`);
    }
  }
  if (s.day && s.day.prior && Number.isFinite(s.day.prior.vah)) {
    assert.ok(onGrid(s.day.prior.vah, 0.25) && onGrid(s.day.prior.val, 0.25) && onGrid(s.day.prior.poc, 0.25));
  }
  const raw = snapshot({ bars });
  assert.ok([raw.volumeProfile.priorRth.poc, raw.volumeProfile.priorRth.vah].every(x => Math.round(x * 100) === x * 100 || Math.abs(Math.round(x * 100) - x * 100) < 1e-6));
  // The briefing's profiles and dealing ranges use the contract's tick.
  const b = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3 });
  const pp = b.sections.day.data.priorProfile;
  if (pp) for (const x of [pp.poc, pp.vah, pp.val, ...pp.hvn, ...pp.lvn]) assert.ok(onGrid(x, 0.25), `prior profile ${x}`);
  const h1 = b.sections.h1.data.h1;
  if (h1 && h1.range) assert.ok(onGrid(h1.range.mid, 0.25), `range mid ${h1.range.mid}`);
});

test('market_snapshot takes the contract root (--symbol), not as an indicator parameter', () => {
  assert.deepStrictEqual(parseArgv(['b.json', '--symbol=mnq', '--orbMinutes=30']), { file: 'b.json', params: { orbMinutes: 30 }, symbol: 'MNQ' });
  assert.deepStrictEqual(parseArgv(['b.json']), { file: 'b.json', params: {} });
});
