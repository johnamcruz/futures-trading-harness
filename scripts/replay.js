#!/usr/bin/env node
/**
 * Replay: the live harness (runner, harness CLI, agents, skills, scripts,
 * order gate, broker interface) run over history, one decision time per
 * process, against a replay broker (a brokers.json entry with "replay": true,
 * e.g. backtester-mcp) that simulates the data, the clock and the fills.
 * Replay runs are the user's to start, like backtests and training.
 *
 *   node scripts/replay.js run --config replay.json [--max-cycles N]   run (or resume) a replay
 *   node scripts/replay.js points --config replay.json                 the decision times, nothing run
 *   node scripts/replay.js report <run dir | --config replay.json>     month by month; writes report.md
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
const { resolveReplay } = require('./lib/replay/config');
const { decisionPoints, tradingDays } = require('./lib/replay/schedule');
const { seedRunHome, runReplay } = require('./lib/replay/driver');
const { readRun } = require('./lib/replay/store');
const { summarize, toMarkdown, toText } = require('./lib/replay/report');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: replay.js run --config <replay.json> [--max-cycles N] | points --config <replay.json> | report <run dir> | report --config <replay.json>';

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
  const list = decisionPoints(run.cfg, { start: run.start, end: run.end, everyNth: run.everyNth });
  for (const d of tradingDays(run.cfg, run)) {
    const mine = list.filter(p => p.day === d.day);
    const kinds = ['premarket', 'trade', 'eod'].map(k => `${mine.filter(p => p.kind === k).length} ${k}`).join(', ');
    process.stdout.write(`${d.day}  ${d.skipped ? `skipped: ${d.skipped}` : `${kinds}${mine.length ? ` (${mine[0].t.toISOString()} .. ${mine[mine.length - 1].t.toISOString()})` : ''}`}\n`);
  }
  process.stdout.write(`${list.length} decision times; each trade time is one harness cycle (${run.cfg.harness}${run.cfg.model ? ` ${run.cfg.model}` : ''}) unless the runner stands down\n`);
  return 0;
}

function report(argv) {
  const dir = arg(argv, '--config') ? load(argv).paths.runDir : argv[1];
  if (!dir) throw new Error(USAGE);
  const { manifest, days } = readRun(path.resolve(dir));
  const summary = summarize(days);
  const file = path.join(path.resolve(dir), 'report.md');
  fs.writeFileSync(file, toMarkdown(summary, manifest));
  process.stdout.write(toText(summary));
  say(`wrote ${file}`);
  return 0;
}

async function run(argv) {
  const r = load(argv);
  const max = arg(argv, '--max-cycles') !== undefined ? Number(arg(argv, '--max-cycles')) : Infinity;
  if (!(max === Infinity || (Number.isInteger(max) && max > 0))) throw new Error('--max-cycles: a positive whole number');
  const fresh = seedRunHome(r, { root: ROOT, userEnv: process.env });
  say(`${fresh ? 'new run' : 'resuming'} ${r.runId} in ${r.paths.runHome} (broker ${r.broker}, ${r.start.toISOString()} to ${r.end.toISOString()})`);
  const res = await runReplay({ run: r, baseEnv: process.env, root: ROOT, maxCycles: max, log: say });
  if (res.stopped) say(`${res.stopped}; run it again to resume`);
  else say(`done: ${res.cycles} decision time(s) this time; report: node scripts/replay.js report ${r.paths.runDir}`);
  return res.stopped && !/max-cycles/.test(res.stopped) ? 1 : 0;
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === 'run') return run(argv);
  if (cmd === 'points') return points(load(argv));
  if (cmd === 'report') return report(argv);
  throw new Error(USAGE);
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[replay] ${err.message}\n`);
  process.exitCode = 1;
});
