'use strict';

// A bars file's decompression is bounded (scripts/lib/backtest/decode-budget.js): a small .xlsx or
// .parquet that inflates to gigabytes is refused, with bounded memory and no content in the error;
// malformed headers are refused; a large real file still loads.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const { createBudget, MAX_DECOMPRESSED_BYTES } = require('../../scripts/lib/backtest/decode-budget');
const { readXlsx, unzip } = require('../../scripts/lib/backtest/xlsx');
const { readParquet, decompress, snappy } = require('../../scripts/lib/backtest/parquet');

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
  assert.throws(() => b.take('x', 41), /^Error: x: the file decompresses to more than 100 bytes, more than the reader takes: refused$/);
  assert.throws(() => b.take('x', NaN), /refused/);
  b.count('y', 10);
  assert.throws(() => b.count('y', 1), /y: the file decodes to more than 10 values/);
  const out = b.inflate('z', max => { assert.strictEqual(max, 40); return Buffer.alloc(30); });
  assert.strictEqual(out.length, 30);
  assert.strictEqual(b.left, 10);
  assert.throws(() => b.inflate('z', max => zlib.inflateRawSync(zlib.deflateRawSync(Buffer.alloc(1000)), { maxOutputLength: max })), /z: the file decompresses to more than/);
  assert.throws(() => b.inflate('z', () => { throw new Error('corrupt'); }), /^Error: corrupt$/, 'other errors pass through');
  assert.strictEqual(MAX_DECOMPRESSED_BYTES, 512 * MB);
  assert.strictEqual(createBudget().count('v', 1e12), undefined, 'no value cap by default: the readers serve the user\'s own files');
});

test('xlsx: entries that inflate past the budget are refused, summed across entries', () => {
  const zip = bombZip(4 * MB, 3);
  assert.ok(zip.length < 64 * 1024);
  assert.strictEqual(Object.keys(unzip(zip, createBudget({ bytes: 13 * MB }))).length, 3, 'under the budget it reads');
  assert.throws(() => unzip(zip, createBudget({ bytes: 10 * MB })), /^Error: xlsx: the file decompresses to more than 10 MB/);
  assert.throws(() => unzip(zip, createBudget({ bytes: 3 * MB })), /xlsx: the file decompresses to more than 3 MB/, 'one entry alone');
  const file = path.join(tmpDir(), 'bomb.xlsx');
  fs.writeFileSync(file, zip);
  assert.throws(() => readXlsx(file, { budget: createBudget({ bytes: MB }) }), /xlsx: the file decompresses to more than 1 MB/);
  assert.ok(readXlsx(path.join(DATA, 'bars.xlsx')).rows.length > 300, 'a real workbook reads under the default budget');
});

test('parquet: every codec counts against the budget, and a claimed page size is checked before it is allocated', () => {
  const big = Buffer.alloc(4 * MB);
  const small = () => createBudget({ bytes: MB });
  assert.throws(() => decompress(2, zlib.gzipSync(big), big.length, small()), /parquet: the file decompresses to more than 1 MB/);
  assert.throws(() => decompress(4, zlib.brotliCompressSync(big), big.length, small()), /parquet: the file decompresses to more than 1 MB/);
  if (typeof zlib.zstdDecompressSync === 'function') {
    assert.throws(() => decompress(6, zlib.zstdCompressSync(big), big.length, small()), /parquet: the file decompresses to more than 1 MB/);
  }
  assert.throws(() => decompress(7, Buffer.alloc(0), 2 ** 31, small()), /parquet: the file decompresses to more than 1 MB/, 'LZ4: the claimed size, before allocating it');
  // Snappy: a header that claims 4 GB.
  assert.throws(() => snappy(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x10]), undefined, small()), /parquet: the file decompresses to more than 1 MB/);
  assert.strictEqual(decompress(2, zlib.gzipSync(Buffer.from('ok')), 2, small()).toString(), 'ok');
  // Wired through readParquet: a real file over a tiny budget is refused (bytes, or values for an uncompressed one).
  for (const f of ['pyarrow-gzip-v2-plain.parquet', 'pyarrow-snappy.parquet', 'pyarrow-brotli.parquet', 'pyarrow-lz4.parquet']) {
    assert.throws(() => readParquet(path.join(DATA, f), { budget: createBudget({ bytes: 64 }) }), /parquet: the file decompresses to more than/, f);
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
  assert.match(msg, /^xlsx: the file decompresses to more than 512 MB, more than the reader takes: refused$/);
  assert.ok(maxRssMb < 1400, `memory stayed bounded (${maxRssMb} MB)`);
});

