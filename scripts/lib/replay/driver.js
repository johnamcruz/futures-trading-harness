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
 * the runner hasn't verified the account flat; a day is done after its last
 * time. The run stops after cfg.maxConsecutiveErrors failed cycles in a row,
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
const { withAdapter } = require('../broker/adapter');
const { contractRoot } = require('../trading/journal');
const { specFor } = require('../trading/contracts');
const { sessionMinute, MARKET_OPEN_MIN, MARKET_CLOSE_MIN } = require('../trading/clock');
const { SERVER_TIME_TOLERANCE_MS } = require('../trading/harness-now');
const { decisionPoints } = require('./schedule');
const { replayEnv, brokerErrors, configHash, harnessCommand } = require('./config');
const store = require('./store');

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
  const brokersFile = loadBrokers(userEnv).file;
  if (fs.existsSync(brokersFile)) fs.copyFileSync(brokersFile, path.join(paths.runHome, 'brokers.json'));
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

/** An opening fill matched to the entry the gateway recorded (its strategy and stop), for R. */
function withEntry(fill, entries) {
  const e = fill.profitAndLoss === null || fill.profitAndLoss === undefined ? entries.find(x => String(x.orderId) === String(fill.orderId)) : null;
  if (!e) return fill;
  const spec = specFor(contractRoot(fill.contractId));
  return { ...fill, entry: { setup: e.setup || null, stopTicks: e.stopTicks || null, tickValue: spec ? spec.tickValue : null } };
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
      const cfg = await withAdapter({ root, env }, a => a.serverConfig());
      const t = Date.parse(String((cfg && cfg.serverTime) || ''));
      if (!cfg || cfg.replay !== true) return `the server of broker "${run.broker}" does not report itself a replay server (get_server_config.replay)`;
      if (!Number.isFinite(t) || Math.abs(t - at.getTime()) > SERVER_TIME_TOLERANCE_MS) return `the replay server's time (${cfg.serverTime}) is not the replay clock's (${at.toISOString()}): is ${run.brokerEnv.clockFile || 'its clock'} read by the server?`;
      return null;
    },
    async trades(env, account, since, until) {
      const fills = await withAdapter({ root, env }, a => a.fillsSince(account, since));
      const entries = entryOrders(run.paths.runHome);
      return fills.filter(f => Date.parse(f.creationTimestamp) > since.getTime() && Date.parse(f.creationTimestamp) <= until.getTime()).map(f => withEntry(f, entries));
    },
  };
}

async function runReplay({ run, baseEnv = process.env, root, deps = defaultDeps(run, root), maxCycles = Infinity, log = () => {} }) {
  const { paths, cfg } = run;
  writeJsonAtomic(paths.autotrader, run.derived);
  const startEnv = replayEnv(baseEnv, run, { at: run.start });
  const problems = brokerErrors(startEnv, run);
  if (problems.length) throw new Error(`replay refused:\n- ${problems.join('\n- ')}`);
  const manifest = store.openRun(paths, {
    runId: run.runId, hash: configHash(run, baseEnv),
    info: { broker: run.broker, start: run.start.toISOString(), end: run.end.toISOString(), harness: cfg.harness, model: cfg.model || null, command: harnessCommand(run, baseEnv), autotraderFile: run.autotraderFile },
  });
  const points = decisionPoints(cfg, { start: run.start, end: run.end, everyNth: run.everyNth });
  const todo = store.remaining(manifest, points);
  const lastOfDay = new Map(points.map(p => [p.day, p]));
  if (!todo.length) {
    for (const day of new Set(points.map(p => p.day))) store.markDayDone(paths, manifest, day);
    return { cycles: 0, stopped: null, done: true };
  }
  log(`${todo.length} of ${points.length} decision times left (${run.cfg.harness}, ${cfg.symbols.join(',')} ${cfg.timeframe}m)`);
  const writeClock = at => writeJsonAtomic(paths.clockFile, { now: at.toISOString() });
  writeClock(todo[0].t);
  const why = await deps.serverCheck(replayEnv(baseEnv, run, { at: todo[0].t }), todo[0].t);
  if (why) throw new Error(`replay refused: ${why}`);

  let since = manifest.tradesSince ? new Date(manifest.tradesSince) : run.start;
  let cycles = 0;
  let failures = 0;
  const timeoutMs = (cfg.cycleTimeoutMinutes * Math.max(1, cfg.symbols.length) + 2) * 60000;
  const queue = [...todo];
  while (queue.length) {
    if (cycles >= maxCycles) return { cycles, stopped: `stopped after ${cycles} decision times (--max-cycles)`, done: false };
    const point = queue.shift();
    writeClock(point.t);
    const env = replayEnv(baseEnv, run, { at: point.t });
    const started = Date.now();
    const res = await deps.step(point, env, timeoutMs);
    const step = store.parseStep(res.output);
    if (res.code !== 0 || !step) {
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
    const rec = {
      t: point.t.toISOString(), day: point.day, kind: point.kind, asked: step.asked, ran: step.ran || [], events: step.events || [],
      step: { code: res.code, timedOut: Boolean(res.timedOut) },
      cycles: store.cycleLogsSince(paths.runHome, started).map(store.cycleSummary),
      refusals: store.refusalsSince(paths.runHome, started),
      trades, since: since.toISOString(),
    };
    // A failed read is retried from the same time on the next one (also after a resume).
    if (!(trades && trades.error)) since = point.t;
    manifest.tradesSince = since.toISOString();
    store.appendRecord(paths, manifest, rec);
    cycles += 1;
    const failed = rec.ran.some(r => !r.ok);
    failures = failed ? failures + 1 : rec.ran.length ? 0 : failures;
    log(`${rec.t} ${point.kind}: ${rec.ran.map(r => `${r.action} ${r.result || (r.ok ? 'ok' : 'failed')}`).join('; ') || 'no cycle'}${rec.refusals.length ? `; ${rec.refusals.length} gate refusal(s)` : ''}${Array.isArray(trades) && trades.length ? `; ${trades.length} fill(s)` : ''}`);
    if (failures >= cfg.maxConsecutiveErrors) return { cycles, stopped: `${failures} failed cycles in a row at ${rec.t}; see ${paths.stepsLog}`, done: false };
    // End of day not verified flat: once more a minute later, as the live runner retries, before the close.
    if (point.kind === 'eod' || point.kind === 'eod-retry') {
      const state = readJson(path.join(paths.runHome, 'autotrader-state.json'), {}) || {};
      const tries = point.tries || 0;
      const next = new Date(point.t.getTime() + 60000);
      if (!(state.day === point.day && state.eodDone) && tries < EOD_RETRIES && sessionMinute(next) < CLOSE_SESSION_MIN && next < run.end) {
        queue.unshift({ t: next, kind: 'eod-retry', day: point.day, tries: tries + 1 });
        continue;
      }
    }
    const nextPoint = queue[0];
    if (lastOfDay.get(point.day) && (!nextPoint || nextPoint.day !== point.day) && point.t >= lastOfDay.get(point.day).t) store.markDayDone(paths, manifest, point.day);
  }
  return { cycles, stopped: null, done: true };
}

module.exports = { seedRunHome, runReplay, defaultDeps, withEntry, EOD_RETRIES };
