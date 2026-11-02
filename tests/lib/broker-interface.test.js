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
const { FAKE_BROKERS, shippedBroker, tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
const MNQ = 'fake:MNQ:Z26';
const fake = (env = {}) => createMcpClient({ command: process.execPath, args: [FAKE], env: { ...process.env, ...env } });
// The fake behind the contract translator, as the harness always runs a server: standard names above it.
const TRANSLATOR = path.join(ROOT, 'scripts', 'contract-translator.js');
const translated = (env = {}) => createMcpClient({ command: process.execPath, args: [TRANSLATOR, '--broker', 'fake', '--', process.execPath, FAKE], env: { ...process.env, FTH_HOME: tmpDir(), ...env } });

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
  // The harness trades with the broker's tick specs: an unusable one fails; one unlike the static table (training) is a warning.
  const zero = fake({ FAKE_TICK: JSON.stringify({ tickValue: 0 }) });
  try {
    const r = await checkConformance(zero);
    assert.strictEqual(r.ok, false);
    assert.ok(r.results.some(x => !x.ok && /^get_contract: tickSize above 0 and tickValue/.test(x.check) && x.problems.includes('tickSize 0.25, tickValue 0')), JSON.stringify(r.results));
  } finally {
    zero.close();
  }
  const odd = fake({ FAKE_TICK: JSON.stringify({ tickValue: 2 }) });
  try {
    const r = await checkConformance(odd);
    assert.ok(r.ok, JSON.stringify(r.results.filter(x => !x.ok)));
    const warn = r.results.find(x => /tick specs match the static table \(warning: training would not equal live\)/.test(x.check));
    assert.match(warn.problems[0], /^MNQ: the broker's tick spec \(0\.25 = \$2\.00\) differs from the static table/);
  } finally {
    odd.close();
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
    const raw = await mcp.request('tools/call', { name: 'get_quote', arguments: { contractId: MNQ } });
    assert.strictEqual(raw.isError, true, 'request returns the raw result, isError included');
    assert.strictEqual((await mcp.request('tools/list')).tools.length, 19);
  } finally {
    mcp.close();
  }
  const dead = createMcpClient({ command: process.execPath, args: ['-e', 'process.exit(3)'] });
  await assert.rejects(() => dead.listTools(), /MCP server exited \(code 3\)/);
  await assert.rejects(() => dead.listTools(), /MCP server exited/, 'starts again, and fails again');
});

