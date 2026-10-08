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
const { handleClientLine, childCaller, lineSplitter, isLaneCall } = require('./lib/trading/mcp-gateway');
const { parseToolJson, netPosition, evaluateAccount, evaluateCancel, evaluateModifyAccount, barsRequest, regimeGatedStrategy, regimeViolation } = require('./lib/trading/account-gate');
const { isRiskReducing } = require('./lib/trading/order-gate');
const { writeJsonAtomic, readJson } = require('./lib/harness-run');
const { contractRoot } = require('./lib/trading/journal');
const { loadStrategies } = require('./lib/trading/strategies');
const { loadConfig } = require('./lib/trading/config');
const { formatBlock } = require('./lib/trading/order-gate');
const { harnessHome } = require('./lib/paths');

const ROOT = path.resolve(__dirname, '..');
const LANE_TIMEOUT_MS = Number(process.env.FTH_LANE_TIMEOUT_MS) > 0 ? Number(process.env.FTH_LANE_TIMEOUT_MS) : 30000;
const LEDGER_TTL_MS = 30000;
const ENTRY_ORDERS_KEPT = 200;

/**
 * Remember entry order ids (setup:<name>) the gateway let through, so the
 * runner's flat-account cleanup can tell a pending entry from a leftover
 * stop or target (see runner.js). Best effort.
 */
function recordEntryOrder(env, orderId, contractId) {
  try {
    const file = path.join(harnessHome(env), 'entry-orders.json');
    const list = readJson(file, []);
    const next = [...(Array.isArray(list) ? list : []), { orderId, contractId, at: new Date().toISOString() }].slice(-ENTRY_ORDERS_KEPT);
    writeJsonAtomic(file, next);
  } catch (err) {
    process.stderr.write(`[mcp-gateway] could not record entry order ${orderId}: ${err.message}\n`);
  }
}

function resultJson(response) {
  try {
    return JSON.parse(response.result.content[0].text);
  } catch (_err) {
    return null;
  }
}

async function accountFacts(args, caller, withTrades = true) {
  const accountId = args.accountId;
  const [positions, orders, trades] = await Promise.all([
    caller.call('list_open_positions', { accountId }).then(r => parseToolJson(r, 'list_open_positions')),
    caller.call('list_open_orders', { accountId }).then(r => parseToolJson(r, 'list_open_orders')),
    withTrades ? caller.call('search_trades', { accountId }).then(r => parseToolJson(r, 'search_trades')) : Promise.resolve([]),
  ]);
  return { positions, orders, trades };
}

