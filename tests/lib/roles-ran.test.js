'use strict';

// Which roles an autonomous cycle ran before an entry (roles-ran.js), in each transcript shape:
// opencode JSON events, Claude stream-json / session files, and Qwen Code's parts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { roleCalls, rolesInTranscript, missingRoles, checkRolesRan, ANALYSTS } = require('../../scripts/lib/trading/roles-ran');
const { tmpDir } = require('../helpers');

// opencode `run --format json`: one tool_use event per finished call, with its start and end times.
const oc = (subagent_type, [start, end] = [null, null], { status = 'completed', input = {}, output = '<task id="s" state="completed"><task_result>VERDICT: APPROVE - size 1</task_result></task>', metadata } = {}) => JSON.stringify({
  type: 'tool_use', timestamp: 1, sessionID: 'ses_main',
  part: { type: 'tool', tool: 'task', state: { status, input: { description: 'x', prompt: 'y', subagent_type, ...input }, output, ...(metadata ? { metadata } : {}), ...(start !== null ? { time: { start, end } } : {}) } },
});
// A full cycle as the skill runs it: the analysts and phase 1 at once (10-20), phase 2 after (30-40).
const FULL = [...ANALYSTS.map(r => oc(r, [10, 20])), oc('risk-manager', [10, 18]), oc('risk-manager', [30, 40])];
const miss = (lines, cycle) => missingRoles(roleCalls(lines.join('\n')), cycle);
const calls = text => roleCalls(text).calls;
const P2 = 'risk-manager phase 2 (a second call, started after phase 1';

test('opencode: completed foreground task calls count by role; errored, running or background ones do not', () => {
  assert.deepStrictEqual(Object.fromEntries(rolesInTranscript(FULL.join('\n'))),
    { 'market-structure-analyst': 1, 'trend-momentum-analyst': 1, 'volume-liquidity-analyst': 1, 'risk-manager': 2 });
  assert.deepStrictEqual(calls([oc('risk-manager', [1, 2], { status: 'error' }), oc('risk-manager', [1, 2], { status: 'running' })].join('\n')), []);
  // A background launch returns at once, before any report.
  assert.deepStrictEqual(calls(oc('risk-manager', [1, 2], { input: { background: true } })), []);
  assert.deepStrictEqual(calls(oc('risk-manager', [1, 2], { metadata: { background: true } })), []);
  assert.deepStrictEqual(calls(oc('risk-manager', [1, 2], { output: '<task id="s" state="running">started</task>' })), []);
  // Another tool's event, or a skill load, is not a role; a role named inside another call's text never counts.
  const other = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { tool: 'broker_journal_add', state: { status: 'completed', input: { text: oc('risk-manager') } } } });
  const skill = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { tool: 'skill', state: { status: 'completed', input: { name: 'market-structure' } } } });
  assert.deepStrictEqual(calls([other, skill].join('\n')), []);
});

test('Claude: a Task/Agent call counts once its tool_result returned without an error, in the foreground', () => {
  const call = (id, subagent_type, extra = {}, name = 'Task') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { subagent_type, prompt: 'p', ...extra } }] } });
  const result = (id, is_error = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'VERDICT: APPROVE - size 1' }] } });
  assert.deepStrictEqual(calls([call('a', 'futures-trading-harness:risk-manager'), result('a'), call('b', 'trend-momentum-analyst', {}, 'Agent'), result('b')].join('\n')),
    [{ role: 'risk-manager', start: 0, end: 1, text: 'VERDICT: APPROVE - size 1' }, { role: 'trend-momentum-analyst', start: 2, end: 3, text: 'VERDICT: APPROVE - size 1' }]);
  assert.deepStrictEqual(calls([call('a', 'risk-manager'), result('a', true)].join('\n')), [], 'an errored call');
  assert.deepStrictEqual(calls(call('a', 'risk-manager')), [], 'no result yet');
  assert.deepStrictEqual(calls([call('a', 'risk-manager', { run_in_background: true }), result('a')].join('\n')), [], 'a background launch');
});

