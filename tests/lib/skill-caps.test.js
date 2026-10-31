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

test('skill caps: candle-reading alone has its own cap (feat/sweep-candle-control, owner-approved: its reaction read improves context); every other skill keeps its cap', () => {
  assert.deepStrictEqual({ ...C.PER_SKILL }, { 'candle-reading': 6212 });
  assert.ok(Object.isFrozen(C.PER_SKILL));
  assert.strictEqual(C.skillByteCap('candle-reading'), 6212);
  const fs = require('fs');
  const path = require('path');
  for (const s of fs.readdirSync(path.join(__dirname, '..', '..', 'skills'))) {
    if (s === 'candle-reading') continue;
    assert.strictEqual(C.skillByteCap(s), C.SETUP_SKILLS.includes(s) ? 4000 : 3459, s);
  }
  // Inherited names are no skill's own cap.
  assert.strictEqual(C.skillByteCap('toString'), 3459);
  assert.strictEqual(C.skillByteCap('constructor'), 3459);
});

test('skill caps: a per-skill cap past its pin, or a second skill given its own, is refused on load', () => {
  const T = require('../../scripts/lib/tunables');
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'training.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-test-caps-'));
  const at = v => { const f = path.join(dir, `t${Math.random()}.json`); fs.writeFileSync(f, JSON.stringify(v)); return f; };
  try {
    assert.throws(() => T.load('training', at({ ...base, skillCaps: { ...base.skillCaps, perSkill: { 'candle-reading': 7000 } } })), /perSkill\.candle-reading/);
    assert.throws(() => T.load('training', at({ ...base, skillCaps: { ...base.skillCaps, perSkill: { 'candle-reading': 6212, cisd: 9000 } } })), /cisd/);
    assert.strictEqual(T.load('training', at({ ...base, skillCaps: { ...base.skillCaps, perSkill: { 'candle-reading': 5000 } } })).skillCaps.perSkill['candle-reading'], 5000, 'lower is allowed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
