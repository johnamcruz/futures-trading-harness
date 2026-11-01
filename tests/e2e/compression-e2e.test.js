'use strict';

/**
 * The compression setup end to end on real bars (the parity fixture, briefing.js as the runner builds it): the
 * briefing's code-verified compression -> expansion facts (an NR7 or inside-bar box); the real compose_check
 * (harness-tools/compose.js) on a with-trend plan whose setup is the compression break, its stop beyond the box's far
 * side and its entry a later closed candle (OK, and the gate's trend rule allows it); the same plan with its entry on the
 * expansion candle itself (refused); runway (a pennant whose box stop leaves no named level at 2R: refused); and a
 * counter-HTF compression break the gate's trend rule refuses (mtf-state.js checkTrend: never counter).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildBriefing, writeBriefing } = require('../../scripts/lib/trading/briefing');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { composeCheck } = require('../../scripts/lib/harness-tools/compose');
const { checkReads, checkRead, parseRead } = require('../../scripts/lib/trading/composed-reads');
const { buildRecord, writeRecord, checkTrend } = require('../../scripts/lib/trading/mtf-state');
const { tmpDir, recordBrokerSpecs } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'));
const briefingAt = n => buildBriefing({ symbol: 'MNQ', bars: BARS.slice(0, n), minutes: 3, scan: [] });

/** The real compose_check on the bar the first n bars end on: its briefing written to a run home, the cycle bar set. */
function compose(n, side, reads) {
  const home = tmpDir();
  recordBrokerSpecs(home); // the broker's tick specs: compose_check prices the stop with them only
  const b = briefingAt(n);
  writeBriefing(home, b);
  const env = { FTH_HOME: home, FTH_CYCLE_BARS: JSON.stringify({ MNQ: b.asOf }) };
  const now = new Date(Date.parse(b.closedAt) + 5000);
  return { home, b, now, text: composeCheck({ symbol: 'MNQ', side, reads, size: 1 }, { env, now: () => now, replayAt: () => null }).text };
}
const r = (step, skill, read) => ({ step, skill, read });

// 08:39 UTC on 04-27 (04:39 ET): a 3m expansion candle closed above an inside-bar box (its mother's range 27413-27422,
// on the prior POC), the 1h trend up; the 08:39 bar (closed 08:42) is the next closed candle, top third.
const LONG = [r('bias', 'multi-timeframe-analysis', '1h up'), r('location', 'vwap-volume-profile', 'vwap below'), r('setup', 'compression', '3m compression break up'),
  r('entry', 'candle-reading', '3m close top'), r('stop', 'invalidation', 'stop 3m box low 27413'), r('target', 'take-profit', 'target prior rth high 27462.5')];

test('compression e2e: the briefing holds the transition as code-verified facts, on completed candles', () => {
  const at = briefingAt(1128).sections.m3.data.compression['3m'];
  assert.strictEqual(at.state, 'expanding');
  assert.deepStrictEqual([at.box.flavor, at.box.insideStack, at.box.low, at.box.high, at.break.dir, at.break.closedAt, at.break.expansion, at.break.beyondNow, at.break.barsAgo],
    ['inside', 1, 27413, 27422, 'up', '2026-04-27T08:39:00.000Z', true, true, 1]);
  assert.ok(at.box.levels.some(l => l.name === 'prior POC' && l.edge === 'bottom'), JSON.stringify(at.box.levels));
  // Before the expansion candle closed, its mother's inside candle was the box (compressing).
  assert.strictEqual(briefingAt(1126).sections.m3.data.compression['3m'].state, 'compressing');
  // A flag's pole: a displacement up just before a 2-candle inside stack, the break its way (04-24 00:27 UTC).
  const flag = briefingAt(504).sections.m3.data.compression['3m'];
  assert.deepStrictEqual([flag.state, flag.box.insideStack, flag.box.pole && flag.box.pole.dir, flag.break.withPole], ['expanding', 2, 'up', true]);
  // Every session level a box names has the briefing's current value for that name (keyLevels): one value per level.
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
});

