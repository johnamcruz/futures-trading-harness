'use strict';

/**
 * The goal regression's tier 2 (npm run goal:full; its own CI job): the fixture's tier 2 days through the live path
 * with the mock policy (tests/goal/tier2-run.js), against main's tier 2 baseline. It fails on any blow, on fewer trades,
 * less total R or fewer fills of the mechanical tier's first entries than main beyond the
 * tolerances (config/training.json goalRegression.tier2.tolerance), on any lost or changed trade (each named by the
 * category of its break, goal-path.js CATEGORIES), and on any trade whose path trace is not whole (a step missing, failed
 * or out of order). The full trace is written outside the repository (its path printed). The break self-tests, the
 * broker-fault days and the catch-the-move goldens are tier2-breaks, tier2-faults and tier2-moves.goal.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./tier2-run');
const GP = require('../../scripts/lib/eval/goal-path');

const SET = (() => { try { return T.set(); } catch (err) { return { missing: err.message }; } })();
const skip = SET.missing ? `skipped: ${SET.missing}` : false;
const BASE = skip ? null : JSON.parse(fs.readFileSync(SET.baselineFile, 'utf8')).tier2;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-tier2-'));
test('tier 2: main\'s baseline holds its days and a whole trace for every trade', { skip }, () => {
  assert.ok(BASE && Array.isArray(BASE.trades) && BASE.trades.length > 0, 'a tier 2 baseline (node tests/goal/tier2-run.js --write)');
  assert.deepStrictEqual(BASE.days, T.tier2Days(), 'the baseline\'s days are the configured ones (config/training.json goalRegression.tier2)');
  assert.strictEqual(BASE.fixture, SET.doc.hash, 'the tier 2 baseline is of this fixture');
  for (const t of BASE.trades) {
    const need = GP.STEPS.filter(s => s !== 'trail');
    assert.deepStrictEqual(t.steps.filter(s => s !== 'trail'), need, `${t.key}: every step, in order`);
  }
});

test('tier 2: the live path with the mock policy is no worse than main (blows, trades, R, fills), every trade the same, its path whole, every day behaving as its label says', { skip }, async () => {
  const t0 = Date.now();
  const results = await T.runDays(BASE.days, { dir: OUT });
  const now = T.readTier2(results);
  fs.writeFileSync(T.tracePath(OUT), JSON.stringify(now.trades.map(t => ({ key: t.key, trace: t.trace })), null, 1));
  const j = T.judge(BASE, now, results);
  const report = `${T.reportText(j)}\n(${results.length} days in ${((Date.now() - t0) / 1000).toFixed(0)} s; the full trace: ${T.tracePath(OUT)})`;
  process.stdout.write(`${report}\n`);
  assert.ok(!j.fail, `tier 2 moved away from main:\n${report}`);
});

