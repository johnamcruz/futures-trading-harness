'use strict';

// The head trader's pre-collected cycle data (scripts/lib/cycle-data.js; the runner config's cycleDataInPrompt, Claude
// Code only): each block's body is exactly what the tool returns to the model at that moment (bar_briefing through the
// harness tool path and the harness MCP server; the broker reads through the adapter and translator against the
// gateway's passthrough, on the mock exchange), a read not made whole gives no block but a line, the blocks go at the
// prompt's end before the result line, and the cycle log records them.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const CD = require('../../scripts/lib/cycle-data');
const B = require('../../scripts/lib/trading/briefing');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { callTool, createServer } = require('../../scripts/lib/harness-tools/protocol');
const { validateConfig, prompts, childEnv, withCycleData, RESULT_LINE } = require('../../scripts/lib/autotrader');
const { runCycle } = require('../../scripts/lib/cycle-run');
const { openAdapter } = require('../../scripts/lib/broker/adapter');
const { createMcpClient } = require('../../scripts/lib/broker/mcp-client');
const { defaultRoundSteps } = require('../../scripts/lib/trading/round-numbers');
const exchange = require('../fixtures/mock-exchange');
const { tmpDir, recordBrokerSpecs } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'));
const SERVER = path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js');
// The head trader's floor (config/runner.json cycle.timeoutMinMinutes); a cycle limit with a minute of reads above it.
const FLOOR = require('../../scripts/lib/tunables').runner().cycle.timeoutMinMinutes * 60000;
const LIMIT = FLOOR + 60000;
const ON = () => validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], cycleDataInPrompt: true });

/** A harness home with this bar's briefing, and the head trader's run's environment for the cycle on `bar` (childEnv). */
function home({ bar = null, n = 1300, extra = {} } = {}) {
  const h = tmpDir();
  const b = B.buildBriefing({ symbol: 'NQ', bars: BARS.slice(0, n), minutes: 3, roundSteps: defaultRoundSteps() });
  B.writeBriefing(h, b);
  const cfg = ON();
  const context = { action: 'trade', symbols: [{ symbol: 'MNQ', bar: { t: bar || b.asOf, contractId: 'MNQ' } }] };
  const env = childEnv(cfg, ROOT, { FTH_HOME: h, HOME: h, NODE_ENV: 'test', FTH_TEST_NOW: b.closedAt, ...extra }, context);
  return { h, b, cfg, env, context };
}

/** The body of the block for `tool` in a prompt: the text between its header line and its footer line. */
function bodyOf(prompt, tool) {
  const m = new RegExp(`\\n--- ${tool} (\\{[^\\n]*\\}) as of [^\\n]+ ---\\n([\\s\\S]*?)\\n--- end of ${tool} \\1 \\(sha256 [0-9a-f]{64}\\) ---\\n`).exec(prompt);
  return m ? m[2] : null;
}

/** What the harness MCP server returns for a tools/call, as the model's client receives it. */
async function serverText(env, name, args) {
  const replies = [];
  const s = createServer({ env, root: ROOT, write: m => replies.push(m) });
  await s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
  await s.idle();
  return replies[0].result;
}

test('on: Claude Code with cycleDataInPrompt true only', () => {
  assert.strictEqual(CD.on(ON()), true);
  assert.strictEqual(CD.on(validateConfig({ harness: 'claude' })), false);
  assert.strictEqual(CD.on(validateConfig({ harness: 'claude', cycleDataInPrompt: false })), false);
  assert.strictEqual(CD.on({ harness: 'opencode', cycleDataInPrompt: true }), false, 'a config validateConfig never passes');
  assert.strictEqual(CD.on(null), false);
});

