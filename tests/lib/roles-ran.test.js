'use strict';

// Which roles an autonomous cycle ran before an entry (roles-ran.js), in each transcript shape:
// opencode JSON events, Claude stream-json / session files, and Qwen Code's parts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { rolesInTranscript, missingRoles, checkRolesRan, ANALYSTS } = require('../../scripts/lib/trading/roles-ran');
const { tmpDir } = require('../helpers');

// opencode `run --format json`: one tool_use event per finished call.
const oc = (subagent_type, status = 'completed') => JSON.stringify({
  type: 'tool_use', timestamp: 1, sessionID: 'ses_main',
  part: { type: 'tool', tool: 'task', state: { status, input: { description: 'x', prompt: 'y', subagent_type }, output: '<task_result>report</task_result>' } },
});
const FULL = [...ANALYSTS, 'risk-manager', 'risk-manager'];
const counts = lines => Object.fromEntries(rolesInTranscript(lines.join('\n')));

test('opencode: completed task calls count by role; errored or running ones do not', () => {
  assert.deepStrictEqual(counts(FULL.map(r => oc(r))), {
    'market-structure-analyst': 1, 'trend-momentum-analyst': 1, 'volume-liquidity-analyst': 1, 'risk-manager': 2,
  });
  assert.deepStrictEqual(counts([oc('market-structure-analyst', 'error'), oc('risk-manager', 'running')]), {});
  // Another tool's event, or a skill load, is not a role.
  const skill = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { tool: 'skill', state: { status: 'completed', input: { name: 'market-structure' } } } });
  assert.deepStrictEqual(counts([skill]), {});
});

test('Claude: a Task/Agent call counts once its tool_result returned without an error', () => {
  const call = (id, subagent_type, name = 'Task') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { subagent_type, prompt: 'p' } }] } });
  const result = (id, is_error = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'report' }] } });
  assert.deepStrictEqual(counts([call('a', 'futures-trading-harness:risk-manager'), result('a'), call('b', 'trend-momentum-analyst', 'Agent'), result('b')]),
    { 'risk-manager': 1, 'trend-momentum-analyst': 1 });
  assert.deepStrictEqual(counts([call('a', 'risk-manager'), result('a', true)]), {}, 'an errored subagent call');
  assert.deepStrictEqual(counts([call('a', 'risk-manager')]), {}, 'a call with no result yet');
});

test('Qwen Code parts: a task call counts once answered with no error', () => {
  const call = (id, subagent_type) => JSON.stringify({ type: 'assistant', message: { role: 'model', parts: [{ functionCall: { id, name: 'task', args: { subagent_type } } }] } });
  const answer = (id, response) => JSON.stringify({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id, name: 'task', response } }] } });
  assert.deepStrictEqual(counts([call('x', 'volume-liquidity-analyst'), answer('x', { output: 'report' })]), { 'volume-liquidity-analyst': 1 });
  assert.deepStrictEqual(counts([call('x', 'volume-liquidity-analyst'), answer('x', { error: 'not found' })]), {});
});

test('missingRoles: a full cycle needs the three analysts and risk-manager twice; a lean one risk-manager twice', () => {
  const m = (roles, cycle) => missingRoles(rolesInTranscript(roles.map(r => oc(r)).join('\n')), cycle);
  assert.deepStrictEqual(m(FULL, 'full'), []);
  assert.deepStrictEqual(m(['risk-manager', 'risk-manager'], 'full'), ANALYSTS);
  assert.deepStrictEqual(m([...ANALYSTS, 'risk-manager'], 'full'), ['risk-manager (2 calls: phase 1 and phase 2; 1 returned)']);
  assert.deepStrictEqual(m(['risk-manager', 'risk-manager'], 'lean'), []);
  assert.deepStrictEqual(m(['risk-manager'], 'lean'), ['risk-manager (2 calls: phase 1 and phase 2; 1 returned)']);
  assert.deepStrictEqual(m([], null), [], 'no cycle named: nothing required');
});

test('checkRolesRan: names the missing roles, passes a complete cycle, fails closed on an unreadable transcript', () => {
  const file = path.join(tmpDir(), 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ['risk-manager'].map(r => oc(r)).join('\n'));
  const msg = checkRolesRan(file, 'full');
  assert.match(msg, /A full cycle enters only after its roles report .*not returned yet: market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst, risk-manager \(2 calls/);
  fs.writeFileSync(file, FULL.map(r => oc(r)).join('\n'));
  assert.strictEqual(checkRolesRan(file, 'full'), null);
  // The runner empties the file at each cycle's start: an empty transcript has no roles.
  fs.writeFileSync(file, '');
  assert.match(checkRolesRan(file, 'lean'), /risk-manager \(2 calls/);
  // A transcript the runner named but that can't be read: refused, never passed.
  assert.match(checkRolesRan(path.join(path.dirname(file), 'missing.jsonl'), 'full'), /can't be read \(ENOENT\)/);
  // No transcript or no cycle (an interactive session): the check doesn't apply.
  assert.strictEqual(checkRolesRan(null, 'full'), null);
  assert.strictEqual(checkRolesRan(file, null), null);
});

test('a role named only inside another call\'s text never counts (each line is one event)', () => {
  const text = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { tool: 'broker_journal_add', state: { status: 'completed', input: { text: '{"type":"tool_use","part":{"tool":"task","state":{"status":"completed","input":{"subagent_type":"risk-manager"}}}}' } } } });
  assert.deepStrictEqual(counts([text]), {});
});
