'use strict';

// Long-run simulations of the autonomous runner core (scripts/lib/runner.js)
// under a simulated clock and a fake market, to show it runs exactly one cycle
// per closed bar, consistently, across a whole session.
const test = require('node:test');
const assert = require('node:assert');
const { createRunner } = require('../../scripts/lib/runner');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { afterTargetStep } = require('../../scripts/lib/trading/exit-trail');

const DAY = Date.UTC(2026, 9, 7); // Wednesday; New York = UTC-4
const et = (h, m, s = 0) => DAY + ((h + 4) * 60 + m) * 60000 + s * 1000;

/**
 * Fake market: bars aligned to the timeframe, published `publishMs` after the
 * close; optional outages (no bars) and a contract roll at `rollAt`.
 */
function fakeMarket({ minutes, publishMs = 1000, outage = null, rollAt = null, accountState = null }) {
  let requests = 0;
  // Standard contract names (the contract translator's): the root, or root:YYYY-MM for another month.
  const contractAt = (t, symbol) => (rollAt && t >= rollAt ? `${symbol}:2027-03` : symbol);
  return {
    get requests() { return requests; },
    client: (clockRef, positions = { net: 0, working: 0 }) => ({
      async activeContract(symbol) { return { id: contractAt(clockRef.t, symbol) }; },
      async closedBars(contractId, { limit }) {
        requests += 1;
        // Bars only for the contract that is current now (an old month after the roll has none).
        if (contractAt(clockRef.t, contractId.split(':')[0]) !== contractId) return [];
        const step = minutes * 60000;
        let lastOpen = Math.floor((clockRef.t - publishMs) / step) * step - step;
        if (outage) while (lastOpen + step > outage[0] && lastOpen + step <= outage[1]) lastOpen -= step;
        return Array.from({ length: Math.min(limit, 5) }, (_, k) => {
          const t = lastOpen - (4 - k) * step;
          return { t: new Date(t).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 1 };
        });
      },
      ...(accountState ? { async accountState() { return accountState; }, async accountBalance() { return 100000; } } : {}),
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
  assert.ok(trade.some(c => /MNQ:2027-03/.test(c.prompt)), 'trades the new contract after the roll');
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
    client: { async activeContract() { lookups += 1; return { id: 'MNQ' }; }, async closedBars() { return []; } },
  });
  while (clockRef.t < et(10, 30)) { const ms = await runner.step(); clockRef.t += ms; }
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
  while (clockRef.t < et(9, 45)) { const ms = await runner.step(); clockRef.t += ms; }
  // The next trading day starts with the lookup failing for 10 minutes.
  clockRef.t = et(9, 35) + 864e5;
  failing = true;
  lookups = 0;
  const before = cycles.length;
  while (clockRef.t < et(9, 45) + 864e5) { const ms = await runner.step(); clockRef.t += ms; }
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
  assert.ok(validateConfig({ sessions: ['18:00-15:50@America/New_York'] }), 'the harness\'s full hours in the trading day');
  assert.ok(validateConfig({ sessions: ['asia', 'london', 'ny'], eodAt: '16:00@America/New_York' }), 'named sessions');
  assert.throws(() => validateConfig({ eodAt: '' }), /eodAt: required/);
  assert.throws(() => validateConfig({ eodAt: '16:30@America/New_York' }), /no later than 16:00/);
  assert.throws(() => validateConfig({ eodAt: '15:30@America/Chicago' }), /no later than 16:00/, '15:30 CT is 16:30 ET');
  assert.ok(validateConfig({ sessions: ['08:35-14:00@America/Chicago'], eodAt: '14:50@America/Chicago' }));
});

test('outside market hours the runner flattens anything open, once a minute', async () => {
  const r = await trailSim({ tape: {}, until: et(16, 5) });
  assert.ok(r.cycles.includes('eod'));
  assert.deepStrictEqual(r.closedIds, ['MNQ'], 'closed at end of day');
  const brk = await trailSim({ tape: {}, startAt: et(17, 0), until: et(17, 3) });
  assert.deepStrictEqual(brk.closedIds, ['MNQ'], 'a position found in the 16:00-18:00 ET break is closed');
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
    { id: 1, contractId: 'MNQ', type: 4, side: 1, size: 1 }, // leftover stop
    { id: 2, contractId: 'MNQ', type: 1, side: 0, size: 1 }, // pending entry
    { id: 3, contractId: 'MES', type: 4, side: 1, size: 1 }, // another root
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
    writeBars: () => '/b.json', scanFor: () => [], entryOrders: () => [{ orderId: 2, contractId: 'MNQ', setup: 'orb', side: 'buy' }],
  });
  while (clockRef.t < et(10, 2)) { const ms = await runner.step(); clockRef.t += ms; }
  assert.deepStrictEqual(cancelled, [1]);
  // With a position open nothing is cancelled.
  positions = [{ contractId: 'MNQ', type: 1, size: 1 }];
  cancelled.length = 0;
  orders.push({ id: 4, contractId: 'MNQ', type: 4, side: 1, size: 1 });
  while (clockRef.t < et(10, 8)) { const ms = await runner.step(); clockRef.t += ms; }
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
      async activeContract() { return { id: 'MNQ', tickSize: 0.25, tickValue: 0.5 }; },
      async closedBars() {
        const lastOpen = Math.floor((clockRef.t - 1000) / step) * step - step;
        k = Math.min(path.length - 1, Math.max(0, Math.round((lastOpen - et(10, 0)) / step)));
        const [c, h, l] = path[k];
        return [{ t: new Date(lastOpen - step).toISOString(), o: 21500, h: 21501, l: 21499, c: 21500, v: 1 }, { t: new Date(lastOpen).toISOString(), o: c, h, l, c, v: 1 }];
      },
      async accountState() {
        return {
          positions: closed.length ? [] : [{ id: 77, contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500, creationTimestamp: new Date(et(10, 0) + 5000).toISOString() }],
          orders: closed.length ? [] : [{ id: 9, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice }],
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
    entryOrders: () => [{ orderId: 5, contractId: 'MNQ', setup: 'trendy', side: 'buy', stopTicks: 40, at: new Date(et(10, 0) + 3000).toISOString() }],
    strategyNamed: () => ({ name: 'trendy', risk: { stop: 'atr:0.5', min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } }),
  });
  while (clockRef.t < et(10, 15)) { const ms = await runner.step(); clockRef.t += ms; }
  // Bar 2: peak 21525 = 2.5R -> stop 21520 (2R). Bar 3: peak 3.5R -> 21530.
  // Bar 4: peak 4R -> 21535, but its low 21534 is already through it -> closed at market.
  assert.deepStrictEqual(modified, [21520, 21530]);
  assert.deepStrictEqual(closed, ['MNQ']);
});

/**
 * Trailing harness: long 1 MNQ from 21500 with a 40-tick stop (1R = 10), exit
 * trail 2R / 0.5R. `tape` maps bar open (ET minutes after 10:00) to [h, l, c].
 */
async function trailSim({ tape, fillAt = et(10, 0) + 5000, record = {}, modifyFails = 0, cycleMs = 0, until = et(10, 20), stopAt = 21490, noStop = false, stopSize = 1, killAfterCycle = false, otherMonth = null, barExtra = null, writeFails = false, startAt = et(10, 0) + 2000, eodFails = false, prop = null, startFlat = false, scan = [], trigger = undefined, balanceFails = false, balanceHangs = false, readMs = 0, accountReadMs = undefined, exit = { trail_activate_r: 2, trail_giveback_r: 0.5 }, stf = undefined, accountFails = false, ghostCloses = 0, oddSize = false, closeFillMs = 0, cfgOver = {}, pollMs = 0, stateIn = null, outcome = null, realKill = false, killWhen = null, keepCycleTime = false, killFile = null, beforeStep = null, fillPrice = 21500, short = false, base = [21501, 21499, 21500], extraEntries = [], closeFails = 0, bars1mFail = false, price1m = null, watchMs = undefined, recordPrice = undefined, cycleWait = 0, flatAt = null, cancelFails = 0, modifyGone = false, restore = false, placeFails = false, ordersOver = null, resizeFails = false, flatOnReread = false }) {
  let ghosts = ghostCloses;
  let fillsAt = null; // closeFillMs: the close fills that long after it is sent // closes the broker accepts without filling
  const clockRef = { t: startAt };
  const step = 180000;
  const calls = { modified: [], closed: [], cancelled: [], closedIds: [], written: [], limits: [], prompts: [], scans: [], logs: [], events: [] };
  let stopPrice = stopAt;
  let failsLeft = modifyFails;
  let flat = startFlat;
  let killed = false;
  const cycles = [];
  const runner = createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '', timeframe: 3, account: '7', ...(trigger ? { trigger } : {}), ...cfgOver }), root: '/r',
    client: {
      async activeContract() { return { id: 'MNQ', tickSize: 0.25, tickValue: 0.5 }; },
      async closedBars(cid, o = {}) {
        if (o.minutes === 1) { (calls.bars1m = calls.bars1m || []).push(clockRef.t); if (bars1mFail) throw new Error('HTTP 503'); if (typeof price1m === 'function') return price1m(calls.bars1m.length, clockRef.t); if (price1m !== null) return [{ t: new Date(clockRef.t - 120000).toISOString(), o: price1m, h: price1m, l: price1m, c: price1m, v: 1 }]; }
        const lastOpen = Math.floor((clockRef.t - 1000) / step) * step - step;
        clockRef.t += pollMs; // a slow API
        const out = [];
        for (let t = lastOpen - 6 * step; t <= lastOpen; t += step) {
          const m = Math.round((t - et(10, 0)) / 60000);
          const [h, l, c] = tape[m] || base;
          out.push({ t: new Date(t).toISOString(), o: c, h, l, c, v: 1, ...(barExtra || {}) });
        }
        return out;
      },
      async accountState() {
        (calls.accountReads = calls.accountReads || []).push(clockRef.t);
        if (accountFails) throw new Error('HTTP 502');
        // flatOnReread: the position goes flat between two reads of one pass (a leg that just filled).
        if (flatOnReread && clockRef.t >= flatOnReread && calls.accountReads.length >= 2 && calls.accountReads.at(-2) === clockRef.t) flat = true;
        if (fillsAt !== null && clockRef.t >= fillsAt) flat = true;
        // flatAt: the bracket's stop fills then (the position goes flat, the stop with it; any target keeps working).
        const stopFilled = flatAt !== null && clockRef.t >= flatAt;
        if (stopFilled) flat = true;
        return {
          positions: [
            ...(flat ? [] : [{ id: 77, contractId: 'MNQ', type: short ? 2 : 1, ...(oddSize ? {} : { size: 1 }), averagePrice: fillPrice, creationTimestamp: new Date(fillAt).toISOString() }]),
            ...(otherMonth && !calls.closedIds.includes(otherMonth) ? [{ id: 78, contractId: otherMonth, type: 1, size: 1, averagePrice: 21600, creationTimestamp: new Date(fillAt).toISOString() }] : []),
          ],
          orders: (ordersOver || (x => x))([...(calls.placed || []).map(([cid, side, size, stopPrice], i) => ({ id: 90 + i, contractId: cid, type: 4, side: side === 'buy' ? 0 : 1, size, stopPrice })), ...(noStop ? [] : [{ id: 9, contractId: 'MNQ', type: 4, side: short ? 0 : 1, size: stopSize, stopPrice }]), { id: 10, contractId: 'MNQ', type: 1, side: short ? 0 : 1, size: 1, limitPrice: short ? fillPrice - 100 : 21600 }].filter(o => !calls.cancelled.includes(o.id) && !(stopFilled && o.id === 9))).filter(o => !calls.cancelled.includes(o.id)),
        };
      },
      ...(restore ? { async placeStop(acct, cid, side, size, stopPrice, rationale) { if (placeFails) throw new Error('HTTP 503'); (calls.placed = calls.placed || []).push([cid, side, size, stopPrice]); (calls.rationales = calls.rationales || []).push(rationale); } } : {}),
      async resizeStop(acct, id, size) { if (resizeFails) throw new Error('HTTP 400'); (calls.resized = calls.resized || []).push([id, size]); stopSize = size; },
      async modifyStop(acct, id, price, reason) { if (modifyGone) { flat = true; throw new Error('order not found'); } if (failsLeft > 0) { failsLeft -= 1; throw new Error('HTTP 503'); } calls.modified.push(price); if (reason) (calls.reasons = calls.reasons || []).push(reason); stopPrice = price; },
      async closePosition(acct, id) { (calls.seq = calls.seq || []).push(`close ${id}`); calls.closed.push(clockRef.t); calls.closedIds.push(id); if (closeFails > 0) { closeFails -= 1; throw new Error('HTTP 503'); } if (id === 'MNQ') { if (ghosts > 0) ghosts -= 1; else if (closeFillMs) fillsAt = clockRef.t + closeFillMs; else flat = true; } },
      async cancelOrder(acct, id) { (calls.seq = calls.seq || []).push(`cancel ${id}`); if (cancelFails > 0) { cancelFails -= 1; (calls.cancelTries = calls.cancelTries || []).push([id, clockRef.t]); throw new Error('HTTP 503'); } calls.cancelled.push(id); (calls.cancelTries = calls.cancelTries || []).push([id, clockRef.t]); },
      async netPosition() { return flat ? 0 : short ? -1 : 1; },
      async workingOrders() { return flat ? 0 : 1; },
      async accountBalance() {
        if (balanceFails) throw new Error('HTTP 503');
        if (balanceHangs) return new Promise(() => {});
        clockRef.t += readMs;
        return 50100;
      },
    },
    clock: { now: () => new Date(clockRef.t) }, prop, ...(accountReadMs ? { accountReadMs } : {}), ...(watchMs ? { composedWatchMs: watchMs } : {}), ...(recordPrice ? { recordPrice } : {}),
    runCycle: async (action, prompt, limits = {}) => { cycles.push(action); calls.prompts.push(prompt); calls.limits.push([action, clockRef.t, limits.timeoutMs]); if (action === 'eod' && eodFails) return { ok: false, timedOut: true }; if (cycleWait && (action === 'trade' || action === 'manage')) await cycleWait(clockRef); clockRef.t += cycleMs; if (killAfterCycle) killed = true; if (killWhen && killWhen(action)) killed = true; if (outcome && action !== 'eod') return outcome(action); return { ok: true, timedOut: false, result: `CYCLE RESULT: managed - ${action}` }; },
    isKillSwitchOn: () => killed || (killFile !== null && require('fs').existsSync(killFile)), createKillSwitch: () => { calls.kills = (calls.kills || 0) + 1; if (realKill) killed = true; }, loadState: () => stateIn, saveState: s => { calls.saved = s; },
    writeBars: (sym, bars) => { if (writeFails) throw new Error('ENOSPC: no space left on device'); calls.written.push(bars); return '/b.json'; }, scanFor: () => scan,
    entryOrders: () => [...extraEntries, { orderId: 5, contractId: 'MNQ', setup: 'trendy', side: short ? 'sell' : 'buy', stopTicks: 40, at: new Date(fillAt - 2000).toISOString(), ...record }],
    strategyNamed: () => ({ name: 'trendy', risk: { stop: 'atr:0.5', min_rr: 2 }, exit, ...(stf ? { timeframe: stf } : {}) }),
    scanLog: rec => calls.scans.push(rec),
    event: ev => calls.events.push(ev),
    log: (msg, level) => calls.logs.push(`${level === 'error' ? 'ERROR' : 'INFO'} ${msg}`),
  });
  // `clockRef.t += await step()` adds the pause to the time the pass started (what a cycle took is not kept);
  // keepCycleTime: the pause counts from where the pass ended, as the live loop's does.
  if (keepCycleTime) while (clockRef.t < until) { const ms = await runner.step(); clockRef.t += Math.max(0, ms); }
  while (clockRef.t < until) {
    if (beforeStep) await beforeStep(clockRef.t);
    { const ms = await runner.step(); clockRef.t += ms; }
  }
  return { ...calls, runner, cycles };
}

