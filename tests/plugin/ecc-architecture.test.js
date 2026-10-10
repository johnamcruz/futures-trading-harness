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
const LIB_WITHOUT_OWN_TEST = ['backtest/parquet', 'paths', 'rl/policy-net', 'trading/cisd-ote', 'trading/contracts'];
// CLIs stay thin (logic goes to scripts/lib/): a new CLI stays under 200 lines; the larger ones that
// predate the rule are pinned near their size and may only shrink. Hook scripts stay under 200 lines.
const CLI_MAX_LINES = 200;
const CLI_CEILINGS = { 'autotrader.js': 401, 'mcp-gateway.js': 306 };
const PIN_SLACK = 25; // a pinned CLI that shrank by more than this: lower its ceiling
const HOOK_MAX_LINES = 200;

test('ECC: every scripts/lib module has a unit test that loads it (no new untested logic)', () => {
  // Unit tests only (tests/lib/, tests/scripts/): fixtures and end-to-end runs don't count.
  const tests = ['lib', 'scripts'].flatMap(d => walk(path.join(REPO, 'tests', d))).filter(f => f.endsWith('.test.js'))
    .map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const libs = walk(path.join(REPO, 'scripts', 'lib')).filter(f => f.endsWith('.js'))
    .map(f => path.relative(path.join(REPO, 'scripts', 'lib'), f).replace(/\.js$/, '').split(path.sep).join('/'));
  // require('../../scripts/lib/x'), with any quote, or path.join(..., 'scripts', 'lib', ..., 'x').
  const loaded = lib => new RegExp(`scripts/lib/${lib.replace(/[.]/g, '\\.')}(\\.js)?['"\`]`).test(tests)
    || new RegExp(`'lib',\\s*${lib.split('/').map(p => `'${p.replace(/[.]/g, '\\.')}(\\.js)?'`).join(',\\s*')}\\s*\\)`).test(tests);
  const untested = libs.filter(l => !loaded(l));
  assert.deepStrictEqual(untested.filter(l => !LIB_WITHOUT_OWN_TEST.includes(l)), [], 'new scripts/lib modules need tests in tests/lib/');
  for (const l of LIB_WITHOUT_OWN_TEST) {
    assert.ok(libs.includes(l) && untested.includes(l), `${l} is now tested or gone: remove it from LIB_WITHOUT_OWN_TEST`);
  }
});

test('ECC: CLIs stay thin and hook scripts stay under 200 lines', () => {
  for (const f of fs.readdirSync(path.join(REPO, 'scripts')).filter(n => n.endsWith('.js'))) {
    const n = lines(path.join(REPO, 'scripts', f));
    const pinned = CLI_CEILINGS[f];
    if (pinned === undefined) assert.ok(n < CLI_MAX_LINES, `scripts/${f} has ${n} lines (a CLI stays under ${CLI_MAX_LINES}): move logic to scripts/lib/ (with tests)`);
    else {
      assert.ok(n <= pinned, `scripts/${f} grew to ${n} lines (pinned at ${pinned}): move logic to scripts/lib/ (with tests)`);
      assert.ok(pinned - n <= PIN_SLACK, `scripts/${f} shrank to ${n} lines: lower its pin in CLI_CEILINGS`);
    }
  }
  for (const f of Object.keys(CLI_CEILINGS)) assert.ok(fs.existsSync(path.join(REPO, 'scripts', f)), `${f} is gone: remove its pin`);
  for (const f of fs.readdirSync(path.join(REPO, 'scripts', 'hooks')).filter(n => n.endsWith('.js'))) {
    assert.ok(lines(path.join(REPO, 'scripts', 'hooks', f)) < HOOK_MAX_LINES, `scripts/hooks/${f} is not under ${HOOK_MAX_LINES} lines`);
  }
});

test('ECC: no runtime dependencies (plugin installs don\'t run npm install)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.deepStrictEqual(pkg.dependencies || {}, {});
});

test('ECC: no broker code in the harness (brokers are MCP servers reached through the adapter)', () => {
  // Known broker endpoints and SDKs; a new broker's belong in its own MCP server, and in this list.
  const BROKER = /api\.topstepx\.com|rtc\.topstepx\.com|projectx\.com|tradovateapi\.com|tradovate\.com\/v1|rithmic\.com|ninjatrader\.com|@microsoft\/signalr|protobufjs/;
  const hits = walk(path.join(REPO, 'scripts')).filter(f => f.endsWith('.js') && BROKER.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(hits.map(f => path.relative(REPO, f)), []);
});
