'use strict';

// The harness-tools MCP server (scripts/harness-tools-mcp.js), spawned for real and driven with
// the harness's own MCP client: the handshake and tool list; each tool's text equal to what the
// matching CLI prints on the parity fixtures (stdout, then its stderr notes; a failure's
// `[script] message`), each side on its own identical fixture home; bars path attacks refused
// without echoing a file; unknown arguments refused; record ignored (with a note, not an error) in autonomous runs; the
// output cap; and the replay clock honored and refused as the CLIs honor and refuse it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, recordBrokerSpecs } = require('../helpers');
const { createMcpClient } = require('../../scripts/lib/broker/mcp-client');
const { TOOLS } = require('../../scripts/lib/harness-tools/registry');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'scripts', 'harness-tools-mcp.js');
const PARITY = path.join(ROOT, 'tests', 'fixtures', 'parity');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
const REPLAY = '2026-10-07T13:05:30Z';
const MARKER = 'PRIVATE-JOURNAL-LINE';
const tag = `fth-test-${process.pid}`;

/** A harness home whose broker is the fake replay broker, with its journal and bars inside. */
function fixtureHome({ replay = true } = {}) {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({
    broker: 'sim', brokers: { sim: { command: [process.execPath, FAKE], replay, journal: path.join(home, 'journal.jsonl') } },
  }));
  fs.mkdirSync(path.join(home, 'bars'), { mode: 0o700 });
  for (const f of ['NQ-3m.csv', 'RTY-3m.csv']) fs.copyFileSync(path.join(PARITY, f), path.join(home, 'bars', f));
  recordBrokerSpecs(home, { broker: 'sim' }); // the broker's tick specs, as the translator records them
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

const { scanSummary, recentLines } = require('../../scripts/lib/harness-tools/compact');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { normalizeBars } = require('../../scripts/lib/trading/indicators');

const lastBar = file => normalizeBars(readBarsArg(file)).at(-1).t;
const oneLine = s => `${JSON.stringify(JSON.parse(s))}\n`;

/**
 * Where a tool's message names its arguments rather than the script's flags, and the tools' compact
 * forms (harness-tools/compact.js): the same result as the script's, made smaller.
 */
const TOOL_WORDING = {
  'strategies list json': oneLine,
  'strategies scan summary': s => scanSummary(JSON.parse(s), { symbol: 'MNQ', bar: lastBar(path.join(PARITY, 'NQ-3m.csv')) }),
  'strategies scan one': s => `${JSON.stringify(JSON.parse(s).find(r => r.name === 'orb'), null, 2)}\n`,
  'strategies recent lines': s => recentLines(JSON.parse(s), { symbol: 'MNQ' }),
  'market snapshot': oneLine,
  'market snapshot params': oneLine,
  'combine status none': () => 'no attempt is started (starting one is the user\'s: combine.js start --account <name>)\n',
  'mtf record no symbol': s => s.replace('--record needs --symbol=<ROOT> (e.g. MNQ)', 'record needs symbol (a contract root, e.g. MNQ)'),
  'bars fetch daily record': s => s.replace('--record reads trigger bars (minutes), not daily bars', 'record reads trigger bars (minutes), not timeframe "daily"'),
};

