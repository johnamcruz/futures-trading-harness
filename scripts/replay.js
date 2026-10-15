#!/usr/bin/env node
/**
 * Replay: the live harness (runner, harness CLI, agents, skills, scripts,
 * order gate, broker interface) run over history, one decision time per
 * process, against a replay broker (a brokers.json entry with "replay": true,
 * e.g. backtester-mcp) that simulates the data, the clock and the fills.
 * Replay runs are the user's to start, like backtests and training.
 *
 *   node scripts/replay.js run --config replay.json [--max-cycles N]   run (or resume) a replay; a learning run (the
 *       default; "learning": false in the config declares one that is not) lies in one window of the learning split
 *       and takes its look first (learning/run-gate.js): --validate for practice-validate months, --candidate and
 *       --evaluation (the arms of one evaluation share it) for test or final, --reasoning-fix (outcomes hidden); every
 *       look goes to the one ledger, <FTH_HOME>/learning/looks.jsonl; the config's experienceIndex (and setupLibrary) is pinned for the
 *       run (learning/experience-index.js)
 *   node scripts/replay.js points --config replay.json                 the decision times, nothing run
 *   node scripts/replay.js report <run dir | --config replay.json> [--account <name>] [--natural-rates file]   month by
 *       month, with the 30-day Monte Carlo prop score of the model's trades (prop/model-score.js: zero blows, pass
 *       within 30 days, median and p90 days to pass, blow and timeout rates; a curated run's, with its natural rates,
 *       is diagnostic) and the learning measures; writes report.md. `run` prints the score when the run finishes
 *   node scripts/replay.js labels <run dir> [--budget USD] [--bars SYM=file ...]   the teacher's decisions as labels (labels.jsonl);
 *       --bars: the data the run replayed (one-minute or the run's bars), for the counterfactuals of untaken setups;
 *       --out: write elsewhere (required for an unfinished run, outside its run home)
 *   node scripts/replay.js scorecard <run dir> [--bars SYM=file ...] [--out dir]   the adherence scorecard: each decision
 *       against the priority order's mechanical steps, its stated reasons checked against the facts, a failure
 *       category and its severity (scorecard.jsonl, scorecard-summary.json, scorecard.md), and the flagged decisions
 *       for review (flagged.jsonl, flagged.md); --bars and --out as for labels; a look at the schedule's months
 *       (prop/looks.js): --purpose reasoning-fix (default in Recent: outcomes hidden) | tuning (default elsewhere) |
 *       judging, --ledger <file> (required for judging; an allowed look is appended to it), --candidate <name>
 *   node scripts/replay.js experience <run dir> [--bars SYM=file ...]   the learning loop's experience log (<run
 *       home>/experience/decisions.jsonl; learning/run-experience.js), of a learning run that passed the gate; `run`
 *       writes it when the run finishes; `report` adds the learning measures (learning/learning-report.js).
 *   report, labels and scorecard read a live session's folder (<FTH_HOME>/sessions/<day>, session/live.js) as a run's
 *
 * Config: mcp-configs/replay.example.json (scripts/lib/replay/config.js).
 * Each run lives in its own harness home, <workDir>/<runId>, never the live
 * one; its records are in <run home>/replay/<runId>/ (<day>.jsonl, manifest,
 * report.md, steps.log). A re-run resumes after the last decision time done;
 * a changed config, harness or model needs a new runId.
 */

'use strict';

// The replay broker's settings (data folder, guardrails) from the user's .env; a live broker's
// variables never reach a replay process (replay/config.js replayEnv replaces them).
require('./lib/env-file').loadEnvForCli('replay');

const fs = require('fs');
const path = require('path');
const { resolveReplay, setupHash, setupFixed, setupBase, lookArm } = require('./lib/replay/config');
const { decisionPoints, tradingDays } = require('./lib/replay/schedule');
const { seedRunHome, runReplay } = require('./lib/replay/driver');
const { readRun } = require('./lib/replay/store');
const { summarize, toMarkdown, toText } = require('./lib/replay/report');
const { propScoreSection } = require('./lib/prop/model-score');
const { loadAccounts } = require('./lib/trading/accounts');
const { writeLabels, summaryText } = require('./lib/replay/labels');
const scorecard = require('./lib/replay/scorecard');
const { checkLearningRun, startLearningRun, readLearningRun } = require('./lib/learning/run-gate');
const { writeRunExperience, experienceLine } = require('./lib/learning/run-experience');
const { pinForRun } = require('./lib/learning/run-pins');
const { pinCurated, curatedPoints } = require('./lib/learning/curated-lists');
const learning = require('./lib/learning/learning-report');
const { loadStrategies } = require('./lib/trading/strategies');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: replay.js run --config <replay.json> [--max-cycles N] [--validate | --candidate name --evaluation id [--reasoning-fix]] | points --config <replay.json> | report <run dir> | report --config <replay.json> [--account <name>] [--natural-rates file] | labels <run dir> [--budget USD] [--bars SYM=file ...] [--out dir] | scorecard <run dir> [--bars SYM=file ...] [--out dir] [--purpose reasoning-fix|tuning|judging] [--ledger file] [--candidate name] | experience <run dir> [--bars SYM=file ...]';

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function load(argv) {
  const file = arg(argv, '--config');
  if (!file) throw new Error(USAGE);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return resolveReplay(raw, { baseDir: path.dirname(path.resolve(file)), env: process.env, root: ROOT });
}

