'use strict';

/**
 * A bound on what one bars file may decode to (xlsx.js, parquet.js): a file
 * is capped on disk, but a compressed stream is not, so a small file could
 * inflate to gigabytes (a decompression bomb) or encode billions of values.
 * Every inflate, gunzip, brotli, zstd, snappy and LZ4 output of one file read
 * counts against one byte budget (handed to zlib as maxOutputLength, so it
 * stops inflating at the limit), and every value decoded against a value
 * budget. Over either: an error naming the limit, never the content.
 *
 *   createBudget({ bytes, values }) -> { inflate(what, fn), take(what, n), count(what, n), left }
 *     inflate(what, fn)   fn(maxOutputLength) -> Buffer, counted; a zlib "too large" becomes the refusal
 *     take(what, n)       n more decompressed bytes (checked before allocating them)
 *     count(what, n)      n more decoded values
 */

const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
// About 70 bytes a decoded value: 10M values (2M bars of 5 columns) stay well under a gigabyte.
const MAX_DECODED_VALUES = 10 * 1000 * 1000;

class DecodeBudgetError extends Error {}

function createBudget({ bytes = MAX_DECOMPRESSED_BYTES, values = MAX_DECODED_VALUES } = {}) {
  let left = bytes;
  let valuesLeft = values;
  const refuse = (what, limit) => new DecodeBudgetError(`${what}: the file decodes to more than ${limit} (a decompression bomb, or a file too large to read): refused`);
  const mb = bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${bytes} bytes`;
  return {
    get left() { return left; },
    take(what, n) {
      if (!(Number.isFinite(n) && n >= 0) || n > left) throw refuse(what, mb);
      left -= n;
    },
    count(what, n) {
      if (!(Number.isFinite(Number(n)) && Number(n) >= 0) || Number(n) > valuesLeft) throw refuse(what, `${values} values`);
      valuesLeft -= Number(n);
    },
    inflate(what, fn) {
      let out;
      try {
        out = fn(Math.max(left, 1));
      } catch (err) {
        if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw refuse(what, mb);
        throw err;
      }
      this.take(what, out.length);
      return out;
    },
  };
}

module.exports = { MAX_DECOMPRESSED_BYTES, MAX_DECODED_VALUES, DecodeBudgetError, createBudget };
