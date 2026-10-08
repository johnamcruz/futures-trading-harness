'use strict';

/**
 * Minimal, dependency-free Apache Parquet reader for bar files (flat tables
 * of time + OHLCV columns, as written by pandas/pyarrow, polars, fastparquet,
 * or DuckDB). Reads the whole file into column arrays.
 *
 * Supported: flat schemas (required or optional columns), row groups, data
 * pages v1 and v2, dictionary pages; encodings PLAIN, PLAIN_DICTIONARY,
 * RLE_DICTIONARY, RLE (booleans), DELTA_BINARY_PACKED,
 * DELTA_LENGTH_BYTE_ARRAY, DELTA_BYTE_ARRAY, BYTE_STREAM_SPLIT; codecs
 * UNCOMPRESSED, SNAPPY, GZIP, BROTLI, ZSTD (Node with zlib zstd), LZ4_RAW;
 * physical types BOOLEAN, INT32, INT64, INT96, FLOAT, DOUBLE, BYTE_ARRAY,
 * FIXED_LEN_BYTE_ARRAY; logical TIMESTAMP (ms/us/ns), DATE, DECIMAL, STRING.
 * Nested (repeated) columns are rejected.
 */

const fs = require('fs');
const zlib = require('zlib');

const TYPE = { BOOLEAN: 0, INT32: 1, INT64: 2, INT96: 3, FLOAT: 4, DOUBLE: 5, BYTE_ARRAY: 6, FIXED_LEN_BYTE_ARRAY: 7 };
const ENC = { PLAIN: 0, PLAIN_DICTIONARY: 2, RLE: 3, BIT_PACKED: 4, DELTA_BINARY_PACKED: 5, DELTA_LENGTH_BYTE_ARRAY: 6, DELTA_BYTE_ARRAY: 7, RLE_DICTIONARY: 8, BYTE_STREAM_SPLIT: 9 };
const PAGE = { DATA: 0, DICTIONARY: 2, DATA_V2: 3 };

// ── Thrift compact protocol (just enough for Parquet metadata) ─────────────

class Reader {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  byte() {
    if (this.pos >= this.buf.length) throw new Error('parquet: unexpected end of metadata');
    return this.buf[this.pos++];
  }

  varint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
  }

  zigzag() {
    const v = this.varint();
    return (v >> 1n) ^ -(v & 1n);
  }

  int() {
    return Number(this.zigzag());
  }

  binary() {
    const len = Number(this.varint());
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  value(type) {
    switch (type) {
      case 1: return true;
      case 2: return false;
      case 3: return (this.byte() << 24) >> 24;
      case 4: case 5: return this.int();
      case 6: return this.zigzag();
      case 7: { const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
      case 8: return this.binary();
      case 9: case 10: return this.list();
      case 11: return this.map();
      case 12: return this.struct();
      default: throw new Error(`parquet: unknown thrift type ${type}`);
    }
  }

  list() {
    const head = this.byte();
    let size = head >> 4;
    const type = head & 0x0f;
    if (size === 15) size = Number(this.varint());
    const out = [];
    for (let k = 0; k < size; k += 1) out.push(type === 1 || type === 2 ? this.byte() === 1 : this.value(type));
    return out;
  }

  map() {
    const size = Number(this.varint());
    const out = [];
    if (size === 0) return out;
    const types = this.byte();
    for (let k = 0; k < size; k += 1) out.push([this.value(types >> 4), this.value(types & 0x0f)]);
    return out;
  }

  /** A struct as { fieldId: value }. */
  struct() {
    const out = {};
    let last = 0;
    for (;;) {
      const head = this.byte();
      if (head === 0) return out;
      const delta = head >> 4;
      const type = head & 0x0f;
      const id = delta ? last + delta : this.int();
      last = id;
      out[id] = this.value(type);
    }
  }
}

// ── decompression ──────────────────────────────────────────────────────────

function snappy(input, outLen) {
  const r = new Reader(input);
  const len = Number(r.varint());
  const out = Buffer.alloc(len);
  let o = 0;
  let p = r.pos;
  while (p < input.length) {
    const tag = input[p++];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = input.readUIntLE(p, bytes);
        p += bytes;
      }
      n += 1;
      input.copy(out, o, p, p + n);
      o += n;
      p += n;
    } else {
      let n; let offset;
      if (kind === 1) { n = 4 + ((tag >> 2) & 7); offset = ((tag >> 5) << 8) | input[p++]; } else if (kind === 2) { n = (tag >> 2) + 1; offset = input.readUInt16LE(p); p += 2; } else { n = (tag >> 2) + 1; offset = input.readUInt32LE(p); p += 4; }
      if (offset === 0 || offset > o) throw new Error('parquet: corrupt snappy data');
      for (let k = 0; k < n; k += 1) out[o + k] = out[o - offset + k];
      o += n;
    }
  }
  if (o !== len || (outLen !== undefined && len !== outLen)) throw new Error('parquet: snappy length mismatch');
  return out;
}

