'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cb = require('../../scripts/lib/compare-bars');
const { tmpDir } = require('../helpers');

const t = k => new Date(Date.UTC(2024, 5, 3, 13, 30 + k)).toISOString(); // 09:30 ET + k minutes
const bar = (k, extra = {}) => ({ t: t(k), o: 100 + k, h: 101 + k, l: 99 + k, c: 100.5 + k, v: 10, ...extra });
const close = (x, y, eps = 1e-9) => assert.ok(Math.abs(x - y) <= eps, `${x} != ${y}`);

/** An independent Pearson, for checking. */
function corr(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  return cov / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
}

test('align: by time; one-sided bars, price mismatches (left out), duplicates (last kept), any input order', () => {
  const a = [bar(2), bar(0), bar(1), bar(1, { x: 9 }), bar(3)];
  const b = [bar(0), bar(1), bar(2, { c: 50 }), bar(4)];
  const r = cb.align(a, b);
  assert.deepStrictEqual(r.pairs.map(p => p.t), [t(0), t(1)]);
  assert.deepStrictEqual(r.mismatched.map(m => [m.t, m.diffs]), [[t(2), { c: [102.5, 50] }]]);
  assert.deepStrictEqual(r.onlyA, [t(3)]);
  assert.deepStrictEqual(r.onlyB, [t(4)]);
  assert.deepStrictEqual(r.duplicates, { a: 1, b: 0 });
  assert.strictEqual(r.A[r.pairs[1].ia].x, 9, 'the last duplicate is kept');
  assert.strictEqual(r.byContract, false);
});

test('align: OHLCV tolerance, volume included, a missing price never matches', () => {
  assert.strictEqual(cb.align([bar(0)], [bar(0, { c: 100.75 })]).mismatched.length, 1);
  assert.strictEqual(cb.align([bar(0)], [bar(0, { c: 100.75 })], { ohlcvTol: 0.25 }).pairs.length, 1);
  assert.deepStrictEqual(cb.align([bar(0)], [bar(0, { v: 11 })]).mismatched[0].diffs, { v: [10, 11] });
  assert.strictEqual(cb.align([bar(0)], [bar(0, { v: 11 })], { ohlcvTol: 1 }).pairs.length, 1);
  assert.strictEqual(cb.align([bar(0, { o: NaN })], [bar(0, { o: NaN })]).mismatched.length, 1);
});

test('align: by contract too when both sources carry one on every bar; by time alone otherwise', () => {
  const a = [bar(0, { contract: 'MNQ' }), bar(0, { contract: 'MES', c: 5000 })];
  const b = [bar(0, { contract: 'MES', c: 5000 }), bar(0, { contract: 'MNQ' })];
  const r = cb.align(a, b);
  assert.strictEqual(r.byContract, true);
  assert.strictEqual(r.pairs.length, 2);
  assert.deepStrictEqual(r.pairs.map(p => p.contract).sort(), ['MES', 'MNQ']);
  const c = cb.align(a, [bar(0)]); // one source names no contract: by time, the second A bar a duplicate
  assert.strictEqual(c.byContract, false);
  assert.strictEqual(c.duplicates.a, 1);
});

test('leafPaths: numeric and boolean leaves, nested and in arrays, OHLCV and strings left out, --prefix', () => {
  const bars = [bar(0, { ext: { deep: { s: 1, f: true, note: 'x', n: null }, list: [1, { z: 2 }] }, top: 3 }), bar(1, { other: { q: 1 } })];
  assert.deepStrictEqual(cb.leafPaths(bars), ['ext.deep.f', 'ext.deep.s', 'ext.list.0', 'ext.list.1.z', 'other.q', 'top']);
  assert.deepStrictEqual(cb.leafPaths(bars, { prefix: 'ext.deep' }), ['ext.deep.f', 'ext.deep.s']);
  assert.deepStrictEqual(cb.leafPaths(bars, { prefix: 'ext.de' }), [], 'a prefix is whole segments');
  assert.deepStrictEqual(cb.leafPaths([bar(0, { 'a.b': 1, n: { 'c.d': 2 } })]), [], 'a key with a dot cannot be named by a path');
});

test('leafPaths: too many leaves is refused (narrow with --prefix)', () => {
  const wide = Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`k${i}`, i]));
  assert.throws(() => cb.leafPaths([bar(0, { w: wide })]), /more than 2000 leaf fields/);
});

