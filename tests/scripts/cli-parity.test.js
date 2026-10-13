'use strict';

// The scripts agents run print exactly what they printed before their logic
// moved to scripts/lib/harness-tools/: stdout, stderr and exit code of each
// CLI, on the parity bars and a fixture harness home, against a snapshot
// captured from the CLIs before the move. Paths are normalized (<home>,
// <root>, <out>); the clock is a replay broker's FTH_REPLAY_NOW, so nothing
// depends on the wall clock.
//
// When an output is meant to change (a strategy edited, a message reworded),
// regenerate deliberately and review the diff:
//   FTH_UPDATE_SNAPSHOTS=1 node --test tests/scripts/cli-parity.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, TEST_ACCOUNTS } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const SNAPSHOT = path.join(__dirname, 'cli-parity.snapshot.json');
const PARITY = path.join(ROOT, 'tests', 'fixtures', 'parity');
const CSV = path.join(PARITY, 'NQ-3m.csv');
const DAILY = path.join(PARITY, 'RTY-3m.csv');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
const REPLAY = '2026-10-07T13:05:30Z';
const OUT = '<out>'; // in the arguments: the fixture home's own bars scratch file (bars files go nowhere else)

/** A harness home whose broker is the fake replay broker, with its journal inside. */
function fixtureHome() {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({
    broker: 'sim', brokers: { sim: { command: [process.execPath, FAKE], replay: true, journal: path.join(home, 'journal.jsonl') } },
  }));
  return home;
}

function stdinBars() {
  // The last 400 bars of the CSV as get_bars JSON (a reply piped to '-').
  const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n');
  const head = lines[0].split(',').map(s => s.trim().toLowerCase());
  const col = n => head.indexOf(n);
  const bars = lines.slice(-400).map(l => l.split(',')).map(c => ({
    t: new Date(c[col('time')] || c[col('timestamp')] || c[0]).toISOString(), o: +c[col('open')], h: +c[col('high')], l: +c[col('low')], c: +c[col('close')], v: +c[col('volume')] || 0,
  }));
  return JSON.stringify({ bars });
}

