#!/usr/bin/env node
/**
 * MCP order gateway: run the broker MCP server behind the harness order gate so every
 * MCP client gets the same enforcement, with or without hook support. This
 * is the authoritative gate: besides the journal and strategy checks, it asks
 * the server for live positions, working orders, and today's fills, so
 * [exit]/[protect] labels and loss counts can't be faked.
 *
 *   node scripts/mcp-gateway.js                  the broker in the broker config
 *   node scripts/mcp-gateway.js -- <server command> [args...]
 *
 * Register THIS command as the MCP server named "broker" in your harness.
 * Credentials stay in the environment; the gateway passes it to the child
 * unchanged and never reads or logs them. Decisions are appended to
 * ~/.futures-trading-harness/logs/gate-log.jsonl (FTH_GATE_LOG). stdout carries only
 * protocol messages.
 */

'use strict';

// Credentials and settings from a .env file (<FTH_HOME>/.env, or the repo's
// git-ignored .env); a variable already set in the environment wins. Logs key
// names only, to stderr.
require('./lib/env-file').loadEnvForCli('mcp-gateway');

const path = require('path');
const { spawn } = require('child_process');
const { checkOrder, logDecision } = require('./lib/trading/check-order');
const { handleClientLine, childCaller, lineSplitter, isLaneCall } = require('./lib/trading/mcp-gateway');
const { parseToolJson, netPosition, contractNet, evaluateAccount, evaluateCancel, evaluateModifyAccount, barsRequest, regimeGatedStrategy, regimeViolation } = require('./lib/trading/account-gate');
const { isRiskReducing, marketClosed } = require('./lib/trading/order-gate');
const { writeJsonAtomic, readJson } = require('./lib/harness-run');
const { contractRoot } = require('./lib/trading/journal');
const { loadStrategies } = require('./lib/trading/strategies');
const { loadConfig, gateNow } = require('./lib/trading/config');
const { formatBlock } = require('./lib/trading/order-gate');
const { harnessHome } = require('./lib/paths');
const { runningAttempts } = require('./lib/trading/prop-state');
const { activeBroker, serverCommand } = require('./lib/broker/config');

const ROOT = path.resolve(__dirname, '..');
const LANE_TIMEOUT_MS = Number(process.env.FTH_LANE_TIMEOUT_MS) > 0 ? Number(process.env.FTH_LANE_TIMEOUT_MS) : 30000;
const LEDGER_TTL_MS = 30000;
const ENTRY_ORDERS_KEPT = 200;

const STOP_PRICE = /\bstop(?:\s+at)?\s*[:=@]?\s*(\d+(?:\.\d+)?)\b/i;

/**
 * Remember the entries (setup:<name>) the gateway let through: the runner's
 * flat-account cleanup tells a pending entry from a leftover stop or target
 * by id, and its trailing-stop manager needs the strategy and the planned
 * stop (bracket ticks or the "stop <price>" in the rationale). Best effort.
 */