test('fieldStats: nulls, NaN, coverage, differences, tolerance, correlation, sign, percentiles, worst', () => {
  const xs = [1, 2, -1, 4, NaN, 3];
  const ys = [1, 2.5, -1, NaN, 5, 0];
  const s = cb.fieldStats(xs, ys, { at: ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'] });
  assert.strictEqual(s.bars, 6);
  assert.deepStrictEqual(s.coverage, { a: 5 / 6, b: 5 / 6 });
  assert.strictEqual(s.n, 4);
  assert.strictEqual(s.onlyA, 1);
  assert.strictEqual(s.onlyB, 1);
  close(s.meanAbs, (0 + 0.5 + 0 + 3) / 4);
  assert.strictEqual(s.maxAbs, 3);
  assert.strictEqual(s.within, 2 / 4);
  close(s.corr, corr([1, 2, -1, 3], [1, 2.5, -1, 0]), 1e-11);
  assert.strictEqual(s.sign, 3 / 4, 'the bar where B is 0 and A is not disagrees');
  assert.deepStrictEqual(s.worst, [{ t: 'b5', a: 3, b: 0, diff: -3 }, { t: 'b1', a: 2, b: 2.5, diff: 0.5 }]);
  // Percentiles over the compared values, linear between ranks.
  close(s.pct.a.p50, 1.5);
  close(s.pct.a.p5, -1 + 0.15 * 2);
  close(s.pct.b.p95, 1 + 0.85 * 1.5); // sorted [-1, 0, 1, 2.5], position 2.85
});

test('fieldStats: tolerance, absolute or relative; worst lists only bars outside it', () => {
  assert.strictEqual(cb.fieldStats([1, 10], [1.2, 11]).within, 0);
  assert.strictEqual(cb.fieldStats([1, 10], [1.2, 11], { tol: 0.2 }).within, 0.5);
  assert.strictEqual(cb.fieldStats([1, 10], [1.2, 11], { tol: 0.2, rtol: 0.1 }).within, 1);
  assert.strictEqual(cb.fieldStats([1, 10], [1.2, 11], { rtol: 0.1 }).within, 0.5);
  assert.deepStrictEqual(cb.fieldStats([1, 10], [1.2, 11], { tol: 0.2, rtol: 0.1 }).worst, []);
  assert.strictEqual(cb.fieldStats([1, 2, 3], [1, 2, 3], { worst: 0 }).worst.length, 0);
});

test('fieldStats: constant series (correlation undefined), all zeros (sign undefined), nothing compared', () => {
  const k = cb.fieldStats([2, 2, 2], [2, 2, 2]);
  assert.strictEqual(k.corr, null);
  assert.strictEqual(k.within, 1);
  assert.strictEqual(cb.fieldStats([1, 2, 3], [5, 5, 5]).corr, null);
  assert.strictEqual(cb.fieldStats([0, 0], [0, 0]).sign, null);
  assert.strictEqual(cb.fieldStats([1], [1]).corr, null, 'one pair has no correlation');
  const none = cb.fieldStats([NaN, 1], [2, NaN]);
  assert.deepStrictEqual([none.n, none.meanAbs, none.maxAbs, none.within, none.corr, none.sign, none.pct.a.p50], [0, null, null, null, null, null, null]);
  const empty = cb.fieldStats([], []);
  assert.deepStrictEqual(empty.coverage, { a: null, b: null });
  assert.strictEqual(cb.fieldStats([1, 2, 3], [3, 2, 1]).corr, -1);
});

test('pearson: rounded to 1e-12 and clamped, so identical series read exactly 1', () => {
  const xs = Array.from({ length: 500 }, (_, i) => Math.sin(i) * 1e3 + 0.1);
  assert.strictEqual(cb.pearson(xs, xs.slice()), 1);
  assert.strictEqual(cb.quantile([], 0.5), null);
});

test('compareBars: booleans read as 1/0, nested and look-back paths, price mismatches left out of the stats', () => {
  const a = [0, 1, 2, 3, 4].map(k => bar(k, { ext: { s: [1, 2, 3, 4, 5][k], f: [true, false, true, true, false][k] } }));
  const b = [0, 1, 2, 3, 4].map(k => bar(k, { ext: { s: [1, 2, 9, 4, 6][k], f: [true, true, true, true, false][k] }, ...(k === 2 ? { h: 500 } : {}) }));
  const r = cb.compareBars(a, b, { fields: cb.parseFields('ext.s,ext.f,ext.s[1]') });
  const by = Object.fromEntries(r.fields.map(s => [s.field, s]));
  assert.strictEqual(r.bars.compared, 4);
  assert.strictEqual(r.bars.mismatched, 1);
  assert.deepStrictEqual([by['ext.s'].n, by['ext.s'].maxAbs], [4, 1], 'the mismatched bar (9 vs 3) is not compared');
  assert.deepStrictEqual([by['ext.f'].n, by['ext.f'].within], [4, 0.75]);
  // ext.s[1]: each source's own previous bar (B's bar 2, though its prices differ, is B's previous bar for bar 3).
  assert.deepStrictEqual(by['ext.s[1]'].worst.map(w => [w.t, w.a, w.b]), [[t(3), 3, 9]]);
  assert.strictEqual(by['ext.s[1]'].n, 3, 'bar 0 has no previous bar');
  assert.strictEqual(r.pass, true, 'no thresholds: a pass');
});

test('compareBars: default fields are every leaf in either source; --prefix narrows them; --fields under the prefix', () => {
  const a = [bar(0, { x: { p: 1 } }), bar(1, { x: { p: 2 } })];
  const b = [bar(0, { x: { p: 1 }, y: { q: true } }), bar(1, { x: { p: 2 }, y: { q: false } })];
  assert.deepStrictEqual(cb.compareBars(a, b).fields.map(s => s.field), ['x.p', 'y.q']);
  const yq = cb.compareBars(a, b).fields[1];
  assert.deepStrictEqual([yq.coverage.a, yq.coverage.b, yq.n], [0, 1, 0]);
  assert.deepStrictEqual(cb.compareBars(a, b, { prefix: 'y' }).fields.map(s => s.field), ['y.q']);
  assert.deepStrictEqual(cb.compareBars(a, b, { prefix: 'y', fields: cb.parseFields('x.p,y.q') }).fields.map(s => s.field), ['y.q']);
});

test('thresholds: each key, an undefined correlation passes only where the values agree, nothing compared fails', () => {
  const s = { n: 4, bars: 4, within: 0.75, corr: 0.9, sign: 0.5, coverage: { a: 1, b: 0.5 } };
  assert.deepStrictEqual(cb.fieldFailures(s, {}), []);
  assert.strictEqual(cb.fieldFailures(s, { corr: 0.9 }).length, 0);
  assert.match(cb.fieldFailures(s, { corr: 0.95 })[0], /^corr 0.9 < 0.95/);
  assert.match(cb.fieldFailures(s, { within: 0.8 })[0], /^within 0.75 < 0.8/);
  assert.strictEqual(cb.fieldFailures(s, { within: 0.75 }).length, 0);
  assert.match(cb.fieldFailures(s, { sign: 0.6 })[0], /^sign/);
  assert.match(cb.fieldFailures(s, { coverage: 0.6 })[0], /^coverage 0.5 < 0.6/);
  assert.deepStrictEqual(cb.fieldFailures({ ...s, corr: null, within: 1 }, { corr: 0.99 }), []);
  assert.match(cb.fieldFailures({ ...s, corr: null, within: 0.5 }, { corr: 0.99 })[0], /corr undefined/);
  assert.deepStrictEqual(cb.fieldFailures({ ...s, sign: null }, { sign: 0.99 }), [], 'all zeros on both sides agree');
  const none = { n: 0, bars: 4, within: null, corr: null, sign: null, coverage: { a: 1, b: 0 } };
  assert.strictEqual(cb.fieldFailures(none, { corr: 0, within: 0, sign: 0, coverage: 0 }).length, 3, 'coverage 0 >= 0 passes; the rest fail');
});

test('compareBars: --fail-below sets pass/failures; bars= is the share of bars in both with equal prices', () => {
  const a = [0, 1, 2, 3].map(k => bar(k, { z: k }));
  const b = [0, 1, 2].map(k => bar(k, { z: k === 2 ? 5 : k }));
  const r = cb.compareBars(a, b, { thresholds: cb.parseThresholds('within=0.6') });
  assert.strictEqual(r.pass, true);
  const f = cb.compareBars(a, b, { thresholds: cb.parseThresholds('within=0.7,bars=0.8') });
  assert.strictEqual(f.pass, false);
  assert.deepStrictEqual(f.failures, ['bars: 0.75 of the bars are in both with the same prices (< 0.8)', 'z: within 0.666667 < 0.7']);
  assert.strictEqual(cb.compareBars(a, b, { thresholds: { bars: 0.75 } }).pass, true);
  const nothing = cb.compareBars([bar(0)], [bar(0)], { thresholds: { corr: 0.9 } });
  assert.deepStrictEqual(nothing.failures, ['no field to compare']);
  assert.strictEqual(cb.compareBars([], [], { thresholds: { bars: 0 } }).pass, false, 'no bars at all fails bars=');
});

test('compareBars --by hour: per ET hour of the bar open (daylight time and standard time)', () => {
  const mk = (iso, z) => ({ t: iso, o: 1, h: 2, l: 0, c: 1, v: 1, z });
  const a = [mk('2024-06-03T13:59:00Z', 1), mk('2024-06-03T14:00:00Z', 1), mk('2024-01-03T14:30:00Z', 1)];
  const b = [mk('2024-06-03T13:59:00Z', 1), mk('2024-06-03T14:00:00Z', 2), mk('2024-01-03T14:30:00Z', 1)];
  const s = cb.compareBars(a, b, { by: 'hour' }).fields[0];
  assert.deepStrictEqual(Object.keys(s.byHour), ['9', '10']);
  assert.deepStrictEqual([s.byHour[9].n, s.byHour[9].within, s.byHour[10].n, s.byHour[10].within], [2, 1, 1, 0]);
  assert.strictEqual(cb.compareBars(a, b).fields[0].byHour, undefined);
});

test('parseFields and parseThresholds: values and refusals', () => {
  assert.deepStrictEqual(cb.parseFields('a.b, c.d[1],e.0'), [
    { path: 'a.b', shift: 0, name: 'a.b' }, { path: 'c.d', shift: 1, name: 'c.d[1]' }, { path: 'e.0', shift: 0, name: 'e.0' }]);
  assert.deepStrictEqual(cb.parseFields(''), []);
  for (const bad of ['a..b', 'a.b[x]', 'a[1].b', '.a', 'a.b[501]', 'a b', '1.2.3.4.5.6.7.8.9']) assert.throws(() => cb.parseFields(bad), /--fields/, bad);
  assert.deepStrictEqual(cb.parseThresholds('corr=0.95,within=0.99,sign=0.9,coverage=1,bars=1'), { corr: 0.95, within: 0.99, sign: 0.9, coverage: 1, bars: 1 });
  assert.deepStrictEqual(cb.parseThresholds(undefined), {});
  for (const bad of ['corr', 'corr=x', 'mean=1', 'within=1.5', 'corr=-2']) assert.throws(() => cb.parseThresholds(bad), /--fail-below/, bad);
});

test('parseArgs: sources, a broker source needs its span, unknown or valueless flags are usage errors', () => {
  const o = cb.parseArgs(['--a', 'x.jsonl', '--b', 'broker:replay-1', '--contract', 'MNQ', '--from', '2024-06-03', '--to', '2024-06-08', '--tol', '0.5', '--by', 'hour', '--fail-below', 'corr=0.9', '--out', 'r.json']);
  assert.deepStrictEqual(o.sources.a, { kind: 'file', file: 'x.jsonl', label: 'x.jsonl' });
  assert.strictEqual(o.sources.b.broker, 'replay-1');
  assert.match(o.sources.b.label, /broker replay-1: MNQ 1 from 2024-06-03 to 2024-06-08/);
  assert.deepStrictEqual([o.compare.tol, o.compare.rtol, o.compare.worst, o.compare.by, o.out], [0.5, 0, 5, 'hour', 'r.json']);
  const bad = [
    [], ['--a', 'x.jsonl'], ['--a', 'x', '--b', 'y', '--nope', '1'], ['--a', 'x', '--b'], ['--a', 'x', '--b', 'broker:n'],
    ['--a', 'x', '--b', 'broker:bad name', '--contract', 'MNQ', '--from', '2024-01-01', '--to', '2024-01-02'],
    ['--a', 'x', '--b', 'y', '--tol', '-1'], ['--a', 'x', '--b', 'y', '--worst', '1.5'], ['--a', 'x', '--b', 'y', '--by', 'day'],
    ['--a', 'x', '--b', 'y', '--out', 'r.md'], ['--a', 'x', '--b', 'y', '--fields', 'a..b'], ['--a', 'x', '--b', 'y', '--fail-below', 'x=1'],
  ];
  for (const argv of bad) assert.throws(() => cb.parseArgs(argv), cb.UsageError, argv.join(' '));
});

test('readBarsFile: .jsonl and .json keep every field; other formats are refused', () => {
  const dir = tmpDir();
  const bars = [bar(0, { ext: { a: [1, true] } }), bar(1, { ext: { a: [2, false] } })];
  fs.writeFileSync(path.join(dir, 'x.jsonl'), bars.map(b => JSON.stringify(b)).join('\n'));
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ bars }));
  assert.deepStrictEqual(cb.readBarsFile(path.join(dir, 'x.jsonl')), bars);
  assert.deepStrictEqual(cb.readBarsFile(path.join(dir, 'x.json')), bars);
  assert.throws(() => cb.readBarsFile(path.join(dir, 'x.csv')), /\.jsonl or \.json/);
});

