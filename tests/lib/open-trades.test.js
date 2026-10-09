'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openTrades, describeOpenTrade, entryOrder } = require('../../scripts/lib/trading/open-trades');

const C = 'CON.F.US.MNQ.Z26';
const placed = (ts, text, ok = true, contractId = C) => ({ ts, kind: 'order_placed', contractId, text, data: { result: { success: ok } } });
const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
// Filled at 14:41:10Z; the 14:39 bar holds the fill (partly before it), then two bars after.
const BARS = [
  bar('2026-10-08T14:39:00.000Z', 21495, 21530, 21470, 21500), // before/at the fill: not counted
  bar('2026-10-08T14:42:00.000Z', 21500, 21505, 21498, 21503),
  bar('2026-10-08T14:45:00.000Z', 21503, 21514, 21496, 21509.75),
];

test('a long: setup and initial stop from the entry\'s order, working stop and target, R now, best and worst', () => {
  const [t] = openTrades({
    positions: [{ contractId: C, type: 1, size: 2, averagePrice: 21500.25, creationTimestamp: '2026-10-08T14:41:10Z' }],
    orders: [
      { contractId: C, type: 4, side: 1, stopPrice: 21494.75 }, // trailed up from the initial 21489.00
      { contractId: C, type: 1, side: 1, limitPrice: 21560 },
      { contractId: C, type: 1, side: 0, limitPrice: 21400 }, // a buy limit: not this trade's target
      { contractId: 'CON.F.US.MES.Z26', type: 4, side: 1, stopPrice: 6000 },
    ],
    entries: [
      placed('2026-10-08T13:00:00Z', 'setup:orb long, stop 21300.00'), // an earlier trade
      placed('2026-10-08T14:41:05Z', 'setup:value_area long, POC rejection, stop 21489.00'),
      placed('2026-10-08T14:41:08Z', 'setup:bos long, stop 21480.00', false), // failed: not the entry
    ],
    barsFor: () => BARS,
  });
  assert.strictEqual(t.setup, 'value_area');
  assert.strictEqual(t.initialStop, 21489);
  assert.strictEqual(t.risk, 11.25);
  assert.strictEqual(t.stop, 21494.75);
  assert.strictEqual(t.target, 21560);
  assert.strictEqual(t.barsHeld, 2, 'bars after the fill only');
  assert.strictEqual(t.rNow, 0.84); // (21509.75 - 21500.25) / 11.25
  assert.strictEqual(t.mfeR, 1.22); // 21514
  assert.strictEqual(t.maeR, -0.38); // 21496
  assert.deepStrictEqual(t.notes, []);
  const line = describeOpenTrade(t, { tickSize: 0.25, et: () => '10:41 ET' });
  assert.strictEqual(line, `Open trade ${C} long 2 @ 21500.25 since 10:41 ET, 2 bars closed since (setup:value_area): initial stop 21489: risk 11.25 points = 45 ticks; working stop 21494.75 (-0.49R), target 21560 (+5.31R); now +0.84R at 21509.75, best +1.22R, worst -0.38R.`);
});

test('a short with no working stop and no planned stop: flagged, risk unknown', () => {
  const [t] = openTrades({
    positions: [{ contractId: C, type: 2, size: 1, averagePrice: 21500, creationTimestamp: '2026-10-08T14:41:10Z' }],
    orders: [{ contractId: C, type: 1, side: 0, limitPrice: 21450 }],
    entries: [placed('2026-10-08T14:41:00Z', 'setup:bos short at market')],
    barsFor: () => BARS,
  });
  assert.strictEqual(t.side, 'short');
  assert.strictEqual(t.target, 21450);
  assert.strictEqual(t.risk, null);
  assert.strictEqual(t.rNow, null);
  assert.deepStrictEqual(t.notes, ['NO working stop']);
  assert.match(describeOpenTrade(t), /\(setup:bos\): initial risk unknown; NO working stop, target 21450 \(\?\); last close 21509\.75 \(no R without an initial risk\)\.$/);
});

test('the initial stop falls back to the working stop; a stop on the wrong side of the entry is not a risk', () => {
  const pos = { contractId: C, type: 1, size: 1, averagePrice: 21500, creationTimestamp: '2026-10-08T14:41:10Z' };
  const [a] = openTrades({ positions: [pos], orders: [{ contractId: C, type: 4, side: 1, stopPrice: 21490 }], entries: [], barsFor: () => null });
  assert.strictEqual(a.initialStop, 21490);
  assert.deepStrictEqual(a.notes, ['initial stop unknown: risk from the working stop']);
  assert.strictEqual(a.setup, null);
  assert.strictEqual(a.barsHeld, 0);
  assert.match(describeOpenTrade(a), /setup unknown: no order_placed entry with a setup tag.*no closed bar since the fill yet \(initial stop unknown: risk from the working stop\)/);
  // A breakeven-plus stop above a long's entry: no risk from it.
  const [b] = openTrades({ positions: [pos], orders: [{ contractId: C, type: 4, side: 1, stopPrice: 21505 }], entries: [placed('2026-10-08T14:41:00Z', 'setup:orb long, stop 21510.00')], barsFor: () => null });
  assert.strictEqual(b.initialStop, null);
  assert.strictEqual(b.risk, null);
  // Flat or unknown positions are not trades.
  assert.deepStrictEqual(openTrades({ positions: [{ contractId: C, type: 1, size: 0, averagePrice: 1 }] }), []);
});

test('a stop written in ticks is not a price; a thousands separator is read', () => {
  const pos = { contractId: C, type: 1, size: 1, averagePrice: 21500.25, creationTimestamp: '2026-10-08T14:41:10Z' };
  const orders = [{ contractId: C, type: 4, side: 1, stopPrice: 21490.25 }];
  const [ticks] = openTrades({ positions: [pos], orders, entries: [placed('2026-10-08T14:41:00Z', 'setup:orb long break, stop 40 ticks')], barsFor: () => null });
  assert.strictEqual(ticks.initialStop, 21490.25, 'from the working stop, not 40');
  assert.deepStrictEqual(ticks.notes, ['initial stop unknown: risk from the working stop']);
  const [comma] = openTrades({ positions: [pos], orders, entries: [placed('2026-10-08T14:41:00Z', 'setup:orb long, stop 21,489.00')], barsFor: () => null });
  assert.strictEqual(comma.initialStop, 21489);
  assert.strictEqual(comma.risk, 11.25);
});

test('the entry order: the last successful order with a setup, on the contract (or its root), before the fill', () => {
  const pos = { contractId: C, creationTimestamp: '2026-10-08T14:41:10Z' };
  assert.strictEqual(entryOrder([placed('2026-10-08T14:42:30Z', 'setup:orb long')], pos), null, 'after the fill');
  assert.strictEqual(entryOrder([placed('2026-10-08T14:20:00Z', 'setup:orb long')], pos), null, 'too long before');
  assert.strictEqual(entryOrder([placed('2026-10-08T14:41:00Z', 'setup:orb long', true, 'CON.F.US.MNQ.H27')], pos).text, 'setup:orb long', 'same root');
  assert.strictEqual(entryOrder([placed('2026-10-08T14:41:00Z', 'no setup tag')], pos), null);
});
