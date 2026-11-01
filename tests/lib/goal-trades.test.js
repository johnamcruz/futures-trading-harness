'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const GT = require('../../scripts/lib/eval/goal-trades');
const GC = require('../../scripts/lib/eval/goal-check');
const GF = require('../../scripts/lib/eval/goal-fixture');
const { chainSideSeries } = require('../../scripts/lib/trading/chain-side');
const { stopFloorTicks } = require('../../scripts/lib/trading/trade-lifecycle');

const ROOT = path.resolve(__dirname, '..', '..');
const P = GT.shippedOf(ROOT, {});
const DOC = GC.loadFixture(path.join(ROOT, 'tests', 'fixtures', 'goal', 'bars.json.gz'));

test('shippedOf: the policy that trades trade_lifecycle, its rulebook entry rule and exit, the strategy\'s stop rule and window, the cited setups', () => {
  assert.strictEqual(P.policy.name, 'prop_portfolio');
  assert.ok(P.entryRule.biasNeutral && P.entryRule.chain.setup === '15m' && P.entryRule.chain.entry === '3m');
  assert.deepStrictEqual([P.setupMinutes, P.baseMinutes], [15, 3]);
  assert.strictEqual(P.exit.mode, 'target_then_trail');
  assert.ok(P.exit.plan.afterTarget && P.exit.plan.afterTarget.lockGivebackR > 0);
  assert.deepStrictEqual([P.stopRule.bufferTicks, P.validBars, P.minRR], [P.life.risk.stop_buffer_ticks, P.life.valid_bars, P.life.risk.min_rr]);
  assert.deepStrictEqual(P.cited.map(s => s.name), ['momentum_continuation']);
});

test('oneAtATime: by entry time, a fill while one is open dropped', () => {
  const t = (type, entryTime, exitTime) => ({ type, entryTime, exitTime, setupAt: entryTime });
  const out = GT.oneAtATime([t('b', '2022-01-03T15:00:00Z', '2022-01-03T15:30:00Z'), t('a', '2022-01-03T14:00:00Z', '2022-01-03T15:10:00Z'), t('c', '2022-01-03T15:10:00Z', '2022-01-03T15:20:00Z')]);
  assert.deepStrictEqual(out.map(x => x.type), ['a', 'c']);
});

test('blockTrades on a fixture block: deterministic; every trade on the entry rule\'s side at its setup, its stop at or past D13\'s floor, one at a time, in the block\'s sessions', () => {
  const b = DOC.blocks.find(x => x.half === 'A');
  const bars = GF.decodeBars(b.bars);
  const r = GT.blockTrades(bars, b.sessions, P, { symbol: DOC.symbol });
  assert.deepStrictEqual(GT.blockTrades(bars, b.sessions, P, { symbol: DOC.symbol }), r);
  assert.ok(r.trades.length > 0 && r.setups >= r.trades.length);
  const side = chainSideSeries(bars, { rule: P.entryRule, minutes: P.baseMinutes });
  const ix = new Map(bars.map((x, i) => [x.t, i]));
  const ind = require('../../scripts/lib/trading/indicators');
  const atr20 = ind.atr(bars, ind.STOP_ATR_PERIOD);
  const snap = require('../../scripts/lib/tunables').analysis().snapshot.stopAtrMult;
  for (const t of r.trades) {
    assert.ok(b.sessions.includes(t.day), t.day);
    assert.strictEqual(side[ix.get(t.setupAt)], t.side === 'long' ? 1 : -1, `${t.setupAt}: the BG side`);
    const j = ix.get(t.decidedAt);
    const floor = stopFloorTicks({ sections: { m3: { data: { referenceStop: { distance: Math.round(snap * atr20[j] * 1e4) / 1e4 } } } } }, 0.25, P.stopRule);
    assert.ok(t.stopTicks >= floor, `${t.decidedAt}: ${t.stopTicks} ticks, the floor ${floor}`);
    assert.ok(Number.isFinite(t.R) && t.mfeR >= 0 && t.maeR <= 0);
  }
  for (let i = 1; i < r.trades.length; i += 1) assert.ok(Date.parse(r.trades[i].entryTime) >= Date.parse(r.trades[i - 1].exitTime), 'one position at a time');
  // The candidates: every fill in entry order (the attempts decide the slot after sizing), the one-at-a-time list among them.
  assert.ok(r.candidates.length >= r.trades.length);
  for (let i = 1; i < r.candidates.length; i += 1) assert.ok(GT.entryOrder(r.candidates[i - 1], r.candidates[i]) <= 0, 'entry order');
  assert.deepStrictEqual(GT.oneAtATime(r.candidates), r.trades);
  // The setup is the entry (no confirming read): a 15m structure setup is entered from the bar its candle is known at,
  // its own close first.
  const structure = DOC.blocks.flatMap(x => GT.blockTrades(GF.decodeBars(x.bars), x.sessions, P, { symbol: DOC.symbol }).candidates).filter(t => /^15m (CHoCH|BOS|compression break)$/.test(t.type));
  assert.ok(structure.length > 0 && structure.every(t => Date.parse(t.decidedAt) >= Date.parse(t.setupAt)));
  assert.ok(structure.some(t => t.decidedAt === t.setupAt), 'one entered at the setup bar\'s own close');
  // No session is traded outside the sessions given: the warm-up is read, never traded.
  assert.deepStrictEqual(GT.blockTrades(bars, [b.sessions[0]], P, { symbol: DOC.symbol }).trades.filter(t => t.day !== b.sessions[0]), []);
});

test('the chain side reads the rule it is given: a stricter rule allows no more than the shipped one; a rule reading the regime is refused', () => {
  const b = DOC.blocks[0];
  const bars = GF.decodeBars(b.bars).slice(0, 8000);
  const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
  const shipped = chainSideSeries(bars, { rule: P.entryRule, minutes: 3 });
  const strict = chainSideSeries(bars, { rule: entryRuleOf({ ...P.policy.entry, bias_agree: 'on' }), minutes: 3 });
  assert.ok(strict.every((s, i) => s === 0 || s === shipped[i]));
  assert.ok(strict.filter(Boolean).length < shipped.filter(Boolean).length);
  assert.deepStrictEqual(chainSideSeries(bars), chainSideSeries(bars, { rule: entryRuleOf({ bias_frames: ['4h', '1h'], bias_agree: 'neutral-15m-declared', regime_against: 'off', leg_turned: 'off' }) }));
  assert.throws(() => chainSideSeries(bars, { rule: entryRuleOf({ ...P.policy.entry, regime_against: 'on' }) }), /needs the full briefing/);
  assert.throws(() => chainSideSeries(bars, { rule: entryRuleOf({ ...P.policy.entry, bias_frames: ['4h', '15m'] }) }), /not read here/);
});