const day = '2026-10-07';
const scans = [
  { symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00.000Z', c: 1 }, results: [{ name: 'orb', candidate: true, direction: 'long' }, { name: 'bos', candidate: false, direction: 'short' }] },
  { symbol: 'MNQ', bar: { t: '2026-10-07T15:00:00.000Z', c: 1 }, results: [{ name: 'ema_cross', candidate: true, direction: 'short' }] },
];
const placed = (ts, text) => ({ ts, kind: 'order_placed', contractId: 'MNQ', text, data: { result: { success: true } } });
let hour = Date.parse('2026-10-01T14:00:00Z');
const review = (result, tags, text = '') => ({ ts: new Date((hour += 3600000)).toISOString(), kind: 'review', text, tags: [`result:${result}`, ...tags] });
const journal = [
  ...Array.from({ length: 4 }, (_, i) => review(i < 3 ? 'win' : 'loss', ['setup:orb', 'regime:trend-up', `r:${i < 3 ? 1.5 : -1}`])),
  ...Array.from({ length: 3 }, () => review('loss', ['setup:keltner', 'regime:range', 'mistake:chased-entry', 'r:-1'], 'entered late')),
  { ts: '2026-10-05T14:00:00.000Z', kind: 'lesson', text: 'Keltner in range: skip.', tags: ['setup:keltner'] },
  placed('2026-10-07T14:04:30.000Z', 'setup:orb long, stop 21480'),
  { ts: '2026-10-07T15:04:00.000Z', kind: 'note', text: 'ema_cross short passed: relative volume 0.8x (skip rule)' },
  placed('2026-10-07T16:00:00.000Z', 'setup:vwap_reclaim long, stop 21490'),
];

/** [label, script, args, { stdin, before(home) }] in order: some cases build state the later ones read. */
const CASES = [
  ['strategies list', 'strategies.js', ['list']],
  ['strategies list --json', 'strategies.js', ['list', '--json']],
  ['strategies list --bogus', 'strategies.js', ['list', '--bogus']],
  ['strategies show orb', 'strategies.js', ['show', 'orb']],
  ['strategies show unknown', 'strategies.js', ['show', 'nope']],
  ['strategies validate', 'strategies.js', ['validate']],
  ['strategies scan (replay clock)', 'strategies.js', ['scan', CSV, '--symbol', 'MNQ']],
  ['strategies scan --now', 'strategies.js', ['scan', CSV, '--symbol=MNQ', '--now', '2026-04-28T14:15:30Z']],
  ['strategies scan --record', 'strategies.js', ['scan', CSV, '--symbol', 'MNQ', '--record']],
  ['strategies scan --record no symbol', 'strategies.js', ['scan', CSV, '--record']],
  ['strategies scan stdin', 'strategies.js', ['scan', '-', '--symbol', 'MNQ'], { stdin: 'bars' }],
  ['strategies scan bad --now', 'strategies.js', ['scan', CSV, '--now', 'bogus']],
  ['strategies scan no file', 'strategies.js', ['scan']],
  ['strategies scan missing file', 'strategies.js', ['scan', path.join(PARITY, 'missing.csv')]],
  ['strategies recent', 'strategies.js', ['recent', CSV, '--symbol', 'MNQ', '--bars', '3']],
  ['strategies recent default', 'strategies.js', ['recent', DAILY]],
  ['strategies recent bad count', 'strategies.js', ['recent', CSV, '--bars', '99']],
  ['strategies recent no file', 'strategies.js', ['recent']],
  ['strategies usage', 'strategies.js', ['bogus']],
  ['strategies no command', 'strategies.js', []],
  ['market-snapshot', 'market-snapshot.js', [CSV]],
  ['market-snapshot params', 'market-snapshot.js', [CSV, '--orbMinutes=15', '--emaSlow', '30']],
  ['market-snapshot stdin', 'market-snapshot.js', ['-'], { stdin: 'bars' }],
  ['market-snapshot unknown param', 'market-snapshot.js', [CSV, '--bogus=1']],
  ['market-snapshot non-number', 'market-snapshot.js', [CSV, '--emaSlow=x']],
  ['market-snapshot extra arg', 'market-snapshot.js', [CSV, DAILY]],
  ['market-snapshot usage', 'market-snapshot.js', []],
  ['mtf', 'mtf.js', [CSV]],
  ['mtf --json', 'mtf.js', [CSV, '--json']],
  ['mtf --tf', 'mtf.js', [CSV, '--tf=15,60']],
  ['mtf --daily', 'mtf.js', [CSV, `--daily=${DAILY}`]],
  ['mtf stdin', 'mtf.js', ['-'], { stdin: 'bars' }],
  ['mtf --record', 'mtf.js', [CSV, '--record', '--symbol', 'MNQ']],
  ['mtf --record no symbol', 'mtf.js', [CSV, '--record']],
  ['mtf unknown', 'mtf.js', [CSV, '--bogus']],
  ['mtf usage', 'mtf.js', []],
  ['blackouts list empty', 'blackouts.js', ['list']],
  ['blackouts add', 'blackouts.js', ['add', '--start', '2026-10-07T14:25:00Z', '--end', '2026-10-07T14:40:00Z', '--reason', 'CPI']],
  ['blackouts add again', 'blackouts.js', ['add', '--start', '2026-10-07T18:00:00Z', '--end', '2026-10-07T18:30:00Z', '--reason', 'FOMC']],
  ['blackouts list', 'blackouts.js', ['list']],
  ['blackouts add ended', 'blackouts.js', ['add', '--start', '2026-10-06T12:00:00Z', '--end', '2026-10-06T12:30:00Z']],
  ['blackouts add bad', 'blackouts.js', ['add', '--start', 'x']],
  ['blackouts usage', 'blackouts.js', ['remove']],
  ['combine status none', 'combine.js', ['status']],
  ['combine status --json none', 'combine.js', ['status', '--json']],
  ['combine accounts', 'combine.js', ['accounts']],
  ['combine start', 'combine.js', ['start', '--account', 'test_50k']],
  ['combine start again', 'combine.js', ['start', '--account', 'test_50k']],
  ['combine status', 'combine.js', ['status']],
  ['combine status --json', 'combine.js', ['status', '--json']],
  ['combine status --account', 'combine.js', ['status', '--account', 'test_100k']],
  ['combine status unknown account', 'combine.js', ['status', '--account', 'nope']],
  ['combine record-day', 'combine.js', ['record-day', '--account', 'test_50k', '--day', '2026-10-07', '--balance', '50250']],
  ['combine status after day', 'combine.js', ['status', '--account', 'test_50k']],
  ['combine stop', 'combine.js', ['stop', '--account', 'test_50k']],
  ['combine stop again', 'combine.js', ['stop', '--account', 'test_50k']],
  ['combine usage', 'combine.js', ['bogus']],
  ['lessons empty', 'lessons.js', []],
  ['lessons', 'lessons.js', [], { before: home => fs.writeFileSync(path.join(home, 'journal.jsonl'), journal.map(e => JSON.stringify(e)).join('\n') + '\n') }],
  ['lessons --top --json', 'lessons.js', ['--top', '2', '--json']],
  ['lessons --top=1', 'lessons.js', ['--top=1']],
  ['lessons bad top', 'lessons.js', ['--top', '0']],
  ['lessons unknown', 'lessons.js', ['--bogus']],
  ['reconcile missing log', 'reconcile.js', ['--day', day]],
  ['reconcile', 'reconcile.js', ['--day', day], {
    before: home => {
      fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(home, 'logs', `scans-${day}.jsonl`), `${scans.map(s => JSON.stringify(s)).join('\n')}\nnot json\n`);
    },
  }],
  ['reconcile --json', 'reconcile.js', [`--day=${day}`, '--json']],
  ['reconcile --timeframe', 'reconcile.js', ['--day', day, '--timeframe', '60']],
  ['reconcile bad day', 'reconcile.js', ['--day', '10/07']],
  ['reconcile bad timeframe', 'reconcile.js', ['--day', day, '--timeframe', '0']],
  ['reconcile unknown', 'reconcile.js', ['--bogus']],
  ['bars --record', 'bars.js', ['--symbol', 'mnq', '--timeframe', '1', '--count', '10', '--out', OUT, '--record']],
  ['bars --daily', 'bars.js', ['--symbol', 'MNQ', '--daily', '--count', '5', `--out=${OUT}`]],
  ['bars bad request', 'bars.js', ['--symbol', 'MNQ!', '--timeframe', '0', '--count', '1', '--out', OUT]],
  ['bars --record --daily', 'bars.js', ['--symbol', 'MNQ', '--daily', '--record']],
  ['bars unknown', 'bars.js', ['--symbol', 'MNQ', '--bogus']],
];

