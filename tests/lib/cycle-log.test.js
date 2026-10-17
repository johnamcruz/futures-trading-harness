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
  const all = summarize(claudeStream(['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan']));
  assert.deepStrictEqual(all.skills, ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan']);
  assert.strictEqual(all.tools.mcp__broker__place_order, 2);
  assert.match(all.commands[0], /strategies\.js scan/);
  assert.strictEqual(all.orders.length, 2);
  assert.deepStrictEqual(all.missingSkills, []);
  assert.deepStrictEqual(summarize(claudeStream(['trade-session'])).missingSkills, ['multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan']);
  // The skills read before an entry (REQUIRED_AT_ENTRY) are named too; a skill_lookup of one counts (its "skill" argument).
  const perCycle = ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks'];
  assert.deepStrictEqual(summarize(claudeStream(perCycle)).missingSkills, ['setup-judgment', 'trade-plan']);
  assert.deepStrictEqual(summarize(`${claudeStream([...perCycle, 'setup-judgment'])}\n{"skill": "trade-plan"}`).missingSkills, []);
  // opencode's head trader in index mode: the skills the runner attested embedded in its prompt are not missing.
  const embedded = summarize(claudeStream([]), [...perCycle, 'setup-judgment']);
  assert.deepStrictEqual([embedded.missingSkills, embedded.embeddedSkills], [['trade-plan'], [...perCycle, 'setup-judgment']]);
  assert.ok(!('embeddedSkills' in summarize(claudeStream([]))));
  const { writeCycleLog } = require('../../scripts/lib/cycle-log');
  const att = JSON.stringify({ config: '/w/opencode.json', sha256: '0'.repeat(64), skills: [...perCycle, 'setup-judgment', 'trade-plan'] });
  assert.deepStrictEqual(writeCycleLog(require('../helpers').tmpDir(), { action: 'trade', harness: 'opencode', prompt: 'p', output: claudeStream([]), headPrompt: att }).summary.missingSkills, []);
  assert.deepStrictEqual(writeCycleLog(require('../helpers').tmpDir(), { action: 'trade', harness: 'opencode', prompt: 'p', output: claudeStream([]), headPrompt: '{bad' }).summary.missingSkills.length, 7);
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
  // Recorded before strategy-library was split: its loads (Qwen's skill tool) count, and the two new pieces are missing.
  assert.deepStrictEqual(s.missingSkills, ['strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan']);
  // The bridged call's own arguments, not the wrapper's.
  const scan = toolCalls(QWEN_CYCLE).find(c => c.name === 'mcp__harness__strategies_scan');
  assert.deepStrictEqual(Object.keys(scan.input).sort(), ['bars', 'symbol']);
  // Without its skills, a bridged entry is an entry without them.
  const noSkills = QWEN_CYCLE.replace(/"name":"skill"/g, '"name":"noop"').replace(/"skill":"futures-trading-harness:[a-z-]+"/g, '"x":"y"');
  assert.deepStrictEqual(summarize(noSkills).missingSkills, ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan']);
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
  assert.deepStrictEqual(summarize(sneaky).missingSkills, ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan'], 'the entries still raise the missing-skills alarm');
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
  assert.strictEqual(line.cycleAt, at.toISOString(), 'no cycle env: the cycle\'s time is `at`');
});

test('writeCycleLog: a replayed cycle is filed and judged at the replay clock\'s time, its `at` the wall clock; a time run again keeps both records', () => {
  const { cycleClock } = require('../../scripts/lib/cycle-log');
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'rp', brokers: { rp: { command: ['node', path.join(home, 'replay-server.js')], replay: true } } }));
  const env = { HOME: home, FTH_HOME: home, FTH_REPLAY_NOW: '2026-04-28T04:12:02Z' };
  const wall = new Date('2026-10-07T14:03:05Z');
  const write = e => writeCycleLog(home, { at: wall, env: e, action: 'trade', harness: 'opencode', prompt: 'P', output: '', result: 'CYCLE RESULT: no-trade', ok: true });
  const { file } = write(env);
  assert.strictEqual(path.relative(home, file), path.join('logs', 'cycles', '2026-04-28', '041202-trade.json'));
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual([rec.at, rec.cycleAt], [wall.toISOString(), '2026-04-28T04:12:02.000Z']);
  assert.strictEqual(path.basename(write(env).file), '041202-trade-2.json', 'the earlier record is kept');
  // A name another writer took (created exclusively, never overwritten): the next free one.
  fs.writeFileSync(path.join(path.dirname(file), '041202-trade-3.json'), 'theirs');
  assert.strictEqual(path.basename(write(env).file), '041202-trade-4.json');
  assert.strictEqual(fs.readFileSync(path.join(path.dirname(file), '041202-trade-3.json'), 'utf8'), 'theirs');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).cycleAt, '2026-04-28T04:12:02.000Z', 'the first record intact');
  const lines = fs.readFileSync(path.join(home, 'logs', 'cycles-2026-04-28.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(lines.map(l => [l.at, l.cycleAt]), Array(3).fill([wall.toISOString(), '2026-04-28T04:12:02.000Z']));
  assert.deepStrictEqual([cycleClock(env, wall).cycleAt.toISOString(), cycleClock(env, wall).replay], ['2026-04-28T04:12:02.000Z', true]);
  // A live broker: the replay clock is refused (the gate refuses entries), the record keeps the wall clock.
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'lv', brokers: { lv: { command: ['node', path.join(home, 'live-server.js')] } } }));
  assert.deepStrictEqual([cycleClock(env, wall).cycleAt, cycleClock(env, wall).replay], [wall, false]);
  assert.strictEqual(cycleClock({ HOME: home, FTH_HOME: home }, wall).cycleAt, wall, 'live: the wall clock');
  // The cycle's lanes, read as the gate reads FTH_CYCLE_LANE_BARS: unset {}, a lane by family root, unreadable null.
  assert.deepStrictEqual(cycleClock({}, wall).laneBars, {});
  assert.deepStrictEqual(cycleClock({ FTH_CYCLE_LANE_BARS: '{"MNQ":{"1":"2026-04-28T04:11:00Z"}}' }, wall).laneBars, { MNQ: { 1: '2026-04-28T04:11:00Z' } });
  assert.strictEqual(cycleClock({ FTH_CYCLE_LANE_BARS: '{bad' }, wall).laneBars, null);
  assert.deepStrictEqual(cycleClock(null, wall), { cycleAt: wall, laneBars: {}, replay: false, charged: false });
  // The replay broker again, the replay clock running from the step's wall start (the latency charged): the cycle's
  // time is the replay time at its own wall start, never the time the record is written at.
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'rp', brokers: { rp: { command: ['node', path.join(home, 'replay-server.js')], replay: true } } }));
  const startMs = Date.now() - 600000;
  const running = { ...env, FTH_REPLAY_WALL_START: String(startMs) };
  const c = cycleClock(running, new Date(startMs + 90000));
  assert.deepStrictEqual([c.cycleAt.toISOString(), c.replay, c.charged], ['2026-04-28T04:13:32.000Z', true, true]);
  assert.strictEqual(cycleClock(running, new Date(0), startMs + 30000).cycleAt.toISOString(), '2026-04-28T04:12:32.000Z', 'the wall start given');
  assert.deepStrictEqual([cycleClock(env, new Date(startMs + 90000)).cycleAt.toISOString(), cycleClock(env, wall).charged], ['2026-04-28T04:12:02.000Z', false], 'pinned: the decision time');
});

