'use strict';

// compose_check's reaction echo (scripts/lib/trading/reaction-echo.js): next to each composed rejected, broke or swept
// read, the briefing's verified reaction with its side and who took control (or what conflicting, stall and plain mean);
// a MISMATCH when the read's own words name another; nothing for any other read kind.

const test = require('node:test');
const assert = require('node:assert');
const E = require('../../scripts/lib/trading/reaction-echo');
const { REACTIONS } = require('../../scripts/lib/trading/candle-reaction');

const briefing = (tf, relations, extra = {}) => ({ sections: { m3: { data: { candles: { [tf]: { relations } }, ...extra } } } });
const rel = (name, r, dir, reaction) => ({ name, price: 100, rel: r, dir, reaction });

test('each reaction class: its label and its meaning, the side the candle\'s (a rejection of a high the short side)', () => {
  const at = (r, dir, reaction) => E.echoLines([{ read: `15m ${r} prior vah ${dir}` }], briefing('15m', [rel('prior VAH', r, dir, reaction)]))[0];
  assert.strictEqual(at('rejected', 'down', 'long-wick rejection'), '- REACTION 15m rejected down prior VAH: long-wick rejection (short side: sellers rejected higher prices)');
  assert.strictEqual(at('rejected', 'up', 'long-wick rejection'), '- REACTION 15m rejected up prior VAH: long-wick rejection (long side: buyers rejected lower prices)');
  assert.strictEqual(at('rejected', 'down', 'engulfing rejection'), '- REACTION 15m rejected down prior VAH: engulfing rejection (short side: sellers took control)');
  assert.strictEqual(at('rejected', 'up', 'confirmed rejection'), '- REACTION 15m rejected up prior VAH: confirmed rejection (long side: buyers took over, confirmed)');
  assert.strictEqual(at('broke', 'up', 'breakout'), '- REACTION 15m broke up prior VAH: breakout (long side: buyers in control: a breakout attempt, not a sweep)');
  assert.strictEqual(at('broke', 'down', 'breakout'), '- REACTION 15m broke down prior VAH: breakout (short side: sellers in control: a breakout attempt, not a sweep)');
  assert.strictEqual(at('rejected', 'down', 'conflicting'), '- REACTION 15m rejected down prior VAH: conflicting (mixed: needs other confirmation (the count, or the next candle))');
  assert.strictEqual(at('rejected', 'down', 'stall'), '- REACTION 15m rejected down prior VAH: stall (stalled: the next candle decides)');
  assert.strictEqual(at('rejected', 'down', 'plain'), '- REACTION 15m rejected down prior VAH: plain (not a rejection: no one took control, weak context only; needs other confirmation)');
  assert.match(at('broke', 'up', undefined), /: unknown \(unknown: the briefing can't say/);
  for (const r of REACTIONS) assert.ok(E.MEANING[r], `${r}: a meaning`);
});

test('a sweep: the swept level\'s rejection on the setup frame first, its side; none for other read kinds or a missing candle', () => {
  const b = briefing('15m', [rel('prior RTH high', 'rejected', 'down', 'long-wick rejection')], { sweeps: [{ name: 'prior RTH high' }] });
  assert.deepStrictEqual(E.echoLines([{ read: 'swept prior rth high' }], b), ['- REACTION 15m rejected down prior RTH high: long-wick rejection (short side: sellers rejected higher prices)']);
  for (const read of ['15m cisd up', '3m close top', '15m touched prior vah', 'stop 15m low 99', '4h up']) assert.deepStrictEqual(E.echoLines([{ read }], b), [], read);
  // The read's candle doesn't hold the level: the reaction is unknown (never guessed).
  assert.match(E.echoLines([{ read: '1h rejected prior vah down' }], b)[0], /unknown/);
});

test('a MISMATCH when the read\'s own words name another reaction than the briefing\'s; none when they agree or name none', () => {
  const b = briefing('15m', [rel('prior VAH', 'rejected', 'down', 'plain')]);
  assert.deepStrictEqual(E.echoLines([{ read: '15m rejected prior vah down', why: 'a long-wick rejection of the VAH' }], b), [
    '- REACTION 15m rejected down prior VAH: plain (not a rejection: no one took control, weak context only; needs other confirmation)',
    '- MISMATCH: your read says long-wick rejection; the briefing\'s reaction is plain (a read, never a veto: read it with candle-reading)',
  ]);
  assert.strictEqual(E.echoLines([{ read: '15m rejected prior vah down', why: 'plain, weak' }], b).length, 1);
  assert.strictEqual(E.echoLines([{ read: '15m rejected prior vah down', why: 'the VAH held' }], b).length, 1);
});

test('a touch reading as a rejection: its side by the close against the level, as the briefing says it; none without a price', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const touch = (name, price, c, reaction) => ({ sections: { m3: { data: { candles: { '15m': { c, relations: [{ name, price, rel: 'touched', dir: null, reaction }] } } } } } });
  // A high touched exactly, the close below it: the short side, sellers (never the after-a-low meaning).
  assert.deepStrictEqual(E.echoLines([{ read: '15m rejected overnight high down' }], touch('overnight high', 100, 98, 'confirmed rejection')),
    ['- REACTION 15m touched overnight high: confirmed rejection (short side: sellers took over, confirmed)']);
  // The briefing's candle line for the same candle says the same side.
  const line = B.candleLines({ candles: { '15m': { closedAt: '2026-06-15T14:00:00.000Z', pattern: 'bearish engulfing', closeLocation: 'bottom', rangeAtr: null, volRatio: null, sweep: null, c: 98,
    levels: { 'overnight high': 'touched' }, reactions: { 'overnight high': 'confirmed rejection' }, relations: [{ name: 'overnight high', price: 100, rel: 'touched', dir: null }] } }, swingTargets: { above: [], below: [] } }, v => v)[0];
  assert.match(line, /touched overnight high \(confirmed rejection, short side\)/);
  // The mirror: a low touched, the close above it: the long side, buyers.
  assert.deepStrictEqual(E.echoLines([{ read: '15m rejected overnight low up' }], touch('overnight low', 100, 102, 'confirmed rejection')),
    ['- REACTION 15m touched overnight low: confirmed rejection (long side: buyers took over, confirmed)']);
  // No price (or a close at the level): the label alone, no side and no meaning.
  for (const [price, c] of [[null, 98], [100, 100], [100, undefined]]) {
    assert.deepStrictEqual(E.echoLines([{ read: '15m rejected overnight high down' }], touch('overnight high', price, c, 'confirmed rejection')), ['- REACTION 15m touched overnight high: confirmed rejection'], `${price} ${c}`);
  }
});

test('a broke candle reading as a rejection: the meaning follows its side (short: sellers), never the other side\'s', () => {
  const at = (dir, reaction) => E.echoLines([{ read: `15m broke prior vah ${dir}` }], briefing('15m', [rel('prior VAH', 'broke', dir, reaction)]))[0];
  assert.strictEqual(at('down', 'confirmed rejection'), '- REACTION 15m broke down prior VAH: confirmed rejection (short side: sellers took over, confirmed)');
  assert.strictEqual(at('up', 'long-wick rejection'), '- REACTION 15m broke up prior VAH: long-wick rejection (long side: buyers rejected lower prices)');
  // A breakout's stays the breaking side.
  assert.strictEqual(at('down', 'breakout'), '- REACTION 15m broke down prior VAH: breakout (short side: sellers in control: a breakout attempt, not a sweep)');
});
