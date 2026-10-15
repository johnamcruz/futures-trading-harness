'use strict';

/**
 * The live runner wired to the harness: the broker adapter, the harness home's
 * files (bars, records, logs, journal), the strategies, and the prompt's
 * context sources. scripts/autotrader.js uses it for the long-running loop
 * and, under a replay clock, for one pass per process (`--once`), so a
 * replayed cycle is built exactly as a live one.
 *
 *   openRunnerBroker({ cfg, root, env, log })   the adapter, verified, holding a live run's account lock; throws
 *                                         when a live run can't manage positions or another runner trades the account
 *   holdAccountLock(client, { killSwitchFile, log, event })   before each pass (async, never rejects): 'held' | 'relinked'
 *                                         | 'taken' (the caller exits, no broker action) | 'unknown' (kill switch, full risk management) | 'none'
 *   manualRunBroker({ cfg, once, root, env, log })   the same for a manual (--once) run that can place live orders, else null
 *   closedBarsOnly(client, now)           the adapter, bars closing after now() dropped (replay)
 *   replayUnattested(serverConfig, at)     why a replay server doesn't attest the replayed time, or null
 *   wireRunner({ cfg, root, home, env, client, prop, dataDir, now, runCycle,
 *                loadState, saveState, killSwitchFile, log, event, onBarClosed, agents })   createRunner(...) with every
 *                                         dependency; onBarClosed(symbol, { bar, stale, action, contractId, values }) hears each closed bar the runner polls
 *                                         (barRecorder: its bars archived, the strategies' field values taken)
 *   reportCacheFor(home, cfg, frames, env) the runner's report cache (report-cache.js), or null for a harness whose
 *                                         cycle output doesn't carry its roles' reports
 *   briefingRecorder(home, cfg, now, env, { frames, dataDir, log })   the bar briefing of each bar, and of each
 *                                         analyst's own timeframe (frames: lanes.js analystFrames); on a lane's bar
 *                                         whose briefing can't be built, { error } (the runner allows no entry on it);
 *                                         its `fine(item)` notes a 1m lane's closed bars, from which the runner's
 *                                         briefing builds 5m candles its own 3m bars can't
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
const { acquireAccountLocks, checkAccountLock, lockExemption, serverIdentities, lockSpec, normApi } = require('./account-lock');
const { normId } = require('./broker/allow-list');
const { dayKey } = require('./autotrader');
const { dayContextSeries, describeDay, describeOvernight } = require('./trading/day-context');
const { premarketPlan, newsLine, unreviewedLine } = require('./trading/session-context');
const { readBlackouts } = require('./trading/check-order');
const { readRecord, liveRecord, describeRecord, excursionNote } = require('./trading/track-record');
const { loadStrategies, scan, retiredCopies } = require('./trading/strategies');
const { lanesOf, laneStrategies, analystFrames, retireLanes } = require('./lanes');
const { loadAgents } = require('./harness-sync');
const { scanRecord, appendJsonl } = require('./trading/scan-log');
const { loadConfig } = require('./trading/config');
const { writeJsonAtomic, entryOrders } = require('./harness-run');
const { createExitMemory } = require('./trading/exit-memory');
const { writeMtfRecord, readRecord: readMtfRecord } = require('./trading/mtf-state');
const { buildBriefing, readBriefing, writeBriefing, removeBriefing, buildFrameBriefing, wholeBars, readFrameBriefing, writeFrameBriefing, removeFrameBriefing } = require('./trading/briefing');
const { buildSignals, writeSignals, syncRetiredMarks } = require('./trading/signal-state');
const RC = require('./trading/report-cache');
const { tradingDayKey } = require('./trading/clock');
const { digest, recentTrades, formSummary } = require('./trading/instincts');
const LR = require('./trading/lifecycle-runner');
const { recordsAt } = require('./trading/lifecycle-gate');
const { resolveJournalPath, readJournal } = require('./trading/journal');
const { barsArchiver } = require('./session/bars-archive');
const { fieldValues } = require('./session/record');
const { levelOnTick } = require('./trading/contracts');

/**
 * The broker adapter for the runner: every interface tool, and (live, with an account) a server that trades.
 * A live run holds its account's lock (account-lock.js: one runner per broker account, across every harness
 * home; paper and confirmed replays are exempt): checked before the server is started (a refused runner never
 * logs in), taken once the server answers, released when the adapter closes or the process exits. The adapter's
 * ensureLock() (async) says whether the lock is still this runner's (holdAccountLock).
 */