function recordEntryOrder(env, orderId, args) {
  try {
    const file = path.join(harnessHome(env), 'entry-orders.json');
    const list = readJson(file, []);
    const setup = /^\s*setup:([a-z0-9][a-z0-9_-]*)/i.exec(String(args.rationale || ''));
    // The planned stop is the last "stop <price>" ("buy stop 21510 above the high, stop 21490" plans 21490).
    const stops = [...String(args.rationale || '').matchAll(new RegExp(STOP_PRICE.source, 'gi'))];
    const stop = stops.length ? stops[stops.length - 1] : null;
    const entry = {
      orderId, contractId: args.contractId, side: String(args.side || '').toLowerCase(), setup: setup ? setup[1].toLowerCase() : null,
      stopTicks: args.stopLossBracket && Number(args.stopLossBracket.ticks) > 0 ? Number(args.stopLossBracket.ticks) : null,
      stopPrice: stop ? Number(stop[1]) : null, at: gateNow().toISOString(),
    };
    const next = [...(Array.isArray(list) ? list : []), entry].slice(-ENTRY_ORDERS_KEPT);
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
  // An order still resting keeps its ledger entry alive: when it fills later,
  // the fill is counted until the account shows it.
  if (Array.isArray(orders)) {
    const resting = new Set(orders.map(o => String(o.id)));
    for (const e of ledger) if (e.orderId && resting.has(e.orderId)) e.at = now.getTime();
  }
  const config = loadConfig(process.env);
  const running = runningAttempts(config.home);
  const violations = evaluateAccount({ input: args, positions, orders, trades, now, config, ledger, propAttempt: running.length ? running.join(', ') : null });
  const gated = regimeGatedStrategy(args, loadStrategies(ROOT, process.env).strategies);
  if (gated) {
    const req = barsRequest(args.contractId, gated.timeframe);
    if (!req) throw new Error(`cannot fetch bars for timeframe ${gated.timeframe}`);
    const result = parseToolJson(await caller.call('get_bars', req), 'get_bars');
    violations.push(...regimeViolation(gated, result.bars || result, config));
  }
  return {
    violations,
    observedNet: Array.isArray(positions) ? contractNet(positions, args.contractId) : null,
    observedRootNet: Array.isArray(positions) ? netPosition(positions, args.contractId) : null,
  };
}

function main(argv) {
  const sep = argv.indexOf('--');
  let command = sep === -1 ? argv : argv.slice(sep + 1);
  // No command: the broker MCP server named in the broker config (broker/config.js).
  if (command.length === 0) {
    try {
      command = serverCommand(activeBroker(process.env));
    } catch (err) {
      process.stderr.write(`[mcp-gateway] ${err.message}\n`);
      process.exit(2);
    }
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
    const now = gateNow();
    if (unanswered.size) {
      return blocked([{ check: 'order-pending', message: `An earlier order call (request ${[...unanswered].join(', ')}) has had no reply for over ${LANE_TIMEOUT_MS / 1000} s, so the account state is unknown. Wait for it, then check positions and orders.` }]);
    }
    const base = checkOrder(args, { env: process.env, pluginRoot: ROOT, now, tool });
    if (tool === 'cancel_order') {
      const { positions, orders } = await accountFacts(args, caller, false);
      ledger = ledger.filter(e => now.getTime() - e.at < LEDGER_TTL_MS);
      return blocked(evaluateCancel({ input: args, positions, orders, config: loadConfig(process.env), ledger, now }));
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
    // The account reads take time: an entry checked just before the close
    // must still be inside the session when it is sent.
    const late = isRiskReducing(args.rationale) ? null : marketClosed(gateNow(), loadConfig(process.env));
    if (late && !violations.some(v => v.check === 'market-hours')) violations.push({ check: 'market-hours', message: late });
    if (violations.length === 0 && id !== undefined) sentNet.set(id, { args, observedNet: extra.observedNet, observedRootNet: extra.observedRootNet });
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
    const { args, observedNet, observedRootNet, closeTool } = sent;
    if (closeTool) {
      // A close is a market order the account may not show yet, like one sent through place_order. Only one
      // the server confirmed (success: true; a refused close comes back as success: false) counts.
      const res = resultJson(response);
      if (!observedNet || !res || res.success !== true) return;
      const size = closeTool === 'partial_close_position' ? Math.min(Number(args.size) || 0, Math.abs(observedNet)) : Math.abs(observedNet);
      if (size > 0) ledger.push({ contractId: args.contractId, root: contractRoot(args.contractId), sign: -Math.sign(observedNet), size, netBefore: observedNet, rootNetBefore: observedRootNet, at: gateNow().getTime() });
      return;
    }
    const placed = resultJson(response);
    if (!isRiskReducing(args.rationale) && placed && placed.orderId !== undefined && placed.orderId !== null) {
      recordEntryOrder(process.env, placed.orderId, args);
    }
    if (observedNet === null) return;
    // Every order type: a marketable limit or stop fills at once too. While
    // it rests it shows in list_open_orders and the ledger skips it.
    const sign = String(args.side).toLowerCase() === 'buy' ? 1 : -1;
    const orderId = placed && placed.orderId !== undefined && placed.orderId !== null ? String(placed.orderId) : null;
    ledger.push({ contractId: args.contractId, root: contractRoot(args.contractId), sign, size: Number(args.size), netBefore: observedNet, rootNetBefore: observedRootNet, at: gateNow().getTime(), orderId });
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
      // A request reusing the id of one still in flight (or of an order call
      // whose reply is overdue) would let one reply answer the other: an
      // order lane released early, or an order-pending lock cleared by the
      // wrong reply.
      const dup = [].concat(incoming || []).find(m => m && m.method !== undefined && m.id !== undefined && (inFlight.has(m.id) || waiting.has(m.id)));
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
      // Closes aren't gated, but they change the position: note the position
      // before them so the ledger can count them until the account shows it.
      for (const m of lane) {
        const close = /(?:^|__)(close_position|partial_close_position)$/.exec(String(m.params.name || ''));
        const args = m.params.arguments || {};
        if (!close || !args.contractId) continue;
        try {
          const positions = parseToolJson(await caller.call('list_open_positions', { accountId: args.accountId }), 'list_open_positions');
          if (Array.isArray(positions)) sentNet.set(m.id, { args, closeTool: close[1], observedNet: contractNet(positions, args.contractId), observedRootNet: netPosition(positions, args.contractId) });
        } catch (err) {
          process.stderr.write(`[mcp-gateway] could not read the position before ${close[1]}: ${err.message}\n`);
        }
      }
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
