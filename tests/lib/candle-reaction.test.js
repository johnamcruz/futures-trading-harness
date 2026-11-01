'use strict';

// The reaction read at a level (scripts/lib/trading/candle-reaction.js, the owner's classification 2026-10-31): each
// reaction, the priority (a candle matching two gets the higher), a close beyond beating its wick, a close exactly on
// the level, the mirror after a low, the two-candle confirmation, the 15m against the 1h, and missing data (unknown).

const test = require('node:test');
const assert = require('node:assert');
const R = require('../../scripts/lib/trading/candle-reaction');
const CF = require('../../scripts/lib/trading/candle-facts');

const k = (o, h, l, c) => ({ o, h, l, c });
const L = 100;
/** The reaction of c at L after prev (patterns from candle-facts, as the briefing reads them). */
const at = (c, prev, extra = {}) => R.reactionOf({ c, prev, level: L, patterns: CF.patternsOf(c, prev), ...extra });

test('the thresholds come from config/analysis.json reaction (wick >= 1 body and >= 1/3 range, a breakout body 0.7)', () => {
  const A = require('../../scripts/lib/tunables').analysis().reaction;
  assert.deepStrictEqual(R.DEF, { wickBody: A.wickBody, wickRange: A.wickRange, breakoutBody: A.breakoutBody });
  assert.deepStrictEqual([A.wickBody, A.wickRange, A.breakoutBody], [1, 0.3333, 0.7]);
  assert.deepStrictEqual({ ...A.conflict }, { 15: 60 });
  assert.deepStrictEqual(R.REACTIONS, ['confirmed rejection', 'breakout', 'engulfing rejection', 'long-wick rejection', 'conflicting', 'stall', 'plain', 'unknown']);
});

test('after a high: each reaction', () => {
  const up = k(97, 99, 96, 98); // a bullish candle below the level
  // Long wick: traded above 100, closed back below; the wick beyond the level 3 >= B 1 and >= R/3 (5.5 / 3). Its
  // bullish body would be conflicting, but the long wick ranks first.
  assert.strictEqual(at(k(98, 103, 97.5, 99), up), 'long-wick rejection');
  // The wick is measured beyond the level: the whole upper wick (2.9) qualifies (>= B 0.6, >= R/3 1.33), but the part
  // above 100 (0.5) is under a third of the range: no long-wick rejection (its bullish body: conflicting).
  const shallow = k(97, 100.5, 96.5, 97.6);
  assert.ok(shallow.h - Math.max(shallow.o, shallow.c) >= (shallow.h - shallow.l) / 3, 'the whole wick would qualify');
  assert.strictEqual(at(shallow, up), 'conflicting');
  assert.ok(!R.isLongWick(shallow, L, 'below'));
  // After a low the mirror: the lower wick below the level.
  assert.ok(!R.isLongWick(k(103, 103.2, 99.5, 102.7), L, 'above'), 'whole lower wick 3.2, below 100 only 0.5');
  // Engulfing: a bearish engulfing closing back below, the wick short (U 1.25 < B 1.75).
  assert.strictEqual(at(k(99.25, 100.5, 97, 97.5), k(98, 99.5, 97.5, 99)), 'engulfing rejection');
  // Breakout: closed above with a body 0.91 of the range.
  assert.strictEqual(at(k(98, 102.2, 97.8, 102), up), 'breakout');
  // Breakout by a bullish engulfing (body share 0.54 only).
  assert.strictEqual(at(k(97.25, 104, 97, 101), k(99, 99.5, 97, 97.5)), 'breakout');
  // Conflicting (i): closed back below with a bullish body, no long wick (U 1 < B 1.5).
  assert.strictEqual(at(k(98, 100.5, 97.9, 99.5), up), 'conflicting');
  // Stall: an inside candle that touched the level exactly (never traded through).
  assert.strictEqual(at(k(99, 100, 98.5, 99.5), k(98, 101, 97, 99)), 'stall');
  // Plain: traded through, closed back with a bearish body, no long wick, no engulfing.
  assert.strictEqual(at(k(99.8, 100.4, 98, 98.4), k(99, 99.5, 97, 98)), 'plain');
});