test('cycleLookups: the lanes reach the briefing\'s facts as the gate\'s (unreadable lanes: every situational lookup required)', () => {
  const { cycleLookups } = require('../../scripts/lib/cycle-log');
  const L = require('../../scripts/lib/trading/skill-lookups');
  const seen = [];
  const orig = L.briefingFacts;
  L.briefingFacts = (...a) => { seen.push(a.slice(1)); return orig(...a); };
  try {
    const home = tmpDir();
    const at = new Date('2026-04-28T04:12:02Z');
    cycleLookups({ home, output: '', transcript: path.join(home, 't.jsonl'), context: { symbols: [{ symbol: 'MNQ' }] }, roleSkills: 'index', at, laneBars: null });
    assert.deepStrictEqual(seen, [['MNQ', at, null]]);
  } finally {
    L.briefingFacts = orig;
  }
});

test('cycleLookups: the runner\'s role record joins the transcript\'s calls (a desk role run by the runner is counted)', () => {
  const { cycleLookups } = require('../../scripts/lib/cycle-log');
  const L = require('../../scripts/lib/trading/skill-lookups');
  const RR = require('../../scripts/lib/trading/runner-roles');
  const home = tmpDir();
  const rolesFile = path.join(home, 'logs', 'cycle-roles-1-ab.jsonl');
  RR.appendRoleRun(rolesFile, { role: 'market-structure-analyst', start: 1.7e12, end: 1.7e12 + 1000, text: '## s\nData: bar_briefing m3@x', lookups: ['breakout'], ok: true });
  const seen = [];
  const orig = L.lookupStats;
  L.lookupStats = a => { seen.push(a.calls); return orig(a); };
  try {
    cycleLookups({ home, output: '', transcript: path.join(home, 't.jsonl'), context: { symbols: [{ symbol: 'MNQ' }], rolesFile }, roleSkills: 'index', at: new Date('2026-04-28T04:12:02Z') });
  } finally {
    L.lookupStats = orig;
  }
  assert.deepStrictEqual(seen[0].map(c => [c.role, c.source]), [['market-structure-analyst', 'runner']]);
});