const say = msg => process.stdout.write(`[replay] ${msg}\n`);

function points(run) {
  const all = decisionPoints(run.cfg, { start: run.start, end: run.end, everyNth: run.everyNth });
  const list = run.curated ? curatedPoints(all, run.curated, (run.cfg.barDelaySeconds || 0) * 1000).filter(p => !p.manage) : all;
  for (const d of tradingDays(run.cfg, run)) {
    const mine = list.filter(p => p.day === d.day);
    const kinds = ['premarket', 'trade', 'eod'].map(k => `${mine.filter(p => p.kind === k).length} ${k}`).join(', ');
    process.stdout.write(`${d.day}  ${d.skipped ? `skipped: ${d.skipped}` : `${kinds}${mine.length ? ` (${mine[0].t.toISOString()} .. ${mine[mine.length - 1].t.toISOString()})` : ''}`}\n`);
  }
  process.stdout.write(`${list.length} decision times${run.curated ? ' of the curated windows (plus management times, stepped only while something is open: not counted)' : ''}; each trade time is one harness cycle (${run.cfg.harness}${run.cfg.model ? ` ${run.cfg.model}` : ''}) unless the runner stands down\n`);
  return 0;
}

function report(argv) {
  const cfg = arg(argv, '--config') ? load(argv) : null;
  const dir = cfg ? cfg.paths.runDir : argv.slice(1).find((a, i, all) => !a.startsWith('--') && !['--account', '--natural-rates', '--bars'].includes(all[i - 1]));
  if (!dir || dir.startsWith('--')) throw new Error(USAGE);
  outcomesShown(dir, 'report');
  const { manifest, days } = readRun(path.resolve(dir));
  const summary = summarize(days);
  // The 30-day Monte Carlo of the model's trades (prop/model-score.js): the account named, else the run's attempt, ...
  const prop = propScoreSection(dir, { root: ROOT, override: arg(argv, '--account'), ratesFile: arg(argv, '--natural-rates') || null, curated: cfg && cfg.curated, barsFiles: barsArgs(argv) });
  const file = path.join(path.resolve(dir), 'report.md');
  // The learning measures, when the run has an experience log (learning/learning-report.js), the prop score beside them.
  const learned = learning.readLearning(path.resolve(dir, '..', '..'));
  const measures = learned ? learning.learningMeasures({ ...learned, prop: prop.summary }) : null;
  fs.writeFileSync(file, `${toMarkdown(summary, manifest)}\n${prop.markdown}${measures ? `\n${learning.learningMarkdown(measures)}` : ''}`);
  process.stdout.write(toText(summary) + prop.text + (measures ? learning.learningText(measures) : ''));
  say(`wrote ${file}`);
  return 0;
}

// --bars SYMBOL=file, any number of times: the data the run replayed.
function barsArgs(argv) {
  const barsFiles = {};
  argv.forEach((a, i) => {
    if (a !== '--bars') return;
    const m = /^([A-Z0-9]+)=(.+)$/.exec(String(argv[i + 1] || ''));
    if (!m) throw new Error('--bars: SYMBOL=file (e.g. MNQ=~/data/MNQ-1m.parquet)');
    barsFiles[m[1]] = m[2];
  });
  return barsFiles;
}

// The adherence scorecard (scripts/lib/replay/scorecard.js), written in the run's folder or --out, never the repository.
// A learning run on a reasoning-fix look (learning/run-gate.js) hides its outcomes: no report or labels, a reasoning-fix scorecard.
function outcomesShown(dir, what) {
  const l = readLearningRun(path.resolve(dir)) || readLearningRun(path.resolve(dir, '..', '..'));
  if (l && l.hideOutcomes) throw new Error(`${what} refused: this learning run is a reasoning-fix look, its outcomes hidden (the scorecard with --purpose reasoning-fix shows the rest)`);
}

