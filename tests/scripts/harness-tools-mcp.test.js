'use strict';

// The harness-tools MCP server (scripts/harness-tools-mcp.js), spawned for real and driven with
// the harness's own MCP client: the handshake and tool list; each tool's text equal to what the
// matching CLI prints on the parity fixtures (stdout, then its stderr notes; a failure's
// `[script] message`), each side on its own identical fixture home; bars path attacks refused
// without echoing a file; unknown arguments refused; record refused in autonomous runs; the
// output cap; and the replay clock honored and refused as the CLIs honor and refuse it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const { createMcpClient } = require('../../scripts/lib/broker/mcp-client');
const { TOOLS } = require('../../scripts/lib/harness-tools/registry');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'scripts', 'harness-tools-mcp.js');
const PARITY = path.join(ROOT, 'tests', 'fixtures', 'parity');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
const REPLAY = '2026-10-07T13:05:30Z';
const MARKER = 'PRIVATE-JOURNAL-LINE';
const TMP_FTH = '/tmp/fth';
const tag = `fth-test-${process.pid}`;

/** A harness home whose broker is the fake replay broker, with its journal and bars inside. */
function fixtureHome({ replay = true } = {}) {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({
    broker: 'sim', brokers: { sim: { command: [process.execPath, FAKE], replay, journal: path.join(home, 'journal.jsonl') } },
  }));
  fs.mkdirSync(path.join(home, 'bars'), { mode: 0o700 });
  for (const f of ['NQ-3m.csv', 'RTY-3m.csv']) fs.copyFileSync(path.join(PARITY, f), path.join(home, 'bars', f));
  return home;
}

const envFor = (home, extra = {}) => ({
  PATH: process.env.PATH, HOME: home, FTH_HOME: home, FTH_REPLAY_NOW: REPLAY, FTH_AUTONOMOUS: '',
  FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'), FTH_ENV_FILE: path.join(home, 'none.env'), ...extra,
});

const server = env => createMcpClient({ command: process.execPath, args: [SERVER], env, timeoutMs: 60000, clientName: 'harness-test' });
const call = async (client, name, args) => {
  const r = await client.request('tools/call', { name, arguments: args });
  return { text: r.content[0].text, isError: r.isError === true };
};

function normalizer(home) {
  const real = fs.realpathSync(home);
  return s => s.split(real).join('<home>').split(home).join('<home>')
    .split('\n').filter(l => !/^\[(bars|harness)\] (loaded|warning)/.test(l)).join('\n');
}

function runCli(home, script, args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8', env: envFor(home), timeout: 60000 });
  const norm = normalizer(home);
  return { text: norm(r.stdout + r.stderr), isError: r.status !== 0 };
}

