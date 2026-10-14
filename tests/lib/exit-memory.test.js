'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createExitMemory } = require('../../scripts/lib/trading/exit-memory');
const { exitPlan } = require('../../scripts/lib/trading/strategies');
const { tmpDir } = require('../helpers');

const VALID = { name: 'prop_x', valid: true, timeframe: '3m', risk: { stop: 'strategy', min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 }, sizing: { cushion_frac: 0.3 } };

test('exit memory: a valid strategy is itself; once invalid, its last valid exit plan still manages the open position', () => {
  const file = path.join(tmpDir(), 'exit-plans.json');
  const mem = createExitMemory(file);
  assert.strictEqual(mem.strategyFor('prop_x', [VALID]), VALID);
  // Its rulebook refuses it now: no sizing, no exit; the position it opened keeps its trail.
  const now = mem.strategyFor('prop_x', [{ name: 'prop_x', valid: false, errors: ['rulebook'], risk: VALID.risk }]);
  assert.deepStrictEqual([now.valid, now.remembered], [false, true]);
  assert.deepStrictEqual(exitPlan(now), exitPlan(VALID));
  assert.strictEqual(now.sizing, undefined, 'exits only: nothing it sizes with is kept');
  // A restarted runner reads it back from the file.
  assert.deepStrictEqual(exitPlan(createExitMemory(file).strategyFor('prop_x', [])), exitPlan(VALID));
  // A later valid version replaces it.
  const changed = { ...VALID, exit: { trail_activate_r: 3, trail_giveback_r: 1 } };
  mem.strategyFor('prop_x', [changed]);
  assert.strictEqual(createExitMemory(file).strategyFor('prop_x', []).exit.trail_activate_r, 3);
});

test('exit memory: never seen, a corrupt file, or prototype names give nothing; a write failure is reported, not thrown', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'exit-plans.json');
  assert.strictEqual(createExitMemory(file).strategyFor('nope', []), null);
  fs.writeFileSync(file, '{not json');
  assert.strictEqual(createExitMemory(file).strategyFor('prop_x', []), null);
  fs.writeFileSync(file, JSON.stringify(['x']));
  assert.strictEqual(createExitMemory(file).strategyFor('prop_x', []), null);
  fs.writeFileSync(file, JSON.stringify({ prop_x: { name: 'prop_x' } }));
  assert.strictEqual(createExitMemory(file).strategyFor('prop_x', []), null, 'no risk: no plan');
  assert.strictEqual(createExitMemory(file).strategyFor('toString', []), null);
  // A remembered exit that fails the strategy exit checks is dropped, with the file and the key in the alert.
  for (const exit of [{ trail_activate_r: 2, trail_giveback_r: {} }, { trail_activate_r: 2, trail_giveback_r: 'x' }, { trail_activate_r: 2 }, { surprise: 1 }, 'x']) {
    const seen = [];
    const drops = [];
    fs.writeFileSync(file, JSON.stringify({ prop_x: { name: 'prop_x', timeframe: '3m', risk: { min_rr: 2 }, exit }, other: { name: 'other', risk: { min_rr: 2 }, exit: null } }));
    const mem = createExitMemory(file, { onError: m => seen.push(m), onDrop: d => drops.push(d) });
    assert.strictEqual(mem.strategyFor('prop_x', [], { symbol: 'MNQ', position: '77' }), null, JSON.stringify(exit));
    assert.ok(seen.some(m => m.includes(file) && /remembered exit plan for prop_x is invalid \(exit.*loses its trail and its time stop, and the broker's stop stays/.test(m)), seen.join());
    assert.deepStrictEqual(drops.map(d => [d.strategy, d.file, d.symbol, d.position]), [['prop_x', file, 'MNQ', '77']]);
    // Cleared from the file (the others kept), so it is reported once, not on every bar.
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['other']);
    assert.strictEqual(mem.strategyFor('prop_x', []), null);
    assert.strictEqual(drops.length, 1, 'once');
  }
  fs.writeFileSync(file, JSON.stringify({ prop_x: { name: 'prop_x', timeframe: 3, risk: { min_rr: 2 }, exit: null } }));
  assert.strictEqual(createExitMemory(file).strategyFor('prop_x', []), null, 'a timeframe that is not text');
  const errors = [];
  const blocked = path.join(dir, 'a-file');
  fs.writeFileSync(blocked, '');
  const mem = createExitMemory(path.join(blocked, 'exit-plans.json'), { onError: m => errors.push(m) });
  assert.strictEqual(mem.strategyFor('prop_x', [VALID]), VALID);
  assert.match(errors.join(), /could not remember prop_x's exit plan/);
});
