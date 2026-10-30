'use strict';

// The entry rule's side per bar (scripts/lib/trading/chain-side.js, the rules language's chain_side) and the regime
// series it reads (regime.js primarySeries).

const test = require('node:test');
const assert = require('node:assert');
const FX = require('../fixtures/momentum-continuation');
const { chainSideSeries, briefingAt } = require('../../scripts/lib/trading/chain-side');
const { classifyRegime, primarySeries } = require('../../scripts/lib/trading/regime');
const B = require('../../scripts/lib/trading/briefing');
const { entryRuleOf, entryProblems, BIAS_FRAMES, NEUTRAL } = require('../../scripts/lib/trading/entry-rule');

const RULE = entryRuleOf({ bias_frames: [...BIAS_FRAMES], bias_agree: NEUTRAL, regime_against: 'off', leg_turned: 'off' });
const bars = FX.load();
const at = t => bars.findIndex(b => b.t === t);

test('primarySeries: each bar\'s primary regime is classifyRegime\'s on the bars up to it', () => {
  const ps = primarySeries(bars);
  for (let i = 0; i < bars.length; i += 37) {
    const c = classifyRegime(bars.slice(0, i + 1));
    assert.strictEqual(ps[i], c ? c.primary : null, `bar ${i}`);
  }
});

test('chainSideSeries: causal, the entry rule\'s own side on each bar, and the gate\'s on the runner\'s briefing', () => {
  const side = chainSideSeries(bars);
  assert.ok(side.every(x => x === 1 || x === -1 || x === 0));
  // Causal: the series on a prefix ends where the full one has it.
  for (const k of [at('2021-05-17T13:39:00.000Z'), at('2021-05-18T13:36:00.000Z'), at('2021-05-24T13:48:00.000Z')]) {
    assert.strictEqual(chainSideSeries(bars.slice(0, k + 1))[k], side[k], bars[k].t);
  }
  // The census's dropped short (both ranging, the 15m down, not declared): no side, and the gate refuses the short.
  const k = at(FX.BG_DROPPED[0]);
  assert.strictEqual(side[k], 0);
  const b = B.buildBriefing({ symbol: 'MNQ', bars: bars.slice(0, k + 1), minutes: 3 });
  assert.match(entryProblems({ briefing: b, side: 'short', reads: [], rule: RULE }).join(), /not declared down/);
  // A kept long: its side, and the gate's.
  const j = at('2021-05-24T13:48:00.000Z');
  assert.strictEqual(side[j], 1);
  assert.deepStrictEqual(entryProblems({ briefing: B.buildBriefing({ symbol: 'MNQ', bars: bars.slice(0, j + 1), minutes: 3 }), side: 'long', reads: [], rule: RULE }), []);
});

test('briefingAt: the entry rule reads its four facts; a BG-only bar has its side, both ranging undeclared none', () => {
  const side = x => ['long', 'short'].filter(s => !entryProblems({ briefing: briefingAt(x), side: s, reads: [], rule: RULE }).length);
  assert.deepStrictEqual(side({ t4h: 'up', t1h: 'range', t15: 'down', declared: null }), ['long']);
  assert.deepStrictEqual(side({ t4h: 'range', t1h: 'down', t15: 'up', declared: null }), ['short']);
  assert.deepStrictEqual(side({ t4h: 'range', t1h: 'range', t15: 'down', declared: null }), []);
  assert.deepStrictEqual(side({ t4h: 'up', t1h: 'down', t15: 'up', declared: null }), []);
  const dec = { long: { vwapAtr: -0.5, ema20Atr: -0.2, dayMoveAtr: -1, regime: 'against' }, short: { vwapAtr: 0.5, ema20Atr: 0.2, dayMoveAtr: 1, regime: 'with' } };
  assert.deepStrictEqual(side({ t4h: 'range', t1h: 'range', t15: 'down', declared: dec }), ['short']);
});
