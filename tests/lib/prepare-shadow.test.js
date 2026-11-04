'use strict';

// Prepare ahead, shadow mode (scripts/lib/prepare-shadow.js, PR B1): after a cycle's result is final, the shadow confirm
// of the plan made for this close (logged beside the cycle's own decision), then the prepare of the next bar's plan.
// On real bars (the momentum_continuation census: a short that fires at the 14:06 close of 2021-05-17), with the runs
// played by a fake CLI that answers as the prepare and the confirm do. Every row of the failure table end to end, and
// nothing written but the plan files and the cycle log's `prepare` field.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../scripts/lib/prepare-shadow');
const PA = require('../../scripts/lib/prepare-ahead');
const B = require('../../scripts/lib/trading/briefing');
const { loadStrategies, scan } = require('../../scripts/lib/trading/strategies');
const { listedReads } = require('../../scripts/lib/learning/setup-moments');
const { validateConfig } = require('../../scripts/lib/autotrader');
const FX = require('../fixtures/momentum-continuation');

const ROOT = path.resolve(__dirname, '..', '..');
const REG = loadStrategies(ROOT, {}).strategies;
const BARS = FX.load();
const FIRE = FX.CENSUS_BG[0][0]; // a short fires at this bar's close (it opens at 14:06 UTC)
const I = BARS.findIndex(b => b.t === FIRE);
const STEP = 180000;
const cfg = validateConfig({ harness: 'claude', premarketAt: '', symbols: ['MNQ'], prepareAhead: 'shadow' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-shadow-'));

/** One cycle's close (bar index k): its bars, briefing (built on the one before, as the runner's), scan and listed setups. */
function closeAt(k, prev = null) {
  const bars = BARS.slice(0, k + 1);
  const sc = scan(REG, bars, { symbol: 'MNQ' });
  const briefing = B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, scan: sc, prev });
  return { bars, briefing, scan: sc, listed: listedReads(briefing), bar: { t: bars[k].t, c: bars[k].c, contractId: 'MNQ', file: '/bars.json' } };
}
const PREP = closeAt(I - 1);
const FIRED = closeAt(I, PREP.briefing);
const closeMs = c => Date.parse(c.bar.t) + STEP;

/**
 * The fake CLI (cycle-run.js runPrepare's shape): a prepare writes one SCENARIO per candidate its prompt lists, a confirm
 * takes its scenario (or `o.decision`); each records its session as the SessionStart hook does. `o.advanceMs`: the harness
 * clock moves that much during the run; `o.fail`: the run fails; `o.throws`; `o.transcript`: the session's file.
 */
function fakeCli(clock, o = {}) {
  const runs = [];
  const run = async (_cfg, kind, prompt, limits) => {
    runs.push({ kind, prompt, limits });
    clock.ms += o.advanceMs ?? 20000;
    if (o.throws) throw new Error('spawn claude ENOENT');
    if (o.fail === kind) return { ok: false, timedOut: false, text: '', sessionId: null, transcript: null, source: null, usage: null, ms: 1 };
    const id = `ses-${kind}-${runs.length}`;
    const text = kind === 'prepare'
      ? [...prompt.matchAll(/^ {2}- (P\d+) \S+ (long|short) "([^"]+)"/gm)].map((m, j) => `SCENARIO ${j + 1}: ${m[1]} "${m[3]}" → TAKE if the candle meets it | PASS if not; reads: "${m[3]}"; why: the trend`).concat(['STAND DOWN if: a news window', 'INVALID if: a fill', 'PLAN END']).join('\n')
      : (o.decision || `DECISION: TAKE ${/Your plan said: scenario (\d+)/.exec(prompt)[1]}`);
    return { ok: true, timedOut: false, text, sessionId: id, transcript: o.transcript === undefined ? o.sessionFile : o.transcript, source: kind === 'confirm' ? 'fork' : 'startup', usage: o.usage || { total: { input: 1, cacheRead: 9, cacheCreation: 0, output: 2 } }, ms: o.reportMs || o.advanceMs || 20000, denied: o.denied || [], gateRefusals: o.gateRefusals || 0, initMs: o.initMs ?? null };
  };
  return { run, runs };
}