test('the broker client reads and manages through any conforming server, in standard contract names', async () => {
  const client = createAdapter({ mcp: translated({ FAKE_NEWEST_FIRST: '1' }) });
  const MNQ = 'MNQ'; // the server's own id (fake:MNQ:Z26) never reaches the adapter
  try {
    assert.deepStrictEqual(await client.activeContract('MNQ'), { id: 'MNQ', name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5 });
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
  const env = { PATH: process.env.PATH, HOME: home, FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_ENTRY: FAKE, FAKE_BROKER_JOURNAL: path.join(home, 'j.jsonl'), FTH_GATE_LOG: path.join(home, 'gate.jsonl') };
  const client = openAdapter({ root: ROOT, env });
  try {
    await client.verify();
    assert.strictEqual((await client.activeContract('MNQ')).id, 'MNQ');
    // The fake's long 1 MNQ has its stop at 21480.00: lowering it is moving it away from the market.
    await assert.rejects(() => client.modifyStop(7, 9, 21470), /modify-protection|Blocked by trading harness/);
    await client.modifyStop(7, 9, 21490);
  } finally {
    client.close();
  }
  assert.throws(() => openAdapter({ root: ROOT, env: { ...env, FTH_BROKER: 'other-broker' } }), /unknown broker "other-broker"/);
  const { FAKE_BROKER_ENTRY: _entry, ...noEntry } = env;
  assert.throws(() => openAdapter({ root: ROOT, env: noEntry }), /broker fake: no MCP server configured \(set FAKE_BROKER_ENTRY/);
});

test('the broker config: the default is the broker mcp-configs/brokers.json names; yours adds brokers, picks one, or overrides fields; FTH_BROKER wins', () => {
  const home = tmpDir();
  const shipped = shippedBroker(); // read from the file, never named here
  const t = activeBroker({ FTH_HOME: home });
  assert.deepStrictEqual([t.name, t.repo], [shipped.name, shipped.repo]);
  // A server from the broker's entry variable (the tests' fake broker's).
  assert.strictEqual(activeBroker({ FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS }).command, null);
  assert.strictEqual(activeBroker({ FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_ENTRY: '/x/index.js' }).command[1], '/x/index.js');
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({
    broker: 'other',
    brokers: { other: { repo: 'https://example.com/other-mcp', command: ['other-mcp', '--stdio'], journal: '~/other/j.jsonl', paperEnv: { OTHER_TRADING: 'off' } }, [shipped.name]: { entry: '/y/index.js' } },
  }));
  const o = activeBroker({ FTH_HOME: home });
  assert.deepStrictEqual([o.name, serverCommand(o), o.journalPath, o.paperEnv], ['other', ['other-mcp', '--stdio'], path.join(require('os').homedir(), 'other', 'j.jsonl'), { OTHER_TRADING: 'off' }]);
  // An override changes only the fields it sets: the shipped broker keeps its variables.
  const back = activeBroker({ FTH_HOME: home, FTH_BROKER: shipped.name });
  assert.deepStrictEqual([back.command[1], back.env], ['/y/index.js', shipped.env || []]);
  assert.throws(() => activeBroker({ FTH_HOME: home, FTH_BROKER: 'Bad Name' }), /not valid/);
  // Paths resolve against the config file's folder, so the gateway (run from workspace/) and the runner agree.
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ brokers: { [shipped.name]: { entry: 'srv/index.js', journal: 'j.jsonl' } } }));
  const rel = activeBroker({ FTH_HOME: home });
  assert.deepStrictEqual([rel.command[1], rel.journalPath], [path.join(home, 'srv', 'index.js'), path.join(home, 'j.jsonl')]);
  assert.throws(() => activeBroker({ FTH_HOME: home, FTH_BROKERS_FILE: path.join(home, 'missing.json') }), /FTH_BROKERS_FILE: .*does not exist/);
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
  // The fills since a time (a catch-up's close): search_trades on the read connection, a list or an error.
  const fillReads = [];
  const fillsClient = createAdapter({ mcp: stub(fillReads, () => [{ id: 1, profitAndLoss: -16, fees: 0.37, creationTimestamp: '2026-10-08T12:00:30Z' }]) });
  assert.strictEqual((await fillsClient.fillsSince('7', new Date('2026-10-07T22:00:00Z'))).length, 1);
  assert.deepStrictEqual(fillReads[0], ['search_trades', { accountId: 7, startTimestamp: '2026-10-07T22:00:00.000Z' }]);
  await assert.rejects(() => createAdapter({ mcp: stub([], () => ({ nope: 1 })) }).fillsSince(7, new Date()), /search_trades/);
  // The orders since a time (how an entry ended) and the runner's factual review: both on the read connection.
  const more = [];
  const busy = createAdapter({ mcp: stub(more, name => (name === 'search_orders' ? [{ id: 9, status: 3 }] : { ts: 't', kind: 'review', text: 'x' })), writeMcp: stub(writes, () => ({})) });
  assert.deepStrictEqual(await busy.ordersSince('7', new Date('2026-10-07T22:00:00Z')), [{ id: 9, status: 3 }]);
  const review = { kind: 'review', text: 'x', contractId: 'MNQ', orderId: 9, tags: ['by:runner', 'result:nofill'] };
  assert.strictEqual((await busy.journalAdd(review)).kind, 'review');
  assert.deepStrictEqual(more, [['search_orders', { accountId: 7, startTimestamp: '2026-10-07T22:00:00.000Z' }], ['journal_add', review]]);
  await assert.rejects(() => createAdapter({ mcp: stub([], () => null) }).journalAdd(review), /journal_add returned no journal entry/);
  await assert.rejects(() => createAdapter({ mcp: stub([], () => ({})) }).ordersSince(7, new Date()), /search_orders/);
});

