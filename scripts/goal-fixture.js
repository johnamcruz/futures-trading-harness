#!/usr/bin/env node
'use strict';

/**
 * Builds the goal regression's fixture (scripts/lib/eval/goal-fixture.js; docs/TRAINING.md, "The goal regression"):
 * a seeded sample of real sessions in blocks with their warm-up, each session labelled (trend or non-trend, and why),
 * plus the move days' blocks. Re-runnable: the same bars and config give the same fixture.
 *
 *   node scripts/goal-fixture.js --bars <3m bars file> --symbol MNQ
 *        the committed CI slice (tests/fixtures/goal/bars.json.gz): config goalRegression's draw, small
 *   node scripts/goal-fixture.js --replay-config <replay config.json> --symbol MNQ
 *   node scripts/goal-fixture.js --broker <name> --symbol MNQ
 *        the local goal:real fixture: its bars fetched through the configured broker's MCP server (goal-fetch.js: the
 *        replay config's replay broker, its clock moved chunk by chunk; or a broker by name, read only), the larger draw
 *        (goalRegression.real), written under the harness home (<FTH_HOME>/goal/real-bars.json.gz), never the repository
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { baseBars, runnerClock } = require('./lib/learning/setup-library');
const { HISTORY_HOURS } = require('./lib/trading/mtf');
const { tickOf } = require('./lib/trading/contracts');
const GF = require('./lib/eval/goal-fixture');
const GT = require('./lib/eval/goal-trades');
const GC = require('./lib/eval/goal-check');

const USAGE = 'usage: goal-fixture.js (--bars <bars file> | --replay-config <replay config.json> | --broker <name>) --symbol <root> [--out <file.json.gz>]';
const ROOT = path.resolve(__dirname, '..');
const MINUTES = require('./lib/tunables').runner().bars.timeframe; // the runner's base bars (3m)

function args(argv) {
  const o = { bars: null, 'replay-config': null, broker: null, symbol: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i].replace(/^--/, '');
    if (!(k in o) || argv[i + 1] === undefined) throw new Error(USAGE);
    o[k] = argv[i += 1];
  }
  if (!o.symbol || [o.bars, o['replay-config'], o.broker].filter(Boolean).length !== 1) throw new Error(USAGE);
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  const cfg = require('./lib/tunables').training().goalRegression;
  const real = Boolean(o['replay-config'] || o.broker);
  const draw = real ? { ...cfg, ...cfg.real } : cfg;
  const sched = require('./lib/schedule').current();
  const tick = tickOf(o.symbol);
  if (!tick) throw new Error(`${o.symbol}: not a contract the harness lists`);
  const from = sched.data.sessionsFrom;
  const to = sched.learning.windows['practice-train'][1];
  const session = require('./lib/tunables').replay().trendCapture.curationSessions.join(',');
  let source;
  let bars;
  if (real) {
    // The user's .env (the broker server's entry and settings), as every CLI that starts a broker loads it.
    require('./lib/env-file').loadEnvForCli('goal-fixture');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-fetch-'));
    const start = new Date(Date.parse(`${from}T00:00:00Z`) - HISTORY_HOURS * 3600000);
    bars = baseBars(await require('./lib/eval/goal-fetch').fetchAll({ root: ROOT, replayConfig: o['replay-config'], broker: o.broker, from: start, to: new Date(`${to}T00:00:00Z`), dir, symbol: o.symbol, minutes: MINUTES }), MINUTES);
    fs.rmSync(dir, { recursive: true, force: true });
    source = { broker: o.broker ? `${o.broker} (MCP, read only)` : 'the replay config\'s replay broker (MCP)', bars: bars.length };
  } else {
    source = { file: path.basename(o.bars), sha256: crypto.createHash('sha256').update(fs.readFileSync(o.bars)).digest('hex') };
    bars = baseBars(require('./lib/backtest/data').loadBars(o.bars), MINUTES).filter(b => b.t < `${to}T23:59:59Z`);
  }
  if (!bars.length) throw new Error('no bars');
  process.stderr.write(`[goal-fixture] ${bars.length} bars, ${bars[0].t} to ${bars[bars.length - 1].t}\n`);
  const clock = runnerClock({ from, to });
  const days = GF.sessionDays(bars, { from, to, session, inSession: clock.inSession });
  const legs = GF.trendLegsByDay(bars, { from, to, session, minutes: MINUTES });
  const trend = new Set(legs.keys());
  const drawn = GF.pickBlocks(days, { trend, seed: cfg.seed, split: cfg.split, perHalf: draw.blocksPerHalf, length: cfg.blockSessions, trendPerHalf: draw.trendPerHalf });
  const missing = cfg.moveDays.filter(d => !days.includes(d));
  if (missing.length) throw new Error(`move days that are no session in the window: ${missing.join(', ')}`);
  const P = GT.shippedOf(ROOT, {});
  const blocks = [...drawn, ...GF.moveBlocks(days, cfg.moveDays, cfg.blockSessions)].map(b => {
    const mine = GF.blockBars(bars, b.sessions, { historyHours: HISTORY_HOURS, minutes: MINUTES });
    const byDay = new Map();
    for (const t of GT.blockTrades(mine, b.sessions, P, { symbol: o.symbol }).trades) byDay.set(t.day, [...(byDay.get(t.day) || []), t]);
    return { ...b, trend: b.sessions.filter(d => trend.has(d)), labels: GF.labelsFor(b.sessions, legs, byDay), bars: GF.encodeBars(mine, tick, MINUTES) };
  });
  const doc = { v: 1, kind: 'goal-fixture', symbol: o.symbol, minutes: MINUTES, seed: cfg.seed, split: cfg.split, from, to, session, historyHours: HISTORY_HOURS, source, pool: { sessions: days.length, trend: days.filter(d => trend.has(d)).length }, blocks };
  const out = o.out || (real ? GC.REAL_FIXTURE() : GC.CI_FIXTURE);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(doc)), { level: zlib.constants.Z_BEST_COMPRESSION });
  fs.writeFileSync(out, gz);
  const all = blocks.flatMap(b => b.sessions.map(d => b.labels[d].kind));
  process.stdout.write(`${out}: ${blocks.length} blocks, ${all.length} sessions (${all.filter(k => k === 'trend').length} trend, ${all.filter(k => k !== 'trend').length} non-trend), ${blocks.reduce((a, b) => a + b.bars.rows.length, 0)} bars, ${gz.length} bytes\n`);
}

main().catch(err => { process.stderr.write(`${err.message}\n`); process.exit(1); });
