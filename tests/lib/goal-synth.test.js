'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const S = require('../../scripts/lib/eval/goal-synth');
const GF = require('../../scripts/lib/eval/goal-fixture');
const GT = require('../../scripts/lib/eval/goal-trades');
const { chainSideSeries } = require('../../scripts/lib/trading/chain-side');

const ROOT = path.resolve(__dirname, '..', '..');
const FX = S.synthFixture();
const P = GT.shippedOf(ROOT, {});
const blockOf = name => FX.blocks.find(b => b.scenario === name);

test('synthFixture: deterministic (the same document, the same hash), its blocks the configured scenarios', () => {
  const again = S.synthFixture();
  assert.strictEqual(again.hash, FX.hash);
  assert.deepStrictEqual(FX.blocks.map(b => [b.half, b.scenario]), [['M', 'fakeout'], ['M', 'quiet'], ['S', 'bleed']]);
  for (const b of FX.blocks) for (const d of b.sessions) assert.ok(b.labels[d].kind === 'non-trend' && b.labels[d].why, `${b.scenario} ${d}`);
});

test('the bars: on MNQ\'s tick, OHLC consistent, volume on every bar, the warm-up before the first session', () => {
  for (const b of FX.blocks) {
    const bars = GF.decodeBars(b.bars);
    for (const x of bars) {
      for (const k of ['o', 'h', 'l', 'c']) assert.ok(Math.abs(x[k] / 0.25 - Math.round(x[k] / 0.25)) < 1e-9, `${x.t} ${k}`);
      assert.ok(x.l <= Math.min(x.o, x.c) && x.h >= Math.max(x.o, x.c) && x.v > 0, x.t);
    }
    const first = bars.findIndex(x => x.t.slice(0, 10) === b.sessions[0]);
    assert.ok(Date.parse(bars[first].t) - Date.parse(bars[0].t) > 400 * 3600000, `${b.scenario}: the warm-up`);
  }
});

test('the scenarios do what they are for: the fakeout fires one setup on the side and stops at -1R; the quiet day has no setup; the blow path loses past 1R every session', () => {
  const run = name => { const b = blockOf(name); return GT.blockTrades(GF.decodeBars(b.bars), b.sessions, P, { symbol: 'MNQ' }); };
  const f = run('fakeout');
  const b = blockOf('fakeout');
  const bars = GF.decodeBars(b.bars);
  const side = chainSideSeries(bars, { rule: P.entryRule, minutes: 3 });
  assert.strictEqual(f.trades.length, 1);
  assert.strictEqual(side[bars.findIndex(x => x.t === f.trades[0].setupAt)], 1, 'on the BG side (long)');
  assert.deepStrictEqual([f.trades[0].reason, f.trades[0].R < -0.99 && f.trades[0].R >= -1.1], ['stop', true]);
  assert.strictEqual(run('quiet').trades.length, 0);
  const bleed = run('bleed');
  const days = blockOf('bleed').sessions;
  for (const d of days) {
    const first = bleed.trades.find(t => t.day === d);
    assert.ok(first && first.R < -1.2, `${d}: a loss past 1R (${first && first.R})`);
  }
});
