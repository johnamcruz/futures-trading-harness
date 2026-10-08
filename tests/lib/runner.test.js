'use strict';

// Long-run simulations of the autonomous runner core (scripts/lib/runner.js)
// under a simulated clock and a fake market, to show it runs exactly one cycle
// per closed bar, consistently, across a whole session.
const test = require('node:test');
const assert = require('node:assert');
const { createRunner } = require('../../scripts/lib/runner');
const { validateConfig } = require('../../scripts/lib/autotrader');

const DAY = Date.UTC(2026, 9, 7); // Wednesday; New York = UTC-4
const et = (h, m, s = 0) => DAY + ((h + 4) * 60 + m) * 60000 + s * 1000;

/**
 * Fake market: bars aligned to the timeframe, published `publishMs` after the
 * close; optional outages (no bars) and a contract roll at `rollAt`.
 */
function fakeMarket({ minutes, publishMs = 1000, outage = null, rollAt = null }) {
  let requests = 0;
  const contractAt = t => (rollAt && t >= rollAt ? 'CON.F.US.X.H27' : 'CON.F.US.X.Z26');
  return {
    get requests() { return requests; },
    client: (clockRef, positions = { net: 0, working: 0 }) => ({
      async activeContract(symbol) { return { id: contractAt(clockRef.t).replace('.X.', `.${symbol}.`) }; },
      async closedBars(contractId, { limit }) {
        requests += 1;
        if (contractAt(clockRef.t).split('.').pop() !== contractId.split('.').pop()) return [];
        const step = minutes * 60000;
        let lastOpen = Math.floor((clockRef.t - publishMs) / step) * step - step;
        if (outage) while (lastOpen + step > outage[0] && lastOpen + step <= outage[1]) lastOpen -= step;
        return Array.from({ length: Math.min(limit, 5) }, (_, k) => {
          const t = lastOpen - (4 - k) * step;
          return { t: new Date(t).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 1 };
        });
      },
      async netPosition() { return positions.net; },
      async workingOrders() { return positions.working; },
    }),
  };
}

async function simulate({ cfg: rawCfg, from, to, cycleMs = 20000, market, killAt = null, positions, timeoutAt = null }) {
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', ...rawCfg });
  const clockRef = { t: from };
  const cycles = [];
  let kill = false;
  const runner = createRunner({
    cfg,
    root: '/r',
    client: market.client(clockRef, positions),
    clock: { now: () => new Date(clockRef.t) },
    runCycle: async (action, prompt) => {
      const start = clockRef.t;
      const timedOut = timeoutAt !== null && start >= timeoutAt && !cycles.some(c => c.timedOut);
      cycles.push({ action, prompt, start, timedOut });
      clockRef.t += cycleMs;
      return { ok: !timedOut, timedOut };
    },
    isKillSwitchOn: () => kill || (killAt !== null && clockRef.t >= killAt),
    createKillSwitch: () => { kill = true; },
    loadState: () => null,
    saveState: () => {},
    writeBars: sym => `/bars/${sym.symbol}.json`,
    scanFor: () => [],
  });
  let guard = 0;
  while (clockRef.t < to) {
    const ms = await runner.step();
    clockRef.t += ms;
    guard += 1;
    if (guard > 200000) throw new Error('runaway loop');
  }
  return { cycles, runner };
}

