'use strict';

// The golden-file workflow (tests/golden.js): a golden is compared, never created by a plain run; a missing one
// fails with how to create it; a difference fails with the changed lines and how to update; the update flag is
// refused under CI (CI or GITHUB_ACTIONS), here and for the CLI snapshot; golden text is platform-neutral, with a
// distinct placeholder per name or time, and names no machine path; and every golden in tests/fixtures/golden/ is
// named, in full, by a test that checks it (none left behind when a test is removed).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { GOLDEN_DIR, FLAG, neutral, lineDiff, checkGolden, updateRefused } = require('../golden');
const { TERMS, FIRM_TIME, FORBIDDEN, MODEL_SIZE } = require('./platform-scan');
const { tmpDir } = require('../helpers');

const plain = { [FLAG]: '' };
const updating = { [FLAG]: '1' };

test('a missing golden fails and is not created; the message says how to create it on purpose', () => {
  const dir = tmpDir();
  const r = checkGolden('none.txt', 'x', { dir, env: plain });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /missing/);
  assert.ok(r.message.includes(`${FLAG}=1`));
  assert.ok(!fs.existsSync(path.join(dir, 'none.txt')), 'never written by a plain run');
});

test('a difference fails with the changed lines and how to update; the same text passes', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'g.txt'), 'a\nb\nc\nd\n');
  assert.deepStrictEqual(checkGolden('g.txt', 'a\nb\nc\nd\n', { dir, env: plain }), { ok: true, wrote: false, message: '' });
  const r = checkGolden('g.txt', 'a\nB\nc\nd\n', { dir, env: plain });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /line 2 - b\n {2}line 2 \+ B/);
  assert.ok(r.message.includes(`${FLAG}=1`) && /explain every changed line in the pull request/.test(r.message));
  // An inserted line shows as itself, not as every line after it.
  assert.match(lineDiff('a\nb\nc\n', 'a\nx\nb\nc\n'), /line 2 \+ x$/);
  assert.doesNotMatch(lineDiff('a\nb\nc\n', 'a\nx\nb\nc\n'), / - /);
});

test('the update flag writes the golden, and is refused with CI or GITHUB_ACTIONS set', () => {
  const dir = tmpDir();
  for (const ci of [{ CI: 'true' }, { CI: '1' }, { GITHUB_ACTIONS: 'true' }]) {
    const r = checkGolden('g.txt', 'new', { dir, env: { ...updating, ...ci } });
    assert.strictEqual(r.ok, false, JSON.stringify(ci));
    assert.match(r.message, /is refused with (CI|GITHUB_ACTIONS) set/);
    assert.ok(!fs.existsSync(path.join(dir, 'g.txt')));
  }
  assert.strictEqual(updateRefused({ ...plain, CI: 'true' }), null, 'without the flag nothing is refused');
  assert.deepStrictEqual(checkGolden('g.txt', 'new', { dir, env: updating }), { ok: true, wrote: true, message: '' });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'g.txt'), 'utf8'), 'new\n');
  assert.ok(checkGolden('g.txt', 'new', { dir, env: plain }).ok);
});

test('the CLI snapshot refuses the update flag under CI too, before it writes anything', () => {
  const snapshot = path.join(__dirname, '..', 'scripts', 'cli-parity.snapshot.json');
  const before = fs.readFileSync(snapshot, 'utf8');
  const r = spawnSync(process.execPath, ['--test', path.join(__dirname, '..', 'scripts', 'cli-parity.test.js')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, [FLAG]: '1', CI: 'true' }, timeout: 120000,
  });
  assert.notStrictEqual(r.status, 0, 'fails');
  assert.match(r.stdout, /is refused with CI set/);
  assert.strictEqual(fs.readFileSync(snapshot, 'utf8'), before, 'the snapshot is untouched');
});

