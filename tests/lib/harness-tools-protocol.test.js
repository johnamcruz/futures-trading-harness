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
  assert.strictEqual(await code({ jsonrpc: '2.0', id: 'x'.repeat(257), method: 'ping' }), -32600);
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

test('protocol: tool calls run one at a time, in the order they arrived, and answer in that order', async () => {
  const out = [];
  const log = [];
  let running = 0;
  const call = async name => {
    running += 1;
    assert.strictEqual(running, 1, 'never two at once');
    log.push(`start ${name}`);
    await new Promise(r => setTimeout(r, name === 'lessons' ? 30 : 1)); // the first is the slow one
    log.push(`end ${name}`);
    running -= 1;
    return { content: [{ type: 'text', text: name }] };
  };
  const s = createServer({ env: {}, write: m => out.push(m), call });
  s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lessons' } }));
  s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'blackouts_list' } }));
  s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }));
  await s.idle();
  assert.deepStrictEqual(log, ['start lessons', 'end lessons', 'start blackouts_list', 'end blackouts_list']);
  assert.deepStrictEqual(out.filter(m => m.id !== 3).map(m => m.id), [1, 2]);
  // A call that throws still answers, and the next one runs.
  const out2 = [];
  const s2 = createServer({ env: {}, write: m => out2.push(m), call: async name => { if (name === 'lessons') throw new Error('boom'); return { content: [{ type: 'text', text: 'ok' }] }; } });
  s2.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lessons' } }));
  s2.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'blackouts_list' } }));
  await s2.idle();
  assert.deepStrictEqual(out2.map(m => [m.id, m.result.isError === true, m.result.content[0].text]), [[1, true, '[harness] boom\n'], [2, false, 'ok']]);
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

test('callTool: the clock is read first where the CLI reads it first; deep arguments are invalid, not a crash', async () => {
  const home = tmpDir();
  const file = path.join(home, 'blackouts.json');
  fs.writeFileSync(file, '{"not":"a list"}');
  const env = { FTH_HOME: home, FTH_BLACKOUTS_FILE: file, FTH_REPLAY_NOW: 'soon' };
  const r = await callTool('blackouts_add', { start: '2026-10-07T14:25:00Z', end: '2026-10-07T14:40:00Z', reason: 'CPI' }, { env });
  assert.match(r.content[0].text, /^\[blackouts\] FTH_REPLAY_NOW "soon"/, 'the clock refusal, before the malformed file');
  const { FTH_REPLAY_NOW: _drop, ...wall } = env;
  const m = await callTool('blackouts_add', { start: '2999-10-07T14:25:00Z', end: '2999-10-07T14:40:00Z', reason: 'CPI' }, { env: wall });
  assert.match(m.content[0].text, /^\[blackouts\] .*must contain a JSON array/);
  let deep = 3;
  for (let i = 0; i < 200000; i += 1) deep = [deep];
  const d = await callTool('bars_fetch', { symbol: 'MNQ', timeframe: deep }, { env: wall });
  assert.match(d.content[0].text, /^\[harness\] invalid arguments for bars_fetch: timeframe/);
});

