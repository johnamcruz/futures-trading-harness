'use strict';

// The simulated broker (scripts/lib/backtest/sim-broker.js): the fill model the
// backtester drives bar by bar. MNQ arithmetic: tick 0.25, $0.50 a tick, $0.37
// a side per contract.
const test = require('node:test');
const assert = require('node:assert');
const { createSimBroker, onTick } = require('../../scripts/lib/backtest/sim-broker');

const MNQ = { tickSize: 0.25, slippageTicks: 1 };
const PLAN = { trailActivateR: null, trailGivebackR: null, maxBars: null };
const order = (over = {}) => ({ sign: 1, risk: 2, size: 1, tickValue: 0.5, fee: 0.37, plan: PLAN, target: null, ...over });
const bar = (o, h, l, c, t = '2026-03-02T15:00:00Z') => ({ o, h, l, c, t });
// An open position, filled at the signal bar's close (100) plus a tick: entry 100.25, stop 98.25.
function open(over = {}, brokerOpts = MNQ) {
  const b = createSimBroker(brokerOpts);
  b.submitMarket(order(over), { price: 100, fill: 'close' });
  return b;
}

test('onTick snaps to the tick grid without float noise', () => {
  assert.strictEqual(onTick(2045.1 - 0.2, 0.1), 2044.9);
  assert.strictEqual(onTick(100.13, 0.25), 100.25);
});

test('fill: close fills at the signal close plus slippage, the stop risk away, a target in ticks from the fill', () => {
  const b = open({ target: { ticks: 16 }, strategy: 'orb', tradingDay: 7 });
  const p = b.position;
  assert.deepStrictEqual([p.entry, p.stop, p.initialStop, p.target, p.pending], [100.25, 98.25, 98.25, 104.25, undefined]);
  assert.deepStrictEqual([p.peakR, p.troughR, p.barsHeld], [0, 0, 0]);
  // The order's other keys ride on the position.
  assert.deepStrictEqual([p.strategy, p.tradingDay], ['orb', 7]);
  const s = createSimBroker(MNQ);
  s.submitMarket(order({ sign: -1, target: { ticks: 8 } }), { price: 100, fill: 'close' });
  assert.deepStrictEqual([s.position.entry, s.position.stop, s.position.target], [99.75, 101.75, 97.75]);
});

test('next-open: the entry rests until the next bar, then fills at its open plus slippage, stop and target from the fill', () => {
  const b = createSimBroker(MNQ);
  const p = b.submitMarket(order({ target: { ticks: 16 } }), { price: 100 });
  assert.strictEqual(p.pending, true);
  assert.strictEqual(b.onBar(bar(100, 120, 80, 100)), null, 'a pending entry settles nothing');
  assert.strictEqual(b.manage(bar(100, 120, 80, 100)), null);
  const q = b.fillAtOpen(bar(101, 102, 100.5, 101.5));
  assert.strictEqual(q, p);
  assert.deepStrictEqual([q.pending, q.entry, q.stop, q.initialStop, q.target], [false, 101.25, 99.25, 99.25, 105.25]);
  // Two ticks of slippage.
  const b2 = createSimBroker({ tickSize: 0.25, slippageTicks: 2 });
  b2.submitMarket(order({ sign: -1 }), { price: 100 });
  assert.strictEqual(b2.fillAtOpen(bar(99, 99, 98, 98.5)).entry, 98.5);
});

test('next-open: a fill at or through the signal stop drops the entry', () => {
  // The signal's stop: 100.25 - 2 = 98.25. Opening at 98 fills at 98.25: no trade.
  const b = createSimBroker(MNQ);
  b.submitMarket(order(), { price: 100 });
  assert.strictEqual(b.fillAtOpen(bar(98, 99, 97, 98.5)), null);
  assert.strictEqual(b.position, null);
  // One tick better (open 98.25, fill 98.5) still trades, its stop 2 points under the fill.
  const ok = createSimBroker(MNQ);
  ok.submitMarket(order(), { price: 100 });
  assert.deepStrictEqual([ok.fillAtOpen(bar(98.25, 99, 98, 98.5)).entry, ok.position.stop], [98.5, 96.5]);
  // A short: signal stop 99.75 + 2 = 101.75.
  const s = createSimBroker(MNQ);
  s.submitMarket(order({ sign: -1 }), { price: 100 });
  assert.strictEqual(s.fillAtOpen(bar(102, 102, 101, 101.5)), null);
});

