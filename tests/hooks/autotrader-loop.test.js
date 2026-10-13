'use strict';

// End to end: the runner loop against a fake broker MCP server and a fake
// harness. A freshly closed bar must start exactly one cycle whose prompt names
// the bar and the data file the runner wrote.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { FAKE_BROKERS, tmpDir } = require('../helpers');
const { inMarketHours, zonedParts } = require('../../scripts/lib/trading/clock');

const ROOT = path.resolve(__dirname, '..', '..');

// The broker: a fake MCP server that implements the broker MCP interface, started by the gateway.
const FAKE_BROKER = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');

// A runner that should have refused to start but didn't would run on: it is killed after `limitMs`, so the test
// fails (exit code null) instead of hanging.
function runAutotrader(config, home, calls = path.join(home, 'calls.txt'), extraEnv = {}, limitMs = 25000) {
  const runner = spawn(process.execPath, [path.join(ROOT, 'scripts', 'autotrader.js'), '--config', config], {
    env: {
      PATH: process.env.PATH, HOME: home, FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'),
      FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_ENTRY: FAKE_BROKER, FAKE_LIVE_BARS: '1', FAKE_FLAT: '1', FAKE_CALLS: calls,
      FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '7,8', ...extraEnv,
    },
  });
  const limit = setTimeout(() => runner.kill('SIGKILL'), limitMs);
  const done = new Promise(r => runner.on('close', code => { clearTimeout(limit); r(code); }));
  const io = { out: '' };
  runner.stdout.on('data', c => { io.out += c; });
  runner.stderr.on('data', c => { io.out += c; });
  return { runner, done, io };
}

test('a runner config that trades outside market hours is refused', { timeout: 30000 }, async () => {
  const home = tmpDir();
  const config = path.join(home, 'auto.json');
  fs.writeFileSync(config, JSON.stringify({ harness: 'custom', command: ['true'], sessions: ['00:00-24:00@UTC'], eodAt: '', premarketAt: '' }));
  const { done, io } = runAutotrader(config, home);
  const code = await done;
  assert.notStrictEqual(code, 0);
  assert.match(io.out, /market hours|eodAt: required/);
});

test('a live runner refuses to start when the broker server would refuse its housekeeping', { timeout: 60000 }, async () => {
  const live = account => {
    const home = tmpDir();
    const config = path.join(home, 'auto.json');
    fs.writeFileSync(config, JSON.stringify({
      harness: 'custom', command: ['true', '{prompt}'], account, timeframe: 1, sessions: ['18:00-15:50@America/New_York'],
      premarketAt: '', eodAt: '15:50@America/New_York', weekdaysOnly: false,
    }));
    return { config, home };
  };
  const other = live(8);
  const a = runAutotrader(other.config, other.home, undefined, {}, 10000);
  assert.strictEqual(await a.done, 1);
  assert.match(a.io.out, /broker: can't start \(account 8 is not among the server's allowed accounts \(7\)\)/);
  const off = live(7);
  const b = runAutotrader(off.config, off.home, undefined, { FAKE_TRADING_OFF: '1' }, 10000);
  assert.strictEqual(await b.done, 1);
  assert.match(b.io.out, /broker: can't start \(the broker MCP server has trading disabled/);
  // The broker's allow-list (allowedAccountsEnv) empty or without the account: a live run never starts.
  for (const [list, why] of [['', /FAKE_BROKER_ALLOWED_ACCOUNT_IDS is empty/], ['8', /account 7 is not in FAKE_BROKER_ALLOWED_ACCOUNT_IDS \(8\)/]]) {
    const run = live(7);
    const c = runAutotrader(run.config, run.home, undefined, { FAKE_BROKER_ALLOWED_ACCOUNT_IDS: list }, 10000);
    assert.strictEqual(await c.done, 1);
    assert.match(c.io.out, why);
  }
});

