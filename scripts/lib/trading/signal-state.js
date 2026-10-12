'use strict';

/**
 * The signal record the order gate reads: which rules strategies fired, and
 * on which side, on the last closed bar of an index family, at
 * <FTH_HOME>/signals/<MICRO ROOT>-<minutes>m.json (one per timeframe).
 *
 * The autonomous runner writes it after scanning every closed bar;
 * interactively, `node scripts/strategies.js scan <bars> --symbol MNQ
 * --record` writes it (refused in autonomous runs). The gate refuses a rules
 * strategy's entry unless that strategy fired in that direction on a bar that
 * closed less than FTH_SIGNAL_MAX_AGE_MIN (10) minutes ago: no entry without
 * its trigger, under any setup tag, and no entry on a stale signal.
 */

const fs = require('fs');
const path = require('path');
const { familyRoot } = require('./contracts');

const DEFAULT_MAX_AGE_MIN = 10;
// How far after now a bar's close may be dated and still be trusted: the broker's clock may run a
// little ahead of the harness's (order_plan applies the same tolerance to the bars it plans from).
const FUTURE_TOLERANCE_MIN = 1;

// One record per index family and timeframe: a 1m scan never overwrites the 3m one.
const signalFile = (home, root, timeframe) => path.join(home, 'signals', `${familyRoot(root)}-${timeframe}.json`);
const tfOf = stepMs => `${Math.round(stepMs / 60000)}m`;

/** The record for scan `results` on the bar `bar` ({ t }) of `symbol`, `stepMs` long. */
function buildSignals(results, { symbol, bar, stepMs, now = new Date(), source = null }) {
  return {
    symbol: String(symbol || '').toUpperCase(),
    timeframe: tfOf(stepMs),
    asOf: bar.t,
    closedAt: new Date(Date.parse(bar.t) + stepMs).toISOString(),
    recordedAt: now.toISOString(),
    source,
    candidates: (results || []).filter(r => r.candidate && r.direction && r.signal === 'rules')
      .map(r => ({ name: r.name, direction: r.direction, stopDistance: r.stopDistance ?? null, ...(r.confluence ? { confluence: r.confluence } : {}) })),
  };
}

