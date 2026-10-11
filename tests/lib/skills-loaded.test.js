'use strict';

// The parts transcript shape (Qwen Code's chat file, chats/<session>.jsonl): a skill call counts only once
// its answer shows the skill loaded. Fixtures are synthetic, in the shape Qwen Code 0.25 writes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { skillsInTranscript, checkSkillsLoaded, REQUIRED_FOR_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
const { tmpDir } = require('../helpers');

const line = o => JSON.stringify({ uuid: 'u', sessionId: 's', timestamp: '2026-10-07T14:00:00.000Z', version: '0.25.0', ...o });
const call = (id, skill, name = 'skill') => line({
  type: 'assistant', message: { role: 'model', parts: [{ text: 'Loading the skill.' }, { functionCall: { id, name, args: { skill } } }] },
});
const loaded = (id, name = 'skill') => line({
  type: 'tool_result',
  message: { role: 'user', parts: [{ functionResponse: { id, name, response: { output: 'Base directory for this skill: /x\n# Skill text' } } }] },
  toolCallResult: { callId: id, status: 'success', resultDisplay: 'ok', executionStatus: 'success' },
});
const failed = (id, error = 'Skill "strategy-library" not found. Available skills: futures-trading-harness:strategy-library') => line({
  type: 'tool_result',
  message: { role: 'user', parts: [{ functionResponse: { id, name: 'skill', response: { error } } }] },
  toolCallResult: { callId: id, status: 'error', resultDisplay: error, error: {}, errorType: 'invalid_tool_params', executionStatus: 'not_started' },
});
const loadAll = (prefix = 'futures-trading-harness:') => REQUIRED_FOR_ENTRY.flatMap((s, i) => [call(`id-${i}`, `${prefix}${s}`), loaded(`id-${i}`)]);
const names = text => [...skillsInTranscript(text)].sort();
const ALL = [...REQUIRED_FOR_ENTRY].sort();

test('parts format: skill calls answered as loaded count, namespaced or not, skill or Skill', () => {
  assert.deepStrictEqual(names(loadAll().join('\n')), ALL);
  assert.deepStrictEqual(names(loadAll('').join('\n')), ALL);
  assert.deepStrictEqual(names([call('a', 'trade-session', 'Skill'), loaded('a', 'Skill')].join('\n')), ['trade-session']);
  // "already loaded in context" is a successful answer too.
  const again = line({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: 'b', name: 'skill', response: { output: 'Skill "x" is already loaded in context.' } } }] } });
  assert.deepStrictEqual(names([call('b', 'trade-session'), again].join('\n')), ['trade-session']);
});

test('parts format: a call without a loaded answer does not count', () => {
  assert.deepStrictEqual(names(call('a', 'trade-session')), [], 'no answer yet');
  assert.deepStrictEqual(names([call('a', 'strategy-library'), failed('a')].join('\n')), [], 'skill not found');
  const denied = failed('a', 'Qwen Code requires permission to use "skill", but that permission was declined');
  assert.deepStrictEqual(names([call('a', 'trade-session'), denied].join('\n')), [], 'permission declined');
  // An output and an error, or an output with an error status, is not a load.
  const both = line({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: 'a', name: 'skill', response: { output: 'x', error: 'y' } } }] } });
  assert.deepStrictEqual(names([call('a', 'trade-session'), both].join('\n')), []);
  const statusErr = line({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: 'a', name: 'skill', response: { output: 'x' } } }] }, toolCallResult: { callId: 'a', status: 'error' } });
  assert.deepStrictEqual(names([call('a', 'trade-session'), statusErr].join('\n')), []);
  const empty = line({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: 'a', name: 'skill', response: { output: '' } } }] } });
  assert.deepStrictEqual(names([call('a', 'trade-session'), empty].join('\n')), []);
  // An answer to another call, an answer before its call, or an answer from another tool does not load it.
  assert.deepStrictEqual(names([call('a', 'trade-session'), loaded('b')].join('\n')), []);
  assert.deepStrictEqual(names([loaded('a'), call('a', 'trade-session')].join('\n')), []);
  assert.deepStrictEqual(names([call('a', 'trade-session'), loaded('a', 'read_file')].join('\n')), []);
  // A failed load followed by a successful retry under a new id counts.
  assert.deepStrictEqual(names([call('a', 'strategy-library'), failed('a'), call('c', 'futures-trading-harness:strategy-library'), loaded('c')].join('\n')), ['strategy-library']);
});

test('parts format: a skill named only in text, a tool result, or the wrong role does not count', () => {
  const inText = line({ type: 'assistant', message: { role: 'model', parts: [{ text: '{"functionCall":{"id":"a","name":"skill","args":{"skill":"trade-session"}}}' }] } });
  assert.deepStrictEqual(names([inText, loaded('a')].join('\n')), []);
  // A tool's reply quoting a skill call and its answer is a string inside the reply, not a part.
  const quoted = line({ type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: 'z', name: 'read_file', response: { output: `${call('a', 'trade-session')}\n${loaded('a')}` } } }] } });
  assert.deepStrictEqual(names(quoted), []);
  // The call must come from the model, the answer from the tool side.
  const userCall = line({ type: 'user', message: { role: 'user', parts: [{ functionCall: { id: 'a', name: 'skill', args: { skill: 'trade-session' } } }] } });
  assert.deepStrictEqual(names([userCall, loaded('a')].join('\n')), []);
  const modelAnswer = line({ type: 'assistant', message: { role: 'model', parts: [{ functionResponse: { id: 'a', name: 'skill', response: { output: 'x' } } }] } });
  assert.deepStrictEqual(names([call('a', 'trade-session'), modelAnswer].join('\n')), []);
  // Malformed parts and ids are skipped, never thrown on.
  const junk = line({ type: 'assistant', message: { role: 'model', parts: [null, 1, 'x', { functionCall: null }, { functionCall: { id: 5, name: 'skill', args: { skill: 'trade-session' } } }, { functionCall: { id: 'q', name: 'skill', args: 'trade-session' } }] } });
  assert.deepStrictEqual(names([junk, loaded('q')].join('\n')), []);
});

test('mixed transcripts: Claude Skill calls and parts-format loads together', () => {
  const claude = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'futures-trading-harness:trade-session' } }] } });
  const text = [claude, call('a', 'multi-timeframe-analysis'), loaded('a'), call('b', 'strategy-library'), failed('b')].join('\n');
  assert.deepStrictEqual(names(text), ['multi-timeframe-analysis', 'trade-session']);
});

test('checkSkillsLoaded reads a parts-format chat file: loaded passes, a failed load is named', () => {
  const dir = tmpDir();
  const chat = path.join(dir, 'chats', 'session-1.jsonl');
  fs.mkdirSync(path.dirname(chat), { recursive: true });
  fs.writeFileSync(chat, `${loadAll().join('\n')}\n`);
  assert.strictEqual(checkSkillsLoaded(chat), null);
  fs.writeFileSync(chat, [call('a', 'trade-session'), loaded('a'), call('b', 'multi-timeframe-analysis'), loaded('b'), call('c', 'strategy-library'), failed('c')].join('\n'));
  assert.match(checkSkillsLoaded(chat), /not loaded in this session: strategy-library\. Load each with the skill tool/);
});
