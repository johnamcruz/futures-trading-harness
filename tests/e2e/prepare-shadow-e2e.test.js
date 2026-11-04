'use strict';

/**
 * Prepare ahead, shadow mode (PR B1) end to end, in replay: the decision-path world (tests/fixtures/decision-path.js:
 * the live runner as the harness wires it, Claude Code's head trader scripted, the mock exchange as a replay broker
 * behind the real adapter and the real order gateway) with prepareAhead "shadow", the shadow runs played by a fake
 * Claude Code that keeps sessions as the CLI does (tests/fixtures/fake-claude-sessions.js: --resume --fork-session, the
 * plugin's real SessionStart hook, --allowedTools under dontAsk). The flow: the cycle at the 04:09 bar's close, then the
 * prepare of the 04:12 bar's plan (a 15m close: reactions in reach); at the 04:15 close the cycle, then the shadow confirm
 * of that plan and the next prepare. And the property: the old path's outputs are the same with the key off and in
 * shadow (the shadow adds only the cycle log's `prepare` field), whatever the shadow runs try.
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

/**
 * The shadow runs as a model might play them, trying everything it must not: compose_check, an order, a subagent,
 * a bars fetch (each refused by the narrower --allowedTools, never reaching its tool), then its plan or its decision.
 */
const shadowScript = (o = {}) => (prompt, _env, { resumed }) => [
  { harness: 'bar_briefing', args: { symbol: 'MNQ', json: true } },
  { harness: 'compose_check', args: { symbol: 'MNQ', side: 'long', reads: [{ step: 'setup', skill: 'rejection', read: '15m rejected prior vah up' }], size: 1 } },
  { broker: 'place_order', args: { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40, type: 'stop' }, rationale: 'setup:trade_lifecycle long' } },
  { broker: 'journal_add', args: { kind: 'plan', text: 'shadow plan', contractId: 'MNQ' } },
  { harness: 'bars_fetch', args: { symbol: 'MNQ', minutes: 1, count: 5 } },
  { role: 'trade-executor', lookups: [], report: 'EXECUTED' },
  // Shell commands: a read-only one (approved without a rule), a reading script the prepare is allowed, a bars fetch
  // and a write (refused: no rule allows them).
  { bash: 'echo checking' },
  { bash: `node ${D.ROOT}/scripts/strategies.js list` },
  { bash: `node ${D.ROOT}/scripts/bars.js --symbol MNQ` },
  { bash: 'rm -rf /tmp/x' },
  { result: resumed
    ? (o.decision ? o.decision(prompt) : `DECISION: TAKE ${(/Your plan said: scenario (\d+)/.exec(prompt) || [])[1]}`)
    : [...prompt.matchAll(/^ {2}- (P\d+) \S+ (long|short) "([^"]+)"/gm)].map((m, j) => `SCENARIO ${j + 1}: ${m[1]} "${m[3]}" → TAKE if the 15m closes as listed | PASS if not; reads: "${m[3]}"; why: the bias`).concat(['STAND DOWN if: a news window', 'INVALID if: a fill', 'PLAN END']).join('\n') },
];

