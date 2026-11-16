'use strict';

// The head trader's turn from a Claude Code run record (scripts/lib/learning/claude-turns.js), as the same chat
// messages the opencode reader gives: faithful or nothing. The fixture is a sanitized, shortened copy of a recorded
// run's stream (its shape: a deferred tool's schema load, two calls in one message, thinking blocks, the result event).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const CT = require('../../scripts/lib/learning/claude-turns');
const E = require('../../scripts/lib/learning/decision-examples');
const { documents } = require('../../scripts/lib/transcript');
const { tmpDir } = require('../helpers');
const F = require('../fixtures/decision-run');

const TEXT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-cycle-transcript.jsonl'), 'utf8');
const events = () => documents(TEXT);
const without = (evs, pred) => evs.filter(e => !pred(e));
const asText = evs => evs.map(e => JSON.stringify(e)).join('\n');

test('isClaudeStream: a Claude Code stream (its init event, known event types); opencode\'s events are not', () => {
  assert.strictEqual(CT.isClaudeStream(events()), true);
  assert.strictEqual(CT.isClaudeStream(without(events(), e => e.subtype === 'init')), false);
  assert.strictEqual(CT.isClaudeStream([...events(), { type: 'mystery' }]), false, 'an event of a kind it doesn\'t know');
  assert.strictEqual(CT.isClaudeStream(documents(F.transcript({ headText: ['x'] }))), false);
  assert.strictEqual(CT.isClaudeStream([]), false);
});

test('claudeHeadMessages: each step one assistant message, results as tool messages, byte for byte; a schema load left out and counted', () => {
  const { messages, omitted } = CT.claudeHeadMessages(events());
  assert.strictEqual(omitted, 1, 'the deferred tool\'s schema load');
  assert.deepStrictEqual(messages.map(m => m.role), ['assistant', 'tool', 'tool', 'assistant']);
  // Two calls in one API message (its id), their results streamed between them: one assistant message.
  assert.deepStrictEqual(messages[0].tool_calls.map(c => c.function.name), ['mcp__harness__reason_check', 'mcp__broker__journal_add']);
  assert.strictEqual(messages[0].content, '');
  assert.deepStrictEqual(JSON.parse(messages[0].tool_calls[1].function.arguments), { kind: 'note', contractId: 'MNQ', tags: ['MNQ', 'no-trade'], text: '09:30 ET cycle — no entry →' });
  assert.deepStrictEqual(messages.slice(1, 3).map(m => m.tool_call_id), messages[0].tool_calls.map(c => c.id));
  assert.strictEqual(messages[1].content, 'Reasons checked against this bar\'s facts:\n- TRUE no-entry-window: "opening print"\t\n', 'the result\'s bytes');
  assert.strictEqual(messages[3].content, 'PLAN: no trade  \nCYCLE RESULT: no-trade - opening print\n', 'the final text\'s bytes');
  assert.ok(!JSON.stringify(messages).includes('ToolSearch') && !JSON.stringify(messages).includes('signature'), 'no schema load, no thinking block');
});

test('claudeHeadMessages: anything it can\'t read whole gives null, never a guess', () => {
  const evs = events();
  const result = e => e.type === 'result';
  assert.strictEqual(CT.claudeHeadMessages(without(evs, result)), null, 'no result event');
  assert.strictEqual(CT.claudeHeadMessages(evs.map(e => (result(e) ? { ...e, is_error: true } : e))), null, 'an error result');
  assert.strictEqual(CT.claudeHeadMessages(evs.map(e => (result(e) ? { ...e, subtype: 'error_max_turns' } : e))), null, 'a run cut off');
  const firstResult = evs.findIndex(e => e.type === 'user' && e.message.content[0].tool_use_id === 'toolu_fx3');
  assert.strictEqual(CT.claudeHeadMessages(evs.filter((_e, i) => i !== firstResult)), null, 'a call never answered');
  const image = evs.map((e, i) => (i === firstResult ? { ...e, message: { ...e.message, content: [{ ...e.message.content[0], content: [{ type: 'text', text: 'x' }, { type: 'image', source: {} }] }] } } : e));
  assert.strictEqual(CT.claudeHeadMessages(image), null, 'a result with an image');
  const injected = [...evs.slice(0, firstResult), { type: 'user', message: { role: 'user', content: 'a message injected mid-turn' }, session_id: 's' }, ...evs.slice(firstResult)];
  assert.strictEqual(CT.claudeHeadMessages(injected), null, 'a user message that isn\'t tool results');
  const dup = evs.map(e => (e.type === 'assistant' && e.message.content[0].id === 'toolu_fx5' ? { ...e, message: { ...e.message, content: [{ ...e.message.content[0], id: 'toolu_fx3' }] } } : e));
  assert.strictEqual(CT.claudeHeadMessages(dup), null, 'a repeated call id');
  const unknown = evs.map(e => (e.type === 'assistant' && e.message.content[0].type === 'text' ? { ...e, message: { ...e.message, content: [{ type: 'server_tool_use', id: 'x' }] } } : e));
  assert.strictEqual(CT.claudeHeadMessages(unknown), null, 'a block of a kind it doesn\'t know');
  const noFinalText = evs.filter(e => !(e.type === 'assistant' && e.message.content[0].type === 'text'));
  assert.strictEqual(CT.claudeHeadMessages(noFinalText), null, 'a turn that doesn\'t end in text');
});

