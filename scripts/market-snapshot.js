#!/usr/bin/env node
/**
 * Indicator and level snapshot for the analyst agents.
 *
 *   node scripts/market-snapshot.js bars.json [--orbMinutes=30 --adxGate=20 ...]
 *   cat bars.json | node scripts/market-snapshot.js -
 *
 * Input: the JSON returned by projectx-mcp get_bars ({ bars: [{t,o,h,l,c,v}] })
 * or a bare array of bars. Output: JSON (see scripts/lib/trading/market-snapshot.js).
 * Use closed bars only (includePartialBar=false), oldest first.
 */

'use strict';

require('./lib/sim-clock').installSimClock(process.env);

const fs = require('fs');
const { PARAMS, snapshot } = require('./lib/trading/market-snapshot');

function parseArgs(argv) {
  const overrides = {};
  let file = null;
  for (const arg of argv) {
    const m = /^--([A-Za-z0-9]+)=(.+)$/.exec(arg);
    if (m) {
      if (!(m[1] in PARAMS)) throw new Error(`unknown parameter --${m[1]} (known: ${Object.keys(PARAMS).join(', ')})`);
      const n = Number(m[2]);
      if (!Number.isFinite(n)) throw new Error(`--${m[1]} must be a number`);
      overrides[m[1]] = n;
    } else if (file === null) {
      file = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (file === null) throw new Error('usage: market-snapshot.js <bars.json | -> [--param=value ...]');
  return { file, overrides };
}

function main() {
  try {
    const { file, overrides } = parseArgs(process.argv.slice(2));
    const text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
    process.stdout.write(`${JSON.stringify(snapshot(JSON.parse(text), overrides), null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`[market-snapshot] ${err.message}\n`);
    process.exit(1);
  }
}

main();
