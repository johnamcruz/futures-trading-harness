'use strict';

// End to end: the runner loop against a fake broker MCP server and a fake
// harness. A freshly closed bar must start exactly one cycle whose prompt names
// the bar and the data file the runner wrote.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir } = require('../helpers');
const { inMarketHours, zonedParts } = require('../../scripts/lib/trading/clock');

const ROOT = path.resolve(__dirname, '..', '..');

// The broker: a fake MCP server that implements the broker MCP interface, started by the gateway.
const FAKE_BROKER = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');

function runAutotrader(config, home, calls = path.join(home, 'calls.txt'), extraEnv = {}) {
  const runner = spawn(process.execPath, [path.join(ROOT, 'scripts', 'autotrader.js'), '--config', config], {
    env: {
      PATH: process.env.PATH, HOME: home, FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'),
      PROJECTX_MCP_ENTRY: FAKE_BROKER, FAKE_LIVE_BARS: '1', FAKE_FLAT: '1', FAKE_CALLS: calls, ...extraEnv,
    },
  });
  const done = new Promise(r => runner.on('close', r));
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

test('a live runner refuses to start when the broker server would refuse its housekeeping', { timeout: 30000 }, async () => {
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
  const a = runAutotrader(other.config, other.home);
  assert.strictEqual(await a.done, 1);
  assert.match(a.io.out, /broker: can't start \(account 8 is not among the server's allowed accounts \(7\)\)/);
  const off = live(7);
  const b = runAutotrader(off.config, off.home, undefined, { FAKE_TRADING_OFF: '1' });
  assert.strictEqual(await b.done, 1);
  assert.match(b.io.out, /broker: can't start \(the broker MCP server has trading disabled/);
});

// The runner runs on the real clock: during market hours a fresh bar starts a
// cycle; outside them it must stay idle.
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
      if (closed) assert.ok(!io.out.includes('CYCLE RESULT'), 'no cycle outside market hours');
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
});

// A copy of the harness whose harness tools server is a foreign MCP server (the fake broker).
function foreignToolsRoot() {
  const root = tmpDir();
  for (const d of ['scripts', 'strategies', 'accounts', 'mcp-configs', 'agents', 'skills', 'models', 'workspace']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
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
    harness: 'custom', command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), '{prompt}'], timeframe: 1,
    sessions: ['18:00-15:50@America/New_York'], premarketAt: '', eodAt: '15:50@America/New_York', weekdaysOnly: false,
  }));
  const killSwitch = path.join(home, 'STOP');
  const state = path.join(home, '.futures-trading-harness');
  const start = () => {
    const runner = spawn(process.execPath, [path.join(root, 'scripts', 'autotrader.js'), '--config', config], {
      env: { PATH: process.env.PATH, HOME: home, FTH_KILL_SWITCH_FILE: killSwitch, PROJECTX_MCP_ENTRY: FAKE_BROKER, FAKE_LIVE_BARS: '1', FAKE_FLAT: '1' },
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
