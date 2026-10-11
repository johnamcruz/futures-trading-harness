'use strict';

// The runner's start check of the harness-tools server (scripts/lib/harness-tools/preflight.js):
// the server the cycles will start answers tools/list with exactly the registry's tools.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { compareTools, checkToolsServer } = require('../../scripts/lib/harness-tools/preflight');
const { listTools } = require('../../scripts/lib/harness-tools/registry');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE_BROKER = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');

test('compareTools: the registry matches itself; a missing, changed, or extra tool is named', () => {
  const want = listTools();
  assert.deepStrictEqual(compareTools(want), []);
  assert.deepStrictEqual(compareTools(want.slice(1)), [`missing ${want[0].name}`]);
  const changed = want.map((t, i) => (i === 1 ? { ...t, inputSchema: { type: 'object' } } : t));
  assert.deepStrictEqual(compareTools(changed), [`${want[1].name}: a different argument schema`]);
  const reworded = want.map((t, i) => (i === 2 ? { ...t, description: 'x' } : t));
  assert.deepStrictEqual(compareTools(reworded), [`${want[2].name}: a different description`]);
  assert.deepStrictEqual(compareTools([...want, { name: 'place_order' }]), ['unexpected tool place_order']);
  assert.strictEqual(compareTools(null).length, want.length);
});

test('checkToolsServer: the real server passes; a foreign server or one that never answers is refused', { timeout: 60000 }, async () => {
  const env = { ...process.env, FTH_HOME: tmpDir(), FTH_AUTONOMOUS: '1' };
  assert.strictEqual(await checkToolsServer({ root: ROOT, env }), listTools().length);
  await assert.rejects(() => checkToolsServer({ root: ROOT, env, args: [FAKE_BROKER] }), /does not offer the harness's tools \(missing strategies_list; .*; and \d+ more\); update the checkout/);
  await assert.rejects(() => checkToolsServer({ root: ROOT, env, args: ['-e', 'process.exit(5)'] }), /did not answer tools\/list: MCP server exited \(code 5\)/);
  await assert.rejects(() => checkToolsServer({ root: ROOT, env, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 500 }), /did not answer tools\/list: .*no answer/);
});
