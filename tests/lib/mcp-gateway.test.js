'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { handleClientLine, isOrderCall, isLaneCall, orderTool, childCaller, lineSplitter, canonicalArgs, closeLedgerEntry, closeRefused } = require('../../scripts/lib/trading/mcp-gateway');
const { tmpDir } = require('../helpers');

const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const allow = () => ({ allowed: true, violations: [] });
const deny = () => ({ allowed: false, message: 'Blocked by trading harness: no plan', violations: [{ check: 'plan-required' }] });

test('only place_order tool calls are order calls', () => {
  assert.strictEqual(isOrderCall(call(1, 'place_order')), true);
  assert.strictEqual(isOrderCall(call(1, 'mcp__broker__place_order')), true);
  assert.strictEqual(isOrderCall(call(1, 'get_bars')), false);
  assert.strictEqual(isOrderCall(call(1, 'replace_order')), false);
  assert.strictEqual(orderTool(call(1, 'mcp__broker__modify_order')), 'modify_order');
  assert.strictEqual(isOrderCall({ method: 'tools/list' }), false);
});

test('non-order and unparseable lines pass through untouched', async () => {
  const line = JSON.stringify(call(1, 'get_bars'));
  assert.deepStrictEqual(await handleClientLine(line, deny), { forward: line, respond: [] });
  assert.deepStrictEqual(await handleClientLine('not json', deny), { forward: 'not json', respond: [] });
});

test('allowed orders are forwarded, blocked orders answered with isError', async () => {
  const line = JSON.stringify(call(7, 'place_order', { rationale: 'x' }));
  assert.strictEqual((await handleClientLine(line, allow)).forward, line);
  const logs = [];
  const r = await handleClientLine(line, deny, e => logs.push(e));
  assert.strictEqual(r.forward, null);
  assert.deepStrictEqual(r.respond, [{ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'Blocked by trading harness: no plan' }], isError: true } }]);
  assert.strictEqual(logs[0].decision, 'blocked');
});

test('a crashing check blocks the order (fail closed)', async () => {
  const r = await handleClientLine(JSON.stringify(call(3, 'place_order')), () => { throw new Error('journal unreadable'); });
  assert.strictEqual(r.forward, null);
  assert.match(r.respond[0].result.content[0].text, /could not run \(journal unreadable\)/);
});

test('a batch with an order call is refused whole; other batches pass', async () => {
  const allow = async () => ({ allowed: true });
  const batch = [call(1, 'get_bars'), call(2, 'place_order')];
  const r = await handleClientLine(JSON.stringify(batch), allow);
  assert.strictEqual(r.forward, null, 'order calls are checked one at a time, never as a batch');
  assert.deepStrictEqual(r.respond.map(x => x.id), [1, 2]);
  assert.match(r.respond[1].result.content[0].text, /batch/);
  const reads = [call(3, 'get_bars'), call(4, 'list_open_orders')];
  assert.deepStrictEqual(JSON.parse((await handleClientLine(JSON.stringify(reads), allow)).forward), reads);
});

test('a blocked notification is dropped without a response', async () => {
  const note = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'place_order' } };
  assert.deepStrictEqual(await handleClientLine(JSON.stringify(note), deny), { forward: null, respond: [] });
});

test('lineSplitter reassembles chunked lines', () => {
  const lines = [];
  const s = lineSplitter(l => lines.push(l));
  s.push('{"a":1}\n{"b"');
  s.push(':2}\r\n\n{"c":3}');
  s.flush();
  assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('childCaller correlates its own responses and leaves others alone', async () => {
  const sent = [];
  const caller = childCaller(line => sent.push(JSON.parse(line)), { timeoutMs: 50 });
  const p = caller.call('list_open_positions', { accountId: 1 });
  assert.match(sent[0].id, /^fth-gw-[0-9a-f]{12}-1$/, 'ids carry a random nonce');
  assert.strictEqual(sent[0].params.name, 'list_open_positions');
  assert.strictEqual(caller.consume(JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} })), false);
  assert.strictEqual(caller.consume(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { ok: 1 } })), true);
  assert.deepStrictEqual(await p, { ok: 1 });
  await assert.rejects(caller.call('search_trades', {}), /timed out/);
  const q = caller.call('x', {});
  caller.rejectAll('server exited');
  await assert.rejects(q, /server exited/);
});

