'use strict';

// Building the model's risk record from finished practice-train replay runs (scripts/lib/learning/risk-record-build.js,
// scripts/risk-record.js): one entry per day with a risk action, each day's actions reverted alone over paths of the
// run's days through it (nothing after it), fingerprinted with its sources; unfinished, held-out and non-learning runs
// refused, and a day two runs hold.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const B = require('../../scripts/lib/learning/risk-record-build');
const R = require('../../scripts/lib/learning/risk-record-index');
const { readModelStream } = require('../../scripts/lib/prop/model-stream');
const { ACCOUNT, M3, record, multiDayRun } = require('../fixtures/prop-model');
const { TEST_ACCOUNTS } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'risk-record.js');
const NOW = new Date('2023-04-01T00:00:00Z');
const at = (iso, k) => new Date(Date.parse(iso) + k * M3).toISOString();
const fill = (id, t, price, side, pnl, size = 1) => ({ id, contractId: 'MNQ:2023-06', creationTimestamp: t, price, size, side, profitAndLoss: pnl });
const d1 = '2023-03-15T14:00:00.000Z';
const d2 = '2023-03-16T14:00:00.000Z';
const d3 = '2023-03-17T14:00:00.000Z';

// Day 1: a size under the ceiling and an early exit; day 2: a loss, then a stop for the day; day 3: a pass on a fresh day.
const DAYS = [
  {
    day: '2023-03-15', times: [d1, at(d1, 3)], records: [record({ at: d1 })],
    fills: [fill(1, '2023-03-15T14:01:00Z', 100, 0, null), fill(2, '2023-03-15T14:05:00Z', 101, 1, 2)],
    rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 101.25, 100, 101], [101, 101.25, 98.5, 98.75], [98.75, 99, 97.5, 97.75]],
  },
  {
    day: '2023-03-16', times: [d2, at(d2, 3)], records: [record({ at: d2 }), record({ at: at(d2, 3) })],
    fills: [fill(3, '2023-03-16T14:01:00Z', 100, 0, null), fill(4, '2023-03-16T14:04:00Z', 97.75, 1, -4.5)],
    rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 100.5, 97.5, 97.75], [97.75, 98, 97.5, 98], [100.5, 100.75, 99.75, 100], [100, 104.5, 99.5, 104.25]],
  },
  { day: '2023-03-17', times: [d3], records: [record({ at: d3 })], rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 100, 104.25]] },
];

function run(days = DAYS, over = {}) {
  const r = multiDayRun({ days, ...over });
  fs.writeFileSync(path.join(r.home, 'policy-verdicts.jsonl'), `${JSON.stringify({ bar: record({ at: d1 }).bar, direction: 'long', symbol: 'MNQ', action: 'full', maxSize: 4 })}\n`);
  return r;
}
const OPTS = { account: ACCOUNT, paths: 60, reps: 60, seed: 3, now: NOW };

test('dayStream: the days through the day, only that day\'s risk actions kept', () => {
  const { stream } = readModelStream(run().dir);
  assert.deepStrictEqual(B.actedDays(stream), ['2023-03-15', '2023-03-16', '2023-03-17']);
  const s = B.dayStream(stream, '2023-03-16');
  assert.deepStrictEqual(s.days.map(d => d.day), ['2023-03-15', '2023-03-16'], 'no day after it');
  assert.deepStrictEqual(s.days[0].trades.map(t => t.actions), [[]], 'an earlier day\'s actions are not reverted');
  assert.deepStrictEqual(s.days[0].passed, []);
  assert.deepStrictEqual(s.days[1].passed.map(p => p.actions[0]), ['day-stop'], 'the day\'s own kept');
  assert.strictEqual(s.trades.length, 2);
  assert.deepStrictEqual(stream.days[0].trades[0].actions, ['size-down', 'early-exit'], 'the run\'s stream is not changed');
});