test('byte identity: the bar_briefing block is exactly the harness tool\'s text, and the harness MCP server\'s, with the run\'s own environment', async () => {
  const w = home();
  const got = await CD.collect({ symbols: ['MNQ'], env: w.env, root: ROOT });
  assert.deepStrictEqual(got.missing, []);
  assert.strictEqual(got.blocks.length, 1);
  const [blk] = got.blocks;
  assert.deepStrictEqual([blk.tool, blk.args, blk.asOf], ['bar_briefing', { symbol: 'MNQ' }, w.b.closedAt]);
  const tool = await callTool('bar_briefing', { symbol: 'MNQ' }, { env: w.env, root: ROOT });
  assert.strictEqual(blk.text, tool.content[0].text);
  const served = await serverText(w.env, 'bar_briefing', { symbol: 'MNQ' });
  assert.strictEqual(served.isError, undefined);
  assert.strictEqual(blk.text, served.content[0].text);
  assert.match(blk.text, /^Bar briefing NQ 3m/);
  // In the prompt: the body between its header and footer is that text, byte for byte.
  const prompt = withCycleData(prompts(w.cfg, new Date(w.b.closedAt), ROOT).trade([{ symbol: 'MNQ', bar: { t: w.b.asOf, c: 1, file: '/b.json', contractId: 'MNQ' } }]), CD.render(got));
  assert.strictEqual(bodyOf(prompt, 'bar_briefing'), served.content[0].text);
  // Stable through the cycle: rendered as of its bar's close, whatever the clock says later in it.
  const later = childEnv(w.cfg, ROOT, { FTH_HOME: w.h, HOME: w.h, NODE_ENV: 'test', FTH_TEST_NOW: new Date(Date.parse(w.b.closedAt) + 170000).toISOString() }, w.context);
  assert.strictEqual((await callTool('bar_briefing', { symbol: 'MNQ' }, { env: later, root: ROOT })).content[0].text, blk.text);
});

