'use strict';

/**
 * The signal record the order gate reads: which rules strategies fired, and
 * on which side, on the last closed bar of an index family, at
 * <FTH_HOME>/signals/<MICRO ROOT>.json.
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
  const file = signalFile(home, record.symbol, record.timeframe);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
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
  const how = `Fetch fresh ${timeframe} bars (node <root>/scripts/bars.js --symbol ${root} --timeframe ${parseInt(timeframe, 10) || '<minutes>'}), then scan and record them: node <root>/scripts/strategies.js scan <that file> --symbol ${root} --record. The autonomous runner records every bar.`;
  const rec = readSignals(home, root, timeframe);
  if (!rec) return `No ${timeframe} signal record for ${fam}: setup:${strategy} is a rules strategy, and the gate needs to see its trigger fire. ${how}`;
  if (rec.error || !Array.isArray(rec.candidates) || !rec.closedAt) return `The signal record for ${fam} is unreadable (${rec.error || 'missing fields'}). ${how}`;
  const age = (now.getTime() - Date.parse(rec.closedAt)) / 60000;
  if (age < -1) return `The signal record for ${fam} is dated ${rec.closedAt}, after now; it can't be trusted. ${how}`;
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

module.exports = { DEFAULT_MAX_AGE_MIN, signalFile, buildSignals, writeSignals, readSignals, checkTrigger };