async function openRunnerBroker({ cfg, root, env = process.env, open = openAdapter, broker = null, log = () => {} }) {
  const b = cfg.paper ? null : broker || activeBroker(env);
  if (b && b.replay !== true && normId(cfg.account) !== null) checkAccountLock({ env, broker: b, servers: serverIdentities({ broker: b, env }), accountId: cfg.account });
  const client = open({ root, env });
  try {
    await client.verify();
    // A live run manages its positions (trailing stops, exits, leftover cancels): the server must accept those,
    // and trades only an account on the broker's allow-list (a confirmed replay is exempt).
    const config = cfg.paper ? null : await client.serverConfig();
    const why = cfg.paper ? null : liveRunBlocked({ broker: b, config, env, accountId: cfg.account });
    if (why) throw new Error(why);
    if (lockExemption({ paper: cfg.paper, broker: b, config })) return client;
    // The API it trades keys the lock across installs: a server that names none can't be locked, so no live run.
    if (!normApi(config && config.apiUrl)) throw new Error(`the broker server reports no apiUrl that is a URL with a host (get_server_config: ${JSON.stringify(config && config.apiUrl)}), so its account can't be locked against another install of it: a live run refuses`);
    const lock = acquireAccountLocks({ env, broker: b, servers: serverIdentities({ broker: b, config, env }), accountId: cfg.account, log });
    env.FTH_ACCOUNT_LOCK = lockSpec(lock); // the run's cycles: the gate refuses their entries once the lock isn't ours
    return { ...client, ensureLock: opts => lock.ensure(opts), close: () => { lock.release(); client.close(); } };
  } catch (err) {
    client.close();
    throw err;
  }
}

const LOCK_UNKNOWN = 'ALERT: the account lock can\'t be confirmed as this runner\'s (unreadable, another host\'s, or a holder that can\'t be positively identified): no new entries (this kill switch); full risk management of the account continues (trailing, protection, exits, end-of-day flatten). Find out which runner should trade the account, stop any other, then remove this file to resume.';

/** Append `reason` to the kill switch unless it already says it (re-armed after the user removed it). */
function armKillSwitch(killSwitchFile, reason) {
  let text;
  try { text = fs.readFileSync(killSwitchFile, 'utf8'); } catch (_err) { text = ''; }
  if (!text.includes(reason)) fs.appendFileSync(killSwitchFile, `${reason}\n`);
}

/**
 * Before every pass, never rejecting: 'held'; 'relinked' (a file of ours that vanished and stayed gone: linked back,
 * logged); 'taken' (another runner, positively identified twice, holds the lock: it manages the account, so this
 * runner takes no broker action at all: logged and recorded; the caller exits); 'unknown' (anything else, the check
 * failing included): no new entries (the kill switch, re-armed every pass), full risk management of the account as
 * before the lock existed, an alert logged every pass and an event recorded once per episode. Nothing is sticky: held
 * again, the runner re-arms nothing, so removing the kill switch resumes it. 'none': no lock (paper, replay).
 */
