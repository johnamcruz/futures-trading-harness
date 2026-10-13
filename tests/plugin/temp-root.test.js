'use strict';

// tests/run-all.js runs the suite inside one temporary root (tests/temp-root.js) and removes it at
// the end, so a run leaves nothing in the system temporary directory.

const test = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../temp-root');
const { tmpDir } = require('./../helpers');

const FIX = path.join(__dirname, '..', 'fixtures', 'temp-root');
const quiet = () => {};
const inside = (p, root) => fs.realpathSync(p).startsWith(fs.realpathSync(root) + path.sep);

test('temp root: under tests/run-all.js, os.tmpdir(), the helpers and child processes are inside the run root', t => {
  const root = process.env[T.ROOT_ENV];
  if (!root) return t.skip('run directly, not through tests/run-all.js: os.tmpdir() is the system one');
  assert.ok(path.basename(root).startsWith(T.ROOT_PREFIX));
  assert.strictEqual(os.tmpdir(), root);
  assert.ok(inside(tmpDir(), root), 'tests/helpers.js tmpDir()');
  const child = execFileSync(process.execPath, ['-p', 'require("os").tmpdir()'], { encoding: 'utf8' }).trim();
  assert.strictEqual(child, root, 'a spawned process inherits it');
});

test('temp root: a run puts every temp dir (its own and its children\'s) in the root, removes it, and leaves nothing', async () => {
  const parent = tmpDir();
  const out = path.join(tmpDir(), 'out.json');
  const r = await T.runTests([path.join(FIX, 'makes-temp.js')], { parent, stdio: 'ignore', log: quiet, env: { ...process.env, TEMP_ROOT_OUT: out, [T.KEEP_ENV]: '' } });
  assert.strictEqual(r.status, 0);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(seen.root, r.root);
  for (const p of [seen.own, seen.child]) assert.ok(p.startsWith(r.root + path.sep), `${p} is inside ${r.root}`);
  assert.strictEqual(path.dirname(r.root), parent);
  assert.ok(path.basename(r.root).startsWith(`${T.ROOT_PREFIX}${process.pid}-`));
  assert.strictEqual(fs.existsSync(r.root), false, 'the root is removed');
  assert.deepStrictEqual(fs.readdirSync(parent), [], 'nothing is left in the parent');
});

test('temp root: a failing run still removes the root and keeps the tests\' status', async () => {
  const parent = tmpDir();
  const out = path.join(tmpDir(), 'out.json');
  const r = await T.runTests([path.join(FIX, 'makes-temp.js')], { parent, stdio: 'ignore', log: quiet, env: { ...process.env, TEMP_ROOT_OUT: out, TEMP_ROOT_FAIL: '1', [T.KEEP_ENV]: '' } });
  assert.notStrictEqual(r.status, 0);
  assert.ok(fs.existsSync(out), 'the test ran');
  assert.deepStrictEqual(fs.readdirSync(parent), []);
});

