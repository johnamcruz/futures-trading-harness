'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { documents, parsed, BRIDGE_TOOLS, unwrap, SHELL_TOOLS } = require('../../scripts/lib/transcript');
const hc = require('../../scripts/lib/headless-check');

test('documents: one JSON document, one per line, or what parses after warning lines', () => {
  assert.deepStrictEqual(documents('[{"a":1}]'), [[{ a: 1 }]]);
  assert.deepStrictEqual(documents('{"a":1}\n{"b":2}\nnot json\n42'), [{ a: 1 }, { b: 2 }], 'stream-json lines; text and bare values skipped');
  assert.deepStrictEqual(documents('Warning: a long context\n[{"type":"result"}]\n'), [[{ type: 'result' }]], 'Qwen prints warnings before its JSON');
  assert.deepStrictEqual(documents(''), []);
  assert.deepStrictEqual(documents(null), []);
});

test('parsed: a JSON string\'s value, else null; anything else as is', () => {
  assert.deepStrictEqual(parsed('{"x":1}'), { x: 1 });
  assert.strictEqual(parsed('{oops'), null);
  const o = { y: 2 };
  assert.strictEqual(parsed(o), o);
});

test('unwrap: a bridge call is the tool it reaches, with its arguments; anything else is itself', () => {
  const r = unwrap('tool_call', { name: 'mcp__broker__place_order', arguments: { size: 1 } });
  assert.deepStrictEqual([r.name, r.input, r.bridge && r.bridge.name], ['mcp__broker__place_order', { size: 1 }, 'tool_call']);
  assert.deepStrictEqual(unwrap('tool_call', JSON.stringify({ name: 'x', arguments: '{"a":1}' })).input, { a: 1 }, 'string input and string arguments');
  assert.deepStrictEqual(unwrap('tool_call', { name: 'x', arguments: 'garbage' }).input, {}, 'unparseable arguments: none');
  assert.deepStrictEqual(unwrap('tool_call', { arguments: {} }), { name: 'tool_call', input: { arguments: {} } }, 'no target: the wrapper itself');
  assert.deepStrictEqual(unwrap('tool_call', { name: '' }), { name: 'tool_call', input: { name: '' } });
  assert.deepStrictEqual(unwrap('Bash', { command: 'ls' }), { name: 'Bash', input: { command: 'ls' } });
  assert.deepStrictEqual(unwrap('Bash', undefined), { name: 'Bash', input: {} });
  assert.ok(BRIDGE_TOOLS[0].refused.test('[tool_call bridge refused] Deferred tool "x" has no verified schema'));
  assert.ok(!BRIDGE_TOOLS[0].refused.test('order gate: refused [plan-required]'));
  // One list, shared by the headless check and the cycle log.
  assert.strictEqual(hc.BRIDGE_TOOLS, BRIDGE_TOOLS);
  assert.ok(SHELL_TOOLS.has('Bash') && SHELL_TOOLS.has('run_shell_command') && !SHELL_TOOLS.has('tool_call'));
});