test('claudeHeadMessages: a subagent\'s own events are not the head trader\'s turn; a text after a call in one message starts the next', () => {
  const evs = events();
  const at = evs.findIndex(e => e.type === 'result');
  const sub = { type: 'assistant', message: { id: 'msg_sub', content: [{ type: 'text', text: 'SUBAGENT TEXT' }] }, parent_tool_use_id: 'toolu_fx3', session_id: 's' };
  const r = CT.claudeHeadMessages([...evs.slice(0, at), sub, ...evs.slice(at)]);
  assert.ok(r && !JSON.stringify(r.messages).includes('SUBAGENT TEXT'));
  const mixed = [
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'A' }, { type: 'tool_use', id: 't1', name: 'Read', input: { p: 1 } }, { type: 'text', text: 'B' }] }, session_id: 's' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'R', is_error: true }] }, session_id: 's' },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
  ];
  assert.deepStrictEqual(CT.claudeHeadMessages(mixed).messages, [
    { role: 'assistant', content: 'A', tool_calls: [{ id: 't1', type: 'function', function: { name: 'Read', arguments: '{"p":1}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'R' },
    { role: 'assistant', content: 'B' },
  ]);
});

test('claudeHeadMessages: a hook\'s feedback mid-turn (isSynthetic, text only) is a user message, byte for byte; a plain one is not read', () => {
  const evs = events();
  const at = evs.findIndex(e => e.type === 'result');
  const hook = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Stop hook feedback:\n review it  ' }] }, parent_tool_use_id: null, session_id: 's', isSynthetic: true };
  const again = { type: 'assistant', message: { id: 'msg_again', content: [{ type: 'text', text: 'CYCLE RESULT: again\n' }] }, session_id: 's' };
  const { messages } = CT.claudeHeadMessages([...evs.slice(0, at), hook, again, evs[at]]);
  assert.deepStrictEqual(messages.slice(-3).map(m => [m.role, m.content]), [['assistant', 'PLAN: no trade  \nCYCLE RESULT: no-trade - opening print\n'], ['user', 'Stop hook feedback:\n review it  '], ['assistant', 'CYCLE RESULT: again\n']]);
  const plain = { ...hook };
  delete plain.isSynthetic;
  assert.strictEqual(CT.claudeHeadMessages([...evs.slice(0, at), plain, again, evs[at]]), null);
});

test('resumedSession: a resumed or forked session continues a history the record doesn\'t hold', () => {
  assert.strictEqual(CT.resumedSession({ argv: ['claude', '-p', 'x'] }, events()), null);
  assert.match(CT.resumedSession({ argv: ['claude', '--resume', 'abc', '--fork-session'] }, events()), /resumed a session \(--resume\)/);
  assert.match(CT.resumedSession({ argv: ['claude', '--continue'] }, []), /--continue/);
  const fork = events().map(e => (e.hook_name ? { ...e, hook_name: 'SessionStart:fork' } : e));
  assert.match(CT.resumedSession({ argv: ['claude'] }, fork), /SessionStart:fork/);
});

test('appendedSystemPrompt: the file the run appended, read in the run home and checked against the sha256 in its name', () => {
  const home = tmpDir();
  const text = 'You are the head trader.  \n';
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  fs.mkdirSync(path.join(home, 'head-prompt'));
  fs.writeFileSync(path.join(home, 'head-prompt', `claude-head-${sha}.md`), text);
  const argv = file => ({ argv: ['claude', '-p', 'x', '--append-system-prompt-file', file] });
  assert.deepStrictEqual(CT.appendedSystemPrompt(argv(`/elsewhere/head-prompt/claude-head-${sha}.md`), home), { prompt: text }, 'by its folder and name in the run home');
  assert.deepStrictEqual(CT.appendedSystemPrompt({ argv: ['claude', '-p', 'x'] }, home), { none: true });
  assert.match(CT.appendedSystemPrompt(argv(`/x/head-prompt/claude-head-${'0'.repeat(64)}.md`), home).error, /not in the run home/);
  fs.writeFileSync(path.join(home, 'head-prompt', `claude-head-${sha}.md`), `${text}edited`);
  assert.match(CT.appendedSystemPrompt(argv(`/x/head-prompt/claude-head-${sha}.md`), home).error, /doesn't match/);
  assert.match(CT.appendedSystemPrompt({ argv: ['claude', '--system-prompt', 'inline'] }, home).error, /inline/);
});

test('roleTurns on a Claude Code record: the head turn with the appended system prompt; resumed, unreadable or a launched subagent: no example', () => {
  const home = tmpDir();
  const text = 'HEAD SYSTEM\n';
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  fs.mkdirSync(path.join(home, 'head-prompt'));
  fs.writeFileSync(path.join(home, 'head-prompt', `claude-head-${sha}.md`), text);
  const argv = ['claude', '-p', '<prompt>', '--append-system-prompt-file', `/run/head-prompt/claude-head-${sha}.md`];
  const doc = { prompt: 'CYCLE PROMPT  \r\n', argv, transcript: TEXT };
  const [head] = E.roleTurns(doc, { home });
  assert.strictEqual(head.faithful, true);
  assert.deepStrictEqual(head.messages.slice(0, 2), [{ role: 'system', content: text }, { role: 'user', content: 'CYCLE PROMPT  \r\n' }]);
  assert.strictEqual(head.omitted, 1);
  assert.strictEqual(E.roleTurns({ ...doc, argv: [...argv, '--resume', 's', '--fork-session'] }, { home })[0].faithful, false, 'resumed');
  assert.strictEqual(E.roleTurns(doc, { home: tmpDir() })[0].faithful, false, 'its system prompt not in the run home');
  assert.strictEqual(E.roleTurns({ ...doc, argv: ['claude'] }, { home })[0].messages[0].role, 'user', 'none appended: no system message');
  const evs = events();
  const at = evs.findIndex(e => e.type === 'result');
  const agent = { type: 'assistant', message: { id: 'msg_a', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { subagent_type: 'risk-manager', prompt: 'check' } }] }, session_id: 's' };
  const res = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: 'APPROVE' }] }] }, session_id: 's' };
  const final = evs.filter(e => e.type === 'assistant' && e.message.content[0].type === 'text').map(e => ({ ...e, message: { ...e.message, id: 'msg_z' } }));
  const turns = E.roleTurns({ ...doc, transcript: asText([...evs.slice(0, at - 2), agent, res, ...final, evs[at]]) }, { home });
  assert.strictEqual(turns[0].faithful, true, 'the head turn keeps its Agent call and result');
  assert.ok(turns[0].messages.some(m => m.tool_calls && m.tool_calls.some(c => c.function.name === 'Agent')));
  assert.deepStrictEqual(turns.slice(1).map(t => [t.role, t.faithful, t.subagent]), [['risk-manager', false, true]]);
});

