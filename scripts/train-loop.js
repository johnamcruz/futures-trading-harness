#!/usr/bin/env node
/**
 * The training loop (docs/LEARNED-RULEBOOK.md section 7a, section 10 step 14; skills/training-loop):
 * replays on tuning windows score the champion's decisions, the model the proposer's runner config names
 * proposes small edits to skills, strategies or the rulebook, and code judges each by a paired re-run of
 * the flagged decision points. A kept change becomes a local branch and a PR body draft for the owner to
 * review; nothing is pushed, merged or opened. The user starts it, as replays.
 *
 *   node scripts/train-loop.js plan   --config loop.json                  the plan and the looks it will take; nothing run
 *   node scripts/train-loop.js run    --config loop.json [--dry-run] [--steps steps.js]   run or resume (dry run: no branch)
 *   node scripts/train-loop.js status --config loop.json                  progress, verdicts, leaders
 *   node scripts/train-loop.js judge  --config loop.json --proposal <id> --held-out-look [--steps steps.js]
 *       held-out judging of a kept change: spends a look from the held-out budget (R16, R17)
 *   node scripts/train-loop.js import-proposal --config loop.json --file <proposal.json> --approved-by <name>
 *       tier 3, manual: a proposal a person brings (from any source they chose) for the next iteration
 *
 * --steps: a module exporting any of { scorecard, evaluator } (lib/train/loop.js defaultSteps) to plug in a
 * step built elsewhere (the scorecard of section 10 step 2, the evaluator of step 9). Config:
 * mcp-configs/train-loop.example.json (scripts/lib/train/config.js).
 */

'use strict';

require('./lib/env-file').loadEnvForCli('train-loop');

const fs = require('fs');
const path = require('path');
const { resolveLoop, windowRange } = require('./lib/train/config');
const { runLoop, judgeHeldOut, importProposal } = require('./lib/train/loop');
const { loopPaths, readLedger, lockHolder } = require('./lib/train/state');
const { readArchive, leaders } = require('./lib/train/archive');
const { parseProposals } = require('./lib/train/proposal');
const { checkLook } = require('./lib/prop/looks');
const { line, rideLines } = require('./lib/train/iteration-report');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: train-loop.js plan|run|status --config <loop.json> [--dry-run] [--steps <steps.js>] | judge --config <loop.json> --proposal <id> --held-out-look | import-proposal --config <loop.json> --file <proposal> --approved-by <name>';
const PLUGGABLE = ['scorecard', 'evaluator'];

const arg = (argv, name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const say = msg => process.stdout.write(`[train-loop] ${msg}\n`);

function load(argv) {
  const file = arg(argv, '--config');
  if (!file) throw new Error(USAGE);
  return resolveLoop(JSON.parse(fs.readFileSync(file, 'utf8')), { baseDir: path.dirname(path.resolve(file)) });
}

function steps(argv) {
  const file = arg(argv, '--steps');
  if (!file) return {};
  const mod = require(path.resolve(file));
  const extra = Object.keys(mod).filter(k => !PLUGGABLE.includes(k));
  if (extra.length) throw new Error(`--steps: only ${PLUGGABLE.join(', ')} may be plugged in, not ${extra.join(', ')}`);
  return mod;
}

function plan(loop) {
  const paths = loopPaths(process.env, loop.loopId);
  const ledger = readLedger(paths.ledger);
  say(`loop ${loop.loopId}: state ${paths.dir}; runs, checkpoints and trees in ${loop.workDir}`);
  for (const w of loop.tuningWindows) {
    const { start, end } = windowRange(w);
    const v = checkLook({ candidate: `${loop.loopId}/plan`, purpose: 'tuning', ranges: [w] }, ledger);
    say(`tuning ${w.from}..${w.to} (${start.toISOString()} to ${end.toISOString()}): ${v.ok ? `allowed (${v.units.map(u => u.key).join(', ')})` : `REFUSED: ${v.refusals.join('; ')}`}`);
  }
  for (const w of loop.heldOutWindows || []) {
    const v = checkLook({ candidate: `${loop.loopId}/plan`, purpose: 'judging', ranges: [w] }, ledger);
    say(`held-out ${w.from}..${w.to}: judge only with --held-out-look; ${v.ok ? `budget left ${v.units.map(u => (u.budgeted ? u.remaining : 'none needed')).join(', ')}` : `REFUSED: ${v.refusals.join('; ')}`}`);
  }
  say(`per iteration: up to ${loop.maxFlagged} flagged + ${loop.controlPoints} control decisions, ${loop.repeats} repeat(s), up to ${loop.maxProposals} proposal(s), seed ${loop.seed}`);
  say(`evaluator: ${loop.evaluator ? `${loop.evaluator.prop} on ${Object.keys(loop.evaluator.data).join(', ')}, champion and candidate on one seed` : 'none (a strategy or rulebook change stays blocked)'}`);
  say(`model scoring: ${loop.modelScore ? `on (account ${loop.modelScore.account}): the challenger replays every window, judged by the keep rule (train/model-verifier.js); a kept change is a PR, never promoted` : 'off (the paired panel test and the evaluator only)'}`);
  say(`probe: ${loop.probe ? `on: ${loop.probe.k} edit(s) a round, each replayed alone on ${loop.probe.windows.map(w => `${w.from}..${w.to}`).join(', ')} (practice-train, no budget), ${loop.probe.parallel} at once; the passing ones composed, then the keep rule` : 'off'}`);
  for (const l of require('./lib/train/plan').probePlan(loop, { root: ROOT })) say(l);
  say(`proposer: harness ${loop.proposer.harness}${loop.proposer.model ? ` (${loop.proposer.model})` : ''}; limits ${JSON.stringify(loop.limits)}; decision rule ${JSON.stringify(loop.rule)}`);
  return 0;
}

const readJsonOr = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return null; }
};

