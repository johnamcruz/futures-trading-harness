'use strict';

// The open trade's read applied mechanically (replay/read-mechanical.js), and the acceptance the read's teaching must
// pass on real bars (feat/ride-or-exit, review round 2): applied to the letter on the biggest run of
// tests/fixtures/data/bars.csv, it keeps at least as much of the move as the runner's own 15m structure trail, and
// weakening is rare on that healthy trend's bars.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { applyRead } = require('../../scripts/lib/replay/read-mechanical');
const { tradeRead } = require('../../scripts/lib/trading/trade-read');

const rows = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'data', 'bars.csv'), 'utf8').trim().split('\n').slice(1)
  .map(l => { const [t, o, h, lo, c, v] = l.split(','); return { t, o: +o, h: +h, l: +lo, c: +c, v: +v }; });

/** The biggest move by close between two bars at least 20 apart: the fixture's trend. */
function biggestRun() {
  let best = null;
  for (let i = 20; i < rows.length - 30; i += 1) for (let j = i + 20; j < rows.length; j += 1) {
    const d = rows[j].c - rows[i].c;
    if (!best || Math.abs(d) > Math.abs(best.d)) best = { i, j, d };
  }
  return best;
}

test('acceptance: on the fixture\'s biggest run the read, applied mechanically, keeps at least the runner\'s 15m trail; weakening is rare', () => {
  const run = biggestRun();
  const side = run.d > 0 ? 'long' : 'short';
  assert.deepStrictEqual([side, rows[run.i].t, run.d], ['long', '2026-04-24T04:24:00Z', 327.5]);
  const entry = rows[run.i].c;
  const openedAt = rows[run.i].t;
  const bars = rows.slice(0, run.j + 1);
  const stop = Math.min(...rows.slice(run.i - 5, run.i + 1).map(b => b.l)) - 0.25;
  const o = { side, entry, openedAt, stop, bars, base: 3, tick: 0.25 };
  const trail = applyRead({ ...o, trail: true, read: false });
  const readOnly = applyRead({ ...o, trail: false, read: true });
  const both = applyRead({ ...o, trail: true, read: true });
  // The runner's own trail behind 15m swings kept 50.25 of the 327.5 points; the read alone kept them all.
  assert.strictEqual(trail.points, 50.25);
  assert.ok(readOnly.points >= trail.points, `read ${readOnly.points} < trail ${trail.points}`);
  assert.strictEqual(readOnly.points, 327.5);
  assert.ok(both.points >= trail.points);
  // The weakening base rate on the run's bars (a healthy trend): at most 5%.
  let n = 0;
  let weak = 0;
  for (let k = run.i + 1; k <= run.j; k += 1) {
    const r = tradeRead({ side, entry, openedAt, bars: rows.slice(0, k + 1), base: 3, tick: 0.25 });
    if (r.unavailable) continue;
    n += 1;
    weak += r.weakening ? 1 : 0;
  }
  assert.ok(n > 100 && weak / n <= 0.05, `weakening on ${weak} of ${n} bars`);
});

test('applyRead: the stop, the read\'s reversal exit and its tighten to the trail level, the trade\'s own exit', () => {
  // A trend up, then a 15m break down: the read exits at the close of the bar it confirms on.
  const closes = [];
  let p = 21000;
  for (const [n, d] of [[40, 1], [20, -1], [40, 1], [20, -1], [40, 1], [20, -1], [40, 1], [60, -1.5]]) for (let i = 0; i < n; i += 1) closes.push((p += d));
  const bars = closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: new Date(Date.parse('2026-10-05T12:00:00.000Z') + i * 180000).toISOString(), o, h: Math.max(o, c) + (c >= o ? 1 : 0.5), l: Math.min(o, c) - (c <= o ? 1 : 0.5), c, v: 100 };
  });
  const o = { side: 'long', entry: bars[20].c, openedAt: bars[20].t, stop: 20990, bars, base: 3, tick: 0.25 };
  const r = applyRead({ ...o, read: true });
  assert.ok(/^reversal: 15m/.test(r.exit.why) || r.exit.why === 'stop', r.exit.why);
  assert.ok(r.points > 0);
  // Initial stop only: out at the stop or the end, never by a read.
  const none = applyRead({ ...o, read: false });
  assert.ok(['stop', 'end'].includes(none.exit.why));
  // The trade's own exit ends it when nothing came first.
  const own = applyRead({ ...o, read: false, exitAt: Date.parse(bars[60].t), exitPrice: 21030 });
  assert.deepStrictEqual([own.exit.why, own.points], ['the trade\'s own exit', 21030 - o.entry]);
  // A stop the first bar trades through exits there.
  const hit = applyRead({ ...o, stop: bars[21].l + 0.25, read: false });
  assert.deepStrictEqual([hit.exit.why, hit.exit.price], ['stop', bars[21].l + 0.25]);
});