test('Qwen Code parts: a task call counts once answered with no error', () => {
  const call = (id, subagent_type) => JSON.stringify({ type: 'assistant', message: { role: 'model', parts: [{ functionCall: { id, name: 'task', args: { subagent_type } } }] } });
  const answer = (id, response) => JSON.stringify({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id, name: 'task', response } }] } });
  assert.deepStrictEqual(calls([call('x', 'volume-liquidity-analyst'), answer('x', { output: 'VERDICT: APPROVE - size 1' })].join('\n')), [{ role: 'volume-liquidity-analyst', start: 0, end: 1, text: 'VERDICT: APPROVE - size 1' }]);
  assert.deepStrictEqual(calls([call('x', 'volume-liquidity-analyst'), answer('x', { error: 'not found' })].join('\n')), []);
});

test('missingRoles: the analysts, then phase 2 after phase 1 and the analysts returned; a lean cycle phase 1 then 2', () => {
  assert.deepStrictEqual(miss(FULL, 'full'), []);
  assert.deepStrictEqual(miss(FULL.slice(3), 'full'), ANALYSTS);
  assert.deepStrictEqual(miss([], 'full'), [...ANALYSTS, 'risk-manager phase 1', `${P2} and the analysts returned)`]);
  // Two risk-manager calls at once are phase 1 twice: phase 2 is missing.
  assert.deepStrictEqual(miss([...ANALYSTS.map(r => oc(r, [10, 20])), oc('risk-manager', [10, 18]), oc('risk-manager', [11, 19])], 'full'), [`${P2} and the analysts returned)`]);
  // Phase 2 started before an analyst returned: not a review of a plan built from the reports.
  assert.deepStrictEqual(miss([...ANALYSTS.map(r => oc(r, [10, 35])), oc('risk-manager', [10, 18]), oc('risk-manager', [30, 40])], 'full'), [`${P2} and the analysts returned)`]);
  assert.deepStrictEqual(miss([oc('risk-manager', [1, 2]), oc('risk-manager', [3, 4])], 'lean'), []);
  assert.deepStrictEqual(miss([oc('risk-manager', [1, 4]), oc('risk-manager', [2, 5])], 'lean'), [`${P2} returned)`]);
  assert.deepStrictEqual(miss([oc('risk-manager', [1, 2])], 'lean'), [`${P2} returned)`]);
  assert.deepStrictEqual(miss([], null), [], 'no cycle named: nothing required');
});

test('missingRoles: each entry needs its own round - roles before the last trade-executor call don\'t count', () => {
  const exec = oc('trade-executor', [45, 60]);
  assert.deepStrictEqual(miss([...FULL, exec], 'full'), [...ANALYSTS, 'risk-manager phase 1', `${P2} and the analysts returned)`]);
  const again = [...ANALYSTS.map(r => oc(r, [70, 80])), oc('risk-manager', [70, 75]), oc('risk-manager', [85, 90])];
  assert.deepStrictEqual(miss([...FULL, exec, ...again], 'full'), []);
  // Line order stands in for times (Claude, Qwen, or an event without times): the same rule.
  const noTimes = [...ANALYSTS.map(r => oc(r)), oc('risk-manager'), oc('risk-manager')];
  assert.deepStrictEqual(miss(noTimes, 'full'), []);
  assert.deepStrictEqual(miss([...noTimes, oc('trade-executor')], 'full').length, 5);
});