/** The shadow after a cycle at close `c`: its inputs as the runner gives them; `o` overrides. */
async function after(home, c, o = {}) {
  const clock = o.clock || { ms: closeMs(c) + 40000 };
  const sessionFile = path.join(home, 'claude-session.jsonl');
  fs.writeFileSync(sessionFile, '{}\n');
  const cli = o.cli || fakeCli(clock, { sessionFile, ...(o.fake || {}) });
  const log = path.join(home, 'logs', 'cycles', 'x', `${Date.parse(c.bar.t)}-trade.json`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, JSON.stringify({ result: o.result || 'CYCLE RESULT: no-trade - x', ...(o.entry ? { entry: o.entry } : {}) }, null, 2));
  const shadow = S.createShadow({ cfg, root: ROOT, home, runPrepare: cli.run, now: () => new Date(clock.ms), sectionOpts: () => ({ registry: REG }), newsAt: o.newsAt || (() => ({ inBlackout: false })), ...(o.chainSideOf ? { chainSideOf: o.chainSideOf } : {}) });
  const acct = o.acct || { id: '7', at: new Date(clock.ms).toISOString(), balance: 50000, positions: [], orders: [], workingOrders: 0 };
  const r = await shadow.after({
    symbol: 'MNQ', minutes: 3, bar: c.bar, bars: c.bars, windowBars: null, briefing: c.briefing, factsKey: o.factsKey || 'k1', reports: o.reports || [], scan: c.scan, listed: c.listed,
    result: o.result || 'CYCLE RESULT: no-trade - x', cycleLog: log, killSwitch: o.killSwitch || (() => false), accountAfter: async () => acct, phase1KeyOf: () => o.nextKey || 'k1',
    eodMs: o.eodMs ?? null, inSession: () => true, ...(o.reportsAfter ? { reportsAfter: o.reportsAfter } : {}),
  });
  return { ...r, cli, clock, log: JSON.parse(fs.readFileSync(log, 'utf8')) };
}

test('shadow: no plan for this close, a prepare for the next: its plan written (keyed by the next bar) with its session and versions; the cycle log carries both', async () => {
  const home = tmp();
  const r = await after(home, PREP);
  assert.deepStrictEqual(r.shadow, { status: 'none', reason: 'no-plan', planId: null });
  assert.deepStrictEqual(r.cli.runs.map(x => x.kind), ['prepare']);
  assert.strictEqual(r.made.outcome, 'done');
  const plan = PA.readPlan(home, 'MNQ', FIRE);
  assert.ok(plan, 'the plan for the bar opening at the fire');
  assert.strictEqual(r.made.planId, plan.id);
  assert.strictEqual(plan.session.id, 'ses-prepare-1');
  assert.strictEqual(plan.versions.asOf, PREP.bar.t);
  assert.strictEqual(plan.versions.factsKey, 'k1');
  // The momentum fire, then the 15m reactions at fixed key levels still standing at that close (it completes no 15m
  // candle: next-close.js standing candidates).
  assert.deepStrictEqual(plan.candidates.map(x => [x.id, x.kind, x.side, x.read]), [['P1', 'momentum', 'short', 'momentum_continuation fired down'],
    ['P2', 'standing', 'short', '15m rejected opening range high down'], ['P3', 'standing', 'short', '15m rejected 15m swing high 16664 down'], ['P4', 'standing', 'short', '15m broke overnight low down']]);
  assert.strictEqual(plan.scenarios.length, plan.candidates.length, 'one per candidate (the fake prepare)');
  // The prepare's prompt: the prepare briefing with the section, from these closed bars.
  assert.match(r.cli.runs[0].prompt, /Possible at the next close/);
  assert.match(r.cli.runs[0].prompt, /P1 momentum_continuation short "momentum_continuation fired down"/);
  // Its deadline: the next close less the margin (config/runner.json prepare), from the harness clock.
  const RT = require('../../scripts/lib/tunables').runner();
  const T = RT.prepare;
  const grace = RT.runner.killGraceMs;
  // (No plan here, so no confirm: the prepare has the pair's budget, maxMs less the account read, each bound less the grace.)
  assert.strictEqual(r.cli.runs[0].limits.timeoutMs, Math.min(Date.parse(FIRE) + STEP - T.marginMs, closeMs(PREP) + 40000 + T.maxMs - RT.runner.accountReadMs) - grace - (closeMs(PREP) + 40000));
  assert.strictEqual(r.log.prepare.made.planId, plan.id);
  assert.strictEqual(r.log.prepare.shadow.status, 'none');
});

