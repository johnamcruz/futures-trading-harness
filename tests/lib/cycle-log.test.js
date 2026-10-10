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
