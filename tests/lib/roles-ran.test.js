'use strict';

// Which roles an autonomous cycle ran before an entry (roles-ran.js), in each transcript shape:
// opencode JSON events, Claude stream-json / session files, and Qwen Code's parts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { roleCalls, rolesInTranscript, missingRoles, checkRolesRan, approvedPhase2, ANALYSTS } = require('../../scripts/lib/trading/roles-ran');
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
  const skill = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { tool: 'skill', state: { status: 'completed', input: { name: 'bos-vs-choch' } } } });
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

test('Claude: a role\'s report is read without Claude Code\'s subagent footer (its agentId and how to continue it, its usage): the report\'s FACTS line stays its last line', () => {
  const call = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Agent', input: { subagent_type: 'futures-trading-harness:risk-manager', prompt: 'p' } }] } });
  const report = 'VERDICT: APPROVE - size 1, risk $14\nFACTS: window london; entries allowed; trend long allowed';
  const footer = "agentId: afd8373ed55f8f174 (use SendMessage with to: 'afd8373ed55f8f174', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: 64139\ntool_uses: 12\nduration_ms: 81234</usage>";
  for (const content of [`${report}\n\n${footer}`, [{ type: 'text', text: report }, { type: 'text', text: footer }]]) {
    const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r', content }] } });
    assert.deepStrictEqual(calls([call, result].join('\n')).map(c => c.text), [report], JSON.stringify(content).slice(0, 40));
  }
  // A report's own words that merely mention an agent are kept.
  const own = 'VERDICT: APPROVE - size 1\nThe agentId field is not a fact here.\nFACTS: entries allowed; trend long allowed';
  const r2 = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r', content: own }] } });
  assert.deepStrictEqual(calls([call, r2].join('\n')).map(c => c.text), [own]);
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

test('verdictOf: read as a model writes it; any decision other than approve, or a veto, is no approval', () => {
  const { verdictOf } = require('../../scripts/lib/trading/roles-ran');
  for (const t of [
    'VERDICT: APPROVE - size 1', '**VERDICT**: APPROVE - size 1', 'VERDICT: **APPROVE**', 'VERDICT - APPROVE', 'VERDICT: APPROVED', 'VERDICT : APPROVE',
    'verdict: approve', 'VERDICT \u2014 APPROVE', 'Final VERDICT: APPROVE', 'Phase 2 VERDICT: APPROVE', '**Final Verdict:** APPROVE', '"VERDICT: APPROVE - size 1"',
    '\u00a0VERDICT: APPROVE', '\u200bVERDICT: APPROVE', '> Final VERDICT: APPROVE', 'VERDICT (phase 2): APPROVE', '| VERDICT: APPROVE |',
    '## Verdict\nVERDICT: APPROVE', '**Verdict:**\n\nAPPROVE - size 1', '\u2705 VERDICT: APPROVE',
    // The taught order: step lines (8 Decision: take), the verdict, the facts; lowercase "veto" in prose is no veto.
    '8 Decision: take - aligned continuation with room\nVERDICT: APPROVE - size 1, risk $10.50, orb long\nFACTS: window rth; entries allowed',
    'VERDICT: APPROVE - size 1\nthe trend is a read, never a veto',
    'VERDICT (phase 2): APPROVE - size 1', '**Final Verdict:** APPROVE', 'VERDICT: APPROVE\nthe decision is to wait for the fill', 'VERDICT: APPROVE\nthe verdict was clear', 'Verdict\u2014approve', 'Verdict \u2192 APPROVE', 'Verdict / approve', 'Verdict\u2026: approve', 'Verdict [phase 2]: approve', 'Verdict: (approve)', 'Verdict risk overall final: approve', 'VERDICT: full', 'VERDICT: FULL - size 2, as the prop verdict says', 'VERDICT: APPROVE\nsized as its verdict says: full', 'VERDICT: APPROVE\nas the verdict said, room past the level', 'VERDICT | APPROVE', '| VERDICT | APPROVE | size 1 |', 'Verdict phase 2: approve', 'Verdict (phase 2) - final: APPROVED',
    // Several APPROVE lines are one approval, whatever else they say (the order decides setup, side and size).
    '### VERDICT: **APPROVE** but with reservations\n\nVERDICT: APPROVE - size 1, risk $40, orb long, room past the first level',
    'VERDICT: APPROVE - size 1, MNQ long\nVERDICT: APPROVE - size 2, opening long, risk $40',
  ]) assert.strictEqual(verdictOf(t), 'APPROVE', JSON.stringify(t));
  for (const t of [
    'Overall verdict: REJECT', 'Risk Verdict: STAND ASIDE', '\u274c VERDICT: REJECT', '8 Decision: skip', '## Verdict\nREJECT', '## Verdict\n\n**STAND ASIDE**',
    'VERDICT: VETO - room', 'VERDICT: VETOED', 'VERDICT:\nSTAND ASIDE', 'VERDICT: Approvement pending', 'VERDICT: BLOCKED', 'Decision = wait',
    'VERDICT: APPROVE - size 1\nVERDICT: SKIP', 'VERDICT: APPROVE - size 1\n8 Decision: skip - no room', 'VERDICT: APPROVE - size 1\n### Decision: **VETO** on room',
    'VERDICT: APPROVE - size 1\nVERDICT (phase 2): VETO', 'VERDICT: APPROVE\nVERDICT [phase 2]: VETO', 'VERDICT: APPROVE\n| VERDICT | VETO |',
    'VERDICT: APPROVE\nVERDICT = VETO', 'VERDICT: APPROVE\nVERDICT\u200b: VETO', 'VERDICT (VETO): APPROVE', 'VERDICT: APPROVE\nVER\u200bDICT: REJECT',
    'VERDICT: APPROVE\nVERDICT:\u00a0REJECT', 'VERDICT: APPROVE\nthe plan was VETOED', 'VERDICT: APPROVE\nVETOES stand', 'VERDICT: APPROVE\nDecision: vetoed',
    'VERDICT: APPROVE\nVE\u200bTO from phase 1',
    'Decision: (skip)', 'VERDICT: [REJECT]', 'VERDICT: \u00abreject\u00bb', 'Decision: 0 contracts', 'Decision: 0', 'Verdict [phase 2]: reject', 'VERDICT: APPROVE | Decision: skip', 'Verdict\u2014reject', 'Verdict\u2026: reject', 'Verdict \u2192 reject', 'Verdict / reject', 'Verdict = reject', 'Verdict | reject', 'VERDICT: APPROVE\ndecision-making: wait', 'VERDICT: APPROVE - size 1 | final decision: skip', 'Decision: to wait', 'Verdict: is pending', 'VERDICT: NOT APPROVE', 'VERDICT: not approved', 'VERDICT: skip', 'VERDICT: APPROVE\nthe verdict is veto', 'VERDICT: APPROVE\nthe decision was a veto', 'VERDICT (vetoed): approve', 'VERDICT (vetoes): approve',
  ]) assert.strictEqual(verdictOf(t), 'VETO', JSON.stringify(t));
  // A markdown heading never approves (owner-approved 2026-10-22): an approval needs its VERDICT line; a heading still refuses.
  for (const t of ['## VERDICT: APPROVE', '## Verdict\n\u2705 APPROVE - size 1', '## Verdict\n\u00a0APPROVE']) assert.strictEqual(verdictOf(t), null, JSON.stringify(t));
  for (const t of ['looks fine', 'APPROVE', 'risk state: 2 trades left', '', null, 'the decision is mine', 'the decision is to wait', 'the verdict was in', 'VERDICT: take', 'Decision: take', 'Decision: full', '8 Decision: take',
    // A keyword in the middle of a line never approves (owner-approved 2026-10-24): an approval starts its line.
    'per the VERDICT: APPROVE line', 'the risk is fine, VERDICT: APPROVE - size 1', 'Risk-manager verdict: APPROVE - size 1']) assert.strictEqual(verdictOf(t), null, String(t));
});

test('verdictProblem: names the decision that isn\'t approve, or the veto; several APPROVE lines are one approval', () => {
  const { verdictProblem, decisionLines } = require('../../scripts/lib/trading/roles-ran');
  const V = 'VERDICT: APPROVE - size 1, risk $40.00, orb long with the 15m up trend, room to 2R';
  assert.strictEqual(verdictProblem(V), null);
  assert.strictEqual(verdictProblem(`${V}\nnotes\n${V.replace('orb', 'vx').replace('size 1', 'size 2')}`), null, 'APPROVE lines never compared');
  assert.match(verdictProblem(`${V}\nVERDICT: STAND ASIDE`), /a verdict line decides stand, not APPROVE/);
  assert.match(verdictProblem(`${V}\n8 Decision: skip`), /a decision line decides skip, not APPROVE/);
  assert.match(verdictProblem(`${V}\nVERDICT (VETO): APPROVE`), /a decision line says veto/);
  assert.strictEqual(verdictProblem(`${V}\nthe plan was VETOED earlier`), 'the report says VETO');
  assert.strictEqual(verdictProblem(`${V}\na read, never a veto`), null);
  assert.deepStrictEqual(decisionLines('## Verdict\nVERDICT: APPROVE\n8 Decision: take\nthe decision is mine').map(l => [l.keyword, l.word]), [['verdict', 'approve'], ['decision', 'take']]);
});

test('the risk-manager\'s phase-2 format: its example approves; each phrasing it names reads as a veto, the parser unchanged', () => {
  const { verdictOf } = require('../../scripts/lib/trading/roles-ran');
  const rm = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'risk-manager.md'), 'utf8');
  // The example report the agent teaches (the code block after "For example:" in phase 2) approves.
  const example = /For example:\n\n```text\n([^]*?)```/.exec(rm.slice(rm.indexOf('## Phase 2')))[1];
  assert.match(example, /^Size: /m);
  assert.strictEqual(verdictOf(example), 'APPROVE', example);
  // Its Size line, in the agent's own words, approves beside an APPROVE line.
  const size = /e\.g\. `(Size: [^`]+)`/.exec(rm.replace(/\n\s*/g, ' '))[1];
  assert.strictEqual(size, 'Size: 1 (record 8 cut to 1: no reviewed trades yet)');
  // A cut is an approval of the smaller size (runner-entry.js orders exactly it; the gate's composed-reads takes it).
  assert.ok(rm.replace(/\n\s*/g, ' ').includes('To cut, approve the smaller size: the order is exactly it.'));
  assert.ok(rm.replace(/\n\s*/g, ' ').includes('- "verdict" and "decision" only to open the VERDICT line, never in prose or headings: one starting a line decides; elsewhere it can only veto.'));
  assert.ok(rm.replace(/\n\s*/g, ' ').includes('- Size → its own `Size:` line, final size first,'));
  const V = 'VERDICT: APPROVE - size 1, risk $20.00, trade_lifecycle long with the 1h up trend, 2.08R\nFACTS: window opening drive; trend long allowed';
  // Mid-line, a keyword then up to three words and a separator labels a decision: it still refuses (review of 2026-10-24).
  assert.strictEqual(verdictOf(`The verdict priority order: step 2 allows\n${V}`), 'VETO');
  assert.strictEqual(verdictOf(`${size}\n${V}`), 'APPROVE');
  // The baseline's taught step line still approves (the parser keeps it).
  assert.strictEqual(verdictOf(`8 Decision: take - aligned continuation with room\n${V}`), 'APPROVE');
  // Each phrasing that reads as a veto, beside an APPROVE line: a veto (the gate's reading, unchanged).
  for (const bad of ['Sizing decision: size 1', 'Decision: cut to size 1', 'VETO rules: none apply', 'Sizing verdict: skip x0.5', '8 Decision: valid yes, full - compose_check OK', 'not a VETO']) {
    assert.strictEqual(verdictOf(`${bad}\n${V}`), 'VETO', bad);
  }
  // The agent states each rule and names the phrasings it warns of.
  const flatRm = rm.replace(/\n\s*/g, ' ');
  for (const rule of ['The code reads your report; anything else reads as a veto:', '- These read as a veto: `Decision: cut to size 1`,']) assert.ok(flatRm.includes(rule), rule);
  for (const named of ['`Decision: cut to size 1`', '`8 Decision: valid yes`', '`Sizing verdict: skip x0.5`', '"VETO rules: none"', '"not a VETO"']) assert.ok(flatRm.includes(named), named);
});

test('a markdown heading is never a decision line: a heading naming the verdict leaves a clean APPROVE an approval; a veto in a heading still vetoes', () => {
  const { verdictOf, decisionLines } = require('../../scripts/lib/trading/roles-ran');
  const V = 'VERDICT: APPROVE - size 1, risk $46.00, trade_lifecycle short with the 1h down trend, 2.1R\nFACTS: window rth; entries allowed; trend short allowed';
  // The smoke's phase-2 report shape (2026-10-22 22:09): a heading naming the plan verdict, the PLAN lines, the verdict.
  const report = [
    '## Phase 2: Plan verdict, MNQ short, bar 2026-10-22T22:06:00.000Z',
    '',
    '2 Context: window rth, entries allowed, news clear, regime trend-down, account budget $300, attempt none',
    '5 Confluence: for 4, against 1, neutral 1: structure, level, trigger, VWAP',
    '7 Risk: stop 92 ticks, target 2.1R (compose_check), size 1, ahead none',
    'Size: 1 (the record\'s 1)',
    V,
  ].join('\n');
  assert.strictEqual(verdictOf(report), 'APPROVE');
  assert.strictEqual(verdictOf(`## Phase 2: Plan verdict, MNQ short\n${V}`), 'APPROVE');
  assert.deepStrictEqual(decisionLines(report).map(l => [l.keyword, l.word]), [['verdict', 'approve']], 'the heading is read as no decision');
  for (const h of ['## VETO', '## Phase 2 verdict: veto', '# Decision: veto', '  ### Plan VETOED', '## Phase 2 decision: vetoed']) assert.strictEqual(verdictOf(`${h}\n${V}`), 'VETO', h);
  // Not a heading: a '#' later in the line (an issue number, a hashtag) keeps the line a decision line.
  assert.strictEqual(verdictOf(`Decision #2: wait\n${V}`), 'VETO');
});