test('shadow: at the close the plan was made for, valid and matched: the confirm forks the prepare\'s session with the at-close facts first, and its decision is logged beside the full cycle\'s', async () => {
  const home = tmp();
  await after(home, PREP);
  const plan = PA.readPlan(home, 'MNQ', FIRE);
  const r = await after(home, FIRED, { result: 'CYCLE RESULT: executed - trade_lifecycle short 3', entry: { outcome: 'executed' } });
  const conf = r.cli.runs.find(x => x.kind === 'confirm');
  assert.ok(conf, 'the confirm ran');
  assert.strictEqual(conf.limits.resume, plan.session.id);
  assert.ok(conf.prompt.indexOf('Bar briefing MNQ 3m') < conf.prompt.indexOf('Your plan said: scenario 1'), 'the at-close facts first');
  assert.match(conf.prompt, /What fired at the close: "momentum_continuation fired down"/);
  assert.deepStrictEqual({ status: r.shadow.status, planId: r.shadow.planId, k: r.shadow.match.k, read: r.shadow.match.read }, { status: 'valid', planId: plan.id, k: 1, read: 'momentum_continuation fired down' });
  assert.deepStrictEqual(r.shadow.confirm.decision, { decision: 'take', k: 1, side: 'short' });
  assert.deepStrictEqual(r.shadow.full, { decision: 'take', side: 'short', why: null });
  assert.strictEqual(r.shadow.agreesWithFull, true);
  assert.strictEqual(r.shadow.prepareMs, plan.ms);
  assert.ok(Number.isFinite(r.shadow.confirm.ms));
  assert.deepStrictEqual(r.shadow.confirm.usage, { total: { input: 1, cacheRead: 9, cacheCreation: 0, output: 2 } });
  // The setups the plan did not cover, by level kind (v1 lists no moving level).
  assert.ok(r.shadow.unplanned.includes('15m broke vwap rth down'));
  assert.strictEqual(r.shadow.unplannedKinds.vwap, 1);
  assert.deepStrictEqual(r.log.prepare.shadow, JSON.parse(JSON.stringify(r.shadow)));
});

test('shadow: prepare.maxMs bounds both runs together: on a frozen replay clock the confirm\'s own time comes off the prepare\'s budget (a replay step never outlasts its cycle\'s leftover)', async () => {
  const T = require('../../scripts/lib/tunables').runner().prepare;
  const home = tmp();
  await after(home, PREP);
  const clock = { ms: closeMs(FIRED) + 2000 };
  const r = await after(home, FIRED, { clock, fake: { advanceMs: 0, reportMs: 30000 } });
  assert.strictEqual(r.shadow.confirm.ms, 30000);
  const [conf, prep] = ['confirm', 'prepare'].map(k => r.cli.runs.find(x => x.kind === k));
  const R = require('../../scripts/lib/tunables').runner();
  const pair = T.maxMs - R.runner.accountReadMs - R.runner.killGraceMs;
  assert.strictEqual(conf.limits.timeoutMs, pair, 'the frozen clock: the cap');
  assert.strictEqual(prep.limits.timeoutMs, pair - 30000, 'the cap less what the confirm took');
  // A confirm that took the whole cap: no prepare.
  await after(home, PREP);
  const r2 = await after(home, FIRED, { clock: { ms: closeMs(FIRED) + 2000 }, fake: { advanceMs: 0, reportMs: T.maxMs } });
  assert.deepStrictEqual([r2.made.outcome, r2.made.why], ['skipped', 'no-time']);
});

