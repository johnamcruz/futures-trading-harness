'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../../scripts/lib/skill-caps');

test('skill caps: the setups 4000 bytes, every other skill 3459 (3400 until feat/bias-bg: the owner approved raising it to restore candle-reading\'s context)', () => {
  assert.deepStrictEqual([C.SKILL_BYTES, C.SETUP_SKILL_BYTES], [3459, 4000]);
  assert.deepStrictEqual([...C.SETUP_SKILLS], ['rejection', 'breakout']);
  assert.ok(Object.isFrozen(C.SETUP_SKILLS));
  assert.strictEqual(C.skillByteCap('rejection'), 4000);
  assert.strictEqual(C.skillByteCap('breakout'), 4000);
  assert.strictEqual(C.skillByteCap('cisd'), 3459);
  assert.strictEqual(C.skillByteCap(undefined), 3459);
});
