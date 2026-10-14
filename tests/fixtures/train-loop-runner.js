'use strict';

// The training loop's end-to-end runner (tests/e2e/train-loop-e2e.test.js), in a process of its own so the test
// controls HOME and FTH_HOME. The real loop (scripts/lib/train/loop.js) with two steps planted: trees copied from
// the working tree (the tests run before a commit; the real step exports HEAD), and a planted scorecard that reads
// each decision's result line (the real one is section 10 step 2's). Everything else is real: the replay driver
// with checkpoints, the decision-point runs through autotrader.js --once, the fake harness CLI, the replay broker,
// the proposer, validation, apply and sync, the paired test, the archive and the promotion files.
//
//   node train-loop-runner.js <loop.json> run [--dry-run] | judge <proposalId> | import <file> <approvedBy>

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { resolveLoop } = require(path.join(ROOT, 'scripts', 'lib', 'train', 'config'));
const { runLoop, judgeHeldOut, importProposal } = require(path.join(ROOT, 'scripts', 'lib', 'train', 'loop'));
const { copyTree } = require(path.join(ROOT, 'scripts', 'lib', 'train', 'tree'));
const { readRun } = require(path.join(ROOT, 'scripts', 'lib', 'replay', 'store'));

const CATEGORY = [[/planted failure/, 'wrong stated reason'], [/planted harm/, 'wrong-side entry'], [/planted fix/, 'right']];

function scorecard({ runDir }) {
  const { days } = readRun(runDir);
  return Object.values(days).flat().filter(l => l.kind === 'trade').map(l => {
    const text = (l.ran || []).map(r => r.result || '').join(' ');
    const hit = CATEGORY.find(([re]) => re.test(text));
    return { key: `${l.t}|MNQ`, t: l.t, day: l.day, symbol: 'MNQ', category: hit ? hit[1] : 'unchecked', inTrade: false, blow: false, expected: { decision: 'no trade' }, actual: { action: 'none' }, why: [], falseReasons: [], stated: text };
  });
}

async function main([file, cmd, ...rest]) {
  const loop = resolveLoop(JSON.parse(fs.readFileSync(file, 'utf8')), { baseDir: path.dirname(file) });
  const steps = { makeTree: dir => copyTree(ROOT, dir), scorecard };
  const log = m => process.stdout.write(`[loop] ${m}\n`);
  let out;
  if (cmd === 'run') out = await runLoop({ loop, root: ROOT, steps, dryRun: rest.includes('--dry-run'), log });
  else if (cmd === 'judge') out = await judgeHeldOut({ loop, root: ROOT, steps, proposalId: rest[0], heldOutLook: rest.includes('--held-out-look'), log });
  else if (cmd === 'import') out = importProposal({ loop, root: ROOT, proposal: JSON.parse(fs.readFileSync(rest[0], 'utf8')), approvedBy: rest[1] });
  else throw new Error(`unknown command ${cmd}`);
  process.stdout.write(`RESULT ${JSON.stringify(out)}\n`);
}

main(process.argv.slice(2)).catch(err => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