test('priority: a candle matching two reactions gets the higher one', () => {
  // A bearish engulfing with a long upper wick (U 3 >= B 2.5): engulfing ranks above the long wick.
  assert.strictEqual(at(k(99.5, 102.5, 96.5, 97), k(98, 99, 97.5, 99)), 'engulfing rejection');
  // A doji closing back below with a long wick: the long wick ranks above stall.
  assert.strictEqual(at(k(99, 102, 98.8, 99.05), k(97, 99, 96, 98)), 'long-wick rejection');
  // A doji closing just above: no decisive close (body 0.075 of the range): stall, never a breakout.
  assert.strictEqual(at(k(99.95, 101, 99, 100.1), k(97, 99.5, 96, 98)), 'stall');
});

test('close precedence: a close beyond beats its wick; a close exactly on the level is no breakout', () => {
  // A long upper wick (U 3) but the close above the level: never a rejection (body 0.46: no breakout either).
  const r = at(k(98, 104, 97.5, 101), k(97, 99, 96, 98));
  assert.ok(!/rejection/.test(r), r);
  assert.strictEqual(r, 'plain');
  // Closed exactly at 100: neither beyond nor back; a full body (2 / 3.5 = 0.57) is still no breakout.
  assert.strictEqual(at(k(98, 101, 97.5, 100), k(97, 99, 96, 98)), 'plain');
  // Exactly at it with a doji: stall.
  assert.strictEqual(at(k(99.9, 101, 99, 100), k(97, 99, 96, 98)), 'stall');
  // A body of 0.95 closing exactly at the level: no breakout.
  assert.strictEqual(at(k(96.1, 100.1, 96, 100), k(97, 99, 96, 98)), 'plain');
});

test('after a low: the mirror (bullish and bearish swap, the lower wick)', () => {
  const dn = k(103, 104, 101, 102); // a bearish candle above the level
  assert.strictEqual(at(k(102, 102.5, 97, 101), dn), 'long-wick rejection');
  assert.strictEqual(at(k(102, 102.2, 97.8, 98), dn), 'breakout');
  assert.strictEqual(at(k(100.75, 103, 99.5, 102.5), k(102, 102.5, 100.5, 101)), 'engulfing rejection');
  assert.strictEqual(at(k(102, 102.1, 99.5, 100.5), dn), 'conflicting', 'a bearish body closing back above');
  // The confirmation after a low: a long lower wick, then a bullish engulfing closing higher.
  const wick = k(102, 102.5, 97, 101);
  assert.strictEqual(R.reactionOf({ c: k(100.5, 105, 100.25, 104), prev: wick, level: L, patterns: ['bullish engulfing'], prevPrevClose: 103 }), 'confirmed rejection');
});

test('confirmed rejection: a long-wick rejection, then a bearish engulfing closing lower; on the second candle, met or not', () => {
  const wick = k(98, 103, 97.5, 99); // a long-wick rejection of 100 (bullish body)
  const next = k(99.5, 99.75, 95, 96); // a bearish engulfing below the level, closing lower
  assert.deepStrictEqual(CF.patternsOf(next, wick).slice(0, 1), ['bearish engulfing']);
  assert.strictEqual(R.reactionOf({ c: next, prev: wick, level: L, patterns: CF.patternsOf(next, wick), prevPrevClose: 97 }), 'confirmed rejection');
  // Meeting the level too: confirmed ranks above engulfing rejection.
  const met = k(99.5, 100.25, 95, 96);
  assert.strictEqual(R.reactionOf({ c: met, prev: wick, level: L, patterns: CF.patternsOf(met, wick), prevPrevClose: 97 }), 'confirmed rejection');
  // Not an engulfing (body too small): no confirmation; it didn't meet the level, so no reaction there.
  const small = k(98.9, 99.2, 98.5, 98.7);
  assert.strictEqual(R.reactionOf({ c: small, prev: wick, level: L, patterns: CF.patternsOf(small, wick), prevPrevClose: 97 }), null);
  // The first candle no long wick (U 0.5): no confirmation.
  const noWick = k(98, 100.5, 97.5, 100.25 - 0.5);
  assert.strictEqual(R.reactionOf({ c: next, prev: noWick, level: L, patterns: ['bearish engulfing'], prevPrevClose: 97 }), null);
  assert.ok(R.isLongWick(wick, L, 'below') && !R.isLongWick(noWick, L, 'below'));
});