test('an exit the runner made (its trail or time stop, from its event log) is the policy\'s, never the model\'s early exit', () => {
  const withEvents = events => {
    const r = run();
    fs.mkdirSync(path.join(r.home, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(r.home, 'logs', 'events-2023-03-15.jsonl'), events.map(e => `${JSON.stringify(e)}\n`).join(''));
    return readModelStream(r.dir).stream.days[0].trades[0];
  };
  // Day 1's entry closed at 101 at 14:05, before its stop and target: the model's own exit when the runner did nothing.
  const own = withEvents([]);
  assert.deepStrictEqual([own.actions, own.exitBy], [['size-down', 'early-exit'], undefined]);
  // The runner closed it (its trail or time stop): the policy's.
  const closed = withEvents([{ at: '2023-03-15T14:04:30.000Z', kind: 'position_closed', symbol: 'MNQ', contractId: 'x', why: 'trail' }]);
  assert.deepStrictEqual([closed.actions, closed.exitBy, closed.hold], [['size-down'], 'runner-close', null]);
  // It filled at the stop the runner last trailed it to: the policy's trail.
  const trailed = withEvents([{ at: '2023-03-15T14:03:00.000Z', kind: 'stop_moved', symbol: 'MNQ', from: 98, to: 101 }]);
  assert.deepStrictEqual([trailed.actions, trailed.exitBy], [['size-down'], 'runner-trail']);
  // The runner moved the stop elsewhere, another market's close, or a close outside the trade: still the model's.
  for (const e of [{ at: '2023-03-15T14:03:00.000Z', kind: 'stop_moved', symbol: 'MNQ', to: 99.5 }, { at: '2023-03-15T14:04:30.000Z', kind: 'position_closed', symbol: 'MES' }, { at: '2023-03-15T14:30:00.000Z', kind: 'position_closed', symbol: 'MNQ' }]) {
    assert.deepStrictEqual(withEvents([e]).actions, ['size-down', 'early-exit'], JSON.stringify(e));
  }
});

test('buildFromRuns: an entry per acted day, the day\'s actions only, walk-forward, fingerprinted with its sources', () => {
  const doc = B.buildFromRuns([run().dir], OPTS);
  assert.deepStrictEqual(doc.entries.map(e => e.day), ['2023-03-15', '2023-03-16', '2023-03-17']);
  assert.ok(doc.entries.every(e => e.role === 'practice-train'));
  assert.deepStrictEqual(Object.keys(doc.entries[0].cells).map(k => k.split('|')[0]).filter((k, i, a) => a.indexOf(k) === i).sort(), ['early-exit', 'size-down']);
  assert.ok(Object.keys(doc.entries[1].cells).every(k => k.startsWith('day-stop|') || k.startsWith('pass|')), JSON.stringify(doc.entries[1].cells));
  assert.ok(Object.keys(doc.entries[2].cells).every(k => k.startsWith('pass|')), JSON.stringify(doc.entries[2].cells));
  assert.deepStrictEqual({ ...doc.sources, runs: doc.sources.runs.map(r => [r.runId, r.acted]) }, { runs: [['run1', 3]], account: ACCOUNT.name, policy: null, seed: 3, paths: 60, reps: 60 });
  // Walk-forward: a day's entry is the same when the run had ended that day (no later day reaches it).
  const first = B.buildFromRuns([run(DAYS.slice(0, 1)).dir], OPTS);
  assert.deepStrictEqual(first.entries[0].cells, doc.entries[0].cells);
  // Fingerprinted: written, read back, hash checked; the sources are in the hash.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-rr-build-'));
  assert.strictEqual(R.readRiskIndex(R.writeRiskIndex(dir, doc)).hash, doc.hash);
  assert.notStrictEqual(B.buildFromRuns([run().dir], { ...OPTS, seed: 4 }).hash, doc.hash, 'another seed, another fingerprint');
  assert.strictEqual(B.buildFromRuns([run().dir], OPTS).hash, doc.hash, 'the same runs and settings, the same fingerprint');
});

test('refused: an unfinished run, a held-out or non-learning run, a day two runs hold, no account', () => {
  const unfinished = run();
  fs.writeFileSync(path.join(unfinished.dir, 'manifest.json'), JSON.stringify({ runId: 'run1', finished: false }));
  assert.throws(() => B.buildFromRuns([unfinished.dir], OPTS), /run run1 is not finished/);
  // The build's own guard (a reader that doesn't check it itself).
  const { stream, run: r } = readModelStream(run().dir);
  assert.throws(() => B.buildFromRuns(['x'], { ...OPTS, readRun: () => ({ stream, run: r, finished: false }) }), /run run1 is not finished: build from finished runs/);
  assert.strictEqual(B.buildFromRuns(['x'], { ...OPTS, readRun: () => ({ stream, run: r, finished: true }) }).days, 3);
  for (const [gate, why] of [
    [{ learning: true, role: 'practice-validate', look: { evaluation: 'e' }, hideOutcomes: false }, /is practice-validate, not practice-train/],
    [{ learning: true, role: 'test', look: { evaluation: 'e' }, hideOutcomes: false }, /is test, not practice-train/],
    [{ learning: false, role: null }, /is not a learning run, not practice-train/],
  ]) assert.throws(() => B.buildFromRuns([run(DAYS, { gate }).dir], OPTS), why);
  assert.throws(() => B.buildFromRuns([run().dir, run(DAYS, { runId: 'run2' }).dir], OPTS), /2023-03-15 twice/);
  // Full-day runs only: a setup-focused or curated run's actions come at practice density (raw curated input refused).
  const practice = { learning: true, role: 'practice-train', look: null, hideOutcomes: false, practice: { mode: 'setup-focus', setupTf: 15 } };
  assert.throws(() => B.buildFromRuns([run(DAYS, { gate: practice }).dir], OPTS), /is a setup-focused practice run: .* full-day practice-train runs only/);
  assert.throws(() => B.buildFromRuns(['x'], { ...OPTS, readRun: () => ({ stream, run: { ...r, curated: true }, finished: true }) }), /is a curated practice run/);
  assert.throws(() => B.buildFromRuns([run().dir], { ...OPTS, account: null }), /an account profile/);
  assert.throws(() => B.buildFromRuns([], OPTS), /one or more finished practice-train runs/);
  assert.throws(() => B.buildFromRuns([run().dir], { ...OPTS, paths: 0 }), /paths and reps/);
});

test('scripts/risk-record.js: builds and shows a fingerprinted record; refuses without an account or on a held-out run', () => {
  const env = { ...process.env, FTH_ACCOUNTS_DIRS: TEST_ACCOUNTS, FTH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'fth-rr-home-')) };
  const cli = args => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-rr-out-'));
  const ok = cli(['build', run().home, '--account', 'test_50k', '--out', out, '--paths', '40', '--reps', '40']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /3 day\(s\) with a risk action from 1 run\(s\) .* test_50k, 40 paths, seed 1, minN 10; fingerprint [0-9a-f]{64}/);
  const file = /wrote (.+)\n/.exec(ok.stdout)[1];
  assert.match(path.basename(file), /^risk-record-[0-9a-f]{16}\.json$/);
  const shown = cli(['show', file]);
  assert.strictEqual(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /^risk record [0-9a-f]{64}: 3 day\(s\), 2023-03-15 to 2023-03-17, minN 10; from run1; test_50k/);
  assert.match(shown.stdout, /\nYour risk record \(counterfactual, practice-train days before 2023-03-18 only/);
  assert.match(cli(['build', run().dir]).stderr, /--account: the account profile/);
  assert.match(cli(['build', run().dir, '--account', 'test_50k', '--bogus']).stderr, /unknown flag --bogus/);
  assert.match(cli(['build', run().dir, '--account', 'test_50k', '--paths', '0']).stderr, /--paths: a whole number from 1/);
  const held = cli(['build', run(DAYS, { gate: { learning: true, role: 'final', look: { evaluation: 'e' }, hideOutcomes: false } }).dir, '--account', 'test_50k', '--out', out]);
  assert.strictEqual(held.status, 1);
  assert.match(held.stderr, /is final, not practice-train/);
  assert.strictEqual(cli([]).status, 1);
});