test('shadow: the plan keys the desk\'s reports as the cache serves them after the cycle (with their ends), so a report expected to hold that changes voids', async () => {
  const home = tmp();
  const held = [{ role: 'trend-momentum-analyst', text: 'Bias: down', until: '2021-05-17T14:30:00.000Z' }];
  await after(home, PREP, { reports: [{ role: 'trend-momentum-analyst', text: 'Bias: down' }], reportsAfter: () => held });
  const plan = PA.readPlan(home, 'MNQ', FIRE);
  assert.strictEqual(plan.versions.desk['trend-momentum-analyst'].until, '2021-05-17T14:30:00.000Z');
  const r = await after(home, FIRED, { reports: [{ role: 'trend-momentum-analyst', text: 'Bias: up', until: '2021-05-17T14:30:00.000Z' }] });
  assert.deepStrictEqual([r.shadow.status, r.shadow.reason], ['void', 'desk']);
});

test('shadow: what each run tried and was refused (the CLI\'s permission denials, the gate refusals in the shadow\'s log) is in its record', async () => {
  const home = tmp();
  const a = await after(home, PREP, { fake: { denied: ['mcp__harness__compose_check'], gateRefusals: 1 } });
  assert.deepStrictEqual([a.made.denied, a.made.gateRefusals], [['mcp__harness__compose_check'], 1]);
  const b = await after(home, FIRED, { fake: { denied: ['Agent', 'mcp__broker__place_order'], gateRefusals: 2 } });
  assert.deepStrictEqual([b.shadow.confirm.denied, b.shadow.confirm.gateRefusals], [['Agent', 'mcp__broker__place_order'], 2]);
});

test('shadow: near the end of day (a 15:48 cycle, or an early close\'s 12:48) the runs end by the end of day less the margin and the kill grace; under the grace neither runs, so the flatten is never held', async () => {
  const R = require('../../scripts/lib/tunables').runner();
  const T = R.prepare;
  const grace = R.runner.killGraceMs;
  for (const left of [70000, 45000]) {
    const home = tmp();
    await after(home, PREP);
    const start = closeMs(FIRED) + 2000;
    const eodMs = start + left; // the end of day `left` ms after the shadow starts (15:50 or an early close's 12:50)
    const r = await after(home, FIRED, { clock: { ms: start }, eodMs, fake: { advanceMs: 0 } });
    const conf = r.cli.runs.find(x => x.kind === 'confirm');
    assert.strictEqual(conf.limits.timeoutMs, eodMs - T.marginMs - grace - start, `${left}`);
  }
  // Under the grace left: no confirm, no prepare.
  const home = tmp();
  await after(home, PREP);
  const start = closeMs(FIRED) + 2000;
  const r = await after(home, FIRED, { clock: { ms: start }, eodMs: start + T.marginMs + grace + grace - 1, fake: { advanceMs: 0 } });
  assert.deepStrictEqual(r.cli.runs, []);
  assert.strictEqual(r.shadow.confirm.outcome, 'no-time');
  assert.deepStrictEqual([r.made.outcome, r.made.why], ['skipped', 'no-time']);
});

test('shadow: on a frozen replay clock the two runs together get prepare.maxMs less the account read and the kill grace (inside the step\'s headroom past its cycle)', async () => {
  const R = require('../../scripts/lib/tunables').runner();
  const home = tmp();
  await after(home, PREP);
  const r = await after(home, FIRED, { clock: { ms: closeMs(FIRED) + 2000 }, fake: { advanceMs: 0, reportMs: 5000 } });
  const [conf, prep] = ['confirm', 'prepare'].map(k => r.cli.runs.find(x => x.kind === k));
  const pair = R.prepare.maxMs - R.runner.accountReadMs - R.runner.killGraceMs;
  assert.strictEqual(conf.limits.timeoutMs, pair);
  assert.strictEqual(prep.limits.timeoutMs, pair - 5000);
});

