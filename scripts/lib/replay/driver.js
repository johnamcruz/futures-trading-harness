'use strict';

/**
 * The replay driver: runs the live runner over a window of history, one
 * decision time per process (the replay clock is frozen per process).
 *
 * For each decision time t, in order (replay/schedule.js):
 *   1. the replay broker's clock file says { now: t }, so fills between the
 *      previous time and t happen in the broker;
 *   2. `node scripts/autotrader.js --config <run's runner config> --once <kind>`
 *      runs with FTH_REPLAY_NOW=t, FTH_BROKER=<replay broker>, FTH_HOME=<run
 *      home> and the broker's run variables (replay/config.js replayEnv): one
 *      pass of the live loop at t (bars through the broker adapter, the bars
 *      file, the trend and signal records, the scan, verdicts, the account,
 *      then the harness cycle), with every order through the order gate;
 *   3. one store line (replay/store.js): what ran, the cycle log's summary and
 *      prompt hash, the gate's refusals, and the broker's fills since the
 *      previous time (search_trades through the broker adapter).
 * End of day is retried a minute later (up to 5 times, before 16:00 ET) while
 * the runner hasn't verified the account flat (the retry is saved in the
 * manifest before each end-of-day step, so no stop or crash loses it); a day is done after its last
 * time. A step whose cycle made no decision (an infrastructure failure: no CYCLE RESULT line, a failed or
 * timed-out harness; the step exits 1 with its REPLAY STEP line) is recorded as an attempt (store.js
 * appendAttempt) and its decision time runs again, never skipped (a crash during it: interrupted, as any
 * step); each attempt is a failed cycle. The agent's own "CYCLE RESULT: error" is a decision: recorded as
 * live records it (a failed cycle), never retried. The run stops after cfg.maxConsecutiveErrors failed cycles in a row
 * (the time still due, in the manifest's cycleRetry: a resume runs it first),
 * before a new trading day while the run's kill switch (<run home>/STOP) is on
 * (the day under way still runs: as live, no trade cycle, but housekeeping and
 * end of day; the reason is the file's latest line),
 * or at once when a step can't run (the broker won't start, the clock is
 * refused).
 *
 *   seedRunHome(run, { root, userEnv })         the fresh run home (or checks the one being resumed)
 *   runReplay({ run, baseEnv, root, deps, maxCycles, log })   resolves { cycles, stopped, done }
 *   defaultDeps(run, root)                       the real step, broker checks and trade reads
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, runHarness, entryOrders, TRUSTED_WORKSPACE_FILES } = require('../harness-run');
const { loadBrokers } = require('../broker/config');
const { loadRoundSteps, seedFile, FILE_NAME: ROUND_NUMBERS_FILE } = require('../trading/round-numbers');
const { withAdapter } = require('../broker/adapter');
const { liveSpecs } = require('../trading/broker-specs');
const { sessionMinute, tradingDayKey, MARKET_OPEN_MIN, MARKET_CLOSE_MIN } = require('../trading/clock');
const { replayUnattested } = require('../runner-wiring');
const { harnessHome } = require('../paths');
const { liveRunner } = require('../runner-lock');
const { decisionPoints } = require('./schedule');
const { curatedPoints, accountOpen } = require('../learning/curated-lists');
const { replayEnv, brokerErrors, configHash, harnessCommand } = require('./config');
const store = require('./store');
const { failedRun, noDecision, decisionRecord, killSwitchReason, withEntry, fillsBetween, fingerprints, brokerFingerprint, noteVersion } = require('../session/record');
const { readAttempt, startAttempt } = require('../trading/prop-state');
const { accountNamed } = require('../trading/accounts');

const EOD_RETRIES = 5;
// Minutes from the 18:00 ET open to the 16:00 ET close.
const CLOSE_SESSION_MIN = 24 * 60 - MARKET_OPEN_MIN + MARKET_CLOSE_MIN;

/** The run home: created fresh, or (with a manifest) the run being resumed. */
function seedRunHome(run, { root, userEnv = process.env }) {
  const { paths } = run;
  const fresh = !fs.existsSync(paths.manifest);
  if (fresh && fs.existsSync(paths.runHome) && fs.readdirSync(paths.runHome).length) {
    throw new Error(`${paths.runHome} exists and is not a replay run home (no ${path.relative(paths.runHome, paths.manifest)}): a run starts in a fresh home; pick another runId or workDir`);
  }
  for (const d of [paths.runHome, paths.runDir, paths.brokerDir, paths.bars, paths.workspace]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  if (!fresh) return false;
  // The brokers as the user configured them (the replay broker is one), read by every process of the run.
  // Resolved (absolute entry and journal paths), so nothing is re-based on the run home.
  const { broker, brokers } = loadBrokers(userEnv);
  writeJsonAtomic(path.join(paths.runHome, 'brokers.json'), { broker, brokers });
  // The round-number steps as the user's home resolves them, refusals included (round-numbers.js seedFile), so the
  // replay's briefing shows the levels, and the reasons for none, that live would.
  writeJsonAtomic(path.join(paths.runHome, ROUND_NUMBERS_FILE), seedFile(loadRoundSteps(userEnv)));
  // The run's own .env (FTH_ENV_FILE points here): empty, so a child reads no other first.
  fs.writeFileSync(path.join(paths.runHome, '.env'), '', { flag: 'a', mode: 0o600 });
  // The workspace's operator files, so the harness CLI runs as live but never writes the live workspace.
  for (const f of TRUSTED_WORKSPACE_FILES.filter(x => !x.startsWith('.qwen/'))) {
    const src = path.join(root, 'workspace', f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(paths.workspace, f)), { recursive: true });
    fs.copyFileSync(src, path.join(paths.workspace, f));
  }
  fs.writeFileSync(path.join(paths.journal), '', { flag: 'a' });
  return true;
}

