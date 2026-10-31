'use strict';

/**
 * The goal regression's real bars for the local run (npm run goal:real; docs/TRAINING.md, "The goal regression"): fetched
 * through the configured replay broker's MCP server, by the harness's broker adapter (broker/adapter.js history: the
 * interface's get_bars, paged), the way a replay reads them, never a file path. The replay config names the broker and
 * the variables its server reads (resolveReplay: `broker`, `brokerEnv`); the server's clock is set past the window's end
 * (a replay server serves only bars closed by its clock), its state in a scratch directory.
 *
 *   brokerEnvFor(run, { clockFile, stateDir, from, to, base })   the environment the adapter starts the server with
 *   fetchSpan(history, { symbol, from, to, minutes })   the bars of [from, to) through `history` (adapter.history)
 *   fetchAll({ root, replayConfig, from, to, dir, symbol, minutes })   the bars, through the replay broker (async), chunk
 *                              by chunk (goalRegression.real.chunkDays), the server's clock at each chunk's end
 */

const fs = require('fs');
const path = require('path');

function brokerEnvFor(run, { clockFile, stateDir, from, to, base = process.env }) {
  const env = { ...base, FTH_BROKER: run.broker, FTH_REPLAY_NOW: to.toISOString() };
  const set = (k, v) => { if (k) env[k] = v; };
  set(run.brokerEnv.clockFile, clockFile);
  set(run.brokerEnv.stateDir, stateDir);
  set(run.brokerEnv.runId, 'goal-fixture');
  set(run.brokerEnv.start, from.toISOString());
  set(run.brokerEnv.end, to.toISOString());
  return env;
}

async function fetchSpan(history, { symbol, from, to, minutes }) {
  const bars = await history(symbol, { start: from.toISOString(), end: to.toISOString(), timeframe: minutes });
  return (Array.isArray(bars) ? bars : []).map(b => ({ t: new Date(Date.parse(b.t)).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
    .filter(b => Date.parse(b.t) >= from.getTime() && Date.parse(b.t) < to.getTime());
}

async function fetchAll({ root, replayConfig, from, to, dir, symbol, minutes }) {
  const { resolveReplay } = require('../replay/config');
  const { withAdapter } = require('../broker/adapter');
  const raw = JSON.parse(fs.readFileSync(replayConfig, 'utf8'));
  // The run home is the scratch directory's: nothing of the user's replay runs is read or written.
  // Its window the sessions' (the warm-up rule refuses an earlier start); the server's own window reaches back to `from`.
  const sessions = require('../schedule').current().data.sessionsFrom;
  // Only what names the broker and its server (the run's own settings, a combine, a stage, a list, are no fetch's).
  const own = { runId: 'goal-fixture', workDir: dir, broker: raw.broker, autotrader: raw.autotrader, ...(raw.brokerEnv ? { brokerEnv: raw.brokerEnv } : {}), learning: false };
  const run = resolveReplay({ ...own, start: `${sessions}T00:00:00Z`, end: to.toISOString().replace('.000Z', 'Z') }, { baseDir: path.dirname(path.resolve(replayConfig)), root });
  fs.mkdirSync(dir, { recursive: true });
  const clockFile = path.join(dir, 'clock.json');
  fs.writeFileSync(clockFile, JSON.stringify({ now: to.toISOString() }));
  const env = brokerEnvFor(run, { clockFile, stateDir: path.join(dir, 'broker'), from, to });
  // Chunk by chunk, the server's clock at each chunk's end: the contract it serves is the front month of that time (a
  // replay server serves the root's active contract by its clock), as a replay sees it.
  const chunkMs = require('../tunables').training().goalRegression.real.chunkDays * 86400000;
  return withAdapter({ root, env }, async a => {
    const out = [];
    for (let t = from.getTime(); t < to.getTime(); t += chunkMs) {
      const end = new Date(Math.min(t + chunkMs, to.getTime()));
      fs.writeFileSync(clockFile, JSON.stringify({ now: end.toISOString() }));
      out.push(...await fetchSpan((s, o) => a.history(s, o), { symbol, from: new Date(t), to: end, minutes }));
    }
    return out;
  });
}

module.exports = { brokerEnvFor, fetchSpan, fetchAll };
