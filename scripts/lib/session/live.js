'use strict';

/**
 * The live session record: the runner records every decision of a live
 * session the way a replay run is recorded (replay/store.js, session/record.js),
 * so `replay.js scorecard` and `replay.js labels` read a live session as they
 * read a replay run, and both feed the learned-policy loop (source: live is
 * its own split there).
 *
 *   <FTH_HOME>/sessions/<trading day>/manifest.json         { v, runId (the trading day), hash, source: 'live',
 *       broker, start, end (the trading day's bounds), harness, model, command, createdAt, lastT, daysDone,
 *       finished, fingerprints, versions, journal, fillsPending (while the day's fills are unknown) }
 *   <FTH_HOME>/sessions/<trading day>/<trading day>.jsonl   one line per decision point (replay's shape)
 *   <FTH_HOME>/sessions/<trading day>/autotrader.json      the runner config the session started with; a later
 *       version's (a restart on another config) is autotrader-<since>.json, named by its `versions` entry's `config`
 *   <FTH_HOME>/sessions/<trading day>/broker/journal.jsonl the broker's journal for the trading day
 * Its run home is the harness home (two folders up), as a replay run's is its own run home: the scan,
 * cycle and gate logs, the bars and the translator cache are read there.
 *
 * Decision points, replay's (replay/schedule.js): premarket, end of day (then eod-retry while it isn't
 * verified flat), and every closed bar the runner polled whose time (its close plus barDelaySeconds) is a
 * trade time by decisionPoints' rule (isTradeTime): a cycle ran, the runner passed it over (no-cycle), the
 * kill switch was on (killSwitch), or the bar closed too long ago to start one (stale: its symbols). A bar
 * outside the runner's sessions (housekeeping only) and a pass with nothing to decide write no line.
 *
 * End of day: once the runner has verified the account flat, the day's fills (search_trades through the
 * broker adapter, the trading day's start to then, each joined to the gateway's entry) go on that end of
 * day's line, the broker's journal for the day is copied, the day is done, and the session finished. A
 * read that fails or times out is recorded as unknown ({ error }), the session stays unfinished
 * (fillsPending), and it is retried after a later pass, never during one, and only while the runner is
 * idle (idleForRetry: nothing open, its end of day done or the market closed, no end of day under way, a
 * wait longer than the retry's read): one day per pass, a minute apart, then, after RETRY_ALERT_AFTER
 * failures in a row (one alert), every BACKOFF_MS; after a restart the pending days are due a minute
 * apart. A record that can't be written is logged; the runner goes on.
 *
 *   createLiveSession({ cfg, root, home, env, client, now, log, tap, killSwitchFile })
 *       { pass(runner) -> ms: runner.step(), its record, then any retry due }
 *       log: the runner's logger (not the pass tap's: a retry's message is no pass's error)
 *   sessionPaths(home, day), dayBounds(day), liveHash({ cfg, root, env })
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('../replay/store');
const { readJson, writeJsonAtomic, entryOrders } = require('../harness-run');
const { tradingDayKey, tradingDayStart, inMarketHours } = require('../trading/clock');
const { gateLogPath } = require('../trading/check-order');
const { liveSpecs } = require('../trading/broker-specs');
const { activeBroker } = require('../broker/config');
const { buildCommand } = require('../autotrader');
const { GATE_ENV } = require('../replay/config');
const { isTradeTime } = require('../replay/schedule');
const { decisionRecord, killSwitchReason, fillsBetween, fingerprints, brokerFingerprint, noteVersion, treeDigest, gateReader, HARNESS_DIRS, CODE_DIRS } = require('./record');

const FILLS_TIMEOUT_MS = 10000;
// A retry's read: shorter than the runner's idle pause, and only when the pass returned a longer wait.
const RETRY_TIMEOUT_MS = 4000;
const RETRY_MS = 60000;
const RETRY_ALERT_AFTER = 5;
const BACKOFF_MS = 30 * 60000;
// Sessions checked at start for fills still to record (the last week or so).
const RECENT_SESSIONS = 7;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function sessionPaths(home, day) {
  const runDir = path.join(home, 'sessions', day);
  return { runHome: home, runDir, manifest: path.join(runDir, 'manifest.json'), autotrader: path.join(runDir, 'autotrader.json'), journal: path.join(runDir, 'broker', 'journal.jsonl') };
}

/** The trading day's start (trading/clock.js tradingDayStart) and the next one's. */
function dayBounds(day) {
  return { start: tradingDayStart(new Date(`${day}T16:00:00Z`)), end: tradingDayStart(new Date(`${day}T23:59:00Z`)) };
}

