'use strict';

// The fake Claude Code CLI (tests/fixtures/fake-claude-sessions.js) models the real one where the gate reads it
// (BRIEF-PR-B2 lesson 2; docs/PREPARE-AHEAD.md "Process model"): the session file's lines are the CLI's own shape (each
// event at the top level with its uuid, parentUuid and sessionId, as Claude Code's session JSONL is), written as the run
// goes; a fork copies the history with the original uuids and its own sessionId on every line; the stream's session id
// is the session's; PreToolUse hooks fire on every call (allowed or not) before the permission check, and a hook's
// refusal blocks the call (a tool_use answered by an error tool_result, never the tool); dontAsk's refusal is a
// tool_use answered by the CLI's denial text.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeClaude } = require('../fixtures/fake-claude-sessions');
const { roleCalls } = require('../../scripts/lib/trading/roles-ran');
const { skillsInTranscript } = require('../../scripts/lib/trading/skills-loaded');
const { claudeStreamSession, claudeSessionOfPath } = require('../../scripts/lib/head-prompt');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-fake-claude-'));
const lines = f => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const argv = (prompt, extra = []) => ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--allowedTools', 'Skill,Agent,mcp__harness__skill_lookup', ...extra];
const NO_HOOKS = () => ({ code: 0, stderr: '' });

test('fake CLI: the session file is the CLI\'s shape (each event top-level with uuid, parentUuid, sessionId); the stream names the session', async () => {
  const dir = tmp();
  const live = path.join(dir, 'stream.jsonl');
  let streamed = '';
  const run = fakeClaude({ dir: path.join(dir, 's'), preHooks: NO_HOOKS, script: () => [{ load: 'candle-reading' }, { result: 'done' }] });
  // The live writer's file is removed by the scripted model at its end: watch it through the stream instead.
  const res = await run(argv('go'), { env: {}, liveFile: live, stream: l => { streamed += l; } });
  const id = run.calls[0].session;
  const file = run.file(id);
  const ls = lines(file);
  assert.ok(ls.length >= 3);
  for (const l of ls) {
    assert.strictEqual(l.sessionId, id);
    assert.match(l.uuid, /^[0-9a-f-]{36}$/);
    assert.ok(!('event' in l), 'not nested: the event is the line');
    assert.ok(typeof l.type === 'string');
  }
  assert.strictEqual(ls[0].parentUuid, null);
  for (let i = 1; i < ls.length; i += 1) assert.strictEqual(ls[i].parentUuid, ls[i - 1].uuid);
  // The gate's parsers read it as they read a real session file.
  assert.deepStrictEqual([...skillsInTranscript(fs.readFileSync(file, 'utf8'))], ['candle-reading']);
  // The stream's init event names the session (claudeAttested matches it against the hook's transcript path).
  const tmpStream = path.join(dir, 'copy.jsonl');
  fs.writeFileSync(tmpStream, res.output);
  assert.strictEqual(claudeStreamSession(tmpStream), id);
  assert.strictEqual(claudeSessionOfPath(file), id);
  assert.ok(streamed.includes(`"session_id":"${id}"`));
});

test('fake CLI: a fork copies the history with its original uuids, its own sessionId on every line, then its own lines chained to the last copied one; the gate reads the history in the fork', async () => {
  const dir = tmp();
  const run = fakeClaude({ dir: path.join(dir, 's'), preHooks: NO_HOOKS, script: (_p, _e, { resumed }) => (resumed ? [{ result: 'confirmed' }] : [{ role: 'risk-manager', report: 'VERDICT: APPROVE - size 3' }, { result: 'planned' }]) });
  await run(argv('prepare'), { env: {} });
  const orig = run.calls[0].session;
  const before = lines(run.file(orig));
  await run(argv('confirm', ['--resume', orig, '--fork-session']), { env: {} });
  const fork = run.calls[1].session;
  assert.notStrictEqual(fork, orig);
  assert.strictEqual(run.calls[1].source, 'fork');
  const after = lines(run.file(fork));
  assert.deepStrictEqual(after.slice(0, before.length).map(l => l.uuid), before.map(l => l.uuid), 'the original uuids');
  assert.ok(after.every(l => l.sessionId === fork), 'the fork\'s sessionId on every line, copied ones too');
  const own = after.slice(before.length);
  assert.ok(own.length > 0 && own.every(l => !before.some(b => b.uuid === l.uuid)));
  assert.strictEqual(own[0].parentUuid, before.at(-1).uuid);
  // The prepare's role call is in the fork's file, where the gate's roles-ran parser finds it (the attribution problem).
  assert.deepStrictEqual(roleCalls(fs.readFileSync(run.file(fork), 'utf8')).calls.map(c => c.role), ['risk-manager']);
  // The original is untouched.
  assert.deepStrictEqual(lines(run.file(orig)), before);
});

test('fake CLI: PreToolUse hooks fire on an allowed call too, with the session file as it stands (history and the run so far); a hook\'s refusal blocks the call', async () => {
  const dir = tmp();
  const seen = [];
  const preHooks = (name, input, payload) => {
    seen.push({ name, input, transcript: fs.readFileSync(payload.transcript_path, 'utf8') });
    return name === 'Agent' ? { code: 2, stderr: '[test] refused by the hook' } : { code: 0, stderr: '' };
  };
  const run = fakeClaude({ dir: path.join(dir, 's'), preHooks, script: () => [{ load: 'breakout' }, { role: 'risk-manager', report: 'VERDICT: APPROVE - size 3' }, { lookup: 'candle-reading' }, { result: 'done' }] });
  await run(argv('go'), { env: {} });
  assert.deepStrictEqual(seen.map(s => s.name), ['Skill', 'Agent', 'mcp__harness__skill_lookup']);
  // The hook on the second call sees the first call's lines (the file is written as the run goes).
  assert.match(seen[1].transcript, /"name":"Skill"/);
  const text = fs.readFileSync(run.file(run.calls[0].session), 'utf8');
  // The blocked Agent call: a tool_use answered by an error tool_result with the hook's reason; never a report.
  assert.match(text, /\[test\] refused by the hook/);
  assert.deepStrictEqual(roleCalls(text).calls, []);
});

test('fake CLI: dontAsk\'s refusal of a call not allowed is a tool_use answered by the CLI\'s denial (an error), after the hooks ran, and in the result\'s permission_denials', async () => {
  const dir = tmp();
  const seen = [];
  const run = fakeClaude({ dir: path.join(dir, 's'), preHooks: name => { seen.push(name); return { code: 0, stderr: '' }; }, script: () => [{ harness: 'compose_check', args: { symbol: 'MNQ' } }, { result: 'done' }] });
  const res = await run(argv('go'), { env: {} });
  assert.deepStrictEqual(seen, ['mcp__harness__compose_check'], 'the hook ran before the denial');
  assert.deepStrictEqual(run.calls[0].refused, ['mcp__harness__compose_check']);
  const text = fs.readFileSync(run.file(run.calls[0].session), 'utf8');
  assert.match(text, /Permission to use mcp__harness__compose_check has been denied because Claude Code is running in don't ask mode/);
  assert.match(text, /"is_error":true/);
  assert.match(res.output, /"permission_denials":\[\{"tool_name":"mcp__harness__compose_check"/);
});
