'use strict';

// The training loop's plan, the probe round's part (scripts/lib/train/plan.js): the probe and trend replays resolved as
// the loop's runs resolve them, so a config the first run would refuse fails at plan; the trend pool described. And a
// replay config's autotrader path resolves against the replay file's own folder (train/config.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const { resolveLoop } = require('../../scripts/lib/train/config');
const { probePlan } = require('../../scripts/lib/train/plan');
const LC = require('../../scripts/lib/learning/leg-census');
const C = require('../../scripts/lib/learning/curated-lists');
const { VERSION } = require('../../scripts/lib/learning/curated-moments');
const { load } = require('../fixtures/trend-moves');

const ROOT = path.resolve(__dirname, '..', '..');
const MIN3 = 180000;
const NY = '09:30-12:00@America/New_York';
const NOW = new Date('2026-10-24T00:00:00Z');

function moment(bar, side, id) {
  const t = Date.parse(bar);
  return {
    v: VERSION, use: 'practice', id, root: 'MNQ', day: new Date(t + 6 * 3600000).toISOString().slice(0, 10), year: bar.slice(0, 4), reactionAt: bar, bar, minutes: 3, setupTf: 15, side, list: 'chop',
    trend: { state: 'chop' }, reactionKind: 'rejection', skills: ['rejection'], aligned: [], expected: 'pass', gate: null, outcome: { result: 'no-room' },
    window: { from: new Date(t - 4 * MIN3).toISOString(), to: new Date(t + MIN3).toISOString() },
  };
}

/** A loop folder: loop.json beside replays/ (each replay config naming its runner config by a path relative to replays/). */
function loopFolder({ sessions = [NY] } = {}) {
  const dir = tmpDir();
  const user = tmpDir();
  const replays = path.join(dir, 'replays');
  fs.mkdirSync(replays);
  const trader = { harness: 'claude', model: 'm', symbols: ['MNQ'], account: '1', timeframe: 3, premarketAt: '', sessions };
  fs.writeFileSync(path.join(replays, 'trader.json'), JSON.stringify(trader));
  // The census and a curated list of its first legs' moments (2021-05-03 to 05-05: practice-train).
  const legs = C.legsFor(load().bars.m3, { session: NY, use: 'practice' });
  const moments = legs.legs.map((g, i) => moment(new Date(Date.parse(g.start) + MIN3).toISOString(), g.side, `m${i}`));
  const census = LC.writeCensus(dir, LC.buildCensus(moments, legs, { use: 'practice', seed: 3, now: NOW }));
  const list = C.writeLists(dir, C.buildLists(moments, { use: 'practice', total: moments.length, now: NOW }));
  const base = { workDir: path.join(user, 'work'), broker: 'backtester', autotrader: 'trader.json' };
  const write = (name, obj) => fs.writeFileSync(path.join(replays, name), JSON.stringify({ ...base, ...obj }));
  write('keep.json', {});
  write('probe.json', { stage: 1, practice: { mode: 'setup-focus', setupTf: 15, quietSample: 0.15, seed: 1 }, curatedList: { file: list, list: 'mix' } });
  write('trend.json', { stage: 1 });
  const raw = {
    loopId: 'plan', replay: 'replays/keep.json', proposer: trader, seed: 1, modelScore: { account: 'acct_a' },
    tuningWindows: [{ from: '2022-09-01', to: '2023-02-01' }],
    probe: { replay: 'replays/probe.json', windows: [{ from: '2021-05-03', to: '2021-05-07' }], trend: { replay: 'replays/trend.json', census, from: '2021-05-03', to: '2021-05-07', batch: { start: 4, max: 8 } } },
  };
  return { dir, user, raw, trader, env: { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'home') } };
}

test('a replay config\'s autotrader path resolves against the replay file\'s own folder, never the loop config\'s', () => {
  const f = loopFolder();
  const loop = resolveLoop(f.raw, { baseDir: f.dir });
  assert.deepStrictEqual(loop.replay.autotrader, f.trader);
  assert.deepStrictEqual([loop.probe.replay.autotrader, loop.probe.trend.replay.autotrader], [f.trader, f.trader]);
  // A trader.json beside loop.json (the old, wrong folder) is never read.
  fs.writeFileSync(path.join(f.dir, 'trader.json'), JSON.stringify({ ...f.trader, timeframe: 1 }));
  assert.deepStrictEqual(resolveLoop(f.raw, { baseDir: f.dir }).replay.autotrader, f.trader);
  // An inline replay config: its autotrader path against the loop config's folder, as before.
  const inline = resolveLoop({ ...f.raw, replay: { ...JSON.parse(fs.readFileSync(path.join(f.dir, 'replays', 'keep.json'), 'utf8')), autotrader: 'replays/trader.json' } }, { baseDir: f.dir });
  assert.deepStrictEqual(inline.replay.autotrader, f.trader);
});

test('plan: the probe and trend replays resolve as the loop\'s runs will; the trend pool is described', () => {
  const f = loopFolder();
  const loop = resolveLoop(f.raw, { baseDir: f.dir });
  const lines = probePlan(loop, { root: ROOT, env: f.env });
  assert.match(lines[0], /^probe replay 2021-05-03\.\.2021-05-07: resolves \(\d+ curated window\(s\), list mix, stage 1\)$/);
  assert.match(lines[1], /^trend replay: resolves on 2021-05-0\d \(stage 1; the loop sets each run's stepped windows\)$/);
  const t = loop.probe.trend;
  assert.strictEqual(lines[2], `trend pool: 2021-05-03..2021-05-07, ${t.set.legs.length} leg(s) on ${t.set.days.length} day(s) (census ${t.set.fingerprint.slice(0, 12)}); batch 4 leg(s) a round (about 2 probe, 2 confirm), up to 8; stepped around each leg (4 bar(s) before it through its catch window) and 1 control window(s) a leg; regression 0 day(s)`);
  assert.deepStrictEqual(probePlan({ ...loop, probe: undefined }, { root: ROOT, env: f.env }), []);
});

test('plan: a curated list whose windows miss the runner\'s sessions fails at plan, naming the replay, not at the first run', () => {
  const f = loopFolder({ sessions: ['13:00-14:00@America/New_York'] });
  const loop = resolveLoop(f.raw, { baseDir: f.dir });
  assert.throws(() => probePlan(loop, { root: ROOT, env: f.env }), /the probe round's replays are refused:\n- probe\.replay on 2021-05-03\.\.2021-05-07: invalid replay config:\n- curatedList: \d+ window\(s\) hold no decision time of the run's sessions/);
});
