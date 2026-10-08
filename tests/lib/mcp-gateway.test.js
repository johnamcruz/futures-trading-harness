'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { handleClientLine, isOrderCall, isLaneCall, orderTool, childCaller, lineSplitter } = require('../../scripts/lib/trading/mcp-gateway');

const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const allow = () => ({ allowed: true, violations: [] });
const deny = () => ({ allowed: false, message: 'Blocked by trading harness: no plan', violations: [{ check: 'plan-required' }] });

test('only place_order tool calls are order calls', () => {
  assert.strictEqual(isOrderCall(call(1, 'place_order')), true);
  assert.strictEqual(isOrderCall(call(1, 'mcp__projectx__place_order')), true);
  assert.strictEqual(isOrderCall(call(1, 'get_bars')), false);
  assert.strictEqual(isOrderCall(call(1, 'replace_order')), false);
  assert.strictEqual(orderTool(call(1, 'mcp__projectx__modify_order')), 'modify_order');
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
