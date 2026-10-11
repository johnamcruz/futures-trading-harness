'use strict';

// A minimal Parquet writer for tests: the Thrift compact protocol for the
// metadata, and plain pages. Enough to build a realistic large file and small
// crafted ones; not a general writer.

const zlib = require('zlib');

const varint = n => { let v = BigInt(n); const out = []; while (v >= 128n) { out.push(Number(v & 127n) | 128); v >>= 7n; } out.push(Number(v)); return out; };
const zz = n => { const v = BigInt(n); return varint(v >= 0n ? v << 1n : ((-v) << 1n) - 1n); };

/** A struct from [id, kind, value]: kinds i32, i64, bin, struct, list (of structs), listbin, listi32. */
function struct(fields) {
  const out = [];
  let last = 0;
  for (const [id, kind, val] of fields) {
    const t = { i32: 5, i64: 6, bin: 8, list: 9, listbin: 9, listi32: 9, struct: 12 }[kind];
    const d = id - last;
    if (d > 0 && d <= 15) out.push((d << 4) | t); else out.push(t, ...zz(id));
    last = id;
    if (kind === 'i32' || kind === 'i64') out.push(...zz(val));
    else if (kind === 'bin') { const b = Buffer.from(val); out.push(...varint(b.length), ...b); }
    else if (kind === 'struct') out.push(...struct(val));
    else {
      const et = { list: 12, listbin: 8, listi32: 5 }[kind];
      if (val.length < 15) out.push((val.length << 4) | et); else out.push(0xf0 | et, ...varint(val.length));
      for (const e of val) {
        if (kind === 'list') out.push(...struct(e));
        else if (kind === 'listbin') { const b = Buffer.from(e); out.push(...varint(b.length), ...b); }
        else out.push(...zz(e));
      }
    }
  }
  out.push(0);
  return out;
}

const finish = (parts, footer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(footer.length);
  return Buffer.concat([...parts, footer, len, Buffer.from('PAR1')]);
};

/**
 * A file of `columns` ([{ name, type, values, typeLength, encoding, convert }]; type: 1 INT32, 2 INT64,
 * 5 DOUBLE, 7 FIXED_LEN_BYTE_ARRAY), plain pages of `pageRows`, gzip (codec 2) or none (codec 0).
 */
function writeParquet({ columns, pageRows = 65536, codec = 2 }) {
  const n = columns[0].values.length;
  const parts = [Buffer.from('PAR1')];
  let off = 4;
  const chunks = [];
  for (const col of columns) {
    const start = off;
    let total = 0;
    const width = { 1: 4, 2: 8, 5: 8, 7: col.typeLength }[col.type];
    for (let i = 0; i < n; i += pageRows) {
      const rows = Math.min(pageRows, n - i);
      const raw = Buffer.alloc(rows * width);
      for (let j = 0; j < rows; j += 1) {
        const v = col.values[i + j];
        if (col.encoding === 9) for (let b = 0; b < width; b += 1) raw[b * rows + j] = v[b]; // BYTE_STREAM_SPLIT
        else if (col.type === 1) raw.writeInt32LE(v, j * 4);
        else if (col.type === 2) raw.writeBigInt64LE(BigInt(v), j * 8);
        else if (col.type === 5) raw.writeDoubleLE(v, j * 8);
        else Buffer.from(v).copy(raw, j * width);
      }
      const body = codec === 2 ? zlib.gzipSync(raw, { level: 1 }) : raw;
      const h = Buffer.from(struct([[1, 'i32', 0], [2, 'i32', raw.length], [3, 'i32', body.length], [5, 'struct', [[1, 'i32', rows], [2, 'i32', col.encoding || 0], [3, 'i32', 0], [4, 'i32', 0]]]]));
      parts.push(h, body);
      off += h.length + body.length;
      total += raw.length;
    }
    chunks.push([[2, 'i64', start], [3, 'struct', [[1, 'i32', col.type], [2, 'listi32', [col.encoding || 0]], [3, 'listbin', [col.name]], [4, 'i32', codec], [5, 'i64', n], [6, 'i64', total], [7, 'i64', off - start], [9, 'i64', start]]]]);
  }
  const schema = [[[4, 'bin', 'schema'], [5, 'i32', columns.length]], ...columns.map(c => [
    [1, 'i32', c.type], ...(c.typeLength ? [[2, 'i32', c.typeLength]] : []), [3, 'i32', 0], [4, 'bin', c.name], ...(c.convert !== undefined ? [[6, 'i32', c.convert]] : []),
  ])];
  const footer = Buffer.from(struct([[1, 'i32', 1], [2, 'list', schema], [3, 'i64', n], [4, 'list', [[[1, 'list', chunks], [2, 'i64', 0], [3, 'i64', n]]]]]));
  return finish(parts, footer);
}

/** A file whose footer is the given raw metadata bytes. */
const rawFooter = meta => finish([Buffer.from('PAR1')], Buffer.from(meta));

module.exports = { varint, zz, struct, writeParquet, rawFooter };