test('a target level the fill reaches, or one under minRR, is no trade (at submission and at the fill)', () => {
  const sub = (target, extra = {}) => createSimBroker(MNQ).submitMarket(order({ target, ...extra }), { price: 100, fill: 'close' });
  assert.strictEqual(sub({ price: 100.25 }), null, 'the fill (100.25) is at the level');
  assert.strictEqual(sub({ price: null }), null, 'no level');
  assert.strictEqual(sub({ price: 100.5 }).target, 100.5, 'one tick of reward trades');
  assert.strictEqual(sub({ price: 104 }, { minRR: 2 }), null, '3.75 points < 2R of 2');
  assert.strictEqual(sub({ price: 104.25 }, { minRR: 2 }).target, 104.25);
  // At the fill: the level stays put while the entry moves.
  const b = createSimBroker(MNQ);
  b.submitMarket(order({ target: { price: 103 } }), { price: 100 });
  assert.strictEqual(b.fillAtOpen(bar(102.75, 103, 102, 102.5)), null, 'filled at 103, the level');
  const m = createSimBroker(MNQ);
  m.submitMarket(order({ target: { price: 105 }, minRR: 2 }), { price: 100 });
  assert.strictEqual(m.fillAtOpen(bar(101.25, 102, 101, 101.5)), null, 'filled at 101.5: 3.5 points < 4');
  const k = createSimBroker(MNQ);
  k.submitMarket(order({ target: { price: 105 }, minRR: 2 }), { price: 100 });
  assert.strictEqual(k.fillAtOpen(bar(100.75, 102, 100.5, 101.5)).target, 105, 'filled at 101: 4 points = 2R');
});

test('stop first: a bar reaching both the stop and the target is a loss at the stop less slippage', () => {
  const b = open({ target: { ticks: 16 } });
  const x = b.onBar(bar(100, 105, 97, 104));
  assert.deepStrictEqual([x.reason, x.price], ['stop', 98]);
  // (98 - 100.25) / 0.25 = -9 ticks x $0.50 = -$4.50, fees 2 x $0.37.
  assert.deepStrictEqual([x.gross, x.fees, Math.round(x.net * 100) / 100], [-4.5, 0.74, -5.24]);
  assert.strictEqual(b.position, null);
  const s = open({ sign: -1, target: { ticks: 16 } });
  const y = s.onBar(bar(100, 102, 95, 96));
  assert.deepStrictEqual([y.reason, y.price], ['stop', 102]);
});

test('a bar gapping through the stop fills at its open less slippage', () => {
  const x = open().onBar(bar(96, 97, 95, 96.5));
  assert.deepStrictEqual([x.reason, x.price], ['stop', 95.75]);
  const y = open({ sign: -1 }).onBar(bar(104, 105, 103, 104));
  assert.deepStrictEqual([y.reason, y.price], ['stop', 104.25]);
});

test('the target fills at its price, or at a better open, with no slippage', () => {
  const x = open({ target: { ticks: 16 } }).onBar(bar(101, 104.5, 100.5, 104));
  assert.deepStrictEqual([x.reason, x.price, x.gross], ['target', 104.25, 8]);
  assert.strictEqual(open({ target: { ticks: 16 } }).onBar(bar(105, 106, 104.75, 105.5)).price, 105);
  const s = open({ sign: -1, target: { ticks: 8 } }).onBar(bar(97, 97.5, 96, 96.5));
  assert.deepStrictEqual([s.reason, s.price], ['target', 97]);
  assert.strictEqual(open({ sign: -1, target: { ticks: 8 } }).onBar(bar(98, 99, 97.5, 98.5)).price, 97.75);
});

test('a bar touching neither holds: bars held, best and worst excursion in R', () => {
  const b = open({ target: { ticks: 16 } });
  assert.strictEqual(b.onBar(bar(100.25, 101.25, 99.25, 101)), null);
  const p = b.position;
  assert.deepStrictEqual([p.barsHeld, p.peakR, p.troughR], [1, 0.5, -0.5]);
  b.onBar(bar(101, 101.5, 100, 101));
  assert.deepStrictEqual([p.barsHeld, p.peakR, p.troughR], [2, 0.625, -0.5]);
});

