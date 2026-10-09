'use strict';

/**
 * value_area end to end on real NQ bars, through the entry points an LLM and
 * the runner use (separate processes, as in a session). On 2026-04-27 the
 * prior day's POC is 27414.32; the 13:15 ET bar comes up from below, pokes
 * above it, and closes in its lower half on a range expansion: a POC
 * rejection short. The test records the multi-timeframe read and the scan,
 * plans, and sends the order through the order-gate hook: a live copy of the
 * strategy (status active) is let through with the stop sized from the scan,
 * value_area itself (paper) is refused, and a relabel is refused. Then the
 * backtester trades the same bar: entry at the next open, stop and target
 * where the strategy put them, exit as the bars dictate.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { profileSeries } = require('../../scripts/lib/trading/volume-profile');
const { tmpDir, writeJournal } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const CSV = path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv');
const BARS = readBarsArg(CSV).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
const STEP = 180000;
const CONTRACT = 'CON.F.US.MNQ.M26';
const FIRE = BARS.findIndex(b => b.t === '2026-04-27T17:15:00.000Z');

const node = (args, env, input) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, input });

/** A live copy of value_area (status active, its own name) in a strategies folder of the user's. */
function liveCopy(home) {
  const dir = path.join(home, 'strategies', 'value_area_live');
  fs.mkdirSync(dir, { recursive: true });
  const src = fs.readFileSync(path.join(ROOT, 'strategies', 'value_area', 'STRATEGY.md'), 'utf8');
  fs.writeFileSync(path.join(dir, 'STRATEGY.md'), src.replace(/^name: value_area$/m, 'name: value_area_live').replace(/^status: paper$/m, 'status: active'));
  return path.dirname(dir);
}

test('value_area e2e on real bars: POC rejection short -> records -> plan -> the gate lets the live strategy through, refuses paper and relabels', () => {
  assert.ok(FIRE > 0, 'the 13:15 ET bar is in the fixture');
  const poc = profileSeries(BARS, 'prior_rth').poc[FIRE];
  assert.ok(Math.abs(poc - 27414.32) < 0.01, `prior POC ${poc}`);
  const home = tmpDir();
  const file = path.join(home, 'MNQ-3m.json');
  fs.writeFileSync(file, JSON.stringify({ contractId: CONTRACT, bars: BARS.slice(0, FIRE + 1) }));
  const now = new Date(Date.parse(BARS[FIRE].t) + STEP + 30000).toISOString();
  const journal = writeJournal(home, []);
  const env = {
    FTH_HOME: home, PROJECTX_JOURNAL_PATH: journal, NODE_ENV: 'test', FTH_TEST_NOW: now, FTH_AUTONOMOUS: '',
    FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'),
    FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'), FTH_GATE_LOG: path.join(home, 'gate.jsonl'), CLAUDE_PLUGIN_ROOT: ROOT,
    FTH_STRATEGIES_DIRS: liveCopy(home),
  };

  // 1. The multi-timeframe read, recorded for the gate.
  const mtf = node([path.join(ROOT, 'scripts', 'mtf.js'), file, '--record', '--symbol', 'MNQ'], env);
  assert.strictEqual(mtf.status, 0, mtf.stderr);

  // 2. The scan at the bar's close, recorded: both copies fire short, with the branch that held.
  const sc = node([path.join(ROOT, 'scripts', 'strategies.js'), 'scan', file, '--symbol', 'MNQ', '--now', now, '--record'], env);
  assert.strictEqual(sc.status, 0, sc.stderr);
  const results = JSON.parse(sc.stdout);
  const r = results.find(x => x.name === 'value_area_live');
  assert.ok(r && r.candidate && r.direction === 'short', JSON.stringify(r && r.filtersFailed));
  assert.strictEqual(results.find(x => x.name === 'value_area').direction, 'short');
  const [setup, confirm] = [r.rules.short[2], r.rules.short[3]];
  assert.deepStrictEqual(setup.parts.map(x => x.ok), [true, false], 'a rejection, not a breakout');
  assert.ok(confirm.ok, 'confirmed by flow or expansion');
  // Stop above the last 3 bars' high; target the prior day's value area low, at least 2R.
  const close = BARS[FIRE].c;
  assert.ok(r.stopDistance > Math.max(...BARS.slice(FIRE - 2, FIRE + 1).map(b => b.h)) - close);
  const val = profileSeries(BARS, 'prior_rth').val[FIRE];
  assert.ok(Math.abs(r.targetDistance - (close - val)) < 1e-3 && r.targetDistance >= 2 * r.stopDistance);

  // 3. The plan, then the order as the trade-executor sends it, through the hook.
  const ticks = Math.ceil(r.stopDistance / 0.25);
  const stop = (close + ticks * 0.25).toFixed(2);
  fs.appendFileSync(journal, `${JSON.stringify({ ts: now, kind: 'plan', contractId: CONTRACT, tags: ['setup:value_area_live', 'MNQ', `regime:${r.regime}`], text: `value_area_live short, POC ${poc.toFixed(2)} rejection, stop ${stop}` })}\n`);
  const order = {
    accountId: 1, contractId: CONTRACT, side: 'sell', type: 'market', size: 1,
    stopLossBracket: { ticks, type: 'stop' }, rationale: `setup:value_area_live short, POC rejection on the 13:15 ET bar, stop ${stop}`,
  };
  const gate = o => node([path.join(ROOT, 'scripts', 'hooks', 'run-with-flags.js'), 'pre:trading:order-gate', 'scripts/hooks/trading-order-gate.js', 'minimal,standard,strict'],
    env, JSON.stringify({ tool_name: 'mcp__broker__place_order', tool_input: o }));
  // No other strategy fired the other way, and five days of bars give no 4h trend read yet: allowed.
  assert.deepStrictEqual(r.confluence.against, []);
  const res = gate(order);
  assert.strictEqual(res.status, 0, `refused:\n${res.stderr}`);
  // The paper strategy itself can't trade live.
  const paper = gate({ ...order, rationale: order.rationale.replace('setup:value_area_live', 'setup:value_area') });
  assert.strictEqual(paper.status, 2);
  assert.match(paper.stderr, /status "paper"/);
  // A strategy that didn't fire can't carry the trade.
  const relabel = gate({ ...order, rationale: order.rationale.replace('setup:value_area_live', 'setup:orb') });
  assert.strictEqual(relabel.status, 2);
  assert.match(relabel.stderr, /\[trigger-fired\]/);
  // value_area is a trend setup: with the 4h, 1h and 15m all up, the gate refuses the short.
  const mtfFile = path.join(home, 'mtf', 'MNQ.json');
  const rec = JSON.parse(fs.readFileSync(mtfFile, 'utf8'));
  fs.writeFileSync(mtfFile, JSON.stringify({ ...rec, biases: { 240: 1, 60: 1, 15: 1 } }));
  const counter = gate(order);
  assert.strictEqual(counter.status, 2);
  assert.match(counter.stderr, /\[mtf-trend\]/);
});

