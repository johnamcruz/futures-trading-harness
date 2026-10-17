'use strict';

// The tool-call layer (docs/TOOL-CALLS-AND-ORCHESTRATION.md): the rules (scripts/lib/toolcall/rules.js) through the
// pipeline, with opencode's names (toolcall/names.js), its call log in memory; the registry's contract; Claude's names.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { RULES, deniedRolesOf } = require('../../scripts/lib/toolcall/rules');
const { createPipeline } = require('../../scripts/lib/toolcall/pipeline');
const { createCallLog } = require('../../scripts/lib/toolcall/call-log');
const N = require('../../scripts/lib/toolcall/names');
const { declaredEvents, DISPATCHER } = require('../../scripts/lib/toolcall/hooks');
const { tmpDir, FAKE_BROKERS } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const pipe = (env = {}, now = () => Date.now()) => createPipeline({ log: createCallLog(), env, now, native: N.toOpencode });
const call = (name, args, session = 's', id = null) => ({ tool: N.fromOpencode(name), name, args, session, id });
const pre = (p, name, args, session, id) => p.before(call(name, args, session, id)).refuse;
const post = (p, name, args, session, id, text) => p.after(call(name, args, session, id), { text }).note;

test('names: one canonical name per tool, from and back to opencode\'s and Claude\'s', () => {
  assert.strictEqual(N.fromOpencode('harness_compose_check'), 'harness.compose_check');
  assert.strictEqual(N.fromOpencode('broker_place_order'), 'broker.place_order');
  assert.strictEqual(N.fromOpencode('task'), 'task');
  assert.strictEqual(N.toOpencode('harness.compose_check'), 'harness_compose_check');
  assert.strictEqual(N.fromClaude('mcp__harness__compose_check'), 'harness.compose_check');
  assert.strictEqual(N.fromClaude('mcp__plugin_fth_broker__place_order'), 'broker.place_order', 'a plugin\'s server form');
  assert.strictEqual(N.fromClaude('mcp__my_harness__compose_check'), 'my_harness.compose_check', 'another server ending in _harness is not ours');
  assert.strictEqual(N.fromClaude('Agent'), 'task');
  assert.strictEqual(N.fromClaude('Read'), 'read');
  assert.strictEqual(N.toClaude('broker.close_position'), 'mcp__broker__close_position');
  assert.strictEqual(N.toOpencode('task'), 'task');
});

test('task-id: a task_id that names no session (a label, a number, null, an object) is dropped in place; a session id, another tool, or no task_id is left as it is', () => {
  for (const id of ['msa', 'rm1', '', 7, null, {}, ['ses_x']]) {
    const args = { subagent_type: 'risk-manager', prompt: 'p', task_id: id };
    assert.strictEqual(pre(pipe(), 'task', args), null, JSON.stringify(id));
    assert.deepStrictEqual(args, { subagent_type: 'risk-manager', prompt: 'p' }, JSON.stringify(id));
  }
  const resume = { subagent_type: 'risk-manager', task_id: 'ses_eb993c3b1ffekqL45GDgHQpdeZ' };
  pre(pipe(), 'task', resume);
  assert.strictEqual(resume.task_id, 'ses_eb993c3b1ffekqL45GDgHQpdeZ');
  const other = { task_id: 'msa' };
  pre(pipe(), 'read', other);
  assert.strictEqual(other.task_id, 'msa');
  for (const args of [{ subagent_type: 'risk-manager' }, null, undefined]) assert.strictEqual(pre(pipe(), 'task', args), null);
});

test('denied-role: a role launch the run denies is refused with the same text every cycle; any other launch runs', () => {
  const env = { FTH_DENIED_ROLES: 'market-structure-analyst, strategy-researcher' };
  assert.deepStrictEqual(deniedRolesOf(env), ['market-structure-analyst', 'strategy-researcher']);
  assert.match(pre(pipe(env), 'task', { subagent_type: 'market-structure-analyst' }), /^\[denied-role\] market-structure-analyst is not launched this cycle/);
  assert.match(pre(pipe(env), 'task', { subagent_type: ' strategy-researcher ' }), /^\[denied-role\]/);
  for (const args of [{ subagent_type: 'risk-manager' }, {}, null]) assert.strictEqual(pre(pipe(env), 'task', args), null);
  assert.strictEqual(pre(pipe({}), 'task', { subagent_type: 'market-structure-analyst' }), null, 'no list: nothing refused');
});