test('a heading never approves but still refuses: a refusal word or a number after its keyword, or on the line after it; a heading is a real markdown one', () => {
  const { verdictOf } = require('../../scripts/lib/trading/roles-ran');
  const V = 'VERDICT: APPROVE - size 1, risk $46.00, trade_lifecycle short\nFACTS: window rth; trend short allowed';
  for (const h of ['# Verdict: REJECT', '## Decision: PASS, stand aside', '## Decision: skip', '## Decision: wait', '## Verdict: hold', '# Verdict: BLOCKED',
    '## verdict: stand aside', '# Decision: no trade', '## Decision: 0 contracts', '## Verdict: half', '# Verdict\nPASS', '   ### Decision: defer',
    // Not markdown headings: read as decision lines.
    '#1 Decision: pass', '#Decision: pass', '    # Decision: pass']) assert.strictEqual(verdictOf(`${h}\n${V}`), 'VETO', JSON.stringify(h));
  // A heading that merely names the verdict: no decision; the body's APPROVE approves.
  for (const h of ['## Phase 2: Plan verdict, MNQ short', '## Phase 2: Plan verdict, MNQ short, bar 2026-10-22T22:06:00.000Z', '## Verdict', '## Verdict: APPROVE']) assert.strictEqual(verdictOf(`${h}\n${V}`), 'APPROVE', h);
  // A heading alone never approves.
  for (const t of ['## VERDICT: APPROVE', '## Verdict\nAPPROVE', '# Decision: take']) assert.strictEqual(verdictOf(t), null, JSON.stringify(t));
  // Not a markdown heading ('#' with no space after it, or indented four spaces): its approval counts.
  for (const t of ['#1 VERDICT: APPROVE - size 1', '#VERDICT: APPROVE - size 1', '    # VERDICT: APPROVE - size 1']) assert.strictEqual(verdictOf(t), 'APPROVE', JSON.stringify(t));
  // A veto word anywhere in a heading naming the verdict still vetoes (the veto rule reads every line).
  assert.strictEqual(verdictOf(`## Plan verdict, MNQ short: a veto\n${V}`), 'VETO');
});

