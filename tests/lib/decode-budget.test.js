'use strict';

// A bars file's decoding is bounded (scripts/lib/backtest/decode-budget.js): a small .xlsx or
// .parquet that inflates to gigabytes (a decompression bomb) is refused, with bounded memory and
// no content in the error.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const { createBudget, MAX_DECOMPRESSED_BYTES } = require('../../scripts/lib/backtest/decode-budget');
const { readXlsx, unzip } = require('../../scripts/lib/backtest/xlsx');
const { readParquet, decompress, snappy, deltaBinary, rleHybrid } = require('../../scripts/lib/backtest/parquet');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'tests', 'fixtures', 'data');
const MB = 1024 * 1024;

/** A zip whose `entries` directory records all point at one deflated stream of `bytes` zeros. */
function bombZip(bytes, entries = 1) {
  const data = zlib.deflateRawSync(Buffer.alloc(bytes), { level: 9 });
  const name = i => Buffer.from(`xl/e${i}.xml`);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(name(0).length, 26);
  const head = Buffer.concat([local, name(0), data]);
  const cds = [];
  for (let i = 0; i < entries; i += 1) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(data.length, 20); c.writeUInt16LE(name(i).length, 28); c.writeUInt32LE(0, 42);
    cds.push(c, name(i));
  }
  const cd = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries, 8); end.writeUInt16LE(entries, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(head.length, 16);
  return Buffer.concat([head, cd, end]);
}

test('budget: bytes and values are counted; over either is a refusal that names the limit', () => {
  const b = createBudget({ bytes: 100, values: 10 });
  b.take('x', 60);
  assert.strictEqual(b.left, 40);
  assert.throws(() => b.take('x', 41), /^Error: x: the file decodes to more than 100 bytes \(a decompression bomb, or a file too large to read\): refused$/);
  assert.throws(() => b.take('x', NaN), /refused/);
  b.count('y', 10);
  assert.throws(() => b.count('y', 1), /y: the file decodes to more than 10 values/);
  const out = b.inflate('z', max => { assert.strictEqual(max, 40); return Buffer.alloc(30); });
  assert.strictEqual(out.length, 30);
  assert.strictEqual(b.left, 10);
  assert.throws(() => b.inflate('z', max => zlib.inflateRawSync(zlib.deflateRawSync(Buffer.alloc(1000)), { maxOutputLength: max })), /z: the file decodes to more than/);
  assert.throws(() => b.inflate('z', () => { throw new Error('corrupt'); }), /^Error: corrupt$/, 'other errors pass through');
  assert.strictEqual(MAX_DECOMPRESSED_BYTES, 512 * MB);
});

test('xlsx: entries that inflate past the budget are refused, summed across entries', () => {
  const zip = bombZip(4 * MB, 3);
  assert.ok(zip.length < 64 * 1024);
  assert.strictEqual(Object.keys(unzip(zip, createBudget({ bytes: 13 * MB }))).length, 3, 'under the budget it reads');
  assert.throws(() => unzip(zip, createBudget({ bytes: 10 * MB })), /^Error: xlsx: the file decodes to more than 10 MB/);
  assert.throws(() => unzip(zip, createBudget({ bytes: 3 * MB })), /xlsx: the file decodes to more than 3 MB/, 'one entry alone');
  const file = path.join(tmpDir(), 'bomb.xlsx');
  fs.writeFileSync(file, zip);
  assert.throws(() => readXlsx(file, { budget: createBudget({ bytes: MB }) }), /xlsx: the file decodes to more than 1 MB/);
  assert.ok(readXlsx(path.join(DATA, 'bars.xlsx')).rows.length > 300, 'a real workbook reads under the default budget');
});

test('parquet: every codec counts against the budget, and a claimed page size is checked before it is allocated', () => {
  const big = Buffer.alloc(4 * MB);
  const small = () => createBudget({ bytes: MB });
  assert.throws(() => decompress(2, zlib.gzipSync(big), big.length, small()), /parquet: the file decodes to more than 1 MB/);
  assert.throws(() => decompress(4, zlib.brotliCompressSync(big), big.length, small()), /parquet: the file decodes to more than 1 MB/);
  if (typeof zlib.zstdDecompressSync === 'function') {
    assert.throws(() => decompress(6, zlib.zstdCompressSync(big), big.length, small()), /parquet: the file decodes to more than 1 MB/);
  }
  assert.throws(() => decompress(7, Buffer.alloc(0), 2 ** 31, small()), /parquet: the file decodes to more than 1 MB/, 'LZ4: the claimed size, before allocating it');
  // Snappy: a header that claims 4 GB.
  assert.throws(() => snappy(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x10]), undefined, small()), /parquet: the file decodes to more than 1 MB/);
  assert.strictEqual(decompress(2, zlib.gzipSync(Buffer.from('ok')), 2, small()).toString(), 'ok');
  // Wired through readParquet: a real file over a tiny budget is refused (bytes, or values for an uncompressed one).
  for (const f of ['pyarrow-gzip-v2-plain.parquet', 'pyarrow-snappy.parquet', 'pyarrow-brotli.parquet', 'pyarrow-lz4.parquet']) {
    assert.throws(() => readParquet(path.join(DATA, f), { budget: createBudget({ bytes: 64 }) }), /parquet: the file decodes to more than/, f);
  }
  assert.throws(() => readParquet(path.join(DATA, 'pyarrow-none-small-pages.parquet'), { budget: createBudget({ values: 10 }) }), /parquet: the file decodes to more than 10 values/);
  // Version-2 data pages count their values too.
  assert.throws(() => readParquet(path.join(DATA, 'pyarrow-gzip-v2-plain.parquet'), { budget: createBudget({ values: 10 }) }), /parquet: the file decodes to more than 10 values/);
});