function writeSignals(home, record) {
  // The file name comes from these: a contract root and a minute count, nothing that could climb out of signals/.
  if (!/^[A-Z0-9]+$/.test(familyRoot(record.symbol))) throw new Error(`signal record: the symbol must be a contract root, e.g. MNQ (got ${JSON.stringify(String(record.symbol))})`);
  if (!/^\d+m$/.test(String(record.timeframe))) throw new Error(`signal record: the timeframe must be minutes, e.g. 3m (got ${JSON.stringify(String(record.timeframe))})`);
  const file = signalFile(home, record.symbol, record.timeframe);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/**
 * A bar time as an instant (ms), NaN when unreadable. Bar times are compared
 * as instants, never as text: "...T13:57:00Z", "...T13:57:00.000Z" and
 * "...T08:57:00-05:00" are one bar.
 */
const barMs = t => (typeof t === 'string' && t.trim() ? Date.parse(t) : NaN);

/** Whether two bar times name the same bar (both readable). */
const sameBar = (a, b) => Number.isFinite(barMs(a)) && barMs(a) === barMs(b);

/** A strategy's timeframe (3m, 1h) as the record's file names it (minutes: 3m, 60m), or null. */
function recordTimeframe(timeframe) {
  const m = /^(\d+)(m|h)$/.exec(String(timeframe || ''));
  return m && Number(m[1]) > 0 ? `${Number(m[1]) * (m[2] === 'h' ? 60 : 1)}m` : null;
}

function readSignals(home, root, timeframe) {
  try {
    return JSON.parse(fs.readFileSync(signalFile(home, root, timeframe), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { error: err.code || err.message };
  }
}

/**
 * The gate's check for a rules strategy's entry: did `strategy` fire `side`
 * (buy/sell) on `root`'s last closed bar, recently? Returns a message, or null.
 */
function checkTrigger(home, { root, side, strategy, style = 'trend', timeframe = '3m', now = new Date(), maxAgeMin = DEFAULT_MAX_AGE_MIN, minConfluence = 1 }) {
  const fam = familyRoot(root);
  const how = `Fetch fresh ${timeframe} bars (the harness tool bars_fetch {"symbol": "${root}", "timeframe": ${parseInt(timeframe, 10) || '<minutes>'}}), then scan and record them: strategies_scan {"bars": "<that file>", "symbol": "${root}", "record": true}. The autonomous runner records every bar; while it runs, recording yourself is refused.`;
  const rec = readSignals(home, root, timeframe);
  if (!rec) return `No ${timeframe} signal record for ${fam}: setup:${strategy} is a rules strategy, and the gate needs to see its trigger fire. ${how}`;
  if (rec.error || !Array.isArray(rec.candidates) || !rec.closedAt) return `The signal record for ${fam} is unreadable (${rec.error || 'missing fields'}). ${how}`;
  const age = (now.getTime() - Date.parse(rec.closedAt)) / 60000;
  if (age < -FUTURE_TOLERANCE_MIN) return `The signal record for ${fam} is dated ${rec.closedAt}, after now; it can't be trusted. ${how}`;
  if (!(age <= maxAgeMin)) {
    return `The last recorded signal bar for ${fam} closed ${Number.isFinite(age) ? `${Math.round(age)} min` : 'an unknown time'} ago (limit ${maxAgeMin}, FTH_SIGNAL_MAX_AGE_MIN): the setup has expired. ${how}`;
  }
  const dir = { buy: 'long', sell: 'short' }[String(side || '').toLowerCase()];
  const hit = rec.candidates.find(c => c.name === strategy && (!dir || c.direction === dir));
  if (hit) {
    // Confluence, as the backtester's defaults: strategies firing the other side on the bar stop a
    // trend strategy (a reversal may fade them), and FTH_MIN_CONFLUENCE strategies must agree.
    const conf = hit.confluence || { with: [], against: [] };
    if (conf.against.length && style !== 'reversal') {
      return `setup:${strategy} ${dir} conflicts with ${conf.against.join(', ')} firing the other side on the same bar: stand aside (only a reversal strategy may fade other signals).`;
    }
    if (1 + conf.with.length < minConfluence) {
      return `setup:${strategy} ${dir} fired alone (${1 + conf.with.length} of the ${minConfluence} agreeing strategies FTH_MIN_CONFLUENCE asks for).`;
    }
    return null;
  }
  const fired = rec.candidates.length ? rec.candidates.map(c => `${c.name} ${c.direction}`).join(', ') : 'nothing';
  return `setup:${strategy} ${dir || ''} did not fire on the last closed ${fam} bar (closed ${rec.closedAt}; fired: ${fired}). Enter only on a strategy's own trigger; a different setup tag doesn't make it one.`;
}

/**
 * The last bar recorded for `root`'s index family on `timeframe` (its open
 * time, as the scan recorded it): { bar, timeframe } or { error }. The runner
 * records every bar it scans, so this is the bar a setup is on now; the gate
 * ties a policy verdict to it (prop-state.js).
 */
function lastRecordedBar(home, root, timeframe) {
  const fam = familyRoot(root);
  const tf = recordTimeframe(timeframe);
  if (!tf) return { error: `the strategy's timeframe (${timeframe}) names no signal record` };
  const rec = readSignals(home, root, tf);
  if (!rec) return { error: `no ${tf} signal record for ${fam}, so the bar the setup is on is unknown (the runner records one every bar)` };
  if (rec.error || !Number.isFinite(barMs(rec.asOf))) return { error: `the ${tf} signal record for ${fam} is unreadable (${rec.error || 'no bar time'}), so the bar the setup is on is unknown` };
  return { bar: rec.asOf, timeframe: tf };
}

module.exports = { DEFAULT_MAX_AGE_MIN, FUTURE_TOLERANCE_MIN, signalFile, buildSignals, writeSignals, readSignals, checkTrigger, barMs, sameBar, recordTimeframe, lastRecordedBar };
