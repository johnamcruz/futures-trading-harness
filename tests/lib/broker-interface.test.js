'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { TOOLS, OUTCOMES, ENUMS, JOURNAL, GUARDRAILS, TRANSPORT, validateTools, validateResult } = require('../../scripts/lib/broker/interface');
const { createMcpClient } = require('../../scripts/lib/broker/mcp-client');
const { createAdapter, openAdapter, tradingBlocked } = require('../../scripts/lib/broker/adapter');
const { activeBroker, serverCommand } = require('../../scripts/lib/broker/config');
const { checkConformance } = require('../../scripts/lib/broker/conformance');
const { main: checkCli } = require('../../scripts/check-broker-mcp');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
const MNQ = 'CON.F.US.MNQ.Z26';
const fake = (env = {}) => createMcpClient({ command: process.execPath, args: [FAKE], env: { ...process.env, ...env } });

test('the interface: 20 tools (5 order tools), enums, journal kinds, guardrails, transport', () => {
  assert.strictEqual(Object.keys(TOOLS).length, 20);
  assert.deepStrictEqual(Object.keys(TOOLS).filter(n => TOOLS[n].role === 'order').sort(), ['cancel_order', 'close_position', 'modify_order', 'partial_close_position', 'place_order']);
  assert.ok(TOOLS.place_order.input.rationale.required && TOOLS.place_order.input.stopLossBracket);
  assert.deepStrictEqual([ENUMS.side.buy, ENUMS.side.sell, ENUMS.orderType.stop, ENUMS.positionType.short], [0, 1, 4, 2]);
  assert.ok(JOURNAL.serverWritten.order_placed && JOURNAL.agentWritten.includes('plan') && GUARDRAILS.length >= 5);
  assert.match(TRANSPORT.error, /Blocked by risk guardrail:/);
  assert.deepStrictEqual([OUTCOMES.place[4], OUTCOMES.edit[2], OUTCOMES.close[2]], ['AccountViolation', 'OrderNotFound', 'PositionNotFound']);
});

test('validators: a missing tool or input field, and a result missing the fields the harness reads', () => {
  const tools = Object.entries(TOOLS).map(([name, t]) => ({ name, inputSchema: { properties: Object.fromEntries(Object.keys(t.input).map(k => [k, {}])) } }));
  assert.deepStrictEqual(validateTools(tools), []);
  const less = tools.filter(t => t.name !== 'get_bars').map(t => (t.name === 'place_order' ? { ...t, inputSchema: { properties: { contractId: {} } } } : t));
  const problems = validateTools(less);
  assert.ok(problems.includes('missing tool get_bars') && problems.includes('place_order: no input field rationale'));
  assert.deepStrictEqual(validateResult('list_open_positions', [{ id: 1, contractId: MNQ, type: 1, size: 1, averagePrice: 21500, creationTimestamp: '2026-10-07T14:01:00Z' }]), []);
  assert.deepStrictEqual(validateResult('list_open_positions', [{ id: 1, contractId: MNQ, type: 'long', size: 1, averagePrice: 21500, creationTimestamp: 'x' }]), ['list_open_positions: [0].type is not number']);
  assert.deepStrictEqual(validateResult('get_bars', { contractId: MNQ, barSize: '1 minute', count: 0, bars: 'none' }), ['get_bars: bars is not a list']);
  assert.deepStrictEqual(validateResult('search_trades', [{ id: 1, orderId: 2, contractId: MNQ, creationTimestamp: 't', price: 1, side: 0, size: 1, profitAndLoss: null, fees: null, voided: false }]), [], 'null P&L on an opening fill');
});

test('the conformance checker: a conforming server passes; a missing tool or newest-first bars fail; it never calls an order tool', async () => {
  const calls = path.join(tmpDir(), 'calls.txt');
  const good = fake({ FAKE_CALLS: calls });
  try {
    const r = await checkConformance(good);
    assert.ok(r.ok, JSON.stringify(r.results.filter(x => !x.ok)));
  } finally {
    good.close();
  }
  const used = fs.readFileSync(calls, 'utf8').trim().split('\n');
  for (const t of Object.keys(TOOLS).filter(n => TOOLS[n].role === 'order').concat('journal_add')) assert.ok(!used.includes(t), `${t} was called`);
  const bad = fake({ FAKE_DROP: 'get_bars', FAKE_NEWEST_FIRST: '1' });
  try {
    const r = await checkConformance(bad);
    assert.strictEqual(r.ok, false);
    assert.ok(r.results.some(x => x.problems.includes('missing tool get_bars')));
  } finally {
    bad.close();
  }
  const newest = fake({ FAKE_NEWEST_FIRST: '1' });
  try {
    assert.ok((await checkConformance(newest)).results.some(x => x.problems.includes('bars are not oldest first')));
  } finally {
    newest.close();
  }
  let out = '';
  assert.strictEqual(await checkCli(['--', process.execPath, FAKE], s => { out += s; }), 0);
  assert.match(out, /conforms to the broker MCP interface/);
  await assert.rejects(() => checkCli([]), /usage/);
});