test('fetchBrokerBars: the named broker through the adapter\'s history(), the span as asked, bars normalized', async () => {
  const seen = [];
  const withAdapter = async (opts, fn) => {
    seen.push(opts.env.FTH_BROKER);
    return fn({ history: async (c, span) => { seen.push([c, span.from.toISOString(), span.to.toISOString(), span.timeframe]); return [{ ...bar(1), extra: { n: 1 } }, bar(0)]; } });
  };
  const got = await cb.fetchBrokerBars({ broker: 'second', contract: 'MNQ', from: '2024-06-03T00:00:00Z', to: '2024-06-08T00:00:00Z', timeframe: '3', root: '/r', env: { FTH_BROKER: 'first' }, withAdapter });
  assert.deepStrictEqual(seen, ['second', ['MNQ', '2024-06-03T00:00:00.000Z', '2024-06-08T00:00:00.000Z', '3']]);
  assert.deepStrictEqual(got.map(b => b.t), [t(0), t(1)]);
  assert.deepStrictEqual(got[1].extra, { n: 1 });
});

test('toMarkdown: the summary, the field table, failures, worst bars and the hourly breakdown', () => {
  const a = [0, 1].map(k => bar(k, { z: k }));
  const b = [0, 1].map(k => bar(k, { z: k * 2 }));
  const md = cb.toMarkdown(cb.compareBars(a, b, { by: 'hour', thresholds: { within: 1 }, labels: { a: 'first|one', b: 'second' } }));
  assert.match(md, /- A: first\\\|one/);
  assert.match(md, /Verdict: FAIL \(fail below within=1\)/);
  assert.match(md, /\| `z` \| 100% \| 100% \| 2 \| 0\.5 \| 1 \| 50% \| 1 \| 100% \| 0\.05 \/ 0\.5 \/ 0\.95 \| 0\.1 \/ 1 \/ 1\.9 \|/);
  assert.match(md, /## Below thresholds\n\n- z: within 0\.5 < 1/);
  assert.match(md, /### `z`\n\n\| bar \| A \| B \| B - A \|\n\|---\|---\|---\|---\|\n\| 2024-06-03T13:31:00\.000Z \| 1 \| 2 \| 1 \|/);
  assert.match(md, /## By hour \(ET, bar open\)[\s\S]*\| 09 \| 2 \| 0\.5 \| 50% \| 1 \| 100% \|/);
  const plain = cb.toMarkdown(cb.compareBars([bar(0)], [bar(0)]));
  assert.match(plain, /Verdict: pass \(no thresholds set\)/);
  assert.match(plain, /No numeric or boolean field to compare\./);
});

test('look-back stays on the bar\'s own contract when bars align by contract', () => {
  const A = [0, 1, 2].flatMap(k => [bar(k, { contract: 'MES', c: 5000, z: 1000 + k }), bar(k, { contract: 'MNQ', z: k })]);
  const B = A.map(b => (b.contract === 'MES' ? { ...b, z: b.z + 500 } : b));
  const r = cb.compareBars(A, B, { fields: cb.parseFields('z[1]') });
  assert.strictEqual(r.bars.byContract, true);
  const s = r.fields[0];
  assert.strictEqual(s.n, 4, 'two later bars on each contract');
  assert.deepStrictEqual(s.worst.map(w => w.t), [`MES ${t(1)}`, `MES ${t(2)}`], 'only MES differs');
  assert.ok(s.worst.every(w => w.diff === 500));
});

test('pearson: a constant series is undefined however its mean rounds; a corr threshold then needs agreeing values', () => {
  const tenth = Array(7).fill(0.1);
  assert.strictEqual(cb.pearson(tenth, [1, 2, 3, 4, 5, 6, 8]), null);
  assert.strictEqual(cb.pearson(tenth, Array(7).fill(0.1 + 1e-9)), null);
  assert.strictEqual(cb.pearson(tenth, Array(7).fill(0.7)), null);
  const mk = z => [0, 1, 2, 3, 4, 5, 6].map(k => bar(k, { z }));
  const off = cb.compareBars(mk(0.1), mk(0.1 + 1e-9), { thresholds: { corr: 0.99 } });
  assert.strictEqual(off.pass, false, 'constant fields that differ never pass on correlation');
  assert.match(off.failures[0], /corr undefined/);
  assert.strictEqual(cb.compareBars(mk(0.1), mk(0.1), { thresholds: { corr: 0.99 } }).pass, true);
});

test('an undefined correlation from one compared value never passes a corr threshold', () => {
  assert.strictEqual(cb.compareBars([bar(0, { z: 5 })], [bar(0, { z: 5 })], { thresholds: { corr: 0.99 } }).pass, false);
  assert.strictEqual(cb.compareBars([bar(0, { z: 5 }), bar(1, { z: 5 })], [bar(0, { z: 5 }), bar(1, { z: 5 })], { thresholds: { corr: 0.99 } }).pass, true);
});

test('--prefix narrows the leaves before the field limit counts them', () => {
  const wide = Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`k${i}`, i]));
  const bars = [bar(0, { w: wide, x: { y: 1 } })];
  assert.deepStrictEqual(cb.leafPaths(bars, { prefix: 'x' }), ['x.y']);
  assert.deepStrictEqual(cb.leafPaths([bar(0, { a: { b: { c: 1, d: 2 }, e: 3 } })], { prefix: 'a.b' }), ['a.b.c', 'a.b.d']);
  assert.deepStrictEqual(cb.leafPaths([bar(0, { a: { b: 1 } })], { prefix: 'a.b' }), ['a.b']);
  assert.throws(() => cb.leafPaths(bars, { prefix: 'w' }), /more than 2000 leaf fields under w/);
});

