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
});

test('bars files go only under the bars directory, also through symlinks', async () => {
  const outDir = tmpDir();
  const elsewhere = tmpDir();
  assert.strictEqual(outError(path.join(outDir, 'MNQ-3m.json'), outDir), null);
  assert.strictEqual(outError(path.join(outDir, 'a', 'b.json'), outDir), null);
  // The journal, settings, state, a non-JSON name, the directory itself, and a climb out.
  for (const bad of [path.join(elsewhere, 'journal.jsonl'), path.join(elsewhere, 'settings.json'), path.join(outDir, 'x.txt'),
    path.join(outDir, '..', 'x.json'), `${outDir}.json`]) assert.match(outError(bad, outDir), /--out: a \.json file under/, bad);
  // A symlinked file or directory inside that points out is refused.
  fs.symlinkSync(path.join(elsewhere, 'target.json'), path.join(outDir, 'link.json'));
  fs.symlinkSync(elsewhere, path.join(outDir, 'dirlink'));
  assert.match(outError(path.join(outDir, 'link.json'), outDir), /--out/);
  assert.match(outError(path.join(outDir, 'dirlink', 'x.json'), outDir), /--out/);
  // The directory itself a link (someone's /tmp/fth pointing into the harness state): refused, default name included.
  const linkedDir = path.join(tmpDir(), 'fth');
  fs.symlinkSync(elsewhere, linkedDir);
  assert.match(outError(path.join(linkedDir, 'MNQ-3m.json'), linkedDir), /--out/);
  assert.match(outError(path.join(linkedDir, 'a', 'b.json'), linkedDir), /--out/);
  // Refused before the broker is asked, and nothing is written.
  const client = fakeClient();
  const journal = path.join(elsewhere, 'journal.jsonl');
  fs.writeFileSync(journal, 'keep');
  await assert.rejects(fetchBarsToFile({ client, symbol: 'MNQ', count: 50, out: journal, outDir }), /--out/);
  assert.deepStrictEqual(client.calls, []);
  assert.strictEqual(fs.readFileSync(journal, 'utf8'), 'keep');
  // The default directory is /tmp/fth.
  assert.strictEqual(OUT_DIR, '/tmp/fth');
  assert.match(outError('/home/u/.futures-trading-harness/journal.json'), /under \/tmp\/fth\//);
});

test('a link planted while the broker answers, or at the temp name, is not written through', async () => {
  const outDir = tmpDir();
  const victim = path.join(tmpDir(), 'journal.jsonl');
  fs.writeFileSync(victim, 'keep');
  const out = path.join(outDir, 'MNQ-3m.json');
  // A planted temp-name link is removed, not followed.
  fs.symlinkSync(victim, `${out}.${process.pid}.tmp`);
  await fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', count: 50, out, outDir });
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).count, 50);
  // The target turned into a link during the broker call: checked again, refused.
  const client = fakeClient();
  const closedBars = client.closedBars;
  client.closedBars = async (...a) => { fs.rmSync(out); fs.symlinkSync(victim, out); return closedBars(...a); };
  await assert.rejects(fetchBarsToFile({ client, symbol: 'MNQ', count: 50, out, outDir }), /--out/);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
});

test('request checks and default paths', () => {
  assert.deepStrictEqual(requestErrors({ symbol: 'MNQ', timeframe: 3, count: 2000 }), []);
  assert.match(requestErrors({ symbol: 'mnq!', timeframe: 0, count: 1 }).join(), /--symbol.*--timeframe.*--count/);
  assert.strictEqual(defaultOut('MNQ', 3, false), '/tmp/fth/MNQ-3m.json');
  assert.strictEqual(defaultOut('MNQ', 3, true), '/tmp/fth/MNQ-1d.json');
});

test('scripts/bars.js refuses unknown flags and --record in autonomous runs', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bars.js'), ...args], { encoding: 'utf8', env: { ...process.env, FTH_HOME: tmpDir(), ...env } });
  const bad = run(['--symbol', 'MNQ', '--bogus']);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown argument: --bogus/);
  const auto = run(['--symbol', 'MNQ', '--record'], { FTH_AUTONOMOUS: '1' });
  assert.match(auto.stderr, /the autonomous runner records the read itself/);
});
