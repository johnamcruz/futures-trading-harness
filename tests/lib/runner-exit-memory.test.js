'use strict';

// The runner keeps managing an open position when its strategy stops loading (trading/exit-memory.js), through
// the real wiring (runner-wiring.js): the last valid exit plan, remembered in <FTH_HOME>/exit-plans.json, trails
// it after a restart. A corrupted remembered plan is dropped with an alert and the broker's stop is left alone,
// and the runner never sends a stop that isn't a price.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { wireRunner } = require('../../scripts/lib/runner-wiring');
const { createRunner } = require('../../scripts/lib/runner');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { tmpDir, rootWithPolicies, shippedPolicy } = require('../helpers');

const DAY = Date.UTC(2026, 9, 7); // Wednesday; New York = UTC-4
const et = (h, m, s = 0) => DAY + ((h + 4) * 60 + m) * 60000 + s * 1000;
const iso = ms => new Date(ms).toISOString();
const START = et(9, 59, 50);
const CFG = () => validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York' });

/** A broker with a long 1 MNQ from 21500 and its stop at 21490 (1R = 10 points); the 3m bars rise to `high`. */
function broker(clock, { high = 21501 } = {}) {
  const modified = [];
  return {
    modified,
    async activeContract() { return { id: 'MNQ', tickSize: 0.25 }; },
    async closedBars(contractId, { minutes, limit }) {
      const step = minutes * 60000;
      const lastOpen = Math.floor((clock.t - 1000) / step) * step - step;
      return Array.from({ length: Math.min(limit, 60) }, (_, k) => {
        const t = lastOpen - (59 - k) * step;
        const up = t >= et(10, 0);
        return { t: iso(t), o: 21500, h: up ? high : 21501, l: 21499, c: up ? high - 1 : 21500, v: 1 };
      });
    },
    async accountState() {
      return { positions: [{ id: 77, contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500, creationTimestamp: iso(et(9, 59, 55)) }], orders: [{ id: 9, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 21490 }] };
    },
    async accountBalance() { return 50000; },
    async fillsSince() { return []; },
    async modifyStop(acct, id, price) { modified.push(price); },
    async closePosition() {},
    async cancelOrder() {},
    async netPosition() { return 1; },
    async workingOrders() { return 1; },
  };
}

/** One wired runner (as autotrader.js wires it) over a home and a plugin root, until 10:08: what it managed and logged. */
async function wired({ root, home, high }) {
  const clock = { t: START };
  const client = broker(clock, { high });
  const managed = [];
  const logs = [];
  const events = [];
  const runner = wireRunner({
    cfg: CFG(), root, home, env: { FTH_HOME: home }, client, dataDir: path.join(home, 'bars'), now: () => new Date(clock.t),
    runCycle: async () => ({ ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x' }),
    loadState: () => null, saveState: () => {}, killSwitchFile: path.join(home, 'STOP'),
    log: (m, l) => logs.push([m, l]), event: e => { events.push(e); if (e.kind === 'position_managed') managed.push(e); },
  });
  while (clock.t < et(10, 8)) clock.t += await runner.step();
  return { managed, logs, events, modified: client.modified };
}

function world() {
  const policy = shippedPolicy();
  const root = rootWithPolicies({});
  // The rest of the plugin linked in as it is (the wiring reads the agents for their timeframes, lanes.js).
  const repo = path.resolve(__dirname, '..', '..');
  for (const e of fs.readdirSync(repo)) if (!['accounts', 'strategies', '.git'].includes(e)) fs.symlinkSync(path.join(repo, e), path.join(root, e));
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'entry-orders.json'), JSON.stringify([{ orderId: 5, contractId: 'MNQ', side: 'buy', setup: policy.name, stopTicks: 40, stopPrice: null, at: iso(et(9, 59, 54)) }]));
  return { policy, root, home, book: path.join(root, 'accounts', policy.account, 'RULEBOOK.md') };
}

test('restart: a position opened under a valid policy keeps its trail after the rulebook refuses the policy and the runner restarts', async () => {
  const { policy, root, home, book } = world();
  const first = await wired({ root, home });
  assert.ok(first.managed.length >= 1, 'managed while valid');
  const kept = JSON.parse(fs.readFileSync(path.join(home, 'exit-plans.json'), 'utf8'))[policy.name];
  assert.deepStrictEqual(kept.exit, policy.exit, 'the exit plan is remembered');
  // The rulebook turns invalid (a cap left out): the policy no longer loads.
  fs.writeFileSync(book, fs.readFileSync(book, 'utf8').replace(/^ {6}cap_usd: .*\n/m, ''));
  // A restarted runner (no state carried over) still trails the open position by the remembered plan.
  const second = await wired({ root, home });
  assert.ok(second.managed.length >= 1, `managed after the restart: ${JSON.stringify(second.logs.filter(([, l]) => l === 'error'))}`);
  assert.ok(!second.logs.some(([m]) => /position not managed/.test(m)));
});