/**
 * A decision time whose step started but whose line was never written (the
 * driver was stopped mid-step): recorded as interrupted from what its process
 * left in the logs, and never run again (its cycle may have traded). Its
 * fills go to the next line. One whose line was written (a stop before the
 * manifest said so) is already recorded.
 */
function recoverPending(paths, manifest, log, recorded) {
  const p = manifest.pending;
  if (!p) return;
  delete manifest.pending;
  // Its line was written just before the stop (the manifest not yet saying so): already recorded.
  if (recorded.has(p.t)) {
    writeJsonAtomic(paths.manifest, manifest);
    return;
  }
  store.appendRecord(paths, manifest, {
    t: p.t, day: p.day, kind: p.kind, asked: p.kind, ran: [], events: [], step: { code: null, timedOut: false }, interrupted: true,
    cycles: store.cycleLogsSince(paths.runHome, p.startedMs).map(store.cycleSummary), refusals: store.refusalsSince(paths.runHome, p.startedMs),
    trades: null, since: manifest.tradesSince || null,
  });
  log(`${p.t} ${p.kind}: interrupted in a previous run; recorded from its logs, not run again`);
}

function defaultDeps(run, root) {
  const autotrader = path.join(root, 'scripts', 'autotrader.js');
  return {
    async step(point, env, timeoutMs) {
      const once = point.kind === 'eod-retry' ? 'eod' : point.kind;
      const res = await runHarness([process.execPath, autotrader, '--config', run.paths.autotrader, '--once', once], { cwd: root, env, timeoutMs });
      fs.appendFileSync(run.paths.stepsLog, `\n===== ${point.t.toISOString()} ${point.kind} (exit ${res.code}${res.timedOut ? ', timed out' : ''})\n${res.output}`);
      return res;
    },
    // The server must attest the replay at the time it was given (as the gateway checks before any order).
    async serverCheck(env, at) {
      const why = replayUnattested(await withAdapter({ root, env }, a => a.serverConfig()), at);
      return why && `${why}: is ${run.brokerEnv.clockFile || 'its clock'} read by the server of broker "${run.broker}"?`;
    },
    // Whether the account holds a position or a working order (a curated run manages what is open after a window).
    async open(env, account) {
      return accountOpen(await withAdapter({ root, env }, a => a.accountState(account)));
    },
    async trades(env, account, since, until) {
      // The run home's broker specs (env carries the run's FTH_HOME and FTH_BROKER).
      return withAdapter({ root, env }, a => fillsBetween(a, account, since, until, { entries: entryOrders(run.paths.runHome), specOf: liveSpecs(env) }));
    },
  };
}