test('the 15m against the 1h: a 15m rejection while the 1h closed decisively beyond is conflicting', () => {
  const c = k(99.8, 100.4, 98, 98.4); // bearish, closed back below, no long wick: plain on its own
  const prev = k(99, 99.5, 97, 98);
  assert.strictEqual(at(c, prev, { higher: { relation: 'broke', dir: 'up' } }), 'conflicting');
  assert.strictEqual(at(c, prev, { higher: { relation: 'broke', dir: 'down' } }), 'plain', 'the 1h broke the other way');
  assert.strictEqual(at(c, prev, { higher: { relation: 'rejected', dir: 'down' } }), 'plain');
  assert.strictEqual(at(c, prev, { higher: { relation: 'none', dir: null } }), 'plain');
  assert.strictEqual(at(c, prev, { higher: null }), 'unknown', 'the 1h unknown where it would decide: fail closed');
  // A long wick ranks above the conflict.
  assert.strictEqual(at(k(98, 103, 97.5, 98.5), prev, { higher: { relation: 'broke', dir: 'up' } }), 'long-wick rejection');
});

test('missing data: no label (unknown), never a guess', () => {
  const prev = k(97, 99, 96, 98);
  assert.strictEqual(at(k(98, NaN, 97, 99), prev), 'unknown');
  assert.strictEqual(R.reactionOf({ c: k(98, 103, 97.5, 99), prev, level: NaN }), null, 'no level, no reaction');
  assert.strictEqual(at(k(98, 103, 97.5, 99), null), 'unknown', 'no previous candle');
  // Opened on the level after a close on it: no side.
  assert.strictEqual(at(k(100, 101, 99, 99.5), k(99, 100.5, 98.5, 100)), 'unknown');
  // Away from the level and no confirmation: none.
  assert.strictEqual(at(k(95, 96, 94, 95.5), prev), null);
});

test('levelReactionsOf: each relation carries its reaction, the 15m reads the 1h\'s relation to the same level, a confirmed level the candle missed is listed', () => {
  const wick = k(98, 103, 97.5, 99);
  const c = k(99.5, 99.75, 95, 96);
  const found = [{ name: 'round number 96', price: 96, rel: 'touched', dir: null }];
  const out = { '1h': { relations: [] } };
  const r = CF.levelReactionsOf({ m: 15, c, prev: wick, pp: 97, patterns: CF.patternsOf(c, wick), found, prevAll: [['prior RTH high', 100], ['far', 500]] }, out);
  assert.deepStrictEqual(r.confirmed, [{ name: 'prior RTH high', price: 100, dir: 'down', text: 'prior RTH high 100' }]);
  assert.strictEqual(r.relations[0].reaction, r.reactions['round number 96']);
  // The 1h missing: a 15m rejection that the 1h would decide is unknown.
  const c2 = k(99.8, 100.4, 98, 98.4);
  const prev2 = k(99, 99.5, 97, 98);
  const one = [{ name: 'prior RTH high', price: 100, rel: 'rejected', dir: 'down' }];
  const of = o => CF.levelReactionsOf({ m: 15, c: c2, prev: prev2, pp: 97, patterns: CF.patternsOf(c2, prev2), found: one, prevAll: [] }, o).reactions['prior RTH high'];
  assert.strictEqual(of({ '1h': { unavailable: 'x' } }), 'unknown');
  assert.strictEqual(of({ '1h': { relations: [{ name: 'prior RTH high', rel: 'broke', dir: 'up' }] } }), 'conflicting');
  assert.strictEqual(of({ '1h': { relations: [] } }), 'plain');
  // A frame not checked against another (the 3m): the 1h is never read.
  assert.strictEqual(CF.levelReactionsOf({ m: 3, c: c2, prev: prev2, pp: 97, patterns: [], found: one, prevAll: [] }, {}).reactions['prior RTH high'], 'plain');
});