test('checkRolesRan: names what is missing, passes a complete cycle, fails closed on an unreadable transcript', () => {
  const file = path.join(tmpDir(), 'logs', 'cycle-transcript-1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, oc('risk-manager', [1, 2]));
  assert.match(checkRolesRan(file, 'full'), /A full cycle enters only after its roles report, in the foreground, since the last trade-executor call .*not returned yet: market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst, risk-manager phase 2/);
  fs.writeFileSync(file, FULL.join('\n'));
  assert.strictEqual(checkRolesRan(file, 'full'), null);
  fs.writeFileSync(file, '');
  assert.match(checkRolesRan(file, 'lean'), /risk-manager phase 1, risk-manager phase 2/);
  assert.match(checkRolesRan(path.join(path.dirname(file), 'missing.jsonl'), 'full'), /can't be read \(ENOENT\)/);
  assert.strictEqual(checkRolesRan(null, 'full'), null);
  assert.strictEqual(checkRolesRan(file, null), null);
});

test('checkRolesRan: a Claude subagent\'s transcript (the trade-executor\'s hook) is read with its main session\'s, where the roles ran', () => {
  const dir = tmpDir();
  const main = path.join(dir, 'sess-1.jsonl');
  const sub = path.join(dir, 'sess-1', 'subagents', 'agent-x.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  const call = (id, subagent_type) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Task', input: { subagent_type } }] } });
  const result = id => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'VERDICT: APPROVE - size 1' }] } });
  const lines = [...ANALYSTS.flatMap((r, i) => [call(`a${i}`, r)]), call('p1', 'risk-manager'), ...ANALYSTS.map((_r, i) => result(`a${i}`)), result('p1'), call('p2', 'risk-manager'), result('p2')];
  fs.writeFileSync(main, lines.join('\n'));
  fs.writeFileSync(sub, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'o', name: 'mcp__broker__place_order', input: {} }] } }));
  assert.strictEqual(checkRolesRan(sub, 'full'), null);
  fs.writeFileSync(main, lines.slice(0, -2).join('\n'));
  assert.match(checkRolesRan(sub, 'full'), /risk-manager phase 2/);
});

test('every trade-executor launch ends the round: running in parallel, errored, in the background, or without times', () => {
  // Claude: the call placing this order has no result yet (the current one); a second one running at once is refused.
  const call = (id, subagent_type, extra = {}) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Task', input: { subagent_type, prompt: 'p', ...extra } }] } });
  const result = (id, content = 'VERDICT: APPROVE - size 1', is_error = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] } });
  const round = (p) => [...ANALYSTS.map((r, i) => call(`${p}a${i}`, r)), call(`${p}p1`, 'risk-manager'), ...ANALYSTS.map((_r, i) => result(`${p}a${i}`)), result(`${p}p1`), call(`${p}p2`, 'risk-manager'), result(`${p}p2`)];
  const m = lines => missingRoles(roleCalls(lines.join('\n')), 'full');
  assert.deepStrictEqual(m([...round('x'), call('e1', 'trade-executor')]), [], 'the current launch, running');
  assert.deepStrictEqual(m([...round('x'), call('e1', 'trade-executor'), call('e2', 'trade-executor')]), ['one trade-executor at a time (2 running)']);
  // An earlier launch that errored, or was launched in the background, still ends the round.
  assert.ok(m([...round('x'), call('e1', 'trade-executor'), result('e1', 'boom', true), call('e2', 'trade-executor')]).length > 1);
  assert.ok(m([...round('x'), call('e1', 'trade-executor', { run_in_background: true }), result('e1', 'Async agent launched successfully.'), call('e2', 'trade-executor')]).length > 1);
  assert.ok(m([...round('x'), call('e1', 'trade-executor'), result('e1', 'Async agent launched successfully.'), call('e2', 'trade-executor')]).length > 1, 'a background launch by default');
  // A fresh round after it lets the next entry through.
  assert.deepStrictEqual(m([...round('x'), call('e1', 'trade-executor'), result('e1'), ...round('y'), call('e2', 'trade-executor')]), []);
  // opencode: a background or errored launch ends the round at its start; one without times ends every round.
  assert.ok(miss([...FULL, oc('trade-executor', [45, 46], { input: { background: true } })], 'full').length > 1);
  assert.ok(miss([...FULL, oc('trade-executor', [45, 60], { status: 'error' })], 'full').length > 1);
  assert.ok(miss([...FULL, oc('trade-executor')], 'full').length > 1);
  // A role that started before the last launch ended doesn't count, even if it returned after.
  assert.ok(miss([oc('trade-executor', [40, 60]), ...ANALYSTS.map(r => oc(r, [50, 70])), oc('risk-manager', [61, 65]), oc('risk-manager', [75, 80])], 'full').length > 0);
});

