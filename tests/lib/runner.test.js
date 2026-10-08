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
  const { cycles } = await simulate({ cfg: { timeframe: 3 }, from: et(9, 30), to: et(15, 0), market });
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
  const { cycles } = await simulate({ cfg: { timeframe: 3, sessions: ['00:00-24:00@America/New_York'], weekdaysOnly: false, eodAt: '' }, from: et(11, 0), to: et(11, 0) + 26 * 3600000, market });
  const trade = cycles.filter(c => c.action === 'trade');
  assert.ok(trade.some(c => /H27/.test(c.prompt)), 'trades the new contract after the roll');
  assert.ok(trade.filter(c => c.start > et(12, 0) && c.start < et(18, 0) + 3600000).length >= 1, 'resyncs re-resolve the contract within the day too');
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

test('a session that runs past end of day is rejected', () => {
  assert.throws(() => validateConfig({ sessions: ['18:00-16:00@America/New_York'], eodAt: '15:50@America/New_York' }), /past eodAt/);
  assert.ok(validateConfig({ sessions: ['09:35-15:00@America/New_York'] }));
});
