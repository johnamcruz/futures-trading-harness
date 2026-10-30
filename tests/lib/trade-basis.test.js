'use strict';

// A round trip's R on the stop it held (scripts/lib/replay/trade-basis.js): the runner's move to the plan's stop after
// the fill, read from its event log, rescales the broker's R, MAE and MFE; a 'trail' exit at that stop is a 'stop'.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const TB = require('../../scripts/lib/replay/trade-basis');
const { outcomeOf } = require('../../scripts/lib/replay/labels');
const { tmpDir } = require('../helpers');

// 2021-06-24's long: filled 14374.25, the bracket stop 14359.5 (14.75 points), moved to the plan's 14361.75 (12.5).
const RT = (over = {}) => ({ contractId: 'MNQ', direction: 'long', entryTime: '2021-06-24T14:03:30.363Z', exitTime: '2021-06-24T15:01:00.000Z', averageEntryPrice: 14374.25, exitPrice: 14387,
  reason: 'trail', initialStop: 14359.5, risk: 14.75, r: 0.864, maeR: 0, mfeR: 2.542, ...over });
const PLAN_STOP = { at: '2021-06-24T14:03:31.612Z', kind: 'stop_moved', symbol: 'MNQ', contractId: 'MNQ', setup: 'prop_portfolio', from: 14359.5, to: 14361.75, why: 'plan stop' };
const TRAIL = { at: '2021-06-24T14:36:04.253Z', kind: 'stop_moved', symbol: 'MNQ', contractId: 'MNQ', from: 14361.75, to: 14387.25, peakR: 2.66 };

test('trade basis: only the runner\'s moves to the plan\'s stop count, the first from the fill to the exit, of the same market', () => {
  const moves = TB.planStops([TRAIL, PLAN_STOP, { ...PLAN_STOP, to: 'x' }, null, { kind: 'position_closed', at: PLAN_STOP.at }]);
  assert.deepStrictEqual(moves, [{ ms: Date.parse(PLAN_STOP.at), to: 14361.75, fam: 'MNQ' }]);
  const span = { fam: 'MNQ', fromMs: Date.parse(RT().entryTime), toMs: Date.parse(RT().exitTime) };
  assert.strictEqual(TB.heldStop(moves, span), 14361.75);
  assert.strictEqual(TB.heldStop(moves, { ...span, fam: 'MES' }), null, 'another market');
  assert.strictEqual(TB.heldStop(moves, { ...span, fromMs: span.fromMs + 5000 }), null, 'before this fill: another trade\'s');
  assert.strictEqual(TB.heldStop(moves, { ...span, toMs: NaN }), 14361.75, 'still open: to now');
  assert.strictEqual(TB.heldStop(moves, { ...span, fromMs: NaN }), null);
  // From a run home's event logs; none: [].
  const home = tmpDir();
  assert.deepStrictEqual(TB.readPlanStops(home), []);
  fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(path.join(home, 'logs', 'events-2021-06-24.jsonl'), `${JSON.stringify(PLAN_STOP)}\n{torn\n${JSON.stringify(TRAIL)}\n`);
  assert.deepStrictEqual(TB.readPlanStops(home), moves);
});

test('trade basis: on the stop it held, 06-24\'s +0.864R is +1.02R; no move, or a move to the same distance, keeps the broker\'s', () => {
  const held = TB.onHeldStop(RT(), { stop: 14361.75, tick: 0.25 });
  // 12.75 points over 12.5: 1.02R; the best 2.542R x 14.75 / 12.5 = 3.0R.
  assert.deepStrictEqual(held, { r: 1.02, maeR: 0, mfeR: 3, risk: 12.5, reason: 'trail', rBasis: 'held stop' }, 'a trail move above the entry: still a trail');
  assert.deepStrictEqual(TB.onHeldStop(RT(), { stop: null, tick: 0.25 }), { r: 0.864, maeR: 0, mfeR: 2.542, risk: 14.75, reason: 'trail', rBasis: 'bracket stop' });
  assert.strictEqual(TB.onHeldStop(RT(), { stop: 14359.5, tick: 0.25 }).rBasis, 'bracket stop');
  // A stop on the wrong side of the entry is no held stop (never a negative or infinite risk).
  assert.strictEqual(TB.onHeldStop(RT(), { stop: 14380, tick: 0.25 }).r, 0.864);
  assert.strictEqual(TB.onHeldStop(null, {}).r, null);
});

