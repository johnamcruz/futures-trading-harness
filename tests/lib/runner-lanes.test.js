'use strict';

// The runner with several timeframe lanes (runner.js, lanes.js, lane-cycle.js) under a simulated clock and a fake
// market: one cycle per close time however many lanes close then, each lane's trigger, policy collisions settled by
// priority, the fastest closed lane's budget, and a replay (one fresh runner per decision point, as replay runs
// passes) whose cycles are exactly the live runner's and the replay schedule's.
const test = require('node:test');
const assert = require('node:assert');
const { createRunner } = require('../../scripts/lib/runner');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { decisionPoints } = require('../../scripts/lib/replay/schedule');

const DAY = Date.UTC(2026, 9, 7); // Wednesday; New York = UTC-4
const et = (h, m, s = 0) => DAY + ((h + 4) * 60 + m) * 60000 + s * 1000;
const iso = ms => new Date(ms).toISOString();

// Ten seconds before 10:00: the first poll finds only bars too old to cycle on; the first cycle is 10:00's.
const START = et(9, 59, 50);
const TWO = [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal' }];

/**
 * Bars of any timeframe (the request's `minutes`), each published `publishMs(minutes)` after its close. `positions`:
 * the account's net position and working orders as the runner reads them.
 */
// `missing(minutes, closeMs)`: a bar the broker never publishes (a data gap); `contract(t)`: the front month at t.
function market({ publishMs = () => 1000, positions = { net: 0, working: 0 }, missing = () => false, contract = () => 'MNQ' } = {}) {
  const requests = [];
  return {
    requests,
    positions,
    client: clockRef => ({
      async activeContract() { return { id: contract(clockRef.t), tickSize: 0.25 }; },
      async closedBars(contractId, { minutes, limit }) {
        requests.push(minutes);
        const step = minutes * 60000;
        let lastOpen = Math.floor((clockRef.t - publishMs(minutes)) / step) * step - step;
        while (missing(minutes, lastOpen + step)) lastOpen -= step;
        return Array.from({ length: Math.min(limit, 5) }, (_, k) => {
          const t = lastOpen - (4 - k) * step;
          return { t: iso(t), o: 1, h: 2, l: 0, c: 1, v: 1 };
        });
      },
      async netPosition() { return positions.net; },
      async workingOrders() { return positions.working; },
    }),
  };
}

function runnerFor({ cfg: raw, clockRef, mkt, cycleMs = 20000, cycles, deps = {}, state = { value: null } }) {
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', account: '7', lanes: TWO, ...raw });
  return createRunner({
    cfg,
    root: '/r',
    client: mkt.client(clockRef),
    clock: { now: () => new Date(clockRef.t) },
    runCycle: async (action, prompt, limits = {}) => {
      cycles.push({ action, prompt, context: limits.context || null, start: clockRef.t, timeoutMs: limits.timeoutMs });
      clockRef.t += cycleMs;
      return { ok: true, timedOut: false };
    },
    isKillSwitchOn: () => false,
    createKillSwitch: () => {},
    loadState: () => state.value,
    saveState: s => { state.value = JSON.parse(JSON.stringify(s)); },
    writeBars: sym => `/bars/${sym.symbol}-${sym.minutes}m.json`,
    scanFor: () => [],
    ...deps,
  });
}

async function simulate({ from, to, ...opts }) {
  const clockRef = { t: from };
  const cycles = [];
  const runner = runnerFor({ ...opts, clockRef, cycles });
  let guard = 0;
  while (clockRef.t < to) {
    clockRef.t += await runner.step();
    guard += 1;
    if (guard > 200000) throw new Error('runaway loop');
  }
  return { cycles: cycles.filter(c => c.action === 'trade'), runner };
}

// A cycle's bars as "<symbol> <lane> <bar close>", from the context the cycle log records.
const barsOf = c => c.context.symbols.map(x => `${x.symbol} ${x.lane} ${iso(Date.parse(x.bar.t) + parseInt(x.lane, 10) * 60000)}`);
const closeOf = c => Math.max(...c.context.symbols.map(x => Date.parse(x.bar.t) + parseInt(x.lane, 10) * 60000));

test('lanes on bar triggers: one cycle per close time, the 3m close and that minute\'s 1m close coalesced into one', async () => {
  const mkt = market();
  const { cycles } = await simulate({ cfg: { lanes: [{ timeframe: 3 }, { timeframe: 1 }] }, from: START, to: et(10, 30, 30), mkt });
  // 10:00 .. 10:30: 31 closes, one cycle each.
  assert.strictEqual(cycles.length, 31, cycles.map(c => barsOf(c).join(',')).join('\n'));
  const seen = cycles.flatMap(barsOf);
  assert.strictEqual(new Set(seen).size, seen.length, 'no bar is processed twice');
  for (const c of cycles) {
    const m = new Date(closeOf(c)).getUTCMinutes();
    const want = m % 3 === 0 ? ['3m', '1m'] : ['1m'];
    assert.deepStrictEqual(c.context.lanes, want, iso(closeOf(c)));
    assert.deepStrictEqual(c.context.symbols.map(x => x.lane), want);
    // The prompt names the lanes that closed and each lane's bars file; a symbol's second lane repeats no trend line.
    assert.match(c.prompt, new RegExp(`Lanes closed this cycle: ${want.map(l => `${l} \\(every bar\\)`).join(', ')}; one cycle covers them all`));
    assert.match(c.prompt, /a 1-minute bar just closed .* are in \/bars\/MNQ-1m\.json/);
    if (want.length === 2) {
      assert.match(c.prompt, /a 3-minute bar just closed .* are in \/bars\/MNQ-3m\.json/);
      assert.ok(c.prompt.indexOf('3-minute bar just closed') < c.prompt.indexOf('1-minute bar just closed'), 'the first lane first');
      assert.match(c.prompt, /run the trade-session skill for MNQ on account 7/, 'the symbol once');
    }
    assert.ok(c.start - closeOf(c) <= 6000, `started ${c.start - closeOf(c)} ms after the close`);
  }
});

test('lanes: a lane due at the same close that publishes late holds the cycle a few seconds, never longer', async () => {
  // The 3m bar publishes 6 s after the 1m one: still one cycle with both.
  const late = await simulate({ cfg: { lanes: [{ timeframe: 3 }, { timeframe: 1 }] }, from: START, to: et(10, 15, 30), mkt: market({ publishMs: m => (m === 3 ? 7000 : 1000) }) });
  assert.strictEqual(late.cycles.length, 16);
  for (const c of late.cycles.filter(x => new Date(closeOf(x)).getUTCMinutes() % 3 === 0)) assert.deepStrictEqual(c.context.lanes, ['3m', '1m'], iso(closeOf(c)));
  // 40 s late: past the hold (10 s after the close plus the poll delay), the 1m bar cycles without it.
  const later = await simulate({ cfg: { lanes: [{ timeframe: 3 }, { timeframe: 1 }] }, from: START, to: et(10, 15, 30), mkt: market({ publishMs: m => (m === 3 ? 40000 : 1000) }) });
  const at = later.cycles.find(c => c.context.symbols.some(x => x.lane === '1m' && Date.parse(x.bar.t) === et(10, 5)));
  assert.ok(at.start - et(10, 6) <= 2000 + 10000 + 2000, `held ${at.start - et(10, 6)} ms`);
  assert.deepStrictEqual(at.context.lanes, ['1m']);
});

test('a "signal" lane cycles only on a fire or with something open; no fire and flat is no model call', async () => {
  // The 1m strategy fires on the 1m bars opening at :05 and :10 past (closing :06, :11).
  const scanFor = (symbol, bars, lane) => {
    const last = bars[bars.length - 1];
    const fire = lane && lane.timeframe === 1 && [5, 10].includes(new Date(last.t).getUTCMinutes() % 15);
    return fire ? [{ name: 'quick', signal: 'rules', status: 'active', candidate: true, direction: 'long' }] : [];
  };
  const flat = await simulate({ cfg: {}, from: START, to: et(10, 15, 30), mkt: market(), deps: { scanFor } });
  const lanesAt = flat.cycles.map(c => `${iso(closeOf(c)).slice(11, 16)} ${c.context.lanes.join('+')}`);
  // Every 3m close (bar trigger) and the 1m closes that fired: 10:06 and 10:11 (10:06 shares the 3m close).
  assert.deepStrictEqual(lanesAt, ['14:00 3m', '14:03 3m', '14:06 3m+1m', '14:09 3m', '14:11 1m', '14:12 3m', '14:15 3m']);
  assert.match(flat.cycles[4].prompt, /Lanes closed this cycle: 1m \(on a signal: a strategy fired or a position is open\)/);
  assert.match(flat.cycles[4].prompt, /MNQ fired on this bar .*quick long/);
  // A 1m close at a 3m close that didn't fire: the 3m cycle only (the 1m lane adds nothing to it).
  assert.deepStrictEqual(flat.cycles[0].context.symbols.map(x => x.lane), ['3m']);
  // With a position open, every 1m close cycles.
  const open = await simulate({ cfg: {}, from: START, to: et(10, 15, 30), mkt: market({ positions: { net: 1, working: 1 } }), deps: { scanFor } });
  assert.strictEqual(open.cycles.length, 16);
  assert.ok(open.cycles.every(c => c.context.lanes.includes('1m')));
});

test('lanes: two policies\' entry verdicts in one cycle: the higher priority stands, the other is skipped, recorded for the gate and the labels', async () => {
  const verdict = (strategy, component, now) => ({ at: now.toISOString(), strategy, component, symbol: 'MNQ', contractId: 'MNQ', direction: 'long', action: 'full', maxSize: 2, contract: 'MNQ', stopTicks: 40, bar: null });
  const run = async (priorities, { onlyAt = null } = {}) => {
    const superseded = [];
    const events = [];
    const prop = {
      owners: () => new Map(),
      snapshot: async () => {},
      summaries: () => [],
      supersede: v => superseded.push(v),
      screen: (results, { lane, now }) => {
        const p = lane.timeframe === 3 ? 'pol3' : 'pol1';
        if (onlyAt !== null && lane.timeframe === 1 && new Date(now).getUTCMinutes() % 3 !== onlyAt) return results;
        const v = verdict(p, lane.timeframe === 3 ? 'a3' : 'a1', now);
        return [...results, { name: p, signal: 'policy', status: 'active', candidate: true, direction: 'long', component: v.component, verdict: v }];
      },
    };
    const strategyNamed = n => ({ pol3: { name: 'pol3', timeframe: '3m', priority: priorities.pol3 }, pol1: { name: 'pol1', timeframe: '1m', priority: priorities.pol1 } }[n] || null);
    const r = await simulate({ cfg: {}, from: START, to: et(10, 6, 30), mkt: market(), deps: { prop, strategyNamed, event: e => events.push(e) } });
    return { ...r, superseded, events };
  };
  // No priorities: the 3m policy goes first.
  const none = await run({});
  const shared = none.cycles.filter(c => c.context.lanes.length === 2);
  assert.strictEqual(shared.length, 3);
  for (const c of shared) {
    assert.deepStrictEqual(c.context.skipped.map(s => [s.policy, s.lane, s.skipped, s.by]), [['pol1', '1m', 'lower priority', 'pol3']]);
    assert.match(c.prompt, /MNQ pol3: long setup from a3, verdict full: enter only as setup:pol3/);
    assert.match(c.prompt, /MNQ pol1: the long setup from a1 is skipped \(skipped: lower priority \(pol3 goes first when both have a setup in one cycle\)\); no entry\./);
    assert.deepStrictEqual(c.context.symbols.find(x => x.lane === '1m').verdicts.map(v => v.action), ['skip']);
  }
  // Recorded for the gate (the latest verdict of pol1 is a skip, size 0) and in the event log.
  assert.ok(none.superseded.length === 3 && none.superseded.every(v => v.strategy === 'pol1' && v.action === 'skip' && v.maxSize === 0 && v.skippedBy === 'pol3'));
  assert.strictEqual(none.events.filter(e => e.kind === 'policy_skipped').length, 3);
  // 1m-only cycles: no collision.
  assert.ok(none.cycles.filter(c => c.context.lanes.length === 1 && c.context.lanes[0] === '1m').every(c => c.context.skipped.length === 0));
  // Equal priorities: still the 3m policy. A lower number goes first: the 1m policy at priority 1 over the 3m at 2.
  assert.ok((await run({ pol3: 5, pol1: 5 })).superseded.every(v => v.strategy === 'pol1'));
  const p1 = await run({ pol3: 2, pol1: 1 });
  assert.ok(p1.superseded.length === 3 && p1.superseded.every(v => v.strategy === 'pol3' && v.skippedBy === 'pol1'));
  // Only one priority set: the timeframe rule (3m first).
  assert.ok((await run({ pol1: 1 })).superseded.every(v => v.strategy === 'pol1'));
});

test('lanes: a cycle\'s budget is the fastest closed lane\'s; one lane keeps the runner\'s', async () => {
  // Default cycleTimeoutMinutes with a 3m first lane: 6 min; the 1m lane's own: 3 min.
  const both = await simulate({ cfg: { lanes: [{ timeframe: 3 }, { timeframe: 1 }] }, from: START, to: et(10, 6, 30), mkt: market() });
  for (const c of both.cycles) assert.strictEqual(c.timeoutMs, 3 * 60000, `${c.context.lanes} ${c.timeoutMs}`);
  // A 15m lane beside the 3m one: a 3m-only cycle keeps 6 min, the shared close too (the fastest is 3m).
  const slow = await simulate({ cfg: { lanes: [{ timeframe: 3 }, { timeframe: 15 }] }, from: START, to: et(10, 15, 30), mkt: market() });
  assert.ok(slow.cycles.length === 6 && slow.cycles.every(c => c.timeoutMs === 6 * 60000));
  assert.deepStrictEqual(slow.cycles.at(-1).context.lanes, ['3m', '15m']);
  // An explicit cycleTimeoutMinutes caps every lane; the first lane keeps it whole.
  const capped = await simulate({ cfg: { cycleTimeoutMinutes: 2, lanes: [{ timeframe: 3 }, { timeframe: 1 }] }, from: START, to: et(10, 3, 30), mkt: market() });
  assert.ok(capped.cycles.every(c => c.timeoutMs === 2 * 60000));
  // One lane: the runner's, whatever the lane.
  const one = await simulate({ cfg: { lanes: [{ timeframe: 3 }] }, from: START, to: et(10, 6, 30), mkt: market() });
  assert.ok(one.cycles.length === 3 && one.cycles.every(c => c.timeoutMs === 6 * 60000 && c.context.lanes === undefined));
});

test('replay equals live: a fresh runner per decision point (as replay runs passes) cycles exactly the live runner\'s closes and lanes, at the schedule\'s points', async () => {
  const scanFor = (symbol, bars, lane) => {
    const last = bars[bars.length - 1];
    return lane && lane.timeframe === 1 && new Date(last.t).getUTCMinutes() % 4 === 0 ? [{ name: 'quick', signal: 'rules', status: 'active', candidate: true, direction: 'long' }] : [];
  };
  const raw = { barDelaySeconds: 2, sessions: ['10:00-10:30@America/New_York'] };
  const from = START;
  const to = et(10, 30, 30);
  // Live: the loop, bars published 1 s after the close (before the 2 s poll delay, as a replay's are).
  const live = await simulate({ cfg: raw, from, to, mkt: market(), deps: { scanFor } });
  // The schedule: every 3m and 1m close, coalesced, each point listing its lanes.
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', account: '7', lanes: TWO, ...raw });
  const points = decisionPoints(cfg, { start: new Date(from), end: new Date(to) }).filter(p => p.kind === 'trade');
  assert.strictEqual(points.length, 30, '10:00 .. 10:29 (the 10:30 close is polled at 10:30:02, past the window)');
  for (const p of points) assert.deepStrictEqual(p.lanes, new Date(p.t).getUTCMinutes() % 3 === 0 ? [3, 1] : [1], iso(p.t));
  // Replay: one fresh runner per point, the state saved between them, one pass each.
  const state = { value: null };
  const cycles = [];
  const mkt = market();
  for (const p of points) {
    const clockRef = { t: p.t.getTime() };
    await runnerFor({ cfg: raw, clockRef, mkt, cycles, deps: { scanFor }, state }).step();
  }
  const replay = cycles.filter(c => c.action === 'trade');
  const key = c => `${iso(closeOf(c))} ${c.context.lanes.join('+')}`;
  assert.deepStrictEqual(replay.map(key), live.cycles.map(key));
  // Each replay cycle runs at its point (the close plus the poll delay), and the point lists the lanes it cycled
  // (a signal lane that didn't fire adds no bars, so its lanes are a subset).
  for (const c of replay) {
    const p = points.find(x => x.t.getTime() === c.start);
    assert.ok(p, `a cycle at ${iso(c.start)} off the schedule`);
    assert.ok(c.context.lanes.every(l => p.lanes.includes(parseInt(l, 10))));
  }
  // Without the lanes' saved clocks, a 3m lane would take its last bar for a new one at every 1m point.
  assert.ok(state.value.laneClocks['MNQ|3m'] && state.value.laneClocks['MNQ|1m']);
});

test('one lane is the runner as before: no lane keys in the context, the state or the schedule\'s points', async () => {
  const { cycles, runner } = await simulate({ cfg: { lanes: undefined, timeframe: 3 }, from: START, to: et(10, 6, 30), mkt: market() });
  assert.strictEqual(cycles.length, 3);
  for (const c of cycles) {
    assert.ok(!('lanes' in c.context) && !('skipped' in c.context));
    assert.ok(c.context.symbols.every(x => !('lane' in x)));
    assert.doesNotMatch(c.prompt, /Lanes closed/);
  }
  assert.ok(!runner.state || !('laneClocks' in runner.state));
  assert.deepStrictEqual(Object.keys(runner.symbols[0]).filter(k => ['lane', 'minutes'].includes(k)), []);
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', timeframe: 3 });
  assert.ok(decisionPoints(cfg, { start: new Date(et(10, 0)), end: new Date(et(11, 0)) }).every(p => !('lanes' in p)));
});

test('replay: a lane missing its bar at a shared close never loses the other lane\'s cycle (a one-pass process does not hold)', async () => {
  const raw = { barDelaySeconds: 2, sessions: ['10:00-10:30@America/New_York'], lanes: [{ timeframe: 3 }, { timeframe: 1 }] };
  // The 1m bar closing at 10:06 is a gap in the data.
  const missing = (m, close) => m === 1 && close === et(10, 6);
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', account: '7', ...raw });
  const points = decisionPoints(cfg, { start: new Date(START), end: new Date(et(10, 9, 30)) }).filter(p => p.kind === 'trade');
  const state = { value: null };
  const cycles = [];
  const mkt = market({ missing });
  for (const p of points) {
    const clockRef = { t: p.t.getTime() };
    // As runner-wiring.js wires a replay pass (FTH_REPLAY_NOW): no hold.
    await runnerFor({ cfg: raw, clockRef, mkt, cycles, state, deps: { coalesceHoldMs: 0 } }).step();
  }
  const at = cycles.find(c => closeOf(c) === et(10, 6));
  assert.ok(at, 'the 3m bar closing at 10:06 cycles');
  assert.deepStrictEqual(at.context.lanes, ['3m']);
  // Live holds up to 10 s for the 1m bar, then cycles the 3m one alone: the same cycle.
  const live = await simulate({ cfg: raw, from: START, to: et(10, 9, 30), mkt: market({ missing }) });
  assert.deepStrictEqual(cycles.filter(c => c.action === 'trade').map(c => `${iso(closeOf(c))} ${c.context.lanes}`), live.cycles.map(c => `${iso(closeOf(c))} ${c.context.lanes}`));
  const held = live.cycles.find(c => closeOf(c) === et(10, 6));
  assert.ok(held.start - et(10, 6) >= 10000 && held.start - et(10, 6) <= 2000 + 10000 + 2500, `live held ${held.start - et(10, 6)} ms`);
});

test('lanes: held bars go only into the next pass while the hold lasts; a pass after a long gap drops them', async () => {
  const clockRef = { t: et(10, 2, 50) };
  const cycles = [];
  // The 3m bar publishes 15 s late (past the hold): the 1m bar closing 10:03 is held meanwhile.
  const runner = runnerFor({ cfg: { lanes: [{ timeframe: 3 }, { timeframe: 1 }] }, clockRef, mkt: market({ publishMs: m => (m === 3 ? 15000 : 1000) }), cycles });
  await runner.step(); // learns the clocks (the bars it finds are too old to cycle on)
  clockRef.t = et(10, 3, 3);
  const wait = await runner.step();
  assert.ok(wait > 0 && wait <= 2000, `held: ${wait}`);
  assert.strictEqual(cycles.length, 0);
  // A minute later (end of day, outside hours, a stalled loop): the held 10:03 bar is gone, never cycled late.
  clockRef.t = et(10, 4, 0);
  await runner.step();
  const held1m = c => c.context.symbols.some(x => x.lane === '1m' && Date.parse(x.bar.t) === et(10, 2));
  assert.ok(!cycles.some(held1m), cycles.map(barsOf).join(' | '));
});

test('lanes: a skip the gate can\'t read (supersede fails) makes the cycle manage-only and turns the kill switch on (the gate refuses every entry)', async () => {
  const prop = {
    owners: () => new Map(), snapshot: async () => {}, summaries: () => [],
    supersede: () => { throw new Error('disk full'); },
    screen: (results, { lane, now }) => {
      const p = lane.timeframe === 3 ? 'pol3' : 'pol1';
      const v = { at: now.toISOString(), strategy: p, component: 'c', symbol: 'MNQ', contractId: 'MNQ', direction: 'long', action: 'full', maxSize: 1, contract: 'MNQ', stopTicks: 40 };
      return [...results, { name: p, signal: 'policy', candidate: true, direction: 'long', verdict: v }];
    },
  };
  const strategyNamed = n => ({ name: n, timeframe: n === 'pol3' ? '3m' : '1m' });
  const kills = [];
  const logs = [];
  const { cycles } = await simulate({ cfg: { lanes: [{ timeframe: 3 }, { timeframe: 1 }] }, from: START, to: et(10, 3, 30), mkt: market(), deps: { prop, strategyNamed, log: (m, l) => logs.push([m, l]), createKillSwitch: r => kills.push(r) } });
  // The gate would still read pol1's entry verdict: the kill switch makes it refuse every entry.
  assert.ok(kills.length >= 1 && /pol1's skip for pol3 could not be recorded for the gate \(disk full\)/.test(kills[0]), kills.join('|'));
  const shared = cycles.filter(c => c.context.lanes.length === 2);
  assert.strictEqual(shared.length, 2);
  for (const c of shared) {
    assert.strictEqual(c.context.manageOnly, true);
    assert.match(c.prompt, /manage-only/);
    assert.match(c.prompt, /pol1's skip for pol3 could not be recorded for the gate \(disk full\): this cycle is manage-only, no entry/);
    assert.strictEqual(c.context.skipped[0].unrecorded, 'disk full');
  }
  assert.ok(logs.some(([m, l]) => l === 'error' && /could not record pol1's skip \(disk full\)/.test(m)));
  // 1m-only cycles (no collision) are trade cycles.
  assert.ok(cycles.filter(c => c.context.lanes.length === 1).every(c => c.context.manageOnly === false));
});

test('replay: a lane clock kept on another contract is not restored (a roll since starts over, as live)', async () => {
  const raw = { lanes: [{ timeframe: 3 }, { timeframe: 1 }] };
  const state = { value: null };
  const cycles = [];
  // The front month changes at 10:04.
  const mkt = market({ contract: t => (t >= et(10, 4) ? 'MNQ:2026-12' : 'MNQ') });
  for (const t of [et(10, 3, 2), et(10, 4, 2)]) {
    const clockRef = { t };
    await runnerFor({ cfg: raw, clockRef, mkt, cycles, state }).step();
  }
  assert.strictEqual(state.value.laneClocks['MNQ|3m'].contractId, 'MNQ:2026-12');
  // At 10:04 the 3m clock was kept on the old month: started over, the 3m bar closing 10:03 is new on the new
  // contract (as a live runner that rolled would take it), so the 10:04 pass cycles it with the 1m bar.
  const roll = cycles.find(c => c.start === et(10, 4, 2));
  assert.ok(roll && roll.context.lanes.includes('3m'), roll && roll.context.lanes.join('+'));
});

test('lanes: a 1m-only cycle reuses the cached reports only while the briefing is current: not past their time, not with the 3m bar overdue', async () => {
  // A cache that always offers an analyst report valid until 10:14 (as a briefing part would end at a 15m close
  // between two first-lane bars, e.g. on 2m bars) and phase 1.
  const asked = [];
  const reportCache = {
    serve: ({ symbols, now }) => {
      asked.push({ at: now.getTime(), bar: symbols[0].bar });
      return { roles: ['market-structure-analyst', 'risk-manager'], reports: [{ role: 'market-structure-analyst', text: 'a', at: iso(et(10, 0)), until: iso(et(10, 14)) }, { role: 'risk-manager', text: 'p', at: iso(et(10, 0)), until: null }] };
    },
    record: () => {},
  };
  // The 3m bar closing at 10:15 never arrives; a position is open, so the 1m signal lane cycles every minute.
  const mkt = market({ positions: { net: 1, working: 1 }, missing: (m, close) => m === 3 && close === et(10, 15) });
  const { cycles } = await simulate({ cfg: { harness: 'opencode' }, from: et(10, 10, 50), to: et(10, 17, 30), mkt, deps: { reportCache } });
  const byClose = new Map(cycles.map(c => [iso(closeOf(c)).slice(11, 16), c]));
  const keyAt = hhmm => asked.find(a => Math.abs(a.at - byClose.get(hhmm).start) < 1000).bar;
  // 10:13 (1m only): keyed on the last 3m bar (opened 10:09), the analyst's report served.
  assert.strictEqual(keyAt('14:13'), iso(et(10, 9)));
  assert.deepStrictEqual(byClose.get('14:13').context.cachedRoles, ['market-structure-analyst', 'risk-manager']);
  // 10:14: still keyed on it, but the report is past its time: not served.
  assert.strictEqual(keyAt('14:14'), iso(et(10, 9)));
  assert.deepStrictEqual(byClose.get('14:14').context.cachedRoles, ['risk-manager']);
  // 10:15 on (the 3m bar overdue, even after a resync rearms its clock): keyed on the 1m bar itself, no analyst report.
  for (const hhmm of ['14:15', '14:16', '14:17']) {
    const c = byClose.get(hhmm);
    assert.ok(c, `a cycle at ${hhmm}`);
    assert.notStrictEqual(keyAt(hhmm), iso(et(10, 9)), hhmm);
    assert.deepStrictEqual(c.context.cachedRoles, ['risk-manager'], hhmm);
  }
});

test('lanes: the trailing stop counts only the first lane\'s bars: a 1m bar\'s run-up never moves the stop on its own', async () => {
  // Long 1 from 21500, stop 21490 (1R 10 points), trailing from +2R. The 1m bars run to 21530 (+3R); the 3m bars stay flat.
  const clockRef = { t: START };
  const modified = [];
  const managed = [];
  const closed = [];
  const client = {
    async activeContract() { return { id: 'MNQ', tickSize: 0.25 }; },
    async closedBars(contractId, { minutes, limit }) {
      const step = minutes * 60000;
      const lastOpen = Math.floor((clockRef.t - 1000) / step) * step - step;
      return Array.from({ length: Math.min(limit, 5) }, (_, k) => {
        const t = lastOpen - (4 - k) * step;
        const up = minutes === 1 && t >= et(10, 0);
        return { t: iso(t), o: 21500, h: up ? 21530 : 21501, l: 21499, c: up ? 21529 : 21500, v: 1 };
      });
    },
    async accountState() {
      return { positions: [{ id: 77, contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500, creationTimestamp: iso(et(9, 59, 55)) }], orders: [{ id: 9, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 21490 }] };
    },
    async modifyStop(acct, id, price) { modified.push(price); },
    async closePosition() { closed.push(clockRef.t); },
    async cancelOrder() {},
    async netPosition() { return 1; },
    async workingOrders() { return 1; },
  };
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', account: '7', lanes: [{ timeframe: 3 }, { timeframe: 1 }] });
  const runner = createRunner({
    cfg, root: '/r', client, clock: { now: () => new Date(clockRef.t) }, runCycle: async () => ({ ok: true, timedOut: false }),
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {}, writeBars: () => '/b.json', scanFor: () => [],
    entryOrders: () => [{ orderId: 5, contractId: 'MNQ', setup: 'trendy', side: 'buy', stopTicks: 40, at: iso(et(9, 59, 54)) }],
    strategyNamed: () => ({ name: 'trendy', risk: { stop: 'atr:0.5', min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } }),
    event: e => { if (e.kind === 'position_managed') managed.push(e); },
  });
  while (clockRef.t < et(10, 8)) clockRef.t += await runner.step();
  assert.ok(managed.length >= 1, 'the trade is managed (from the 3m bars)');
  assert.deepStrictEqual(modified, [], 'the 1m bars\' +3R never moved the stop');
  assert.deepStrictEqual(closed, [], 'nor closed the trade through a stop the 1m bars would have trailed');
  // The strategy stops loading while the position is open (its rulebook refused): the exit plan it had still
  // manages the position (exitStrategy, trading/exit-memory.js); without one, the position goes unmanaged.
  const trendy = { name: 'trendy', risk: { stop: 'atr:0.5', min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 }, valid: false, remembered: true };
  for (const [label, exitStrategy, want] of [['remembered', () => trendy, true], ['none', () => null, false]]) {
    clockRef.t = START;
    managed.length = 0;
    const again = createRunner({
      cfg, root: '/r', client, clock: { now: () => new Date(clockRef.t) }, runCycle: async () => ({ ok: true, timedOut: false }),
      isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {}, writeBars: () => '/b.json', scanFor: () => [],
      entryOrders: () => [{ orderId: 5, contractId: 'MNQ', setup: 'trendy', side: 'buy', stopTicks: 40, at: iso(et(9, 59, 54)) }],
      strategyNamed: () => null, exitStrategy,
      event: e => { if (e.kind === 'position_managed') managed.push(e); },
    });
    while (clockRef.t < et(10, 8)) clockRef.t += await again.step();
    assert.strictEqual(managed.length >= 1, want, label);
  }
});

test('lanes: the priority holds across cycles: a lower-priority setup in a later 1m-only cycle never jumps a higher one\'s open verdict', async () => {
  // The verdicts file: what screen and supersede append; openVerdicts reads each policy's latest entry still open.
  const file = [];
  const prop = {
    owners: () => new Map(), snapshot: async () => {}, summaries: () => [],
    supersede: v => file.push(v),
    openVerdicts: now => {
      const latest = new Map(file.map(v => [v.strategy, v]));
      return [...latest.values()].filter(v => v.action !== 'skip' && Date.parse(v.expiresAt) > now.getTime());
    },
    screen: (results, { lane, now, bars }) => {
      const close = Date.parse(bars[bars.length - 1].t) + lane.timeframe * 60000;
      // pol3 has a setup on the 3m bar closing 10:03 only (open for one 3m bar); pol1 on every 1m bar.
      if (lane.timeframe === 3 && close !== et(10, 3)) return results;
      const p = lane.timeframe === 3 ? 'pol3' : 'pol1';
      const v = { at: now.toISOString(), expiresAt: iso(close + lane.timeframe * 60000), strategy: p, component: 'c', symbol: 'MNQ', contractId: 'MNQ', direction: 'long', action: 'full', maxSize: 1, contract: 'MNQ', stopTicks: 40 };
      file.push(v);
      return [...results, { name: p, signal: 'policy', status: 'active', candidate: true, direction: 'long', verdict: v }];
    },
  };
  const strategyNamed = n => ({ name: n, timeframe: n === 'pol3' ? '3m' : '1m' });
  const { cycles } = await simulate({ cfg: {}, from: START, to: et(10, 8, 30), mkt: market(), deps: { prop, strategyNamed } });
  const at = hhmm => cycles.find(c => iso(closeOf(c)).slice(11, 16) === hhmm);
  // 10:03: both in one cycle: pol3 first.
  assert.deepStrictEqual(at('14:03').context.skipped.map(k => [k.policy, k.by]), [['pol1', 'pol3']]);
  // 10:04 and 10:05 (1m only): pol3's 10:03 verdict is still open, so pol1's new setup is skipped again.
  for (const hhmm of ['14:04', '14:05']) {
    assert.deepStrictEqual(at(hhmm).context.skipped.map(k => [k.policy, k.by]), [['pol1', 'pol3']], hhmm);
    assert.match(at(hhmm).prompt, /MNQ pol1: the long setup from c is skipped \(skipped: lower priority \(pol3 goes first/);
  }
  // From 10:06 pol3's verdict has expired: pol1's setup stands.
  for (const hhmm of ['14:07', '14:08']) assert.deepStrictEqual(at(hhmm).context.skipped, [], hhmm);
  // pol1 at priority 1 over pol3 (2): in the shared cycle pol3 is skipped, and later pol1 setups stand.
  file.length = 0;
  const first = await simulate({ cfg: {}, from: START, to: et(10, 5, 30), mkt: market(), deps: { prop, strategyNamed: n => ({ ...strategyNamed(n), priority: n === 'pol1' ? 1 : 2 }) } });
  const f = hhmm => first.cycles.find(c => iso(closeOf(c)).slice(11, 16) === hhmm);
  assert.deepStrictEqual(f('14:03').context.skipped.map(k => [k.policy, k.by]), [['pol3', 'pol1']]);
  assert.deepStrictEqual(f('14:04').context.skipped, []);
});

test('lanes: an earlier open verdict that a higher-priority setup now goes before is skipped too (one open setup at a time)', async () => {
  const file = [];
  const prop = {
    owners: () => new Map(), snapshot: async () => {}, summaries: () => [],
    supersede: v => file.push(v),
    openVerdicts: now => [...new Map(file.map(v => [v.strategy, v])).values()].filter(v => v.action !== 'skip' && Date.parse(v.expiresAt) > now.getTime()),
    screen: (results, { lane, now, bars }) => {
      const close = Date.parse(bars[bars.length - 1].t) + lane.timeframe * 60000;
      // pol1 (1m) has a setup at 10:01 only; pol3 (3m) at 10:03 (pol1's verdict, open until 10:03, is still open at the
      // 10:03 pass only when it lasts: here it is made to last 5 minutes).
      const p = lane.timeframe === 3 ? 'pol3' : 'pol1';
      if ((p === 'pol1' && close !== et(10, 1)) || (p === 'pol3' && close !== et(10, 3))) return results;
      const v = { at: now.toISOString(), expiresAt: iso(close + 5 * 60000), strategy: p, component: 'c', symbol: 'MNQ', contractId: 'MNQ', direction: 'long', action: 'full', maxSize: 1, contract: 'MNQ', stopTicks: 40 };
      file.push(v);
      return [...results, { name: p, signal: 'policy', status: 'active', candidate: true, direction: 'long', verdict: v }];
    },
  };
  const { cycles } = await simulate({ cfg: {}, from: START, to: et(10, 4, 30), mkt: market(), deps: { prop, strategyNamed: n => ({ name: n, timeframe: n === 'pol3' ? '3m' : '1m' }) } });
  const c = cycles.find(x => closeOf(x) === et(10, 3));
  assert.deepStrictEqual(c.context.skipped.map(k => [k.policy, k.by, k.earlier ? 'earlier' : 'this cycle']), [['pol1', 'pol3', 'earlier']]);
  const latestPol1 = file.filter(v => v.strategy === 'pol1').pop();
  assert.deepStrictEqual([latestPol1.action, latestPol1.maxSize, latestPol1.skippedBy], ['skip', 0, 'pol3'], 'recorded for the gate');
});

test('lanes: 3m bars missing from 10:06 on, the report valid until 10:15: at 10:40 no analyst report is served', async () => {
  const asked = [];
  const reportCache = {
    serve: ({ symbols, now }) => {
      asked.push({ at: now.getTime(), bar: symbols[0].bar });
      return { roles: ['market-structure-analyst', 'risk-manager'], reports: [{ role: 'market-structure-analyst', text: 'a', at: iso(et(10, 0)), until: iso(et(10, 15)) }, { role: 'risk-manager', text: 'p', at: iso(et(10, 0)), until: null }] };
    },
    record: () => {},
  };
  const mkt = market({ positions: { net: 1, working: 1 }, missing: (m, close) => m === 3 && close >= et(10, 6) });
  const { cycles } = await simulate({ cfg: { harness: 'opencode' }, from: START, to: et(10, 41, 30), mkt, deps: { reportCache } });
  const c = cycles.find(x => closeOf(x) === et(10, 40));
  assert.ok(c, 'a 1m cycle at 10:40');
  assert.deepStrictEqual(c.context.cachedRoles, ['risk-manager']);
  const key = asked.find(a => Math.abs(a.at - c.start) < 1000).bar;
  assert.notStrictEqual(key, iso(et(10, 0)), 'not keyed on the last 3m bar (opened 10:00)');
});

test('lanes: an open verdict is set aside only by its own policy\'s new entry on the same family; unreadable open verdicts settle the cycle alone', async () => {
  const file = [];
  const logs = [];
  let throwOpen = false;
  const prop = {
    owners: () => new Map(), snapshot: async () => {}, summaries: () => [],
    supersede: v => file.push(v),
    openVerdicts: now => {
      if (throwOpen) throw new Error('journal unreadable');
      return [...new Map(file.map(v => [`${v.strategy}|${v.contract}`, v])).values()].filter(v => v.action !== 'skip' && Date.parse(v.expiresAt) > now.getTime());
    },
    screen: (results, { symbol, lane, now, bars }) => {
      const close = Date.parse(bars[bars.length - 1].t) + lane.timeframe * 60000;
      // pol3: an MNQ entry at 10:03 (open 10 min); at 10:09, in one cycle, a pol3 skip on MES and a pol1 MNQ entry.
      let v = null;
      if (lane.timeframe === 3 && symbol === 'MNQ' && close === et(10, 3)) v = { strategy: 'pol3', contract: 'MNQ', action: 'full', maxSize: 1 };
      if (lane.timeframe === 3 && symbol === 'MES' && close === et(10, 9)) v = { strategy: 'pol3', contract: 'MES', action: 'skip', maxSize: 0 };
      if (lane.timeframe === 1 && symbol === 'MNQ' && close === et(10, 9)) v = { strategy: 'pol1', contract: 'MNQ', action: 'full', maxSize: 1 };
      if (!v) return results;
      v = { ...v, at: now.toISOString(), expiresAt: iso(close + 10 * 60000), component: 'c', symbol, contractId: v.contract, direction: 'long', stopTicks: 40 };
      file.push(v);
      return [...results, { name: v.strategy, signal: 'policy', status: 'active', candidate: v.action !== 'skip', direction: 'long', verdict: v }];
    },
  };
  const strategyNamed = n => ({ name: n, timeframe: n === 'pol3' ? '3m' : '1m' });
  const run = () => simulate({ cfg: { symbols: ['MNQ', 'MES'] }, from: START, to: et(10, 9, 30), mkt: market(), deps: { prop, strategyNamed, log: (m, l) => logs.push([m, l]) } });
  const { cycles } = await run();
  // pol3's MES skip at 10:09 doesn't set aside its open MNQ entry: pol1's 10:09 setup is skipped for it.
  const c = cycles.find(x => closeOf(x) === et(10, 9));
  assert.deepStrictEqual(c.context.skipped.map(k => [k.policy, k.by]), [['pol1', 'pol3']]);
  // The open verdicts can't be read: the cycle's own setups are settled alone (pol1 stands), and it is logged.
  file.length = 0;
  logs.length = 0;
  throwOpen = true;
  const alone = await run();
  assert.deepStrictEqual(alone.cycles.find(x => closeOf(x) === et(10, 9)).context.skipped, []);
  assert.ok(logs.some(([m, l]) => l === 'error' && /open policy verdicts unreadable \(journal unreadable\)/.test(m)));
});

test('lanes, end to end on the real verdict file: the runner settles against prop-state\'s open verdicts, per policy and index family, and the gate reads the skips', async () => {
  const state = require('../../scripts/lib/trading/prop-state');
  const { tmpDir } = require('../helpers');
  // `plan(lane, symbol, close)`: the verdict a policy records on that bar, or null. The prop hooks' recording and
  // reading are the real prop-state ones on a real home (appendVerdict, openEntryVerdicts, latestVerdict).
  const run = async (plan, priorities = {}) => {
    const home = tmpDir();
    const prop = {
      owners: () => new Map(), snapshot: async () => {}, summaries: () => [],
      supersede: v => state.appendVerdict(home, v),
      openVerdicts: now => state.openEntryVerdicts(home, [], now),
      screen: (results, { symbol, lane, now, bars }) => {
        const close = Date.parse(bars[bars.length - 1].t) + lane.timeframe * 60000;
        const p = plan(lane.timeframe, symbol, close);
        if (!p) return results;
        const v = { at: now.toISOString(), expiresAt: iso(close + 10 * 60000), strategy: p.strategy, component: 'c', symbol, contract: symbol, contractId: symbol, direction: 'long', action: p.action, multiplier: p.action === 'skip' ? 0 : 1, maxSize: p.action === 'skip' ? 0 : 1, stopTicks: 40, bar: bars[bars.length - 1].t };
        state.appendVerdict(home, v);
        return [...results, { name: v.strategy, signal: 'policy', status: 'active', candidate: v.action !== 'skip', direction: 'long', verdict: v }];
      },
    };
    const strategyNamed = n => ({ name: n, timeframe: n === 'pol3' ? '3m' : '1m', ...(priorities[n] ? { priority: priorities[n] } : {}) });
    const r = await simulate({ cfg: { symbols: ['MNQ', 'MES'] }, from: START, to: et(10, 7, 30), mkt: market(), deps: { prop, strategyNamed } });
    return { ...r, latest: (n, root) => state.latestVerdict(home, n, root) };
  };
  // A: pol3 (no priority, 3m: first) has an MNQ entry at 10:03 and a skip on MES at 10:06; pol1's MNQ entry at 10:07
  // (1m only) is skipped for pol3's MNQ verdict, still open (the MES skip is another family's latest, not MNQ's).
  const a = await run((tf, sym, close) => {
    if (tf === 3 && sym === 'MNQ' && close === et(10, 3)) return { strategy: 'pol3', action: 'full' };
    if (tf === 3 && sym === 'MES' && close === et(10, 6)) return { strategy: 'pol3', action: 'skip' };
    if (tf === 1 && sym === 'MNQ' && close === et(10, 7)) return { strategy: 'pol1', action: 'full' };
    return null;
  });
  const a7 = a.cycles.find(c => closeOf(c) === et(10, 7));
  assert.deepStrictEqual(a7.context.skipped.map(k => [k.policy, k.symbol, k.by]), [['pol1', 'MNQ', 'pol3']]);
  assert.deepStrictEqual([a.latest('pol1', 'MNQ').action, a.latest('pol1', 'MNQ').skippedBy], ['skip', 'pol3'], 'the gate reads pol1\'s skip');
  assert.strictEqual(a.latest('pol3', 'MNQ').action, 'full', 'pol3\'s MNQ entry stands');
  // B: pol1 at priority 1 over pol3 (2). pol3 has an MNQ entry at 10:03; at 10:06, in one cycle, a pol3 MES entry and
  // a pol1 MNQ entry: pol1 goes first, so both pol3 verdicts are skipped: this cycle's MES one and the open MNQ one
  // (pol3's new MES entry is another family: it doesn't replace its MNQ verdict).
  const b = await run((tf, sym, close) => {
    if (tf === 3 && sym === 'MNQ' && close === et(10, 3)) return { strategy: 'pol3', action: 'full' };
    if (tf === 3 && sym === 'MES' && close === et(10, 6)) return { strategy: 'pol3', action: 'full' };
    if (tf === 1 && sym === 'MNQ' && close === et(10, 6)) return { strategy: 'pol1', action: 'full' };
    return null;
  }, { pol1: 1, pol3: 2 });
  const b6 = b.cycles.find(c => closeOf(c) === et(10, 6));
  assert.deepStrictEqual(b6.context.skipped.map(k => [k.policy, k.symbol, k.by]).sort(), [['pol3', 'MES', 'pol1'], ['pol3', 'MNQ', 'pol1']]);
  assert.strictEqual(b.latest('pol3', 'MNQ').action, 'skip', 'the gate reads pol3\'s open MNQ verdict skipped');
  assert.strictEqual(b.latest('pol3', 'MES').action, 'skip');
  assert.strictEqual(b.latest('pol1', 'MNQ').action, 'full');
});

test('lanes: the prompt\'s decision history: 20 1m cycles never push the 15m decisions out of the 15m prompt; a 1m prompt sees the 15m lane\'s last 3; kept across a restart', async () => {
  const cfg = { lanes: [{ timeframe: 15 }, { timeframe: 1, trigger: 'signal' }], symbols: ['MNQ'] };
  // A position open: the 1m lane cycles every minute. Each cycle's result names its time and lanes.
  const mkt = market({ positions: { net: 1, working: 1 } });
  const state = { value: null };
  const cycles = [];
  const runTo = async (from, to) => {
    const clockRef = { t: from };
    const runner = createRunner({
      cfg: validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', account: '7', ...cfg }),
      root: '/r', client: mkt.client(clockRef), clock: { now: () => new Date(clockRef.t) },
      runCycle: async (action, prompt, limits = {}) => {
        const lanes = (limits.context && limits.context.lanes) || [];
        cycles.push({ prompt, lanes, start: clockRef.t });
        clockRef.t += 20000;
        return { ok: true, timedOut: false, result: `CYCLE RESULT: managed - ${lanes.join('+')} at ${iso(clockRef.t).slice(11, 16)}` };
      },
      isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => state.value, saveState: s => { state.value = JSON.parse(JSON.stringify(s)); },
      writeBars: sym => `/bars/${sym.symbol}-${sym.minutes}m.json`, scanFor: () => [],
    });
    while (clockRef.t < to) clockRef.t += await runner.step();
  };
  await runTo(START, et(10, 20, 30));
  // A restart (a new process, the state from the file): the history is kept, tagged by lane.
  assert.ok(state.value.history.some(h => h.lanes.includes('15m')) && state.value.history.some(h => h.lanes.length === 1 && h.lanes[0] === '1m'));
  await runTo(et(10, 20, 30), et(10, 45, 30));
  const at = hhmm => cycles.find(c => c.start >= Date.parse(`2026-10-07T${hhmm}:00Z`) && c.start < Date.parse(`2026-10-07T${hhmm}:30Z`));
  // The 10:45 cycle (15m + 1m): the 15m decisions of 10:00, 10:15, 10:30 are there, past 40 1m cycles.
  const p45 = at('14:45').prompt;
  for (const t of ['14:00', '14:15', '14:30']) assert.match(p45, new RegExp(`15m\\+1m managed @[\\d.]+: 15m\\+1m at ${t}`), t);
  // A 1m-only cycle: its own lane's last 10, and the 15m lane's last 3.
  const p44 = at('14:44').prompt;
  assert.match(p44, /Your last \d+ cycle\(s\) on the lanes that closed/);
  for (const t of ['14:00', '14:15', '14:30']) assert.match(p44, new RegExp(`managed @[\\d.]+: 15m\\+1m at ${t}`), t);
  assert.doesNotMatch(p44, /: 1m at 14:2\d/, 'older 1m decisions are not shown');
  // Kept in the state: at most 10 per lane, the 15m ones included.
  const kept = state.value.history;
  assert.ok(kept.filter(h => h.lanes.length === 1 && h.lanes[0] === '1m').length <= 10);
  assert.ok(kept.length <= 20, 'never more than 10 a lane');
  assert.strictEqual(kept.filter(h => h.lanes.includes('15m')).length, 4);
});

test('lanes: a 1m-only prompt also shows the last decisions of the lane an open trade was entered on', async () => {
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', account: '7', lanes: [{ timeframe: 3 }, { timeframe: 1, trigger: 'signal' }, { timeframe: 15 }] });
  const clockRef = { t: et(10, 30, 50) };
  const prompts = [];
  // History already holds three 15m decisions; the open trade was entered on a 15m strategy (slowpol).
  const history = [0, 1, 2].map(k => ({ at: iso(et(9, 30 + 15 * k)), symbols: ['MNQ'], result: `CYCLE RESULT: planned - slow ${k}`, lanes: ['15m'] }));
  const state = { day: '2026-10-07', premarketDone: true, eodDone: false, cycles: 3, history };
  const client = {
    ...market({ positions: { net: 1, working: 1 } }).client(clockRef),
    async accountState() { return { positions: [{ id: 7, contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500, creationTimestamp: iso(et(10, 0)) }], orders: [{ id: 9, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 21490 }] }; },
    async accountBalance() { return 50000; },
  };
  const runner = createRunner({
    cfg, root: '/r', client, clock: { now: () => new Date(clockRef.t) },
    runCycle: async (action, prompt, limits = {}) => { prompts.push({ prompt, lanes: limits.context.lanes }); clockRef.t += 20000; return { ok: true, timedOut: false, result: 'CYCLE RESULT: managed - x' }; },
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => state, saveState: () => {}, writeBars: () => '/b.json', scanFor: () => [],
    journalEntries: () => [{ ts: iso(et(9, 59, 50)), kind: 'order_placed', contractId: 'MNQ', text: 'setup:slowpol long, stop 21490', data: { result: { success: true } } }],
    strategyNamed: n => (n === 'slowpol' ? { name: 'slowpol', timeframe: '15m' } : null),
  });
  while (clockRef.t < et(10, 32, 30)) clockRef.t += await runner.step();
  const oneMin = prompts.find(p => p.lanes.length === 1 && p.lanes[0] === '1m');
  assert.ok(oneMin, prompts.map(p => p.lanes.join('+')).join(','));
  // The 15m lane's last 3 (its third is the 10:30 cycle, a 3m and 15m close).
  // Old-format entries (no decision facts) render with what they have.
  for (const k of [1, 2]) assert.match(oneMin.prompt, new RegExp(`MNQ 15m planned: slow ${k}`));
  assert.match(oneMin.prompt, /10:30 MNQ 3m\+15m managed @[\d.]+: x/);
  // A position whose entry the journal doesn't name (no lane known): a 1m-only prompt shows no 15m (not the first lane)
  // decisions.
  const r2 = { t: et(10, 30, 50) };
  const flat = [];
  const runner2 = createRunner({
    cfg, root: '/r', client: { ...market({ positions: { net: 1, working: 1 } }).client(r2), async accountState() { return { positions: [{ id: 7, contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500, creationTimestamp: iso(et(10, 0)) }], orders: [] }; } },
    clock: { now: () => new Date(r2.t) },
    runCycle: async (action, prompt, limits = {}) => { flat.push({ prompt, lanes: limits.context.lanes }); r2.t += 20000; return { ok: true, timedOut: false, result: 'CYCLE RESULT: managed - x' }; },
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => ({ ...state, history: [...history] }), saveState: () => {}, writeBars: () => '/b.json', scanFor: () => [],
    strategyNamed: () => null,
  });
  while (r2.t < et(10, 32, 30)) r2.t += await runner2.step();
  const flat1 = flat.find(p => p.lanes.length === 1 && p.lanes[0] === '1m');
  assert.ok(flat1);
  assert.doesNotMatch(flat1.prompt, /planned: slow/);
});

test('lanes: another lane\'s bar is briefed only for an analyst on that lane\'s timeframe; the context names the briefing\'s bar and, with own timeframes, the cycle\'s start', async () => {
  const run = async analystFrames => {
    const briefed = [];
    const { cycles } = await simulate({ cfg: { lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'bar' }] }, from: START, to: et(10, 4, 30), mkt: market(), deps: { analystFrames, recordBriefing: item => briefed.push(`${item.minutes}m ${item.bar.t}`) } });
    return { briefed, cycles };
  };
  const plain = await run([]);
  assert.ok(plain.briefed.length >= 2 && plain.briefed.every(x => x.startsWith('3m')), plain.briefed.join(','));
  for (const c of plain.cycles) assert.ok(!('cycleAt' in c.context) && !('frames' in c.context));
  const own = await run([{ role: 'market-structure-analyst', minutes: 1, lane: 1 }]);
  assert.ok(own.briefed.some(x => x.startsWith('1m')) && own.briefed.filter(x => x.startsWith('3m')).length === plain.briefed.length, own.briefed.join(','));
  for (const c of own.cycles) {
    assert.strictEqual(c.context.cycleAt, iso(c.start));
    assert.deepStrictEqual(c.context.frames, [{ role: 'market-structure-analyst', timeframe: '1m' }]);
  }
  // A 1m-only cycle's briefing bar is the 3m lane's last (the cycle's roles read that briefing as this cycle's).
  const oneMin = plain.cycles.filter(c => c.context.lanes.join() === '1m');
  assert.ok(oneMin.length >= 1);
  for (const c of oneMin) {
    const m1 = c.context.symbols.find(x => x.lane === '1m');
    assert.notStrictEqual(c.context.cycleBars.MNQ, m1.bar.t);
    const b3 = Date.parse(c.context.cycleBars.MNQ);
    assert.ok(b3 % 180000 === 0 && b3 < Date.parse(m1.bar.t) && b3 + 2 * 180000 > Date.parse(m1.bar.t) + 60000, `the last 3m bar's open: ${c.context.cycleBars.MNQ} for ${m1.bar.t}`);
  }
});

// A lane's bar whose briefing can't be built (runner.js laneBlocked): no entry on that symbol's lane, fail closed. The
// gate's per-timeframe signal record says nothing fired on it; other lanes keep theirs and trade as usual.
const FIRED = [{ name: 's1', signal: 'rules', status: 'active', candidate: true, direction: 'long', stopDistance: 5 }];
const FRAME_1M = [{ role: 'market-structure-analyst', minutes: 1, lane: 1 }];
const failing1m = item => (item.lane > 0 ? { error: 'boom' } : null);
async function blockedRun({ lanes, positions = { net: 0, working: 0 }, briefing = failing1m, publishMs, mkt: mk }) {
  const briefed = [];
  const signals = [];
  const logs = [];
  const events = [];
  const { cycles } = await simulate({
    cfg: { lanes }, from: START, to: et(10, 4, 30), mkt: mk || market({ positions, publishMs }),
    deps: {
      analystFrames: FRAME_1M,
      scanFor: () => FIRED.map(r => ({ ...r })),
      recordBriefing: item => { briefed.push(`${item.minutes}m ${item.bar.t}`); return briefing(item); },
      recordSignals: (item, results) => signals.push({ lane: item.minutes, bar: item.bar.t, names: (results || []).filter(r => r.candidate).map(r => r.name) }),
      log: (m, l) => logs.push([m, l]),
      event: e => events.push(e),
    },
  });
  // What the gate's record lets through, per lane: the bars whose record has the fired setup.
  const allowed = m => signals.filter(s => s.lane === m && s.names.includes('s1')).length;
  return { briefed, signals, logs, events, cycles, allowed };
}
const BAR_LANES = [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'bar' }];
const BLOCKED = /MNQ 1m: the 1m lane's bar briefing can't be built \(boom\): no entry on this bar, only managing what is open/;

test('lanes: a lane\'s bar whose briefing can\'t be built allows no entry on it (fail closed): nothing fired recorded for its timeframe, logged, an event; flat, no cycle for it', async () => {
  const flat = await blockedRun({ lanes: BAR_LANES });
  const m1 = flat.signals.filter(s => s.lane === 1);
  assert.ok(m1.length >= 3 && flat.allowed(1) === 0, JSON.stringify(m1));
  assert.ok(flat.allowed(3) >= 1 && flat.allowed(3) === flat.signals.filter(s => s.lane === 3).length, 'the 3m lane keeps what fired');
  assert.ok(flat.logs.some(([m, l]) => l === 'error' && BLOCKED.test(m)));
  const ev = flat.events.filter(e => e.kind === 'lane_briefing_unavailable');
  assert.strictEqual(ev.length, m1.length);
  assert.deepStrictEqual(Object.keys(ev[0]).sort(), ['at', 'bar', 'kind', 'lane', 'reason', 'symbol']);
  assert.ok(ev.every(e => e.symbol === 'MNQ' && e.lane === '1m' && e.reason === 'boom' && m1.some(s => s.bar === e.bar)));
  // Flat: the 1m bars run no cycle; the 3m bars trade as before.
  assert.ok(flat.cycles.length >= 1 && flat.cycles.every(c => c.context.lanes.join() === '3m' && c.context.manageOnly === false), JSON.stringify(flat.cycles.map(c => c.context.lanes)));
  // A lane briefing that builds: the 1m bars record what fired, and no event.
  const ok = await blockedRun({ lanes: BAR_LANES, briefing: () => null });
  assert.ok(ok.allowed(1) >= 3 && ok.events.every(e => e.kind !== 'lane_briefing_unavailable'));
});

test('lanes: with a position open and the 1m briefing failing, only the 1m lane loses its entries: the 3m lane trades in the same cycle; a 1m-only cycle manages', async () => {
  const open = await blockedRun({ lanes: BAR_LANES, positions: { net: 1, working: 1 } });
  assert.strictEqual(open.allowed(1), 0, '1m entries refused (nothing fired on its record)');
  assert.ok(open.allowed(3) >= 1, '3m entries allowed (its record keeps what fired)');
  const shared = open.cycles.filter(c => c.context.lanes.length === 2);
  assert.ok(shared.length >= 1);
  for (const c of shared) {
    assert.strictEqual(c.context.manageOnly, false, 'the 3m lane trades in the same cycle');
    // The prompt lists the 3m lane's setup, never the blocked 1m lane's.
    assert.match(c.prompt, /MNQ fired on this bar \(scan candidates[^)]*\): s1 long/);
    assert.match(c.prompt, /MNQ 1m: no rules strategy fired on this bar/);
    assert.doesNotMatch(c.prompt, /MNQ 1m fired on this bar/);
    assert.match(c.prompt, /MNQ 1m: the 1m lane's bar briefing can't be built \(boom\): no entry on this bar, only managing what is open \(no MNQ entry on 1m bars this cycle; its other lanes and the other symbols as usual\)/);
  }
  const only1m = open.cycles.filter(c => c.context.lanes.join() === '1m');
  assert.ok(only1m.length >= 1 && only1m.every(c => c.context.manageOnly === true), 'a cycle of only blocked bars manages');
  assert.ok(open.cycles.filter(c => c.context.lanes.join() === '3m').every(c => c.context.manageOnly === false));
});

test('lanes: a "signal" lane (the 1m setup) with its briefing failing records nothing fired and runs no cycle when flat; when the account check fails it still manages, never records the fire', async () => {
  const SIGNAL = [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal' }];
  const flat = await blockedRun({ lanes: SIGNAL });
  assert.ok(flat.signals.filter(s => s.lane === 1).length >= 3 && flat.allowed(1) === 0, JSON.stringify(flat.signals));
  assert.ok(flat.cycles.every(c => c.context.lanes.join() === '3m'), 'a fire on a blocked bar is no cycle when flat');
  assert.ok(flat.logs.some(([m, l]) => l === 'error' && BLOCKED.test(m)));
  // Built: the same fires are recorded and cycle (the check above has teeth).
  const ok = await blockedRun({ lanes: SIGNAL, briefing: () => null });
  assert.ok(ok.allowed(1) >= 3 && ok.cycles.some(c => c.context.lanes.includes('1m')));
  // The account can't be read: the bar is still never recorded as fired, and its cycle runs to manage anything open.
  const down = market();
  const base = down.client;
  down.client = ref => ({ ...base(ref), async netPosition() { throw new Error('account down'); } });
  const blind = await blockedRun({ lanes: SIGNAL, mkt: down });
  assert.ok(blind.signals.filter(s => s.lane === 1).length >= 3 && blind.allowed(1) === 0, JSON.stringify(blind.signals));
  const managed = blind.cycles.filter(c => c.context.lanes.join() === '1m');
  assert.ok(managed.length >= 1 && managed.every(c => c.context.manageOnly === true));
  assert.ok(blind.logs.some(([m]) => /cycle \(manage only: account check failed \(account down\); the 1m lane's bar briefing can't be built \(boom\)/.test(m)), blind.logs.map(([m]) => m).join('\n'));
});

test('lanes: the first lane\'s bar is decided and briefed before another lane\'s at the same close, also when that one was published first and held', async () => {
  let pairs = 0;
  for (const publishMs of [undefined, m => (m === 3 ? 7000 : 1000)]) {
    const { briefed } = await blockedRun({ lanes: BAR_LANES, briefing: () => null, publishMs });
    for (const b of briefed.filter(x => x.startsWith('1m'))) {
      const close = Date.parse(b.slice(3)) + 60000;
      const k = briefed.findIndex(x => x.startsWith('3m') && Date.parse(x.slice(3)) + 180000 === close);
      if (k >= 0) { pairs += 1; assert.ok(k < briefed.indexOf(b), briefed.join(',')); }
    }
  }
  assert.ok(pairs >= 2);
});

test('lanes, through the real briefing recorder (runner-wiring.js): a lane frame that can\'t be built returns { error }, and the runner allows no entry on that lane', async () => {
  const fs = require('fs');
  const path = require('path');
  const { tmpDir } = require('../helpers');
  const { briefingRecorder } = require('../../scripts/lib/runner-wiring');
  const home = tmpDir();
  try {
    const cfg = validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', account: '7', lanes: BAR_LANES });
    const env = { FTH_HOME: home, FTH_BLACKOUTS_FILE: path.join(home, 'none.json') };
    const logs = [];
    const recorder = briefingRecorder(home, cfg, () => new Date(et(10, 1, 2)), env, { frames: FRAME_1M, log: (m, l) => logs.push([m, l]) });
    // No runner briefing on disk: the 1m lane's frame can't be built, and the recorder says so.
    const bars = Array.from({ length: 5 }, (_, k) => ({ t: iso(et(9, 56 + k)), o: 1, h: 2, l: 0, c: 1, v: 1 }));
    const r = recorder({ symbol: 'MNQ', contractId: 'MNQ', lane: 1, minutes: 1, bars, bar: { t: bars.at(-1).t } }, FIRED, null);
    assert.ok(r && /no runner bar briefing to share with the 1m one/.test(r.error), JSON.stringify(r));
    assert.ok(logs.some(([m, l]) => l === 'error' && /no 1m bar briefing this bar/.test(m)));
    // A lane the analysts aren't on: nothing to build, no error.
    assert.strictEqual(recorder({ symbol: 'MNQ', contractId: 'MNQ', lane: 1, minutes: 5, bars, bar: { t: bars.at(-1).t } }, FIRED, null), null);
    // The runner on the real recorder, its own briefing never written (as when its build fails): every 1m bar's frame
    // fails, so its record says nothing fired (the gate refuses); the 3m bars' keep theirs.
    const run = await blockedRun({ lanes: BAR_LANES, briefing: item => (item.lane > 0 ? recorder(item, FIRED, null) : null) });
    assert.ok(run.signals.filter(s => s.lane === 1).length >= 3 && run.allowed(1) === 0, JSON.stringify(run.signals));
    assert.ok(run.allowed(3) >= 1);
    assert.ok(run.events.some(e => e.kind === 'lane_briefing_unavailable' && e.lane === '1m' && /no runner bar briefing to share with the 1m one/.test(e.reason)));
    // With the runner's briefing written by the same recorder, the 1m frames build and the 1m bars record what fired.
    const built = await blockedRun({ lanes: BAR_LANES, briefing: item => recorder(item, FIRED, null) });
    assert.ok(built.allowed(1) >= 3 && built.events.every(e => e.kind !== 'lane_briefing_unavailable'), JSON.stringify(built.events.filter(e => e.kind === 'lane_briefing_unavailable')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('lanes: a blocked lane with only working orders (no position) still runs its cycle, manage-only', async () => {
  const working = await blockedRun({ lanes: BAR_LANES, positions: { net: 0, working: 1 } });
  assert.strictEqual(working.allowed(1), 0);
  const only1m = working.cycles.filter(c => c.context.lanes.join() === '1m');
  assert.ok(only1m.length >= 1 && only1m.every(c => c.context.manageOnly === true), JSON.stringify(working.cycles.map(c => c.context.lanes)));
  assert.ok(working.logs.some(([m]) => /MNQ 1m bar .*: cycle \(manage only: the 1m lane's bar briefing can't be built \(boom\)/.test(m)));
});
