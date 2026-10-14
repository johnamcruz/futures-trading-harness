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
 *                loadState, saveState, killSwitchFile, log, event, onBarClosed, agents })   createRunner(...) with every
 *                                         dependency; onBarClosed(symbol, { bar, stale, action, contractId, values }) hears each closed bar the runner polls
 *                                         (barRecorder: its bars archived, the strategies' field values taken)
 *   reportCacheFor(home, cfg, frames)     the runner's report cache (report-cache.js), or null for a harness whose
 *                                         cycle output doesn't carry its roles' reports
 *   briefingRecorder(home, cfg, now, env, { frames, dataDir, log })   the bar briefing of each bar, and of each
 *                                         analyst's own timeframe (frames: lanes.js analystFrames)
 *
 * An analyst on its own timeframe (the runner config's `agents`, an agent file's `timeframe`): its briefing is built
 * from that lane's bars, or from the first lane's whole bars (15m and 1h from 3m: their bars file is written next to
 * the lane's, OHLCV only), and its report is cached on it (report-cache.js).
 */

const fs = require('fs');
const path = require('path');
const { createRunner } = require('./runner');
const { SERVER_TIME_TOLERANCE_MS } = require('./trading/harness-now');
const { cutAtClock } = require('./trading/look-ahead');
const { openAdapter, liveRunBlocked } = require('./broker/adapter');
const { activeBroker } = require('./broker/config');
const { dayKey } = require('./autotrader');
const { dayContextSeries, describeDay, describeOvernight } = require('./trading/day-context');
const { premarketPlan, newsLine, unreviewedLine } = require('./trading/session-context');
const { readBlackouts } = require('./trading/check-order');
const { readRecord, liveRecord, describeRecord, excursionNote } = require('./trading/track-record');
const { loadStrategies, scan } = require('./trading/strategies');
const { lanesOf, laneStrategies, analystFrames } = require('./lanes');
const { loadAgents } = require('./harness-sync');
const { candles } = require('./trading/mtf');
const { scanRecord, appendJsonl } = require('./trading/scan-log');
const { loadConfig } = require('./trading/config');
const { writeJsonAtomic, entryOrders } = require('./harness-run');
const { writeMtfRecord, readRecord: readMtfRecord } = require('./trading/mtf-state');
const { buildBriefing, readBriefing, writeBriefing, removeBriefing, buildFrameBriefing, readFrameBriefing, writeFrameBriefing, removeFrameBriefing } = require('./trading/briefing');
const { buildSignals, writeSignals } = require('./trading/signal-state');
const RC = require('./trading/report-cache');
const { tradingDayKey } = require('./trading/clock');
const { digest, recentTrades, formSummary } = require('./trading/instincts');
const { resolveJournalPath, readJournal } = require('./trading/journal');
const { barsArchiver } = require('./session/bars-archive');
const { fieldValues } = require('./session/record');

/** The broker adapter for the runner: every interface tool, and (live, with an account) a server that trades. */
async function openRunnerBroker({ cfg, root, env = process.env, open = openAdapter, broker = null }) {
  const client = open({ root, env });
  try {
    await client.verify();
    // A live run manages its positions (trailing stops, exits, leftover cancels): the server must accept those,
    // and trades only an account on the broker's allow-list (a confirmed replay is exempt).
    const why = !cfg.paper ? liveRunBlocked({ broker: broker || activeBroker(env), config: await client.serverConfig(), env, accountId: cfg.account }) : null;
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
      return cutAtClock(await client.closedBars(contractId, opts), now(), { stepMs: step });
    },
  };
}

/**
 * The runner's scan of one symbol's closed bar: the strategies of its lane (lanes.js; those on its
 * timeframe, the only ones that can be judged from these bars), with the runner's symbols as the
 * selected contracts (a rules strategy trades the selected leg of its family; strategies.js rootRefusal).
 * `lane`: the lane whose bar closed (none: the runner's first lane).
 */
function runnerScan(strategies, cfg, symbol, bars, now, lane = lanesOf(cfg)[0]) {
  return scan(laneStrategies(strategies, lane), { bars }, { symbol, now, selected: cfg.symbols });
}

/**
 * The session record's side of the runner's bars (R35). `closed(symbol, info)`: a closed bar the runner polled,
 * its window archived with every field (session/bars-archive.js), passed on to onBarClosed without the bars.
 * `scanned(symbol, bars, strategies, results)`: the bar's scan ran; the broker field values of exactly the
 * strategies it scanned (by name, from its results: a disabled one, one that doesn't trade the symbol, or one
 * outside the lane is never there) go to onBarClosed as `values` (session/record.js fieldValues), joined to
 * the bar's entry by the pass tap. Neither ever throws.
 */
function barRecorder({ cfg, home, env, now, log, onBarClosed }) {
  const archive = barsArchiver({ home, env, minutes: cfg.timeframe, now, log });
  const contracts = new Map();
  return {
    closed(symbol, info = {}) {
      const { bars, ...rest } = info;
      contracts.set(symbol, info.contractId || null);
      // The archive is the runner's timeframe: the first lane's bars (`minutes`: several lanes, the bar's lane).
      const first = !info.minutes || info.minutes === cfg.timeframe;
      if (first && Array.isArray(bars) && bars.length) archive(symbol, { bars, contractId: info.contractId || null });
      return onBarClosed(symbol, rest);
    },
    // `minutes`: several lanes, the lane scanned (its values join that lane's bar).
    scanned(symbol, bars, strategies, results, minutes) {
      try {
        const names = new Set((results || []).map(r => r && r.name));
        const values = fieldValues(strategies.filter(s => names.has(s.name)), bars);
        onBarClosed(symbol, { bar: bars[bars.length - 1].t, contractId: contracts.get(symbol) || null, values, ...(minutes ? { minutes } : {}) });
      } catch (err) {
        log(`${symbol}: no field values recorded (${err.message})`, 'error');
      }
    },
  };
}

/**
 * The runner's bar-briefing step: each part kept from the last briefing until it expires (trading/briefing.js). A
 * build that fails removes the file, so an earlier bar's briefing is never read as this one's.
 */
function briefingRecorder(home, cfg, now, env = process.env, { frames = [], dataDir = null, log = () => {} } = {}) {
  // The analysts' own timeframes: built from the first lane's bars, or another lane's (its bars when they close).
  const built = [...new Set(frames.filter(f => f.lane < 0).map(f => f.minutes))];
  const laned = new Set(frames.filter(f => f.lane > 0).map(f => f.minutes));
  // The news blackouts (premarket records them): the briefing says which is in force or next. The gate's entry clock
  // (FTH_ENTRY_HOURS, FTH_NO_ENTRY_WINDOWS): the briefing says what the gate will do; a config that can't be read:
  // entries unknown, so none (the gate fails closed on it too).
  const facts = () => {
    let blackouts;
    try { blackouts = readBlackouts(loadConfig(env).blackoutsFile); } catch (err) { blackouts = { items: [], error: err.message }; }
    let clock;
    try { const c = loadConfig(env); clock = { entryHours: c.entryHours, noEntryWindows: c.noEntryWindows }; } catch (err) { clock = { error: err.message }; }
    return { blackouts, clock };
  };
  // One timeframe's briefing; a failure removes it (an older bar's is never read as this one's) and is logged.
  const frame = (item, minutes, { bars: barsOf, lane = false, scan = null, scanError = null, barsFile = null }) => {
    try {
      const prev = readFrameBriefing(home, item.symbol, minutes);
      const bars = barsOf();
      if (!bars.length) throw new Error(`no whole ${minutes}m bar in the ${cfg.timeframe}m bars`);
      // Built from the first lane's bars: the same last whole bar is the same briefing (kept until its next close).
      if (!lane && prev && prev.asOf === bars[bars.length - 1].t && (prev.contractId || null) === (item.contractId || null)) return;
      let file = barsFile;
      if (!lane && dataDir) {
        file = path.join(dataDir, `${item.symbol}-${minutes}m.json`);
        writeJsonAtomic(file, { contractId: item.contractId || null, barSize: `${minutes} minute`, builtFrom: `${cfg.timeframe} minute`, count: bars.length, bars });
      }
      writeFrameBriefing(home, buildFrameBriefing({ symbol: item.symbol, contractId: item.contractId || null, bars, minutes, first: readBriefing(home, item.symbol), lane, scan, scanError, barsFile: file, ...facts(), now: now() }));
    } catch (err) {
      removeFrameBriefing(home, item.symbol, minutes);
      log(`${item.symbol}: no ${minutes}m bar briefing this bar (${err.message}); the ${minutes}m analysts read the bars themselves`, 'error');
    }
  };
  const whole = (bars, minutes) => candles(bars, minutes).filter(c => c.complete).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  return (item, results, scanError = null) => {
    if (item.lane > 0) {
      if (laned.has(item.minutes)) frame(item, item.minutes, { bars: () => item.bars, lane: true, scan: results, scanError, barsFile: (item.bar && item.bar.file) || null });
      return null;
    }
    const file = firstBriefing(item, results, scanError);
    for (const m of built) frame(item, m, { bars: () => whole(item.bars, m) });
    return file;
  };

  function firstBriefing(item, results, scanError) {
    try {
      const { blackouts, clock } = facts();
      return writeBriefing(home, buildBriefing({ symbol: item.symbol, contractId: item.contractId || null, bars: item.bars, minutes: cfg.timeframe, prev: readBriefing(home, item.symbol), scan: results, scanError, blackouts, clock, now: now() }));
    } catch (err) {
      removeBriefing(home, item.symbol);
      // The timeframes built from it share its parts: none without it.
      for (const m of built) removeFrameBriefing(home, item.symbol, m);
      throw err;
    }
  }
}

/**
 * The report cache over the harness home: the briefings the runner recorded for this bar decide which analyst
 * reports still hold, the account decides phase 1's. Claude and opencode stream their cycle's tool results (each
 * role's report) to the runner; other harnesses run every role every cycle. A lean cycle runs no analysts.
 */
function reportCacheFor(home, cfg, frames = []) {
  if (!['claude', 'opencode'].includes(cfg.harness)) return null;
  const briefings = symbols => Object.fromEntries(symbols.map(s => [s.symbol, readBriefing(home, s.symbol)]));
  // The analysts on their own timeframe (role -> minutes) and those timeframes' briefings.
  const roles = Object.fromEntries(frames.map(f => [f.role, f.minutes]));
  const tfs = [...new Set(frames.map(f => f.minutes))];
  const own = symbols => ({ frames: roles, frameBriefings: Object.fromEntries(symbols.map(s => [s.symbol, Object.fromEntries(tfs.map(m => [m, readFrameBriefing(home, s.symbol, m)]))])) });
  return {
    serve: ({ symbols, account, now }) => {
      const s = RC.serveReports({ cache: RC.readCache(home), briefings: briefings(symbols), symbols, account, day: tradingDayKey(now), now, ...own(symbols) });
      const reports = cfg.cycle === 'lean' ? s.reports.filter(r => r.role === RC.PHASE1) : s.reports;
      return { roles: reports.map(r => r.role), reports };
    },
    record: ({ symbols, account, now, output, served }) => {
      try {
        return RC.writeCache(home, RC.recordReports({ prev: RC.readCache(home), output, served, briefings: briefings(symbols), symbols, account, day: tradingDayKey(now), now, ...own(symbols) }));
      } catch (err) {
        RC.removeCache(home); // a cache that can't be written is none: every role runs next cycle
        throw err;
      }
    },
  };
}

/** A replay pass (FTH_REPLAY_NOW: one step per process) holds no cycle for a late lane; the live loop keeps the default. */
const passHold = env => (env.FTH_REPLAY_NOW ? { coalesceHoldMs: 0 } : {});

function wireRunner({ cfg, root, home, env = process.env, client, prop = null, dataDir, now, runCycle, loadState, saveState, killSwitchFile, log, event, onBarClosed = () => {}, agents = null }) {
  const strategies = () => loadStrategies(root, env).strategies;
  // The analysts on a timeframe of their own (lanes.js; refused at start when it can't be given): none, as before.
  const frames = analystFrames(cfg, agents || loadAgents(root));
  const journal = () => readJournal(resolveJournalPath(env));
  const record = barRecorder({ cfg, home, env, now, log, onBarClosed });
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
    // Each lane's bars in their own file (sym.minutes: the lane's timeframe).
    writeBars: (sym, bars) => {
      const minutes = sym.minutes || cfg.timeframe;
      const file = path.join(dataDir, `${sym.symbol}-${minutes}m.json`);
      writeJsonAtomic(file, { contractId: sym.contractId, barSize: `${minutes} minute`, count: bars.length, bars });
      return file;
    },
    recordMtf: (sym, bars) => writeMtfRecord(home, sym.symbol, bars, { now: now() }).line,
    // Another lane's bar: the record the first lane's bars wrote, as the gate reads it (its line, or null).
    readMtf: sym => { const r = readMtfRecord(home, sym.symbol); return r && !r.error && r.line ? r.line : null; },
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
    unreviewed: (symbols, entries, positions, at, orders) => unreviewedLine(symbols, entries, positions, at, orders),
    news: at => newsLine(readBlackouts(loadConfig(env).blackoutsFile), at),
    journalEntries: journal,
    tradeHistory: t => excursionNote(readRecord(home, t.setup), t),
    // The bar briefing, each part kept from the last one until it expires or is invalidated (trading/briefing.js).
    recordBriefing: briefingRecorder(home, cfg, now, env, { frames, dataDir, log }),
    reportCache: reportCacheFor(home, cfg, frames),
    analystFrames: frames,
    // One record per timeframe (signal-state.js): each lane's bar records its own.
    recordSignals: (item, results) => writeSignals(home, buildSignals(results, { symbol: item.symbol, bar: item.bar, stepMs: (item.minutes || cfg.timeframe) * 60000, now: now() })),
    // The scan of a closed bar (`lane`: several lanes, the lane whose bar it is); the session record takes the field
    // values of the strategies it scanned.
    scanFor: (symbol, bars, lane) => {
      const list = strategies();
      const results = runnerScan(list, cfg, symbol, bars, now(), lane || undefined);
      record.scanned(symbol, bars, list, results, lane ? lane.timeframe : undefined);
      return results;
    },
    log,
    // The decision log: every scanned bar, every strategy's verdict and why (logs/scans-<day>.jsonl).
    scanLog: rec => appendJsonl(path.join(home, 'logs', `scans-${dayKey(new Date(rec.at))}.jsonl`), scanRecord(rec)),
    // The event log: cycles, account reads, positions managed, stops moved, closes, flattens, errors (logs/events-<day>.jsonl).
    event,
    entryOrders: () => entryOrders(home),
    strategyNamed: name => strategies().find(s => s.name === name && s.valid) || null,
    // A closed bar the runner polled: a decision point of the session record (session/live.js), its bars archived.
    barClosed: record.closed,
    // A replay pass is one step in its own process: it can't hold a cycle for a lane that is late (runner.js).
    ...passHold(env),
  });
}

module.exports = { openRunnerBroker, wireRunner, passHold, barRecorder, briefingRecorder, reportCacheFor, runnerScan, replayUnattested, closedBarsOnly };