test('the MCP client: a tool error is thrown with its text; a server that exits restarts on the next call', async () => {
  const mcp = fake({ FAKE_DROP: 'get_quote' });
  try {
    await assert.rejects(() => mcp.call('get_quote', { contractId: MNQ }), /get_quote: unknown tool get_quote/);
    assert.strictEqual((await mcp.listTools()).length, 19);
  } finally {
    mcp.close();
  }
  const dead = createMcpClient({ command: process.execPath, args: ['-e', 'process.exit(3)'] });
  await assert.rejects(() => dead.listTools(), /MCP server exited \(code 3\)/);
  await assert.rejects(() => dead.listTools(), /MCP server exited/, 'starts again, and fails again');
});

test('the broker client reads and manages through any conforming server', async () => {
  const client = createAdapter({ mcp: fake({ FAKE_NEWEST_FIRST: '1' }) });
  try {
    assert.deepStrictEqual(await client.activeContract('MNQ'), { id: MNQ, name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5 });
    const bars = await client.closedBars(MNQ, { minutes: 3, limit: 5, now: new Date('2026-10-07T20:00:00Z') });
    assert.ok(bars.length === 5 && Date.parse(bars[0].t) < Date.parse(bars[4].t), 'sorted oldest first');
    const state = await client.accountState(7);
    assert.deepStrictEqual([state.positions.length, state.orders.length], [1, 1]);
    assert.strictEqual(await client.accountBalance(7), 50000);
    await assert.rejects(() => client.accountBalance(8), /account 8 not found/);
    assert.strictEqual(await client.netPosition(7, MNQ), 1);
    assert.strictEqual(await client.workingOrders(7, MNQ), 1);
    await client.modifyStop(7, 9, 21490);
    await assert.rejects(() => client.modifyStop(7, 99, 21490), /modify order 99 failed \(errorCode 2 OrderNotFound\)/);
    await client.closePosition(7, MNQ);
    await client.cancelOrder(7, 9);
    assert.deepStrictEqual(await client.accountState(7), { positions: [], orders: [] });
    assert.strictEqual((await client.history(MNQ, { start: new Date('2026-10-07T13:00:00Z'), end: new Date('2026-10-07T13:30:00Z') })).length > 0, true);
  } finally {
    client.close();
  }
});

test('the adapter opens the configured broker: reads straight to it, a stop moved away from the market is refused by the gateway', async () => {
  const home = tmpDir();
  const env = { PATH: process.env.PATH, HOME: home, FTH_HOME: home, PROJECTX_MCP_ENTRY: FAKE, PROJECTX_JOURNAL_PATH: path.join(home, 'j.jsonl'), FTH_GATE_LOG: path.join(home, 'gate.jsonl') };
  const client = openAdapter({ root: ROOT, env });
  try {
    await client.verify();
    assert.strictEqual((await client.activeContract('MNQ')).id, MNQ);
    // The fake's long 1 MNQ has its stop at 21480.00: lowering it is moving it away from the market.
    await assert.rejects(() => client.modifyStop(7, 9, 21470), /modify-protection|Blocked by trading harness/);
    await client.modifyStop(7, 9, 21490);
  } finally {
    client.close();
  }
  assert.throws(() => openAdapter({ root: ROOT, env: { ...env, FTH_BROKER: 'tradovate' } }), /unknown broker "tradovate"/);
  const { PROJECTX_MCP_ENTRY: _entry, ...noEntry } = env;
  assert.throws(() => openAdapter({ root: ROOT, env: noEntry }), /broker topstepx: no MCP server configured \(set PROJECTX_MCP_ENTRY/);
});

test('the broker config: topstepx by default; yours adds brokers, picks one, or overrides fields; FTH_BROKER wins', () => {
  const home = tmpDir();
  const t = activeBroker({ FTH_HOME: home });
  assert.deepStrictEqual([t.name, t.command, t.repo], ['topstepx', null, 'https://github.com/johnamcruz/projectx-mcp']);
  assert.strictEqual(activeBroker({ FTH_HOME: home, PROJECTX_MCP_ENTRY: '/x/index.js' }).command[1], '/x/index.js');
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({
    broker: 'other',
    brokers: { other: { repo: 'https://example.com/other-mcp', command: ['other-mcp', '--stdio'], journal: '~/other/j.jsonl', paperEnv: { OTHER_TRADING: 'off' } }, topstepx: { entry: '/y/index.js' } },
  }));
  const o = activeBroker({ FTH_HOME: home });
  assert.deepStrictEqual([o.name, serverCommand(o), o.journalPath, o.paperEnv], ['other', ['other-mcp', '--stdio'], path.join(require('os').homedir(), 'other', 'j.jsonl'), { OTHER_TRADING: 'off' }]);
  const back = activeBroker({ FTH_HOME: home, FTH_BROKER: 'topstepx' });
  assert.deepStrictEqual([back.command[1], back.env.includes('PROJECTX_API_KEY')], ['/y/index.js', true]);
  assert.throws(() => activeBroker({ FTH_HOME: home, FTH_BROKER: 'Bad Name' }), /not valid/);
  fs.writeFileSync(path.join(home, 'brokers.json'), '{ nope');
  assert.throws(() => activeBroker({ FTH_HOME: home }), /brokers\.json/);
});