test('tradingBlocked: the server must trade, on the runner\'s account', () => {
  assert.match(tradingBlocked({ tradingEnabled: false }, 7), /trading disabled/);
  assert.match(tradingBlocked(null, 7), /trading disabled/);
  assert.match(tradingBlocked({ tradingEnabled: true, allowedAccountIds: [5, 6] }, 7), /account 7 is not among the server's allowed accounts \(5, 6\)/);
  assert.strictEqual(tradingBlocked({ tradingEnabled: true, allowedAccountIds: [7] }, '7'), null);
  assert.strictEqual(tradingBlocked({ tradingEnabled: true, allowedAccountIds: [] }, 7), null);
  assert.strictEqual(tradingBlocked({ tradingEnabled: true, allowedAccountIds: 'any' }, 7), null, 'a server may say "any"');
  // A live run: a server that takes any account is refused, never read as allowing this one.
  assert.match(tradingBlocked({ tradingEnabled: true, allowedAccountIds: [] }, 7, { live: true }), /allows any account/);
  assert.match(tradingBlocked({ tradingEnabled: true, allowedAccountIds: 'any' }, 7, { live: true }), /allows any account/);
  assert.strictEqual(tradingBlocked({ tradingEnabled: true, allowedAccountIds: [7] }, 7, { live: true }), null);
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

test('an order\'s bracket field is optional, and checked only where present', () => {
  const o = { id: 1, contractId: MNQ, type: 4, side: 1, size: 1, status: 1, stopPrice: 21490, limitPrice: null };
  assert.deepStrictEqual(validateResult('list_open_orders', [o]), [], 'absent: unknown, not a problem');
  assert.deepStrictEqual(validateResult('list_open_orders', [{ ...o, bracket: { role: 'stop', entry: 'tag-1' } }]), []);
  assert.deepStrictEqual(validateResult('search_orders', [{ ...o, bracket: { role: 'target', entry: 7 } }]), []);
  assert.deepStrictEqual(validateResult('list_open_orders', [{ ...o, bracket: { role: 'stop' } }]), [], 'entry is optional: unknown');
  for (const bad of [null, 'stop', {}, { entry: 'tag-1' }, { role: 'sl', entry: 'tag-1' }, { role: 'stop', entry: '' }, { role: 'stop', entry: 1.5 }, { role: 'stop', entry: null }]) {
    assert.deepStrictEqual(validateResult('list_open_orders', [{ ...o, bracket: bad }]), ['list_open_orders: [0].bracket is malformed'], JSON.stringify(bad));
  }
  assert.strictEqual(TOOLS.list_open_orders.result['[].bracket'].required, false);
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

test('the conformance checker: search_trades must honour a past startTimestamp (a catch-up close reads the fills since a day ended)', async () => {
  const { checkConformance } = require('../../scripts/lib/broker/conformance');
  const { TOOLS } = require('../../scripts/lib/broker/interface');
  const now = new Date('2026-10-08T14:00:00Z');
  const fill = (id, at) => ({ id, contractId: 'X', creationTimestamp: at, price: 1, profitAndLoss: null, fees: 0.37, side: 0, size: 1, voided: false, orderId: id });
  const today = [fill(2, '2026-10-08T13:00:00Z')];
  const older = fill(1, '2026-10-06T15:00:00Z');
  const server = trades => ({
    listTools: async () => Object.keys(TOOLS).map(name => ({ name, inputSchema: { type: 'object', properties: Object.fromEntries(Object.keys(TOOLS[name].input).map(k => [k, {}])) } })),
    call: async (name, a) => (name === 'search_trades' ? trades(a) : (() => { throw new Error('not probed here'); })()),
  });
  const verdict = async trades => (await checkConformance(server(trades), { accountId: 7, now })).results.find(r => /past startTimestamp/.test(r.check));
  assert.strictEqual((await verdict(a => (a.startTimestamp ? [older, ...today] : today))).ok, true, 'honoured');
  assert.match((await verdict(a => (a.startTimestamp ? [] : today))).problems.join(), /narrowed or ignored/);
  assert.match((await verdict(() => [older, fill(0, '2026-09-01T15:00:00Z'), ...today])).problems.join(), /startTimestamp is ignored/);
});

test('the fake broker conforms at any clock: around the 18:00 ET reopen, at midnight, on a Sunday open and across both DST changes (no dated fixture ages out)', async () => {
  // 17:59 / 18:00 / 18:03 / 23:59 ET (EDT), Sunday 18:00 ET, and the days after DST ends and begins.
  const times = ['2026-10-14T21:59:00Z', '2026-10-14T22:00:00Z', '2026-10-14T22:03:00Z', '2026-10-15T03:59:00Z', '2026-10-18T22:00:00Z', '2026-11-02T00:30:00Z', '2027-03-15T13:00:00Z', '2030-01-02T15:00:00Z'];
  for (const at of times) {
    const mcp = fake({ FAKE_REPLAY_NOW: at });
    try {
      const r = await checkConformance(mcp, { accountId: 7 });
      assert.ok(r.ok, `${at}: ${JSON.stringify(r.results.filter(x => !x.ok))}`);
      assert.ok(r.results.some(x => /past startTimestamp is honoured/.test(x.check) && x.ok), at);
    } finally {
      mcp.close();
    }
  }
  // It honours startTimestamp both ways: none after its fill, the fill from a week back.
  const mcp = fake({ FAKE_REPLAY_NOW: '2026-10-14T22:03:00Z' });
  try {
    assert.strictEqual((await mcp.call('search_trades', { accountId: 7 })).length, 1, 'the trading day');
    assert.strictEqual((await mcp.call('search_trades', { accountId: 7, startTimestamp: '2026-10-07T22:00:00Z' })).length, 1, 'a week back');
    assert.strictEqual((await mcp.call('search_trades', { accountId: 7, startTimestamp: '2026-10-14T22:04:00Z' })).length, 0, 'after it');
  } finally {
    mcp.close();
  }
});

test('the contract translator dates its front-month lookups by the harness clock: a replay broker\'s replayed day', async () => {
  const day = async (env) => {
    const home = tmpDir();
    fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'sim.js'], ...env.brokerExtra } } }));
    const client = createAdapter({ mcp: translated({ FTH_HOME: home, FTH_BROKERS_FILE: path.join(home, 'brokers.json'), FTH_REPLAY_NOW: env.now }) });
    try {
      await client.activeContract('MNQ');
    } finally {
      client.close();
    }
    // The cache file: one per replayed day under a replay clock, the live one otherwise (broker/config.js contractsCacheFile).
    const files = fs.readdirSync(home).filter(n => /^contracts-fake.*\.json$/.test(n));
    assert.strictEqual(files.length, 1, files.join(', '));
    return [files[0], JSON.parse(fs.readFileSync(path.join(home, files[0]), 'utf8')).front.MNQ.day];
  };
  assert.deepStrictEqual(await day({ now: '2026-03-04T15:00:00Z', brokerExtra: { replay: true } }), ['contracts-fake.2026-03-04.json', '2026-03-04']);
  // Not a replay broker: the override is refused for checks; lookups go on, on the wall clock, in the live file.
  const [file, keyed] = await day({ now: '2026-03-04T15:00:00Z', brokerExtra: {} });
  assert.strictEqual(file, 'contracts-fake.json');
  assert.notStrictEqual(keyed, '2026-03-04');
});