function status(loop) {
  const paths = loopPaths(process.env, loop.loopId);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch (_err) { /* not started */ }
  if (!state) {
    say(`loop ${loop.loopId} has not run`);
    return 0;
  }
  const holder = lockHolder(paths.lock);
  say(`${holder ? `running (pid ${holder.pid}, ${holder.loopId})` : 'not running'}; ${state.iterations.filter(i => i.done).length} iteration(s) done; ${state.modelCalls} model call(s)${state.stopped ? `; last stop: ${state.stopped}` : ''}`);
  const archive = readArchive(paths.archive);
  for (const e of archive) say(`${e.phase === 'held-out' ? 'held-out' : `iteration ${e.iteration}`}: ${e.proposalId} ${e.verdict}: ${(e.reasons || []).join('; ')}${e.promotion && e.promotion.branch ? ` (branch ${e.promotion.branch})` : ''}`);
  // Propose-Probe-Compose: each iteration in one line (lib/train/iteration-report.js), from its iteration-report.json.
  for (const it of state.iterations) {
    const rec = readJsonOr(path.join(paths.iter(it.n), 'iteration-report.json'));
    if (rec) { say(line(rec)); rideLines(rec).forEach(l => say(l)); }
  }
  for (const l of leaders(archive)) say(`leader for ${l.category}: ${l.proposalId} (iteration ${l.iteration}, effect ${l.effect})`);
  return 0;
}

function readProposal(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = parseProposals(text);
  if (found.length > 1) throw new Error(`${file}: one proposal per import`);
  if (found.length === 1) {
    if (found[0].error) throw new Error(`${file}: ${found[0].error}`);
    return found[0].proposal;
  }
  return JSON.parse(text);
}

async function main(argv) {
  require('./lib/tunables').assertUsable(); // a refused config file: no training (the CRITICAL error)
  const cmd = argv[0];
  if (!['plan', 'run', 'status', 'judge', 'import-proposal'].includes(cmd)) throw new Error(USAGE);
  const loop = load(argv);
  if (cmd === 'plan') return plan(loop);
  if (cmd === 'status') return status(loop);
  if (cmd === 'import-proposal') {
    if (!arg(argv, '--file')) throw new Error(USAGE);
    const { id, file } = importProposal({ loop, root: ROOT, proposal: readProposal(arg(argv, '--file')), approvedBy: arg(argv, '--approved-by') });
    say(`queued ${id} for the next iteration (${file}); it is judged like any other proposal`);
    return 0;
  }
  if (cmd === 'judge') {
    const v = await judgeHeldOut({ loop, root: ROOT, steps: steps(argv), proposalId: arg(argv, '--proposal'), heldOutLook: argv.includes('--held-out-look'), log: say });
    say(`held-out verdict: ${v.verdict}: ${v.reasons.join('; ')}`);
    return v.verdict === 'stopped' ? 1 : 0;
  }
  const res = await runLoop({ loop, root: ROOT, steps: steps(argv), dryRun: argv.includes('--dry-run'), log: say });
  say(`${res.iterations} iteration(s) done${res.stopped ? `; stopped: ${res.stopped}` : ''}; status: node scripts/train-loop.js status --config ${arg(argv, '--config')}`);
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[train-loop] ${err.message}\n`);
  process.exitCode = 1;
});
