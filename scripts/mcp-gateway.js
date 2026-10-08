#!/usr/bin/env node
/**
 * MCP order gateway: run projectx-mcp behind the harness order gate so every
 * MCP client gets the same enforcement, with or without hook support. This
 * is the authoritative gate: besides the journal and strategy checks, it asks
 * the server for live positions, working orders, and today's fills, so
 * [exit]/[protect] labels and loss counts can't be faked.
 *
 *   node scripts/mcp-gateway.js -- node /abs/path/projectx-mcp/dist/index.js
 *   PROJECTX_MCP_ENTRY=/abs/path/projectx-mcp/dist/index.js node scripts/mcp-gateway.js
 *
 * Register THIS command as the MCP server named "projectx" in your harness.
 * Credentials stay in the environment; the gateway passes it to the child
 * unchanged and never reads or logs them. Decisions are appended to
 * ~/.futures-trading-harness/gate-log.jsonl (FTH_GATE_LOG). stdout carries only
 * protocol messages.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { checkOrder, logDecision } = require('./lib/trading/check-order');
const { handleClientLine, childCaller, lineSplitter } = require('./lib/trading/mcp-gateway');
const { parseToolJson, evaluateAccount, barsRequest, regimeGatedStrategy, regimeViolation } = require('./lib/trading/account-gate');
const { loadStrategies } = require('./lib/trading/strategies');
const { loadConfig } = require('./lib/trading/config');
const { formatBlock } = require('./lib/trading/order-gate');

const ROOT = path.resolve(__dirname, '..');

async function accountViolations(args, caller, now) {
  const accountId = args.accountId;
  const [positions, orders, trades] = await Promise.all([
    caller.call('list_open_positions', { accountId }).then(r => parseToolJson(r, 'list_open_positions')),
    caller.call('list_open_orders', { accountId }).then(r => parseToolJson(r, 'list_open_orders')),
    caller.call('search_trades', { accountId }).then(r => parseToolJson(r, 'search_trades')),
  ]);
  const config = loadConfig(process.env);
  const violations = evaluateAccount({ input: args, positions, orders, trades, now, config });
  const gated = regimeGatedStrategy(args, loadStrategies(ROOT, process.env).strategies);
  if (gated) {
    const req = barsRequest(args.contractId, gated.timeframe);
    if (!req) throw new Error(`cannot fetch bars for timeframe ${gated.timeframe}`);
    const result = parseToolJson(await caller.call('get_bars', req), 'get_bars');
    violations.push(...regimeViolation(gated, result.bars || result, config));
  }
  return violations;
}

function main(argv) {
  const sep = argv.indexOf('--');
  let command = sep === -1 ? argv : argv.slice(sep + 1);
  // Manifests that can't embed a local path (Qwen extension, Codex plugin) set
  // PROJECTX_MCP_ENTRY to projectx-mcp's dist/index.js instead.
  const entry = String(process.env.PROJECTX_MCP_ENTRY || '').trim();
  if (command.length === 0 && entry) command = [process.execPath, entry];
  if (command.length === 0) {
    process.stderr.write('[mcp-gateway] usage: mcp-gateway.js -- <projectx-mcp command> [args...] (or set PROJECTX_MCP_ENTRY)\n');
    process.exit(2);
  }

  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  // EPIPE after the server exits must not crash the gateway; 'close' handles the exit.
  child.stdin.on('error', err => process.stderr.write(`[mcp-gateway] server stdin: ${err.message}\n`));
  const write = line => process.stdout.write(`${line}\n`);
  const toChild = line => { if (child.stdin.writable) child.stdin.write(`${line}\n`); };
  const caller = childCaller(toChild);

  const check = async (args, tool) => {
    const now = new Date();
    const base = checkOrder(args, { env: process.env, pluginRoot: ROOT, now, tool });
    if (tool !== 'place_order') return base;
    const extra = await accountViolations(args, caller, now);
    const violations = [...base.violations, ...extra];
    return { allowed: violations.length === 0, violations, message: violations.length ? formatBlock(violations) : '' };
  };
  const log = e => logDecision(e, process.env);

  // Server → client: whole lines only; responses to the gateway's own calls are consumed.
  const fromServer = lineSplitter(line => {
    if (!caller.consume(line)) write(line);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => fromServer.push(chunk));

  // Client → server: one message at a time, in order (an order check may wait on the server).
  let queue = Promise.resolve();
  const fromClient = lineSplitter(line => {
    queue = queue.then(async () => {
      const { forward, respond } = await handleClientLine(line, check, log);
      for (const r of respond) write(JSON.stringify(r));
      if (forward !== null) toChild(forward);
    });
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => fromClient.push(chunk));
  process.stdin.on('end', () => {
    fromClient.flush();
    queue = queue.then(() => child.stdin.end());
  });

  child.on('error', err => {
    process.stderr.write(`[mcp-gateway] could not start the MCP server: ${err.message}\n`);
    process.exit(1);
  });
  // 'close' fires after the child's stdio has drained; exit once our stdout is flushed.
  child.on('close', (code, signal) => {
    fromServer.flush();
    caller.rejectAll('server exited');
    const exitCode = code === null ? (signal ? 1 : 0) : code;
    process.stdout.write('', () => process.exit(exitCode));
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

main(process.argv.slice(2));