function runAll() {
  const home = fixtureHome();
  const realHome = fs.realpathSync(home);
  const env = {
    PATH: process.env.PATH, HOME: home, FTH_HOME: home, FTH_REPLAY_NOW: REPLAY, FTH_AUTONOMOUS: '',
    FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'), FTH_ENV_FILE: path.join(home, 'none.env'), FTH_ACCOUNTS_DIRS: TEST_ACCOUNTS,
  };
  const bars = stdinBars();
  const out = path.join(home, 'bars-scratch', 'cli-parity.json');
  const norm = s => s.split(out).join('<out>').split(realHome).join('<home>').split(home).join('<home>').split(ROOT).join('<root>')
    // Where credentials came from depends on the machine (bars.js names the .env files it loaded).
    .split('\n').filter(l => !/^\[bars\] (loaded|warning)/.test(l)).join('\n');
  const results = {};
  try {
    for (const [label, script, args, opts = {}] of CASES) {
      if (opts.before) opts.before(home);
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args.map(a => a.split(OUT).join(out))], {
        cwd: ROOT, encoding: 'utf8', env, input: opts.stdin === 'bars' ? bars : '', timeout: 60000,
      });
      results[label] = { status: r.status, stdout: norm(r.stdout), stderr: norm(r.stderr) };
    }
  } finally {
    fs.rmSync(out, { force: true });
  }
  return results;
}

test('CLI parity: every operation prints what it printed before the move to scripts/lib/harness-tools', { timeout: 300000 }, () => {
  // The same rule as the goldens (tests/golden.js): the snapshot is regenerated on purpose, locally, never by CI.
  const refused = require('../golden').updateRefused();
  if (refused) assert.fail(refused);
  const results = runAll();
  if (process.env.FTH_UPDATE_SNAPSHOTS === '1') {
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  assert.deepStrictEqual(Object.keys(results), Object.keys(expected), 'the same cases');
  for (const label of Object.keys(expected)) assert.deepStrictEqual(results[label], expected[label], label);
});
