#!/usr/bin/env node
/**
 * The training preflight alone: is this learning replay set up for the owner's two goals, learning to trade and
 * passing the prop firm? Read-only: it starts nothing, seeds nothing and takes no look (scripts/lib/learning/preflight.js;
 * docs/TRAINING.md). scripts/replay.js run runs the same checks before every learning run and refuses it on a FAIL.
 *
 *   node scripts/training-preflight.js --config replay.json [--bars SYM=file ...] [--validate | --candidate name
 *       --evaluation id [--reasoning-fix]] [--json]
 *
 * One line per check: PASS, FAIL, WARN or N/A (a feature not merged yet, or a check that doesn't apply) with its
 * reason. Exit 0 when nothing fails (N/A and WARN never fail), 1 on a FAIL, 2 on a usage error.
 */

'use strict';

if (require.main === module) require('./lib/env-file').loadEnvForCli('replay');

const fs = require('fs');
const path = require('path');
const { resolveReplay } = require('./lib/replay/config');
const { runChecks, formatReport, defaultReaders, gateOptions } = require('./lib/learning/preflight');

const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: training-preflight.js --config <replay.json> [--bars SYM=file ...] [--validate | --candidate name --evaluation id [--reasoning-fix]] [--json]';

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** --bars SYMBOL=file, any number of times: the run's bars (one-minute or the run's own). */
function barsArgs(argv) {
  const out = {};
  argv.forEach((a, i) => {
    if (a !== '--bars') return;
    const m = /^([A-Z0-9]+)=(.+)$/.exec(String(argv[i + 1] || ''));
    if (!m) throw new Error('--bars: SYMBOL=file');
    out[m[1]] = m[2];
  });
  return out;
}

function main(argv, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const file = arg(argv, '--config');
  if (!file) {
    err.write(`${USAGE}\n`);
    return 2;
  }
  let run;
  let barsFiles;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    run = resolveReplay(raw, { baseDir: path.dirname(path.resolve(file)), env, root: ROOT });
    barsFiles = barsArgs(argv);
  } catch (e) {
    err.write(`[training-preflight] ${e.message}\n`);
    return 2;
  }
  if (!run.learning) {
    out.write('not a learning run ("learning": false): no training preflight\n');
    return 0;
  }
  const gate = gateOptions(run, { candidate: arg(argv, '--candidate') || null, evaluation: arg(argv, '--evaluation') || null, validate: argv.includes('--validate'), reasoningFix: argv.includes('--reasoning-fix') });
  const result = runChecks({ run, gate, read: defaultReaders(ROOT, env, { barsFiles }) });
  out.write(argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result));
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, barsArgs };