test('nothing compared fails, thresholds or not', () => {
  const r = cb.compareBars([bar(0, { contract: 'MNQ' })], [bar(0, { contractId: 'X1' })]);
  assert.strictEqual(r.bars.compared, 0);
  assert.strictEqual(r.pass, false);
  assert.match(r.failures[0], /nothing was compared/);
  assert.strictEqual(cb.compareBars([], []).pass, false);
  assert.match(cb.toMarkdown(r), /Verdict: FAIL \(no thresholds set\)/);
});

test('clip: a file source cut to --from/--to (inclusive); --from/--to must be times', () => {
  const bars = [0, 1, 2, 3].map(k => bar(k));
  assert.deepStrictEqual(cb.clip(bars, { from: t(1), to: t(2) }).map(b => b.t), [t(1), t(2)]);
  assert.strictEqual(cb.clip(bars, {}).length, 4);
  assert.deepStrictEqual(cb.clip(bars, { from: t(3) }).map(b => b.t), [t(3)]);
  assert.throws(() => cb.parseArgs(['--a', 'x', '--b', 'y', '--from', 'soon']), cb.UsageError);
});

test('percentages floor past float error: 0.29 is 29%', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i);
  const ys = xs.map(x => (x < 29 ? x : x + 1));
  assert.match(cb.toMarkdown(cb.compareBars(xs.map(k => bar(0, { z: k, t: new Date(Date.UTC(2024, 0, 1) + k * 60000).toISOString() })), ys.map((z, k) => bar(0, { z, t: new Date(Date.UTC(2024, 0, 1) + k * 60000).toISOString() })))), /\| 29% \|/);
});
