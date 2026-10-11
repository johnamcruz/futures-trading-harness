'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { summarize, writeCycleLog, toolCalls } = require('../../scripts/lib/cycle-log');
const { checkSkillsLoaded, skillsInTranscript, transcriptFiles, skillName } = require('../../scripts/lib/trading/skills-loaded');
const { cycleResult } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const use = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const claudeStream = skills => [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  ...skills.map(s => use('Skill', { skill: `futures-trading-harness:${s}` })),
  use('Bash', { command: 'node /r/scripts/strategies.js scan /b.json --symbol MNQ' }),
  use('mcp__broker__place_order', { contractId: 'MNQ', side: 'buy', size: 1, type: 'market', rationale: 'setup:orb long, stop 21480' }),
  use('mcp__broker__place_order', { contractId: 'MNQ', side: 'sell', size: 1, type: 'stop', rationale: '[protect] stop' }),
  JSON.stringify({ type: 'result', result: 'Done.\nCYCLE RESULT: executed - orb long 1 MNQ' }),
].join('\n');

test('summarize: skills loaded, tool calls by name, shell commands, orders, and skills an entry needed', () => {
  const all = summarize(claudeStream(['trade-session', 'multi-timeframe-analysis', 'strategy-library']));
  assert.deepStrictEqual(all.skills, ['trade-session', 'multi-timeframe-analysis', 'strategy-library']);
  assert.strictEqual(all.tools.mcp__broker__place_order, 2);
  assert.match(all.commands[0], /strategies\.js scan/);
  assert.strictEqual(all.orders.length, 2);
  assert.deepStrictEqual(all.missingSkills, []);
  assert.deepStrictEqual(summarize(claudeStream(['trade-session'])).missingSkills, ['multi-timeframe-analysis', 'strategy-library']);
  // Codex --json events.
  const codex = [JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'node mtf.js x' } }), JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'broker', tool: 'get_bars', arguments: {} } })].join('\n');
  assert.deepStrictEqual(toolCalls(codex).map(c => c.name), ['Bash', 'mcp__broker__get_bars']);
  assert.strictEqual(summarize('plain text, nothing parsed').skills.length, 0);
  // The cycle result is still found in a stream-json transcript.
  assert.strictEqual(cycleResult(claudeStream([])), 'CYCLE RESULT: executed - orb long 1 MNQ');
});

// A real Qwen Code replay cycle (--output-format json: a warning line, then one JSON array), trimmed and
// anonymized; every MCP tool went through Qwen's tool_call bridge, refused once until tool_search reviewed
// it. The bridged place_order at its end is added (the real cycle stood aside): refused once by the bridge
// (never reached the gate), then sent (refused by the gate: still an order the model sent).
const QWEN_CYCLE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'qwen-cycle-transcript.txt'), 'utf8');

test('summarize: a Qwen transcript counts tools and orders reached through the tool_call bridge', () => {
  const s = summarize(QWEN_CYCLE);
  assert.deepStrictEqual(s.tools, {
    skill: 3,
    mcp__broker__get_server_config: 1,
    mcp__harness__strategies_scan: 1,
    mcp__broker__journal_add: 1,
    mcp__broker__place_order: 1,
    tool_search: 4,
    read_file: 1,
  }, 'each bridged tool once (its bridge refusal never reached it), the wrapper never as a tool');
  assert.ok(!('tool_call' in s.tools));
  assert.deepStrictEqual(s.skills, ['trade-session', 'multi-timeframe-analysis', 'strategy-library']);
  assert.deepStrictEqual(s.orders, [{ contractId: 'MNQ', side: 'buy', size: 1, type: 'market', rationale: 'setup:supertrend long, stop 30827.5 (15 points = 60 ticks)' }]);
  assert.deepStrictEqual(s.missingSkills, [], 'the skills were loaded (Qwen\'s skill tool)');
  // The bridged call's own arguments, not the wrapper's.
  const scan = toolCalls(QWEN_CYCLE).find(c => c.name === 'mcp__harness__strategies_scan');
  assert.deepStrictEqual(Object.keys(scan.input).sort(), ['bars', 'symbol']);
  // Without its skills, a bridged entry is an entry without them.
  const noSkills = QWEN_CYCLE.replace(/"name":"skill"/g, '"name":"noop"').replace(/"skill":"futures-trading-harness:[a-z-]+"/g, '"x":"y"');
  assert.deepStrictEqual(summarize(noSkills).missingSkills, ['trade-session', 'multi-timeframe-analysis', 'strategy-library']);
  // A bridged shell command and an unanswered bridged order count (sent, its answer unknown); a string arguments field is parsed.
  const ev = (name, input, id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const more = JSON.stringify([
    ev('tool_call', { name: 'run_shell_command', arguments: { command: 'node -e 1' } }, 'a'),
    ev('tool_call', { name: 'mcp__broker__place_order', arguments: JSON.stringify({ contractId: 'MES', side: 'sell', size: 2, type: 'market', rationale: '[exit] flat' }) }, 'b'),
    ev('tool_call', { arguments: {} }, 'c'),
  ]);
  const m = summarize(more);
  assert.deepStrictEqual(m.commands, ['node -e 1']);
  assert.deepStrictEqual(m.orders.map(o => [o.contractId, o.size, o.rationale]), [['MES', 2, '[exit] flat']]);
  assert.strictEqual(m.tools.tool_call, 1, 'a wrapper call that names no tool counts as the wrapper');
  // Only the bridge's own refusal hides a call: an error reply that starts with it. A real order whose reply
  // carries the words (its rationale echoed, a gate refusal quoting it, a success) is still an order sent.
  const res = (id, isError, content) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });
  const order = rationale => ({ name: 'mcp__broker__place_order', arguments: { contractId: 'MNQ', side: 'buy', size: 1, type: 'market', rationale } });
  const sneaky = JSON.stringify([
    ev('tool_call', order('setup:orb long [tool_call bridge refused]'), 'o1'), res('o1', false, '{"success":true,"rationale":"setup:orb long [tool_call bridge refused]"}'),
    ev('tool_call', order('setup:orb long b'), 'o2'), res('o2', true, 'order gate: refused [plan-required]; you wrote "[tool_call bridge refused]"'),
    ev('tool_call', order('setup:orb long c'), 'o3'), res('o3', false, '[tool_call bridge refused] Deferred tool'),
    ev('tool_call', order('setup:orb long d'), 'o4'), res('o4', true, [{ type: 'text', text: '  [tool_call bridge refused] Deferred tool "mcp__broker__place_order"' }]),
  ]);
  assert.deepStrictEqual(summarize(sneaky).orders.map(o => o.rationale.slice(-1)), [']', 'b', 'c'], 'only the error reply that is the bridge\'s refusal (text blocks too) is dropped');
  assert.deepStrictEqual(summarize(sneaky).missingSkills, ['trade-session', 'multi-timeframe-analysis', 'strategy-library'], 'the entries still raise the missing-skills alarm');
});

