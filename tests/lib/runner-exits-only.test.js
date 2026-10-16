'use strict';

// A refused config file (CRITICAL, tunables.js) starts the runner exits-only (runner-wiring.js exitsOnly), through the
// real wiring: no cycle, so no new entry, while housekeeping still closes a position no stop covers and end of day
// still flattens; the critical error goes to the run log (as an error) and the gate log.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { wireRunner, exitsOnly } = require('../../scripts/lib/runner-wiring');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { CriticalConfigError } = require('../../scripts/lib/config-files');
const { tmpDir } = require('../helpers');

const REPO = path.resolve(__dirname, '..', '..');
const DAY = Date.UTC(2026, 9, 7); // Wednesday; New York = UTC-4
const et = (h, m, s = 0) => DAY + ((h + 4) * 60 + m) * 60000 + s * 1000;
const iso = ms => new Date(ms).toISOString();
const CFG = () => validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York' });
const CRITICAL = new CriticalConfigError([{ name: 'runner', file: '/x/config/runner.json', problems: ['gate.maxConsecutiveLosses: a whole number from 1 to Infinity, not "two"'] }], 'Exits still go.');

/** A broker with a long 1 MNQ and no stop working (nothing covers it); it records what the runner closed. */
function broker(clock, orders = []) {
  const closed = [];
  let open = true;
  return {
    closed,
    async activeContract() { return { id: 'MNQ', tickSize: 0.25 }; },
    async closedBars(contractId, { minutes, limit }) {
      const step = minutes * 60000;
      const lastOpen = Math.floor((clock.t - 1000) / step) * step - step;
      return Array.from({ length: Math.min(limit, 60) }, (_, k) => ({ t: iso(lastOpen - (59 - k) * step), o: 21500, h: 21501, l: 21499, c: 21500, v: 1 }));
    },
    async accountState() {
      return { positions: open ? [{ id: 77, contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500, creationTimestamp: iso(et(9, 30)) }] : [], orders: open ? orders : [] };
    },
    async accountBalance() { return 50000; },
    async fillsSince() { return []; },
    async modifyStop() {},
    async closePosition(acct, contractId) { closed.push(contractId); open = false; },
    async cancelOrder() {},
    async netPosition() { return open ? 1 : 0; },
    async workingOrders() { return 0; },
  };
}

async function wired({ configCritical, from = et(9, 59, 50), until = et(10, 8), orders = [] }) {
  const root = REPO;
  const home = tmpDir();
  const clock = { t: from };
  const client = broker(clock, orders);
  const logs = [];
  const events = [];
  let cycles = 0;
  const runner = wireRunner({
    cfg: CFG(), root, home, env: { FTH_HOME: home, FTH_GATE_LOG: path.join(home, 'gate.jsonl') }, client, dataDir: path.join(home, 'bars'), now: () => new Date(clock.t),
    runCycle: async action => { if (action !== 'eod') cycles += 1; return { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x' }; },
    loadState: () => null, saveState: () => {}, killSwitchFile: path.join(home, 'STOP'),
    log: (m, l) => logs.push([m, l]), event: e => events.push(e), configCritical,
  });
  while (clock.t < until) clock.t += await runner.step();
  const gateLog = fs.existsSync(path.join(home, 'gate.jsonl')) ? fs.readFileSync(path.join(home, 'gate.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  return { cycles, closed: client.closed, logs, events, gateLog, home };
}

test('exits-only: a refused config file runs no cycle (no new entry), closes the position no stop covers, and says the critical error in the run log and the gate log', async () => {
  // The positive control: the committed config runs its cycles and leaves the position to them.
  const live = await wired({ configCritical: null });
  assert.ok(live.cycles >= 1, 'cycles run');
  assert.deepStrictEqual(live.closed, [], 'a cycle manages the position: nothing closed by the runner');
  assert.ok(!live.logs.some(([m]) => /CRITICAL config error/.test(m)));
  const off = await wired({ configCritical: CRITICAL });
  assert.strictEqual(off.cycles, 0, 'no cycle: no new entry');
  assert.deepStrictEqual(off.closed, ['MNQ'], 'housekeeping closes what no cycle can protect');
  assert.ok(off.logs.some(([m, l]) => l === 'error' && /^CRITICAL config error .*runner\.json.*exits-only/s.test(m)), JSON.stringify(off.logs.slice(0, 3)));
  assert.ok(off.gateLog.some(e => e.source === 'runner' && e.decision === 'config-critical' && /gate\.maxConsecutiveLosses/.test(e.message)));
  assert.ok(!fs.existsSync(path.join(off.home, 'STOP')), 'the kill switch file is not written: fixing the config is enough');
});

test('exits-only control: a position whose stop covers its full size is NOT closed (only an uncovered one is)', async () => {
  const stop = { id: 88, contractId: 'MNQ', accountId: 7, side: 1, type: 4, size: 1, stopPrice: 21480, status: 1 };
  const covered = await wired({ configCritical: CRITICAL, orders: [stop] });
  assert.strictEqual(covered.cycles, 0, 'still exits-only: no cycle');
  assert.deepStrictEqual(covered.closed, [], 'the covering stop holds: nothing closed');
  const uncovered = await wired({ configCritical: CRITICAL });
  assert.deepStrictEqual(uncovered.closed, ['MNQ'], 'the same run with no stop closes it');
});

test('exits-only: end of day still flattens on a refused config file', async () => {
  const eod = await wired({ configCritical: CRITICAL, from: et(15, 50, 5), until: et(15, 53) });
  assert.strictEqual(eod.cycles, 0);
  assert.ok(eod.closed.includes('MNQ'));
  assert.ok(eod.events.some(e => e.kind === 'flatten' && e.contractId === 'MNQ'), JSON.stringify(eod.events.map(e => e.kind)));
});

test('exitsOnly reads the loaded config files: none refused, false; a refused one (a copied tree), true and logged', () => {
  const logs = [];
  assert.strictEqual(exitsOnly({}, (m, l) => logs.push([m, l])), false);
  assert.deepStrictEqual(logs, []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-exits-only-'));
  fs.cpSync(path.join(REPO, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'config'), path.join(root, 'config'), { recursive: true });
  for (const d of ['strategies', 'accounts', 'skills', 'agents']) fs.symlinkSync(path.join(REPO, d), path.join(root, d));
  fs.rmSync(path.join(root, 'config', 'analysis.json'));
  const code = `const out = []; const r = require(${JSON.stringify(path.join(root, 'scripts', 'lib', 'runner-wiring.js'))}).exitsOnly({ FTH_GATE_LOG: ${JSON.stringify(path.join(root, 'gate.jsonl'))} }, (m, l) => out.push([m, l])); process.stdout.write(JSON.stringify({ r, out }));`;
  const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  const { r, out } = JSON.parse(res.stdout);
  assert.strictEqual(r, true);
  assert.match(out[0][0], /the analysis config .* is refused: it can't be read \(ENOENT\)/);
  assert.strictEqual(out[0][1], 'error');
});
