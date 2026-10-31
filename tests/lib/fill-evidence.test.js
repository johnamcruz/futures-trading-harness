'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evidenceNet, workingEntryOf, stopHeld } = require('../../scripts/lib/trading/fill-evidence');

const C = 'MNQ:2026-12';
// A 9-contract long (entry 11, buy) with its bracket stop (12, sell); the short mirrors it.
const longEntry = { id: 11, contractId: C, side: 0, type: 2, size: 9, status: 2, fillVolume: 9 };
const longStop = { id: 12, contractId: C, side: 1, type: 4, size: 9, status: 1, stopPrice: 21480 };
const shortEntry = { ...longEntry, side: 1 };
const shortStop = { ...longStop, side: 0, stopPrice: 21520 };
const fill = (orderId, side, size, extra = {}) => ({ id: 100 + orderId, orderId, contractId: C, side, size, voided: false, ...extra });

test('evidenceNet: an order that reads filled with no fill listed for it counts, the fills net, voided fills don\'t', () => {
  assert.deepStrictEqual(evidenceNet(C, { fills: [], history: [longEntry, longStop] }), { net: 9, unknown: false });
  assert.deepStrictEqual(evidenceNet(C, { fills: [], history: [shortEntry] }), { net: -9, unknown: false });
  // Listed: the fill and its order count once.
  assert.deepStrictEqual(evidenceNet(C, { fills: [fill(11, 0, 9)], history: [longEntry] }), { net: 9, unknown: false });
  // Closed: the entry and the stop both filled and listed: zero.
  const stopped = { ...longStop, status: 2, fillVolume: 9 };
  assert.deepStrictEqual(evidenceNet(C, { fills: [fill(11, 0, 9), fill(12, 1, 9)], history: [longEntry, stopped] }), { net: 0, unknown: false });
  // A close the broker reports as a fill with no order listed (close_position): counted from the fill.
  assert.deepStrictEqual(evidenceNet(C, { fills: [fill(11, 0, 9), fill(null, 1, 9)], history: [longEntry] }).net, 0);
  // Part filled, still working: the filled part.
  assert.strictEqual(evidenceNet(C, { fills: [], history: [{ ...longEntry, status: 1, fillVolume: 4 }] }).net, 4);
  assert.strictEqual(evidenceNet(C, { fills: [fill(11, 0, 9, { voided: true })], history: [] }).net, 0);
  // Another month is its own.
  assert.strictEqual(evidenceNet('MNQ:2027-03', { fills: [], history: [longEntry] }).net, 0);
  // Unreadable: never flat.
  assert.strictEqual(evidenceNet(C, { fills: [fill(11, 0, 'nine')], history: [] }).unknown, true);
  assert.strictEqual(evidenceNet(C, { fills: [], history: [{ ...longEntry, side: 'x' }] }).unknown, true);
  assert.strictEqual(evidenceNet(C, { fills: [], history: [{ ...longEntry, fillVolume: 'x' }] }).unknown, true);
});

test('stopHeld: a late fill keeps the stop, long and short; the other side, a stop covered by another, or a closed position lets it go', () => {
  assert.strictEqual(stopHeld(longStop, { orders: [longStop], fills: [], history: [longEntry, longStop] }).why, 'fills');
  assert.strictEqual(stopHeld(shortStop, { orders: [shortStop], fills: [], history: [shortEntry, shortStop] }).why, 'fills');
  // A buy stop doesn't protect a long.
  assert.strictEqual(stopHeld(shortStop, { orders: [shortStop], fills: [], history: [longEntry] }), null);
  // Another stop covers the whole position: this one may go.
  const other = { ...longStop, id: 13 };
  assert.strictEqual(stopHeld(longStop, { orders: [longStop, other], fills: [], history: [longEntry] }), null);
  // Confirmed closed: the fills net to zero and no entry works.
  const stopped = { ...longStop, id: 14, status: 2, fillVolume: 9 };
  assert.strictEqual(stopHeld(longStop, { orders: [longStop], fills: [fill(11, 0, 9), fill(14, 1, 9)], history: [longEntry, stopped] }), null);
  // An unreadable fill keeps it.
  assert.strictEqual(stopHeld(longStop, { orders: [longStop], fills: [fill(11, 0, null)], history: [] }).why, 'unreadable');
  // A target is never judged here.
  assert.strictEqual(stopHeld({ ...longStop, type: 1 }, { orders: [], fills: [], history: [longEntry] }), null);
});

test('workingEntryOf: an earlier working order on the other side is the entry a stop may be the leg of; a later one is not', () => {
  const entry = { id: 11, contractId: C, side: 0, type: 1, size: 9, status: 1, limitPrice: 21500 };
  assert.strictEqual(workingEntryOf(longStop, [entry, longStop]), entry);
  assert.strictEqual(stopHeld(longStop, { orders: [entry, longStop], fills: [], history: [] }).why, 'entry');
  assert.strictEqual(workingEntryOf(longStop, [{ ...entry, id: 20 }, longStop]), null, 'placed after the stop: not its entry');
  assert.strictEqual(workingEntryOf(longStop, [{ ...entry, status: 3 }, longStop]), null, 'cancelled');
  assert.strictEqual(workingEntryOf(longStop, [{ ...entry, side: 1 }, longStop]), null, 'the stop\'s own side');
  assert.strictEqual(workingEntryOf(longStop, [{ ...entry, contractId: 'MNQ:2027-03' }, longStop]), null, 'another month');
  assert.strictEqual(workingEntryOf(longStop, [{ ...entry, id: 'abc' }, longStop]).id, 'abc', 'an id that is no number counts');
});

test('stopHeld cover: false (the runner\'s cleanup) holds every stop of the evidenced side; evidenceCover sizes it, fails closed', () => {
  const { evidenceCover } = require('../../scripts/lib/trading/fill-evidence');
  const part = { ...longStop, size: 3 };
  const rest = { ...longStop, id: 13, size: 6 };
  const facts = { orders: [part, rest], fills: [], history: [longEntry] };
  assert.strictEqual(stopHeld(part, { ...facts, orders: [part, { ...rest, size: 9 }] }), null, 'the gate: covered by the other');
  assert.strictEqual(stopHeld(part, { ...facts, orders: [part, { ...rest, size: 9 }] }, { cover: false }).why, 'fills', 'the runner: held');
  assert.strictEqual(evidenceCover(longStop, { fills: [], history: [longEntry] }), 9);
  assert.strictEqual(evidenceCover(shortStop, { fills: [], history: [longEntry] }), 0, 'the other side');
  assert.strictEqual(evidenceCover(longStop, {}), 0, 'no reads made');
  assert.throws(() => evidenceCover(longStop, { fills: null, history: [] }), /not a list/);
  assert.throws(() => evidenceCover(longStop, { fills: [fill(11, 0, 'x')], history: [] }), /can't be read/);
});