test('shadow: the plan\'s facts key is phase 1\'s on the account read after the cycle (as the next cycle will read it), never the cycle\'s own', async () => {
  const home = tmp();
  await after(home, PREP, { factsKey: 'k-cycle-start', nextKey: 'k-after' });
  assert.strictEqual(PA.readPlan(home, 'MNQ', FIRE).versions.factsKey, 'k-after');
});

test('shadow: the kill switch is read again once the account read is back: on by then, no prepare', async () => {
  let n = 0;
  const r = await after(tmp(), PREP, { killSwitch: () => (n += 1) > 2 });
  assert.deepStrictEqual([r.made.outcome, r.made.why], ['skipped', 'kill-switch']);
  assert.deepStrictEqual(r.cli.runs, []);
});

test('shadow: a plan void only by the hourly close records what it would have been (valid and matched, or why not)', async () => {
  const home = tmp();
  await after(home, PREP);
  const plan = PA.readPlan(home, 'MNQ', FIRE);
  plan.versions.sections.h1.until = new Date(closeMs(FIRED)).toISOString();
  PA.writePlan(home, plan);
  const rolled = { ...FIRED, briefing: { ...FIRED.briefing, sections: { ...FIRED.briefing.sections, h1: { ...FIRED.briefing.sections.h1, version: `h1@${new Date(closeMs(FIRED)).toISOString()}` } } } };
  const r = await after(home, rolled);
  assert.deepStrictEqual([r.shadow.status, r.shadow.reason], ['void', 'htf-close:h1']);
  assert.deepStrictEqual(r.shadow.ifHourIgnored, { status: 'valid', match: 'matched', read: 'momentum_continuation fired down' });
  assert.ok(!r.cli.runs.some(x => x.kind === 'confirm'), 'still no confirm: the counterfactual is a record only');
});

test('shadow: each run\'s spawn-to-init time is recorded (and the confirm\'s first-turn cache creation, the first fork\'s cost)', async () => {
  const home = tmp();
  const a = await after(home, PREP, { fake: { initMs: 140 } });
  assert.strictEqual(a.made.initMs, 140);
  const b = await after(home, FIRED, { fake: { initMs: 90, usage: { total: { input: 1, cacheRead: 9, cacheCreation: 13400, output: 2 }, first: { input: 1, cacheRead: 5, cacheCreation: 13400, output: 1 } } } });
  assert.strictEqual(b.shadow.confirm.initMs, 90);
  assert.strictEqual(b.shadow.confirm.firstCacheCreation, 13400);
});

test('shadow: a run that hangs is stopped at its deadline end to end: the wall timer aborts the production runPrepare\'s run (its signal), the prepare is aborted, no plan written', { timeout: 60000 }, async () => {
  const { fakeClaude } = require('../fixtures/fake-claude-sessions');
  const { runPrepare: realRunPrepare } = require('../../scripts/lib/cycle-run');
  const RT = require('../../scripts/lib/tunables').runner();
  const home = tmp();
  // The CLI hangs until it is stopped (its signal: what runHarness kills the process group on).
  const fake = fakeClaude({ dir: path.join(home, 'claude-sessions'), preHooks: false, script: () => [{ act: () => new Promise(() => {}) }, { result: 'PLAN END' }] });
  const runPrepare = (c, kind, prompt, limits) => realRunPrepare(c, kind, prompt, limits, { root: ROOT, home, env: { FTH_HOME: home, HOME: home }, run: fake });
  // The least budget a run is given (the kill grace) plus 200 ms before the deadline: the run gets that long, then stops.
  const start = Date.parse(FIRE) + STEP - RT.prepare.marginMs - RT.runner.killGraceMs - (RT.runner.killGraceMs + 200);
  const clock = { ms: start };
  const t0 = Date.now();
  const r = await after(home, PREP, { clock, cli: { run: runPrepare, runs: [] } });
  assert.strictEqual(r.made.outcome, 'aborted', JSON.stringify(r.made));
  assert.ok(Date.now() - t0 < RT.runner.killGraceMs + 10000, 'stopped at its deadline, not left to hang');
  assert.strictEqual(fake.calls.length, 1);
  assert.strictEqual(fake.calls[0].cancelled, true, 'the run saw its signal');
  assert.strictEqual(PA.readPlan(home, 'MNQ', FIRE), null);
});