test('Claude: a subagent that only acknowledged a background launch has not reported; Qwen: a background call does not count', () => {
  const call = (id, subagent_type, extra = {}) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type, ...extra } }] } });
  const result = (id, content) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  assert.deepStrictEqual(calls([call('a', 'risk-manager'), result('a', [{ type: 'text', text: 'Async agent launched successfully. agentId: x' }])].join('\n')), []);
  assert.strictEqual(calls([call('a', 'risk-manager'), result('a', [{ type: 'text', text: '## Risk state ...' }])].join('\n')).length, 1);
  const qcall = (id, subagent_type, extra = {}) => JSON.stringify({ type: 'assistant', message: { role: 'model', parts: [{ functionCall: { id, name: 'task', args: { subagent_type, ...extra } } }] } });
  const qans = id => JSON.stringify({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id, name: 'task', response: { output: 'started' } } }] } });
  assert.deepStrictEqual(calls([qcall('q', 'risk-manager', { run_in_background: true }), qans('q')].join('\n')), []);
});

test('Qwen Code: every trade-executor launch ends the round too, one at a time', () => {
  const call = (id, subagent_type) => JSON.stringify({ type: 'assistant', message: { role: 'model', parts: [{ functionCall: { id, name: 'task', args: { subagent_type } } }] } });
  const answer = id => JSON.stringify({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id, name: 'task', response: { output: 'VERDICT: APPROVE - size 1' } } }] } });
  const round = p => [...ANALYSTS.map((r, i) => call(`${p}a${i}`, r)), call(`${p}p1`, 'risk-manager'), ...ANALYSTS.map((_r, i) => answer(`${p}a${i}`)), answer(`${p}p1`), call(`${p}p2`, 'risk-manager'), answer(`${p}p2`)];
  const m = lines => missingRoles(roleCalls(lines.join('\n')), 'full');
  assert.deepStrictEqual(m([...round('x'), call('e1', 'trade-executor')]), [], 'the current launch, running');
  assert.deepStrictEqual(m([...round('x'), call('e1', 'trade-executor'), call('e2', 'trade-executor')]), ['one trade-executor at a time (2 running)']);
  assert.strictEqual(m([...round('x'), call('e1', 'trade-executor'), answer('e1'), call('e2', 'trade-executor')]).length, 5, 'a finished launch ended the round');
  assert.deepStrictEqual(m([...round('x'), call('e1', 'trade-executor'), answer('e1'), ...round('y'), call('e2', 'trade-executor')]), []);
});

test('a report that merely mentions a background process is still a report; only an acknowledgment opening the result is not', () => {
  const call = (id, subagent_type) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type } }] } });
  const result = (id, text) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
  assert.strictEqual(roleCalls([call('a', 'volume-liquidity-analyst'), result('a', '## Volume/Liquidity: an iceberg bid appears to be running in the background at 21450.25')].join('\n')).calls.length, 1);
  assert.strictEqual(roleCalls([call('a', 'volume-liquidity-analyst'), result('a', 'Async agent launched successfully.')].join('\n')).calls.length, 0);
});

test('the refusal says the refused call ended the round, so the cycle ends and the next entry runs every role again', () => {
  const file = path.join(tmpDir(), 'cycle-transcript-2.jsonl');
  fs.writeFileSync(file, FULL.slice(0, 2).join('\n'));
  assert.match(checkRolesRan(file, 'full'), /This refused trade-executor call ends the round: report the block and end the cycle \(trade-session step 6\); the next entry needs every role again/);
});