const barOpens = prompt => [...prompt.matchAll(/(\w+): a \d+-minute bar just closed \(open ([^,]+),/g)].map(m => `${m[1]}@${m[2]}`);

test('3m, full session: exactly one cycle per closed bar, each started within seconds of the close', async () => {
  const market = fakeMarket({ minutes: 3 });
  const { cycles } = await simulate({ cfg: { timeframe: 3, sessions: ['09:35-15:00@America/New_York'] }, from: et(9, 30), to: et(15, 0), market });
  const trade = cycles.filter(c => c.action === 'trade');
  const seen = trade.flatMap(c => barOpens(c.prompt));
  assert.strictEqual(new Set(seen).size, seen.length, 'no bar is processed twice');
  // Bars closing 09:36 ... 15:00 inside the 09:35-15:00 session: 109 closes.
  assert.ok(trade.length >= 107 && trade.length <= 109, `cycles: ${trade.length}`);
  for (const c of trade) {
    const open = Date.parse(barOpens(c.prompt)[0].split('@')[1]);
    const lag = c.start - (open + 3 * 60000);
    assert.ok(lag >= 0 && lag <= 6000, `cycle started ${lag} ms after the close`);
  }
  assert.ok(market.requests <= trade.length * 3 + 10, `bar requests: ${market.requests}`);
});

test('1m with 40 s cycles: every bar still gets its cycle', async () => {
  const market = fakeMarket({ minutes: 1 });
  const { cycles } = await simulate({ cfg: { timeframe: 1 }, from: et(10, 0), to: et(11, 0), cycleMs: 40000, market });
  const trade = cycles.filter(c => c.action === 'trade');
  assert.ok(trade.length >= 58, `cycles: ${trade.length}`);
});

test('two symbols are served in the same cycle, so neither starves', async () => {
  const market = fakeMarket({ minutes: 3 });
  const { cycles } = await simulate({ cfg: { timeframe: 3, symbols: ['MNQ', 'MES'] }, from: et(10, 0), to: et(11, 0), cycleMs: 100000, market });
  const trade = cycles.filter(c => c.action === 'trade');
  assert.ok(trade.length >= 19);
  for (const c of trade) assert.deepStrictEqual(barOpens(c.prompt).map(x => x.split('@')[0]), ['MNQ', 'MES']);
});

test('cycles longer than a bar skip bars instead of queueing them', async () => {
  const market = fakeMarket({ minutes: 3 });
  const { cycles } = await simulate({ cfg: { timeframe: 3 }, from: et(10, 0), to: et(11, 0), cycleMs: 200000, market });
  const trade = cycles.filter(c => c.action === 'trade');
  for (let i = 1; i < trade.length; i += 1) assert.ok(trade[i].start >= trade[i - 1].start + 200000, 'never overlapping');
  assert.ok(trade.length >= 15 && trade.length <= 18, `cycles: ${trade.length}`); // back to back, each on a bar under half a bar old
  for (const c of trade) {
    const open = Date.parse(barOpens(c.prompt)[0].split('@')[1]);
    assert.ok(c.start - (open + 180000) <= 90000, 'never acts on a stale bar');
  }
});

test('kill switch stops trade cycles at once; end of day still runs', async () => {
  const market = fakeMarket({ minutes: 3 });
  const { cycles } = await simulate({ cfg: { timeframe: 3 }, from: et(10, 0), to: et(16, 0), market, killAt: et(11, 0) });
  assert.ok(cycles.filter(c => c.action === 'trade').every(c => c.start < et(11, 0, 30)));
  assert.strictEqual(cycles.filter(c => c.action === 'eod').length, 1);
});

test('past the daily cap, cycles only run to manage an open position', async () => {
  const market = fakeMarket({ minutes: 3 });
  const flat = await simulate({ cfg: { timeframe: 3, maxCyclesPerDay: 5, account: '1' }, from: et(10, 0), to: et(11, 0), market, positions: { net: 0, working: 0 } });
  assert.strictEqual(flat.cycles.filter(c => c.action === 'trade').length, 5);
  const open = await simulate({ cfg: { timeframe: 3, maxCyclesPerDay: 5, account: '1' }, from: et(10, 0), to: et(11, 0), market, positions: { net: 1, working: 1 } });
  const manage = open.cycles.filter(c => c.action === 'manage');
  assert.ok(manage.length >= 13, `manage cycles: ${manage.length}`);
  assert.match(manage[0].prompt, /manage-only/);
});

test('an outage resyncs with back-off, then cycles resume', async () => {
  const market = fakeMarket({ minutes: 1, outage: [et(10, 10), et(10, 25)] });
  const { cycles } = await simulate({ cfg: { timeframe: 1 }, from: et(10, 0), to: et(10, 40), cycleMs: 10000, market });
  const trade = cycles.filter(c => c.action === 'trade');
  assert.ok(trade.some(c => c.start > et(10, 25)), 'resumed after the outage');
  assert.ok(market.requests < 40 * 4, `requests ${market.requests} stay bounded during the outage`);
});

test('contract roll: the new front month is picked up on the next trading day', async () => {
  const market = fakeMarket({ minutes: 3, rollAt: et(12, 0) });
  const { cycles } = await simulate({ cfg: { timeframe: 3, weekdaysOnly: false }, from: et(11, 0), to: et(11, 0) + 26 * 3600000, market });
  const trade = cycles.filter(c => c.action === 'trade');
  assert.ok(trade.some(c => /H27/.test(c.prompt)), 'trades the new contract after the roll');
  assert.ok(trade.filter(c => c.start > et(12, 0) && c.start < et(15, 0)).length >= 1, 'resyncs re-resolve the contract within the day too');
});

test('after a timed-out cycle the next cycle is told to check protective stops first', async () => {
  const market = fakeMarket({ minutes: 3 });
  const { cycles } = await simulate({ cfg: { timeframe: 3 }, from: et(10, 0), to: et(10, 30), market, timeoutAt: et(10, 10) });
  const i = cycles.findIndex(c => c.timedOut);
  assert.ok(i >= 0 && cycles[i + 1]);
  assert.match(cycles[i + 1].prompt, /previous cycle was stopped before it finished/);
});

function bareRunner({ cfg, clockRef, client, runCycle = async () => ({ ok: true, timedOut: false }), saveState = () => {}, logs = [] }) {
  return createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', ...cfg }),
    root: '/r', client, clock: { now: () => new Date(clockRef.t) }, runCycle,
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState,
    writeBars: () => '/b.json', scanFor: () => [], log: m => logs.push(m),
  });
}

