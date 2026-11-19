'use strict';

// P1 (feat/p1-mtf-entries): what a run records about an MTF arm. The trade record (session/record.js withEntry) keeps an
// MTF entry's stamp and the trigger-to-entry lag (seconds from the trigger bar's close to the fill, and its cost in R:
// the fill past the trigger bar's close, by the plan's 1R), so the replay measures what waiting for the close costs.
// The run's fingerprints and the replay's config hash name the arm only when it is not today's (older runs keep theirs).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withEntry, fingerprints } = require('../../scripts/lib/session/record');

const STAMP = { record: 'r', entry: 21540.25, stop: 21528.75, target: 21563.25, side: 'long', mtf: { arm: 'B', model: 'aggressive', rank: 1, trigger: { kind: 'CHoCH', frame: '1m', at: '2026-10-07T13:58:00.000Z', price: 21537.5 }, prevHigh: 21598 } };
const spec = () => ({ tickValue: 0.5 });

test('withEntry: an MTF entry\'s fill carries its stamp and the lag (seconds, points, R by the plan\'s 1R); long and short', () => {
  const f = withEntry({ orderId: 5, contractId: 'MNQ', profitAndLoss: null, price: 21540.25, side: 0, creationTimestamp: '2026-10-07T14:00:05.000Z' }, [{ orderId: 5, setup: 'trade_lifecycle', stopTicks: 46, side: 'buy', composed: STAMP }], spec);
  assert.deepEqual(f.entry.mtf, { ...STAMP.mtf, lag: { seconds: 125, points: 2.75, r: 0.24 } });
  // A short: the fill under the trigger's close is the cost.
  const s = { ...STAMP, side: 'short', entry: 21530, stop: 21540, mtf: { ...STAMP.mtf, trigger: { ...STAMP.mtf.trigger, price: 21532 } } };
  const fs = withEntry({ orderId: 6, contractId: 'MNQ', profitAndLoss: null, price: 21530, side: 1, creationTimestamp: '2026-10-07T13:58:30.000Z' }, [{ orderId: 6, setup: 'trade_lifecycle', stopTicks: 40, side: 'sell', composed: s }], spec);
  assert.deepEqual(fs.entry.mtf.lag, { seconds: 30, points: 2, r: 0.2 });
  // No trigger time or price: the lag unknown (nulls), never a guess.
  const n = withEntry({ orderId: 7, contractId: 'MNQ', profitAndLoss: null, price: 1, creationTimestamp: 'x' }, [{ orderId: 7, setup: 'trade_lifecycle', side: 'buy', composed: { ...STAMP, mtf: { arm: 'A' } } }], spec);
  assert.deepEqual(n.entry.mtf.lag, { seconds: null, points: null, r: null });
  // Any other entry: unchanged (no mtf key).
  const o = withEntry({ orderId: 8, contractId: 'MNQ', profitAndLoss: null }, [{ orderId: 8, setup: 'orb', stopTicks: 20 }], spec);
  assert.deepEqual(o.entry, { setup: 'orb', stopTicks: 20, tickValue: 0.5 });
});

test('fingerprints: today\'s arm (the committed default) adds nothing; the arm is named only when another', () => {
  assert.equal('mtfEntry' in fingerprints(null, { code: 'x' }), false);
  assert.deepEqual(fingerprints(null, { code: 'x', mtfEntry: { arm: 'B', exitMode: 'trail', entryPullback: 'any', minStage: 'potential' } }).mtfEntry, { arm: 'B', exitMode: 'trail', entryPullback: 'any', minStage: 'potential' });
  assert.equal('mtfEntry' in fingerprints(null, { code: 'x', mtfEntry: { arm: 'D', exitMode: 'trail', entryPullback: 'any', minStage: 'established' } }), false);
});