test('writeCycleLog: the whole cycle (prompt, transcript, summary) and one summary line a day', () => {
  const home = tmpDir();
  const at = new Date('2026-10-07T14:03:05Z');
  const context = { symbols: [{ symbol: 'MNQ', day: 'MNQ day: ...' }], unavailable: ['the journal (EACCES)'] };
  const { file, summary } = writeCycleLog(home, { at, action: 'trade', harness: 'claude', prompt: 'P', context, argv: ['claude', '-p', 'P'], output: claudeStream(['trade-session']), result: 'CYCLE RESULT: executed', ok: true, durationMs: 1200 });
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(rec.prompt, 'P');
  assert.deepStrictEqual(rec.context, context, 'what the prompt was built from');
  assert.deepStrictEqual(rec.argv, ['claude', '-p', '<prompt>']);
  assert.ok(rec.transcript.includes('place_order'));
  assert.strictEqual(path.basename(file), '140305-trade.json');
  const line = JSON.parse(fs.readFileSync(path.join(home, 'logs', 'cycles-2026-10-07.jsonl'), 'utf8').trim());
  assert.deepStrictEqual([line.result, line.skills, line.missingSkills], ['CYCLE RESULT: executed', ['trade-session'], summary.missingSkills]);
});

test('skills-loaded: names, transcript files (a subagent reads its session too), and the check', () => {
  assert.strictEqual(skillName('futures-trading-harness:trade-session'), 'trade-session');
  assert.strictEqual(skillName('/strategy-library'), 'strategy-library');
  assert.deepStrictEqual(transcriptFiles('/p/abc/subagents/agent-1.jsonl'), ['/p/abc/subagents/agent-1.jsonl', '/p/abc.jsonl']);
  const dir = tmpDir();
  const main = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(main, claudeStream(['trade-session', 'multi-timeframe-analysis']) + '\n' + JSON.stringify({ type: 'user', message: { content: '<command-name>/strategy-library</command-name>' } }));
  assert.deepStrictEqual([...skillsInTranscript(fs.readFileSync(main, 'utf8'))].sort(), ['multi-timeframe-analysis', 'strategy-library', 'trade-session']);
  assert.strictEqual(checkSkillsLoaded(main), null);
  // The trade-executor subagent's own transcript has no skills; its session's main one does.
  fs.mkdirSync(path.join(dir, 'sess', 'subagents'), { recursive: true });
  const sub = path.join(dir, 'sess', 'subagents', 'agent-1.jsonl');
  fs.writeFileSync(sub, use('mcp__broker__place_order', {}));
  assert.strictEqual(checkSkillsLoaded(sub), null);
  const bare = path.join(dir, 'bare.jsonl');
  fs.writeFileSync(bare, claudeStream(['trade-session']));
  assert.match(checkSkillsLoaded(bare), /not loaded in this session: multi-timeframe-analysis, strategy-library/);
  assert.strictEqual(checkSkillsLoaded(null), null, 'no transcript (Codex, Qwen): not applicable');
  assert.strictEqual(checkSkillsLoaded(path.join(dir, 'missing.jsonl')), null);
});

