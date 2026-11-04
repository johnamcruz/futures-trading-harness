'use strict';

/**
 * The off regression's comparison holds across platforms (the CI failure of #297: main's outputs generated on macOS,
 * compared on Linux). Each guard simulates a difference between the two where Linux isn't at hand:
 *   (a) a gzip file's compressed bytes (the header's OS byte, the zlib build and level): compared by its content;
 *   (b) directory order (Linux lists a directory in its own order, macOS sorted): the suite passes with every
 *       readdir reversed, in the test process and every node process it starts;
 *   (c) a temp root whose real path differs from its name (macOS /var -> /private/var; a symlinked TMPDIR).
 * And the comparison reports every difference at once (all days, all fields, at most 50).
 */

process.env.HOME = require('../fixtures/prepare-off/outputs').PINNED_HOME;
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const O = require('../fixtures/prepare-off/outputs');

const ROOT = path.resolve(__dirname, '..', '..');
const childEnv = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), ...extra });
const SUITE = path.join(ROOT, 'tests', 'e2e', 'prepare-ahead-off-regression.test.js');
const runSuite = env => spawnSync(process.execPath, ['--test', '--test-name-pattern', 'key absent is main|key "off" is main', SUITE], { cwd: ROOT, encoding: 'utf8', timeout: 1200000, env: childEnv(env) });
const failures = r => (r.stdout || '').split('\n').filter(l => /not ok|error|got|want/.test(l)).slice(0, 8).join('\n');

test('(a) a gzip file is compared by its content: recompressed with another OS byte in its header and another level, the state is the same', { timeout: 600000 }, async () => {
  const { w } = await O.runDay('no-fill');
  const before = O.stateOf(w, null);
  const gz = fs.readdirSync(w.home, { recursive: true }).filter(f => String(f).endsWith('.gz')).map(f => path.join(w.home, String(f)));
  assert.ok(gz.length >= 1, 'the day writes a gzip file (the session record\'s bars)');
  for (const f of gz) {
    const text = zlib.gunzipSync(fs.readFileSync(f));
    const re = zlib.gzipSync(text, { level: 1 });
    re[9] = re[9] === 3 ? 19 : 3; // the OS byte: Unix (Linux) or macOS
    assert.notDeepStrictEqual(re, fs.readFileSync(f), 'other bytes');
    fs.writeFileSync(f, re);
  }
  assert.deepStrictEqual(O.stateOf(w, null), before);
});

test('(b) every directory listed in reverse (Linux\'s own order is not sorted): the off check still passes', { timeout: 1500000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-readdir-'));
  const preload = path.join(dir, 'reverse-readdir.js');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const sync = fs.readdirSync;
    fs.readdirSync = (...a) => sync(...a).slice().reverse();
    const prom = fs.promises.readdir;
    fs.promises.readdir = async (...a) => (await prom(...a)).slice().reverse();
    const cb = fs.readdir;
    fs.readdir = (p, o, f) => { const done = typeof o === 'function' ? o : f; const opts = typeof o === 'function' ? undefined : o; return cb(p, opts, (e, l) => done(e, l && l.slice().reverse())); };`);
  // Every node process the suite starts (the gateway, the harness tools, the hooks) loads it too.
  const r = runSuite({ NODE_OPTIONS: `--require ${JSON.stringify(preload)}` });
  assert.strictEqual(r.status, 0, failures(r));
});

test('(c) a temp root whose real path is another (a symlinked TMPDIR, as macOS /var is /private/var): the off check still passes', { timeout: 1500000 }, () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-real-tmp-'));
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  assert.notStrictEqual(fs.realpathSync(link), link);
  const r = runSuite({ TMPDIR: link, TMP: link, TEMP: link });
  assert.strictEqual(r.status, 0, failures(r));
});

test('the comparison reports every difference (all days, all fields), at most 50, each with its path', () => {
  const main = require('../fixtures/prepare-off/main-outputs.json').days;
  const got = JSON.parse(JSON.stringify(main));
  got['no-fill'].passes[0].logs.push('x');
  got.fill.state.push(['leak.json', '{}']);
  got.entry.fingerprint.delivery = 'y';
  const all = O.allDiffs(got, main);
  assert.deepStrictEqual(all.map(d => d.at.split('/')[1]), ['no-fill', 'fill', 'entry']);
  // Capped: 60 differences are reported as 50.
  const many = JSON.parse(JSON.stringify(main));
  many['no-fill'].calls = main['no-fill'].calls.map(c => `${c}!`).concat(Array.from({ length: 60 }, () => 'x'));
  assert.strictEqual(O.allDiffs(many, main).length, 50);
  assert.deepStrictEqual(O.allDiffs(main, main), []);
});