test('a symbol whose first poll returns no bars still resyncs and re-checks its contract', async () => {
  const clockRef = { t: et(10, 0) };
  let lookups = 0;
  const runner = bareRunner({
    cfg: { timeframe: 3 }, clockRef,
    client: { async activeContract() { lookups += 1; return { id: 'CON.F.US.MNQ.Z26' }; }, async closedBars() { return []; } },
  });
  while (clockRef.t < et(10, 30)) clockRef.t += await runner.step();
  assert.ok(lookups >= 2, `contract re-checked after repeated resyncs (lookups ${lookups})`);
});

test('a failing end of day is retried with a growing pause, not in a tight loop', async () => {
  const clockRef = { t: et(15, 55) };
  let runs = 0;
  const runner = bareRunner({ cfg: { timeframe: 3 }, clockRef, client: {}, runCycle: async () => { runs += 1; return { ok: false, timedOut: false }; } });
  const start = clockRef.t;
  while (clockRef.t < start + 3600000) clockRef.t += Math.max(await runner.step(), 1);
  assert.ok(runs < 100, `${runs} end-of-day runs in an hour`);
});

test('a failed contract lookup keeps the known contract trading and retries slowly', async () => {
  const market = fakeMarket({ minutes: 3 });
  const clockRef = { t: et(9, 30) };
  const base = market.client(clockRef);
  let lookups = 0;
  let failing = false;
  const cycles = [];
  const runner = bareRunner({
    cfg: { timeframe: 3 }, clockRef,
    client: { ...base, async activeContract(s) { lookups += 1; if (failing) throw new Error('HTTP 500'); return base.activeContract(s); } },
    runCycle: async () => { cycles.push(clockRef.t); return { ok: true, timedOut: false }; },
  });
  while (clockRef.t < et(9, 45)) clockRef.t += await runner.step();
  // The next trading day starts with the lookup failing for 10 minutes.
  clockRef.t = et(9, 35) + 864e5;
  failing = true;
  lookups = 0;
  const before = cycles.length;
  while (clockRef.t < et(9, 45) + 864e5) clockRef.t += await runner.step();
  assert.ok(lookups <= 25, `${lookups} lookups in 10 minutes`);
  assert.ok(cycles.length - before >= 2, 'bars on the known contract still start cycles');
});

