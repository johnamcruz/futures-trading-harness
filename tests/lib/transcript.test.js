'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { documents, parsed, BRIDGE_TOOLS, unwrap, resultText, bridgeRefused, SHELL_TOOLS, claudeRunResult } = require('../../scripts/lib/transcript');
const hc = require('../../scripts/lib/headless-check');

test('claudeRunResult: a Claude Code stream-json run\'s final message and the tools it completed, named as the engine\'s checks read them; errors, unanswered calls and a subagent\'s calls are not its', () => {
  const use = (id, name, input = {}, parent = null) => JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, isError = false, parent = null) => JSON.stringify({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] } });
  const text = t => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    use('a', 'mcp__harness__bar_briefing'), res('a'),
    use('b', 'mcp__broker__place_order'), res('b', true),
    use('c', 'Read'), res('c'),
    use('d', 'tool_call', { name: 'mcp__broker__get_account_snapshot', arguments: '{}' }), res('d'),
    use('e', 'Skill', { skill: 'x' }),
    use('f', 'mcp__broker__place_order', {}, 'zz'), res('f', false, 'zz'),
    text('first'), text('## Report'),
  ];
  assert.deepStrictEqual(claudeRunResult(lines.join('\n')), { text: '## Report', tools: ['harness_bar_briefing', 'read', 'broker_get_account_snapshot'] });
  // The result event's text is the final message when there is one.
  assert.strictEqual(claudeRunResult([...lines, JSON.stringify({ type: 'result', subtype: 'success', result: 'EXECUTED' })].join('\n')).text, 'EXECUTED');
  // A run that ended in an error result (max turns, a crash) wrote no report, whatever text came before it and whatever
  // its exit code: a truncated run is never read as a role's report.
  assert.strictEqual(claudeRunResult([...lines, JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Reached max turns' })].join('\n')).text, '');
  assert.deepStrictEqual(claudeRunResult(''), { text: '', tools: [] });
  assert.deepStrictEqual(claudeRunResult('not json\n{"type":"result"}'), { text: '', tools: [] });
});

test('documents: one JSON document, one per line, or what parses after warning lines', () => {
  assert.deepStrictEqual(documents('[{"a":1}]'), [[{ a: 1 }]]);
  assert.deepStrictEqual(documents('{"a":1}\n{"b":2}\nnot json\n42'), [{ a: 1 }, { b: 2 }], 'stream-json lines; text and bare values skipped');
  assert.deepStrictEqual(documents('Warning: a long context\n[{"type":"result"}]\n'), [[{ type: 'result' }]], 'Qwen prints warnings before its JSON');
  assert.deepStrictEqual(documents(''), []);
  assert.deepStrictEqual(documents(null), []);
});

test('parsed: a JSON string\'s value, else null; anything else as is', () => {
  assert.deepStrictEqual(parsed('{"x":1}'), { x: 1 });
  assert.strictEqual(parsed('{oops'), null);
  const o = { y: 2 };
  assert.strictEqual(parsed(o), o);
});

test('unwrap: a bridge call is the tool it reaches, with its arguments; anything else is itself', () => {
  const r = unwrap('tool_call', { name: 'mcp__broker__place_order', arguments: { size: 1 } });
  assert.deepStrictEqual([r.name, r.input, r.bridge && r.bridge.name], ['mcp__broker__place_order', { size: 1 }, 'tool_call']);
  assert.deepStrictEqual(unwrap('tool_call', JSON.stringify({ name: 'x', arguments: '{"a":1}' })).input, { a: 1 }, 'string input and string arguments');
  assert.deepStrictEqual(unwrap('tool_call', { name: 'x', arguments: 'garbage' }).input, {}, 'unparseable arguments: none');
  assert.deepStrictEqual(unwrap('tool_call', { arguments: {} }), { name: 'tool_call', input: { arguments: {} } }, 'no target: the wrapper itself');
  assert.deepStrictEqual(unwrap('tool_call', { name: '' }), { name: 'tool_call', input: { name: '' } });
  assert.deepStrictEqual(unwrap('Bash', { command: 'ls' }), { name: 'Bash', input: { command: 'ls' } });
  assert.deepStrictEqual(unwrap('Bash', undefined), { name: 'Bash', input: {} });
  assert.ok(BRIDGE_TOOLS[0].refused.test('[tool_call bridge refused] Deferred tool "x" has no verified schema'));
  assert.ok(!BRIDGE_TOOLS[0].refused.test('order gate: refused [plan-required]'));
  assert.ok(!BRIDGE_TOOLS[0].refused.test('you wrote "[tool_call bridge refused]"'), 'anchored at the start');
  const call = unwrap('tool_call', { name: 'x' });
  assert.strictEqual(bridgeRefused(call, { is_error: true, content: '[tool_call bridge refused] Deferred' }), true);
  assert.strictEqual(bridgeRefused(call, { is_error: true, content: [{ type: 'text', text: '[tool_call bridge refused] Deferred' }] }), true);
  assert.strictEqual(bridgeRefused(call, { is_error: false, content: '[tool_call bridge refused] Deferred' }), false, 'an answer, not an error');
  assert.strictEqual(bridgeRefused(call, { is_error: true, content: 'refused: "[tool_call bridge refused]"' }), false);
  assert.strictEqual(bridgeRefused(unwrap('Bash', {}), { is_error: true, content: '[tool_call bridge refused]' }), false, 'not a bridged call');
  assert.deepStrictEqual([resultText('a'), resultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), resultText({ x: 1 })], ['a', 'a\n\nb', '{"x":1}']);
  // One list, shared by the headless check and the cycle log.
  assert.strictEqual(hc.BRIDGE_TOOLS, BRIDGE_TOOLS);
  assert.ok(SHELL_TOOLS.has('Bash') && SHELL_TOOLS.has('run_shell_command') && !SHELL_TOOLS.has('tool_call'));
});

