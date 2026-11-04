'use strict';

/**
 * prepareAhead "on" (PR B2) end to end, in replay: the decision-path world (tests/fixtures/decision-path.js: the live
 * runner as the harness wires it, the mock exchange as a replay broker behind the real adapter and the real order
 * gateway), every Claude Code run (the head trader's, the prepare's) played by the fake CLI that keeps sessions as the
 * real one does (tests/fixtures/fake-claude-sessions.js: --resume --fork-session, the plugin's real SessionStart and
 * PreToolUse hooks, --allowedTools under dontAsk). The flow: the 04:09 bar's cycle, then the prepare of the 04:12 bar's
 * plan; at the 04:12 bar's close the confirm IS the head trader's run (a fork of the prepare's session, its full tools,
 * the close's cycle env with FTH_CONFIRM_BASE, the cycle's prompt then the plan's line). Every fallback row end to end:
 * the full head trader's run, exactly the old path's prompt and argv; and the property: the old path's result, orders
 * and gate decisions are the same with the key off and "on" when the confirm decides as the head trader would.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const D = require('../fixtures/decision-path');
const { fakeClaude } = require('../fixtures/fake-claude-sessions');
const { runPrepare } = require('../../scripts/lib/cycle-run');
const PA = require('../../scripts/lib/prepare-ahead');

const { QUIET_BAR, FIRED_BAR, NEXT_BAR, decisionAt } = D;
const BARS = [QUIET_BAR, FIRED_BAR, NEXT_BAR];
const PLAN_LINES = prompt => [...prompt.matchAll(/^ {2}- (P\d+) \S+ (long|short) "([^"]+)"/gm)].map((m, j) => `SCENARIO ${j + 1}: ${m[1]} "${m[3]}" → TAKE if the 15m closes as listed | PASS if not; reads: "${m[3]}"; why: the bias`).concat(['STAND DOWN if: a news window', 'INVALID if: a fill', 'PLAN END']).join('\n');

/**
 * A replay day of the three bars, every Claude Code run through one fake CLI: the prepare writes its plan; the head
 * trader's run (a fresh one or the confirm) plays `heads[bar]` (default: the old path's pass). `on`: prepareAhead "on".
 * `beforePass[bar](w, fake)`: acting before a pass; `cli(kind, argv)`: a run's result replaced (an error, a hang).
 */
async function day({ on = false, heads = {}, beforePass = {}, cfg = {}, cli = null, afterRun = null } = {}) {
  const w = D.world({ harness: 'claude' });
  // headSkillsInPrompt in both worlds: "on" requires it (autotrader.js validateConfig).
  w.cfg = { ...w.cfg, headSkillsInPrompt: true, ...cfg, ...(on ? { prepareAhead: 'on' } : {}) };
  let head = null;
  const fake = fakeClaude({ dir: path.join(w.home, 'claude-sessions'), script: (prompt, env, info) => (env.FTH_PREPARE === 'prepare' ? [{ harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } }, { result: PLAN_LINES(prompt) }] : head(prompt, env, info)) });
  const run = async (argv, o) => {
    const hit = cli ? cli(argv, o, w) : null;
    if (hit) return hit;
    // `afterRun(argv, res)`: the run played, then its result replaced (a CLI that errs after its calls).
    const res = await fake(argv, o);
    return (afterRun && afterRun(argv, res)) || res;
  };
  const passes = [];
  for (const bar of BARS) {
    if (beforePass[bar]) beforePass[bar](w, fake);
    const steps = heads[bar] ? heads[bar](w) : D.passCycle(w, 'nothing to take');
    head = () => steps;
    const r = await D.pass(w, decisionAt(bar), steps, { headRun: run, ...(on ? { runPrepare: env => (c, kind, prompt, limits) => runPrepare(c, kind, prompt, limits, { root: D.ROOT, home: w.home, env, run }) } : {}) });
    passes.push(r);
  }
  return { w, fake, passes };
}

