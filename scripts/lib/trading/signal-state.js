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
 * closed at most FTH_SIGNAL_MAX_AGE_BARS (3) bars of the signal's own
 * timeframe ago (3 min on 1m, 9 min on 3m, 45 min on 15m; signalMaxAgeMin): no
 * entry without its trigger, under any setup tag, and no entry on a stale
 * signal. A timeframe it can't read counts as 1 minute, the strictest.
 */

const fs = require('fs');
const path = require('path');
const { familyRoot } = require('./contracts');

const DEFAULT_MAX_AGE_BARS = 3;
// However slow the timeframe, a signal is never entered more than this long after its bar closed (the owner's ceiling).
const MAX_AGE_CEILING_MIN = 45;
// How far after now a bar's close may be dated and still be trusted: the broker's clock may run a
// little ahead of the harness's (order_plan applies the same tolerance to the bars it plans from).
const FUTURE_TOLERANCE_MIN = 1;

// One record per index family and timeframe: a 1m scan never overwrites the 3m one.
const signalFile = (home, root, timeframe) => path.join(home, 'signals', `${familyRoot(root)}-${timeframe}.json`);
const tfOf = stepMs => `${Math.round(stepMs / 60000)}m`;

/** The record for scan `results` on the bar `bar` ({ t }) of `symbol`, `stepMs` long. */
function buildSignals(results, { symbol, bar, stepMs, now = new Date(), source = null, retiredLane = null }) {
  return {
    symbol: String(symbol || '').toUpperCase(),
    timeframe: tfOf(stepMs),
    asOf: bar.t,
    closedAt: new Date(Date.parse(bar.t) + stepMs).toISOString(),
    recordedAt: now.toISOString(),
    source,
    candidates: (results || []).filter(r => r.candidate && r.direction && r.signal === 'rules')
      .map(r => ({ name: r.name, direction: r.direction, stopDistance: r.stopDistance ?? null, ...(r.confluence ? { confluence: r.confluence } : {}) })),
    // The runner's lane on this timeframe lists a retired strategy (lanes.js retireLanes): it enters nothing.
    ...(Array.isArray(retiredLane) && retiredLane.length ? { retiredLane } : {}),
  };
}

/**
 * The gate's check for any strategy's entry (rules, manual or policy) on `timeframe`: refused while the latest
 * record of that timeframe says the runner's lane there lists a retired strategy (it enters nothing). A message, or null.
 */
function retiredLaneRefusal(home, { root, strategy, timeframe }) {
  if (!home || !timeframe) return null;
  const rec = readSignals(home, root, timeframe);
  if (!rec || rec.error || !Array.isArray(rec.retiredLane) || !rec.retiredLane.length) return null;
  return `setup:${strategy} trades ${timeframe} bars, and the runner's ${timeframe} lane lists ${rec.retiredLane.map(n => `${n}${require('./strategies').retiredNote(n)}`).join(', ')}: that lane enters nothing, under any setup tag. Exits and protective stops ([exit], [protect]) still go. To trade on ${timeframe} again, remove the retired name from the runner config's lanes (or the lane) and restart the runner: its start clears this mark.`;
}

/**
 * At the runner's start, before any cycle: the retired mark on each of its symbols' records, for exactly the
 * timeframes of its lanes that list a retired strategy (lanes.js retireLanes). A retired lane's timeframe gets the mark
 * now (an older unmarked record could hold a still-fresh candidate until the lane's first bar), with its candidates
 * emptied; a mark on any other timeframe (a lane fixed or deleted since) is cleared. `lanes`: the runner's lanes.
 * Returns what it changed: [{ file, timeframe, marked: [names] | null }].
 */
