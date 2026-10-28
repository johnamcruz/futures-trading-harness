'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { entryRuleErrors, entryRuleOf, entryProblems, trendOf, legReads } = require('../../scripts/lib/trading/entry-rule');
const { checkReads } = require('../../scripts/lib/trading/composed-reads');

const GONE = 'gone';
/** A briefing with only what the entry rule reads: the base regime and minutes, the 15m, 1h and 4h trends (GONE: left out). */
function briefing({ regime = 'range', t15 = 'range', t1h = 'range', t4h = 'range', minutes = 3 } = {}) {
  const frame = t => (t === GONE ? undefined : { trend: t });
  return {
    minutes,
    sections: {
      m3: { data: { price: 21500, ...(regime === GONE ? {} : { regime: regime === null ? null : { primary: regime } }) } },
      m15: { data: { frame: frame(t15) } },
      h1: { data: { h1: frame(t1h), h4: frame(t4h) } },
    },
  };
}
const OFF = { bias_frames: 'off', regime_against: 'off', leg_turned: 'off' };
const rule = over => entryRuleOf({ ...OFF, ...over });
/** A checked read as checkReads returns it: true, agreeing, pointing `dir`. */
const read = (form, kind, dir = 'long', extra = {}) => ({ form, kind, check: true, agrees: true, dir, ...extra });

test('entryRuleOf: null when every key is off or the block is missing; the keys read as the checker reads them', () => {
  assert.strictEqual(entryRuleOf(OFF), null);
  assert.strictEqual(entryRuleOf(null), null);
  assert.strictEqual(entryRuleOf(undefined), null);
  assert.deepStrictEqual({ ...rule({ bias_frames: ['4h', '1h'] }) }, { biasFrames: ['4h', '1h'], regimeAgainst: false, legTurned: false });
  assert.deepStrictEqual({ ...rule({ regime_against: 'on', leg_turned: 'on' }) }, { biasFrames: null, regimeAgainst: true, legTurned: true });
  // Only the word `on` turns a check on: anything else is no check here (the rulebook's validation refuses it first).
  assert.strictEqual(entryRuleOf({ ...OFF, regime_against: true }), null);
});

test('entryRuleErrors: every key stated, each on, off or (bias_frames) a list highest first', () => {
  assert.deepStrictEqual(entryRuleErrors(OFF, 'policies.p'), []);
  assert.deepStrictEqual(entryRuleErrors({ bias_frames: ['4h', '1h'], regime_against: 'on', leg_turned: 'off' }, 'policies.p'), []);
  assert.match(entryRuleErrors(undefined, 'policies.p').join(), /policies\.p\.entry: missing or not a map/);
  assert.match(entryRuleErrors([], 'policies.p').join(), /missing or not a map/);
  assert.match(entryRuleErrors({ regime_against: 'off', leg_turned: 'off' }, 'policies.p').join(), /entry\.bias_frames: missing/);
  assert.match(entryRuleErrors({ ...OFF, bias_frames: ['15m', '1h'] }, 'policies.p').join(), /highest first/);
  // The 15m never sets the side against the 1h: only 4h and/or 1h may be listed.
  for (const f of [['4h', '1h', '15m'], ['1h', '15m'], ['15m'], ['5m']]) assert.match(entryRuleErrors({ ...OFF, bias_frames: f }, 'policies.p').join(), /is not off or a list of 4h, 1h/, JSON.stringify(f));
  assert.match(entryRuleErrors({ ...OFF, leg_turned: 'yes' }, 'policies.p').join(), /leg_turned: "yes" is not on or off/);
});

test('no rule: no problem, whatever the briefing (every key off is the check as before)', () => {
  assert.deepStrictEqual(entryProblems({ briefing: briefing({ regime: 'trend-down', t1h: 'down' }), side: 'long', reads: [], rule: null }), []);
  assert.deepStrictEqual(entryProblems({ briefing: null, side: 'long', reads: [], rule: null }), []);
});

test('regime_against: with the side and range or transition stand; a trend against refuses; missing refuses', () => {
  const r = rule({ regime_against: 'on' });
  const at = (regime, side = 'long') => entryProblems({ briefing: briefing({ regime }), side, reads: [], rule: r });
  assert.deepStrictEqual(at('trend-up'), [], 'with');
  assert.deepStrictEqual(at('range'), [], 'range');
  assert.deepStrictEqual(at('transition'), [], 'transition');
  assert.match(at('trend-down').join(), /regime is trend-down, against the long/);
  assert.match(at('trend-up', 'short').join(), /regime is trend-up, against the short/);
  assert.deepStrictEqual(at('trend-down', 'short'), [], 'a short with a down trend');
  // Fails closed on missing data (the tightening direction).
  assert.match(at(null).join(), /base regime \(m3\.regime\) is not in the briefing: no entry/);
  assert.match(at(GONE).join(), /not in the briefing/);
  assert.match(entryProblems({ briefing: null, side: 'long', reads: [], rule: r }).join(), /not in the briefing/);
  assert.match(entryProblems({ briefing: briefing(), side: 'up', reads: [], rule: r }).join(), /needs the side/);
});