function lz4Raw(input, outLen) {
  const out = Buffer.alloc(outLen);
  let p = 0; let o = 0;
  while (p < input.length) {
    const token = input[p++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = input[p++]; lit += b; } while (b === 255); }
    input.copy(out, o, p, p + lit);
    o += lit; p += lit;
    if (p >= input.length) break;
    const offset = input.readUInt16LE(p); p += 2;
    let m = token & 15;
    if (m === 15) { let b; do { b = input[p++]; m += b; } while (b === 255); }
    m += 4;
    for (let k = 0; k < m; k += 1) out[o + k] = out[o - offset + k];
    o += m;
  }
  return out;
}

function decompress(codec, buf, outLen) {
  switch (codec) {
    case 0: return buf;
    case 1: return snappy(buf, outLen);
    case 2: return zlib.gunzipSync(buf);
    case 4: return zlib.brotliDecompressSync(buf);
    case 6:
      if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('parquet: ZSTD needs Node 22.15+ (or rewrite the file with snappy)');
      return zlib.zstdDecompressSync(buf);
    case 7: return lz4Raw(buf, outLen);
    default: throw new Error(`parquet: compression codec ${codec} is not supported (use snappy, gzip, zstd, brotli, or none)`);
  }
}

// ── encodings ──────────────────────────────────────────────────────────────

/** RLE / bit-packed hybrid: `count` values of `width` bits from buf[pos..end). */
function rleHybrid(buf, pos, end, width, count) {
  const out = new Array(count);
  const r = new Reader(buf, pos);
  const byteWidth = Math.ceil(width / 8);
  let n = 0;
  while (n < count && r.pos < end) {
    const header = Number(r.varint());
    if ((header & 1) === 0) {
      const run = header >> 1;
      let v = 0;
      for (let k = 0; k < byteWidth; k += 1) v |= buf[r.pos + k] << (8 * k);
      r.pos += byteWidth;
      for (let k = 0; k < run && n < count; k += 1) out[n++] = v;
    } else {
      const total = (header >> 1) * 8;
      let bit = 0;
      const start = r.pos;
      for (let k = 0; k < total; k += 1) {
        let v = 0;
        for (let b = 0; b < width; b += 1, bit += 1) if (buf[start + (bit >> 3)] & (1 << (bit & 7))) v |= 1 << b;
        if (n < count) out[n++] = v;
      }
      r.pos = start + (header >> 1) * width;
    }
  }
  if (n < count) throw new Error('parquet: truncated level or index data');
  return out;
}

function bitWidth(max) {
  let w = 0;
  while ((1 << w) <= max) w += 1;
  return w;
}

/** DELTA_BINARY_PACKED: returns { values (BigInt), pos }. */
function deltaBinary(buf, pos) {
  const r = new Reader(buf, pos);
  const blockSize = Number(r.varint());
  const miniblocks = Number(r.varint());
  const total = Number(r.varint());
  let last = r.zigzag();
  const values = total > 0 ? [last] : [];
  const perMini = blockSize / miniblocks;
  while (values.length < total) {
    const minDelta = r.zigzag();
    const widths = [];
    for (let k = 0; k < miniblocks; k += 1) widths.push(r.byte());
    for (let m = 0; m < miniblocks; m += 1) {
      const w = widths[m];
      const start = r.pos;
      for (let k = 0; k < perMini; k += 1) {
        let v = 0n;
        for (let b = 0; b < w; b += 1) {
          const bit = k * w + b;
          if (buf[start + (bit >> 3)] & (1 << (bit & 7))) v |= 1n << BigInt(b);
        }
        if (values.length < total) {
          last += minDelta + v;
          values.push(BigInt.asIntN(64, last));
        }
      }
      r.pos = start + (perMini * w) / 8;
      if (values.length >= total) break;
    }
  }
  return { values, pos: r.pos };
}

