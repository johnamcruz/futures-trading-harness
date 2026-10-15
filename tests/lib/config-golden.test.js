'use strict';

// The move of the tunables into config/ changed no value: tests/fixtures/config/pre-move.json was generated from the
// code before the move (each value as the code held it, and where), and every config key must still equal it. A
// deliberate change of a value updates the config file and this fixture together, explained in its pull request
// (CONTRIBUTING.md, "Golden files").
const test = require('node:test');
const assert = require('node:assert');
const T = require('../../scripts/lib/tunables');
const { valueAt } = require('../../scripts/lib/config-files');
const GOLDEN = require('../fixtures/config/pre-move.json');

const plain = x => JSON.parse(JSON.stringify(x));
const leaves = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? leaves(v, `${p}${k}.`) : [`${p}${k}`]));

test('config golden: every moved value equals the constant the code held before the move', () => {
  assert.deepStrictEqual(Object.keys(GOLDEN).sort(), [...T.NAMES].sort());
  for (const [file, keys] of Object.entries(GOLDEN)) {
    for (const [key, { value, from }] of Object.entries(keys)) assert.deepStrictEqual(plain(valueAt(T[file](), key)), value, `${file}.${key} (was ${from})`);
  }
});

test('config golden: every config value is one the golden covers (nothing added without its pre-move value)', () => {
  for (const file of T.NAMES) {
    const covered = Object.keys(GOLDEN[file]);
    const missing = leaves(T[file]()).filter(l => l !== 'version' && !covered.some(c => l === c || l.startsWith(`${c}.`)));
    assert.deepStrictEqual(missing, [], file);
  }
});