/** A replay day of the three bars: each pass's head trader passes; `shadow` turns prepareAhead on with the fake CLI. */
async function day({ shadow = false, script = shadowScript(), kill = null, preHooks = true, fill = null, cfg = {}, heads = {}, acts = {}, before: beforePass = {} } = {}) {
  const w = D.world({ harness: 'claude' });
  w.cfg = { ...w.cfg, ...cfg, ...(shadow ? { prepareAhead: 'shadow' } : {}) };
  const fake = fakeClaude({ dir: path.join(w.home, 'claude-sessions'), script, preHooks });
  const passes = [];
  for (const bar of BARS) {
    if (kill === bar) fs.writeFileSync(w.env.FTH_KILL_SWITCH_FILE, 'test\n');
    // A fill before this bar's cycle (an entry of the old path's, at the exchange): the account is no longer flat.
    if (fill === bar) require('../fixtures/mock-exchange').handle(w.state, 'place_order', { accountId: 7, contractId: D.MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {});
    const at = decisionAt(bar);
    if (beforePass[bar]) beforePass[bar](w);
    const before = require('../fixtures/mock-exchange').read(w.state).calls.length;
    const head = heads[bar] ? heads[bar](w) : fill && Date.parse(bar) >= Date.parse(fill) ? [{ result: 'CYCLE RESULT: managed - the open long' }] : D.passCycle(w, 'nothing to take');
    const r = await D.pass(w, at, [...(acts[bar] ? [{ act: () => acts[bar](w) }] : []), ...head], shadow ? { runPrepare: env => (c, kind, prompt, limits) => runPrepare(c, kind, prompt, limits, { root: D.ROOT, home: w.home, env, run: fake }) } : {});
    passes.push({ ...r, brokerCalls: require('../fixtures/mock-exchange').read(w.state).calls.slice(before).map(c => c.tool) });
  }
  return { w, fake, passes };
}

/**
 * The shadow confirms of the plan made for `bar`'s close (forks resuming its prepare's session). The 04:06 cycle's
 * prepare lists the 15m reaction still standing at the 04:12 close (next-close.js standing candidates), so the 04:09 bar
 * has a plan and a shadow confirm of its own: the tests below are about the 04:12 bar's.
 */
const forksAt = (fake, w, bar) => {
  const plan = PA.readPlan(w.home, 'MNQ', bar);
  assert.ok(plan, `a plan for the bar opening ${bar}`);
  return fake.calls.filter(c => c.source === 'fork' && c.argv[c.argv.indexOf('--resume') + 1] === plan.session.id);
};

const cycleRecords = w => {
  const dir = path.join(w.home, 'logs', 'cycles');
  return fs.readdirSync(dir).sort().flatMap(d => fs.readdirSync(path.join(dir, d)).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, d, f), 'utf8'))));
};
/**
 * What the old path decided and did: every cycle record but the shadow's own field and the wall-clock ones (`at` the
 * wall time it was written, durationMs, timing; the transcript's run-local ids), the gate's decisions, the broker's
 * orders, the journal and the runner's decision history; each world's home path named alike.
 */
const oldPath = w => JSON.parse(JSON.stringify({
  cycles: cycleRecords(w).map(({ prepare: _p, at: _a, durationMs: _d, timing: _t, transcript: _x, summary, ...rest }) => ({ ...rest, summary: { tools: summary.tools, skills: summary.skills, orders: summary.orders } })),
  gate: D.gateLog(w).map(({ ts: _ts, at: _at, ...e }) => e),
  orders: D.placedAtBroker(w),
  journal: fs.readFileSync(w.journal, 'utf8'),
  state: JSON.parse(fs.readFileSync(w.stateFile, 'utf8')).history,
}).split(w.home).join('<home>'));

