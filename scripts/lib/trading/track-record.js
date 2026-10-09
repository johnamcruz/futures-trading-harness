'use strict';

/**
 * A strategy's track record, for the model to weigh a signal by: how the
 * strategy did in a backtest (recorded with `backtest.js --record`), in the
 * regime and at the hour of this bar, and in the reviewed trades of the
 * journal. The cycle prompt shows it next to every strategy that fired.
 *
 *   <FTH_HOME>/track-record/<strategy>.json
 *     { strategy, source: 'backtest', runId, symbols, timeframe, start, end,
 *       recordedAt, summary: { trades, winRate, meanR, meanRCI95, edge,
 *       profitFactorR }, byRegime: { <regime>: { trades, winRate, meanR } },
 *       byHour: { 'HH:00 ET': { ... } } }
 *
 * Reads only local files (the journal and the record); no network.
 */

const fs = require('fs');
const path = require('path');
const { stats, hourOf } = require('../backtest/report');
const { reviewResult, hasTag } = require('./journal');
const { reviewR } = require('./instincts');
const { zonedParts } = require('./clock');

const MIN_SLICE = 10; // a regime or hour with fewer trades is not shown

const recordFile = (home, strategy) => path.join(home, 'track-record', `${strategy}.json`);
const brief = s => ({ trades: s.trades, winRate: s.winRate, meanR: s.meanR });

/** The track record of `strategy` from a backtest report's trades. */
function fromReport(report, strategy) {
  const trades = (report.trades || []).filter(t => t.strategy === strategy);
  const group = key => {
    const out = {};
    for (const t of trades) (out[key(t)] = out[key(t)] || []).push(t);
    return Object.fromEntries(Object.entries(out).sort().map(([k, v]) => [k, brief(stats(v))]));
  };
  const s = stats(trades);
  const m = report.meta || {};
  return {
    strategy, source: 'backtest', runId: m.runId || null, symbols: m.symbols || null, timeframe: m.timeframe || null,
    start: m.start || null, end: m.end || null, recordedAt: new Date().toISOString(),
    summary: { trades: s.trades, winRate: s.winRate, meanR: s.meanR, meanRCI95: s.meanRCI95, edge: s.edge, profitFactorR: s.profitFactorR },
    byRegime: group(t => (t.setup && t.setup.regime) || 'unknown'),
    byHour: group(hourOf),
  };
}

function writeRecord(home, rec) {
  const file = recordFile(home, rec.strategy);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** The recorded backtest track record of `strategy`, or null (none, or unreadable). */
function readRecord(home, strategy) {
  try {
    const rec = JSON.parse(fs.readFileSync(recordFile(home, strategy), 'utf8'));
    return rec && rec.strategy === strategy && rec.summary ? rec : null;
  } catch (_err) {
    return null;
  }
}

/** The journal's reviewed trades of `strategy` (not paper): { trades, wins, losses, meanR, inRegime }. */
function liveRecord(entries, strategy, regime = null) {
  const reviews = entries.filter(e => e.kind === 'review' && reviewResult(e) !== null && !hasTag(e, 'paper') && hasTag(e, `setup:${strategy}`));
  const sum = list => {
    const rs = list.map(reviewR).filter(Number.isFinite);
    return {
      trades: list.length, wins: list.filter(r => reviewResult(r) === 'win').length, losses: list.filter(r => reviewResult(r) === 'loss').length,
      meanR: rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null,
    };
  };
  return { ...sum(reviews), inRegime: regime ? sum(reviews.filter(r => hasTag(r, `regime:${regime}`))) : null };
}

const sR = x => (x === null || x === undefined ? '?' : `${x >= 0 ? '+' : ''}${Math.round(x * 100) / 100}R`);
const pct = x => (x === null || x === undefined ? '?' : `${Math.round(x * 100)}%`);

/**
 * One line for the prompt: the backtest record overall, in this bar's regime
 * and hour, and the live reviews. `at`: the bar's close time.
 */
function describeRecord({ backtest = null, live = null, regime = null, at = null } = {}) {
  const parts = [];
  if (backtest) {
    const s = backtest.summary;
    const span = [backtest.symbols && backtest.symbols.join(','), backtest.timeframe && `${backtest.timeframe}m`, backtest.start && backtest.end && `${String(backtest.start).slice(0, 10)}..${String(backtest.end).slice(0, 10)}`].filter(Boolean).join(' ');
    parts.push(`backtest ${s.trades} trades (${span}): win ${pct(s.winRate)}, E ${sR(s.meanR)}${s.meanRCI95 ? ` [95% CI ${sR(s.meanRCI95[0])}, ${sR(s.meanRCI95[1])}]` : ''}, edge ${s.edge}`);
    const reg = regime && backtest.byRegime && backtest.byRegime[regime];
    if (reg && reg.trades >= MIN_SLICE) parts.push(`in ${regime}: ${reg.trades} trades, E ${sR(reg.meanR)}`);
    if (at) {
      const p = zonedParts(new Date(at), 'America/New_York');
      const h = backtest.byHour && backtest.byHour[`${String(p.hour).padStart(2, '0')}:00 ET`];
      if (h && h.trades >= MIN_SLICE) parts.push(`at ${String(p.hour).padStart(2, '0')}:00 ET: ${h.trades} trades, E ${sR(h.meanR)}`);
    }
  } else {
    parts.push('no backtest recorded (backtest.js --record)');
  }
  if (live && live.trades) {
    parts.push(`live: ${live.trades} reviewed, ${live.wins}W/${live.losses}L, E ${sR(live.meanR)}${live.inRegime && live.inRegime.trades ? ` (in ${regime}: ${live.inRegime.trades}, E ${sR(live.inRegime.meanR)})` : ''}`);
  } else {
    parts.push('live: no reviewed trades yet');
  }
  return `track record: ${parts.join('; ')}`;
}

module.exports = { MIN_SLICE, recordFile, fromReport, writeRecord, readRecord, liveRecord, describeRecord };
