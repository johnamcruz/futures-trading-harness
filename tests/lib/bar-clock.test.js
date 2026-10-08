'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { barCloseMs, stateFromBars, barAction, onBars, sleepMs, barStep } = require('../../scripts/lib/bar-clock');

const T0 = Date.UTC(2026, 9, 7, 14, 0); // 10:00 ET
const bar = (min, c = 100) => ({ t: new Date(T0 + min * 60000).toISOString(), o: c, h: c, l: c, c, v: 1 });
const at = (min, sec = 0) => new Date(T0 + min * 60000 + sec * 1000);
const opts = { minutes: 3, delayMs: 2000, timeoutMs: 60000, pollMs: 2000 };

test('schedule: the next close is two bars after the last closed bar open', () => {
  const s = stateFromBars([bar(0), bar(3)], 3);
  assert.strictEqual(s.lastBarT, bar(3).t);
  assert.strictEqual(s.expectedCloseAt, T0 + 9 * 60000);
  assert.strictEqual(barCloseMs(bar(3), 3), T0 + 6 * 60000);
  assert.deepStrictEqual(stateFromBars([], 3).expectedCloseAt, null);
});

test('barAction waits, polls after the delay, and resyncs after the timeout', () => {
  const s = stateFromBars([bar(3)], 3); // next close at 9:00
  assert.strictEqual(barAction(s, at(8, 59), opts), 'wait');
  assert.strictEqual(barAction(s, at(9, 1), opts), 'wait'); // inside the 2s delay
  assert.strictEqual(barAction(s, at(9, 2), opts), 'poll');
  assert.strictEqual(barAction(s, at(10, 3), opts), 'resync');
  assert.strictEqual(barAction(null, at(0), opts), 'resync');
});

test('onBars reports only new bars and flags late ones as stale', () => {
  const s = stateFromBars([bar(3)], 3);
  assert.strictEqual(onBars(s, [bar(3)], at(9, 3), 3).bar, null);
  const fresh = onBars(s, [bar(3), bar(6)], at(9, 3), 3);
  assert.strictEqual(fresh.bar.t, bar(6).t);
  assert.strictEqual(fresh.stale, false);
  assert.strictEqual(fresh.state.expectedCloseAt, T0 + 12 * 60000);
  assert.strictEqual(onBars(s, [bar(6)], at(11), 3).stale, true); // 2 min after a 3m bar closed
});

test('sleepMs sleeps until the next close, bounded', () => {
  const s = stateFromBars([bar(3)], 3);
  assert.strictEqual(sleepMs([s], at(8, 58), { delayMs: 2000 }), 4000);
  assert.strictEqual(sleepMs([s], at(5), { delayMs: 2000 }), 5000);
  assert.strictEqual(sleepMs([s], at(9, 30), { delayMs: 2000 }), 250);
  assert.strictEqual(sleepMs([null], at(0), { delayMs: 0 }), 250);
});

test('barStep: startup resync, waiting, polling until the bar appears, then a cycle', async () => {
  let published = [bar(0), bar(3)];
  let fetches = 0;
  const fetch = async () => { fetches += 1; return published; };
  let sym = { symbol: 'MNQ', contractId: 'C', clock: null, lastPollAt: 0 };

  // Startup at 10:07:40: last closed bar (10:03-10:06) is 100s old (> half a bar) -> stale, schedule armed for 10:09.
  let r = await barStep(sym, at(7, 40), opts, fetch);
  assert.strictEqual(r.event, 'stale');
  sym = r.sym;
  assert.strictEqual(sym.clock.expectedCloseAt, T0 + 9 * 60000);

  assert.strictEqual((await barStep(sym, at(8, 0), opts, fetch)).event, 'wait');
  r = await barStep(sym, at(9, 2), opts, fetch); // closed, but not published yet
  assert.strictEqual(r.event, 'no-bar');
  sym = r.sym;
  assert.strictEqual((await barStep(sym, at(9, 3), opts, fetch)).event, 'wait'); // poll interval
  published = [bar(0), bar(3), bar(6)];
  r = await barStep(sym, at(9, 4), opts, fetch);
  assert.strictEqual(r.event, 'bar');
  assert.strictEqual(r.bar.t, bar(6).t);
  assert.strictEqual(r.sym.clock.expectedCloseAt, T0 + 12 * 60000);
  assert.strictEqual(fetches, 3);
});

test('barStep re-arms after a timeout with no bar (daily break) instead of hammering the API', async () => {
  const sym = { symbol: 'MNQ', contractId: 'C', clock: stateFromBars([bar(3)], 3), lastPollAt: 0 };
  const r = await barStep(sym, at(11), opts, async () => [bar(3)]);
  assert.strictEqual(r.event, 'resync');
  assert.strictEqual(r.sym.clock.expectedCloseAt, at(11).getTime() + 3 * 60000);
});