test('callTool: numbers and booleans sent as strings are repaired before validation and reach the operation; out of range still refused', async () => {
  const home = tmpDir();
  const auto = { FTH_HOME: home, FTH_AUTONOMOUS: '1' };
  // record "true" reaches bars.js as true (args() reads record === true: the autonomous note says it was asked), and timeframe "3" as minutes.
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, path.join(__dirname, '..', 'fixtures', 'broker-mcp-server.js')] } } }));
  const r = await callTool('bars_fetch', { symbol: 'MNQ', timeframe: '3', count: '10', record: 'true' }, { env: { ...process.env, ...auto, FTH_ENV_FILE: path.join(home, 'none.env'), FTH_REPLAY_NOW: '' } });
  assert.strictEqual(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /^wrote \d+ 3-minute bars for MNQ /);
  assert.match(r.content[0].text, /^\[bars\] note: record ignored - the autonomous runner records the read itself$/m);
  const out = await callTool('bars_fetch', { symbol: 'MNQ', timeframe: '90' }, { env: auto });
  assert.match(out.content[0].text, /^\[harness\] invalid arguments for bars_fetch: timeframe: minutes per bar, 1 to 60, or "daily" \(got 90\)/);
  const frac = await callTool('bars_fetch', { symbol: 'MNQ', timeframe: '1.5' }, { env: auto });
  assert.match(frac.content[0].text, /^\[harness\] invalid arguments for bars_fetch: timeframe: .*\(got "1\.5"\)/);
  const top = await callTool('lessons', { top: '5', json: 'false' }, { env: { FTH_HOME: home, FTH_JOURNAL: path.join(home, 'none.jsonl') } });
  assert.strictEqual(top.isError, undefined);
  assert.match(top.content[0].text, /^No instincts yet/);
});

test('callTool: only bars_fetch loads the user\'s .env (as only bars.js does), into a copy', async () => {
  const home = tmpDir();
  const envFile = path.join(home, 'x.env');
  fs.writeFileSync(envFile, `FTH_REPLAY_NOW=bogus\nFTH_BLACKOUTS_FILE=${path.join(home, 'other.json')}\n`);
  fs.writeFileSync(path.join(home, 'other.json'), '[{"start":"2999-01-01T00:00:00.000Z","end":"2999-01-01T01:00:00.000Z","reason":"other"}]');
  const env = { FTH_HOME: home, FTH_ENV_FILE: envFile, FTH_BLACKOUTS_FILE: path.join(home, 'mine.json') };
  const list = await callTool('blackouts_list', {}, { env });
  assert.strictEqual(list.content[0].text, '[]\n', 'the launch environment, as blackouts.js reads it');
  const fetch = await callTool('bars_fetch', { symbol: 'MNQ', timeframe: 3 }, { env });
  assert.match(fetch.content[0].text, /^\[bars\] FTH_REPLAY_NOW "bogus"/m, 'bars_fetch saw the .env');
  assert.match(fetch.content[0].text, /^\[bars\] warning: .*x\.env can be read by other users; chmod 600 it\n\[bars\] FTH_REPLAY_NOW/, 'with the loader\'s warning, as bars.js prints it');
  fs.chmodSync(envFile, 0o600);
  const quiet = await callTool('bars_fetch', { symbol: 'MNQ', timeframe: 3 }, { env });
  assert.match(quiet.content[0].text, /^\[bars\] FTH_REPLAY_NOW "bogus"/);
  assert.strictEqual(env.FTH_REPLAY_NOW, undefined, 'the launch environment is unchanged');
});

test('callTool: an invalid call names the first ten problems, never thousands', async () => {
  const many = Object.fromEntries(Array.from({ length: 60000 }, (_, i) => [`k${i}`, 1]));
  const r = await callTool('lessons', many, { env: { FTH_HOME: tmpDir() } });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /"k9": unknown argument .*; and 59990 more\n$/);
  assert.ok(r.content[0].text.length < 2000);
  const items = await callTool('mtf_read', { bars: '/h/bars-scratch/a.json', timeframes: Array(150000).fill('x') }, { env: { FTH_HOME: tmpDir() } });
  assert.ok(items.content[0].text.length < 2000);
});