test('briefing candles: every level relation carries a reaction label', () => {
  const t0 = Date.parse('2026-06-15T13:30:00Z');
  const b = Array.from({ length: 60 }, (_, i) => { const p = 100 + (i % 7) - (i % 3); return { t: new Date(t0 + i * 180000).toISOString(), o: p, h: p + 1, l: p - 1, c: p + 0.5, v: 100 }; });
  const out = CF.briefingCandles({ bars: b, base: 3, levelsAt: () => [['prior RTH high', 101]] });
  let n = 0;
  for (const c of Object.values(out)) {
    if (c.unavailable) continue;
    for (const r of c.relations) { n += 1; assert.ok(R.REACTIONS.includes(r.reaction), JSON.stringify(r)); assert.strictEqual(c.reactions[r.name], r.reaction); }
  }
  assert.ok(n > 0);
});

test('a doji is never conflicting: its with-side body is noise, it stalls', () => {
  const doji = k(99.5, 100.4, 99, 99.51); // B 0.01 of R 1.4; the wick above 100 (0.4) under R/3: no long wick
  assert.ok(CF.patternsOf(doji, k(97, 99, 96, 98)).includes('doji'));
  assert.strictEqual(at(doji, k(97, 99, 96, 98)), 'stall');
  assert.strictEqual(at(doji, k(97, 99, 96, 98), { higher: { relation: 'broke', dir: 'up' } }), 'stall', 'nor by the 1h');
  assert.strictEqual(at(doji, k(97, 99, 96, 98), { higher: null }), 'stall', 'the 1h unknown never decides a doji');
});