test('contractsCacheFile: one file per replayed trading day under a replay clock; the live file otherwise (refused clocks too); the files are listed', () => {
  const { contractsCacheFile, contractsCacheFiles } = require('../../scripts/lib/broker/config');
  const home = tmpDir();
  const brokers = replay => fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'sim.js'], ...(replay ? { replay: true } : {}) } } }));
  brokers(true);
  const env = now => ({ FTH_HOME: home, ...(now ? { FTH_REPLAY_NOW: now } : {}) });
  assert.strictEqual(contractsCacheFile('sim', env()), path.join(home, 'contracts-sim.json'), 'live: the one file, as before');
  assert.strictEqual(contractsCacheFile('sim', env('2026-03-04T15:00:00Z')), path.join(home, 'contracts-sim.2026-03-04.json'));
  assert.strictEqual(contractsCacheFile('sim', env('2026-03-04T23:30:00Z')), path.join(home, 'contracts-sim.2026-03-05.json'), 'after the 18:00 ET open: the next trading day');
  assert.strictEqual(contractsCacheFile('s/m', env('2026-03-04T15:00:00Z')), path.join(home, 'contracts-s_m.2026-03-04.json'));
  assert.strictEqual(contractsCacheFile('sim', env('not a time')), path.join(home, 'contracts-sim.json'), 'a refused replay clock: the live file');
  brokers(false);
  assert.strictEqual(contractsCacheFile('sim', env('2026-03-04T15:00:00Z')), path.join(home, 'contracts-sim.json'), 'not a replay broker: the live file');
  // Listing: the live file first, then the days; other brokers' and other files are not theirs.
  const day = d => path.join(home, `contracts-sim.${d}.json`);
  for (const f of [path.join(home, 'contracts-sim.json'), day('2026-03-04'), day('2026-02-01'), path.join(home, 'contracts-simx.2026-02-01.json'), path.join(home, 'contracts-sim-notes.json')]) fs.writeFileSync(f, '{}');
  assert.deepStrictEqual(contractsCacheFiles('sim', env()), [path.join(home, 'contracts-sim.json'), day('2026-02-01'), day('2026-03-04')]);
  assert.deepStrictEqual(contractsCacheFiles('sim', { FTH_HOME: path.join(home, 'none') }), []);
});