test('callTool: a Parquet or Excel file under the bars directory is refused by every tool that reads bars, without being opened', async () => {
  const home = tmpDir();
  const dir = path.join(home, 'bars');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'), path.join(dir, 'NQ-3m.csv'));
  const env = { FTH_HOME: home };
  for (const ext of ['parquet', 'xlsx', 'xls', 'pq', 'xlsm']) {
    const file = path.join(dir, `b.${ext}`);
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o000); // opening it would fail with EACCES: the refusal must come first
    for (const [tool, args] of [['strategies_scan', { bars: file, symbol: 'MNQ' }], ['strategies_recent', { bars: file, symbol: 'MNQ' }],
      ['market_snapshot', { bars: file }], ['mtf_read', { bars: file }], ['mtf_read', { bars: path.join(dir, 'NQ-3m.csv'), daily: file }]]) {
      const r = await callTool(tool, args, { env });
      assert.strictEqual(r.isError, true, `${tool} ${ext}`);
      assert.match(r.content[0].text, /^\[harness\] (bars|daily): a bars file \(\.json, \.csv, at most 50 MB\).*not a bars file type/, `${tool} ${ext}`);
    }
    fs.chmodSync(file, 0o600);
  }
});

test('callTool: in an autonomous run record is ignored, not an error: the result with a note, and nothing the gate reads is written', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'bars'), { mode: 0o700 });
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'), path.join(home, 'bars', 'NQ-3m.csv'));
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, path.join(__dirname, '..', 'fixtures', 'broker-mcp-server.js')] } } }));
  const bars = path.join(home, 'bars', 'NQ-3m.csv');
  const base = { ...process.env, FTH_HOME: home, FTH_ENV_FILE: path.join(home, 'none.env'), FTH_REPLAY_NOW: '' };
  const auto = { ...base, FTH_AUTONOMOUS: '1' };
  const manual = { ...base, FTH_AUTONOMOUS: '' };
  const cases = [
    ['strategies_scan', { bars, symbol: 'MNQ' }, 'strategies', 'every bar', path.join(home, 'signals', 'MNQ-3m.json')],
    ['mtf_read', { bars, symbol: 'MNQ' }, 'mtf', 'the read', path.join(home, 'mtf', 'MNQ.json')],
    ['bars_fetch', { symbol: 'MNQ', timeframe: 3, count: 10 }, 'bars', 'the read', path.join(home, 'mtf', 'MNQ.json')],
  ];
  for (const [tool, args, tag, what] of cases) {
    const plain = await callTool(tool, args, { env: auto });
    const r = await callTool(tool, { ...args, record: true }, { env: auto });
    assert.strictEqual(r.isError, undefined, `${tool}: ${r.content[0].text}`);
    const note = `[${tag}] note: record ignored - the autonomous runner records ${what} itself\n`;
    assert.ok(r.content[0].text.endsWith(note), `${tool}: ${r.content[0].text}`);
    // The result is the one without record (bars_fetch rewrites its file: the same line), plus the note.
    assert.strictEqual(r.content[0].text, `${plain.content[0].text}${note}`, tool);
    assert.doesNotMatch(r.content[0].text, /recorded for the order gate/, tool);
  }
  assert.ok(!fs.existsSync(path.join(home, 'signals')) && !fs.existsSync(path.join(home, 'mtf')), 'nothing the order gate reads was written');
  // Without the autonomous flag the same calls record, as before.
  for (const [tool, args, , , file] of cases) {
    const r = await callTool(tool, { ...args, record: true }, { env: manual });
    assert.strictEqual(r.isError, undefined, `${tool}: ${r.content[0].text}`);
    assert.match(r.content[0].text, /recorded for the order gate/, tool);
    assert.doesNotMatch(r.content[0].text, /note: record ignored/, tool);
    assert.ok(fs.existsSync(file), `${tool}: ${file}`);
  }
  // A real failure in an autonomous run with record stays an error: the broker's, not a note (an unknown broker).
  const failed = await callTool('bars_fetch', { symbol: 'MNQ', timeframe: 3, record: true }, { env: { ...auto, FTH_BROKER: 'nope' } });
  assert.strictEqual(failed.isError, true);
  assert.match(failed.content[0].text, /^\[bars\] unknown broker "nope"/m);
  assert.doesNotMatch(failed.content[0].text, /note: record ignored/);
});

