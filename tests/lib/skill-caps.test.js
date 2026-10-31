'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../../scripts/lib/skill-caps');

test('skill caps: the setups 4000 bytes, every other skill 5130 (3400 until feat/bias-bg, 3459 until feat/sweep-candle-control: the owner approved raising it for candle-reading\'s context, its reaction-at-a-level read, 2026-10-31)', () => {
  assert.deepStrictEqual([C.SKILL_BYTES, C.SETUP_SKILL_BYTES], [5130, 4000]);
  assert.deepStrictEqual([...C.SETUP_SKILLS], ['rejection', 'breakout']);
  assert.ok(Object.isFrozen(C.SETUP_SKILLS));
  assert.strictEqual(C.skillByteCap('rejection'), 4000);
  assert.strictEqual(C.skillByteCap('breakout'), 4000);
  assert.strictEqual(C.skillByteCap('cisd'), 5130);
  assert.strictEqual(C.skillByteCap(undefined), 5130);
});
