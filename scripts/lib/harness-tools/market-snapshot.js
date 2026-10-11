'use strict';

/**
 * The indicator and level snapshot operation (scripts/market-snapshot.js):
 *
 *   snapshot { file, params }   file: bars file or '-' (get_bars JSON on stdin);
 *                               params: { name: number } overrides of trading/market-snapshot.js PARAMS
 *
 * Output: the snapshot as JSON. Use closed bars only, oldest first.
 */

const { readBarsArg } = require('../backtest/data');
const { PARAMS, snapshot: buildSnapshot } = require('../trading/market-snapshot');

const USAGE = 'usage: market-snapshot.js <bars.json | -> [--param=value ...]';

/** A parameter override as a number; throws on an unknown name or a non-number. */
function paramValue(name, raw) {
  if (!(name in PARAMS)) throw new Error(`unknown parameter --${name} (known: ${Object.keys(PARAMS).join(', ')})`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

function snapshot({ file, params = {} } = {}) {
  if (file === undefined || file === null) throw new Error(USAGE);
  const overrides = {};
  for (const [name, raw] of Object.entries(params || {})) overrides[name] = paramValue(name, raw);
  return { text: `${JSON.stringify(buildSnapshot(readBarsArg(file), overrides), null, 2)}\n` };
}

/** argv to { file, params }: --name=value or --name value, and one bars file. */
function parseArgv(argv) {
  const params = {};
  let file = null;
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const bare = /^--[A-Za-z0-9]+$/.test(argv[i]);
    if (bare && argv[i + 1] !== undefined) { args.push(`${argv[i]}=${argv[i + 1]}`); i += 1; } else args.push(argv[i]);
  }
  for (const arg of args) {
    const m = /^--([A-Za-z0-9]+)=(.+)$/.exec(arg);
    if (m) params[m[1]] = paramValue(m[1], m[2]);
    else if (file === null) file = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (file === null) throw new Error(USAGE);
  return { file, params };
}

const OPS = { snapshot };

module.exports = { OPS, USAGE, snapshot, paramValue, parseArgv };
