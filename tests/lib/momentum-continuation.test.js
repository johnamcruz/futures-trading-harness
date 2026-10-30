'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadStrategies, validateStrategy, scan, citingPolicies, citedSetups, componentRefusal, composedOf } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
const { candleSeries } = require('../../scripts/lib/trading/candle-facts');
const { momentumRead } = require('../../scripts/lib/trading/momentum');
const { prevailingSeries, ruleSeries, biasesAt, trendRule } = require('../../scripts/lib/trading/mtf');
const FX = require('../fixtures/momentum-continuation');

const ROOT = path.resolve(__dirname, '..', '..');
const ALL = loadStrategies(ROOT, {}).strategies;
const S2 = ALL.find(s => s.name === 'momentum_continuation');
const at = (bars, t) => bars.findIndex(b => b.t === t);

test('momentum_continuation: a valid, active rules strategy on 3m MNQ, listed in prop_portfolio beside trade_lifecycle, so a cited setup', () => {
  assert.ok(S2 && S2.valid, S2 && S2.errors.join('; '));
  assert.strictEqual(S2.status, 'active');
  assert.strictEqual(S2.signal, 'rules');
  assert.strictEqual(S2.timeframe, '3m');
  assert.deepStrictEqual(S2.instruments, ['MNQ']);
  assert.deepStrictEqual(S2.exit, { target_r: 2 });
  assert.strictEqual(S2.risk.stop_min, 3);
  assert.strictEqual(S2.risk.max_risk_usd, 300);
  const policy = ALL.find(s => s.name === 'prop_portfolio');
  assert.ok(policy.strategies.includes('momentum_continuation'));
  assert.deepStrictEqual(composedOf(policy, ALL), ['trade_lifecycle']);
  assert.deepStrictEqual(citingPolicies(ALL, 'momentum_continuation').map(p => p.name), ['prop_portfolio']);
  assert.deepStrictEqual([...citedSetups(ALL, 'trade_lifecycle')], ['momentum_continuation']);
  // Never a verdict source of its own (the runner's screen, the gate's verdict check and the backtester read this).
  assert.match(componentRefusal(policy, ALL, 'momentum_continuation'), /a setup trade_lifecycle cites in prop_portfolio: it is traded only through trade_lifecycle's compose record \(the setup read "momentum_continuation fired up\|down"\)/);
  assert.strictEqual(componentRefusal(policy, ALL, 'trade_lifecycle'), null);
  // A paper copy is cited only in a paper run; a policy without a composed strategy cites nothing.
  const paper = ALL.map(s => (s.name === 'momentum_continuation' ? { ...s, status: 'paper' } : s));
  assert.deepStrictEqual([...citedSetups(paper, 'trade_lifecycle')], []);
  assert.deepStrictEqual([...citedSetups(paper, 'trade_lifecycle', { paper: true })], ['momentum_continuation']);
  const plain = ALL.map(s => (s.name === 'prop_portfolio' ? { ...s, strategies: ['momentum_continuation'] } : s));
  assert.deepStrictEqual(citingPolicies(plain, 'momentum_continuation'), []);
  assert.deepStrictEqual([...citedSetups(plain, 'trade_lifecycle')], []);
});

test('momentum_continuation: risk.stop_min is a rules strategy\'s closest stop in points (widened to it), refused anywhere else', () => {
  const base = { name: 'x', description: 'x'.repeat(40), status: 'paper', instruments: ['MNQ'], timeframe: '3m', signal: 'rules', rules: { long: ['close > 0'], short: ['close < 0'] }, risk: { stop: 'atr:0.5', min_rr: 2, stop_min: 3 } };
  const body = '## When to Use\n## How It Works\n## Examples';
  assert.deepStrictEqual(validateStrategy(base, body, 'x'), []);
  for (const bad of [0, -1, '3', null]) assert.ok(validateStrategy({ ...base, risk: { ...base.risk, stop_min: bad } }, body, 'x').some(e => /risk\.stop_min: a distance in price points above 0/.test(e)), String(bad));
  assert.ok(validateStrategy({ ...base, signal: 'manual', rules: undefined }, body, 'x').some(e => /risk\.stop_min: only for signal: rules/.test(e)));
  // On the fixture's 09:48 ET candle: its own stop is 14.50 points (one tick under the low); a 20-point minimum widens it.
  const bars = FX.load();
  const i = at(bars, '2021-05-24T13:48:00.000Z');
  const ev = createEvaluator(bars);
  assert.strictEqual(ev.at(S2, i, { describe: false }).stopDistance, 14.5);
  assert.strictEqual(ev.at({ ...S2, risk: { ...S2.risk, stop_min: 20 } }, i, { describe: false }).stopDistance, 20);
});

test('momentum_continuation: the scan fires on exactly the S2 census candidates of the real-bar set on the BG side (time and side), stop one tick beyond the candle', () => {
  const bars = FX.load();
  const ev = createEvaluator(bars);
  const from = at(bars, FX.CENSUS[0][0]) - 1;
  const fired = [];
  for (let i = from; i < bars.length; i += 1) {
    const r = ev.at(S2, i, { describe: false });
    if (r.candidate) {
      fired.push([bars[i].t, r.direction]);
      // Its stop: the candle's far extreme plus one tick from its close, at least 3.00 points (12 ticks).
      const b = bars[i];
      const own = r.direction === 'long' ? b.c - b.l + 0.25 : b.h - b.c + 0.25;
      assert.strictEqual(r.stopDistance, Math.round(Math.max(3, own) * 1e4) / 1e4, b.t);
    }
  }
  // The census's 34 on its prevailing-trend side; on the entry rule's side (BG: the owner's change) 29, the five 2021-05-17
  // morning shorts dropped (the 4h and 1h ranging, the 15m down, the trend not declared down).
  assert.deepStrictEqual([FX.CENSUS.length, FX.CENSUS_BG.length], [34, 29]);
  assert.deepStrictEqual(fired, FX.CENSUS_BG.map(([t, side]) => [t, side]));
});

test('momentum_continuation: it fires only on the side the entry rule allows (BG), and the gate takes every fire on its side', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const { entryRuleOf, entryProblems, BIAS_FRAMES, NEUTRAL } = require('../../scripts/lib/trading/entry-rule');
  const { chainSideSeries } = require('../../scripts/lib/trading/chain-side');
  const RULE = entryRuleOf({ bias_frames: [...BIAS_FRAMES], bias_agree: NEUTRAL, regime_against: 'off', leg_turned: 'off' });
  const bars = FX.load();
  const ev = createEvaluator(bars);
  const side = chainSideSeries(bars);
  const from = at(bars, FX.CENSUS[0][0]) - 1;
  let n = 0;
  for (let i = from; i < bars.length; i += 1) {
    const r = ev.at(S2, i, { describe: false });
    if (!r.candidate) continue;
    n += 1;
    assert.strictEqual(side[i], r.direction === 'long' ? 1 : -1, `${bars[i].t}: the series' side`);
    // Parity with the gate: the briefing the runner builds on this bar's bars, the shipped rule's own check, its side.
    const b = B.buildBriefing({ symbol: 'MNQ', bars: bars.slice(0, i + 1), minutes: 3 });
    assert.deepStrictEqual(entryProblems({ briefing: b, side: r.direction, reads: [], rule: RULE }), [], `${bars[i].t} ${r.direction}`);
  }
  assert.strictEqual(n, FX.CENSUS_BG.length);
  // A dropped one: both ranging, the 15m down, not declared: no side there, so no fire; the gate refuses the short too.
  const k = at(bars, FX.BG_DROPPED[0]);
  assert.strictEqual(side[k], 0);
  assert.strictEqual(ev.at(S2, k, { describe: false }).candidate, false);
  const kb = B.buildBriefing({ symbol: 'MNQ', bars: bars.slice(0, k + 1), minutes: 3 });
  assert.match(entryProblems({ briefing: kb, side: 'short', reads: [], rule: RULE }).join(), /not declared down/);
});

