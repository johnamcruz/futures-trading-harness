'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { harnessNow, recordNow, resolveClock, pinGatewayClock, createGatewayClock, ReplayClockError } = require('../../scripts/lib/trading/harness-now');
const { tmpDir } = require('../helpers');

const REPLAY = '2026-03-02T15:30:00Z';
const near = t => Math.abs(t.getTime() - Date.now()) < 60000;

/** An isolated harness home whose brokers.json adds `brokers` (and selects `broker`). */
function homeWith(brokers = {}, broker = undefined) {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ ...(broker ? { broker } : {}), brokers }));
  return home;
}
const SIM = { sim: { description: 'replayed history', command: ['node', 'sim.js'], replay: true } };

test('harnessNow: unset (or empty) FTH_REPLAY_NOW is the wall clock', () => {
  const home = homeWith(SIM, 'sim');
  assert.ok(near(harnessNow({ FTH_HOME: home })));
  assert.ok(near(harnessNow({ FTH_HOME: home, FTH_REPLAY_NOW: '' })));
  // Without the override the broker config isn't even read: a broken one doesn't matter.
  assert.ok(near(harnessNow({ FTH_BROKERS_FILE: '/nonexistent/brokers.json' })));
});

test('harnessNow: FTH_REPLAY_NOW with a replay broker is that time, in autonomous runs too', () => {
  const home = homeWith(SIM, 'sim');
  assert.strictEqual(harnessNow({ FTH_HOME: home, FTH_REPLAY_NOW: REPLAY }).toISOString(), '2026-03-02T15:30:00.000Z');
  assert.strictEqual(harnessNow({ FTH_HOME: home, FTH_REPLAY_NOW: REPLAY, FTH_AUTONOMOUS: '1' }).toISOString(), '2026-03-02T15:30:00.000Z');
  // It wins over the test suite's clock, and FTH_BROKER selects the broker as anywhere else.
  assert.strictEqual(harnessNow({ FTH_HOME: home, FTH_REPLAY_NOW: REPLAY, NODE_ENV: 'test', FTH_TEST_NOW: '2026-10-07T14:30:00Z' }).toISOString(), '2026-03-02T15:30:00.000Z');
  assert.strictEqual(harnessNow({ FTH_HOME: homeWith(SIM), FTH_BROKER: 'sim', FTH_REPLAY_NOW: '2026-03-02T15:30:05.250Z' }).toISOString(), '2026-03-02T15:30:05.250Z');
  // A fresh Date each time: a caller can't move the clock for the next one.
  const a = harnessNow({ FTH_HOME: home, FTH_REPLAY_NOW: REPLAY });
  a.setUTCFullYear(2000);
  assert.strictEqual(harnessNow({ FTH_HOME: home, FTH_REPLAY_NOW: REPLAY }).getUTCFullYear(), 2026);
});

