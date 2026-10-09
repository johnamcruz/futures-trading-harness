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

async function simulate({ cfg: rawCfg, from, to, cycleMs = 20000, market, killAt = null, positions, timeoutAt = null, deps = {} }) {
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', ...rawCfg });
  const clockRef = { t: from };
  const cycles = [];
  let kill = false;
  const runner = createRunner({
    cfg,
    root: '/r',
    client: market.client(clockRef, positions),
    clock: { now: () => new Date(clockRef.t) },
    runCycle: async (action, prompt, limits = {}) => {
      const start = clockRef.t;
      const timedOut = timeoutAt !== null && start >= timeoutAt && !cycles.some(c => c.timedOut);
      cycles.push({ action, prompt, context: limits.context || null, start, timedOut });
      clockRef.t += cycleMs;
      return { ok: !timedOut, timedOut };
    },
    isKillSwitchOn: () => kill || (killAt !== null && clockRef.t >= killAt),
    createKillSwitch: () => { kill = true; },
    loadState: () => null,
    saveState: () => {},
    writeBars: sym => `/bars/${sym.symbol}.json`,
    scanFor: () => [],
    ...deps,
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

// Each symbol's bar in a cycle, from the context the cycle log records (the prompt shows ET times).
const barOpens = c => (c.context ? c.context.symbols.map(x => `${x.symbol}@${x.bar.t}`) : []);

test('3m, full session: exactly one cycle per closed bar, each started within seconds of the close', async () => {
  const market = fakeMarket({ minutes: 3 });
  const { cycles } = await simulate({ cfg: { timeframe: 3, sessions: ['09:35-15:00@America/New_York'] }, from: et(9, 30), to: et(15, 0), market });
  const trade = cycles.filter(c => c.action === 'trade');
  const seen = trade.flatMap(c => barOpens(c));
  assert.strictEqual(new Set(seen).size, seen.length, 'no bar is processed twice');
  // Bars closing 09:36 ... 15:00 inside the 09:35-15:00 session: 109 closes.
  assert.ok(trade.length >= 107 && trade.length <= 109, `cycles: ${trade.length}`);
  for (const c of trade) {
    const open = Date.parse(barOpens(c)[0].split('@')[1]);
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
  for (const c of trade) assert.deepStrictEqual(barOpens(c).map(x => x.split('@')[0]), ['MNQ', 'MES']);
});

test('cycles longer than a bar skip bars instead of queueing them', async () => {
  const market = fakeMarket({ minutes: 3 });
  const { cycles } = await simulate({ cfg: { timeframe: 3 }, from: et(10, 0), to: et(11, 0), cycleMs: 200000, market });
  const trade = cycles.filter(c => c.action === 'trade');
  for (let i = 1; i < trade.length; i += 1) assert.ok(trade[i].start >= trade[i - 1].start + 200000, 'never overlapping');
  assert.ok(trade.length >= 15 && trade.length <= 18, `cycles: ${trade.length}`); // back to back, each on a bar under half a bar old
  for (const c of trade) {
    const open = Date.parse(barOpens(c)[0].split('@')[1]);
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
  assert.throws(() => validateConfig({ sessions: ['00:00-24:00@UTC'] }), /America\/New_York or America\/Chicago/);
  assert.throws(() => validateConfig({ sessions: ['23:00-20:50@Europe/London'], eodAt: '20:50@Europe/London' }), /America\/New_York or America\/Chicago/, 'zones whose clocks change on other dates');
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
async function trailSim({ tape, fillAt = et(10, 0) + 5000, record = {}, modifyFails = 0, cycleMs = 0, until = et(10, 20), stopAt = 21490, noStop = false, stopSize = 1, killAfterCycle = false, otherMonth = null, flow = null, writeFails = false, startAt = et(10, 0) + 2000, eodFails = false, prop = null, startFlat = false, scan = [], trigger = undefined, balanceFails = false, balanceHangs = false, readMs = 0, accountReadMs = undefined, exit = { trail_activate_r: 2, trail_giveback_r: 0.5 }, stf = undefined, accountFails = false }) {
  const clockRef = { t: startAt };
  const step = 180000;
  const calls = { modified: [], closed: [], cancelled: [], closedIds: [], written: [], limits: [], prompts: [], scans: [], logs: [], events: [] };
  let stopPrice = stopAt;
  let failsLeft = modifyFails;
  let flat = startFlat;
  let killed = false;
  const cycles = [];
  const runner = createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '', timeframe: 3, account: '7', ...(trigger ? { trigger } : {}) }), root: '/r',
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
        if (accountFails) throw new Error('HTTP 502');
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
      async workingOrders() { return flat ? 0 : 1; },
      async accountBalance() {
        if (balanceFails) throw new Error('HTTP 503');
        if (balanceHangs) return new Promise(() => {});
        clockRef.t += readMs;
        return 50100;
      },
    },
    clock: { now: () => new Date(clockRef.t) }, prop, ...(accountReadMs ? { accountReadMs } : {}),
    runCycle: async (action, prompt, limits = {}) => { cycles.push(action); calls.prompts.push(prompt); calls.limits.push([action, clockRef.t, limits.timeoutMs]); if (action === 'eod' && eodFails) return { ok: false, timedOut: true }; clockRef.t += cycleMs; if (killAfterCycle) killed = true; return { ok: true, timedOut: false, result: `CYCLE RESULT: managed - ${action}` }; },
    isKillSwitchOn: () => killed, createKillSwitch: () => { calls.kills = (calls.kills || 0) + 1; }, loadState: () => null, saveState: () => {},
    writeBars: (sym, bars) => { if (writeFails) throw new Error('ENOSPC: no space left on device'); calls.written.push(bars); return '/b.json'; }, scanFor: () => scan, flow,
    entryOrders: () => [{ orderId: 5, contractId: 'CON.F.US.MNQ.Z26', setup: 'trendy', side: 'buy', stopTicks: 40, at: new Date(fillAt - 2000).toISOString(), ...record }],
    strategyNamed: () => ({ name: 'trendy', risk: { stop: 'atr:0.5', min_rr: 2 }, exit, ...(stf ? { timeframe: stf } : {}) }),
    scanLog: rec => calls.scans.push(rec),
    event: ev => calls.events.push(ev),
    log: (msg, level) => calls.logs.push(`${level === 'error' ? 'ERROR' : 'INFO'} ${msg}`),
  });
  while (clockRef.t < until) clockRef.t += await runner.step();
  return { ...calls, runner, cycles };
}

test('time stop: a strategy with exit.max_bars is closed at market once it has been in the trade that long', async () => {
  // A CRT-style exit: a target level and a 3-bar time stop, no trail. Price goes nowhere.
  const r = await trailSim({ tape: {}, exit: { target: 'crt_target(60)', max_bars: 3 }, until: et(10, 20) });
  assert.deepStrictEqual(r.closedIds, ['CON.F.US.MNQ.Z26']);
  assert.ok(r.closed[0] >= et(10, 9) && r.closed[0] < et(10, 12), `closed after the third bar (${new Date(r.closed[0]).toISOString()})`);
  assert.ok(r.cancelled.includes(9) && r.cancelled.includes(10), 'its orders are cancelled');
  assert.deepStrictEqual(r.modified, [], 'nothing trails');
  // Without max_bars (a plain target), the runner leaves the trade to its bracket.
  const plain = await trailSim({ tape: {}, exit: { target_r: 2 }, until: et(10, 20) });
  assert.deepStrictEqual(plain.closedIds, []);
});

test('time stop: max_bars counts the strategy\'s bars, scaled to the runner\'s timeframe', async () => {
  // 1 bar of a 15-minute strategy = 5 bars of the 3-minute runner.
  const r = await trailSim({ tape: {}, exit: { target: 'x', max_bars: 1 }, stf: '15m', until: et(10, 30) });
  assert.deepStrictEqual(r.closedIds, ['CON.F.US.MNQ.Z26']);
  assert.ok(r.closed[0] >= et(10, 15) && r.closed[0] < et(10, 18), `closed after the fifth 3m bar (${new Date(r.closed[0]).toISOString()})`);
  assert.ok(r.logs.some(l => /time stop 1 15m bars = 5 3m bars/.test(l)), r.logs.join('\n'));
  assert.ok(r.logs.some(l => /time stop: 5 3m bars in the trade \(max_bars 1\)/.test(l)));
});

test('the decision log gets one record per scanned bar, and every bar\'s cycle decision is logged with its close', async () => {
  const candidate = [{ name: 'trendy', status: 'active', signal: 'rules', candidate: true, direction: 'long', stopDistance: 10, detail: { 'crt(60)': { reason: 'fired' } } }];
  const r = await trailSim({ tape: {}, startFlat: true, scan: candidate, until: et(10, 10), trigger: 'signal' });
  assert.ok(r.scans.length >= 1);
  const rec = r.scans[0];
  assert.strictEqual(rec.symbol, 'MNQ');
  assert.strictEqual(rec.contractId, 'CON.F.US.MNQ.Z26');
  assert.ok(rec.bar && rec.bar.t && rec.bar.c === 21500);
  assert.strictEqual(rec.results[0].detail['crt(60)'].reason, 'fired');
  assert.ok(rec.decision && rec.decision.run === true, JSON.stringify(rec.decision));
  assert.ok(r.logs.some(l => /^INFO MNQ bar \S+ close 21500: cycle \(/.test(l)), r.logs.join('\n'));
  // A bar with nothing to do says so, with its close.
  const quiet = await trailSim({ tape: {}, startFlat: true, scan: [], until: et(10, 10), trigger: 'signal' });
  assert.ok(quiet.scans.every(x => x.decision.run === false && !x.results.some(y => y.candidate)));
  assert.ok(quiet.logs.some(l => /MNQ bar \S+ close 21500: no cycle \(/.test(l)));
});

test('the event log records cycles, account reads, managed positions, stops moved, closes, flattens, and end of day', async () => {
  const kinds = r => r.events.map(e => e.kind);
  // A trailed trade: the stop is moved from +2R, then the trade is closed when a bar goes through it.
  const trail = await trailSim({ tape: { 0: [21525, 21521, 21524] }, until: et(10, 12) }); // peak 2.5R: stop to 21520
  const shut = await trailSim({ tape: { 0: [21525, 21521, 21524], 3: [21524, 21518, 21519] }, modifyFails: 5, until: et(10, 12) });
  const managed = trail.events.find(e => e.kind === 'position_managed');
  assert.deepStrictEqual([managed.symbol, managed.setup, managed.side, managed.entry, managed.risk], ['MNQ', 'trendy', 'long', 21500, 10]);
  const moved = trail.events.filter(e => e.kind === 'stop_moved');
  assert.ok(moved.length >= 1 && moved.every(e => e.to > e.from), JSON.stringify(moved));
  const closed = shut.events.find(e => e.kind === 'position_closed');
  assert.ok(closed && /trail/.test(closed.why) && closed.peakR >= 2 && typeof closed.rNow === 'number', JSON.stringify(closed));
  // Every cycle is timed and carries its result line; the account read for it is logged.
  const end = trail.events.find(e => e.kind === 'cycle_end');
  assert.ok(end && end.ok === true && end.result === 'CYCLE RESULT: managed - trade' && typeof end.ms === 'number' && end.symbols[0] === 'MNQ', JSON.stringify(end));
  assert.ok(kinds(trail).indexOf('cycle_start') < kinds(trail).indexOf('cycle_end'));
  const acct = trail.events.find(e => e.kind === 'account');
  assert.ok(acct && acct.balance === 50100 && Array.isArray(acct.positions), JSON.stringify(acct));
  assert.ok(trail.events.every(e => typeof e.at === 'string' && e.kind));
  assert.ok(trail.logs.some(l => /trade: CYCLE RESULT: managed - trade/.test(l)), 'the result line is in the text log too');
  // End of day: the position left open is flattened, and the day's end is recorded.
  const eod = await trailSim({ tape: {}, until: et(15, 52) });
  assert.ok(eod.events.some(e => e.kind === 'flatten' && e.why === 'end of day' && e.contractId === 'CON.F.US.MNQ.Z26'));
  assert.ok(eod.events.some(e => e.kind === 'eod' && e.ok === true && e.day));
});

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

test('end of day flattens first, even when the agents\' end-of-day run fails', async () => {
  const r = await trailSim({ tape: {}, eodFails: true, until: et(15, 52) });
  assert.ok(r.cycles.includes('eod'));
  assert.deepStrictEqual(r.closedIds, ['CON.F.US.MNQ.Z26']);
  assert.ok(r.closed[0] <= et(15, 50) + 5000, 'closed at end of day, not after the run');
});

test('no run may outlast end of day: each gets at most the time left until eodAt', async () => {
  const r = await trailSim({ tape: {}, startAt: et(15, 39) + 2000, until: et(15, 52) });
  const trade = r.limits.filter(([a]) => a === 'trade' || a === 'manage');
  assert.ok(trade.length > 0);
  for (const [, at, ms] of trade) assert.ok(at + ms <= et(15, 50), `a cycle at ${new Date(at).toISOString()} may run ${ms} ms, past end of day`);
  const eod = r.limits.find(([a]) => a === 'eod');
  assert.ok(eod[1] + eod[2] <= et(16, 0), 'the end-of-day run ends by the close');
});

test('after the session, with trades today, the runner keeps housekeeping until end of day', () => {
  const { decide } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', account: '7', sessions: ['09:35-15:00@America/New_York'] });
  const s = { day: '2026-10-07', premarketDone: true, eodDone: false, cycles: 5, lastCycleAt: null };
  assert.strictEqual(decide(cfg, s, new Date(et(15, 20))).action, 'housekeep');
  assert.strictEqual(decide(cfg, { ...s, cycles: 0 }, new Date(et(15, 20))).action, null);
  assert.strictEqual(decide(cfg, s, new Date(et(15, 55))).action, 'eod');
});

/** A fake prop-challenge hook set (rl/live-runner.js) that records its calls. */
function fakeProp({ position = () => 'hold', screen = r => r, summariesFail = false, eodFails = 0, eodError = 'HTTP 503', owners = undefined } = {}) {
  const calls = { snapshots: [], eod: [], eodDays: [], positions: [], screens: [], summaries: 0 };
  return {
    calls,
    ...(owners ? { owners } : {}),
    async snapshot(now) { calls.snapshots.push(now.getTime()); },
    async endOfDay(now, day) {
      calls.eod.push(now.getTime());
      calls.eodDays.push(day);
      if (calls.eod.length <= eodFails) throw new Error(eodError);
    },
    summaries(now, balance) {
      calls.summaries += 1;
      calls.summaryBalances = [...(calls.summaryBalances || []), balance];
      if (summariesFail) throw new Error('attempt file unreadable');
      return [{ account: 'mini', status: 'active', asOf: now.toISOString(), balance, floor: 48000, cushion: balance - 48000, profit: balance - 50000, target: 3000, dayPnl: 100, sessionsLeft: 29, budgets: [], entryBlock: null }];
    },
    screen(results, info) { calls.screens.push({ results, info }); return screen(results); },
    position(args) { calls.positions.push(args); return position(args); },
  };
}

test('prop challenge: the balance is snapshotted every bar and recorded once at end of day, after the flatten', async () => {
  const prop = fakeProp();
  const r = await trailSim({ tape: {}, startAt: et(15, 30) + 2000, until: et(15, 52), prop });
  assert.ok(prop.calls.snapshots.length >= 5, `${prop.calls.snapshots.length} snapshots`);
  assert.strictEqual(prop.calls.eod.length, 1);
  const { tradingDayKey } = require('../../scripts/lib/trading/clock');
  assert.deepStrictEqual(prop.calls.eodDays, [tradingDayKey(new Date(et(15, 30)))], 'the trading day being closed');
  assert.ok(r.closed.length && r.closed[0] <= prop.calls.eod[0], 'flat before the closing balance is read');
});

test('end of day never deadlocks on the closing balance: a failed record is retried on its own, never by rerunning end of day', async () => {
  // Fails once (the broker), then records on the retry a minute later.
  const once = fakeProp({ eodFails: 1 });
  const a = await trailSim({ tape: {}, startAt: et(15, 30) + 2000, until: et(16, 5), prop: once });
  assert.deepStrictEqual(a.cycles.filter(c => c === 'eod'), ['eod'], 'one end-of-day run');
  assert.strictEqual(once.calls.eod.length, 2);
  assert.ok(once.calls.eod[1] - once.calls.eod[0] >= 60000, 'a minute apart');
  assert.strictEqual(a.kills || 0, 0, 'no kill switch');
  // Never recordable (a position the runner doesn't trade stays open): five tries, then it stops;
  // end of day is still done once, and the gate's missed-close check keeps prop entries refused.
  const never = fakeProp({ eodFails: Infinity, eodError: '1 position(s) still open (CON.F.US.GCE.Z26)' });
  const b = await trailSim({ tape: {}, startAt: et(15, 30) + 2000, until: et(17, 0), prop: never });
  assert.deepStrictEqual(b.cycles.filter(c => c === 'eod'), ['eod']);
  assert.strictEqual(never.calls.eod.length, 5);
  assert.strictEqual(b.kills || 0, 0);
  // A conflict a retry can't fix (already recorded by hand at another balance): one try.
  const conflict = fakeProp({ eodFails: Infinity, eodError: 'mini: the close of 2026-10-07 is already recorded at $50300, not $50100' });
  const c = await trailSim({ tape: {}, startAt: et(15, 30) + 2000, until: et(17, 0), prop: conflict });
  assert.strictEqual(conflict.calls.eod.length, 1);
  assert.deepStrictEqual(c.cycles.filter(x => x === 'eod'), ['eod']);
});

test('prop challenge: past the ratchet the policy is asked every bar and may close the trade', async () => {
  // Bar 10:03 peaks at 21525 (2.5R): past the 2R ratchet. The policy closes at once.
  const prop = fakeProp({ position: () => 'close' });
  const r = await trailSim({ tape: { 3: [21525, 21521, 21522] }, prop });
  assert.ok(prop.calls.positions.length >= 1);
  const asked = prop.calls.positions[0];
  assert.ok(asked.pos.peakR >= 2, 'never asked before the ratchet');
  assert.deepStrictEqual({ sign: asked.pos.sign, entry: asked.pos.entry, risk: asked.pos.risk, size: asked.pos.size }, { sign: 1, entry: 21500, risk: 10, size: 1 });
  assert.deepStrictEqual(r.closedIds, ['CON.F.US.MNQ.Z26']);
  assert.ok(r.cancelled.includes(9) && r.cancelled.includes(10));
  // Hold: the trail manages it alone.
  const holder = fakeProp({ position: () => 'hold' });
  const h = await trailSim({ tape: { 3: [21525, 21521, 21522] }, prop: holder });
  assert.ok(holder.calls.positions.length >= 1);
  assert.deepStrictEqual(h.closedIds, []);
});

test('prop challenge: when flat, the policy screens setups; a skipped setup starts no cycle', async () => {
  const candidate = [{ name: 'trendy', status: 'active', signal: 'rules', candidate: true, direction: 'long', stopDistance: 10 }];
  const skip = fakeProp({ screen: rs => rs.map(x => ({ ...x, candidate: false })) });
  const a = await trailSim({ tape: {}, startFlat: true, scan: candidate, prop: skip, until: et(10, 10), trigger: 'signal' });
  assert.ok(skip.calls.screens.length >= 1);
  assert.strictEqual(skip.calls.screens[0].info.contractId, 'CON.F.US.MNQ.Z26');
  assert.deepStrictEqual(a.cycles.filter(c => c === 'trade'), []);
  const take = fakeProp();
  const b = await trailSim({ tape: {}, startFlat: true, scan: candidate, prop: take, until: et(10, 10), trigger: 'signal' });
  // Each trade cycle's prompt carries the attempt's state.
  assert.ok(take.calls.summaries >= 1);
  const tradePrompt = b.prompts.find(x => /trade-session/.test(x));
  assert.match(tradePrompt, /Account 7 at \d\d:\d\d ET: balance \$50,100; flat; 0 working orders\./);
  assert.match(tradePrompt, /mini attempt \(active\)(?: as of \d\d:\d\d ET, balance \$50,100)?: floor \$48,000, cushion \$2,100/);
  assert.ok(take.calls.summaryBalances.every(x => x === 50100), 'the attempt is built from the balance just read');
  // trigger: bar runs every bar, and the policy still records its verdicts.
  const each = fakeProp({ screen: rs => rs.map(x => ({ ...x, candidate: false })) });
  const c = await trailSim({ tape: {}, startFlat: true, scan: candidate, prop: each, until: et(10, 10) });
  assert.ok(each.calls.screens.length >= 1 && c.cycles.includes('trade'));
  assert.ok(b.cycles.filter(c => c === 'trade').length >= 1);
});

test('every run\'s prompt states the account, read just before it; an unreadable account is said, not hidden', async () => {
  const r = await trailSim({ tape: {}, startAt: et(15, 40) + 2000, until: et(15, 52) });
  const eod = r.prompts.find(x => /end-of-day skill/.test(x));
  assert.match(eod, /Account 7 at .*: balance \$50,100; flat; 0 working orders\./, 'the end-of-day run sees the account after the flatten');
  // The open position is described once, as a trade (open-trades.js), not listed again in the account line.
  assert.match(r.prompts.find(x => /trade-session/.test(x)), /Account 7 at .*: balance \$50,100; 1 open position \(below\); 2 working orders\. Open trade CON\.F\.US\.MNQ\.Z26 long 1 @ 21500 since 10:00 ET, 7 bars closed since \(setup unknown[^)]*\): risk 10 points = 40 ticks, measured to the working stop \(the initial stop is unknown\); working stop 21490 \(-1R\), target 21600 \(\+10R\); now \+0R at 21500/);
  const bad = await trailSim({ tape: {}, until: et(10, 8), balanceFails: true });
  assert.match(bad.prompts.find(x => /trade-session/.test(x)), /Account 7: state unavailable \(HTTP 503\); read get_account_snapshot before deciding anything/);
});

test('a hung account read is cut off: the run still starts and says so', async () => {
  const hung = await trailSim({ tape: {}, until: et(10, 8), balanceHangs: true, accountReadMs: 20 });
  assert.ok(hung.cycles.includes('trade'), 'the run is not held up');
  assert.match(hung.prompts.find(x => /trade-session/.test(x)), /Account 7: state unavailable \(no answer within 0\.02 s\)/);
});

test('a slow account read near end of day: each run\'s time limit counts from after the read', async () => {
  const slow = await trailSim({ tape: {}, startAt: et(15, 39) + 2000, until: et(15, 52), readMs: 20000 });
  const runs = slow.limits.filter(([a]) => a !== 'eod');
  assert.ok(runs.length > 0);
  for (const [, at, ms] of runs) assert.ok(at + ms <= et(15, 50), `a run at ${new Date(at).toISOString()} may run ${ms} ms, past end of day`);
  const eod = slow.limits.find(([a]) => a === 'eod');
  assert.ok(eod[1] + eod[2] <= et(16, 0), 'the end-of-day run ends by the close');
});

test('a prop attempt state that cannot be built leaves the account line in the prompt', async () => {
  const take = fakeProp({ summariesFail: true });
  const r = await trailSim({ tape: {}, startFlat: true, scan: [{ name: 'trendy', status: 'active', signal: 'rules', candidate: true, direction: 'long', stopDistance: 10 }], prop: take, until: et(10, 10), trigger: 'signal' });
  const prompt = r.prompts.find(x => /trade-session/.test(x));
  assert.match(prompt, /Account 7 at .*: balance \$50,100; flat; 0 working orders\./);
  assert.doesNotMatch(prompt, /attempt/);
});

test('every closed bar records the multi-timeframe read for the gate, and the cycle prompt carries its trend rule', async () => {
  const recorded = [];
  const line = 'Trend rule: prevailing trend 4h up; trend strategies may not go short, reversal strategies (mtf: reversal) may.';
  const ok = await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 10), market: fakeMarket({ minutes: 3 }),
    deps: { recordMtf: (sym, bars) => { recorded.push([sym.symbol, bars.length]); return line; } },
  });
  assert.ok(recorded.length >= 3 && recorded.every(([sym, n]) => sym === 'MNQ' && n > 0));
  assert.ok(ok.cycles.length >= 3);
  assert.ok(ok.cycles.every(c => c.prompt.includes(`MNQ ${line.replace(/\.$/, '')} (recorded for the order gate, which enforces it).`)), ok.cycles[0].prompt);
  // A failed record never stops the cycle; the prompt says the gate will refuse trend entries.
  const logs = [];
  const failed = await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 4), market: fakeMarket({ minutes: 3 }),
    deps: { recordMtf: () => { throw new Error('disk full'); }, log: (m, level = 'info') => logs.push(`${level} ${m}`) },
  });
  assert.ok(failed.cycles.length >= 1);
  assert.match(failed.cycles[0].prompt, /MNQ: no multi-timeframe record this bar, so the gate refuses trend strategies' entries/);
  assert.ok(logs.some(l => /error MNQ: could not record the multi-timeframe read \(disk full\)/.test(l)), logs.join('\n'));
});