async function accountViolations(args, caller, now, ledger) {
  const { positions, orders, trades } = await accountFacts(args, caller);
  const config = loadConfig(process.env);
  const violations = evaluateAccount({ input: args, positions, orders, trades, now, config, ledger });
  const gated = regimeGatedStrategy(args, loadStrategies(ROOT, process.env).strategies);
  if (gated) {
    const req = barsRequest(args.contractId, gated.timeframe);
    if (!req) throw new Error(`cannot fetch bars for timeframe ${gated.timeframe}`);
    const result = parseToolJson(await caller.call('get_bars', req), 'get_bars');
    violations.push(...regimeViolation(gated, result.bars || result, config));
  }
  return { violations, observedNet: Array.isArray(positions) ? netPosition(positions, args.contractId) : null };
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
  // Market orders let through recently, until the account reflects them (see pendingNet).
  let ledger = [];
  const sentNet = new Map(); // request id -> { args, observedNet } for allowed place_order calls

  // Order calls whose reply never came within LANE_TIMEOUT_MS: their effect is unknown.
  const unanswered = new Set();
  const blocked = violations => ({ allowed: violations.length === 0, violations, message: violations.length ? formatBlock(violations) : '' });

  const check = async (args, tool, id) => {
    const now = new Date();
    if (unanswered.size) {
      return blocked([{ check: 'order-pending', message: `An earlier order call (request ${[...unanswered].join(', ')}) has had no reply for over ${LANE_TIMEOUT_MS / 1000} s, so the account state is unknown. Wait for it, then check positions and orders.` }]);
    }
    const base = checkOrder(args, { env: process.env, pluginRoot: ROOT, now, tool });
    if (tool === 'cancel_order') {
      const { positions, orders } = await accountFacts(args, caller, false);
      return blocked(evaluateCancel({ input: args, positions, orders, config: loadConfig(process.env) }));
    }
    if (tool === 'modify_order') {
      if (base.violations.length) return base;
      const { positions, orders } = await accountFacts(args, caller, false);
      return blocked(evaluateModifyAccount({ input: args, positions, orders, config: loadConfig(process.env) }));
    }
    if (tool !== 'place_order') return base;
    ledger = ledger.filter(e => now.getTime() - e.at < LEDGER_TTL_MS);
    const extra = await accountViolations(args, caller, now, ledger);
    const violations = [...base.violations, ...extra.violations];
    if (violations.length === 0 && id !== undefined) sentNet.set(id, { args, observedNet: extra.observedNet });
    return { allowed: violations.length === 0, violations, message: violations.length ? formatBlock(violations) : '' };
  };

  // Responses the order lane is waiting for, by client request id.
  const waiting = new Map();
  // After the timeout the lane is released but order calls stay refused
  // (order-pending) until the late reply arrives and is recorded.
  const awaitResponse = id => new Promise(resolve => {
    const timer = setTimeout(() => { unanswered.add(id); resolve(null); }, LANE_TIMEOUT_MS);
    waiting.set(id, msg => {
      clearTimeout(timer);
      if (unanswered.delete(id)) recordSent(id, msg);
      else resolve(msg);
    });
  });
  // Client request ids forwarded to the server and not yet answered.
  const inFlight = new Set();
  const noteResponse = line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_err) {
      return;
    }
    if (!msg || msg.method !== undefined || msg.id === undefined) return;
    inFlight.delete(msg.id);
    const done = waiting.get(msg.id);
    if (done) {
      waiting.delete(msg.id);
      done(msg);
    }
  };
  const recordSent = (id, response) => {
    const sent = sentNet.get(id);
    sentNet.delete(id);
    if (!sent || !response || response.error || (response.result && response.result.isError)) return;
    const { args, observedNet } = sent;
    const placed = resultJson(response);
    if (!isRiskReducing(args.rationale) && placed && placed.orderId !== undefined && placed.orderId !== null) {
      recordEntryOrder(process.env, placed.orderId, args.contractId);
    }
    if (String(args.type).toLowerCase() !== 'market' || observedNet === null) return; // resting orders show up in list_open_orders
    const sign = String(args.side).toLowerCase() === 'buy' ? 1 : -1;
    ledger.push({ contractId: args.contractId, root: contractRoot(args.contractId), sign, size: Number(args.size), netBefore: observedNet, at: Date.now() });
  };
  const log = e => logDecision(e, process.env);

  // Server → client: whole lines only; responses to the gateway's own calls are consumed.
  const fromServer = lineSplitter(line => {
    if (caller.consume(line)) return;
    write(line);
    noteResponse(line);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => fromServer.push(chunk));

  // Client → server: one message at a time, in order (an order check may wait on the server).
  let queue = Promise.resolve();
  const fromClient = lineSplitter(line => {
    queue = queue.then(async () => {
      let incoming;
      try {
        incoming = JSON.parse(line);
      } catch (_err) {
        incoming = null;
      }
      // An order call reusing the id of a request still in flight would let
      // the other request's reply release the order lane early.
      const dup = [].concat(incoming || []).find(m => m && isLaneCall(m) && m.id !== undefined && inFlight.has(m.id));
      if (dup) {
        write(JSON.stringify({ jsonrpc: '2.0', id: dup.id, error: { code: -32600, message: `Blocked by trading harness: request id ${JSON.stringify(dup.id)} is already in use by a request in flight. Use a new id.` } }));
        return;
      }
      const { forward, respond } = await handleClientLine(line, check, log);
      for (const r of respond) write(JSON.stringify(r));
      if (forward === null) return;
      let parsed;
      try {
        parsed = JSON.parse(forward);
      } catch (_err) {
        parsed = null;
      }
      for (const m of [].concat(parsed || [])) if (m && m.method !== undefined && m.id !== undefined) inFlight.add(m.id);
      const lane = [].concat(parsed || []).filter(m => isLaneCall(m) && m.id !== undefined);
      const replies = lane.map(m => awaitResponse(m.id).then(r => { if (r) recordSent(m.id, r); }));
      toChild(forward);
      // Hold the lane until the server has answered every order-changing call.
      await Promise.all(replies);
    }).catch(err => process.stderr.write(`[mcp-gateway] ${err.message}\n`));
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