test('a real-size bomb (a small .xlsx that inflates past 512 MB) is refused by the snapshot with bounded memory', { timeout: 120000 }, () => {
  const dir = tmpDir();
  const file = path.join(dir, 'bomb.xlsx');
  fs.writeFileSync(file, bombZip(200 * MB, 3)); // 600 MB of zeros from a few hundred KB
  assert.ok(fs.statSync(file).size < 2 * MB);
  const probe = `
    const { loadBars } = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'backtest', 'data.js'))});
    let msg = '';
    try { loadBars(${JSON.stringify(file)}); } catch (err) { msg = err.message; }
    process.stdout.write(JSON.stringify({ msg, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));`;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 110000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const { msg, maxRssMb } = JSON.parse(r.stdout);
  assert.match(msg, /^xlsx: the file decodes to more than 512 MB \(a decompression bomb, or a file too large to read\): refused$/);
  assert.ok(maxRssMb < 1400, `memory stayed bounded (${maxRssMb} MB)`);
});

// Small hostile files (tests/fixtures/hostile): each would hang, or take gigabytes, without the checks.
//   xfd.xlsx, xfd2.xlsx  thousands of rows with one cell at column XFD (16,384 cells a row)
//   farcol.xlsx          one cell at column AAAAAAA
//   delta.parquet        a DELTA_BINARY_PACKED page claiming 30M values in a 1-value page
//   deltahang.parquet    a delta block size of 2^50
//   negloop.parquet      a page header with a negative size (the reader looped on it)
//   rle.parquet          a bit-packed run of billions of groups
//   many.parquet         a dictionary page and one RLE run of 49M values
const HOSTILE = path.join(ROOT, 'tests', 'fixtures', 'hostile');
test('hostile bars files are refused fast, with bounded memory and no content in the error', { timeout: 120000 }, () => {
  const expect = {
    'xfd.xlsx': /^xlsx: the file decodes to more than 10000000 values/,
    'xfd2.xlsx': /^xlsx: the file decodes to more than 10000000 values/,
    'farcol.xlsx': /^xlsx: a cell past column XFD/,
    'delta.parquet': /^parquet: a (malformed delta encoding header|delta encoding with more values than its page)$/,
    'deltahang.parquet': /^parquet: a malformed delta encoding header$/,
    'negloop.parquet': /^parquet: a page (with a negative size|outside the file)$/,
    'rle.parquet': /^parquet: truncated level or index data$/,
    'many.parquet': /^parquet: the file decodes to more than 10000000 values/,
  };
  assert.deepStrictEqual(Object.keys(expect).sort(), fs.readdirSync(HOSTILE).sort());
  for (const [f, why] of Object.entries(expect)) {
    const probe = `
      const { loadBars } = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'backtest', 'data.js'))});
      const t = Date.now();
      let msg = '';
      try { loadBars(${JSON.stringify(path.join(HOSTILE, f))}); } catch (err) { msg = err.message; }
      process.stdout.write(JSON.stringify({ msg, ms: Date.now() - t, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));`;
    const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 0, `${f}: ${r.signal || r.stderr}`);
    const { msg, ms, maxRssMb } = JSON.parse(r.stdout);
    assert.match(msg, why, f);
    assert.ok(ms < 10000, `${f}: refused in ${ms} ms`);
    assert.ok(maxRssMb < 1200, `${f}: ${maxRssMb} MB`);
  }
});

test('parquet decoders: a delta page claiming more values than its page, an absurd block, a bit width over 32, a run past the data', () => {
  const varint = n => { const out = []; let v = n; while (v >= 128) { out.push((v % 128) | 128); v = Math.floor(v / 128); } out.push(v); return out; };
  const header = (block, minis, total) => Buffer.from([...varint(block), ...varint(minis), ...varint(total), 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => deltaBinary(header(128, 4, 30000000), 0, 1), /^Error: parquet: a delta encoding with more values than its page$/);
  assert.throws(() => deltaBinary(header(2 ** 50, 4, 2), 0, 2), /malformed delta encoding header/);
  assert.throws(() => deltaBinary(header(128, 3, 2), 0, 2), /malformed delta encoding header/, 'miniblocks of a multiple of 32 values');
  assert.deepStrictEqual(deltaBinary(header(128, 4, 1), 0, 1).values, [0n], 'a well-formed one reads');
  assert.throws(() => rleHybrid(Buffer.from([3, 0]), 0, 2, 255, 1), /a bit width over 32/);
  const t = Date.now();
  assert.throws(() => rleHybrid(Buffer.from([...varint(2 ** 31 + 1), 0]), 0, 6, 1, 1), /truncated level or index data/, 'billions of groups in a few bytes');
  assert.ok(Date.now() - t < 1000);
  assert.deepStrictEqual(rleHybrid(Buffer.from([3, 0b101]), 0, 2, 1, 3), [1, 0, 1], 'only the values wanted');
});