test('temp root: KEEP_TEST_TMP=1 keeps the root and prints its path', async () => {
  const parent = tmpDir();
  const out = path.join(tmpDir(), 'out.json');
  const logs = [];
  const r = await T.runTests([path.join(FIX, 'makes-temp.js')], { parent, stdio: 'ignore', log: m => logs.push(m), env: { ...process.env, TEMP_ROOT_OUT: out, [T.KEEP_ENV]: '1' } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.kept, true);
  assert.deepStrictEqual(r.leaked, [], 'the kept root is not a leak');
  assert.ok(fs.existsSync(JSON.parse(fs.readFileSync(out, 'utf8')).own), 'the tests\' dirs are kept');
  assert.ok(logs.some(m => m.includes(r.root) && m.includes('KEEP_TEST_TMP')), logs.join('\n'));
  assert.deepStrictEqual(fs.readdirSync(parent), [path.basename(r.root)], 'only the root, nothing outside it');
});

test('temp root: a temp dir made outside the root fails the run in CI (strict) and is named; locally it warns', async () => {
  const parent = tmpDir();
  const logs = [];
  const env = { ...process.env, TEMP_ROOT_LEAK_PARENT: parent, [T.KEEP_ENV]: '', CI: 'true' };
  const r = await T.runTests([path.join(FIX, 'leaks.js')], { parent, stdio: 'ignore', log: m => logs.push(m), env });
  assert.strictEqual(r.status, 1, 'the tests passed, the leak fails the run');
  assert.strictEqual(r.leaked.length, 1);
  assert.match(r.leaked[0], /^cache-/, 'any name, not only fth-*');
  assert.ok(logs.some(m => m.includes(r.leaked[0]) && !m.startsWith('warning')), logs.join('\n'));
  // Outside CI another run may share the temporary directory: the leak is a warning.
  const local = { ...env, CI: 'false' };
  const warned = [];
  const w = await T.runTests([path.join(FIX, 'leaks.js')], { parent, stdio: 'ignore', log: m => warned.push(m), env: local });
  assert.strictEqual(w.status, 0);
  assert.strictEqual(w.leaked.length, 1);
  assert.ok(warned.some(m => m.startsWith('warning') && m.includes(w.leaked[0])), warned.join('\n'));
  // A dir that was already there before the run is not this run's.
  const again = await T.runTests([path.join(FIX, 'makes-temp.js')], { parent, stdio: 'ignore', log: quiet, env: { ...process.env, TEMP_ROOT_OUT: path.join(tmpDir(), 'o.json'), [T.KEEP_ENV]: '' } });
  assert.strictEqual(again.status, 0);
  assert.deepStrictEqual(again.leaked, []);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  test(`temp root: ${sig} to the runner stops the tests and removes the root`, { timeout: 20000 }, async () => {
    const parent = tmpDir();
    const out = path.join(tmpDir(), 'out.txt');
    const runner = spawn(process.execPath, [path.join(FIX, 'run.js'), path.join(FIX, 'waits.js')], {
      env: { ...process.env, TEMP_ROOT_PARENT: parent, TEMP_ROOT_OUT: out, [T.KEEP_ENV]: '' }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    runner.stdout.on('data', d => { stdout += d; });
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(out) && Date.now() < deadline) await new Promise(res => setTimeout(res, 50));
    const root = fs.readFileSync(out, 'utf8');
    assert.ok(root.startsWith(parent + path.sep) && fs.existsSync(root), 'the tests are running in the root');
    runner.kill(sig);
    const code = await new Promise(res => runner.on('exit', c => res(c)));
    assert.notStrictEqual(code, 0);
    assert.strictEqual(JSON.parse(stdout).root, root);
    assert.deepStrictEqual(fs.readdirSync(parent), [], 'the root is gone');
  });
}

test('temp root: listEntries, leaked, inCI and rootEnv', () => {
  const parent = tmpDir();
  fs.mkdirSync(path.join(parent, 'fth-test-a'));
  fs.writeFileSync(path.join(parent, 'other'), '');
  const before = T.listEntries(parent);
  assert.deepStrictEqual(before, ['fth-test-a', 'other']);
  fs.mkdirSync(path.join(parent, 'fth-pins-b'));
  fs.mkdirSync(path.join(parent, 'abc123'));
  fs.mkdirSync(path.join(parent, 'kept-root'));
  assert.deepStrictEqual(T.leaked(parent, before, ['kept-root']), ['abc123', 'fth-pins-b'], 'any new name, not only fth-*');
  // A CI runner's systemd may make its own dirs mid-run: never the tests'.
  fs.mkdirSync(path.join(parent, 'systemd-private-0123abcd-systemd-resolved.service-XyZ12'));
  assert.deepStrictEqual(T.leaked(parent, before, ['kept-root']), ['abc123', 'fth-pins-b']);
  fs.mkdirSync(path.join(parent, 'my-systemd-private-x'));
  assert.deepStrictEqual(T.leaked(parent, before, ['kept-root']), ['abc123', 'fth-pins-b', 'my-systemd-private-x'], 'only the prefix');
  assert.deepStrictEqual(T.listEntries(path.join(parent, 'missing')), []);
  for (const v of ['true', 'TRUE', '1', ' true ']) assert.strictEqual(T.inCI({ CI: v }), true, v);
  for (const v of [undefined, '', 'false', '0', 'no']) assert.strictEqual(T.inCI({ CI: v }), false, String(v));
  const env = T.rootEnv('/r', { A: '1', TMPDIR: '/old', NODE_TEST_CONTEXT: 'child' });
  assert.deepStrictEqual(env, { A: '1', TMPDIR: '/r', TMP: '/r', TEMP: '/r', [T.ROOT_ENV]: '/r' });
  assert.ok(!path.basename(T.createRoot(parent)).startsWith('fth-'), 'the root itself never counts as a test dir');
});
