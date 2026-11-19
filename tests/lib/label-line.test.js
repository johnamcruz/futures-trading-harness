'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { labelLines } = require('../../scripts/lib/label-line');

test('labelLines: the label at a line start, then its colon or whitespace and a dash (hyphen, en, em), markdown bold around either; the text after it, in order', () => {
  const t = [
    'SELECTION: ENTER - a',
    '**SELECTION:** WAIT - b',
    '  SELECTION – PASS',
    '**SELECTION** — PASS - c',
    'SELECTION - ENTER',
    'Prose: write "SELECTION: ENTER - x" when you enter',
    'SELECTIONS: ENTER',
    'SELECTION-wise, no',
    'selection: enter',
  ].join('\n');
  assert.deepEqual(labelLines(t, 'SELECTION'), ['ENTER - a', 'WAIT - b', 'PASS', 'PASS - c', 'ENTER']);
  assert.deepEqual(labelLines(t, 'SELECTION', { ignoreCase: true }), ['ENTER - a', 'WAIT - b', 'PASS', 'PASS - c', 'ENTER', 'enter']);
  assert.deepEqual(labelLines(t, 'SELECTION', { colonOnly: true }), ['ENTER - a', 'WAIT - b']);
  assert.deepEqual(labelLines(null, 'SELECTION'), []);
});

test('labelLines reproduces the context quiz\'s ANSWER rules (#347) exactly: the colon form, FINAL ANSWER, any case', () => {
  const t = 'Answering the question now\n**Answer (short side):** x\nANSWER: B\nfinal answer: C\nAnswer - D\nAnswer-wise, E';
  assert.deepEqual(labelLines(t, '(?:FINAL\\s+)?ANSWER', { ignoreCase: true, colonOnly: true }), ['B', 'C']);
  assert.deepEqual(labelLines(t, '(?:FINAL\\s+)?ANSWER', { ignoreCase: true }), ['B', 'C', 'D']);
});