/** The run's end of day for `day` verified flat (the runner's state says so). */
function eodVerified(run, day) {
  const state = readJson(path.join(run.paths.runHome, 'autotrader-state.json'), {}) || {};
  return state.day === day && Boolean(state.eodDone);
}

/**
 * The end-of-day try after one at `point` (`point.tries` retries so far), for when it isn't verified flat:
 * a minute later, while retries are left and it is before the close and the run's end; else null.
 */
function retryAfter(run, point) {
  const tries = point.tries || 0;
  const t = new Date(point.t.getTime() + 60000);
  if (tries >= EOD_RETRIES || sessionMinute(t) >= CLOSE_SESSION_MIN || t >= run.end) return null;
  return { t, kind: 'eod-retry', day: point.day, tries: tries + 1 };
}

const savedForm = r => r && { t: r.t.toISOString(), day: r.day, tries: r.tries };

/**
 * The end-of-day retry saved in the manifest (written before each end-of-day step runs, so a stop or a
 * crash at any point never loses it), to run first on resume; null when none is due: its day is done or
 * verified flat, or its time is already recorded or past the run's end.
 */
function savedRetry(run, manifest, lastMs) {
  const r = manifest.eodRetry;
  if (!r || (manifest.daysDone || []).includes(r.day) || eodVerified(run, r.day)) return null;
  const t = Date.parse(r.t);
  return t > lastMs && t < run.end.getTime() ? { t: new Date(t), kind: 'eod-retry', day: r.day, tries: r.tries } : null;
}

