'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const GT = require('../../scripts/lib/eval/goal-trades');
const GC = require('../../scripts/lib/eval/goal-check');
const GF = require('../../scripts/lib/eval/goal-fixture');
const { chainSideSeries } = require('../../scripts/lib/trading/chain-side');
const { stopFloorTicks, planTargetOf, planOf } = require('../../scripts/lib/trading/trade-lifecycle');
const { checkReads } = require('../../scripts/lib/trading/composed-reads');
const { buildBriefing } = require('../../scripts/lib/trading/briefing');
const { historyBars } = require('../../scripts/lib/autotrader');
const { liveTarget, afterTargetStep, swingAtBar } = require('../../scripts/lib/trading/exit-trail');
const { limitOutcome } = require('../../scripts/lib/learning/experience-log');
const { SLIPPAGE_TICKS } = require('../../scripts/lib/replay/counterfactual');
const { scenario1, SCENARIO_1, SKILLS } = require('../fixtures/trade-lifecycle-scenario');

const ROOT = path.resolve(__dirname, '..', '..');
const P = GT.shippedOf(ROOT, {});
const DOC = GC.loadFixture(path.join(ROOT, 'tests', 'fixtures', 'goal', 'bars.json.gz'));

// Every fixture block's candidates, once (the blocks' bars decoded with them).
let BLOCKS = null;
const blocks = () => (BLOCKS = BLOCKS || DOC.blocks.map(b => {
  const bars = GF.decodeBars(b.bars);
  const r = GT.blockTrades(bars, b.sessions, P, { symbol: DOC.symbol });
  return { b, bars, candidates: r.candidates, refused: r.refused };
}));

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
  const structure = blocks().flatMap(x => x.candidates).filter(t => /^15m (CHoCH|BOS|compression break)$/.test(t.type));
  assert.ok(structure.length > 0 && structure.every(t => Date.parse(t.decidedAt) >= Date.parse(t.setupAt)));
  assert.ok(structure.some(t => t.decidedAt === t.setupAt), 'one entered at the setup bar\'s own close');
  // No session is traded outside the sessions given: the warm-up is read, never traded.
  assert.deepStrictEqual(GT.blockTrades(bars, [b.sessions[0]], P, { symbol: DOC.symbol }).trades.filter(t => t.day !== b.sessions[0]), []);
});

test('a composed trade arms its lock and trail at its plan\'s target, as live: the first named level at min_rr or more on the briefing at its decision bar (closed bars only), else the 2R mark', () => {
  const tick = 0.25;
  const lockGiveback = P.exit.plan.afterTarget.lockGivebackR;
  const sign = t => (t.side === 'long' ? 1 : -1);
  const mark = t => t.reference + sign(t) * P.minRR * t.stopTicks * tick;
  let beyond = 0;
  let lockedHigher = 0;
  for (const { b, bars, candidates, refused } of blocks()) {
    // Every composed setup that reaches its plan has one: none is dropped for want of a target.
    assert.strictEqual(refused['no plan'], undefined, `${b.sessions[0]}: a setup refused for no plan`);
    const ix = new Map(bars.map((x, i) => [x.t, i]));
    const composed = candidates.filter(t => t.type !== 'momentum_continuation');
    assert.ok(composed.every(t => typeof t.targetRead === 'string' && Number.isFinite(t.target) && Number.isFinite(t.reference)));
    for (const t of composed) {
      const s = sign(t);
      if (t.targetRead === 'target 2r') { assert.strictEqual(t.target, mark(t), `${t.decidedAt}: the 2R mark`); continue; }
      // A named level: at the mark or past it (min_rr), the price the plan's own code names on the briefing built from the
      // bars up to the decision bar only (no later bar exists to read).
      assert.ok(s * (t.target - mark(t)) >= 0, `${t.decidedAt}: ${t.targetRead} at min_rr or more`);
      const j = ix.get(t.decidedAt);
      const briefing = buildBriefing({ symbol: DOC.symbol, bars: bars.slice(Math.max(0, j + 1 - historyBars(P.baseMinutes)), j + 1), minutes: P.baseMinutes, now: new Date(Date.parse(bars[j].t) + P.baseMinutes * 60000) });
      const stopLevel = t.reference - s * (t.stopTicks - P.stopRule.bufferTicks) * tick;
      const got = planTargetOf({ briefing, side: t.side, stopLevel, tick, minRR: P.minRR, stopRule: P.stopRule });
      assert.deepStrictEqual([got.read, got.target.price], [t.targetRead, t.target], `${t.decidedAt}: the plan's target`);
      if (s * (t.target - mark(t)) > 0) beyond += 1;
      // Reached (a held bar's extreme at the target, from the fill): armed there, so it leaves no lower than its lock (the
      // named target's R less lockGivebackR) less the stop's slippage (R on 4 decimals); never the 2R mark's lock.
      const targetR = Math.abs(t.target - t.reference) / (t.stopTicks * tick);
      if (t.mfeR >= targetR && t.reason === 'trail') {
        assert.ok(t.R >= targetR - lockGiveback - SLIPPAGE_TICKS / t.stopTicks - 1e-4, `${t.decidedAt}: R ${t.R} under the lock of ${t.targetRead} (${targetR}R)`);
        if (targetR > P.minRR) lockedHigher += 1;
      }
    }
  }
  assert.ok(beyond > 0, 'a named target beyond the 2R mark in the fixture');
  assert.ok(lockedHigher > 0, 'one reached and locked above the 2R mark\'s lock');
});

