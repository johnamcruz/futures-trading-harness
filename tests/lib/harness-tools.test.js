'use strict';

// The script operations as functions (scripts/lib/harness-tools/): what each
// returns, how it reads the clock, and how a failure keeps the output printed
// before it. The CLIs' byte-for-byte output is tests/scripts/cli-parity.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { FAKE_BROKERS, tmpDir, writeJournal } = require('../helpers');
const cli = require('../../scripts/lib/harness-tools/cli');
const strategies = require('../../scripts/lib/harness-tools/strategies');
const marketSnapshot = require('../../scripts/lib/harness-tools/market-snapshot');
const mtf = require('../../scripts/lib/harness-tools/mtf');
const blackouts = require('../../scripts/lib/harness-tools/blackouts');
const bars = require('../../scripts/lib/harness-tools/bars');
const combine = require('../../scripts/lib/harness-tools/combine');
const lessons = require('../../scripts/lib/harness-tools/lessons');
const reconcile = require('../../scripts/lib/harness-tools/reconcile');
const { OPERATIONS } = require('../../scripts/lib/harness-tools/index');

const ROOT = path.resolve(__dirname, '..', '..');
const CSV = path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv');
const AT = new Date('2026-04-28T14:15:30Z');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');

/** A clock that counts its calls. */
function clock(at = AT) {
  const f = () => { f.calls += 1; return new Date(at.getTime()); };
  f.calls = 0;
  return f;
}

test('cli: context defaults, options, and an OpError keeps the output before the failure', async () => {
  const c = cli.context({ env: { FTH_REPLAY_NOW: 'tomorrow', FTH_HOME: tmpDir() } });
  assert.strictEqual(c.root, ROOT);
  assert.throws(() => c.now(), /not an ISO 8601 UTC time/, 'the default clock is harnessNow(env), refused as it refuses');
  assert.deepStrictEqual(cli.options(['a', '--x=1', '--y', '2', '--b'], ['--x', '--y'], ['--b']), { _: ['a'], '--x': '1', '--y': '2', '--b': true });
  assert.throws(() => cli.options(['--b=1'], [], ['--b']), /unknown argument: --b=1/);
  assert.throws(() => cli.withText('so far\n', () => { throw new Error('then this'); }), e => e instanceof cli.OpError && e.text === 'so far\n' && e.message === 'then this');
  await assert.rejects(cli.withTextAsync('a\n', async () => { throw new cli.OpError('b', 'c\n'); }), e => e.text === 'a\nc\n');
  const sink = () => { const s = { data: '', write: x => { s.data += x; } }; return s; };
  for (const [fn, want] of [
    [() => ({ text: 'out\n', stderr: 'note\n', code: 1 }), ['out\n', 'note\n', 1]],
    [async () => ({ text: 'async\n' }), ['async\n', '', 0]],
    [() => { throw new cli.OpError('refused', 'printed\n'); }, ['printed\n', '[t] refused\n', 1]],
    [async () => { throw new Error('plain'); }, ['', '[t] plain\n', 1]],
  ]) {
    const stdout = sink();
    const stderr = sink();
    const proc = {};
    await cli.runCli('t', fn, { stdout, stderr, proc });
    assert.deepStrictEqual([stdout.data, stderr.data, proc.exitCode], want);
  }
});

