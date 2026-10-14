'use strict';

// Strategy parity with the original bot: the shipped STRATEGY.md rules must
// reproduce the original bot's signals. The expected signals in
// tests/fixtures/parity/*.expected.json were produced by the original bot's own
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
const { FX_STRATEGIES } = require('../helpers');

// The ports and their names in the original bot's output: the shipped one (orb), and the rules of the ports
// retired on 2026-10-13 (strategies/README.md, "Retired strategies") as test fixtures, so the rule series they read
// (swing crosses, EMA crosses with ADX, Keltner bands, SuperTrend flips) keep their parity: fx_break and fx_cross
// (tests/fixtures/strategies-fx, the old bos and ema_cross rules), fx_keltner and fx_supertrend
// (tests/fixtures/strategies-fx-parity).
// cisd_ote was a port until version 4 (2026-10-13): it is now the textbook CISD + OTE (strategies/cisd_ote), not the
// bot's detector, so the bot's cisd_ote signals in the fixtures are left out.
const NAMES = { orb: 'orb', fx_break: 'bos', fx_cross: 'ema', fx_keltner: 'keltner', fx_supertrend: 'supertrend' };
// The STRATEGY.md files, as written: Markdown rules, no strategy code.
const FX_DIRS = [FX_STRATEGIES, path.join(__dirname, '..', 'fixtures', 'strategies-fx-parity')].join(',');
const SHIPPED = loadStrategies(path.join(__dirname, '..', '..'), { FTH_STRATEGIES_DIRS: FX_DIRS }).strategies;
const strategy = name => {
  const s = SHIPPED.find(x => x.name === name);
  assert.ok(s && s.valid && s.signal === 'rules', `${name} is a valid rules strategy`);
  return s;
};

for (const sym of ['NQ', 'RTY']) {
  test(`${sym} 3m: every strategy fires exactly where the original bot does, with the same stop`, () => {
    const bars = loadBars(path.join(DIR, `${sym}-3m.csv`));
    const expected = require(path.join(DIR, `${sym}-3m.expected.json`));
    const ev = createEvaluator(bars);
    const got = [];
    for (let i = expected.first_eval_index; i < bars.length; i += 1) {
      for (const [signal, name] of Object.entries(NAMES)) {
        const r = ev.at(strategy(signal), i, { describe: false });
        if (!r.direction) continue;
        const d = r.direction === 'long' ? 1 : -1;
        // The original bot's stop: 0.5 x ATR(20) from the close.
        const stop = bars[i].c - d * r.stopDistance;
        got.push({ t: bars[i].t, s: name, d, stop: Math.round(stop * 100) / 100 });
      }
    }
    const key = x => `${new Date(x.t).toISOString()} ${x.s} ${x.d}`;
    const ported = new Set(Object.values(NAMES));
    const want = new Map(expected.signals.filter(x => ported.has(x.s)).map(x => [key(x), Math.round(x.stop * 100) / 100]));
    const have = new Map(got.map(x => [key(x), x.stop]));
    assert.deepStrictEqual([...have.keys()].filter(k => !want.has(k)), [], 'signals the original bot does not fire');
    assert.deepStrictEqual([...want.keys()].filter(k => !have.has(k)), [], 'signals the harness misses');
    for (const [k, stop] of want) assert.ok(Math.abs(have.get(k) - stop) <= 0.01, `${k}: stop ${have.get(k)} vs ${stop}`);
    assert.ok(want.size > 150, `${want.size} signals`);
    for (const n of Object.values(NAMES)) assert.ok(expected.signals.some(x => x.s === n), `the original bot fires ${n} here`);
  });
}
