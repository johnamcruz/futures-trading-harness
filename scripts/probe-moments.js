#!/usr/bin/env node
'use strict';

/**
 * The read probe's moments file from recorded run homes (scripts/lib/eval/read-probe.js momentsFromCycles): every flat
 * cycle in the entry window (a recorded planned or no-trade, `windowEntries: allowed`) of each home's
 * logs/cycles/DAY/*-trade.json, classified by its own State (scripts/lib/trading/frame-state.js, read back from the
 * recorded briefing): `change` when its 1h or 15m label disagrees with its own last break or strong last candle, `hold`
 * when the frames agree (none disagrees or is unknown, at least one agrees), holds from the change cycles' days only.
 * Reads only; the moments file stays outside the repo. Needs scripts/lib/trading/frame-state.js and config/analysis.json
 * briefing.stateRangeAtr (the feat/state-line branch: merge it first; until then it refuses, naming what is missing).
 *
 *   node scripts/probe-moments.js --home <run home> [--home <run home> ...] [--days 2021-05-11,2021-05-19] [--all-days] --out <moments.json>
 *
 * --all-days keeps holds from days without a change cycle. Then run the probe on it (scripts/moment-probe.js --patch state-line).
 */

const fs = require('fs');
const R = require('./lib/eval/read-probe');
const B = require('./lib/eval/briefing-patch');

const many = name => process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]] : []));
const arg = name => many(name)[0] || null;

try {
  const homes = many('--home');
  const out = arg('--out');
  if (!homes.length || !out) {
    process.stderr.write('usage: probe-moments.js --home <run home> [--home ...] [--days d1,d2] [--all-days] --out <moments.json>\n');
    process.exitCode = 1;
  } else {
    const frameState = B.loadFrameState();
    const days = arg('--days') ? arg('--days').split(',').map(d => d.trim()).filter(Boolean) : null;
    const moments = R.momentsFromCycles(R.collectCycles(homes, days), { statesOf: c => B.frameStatesFor(c.log, frameState), sameDays: !process.argv.includes('--all-days') });
    fs.writeFileSync(out, `${JSON.stringify(moments, null, 1)}\n`);
    const n = set => moments.filter(m => m.set === set).length;
    process.stdout.write(`${moments.length} moments: change ${n('change')}, hold ${n('hold')} -> ${out}\n`);
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
}
