'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseEnv, envFiles, loadEnvFiles, loadEnvForCli } = require('../../scripts/lib/env-file');
const { tmpDir } = require('../helpers');

test('parseEnv reads KEY=value lines, export, quotes, and comments; reports bad lines', () => {
  const { values, errors } = parseEnv([
    '# credentials',
    'PROJECTX_USERNAME=trader1',
    'export PROJECTX_API_KEY="abc def#not-a-comment"',
    "QUOTED='single # kept'",
    'PLAIN=value # a comment',
    'EMPTY=',
    'ESCAPED="a\\nb"',
    '',
    'not a line',
    '1BAD=x',
  ].join('\n'));
  assert.deepStrictEqual(values, {
    PROJECTX_USERNAME: 'trader1', PROJECTX_API_KEY: 'abc def#not-a-comment', QUOTED: 'single # kept', PLAIN: 'value', EMPTY: '', ESCAPED: 'a\nb',
  });
  assert.deepStrictEqual(errors, ['line 9: expected KEY=value', 'line 10: expected KEY=value']);
});

test('loadEnvFiles: FTH_ENV_FILE, then FTH_HOME/.env, then the repo .env; the environment always wins', () => {
  const home = tmpDir();
  const root = tmpDir();
  const extra = path.join(tmpDir(), 'my.env');
  fs.writeFileSync(extra, 'A=from-extra\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.env'), 'A=from-home\nB=from-home\nPROJECTX_API_KEY=k-home\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, '.env'), 'B=from-repo\nC=from-repo\n', { mode: 0o600 });
  const env = { FTH_HOME: home, FTH_ENV_FILE: extra, PROJECTX_API_KEY: 'already-set' }; // check-secrets: allow (fake test value)
  assert.deepStrictEqual(envFiles(env, root), [extra, path.join(home, '.env'), path.join(root, '.env')]);
  const r = loadEnvFiles({ env, root });
  assert.deepStrictEqual([env.A, env.B, env.C, env.PROJECTX_API_KEY], ['from-extra', 'from-home', 'from-repo', 'already-set']);
  assert.deepStrictEqual(r.loaded.map(l => l.keys), [['A'], ['B'], ['C']]);
  assert.deepStrictEqual(r.warnings, []);
  // No files at all: nothing loaded, nothing to warn about.
  assert.deepStrictEqual(loadEnvFiles({ env: { FTH_HOME: tmpDir() }, root: tmpDir() }), { loaded: [], warnings: [] });
});

test('a .env other users can read is loaded with a warning; the CLI logs key names, never values', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, '.env'), 'PROJECTX_API_KEY=supersecretvalue123\nbroken line\n', { mode: 0o644 }); // check-secrets: allow (fake test value)
  fs.chmodSync(path.join(home, '.env'), 0o644);
  const env = { FTH_HOME: home };
  let out = '';
  loadEnvForCli('autotrader', { env, out: { write: s => { out += s; } } });
  assert.strictEqual(env.PROJECTX_API_KEY, 'supersecretvalue123');
  assert.match(out, /\[autotrader\] loaded PROJECTX_API_KEY from .*\.env/);
  assert.match(out, /can be read by other users; chmod 600 it/);
  assert.match(out, /line 2: expected KEY=value/);
  assert.doesNotMatch(out, /supersecretvalue123/);
});
