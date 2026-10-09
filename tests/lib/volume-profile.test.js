'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildProfile, profileSeries, nearest, describe, optionsFromParams, DEFAULTS } = require('../../scripts/lib/trading/volume-profile');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { etInfo } = require('../../scripts/lib/trading/indicators');

const NQ = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const T0 = Date.UTC(2026, 9, 7, 14, 0);
// One bar per row of a 1-point grid: bar k covers [lo, lo + 1] with volume v.
const rowBars = vols => vols.map((v, k) => ({ t: new Date(T0 + k * 180000).toISOString(), o: 100 + k, h: 101 + k, l: 100 + k, c: 100.5 + k, v }));

test('volume is spread over the rows a bar covers, in proportion to the overlap, and conserved', () => {
  const bars = [{ t: 'x', o: 100, h: 104, l: 100, c: 103, v: 400 }, { t: 'y', o: 102, h: 102, l: 101, c: 101, v: 100 }];
  const p = buildProfile(bars, 0, 1, { rowSize: 1 });
  assert.strictEqual(p.low, 100);
  assert.strictEqual(p.rows.length, 4); // 100..104: a high on a row's lower edge adds no row
  assert.deepStrictEqual(p.rows.map(r => r.volume), [100, 200, 100, 100]); // 101-102 gets the second bar's 100
  assert.deepStrictEqual(p.rows.map(r => r.up), [100, 100, 100, 100]); // only the first bar closed up
  assert.strictEqual(p.total, 500);
  assert.strictEqual(p.poc, 101, 'on a grid, the row\'s grid price');
  assert.strictEqual(buildProfile(bars, 0, 1, { rows: 4 }).poc, 101.5, 'with rows, the row\'s middle');
});

test('a bar with no range puts all its volume in its row (the source divides by zero there)', () => {
  const p = buildProfile([{ o: 100, h: 102, l: 100, c: 101, v: 10 }, { o: 101.5, h: 101.5, l: 101.5, c: 101.5, v: 50 }], 0, 1, { rowSize: 1 });
  assert.deepStrictEqual(p.rows.map(r => r.volume), [5, 55]);
  assert.strictEqual(buildProfile([{ o: 1, h: 1, l: 1, c: 1, v: 5 }], 0, 0), null); // no range at all
  assert.strictEqual(buildProfile([{ o: 1, h: 2, l: 1, c: 1, v: 0 }], 0, 0), null); // no volume
});

test('POC, then the value area grows toward the bigger neighbour (up on a tie) until it holds 70%', () => {
  const p = buildProfile(rowBars([5, 10, 20, 40, 20, 3, 2]), 0, 6, { rowSize: 1 });
  assert.strictEqual(p.poc, 103);
  // 40, then +20 above (tie goes up), +20 below = 80 of 100: VAL 102, VAH 105.
  assert.strictEqual(p.val, 102);
  assert.strictEqual(p.vah, 105);
  const inside = p.rows.filter(r => r.low >= p.val && r.high <= p.vah).reduce((a, r) => a + r.volume, 0);
  assert.ok(inside >= 0.7 * p.total);
  // A 100-row profile over the same bars: the levels are the window's own split.
  const q = buildProfile(rowBars([5, 10, 20, 40, 20, 3, 2]), 0, 6);
  assert.strictEqual(q.rows.length, DEFAULTS.rows);
  assert.ok(q.val >= 100 && q.vah <= 108 && q.val < q.poc && q.poc < q.vah);
});

test('peaks and troughs: above (below) each of the N rows on both sides, ignoring rows under the threshold', () => {
  const vols = [1, 5, 9, 5, 1, 2, 8, 30, 8, 2, 0.1, 4];
  const p = buildProfile(rowBars(vols), 0, vols.length - 1, { rowSize: 1, nodePct: 2 / 12 + 1e-9, troughPct: 1 / 12 + 1e-9, threshold: 0.01 });
  // 9 and 30 beat two rows each side; the top row's 4 too (beyond the profile counts as 0).
  assert.deepStrictEqual(p.hvn, [102, 107, 111]);
  // 1 at row 4 is a trough, and the bottom row's 1 (beyond counts as the POC's 30);
  // 0.1 at row 10 is under 1% of the POC's volume, so ignored.
  assert.deepStrictEqual(p.lvn, [100, 104]);
  assert.strictEqual(nearest(p.hvn, 104, 1), 107);
  assert.strictEqual(nearest(p.hvn, 104, -1), 102);
  assert.ok(Number.isNaN(nearest(p.lvn, 104, 1)));
});