test('approvedSize: the verdict line\'s size, a Size line, every size and cut on either (the smallest binds); anything unreadable is an error', () => {
  const { approvedSize } = require('../../scripts/lib/trading/roles-ran');
  const A = 'VERDICT: APPROVE';
  for (const [text, size] of [
    [`${A} - size 2, risk $40`, 2],
    [`Size: 1 (record 8 cut to 1: no reviewed trades yet)\n${A} - size 1, risk $20`, 1],
    [`Size: 1\n${A} - size 3, risk $60`, 1], // between lines
    [`${A} - size 3\nSize: 2`, 2],
    [`${A} - size 2 cut to 1, risk $20`, 1], // within a line
    [`${A} - size 3 -> 2, risk $40`, 2],
    [`${A} - size 3 → 1, risk $20`, 1],
    [`Size: 4 (record 8 cut to 2)\n${A} - size 4`, 2],
    [`- Size: 1\n${A} - size 2`, 1], // bulleted
    [`* Size: 1\n${A} - size 2`, 1],
    [`+ Size: 1\n${A} - size 2`, 1],
    [`> Size: 1\n${A} - size 2`, 1],
    [`**Size:** 1\n${A} - size 2`, 1],
    [`${A} - **size 2**, risk $40`, 2],
    [`${A} - size 1, half size if it fills late`, 1], // a word after "size" is prose
    [`${A} - size 3, final size 1`, 1], // two sizes on one line
    [`${A} - size 5 => 1`, 1],
    [`${A} - size 5 \u21d2 1`, 1],
    [`${A} - size 5, trimmed to 1`, 1],
    [`${A} - size 5, reduced to 2`, 2],
    [`${A} - size 5, lowered to 3`, 3],
    [`${A} - size 5, cut back to 2`, 2],
    [`${A} - size 5, scaled down to 1`, 1],
    [`${A} - size 5, down to 2`, 2],
    [`${A} - size 5, cut to size 1`, 1],
    [`${A} - size 5, to size 2`, 2],
    [`Size: 5, trimmed to 1\n${A} - size 5`, 1],
    [`Size: 5 (cut to size 2)\n${A} - size 5`, 2],
    [`Size: 5, scaled down to 3\n${A} - size 5`, 3],
    [`Size: 5 => 4\n${A} - size 5`, 4],
    [`1. Size: 2\n${A} - size 4`, 2],
    [`2) Size: 1\n${A} - size 4`, 1],
  ]) assert.deepStrictEqual(approvedSize(text), { size }, JSON.stringify(text));
  for (const text of [`${A} - size <n>`, `${A} - size 0`, `${A} - size 1.5`, `${A} - size one`, `${A} - size 1-2`, `${A} - size **2**`, `${A} - risk $40`,
    `Size: 0\n${A} - size 1`, `- Size: half\n${A} - size 1`, `${A} - size 2 cut to 0`, `${A} - size 2 -> 1.5`, `${A} - size 5 => 0`, `${A} - size 5 \u21d2 1.5`, `${A} - size 5, trimmed to 0`, `${A} - size 5, reduced to 1.5`, `${A} - size 5, down to size 0`, `1. Size: 0\n${A} - size 1`, 'VERDICT: VETO - room', 'no verdict']) {
    assert.ok(approvedSize(text).error, JSON.stringify(text));
  }
});