const cycleRecords = w => {
  const dir = path.join(w.home, 'logs', 'cycles');
  return fs.readdirSync(dir).sort().flatMap(d => fs.readdirSync(path.join(dir, d)).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, d, f), 'utf8'))));
};
/** What the old path decided and did: each cycle's result, the gate's decisions and the broker's orders. */
const decided = w => ({
  results: cycleRecords(w).map(r => r.result),
  gate: D.gateLog(w).map(e => ({ source: e.source, tool: e.tool, decision: e.decision, checks: (e.violations || []).map(v => v.check).sort() })),
  orders: D.placedAtBroker(w),
});
const headCalls = fake => fake.calls.filter(c => !c.env.FTH_PREPARE);
const promptOf = c => c.argv[c.argv.indexOf('-p') + 1];
/**
 * The confirms of the plan made for `bar`'s close (forks resuming its prepare's session). The 04:06 cycle's prepare
 * lists the 15m reaction still standing at the 04:12 close (next-close.js standing candidates), so the 04:09 bar has a
 * plan and a confirm of its own: the rows below are about the 04:12 bar's.
 */
const forksAt = (fake, w, bar) => {
  const plan = PA.readPlan(w.home, 'MNQ', bar);
  assert.ok(plan, `a plan for the bar opening ${bar}`);
  return fake.calls.filter(c => c.source === 'fork' && c.argv[c.argv.indexOf('--resume') + 1] === plan.session.id);
};

test('"on" e2e: the prepare after the 04:09 cycle; at the 04:12 close the confirm is the head trader\'s run: a fork of the prepare\'s session, its full tools, the close\'s cycle env and FTH_CONFIRM_BASE, the cycle\'s prompt then the plan', async () => {
  const off = await day();
  // Each line's arrival time, as the real run reports it (harness-run.js lineTimes): the confirm's turn is timed by them.
  const timed = (argv, res) => (argv.includes('--resume') ? { ...res, lineTimes: String(res.stdout).split('\n').map(() => Date.now()) } : null);
  const { w, fake } = await day({ on: true, afterRun: timed });
  const plan = PA.readPlan(w.home, 'MNQ', NEXT_BAR);
  assert.ok(plan && plan.base && plan.base.uuids.length > 0, 'the plan, with its sealed base');
  const heads = headCalls(fake);
  assert.strictEqual(heads.length, 3);
  const conf = heads[2];
  assert.strictEqual(conf.source, 'fork');
  assert.strictEqual(conf.argv[conf.argv.indexOf('--resume') + 1], plan.session.id);
  assert.ok(conf.argv.includes('--fork-session'));
  assert.strictEqual(conf.env.FTH_CONFIRM_BASE, PA.planFile(w.home, 'MNQ', NEXT_BAR));
  assert.ok(!('FTH_PREPARE' in conf.env));
  assert.ok(conf.env.FTH_CYCLE_TRANSCRIPT && conf.env.FTH_CYCLE_BARS, 'the close\'s cycle env');
  // Its argv: the head trader's own (the off world's at this close) with the fork added; its prompt: that cycle's then the plan.
  const offRec = cycleRecords(off.w)[2];
  const onRec = cycleRecords(w)[2];
  const r = onRec.argv.indexOf('--resume');
  const strip = a => a.map(x => (/fth-test-[A-Za-z0-9]+/.test(x) ? x.replace(/fth-test-[A-Za-z0-9]+/g, '<tmp>') : x));
  assert.deepStrictEqual(strip([...onRec.argv.slice(0, r), ...onRec.argv.slice(r + 3)]), strip(offRec.argv), 'the head trader\'s argv whole');
  assert.ok(promptOf(conf).includes('Your plan said: scenario'));
  assert.ok(promptOf(conf).indexOf('Your plan said') > promptOf(conf).indexOf('CYCLE RESULT'), 'the at-close facts (the cycle\'s prompt) first');
  // The record: the mode, the path, the confirm's outcome, close to order (no order here), the desk.
  assert.deepStrictEqual([onRec.prepare.mode, onRec.prepare.on.path, onRec.prepare.on.confirm.outcome, onRec.prepare.on.confirm.fellBack], ['on', 'confirm', 'done', false], JSON.stringify(onRec.prepare));
  assert.ok('closeToOrderMs' in onRec.prepare.on);
  // The confirm's own turn, apart from its run and the entry: a pass here, so it ends at its CYCLE RESULT line.
  const c = onRec.prepare.on.confirm;
  assert.deepStrictEqual([c.turnTo, c.composes], ['result', 0], JSON.stringify(c));
  assert.ok(Number.isFinite(c.turnMs) && c.turnMs >= 0 && c.turnMs <= c.runMs && c.runMs <= c.ms, JSON.stringify(c));
  assert.ok(Number.isFinite(c.readsMs) && c.readsMs >= 0);
  assert.deepStrictEqual([onRec.prepare.on.phase2Ms, onRec.prepare.on.executorMs], [null, null], 'no entry: no phase 2 or executor time');
  // The first close had no plan of its own: the full head trader, as before. The second's plan (made after the first
  // close) lists the 15m reaction still standing at its close, and what fired there matches it: a confirm too.
  assert.deepStrictEqual(cycleRecords(w).slice(0, 2).map(x => x.prepare.on.path), ['no-plan', 'confirm']);
  assert.deepStrictEqual(heads.slice(0, 2).map(c => c.argv.includes('--resume')), [false, true]);
  const second = PA.readPlan(w.home, 'MNQ', FIRED_BAR);
  assert.ok(second.candidates.some(c => c.kind === 'standing' && c.read === cycleRecords(w)[1].prepare.on.match.read), JSON.stringify(cycleRecords(w)[1].prepare.on));
  // Each confirm's prompt says "a standing setup" exactly when its matched candidate is standing (the 04:09 bar's is).
  const kinds = [[FIRED_BAR, 1], [NEXT_BAR, 2]].map(([bar, i]) => {
    const m = cycleRecords(w)[i].prepare.on.match;
    const k = PA.readPlan(w.home, 'MNQ', bar).candidates.find(c => c.id === m.id).kind;
    assert.strictEqual(promptOf(heads[i]).includes(`Scenario ${m.k} is a standing setup: the setup is the reaction the briefing lists`), k === 'standing', `${bar}: ${k}`);
    return k;
  });
  assert.strictEqual(kinds[0], 'standing');
  // The property here: the same results, gate decisions and orders.
  assert.deepStrictEqual(decided(w), decided(off.w));
});