function score(argv) {
  if (!argv[1] || argv[1].startsWith('--')) throw new Error(USAGE);
  if (arg(argv, '--purpose') !== 'reasoning-fix') outcomesShown(argv[1], 'a scorecard but reasoning-fix');
  const look = { purpose: arg(argv, '--purpose') || null, candidate: arg(argv, '--candidate') || null, ledgerFile: arg(argv, '--ledger') || null };
  const opts = { root: ROOT, strategies: loadStrategies(ROOT, process.env).strategies, accounts: loadAccounts(ROOT, process.env).accounts, barsFiles: barsArgs(argv), outDir: arg(argv, '--out') || null, look };
  const { file, summary } = scorecard.writeScorecard(argv[1], opts);
  process.stdout.write(scorecard.summaryText(summary));
  say(`wrote ${file}, scorecard-summary.json, scorecard.md, flagged.jsonl and flagged.md${summary.unfinished ? ` (the run is not finished: ${summary.unfinished})` : ''}`);
  return 0;
}

// Labels (stage 2): one per decision time and symbol, written in the run's folder, never the repository.
function labels(argv) {
  if (!argv[1] || argv[1].startsWith('--')) throw new Error(USAGE);
  outcomesShown(argv[1], 'labels');
  const budget = arg(argv, '--budget') !== undefined ? Number(arg(argv, '--budget')) : null;
  if (budget !== null && !(budget > 0)) throw new Error('--budget: the dollars a trade may risk, above 0');
  const barsFiles = barsArgs(argv);
  // The strategies' exits for the counterfactuals: the ones the run's gate read (the repository's and FTH_STRATEGIES_DIRS).
  const { strategies } = loadStrategies(ROOT, process.env);
  const { file, summary } = writeLabels(argv[1], { root: ROOT, budgetUsd: budget, strategies, barsFiles, outDir: arg(argv, '--out') || null });
  process.stdout.write(summaryText(summary));
  say(`wrote ${file} and labels-summary.json${summary.unfinished ? ` (the run is not finished: ${summary.unfinished})` : ''}`);
  return 0;
}


async function run(argv) {
  const r = load(argv);
  const max = arg(argv, '--max-cycles') !== undefined ? Number(arg(argv, '--max-cycles')) : Infinity;
  if (!(max === Infinity || (Number.isInteger(max) && max > 0))) throw new Error('--max-cycles: a positive whole number');
  // The learning gate (learning/run-gate.js): checked before the run home is seeded, its look taken before the first cycle.
  const gate = { from: r.start, to: r.end, runId: r.runId, learning: r.learning, candidate: arg(argv, '--candidate') || null, evaluation: arg(argv, '--evaluation') || null, validate: argv.includes('--validate'), reasoningFix: argv.includes('--reasoning-fix'), endOfDay: r.endOfDay, practice: r.practice, runDir: r.paths.runDir, arm: lookArm(r), config: setupHash(r), base: setupBase(r), setup: setupFixed(r) };
  checkLearningRun(gate);
  const fresh = seedRunHome(r, { root: ROOT, userEnv: process.env });
  const learned = startLearningRun(r.paths.runHome, gate);
  // The record the model is shown (walk-forward: only days before each bar's session), frozen for the run.
  for (const line of pinForRun(r, { fresh, arm: gate.arm })) say(line);
  if (r.curated) say(`curated list pinned: ${r.curated.list} of ${pinCurated(r.paths.runHome, r.curated).fingerprint.slice(0, 16)}, ${r.curated.windows.length} window(s)`);
  say(`${fresh ? 'new run' : 'resuming'} ${r.runId} in ${r.paths.runHome} (broker ${r.broker}, ${r.start.toISOString()} to ${r.end.toISOString()}; ${learned.learning ? `learning: ${learned.role}${learned.look ? `, ${learned.look.purpose} look ${learned.look.evaluation}` : ''}` : 'not a learning run'})`);
  const res = await runReplay({ run: r, baseEnv: process.env, root: ROOT, maxCycles: max, log: say });
  if (res.stopped) say(`${res.stopped}; run it again to resume`);
  else say(`done: ${res.cycles} decision time(s) this time; report: node scripts/replay.js report ${r.paths.runDir}`);
  // A finished learning run logs its experience (learning/run-experience.js); a run declared not learning has none.
  if (res.done) {
    try { if (learned.learning) say(experienceLine(writeRunExperience(r.paths.runDir, { root: ROOT }))); } catch (err) { say(`experience log not written: ${err.message}`); }
    process.stdout.write(propScoreSection(r.paths.runDir, { root: ROOT, curated: r.curated, riskActions: false }).text);
  }
  return res.stopped && !/max-cycles/.test(res.stopped) ? 1 : 0;
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === 'run') return run(argv);
  if (cmd === 'points') return points(load(argv));
  if (cmd === 'report') return report(argv);
  if (cmd === 'labels') return labels(argv);
  if (cmd === 'scorecard') return score(argv);
  if (cmd === 'experience') { say(experienceLine(writeRunExperience(argv[1] && !argv[1].startsWith('--') ? argv[1] : '', { root: ROOT, barsFiles: barsArgs(argv) }))); return 0; }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[replay] ${err.message}\n`);
  process.exitCode = 1;
});