test('an exception inside a pass is logged and the loop carries on', async () => {
  const market = fakeMarket({ minutes: 3 });
  const clockRef = { t: et(9, 50) };
  let saves = 0;
  const logs = [];
  const runner = bareRunner({
    cfg: { timeframe: 3 }, clockRef, client: market.client(clockRef), logs,
    saveState: () => { saves += 1; if (saves === 1) throw new Error('ENOSPC'); },
  });
  let cycles = 0;
  while (clockRef.t < et(10, 10)) {
    const ms = await runner.step();
    clockRef.t += ms;
    cycles = runner.state ? runner.state.cycles : cycles;
  }
  assert.ok(logs.some(l => /ENOSPC/.test(l)));
  assert.ok(saves > 2, 'later passes still run');
});

test('hard market hours: sessions in the 16:00-18:00 ET break, a missing end of day, or one after the 16:00 ET close are rejected', () => {
  assert.throws(() => validateConfig({ sessions: ['16:30-17:30@America/New_York'] }), /market session/);
  assert.throws(() => validateConfig({ sessions: ['00:00-24:00@UTC'] }), /market session/);
  assert.ok(validateConfig({ sessions: ['18:00-15:50@America/New_York'] }), 'the full Topstep session');
  assert.ok(validateConfig({ sessions: ['asia', 'london', 'ny'], eodAt: '16:00@America/New_York' }), 'named sessions');
  assert.throws(() => validateConfig({ eodAt: '' }), /eodAt: required/);
  assert.throws(() => validateConfig({ eodAt: '16:30@America/New_York' }), /no later than 16:00/);
  assert.throws(() => validateConfig({ eodAt: '15:30@America/Chicago' }), /no later than 16:00/, '15:30 CT is 16:30 ET');
  assert.ok(validateConfig({ sessions: ['08:35-14:00@America/Chicago'], eodAt: '14:50@America/Chicago' }));
});

test('outside market hours the runner flattens anything open, once a minute', async () => {
  const r = await trailSim({ tape: {}, until: et(16, 5) });
  assert.ok(r.cycles.includes('eod'));
  assert.deepStrictEqual(r.closedIds, ['CON.F.US.MNQ.Z26'], 'closed at end of day');
  const brk = await trailSim({ tape: {}, startAt: et(17, 0), until: et(17, 3) });
  assert.deepStrictEqual(brk.closedIds, ['CON.F.US.MNQ.Z26'], 'a position found in the 16:00-18:00 ET break is closed');
});

test('a session that runs past end of day is rejected', () => {
  assert.throws(() => validateConfig({ sessions: ['10:00-15:55@America/New_York'], eodAt: '15:50@America/New_York' }), /past eodAt/);
  assert.ok(validateConfig({ sessions: ['09:35-15:00@America/New_York'] }));
});

test('leftover orders on a flat contract are cancelled before the cycle; pending entries are kept', async () => {
  const market = fakeMarket({ minutes: 3 });
  const clockRef = { t: et(9, 55) };
  const cancelled = [];
  let positions = [];
  const orders = [
    { id: 1, contractId: 'CON.F.US.MNQ.Z26', type: 4, side: 1, size: 1 }, // leftover stop
    { id: 2, contractId: 'CON.F.US.MNQ.Z26', type: 1, side: 0, size: 1 }, // pending entry
    { id: 3, contractId: 'CON.F.US.MES.Z26', type: 4, side: 1, size: 1 }, // another root
  ];
  const runner = createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '', timeframe: 3, account: '7' }), root: '/r',
    client: {
      ...market.client(clockRef),
      async accountState() { return { positions, orders: orders.filter(o => !cancelled.includes(o.id)) }; },
      async cancelOrder(acct, id) { cancelled.push(id); },
    },
    clock: { now: () => new Date(clockRef.t) }, runCycle: async () => ({ ok: true, timedOut: false }),
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {},
    writeBars: () => '/b.json', scanFor: () => [], entryOrders: () => [{ orderId: 2, contractId: 'CON.F.US.MNQ.Z26', setup: 'orb', side: 'buy' }],
  });
  while (clockRef.t < et(10, 2)) clockRef.t += await runner.step();
  assert.deepStrictEqual(cancelled, [1]);
  // With a position open nothing is cancelled.
  positions = [{ contractId: 'CON.F.US.MNQ.Z26', type: 1, size: 1 }];
  cancelled.length = 0;
  orders.push({ id: 4, contractId: 'CON.F.US.MNQ.Z26', type: 4, side: 1, size: 1 });
  while (clockRef.t < et(10, 8)) clockRef.t += await runner.step();
  assert.deepStrictEqual(cancelled, []);
});

