'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fetchBarsToFile, requestErrors, defaultOut, outError, scratchDir } = require('../../scripts/lib/bars-fetch');
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
  assert.strictEqual(defaultOut('MNQ', 3, false, '/h/bars-scratch'), '/h/bars-scratch/MNQ-3m.json');
  assert.strictEqual(defaultOut('MNQ', 3, true, '/h/bars-scratch'), '/h/bars-scratch/MNQ-1d.json');
  assert.strictEqual(defaultOut('MNQ', 15, false, '/h/bars-scratch', 'trend'), '/h/bars-scratch/MNQ-15m-trend.json');
  for (const name of ['../x', 'a/b', 'Trend', '', 'x'.repeat(25)]) assert.match(requestErrors({ symbol: 'MNQ', timeframe: 3, count: 50, name }).join(), /name:/, name);
});

test('the bars scratch directory is the harness home\'s own: <FTH_HOME>/bars-scratch, never /tmp/fth', () => {
  assert.strictEqual(scratchDir({ FTH_HOME: '/h' }), '/h/bars-scratch');
  assert.strictEqual(scratchDir({ FTH_HOME: '~/x' }), path.join(require('os').homedir(), 'x', 'bars-scratch'));
  assert.strictEqual(scratchDir({}), path.join(require('os').homedir(), '.futures-trading-harness', 'bars-scratch'));
  assert.notStrictEqual(scratchDir({ FTH_HOME: '/a' }), scratchDir({ FTH_HOME: '/b' }), 'two homes never share one');
});