test('writeCycleLog: the orders the gateway judged in the cycle\'s window are among its orders (an opencode trade-executor\'s are in no main transcript), each once', () => {
  const home = tmpDir();
  const gateLog = path.join(home, 'gate.jsonl');
  const env = { FTH_HOME: home, FTH_GATE_LOG: gateLog, FTH_CYCLE_TRANSCRIPT: path.join(home, 'cycle-transcript-1.jsonl') };
  const { cycleId } = require('../../scripts/lib/trading/check-order');
  const cycle = cycleId(env);
  const at = new Date('2026-10-07T14:03:05Z');
  const ts = s => new Date(at.getTime() + s * 1000).toISOString();
  const g = (s, x) => JSON.stringify({ ts: ts(s), source: 'gateway', tool: 'place_order', decision: 'allowed', violations: [], contractId: 'MNQ', side: 0, size: 1, type: 2, cycle, ...x });
  fs.writeFileSync(gateLog, [
    '{"partial": tr', // a torn line: skipped
    g(-5, { rationale: 'setup:orb long, an earlier cycle\'s' }),
    g(10, { rationale: 'setup:orb long, stop 21480' }), // the transcript's own call (claudeStream): counted once
    g(20, { rationale: 'setup:vwap long' }),
    JSON.stringify({ ts: ts(21), source: 'hook', decision: 'blocked', violations: [], contractId: 'MNQ', rationale: 'setup:vwap long' }), // the hook's: not the gateway's
    g(30, { tool: 'modify_order', rationale: '[protect] stop' }), // not an entry call
    g(40, { side: 1, size: 3, type: 1, rationale: 'setup:orb short' }), // allowed, then refused by the order tracker: one order, refused
    g(40.5, { decision: 'blocked', side: 1, size: 3, type: 1, rationale: 'setup:orb short', violations: [{ check: 'x', message: 'The gateway could not record the order before sending it' }] }),
    g(70, { rationale: 'setup:orb long, after the cycle' }),
    // Another cycle's (another home or account sharing the log), and a record with no cycle (an interactive session):
    // in the window, never this cycle's.
    g(25, { rationale: 'setup:orb long, another runner', cycle: cycleId({ FTH_CYCLE_TRANSCRIPT: path.join(home, 'cycle-transcript-2.jsonl') }) }),
    g(26, { rationale: 'setup:orb long, a session', cycle: undefined }),
  ].join('\n') + '\n');
  const { summary } = writeCycleLog(home, { at, env, action: 'trade', harness: 'opencode', prompt: 'P', output: claudeStream(['trade-session']), ok: true, durationMs: 45000 });
  assert.deepStrictEqual(summary.orders.map(o => [o.rationale, o.gate || null, o.via || null]), [
    ['setup:orb long, stop 21480', null, null],
    ['[protect] stop', null, null],
    ['setup:vwap long', 'allowed', 'gate-log'],
    ['setup:orb short', 'blocked', 'gate-log'],
  ]);
  assert.deepStrictEqual(summary.orders[2], { contractId: 'MNQ', side: 0, size: 1, type: 2, rationale: 'setup:vwap long', gate: 'allowed', via: 'gate-log' });
  // No cycle env (a caller that gives none), or no gate log: the transcript's orders alone.
  assert.strictEqual(writeCycleLog(home, { at, action: 'trade', harness: 'opencode', prompt: 'P', output: claudeStream([]), durationMs: 45000 }).summary.orders.length, 2);
  assert.strictEqual(writeCycleLog(home, { at, env: { ...env, FTH_GATE_LOG: path.join(home, 'none.jsonl') }, action: 'trade', harness: 'opencode', prompt: 'P', output: claudeStream([]), durationMs: 45000 }).summary.orders.length, 2);
  // A cycle env with no runner cycle (no FTH_CYCLE_TRANSCRIPT): no id, nothing merged.
  assert.strictEqual(writeCycleLog(home, { at, env: { FTH_HOME: home, FTH_GATE_LOG: gateLog }, action: 'trade', harness: 'opencode', prompt: 'P', output: claudeStream([]), durationMs: 45000 }).summary.orders.length, 2);
  // The id: a hash of the run's own transcript file, stable, never the path itself; none outside a runner cycle.
  assert.match(cycle, /^[0-9a-f]{16}$/);
  assert.strictEqual(cycleId({ FTH_CYCLE_TRANSCRIPT: '  ' }), null);
  // An entry the gate log alone shows still raises the missing-skills alarm.
  assert.ok(writeCycleLog(home, { at, env, action: 'trade', harness: 'opencode', prompt: 'P', output: use('mcp__harness__bar_briefing', {}), durationMs: 45000 }).summary.missingSkills.length > 0);
});

