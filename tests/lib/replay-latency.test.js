'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../../scripts/lib/replay/latency');
const { resolveReplay, configHash, setupHash } = require('../../scripts/lib/replay/config');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const at = iso => new Date(iso);
const point = (iso, kind = 'trade') => ({ t: at(iso), kind, day: '2026-10-07' });

test('latencySetting: on by default for a learning run, off for one declared not learning; a boolean overrides; anything else refused', () => {
  assert.deepStrictEqual(L.latencySetting(undefined, true), { value: true, error: null });
  assert.deepStrictEqual(L.latencySetting(undefined, false), { value: false, error: null });
  assert.deepStrictEqual(L.latencySetting(false, true), { value: false, error: null });
  assert.deepStrictEqual(L.latencySetting(true, false), { value: true, error: null });
  for (const bad of ['true', 1, null, {}]) assert.match(L.latencySetting(bad, true).error, /latency: true or false/, String(bad));
});

test('runAt and skippedForLatency: a passed time runs at the clock; a trade time is skipped only when its next time has passed too', () => {
  const p = point('2026-10-07T19:45:02Z');
  assert.strictEqual(L.runAt(p, null), p.t.getTime(), 'no clock (pinned): its own time');
  assert.strictEqual(L.runAt(p, Date.parse('2026-10-07T19:44:00Z')), p.t.getTime(), 'the clock before it: its own time');
  assert.strictEqual(L.runAt(p, Date.parse('2026-10-07T19:46:30Z')), Date.parse('2026-10-07T19:46:30Z'), 'passed: the clock');
  const next = point('2026-10-07T19:48:02Z');
  assert.strictEqual(L.skippedForLatency(p, next, Date.parse('2026-10-07T19:48:01Z')), false, 'the next not reached');
  assert.strictEqual(L.skippedForLatency(p, next, Date.parse('2026-10-07T19:48:02Z')), true, 'the next reached');
  assert.strictEqual(L.skippedForLatency(p, undefined, Date.parse('2026-10-07T20:00:00Z')), false, 'the last time always runs');
  assert.strictEqual(L.skippedForLatency(point('2026-10-07T19:45:02Z', 'eod'), next, Date.parse('2026-10-07T20:00:00Z')), false, 'end of day never');
  assert.strictEqual(L.skippedForLatency(point('2026-10-07T19:45:02Z', 'premarket'), next, Date.parse('2026-10-07T20:00:00Z')), false, 'premarket never');
  assert.strictEqual(L.skippedForLatency(p, next, null), false, 'pinned: never');
});

test('readClockMs: the clock file\'s time, null when missing or unreadable', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'clock.json');
  assert.strictEqual(L.readClockMs(f), null);
  fs.writeFileSync(f, '{"now":"2026-10-07T19:49:02.000Z"}');
  assert.strictEqual(L.readClockMs(f), Date.parse('2026-10-07T19:49:02Z'));
  for (const bad of ['{', '{"now":"x"}', '[]']) {
    fs.writeFileSync(f, bad);
    assert.strictEqual(L.readClockMs(f), null, bad);
  }
});

test('startTicker: writes the decision time plus the wall time since the step began, now and on each tick; stop writes the last and returns it', () => {
  let wall = 1000;
  const writes = [];
  let tick = null;
  const timers = { setInterval: (fn, ms) => { tick = fn; assert.strictEqual(ms, L.TICK_MS); return 'id'; }, clearInterval: id => { assert.strictEqual(id, 'id'); tick = null; } };
  const atMs = Date.parse('2026-10-07T19:42:02Z');
  const t = L.startTicker({ write: d => writes.push(d.toISOString()), atMs, startedMs: 1000, wall: () => wall, timers });
  wall = 61000;
  tick();
  wall = 241000;
  assert.strictEqual(t.stop(), atMs + 240000);
  assert.strictEqual(tick, null, 'cleared');
  assert.deepStrictEqual(writes, ['2026-10-07T19:42:02.000Z', '2026-10-07T19:43:02.000Z', '2026-10-07T19:46:02.000Z']);
  // A wall clock behind the start never moves the clock back; a failed write never stops the step.
  const back = L.startTicker({ write: () => { throw new Error('disk'); }, atMs, startedMs: 5000, wall: () => 1000, timers });
  assert.strictEqual(back.stop(), atMs);
});

test('replay config: latency on by default for a learning run; named in the run\'s hashes only when on', () => {
  const dir = tmpDir();
  const base = {
    runId: 'r1', workDir: path.join(dir, 'replays'), broker: 'sim', start: '2026-10-07T13:31:00Z', end: '2026-10-07T13:40:00Z',
    autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York' },
  };
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL' } } }));
  const env = { PATH: process.env.PATH, FTH_HOME: live, FTH_BROKERS_FILE: path.join(live, 'brokers.json') };
  const run = over => resolveReplay({ ...base, ...over }, { env, home: dir, root: ROOT });
  assert.strictEqual(run({}).latency, true, 'a learning run (the default)');
  assert.strictEqual(run({ learning: false }).latency, false);
  assert.strictEqual(run({ latency: false }).latency, false);
  assert.strictEqual(run({ learning: false, latency: true }).latency, true);
  assert.throws(() => run({ latency: 'yes' }), /latency: true or false/);
  // A pinned run hashes as it did before the setting existed (the field absent); a charged one differs, in both hashes.
  const pinned = run({ latency: false });
  require('../../scripts/lib/replay/driver').seedRunHome(pinned, { root: ROOT, userEnv: env });
  const { latency: _l, ...without } = pinned;
  assert.strictEqual(configHash(pinned, env), configHash(without, env));
  assert.strictEqual(setupHash(pinned), setupHash(without));
  assert.notStrictEqual(configHash(run({}), env), configHash(pinned, env));
  assert.notStrictEqual(setupHash(run({})), setupHash(pinned));
});