test('Claude: a launch acknowledgment as plain string content is not a report, and an executor launched so ends the round', () => {
  const call = (id, subagent_type) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type } }] } });
  const result = (id, content) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  const ack = 'Async agent launched successfully.\nagentId: x';
  assert.strictEqual(roleCalls([call('a', 'risk-manager'), result('a', ack)].join('\n')).calls.length, 0);
  const round = [...ANALYSTS.map(r => oc(r, [10, 20])), oc('risk-manager', [10, 18]), oc('risk-manager', [30, 40])];
  const { launches } = roleCalls([call('e', 'trade-executor'), result('e', ack)].join('\n'));
  assert.deepStrictEqual(launches, [{ start: 0, end: null, background: true }]);
  assert.ok(missingRoles({ calls: roleCalls(round.join('\n')).calls, launches: [{ start: 50, end: null, background: true }] }, 'full').length > 0);
});

test('each call carries its report text: opencode\'s task_result, Claude\'s text blocks, Qwen\'s output', () => {
  assert.strictEqual(calls(oc('risk-manager', [1, 2], { output: '<task id="s" state="completed">\n<task_result>\nBias: long\nmore\n</task_result>\n</task>' }))[0].text, 'Bias: long\nmore');
  const claude = [JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'a', name: 'Task', input: { subagent_type: 'risk-manager' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }] } })];
  assert.strictEqual(calls(claude.join('\n'))[0].text, 'one\ntwo');
});

test('roles served from the report cache count as returned; phase 2 still runs, after every analyst that ran', () => {
  const two = ANALYSTS.slice(1);
  // Market structure cached: the other two analysts, phase 1, then phase 2 after them.
  assert.deepStrictEqual(missingRoles(roleCalls([...two.map(r => oc(r, [10, 20])), oc('risk-manager', [10, 18]), oc('risk-manager', [30, 40])].join('\n')), 'full', [ANALYSTS[0]]), []);
  assert.deepStrictEqual(missingRoles(roleCalls([...two.map(r => oc(r, [10, 20])), oc('risk-manager', [10, 18]), oc('risk-manager', [30, 40])].join('\n')), 'full', []), [ANALYSTS[0]], 'control: not cached, it must run');
  // Everything but phase 2 cached: one risk-manager call is phase 2; none at all is refused.
  const all = [...ANALYSTS, 'risk-manager'];
  assert.deepStrictEqual(missingRoles(roleCalls(oc('risk-manager', [30, 40])), 'full', all), []);
  assert.deepStrictEqual(missingRoles(roleCalls(''), 'full', all), ['risk-manager phase 2 (started after the cached reports were given)']);
  // Phase 1 cached, one analyst ran: phase 2 must start after it returned.
  const cached = [...ANALYSTS.slice(0, 2), 'risk-manager'];
  assert.deepStrictEqual(missingRoles(roleCalls([oc(ANALYSTS[2], [10, 20]), oc('risk-manager', [15, 25])].join('\n')), 'full', cached), ['risk-manager phase 2 (started after the analysts)']);
  assert.deepStrictEqual(missingRoles(roleCalls([oc(ANALYSTS[2], [10, 20]), oc('risk-manager', [21, 25])].join('\n')), 'full', cached), []);
  // A lean cycle with phase 1 cached: phase 2 alone.
  assert.deepStrictEqual(missingRoles(roleCalls(oc('risk-manager', [1, 2])), 'lean', ['risk-manager']), []);
  // Each entry has its own round: after a trade-executor launch the cache counts no more, every role runs again.
  const exec = oc('trade-executor', [50, 60]);
  assert.deepStrictEqual(missingRoles(roleCalls([oc('risk-manager', [30, 40]), exec, oc('risk-manager', [70, 80])].join('\n')), 'full', all), [...ANALYSTS, `${P2} and the analysts returned)`]);
  assert.deepStrictEqual(missingRoles(roleCalls([oc('risk-manager', [30, 40]), exec, oc('risk-manager', [70, 80])].join('\n')), 'lean', ['risk-manager']), [`${P2} returned)`]);
});

