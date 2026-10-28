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
 *   deskFor({ home, cfg, root, runRole, log })  the runner's desk (workflows/desk/WORKFLOW.md), or null
 *   entryFor({ home, cfg, root, runRole, client, log, now })  the runner's entry (workflows/entry/WORKFLOW.md), or null
 *   lookupsKeyOf(home, briefings, symbols, now, laneBars)  a one-symbol cycle's lookups facts key, or null
 *   reportCacheFor(home, cfg, frames, env, root) the runner's report cache (report-cache.js), or null for a harness whose
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
const { propAccountRefusal, propAccountMessage } = require('./trading/prop-accounts');
const { loadAccounts } = require('./trading/accounts');
const { dayKey, endOfDayAt, ROLE_RUNS, TIMED_LAUNCHES, deskConcurrencyProblem } = require('./autotrader');
const { dayContextSeries, describeDay, describeOvernight } = require('./trading/day-context');
const { premarketPlan, newsLine, unreviewedLine } = require('./trading/session-context');
const { readBlackouts } = require('./trading/check-order');
const { readRecord, liveRecord, describeRecord, excursionNote } = require('./trading/track-record');
const { loadStrategies, scan, retiredCopies, composedExit, citingPolicies } = require('./trading/strategies');
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
const CD = require('./cycle-data');
const { tradingDayKey, tradingDayStart, sessionMinuteOf } = require('./trading/clock');
const { digest, recentTrades, formSummary } = require('./trading/instincts');
const { historyFrom, journalSince } = require('./prop/attempt-scope');
const { readShadow, recordShadow } = require('./trading/lesson-shadow');
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
    // A live run on an account the user marks as a prop account starts only with its profile's attempt running: the
    // gate's own [prop-account-attempt] refusal (prop-accounts.js), here before any cycle. Paper and a confirmed replay
    // start as before (their entries are still the gate's to judge).
    const replayed = Boolean(b && b.replay === true && config && config.replay === true);
    const prop = cfg.paper || replayed ? null : propAccountRefusal({ broker: b, accountId: cfg.account, home: loadConfig(env).home, accounts: loadAccounts(root, env).accounts });
    if (prop) throw new Error(`[prop-account-attempt] ${propAccountMessage(prop)}`);
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
      // A roll between the lanes' contract lookups: the briefing says "no 1m bars configured"; the log says why.
      if (f && !fineBars) log(`${item.symbol}: the 1m bars are of another contract (${f.contractId}, the bar's ${item.contractId || 'none'}): no 5m facts from them this bar`, 'error');
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

/**
 * The environment lookupNeeds reads the roles' mode from, as their runs get it (autotrader.js childEnv): opencode's
 * own (index by default); every other harness's roles load all their skills (full), so no lookup is required of them.
 */
const rolesEnv = (cfg, env) => (cfg.harness === 'opencode' ? env : { ...env, FTH_ROLE_SKILLS: 'full' });

/** Index mode: the roles a situational lookup is required of on these briefings' bars (lookupNeeds' roles). */
const lookupRoles = (briefingsBySymbol, now, env = process.env, opts = {}) => Object.keys(lookupNeeds(briefingsBySymbol, now, env, opts));

/**
 * The facts key a one-symbol cycle's lookup requirement comes from (skill-lookups.js factsKey), else null, under which
 * no cached or desk lookup counts.
 */
function lookupsKeyOf(home, b, symbols, now, laneBars) {
  const { factsKey, lanesFor, composedAt } = require('./trading/skill-lookups');
  const first = symbols.length === 1 ? b[symbols[0].symbol] : null;
  return first !== null && first !== undefined ? factsKey(first, now, lanesFor(laneBars, symbols[0].symbol), null, first ? composedAt(home, symbols[0].symbol, first.asOf) : []) : null;
}

/**
 * The desk's roles run at once: config/runner.json desk.concurrency, or the runner config's deskConcurrency (the user's
 * machine) when it lowers it; anything else throws (autotrader.js deskConcurrencyProblem; validateConfig refuses it first).
 */
function deskConcurrencyOf(cfg) {
  const committed = require('./tunables').runner().desk.concurrency;
  const local = cfg ? cfg.deskConcurrency : undefined;
  if (local === undefined || local === null) return committed;
  const problem = deskConcurrencyProblem(local);
  if (problem) throw new Error(problem);
  return local;
}

