'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { recordFile } = require('../../scripts/lib/trading/trade-lifecycle');
const { shadowFile, readShadow, recordShadow } = require('../../scripts/lib/trading/lesson-shadow');
const { tmpDir } = require('../helpers');

const TF = 3 * 60000;
const T0 = Date.parse('2024-06-12T14:00:00.000Z'); // 10:00 ET
const iso = ms => new Date(ms).toISOString();
// 3m bars from T0: flat at 100, then a rally to 110 from bar 3.
const bars = Array.from({ length: 20 }, (_, k) => {
  const c = k < 3 ? 100 : Math.min(110, 100 + (k - 2) * 1.5);
  return { t: iso(T0 + k * TF), o: k < 3 ? 100 : c - 1.5, h: c + 0.25, l: k < 3 ? 99.75 : c - 1.75, c };
});
// An ok composed long on bar 0 (a limit at 100, stop 98, target 104): the kind a lesson advised against.
const rec = (id, side, entry, stop, target, barMs, ok = true) => ({ schema: 1, id, at: iso(barMs + TF + 2000), strategy: 'trade_lifecycle', root: 'MNQ', side, bar: iso(barMs), expiresAt: iso(barMs + 3 * TF), ok, plan: ok ? { entry: { type: 'limit', price: entry }, stop: { price: stop }, target: { price: target }, tick: 0.25 } : null });

function home(records) {
  const h = tmpDir();
  const file = recordFile(h, 'MNQ', '2024-06-12');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => `${JSON.stringify(r)}\n`).join(''));
  return h;
}

test('the shadow record: each verified composed plan walked forward on the closed bars, once, only when settled by now', () => {
  const h = home([
    rec('long1', 'long', 100, 98, 104, T0),
    rec('short1', 'short', 100, 102, 96, T0), // stopped as the rally runs
    rec('nofill', 'short', 120, 122, 116, T0), // never trades 120 before it expires
    rec('refused', 'long', 100, 98, 104, T0, false), // not verified: no plan, never walked
  ]);
  // Before the long's target trades (bar 4's close): the long is open; the short's stop (one tick of slippage) and the
  // plan that never filled are settled.
  const early = new Date(T0 + 5 * TF);
  assert.strictEqual(recordShadow(h, { root: 'MNQ', bars, minutes: 3, tick: 0.25, now: early }), 2);
  const a = readShadow(h, early);
  assert.deepStrictEqual(a.map(x => [x.id, x.R]), [['short1', -1.125], ['nofill', null]]);
  // Later: the long settles at its target; nothing is written twice; no bar after now is read.
  const later = new Date(T0 + 12 * TF);
  assert.strictEqual(recordShadow(h, { root: 'MNQ', bars, minutes: 3, tick: 0.25, now: later }), 1);
  assert.strictEqual(recordShadow(h, { root: 'MNQ', bars, minutes: 3, tick: 0.25, now: later }), 0);
  const all = readShadow(h, later);
  const long = all.find(x => x.id === 'long1');
  assert.strictEqual(long.R, 2);
  assert.strictEqual(long.exitReason, 'target');
  assert.ok(Date.parse(long.exitTime) <= later.getTime());
  // A reader with an earlier clock never sees an outcome settled after it.
  assert.ok(!readShadow(h, early).some(x => x.id === 'long1'));
  assert.deepStrictEqual(readShadow(h, null), []);
  assert.strictEqual(fs.readFileSync(shadowFile(h), 'utf8').trim().split('\n').length, 3);
});

test('the shadow record writes nothing without bars, a clock or records', () => {
  const h = tmpDir();
  assert.strictEqual(recordShadow(h, { root: 'MNQ', bars: [], minutes: 3, tick: 0.25, now: new Date(T0) }), 0);
  assert.strictEqual(recordShadow(h, { root: 'MNQ', bars, minutes: 3, tick: 0.25, now: null }), 0);
  assert.strictEqual(recordShadow(h, { root: 'MNQ', bars, minutes: 3, tick: 0.25, now: new Date(T0 + 10 * TF) }), 0);
  assert.ok(!fs.existsSync(shadowFile(h)));
});

test('the shadow record ends a plan at the runner\'s close: a fill after it is not held past it (eodOf)', () => {
  const h = home([rec('late', 'long', 100, 98, 104, T0)]);
  const now = new Date(T0 + 12 * TF);
  // The close falls before the limit's bar fills (bar 1 on): the plan never fills that day.
  const early = recordShadow(h, { root: 'MNQ', bars, minutes: 3, tick: 0.25, now, eodOf: () => T0 + 1 * TF });
  assert.strictEqual(early, 1);
  assert.strictEqual(readShadow(h, now).find(x => x.id === 'late').R, null, 'unfilled before the close: no outcome');
  const h2 = home([rec('late', 'long', 100, 98, 104, T0)]);
  recordShadow(h2, { root: 'MNQ', bars, minutes: 3, tick: 0.25, now });
  assert.strictEqual(readShadow(h2, now).find(x => x.id === 'late').R, 2, 'control: no close given, the same plan reaches its target');
});