test('the conformance checker dates its calls at the replay clock: the configured one, else a replay server\'s serverTime; live, the wall clock', async () => {
  const sent = [];
  const server = (config, bars = []) => ({
    listTools: async () => Object.keys(TOOLS).map(name => ({ name, inputSchema: { type: 'object', properties: Object.fromEntries(Object.keys(TOOLS[name].input).map(k => [k, {}])) } })),
    call: async (name, a) => {
      if (name === 'get_server_config') return config;
      if (name === 'search_contracts') return [{ id: 'X', name: 'MNQZ6', tickSize: 0.25, tickValue: 0.5, activeContract: true }];
      if (name === 'get_bars') return { contractId: 'X', barSize: '1 minute', count: bars.length, bars };
      if (name === 'search_trades') { sent.push(a.startTimestamp || null); return []; }
      throw new Error('not probed here');
    },
  });
  const wall = new Date('2026-10-13T14:00:00Z');
  const run = async (config, opts = {}) => {
    sent.length = 0;
    const r = await checkConformance(server(config, opts.bars), { accountId: 7, now: wall, ...opts });
    return { r, since: sent.find(Boolean) };
  };
  const bar = t => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 });
  const lookAhead = r => r.results.find(x => /no bar closes after the replay clock/.test(x.check));
  // Live: the wall clock (a week back from it), and no replay check.
  const live = await run({ replay: false, serverTime: '2026-03-04T15:00:00Z' }, { bars: [bar('2026-10-13T15:00:00Z')] });
  assert.match(live.since, /^2026-10-0/);
  assert.ok(!live.r.results.some(x => /replay clock/.test(x.check)));
  // A replay server: its serverTime; a bar closing after it fails.
  const rep = await run({ replay: true, serverTime: '2026-03-04T15:00:00Z' }, { bars: [bar('2026-03-04T14:58:00Z'), bar('2026-03-04T14:59:00Z')] });
  assert.match(rep.since, /^2026-02-2/);
  assert.strictEqual(lookAhead(rep.r).ok, true);
  const leak = await run({ replay: true, serverTime: '2026-03-04T15:00:00Z' }, { bars: [bar('2026-03-04T14:59:00Z'), bar('2026-03-04T15:00:00Z')] });
  assert.deepStrictEqual(lookAhead(leak.r).problems, ['1 of 2 bar(s) close after it (the first opened 2026-03-04T15:00:00Z): look-ahead']);
  assert.strictEqual(leak.r.ok, false);
  // A replay server without a readable serverTime fails.
  const blind = await run({ replay: true, serverTime: 'soon' });
  assert.strictEqual(blind.r.ok, false);
  assert.match(blind.r.results.find(x => /reports its replayed serverTime/.test(x.check) && !x.ok).problems[0], /serverTime "soon" is not a time/);
  // A configured replay clock wins; a server that doesn't report replay mode is a warning, and its bars are judged at the clock.
  const conf = await run({ replay: false, serverTime: wall.toISOString() }, { replayAt: new Date('2026-03-04T15:00:00Z'), bars: [bar('2026-10-13T13:59:00Z')] });
  assert.match(conf.since, /^2026-02-2/);
  assert.deepStrictEqual(conf.r.results.find(x => /configured replay clock/.test(x.check)).problems, ['the server does not report replay mode (get_server_config.replay), yet a replay clock is set']);
  assert.deepStrictEqual(lookAhead(conf.r).problems, ['1 of 1 bar(s) close after it (the first opened 2026-10-13T13:59:00Z): look-ahead']);
});

test('pruneReplayCaches: a pruned day\'s broker ids are kept in the broker\'s id index, so the run\'s labels and later days still name them (an expired June contract traded on 2026-06-02, pruned on 2026-08-14)', () => {
  const { contractsCacheFiles, pruneReplayCaches } = require('../../scripts/lib/broker/config');
  const { translatorCache } = require('../../scripts/lib/replay/labels');
  const { readCache } = require('../../scripts/lib/broker/translator');
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'backtester', brokers: { backtester: { command: ['node', 'x.js'], replay: true } } }));
  const env = { FTH_HOME: home, FTH_REPLAY_NOW: '2026-08-14T14:30:00Z' };
  const day = d => path.join(home, `contracts-backtester.${d}.json`);
  fs.writeFileSync(day('2026-06-02'), JSON.stringify({ ids: { 'BT.MNQ.M26': { root: 'MNQ', month: '2026-06' }, bad: { root: 1 } }, front: { MNQ: { id: 'BT.MNQ.M26', month: '2026-06', day: '2026-06-02' } } }));
  fs.writeFileSync(day('2026-06-03'), 'not json');
  fs.writeFileSync(day('2026-08-13'), JSON.stringify({ ids: { 'BT.MNQ.U26': { root: 'MNQ', month: '2026-09' } }, front: {} }));
  assert.strictEqual(translatorCache(contractsCacheFiles('backtester', env)).root('BT.MNQ.M26'), 'MNQ', 'before');
  assert.deepStrictEqual(pruneReplayCaches('backtester', env), [day('2026-06-02')]);
  assert.ok(!fs.existsSync(day('2026-06-02')) && fs.existsSync(day('2026-08-13')));
  assert.ok(fs.existsSync(day('2026-06-03')), 'a day file that can\'t be read is never deleted');
  assert.strictEqual(translatorCache(contractsCacheFiles('backtester', env)).root('BT.MNQ.M26'), 'MNQ', 'after: from the index');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'contracts-backtester.ids.json'), 'utf8')).ids, { 'BT.MNQ.M26': { root: 'MNQ', month: '2026-06' } }, 'root and month only; no front month, no bad entry');
  // A day near June reads it from the index too (a rerun of June); a day after it doesn't reuse the expired contract.
  assert.deepStrictEqual(readCache(day('2026-06-05')).ids['BT.MNQ.M26'], { root: 'MNQ', month: '2026-06' });
  assert.strictEqual(readCache(day('2026-08-14')).ids['BT.MNQ.M26'], undefined);
  // The index is never pruned; the index can't be written: nothing is pruned (no mapping lost).
  fs.writeFileSync(day('2026-06-10'), JSON.stringify({ ids: { 'BT.MNQ.X': { root: 'MNQ', month: '2026-06' } } }));
  const indexFile = path.join(home, 'contracts-backtester.ids.json');
  fs.renameSync(indexFile, `${indexFile}.saved`);
  fs.mkdirSync(indexFile); // the index can't be replaced
  try {
    assert.deepStrictEqual(pruneReplayCaches('backtester', env), []);
  } finally {
    fs.rmdirSync(indexFile);
    fs.renameSync(`${indexFile}.saved`, indexFile);
  }
  assert.ok(fs.existsSync(day('2026-06-10')));
  assert.deepStrictEqual(pruneReplayCaches('backtester', env), [day('2026-06-10')]);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, 'contracts-backtester.ids.json'), 'utf8')).ids).sort(), ['BT.MNQ.M26', 'BT.MNQ.X']);
});

