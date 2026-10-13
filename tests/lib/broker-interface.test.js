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
    return JSON.parse(fs.readFileSync(path.join(home, 'contracts-fake.json'), 'utf8')).front.MNQ.day;
  };
  assert.strictEqual(await day({ now: '2026-03-04T15:00:00Z', brokerExtra: { replay: true } }), '2026-03-04');
  // Not a replay broker: the override is refused for checks; lookups go on, on the wall clock.
  assert.notStrictEqual(await day({ now: '2026-03-04T15:00:00Z', brokerExtra: {} }), '2026-03-04');
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
  // A configured replay clock wins; a server that doesn't report replay mode is a warning (and its bars aren't judged).
  const conf = await run({ replay: false, serverTime: wall.toISOString() }, { replayAt: new Date('2026-03-04T15:00:00Z'), bars: [bar('2026-10-13T13:59:00Z')] });
  assert.match(conf.since, /^2026-02-2/);
  assert.deepStrictEqual(conf.r.results.find(x => /configured replay clock/.test(x.check)).problems, ['the server does not report replay mode (get_server_config.replay), yet a replay clock is set']);
  assert.strictEqual(lookAhead(conf.r), undefined);
});
