'use strict';

/**
 * Tier 2's catch-the-move goldens (npm run goal:full): known trend legs (config/training.json goalRegression.moveDays,
 * a fixture block each) through the live path with the plan-following mock, each layer against its golden
 * (tests/fixtures/goal/move-scenarios.json, written once from main's code by node tests/goal/tier2-run.js
 * --write-moves): the Bias line, the setup the briefing listed, the entry bar, fill and size, the bracket stop and 1R,
 * the exit (the 2R order cancelled at the first managed cycle, the stop held to the target's R, the first move at or past
 * the lock, each trail move, the exit's reason, time, price and R), and the capture (the leg caught by trend-capture's
 * rule, its available R, at least the golden's share). Any change in a layer fails with a per-layer diff; a change that
 * improves capture updates the golden, explained in the pull request like any golden.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./tier2-run');

const SET = (() => { try { return T.set(); } catch (err) { return { missing: err.message }; } })();
const skip = SET.missing ? `skipped: ${SET.missing}` : false;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-moves-'));
const GOLDEN = skip ? null : T.readGolden();
const MAX_LOSS_R = require('../../scripts/lib/tunables').training().goalRegression.tier2.maxLossR;

test('the move goldens cover the move days: the real trend legs and the synthetic fakeout and quiet day', { skip }, () => {
  assert.ok(GOLDEN && Array.isArray(GOLDEN.scenarios), `${SET.goldenFile} (node tests/goal/tier2-run.js --write-moves)`);
  assert.ok(GOLDEN.scenarios.some(s => s.layers && s.layers.exit.R < 0 && s.layers.exit.reason === 'stop'), 'a fakeout to -1R');
  assert.ok(GOLDEN.scenarios.some(s => !s.layers), 'a day whose right answer is no trade');
  assert.deepStrictEqual(GOLDEN.scenarios.map(x => x.day), T.moveDays());
});

test('catch the move: every layer on each move day as the golden has it, and each day behaving as its label says', { skip }, async () => {
  const results = await T.runDays(T.moveDays(), { dir: OUT });
  const now = T.readMoves(results);
  const judged = T.judgeMoves(GOLDEN, now, results[0].tick);
  // The behaviour by label: a trend day the golden catches is caught and ridden (its R above 0); a non-trend day has
  // no entry, or a loss of at most the controlled 1R (the stop's slippage within maxLossR).
  const behaved = now.map((m, i) => {
    const label = results[i].label || {};
    const g = GOLDEN.scenarios.find(x => x.day === m.day);
    const L = m.layers;
    if (label.kind === 'trend' && g && g.layers && g.layers.capture.caught) return L && L.capture.caught && L.exit.R > 0 ? null : `${m.day} (trend): not caught and ridden (${L ? `${L.exit.R}R, caught ${L.capture.caught}` : 'no trade'})`;
    if (label.kind !== 'trend') return !L || L.exit.R >= -MAX_LOSS_R ? null : `${m.day} (${label.kind}): a loss of ${L.exit.R}R, past the controlled -${MAX_LOSS_R}R`;
    return null;
  }).filter(Boolean);
  const text = judged.map(j => `${j.day} (${(results.find(r => r.day === j.day).label || {}).kind || '?'}): ${j.diffs.length ? `\n  ${j.diffs.join('\n  ')}` : 'as the golden'}`).join('\n');
  process.stdout.write(`${text}\n${behaved.join('\n')}\n`);
  assert.ok(judged.every(j => !j.diffs.length), `a layer moved:\n${text}`);
  assert.deepStrictEqual(behaved, []);
});