// Small hostile files (tests/fixtures/hostile): each would hang, crash, or misread without its check.
//   farcol.xlsx          one cell at column AAAAAAA
//   delta.parquet        a DELTA_BINARY_PACKED page claiming 30M values in a 1-value page
//   deltahang.parquet    a delta block size of 2^50
//   negloop.parquet      a page header with a negative size (the reader looped on it)
//   rle.parquet          a bit-packed run of billions of groups
//   negnulls.parquet, v2negnulls.parquet  a version-2 page with a negative null count
//   mapbool.parquet      a metadata map of 2^40 booleans in 21 bytes
//   bss.parquet, bssflba.parquet  BYTE_STREAM_SPLIT with a type length past the page
const HOSTILE = path.join(ROOT, 'tests', 'fixtures', 'hostile');
const parquetWriter = require('../fixtures/parquet-writer');

/** loadBars on a file in a separate process with a deadline: { status, signal, msg, ms, maxRssMb }. */
function loadIsolated(file, timeout = 30000) {
  const probe = `
    const { loadBars } = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'backtest', 'data.js'))});
    const t = Date.now();
    let msg = 'ok';
    let rows = 0;
    try { rows = loadBars(${JSON.stringify(file)}).length; } catch (err) { msg = err.message; }
    process.stdout.write(JSON.stringify({ msg, rows, ms: Date.now() - t, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));`;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout });
  return { status: r.status, signal: r.signal, stderr: r.stderr, ...(r.stdout ? JSON.parse(r.stdout) : {}) };
}

test('hostile bars files are refused fast, with bounded memory and no content in the error', { timeout: 180000 }, () => {
  const dir = tmpDir();
  // Generated ones: a varint of 11 bytes in the footer; an LZ4 page whose literals run past its size.
  fs.writeFileSync(path.join(dir, 'longvarint.parquet'), parquetWriter.rawFooter([0x15, ...Array(11).fill(0x80), 0x01, 0]));
  const expect = {
    'farcol.xlsx': /^xlsx: a cell past column XFD/,
    'delta.parquet': /^parquet: a (malformed delta encoding header|delta encoding with more values than its page)$/,
    'deltahang.parquet': /^parquet: a malformed delta encoding header$/,
    'negloop.parquet': /^parquet: a page (with a negative size|outside the file)$/,
    'rle.parquet': /^parquet: truncated level or index data$/,
    'negnulls.parquet': /^parquet: a page whose null count is out of range$/,
    'v2negnulls.parquet': /^parquet: a page whose null count is out of range$/,
    'mapbool.parquet': /^parquet: a metadata map longer than the file$/,
    'bss.parquet': /^parquet: BYTE_STREAM_SPLIT data past its page$/,
    'bssflba.parquet': /^parquet: BYTE_STREAM_SPLIT data past its page$/,
  };
  assert.deepStrictEqual(Object.keys(expect).sort(), fs.readdirSync(HOSTILE).sort());
  const files = [...Object.keys(expect).map(f => [path.join(HOSTILE, f), expect[f]]), [path.join(dir, 'longvarint.parquet'), /^parquet: a varint longer than 10 bytes$/]];
  for (const [file, why] of files) {
    const r = loadIsolated(file);
    assert.strictEqual(r.status, 0, `${file}: ${r.signal || r.stderr}`);
    assert.match(r.msg, why, file);
    assert.ok(r.ms < 10000, `${file}: refused in ${r.ms} ms`);
    assert.ok(r.maxRssMb < 1200, `${file}: ${r.maxRssMb} MB`);
  }
});

test('a large real-shaped Parquet file (2M one-minute bars, 6 columns, gzip) still loads', { timeout: 300000 }, () => {
  const n = 2000000;
  const t0 = Date.parse('2020-01-01T00:00:00Z');
  const price = i => 10000 + (i % 977) * 0.25;
  const file = path.join(tmpDir(), 'big.parquet');
  fs.writeFileSync(file, parquetWriter.writeParquet({
    columns: [
      { name: 'time', type: 2, convert: 9, values: Array.from({ length: n }, (_, i) => t0 + i * 60000) },
      { name: 'open', type: 5, values: Array.from({ length: n }, (_, i) => price(i)) },
      { name: 'high', type: 5, values: Array.from({ length: n }, (_, i) => price(i) + 1) },
      { name: 'low', type: 5, values: Array.from({ length: n }, (_, i) => price(i) - 1) },
      { name: 'close', type: 5, values: Array.from({ length: n }, (_, i) => price(i) + 0.25) },
      { name: 'volume', type: 5, values: Array.from({ length: n }, (_, i) => 100 + (i % 50)) },
    ],
  }));
  const r = loadIsolated(file, 240000);
  assert.strictEqual(r.status, 0, r.signal || r.stderr);
  assert.strictEqual(r.msg, 'ok');
  assert.strictEqual(r.rows, n);
});

