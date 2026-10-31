'use strict';

const test = require('node:test');
const assert = require('node:assert');
const GF = require('../../scripts/lib/eval/goal-fetch');

test('brokerEnvFor: the replay broker, its clock past the window, each variable the replay config names (none of its own)', () => {
  const run = { broker: 'replaymock', brokerEnv: { clockFile: 'X_CLOCK', stateDir: 'X_STATE', runId: 'X_RUN', start: 'X_START', end: 'X_END' } };
  const from = new Date('2022-01-03T00:00:00Z');
  const to = new Date('2022-02-01T00:00:00Z');
  const env = GF.brokerEnvFor(run, { clockFile: '/c', stateDir: '/s', from, to, base: { KEEP: '1' } });
  assert.deepStrictEqual(env, { KEEP: '1', FTH_BROKER: 'replaymock', FTH_REPLAY_NOW: to.toISOString(), X_CLOCK: '/c', X_STATE: '/s', X_RUN: 'goal-fixture', X_START: from.toISOString(), X_END: to.toISOString() });
  assert.deepStrictEqual(Object.keys(GF.brokerEnvFor({ broker: 'b', brokerEnv: {} }, { clockFile: '/c', stateDir: '/s', from, to, base: {} })).sort(), ['FTH_BROKER', 'FTH_REPLAY_NOW']);
});

test('fetchSpan: the window\'s bars through the adapter\'s history, OHLCV only, inside [from, to)', async () => {
  const calls = [];
  const history = async (symbol, o) => {
    calls.push([symbol, o]);
    return [{ t: '2022-01-02T23:57:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: '2022-01-03T00:00:00Z', o: 2, h: 3, l: 1, c: 2, v: 5, extra: 'x' }, { t: '2022-02-01T00:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }];
  };
  const bars = await GF.fetchSpan(history, { symbol: 'MNQ', from: new Date('2022-01-03T00:00:00Z'), to: new Date('2022-02-01T00:00:00Z'), minutes: 3 });
  assert.deepStrictEqual(bars, [{ t: '2022-01-03T00:00:00.000Z', o: 2, h: 3, l: 1, c: 2, v: 5 }]);
  assert.deepStrictEqual(calls, [['MNQ', { start: '2022-01-03T00:00:00.000Z', end: '2022-02-01T00:00:00.000Z', timeframe: 3 }]]);
});