// opencode `run --format json`: one event per line (tests/fixtures/opencode-probe-transcript.jsonl is a real
// probe; this cycle is synthetic in the same format): MCP tools by server, a skill that failed to load,
// an order the gate refused and the one it took, a refused shell, a warning line between events.
const OPENCODE_CYCLE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'opencode-cycle-transcript.jsonl'), 'utf8');

test('summarize: an opencode transcript counts its tools, its orders (refused ones too), and only the skills it loaded', () => {
  const s = summarize(OPENCODE_CYCLE);
  assert.deepStrictEqual(s.tools, { skill: 3, mcp__harness__strategies_scan: 1, task: 1, mcp__broker__place_order: 2, mcp__broker__journal_add: 1, Bash: 1 });
  assert.deepStrictEqual(s.skills, ['trade-session', 'multi-timeframe-analysis'], 'the failed load is not a load');
  assert.deepStrictEqual(s.missingSkills, ['strategy-library']);
  assert.deepStrictEqual(s.orders.map(o => [o.contractId, o.side, o.size, o.type]), [['MNQ', 0, 1, 2], ['MNQ', 0, 1, 2]]);
  assert.deepStrictEqual(s.commands, ['node -e 1']);
  assert.deepStrictEqual(toolCalls(OPENCODE_CYCLE).find(c => c.name === 'mcp__harness__strategies_scan').input, { symbol: 'MNQ', timeframe: '3m' });
  assert.strictEqual(cycleResult(OPENCODE_CYCLE), 'CYCLE RESULT: executed - orb long MNQ 1 after the plan was journaled');
  // Another server's tool keeps its opencode name; nothing outside the envelope counts.
  const other = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'github_create_issue', state: { status: 'completed', input: {} } } });
  assert.deepStrictEqual(toolCalls(other).map(c => c.name), ['github_create_issue']);
  assert.deepStrictEqual(toolCalls(JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'broker_place_order', state: { input: {} } } })), []);
});

test('toolCalls: calls that came back an error are failed in every format; a call opencode stopped itself is stopped', () => {
  // opencode: one its permission rules denied, one it doesn't have (stopped: no tool saw them), one the tool answered with an error.
  const oc = (tool, state) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool, state } });
  const opencode = [
    oc('bash', { status: 'error', input: { command: 'rm -rf /' }, error: 'The user has specified a rule which prevents you from using this specific tool call. Try a different approach.' }),
    oc('strategies_show', { status: 'error', input: {}, error: "Model tried to call unavailable tool 'invalid'." }),
    oc('broker_place_order', { status: 'error', input: { size: 1 }, error: 'order gate refused' }),
  ].join('\n');
  assert.deepStrictEqual(toolCalls(opencode).map(c => [c.name, Boolean(c.failed), Boolean(c.stopped)]), [['bash', true, true], ['strategies_show', true, true], ['mcp__broker__place_order', true, false]]);
  // Claude: an is_error tool_result.
  const claude = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__broker__place_order', input: {} }, { type: 'tool_use', id: 'b', name: 'mcp__broker__get_bars', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'invalid arguments' }, { type: 'tool_result', tool_use_id: 'b', content: '[]' }] } }),
  ].join('\n');
  assert.deepStrictEqual(toolCalls(claude).map(c => Boolean(c.failed)), [true, false]);
  // Codex: a failed MCP call.
  const codex = [{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'broker', tool: 'place_order', arguments: {}, status: 'failed' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'broker', tool: 'get_bars', arguments: {}, status: 'completed' } }].map(x => JSON.stringify(x)).join('\n');
  assert.deepStrictEqual(toolCalls(codex).map(c => Boolean(c.failed)), [true, false]);
  // Codex announces each item before it completes: counted once; an error or an isError result is failed.
  const ev = (type, item) => JSON.stringify({ type, item: { id: 'm1', type: 'mcp_tool_call', server: 'broker', tool: 'place_order', arguments: { size: 1 }, ...item } });
  const twice = [ev('item.started', { status: 'in_progress' }), ev('item.updated', { status: 'in_progress' }), ev('item.completed', { status: 'completed', result: { isError: true, content: [] } })].join('\n');
  assert.deepStrictEqual(toolCalls(twice).map(c => [c.name, Boolean(c.failed)]), [['mcp__broker__place_order', true]]);
  assert.deepStrictEqual(summarize(twice).orders.length, 1);
  assert.strictEqual(toolCalls(ev('item.completed', { status: 'completed', error: { message: 'refused' } }))[0].error, 'refused');
  // opencode: a call the user rejected when asked never reached a tool either.
  const rejected = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'broker_place_order', state: { status: 'error', input: {}, error: 'The user rejected permission to use this specific tool call.' } } });
  assert.strictEqual(toolCalls(rejected)[0].stopped, true);
});
