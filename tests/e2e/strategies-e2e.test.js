'use strict';

/**
 * Every active strategy, end to end, through the entry points an LLM uses
 * (separate processes, as in a session): on real NQ bars cut at a bar where
 * the strategy fired, `mtf.js --record` and `strategies.js scan --record`
 * write the gate's records, the plan goes in the journal, and the order goes
 * through the order-gate hook exactly as Claude Code / Codex / Qwen run it.
 * Each must be allowed, with the stop sized from the scan; each strategy's
 * scan result must carry its context (regime, session, the trend rule, rule
 * results, stop, exit, confluence); and a paper strategy's entry is refused.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { FAKE_BROKERS, tmpDir, writeJournal, recordBrokerSpecs } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv')).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
const STEP = 180000;
const CONTRACT = 'MNQ:2026-06';
const ALL = loadStrategies(ROOT, {}).strategies;
const ACTIVE_ALL = ALL.filter(s => s.valid && s.status === 'active' && s.signal === 'rules' && s.timeframe === '3m' && s.instruments.includes('MNQ'));
// Active strategies whose setup the 6-day NQ fixture never produces (checked below: they load, validate and scan);
// the rest are driven end to end. A fixture where these fire would drive them too.
const NOT_ON_FIXTURE = {
  vwap_reclaim: 'each of its rule hits here is outside 10:00-15:00 ET, in a transition regime, or against the trend rule (vwap-reclaim-strategy.test.js fires it on constructed bars)',
  value_area_breakout: 'its two closes above the prior value area on volume all come outside 10:00-15:00 ET here, none below it (value-area-strategies.test.js fires it on constructed sessions)',
  value_area_reentry: 'no open outside the prior value area with two closes back inside on this fixture (value-area-strategies.test.js fires it on constructed sessions)',
};
const ACTIVE = ACTIVE_ALL.filter(s => !NOT_ON_FIXTURE[s.name]);

const node = (args, env, input) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, input });

/** The first bar index where `s` is a scan candidate (the live scan at that bar's close). */
function firstFire(s) {
  const ev = createEvaluator(BARS);
  for (let i = 300; i < BARS.length; i += 1) {
    const r = ev.at(s, i, { describe: false });
    if (r.candidate && r.stopDistance > 0) return i;
  }
  return -1;
}

test('the active strategies are the ones this test drives, and the ones the fixture can\'t, named with why', () => {
  // value_area is active (the owner's decision after order flow moved to the broker servers): on this fixture, which
  // carries no flow, it fires on its range-expansion confirmation.
  assert.deepStrictEqual(ACTIVE.map(s => s.name).sort(), ['bos', 'cisd_ote', 'crt_1h', 'crt_4h', 'ema_cross', 'keltner', 'orb', 'supertrend', 'value_area']);
  assert.deepStrictEqual(ACTIVE_ALL.filter(s => NOT_ON_FIXTURE[s.name]).map(s => s.name).sort(), Object.keys(NOT_ON_FIXTURE).sort());
  // Each one not on the fixture: valid, scans every bar without an error, and truly never fires here (else drive it).
  const ev = createEvaluator(BARS);
  for (const name of Object.keys(NOT_ON_FIXTURE)) {
    const s = ACTIVE_ALL.find(x => x.name === name);
    assert.ok(s && s.valid, name);
    assert.strictEqual(firstFire(s), -1, `${name} fires on the fixture now: drive it end to end instead`);
    for (let i = 300; i < BARS.length; i += 97) {
      const r = ev.at(s, i, { describe: true });
      assert.ok(r.candidate === false && !r.error && r.rules && r.rules.long.length > 0, `${name} at bar ${i}: ${JSON.stringify(r).slice(0, 200)}`);
    }
  }
});

