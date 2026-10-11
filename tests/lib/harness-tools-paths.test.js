'use strict';

// Which bars files a harness tool may read (scripts/lib/harness-tools/paths.js): regular bars
// files under the bars directory or /tmp/fth, through no symlink, refused without reading them.

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
  fs.writeFileSync(path.join(dir, 'MNQ-3m.json'), '{"bars":[]}');
  fs.writeFileSync(path.join(dir, 'sub', 'a.csv'), 'time,open\n');
  const secret = path.join(base, 'journal.jsonl');
  fs.writeFileSync(secret, 'SECRET-CONTENT\n');
  return { base, dir, secret };
}

test('paths: barsDirs is FTH_BARS_DIR (default <FTH_HOME>/bars) and /tmp/fth', () => {
  assert.deepStrictEqual(barsDirs({ FTH_HOME: '/h' }), ['/h/bars', '/tmp/fth']);
  assert.deepStrictEqual(barsDirs({ FTH_HOME: '/h', FTH_BARS_DIR: '/data/bars' }), ['/data/bars', '/tmp/fth']);
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
    [big, /larger than 50 MB/],
    ['MNQ-3m.json', /not an absolute path/],
    ['-', /not an absolute path/],
    ['', /not a path/],
    [`${dir}/MNQ-3m.json\0`, /not a path/],
    [42, /not a path/],
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
});

test('paths: a directory given by its real form (/private/tmp/fth for /tmp/fth) is the same place', () => {
  const { base, dir } = setup();
  // A directory reached through a symlinked parent is checked from the directory down.
  const alias = path.join(fs.realpathSync(tmpDir()), 'alias');
  fs.symlinkSync(base, alias);
  const viaAlias = path.join(alias, 'bars');
  assert.deepStrictEqual(barsFile(path.join(dir, 'MNQ-3m.json'), { dirs: [viaAlias] }), { file: path.join(viaAlias, 'MNQ-3m.json') });
  assert.deepStrictEqual(barsFile(path.join(viaAlias, 'MNQ-3m.json'), { dirs: [viaAlias] }), { file: path.join(viaAlias, 'MNQ-3m.json') });
});