test('trade basis: the broker\'s "trail" for an exit at the stop held or worse is "stop" (2021-07-19); a stop moved toward profit stays "trail"', () => {
  // 07-19's short: filled 14494.5, the bracket 14557.25 (62.75), moved to the plan's 14545.25 (50.75); out a tick
  // worse, at 14545.5: -0.813R by the broker, -1.005R on the stop it held, and a stop, not a trail.
  const short = { contractId: 'MNQ', direction: 'short', averageEntryPrice: 14494.5, exitPrice: 14545.5, reason: 'trail', initialStop: 14557.25, risk: 62.75, r: -0.813, maeR: -0.813, mfeR: 0.789 };
  assert.deepStrictEqual(TB.onHeldStop(short, { stop: 14545.25, tick: 0.25 }), { r: -1.005, maeR: -1.005, mfeR: 0.976, risk: 50.75, reason: 'stop', rBasis: 'held stop' });
  // At the bracket's own stop, never moved: a stop too.
  assert.strictEqual(TB.onHeldStop({ ...short, exitPrice: 14557.25 }, { stop: null, tick: 0.25 }).reason, 'stop');
  // A stop moved a tick toward profit and filled there: the broker's trail stands.
  assert.strictEqual(TB.onHeldStop({ ...short, exitPrice: 14544.75 }, { stop: 14545.25, tick: 0.25 }).reason, 'trail');
  // Another reason is never touched.
  assert.strictEqual(TB.onHeldStop({ ...short, reason: 'close' }, { stop: 14545.25, tick: 0.25 }).reason, 'close');
});

test('trade basis: the labels\' outcome (the scorecard\'s trade R) on the stop held, marked rBasis; without a move, as before', () => {
  const trip = held => outcomeOf({ contractId: 'MNQ', side: 'buy', openMs: Date.parse(RT().entryTime), closeMs: Date.parse(RT().exitTime), openSize: 9, closedSize: 9,
    opens: [{ creationTimestamp: RT().entryTime, price: 14374.25, profitAndLoss: null, fees: 3.33 }],
    closes: [{ creationTimestamp: RT().exitTime, price: 14387, profitAndLoss: 229.5, fees: 3.33, roundTrip: { ...RT(), net: 222.84 } }] }, 59, null, held);
  const before = trip(null);
  assert.deepStrictEqual([before.r, before.mfeR, before.exitReason, before.rBasis], [0.864, 2.542, 'trail', undefined]);
  const after = trip(14361.75);
  assert.deepStrictEqual([after.r, after.mfeR, after.net, after.rBasis], [1.02, 3, 222.84, 'held stop']);
  // No broker round trip: P&L over the risk on the held stop (12.5 points x $2 x 9 = $225).
  const bare = outcomeOf({ contractId: 'MNQ', side: 'buy', openMs: Date.parse(RT().entryTime), closeMs: Date.parse(RT().exitTime), openSize: 9, closedSize: 9,
    opens: [{ creationTimestamp: RT().entryTime, price: 14374.25, profitAndLoss: null, fees: 3.33 }], closes: [{ creationTimestamp: RT().exitTime, price: 14387, profitAndLoss: 229.5, fees: 3.33 }] }, 59, null, 14361.75);
  assert.deepStrictEqual([bare.r, bare.rBasis], [1.02, 'held stop']);
});
