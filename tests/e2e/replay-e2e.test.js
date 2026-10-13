'use strict';

/**
 * End to end: the replay driver (scripts/replay.js) runs the live runner, one
 * process per decision time, with the test suite's fake harness, against a
 * stub replay broker (the mock exchange as a replay server: its clock is the
 * driver's clock file and it attests replay: true). Proves that each cycle
 * runs at the replayed time, that orders go through the order gate to the
 * broker (an entry refused, a close sent), that the store gets one line per
 * decision time with the broker's fills, that a re-run resumes where the last
 * one stopped, and that the user's own harness home is never touched.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, shippedBroker } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js');
const HARNESS = path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js');
const CLI = path.join(ROOT, 'scripts', 'replay.js');
const MNQ_ID = 'fake:MNQ:Z26';

function setup() {
  const user = tmpDir();
  const live = path.join(user, 'live-home');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({
    brokers: { replaymock: { command: [process.execPath, SERVER], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_STATE_DIR', 'MOCK_JOURNAL', 'MOCK_CLOCK_FILE', 'MOCK_REPLAY', 'MOCK_INIT'] } },
  }));
  const config = path.join(user, 'replay.json');
  fs.writeFileSync(config, JSON.stringify({
    runId: 'e2e', workDir: path.join(user, 'replays'), broker: 'replaymock',
    start: '2026-10-07T13:31:00Z', end: '2026-10-07T13:40:00Z', premarket: false,
    autotrader: { harness: 'custom', command: [process.execPath, HARNESS, '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York' },
    brokerEnv: { clockFile: 'MOCK_CLOCK_FILE', stateDir: 'MOCK_STATE_DIR', runId: null, start: null, end: null },
  }));
  // A long MNQ open at 21490 in the replay account; the exchange's price is 21500.
  const init = { positions: [{ id: 1, accountId: 7, contractId: MNQ_ID, creationTimestamp: '2026-10-07T13:00:00.000Z', type: 1, size: 1, averagePrice: 21490 }] };
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: live, MOCK_REPLAY: '1', MOCK_INIT: JSON.stringify(init), FAKE_HARNESS_ORDERS: '1' };
  return { user, live, config, env, runHome: path.join(user, 'replays', 'e2e'), runDir: path.join(user, 'replays', 'e2e', 'replay', 'e2e') };
}

const replay = (w, args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: w.env, timeout: 240000 });
const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('replay: the live runner, cycle by cycle at the replayed time, through the gate to a replay broker; store, resume, report', { timeout: 300000 }, async () => {
  const w = setup();
  const pts = replay(w, ['points', '--config', w.config]);
  assert.strictEqual(pts.status, 0, pts.stderr);
  assert.match(pts.stdout, /2026-10-07 {2}0 premarket, 3 trade, 0 eod/);

  // Two decision times, then stop (a budget cap): the run resumes from there.
  const first = replay(w, ['run', '--config', w.config, '--max-cycles', '2']);
  assert.strictEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const day = path.join(w.runDir, '2026-10-07.jsonl');
  let recs = lines(day);
  assert.deepStrictEqual(recs.map(r => r.t), ['2026-10-07T13:33:02.000Z', '2026-10-07T13:36:02.000Z']);

  const second = replay(w, ['run', '--config', w.config]);
  assert.strictEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
  recs = lines(day);
  assert.deepStrictEqual(recs.map(r => r.t), ['2026-10-07T13:33:02.000Z', '2026-10-07T13:36:02.000Z', '2026-10-07T13:39:02.000Z'], 'one line per decision time, none repeated');
  const manifest = JSON.parse(fs.readFileSync(path.join(w.runDir, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest.daysDone, ['2026-10-07']);
  assert.match(manifest.hash, /^[0-9a-f]{64}$/);

  for (const r of recs) {
    // The live runner's bar cycle: one trade cycle per bar, its prompt built at the replayed time.
    assert.deepStrictEqual(r.ran.map(x => [x.action, x.ok, x.result]), [['trade', true, 'CYCLE RESULT: no-trade - fake harness']]);
    assert.strictEqual(r.cycles.length, 1);
    const c = r.cycles[0];
    assert.match(c.promptHash, /^[0-9a-f]{64}$/);
    const cycle = JSON.parse(fs.readFileSync(c.file, 'utf8'));
    assert.ok(cycle.prompt.includes(`(${r.t})`), 'the prompt is dated at the replayed time');
    const barOpen = new Date(Date.parse(r.t) - 2000 - 180000).toISOString();
    assert.strictEqual(cycle.context.symbols[0].bar.t, barOpen, 'the bar that just closed at the replayed time');
    // The cycle's harness knows that bar (the bar briefing for it is the cycle's own), and the runner briefed it.
    assert.ok(cycle.transcript.includes(`FTH_CYCLE_BARS=${JSON.stringify({ MNQ: barOpen })}`), cycle.transcript.slice(0, 400));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(w.runHome, 'briefing', 'MNQ.json'), 'utf8')).symbol, 'MNQ');
    assert.ok(c.file.startsWith(w.runHome), 'the cycle log is in the run home');
    // The entry is refused by the gate (no plan); every refusal is in the line.
    assert.ok(r.refusals.length >= 1 && r.refusals.every(x => x.tool === 'place_order' && x.checks.length), JSON.stringify(r.refusals));
  }
  // The first close went through the gateway to the broker and closed the long: one fill, P&L +$20.00 (10 points = 40 ticks x $0.50).
  const fills = recs.flatMap(r => r.trades);
  assert.strictEqual(fills.length, 1, JSON.stringify(fills));
  assert.deepStrictEqual([fills[0].contractId, fills[0].profitAndLoss, fills[0].creationTimestamp], ['MNQ', 20, '2026-10-07T13:33:02.000Z']);
  assert.strictEqual(recs[0].trades.length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(w.runDir, 'broker', 'state.json'), 'utf8'));
  assert.ok(state.calls.some(c => c.tool === 'close_position' && c.args.contractId === MNQ_ID), 'the broker saw its own contract id');
  assert.ok(!state.calls.some(c => c.tool === 'place_order'), 'the refused entry never reached the broker');
  // The runner's bars file for the run, inside the run home.
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(w.runHome, 'bars', 'MNQ-3m.json'), 'utf8')).contractId, 'MNQ');

  // Nothing left: a third run does nothing.
  const third = replay(w, ['run', '--config', w.config]);
  assert.strictEqual(third.status, 0, third.stderr);
  assert.strictEqual(lines(day).length, 3);

  const rep = replay(w, ['report', w.runDir]);
  assert.strictEqual(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /2026-10 +3 +3 +0 +100\.0% +1 +100\.0%/);
  assert.ok(fs.existsSync(path.join(w.runDir, 'report.md')));
  // Labels (stage 2) from the same run: one per decision time, joined to the gate's log and the fills.
  const lab = replay(w, ['labels', w.runDir]);
  assert.strictEqual(lab.status, 0, lab.stderr);
  assert.match(lab.stdout, /labels 3, decisions 3, taken 0, unknownOutcome 0, skipped 0, refused 2, wins 0, losses 0, uncloneable 3/);
  const labels = lines(path.join(w.runDir, 'labels.jsonl'));
  assert.deepStrictEqual(labels.map(l => l.t), recs.map(r => r.t));
  // First: the replay account's long is open (the cycle's context): an entry on top of it, refused, keeps it out of cloning.
  // The close (close_position, not gated) is in no gate record and the fake harness's text transcript names no tool calls.
  assert.deepStrictEqual([labels[0].decision, labels[0].position.side, labels[0].teacher.action, labels[0].clone.reasons], ['in-trade', 'long', 'hold', ['entry while in a trade']]);
  assert.deepStrictEqual([labels[0].outcome.result, labels[0].outcome.pnl, labels[0].outcome.openKnown], ['win', 20, false]);
  // Then flat: the teacher's long (setup:orb, stop 21495 from its rationale), refused with the gate's checks; its intent kept.
  for (const l of labels.slice(1)) {
    assert.deepStrictEqual([l.decision, l.teacher.action, l.teacher.setup, l.gate.decision, l.outcome.result], ['flat', 'long', 'orb', 'refused', 'refused']);
    assert.ok(l.gate.checks.includes('plan-required'), JSON.stringify(l.gate));
    assert.strictEqual(l.teacher.orders.length, 1, 'each cycle\'s own gate record, none of its neighbour\'s');
    assert.strictEqual(l.teacher.stop.points, 5);
    assert.match(l.provenance.promptHash, /^[0-9a-f]{64}$/);
  }
  const labelSummary = JSON.parse(fs.readFileSync(path.join(w.runDir, 'labels-summary.json'), 'utf8'));
  assert.strictEqual(labelSummary.decisions, 3);

  // The user's own home holds what it held: the replay wrote nothing there.
  assert.deepStrictEqual(fs.readdirSync(w.live), ['brokers.json']);
  // A changed config is a new run.
  const cfg = JSON.parse(fs.readFileSync(w.config, 'utf8'));
  fs.writeFileSync(w.config, JSON.stringify({ ...cfg, everyNthBar: 2 }));
  const changed = replay(w, ['run', '--config', w.config]);
  assert.strictEqual(changed.status, 1);
  assert.match(changed.stderr, /another config, harness or model/);
});

test('replay refuses a live broker, and a run home that is the live harness home', { timeout: 60000 }, () => {
  const w = setup();
  const cfg = JSON.parse(fs.readFileSync(w.config, 'utf8'));
  fs.writeFileSync(w.config, JSON.stringify({ ...cfg, broker: shippedBroker().name })); // the live broker the repo ships
  const live = replay(w, ['run', '--config', w.config]);
  assert.strictEqual(live.status, 1);
  assert.match(live.stderr, /not a replay broker/);
  fs.writeFileSync(w.config, JSON.stringify({ ...cfg, workDir: w.user, runId: 'live-home' }));
  const home = replay(w, ['run', '--config', w.config]);
  assert.strictEqual(home.status, 1);
  assert.match(home.stderr, /overlaps the live harness home/);
  assert.deepStrictEqual(fs.readdirSync(w.live), ['brokers.json']);
});

test('replay every Nth bar with Qwen: a cycle at each decision time; the $version Qwen stamps on its settings is no workspace change', { timeout: 300000 }, () => {
  const w = setup();
  // A stand-in `qwen` on PATH (the runner starts Qwen by name) that stamps the workspace settings as Qwen Code does.
  const bin = path.join(w.user, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'qwen'), `#!/bin/sh\nexec "${process.execPath}" "${HARNESS}" "$@"\n`, { mode: 0o755 });
  const cfg = JSON.parse(fs.readFileSync(w.config, 'utf8'));
  const { command: _c, ...autotrader } = cfg.autotrader;
  fs.writeFileSync(w.config, JSON.stringify({ ...cfg, end: '2026-10-07T13:50:00Z', everyNthBar: 2, autotrader: { ...autotrader, harness: 'qwen' } }));
  const { FAKE_HARNESS_ORDERS: _o, ...env } = w.env;
  // The first cycle ends with a summary instead of its result line: logged as none reported, and the run goes on.
  w.env = { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_QWEN_SETTINGS_VERSION: '4', FAKE_HARNESS_NO_RESULT: '(2026-10-07T13:36:02.000Z)' };

  const pts = replay(w, ['points', '--config', w.config]);
  assert.strictEqual(pts.status, 0, pts.stderr);
  assert.match(pts.stdout, /2026-10-07 {2}0 premarket, 3 trade, 0 eod/);
  const run = replay(w, ['run', '--config', w.config]);
  assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(run.stdout, /no cycle/);
  const recs = lines(path.join(w.runDir, '2026-10-07.jsonl'));
  // Every second 3-minute bar of the session (09:30, 09:36, 09:42, 09:48 ET), inside the window.
  assert.deepStrictEqual(recs.map(r => r.t), ['2026-10-07T13:36:02.000Z', '2026-10-07T13:42:02.000Z', '2026-10-07T13:48:02.000Z']);
  assert.deepStrictEqual(recs.map(r => r.ran.map(x => [x.action, x.ok, x.result])), [
    [['trade', true, 'CYCLE RESULT: (none reported)']],
    [['trade', true, 'CYCLE RESULT: no-trade - fake harness']],
    [['trade', true, 'CYCLE RESULT: no-trade - fake harness']],
  ]);
  for (const r of recs) {
    // The repository's paper prop policy names an account with no attempt started in the run home: a warning each pass, never a stop.
    assert.ok(r.errors.some(e => /topstep_100k: no attempt is started/.test(e)), JSON.stringify(r.errors));
    const cycle = JSON.parse(fs.readFileSync(r.cycles[0].file, 'utf8'));
    assert.strictEqual(cycle.context.symbols[0].bar.t, new Date(Date.parse(r.t) - 2000 - 180000).toISOString(), 'the bar that just closed, after the skipped ones');
  }
  // Qwen stamped its settings, and the run went on: no kill switch in the run home.
  const settings = JSON.parse(fs.readFileSync(path.join(w.runHome, 'workspace', '.qwen', 'settings.json'), 'utf8'));
  assert.strictEqual(settings.$version, 4);
  assert.ok(Array.isArray(settings.permissions.allow));
  const stop = path.join(w.runHome, 'STOP');
  assert.ok(!fs.existsSync(stop), fs.existsSync(stop) ? fs.readFileSync(stop, 'utf8') : '');
});
