'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { handleClientLine, isOrderCall, lineSplitter } = require('../../scripts/lib/trading/mcp-gateway');

const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const allow = () => ({ allowed: true, violations: [] });
const deny = () => ({ allowed: false, message: 'Blocked by trading harness: no plan', violations: [{ check: 'plan-required' }] });

test('only place_order tool calls are order calls', () => {
  assert.strictEqual(isOrderCall(call(1, 'place_order')), true);
  assert.strictEqual(isOrderCall(call(1, 'mcp__projectx__place_order')), true);
  assert.strictEqual(isOrderCall(call(1, 'get_bars')), false);
  assert.strictEqual(isOrderCall(call(1, 'replace_order')), false);
  assert.strictEqual(isOrderCall({ method: 'tools/list' }), false);
});

test('non-order and unparseable lines pass through untouched', () => {
  const line = JSON.stringify(call(1, 'get_bars'));
  assert.deepStrictEqual(handleClientLine(line, deny), { forward: line, respond: [] });
  assert.deepStrictEqual(handleClientLine('not json', deny), { forward: 'not json', respond: [] });
});

test('allowed orders are forwarded, blocked orders answered with isError', () => {
  const line = JSON.stringify(call(7, 'place_order', { rationale: 'x' }));
  assert.strictEqual(handleClientLine(line, allow).forward, line);
  const logs = [];
  const r = handleClientLine(line, deny, e => logs.push(e));
  assert.strictEqual(r.forward, null);
  assert.deepStrictEqual(r.respond, [{ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'Blocked by trading harness: no plan' }], isError: true } }]);
  assert.strictEqual(logs[0].decision, 'blocked');
});

test('a crashing check blocks the order (fail closed)', () => {
  const r = handleClientLine(JSON.stringify(call(3, 'place_order')), () => { throw new Error('journal unreadable'); });
  assert.strictEqual(r.forward, null);
  assert.match(r.respond[0].result.content[0].text, /could not run \(journal unreadable\)/);
});

test('batches forward the allowed subset and answer the blocked ones', () => {
  const batch = [call(1, 'get_bars'), call(2, 'place_order')];
  const r = handleClientLine(JSON.stringify(batch), deny);
  assert.deepStrictEqual(JSON.parse(r.forward), [batch[0]]);
  assert.strictEqual(r.respond[0].id, 2);
  const onlyOrders = handleClientLine(JSON.stringify([call(5, 'place_order')]), deny);
  assert.strictEqual(onlyOrders.forward, null);
});

test('a blocked notification is dropped without a response', () => {
  const note = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'place_order' } };
  assert.deepStrictEqual(handleClientLine(JSON.stringify(note), deny), { forward: null, respond: [] });
});

test('lineSplitter reassembles chunked lines', () => {
  const lines = [];
  const s = lineSplitter(l => lines.push(l));
  s.push('{"a":1}\n{"b"');
  s.push(':2}\r\n\n{"c":3}');
  s.flush();
  assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});