test('restart: a corrupted remembered plan is dropped with an alert and an event naming the position, cleared from the file, and the broker\'s stop is never touched', async () => {
  const { policy, root, home, book } = world();
  await wired({ root, home });
  const file = path.join(home, 'exit-plans.json');
  fs.writeFileSync(book, fs.readFileSync(book, 'utf8').replace(/^ {6}cap_usd: .*\n/m, ''));
  const good = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const giveback of [{}, 'x', -1, null]) {
    const plans = JSON.parse(JSON.stringify(good));
    plans[policy.name].exit = { ...plans[policy.name].exit, trail_giveback_r: giveback };
    fs.writeFileSync(file, JSON.stringify(plans));
    // The bars run to +3R: a valid plan would move the stop; the dropped one leaves it.
    const r = await wired({ root, home, high: 21530 });
    assert.deepStrictEqual(r.modified, [], JSON.stringify(giveback));
    assert.strictEqual(r.managed.length, 0);
    assert.ok(r.logs.some(([m, l]) => l === 'error' && m.includes(file) && /remembered exit plan for .* is invalid \(exit\.trail_giveback_r[^]*loses its trail and its time stop, and the broker's stop stays/.test(m)), JSON.stringify(r.logs.filter(([, l]) => l === 'error')));
    // The event, once, naming the strategy, the position and why; the bad entry is gone from the file.
    const dropped = r.events.filter(e => e.kind === 'exit_plan_dropped');
    assert.strictEqual(dropped.length, 1, JSON.stringify(giveback));
    assert.deepStrictEqual([dropped[0].strategy, dropped[0].symbol, dropped[0].contractId, dropped[0].position, dropped[0].file], [policy.name, 'MNQ', 'MNQ', '77', file]);
    assert.match(dropped[0].reason, /exit\.trail_giveback_r/);
    assert.strictEqual(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), policy.name), false, 'cleared');
  }
});

test('the runner never sends a stop that is not a price: a plan that computes NaN leaves the broker\'s stop and alerts', async () => {
  for (const giveback of ['x', {}, NaN]) {
    const clock = { t: START };
    const client = broker(clock, { high: 21530 });
    const logs = [];
    const events = [];
    const runner = createRunner({
      cfg: CFG(), root: '/r', client, clock: { now: () => new Date(clock.t) }, runCycle: async () => ({ ok: true, timedOut: false }),
      isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {}, writeBars: () => '/b.json', scanFor: () => [],
      entryOrders: () => [{ orderId: 5, contractId: 'MNQ', setup: 'trendy', side: 'buy', stopTicks: 40, at: iso(et(9, 59, 54)) }],
      // Unvalidated on purpose (as a broken source would give it): the send-time guard is the last line.
      exitStrategy: () => ({ name: 'trendy', risk: { stop: 'atr:0.5', min_rr: 2 }, exit: { trail_activate_r: 0.5, trail_giveback_r: giveback } }),
      log: (m, l) => logs.push([m, l]), event: e => events.push(e),
    });
    while (clock.t < et(10, 8)) clock.t += await runner.step();
    assert.ok(client.modified.every(p => typeof p === 'number' && Number.isFinite(p) && p > 0), `${String(giveback)}: ${JSON.stringify(client.modified)}`);
    assert.strictEqual(client.modified.length, 0, String(giveback));
    assert.ok(events.some(e => e.kind === 'stop_not_moved') || logs.some(([m, l]) => l === 'error' && /not a price/.test(m)), `${String(giveback)}: ${JSON.stringify(logs.filter(([, l]) => l === 'error'))}`);
  }
});

test('the runner never sends a stop at or below 0 (futures prices): a trail target of 0 is not sent', async () => {
  // A long from 5 with its stop at -5 (1R 10): the bars run to 30 (+2.5R); a giveback of 3R puts the trail at 0,
  // above the resting stop and below the bar's low, so only the guard's "above 0" keeps it from being sent.
  const clock = { t: START };
  const modified = [];
  const logs = [];
  const client = {
    async activeContract() { return { id: 'MNQ', tickSize: 0.25 }; },
    async closedBars(contractId, { minutes, limit }) {
      const step = minutes * 60000;
      const lastOpen = Math.floor((clock.t - 1000) / step) * step - step;
      return Array.from({ length: Math.min(limit, 60) }, (_, k) => {
        const t = lastOpen - (59 - k) * step;
        const up = t >= et(10, 0);
        return { t: iso(t), o: 5, h: up ? 30 : 6, l: up ? 1 : 4, c: up ? 29 : 5, v: 1 };
      });
    },
    async accountState() {
      return { positions: [{ id: 78, contractId: 'MNQ', type: 1, size: 1, averagePrice: 5, creationTimestamp: iso(et(9, 59, 55)) }], orders: [{ id: 9, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: -5 }] };
    },
    async modifyStop(acct, id, price) { modified.push(price); },
    async closePosition() {},
    async cancelOrder() {},
    async netPosition() { return 1; },
    async workingOrders() { return 1; },
  };
  const runner = createRunner({
    cfg: CFG(), root: '/r', client, clock: { now: () => new Date(clock.t) }, runCycle: async () => ({ ok: true, timedOut: false }),
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {}, writeBars: () => '/b.json', scanFor: () => [],
    entryOrders: () => [{ orderId: 5, contractId: 'MNQ', setup: 'trendy', side: 'buy', stopTicks: 40, at: iso(et(9, 59, 54)) }],
    exitStrategy: () => ({ name: 'trendy', risk: { stop: 'atr:0.5', min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 3 } }),
    log: (m, l) => logs.push([m, l]), event: () => {},
  });
  while (clock.t < et(10, 8)) clock.t += await runner.step();
  assert.deepStrictEqual(modified, [], 'a stop at 0 is never sent');
  assert.ok(logs.some(([m, l]) => l === 'error' && /trail: the new stop for trendy is not a price \(0\)/.test(m)), JSON.stringify(logs.filter(([, l]) => l === 'error')));
});
