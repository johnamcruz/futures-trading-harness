'use strict';

/**
 * npm run goal:real: the goal regression on the local real fixture (docs/TRAINING.md, "The goal regression"): built
 * through the replay broker's MCP server (node scripts/goal-fixture.js --replay-config <config> --symbol MNQ), kept
 * under the harness home with its baseline and move goldens, never in the repository. Without it, a skip with how to
 * build it. CI runs the committed slice (npm run goal:full); this is the larger local check.
 *
 *   node tests/goal/real.js           tier 1 (goal-check.js run --real) and tier 2's files on the real fixture
 *   node tests/goal/real.js --write   the real baselines and move goldens written (each refuses a worse one)
 */

const { spawnSync } = require('child_process');
const path = require('path');
const GC = require('../../scripts/lib/eval/goal-check');

const ROOT = path.resolve(__dirname, '..', '..');
const env = { ...process.env, FTH_GOAL_FIXTURE: 'real' };
const node = args => spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' }).status;

function main(argv) {
  const set = GC.fixtureSet('real');
  if (set.missing) { process.stdout.write(`goal:real skipped: ${set.missing}\n`); return 0; }
  if (argv.includes('--write')) {
    const steps = [['scripts/goal-check.js', 'baseline', '--write', '--real'], ['tests/goal/tier2-run.js', '--write'], ['tests/goal/tier2-run.js', '--write-moves']];
    for (const s of steps) { const c = node(s); if (c !== 0) return c; }
    return 0;
  }
  const one = node(['scripts/goal-check.js', 'run', '--real']);
  const two = node(['--test', '--test-concurrency=2', 'tests/goal/tier2.goal.js', 'tests/goal/tier2-moves.goal.js']);
  return one || two;
}

process.exitCode = main(process.argv.slice(2));