/**
 * The runner config's deskOnManagedCycles set where it does nothing: the runner's desk on a harness that doesn't time
 * the head trader's own launches (Claude Code), in a full cycle, is the only place it applies. The line said once at
 * the runner's start (deskFor), or null; never a refusal.
 */
function managedDeskNote(cfg) {
  if (!cfg || cfg.deskOnManagedCycles !== true) return null;
  if (ROLE_RUNS.has(cfg.harness) && !TIMED_LAUNCHES.has(cfg.harness) && cfg.cycle === 'full') return null;
  return `deskOnManagedCycles is set but does nothing here (harness ${cfg.harness}, ${cfg.cycle} cycle): it applies only to the runner's desk in a full cycle on a harness that doesn't time the head trader's own launches; managed cycles run as before`;
}

/**
 * The desk's reads in the cycle's store (cycle-data.js collectDesk), made with the environment the roles' runs get
 * (childEnv on the cycle's context: a role's run differs only in its own variables, cycle-data.js PER_RUN), within `ms`
 * and the desk's signal: a collection that runs out or fails gives every role a line and no credit, never an error.
 */
async function deskReads({ cfg, root, env, context, store, roles, symbols, signal, ms, now }) {
  // The desk's time already spent: no read made.
  if (signal && signal.aborted) return CD.deskFailed(roles, 'the desk\'s time ran out');
  const accountId = Number.isInteger(Number(cfg.account)) && Number(cfg.account) >= 1 ? Number(cfg.account) : null;
  // An analyst on its own timeframe (the cycle's context: lanes.js analystFrames) reads its timeframe's briefing first.
  const frames = Object.fromEntries((context && Array.isArray(context.frames) ? context.frames : []).filter(f => f && typeof f.role === 'string' && typeof f.timeframe === 'string').map(f => [f.role, f.timeframe]));
  // Phase 1 reads today's reviews: since the trading day's start (trading/clock.js), the cycle's own clock.
  const since = now instanceof Date && Number.isFinite(now.getTime()) ? require('./trading/clock').tradingDayStart(now).toISOString() : null;
  let timer;
  let onAbort = null;
  const late = new Promise(resolve => {
    timer = setTimeout(() => resolve(CD.deskFailed(roles, `the reads took longer than the ${Math.round(ms / 1000)} s the desk could spare`)), ms);
    if (signal) { onAbort = () => resolve(CD.deskFailed(roles, 'the desk\'s time ran out')); signal.addEventListener('abort', onAbort, { once: true }); }
  });
  try {
    const roleEnv = require('./autotrader').childEnv(cfg, root, env, context);
    return await Promise.race([CD.collectDesk({ roles, symbol: symbols[0].symbol, contractId: symbols[0].contractId || null, accountId, env: roleEnv, store, frames, since }), late]);
  } catch (err) {
    return CD.deskFailed(roles, err);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * A desk role's report as the cycle log's desk record keeps it, for the next diagnosis: its text (cut at the report cache's
 * limit, config/runner.json prompt.reportMaxText); a run that didn't count, each attempt's text and why the checks
 * refused it (`tries`: [{ text, cut?, rejected }], at most the workflow's retries + 1).
 */
function deskText(r) {
  const max = require('./tunables').runner().prompt.reportMaxText;
  const cut = t => { const s = String(t || ''); return s.length > max ? { text: s.slice(0, max), cut: true } : { text: s }; };
  const tries = Array.isArray(r.tries) ? r.tries : [];
  return { ...cut(r.text), ...(r.ok ? {} : { tries: tries.map(t => ({ ...cut(t.text), rejected: t.why || t.stop })) }) };
}

/**
 * The runner's desk (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "The desk, the first workflow"): each full trade cycle the
 * runner runs the desk's roles the report cache didn't serve, as workflows/desk/WORKFLOW.md says, through the
 * orchestration engine (orchestrate/engine.js) on `runRole` (cycle-run.js: one role's harness run), at once up to
 * config/runner.json desk.concurrency (lowered by the runner config's deskConcurrency: deskConcurrencyOf), each within
 * desk.timeoutMinutes. null (the model launches its desk, as before)
 * without a `runRole`, on a harness that runs no role on its own (autotrader.js ROLE_RUNS), on a lean cycle, or without
 * a valid desk workflow.
 *   run({ symbols, roles, now, laneBars, at, context, signal }) -> { reports, missing, results, rolesFile, recorded }:
 *     `context` the cycle's own (its bars, lanes, start: each role reads the cycle's bar), `signal` the cycle's budget
 *     for the desk, `budgetMs` its length: no role's own run outlasts it; each report as the prompt and the report cache
 *     take it ({ role, text, at, until, lookups, lookupsKey, source: 'desk' }); `missing` the roles whose result didn't
 *     count; `results` each role's stop, attempts, ms, skills and report (deskText: its text, a rejected run's tries). Each role's run (its last attempt's wall-clock start and end, `wallNow`, its report, its lookups, whether it
 *     counted) is written to the cycle's role record (`rolesFile`, runner-roles.js), which the head trader's run gets as
 *     FTH_CYCLE_ROLES: the order gate credits the desk from it. `recorded`: the roles whose counted run it holds (a
 *     record that can't be written credits none: logged, and the head trader may launch them).
 *     `store` (this machine's cycleDataInPrompt only, Claude Code: the cycle's store, cycle-data.js createStore): each
 *     role's every-cycle reads are made in it first, once each, with the cycle's environment for the roles' runs, within
 *     the desk's time, and go at the end of each role's request; the read-data check credits a role from that record
 *     (checks.js collectedFor). The runner config's deskBriefReports (Claude Code): each request asks for the report
 *     block alone. Neither: the requests and checks as before.
 */
function deskFor({ home, cfg, root, runRole = null, log = () => {}, wallNow = Date.now, env = process.env }) {
  const note = managedDeskNote(cfg);
  if (note) log(note);
  if (typeof runRole !== 'function' || !ROLE_RUNS.has(cfg.harness) || cfg.cycle !== 'full') return null;
  const { workflowNamed, runWorkflow } = require('./orchestrate/workflows');
  const { createRun } = require('./orchestrate/engine');
  const workflow = workflowNamed(root, 'desk');
  if (!workflow) return null;
  const { timeoutMinutes } = require('./tunables').runner().desk;
  // The runner config's deskConcurrency (this machine's, validated as at most the committed value) lowers it.
  const concurrency = deskConcurrencyOf(cfg);
  return {
    // Whether the head trader's own launches are timed in its transcript (autotrader.js TIMED_LAUNCHES): runner.js runs an
    // untimed harness's desk only in a cycle whose entry it runs or a managed one (no entry that cycle: runner.js managedDesk).
    timed: TIMED_LAUNCHES.has(cfg.harness),
    run: async ({ symbols, roles, now, laneBars = {}, at, bars = null, context = null, signal = null, budgetMs = null, store = null }) => {
      const b = Object.fromEntries(symbols.map(s => [s.symbol, readBriefing(home, s.symbol)]));
      const key = lookupsKeyOf(home, b, symbols, now, laneBars);
      const perRoleMs = timeoutMinutes * 60000;
      // Each role's last attempt's wall-clock times (the engine retries a role in turn; roles run at once are distinct).
      const times = new Map();
      const engine = {
        run: async (role, request, { timeoutMs }) => {
          const start = wallNow();
          try { return await runRole(role, request, { timeoutMs, context }); } finally { times.set(role, { start, end: wallNow() }); }
        },
      };
      // The lookups the bar requires of each role (index mode), as the gate reads them: the request names them and the
      // desk's `lookups` check holds a run that missed one (retried, then missing, never served).
      const lookups = lookupNeeds(b, now, rolesEnv(cfg, env), { home, laneBars });
      const ctx = { symbol: symbols.map(s => s.symbol).join(', '), contractId: symbols.length === 1 ? symbols[0].contractId : null, at, timeframe: cfg.timeframe, bars, lookups };
      if (cfg.harness === 'claude' && cfg.deskBriefReports === true) ctx.brief = true;
      // This machine's opt-in (cycleDataInPrompt): the roles' reads made first, in the cycle's store, within the desk's time.
      if (store && CD.on(cfg) && symbols.length === 1) ctx.precollected = await deskReads({ cfg, root, env, context, store, roles, symbols, signal, now, ms: Number.isFinite(budgetMs) ? Math.min(perRoleMs, budgetMs) : perRoleMs });
      const res = await runWorkflow(workflow, { run: createRun({ engine, signal, onEvent: e => { if (e.type === 'agent-end' && e.stop !== 'completed') log(`the desk: ${e.role} ${e.stop}${e.why ? ` (${e.why})` : ''}`); } }), ctx, roles, concurrency, timeoutMs: Number.isFinite(budgetMs) ? Math.min(perRoleMs, budgetMs) : perRoleMs });
      const results = res.phases.flatMap(p => p.results);
      const reports = results.filter(r => r.ok).map(r => ({ role: r.role, text: r.text, at: now.toISOString(), until: null, lookups: key ? (r.lookups || []) : [], lookupsKey: key && (r.lookups || []).length ? key : null, source: 'desk' }));
      const RR = require('./trading/runner-roles');
      const rolesFile = RR.newRoleRunsFile(home);
      const recorded = [];
      for (const r of results.filter(x => times.has(x.role))) {
        try {
          RR.appendRoleRun(rolesFile, { role: r.role, ...times.get(r.role), text: r.text || '', lookups: r.lookups || [], ok: r.ok });
          if (r.ok && String(r.text || '').trim()) recorded.push(r.role);
        } catch (err) {
          log(`the desk: ${r.role}'s run could not be recorded for the gate (${err.message}): the head trader may launch it`);
        }
      }
      return { reports, missing: results.filter(r => !r.ok).map(r => ({ role: r.role, stop: r.stop, why: r.why })), results: results.map(r => ({ role: r.role, stop: r.stop, attempts: r.attempts, ms: r.ms, ...(r.skills ? { skills: r.skills } : {}), ...deskText(r) })), rolesFile, recorded };
    },
  };
}

/**
 * The runner's entry (runner-entry.js, workflows/entry/WORKFLOW.md): after the head trader's run in a cycle where the
 * runner runs the entry (runner.js), risk-manager phase 2 and the trade-executor through the orchestration engine on
 * `runRole`, each within config/runner.json entry.timeoutMinutes and the cycle's budget. null (the head trader runs its
 * entry, as before) without a `runRole`, on a harness that runs no role on its own (ROLE_RUNS), on a lean cycle, or without a valid entry
 * workflow.
 *   run(cycle) -> null | { result, entry }    runner-entry.js runEntry (the lookups the bar requires of phase 2 added)
 *   recordFile()                              a fresh role record for a cycle whose desk the cache served whole
 */
function entryFor({ home, cfg, root, runRole = null, client = null, log = () => {}, wallNow = Date.now, now = () => new Date(), env = process.env }) {
  if (typeof runRole !== 'function' || !ROLE_RUNS.has(cfg.harness) || cfg.cycle !== 'full') return null;
  const workflow = require('./orchestrate/workflows').workflowNamed(root, 'entry');
  if (!workflow) return null;
  const { timeoutMinutes } = require('./tunables').runner().entry;
  const { runEntry } = require('./runner-entry');
  const { childEnv } = require('./autotrader');
  return {
    run: cycle => {
      const b = { [cycle.symbol]: readBriefing(home, cycle.symbol) };
      const lookups = lookupNeeds(b, cycle.now || new Date(), rolesEnv(cfg, env), { home, laneBars: cycle.laneBars || {} });
      return runEntry({ workflow, runRole, client, home, cfg, root, env, log, wallNow, now, perRoleMs: timeoutMinutes * 60000, childEnv, lookups }, cycle);
    },
    recordFile: () => require('./trading/runner-roles').newRoleRunsFile(home),
  };
}

function reportCacheFor(home, cfg, frames = [], env = process.env, root = path.join(__dirname, '..', '..')) {
  if (!['claude', 'opencode'].includes(cfg.harness)) return null;
  const briefings = symbols => Object.fromEntries(symbols.map(s => [s.symbol, readBriefing(home, s.symbol)]));
  // The analysts on their own timeframe (role -> minutes) and those timeframes' briefings.
  const roles = Object.fromEntries(frames.map(f => [f.role, f.minutes]));
  const tfs = [...new Set(frames.map(f => f.minutes))];
  const own = symbols => ({ frames: roles, frameBriefings: Object.fromEntries(symbols.map(s => [s.symbol, Object.fromEntries(tfs.map(m => [m, readFrameBriefing(home, s.symbol, m)]))])) });
  // The facts key the cycle's lookup requirement comes from (skill-lookups.js factsKey): one-symbol cycles only (an
  // analyst's report is cached in those alone); else null, under which no cached lookup counts.
  const keyOf = (b, symbols, now, laneBars) => lookupsKeyOf(home, b, symbols, now, laneBars);
  // Phase 1's report is served only under the risk-manager body it was written under (an edited body runs the role again).
  const bodyKey = () => { try { return require('crypto').createHash('sha256').update(fs.readFileSync(path.join(root, 'agents', 'risk-manager.md'))).digest('hex'); } catch (_err) { return null; } };
  return {
    // `laneBars`: several lanes, the other lanes whose bar closed this cycle ({ ROOT: { minutes: "<bar open>" } }).
    serve: ({ symbols, account, now, laneBars = {} }) => {
      const b = briefings(symbols);
      const key = keyOf(b, symbols, now, laneBars);
      const s = RC.serveReports({ cache: RC.readCache(home), briefings: b, symbols, account, day: tradingDayKey(now), now, ...own(symbols), bodyKey: bodyKey() });
      // Index mode (the default, FTH_ROLE_SKILLS not full): a role a lookup is required of on this bar is served only when
      // the call that produced its cached report looked up every skill required, under this cycle's facts key (the same
      // bar and lanes: a candidate that appeared since needs a fresh run); else it runs. The gate counts those lookups
      // of a cached report under that key, and no others (trading/skill-lookups.js lookupRule).
      // Only opencode runs index their roles (autotrader.js childEnv gives every other harness full).
      const needs = lookupNeeds(b, now, rolesEnv(cfg, env), { home, laneBars });
      const credited = r => (key && r.lookupsKey === key && Array.isArray(r.lookups) ? r.lookups : []);
      const met = r => (needs[r.role] || []).every(skill => credited(r).includes(skill));
      const reports = (cfg.cycle === 'lean' ? s.reports.filter(r => r.role === RC.PHASE1) : s.reports).filter(met)
        .map(r => ({ ...r, lookups: credited(r), lookupsKey: credited(r).length ? key : null }));
      return { roles: reports.map(r => r.role), reports };
    },
    // `lookups`: the cycle's skill_lookup records (skill-lookups.js), so each cached report keeps its own call's, under
    // the cycle's facts key (`laneBars` as serve takes them).
    // `fresh`: the desk's reports this cycle (deskFor), recorded as the roles' own calls are.
    record: ({ symbols, account, now, output, served, fresh = [], runs = [], lookups = [], laneBars = {} }) => {
      try {
        const b = briefings(symbols);
        return RC.writeCache(home, RC.recordReports({ prev: RC.readCache(home), output, served, fresh, runs, briefings: b, symbols, account, day: tradingDayKey(now), now, ...own(symbols), lookups, lookupsKey: keyOf(b, symbols, now, laneBars), bodyKey: bodyKey() }));
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

/**
 * Setup-focused practice's bar selector (learning/setup-moments.js selectBar), from the bar's own briefing (the
 * symbol's, the facts the model reads), or null without `practice`. Refused (throws) unless the run is a replay
 * (FTH_REPLAY_NOW) of a practice learning run (the run home's learning-run.json: practice-train or practice-validate):
 * live and the sealed windows always run every bar. With a pinned curated list (learning/curated-lists.js), only its
 * windows run practice; outside them a bar runs only with something open.
 */
function practiceSelector(cfg, home, env) {
  if (!cfg.practice) return null;
  const { selectBar } = require('./learning/setup-moments');
  const { readLearningRun } = require('./learning/run-gate');
  const { loadPinnedCurated, curatedSelect } = require('./learning/curated-lists');
  const run = readLearningRun(home);
  if (!env.FTH_REPLAY_NOW) throw new Error('practice (setup-focus) runs only in a replay: live runs every bar');
  if (!run || run.learning !== true || !['practice-train', 'practice-validate'].includes(run.role)) {
    throw new Error(`practice (setup-focus) runs only on a practice-train or practice-validate learning run (this run: ${run ? (run.learning ? run.role : 'not a learning run') : 'no learning-run.json'}); test and final run every bar`);
  }
  // The pinned curated list (its fingerprint checked; a broken pin throws: practice never runs the wrong bars).
  const curated = loadPinnedCurated(home);
  return (item, open) => {
    const b = readBriefing(home, item.symbol);
    const data = b && b.sections && b.sections.m3 && b.sections.m3.data;
    const barClose = Date.parse(item.bar.t) + (item.minutes || cfg.timeframe) * 60000;
    // The first lane's briefing as of this close (another lane's bar reads the one holding then); an older one is none.
    const candles = data && data.bar && Date.parse(data.bar.t) + cfg.timeframe * 60000 <= barClose && Date.parse(b.sections.m3.validUntil) >= barClose ? data.candles : null;
    const select = () => selectBar({ practice: cfg.practice, candles, symbol: item.symbol, bar: item.bar.t, barClose, open });
    // A curated run (learning/curated-lists.js): the same practice inside the pinned list's windows; outside them a bar
    // runs only to manage what is open.
    return curated ? curatedSelect({ windows: curated.windows, barClose, open, select }) : select();
  };
}

/** A replay pass (FTH_REPLAY_NOW: one step per process) holds no cycle for a late lane; the live loop keeps the default. */
const passHold = env => (env.FTH_REPLAY_NOW ? { coalesceHoldMs: 0 } : {});

/** The signal record of a lane's closed bar (signal-state.js), marked when the lane lists a retired strategy (lanes.js retireLanes). */
const laneSignals = (cfg, item, results, at) => buildSignals(results, { symbol: item.symbol, bar: item.bar, stepMs: (item.minutes || cfg.timeframe) * 60000, now: at, retiredLane: (lanesOf(cfg)[item.lane || 0] || {}).retired || null });

/**
 * Whether the runner runs exits-only: a config file refused (tunables.js critical()). Said as an error in the run log
 * (log: the terminal, the day's log, an alert) and in the gate log. Returns true then, else false.
 */
function exitsOnly(env, log, critical = require('./tunables').critical()) {
  if (!critical) return false;
  log(`${critical.message} The runner runs exits-only: no cycle and no new entry; housekeeping closes what no cycle can protect, and end of day flattens.`, 'error');
  require('./trading/check-order').logDecision({ source: 'runner', decision: 'config-critical', message: critical.message }, env);
  return true;
}

function wireRunner({ cfg, root, home, env = process.env, client, prop = null, dataDir, now, runCycle, runRole = null, loadState, saveState, killSwitchFile, log, event, onBarClosed = () => {}, agents = null, configCritical = undefined }) {
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
  // A refused config file (CRITICAL, tunables.js): exits-only, as under the kill switch, without writing it: no cycle (no
  // new entry), while housekeeping closes what no cycle can protect and end of day flattens, on the built-in values.
  const critical = exitsOnly(env, log, configCritical); // configCritical: the error (tests); undefined: tunables.js critical()
  const record = barRecorder({ cfg, home, env, now, log, onBarClosed });
  const recorder = briefingRecorder(home, cfg, now, env, { frames, dataDir, log });
  return createRunner({
    cfg,
    prop,
    root,
    client,
    clock: { now },
    runCycle,
    isKillSwitchOn: () => critical || fs.existsSync(killSwitchFile),
    exitsOnly: critical,
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
    // The composed plans walked forward, settled by this bar (trading/lesson-shadow.js): a lesson's record.
    // A plan's day ends at the runner's own close (as the decisions' outcomes do): a late fill is not held past it.
    recordShadow: (sym, bars) => recordShadow(home, { root: sym.symbol, bars, minutes: cfg.timeframe, tick: sym.tickSize, now: now(), eodOf: ms => { const at = new Date(ms); const eod = endOfDayAt(cfg, at); return eod ? tradingDayStart(at).getTime() + sessionMinuteOf(eod, at) * 60000 : Infinity; } }),
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
    lessons: ({ entries } = {}) => (LR.runsComposed(strategies(), `${cfg.timeframe}m`) ? [] : digest(entries || journal(), 5, { kinds: ['mistake', 'lesson'], form: false, now: now(), shadow: readShadow(home, now()) })),
    // A fresh combine attempt's prompt shows only its own reviewed trades (prop/attempt-scope.js); any other run, all.
    recentTrades: ({ entries } = {}) => recentTrades(journalSince(entries || journal(), historyFrom(home)), 10),
    tradesSummary: ({ entries } = {}) => formSummary(journalSince(entries || journal(), historyFrom(home)), 10),
    // The time a fresh combine attempt's in-prompt history starts at (its record's historyFrom), or null.
    historyFrom: () => historyFrom(home),
    premarketPlan: (symbol, entries, at) => premarketPlan(entries, symbol, at),
    unreviewed: (symbols, entries, positions, at, orders) => unreviewedLine(symbols, entries, positions, at, orders),
    news: at => newsLine(readBlackouts(loadConfig(env).blackoutsFile), at),
    journalEntries: journal,
    tradeHistory: t => excursionNote(readRecord(home, t.setup), t),
    // The bar briefing, each part kept from the last one until it expires or is invalidated (trading/briefing.js).
    recordBriefing: recorder,
    // A 1m lane's closed bars, noted before the pass's briefings: the runner's briefing builds 5m candles from them.
    recordFineBars: recorder.fine,
    reportCache: reportCacheFor(home, cfg, frames, env, root),
    // The desk run by the runner (deskFor): on `runRole` (cycle-run.js, the caller's), else null.
    desk: deskFor({ home, cfg, root, runRole, log, env }),
    // The entry run by the runner (entryFor): on `runRole`, else null.
    entry: entryFor({ home, cfg, root, runRole, client, log, env, now }),
    // The price the runner's entry recorded before its order (trading/late-entry.js), for a composed fill's check.
    latestPrice: symbol => { try { return require('./trading/late-entry').readPrice(home, symbol); } catch (_err) { return null; } },
    // The latest 1m price kept during a trade cycle for the gate's [late-entry] (runner.js watchPrice), on every harness.
    recordPrice: (symbol, rec, opts) => require('./trading/late-entry').recordPrice(home, symbol, rec, opts),
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
      // A composed entry on these roots that may still be working: its expiry not passed when the cycle began, or no
      // expiry stamped and sent since then (an older one without an expiry was cancelled before the cycle).
      stamped: (roots, since) => LR.liveComposed({ entries: entryOrders(home), roots, since }),
      // A setup a composed trade cites (strategies.js citingPolicies) enters only through that trade's record: composed too.
      onlyComposed: () => { const all = strategies(); const tags = LR.composedSetups(all); const on = all.filter(s => s.valid && s.status !== 'disabled' && s.timeframe === `${cfg.timeframe}m`); return on.length > 0 && on.every(s => tags.has(s.name) || citingPolicies(all, s.name).length > 0); },
      unrecorded: (orders, positions, contractId) => LR.unrecordedEntries({ entries: entryOrders(home), orders, positions, root: contractId }),
      forItem: item => recordsAt(home, item.symbol, item.bar && item.bar.t).map(LR.recordSummary),
      byOrder: () => Object.fromEntries(entryOrders(home).filter(e => e.composed && e.composed.record).map(e => [String(e.orderId), e.composed.record])),
    },
    strategyNamed: name => strategies().find(s => s.name === name && s.valid) || null,
    exitStrategy: (name, position) => exitMemory.strategyFor(name, strategies(), position),
    // A composed trade is managed by the exit of the policy that lists it, with or without an attempt (the practice
    // exit is the attempt's): evaluator.js composedExit.
    exitPlanOf: s => composedExit(s, strategies()).plan,
    // A closed bar the runner polled: a decision point of the session record (session/live.js), its bars archived.
    barClosed: record.closed,
    // A running cycle's composed limits are checked for expiry this often (runner.js watchComposed); a test may shorten it.
    ...(env.NODE_ENV === 'test' && Number(env.FTH_COMPOSED_WATCH_MS) > 0 && env.FTH_AUTONOMOUS !== '1' ? { composedWatchMs: Number(env.FTH_COMPOSED_WATCH_MS) } : {}),
    // A replay pass is one step in its own process: it can't hold a cycle for a lane that is late (runner.js).
    ...passHold(env),
    // Setup-focused practice: only a practice replay's selected bars run a cycle (refused anywhere else).
    practiceSelect: practiceSelector(cfg, home, env),
  });
}

module.exports = { deskFor, deskConcurrencyOf, managedDeskNote, entryFor, lookupsKeyOf, exitsOnly, laneSignals, lookupRoles, lookupNeeds, openRunnerBroker, manualRunBroker, holdAccountLock, wireRunner, dayLine, passHold, practiceSelector, barRecorder, briefingRecorder, reportCacheFor, runnerScan, replayUnattested, closedBarsOnly };
