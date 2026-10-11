#!/usr/bin/env node
/**
 * Live against the scan for a trading day (scripts/lib/trading/reconcile.js):
 * which strategy signals the runner saw were traded, passed (and the note
 * that says why), and which entries had no signal behind them.
 *
 *   node scripts/reconcile.js --day 2026-10-07 [--timeframe 3] [--json]
 *
 * Reads <FTH_HOME>/logs/scans-<day>.jsonl and the broker's journal (broker config).
 * The operation lives in scripts/lib/harness-tools/reconcile.js.
 */

'use strict';

const { reconcile, parseArgv } = require('./lib/harness-tools/reconcile');
const { runCli } = require('./lib/harness-tools/cli');

/** Run with argv (after the script name): prints and sets the exit code. */
const main = argv => runCli('reconcile', () => reconcile(parseArgv(argv)));

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
