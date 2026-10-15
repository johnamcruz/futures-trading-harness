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
  assert.deepStrictEqual(turns.map(t => [t.role, t.faithful]), [['fth-head-trader', true], ['risk-manager', true]]);
  assert.deepStrictEqual(turns[0].messages, [
    { role: 'system', content: F.SYSTEM['fth-head-trader'] }, { role: 'user', content: PROMPT }, { role: 'assistant', content: 'First.  \n\nCYCLE RESULT: long MNQ\n' },
  ]);
  assert.strictEqual(turns[0].messages[1].content, PROMPT, 'byte for byte');
  assert.deepStrictEqual(turns[1].messages, [{ role: 'system', content: F.SYSTEM['risk-manager'] }, { role: 'user', content: tasks[0].prompt }, { role: 'assistant', content: tasks[0].reply }]);
  // No system prompt recorded for a role: none invented.
  assert.deepStrictEqual(E.roleTurns(doc)[0].messages.map(m => m.role), ['user', 'assistant']);
  // A transcript it doesn't recognize: no head turn, nothing guessed; no prompt: no turns.
  assert.deepStrictEqual(E.roleTurns({ prompt: PROMPT, transcript: 'plain text output\nCYCLE RESULT: none' }), [{ role: 'fth-head-trader', messages: null, faithful: false }]);
  assert.deepStrictEqual(E.roleTurns({ transcript: '' }), []);
  // A task call without its wrapper: unfaithful.
  const bare = { prompt: PROMPT, transcript: F.transcript({ headText: ['x'] }).replace('"step-finish"}}', '"step-finish"}}\n') + JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'task', state: { status: 'completed', input: { prompt: 'p', subagent_type: 'risk-manager' }, output: 'raw' } } }) };
  assert.deepStrictEqual(E.roleTurns(bare).map(t => t.faithful), [true, false]);
});

test('the real opencode cycle transcript fixture reads as the head trader\'s text and its risk-manager task', () => {
  const doc = { prompt: 'p', transcript: fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'opencode-cycle-transcript.jsonl'), 'utf8') };
  const turns = E.roleTurns(doc);
  assert.ok(turns[0].faithful && turns[0].messages[1].content.length > 0);
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
