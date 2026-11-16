'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openTrades, describeOpenTrade, entryOrder, tradeReadText } = require('../../scripts/lib/trading/open-trades');

const C = 'MNQ';
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
      { contractId: 'MES', type: 4, side: 1, stopPrice: 6000 },
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
  // The Position line first (no held trade here: folded from the bars, said so); now, best and worst are its, not the sentence's.
  assert.strictEqual(line, `Position (code facts): ${C} long 2 @ 21500.25, 1R 11.25 pts; now +0.84R at 21509.75; MFE +1.22R at 21514 (10:45 ET bar); MAE -0.38R; giveback 0.38R (31% of MFE); working stop 21494.75 (-0.49R; a fill there gives back 1.71R); target order 21560 (+5.31R) (not runner-managed: no held trade; risk from the journal stop). Open trade ${C} long 2 @ 21500.25 since 10:41 ET, 2 bars closed since (setup:value_area): initial stop 21489: risk 11.25 points = 45 ticks; working stop 21494.75 (-0.49R), target 21560 (+5.31R).`);
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
  assert.match(describeOpenTrade(t), /^Position: unavailable \(no initial risk: no R to state\)\. Open trade .*\(setup:bos\): initial risk unknown; NO working stop, target 21450 \(\?\)\.$/);
});

test('the initial stop falls back to the working stop; a stop on the wrong side of the entry is not a risk', () => {
  const pos = { contractId: C, type: 1, size: 1, averagePrice: 21500, creationTimestamp: '2026-10-08T14:41:10Z' };
  const [a] = openTrades({ positions: [pos], orders: [{ contractId: C, type: 4, side: 1, stopPrice: 21490 }], entries: [], barsFor: () => null });
  assert.strictEqual(a.initialStop, 21490);
  assert.deepStrictEqual(a.notes, ['initial stop unknown: risk from the working stop']);
  assert.strictEqual(a.setup, null);
  assert.strictEqual(a.barsHeld, null, 'no bars for its contract this cycle');
  assert.match(describeOpenTrade(a), /^Position: unavailable \(no bars for this contract this cycle\)\. Open trade .*setup unknown: no order_placed entry with a setup tag\): risk 10 points, measured to the working stop \(the initial stop is unknown\);.*no bars for this contract this cycle \(read get_bars or the quote\)\.$/);
  // Bars, but none since the fill (it filled during the bar that just closed).
  const [c] = openTrades({ positions: [pos], orders: [{ contractId: C, type: 4, side: 1, stopPrice: 21490 }], entries: [], barsFor: () => [BARS[0]] });
  assert.strictEqual(c.barsHeld, 0);
  assert.match(describeOpenTrade(c), /^Position: unavailable \(no closed bar since the fill yet\)\. Open trade /);
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
  assert.strictEqual(entryOrder([placed('2026-10-08T14:41:00Z', 'setup:orb long', true, 'MNQ:2027-03')], pos).text, 'setup:orb long', 'same root');
  assert.strictEqual(entryOrder([placed('2026-10-08T14:41:00Z', 'no setup tag')], pos), null);
});