test('verifySubagents: only a risk-manager reply whose cycle fact check holds one report, every claim true', () => {
  const sub = { role: 'risk-manager', faithful: true, subagent: true, messages: [] };
  const head = { role: 'fth-head-trader', faithful: true, messages: [] };
  const v = (turns, factCheck) => E.verifySubagents(turns, { factCheck }).filter(t => t.subagent).map(t => t.verified);
  assert.deepStrictEqual(v([head, sub], F.FACTS_TRUE), [true]);
  assert.deepStrictEqual(v([head, sub], undefined), [false], 'no fact check');
  const oneFalse = { reports: [{ claims: [{ check: true }, { check: false }] }] };
  assert.deepStrictEqual(v([head, sub], oneFalse), [false], 'a false claim');
  assert.deepStrictEqual(v([head, sub], { reports: [{ claims: [{ check: 'unchecked' }] }] }), [false], 'an unchecked claim');
  assert.deepStrictEqual(v([head, sub], { reports: [{ claims: [] }] }), [false], 'no claims');
  assert.deepStrictEqual(v([head, sub, sub], F.FACTS_TRUE), [false, false], 'two replies: which one the report checked is unknown');
  assert.deepStrictEqual(v([head, { ...sub, role: 'market-structure-analyst' }], F.FACTS_TRUE), [false], 'an analyst: no code checks its claims');
  assert.deepStrictEqual(v([head, { ...sub, faithful: false }], F.FACTS_TRUE), [false]);
});