const day = '2026-10-07';
const scans = [
  { symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00.000Z', c: 1 }, results: [{ name: 'orb', candidate: true, direction: 'long' }] },
  { symbol: 'MNQ', bar: { t: '2026-10-07T15:00:00.000Z', c: 1 }, results: [{ name: 'ema_cross', candidate: true, direction: 'short' }] },
];
let hour = Date.parse('2026-10-01T14:00:00Z');
const review = (result, tags) => ({ ts: new Date((hour += 3600000)).toISOString(), kind: 'review', text: '', tags: [`result:${result}`, ...tags] });
const journal = [
  ...Array.from({ length: 4 }, (_, i) => review(i < 3 ? 'win' : 'loss', ['setup:orb', 'regime:trend-up', `r:${i < 3 ? 1.5 : -1}`])),
  ...Array.from({ length: 3 }, () => review('loss', ['setup:keltner', 'regime:range', 'mistake:chased-entry', 'r:-1'])),
  { ts: '2026-10-07T14:04:30.000Z', kind: 'order_placed', contractId: 'MNQ', text: 'setup:orb long, stop 21480', data: { result: { success: true } } },
];

/** [label, CLI script, CLI args(bars dir), tool, tool arguments(bars dir), before(home)] in order: later cases read earlier state. */
const CASES = [
  ['strategies list', 'strategies.js', () => ['list'], 'strategies_list', () => ({})],
  ['strategies list json', 'strategies.js', () => ['list', '--json'], 'strategies_list', () => ({ json: true })],
  ['strategies show', 'strategies.js', () => ['show', 'orb'], 'strategies_show', () => ({ name: 'orb' })],
  ['strategies show unknown', 'strategies.js', () => ['show', 'nope'], 'strategies_show', () => ({ name: 'nope' })],
  ['strategies validate', 'strategies.js', () => ['validate'], 'strategies_validate', () => ({})],
  ['strategies scan', 'strategies.js', b => ['scan', `${b}/NQ-3m.csv`, '--symbol', 'MNQ'], 'strategies_scan', b => ({ bars: `${b}/NQ-3m.csv`, symbol: 'MNQ' })],
  ['strategies scan record', 'strategies.js', b => ['scan', `${b}/NQ-3m.csv`, '--symbol', 'MNQ', '--record'], 'strategies_scan', b => ({ bars: `${b}/NQ-3m.csv`, symbol: 'MNQ', record: true })],
  ['strategies recent', 'strategies.js', b => ['recent', `${b}/NQ-3m.csv`, '--symbol', 'MNQ', '--bars', '3'], 'strategies_recent', b => ({ bars: `${b}/NQ-3m.csv`, symbol: 'MNQ', count: 3 })],
  ['strategies recent default', 'strategies.js', b => ['recent', `${b}/RTY-3m.csv`, '--symbol', 'RTY'], 'strategies_recent', b => ({ bars: `${b}/RTY-3m.csv`, symbol: 'RTY' })],
  ['market snapshot', 'market-snapshot.js', b => [`${b}/NQ-3m.csv`], 'market_snapshot', b => ({ bars: `${b}/NQ-3m.csv` })],
  ['market snapshot params', 'market-snapshot.js', b => [`${b}/NQ-3m.csv`, '--orbMinutes=15', '--emaSlow', '30'], 'market_snapshot', b => ({ bars: `${b}/NQ-3m.csv`, params: { orbMinutes: 15, emaSlow: 30 } })],
  ['mtf', 'mtf.js', b => [`${b}/NQ-3m.csv`], 'mtf_read', b => ({ bars: `${b}/NQ-3m.csv` })],
  ['mtf json', 'mtf.js', b => [`${b}/NQ-3m.csv`, '--json'], 'mtf_read', b => ({ bars: `${b}/NQ-3m.csv`, json: true })],
  ['mtf timeframes', 'mtf.js', b => [`${b}/NQ-3m.csv`, '--tf=15,60'], 'mtf_read', b => ({ bars: `${b}/NQ-3m.csv`, timeframes: [15, 60] })],
  ['mtf daily', 'mtf.js', b => [`${b}/NQ-3m.csv`, `--daily=${b}/RTY-3m.csv`], 'mtf_read', b => ({ bars: `${b}/NQ-3m.csv`, daily: `${b}/RTY-3m.csv` })],
  ['mtf record', 'mtf.js', b => [`${b}/NQ-3m.csv`, '--record', '--symbol', 'MNQ'], 'mtf_read', b => ({ bars: `${b}/NQ-3m.csv`, record: true, symbol: 'MNQ' })],
  ['mtf record no symbol', 'mtf.js', b => [`${b}/NQ-3m.csv`, '--record'], 'mtf_read', b => ({ bars: `${b}/NQ-3m.csv`, record: true })],
  ['blackouts list empty', 'blackouts.js', () => ['list'], 'blackouts_list', () => ({})],
  ['blackouts add', 'blackouts.js', () => ['add', '--start', '2026-10-07T14:25:00Z', '--end', '2026-10-07T14:40:00Z', '--reason', 'CPI'], 'blackouts_add', () => ({ start: '2026-10-07T14:25:00Z', end: '2026-10-07T14:40:00Z', reason: 'CPI' })],
  ['blackouts add again', 'blackouts.js', () => ['add', '--start', '2026-10-07T18:00:00Z', '--end', '2026-10-07T18:30:00Z', '--reason', 'FOMC'], 'blackouts_add', () => ({ start: '2026-10-07T18:00:00Z', end: '2026-10-07T18:30:00Z', reason: 'FOMC' })],
  ['blackouts list', 'blackouts.js', () => ['list'], 'blackouts_list', () => ({})],
  ['blackouts add ended', 'blackouts.js', () => ['add', '--start', '2026-10-06T12:00:00Z', '--end', '2026-10-06T12:30:00Z', '--reason', 'old'], 'blackouts_add', () => ({ start: '2026-10-06T12:00:00Z', end: '2026-10-06T12:30:00Z', reason: 'old' })],
  ['combine status none', 'combine.js', () => ['status'], 'combine_status', () => ({})],
  ['combine status json none', 'combine.js', () => ['status', '--json'], 'combine_status', () => ({ json: true })],
  ['combine status', 'combine.js', () => ['status'], 'combine_status', () => ({}), home => runCli(home, 'combine.js', ['start', '--account', 'topstep_50k'])],
  ['combine status json', 'combine.js', () => ['status', '--json'], 'combine_status', () => ({ json: true })],
  ['combine status account', 'combine.js', () => ['status', '--account', 'topstep_100k'], 'combine_status', () => ({ account: 'topstep_100k' })],
  ['combine status unknown account', 'combine.js', () => ['status', '--account', 'nope'], 'combine_status', () => ({ account: 'nope' })],
  ['lessons empty', 'lessons.js', () => [], 'lessons', () => ({})],
  ['lessons', 'lessons.js', () => [], 'lessons', () => ({}), home => fs.writeFileSync(path.join(home, 'journal.jsonl'), `${journal.map(e => JSON.stringify(e)).join('\n')}\n`)],
  ['lessons top json', 'lessons.js', () => ['--top', '2', '--json'], 'lessons', () => ({ top: 2, json: true })],
  ['reconcile missing log', 'reconcile.js', () => ['--day', day], 'reconcile', () => ({ day })],
  ['reconcile', 'reconcile.js', () => ['--day', day], 'reconcile', () => ({ day }), home => {
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'logs', `scans-${day}.jsonl`), `${scans.map(s => JSON.stringify(s)).join('\n')}\n`);
  }],
  ['reconcile json', 'reconcile.js', () => ['--day', day, '--json'], 'reconcile', () => ({ day, json: true })],
  ['reconcile timeframe', 'reconcile.js', () => ['--day', day, '--timeframe', '60'], 'reconcile', () => ({ day, timeframe: 60 })],
  // Bars go to the op's default /tmp/fth file: an odd timeframe no session uses, removed afterwards.
  ['bars fetch record', 'bars.js', () => ['--symbol', 'MNQ', '--timeframe', '7', '--count', '10', '--record'], 'bars_fetch', () => ({ symbol: 'MNQ', timeframe: 7, count: 10, record: true })],
  ['bars fetch daily record', 'bars.js', () => ['--symbol', 'MNQ', '--daily', '--record'], 'bars_fetch', () => ({ symbol: 'MNQ', timeframe: 'daily', record: true })],
];