test('every scanned bar records its signals for the gate, also on the default bar trigger', async () => {
  const recorded = [];
  const scan = [{ name: 'orb', signal: 'rules', status: 'active', candidate: true, direction: 'long', stopDistance: 5 }];
  await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 10), market: fakeMarket({ minutes: 3 }),
    deps: { scanFor: () => scan, recordSignals: (item, results) => recorded.push([item.symbol, item.bar.t, results.length]) },
  });
  assert.ok(recorded.length >= 3 && recorded.every(([s, t, n]) => s === 'MNQ' && t && n === 1), JSON.stringify(recorded));
});

test('the trade prompt carries the last closed bars and the model\'s own last cycle results', async () => {
  let n = 0;
  const r = await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 12), market: fakeMarket({ minutes: 3 }),
    deps: { runCycle: async () => { n += 1; return { ok: true, timedOut: false, result: `CYCLE RESULT: no-trade - reason ${n}` }; } },
  });
  // simulate() records prompts via its own runCycle; use the runner's state for the history and check the builder directly.
  assert.ok(r.runner.state.history.length >= 2);
  assert.match(r.runner.state.history.at(-1).result, /no-trade - reason \d/);
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'qwen', eodAt: '15:50@America/New_York' });
  const bars = Array.from({ length: 12 }, (_, k) => ({ t: new Date(et(9, 30) + k * 180000).toISOString(), o: 100 + k, h: 101 + k, l: 99 + k, c: 100.5 + k, v: 10 + k }));
  const p = prompts(cfg, new Date(et(10, 6)), '/r').trade([{ symbol: 'MNQ', bar: { t: bars[11].t, c: 111.5, file: '/f', contractId: 'C', recent: bars.slice(-10) } }], { history: r.runner.state.history });
  assert.match(p, /MNQ last 10 closed 3m bars \(ET open time, oldest first\): 09:36 O 102 H 103 L 101 C 102\.5 V 12 \(\+0\.5\);/);
  assert.match(p, /Your last \d cycle\(s\), oldest first: .*MNQ: no-trade - reason 1 \| .*Don't flip-flop/);
});