test('tool-name: a call opencode sent to its invalid tool names the harness or broker tool meant; anything else is opencode\'s own answer', () => {
  assert.strictEqual(pre(pipe(), 'invalid', { tool: 'compose_check', error: 'x' }), '[tool-name] "compose_check" is not a tool here: call harness_compose_check with the same arguments.');
  assert.match(pre(pipe(), 'invalid', { tool: 'mcp__harness__bar_briefing' }), /call harness_bar_briefing /);
  assert.match(pre(pipe(), 'invalid', { tool: 'harness.order_plan' }), /call harness_order_plan /);
  assert.match(pre(pipe(), 'invalid', { tool: 'get_account_snapshot' }), /call broker_get_account_snapshot /);
  for (const args of [{ tool: 'nope' }, { tool: 'harness_compose_check' }, {}, null, { tool: 7 }]) assert.strictEqual(pre(pipe(), 'invalid', args), null, JSON.stringify(args));
  assert.strictEqual(pre(pipe(), 'read', { tool: 'compose_check' }), null, 'only the invalid tool');
  // Claude's names in the route, where Claude runs the rule.
  const claude = createPipeline({ log: createCallLog(), env: {}, native: N.toClaude });
  assert.match(claude.before({ tool: 'invalid', name: 'invalid', args: { tool: 'compose_check' }, session: 's' }).refuse, /call mcp__harness__compose_check /);
});

test('repeat: an identical call that failed is answered with the reminder from the first count on; one that succeeds gets it after its result at each count; per session; order tools and launches untouched', () => {
  let t = 0;
  const clock = () => t;
  const g = pipe({}, clock);
  const failing = Array.from({ length: 6 }, () => { t += 5000; return pre(g, 'harness_market_snapshot', { bars: '/workspace/x.json' }, 's1'); });
  assert.deepStrictEqual(failing.map(Boolean), [false, false, true, true, true, true]);
  assert.match(failing[2], /^\[repeat\] You are repeating the exact same tool call with identical arguments/);
  assert.match(failing[3], /^\[repeat\] You have called harness_market_snapshot 4 times in a row with the same arguments\. It will not change/);
  assert.strictEqual(pre(g, 'harness_market_snapshot', { bars: '/right.json' }, 's1'), null, 'new arguments run');
  assert.strictEqual(pre(g, 'harness_market_snapshot', { bars: '/workspace/x.json' }, 's2'), null, 'another session counts its own');
  const par = pipe({}, clock);
  assert.deepStrictEqual([1, 2, 3, 4].map(i => pre(par, 'harness_bar_briefing', { symbol: 'MNQ' }, 'p', `c${i}`)), [null, null, null, null]);
  const twin = pipe({}, clock);
  pre(twin, 'harness_market_snapshot', { bars: '/x' }, 'w', 'a');
  pre(twin, 'harness_market_snapshot', { bars: '/x' }, 'w', 'b');
  post(twin, 'harness_market_snapshot', {}, 'w', 'b');
  t += 5000;
  assert.match(pre(twin, 'harness_market_snapshot', { bars: '/x' }, 'w', 'c'), /^\[repeat\]/, 'a never returned');
  const ok = pipe({}, clock);
  const notes = [];
  for (let i = 0; i < 8; i += 1) {
    assert.strictEqual(pre(ok, 'harness_bar_briefing', i % 2 ? { json: true, symbol: 'MNQ' } : { symbol: 'MNQ', json: true }, 's'), null);
    notes.push(post(ok, 'harness_bar_briefing', {}, 's', null, 'the same briefing'));
  }
  assert.deepStrictEqual(notes.map(n => Boolean(n)), [false, false, true, false, true, false, false, true]);
  assert.match(notes[2], /^\[repeat\] You are repeating/);
  const moving = pipe({}, clock);
  const moved = [];
  for (let i = 0; i < 5; i += 1) {
    pre(moving, 'harness_skill_lookup', { skill: 'x' }, 'm');
    moved.push(post(moving, 'harness_skill_lookup', {}, 'm', null, `answer ${i}`));
  }
  assert.deepStrictEqual(moved, [null, null, null, null, null]);
  const ids = pipe({}, clock);
  for (let i = 0; i < 4; i += 1) { pre(ids, 'harness_bar_briefing', { symbol: 'MNQ' }, 'i'); t += 5000; post(ids, 'harness_bar_briefing', {}, 'i', `late-${i}`, `b${i}`); }
  assert.strictEqual(pre(ids, 'harness_bar_briefing', { symbol: 'MNQ' }, 'i'), null);
  const ord = pipe({}, clock);
  for (let i = 0; i < 6; i += 1) {
    t += 5000;
    for (const tool of ['broker_close_position', 'broker_get_positions', 'broker_list_open_orders', 'broker_get_account_snapshot', 'task']) assert.strictEqual(pre(ord, tool, { contractId: 'MNQ' }, 's'), null, tool);
  }
  assert.strictEqual(post(ord, 'broker_get_positions', {}, 's', null, 'same'), null);
});

