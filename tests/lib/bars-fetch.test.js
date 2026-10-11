'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fetchBarsToFile, requestErrors, defaultOut, outError, OUT_DIR } = require('../../scripts/lib/bars-fetch');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

function fakeClient(n = 50) {
  const calls = [];
  return {
    calls,
    async activeContract(symbol) { calls.push(['contract', symbol]); return { id: symbol, tickSize: 0.25, tickValue: 0.5 }; },
    async closedBars(id, opts) {
      calls.push(['bars', id, opts.minutes, opts.limit, opts.daily]);
      return Array.from({ length: n }, (_, k) => ({ t: new Date(Date.UTC(2026, 9, 7, 13) + k * 180000).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 3 })).reverse();
    },
  };
}

test('fetchBarsToFile writes get_bars JSON oldest first, and says when the last bar closed', async () => {
  const outDir = tmpDir();
  const out = path.join(outDir, 'sub', 'MNQ-3m.json');
  const client = fakeClient();
  const r = await fetchBarsToFile({ client, symbol: 'MNQ', timeframe: 3, count: 50, out, outDir });
  assert.deepStrictEqual(client.calls[1], ['bars', 'MNQ', 3, 50, false]);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual([j.contractId, j.barSize, j.count], ['MNQ', '3 minute', 50]);
  assert.ok(Date.parse(j.bars[0].t) < Date.parse(j.bars[49].t), 'oldest first');
  assert.strictEqual(r.closedAt, new Date(Date.parse(r.last) + 180000).toISOString());
  const daily = await fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', daily: true, count: 60, out: path.join(outDir, 'd.json'), outDir });
  assert.strictEqual(JSON.parse(fs.readFileSync(daily.file, 'utf8')).barSize, '1 day');
  await assert.rejects(fetchBarsToFile({ client: fakeClient(2), symbol: 'MNQ', count: 50, out: path.join(outDir, 'x.json'), outDir }), /only 2 closed bars/);
  assert.deepStrictEqual(fs.readdirSync(outDir).sort(), ['d.json', 'sub'], 'no temp file left behind');
});

test('request checks and default paths', () => {
  assert.deepStrictEqual(requestErrors({ symbol: 'MNQ', timeframe: 3, count: 2000 }), []);
  assert.match(requestErrors({ symbol: 'mnq!', timeframe: 0, count: 1 }).join(), /--symbol.*--timeframe.*--count/);
  assert.strictEqual(defaultOut('MNQ', 3, false), '/tmp/fth/MNQ-3m.json');
  assert.strictEqual(defaultOut('MNQ', 3, true), '/tmp/fth/MNQ-1d.json');
});