test('a failed strategy scan is named in the prompt; end-of-day and premarket cycles log their context', async () => {
  const logs = [];
  const r = await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 7), market: fakeMarket({ minutes: 3 }),
    deps: { scanFor: () => { throw new Error('rules engine down'); }, log: (m, level = 'info') => logs.push(`${level} ${m}`) },
  });
  const trade = r.cycles.filter(c => c.action === 'trade');
  assert.ok(trade.length >= 1, 'the bar still gets its cycle');
  for (const c of trade) {
    assert.match(c.prompt, /Context unavailable this cycle \(not "none"\): MNQ strategy scan \(rules engine down\): what fired is unknown\./);
    assert.doesNotMatch(c.prompt, /no rules strategy fired/, 'not "nothing fired"');
    assert.deepStrictEqual(c.context.unavailable, ['MNQ strategy scan (rules engine down): what fired is unknown']);
  }
  assert.ok(logs.some(l => /^error MNQ: strategy scan failed \(rules engine down\)/.test(l)));
  // End of day: the prompt and its logged context name the trading day.
  const e = await simulate({ cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(15, 48), to: et(15, 55), market: fakeMarket({ minutes: 3 }) });
  const eod = e.cycles.find(c => c.action === 'eod');
  assert.ok(eod, 'an end-of-day cycle');
  assert.match(eod.prompt, /for the trading day ending \d{4}-\d\d-\d\d, on 3-minute bars/);
  assert.strictEqual(eod.context.action, 'eod');
  assert.match(eod.context.day, /^\d{4}-\d\d-\d\d$/);
  assert.ok(eod.prompt.includes(eod.context.day));
});