function plain(buf, pos, type, count, typeLength) {
  const out = new Array(count);
  let p = pos;
  for (let k = 0; k < count; k += 1) {
    switch (type) {
      case TYPE.BOOLEAN: out[k] = Boolean(buf[pos + (k >> 3)] & (1 << (k & 7))); break;
      case TYPE.INT32: out[k] = buf.readInt32LE(p); p += 4; break;
      case TYPE.INT64: out[k] = buf.readBigInt64LE(p); p += 8; break;
      case TYPE.INT96: out[k] = { nanos: buf.readBigInt64LE(p), julian: buf.readInt32LE(p + 8) }; p += 12; break;
      case TYPE.FLOAT: out[k] = buf.readFloatLE(p); p += 4; break;
      case TYPE.DOUBLE: out[k] = buf.readDoubleLE(p); p += 8; break;
      case TYPE.BYTE_ARRAY: { const len = buf.readUInt32LE(p); out[k] = buf.subarray(p + 4, p + 4 + len); p += 4 + len; break; }
      case TYPE.FIXED_LEN_BYTE_ARRAY: out[k] = buf.subarray(p, p + typeLength); p += typeLength; break;
      default: throw new Error(`parquet: physical type ${type} is not supported`);
    }
  }
  return out;
}

function decodeValues(buf, pos, end, encoding, col, count, dict) {
  switch (encoding) {
    case ENC.PLAIN: return plain(buf, pos, col.type, count, col.typeLength);
    case ENC.PLAIN_DICTIONARY:
    case ENC.RLE_DICTIONARY: {
      if (!dict) throw new Error('parquet: dictionary-encoded page without a dictionary');
      const width = buf[pos];
      return rleHybrid(buf, pos + 1, end, width, count).map(i => dict[i]);
    }
    case ENC.RLE:
      if (col.type !== TYPE.BOOLEAN) throw new Error('parquet: RLE values are only supported for booleans');
      return rleHybrid(buf, pos + 4, end, 1, count).map(Boolean);
    case ENC.DELTA_BINARY_PACKED: {
      const v = deltaBinary(buf, pos).values;
      return col.type === TYPE.INT32 ? v.map(Number) : v;
    }
    case ENC.DELTA_LENGTH_BYTE_ARRAY: {
      const { values: lens, pos: p0 } = deltaBinary(buf, pos);
      let p = p0;
      return lens.map(l => { const n = Number(l); const s = buf.subarray(p, p + n); p += n; return s; });
    }
    case ENC.DELTA_BYTE_ARRAY: {
      const { values: prefix, pos: p1 } = deltaBinary(buf, pos);
      const { values: suffix, pos: p2 } = deltaBinary(buf, p1);
      let p = p2;
      let prev = Buffer.alloc(0);
      return prefix.map((pl, k) => {
        const n = Number(suffix[k]);
        const v = Buffer.concat([prev.subarray(0, Number(pl)), buf.subarray(p, p + n)]);
        p += n;
        prev = v;
        return v;
      });
    }
    case ENC.BYTE_STREAM_SPLIT: {
      const width = { [TYPE.FLOAT]: 4, [TYPE.DOUBLE]: 8, [TYPE.INT32]: 4, [TYPE.INT64]: 8 }[col.type] || col.typeLength;
      const tmp = Buffer.alloc(width);
      const out = new Array(count);
      for (let k = 0; k < count; k += 1) {
        for (let b = 0; b < width; b += 1) tmp[b] = buf[pos + b * count + k];
        out[k] = plain(tmp, 0, col.type, 1, col.typeLength)[0];
      }
      return out;
    }
    default: throw new Error(`parquet: encoding ${encoding} is not supported`);
  }
}

// ── file structure ─────────────────────────────────────────────────────────

function readMetadata(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'PAR1' || buf.toString('latin1', buf.length - 4) !== 'PAR1') {
    throw new Error('not a Parquet file (missing PAR1 magic)');
  }
  const len = buf.readUInt32LE(buf.length - 8);
  return new Reader(buf, buf.length - 8 - len).struct();
}

function columnsOf(meta) {
  const schema = meta[2] || [];
  const cols = [];
  // schema[0] is the root; flat files have only leaf children.
  for (const el of schema.slice(1)) {
    if (el[5]) throw new Error(`parquet: nested column "${el[4]}" is not supported`);
    if (el[3] === 2) throw new Error(`parquet: repeated column "${el[4]}" is not supported`);
    const logical = el[10] || {};
    cols.push({
      name: el[4].toString('utf8'), type: el[1], typeLength: el[2], optional: el[3] === 1,
      converted: el[6], scale: el[7] || 0,
      timestampUnit: logical[8] ? (logical[8][2] && (logical[8][2][1] ? 'ms' : logical[8][2][2] ? 'us' : logical[8][2][3] ? 'ns' : null)) : null,
      isDate: Boolean(logical[6]) || el[6] === 6,
      isDecimal: Boolean(logical[5]) || el[6] === 5,
      decimalScale: logical[5] ? logical[5][1] : el[7] || 0,
      isString: Boolean(logical[1]) || el[6] === 0,
    });
  }
  return cols;
}