/** A pid that is running (signal 0 reaches it, or it belongs to another user). */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** One driver per run: an exclusive lock in the run's folder (a dead holder's is taken over). */
function lockRun(paths) {
  const file = path.join(paths.runDir, 'driver.lock');
  for (let i = 0; i < 2; i += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      return () => { try { fs.unlinkSync(file); } catch (_err) { /* gone */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = readJson(file, {});
      if (alive(holder.pid) && holder.pid !== process.pid) throw new Error(`another replay driver (pid ${holder.pid}) is running this run (${file})`, { cause: err });
      fs.unlinkSync(file);
    }
  }
  throw new Error(`could not lock ${file}`);
}

async function runReplay(opts) {
  const { run, baseEnv = process.env } = opts;
  // Never alongside live trading on this machine (each home has its own bars scratch directory, so the
  // bars no longer cross; the refusal stays as defense in depth).
  for (const home of new Set([harnessHome(baseEnv), harnessHome({})])) {
    const pid = liveRunner({ FTH_HOME: home });
    if (pid) throw new Error(`replay refused: the live runner is running (pid ${pid}, ${home}); replay when it is stopped.`);
  }
  const release = lockRun(run.paths);
  try {
    return await replayLoop(opts);
  } finally {
    release();
  }
}

async function replayLoop({ run, baseEnv = process.env, root, deps = defaultDeps(run, root), maxCycles = Infinity, log = () => {} }) {
  const { paths, cfg } = run;
  writeJsonAtomic(paths.autotrader, run.derived);
  const startEnv = replayEnv(baseEnv, run, { at: run.start });
  const problems = brokerErrors(startEnv, run);
  if (problems.length) throw new Error(`replay refused:\n- ${problems.join('\n- ')}`);
  const hash = configHash(run, baseEnv);
  const manifest = store.openRun(paths, {
    runId: run.runId, hash,
    info: { source: 'replay', broker: run.broker, start: run.start.toISOString(), end: run.end.toISOString(), harness: cfg.harness, model: cfg.model || null, command: harnessCommand(run, baseEnv), autotraderFile: run.autotraderFile },
  });
  // A curated run (learning/curated-lists.js) steps its list's windows and their days' premarket and end of day; every
  // other time from the first window on (later days included) is stepped only while a position or working order is
  // open (managed every bar, as practice does), checked at each day's first, and skipped once flat until the next
  // window; the broker's fills and brackets work through the gaps.
  const all = decisionPoints(cfg, { start: run.start, end: run.end, everyNth: run.everyNth });
  const points = run.curated ? curatedPoints(all, run.curated, (cfg.barDelaySeconds || 0) * 1000) : all;
  const recorded = store.recordedTimes(paths.runDir);
  // The run's prop attempt (config `prop`), started at the window's first moment before any decision: every trade of
  // the window is inside it. Only on a fresh run (nothing recorded yet): a resumed run keeps the attempt it has, or
  // the user's choice to end it.
  if (run.prop && !recorded.size && !readAttempt(paths.runHome, run.prop)) {
    startAttempt(paths.runHome, accountNamed(root || run.root, run.prop, startEnv), run.start);
    log(`started a ${run.prop} attempt at ${run.start.toISOString()}`);
  }
  recoverPending(paths, manifest, log, recorded);
  const todo = store.remaining(manifest, points, recorded);
  // An end-of-day retry queued before the last stop (--max-cycles, the kill switch, the error limit, a crash): it runs first.
  const lastAtStart = store.lastRecorded(manifest, recorded);
  const retry = savedRetry(run, manifest, lastAtStart);
  if (retry) todo.unshift(retry);
  else if (manifest.eodRetry) {
    delete manifest.eodRetry;
    writeJsonAtomic(paths.manifest, manifest);
  }
  const lastOfDay = new Map(points.map(p => [p.day, p]));
  if (!todo.length) {
    for (const day of new Set(points.map(p => p.day))) store.markDayDone(paths, manifest, day);
    return finished(paths, manifest, 0, points);
  }
  log(`${todo.length} of ${points.length} decision times left (${run.cfg.harness}, ${cfg.symbols.join(',')} ${cfg.timeframe}m)`);
  const writeClock = at => writeJsonAtomic(paths.clockFile, { now: at.toISOString() });
  writeClock(todo[0].t);
  const why = await deps.serverCheck(replayEnv(baseEnv, run, { at: todo[0].t }), todo[0].t);
  if (why) throw new Error(`replay refused: ${why}`);

  let since = manifest.tradesSince ? new Date(manifest.tradesSince) : run.start;
  let cycles = 0;
  let failures = 0;
  let fingerprintWarned = false;
  let credentialWarned = false;
  const timeoutMs = (cfg.cycleTimeoutMinutes * Math.max(1, cfg.symbols.length) + 2) * 60000;
  const queue = [...todo];
  // A curated run's management after a window: checked at its first time (and each day's first), then while something
  // stays open.
  let managing = true;
  let managingDay = null;
  while (queue.length) {
    if (cycles >= maxCycles) return { cycles, stopped: `stopped after ${cycles} decision times (--max-cycles)`, done: false };
    const env = replayEnv(baseEnv, run, { at: queue[0].t });
    // The run's kill switch (a cycle's workspace change, the runner's error limit): as live, the runner
    // then starts no trade cycle but keeps housekeeping and runs end of day (flat at the close). So the
    // day already under way runs to its end; the run stops before a new day, saying why, and resumes
    // there once the file is removed.
    const killed = killSwitchReason(env.FTH_KILL_SWITCH_FILE);
    const lastMs = Math.max(lastAtStart, manifest.lastT ? Date.parse(manifest.lastT) : -Infinity);
    const dayUnderWay = Number.isFinite(lastMs) && tradingDayKey(new Date(lastMs)) === queue[0].day;
    if (killed !== null && !dayUnderWay) return { cycles, stopped: `the run's kill switch is on (${env.FTH_KILL_SWITCH_FILE}${killed ? `: ${killed}` : ''}); review it, then remove the file`, done: false };
    const point = queue.shift();
    writeClock(point.t);
    if (point.day !== managingDay) {
      managingDay = point.day;
      managing = true;
    }
    if (point.manage) {
      if (!managing) continue;
      // A check that fails manages the bar (never leaves a position alone).
      const open = await Promise.resolve().then(() => deps.open(env, cfg.account)).then(Boolean, () => true);
      if (!open) {
        managing = false;
        log(`${point.t.toISOString()}: flat outside the curated windows; the clock advances to the next window`);
        continue;
      }
    } else if (point.kind === 'trade') managing = true;
    const started = Date.now();
    // Marked before it runs: a driver stopped before its line is written never runs this time twice.
    manifest.pending = { t: point.t.toISOString(), day: point.day, kind: point.kind, startedMs: started };
    // An end of day saves its retry first (the next try, in case it isn't verified flat), so a stop or a
    // crash during or after it never loses it, and retries never exceed EOD_RETRIES across resumes.
    const eodStep = point.kind === 'eod' || point.kind === 'eod-retry';
    const savedBefore = manifest.eodRetry;
    if (eodStep) {
      if (retryAfter(run, point)) manifest.eodRetry = savedForm(retryAfter(run, point));
      else delete manifest.eodRetry;
    }
    writeJsonAtomic(paths.manifest, manifest);
    const res = await deps.step(point, env, timeoutMs);
    const step = store.parseStep(res.output);
    // The pass ran and a cycle in it failed: recorded as an attempt below, and the time runs again.
    // Only an infrastructure failure (no decision: a failed or timed-out harness, no CYCLE RESULT line); the
    // agent's own error result is a decision, recorded as live records it, and the run goes on.
    const cycleFailed = res.code !== 0 && Boolean(step) && noDecision(step.ran);
    // A step that exits non-zero with a failed cycle in its line ran (an attempt, or the agent's own error, a
    // decision); otherwise it could not run.
    if (!step || (res.code !== 0 && !(step.ran || []).some(r => !r.ok))) {
      // Nothing ran (no cycle, no order): the time can run again once the cause is fixed.
      if (!store.touchedSince(paths.runHome, started)) {
        delete manifest.pending;
        if (savedBefore) manifest.eodRetry = savedBefore;
        else delete manifest.eodRetry;
        writeJsonAtomic(paths.manifest, manifest);
      }
      throw new Error(`the runner could not run at ${point.t.toISOString()} (exit ${res.code}${res.timedOut ? ', timed out' : ''}); see ${paths.stepsLog}: ${String(res.output || '').trim().split('\n').slice(-3).join(' | ')}`);
    }
    let trades = null;
    if (cfg.account) {
      try {
        trades = await deps.trades(env, cfg.account, since, point.t);
      } catch (err) {
        trades = { error: err.message };
      }
    }
    const rec = decisionRecord({
      t: point.t.toISOString(), day: point.day, kind: point.kind, pass: step, step: { code: res.code, timedOut: Boolean(res.timedOut) },
      cycles: store.cycleLogsSince(paths.runHome, started).map(store.cycleSummary), refusals: store.refusalsSince(paths.runHome, started),
      trades, since: since.toISOString(), killSwitch: killed,
      premarketUnavailable: step.state && step.state.day === point.day ? step.state.premarketUnavailable || null : null,
      premarketAvailableAt: step.state && step.state.day === point.day ? step.state.premarketAvailableAt || null : null,
      premarketRetryStarved: step.state && step.state.day === point.day ? step.state.premarketRetryStarved || 0 : 0,
      lanes: point.lanes || null,
    });
    // The version of the agent that made this decision (each step is a fresh process on the tree as it is now).
    // With the replay broker's bar-shaping settings (its fingerprintEnv allowlist), as live records its broker's;
    // settings that can't be fingerprinted are logged once and recorded as fingerprintError, never a silent null.
    const fp = brokerFingerprint(env);
    if (fp.error && !fingerprintWarned) {
      fingerprintWarned = true;
      log(`${rec.t}: ERROR ${fp.error}; recorded as fingerprintError, so no other version counts as the same`);
    }
    if (fp.warning && !credentialWarned) {
      credentialWarned = true;
      log(`${rec.t}: ${fp.warning}`);
    }
    noteVersion(manifest, { since: rec.t, hash, fingerprints: fingerprints(root || run.root, { broker: fp.broker, error: fp.error }) });
    if (cycleFailed) {
      // Never a decision done: no progress, no fills window moved (the retry reads them again), the end-of-day
      // retry as it was before this try. The attempt's line and the manifest's cycleRetry say it is due.
      delete manifest.pending;
      if (savedBefore) manifest.eodRetry = savedBefore;
      else delete manifest.eodRetry;
      const tries = (manifest.cycleRetry && manifest.cycleRetry.t === rec.t ? manifest.cycleRetry.tries : 0) + 1;
      store.appendAttempt(paths, manifest, rec, tries);
      cycles += 1;
      failures += 1;
      log(`${rec.t} ${point.kind}: ${rec.ran.map(r => `${r.action} ${r.result || (r.ok ? 'ok' : 'failed')}`).join('; ')}: a failed cycle (try ${tries}); this time runs again`);
      if (failures >= cfg.maxConsecutiveErrors) return { cycles, stopped: `${failures} failed cycles in a row at ${rec.t} (it runs again on resume); see ${paths.stepsLog}`, done: false };
      queue.unshift(point);
      continue;
    }
    // A failed read is retried from the same time on the next one (also after a resume).
    if (!(trades && trades.error)) since = point.t;
    manifest.tradesSince = since.toISOString();
    delete manifest.pending;
    // Verified flat: no retry (cleared in the same write as its line).
    if (eodStep && eodVerified(run, point.day)) delete manifest.eodRetry;
    store.appendRecord(paths, manifest, rec);
    cycles += 1;
    // A failed cycle, or a bar's pass that ran none and read no bar for a symbol while logging errors (the
    // broker's bars or contract failing): a failure, so a broken broker never reads as a quiet trader.
    const unread = (step.bars || []).some(b => !b.lastBarT);
    // A premarket run's failure (the first or a retry) is never a failed run, live or here.
    const failed = rec.ran.some(failedRun) || (point.kind === 'trade' && !rec.ran.length && unread && rec.errors.length > 0);
    failures = failed ? failures + 1 : rec.ran.length ? 0 : failures;
    log(`${rec.t} ${point.kind}: ${rec.ran.map(r => `${r.action} ${r.result || (r.ok ? 'ok' : 'failed')}`).join('; ') || (killed !== null ? 'no cycle (kill switch on)' : 'no cycle')}${rec.refusals.length ? `; ${rec.refusals.length} gate refusal(s)` : ''}${Array.isArray(trades) && trades.length ? `; ${trades.length} fill(s)` : ''}`);
    // End of day not verified flat: once more a minute later, as the live runner retries, before the close
    // (saved in the manifest before this step ran, so a stop here, the error limit included, keeps it).
    const next = eodStep && manifest.eodRetry ? retryAfter(run, point) : null;
    if (failures >= cfg.maxConsecutiveErrors) return { cycles, stopped: `${failures} failed cycles in a row at ${rec.t}; see ${paths.stepsLog}`, done: false };
    if (next) {
      queue.unshift(next);
      continue;
    }
    const nextPoint = queue[0];
    if (lastOfDay.get(point.day) && (!nextPoint || nextPoint.day !== point.day) && point.t >= lastOfDay.get(point.day).t) store.markDayDone(paths, manifest, point.day);
  }
  return finished(paths, manifest, cycles, points);
}

/**
 * Every decision time of the run's window ran: the manifest says so (`finished`), the one sign a run is
 * done (a stop at a day's boundary leaves every day so far done), which its labels wait for (labels.js).
 */
function finished(paths, manifest, cycles, points) {
  // Every day of the window is done too (a stop right after a day's last time can leave it unmarked).
  for (const day of new Set(points.map(p => p.day))) if (!manifest.daysDone.includes(day)) manifest.daysDone.push(day);
  manifest.finished = true;
  writeJsonAtomic(paths.manifest, manifest);
  return { cycles, stopped: null, done: true };
}

module.exports = { seedRunHome, runReplay, defaultDeps, withEntry, EOD_RETRIES };
