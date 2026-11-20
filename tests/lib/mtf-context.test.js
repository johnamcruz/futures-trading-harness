'use strict';

// P1 (feat/p1-mtf-entries): the MTF candidate's CONTEXT facts (scripts/lib/trading/mtf-context.js): the parent impulse's
// quality (ATR, bars, displacement candles, cleanness), the turn's age in sessions, and the texts. Facts only.

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../scripts/lib/trading/mtf-context');

test('impulseQuality: long and short math (net move in ATR, bars, displacement candles, cleanness); not measurable: null', () => {
  // A long impulse from 100 to 112 over 4 candles, ranges 3 + 4 + 5 + 4 = 16: cleanness 12 / 16 = 0.75; ATR 5 at the last: 2.4.
  const cs = [{ h: 103, l: 100 }, { h: 106, l: 102 }, { h: 111, l: 106 }, { h: 112, l: 108 }];
  const q = C.impulseQuality({ candles: cs, from: 0, to: 3, start: 100, extreme: 112, dir: 1, atr: [5, 5, 5, 5], displaced: i => i === 2 });
  assert.deepEqual(q, { atr: 2.4, bars: 4, displaced: 1, cleanness: 0.75 });
  // The short mirror: from 200 down to 188.
  const sh = cs.map(c => ({ h: 300 - c.l, l: 300 - c.h }));
  assert.deepEqual(C.impulseQuality({ candles: sh, from: 0, to: 3, start: 200, extreme: 188, dir: -1, atr: [5, 5, 5, 5], displaced: () => false }), { atr: 2.4, bars: 4, displaced: 0, cleanness: 0.75 });
  // Only the candles from..to (never a later one): the extreme's candle bounds it.
  assert.deepEqual(C.impulseQuality({ candles: cs, from: 0, to: 2, start: 100, extreme: 111, dir: 1, atr: [5, 5, 4, 9], displaced: () => true }), { atr: 2.75, bars: 3, displaced: 3, cleanness: 0.92 });
  for (const bad of [{ to: 9 }, { from: 2, to: 1 }, { extreme: 100 }, { dir: 0 }, { start: NaN }]) {
    assert.equal(C.impulseQuality({ candles: cs, from: 0, to: 3, start: 100, extreme: 112, dir: 1, atr: [5, 5, 5, 5], displaced: () => false, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(C.impulseQuality({ candles: cs, from: 0, to: 3, start: 100, extreme: 112, dir: 1, atr: [], displaced: () => false }).atr, null);
});

test('the texts: a fresh turn (CHoCH then BOS, the BOS count), a CHoCH not yet confirmed, no turn; the impulse, its cut drops cleanness first', () => {
  assert.equal(C.turnText({ way: 'up', choch: { et: '10:15' }, bos: { et: '10:42' }, bosCount: 1 }, '1h', { sessionsAgo: 0 }), '1h turn (this session): 1h CHoCH up 10:15, BOS up 10:42; 1 BOS since the turn');
  assert.equal(C.turnText({ way: 'down', choch: { et: '09:00' }, bos: null, bosCount: 0 }, '15m', { sessionsAgo: 1 }), '15m turn (the previous session): 15m CHoCH down 09:00, no BOS down yet; 0 BOS since the turn');
  // older than the previous session, or its age unknown: a turn, not fresh, its age said.
  assert.equal(C.turnText({ way: 'up', choch: { et: '11-10 09:00' }, bos: { et: '11-10 11:00' }, bosCount: 2 }, '1h', { sessionsAgo: 3 }), '1h turn 3 sessions ago (older): 1h CHoCH up 11-10 09:00, BOS up 11-10 11:00; 2 BOS since the turn');
  assert.equal(C.turnText({ way: 'up', choch: { et: '10:15' }, bos: null, bosCount: 0 }, '1h'), '1h turn of unknown age (older): 1h CHoCH up 10:15, no BOS up yet; 0 BOS since the turn');
  assert.equal(C.isFresh({ choch: {} }, 1), true);
  assert.equal(C.isFresh({ choch: {} }, 2), false);
  assert.equal(C.isFresh({ choch: null }, 0), false);
  assert.equal(C.isFresh({ choch: {} }, null), false);
  // Sessions between two times: trading days (the 18:00 ET rollover), weekends not counted.
  assert.equal(C.sessionsBetween('2026-10-07T13:00:00Z', '2026-10-07T15:00:00Z'), 0);
  assert.equal(C.sessionsBetween('2026-10-06T15:00:00Z', '2026-10-07T15:00:00Z'), 1);
  assert.equal(C.sessionsBetween('2026-10-02T15:00:00Z', '2026-10-05T15:00:00Z'), 1, 'Friday to Monday: one session back');
  assert.equal(C.sessionsBetween('2026-10-01T15:00:00Z', '2026-10-05T15:00:00Z'), 2);
  assert.equal(C.sessionsBetween('x', '2026-10-05T15:00:00Z'), null);
  assert.equal(C.turnText({ way: 'up', choch: null, since: { et: '11-17 14:00' }, bosCount: 3 }, '1h'), 'no turn: trend since 11-17 14:00, 3 BOS');
  assert.equal(C.turnText(null, '1h'), null);
  const q = { atr: 2.4, bars: 9, displaced: 2, cleanness: 0.78 };
  assert.equal(C.impulseText(q), 'impulse 2.4 ATR in 9 bars, 2 displacement candles, cleanness 0.78');
  assert.equal(C.impulseText(q, { cut: 1 }), 'impulse 2.4 ATR in 9 bars, 2 displacement candles');
  assert.equal(C.impulseText({ ...q, displaced: 1 }), 'impulse 2.4 ATR in 9 bars, 1 displacement candle, cleanness 0.78');
  assert.equal(C.impulseText(null), 'impulse not measured');
});
