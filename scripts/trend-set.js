#!/usr/bin/env node
/**
 * The probe round's trend pool (docs/TRAINING.md, Propose-Probe-Compose; scripts/lib/train/trend-set.js): every trend leg
 * of a practice-train screen period, by the capture report's own detector, pinned to a file the loop config's
 * probe.trend.set names. Each round of the loop takes the next batch of its legs (the loop's seed).
 *
 *   node scripts/trend-set.js build --bars <file> --from YYYY-MM-DD --to YYYY-MM-DD --minutes M
 *       [--session 09:30-12:00@America/New_York] [--exclude YYYY-MM-DD,...] [--out dir]
 *       --minutes: the base timeframe (the runner's; 1m bars are aggregated to it); --to is exclusive; --session
 *       defaults to config/replay.json trendCapture.curationSessions; --exclude: the regression days (never in the
 *       pool); --out defaults to <FTH_HOME>/experience
 *   node scripts/trend-set.js show <trend pool file>
 */

'use strict';

const path = require('path');
const { harnessHome } = require('./lib/paths');
const { loadBars } = require('./lib/backtest/data');
const { baseBars } = require('./lib/learning/setup-library');
const TS = require('./lib/train/trend-set');

const USAGE = 'usage: trend-set.js build --bars <file> --from YYYY-MM-DD --to YYYY-MM-DD --minutes M [--session spec] [--exclude d,...] [--out dir] | show <file>';
const say = m => process.stdout.write(`${m}\n`);

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name}: a value\n${USAGE}`);
  return v;
}

function minutes(argv) {
  const v = opt(argv, '--minutes');
  if (v === undefined) throw new Error(`--minutes: required\n${USAGE}`);
  if (!/^\d+$/.test(v)) throw new Error('--minutes: a whole number');
  return Number(v);
}

function show(file) {
  const doc = TS.readTrendSet(path.resolve(file));
  say(`trend pool ${doc.fingerprint}: ${doc.legs.length} leg(s) in ${doc.sessions} session(s) of ${doc.from}..${doc.to}, session ${doc.detector.session}, detector ${doc.detector.version} at ${doc.detector.minMoveAtr} x the session's mean true range`);
  say(`excluded: ${doc.exclude.join(', ') || 'none'}`);
  return 0;
}

function build(argv) {
  const bars = opt(argv, '--bars');
  if (!bars) throw new Error(`--bars: required\n${USAGE}`);
  const session = opt(argv, '--session') || require('./lib/tunables').replay().trendCapture.curationSessions.join(',');
  const doc = TS.buildTrendSet({
    bars: baseBars(loadBars(path.resolve(bars)), minutes(argv)), session, from: opt(argv, '--from'), to: opt(argv, '--to'),
    exclude: (opt(argv, '--exclude') || '').split(',').map(x => x.trim()).filter(Boolean),
  });
  const file = TS.writeTrendSet(opt(argv, '--out') ? path.resolve(opt(argv, '--out')) : path.join(harnessHome(), 'experience'), doc);
  say(`wrote ${file}`);
  return show(file);
}

function main(argv) {
  if (argv[0] === 'build') return build(argv.slice(1));
  if (argv[0] === 'show' && argv[1]) return show(argv[1]);
  throw new Error(USAGE);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[trend-set] ${err.message}\n`);
  process.exitCode = 1;
}