test('phase 2 must approve: a VETO, or a report with no verdict, refuses the entry; the latest phase-2 verdict counts', () => {
  const rm = (span, verdict) => oc('risk-manager', span, { output: `<task id="s" state="completed"><task_result>Checks...\n${verdict}</task_result></task>` });
  const round = p2 => [...ANALYSTS.map(r => oc(r, [10, 20])), rm([10, 18], '## Risk state'), p2];
  const NO = 'risk-manager phase 2 approving the plan (its latest verdict is not "VERDICT: APPROVE")';
  assert.deepStrictEqual(miss(round(rm([30, 40], 'VERDICT: APPROVE - size 1, risk $40, ok')), 'full'), []);
  assert.deepStrictEqual(miss(round(rm([30, 40], 'VERDICT: VETO - mixed alignment at size 1: stand aside')), 'full'), [NO], 'B 10:00: a VETO, then the order anyway');
  assert.deepStrictEqual(miss(round(rm([30, 40], 'looks fine to me')), 'full'), [NO], 'no verdict line: not an approval');
  assert.deepStrictEqual(miss(round(rm([30, 40], '**VERDICT:** APPROVE - size 2')), 'full'), [], 'markdown bold around the label');
  // The latest phase 2 decides: a VETO then a fresh APPROVE (a revised plan) passes; the reverse doesn't.
  assert.deepStrictEqual(miss([...round(rm([30, 40], 'VERDICT: VETO - x')), rm([50, 60], 'VERDICT: APPROVE - size 1')], 'full'), []);
  assert.deepStrictEqual(miss([...round(rm([30, 40], 'VERDICT: APPROVE - size 1')), rm([50, 60], 'VERDICT: VETO - x')], 'full'), [NO]);
  // A report that quotes an earlier APPROVE and ends with VETO: its last verdict counts.
  assert.deepStrictEqual(miss(round(rm([30, 40], 'The plan said VERDICT: APPROVE earlier.\nVERDICT: VETO - room')), 'full'), [NO]);
  // With phase 1 cached the same holds; a lean cycle too.
  assert.deepStrictEqual(missingRoles(roleCalls(rm([30, 40], 'VERDICT: VETO - x')), 'full', [...ANALYSTS, 'risk-manager']), [NO]);
  assert.deepStrictEqual(miss([rm([1, 2], 'state'), rm([3, 4], 'VERDICT: VETO - x')], 'lean'), [NO]);
  assert.deepStrictEqual(miss([rm([1, 2], 'state'), rm([3, 4], 'VERDICT: APPROVE - size 1')], 'lean'), []);
});

test('verdictOf: read as a model writes it; any veto in the report is no approval', () => {
  const { verdictOf } = require('../../scripts/lib/trading/roles-ran');
  for (const t of ['VERDICT: APPROVE - size 1', '**VERDICT**: APPROVE - size 1', 'VERDICT: **APPROVE**', 'VERDICT - APPROVE', 'VERDICT: APPROVED', 'VERDICT : APPROVE', 'verdict: approve', 'VERDICT — APPROVE']) assert.strictEqual(verdictOf(t), 'APPROVE', t);
  for (const t of [
    'If aligned: VERDICT: APPROVE. ... **VERDICT**: VETO - trend rule',
    'VERDICT: VETO - mixed: re-plan at size 2 for a VERDICT: APPROVE',
    'VERDICT: VETO - room\n(phase 1 earlier: VERDICT: APPROVE)',
    'Previous: VERDICT: APPROVE\nFinal VERDICT: VETOED',
    '**VERDICT**: VETO - room',
  ]) assert.strictEqual(verdictOf(t), 'VETO', t);
  for (const t of ['looks fine', 'APPROVE', 'risk state: 2 trades left', '', null]) assert.strictEqual(verdictOf(t), null, String(t));
});
