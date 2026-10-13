'use strict';

/**
 * `backtest.js fetch`: the broker's historical bars, at any timeframe, to a file the backtester loads.
 * The bars come through the broker adapter's history() (broker/adapter.js: get_bars, paged) as the
 * broker's server built them, with every field it put on them; the harness never computes or merges a
 * field of its own. JSON lines (.jsonl, one bar a line) and JSON ({ contractId, barSize, count, bars })
 * keep every field; a CSV has only time, prices and volume, so it is refused for bars that carry more.
 *
 *   writeBarsFile(file, bars, { contractId, barSize })   writes it (atomically); returns the format
 *   fetchToFile(adapter, { contractId, from, to, timeframe, out })   { count, format, barSize, extra }
 */

const fs = require('fs');
const path = require('path');
const { barSpec } = require('../broker/adapter');
const { extraKeys } = require('./data');

const formatOf = file => {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.json') return 'json';
  if (ext === '.csv') return 'csv';
  throw new Error(`${file}: write .jsonl (one bar a line, every field kept; best for long spans), .json, or .csv (prices only)`);
};

/** Write the chunks an iterable yields to `file` through a temporary file, renamed into place; removed on failure. */
function writeAtomic(file, chunks) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      for (const c of chunks) fs.writeSync(fd, c);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_err) { /* never written, or already gone */ }
    throw err;
  }
}

function writeBarsFile(file, bars, { contractId = null, barSize = null } = {}) {
  const format = formatOf(file);
  if (format === 'csv') {
    const extra = extraKeys(bars);
    if (extra.length) {
      throw new Error(`${file}: these bars carry the broker's own fields (${extra.slice(0, 5).join(', ')}), which a CSV can't hold: write .jsonl or .json to keep them`);
    }
    writeAtomic(file, (function* csv() {
      yield 'time,open,high,low,close,volume\n';
      for (const b of bars) yield `${[b.t, b.o, b.h, b.l, b.c, b.v].join(',')}\n`;
    }()));
  } else if (format === 'jsonl') {
    // One line at a time: years of bars never become one string.
    writeAtomic(file, (function* lines() { for (const b of bars) yield `${JSON.stringify(b)}\n`; }()));
  } else {
    writeAtomic(file, (function* doc() { yield `${JSON.stringify({ contractId, barSize, count: bars.length, bars }, null, 2)}\n`; }()));
  }
  return format;
}

async function fetchToFile(adapter, { contractId, from, to, timeframe = 1, out }) {
  const spec = barSpec(timeframe);
  formatOf(out); // refuse an unknown format before fetching
  const bars = await adapter.history(contractId, { from, to, timeframe });
  const barSize = `${spec.unitNumber} ${spec.unit}`;
  const format = writeBarsFile(out, bars, { contractId, barSize });
  return { count: bars.length, format, barSize, extra: extraKeys(bars) };
}

module.exports = { writeBarsFile, fetchToFile };