async function holdAccountLock(client, { killSwitchFile, log = () => {}, event = () => {}, command, stableMs } = {}) {
  if (!client || typeof client.ensureLock !== 'function') return 'none';
  let st;
  try {
    st = await client.ensureLock({ ...(command ? { command } : {}), ...(stableMs !== undefined ? { stableMs } : {}) });
  } catch (err) {
    log(`account lock: the check failed (${err.message})`, 'error');
    st = 'unknown';
  }
  const record = kind => { try { event({ at: new Date().toISOString(), kind, pid: process.pid }); } catch (_err) { /* the record never stops the runner */ } };
  if (st === 'relinked') log('account lock: its file had vanished and stayed gone: linked it back');
  if (st === 'taken') {
    log('the account lock is held by another runner now (identified on this host, twice): it manages the account. This runner takes no broker action (no cancels, flattens, trails or end of day) and exits', 'error');
    record('account_lock_taken');
  }
  if (st === 'unknown') {
    log(LOCK_UNKNOWN, 'error');
    if (!client.lockUnknown) record('account_lock_unknown');
    client.lockUnknown = true;
    try { armKillSwitch(killSwitchFile, LOCK_UNKNOWN); } catch (err) { log(`account lock: could not write the kill switch (${err.message})`, 'error'); }
  } else client.lockUnknown = false;
  return st;
}

/**
 * A manual run (`--once`): one that can place orders on a live account holds the account's lock as the loop does
 * (openRunnerBroker: the server trades the account, the allow-list holds it, no other runner trades it), or is
 * refused; a live one that names no account (no lock to key) is refused too, as the loop is. End of day only
 * reduces risk (flatten, cancel), so it is never refused for the lock; paper takes none. The adapter (null when
 * none) is closed after the run.
 */