test('opencode: events are recognized by their whole envelope; tool parts name MCP tools as the other harnesses do', () => {
  const { isOpencodeEvent, opencodeCall } = require('../../scripts/lib/transcript');
  const ev = { type: 'text', timestamp: 1, sessionID: 'ses_1', part: { type: 'text', text: 'hi' } };
  assert.ok(isOpencodeEvent(ev));
  assert.ok(isOpencodeEvent({ type: 'error', timestamp: 1, sessionID: 'ses_1', error: { name: 'APIError' } }));
  for (const bad of [{ ...ev, sessionID: undefined }, { ...ev, timestamp: '1' }, { ...ev, part: null }, { ...ev, type: 'result' }, { type: 'error', timestamp: 1, sessionID: 's' }, [ev], null, 'text'])
    assert.ok(!isOpencodeEvent(bad), JSON.stringify(bad));
  assert.deepStrictEqual(opencodeCall({ tool: 'broker_place_order', state: { status: 'completed', input: { size: 1 }, output: 'ok' } }), { name: 'mcp__broker__place_order', input: { size: 1 }, result: { isError: false, text: 'ok' } });
  assert.deepStrictEqual(opencodeCall({ tool: 'harness_strategies_list', state: { status: 'error', input: {}, error: 'boom' } }), { name: 'mcp__harness__strategies_list', input: {}, result: { isError: true, text: 'boom' } });
  assert.deepStrictEqual(opencodeCall({ tool: 'skill', state: { status: 'running', input: { name: 'trade-session' } } }), { name: 'skill', input: { name: 'trade-session' }, result: null });
  assert.deepStrictEqual(opencodeCall({ tool: 'broker_', state: {} }).name, 'broker_', 'a server prefix alone is not a tool');
  assert.deepStrictEqual(opencodeCall({ tool: 'brokerage_x', state: { input: 'x' } }), { name: 'brokerage_x', input: {}, result: null });
  assert.ok(SHELL_TOOLS.has('bash'));
});

test('claudeRunUsage: a run\'s prompt-cache use from its stream (the result event\'s usage, its first turn\'s, its turns); a subagent\'s events, or no result usage: none', () => {
  const { claudeRunUsage } = require('../../scripts/lib/transcript');
  const u = (read, made, input = 3, output = 10) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: made, output_tokens: output });
  const asst = (id, usage, parent = null) => JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { id, usage, content: [{ type: 'text', text: 'x' }] } });
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    asst('sub', u(1, 1), 'tool-1'),
    asst('m1', u(25310, 59715)), asst('m1', u(25310, 59715)), asst('m2', u(85025, 1600)),
    JSON.stringify({ type: 'result', is_error: false, result: 'done', usage: u(110335, 61315, 9, 4000) }),
  ];
  assert.deepStrictEqual(claudeRunUsage(lines.join('\n')), {
    total: { input: 9, cacheRead: 110335, cacheCreation: 61315, output: 4000 },
    first: { input: 3, cacheRead: 25310, cacheCreation: 59715, output: 10 },
    turns: 2,
  });
  assert.strictEqual(claudeRunUsage(lines.slice(0, -1).join('\n')), null, 'no result event');
  assert.strictEqual(claudeRunUsage(''), null);
  assert.strictEqual(claudeRunUsage('CYCLE RESULT: no-trade - x'), null);
  assert.deepStrictEqual(claudeRunUsage(JSON.stringify({ type: 'result', usage: { cache_read_input_tokens: 'x' } })), { total: { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }, first: null, turns: 0 });
});