test('harness-tools server: handshake, tools, and each tool\'s text equal to the CLI\'s output', { timeout: 300000 }, async () => {
  const cliHome = fixtureHome();
  const srvHome = fixtureHome();
  const client = server(envFor(srvHome));
  const norm = normalizer(srvHome);
  try {
    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.strictEqual(init.serverInfo.name, 'harness');
    assert.strictEqual(init.protocolVersion, '2025-06-18');
    const tools = await client.listTools();
    assert.deepStrictEqual(tools.map(t => t.name), TOOLS.map(t => t.name));
    assert.ok(tools.every(t => t.inputSchema.additionalProperties === false));
    for (const [label, script, cliArgs, tool, toolArgs, before] of CASES) {
      if (before) { before(cliHome); before(srvHome); }
      const want = runCli(cliHome, script, cliArgs(path.join(cliHome, 'bars')));
      const got = await call(client, tool, toolArgs(path.join(srvHome, 'bars')));
      assert.ok(want.text.trim().length > 0, `${label}: the CLI printed something`);
      assert.deepStrictEqual({ text: norm(got.text), isError: got.isError }, want, label);
    }
    assert.ok(fs.existsSync(path.join(srvHome, 'signals')) && fs.existsSync(path.join(srvHome, 'mtf', 'MNQ.json')), 'record wrote the gate\'s records');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(srvHome, 'blackouts.json'), 'utf8')).length, 2);
  } finally {
    client.close();
    fs.rmSync(path.join(TMP_FTH, 'MNQ-7m.json'), { force: true });
  }
});

