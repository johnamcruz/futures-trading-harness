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
  assert.strictEqual(at('rejected', 'down', 'plain'), '- REACTION 15m rejected down prior VAH: plain (no rejection read: weak context only; needs other confirmation)');
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
    '- REACTION 15m rejected down prior VAH: plain (no rejection read: weak context only; needs other confirmation)',
    '- MISMATCH: your read says long-wick rejection; the briefing\'s reaction is plain (a read, never a veto: read it with candle-reading)',
  ]);
  assert.strictEqual(E.echoLines([{ read: '15m rejected prior vah down', why: 'plain, weak' }], b).length, 1);
  assert.strictEqual(E.echoLines([{ read: '15m rejected prior vah down', why: 'the VAH held' }], b).length, 1);
});
