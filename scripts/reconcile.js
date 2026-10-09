#!/usr/bin/env node
/**
 * Live against the scan for a trading day (scripts/lib/trading/reconcile.js):
 * which strategy signals the runner saw were traded, passed (and the note
 * that says why), and which entries had no signal behind them.
 *
 *   node scripts/reconcile.js --day 2026-10-07 [--timeframe 3] [--json]
 *
 * Reads <FTH_HOME>/logs/scans-<day>.jsonl and the broker's journal (broker config).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { reconcile, toText } = require('./lib/trading/reconcile');
const { resolveJournalPath, readJournal, entryTime } = require('./lib/trading/journal');
const { tradingDayKey } = require('./lib/trading/clock');
const { harnessHome } = require('./lib/paths');

function main(argv) {
  const o = { day: null, timeframe: 3, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--day') o.day = value();
    else if (flag === '--timeframe') o.timeframe = Number(value());
    else if (flag === '--json') o.json = true;
    else throw new Error(`unknown argument: ${argv[i]} (usage: reconcile.js --day YYYY-MM-DD [--timeframe 3] [--json])`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.day || ''))) throw new Error('--day YYYY-MM-DD (the trading day, by the date it ends on)');
  if (!(Number.isInteger(o.timeframe) && o.timeframe > 0)) throw new Error('--timeframe: minutes per bar');
  const file = path.join(harnessHome(), 'logs', `scans-${o.day}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`no decision log for ${o.day} (${file}); the autonomous runner writes one every trading day it runs`);
  const scans = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_err) { return null; } }).filter(Boolean);
  const journal = readJournal(resolveJournalPath(process.env)).filter(e => tradingDayKey(new Date(entryTime(e))) === o.day);
  const r = reconcile(scans, journal, { timeframeMin: o.timeframe });
  process.stdout.write(o.json ? `${JSON.stringify(r, null, 2)}\n` : toText(r, o.day));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[reconcile] ${err.message}\n`);
  process.exitCode = 1;
}
