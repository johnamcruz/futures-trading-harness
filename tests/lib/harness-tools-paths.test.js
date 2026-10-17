'use strict';

// Which bars files a harness tool may read (scripts/lib/harness-tools/paths.js): regular bars
// files under the bars directory or the home's bars scratch directory, through no symlink, refused without reading them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const { barsFile, barsDirs, MAX_BYTES } = require('../../scripts/lib/harness-tools/paths');

function setup() {
  const base = fs.realpathSync(tmpDir());
  const dir = path.join(base, 'bars');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.chmodSync(dir, 0o755); // whatever the umask
  fs.chmodSync(path.join(dir, 'sub'), 0o755);
  fs.writeFileSync(path.join(dir, 'MNQ-3m.json'), '{"bars":[]}');
  fs.writeFileSync(path.join(dir, 'sub', 'a.csv'), 'time,open\n');
  const secret = path.join(base, 'journal.jsonl');
  fs.writeFileSync(secret, 'SECRET-CONTENT\n');
  return { base, dir, secret };
}

test('paths: barsDirs is FTH_BARS_DIR (default <FTH_HOME>/bars) and <FTH_HOME>/bars-scratch, never /tmp/fth', () => {
  assert.deepStrictEqual(barsDirs({ FTH_HOME: '/h' }), ['/h/bars', '/h/bars-scratch']);
  assert.deepStrictEqual(barsDirs({ FTH_HOME: '/h', FTH_BARS_DIR: '/data/bars' }), ['/data/bars', '/h/bars-scratch']);
});

test('paths: a bars_fetch file is read from its own home only; /tmp/fth is refused', async () => {
  const { fetchBarsToFile } = require('../../scripts/lib/bars-fetch');
  const client = {
    activeContract: async s => ({ id: s, tickSize: 0.25, tickValue: 0.5 }),
    closedBars: async () => Array.from({ length: 5 }, (_, k) => ({ t: new Date(Date.UTC(2026, 9, 7, 13) + k * 180000).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 3 })),
  };
  const live = fs.realpathSync(tmpDir());
  const replay = fs.realpathSync(tmpDir());
  const { file } = await fetchBarsToFile({ client, symbol: 'MNQ', count: 5, env: { FTH_HOME: live } });
  assert.deepStrictEqual(barsFile(file, { env: { FTH_HOME: live } }), { file });
  assert.match(barsFile(file, { env: { FTH_HOME: replay } }).error, /outside them/, 'another home never reads it');
  assert.match(barsFile(file, { env: { FTH_HOME: replay, FTH_BARS_DIR: path.join(replay, 'bars') } }).error, /outside them/);
  for (const value of ['/tmp/fth/MNQ-3m.json', '/private/tmp/fth/MNQ-3m.json']) assert.match(barsFile(value, { env: { FTH_HOME: live } }).error, /outside them/, value);
  // The path checks hold for the scratch directory: climbing out of it, a link in it, the directory itself a link,
  // or writable by others.
  const scratch = path.join(live, 'bars-scratch');
  fs.writeFileSync(path.join(live, 'journal.json'), '{"secret":1}');
  assert.match(barsFile(path.join(scratch, '..', 'journal.json'), { env: { FTH_HOME: live } }).error, /outside them/);
  fs.symlinkSync(path.join(live, 'journal.json'), path.join(scratch, 'link.json'));
  assert.match(barsFile(path.join(scratch, 'link.json'), { env: { FTH_HOME: live } }).error, /is a symlink/);
  fs.chmodSync(scratch, 0o777);
  assert.match(barsFile(file, { env: { FTH_HOME: live } }).error, /writable by other users/);
  fs.chmodSync(scratch, 0o700);
  fs.renameSync(scratch, path.join(live, 'moved'));
  fs.symlinkSync(path.join(live, 'moved'), scratch);
  assert.match(barsFile(file, { env: { FTH_HOME: live } }).error, /bars-scratch is a symlink/);
});

test('paths: a regular bars file under a bars directory is allowed', () => {
  const { dir } = setup();
  const dirs = [dir];
  assert.deepStrictEqual(barsFile(path.join(dir, 'MNQ-3m.json'), { dirs }), { file: path.join(dir, 'MNQ-3m.json') });
  assert.deepStrictEqual(barsFile(path.join(dir, 'sub', 'a.csv'), { dirs }), { file: path.join(dir, 'sub', 'a.csv') });
  assert.deepStrictEqual(barsFile(path.join(dir, 'sub', '..', 'MNQ-3m.json'), { dirs }), { file: path.join(dir, 'MNQ-3m.json') });
});

