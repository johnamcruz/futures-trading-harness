'use strict';

/**
 * The goal regression's tier 2 (npm run goal:full; in CI its shards, then the goal-full job): the fixture's tier 2 days
 * through the live path with the mock policy (tests/goal/tier2-run.js), against main's tier 2 baseline. It fails on any
 * blow, on fewer trades, less total R or fewer fills of the mechanical tier's first entries than main beyond the
 * tolerances (config/training.json goalRegression.tier2.tolerance), on any lost or changed trade (each named by the
 * category of its break, goal-path.js CATEGORIES), and on any trade whose path trace is not whole (a step missing, failed
 * or out of order). The full trace is written outside the repository (its path printed). Its catch-the-move goldens
 * (below) share the one run: every layer of each move day as the golden has it, trend days caught and ridden. The break
 * self-tests, the negative probes, the state days, the floor days and the broker-fault days are tier2-breaks,
 * tier2-probes, tier2-states, tier2-floor and tier2-faults.goal.js.
 *
 * Sharded (FTH_GOAL_SHARD=k/n, CI's matrix): this run plays shard k's days only (goal-path.js shardDays) and judges
 * each of them (every trade, its trace, its behaviour, its move layers); the sums (blows, trades, R, fills) are the
 * aggregate's, over every shard's days: FTH_GOAL_SHARD_OUT names the folder its results go to, and
 * tests/goal/tier2-aggregate.js judges them all (the goal-full job).
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
const SHARD = GP.shardOf(process.env.FTH_GOAL_SHARD);
// A shard judges no sums: without its results folder (for the aggregate) it would pass on part of the days alone.
if (SHARD && !process.env.FTH_GOAL_SHARD_OUT) throw new Error('FTH_GOAL_SHARD without FTH_GOAL_SHARD_OUT: a shard\'s days are judged as one run only by the aggregate (unset FTH_GOAL_SHARD for the whole run)');
const DAYS = skip ? [] : GP.shardDays(T.allDays(), SHARD);
test('tier 2: main\'s baseline holds its days and a whole trace for every trade', { skip }, () => {
  assert.ok(BASE && Array.isArray(BASE.trades) && BASE.trades.length > 0, 'a tier 2 baseline (node tests/goal/tier2-run.js --write)');
  assert.deepStrictEqual(BASE.days, T.tier2Days(), 'the baseline\'s days are the configured ones (config/training.json goalRegression.tier2)');
  assert.strictEqual(BASE.fixture, SET.doc.hash, 'the tier 2 baseline is of this fixture');
  for (const t of BASE.trades) {
    const need = GP.STEPS.filter(s => s !== 'trail');
    assert.deepStrictEqual(t.steps.filter(s => s !== 'trail'), need, `${t.key}: every step, in order`);
  }
});

// One run of this shard's days (each once, in parallel), read by both tests below; a shard's results written for the
// aggregate.
let ALL = null;
const runAll = () => {
  ALL = ALL || (async () => {
    const t0 = Date.now();
    const r = await T.runDays(DAYS, { dir: OUT });
    if (SHARD && process.env.FTH_GOAL_SHARD_OUT) {
      fs.mkdirSync(process.env.FTH_GOAL_SHARD_OUT, { recursive: true });
      fs.writeFileSync(path.join(process.env.FTH_GOAL_SHARD_OUT, `tier2-shard-${SHARD.k}-of-${SHARD.n}.json`), JSON.stringify({ shard: SHARD, fixture: SET.doc.hash, days: DAYS, results: r }));
    }
    return { r, secs: (Date.now() - t0) / 1000 };
  })();
  return ALL;
};
const pick = (r, days) => days.filter(d => DAYS.includes(d)).map(d => r.find(x => x.day === d));

test('tier 2: the live path with the mock policy is no worse than main (blows, trades, R, fills), every trade the same, its path whole, every day behaving as its label says', { skip }, async () => {
  const { r, secs } = await runAll();
  const results = pick(r, BASE.days);
  const now = T.readTier2(results);
  fs.writeFileSync(T.tracePath(OUT), JSON.stringify(now.trades.map(t => ({ key: t.key, trace: t.trace })), null, 1));
  const j = T.judge(SHARD ? T.baseOn(BASE, DAYS) : BASE, now, results);
  const report = `${T.reportText(j)}\n(${SHARD ? `shard ${SHARD.k}/${SHARD.n}: ` : ''}${r.length} days run in ${secs.toFixed(0)} s; the full trace: ${T.tracePath(OUT)})`;
  process.stdout.write(`${report}\n`);
  assert.ok(!j.fail, `tier 2 moved away from main:\n${report}`);
});

const GOLDEN = skip ? null : T.readGolden();

test('the move goldens cover the move days: the real trend legs and the synthetic fakeout and quiet day', { skip }, () => {
  assert.ok(GOLDEN && Array.isArray(GOLDEN.scenarios), `${SET.goldenFile} (node tests/goal/tier2-run.js --write-moves)`);
  assert.ok(GOLDEN.scenarios.some(s => s.layers && s.layers.exit.R < 0 && s.layers.exit.reason === 'stop'), 'a fakeout to -1R');
  assert.ok(GOLDEN.scenarios.some(s => !s.layers), 'a day whose right answer is no trade');
  // A composed limit entry end to end: its record's limit, filled within the record's life, its bracket, its exit.
  const limit = GOLDEN.scenarios.find(s => s.scenario === 'limit-fill');
  assert.ok(limit && limit.layers && limit.layers.entry.type === 'limit' && limit.layers.stop.price && limit.layers.exit.reason, 'a composed limit fill, bracketed and exited');
  // The floor days: no trade (compose refuses a stop under D13's floor: tier2-floor.goal.js checks the refusal).
  for (const f of T.floorDays()) assert.ok(GOLDEN.scenarios.some(s => s.day === f.day && !s.layers), `${f.day} (floor-${f.bind}): no trade in the golden`);
  assert.deepStrictEqual(GOLDEN.scenarios.map(x => x.day), T.moveDays());
  // The capture check is live: main catches and rides at least two trend legs here, so a capture loss fails.
  assert.ok(GOLDEN.scenarios.filter(x => x.label && x.label.kind === 'trend' && x.layers && x.layers.capture.caught && x.layers.exit.R > 0).length >= 2, 'at least two trend days caught and ridden on main');
});

test('catch the move: every layer on each move day as the golden has it, each day behaving as its label says, every size the rulebook\'s', { skip }, async () => {
  const results = pick((await runAll()).r, T.moveDays());
  if (!results.length) return; // a shard without a move day
  const now = T.readMoves(results);
  const judged = T.judgeMoves(GOLDEN, now, results[0].tick);
  const behaved = T.moveBehaviour(GOLDEN, now, results);
  const text = judged.map(j => `${j.day} (${(results.find(r => r.day === j.day).label || {}).kind || '?'}): ${j.diffs.length ? `\n  ${j.diffs.join('\n  ')}` : 'as the golden'}`).join('\n');
  process.stdout.write(`${text}\n${behaved.join('\n')}\n`);
  assert.ok(judged.every(j => !j.diffs.length), `a layer moved:\n${text}`);
  assert.deepStrictEqual(behaved, []);
  // Every sized or skipped entry of the move days as the rulebook plans it (the main days' are in readTier2's problems).
  assert.deepStrictEqual(T.sizingProblems(results), []);
});
