'use strict';

// A run's decisions as fine-tuning material (scripts/lib/learning/decision-examples.js): each scored decision joined
// with its compose record and the roles' exact prompts and responses, byte for byte.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../../scripts/lib/learning/decision-examples');
const { tmpDir } = require('../helpers');
const F = require('../fixtures/decision-run');

const ROOT = path.join(__dirname, '..', '..');
// Bytes a careless reader changes: trailing spaces, CRLF, tabs, unicode, a JSON-looking line, a lone surrogate-free emoji.
const PROMPT = 'Cycle 2022-03-07 09:33 ET  \r\nMNQ 3m bar closed.\t{"type":"text"}\né—→ 📈\n\n';
const RECORD = { ok: true, side: 'long', entry: 21000, stop: 20990, target: 21025, size: 5, tick: 0.25, tickValue: 0.5, reads: [{ step: 'setup', skill: 'fair-value-gaps', check: true }] };

test('taskResult: the subagent\'s reply inside opencode\'s task wrapper, else null', () => {
  assert.strictEqual(E.taskResult('<task id="x" state="completed">\n<task_result>\nAPPROVED\n</task_result>\n</task>'), 'APPROVED');
  assert.strictEqual(E.taskResult('<task id="x">\n<task_result>\n  two\nlines  \n</task_result>\n</task>'), '  two\nlines  ');
  assert.strictEqual(E.taskResult('APPROVED'), null);
  assert.strictEqual(E.taskResult(null), null);
});

test('roleTurns: the head trader\'s and each subagent\'s exact prompt and response, with the run\'s own system prompts', () => {
  const tasks = [{ role: 'risk-manager', prompt: 'Check the long — 21000  \n', reply: 'APPROVED  \n  size 5' }];
  const doc = { prompt: PROMPT, transcript: F.transcript({ headText: ['First.  ', 'CYCLE RESULT: long MNQ\n'], tasks }) };
  const turns = E.roleTurns(doc, { systemPrompts: F.SYSTEM });
  assert.deepStrictEqual(turns.map(t => [t.role, t.faithful, Boolean(t.subagent)]), [['fth-head-trader', true, false], ['risk-manager', true, true]]);
  // The head trader's turn: its task call and the wrapper it read, then its text.
  const [, , call, result, final] = turns[0].messages;
  assert.deepStrictEqual([call.role, call.content, call.tool_calls[0].type, call.tool_calls[0].function.name], ['assistant', '', 'function', 'task']);
  assert.deepStrictEqual(JSON.parse(call.tool_calls[0].function.arguments), { description: 'd', prompt: tasks[0].prompt, subagent_type: 'risk-manager' });
  assert.deepStrictEqual(result, { role: 'tool', tool_call_id: call.tool_calls[0].id, content: `<task id="ses_c" state="completed">\n<task_result>\n${tasks[0].reply}\n</task_result>\n</task>` });
  assert.deepStrictEqual(final, { role: 'assistant', content: 'First.  \n\nCYCLE RESULT: long MNQ\n' });
  assert.deepStrictEqual(turns[0].messages.slice(0, 2), [{ role: 'system', content: F.SYSTEM['fth-head-trader'] }, { role: 'user', content: PROMPT }]);
  assert.strictEqual(turns[0].messages[1].content, PROMPT, 'byte for byte');
  assert.deepStrictEqual(turns[1].messages, [{ role: 'system', content: F.SYSTEM['risk-manager'] }, { role: 'user', content: tasks[0].prompt }, { role: 'assistant', content: tasks[0].reply }]);
  // No system prompt recorded for a role: none invented.
  assert.deepStrictEqual(E.roleTurns(doc)[0].messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  // A transcript it doesn't recognize: no head turn, nothing guessed; no prompt: no turns.
  assert.deepStrictEqual(E.roleTurns({ prompt: PROMPT, transcript: 'plain text output\nCYCLE RESULT: none' }), [{ role: 'fth-head-trader', messages: null, faithful: false }]);
  assert.deepStrictEqual(E.roleTurns({ transcript: '' }), []);
  // A task call without its wrapper: unfaithful.
  const bare = { prompt: PROMPT, transcript: F.transcript({ headText: ['x'] }).replace('"step-finish"}}', '"step-finish"}}\n') + JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { prompt: 'p', subagent_type: 'risk-manager' }, output: 'raw' } } }) };
  assert.deepStrictEqual(E.roleTurns(bare).map(t => t.faithful), [false, false], 'a call without its id: the head turn is unreadable whole');
});