test('sizeRefusal: no phase 2 required, nothing; an unreadable report or size refuses; an entry over phase 2\'s size refuses; a whole size at or under it goes', () => {
  const { sizeRefusal } = require('../../scripts/lib/trading/roles-ran');
  const R = { text: 'VERDICT: APPROVE - size 2, risk $40' };
  assert.strictEqual(sizeRefusal(null, 5), null);
  assert.match(sizeRefusal({ error: 'ENOENT' }, 1), /transcript can't be read \(ENOENT\)/);
  assert.match(sizeRefusal({ text: 'VERDICT: APPROVE - risk $40' }, 1), /states no size the gate can read/);
  for (const s of [1, 2]) assert.strictEqual(sizeRefusal(R, s), null, String(s));
  for (const s of [3, null, undefined, '', '1', [1], true, 0, -1, 1.5, NaN]) assert.match(sizeRefusal(R, s) || '', /is over the 2 risk-manager phase 2 approved/, JSON.stringify(s));
});

test('decisiveLine: the line verdictOf decided on, the one approvedSize sizes: the approving VERDICT line, never a heading naming a verdict; a veto\'s refusing line; none: \'\'', () => {
  const { decisiveLine, verdictOf, approvedSize } = require('../../scripts/lib/trading/roles-ran');
  const HEAD = '## Phase 2 verdict: MNQ long, 3m bar closed 11:00 ET (15:00 UTC)';
  const V = 'VERDICT: APPROVE - size 5, risk $100';
  for (const text of [`${HEAD}\n${V}\nFACTS: x`, `${V}\n${HEAD}\nFACTS: x`, `${HEAD}\n### Verdict notes\n${V}`, `**VERDICT:** APPROVE - size 5, risk $100`]) {
    assert.strictEqual(verdictOf(text), 'APPROVE', text);
    assert.deepStrictEqual(approvedSize(text), { size: 5 }, text);
    assert.strictEqual(decisiveLine(text).replace(/\*/g, ''), V, text);
  }
  // A heading, then "VERDICT:" alone with the decision on the next line: both, as read.
  assert.strictEqual(decisiveLine(`${HEAD}\nVERDICT:\nAPPROVE - size 5`), 'VERDICT: APPROVE - size 5');
  assert.strictEqual(decisiveLine(`${HEAD}\nVERDICT: VETO - room\nFACTS: x`), 'VERDICT: VETO - room');
  assert.strictEqual(decisiveLine(`${V}\nDecision: skip`), 'Decision: skip', 'the refusing line, not the approval it overrides');
  assert.strictEqual(decisiveLine(`${HEAD}\nNo call yet.`), '');
  assert.strictEqual(decisiveLine(''), '');
});

test('approvalReadAsVeto: an APPROVE line the reading takes as a veto gives the reason and the line; an approval, a plain veto or no verdict is null', () => {
  const { approvalReadAsVeto, verdictProblem } = require('../../scripts/lib/trading/roles-ran');
  const V = 'VERDICT: APPROVE - size 1, risk $20.00, orb long';
  assert.deepStrictEqual(approvalReadAsVeto(`Decision: cut to size 1\n${V}`), { why: 'a decision line decides cut, not APPROVE ("Decision: cut to size 1")', line: V });
  assert.deepStrictEqual(approvalReadAsVeto(`${V}\nVETO rules: none apply`), { why: 'the report says VETO', line: V });
  assert.strictEqual(approvalReadAsVeto(`Sizing verdict: skip x0.5\n${V}`).why, verdictProblem(`Sizing verdict: skip x0.5\n${V}`));
  for (const t of [V, 'VERDICT: VETO - room: stand aside', 'VERDICT: maybe', 'no verdict', '', null]) assert.strictEqual(approvalReadAsVeto(t), null, String(t));
});

test('assessRound: the approving report is the latest COUNTED phase-2 call; an uncounted call never approves, and a later uncounted veto refuses', () => {
  const { assessRound } = require('../../scripts/lib/trading/roles-ran');
  const call = (role, start, end, text = 'report') => ({ role, start, end, text });
  const APPROVE = 'VERDICT: APPROVE - size 1';
  const VETO = 'VERDICT: VETO - room';
  const analysts = ANALYSTS.map(r => call(r, 1, 5));
  // Index mode: a call whose text says NOLOOKUP skipped its required lookups (it doesn't count).
  const lookups = c => (c.text.includes('NOLOOKUP') ? ['invalidation'] : []);
  lookups.needs = () => [];
  const judge = (calls, cycle, cached = [], lk = null) => assessRound({ calls, launches: [] }, cycle, cached, lk);
  const refused = r => r.missing.some(m => /risk-manager phase 2 approving the plan/.test(m)) && r.report === null;
  // Repro A (index mode): phase 1, a counted veto, then a later approval that skipped its lookups.
  assert.ok(refused(judge([call('risk-manager', 1, 2, 'Risk state'), call('risk-manager', 3, 4, VETO), call('risk-manager', 5, 9, `${APPROVE} NOLOOKUP`)], 'lean', [], lookups)));
  // Repro B (lean): phase 1 at 1-2, a veto at 3-4, an approval that started at 1.5 (before phase 1 ended) and ended at 9.
  assert.ok(refused(judge([call('risk-manager', 1, 2, 'Risk state'), call('risk-manager', 3, 4, VETO), call('risk-manager', 1.5, 9, APPROVE)], 'lean')));
  // Repro C (full, phase 1 cached): an approval that started before the analysts returned, ending after a phase-2 veto.
  assert.ok(refused(judge([...analysts, call('risk-manager', 2, 9, APPROVE), call('risk-manager', 6, 8, VETO)], 'full', ['risk-manager'])));
  // Among counted calls the latest decides (main's rule): a veto, then a revised plan approved later, passes; the
  // reverse doesn't.
  const revised = call('risk-manager', 8, 9, APPROVE);
  assert.deepStrictEqual(judge([...analysts, call('risk-manager', 1, 4, 'Risk state'), call('risk-manager', 6, 7, VETO), revised], 'full').report, revised);
  assert.ok(refused(judge([...analysts, call('risk-manager', 1, 4, 'Risk state'), call('risk-manager', 6, 7, APPROVE), call('risk-manager', 8, 9, VETO)], 'full')));
  // An uncounted veto ending at or after the counted approval refuses; one ending before it doesn't.
  const a = call('risk-manager', 6, 8, APPROVE);
  assert.ok(refused(judge([...analysts, call('risk-manager', 1, 4, 'Risk state'), a, call('risk-manager', 3, 9, VETO)], 'full')));
  const ok = judge([...analysts, call('risk-manager', 1, 4, 'Risk state'), a, call('risk-manager', 3, 7, VETO)], 'full');
  assert.deepStrictEqual([ok.missing, ok.report], [[], a]);
  // Two counted phase-2 reports ending together: no single report, refused.
  assert.ok(refused(judge([...analysts, call('risk-manager', 1, 4, 'Risk state'), call('risk-manager', 6, 8, APPROVE), call('risk-manager', 7, 8, APPROVE)], 'full')));
  // The normal flow passes, in full and index mode, cached or not; the report is the counted approval.
  for (const [cycle, cached, lk] of [['full', [], null], ['full', [], lookups], ['full', ['risk-manager'], null], ['lean', [], null], ['lean', [], lookups]]) {
    const p2 = call('risk-manager', 6, 8, APPROVE);
    const calls = [...(cycle === 'full' ? analysts : []), ...(cached.length ? [] : [call('risk-manager', 1, 4, 'Risk state')]), p2];
    const r = judge(calls, cycle, cached, lk);
    assert.deepStrictEqual([r.missing, r.report], [[], p2], `${cycle} ${cached} ${lk ? 'index' : 'full'}`);
  }
});

test('approvedPhase2: the latest phase-2 report of a complete round that approves; none otherwise; an unreadable transcript is an error', () => {
  const file = path.join(tmpDir(), 'logs', 'cycle-transcript-p2.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const p2 = text => oc('risk-manager', [30, 40], { output: `<task id="s" state="completed"><task_result>${text}</task_result></task>` });
  fs.writeFileSync(file, [...FULL.slice(0, 4), p2('VERDICT: APPROVE - size 1\nFACTS: vwap above')].join('\n'));
  assert.deepStrictEqual(approvedPhase2(file, 'full'), { text: 'VERDICT: APPROVE - size 1\nFACTS: vwap above' });
  // A later phase 2 replaces an earlier one; a veto, an incomplete round: none (checkRolesRan refuses those).
  fs.writeFileSync(file, [...FULL, oc('risk-manager', [50, 60], { output: '<task id="s" state="completed"><task_result>VERDICT: APPROVE - size 2\nFACTS: vwap below</task_result></task>' })].join('\n'));
  assert.deepStrictEqual(approvedPhase2(file, 'full'), { text: 'VERDICT: APPROVE - size 2\nFACTS: vwap below' });
  fs.writeFileSync(file, [...FULL.slice(0, 4), p2('VERDICT: VETO - room')].join('\n'));
  assert.strictEqual(approvedPhase2(file, 'full'), null);
  fs.writeFileSync(file, FULL.slice(1).join('\n'));
  assert.strictEqual(approvedPhase2(file, 'full'), null);
  assert.deepStrictEqual(approvedPhase2(path.join(path.dirname(file), 'missing.jsonl'), 'full'), { error: 'ENOENT' });
  assert.strictEqual(approvedPhase2(null, 'full'), null);
  assert.strictEqual(approvedPhase2(file, null), null);
});
