'use strict';

/**
 * The live runner wired to the harness: the broker adapter, the harness home's
 * files (bars, records, logs, journal), the strategies, and the prompt's
 * context sources. scripts/autotrader.js uses it for the long-running loop
 * and, under a replay clock, for one pass per process (`--once`), so a
 * replayed cycle is built exactly as a live one.
 *
 *   openRunnerBroker({ cfg, root, env })   the adapter, verified; throws when a live run can't manage positions
 *   closedBarsOnly(client, now)           the adapter, bars closing after now() dropped (replay)
 *   replayUnattested(serverConfig, at)     why a replay server doesn't attest the replayed time, or null
 *   wireRunner({ cfg, root, home, env, client, prop, dataDir, now, runCycle,
 *                loadState, saveState, killSwitchFile, log, event })   createRunner(...) with every dependency
 *   reportCacheFor(home, cfg)             the runner's report cache (report-cache.js), or null for a harness whose
 *                                         cycle output doesn't carry its roles' reports
 */

const fs = require('fs');
const path = require('path');
const { createRunner } = require('./runner');
const { SERVER_TIME_TOLERANCE_MS } = require('./trading/harness-now');
const { openAdapter, tradingBlocked } = require('./broker/adapter');
const { dayKey } = require('./autotrader');
const { dayContextSeries, describeDay, describeOvernight } = require('./trading/day-context');
const { premarketPlan, newsLine } = require('./trading/session-context');
const { readBlackouts } = require('./trading/check-order');
const { readRecord, liveRecord, describeRecord, excursionNote } = require('./trading/track-record');
const { loadStrategies, scan } = require('./trading/strategies');
const { scanRecord, appendJsonl } = require('./trading/scan-log');
const { loadConfig } = require('./trading/config');
const { writeJsonAtomic, entryOrders } = require('./harness-run');
const { writeMtfRecord } = require('./trading/mtf-state');
const { buildBriefing, readBriefing, writeBriefing, removeBriefing } = require('./trading/briefing');
const { buildSignals, writeSignals } = require('./trading/signal-state');
const RC = require('./trading/report-cache');
const { tradingDayKey } = require('./trading/clock');
const { digest, recentTrades, formSummary } = require('./trading/instincts');
const { resolveJournalPath, readJournal } = require('./trading/journal');

/** The broker adapter for the runner: every interface tool, and (live, with an account) a server that trades. */
async function openRunnerBroker({ cfg, root, env = process.env, open = openAdapter }) {
  const client = open({ root, env });
  try {
    await client.verify();
    // A live run manages its positions (trailing stops, exits, leftover cancels): the server must accept those.
    const why = !cfg.paper && cfg.account ? tradingBlocked(await client.serverConfig(), cfg.account) : null;
    if (why) throw new Error(why);
    return client;
  } catch (err) {
    client.close();
    throw err;
  }
}

/**
 * Why a replay server's get_server_config doesn't attest the replayed time
 * `at` (replay: true, serverTime within the gateway's tolerance), or null.
 * A replay pass checks it before anything (as the gateway does before an order).
 */
function replayUnattested(config, at) {
  if (!config || config.replay !== true) return 'the broker server does not report itself a replay server (get_server_config.replay)';
  const t = Date.parse(String(config.serverTime || ''));
  if (!Number.isFinite(t) || Math.abs(t - at.getTime()) > SERVER_TIME_TOLERANCE_MS) return `the replay server's time (${config.serverTime}) is not the replayed time (${at.toISOString()})`;
  return null;
}

/**
 * The adapter with bars that closed after `now()` dropped (a replay pass: no
 * forming or future bar, whatever the replay server returns).
 */
function closedBarsOnly(client, now) {
  return {
    ...client,
    closedBars: async (contractId, opts) => {
      const step = (opts.daily ? 1440 : opts.minutes) * 60000;
      return (await client.closedBars(contractId, opts)).filter(b => Date.parse(b.t) + step <= now().getTime());
    },
  };
}

/**
 * The runner's scan of one symbol's closed bar: the strategies on its timeframe (only they can be
 * judged from these bars), with the runner's symbols as the selected contracts (a rules strategy
 * trades the selected leg of its family; strategies.js rootRefusal).
 */
function runnerScan(strategies, cfg, symbol, bars, now) {
  const sameTf = strategies.filter(s => s.timeframe === `${cfg.timeframe}m`);
  return scan(sameTf, { bars }, { symbol, now, selected: cfg.symbols });
}

/**
 * The runner's bar-briefing step: each part kept from the last briefing until it expires (trading/briefing.js). A
 * build that fails removes the file, so an earlier bar's briefing is never read as this one's.
 */
function briefingRecorder(home, cfg, now, env = process.env) {
  return (item, results, scanError = null) => {
    try {
      // The news blackouts (premarket records them): the briefing says which is in force or next.
      let blackouts = null;
      try { blackouts = readBlackouts(loadConfig(env).blackoutsFile); } catch (err) { blackouts = { items: [], error: err.message }; }
      return writeBriefing(home, buildBriefing({ symbol: item.symbol, contractId: item.contractId || null, bars: item.bars, minutes: cfg.timeframe, prev: readBriefing(home, item.symbol), scan: results, scanError, blackouts, now: now() }));
    } catch (err) {
      removeBriefing(home, item.symbol);
      throw err;
    }
  };
}