test('compression e2e: a box\'s key levels are the session\'s and higher timeframes\' levels, never its own or a lower timeframe\'s swings', () => {
  const MIN = { '3m': 3, '5m': 5, '15m': 15, '1h': 60 };
  let higher = 0;
  let named = 0;
  for (let n = 600; n <= 1400; n += 20) {
    for (const [tf, x] of Object.entries(briefingAt(n).sections.m3.data.compression)) {
      if (!x || typeof x !== 'object' || !x.box) continue;
      for (const l of x.box.levels) {
        named += 1;
        assert.doesNotMatch(l.name, /^last |^equal (highs|lows)$|^(day|session) (high|low)$/, `${n} ${tf}: ${l.name}`);
        const k = /^(?:untested )?(\d+)(m|h) swing\b/.exec(l.name);
        if (k) {
          assert.ok(Number(k[1]) * (k[2] === 'h' ? 60 : 1) > MIN[tf], `${n} ${tf}: ${l.name}`);
          higher += 1;
        }
      }
    }
  }
  assert.ok(higher + named > 0, 'levels are named somewhere (the check is not vacuous)');
});

test('compression e2e: a with-trend plan whose setup is the compression break, its stop beyond the box and its entry a later closed candle, passes compose_check and the trend rule', () => {
  const { home, now, text } = compose(1128, 'long', LONG);
  assert.match(text, /TRUE setup \(compression\): "3m compression break up"/, text);
  assert.match(text, /TRUE stop \(invalidation\): "stop 3m box low 27413"/, text);
  assert.match(text, /\bOK\b/, text);
  assert.doesNotMatch(text, /PROBLEM|NOT OK/, text);
  writeRecord(home, buildRecord(BARS.slice(0, 1128), { symbol: 'MNQ', now }));
  assert.strictEqual(checkTrend(home, { root: 'MNQ', side: 'buy', style: 'trend', strategy: 'trade_lifecycle', now }), null);
});

test('compression e2e: the same plan with its entry on the expansion candle itself verifies (the setup is the entry: no confirming close)', () => {
  // On the 08:36 bar (closed 08:39) the expansion candle is the base's last completed one: the CONF3M study made the
  // setup the entry, so its own close is no longer refused for want of a later one.
  const { text } = compose(1127, 'long', LONG);
  assert.match(text, /TRUE setup \(compression\): "3m compression break up"/, text);
  assert.match(text, /Every read is true and agrees with the long/, text);
  assert.doesNotMatch(text, /closed after the setup's/);
});

test('compression e2e: runway: a pennant whose box stop leaves no named level at 2R is refused', () => {
  // 04-24 00:27 UTC: the 2-candle inside stack after the pole; the stop beyond 27102.5, the 15m swing high 1.35R away.
  const reads = [r('bias', 'multi-timeframe-analysis', '15m up'), r('location', 'levels-and-reactions', 'at session high'), r('setup', 'compression', '3m compression break up'),
    r('entry', 'candle-reading', '3m close top'), r('stop', 'invalidation', 'stop 3m box low 27102.5'), r('target', 'take-profit', 'target 15m swing high 27155.75')];
  const { text } = compose(504, 'long', reads);
  assert.match(text, /TRUE stop \(invalidation\): "stop 3m box low 27102.5"/, text);
  assert.match(text, /NOT OK/, text);
  assert.match(text, /R:R .* under the strategy's min/, text);
});

test('compression e2e: a compression break against the HTF trend verifies, and the gate\'s trend rule refuses it', () => {
  // 04-28 01:51 UTC: a 3m expansion down out of an inside-bar box while the 4h trend is up.
  const b = briefingAt(1452);
  const read = checkRead(parseRead('3m compression break down'), b);
  assert.deepStrictEqual([read.check, read.dir], [true, 'short']);
  const reads = [r('bias', 'bos-vs-choch', '15m choch down'), r('setup', 'compression', '3m compression break down')];
  const check = checkReads({ reads, side: 'short', briefing: b });
  assert.ok(check.reads.every(x => x.check === true && x.agrees), JSON.stringify(check.reads.map(x => [x.read, x.check, x.fact])));
  const { home, now } = compose(1452, 'short', reads);
  writeRecord(home, buildRecord(BARS.slice(0, 1452), { symbol: 'MNQ', now }));
  assert.match(String(checkTrend(home, { root: 'MNQ', side: 'sell', style: 'trend', strategy: 'trade_lifecycle', now })), /against the 4h up trend/);
  // A reversal style is refused the same (never counter).
  assert.match(String(checkTrend(home, { root: 'MNQ', side: 'sell', style: 'reversal', strategy: 'trade_lifecycle', now })), /against the 4h up trend/);
});