test('the open trade\'s line ends with its read facts (trade-read.js); a read that fails is said in the line', () => {
  const [t] = openTrades({
    positions: [{ contractId: C, type: 1, size: 1, averagePrice: 21500, creationTimestamp: '2026-10-08T14:41:10Z' }],
    orders: [{ contractId: C, type: 4, side: 1, stopPrice: 21490 }],
    entries: [placed('2026-10-08T14:41:05Z', 'setup:trade_lifecycle long, stop 21490.00')],
    barsFor: () => BARS,
  });
  const read = tradeReadText(t, { bars: BARS, base: 3, tickSize: 0.25 });
  assert.match(read, /^Trade read \(closed bars since entry; pullback-vs-reversal\): best 21514; /);
  const line = describeOpenTrade(t, { read });
  assert.ok(line.endsWith(` ${read}`), line);
  assert.ok(!describeOpenTrade(t).includes('Trade read'), 'no read given, none shown');
  // Broken bars: the failure is in the line, never a throw.
  assert.match(tradeReadText(t, { bars: [{ t: '2026-10-08T14:42:00.000Z' }], base: 3 }), /^Trade read: unavailable \(/);
  assert.match(tradeReadText(t, { bars: null, base: 3 }), /^Trade read: unavailable \(/);
});

// One R basis (DESIGN 4.2, review B1/B2): the runner's held trade, when it is the position's and current.
const { tradeFold } = require('../../scripts/lib/trading/exit-trail');
const POS = { id: 7, contractId: C, type: 1, size: 2, averagePrice: 21500.25, creationTimestamp: '2026-10-08T14:41:10Z' };
const ORDERS = [{ contractId: C, type: 4, side: 1, stopPrice: 21494.75 }];
const JOURNAL = [placed('2026-10-08T14:41:05Z', 'setup:trade_lifecycle long, stop 21489.00')]; // the journal's 1R: 11.25
const PLAN = { afterTarget: { lockGivebackR: 1.5, trailBy: 'r', trailR: 1, swingMinutes: null, warningGivebackR: 0.5 } };
/** The runner's held trade over BARS by its own rule (the 14:39 bar opened 130 s before the fill: not counted), 1R 10. */
function heldOver(bars, over = {}) {
  const x = tradeFold({ sign: 1, entry: 21500.25, risk: 10, stop: 21490.25, target: 21520.25 }, bars.slice(1), PLAN, 0.25);
  return { key: '7', setup: 'trade_lifecycle', sign: 1, entry: 21500.25, risk: 10, stop: 21490.25, plan: PLAN, target: 21520.25, since: Date.parse(POS.creationTimestamp), ...x, ...over };
}

test('one basis: every R and every "best" in the Position line, the Open trade sentence, the Trade read and the Manage read is the held trade\'s (its 1R differing from the journal\'s)', () => {
  const held = heldOver(BARS);
  const [t] = openTrades({ positions: [POS], orders: ORDERS, entries: JOURNAL, barsFor: () => BARS, heldFor: () => held, lastBarFor: () => BARS[2].t, tickFor: () => 0.25 });
  assert.deepStrictEqual([t.held, t.risk, t.initialStop, t.riskFrom], [true, 10, 21490.25, 'runner'], 'the runner\'s 1R, not the journal\'s 11.25');
  assert.deepStrictEqual([t.rNow, t.mfeR, t.maeR], [0.95, 1.38, -0.42]);
  const read = tradeReadText(t, { bars: BARS, base: 3, tickSize: 0.25, exit: PLAN.afterTarget });
  const text = describeOpenTrade(t, { tickSize: 0.25, read });
  assert.match(text, /^Position \(code facts\): MNQ long 2 @ 21500\.25, 1R 10 pts; now \+0\.95R at 21509\.75; MFE \+1\.38R at 21514 \(10:45 ET bar\); MAE -0\.42R; giveback 0\.43R \(31% of MFE\); working stop 21494\.75 \(-0\.55R; a fill there gives back 1\.93R\); target not reached; code floor: before the target: the initial stop holds\. /);
  assert.match(text, /Open trade MNQ long 2 @ 21500\.25.*: initial stop 21490\.25: risk 10 points = 40 ticks; working stop 21494\.75 \(-0\.55R\)/);
  assert.match(text, /Trade read \(closed bars since entry; pullback-vs-reversal\): best 21514; /);
  // The Manage read's warning level from the same best and 1R: 21514 - 0.5 x 10 = 21509.
  assert.match(text, /warning giveback \(0\.5R behind the best\): 21509 /);
  // Every R stated anywhere: the working stop's is one number.
  assert.deepStrictEqual([...new Set([...text.matchAll(/21494\.75 \(([-+\d.]+)R/g)].map(m => m[1]))], ['-0.55']);
  assert.ok(!/11\.25|\b45 ticks/.test(text), 'the journal\'s 1R appears nowhere');
});

test('the held trade is used only for its own position, managed, and current; else the bars fold, said so (never another trade\'s numbers)', () => {
  const held = heldOver(BARS);
  const run = (h, lastBarT, pos = POS) => openTrades({ positions: [pos], orders: ORDERS, entries: JOURNAL, barsFor: () => BARS, heldFor: () => h, lastBarFor: () => lastBarT, tickFor: () => 0.25 })[0];
  // Opened after this pass's housekeeping (no held trade yet).
  const fresh = run(null, BARS[2].t);
  assert.deepStrictEqual([fresh.held, fresh.risk, fresh.position.basis], [false, 11.25, 'fold']);
  assert.match(describeOpenTrade(fresh, { tickSize: 0.25 }), /\(not runner-managed: no held trade; risk from the journal stop\)\./);
  // A micro and its mini on one item: the held trade is the other position's (its key).
  const other = run(held, BARS[2].t, { ...POS, id: 8 });
  assert.deepStrictEqual([other.held, other.risk], [false, 11.25]);
  assert.match(describeOpenTrade(other, { tickSize: 0.25 }), /not runner-managed: the held trade is another position's;/);
  // Housekeeping failed this pass: the held trade's last bar is not the last closed bar.
  const stale = run(heldOver(BARS.slice(0, 2)), BARS[2].t);
  assert.deepStrictEqual([stale.held, stale.position.basis], [false, 'fold']);
  assert.match(describeOpenTrade(stale, { tickSize: 0.25 }), /not runner-managed: the held trade was not updated to the last closed bar;/);
  // Not managed by the runner ({ skip: true }).
  assert.strictEqual(run({ key: '7', skip: true }, BARS[2].t).held, false);
  // The fallback counts the bars the runner would: the 14:41 bar? none here; a bar opened 20 s before the fill would be.
  const graced = openTrades({ positions: [POS], orders: ORDERS, entries: JOURNAL, barsFor: () => [{ t: '2026-10-08T14:40:50.000Z', o: 21500, h: 21530, l: 21499, c: 21501 }], tickFor: () => 0.25 })[0];
  assert.deepStrictEqual([graced.barsHeld, graced.mfeR], [1, 2.64]);
});

test('every working stop is kept (`stops`); `stop` stays the working stop nearest the entry (replay/labels.js reads it)', () => {
  const [t] = openTrades({ positions: [POS], orders: [...ORDERS, { contractId: C, type: 4, side: 1, stopPrice: 21480 }], entries: JOURNAL, barsFor: () => BARS, tickFor: () => 0.25 });
  assert.deepStrictEqual([t.stop, t.stops], [21494.75, [21494.75, 21480]]);
  assert.match(describeOpenTrade(t, { tickSize: 0.25 }), /; 2 stop orders, the loosest 21480 \(-1\.8R; /);
});

test('describeOpenTrade is total: a broken trade object still gives a Position line or "Position: unavailable (...)" first', () => {
  for (const bad of [{}, { contractId: C, notes: null }, { contractId: C, position: { unavailable: 'x' } }]) {
    const s = describeOpenTrade(bad);
    assert.match(s, /^Position(: unavailable \(| \(code facts\): )/, s);
  }
});
