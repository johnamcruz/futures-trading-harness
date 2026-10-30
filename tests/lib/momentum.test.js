'use strict';

// The momentum read (trading/momentum.js, D4): a bar read only (range at least 1 ATR, close in the far third, volume at
// least its average); on each completed candle (m3.candles.<tf>.momentum, candle-facts.js) from the values shown; the
// trend is its own read; causal; rendered on the candle's own summary line.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { momentumRead } = require('../../scripts/lib/trading/momentum');
const { candleSeries } = require('../../scripts/lib/trading/candle-facts');
const B = require('../../scripts/lib/trading/briefing');
const { readBarsArg } = require('../../scripts/lib/backtest/data');

const NQ = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

test('momentumRead: range at least 1 ATR, close in the far third, volume at least its average; anything missing is unknown', () => {
  const c = (rangeAtr, closeLocation, volRatio) => ({ rangeAtr, closeLocation, volRatio });
  assert.strictEqual(momentumRead(c(1, 'top', 1)), 'up', 'both thresholds inclusive');
  assert.strictEqual(momentumRead(c(1.6, 'bottom', 2.1)), 'down');
  assert.strictEqual(momentumRead(c(1.6, 'middle', 2.1)), 'none', 'a mid-range close');
  assert.strictEqual(momentumRead(c(0.99, 'top', 3)), 'none', 'a small range');
  assert.strictEqual(momentumRead(c(2, 'top', 0.99)), 'none', 'thin volume');
  for (const x of [c(null, 'top', 1), c(1, null, 1), c(1, 'top', null), null]) assert.strictEqual(momentumRead(x), null);
  // The trend is never part of it: an ADX or EMA field changes nothing.
  assert.strictEqual(momentumRead({ ...c(1.2, 'top', 1.1), adx: 5, adxSlope: -9, ema20: 1, ema50: 2 }), 'up');
});

test('no look-ahead: the read at a bar, from the per-bar candle series over all the bars, is the briefing\'s built on the bars cut at its close', () => {
  const series = { '3m': candleSeries(NQ, 3, 3), '15m': candleSeries(NQ, 15, 3), '1h': candleSeries(NQ, 60, 3), '4h': candleSeries(NQ, 240, 3) };
  const loc = x => (x === 1 ? 'top' : x === -1 ? 'bottom' : x === 0 ? 'middle' : null);
  const seen = new Set();
  for (let i = 300; i < NQ.length; i += 29) {
    const candles = B.buildBriefing({ symbol: 'NQ', bars: NQ.slice(0, i + 1), minutes: 3, blackouts: { items: [] } }).sections.m3.data.candles;
    for (const [tf, s] of Object.entries(series)) {
      const read = momentumRead({ rangeAtr: r2(s.htfd_range_atr[i]), closeLocation: loc(s.htfd_close_loc[i]), volRatio: r2(s.htfd_vol_ratio[i]) });
      if (!candles[tf] || candles[tf].unavailable) continue;
      assert.strictEqual(candles[tf].momentum, read, `bar ${i} ${tf}`);
      seen.add(read);
    }
  }
  for (const r of ['up', 'down', 'none']) assert.ok(seen.has(r), `${r} on the golden days`);
});

test('rendered on the candle\'s line: "momentum up" or "momentum down", nothing for none or unknown, nothing else changes', () => {
  let shown = 0;
  for (let n = 300; n <= NQ.length; n += 53) {
    const b = B.buildBriefing({ symbol: 'NQ', bars: NQ.slice(0, n), minutes: 3, blackouts: { items: [] } });
    const now = new Date(b.closedAt);
    const without = JSON.parse(JSON.stringify(b));
    for (const c of Object.values(without.sections.m3.data.candles)) delete c.momentum;
    const lines = B.renderBriefing(b, { now }).split('\n');
    const plain = B.renderBriefing(without, { now }).split('\n');
    assert.strictEqual(lines.length, plain.length);
    for (const [k, line] of lines.entries()) {
      if (line === plain[k]) continue;
      // The standard plan (setup-library.js planLine) composes from the candles, momentum among its entry reads.
      if (line.startsWith('- Standard plan')) continue;
      const tf = /^- (\w+) \((?:setup candle, |entry candle, timing, )?closed/.exec(line)[1];
      const m = b.sections.m3.data.candles[tf].momentum;
      assert.ok(m === 'up' || m === 'down');
      assert.strictEqual(line.replace(`, momentum ${m}`, ''), plain[k], 'only the read is added');
      shown += 1;
    }
  }
  assert.ok(shown > 0, 'a momentum read on the golden days');
});
