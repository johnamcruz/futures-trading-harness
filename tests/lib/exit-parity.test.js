'use strict';

// Cross-caller parity of the policy's exit (exit mode target_then_trail with the early lock): the same bar path through
// the four places that apply exit-trail.js afterTargetStep (the live runner, the backtester's broker, the attempt
// simulator's exitAs, the experience log's bracketExit) gives the same stops and the same exit. Hand vectors cover the
// lock bar (the stop rests above its close; closes through it), a gap through a resting stop, a bar touching both the
// stop and the target, the activation bar, a swing on the wrong side; seeded random paths with 15m swings cover the rest.
// The runner never fills a stop itself: the fake broker here fills a resting stop the way the three simulators do (at
// the stop, or a worse open, less one tick) and the runner's market close at the bar's close, so what is compared is
// the runner's own decisions: every stop it moves and every bar it closes on.

const test = require('node:test');
const assert = require('node:assert');
const { createRunner } = require('../../scripts/lib/runner');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { createSimBroker } = require('../../scripts/lib/backtest/sim-broker');
const { exitAs } = require('../../scripts/lib/prop/attempts');
const { bracketExit, swingsFor } = require('../../scripts/lib/learning/experience-log');
const { exitPlan } = require('../../scripts/lib/trading/evaluator');
const { swingSeries } = require('../../scripts/lib/trading/exit-trail');
const { SLIPPAGE_TICKS } = require('../../scripts/lib/replay/counterfactual');
const { rng } = require('../../scripts/lib/prop/stats');

const TICK = 0.25;
const STEP = 180000;
const DAY = Date.UTC(2026, 9, 7); // Wednesday; New York = UTC-4
const et = (h, m) => DAY + ((h + 4) * 60 + m) * 60000;
const FILL_AT = et(10, 0) + 5000; // seconds into the 10:00 bar: the runner counts that bar (a market fill), as here
const SLIP = 1; // ticks, every caller's stop slippage
const EXIT = { mode: 'target_then_trail', lock_giveback_r: 1.5, trail_by: 'structure', trail_r: 1, swing_tf: '15m', lock_at_r: 1, lock_to_ticks: 2 };
const STOP_TICKS = 40; // 1R = 10 points
const TARGET_TICKS = 80; // the trade's own target at 2R

const round = x => Math.round(x * 1e6) / 1e6;

/** 3m bars: `history` before the 10:00 bar, then `path` from it (the fill bar, held whole), each { o, h, l, c }. */
function barsOf(history, path) {
  const all = [...history, ...path];
  const t0 = et(10, 0) - history.length * STEP;
  return all.map((b, k) => ({ t: new Date(t0 + k * STEP).toISOString(), ms: t0 + k * STEP, v: 1, ...b }));
}

/** The backtester's broker: the resting stop first, then the trail at the close, bar by bar from the fill bar. */
function viaSimBroker({ bars, i, sign, entry, plan, swings }) {
  const b = createSimBroker({ tickSize: TICK, slippageTicks: SLIP });
  b.position = { sign, entry, risk: STOP_TICKS * TICK, stop: entry - sign * STOP_TICKS * TICK, initialStop: entry - sign * STOP_TICKS * TICK, target: entry + sign * TARGET_TICKS * TICK, plan, peakR: 0, troughR: 0, barsHeld: 0, tickValue: 0.5, fee: 0, size: 1, armed: false };
  const stops = [];
  for (let j = i; j < bars.length; j += 1) {
    const bar = bars[j];
    const hit = b.onBar(bar);
    if (hit) return { bar: j, price: hit.price, stops };
    const swing = (sign > 0 ? swings.low : swings.high)[j];
    const out = b.manage(bar, { swing: Number.isFinite(swing) ? swing : null });
    if (out) return { bar: j, price: out.price, stops };
    if (stops[stops.length - 1] !== b.position.stop && b.position.stop !== entry - sign * STOP_TICKS * TICK) stops.push(b.position.stop);
  }
  return { bar: null, price: null, stops };
}