test('skills-loaded: names, transcript files (a subagent reads its session too), and the check', () => {
  assert.strictEqual(skillName('futures-trading-harness:trade-session'), 'trade-session');
  assert.strictEqual(skillName('/strategy-library'), 'strategy-library');
  assert.deepStrictEqual(transcriptFiles('/p/abc/subagents/agent-1.jsonl'), ['/p/abc/subagents/agent-1.jsonl', '/p/abc.jsonl']);
  const dir = tmpDir();
  const main = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(main, claudeStream(['trade-session', 'multi-timeframe-analysis', 'strategy-scan', 'strategy-gate-checks']) + '\n' + JSON.stringify({ type: 'user', message: { content: '<command-name>/strategy-library</command-name>' } }));
  assert.deepStrictEqual([...skillsInTranscript(fs.readFileSync(main, 'utf8'))].sort(), ['multi-timeframe-analysis', 'strategy-gate-checks', 'strategy-library', 'strategy-scan', 'trade-session']);
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
  assert.deepStrictEqual(s.missingSkills, ['strategy-library', 'strategy-scan', 'strategy-gate-checks', 'setup-judgment', 'trade-plan']);
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
  // A call still in flight when the turn ended (only started) still counts, once.
  const inFlight = [ev('item.started', { status: 'in_progress' }), ev('item.updated', { status: 'in_progress' })].join('\n');
  assert.deepStrictEqual(toolCalls(inFlight).map(c => [c.name, Boolean(c.failed)]), [['mcp__broker__place_order', false]]);
  assert.strictEqual(summarize(inFlight).orders.length, 1);
  // Without an id, only the completed form counts.
  const noId = (type, status) => JSON.stringify({ type, item: { type: 'mcp_tool_call', server: 'broker', tool: 'get_bars', arguments: {}, status } });
  assert.strictEqual(toolCalls([noId('item.started', 'in_progress'), noId('item.completed', 'completed')].join('\n')).length, 1);
  // The error text: a refusal returned as the result's content; an error object without a message.
  assert.strictEqual(toolCalls(ev('item.completed', { status: 'failed', result: { content: [{ type: 'text', text: 'Blocked by trading harness' }] } }))[0].error, 'Blocked by trading harness');
  assert.strictEqual(toolCalls(ev('item.completed', { status: 'failed', error: { code: 7 } }))[0].error, '{"code":7}');
  // opencode: a call the user rejected when asked never reached a tool either.
  const rejected = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'broker_place_order', state: { status: 'error', input: {}, error: 'The user rejected permission to use this specific tool call.' } } });
  assert.strictEqual(toolCalls(rejected)[0].stopped, true);
});