/** [label, CLI script, CLI args(bars dir), tool, tool arguments(bars dir), before(home)] in order: later cases read earlier state. */
const CASES = [
  ['strategies list', 'strategies.js', () => ['list'], 'strategies_list', () => ({})],
  ['strategies list json', 'strategies.js', () => ['list', '--json'], 'strategies_list', () => ({ json: true })],
  ['strategies show', 'strategies.js', () => ['show', 'orb'], 'strategies_show', () => ({ name: 'orb' })],
  ['strategies show unknown', 'strategies.js', () => ['show', 'nope'], 'strategies_show', () => ({ name: 'nope' })],
  ['strategies validate', 'strategies.js', () => ['validate'], 'strategies_validate', () => ({})],
  ['strategies scan', 'strategies.js', b => ['scan', `${b}/NQ-3m.csv`, '--symbol', 'MNQ'], 'strategies_scan', b => ({ bars: `${b}/NQ-3m.csv`, symbol: 'MNQ', detail: true })],
  ['strategies scan summary', 'strategies.js', b => ['scan', `${b}/NQ-3m.csv`, '--symbol', 'MNQ'], 'strategies_scan', b => ({ bars: `${b}/NQ-3m.csv`, symbol: 'MNQ' })],
  ['strategies scan one', 'strategies.js', b => ['scan', `${b}/NQ-3m.csv`, '--symbol', 'MNQ'], 'strategies_scan', b => ({ bars: `${b}/NQ-3m.csv`, symbol: 'MNQ', name: 'orb' })],
  ['strategies scan record', 'strategies.js', b => ['scan', `${b}/NQ-3m.csv`, '--symbol', 'MNQ', '--record'], 'strategies_scan', b => ({ bars: `${b}/NQ-3m.csv`, symbol: 'MNQ', record: true, detail: true })],
  ['strategies recent', 'strategies.js', b => ['recent', `${b}/NQ-3m.csv`, '--symbol', 'MNQ', '--bars', '3'], 'strategies_recent', b => ({ bars: `${b}/NQ-3m.csv`, symbol: 'MNQ', count: 3, json: true })],
  ['strategies recent lines', 'strategies.js', b => ['recent', `${b}/NQ-3m.csv`, '--symbol', 'MNQ', '--bars', '3'], 'strategies_recent', b => ({ bars: `${b}/NQ-3m.csv`, symbol: 'MNQ', count: 3 })],
  ['strategies recent default', 'strategies.js', b => ['recent', `${b}/RTY-3m.csv`, '--symbol', 'RTY'], 'strategies_recent', b => ({ bars: `${b}/RTY-3m.csv`, symbol: 'RTY', json: true })],
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
  // Bars go to the op's default file in each home's own bars scratch directory (<home>/bars-scratch).
  ['bars fetch record', 'bars.js', () => ['--symbol', 'MNQ', '--timeframe', '7', '--count', '10', '--record'], 'bars_fetch', () => ({ symbol: 'MNQ', timeframe: 7, count: 10, record: true })],
  ['bars fetch named', 'bars.js', bars => ['--symbol', 'MNQ', '--timeframe', '7', '--count', '10', '--out', path.join(path.dirname(bars), 'bars-scratch', 'MNQ-7m-test.json')], 'bars_fetch', () => ({ symbol: 'MNQ', timeframe: 7, count: 10, name: 'test' })],
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
      // The tools name their arguments where the scripts name their flags: otherwise the same text.
      if (TOOL_WORDING[label]) want.text = TOOL_WORDING[label](want.text);
      const got = await call(client, tool, toolArgs(path.join(srvHome, 'bars')));
      assert.ok(want.text.trim().length > 0, `${label}: the CLI printed something`);
      assert.deepStrictEqual({ text: norm(got.text), isError: got.isError }, want, label);
    }
    assert.ok(fs.existsSync(path.join(srvHome, 'signals')) && fs.existsSync(path.join(srvHome, 'mtf', 'MNQ.json')), 'record wrote the gate\'s records');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(srvHome, 'blackouts.json'), 'utf8')).length, 2);
    // Each home's fetches stayed in its own scratch directory.
    for (const h of [cliHome, srvHome]) {
      assert.deepStrictEqual(fs.readdirSync(path.join(h, 'bars-scratch')).sort(), ['MNQ-7m-test.json', 'MNQ-7m.json'], h);
    }
  } finally {
    client.close();
  }
});

test('harness-tools server: bars path attacks are refused without echoing a file; unknown arguments refused', { timeout: 120000 }, async () => {
  const home = fixtureHome();
  fs.writeFileSync(path.join(home, 'journal.jsonl'), `${MARKER}\n`);
  fs.writeFileSync(path.join(home, 'secret.json'), `{"x":"${MARKER}"}`);
  const scratch = path.join(home, 'bars-scratch');
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 }); // as bars_fetch makes it
  const link = path.join(scratch, `${tag}-link.json`);
  const dirLike = path.join(scratch, `${tag}-dir.json`);
  // A bars file in the shared /tmp/fth (where an earlier run, a test, or another home left one): refused by its path alone.
  const shared = '/tmp/fth/MNQ-3m.json';
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
      // A path under the home's real form is the same place (macOS: /var is /private/var); a form that isn't is outside.
      [path.join(fs.realpathSync(home), 'bars-scratch', path.basename(link)), /is a symlink/],
      [`/private${link}`, fs.realpathSync(path.dirname(home)) === `/private${path.dirname(home)}` ? /is a symlink/ : /outside them/],
      [shared, /outside them/],
      [`${scratch}/../secret.json`, /outside them/],
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
  }
});