/** The attempt simulator: the trade's path in its own ticks (its way), its swings the same, re-exited. */
function viaExitAs({ bars, i, sign, entry, swings }) {
  const its = px => round((sign * (px - entry)) / TICK);
  const path = bars.slice(i).map(b => [its(b.o), its(sign > 0 ? b.l : b.h), its(sign > 0 ? b.h : b.l), its(b.c)]);
  const sw = bars.slice(i).map((_, k) => { const v = (sign > 0 ? swings.low : swings.high)[i + k]; return Number.isFinite(v) ? its(v) : null; });
  const t = { symbol: 'MNQ', stopTicks: STOP_TICKS, path, ownExit: { targetTicks: TARGET_TICKS, trailActivateR: null, trailGivebackR: null }, swingPath: { '5m': sw.map(() => null), '15m': sw, '1h': sw.map(() => null) }, moveTicks: 0, troughTicks: [] };
  const out = exitAs(t, EXIT, SLIP);
  // exitAs runs to the path's end: an exit before it is the bar it stopped on (its exitTime needs pathEnds: given here).
  return { price: round(entry + sign * out.moveTicks * TICK) };
}

/** The experience log's counterfactual: the fill bar held whole (partial false), the swings its own (causal). */
function viaBracketExit({ bars, i, sign, entry, plan }) {
  const x = bracketExit({ bars, i, partial: false, tfMs: STEP, side: sign > 0 ? 'long' : 'short', fill: entry, risk: STOP_TICKS * TICK, targetDist: TARGET_TICKS * TICK, tick: TICK, plan, swingAt: swingsFor(bars, plan) });
  return x ? { bar: bars.findIndex(b => b.ms + STEP === x.exitMs), price: x.exitPrice } : { bar: null, price: null };
}

/**
 * The live runner on a fake broker that publishes the bars as they close, fills the resting stop as the simulators do
 * (the first bar through it: at it, or a worse open, less a tick) and fills a market close at the last closed bar's close.
 */
async function viaRunner({ bars, i, sign, entry }) {
  const clockRef = { t: FILL_AT - 3000 };
  let stopPrice = entry - sign * STOP_TICKS * TICK;
  let flat = null; // { bar, price }
  let judged = i - 1; // the last bar the broker judged the resting stop against
  const modified = [];
  const closedUpTo = () => bars.filter(b => b.ms + STEP <= clockRef.t);
  // The broker's side: each newly closed bar after the fill tests the stop resting during it.
  const settle = () => {
    const done = closedUpTo();
    for (let j = judged + 1; j < done.length && !flat; j += 1) {
      const b = bars[j];
      if (j >= i && (sign > 0 ? b.l <= stopPrice : b.h >= stopPrice)) flat = { bar: j, price: round((sign > 0 ? Math.min(b.o, stopPrice) : Math.max(b.o, stopPrice)) - sign * SLIP * TICK) };
      judged = j;
    }
  };
  const runner = createRunner({
    cfg: validateConfig({ harness: 'qwen', premarketAt: '', timeframe: 3, account: '7' }), root: '/r',
    client: {
      async activeContract() { return { id: 'MNQ', tickSize: TICK, tickValue: 0.5 }; },
      async closedBars(cid, o = {}) { if (o.minutes === 1) return []; settle(); const done = closedUpTo(); return done.slice(-(o.limit || 500)).map(({ ms: _ms, ...b }) => b); },
      async accountState() {
        settle();
        return {
          positions: flat ? [] : [{ id: 77, contractId: 'MNQ', type: sign > 0 ? 1 : 2, size: 1, averagePrice: entry, creationTimestamp: new Date(FILL_AT).toISOString() }],
          orders: flat ? [] : [{ id: 9, contractId: 'MNQ', type: 4, side: sign > 0 ? 1 : 0, size: 1, stopPrice }, { id: 10, contractId: 'MNQ', type: 1, side: sign > 0 ? 1 : 0, size: 1, limitPrice: entry + sign * TARGET_TICKS * TICK }],
        };
      },
      async modifyStop(acct, id, price) { modified.push(price); stopPrice = price; },
      async closePosition() { settle(); if (!flat) { const done = closedUpTo(); const last = done[done.length - 1]; flat = { bar: done.length - 1, price: last.c, market: true }; } },
      async cancelOrder() {},
      async netPosition() { return flat ? 0 : sign; },
      async workingOrders() { return flat ? 0 : 1; },
      async accountBalance() { return 50000; },
    },
    clock: { now: () => new Date(clockRef.t) },
    runCycle: async () => ({ ok: true, timedOut: false, result: 'CYCLE RESULT: managed' }),
    isKillSwitchOn: () => false, createKillSwitch: () => {}, loadState: () => null, saveState: () => {},
    writeBars: () => '/b.json', scanFor: () => [],
    entryOrders: () => [{ orderId: 5, contractId: 'MNQ', setup: 'trendy', side: sign > 0 ? 'buy' : 'sell', stopTicks: STOP_TICKS, targetTicks: TARGET_TICKS, at: new Date(FILL_AT - 2000).toISOString() }],
    strategyNamed: () => ({ name: 'trendy', risk: { stop: 'atr:0.5', min_rr: 2 }, exit: EXIT }),
    scanLog: () => {}, event: () => {}, log: () => {},
  });
  const until = bars[bars.length - 1].ms + STEP + 60000;
  while (clockRef.t < until && !flat) { const ms = await runner.step(); clockRef.t += Math.max(1000, ms); }
  settle();
  return { bar: flat ? flat.bar : null, price: flat ? flat.price : null, stops: modified };
}

