'use strict';

/**
 * Live against the scan for a trading day (scripts/reconcile.js;
 * trading/reconcile.js): which strategy signals the runner saw were traded,
 * passed (and the note that says why), and which entries had no signal.
 *
 *   reconcile { day, timeframe, json }   day: YYYY-MM-DD; timeframe: minutes per bar (default 3)
 *
 * Reads <FTH_HOME>/logs/scans-<day>.jsonl and the broker's journal (broker config).
 */

const fs = require('fs');
const path = require('path');
const { reconcile: reconcileDay, toText } = require('../trading/reconcile');
const { resolveJournalPath, readJournal, entryTime } = require('../trading/journal');
const { tradingDayKey } = require('../trading/clock');
const { harnessHome } = require('../paths');
const { context } = require('./cli');

const USAGE = 'usage: reconcile.js --day YYYY-MM-DD [--timeframe 3] [--json]';

function reconcile({ day = null, timeframe = 3, json = false } = {}, ctx) {
  const { env } = context(ctx);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new Error('--day YYYY-MM-DD (the trading day, by the date it ends on)');
  if (!(Number.isInteger(timeframe) && timeframe > 0)) throw new Error('--timeframe: minutes per bar');
  const file = path.join(harnessHome(env), 'logs', `scans-${day}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`no decision log for ${day} (${file}); the autonomous runner writes one every trading day it runs`);
  const scans = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_err) { return null; } }).filter(Boolean);
  const journal = readJournal(resolveJournalPath(env)).filter(e => tradingDayKey(new Date(entryTime(e))) === day);
  const r = reconcileDay(scans, journal, { timeframeMin: timeframe });
  return { text: json ? `${JSON.stringify(r, null, 2)}\n` : toText(r, day) };
}

/** argv to { day, timeframe, json }. */
function parseArgv(argv) {
  const o = { day: null, timeframe: 3, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--day') o.day = value();
    else if (flag === '--timeframe') o.timeframe = Number(value());
    else if (flag === '--json') o.json = true;
    else throw new Error(`unknown argument: ${argv[i]} (${USAGE})`);
  }
  return o;
}

const OPS = { reconcile };

module.exports = { OPS, USAGE, reconcile, parseArgv };