/** The actions of every cycle the runner started (its event log, <harness home>/logs/events-<day>.jsonl). */
function cycleActions(harnessHome) {
  const dir = path.join(harnessHome, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^events-.*\.jsonl$/.test(f)).sort()
    .flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)))
    .filter(e => e.kind === 'cycle_start').map(e => e.action);
}

// One pass of the runner at a pinned instant: the replay clock (FTH_REPLAY_NOW with a replay broker, the mock
// exchange attesting it), the clock the runner already takes; the live loop itself has no injectable clock.
const MOCK_EXCHANGE = path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js');
function passAt(at) {
  const home = tmpDir();
  const brokers = path.join(home, 'brokers.json');
  fs.writeFileSync(brokers, JSON.stringify({ broker: 'replaymock', brokers: { replaymock: { command: [process.execPath, MOCK_EXCHANGE], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_STATE_DIR', 'MOCK_JOURNAL', 'MOCK_CLOCK_FILE', 'MOCK_REPLAY', 'MOCK_INIT'] } } }));
  fs.mkdirSync(path.join(home, 'state'));
  fs.writeFileSync(path.join(home, 'clock.json'), JSON.stringify({ now: at }));
  const config = path.join(home, 'auto.json');
  fs.writeFileSync(config, JSON.stringify({
    harness: 'custom', command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3,
    sessions: ['18:00-15:50@America/New_York'], premarketAt: '', eodAt: '15:50@America/New_York', dataDir: path.join(home, 'bars'),
  }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'autotrader.js'), '--config', config, '--once', 'trade'], {
    encoding: 'utf8', timeout: 60000,
    env: {
      PATH: process.env.PATH, HOME: home, FTH_HOME: home, FTH_BROKERS_FILE: brokers, FTH_REPLAY_NOW: at,
      MOCK_REPLAY: '1', MOCK_STATE_DIR: path.join(home, 'state'), MOCK_CLOCK_FILE: path.join(home, 'clock.json'), MOCK_JOURNAL: path.join(home, 'journal.jsonl'), MOCK_INIT: '{}',
    },
  });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const line = r.stdout.split('\n').find(l => l.startsWith('REPLAY STEP '));
  assert.ok(line, r.stdout);
  return { home, step: JSON.parse(line.slice('REPLAY STEP '.length)) };
}

test('runner at pinned instants: a trade cycle in market hours, only the end-of-day job after eodAt, nothing with the market closed', { timeout: 120000 }, () => {
  // Wednesday 2026-10-07 (New York = UTC-4): 10:03 ET, 15:53 ET (after the 15:50 eodAt), 16:30 ET (the daily break); Saturday noon.
  const open = passAt('2026-10-07T14:03:02Z');
  assert.deepStrictEqual(open.step.ran.map(x => [x.action, x.ok, x.result]), [['trade', true, 'CYCLE RESULT: no-trade - fake harness']]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(open.home, 'bars', 'MNQ-3m.json'), 'utf8')).contractId, 'MNQ');
  assert.deepStrictEqual(cycleActions(open.home), ['trade']);
  const afterEod = passAt('2026-10-07T19:53:02Z');
  assert.deepStrictEqual(afterEod.step.ran.map(x => x.action), ['eod'], 'after eodAt: the end-of-day job, never a trade cycle');
  assert.deepStrictEqual(cycleActions(afterEod.home), ['eod']);
  for (const at of ['2026-10-07T20:30:00Z', '2026-10-10T16:00:00Z']) {
    const closed = passAt(at);
    assert.deepStrictEqual(closed.step.ran, [], `${at}: the market is closed, nothing runs`);
    assert.deepStrictEqual(cycleActions(closed.home), [], at);
  }
});

// The live loop runs on the real clock (it has no injectable clock): during market hours a fresh bar starts a
// cycle; outside them it must stay up and start no trade cycle. The pinned instants are the test above.
test('runner starts a cycle on a fresh closed bar during market hours, and none outside them', { timeout: 30000 }, async () => {
  // Open = market hours, and before this config's 15:50 ET end of day (its session is the whole market session).
  const etMin = d => { const p = zonedParts(d, 'America/New_York'); return p.hour * 60 + p.minute; };
  const beforeEod = (d, endMin) => { const m = etMin(d); return m >= 18 * 60 || m < endMin; };
  const span = [new Date(), new Date(Date.now() + 25000)];
  // Open: a cycle must run (a minute of margin before 15:50). Closed: none may (past 15:50 or the market shut).
  // In between (15:49-15:50, or a market open/close inside the window) only the runner staying up is checked.
  const open = span.every(d => inMarketHours(d) && beforeEod(d, 15 * 60 + 49));
  const closed = span.every(d => !inMarketHours(d) || !beforeEod(d, 15 * 60 + 50));
  const home = tmpDir();
  const callsFile = path.join(home, 'calls.txt');
  const dataDir = path.join(home, 'fth');
  const config = path.join(home, 'auto.json');
  fs.writeFileSync(config, JSON.stringify({
    harness: 'custom',
    command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), '{prompt}'],
    timeframe: 1,
    account: '7', // a live run names its account, on the broker's allow-list
    dataDir,
    sessions: ['18:00-15:50@America/New_York'],
    premarketAt: '',
    eodAt: '15:50@America/New_York',
    weekdaysOnly: false,
    barDelaySeconds: 0,
  }));
  const { runner, done, io } = runAutotrader(config, home, callsFile);
  try {
    if (!open) {
      await new Promise(r => setTimeout(r, 5000));
      assert.ok(runner.exitCode === null, `the runner keeps running:\n${io.out}`);
      // Past eodAt the end-of-day job runs (and prints its CYCLE RESULT): judged by the action, never a trade cycle.
      // The instants are pinned in the replay-clock test above; this live-loop test only checks what holds at any time.
      if (closed) assert.deepStrictEqual(cycleActions(path.join(home, '.futures-trading-harness')).filter(a => a !== 'eod'), [], 'no trade cycle outside market hours or after eodAt');
      return;
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no cycle within 20s:\n${io.out}`)), 20000);
      const check = setInterval(() => {
        if (io.out.includes('CYCLE RESULT')) { clearTimeout(timer); clearInterval(check); resolve(); }
        else if (runner.exitCode !== null) { clearTimeout(timer); clearInterval(check); reject(new Error(`runner exited:\n${io.out}`)); }
      }, 100);
    });
  } finally {
    if (runner.exitCode === null) runner.kill('SIGTERM');
    await done;
  }
  const out = io.out;
  assert.match(out, /MNQ: active contract MNQ/);
  assert.match(out, /CYCLE RESULT: no-trade - fake harness/);
  const file = path.join(dataDir, 'MNQ-1m.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(data.contractId, 'MNQ');
  assert.strictEqual(data.bars.length, 3);
  const logs = fs.readdirSync(path.join(home, '.futures-trading-harness', 'logs'));
  const log = fs.readFileSync(path.join(home, '.futures-trading-harness', 'logs', logs.find(f => /^autotrader-.*\.log$/.test(f))), 'utf8');
  assert.match(log, /MNQ: a 1-minute bar just closed/);
  assert.ok(log.includes(file));
  // Everything through the broker's MCP server (the broker MCP interface).
  const calls = fs.readFileSync(callsFile, 'utf8').split('\n');
  assert.ok(calls.includes('search_contracts') && calls.includes('get_bars'), calls.join(', '));
  assert.ok(!fs.existsSync(path.join(home, '.futures-trading-harness', 'autotrader.lock')), 'lock released on exit');
  const state = JSON.parse(fs.readFileSync(path.join(home, '.futures-trading-harness', 'autotrader-state.json'), 'utf8'));
  assert.strictEqual(state.cycles, 1);
  // The live loop recorded the pass as a replay records a decision time (session/live.js): the bar's cycle on a trade line.
  const sessions = path.join(home, '.futures-trading-harness', 'sessions', state.day);
  const recs = fs.readFileSync(path.join(sessions, `${state.day}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(recs.some(r => r.kind === 'trade' && r.ran.some(x => x.action === 'trade') && r.cycles.length === 1), JSON.stringify(recs).slice(0, 400));
  const manifest = JSON.parse(fs.readFileSync(path.join(sessions, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual([manifest.source, manifest.runId], ['live', state.day]);
});

// A copy of the harness whose harness tools server is a foreign MCP server (the fake broker).
function foreignToolsRoot() {
  const root = tmpDir();
  for (const d of ['scripts', 'strategies', 'accounts', 'mcp-configs', 'agents', 'skills', 'workspace']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  fs.writeFileSync(path.join(root, 'scripts', 'harness-tools-mcp.js'), `require(${JSON.stringify(FAKE_BROKER)});\n`);
  return root;
}

const waitFor = (what, ms, cond) => new Promise((resolve, reject) => {
  let check = null;
  const timer = setTimeout(() => { clearInterval(check); reject(new Error(`${what}: not within ${ms} ms`)); }, ms);
  check = setInterval(() => { if (cond()) { clearTimeout(timer); clearInterval(check); resolve(); } }, 100);
});

test('live loop: a harness tools server that fails the start check turns trading off after the lock is taken, and the loop runs on', { timeout: 60000 }, async () => {
  const root = foreignToolsRoot();
  const home = tmpDir();
  const config = path.join(home, 'auto.json');
  fs.writeFileSync(config, JSON.stringify({
    harness: 'custom', command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), '{prompt}'], timeframe: 1, account: '7',
    sessions: ['18:00-15:50@America/New_York'], premarketAt: '', eodAt: '15:50@America/New_York', weekdaysOnly: false,
  }));
  const killSwitch = path.join(home, 'STOP');
  const state = path.join(home, '.futures-trading-harness');
  const start = () => {
    const runner = spawn(process.execPath, [path.join(root, 'scripts', 'autotrader.js'), '--config', config], {
      env: { PATH: process.env.PATH, HOME: home, FTH_KILL_SWITCH_FILE: killSwitch, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_ENTRY: FAKE_BROKER, FAKE_LIVE_BARS: '1', FAKE_FLAT: '1', FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '7' },
    });
    const io = { out: '' };
    runner.stdout.on('data', c => { io.out += c; });
    runner.stderr.on('data', c => { io.out += c; });
    return { runner, io, done: new Promise(r => runner.on('close', r)) };
  };
  const first = start();
  try {
    await waitFor('the kill switch', 30000, () => fs.existsSync(killSwitch) || first.runner.exitCode !== null);
    assert.strictEqual(first.runner.exitCode, null, `the runner keeps running:\n${first.io.out}`);
    const reason = fs.readFileSync(killSwitch, 'utf8');
    assert.match(reason, /^the harness tools server \(.*harness-tools-mcp\.js\) does not offer the harness's tools .*Fix it, then remove this file to resume trading\.\n$/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(state, 'autotrader.lock'), 'utf8')).pid, first.runner.pid, 'the lock is the running loop\'s');
    // It keeps running: its heartbeat (end of day and housekeeping run from the same loop).
    await waitFor('a heartbeat', 20000, () => fs.existsSync(path.join(state, 'autotrader-heartbeat.json')));
    assert.match(first.io.out, /trading is off \(kill switch .*\); end of day and housekeeping still run/);
    // A second start while the lock is held stops at the lock: the kill switch is left alone.
    const second = start();
    assert.strictEqual(await second.done, 1);
    assert.match(second.io.out, /another autotrader is running/);
    assert.strictEqual(fs.readFileSync(killSwitch, 'utf8'), reason, 'no second reason appended');
    assert.strictEqual(first.runner.exitCode, null);
  } finally {
    if (first.runner.exitCode === null) first.runner.kill('SIGTERM');
    await first.done;
  }
});