/** All four on one path; the runner's stops are what the broker's stop order was moved to. */
async function allFour(history, path, sign) {
  const bars = barsOf(history, path);
  const i = history.length;
  const entry = path[0].o;
  const plan = exitPlan({ risk: { min_rr: 2 }, exit: EXIT });
  const swings = swingSeries(bars, 15);
  return {
    sim: viaSimBroker({ bars, i, sign, entry, plan, swings }),
    exitAs: viaExitAs({ bars, i, sign, entry, swings }),
    bracket: viaBracketExit({ bars, i, sign, entry, plan }),
    runner: await viaRunner({ bars, i, sign, entry }),
    lastClose: bars[bars.length - 1].c,
  };
}

const flatHistory = n => Array.from({ length: n }, () => ({ o: 21500, h: 21501, l: 21499, c: 21500 }));

function assertSame(r, label) {
  // Still open at the path's end: exitAs closes at the last close; the others report no exit.
  if (r.sim.bar === null) {
    assert.deepStrictEqual([r.bracket.bar, r.runner.bar], [null, null], `${label}: open at the end ${JSON.stringify(r)}`);
    assert.strictEqual(r.exitAs.price, r.lastClose, `${label}: exitAs out at the last close`);
    assert.deepStrictEqual(r.runner.stops, r.sim.stops, `${label}: the stops moved`);
    return;
  }
  assert.strictEqual(r.exitAs.price, r.sim.price, `${label}: exitAs vs sim-broker ${JSON.stringify(r)}`);
  assert.strictEqual(r.bracket.price, r.sim.price, `${label}: bracketExit vs sim-broker ${JSON.stringify(r)}`);
  assert.strictEqual(r.runner.price, r.sim.price, `${label}: runner vs sim-broker ${JSON.stringify(r)}`);
  assert.strictEqual(r.bracket.bar, r.sim.bar, `${label}: the exit bar`);
  assert.strictEqual(r.runner.bar, r.sim.bar, `${label}: the exit bar`);
  assert.deepStrictEqual(r.runner.stops, r.sim.stops, `${label}: the stops moved`);
}

test('parity: the lock bar rests above its close in all four callers, then a gap through the resting stop fills at the open', async () => {
  const path = [
    { o: 21500, h: 21503, l: 21496, c: 21501 },
    { o: 21501, h: 21510, l: 21497, c: 21508 }, // +1R touched after trading under the entry; closes beyond the lock: rests at 21500.5
    { o: 21508, h: 21515, l: 21505, c: 21512 },
    { o: 21512, h: 21521, l: 21512, c: 21519 }, // the target (2R): the +0.5R lock (21505), the 1R fallback (21511)
    { o: 21518, h: 21530, l: 21521, c: 21528 }, // 3R: the fallback trail to 21520
    { o: 21515, h: 21516, l: 21510, c: 21512 }, // a gap under 21520: filled at the open less a tick
    { o: 21512, h: 21513, l: 21505, c: 21506 },
  ];
  const r = await allFour(flatHistory(40), path, 1);
  assertSame(r, 'lock-bar vector');
  assert.deepStrictEqual(r.sim.stops, [21500.5, 21511, 21520]);
  assert.deepStrictEqual([r.sim.bar, r.sim.price], [40 + 5, 21514.75], 'no market close at the lock bar: out at the gap');
});