test('strategies: list, show, validate, scan, recent as operations', () => {
  const ctx = { env: {}, now: clock() };
  const rows = JSON.parse(strategies.list({ json: true }, ctx).text);
  assert.ok(rows.some(r => r.name === 'orb'));
  assert.match(strategies.list({}, ctx).text, /^orb +active/m);
  assert.match(strategies.show({ name: 'orb' }, ctx).text, /^---\nname: orb/);
  assert.throws(() => strategies.show({ name: 'nope' }, ctx), /unknown strategy "nope"/);
  assert.strictEqual(strategies.validate({}, ctx).code, 0);
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'STRATEGY.md'), '---\nname: broken\n---\n');
  const bad = strategies.validate({}, { env: { FTH_STRATEGIES_DIRS: dir } });
  assert.strictEqual(bad.code, 1);
  assert.match(bad.text, /FAIL broken/);
  // scan reads the clock even with an explicit time (a refused clock refuses it), and scans at that time.
  const now = clock(new Date('2020-01-01T00:00:00Z'));
  const at = JSON.parse(strategies.scan({ file: CSV, symbol: 'MNQ', now: AT.toISOString() }, { env: {}, now }).text);
  assert.strictEqual(now.calls, 1);
  const byClock = JSON.parse(strategies.scan({ file: CSV, symbol: 'MNQ' }, ctx).text);
  assert.deepStrictEqual(at, byClock);
  assert.throws(() => strategies.scan({ file: CSV }, { env: {}, now: () => { throw new Error('clock refused'); } }), /clock refused/);
  assert.throws(() => strategies.scan({}, ctx), /scan needs a bars file/);
  assert.throws(() => strategies.scan({ file: CSV, now: 'bogus' }, ctx), /--now: not a time \(bogus\)/);
  // record: the scan printed, then the refusal.
  assert.throws(() => strategies.scan({ file: CSV, record: true }, ctx), e => e instanceof cli.OpError && /--record needs --symbol/.test(e.message) && e.text.startsWith('[\n'));
  // In an autonomous run record is ignored, not refused: the scan comes back with a note, and nothing is recorded.
  const autoHome = tmpDir();
  const auto = strategies.scan({ file: CSV, symbol: 'MNQ', record: true }, { env: { FTH_HOME: autoHome, FTH_AUTONOMOUS: '1', FTH_SYMBOLS: 'MNQ' }, now: clock() });
  assert.deepStrictEqual(JSON.parse(auto.text), byClock);
  assert.strictEqual(auto.stderr, '[strategies] note: --record ignored - the autonomous runner records every bar itself\n');
  assert.strictEqual(auto.code, undefined);
  assert.deepStrictEqual(fs.readdirSync(autoHome), [], 'nothing recorded');
  const home = tmpDir();
  const rec = strategies.scan({ file: CSV, symbol: 'MNQ', record: true }, { env: { FTH_HOME: home }, now: clock() });
  assert.match(rec.stderr, /recorded for the order gate: .*MNQ-3m\.json/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'signals', 'MNQ-3m.json'), 'utf8')).recordedAt, AT.toISOString());
  // The record's file is named after the symbol: a contract root only, nothing that climbs out of signals/.
  const esc = tmpDir();
  const escHome = path.join(esc, 'a', 'home');
  for (const symbol of ['../../x', 'MNQ/..', 'a b', '.']) {
    assert.throws(() => strategies.scan({ file: CSV, symbol, record: true }, { env: { FTH_HOME: escHome }, now: clock() }), e => e instanceof cli.OpError && /^--record needs --symbol <ROOT>: a contract root/.test(e.message), symbol);
  }
  assert.deepStrictEqual(fs.readdirSync(esc, { recursive: true }), [], 'nothing written');
  assert.match(strategies.scan({ file: CSV, symbol: 'mnq', record: true }, { env: { FTH_HOME: home }, now: clock() }).stderr, /MNQ-3m\.json/, 'a lowercase root still records');
  assert.strictEqual(JSON.parse(strategies.recent({ file: CSV, symbol: 'MNQ', count: 3 }, ctx).text).length, 3);
  assert.strictEqual(JSON.parse(strategies.recent({ file: CSV, symbol: 'MNQ', count: '2' }, ctx).text).length, 2, 'a CLI string count');
  for (const count of [0, 51, 2.5, 'x']) assert.throws(() => strategies.recent({ file: CSV, count }, ctx), /--bars: 1 to 50/);
  assert.throws(() => strategies.recent({}, ctx), /recent needs a bars file/);
  // argv parsing.
  assert.deepStrictEqual(strategies.parseArgv(['scan', 'f.csv', '--symbol=MNQ', '--record']), { op: 'scan', args: { file: 'f.csv', symbol: 'MNQ', now: undefined, record: true } });
  assert.throws(() => strategies.parseArgv(['bogus']), /^Error: usage: strategies\.js/);
  assert.throws(() => strategies.parseArgv(['list', '--bogus']), /unknown argument: --bogus/);
});