test('day files: a broker named like a date never shares another broker\'s files, and pruning removes only its own day files', () => {
  const { contractsCacheFile, contractsCacheFiles, pruneReplayCaches } = require('../../scripts/lib/broker/config');
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'x.js'], replay: true } } }));
  const env = { FTH_HOME: home, FTH_REPLAY_NOW: '2026-03-04T15:00:00Z' };
  // Broker "sim-2026-03-01"'s live file is not one of broker "sim"'s day files, and the other way round.
  const other = contractsCacheFile('sim-2026-03-01', { FTH_HOME: home });
  assert.strictEqual(path.basename(other), 'contracts-sim-2026-03-01.json');
  assert.notStrictEqual(contractsCacheFile('sim', env), other);
  fs.writeFileSync(other, JSON.stringify({ ids: { keep: { root: 'MNQ', month: '2026-03' } } }));
  fs.writeFileSync(path.join(home, 'contracts-sim.2026-01-01.json'), JSON.stringify({ ids: {} }));
  fs.writeFileSync(path.join(home, 'contracts-simx.2026-01-01.json'), JSON.stringify({ ids: {} }));
  fs.writeFileSync(path.join(home, 'contracts-sim.2026-01-01.json.bak'), '{}');
  assert.deepStrictEqual(contractsCacheFiles('sim', env).map(f => path.basename(f)), ['contracts-sim.2026-01-01.json']);
  assert.deepStrictEqual(pruneReplayCaches('sim', env).map(f => path.basename(f)), ['contracts-sim.2026-01-01.json']);
  assert.ok(fs.existsSync(other) && fs.existsSync(path.join(home, 'contracts-simx.2026-01-01.json')) && fs.existsSync(path.join(home, 'contracts-sim.2026-01-01.json.bak')));
  // And the translator never reads another broker's files as a day file's siblings.
  const { readCache } = require('../../scripts/lib/broker/translator');
  assert.strictEqual(readCache(contractsCacheFile('sim', env)).ids.keep, undefined);
});