test('parity: the lock bar closing through the lock closes at its close in all four (a stop above the market cannot rest)', async () => {
  const path = [{ o: 21500, h: 21503, l: 21496, c: 21501 }, { o: 21501, h: 21510, l: 21497, c: 21500 }, { o: 21500, h: 21502, l: 21480, c: 21485 }];
  const r = await allFour(flatHistory(40), path, 1);
  assertSame(r, 'lock-bar close-through');
  assert.deepStrictEqual([r.sim.bar, r.sim.price], [41, 21500]);
});

test('parity: a bar reaching both the stop and the target is a stop in all four; a short mirrors the lock bar', async () => {
  const both = await allFour(flatHistory(40), [{ o: 21500, h: 21503, l: 21496, c: 21501 }, { o: 21501, h: 21521, l: 21489, c: 21500 }, { o: 21500, h: 21501, l: 21499, c: 21500 }], 1);
  assertSame(both, 'stop and target in one bar');
  assert.deepStrictEqual([both.sim.bar, both.sim.price], [41, 21489.75]);
  const short = await allFour(flatHistory(40), [{ o: 21500, h: 21504, l: 21497, c: 21499 }, { o: 21499, h: 21503, l: 21490, c: 21492 }, { o: 21492, h: 21499.75, l: 21488, c: 21499 }, { o: 21499, h: 21500, l: 21497, c: 21498 }], -1);
  assertSame(short, 'short lock bar');
  assert.deepStrictEqual(short.sim.stops, [21499.5]);
  assert.deepStrictEqual([short.sim.bar, short.sim.price], [42, 21499.75], 'the resting lock (21499.5) filled a tick worse');
});

/** A random walk with occasional gaps, on the tick grid: a long history (so 15m swings confirm), then the path. */
function walk(r, n, from) {
  const out = [];
  let px = from;
  for (let k = 0; k < n; k += 1) {
    const gap = r() < 0.06 ? (r() - 0.5) * 16 : 0;
    const o = Math.round((px + gap) * 4) / 4;
    const c = Math.round((o + (r() - 0.48) * 9) * 4) / 4;
    out.push({ o, h: Math.max(o, c) + Math.round(r() * 12) / 4, l: Math.min(o, c) - Math.round(r() * 12) / 4, c });
    px = c;
  }
  return out;
}

test('parity: seeded random paths with 15m swings and gaps, long and short: the same stops and exit in all four callers', async () => {
  const r = rng(29);
  let locked = 0;
  let armed = 0;
  let structure = 0;
  for (let n = 0; n < 24; n += 1) {
    const sign = n % 2 ? -1 : 1;
    const history = walk(r, 60, 21500);
    const path = walk(r, 40, history[history.length - 1].c);
    const res = await allFour(history, path, sign);
    assertSame(res, `path ${n}`);
    const entry = path[0].o;
    if (res.sim.stops.length) locked += 1;
    if (res.sim.stops.some(s => sign * (s - (entry + sign * 0.5 * STOP_TICKS * TICK)) >= 0)) armed += 1;
    if (res.sim.stops.some(s => !Number.isInteger(round((s - entry) / (STOP_TICKS * TICK) * 4)))) structure += 1;
  }
  // The paths exercise the rule, not only the original stop.
  assert.ok(locked >= 6 && armed >= 3, `locked ${locked}, armed ${armed}, structure stops ${structure}`);
});

test('parity guard: the four callers share the slippage the vectors assume', () => {
  assert.strictEqual(SLIPPAGE_TICKS, SLIP, 'bracketExit\'s stop slippage');
});