test('market-snapshot: parameters checked by name and as numbers, in argv order', () => {
  const r = JSON.parse(marketSnapshot.snapshot({ file: CSV, params: { orbMinutes: 15, emaSlow: '30' } }).text);
  assert.strictEqual(r.bars, 1499);
  assert.throws(() => marketSnapshot.snapshot({ file: CSV, params: { bogus: 1 } }), /unknown parameter --bogus/);
  assert.throws(() => marketSnapshot.snapshot({ file: CSV, params: { emaSlow: 'x' } }), /--emaSlow must be a number/);
  assert.throws(() => marketSnapshot.snapshot({}), /usage: market-snapshot\.js/);
  assert.deepStrictEqual(marketSnapshot.parseArgv(['b.json', '--emaSlow', '30', '--orbMinutes=15']), { file: 'b.json', params: { emaSlow: 30, orbMinutes: 15 } });
  assert.throws(() => marketSnapshot.parseArgv(['a', '--bogus=1', 'b']), /unknown parameter --bogus/);
  assert.throws(() => marketSnapshot.parseArgv(['a', 'b', '--bogus=1']), /unexpected argument: b/);
  assert.throws(() => marketSnapshot.parseArgv([]), /usage/);
});

test('mtf: the read, the record at the harness clock, a refused record after the read, and record ignored in autonomous runs', () => {
  assert.match(mtf.mtf({ file: CSV }, { env: {}, now: clock() }).text, /^4h: /);
  assert.ok(JSON.parse(mtf.mtf({ file: CSV, json: true, tf: [15, 60] }, { env: {} }).text).frames.length >= 2);
  const home = tmpDir();
  const now = clock();
  const r = mtf.mtf({ file: CSV, record: true, symbol: 'MNQ' }, { env: { FTH_HOME: home }, now });
  assert.strictEqual(now.calls, 1);
  assert.match(r.stderr, /\[mtf\] recorded for the order gate: .*MNQ\.json/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'mtf', 'MNQ.json'), 'utf8')).recordedAt, AT.toISOString());
  assert.throws(() => mtf.mtf({ file: CSV, record: true, symbol: 'MN Q' }, { env: {}, now: clock() }), e => e instanceof cli.OpError && /--symbol=<ROOT>/.test(e.message) && /^4h: /.test(e.text));
  // Autonomous: the read with a note, nothing recorded (even with no symbol: record is not honoured at all).
  const autoHome = tmpDir();
  const plain = mtf.mtf({ file: CSV }, { env: {}, now: clock() }).text;
  for (const args of [{ symbol: 'MNQ' }, {}, { symbol: 'MN Q' }]) {
    const a = mtf.mtf({ file: CSV, record: true, ...args }, { env: { FTH_HOME: autoHome, FTH_AUTONOMOUS: '1' }, now: clock(), tool: true });
    assert.strictEqual(a.text, plain);
    assert.strictEqual(a.stderr, '[mtf] note: record ignored - the autonomous runner records the read itself\n', 'the tool\'s wording');
  }
  assert.deepStrictEqual(fs.readdirSync(autoHome), [], 'nothing recorded');
  assert.throws(() => mtf.mtf({}, {}), /usage: mtf\.js/);
  assert.deepStrictEqual(mtf.parseArgv(['f', '--symbol', 'MNQ', '--tf=15, 60', '--record']), { tf: [15, 60], daily: null, json: false, file: 'f', record: true, symbol: 'MNQ' });
  assert.throws(() => mtf.parseArgv(['f', 'g']), /unknown argument: g/);
});

