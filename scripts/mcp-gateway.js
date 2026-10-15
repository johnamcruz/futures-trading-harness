#!/usr/bin/env node
/**
 * MCP order gateway: run the broker MCP server behind the harness order gate so every
 * MCP client gets the same enforcement, with or without hook support. This
 * is the authoritative gate: besides the journal and strategy checks, it asks
 * the server for live positions, working orders, and (entries only) today's
 * fills, so [exit]/[protect] labels and loss counts can't be faked.
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
const { checkOrder, logDecision, createGatewayClock } = require('./lib/trading/check-order');
const { DEFAULT_LANE_TIMEOUT_MS, handleClientLine, childCaller, lineSplitter, isLaneCall, blockedResponse, canonicalArgs, closeLedgerEntry, closeRefused, resultJson } = require('./lib/trading/mcp-gateway');
const { accountFacts, ledgerName, parseToolJson, netPosition, contractNet, evaluateAccount, evaluateAccountChange, barsRequest, regimeGatedStrategy, regimeViolation } = require('./lib/trading/account-gate');
const { isRiskReducing, marketClosed, formatBlock } = require('./lib/trading/order-gate');
const { contractRoot } = require('./lib/trading/journal');
const { loadStrategies } = require('./lib/trading/strategies');
const { loadConfig } = require('./lib/trading/config');
const { runningAttempts, carriedLossState } = require('./lib/trading/prop-state');
const { activeBroker, translatedCommand } = require('./lib/broker/config');
const { createServerAttestation } = require('./lib/broker/allow-list');
const { recordEntryOrder, graceFor, createOrderTracker } = require('./lib/trading/order-tracker');

const ROOT = path.resolve(__dirname, '..');
const LANE_TIMEOUT_MS = Number(process.env.FTH_LANE_TIMEOUT_MS) > 0 ? Number(process.env.FTH_LANE_TIMEOUT_MS) : DEFAULT_LANE_TIMEOUT_MS;
const { PENDING_ORDER_TTL_MS: LEDGER_TTL_MS } = require('./lib/trading/gate-timing');
const GRACE_MS = graceFor(process.env, LANE_TIMEOUT_MS);

async function accountViolations(args, caller, now, ledger, extraOrders = []) {
  const entry = !isRiskReducing(args.rationale); // an [exit] / [protect] never reads fills, prop attempts or strategies
  const facts = await accountFacts(args, caller, entry);
  const { positions, trades } = facts;
  // Orders of unknown outcome that would rest (limits, stops) count as working orders.
  const orders = Array.isArray(facts.orders) ? [...facts.orders, ...extraOrders] : facts.orders;
  // An order still resting keeps its ledger entry alive: counted when it fills, until the account shows it.
  if (Array.isArray(orders)) {
    const resting = new Set(orders.map(o => String(o.id)));
    for (const e of ledger) if (e.orderId && resting.has(e.orderId)) e.at = now.getTime();
  }
  const config = loadConfig(process.env);
  const running = entry ? runningAttempts(config.home) : [];
  const violations = evaluateAccount({ input: args, positions, orders, trades, now, config, ledger, propAttempt: running.length ? running.join(', ') : null, carried: entry ? carriedLossState(config.home, now) : null });
  const gated = entry ? regimeGatedStrategy(args, loadStrategies(ROOT, process.env).strategies) : null;
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
  // Behind the contract translator (the configured broker): one standard name per contract for the gate (canonicalArgs).
  const canon = command.length === 0 ? canonicalArgs : a => a;
  let broker = null; // the configured broker whose server runs here (null: a server from the command line)
  if (command.length === 0) {
    try {
      // The broker in the broker config (broker/config.js), behind the contract translator: standard contract names only.
      command = translatedCommand(broker = activeBroker(process.env));
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
  const clock = createGatewayClock(process.env, { broker, fromArgv: !broker, call: (n, a) => caller.call(n, a) }); // pinned once (harness-now.js)
  const attest = createServerAttestation({ env: process.env, broker, call: (n, a) => caller.call(n, a) }); // live entries vs get_server_config
  // Market orders let through recently, until the account reflects them (see pendingNet).
  let ledger = [];
  const sentNet = new Map(); // request id -> { args, observedNet } for allowed place_order calls
  // Order calls past LANE_TIMEOUT_MS: the lane is released, and a place_order's
  // marker stays on disk (new entries wait) until the late reply or the broker's orders settle it.
  const overdue = new Set();
  // Orders of unknown outcome: their records on disk, settled from the broker's orders (order-tracker.js).
  const logErr = msg => process.stderr.write(`[mcp-gateway] ${msg}\n`);
  const tracker = createOrderTracker({
    env: process.env, graceMs: GRACE_MS, onError: logErr, canon,
    searchOrders: async a => parseToolJson(await caller.call('search_orders', a), 'search_orders'),
  });

  const blocked = violations => ({ allowed: violations.length === 0, violations, message: violations.length ? formatBlock(violations) : '' });

  // Settle this account's orders of unknown outcome; what it found placed is counted like any order just sent.
  const settle = async (accountId, now) => {
    const r = await tracker.settle(accountId, now, { isWaiting: id => waiting.has(id) });
    ledger.push(...r.ledger);
    for (const id of r.settledIds) { overdue.delete(id); sentNet.delete(id); }
    return r;
  };

  const check = async (sentArgs, tool, id) => {
    const args = canon(sentArgs); // one name per contract for the gate and its ledger
    const base = checkOrder(args, { env: process.env, pluginRoot: ROOT, tool, clock: await clock.ready() });
    const now = base.now;
    ledger = ledger.filter(e => now.getTime() - e.at < LEDGER_TTL_MS);
    if (tool !== 'place_order') {
      // cancel, modify, partial close: against the account, counting recent orders and orders of unknown outcome.
      if (tool === 'modify_order' && base.violations.length) return base;
      const { unknown } = await settle(args.accountId, now);
      const { positions, orders } = await accountFacts(args, caller, false);
      return blocked(evaluateAccountChange(tool, {
        input: args, positions, orders, config: loadConfig(process.env), now,
        ledger: [...ledger, ...tracker.exitLedger(unknown, now)], cancelLedger: [...ledger.filter(e => !e.unconfirmed), ...tracker.cancelLedger(unknown, now)],
      }));
    }
    // An order of unknown outcome blocks new risk until the broker's orders settle it (hard: not
    // skippable); exits and stops still go, checked against the account as it would be if it filled.
    const { unknown, lookupFailed } = await settle(args.accountId, now);
    const entry = !isRiskReducing(args.rationale);
    const extra = entry
      ? await accountViolations(args, caller, now, ledger)
      : await accountViolations(args, caller, now, [...ledger, ...tracker.exitLedger(unknown, now)], tracker.exitOrders(unknown, now));
    const violations = [...base.violations, ...extra.violations];
    if (!entry) tracker.annotateExposure(violations, unknown, now);
    if (entry && unknown.length) violations.push(tracker.pendingViolation(unknown, now, lookupFailed));
    if (entry) violations.push(...await attest.violations(args, (await clock.ready()).replay === true, violations));
    // The account reads take time: an entry checked just before the close
    // must still be inside the session when it is sent.
    const late = isRiskReducing(args.rationale) ? null : marketClosed(clock.now(), loadConfig(process.env));
    if (late && !violations.some(v => v.check === 'market-hours')) violations.push({ check: 'market-hours', message: late });
    if (violations.length === 0 && id !== undefined) sentNet.set(id, { args, observedNet: extra.observedNet, observedRootNet: extra.observedRootNet, sentAt: clock.now().getTime(), composed: base.composed || null });
    return { allowed: violations.length === 0, violations, message: violations.length ? formatBlock(violations) : '' };
  };

  // Responses the order lane is waiting for, by client request id.
  const waiting = new Map();
  const awaitResponse = id => new Promise(resolve => {
    const timer = setTimeout(() => { overdue.add(id); tracker.onOverdue(id); resolve(null); }, LANE_TIMEOUT_MS);
    waiting.set(id, msg => {
      clearTimeout(timer);
      tracker.onReply(id, msg);
      overdue.delete(id);
      try { recordSent(id, msg); } catch (err) { logErr(`could not record reply ${id}: ${err.message}`); } // before the client sees it
      resolve(msg);
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
    if (!sent || ((!response || response.error || (response.result && response.result.isError)) && !sent.closeEntry)) return;
    const { args, observedNet, observedRootNet, closeEntry } = sent;
    if (closeEntry) {
      // Counted since it was sent: only a refusal (success: false) drops it; an error reply is an unknown outcome and stays.
      if (closeRefused(response)) ledger = ledger.filter(e => e !== closeEntry);
      else if ((resultJson(response) || {}).success === true) Object.assign(closeEntry, { at: clock.now().getTime(), unconfirmed: false });
      return;
    }
    const placed = resultJson(response);
    if (!isRiskReducing(args.rationale) && placed && placed.orderId !== undefined && placed.orderId !== null) {
      recordEntryOrder(process.env, placed.orderId, args, sent.sentAt || clock.now().getTime(), logErr, sent.composed);
    }
    if (observedNet === null) return;
    // Every order type: a marketable limit or stop fills at once too. While
    // it rests it shows in list_open_orders and the ledger skips it.
    const sign = String(args.side).toLowerCase() === 'buy' ? 1 : -1;
    const orderId = placed && placed.orderId !== undefined && placed.orderId !== null ? String(placed.orderId) : null;
    ledger.push({ contractId: ledgerName(args), root: contractRoot(args.contractId), sign, size: Number(args.size), netBefore: observedNet, rootNetBefore: observedRootNet, at: clock.now().getTime(), sentAt: sent.sentAt, orderId });
  };
  const log = e => logDecision(e, process.env);

  // Server → client: whole lines only; responses to the gateway's own calls are consumed.
  const fromServer = lineSplitter(line => {
    if (caller.consume(line)) return;
    try { noteResponse(line); } finally { write(line); } // bookkeeping never hides a broker reply
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
      // Every place_order goes out with a customTag and a record on disk first, so an unknown
      // outcome (no reply, or this gateway gone) is found again in the broker's orders.
      const tagged = tracker.tagRequest(parsed, { observed: parsed && parsed.id !== undefined ? sentNet.get(parsed.id) : null, now: clock.now() });
      if (tagged.refuse) {
        const args = parsed.params.arguments || {};
        if (parsed.id !== undefined) write(JSON.stringify(blockedResponse(parsed.id, formatBlock([tagged.refuse]))));
        log({ source: 'gateway', tool: 'place_order', decision: 'blocked', violations: [tagged.refuse], contractId: args.contractId, side: args.side, size: args.size, type: args.type, rationale: args.rationale });
        sentNet.delete(parsed.id);
        inFlight.delete(parsed.id);
        return;
      }
      const line2 = tagged.msg === parsed ? forward : JSON.stringify(tagged.msg);
      parsed = tagged.msg;
      const lane = [].concat(parsed || []).filter(m => isLaneCall(m) && m.id !== undefined);
      // Closes aren't gated, but they change the position: note the position
      // before them so the ledger can count them until the account shows it.
      for (const m of lane) {
        const close = /(?:^|__)(close_position|partial_close_position)$/.exec(String(m.params.name || ''));
        const args = canon(m.params.arguments || {});
        if (!close || !args.contractId) continue;
        try {
          const positions = parseToolJson(await caller.call('list_open_positions', { accountId: args.accountId }), 'list_open_positions');
          const closeEntry = closeLedgerEntry(close[1], args, positions, (await clock.ready()).now());
          if (closeEntry) { ledger.push(closeEntry); sentNet.set(m.id, { closeEntry }); }
        } catch (err) {
          process.stderr.write(`[mcp-gateway] could not read the position before ${close[1]}: ${err.message}\n`);
        }
      }
      const replies = lane.map(m => awaitResponse(m.id));
      toChild(line2);
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
