'use strict';

/**
 * The compression setup end to end on real bars (the parity fixture, briefing.js as the runner builds it): the
 * briefing's code-verified compression -> expansion facts; the real compose_check (harness-tools/compose.js) on a plan
 * whose setup is the compression break, its stop beyond the box's far side and its entry a later closed candle (OK);
 * the same plan with its entry on the expansion candle itself (refused); runway (a with-trend box whose far-side stop
 * leaves no named level at 2R: refused); and the gate's trend rule refusing a counter-HTF compression plan whose
 * reads all verify (mtf-state.js checkTrend, with no verified CHoCH tier: lifecycle-gate.js reversalAllowed). On these
 * bars no with-trend compression break has a box-far-side stop with runway, so the passing plan is the counter-HTF one,
 * which compose_check (reads and plan) passes and only the trend rule refuses.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildBriefing, writeBriefing } = require('../../scripts/lib/trading/briefing');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { composeCheck } = require('../../scripts/lib/harness-tools/compose');
const { checkReads } = require('../../scripts/lib/trading/composed-reads');
const { buildRecord, writeRecord, checkTrend } = require('../../scripts/lib/trading/mtf-state');
const { reversalAllowed } = require('../../scripts/lib/trading/lifecycle-gate');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'));
const briefingAt = n => buildBriefing({ symbol: 'MNQ', bars: BARS.slice(0, n), minutes: 3, scan: [] });

/** The real compose_check on the bar the first n bars end on: its briefing written to a run home, the cycle bar set. */
function compose(n, side, reads) {
  const home = tmpDir();
  const b = briefingAt(n);
  writeBriefing(home, b);
  const env = { FTH_HOME: home, FTH_CYCLE_BARS: JSON.stringify({ MNQ: b.asOf }) };
  const now = new Date(Date.parse(b.closedAt) + 5000);
  return { home, b, now, text: composeCheck({ symbol: 'MNQ', side, reads, size: 1 }, { env, now: () => now, replayAt: () => null }).text };
}
const r = (step, skill, read) => ({ step, skill, read });

// 04:57 UTC on 04-27: a 3m expansion candle closed below a 10-candle box (27522.25-27540) while the 1h trend is up; the
// 04:57 bar (closed 05:00) is the next closed candle; the stop beyond the box's high. Only a 3m CHoCH down for bias (no
// D2 tier: a 1h CHoCH the trade's way is needed against a 1h trend).
const SHORT = [r('bias', 'bos-vs-choch', '3m choch down'), r('location', 'levels-and-reactions', 'at 15m swing low 27512.75'), r('setup', 'compression', '3m compression break down'),
  r('entry', 'candle-reading', '15m close bottom'), r('stop', 'invalidation', 'stop 3m box high 27540'), r('target', 'take-profit', 'target session vah 27467.57')];
// 00:03 UTC on 04-27 (20:03 ET): a 3m expansion candle closed above a 30-candle box (27363.75-27399.75), the 1h trend
// up; the 00:03 bar (closed 00:06) is the next closed candle, top third; the stop beyond the box's low.
const BOX_LOW = 27363.75;
const LONG = [r('bias', 'multi-timeframe-analysis', '1h up'), r('location', 'levels-and-reactions', 'at session vah'), r('setup', 'compression', '3m compression break up'),
  r('entry', 'candle-reading', '3m close top'), r('stop', 'invalidation', `stop 3m box low ${BOX_LOW}`), r('target', 'take-profit', 'target prior rth close 27434')];

test('compression e2e: the briefing holds the transition as code-verified facts, on completed candles', () => {
  const b = briefingAt(956);
  const at = b.sections.m3.data.compression['3m'];
  assert.strictEqual(at.state, 'expanding');
  assert.deepStrictEqual([at.box.low, at.box.high, at.box.bars, at.break.dir, at.break.closedAt, at.break.expansion, at.break.beyondNow, at.break.barsAgo], [BOX_LOW, 27399.75, 30, 'up', '2026-04-27T00:03:00.000Z', true, true, 1]);
  // The box's levels: those that stood when it began and still stand at the same value (one value per level in the
  // briefing). Here the session profile moved since the box began (its own volume built it): none of it is the box's.
  assert.ok(!at.box.levels.some(l => /^session (POC|VAH|VAL)$/.test(l.name)), JSON.stringify(at.box.levels));
  // Over the series, every session level a box names has the briefing's current value for that name (keyLevels).
  let named = 0;
  for (let n = 600; n <= 1400; n += 20) {
    const bn = briefingAt(n);
    const now = new Map(bn.keyLevels.map(([name, p]) => [name, p]));
    for (const x of Object.values(bn.sections.m3.data.compression)) {
      for (const l of (x && x.box ? x.box.levels : []).filter(y => now.has(y.name))) {
        named += 1;
        assert.ok(Math.abs(now.get(l.name) - l.price) <= 0.25, `${n} ${l.name}: ${l.price} vs ${now.get(l.name)}`);
      }
    }
  }
  assert.ok(named > 0, 'the check is not vacuous');
  // The bar before the expansion candle closed was compressing: the transition is a change on one closed candle.
  assert.strictEqual(briefingAt(954).sections.m3.data.compression['3m'].state, 'compressing');
  // A poke: 04-24 07:03 UTC closed 2 ticks above its box (0.06 ATR): no expansion, and the read is FALSE.
  const poke = briefingAt(636).sections.m3.data.compression['3m'];
  assert.deepStrictEqual([poke.break.expansion, poke.break.beyondAtr, poke.state], [false, 0.06, 'neither']);
});