test('bars files go only to a .json file under the bars directory, through no symlink', async () => {
  const outDir = tmpDir();
  const elsewhere = tmpDir();
  assert.strictEqual(OUT_DIR, '/tmp/fth');
  assert.strictEqual(outError(path.join(outDir, 'MNQ-3m.json'), outDir), null);
  assert.strictEqual(outError(path.join(outDir, 'a', 'b', 'c.json'), outDir), null, 'subdirectories that do not exist yet');
  fs.writeFileSync(path.join(outDir, 'old.json'), '{}');
  assert.strictEqual(outError(path.join(outDir, 'old.json'), outDir), null, 'an existing bars file is replaced');
  // Outside, climbing out, the directory itself, a sibling, not .json, the journal, settings.
  for (const bad of [path.join(elsewhere, 'x.json'), path.join(outDir, '..', 'x.json'), outDir, `${outDir}.json`, `${outDir}x/y.json`,
    path.join(outDir, 'x.txt'), path.join(outDir, 'journal.jsonl'), path.join(outDir, '.env'), '/home/u/.futures-trading-harness/journal.json', path.join(elsewhere, 'settings.json')]) {
    assert.match(outError(bad, outDir), /^--out: a \.json file under /, bad);
  }
  // A symlinked file, a symlinked subdirectory, a dangling link, a directory or a file in the way.
  fs.symlinkSync(path.join(elsewhere, 'target.json'), path.join(outDir, 'link.json'));
  fs.symlinkSync(elsewhere, path.join(outDir, 'dirlink'));
  fs.symlinkSync(path.join(elsewhere, 'missing.json'), path.join(outDir, 'dangling.json'));
  fs.mkdirSync(path.join(outDir, 'dir.json'));
  for (const bad of ['link.json', 'dangling.json', path.join('dirlink', 'x.json'), path.join('dirlink', 'sub', 'x.json'), 'dir.json', path.join('old.json', 'x.json')]) {
    assert.match(outError(path.join(outDir, bad), outDir), /--out/, bad);
  }
  // The directory itself a link (a /tmp/fth someone pointed at the harness state): refused, default names included.
  const linkedDir = path.join(tmpDir(), 'fth');
  fs.symlinkSync(elsewhere, linkedDir);
  assert.match(outError(path.join(linkedDir, 'MNQ-3m.json'), linkedDir), /is a symlink/);
  await assert.rejects(fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', count: 50, outDir: linkedDir, out: null }), /--out/);
  assert.deepStrictEqual(fs.readdirSync(elsewhere).sort(), [], 'nothing written through the link');
  // A bars directory that belongs to another user (root's /) is refused.
  if (typeof process.getuid === 'function' && process.getuid() !== 0) assert.match(outError('/x.json', '/'), /belongs to another user/);
  // Refused before the broker is asked, and nothing written.
  const client = fakeClient();
  const journal = path.join(elsewhere, 'journal.jsonl');
  fs.writeFileSync(journal, 'keep');
  await assert.rejects(fetchBarsToFile({ client, symbol: 'MNQ', count: 50, out: journal, outDir }), /--out/);
  await assert.rejects(fetchBarsToFile({ client, symbol: 'MNQ', count: 50, out: path.join(outDir, 'link.json'), outDir }), /--out/);
  assert.deepStrictEqual(client.calls, []);
  assert.strictEqual(fs.readFileSync(journal, 'utf8'), 'keep');
});

test('a link planted while the broker answers is refused, and the write never follows one', async () => {
  const outDir = tmpDir();
  const victim = path.join(tmpDir(), 'journal.jsonl');
  fs.writeFileSync(victim, 'keep');
  const out = path.join(outDir, 'MNQ-3m.json');
  // A link at the old fixed temp name is not followed (the temp file is new, created with wx).
  fs.symlinkSync(victim, `${out}.${process.pid}.tmp`);
  await fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', count: 50, out, outDir });
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).count, 50);
  // The target turned into a link during the broker call: checked again just before the write.
  const swap = (fn) => {
    const client = fakeClient();
    const closedBars = client.closedBars;
    client.closedBars = async (...a) => { fn(); return closedBars(...a); };
    return client;
  };
  await assert.rejects(fetchBarsToFile({ client: swap(() => { fs.rmSync(out); fs.symlinkSync(victim, out); }), symbol: 'MNQ', count: 50, out, outDir }), /--out/);
  // A subdirectory turned into a link to elsewhere during the call.
  const sub = path.join(outDir, 'sub');
  const elsewhere = tmpDir();
  await assert.rejects(fetchBarsToFile({ client: swap(() => fs.symlinkSync(elsewhere, sub)), symbol: 'MNQ', count: 50, out: path.join(sub, 'x.json'), outDir }), /--out/);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
});

test('scripts/bars.js refuses an --out outside /tmp/fth before asking the broker', () => {
  const home = tmpDir();
  const calls = path.join(home, 'calls.txt');
  const FAKE = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, FAKE] } } }));
  const env = { PATH: process.env.PATH, HOME: home, FTH_HOME: home, FAKE_CALLS: calls, FTH_ENV_FILE: path.join(home, 'none.env') };
  const run = args => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bars.js'), '--symbol', 'MNQ', '--timeframe', '1', '--count', '10', ...args], { encoding: 'utf8', env });
  const target = path.join(home, 'journal.jsonl');
  for (const out of [target, path.join(home, 'settings.json'), '/tmp/fth/x.txt', '/tmp/fth/../x.json']) {
    const r = run(['--out', out]);
    assert.strictEqual(r.status, 1, out);
    assert.match(r.stderr, /\[bars\] --out: a \.json file under \/tmp\/fth\//, out);
    assert.strictEqual(r.stdout, '');
  }
  assert.ok(!fs.existsSync(target));
  const asked = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  assert.ok(!/get_bars/.test(asked), `the broker was asked for bars: ${asked}`);
  const ok = run(['--out', `/tmp/fth/bars-fetch-${process.pid}.json`]);
  assert.strictEqual(ok.status, 0, ok.stderr);
  fs.rmSync(`/tmp/fth/bars-fetch-${process.pid}.json`, { force: true });
});

test('scripts/bars.js refuses unknown flags and --record in autonomous runs', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bars.js'), ...args], { encoding: 'utf8', env: { ...process.env, FTH_HOME: tmpDir(), ...env } });
  const bad = run(['--symbol', 'MNQ', '--bogus']);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown argument: --bogus/);
  const auto = run(['--symbol', 'MNQ', '--record'], { FTH_AUTONOMOUS: '1' });
  assert.match(auto.stderr, /the autonomous runner records the read itself/);
});