test('by default the bars go under the caller\'s home, so two homes (the live runner, a replay) never share a file', async () => {
  const live = tmpDir();
  const replay = tmpDir();
  const a = await fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', count: 50, env: { FTH_HOME: live } });
  assert.strictEqual(a.file, path.join(live, 'bars-scratch', 'MNQ-3m.json'));
  assert.strictEqual(fs.statSync(path.join(live, 'bars-scratch')).mode & 0o777, 0o700, 'created private');
  const b = await fetchBarsToFile({ client: fakeClient(10), symbol: 'MNQ', count: 10, env: { FTH_HOME: replay } });
  assert.strictEqual(b.file, path.join(replay, 'bars-scratch', 'MNQ-3m.json'));
  assert.strictEqual(JSON.parse(fs.readFileSync(a.file, 'utf8')).count, 50, 'the other home\'s fetch left it alone');
  const named = await fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', timeframe: 15, count: 50, name: 'trend', env: { FTH_HOME: live } });
  assert.strictEqual(named.file, path.join(live, 'bars-scratch', 'MNQ-15m-trend.json'));
  // Out of the home's scratch directory: /tmp/fth, the other home's, the home itself; refused before the broker is asked.
  for (const out of ['/tmp/fth/MNQ-3m.json', path.join(replay, 'bars-scratch', 'MNQ-3m.json'), path.join(live, 'MNQ-3m.json'), path.join(live, 'bars', 'MNQ-3m.json')]) {
    const client = fakeClient();
    await assert.rejects(fetchBarsToFile({ client, symbol: 'MNQ', count: 50, out, env: { FTH_HOME: live } }), /a \.json file under .*bars-scratch\//, out);
    assert.deepStrictEqual(client.calls, [], out);
  }
  await assert.rejects(fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', count: 50, name: '../x', env: { FTH_HOME: live } }), /name:/);
});

test('bars files go only to a .json file under the bars directory, through no symlink', async () => {
  const outDir = tmpDir();
  const elsewhere = tmpDir();
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
  // A directory others can write to (the scratch directory or one below it): refused, as the bars tools refuse reading from it.
  const open = tmpDir();
  fs.mkdirSync(path.join(open, 'sub'));
  fs.chmodSync(open, 0o777);
  assert.match(outError(path.join(open, 'MNQ-3m.json'), open), /is writable by other users/);
  fs.chmodSync(open, 0o700);
  fs.chmodSync(path.join(open, 'sub'), 0o777);
  assert.match(outError(path.join(open, 'sub', 'MNQ-3m.json'), open), /sub is writable by other users/);
  fs.chmodSync(path.join(open, 'sub'), 0o755);
  assert.strictEqual(outError(path.join(open, 'sub', 'MNQ-3m.json'), open), null);
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

test('a link planted during the broker call is refused before mkdir can create directories through it', async () => {
  const outDir = tmpDir();
  const victim = tmpDir();
  const sub = path.join(outDir, 'sub');
  const client = fakeClient();
  const activeContract = client.activeContract;
  client.activeContract = async s => { fs.symlinkSync(victim, sub); return activeContract(s); };
  await assert.rejects(fetchBarsToFile({ client, symbol: 'MNQ', count: 50, out: path.join(sub, 'a', 'b', 'x.json'), outDir }), /--out/);
  assert.deepStrictEqual(fs.readdirSync(victim), [], 'no directory created outside the bars directory');
});

test('a link planted after mkdir is refused by the check just before the write', async () => {
  const outDir = tmpDir();
  const victim = tmpDir();
  const sub = path.join(outDir, 'sub');
  const mkdirSync = fs.mkdirSync;
  // The directories made, then the bars' directory swapped for a link before the write.
  fs.mkdirSync = (p, o) => {
    const r = mkdirSync(p, o);
    if (path.resolve(p) === sub) { fs.rmdirSync(sub); fs.symlinkSync(victim, sub); }
    return r;
  };
  try {
    await assert.rejects(fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', count: 50, out: path.join(sub, 'x.json'), outDir }), /--out/);
  } finally {
    fs.mkdirSync = mkdirSync;
  }
  assert.deepStrictEqual(fs.readdirSync(victim), [], 'nothing written through the link');
  const made = await fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', count: 50, out: path.join(outDir, 'new', 'x.json'), outDir });
  assert.strictEqual(fs.statSync(path.dirname(made.file)).mode & 0o077, 0, 'new directories are private');
});

test('the real-path check refuses what the symlink walk cannot see, and the temp file is never an existing one', async () => {
  const outDir = tmpDir();
  const file = path.join(outDir, 'x.json');
  fs.writeFileSync(file, '{}');
  // A file whose real path is elsewhere though no link shows on the way (a mount, a filesystem quirk).
  const realpathSync = fs.realpathSync;
  fs.realpathSync = p => (path.resolve(p) === file ? path.join(tmpDir(), 'x.json') : realpathSync(p));
  try {
    assert.match(outError(file, outDir), /real path is outside/);
  } finally {
    fs.realpathSync = realpathSync;
  }
  assert.strictEqual(outError(file, outDir), null);
  // The temp name made predictable and a link planted there: wx refuses it rather than write through.
  const crypto = require('crypto');
  const randomBytes = crypto.randomBytes;
  const victim = path.join(tmpDir(), 'journal.jsonl');
  fs.writeFileSync(victim, 'keep');
  const out = path.join(outDir, 'MNQ-3m.json');
  crypto.randomBytes = n => Buffer.alloc(n);
  try {
    fs.symlinkSync(victim, `${out}.${process.pid}.${'00'.repeat(6)}.tmp`);
    await assert.rejects(fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', count: 50, out, outDir }), /EEXIST/);
  } finally {
    crypto.randomBytes = randomBytes;
  }
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
});

test('a path given under the bars directory\'s real form (/private/tmp/fth on macOS) is the same directory', async () => {
  // The bars directory under a parent that is a link, as /tmp is on macOS.
  const real = tmpDir();
  const parent = path.join(tmpDir(), 'tmp');
  fs.symlinkSync(real, parent);
  const outDir = path.join(parent, 'fth');
  const realDir = path.join(fs.realpathSync(real), 'fth');
  assert.strictEqual(outError(path.join(realDir, 'MNQ-3m.json'), outDir), null);
  assert.strictEqual(outError(path.join(outDir, 'MNQ-3m.json'), outDir), null);
  const r = await fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', count: 50, out: path.join(realDir, 'a', 'MNQ-3m.json'), outDir });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'a', 'MNQ-3m.json'), 'utf8')).count, 50);
  assert.strictEqual(r.count, 50);
  // Every other check still holds under that form.
  fs.symlinkSync(tmpDir(), path.join(realDir, 'link'));
  for (const bad of [path.join(realDir, 'x.txt'), path.join(realDir, 'link', 'x.json'), realDir, path.join(realDir, '..', 'x.json')]) {
    assert.match(outError(bad, outDir), /--out/, bad);
  }
  // A home under the system temp directory (/var/folders -> /private/var/folders on macOS): its scratch directory by either form.
  const home = tmpDir();
  const realHome = fs.realpathSync(home);
  assert.strictEqual(outError(path.join(realHome, 'bars-scratch', 'MNQ-3m.json'), scratchDir({ FTH_HOME: home })), null);
  assert.match(outError(path.join(realHome, 'MNQ-3m.json'), scratchDir({ FTH_HOME: home })), /outside it/);
});

test('scripts/bars.js refuses an --out outside the home\'s bars scratch directory (/tmp/fth included) before asking the broker', () => {
  const home = tmpDir();
  const calls = path.join(home, 'calls.txt');
  const FAKE = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, FAKE] } } }));
  const env = { PATH: process.env.PATH, HOME: home, FTH_HOME: home, FAKE_CALLS: calls, FTH_ENV_FILE: path.join(home, 'none.env') };
  const run = args => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bars.js'), '--symbol', 'MNQ', '--timeframe', '1', '--count', '10', ...args], { encoding: 'utf8', env });
  const target = path.join(home, 'journal.jsonl');
  const scratch = path.join(home, 'bars-scratch');
  for (const out of [target, path.join(home, 'settings.json'), '/tmp/fth/x.json', '/tmp/fth/x.txt', '/tmp/fth/../x.json', path.join(scratch, '..', 'x.json'), path.join(scratch, 'x.txt')]) {
    const r = run(['--out', out]);
    assert.strictEqual(r.status, 1, out);
    assert.ok(r.stderr.includes(`[bars] --out: a .json file under ${scratch}/`), `${out}: ${r.stderr}`);
    assert.strictEqual(r.stdout, '');
  }
  assert.ok(!fs.existsSync(target));
  const asked = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  assert.ok(!/get_bars/.test(asked), `the broker was asked for bars: ${asked}`);
  const ok = run([]);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.ok(ok.stdout.includes(`to ${path.join(scratch, 'MNQ-1m.json')};`), ok.stdout);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(scratch, 'MNQ-1m.json'), 'utf8')).count, 10);
  assert.strictEqual(run(['--out', path.join(scratch, 'sub', 'mine.json')]).status, 0, 'any .json file under it');
});

test('scripts/bars.js refuses unknown flags, and ignores --record (with a note) in autonomous runs', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bars.js'), ...args], { encoding: 'utf8', env: { ...process.env, FTH_HOME: tmpDir(), ...env } });
  const bad = run(['--symbol', 'MNQ', '--bogus']);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown argument: --bogus/);
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js')] } } }));
  const auto = run(['--symbol', 'MNQ', '--timeframe', '1', '--count', '10', '--record'], { FTH_HOME: home, FTH_AUTONOMOUS: '1', FTH_REPLAY_NOW: '', FTH_ENV_FILE: path.join(home, 'none.env') });
  assert.strictEqual(auto.status, 0, auto.stderr);
  assert.match(auto.stdout, /^wrote \d+ 1-minute bars for MNQ /);
  assert.ok(auto.stderr.includes('[bars] note: --record ignored - the autonomous runner records the read itself\n'), auto.stderr);
  assert.ok(!fs.existsSync(path.join(home, 'mtf')), 'nothing recorded');
});