test('leg_turned: a regime not trending the side\'s way needs a true base break or compression break the side\'s way', () => {
  const r = rule({ leg_turned: 'on' });
  const at = (regime, reads, side = 'long', minutes = 3) => entryProblems({ briefing: briefing({ regime, minutes }), side, reads, rule: r });
  assert.deepStrictEqual(at('trend-up', []), [], 'trending its way: no leg needed');
  for (const regime of ['range', 'transition', 'trend-down']) {
    assert.match(at(regime, []).join(), new RegExp(`regime is ${regime}, not trending the long's way: state the leg turned back, a true "3m choch up", "3m bos up" or "3m compression break up"`), regime);
    assert.deepStrictEqual(at(regime, [read('3m choch up', 'break')]), [], `${regime}: a 3m CHoCH its way`);
    assert.deepStrictEqual(at(regime, [read('3m bos up', 'break')]), [], `${regime}: a 3m BOS its way`);
    assert.deepStrictEqual(at(regime, [read('3m compression break up', 'compression')]), [], `${regime}: a 3m expansion its way`);
  }
  // Only a TRUE, agreeing base read pointing the side: a higher frame, a false read, the other way or another kind never.
  for (const bad of [read('15m choch up', 'break'), read('3m choch up', 'break', 'long', { check: false }), read('3m choch up', 'break', 'long', { check: 'unchecked' }),
    read('3m choch down', 'break', 'short'), read('3m choch up', 'break', 'long', { agrees: false }), read('3m momentum up', 'momentum'), read('3m close top', 'close')]) {
    assert.match(at('range', [bad]).join(), /state the leg turned back/, JSON.stringify(bad));
  }
  assert.deepStrictEqual(at('range', [read('3m choch down', 'break', 'short')], 'short'), [], 'a short\'s leg turned down');
  // A 5m lane reads its own base frame.
  assert.deepStrictEqual(at('range', [read('5m bos up', 'break')], 'long', 5), []);
  assert.match(at('range', [read('3m bos up', 'break')], 'long', 5).join(), /"5m choch up"/);
  // Missing data refuses.
  assert.match(at(null, [read('3m choch up', 'break')]).join(), /not in the briefing/);
  assert.match(entryProblems({ briefing: { ...briefing({ regime: 'range' }), minutes: undefined }, side: 'long', reads: [read('3m choch up', 'break')], rule: r }).join(), /base timeframe is unknown/);
  // With regime_against on too, a trend against refuses whatever the leg says (one problem, the regime's).
  const both = entryProblems({ briefing: briefing({ regime: 'trend-down' }), side: 'long', reads: [read('3m choch up', 'break')], rule: rule({ regime_against: 'on', leg_turned: 'on' }) });
  assert.strictEqual(both.length, 1);
  assert.match(both[0], /against the long/);
});

test('bias_frames: the first listed frame that trends sets the side; no listed frame against it; none trending: no entry', () => {
  const r = rule({ bias_frames: ['4h', '1h'] });
  const at = (trends, side = 'long') => entryProblems({ briefing: briefing(trends), side, reads: [], rule: r });
  assert.deepStrictEqual(at({ t4h: 'up', t1h: 'up' }), [], '4h and 1h up');
  assert.deepStrictEqual(at({ t4h: 'range', t1h: 'up' }), [], 'the 1h sets it when the 4h ranges');
  assert.deepStrictEqual(at({ t4h: 'up', t1h: 'range' }), [], 'the 4h sets it');
  assert.match(at({ t4h: 'down', t1h: 'down' }).join(), /4h and 1h trends are down, against the long/);
  // The 15m never stands in against a listed frame (timeframe shopping).
  assert.match(at({ t4h: 'range', t1h: 'down', t15: 'up' }).join(), /the 1h trend is down, against the long: the bias frames \(4h, 1h\) set the side, never a lower frame/);
  // A 4h up with the 1h against: an unfinished pullback on the 1h, refused.
  assert.match(at({ t4h: 'up', t1h: 'down' }).join(), /the 1h trend is down/);
  assert.match(at({ t4h: 'range', t1h: 'range', t15: 'up' }).join(), /no higher-timeframe bias \(4h range, 1h range\): sit out/);
  assert.deepStrictEqual(at({ t4h: 'down', t1h: 'range' }, 'short'), []);
  // A trend the briefing doesn't hold refuses (unknown is never read as range).
  assert.match(at({ t4h: GONE, t1h: 'up' }).join(), /the 4h trend is not in the briefing/);
  assert.match(at({ t4h: 'unknown', t1h: 'up' }).join(), /the 4h trend is not in the briefing/);
  // [1h] alone: the 1h must trend the side's way.
  assert.deepStrictEqual(entryProblems({ briefing: briefing({ t1h: 'up', t4h: 'down' }), side: 'long', reads: [], rule: rule({ bias_frames: ['1h'] }) }), []);
  assert.strictEqual(trendOf(briefing({ t15: 'up' }), '15m'), 'up');
  assert.strictEqual(trendOf(briefing(), '2h'), null);
});

test('legReads: the base reads that turn the leg, from checked reads', () => {
  const rows = [read('3m choch up', 'break'), read('15m choch up', 'break'), read('3m compression break up', 'compression'), null, 'x'];
  assert.deepStrictEqual(legReads(rows, '3m', 'long').map(r => r.form), ['3m choch up', '3m compression break up']);
  assert.deepStrictEqual(legReads(null, '3m', 'long'), []);
});

test('checkReads holds the entry rule: its problems refuse the combination; none without a rule', () => {
  const b = briefing({ regime: 'trend-down', t1h: 'down' });
  const base = checkReads({ reads: [], side: 'long', briefing: b });
  assert.ok(!base.problems.some(x => /^entry rule/.test(x)), 'no rule: nothing more');
  const ruled = checkReads({ reads: [], side: 'long', briefing: b, entryRule: rule({ regime_against: 'on', bias_frames: ['1h'] }) });
  assert.deepStrictEqual(ruled.problems.filter(x => /^entry rule/.test(x)).length, 2);
  assert.strictEqual(ruled.ok, false);
});
