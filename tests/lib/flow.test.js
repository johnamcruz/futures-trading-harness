'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withFlow, flowCsv, parseFlowCsv, readFlow, flowFile } = require('../../scripts/lib/trading/flow');
const { barDelta, ofi, normalizeBars } = require('../../scripts/lib/trading/indicators');
const { loadBars, aggregate } = require('../../scripts/lib/backtest/data');
const { tmpDir } = require('../helpers');

const M = 60000;
const T0 = Date.UTC(2026, 9, 8, 14, 0);
const C = 'MNQ';
const at = (min, sec = 0) => new Date(T0 + min * M + sec * 1000).toISOString();

test('bars get flow only when every minute is known; CSV round-trips', () => {
  const map = new Map([[T0, { bv: 3, sv: 1 }], [T0 + M, { bv: 0, sv: 2 }], [T0 + 2 * M, { bv: 1, sv: 1 }]]);
  const bars = [{ t: at(0), o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: at(3), o: 1, h: 1, l: 1, c: 1, v: 1 }];
  const out = withFlow(bars, map, 3);
  assert.deepStrictEqual([out[0].bv, out[0].sv, out[1].bv], [4, 4, undefined]);
  assert.deepStrictEqual(parseFlowCsv(flowCsv([{ t: T0, bv: 1.5, sv: 2 }])), [{ t: T0, bv: 1.5, sv: 2 }]);
});

test('real flow replaces the bar-shape estimate in delta and ofi', () => {
  const bars = normalizeBars([{ t: at(0), o: 10, h: 11, l: 9, c: 11, v: 10, bv: 2, sv: 8 }, { t: at(1), o: 11, h: 12, l: 10, c: 12, v: 10 }]);
  assert.deepStrictEqual(barDelta(bars), [-6, 10], 'real flow on the first bar, the estimate on the second');
  assert.strictEqual(ofi(bars, 1)[0], -0.6);
});

test('data files: buy/sell volume (or delta) columns load, and aggregate only where every minute has flow', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'f.csv');
  fs.writeFileSync(file, `time,open,high,low,close,volume,buy_volume,sell_volume\n${at(0)},1,2,0,1,10,6,4\n${at(1)},1,2,0,1,10,3,7\n${at(2)},1,2,0,1,10,,\n${at(3)},1,2,0,1,10,5,5\n`);
  const bars = loadBars(file);
  assert.deepStrictEqual(bars.map(b => [b.bv, b.sv]), [[6, 4], [3, 7], [undefined, undefined], [5, 5]]);
  const agg = aggregate(bars, { unit: 2, unitNumber: 2, nowMs: T0 + 4 * M });
  assert.deepStrictEqual(agg.map(b => [b.bv, b.sv]), [[9, 11], [undefined, undefined]]);
  const dfile = path.join(dir, 'd.csv');
  fs.writeFileSync(dfile, `time,open,high,low,close,volume,delta\n${at(0)},1,2,0,1,10,4\n`);
  assert.deepStrictEqual(loadBars(dfile).map(b => [b.bv, b.sv]), [[7, 3]]);
});

test('flow that misses most of a bar\'s volume is not used; the estimate is', () => {
  const bars = normalizeBars([{ t: at(0), o: 10, h: 11, l: 9, c: 11, v: 2000, bv: 30, sv: 10 }]);
  assert.deepStrictEqual(barDelta(bars), [2000], 'bar-shape estimate (close at the high), not the partial flow');
});

test('recorded flow files load by contract and time window', () => {
  const home = tmpDir();
  fs.mkdirSync(path.dirname(flowFile(home, C)), { recursive: true });
  fs.writeFileSync(flowFile(home, C), flowCsv([{ t: T0, bv: 3, sv: 1 }, { t: T0 + M, bv: 0, sv: 2 }]));
  assert.deepStrictEqual(readFlow(home, C, { from: T0 + M }).map(r => [r.t, r.bv, r.sv]), [[T0 + M, 0, 2]]);
  assert.deepStrictEqual(readFlow(home, 'MES'), []);
});