test('shadow: the agreement check can fail: a deliberately wrong shadow decision is logged as a disagreement', async () => {
  const home = tmp();
  await after(home, PREP);
  const r = await after(home, FIRED, { result: 'CYCLE RESULT: no-trade - the candle was weak', fake: { decision: 'DECISION: TAKE 1' } });
  assert.deepStrictEqual(r.shadow.full, { decision: 'pass', side: null, why: null });
  assert.strictEqual(r.shadow.agreesWithFull, false);
  const r2 = await after(tmp(), FIRED, {});
  assert.strictEqual(r2.shadow.status, 'none');
});

test('shadow: a confirm that states no DECISION line is no decision (no agreement either way)', async () => {
  const home = tmp();
  await after(home, PREP);
  const r = await after(home, FIRED, { fake: { decision: 'I think it fits.' }, result: 'CYCLE RESULT: no-trade - x' });
  assert.strictEqual(r.shadow.confirm.decision, null);
  assert.strictEqual(r.shadow.agreesWithFull, null);
});

// --- The failure table, end to end ----------------------------------------------------------------------------------

test('failure row: a prepare done after its deadline is aborted: no plan file; the next close finds none', async () => {
  const home = tmp();
  const r = await after(home, PREP, { fake: { advanceMs: 200000 } });
  assert.strictEqual(r.made.outcome, 'aborted');
  assert.strictEqual(PA.readPlan(home, 'MNQ', FIRE), null);
  assert.strictEqual((await after(home, FIRED)).shadow.reason, 'no-plan');
});

test('failure row: the deadline passed already (no time left): no prepare', async () => {
  const home = tmp();
  const r = await after(home, PREP, { clock: { ms: Date.parse(FIRE) + STEP - 1000 } });
  assert.deepStrictEqual([r.made.outcome, r.made.why], ['skipped', 'no-time']);
  assert.deepStrictEqual(r.cli.runs, []);
});

test('failure row: a prepare that fails or crashes leaves no plan file', async () => {
  for (const fake of [{ fail: 'prepare' }, { throws: true }]) {
    const home = tmp();
    const r = await after(home, PREP, { fake });
    assert.strictEqual(r.made.outcome, 'error', JSON.stringify(fake));
    assert.strictEqual(PA.readPlan(home, 'MNQ', FIRE), null);
  }
});

test('failure row: a fill or P&L change (the facts key) before the close voids the plan: no confirm', async () => {
  const home = tmp();
  await after(home, PREP);
  const r = await after(home, FIRED, { factsKey: 'k2' });
  assert.deepStrictEqual([r.shadow.status, r.shadow.reason], ['void', 'facts']);
  assert.ok(!r.cli.runs.some(x => x.kind === 'confirm'));
});

test('failure row: the chain side flipping at the close voids the plan', async () => {
  const home = tmp();
  await after(home, PREP, { chainSideOf: () => -1 });
  const r = await after(home, FIRED, { chainSideOf: () => 1 });
  assert.deepStrictEqual([r.shadow.status, r.shadow.reason], ['void', 'chain-side']);
});

test('failure row: a news window starting at the close voids the plan', async () => {
  const home = tmp();
  await after(home, PREP);
  const r = await after(home, FIRED, { newsAt: () => ({ inBlackout: true, reason: 'CPI' }) });
  assert.deepStrictEqual([r.shadow.status, r.shadow.reason], ['void', 'news']);
});