test('harnessNow: FTH_REPLAY_NOW with a broker that is not a replay broker is refused (never a fake time live)', () => {
  // The default broker (TopstepX), with nothing configured.
  assert.throws(() => harnessNow({ FTH_HOME: tmpDir(), FTH_REPLAY_NOW: REPLAY }), err => err instanceof ReplayClockError && /broker "topstepx" is not a replay broker/.test(err.message));
  assert.throws(() => harnessNow({ FTH_HOME: tmpDir(), FTH_REPLAY_NOW: REPLAY, FTH_AUTONOMOUS: '1' }), ReplayClockError);
  // Only "replay": true counts.
  const loose = homeWith({ sim: { command: ['node', 'sim.js'], replay: 'true' } }, 'sim');
  assert.throws(() => harnessNow({ FTH_HOME: loose, FTH_REPLAY_NOW: REPLAY }), /"sim" is not a replay broker/);
  // A replay broker configured but not selected doesn't count.
  assert.throws(() => harnessNow({ FTH_HOME: homeWith(SIM), FTH_REPLAY_NOW: REPLAY }), /"topstepx"/);
  // A broker the defaults ship as live can't be relabelled a replay broker by an override.
  const relabelled = homeWith({ topstepx: { replay: true } });
  assert.throws(() => harnessNow({ FTH_HOME: relabelled, FTH_REPLAY_NOW: REPLAY }), /"topstepx" is not a replay broker/);
  // An unreadable broker config is refused too.
  assert.throws(() => harnessNow({ FTH_BROKERS_FILE: '/nonexistent/brokers.json', FTH_REPLAY_NOW: REPLAY }), /broker config can't be read/);
  const broken = tmpDir();
  fs.writeFileSync(path.join(broken, 'brokers.json'), '{ broken');
  assert.throws(() => harnessNow({ FTH_HOME: broken, FTH_REPLAY_NOW: REPLAY }), ReplayClockError);
});

test('harnessNow: an FTH_REPLAY_NOW that is not an ISO 8601 UTC time is refused, even with a replay broker', () => {
  const home = homeWith(SIM, 'sim');
  for (const bad of ['garbage', ' ', '1772465400000', '2026-03-02', '2026-03-02 15:30:00Z', '2026-03-02T15:30:00', '2026-03-02T15:30:00+01:00',
    '2026-02-30T10:00:00Z', '2026-03-02T24:00:00Z', '2026-03-02T15:60:00Z', '2026-03-02T15:30:60Z', ` ${REPLAY}`]) {
    assert.throws(() => harnessNow({ FTH_HOME: home, FTH_REPLAY_NOW: bad }), err => err instanceof ReplayClockError && /not an ISO 8601 UTC time/.test(err.message), bad);
  }
  assert.strictEqual(harnessNow({ FTH_HOME: home, FTH_REPLAY_NOW: '2026-03-02T15:30Z' }).toISOString(), '2026-03-02T15:30:00.000Z');
});

test('harnessNow: the test clock (FTH_TEST_NOW) works only under the test suite, never in autonomous runs', () => {
  const far = '2020-01-01T00:00:00Z';
  assert.ok(near(harnessNow({ FTH_TEST_NOW: far })), 'ignored without NODE_ENV=test');
  assert.ok(near(harnessNow({ FTH_TEST_NOW: far, NODE_ENV: 'test', FTH_AUTONOMOUS: '1' })), 'ignored in autonomous runs');
  assert.ok(!near(harnessNow({ FTH_TEST_NOW: far, NODE_ENV: 'test' })));
});

test('recordNow: the replay time when honored, else the wall clock; never throws', () => {
  const home = homeWith(SIM, 'sim');
  assert.strictEqual(recordNow({ FTH_HOME: home, FTH_REPLAY_NOW: REPLAY }).toISOString(), '2026-03-02T15:30:00.000Z');
  assert.ok(near(recordNow({ FTH_HOME: tmpDir(), FTH_REPLAY_NOW: REPLAY })));
  assert.ok(near(recordNow({ FTH_HOME: home, FTH_REPLAY_NOW: 'garbage' })));
  assert.ok(near(recordNow({ FTH_HOME: home })));
});

test('harnessNow: testClock false never takes FTH_TEST_NOW (the runner trades live)', () => {
  const far = '2020-01-01T00:00:00Z';
  assert.ok(near(harnessNow({ FTH_TEST_NOW: far, NODE_ENV: 'test' }, { testClock: false })));
  assert.ok(!near(harnessNow({ FTH_TEST_NOW: far, NODE_ENV: 'test' })));
  // A replay broker's time is still honored.
  assert.strictEqual(harnessNow({ FTH_HOME: homeWith(SIM, 'sim'), FTH_REPLAY_NOW: REPLAY }, { testClock: false }).toISOString(), '2026-03-02T15:30:00.000Z');
});

test('resolveClock: a refused override is the wall clock with the reason; a broker passed in is judged instead of the config', () => {
  const live = resolveClock({ FTH_HOME: tmpDir(), FTH_REPLAY_NOW: REPLAY });
  assert.strictEqual(live.replay, false);
  assert.match(live.refused, /not a replay broker.*Unset FTH_REPLAY_NOW/);
  assert.ok(near(live.now()));
  const given = resolveClock({ FTH_HOME: tmpDir(), FTH_REPLAY_NOW: REPLAY }, { broker: { name: 'sim', command: ['node', 'sim.js'], replay: true, env: [] } });
  assert.strictEqual(given.now().toISOString(), '2026-03-02T15:30:00.000Z');
  assert.deepStrictEqual([resolveClock({}).replay, resolveClock({}).refused], [false, null]);
});

const SIM_BROKER = { name: 'sim', command: ['node', 'sim.js'], replay: true, env: [] };
const reply = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('pinGatewayClock: honors FTH_REPLAY_NOW only when the started broker and its server both say replay, at that time', async () => {
  const env = { FTH_HOME: tmpDir(), FTH_REPLAY_NOW: REPLAY };
  const calls = [];
  const call = server => async (name, args) => { calls.push([name, args]); return server; };
  const ok = await pinGatewayClock(env, { broker: SIM_BROKER, call: call(reply({ replay: true, serverTime: '2026-03-02T15:33:00Z' })) });
  assert.strictEqual(ok.now().toISOString(), '2026-03-02T15:30:00.000Z');
  assert.deepStrictEqual(calls, [['get_server_config', {}]]);
  const refused = async (opts, why) => {
    const c = await pinGatewayClock(env, { broker: SIM_BROKER, ...opts });
    assert.strictEqual(c.replay, false);
    assert.match(c.refused, why);
    assert.ok(near(c.now()), 'the wall clock');
  };
  await refused({ fromArgv: true, broker: null, call: call(reply({ replay: true, serverTime: REPLAY })) }, /server given on its command line/);
  await refused({ call: call(reply({ serverTime: REPLAY })) }, /does not report itself a replay server/);
  await refused({ call: call(reply({ replay: 'true', serverTime: REPLAY })) }, /does not report itself a replay server/);
  await refused({ call: call(reply({ replay: true, serverTime: '2026-03-02T15:36:00Z' })) }, /not within 5 min/);
  await refused({ call: call(reply({ replay: true })) }, /not within 5 min/);
  await refused({ call: call({ content: [{ type: 'text', text: 'boom' }], isError: true }) }, /could not be read \(boom\)/);
  await refused({ call: async () => { throw new Error('get_server_config timed out'); } }, /could not be read \(get_server_config timed out\)/);
  await refused({ call: call({ content: [{ type: 'text', text: 'not json' }] }) }, /could not be read/);
  // Not a replay broker: the server isn't even asked.
  calls.length = 0;
  await refused({ broker: { ...SIM_BROKER, replay: false }, call: call(reply({ replay: true, serverTime: REPLAY })) }, /not a replay broker/);
  assert.deepStrictEqual(calls, []);
  // Unset: the wall clock, no question asked.
  const wall = await pinGatewayClock({}, { broker: SIM_BROKER, call: call(reply({})) });
  assert.deepStrictEqual([wall.replay, wall.refused, calls.length], [false, null, 0]);
});

test('createGatewayClock: pinned once for its lifetime; before that, now() is the wall clock', async () => {
  let asked = 0;
  const clock = createGatewayClock({ FTH_HOME: tmpDir(), FTH_REPLAY_NOW: REPLAY }, { broker: SIM_BROKER, call: async () => { asked += 1; return reply({ replay: true, serverTime: REPLAY }); } });
  assert.ok(near(clock.now()));
  const [a, b] = await Promise.all([clock.ready(), clock.ready()]);
  assert.strictEqual(a, b);
  await clock.ready();
  assert.strictEqual(asked, 1);
  assert.strictEqual(clock.now().toISOString(), '2026-03-02T15:30:00.000Z');
});