test('guard: a forced exit (a prop floor) comes before the stop, given the worst price in the bar', () => {
  const seen = [];
  const b = open();
  const x = b.onBar(bar(100, 100.5, 97, 98), { guard: (worst) => { seen.push(worst); return { price: 99, reason: 'blow' }; } });
  assert.deepStrictEqual([x.reason, x.price, seen], ['blow', 99, [98]], 'the stop fill is the worst price');
  const h = open();
  assert.strictEqual(h.onBar(bar(100, 100.5, 99, 100), { guard: (worst) => { seen.push(worst); return null; } }), null);
  assert.strictEqual(seen[1], 99, 'no stop: the bar low');
  assert.strictEqual(h.position.barsHeld, 1);
});

test('trail: the stop moves toward the market only, and a bar already through the new stop closes at its close', () => {
  const plan = { trailActivateR: 1, trailGivebackR: 0.5, maxBars: null };
  // Entry 100.25, 1R = 2. High 103.25 = 1.5R: the stop goes to 1R above entry, 102.25.
  const b = open({ plan });
  assert.strictEqual(b.manage(bar(101, 103.25, 102.5, 103)), null);
  assert.strictEqual(b.position.stop, 102.25);
  // A lower peak never loosens it.
  b.manage(bar(102.75, 103, 102.5, 102.75));
  assert.strictEqual(b.position.stop, 102.25);
  // The resting trailed stop fills as 'trail'.
  const x = b.onBar(bar(102.5, 102.75, 101.5, 101.75));
  assert.deepStrictEqual([x.reason, x.price], ['trail', 102]);
  // Same-bar breach of the tightened stop: closed at the bar's close.
  const c = open({ plan }).manage(bar(101, 103.25, 101.5, 102.5));
  assert.deepStrictEqual([c.reason, c.price], ['trail', 102.5]);
  // Short: the stop moves down.
  const s = open({ sign: -1, plan });
  assert.strictEqual(s.manage(bar(97.5, 97.5, 96.75, 97)), null);
  assert.strictEqual(s.position.stop, 97.75);
  // Not active below trailActivateR.
  const n = open({ plan });
  n.manage(bar(100.5, 102, 100, 101.5));
  assert.strictEqual(n.position.stop, 98.25);
  // Active, but 2.5R behind a 1R peak is below the initial stop: the stop stays.
  const w = open({ plan: { trailActivateR: 1, trailGivebackR: 2.5, maxBars: null } });
  assert.strictEqual(w.manage(bar(100.5, 102.25, 100, 102)), null);
  assert.strictEqual(w.position.stop, 98.25);
});

test('time stop: plan.maxBars bars held closes at the bar close', () => {
  const b = open({ plan: { ...PLAN, maxBars: 2 } });
  b.onBar(bar(100.25, 100.5, 100, 100.25));
  assert.strictEqual(b.manage(bar(100.25, 100.5, 100, 100.25)), null, 'one bar held');
  b.onBar(bar(100.25, 100.75, 100, 100.5));
  const x = b.manage(bar(100.25, 100.75, 100, 100.5));
  assert.deepStrictEqual([x.reason, x.price], ['max_bars', 100.5]);
});

test('exit at a price (end of day): P&L in ticks x tick value x size, fees per side on both sides', () => {
  const b = open({ size: 3 });
  const x = b.exit(101.25, 'eod');
  // +4 ticks x $0.50 x 3 = $6; fees 2 x $0.37 x 3 = $2.22.
  assert.deepStrictEqual([x.reason, x.gross, Math.round(x.fees * 100) / 100, Math.round(x.net * 100) / 100], ['eod', 6, 2.22, 3.78]);
  assert.strictEqual(b.position, null);
});

test('netAt and priceForNet: open net P&L at a price and the tick at which it reaches a net, against the trade', () => {
  const b = open({ size: 2 }); // $4 a point
  assert.strictEqual(Math.round(b.netAt(99.25) * 100) / 100, -5.48);
  assert.strictEqual(b.priceForNet(-5.48), 99.25);
  assert.strictEqual(b.priceForNet(-4.5), 99.25, '99.495 rounded down for a long');
  const s = open({ sign: -1, size: 2 }); // entry 99.75
  assert.strictEqual(s.priceForNet(-6), 101, '100.88 rounded up for a short');
  assert.strictEqual(s.priceForNet(-4.5), 100.75, '100.505 rounded up for a short');
});

test('cancel drops a pending entry', () => {
  const b = createSimBroker(MNQ);
  b.submitMarket(order(), { price: 100 });
  b.cancel();
  assert.strictEqual(b.position, null);
  assert.strictEqual(b.fillAtOpen(bar(100, 101, 99, 100)), null);
});
