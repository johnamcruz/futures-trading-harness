'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const { resolveLoop, windowRange, replayFor } = require('../../scripts/lib/train/config');
const { DECISION_RULE } = require('../../scripts/lib/train/paired');

const ROOT = path.resolve(__dirname, '..', '..');
const trader = { harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 };
const raw = (over = {}) => ({
  loopId: 'l1', replay: { workDir: '/tmp/fth-train', broker: 'sim', autotrader: trader }, tuningWindows: [{ from: '2022-03-07', to: '2022-03-12' }], proposer: trader, ...over,
});

test('resolveLoop: defaults, the work folder, and a hash that ignores the limits (raised on resume)', () => {
  const l = resolveLoop(raw());
  assert.deepStrictEqual([l.repeats, l.seed, l.maxFlagged, l.controlPoints, l.maxProposals], [3, 1, 12, 12, 2]);
  assert.deepStrictEqual(l.limits, { maxIterations: 1, maxModelCalls: 200, maxWallMinutes: 240 });
  assert.deepStrictEqual(l.rule, DECISION_RULE);
  assert.strictEqual(l.workDir, path.join('/tmp/fth-train', 'l1'));
  assert.strictEqual(resolveLoop(raw({ limits: { maxModelCalls: 999 } })).hash, l.hash);
  assert.notStrictEqual(resolveLoop(raw({ seed: 2 })).hash, l.hash);
  assert.notStrictEqual(resolveLoop(raw({ tuningWindows: [{ from: '2022-03-07', to: '2022-03-11' }] })).hash, l.hash);
});

test('resolveLoop: refuses a bad id, window, limit, a loosened rule, a relative workDir; reads the replay and proposer from files', () => {
  const bad = over => assert.throws(() => resolveLoop(raw(over)), /invalid training-loop config/);
  bad({ loopId: '../x' });
  bad({ tuningWindows: [] });
  bad({ tuningWindows: [{ from: '2022-03-12', to: '2022-03-07' }] });
  bad({ tuningWindows: [{ from: '2022-3-7', to: '2022-03-12' }] });
  bad({ heldOutWindows: [{ from: '2023-09-11' }] });
  bad({ repeats: 0 });
  bad({ limits: { maxIterations: 0 } });
  bad({ limits: { forever: true } });
  bad({ maxProposals: 9 });
  bad({ replay: { workDir: 'relative', broker: 'sim', autotrader: trader } });
  assert.throws(() => resolveLoop(raw({ decision: { minPairs: 5 } })), /loosen the frozen rule/);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'replay.json'), JSON.stringify({ workDir: '/tmp/x', broker: 'sim', autotrader: 'trader.json' }));
  fs.writeFileSync(path.join(dir, 'trader.json'), JSON.stringify(trader));
  const l = resolveLoop(raw({ replay: 'replay.json', proposer: 'trader.json' }), { baseDir: dir });
  assert.deepStrictEqual(l.replay.autotrader, trader);
  assert.strictEqual(l.proposer.harness, 'custom');
  // The shipped example resolves.
  const ex = path.join(ROOT, 'mcp-configs', 'train-loop.example.json');
  assert.strictEqual(resolveLoop(JSON.parse(fs.readFileSync(ex, 'utf8')), { baseDir: path.dirname(ex) }).loopId, 'nq-skills-1');
});

test('windowRange and replayFor: session from\'s start to session to\'s start, as one replay run per window', () => {
  // Session 2022-03-07 (a Monday) starts Sunday 18:00 New York time; session 2022-03-12 (a Saturday, none) at Friday 18:00.
  assert.deepStrictEqual(windowRange({ from: '2022-03-07', to: '2022-03-12' }), { start: new Date('2022-03-06T23:00:00Z'), end: new Date('2022-03-11T23:00:00Z') });
  const l = resolveLoop(raw());
  const r = replayFor(l, { label: 'champion-t0', window: l.tuningWindows[0] });
  assert.deepStrictEqual([r.runId, r.workDir, r.start, r.end, r.broker], ['l1-champion-t0', path.join(l.workDir, 'runs'), '2022-03-06T23:00:00.000Z', '2022-03-11T23:00:00.000Z', 'sim']);
});
