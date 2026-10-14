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
const LIB_WITHOUT_OWN_TEST = ['paths'];
// CLIs stay thin (logic goes to scripts/lib/): a new CLI stays under 200 lines; the larger ones that
// predate the rule are pinned near their size and may only shrink. Hook scripts stay under 200 lines.
const CLI_MAX_LINES = 200;
const CLI_CEILINGS = { 'autotrader.js': 381, 'mcp-gateway.js': 299 };
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

test('ECC: the platform-neutral guard is in place at its fixed paths, and the suite runs it', () => {
  // tests/plugin/no-platform-specifics.test.js checks its pins only shrink against the base branch; a rename or a
  // deletion of the guard must fail here, in a file of its own.
  for (const f of ['tests/plugin/no-platform-specifics.test.js', 'tests/plugin/platform-scan.js', 'tests/plugin/no-platform-specifics.pins.json']) {
    assert.ok(fs.existsSync(path.join(REPO, f)), `${f} is gone: the platform-neutral guard (CLAUDE.md, "Separation of work") stays`);
  }
  const guard = fs.readFileSync(path.join(REPO, 'tests', 'plugin', 'no-platform-specifics.test.js'), 'utf8');
  assert.match(guard, /S\.readBasePins\(REPO, rel\(PINS\), rel\(__filename\)\)/, 'the guard checks its pins against the base branch');
  assert.match(guard, /path\.join\(__dirname, 'no-platform-specifics\.pins\.json'\)/, 'at the fixed pins path');
  // The base it read is the one checked, and the check's result is what the test asserts on.
  assert.match(guard, /const base = S\.readBasePins\(REPO, rel\(PINS\), rel\(__filename\)\);[^\n]*\n\s*assert\.deepStrictEqual\(S\.baseVerdict\(pins, base\), \[\]\);/, 'the guard asserts baseVerdict(pins, base) on the base it read');
  assert.match(guard, /const pins = JSON\.parse\(fs\.readFileSync\(PINS, 'utf8'\)\);\n\s*const rel = [^\n]*\n\s*const base = S\.readBasePins/, 'on the pins file it read');
  // tests/run-all.js runs every *.test.js under tests/: the guard is among them.
  const { collect } = { collect: dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)])) };
  const runAll = fs.readFileSync(path.join(REPO, 'tests', 'run-all.js'), 'utf8');
  assert.match(runAll, /collect\(__dirname\)/);
  assert.match(runAll, /d\.name\.endsWith\('\.test\.js'\)/);
  assert.ok(collect(path.join(REPO, 'tests')).includes(path.join(REPO, 'tests', 'plugin', 'no-platform-specifics.test.js')));
});

// The platform guard's base check, run here too, so switching it off takes edits to two files.
const GUARD_PINS = 'tests/plugin/no-platform-specifics.pins.json';
const GUARD_TEST = 'tests/plugin/no-platform-specifics.test.js';
function guardBaseViolations(repo) {
  const S = require('./platform-scan');
  const pins = JSON.parse(fs.readFileSync(path.join(repo, GUARD_PINS), 'utf8'));
  return S.baseVerdict(pins, S.readBasePins(repo, GUARD_PINS, GUARD_TEST));
}

test('ECC: the platform guard\'s pins only shrink against the base branch (checked here as well as in the guard)', () => {
  assert.deepStrictEqual(guardBaseViolations(REPO), []);
});

test('ECC: that base check fails on a key added by hand on a branch', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-guard-'));
  const git = (...args) => assert.strictEqual(spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).status, 0, args.join(' '));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  write(GUARD_TEST, '\n');
  write(GUARD_PINS, JSON.stringify({ 'a.md|firm': ['1'] }));
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.deepStrictEqual(guardBaseViolations(dir), [], 'unchanged');
  write(GUARD_PINS, JSON.stringify({ 'a.md|firm': ['1'], 'b.md|firm': ['2'] }));
  git('commit', '-qam', 'a key added by hand');
  assert.match(guardBaseViolations(dir).join(), /b\.md\|firm: not pinned on the base branch/);
  fs.rmSync(dir, { recursive: true, force: true });
});
