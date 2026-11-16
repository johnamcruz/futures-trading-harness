'use strict';

// The open trade's manage read (scripts/lib/trading/manage-read.js): the code floor's lock, the 15m BOS protected swing
// the trade's way since entry, a 15m CHoCH against, the warning giveback; each level against the working stop.

const test = require('node:test');
const assert = require('node:assert');
const { manageRead, manageReadLine } = require('../../scripts/lib/trading/manage-read');

const T0 = Date.parse('2026-10-05T13:30:00Z');
/** 15m candles [o, h, l, c] as five 3m bars each (aggregating back to the same candle). */
function bars15(candles, f = x => x) {
  const out = [];
  candles.forEach(([o0, h0, l0, c0], j) => {
    const [o, c] = [f(o0), f(c0)];
    const [h, l] = f(h0) >= f(l0) ? [f(h0), f(l0)] : [f(l0), f(h0)];
    const five = [{ o, h: Math.max(o, c), l: Math.min(o, c), c: o }, { o, h, l: Math.min(o, c), c: o }, { o, h: Math.max(o, c), l, c: o }, { o, h: Math.max(o, c), l: Math.min(o, c), c }, { o: c, h: c, l: c, c }];
    five.forEach((b, k) => out.push({ t: new Date(T0 + (j * 5 + k) * 180000).toISOString(), v: 1, ...b }));
  });
  return out;
}
// A swing high 108 (c2), then a close at 109 (c6) through it: a 15m BOS up; its protected low 100 (c4).
const UP = [[100, 102, 99, 101], [101, 104, 100, 103], [103, 108, 102, 106], [106, 107, 101, 102], [102, 105, 100, 104], [104, 106, 101, 105], [105, 110, 104, 109]];
const EXIT = { lockGivebackR: 1.5, trailBy: 'structure', trailR: 1, swingMinutes: 15, lockAtR: 1, lockToTicks: 2, warningGivebackR: 0.5 };
const opened = new Date(T0 + 3 * 15 * 60000).toISOString(); // filled at c3's open (106)

test('manageRead: a 15m BOS the trade\'s way since entry gives its protected swing and the stop a tick beyond; the lock and the warning giveback are levels', () => {
  const m = manageRead({ side: 'long', entry: 106, risk: 10, stop: 96, openedAt: opened, bars: bars15(UP), base: 3, tick: 0.25, exit: EXIT });
  assert.deepStrictEqual([m.best, m.bestR, m.workingR], [110, 0.4, -1]);
  assert.deepStrictEqual(m.bos, { level: 100, broken: false, stop: 99.75, tighter: true, past: false });
  assert.deepStrictEqual(m.lock, { atR: 1, stop: 106.5, reached: false });
  assert.deepStrictEqual(m.warning, { r: 0.5, stop: 105, tighter: true, past: false });
  assert.strictEqual(m.choch, null);
  const line = manageReadLine(m);
  assert.match(line, /STOP <price\|hold>: <reason>/);
  assert.match(line, /15m BOS up since entry: protected swing 100 holds, stop beyond it 99\.75 \(tighter than the working stop\)/);
  assert.match(line, /code floor: from \+1R the runner holds the stop at 106\.5 \(not reached yet\)/);
  assert.match(line, /warning giveback \(0\.5R behind the best\): 105 \(tighter than the working stop\)/);
  // A working stop already past them: not tighter (by less than a tick counts as not).
  const past = manageRead({ side: 'long', entry: 106, risk: 10, stop: 105, openedAt: opened, bars: bars15(UP), base: 3, tick: 0.25, exit: EXIT });
  assert.deepStrictEqual([past.bos.tighter, past.warning.tighter], [false, false]);
  // A level at or past the last close is no stop to rest: said so, never 'tighter' (the warning giveback after a deep pullback).
  const deep = manageRead({ side: 'long', entry: 106, risk: 2, stop: 96, openedAt: opened, bars: bars15(UP), base: 3, tick: 0.25, exit: EXIT });
  assert.deepStrictEqual([deep.warning.stop, deep.warning.past, deep.warning.tighter], [109, true, false], 'best 110 - 0.5 x 2 = 109, snapped 109; last close 109');
  // The fact only, no advice in it (the skill keeps "past the price -> hold").
  assert.match(manageReadLine(deep), /past the price: a stop there would fill at once/);
  const facts = x => x.slice(x.indexOf('only when tighter): ')); // the facts after the header's instruction (kept)
  assert.doesNotMatch(facts(manageReadLine(deep)), /\bhold\b/, 'no "hold" in any Manage read fact');
  // The working stop and the best are the Position line's: not repeated here.
  assert.doesNotMatch(line, /working stop \d|; best \d/);
  // Filled after the break: no BOS since entry.
  const late = manageRead({ side: 'long', entry: 109, risk: 10, stop: 99, openedAt: new Date(T0 + 7 * 15 * 60000).toISOString(), bars: bars15([...UP, [109, 111, 108, 110]]), base: 3, tick: 0.25, exit: EXIT });
  assert.strictEqual(late.bos, null);
  // No warning giveback or lock in the plan: none shown.
  const bare = manageRead({ side: 'long', entry: 106, risk: 10, stop: 96, openedAt: opened, bars: bars15(UP), base: 3, tick: 0.25, exit: { trailBy: 'r' } });
  assert.deepStrictEqual([bare.lock, bare.warning], [null, null]);
  assert.match(manageReadLine(bare), /code floor: no early lock; .*warning giveback: none set/);
});