for (const s of ACTIVE) {
  test(`e2e ${s.name}: fires on real bars, records, plans, and the gate hook lets its trade through`, () => {
    const i = firstFire(s);
    assert.ok(i > 0, `${s.name} never fires on the NQ fixture`);
    const home = tmpDir();
    recordBrokerSpecs(home); // the broker's tick specs, as the translator records them at the contract lookup
    const file = path.join(home, 'MNQ-3m.json');
    fs.writeFileSync(file, JSON.stringify({ contractId: CONTRACT, bars: BARS.slice(0, i + 1) }));
    const closeMs = Date.parse(BARS[i].t) + STEP;
    const now = new Date(closeMs + 30000).toISOString(); // the cycle, 30 s after the bar closed
    const journal = writeJournal(home, []);
    const env = {
      FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: journal, NODE_ENV: 'test', FTH_TEST_NOW: now, FTH_AUTONOMOUS: '',
      FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'),
      FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'), FTH_GATE_LOG: path.join(home, 'gate.jsonl'), CLAUDE_PLUGIN_ROOT: ROOT,
    };

    // 1. The multi-timeframe read, recorded for the gate.
    const mtf = node([path.join(ROOT, 'scripts', 'mtf.js'), file, '--record', '--symbol', 'MNQ'], env);
    assert.strictEqual(mtf.status, 0, mtf.stderr);
    assert.match(mtf.stdout, /^Trend rule: /m);

    // 2. The scan at the bar's close, recorded: the strategy is a candidate, with its context.
    const sc = node([path.join(ROOT, 'scripts', 'strategies.js'), 'scan', file, '--symbol', 'MNQ', '--now', now, '--record'], env);
    assert.strictEqual(sc.status, 0, sc.stderr);
    const r = JSON.parse(sc.stdout).find(x => x.name === s.name);
    assert.ok(r.candidate, `${s.name} at ${BARS[i].t}: ${JSON.stringify(r.filtersFailed)}`);
    for (const k of ['regime', 'inSession', 'inRegime', 'mtf', 'filtersFailed', 'stopDistance', 'exit', 'rules', 'confluence', 'entryRef']) assert.ok(k in r, `${s.name} scan result lacks ${k}`);
    assert.ok(r.mtf.ready && typeof r.mtf.prevailing !== 'undefined');
    assert.ok(r.stopDistance > 0);

    // 3. The plan, then the order as the trade-executor sends it, through the hook.
    const side = r.direction;
    const sign = side === 'long' ? 1 : -1;
    const ticks = Math.ceil(r.stopDistance / 0.25);
    const stop = (BARS[i].c - sign * ticks * 0.25).toFixed(2);
    fs.appendFileSync(journal, `${JSON.stringify({ ts: now, kind: 'plan', contractId: CONTRACT, tags: [`setup:${s.name}`, 'MNQ', `regime:${r.regime}`], text: `${s.name} ${side}, stop ${stop}` })}\n`);
    const order = {
      accountId: 1, contractId: CONTRACT, side: side === 'long' ? 'buy' : 'sell', type: 'market', size: 1,
      stopLossBracket: { ticks, type: 'stop' }, rationale: `setup:${s.name} ${side} trigger on the ${BARS[i].t} bar, stop ${stop}`,
    };
    const gate = o => node([path.join(ROOT, 'scripts', 'hooks', 'run-with-flags.js'), 'pre:trading:order-gate', 'scripts/hooks/trading-order-gate.js', 'minimal,standard,strict'],
      env, JSON.stringify({ tool_name: 'mcp__broker__place_order', tool_input: o }));
    const conflict = r.confluence.against.length > 0 && s.mtf !== 'reversal';
    const res = gate(order);
    if (conflict) {
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /conflicts with/);
    } else {
      assert.strictEqual(res.status, 0, `${s.name} ${side} at ${BARS[i].t} was refused:\n${res.stderr}`);
    }
    // The same trade under another strategy's name is refused.
    const other = ACTIVE.find(x => x.name !== s.name && !(r.confluence.with || []).includes(x.name));
    const relabel = gate({ ...order, rationale: order.rationale.replace(`setup:${s.name}`, `setup:${other.name}`) });
    assert.strictEqual(relabel.status, 2);
    assert.match(relabel.stderr, /\[trigger-fired\]/);
  });
}

test('every strategy with rules provides its context on every scanned bar; a paper strategy cannot enter', () => {
  const rules = ALL.filter(s => s.valid && s.signal === 'rules' && s.timeframe === '3m');
  const ev = createEvaluator(BARS);
  for (const s of rules) {
    for (let i = 600; i < BARS.length; i += 150) {
      const r = ev.at(s, i, { describe: true });
      for (const k of ['regime', 'inSession', 'inRegime', 'mtf', 'filtersFailed', 'exit', 'rules']) assert.ok(k in r, `${s.name} at ${i}: no ${k}`);
      assert.ok(['trend', 'reversal'].includes(r.mtf.style), s.name);
    }
  }
  // A paper strategy (a paper copy of value_area in the user's strategies folder; the repo's own strategies are all
  // active): the gate refuses a live entry.
  const home = tmpDir();
  const dir = path.join(home, 'strategies', 'value_area_paper');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'STRATEGY.md'), fs.readFileSync(path.join(ROOT, 'strategies', 'value_area', 'STRATEGY.md'), 'utf8')
    .replace(/^name: value_area$/m, 'name: value_area_paper').replace(/^status: active\b.*$/m, 'status: paper'));
  const paper = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: path.dirname(dir) }).strategies.find(s => s.name === 'value_area_paper');
  assert.strictEqual(paper.status, 'paper');
  recordBrokerSpecs(home); // the broker's tick specs, as the translator records them at the contract lookup
  const env = { FTH_HOME: home, FTH_STRATEGIES_DIRS: path.dirname(dir), FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_ALLOWED_ACCOUNT_IDS: '1,7', FAKE_BROKER_JOURNAL: writeJournal(home, [{ ts: '2026-04-28T04:13:00.000Z', kind: 'plan', contractId: CONTRACT, text: 'p' }]), NODE_ENV: 'test', FTH_TEST_NOW: '2026-04-28T04:13:00.000Z', FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_KILL_SWITCH_FILE: path.join(home, 'STOP'), FTH_GATE_LOG: path.join(home, 'g.jsonl'), CLAUDE_PLUGIN_ROOT: ROOT };
  const res = node([path.join(ROOT, 'scripts', 'hooks', 'run-with-flags.js'), 'pre:trading:order-gate', 'scripts/hooks/trading-order-gate.js', 'minimal,standard,strict'], env,
    JSON.stringify({ tool_name: 'mcp__broker__place_order', tool_input: { accountId: 1, contractId: CONTRACT, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 20, type: 'stop' }, rationale: 'setup:value_area_paper long, stop 27400' } }));
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /status "paper"/);
});