test('roleTurns: a compose_check call and its result are tool turns, byte for byte, in the order the model made them', () => {
  const out = '{"ok":false,"refusals":["the setup read is false  "],\n"plan":null}\t';
  const calls = [
    { tool: 'harness_compose_check', id: 'call_c1', input: { symbol: 'MNQ', side: 'long', reads: [{ step: 'setup', claim: 'FVG — 21000  ' }] }, output: out },
    { tool: 'broker_place_order', id: 'call_c2', input: { symbol: 'MNQ' }, error: 'refused: no compose record  ' },
  ];
  const doc = { prompt: PROMPT, transcript: F.transcript({ headText: ['CYCLE RESULT: none  \n'], calls }) };
  const [head] = E.roleTurns(doc);
  assert.ok(head.faithful);
  assert.deepStrictEqual(head.messages, [
    { role: 'user', content: PROMPT },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_c1', type: 'function', function: { name: 'harness_compose_check', arguments: JSON.stringify(calls[0].input) } },
      { id: 'call_c2', type: 'function', function: { name: 'broker_place_order', arguments: JSON.stringify(calls[1].input) } }] },
    { role: 'tool', tool_call_id: 'call_c1', content: out },
    { role: 'tool', tool_call_id: 'call_c2', content: 'refused: no compose record  ' },
    { role: 'assistant', content: 'CYCLE RESULT: none  \n' },
  ]);
  // A text after a call in one step starts the next assistant message (never merged before the call).
  const ev = (type, part) => ({ type, timestamp: 1, sessionID: 's', part });
  const msgs = E.headMessages([ev('step_start', {}), ev('text', { text: 'A' }), ev('tool_use', { tool: 'x', callID: 'k', state: { status: 'completed', input: {}, output: 'o' } }), ev('text', { text: 'B' }), ev('step_finish', {})]);
  assert.deepStrictEqual(msgs.map(m => [m.role, m.content]), [['assistant', 'A'], ['tool', 'o'], ['assistant', 'B']]);
  // A call still running, or a turn ending on a call: no faithful turn.
  assert.strictEqual(E.headMessages([ev('tool_use', { tool: 'x', callID: 'k', state: { status: 'running', input: {} } }), ev('text', { text: 'B' })]), null);
  assert.strictEqual(E.headMessages([ev('text', { text: 'A' }), ev('tool_use', { tool: 'x', callID: 'k', state: { status: 'completed', input: {}, output: 'o' } })]), null);
});

test('the real opencode cycle transcript fixture reads as the head trader\'s text and its risk-manager task', () => {
  const doc = { prompt: 'p', transcript: fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'opencode-cycle-transcript.jsonl'), 'utf8') };
  const turns = E.roleTurns(doc);
  assert.ok(turns[0].faithful);
  const head = turns[0].messages;
  assert.strictEqual(head.filter(m => m.role === 'tool').length, 9, 'every call, a failed one too, with its result');
  assert.strictEqual(head.find(m => m.tool_call_id === 'call_3').content.startsWith('Skill "strategy-library" not found'), true);
  assert.strictEqual(head[head.length - 1].role, 'assistant');
  assert.ok(head[head.length - 1].content.length > 0);
  assert.deepStrictEqual(turns.find(t => t.role === 'risk-manager').messages[1], { role: 'assistant', content: 'APPROVED' });
});

test('runDecisions: each scored decision with its record, risk, account call, balance keys and turns', () => {
  const home = tmpDir();
  const { runDir, score } = F.writeRun(home, {
    start: '2022-03-07T14:00:00Z', end: '2022-03-08T00:00:00Z', stage: 2,
    states: [{ day: '2022-03-07', draw: 1, bucket: 'near-mll', weight: 0.4 }],
    decisions: [
      { t: '2022-03-07T14:33:00.000Z', kind: 'take', record: RECORD, prompt: PROMPT, headText: ['go'], tasks: [{ role: 'risk-manager', prompt: 'q', reply: 'APPROVED' }], attempt: { status: 'active', cushion: 2500, dailyHeadroom: 600, softHeadroom: 400 } },
      { t: '2022-03-07T14:36:00.000Z', kind: 'pass', composed: [{ symbol: 'MNQ', ok: false, reads: [] }, { symbol: 'MES', ...RECORD }], prompt: 'p2', headText: ['no'] },
      { t: '2022-03-07T14:39:00.000Z', kind: 'risk', action: 'exit', prompt: 'p3', headText: ['out'] },
    ],
  });
  const ds = E.runDecisions(runDir, { score, sample: { t: 'x', repeat: 0, seed: 7 } });
  assert.deepStrictEqual(ds.map(d => [d.kind, d.action]), [['take', 'long'], ['pass', 'none'], ['risk', 'exit']]);
  const [tk, ps] = ds;
  assert.strictEqual(tk.riskUsd, 100, '40 ticks x $0.50 x 5');
  assert.strictEqual(tk.record.entry, 21000);
  assert.strictEqual(tk.skill, 'fair-value-gaps');
  assert.deepStrictEqual([tk.stage, tk.accountState, tk.year], [2, 'near-mll', '2022']);
  assert.strictEqual(tk.account.standDown, false);
  assert.deepStrictEqual(tk.sample, { t: 'x', repeat: 0, seed: 7 });
  assert.strictEqual(tk.turns[0].messages[1].content, PROMPT);
  // The pass: the MES record is another family's; MNQ's one record was refused.
  assert.deepStrictEqual([ps.attempts, ps.record.ok, ps.skill], [1, false, 'none']);
  // Times: only a sample's decisions.
  assert.deepStrictEqual(E.runDecisions(runDir, { score, times: ['2022-03-07T14:36:00Z'] }).map(d => d.kind), ['pass']);
  assert.throws(() => E.runDecisions(runDir, {}), /score\(runDir\)/);
  assert.throws(() => E.runDecisions(path.join(home, 'nope'), { score }), /no manifest\.json/);
});