test('client requests may not use the gateway-reserved id prefix; lane calls are recognized', async () => {
  const r = await handleClientLine(JSON.stringify({ jsonrpc: '2.0', id: 'fth-gw-1', method: 'tools/call', params: { name: 'list_open_positions' } }), () => ({ allowed: true }));
  assert.strictEqual(r.forward, null);
  assert.match(r.respond[0].error.message, /reserved/);
  assert.strictEqual(isLaneCall(call(1, 'close_position')), true);
  assert.strictEqual(isLaneCall(call(1, 'get_bars')), false);
  assert.strictEqual(orderTool(call(1, 'cancel_order')), 'cancel_order');
});

test('canonicalArgs: the gate sees one name per contract, from the configured broker\'s translator cache', () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'fake', brokers: { fake: { command: ['node', 'x.js'] } } }));
  const env = { FTH_HOME: home };
  const args = { accountId: 7, contractId: 'MNQ:2026-12', size: 1 };
  assert.deepStrictEqual(canonicalArgs(args, env), args, 'no cache yet: as given');
  fs.writeFileSync(path.join(home, 'contracts-fake.json'), JSON.stringify({ ids: { 'fake:MNQ:Z26': { root: 'MNQ', month: '2026-12' } }, front: { MNQ: { id: 'fake:MNQ:Z26', month: '2026-12', day: '2026-10-07' } } }));
  assert.deepStrictEqual(canonicalArgs(args, env), { ...args, contractId: 'MNQ' });
  assert.strictEqual(canonicalArgs({ contractId: 'fake:MNQ:Z26' }, env).contractId, 'MNQ');
  assert.strictEqual(args.contractId, 'MNQ:2026-12', 'the call itself is left as sent');
  assert.deepStrictEqual(canonicalArgs({ orderId: 9 }, env), { orderId: 9 });
  assert.deepStrictEqual(canonicalArgs(args, { FTH_HOME: home, FTH_BROKER: 'nope' }), args, 'no broker config: as given');
});

test('canonicalArgs on a replayed day: the call, the positions, the orders and the ledger are named again from one read of the day\'s file after the account reads (a lookup failed, then the reads looked the front month up: the exit of the position\'s own month goes)', async () => {
  const AG = require('../../scripts/lib/trading/account-gate');
  const { loadConfig } = require('../../scripts/lib/trading/config');
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'x.js'], replay: true } } }));
  const env = { FTH_HOME: home, FTH_REPLAY_NOW: '2026-10-05T14:30:00Z' };
  const dayFile = path.join(home, 'contracts-sim.2026-10-05.json');
  // Nothing looked up that day yet (a lookup failed): the exit and a close are named by their month.
  const exit = canonicalArgs({ accountId: 1, contractId: 'MNQ:2026-12', side: 'sell', type: 'market', size: 1, rationale: '[exit] flatten' }, env);
  const close = canonicalArgs({ accountId: 1, contractId: 'MNQ:2026-12' }, env);
  assert.strictEqual(exit.contractId, 'MNQ:2026-12');
  assert.strictEqual(JSON.stringify(exit).includes('rename'), false, 'the mark never reaches a log or the wire');
  // The account reads then succeed: the translator looked the front month (December) up and lists the long as MNQ.
  const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  const caller = { call: async name => {
    fs.writeFileSync(dayFile, JSON.stringify({ ids: { 'sim-Z6': { root: 'MNQ', month: '2026-12' } }, front: { MNQ: { id: 'sim-Z6', month: '2026-12', day: '2026-10-05' } } }));
    return reply(name === 'list_open_positions' ? [{ contractId: 'MNQ', type: 1, size: 1 }] : name === 'list_open_orders' ? [{ id: 9, contractId: 'MNQ:2026-12', type: 4, side: 1, size: 1, stopPrice: 20990 }] : []);
  } };
  const facts = await AG.accountFacts(exit, caller);
  assert.strictEqual(exit.contractId, 'MNQ', 'named again after the reads, as the positions were');
  assert.deepStrictEqual(facts.orders.map(o => o.contractId), ['MNQ']);
  const config = loadConfig({});
  const now = new Date('2026-10-05T14:30:00Z');
  assert.deepStrictEqual(AG.evaluateAccount({ input: exit, ...facts, config, now }), [], 'the long\'s own exit goes');
  // A close sent moments ago under the month's name still counts for the exit (the ledger is named alike).
  const ledger = [{ contractId: 'MNQ:2026-12', root: 'MNQ', sign: -1, size: 1, netBefore: 1, rootNetBefore: 1, at: now.getTime(), sentAt: now.getTime() }];
  assert.match(AG.evaluateAccount({ input: exit, ...facts, config, now, ledger })[0].message, /once recent orders fill/);
  assert.match(AG.evaluateAccountChange('partial_close_position', { input: { ...exit, size: 1 }, positions: facts.positions, orders: facts.orders, config, now, ledger })[0].message, /once recent orders fill/);
  // The close lane's ledger entry: named with the positions too.
  assert.strictEqual(closeLedgerEntry('close_position', close, [{ contractId: 'MNQ', type: 1, size: 1 }], now).contractId, 'MNQ');
  // Live: nothing is named again (main's naming).
  const live = canonicalArgs({ accountId: 1, contractId: 'MNQ:2026-12' }, { FTH_HOME: home });
  assert.strictEqual(live[AG.RENAME], undefined);
  assert.deepStrictEqual(AG.renamed(live, [{ contractId: 'MNQ' }]).positions, [{ contractId: 'MNQ' }]);
});