test('arming parity: tier 1 arms where live arms for the same plan (scenario 1: the gate\'s stamp of the plan\'s target through liveTarget and afterTargetStep, against the simulation\'s exit)', () => {
  const tick = 0.25;
  const briefing = scenario1();
  const checked = checkReads({ reads: SCENARIO_1, side: 'long', briefing, skills: SKILLS });
  const { plan } = planOf({ checked, briefing, side: 'long', size: 1, tick, tickValue: 0.5, minRR: P.minRR, maxRiskUsd: 150, stopRule: P.stopRule });
  // Live: the gate stamps plan.target.price (rec.composed.target); the runner arms the trail at liveTarget's price.
  const live = liveTarget({ rec: { composed: { target: plan.target.price } }, entry: plan.entry.price, sign: 1, tick, orders: [], contractId: 'X' }).price;
  // Tier 1: the plan's target by compose's rule from the stop read alone.
  const tier1 = planTargetOf({ briefing, side: 'long', stopLevel: checked.stop.level, tick, minRR: P.minRR, stopRule: P.stopRule }).target.price;
  assert.deepStrictEqual([live, tier1], [21598, 21598]);
  // The bars after the decision (3m, its close 21540.25): the limit fills on the next bar; then a high `peak`, then a drop
  // through the stop. Live: the runner's per-bar rule (afterTargetStep from the fill with the stamped target; a stop
  // already breached in the bar closes at its close), its stop level compared, not a broker's fill; tier 1: limitOutcome.
  const at = ms => new Date(ms).toISOString();
  const t0 = Date.parse(briefing.closedAt);
  const path = peak => [
    { o: 21541, h: 21545, l: 21540, c: 21544 }, { o: 21544, h: peak, l: 21580, c: 21590 }, { o: 21589, h: 21590, l: 21500, c: 21505 },
  ].map((b, i) => ({ ...b, v: 1, t: at(t0 + i * 180000), ms: t0 + i * 180000 }));
  const plan1 = P.exit.plan;
  const liveExit = bars => {
    const risk = plan.entry.price - plan.stop.price;
    let t = { sign: 1, entry: plan.entry.price, risk, stop: plan.stop.price, peakR: 0, armed: false, target: live };
    for (const b of bars.slice(1)) {
      if (b.l <= t.stop) return { reason: t.stop === plan.stop.price ? 'stop' : 'trail', stop: t.stop, armed: t.armed };
      const step = afterTargetStep(t, b, plan1, tick, swingAtBar(bars, b, plan1.afterTarget.swingMinutes, 1));
      if (step.close) return { reason: 'trail', close: step.close.price, armed: step.armed };
      t = { ...t, ...step };
    }
    return null;
  };
  const tier1Exit = (bars, target) => limitOutcome({ bars, tfMs: 180000, side: 'long', entry: plan.entry.price, stop: plan.stop.price, target, fromMs: t0, expiresMs: t0 + P.validBars * 180000, tick, plan: plan1 });
  // A peak a tick short of the named target (past the 2R mark 21595.75): live never arms, and tier 1 neither (stopped
  // out); armed at the 2R mark instead, tier 1 would have trailed out in profit.
  const short = path(21597.75);
  assert.deepStrictEqual([liveExit(short).reason, tier1Exit(short, tier1).exitReason], ['stop', 'stop']);
  assert.strictEqual(tier1Exit(short, tier1).exitPrice, liveExit(short).stop - SLIPPAGE_TICKS * tick, 'the original stop, the simulation\'s slippage beyond it');
  assert.strictEqual(tier1Exit(short, 21595.75).exitReason, 'trail');
  // The peak at the named target: both arm, and both trail out at the same stop (the lock or trail the arming set).
  const reached = path(21598);
  const l = liveExit(reached);
  const s = tier1Exit(reached, tier1);
  assert.deepStrictEqual([l.reason, l.armed, s.exitReason], ['trail', true, 'trail']);
  assert.ok(Number.isFinite(l.stop) && l.stop > plan.entry.price, 'live armed: its stop past the entry');
  assert.strictEqual(s.exitPrice, l.stop - SLIPPAGE_TICKS * tick, 'the same stop, the simulation\'s slippage beyond it');
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