test('pruneReplayCaches: one prune at a time (a second, started while the first is between reading and writing the index, prunes nothing and loses nothing); a corrupt index prunes nothing; live never prunes', () => {
  const { pruneReplayCaches } = require('../../scripts/lib/broker/config');
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'x.js'], replay: true } } }));
  const env = { FTH_HOME: home, FTH_REPLAY_NOW: '2026-08-14T14:30:00Z' };
  const day = d => path.join(home, `contracts-sim.${d}.json`);
  const indexFile = path.join(home, 'contracts-sim.ids.json');
  const ids = n => Object.fromEntries(Array.from({ length: n }, (_, k) => [`id-${n}-${k}`, { root: 'MNQ', month: '2026-12' }]));
  fs.writeFileSync(day('2026-06-01'), JSON.stringify({ ids: ids(1500) }));
  fs.writeFileSync(day('2026-06-02'), JSON.stringify({ ids: ids(7) }));
  // Live (no replay clock): never prunes.
  assert.deepStrictEqual(pruneReplayCaches('sim', { FTH_HOME: home }), []);
  assert.ok(fs.existsSync(day('2026-06-01')));
  // The injected delay: while the first prune writes its index, a second one starts (another translator).
  const rename = fs.renameSync;
  let inner = null;
  fs.renameSync = (from, to) => {
    if (inner === null && to === indexFile) inner = pruneReplayCaches('sim', env);
    return rename(from, to);
  };
  // And the index is on disk (its data, then the directory) before any day file goes.
  const fsync = fs.fsyncSync;
  const unlink = fs.unlinkSync;
  const order = [];
  fs.fsyncSync = fd => { order.push('fsync'); return fsync(fd); };
  fs.unlinkSync = file => { if (String(file).includes('contracts-sim.2026')) order.push('unlink'); return unlink(file); };
  const quiet0 = process.stderr.write;
  process.stderr.write = () => true;
  let outer;
  try {
    outer = pruneReplayCaches('sim', env);
  } finally {
    fs.renameSync = rename;
    fs.fsyncSync = fsync;
    fs.unlinkSync = unlink;
    process.stderr.write = quiet0;
  }
  assert.deepStrictEqual(order.slice(0, 3), ['fsync', 'fsync', 'unlink'], order.join(' '));
  assert.deepStrictEqual(inner, [], 'the second prune did nothing');
  assert.deepStrictEqual(outer, [day('2026-06-01'), day('2026-06-02')]);
  assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(indexFile, 'utf8')).ids).length, 1507, 'no id lost');
  assert.ok(!fs.existsSync(`${indexFile}.lock`), 'the lock is released');
  // A lock left by another prune (or a crashed one): nothing is pruned, the lock is not ours to remove, and it
  // says once which file to remove (the inner prune above already said it for this home: a fresh home here).
  fs.writeFileSync(day('2026-06-03'), JSON.stringify({ ids: ids(2) }));
  fs.writeFileSync(`${indexFile}.lock`, '123');
  assert.deepStrictEqual(pruneReplayCaches('sim', env), []);
  assert.ok(fs.existsSync(day('2026-06-03')) && fs.existsSync(`${indexFile}.lock`));
  fs.unlinkSync(`${indexFile}.lock`);
  {
    const other = tmpDir();
    fs.writeFileSync(path.join(other, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'x.js'], replay: true } } }));
    fs.writeFileSync(path.join(other, 'contracts-sim.2026-06-01.json'), JSON.stringify({ ids: ids(3) }));
    const otherLock = path.join(other, 'contracts-sim.ids.json.lock');
    fs.writeFileSync(otherLock, '');
    const saidLock = [];
    const q = process.stderr.write;
    process.stderr.write = m => { saidLock.push(String(m)); return true; };
    try {
      pruneReplayCaches('sim', { ...env, FTH_HOME: other });
      pruneReplayCaches('sim', { ...env, FTH_HOME: other });
    } finally {
      process.stderr.write = q;
    }
    assert.strictEqual(saidLock.length, 1, 'once per process');
    assert.ok(saidLock[0].includes(otherLock) && /remove that file to prune again/.test(saidLock[0]), saidLock[0]);
    // A lock that can't be written after it was made (a full disk): removed at once, nothing pruned.
    fs.unlinkSync(otherLock);
    const writeSync = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => { if (String(data) === String(process.pid)) { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; } return writeSync(fd, data, ...rest); };
    process.stderr.write = () => true;
    try {
      assert.deepStrictEqual(pruneReplayCaches('sim', { ...env, FTH_HOME: other }), []);
    } finally {
      fs.writeSync = writeSync;
      process.stderr.write = q;
    }
    assert.ok(!fs.existsSync(otherLock), 'no stale lock left behind');
    assert.ok(fs.existsSync(path.join(other, 'contracts-sim.2026-06-01.json')));
    assert.deepStrictEqual(pruneReplayCaches('sim', { ...env, FTH_HOME: other }), [path.join(other, 'contracts-sim.2026-06-01.json')], 'and the next prune runs');
  }
  // An index that exists but won't parse: nothing is pruned, and it says so once.
  const saved = fs.readFileSync(indexFile, 'utf8');
  fs.writeFileSync(indexFile, '{"ids": {broken');
  const quiet = process.stderr.write;
  const said = [];
  process.stderr.write = m => { said.push(String(m)); return true; };
  try {
    assert.deepStrictEqual(pruneReplayCaches('sim', env), []);
    assert.deepStrictEqual(pruneReplayCaches('sim', env), []);
  } finally {
    process.stderr.write = quiet;
  }
  assert.ok(fs.existsSync(day('2026-06-03')));
  assert.strictEqual(fs.readFileSync(indexFile, 'utf8'), '{"ids": {broken', 'never overwritten');
  assert.strictEqual(said.filter(m => /not pruning old replay day files: .*can't be read/.test(m)).length, 1);
  fs.writeFileSync(indexFile, saved);
  assert.deepStrictEqual(pruneReplayCaches('sim', env), [day('2026-06-03')]);
  assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(indexFile, 'utf8')).ids).length, 1509);
});