test('"on" e2e, every fallback row: the full head trader\'s run at the close, exactly as with the key off (its prompt and argv), and the same results, gate decisions and orders', async () => {
  const off = await day();
  // Each world's own home named alike (the prompt names it).
  const named = (text, w) => String(text).split(w.home).join('<home>');
  const offPrompt = named(promptOf(headCalls(off.fake)[2]), off.w);
  const rows = {
    // The prepare's session lost before the close: void (session-missing).
    'session-missing': { beforePass: { [NEXT_BAR]: w => { const p = PA.readPlan(w.home, 'MNQ', NEXT_BAR); fs.rmSync(p.session.transcript); } }, path: 'void', reason: 'session-missing' },
    // A corrupt plan file: no plan.
    'corrupt-plan': { beforePass: { [NEXT_BAR]: w => fs.writeFileSync(PA.planFile(w.home, 'MNQ', NEXT_BAR), '{"v":1,') }, path: 'no-plan' },
    // A plan whose base was tampered with: never a confirm.
    'forged-base': { beforePass: { [NEXT_BAR]: w => { const f = PA.planFile(w.home, 'MNQ', NEXT_BAR); const p = JSON.parse(fs.readFileSync(f, 'utf8')); p.base.uuids = p.base.uuids.slice(1); fs.writeFileSync(f, JSON.stringify(p)); } }, path: 'no-base' },
    // (The prepare that runs past its deadline is stopped there and writes no plan: tests/lib/prepare-shadow.test.js "a run
    // that hangs is stopped at its deadline end to end"; here, no plan is the corrupt-plan row's own fallback.)
    // The confirm errors before a compose: the full head trader runs after it.
    'confirm-error': { cli: argv => (argv.includes('--resume') ? { ok: false, timedOut: false, code: 1, output: '', stdout: '' } : null), path: 'confirm', fellBack: true },
    // The confirm hangs to its bound: the full head trader runs after it.
    'confirm-timeout': { cli: argv => (argv.includes('--resume') ? { ok: false, timedOut: true, code: null, output: '', stdout: '' } : null), path: 'confirm', fellBack: true },
  };
  for (const [name, row] of Object.entries(rows)) {
    const { w, fake } = await day({ on: true, beforePass: row.beforePass || {}, cli: row.cli || null });
    const rec = cycleRecords(w)[2];
    assert.strictEqual(rec.prepare.on.path, row.path, `${name}: ${JSON.stringify(rec.prepare.on)}`);
    if (row.reason) assert.strictEqual(rec.prepare.on.reason, row.reason, name);
    const last = headCalls(fake).at(-1);
    assert.ok(!last.argv.includes('--resume') && !('FTH_CONFIRM_BASE' in last.env), `${name}: the full head trader ran last`);
    assert.strictEqual(named(promptOf(last), w), offPrompt, `${name}: the old path's own prompt`);
    if (row.fellBack) assert.deepStrictEqual([rec.prepare.on.confirm.outcome, rec.prepare.on.confirm.fellBack], [name === 'confirm-error' ? 'error' : 'timeout', true], name);
    assert.deepStrictEqual(decided(w), decided(off.w), `${name}: the same results, gate decisions and orders`);
  }
});

