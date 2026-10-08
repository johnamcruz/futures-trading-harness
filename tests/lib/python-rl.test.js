'use strict';

// The Python trainer's own tests (rl/tests), when a Python with numpy and
// gymnasium is available (FTH_PYTHON, else python3). The training test inside
// also needs torch, stable-baselines3, and sb3-contrib, and skips without them.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const RL = path.resolve(__dirname, '..', '..', 'rl');
const python = process.env.FTH_PYTHON || 'python3';
const probe = spawnSync(python, ['-c', 'import numpy, gymnasium'], { encoding: 'utf8' });
const ready = probe.status === 0;

test('rl/tests (Python)', { skip: ready ? false : `${python} lacks numpy/gymnasium (pip install -r rl/requirements.txt)`, timeout: 600000 }, () => {
  const r = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-t', '.'], { cwd: RL, encoding: 'utf8', timeout: 600000 });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