test('the broker client: journalAdd writes a journal entry on the read connection (no order tool, no gate) and returns the broker\'s entry; a reply without one is an error', async () => {
  const reads = [];
  const writes = [];
  const stub = (log, result) => ({ call: async (name, args) => { log.push([name, args]); return result(name, args); }, close: () => {} });
  const client = createAdapter({ mcp: stub(reads, (name, args) => ({ ts: '2026-10-07T14:00:01Z', ...args })), writeMcp: stub(writes, () => ({ success: true })) });
  const entry = { kind: 'plan', contractId: MNQ, accountId: 7, tags: ['setup:trade_lifecycle', 'MNQ'], text: 'trade_lifecycle long 1 MNQ' };
  assert.deepStrictEqual(await client.journalAdd(entry), { ts: '2026-10-07T14:00:01Z', ...entry });
  assert.deepStrictEqual([reads, writes], [[['journal_add', entry]], []]);
  await assert.rejects(() => createAdapter({ mcp: stub([], () => ({ ok: true })) }).journalAdd(entry), /journal_add returned no journal entry/);
});

test('closedBars: a limit over one get_bars call (the multi-timeframe window on a one-minute lane) is paged and covers it, never cut to the cap', async () => {
  const { historyBars } = require('../../scripts/lib/autotrader');
  const now = new Date('2026-10-07T14:00:00Z');
  const minute = 60000;
  const calls = [];
  const mcp = {
    call: async (name, args) => {
      calls.push(args.limit);
      // A continuous one-minute series 60 days back; a call returns the newest bars of its window, at most its limit.
      const t0 = Date.parse(args.startTime);
      const t1 = Math.min(Date.parse(args.endTime), now.getTime() - minute);
      const got = [];
      for (let t = Math.ceil(t0 / minute) * minute; t <= t1; t += minute) got.push({ t: new Date(t).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 1 });
      return { bars: got.slice(-args.limit) };
    },
  };
  const want = historyBars(1);
  assert.ok(want > 20000, `a one-minute lane's window is over the cap (${want})`);
  const got = await createAdapter({ mcp }).closedBars('X', { minutes: 1, limit: want, now });
  assert.strictEqual(got.length, want, 'the whole window');
  assert.strictEqual(got[got.length - 1].t, new Date(now.getTime() - minute).toISOString());
  assert.strictEqual(Date.parse(got[got.length - 1].t) - Date.parse(got[0].t), (want - 1) * minute, 'contiguous');
  assert.ok(calls.length > 1, 'paged');
  // Within one call: one call, as before.
  calls.length = 0;
  assert.strictEqual((await createAdapter({ mcp }).closedBars('X', { minutes: 1, limit: 500, now })).length, 500);
  assert.strictEqual(calls.length, 1);
});

test('the broker client: accountStatus reads the balance and the trading flags from list_accounts (absent flags null); accountToday the snapshot\'s remainingBeforeLimit', async () => {
  const stub = result => ({ call: async name => result(name), close: () => {} });
  const accounts = [{ id: 7, balance: 50000, canTrade: true, mcpTradingAllowed: false }, { id: 8, balance: 1000 }];
  const c = createAdapter({ mcp: stub(name => (name === 'list_accounts' ? accounts : { today: { remainingBeforeLimit: 1500 } })) });
  assert.deepStrictEqual(await c.accountStatus(7), { balance: 50000, canTrade: true, mcpTradingAllowed: false });
  assert.deepStrictEqual(await c.accountStatus(8), { balance: 1000, canTrade: null, mcpTradingAllowed: null });
  await assert.rejects(() => c.accountStatus(9), /account 9 not found/);
  assert.deepStrictEqual(await c.accountToday(7), { remainingBeforeLimit: 1500 });
  assert.deepStrictEqual(await createAdapter({ mcp: stub(() => ({ today: { remainingBeforeLimit: null } })) }).accountToday(7), { remainingBeforeLimit: null });
  assert.deepStrictEqual(await createAdapter({ mcp: stub(() => ({ account: {} })) }).accountToday(7), { remainingBeforeLimit: null });
  await assert.rejects(() => createAdapter({ mcp: stub(() => null) }).accountToday(7), /get_account_snapshot/);
});