test('a trailing strategy\'s stop is tightened from +2R and the trade is closed when a bar goes through the new stop', async () => {
  const clockRef = { t: et(10, 0) + 2000 };
  const step = 180000;
  // Long 1 from 21500, stop 21490 (1R = 10 points = 40 ticks). Each closed bar is scripted.
  const path = [[21505, 21510, 21502], [21522, 21525, 21521], [21533, 21535, 21531], [21536, 21540, 21534]];
  let k = 0;
  const modified = [];
  const closed = [];
  let stopPrice = 21490;
  const runner = createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '', timeframe: 3, account: '7' }), root: '/r',
    client: {
      async activeContract() { return { id: 'CON.F.US.MNQ.Z26', tickSize: 0.25, tickValue: 0.5 }; },
      async closedBars() {
        const lastOpen = Math.floor((clockRef.t - 1000) / step) * step - step;
        k = Math.min(path.length - 1, Math.max(0, Math.round((lastOpen - et(10, 0)) / step)));
        const [c, h, l] = path[k];
        return [{ t: new Date(lastOpen - step).toISOString(), o: 21500, h: 21501, l: 21499, c: 21500, v: 1 }, { t: new Date(lastOpen).toISOString(), o: c, h, l, c, v: 1 }];
      },
      async accountState() {
        return {
          positions: closed.length ? [] : [{ id: 77, contractId: 'CON.F.US.MNQ.Z26', type: 1, size: 1, averagePrice: 21500, creationTimestamp: new Date(et(10, 0) + 5000).toISOString() }],
          orders: closed.length ? [] : [{ id: 9, contractId: 'CON.F.US.MNQ.Z26', type: 4, side: 1, size: 1, stopPrice }],
        };
      },
      async modifyStop(acct, id, price) { modified.push(price); stopPrice = price; },
      async closePosition(acct, contractId) { closed.push(contractId); },
      async cancelOrder() {},
      async netPosition() { return closed.length ? 0 : 1; },
      async workingOrders() { return 1; },
    },
    clock: { now: () => new Date(clockRef.t) }, runCycle: async () => ({ ok: true, timedOut: false }),
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {},
    writeBars: () => '/b.json', scanFor: () => [],
    entryOrders: () => [{ orderId: 5, contractId: 'CON.F.US.MNQ.Z26', setup: 'trendy', side: 'buy', stopTicks: 40, at: new Date(et(10, 0) + 3000).toISOString() }],
    strategyNamed: () => ({ name: 'trendy', risk: { stop: 'atr:0.5', min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } }),
  });
  while (clockRef.t < et(10, 15)) clockRef.t += await runner.step();
  // Bar 2: peak 21525 = 2.5R -> stop 21520 (2R). Bar 3: peak 3.5R -> 21530.
  // Bar 4: peak 4R -> 21535, but its low 21534 is already through it -> closed at market.
  assert.deepStrictEqual(modified, [21520, 21530]);
  assert.deepStrictEqual(closed, ['CON.F.US.MNQ.Z26']);
});

/**
 * Trailing harness: long 1 MNQ from 21500 with a 40-tick stop (1R = 10), exit
 * trail 2R / 0.5R. `tape` maps bar open (ET minutes after 10:00) to [h, l, c].
 */