test('harness-tools server: bars path attacks are refused without echoing a file; unknown arguments refused', { timeout: 120000 }, async () => {
  const home = fixtureHome();
  fs.writeFileSync(path.join(home, 'journal.jsonl'), `${MARKER}\n`);
  fs.writeFileSync(path.join(home, 'secret.json'), `{"x":"${MARKER}"}`);
  fs.mkdirSync(TMP_FTH, { recursive: true, mode: 0o700 }); // as bars_fetch makes it
  const link = path.join(TMP_FTH, `${tag}-link.json`);
  const dirLike = path.join(TMP_FTH, `${tag}-dir.json`);
  const big = path.join(home, 'bars', 'big.csv');
  fs.symlinkSync(path.join(home, 'secret.json'), link);
  fs.mkdirSync(dirLike);
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 50 * 1024 * 1024 + 1);
  fs.writeFileSync(path.join(home, 'bars', 'notes.txt'), MARKER);
  const client = server(envFor(home));
  try {
    const attacks = [
      [`${home}/bars/../secret.json`, /outside them/],
      [`${home}/bars/../journal.jsonl`, /not a bars file type/],
      [path.join(home, 'secret.json'), /outside them/],
      [link, /is a symlink/],
      // macOS: /tmp is /private/tmp, and the real form is the same place; elsewhere /private/tmp/fth is outside.
      [`/private${link}`, process.platform === 'darwin' ? /is a symlink/ : /outside them/],
      [dirLike, /not a regular file/],
      [big, /larger than 50 MB/],
      [path.join(home, 'bars', 'notes.txt'), /not a bars file type/],
      ['secret.json', /not an absolute path/],
      ['-', /not an absolute path/],
    ];
    for (const [bars, why] of attacks) {
      for (const [tool, args] of [['market_snapshot', { bars }], ['strategies_scan', { bars, symbol: 'MNQ' }], ['mtf_read', { bars: path.join(home, 'bars', 'NQ-3m.csv'), daily: bars }]]) {
        const r = await call(client, tool, args);
        assert.strictEqual(r.isError, true, `${tool} ${bars}`);
        assert.match(r.text, why, `${tool} ${bars}`);
        assert.doesNotMatch(r.text, new RegExp(MARKER));
      }
    }
    for (const [tool, args, why] of [
      ['strategies_scan', { bars: path.join(home, 'bars', 'NQ-3m.csv'), symbol: 'MNQ', now: '2026-01-01T00:00:00Z' }, /"now": unknown argument/],
      ['bars_fetch', { symbol: 'MNQ', timeframe: 3, out: path.join(home, 'journal.jsonl') }, /"out": unknown argument/],
      ['strategies_show', { name: '../../etc/passwd' }, /name: must match/],
      ['lessons', { env: { FTH_HOME: '/' } }, /"env": unknown argument/],
      ['blackouts_list', { cwd: '/' }, /this tool takes none/],
    ]) {
      const r = await call(client, tool, args);
      assert.strictEqual(r.isError, true, tool);
      assert.match(r.text, why, tool);
    }
    await assert.rejects(() => client.request('tools/call', { name: 'place_order', arguments: {} }), /unknown tool/);
    await assert.rejects(() => client.request('resources/list', {}), /method not found/);
  } finally {
    client.close();
    fs.rmSync(link, { force: true });
    fs.rmSync(dirLike, { recursive: true, force: true });
  }
});

test('harness-tools server: a symlinked bars directory, record in autonomous runs, and the output cap are refused', { timeout: 120000 }, async () => {
  const home = fixtureHome();
  const linkedDir = path.join(home, 'bars-link');
  fs.symlinkSync(path.join(home, 'bars'), linkedDir);
  const tmpBars = path.join(TMP_FTH, `${tag}-NQ.csv`);
  fs.mkdirSync(TMP_FTH, { recursive: true, mode: 0o700 }); // as bars_fetch makes it
  fs.copyFileSync(path.join(PARITY, 'NQ-3m.csv'), tmpBars);
  const big = path.join(home, 'more-strategies', 'big');
  fs.mkdirSync(big, { recursive: true });
  fs.writeFileSync(path.join(big, 'STRATEGY.md'), `---\nname: big\n---\n${'x'.repeat(300 * 1024)}\n`);
  const client = server(envFor(home, { FTH_AUTONOMOUS: '1', FTH_BARS_DIR: linkedDir, FTH_STRATEGIES_DIRS: path.join(home, 'more-strategies') }));
  try {
    const viaLink = await call(client, 'market_snapshot', { bars: path.join(linkedDir, 'NQ-3m.csv') });
    assert.strictEqual(viaLink.isError, true);
    assert.match(viaLink.text, /bars-link is a symlink/);
    for (const [tool, args, why] of [
      ['strategies_scan', { bars: tmpBars, symbol: 'MNQ', record: true }, /\[strategies\] --record: the autonomous runner records every bar itself/],
      ['mtf_read', { bars: tmpBars, symbol: 'MNQ', record: true }, /\[mtf\] --record: the autonomous runner records the read itself/],
      ['bars_fetch', { symbol: 'MNQ', timeframe: 7, record: true }, /\[bars\] --record: the autonomous runner records the read itself/],
    ]) {
      const r = await call(client, tool, args);
      assert.strictEqual(r.isError, true, tool);
      assert.match(r.text, why, tool);
    }
    assert.ok(!fs.existsSync(path.join(home, 'signals')) && !fs.existsSync(path.join(home, 'mtf')), 'nothing recorded');
    const ok = await call(client, 'strategies_scan', { bars: tmpBars, symbol: 'MNQ' });
    assert.strictEqual(ok.isError, false, 'without record it runs (bars under /tmp/fth)');
    const capped = await call(client, 'strategies_show', { name: 'big' });
    assert.strictEqual(capped.isError, true);
    assert.match(capped.text, /strategies_show: the output is 30\d KB, over the 256 KB .* none of it is returned/);
    assert.ok(capped.text.length < 1000, 'never truncated into the reply');
  } finally {
    client.close();
    fs.rmSync(tmpBars, { force: true });
  }
});

