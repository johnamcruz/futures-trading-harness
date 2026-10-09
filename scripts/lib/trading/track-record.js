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
 *       byHour: { 'HH:00 ET': { ... } }, excursions }
 *
 *   excursions (from each trade's MFE / MAE in R): how far winners ran
 *   (median best), how deep winners dipped before working (the MAE that 80%
 *   of them stayed above), how far losers got before failing, and how often
 *   a trade that reached +1R ended at or below 0. The open-trade line in the
 *   prompt compares a live trade with them.
 *
 * Reads only local files (the journal and the record); no network.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { stats, hourOf } = require('../backtest/report');
const { reviewResult, hasTag } = require('./journal');
const { reviewR } = require('./instincts');
const { zonedParts } = require('./clock');

const MIN_SLICE = 10; // a regime or hour with fewer trades is not shown

/** The value at quantile q (0..1) of `xs`, nearest rank; null when empty. */
function quantile(xs, q) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

const r2 = x => (x === null ? null : Math.round(x * 100) / 100);

/** The excursion profile of `trades` ({ r, mfeR, maeR }). */
function excursions(trades) {
  const winners = trades.filter(t => t.r > 0);
  const losers = trades.filter(t => t.r <= 0);
  const reached = trades.filter(t => t.mfeR >= 1);
  return {
    winners: winners.length, losers: losers.length,
    winnersMedianMfeR: r2(quantile(winners.map(t => t.mfeR), 0.5)),
    // 80% of winners never went below this (their 20th-percentile MAE).
    winnersMaeFloorR: r2(quantile(winners.map(t => t.maeR), 0.2)),
    losersMedianMfeR: r2(quantile(losers.map(t => t.mfeR), 0.5)),
    reached1R: reached.length,
    gaveBackAfter1R: reached.length ? r2(reached.filter(t => t.r <= 0).length / reached.length) : null,
  };
}

const recordFile = (home, strategy) => path.join(home, 'track-record', `${strategy}.json`);
const brief = s => ({ trades: s.trades, winRate: s.winRate, meanR: s.meanR });

/** A fingerprint of a strategy's definition (its STRATEGY.md), so an edited strategy's old record shows as stale. */
function definitionHash(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch (_err) {
    return null;
  }
}

/** The track record of `strategy` from a backtest report's trades; `file`: its STRATEGY.md. */
function fromReport(report, strategy, { file = null } = {}) {
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
    start: m.start || null, end: m.end || null, recordedAt: new Date().toISOString(), definition: file ? definitionHash(file) : null,
    summary: { trades: s.trades, winRate: s.winRate, meanR: s.meanR, meanRCI95: s.meanRCI95, edge: s.edge, profitFactorR: s.profitFactorR },
    byRegime: group(t => (t.setup && t.setup.regime) || 'unknown'),
    byHour: group(hourOf),
    excursions: excursions(trades),
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
function describeRecord({ backtest = null, live = null, regime = null, at = null, file = null } = {}) {
  const parts = [];
  // Recorded from another version of the strategy: say so, the numbers may not apply.
  const stale = backtest && file && backtest.definition && definitionHash(file) !== backtest.definition;
  if (stale) parts.push('STALE: the STRATEGY.md changed since this backtest was recorded; re-record it');
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

/**
 * How an open trade compares with the strategy's recorded excursions, for its
 * prompt line: "value_area winners: median best +2.4R; 80% stayed above -0.6R
 * (this one is at -0.95R: deeper than most winners)". Null without enough trades.
 */
function excursionNote(rec, { maeR = null, mfeR = null, rNow = null } = {}) {
  const x = rec && rec.excursions;
  if (!x || x.winners < MIN_SLICE) return null;
  const sR = v => `${v >= 0 ? '+' : ''}${v}R`;
  const parts = [`${rec.strategy} winners in its backtest: median best ${sR(x.winnersMedianMfeR)}, 80% never went below ${sR(x.winnersMaeFloorR)}`];
  if (maeR !== null && x.winnersMaeFloorR !== null && maeR < x.winnersMaeFloorR) parts.push(`this trade's worst ${sR(maeR)} is deeper than 80% of its winners went`);
  if (mfeR !== null && mfeR >= 1 && x.gaveBackAfter1R !== null && x.reached1R >= MIN_SLICE) {
    parts.push(`${Math.round(x.gaveBackAfter1R * 100)}% of its trades that reached +1R ended at or below 0${rNow !== null ? ` (this one: best ${sR(mfeR)}, now ${sR(rNow)})` : ''}`);
  }
  return parts.join('; ');
}

module.exports = { MIN_SLICE, recordFile, definitionHash, fromReport, excursions, excursionNote, quantile, writeRecord, readRecord, liveRecord, describeRecord };