async function trailSim({ tape, fillAt = et(10, 0) + 5000, record = {}, modifyFails = 0, cycleMs = 0, until = et(10, 20), stopAt = 21490, noStop = false, stopSize = 1, killAfterCycle = false, otherMonth = null, flow = null, writeFails = false, startAt = et(10, 0) + 2000 }) {
  const clockRef = { t: startAt };
  const step = 180000;
  const calls = { modified: [], closed: [], cancelled: [], closedIds: [], written: [] };
  let stopPrice = stopAt;
  let failsLeft = modifyFails;
  let flat = false;
  let killed = false;
  const cycles = [];
  const runner = createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '', timeframe: 3, account: '7' }), root: '/r',
    client: {
      async activeContract() { return { id: 'CON.F.US.MNQ.Z26', tickSize: 0.25, tickValue: 0.5 }; },
      async closedBars() {
        const lastOpen = Math.floor((clockRef.t - 1000) / step) * step - step;
        const out = [];
        for (let t = lastOpen - 6 * step; t <= lastOpen; t += step) {
          const m = Math.round((t - et(10, 0)) / 60000);
          const [h, l, c] = tape[m] || [21501, 21499, 21500];
          out.push({ t: new Date(t).toISOString(), o: c, h, l, c, v: 1 });
        }
        return out;
      },
      async accountState() {
        return {
          positions: [
            ...(flat ? [] : [{ id: 77, contractId: 'CON.F.US.MNQ.Z26', type: 1, size: 1, averagePrice: 21500, creationTimestamp: new Date(fillAt).toISOString() }]),
            ...(otherMonth && !calls.closedIds.includes(otherMonth) ? [{ id: 78, contractId: otherMonth, type: 1, size: 1, averagePrice: 21600, creationTimestamp: new Date(fillAt).toISOString() }] : []),
          ],
          orders: calls.cancelled.length ? [] : [...(noStop ? [] : [{ id: 9, contractId: 'CON.F.US.MNQ.Z26', type: 4, side: 1, size: stopSize, stopPrice }]), { id: 10, contractId: 'CON.F.US.MNQ.Z26', type: 1, side: 1, size: 1, limitPrice: 21600 }],
        };
      },
      async modifyStop(acct, id, price) { if (failsLeft > 0) { failsLeft -= 1; throw new Error('HTTP 503'); } calls.modified.push(price); stopPrice = price; },
      async closePosition(acct, id) { calls.closed.push(clockRef.t); calls.closedIds.push(id); if (id === 'CON.F.US.MNQ.Z26') flat = true; },
      async cancelOrder(acct, id) { calls.cancelled.push(id); },
      async netPosition() { return flat ? 0 : 1; },
      async workingOrders() { return 1; },
    },
    clock: { now: () => new Date(clockRef.t) },
    runCycle: async (action) => { cycles.push(action); clockRef.t += cycleMs; if (killAfterCycle) killed = true; return { ok: true, timedOut: false }; },
    isKillSwitchOn: () => killed, createKillSwitch: () => {}, loadState: () => null, saveState: () => {},
    writeBars: (sym, bars) => { if (writeFails) throw new Error('ENOSPC: no space left on device'); calls.written.push(bars); return '/b.json'; }, scanFor: () => [], flow,
    entryOrders: () => [{ orderId: 5, contractId: 'CON.F.US.MNQ.Z26', setup: 'trendy', side: 'buy', stopTicks: 40, at: new Date(fillAt - 2000).toISOString(), ...record }],
    strategyNamed: () => ({ name: 'trendy', risk: { stop: 'atr:0.5', min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } }),
  });
  while (clockRef.t < until) clockRef.t += await runner.step();
  return { ...calls, runner, cycles };
}

test('trailing: prices from before a mid-bar fill do not count toward the peak', async () => {
  // A limit fills at 10:04:30 inside the 10:03 bar, which earlier traded up to 21521.
  const r = await trailSim({ tape: { 3: [21521, 21499, 21503] }, fillAt: et(10, 4, 30), until: et(10, 12) });
  assert.deepStrictEqual([r.modified, r.closed], [[], []]);
});

test('trailing: bars that close while a cycle runs are still applied, in order', async () => {
  const r = await trailSim({ tape: { 0: [21525, 21521, 21524], 3: [21524, 21515, 21516] }, cycleMs: 290000, until: et(10, 15) });
  // Peak 2.5R on the 10:00 bar -> stop 21520; the 10:03 bar (seen late) goes through it.
  assert.ok(r.modified.includes(21520) || r.closed.length === 1, JSON.stringify(r));
});

test('trailing: when the modify fails, a bar through the unrested level closes the trade and its orders are cancelled', async () => {
  const r = await trailSim({ tape: { 0: [21525, 21521, 21524], 3: [21524, 21518, 21519] }, modifyFails: 5, until: et(10, 12) });
  assert.strictEqual(r.closed.length, 1);
  assert.deepStrictEqual(r.cancelled.sort(), [10, 9]);
});

