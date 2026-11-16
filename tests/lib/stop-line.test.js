'use strict';

// The managed cycle's STOP line (scripts/lib/trading/stop-line.js): line-start only, the last one wins, the reason
// classified; missing or malformed: not stated (the runner reads it as hold and logs a process failure).

const test = require('node:test');
const assert = require('node:assert');
const { parseStopLine, REASONS } = require('../../scripts/lib/trading/stop-line');

test('parseStopLine: a line starting STOP decides; price or hold; the reason classified against the closed list', () => {
  assert.deepStrictEqual(parseStopLine('read...\nSTOP 21,512.25: protected-swing 15m BOS up, HL 21512.5\nCYCLE RESULT: managed - x'), { stated: true, hold: false, stop: 21512.25, reason: 'protected-swing', text: 'protected-swing 15m BOS up, HL 21512.5' });
  assert.deepStrictEqual(parseStopLine('STOP hold: hold, pullback inside the leg'), { stated: true, hold: true, stop: null, reason: 'hold', text: 'hold, pullback inside the leg' });
  assert.strictEqual(parseStopLine('  STOP HOLD: weakening but at the floor').reason, 'weakening');
  assert.strictEqual(parseStopLine('STOP 100: because I feel like it').reason, 'other');
  assert.strictEqual(parseStopLine('STOP 100: hold\nSTOP 105: choch-against').stop, 105, 'the last line wins');
  for (const r of REASONS) assert.strictEqual(parseStopLine(`STOP 1: ${r} x`).reason, r);
  // Markdown at the line start, a dollar sign, bold around the line: still the line.
  for (const t of ['**STOP 21516.75: protected-swing**', '- STOP 21516.75: protected-swing', '> STOP 21516.75: protected-swing', 'STOP $21,516.75: protected-swing']) assert.deepStrictEqual([parseStopLine(t).stated, parseStopLine(t).stop, parseStopLine(t).reason], [true, 21516.75, 'protected-swing'], t);
});

test('parseStopLine: prose, a missing line or a malformed one is not stated, and says which', () => {
  assert.deepStrictEqual(parseStopLine('I would say STOP 21500: protected-swing here'), { stated: false, why: 'no STOP line' });
  assert.deepStrictEqual(parseStopLine(''), { stated: false, why: 'no STOP line' });
  assert.deepStrictEqual(parseStopLine(null), { stated: false, why: 'no STOP line' });
  assert.deepStrictEqual(parseStopLine('STOP at the swing'), { stated: false, why: 'a STOP line that is not "STOP <price|hold>: <reason>"' });
  assert.strictEqual(parseStopLine('STOP 21500:').stated, false, 'no reason');
  assert.strictEqual(parseStopLine('stop 21500: i think we stop here').stated, false, 'lower-case prose is never the line');
});