async function manualRunBroker({ cfg, once, root, env = process.env, log = () => {}, open = openAdapter, broker = null }) {
  if (cfg.paper) return null;
  if (once === 'eod') {
    env.FTH_ACCOUNT_LOCK = lockSpec(null); // no lock taken: the gate refuses the cycle's entries
    return null;
  }
  if (!String(cfg.account || '').trim()) throw new Error(`a live manual run (--once ${once}, paper: false) names its account ("account" in the runner config), so no other runner trades it; or run it with paper: true`);
  return openRunnerBroker({ cfg, root, env, open, broker, log });
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
  // The round-number steps (round-numbers.js), read once per bar close and passed to every timeframe's briefing of
  // that bar, so an edit mid-bar never gives two timeframes different steps; refusals are carried in them.
  let steps = { at: null, value: null };
  const roundStepsAt = closeAt => {
    if (steps.at !== closeAt) {
      let value;
      try { value = loadConfig(env).roundSteps; } catch (err) { value = { steps: {}, errors: [{ family: '*', message: err.message }] }; }
      steps = { at: closeAt, value };
    }
    return steps.value;
  };
  const closeOf = (bars, minutes) => (bars && bars.length ? new Date(Date.parse(bars[bars.length - 1].t) + minutes * 60000).toISOString() : null);
  // One timeframe's briefing; a failure removes it (an older bar's is never read as this one's), is logged, and is
  // returned (its message; null when built).
  const frame = (item, minutes, { bars: barsOf, lane = false, scan = null, scanError = null, barsFile = null, roundSteps }) => {
    try {
      const prev = readFrameBriefing(home, item.symbol, minutes);
      const bars = barsOf();
      if (!bars.length) throw new Error(`no whole ${minutes}m bar in the ${cfg.timeframe}m bars`);
      // Built from the first lane's bars: the same last whole bar is the same briefing (kept until its next close).
      if (!lane && prev && prev.asOf === bars[bars.length - 1].t && (prev.contractId || null) === (item.contractId || null)) return null;
      let file = barsFile;
      if (!lane && dataDir) {
        file = path.join(dataDir, `${item.symbol}-${minutes}m.json`);
        writeJsonAtomic(file, { contractId: item.contractId || null, barSize: `${minutes} minute`, builtFrom: `${cfg.timeframe} minute`, count: bars.length, bars });
      }
      writeFrameBriefing(home, buildFrameBriefing({ symbol: item.symbol, contractId: item.contractId || null, bars, minutes, first: readBriefing(home, item.symbol), lane, scan, scanError, barsFile: file, ...facts(), roundSteps, now: now() }));
      return null;
    } catch (err) {
      removeFrameBriefing(home, item.symbol, minutes);
      log(`${item.symbol}: no ${minutes}m bar briefing this bar (${err.message}); the ${minutes}m analysts read the bars themselves`, 'error');
      return err.message;
    }
  };
  // The latest closed 1m bars per symbol (a 1m lane's, this pass's when it closed with the first lane's bar): the
  // runner's briefing builds the timeframes its own bars can't (5m from 3m) from them; another contract's never.
  const fine = new Map();
  const record = (item, results, scanError = null) => {
    if (item.lane > 0) {
      const roundSteps = roundStepsAt(closeOf(item.bars, item.minutes));
      // A lane's briefing that can't be built: the lane's setups have no room read (fail closed: no entry on this bar).
      const error = laned.has(item.minutes) ? frame(item, item.minutes, { bars: () => item.bars, lane: true, scan: results, scanError, barsFile: (item.bar && item.bar.file) || null, roundSteps }) : null;
      return error ? { error } : null;
    }
    const roundSteps = roundStepsAt(closeOf(item.bars, cfg.timeframe));
    const file = firstBriefing(item, results, scanError, roundSteps);
    for (const m of built) frame(item, m, { bars: () => wholeBars(item.bars, m), roundSteps });
    return file;
  };
  record.fine = item => {
    if (item && item.minutes === 1 && Array.isArray(item.bars) && cfg.timeframe !== 1) fine.set(item.symbol, { contractId: item.contractId || null, bars: item.bars });
  };
  return record;

  function firstBriefing(item, results, scanError, roundSteps) {
    try {
      const { blackouts, clock } = facts();
      const f = fine.get(item.symbol);
      const fineBars = f && f.contractId === (item.contractId || null) ? f.bars : null;
      return writeBriefing(home, buildBriefing({ symbol: item.symbol, contractId: item.contractId || null, bars: item.bars, minutes: cfg.timeframe, fineBars, prev: readBriefing(home, item.symbol), scan: results, scanError, blackouts, clock, roundSteps, now: now() }));
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
 * role's report) to the runner; other harnesses run every role every cycle. A lean cycle runs no analysts. In index
 * mode (opencode, the default, FTH_ROLE_SKILLS not full) a role a lookup is required of on the bar is served only when
 * its cached report's own call looked up every skill required (lookupNeeds; the gate counts the same lookups).
 */
/**
 * Index mode: the skills a situational lookup is required of each role on these briefings' bars, { role: [skill] }
 * (none in full mode). Several lanes (`laneBars`, { ROOT: { minutes: "<bar open>" } }: the other lanes whose bar closed
 * this cycle): their candidates count too, read as the gate reads them (trading/skill-lookups.js cycleFacts), so the
 * cache and the gate agree.
 */
function lookupNeeds(briefingsBySymbol, now, env = process.env, { home = null, laneBars = {} } = {}) {
  let mode;
  try { mode = require('./role-skills').modeOf(env); } catch (_err) { mode = 'index'; }
  if (mode !== 'index') return {};
  const { requiredFor, needed, cycleFacts, lanesFor, composedAt } = require('./trading/skill-lookups');
  const { readSignals } = require('./trading/signal-state');
  const required = requiredFor(path.resolve(__dirname, '..', '..'));
  const facts = Object.entries(briefingsBySymbol).map(([symbol, b]) => cycleFacts({
    first: b, now, lanes: lanesFor(laneBars, symbol),
    readFrame: m => (home ? readFrameBriefing(home, symbol, m) : null), readSignal: m => (home ? readSignals(home, symbol, `${m}m`) : null),
    composed: home && b ? composedAt(home, symbol, b.asOf) : [],
  }));
  const out = {};
  for (const role of required.keys()) {
    const skills = [...new Set((facts.length ? facts : [null]).flatMap(m3 => needed(role, required, m3).map(r => r.skill)))];
    if (skills.length) out[role] = skills;
  }
  return out;
}

/** Index mode: the roles a situational lookup is required of on these briefings' bars (lookupNeeds' roles). */
const lookupRoles = (briefingsBySymbol, now, env = process.env, opts = {}) => Object.keys(lookupNeeds(briefingsBySymbol, now, env, opts));

function reportCacheFor(home, cfg, frames = [], env = process.env) {
  if (!['claude', 'opencode'].includes(cfg.harness)) return null;
  const briefings = symbols => Object.fromEntries(symbols.map(s => [s.symbol, readBriefing(home, s.symbol)]));
  // The analysts on their own timeframe (role -> minutes) and those timeframes' briefings.
  const roles = Object.fromEntries(frames.map(f => [f.role, f.minutes]));
  const tfs = [...new Set(frames.map(f => f.minutes))];
  const own = symbols => ({ frames: roles, frameBriefings: Object.fromEntries(symbols.map(s => [s.symbol, Object.fromEntries(tfs.map(m => [m, readFrameBriefing(home, s.symbol, m)]))])) });
  // The facts key the cycle's lookup requirement comes from (skill-lookups.js factsKey): one-symbol cycles only (an
  // analyst's report is cached in those alone); else null, under which no cached lookup counts.
  const keyOf = (b, symbols, now, laneBars) => {
    const { factsKey, lanesFor, composedAt } = require('./trading/skill-lookups');
    const first = symbols.length === 1 ? b[symbols[0].symbol] : null;
    return first !== null ? factsKey(first, now, lanesFor(laneBars, symbols[0].symbol), null, first ? composedAt(home, symbols[0].symbol, first.asOf) : []) : null;
  };
  return {
    // `laneBars`: several lanes, the other lanes whose bar closed this cycle ({ ROOT: { minutes: "<bar open>" } }).
    serve: ({ symbols, account, now, laneBars = {} }) => {
      const b = briefings(symbols);
      const key = keyOf(b, symbols, now, laneBars);
      const s = RC.serveReports({ cache: RC.readCache(home), briefings: b, symbols, account, day: tradingDayKey(now), now, ...own(symbols) });
      // Index mode (the default, FTH_ROLE_SKILLS not full): a role a lookup is required of on this bar is served only when
      // the call that produced its cached report looked up every skill required, under this cycle's facts key (the same
      // bar and lanes: a candidate that appeared since needs a fresh run); else it runs. The gate counts those lookups
      // of a cached report under that key, and no others (trading/skill-lookups.js lookupRule).
      // Only opencode runs index their roles (autotrader.js childEnv gives every other harness full).
      const needs = cfg.harness === 'opencode' ? lookupNeeds(b, now, env, { home, laneBars }) : {};
      const credited = r => (key && r.lookupsKey === key && Array.isArray(r.lookups) ? r.lookups : []);
      const met = r => (needs[r.role] || []).every(skill => credited(r).includes(skill));
      const reports = (cfg.cycle === 'lean' ? s.reports.filter(r => r.role === RC.PHASE1) : s.reports).filter(met)
        .map(r => ({ ...r, lookups: credited(r), lookupsKey: credited(r).length ? key : null }));
      return { roles: reports.map(r => r.role), reports };
    },
    // `lookups`: the cycle's skill_lookup records (skill-lookups.js), so each cached report keeps its own call's, under
    // the cycle's facts key (`laneBars` as serve takes them).
    record: ({ symbols, account, now, output, served, lookups = [], laneBars = {} }) => {
      try {
        const b = briefings(symbols);
        return RC.writeCache(home, RC.recordReports({ prev: RC.readCache(home), output, served, briefings: b, symbols, account, day: tradingDayKey(now), now, ...own(symbols), lookups, lookupsKey: keyOf(b, symbols, now, laneBars) }));
      } catch (err) {
        RC.removeCache(home); // a cache that can't be written is none: every role runs next cycle
        throw err;
      }
    },
  };
}

/**
 * The day so far (trading/day-context.js), one line for the prompt, prices on the contract's tick (sym.tickSize, the
 * broker's; 0.25 without one); in RTH the day so far, outside it the overnight session against the prior day.
 */
function dayLine(sym, bars) {
  const tick = sym.tickSize > 0 ? sym.tickSize : 0.25;
  const round = x => Number((Math.round(x / tick) * tick).toFixed(6));
  // The prior value area and POC as the briefing and market_snapshot show them (contracts.js levelOnTick).
  const level = x => levelOnTick(x, tick);
  return describeDay(dayContextSeries(bars).day.at(-1), { symbol: sym.symbol, round, level }) || describeOvernight(bars, { symbol: sym.symbol, round, level });
}

/** A replay pass (FTH_REPLAY_NOW: one step per process) holds no cycle for a late lane; the live loop keeps the default. */
const passHold = env => (env.FTH_REPLAY_NOW ? { coalesceHoldMs: 0 } : {});

/** The signal record of a lane's closed bar (signal-state.js), marked when the lane lists a retired strategy (lanes.js retireLanes). */
const laneSignals = (cfg, item, results, at) => buildSignals(results, { symbol: item.symbol, bar: item.bar, stepMs: (item.minutes || cfg.timeframe) * 60000, now: at, retiredLane: (lanesOf(cfg)[item.lane || 0] || {}).retired || null });

function wireRunner({ cfg, root, home, env = process.env, client, prop = null, dataDir, now, runCycle, loadState, saveState, killSwitchFile, log, event, onBarClosed = () => {}, agents = null }) {
  const strategies = () => loadStrategies(root, env).strategies;
  // A user's own strategy under a retired name: it trades as theirs; said at start so a stale copy is noticed.
  try { for (const m of retiredCopies(strategies())) log(m, 'error'); } catch (_err) { /* the strategies load again at each scan */ }
  // Before any cycle: the retired-lane mark on exactly the retired lanes' timeframes (signal-state.js syncRetiredMarks).
  // Not written: no new entries (the kill switch), since an older unmarked record could let one through.
  try {
    retireLanes(cfg, strategies()); // as the start's checks did (idempotent): the lanes the marks follow
    for (const c of syncRetiredMarks(home, { symbols: cfg.symbols, lanes: lanesOf(cfg), now: now() })) log(`signal record ${c.timeframe}: ${c.marked ? `marked: its runner lane lists ${c.marked.join(', ')} (retired), so no entry on ${c.timeframe}` : 'retired-lane mark cleared (no runner lane lists a retired strategy there now)'}`, c.marked ? 'error' : undefined);
  } catch (err) {
    log(`the retired-lane signal marks could not be written (${err.message}): kill switch on, no new entries until it is fixed`, 'error');
    try { armKillSwitch(killSwitchFile, `retired-lane signal marks not written (${err.message})`); } catch (e) { log(`could not write the kill switch (${e.message})`, 'error'); }
  }
  // The analysts on a timeframe of their own (lanes.js; refused at start when it can't be given): none, as before.
  const frames = analystFrames(cfg, agents || loadAgents(root));
  // An open position keeps its strategy's exit plan if the strategy stops loading (trading/exit-memory.js).
  const exitMemory = createExitMemory(path.join(home, 'exit-plans.json'), {
    onError: m => log(m, 'error'),
    // An alert like the runner's own: into the event log (the cycle log and the scorecard read it).
    onDrop: d => event({ at: now().toISOString(), kind: 'exit_plan_dropped', ...d }),
  });
  const journal = () => readJournal(resolveJournalPath(env));
  const record = barRecorder({ cfg, home, env, now, log, onBarClosed });
  const recorder = briefingRecorder(home, cfg, now, env, { frames, dataDir, log });
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
    dayContext: dayLine,
    // The prompt shows each fact once: mistakes and lessons here; live results in the track records;
    // the last reviewed trades' record on their own line.
    // Off when an active composed strategy (trade_lifecycle) trades the runner's timeframe: what it learns comes from
    // its experience record, not the journal's instincts (the composed-entry design, PR 14).
    lessons: ({ entries } = {}) => (LR.runsComposed(strategies(), `${cfg.timeframe}m`) ? [] : digest(entries || journal(), 5, { kinds: ['mistake', 'lesson'], form: false })),
    recentTrades: ({ entries } = {}) => recentTrades(entries || journal(), 10),
    tradesSummary: ({ entries } = {}) => formSummary(entries || journal(), 10),
    premarketPlan: (symbol, entries, at) => premarketPlan(entries, symbol, at),
    unreviewed: (symbols, entries, positions, at, orders) => unreviewedLine(symbols, entries, positions, at, orders),
    news: at => newsLine(readBlackouts(loadConfig(env).blackoutsFile), at),
    journalEntries: journal,
    tradeHistory: t => excursionNote(readRecord(home, t.setup), t),
    // The bar briefing, each part kept from the last one until it expires or is invalidated (trading/briefing.js).
    recordBriefing: recorder,
    // A 1m lane's closed bars, noted before the pass's briefings: the runner's briefing builds 5m candles from them.
    recordFineBars: recorder.fine,
    reportCache: reportCacheFor(home, cfg, frames, env),
    analystFrames: frames,
    // One record per timeframe (signal-state.js): each lane's bar records its own.
    recordSignals: (item, results) => writeSignals(home, laneSignals(cfg, item, results, now())),
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
    // The trade lifecycle's composed limits: stamped with their record's expiry after a cycle, cancelled at it.
    composed: {
      due: (orders, at) => LR.dueComposed({ entries: entryOrders(home), orders, composed: LR.composedSetups(strategies()), now: at }),
      onlyComposed: () => { const tags = LR.composedSetups(strategies()); const on = strategies().filter(s => s.valid && s.status !== 'disabled' && s.timeframe === `${cfg.timeframe}m`); return on.length > 0 && on.every(s => tags.has(s.name)); },
      unrecorded: (orders, positions, contractId) => LR.unrecordedEntries({ entries: entryOrders(home), orders, positions, root: contractId }),
      forItem: item => recordsAt(home, item.symbol, item.bar && item.bar.t).map(LR.recordSummary),
      byOrder: () => Object.fromEntries(entryOrders(home).filter(e => e.composed && e.composed.record).map(e => [String(e.orderId), e.composed.record])),
    },
    strategyNamed: name => strategies().find(s => s.name === name && s.valid) || null,
    exitStrategy: (name, position) => exitMemory.strategyFor(name, strategies(), position),
    // A closed bar the runner polled: a decision point of the session record (session/live.js), its bars archived.
    barClosed: record.closed,
    // A running cycle's composed limits are checked for expiry this often (runner.js watchComposed); a test may shorten it.
    ...(env.NODE_ENV === 'test' && Number(env.FTH_COMPOSED_WATCH_MS) > 0 && env.FTH_AUTONOMOUS !== '1' ? { composedWatchMs: Number(env.FTH_COMPOSED_WATCH_MS) } : {}),
    // A replay pass is one step in its own process: it can't hold a cycle for a lane that is late (runner.js).
    ...passHold(env),
  });
}

module.exports = { laneSignals, lookupRoles, lookupNeeds, openRunnerBroker, manualRunBroker, holdAccountLock, wireRunner, dayLine, passHold, barRecorder, briefingRecorder, reportCacheFor, runnerScan, replayUnattested, closedBarsOnly };