test('blackouts: add at the clock\'s time, list, and the window checks', () => {
  const dir = tmpDir();
  const env = { FTH_BLACKOUTS_FILE: path.join(dir, 'b', 'blackouts.json') };
  assert.strictEqual(blackouts.list({}, { env }).text, '[]\n');
  const now = clock(new Date('2026-10-14T10:00:00Z'));
  assert.match(blackouts.add({ start: '2026-10-14T12:20:00Z', end: '2026-10-14T12:40:00Z', reason: 'CPI' }, { env, now }).text, /^blackouts: 1 window\(s\) in /);
  assert.strictEqual(now.calls, 1);
  assert.strictEqual(JSON.parse(blackouts.list({}, { env }).text)[0].reason, 'CPI');
  assert.throws(() => blackouts.add({ start: '2026-10-13T12:20:00Z', end: '2026-10-13T12:40:00Z' }, { env, now }), /already ended/);
  assert.throws(() => blackouts.add({ start: 'x', end: 'y' }, { env, now }), /ISO times/);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'b')), ['blackouts.json'], 'no temp file left');
  // A refused replay clock refuses the list too, by default as the CLI does.
  const live = tmpDir();
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'sim.js'] } } }));
  const refused = { ...env, FTH_HOME: live, FTH_REPLAY_NOW: '2026-10-14T10:00:00Z' };
  assert.throws(() => blackouts.list({}, { env: refused }), /not a replay broker/);
  const reads = clock();
  blackouts.list({}, { env, now: reads });
  assert.strictEqual(reads.calls, 1);
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'blackouts.js'), 'list'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...refused } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /\[blackouts\] .*not a replay broker/);
});