test('callTool: record is refused while an autonomous runner holds its lock, whatever the server\'s environment', async () => {
  const { spawn } = require('child_process');
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'bars'), { mode: 0o700 });
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'), path.join(home, 'bars', 'NQ-3m.csv'));
  const bars = path.join(home, 'bars', 'NQ-3m.csv');
  const env = { FTH_HOME: home }; // no FTH_AUTONOMOUS: as if a harness hadn't passed it on
  // A stand-in runner: a live process whose command line names the autotrader.
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/x/scripts/autotrader.js'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(home, 'autotrader.lock'), JSON.stringify({ pid: runner.pid, startedAt: new Date().toISOString() }));
    for (const [tool, args, tag] of [['strategies_scan', { bars, symbol: 'MNQ', record: true }, 'strategies'], ['mtf_read', { bars, symbol: 'MNQ', record: true }, 'mtf'], ['bars_fetch', { symbol: 'MNQ', timeframe: 3, record: true }, 'bars']]) {
      const r = await callTool(tool, args, { env });
      assert.strictEqual(r.isError, true, tool);
      assert.match(r.content[0].text, new RegExp(`\\[${tag}\\] record: an autonomous runner is running \\(pid ${runner.pid}\\): it records the reads and signals of the symbols it trades, and record is refused while it runs\\n$`));
    }
    assert.ok(!fs.existsSync(path.join(home, 'signals')) && !fs.existsSync(path.join(home, 'mtf')), 'nothing recorded');
    assert.strictEqual((await callTool('mtf_read', { bars }, { env })).isError, undefined, 'without record it runs');
    // A lock whose pid is another program (a reused pid), or gone, doesn't refuse.
    for (const pid of [process.pid, 2 ** 30]) {
      fs.writeFileSync(path.join(home, 'autotrader.lock'), JSON.stringify({ pid }));
      assert.match((await callTool('mtf_read', { bars, record: true }, { env })).content[0].text, /\[mtf\] record needs symbol \(a contract root/, String(pid));
    }
  } finally {
    runner.kill();
  }
});