test('a stale or missing briefing, or a refused tool: no block, and a line telling the model to read it itself', async () => {
  // Another bar's briefing (the cycle decides a later bar).
  const stale = home({ bar: BARS[1300].t });
  let got = await CD.collect({ symbols: ['MNQ'], env: stale.env, root: ROOT });
  assert.deepStrictEqual(got.blocks, []);
  assert.match(got.missing[0].why, /not this cycle's/);
  const text = CD.render(got);
  assert.match(text, /Not collected: bar_briefing \{"symbol":"MNQ"\} \(the briefing is of the bar opened .*, not this cycle's .*\); read it yourself if you need it\./);
  assert.strictEqual(bodyOf(text, 'bar_briefing'), null);
  // The tool itself agrees: it doesn't serve that briefing as this bar's.
  assert.match((await callTool('bar_briefing', { symbol: 'MNQ' }, { env: stale.env, root: ROOT })).content[0].text, /is old/);
  // No briefing at all (another root), and no cycle bar.
  got = await CD.collect({ symbols: ['MES'], env: stale.env, root: ROOT });
  assert.deepStrictEqual([got.blocks.length, got.missing[0].why], [0, 'no bar briefing']);
  const bare = home();
  const { FTH_CYCLE_BARS: _b, ...noBar } = bare.env;
  got = await CD.collect({ symbols: ['MNQ'], env: noBar, root: ROOT });
  assert.deepStrictEqual([got.blocks.length, got.missing[0].why], [0, 'no cycle bar for it']);
  // A briefing after the replay clock: never served.
  const brokers = path.join(bare.h, 'replay-brokers.json');
  fs.writeFileSync(brokers, JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL' } } }));
  const replay = at => ({ ...bare.env, FTH_BROKERS_FILE: brokers, FTH_REPLAY_NOW: at });
  // At its close the replay clock serves it (the same text as the tool's); a minute before, never.
  got = await CD.collect({ symbols: ['MNQ'], env: replay(bare.b.closedAt), root: ROOT });
  assert.deepStrictEqual([got.blocks.length, got.missing], [1, []], 'a replay clock at the close serves it');
  assert.strictEqual(got.blocks[0].text, (await callTool('bar_briefing', { symbol: 'MNQ' }, { env: replay(bare.b.closedAt), root: ROOT })).content[0].text);
  got = await CD.collect({ symbols: ['MNQ'], env: replay(new Date(Date.parse(bare.b.closedAt) - 60000).toISOString()), root: ROOT });
  assert.deepStrictEqual([got.blocks.length, /after the replay clock/.test(got.missing[0].why)], [0, true]);
  assert.match((await callTool('bar_briefing', { symbol: 'MNQ' }, { env: replay(new Date(Date.parse(bare.b.closedAt) - 60000).toISOString()), root: ROOT })).content[0].text, /not served/);
  // A refused clock (not a time): no block.
  got = await CD.collect({ symbols: ['MNQ'], env: replay('not-a-time'), root: ROOT });
  assert.deepStrictEqual([got.blocks.length, /the clock refused/.test(got.missing[0].why)], [0, true]);
  // The tool's error reply, a reply that isn't one text, a throw, and a briefing rewritten while read: no block.
  for (const make of [
    () => async () => ({ content: [{ type: 'text', text: '[briefing] boom' }], isError: true }),
    () => async () => ({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    () => async () => { throw new Error('down'); },
    // Rewritten while it was read (another bar's briefing in its place): the text read is not the one checked.
    h => async (n, a, o) => { B.writeBriefing(h.h, B.buildBriefing({ symbol: 'NQ', bars: BARS.slice(0, 1301), minutes: 3, roundSteps: defaultRoundSteps() })); return callTool(n, a, o); },
  ]) {
    const h = home();
    const callToolX = make(h);
    got = await CD.collect({ symbols: ['MNQ'], env: h.env, root: ROOT, callTool: callToolX });
    assert.deepStrictEqual(got.blocks, [], callToolX.toString());
    assert.strictEqual(got.missing.length, 1);
    assert.match(CD.render(got), /Not collected: bar_briefing/);
  }
  const moved = home();
  got = await CD.collect({ symbols: ['MNQ'], env: moved.env, root: ROOT, callTool: async (n, a, o) => { B.writeBriefing(moved.h, { ...moved.b, builtAt: 'later' }); return callTool(n, a, o); } });
  assert.deepStrictEqual([got.blocks.length, got.missing[0].why], [0, 'the briefing changed while it was read']);
});

test('the broker reads: none without an account; a client without raw reads, an error reply or a throw: no block, a line', async () => {
  const w = home();
  const none = await CD.collect({ symbols: [], accountId: null, env: w.env, root: ROOT });
  assert.deepStrictEqual(none, { blocks: [], missing: [] });
  assert.strictEqual(CD.render(none), '', 'nothing to say: no section');
  const noRaw = await CD.collect({ accountId: 7, env: w.env, root: ROOT, broker: {} });
  assert.deepStrictEqual(noRaw.missing.map(m => m.tool), CD.READS);
  const broker = { readText: async t => (t === 'get_account_snapshot' ? { text: 'denied', isError: true } : t === 'list_open_positions' ? { text: null, isError: false } : Promise.reject(new Error('gone'))) };
  const got = await CD.collect({ accountId: 7, env: w.env, root: ROOT, broker });
  assert.deepStrictEqual(got.blocks, []);
  assert.deepStrictEqual(got.missing.map(m => [m.tool, m.why]), [['get_account_snapshot', 'the broker answered with an error (denied)'], ['list_open_positions', 'the reply is not one text'], ['list_open_orders', 'the read failed (gone)']]);
  for (const t of CD.READS) assert.match(CD.render(got), new RegExp(`Not collected: ${t} \\{"accountId":7\\} .*; read it yourself if you need it\\.`));
});

test('byte identity: each broker read through the adapter and translator is exactly the gateway\'s passthrough on the mock exchange', async () => {
  const h = tmpDir();
  recordBrokerSpecs(h, { broker: 'mock', roots: ['MNQ', 'NQ', 'MES', 'ES'] });
  const state = path.join(h, 'exchange.json');
  const journal = path.join(h, 'journal.jsonl');
  fs.writeFileSync(journal, '');
  fs.writeFileSync(path.join(h, 'brokers.json'), JSON.stringify({ broker: 'mock', brokers: { mock: { command: [process.execPath, SERVER], journal, allowedAccountsEnv: 'MOCK_ALLOWED_ACCOUNTS' } } }));
  const at = '2026-10-07T14:30:05Z';
  exchange.initState(state, { nowMs: Date.parse(at) });
  exchange.update(state, s => {
    s.positions.push({ id: 1, accountId: 7, contractId: 'fake:MNQ:Z26', creationTimestamp: at, type: 1, size: 2, averagePrice: 27420.25 });
    s.orders.push({ id: 9, accountId: 7, contractId: 'fake:MNQ:Z26', status: 1, type: 4, side: 1, size: 2, stopPrice: 27410.25, creationTimestamp: at });
  });
  const env = { PATH: process.env.PATH, HOME: h, FTH_HOME: h, MOCK_STATE: state, MOCK_JOURNAL: journal, MOCK_ALLOWED_ACCOUNTS: '7', NODE_ENV: 'test', FTH_TEST_NOW: at, FTH_GATE_LOG: path.join(h, 'gate.jsonl'), FTH_KILL_SWITCH_FILE: path.join(h, 'STOP') };
  const adapter = openAdapter({ root: ROOT, env, timeoutMs: 20000 });
  const gw = createMcpClient({ command: process.execPath, args: [path.join(ROOT, 'scripts', 'mcp-gateway.js')], env, cwd: ROOT, timeoutMs: 20000 });
  try {
    const got = await CD.collect({ accountId: 7, env, root: ROOT, broker: adapter, now: () => new Date(at) });
    assert.deepStrictEqual(got.missing, []);
    assert.deepStrictEqual(got.blocks.map(b => b.tool), CD.READS);
    const prompt = withCycleData(`x.${RESULT_LINE}`, CD.render(got));
    for (const b of got.blocks) {
      const raw = await gw.request('tools/call', { name: b.tool, arguments: { accountId: 7 } });
      assert.strictEqual(raw.content.length, 1);
      assert.strictEqual(b.text, raw.content[0].text, b.tool);
      assert.strictEqual(bodyOf(prompt, b.tool), raw.content[0].text, `${b.tool} in the prompt`);
      assert.deepStrictEqual([b.args, b.asOf], [{ accountId: 7 }, new Date(at).toISOString()]);
    }
    // The translator's standard names, as the model sees them through the gateway.
    assert.match(got.blocks[1].text, /"contractId": "MNQ"/);
    // readText reads only: an order tool or a tool outside the interface is never sent.
    await assert.rejects(adapter.readText('place_order', { accountId: 7 }), /not a read of the broker interface/);
    await assert.rejects(adapter.readText('close_position', { accountId: 7 }), /not a read/);
    await assert.rejects(adapter.readText('nope', {}), /not a read/);
    assert.ok(!exchange.read(state).calls.some(c => /^(place_order|modify_order|cancel_order|close_position|partial_close_position)$/.test(c.tool)), 'no order tool reached the server');
  } finally {
    adapter.close();
    gw.close();
  }
});

test('the prompt: the blocks at its end, just before the result line, everything before them the prompt as built', async () => {
  const w = home();
  const items = [{ symbol: 'MNQ', bar: { t: w.b.asOf, c: 1, file: '/b.json', contractId: 'MNQ' } }];
  const plain = prompts(w.cfg, new Date(w.b.closedAt), ROOT).trade(items);
  const got = await CD.collect({ symbols: ['MNQ'], accountId: 7, env: w.env, root: ROOT, broker: { readText: async () => ({ text: '{"ok":true}', isError: false }) }, now: () => new Date(w.b.closedAt) });
  const data = CD.render(got);
  const p = withCycleData(plain, data);
  assert.ok(p.endsWith(`${data}${RESULT_LINE}`));
  assert.strictEqual(p.slice(0, plain.length - RESULT_LINE.length), plain.slice(0, -RESULT_LINE.length), 'the prefix is the prompt as built');
  assert.ok(data.includes(CD.INTRO));
  assert.deepStrictEqual([...p.matchAll(/\n--- ([a-z_]+) \{/g)].map(m => m[1]), ['bar_briefing', ...CD.READS], 'briefing first, then the account');
  // No data: the prompt as it was; a prompt without its result line is refused (the caller gives it unchanged).
  assert.strictEqual(withCycleData(plain, ''), plain);
  assert.throws(() => withCycleData('no result line', data), /does not end with its result line/);
  // The records: one per block, its text's hash and size.
  assert.deepStrictEqual(CD.records(got), got.blocks.map(b => ({ tool: b.tool, args: b.args, asOf: b.asOf, sha256: crypto.createHash('sha256').update(b.text).digest('hex'), chars: b.text.length })));
});

test('cycle run with the reads: made with the run\'s own environment, in the prompt it runs and logs, recorded in the cycle log', async () => {
  const w = home();
  const seen = [];
  const run = async (argv, o) => { seen.push({ argv, env: o.env, timeoutMs: o.timeoutMs }); return { ok: true, timedOut: false, code: 0, output: 'CYCLE RESULT: no-trade - x\n', stdout: 'CYCLE RESULT: no-trade - x\n' }; };
  const prompt = prompts(w.cfg, new Date(w.b.closedAt), ROOT).trade([{ symbol: 'MNQ', bar: { t: w.b.asOf, c: 1, file: '/b.json', contractId: 'MNQ' } }]);
  let envGiven = null;
  let wall = 1000;
  const precollect = async runEnv => { envGiven = runEnv; wall += 4000; return CD.collect({ symbols: ['MNQ'], accountId: 7, env: runEnv, root: ROOT, broker: { readText: async () => ({ text: '[]', isError: false }) }, now: () => new Date(w.b.closedAt) }); };
  const base = { FTH_HOME: w.h, HOME: w.h, NODE_ENV: 'test', FTH_TEST_NOW: w.b.closedAt };
  const deps = { root: ROOT, home: w.h, env: base, run, out: () => {}, err: () => {}, now: () => new Date(w.b.closedAt), wallNow: () => wall, guard: () => true };
  await runCycle(w.cfg, 'trade', prompt, {}, { timeoutMs: LIMIT, context: w.context, precollect }, deps);
  const [{ argv, env, timeoutMs }] = seen;
  assert.strictEqual(envGiven, env, 'the very environment the run gets');
  assert.strictEqual(timeoutMs, LIMIT - 4000, 'the reads\' time comes off the run\'s limit');
  const given = argv[2];
  assert.ok(given.startsWith(prompt.slice(0, -RESULT_LINE.length)) && given.endsWith(RESULT_LINE) && given.length > prompt.length);
  assert.strictEqual(bodyOf(given, 'bar_briefing'), (await callTool('bar_briefing', { symbol: 'MNQ' }, { env, root: ROOT })).content[0].text);
  const summary = JSON.parse(fs.readFileSync(path.join(w.h, 'logs', `cycles-${w.b.closedAt.slice(0, 10)}.jsonl`), 'utf8').trim().split('\n').pop());
  const line = JSON.parse(fs.readFileSync(summary.file, 'utf8'));
  assert.strictEqual(line.prompt, given, 'the cycle log holds the prompt the model got');
  assert.deepStrictEqual(line.context.precollected.map(x => x.tool), ['bar_briefing', ...CD.READS]);
  assert.deepStrictEqual(Object.keys(line.context.precollected[0]).sort(), ['args', 'asOf', 'chars', 'sha256', 'tool']);
  assert.ok(!('notCollected' in line.context));
  // Only the prompt differs from the same cycle without the key: the argv otherwise, and the environment, are the same.
  const plainRun = [];
  const offCfg = validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'] });
  await runCycle(offCfg, 'trade', prompt, {}, { timeoutMs: LIMIT, context: w.context }, { ...deps, run: async (a, o) => { plainRun.push({ argv: a, env: o.env }); return run(a, o); } });
  const strip = e => { const { FTH_CYCLE_TRANSCRIPT: _t, ...rest } = e; return rest; };
  assert.deepStrictEqual(strip(plainRun[0].env), strip(env));
  assert.deepStrictEqual(plainRun[0].argv.map(a => (a === prompt ? '<p>' : a)), argv.map(a => (a === given ? '<p>' : a)));
  // A collection that throws: the run goes on with a line saying so, and nothing recorded as given.
  seen.length = 0;
  await runCycle(w.cfg, 'trade', prompt, {}, { timeoutMs: LIMIT, context: w.context, precollect: async () => { throw new Error('boom'); } }, deps);
  assert.match(seen[0].argv[2], /The runner's reads for this cycle could not be made \(boom\): make your reads yourself\./);
  assert.ok(seen[0].argv[2].endsWith(RESULT_LINE));
  // A prompt without its result line (not a trade prompt): run unchanged, the reason recorded.
  seen.length = 0;
  await runCycle(w.cfg, 'trade', 'odd prompt', {}, { timeoutMs: LIMIT, context: w.context, precollect }, deps);
  assert.strictEqual(seen[0].argv[2], 'odd prompt');
});

test('no gate or check reads the blocks: nothing outside cycle-data.js and the prompt glue names them', () => {
  const files = [];
  const walk = d => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else if (f.endsWith('.js')) files.push(f); } };
  walk(path.join(ROOT, 'scripts'));
  const users = files.filter(f => /cycle-data|precollect|withCycleData/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(ROOT, f)).sort();
  // The desk's (the same key): its wiring (runner-wiring.js), its requests (requests.js renders a role's blocks), and the
  // read-data check (checks.js), which reads the runner's own record for the role (primaryOk), never a block.
  assert.deepStrictEqual(users, ['scripts/lib/autotrader.js', 'scripts/lib/broker/adapter.js', 'scripts/lib/broker/mcp-client.js', 'scripts/lib/cycle-data.js', 'scripts/lib/cycle-run.js', 'scripts/lib/orchestrate/checks.js', 'scripts/lib/orchestrate/requests.js', 'scripts/lib/runner-wiring.js', 'scripts/lib/runner.js']);
  // The check names only the record's primaryOk, never a block's text.
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'scripts/lib/orchestrate/checks.js'), 'utf8'), /\.blocks|\.text\b.*precollected|require\('\.\.\/cycle-data'\)/);
  // The gate's own code never mentions them.
  for (const f of ['scripts/lib/trading/order-gate.js', 'scripts/lib/trading/account-gate.js', 'scripts/lib/trading/check-order.js', 'scripts/mcp-gateway.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /cycle-data|precollect|This cycle's reads/, f);
  }
});

test('callText: the reply\'s text exactly as sent, only when it is one text item; an error reply flagged, never parsed', async () => {
  // A server answering each tool with the content its name asks for.
  const script = `
    const replies = {
      one: { content: [{ type: 'text', text: '  {"a": 1}\\n' }] },
      two: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      image: { content: [{ type: 'image', data: 'x' }] },
      none: { content: [] },
      bad: { content: [{ type: 'text', text: 'refused' }], isError: true },
    };
    let buf = '';
    process.stdin.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\\n')) !== -1) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.id === undefined) continue;
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : replies[m.params.name];
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); } });`;
  const c = createMcpClient({ command: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH }, timeoutMs: 10000 });
  try {
    assert.deepStrictEqual(await c.callText('one'), { text: '  {"a": 1}\n', isError: false }, 'byte for byte, not parsed or trimmed');
    for (const n of ['two', 'image', 'none']) assert.deepStrictEqual(await c.callText(n), { text: null, isError: false }, n);
    assert.deepStrictEqual(await c.callText('bad'), { text: 'refused', isError: true });
  } finally {
    c.close();
  }
});

test('the reads get only the cycle\'s time above the head trader\'s floor: none left, none made; too slow, dropped; the run keeps its floor either way', async () => {
  const w = home();
  const prompt = prompts(w.cfg, new Date(w.b.closedAt), ROOT).trade([{ symbol: 'MNQ', bar: { t: w.b.asOf, c: 1, file: '/b.json', contractId: 'MNQ' } }]);
  const seen = [];
  const run = async (argv, o) => { seen.push({ argv, timeoutMs: o.timeoutMs }); return { ok: true, timedOut: false, code: 0, output: 'CYCLE RESULT: no-trade - x\n', stdout: 'CYCLE RESULT: no-trade - x\n' }; };
  const deps = { root: ROOT, home: w.h, env: { FTH_HOME: w.h, HOME: w.h, NODE_ENV: 'test', FTH_TEST_NOW: w.b.closedAt }, run, out: () => {}, err: () => {}, now: () => new Date(w.b.closedAt), guard: () => true };
  // At or under the floor: no read made, the run gets the whole limit and the line.
  let called = 0;
  const precollect = async env => { called += 1; return CD.collect({ symbols: ['MNQ'], env, root: ROOT }); };
  const r = await runCycle(w.cfg, 'trade', prompt, {}, { timeoutMs: FLOOR, context: w.context, precollect }, deps);
  assert.strictEqual(called, 0);
  assert.strictEqual(r.ok, true, 'an ordinary cycle, never an error');
  assert.strictEqual(seen[0].timeoutMs, FLOOR);
  assert.match(seen[0].argv[2], /The runner made no reads for this cycle \(too little of the cycle's time is left above the \d+ min its run keeps\): make your reads yourself\./);
  assert.strictEqual(bodyOf(seen[0].argv[2], 'bar_briefing'), null);
  // Reads slower than the time above the floor: dropped when it runs out, and the run still gets at least its floor.
  seen.length = 0;
  const slow = () => new Promise(resolve => { setTimeout(() => resolve({ blocks: [{ tool: 'bar_briefing', args: { symbol: 'MNQ' }, asOf: 'x', text: 'LATE' }], missing: [] }), 600); });
  const r2 = await runCycle(w.cfg, 'trade', prompt, {}, { timeoutMs: FLOOR + 150, context: w.context, precollect: slow }, { ...deps, wallNow: Date.now });
  assert.strictEqual(r2.ok, true);
  assert.ok(seen[0].timeoutMs >= FLOOR && seen[0].timeoutMs <= FLOOR + 150, String(seen[0].timeoutMs));
  assert.match(seen[0].argv[2], /could not be made \(the reads took longer than the 0 s the cycle could spare\): make your reads yourself/);
  assert.doesNotMatch(seen[0].argv[2], /LATE/);
});

test('paper mode: no broker read is made for the head trader (its gateway runs under the paper settings, the runner\'s client doesn\'t); each a line', async () => {
  const w = home();
  let reads = 0;
  const got = await CD.collect({ symbols: ['MNQ'], accountId: 7, env: w.env, root: ROOT, broker: { readText: async () => { reads += 1; return { text: '[]', isError: false }; } }, paper: true });
  assert.strictEqual(reads, 0);
  assert.deepStrictEqual(got.blocks.map(b => b.tool), ['bar_briefing'], 'the harness tool still (the run\'s own environment)');
  assert.deepStrictEqual(got.missing.map(m => [m.tool, m.why]), CD.READS.map(t => [t, 'paper mode: the runner reads no account for you']));
  assert.match(CD.render(got), /Not collected: get_account_snapshot \{"accountId":7\} \(paper mode: the runner reads no account for you\); read it yourself if you need it\./);
});

test('the size cap: the section stays under prompt.cycleDataMaxBytes, the largest blocks dropped first, each a line and recorded', async () => {
  assert.ok(Number.isInteger(CD.MAX_BYTES) && CD.MAX_BYTES > 0 && CD.MAX_BYTES < 128 * 1024 / 2, 'well under one argv string\'s limit');
  const blk = (tool, n) => ({ tool, args: { accountId: 7 }, asOf: 'x', text: 'é'.repeat(n) });
  const got = { blocks: [blk('get_account_snapshot', 300), blk('list_open_positions', 2000), blk('list_open_orders', 900)], missing: [] };
  // Room for two blocks and the dropped one's line, not for the third (its 900 characters are 1800 bytes).
  const fits = Buffer.byteLength(CD.render({ ...got, blocks: [got.blocks[0], got.blocks[2]] })) + 300;
  const c = CD.capped(got, fits);
  assert.deepStrictEqual(c.blocks.map(b => b.tool), ['get_account_snapshot', 'list_open_orders'], 'the largest (in bytes) went first');
  assert.match(c.missing[0].why, /^its 4000 bytes would take this cycle's reads past \d+ \(config\/runner\.json prompt\.cycleDataMaxBytes\)$/);
  assert.ok(Buffer.byteLength(CD.render(c)) <= fits);
  assert.strictEqual(CD.capped(got, 10).blocks.length, 0, 'none fits: every block a line');
  // Bytes, as the prompt goes out, never characters: a section a byte over is capped though its characters fit.
  assert.ok(CD.render(got).length < Buffer.byteLength(CD.render(got)) - 1);
  assert.strictEqual(CD.capped(got, Buffer.byteLength(CD.render(got)) - 1).blocks.length, 2);
  assert.deepStrictEqual(CD.capped(got, 1e9), got, 'under the cap: as collected');
  // In the cycle: a block past the config's cap never reaches the prompt; the cycle log says why.
  const w = home();
  const seen = [];
  const run = async argv => { seen.push(argv); return { ok: true, timedOut: false, code: 0, output: 'CYCLE RESULT: no-trade - x\n', stdout: 'CYCLE RESULT: no-trade - x\n' }; };
  const prompt = prompts(w.cfg, new Date(w.b.closedAt), ROOT).trade([{ symbol: 'MNQ', bar: { t: w.b.asOf, c: 1, file: '/b.json', contractId: 'MNQ' } }]);
  const huge = async () => ({ blocks: [blk('get_account_snapshot', CD.MAX_BYTES)], missing: [] });
  await runCycle(w.cfg, 'trade', prompt, {}, { timeoutMs: LIMIT, context: w.context, precollect: huge }, { root: ROOT, home: w.h, env: { FTH_HOME: w.h, HOME: w.h }, run, out: () => {}, err: () => {}, now: () => new Date(w.b.closedAt), guard: () => true });
  assert.ok(Buffer.byteLength(seen[0][2]) < Buffer.byteLength(prompt) + CD.MAX_BYTES);
  assert.match(seen[0][2], /Not collected: get_account_snapshot \{"accountId":7\} \(its \d+ bytes would take/);
  const summary = JSON.parse(fs.readFileSync(path.join(w.h, 'logs', `cycles-${w.b.closedAt.slice(0, 10)}.jsonl`), 'utf8').trim().split('\n').pop());
  const line = JSON.parse(fs.readFileSync(summary.file, 'utf8'));
  assert.deepStrictEqual(line.context.precollected, []);
  assert.match(line.context.notCollected[0].why, /cycleDataMaxBytes/);
});