test('parquet: BYTE_STREAM_SPLIT fixed-length values are each their own (not one shared buffer); LZ4 stays inside its page', () => {
  const file = path.join(tmpDir(), 'flba.parquet');
  fs.writeFileSync(file, parquetWriter.writeParquet({ codec: 0, columns: [{ name: 'v', type: 7, typeLength: 2, encoding: 9, values: [[0x41, 0x42], [0x43, 0x44], [0x45, 0x46]] }] }));
  assert.deepStrictEqual(readParquet(file).rows.map(r => r.v), ['AB', 'CD', 'EF']);
  // LZ4 raw: a literal run longer than the page's size, and a match before the start.
  assert.throws(() => decompress(7, Buffer.from([0xf0, 0xff, 0xff, 0x01, ...Array(10).fill(0)]), 8, createBudget()), /^Error: parquet: LZ4 data past its page$/);
  assert.throws(() => decompress(7, Buffer.from([0x10, 0x41, 0x05, 0x00]), 64, createBudget()), /^Error: parquet: LZ4 data past its page$/);
  assert.strictEqual(decompress(7, Buffer.from([0x10, 0x41, 0x01, 0x00]), 5, createBudget()).toString(), 'AAAAA', 'a well-formed one reads');
});

test('parquet decoders: a delta page claiming more values than its page, an absurd block, a bit width over 32, a run past the data', { timeout: 60000 }, () => {
  // In a child with a deadline: a regression that hangs fails here instead of hanging the suite.
  const probe = `
    const assert = require('node:assert');
    const { deltaBinary, rleHybrid } = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'backtest', 'parquet.js'))});
    const varint = n => { const out = []; let v = n; while (v >= 128) { out.push((v % 128) | 128); v = Math.floor(v / 128); } out.push(v); return out; };
    const header = (block, minis, total) => Buffer.from([...varint(block), ...varint(minis), ...varint(total), 0, 0, 0, 0, 0, 0, 0]);
    assert.throws(() => deltaBinary(header(128, 4, 30000000), 0, 1), /^Error: parquet: a delta encoding with more values than its page$/);
    assert.throws(() => deltaBinary(header(2 ** 50, 4, 2), 0, 2), /malformed delta encoding header/);
    assert.throws(() => deltaBinary(header(128, 3, 2), 0, 2), /malformed delta encoding header/);
    assert.deepStrictEqual(deltaBinary(header(128, 4, 1), 0, 1).values, [0n]);
    assert.throws(() => rleHybrid(Buffer.from([3, 0]), 0, 2, 255, 1), /a bit width over 32/);
    assert.throws(() => rleHybrid(Buffer.from([...varint(2 ** 31 + 1), 0]), 0, 6, 1, 1), /truncated level or index data/);
    assert.deepStrictEqual(rleHybrid(Buffer.from([3, 0b101]), 0, 2, 1, 3), [1, 0, 1]);
    process.stdout.write('ok');`;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.signal, null, 'no hang');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'ok');
});

test('JSON and CSV (what the agents\' tools read): shapes no bars file has are refused before parsing, with bounded time and memory', { timeout: 240000 }, () => {
  const dir = tmpDir();
  const MB45 = 45 * MB;
  const files = {
    'deep.json': ['['.repeat(MB45), /JSON nested deeper than 32 levels/],
    'values.json': [`[${'0,'.repeat(MB45 / 2)}0]`, /more JSON values than a bars file of its size holds/],
    'objects.json': [`[${'{},'.repeat(MB45 / 3)}{}]`, /more JSON values than a bars file of its size holds/],
    'lines.csv': [`time,open,high,low,close\n${'1\n'.repeat(MB45 / 2)}`, /csv: more lines than a bars file of its size holds/],
    'columns.csv': [`${','.repeat(MB45)}\n1\n`, /csv: more than 1000 columns/],
    'wide-rows.csv': [`time,open,high,low,close\n${`${','.repeat(1000)}\n`.repeat(40000)}`, /row 2: unreadable time/],
  };
  // Rows are split only to the header's width: wide rows stay small (650 MB if every cell were split out).
  const limits = { 'wide-rows.csv': 400 };
  for (const [name, [text, why]] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text);
    const r = loadIsolated(path.join(dir, name), 60000);
    assert.strictEqual(r.status, 0, `${name}: ${r.signal || r.stderr}`);
    assert.match(r.msg, why, name);
    assert.ok(r.ms < 15000, `${name}: ${r.ms} ms`);
    assert.ok(r.maxRssMb < (limits[name] || 800), `${name}: ${r.maxRssMb} MB`);
  }
  // Real shapes still read: get_bars JSON, arrays of objects, and CSV.
  const bars = Array.from({ length: 50 }, (_, i) => ({ t: new Date(Date.UTC(2026, 0, 2, 14, i)).toISOString(), o: 1.5, h: 1.75, l: 1.25, c: 1.5, v: 0 }));
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ bars }));
  fs.writeFileSync(path.join(dir, 'ok.csv'), `time,open,high,low,close\n${bars.map(b => `${b.t},${b.o},${b.h},${b.l},${b.c}`).join('\n')}\n`);
  const { loadBars } = require('../../scripts/lib/backtest/data');
  assert.strictEqual(loadBars(path.join(dir, 'ok.json')).length, 50);
  assert.strictEqual(loadBars(path.join(dir, 'ok.csv')).length, 50);
});