test('golden text is neutral, with a distinct placeholder per name or time, and no temporary path', () => {
  const placeholders = new Set();
  for (const t of TERMS) {
    const out = neutral(`before ${t.sample} after`);
    assert.ok(!FORBIDDEN.test(out) && !FIRM_TIME.test(out) && !MODEL_SIZE.test(`${out} model`), t.sample);
    placeholders.add(out);
  }
  assert.strictEqual(placeholders.size, new Set(TERMS.map(t => t.sample)).size, 'each name its own placeholder');
  // A name and the same name with a suffix (an account) stay apart; one text always maps to the same placeholder.
  const name = TERMS[0].sample.replace(/\s/g, '');
  assert.notStrictEqual(neutral(name), neutral(`${name}_50k`));
  assert.strictEqual(neutral(name), neutral(name));
  assert.strictEqual(neutral(path.join(os.tmpdir(), 'fth-test-abc123', 'bars', 'x.json')), '<tmp>/<dir>/bars/x.json\n');
  assert.strictEqual(neutral(path.join(fs.realpathSync(os.tmpdir()), 'fth-test-abc123')), '<tmp>/<dir>\n');
});

/** Every golden name a test checks: the .txt literals of the test files that call assertGolden (no templates). */
function namedGoldens() {
  const files = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.test.js') && files.push(path.join(d, e.name))));
  walk(path.join(__dirname, '..'));
  const names = new Map();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (!/\bassertGolden\(/.test(text) || f === __filename) continue;
    assert.doesNotMatch(text, /assertGolden\(`/, `${path.basename(f)}: a golden is named in full, never built from a template`);
    for (const m of text.matchAll(/'([A-Za-z0-9][A-Za-z0-9-]*\.txt)'/g)) names.set(m[1], path.basename(f));
  }
  return names;
}

test('every golden is named in full by a test that checks it, every named golden exists, and none names a machine path', () => {
  const goldens = fs.readdirSync(GOLDEN_DIR).sort();
  const named = namedGoldens();
  assert.ok(goldens.length > 0);
  assert.deepStrictEqual(goldens.filter(g => !named.has(g)), [], 'goldens no test names (remove them with their test)');
  assert.deepStrictEqual([...named.keys()].filter(n => !goldens.includes(n)).sort(), [], 'named goldens that are missing');
  for (const g of goldens) {
    const text = fs.readFileSync(path.join(GOLDEN_DIR, g), 'utf8');
    assert.doesNotMatch(text, /\/(?:Users|Volumes|home|private\/var|var\/folders)\//, `${g}: a machine path`);
    assert.strictEqual(neutral(text), text, `${g}: not neutral`);
  }
});

/** A golden test run in a child under its own TMPDIR, as given (spaces, nesting, a doubled slash). */
function underTmp(tmpdir) {
  fs.mkdirSync(tmpdir, { recursive: true });
  try {
    return spawnSync(process.execPath, ['--test', path.join(__dirname, '..', 'lib', 'golden-gate.test.js')], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir }, timeout: 120000,
    });
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}

test('goldens hold under any TMPDIR: a custom nested one, one with a space, one written with a doubled slash', () => {
  const base = tmpDir();
  try {
    for (const dir of [path.join(base, 'nested', 'deeper'), path.join(base, 'with space', 'tmp'), `${path.join(base, 'slash')}//`]) {
      const r = underTmp(dir);
      assert.strictEqual(r.status, 0, `${dir}:\n${r.stdout.split('\n').filter(l => /not ok|line \d+ [-+]/.test(l)).join('\n')}`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('neutral() masks the temporary directory as the environment names it now, and by its real path', () => {
  const saved = process.env.TMPDIR;
  const base = fs.realpathSync(tmpDir());
  const custom = path.join(base, 'a b', 'tmp');
  fs.mkdirSync(custom, { recursive: true });
  try {
    process.env.TMPDIR = `${custom}/`;
    assert.strictEqual(neutral(path.join(custom, 'run-home-x', 'STOP')), '<tmp>/<dir>/STOP\n');
    assert.strictEqual(neutral(`${custom}//fth-test-q/bars`), '<tmp>/<dir>/bars\n');
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
