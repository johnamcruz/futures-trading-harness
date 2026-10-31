'use strict';

/**
 * Tier 2's aggregate (CI's goal-full job; npm run goal:aggregate -- <dir>): the tier 2 shards' results
 * (tests/goal/tier2.goal.js under FTH_GOAL_SHARD and FTH_GOAL_SHARD_OUT) judged as one run. Every shard 1..n of one n
 * once, of this fixture, their days tier 2's exactly (goal-path.js shardCoverage); then main's tier 2 baseline in full
 * (the sums: blows, trades, total R, fills; every trade, its trace, the behaviour) and every move day against its
 * golden, as an unsharded npm run goal:full judges them. Exit 1 on any problem.
 *
 *   node tests/goal/tier2-aggregate.js <dir>
 */

const fs = require('fs');
const path = require('path');
const T = require('./tier2-run');
const GP = require('../../scripts/lib/eval/goal-path');

function aggregate(dir) {
  const parts = fs.readdirSync(dir).filter(f => /^tier2-shard-\d+-of-\d+\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const lines = [];
  const coverage = GP.shardCoverage(parts, { days: T.allDays(), fixture: T.set().doc.hash });
  for (const p of coverage) lines.push(`shards: ${p}`);
  if (coverage.length) return { fail: true, lines };
  const results = parts.flatMap(p => p.results);
  const of = days => days.map(d => results.find(r => r.day === d));
  const base = JSON.parse(fs.readFileSync(T.BASELINE_FILE(), 'utf8')).tier2;
  const main = of(base.days);
  const j = T.judge(base, T.readTier2(main), main);
  lines.push(T.reportText(j));
  const moves = of(T.moveDays());
  const golden = T.readGolden();
  const now = T.readMoves(moves);
  const judged = T.judgeMoves(golden, now, moves[0].tick);
  const behaved = T.moveBehaviour(golden, now, moves);
  for (const m of judged) lines.push(`${m.day}: ${m.diffs.length ? m.diffs.join('; ') : 'as the golden'}`);
  for (const b of behaved) lines.push(`behaviour: ${b}`);
  lines.push(`${parts.length} shards, ${results.length} days`);
  return { fail: j.fail || judged.some(m => m.diffs.length) || behaved.length > 0, lines };
}

if (require.main === module) {
  try {
    const { fail, lines } = aggregate(process.argv[2] || '');
    process.stdout.write(`${lines.join('\n')}\n${fail ? 'tier 2 aggregate: FAIL' : 'tier 2 aggregate: ok'}\n`);
    process.exitCode = fail ? 1 : 0;
  } catch (err) {
    process.stderr.write(`tier 2 aggregate: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { aggregate };