/**
 * The report cache over the harness home: the briefings the runner recorded for this bar decide which analyst
 * reports still hold, the account decides phase 1's. Claude and opencode stream their cycle's tool results (each
 * role's report) to the runner; other harnesses run every role every cycle. A lean cycle runs no analysts.
 */
function reportCacheFor(home, cfg) {
  if (!['claude', 'opencode'].includes(cfg.harness)) return null;
  const briefings = symbols => Object.fromEntries(symbols.map(s => [s.symbol, readBriefing(home, s.symbol)]));
  return {
    serve: ({ symbols, account, now }) => {
      const s = RC.serveReports({ cache: RC.readCache(home), briefings: briefings(symbols), symbols, account, day: tradingDayKey(now) });
      const reports = cfg.cycle === 'lean' ? s.reports.filter(r => r.role === RC.PHASE1) : s.reports;
      return { roles: reports.map(r => r.role), reports };
    },
    record: ({ symbols, account, now, output, served }) => {
      try {
        return RC.writeCache(home, RC.recordReports({ prev: RC.readCache(home), output, served, briefings: briefings(symbols), symbols, account, day: tradingDayKey(now), now }));
      } catch (err) {
        RC.removeCache(home); // a cache that can't be written is none: every role runs next cycle
        throw err;
      }
    },
  };
}

function wireRunner({ cfg, root, home, env = process.env, client, prop = null, dataDir, now, runCycle, loadState, saveState, killSwitchFile, log, event }) {
  const strategies = () => loadStrategies(root, env).strategies;
  const journal = () => readJournal(resolveJournalPath(env));
  return createRunner({
    cfg,
    prop,
    root,
    client,
    clock: { now },
    runCycle,
    isKillSwitchOn: () => fs.existsSync(killSwitchFile),
    createKillSwitch: reason => fs.writeFileSync(killSwitchFile, `${reason}\n`),
    loadState,
    saveState,
    writeBars: (sym, bars) => {
      const file = path.join(dataDir, `${sym.symbol}-${cfg.timeframe}m.json`);
      writeJsonAtomic(file, { contractId: sym.contractId, barSize: `${cfg.timeframe} minute`, count: bars.length, bars });
      return file;
    },
    recordMtf: (sym, bars) => writeMtfRecord(home, sym.symbol, bars, { now: now() }).line,
    // A strategy's track record (trading/track-record.js): its recorded backtest and the journal's reviews.
    trackRecord: (name, { regime, at, entries }) => describeRecord({
      backtest: readRecord(home, name), live: liveRecord(entries || journal(), name, regime), regime, at,
      file: (strategies().find(s => s.name === name) || {}).file || null,
    }),
    // The day so far (trading/day-context.js), one line for the prompt; levels on the contract's tick.
    dayContext: (sym, bars) => {
      const tick = sym.tickSize > 0 ? sym.tickSize : 0.25;
      const round = x => Number((Math.round(x / tick) * tick).toFixed(6));
      // In RTH the day so far; outside it, the overnight session against the prior day.
      return describeDay(dayContextSeries(bars).day.at(-1), { symbol: sym.symbol, round }) || describeOvernight(bars, { symbol: sym.symbol, round });
    },
    // The prompt shows each fact once: mistakes and lessons here; live results in the track records;
    // the last reviewed trades' record on their own line.
    lessons: ({ entries } = {}) => digest(entries || journal(), 5, { kinds: ['mistake', 'lesson'], form: false }),
    recentTrades: ({ entries } = {}) => recentTrades(entries || journal(), 10),
    tradesSummary: ({ entries } = {}) => formSummary(entries || journal(), 10),
    premarketPlan: (symbol, entries, at) => premarketPlan(entries, symbol, at),
    news: at => newsLine(readBlackouts(loadConfig(env).blackoutsFile), at),
    journalEntries: journal,
    tradeHistory: t => excursionNote(readRecord(home, t.setup), t),
    // The bar briefing, each part kept from the last one until it expires or is invalidated (trading/briefing.js).
    recordBriefing: briefingRecorder(home, cfg, now, env),
    reportCache: reportCacheFor(home, cfg),
    recordSignals: (item, results) => writeSignals(home, buildSignals(results, { symbol: item.symbol, bar: item.bar, stepMs: cfg.timeframe * 60000, now: now() })),
    scanFor: (symbol, bars) => runnerScan(strategies(), cfg, symbol, bars, now()),
    log,
    // The decision log: every scanned bar, every strategy's verdict and why (logs/scans-<day>.jsonl).
    scanLog: rec => appendJsonl(path.join(home, 'logs', `scans-${dayKey(new Date(rec.at))}.jsonl`), scanRecord(rec)),
    // The event log: cycles, account reads, positions managed, stops moved, closes, flattens, errors (logs/events-<day>.jsonl).
    event,
    entryOrders: () => entryOrders(home),
    strategyNamed: name => strategies().find(s => s.name === name && s.valid) || null,
  });
}

module.exports = { openRunnerBroker, wireRunner, briefingRecorder, reportCacheFor, runnerScan, replayUnattested, closedBarsOnly };
