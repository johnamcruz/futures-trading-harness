'use strict';

// The tier 2 mock policy (tests/fixtures/goal-world.js) follows the shipped plan: the setup is the entry (no confirming
// 3m read required), and a Standard plan's reads go to their steps by form, never by position.
const test = require('node:test');
const assert = require('node:assert');
const GW = require('../fixtures/goal-world');

test('stepsOf: a Standard plan without an entry read puts its stop and target reads in their steps (by form)', () => {
  const steps = r => GW.stepsOf(r).map(x => `${x.step}:${x.read}`);
  assert.deepStrictEqual(steps(['1h up', 'at overnight high', '15m broke overnight high up', 'stop 15m low 16671.25', 'target 2r']),
    ['bias:1h up', 'location:at overnight high', 'setup:15m broke overnight high up', 'stop:stop 15m low 16671.25', 'target:target 2r']);
  // With a true entry read the plan states it fourth, as before.
  assert.deepStrictEqual(steps(['1h up', 'vwap above', '15m rejected prior RTH low up', '3m momentum up', 'stop 15m low 16546.25', 'target prior 1h high 16600']),
    ['bias:1h up', 'location:vwap above', 'setup:15m rejected prior RTH low up', 'entry:3m momentum up', 'stop:stop 15m low 16546.25', 'target:target prior 1h high 16600']);
});

test('listedReads: a listed setup is composed with no confirming 3m read; one is stated only when it is true', () => {
  const bias = { step: 'bias', read: 'trend long allowed' };
  const c15 = { l: 16546.5, h: 16570 };
  const plain = GW.listedReads({ side: 'long', setup: '15m broke prior RTH low up', c3: { closeLocation: 'middle', patterns: [], momentum: 'none' }, c15, bias, vwap: null });
  assert.deepStrictEqual(plain.map(x => x.step), ['bias', 'setup', 'stop', 'target']);
  assert.strictEqual(plain.find(x => x.step === 'stop').read, 'stop 15m low 16546.5');
  const confirmed = GW.listedReads({ side: 'long', setup: '15m broke prior RTH low up', c3: { closeLocation: 'top', patterns: [], momentum: 'none' }, c15, bias, vwap: null });
  assert.deepStrictEqual(confirmed.map(x => x.read), ['trend long allowed', '15m broke prior RTH low up', '3m close top', 'stop 15m low 16546.5', 'target trail']);
  // No 15m candle: no stop read, no setup.
  assert.strictEqual(GW.listedReads({ side: 'long', setup: 'x', c3: {}, c15: null, bias, vwap: null }), null);
});