test('under a policy, a failed account check means no verdict: named, and the components are not entries', async () => {
  const candidate = [{ name: 'trendy', status: 'active', signal: 'rules', candidate: true, direction: 'long', stopDistance: 10 }];
  const r = await trailSim({ tape: {}, startFlat: true, scan: candidate, prop: fakeProp(), until: et(10, 10), trigger: 'signal', accountFails: true });
  const p = r.prompts.find(x => /trade-session/.test(x));
  assert.ok(p, 'the cycle still runs, to manage anything open');
  assert.match(p, /MNQ policy screen \(account check failed: HTTP 502\): no verdict, so no entry for trendy this bar/);
  assert.match(p, /trendy long \(its policy has no verdict this bar: not an entry\)/);
  assert.doesNotMatch(p, /These are .*'s components/);
  assert.ok(r.logs.some(l => /^ERROR MNQ: account check failed \(HTTP 502\)/.test(l)), r.logs.filter(l => /^ERROR/.test(l)).join(' / '));
});

test('a prop account with no active policy: a failed account check leaves plain strategies tradable', async () => {
  const candidate = [{ name: 'trendy', status: 'active', signal: 'rules', candidate: true, direction: 'long', stopDistance: 10 }];
  for (const trigger of ['signal', 'bar']) {
    // owners: no active policy owns anything on this contract (e.g. prop_portfolio_3m is paper).
    const r = await trailSim({ tape: {}, startFlat: true, scan: candidate, prop: fakeProp({ owners: () => new Map() }), until: et(10, 10), trigger, accountFails: true });
    const p = r.prompts.find(x => /trade-session/.test(x));
    assert.ok(p, trigger);
    assert.match(p, /fired on this bar[^:]*: trendy long[.\s]/, trigger);
    assert.doesNotMatch(p, /no verdict|not an entry/, `${trigger}: no policy is involved, so nothing about verdicts`);
  }
  // Owned by an active policy: marked, and only that one.
  const two = [...candidate, { name: 'plain', status: 'active', signal: 'rules', candidate: true, direction: 'long', stopDistance: 10 }];
  const r = await trailSim({ tape: {}, startFlat: true, scan: two, prop: fakeProp({ owners: () => new Map([['trendy', 'prop_x']]) }), until: et(10, 10), trigger: 'signal', accountFails: true });
  const p = r.prompts.find(x => /trade-session/.test(x));
  assert.match(p, /trendy long \(its policy has no verdict this bar: not an entry\)/);
  assert.match(p, /plain long(?! \(its policy)/);
});