test('"on" e2e: an open position at the close (a fill before it): the management cycle as before (not-flat), no confirm, no prepare after', async () => {
  const fill = { [NEXT_BAR]: w => require('../fixtures/mock-exchange').handle(w.state, 'place_order', { accountId: 7, contractId: D.MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {}) };
  const heads = { [NEXT_BAR]: () => [{ result: 'CYCLE RESULT: managed - the open long' }] };
  const off = await day({ beforePass: fill, heads });
  const { w, fake } = await day({ on: true, beforePass: fill, heads });
  const rec = cycleRecords(w)[2];
  assert.strictEqual(rec.prepare.on.path, 'not-flat');
  assert.deepStrictEqual([rec.prepare.made.outcome, rec.prepare.made.why], ['skipped', 'not-flat']);
  assert.deepStrictEqual(forksAt(fake, w, NEXT_BAR), [], 'no confirm at the close');
  assert.deepStrictEqual(decided(w), decided(off.w));
});

test('"on" e2e: the kill switch on: no trade cycle, no confirm, no prepare (as before)', async () => {
  const kill = { [NEXT_BAR]: w => fs.writeFileSync(w.env.FTH_KILL_SWITCH_FILE, 'test\n') };
  const off = await day({ beforePass: kill });
  const { w, fake } = await day({ on: true, beforePass: kill });
  assert.deepStrictEqual(forksAt(fake, w, NEXT_BAR), [], 'no confirm at the close');
  assert.deepStrictEqual(decided(w), decided(off.w));
});

test('"on" e2e (the check can fail): a confirm that trusts the plan over the at-close facts (it says it entered where the facts say pass) makes the decisions differ from the key off', async () => {
  const off = await day();
  // The trusting confirm: at the fork it ends "executed" on the plan's word, whatever the facts say.
  const heads = { [NEXT_BAR]: w => [{ act: () => {} }, ...D.passCycle(w, 'x').slice(0, -1), { result: 'CYCLE RESULT: executed - trade_lifecycle long 1 MNQ (the plan said take)' }] };
  const { w } = await day({ on: true, heads });
  assert.notDeepStrictEqual(decided(w), decided(off.w), 'the comparison sees a confirm that does not decide as the head trader would');
});

test('"on" e2e: a confirm that composes (a real compose_check at the close) and then errs is never followed by a second head trader\'s run: one compose record at the close, no double entry', async () => {
  const TL = require('../../scripts/lib/trading/trade-lifecycle');
  const compose = { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: [{ step: 'setup', skill: 'rejection', read: '15m rejected prior vah up' }], size: 1 } };
  // (The world's own round of roles first: the head trader launches its desk here, and the desk rule holds compose_check.)
  const heads = { [NEXT_BAR]: w => [...D.passCycle(w, 'x').slice(0, -1), compose, { result: 'CYCLE RESULT: planned - trade_lifecycle long 1' }] };
  // The confirm's CLI plays its run (the compose reaches the real harness tools server), then exits in error.
  const { w, fake } = await day({ on: true, heads, afterRun: argv => (argv.includes('--resume') ? { ok: false, timedOut: false, code: 1, output: '', stdout: '' } : null) });
  const rec = cycleRecords(w)[2];
  assert.strictEqual(rec.prepare.on.path, 'confirm');
  assert.deepStrictEqual([rec.prepare.on.confirm.outcome, rec.prepare.on.confirm.fellBack], ['error', false], 'composed: no fallback');
  const at = headCalls(fake).filter(c => c.env.FTH_CYCLE_BARS && JSON.parse(c.env.FTH_CYCLE_BARS).MNQ === NEXT_BAR);
  assert.strictEqual(at.length, 1, 'one head trader\'s run at the close: the confirm, never a second');
  const records = TL.readRecords(w.home, 'MNQ').filter(r => r.bar === NEXT_BAR);
  assert.strictEqual(records.length, 1, `exactly one compose record at the close (${JSON.stringify(TL.readRecords(w.home, 'MNQ').map(r => r.bar))})`);
  assert.deepStrictEqual(D.placedAtBroker(w), [], 'no order: the confirm failed, nothing ran after it');
});
