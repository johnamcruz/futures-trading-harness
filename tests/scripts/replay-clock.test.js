'use strict';

// The scripts agents run take "now" from the harness clock (trading/harness-now.js):
// a replay broker's FTH_REPLAY_NOW, else the wall clock; with the override and a
// live broker (or an unparseable value) they exit with an error.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const CSV = path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv');
const REPLAY = '2026-04-28T04:15:30Z';

/** A harness home whose broker ("sim") is a replay broker, or not. */
function home({ replay = true } = {}) {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'sim.js'], ...(replay ? { replay: true } : {}) } } }));
  return dir;
}
const node = (script, args, env) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, FTH_AUTONOMOUS: '', ...env },
});

test('strategies.js scan: without --now it scans at the replayed time (sessions, the signal record)', () => {
  const sim = home();
  const replayed = node('strategies.js', ['scan', CSV, '--symbol', 'MNQ', '--record'], { FTH_HOME: sim, FTH_REPLAY_NOW: REPLAY });
  assert.strictEqual(replayed.status, 0, replayed.stderr);
  const rec = JSON.parse(fs.readFileSync(path.join(sim, 'signals', 'MNQ-3m.json'), 'utf8'));
  assert.strictEqual(rec.recordedAt, '2026-04-28T04:15:30.000Z');
  // The same scan as --now at that time: every strategy's session and verdict.
  const explicit = node('strategies.js', ['scan', CSV, '--symbol', 'MNQ', '--now', REPLAY], { FTH_HOME: home({ replay: false }) });
  assert.strictEqual(explicit.status, 0, explicit.stderr);
  assert.deepStrictEqual(JSON.parse(replayed.stdout), JSON.parse(explicit.stdout));
});

test('scripts refuse FTH_REPLAY_NOW with a live broker or an unparseable value (exit 1, nothing written)', () => {
  const live = home({ replay: false });
  const sim = home();
  for (const [script, args] of [
    ['strategies.js', ['scan', CSV, '--symbol', 'MNQ', '--record']],
    ['strategies.js', ['scan', CSV, '--symbol', 'MNQ', '--now', REPLAY]],
    ['blackouts.js', ['add', '--start', '2026-04-28T12:20:00Z', '--end', '2026-04-28T12:40:00Z', '--reason', 'CPI']],
    ['combine.js', ['start', '--account', 'topstep_50k']],
    ['mtf.js', [CSV, '--record', '--symbol=MNQ']],
  ]) {
    for (const [dir, value, why] of [[live, REPLAY, /"sim" is not a replay broker/], [sim, 'tomorrow', /not an ISO 8601 UTC time/]]) {
      const r = node(script, args, { FTH_HOME: dir, FTH_REPLAY_NOW: value, FTH_BLACKOUTS_FILE: path.join(dir, 'blackouts.json') });
      assert.strictEqual(r.status, 1, `${script} ${value}: ${r.stderr}`);
      assert.match(r.stderr, why, script);
    }
  }
  for (const dir of [live, sim]) {
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['brokers.json'], 'no signal, blackout, combine or trend record written');
  }
});

test('blackouts.js, combine.js and mtf.js --record take the replayed time', () => {
  const sim = home();
  const env = { FTH_HOME: sim, FTH_REPLAY_NOW: REPLAY, FTH_BLACKOUTS_FILE: path.join(sim, 'blackouts.json') };
  // A window later on the replayed day is still ahead (the wall clock would call it ended).
  const add = node('blackouts.js', ['add', '--start', '2026-04-28T12:20:00Z', '--end', '2026-04-28T12:40:00Z', '--reason', 'CPI'], env);
  assert.strictEqual(add.status, 0, add.stderr);
  const start = node('combine.js', ['start', '--account', 'topstep_50k'], env);
  assert.strictEqual(start.status, 0, start.stderr);
  const attempt = JSON.parse(fs.readFileSync(path.join(sim, 'combine', 'topstep_50k.json'), 'utf8'));
  assert.deepStrictEqual([attempt.startedAt, attempt.startDay], ['2026-04-28T04:15:30.000Z', '2026-04-28']);
  const mtf = node('mtf.js', [CSV, '--record', '--symbol=MNQ'], env);
  assert.strictEqual(mtf.status, 0, mtf.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sim, 'mtf', 'MNQ.json'), 'utf8')).recordedAt, '2026-04-28T04:15:30.000Z');
});

test('bars.js: fetches bars up to the replayed time and records the trend read at it', () => {
  const dir = tmpDir();
  const FAKE = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
  fs.writeFileSync(path.join(dir, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, FAKE], replay: true } } }));
  const out = path.join(dir, 'MNQ-1m.json');
  const run = extra => node('bars.js', ['--symbol', 'MNQ', '--timeframe', '1', '--count', '10', '--out', out, '--record'], { FTH_HOME: dir, ...extra });
  // The fake serves 1-minute bars from 13:00 to 13:09 and never one after the request's endTime.
  const replayed = run({ FTH_REPLAY_NOW: '2026-10-07T13:05:30Z' });
  assert.strictEqual(replayed.status, 0, replayed.stderr);
  assert.match(replayed.stdout, /wrote 6 1-minute bars .*last bar 2026-10-07T13:05:00.000Z/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'mtf', 'MNQ.json'), 'utf8')).recordedAt, '2026-10-07T13:05:30.000Z');
  const wall = run({});
  assert.strictEqual(wall.status, 0, wall.stderr);
  assert.match(wall.stdout, /wrote 10 1-minute bars .*last bar 2026-10-07T13:09:00.000Z/);
  // Refused with a live broker: exits before asking the broker for anything.
  const live = node('bars.js', ['--symbol', 'MNQ', '--count', '10', '--out', out], { FTH_HOME: tmpDir(), FTH_REPLAY_NOW: '2026-10-07T13:05:30Z' });
  assert.strictEqual(live.status, 1);
  assert.match(live.stderr, /not a replay broker/);
});