test('closeLedgerEntry: a close counts from the account before it, capped at the position; nothing to close is no entry', () => {
  const now = new Date('2026-10-07T14:00:00Z');
  const long2 = [{ contractId: 'MNQ', type: 1, size: 2 }, { contractId: 'MNQ:2027-03', type: 2, size: 1 }];
  const full = closeLedgerEntry('close_position', { contractId: 'MNQ' }, long2, now);
  assert.deepStrictEqual(full, { contractId: 'MNQ', root: 'MNQ', sign: -1, size: 2, netBefore: 2, rootNetBefore: 1, at: now.getTime(), sentAt: now.getTime(), unconfirmed: true });
  assert.strictEqual(closeLedgerEntry('partial_close_position', { contractId: 'MNQ', size: 1 }, long2, now).size, 1);
  assert.strictEqual(closeLedgerEntry('partial_close_position', { contractId: 'MNQ', size: 5 }, long2, now).size, 2);
  assert.strictEqual(closeLedgerEntry('close_position', { contractId: 'MES' }, long2, now), null);
  assert.strictEqual(closeLedgerEntry('close_position', { contractId: 'MNQ' }, null, now), null);
});

test('closeRefused: only a body saying success: false is a refusal; an error reply is an unknown outcome', () => {
  const reply = (text, extra = {}) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], ...extra } });
  assert.strictEqual(closeRefused(reply(JSON.stringify({ success: false, errorCode: 2 }))), true);
  assert.strictEqual(closeRefused(reply(JSON.stringify({ success: true }))), false);
  assert.strictEqual(closeRefused(reply('HTTP 504 gateway timeout', { isError: true })), false);
  assert.strictEqual(closeRefused(reply(JSON.stringify({ success: false }), { isError: true })), false, 'an error reply, whatever it says');
  assert.strictEqual(closeRefused({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }), false);
  assert.strictEqual(closeRefused(reply('not json')), false);
  // Sure refusals in an error reply: the broker's guardrail, the translator's "not sent", a malformed request.
  assert.strictEqual(closeRefused(reply('Blocked by risk guardrail: trading is disabled', { isError: true })), true);
  assert.strictEqual(closeRefused(reply('contract-translator: not sent: no ES contract found at this broker', { isError: true })), true);
  assert.strictEqual(closeRefused({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } }), true);
  assert.strictEqual(closeRefused(null), false);
});

test('the gateway with the real gate: an entry tagged with a retired strategy is answered with the refusal; its exit is forwarded', async () => {
  const { checkOrder } = require('../../scripts/lib/trading/check-order');
  const { FAKE_BROKERS, writeJournal, entryOrder } = require('../helpers');
  const home = tmpDir();
  const env = { FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_JOURNAL: writeJournal(home, []), NODE_ENV: 'test', FTH_TEST_NOW: '2026-10-07T14:30:00.000Z', FTH_KILL_SWITCH_FILE: path.join(home, 'STOP') };
  const ROOT = path.resolve(__dirname, '..', '..');
  const check = (args, tool) => checkOrder(args, { env, pluginRoot: ROOT, tool });
  const entry = JSON.stringify(call(1, 'place_order', entryOrder({ rationale: 'setup:supertrend long, stop 21480' })));
  const r = await handleClientLine(entry, check);
  assert.strictEqual(r.forward, null);
  assert.match(r.respond[0].result.content[0].text, /setup:supertrend is not a known strategy \(retired on 2026-10-13: strategies\/README\.md, "Retired strategies"\): no new entries from it/);
  const { stopLossBracket: _sl, ...exitArgs } = entryOrder({ side: 'sell', rationale: '[exit] close the supertrend long' });
  const exit = JSON.stringify(call(2, 'place_order', exitArgs));
  assert.strictEqual((await handleClientLine(exit, check)).forward, exit, 'the exit goes to the broker (its account checks are the gateway\'s next step)');
});
