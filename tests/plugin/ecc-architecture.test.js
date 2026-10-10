'use strict';

// The ECC architecture as hard rules (CLAUDE.md, "ECC architecture"): every
// change must keep these. Exceptions that predate a rule are listed here and
// may only shrink; never add to them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const lines = file => (fs.readFileSync(file, 'utf8').match(/\n/g) || []).length;

// Logic lives in scripts/lib/ and is tested: each module is loaded by a test of its own.
const LIB_WITHOUT_OWN_TEST = ['backtest/parquet', 'paths', 'rl/env-config', 'rl/policy-net', 'trading/cisd-ote', 'trading/contracts'];
// CLIs stay thin (logic goes to scripts/lib/); hook scripts stay under 200 lines.
const CLI_MAX_LINES = 400;
const CLI_CEILINGS = { 'autotrader.js': 401 };
const HOOK_MAX_LINES = 200;

test('ECC: every scripts/lib module has a test that loads it (no new untested logic)', () => {
  const tests = walk(path.join(REPO, 'tests')).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const libs = walk(path.join(REPO, 'scripts', 'lib')).filter(f => f.endsWith('.js'))
    .map(f => path.relative(path.join(REPO, 'scripts', 'lib'), f).replace(/\.js$/, '').split(path.sep).join('/'));
  const loaded = lib => new RegExp(`scripts/lib/${lib.replace(/[.]/g, '\\.')}(\\.js)?['"]`).test(tests);
  const untested = libs.filter(l => !loaded(l));
  assert.deepStrictEqual(untested.filter(l => !LIB_WITHOUT_OWN_TEST.includes(l)), [], 'new scripts/lib modules need tests in tests/lib/');
  for (const l of LIB_WITHOUT_OWN_TEST) {
    assert.ok(libs.includes(l) && untested.includes(l), `${l} is now tested or gone: remove it from LIB_WITHOUT_OWN_TEST`);
  }
});

test('ECC: CLIs stay thin and hook scripts stay under 200 lines', () => {
  for (const f of fs.readdirSync(path.join(REPO, 'scripts')).filter(n => n.endsWith('.js'))) {
    const max = CLI_CEILINGS[f] || CLI_MAX_LINES;
    assert.ok(lines(path.join(REPO, 'scripts', f)) <= max, `scripts/${f} is over ${max} lines: move logic to scripts/lib/ (with tests)`);
  }
  for (const f of fs.readdirSync(path.join(REPO, 'scripts', 'hooks')).filter(n => n.endsWith('.js'))) {
    assert.ok(lines(path.join(REPO, 'scripts', 'hooks', f)) <= HOOK_MAX_LINES, `scripts/hooks/${f} is over ${HOOK_MAX_LINES} lines`);
  }
});

test('ECC: no runtime dependencies (plugin installs don\'t run npm install)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.deepStrictEqual(pkg.dependencies || {}, {});
});

test('ECC: no broker code in the harness (brokers are MCP servers reached through the adapter)', () => {
  const BROKER = /api\.topstepx\.com|rtc\.topstepx\.com|tradovateapi\.com|rithmic\.com|@microsoft\/signalr/;
  const hits = walk(path.join(REPO, 'scripts')).filter(f => f.endsWith('.js') && BROKER.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(hits.map(f => path.relative(REPO, f)), []);
});
