'use strict';

// Strategy parity with algoTraderBot: the shipped STRATEGY.md rules must
// reproduce algoTraderBot's signals. The expected signals in
// tests/fixtures/parity/*.expected.json were produced by algoTraderBot's own
// Python detectors (strategies/*.py detect() on 500-bar windows) on its 3m
// bar data. The harness must fire the same direction on the same bar with
// the same stop, for every strategy.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadBars } = require('../../scripts/lib/backtest/data');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');

const DIR = path.join(__dirname, '..', 'fixtures', 'parity');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');

const NAMES = { supertrend: 'supertrend', ema_cross: 'ema', keltner: 'keltner', bos: 'bos', orb: 'orb', cisd_ote: 'cisd_ote' };
// The shipped STRATEGY.md files, as written: Markdown rules, no strategy code.
const SHIPPED = loadStrategies(path.join(__dirname, '..', '..'), {}).strategies;
const strategy = name => {
  const s = SHIPPED.find(x => x.name === name);
  assert.ok(s && s.valid && s.signal === 'rules', `${name} is a valid rules strategy`);
  return s;
};

for (const sym of ['NQ', 'RTY']) {
  test(`${sym} 3m: every strategy fires exactly where algoTraderBot does, with the same stop`, () => {
    const bars = loadBars(path.join(DIR, `${sym}-3m.csv`));
    const expected = require(path.join(DIR, `${sym}-3m.expected.json`));
    const ev = createEvaluator(bars);
    const got = [];
    for (let i = expected.first_eval_index; i < bars.length; i += 1) {
      for (const [signal, name] of Object.entries(NAMES)) {
        const r = ev.at(strategy(signal), i, { describe: false });
        if (!r.direction) continue;
        const d = r.direction === 'long' ? 1 : -1;
        // algoTraderBot's stop: 0.5 x ATR(20) from the close; cisd_ote: the zone pivot, measured from the entry bar's open.
        const stop = signal === 'cisd_ote' ? bars[i].o - d * r.stopDistance : bars[i].c - d * r.stopDistance;
        got.push({ t: bars[i].t, s: name, d, stop: Math.round(stop * 100) / 100 });
      }
    }
    const key = x => `${new Date(x.t).toISOString()} ${x.s} ${x.d}`;
    const want = new Map(expected.signals.map(x => [key(x), Math.round(x.stop * 100) / 100]));
    const have = new Map(got.map(x => [key(x), x.stop]));
    assert.deepStrictEqual([...have.keys()].filter(k => !want.has(k)), [], 'signals algoTraderBot does not fire');
    assert.deepStrictEqual([...want.keys()].filter(k => !have.has(k)), [], 'signals the harness misses');
    for (const [k, stop] of want) assert.ok(Math.abs(have.get(k) - stop) <= 0.01, `${k}: stop ${have.get(k)} vs ${stop}`);
    assert.ok(want.size > 150);
  });
}
