'use strict';

// The harness-tools server's protocol (scripts/lib/harness-tools/protocol.js): JSON-RPC 2.0 over
// newline-delimited stdio, MCP's initialize / ping / tools/list / tools/call, and tool results
// that are the CLI's output (or an isError saying why not).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const { createServer, callTool, boundedLines, PROTOCOL_VERSIONS, MAX_OUTPUT_BYTES } = require('../../scripts/lib/harness-tools/protocol');

function server(env = { FTH_HOME: tmpDir() }, root) {
  const out = [];
  const s = createServer({ env, root, write: m => out.push(m) });
  const send = async msg => {
    const n = out.length;
    await s.handleLine(typeof msg === 'string' ? msg : JSON.stringify(msg));
    await s.idle();
    return out.slice(n);
  };
  return { s, out, send };
}

test('protocol: initialize echoes a supported version, else the latest; serverInfo is harness', async () => {
  const { send } = server();
  const [a] = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } });
  assert.strictEqual(a.result.protocolVersion, '2025-03-26');
  assert.deepStrictEqual(a.result.serverInfo, { name: 'harness', version: '1' });
  assert.deepStrictEqual(a.result.capabilities, { tools: { listChanged: false } });
  const [b] = await send({ jsonrpc: '2.0', id: 'x', method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.strictEqual(b.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.strictEqual(PROTOCOL_VERSIONS[0], '2025-06-18');
});

test('protocol: notifications get no reply; ping, tools/list; unknown methods, batches and bad requests are errors', async () => {
  const { send } = server();
  assert.deepStrictEqual(await send({ jsonrpc: '2.0', method: 'notifications/initialized' }), []);
  assert.deepStrictEqual(await send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'blackouts_add', arguments: {} } }), [], 'a tools/call notification is not run');
  assert.deepStrictEqual(await send({ jsonrpc: '2.0', id: 2, method: 'ping' }), [{ jsonrpc: '2.0', id: 2, result: {} }]);
  const [list] = await send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.strictEqual(list.result.tools.length, 13);
  const code = async msg => (await send(msg))[0].error.code;
  assert.strictEqual(await code({ jsonrpc: '2.0', id: 4, method: 'resources/list' }), -32601);
  assert.strictEqual(await code([{ jsonrpc: '2.0', id: 5, method: 'ping' }]), -32600);
  assert.strictEqual(await code('{not json'), -32700);
  assert.strictEqual(await code('42'), -32600);
  assert.strictEqual(await code('null'), -32600);
  assert.strictEqual(await code({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' }), -32600);
  assert.strictEqual(await code({ jsonrpc: '2.0', id: null, method: 'ping' }), -32600);
  assert.strictEqual(await code({ jsonrpc: '1.0', id: 6, method: 'ping' }), -32600);
  assert.strictEqual(await code({ jsonrpc: '2.0', id: 7 }), -32600);
  assert.strictEqual(await code({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: [] }), -32602);
  assert.strictEqual(await code({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'place_order', arguments: {} } }), -32602);
  assert.strictEqual(await code({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: '__proto__' } }), -32602);
  assert.deepStrictEqual(await send({ jsonrpc: '2.0', id: 11, result: {} }), [], 'a stray response is ignored');
});

test('protocol: invalid arguments are an isError result naming the problem, not a protocol error', async () => {
  const { send } = server();
  const [r] = await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lessons', arguments: { top: 0, cwd: '/' } } });
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /invalid arguments for lessons: top: at least 1; "cwd": unknown argument/);
  const [n] = await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lessons', arguments: null } });
  assert.match(n.result.content[0].text, /must be an object/);
});

test('callTool: success is the CLI text plus stderr notes; a failure is [script] message; a refused bars path never runs', async () => {
  const home = tmpDir();
  const ok = await callTool('lessons', {}, { env: { FTH_HOME: home, FTH_JOURNAL: path.join(home, 'none.jsonl') } });
  assert.strictEqual(ok.isError, undefined);
  assert.match(ok.content[0].text, /^No instincts yet/);
  const fail = await callTool('reconcile', { day: '2026-10-07' }, { env: { FTH_HOME: home } });
  assert.strictEqual(fail.isError, true);
  assert.match(fail.content[0].text, /^\[reconcile\] no decision log for 2026-10-07/);
  const refused = await callTool('market_snapshot', { bars: '/etc/hosts.json' }, { env: { FTH_HOME: home } });
  assert.strictEqual(refused.isError, true);
  assert.match(refused.content[0].text, /^\[harness\] bars: a bars file .*\(outside them/);
  const clock = await callTool('blackouts_list', {}, { env: { FTH_HOME: home, FTH_REPLAY_NOW: 'soon' } });
  assert.match(clock.content[0].text, /^\[blackouts\] FTH_REPLAY_NOW "soon" is not an ISO 8601 UTC time/);
});

test('callTool: output over 256 KB is refused whole, with how to narrow it', async () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'strategies', 'big'), { recursive: true });
  fs.writeFileSync(path.join(root, 'strategies', 'big', 'STRATEGY.md'), `---\nname: big\n---\n${'x'.repeat(MAX_OUTPUT_BYTES + 10)}\n`);
  const r = await callTool('strategies_show', { name: 'big' }, { env: { FTH_HOME: tmpDir() }, root });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /output is 25\d KB, over the 256 KB .* none of it is returned/);
  assert.ok(r.content[0].text.length < 1000);
});

test('boundedLines: complete lines pass; a line over the limit is dropped whole and reported once', () => {
  const lines = [];
  let over = 0;
  const b = boundedLines(l => lines.push(l), () => { over += 1; }, 10);
  b.push('{"a":1}\n{"b"');
  b.push(':2}\r\n');
  b.push('x'.repeat(6));
  b.push('y'.repeat(6));
  b.push('z\n{"c":3}\n');
  b.push('0123456789\n');
  b.push('01234567890\n');
  b.push('tail');
  b.flush();
  assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}', '0123456789', 'tail']);
  assert.strictEqual(over, 2);
});
