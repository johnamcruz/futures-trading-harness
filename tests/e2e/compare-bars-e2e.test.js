'use strict';

/**
 * End to end: `compare-bars.js` on two fixture bar files carrying a neutral nested field (ext.deep.score,
 * ext.deep.flag, ext.list) with known differences: one bar only in each, one bar whose close differs (left
 * out), a value off by 0.5, a null, a flipped boolean. The Markdown, the JSON (--out), and the exit codes
 * (0 pass, 1 below --fail-below, 2 usage). Then a broker source: the tests' fake broker serving file A,
 * fetched through the broker adapter (and the contract translator), compares identical to the file.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { FAKE_BROKERS, tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'compare-bars.js');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'compare-bars');
const A = path.join(FIX, 'a.jsonl');
const B = path.join(FIX, 'b.json');
const FAKE_SERVER = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');

function run(args, extraEnv = {}) {
  const home = tmpDir();
  const env = { PATH: process.env.PATH, HOME: home, FTH_HOME: home, ...extraEnv };
  return { home, ...spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 }) };
}

test('two files: alignment, every leaf field, the known differences, Markdown and JSON, exit 1 below thresholds', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'sub', 'report.json');
  const r = run(['--a', A, '--b', B, '--fail-below', 'corr=0.95,within=0.99', '--by', 'hour', '--out', out]);
  assert.strictEqual(r.status, 1, r.stderr);
  const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(fs.readFileSync(out.replace(/\.json$/, '.md'), 'utf8'), r.stdout);
  assert.deepStrictEqual(
    [rep.bars.a, rep.bars.b, rep.bars.compared, rep.bars.onlyA, rep.bars.onlyB, rep.bars.mismatched],
    [6, 6, 4, 1, 1, 1],
  );
  assert.deepStrictEqual(rep.bars.examples.mismatched, [{ t: '2024-06-03T13:33:00.000Z', contract: null, diffs: { c: [103.5, 999] } }]);
  const by = Object.fromEntries(rep.fields.map(s => [s.field, s]));
  assert.deepStrictEqual(Object.keys(by), ['ext.deep.flag', 'ext.deep.score', 'ext.list.0', 'ext.list.1']);
  const score = by['ext.deep.score'];
  assert.deepStrictEqual([score.coverage.a, score.coverage.b, score.n, score.maxAbs, score.within, score.sign], [1, 0.75, 3, 0.5, 2 / 3, 1]);
  assert.deepStrictEqual(score.worst, [{ t: '2024-06-03T13:31:00.000Z', a: 2, b: 2.5, diff: 0.5 }]);
  const flag = by['ext.deep.flag'];
  assert.deepStrictEqual([flag.n, flag.within, flag.sign], [4, 0.75, 2 / 3]);
  assert.ok(Math.abs(flag.corr - 0.5 / Math.sqrt(0.75)) < 1e-9, String(flag.corr));
  assert.deepStrictEqual([by['ext.list.0'].corr, by['ext.list.1'].corr, by['ext.list.1'].within], [1, null, 1]);
  assert.deepStrictEqual(rep.failures, ['ext.deep.flag: corr 0.57735 < 0.95, within 0.75 < 0.99', 'ext.deep.score: within 0.666667 < 0.99']);
  assert.deepStrictEqual(Object.keys(score.byHour), ['9']);
  assert.match(r.stdout, /Verdict: FAIL/);
  assert.match(r.stdout, /\| `ext\.deep\.score` \| 100% \| 75% \| 3 \| 0\.166667 \| 0\.5 \| 66\.666% \|/);
  assert.match(r.stdout, /- 2024-06-03T13:33:00\.000Z: c 103\.5 vs 999/);
});

test('exit 0: thresholds met (a constant field passes corr where its values agree), tolerance, look-back, prefix', () => {
  const ok = run(['--a', A, '--b', B, '--fields', 'ext.list.0,ext.list.1', '--fail-below', 'corr=0.99,within=1,sign=1,coverage=1']);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Verdict: pass/);
  const tol = run(['--a', A, '--b', B, '--fields', 'ext.deep.score', '--tol', '0.5', '--fail-below', 'within=1']);
  assert.strictEqual(tol.status, 0, tol.stdout);
  const rtol = run(['--a', A, '--b', B, '--fields', 'ext.deep.score', '--rtol', '0.2', '--fail-below', 'within=1']);
  assert.strictEqual(rtol.status, 0, rtol.stdout);
  const back = run(['--a', A, '--b', B, '--fields', 'ext.deep.score[1]', '--fail-below', 'within=1']);
  assert.strictEqual(back.status, 1, 'B\'s previous bar of 13:34 is its mismatched 13:33 bar (99 vs 3)');
  assert.match(back.stdout, /\| 2024-06-03T13:34:00\.000Z \| 3 \| 99 \| 96 \|/);
  const prefix = run(['--a', A, '--b', B, '--prefix', 'ext.list']);
  assert.strictEqual(prefix.status, 0);
  assert.ok(!prefix.stdout.includes('ext.deep'), prefix.stdout);
  const bars = run(['--a', A, '--b', B, '--fields', 'ext.list.0', '--fail-below', 'bars=0.6']);
  assert.strictEqual(bars.status, 1, '4 of 7 bar times are in both with equal prices');
  assert.strictEqual(run(['--a', A, '--b', A, '--fail-below', 'corr=1,within=1,sign=1,coverage=1,bars=1']).status, 0);
});

test('exit 2 on a usage error, 3 when a source cannot be read', () => {
  for (const args of [[], ['--a', A], ['--a', A, '--b', B, '--bogus', 'x'], ['--a', A, '--b', B, '--fail-below', 'corr'], ['--a', A, '--b', 'broker:fake']]) {
    const r = run(args);
    assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^\[compare-bars\] /);
  }
  const missing = run(['--a', A, '--b', path.join(FIX, 'none.jsonl')]);
  assert.strictEqual(missing.status, 3, missing.stderr);
});

test('a broker source: fetched through the broker adapter, the same bars as the file it served', () => {
  const home = tmpDir();
  const args = path.join(home, 'args.jsonl');
  const served = path.join(home, 'served.json');
  fs.writeFileSync(served, JSON.stringify(fs.readFileSync(A, 'utf8').trim().split('\n').map(l => JSON.parse(l))));
  const r = run(['--a', 'broker:fake', '--b', A, '--contract', 'MNQ', '--from', '2024-06-03T13:00:00Z', '--to', '2024-06-03T14:00:00Z',
    '--fail-below', 'corr=1,within=1,sign=1,coverage=1,bars=1'], {
    FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_ENTRY: FAKE_SERVER, FAKE_BARS: served, FAKE_BARS_FROM_START: '1', FAKE_ARGS: args,
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /- A: broker fake: MNQ 1 from 2024-06-03T13:00:00Z to 2024-06-03T14:00:00Z/);
  assert.match(r.stdout, /Bars: A 6, B 6; compared 6/);
  const calls = fs.readFileSync(args, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(c => c.name === 'get_bars');
  assert.ok(calls.length >= 1 && calls.every(c => c.args.unit === 'minute' && c.args.unitNumber === 1), JSON.stringify(calls));
});

test('--from/--to cut a file source; an unwritable --out exits 3', () => {
  const cut = run(['--a', A, '--b', B, '--from', '2024-06-03T13:30:00Z', '--to', '2024-06-03T13:34:00Z', '--fields', 'ext.list.0', '--fail-below', 'bars=0.8']);
  assert.strictEqual(cut.status, 0, cut.stdout);
  assert.match(cut.stdout, /Bars: A 5, B 5; compared 4[^;]*; only in A 0; only in B 0; prices differ 1/);
  const bad = run(['--a', A, '--b', B, '--out', path.join(A, 'x.json')]);
  assert.strictEqual(bad.status, 3, bad.stderr);
});
