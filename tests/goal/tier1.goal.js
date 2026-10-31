'use strict';

/**
 * The goal regression's tier 1 mutation checks (npm run goal:full): a copy of the harness tree with one shipped rule
 * changed for the worse, each of a kind the mechanical tier claims to guard, must fail tier 1 against the baseline on
 * the metric it moves; the unchanged copy must pass (a test that can't catch the break it claims to guard is no test).
 * On the fixture set FTH_GOAL_FIXTURE names (ci by default; real: the local one, skipped when it isn't built).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const GC = require('../../scripts/lib/eval/goal-check');
const { tmpDir, treeCopy } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const SET = GC.fixtureSet(GC.kindOf());
const skip = SET.missing ? `skipped: ${SET.missing}` : false;
const BASE = skip ? null : JSON.parse(fs.readFileSync(SET.baselineFile, 'utf8'));
const TOL = require('../../scripts/lib/tunables').training().goalRegression.tolerance;
const POLICY = require('../../scripts/lib/eval/goal-trades').shippedOf(ROOT, {}).policy;
const RULEBOOK = `accounts/${POLICY.account}/RULEBOOK.md`;
const LIFECYCLE = 'strategies/trade_lifecycle/STRATEGY.md';

const edit = (...changes) => root => {
  for (const [file, from, to] of changes) {
    const p = path.join(root, file);
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(text.includes(from), `${file} holds ${from}`);
    fs.writeFileSync(p, text.replace(from, to));
  }
};

const run = change => GC.summary(GC.evaluate(SET.doc, { root: treeCopy(tmpDir(), change), env: {}, synth: SET.synth }));
const failing = now => GC.regressions(GC.compare(BASE, now, TOL)).map(r => `${r.half} ${r.key}`);

test('tier 1 control: an unchanged copy of the tree passes', { skip }, () => {
  assert.deepStrictEqual(failing(run(() => {})), []);
});

const CHECKS = [
  // The exit: the lock at the 2R target given back to +1.5R instead of +0.5R (a tighter lock the exit study rejected).
  { name: 'exit (lock_giveback_r 1.5 -> 0.5)', change: edit([RULEBOOK, 'lock_giveback_r: 1.5', 'lock_giveback_r: 0.5']), metric: /mc\.pass|meanR|caught/ },
  // The gate's entry rule: every bias frame must trend the side (no neutral 15m-declared side).
  { name: 'entry rule (bias_agree neutral-15m-declared -> on)', change: edit([RULEBOOK, 'bias_agree: neutral-15m-declared', 'bias_agree: on']), metric: /mc\.pass|meanR|caught/ },
  // The sizing broken on the blow path: three times the cushion's share and a $3,000 cap per trade.
  { name: 'sizing (cushion_frac 0.9, max_risk_usd 3000) on the blow path', change: edit([RULEBOOK, 'cushion_frac: 0.3 ', 'cushion_frac: 0.9 '], [RULEBOOK, 'cap_usd: 1000 ', 'cap_usd: 3000 '], [LIFECYCLE, 'max_risk_usd: 300 ', 'max_risk_usd: 3000 ']), metric: /mc\.blows/ },
  // Sizing below the minimum: a floor no stop fits, so every entry is skipped.
  { name: 'sizing below min (min_contracts 3 -> 60)', change: edit([RULEBOOK, 'min_contracts: 3 ', 'min_contracts: 60 ']), metric: /mc\.pass|meanR|caught/ },
  // The stop: the D13 floor at 160 ticks, refusing most structure stops.
  { name: 'stop floor (stop_floor_ticks 8 -> 160)', change: edit([LIFECYCLE, 'stop_floor_ticks: 8 ', 'stop_floor_ticks: 160 ']), metric: /mc\.pass|meanR|caught/ },
];

for (const c of CHECKS) {
  test(`tier 1 mutation check: ${c.name} fails tier 1`, { skip }, () => {
    const bad = failing(run(c.change));
    assert.ok(bad.some(k => c.metric.test(k)), `${c.name}: tier 1 must fail on ${c.metric}; it failed on: ${bad.join(', ') || 'nothing'}`);
  });
}
