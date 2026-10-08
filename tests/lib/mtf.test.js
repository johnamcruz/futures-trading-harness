'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { candles, readTimeframe, alignment, mtfRead, biasSeries } = require('../../scripts/lib/trading/mtf');
const { normalizeBars } = require('../../scripts/lib/trading/indicators');
const { compileCondition, evaluateRules, seriesSource } = require('../../scripts/lib/trading/rules');

const ROOT = path.resolve(__dirname, '..', '..');
const NQ = path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv');
// 2026-10-07 is EDT (UTC-4): 09:00 ET = 13:00 UTC.
const et = (h, m = 0, day = 7) => Date.UTC(2026, 9, day, h + 4, m);

/** 3-minute bars from `from` for `n` bars, price path p(k). */
function path3m(from, n, p, wiggle = 1) {
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const c = p(k);
    out.push({ t: new Date(from + k * 180000).toISOString(), o: c, h: c + wiggle, l: c - wiggle, c, v: 10 });
  }
  return normalizeBars(out);
}
const zigzag = (slope, amp = 6, period = 10) => k => 20000 + slope * k + amp * Math.sin((2 * Math.PI * k) / period);

test('candles: OHLCV per m-minute candle aligned to the hour; a cut-off first candle is dropped, the last is in progress', () => {
  const b = path3m(et(9, 30), 50, k => 100 + k); // 09:30 .. 11:57
  const cs = candles(b, 60);
  assert.deepStrictEqual(cs.map(c => c.t), [et(10, 0), et(11, 0)].map(x => new Date(x).toISOString()), 'the 09:00 hour starts mid-way: dropped');
  assert.deepStrictEqual([cs[0].o, cs[0].h, cs[0].l, cs[0].c, cs[0].v], [110, 130, 109, 129, 200]);
  assert.deepStrictEqual(cs.map(c => c.complete), [true, false]);
});

test('readTimeframe: up, down, and range trends from the three votes; too few candles is unknown', () => {
  const read = slope => readTimeframe(candles(path3m(et(9, 0, 1), 6000, zigzag(slope, 30, 80)), 60).filter(c => c.complete));
  const up = read(0.5);
  assert.deepStrictEqual([up.trend, up.bias, up.votes.closeVsFast, up.votes.fastVsSlow, up.votes.structure], ["up", 1, 1, 1, "HH/HL"]);
  assert.ok(up.adx > 0 && up.atr > 0 && up.rangePos > 0.5);
  const down = read(-0.5);
  assert.deepStrictEqual([down.trend, down.bias, down.votes.structure], ['down', -1, 'LH/LL']);
  const flat = readTimeframe(candles(path3m(et(9, 0, 1), 6000, () => 20000), 60).filter(c => c.complete));
  assert.strictEqual(flat.bias, 0);
  assert.strictEqual(readTimeframe([]).trend, 'unknown');
  const short = readTimeframe(candles(path3m(et(9, 0), 200, zigzag(0.2)), 60).filter(c => c.complete));
  assert.strictEqual(short.emaSlow, null);
  assert.match(short.note, /no EMA50 vote, needs 50/);
});

test('alignment: aligned, pullback, counter, mixed per side, highest timeframe first', () => {
  const f = (...b) => b.map(x => ({ read: { bias: x } }));
  assert.deepStrictEqual(alignment(f(1, 1, 1)), { long: 'aligned', short: 'counter', bias: 'long', score: 6, maxScore: 6 });
  assert.deepStrictEqual([alignment(f(1, 1, -1)).long, alignment(f(1, 1, -1)).short], ['pullback', 'counter']);
  assert.deepStrictEqual([alignment(f(1, 0, -1)).long, alignment(f(0, 1, -1)).short], ['mixed', 'mixed']);
  assert.deepStrictEqual([alignment(f(1, 0, 0)).long, alignment(f(0, 0, 1)).long], ['mixed', 'mixed'], 'one of three is not most');
  assert.deepStrictEqual([alignment(f(1, 1, 0)).long, alignment(f(-1, 1, 1)).long], ['aligned', 'counter']);
  assert.strictEqual(alignment(f(-1, -1, 1)).short, 'pullback');
  assert.strictEqual(alignment([]).long, 'unknown');
});

test('mtfRead on real NQ: one line per timeframe, highest first, and the alignment; daily bars add the top timeframe', () => {
  const bars = fs.readFileSync(NQ, 'utf8').trim().split('\n').slice(1).map(l => {
    const [t, o, h, lo, c, v] = l.split(',');
    return { t: new Date(t.replace(' ', 'T')).toISOString(), o: +o, h: +h, l: +lo, c: +c, v: +v };
  });
  const r = mtfRead(bars);
  assert.deepStrictEqual(r.frames.map(f => f.label), ['4h', '1h', '15m']);
  assert.strictEqual(r.lines.length, 4);
  assert.match(r.lines[3], /^Alignment: long (aligned|pullback|counter|mixed), short (aligned|pullback|counter|mixed); bias (long|short|neutral)/);
  assert.ok(r.frames.every(f => f.forming && f.read.candles > 0));
  const daily = Array.from({ length: 60 }, (_, k) => ({ t: new Date(Date.UTC(2026, 1, 1) + k * 86400000).toISOString(), o: 20000 + 20 * k, h: 20040 + 20 * k, l: 19970 + 20 * k, c: 20030 + 20 * k, v: 1 }));
  const withDaily = mtfRead(bars, { daily });
  assert.strictEqual(withDaily.frames[0].label, 'daily');
  assert.strictEqual(withDaily.frames[0].read.trend, 'up');
  assert.throws(() => mtfRead(bars, { timeframes: [7] }), /divide a day/);
});

test('mtf_bias(m) in rules: causal, and the same trend the read gives for the candles completed before each bar', () => {
  const b = path3m(et(9, 0, 1), 3000, zigzag(0.05));
  const s = biasSeries(b, 60);
  // Causal: a prefix gives the same values.
  assert.deepStrictEqual(biasSeries(b.slice(0, 1500), 60), s.slice(0, 1500));
  // At each bar: the read of the hour candles completed before it.
  for (const i of [400, 1200, 2999]) {
    const done = candles(b.slice(0, i + 1), 60).filter(c => c.complete);
    assert.strictEqual(s[i], readTimeframe(done).bias, `bar ${i}`);
  }
  assert.ok(Number.isNaN(s[0]), 'no completed candle yet');
  const rules = { long: [compileCondition('mtf_bias(60) > 0')], short: [compileCondition('mtf_bias(60) < 0')] };
  assert.strictEqual(evaluateRules(rules, b, {}, { index: 2999, get: seriesSource(b, {}) }).direction, 'long');
  assert.throws(() => compileCondition('mtf_bias(7) > 0'), /divide a day/);
});

test('scripts/mtf.js prints the read for a bars file, as lines or JSON', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'mtf.js'), NQ], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^4h: (UP|DOWN|RANGE) /);
  assert.match(r.stdout, /Alignment: long /);
  const j = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'mtf.js'), NQ, '--tf=30,60', '--json'], { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(j.stdout).frames.map(f => f.label), ['1h', '30m']);
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'mtf.js'), NQ, '--bogus'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown argument: --bogus/);
});