test('failure row: what fired is not a scenario of the plan: outside the plan, no confirm, the reads and their kinds logged', async () => {
  const home = tmp();
  await after(home, PREP);
  const outside = { ...FIRED, scan: [], listed: ['15m broke vwap rth down'] };
  const r = await after(home, outside);
  assert.deepStrictEqual([r.shadow.status, r.shadow.fired], ['outside', ['15m broke vwap rth down']]);
  assert.deepStrictEqual(r.shadow.unplannedKinds, { vwap: 1 });
  assert.ok(!r.cli.runs.some(x => x.kind === 'confirm'));
  const none = await after(tmp(), PREP);
  void none;
});

test('failure row: the prepare session\'s file missing: void, no confirm', async () => {
  const home = tmp();
  await after(home, PREP, { fake: { transcript: path.join(home, 'gone.jsonl') } });
  const r = await after(home, FIRED);
  assert.deepStrictEqual([r.shadow.status, r.shadow.reason], ['void', 'session-missing']);
  assert.ok(!r.cli.runs.some(x => x.kind === 'confirm'));
});

test('failure row: the confirm past its budget is aborted: no decision; the full cycle\'s stands', async () => {
  const home = tmp();
  await after(home, PREP);
  const r = await after(home, FIRED, { fake: { advanceMs: 200000 } });
  assert.strictEqual(r.shadow.confirm.outcome, 'aborted');
  assert.strictEqual(r.shadow.confirm.decision, null);
  assert.strictEqual(r.shadow.agreesWithFull, null);
});

test('failure row: the kill switch on: no confirm and no prepare', async () => {
  const home = tmp();
  await after(home, PREP);
  const r = await after(home, FIRED, { killSwitch: () => true });
  assert.deepStrictEqual(r.shadow, { status: 'kill-switch', reason: 'kill-switch', planId: PA.readPlan(home, 'MNQ', FIRE).id });
  assert.deepStrictEqual([r.made.outcome, r.made.why], ['skipped', 'kill-switch']);
  assert.deepStrictEqual(r.cli.runs, []);
});

test('failure row: a stale plan from an earlier bar is never this close\'s (keyed by bar)', async () => {
  const home = tmp();
  await after(home, closeAt(I - 3));
  // The plan made two bars back is for the bar before the fire, not the fire's.
  const r = await after(home, FIRED);
  assert.strictEqual(r.shadow.reason, 'no-plan');
});

test('failure row: an open position (or a working order) after the cycle: no prepare (management first)', async () => {
  for (const acct of [{ id: '7', positions: [{ contractId: 'MNQ', size: 1, type: 2 }], orders: [] }, { id: '7', positions: [], orders: [{ id: 1 }] }, { id: '7', error: 'timeout' }]) {
    const r = await after(tmp(), PREP, { acct });
    assert.deepStrictEqual([r.made.outcome, r.made.why], ['skipped', 'not-flat'], JSON.stringify(acct));
    assert.deepStrictEqual(r.cli.runs, []);
  }
});

