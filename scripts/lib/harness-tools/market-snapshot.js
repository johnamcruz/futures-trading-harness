'use strict';

/**
 * The indicator and level snapshot operation (scripts/market-snapshot.js):
 *
 *   snapshot { file, params, symbol }   file: bars file or '-' (get_bars JSON on stdin);
 *                               params: { name: number } overrides of trading/market-snapshot.js PARAMS;
 *                               symbol: the contract root, so the volume profile's levels are on its tick (default:
 *                               the root a harness bars file is named for, MNQ-3m.json: bars-fetch.js symbolOfBarsFile)
 *
 * Output: the snapshot as JSON (compact: on one line, as the harness tool
 * returns it). Use closed bars only, oldest first. Under a replay clock, bars
 * that close after it are refused (cli.js atClock).
 */

const { readBarsArg } = require('../backtest/data');
const { PARAMS, snapshot: buildSnapshot } = require('../trading/market-snapshot');
const { context, atClock } = require('./cli');
const { tickOf } = require('../trading/contracts');
const { symbolOfBarsFile } = require('../bars-fetch');

const USAGE = 'usage: market-snapshot.js <bars.json | -> [--symbol=MNQ] [--param=value ...]';

/** A parameter override as a number; throws on an unknown name or a non-number. */
function paramValue(name, raw) {
  if (!(name in PARAMS)) throw new Error(`unknown parameter --${name} (known: ${Object.keys(PARAMS).join(', ')})`); // cli-only: the tool's schema refuses this first
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`); // cli-only: the tool's schema refuses this first
  return n;
}

function snapshot({ file, params = {}, symbol = null, compact = false } = {}, ctx) {
  const c = context(ctx);
  if (file === undefined || file === null) throw new Error(USAGE);
  const overrides = {};
  for (const [name, raw] of Object.entries(params || {})) overrides[name] = paramValue(name, raw);
  const bars = atClock(c, readBarsArg(file), file); // no bar after a replay clock (no look-ahead)
  // The contract's tick: the symbol given, else the one the harness's bars file is named for (none: two decimals).
  const root = symbol || symbolOfBarsFile(file);
  const snap = buildSnapshot({ bars, tickSize: root ? tickOf(root) : null }, overrides);
  return { text: compact ? `${JSON.stringify(snap)}\n` : `${JSON.stringify(snap, null, 2)}\n` };
}

/** argv to { file, params, symbol }: --name=value or --name value, and one bars file. */
function parseArgv(argv) {
  const params = {};
  let file = null;
  let symbol = null;
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const bare = /^--[A-Za-z0-9]+$/.test(argv[i]);
    if (bare && argv[i + 1] !== undefined) { args.push(`${argv[i]}=${argv[i + 1]}`); i += 1; } else args.push(argv[i]);
  }
  for (const arg of args) {
    const m = /^--([A-Za-z0-9]+)=(.+)$/.exec(arg);
    if (m && m[1] === 'symbol') symbol = m[2].toUpperCase();
    else if (m) params[m[1]] = paramValue(m[1], m[2]);
    else if (file === null) file = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (file === null) throw new Error(USAGE);
  return { file, params, ...(symbol ? { symbol } : {}) };
}

const OPS = { snapshot };

module.exports = { OPS, USAGE, snapshot, paramValue, parseArgv };