test('harness-tools server: the replay clock is honored for a replay broker and refused for a live one, as the CLIs do', { timeout: 120000 }, async () => {
  const live = fixtureHome({ replay: false });
  const bars = path.join(live, 'bars', 'NQ-3m.csv');
  const client = server(envFor(live));
  const norm = normalizer(live);
  try {
    for (const [script, cliArgs, tool, args] of [
      ['strategies.js', ['scan', bars, '--symbol', 'MNQ'], 'strategies_scan', { bars, symbol: 'MNQ' }],
      ['combine.js', ['status'], 'combine_status', {}],
      ['blackouts.js', ['list'], 'blackouts_list', {}],
      ['blackouts.js', ['add', '--start', '2026-10-07T14:25:00Z', '--end', '2026-10-07T14:40:00Z', '--reason', 'CPI'], 'blackouts_add', { start: '2026-10-07T14:25:00Z', end: '2026-10-07T14:40:00Z', reason: 'CPI' }],
      ['bars.js', ['--symbol', 'MNQ', '--timeframe', '7'], 'bars_fetch', { symbol: 'MNQ', timeframe: 7 }],
    ]) {
      const got = await call(client, tool, args);
      assert.strictEqual(got.isError, true, tool);
      assert.match(got.text, /not a replay broker/, tool);
      assert.deepStrictEqual({ text: norm(got.text), isError: true }, runCli(live, script, cliArgs), tool);
    }
    assert.ok(!fs.existsSync(path.join(live, 'blackouts.json')), 'nothing written under a refused clock');
    const list = await call(client, 'strategies_list', {});
    assert.strictEqual(list.isError, false, 'tools that read no clock still work, as their CLIs do');
  } finally {
    client.close();
  }
});

test('harness-tools server: a line over 1 MB is refused and the next request still answered', { timeout: 60000 }, async () => {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [SERVER], { env: envFor(fixtureHome()), stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = [];
  let buf = '';
  const done = new Promise(resolve => {
    child.stdout.on('data', c => {
      buf += c;
      const parts = buf.split('\n');
      buf = parts.pop();
      replies.push(...parts.filter(Boolean).map(l => JSON.parse(l)));
      if (replies.length >= 2) resolve();
    });
  });
  // Multibyte: 600 K characters, 1.2 MB.
  child.stdin.write(`{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"${'é'.repeat(600 * 1024)}"}}\n`);
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  await done;
  child.stdin.end();
  child.kill();
  assert.deepStrictEqual(replies[0], { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: a line over 1 MB is refused' } });
  assert.deepStrictEqual(replies[1], { jsonrpc: '2.0', id: 2, result: {} });
});

test('harness-tools server main: only protocol messages reach stdout; anything else printed goes to stderr', async () => {
  const { EventEmitter } = require('events');
  const { main } = require('../../scripts/harness-tools-mcp');
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
  const got = { out: '', err: '' };
  const stdout = { write: s => { got.out += s; return true; } };
  const stderr = { write: s => { got.err += s; return true; } };
  assert.strictEqual(main({ env: { FTH_HOME: tmpDir() }, stdin, stdout, stderr }), 0);
  stdout.write('stray print from an operation\n');
  stdin.emit('data', '{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(got.out, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.match(got.err, /stray print from an operation/);
  assert.match(got.err, /13 tools ready/);
});