test('compression e2e: a box\'s key levels are the session\'s and higher timeframes\' levels, never its own or a lower timeframe\'s swings', () => {
  const MIN = { '3m': 3, '5m': 5, '15m': 15, '1h': 60 };
  let higher = 0;
  for (let n = 600; n <= 1400; n += 40) {
    for (const [tf, x] of Object.entries(briefingAt(n).sections.m3.data.compression)) {
      if (!x || typeof x !== 'object' || !x.box) continue;
      for (const l of x.box.levels) {
        assert.doesNotMatch(l.name, /^last |^equal (highs|lows)$|^(day|session) (high|low)$/, `${n} ${tf}: ${l.name}`);
        const k = /^(?:untested )?(\d+)(m|h) swing\b/.exec(l.name);
        if (k) {
          assert.ok(Number(k[1]) * (k[2] === 'h' ? 60 : 1) > MIN[tf], `${n} ${tf}: ${l.name}`);
          higher += 1;
        }
      }
    }
  }
  assert.ok(higher > 0, 'a higher timeframe\'s swing is named somewhere (the check is not vacuous)');
});

test('compression e2e: a plan whose setup is the compression break, its stop beyond the box and its entry a later closed candle, passes compose_check', () => {
  const { text } = compose(1054, 'short', SHORT);
  assert.match(text, /TRUE setup \(compression\): "3m compression break down"/, text);
  assert.match(text, /TRUE stop \(invalidation\): "stop 3m box high 27540"/, text);
  assert.match(text, /\bOK\b/, text);
  assert.doesNotMatch(text, /PROBLEM|NOT OK/, text);
});

test('compression e2e: runway: with the trend, the stop beyond the box\'s far side leaves no named level at 2R, so the plan is refused', () => {
  const { text } = compose(956, 'long', LONG);
  assert.match(text, /TRUE setup \(compression\): "3m compression break up"/, text);
  assert.match(text, /TRUE stop \(invalidation\): "stop 3m box low 27363.75"/, text);
  assert.match(text, /NOT OK/, text);
  assert.match(text, /R:R .* under the strategy's min/, text);
});

test('compression e2e: the same plan with its entry on the expansion candle itself is refused (the confirmation is the next close)', () => {
  // On the 00:00 bar (closed 00:03) the expansion candle is the base's last completed one: its own close is no entry.
  const { text } = compose(955, 'long', LONG);
  assert.match(text, /TRUE setup \(compression\): "3m compression break up"/, text);
  assert.match(text, /NOT OK/, text);
  assert.match(text, /closed after the setup's/);
});

test('compression e2e: a compression break against the HTF trend: every read verifies, and the gate\'s trend rule refuses it', () => {
  const { home, b, now } = compose(1054, 'short', SHORT);
  const check = checkReads({ reads: SHORT, side: 'short', briefing: b });
  assert.strictEqual(check.ok, true, check.problems.join('; '));
  writeRecord(home, buildRecord(BARS.slice(0, 1054), { symbol: 'MNQ', now }));
  assert.match(String(checkTrend(home, { root: 'MNQ', side: 'sell', style: 'trend', strategy: 'trade_lifecycle', now })), /against the prevailing 1h up trend/);
  const rev = reversalAllowed({ home, root: 'MNQ', side: 'short', check, now });
  assert.strictEqual(rev.ok, false);
  assert.match(rev.why, /a verified 1h CHoCH/);
  // A long with the trend passes the same rule.
  const { home: h2, now: n2 } = compose(956, 'long', LONG);
  writeRecord(h2, buildRecord(BARS.slice(0, 956), { symbol: 'MNQ', now: n2 }));
  assert.strictEqual(checkTrend(h2, { root: 'MNQ', side: 'buy', style: 'trend', strategy: 'trade_lifecycle', now: n2 }), null);
});