test('callTool: refusals name the tool\'s arguments, never the script\'s flags', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'bars'), { mode: 0o700 });
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'), path.join(home, 'bars', 'NQ-3m.csv'));
  const bars = path.join(home, 'bars', 'NQ-3m.csv');
  const auto = { FTH_HOME: home, FTH_AUTONOMOUS: '1' };
  const cases = [
    ['strategies_scan', { bars, symbol: 'MNQ', record: true }, auto, /^\[strategies\] note: record ignored - the autonomous runner records every bar itself$/m],
    ['mtf_read', { bars, symbol: 'MNQ', record: true }, auto, /^\[mtf\] note: record ignored - the autonomous runner records the read itself$/m],
    ['mtf_read', { bars, record: true }, { FTH_HOME: home }, /^\[mtf\] record needs symbol \(a contract root, e.g\. MNQ\)$/m],
    ['bars_fetch', { symbol: 'MNQ', timeframe: 'daily', record: true }, { FTH_HOME: home }, /^\[bars\] record reads trigger bars \(minutes\), not timeframe "daily"$/m],
    // An impossible date that fits the pattern reaches the operation.
    ['blackouts_add', { start: '2999-02-30T10:00:00Z', end: '2999-02-30T09:00:00Z', reason: 'x' }, { FTH_HOME: home, FTH_BLACKOUTS_FILE: path.join(home, 'b.json') }, /^\[blackouts\] start and end must be ISO times with end after start$/m],
  ];
  for (const [tool, args, env, why] of cases) {
    const text = (await callTool(tool, args, { env })).content[0].text;
    assert.match(text, why, tool);
    assert.doesNotMatch(text.split('\n').filter(l => l.startsWith('[')).join('\n'), /--[a-z]/, `${tool}: no script flag in the refusal`);
  }
  // bars_fetch has no output argument: a refused bars file is named as the file, not as --out (refused before the broker is asked).
  const { fetchBarsToFile, outError } = require('../../scripts/lib/bars-fetch');
  const outDir = path.join(home, 'fth');
  fs.mkdirSync(path.join(outDir, 'MNQ-7m-x.json'), { recursive: true, mode: 0o700 });
  fs.chmodSync(outDir, 0o700);
  const broker = { activeContract: async () => assert.fail('the broker is not asked') };
  await assert.rejects(() => fetchBarsToFile({ client: broker, symbol: 'MNQ', timeframe: 7, count: 10, out: path.join(outDir, 'MNQ-7m-x.json'), outDir, tool: true }), /^Error: the bars file: a \.json file under .* \(not a regular file: /);
  assert.match(outError(path.join(outDir, 'MNQ-7m-x.json'), outDir), /^--out: /, 'the script names its flag');
  // Through the tool itself (the operation passes `tool` on): its own file a directory, with the fake broker configured.
  const fakeHome = tmpDir();
  fs.writeFileSync(path.join(fakeHome, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, path.join(__dirname, '..', 'fixtures', 'broker-mcp-server.js')] } } }));
  const mine = path.join(fakeHome, 'bars-scratch', 'MNQ-7m-mine.json');
  fs.mkdirSync(mine, { recursive: true, mode: 0o700 });
  const viaTool = await callTool('bars_fetch', { symbol: 'MNQ', timeframe: 7, count: 10, name: 'mine' }, { env: { ...process.env, FTH_HOME: fakeHome, FTH_ENV_FILE: path.join(fakeHome, 'none.env'), FTH_REPLAY_NOW: '' } });
  assert.strictEqual(viaTool.isError, true);
  assert.ok(viaTool.content[0].text.includes(`[bars] the bars file: a .json file under ${path.join(fakeHome, 'bars-scratch')}/ (not a regular file: `), viaTool.content[0].text);
  // combine_status with no attempt: starting one is the user's (the script's own line stays as it was).
  const none = await callTool('combine_status', {}, { env: { FTH_HOME: home } });
  assert.strictEqual(none.content[0].text, 'no attempt is started (starting one is the user\'s: combine.js start --account <name>)\n');
  // The scripts keep their own wording.
  const mtf = require('../../scripts/lib/harness-tools/mtf');
  assert.throws(() => mtf.mtf({ file: bars, record: true }, { env: { FTH_HOME: home } }), /^Error: --record needs --symbol=<ROOT> \(e\.g\. MNQ\)$/);
});

test('callTool: output over 256 KB is refused whole, with how to narrow it', async () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'strategies', 'big'), { recursive: true });
  fs.writeFileSync(path.join(root, 'strategies', 'big', 'STRATEGY.md'), `---\nname: big\n---\n${'x'.repeat(MAX_OUTPUT_BYTES + 10)}\n`);
  const r = await callTool('strategies_show', { name: 'big' }, { env: { FTH_HOME: tmpDir() }, root });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /output is 25\d KB, over the 256 KB .* none of it is returned/);
  assert.ok(r.content[0].text.length < 1000);
  // Measured JSON-encoded: 200 KB of control characters is 1.2 MB in the reply.
  fs.writeFileSync(path.join(root, 'strategies', 'big', 'STRATEGY.md'), `---\nname: big\n---\n${'\u0001'.repeat(200 * 1024)}\n`);
  const encoded = await callTool('strategies_show', { name: 'big' }, { env: { FTH_HOME: tmpDir() }, root });
  assert.strictEqual(encoded.isError, true);
  assert.match(encoded.content[0].text, /over the 256 KB/);
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
  b.push('012345678\r\n');
  b.push('0123456789\r');
  b.push('\n');
  b.push('tail');
  b.flush();
  b.push('0123456789\r');
  b.flush();
  assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}', '0123456789', '012345678', '0123456789', 'tail', '0123456789']);
  assert.strictEqual(over, 2);
});
