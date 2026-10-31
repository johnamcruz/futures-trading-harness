'use strict';

const test = require('node:test');
const assert = require('node:assert');
const GF = require('../../scripts/lib/eval/goal-fetch');

const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();

/** A replay-style server: a clock, bars only closed by it, and a front month by it (none of a later month's past). */
function replayServer(bars, rollMs) {
  let clock = null;
  return {
    setClock: at => { clock = at.getTime(); },
    history: async (_s, { from, to }) => {
      if (clock === null) throw new Error('no clock');
      // After the roll, the new front month holds no bars before the roll (a continuous-series replay server).
      const earliest = clock > rollMs ? rollMs : -Infinity;
      return bars.filter(b => { const t = Date.parse(b.t); return t >= from.getTime() && t < to.getTime() && t < clock && t >= earliest; });
    },
  };
}

test('fetchChunks, a replay-style server: the clock at each chunk\'s end, so a roll inside the window loses no bars (one clock at the end would)', async () => {
  const from = Date.parse('2022-03-01T00:00:00Z');
  const bars = Array.from({ length: 20 }, (_, i) => ({ t: iso(from + i * DAY + 3600000), o: i, h: i, l: i, c: i, v: 1, extra: 'x' }));
  const roll = from + 10 * DAY;
  const srv = replayServer(bars, roll);
  const got = await GF.fetchChunks({ history: srv.history, setClock: srv.setClock, symbol: 'MNQ', from: new Date(from), to: new Date(from + 20 * DAY), minutes: 3, chunkMs: 5 * DAY });
  assert.strictEqual(got.length, 20, 'every bar, the roll inside the window');
  assert.deepStrictEqual(Object.keys(got[0]), ['t', 'o', 'h', 'l', 'c', 'v'], 'OHLCV only');
  // The old way, one clock at the window's end: the front month after the roll holds none of the bars before it.
  const one = replayServer(bars, roll);
  one.setClock(new Date(from + 20 * DAY));
  assert.strictEqual((await one.history('MNQ', { from: new Date(from), to: new Date(from + 20 * DAY) })).length, 10);
});

test('fetchChunks, a live-style server: no clock, the same chunks, nothing set', async () => {
  const from = Date.parse('2022-03-01T00:00:00Z');
  const calls = [];
  const history = async (symbol, o) => { calls.push([symbol, o.from.toISOString(), o.to.toISOString(), o.timeframe]); return [{ t: iso(o.from.getTime() + 60000), o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: iso(o.to.getTime()), o: 1, h: 1, l: 1, c: 1, v: 1 }]; };
  const got = await GF.fetchChunks({ history, symbol: 'MNQ', from: new Date(from), to: new Date(from + 3 * DAY), minutes: 3, chunkMs: 2 * DAY });
  assert.deepStrictEqual(calls, [['MNQ', iso(from), iso(from + 2 * DAY), 3], ['MNQ', iso(from + 2 * DAY), iso(from + 3 * DAY), 3]]);
  assert.strictEqual(got.length, 2, 'a bar at a chunk\'s end is the next chunk\'s, never twice');
});

test('brokerEnvFor: the replay broker, each variable its replay config names (none of the harness\'s own)', () => {
  const run = { broker: 'replaymock', brokerEnv: { clockFile: 'X_CLOCK', stateDir: 'X_STATE', runId: 'X_RUN', start: 'X_START', end: 'X_END' } };
  const from = new Date('2022-01-03T00:00:00Z');
  const to = new Date('2022-02-01T00:00:00Z');
  const env = GF.brokerEnvFor(run, { clockFile: '/c', stateDir: '/s', from, to, base: { KEEP: '1' } });
  assert.deepStrictEqual(env, { KEEP: '1', FTH_BROKER: 'replaymock', FTH_REPLAY_NOW: to.toISOString(), X_CLOCK: '/c', X_STATE: '/s', X_RUN: 'goal-fixture', X_START: from.toISOString(), X_END: to.toISOString() });
});