function syncRetiredMarks(home, { symbols = [], lanes = [], now = new Date() }) {
  const retired = new Map(lanes.filter(l => Array.isArray(l.retired) && l.retired.length).map(l => [`${l.timeframe}m`, l.retired]));
  const roots = new Set(symbols.map(familyRoot));
  const changed = [];
  const write = (file, rec, timeframe, marked) => { writeSignals(home, rec); changed.push({ file, timeframe, marked }); };
  for (const symbol of symbols) {
    for (const [timeframe, names] of retired) {
      const old = readSignals(home, symbol, timeframe);
      const base = old && !old.error ? old : { symbol: String(symbol).toUpperCase(), timeframe, asOf: now.toISOString(), closedAt: now.toISOString(), source: null };
      write(signalFile(home, symbol, timeframe), { ...base, symbol: base.symbol || String(symbol).toUpperCase(), timeframe, recordedAt: now.toISOString(), candidates: [], retiredLane: names }, timeframe, names);
    }
  }
  let files;
  try { files = fs.readdirSync(path.join(home, 'signals')).filter(f => /^[A-Z0-9]+-\d+m\.json$/.test(f)); } catch (_err) { files = []; }
  for (const f of files) {
    const [root, tf] = f.replace(/\.json$/, '').split('-');
    if (!roots.has(root) || retired.has(tf)) continue;
    const rec = readSignals(home, root, tf);
    if (!rec || rec.error || !rec.retiredLane) continue;
    const { retiredLane: _gone, ...rest } = rec;
    write(signalFile(home, root, tf), { ...rest, symbol: rest.symbol || root, timeframe: tf, recordedAt: now.toISOString() }, tf, null);
  }
  return changed;
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

/**
 * How old (minutes after its bar closed) a signal on `timeframe` may be: `bars` of that timeframe, never over
 * MAX_AGE_CEILING_MIN (45: 1h and 15m signals both get 45), an unreadable timeframe counted as 1 minute (the
 * strictest) and a bar count that isn't a whole number >= 1 as 1 bar; `capMin` (FTH_SIGNAL_MAX_AGE_MIN, when set)
 * only ever shortens it.
 */
function signalMaxAgeMin(timeframe, { bars = DEFAULT_MAX_AGE_BARS, capMin = null, ceilingMin = MAX_AGE_CEILING_MIN } = {}) {
  const tf = recordTimeframe(timeframe);
  const minutes = tf ? Number(tf.slice(0, -1)) : 1;
  const n = Number.isInteger(bars) && bars >= 1 ? bars : 1;
  // A ceiling that isn't a positive number is the owner's 45 (never "no ceiling").
  const ceiling = Number.isFinite(ceilingMin) && ceilingMin > 0 ? ceilingMin : MAX_AGE_CEILING_MIN;
  const limit = Math.min(n * minutes, ceiling);
  return Number.isFinite(capMin) && capMin > 0 ? Math.min(limit, capMin) : limit;
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
function checkTrigger(home, { root, side, strategy, style = 'trend', timeframe: given, now = new Date(), maxAgeBars = DEFAULT_MAX_AGE_BARS, maxAgeCapMin = null, maxAgeCeilingMin = MAX_AGE_CEILING_MIN, minConfluence = 1 }) {
  const fam = familyRoot(root);
  // The record read is the 3m one when no timeframe is given; the age, the strictest (1 minute a bar).
  const timeframe = given === undefined ? '3m' : given;
  const maxAgeMin = signalMaxAgeMin(given, { bars: maxAgeBars, capMin: maxAgeCapMin, ceilingMin: maxAgeCeilingMin });
  const ceilingBinds = signalMaxAgeMin(given, { bars: maxAgeBars, ceilingMin: maxAgeCeilingMin }) < signalMaxAgeMin(given, { bars: maxAgeBars, ceilingMin: Number.MAX_SAFE_INTEGER });
  const how = `Fetch fresh ${timeframe} bars (the harness tool bars_fetch {"symbol": "${root}", "timeframe": ${parseInt(timeframe, 10) || '<minutes>'}}), then scan and record them: strategies_scan {"bars": "<that file>", "symbol": "${root}", "record": true}. The autonomous runner records every bar; while it runs, recording yourself is refused.`;
  const rec = readSignals(home, root, timeframe);
  if (!rec) return `No ${timeframe} signal record for ${fam}: setup:${strategy} is a rules strategy, and the gate needs to see its trigger fire. ${how}`;
  if (rec.error || !Array.isArray(rec.candidates) || !rec.closedAt) return `The signal record for ${fam} is unreadable (${rec.error || 'missing fields'}). ${how}`;
  const age = (now.getTime() - Date.parse(rec.closedAt)) / 60000;
  if (age < -FUTURE_TOLERANCE_MIN) return `The signal record for ${fam} is dated ${rec.closedAt}, after now; it can't be trusted. ${how}`;
  if (!(age <= maxAgeMin)) {
    return `The last recorded signal bar for ${fam} closed ${Number.isFinite(age) ? `${Math.round(age)} min` : 'an unknown time'} ago (limit ${maxAgeMin} min: ${maxAgeBars} ${recordTimeframe(given) ? given : '1-minute (no readable timeframe)'} bar${maxAgeBars === 1 ? '' : 's'}, FTH_SIGNAL_MAX_AGE_BARS${ceilingBinds ? `, at most ${signalMaxAgeMin(given, { bars: maxAgeBars, ceilingMin: maxAgeCeilingMin })} min` : ''}${maxAgeCapMin ? `, capped at ${maxAgeCapMin} min by FTH_SIGNAL_MAX_AGE_MIN` : ''}): the setup has expired. ${how}`;
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

module.exports = { retiredLaneRefusal, syncRetiredMarks, DEFAULT_MAX_AGE_BARS, MAX_AGE_CEILING_MIN, signalMaxAgeMin, FUTURE_TOLERANCE_MIN, signalFile, buildSignals, writeSignals, readSignals, checkTrigger, barMs, sameBar, recordTimeframe, lastRecordedBar };