test('config golden: the modules read the config (their exported values are the config\'s)', () => {
  const R = T.runner();
  const timing = require('../../scripts/lib/trading/gate-timing');
  assert.deepStrictEqual([timing.PENDING_ORDER_TTL_MS, timing.ORDER_GRACE_MS, timing.CALL_TIMEOUT_MS], [R.gate.pendingOrderTtlMs, R.gate.orderGraceMs, R.gate.callTimeoutMs]);
  const cfg = require('../../scripts/lib/trading/config').loadConfig({});
  for (const k of ['planMaxAgeMin', 'maxConsecutiveLosses', 'lossCooldownMin', 'maxDailyLosses', 'maxEntriesPerDay', 'mtfMaxAgeMin', 'signalMaxAgeBars', 'minConfluence', 'maxCorrelatedPositions']) assert.strictEqual(cfg[k], R.gate[k], k);
  assert.strictEqual(cfg.noEntryWindows, R.gate.noEntryWindows.join(','));
  assert.strictEqual(cfg.signalMaxAgeCeilingMin, R.gate.signalMaxAgeCeilingMin);
  const lc = require('../../scripts/lib/trading/trade-lifecycle');
  assert.deepStrictEqual([lc.STOP_BUFFER_TICKS, lc.FLOOR_TICKS, lc.FLOOR_ATR, lc.MAX_SIZE, lc.MAX_BYTES], [R.lifecycle.stopBufferTicks, R.lifecycle.floorTicks, R.lifecycle.floorAtr, R.lifecycle.maxSize, R.limits.lifecycleBytes]);
  const ps = require('../../scripts/lib/trading/prop-state');
  assert.deepStrictEqual([ps.SNAPSHOT_MAX_AGE_MS, ps.BALANCE_TOLERANCE], [R.account.snapshotMaxAgeMs, R.account.balanceToleranceUsd]);
  assert.deepStrictEqual(require('../../scripts/lib/prop/mc-size').MC_SIZE, { paths: R.monteCarlo.paths, reps: R.monteCarlo.reps });
  assert.strictEqual(require('../../scripts/lib/prop/mc-size').MC_MAX, R.monteCarlo.max);
  const D = require('../../scripts/lib/autotrader').DEFAULTS;
  assert.deepStrictEqual([D.timeframe, D.barDelaySeconds, D.barPollSeconds, D.barTimeoutSeconds, D.premarketAt, D.maxConsecutiveErrors], [R.bars.timeframe, R.bars.delaySeconds, R.bars.pollSeconds, R.bars.timeoutSeconds, R.bars.premarketAt, R.cycle.maxConsecutiveErrors]);

  const Tr = T.training();
  const stage = require('../../scripts/lib/replay/stage');
  const { seed: _seed, reps: _reps, ...exitBars } = plain(Tr.exitTest);
  assert.deepStrictEqual(plain(stage.EXIT_TEST), { ...exitBars, minN: Tr.experienceIndex.minN, minDays: Tr.experienceIndex.minDays });
  assert.strictEqual(require('../../scripts/lib/train/model-verifier').KEEP_RULE, Tr.keepRule);
  assert.strictEqual(require('../../scripts/lib/train/paired').DECISION_RULE, Tr.decisionRule);
  assert.strictEqual(require('../../scripts/lib/train/screen').SCREEN, Tr.screen);
  assert.deepStrictEqual(plain(require('../../scripts/lib/train/probe-config').PROBE_LIMITS), { k: [Tr.probe.k.default, Tr.probe.k.min, Tr.probe.k.max], parallel: [Tr.probe.parallel.default, Tr.probe.parallel.min, Tr.probe.parallel.max] });
  const ei = require('../../scripts/lib/learning/experience-index');
  assert.deepStrictEqual([ei.MIN_N, ei.MIN_DAYS, ei.LEVEL], [Tr.experienceIndex.minN, Tr.experienceIndex.minDays, Tr.experienceIndex.level]);

  const Rp = T.replay();
  assert.deepStrictEqual(plain(stage.STAGES[1]), { name: Rp.stages[1].name, defaults: plain(Rp.stages[1].defaults), refused: plain(Rp.stages[1].refused) }, 'stage 1 has no comparisonOnly, as before');
  assert.deepStrictEqual(plain(stage.STAGES[2]), plain(Rp.stages[2]));
  const cl = require('../../scripts/lib/learning/curated-lists');
  assert.deepStrictEqual(plain(cl.DEFAULTS), { total: Rp.curatedLists.total, mix: plain(Rp.curatedLists.mix), minSkill: Rp.curatedLists.minSkill, passShare: plain(Rp.curatedLists.passShare), seed: Rp.curatedLists.seed });

  const A = T.analysis();
  assert.deepStrictEqual(plain(require('../../scripts/lib/trading/regime').REGIME_PARAMS), plain((({ minBars: _m, minBarsOverSlope: _o, ...r }) => r)(A.regime)));
  assert.deepStrictEqual(plain(require('../../scripts/lib/trading/cisd').PARAMS), plain(A.cisd));
  assert.deepStrictEqual(plain(require('../../scripts/lib/trading/volume-profile').PARAM_DEFAULTS), plain(A.volumeProfile));
  const P = require('../../scripts/lib/trading/market-snapshot').PARAMS;
  assert.deepStrictEqual([P.emaFast, P.emaSlow, P.adxPeriod, P.stPeriod, P.stMult, P.kcLen, P.kcMult, P.kcAtr, P.swingK, P.orbMinutes, P.stopAtrMult, P.vpLookback, P.adrDays, P.crtSweepBars, P.crtMinRR],
    [A.snapshot.emaFast, A.snapshot.emaSlow, A.indicators.adxPeriod, A.indicators.supertrendPeriod, A.indicators.supertrendMult, A.indicators.keltnerLen, A.indicators.keltnerMult, A.indicators.keltnerAtr, A.indicators.swingK, A.indicators.openingRangeMinutes, A.snapshot.stopAtrMult, A.snapshot.vpLookback, A.dayContext.adrDays, A.crt.sweepBars, A.crt.minRR]);
  const mtf = require('../../scripts/lib/trading/mtf');
  assert.deepStrictEqual([mtf.DEFAULTS.historyHours, mtf.HISTORY_HOURS, [...mtf.RULE_FRAMES]], [A.mtf.historyHours, A.mtf.historyHours + A.mtf.historyMarginHours, [...A.mtf.ruleFrames]]);
});

test('config golden: a strategy\'s params still override the analysis config (the strategy wins)', () => {
  const { classifyRegime, REGIME_PARAMS } = require('../../scripts/lib/trading/regime');
  const bars = Array.from({ length: 200 }, (_, i) => ({ t: new Date(Date.parse('2026-03-02T14:30:00Z') + i * 180000).toISOString(), o: 100 + i * 0.5, h: 101 + i * 0.5, l: 99.5 + i * 0.5, c: 100.5 + i * 0.5, v: 100 }));
  const base = classifyRegime(bars);
  assert.ok(base, 'enough bars');
  // A steady climb reads as a trend under the config; a trend threshold no ADX reaches (the strategy's) reads it as none.
  assert.strictEqual(base.primary, 'trend-up');
  assert.ok(REGIME_PARAMS.trendAdx < 1000);
  assert.notStrictEqual(classifyRegime(bars, { trendAdx: 1000 }).primary, 'trend-up', 'the override is used, not the config');
  const { paramsFrom } = require('../../scripts/lib/trading/cisd');
  assert.strictEqual(paramsFrom({ cisdMinRun: 5 }).minRun, 5);
  assert.strictEqual(paramsFrom({}).minRun, T.analysis().cisd.minRun);
  const vp = require('../../scripts/lib/trading/volume-profile');
  assert.notDeepStrictEqual(vp.optionsFromParams({ vpRows: 50 }), vp.optionsFromParams({}));
});