test('paths: everything else is refused, and no refusal carries the file content', () => {
  const { base, dir, secret } = setup();
  const dirs = [dir];
  fs.symlinkSync(secret, path.join(dir, 'link.json'));
  fs.linkSync(secret, path.join(dir, 'hard.json'));
  fs.mkdirSync(path.join(dir, 'folder.json'));
  fs.symlinkSync(base, path.join(dir, 'up'));
  fs.writeFileSync(path.join(base, 'outside.json'), 'SECRET-CONTENT');
  const big = path.join(dir, 'big.csv');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, MAX_BYTES + 1);
  const cases = [
    [path.join(dir, '..', 'outside.json'), /outside them/],
    [`${dir}/../outside.json`, /outside them/],
    [secret, /not a bars file type/],
    [path.join(dir, 'link.json'), /is a symlink/],
    [path.join(dir, 'hard.json'), /more than one hard link/],
    [path.join(dir, 'folder.json'), /not a regular file/],
    [path.join(dir, 'up', 'outside.json'), /up is a symlink/],
    [path.join(dir, 'missing.json'), /no such file/],
    [path.join(dir, 'MNQ-3m.txt'), /not a bars file type/],
    // Parquet and Excel are the user's (their readers trust the file): never through the tools.
    [path.join(dir, 'MNQ-3m.parquet'), /not a bars file type/],
    [path.join(dir, 'MNQ-3m.xlsx'), /not a bars file type/],
    [path.join(dir, 'MNQ-3m.xls'), /not a bars file type/],
    [path.join(dir, 'MNQ-3m.pq'), /not a bars file type/],
    [big, /larger than 50 MB/],
    ['MNQ-3m.json', /not an absolute path/],
    ['-', /not an absolute path/],
    ['', /not a path/],
    [`${dir}/MNQ-3m.json\0`, /not a path/],
    [42, /not a path/],
    [path.join(dir, `${'n'.repeat(300)}.json`), /ENAMETOOLONG/],
  ];
  for (const [value, why] of cases) {
    const r = barsFile(value, { dirs });
    assert.ok(r.error, `${value} refused`);
    assert.match(r.error, why, String(value));
    assert.doesNotMatch(r.error, /SECRET-CONTENT/);
  }
});

test('paths: the bars directory itself a symlink, missing, or another user\'s is refused', () => {
  const { base, dir } = setup();
  const linked = path.join(base, 'fth');
  fs.symlinkSync(dir, linked);
  assert.match(barsFile(path.join(linked, 'MNQ-3m.json'), { dirs: [linked] }).error, /fth is a symlink/);
  assert.match(barsFile(path.join(base, 'none', 'a.json'), { dirs: [path.join(base, 'none')] }).error, /does not exist/);
  assert.match(barsFile(path.join(dir, 'MNQ-3m.json'), { dirs: [dir], uid: 123456 }).error, /belongs to another user/);
  fs.chmodSync(dir, 0o777);
  assert.match(barsFile(path.join(dir, 'MNQ-3m.json'), { dirs: [dir] }).error, /is writable by other users/);
  fs.chmodSync(dir, 0o775);
  assert.match(barsFile(path.join(dir, 'MNQ-3m.json'), { dirs: [dir] }).error, /is writable by other users/);
  fs.chmodSync(dir, 0o755);
  assert.ok(barsFile(path.join(dir, 'MNQ-3m.json'), { dirs: [dir] }).file);
  fs.chmodSync(path.join(dir, 'sub'), 0o777);
  assert.match(barsFile(path.join(dir, 'sub', 'a.csv'), { dirs: [dir] }).error, /sub is writable by other users/, 'every directory on the way');
  fs.chmodSync(path.join(dir, 'sub'), 0o755);
  assert.ok(barsFile(path.join(dir, 'sub', 'a.csv'), { dirs: [dir] }).file);
});

test('paths: a directory given by its real form (/private/tmp/x for /tmp/x) is the same place', () => {
  const { base, dir } = setup();
  // A directory reached through a symlinked parent is checked from the directory down.
  const alias = path.join(fs.realpathSync(tmpDir()), 'alias');
  fs.symlinkSync(base, alias);
  const viaAlias = path.join(alias, 'bars');
  assert.deepStrictEqual(barsFile(path.join(dir, 'MNQ-3m.json'), { dirs: [viaAlias] }), { file: path.join(viaAlias, 'MNQ-3m.json') });
  assert.deepStrictEqual(barsFile(path.join(viaAlias, 'MNQ-3m.json'), { dirs: [viaAlias] }), { file: path.join(viaAlias, 'MNQ-3m.json') });
});

test('paths: a shortened or relative path whose file name is in a bars directory names that file (the dir it names first); none, no hint; a link is never named', () => {
  const { base, dir } = setup();
  const scratch = path.join(base, 'bars-scratch');
  fs.mkdirSync(scratch, { mode: 0o755 });
  fs.chmodSync(scratch, 0o755);
  fs.writeFileSync(path.join(scratch, 'MNQ-3m.json'), '{"bars":[]}');
  fs.writeFileSync(path.join(scratch, 'MNQ-15m.json'), '{"bars":[]}');
  const dirs = [dir, scratch];
  // The PPC run's shortened path: the scratch copy, the directory its path names.
  const short = barsFile('/workspace/bars-scratch/MNQ-3m.json', { dirs });
  assert.match(short.error, new RegExp(`outside them: /workspace/bars-scratch/MNQ-3m\\.json\\); that file is ${path.join(scratch, 'MNQ-3m.json').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: pass that path$`));
  // Naming no directory: the first that holds it; only the scratch holds it: that one.
  assert.match(barsFile('/elsewhere/MNQ-3m.json', { dirs }).error, new RegExp(`that file is ${path.join(dir, 'MNQ-3m.json').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  assert.match(barsFile('MNQ-15m.json', { dirs }).error, /not an absolute path: MNQ-15m\.json\); that file is .*bars-scratch\/MNQ-15m\.json: pass that path$/);
  // No such file anywhere, or not a bars file type: the refusal as before, no hint.
  assert.doesNotMatch(barsFile('/workspace/bars-scratch/ES-3m.json', { dirs }).error, /that file is/);
  assert.doesNotMatch(barsFile('/workspace/journal.jsonl', { dirs }).error, /that file is/);
  // A symlink of that name is never named.
  fs.symlinkSync(path.join(dir, 'MNQ-3m.json'), path.join(scratch, 'MES-3m.json'));
  assert.doesNotMatch(barsFile('/workspace/bars-scratch/MES-3m.json', { dirs }).error, /that file is/);
});
