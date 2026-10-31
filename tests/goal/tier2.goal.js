'use strict';

/**
 * The goal regression's tier 2 (npm run goal:full; its own CI job): the fixture's tier 2 days through the live path
 * with the mock policy (tests/goal/tier2-run.js), against main's tier 2 baseline. It fails on any blow, on fewer trades,
 * less total R or fewer fills of the mechanical tier's first entries than main beyond the
 * tolerances (config/training.json goalRegression.tier2.tolerance), on any lost or changed trade (each named by the
 * category of its break, goal-path.js CATEGORIES), and on any trade whose path trace is not whole (a step missing, failed
 * or out of order). The full trace is written outside the repository (its path printed). Its catch-the-move goldens
 * (below) share the one run: every layer of each move day as the golden has it, trend days caught and ridden. The break
 * self-tests, the negative probes, the state days and the broker-fault days are tier2-breaks, tier2-probes,
 * tier2-states and tier2-faults.goal.js.
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

// One run of every tier 2 day and every move day (each once, in parallel), read by both tests below.
let ALL = null;
const runAll = () => { ALL = ALL || (async () => { const t0 = Date.now(); const days = [...new Set([...BASE.days, ...T.moveDays()])]; const r = await T.runDays(days, { dir: OUT }); return { r, secs: (Date.now() - t0) / 1000 }; })(); return ALL; };
const pick = (r, days) => days.map(d => r.find(x => x.day === d));

test('tier 2: the live path with the mock policy is no worse than main (blows, trades, R, fills), every trade the same, its path whole, every day behaving as its label says', { skip }, async () => {
  const { r, secs } = await runAll();
  const results = pick(r, BASE.days);
  const now = T.readTier2(results);
  fs.writeFileSync(T.tracePath(OUT), JSON.stringify(now.trades.map(t => ({ key: t.key, trace: t.trace })), null, 1));
  const j = T.judge(BASE, now, results);
  const report = `${T.reportText(j)}\n(${r.length} days run in ${secs.toFixed(0)} s; the full trace: ${T.tracePath(OUT)})`;
  process.stdout.write(`${report}\n`);
  assert.ok(!j.fail, `tier 2 moved away from main:\n${report}`);
});

const GOLDEN = skip ? null : T.readGolden();
const MAX_LOSS_R = require('../../scripts/lib/tunables').training().goalRegression.tier2.maxLossR;

test('the move goldens cover the move days: the real trend legs and the synthetic fakeout and quiet day', { skip }, () => {
  assert.ok(GOLDEN && Array.isArray(GOLDEN.scenarios), `${SET.goldenFile} (node tests/goal/tier2-run.js --write-moves)`);
  assert.ok(GOLDEN.scenarios.some(s => s.layers && s.layers.exit.R < 0 && s.layers.exit.reason === 'stop'), 'a fakeout to -1R');
  assert.ok(GOLDEN.scenarios.some(s => !s.layers), 'a day whose right answer is no trade');
  // A composed limit entry end to end: its record's limit, filled within the record's life, its bracket, its exit.
  const limit = GOLDEN.scenarios.find(s => s.scenario === 'limit-fill');
  assert.ok(limit && limit.layers && limit.layers.entry.type === 'limit' && limit.layers.stop.price && limit.layers.exit.reason, 'a composed limit fill, bracketed and exited');
  assert.deepStrictEqual(GOLDEN.scenarios.map(x => x.day), T.moveDays());
  // The capture check is live: main catches and rides at least two trend legs here, so a capture loss fails.
  assert.ok(GOLDEN.scenarios.filter(x => x.label && x.label.kind === 'trend' && x.layers && x.layers.capture.caught && x.layers.exit.R > 0).length >= 2, 'at least two trend days caught and ridden on main');
});

test('catch the move: every layer on each move day as the golden has it, and each day behaving as its label says', { skip }, async () => {
  const results = pick((await runAll()).r, T.moveDays());
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
