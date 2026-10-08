#!/usr/bin/env node
/**
 * The prop-challenge env for the Python trainer (rl/fth_rl), over stdin and
 * stdout, one JSON line per request (scripts/lib/rl/env-server.js).
 *
 *   node scripts/rl-env-server.js --config rl/configs/<name>.json
 *
 * Logs go to stderr; stdout carries only protocol lines.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { envFromConfig } = require('./lib/rl/env-config');
const { serve } = require('./lib/rl/env-server');

const ROOT = path.resolve(__dirname, '..');

/** Blocking line reader on fd 0 (the env answers decisions synchronously). */
function lineReader(fd = 0) {
  const buf = Buffer.alloc(1 << 16);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let carry = '';
  let eof = false;
  return () => {
    for (;;) {
      const nl = carry.indexOf('\n');
      if (nl !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        return line;
      }
      if (eof) {
        if (!carry) return null;
        const line = carry;
        carry = '';
        return line;
      }
      let n;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (err) {
        if (err.code === 'EAGAIN') { Atomics.wait(wait, 0, 0, 5); continue; }
        if (err.code === 'EOF') n = 0;
        else throw err;
      }
      if (n === 0) eof = true;
      else carry += buf.toString('utf8', 0, n);
    }
  };
}

function main(argv) {
  const i = argv.indexOf('--config');
  if (i === -1 || !argv[i + 1]) throw new Error('usage: rl-env-server.js --config <training config>');
  const file = path.resolve(argv[i + 1]);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const log = msg => process.stderr.write(`[rl-env] ${msg}\n`);
  const { env, meta } = envFromConfig(cfg, { root: ROOT, baseDir: path.dirname(file), log, hashData: !argv.includes('--no-hash') });
  log(`${meta.strategies.join(', ')} on ${meta.symbol} ${meta.timeframe}m, account ${meta.account}, ${env.days.length} trading days`);
  serve({ env, meta, readLine: lineReader(0), writeLine: s => fs.writeSync(1, `${s}\n`) });
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[rl-env] ${err.message}\n`);
  process.exitCode = 1;
}