const tryOr = (fn, fallback) => { try { return fn(); } catch (_err) { return fallback; } };

/**
 * What makes a live session's agent a version: the runner config, broker, harness command, gate settings,
 * the broker's bar-shaping settings (its allowlist only, R35) and documents.
 */
function liveHash({ cfg, root, env }) {
  const gate = Object.fromEntries(GATE_ENV.filter(k => env[k] !== undefined && env[k] !== '').map(k => [k, env[k]]));
  const body = {
    cfg, broker: tryOr(() => activeBroker(env).name, null), command: tryOr(() => buildCommand(cfg, '<prompt>', root, env), null), gate,
    harness: treeDigest(root, HARNESS_DIRS),
  };
  // The broker's settings, or why they couldn't be fingerprinted (then no other session's hash is this one's).
  const fp = brokerFingerprint(env);
  body.brokerSettings = fp.broker;
  if (fp.error) body.fingerprintError = fp.error;
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function withTimeout(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000} s`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The broker journal's entries of the trading day, copied (never linked: the live file goes on growing). */
function copyJournal(src, dst, { start, end }) {
  let text = '';
  try { text = fs.readFileSync(src, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const inDay = line => tryOr(() => { const ms = Date.parse(JSON.parse(line).ts); return ms >= start.getTime() && ms < end.getTime(); }, false);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text.split('\n').filter(inDay).map(l => `${l}\n`).join(''));
  fs.renameSync(tmp, dst);
}

/** The time a closed bar is decided at (its close plus the runner's poll delay), as the replay schedule places it. */
const pointOf = (cfg, barT) => new Date(Date.parse(barT) + cfg.timeframe * 60000 + (cfg.barDelaySeconds || 0) * 1000);

function createLiveSession({ cfg, root, home, env = process.env, client, now, log = () => {}, tap, killSwitchFile, fillsTimeoutMs = FILLS_TIMEOUT_MS }) {
  // The code this process runs: hashed once, as loaded (a later edit on disk isn't running until a restart).
  const code = treeDigest(root, CODE_DIRS);
  const gate = gateReader(gateLogPath(env));
  const open = new Map();
  // day -> { failures, nextAt }: the sessions whose fills are still unknown.
  const pending = new Map();
  let hash = null;
  let scanned = false;
  let fingerprintWarned = false;
  let credentialWarned = false;

  /** The day's session: created (manifest, config), or the one already there (a restart, or a catch-up end of day). */
  function session(day) {
    if (open.has(day)) return open.get(day);
    const paths = sessionPaths(home, day);
    fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    if (hash === null) hash = liveHash({ cfg, root, env });
    let manifest = readJson(paths.manifest, null);
    if (manifest === null && fs.existsSync(paths.manifest)) throw new Error(`${paths.manifest} is unreadable: move it aside to record ${day} again`);
    // A restart on another config, harness or model is a new version of the same session (noteVersion), never a refusal.
    if (!manifest) {
      const { start, end } = dayBounds(day);
      writeJsonAtomic(paths.autotrader, cfg);
      manifest = store.openRun(paths, {
        runId: day, hash, now: now(),
        info: { source: 'live', broker: tryOr(() => activeBroker(env).name, null), start: start.toISOString(), end: end.toISOString(), harness: cfg.harness, model: cfg.model || null, command: tryOr(() => buildCommand(cfg, '<prompt>', root, env), null) },
      });
    }
    const s = { paths, manifest };
    open.set(day, s);
    return s;
  }

  /** The agent's version at this decision; a changed runner config gets its own file beside the first. */
  function version(s, since) {
    const list = s.manifest.versions || [];
    const last = list[list.length - 1];
    const fp = brokerFingerprint(env);
    // Loudly, once a process: the session's broker settings are unknown (recorded as fingerprintError).
    if (fp.error && !fingerprintWarned) {
      fingerprintWarned = true;
      log(`session record: ${fp.error}; recorded as fingerprintError, so no other session counts as the same version`, 'error');
    }
    if (fp.warning && !credentialWarned) {
      credentialWarned = true;
      log(`session record: ${fp.warning}`);
    }
    if (!noteVersion(s.manifest, { since, hash, fingerprints: fingerprints(root, { code, broker: fp.broker, error: fp.error }) })) return;
    const v = s.manifest.versions[s.manifest.versions.length - 1];
    if (!last) v.config = 'autotrader.json';
    else if (last.hash === hash) v.config = last.config || 'autotrader.json';
    else {
      v.config = `autotrader-${since.replace(/[:.]/g, '-')}.json`;
      writeJsonAtomic(path.join(s.paths.runDir, v.config), cfg);
    }
  }

  const hasEod = (s, day) => store.readLines(store.dayFile(s.paths.runDir, day)).some(l => l && (l.kind === 'eod' || l.kind === 'eod-retry'));

  /** The day's fills up to `at`: { trades, ok }; without an account none are read (as a replay). */
  async function dayFills(day, at, timeoutMs = fillsTimeoutMs) {
    if (!cfg.account) return { trades: null, ok: true };
    const { start, end } = dayBounds(day);
    const until = new Date(Math.min(at.getTime(), end.getTime()));
    try {
      const trades = await withTimeout(fillsBetween(client, cfg.account, start, until, { entries: entryOrders(home), specOf: liveSpecs(env) }), timeoutMs, 'search_trades');
      return { trades, ok: true };
    } catch (err) {
      return { trades: { error: err.message }, ok: false };
    }
  }

  /** End of day verified flat: the journal copied, the day done, the session finished once its fills are known. */
  function finishDay(s, day, t, fillsOk) {
    let ok = fillsOk;
    let journal = null;
    try {
      journal = activeBroker(env).journalPath;
    } catch (_err) { /* no broker configured: no journal to copy */ }
    if (journal) {
      try {
        copyJournal(journal, s.paths.journal, dayBounds(day));
      } catch (err) {
        ok = false;
        log(`session ${day}: could not copy the broker journal (${err.message}); retrying`);
      }
    }
    s.manifest.journal = journal;
    if (!s.manifest.daysDone.includes(day)) s.manifest.daysDone.push(day);
    if (ok) {
      delete s.manifest.fillsPending;
      s.manifest.finished = true;
      pending.delete(day);
    } else {
      s.manifest.fillsPending = { t };
      s.manifest.finished = false;
    }
    writeJsonAtomic(s.paths.manifest, s.manifest);
    return ok;
  }

  /** A failed try at a day's fills: retried a minute later, then (after RETRY_ALERT_AFTER in a row, alerted once) less often. */
  function failed(day, at, why) {
    const p = pending.get(day) || { failures: 0, nextAt: 0 };
    p.failures += 1;
    p.nextAt = at.getTime() + (p.failures >= RETRY_ALERT_AFTER ? BACKOFF_MS : RETRY_MS);
    pending.set(day, p);
    if (p.failures === 1) log(`session ${day}: the day's fills are unknown (${why}); retried after a later pass`, 'error');
    else if (p.failures === RETRY_ALERT_AFTER) log(`session ${day}: the day's fills are still unknown after ${p.failures} tries (${why}); retrying every ${BACKOFF_MS / 60000} min`, 'error');
    else log(`session ${day}: the day's fills are still unknown (${why}); retrying`);
  }

  /** The sessions left with fills unknown (a restart keeps retrying them). */
  function scanPending() {
    scanned = true;
    let days;
    try { days = fs.readdirSync(path.join(home, 'sessions')).filter(d => DAY.test(d)).sort().slice(-RECENT_SESSIONS); } catch (_err) { return; }
    // Due a minute apart, so a restart never reads them all at once.
    const t0 = now().getTime();
    let k = 0;
    for (const d of days) {
      if ((readJson(sessionPaths(home, d).manifest, null) || {}).fillsPending && !pending.has(d)) pending.set(d, { failures: 0, nextAt: t0 + RETRY_MS * k++ });
    }
  }

  /** At most one day's fills a pass: the first due. */
  async function retryPending(at) {
    const due = [...pending].find(([, p]) => at.getTime() >= p.nextAt);
    if (!due) return;
    const [day] = due;
    const s = session(day);
    const want = s.manifest.fillsPending;
    if (!want) { pending.delete(day); return; }
    const fills = await dayFills(day, at, RETRY_TIMEOUT_MS);
    if (fills.ok) store.setTrades(s.paths, day, want.t, fills.trades, dayBounds(day).start.toISOString());
    if (finishDay(s, day, want.t, fills.ok)) log(`session ${day}: the day's fills are recorded`);
    else failed(day, at, fills.ok ? 'the broker journal' : fills.trades.error);
  }

  /**
   * The runner is idle enough for a broker read that may be slow: nothing open (its last flatten pass read
   * the account flat; with no live account nothing it holds), its end of day done or the market closed, no
   * end of day in this pass (a retry until verified flat), and its next pass not due within the read's timeout.
   */
  function idleForRetry(runner, at, ms) {
    const state = runner.state || {};
    const flat = cfg.paper || !cfg.account || runner.verifiedFlat === true;
    const dayDone = (state.day === tradingDayKey(at) && Boolean(state.eodDone)) || !inMarketHours(at);
    const eodPass = tap.events().some(e => e.kind === 'eod');
    return flat && dayDone && !eodPass && ms > RETRY_TIMEOUT_MS && !isTradeTime(cfg, at);
  }

  async function record(runner, at, startedMs, killed) {
    const p = tap.summary(runner.symbols);
    const eod = tap.events().filter(e => e.kind === 'eod').pop();
    let day = tradingDayKey(at);
    let kind = null;
    // Replay's trade times: the bars whose close (plus the poll delay) is a trade time of the runner's sessions.
    const bars = p.closed.filter(c => c.bar && isTradeTime(cfg, pointOf(cfg, c.bar)));
    if (eod) {
      day = DAY.test(String(eod.day)) ? eod.day : day; // a catch-up end of day closes an earlier day
      kind = hasEod(session(day), day) ? 'eod-retry' : 'eod';
    } else if (p.events.includes('premarket')) kind = 'premarket';
    else if (bars.length) kind = 'trade';
    if (!kind) return;
    const s = session(day);
    const state = runner.state || {};
    const verified = Boolean(eod) && state.day === day && Boolean(state.eodDone);
    const fills = verified ? await dayFills(day, at) : null;
    const rec = decisionRecord({
      t: at.toISOString(), day, kind, pass: { ...p, asked: kind === 'eod-retry' ? 'eod' : kind }, step: { code: 0, timedOut: false },
      cycles: store.cycleLogsSince(home, startedMs).map(store.cycleSummary), refusals: gate.refusalsSince(startedMs),
      trades: fills ? fills.trades : null, since: fills ? dayBounds(day).start.toISOString() : null, killSwitch: killed,
      stale: kind === 'trade' ? bars.filter(c => c.stale).map(c => c.symbol) : [],
      premarketUnavailable: state.day === day ? state.premarketUnavailable || null : null,
      premarketAvailableAt: state.day === day ? state.premarketAvailableAt || null : null,
      premarketRetryStarved: state.day === day ? state.premarketRetryStarved || 0 : 0,
    });
    version(s, rec.t);
    store.appendRecord(s.paths, s.manifest, rec);
    if (verified && !finishDay(s, day, rec.t, fills.ok)) failed(day, at, fills.ok ? 'the broker journal' : fills.trades.error);
  }

  /**
   * One pass of the runner, recorded, then any fills retry due: after the pass, never while it runs, and
   * never at a trade time (a bar's cycle is never held up by a slow broker read). Never throws.
   */
  async function pass(runner) {
    const at = now();
    // What the pass's cycles and the gate logged from its start (live, the harness clock is the clock that stamps them).
    const startedMs = at.getTime();
    const killed = killSwitchReason(killSwitchFile);
    tap.begin();
    const ms = await runner.step();
    try {
      if (!scanned) scanPending();
      await record(runner, at, startedMs, killed);
      const later = now();
      if (pending.size && idleForRetry(runner, later, ms)) await retryPending(later);
    } catch (err) {
      log(`session record: ${err.message}`, 'error');
    }
    return ms;
  }

  return { pass };
}

module.exports = { createLiveSession, sessionPaths, dayBounds, liveHash, copyJournal, pointOf, FILLS_TIMEOUT_MS, RETRY_TIMEOUT_MS, RETRY_MS, RETRY_ALERT_AFTER, BACKOFF_MS };