test('manageRead: the short mirror; a CHoCH against since entry is shown; unavailable inputs say why', () => {
  const f = x => 200 - x;
  const m = manageRead({ side: 'short', entry: 94, risk: 10, stop: 104, openedAt: opened, bars: bars15(UP, f), base: 3, tick: 0.25, exit: EXIT });
  assert.deepStrictEqual(m.bos, { level: 100, broken: false, stop: 100.25, tighter: true, past: false });
  assert.deepStrictEqual(m.warning.stop, 95);
  // Then a close back under the protected low (99): a CHoCH down against the long, the protected swing broken.
  const turned = [...UP, [109, 109, 101, 103], [103, 104, 98, 99]];
  const t = manageRead({ side: 'long', entry: 106, risk: 10, stop: 96, openedAt: opened, bars: bars15(turned), base: 3, tick: 0.25, exit: EXIT });
  assert.ok(t.choch, JSON.stringify(t));
  assert.strictEqual(t.bos.broken, true);
  assert.match(manageReadLine(t), /protected swing 100 BROKEN by a close; 15m CHoCH against since entry: through/);
  assert.match(manageReadLine(manageRead({ side: 'long', entry: 106, risk: 0, stop: 96, openedAt: opened, bars: [], base: 3, tick: 0.25 })), /Manage read: unavailable \(no side, entry, risk/);
  assert.match(manageReadLine(manageRead({ side: 'long', entry: 106, risk: 10, stop: 96, openedAt: '2027-01-01T00:00:00Z', bars: bars15(UP), base: 3, tick: 0.25 })), /no closed bar since the fill/);
});

test('manageRead, one basis: the first bar counted is `from` (the runner\'s rule) and the best is the held trade\'s when given', () => {
  // A bar that opened just before the fill (inside the runner's grace) is counted from `from`, not from the fill.
  const before = manageRead({ side: 'long', entry: 106, risk: 10, stop: 96, openedAt: new Date(Date.parse(opened) + 20000).toISOString(), bars: bars15(UP), base: 3, tick: 0.25, exit: EXIT });
  const graced = manageRead({ side: 'long', entry: 106, risk: 10, stop: 96, openedAt: new Date(Date.parse(opened) + 20000).toISOString(), from: opened, bars: bars15(UP), base: 3, tick: 0.25, exit: EXIT });
  assert.ok(before.best <= graced.best);
  // The held trade's best price decides the warning level (best 112 - 0.5 x 10 = 107).
  const held = manageRead({ side: 'long', entry: 106, risk: 10, stop: 96, openedAt: opened, bars: bars15(UP), base: 3, tick: 0.25, exit: EXIT, best: 112 });
  assert.deepStrictEqual([held.best, held.bestR, held.warning.stop], [112, 0.6, 107]);
});
