'use strict';

// End to end: the runner loop against a fake ProjectX REST server and a fake
// harness. A freshly closed bar must start exactly one cycle whose prompt names
// the bar and the data file the runner wrote.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

function fakeProjectX() {
  const calls = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls.push(req.url);
      const send = obj => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/Auth/loginKey') return send({ success: true, token: 't' });
      if (req.url === '/api/Contract/search') return send({ success: true, contracts: [{ id: 'CON.F.US.MNQ.Z26', activeContract: true }] });
      if (req.url === '/api/History/retrieveBars') {
        // The newest 1-minute bar closed 5 seconds ago.
        const lastOpen = Date.now() - 65000;
        const bars = [2, 1, 0].map(k => ({ t: new Date(lastOpen - k * 60000).toISOString(), o: 1, h: 2, l: 0, c: 1 + k, v: 10 }));
        return send({ success: true, bars });
      }
      res.statusCode = 404;
      return res.end('{}');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('runner starts a cycle on a fresh closed bar and hands the agent the bar file', { timeout: 30000 }, async () => {
  const { server, calls, url } = await fakeProjectX();
  const home = tmpDir();
  const dataDir = path.join(home, 'fth');
  const config = path.join(home, 'auto.json');
  fs.writeFileSync(config, JSON.stringify({
    harness: 'custom',
    command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), '{prompt}'],
    timeframe: 1,
    dataDir,
    sessions: ['00:00-24:00@UTC'],
    premarketAt: '',
    eodAt: '',
    weekdaysOnly: false,
    barDelaySeconds: 0,
  }));
  const runner = spawn(process.execPath, [path.join(ROOT, 'scripts', 'autotrader.js'), '--config', config], {
    env: { PATH: process.env.PATH, HOME: home, PROJECTX_USERNAME: 'u', PROJECTX_API_KEY: 'k', PROJECTX_API_URL: url, FTH_KILL_SWITCH_FILE: path.join(home, 'STOP') },
  });
  let out = '';
  runner.stdout.on('data', c => { out += c; });
  runner.stderr.on('data', c => { out += c; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no cycle within 20s:\n${out}`)), 20000);
      const check = setInterval(() => {
        if (out.includes('CYCLE RESULT')) { clearTimeout(timer); clearInterval(check); resolve(); }
      }, 100);
    });
  } finally {
    runner.kill('SIGTERM');
    await new Promise(r => runner.on('close', r));
    server.close();
  }
  assert.match(out, /MNQ -> CON\.F\.US\.MNQ\.Z26/);
  assert.match(out, /CYCLE RESULT: no-trade - fake harness/);
  const file = path.join(dataDir, 'MNQ-1m.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(data.contractId, 'CON.F.US.MNQ.Z26');
  assert.strictEqual(data.bars.length, 3);
  const logs = fs.readdirSync(path.join(home, '.futures-trading-harness', 'logs'));
  const log = fs.readFileSync(path.join(home, '.futures-trading-harness', 'logs', logs[0]), 'utf8');
  assert.match(log, /A 1-minute MNQ bar just closed/);
  assert.ok(log.includes(file));
  assert.ok(calls.includes('/api/History/retrieveBars'));
  assert.ok(!fs.existsSync(path.join(home, '.futures-trading-harness', 'autotrader.lock')), 'lock released on exit');
  const state = JSON.parse(fs.readFileSync(path.join(home, '.futures-trading-harness', 'autotrader-state.json'), 'utf8'));
  assert.strictEqual(state.cycles, 1);
});