function readColumnChunk(buf, chunk, col) {
  const md = chunk[3];
  const codec = md[4];
  const total = Number(md[5]);
  let pos = Number(md[11] !== undefined && md[11] > 0n ? (md[11] < md[9] ? md[11] : md[9]) : md[9]);
  const values = [];
  let dict = null;
  let seen = 0;
  while (seen < total) {
    const r = new Reader(buf, pos);
    const header = r.struct();
    const dataStart = r.pos;
    const compressed = header[3];
    const uncompressed = header[2];
    const type = header[1];
    pos = dataStart + compressed;
    if (type === PAGE.DICTIONARY) {
      const page = decompress(codec, buf.subarray(dataStart, dataStart + compressed), uncompressed);
      dict = plain(page, 0, col.type, header[7][1], col.typeLength);
    } else if (type === PAGE.DATA) {
      const h = header[5];
      const n = h[1];
      const page = decompress(codec, buf.subarray(dataStart, dataStart + compressed), uncompressed);
      let p = 0;
      let defs = null;
      if (col.optional) {
        const len = page.readUInt32LE(0);
        defs = rleHybrid(page, 4, 4 + len, 1, n);
        p = 4 + len;
      }
      const present = defs ? defs.filter(d => d === 1).length : n;
      const vals = decodeValues(page, p, page.length, h[2], col, present, dict);
      let k = 0;
      for (let j = 0; j < n; j += 1) values.push(defs && defs[j] === 0 ? null : vals[k++]);
      seen += n;
    } else if (type === PAGE.DATA_V2) {
      const h = header[8];
      const n = h[1];
      const nulls = h[2] || 0;
      const defLen = h[5] || 0;
      const repLen = h[6] || 0;
      const levels = dataStart + repLen;
      const defs = col.optional && defLen ? rleHybrid(buf, levels, levels + defLen, bitWidth(1), n) : null;
      const body = buf.subarray(dataStart + repLen + defLen, dataStart + compressed);
      const page = h[7] === false ? body : decompress(codec, body, uncompressed - repLen - defLen);
      const vals = decodeValues(page, 0, page.length, h[4], col, n - nulls, dict);
      let k = 0;
      for (let j = 0; j < n; j += 1) values.push(defs && defs[j] === 0 ? null : vals[k++]);
      seen += n;
    } else if (type !== 1) {
      throw new Error(`parquet: page type ${type} is not supported`);
    }
  }
  return values;
}

/** Convert a raw value to a JS value: numbers, ISO strings for times, strings for text. */
function convert(col, v) {
  if (v === null || v === undefined) return null;
  if (col.type === TYPE.INT96) {
    const ms = (v.julian - 2440588) * 86400000 + Number(v.nanos / 1000000n);
    return new Date(ms).toISOString();
  }
  if (col.timestampUnit || col.converted === 9 || col.converted === 10) {
    const unit = col.timestampUnit || (col.converted === 9 ? 'ms' : 'us');
    const big = BigInt(v);
    const ms = unit === 'ms' ? Number(big) : unit === 'us' ? Number(big / 1000n) : Number(big / 1000000n);
    return new Date(ms).toISOString();
  }
  if (col.isDate) return new Date(Number(v) * 86400000).toISOString();
  if (col.isDecimal) {
    const n = Buffer.isBuffer(v) ? Number(v.length ? BigInt.asIntN(v.length * 8, BigInt(`0x${v.toString('hex')}`)) : 0n) : Number(v);
    return n / 10 ** (col.decimalScale || 0);
  }
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'bigint') return Number(v);
  return v;
}

/** Read a Parquet file into { columns: [names], rows: [{ name: value }] }. */
function readParquet(file) {
  const buf = fs.readFileSync(file);
  const meta = readMetadata(buf);
  const cols = columnsOf(meta);
  const data = cols.map(() => []);
  for (const rg of meta[4] || []) {
    const chunks = rg[1];
    cols.forEach((col, k) => {
      const chunk = chunks.find(c => c[3] && c[3][3] && c[3][3].map(x => x.toString('utf8')).join('.') === col.name) || chunks[k];
      for (const v of readColumnChunk(buf, chunk, col)) data[k].push(convert(col, v));
    });
  }
  const n = data.length ? data[0].length : 0;
  const rows = new Array(n);
  for (let r = 0; r < n; r += 1) {
    const row = {};
    cols.forEach((col, k) => { row[col.name] = data[k][r]; });
    rows[r] = row;
  }
  return { columns: cols.map(c => c.name), rows };
}

module.exports = { readParquet, snappy, rleHybrid, deltaBinary };