test('end of day is done only once the account is verified flat: a close the broker accepts but doesn\'t fill is closed again', async () => {
  // The broker accepts the first two closes without filling them; the third fills.
  const prop = fakeProp();
  const r = await trailSim({ tape: {}, startAt: et(15, 49) + 2000, until: et(16, 5), ghostCloses: 2, prop });
  assert.strictEqual(r.closedIds.filter(id => id === 'MNQ').length, 3, 'closed again until it is gone');
  assert.deepStrictEqual(r.cycles.filter(c => c === 'eod'), ['eod'], 'the agents\' end-of-day run happens once; retries only flatten');
  const kinds = r.events.map(e => e.kind);
  assert.ok(kinds.includes('flatten_unverified') && kinds.includes('flatten_verified'));
  // The prop close is recorded only after the verified flat, and end of day is done.
  const verifiedAt = Date.parse(r.events.find(e => e.kind === 'flatten_verified').at);
  assert.strictEqual(prop.calls.eod.length, 1);
  assert.ok(prop.calls.eod[0] >= verifiedAt, 'the closing balance is recorded only once flat');
  assert.ok(r.events.some(e => e.kind === 'eod' && e.ok === true));
  assert.strictEqual(r.kills || 0, 0);
});

test('a close that fills late is never sent twice: two closes in flight would over-close into the other side', async () => {
  // The agents' run fails at once, so the passes come quickly; the close fills 7 s after it is sent.
  const r = await trailSim({ tape: {}, startAt: et(15, 49) + 2000, until: et(15, 53), closeFillMs: 7000, eodFails: true });
  assert.strictEqual(r.closedIds.filter(id => id === 'MNQ').length, 1);
  assert.ok(r.events.some(e => e.kind === 'eod' && e.ok === true));
  assert.deepStrictEqual(r.cancelled, [9, 10], 'its stop and target are cancelled once it reads flat');
});

test('waiting for closes to fill is no failed run, for a while; a close that never fills still trips the kill switch', async () => {
  const slow = await trailSim({ tape: {}, startAt: et(15, 49) + 2000, until: et(16, 5), ghostCloses: 4 });
  assert.strictEqual(slow.kills || 0, 0);
  assert.ok(slow.events.some(e => e.kind === 'eod' && e.ok === true));
  const stuck = await trailSim({ tape: {}, startAt: et(15, 49) + 2000, until: et(16, 5), ghostCloses: 1000 });
  assert.ok(stuck.kills >= 1, 'never verified flat: a real failure');
  assert.ok(!stuck.events.some(e => e.kind === 'eod' && e.ok === true));
});

test('end of day doesn\'t close again while the trailing manager\'s own close fills', async () => {
  // A time stop (2 bars) closes the trade at 15:49:55 after a slow poll; the close fills 8 s later, after end of day began.
  const r = await trailSim({
    tape: {}, fillAt: et(15, 45) + 5000, startAt: et(15, 45) + 6000, until: et(15, 51), exit: { max_bars: 1 }, pollMs: 115000, closeFillMs: 8000,
  });
  assert.strictEqual(r.closedIds.filter(id => id === 'MNQ').length, 1, r.logs.join('\n'));
  assert.ok(r.closed[0] < et(15, 50) && r.closed[0] > et(15, 49) + 50000, `closed at ${new Date(r.closed[0]).toISOString()}: ${r.logs.join(' | ')}`);
  assert.ok(r.events.some(e => e.kind === 'eod' && e.ok === true));
});

test('on an exchange holiday nothing trades, and a position carried into it is flattened', async () => {
  const r = await trailSim({ tape: {}, startAt: et(10, 0) + 2000, until: et(10, 10), cfgOver: { closedDates: ['2026-10-07'] } });
  assert.deepStrictEqual(r.cycles.filter(c => c === 'trade'), []);
  assert.ok(r.closedIds.includes('MNQ'));
});

test('a position whose size can\'t be read is flattened, never read as flat', async () => {
  const r = await trailSim({ tape: {}, until: et(16, 5), oddSize: true });
  assert.ok(r.closedIds.includes('MNQ'));
});

test('time stop: a strategy with exit.max_bars is closed at market once it has been in the trade that long', async () => {
  // A CRT-style exit: a target level and a 3-bar time stop, no trail. Price goes nowhere.
  const r = await trailSim({ tape: {}, exit: { target: 'crt_target(60)', max_bars: 3 }, until: et(10, 20) });
  assert.deepStrictEqual(r.closedIds, ['MNQ']);
  assert.ok(r.closed[0] >= et(10, 9) && r.closed[0] < et(10, 12), `closed after the third bar (${new Date(r.closed[0]).toISOString()})`);
  assert.ok(r.cancelled.includes(9) && r.cancelled.includes(10), 'its orders are cancelled');
  assert.deepStrictEqual(r.modified, [], 'nothing trails');
  // Without max_bars (a plain target), the runner leaves the trade to its bracket.
  const plain = await trailSim({ tape: {}, exit: { target_r: 2 }, until: et(10, 20) });
  assert.deepStrictEqual(plain.closedIds, []);
});

test('a policy\'s exit mode: target leaves the trade to its own stop and target brackets; a trail on top, or mode trail, trails it', async () => {
  // The bar runs to +2.5R: a trail from 2R would move the stop; the trade's own brackets would not.
  const tape = { 0: [21525, 21521, 21524] };
  const own = await trailSim({ tape, exit: { mode: 'target' }, until: et(10, 12) });
  assert.deepStrictEqual([own.modified, own.closedIds], [[], []], 'nothing moved, nothing closed: the brackets stand');
  assert.ok(!own.events.some(e => e.kind === 'position_managed'), 'not managed');
  for (const exit of [{ mode: 'target', trail_activate_r: 2, trail_giveback_r: 0.5 }, { mode: 'trail', trail_activate_r: 2, trail_giveback_r: 0.5 }]) {
    const r = await trailSim({ tape, exit, until: et(10, 12) });
    assert.deepStrictEqual(r.modified, [21520], JSON.stringify(exit));
  }
});

test('exit mode target_then_trail, live: the target order is cancelled, the stop holds to the target, then locks and trails past it; never loosened', async () => {
  // A long from 21500, 1R = 40 ticks (10 points); its own target (the bracket, 400 ticks) at 21600 = 10R: the lock at 9.5R = 21595.
  const exit = { mode: 'target_then_trail', lock_giveback_r: 0.5, trail_by: 'r', trail_r: 1 };
  const tape = { 0: [21590, 21560, 21580], 3: [21605, 21598, 21603], 6: [21620, 21612, 21618], 9: [21616, 21611, 21614] };
  const r = await trailSim({ tape, exit, record: { targetTicks: 400 }, until: et(10, 15) });
  assert.ok(r.cancelled.includes(10) && !r.cancelled.includes(9), `the target order goes, the stop stays: ${r.cancelled}`);
  // Under the target nothing moves (21590 is 9R); at it the lock (21595); then 1R behind the best price (12R: 21610); a pullback moves nothing.
  assert.deepStrictEqual(r.modified, [21595, 21610]);
  assert.deepStrictEqual(r.closedIds, [], 'not closed at the target');
  assert.ok(r.logs.some(l => /cancelled the target order 10 at 21600: past its target trendy is trailed, not closed/.test(l)), r.logs.join('\n'));
  // A bar through the new stop before it rests: out at market (an exit is never held).
  const thru = await trailSim({ tape: { 3: [21605, 21590, 21600] }, exit, record: { targetTicks: 400 }, until: et(10, 9) });
  assert.deepStrictEqual(thru.closedIds, ['MNQ']);
  // Structure on 15m swings: these few bars confirm none, so the R trail (the fallback), and the runner says so.
  const st = await trailSim({ tape, exit: { ...exit, trail_by: 'structure', swing_tf: '15m' }, record: { targetTicks: 400 }, until: et(10, 15) });
  assert.deepStrictEqual(st.modified, [21595, 21610]);
  assert.ok(st.logs.some(l => /structure trail: no 15m swing confirmed yet; trailing 1R behind the best price \(the fallback\)/.test(l)), st.logs.join('\n'));
  const none = await trailSim({ tape, exit, until: et(10, 15) });
  assert.deepStrictEqual([none.modified, none.cancelled.includes(10)], [[21595, 21610], true], 'no bracket recorded: the one resting limit (21600) is its target');
});

test('exit mode target_then_trail, live: the ratchet moves the resting stop to the best R less the giveback, as exit-trail.js steps the same bars', async () => {
  // The 2026-10-24 replay's MNQ short: from 14530.5, 1R = 98 ticks (24.5 points), its own target (the bracket, 196 ticks)
  // at 14481.5 = 2R. Giveback 1.5R, a loose 3R trail, so the ratchet is the stop past the target.
  const exit = { mode: 'target_then_trail', lock_giveback_r: 1.5, trail_by: 'r', trail_r: 3, ratchet: 'on' };
  const tape = { 3: [14490, 14481.5, 14485], 6: [14440, 14415.25, 14420], 9: [14450, 14430, 14445] };
  const base = [14531, 14530, 14530.5];
  const r = await trailSim({ tape, short: true, base, fillPrice: 14530.5, stopAt: 14555, record: { stopTicks: 98, targetTicks: 196 }, exit, until: et(10, 15) });
  // At the target +0.5R (14518.25); at 4.7R (14415.25) +3.2R (14452); the pullback moves nothing; never closed.
  assert.deepStrictEqual([r.modified, r.closedIds], [[14518.25, 14452], []], r.logs.join('\n'));
  // The same bars through exit-trail.js directly: the same stops (the runner adds nothing of its own).
  let t = { sign: -1, entry: 14530.5, risk: 24.5, stop: 14555, peakR: 0, armed: false, target: 14481.5 };
  const plan = { afterTarget: { lockGivebackR: 1.5, trailBy: 'r', trailR: 3, swingMinutes: null, ratchet: true } };
  const stops = [3, 6, 9].map(m => { const [h, l, c] = tape[m]; const s = afterTargetStep(t, { h, l, c }, plan, 0.25); t = { ...t, ...s }; return s.stop; });
  assert.deepStrictEqual([...new Set(stops)], r.modified);
  // A long mirrors it: from 21500, 1R 10 points, target 21600 (10R); at 10.5R the ratchet is 9R (21590), at 12R 10.5R (21605).
  const long = await trailSim({ tape: { 0: [21590, 21560, 21580], 3: [21605, 21598, 21603], 6: [21620, 21612, 21618], 9: [21616, 21611, 21614] }, exit, record: { targetTicks: 400 }, until: et(10, 15) });
  assert.deepStrictEqual(long.modified, [21590, 21605]);
  // Off (the key left out, as the rulebook's `off` reads): the lock once at 10R - 1.5R (21585), then the loose trail only.
  const { ratchet: _on, ...offExit } = exit;
  const off = await trailSim({ tape: { 0: [21590, 21560, 21580], 3: [21605, 21598, 21603], 6: [21620, 21612, 21618], 9: [21616, 21611, 21614] }, exit: offExit, record: { targetTicks: 400 }, until: et(10, 15) });
  assert.deepStrictEqual(off.modified, [21585, 21590]);
});

