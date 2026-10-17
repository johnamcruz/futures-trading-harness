'use strict';

// The tool-call layer's dispatcher for Claude Code (scripts/hooks/toolcall.js): the same rules, Claude's names, the
// call log in a file per session, a refusal as exit 2, a note as the result's added context.

const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../../scripts/hooks/toolcall');
const { tmpDir } = require('../helpers');

test('toolcall hook: compose_check before the desk reported is refused (exit 2) in Claude\'s names; a role report after it, then it goes', () => {
  const home = tmpDir();
  const env = { FTH_HOME: home, FTH_CYCLE_DESK: 'risk-manager' };
  const pre = (tool, input) => run(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'abc', tool_name: tool, tool_input: input, tool_use_id: 't1' }), {}, { env });
  const blocked = pre('mcp__harness__compose_check', { symbol: 'MNQ' });
  assert.strictEqual(blocked.exitCode, 2);
  assert.match(blocked.stderr, /^\[desk\] .*launch risk-manager first/);
  // The role reported (another process: the log is a file).
  run(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'abc', tool_name: 'Agent', tool_input: { subagent_type: 'risk-manager' }, tool_response: 'report' }), {}, { env });
  assert.strictEqual(pre('mcp__harness__compose_check', { symbol: 'MNQ' }), '');
  // An exit is never refused; bad input is no decision.
  assert.strictEqual(pre('mcp__broker__close_position', { contractId: 'MNQ' }), '');
  assert.strictEqual(run('not json', {}, { env }), '');
});

test('toolcall hook: a repeated identical result gets the reminder as added context', () => {
  const env = { FTH_HOME: tmpDir() };
  let t = 0;
  const now = () => t;
  let out = '';
  for (let i = 0; i < 3; i += 1) {
    t += 5000;
    run(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'r', tool_name: 'mcp__harness__bar_briefing', tool_input: { symbol: 'MNQ' }, tool_use_id: `c${i}` }), {}, { env, now });
    out = run(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'r', tool_name: 'mcp__harness__bar_briefing', tool_input: { symbol: 'MNQ' }, tool_use_id: `c${i}`, tool_response: 'same' }), {}, { env, now });
  }
  const ctx = JSON.parse(out).hookSpecificOutput;
  assert.strictEqual(ctx.hookEventName, 'PostToolUse');
  assert.match(ctx.additionalContext, /^\[repeat\] You are repeating/);
});