test('the broker client: reads on one connection, order calls on the other; a stop move carries no reason', async () => {
  const stub = (log, result) => ({ call: async (name, args) => { log.push([name, args]); return result(name); }, close: () => log.push(['close']) });
  const reads = [];
  const writes = [];
  const client = createAdapter({
    mcp: stub(reads, name => (name === 'list_open_positions' || name === 'list_open_orders' ? [] : { tradingEnabled: true })),
    writeMcp: stub(writes, () => ({ success: true, errorCode: 0 })),
  });
  await client.accountState(7);
  await client.serverConfig();
  await client.modifyStop(7, 9, 21490.25);
  await client.cancelOrder(7, 9);
  await client.closePosition(7, MNQ);
  client.close();
  assert.deepStrictEqual(reads.map(r => r[0]).sort(), ['close', 'get_server_config', 'list_open_orders', 'list_open_positions']);
  assert.deepStrictEqual(writes.map(w => w[0]), ['modify_order', 'cancel_order', 'close_position', 'close']);
  assert.deepStrictEqual(writes[0][1], { accountId: 7, orderId: 9, stopPrice: 21490.25 });
});

test('tradingBlocked: the server must trade, on the runner\'s account', () => {
  assert.match(tradingBlocked({ tradingEnabled: false }, 7), /trading disabled/);
  assert.match(tradingBlocked(null, 7), /trading disabled/);
  assert.match(tradingBlocked({ tradingEnabled: true, allowedAccountIds: [5, 6] }, 7), /account 7 is not among the server's allowed accounts \(5, 6\)/);
  assert.strictEqual(tradingBlocked({ tradingEnabled: true, allowedAccountIds: [7] }, '7'), null);
  assert.strictEqual(tradingBlocked({ tradingEnabled: true, allowedAccountIds: [] }, 7), null);
  assert.strictEqual(tradingBlocked({ tradingEnabled: true, allowedAccountIds: 'any' }, 7), null, 'projectx-mcp says "any"');
});

test('the MCP client: a server that never finishes the handshake is stopped and started afresh on the next call', async () => {
  let spawns = 0;
  const { spawn } = require('child_process');
  const mcp = createMcpClient({
    command: process.execPath, args: ['-e', 'process.stdin.resume()'], timeoutMs: 300,
    spawnFn: (...a) => { spawns += 1; return spawn(...a); },
  });
  try {
    await assert.rejects(() => mcp.listTools(), /initialize: no answer/);
    await assert.rejects(() => mcp.listTools(), /initialize: no answer/);
    assert.strictEqual(spawns, 2, 'the wedged server was replaced');
  } finally {
    mcp.close();
  }
});

test('the conformance checker: a failing get_quote is a warning, not a failure', async () => {
  const inner = fake();
  const mcp = { listTools: () => inner.listTools(), call: (name, args) => (name === 'get_quote' ? Promise.reject(new Error('no market data subscription')) : inner.call(name, args)), close: () => inner.close() };
  try {
    const r = await checkConformance(mcp);
    assert.ok(r.ok, JSON.stringify(r.results.filter(x => !x.ok)));
    assert.ok(r.results.some(x => /get_quote \(warning/.test(x.check) && x.problems.includes('no market data subscription')));
  } finally {
    mcp.close();
  }
});

test('the spec document names every tool, required input, and required result field of the interface', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'BROKER-MCP-INTERFACE.md'), 'utf8');
  for (const [name, t] of Object.entries(TOOLS)) {
    assert.ok(doc.includes(`\`${name}\``), `tool ${name}`);
    for (const [k, f] of Object.entries(t.input)) if (f.required) assert.ok(doc.includes(`**\`${k}\`**`), `${name} input ${k}`);
    for (const [p, f] of Object.entries(t.result)) {
      const leaf = p.split('.').pop().replace('[]', '');
      if (f.required && leaf) assert.match(doc, new RegExp(`\\b${leaf}\\b`), `${name} result ${p}`);
    }
  }
  for (const kind of Object.keys(JOURNAL.serverWritten)) assert.ok(doc.includes(`\`${kind}\``), kind);
  for (const table of Object.values(OUTCOMES)) for (const [code, name] of Object.entries(table)) assert.ok(doc.includes(`${code} ${name}`), `${code} ${name}`);
});
