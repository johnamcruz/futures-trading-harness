'use strict';

/**
 * The goal regression's real bars for the local run (npm run goal:real; docs/TRAINING.md, "The goal regression"):
 * fetched from whichever broker MCP server is configured, through the harness's broker adapter (broker/adapter.js
 * history: the interface's get_bars, paged), never a file path:
 *
 *   a replay broker (brokers.json `replay: true`; named by a replay config, as a replay names it): its server serves
 *   bars closed by its clock and the root's front contract by that clock, so the window is fetched chunk by chunk with
 *   the clock at each chunk's end (the variable the replay config's `brokerEnv` names for it, as the replay driver sets
 *   it), never one clock for the whole window (a later front month holds none of the earlier bars); a chunk a run
 *   serves nothing of (after a contract roll) is fetched again in a fresh run starting there
 *   a live broker (read only: get_bars alone): no clock, chunk by chunk all the same
 *
 *   fetchChunks({ history, setClock, symbol, from, to, minutes, chunkMs })   the bars of [from, to), chunk by chunk
 *                          through `history` (adapter.history); setClock(end) before each chunk when the server has a clock
 *   brokerEnvFor(run, { clockFile, stateDir, from, to, base })   a replay broker's environment for the adapter
 *   fetchAll({ root, replayConfig, broker, from, to, dir, symbol, minutes })   the bars (async): from the replay config's
 *                          replay broker, or the named broker (a live one, read only)
 */

const fs = require('fs');
const path = require('path');

const chunkMsOf = () => require('../tunables').training().goalRegression.real.chunkDays * 86400000;

async function fetchChunks({ history, setClock = null, symbol, from, to, minutes, chunkMs = chunkMsOf() }) {
  const out = [];
  for (let t = from.getTime(); t < to.getTime(); t += chunkMs) {
    const end = new Date(Math.min(t + chunkMs, to.getTime()));
    if (setClock) setClock(end);
    const bars = await history(symbol, { from: new Date(t), to: end, timeframe: minutes });
    for (const b of Array.isArray(bars) ? bars : []) {
      const ms = Date.parse(b.t);
      if (ms >= t && ms < end.getTime()) out.push({ t: new Date(ms).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
  }
  return out;
}

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

async function fetchAll({ root, replayConfig = null, broker = null, from, to, dir, symbol, minutes, base = process.env }) {
  fs.mkdirSync(dir, { recursive: true });
  if (!replayConfig) {
    // A live broker, read only: get_bars alone, every month's own history, no clock.
    const env = { ...base, FTH_BROKER: broker, FTH_HOME: dir };
    return require('../broker/adapter').withAdapter({ root, env }, a => fetchChunks({ history: (s, o) => a.history(s, o), symbol, from, to, minutes }));
  }
  const { resolveReplay } = require('../replay/config');
  const raw = JSON.parse(fs.readFileSync(replayConfig, 'utf8'));
  // Only what names the broker and its server (the run's own settings, a combine, a stage, a list, are no fetch's); its
  // window the sessions' (the warm-up rule refuses an earlier start), the server's own reaching back to `from`.
  const sessions = require('../schedule').current().data.sessionsFrom;
  const own = { runId: 'goal-fixture', workDir: dir, broker: raw.broker, autotrader: raw.autotrader, ...(raw.brokerEnv ? { brokerEnv: raw.brokerEnv } : {}), learning: false };
  const run = resolveReplay({ ...own, start: `${sessions}T00:00:00Z`, end: to.toISOString().replace('.000Z', 'Z') }, { baseDir: path.dirname(path.resolve(replayConfig)), root });
  // Chunk by chunk with the clock at each chunk's end, inside replay runs of their own (segmentDays each); a chunk a run
  // serves nothing of
  // (a replay server's run that started before a contract roll serves the new front month from its data switch only)
  // is fetched again in a fresh run starting at that chunk (its own window, state and clock, moving forward).
  const chunkMs = chunkMsOf();
  const { openAdapter } = require('../broker/adapter');
  let seg = null;
  let k = 0;
  const segMs = require('../tunables').training().goalRegression.real.segmentDays * 86400000;
  // A run's window: from its start, segmentDays long at most (a replay server serves a run's own window).
  const open = at => {
    if (seg) seg.adapter.close();
    const d = path.join(dir, `run-${k += 1}`);
    fs.mkdirSync(d, { recursive: true });
    const clockFile = path.join(d, 'clock.json');
    const setClock = t => fs.writeFileSync(clockFile, JSON.stringify({ now: t.toISOString() }));
    setClock(at);
    const until = new Date(Math.min(at.getTime() + segMs, to.getTime()));
    seg = { until, setClock, adapter: openAdapter({ root, env: brokerEnvFor(run, { clockFile, stateDir: path.join(d, 'broker'), from: at, to: until, base }) }) };
  };
  const out = [];
  try {
    open(from);
    for (let t = from.getTime(); t < to.getTime(); t += chunkMs) {
      const a0 = new Date(t);
      const a1 = new Date(Math.min(t + chunkMs, to.getTime()));
      const one = () => fetchChunks({ history: (x, o) => seg.adapter.history(x, o), setClock: seg.setClock, symbol, from: a0, to: a1, minutes, chunkMs });
      if (a1 > seg.until) open(a0);
      let got = await one();
      if (!got.length) { open(a0); got = await one(); }
      out.push(...got);
    }
  } finally {
    if (seg) seg.adapter.close();
  }
  return out;
}

module.exports = { fetchChunks, brokerEnvFor, fetchAll };
