'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'train-loop.js');

function world(over = {}) {
  const user = tmpDir();
  const trader = { harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 };
  const config = path.join(user, 'loop.json');
  fs.writeFileSync(config, JSON.stringify({
    loopId: 'cli', replay: { workDir: path.join(user, 'work'), broker: 'sim', autotrader: trader }, proposer: trader,
    tuningWindows: [{ from: '2022-03-07', to: '2022-03-12' }, { from: '2023-09-11', to: '2023-09-16' }], heldOutWindows: [{ from: '2023-09-11', to: '2023-09-16' }], ...over,
  }));
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'home') };
  return { user, config, env, cli: (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 60000 }) };
}

test('train-loop.js plan: each window\'s unit and whether the ledger allows the look; nothing run or logged', () => {
  const w = world();
  const r = w.cli('plan', '--config', w.config);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /tuning 2022-03-07\.\.2022-03-12 \(2022-03-06T23:00:00\.000Z to 2022-03-11T23:00:00\.000Z\): allowed \(train/);
  assert.match(r.stdout, /tuning 2023-09-11\.\.2023-09-16 [^\n]*REFUSED: select [^\n]*allows judging looks only/);
  assert.match(r.stdout, /held-out 2023-09-11\.\.2023-09-16: judge only with --held-out-look/);
  assert.match(r.stdout, /decision rule \{"alpha":0\.05,"minPairs":20/);
  assert.ok(!fs.existsSync(path.join(w.env.FTH_HOME, 'training', 'looks.jsonl')), 'a plan logs no look');
});

test('train-loop.js: usage, status before a run, a held-out look needs its flag, an import needs a person, --steps plugs only the stubbed steps', () => {
  const w = world();
  assert.match(w.cli('nope').stderr, /usage: train-loop\.js/);
  assert.match(w.cli('run').stderr, /usage/);
  const st = w.cli('status', '--config', w.config);
  assert.strictEqual(st.status, 0, st.stderr);
  assert.match(st.stdout, /loop cli has not run/);
  assert.match(w.cli('judge', '--config', w.config, '--proposal', 'abc').stderr, /pass --held-out-look/);
  const p = path.join(w.user, 'p.json');
  fs.writeFileSync(p, `PROPOSAL ${JSON.stringify({ targets: ['wrong stated reason'], expects: 'x', edits: [{ file: 'skills/session-timing/SKILL.md', find: '# Session Timing', replace: '# Session Timing\n\nx' }] })}\n`);
  assert.match(w.cli('import-proposal', '--config', w.config, '--file', p).stderr, /--approved-by <name>/);
  const ok = w.cli('import-proposal', '--config', w.config, '--file', p, '--approved-by', 'owner');
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /queued [0-9a-f]{12} for the next iteration/);
  const steps = path.join(w.user, 'steps.js');
  fs.writeFileSync(steps, 'module.exports = { scorecard: () => [], writeBranch: () => "x" };\n');
  assert.match(w.cli('run', '--config', w.config, '--steps', steps).stderr, /only scorecard, evaluator may be plugged in, not writeBranch/);
});

test('train-loop.js run: a tuning window outside a tuning unit is refused before anything runs', () => {
  const w = world({ tuningWindows: [{ from: '2023-09-11', to: '2023-09-16' }] });
  const r = w.cli('run', '--config', w.config);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /look refused:\n- select [^\n]*allows judging looks only/);
  assert.ok(!fs.existsSync(path.join(w.env.FTH_HOME, 'training', 'looks.jsonl')));
  assert.ok(!fs.existsSync(path.join(w.user, 'work', 'cli', 'runs')), 'no replay started');
});