test('no look-ahead: every window gives bar i the same levels from bars 0..i as from the whole series', () => {
  const kinds = [['prior_rth', {}], ['session', {}], ['rolling', { length: 120 }]];
  const full = Object.fromEntries(kinds.map(([k, o]) => [k, profileSeries(NQ, k, o)]));
  for (const i of [150, 400, 777, 1001, 1300, NQ.length - 1]) {
    const cut = NQ.slice(0, i + 1);
    for (const [k, o] of kinds) {
      const part = profileSeries(cut, k, o);
      for (const f of ['poc', 'vah', 'val', 'hvn_above', 'lvn_below']) {
        const a = full[k][f][i]; const b = part[f][i];
        assert.ok(Object.is(a, b) || Math.abs(a - b) < 1e-9, `${k} ${f} at ${i}: ${a} vs ${b}`);
      }
    }
  }
});

test('prior_rth is the last complete RTH day, known from the first bar after it; a day the data starts inside is skipped', () => {
  const s = profileSeries(NQ, 'prior_rth');
  // Find the first RTH day whose 09:30 bar is in the data, and the bar after it ends.
  let start = -1; let end = -1;
  for (let i = 1; i < NQ.length; i += 1) {
    const m = etInfo(NQ[i].t).minute;
    if (start < 0 && m === 570) start = i;
    if (start >= 0 && end < 0 && (m >= 960 || m < 570)) { end = i - 1; break; }
  }
  assert.ok(start > 0 && end > start);
  assert.ok(s.profile.slice(0, end + 1).every(p => p === null), 'nothing before the first whole day ends');
  const want = buildProfile(NQ, start, end);
  assert.strictEqual(s.poc[end + 1], want.poc);
  assert.strictEqual(s.vah[end + 1], want.vah);
  assert.strictEqual(s.val[end + 1], want.val);
  assert.ok(s.val[end + 1] < s.poc[end + 1] && s.poc[end + 1] < s.vah[end + 1]);
});

test('session restarts at 18:00 ET and rolling needs n bars', () => {
  const s = profileSeries(NQ, 'session');
  const first = NQ.findIndex((b, i) => i > 0 && etInfo(b.t).minute === 18 * 60);
  assert.ok(first > 0);
  assert.ok(Number.isNaN(s.poc[first - 1]) || s.profile[first - 1].from < first);
  assert.strictEqual(s.profile[first].from, first);
  assert.strictEqual(s.profile[first + 5].from, first);
  const r = profileSeries(NQ, 'rolling', { length: 50 });
  assert.ok(Number.isNaN(r.poc[48]));
  assert.strictEqual(r.profile[49].from, 0);
  assert.strictEqual(r.profile[200].from, 151);
});

test('options from strategy params, and the summary for a snapshot', () => {
  assert.deepStrictEqual(optionsFromParams({ vpRows: 50, vpValueArea: 68, vpNodePct: 5 }), { ...DEFAULTS, rows: 50, valueArea: 0.68, nodePct: 0.05 });
  const p = buildProfile(rowBars([5, 10, 20, 40, 20, 3, 2]), 0, 6, { rowSize: 1 });
  const d = describe(p, 106.2, 2, x => Math.round(x * 100) / 100);
  assert.strictEqual(d.price, 'above value');
  assert.strictEqual(d.fromPocAtr, 1.6); // (106.2 - POC 103) / 2
  assert.strictEqual(describe(p, 103, 2).price, 'inside value');
  assert.strictEqual(describe(null, 1, 1), null);
});