test('desk: the head trader\'s compose_check waits until every role FTH_CYCLE_DESK names reported in its session; nothing else is held', () => {
  const g = pipe({ FTH_CYCLE_DESK: 'market-structure-analyst,trend-momentum-analyst,volume-liquidity-analyst,risk-manager' });
  assert.match(pre(g, 'harness_compose_check', {}, 'h'), /^\[desk\] compose_check composes the trade from the desk's reports: launch market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst, risk-manager first/);
  for (const r of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst']) post(g, 'task', { subagent_type: r }, 'h');
  assert.match(pre(g, 'harness_compose_check', {}, 'h'), /launch risk-manager first/);
  post(g, 'task', { subagent_type: 'risk-manager' }, 'other');
  assert.match(pre(g, 'harness_compose_check', {}, 'h'), /launch risk-manager first/, 'a report in another session is not this one\'s');
  post(g, 'task', { subagent_type: ' risk-manager ' }, 'h');
  assert.strictEqual(pre(g, 'harness_compose_check', {}, 'h'), null, 'the desk reported');
  const fresh = pipe({ FTH_CYCLE_DESK: 'risk-manager' });
  for (const t of ['task', 'broker_close_position', 'broker_cancel_order', 'broker_modify_order', 'broker_get_positions', 'harness_bar_briefing', 'harness_order_plan']) assert.strictEqual(pre(fresh, t, {}, 'h'), null, t);
  for (const env of [{}, { FTH_CYCLE_DESK: '' }, { FTH_CYCLE_DESK: ' , ' }]) assert.strictEqual(pre(pipe(env), 'harness_compose_check', {}, 'h'), null, JSON.stringify(env));
  const both = pipe({ FTH_CYCLE_DESK: 'market-structure-analyst,risk-manager', FTH_DENIED_ROLES: 'market-structure-analyst' });
  assert.match(pre(both, 'harness_compose_check', {}, 'h'), /launch risk-manager first/);
  post(both, 'task', { subagent_type: 'risk-manager' }, 'h');
  assert.strictEqual(pre(both, 'harness_compose_check', {}, 'h'), null);
});

test('review: in the runner\'s runs, compose_check on a symbol with an entry today that has no review is refused with the route; reviewed, another symbol, or outside a runner: it goes; an unreadable journal refuses it', () => {
  const home = tmpDir();
  const journal = path.join(home, 'journal.jsonl');
  const ts = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(journal, `${JSON.stringify({ ts, kind: 'order_placed', contractId: 'MNQ', orderId: 101, text: 'setup:trade_lifecycle long', data: { result: { success: true, orderId: 101 } } })}\n`);
  const env = { FTH_AUTONOMOUS: '1', FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_JOURNAL: journal };
  const refusal = pre(pipe(env), 'harness_compose_check', { symbol: 'mnq', side: 'long' }, 'h');
  assert.strictEqual(refusal, '[review] 1 earlier MNQ entry today has no review, so no new MNQ trade (the order gate refuses it). An open one: manage it until it closes. A closed or cancelled one: the runner writes its factual review at the next bar; or launch the trade-reviewer for it now. Exits and stops are never held by this.');
  assert.strictEqual(pre(pipe(env), 'harness_compose_check', { symbol: 'MES', side: 'long' }, 'h'), null, 'another symbol');
  assert.strictEqual(pre(pipe({ ...env, FTH_AUTONOMOUS: '' }), 'harness_compose_check', { symbol: 'MNQ' }, 'h'), null, 'outside the runner\'s runs');
  for (const args of [{}, null, { symbol: 7 }]) assert.strictEqual(pre(pipe(env), 'harness_compose_check', args, 'h'), null, `${JSON.stringify(args)}: compose_check answers it`);
  for (const t of ['broker_close_position', 'broker_cancel_order', 'broker_modify_order', 'broker_place_order', 'harness_bar_briefing', 'task']) assert.strictEqual(pre(pipe(env), t, { symbol: 'MNQ', contractId: 'MNQ' }, 'h'), null, t);
  // The runner's review (or the trade-reviewer's) clears it.
  fs.appendFileSync(journal, `${JSON.stringify({ ts, kind: 'review', contractId: 'MNQ', orderId: 101, text: 'runner: nofill', tags: ['by:runner', 'result:nofill'] })}\n`);
  assert.strictEqual(pre(pipe(env), 'harness_compose_check', { symbol: 'MNQ' }, 'h'), null, 'reviewed');
  // A journal that can't be read: refused (it fails closed, as the gate would).
  assert.match(pre(pipe({ ...env, FAKE_BROKER_JOURNAL: home }), 'harness_compose_check', { symbol: 'MNQ' }, 'h'), /^\[review\] the check failed \(.*\): refused \(it fails closed\)\.$/);
});

test('the registry\'s contract: every rule has an id, an event and a matcher; no rule that can refuse matches an order or exit tool; only the review and the desk fail closed', () => {
  const { TOOLS } = require('../../scripts/lib/broker/interface');
  const orders = Object.keys(TOOLS).filter(t => TOOLS[t].role === 'order').map(t => `broker.${t}`);
  assert.ok(orders.includes('broker.close_position') && orders.includes('broker.cancel_order'));
  const ids = RULES.map(r => r.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique');
  for (const r of RULES) {
    assert.ok(typeof r.id === 'string' && ['pre', 'post'].includes(r.event) && typeof r.match === 'function' && typeof r.check === 'function', r.id);
    if (r.event === 'pre') for (const o of orders) assert.strictEqual(r.match({ tool: o, args: {} }), false, `${r.id} never matches ${o}`);
  }
  assert.deepStrictEqual(RULES.filter(r => r.failClosed).map(r => r.id), ['review', 'desk']);
});

test('the pipeline: the first refusal is final; a rule that throws refuses only when it fails closed; a post rule that throws adds nothing; misuse is loud', () => {
  const log = createCallLog();
  const boom = { id: 'boom', event: 'pre', failClosed: false, match: () => true, check: () => { throw new Error('x'); } };
  const shut = { id: 'shut', event: 'pre', failClosed: true, match: () => true, check: () => { throw new Error('y'); } };
  const no = { id: 'no', event: 'pre', failClosed: false, match: () => true, check: () => ({ refuse: '[no] stop' }) };
  const later = { id: 'later', event: 'pre', failClosed: false, match: () => true, check: () => { throw new Error('never reached'); } };
  const c = { tool: 'harness.x', name: 'harness_x', args: {}, session: 's' };
  assert.strictEqual(createPipeline({ rules: [boom], log }).before(c).refuse, null);
  assert.strictEqual(createPipeline({ rules: [shut], log }).before(c).refuse, '[shut] the check failed (y): refused (it fails closed).');
  assert.strictEqual(createPipeline({ rules: [no, later], log }).before(c).refuse, '[no] stop');
  const p = { id: 'p', event: 'post', failClosed: false, match: () => true, check: () => { throw new Error('z'); } };
  assert.deepStrictEqual(createPipeline({ rules: [p], log }).after(c, { text: 'r' }), { note: null });
  assert.throws(() => createPipeline({}), TypeError);
});

test('the call log: in memory one state per rule and session; in a file append-only, the state rebuilt by replay, parallel processes losing nothing', async () => {
  const { readEvents, appendEvent, replayEvents } = require('../../scripts/lib/toolcall/call-log');
  const m = createCallLog();
  m.state('repeat', 's').n = 3;
  assert.strictEqual(m.state('repeat', 's').n, 3);
  assert.deepStrictEqual(m.state('repeat', 'other'), {});
  const file = path.join(tmpDir(), 'logs', 'toolcall', 's.jsonl');
  assert.deepStrictEqual(readEvents(file), [], 'no file: no events');
  appendEvent(file, { event: 'post', call: { tool: 'task', name: 'task', args: { subagent_type: 'risk-manager' }, session: 's' }, result: { text: 'r' }, at: 1 });
  fs.appendFileSync(file, 'torn{\n');
  assert.strictEqual(readEvents(file).length, 1, 'a torn line is skipped');
  const clock = { at: 0 };
  const p = createPipeline({ log: createCallLog(), env: { FTH_CYCLE_DESK: 'risk-manager' }, now: () => clock.at, native: N.toOpencode });
  assert.match(p.before({ tool: 'harness.compose_check', name: 'harness_compose_check', args: {}, session: 's' }).refuse, /^\[desk\]/, 'before the replay: not reported');
  const q = createPipeline({ log: createCallLog(), env: { FTH_CYCLE_DESK: 'risk-manager' }, now: () => clock.at, native: N.toOpencode });
  replayEvents(q, readEvents(file), clock);
  assert.strictEqual(q.before({ tool: 'harness.compose_check', name: 'harness_compose_check', args: {}, session: 's' }).refuse, null, 'replayed: reported');
  // Three hook processes at once (Claude's parallel role launches) each append their report: none is lost.
  const { spawn } = require('child_process');
  const home = tmpDir();
  const hook = path.join(ROOT, 'scripts', 'hooks', 'toolcall.js');
  const one = role => new Promise(res => {
    const c = spawn(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(hook)}).run(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'par', tool_name: 'Agent', tool_input: { subagent_type: ${JSON.stringify(role)} }, tool_response: 'report' }), {}, { env: { FTH_HOME: ${JSON.stringify(home)}, FTH_AUTONOMOUS: '1' } })))`]);
    c.on('exit', res);
  });
  await Promise.all(['market-structure-analyst', 'trend-momentum-analyst', 'risk-manager'].map(one));
  const { run } = require('../../scripts/hooks/toolcall');
  const out = run(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'par', tool_name: 'mcp__harness__compose_check', tool_input: {} }), {}, { env: { FTH_HOME: home, FTH_AUTONOMOUS: '1', FTH_CYCLE_DESK: 'market-structure-analyst,trend-momentum-analyst,risk-manager' } });
  assert.strictEqual(out, '', 'every role\'s report kept: compose goes');
});
test('hooks.json declares the layer: PreToolUse and PostToolUse entries that run the dispatcher; no file, no rules', () => {
  assert.deepStrictEqual([...declaredEvents(ROOT)].sort(), ['post', 'pre']);
  const h = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const ev of ['PreToolUse', 'PostToolUse']) assert.ok(h[ev].some(e => e.hooks.some(x => x.command.includes(DISPATCHER))), ev);
  assert.deepStrictEqual([...declaredEvents(tmpDir())], []);
});
