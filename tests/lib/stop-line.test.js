'use strict';

// The managed cycle's STOP line (scripts/lib/trading/stop-line.js): line-start only, the last one wins, the reason
// classified; missing or malformed: not stated (the runner reads it as hold and logs a process failure).

const test = require('node:test');
const assert = require('node:assert');
const { parseStopLine, REASONS } = require('../../scripts/lib/trading/stop-line');

test('parseStopLine: a line starting STOP decides; price or hold; the reason classified against the closed list', () => {
  assert.deepStrictEqual(parseStopLine('read...\nSTOP 21,512.25: protected-swing 15m BOS up, HL 21512.5\nCYCLE RESULT: managed - x'), { stated: true, hold: false, stop: 21512.25, reason: 'protected-swing', text: 'protected-swing 15m BOS up, HL 21512.5', inline: false });
  assert.deepStrictEqual(parseStopLine('STOP hold: hold, pullback inside the leg'), { stated: true, hold: true, stop: null, reason: 'hold', text: 'hold, pullback inside the leg', inline: false });
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

// stopLines: every line-start STOP line, plus the last STOP tail of a line that starts `9 Manage:`; a
// line-start one wins over an inline one, among inline the last. Quoted text (an example after "->") never parses.
const { stopLines } = require('../../scripts/lib/trading/stop-line');
const RECORDED = require('../fixtures/stop-lines-recorded.json').cycles;

test('stopLines: the 16 recorded cycles with no parsed line: 11 recovered from the 9 Manage: line (inline), 5 still missing', () => {
  assert.strictEqual(RECORDED.length, 16);
  for (const c of RECORDED) {
    const p = parseStopLine(c.text);
    if (c.recovered) {
      assert.strictEqual(p.stated, true, c.cycle);
      assert.strictEqual(p.inline, true, c.cycle);
      assert.strictEqual(p.hold, true, `${c.cycle}: all 16 were holds`);
    } else assert.strictEqual(p.stated, false, `${c.cycle}: ${c.missing}`);
  }
  assert.strictEqual(RECORDED.filter(c => parseStopLine(c.text).stated).length, 11);
});

test('stopLines: line-start beats inline; among inline the last; the record says which', () => {
  const both = '9 Manage: invalidation 15620.5; STOP 15683.25: protected-swing\nSTOP hold: hold (a pullback)';
  assert.deepStrictEqual(stopLines(both).map(x => [x.text, x.inline]), [['STOP 15683.25: protected-swing', true], ['STOP hold: hold (a pullback)', false]]);
  const p = parseStopLine(both);
  assert.deepStrictEqual([p.hold, p.inline], [true, false]);
  // A line-start line before the inline one still wins (order in the text does not matter, the kind does).
  assert.strictEqual(parseStopLine('STOP 15690: protected-swing\n9 Manage: x; STOP hold: hold').stop, 15690);
  const last = parseStopLine('9 Manage: invalidation 15620.5; STOP 15683.25: considered, rejected; STOP hold: hold');
  assert.deepStrictEqual([last.stated, last.hold, last.inline, last.text], [true, true, true, 'hold']);
  // Only a line that starts "9 Manage:": the CYCLE RESULT line, prose, "**9 Manage:**", "9. Manage:" never.
  for (const t of ['CYCLE RESULT: managed - held; STOP hold: hold', 'so I keep it, STOP hold: hold', '**9 Manage:** x; STOP hold: hold', '9. Manage: x; STOP hold: hold', '9 Manage: x, STOP hold, nothing to do']) assert.strictEqual(parseStopLine(t).stated, false, t);
  assert.deepStrictEqual(stopLines('no line'), []);
  assert.strictEqual(parseStopLine('STOP hold: hold').inline, false);
});

test('stopLines: an indented example after "->" (a skill\'s quoted line) never parses; the model\'s own "-> STOP" at the line start, a bullet or a quote does', () => {
  for (const t of ['  -> STOP 21516.75: protected-swing; modify_order the stop to 21516.75', ' -> STOP hold: hold', '--> STOP hold: hold', 'trade_lifecycle long +2.1R -> STOP hold: hold']) {
    assert.deepStrictEqual(stopLines(t), [], t);
    assert.strictEqual(parseStopLine(t).stated, false, t);
  }
  for (const t of ['- STOP hold: hold', '> STOP hold: hold', '- > STOP hold: hold', '* STOP hold: hold', '-> STOP hold: hold', '->STOP 21511.5: choch-against']) assert.strictEqual(parseStopLine(t).stated, true, t);
  assert.strictEqual(parseStopLine('-> STOP 21511.5: choch-against').stop, 21511.5);
});

test('stopLines: an inline STOP counts only at a clause start of the 9 Manage: line (after the label, a ";" or a "."), so a conditional after a hold is no tighten', () => {
  const cond = parseStopLine('9 Manage: invalidation 15620.5; STOP hold: hold; if the 15m breaks I would STOP 21511.50: choch-against');
  assert.deepStrictEqual([cond.stated, cond.hold, cond.inline], [true, true, true]);
  assert.strictEqual(parseStopLine('9 Manage: STOP 21511.5: choch-against').stop, 21511.5, 'right after the label');
  assert.strictEqual(parseStopLine('9 Manage: x. STOP 21511.5: choch-against').stop, 21511.5, 'after a period');
  assert.strictEqual(parseStopLine('9 Manage: I would STOP 21511.5: choch-against').stated, false, 'mid-clause only: none');
});
