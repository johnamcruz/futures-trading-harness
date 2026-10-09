'use strict';

/**
 * The multi-timeframe record the order gate reads: the trend rule's frames
 * (mtf.js RULE_FRAMES) as of the last closed bar, per index family, at
 * <FTH_HOME>/mtf/<MICRO ROOT>.json (MNQ and NQ share one: same index, same
 * bars).
 *
 * The autonomous runner writes it after every closed bar from the bars it
 * hands the cycle; interactively, `node scripts/mtf.js <bars> --record
 * --symbol MNQ` writes it (refused in autonomous runs, where the runner owns
 * it). The gate reads only this local file: no record, a stale one, or a
 * trend strategy's entry against its prevailing trend is refused.
 */

const fs = require('fs');
const path = require('path');
const { familyRoot } = require('./contracts');
const { mtfRead, trendRule, RULE_FRAMES, label } = require('./mtf');
const { normalizeBars } = require('./indicators');

const DEFAULT_MAX_AGE_MIN = 15;

const recordFile = (home, root) => path.join(home, 'mtf', `${familyRoot(root)}.json`);

/** The record for `bars` (normalized, closed, oldest first) of `symbol`. */
function buildRecord(raw, { symbol, source = null, now = new Date() } = {}) {
  const bars = normalizeBars(raw);
  const read = mtfRead(bars);
  const last = bars[bars.length - 1];
  const step = bars.length > 1 ? Date.parse(last.t) - Date.parse(bars[bars.length - 2].t) : 60000;
  return {
    symbol: String(symbol || '').toUpperCase(),
    asOf: last.t,
    // When the last bar closed: what freshness is measured from.
    closedAt: new Date(Date.parse(last.t) + step).toISOString(),
    recordedAt: now.toISOString(),
    source,
    biases: Object.fromEntries(RULE_FRAMES.map(m => [m, Number.isFinite(read.biases[m]) ? read.biases[m] : null])),
    rule: read.rule,
    line: read.lines[read.lines.length - 1],
  };
}

/** Write atomically (a reader never sees half a file). */
function writeRecord(home, record) {
  const file = recordFile(home, record.symbol);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** Build and write the record for `bars` of `symbol`; returns the record. */
function writeMtfRecord(home, symbol, bars, opts = {}) {
  const rec = buildRecord(bars, { symbol, ...opts });
  writeRecord(home, rec);
  return rec;
}

function readRecord(home, root) {
  try {
    return JSON.parse(fs.readFileSync(recordFile(home, root), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { error: err.code || err.message };
  }
}

/**
 * The gate's check: may a `style` strategy enter `side` (buy/sell) on `root`
 * at `now`? Returns a message, or null.
 */
function checkTrend(home, { root, side, style = 'trend', strategy, now = new Date(), maxAgeMin = DEFAULT_MAX_AGE_MIN }) {
  if (style === 'reversal') return null;
  const how = `Fetch fresh bars and record the read: node <root>/scripts/bars.js --symbol ${root} --timeframe <minutes> --record (or mtf.js <a fresh bars file> --record --symbol ${root}; re-recording an old file stays stale). The autonomous runner records it every bar.`;
  const rec = readRecord(home, root);
  if (!rec) return `No multi-timeframe read for ${familyRoot(root)}: setup:${strategy} is a trend strategy and may not enter without one. ${how}`;
  if (rec.error || !rec.biases || !rec.closedAt) return `The multi-timeframe record for ${familyRoot(root)} is unreadable (${rec.error || 'missing fields'}). ${how}`;
  const age = (now.getTime() - Date.parse(rec.closedAt)) / 60000;
  // A bar can't close after now (a minute of clock skew aside): such a record would never go stale.
  if (age < -1) return `The multi-timeframe record for ${familyRoot(root)} is dated ${rec.closedAt}, after now; it can't be trusted. ${how}`;
  if (!(age <= maxAgeMin)) {
    return `The multi-timeframe read for ${familyRoot(root)} is ${Number.isFinite(age) ? `${Math.round(age)} min` : 'of unknown'} old (limit ${maxAgeMin}, FTH_MTF_MAX_AGE_MIN). ${how}`;
  }
  const biases = Object.fromEntries(RULE_FRAMES.map(m => [m, rec.biases[m] === null || rec.biases[m] === undefined ? NaN : Number(rec.biases[m])]));
  const dir = String(side || '').toLowerCase() === 'buy' ? 'long' : String(side || '').toLowerCase() === 'sell' ? 'short' : null;
  if (!dir) return null; // the side check is the gateway's and the server's
  const r = trendRule(biases, dir, style);
  if (r.allowed) return null;
  const frames = RULE_FRAMES.map(m => `${label(m)} ${Number.isFinite(biases[m]) ? (biases[m] > 0 ? 'up' : biases[m] < 0 ? 'down' : 'range') : 'unknown'}`).join(', ');
  return `setup:${strategy} ${dir} is ${r.reason} (${frames}, as of the bar closed ${rec.closedAt}). Stand aside, or trade a setup with the trend.`;
}

module.exports = { DEFAULT_MAX_AGE_MIN, recordFile, buildRecord, writeRecord, writeMtfRecord, readRecord, checkTrend };