test('a composed fill (the gate\'s stamp): beyond the plan\'s stop it is closed at once ([exit]); away from the plan\'s limit its stop goes to the plan\'s price ([protect]); at the limit nothing moves', async () => {
  // The plan: a long, limit 21500, stop 21490 (40 ticks), target 21520. The broker's stop is 40 ticks from the fill.
  const composed = { record: 'r1', expiresAt: new Date(et(10, 6)).toISOString(), entry: 21500, stop: 21490, target: 21520, side: 'long' };
  const exit = { mode: 'target' };
  // Filled 2 points better (21498): its stop rests at 21488; the runner moves it to 21490 once, with its reason.
  const better = await trailSim({ tape: {}, exit, fillPrice: 21498, stopAt: 21488, record: { composed }, until: et(10, 12) });
  assert.deepStrictEqual([better.modified, better.closedIds], [[21490], []], better.logs.join('\n'));
  assert.match(better.reasons[0], /^\[protect\] the plan's stop 21490: filled at 21498, not the plan's 21500/);
  assert.ok(better.events.some(e => e.kind === 'stop_moved' && e.from === 21488 && e.to === 21490));
  // Filled beyond the plan's stop (a marketable limit after the market left the plan): closed at once, orders cancelled.
  const bad = await trailSim({ tape: {}, exit, fillPrice: 21488, stopAt: 21478, record: { composed }, until: et(10, 4) });
  assert.deepStrictEqual([bad.closedIds, bad.modified], [['MNQ'], []]);
  assert.ok(bad.cancelled.includes(9) && bad.cancelled.includes(10));
  assert.ok(bad.logs.some(l => /\[exit\] filled at 21488, beyond the plan's stop 21490: the setup was invalid before the fill \(no late entry\); closed at market/.test(l)), bad.logs.join('\n'));
  // Filled at the limit: its bracket is the plan's; nothing moves. Not composed (no stamp): nothing moves either.
  const at = await trailSim({ tape: {}, exit, record: { composed }, until: et(10, 12) });
  assert.deepStrictEqual([at.modified, at.closedIds], [[], []]);
  const plain = await trailSim({ tape: {}, exit, fillPrice: 21488, stopAt: 21478, until: et(10, 12) });
  assert.deepStrictEqual([plain.modified, plain.closedIds], [[], []]);
});

test('a composed fill closed beyond its plan\'s stop: a lost (ghost) or refused close is sent again while it reads open; its protective stop is never cancelled before it reads flat (only its target goes at once)', async () => {
  const composed = { record: 'r1', expiresAt: new Date(et(10, 6)).toISOString(), entry: 21500, stop: 21490, target: 21520, side: 'long' };
  for (const o of [{ ghostCloses: 1 }, { closeFails: 1 }]) {
    const r = await trailSim({ tape: {}, exit: { mode: 'target' }, fillPrice: 21488, stopAt: 21478, record: { composed }, until: et(10, 12), ...o });
    assert.strictEqual(r.closedIds.filter(id => id === 'MNQ').length, 2, `${JSON.stringify(o)}: ${r.logs.join('\n')}`);
    // The target at once, the stop only after the second close (once it reads flat: cleanupFlat).
    assert.deepStrictEqual(r.seq.slice(0, 2), ['close MNQ', 'cancel 10'], r.seq.join(', '));
    assert.ok(r.seq.indexOf('cancel 9') > r.seq.lastIndexOf('close MNQ'), r.seq.join(', '));
    assert.ok(r.logs.some(l => /\[exit\] filled at 21488, beyond the plan's stop 21490.*\(still open\); closed again at market/.test(l)), r.logs.join('\n'));
  }
});

test('a composed fill: the position is judged by the latest entry of any setup for its root and side; a later non-composed entry that filled is never judged by an earlier composed one\'s plan', async () => {
  // A: a composed long at 21510 (stop 21505), unfilled, a minute before; B: a non-composed long that filled at 21500.
  const A = { orderId: 4, contractId: 'MNQ', setup: 'trade_lifecycle', side: 'buy', stopTicks: 20, at: new Date(et(10, 0) + 5000 - 60000).toISOString(), composed: { record: 'a', expiresAt: new Date(et(10, 6)).toISOString(), entry: 21510, stop: 21505, target: 21530, side: 'long' } };
  const r = await trailSim({ tape: {}, exit: { mode: 'target' }, extraEntries: [A], until: et(10, 12) });
  assert.deepStrictEqual([r.closedIds, r.modified], [[], []], r.logs.join('\n'));
});

test('a composed fill: the stop moves to the plan\'s price only on the newest 1m bar read then; through the plan\'s stop, or unreadable, the position is closed instead ([exit]), never a stop moved through the market', async () => {
  const composed = { record: 'r1', expiresAt: new Date(et(10, 6)).toISOString(), entry: 21500, stop: 21490, target: 21520, side: 'long' };
  const base = { tape: {}, exit: { mode: 'target' }, fillPrice: 21498, stopAt: 21488, record: { composed }, until: et(10, 4) };
  const through = await trailSim({ ...base, price1m: 21489.75 });
  assert.deepStrictEqual([through.modified, through.closedIds], [[], ['MNQ']], through.logs.join('\n'));
  assert.ok(through.logs.some(l => /\[exit\] the price 21489\.75 is beyond the plan's stop 21490/.test(l)), through.logs.join('\n'));
  const unknown = await trailSim({ ...base, bars1mFail: true });
  assert.deepStrictEqual([unknown.modified, unknown.closedIds], [[], ['MNQ']]);
  assert.ok(unknown.logs.some(l => /\[exit\] the price now is unknown, so the stop can't be moved to the plan's 21490 safely/.test(l)), unknown.logs.join('\n'));
  const fine = await trailSim({ ...base, price1m: 21497 });
  assert.deepStrictEqual([fine.modified, fine.closedIds, fine.bars1m.length >= 1], [[21490], [], true]);
  // An old 1m bar (a data stall): no current price, so out, never a stop moved on it.
  const stale = await trailSim({ ...base, price1m: (_n, t) => [{ t: new Date(t - 10 * 60000).toISOString(), o: 21497, h: 21497, l: 21497, c: 21497, v: 1 }] });
  assert.deepStrictEqual([stale.modified, stale.closedIds], [[], ['MNQ']], stale.logs.join('\n'));
});

test('a composed short filled better than its plan: the trail\'s 1R is the risk actually taken to the plan\'s stop (14981.5 to 14986.5: 5 points), not the bracket\'s 28 ticks', async () => {
  const composed = { record: 'r1', expiresAt: new Date(et(10, 6)).toISOString(), entry: 14979.5, stop: 14986.5, target: 14960, side: 'short' };
  // A bar 10.5 points in the short's favour: 2.1R on a 5-point R (the trail activates at 2R), 1.5R on the bracket's 7.
  const r = await trailSim({ tape: { 3: [14976, 14971, 14972] }, short: true, base: [14982, 14981, 14981.5], fillPrice: 14981.5, stopAt: 14988.5, record: { stopTicks: 28, composed }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 }, until: et(10, 12) });
  const managed = r.events.find(e => e.kind === 'position_managed');
  assert.deepStrictEqual([managed.risk, managed.stop], [5, 14986.5], r.logs.join('\n'));
  assert.strictEqual(r.modified[0], 14986.5, 'the re-anchor first');
  // Activated at 2.1R (on the bracket's 7 points it is 1.5R: nothing would move), its stop 0.5R (2.5 points) behind the
  // best price, 14973.5; the bar went through it before it rested: out at market.
  assert.ok(r.logs.some(l => /trail: price went through the new stop 14973\.5 \(resting 14986\.5\); closed trendy at market \(peak 2\.10R\)/.test(l)), r.logs.join('\n'));
  assert.deepStrictEqual(r.closedIds, ['MNQ']);
});

test('during a trade cycle the runner keeps the latest 1m price for the gate (any harness): an in-session composed entry whose price ran past its stop during the cycle is refused on it; never written backwards; no reads outside trade cycles', async () => {
  const LE = require('../../scripts/lib/trading/late-entry');
  const home = require('../helpers').tmpDir();
  const said = [];
  // The 1m bars the broker serves during the cycle: the long's plan is limit 21500, stop 21490; the market falls to
  // 21485 (the 2nd read); the 3rd read is an older bar served late (never recorded over the newer one).
  let fell = null;
  const bars = (n, t) => {
    const at = Math.floor(t / 60000) * 60000 - 60000;
    if (n === 2) fell = at;
    const [open, c] = n === 1 ? [at, 21499] : n === 2 ? [at, 21485] : [(fell ?? at) - 120000, 21500];
    return [{ t: new Date(open).toISOString(), o: c, h: c, l: c, c, v: 1 }];
  };
  const seen = [];
  const cycleWait = async clockRef => {
    // The model's own session: it waits a few polls, then the gate judges its composed long on what the runner recorded.
    for (let i = 0; i < 4; i += 1) { clockRef.t += 20000; await new Promise(r => setTimeout(r, 15)); }
    const briefing = { price: 21500, closedAt: new Date(Math.floor((clockRef.t - 80000) / 180000) * 180000).toISOString(), minutes: 3 };
    seen.push(LE.lateEntryRefusal({ home, root: 'MNQ', side: 'long', entry: 21500, stop: 21490, briefing, now: new Date(clockRef.t), share: 0.25, maxAgeMin: LE.ageLimitOf({ signalMaxAgeBars: 3, signalMaxAgeCeilingMin: 45 }) }));
  };
  const r = await trailSim({ tape: {}, startFlat: true, exit: { mode: 'target' }, price1m: bars, watchMs: 5, cycleWait, until: et(10, 4),
    recordPrice: (sym, rec, o) => LE.recordPrice(home, sym, rec, { ...o, log: m => { said.push(m); o.log(m); } }) });
  assert.ok(r.bars1m.length >= 3, `one read a poll during the cycle: ${r.bars1m.length}`);
  assert.match(seen[0] || '', /^the setup was invalidated before the order went \(price 21485 beyond the plan's stop 21490\): no late entry \(the runner price at /, JSON.stringify(seen));
  assert.strictEqual(LE.readPrice(home, 'MNQ').price, 21485, 'the older bar served late never overwrote it');
  assert.ok(said.some(m => /is newer than this one \(21500 closed .*\): kept$/.test(m)), said.join('\n'));
  // No trade cycle (manage-only, or none at all): no 1m reads for the gate.
  const quiet = await trailSim({ tape: {}, startFlat: true, exit: { mode: 'target' }, price1m: bars, watchMs: 5, until: et(10, 4), cfgOver: { closedDates: ['2026-10-07'] } });
  assert.strictEqual((quiet.bars1m || []).length, 0);
  // A manage-only cycle (the day's cycles used up, a position open): it runs, but reads no 1m bars for the gate.
  const manage = await trailSim({ tape: {}, exit: { mode: 'target' }, price1m: bars, watchMs: 5, cycleWait: async clockRef => { for (let i = 0; i < 4; i += 1) { clockRef.t += 20000; await new Promise(r => setTimeout(r, 15)); } }, until: et(10, 4), recordPrice: () => {}, cfgOver: { maxCyclesPerDay: 1 }, stateIn: { day: '2026-10-07', premarketDone: true, eodDone: false, cycles: 1, lastCycleAt: null } });
  assert.ok(manage.cycles.length > 0 && manage.cycles.every(a => a === 'manage'), `manage cycles ran: ${manage.cycles}`);
  assert.strictEqual((manage.bars1m || []).length, 0, manage.logs.join('\n'));
});

test('time stop: max_bars counts the strategy\'s bars, scaled to the runner\'s timeframe', async () => {
  // 1 bar of a 15-minute strategy = 5 bars of the 3-minute runner.
  const r = await trailSim({ tape: {}, exit: { target: 'x', max_bars: 1 }, stf: '15m', until: et(10, 30) });
  assert.deepStrictEqual(r.closedIds, ['MNQ']);
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
  assert.strictEqual(rec.contractId, 'MNQ');
  assert.ok(rec.bar && rec.bar.t && rec.bar.c === 21500);
  assert.strictEqual(rec.results[0].detail['crt(60)'].reason, 'fired');
  assert.ok(rec.decision && rec.decision.run === true, JSON.stringify(rec.decision));
  assert.ok(r.logs.some(l => /^INFO MNQ bar \S+ close 21500: cycle \(/.test(l)), r.logs.join('\n'));
  // A bar with nothing to do says so, with its close.
  const quiet = await trailSim({ tape: {}, startFlat: true, scan: [], until: et(10, 10), trigger: 'signal' });
  assert.ok(quiet.scans.every(x => x.decision.run === false && !x.results.some(y => y.candidate)));
  assert.ok(quiet.logs.some(l => /MNQ bar \S+ close 21500: no cycle \(/.test(l)));
});

test('a result the runner scores otherwise (autotrader.js scoredResult): cycle_end carries the scored line and the one the agent wrote, the log says so, the decision history takes the scored one', async () => {
  const r = await trailSim({ tape: {}, startFlat: true, until: et(10, 4), outcome: () => ({ ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - stood aside', reportedResult: 'CYCLE RESULT: blocked - stood aside', resultNote: 'reported blocked with no order call this cycle' }) });
  const end = r.events.find(e => e.kind === 'cycle_end' && e.action === 'trade');
  assert.ok(end, r.events.map(e => e.kind).join(','));
  assert.strictEqual(end.result, 'CYCLE RESULT: no-trade - stood aside');
  assert.strictEqual(end.reportedResult, 'CYCLE RESULT: blocked - stood aside');
  assert.ok(r.logs.some(l => /trade: the agent wrote "CYCLE RESULT: blocked - stood aside"; reported blocked with no order call this cycle/.test(l)), r.logs.join('\n'));
  assert.ok((r.runner.state.history || []).every(h => !/blocked/.test(h.result || '')), JSON.stringify(r.runner.state.history));
  // A result scored as written: no reportedResult.
  const plain = await trailSim({ tape: {}, startFlat: true, until: et(10, 4) });
  assert.ok(plain.events.filter(e => e.kind === 'cycle_end').every(e => !('reportedResult' in e)));
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
  // The runner's own exit is kept for the decision history's real R (decision-history.js withPositions).
  const own = (shut.runner.state.runnerExits || []).find(x => x.contractId === closed.contractId);
  assert.ok(own && Math.abs(own.r - closed.rNow) < 0.01 && Number.isFinite(Date.parse(own.at)) && own.side === closed.side && Number.isFinite(Date.parse(own.openedAt)) && own.size === 1, JSON.stringify(shut.runner.state.runnerExits));
  // The entered decision behind that position reads the runner's own exit R in the next prompts.
  const entered = { at: new Date(et(10, 0)).toISOString(), symbols: ['MNQ'], result: 'CYCLE RESULT: executed - trendy long', symbol: 'MNQ', tf: 3, bar: new Date(et(9, 57)).toISOString(), price: 21500, tick: 0.25, contract: 'MNQ', action: 'entered', setup: 'trendy', side: 'long', entrySize: 1 };
  const told = await trailSim({ tape: { 0: [21525, 21521, 21524], 3: [21524, 21518, 21519] }, modifyFails: 5, until: et(10, 12), stateIn: { day: new Date(et(10, 0)).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), premarketDone: true, eodDone: false, cycles: 0, history: [entered] } });
  const toldExit = told.runner.state.runnerExits.at(-1);
  assert.ok(told.prompts.some(p => p.includes(`entered trendy long @21500: trendy long; since`) && p.includes(`closed about ${toldExit.r > 0 ? '+' : ''}${Math.round(toldExit.r * 10) / 10}R (the runner's exit, at the bar close)`)), told.prompts.map(p => (p.match(/Your last [^\n]*?Don't flip-flop/) || [''])[0]).join('\n'));
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
  assert.ok(eod.events.some(e => e.kind === 'flatten' && e.why === 'end of day' && e.contractId === 'MNQ'));
  assert.ok(eod.events.some(e => e.kind === 'eod' && e.ok === true && e.day));
  assert.deepStrictEqual(eod.cycles.filter(c => c === 'eod'), ['eod'], 'the agents\' review run by default');
  // eodReview false (replay): end of day still flattens and finishes, with no agents' run.
  const quiet = await trailSim({ tape: {}, until: et(15, 52), cfgOver: { eodReview: false } });
  assert.ok(quiet.events.some(e => e.kind === 'flatten' && e.why === 'end of day' && e.contractId === 'MNQ'));
  assert.ok(quiet.events.some(e => e.kind === 'eod' && e.ok === true && e.day));
  assert.deepStrictEqual(quiet.cycles.filter(c => c === 'eod'), []);
  assert.throws(() => validateConfig({ eodReview: 'no' }), /eodReview: true or false/);
  // The review run is in the saved state: a runner started again that day (or a replay's next process) doesn't repeat it.
  assert.strictEqual(eod.saved.eodReviewedDay, '2026-10-07');
  const again = await trailSim({ tape: {}, startAt: et(15, 50) + 2000, until: et(15, 52), stateIn: { day: '2026-10-07', premarketDone: true, eodDone: false, cycles: 3, lastCycleAt: null, eodReviewedDay: '2026-10-07' } });
  assert.deepStrictEqual(again.cycles.filter(c => c === 'eod'), []);
  assert.ok(again.events.some(e => e.kind === 'eod' && e.ok === true), 'end of day still flattens and finishes');
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

test('trailing: a stop bigger than the position is not moved toward the market; it is cut to the position (anti-flip), then trailed', async () => {
  const r = await trailSim({ tape: { 0: [21525, 21521, 21524] }, stopSize: 2, until: et(10, 5) });
  assert.deepStrictEqual(r.modified, []);
  assert.deepStrictEqual(r.resized, [[9, 1]], 'the bracket stop itself, cut with modify_order: never a new order');
  assert.ok(r.events.some(e => e.kind === 'stop_resized' && e.from === 2 && e.to === 1));
  // Cut once (the next read finds it the position's size); the trail goes on (here a bar through the level not yet
  // rested closes the trade at market).
  const later = await trailSim({ tape: { 0: [21525, 21521, 21524] }, stopSize: 2, until: et(10, 8) });
  assert.deepStrictEqual(later.resized, [[9, 1]]);
  assert.ok(later.modified.length + later.closed.length >= 1, JSON.stringify(later.logs.slice(-5)));
});

test('trailing: a stop move refused as "order not found" (the bracket filled) reconciles at once: flat, the leftover target is cancelled that same pass', async () => {
  const r = await trailSim({ tape: { 0: [21525, 21521, 21524] }, modifyGone: true, until: et(10, 5) });
  assert.deepStrictEqual(r.modified, []);
  assert.ok(r.cancelled.includes(10), `the target, not waiting for the next bar: ${JSON.stringify(r.cancelled)}`);
  assert.ok(r.logs.some(l => /the stop move was refused \(order not found\) and the MNQ position reads flat/.test(l)), r.logs.join('\n'));
});

test('the bracket invariant: a position with no working stop (a lost bracket) gets the runner\'s [protect] stop at the plan\'s stop on the next poll, an alert; not closed', async () => {
  const r = await trailSim({ tape: {}, noStop: true, restore: true, until: et(10, 5) });
  assert.deepStrictEqual(r.placed, [['MNQ', 'sell', 1, 21490]], 'the entry record\'s 40 ticks from the 21500 fill');
  assert.match(r.rationales[0], /^\[protect\] runner: the bracket's stop is missing/);
  assert.deepStrictEqual(r.closed, []);
  assert.ok(r.logs.some(l => /^ERROR MNQ: ALERT MNQ had stops for 0 of 1: restored a stop for 1 at 21490/.test(l)), r.logs.join('\n'));
  assert.ok(r.events.some(e => e.kind === 'protection_restored' && e.stop === 21490));
  // Restored once: the next polls read it working.
  const later = await trailSim({ tape: {}, noStop: true, restore: true, until: et(10, 12) });
  assert.strictEqual(later.placed.length, 1);
});

test('the bracket invariant outside the sessions: the lost stop is restored (not the position closed)', async () => {
  const r = await trailSim({ tape: {}, noStop: true, restore: true, startAt: et(11, 51) + 2000, fillAt: et(11, 50), until: et(12, 5), cfgOver: { sessions: ['09:30-12:00@America/New_York'] } });
  assert.strictEqual((r.placed || []).length, 1, r.logs.join('\n'));
  assert.deepStrictEqual(r.closed, []);
});

test('the bracket invariant: the plan\'s stop already through the price, or a restore the broker refuses: closed at market at once, an alert', async () => {
  // The 10:00 bar closes at 21485, under the plan's 21490.
  const through = await trailSim({ tape: { 0: [21501, 21484, 21485] }, noStop: true, restore: true, until: et(10, 5), exit: { trail_activate_r: 9, trail_giveback_r: 0.5 } });
  assert.deepStrictEqual(through.placed, undefined);
  assert.strictEqual(through.closed.length, 1);
  assert.ok(through.logs.some(l => /ALERT MNQ long 1: stops cover 0 and the plan's stop 21490 is through the last close 21485; closed at market/.test(l)), through.logs.join('\n'));
  const refused = await trailSim({ tape: {}, noStop: true, restore: true, placeFails: true, until: et(10, 5) });
  assert.strictEqual(refused.closed.length, 1);
  assert.ok(refused.logs.some(l => /its stop could not be restored \(HTTP 503\); closed at market/.test(l)));
  // No plan stop known (no entry record of today): closed, never a guessed stop.
  const unknown = await trailSim({ tape: {}, noStop: true, restore: true, record: { at: new Date(et(10, 0) - 864e5).toISOString() }, until: et(10, 5) });
  assert.strictEqual(unknown.closed.length, 1);
  assert.deepStrictEqual(unknown.placed, undefined);
});

test('the bracket invariant: a fresh fill (its leg may not be listed yet) waits the fill grace; a stop sized over the position is cut; one under it gets the rest', async () => {
  const fresh = await trailSim({ tape: {}, noStop: true, restore: true, fillAt: et(10, 2, 59), startAt: et(10, 3) + 2000, until: et(10, 4) });
  assert.deepStrictEqual([fresh.placed, fresh.closed], [undefined, []]);
  const big = await trailSim({ tape: {}, stopSize: 2, restore: true, until: et(10, 5) });
  assert.deepStrictEqual(big.resized, [[9, 1]]);
  assert.deepStrictEqual([big.placed, big.closed], [undefined, []]);
  // Two stops over the position, neither of its size: closed (they could reverse it).
  const two = await trailSim({ tape: {}, restore: true, stopSize: 2, ordersOver: o => [...o, { id: 11, contractId: 'MNQ', type: 4, side: 1, size: 2, stopPrice: 21480 }], until: et(10, 5) });
  assert.strictEqual(two.closed.length, 1);
});

test('the bracket invariant, faults: a cut the broker refuses closes instead; surplus stops are trimmed to one of its size; a second read that finds it flat (a leg just filled) places nothing; another month is closed', async () => {
  const cut = await trailSim({ tape: {}, stopSize: 2, restore: true, resizeFails: true, until: et(10, 5) });
  assert.strictEqual(cut.closed.length, 1);
  assert.ok(cut.logs.some(l => /could not be cut \(HTTP 400\); closed at market/.test(l)), cut.logs.join('\n'));
  assert.ok(!cut.logs.some(l => /account housekeeping failed/.test(l)), 'never a failing pass every poll');
  // A stop of its size and a duplicate: the duplicate cancelled, the position kept.
  const dup = await trailSim({ tape: {}, restore: true, ordersOver: o => [...o, { id: 11, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 21480 }], until: et(10, 5) });
  assert.deepStrictEqual([dup.closed, dup.cancelled], [[], [11]]);
  assert.ok(dup.events.some(e => e.kind === 'stops_trimmed' && e.kept === 9));
  // The second read finds it flat: no stray stop.
  // From the 10:03 pass (the first past the fill grace), its second read finds it flat.
  const filled = await trailSim({ tape: {}, noStop: true, restore: true, flatOnReread: et(10, 3), until: et(10, 4) });
  assert.deepStrictEqual([filled.placed, filled.closed], [undefined, []]);
  assert.strictEqual((await trailSim({ tape: {}, noStop: true, restore: true, until: et(10, 4) })).placed.length, 1, 'the control: restored on that pass');
  // An unprotected position in another month than the bars: closed (their prices aren't its).
  // (March at 21600 with its plan stop under the front month's 21650 close: a level that reads valid, but isn't its.)
  const other = await trailSim({ tape: {}, base: [21651, 21649, 21650], restore: true, otherMonth: 'MNQ:2027-03', until: et(10, 5) });
  assert.deepStrictEqual([other.placed, other.closedIds], [undefined, ['MNQ:2027-03']]);
});

test('the bracket invariant reads the server\'s bracket role when given, else the order type; absence is never "no bracket"', async () => {
  // A stop leg the server marks { role: "stop" } covers the position whatever its type; no restore.
  const marked = await trailSim({ tape: {}, noStop: true, restore: true, ordersOver: o => [...o, { id: 12, contractId: 'MNQ', type: 99, side: 1, size: 1, stopPrice: 21490, bracket: { role: 'stop' } }], until: et(10, 5) });
  assert.deepStrictEqual([marked.placed, marked.closed], [undefined, []]);
  // No field: the type-4 stop covers it, as before.
  const plain = await trailSim({ tape: {}, restore: true, until: et(10, 5) });
  assert.deepStrictEqual([plain.placed, plain.closed], [undefined, []]);
  // A stop-type order the server marks a target is no stop: restored.
  const target = await trailSim({ tape: {}, noStop: true, restore: true, ordersOver: o => [...o, { id: 13, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 21490, bracket: { role: 'target' } }], until: et(10, 5) });
  assert.strictEqual((target.placed || []).length, 1);
});

test('after the session window: the bracket stop fills, and the leftover target is cancelled on the next bar (housekeeping only, no cycle); the flat account opens nothing', async () => {
  // A short from 11:50 with its stop and a separate target; the session ends 12:00; the stop fills at 12:02.
  const r = await trailSim({ tape: {}, short: true, startAt: et(11, 51) + 2000, fillAt: et(11, 50), flatAt: et(12, 2), until: et(12, 30), cfgOver: { sessions: ['09:30-12:00@America/New_York'] } });
  const tries = (r.cancelTries || []).filter(([id]) => id === 10);
  assert.ok(tries.length === 1 && tries[0][1] >= et(12, 2) && tries[0][1] <= et(12, 3) + 60000, JSON.stringify(r.cancelTries));
  assert.ok(r.cancelled.includes(10));
  assert.ok(!r.limits.some(l => (l[0] === 'trade' || l[0] === 'manage') && l[1] >= et(12, 0) + 30000), 'no cycle after the window');
  // Before the fill nothing is cancelled (the position is still open: its target and stop stay).
  assert.ok(!(r.cancelTries || []).some(([, t]) => t < et(12, 2)));
});

test('after the session window: a cancel the broker refuses is logged and retried on the next bar, never given up', async () => {
  const r = await trailSim({ tape: {}, short: true, startAt: et(11, 51) + 2000, fillAt: et(11, 50), flatAt: et(12, 2), cancelFails: 2, until: et(12, 30), cfgOver: { sessions: ['09:30-12:00@America/New_York'] } });
  const tries = (r.cancelTries || []).filter(([id]) => id === 10).map(([, t]) => t);
  assert.strictEqual(tries.length, 3, JSON.stringify(tries));
  assert.ok(tries[1] - tries[0] >= 120000 && tries[2] - tries[1] >= 120000, 'one try a bar');
  assert.ok(r.cancelled.includes(10));
  assert.strictEqual(r.logs.filter(l => /ERROR .*could not cancel leftover order 10 on a flat MNQ position \(HTTP 503\); the next bar retries/.test(l)).length, 2);
  assert.strictEqual(r.events.filter(e => e.kind === 'leftover_cancel_failed' && e.orderId === 10).length, 2);
});

test('in the session: one leftover cancel that fails never skips the others', async () => {
  const r = await trailSim({ tape: {}, flatAt: et(10, 2), cancelFails: 1, until: et(10, 4) });
  // Order 9 (the filled stop) is gone; the target 10 fails once, and nothing else is left to skip: the pass goes on.
  assert.ok(r.logs.some(l => /could not cancel leftover order 10/.test(l)));
  assert.ok(!r.logs.some(l => /account housekeeping failed/.test(l)), 'the rest of the housekeeping ran');
});

test('kill switch on after the day traded: a position with no stop is closed and its target cancelled at once', async () => {
  const r = await trailSim({ tape: {}, noStop: true, killAfterCycle: true, restore: true, until: et(10, 9) });
  assert.strictEqual(r.closed.length, 1);
  assert.deepStrictEqual(r.cancelled, [10]);
});

test('kill switch on: a stop bigger than the position (it would flip it) counts as unprotected', async () => {
  // On already when the pass reads it: closed, as before (no cycle will come).
  const kill = require('path').join(require('os').tmpdir(), `orf-kill-${process.pid}`);
  require('fs').writeFileSync(kill, 'x');
  try {
    const r = await trailSim({ tape: {}, stopSize: 2, killFile: kill, restore: true, stateIn: { day: '2026-10-07', premarketDone: true, eodDone: false, cycles: 1, lastCycleAt: null }, until: et(10, 9) });
    assert.strictEqual(r.closed.length, 1);
    assert.deepStrictEqual(r.cancelled.sort(), [10, 9]);
    assert.strictEqual(r.resized, undefined, 'not cut and held: closed');
  } finally {
    require('fs').rmSync(kill, { force: true });
  }
  // Turned on after a pass that already cut the stop to the position: protected, so left to its stop.
  const after = await trailSim({ tape: {}, stopSize: 2, killAfterCycle: true, restore: true, until: et(10, 9) });
  assert.deepStrictEqual([after.resized, after.closed], [[[9, 1]], []]);
});

test('kill switch on: an unprotected position in another month of the root is closed too', async () => {
  const r = await trailSim({ tape: {}, otherMonth: 'MNQ:2027-03', killAfterCycle: true, restore: true, until: et(10, 9) });
  assert.deepStrictEqual(r.closedIds, ['MNQ:2027-03']);
  assert.deepStrictEqual(r.cancelled, [], 'the protected Z26 position keeps its orders');
});

test('kill switch on after the day traded: a protected position is left to its stop', async () => {
  const r = await trailSim({ tape: {}, killAfterCycle: true, restore: true, until: et(10, 9) });
  assert.deepStrictEqual([r.closed, r.cancelled], [[], []]);
});

test('fields the broker adds to its bars reach the bars written and scanned untouched', async () => {
  const extra = { x: { y: 0.4, w: { 5: { z: null } } } };
  const r = await trailSim({ tape: {}, barExtra: extra, until: et(10, 4) });
  assert.ok(r.written.length > 0 && r.written.every(bars => bars.every(b => JSON.stringify(b.x) === JSON.stringify(extra.x))));
});

test('a bars file that cannot be written still lets housekeeping protect the position', async () => {
  const r = await trailSim({ tape: { 3: [21501, 21485, 21488] }, noStop: true, writeFails: true, until: et(10, 9) });
  assert.strictEqual(r.closed.length, 1, 'the bar through the planned stop still closes the trade');
  assert.ok(!r.cycles.includes('trade'), 'no cycle without a bars file');
});

test('end of day: a position the end-of-day run left open is closed directly', async () => {
  const r = await trailSim({ tape: {}, until: et(15, 52) });
  assert.ok(r.cycles.includes('eod'));
  assert.deepStrictEqual(r.closedIds, ['MNQ']);
  assert.deepStrictEqual(r.cancelled.sort(), [10, 9]);
});

test('end of day flattens first, even when the agents\' end-of-day run fails', async () => {
  const r = await trailSim({ tape: {}, eodFails: true, until: et(15, 52) });
  assert.ok(r.cycles.includes('eod'));
  assert.deepStrictEqual(r.closedIds, ['MNQ']);
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

/** A fake prop-challenge hook set (prop/live-runner.js) that records its calls. */
function fakeProp({ screen = r => r, summariesFail = false, eodFails = 0, eodError = 'HTTP 503', owners = undefined } = {}) {
  const calls = { snapshots: [], eod: [], eodDays: [], screens: [], summaries: 0 };
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
  const never = fakeProp({ eodFails: Infinity, eodError: '1 position(s) still open (GC)' });
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

test('prop challenge: past the ratchet nothing closes the trade early; the trail manages it', async () => {
  // Bar 10:03 peaks at 21525 (2.5R): past the 2R ratchet. A hook set offering an in-trade decision is never asked.
  const prop = fakeProp();
  let asked = 0;
  prop.position = () => { asked += 1; return 'close'; };
  const h = await trailSim({ tape: { 3: [21525, 21521, 21522] }, prop });
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual(h.closedIds, []);
});

test('prop challenge: when flat, the policy screens setups; a skipped setup starts no cycle', async () => {
  const candidate = [{ name: 'trendy', status: 'active', signal: 'rules', candidate: true, direction: 'long', stopDistance: 10 }];
  const skip = fakeProp({ screen: rs => rs.map(x => ({ ...x, candidate: false })) });
  const a = await trailSim({ tape: {}, startFlat: true, scan: candidate, prop: skip, until: et(10, 10), trigger: 'signal' });
  assert.ok(skip.calls.screens.length >= 1);
  assert.strictEqual(skip.calls.screens[0].info.contractId, 'MNQ');
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
  // The close went first; the stop and target of the contract it just closed are cancelled on the next pass, once it reads flat.
  assert.match(eod, /Account 7 at .*: balance \$50,100; flat; 2 working orders\./, 'the end-of-day run sees the account after the flatten');
  assert.deepStrictEqual(r.cancelled, [9, 10], 'the leftovers are cancelled once the account reads flat');
  // The open position is described once, as a trade (open-trades.js), not listed again in the account line.
  assert.match(r.prompts.find(x => /trade-session/.test(x)), /Account 7 at .*: balance \$50,100; 1 open position \(below\); 2 working orders\. Open trade MNQ long 1 @ 21500 since 10:00 ET, 7 bars closed since \(setup unknown[^)]*\): risk 10 points = 40 ticks, measured to the working stop \(the initial stop is unknown\); working stop 21490 \(-1R\), target 21600 \(\+10R\); now \+0R at 21500/);
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

test('a manage-only bar (the daily cycle cap reached, a position open) is briefed too, unscanned: the file is always the latest bar\'s', async () => {
  const market = fakeMarket({ minutes: 3 });
  const briefed = [];
  const r = await simulate({
    cfg: { timeframe: 3, maxCyclesPerDay: 5, account: '1' }, from: et(10, 0), to: et(11, 0), market, positions: { net: 1, working: 1 },
    deps: { recordBriefing: (item, results, scanError) => briefed.push([item.bar.t, results, scanError]) },
  });
  const manage = r.cycles.filter(c => c.action === 'manage');
  assert.ok(manage.length >= 1);
  const unscanned = briefed.filter(([, results, err]) => results === null && err === 'not scanned this bar');
  assert.ok(unscanned.length >= manage.length, JSON.stringify(briefed.slice(-3)));
  // Each bar is briefed once.
  assert.strictEqual(new Set(briefed.map(([t]) => t)).size, briefed.length);
});

test('every scanned bar records its bar briefing after the scan; a failed briefing is logged and never stops the pass', async () => {
  const recorded = [];
  const scan = [{ name: 'orb', signal: 'rules', status: 'active', candidate: true, direction: 'long', stopDistance: 5 }];
  await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 10), market: fakeMarket({ minutes: 3 }),
    deps: { scanFor: () => scan, recordBriefing: (item, results) => recorded.push([item.symbol, item.bar.t, item.bars.length > 0, results === scan]) },
  });
  assert.ok(recorded.length >= 3 && recorded.every(([s, t, hasBars, sameScan]) => s === 'MNQ' && t && hasBars && sameScan), JSON.stringify(recorded));
  // A failed scan: the briefing gets the scan's own error text.
  const errs = [];
  await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 7), market: fakeMarket({ minutes: 3 }),
    deps: { scanFor: () => { throw new Error('rules engine down'); }, recordBriefing: (item, results, scanError) => errs.push([results, scanError]) },
  });
  assert.ok(errs.length >= 1 && errs.every(([r, e]) => r === null && e === 'rules engine down'), JSON.stringify(errs));
  const logs = [];
  const failed = await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 7), market: fakeMarket({ minutes: 3 }),
    deps: { scanFor: () => scan, recordBriefing: () => { throw new Error('disk full'); }, log: (m, level = 'info') => logs.push(`${level} ${m}`) },
  });
  assert.ok(failed.cycles.length >= 1);
  assert.ok(logs.some(l => /error MNQ: no bar briefing this bar \(disk full\); the roles read the tools themselves/.test(l)), logs.join('\n'));
});

test('an executed cycle\'s history entry reads the order it placed from the journal; a failed journal read keeps the result line only', async () => {
  const base = fakeMarket({ minutes: 3 });
  const market = { client: (c, p) => ({ ...base.client(c, p), async activeContract(symbol) { return { id: symbol, tickSize: 0.25 }; } }) };
  let n = 0;
  let placedAt = null;
  const runCycle = async () => {
    n += 1;
    return { ok: true, timedOut: false, result: n === 1 ? 'CYCLE RESULT: executed - keltner short MNQ' : 'CYCLE RESULT: managed - stop held' };
  };
  // The broker journals the entry during the first cycle (after its bar closed); an older order is not it.
  const journal = () => (placedAt === null ? [] : [
    { ts: new Date(placedAt - 600000).toISOString(), kind: 'order_placed', contractId: 'MNQ', text: 'setup:orb long', data: { request: { side: 'buy', stopLossBracket: { ticks: 40 } }, result: { success: true } } },
    { ts: new Date(placedAt).toISOString(), kind: 'order_placed', contractId: 'MNQ', text: 'setup:keltner short, stop 21510', data: { request: { side: 'sell', stopLossBracket: { ticks: 24 } }, result: { success: true } } },
  ]);
  const r = await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 7), market,
    deps: { runCycle: async (...a) => { if (placedAt === null) placedAt = et(10, 0, 30); return runCycle(...a); }, journalEntries: journal },
  });
  const [first, second] = r.runner.state.history;
  assert.deepStrictEqual([first.action, first.setup, first.side, first.stop, first.symbol, first.tick], ['entered', 'keltner', 'short', 6, 'MNQ', 0.25]);
  assert.deepStrictEqual([second.action, second.setup], ['managed', undefined]);
  // The journal can't be read after the cycle: the bar's facts, but no setup guessed; the runner says so.
  const logs = [];
  const failed = await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 4), market,
    deps: { runCycle: async () => ({ ok: true, timedOut: false, result: 'CYCLE RESULT: executed - orb long' }), journalEntries: () => { throw new Error('journal locked'); }, scanFor: () => [{ name: 'orb', direction: 'long', candidate: true, signal: 'rules', stopDistance: 2 }], log: (m, level = 'info') => logs.push(`${level} ${m}`) },
  });
  const kept = failed.runner.state.history[0];
  assert.deepStrictEqual([kept.action, kept.symbol, kept.setup, kept.details, Number.isFinite(kept.price)], ['entered', 'MNQ', undefined, 'unavailable', true]);
  assert.ok(logs.some(l => /error history: the journal unavailable \(journal locked\); the entry's details unavailable/.test(l)), logs.join('\n'));
});

test('an entered decision follows its real position across cycles: open from the fill with the broker trade\'s R, then closed with the R of its closing fill, or unknown', async () => {
  const base = fakeMarket({ minutes: 3 });
  // Flat until 10:02, a long from 0.5 (stop 0.25 below, 1R = 0.25) until 10:05, then flat.
  const accountAt = c => ({
    positions: c.t >= et(10, 2) && c.t < et(10, 5) ? [{ id: 7, contractId: 'MNQ', type: 1, size: 1, averagePrice: 0.5, creationTimestamp: new Date(et(10, 0, 40)).toISOString() }] : [],
    orders: c.t >= et(10, 2) && c.t < et(10, 5) ? [{ id: 9, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 0.25 }] : [],
  });
  // The broker's fills: the opening buy, and the closing sell at 0.25 (its stop: -1R) at 10:04:30.
  const fills = [
    { id: 1, contractId: 'MNQ', creationTimestamp: new Date(et(10, 0, 40)).toISOString(), price: 0.5, profitAndLoss: null, fees: 0.37, side: 0, size: 1, voided: false, orderId: 11 },
    { id: 2, contractId: 'MNQ', creationTimestamp: new Date(et(10, 4, 30)).toISOString(), price: 0.25, profitAndLoss: -0.5, fees: 0.37, side: 1, size: 1, voided: false, orderId: 12 },
  ];
  const run = async ({ fillsSince = null, prop = null } = {}) => {
    const reads = [];
    const market = { client: (c, p) => ({ ...base.client(c, p), async activeContract(symbol) { return { id: symbol, tickSize: 0.25 }; }, async accountState() { return accountAt(c); }, async accountBalance() { return 100000; }, ...(fillsSince ? { async fillsSince(id, start) { reads.push(start.toISOString()); return fillsSince(c); } } : {}) }) };
    let n = 0;
    const seen = [];
    const r = await simulate({
      cfg: { symbols: ['MNQ'], timeframe: 3, account: '7' }, from: et(10, 0), to: et(10, 10), market,
      deps: {
        runCycle: async (action, prompt) => { n += 1; seen.push(prompt); return { ok: true, timedOut: false, result: n === 1 ? 'CYCLE RESULT: executed - orb long' : 'CYCLE RESULT: managed - held' }; },
        journalEntries: () => [{ ts: new Date(et(10, 0, 30)).toISOString(), kind: 'order_placed', contractId: 'MNQ', text: 'setup:orb long, stop 0.25', data: { request: { side: 'buy', stopLossBracket: { ticks: 1 } }, result: { success: true, orderId: 11 } } }],
        ...(prop ? { prop } : {}),
      },
    });
    return { prompts: seen, reads, entry: r.runner.state.history.find(h => h.action === 'entered') };
  };
  // No fills to read: closed, its outcome unknown (never inferred from the bars, which went through its stop).
  const blind = await run();
  assert.ok(blind.prompts.some(p => /entered orb long @1: orb long; since 0t, open from 0\.5\./.test(p)), blind.prompts.join('\n\n'));
  assert.ok(blind.prompts.some(p => /entered orb long @1: orb long; since 0t, closed, outcome unknown \|/.test(p)), blind.prompts.join('\n\n'));
  assert.deepStrictEqual([blind.entry.trade.state, blind.entry.trade.fill], ['closed', 0.5]);
  // The fills read: its loss, -1R, from the closing fill. Read once a cycle while unresolved, from the decision's time.
  const read = await run({ fillsSince: c => fills.filter(f => Date.parse(f.creationTimestamp) <= c.t) });
  assert.ok(read.prompts.some(p => /entered orb long @1: orb long; since 0t, closed -1R \|/.test(p)), read.prompts.join('\n\n'));
  assert.ok(read.reads.length >= 1 && read.reads.every(s => s === read.entry.at), JSON.stringify(read.reads));
  const resolvedReads = read.reads.length;
  assert.ok(resolvedReads <= read.prompts.length, 'at most one read a cycle');
  // A failed read: outcome unknown, the cycle goes on.
  const failed = await run({ fillsSince: () => { throw new Error('search_trades: 503'); } });
  assert.ok(failed.prompts.some(p => /closed, outcome unknown \|/.test(p)), failed.prompts.join('\n\n'));
  // The prop hooks' read of this pass covers it: reused, no adapter read.
  const propWith = (read) => {
    let clockNow = 0;
    return { snapshot: async now => { clockNow = now.getTime(); }, screen: s => s, endOfDay: async () => {}, recentFills: () => read(clockNow) };
  };
  const upTo = ms => fills.filter(f => Date.parse(f.creationTimestamp) <= ms);
  const reused = await run({ fillsSince: () => { throw new Error('the adapter must not be read'); }, prop: propWith(now => ({ sinceMs: et(9, 30), atMs: now, fills: upTo(now) })) });
  assert.ok(reused.prompts.some(p => /closed -1R \|/.test(p)), reused.prompts.join('\n\n'));
  assert.deepStrictEqual(reused.reads, []);
  // Not reused: a read from an earlier pass (this pass's snapshot skipped it), or one that doesn't reach back to the
  // decision: the adapter is read instead.
  const adapter = c => upTo(c.t);
  const stale = await run({ fillsSince: adapter, prop: propWith(now => ({ sinceMs: et(9, 30), atMs: now - 180000, fills: [] })) });
  assert.ok(stale.reads.length >= 1 && stale.prompts.some(p => /closed -1R \|/.test(p)), stale.prompts.join('\n\n'));
  const short = await run({ fillsSince: adapter, prop: propWith(now => ({ sinceMs: et(10, 4), atMs: now, fills: [] })) });
  assert.ok(short.reads.length >= 1 && short.prompts.some(p => /closed -1R \|/.test(p)), short.prompts.join('\n\n'));
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
  assert.match(p, /MNQ last 10 closed 3m bars \(ET open time, oldest first\): 09:36 O 102 H 103 L 101 C 102\.5 V 12 c-o \+0\.5;/);
  assert.match(p, /Your last \d cycle\(s\), oldest first, ET \(not facts; "since" is from bars closed by now\): .*MNQ 3m no-trade @[\d.]+: reason 1(; since [+-]?\d+t)? \| .*Don't flip-flop/);
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
  // The bar is still recorded (signals and decision log): the gate ties a verdict to the last recorded bar, so the
  // previous bar's verdict can't pass for this one.
  assert.ok(r.scans.length >= 1 && r.scans.every(x => /^account check failed \(HTTP 502\)/.test(x.decision.reason) && x.results === candidate), JSON.stringify(r.scans.map(x => x.decision)));
});

test('a prop account with no active policy: a failed account check leaves plain strategies tradable', async () => {
  const candidate = [{ name: 'trendy', status: 'active', signal: 'rules', candidate: true, direction: 'long', stopDistance: 10 }];
  for (const trigger of ['signal', 'bar']) {
    // owners: no active policy owns anything on this contract (no attempt running, or the policy paper).
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

test('the broker\'s tick specs at the contract lookup: the family\'s other contract is looked up too, and a spec unlike the static table (training) is said once', async () => {
  const clockRef = { t: et(10, 0) };
  const asked = [];
  const logs = [];
  const SPECS = { MNQ: { tickSize: 0.25, tickValue: 2 }, NQ: { tickSize: 0.25, tickValue: 5 }, MES: {} };
  const runner = bareRunner({
    cfg: { timeframe: 3, symbols: ['MNQ', 'MES'] }, clockRef, logs,
    client: { async activeContract(s) { asked.push(s); if (s === 'ES') throw new Error('HTTP 500'); return { id: s, ...SPECS[s] }; }, async closedBars() { return []; } },
  });
  while (clockRef.t < et(10, 30)) { const ms = await runner.step(); clockRef.t += ms; }
  assert.ok(asked.includes('NQ') && asked.includes('ES'), `the partners are looked up (${asked.join(', ')})`);
  const said = logs.filter(m => /^MNQ: the broker's tick spec \(0\.25 = \$2\.00\) differs from the static table .*training does not equal live/.test(m));
  assert.strictEqual(said.length, 1, logs.join('\n'));
  assert.ok(!logs.some(m => /^NQ: the broker's tick spec/.test(m)), 'NQ agrees with the table');
  assert.strictEqual(logs.filter(m => /^MES: the broker's contract has no usable tick specs \(no tick specs from the broker for MES yet/.test(m)).length, 1, logs.join('\n'));
  assert.strictEqual(logs.filter(m => /^ES: contract lookup failed \(HTTP 500\); a prop entry that may size into ES is refused until the broker's tick specs for it are recorded/.test(m)).length, 1, `once a day, however often it is retried: ${logs.join('\n')}`);
  assert.ok(asked.filter(s => s === 'ES').length >= 2, 'retried at the re-checks');
});

test('the partner lookup never holds up the symbol\'s poll, and the step settles it before returning (a one-step replay process never closes the broker under it)', async () => {
  const clockRef = { t: et(10, 0) };
  const events = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const runner = bareRunner({
    cfg: { timeframe: 3 }, clockRef,
    client: {
      async activeContract(s) {
        if (s === 'NQ') { events.push('partner asked'); await gate; events.push('partner answered'); }
        return { id: s, tickSize: 0.25, tickValue: s === 'NQ' ? 5 : 0.5 };
      },
      async closedBars() { events.push('polled'); return []; },
    },
  });
  let done = false;
  const stepping = runner.step().then(() => { done = true; });
  for (let i = 0; i < 20 && !events.includes('polled'); i += 1) await new Promise(r => setImmediate(r));
  assert.ok(events.includes('polled') && !events.includes('partner answered'), `polled while the partner lookup waits: ${events.join(', ')}`);
  assert.strictEqual(done, false, 'the step waits for the lookup it started');
  release();
  await stepping;
  assert.deepStrictEqual(events.slice(-1), ['partner answered']);
});

test('the report cache: valid reports go into the trade prompt and the gate\'s cached roles; each cycle\'s output is recorded; a failure runs every role', async () => {
  const served = [];
  const recorded = [];
  const report = { role: 'trend-momentum-analyst', text: 'Data: bar_briefing m15@x\nBias: long', at: '2026-10-07T14:00:00Z', until: '2026-10-07T14:45:00.000Z' };
  const reportCache = {
    serve: q => { served.push(q); return served.length > 1 ? { roles: [report.role], reports: [report] } : { roles: [], reports: [] }; },
    record: q => recorded.push(q),
  };
  const r = await simulate({ cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 12), market: fakeMarket({ minutes: 3 }), deps: { reportCache } });
  const trade = r.cycles.filter(c => c.action === 'trade');
  assert.ok(trade.length >= 2);
  // The first cycle: nothing cached, every role runs; later ones carry the report and name the role to the gate.
  assert.doesNotMatch(trade[0].prompt, /Cached reports/);
  assert.deepStrictEqual(trade[0].context.cachedRoles, []);
  assert.ok(trade.every(c => c.context.action === 'trade'), 'a trade cycle names itself (the roles it may not launch follow from it)');
  assert.match(trade[1].prompt, /don't launch trend-momentum-analyst this cycle[^]*--- trend-momentum-analyst report/);
  assert.deepStrictEqual(trade[1].context.cachedRoles, [report.role]);
  // Served for this cycle's bar and contract, with the account the prompt was given; recorded after it, with the roles served.
  assert.deepStrictEqual(served[0].symbols.map(s => s.symbol), ['MNQ']);
  assert.strictEqual(served[0].symbols[0].bar, trade[0].context.symbols[0].bar.t);
  assert.strictEqual(recorded.length, trade.length);
  assert.deepStrictEqual(recorded.map(q => q.served), [[], ...trade.slice(1).map(() => [report.role])]);
  assert.ok(recorded.every(q => typeof q.output === 'string'));
  // A cache that can't be read: logged, and the cycle runs every role.
  const logs = [];
  const broken = await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3 }, from: et(10, 0), to: et(10, 7), market: fakeMarket({ minutes: 3 }),
    deps: { reportCache: { serve: () => { throw new Error('bad cache'); }, record: () => {} }, log: (m, level = 'info') => logs.push(`${level} ${m}`) },
  });
  const t = broken.cycles.filter(c => c.action === 'trade');
  assert.ok(t.length >= 1 && t.every(c => !/Cached reports/.test(c.prompt) && c.context.cachedRoles.length === 0));
  assert.ok(logs.some(l => /the report cache: every role runs this cycle.*bad cache/.test(l)), logs.join('\n'));
  // Paper mode lists no roles to launch, so nothing is served or recorded.
  const paper = [];
  await simulate({ cfg: { symbols: ['MNQ'], timeframe: 3, paper: true }, from: et(10, 0), to: et(10, 7), market: fakeMarket({ minutes: 3 }), deps: { reportCache: { serve: q => paper.push(q), record: q => paper.push(q) } } });
  assert.deepStrictEqual(paper, []);
  // Manage-only cycles (the daily cap reached): neither served nor recorded (their risk-manager isn't phase 1).
  const manage = [];
  const m = await simulate({ cfg: { timeframe: 3, maxCyclesPerDay: 2, account: '1' }, from: et(10, 0), to: et(10, 30), market: fakeMarket({ minutes: 3 }), positions: { net: 1, working: 1 }, deps: { reportCache: { serve: q => { manage.push(['serve', q]); return { roles: [], reports: [] }; }, record: q => manage.push(['record', q]) } } });
  const trades = m.cycles.filter(c => c.action === 'trade').length;
  assert.ok(m.cycles.some(c => c.action === 'manage'), 'control: manage-only cycles ran');
  assert.strictEqual(manage.filter(([k]) => k === 'serve').length, trades);
  assert.strictEqual(manage.filter(([k]) => k === 'record').length, trades);
});

test('the trade prompt names today\'s unreviewed entries, from the journal and the account the runner read', async () => {
  const calls = [];
  const r = await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3, account: '1' }, from: et(10, 0), to: et(10, 7), market: fakeMarket({ minutes: 3 }), positions: { net: 0, working: 0 },
    deps: {
      journalEntries: () => [{ ts: new Date(et(9, 45)).toISOString(), kind: 'order_placed', contractId: 'MNQ', text: 'setup:keltner short', data: { result: { success: true } } }],
      unreviewed: (symbols, entries, positions, at, orders) => { calls.push({ symbols, entries: entries.length, positions, orders }); return 'Unreviewed: MNQ: 1 closed entry today with no review.'; },
    },
  });
  const trade = r.cycles.filter(c => c.action === 'trade');
  assert.ok(trade.length >= 1);
  assert.match(trade[0].prompt, /Unreviewed: MNQ: 1 closed entry today with no review\./);
  assert.deepStrictEqual(calls[0].symbols, ['MNQ']);
  assert.strictEqual(calls[0].entries, 1, 'the journal the prompt read');
  // This fake broker reads no account state: the positions are unknown (null), never an empty, flat account.
  assert.strictEqual(calls[0].positions, null);
  assert.ok(Array.isArray(calls[0].orders));
});

test('the Unreviewed line gets the account\'s positions and working orders as the runner read them', async () => {
  const calls = [];
  const order = { id: 9, contractId: 'MNQ', type: 1, side: 1, size: 1, limitPrice: 21400 };
  await simulate({
    cfg: { symbols: ['MNQ'], timeframe: 3, account: '1' }, from: et(10, 0), to: et(10, 7),
    market: fakeMarket({ minutes: 3, accountState: { positions: [], orders: [order] } }), positions: { net: 0, working: 1 },
    deps: { journalEntries: () => [], unreviewed: (symbols, entries, positions, at, orders) => { calls.push({ positions, orders }); return null; } },
  });
  assert.ok(calls.length >= 1);
  assert.deepStrictEqual(calls[0].positions, []);
  assert.deepStrictEqual(calls[0].orders.map(o => o.id), [9], 'the working order reaches it (an entry not filled yet is not "closed")');
});

test('verifiedFlat: true only after a flatten pass read the account and found nothing open or working', async () => {
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', timeframe: 3, account: '7' });
  const clockRef = { t: et(16, 30) }; // the daily break: the runner checks the account once a minute
  let read = 'fail';
  const open = { positions: [{ id: 1, contractId: 'MNQ', type: 1, size: 1, averagePrice: 1 }], orders: [] };
  const working = { positions: [], orders: [{ id: 9, contractId: 'MNQ' }] };
  const runner = createRunner({
    cfg, root: '/r', clock: { now: () => new Date(clockRef.t) },
    client: {
      async accountState() {
        if (read === 'fail') throw new Error('timeout');
        return read === 'open' ? open : read === 'working' ? working : { positions: [], orders: [] };
      },
      async closePosition() {}, async cancelOrder() {},
    },
    runCycle: async () => ({ ok: true }), isKillSwitchOn: () => false, createKillSwitch: () => {},
    loadState: () => null, saveState: () => {}, writeBars: () => null, scanFor: () => [],
  });
  assert.strictEqual(runner.verifiedFlat, false, 'before any flatten pass');
  const pass = async what => { read = what; await runner.step(); clockRef.t += 60000; return runner.verifiedFlat; };
  assert.strictEqual(await pass('fail'), false, 'the account read failed');
  assert.strictEqual(await pass('open'), false, 'a position open (closed this pass, not yet read flat)');
  assert.strictEqual(await pass('working'), false, 'a working order left after the close');
  assert.strictEqual(await pass('flat'), true, 'read empty');
  assert.strictEqual(await pass('fail'), false, 'a later failed read: unknown again');
});

/** A runner whose kill switch and cycles are recorded: { kill: [cycle count when it tripped], runs, events }. */
function outcomeWorld({ outcome = () => ({ ok: true, timedOut: false }), cfg = {} } = {}) {
  const w = { runs: [], kill: [], events: [], logs: [] };
  w.deps = {
    runCycle: async action => { w.runs.push(action); return outcome(w.runs.length, action); },
    isKillSwitchOn: () => w.kill.length > 0,
    createKillSwitch: reason => { w.kill.push({ runs: w.runs.length, reason }); },
    event: e => w.events.push(e),
    log: m => w.logs.push(m),
  };
  w.cfg = { timeframe: 3, ...cfg };
  return w;
}

test('no CYCLE RESULT is a failed cycle: three in a row trip the kill switch; a cycle with its result line does not count', async () => {
  const { cycleOutcome, runResult } = require('../../scripts/lib/autotrader');
  const exit0 = output => { const res = { ok: true, timedOut: false, code: 0, output, stdout: output }; return cycleOutcome(res, { result: runResult(res), intact: true, action: 'trade' }); };
  // A provider error: the harness exits 0 having said nothing the runner can read.
  const silent = outcomeWorld({ outcome: () => exit0('Error: provider returned 500\n') });
  await simulate({ cfg: silent.cfg, from: et(10, 0), to: et(10, 30), market: fakeMarket({ minutes: 3 }), deps: silent.deps });
  assert.deepStrictEqual(silent.kill.map(k => k.runs), [3], 'the kill switch on the third such cycle, not before');
  const good = outcomeWorld({ outcome: () => exit0('CYCLE RESULT: no-trade - nothing fired\n') });
  await simulate({ cfg: good.cfg, from: et(10, 0), to: et(10, 30), market: fakeMarket({ minutes: 3 }), deps: good.deps });
  assert.strictEqual(good.kill.length, 0);
  assert.ok(good.runs.length >= 8);
  // A failed exit (no result either) counts once, not twice: still the third cycle.
  const failed = outcomeWorld({ outcome: () => { const res = { ok: false, timedOut: false, code: 1, output: '', stdout: '' }; return cycleOutcome(res, { result: runResult(res), intact: true, action: 'trade' }); } });
  await simulate({ cfg: failed.cfg, from: et(10, 0), to: et(10, 30), market: fakeMarket({ minutes: 3 }), deps: failed.deps });
  assert.deepStrictEqual(failed.kill.map(k => k.runs), [3]);
});

test('CYCLE RESULT: error is a failed cycle and stays fail-closed: the kill switch after three, then trailing, unprotected-position closes and the end-of-day flatten still run', async () => {
  const { cycleOutcome, runResult } = require('../../scripts/lib/autotrader');
  const error = () => { const res = { ok: true, timedOut: false, code: 0, output: 'CYCLE RESULT: error - the tools failed\n', stdout: 'CYCLE RESULT: error - the tools failed\n' }; return cycleOutcome(res, { result: runResult(res), intact: true, action: 'trade' }); };
  // A bar at 10:30 runs the trade past +2R (high 21525): the trailing manager moves the stop, kill switch or not.
  const r = await trailSim({ tape: { 30: [21525, 21521, 21524] }, outcome: error, realKill: true, until: et(15, 52) });
  assert.strictEqual(r.kills, 1, 'the kill switch, once');
  assert.strictEqual(r.cycles.filter(c => c === 'trade').length, 3, 'no trade cycle after it');
  assert.ok(r.modified.length >= 1, 'the trailing stop still tightened under the kill switch');
  assert.ok(r.cycles.includes('eod'), 'end of day still runs');
  assert.ok(r.closedIds.includes('MNQ'), 'the end-of-day flatten closed the position');
  // Unprotected under the kill switch: closed at once (housekeeping never refuses a risk-reducing action).
  const bare = await trailSim({ tape: {}, noStop: true, outcome: error, realKill: true, until: et(10, 20) });
  assert.strictEqual(bare.kills, 1);
  assert.strictEqual(bare.closed.length, 1);
});

test('end of day without a CYCLE RESULT line is no failed run, live and in replay alike: its cycle_end (what a replay step reports) is ok', async () => {
  const { cycleOutcome, runResult } = require('../../scripts/lib/autotrader');
  const silent = outcomeWorld({ outcome: (n, action) => { const res = { ok: true, timedOut: false, code: 0, output: 'reviewed the day\n', stdout: 'reviewed the day\n' }; return cycleOutcome(res, { result: runResult(res), intact: true, action }); } });
  await simulate({ cfg: silent.cfg, from: et(15, 49), to: et(15, 53), market: fakeMarket({ minutes: 3 }), deps: silent.deps });
  const ends = silent.events.filter(e => e.kind === 'cycle_end' && e.action === 'eod');
  assert.deepStrictEqual(ends.map(e => [e.ok, e.result]), [[true, 'CYCLE RESULT: (none reported)']]);
  assert.ok(silent.events.some(e => e.kind === 'eod' && e.ok === true));
  assert.strictEqual(silent.kill.length, 0);
});

/** A runner with premarket at `pre` (09:00 by default, before a 09:30 session); premarket runs fail while fails(n) says so. */
async function premarketDay(fails, { from = et(9, 0), until = et(9, 40), cfg = { premarketAt: '09:00@America/New_York', sessions: ['09:30-15:50@America/New_York'] } } = {}) {
  const cycles = [];
  const events = [];
  let kill = 0;
  let n = 0;
  const { runner } = await simulate({
    cfg: { timeframe: 3, ...cfg }, from, to: until, market: fakeMarket({ minutes: 3 }), cycleMs: 20000,
    deps: {
      runCycle: async (action, prompt, limits = {}) => {
        if (action === 'premarket') n += 1;
        cycles.push({ action, prompt, context: limits.context || null });
        return action === 'premarket' && fails(n) ? { ok: false, timedOut: false, result: 'CYCLE RESULT: (none reported)' } : { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x' };
      },
      event: e => events.push(e),
      isKillSwitchOn: () => kill > 0, createKillSwitch: () => { kill += 1; },
    },
  });
  const starts = events.filter(e => e.kind === 'cycle_start').map(e => [e.action, e.at.slice(11, 16)]);
  return { cycles, events, starts, kill, runner };
}

test('a failed premarket never trips the kill switch: tried again after 1, 2, 5, then every 10 min, before the session and during it, never alongside a cycle', async () => {
  const r = await premarketDay(() => true, { until: et(11, 0) });
  assert.strictEqual(r.kill, 0, 'premarket failures are no failed runs, however many');
  const pre = r.starts.filter(s => s[0] === 'premarket').map(s => s[1]);
  // 09:00 ET is 13:00Z: 09:00, 09:01, 09:03, 09:08, 09:18, 09:28, then every 10 min while the session trades.
  assert.deepStrictEqual(pre.slice(0, 6), ['13:00', '13:01', '13:03', '13:08', '13:18', '13:28']);
  assert.ok(pre.length >= 13 && pre.length <= 16, `${pre.length} tries by 11:00`);
  const trade = r.cycles.filter(c => c.action === 'trade');
  assert.ok(trade.length >= 25, 'the day trades');
  assert.match(r.starts.find(s => s[0] === 'trade')[1], /^13:3[0-3]$/, 'from the first bar of the session');
  for (const c of trade) {
    assert.match(c.prompt, /premarket plan unavailable \(today's premarket run failed \d+ time\(s\)/);
    assert.ok(c.context.unavailable.some(u => /^premarket plan unavailable/.test(u)), 'the cycle log has it');
  }
  // One run at a time: every cycle ends before the next starts.
  const seq = r.events.filter(e => e.kind === 'cycle_start' || e.kind === 'cycle_end').map(e => e.kind);
  for (let i = 0; i < seq.length; i += 1) assert.strictEqual(seq[i], i % 2 ? 'cycle_end' : 'cycle_start', `overlap at ${i}`);
  assert.deepStrictEqual(r.events.filter(e => e.kind === 'premarket_unavailable').map(e => e.tries), [6]);
  assert.strictEqual(r.events.filter(e => e.kind === 'premarket_recovered').length, 0);
});

test('the default sessions: a premarket that fails at 18:05 leaves the first cycle without a plan; a retry during the session gets it, and the next cycles have it', async () => {
  const r = await premarketDay(n => n === 1, { from: et(18, 0), until: et(18, 30), cfg: { premarketAt: '18:05@America/New_York' } });
  // The first cycle after the failed 18:05 premarket (a bar closing before premarket time traded as always).
  const firstPre = r.cycles.findIndex(c => c.action === 'premarket');
  const trade = r.cycles.slice(firstPre + 1).filter(c => c.action === 'trade');
  assert.match(trade[0].prompt, /premarket plan unavailable/, 'the first cycle: no plan yet');
  const pre = r.starts.filter(s => s[0] === 'premarket').map(s => s[1]);
  assert.deepStrictEqual(pre.length, 2, 'the failure, then one retry that succeeded');
  const recovered = r.events.find(e => e.kind === 'premarket_recovered');
  assert.ok(recovered, 'premarket_recovered logged');
  const after = r.cycles.slice(r.cycles.findIndex(c => c.action === 'premarket' && c.context && c.context.retry) + 1).filter(c => c.action === 'trade');
  assert.ok(after.length >= 3);
  for (const c of after) assert.doesNotMatch(c.prompt, /premarket plan unavailable/, 'the following cycles have the plan');
  assert.deepStrictEqual([r.runner.state.premarketUnavailable, typeof r.runner.state.premarketAvailableAt], [null, 'string']);
  assert.strictEqual(r.kill, 0);
  const seq = r.events.filter(e => e.kind === 'cycle_start' || e.kind === 'cycle_end').map(e => e.kind);
  for (let i = 0; i < seq.length; i += 1) assert.strictEqual(seq[i], i % 2 ? 'cycle_end' : 'cycle_start', `overlap at ${i}`);
});

test('a premarket that succeeds on a later try before the session clears what the failures left: no marker, no prompt line', async () => {
  const r = await premarketDay(n => n <= 2);
  assert.deepStrictEqual(r.starts.filter(s => s[0] === 'premarket').map(s => s[1]), ['13:00', '13:01', '13:03']);
  assert.deepStrictEqual([r.runner.state.premarketDone, r.runner.state.premarketUnavailable, r.runner.state.premarketTries, r.runner.state.premarketRetryAt], [true, null, 0, null]);
  const trade = r.cycles.filter(c => c.action === 'trade');
  assert.ok(trade.length >= 2);
  for (const c of trade) assert.doesNotMatch(c.prompt, /premarket plan unavailable/);
  assert.strictEqual(r.events.filter(e => e.kind === 'premarket_unavailable').length, 0);
});

test('premarket retries stop at end of day', async () => {
  const r = await premarketDay(() => true, { from: et(15, 0), until: et(16, 30), cfg: { premarketAt: '15:00@America/New_York', sessions: ['15:10-15:45@America/New_York'] } });
  const eodAt = r.events.find(e => e.kind === 'cycle_start' && e.action === 'eod').at;
  assert.ok(r.events.filter(e => e.kind === 'cycle_start' && e.action === 'premarket').every(e => e.at < eodAt), 'none at or after end of day');
  assert.strictEqual(r.kill, 0);
});

const PRE_SESSION = { premarketAt: '09:00@America/New_York', sessions: ['09:30-15:50@America/New_York'] };
const premarketFails = action => (action === 'premarket' ? { ok: false, timedOut: false, result: 'CYCLE RESULT: (none reported)' } : { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x' });

test('waiting for a premarket retry never holds up risk-reducing work: an overnight position\'s stop still trails', async () => {
  // Long from 08:00; the 09:09 bar runs it past +2R while the 09:00 premarket keeps failing (retries 09:01, 09:03, 09:08, 09:18).
  const r = await trailSim({
    tape: { [-51]: [21525, 21521, 21524] }, fillAt: et(8, 0), startAt: et(9, 0) + 2000, until: et(9, 29), cfgOver: PRE_SESSION,
    stateIn: { day: '2026-10-07', premarketDone: false, eodDone: false, cycles: 5, lastCycleAt: null }, outcome: premarketFails,
  });
  assert.ok(r.cycles.filter(c => c === 'premarket').length >= 4, 'the premarket is still being retried');
  assert.ok(r.modified.length >= 1, 'the trailing stop moved meanwhile');
  assert.ok(!r.cycles.includes('trade'), 'and no cycle ran before the session');
  assert.strictEqual(r.kills || 0, 0);
});

test('a premarket retry never runs while a position is open', async () => {
  const r = await trailSim({ tape: {}, fillAt: et(8, 0), startAt: et(9, 0) + 2000, until: et(11, 0), cfgOver: PRE_SESSION, outcome: premarketFails });
  const pre = r.limits.filter(l => l[0] === 'premarket').map(l => l[1]);
  assert.strictEqual(pre.length, 6, 'the six tries before the session, none after it while the position is open');
  assert.ok(pre.every(t => t < et(9, 30)));
  assert.ok(r.cycles.filter(c => c === 'trade').length > 10, 'the day trades');
});

test('no premarket retry runs while the kill switch is on', async () => {
  const r = await trailSim({ tape: {}, startFlat: true, startAt: et(9, 0) + 2000, until: et(11, 0), cfgOver: PRE_SESSION, outcome: premarketFails, killWhen: action => action === 'trade' });
  const firstTrade = r.limits.find(l => l[0] === 'trade')[1];
  const pre = r.limits.filter(l => l[0] === 'premarket').map(l => l[1]);
  assert.ok(pre.length >= 6);
  assert.ok(pre.every(t => t < firstTrade), 'none after the kill switch came on');
});

test('a premarket retry is tagged (its failure is no failed run anywhere) and its time limit ends before the next bar\'s poll', async () => {
  const { noDecision, passTap } = require('../../scripts/lib/session/record');
  const r = await premarketDay(() => true, { until: et(11, 0) });
  const ends = r.events.filter(e => e.kind === 'cycle_end' && e.action === 'premarket');
  assert.ok(ends.slice(0, 6).every(e => !e.premarketRetry), 'the tries before the session are premarket runs');
  const retries = ends.filter(e => e.premarketRetry);
  assert.ok(retries.length >= 7, 'the tries during the session are retries');
  const tap = passTap();
  for (const e of retries) tap.event(() => {})(e);
  assert.ok(tap.summary([]).ran.every(x => x.premarketRetry));
  assert.strictEqual(noDecision(tap.summary([]).ran), false);
  const step = 180000;
  const delay = validateConfig({ harness: 'qwen' }).barDelaySeconds * 1000;
  const starts = r.events.filter(e => e.kind === 'cycle_start' && e.premarketRetry);
  assert.strictEqual(starts.length, retries.length);
  for (const e of starts) {
    const t = Date.parse(e.at);
    const nextPoll = Math.floor((t - delay) / step) * step + step + delay;
    assert.ok(t + e.timeoutMs <= nextPoll, `the retry at ${e.at} could run into the next bar (${e.timeoutMs} ms)`);
  }
});

test('a premarket retry outside the session windows gets the premarket\'s whole time limit; in one, it ends before the next bar and is said to be cut short', async () => {
  // Sessions 09:30-10:00 and 11:00-15:50: the hour between is no session (housekeeping only).
  const r = await trailSim({
    tape: {}, startFlat: true, startAt: et(9, 0) + 2000, until: et(12, 0), outcome: premarketFails,
    cfgOver: { premarketAt: '09:00@America/New_York', sessions: ['09:30-10:00@America/New_York', '11:00-15:50@America/New_York'] },
  });
  const full = validateConfig({ harness: 'qwen', timeframe: 3 }).cycleTimeoutMinutes * 60000;
  const retries = r.limits.filter(l => l[0] === 'premarket' && l[1] >= et(9, 30));
  const between = retries.filter(l => l[1] >= et(10, 0) && l[1] < et(11, 0));
  const inside = retries.filter(l => l[1] < et(10, 0) || l[1] >= et(11, 0));
  assert.ok(between.length >= 2 && inside.length >= 2, `${between.length} between, ${inside.length} inside`);
  assert.ok(between.every(l => l[2] === full), 'the whole limit between sessions');
  assert.ok(inside.every(l => l[2] < 180000), 'cut to the next bar in a session');
  const starved = r.events.filter(e => e.kind === 'premarket_retry_starved');
  assert.strictEqual(starved.filter(e => e.how === 'capped').length, inside.length, 'each cut-short retry said');
  assert.ok(starved.every(e => e.timeoutMs < e.fullMs));
  assert.strictEqual(r.runner.state.premarketRetryStarved, starved.length, 'counted for the session record');
});

test('a premarket retry with no time before the next bar is skipped and said, with no account read for it', async () => {
  // 160-second cycles on 3-minute bars: after each trade cycle there is never 30 s left before the next bar.
  const opts = { tape: {}, startFlat: true, startAt: et(9, 0) + 2000, until: et(10, 30), cycleMs: 160000, keepCycleTime: true, cfgOver: PRE_SESSION };
  const skipped = await trailSim({ ...opts, outcome: premarketFails });
  const fine = await trailSim({ ...opts, outcome: a => ({ ok: true, timedOut: false, result: `CYCLE RESULT: no-trade - ${a}` }) });
  assert.ok(!skipped.limits.some(l => l[0] === 'premarket' && l[1] >= et(9, 30)), 'no retry ran');
  const starved = skipped.events.filter(e => e.kind === 'premarket_retry_starved');
  assert.deepStrictEqual(starved.map(e => e.how), ['skipped'], 'said once in the session window, not every bar');
  // Counted once per bar (an hour of 3-minute bars, every one too short after its cycle), not once per pass.
  const n = skipped.runner.state.premarketRetryStarved;
  assert.ok(n >= 15 && n <= 20, `${n} counted`);
  const after = reads => (reads || []).filter(t => t >= et(9, 31)).length;
  assert.strictEqual(after(skipped.accountReads), after(fine.accountReads), 'no account read for a skipped retry');
});

/**
 * A day with premarket at 09:00 and a 09:30 session, on `minutes` bars anchored at `anchor` (their open times are
 * anchor + k bars, as a broker anchors them to its session, not to the epoch). Trade cycles take tradeMs; a
 * premarket retry runs to its whole time limit. Returns the bars each trade cycle was on.
 */
async function retryDay({ minutes, anchor, failPremarket, tradeMs, symbols = ['MNQ'], fails = null, retryFull = true, anchors = {}, noBars = [], preHang = false, until = et(11, 0), premarketAt = '09:00@America/New_York' }) {
  const ref = { t: 0 };
  const step = minutes * 60000;
  const market = {
    client: clockRef => {
      Object.defineProperty(ref, 't', { get: () => clockRef.t, set: v => { clockRef.t = v; }, configurable: true });
      return {
        async activeContract(symbol) { return { id: symbol }; },
        async closedBars(contractId, { limit }) {
          if (noBars.includes(contractId)) return []; // no bar yet: its bar clock knows no close
          const a = anchors[contractId] ?? anchor;
          const k = Math.floor((clockRef.t - 1000 - a) / step) - 1; // the newest bar closed a second ago or more
          return Array.from({ length: Math.min(limit, 5) }, (_, i) => ({ t: new Date(a + (k - 4 + i) * step).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 1 }));
        },
      };
    },
  };
  const trades = [];
  const tradePrompts = [];
  const events = [];
  const pre = [];
  await simulate({
    cfg: { timeframe: minutes, symbols, premarketAt, sessions: ['09:30-15:50@America/New_York'] }, from: et(9, 0), to: until, market,
    deps: {
      event: e => events.push(e),
      runCycle: async (action, prompt, limits = {}) => {
        if (action === 'trade') {
          trades.push(...((limits.context && limits.context.symbols) || []).map(s => `${s.symbol}@${s.bar.t}`));
          tradePrompts.push(prompt);
          ref.t += tradeMs;
          return { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x' };
        }
        const retry = Boolean(limits.context && limits.context.retry);
        pre.push({ at: ref.t, timeoutMs: limits.timeoutMs, retry, symbol: limits.context && limits.context.symbol });
        ref.t += (retry && retryFull) || (!retry && preHang) ? limits.timeoutMs : 20000;
        const failed = fails ? fails(limits.context && limits.context.symbol, retry) : failPremarket;
        return failed ? { ok: false, timedOut: retry, result: 'CYCLE RESULT: (none reported)' } : { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - plan' };
      },
    },
  });
  return { trades, tradePrompts, events, pre };
}

test('a premarket retry never makes a bar go stale: capped to the soonest bar each symbol\'s own clock waits for, skipped when one is already due (200 s cycles on 3-minute bars)', async () => {
  const anchor = Date.UTC(2026, 9, 7);
  const failing = await retryDay({ minutes: 3, anchor, failPremarket: true, tradeMs: 200000 });
  const fine = await retryDay({ minutes: 3, anchor, failPremarket: false, tradeMs: 200000 });
  assert.ok(failing.pre.filter(p => p.retry).length >= 3, 'retries ran');
  assert.deepStrictEqual(failing.trades, fine.trades, 'the same bars got their cycles as with a premarket that worked');
});

test('a premarket retry on 7-minute bars anchored at the session (not the hour) ends before the next bar is due', async () => {
  const anchor = et(9, 30) + 3 * 60000; // 7-minute bars opening at 09:33, 09:40, ... (a broker's own anchor)
  const failing = await retryDay({ minutes: 7, anchor, failPremarket: true, tradeMs: 20000 });
  const fine = await retryDay({ minutes: 7, anchor, failPremarket: false, tradeMs: 20000 });
  const retries = failing.pre.filter(p => p.retry);
  assert.ok(retries.length >= 3, 'retries ran');
  const delay = validateConfig({ harness: 'qwen' }).barDelaySeconds * 1000;
  for (const r of retries) {
    const nextDue = anchor + Math.ceil((r.at - delay - anchor) / 420000) * 420000 + delay;
    assert.ok(r.at + r.timeoutMs <= nextDue, `the retry at ${new Date(r.at).toISOString()} runs into the bar due ${new Date(nextDue).toISOString()}`);
  }
  assert.deepStrictEqual(failing.trades, fine.trades);
});

test('a premarket retry that works for one symbol but fails for another is no recovery', async () => {
  const r = await retryDay({ minutes: 3, anchor: Date.UTC(2026, 9, 7), tradeMs: 20000, symbols: ['MNQ', 'MES'], retryFull: false, fails: (symbol, retry) => !retry || symbol === 'MNQ' });
  const retries = r.pre.filter(p => p.retry);
  assert.ok(retries.some(p => p.symbol === 'MES') && retries.some(p => p.symbol === 'MNQ'));
  assert.strictEqual(r.events.filter(e => e.kind === 'premarket_recovered').length, 0);
});

test('a premarket retry ends before the soonest bar of any symbol, each on its own clock', async () => {
  const base = Date.UTC(2026, 9, 7);
  const anchors = { MNQ: base, MES: base + 90000 }; // MES's 3-minute bars close 90 s after MNQ's
  const r = await retryDay({ minutes: 3, anchor: base, anchors, failPremarket: true, tradeMs: 20000, symbols: ['MNQ', 'MES'], retryFull: false });
  const delay = validateConfig({ harness: 'qwen' }).barDelaySeconds * 1000;
  const retries = r.pre.filter(p => p.retry);
  assert.ok(retries.length >= 3);
  for (const p of retries) {
    const due = Math.min(...Object.values(anchors).map(a => a + Math.ceil((p.at - delay - a) / 180000) * 180000 + delay));
    assert.ok(p.at + p.timeoutMs <= due, `the retry at ${new Date(p.at).toISOString()} runs past ${new Date(due).toISOString()}`);
  }
});

test('a premarket retry is skipped while a symbol has no bar clock yet (before its first bar): its next bar\'s time is unknown', async () => {
  const r = await retryDay({ minutes: 3, anchor: Date.UTC(2026, 9, 7), failPremarket: true, tradeMs: 20000, symbols: ['MNQ', 'MES'], retryFull: false, noBars: ['MES'] });
  assert.ok(r.trades.length >= 10, 'MNQ trades');
  assert.strictEqual(r.pre.filter(p => p.retry).length, 0, 'no retry while MES\'s next bar is unknown');
  const starved = r.events.filter(e => e.kind === 'premarket_retry_starved');
  assert.ok(starved.length >= 1 && starved.every(e => e.how === 'skipped' && e.nextPollAt === 'unknown'));
});

test('a premarket that hangs before the session never costs its first bar: a retry ends before that bar is polled, or isn\'t tried', async () => {
  const anchor = Date.UTC(2026, 9, 7);
  const failing = await retryDay({ minutes: 3, anchor, failPremarket: true, preHang: true, tradeMs: 20000, until: et(10, 30) });
  const fine = await retryDay({ minutes: 3, anchor, failPremarket: false, preHang: true, tradeMs: 20000, until: et(10, 30) });
  const pre = failing.pre.filter(p => !p.retry);
  assert.strictEqual(pre[0].timeoutMs, validateConfig({ harness: 'qwen', timeframe: 3 }).cycleTimeoutMinutes * 60000, 'the first try keeps the premarket\'s limit');
  const firstPoll = et(9, 30) + validateConfig({ harness: 'qwen' }).barDelaySeconds * 1000;
  for (const p of pre) assert.ok(p.at + p.timeoutMs <= firstPoll - 5000, `the try at ${new Date(p.at).toISOString()} runs into the session`);
  assert.deepStrictEqual(failing.trades, fine.trades, 'the same bars as with a premarket that worked');
  const gaveUp = failing.events.filter(e => e.kind === 'premarket_unavailable');
  assert.strictEqual(gaveUp.length, 1);
  assert.ok(Date.parse(gaveUp[0].at) < et(9, 30), 'given up before the session: no try could end in time');
  // The first try of the day keeps the premarket's limit even close to the session (as before retries existed).
  const late = await retryDay({ minutes: 3, anchor, failPremarket: true, preHang: true, tradeMs: 20000, until: et(9, 40), premarketAt: '09:28@America/New_York' });
  assert.strictEqual(late.pre[0].timeoutMs, validateConfig({ harness: 'qwen', timeframe: 3 }).cycleTimeoutMinutes * 60000);
});

test('on 1-minute bars a retry that can\'t fit is said once in the session window, still counted per bar', async () => {
  const r = await retryDay({ minutes: 1, anchor: Date.UTC(2026, 9, 7), failPremarket: true, tradeMs: 50000, until: et(11, 0) });
  const skipped = r.events.filter(e => e.kind === 'premarket_retry_starved' && e.how === 'skipped');
  assert.strictEqual(skipped.length, 1, 'said once, not every bar');
  assert.ok(r.pre.filter(p => p.retry).length === 0, 'no retry fit');
});

test('a premarket retry for a later symbol isn\'t tried when the first one used up the time before the next bar', async () => {
  const r = await retryDay({ minutes: 3, anchor: Date.UTC(2026, 9, 7), failPremarket: true, tradeMs: 20000, symbols: ['MNQ', 'MES'] });
  const retries = r.pre.filter(p => p.retry);
  assert.ok(retries.some(p => p.symbol === 'MNQ'), 'the first symbol\'s retries ran');
  assert.ok(retries.every(p => p.timeoutMs >= 30000), 'never one with under 30 s');
  assert.ok(!retries.some(p => p.symbol === 'MES'), 'the second had no time left');
  assert.strictEqual(r.events.filter(e => e.kind === 'premarket_recovered').length, 0, 'never recovered with a symbol not tried');
});

test('in the session, a premarket still missing is given up at once (the day trades, saying so) and tried again only as a retry that fits before the next bar', async () => {
  const r = await retryDay({ minutes: 3, anchor: Date.UTC(2026, 9, 7), failPremarket: true, tradeMs: 20000, retryFull: false });
  assert.match(r.tradePrompts[0], /premarket plan unavailable/, 'the first cycle of the session already says so');
  assert.match(r.trades[0], /@2026-10-07T13:27:00.000Z$/, 'the session\'s first bar got its cycle');
  const inSessionRuns = r.pre.filter(p => p.at >= et(9, 30));
  assert.ok(inSessionRuns.length >= 3);
  assert.ok(inSessionRuns.every(p => p.retry && p.timeoutMs >= 30000 && p.timeoutMs < 180000), 'only retries, each fitting before the next bar');
  for (const p of r.tradePrompts) assert.match(p, /premarket plan unavailable/, 'the marker kept while every retry fails');
});

test('end of day with no time left after its account read is no failed run: judged by its flatten alone', async () => {
  // End of day at 15:59 ET; the pass at 15:59:22 reads the account in 4.5 s, leaving under 30 s before the close.
  let kills = 0;
  const clockRef = { t: et(15, 59, 22) };
  const runner = createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:59@America/New_York', timeframe: 3, account: '7', maxConsecutiveErrors: 1 }), root: '/r',
    client: {
      async accountState() { clockRef.t += 4500; return { positions: [], orders: [] }; },
      async accountBalance() { return 50000; },
      async closePosition() {}, async cancelOrder() {},
    },
    clock: { now: () => new Date(clockRef.t) }, runCycle: async () => ({ ok: true, timedOut: false, result: 'CYCLE RESULT: flattened - x' }),
    isKillSwitchOn: () => kills > 0, createKillSwitch: () => { kills += 1; }, loadState: () => ({ day: '2026-10-07', premarketDone: true, eodDone: false, cycles: 3, lastCycleAt: null }), saveState: () => {},
    writeBars: () => '/b.json', scanFor: () => [],
  });
  await runner.step();
  assert.strictEqual(kills, 0, 'a flat end of day with no time for its review trips nothing');
  assert.strictEqual(runner.state.eodDone, true);
});

test('a runner that starts in the session with a premarket still failing gives it up at once: its first cycle says so, its retries are retries', async () => {
  const cycles = [];
  await simulate({
    cfg: { timeframe: 3, premarketAt: '09:00@America/New_York', sessions: ['09:30-15:50@America/New_York'] }, from: et(9, 35, 10), to: et(10, 30), market: fakeMarket({ minutes: 3 }),
    deps: {
      // Restarted mid-session (not on a minute: the session's next minute is under a minute away): today's premarket failed twice, its next retry due at 09:45.
      loadState: () => ({ day: '2026-10-07', premarketDone: false, eodDone: false, cycles: 0, lastCycleAt: null, premarketTries: 2, premarketRetryAt: new Date(et(9, 45)).toISOString() }),
      runCycle: async (action, prompt, limits = {}) => {
        cycles.push({ action, prompt, retry: Boolean(limits.context && limits.context.retry), timeoutMs: limits.timeoutMs });
        return action === 'premarket' ? { ok: false, timedOut: false, result: 'CYCLE RESULT: (none reported)' } : { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x' };
      },
    },
  });
  const trade = cycles.filter(c => c.action === 'trade');
  assert.ok(trade.length >= 10);
  for (const c of trade) assert.match(c.prompt, /premarket plan unavailable/);
  const pre = cycles.filter(c => c.action === 'premarket');
  assert.ok(pre.length >= 2 && pre.every(c => c.retry && c.timeoutMs >= 30000 && c.timeoutMs < 180000), 'retries, each with at least 30 s before the next poll');
});

test('in the session a missing premarket is given up on the pass itself, even with a minute to the next poll: that pass\'s cycle says so', async () => {
  const clockRef = { t: et(9, 33, 10) };
  const prompts = [];
  const runner = createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '09:00@America/New_York', eodAt: '15:50@America/New_York', timeframe: 3, sessions: ['09:30-15:50@America/New_York'] }), root: '/r',
    client: fakeMarket({ minutes: 3 }).client(clockRef), clock: { now: () => new Date(clockRef.t) },
    runCycle: async (action, prompt) => { prompts.push([action, prompt]); return { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x' }; },
    isKillSwitchOn: () => false, createKillSwitch: () => {}, saveState: () => {}, writeBars: () => '/b.json', scanFor: () => [],
    loadState: () => ({ day: '2026-10-07', premarketDone: false, eodDone: false, cycles: 0, lastCycleAt: null, premarketTries: 2, premarketRetryAt: new Date(et(9, 45)).toISOString() }),
  });
  await runner.step(); // 09:33:10, 47 s to the next minute's poll
  assert.ok(runner.state.premarketUnavailable, 'given up: the session is open');
  clockRef.t = et(9, 36, 2); // the next bar: 55 s to the next minute's poll
  await runner.step();
  const trade = prompts.filter(p => p[0] === 'trade');
  assert.ok(trade.length >= 1);
  for (const p of trade) assert.match(p[1], /premarket plan unavailable/);
  assert.ok(!prompts.some(p => p[0] === 'premarket'), 'no premarket run in the session but as a retry when due');
});


test('account lock unknown: no new entries from the next pass, full risk management of the account (its trailing, every position flattened at end of day), an alert every pass; held again with the kill switch removed, it trades again without a restart', async () => {
  const fs = require('fs');
  const path = require('path');
  const { holdAccountLock } = require('../../scripts/lib/runner-wiring');
  const lostAt = et(10, 15);
  const backAt = et(11, 0);
  const stop = path.join(require('../helpers').tmpDir(), 'STOP');
  const logs = [];
  const events = [];
  const client = { ensureLock: async () => 'held' };
  const r = await trailSim({
    tape: { 30: [21525, 21521, 21524] }, until: et(15, 52), otherMonth: 'MNQ:2027-03', killFile: stop,
    beforeStep: async t => {
      client.ensureLock = async () => (t >= lostAt && t < backAt ? 'unknown' : 'held');
      if (t >= backAt && fs.existsSync(stop)) fs.rmSync(stop); // the user, once it is sorted out
      await holdAccountLock(client, { killSwitchFile: stop, log: (m, l) => logs.push([t, l, m]), event: e => events.push(e) });
    },
  });
  const during = r.limits.filter(([, t]) => t >= lostAt && t < backAt).map(([a]) => a);
  assert.ok(r.limits.some(([a, t]) => a === 'trade' && t < lostAt), 'trading before');
  assert.ok(!during.includes('trade'), 'no trade cycle while the lock is unknown');
  assert.ok(r.limits.some(([a, t]) => a === 'trade' && t >= backAt), 'held again and the kill switch removed: trading again, no restart');
  assert.ok(r.modified.length >= 1, 'the trailing stop still tightened (10:30 bar)');
  assert.ok(r.closedIds.includes('MNQ') && r.closedIds.includes('MNQ:2027-03'), 'end of day flattens every position, as before the lock');
  const alerts = logs.filter(([, l, m]) => l === 'error' && /^ALERT: the account lock can't be confirmed/.test(m));
  assert.ok(alerts.length >= 3, `an alert every pass (${alerts.length})`);
  assert.ok(alerts.every(([t]) => t >= lostAt && t < backAt));
  assert.deepStrictEqual(events.map(e => e.kind), ['account_lock_unknown'], 'recorded once for the episode');
  assert.ok(!fs.existsSync(stop), 'not re-armed once held');
});

test('holdAccountLock: relinked is logged; taken is logged and recorded, nothing armed; unknown (or a check that fails) re-arms the kill switch every pass; never rejects', async () => {
  const fs = require('fs');
  const path = require('path');
  const { holdAccountLock } = require('../../scripts/lib/runner-wiring');
  const stop = path.join(require('../helpers').tmpDir(), 'STOP');
  const logs = [];
  const events = [];
  const log = (m, l) => logs.push([l || 'info', m]);
  const opts = { killSwitchFile: stop, log, event: e => events.push(e) };
  assert.strictEqual(await holdAccountLock({}, opts), 'none');
  let asked = null;
  assert.strictEqual(await holdAccountLock({ ensureLock: async o => { asked = o; return 'relinked'; } }, { ...opts, stableMs: 0, command: () => 'x' }), 'relinked');
  assert.strictEqual(asked.stableMs, 0);
  assert.match(logs[0][1], /its file had vanished and stayed gone: linked it back/);
  assert.strictEqual(await holdAccountLock({ ensureLock: async () => 'taken' }, opts), 'taken');
  assert.match(logs.at(-1)[1], /held by another runner now .*it manages the account. This runner takes no broker action .* and exits/);
  assert.deepStrictEqual(events.map(e => e.kind), ['account_lock_taken']);
  assert.ok(!fs.existsSync(stop), 'nothing armed: the runner exits');
  assert.strictEqual(await holdAccountLock({ ensureLock: async () => 'taken' }, { ...opts, event: () => { throw new Error('disk'); } }), 'taken', 'a failing record never stops the exit');
  const unknown = { ensureLock: async () => 'unknown' };
  assert.strictEqual(await holdAccountLock(unknown, opts), 'unknown');
  fs.rmSync(stop); // removed while the lock is still unknown
  await holdAccountLock(unknown, opts);
  assert.ok(fs.existsSync(stop), 're-armed');
  fs.writeFileSync(stop, 'another reason\n');
  await holdAccountLock(unknown, opts);
  assert.match(fs.readFileSync(stop, 'utf8'), /^another reason\nALERT: the account lock can't be confirmed/, 'appended to a kill switch already on');
  // The check itself rejecting or throwing, or the kill switch unwritable: unknown, logged, never a rejection.
  for (const ensureLock of [async () => { throw new Error('EIO'); }, () => { throw new Error('EIO'); }]) {
    assert.strictEqual(await holdAccountLock({ ensureLock }, { ...opts, killSwitchFile: path.join(stop, 'nope', 'STOP') }), 'unknown');
  }
  assert.ok(logs.some(([l, m]) => l === 'error' && /the check failed \(EIO\)/.test(m)));
  assert.ok(logs.some(([l, m]) => l === 'error' && /could not write the kill switch/.test(m)));
});

test('a running cycle reads the account for composed expiry only while a composed entry on its symbols may be working', async () => {
  const run = async live => {
    const clockRef = { t: et(10, 0, 2) };
    let inCycle = false;
    let reads = 0;
    const asked = [];
    const base = fakeMarket({ minutes: 3, accountState: { positions: [], orders: [] } }).client(clockRef);
    const runner = createRunner({
      cfg: validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', timeframe: 3, account: '7' }), root: '/r',
      client: { ...base, async accountState() { if (inCycle) reads += 1; return base.accountState(); }, async cancelOrder() {} },
      clock: { now: () => new Date(clockRef.t) },
      runCycle: async action => {
        if (action === 'trade') { inCycle = true; await new Promise(r => setTimeout(r, 200)); inCycle = false; }
        return { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x' };
      },
      isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {}, writeBars: () => '/b.json', scanFor: () => [],
      composed: { due: () => [], stamped: (roots, since) => { asked.push([roots, since]); return live; }, onlyComposed: () => false, unrecorded: () => [], forItem: () => [], byOrder: () => ({}) },
      composedWatchMs: 20,
    });
    await runner.step();
    return { reads, asked };
  };
  const none = await run(false);
  assert.ok(none.asked.length > 0, 'the watch ran');
  assert.strictEqual(none.reads, 0, 'no composed entry stamped: no account read during the cycle');
  assert.deepStrictEqual(none.asked[0], [['MNQ'], et(10, 0, 2)], 'asked for the cycle\'s symbols since its start');
  assert.ok((await run(true)).reads > 0, 'one may be working: the account is read');
});

// Setup-focused practice (runner.js practiced, learning/setup-moments.js): the selector decides which bars run a cycle.
function practiceMarket({ openFrom = null, openTo = null, leftoverAt = null } = {}) {
  const market = fakeMarket({ minutes: 3 });
  const cancelled = [];
  const reads = [];
  return {
    cancelled, reads,
    client: clockRef => ({
      ...market.client(clockRef),
      async accountState() {
        reads.push(clockRef.t);
        const open = openFrom !== null && clockRef.t >= openFrom && clockRef.t < openTo;
        const leftover = leftoverAt !== null && clockRef.t >= leftoverAt && !cancelled.length;
        return { positions: open ? [{ contractId: 'MNQ', type: 1, size: 1 }] : [], orders: leftover ? [{ id: 99, contractId: 'MNQ', type: 4, side: 1, size: 1 }] : [] };
      },
      async accountBalance() { return 100000; },
      async cancelOrder(_acct, id) { cancelled.push({ id, t: clockRef.t }); },
    }),
  };
}

test('practice: only the bars the selector picks run a cycle; every bar is still scanned and logged with its decision', async () => {
  const pm = practiceMarket();
  const logged = [];
  const picked = item => Date.parse(item.bar.t) % (15 * 60000) === 12 * 60000; // the 3m bar that completes each 15m candle
  const { cycles } = await simulate({
    cfg: { timeframe: 3, account: '7', sessions: ['09:30-15:00@America/New_York'] }, from: et(9, 59), to: et(11, 0), market: pm,
    deps: { practiceSelect: (item, open) => (picked(item) ? { run: true, why: 'moment', reason: 'practice: setup moment' } : { run: false, why: 'none', reason: `practice: no setup moment (open ${open})` }), scanLog: r => logged.push(r) },
  });
  const trade = cycles.filter(c => c.action === 'trade');
  assert.ok(trade.length >= 3 && trade.length <= 4, `cycles: ${trade.length}`);
  for (const c of trade) assert.strictEqual(Date.parse(barOpens(c)[0].split('@')[1]) % (15 * 60000), 12 * 60000);
  assert.ok(logged.length >= 19, `every bar logged: ${logged.length}`);
  assert.deepStrictEqual([...new Set(logged.filter(r => !r.decision.run).map(r => r.decision.reason))], ['practice: no setup moment (open false)']);
  assert.ok(logged.filter(r => r.decision.run).every(r => /bar closed; practice: setup moment/.test(r.decision.reason)));
});

test('practice: a held position is managed every bar; the risk work (a leftover order cancelled) runs on skipped bars too', async () => {
  const pm = practiceMarket({ openFrom: et(10, 10), openTo: et(10, 31), leftoverAt: et(10, 40) });
  const seen = [];
  const { cycles } = await simulate({
    cfg: { timeframe: 3, account: '7', sessions: ['09:30-15:00@America/New_York'] }, from: et(9, 59), to: et(11, 0), market: pm,
    deps: { practiceSelect: (item, open) => { seen.push(open); return open ? { run: true, why: 'manage', reason: 'practice: managing' } : { run: false, why: 'none', reason: 'practice: none' }; } },
  });
  const trade = cycles.filter(c => c.action === 'trade');
  // Bars closing 10:12 .. 10:30 while the position is open: every one ran its cycle, no other did.
  const bars = trade.map(c => Date.parse(barOpens(c)[0].split('@')[1]) + 180000);
  assert.ok(bars.length >= 6 && bars.length <= 7, `managed bars: ${bars.length}`);
  for (let i = 1; i < bars.length; i += 1) assert.strictEqual(bars[i] - bars[i - 1], 180000, 'every bar while open');
  assert.ok(bars.every(t => t > et(10, 10) && t <= et(10, 31)));
  // The leftover stop on a flat contract was cancelled on a bar that ran no cycle (housekeeping, before the selector).
  assert.strictEqual(pm.cancelled.length, 1);
  assert.ok(!bars.some(t => Math.abs(t - pm.cancelled[0].t) < 10000), 'on a skipped bar');
  assert.ok(seen.includes(true) && seen.includes(false));
});

test('practice: a failed selector or an unreadable account runs the bar (never hides one)', async () => {
  const pm = practiceMarket();
  const { cycles } = await simulate({
    cfg: { timeframe: 3, account: '7', sessions: ['09:30-15:00@America/New_York'] }, from: et(9, 59), to: et(10, 30), market: pm,
    deps: { practiceSelect: () => { throw new Error('no briefing'); } },
  });
  assert.ok(cycles.filter(c => c.action === 'trade').length >= 9);
  const broken = { client: clockRef => ({ ...pm.client(clockRef), async accountState() { throw new Error('down'); } }) };
  const r = await simulate({
    cfg: { timeframe: 3, account: '7', sessions: ['09:30-15:00@America/New_York'] }, from: et(9, 59), to: et(10, 30), market: broken,
    deps: { practiceSelect: () => ({ run: false, why: 'none', reason: 'none' }) },
  });
  assert.ok(r.cycles.filter(c => c.action === 'trade').length >= 9);
});

test('practice, signal trigger: a held position runs every bar though no bar is a moment (the selector is told it is open)', async () => {
  const pm = practiceMarket({ openFrom: et(10, 10), openTo: et(10, 31) });
  const told = [];
  const { cycles } = await simulate({
    cfg: { timeframe: 3, account: '7', trigger: 'signal', sessions: ['09:30-15:00@America/New_York'] }, from: et(9, 59), to: et(11, 0), market: pm,
    deps: { practiceSelect: (item, open) => { told.push(open); return open ? { run: true, why: 'manage', reason: 'practice: managing' } : { run: false, why: 'none', reason: 'practice: none' }; } },
  });
  const bars = cycles.filter(c => c.action === 'trade' || c.action === 'manage').map(c => Date.parse(barOpens(c)[0].split('@')[1]) + 180000);
  assert.ok(bars.length >= 6 && bars.length <= 7, `managed bars: ${bars.length}`);
  assert.ok(bars.every(t => t > et(10, 10) && t <= et(10, 31)));
  assert.ok(told.includes(true), 'the selector heard the position');
});

test('cycleDataInPrompt: the runner hands a trade cycle its reads\' collector only with the key on (Claude Code); absent, the limits are as before', async () => {
  const run = async extra => {
    const clockRef = { t: et(10, 0) };
    const seen = [];
    const client = { ...fakeMarket({ minutes: 3, accountState: { positions: [], orders: [] } }).client(clockRef), readText: async (tool, args) => { seen.push(['read', tool, args]); return { text: '[]', isError: false }; } };
    const runner = bareRunner({ cfg: { timeframe: 3, harness: 'claude', account: '7', ...extra }, clockRef, client, runCycle: async (action, prompt, limits = {}) => { seen.push(['cycle', action, Object.keys(limits).sort(), limits]); clockRef.t += 20000; return { ok: true, timedOut: false }; } });
    while (clockRef.t < et(10, 7)) { const ms = await runner.step(); clockRef.t += ms; }
    return seen;
  };
  const off = (await run({})).filter(x => x[0] === 'cycle' && x[1] === 'trade');
  assert.ok(off.length >= 1);
  for (const c of off) assert.deepStrictEqual(c[2], ['context', 'timeoutMs'], 'no collector, no other key');
  const onSeen = await run({ cycleDataInPrompt: true });
  const on = onSeen.filter(x => x[0] === 'cycle' && x[1] === 'trade');
  assert.ok(on.length >= 1);
  for (const c of on) assert.deepStrictEqual(c[2], ['context', 'precollect', 'timeoutMs']);
  // The collector reads the cycle's symbols' briefings and the configured account through the runner's broker client.
  const got = await on[0][3].precollect({ FTH_HOME: '/nonexistent-home' });
  assert.deepStrictEqual(got.missing.map(m => [m.tool, m.args]), [['bar_briefing', { symbol: 'MNQ' }]]);
  assert.deepStrictEqual(got.blocks.map(b => [b.tool, b.args, b.text]), [['get_account_snapshot', { accountId: 7 }, '[]'], ['list_open_positions', { accountId: 7 }, '[]'], ['list_open_orders', { accountId: 7 }, '[]']]);
  // Paper mode: the runner's own client isn't under the broker's paper settings, so no account read is made for it.
  const paperSeen = await run({ cycleDataInPrompt: true, paper: true });
  const paper = paperSeen.filter(x => x[0] === 'cycle' && x[1] === 'trade');
  assert.ok(paper.length >= 1);
  const p = await paper[0][3].precollect({ FTH_HOME: '/nonexistent-home' });
  assert.deepStrictEqual(p.blocks, []);
  assert.ok(p.missing.filter(m => m.tool !== 'bar_briefing').every(m => /paper mode/.test(m.why)) && p.missing.length === 4);
  assert.ok(!paperSeen.some(x => x[0] === 'read'), 'no account read made');
});