test('trailing: an entry record from an earlier day is not used for today\'s position', async () => {
  const r = await trailSim({ tape: { 0: [21525, 21521, 21524] }, record: { at: new Date(et(10, 0) - 864e5).toISOString(), stopTicks: 8 }, until: et(10, 9) });
  assert.deepStrictEqual([r.modified, r.closed], [[], []]);
});

test('trailing: with no working stop, a bar through the planned stop closes the trade', async () => {
  const r = await trailSim({ tape: { 3: [21501, 21485, 21488] }, noStop: true, until: et(10, 9) });
  assert.strictEqual(r.closed.length, 1);
});

test('trailing: a stop bigger than the position is not moved toward the market', async () => {
  const r = await trailSim({ tape: { 0: [21525, 21521, 21524] }, stopSize: 2, until: et(10, 5) });
  assert.deepStrictEqual(r.modified, []);
});

test('kill switch on after the day traded: a position with no stop is closed and its target cancelled at once', async () => {
  const r = await trailSim({ tape: {}, noStop: true, killAfterCycle: true, until: et(10, 9) });
  assert.strictEqual(r.closed.length, 1);
  assert.deepStrictEqual(r.cancelled, [10]);
});

test('kill switch on: a stop bigger than the position (it would flip it) counts as unprotected', async () => {
  const r = await trailSim({ tape: {}, stopSize: 2, killAfterCycle: true, until: et(10, 9) });
  assert.strictEqual(r.closed.length, 1);
  assert.deepStrictEqual(r.cancelled.sort(), [10, 9]);
});

test('kill switch on: an unprotected position in another month of the root is closed too', async () => {
  const r = await trailSim({ tape: {}, otherMonth: 'CON.F.US.MNQ.H27', killAfterCycle: true, until: et(10, 9) });
  assert.deepStrictEqual(r.closedIds, ['CON.F.US.MNQ.H27']);
  assert.deepStrictEqual(r.cancelled, [], 'the protected Z26 position keeps its orders');
});

test('kill switch on after the day traded: a protected position is left to its stop', async () => {
  const r = await trailSim({ tape: {}, killAfterCycle: true, until: et(10, 9) });
  assert.deepStrictEqual([r.closed, r.cancelled], [[], []]);
});

test('with order flow on, the bars written and scanned carry real buy/sell volume', async () => {
  const flow = { annotate: (id, bars, minutes) => bars.map(b => ({ ...b, bv: minutes, sv: 1 })) };
  const r = await trailSim({ tape: {}, flow, until: et(10, 4) });
  assert.ok(r.written.length > 0 && r.written.every(bars => bars.every(b => b.bv === 3 && b.sv === 1)));
});

test('a bars file that cannot be written still lets housekeeping protect the position', async () => {
  const r = await trailSim({ tape: { 3: [21501, 21485, 21488] }, noStop: true, writeFails: true, until: et(10, 9) });
  assert.strictEqual(r.closed.length, 1, 'the bar through the planned stop still closes the trade');
  assert.ok(!r.cycles.includes('trade'), 'no cycle without a bars file');
});

test('end of day: a position the end-of-day run left open is closed directly', async () => {
  const r = await trailSim({ tape: {}, until: et(15, 52) });
  assert.ok(r.cycles.includes('eod'));
  assert.deepStrictEqual(r.closedIds, ['CON.F.US.MNQ.Z26']);
  assert.deepStrictEqual(r.cancelled.sort(), [10, 9]);
});

test('after the session, with trades today, the runner keeps housekeeping until end of day', () => {
  const { decide } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', account: '7', sessions: ['09:35-15:00@America/New_York'] });
  const s = { day: '2026-10-07', premarketDone: true, eodDone: false, cycles: 5, lastCycleAt: null };
  assert.strictEqual(decide(cfg, s, new Date(et(15, 20))).action, 'housekeep');
  assert.strictEqual(decide(cfg, { ...s, cycles: 0 }, new Date(et(15, 20))).action, null);
  assert.strictEqual(decide(cfg, s, new Date(et(15, 55))).action, 'eod');
});
