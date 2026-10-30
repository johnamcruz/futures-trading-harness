'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { candles, readTimeframe, alignment, mtfRead, biasSeries, trendRule, ruleSeries, biasesAt } = require('../../scripts/lib/trading/mtf');
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

test('candles: OHLCV per m-minute candle aligned to the hour; a cut-off first candle is dropped; the last is in progress until its closing bar', () => {
  const b = path3m(et(9, 30), 50, k => 100 + k); // 09:30 .. 11:57
  const cs = candles(b, 60);
  assert.deepStrictEqual(cs.map(c => c.t), [et(10, 0), et(11, 0)].map(x => new Date(x).toISOString()), 'the 09:00 hour starts mid-way: dropped');
  assert.deepStrictEqual([cs[0].o, cs[0].h, cs[0].l, cs[0].c, cs[0].v], [110, 130, 109, 129, 200]);
  // The last bar (11:57) closes at 12:00, the 11:00 candle's end: complete now, not one bar later.
  assert.deepStrictEqual(cs.map(c => c.complete), [true, true]);
  assert.deepStrictEqual(candles(b.slice(0, 49), 60).map(c => c.complete), [true, false], 'ending at 11:57, the 11:00 candle is still forming');
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
  assert.strictEqual(r.lines.length, 5);
  assert.match(r.lines[4], /^Trend rule: /);
  assert.match(r.lines[3], /^Alignment: long (aligned|pullback|counter|mixed), short (aligned|pullback|counter|mixed); bias (long|short|neutral)/);
  // The last bar (04:12) closes at 04:15: the 15m candle is complete; the 1h and 4h are still forming.
  assert.ok(r.frames.every(f => f.read.candles > 0));
  assert.deepStrictEqual(r.frames.map(f => Boolean(f.forming)), [true, true, false]);
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

test('trendRule: never counter: no entry against a trending 4h or 1h, whatever the strategy\'s style; both ranging, not against the 15m', () => {
  const b = (h4, h1, m15) => ({ 240: h4, 60: h1, 15: m15 });
  const allowed = (biases, side, style) => trendRule(biases, side, style).allowed;
  // 4h up: shorts are against it, whatever the lower frames say; longs are fine even in a 15m pullback.
  assert.strictEqual(allowed(b(1, 1, -1), 'short'), false);
  assert.strictEqual(allowed(b(1, 1, -1), 'long'), true);
  assert.match(trendRule(b(1, 0, 0), 'short').reason, /^against the 4h up trend: no entry against a trending 4h or 1h$/);
  // A trending frame against either side: the 4h up beside the 1h down is no side at all.
  assert.deepStrictEqual([allowed(b(1, -1, -1), 'long'), allowed(b(1, -1, -1), 'short')], [false, false]);
  assert.match(trendRule(b(1, -1, 0), 'long').reason, /against the 1h down trend/);
  // 4h range: the 1h trend sets it; both ranging: not against the 15m; all range: both sides open (not in a prop attempt:
  // there the entry rule also needs the declared trend and refuses a bar with no trend).
  assert.deepStrictEqual([allowed(b(0, -1, 1), 'long'), allowed(b(0, -1, 1), 'short')], [false, true]);
  assert.deepStrictEqual([allowed(b(0, 0, 1), 'long'), allowed(b(0, 0, 1), 'short')], [true, false]);
  assert.match(trendRule(b(0, 0, 1), 'short').reason, /^against the 15m up trend, the 4h and 1h ranging$/);
  assert.strictEqual(trendRule(b(0, 0, 1), 'short').prevailing.label, '15m');
  assert.deepStrictEqual([allowed(b(0, 0, 0), 'long'), allowed(b(0, 0, 0), 'short')], [true, true]);
  // No 4h read yet: no entry; a reversal style is held like any other (no exemption).
  assert.match(trendRule(b(NaN, 1, 1), 'long').reason, /no 4h trend read yet/);
  assert.strictEqual(allowed(b(NaN, 1, 1), 'long'), false);
  assert.strictEqual(allowed(b(1, 1, 1), 'short', 'reversal'), false, 'a reversal strategy may not fade the 4h and 1h');
  assert.strictEqual(allowed(b(NaN, NaN, NaN), 'short', 'reversal'), false, 'nor enter before the 4h read');
  assert.strictEqual(allowed(b(1, 1, 1), 'long', 'reversal'), true, 'with the trend it goes');
});

test('ruleSeries: causal per bar, and on the last bar the same biases as the live read (mtfRead)', () => {
  const b = path3m(et(9, 0, 1), 6000, zigzag(-0.3, 40, 320));
  const ser = ruleSeries(b);
  assert.deepStrictEqual(ruleSeries(b.slice(0, 3000))[240], ser[240].slice(0, 3000), 'a prefix gives the same values');
  const live = mtfRead(b);
  for (const m of [240, 60, 15]) assert.strictEqual(biasesAt(ser, b.length - 1)[m], live.biases[m], `${m}m`);
  assert.strictEqual(live.rule.prevailing, '4h down');
  assert.deepStrictEqual([live.rule.longAllowed, live.rule.shortAllowed], [false, true]);
  assert.match(live.lines[live.lines.length - 1], /^Trend rule: SHORT allowed \(prevailing 4h down\); no long against it\.$/);
});

test('readTimeframe reads at most the last 300 candles, so long series stay linear', () => {
  const cs = candles(path3m(et(9, 0, 1), 30000, zigzag(0.2, 30, 80)), 15).filter(c => c.complete);
  assert.ok(cs.length > 300);
  const full = readTimeframe(cs);
  const tail = readTimeframe(cs.slice(-300));
  assert.strictEqual(full.candles, cs.length);
  assert.deepStrictEqual([full.bias, full.emaFast, full.emaSlow], [tail.bias, tail.emaFast, tail.emaSlow]);
});

test('live and backtest read the same trend: the per-bar series over a long history equals the live read of the runner\'s bars', () => {
  const { historyBars } = require('../../scripts/lib/autotrader');
  // About 75 days of round-the-clock 3m bars inside one DST period (2026-03-10 .. 05-24): the repeated 01:00 ET hour
  // of a fall-back night has no bars on the real Globex calendar (Sunday 02:00 ET, the market closed).
  const b = path3m(Date.UTC(2026, 2, 10, 13, 0), 36000, zigzag(-0.05, 40, 320));
  const ser = ruleSeries(b);
  const keep = historyBars(3);
  let checked = 0;
  for (let i = keep + 500; i < b.length; i += 397) {
    const live = mtfRead(b.slice(i + 1 - keep, i + 1));
    for (const m of [240, 60, 15]) {
      const want = biasesAt(ser, i)[m];
      assert.ok(Object.is(live.biases[m], want) || live.biases[m] === want, `bar ${i} ${m}m: live ${live.biases[m]} vs backtest ${want}`);
    }
    checked += 1;
  }
  assert.ok(checked > 40);
});

test('ruleSummary: the reason names the side it is about, so a strategy that fired the open side never reads it as its own refusal', () => {
  const { ruleSummary } = require('../../scripts/lib/trading/mtf');
  // The June 1, 2026 replay: 15m down, keltner fired short, and the summary said only "against the prevailing 15m down trend".
  const down = ruleSummary({ 240: 0, 60: 0, 15: -1 });
  assert.deepStrictEqual([down.longAllowed, down.shortAllowed], [false, true]);
  assert.strictEqual(down.reason, 'longs: against the 15m down trend, the 4h and 1h ranging; shorts are with it');
  const up = ruleSummary({ 240: 1, 60: 1, 15: -1 });
  assert.match(up.reason, /^shorts: against the 4h up trend: no entry against a trending 4h or 1h; longs are with it$/);
  // A frame against either side: no side, both reasons said.
  const split = ruleSummary({ 240: 1, 60: -1, 15: -1 });
  assert.deepStrictEqual([split.longAllowed, split.shortAllowed], [false, false]);
  assert.match(split.reason, /^no side: longs against the 1h down trend.*; shorts against the 4h up trend/);
  // Not ready: both sides wait, said once; no trend anywhere: no reason; a reversal style is held as any other.
  assert.match(ruleSummary({ 240: NaN, 60: 0, 15: 0 }).reason, /^no 4h trend read yet/);
  assert.strictEqual(ruleSummary({ 240: 0, 60: 0, 15: 0 }).reason, undefined);
  assert.match(ruleSummary({ 240: -1, 60: 0, 15: 0 }, 'reversal').reason, /^longs: against the 4h down trend/);
});

test('the 4h EMA50 votes on the read\'s window: three weeks of Globex hours (weekends and the daily break out) hold over 50 4h candles', () => {
  const { zonedParts } = require('../../scripts/lib/trading/clock');
  const { DEFAULTS, HISTORY_HOURS } = require('../../scripts/lib/trading/mtf');
  const { historyBars } = require('../../scripts/lib/autotrader');
  // 3m bars on the Globex calendar (Sunday 18:00 ET to Friday 17:00 ET, no bars 17:00-18:00 ET), four weeks up to
  // Monday 2024-06-17 10:00 ET, rising with a swing: what the runner keeps on a 3m lane.
  const open = ms => {
    const p = zonedParts(new Date(ms), 'America/New_York');
    const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    if (p.hour === 17 || wd === 6 || (wd === 5 && p.hour >= 17) || (wd === 0 && p.hour < 18)) return false;
    return true;
  };
  const end = Date.parse('2024-06-17T14:00:00Z');
  const raw = [];
  for (let ms = end - 28 * 864e5, k = 0; ms < end; ms += 180000) {
    if (!open(ms)) continue;
    const c = Math.round((19000 + 0.08 * k + 40 * Math.sin((2 * Math.PI * k) / 400)) * 4) / 4;
    raw.push({ t: new Date(ms).toISOString(), o: c, h: c + 1, l: c - 1, c, v: 10 });
    k += 1;
  }
  const kept = normalizeBars(raw.slice(-historyBars(3)));
  assert.ok(Date.parse(kept[kept.length - 1].t) - Date.parse(kept[0].t) >= HISTORY_HOURS * 3600000 - 864e5, 'the runner keeps the read\'s window');
  const four = mtfRead(kept).frames.find(f => f.minutes === 240).read;
  assert.ok(four.candles >= DEFAULTS.slow + 10, `4h candles in the window: ${four.candles}`);
  assert.strictEqual(four.votes.fastVsSlow, 1, 'the EMA20-vs-EMA50 vote is cast');
  assert.notStrictEqual(four.emaSlow, null);
  assert.strictEqual(four.note, undefined);
  // The old 240-hour window: about 45 4h candles, so the vote was never cast.
  const old = mtfRead(kept, { opts: { historyHours: 240 } }).frames.find(f => f.minutes === 240).read;
  assert.ok(old.candles < DEFAULTS.slow);
  assert.strictEqual(old.votes.fastVsSlow, null);
  assert.match(old.note, /no EMA50 vote, needs 50/);
});