test('combine: status only (start, stop, record-day stay the user\'s, in scripts/combine.js)', () => {
  const home = tmpDir();
  const ctx = { env: { FTH_HOME: home }, now: clock() };
  assert.strictEqual(combine.status({}, ctx).text, 'no attempt is started (node scripts/combine.js start --account <name>)\n');
  assert.deepStrictEqual(JSON.parse(combine.status({ json: true }, ctx).text), { attempts: [], verdicts: [] });
  assert.strictEqual(combine.status({ account: 'topstep_50k' }, ctx).text, 'topstep_50k: no attempt started\n');
  // A name that isn't a profile (a run id, the broker's account) reads every started attempt, and says so.
  assert.match(combine.status({ account: 'nope' }, ctx).text, /^no account profile named nope: every started attempt\n/);
  require('../../scripts/lib/trading/prop-state').startAttempt(home, require('../../scripts/lib/trading/accounts').accountNamed(ROOT, 'topstep_50k', {}), AT);
  assert.match(combine.status({}, ctx).text, /^topstep_50k: active, balance \$50000 .*entries blocked/);
  assert.strictEqual(JSON.parse(combine.status({ json: true }, ctx).text).attempts[0].startedAt, AT.toISOString());
  assert.deepStrictEqual(Object.keys(combine.OPS), ['status']);
  // A live verdict names its stop as the whole bracket the gate requires: ticks and type "stop".
  require('../../scripts/lib/trading/prop-state').appendVerdict(home, { strategy: 'prop_portfolio', component: 'cisd_ote', direction: 'short', action: 'full', maxSize: 2, contract: 'MNQ', stopTicks: 40,
    bar: '2026-04-28T14:12:00.000Z', at: AT.toISOString(), expiresAt: new Date(AT.getTime() + 120000).toISOString() });
  assert.match(combine.status({}, ctx).text, /prop_portfolio: short setup from cisd_ote: full, at most 2 MNQ with a 40-tick stop \(stopLossBracket \{ticks: 40, type: "stop"\}, rationale/);
});

test('lessons and reconcile read the broker\'s journal and the day\'s decision log', () => {
  const home = tmpDir();
  const env = { FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_JOURNAL: path.join(home, 'journal.jsonl') };
  assert.match(lessons.lessons({}, { env }).text, /^No instincts yet/);
  assert.throws(() => lessons.lessons({ top: 0 }, { env }), /--top: a positive whole number/);
  assert.deepStrictEqual(lessons.parseArgv(['--top=3', '--json']), { top: 3, json: true });
  writeJournal(home, [
    { ts: '2026-10-07T14:04:30.000Z', kind: 'order_placed', contractId: 'MNQ', text: 'setup:orb long, stop 21480', data: { result: { success: true } } },
    { ts: '2026-10-07T15:00:00.000Z', kind: 'lesson', text: 'Wait for the retest.', tags: ['setup:orb'] },
  ]);
  assert.strictEqual(JSON.parse(lessons.lessons({ json: true, top: 1 }, { env }).text).length, 1);
  assert.throws(() => reconcile.reconcile({ day: '2026-10-07' }, { env }), /no decision log for 2026-10-07/);
  assert.throws(() => reconcile.reconcile({ day: '10/07' }, { env }), /--day YYYY-MM-DD/);
  assert.throws(() => reconcile.reconcile({ day: '2026-10-07', timeframe: 0 }, { env }), /--timeframe: minutes per bar/);
  fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(path.join(home, 'logs', 'scans-2026-10-07.jsonl'), `${JSON.stringify({ symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00.000Z', c: 1 }, results: [{ name: 'orb', candidate: true, direction: 'long' }] })}\n`);
  assert.match(reconcile.reconcile({ day: '2026-10-07' }, { env }).text, /1 signal\(s\) from the scan, 1 taken \(100%\)/);
  assert.strictEqual(JSON.parse(reconcile.reconcile({ day: '2026-10-07', json: true }, { env }).text).taken, 1);
  assert.deepStrictEqual(reconcile.parseArgv(['--day=2026-10-07', '--timeframe', '5']), { day: '2026-10-07', timeframe: 5, json: false });
});

test('bars: fetch through the broker; only its own arguments reach the file writer', async () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, FAKE] } } }));
  const env = { PATH: process.env.PATH, FTH_HOME: home };
  const scratch = path.join(home, 'bars-scratch');
  const now = clock(new Date('2026-10-07T13:05:30Z'));
  const r = await bars.fetch({ symbol: 'MNQ', timeframe: 1, count: 10, record: true }, { env, now });
  assert.strictEqual(now.calls, 1);
  assert.ok(r.text.startsWith('wrote 6 1-minute bars for MNQ ') && r.text.includes(` to ${path.join(scratch, 'MNQ-1m.json')}; last bar 2026-10-07T13:05:00.000Z`), r.text);
  assert.match(r.text, /\(recorded for the order gate: .*MNQ\.json\)\n$/);
  // The env's home decides where: another home's fetch goes to its own scratch directory.
  const other = tmpDir();
  fs.copyFileSync(path.join(home, 'brokers.json'), path.join(other, 'brokers.json'));
  const r2 = await bars.fetch({ symbol: 'MNQ', timeframe: 1, count: 10, name: 'trend' }, { env: { ...env, FTH_HOME: other }, now });
  assert.ok(r2.text.includes(` to ${path.join(other, 'bars-scratch', 'MNQ-1m-trend.json')};`), r2.text);
  // An output directory in the arguments is ignored: the file still has to be under the home's scratch directory.
  await assert.rejects(bars.fetch({ symbol: 'MNQ', count: 10, out: path.join(home, 'x.json'), outDir: home }, { env, now }), new RegExp(`--out: a \\.json file under ${scratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
  await assert.rejects(bars.fetch({ symbol: 'MNQ', count: 10, out: '/tmp/fth/MNQ-1m.json' }, { env, now }), /--out: a \.json file under .*bars-scratch\/ \(outside it/);
  assert.ok(!fs.existsSync(path.join(home, 'x.json')));
  await assert.rejects(bars.fetch({ symbol: 'MNQ', daily: true, record: true }, { env, now }), /--record reads trigger bars/);
  // Autonomous: the bars are fetched, record is ignored with a note, and no read is recorded (daily too: record is not honoured at all).
  const autoHome = tmpDir();
  fs.copyFileSync(path.join(home, 'brokers.json'), path.join(autoHome, 'brokers.json'));
  const autoEnv = { ...env, FTH_HOME: autoHome, FTH_AUTONOMOUS: '1' };
  const a = await bars.fetch({ symbol: 'MNQ', timeframe: 1, count: 10, record: true }, { env: autoEnv, now });
  assert.ok(a.text.startsWith('wrote 6 1-minute bars for MNQ ') && !/recorded/.test(a.text), a.text);
  assert.strictEqual(a.stderr, '[bars] note: --record ignored - the autonomous runner records the read itself\n');
  const d = await bars.fetch({ symbol: 'MNQ', daily: true, count: 5, record: true }, { env: autoEnv, now, tool: true });
  assert.strictEqual(d.stderr, '[bars] note: record ignored - the autonomous runner records the read itself\n');
  assert.ok(!fs.existsSync(path.join(autoHome, 'mtf')), 'no mtf record');
  assert.ok(fs.existsSync(path.join(home, 'mtf', 'MNQ.json')), 'the same call outside autonomous mode recorded');
  // A broker failure is still a failure, not hidden behind the note.
  await assert.rejects(bars.fetch({ symbol: 'MNQ', record: true }, { env: { PATH: process.env.PATH, FTH_HOME: tmpDir(), FTH_AUTONOMOUS: '1', FTH_BROKER: 'nope' }, now }), e => /^unknown broker "nope"/.test(e.message) && !/note: /.test(e.message));
  assert.deepStrictEqual(bars.parseArgv(['--symbol=mnq', '--timeframe', '5', '--daily', '--out', 'f.json']), { symbol: 'MNQ', timeframe: 5, daily: true, count: null, out: 'f.json', record: false });
});

test('index: one function per agent operation, and none of the user\'s', () => {
  assert.deepStrictEqual(Object.keys(OPERATIONS).sort(), [
    'bar_briefing', 'bars_fetch', 'blackouts_add', 'blackouts_list', 'combine_status', 'lessons', 'market_snapshot', 'mtf', 'order_plan', 'reason_check', 'reconcile',
    'strategies_list', 'strategies_recent', 'strategies_scan', 'strategies_show', 'strategies_validate',
  ]);
  for (const [name, fn] of Object.entries(OPERATIONS)) assert.strictEqual(typeof fn, 'function', name);
  assert.ok(!Object.keys(OPERATIONS).some(n => /start|stop|record_day/.test(n)));
});

test('the bars operations under a replay clock (ctx.replayAt): a bar closing after it refuses the read; at or before it, or live, it reads', () => {
  // The fixture's last bar opened 2026-04-28T04:12 and closed at 04:15.
  const last = Date.parse('2026-04-28T04:15:00Z');
  const ops = [
    ['scan', ctx => strategies.scan({ file: CSV, symbol: 'MNQ' }, ctx)],
    ['recent', ctx => strategies.recent({ file: CSV, symbol: 'MNQ' }, ctx)],
    ['snapshot', ctx => marketSnapshot.snapshot({ file: CSV }, ctx)],
    ['mtf', ctx => mtf.mtf({ file: CSV }, ctx)],
    ['mtf daily', ctx => mtf.mtf({ file: CSV, daily: CSV }, ctx)],
  ];
  for (const [label, run] of ops) {
    const env = { FTH_HOME: tmpDir() };
    const ctx = at => ({ env, now: () => new Date(last + 2000), replayAt: () => at });
    assert.throws(() => run(ctx(new Date(last - 1))), /: 1 bar\(s\) close after the replay clock \(2026-04-28T04:14:59\.999Z\), the first at 2026-04-28T04:15:00\.000Z/, label);
    assert.doesNotThrow(() => run(ctx(new Date(last))), label);
    assert.doesNotThrow(() => run(ctx(null)), `${label} live`);
  }
  // The refusal names the file read; a daily file says so.
  assert.throws(() => mtf.mtf({ file: CSV }, { env: {}, replayAt: () => new Date(last - 1) }), new RegExp(`the bars file ${CSV.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
  const dailyBars = path.join(tmpDir(), 'd.json');
  fs.writeFileSync(dailyBars, JSON.stringify(Array.from({ length: 5 }, (_, k) => ({ t: new Date(Date.parse('2026-04-24T00:00:00Z') + k * 864e5).toISOString(), o: 1, h: 2, l: 0, c: 1 }))));
  assert.throws(() => mtf.mtf({ file: CSV, daily: dailyBars }, { env: {}, replayAt: () => new Date(last) }), /the daily bars file .*d\.json: 1 bar\(s\) close after the replay clock/);
  // The default replayAt is the environment's replay clock: live, none.
  assert.strictEqual(cli.context({ env: {} }).replayAt(), null);
});