test('runDecisions: a failed, timed-out or interrupted cycle is marked, and none of its turns is faithful', () => {
  const home = tmpDir();
  const d = (t, over) => ({ t, kind: 'take', record: RECORD, prompt: `p${t}`, headText: ['go'], tasks: [{ role: 'risk-manager', prompt: 'q', reply: 'OK' }], ...over });
  const { runDir, score } = F.writeRun(home, {
    start: '2022-03-07T14:00:00Z', end: '2022-03-08T00:00:00Z', stage: 1,
    decisions: [
      d('2022-03-07T14:33:00.000Z', {}),
      d('2022-03-07T14:36:00.000Z', { ran: [{ action: 'trade', ok: false, timedOut: false }] }),
      d('2022-03-07T14:39:00.000Z', { ran: [{ action: 'trade', ok: true, timedOut: true }] }),
      d('2022-03-07T14:42:00.000Z', { ran: [], interrupted: true }),
    ],
  });
  const ds = E.runDecisions(runDir, { score });
  assert.deepStrictEqual(ds.map(x => x.cycleFailed), [null, 'a cycle failed or timed out', 'a cycle failed or timed out', 'the step was interrupted']);
  assert.ok(ds[0].turns.every(t => t.faithful));
  for (const x of ds.slice(1)) assert.ok(x.turns.length && x.turns.every(t => !t.faithful), x.t);
  const L = require('../../scripts/lib/learning/decision-label');
  assert.deepStrictEqual(ds.map(x => L.labelDecision(x, { minRR: 2, maxRiskUsd: 300 }).label), ['correct', 'unverifiable', 'unverifiable', 'unverifiable']);
  // No store line for the time, or a cycle file that says it failed: unknown or failed, never clean.
  assert.match(E.cycleHealth(undefined, {}), /no replay record/);
  assert.match(E.cycleHealth({ ran: [{ ok: true }] }, { ok: false }), /cycle record says it failed/);
  assert.match(E.cycleHealth({ ran: [{ ok: true }], step: { timedOut: true } }, {}), /step timed out/);
  assert.strictEqual(E.cycleHealth({ ran: [{ ok: true, timedOut: false }], step: { timedOut: false } }, { ok: true }), null);
});

test('runDecisions: a stage-1 run carries no account state', () => {
  const home = tmpDir();
  const { runDir, score } = F.writeRun(home, { start: '2022-03-07T14:00:00Z', end: '2022-03-08T00:00:00Z', stage: 1, decisions: [{ t: '2022-03-07T14:33:00.000Z', kind: 'take', record: RECORD, prompt: 'p', headText: ['go'] }] });
  const [d] = E.runDecisions(runDir, { score });
  assert.deepStrictEqual([d.stage, d.accountState, d.account], [1, null, null]);
});

test('runDecisions: an exit the runner made (its trail or time stop) is marked the policy\'s, by the measurement\'s runnerExit', () => {
  const home = tmpDir();
  const { runDir, score } = F.writeRun(home, {
    start: '2022-03-07T14:00:00Z', end: '2022-03-08T00:00:00Z',
    decisions: [
      { t: '2022-03-07T14:30:00.000Z', kind: 'risk', action: 'hold', prompt: 'p0', headText: ['hold'] },
      { t: '2022-03-07T14:33:00.000Z', kind: 'risk', action: 'exit', prompt: 'p1', headText: ['out'] },
      { t: '2022-03-07T15:33:00.000Z', kind: 'risk', action: 'exit', prompt: 'p2', headText: ['out'] },
    ],
  });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'events-2022-03-07.jsonl'), `${JSON.stringify({ kind: 'position_closed', at: '2022-03-07T14:32:10.000Z', symbol: 'MNQ', contractId: 'X' })}\n`);
  const ds = E.runDecisions(runDir, { score });
  assert.deepStrictEqual(ds.map(d => d.policyExit), [null, 'runner-close', null]);
});