test('shadow e2e: the cycle, then the prepare (its plan written with its session); at the plan\'s close the cycle, then the shadow confirm on a fork of that session, logged beside the cycle\'s decision', async () => {
  const { w, fake, passes } = await day({ shadow: true });
  const recs = cycleRecords(w);
  assert.strictEqual(recs.length, 3);
  // 04:09's cycle: its own plan (a 15m reaction standing at its close, made after 04:06's cycle) and its shadow confirm;
  // then the prepare for 04:12's bar.
  assert.strictEqual(recs[1].prepare.shadow.status, 'valid', JSON.stringify(recs[1].prepare.shadow));
  assert.ok(PA.readPlan(w.home, 'MNQ', FIRED_BAR).candidates.some(c => c.kind === 'standing' && c.read === recs[1].prepare.shadow.match.read));
  // Its shadow confirm says what "on" says at a standing close (PR C3: shadow parity): the standing line, once.
  {
    const [c1, ...more] = forksAt(fake, w, FIRED_BAR);
    assert.ok(c1 && !more.length);
    const p1 = c1.argv[c1.argv.indexOf('-p') + 1];
    const k = recs[1].prepare.shadow.match.k;
    assert.strictEqual(p1.split(PA.standingLine(k)).length, 2, p1);
    assert.ok(p1.endsWith(`DECISION: TAKE ${k} | DECISION: PASS - <why>.`));
  }
  const made = recs[1].prepare.made;
  assert.strictEqual(made.outcome, 'done', JSON.stringify(recs[1].prepare));
  const plan = PA.readPlan(w.home, 'MNQ', NEXT_BAR);
  assert.ok(plan && plan.id === made.planId);
  assert.ok(plan.candidates.length > 0 && plan.candidates.every(c => c.kind === 'reaction'), 'a 15m close: reactions in reach');
  assert.strictEqual(plan.scenarios.length, plan.candidates.length);
  const prep = fake.calls.find(c => c.source === 'startup' && c.session === plan.session.id);
  assert.ok(prep, 'the prepare\'s own session');
  assert.strictEqual(plan.session.transcript, fake.file(plan.session.id), 'the transcript from the SessionStart hook\'s record');
  assert.strictEqual(prep.env.FTH_PREPARE, 'prepare');
  assert.deepStrictEqual(prep.ran, ['echo checking', `node ${D.ROOT}/scripts/strategies.js list`], 'a read-only command and a reading script run; the bars fetch and the write are refused');
  // Every forbidden call refused, none reaching its tool: compose_check and the order by their hooks (the desk rule, the
  // order gate: the CLI runs PreToolUse hooks before the permission check), the rest by the narrower tools (dontAsk).
  assert.deepStrictEqual(prep.hooked.filter(h => h.code === 2).map(h => h.name), ['mcp__harness__compose_check', 'mcp__broker__place_order']);
  assert.deepStrictEqual(prep.refused, ['mcp__broker__journal_add', 'mcp__harness__bars_fetch', 'Agent', 'Bash', 'Bash']);
  // The record counts every attempt from the run's own transcript, the hooks' refusals with the CLI's denials.
  assert.deepStrictEqual(made.forbidden, ['mcp__harness__compose_check', 'mcp__broker__place_order', 'mcp__broker__journal_add', 'mcp__harness__bars_fetch', 'Agent', 'Bash', 'Bash']);
  // 04:12's cycle (the plan's close): the shadow confirm, a fork of the prepare's session.
  const sh = recs[2].prepare.shadow;
  assert.strictEqual(sh.planId, plan.id);
  // Valid at 04:15 (nothing it rested on changed), and what fired is one of its scenarios: the 15m rejection of the prior VAH.
  assert.deepStrictEqual([sh.status, sh.match.read, sh.fired], ['valid', '15m rejected prior vah up', ['15m rejected prior vah up']], JSON.stringify(sh));
  {
    const [conf, ...more] = forksAt(fake, w, NEXT_BAR);
    assert.ok(conf && !more.length, 'the confirm forked the prepare\'s session, once');
    assert.strictEqual(conf.argv[conf.argv.indexOf('--resume') + 1], plan.session.id);
    assert.notStrictEqual(conf.session, plan.session.id, 'a new session of its own');
    // The fork's transcript: the prepare's lines with their own uuids, each stamped with the fork's session.
    const lines = fs.readFileSync(fake.file(conf.session), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const orig = fs.readFileSync(fake.file(plan.session.id), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepStrictEqual(lines.slice(0, orig.length).map(l => l.uuid), orig.map(l => l.uuid));
    assert.ok(lines.every(l => l.sessionId === conf.session));
    assert.strictEqual(conf.env.FTH_PREPARE, 'confirm');
    assert.deepStrictEqual(sh.confirm.decision && sh.confirm.decision.decision, 'take');
    assert.deepStrictEqual(sh.full, { decision: 'pass', side: null, why: null });
    assert.strictEqual(sh.agreesWithFull, false, 'a take beside the cycle\'s pass: a disagreement');
  }
  // The runner's tap: the shadow runs are no cycles (three cycles, three cycle events).
  assert.deepStrictEqual(passes.map(p => p.ran.length), [1, 1, 1]);
  assert.ok(passes.every(p => !p.events.some(e => /prepare|shadow/.test(e.kind))), 'no event of its own');
});

test('shadow e2e (the property): the old path is the same with prepareAhead off and in shadow, whatever the shadow runs try; the shadow adds only its plan files, its sessions and the cycle log\'s prepare field', async () => {
  const off = await day({ shadow: false });
  const on = await day({ shadow: true });
  assert.deepStrictEqual(oldPath(on.w), oldPath(off.w));
  // Off: no prepare field, no plan file, no shadow run.
  assert.ok(cycleRecords(off.w).every(r => !('prepare' in r)));
  assert.ok(!fs.existsSync(path.join(off.w.home, 'prepare')));
  assert.deepStrictEqual(off.fake.calls, []);
  // On: nothing reached the broker or the gate from the shadow runs (their tries refused), no compose record of theirs.
  assert.deepStrictEqual(D.placedAtBroker(on.w), []);
  assert.ok(D.gateLog(on.w).every(e => !/place_order|compose/.test(String(e.tool || ''))), 'no order or compose went to the gate');
  assert.ok(on.fake.calls.length >= 1);
});

test('shadow e2e (the property, a fill): a position opens before the plan\'s close (04:12): the cycle manages it, the plan is void (the facts key), no prepare after; off and shadow give the same old path', async () => {
  const off = await day({ fill: NEXT_BAR });
  const on = await day({ shadow: true, fill: NEXT_BAR });
  assert.ok(D.position(on.w), 'the position is open');
  assert.deepStrictEqual(oldPath(on.w), oldPath(off.w));
  const last = cycleRecords(on.w).at(-1);
  assert.match(last.result, /^CYCLE RESULT: managed/);
  assert.deepStrictEqual([last.prepare.shadow.status, last.prepare.shadow.reason], ['void', 'facts']);
  assert.deepStrictEqual([last.prepare.made.outcome, last.prepare.made.why], ['skipped', 'not-flat']);
  assert.deepStrictEqual(forksAt(on.fake, on.w, NEXT_BAR), [], 'no confirm at the close');
});

test('shadow e2e: a manage-only cycle (the day\'s cap reached, a position open) runs no shadow: no prepare field and no extra account read', async () => {
  const cfg = { maxCyclesPerDay: 1 };
  const off = await day({ fill: NEXT_BAR, cfg });
  const on = await day({ shadow: true, fill: NEXT_BAR, cfg });
  const last = cycleRecords(on.w).at(-1);
  assert.strictEqual(last.context.manageOnly, true, 'the cycle after the cap is manage-only');
  assert.ok(!('prepare' in last));
  assert.deepStrictEqual(on.passes.at(-1).brokerCalls, off.passes.at(-1).brokerCalls, 'no broker call of its own');
  assert.deepStrictEqual(oldPath(on.w), oldPath(off.w));
});

test('shadow e2e: a cycle that failed (the head trader\'s error, a timeout) runs no shadow', async () => {
  const heads = { [FIRED_BAR]: () => [{ result: 'CYCLE RESULT: error - the model lost the thread' }] };
  const on = await day({ shadow: true, heads });
  const rec = cycleRecords(on.w).find(r => /CYCLE RESULT: error/.test(r.result || ''));
  assert.ok(rec, 'the failed cycle');
  assert.ok(!('prepare' in rec), JSON.stringify(rec.prepare));
});

test('shadow e2e: the shadow\'s own account reads leave no line in the old path\'s log when they fail', async () => {
  // The broker's account read fails from the 04:12 pass on: the cycle's own read fails in both worlds alike, and the
  // shadow's read after it fails too, silently.
  const before = { [NEXT_BAR]: w => require('../fixtures/mock-exchange').update(w.state, s => { s.failBalance = true; }) };
  const off = await day({ before });
  const on = await day({ shadow: true, before });
  assert.ok(off.passes.at(-1).logs.some(l => /account state for the prompt unavailable/.test(l)), 'the old path\'s own read failed and said so');
  assert.deepStrictEqual(on.passes.map(p => p.logs), off.passes.map(p => p.logs));
  assert.deepStrictEqual(oldPath(on.w), oldPath(off.w));
});

test('shadow e2e: the full cycle takes the trade (a fill at its close): the confirm runs beside the fresh position on the inputs the cycle started from, a take beside a take; no prepare after', async () => {
  const heads = { [NEXT_BAR]: () => [{ result: 'CYCLE RESULT: executed - trade_lifecycle long 1 MNQ' }] };
  const acts = { [NEXT_BAR]: w => require('../fixtures/mock-exchange').handle(w.state, 'place_order', { accountId: 7, contractId: D.MNQ_ID, side: 'buy', type: 'market', size: 1, stopLossBracket: { ticks: 40 } }, {}) };
  const on = await day({ shadow: true, heads, acts });
  const p = cycleRecords(on.w).at(-1).prepare;
  assert.strictEqual(p.shadow.status, 'valid', JSON.stringify(p.shadow));
  assert.deepStrictEqual(p.shadow.full, { decision: 'take', side: 'long', why: null });
  assert.deepStrictEqual(p.shadow.confirm.decision, { decision: 'take', k: p.shadow.match.k, side: 'long' });
  assert.strictEqual(p.shadow.agreesWithFull, true);
  assert.deepStrictEqual([p.made.outcome, p.made.why], ['skipped', 'not-flat']);
});

test('shadow e2e: several trading lanes run no shadow (one lane only in v1)', async () => {
  const { validateConfig } = require('../../scripts/lib/autotrader');
  const w = D.world({ harness: 'claude', dataLane: true });
  w.cfg = { ...validateConfig({ harness: 'claude', cycle: 'full', premarketAt: '', account: '7', symbols: ['MNQ'], dataDir: w.cfg.dataDir, bars: 1400, lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal' }] }), prepareAhead: 'shadow' };
  const fake = fakeClaude({ dir: path.join(w.home, 'claude-sessions'), script: shadowScript() });
  const opts = { runPrepare: env => (c, kind, prompt, limits) => runPrepare(c, kind, prompt, limits, { root: D.ROOT, home: w.home, env, run: fake }) };
  for (const bar of [FIRED_BAR, NEXT_BAR]) await D.pass(w, decisionAt(bar), D.passCycle(w, 'x'), opts);
  const recs = cycleRecords(w);
  assert.ok(recs.length >= 1);
  assert.ok(recs.every(r => !('prepare' in r)));
  assert.deepStrictEqual(fake.calls, []);
});

test('shadow e2e: paper mode: no shadow run and no prepare field', async () => {
  for (const extra of [{ paper: true }]) {
    const w = D.world({ harness: 'claude' });
    w.cfg = { ...w.cfg, prepareAhead: 'shadow', ...extra };
    const fake = fakeClaude({ dir: path.join(w.home, 'claude-sessions'), script: shadowScript() });
    const opts = { runPrepare: env => (c, kind, prompt, limits) => runPrepare(c, kind, prompt, limits, { root: D.ROOT, home: w.home, env, run: fake }) };
    for (const bar of BARS) await D.pass(w, decisionAt(bar), D.passCycle(w, 'x'), opts);
    const recs = cycleRecords(w).filter(r => extra.paper || r.context.manageOnly === true);
    assert.ok(recs.length >= 1, `${JSON.stringify(extra)}: such a cycle ran`);
    for (const r of recs) assert.ok(!('prepare' in r), `${JSON.stringify(extra)}: ${JSON.stringify(r.prepare)}`);
    if (extra.paper) assert.deepStrictEqual(fake.calls, []);
  }
});

test('shadow e2e: the CLI runs PreToolUse hooks before dontAsk refuses a call: a shadow run\'s order attempt is refused by the order gate\'s hook into the shadow\'s own gate log; the old path\'s gate log is unchanged, the attempt counted', async () => {
  const off = await day({ shadow: false });
  const on = await day({ shadow: true });
  assert.deepStrictEqual(oldPath(on.w).gate, oldPath(off.w).gate, 'the old path\'s gate log as with the key off');
  assert.deepStrictEqual(oldPath(on.w), oldPath(off.w));
  const shadowLog = PA.shadowGateLog(on.w.home);
  assert.ok(fs.existsSync(shadowLog), 'the hook\'s refusal went to the shadow\'s gate log');
  const lines = fs.readFileSync(shadowLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.length >= 1 && lines.every(e => e.source === 'hook' && e.decision === 'blocked' && e.tool === 'place_order'), JSON.stringify(lines));
  const made = cycleRecords(on.w)[1].prepare.made;
  assert.ok(made.gateRefusals >= 1, JSON.stringify(made));
  assert.deepStrictEqual(made.denied, ['mcp__broker__journal_add', 'mcp__harness__bars_fetch', 'Agent', 'Bash', 'Bash'], 'the CLI\'s own denials: not the calls a hook refused first');
  assert.deepStrictEqual(made.forbidden, ['mcp__harness__compose_check', 'mcp__broker__place_order', 'mcp__broker__journal_add', 'mcp__harness__bars_fetch', 'Agent', 'Bash', 'Bash'], 'every attempt, from the transcript');
  assert.deepStrictEqual(D.placedAtBroker(on.w), []);
});

test('shadow e2e: the agreement check can fail and can hold: a PASS beside the cycle\'s pass agrees', async () => {
  const { w } = await day({ shadow: true, script: shadowScript({ decision: () => 'DECISION: PASS - the candle did not meet it' }) });
  const sh = cycleRecords(w)[2].prepare.shadow;
  assert.strictEqual(sh.status, 'valid');
  assert.deepStrictEqual(sh.confirm.decision, { decision: 'pass', k: null, side: null });
  assert.strictEqual(sh.agreesWithFull, true);
});

test('shadow e2e: the kill switch on: no shadow confirm, no prepare (on before the close: no trade cycle at all; turned on during the cycle: the shadow stands down after it)', async () => {
  const a = await day({ shadow: true, kill: NEXT_BAR });
  assert.strictEqual(cycleRecords(a.w).length, 2, 'no trade cycle under the kill switch');
  assert.deepStrictEqual(forksAt(a.fake, a.w, NEXT_BAR), [], 'no confirm at the close');
  // On during the plan's close's cycle (the head trader's run arms it): the shadow neither confirms nor prepares.
  const w = D.world({ harness: 'claude' });
  w.cfg = { ...w.cfg, prepareAhead: 'shadow' };
  const fake = fakeClaude({ dir: path.join(w.home, 'claude-sessions'), script: shadowScript() });
  const opts = { runPrepare: env => (c, kind, prompt, limits) => runPrepare(c, kind, prompt, limits, { root: D.ROOT, home: w.home, env, run: fake }) };
  await D.pass(w, decisionAt(FIRED_BAR), D.passCycle(w, 'x'), opts);
  const n = fake.calls.length;
  await D.pass(w, decisionAt(NEXT_BAR), [{ act: () => fs.writeFileSync(w.env.FTH_KILL_SWITCH_FILE, 'test\n') }, ...D.passCycle(w, 'x')], opts);
  const p = cycleRecords(w).at(-1).prepare;
  assert.deepStrictEqual([p.shadow.status, p.made.outcome, p.made.why], ['kill-switch', 'skipped', 'kill-switch']);
  assert.strictEqual(fake.calls.length, n, 'no shadow run');
});

test('shadow e2e: the prepare session lost (its transcript gone) before the close: void, no confirm', async () => {
  const w = D.world({ harness: 'claude' });
  w.cfg = { ...w.cfg, prepareAhead: 'shadow' };
  const fake = fakeClaude({ dir: path.join(w.home, 'claude-sessions'), script: shadowScript() });
  const opts = { runPrepare: env => (c, kind, prompt, limits) => runPrepare(c, kind, prompt, limits, { root: D.ROOT, home: w.home, env, run: fake }) };
  await D.pass(w, decisionAt(FIRED_BAR), D.passCycle(w, 'x'), opts);
  const plan = PA.readPlan(w.home, 'MNQ', NEXT_BAR);
  assert.ok(plan);
  fs.unlinkSync(fake.file(plan.session.id));
  await D.pass(w, decisionAt(NEXT_BAR), D.passCycle(w, 'x'), opts);
  const sh = cycleRecords(w).at(-1).prepare.shadow;
  assert.deepStrictEqual([sh.status, sh.reason], ['void', 'session-missing']);
  assert.deepStrictEqual(forksAt(fake, w, NEXT_BAR), [], 'no confirm at the close');
});