test('momentum_continuation: the live scan fires long on the census\'s 2021-05-24 09:48 ET candle, and not on a candle without momentum, one against the trend or the opening print', () => {
  const bars = FX.load();
  const scanAt = t => scan([S2], bars.slice(0, at(bars, t) + 1), { symbol: 'MNQ' })[0];
  const hit = scanAt('2021-05-24T13:48:00.000Z');
  assert.deepStrictEqual([hit.candidate, hit.direction, hit.stopDistance, hit.entryRef], [true, 'long', 14.5, 16910]);
  assert.deepStrictEqual(hit.rules.long.map(r => r.ok), [true, true, true, true]);
  assert.strictEqual(hit.mtf.prevailing, '4h up');
  assert.deepStrictEqual(hit.exit.targetR, 2);
  const cs = candleSeries(bars, 3, 3);
  const prev = prevailingSeries(bars);
  const facts = t => { const i = at(bars, t); return { mom: cs.htfd_momentum[i], prevailing: prev[i] }; };
  // 09:42: no momentum (the census's none); 09:45: momentum down against the 4h up; 09:30: momentum up in the opening print.
  for (const [t, f] of [['2021-05-24T13:42:00.000Z', { mom: 0, prevailing: 1 }], ['2021-05-24T13:45:00.000Z', { mom: -1, prevailing: 1 }], ['2021-05-24T13:30:00.000Z', { mom: 1, prevailing: 1 }]]) {
    assert.deepStrictEqual(facts(t), f, t);
    const r = scanAt(t);
    assert.strictEqual(r.candidate, false, t);
  }
  // A short with the trend: the 2021-05-20 09:42 ET candle, its stop 17.00 points above the close.
  const short = scanAt('2021-05-20T13:42:00.000Z');
  assert.deepStrictEqual([short.candidate, short.direction, short.stopDistance], [true, 'short', 17]);
});

