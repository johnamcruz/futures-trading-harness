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
  assert.deepStrictEqual(FX.blocks.map(b => [b.half, b.scenario]), [['M', 'fakeout'], ['M', 'quiet'], ['M', 'listed-vwap'], ['M', 'limit-fill'], ['S', 'bleed'], ['M', 'floor-ticks'], ['M', 'floor-atr']]);
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

test('the floor days: the reaction candle breaks the overnight high by crossTicks from belowTicks under it, no bar of it closing at its top; the confirming close confirmTicks over it; flat after; the V only on floor-atr', () => {
  const cfg = require('../../scripts/lib/tunables').training().goalRegression.synth.floor;
  const { RTH_OPEN_MIN, RTH_CLOSE_MIN, MARKET_TZ, minutesOfDay, tradingDayKey } = require('../../scripts/lib/trading/clock');
  for (const [name, v] of [['floor-ticks', cfg.ticks], ['floor-atr', cfg.atr]]) {
    const b = blockOf(name);
    const day = b.sessions[0];
    const bars = GF.decodeBars(b.bars).filter(x => tradingDayKey(new Date(Date.parse(x.t))) === day);
    const rthAt = bars.findIndex(x => minutesOfDay(new Date(Date.parse(x.t)), MARKET_TZ) === RTH_OPEN_MIN);
    const onHigh = Math.max(...bars.slice(0, rthAt).map(x => x.h));
    const rth = bars.slice(rthAt).filter(x => minutesOfDay(new Date(Date.parse(x.t)), MARKET_TZ) < RTH_CLOSE_MIN);
    const a = cfg.quietBars + cfg.approachBars;
    const reaction = rth.slice(a, a + cfg.reactionBars);
    const confirm = rth[a + cfg.reactionBars];
    const t = 0.25;
    assert.strictEqual(Math.min(...reaction.map(x => x.l)), onHigh - v.belowTicks * t, `${name}: the reaction candle's low`);
    assert.strictEqual(reaction.at(-1).c, onHigh + v.crossTicks * t, `${name}: its close over the level`);
    for (const x of reaction) assert.ok(x.h - x.c >= v.wickTicks * t, `${name} ${x.t}: no close at its top`);
    assert.deepStrictEqual([confirm.o, confirm.l, confirm.c, confirm.h], [reaction.at(-1).c, reaction.at(-1).c, reaction.at(-1).c + v.confirmTicks * t, reaction.at(-1).c + v.confirmTicks * t], `${name}: the confirming close`);
    for (const x of rth.slice(a + cfg.reactionBars + 1)) assert.ok(x.o === x.c && x.h === x.l, `${name} ${x.t}: flat after`);
    const approach = rth.slice(cfg.quietBars, a);
    assert.ok(Math.max(...approach.map(x => x.h)) < onHigh, `${name}: the approach stays under the level`);
    const low = Math.min(...approach.map(x => x.l));
    assert.strictEqual(low <= rth[0].o - v.depthTicks * t, true, `${name}: the V's depth`);
    // The cash open: gapped to openUnderTicks under the level (over the prior session's levels: the approach meets
    // none, so no break of it is composed on its own close), or where the overnight closed.
    const prior = GF.decodeBars(b.bars).filter(x => tradingDayKey(new Date(Date.parse(x.t))) < day && minutesOfDay(new Date(Date.parse(x.t)), MARKET_TZ) >= RTH_OPEN_MIN && minutesOfDay(new Date(Date.parse(x.t)), MARKET_TZ) < RTH_CLOSE_MIN);
    const priorDay = prior.filter(x => tradingDayKey(new Date(Date.parse(x.t))) === tradingDayKey(new Date(Date.parse(prior.at(-1).t))));
    if (v.openUnderTicks > 0) {
      assert.strictEqual(rth[0].o, Math.max(bars[rthAt - 1].c, onHigh - v.openUnderTicks * t), `${name}: the gapped open`);
      assert.ok(low > Math.max(...priorDay.map(x => x.h)), `${name}: the approach over the prior session's high`);
    } else assert.strictEqual(rth[0].o, bars[rthAt - 1].c, `${name}: the open where the overnight closed`);
  }
});