test('toolCalls: Codex items with no event type count; an opencode call that errored keeps its error text', () => {
  const item = { type: 'mcp_tool_call', server: 'broker', tool: 'place_order', arguments: { size: 1 }, status: 'completed' };
  assert.deepStrictEqual(toolCalls(JSON.stringify({ item })).map(c => c.name), ['mcp__broker__place_order'], 'no id, no type');
  assert.deepStrictEqual(toolCalls(JSON.stringify({ item: { ...item, id: 'x' } })).map(c => c.name), ['mcp__broker__place_order'], 'an id, no type');
  const oc = JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool: 'broker_close_position', state: { status: 'error', input: {}, error: 'PositionNotFound: no open position' } } });
  assert.deepStrictEqual(toolCalls(oc).map(c => [c.name, c.failed, c.error]), [['mcp__broker__close_position', true, 'PositionNotFound: no open position']]);
});

test('writeCycleLog: every phase-2 report\'s FACTS checked against the cycle bar\'s briefing, in the record and the line (fact-claims.js)', () => {
  const home = tmpDir();
  const BAR = '2026-10-07T13:57:00.000Z';
  require('../../scripts/lib/trading/briefing').writeBriefing(home, { symbol: 'MNQ', minutes: 3, asOf: BAR, closedAt: '2026-10-07T14:00:00.000Z', sections: {
    m3: { version: 'a', validUntil: '2026-10-07T14:03:00.000Z', data: { window: 'opening drive', windowEntries: 'allowed' } },
  } });
  const ev = (id, text) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Task', input: { subagent_type: 'risk-manager', prompt: 'p' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }),
  ];
  const output = [...ev('p1', 'Risk state: ok'), ...ev('p2', 'VERDICT: VETO - opening print, no entries\nFACTS: window opening print; entries none; momentum weak')].join('\n');
  const at = new Date('2026-10-07T14:03:05Z');
  const { file } = writeCycleLog(home, { at, action: 'trade', harness: 'claude', prompt: 'P', context: { symbols: [{ symbol: 'MNQ', bar: { t: BAR } }] }, output, result: 'CYCLE RESULT: no-trade - vetoed', ok: true });
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(rec.factCheck.counts, { reports: 1, claims: 3, true: 0, false: 2, unchecked: 1 });
  assert.deepStrictEqual(rec.factCheck.reports[0].claims.map(c => [c.text, c.check]), [['window opening print', false], ['entries none', false], ['momentum weak', 'unchecked']]);
  const line = JSON.parse(fs.readFileSync(path.join(home, 'logs', 'cycles-2026-10-07.jsonl'), 'utf8').trim());
  assert.deepStrictEqual(line.factCheck, rec.factCheck.counts);
  // No phase-2 report: the record says so, the line carries nothing.
  const quiet = writeCycleLog(home, { at: new Date('2026-10-07T14:06:05Z'), action: 'trade', harness: 'claude', prompt: 'P', output: 'x', result: 'r', ok: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(quiet.file, 'utf8')).factCheck.counts.reports, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'logs', 'cycles-2026-10-07.jsonl'), 'utf8').trim().split('\n')[1]).factCheck, undefined);
});