test('shadow writes nothing but the plan files under <home>/prepare and the cycle log\'s prepare field (no compose record, verdict or journal)', async () => {
  const home = tmp();
  const before = new Set();
  const walk = d => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
  await after(home, PREP);
  for (const f of walk(home)) before.add(path.relative(home, f));
  const r = await after(home, FIRED, { result: 'CYCLE RESULT: executed - trade_lifecycle short 3', entry: { outcome: 'executed' } });
  assert.strictEqual(r.shadow.status, 'valid');
  const added = walk(home).map(f => path.relative(home, f)).filter(f => !before.has(f));
  for (const f of added) assert.ok(/^prepare\//.test(f) || /^logs\/cycles\//.test(f) || f === 'claude-session.jsonl', f);
  for (const f of walk(home).map(x => path.relative(home, x))) assert.ok(!/compose|verdict|journal|lifecycle/.test(f), f);
});

test('wiring: the shadow only with prepareAhead "shadow" on Claude Code and a runPrepare; else none (the runner as before)', () => {
  const { prepareShadowFor } = require('../../scripts/lib/runner-wiring');
  const runPrepare = async () => ({});
  const base = { root: ROOT, home: tmp(), now: () => new Date(), strategies: () => REG };
  assert.strictEqual(typeof prepareShadowFor({ ...base, cfg, runPrepare }).after, 'function');
  assert.strictEqual(prepareShadowFor({ ...base, cfg }), null, 'no runPrepare');
  assert.strictEqual(prepareShadowFor({ ...base, cfg: validateConfig({ harness: 'claude', premarketAt: '' }), runPrepare }), null, 'the key off');
  assert.strictEqual(prepareShadowFor({ ...base, cfg: validateConfig({ harness: 'claude', premarketAt: '', prepareAhead: 'off' }), runPrepare }), null, 'off');
  assert.strictEqual(prepareShadowFor({ ...base, cfg: { ...validateConfig({ harness: 'opencode', premarketAt: '' }), prepareAhead: 'shadow' }, runPrepare }), null, 'another harness');
});

test('wiring: the section reads what the close\'s own code reads: the selected contracts, the lane\'s strategies, the paper flag, and (no attempt running) no entry rule, no size and not in an attempt', () => {
  const { sectionInputsFor } = require('../../scripts/lib/runner-wiring');
  const { laneStrategies, lanesOf } = require('../../scripts/lib/lanes');
  const home = tmp();
  // A strategy on another timeframe is no strategy of the first lane's: the section never scans it.
  const all = [...REG, { ...REG.find(s => s.name === 'momentum_continuation'), name: 'other_tf', timeframe: '1h' }];
  for (const c of [cfg, { ...cfg, paper: true, symbols: ['NQ'] }]) {
    const o = sectionInputsFor({ cfg: c, root: ROOT, home, env: { FTH_HOME: home, HOME: home }, strategies: () => all })('MNQ');
    assert.deepStrictEqual(o.selected, c.symbols);
    assert.deepStrictEqual(o.strategies.map(s => s.name), laneStrategies(all, lanesOf(c)[0]).map(s => s.name));
    assert.ok(!o.strategies.some(s => s.name === 'other_tf'));
    assert.strictEqual(o.registry, all);
    assert.strictEqual(o.paper, Boolean(c.paper));
    assert.deepStrictEqual([o.inAttempt, o.entryRule, o.sizing], [false, null, null]);
    assert.ok(o.blackouts && o.clock, 'the briefing\'s own facts');
  }
});

test('wiring: phase 1\'s key for the prepare is the report cache\'s own (the key a cycle serves phase 1 under), from the same facts', () => {
  const { reportCacheFor } = require('../../scripts/lib/runner-wiring');
  const home = tmp();
  B.writeBriefing(home, PREP.briefing);
  const rc = reportCacheFor(home, { harness: 'claude', cycle: 'full', timeframe: 3 }, [], { FTH_HOME: home, HOME: home });
  const account = { id: '7', balance: 50000, positions: [], orders: [], canTrade: true, mcpTradingAllowed: true, remainingBeforeLimit: 1000, attempts: [] };
  const now = new Date(closeMs(PREP) + 30000);
  const symbols = [{ symbol: 'MNQ', bar: PREP.bar.t, contractId: 'MNQ' }];
  const facts = { symbols, account, now, fills: [], lessons: [], reviewed: [] };
  const key = rc.phase1Key(facts);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.strictEqual(key, rc.serve(facts).phase1.key);
  assert.notStrictEqual(rc.phase1Key({ ...facts, account: { ...account, balance: 49900 } }), key, 'a P&L change: another key');
  assert.strictEqual(rc.phase1Key({ ...facts, fills: null }), null, 'a fact unread: no key');
});

test('the shadow\'s module never reads the wall clock', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'prepare-shadow.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/Date\.now|new Date\(\s*\)|performance\.now/.test(src));
});