test('parquet: a metadata map of booleans reads each boolean as a byte; negative page counts are refused as out of range', () => {
  const { Reader } = require('../../scripts/lib/backtest/parquet');
  // map<bool, i32> { true: 5, false: -3 } (compact protocol: size, key/value types, then the entries), then a byte after it.
  const r = new Reader(Buffer.from([2, 0x15, 1, ...parquetWriter.zz(5), 2, ...parquetWriter.zz(-3), 0x7f]));
  assert.deepStrictEqual(r.map(), [[true, 5], [false, -3]]);
  assert.strictEqual(r.byte(), 0x7f, 'the entries consumed exactly their bytes');
  const page = pageHeader => {
    const file = path.join(tmpDir(), 'p.parquet');
    fs.writeFileSync(file, parquetWriter.writeParquet({ codec: 0, columns: [{ name: 'v', type: 1, values: [1, 2, 3] }], pageHeader }));
    return file;
  };
  const v2 = (n, nulls) => (rows, raw, body) => [[1, 'i32', 3], [2, 'i32', raw], [3, 'i32', body], [8, 'struct', [[1, 'i32', n], [2, 'i32', nulls], [3, 'i32', rows], [4, 'i32', 0], [5, 'i32', 0], [6, 'i32', 0]]]];
  const dict = n => (rows, raw, body) => [[1, 'i32', 2], [2, 'i32', raw], [3, 'i32', body], [7, 'struct', [[1, 'i32', n], [2, 'i32', 0]]]];
  assert.throws(() => readParquet(page(v2(-5, 0))), /^Error: parquet: a page whose value count is out of range$/);
  assert.throws(() => readParquet(page(v2(3, 4))), /^Error: parquet: a page whose null count is out of range$/);
  assert.throws(() => readParquet(page(dict(-5))), /^Error: parquet: a page whose value count is out of range$/);
  assert.deepStrictEqual(readParquet(page(v2(3, 0))).rows.map(x => x.v), [1, 2, 3], 'a well-formed version-2 page reads');
});

test('JSON bars: a byte order mark is skipped; numeric epoch times (pandas to_json records) read; a file of unreadable bars is refused, never loaded as none', () => {
  const { loadBars } = require('../../scripts/lib/backtest/data');
  const dir = tmpDir();
  const t0 = Date.UTC(2026, 0, 2, 14, 0);
  const rows = Array.from({ length: 5 }, (_, i) => ({ time: t0 + i * 60000, open: 1.5, high: 1.75, low: 1.25, close: 1.5, volume: 3 }));
  fs.writeFileSync(path.join(dir, 'records-ms.json'), JSON.stringify(rows));
  fs.writeFileSync(path.join(dir, 'records-s.json'), JSON.stringify(rows.map(r => ({ ...r, time: r.time / 1000 }))));
  fs.writeFileSync(path.join(dir, 'bom.json'), `\ufeff${JSON.stringify({ bars: rows.map(r => ({ t: new Date(r.time).toISOString(), o: 1, h: 2, l: 0.5, c: 1 })) })}`);
  fs.writeFileSync(path.join(dir, 'bom.csv'), `\ufefftime,open,high,low,close\n2026-01-02T14:00:00Z,1,2,0.5,1\n`);
  for (const f of ['records-ms.json', 'records-s.json', 'bom.json']) {
    const bars = loadBars(path.join(dir, f));
    assert.strictEqual(bars.length, 5, f);
    assert.strictEqual(bars[0].t, '2026-01-02T14:00:00.000Z', f);
  }
  assert.strictEqual(loadBars(path.join(dir, 'bom.csv')).length, 1);
  fs.writeFileSync(path.join(dir, 'unreadable.json'), JSON.stringify([{ time: 'soon', open: 1, high: 2, low: 0, close: 1 }, { foo: 1 }]));
  assert.throws(() => loadBars(path.join(dir, 'unreadable.json')), /unreadable\.json: none of its 2 bars has a readable time, open, high, low and close$/);
  fs.writeFileSync(path.join(dir, 'empty.json'), '[]');
  assert.deepStrictEqual(loadBars(path.join(dir, 'empty.json')), [], 'an empty file is empty, not an error');
});