test('momentum_continuation: no look-ahead: the candle read is the closed one; a bar sees only bars closed by it', () => {
  const bars = FX.load();
  const i = at(bars, '2021-05-24T13:48:00.000Z');
  const cs = candleSeries(bars, 3, 3);
  // htfd_momentum(3) on 3m bars is the candle that closed with the bar (momentum.js on its own facts), never the next.
  assert.strictEqual(cs.htfd_momentum[i], 1);
  assert.strictEqual(cs.htfd_momentum[i - 1], -1, 'the 09:45 candle before it, down');
  const ev = createEvaluator(bars);
  // The scan on the bars up to the candle equals the full set's evaluation at it: later bars change nothing.
  const truncated = scan([S2], bars.slice(0, i + 1), { symbol: 'MNQ' })[0];
  assert.deepStrictEqual([truncated.candidate, truncated.direction, truncated.stopDistance], [true, 'long', 14.5]);
  const full = ev.at(S2, i, { describe: false });
  assert.deepStrictEqual([full.candidate, full.direction, full.stopDistance], [true, 'long', 14.5]);
  const edited = bars.map((b, k) => (k > i ? { ...b, h: b.h + 50, c: b.c + 40 } : b));
  const after = createEvaluator(edited).at(S2, i, { describe: false });
  assert.deepStrictEqual([after.candidate, after.direction, after.stopDistance], [true, 'long', 14.5]);
  // Before it closed (the bars end one bar earlier) nothing about it fires.
  assert.strictEqual(scan([S2], bars.slice(0, i), { symbol: 'MNQ' })[0].candidate, false);
  // The trend rule's prevailing frame is the gate's: trendRule on the rule series at the bar.
  const r = trendRule(biasesAt(ruleSeries(bars), i), 0);
  assert.strictEqual(prevailingSeries(bars)[i], r.prevailing && r.prevailing.trend === 'up' ? 1 : -1);
});

test('htfd_momentum is momentum.js\'s read on the unrounded candle facts; mtf_prevailing is missing until the 4h trend rule is ready', () => {
  const bars = FX.load();
  const cs = candleSeries(bars, 3, 3);
  for (let i = 100; i < bars.length; i += 97) {
    const loc = cs.htfd_close_loc[i] === 1 ? 'top' : cs.htfd_close_loc[i] === -1 ? 'bottom' : cs.htfd_close_loc[i] === 0 ? 'middle' : null;
    const m = momentumRead({ rangeAtr: cs.htfd_range_atr[i], volRatio: cs.htfd_vol_ratio[i], closeLocation: loc });
    assert.strictEqual(cs.htfd_momentum[i], m === 'up' ? 1 : m === 'down' ? -1 : m === 'none' ? 0 : NaN, bars[i].t);
  }
  const prev = prevailingSeries(bars.slice(0, 20));
  assert.ok(prev.every(x => Number.isNaN(x)), 'no 4h read in an hour of bars');
});
