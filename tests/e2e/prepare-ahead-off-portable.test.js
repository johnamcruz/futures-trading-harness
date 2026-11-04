'use strict';

/**
 * The off regression's fixture is machine-independent (review F1): the suite's own key-absent check passes in a child
 * process with another HOME (os.homedir: the user's home in the deny rules and the prompt) and another time zone, as it
 * passes in CI. tests/e2e/prepare-ahead-off-regression.test.js and tests/fixtures/prepare-off/generate.js pin HOME and
 * the normalizer names the user's home, so neither the developer's machine nor CI's leaks into the expected value.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

test('the off regression passes with another HOME and another time zone (a CI machine\'s)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-other-home-'));
  for (const TZ of ['UTC', 'Asia/Tokyo']) {
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern', 'key absent is main|key "off" is main', path.join(ROOT, 'tests', 'e2e', 'prepare-ahead-off-regression.test.js')], {
      // (NODE_TEST_CONTEXT left out: the child's runner reports to its own output, not to this one's.)
      cwd: ROOT, encoding: 'utf8', timeout: 1200000, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), HOME: home, TZ, USER: 'runner', LOGNAME: 'runner', LANG: 'C', LC_ALL: 'C' },
    });
    assert.strictEqual(r.status, 0, `${TZ}: ${(r.stdout || '').split('\n').filter(l => /not ok|error|got|want/.test(l)).slice(0, 8).join('\n')}`);
    assert.match(r.stdout, /# pass 2/);
  }
});

test('the generator and the suite pin HOME before anything reads it; the normalizer names the user\'s home', () => {
  for (const f of ['tests/fixtures/prepare-off/generate.js', 'tests/e2e/prepare-ahead-off-regression.test.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const pin = src.indexOf("process.env.HOME = require('../fixtures/prepare-off/outputs').PINNED_HOME") >= 0 ? src.indexOf("process.env.HOME = require('../fixtures/prepare-off/outputs').PINNED_HOME") : src.indexOf("process.env.HOME = require('./outputs').PINNED_HOME");
    assert.ok(pin >= 0, `${f} pins HOME`);
    assert.ok(pin < src.indexOf("require('../../scripts") || src.indexOf("require('../../scripts") < 0, `${f}: before the harness loads`);
  }
  const O = require('../fixtures/prepare-off/outputs');
  const norm = O.normalizer({ home: '/w' }, ROOT);
  assert.strictEqual(norm(`a ${os.homedir()}/.ssh b`), 'a <user-home>/.ssh b');
});