test('harness-tools server: a symlinked bars directory and the output cap are refused; record in autonomous runs is ignored with a note', { timeout: 120000 }, async () => {
  const home = fixtureHome();
  const linkedDir = path.join(home, 'bars-link');
  fs.symlinkSync(path.join(home, 'bars'), linkedDir);
  const tmpBars = path.join(home, 'bars-scratch', `${tag}-NQ.csv`);
  fs.mkdirSync(path.dirname(tmpBars), { recursive: true, mode: 0o700 }); // as bars_fetch makes it
  fs.copyFileSync(path.join(PARITY, 'NQ-3m.csv'), tmpBars);
  const big = path.join(home, 'more-strategies', 'big');
  fs.mkdirSync(big, { recursive: true });
  fs.writeFileSync(path.join(big, 'STRATEGY.md'), `---\nname: big\n---\n${'x'.repeat(300 * 1024)}\n`);
  const client = server(envFor(home, { FTH_AUTONOMOUS: '1', FTH_SYMBOLS: 'MNQ', FTH_BARS_DIR: linkedDir, FTH_STRATEGIES_DIRS: path.join(home, 'more-strategies') }));
  try {
    const viaLink = await call(client, 'market_snapshot', { bars: path.join(linkedDir, 'NQ-3m.csv') });
    assert.strictEqual(viaLink.isError, true);
    assert.match(viaLink.text, /bars-link is a symlink/);
    for (const [tool, args, why] of [
      ['strategies_scan', { bars: tmpBars, symbol: 'MNQ', record: true }, /\n\[strategies\] note: record ignored - the autonomous runner records every bar itself\n$/],
      ['mtf_read', { bars: tmpBars, symbol: 'MNQ', record: true }, /^Trend rule: [^]*\n\[mtf\] note: record ignored - the autonomous runner records the read itself\n$/m],
      ['bars_fetch', { symbol: 'MNQ', timeframe: 7, record: true }, /^wrote \d+ 7-minute bars for [^]*\n\[bars\] note: record ignored - the autonomous runner records the read itself\n$/],
    ]) {
      const r = await call(client, tool, args);
      assert.strictEqual(r.isError, false, `${tool}: ${r.text}`);
      assert.match(r.text, why, tool);
    }
    assert.ok(!fs.existsSync(path.join(home, 'signals')) && !fs.existsSync(path.join(home, 'mtf')), 'nothing recorded');
    const ok = await call(client, 'strategies_scan', { bars: tmpBars, symbol: 'MNQ' });
    assert.strictEqual(ok.isError, false, 'without record it runs (bars under the home\'s bars scratch directory)');
    const capped = await call(client, 'strategies_show', { name: 'big' });
    assert.strictEqual(capped.isError, true);
    assert.match(capped.text, /strategies_show: the output is 30\d KB, over the 256 KB .* none of it is returned/);
    assert.ok(capped.text.length < 1000, 'never truncated into the reply');
  } finally {
    client.close();
  }
});

test('harness-tools server: bars_fetch writes where the bars tools read, even when a .env file names another FTH_HOME', { timeout: 120000 }, async () => {
  // The server's home comes from HOME (no FTH_HOME); the .env bars_fetch loads names another home (whose broker it uses).
  const user = tmpDir();
  const other = fixtureHome();
  const envFile = path.join(user, 'x.env');
  fs.writeFileSync(envFile, `FTH_HOME=${other}\n`, { mode: 0o600 });
  const client = server(envFor(other, { HOME: user, FTH_HOME: '', FTH_ENV_FILE: envFile }));
  try {
    const fetched = await call(client, 'bars_fetch', { symbol: 'MNQ', timeframe: 7, count: 10 });
    assert.strictEqual(fetched.isError, false, fetched.text);
    const file = path.join(user, '.futures-trading-harness', 'bars-scratch', 'MNQ-7m.json');
    assert.ok(fetched.text.includes(` to ${file};`), fetched.text);
    assert.ok(!fs.existsSync(path.join(other, 'bars-scratch')), 'nothing in the .env file\'s home');
    const read = await call(client, 'market_snapshot', { bars: file });
    assert.strictEqual(read.isError, false, read.text);
  } finally {
    client.close();
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

/** Resolves with fn's result, or rejects after ms (a protocol regression fails fast instead of hanging CI). */
const within = (ms, what, promise) => {
  let timer;
  return Promise.race([promise, new Promise((_r, reject) => { timer = setTimeout(() => reject(new Error(`${what}: nothing after ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(timer));
};

test('harness-tools server: a line over 1 MB is refused and the next request still answered', { timeout: 60000 }, async () => {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [SERVER], { env: envFor(fixtureHome()), stdio: ['pipe', 'pipe', 'pipe'] });
  try {
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
    await within(20000, 'two replies', done);
    assert.deepStrictEqual(replies[0], { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: a line over 1 MB is refused' } });
    assert.deepStrictEqual(replies[1], { jsonrpc: '2.0', id: 2, result: {} });
  } finally {
    child.stdin.end();
    child.kill();
  }
});

test('harness-tools server: when its client goes away (stdout closed), it exits cleanly', { timeout: 60000 }, async () => {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [SERVER], { env: envFor(fixtureHome()), stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    child.stdin.on('error', () => {}); // the server may be gone before our writes drain
    child.stdout.destroy(); // the reading end: the server's next write fails with EPIPE
    for (let i = 1; i <= 5; i += 1) child.stdin.write(`{"jsonrpc":"2.0","id":${i},"method":"tools/list"}\n`);
    assert.deepStrictEqual(await within(20000, 'the server to exit', exited), { code: 0, signal: null });
  } finally {
    child.kill();
  }
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
  assert.match(got.err, /14 tools ready/);
});