test('value_area e2e in the backtester: the same bar trades at the next open with the strategy\'s stop and target', () => {
  const out = tmpDir();
  const run = node([path.join(ROOT, 'scripts', 'backtest.js'), '--data', CSV, '--symbol', 'MNQ', '--strategy', 'value_area', '--no-gate', '--out', out], { FTH_HOME: out });
  assert.strictEqual(run.status, 0, run.stderr);
  const trades = fs.readFileSync(path.join(out, 'trades.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const t = trades.find(x => x.setup.signalBar === BARS[FIRE].t);
  assert.ok(t, JSON.stringify(trades.map(x => x.setup.signalBar)));
  assert.strictEqual(t.direction, 'short');
  // Entry: the next bar's open, one tick of slippage against the trade.
  assert.strictEqual(t.entryTime, BARS[FIRE + 1].t);
  assert.strictEqual(t.entry, BARS[FIRE + 1].o - 0.25);
  // Stop: the scan's distance in whole ticks above the entry; target: the prior VAL level, on the tick.
  const onTick = x => Math.round(x * 4) / 4;
  assert.ok(Math.abs(t.risk - Math.max(0.25, Math.round(t.setup.stopDistance / 0.25) * 0.25)) < 1e-9, `${t.risk} vs ${t.setup.stopDistance}`);
  assert.strictEqual(t.initialStop, onTick(t.entry + t.risk));
  const val = profileSeries(BARS, 'prior_rth').val[FIRE];
  assert.ok(Math.abs(t.target - onTick(val)) <= 0.25, `target ${t.target} vs VAL ${val}`);
  // Four bars later the 13:30 ET bar trades through the stop: filled a tick worse, about -1R.
  assert.strictEqual(t.reason, 'stop');
  assert.strictEqual(t.exit, t.initialStop + 0.25);
  assert.ok(Math.abs(t.r - (t.entry - t.exit) / t.risk) < 0.01, JSON.stringify(t));
  assert.strictEqual(t.barsHeld, 4);
});