test('confirmed: a relative level is said as the previous candle met it, with its price; deduplicated by price, never by name', () => {
  // 15m A (high 110), B a long-wick rejection of 110, C a bearish engulfing closing lower. For C, its own
  // `previous 15m high` is B's 113: the confirmed level is A's high, said as "the 15m high 110".
  const A = k(105, 110, 104, 107);
  const B = k(106.5, 113, 106, 108);
  const C = k(108.5, 109.5, 102.5, 103);
  assert.ok(R.isLongWick(B, 110, 'below'));
  const patterns = CF.patternsOf(C, B);
  const ownLevels = [{ name: 'previous 15m low', price: 106, rel: 'touched', dir: null }];
  const r = CF.levelReactionsOf({ m: 15, c: C, prev: B, pp: A.c, patterns, found: ownLevels, prevAll: [['previous 15m high', 110], ['previous 15m low', 104], ['prior RTH high', 110]] }, { '1h': { relations: [] } });
  assert.deepStrictEqual(r.confirmed, [{ name: 'previous 15m high', price: 110, dir: 'down', text: 'the 15m high 110' }], 'once: the prior RTH high at the same price is the same level');
  assert.strictEqual(CF.confirmedText('prior RTH high', 110), 'prior RTH high 110');
  // A name that already ends with its price (a swing, a round number) says it once.
  assert.strictEqual(CF.confirmedText('15m swing high 21000.25', 21000.25), '15m swing high 21000.25');
  assert.strictEqual(CF.confirmedText('round number 110', 110), 'round number 110');
  assert.strictEqual(CF.confirmedText('15m swing high 21000.25', 21000.5), '15m swing high 21000.25 21000.5', 'another price is said');
  const swing = CF.levelReactionsOf({ m: 15, c: C, prev: B, pp: A.c, patterns, found: [], prevAll: [['1h swing high 110', 110]] }, { '1h': { relations: [] } });
  assert.deepStrictEqual(swing.confirmed.map(x => x.text), ['1h swing high 110']);
  // A level this candle met at the same price, under another name: its own relation carries it, not `confirmed`.
  const met = CF.levelReactionsOf({ m: 15, c: C, prev: B, pp: A.c, patterns, found: [{ name: 'IB high', price: 110, rel: 'touched', dir: null }], prevAll: [['previous 15m high', 110]] }, { '1h': { relations: [] } });
  assert.strictEqual(met.confirmed, undefined);
  // The rendered line names it with its price.
  const B2 = require('../../scripts/lib/trading/briefing');
  const line = B2.candleLines({ candles: { '15m': { closedAt: '2026-06-15T14:00:00.000Z', pattern: 'bearish engulfing', closeLocation: 'bottom', rangeAtr: null, volRatio: null, sweep: null, levels: {}, reactions: {}, confirmed: r.confirmed } }, swingTargets: { above: [], below: [] } }, v => v)[0];
  assert.match(line, /confirmed rejection of the 15m high 110 \(short side\)/, 'a confirmed rejection closing lower: the short side');
  assert.ok(!/previous 15m high/.test(line), line);
  const swingLine = B2.candleLines({ candles: { '15m': { closedAt: '2026-06-15T14:00:00.000Z', pattern: 'bearish engulfing', closeLocation: 'bottom', rangeAtr: null, volRatio: null, sweep: null, levels: {}, reactions: {}, confirmed: swing.confirmed } }, swingTargets: { above: [], below: [] } }, v => v)[0];
  assert.match(swingLine, /confirmed rejection of 1h swing high 110 \(short side\)[.,]/);
  assert.ok(!/110 110/.test(swingLine), swingLine);
});

test('confirmed: every level is deduplicated by price, whatever its kind or order; a MOVING one (VWAP, the session profile) by its name too', () => {
  const A = k(105, 110, 104, 107);
  const B = k(106.5, 113, 106, 108);
  const C = k(108.5, 109.5, 102.5, 103);
  const patterns = CF.patternsOf(C, B);
  const of = (found, prevAll) => CF.levelReactionsOf({ m: 15, c: C, prev: B, pp: A.c, patterns, found, prevAll }, { '1h': { relations: [] } }).confirmed;
  assert.ok(CF.MOVING_LEVEL.test('VWAP (rth)') && CF.MOVING_LEVEL.test('VWAP (session)') && CF.MOVING_LEVEL.test('session POC') && !CF.MOVING_LEVEL.test('prior POC'));
  // The VWAP was 110 for B and is 104 for C, which met it: C's own relation carries it, not `confirmed`.
  assert.strictEqual(of([{ name: 'VWAP (rth)', price: 104, rel: 'touched', dir: null }], [['VWAP (rth)', 110]]), undefined);
  // C didn't meet the VWAP: listed with the price B met it at.
  assert.deepStrictEqual(of([], [['VWAP (rth)', 110]]).map(x => x.text), ['VWAP (rth) 110']);
  // A moving level at the price of one this candle met (another name): the same price, not listed.
  assert.strictEqual(of([{ name: 'session POC', price: 110, rel: 'touched', dir: null }], [['VWAP (rth)', 110]]), undefined);
  assert.strictEqual(of([{ name: 'VWAP (rth)', price: 110, rel: 'touched', dir: null }], [['prior RTH high', 110]]), undefined);
  // The previous candle's levels at one price are listed once, in either order, whatever their kinds.
  assert.deepStrictEqual(of([], [['prior RTH high', 110], ['VWAP (rth)', 110]]).map(x => x.text), ['prior RTH high 110']);
  assert.deepStrictEqual(of([], [['VWAP (rth)', 110], ['prior RTH high', 110]]).map(x => x.text), ['VWAP (rth) 110']);
  assert.strictEqual(of([], [['prior RTH high', 110], ['VWAP (rth)', 110]]).length, of([], [['VWAP (rth)', 110], ['prior RTH high', 110]]).length);
  // Two moving levels at one price: once.
  assert.deepStrictEqual(of([], [['VWAP (rth)', 110], ['session POC', 110]]).map(x => x.text), ['VWAP (rth) 110']);
  // A fixed level keeps the price rule: met by C under another name at that price, not listed; at another price, listed.
  assert.strictEqual(of([{ name: 'IB high', price: 110, rel: 'touched', dir: null }], [['prior RTH high', 110]]), undefined);
  assert.deepStrictEqual(of([{ name: 'prior RTH high', price: 104, rel: 'touched', dir: null }], [['prior RTH high', 110]]).map(x => x.text), ['prior RTH high 110']);
});

