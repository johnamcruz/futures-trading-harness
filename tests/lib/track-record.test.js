'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fromReport, writeRecord, readRecord, liveRecord, describeRecord, MIN_SLICE } = require('../../scripts/lib/trading/track-record');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
// A trade entered at `et` (HH:MM New York, EDT) in `regime` with result r.
const trade = (strategy, r, regime, hh = 10) => ({ strategy, r, net: r * 20, fees: 0.74, mfeR: Math.max(r, 0.5), maeR: -0.5, barsHeld: 5, entryTime: `2026-10-07T${String(hh + 4).padStart(2, '0')}:03:00.000Z`, exitTime: `2026-10-07T${String(hh + 4).padStart(2, '0')}:30:00.000Z`, setup: { regime } });

test('a backtest report becomes a track record: overall, by regime, by hour', () => {
  const trades = [
    ...Array.from({ length: 12 }, (_, k) => trade('orb', k % 3 === 0 ? -1 : 1.5, 'trend-up', 10)),
    ...Array.from({ length: 4 }, () => trade('orb', -1, 'range', 14)),
    trade('ema_cross', 2, 'range', 11),
  ];
  const rec = fromReport({ meta: { runId: 'r1', symbols: ['MNQ'], timeframe: 3, start: '2025-01-02T00:00:00Z', end: '2025-04-01T00:00:00Z' }, trades }, 'orb');
  assert.strictEqual(rec.summary.trades, 16, 'only its own trades');
  assert.deepStrictEqual(Object.keys(rec.byRegime), ['range', 'trend-up']);
  assert.strictEqual(rec.byRegime['trend-up'].trades, 12);
  assert.strictEqual(rec.byRegime['trend-up'].meanR, 0.667);
  assert.strictEqual(rec.byHour['10:00 ET'].trades, 12);
  assert.strictEqual(rec.summary.edge, 'anecdotal (under 30 trades)');
  const home = tmpDir();
  writeRecord(home, rec);
  assert.deepStrictEqual(readRecord(home, 'orb'), rec);
  assert.strictEqual(readRecord(home, 'nope'), null);
  fs.writeFileSync(path.join(home, 'track-record', 'bad.json'), '{oops');
  assert.strictEqual(readRecord(home, 'bad'), null);

  // The prompt line: the regime and hour slices only with enough trades.
  const line = describeRecord({ backtest: rec, regime: 'trend-up', at: '2026-10-08T14:30:00.000Z' });
  assert.match(line, /^track record: backtest 16 trades \(MNQ 3m 2025-01-02\.\.2025-04-01\): win 50%, E \+0\.25R \[95% CI [^\]]+\], edge anecdotal \(under 30 trades\); in trend-up: 12 trades, E \+0\.67R; at 10:00 ET: 12 trades, E \+0\.67R; live: no reviewed trades yet$/);
  assert.ok(MIN_SLICE > 4);
  assert.doesNotMatch(describeRecord({ backtest: rec, regime: 'range', at: '2026-10-08T18:30:00.000Z' }), /in range|at 14:00/, 'under MIN_SLICE trades: not shown');
  assert.match(describeRecord({}), /no backtest recorded \(backtest\.js --record\); live: no reviewed trades yet/);
});

test('live record: the journal\'s reviewed trades of the setup, paper excluded, and those in this regime', () => {
  const review = (tags, text) => ({ ts: '2026-10-07T15:00:00.000Z', kind: 'review', text, tags });
  const entries = [
    review(['result:win', 'setup:orb', 'regime:trend-up', 'r:2'], 'orb long'),
    review(['result:loss', 'setup:orb', 'regime:range'], 'orb short R = -1.05'),
    review(['result:win', 'setup:orb', 'paper', 'r:3'], 'paper'),
    review(['result:win', 'setup:bos', 'r:1'], 'bos'),
  ];
  const l = liveRecord(entries, 'orb', 'trend-up');
  assert.deepStrictEqual({ trades: l.trades, wins: l.wins, losses: l.losses, meanR: l.meanR }, { trades: 2, wins: 1, losses: 1, meanR: 0.48 });
  assert.deepStrictEqual(l.inRegime, { trades: 1, wins: 1, losses: 0, meanR: 2 });
  assert.match(describeRecord({ live: l, regime: 'trend-up' }), /live: 2 reviewed, 1W\/1L, E \+0\.48R \(in trend-up: 1, E \+2R\)/);
});

test('backtest --record writes each strategy\'s own record (run alone), and only on plain runs', () => {
  const home = tmpDir();
  const csv = path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv');
  const run = args => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backtest.js'), '--data', csv, '--symbol', 'MNQ', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, FTH_HOME: home } });
  const joint = run(['--strategy', 'ema_cross,supertrend', '--record', '--out', path.join(home, 'joint')]);
  assert.strictEqual(joint.status, 0, joint.stderr);
  const alone = run(['--strategy', 'ema_cross', '--out', path.join(home, 'alone')]);
  assert.strictEqual(alone.status, 0, alone.stderr);
  const aloneTrades = fs.readFileSync(path.join(home, 'alone', 'trades.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
  const rec = readRecord(home, 'ema_cross');
  assert.strictEqual(rec.summary.trades, aloneTrades, 'the record is the strategy alone, not its share of the joint run');
  assert.ok(readRecord(home, 'supertrend'));
  assert.ok(rec.byRegime && Object.keys(rec.byRegime).every(k => k !== 'unknown'), 'trades carry their regime');
  const wf = run(['--strategy', 'ema_cross', '--record', '--walk-forward', '--grid', 'emaFast=9']);
  assert.notStrictEqual(wf.status, 0);
  assert.match(wf.stderr + wf.stdout, /record: plain runs only/);
});