test('the rendered reaction: a touch closing beyond says so ("closed beyond: breakout"); a broke that is plain stays plain', () => {
  const B2 = require('../../scripts/lib/trading/briefing');
  const c = { closedAt: '2026-06-15T14:00:00.000Z', pattern: 'none', closeLocation: 'top', rangeAtr: null, volRatio: null, sweep: null,
    levels: { 'session POC': 'touched', 'VWAP (rth)': 'broke above', 'overnight high': 'rejected: closed back below' },
    reactions: { 'session POC': 'breakout', 'VWAP (rth)': 'plain', 'overnight high': 'long-wick rejection' } };
  const line = B2.candleLines({ candles: { '15m': c }, swingTargets: { above: [], below: [] } }, v => v)[0];
  assert.match(line, /touched session POC \(closed beyond: breakout\)/);
  assert.match(line, /broke above VWAP \(rth\) \(plain\)/);
  assert.match(line, /rejected overnight high \(closed back below; long-wick rejection, short side\)/);
});

test('the rendered rejection says its side, the candle\'s: back below short, back above long; a conflicting, stall or plain one none', () => {
  const B2 = require('../../scripts/lib/trading/briefing');
  const c = { closedAt: '2026-06-15T14:00:00.000Z', pattern: 'none', closeLocation: 'top', rangeAtr: null, volRatio: null, sweep: null,
    levels: { 'prior VAH': 'rejected: closed back below', 'prior VAL': 'rejected: closed back above', 'session POC': 'rejected: closed back below', 'IB high': 'rejected: closed back below', 'IB low': 'rejected: closed back above', 'VWAP (rth)': 'rejected: closed back below' },
    reactions: { 'prior VAH': 'engulfing rejection', 'prior VAL': 'long-wick rejection', 'session POC': 'conflicting', 'IB high': 'plain', 'IB low': 'stall', 'VWAP (rth)': 'confirmed rejection' } };
  const line = B2.candleLines({ candles: { '15m': c }, swingTargets: { above: [], below: [] } }, v => v)[0];
  assert.match(line, /rejected prior VAH \(closed back below; engulfing rejection, short side\)/);
  assert.match(line, /rejected prior VAL \(closed back above; long-wick rejection, long side\)/);
  assert.match(line, /rejected VWAP \(rth\) \(closed back below; confirmed rejection, short side\)/);
  assert.match(line, /rejected session POC \(closed back below; conflicting\)/, 'mixed: no side');
  assert.match(line, /rejected IB high \(closed back below; plain\)/, 'not a rejection: no side');
  assert.match(line, /rejected IB low \(closed back above; stall\)/, 'stalled: the next candle decides, no side');
  // The 4h (an event frame) keeps its own byte budget: no reaction, so no side.
  const h4 = B2.candleLines({ candles: { '4h': { ...c, closedAt: '2026-06-15T14:00:00.000Z' } }, swingTargets: { above: [], below: [] } }, v => v, undefined, '2026-06-15T14:00:00.000Z')[0];
  assert.ok(!/ side\)/.test(h4), h4);
});
