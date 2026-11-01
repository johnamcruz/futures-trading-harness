'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { cycleOutcome, validateConfig, buildCommand, decide, recordRun, prompts, cycleResult, parseAt, childEnv, claudeTools, claudeDenied, claudeOrderToolConflicts, signalDecision } = require('../../scripts/lib/autotrader');
const { FAKE_BROKERS, shippedBroker, tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = validateConfig({ harness: 'qwen', sessions: ['09:35-15:00@America/New_York'], premarketAt: '09:00@America/New_York' });
const et = (h, m, day = 7) => new Date(Date.UTC(2026, 9, day, h + 4, m)); // October: ET = UTC-4; 7th is a Wednesday

test('config defaults validate and bad configs list every problem', () => {
  assert.strictEqual(cfg.symbols[0], 'MNQ');
  assert.throws(() => validateConfig({ harness: 'gpt', symbols: [], sessions: ['bad'], eodAt: '25:00@UTC', timeframe: 0 }),
    /harness[\s\S]*symbols[\s\S]*sessions[\s\S]*eodAt[\s\S]*timeframe/);
  assert.throws(() => validateConfig({ trigger: 'signal' }), /account: required/);
  assert.throws(() => validateConfig({ cycleMinutes: 3 }), /replaced by timeframe/);
  assert.throws(() => validateConfig({ timeframe: 90 }), /1 to 60/);
  assert.strictEqual(validateConfig({ timeframe: 1 }).timeframe, 1);
  assert.throws(() => validateConfig({ harness: 'custom', command: ['agent'] }), /\{prompt\}/);
  assert.deepStrictEqual(parseAt('09:05@America/New_York'), { minute: 545, timeZone: 'America/New_York' });
  assert.strictEqual(parseAt('9am'), null);
});

test('commands for each harness put the prompt where the CLI expects it', () => {
  const p = 'PROMPT';
  const claude = buildCommand(validateConfig({ harness: 'claude', model: 'sonnet' }), p, '/fth');
  assert.deepStrictEqual(claude.slice(0, 5), ['claude', '-p', 'PROMPT', '--plugin-dir', '/fth']);
  assert.ok(claude.includes('dontAsk') && claude.includes('--model'));
  const tools = claude[claude.indexOf('--allowedTools') + 1].split(',');
  assert.ok(tools.includes('mcp__broker'));
  assert.ok(tools.includes('Bash(node /fth/scripts/strategies.js:*)'));
  assert.ok(!tools.some(t => t === 'Write' || t === 'Bash' || /^Bash\(node:/.test(t)), 'no general write or shell access');
  assert.deepStrictEqual(claudeTools('/r').filter(t => /^(Write|Edit)|mkdir/.test(t)), [], 'no write rule: bars_fetch writes the scratch files');
  // The home's own bars scratch directory is readable (where bars_fetch writes); the shared /tmp/fth is not.
  assert.ok(claudeTools('/r', { home: '/h' }).includes('Read(//h/.futures-trading-harness/bars-scratch/**)'));
  assert.ok(claudeTools('/r', { home: '/h', stateDir: '/srv/run' }).includes('Read(//srv/run/bars-scratch/**)'));
  assert.ok(!claudeTools('/r', { home: '/h' }).some(t => t.includes('/tmp/fth')));
  assert.ok(!tools.includes('Read') && !tools.includes('WebFetch'), 'reads and fetches are scoped');
  assert.ok(tools.includes('Read(//fth/**)') && tools.includes('WebFetch(domain:bls.gov)'));
  const denied = claude[claude.indexOf('--disallowedTools') + 1].split(',');
  assert.ok(denied.includes('Read(//proc/**)') && denied.includes('Write(//fth/**)'));
  // No cross-session tools: the head trader reaches no other session on the machine; it keeps Agent (its desk fallback).
  assert.ok(denied.includes('SendMessage') && denied.includes('ListAgents'), 'the head trader messages no other session');
  assert.ok(tools.includes('Agent') && !denied.includes('Agent'), 'the head trader keeps Agent');
  assert.ok(claudeDenied('/r', { home: '/h' }).includes('Edit(//h/.futures-trading-harness/**)'));
  // The skills' scripts (multi-timeframe read, prop status) and the runner's logs are allowed; credentials are not.
  assert.ok(tools.includes('Bash(node /fth/scripts/mtf.js:*)') && tools.includes('Bash(node /fth/scripts/combine.js status:*)'));
  assert.ok(claudeTools('/r', { home: '/h' }).includes('Read(//h/.futures-trading-harness/logs/**)'));
  assert.ok(claudeTools('/r', { home: '/h', stateDir: '/srv/fth' }).includes('Read(//srv/fth/logs/**)'));
  assert.ok(claudeDenied('/r', { home: '/h', stateDir: '/srv/fth' }).includes('Read(//srv/fth/.env)'));
  assert.ok(claudeDenied('/r', { home: '/h' }).includes('Read(//h/.futures-trading-harness/.env)'));
  // The broker server's journal folder can't be edited (the order gate reads the journal).
  assert.ok(claudeDenied('/r', { home: '/h', journal: '/h/.broker-mcp/journal.jsonl' }).includes('Edit(//h/.broker-mcp/journal.jsonl)'));
  assert.ok(claudeTools('/r', { home: '/h' }).includes('mcp__broker'));
  // The harness tools server, all its tools (none places an order).
  assert.ok(tools.includes('mcp__harness') && claudeTools('/r', { home: '/h' }).includes('mcp__harness'));
  const codex = buildCommand(validateConfig({ harness: 'codex' }), p, '/fth');
  assert.deepStrictEqual([codex[0], codex[1], codex[codex.length - 1]], ['codex', 'exec', 'PROMPT']);
  const qwen = buildCommand(cfg, p, '/fth');
  assert.deepStrictEqual(qwen.slice(0, 3), ['qwen', '-p', 'PROMPT']);
  assert.strictEqual(qwen[qwen.indexOf('--approval-mode') + 1], 'default');
  const custom = buildCommand(validateConfig({ harness: 'custom', command: ['my-agent', '--task', '{prompt}'] }), p, '/fth');
  assert.deepStrictEqual(custom, ['my-agent', '--task', 'PROMPT']);
});

test('one role\'s own run (buildCommand `agent`): Claude Code and opencode run it; its tools are its own, never wider than the head trader\'s; any other harness, or a role the runner never runs alone, throws', () => {
  const { claudeRoleTools, claudeRoleDenied, runnerRole, ROLE_RUNS } = require('../../scripts/lib/autotrader');
  assert.deepStrictEqual([...ROLE_RUNS].sort(), ['claude', 'opencode']);
  const claude = validateConfig({ harness: 'claude' });
  const replay = { FTH_REPLAY_NOW: '2026-04-28T14:00:00.000Z', HOME: '/h' };
  for (const role of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager', 'trade-executor']) {
    const argv = buildCommand(claude, 'REQ', '/fth', replay, { agent: role });
    const flag = f => argv[argv.indexOf(f) + 1];
    assert.deepStrictEqual(argv.slice(0, 7), ['claude', '-p', 'REQ', '--plugin-dir', '/fth', '--agent', `futures-trading-harness:${role}`], role);
    const allowed = flag('--allowedTools').split(',');
    const denied = flag('--disallowedTools').split(',');
    const head = claudeTools('/fth', { replay: true });
    const own = runnerRole(role).tools;
    // Every allowed rule is the role's own tool, or a head trader's scoped read when the role reads.
    for (const t of allowed) assert.ok(own.includes(t) || (own.includes('Read') && t.startsWith('Read(') && head.includes(t)), `${role}: ${t}`);
    assert.ok(!allowed.some(t => t === 'Agent' || t === 'mcp__broker' || t === 'mcp__harness' || t === 'WebSearch' || /^(Bash|Write|Edit)/.test(t)), role);
    assert.ok(denied.includes('Agent') && denied.includes('WebSearch'), `${role}: no role launches a role; a replay has no web`);
    assert.ok(denied.includes('SendMessage') && denied.includes('ListAgents'), `${role}: no role messages another session`);
    const orders = ['place_order', 'modify_order', 'cancel_order', 'close_position', 'partial_close_position'].map(t => `mcp__broker__${t}`);
    if (role === 'trade-executor') assert.ok(orders.every(t => allowed.includes(t) && !denied.includes(t)), 'only the trade-executor holds the order tools');
    else assert.ok(orders.every(t => denied.includes(t) && !allowed.includes(t)), `${role} holds no order tool`);
    // A replay: only the harness's own MCP servers.
    assert.ok(argv.includes('--strict-mcp-config') && argv.includes('--mcp-config'), role);
  }
  // The head trader's run names no agent.
  assert.ok(!buildCommand(claude, 'P', '/fth').includes('--agent'));
  // A role tool the head trader doesn't hold (a shell, edits) is never allowed; WebFetch stays the calendar sites.
  assert.deepStrictEqual(claudeRoleTools('/r', { tools: ['Bash', 'Edit', 'Write', 'Glob', 'WebFetch', 'mcp__other__x'] }, { home: '/h' }), claudeTools('/r', { home: '/h' }).filter(t => t.startsWith('WebFetch(')));
  assert.deepStrictEqual(claudeRoleDenied({ tools: ['mcp__broker__place_order'] }).filter(t => /place_order/.test(t)), []);
  assert.throws(() => buildCommand(claude, 'P', '/fth', {}, { agent: 'strategy-researcher' }), /not a role the runner runs on its own/);
  for (const harness of ['codex', 'qwen', 'custom']) {
    const c = validateConfig({ harness, ...(harness === 'custom' ? { command: ['x', '{prompt}'] } : {}) });
    assert.throws(() => buildCommand(c, 'P', '/fth', {}, { agent: 'risk-manager' }), /runs no role on its own/, harness);
  }
  const oc = buildCommand(validateConfig({ harness: 'opencode' }), 'REQ', '/fth', {}, { agent: 'risk-manager' });
  assert.strictEqual(oc[oc.indexOf('--agent') + 1], 'risk-manager');
});

test('prompts name the skill, symbol, account, and paper mode', () => {
  const p = prompts(validateConfig({ account: '123', paper: true }), et(10, 0));
  assert.match(p.trade('MNQ'), /autonomous-trading skill[\s\S]*trade-session skill for MNQ on account 123 in paper mode/);
  assert.match(p.premarket('MES'), /premarket skill for MES/);
  assert.match(p.eod(), /end-of-day skill on account 123 for the trading day ending \d{4}-\d\d-\d\d, on \d+-minute bars \(the reconcile tool with day \d{4}-\d\d-\d\d and timeframe \d+\): flatten/);
});

test('stable prompt prefix: every cycle\'s prompt starts with the same head, the time after it, so consecutive prompts share it (a local model server\'s prompt cache)', () => {
  const { stableHead } = require('../../scripts/lib/autotrader');
  const common = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n += 1; return n; };
  const c = validateConfig({ account: '123' });
  const head = stableHead('/fth');
  assert.match(head, /^Autonomous cycle\. Follow the autonomous-trading skill\. No user is present\. Harness root \(FTH_ROOT\): \/fth;/);
  // Nothing that changes between cycles in it: no time, no date, no account, no symbol.
  assert.doesNotMatch(head, /\d\d:\d\d|\d{4}-\d\d-\d\d|123|MNQ/);
  const bar = (t, close) => [{ symbol: 'MNQ', bar: { t, c: close, file: '/b/MNQ-3m.json', contractId: 'MNQ', recent: [{ t, o: close - 1, h: close + 1, l: close - 2, c: close, v: 100 }] } }];
  const state = (balance, at) => ({ id: '123', at, balance, positions: [], workingOrders: 0 });
  // Two consecutive trade cycles, a different bar, time and balance: they share the head and the time's leading digits.
  const p1 = prompts(c, et(10, 3), '/fth').trade(bar('2026-10-07T14:00:00Z', 21500), { state: state(50000, et(10, 3).toISOString()) });
  const p2 = prompts(c, et(10, 6), '/fth').trade(bar('2026-10-07T14:03:00Z', 21510.25), { state: state(49950, et(10, 6).toISOString()) });
  for (const p of [p1, p2]) assert.ok(p.startsWith(`${head} The cycle's time: 2026-10-07 10:0`), p.slice(0, head.length + 40));
  assert.ok(common(p1, p2) >= head.length, `${common(p1, p2)} < ${head.length}`);
  // The premarket and end-of-day prompts start with the same head.
  const p = prompts(c, et(9, 0), '/fth');
  for (const q of [p.premarket('MNQ'), p.eod()]) assert.ok(q.startsWith(`${head} The cycle's time: `));
  // The time is still stated once, New York time with UTC.
  assert.match(p1, /The cycle's time: 2026-10-07 10:03:00 ET \(2026-10-07T14:03:00\.000Z\)\./);
});

test('schedule: premarket, then trade cycles at the interval, then end of day once', () => {
  let { action, state } = decide(cfg, null, et(8, 30));
  assert.strictEqual(action, null);
  ({ action, state } = decide(cfg, state, et(9, 1)));
  assert.strictEqual(action, 'premarket');
  state = recordRun(state, 'premarket', et(9, 1));
  ({ action } = decide(cfg, state, et(9, 20)));
  assert.strictEqual(action, null); // before sessions
  ({ action, state } = decide(cfg, state, et(9, 40)));
  assert.strictEqual(action, 'trade');
  state = recordRun(state, 'trade', et(9, 40));
  assert.strictEqual(decide(cfg, state, et(9, 41)).action, 'trade'); // the bar clock times each cycle
  assert.strictEqual(decide(cfg, state, et(15, 10)).action, null); // after sessions, before eod
  ({ action, state } = decide(cfg, state, et(15, 55)));
  assert.strictEqual(action, 'eod');
  state = recordRun(state, 'eod', et(15, 55));
  assert.strictEqual(decide(cfg, state, et(16, 30)).action, null);
});

test('kill switch stops new cycles but not end of day; weekends and caps are respected', () => {
  const s = recordRun(decide(cfg, null, et(9, 1)).state, 'premarket', et(9, 1));
  assert.strictEqual(decide(cfg, s, et(10, 0), { killSwitch: true }).action, null);
  assert.strictEqual(decide(cfg, s, et(15, 55), { killSwitch: true }).action, 'eod');
  assert.strictEqual(decide(cfg, null, et(10, 0, 10)).action, null); // Saturday
  const capped = { ...s, cycles: cfg.maxCyclesPerDay };
  assert.strictEqual(decide(cfg, capped, et(10, 0)).action, 'manage'); // past the cap: manage positions only
  const yesterday = { ...capped, day: '2026-10-06', eodDone: true };
  assert.strictEqual(decide(cfg, yesterday, et(9, 1)).action, 'premarket'); // new day resets state
});

test('exits-only (a refused config file): housekeeping from the start of the day, with no cycle; end of day as usual', () => {
  const acct = { ...cfg, account: '7', paper: false };
  const s = recordRun(decide(acct, null, et(9, 1)).state, 'premarket', et(9, 1));
  assert.strictEqual(decide(acct, s, et(10, 0), { killSwitch: true }).action, null, 'the kill switch alone: nothing before the day traded');
  assert.strictEqual(decide(acct, s, et(10, 0), { killSwitch: true, exitsOnly: true }).action, 'housekeep');
  assert.strictEqual(decide(acct, s, et(15, 55), { killSwitch: true, exitsOnly: true }).action, 'eod');
  assert.strictEqual(decide({ ...acct, paper: true }, s, et(10, 0), { killSwitch: true, exitsOnly: true }).action, null, 'paper: no account to keep');
});

test('a previous day that never finished end of day is flattened first', () => {
  const thursday = { day: '2026-10-08', premarketDone: true, eodDone: false, cycles: 12, lastCycleAt: null };
  const sat = new Date(Date.UTC(2026, 9, 10, 4, 30)); // 00:30 ET Saturday
  const { action, state } = decide(cfg, thursday, sat);
  assert.strictEqual(action, 'eod');
  const done = recordRun(state, 'eod', sat);
  assert.strictEqual(decide(cfg, done, sat).action, null);
  assert.strictEqual(decide(cfg, { ...thursday, cycles: 0, premarketDone: false }, sat).action, null); // didn't trade
  // An end of day that was tried but never verified flat (no cycles, no premarket: a carried position, kill switch on) still catches up.
  assert.strictEqual(decide(cfg, { ...thursday, cycles: 0, premarketDone: false, eodAttempted: true }, sat).action, 'eod');
});

test('child env: the verdict stage (FTH_VERDICT_STAGE) only from the run\'s own context (the early phase 2\'s), never inherited by the head trader, the trade-executor or any other run', () => {
  const home = '/srv/fth';
  const stage = require('path').join(home, 'logs', 'verdict-stage-123-0123456789ab.jsonl');
  const inherited = { FTH_HOME: home, FTH_VERDICT_STAGE: stage };
  for (const harness of ['opencode', 'claude']) {
    const c = validateConfig({ harness });
    assert.strictEqual(childEnv(c, '/r', inherited).FTH_VERDICT_STAGE, undefined, `${harness}: the head trader's run`);
    assert.strictEqual(childEnv(c, '/r', inherited, { roleRun: 'trade-executor', entry: false }).FTH_VERDICT_STAGE, undefined, `${harness}: the trade-executor's`);
    assert.strictEqual(childEnv(c, '/r', inherited, { roleRun: 'risk-manager', verdictStage: '' }).FTH_VERDICT_STAGE, undefined, `${harness}: an empty one`);
    assert.strictEqual(childEnv(c, '/r', { FTH_HOME: home }, { roleRun: 'risk-manager', verdictStage: stage }).FTH_VERDICT_STAGE, stage, `${harness}: the early phase 2's own`);
  }
});

test('child env names the cycle and, for a harness that streams its transcript, the live transcript file the gate reads', () => {
  const home = { FTH_HOME: '/srv/fth' };
  for (const harness of ['opencode', 'claude']) {
    const env = childEnv(validateConfig({ harness }), '/r', home);
    assert.strictEqual(env.FTH_CYCLE, 'full', harness);
    assert.match(env.FTH_CYCLE_TRANSCRIPT, /^\/srv\/fth\/logs\/cycle-transcript-\d+-[0-9a-f]{12}\.jsonl$/, harness);
  }
  // A file per run: two runs (a loop cycle and a concurrent --once) never share one.
  assert.notStrictEqual(childEnv(validateConfig({ harness: 'opencode' }), '/r', home).FTH_CYCLE_TRANSCRIPT, childEnv(validateConfig({ harness: 'opencode' }), '/r', home).FTH_CYCLE_TRANSCRIPT);
  assert.strictEqual(childEnv(validateConfig({ cycle: 'lean' }), '/r', home).FTH_CYCLE, 'lean');
  // Qwen Code's JSON output comes at the end, not as it happens: no live file (its hook passes its own transcript), and a stale one is dropped.
  const qwen = childEnv(validateConfig({ harness: 'qwen' }), '/r', { ...home, FTH_CYCLE_TRANSCRIPT: '/old' });
  assert.strictEqual(qwen.FTH_CYCLE_TRANSCRIPT, undefined);
});

test('child env names the roles served from the report cache (FTH_CYCLE_CACHED); none: unset, a stale one dropped', () => {
  const cfg = validateConfig({ harness: 'opencode' });
  const ctx = { symbols: [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z' } }], cachedRoles: ['market-structure-analyst', 'risk-manager'] };
  assert.strictEqual(childEnv(cfg, '/r', { FTH_HOME: '/srv/fth' }, ctx).FTH_CYCLE_CACHED, 'market-structure-analyst,risk-manager');
  assert.strictEqual(childEnv(cfg, '/r', { FTH_HOME: '/srv/fth', FTH_CYCLE_CACHED: 'risk-manager' }, { ...ctx, cachedRoles: [] }).FTH_CYCLE_CACHED, undefined);
  assert.strictEqual(childEnv(cfg, '/r', { FTH_HOME: '/srv/fth', FTH_CYCLE_CACHED: 'risk-manager' }).FTH_CYCLE_CACHED, undefined, 'a manual run serves none');
});

test('a trade prompt carries the cached reports whole, launches only the other roles, and never sends a cached report back', () => {
  const now = new Date('2026-10-07T14:30:00Z');
  const items = [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 21500, file: '/b/MNQ-3m.json', contractId: 'MNQ' } }];
  const cached = { roles: ['trend-momentum-analyst', 'risk-manager'], reports: [
    { role: 'trend-momentum-analyst', text: 'Data: bar_briefing m15@x\nBias: long (high)', at: '2026-10-07T14:21:00Z', until: '2026-10-07T14:45:00.000Z' },
    { role: 'risk-manager', text: 'Phase 1: 2 trades left', at: '2026-10-07T14:21:00Z', until: null },
  ] };
  const p = prompts(validateConfig({}), now).trade(items, { cached });
  assert.match(p, /Full cycle: market-structure-analyst and volume-liquidity-analyst as parallel subagents, plan from their reports, then risk-manager phase 2 on your plan, if any/, 'only the roles still to run');
  assert.doesNotMatch(p.split('Cached reports')[0], /trend-momentum-analyst|risk-manager \(phase 1\)/, 'the cached ones are not in the roster');
  assert.match(p, /Cached reports, still valid this bar[^]*don't launch trend-momentum-analyst, risk-manager \(phase 1\) this cycle; the order gate counts them as returned\. An analyst's 15m-and-up view holds until 10:45 ET; take this bar's 3m facts[^]*A cached report is that role's report this cycle: never send it back to a role to read, summarize or redo\./);
  assert.match(p, /\n--- trend-momentum-analyst report \(from 10:21 ET\) ---\nData: bar_briefing m15@x\nBias: long \(high\)\n--- end of trend-momentum-analyst report ---/);
  assert.match(p, /\n--- risk-manager phase 1 report \(from 10:21 ET\) ---\nPhase 1: 2 trades left\n/);
  // None cached, manage-only or paper: no cached section.
  assert.doesNotMatch(prompts(validateConfig({}), now).trade(items), /Cached reports/);
  assert.doesNotMatch(prompts(validateConfig({}), now).trade(items, { cached, manageOnly: true }), /Cached reports/);
  assert.doesNotMatch(prompts(validateConfig({ paper: true }), now).trade(items, { cached }), /Cached reports/);
});

test('a trade prompt names the roles its cycle runs before an entry, as the gate checks them', () => {
  const now = new Date('2026-10-07T14:30:00Z');
  const items = [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 21500, file: '/b/MNQ-3m.json', contractId: 'MNQ' } }];
  const full = prompts(validateConfig({}), now).trade(items);
  assert.match(full, /With your skill tool, load trade-session, multi-timeframe-analysis, and trade-lifecycle \(the order gate refuses an entry without them\); also load htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context before deciding/);
  // Codex has no skill tool (it carries the skills in AGENTS.md): it reads them, and its gate can't see them loaded.
  const cx = prompts(validateConfig({ harness: 'codex' }), now).trade(items);
  assert.match(cx, /Read the skills trade-session, multi-timeframe-analysis, and trade-lifecycle; also load htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context before deciding, then run/);
  assert.match(prompts(validateConfig({ harness: 'custom', command: ['x', '{prompt}'] }), now).trade(items), /Load the skills trade-session, multi-timeframe-analysis, and trade-lifecycle; also load htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context before deciding, then run/);
  assert.match(full, /trade-lifecycle \(the order gate refuses an entry without them\); also load htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context before deciding, then run/);
  assert.match(full, /Full cycle: market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst and risk-manager \(phase 1\) as parallel subagents, plan from their reports, then risk-manager phase 2 on your plan, if any; the gate refuses an entry until all report and phase 2 approves\./);
  assert.match(prompts(validateConfig({ cycle: 'lean' }), now).trade(items), /Lean cycle: on a candidate, risk-manager phase 1, then risk-manager phase 2 on your plan, if any; the gate refuses an entry until all report and phase 2 approves\./);
  // No entries possible: no roster.
  assert.doesNotMatch(prompts(validateConfig({}), now).trade(items, { manageOnly: true }), /Full cycle:/);
  assert.doesNotMatch(prompts(validateConfig({ paper: true }), now).trade(items), /Full cycle:/);
  // A harness whose gate can't see the roles (Codex, custom) is told the roster, not a refusal it won't get.
  const codex = prompts(validateConfig({ harness: 'codex' }), now).trade(items);
  assert.match(codex, /Full cycle: market-structure-analyst[^]*then risk-manager phase 2 on your plan, if any\./);
  assert.doesNotMatch(codex, /the gate refuses an entry until all report/);
  assert.match(prompts(validateConfig({ harness: 'qwen' }), now).trade(items), /the gate refuses an entry until all report and phase 2 approves/);
});

test('child env locks the gate and paper mode disables trading', () => {
  const live = childEnv(validateConfig({}), '/r', { PATH: '/bin' });
  assert.deepStrictEqual([live.FTH_ROOT, live.FTH_AUTONOMOUS, live.FTH_PAPER], ['/r', '1', undefined]);
  // The harness tools read the runner's bar directory: its dataDir, else <FTH_HOME>/bars; never a stale FTH_BARS_DIR.
  assert.strictEqual(childEnv(validateConfig({}), '/r', { FTH_HOME: '/srv/fth', FTH_BARS_DIR: '/elsewhere' }).FTH_BARS_DIR, '/srv/fth/bars');
  assert.strictEqual(childEnv(validateConfig({ dataDir: '/data/bars' }), '/r', {}).FTH_BARS_DIR, '/data/bars');
  // The runner's symbols are the selected contracts for the gate, order_plan and the scan, never a stale FTH_SYMBOLS.
  assert.strictEqual(live.FTH_SYMBOLS, 'MNQ');
  assert.strictEqual(childEnv(validateConfig({ symbols: ['NQ', 'MES'] }), '/r', { FTH_SYMBOLS: 'MNQ' }).FTH_SYMBOLS, 'NQ,MES');
  assert.strictEqual(childEnv(validateConfig({ symbols: ['NQ'], harness: 'opencode' }), '/r', { FTH_SYMBOLS: 'MNQ' }).FTH_SYMBOLS, 'NQ');
  const paper = childEnv(validateConfig({ paper: true }), '/r', { FTH_BROKERS_FILE: FAKE_BROKERS });
  assert.deepStrictEqual([paper.FTH_PAPER, paper.FAKE_BROKER_TRADING_ENABLED], ['1', 'false']);
  // The shipped default broker (mcp-configs/brokers.json, no FTH_BROKERS_FILE): its own off switch, all of it.
  const shippedPaper = shippedBroker().paperEnv || {};
  assert.ok(Object.keys(shippedPaper).length > 0, 'the shipped broker has a paper switch');
  const shipped = childEnv(validateConfig({ paper: true }), '/r', { FTH_HOME: require('../helpers').tmpDir() });
  for (const [k, v] of Object.entries(shippedPaper)) assert.strictEqual(shipped[k], v, k);
  // The broker server's own off switch comes from the broker config (paperEnv), whatever the broker.
  const home = require('../helpers').tmpDir();
  require('fs').writeFileSync(require('path').join(home, 'brokers.json'), JSON.stringify({ broker: 'other', brokers: { other: { command: ['x'], paperEnv: { OTHER_LIVE: 'no' } } } }));
  const other = childEnv(validateConfig({ paper: true }), '/r', { FTH_HOME: home });
  assert.deepStrictEqual([other.OTHER_LIVE, other.FAKE_BROKER_TRADING_ENABLED], ['no', undefined]);
  for (const k of Object.keys(shippedPaper)) assert.strictEqual(other[k], undefined, `${k}: another broker's paper switch never leaks`);
  assert.match(prompts(cfg, et(10, 0), '/r').trade('MNQ'), /Harness root \(FTH_ROOT\): \/r; its operations are the `harness` MCP server's tools, not scripts\./);
  assert.doesNotMatch(prompts(cfg, et(10, 0), '/r').trade('MNQ'), /node \/r\/scripts/);
  assert.match(prompts(cfg, et(16, 0), '/r').eod(), /the reconcile tool with day \d{4}-\d{2}-\d{2} and timeframe \d+/);
});

test('trade prompt carries the closed bar and its data file', () => {
  const bar = sym => ({ t: '2026-10-07T14:00:00Z', c: 21503.25, file: `/b/${sym}-1m.json`, contractId: sym });
  const p = prompts(validateConfig({ timeframe: 1 }), et(10, 1), '/r').trade([{ symbol: 'MNQ', bar: bar('MNQ') }, { symbol: 'MES', bar: bar('MES') }], { recovered: true });
  assert.match(p, /MNQ: a 1-minute bar just closed \(opened 10:00 ET\)/);
  assert.match(p, /\/b\/MES-1m\.json .*contractId MES/);
  assert.match(p, /trade-session skill for MNQ, MES \(one symbol at a time, open positions first\)/);
  assert.match(p, /previous cycle was stopped before it finished/);
  assert.match(prompts(validateConfig({ cycle: 'lean' }), et(10, 1), '/r').trade('MNQ', { manageOnly: true }), /lean cycle.*manage-only/);
});

test('signal trigger runs on an open position or a mechanical candidate only', () => {
  assert.deepStrictEqual(signalDecision([], -1), { run: true, reason: 'position open (net -1)' });
  assert.strictEqual(signalDecision([{ name: 'orb', status: 'active', candidate: true, signal: 'orb', direction: 'long' }], 0).reason, 'strategy candidate: orb long');
  assert.strictEqual(signalDecision([{ name: 'cisd_ote', candidate: true, signal: 'manual' }, { name: 'orb', candidate: false, signal: 'orb' }], 0).run, false);
});

test('Claude settings that ask or deny order tools are reported', () => {
  assert.deepStrictEqual(claudeOrderToolConflicts([{ permissions: { ask: ['mcp__broker__place_order', 'Bash'], allow: ['mcp__broker__get_bars'] } }, { permissions: { deny: ['mcp__broker'] } }]),
    ['ask: mcp__broker__place_order', 'deny: mcp__broker']);
  assert.deepStrictEqual(claudeOrderToolConflicts([{}, null]), []);
});

test('runnerArgv: only the runner\'s own flags, as --flag value or --flag=value, each once', () => {
  const { runnerArgv } = require('../../scripts/lib/autotrader');
  assert.deepStrictEqual(runnerArgv(['--config=a.json', '--once=trade', '--symbol', 'MES', '--dry-run']), ['--config', 'a.json', '--once', 'trade', '--symbol', 'MES', '--dry-run']);
  assert.deepStrictEqual(runnerArgv(['--status', '--stale-minutes', '5']), ['--status', '--stale-minutes', '5']);
  assert.deepStrictEqual(runnerArgv([]), []);
  for (const [argv, why] of [
    [['--dryrun'], /unknown argument: --dryrun/], [['--dry-run=true'], /unknown argument: --dry-run=true/], [['--ONCE', 'trade'], /unknown argument: --ONCE/],
    [['config.json'], /unknown argument: config\.json/], [['--once'], /--once needs a value/], [['--once', '--dry-run'], /--once needs a value/],
    [['--once', 'later'], /--once must be premarket, trade, or eod/], [['--once=trade', '--once', 'eod'], /--once given twice/],
    [['--config', 'a', '--config', 'b'], /--config given twice/], [['--status', '--status'], /--status given twice/],
    [['--config', 'a', '--symbol', 'MNQ'], /--symbol goes with --once/], [['--config', 'a', '--stale-minutes', '5'], /--stale-minutes goes with --status/],
    [['--status', '--config', 'a'], /--status checks the running runner and takes only --stale-minutes, not --config/],
  ]) assert.throws(() => runnerArgv(argv), why, argv.join(' '));
});

test('cycleResult finds the last reported result', () => {
  assert.strictEqual(cycleResult('x\nCYCLE RESULT: planned - a\nCYCLE RESULT: executed - b\n'), 'CYCLE RESULT: executed - b');
  assert.strictEqual(cycleResult('{"result":"done. CYCLE RESULT: no-trade - quiet"}'), 'CYCLE RESULT: no-trade - quiet');
  assert.strictEqual(cycleResult('nothing'), null);
});

test('cycleResult: trivial formatting tolerated, nothing looser; only the final message of a transcript counts', () => {
  const claude = (final, ...earlier) => [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    ...earlier.map(text => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } })),
    JSON.stringify({ type: 'result', result: final }),
  ].join('\n');
  const qwen = final => `Warning: long context\n${JSON.stringify([{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'success', result: final }])}\n`;
  // Formatting: leading spaces, bold or code around the line or the label, a list dash.
  for (const line of ['  CYCLE RESULT: no-trade - quiet', '**CYCLE RESULT: no-trade - quiet**', '**CYCLE RESULT:** no-trade - quiet', '`CYCLE RESULT: no-trade - quiet`', '- CYCLE RESULT: no-trade - quiet  ', '__CYCLE RESULT: no-trade - quiet__']) {
    assert.strictEqual(cycleResult(claude(`Summary.\n${line}`)), 'CYCLE RESULT: no-trade - quiet', line);
    assert.strictEqual(cycleResult(qwen(`Summary.\n${line}`)), 'CYCLE RESULT: no-trade - quiet', `qwen ${line}`);
    assert.strictEqual(cycleResult(`text\n${line}\n`), 'CYCLE RESULT: no-trade - quiet', `plain ${line}`);
  }
  // A reason with quotes, in a final message, stays whole.
  assert.strictEqual(cycleResult(claude('CYCLE RESULT: no-trade - "orb" skipped')), 'CYCLE RESULT: no-trade - "orb" skipped');
  // Not looser: another label, another case, or the template is no result.
  for (const final of ['cycle result: no-trade - x', 'CYCLE RESULTS: no-trade', 'Result: no-trade', 'Decision: NO TRADE (stand aside)',
    'CYCLE RESULT: <no-trade | planned | executed | managed | flattened | blocked | error> - <reason>']) {
    assert.strictEqual(cycleResult(claude(final)), null, final);
    assert.strictEqual(cycleResult(final), null, `plain ${final}`);
  }
  // A summary instead of the line: the skill text, the prompt, or a tool's output echoed earlier is never the result.
  const skillText = 'CYCLE RESULT: no-trade - orb fired but relative volume 0.8x (skip rule)\nCYCLE RESULT: blocked - [loss-streak] cooldown 18 min';
  assert.strictEqual(cycleResult(claude('**Cycle Complete:** NO TRADE (stand aside)', skillText)), null);
  assert.strictEqual(cycleResult(claude('done\nCYCLE RESULT: managed - trailed', skillText)), 'CYCLE RESULT: managed - trailed');
  // Codex --json: its last agent message.
  const codex = [
    { type: 'item.completed', item: { type: 'agent_message', text: 'CYCLE RESULT: executed - early' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'harness', tool: 'x', result: skillText } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done.\n**CYCLE RESULT: flattened - eod**' } },
  ].map(e => JSON.stringify(e)).join('\n');
  assert.strictEqual(cycleResult(codex), 'CYCLE RESULT: flattened - eod');
  // The real Qwen cycle that wrote a summary instead of the line.
  const fixture = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'qwen-cycle-transcript.txt'), 'utf8');
  assert.strictEqual(cycleResult(fixture), null);
});

test('cycleResult: a JSON line in a plain-text run (an echoed order, a stderr warning) never hides its result line', () => {
  for (const out of [
    'placing order\n{"type":"market","side":"buy","size":1}\nCYCLE RESULT: executed - orb long\n',
    'CYCLE RESULT: executed - orb long\n{"type":"warning","message":"deprecated"}\n',
    '{"type":"log","msg":"start"}\n[{"type":"error"}]\nCYCLE RESULT: executed - orb long',
  ]) assert.strictEqual(cycleResult(out), 'CYCLE RESULT: executed - orb long', out);
  // A transcript event among them still makes it a transcript: no final message, no result.
  assert.strictEqual(cycleResult('{"type":"system","subtype":"init"}\nCYCLE RESULT: executed - echoed\n'), null);
  assert.strictEqual(cycleResult('{"type":"turn.started"}\nCYCLE RESULT: executed - echoed\n'), null);
});

test('cycleResult: a transcript cut short has no result; formatting inside the body; no empty body; a failed run logs its error', () => {
  const { runResult } = require('../../scripts/lib/autotrader');
  // (a) A stream-json run that timed out before its result event: an echoed skill example is no result.
  const cut = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'autonomous-trading' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'CYCLE RESULT: executed - orb long 1 MNQ\nCYCLE RESULT: blocked - [loss-streak] cooldown 18 min' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it. CYCLE RESULT: managed - half way' }] } }),
  ].join('\n');
  assert.strictEqual(cycleResult(cut), null);
  // Codex killed before its agent message; Qwen's array without its result.
  assert.strictEqual(cycleResult(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', result: 'CYCLE RESULT: executed - x' } })), null);
  assert.strictEqual(cycleResult(`Warning\n${JSON.stringify([{ type: 'system' }, { type: 'user', message: { content: [{ type: 'tool_result', content: 'CYCLE RESULT: executed - x' }] } }])}`), null);
  assert.deepStrictEqual([runResult({ ok: false, timedOut: true, output: cut }), runResult({ ok: false, timedOut: false, code: 2, output: 'CYCLE RESULT: executed - x' })],
    ['CYCLE RESULT: error - timed out', 'CYCLE RESULT: error - exit 2'], 'a failed run is its error, whatever it printed');
  assert.deepStrictEqual([runResult({ ok: true, output: 'CYCLE RESULT: no-trade - q' }), runResult({ ok: true, output: 'nothing' })], ['CYCLE RESULT: no-trade - q', 'CYCLE RESULT: (none reported)']);
  // (b) Formatting inside the body, on both sides; a backticked template is still the template.
  const result = final => cycleResult(JSON.stringify({ type: 'result', result: final }));
  for (const line of ['CYCLE RESULT: **no-trade - quiet**', 'CYCLE RESULT: **no-trade** - quiet', 'CYCLE RESULT: `no-trade - quiet`', '**CYCLE RESULT:** _no-trade - quiet_', 'CYCLE RESULT:no-trade - quiet']) {
    assert.strictEqual(result(`Done.\n${line}`), 'CYCLE RESULT: no-trade - quiet', line);
    assert.strictEqual(cycleResult(`x\n${line}\n`), 'CYCLE RESULT: no-trade - quiet', `plain ${line}`);
    // The replay report counts it as standing aside.
    assert.match(result(line), /^CYCLE RESULT:\s*no-trade\b/i);
  }
  assert.strictEqual(result('CYCLE RESULT: no-trade - ema_cross and value_area_reentry quiet'), 'CYCLE RESULT: no-trade - ema_cross and value_area_reentry quiet', 'a name\'s underscores stay');
  for (const t of ['CYCLE RESULT: `<no-trade | planned | executed> - <reason>`', 'CYCLE RESULT: **<no-trade | planned> - <reason>**']) {
    assert.strictEqual(result(t), null, t);
    assert.strictEqual(cycleResult(t), null, `plain ${t}`);
  }
  // (c) No body: no result (the "(none reported)" path), in a final message and in plain text.
  for (const t of ['**CYCLE RESULT:**\nno-trade - x', 'Summary.\nCYCLE RESULT:', 'CYCLE RESULT: **  **']) {
    assert.strictEqual(result(t), null, t);
    assert.strictEqual(cycleResult(t), null, `plain ${t}`);
  }
  assert.strictEqual(result('CYCLE RESULT: no-trade - a\nCYCLE RESULT:'), 'CYCLE RESULT: no-trade - a', 'an empty last line doesn\'t hide the one before');
  // Codex: the last agent message counts, not a later tool item's echo nor an earlier message.
  const codex = [
    { type: 'item.completed', item: { type: 'agent_message', text: 'CYCLE RESULT: executed - early' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done.\nCYCLE RESULT: no-trade - final' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'harness', tool: 'x', result: 'CYCLE RESULT: blocked - echo' } },
    { type: 'turn.completed' },
  ].map(e => JSON.stringify(e)).join('\n');
  assert.strictEqual(cycleResult(codex), 'CYCLE RESULT: no-trade - final');
});

// --- The fallback: a final message without the line gives the session's own last line (a stop hook's reminder after it). ---
const MANAGED = 'CYCLE RESULT: managed - MNQ short 1 from 13480.25 is open; protective stop at 13490.25 working; no new order this cycle.';
const sj = evs => evs.map(e => JSON.stringify(e)).join('\n');
const said = (text, extra = {}) => ({ type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const called = (name, id = 'c1', input = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const answered = (id, content) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const ended = result => ({ type: 'result', subtype: 'success', is_error: false, result });
const STOPPED = 'The entry from this cycle is still open, so there is no review to write yet. The protective stop is working. I\'m stopping here.';

test('cycleResult regression: a managed cycle whose stop hook asked again after its line (the replay transcript\'s shape) keeps its line', () => {
  const { runResult } = require('../../scripts/lib/autotrader');
  const out = sj([
    { type: 'system', subtype: 'init' },
    said(`Position managed.\n\n${MANAGED}`),
    { type: 'user', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: 'Stop hook feedback:\n[stop:trading:review-reminder]: 1 entry this trading day has no review. If the trade is closed, run /trade-review. If it is still open, confirm the protective stop is working with list_open_orders, then you may stop. Then end your reply with this cycle\'s CYCLE RESULT line again, as its last line.' }] } },
    called('mcp__broker__list_open_orders', 'l1', { accountId: 1 }),
    answered('l1', '[{"id":7,"type":4,"side":0,"size":1,"stopPrice":13490.25}]'),
    said(STOPPED),
    ended(STOPPED),
  ]);
  assert.strictEqual(cycleResult(out), MANAGED);
  assert.strictEqual(runResult({ ok: true, stdout: out }), MANAGED, 'logged with its line, not "(none reported)"');
  assert.strictEqual(cycleOutcome({ ok: true, stdout: out }, { result: MANAGED, intact: true, action: 'manage' }).ok, true, 'a decision: no failed cycle, no retry');
  // A failed run is still its error, whatever it wrote.
  assert.strictEqual(runResult({ ok: false, timedOut: false, code: 1, stdout: out }), 'CYCLE RESULT: error - exit 1');
});

test('cycleResult fallback: the final message\'s line wins; only the session\'s own text counts; no line anywhere is none', () => {
  const { runResult } = require('../../scripts/lib/autotrader');
  const earlier = 'CYCLE RESULT: no-trade - first look';
  // The final message's line wins over an earlier one.
  assert.strictEqual(cycleResult(sj([said(earlier), said(`Done.\n${MANAGED}`), ended(`Done.\n${MANAGED}`)])), MANAGED);
  assert.strictEqual(cycleResult(sj([said(earlier), ended(`Done.\n${MANAGED}`)])), MANAGED, 'the result event\'s line, with a different earlier one');
  // Without one in the final message: the last own line, of several (a template never counts).
  assert.strictEqual(cycleResult(sj([said(earlier), said(`${MANAGED}\nCYCLE RESULT: <no-trade | managed> - <reason>`), said(STOPPED), ended(STOPPED)])), MANAGED);
  // A subagent's, a sidechain's or the harness's own message never counts.
  for (const extra of [{ parent_tool_use_id: 'toolu_1' }, { isSidechain: true }]) assert.strictEqual(cycleResult(sj([said(MANAGED, extra), ended(STOPPED)])), null, JSON.stringify(extra));
  assert.strictEqual(cycleResult(sj([{ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: MANAGED }] } }, ended(STOPPED)])), null, 'synthetic');
  // Hook feedback and tool results (user-role events) never count.
  assert.strictEqual(cycleResult(sj([{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `Stop hook feedback:\n${MANAGED}` }] } }, ended(STOPPED)])), null, 'hook feedback');
  assert.strictEqual(cycleResult(sj([called('Skill', 's1'), answered('s1', MANAGED), ended(STOPPED)])), null, 'tool result');
  // An order call or a role launch after the line makes it stale; a read doesn't.
  assert.strictEqual(cycleResult(sj([said(earlier), called('mcp__broker__place_order'), ended(STOPPED)])), null, 'order after the line');
  assert.strictEqual(cycleResult(sj([said(earlier), called('Task', 't1', { subagent_type: 'trade-executor' }), ended(STOPPED)])), null, 'launch after the line');
  assert.strictEqual(cycleResult(sj([said(earlier), called('mcp__broker__list_open_orders'), ended(STOPPED)])), earlier, 'a read after the line');
  // A run that ended in an error result keeps no earlier line; a run cut short (no final message) has none.
  assert.strictEqual(cycleResult(sj([said(MANAGED), { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'stopped' }])), null, 'error result');
  assert.strictEqual(cycleResult(sj([said(MANAGED)])), null, 'cut short');
  // No line anywhere: "(none reported)".
  assert.strictEqual(runResult({ ok: true, stdout: sj([said('Looking.'), said(STOPPED), ended(STOPPED)]) }), 'CYCLE RESULT: (none reported)');
  // Qwen's JSON array, Claude-shaped: the same rule.
  assert.strictEqual(cycleResult(`Warning\n${JSON.stringify([{ type: 'system' }, said(MANAGED), said(STOPPED), ended(STOPPED)])}`), MANAGED, 'qwen');
});

test('cycleResult fallback, opencode: its own session\'s text before its last tool call; Codex keeps its last agent message', () => {
  const oc = (type, part, sessionID = 'ses_head') => ({ type, timestamp: 1, sessionID, part });
  const text = (t, sid) => oc('text', { type: 'text', text: t }, sid);
  const tool = name => oc('tool_use', { type: 'tool', tool: name, state: { status: 'completed', input: {}, output: '[]' } });
  assert.strictEqual(cycleResult(sj([text(MANAGED), tool('broker_list_open_orders'), text(STOPPED)])), MANAGED);
  assert.strictEqual(cycleResult(sj([text('CYCLE RESULT: no-trade - early'), tool('broker_list_open_orders'), text(`ok\n${MANAGED}`)])), MANAGED, 'the final text\'s line wins');
  assert.strictEqual(cycleResult(sj([text('start'), text(MANAGED, 'ses_child'), tool('broker_list_open_orders'), text(STOPPED)])), null, 'another session\'s text');
  assert.strictEqual(cycleResult(sj([text(MANAGED), oc('text', { type: 'text', text: STOPPED, synthetic: true }), tool('x'), text(STOPPED)])), MANAGED);
  assert.strictEqual(cycleResult(sj([oc('text', { type: 'text', text: MANAGED, synthetic: true }), tool('x'), text(STOPPED)])), null, 'opencode\'s synthetic text');
  assert.strictEqual(cycleResult(sj([text(MANAGED), tool('broker_place_order'), text(STOPPED)])), null, 'an order after the line');
  assert.strictEqual(cycleResult(sj([text(MANAGED), tool('task'), text(STOPPED)])), null, 'a launch after the line');
  assert.strictEqual(cycleResult(sj([text(MANAGED), { type: 'error', timestamp: 1, sessionID: 'ses_head', error: { name: 'APIError' } }, tool('x'), text(STOPPED)])), null, 'an error event');
  // Codex: no fallback (its items don't say which agent wrote them).
  const codex = [{ type: 'item.completed', item: { type: 'agent_message', text: MANAGED } }, { type: 'item.completed', item: { type: 'agent_message', text: STOPPED } }];
  assert.strictEqual(cycleResult(sj(codex)), null);
});

test('cycleResult fallback, review fixes: Qwen\'s bridged order call stales a line; a `planned` line is never recovered; narration is no line; the recovery is noted', () => {
  const { runResult, scoreRun, finalMessage, EARLIER_NOTE } = require('../../scripts/lib/autotrader');
  // (1) Qwen Code's tool_call bridge (tests/fixtures/qwen-bridge-transcript.json's shape): the tool it reaches decides.
  const bridged = (name, args = {}) => ({ type: 'assistant', session_id: 'session-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-9', name: 'tool_call', input: { name, arguments: args } }] } });
  const qwen = evs => JSON.stringify([{ type: 'system', subtype: 'init', session_id: 'session-1', tools: ['tool_call', 'agent'] }, ...evs]);
  assert.strictEqual(cycleResult(qwen([said(MANAGED), bridged('mcp__broker__place_order', { side: 1 }), said(STOPPED), ended(STOPPED)])), null, 'a bridged order after the line');
  assert.strictEqual(cycleResult(qwen([said(MANAGED), bridged('mcp__broker__list_open_orders'), said(STOPPED), ended(STOPPED)])), MANAGED, 'a bridged read');
  assert.strictEqual(cycleResult(qwen([said(MANAGED), called('agent', 'a1', { subagent_type: 'trade-executor' }), said(STOPPED), ended(STOPPED)])), null, 'Qwen\'s agent launch');
  // (2) A `planned` line (it starts the runner's entry) only ever from the final message.
  const planned = 'CYCLE RESULT: planned - trade_lifecycle long 1';
  assert.strictEqual(runResult({ ok: true, stdout: sj([said(planned), said('I stand aside.'), ended('I stand aside.')]) }), 'CYCLE RESULT: (none reported)');
  assert.strictEqual(cycleResult(sj([said(MANAGED), said(`**${planned.replace('planned', 'Planned')}**`), said(STOPPED), ended(STOPPED)])), null, 'the last own line is planned: none, never an older one');
  assert.strictEqual(cycleResult(sj([said(planned), ended(`ok\n${planned}`)])), planned, 'a final message\'s planned line stands');
  for (const line of ['CYCLE RESULT: executed - orb long 1', 'CYCLE RESULT: no-trade - quiet', 'CYCLE RESULT: blocked - [loss-streak] cooldown', MANAGED]) {
    assert.strictEqual(cycleResult(sj([said(line), said(STOPPED), ended(STOPPED)])), line, line);
  }
  // (3) Only a line that starts with the label: the model's narration is none; within a message the last such line.
  const narration = 'I will end with "CYCLE RESULT: no-trade - nothing set up" if nothing sets up.';
  assert.strictEqual(cycleResult(sj([said(narration), said(STOPPED), ended(STOPPED)])), null, 'narration');
  assert.strictEqual(cycleResult(sj([said(`- **CYCLE RESULT:** no-trade - early\n> CYCLE RESULT: no-trade - later\n${narration}`), said(STOPPED), ended(STOPPED)])), 'CYCLE RESULT: no-trade - later');
  assert.strictEqual(cycleResult(sj([said(`Done. ${MANAGED}`), ended(`Done. ${MANAGED}`)])), MANAGED, 'a final message\'s line stays read anywhere in it');
  // (4) The recovery is visible: fromEarlier, and scoreRun's note; a final message's line has none.
  const recovered = sj([said(MANAGED), said(STOPPED), ended(STOPPED)]);
  assert.deepStrictEqual([finalMessage(recovered).fromEarlier, finalMessage(sj([said(MANAGED), ended(MANAGED)])).fromEarlier], [true, false]);
  assert.deepStrictEqual(scoreRun({ ok: true, stdout: recovered }, { action: 'manage', harness: 'claude' }), { result: MANAGED, resultNote: EARLIER_NOTE });
  assert.deepStrictEqual(scoreRun({ ok: true, stdout: sj([said(MANAGED), ended(MANAGED)]) }, { action: 'manage', harness: 'claude' }), { result: MANAGED });
  assert.deepStrictEqual(scoreRun({ ok: false, code: 1, stdout: recovered }, { action: 'manage', harness: 'claude' }), { result: 'CYCLE RESULT: error - exit 1' }, 'a failed run: no note');
  // With a blocked line rescored too: both notes.
  const blocked = sj([said('CYCLE RESULT: blocked - nothing fired'), called('mcp__broker__list_open_orders'), said(STOPPED), ended(STOPPED)]);
  const s = scoreRun({ ok: true, stdout: blocked }, { action: 'trade', harness: 'claude' });
  assert.deepStrictEqual([s.result, s.reportedResult], ['CYCLE RESULT: no-trade - nothing fired', 'CYCLE RESULT: blocked - nothing fired']);
  assert.match(s.resultNote, new RegExp(`^${EARLIER_NOTE}; reported blocked`));
});

test('every cycle prompt ends with the exact result line the runner reads', () => {
  const cfg = validateConfig({ harness: 'claude', account: '1' });
  const p = prompts(cfg, new Date('2026-10-07T14:03:02Z'), ROOT);
  const line = 'Your last line must be exactly: CYCLE RESULT: <no-trade | planned | executed | managed | flattened | blocked | error> - <reason>';
  for (const text of [p.trade([{ symbol: 'MNQ' }]), p.premarket('MNQ'), p.eod()]) {
    assert.ok(text.includes(line), text.slice(-300));
    assert.ok(text.endsWith(`${line}.`), 'it is the prompt\'s last sentence');
    // A result sent as a tool call is never read: the prompt says it is plain text.
    assert.ok(text.includes(`End with the cycle result as plain text in your final message, never as a tool call. ${line}`), text.slice(-300));
    // The prompt echoed into a run's output is never read as its result.
    assert.strictEqual(cycleResult(`prompt=${text}\n`), null);
  }
});

test('CLI --once runs the harness in the workspace with FTH_ROOT, and --dry-run prints the command', () => {
  const dir = tmpDir();
  const config = path.join(dir, 'auto.json');
  // Paper: a live manual run names its account and takes its lock (runner-wiring.js manualRunBroker).
  fs.writeFileSync(config, JSON.stringify({ harness: 'custom', command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), '{prompt}'], paper: true }));
  const env = { ...process.env, HOME: dir, FTH_KILL_SWITCH_FILE: path.join(dir, 'STOP') };
  const cli = path.join(ROOT, 'scripts', 'autotrader.js');
  const run = spawnSync(process.execPath, [cli, '--config', config, '--once', 'trade', '--symbol', 'MES'], { encoding: 'utf8', env });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.match(run.stdout, /CYCLE RESULT: no-trade - fake harness/);
  const log = fs.readdirSync(path.join(dir, '.futures-trading-harness', 'logs'))[0];
  const text = fs.readFileSync(path.join(dir, '.futures-trading-harness', 'logs', log), 'utf8');
  assert.ok(text.includes(`cwd=${path.join(ROOT, 'workspace')} FTH_ROOT=${ROOT}`));
  assert.match(text, /prompt=.*FTH_ROOT/);
  assert.match(text, /trade-session skill for MES/);
  fs.writeFileSync(path.join(dir, 'STOP'), '');
  const blocked = spawnSync(process.execPath, [cli, '--config', config, '--once', 'trade'], { encoding: 'utf8', env });
  assert.strictEqual(blocked.status, 1);
  assert.match(blocked.stderr, /kill switch is on/);
  const eod = spawnSync(process.execPath, [cli, '--config', config, '--once', 'eod', '--dry-run'], { encoding: 'utf8', env });
  assert.strictEqual(eod.status, 0, eod.stderr);
  assert.match(eod.stdout, /end-of-day skill/);
});

test('CLI start: a harness tools server that does not offer the registry\'s tools refuses a run; a manual end of day only warns', { timeout: 120000 }, () => {
  // A copy of the harness whose tools server is a foreign MCP server (the fake broker).
  const root = tmpDir();
  for (const d of ['scripts', 'config', 'strategies', 'accounts', 'mcp-configs', 'agents', 'skills', 'workspace']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  fs.writeFileSync(path.join(root, 'scripts', 'harness-tools-mcp.js'), `require(${JSON.stringify(path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js'))});\n`);
  const dir = tmpDir();
  const config = path.join(dir, 'auto.json');
  fs.writeFileSync(config, JSON.stringify({ harness: 'custom', command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), '{prompt}'] }));
  const env = { ...process.env, HOME: dir, FTH_HOME: path.join(dir, '.futures-trading-harness'), FTH_KILL_SWITCH_FILE: path.join(dir, 'STOP') };
  delete env.FTH_REPLAY_NOW;
  const cli = path.join(root, 'scripts', 'autotrader.js');
  const trade = spawnSync(process.execPath, [cli, '--config', config, '--once', 'trade', '--symbol', 'MES'], { encoding: 'utf8', env });
  assert.strictEqual(trade.status, 1);
  assert.match(trade.stderr, /the harness tools server \(.*harness-tools-mcp\.js\) does not offer the harness's tools/);
  assert.doesNotMatch(trade.stdout, /CYCLE RESULT/, 'no cycle ran');
  // A bad --once is refused before the start check runs.
  const bogus = spawnSync(process.execPath, [cli, '--config', config, '--once', 'bogus'], { encoding: 'utf8', env });
  assert.strictEqual(bogus.status, 1);
  assert.match(bogus.stderr, /--once must be premarket, trade, or eod/);
  assert.doesNotMatch(bogus.stderr, /harness tools server/);
  const bare = spawnSync(process.execPath, [cli, '--config', config, '--once'], { encoding: 'utf8', env, timeout: 30000 });
  assert.strictEqual(bare.status, 1, 'a bare --once never starts the live loop');
  assert.match(bare.stderr, /--once needs a value/);
  // Typos never fall through to the live loop: refused before anything runs, the lock never taken.
  const lockFile = path.join(env.FTH_HOME, 'autotrader.lock');
  for (const args of [['--dryrun'], ['--dry-run=true'], ['--ONCE', 'trade'], ['--once', 'trade', '--once', 'eod'], ['--symbol'], ['--symbol', 'MNQ'], ['--stale-minutes', '5']]) {
    const r = spawnSync(process.execPath, [cli, '--config', config, ...args], { encoding: 'utf8', env, timeout: 30000 });
    assert.strictEqual(r.status, 1, args.join(' '));
    assert.match(r.stderr, /unknown argument|given twice|needs a value|goes with/, args.join(' '));
    assert.ok(!fs.existsSync(lockFile), `${args.join(' ')}: no lock taken`);
  }
  // --once=trade is --once trade: one manual cycle (refused here by the start check), never the live loop.
  const inline = spawnSync(process.execPath, [cli, `--config=${config}`, '--once=trade'], { encoding: 'utf8', env, timeout: 30000 });
  assert.strictEqual(inline.status, 1);
  assert.match(inline.stderr, /the harness tools server .* does not offer the harness's tools/);
  assert.ok(!fs.existsSync(lockFile));
  const eod = spawnSync(process.execPath, [cli, '--config', config, '--once', 'eod'], { encoding: 'utf8', env });
  assert.strictEqual(eod.status, 0, eod.stderr);
  assert.match(eod.stderr, /\[autotrader\] warning: the harness tools server/);
  assert.match(eod.stdout, /CYCLE RESULT: no-trade - fake harness/, 'flattening needs only the broker: the end of day runs');
  // A replay step is a pass of the live loop: trading turns off (kill switch), the step itself runs.
  const home = path.join(dir, 'replay-home');
  fs.mkdirSync(home);
  // The replay broker: the mock exchange as a replay server (its clock starts at 2026-10-07T14:00:00Z).
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'replaymock', brokers: { replaymock: { command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js')], replay: true, limits: { dailyLoss: 'MOCK_MAX_DAILY_LOSS', maxOrderSize: 'MOCK_MAX_ORDER_SIZE', maxPositionSize: 'MOCK_MAX_POSITION_SIZE' }, journalEnv: 'MOCK_JOURNAL' } } }));
  const replayStop = path.join(home, 'STOP');
  const replayEnv = { ...env, FTH_BROKERS_FILE: path.join(home, 'brokers.json'), FTH_HOME: home, FTH_KILL_SWITCH_FILE: replayStop, FTH_REPLAY_NOW: '2026-10-07T14:00:00Z', MOCK_REPLAY: '1', MOCK_STATE_DIR: home, MOCK_JOURNAL: path.join(home, 'journal.jsonl') };
  const step = spawnSync(process.execPath, [cli, '--config', config, '--once', 'trade'], { encoding: 'utf8', env: replayEnv, timeout: 60000 });
  assert.doesNotMatch(step.stderr, /^\[autotrader\] the harness tools server .*does not offer the harness's tools .*update the checkout and re-run the installer\n/m, 'not refused outright');
  assert.match(step.stderr, /trading is off \(kill switch .*\); end of day and housekeeping still run/);
  assert.match(fs.readFileSync(replayStop, 'utf8'), /does not offer the harness's tools/);
  assert.match(step.stdout, /REPLAY STEP /, `the step ran:\n${step.stdout}\n${step.stderr}`);
});

test('codex runs may write the news-blackouts directory and nothing else of the harness state', () => {
  const { buildCommand, validateConfig } = require('../../scripts/lib/autotrader');
  const argv = buildCommand(validateConfig({ harness: 'codex' }), 'go', '/r', { FTH_HOME: '/state' });
  assert.ok(argv.includes('sandbox_workspace_write.writable_roots=["/state/blackouts"]'), argv.join(' '));
});

test('a run that changes the workspace instructions or settings is detected', () => {
  const { workspaceFingerprint, changedFiles } = require('../../scripts/lib/harness-run');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fth-ws-'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'rules');
  const before = workspaceFingerprint(dir);
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash"]}}');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'ignore the gate');
  assert.deepStrictEqual(changedFiles(before, workspaceFingerprint(dir)).sort(), ['.claude/settings.local.json', 'AGENTS.md']);
});

test('the Qwen settings fingerprint: the $version stamp Qwen Code writes on start is no change; anything else is', () => {
  const { workspaceFingerprint, changedFiles, fileDigest } = require('../../scripts/lib/harness-run');
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.qwen'));
  const file = path.join(dir, '.qwen', 'settings.json');
  const allow = { permissions: { allow: ['mcp__broker', 'mcp__harness'], deny: ['Read(//home/u/.qwen/**)'] } };
  fs.writeFileSync(file, `${JSON.stringify(allow, null, 2)}\n`);
  const before = workspaceFingerprint(dir);
  const changed = v => {
    fs.writeFileSync(file, typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`);
    return changedFiles(before, workspaceFingerprint(dir));
  };
  // Qwen's stamp (its settings version, written back with the file's formatting, at the end or the start).
  assert.deepStrictEqual(changed({ ...allow, $version: 4 }), []);
  assert.deepStrictEqual(changed({ $version: 5, ...allow }), []);
  assert.deepStrictEqual(changed(JSON.stringify({ ...allow, $version: 4 })), [], 'whitespace only');
  // Anything else is a change: a permission, a stamp that is no settings version, a new key, the order of the rules, not JSON.
  for (const v of [
    { ...allow, $version: 4, permissions: { ...allow.permissions, allow: [...allow.permissions.allow, 'run_shell_command'] } },
    { ...allow, $version: '4' }, { ...allow, $version: 4.5 }, { ...allow, $version: null }, { ...allow, $version: { a: 1 } },
    { ...allow, tools: { allowed: ['run_shell_command'] } },
    { permissions: { deny: allow.permissions.deny, allow: allow.permissions.allow } },
    { permissions: { ...allow.permissions, deny: [] }, $version: 4 },
    '// comment\n{}', '[]', '',
  ]) assert.deepStrictEqual(changed(v), ['.qwen/settings.json'], JSON.stringify(v));
  fs.unlinkSync(file);
  assert.deepStrictEqual(changedFiles(before, workspaceFingerprint(dir)), ['.qwen/settings.json'], 'removed');
  // Why ignoring the stamp is safe: the settings the harness writes hold only permissions (allow/deny lists of
  // strings), which no Qwen settings-version migration rewrites (they move legacy top-level scalars, tools.core/
  // allowed/exclude, modelProviders, general.disable*). A key like those here would reopen the question.
  const { qwenWorkspaceSettings } = require('../../scripts/lib/install');
  for (const opts of [{}, { dataDir: '/r/bars', stateDir: '/r/home' }]) {
    const generated = qwenWorkspaceSettings(ROOT, '/home/u', opts);
    assert.deepStrictEqual(Object.keys(generated), ['permissions']);
    assert.deepStrictEqual(Object.keys(generated.permissions).sort(), ['allow', 'deny']);
    for (const list of Object.values(generated.permissions)) assert.ok(Array.isArray(list) && list.every(x => typeof x === 'string'));
  }
  // Only the Qwen settings file: another file's $version is a change like any other.
  assert.notStrictEqual(fileDigest('.claude/settings.json', '{"a":1}'), fileDigest('.claude/settings.json', '{"a":1,"$version":4}'));
  assert.strictEqual(fileDigest('.qwen/settings.json', '{"a":1}'), fileDigest('.qwen/settings.json', Buffer.from('{ "a": 1, "$version": 4 }')));
});

test('signal mode: a paper strategy only starts a cycle in paper mode', () => {
  const { signalDecision } = require('../../scripts/lib/autotrader');
  const scan = [{ name: 'vwap_reclaim', status: 'paper', signal: 'rules', candidate: true, direction: 'long' }];
  assert.strictEqual(signalDecision(scan, 0, 0).run, false);
  assert.strictEqual(signalDecision(scan, 0, 0, { paper: true }).run, true);
  assert.strictEqual(signalDecision([{ ...scan[0], status: 'active' }], 0, 0).run, true);
});

test('a harness run ends with its process group: nothing it left behind keeps running', { timeout: 20000 }, async () => {
  const { runHarness } = require('../../scripts/lib/harness-run');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fth-run-'));
  const marker = path.join(dir, 'ticks');
  // The harness exits only once its background loop has written (else, on a loaded machine, the group could be ended
  // before the loop ever ran, and there would be nothing to prove).
  let group = null;
  const r = await runHarness(['bash', '-c', `(while true; do echo x >> '${marker}'; sleep 0.2; done) & until [ -s '${marker}' ]; do sleep 0.05; done; exit 0`], {
    cwd: dir, env: process.env, timeoutMs: 10000, onChild: c => { if (c && group === null) group = c.pid; },
  });
  assert.strictEqual(r.ok, true);
  assert.ok(fs.readFileSync(marker, 'utf8').length > 0, 'the loop ran while the harness did');
  // The group is gone (SIGTERM at the harness's exit, SIGKILL 2 s later): polled, not slept for a fixed time.
  const alive = () => { try { process.kill(-group, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
  for (const until = Date.now() + 10000; alive() && Date.now() < until;) await new Promise(res => setTimeout(res, 50));
  assert.strictEqual(alive(), false, 'nothing in the harness\'s process group is left running');
  const n = fs.readFileSync(marker, 'utf8').length;
  await new Promise(res => setTimeout(res, 500));
  assert.strictEqual(fs.readFileSync(marker, 'utf8').length, n, 'the background loop was stopped');
});

test('full market session: trading runs through the night; the 16:00-18:00 ET break and weekends are closed', () => {
  const full = validateConfig({ harness: 'qwen', premarketAt: '' });
  const at = iso => decide(full, null, new Date(iso)).action;
  assert.strictEqual(at('2026-10-07T00:30:00Z'), 'trade', '20:30 ET (Asia)');
  assert.strictEqual(at('2026-10-07T08:00:00Z'), 'trade', '04:00 ET (London)');
  assert.strictEqual(at('2026-10-07T14:00:00Z'), 'trade', '10:00 ET (New York)');
  const done = { day: '2026-10-07', premarketDone: true, eodDone: true, cycles: 3, lastCycleAt: null };
  assert.strictEqual(decide(full, done, new Date('2026-10-07T21:00:00Z')).action, null, '17:00 ET: daily break, end of day done');
  assert.strictEqual(at('2026-10-10T20:30:00Z'), null, 'no end of day on a Saturday');
  assert.strictEqual(at('2026-10-07T22:05:00Z'), 'trade', '18:05 ET: the next trading day');
  assert.strictEqual(at('2026-10-10T15:00:00Z'), null, 'Saturday');
  assert.strictEqual(at('2026-10-11T21:00:00Z'), null, 'Sunday before the 18:00 ET open');
  assert.strictEqual(at('2026-10-11T22:30:00Z'), 'trade', 'Sunday 18:30 ET');
  // Sunday evening and Monday are one trading day, named Monday.
  const { dayKey } = require('../../scripts/lib/autotrader');
  assert.strictEqual(dayKey(new Date('2026-10-11T22:30:00Z')), '2026-10-12');
  assert.strictEqual(dayKey(new Date('2026-10-12T19:00:00Z')), '2026-10-12');
});

test('the default cycle cap covers the whole 22-hour session; the runner passes the exchange calendar to the gate', () => {
  assert.strictEqual(validateConfig({ harness: 'qwen', timeframe: 1 }).maxCyclesPerDay, 1330);
  assert.strictEqual(validateConfig({ harness: 'qwen', timeframe: 3 }).maxCyclesPerDay, 450);
  const { childEnv } = require('../../scripts/lib/autotrader');
  // The built-in CME calendar, plus the dates the config adds.
  const env = childEnv(validateConfig({ harness: 'qwen', closedDates: ['2028-04-14'], earlyCloseDates: ['2028-01-17'] }), '/r', {});
  assert.ok(env.FTH_CLOSED_DATES.split(',').includes('2026-12-25') && env.FTH_CLOSED_DATES.split(',').includes('2028-04-14'));
  assert.ok(env.FTH_EARLY_CLOSE_DATES.split(',').includes('2026-11-27') && env.FTH_EARLY_CLOSE_DATES.split(',').includes('2028-01-17'));
  const closed = validateConfig({ harness: 'qwen', premarketAt: '', closedDates: ['2026-12-25'] });
  assert.strictEqual(decide(closed, null, new Date('2026-12-25T15:00:00Z')).action, null, 'no cycles on a holiday');
});

test('a policy strategy\'s verdicts go into the cycle prompt as the only allowed entry', () => {
  const p = prompts(validateConfig({ account: '123' }), et(10, 0));
  const verdicts = [
    { strategy: 'prop_portfolio', component: 'supertrend', direction: 'long', action: 'full', contract: 'NQ', maxSize: 3, stopTicks: 40 },
    { strategy: 'prop_flow_1m', component: 'ofi', direction: 'short', action: 'skip', reason: 'the size budget is below one contract at this stop' },
  ];
  const text = p.trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00Z', c: 21500, file: '/b.json', contractId: 'MNQ' }, verdicts }]);
  assert.match(text, /prop_portfolio: long setup from supertrend, verdict full: enter only as setup:prop_portfolio, NQ buy, at most 3, stopLossBracket \{ticks: 40, type: "stop"\}/);
  assert.match(text, /prop_flow_1m: the short setup from ofi is skipped \(the size budget is below one contract at this stop\); no entry/);
});

test('the runner polls one contract per micro/mini index', () => {
  assert.throws(() => validateConfig({ symbols: ['MNQ', 'NQ'] }), /one contract per index/);
  assert.doesNotThrow(() => validateConfig({ symbols: ['MNQ', 'MES'] }));
});

test('every cycle prompt carries the account: balance, positions, orders, and each running prop attempt', () => {
  const p = prompts(validateConfig({ account: '123' }), et(10, 0));
  const attempts = [{
    account: 'topstep_100k', status: 'active', asOf: '2026-10-07T14:00:01.000Z', balance: 101250, floor: 98000, cushion: 3250, profit: 1250, target: 6000, dayPnl: -250, sessionsLeft: 26,
    budgets: [{ strategy: 'prop_portfolio', budgetUsd: 975 }], entryBlock: null,
  }];
  const state = { id: '123', at: '2026-10-07T14:00:01.000Z', balance: 101250, positions: [{ contractId: 'NQ', type: 1, size: 2, averagePrice: 21500.25 }], workingOrders: 1, attempts };
  const text = p.trade([{ symbol: 'MNQ' }], { state });
  assert.match(text, /Account 123 at 10:00 ET: balance \$101,250; open: NQ long 2 @ 21500.25; 1 working order\./);
  assert.match(text, /topstep_100k attempt \(active\): floor \$98,000, cushion \$3,250, profit \+\$1,250 of \$6,000, day -\$250, 26 sessions left; prop_portfolio size budget \$975\./);
  const flat = { ...state, positions: [], workingOrders: 0, attempts: [{ ...attempts[0], entryBlock: 'a position is open on the account' }] };
  assert.match(p.trade([{ symbol: 'MNQ' }], { state: flat }), /balance \$101,250; flat; 0 working orders\..*new entries blocked: a position is open on the account\./);
  assert.match(p.premarket('MNQ', { state }), /Account 123 .*balance \$101,250.*Run the premarket skill/);
  assert.match(p.eod({ state }), /Account 123 .*Run the end-of-day skill/);
  assert.match(p.trade([{ symbol: 'MNQ' }], { state: { id: '123', error: 'HTTP 503' } }), /Account 123: state unavailable \(HTTP 503\); read get_account_snapshot before deciding anything/);
  assert.doesNotMatch(p.trade([{ symbol: 'MNQ' }]), /Account|attempt/);
});

test('the account line says what it does not know, and formats every side and count', () => {
  const p = prompts(validateConfig({ account: '123' }), et(10, 0));
  const base = { id: '123', at: '2026-10-07T14:00:01.000Z', balance: 50000, workingOrders: 1, attempts: [] };
  const short = p.trade([{ symbol: 'MNQ' }], { state: { ...base, positions: [{ contractId: 'A', type: 2, size: 3, averagePrice: 21500 }, { contractId: 'B', type: 7, size: 1, averagePrice: 1 }] } });
  assert.match(short, /open: A short 3 @ 21500, B \? 1 @ 1; 1 working order\./);
  const unknown = p.trade([{ symbol: 'MNQ' }], { state: { ...base, balance: NaN, positions: null, workingOrders: null } });
  assert.match(unknown, /balance unknown; positions and working orders unknown \(read get_account_snapshot\)\./);
  assert.doesNotMatch(unknown, /\bflat\b|NaN|undefined/);
  const attempt = {
    account: 'topstep_50k', status: 'active', asOf: '2026-10-07T13:57:00.000Z', balance: 49750, floor: 48000, cushion: 1750, profit: -250, target: 3000, dayPnl: 0.3, sessionsLeft: 1, budgets: [],
  };
  const one = p.trade([{ symbol: 'MNQ' }], { state: { ...base, positions: [], attempts: [attempt] } });
  assert.match(one, /topstep_50k attempt \(active\) as of 09:57 ET, balance \$49,750: floor \$48,000, cushion \$1,750, profit -\$250 of \$3,000, day \$0, 1 session left\./);
  const none = p.trade([{ symbol: 'MNQ' }], { state: { ...base, positions: [], attempts: [{ account: 'topstep_50k', status: 'unknown', noBalance: true, entryBlock: 'the topstep_50k account snapshot is missing' }] } });
  assert.match(none, /topstep_50k attempt: no balance read yet, so no floor or cushion to show; new entries blocked: the topstep_50k account snapshot is missing\./);
  assert.doesNotMatch(none, /NaN|undefined/);
  const past = p.trade([{ symbol: 'MNQ' }], { state: { ...base, positions: [], attempts: [{ ...attempt, sessionsLeft: 0, sessionsDone: 32 }] } });
  assert.match(past, /32 sessions done, past the training length \(the attempt runs on until it passes or blows\)\./);
  assert.doesNotMatch(past, /0 sessions left/);
});

test('cycle history in the prompt: repeated results collapse into one, long ones are cut', () => {
  const { historyText } = require('../../scripts/lib/autotrader');
  const at = m => `2026-10-08T14:${String(m).padStart(2, '0')}:20.000Z`;
  const h = [
    ...[0, 3, 6, 9].map(m => ({ at: at(m), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - nothing fired' })),
    { at: at(12), symbols: ['MNQ'], result: `CYCLE RESULT: executed - orb long ${'x'.repeat(400)}` },
    { at: at(15), symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - nothing fired' },
  ];
  // Old-format entries (only at, symbols, result: a state saved before the decision facts) render with what they have.
  const t = historyText(h);
  assert.match(t, /Your last 6 cycle\(s\), oldest first, ET \(not facts; "since" is from bars closed by now\): 10:00-10:09 MNQ no-trade ×4: nothing fired \| 10:12 MNQ entered: orb long x+… \| 10:15 MNQ no-trade: nothing fired\. Don't flip-flop without a new reason\.$/);
  assert.ok(t.length < 400, `${t.length} chars`);
  assert.strictEqual(historyText([]), '');
});

test('a busy cycle prompt stays lean: every line is decision context, and the whole fits a budget', () => {
  // The prompt names the harness home: a fixed one, so the budget doesn't depend on who runs the tests.
  const savedHome = process.env.FTH_HOME;
  process.env.FTH_HOME = '/home/u/.fth';
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', symbols: ['MNQ'], timeframe: 3, account: 1 });
  const bars = Array.from({ length: 10 }, (_, k) => ({ t: new Date(Date.UTC(2026, 9, 8, 14, 3 * k)).toISOString(), o: 21500.25, h: 21510.75, l: 21490.5, c: 21505.25, v: 1234 }));
  const record = 'track record: backtest 214 trades: win 41%, E +0.18R, edge positive; in trend-up: 60 trades, E +0.31R; at 10:00 ET: 22 trades, E -0.05R; live: 12 reviewed, 5W/7L, E -0.1R (in trend-up: 6, E +0.2R)';
  const p = prompts(cfg, new Date('2026-10-08T14:33:20Z'), '/root/fth').trade([{
    symbol: 'MNQ',
    bar: {
      t: bars[9].t, c: 21505.25, file: '/root/.fth/bars/MNQ-3m.json', contractId: 'MNQ', recent: bars,
      trend: 'Trend rule: prevailing trend 4h up; trend strategies may not go short, reversal strategies (mtf: reversal) may.',
      day: 'MNQ day: opened 21480.25 inside the prior value area, gap -12.5 from the prior close (0.04 ADR); opening type open-auction; initial balance 21455-21520.25 (65.25 points, 0.22 ADR), extended 0 up and 0 down: inside the initial balance; range so far 65.25 of a 10-day average 290.4 (22% used).',
    },
    scan: [
      { name: 'orb', candidate: true, direction: 'long', signal: 'rules', confluence: { with: ['ema_cross'], against: [] }, record },
      { name: 'ema_cross', candidate: true, direction: 'long', signal: 'rules', confluence: { with: ['orb'], against: [] }, record },
    ],
  }], {
    state: { id: 1, at: '2026-10-08T14:33:20Z', balance: 50250, positions: [], workingOrders: 0, attempts: [] },
    history: Array.from({ length: 10 }, (_, k) => ({ at: new Date(Date.UTC(2026, 9, 8, 14, 3 * k, 20)).toISOString(), symbols: ['MNQ'], result: `CYCLE RESULT: no-trade - ${k % 4 === 3 ? `orb fired but the stop was over budget ${'and more '.repeat(40)}` : 'nothing fired'}` })),
    lessons: Array.from({ length: 6 }, (_, k) => `(0.${9 - k}) a lesson of about a hundred characters, as the instincts digest writes them, number ${k}`),
    trades: Array.from({ length: 10 }, (_, k) => (k % 2 ? 'orb long win +1.8R in trend-up' : 'ema_cross short loss -1.02R in range [mistake:chased]')),
  });
  // 4700: 4500 plus the required last-line instruction (RESULT_LINE, ~220 characters, with its plain-text rule).
  // 4900: the full cycle's roster (the roles the gate requires) is decision context too.
  // 4950: the load sentence names the two skills strategy-library was split into (an entry needs them loaded).
  // Still 4950 with "; also load htf-to-ltf" (ALSO_LOAD): the bar line's "use that file for the 3-minute timeframe
  // instead of fetching it" became "use that file; don't fetch 3-minute bars".
  // 5000: setup-judgment and trade-plan on the every-cycle load list (ALSO_LOAD: the gate's skills-at-entry; a head trader
  // that loads its own skills, Claude Code, was refused [skills-at-entry] without them; fix/confluence-not-vetoes).
  if (savedHome === undefined) delete process.env.FTH_HOME; else process.env.FTH_HOME = savedHome;
  assert.ok(p.length < 5000, `the prompt grew to ${p.length} characters`);
  // The context is there; the noise is not.
  for (const want of [/MNQ day: opened/, /orb long with ema_cross \[orb track record/, /Your last 10 cycle\(s\)/, /no-trade ×\d @|no-trade ×\d:/, /Your last 10 reviewed trade/, /Your recurring mistakes and lessons/]) assert.match(p, want);
  assert.doesNotMatch(p, /95% CI|not over|no 10-day average/);
});

test('the fired line names a running attempt\'s cited setup as the attempt\'s, cited in compose_check, its track record no reason to pass', () => {
  // The late-entry diagnosis: four skips of a fired S2 on "a rules candidate ... refused under the attempt" and on its
  // "no backtest recorded" track record; the setup trade_lifecycle cites is traded in the attempt (composed-reads citedSetup).
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', symbols: ['MNQ'], timeframe: 3, account: 1 });
  const bar = { t: '2026-10-08T14:30:00.000Z', c: 21505.25, file: '/b.json', contractId: 'MNQ' };
  const s2 = { name: 'momentum_continuation', status: 'active', candidate: true, direction: 'long', signal: 'rules', confluence: { with: [], against: [] }, record: 'track record: no backtest recorded (the user records one: backtest.js --record); live: no reviewed trades yet' };
  const p = prompts(cfg, new Date('2026-10-08T14:33:20Z'), '/r');
  const inAttempt = p.trade([{ symbol: 'MNQ', bar, scan: [s2], cited: ['momentum_continuation'] }]);
  assert.match(inAttempt, /MNQ fired on this bar \([^)]*\): momentum_continuation fired up \(long\): a setup in this attempt: cite it in compose_check \("momentum_continuation fired up", the trend rule's side\) \[track record: n\/a, not a reason to pass\]\./);
  assert.doesNotMatch(inAttempt, /no backtest recorded/);
  // Both fired: a cited setup and a strategy a verdict trades. The verdict sentence names only the latter, so no strategy
  // is told both "cite it" and "never as setup:<component>".
  const orb = { name: 'orb', status: 'active', candidate: true, direction: 'long', signal: 'rules', confluence: { with: [], against: [] } };
  const mixed = p.trade([{ symbol: 'MNQ', bar, scan: [s2, orb], cited: ['momentum_continuation'], verdicts: [{ strategy: 'prop_portfolio', component: 'orb', action: 'full' }] }]);
  assert.match(mixed, / orb is one of prop_portfolio's components: enter only as its verdict below says \(setup:prop_portfolio\), never as setup:<component>\./);
  assert.doesNotMatch(mixed, /These are prop_portfolio's components/);
  assert.match(mixed, /momentum_continuation fired up \(long\): a setup in this attempt/);
  // Only a verdict's components fired: the sentence as before.
  assert.match(p.trade([{ symbol: 'MNQ', bar, scan: [orb], cited: ['momentum_continuation'], verdicts: [{ strategy: 'prop_portfolio', component: 'orb', action: 'full' }] }]), / These are prop_portfolio's components:/);
  // Only the cited setup fired: no verdict sentence.
  assert.doesNotMatch(p.trade([{ symbol: 'MNQ', bar, scan: [s2], cited: ['momentum_continuation'], verdicts: [{ strategy: 'prop_portfolio', component: 'orb', action: 'full' }] }]), /components: enter only/);
  // Another lane's cited setup keeps its trend rule (runner-lanes: the roles read it as the briefing's).
  const lane = p.trade([{ symbol: 'MNQ', bar, scan: [{ ...s2, mtf: { longAllowed: true, shortAllowed: false } }], cited: ['momentum_continuation'], minutes: 1 }]);
  assert.match(lane, /momentum_continuation fired up \(long\) \(trend rule: allows\): a setup in this attempt/);
  // Outside an attempt (none cited), the line is as before, its track record shown.
  const outside = p.trade([{ symbol: 'MNQ', bar, scan: [s2] }]);
  assert.match(outside, /: momentum_continuation long \[momentum_continuation track record: no backtest recorded/);
});

test('the fired line shows the field values a candidate\'s rules read on the bar; one without fields is unchanged', () => {
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', symbols: ['MNQ'], timeframe: 3, account: 1 });
  const bar = { t: '2026-10-08T14:30:00.000Z', c: 21505.25, file: '/b.json', contractId: 'MNQ' };
  const rules = { short: [{ rule: 'field("a.b") >= 0.25', ok: true, values: { 'field("a.b")': 0.28571 } }, { rule: 'field("c") < 0', ok: true, values: { 'field("c")': -0.8191 } }], long: [{ rule: 'field("z") <= -0.25', ok: false, values: { 'field("z")': 9 } }] };
  const base = { name: 'flow', status: 'active', candidate: true, direction: 'short', signal: 'rules', confluence: { with: [], against: [] }, record: 'live 1W/0L' };
  const p = prompts(cfg, new Date('2026-10-08T14:33:20Z'), '/r');
  const withValues = p.trade([{ symbol: 'MNQ', bar, scan: [{ ...base, rules }] }]);
  assert.match(withValues, /MNQ fired on this bar \([^)]*\): flow short \(field\("a\.b"\)=0\.2857, field\("c"\)=-0\.8191\) \[flow live 1W\/0L\]\./);
  const without = p.trade([{ symbol: 'MNQ', bar, scan: [{ ...base, rules: { short: rules.short.map(({ rule, ok }) => ({ rule, ok })), long: [] } }] }]);
  assert.match(without, /: flow short \[flow live 1W\/0L\]\./);
  assert.strictEqual(withValues.length - without.length, ' (field("a.b")=0.2857, field("c")=-0.8191)'.length, 'only the values are added');
  assert.doesNotMatch(withValues, /field\("z"\)/, 'the other side\'s values are not the candidate\'s');
  // At most 6 values per candidate; the rest are counted.
  const many = { short: [{ rule: 'x', ok: true, values: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`field("f${k}")`, k])) }], long: [] };
  assert.match(p.trade([{ symbol: 'MNQ', bar, scan: [{ ...base, rules: many }] }]), /flow short \(field\("f0"\)=0, field\("f1"\)=1, field\("f2"\)=2, field\("f3"\)=3, field\("f4"\)=4, field\("f5"\)=5, \+2 more\) \[flow/);
});

test('the fired line: a paper strategy is marked, manage-only lists nothing, a policy\'s components point at its verdict', () => {
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', symbols: ['MNQ'], timeframe: 3, account: 1 });
  const bar = { t: '2026-10-08T14:30:00.000Z', c: 21505.25, file: '/b.json', contractId: 'MNQ' };
  const scan = [
    { name: 'value_area', status: 'paper', candidate: true, direction: 'short', signal: 'rules', confluence: { with: [], against: [] } },
    { name: 'orb', status: 'active', candidate: true, direction: 'long', signal: 'rules', confluence: { with: [], against: [] } },
  ];
  const p = prompts(cfg, new Date('2026-10-08T14:33:20Z'), '/r');
  const flat = p.trade([{ symbol: 'MNQ', bar, scan }]);
  assert.match(flat, /value_area short \(paper: plan only, the gate refuses a live entry\)/);
  assert.match(flat, /orb long(?! \(paper)/);
  const manage = p.trade([{ symbol: 'MNQ', bar, scan }], { manageOnly: true });
  // Manage-only is said once, in the instruction's mode; nothing that fired is listed.
  assert.doesNotMatch(manage, /value_area|orb long|fired on this bar/);
  assert.strictEqual(manage.match(/manage-only/g).length, 1, manage);
  const verdicts = [{ strategy: 'prop_portfolio', component: 'orb', direction: 'long', action: 'full', contract: 'MNQ', contractId: 'MNQ', maxSize: 3, stopTicks: 40 }];
  const prop = p.trade([{ symbol: 'MNQ', bar, scan, verdicts }]);
  assert.match(prop, /These are prop_portfolio's components: enter only as its verdict below says \(setup:prop_portfolio\), never as setup:<component>\./);
  assert.match(prop, /prop_portfolio: long setup from orb, verdict full: enter only as setup:prop_portfolio/);
});

test('a section that could not be built is named; positions without trade details are still listed', () => {
  const { prompts, validateConfig, accountText } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', symbols: ['MNQ'], timeframe: 3, account: 1 });
  const p = prompts(cfg, new Date('2026-10-08T14:33:20Z'), '/r').trade([{ symbol: 'MNQ' }], { unavailable: ['MNQ day context (boom)', 'the journal (EACCES)'] });
  assert.match(p, /Context unavailable this cycle \(not "none"\): MNQ day context \(boom\); the journal \(EACCES\)\./);
  assert.doesNotMatch(prompts(cfg, new Date(), '/r').trade([{ symbol: 'MNQ' }]), /Context unavailable/);
  const t = accountText({ id: 1, at: '2026-10-08T14:33:20Z', balance: 50000, positions: [{ contractId: 'MNQ', type: 1, size: 2, averagePrice: 21500 }], workingOrders: 1, openTradesError: 'bad order data' });
  assert.match(t, /1 open position \(below\); 1 working order\. Open positions: MNQ long 2 @ 21500 \(trade details unavailable this cycle: bad order data; read list_open_positions and list_open_orders\)\./);
});

test('the end-of-day prompt names the trading day it closes (a catch-up says so) and the timeframe to reconcile', () => {
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', symbols: ['MNQ'], timeframe: 3, account: 1 });
  const today = prompts(cfg, new Date('2026-10-08T19:50:30Z'), '/r').eod({ day: '2026-10-08' });
  assert.match(today, /end-of-day skill on account 1 for the trading day ending 2026-10-08, on 3-minute bars \(the reconcile tool with day 2026-10-08 and timeframe 3\): flatten/);
  assert.doesNotMatch(today, /catch-up/);
  const late = prompts(cfg, new Date('2026-10-09T13:00:00Z'), '/r').eod({ day: '2026-10-08' });
  assert.match(late, /for the trading day ending 2026-10-08 \(a catch-up: that day's end of day did not run; review and reconcile 2026-10-08, not today\)/);
});

test('the trade prompt says when the runner flattens, the cycles left when few, and what it cannot see', () => {
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const bar = { t: '2026-10-08T19:30:00.000Z', c: 21505.25, file: '/b.json', contractId: 'MNQ' };
  const cfg = validateConfig({ harness: 'qwen', premarketAt: '', symbols: ['MNQ'], timeframe: 3, account: 1, eodAt: '15:50@America/New_York' });
  const p = prompts(cfg, new Date('2026-10-08T19:33:20Z'), '/r'); // 15:33:20 ET
  const late = p.trade([{ symbol: 'MNQ', bar, scan: [] }], { cyclesLeft: 3 });
  assert.match(late, /End of day: the runner flattens every position at 15:50 ET \(in 17 min\); a trade must have room to work before then\./);
  assert.match(late, /3 more trade cycles today after this one, then manage-only\./);
  assert.match(p.trade([{ symbol: 'MNQ', bar, scan: [] }], { cyclesLeft: 0 }), /This is the last trade cycle today; after it, cycles only manage\./);
  assert.doesNotMatch(p.trade([{ symbol: 'MNQ', bar, scan: [] }], { cyclesLeft: 40 }), /trade cycles? today/, 'only when few');
  assert.doesNotMatch(p.trade([{ symbol: 'MNQ', bar, scan: [] }], { cyclesLeft: 0, manageOnly: true }), /last trade cycle/, 'manage-only already says it');
  // Lessons without reviews: no claim that there are no lessons; a failed read: no "none yet" at all.
  assert.match(p.trade([{ symbol: 'MNQ', bar, scan: [] }], { lessons: ['(0.6) wait for the IB'] }), / No reviewed trades in the journal yet\. Your recurring mistakes and lessons/);
  assert.doesNotMatch(p.trade([{ symbol: 'MNQ', bar, scan: [] }], { unavailable: ['your reviewed trades (bad)'] }), /No reviewed trades/);
  // No account configured, no journal entries: said, not silent.
  const noAcct = prompts(validateConfig({ harness: 'qwen', premarketAt: '', symbols: ['MNQ'], timeframe: 3 }), new Date('2026-10-08T14:33:20Z'), '/r').trade([{ symbol: 'MNQ', bar, scan: [] }]);
  assert.match(noAcct, /No account is configured: the runner reads no positions or orders/);
  assert.match(noAcct, /No reviewed trades in the journal yet, so no record of your own results, mistakes, or lessons\./);
  assert.doesNotMatch(p.trade([{ symbol: 'MNQ', bar, scan: [] }], { journalRead: false }), /No reviewed trades/, 'an unread journal is named in the unavailable line instead');
  // A position on a symbol whose bar didn't close: the instruction covers it.
  assert.match(p.trade([{ symbol: 'MNQ', bar, scan: [] }], { manageAlso: ['MES'] }), /run the trade-session skill for MNQ, and manage the open MES position \(no bar closed for it this cycle\) on account 1/);
  // A failed policy screen: no verdict, no entry.
  const scan = [{ name: 'orb', status: 'active', candidate: true, direction: 'long', signal: 'rules', confluence: { with: [], against: [] } }];
  // A failed screen is named once (in the unavailable line); the fired line only marks them as not entries.
  const failedScreen = p.trade([{ symbol: 'MNQ', bar, scan, notEntries: ['orb'] }], { unavailable: ['MNQ policy screen (attempt file unreadable): no verdict, so no entry for orb this bar'] });
  assert.match(failedScreen, /orb long \(its policy has no verdict this bar: not an entry\)\./);
  assert.strictEqual(failedScreen.match(/no verdict, so no entry/g).length, 1, 'the reason, once');
  assert.doesNotMatch(failedScreen, /The policy screen failed this bar/);
  // Verdicts name their symbol (two symbols can each have one).
  const verdicts = [{ strategy: 'prop_portfolio', component: 'orb', direction: 'long', action: 'skip', reason: 'cushion' }];
  assert.match(p.trade([{ symbol: 'MES', bar, scan, verdicts }]), / MES prop_portfolio: the long setup from orb is skipped \(cushion\); no entry\./);
  // Formatting: one sentence for the trend line; a plan without a full stop gets one; the bar's close is not repeated.
  const f = p.trade([{ symbol: 'MNQ', bar: { ...bar, trend: 'Trend rule: up; trend strategies may not go short.', plan: 'MNQ premarket plan (09:05 ET): bias long' }, scan: [] }]);
  assert.match(f, /MNQ Trend rule: up; trend strategies may not go short \(recorded for the order gate, which enforces it\)\. MNQ premarket plan \(09:05 ET\): bias long\. /);
  assert.match(f, /a 3-minute bar just closed \(opened 15:30 ET\);/);
});

test('CLI: the runner decides on the harness clock: a replay broker\'s FTH_REPLAY_NOW, refused with a live broker', () => {
  const dir = tmpDir();
  const config = path.join(dir, 'auto.json');
  fs.writeFileSync(config, JSON.stringify({ harness: 'custom', command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), '{prompt}'] }));
  fs.writeFileSync(path.join(dir, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'sim.js'], replay: true } } }));
  const cli = path.join(ROOT, 'scripts', 'autotrader.js');
  const env = { PATH: process.env.PATH, HOME: dir, FTH_HOME: dir, FTH_KILL_SWITCH_FILE: path.join(dir, 'STOP') };
  const at = (now, extra = {}) => spawnSync(process.execPath, [cli, '--config', config, '--dry-run'], { encoding: 'utf8', env: { ...env, FTH_REPLAY_NOW: now, ...extra } });
  const premarket = at('2026-10-07T12:00:00Z'); // Wednesday 08:00 ET
  assert.strictEqual(premarket.status, 0, premarket.stderr);
  const weekend = at('2026-10-10T15:00:00Z'); // Saturday
  assert.strictEqual(weekend.status, 0, weekend.stderr);
  assert.notStrictEqual(premarket.stdout, weekend.stdout, 'the action depends on the replayed time');
  assert.match(weekend.stdout, /next action now: none/);
  const LIVE = shippedBroker().name; // the live broker the repo ships (mcp-configs/brokers.json)
  const live = at('2026-10-07T12:00:00Z', { FTH_BROKER: LIVE });
  assert.strictEqual(live.status, 1);
  assert.ok(live.stderr.includes(`FTH_REPLAY_NOW is set but the selected broker "${LIVE}" is not a replay broker`), live.stderr);
  // The live loop too: refused before the lock, the broker, or the first cycle.
  const loop = spawnSync(process.execPath, [cli, '--config', config], { encoding: 'utf8', env: { ...env, FTH_BROKER: LIVE, FTH_REPLAY_NOW: '2026-10-07T12:00:00Z' }, timeout: 20000 });
  assert.strictEqual(loop.status, 1);
  assert.ok(loop.stderr.includes(`FTH_REPLAY_NOW is set but the selected broker "${LIVE}" is not a replay broker`), loop.stderr);
  // --once: the prompt is dated by the replayed clock; end of day still runs, at the wall clock, when the override is refused.
  const once = (now, extra = {}) => spawnSync(process.execPath, [cli, '--config', config, '--once', 'eod', '--dry-run'], { encoding: 'utf8', env: { ...env, FTH_REPLAY_NOW: now, ...extra } });
  const replayedEod = once('2026-03-04T20:30:00Z');
  assert.strictEqual(replayedEod.status, 0, replayedEod.stderr);
  assert.match(replayedEod.stdout, /trading day ending 2026-03-04/);
  const refusedEod = once('2026-03-04T20:30:00Z', { FTH_BROKER: LIVE });
  assert.strictEqual(refusedEod.status, 0, refusedEod.stderr);
  assert.doesNotMatch(refusedEod.stdout, /2026-03-04/, 'the wall clock\'s day');
  const premarketOnce = spawnSync(process.execPath, [cli, '--config', config, '--once', 'premarket', '--symbol', 'MNQ', '--dry-run'], { encoding: 'utf8', env: { ...env, FTH_REPLAY_NOW: '2026-03-04T12:00:00Z' } });
  assert.match(premarketOnce.stdout, /premarket skill for MNQ.*trading day ending 2026-03-04/);
  assert.strictEqual(spawnSync(process.execPath, [cli, '--config', config, '--once', 'trade', '--dry-run'], { encoding: 'utf8', env: { ...env, FTH_REPLAY_NOW: '2026-03-04T20:30:00Z', FTH_BROKER: LIVE } }).status, 1, 'any other run is refused');
  const garbage = at('soon');
  assert.strictEqual(garbage.status, 1);
  assert.match(garbage.stderr, /not an ISO 8601 UTC time/);
});

test('CLI: the runner never takes the test suite\'s FTH_TEST_NOW, keeps its state on the replayed day, and refuses its loop with FTH_REPLAY_NOW', () => {
  const dir = tmpDir();
  const config = path.join(dir, 'auto.json');
  fs.writeFileSync(config, JSON.stringify({ harness: 'custom', command: ['true', '{prompt}'] }));
  fs.writeFileSync(path.join(dir, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['node', 'sim.js'], replay: true } } }));
  const cli = path.join(ROOT, 'scripts', 'autotrader.js');
  const env = { PATH: process.env.PATH, HOME: dir, FTH_HOME: dir, FTH_KILL_SWITCH_FILE: path.join(dir, 'STOP') };
  const run = (extra, args = ['--dry-run']) => spawnSync(process.execPath, [cli, '--config', config, ...args], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 20000 });
  // Wednesday 08:00 ET is premarket on the replayed clock; the test clock at that time is ignored (a live runner).
  assert.match(run({ FTH_REPLAY_NOW: '2026-10-07T12:00:00Z' }).stdout, /next action now: premarket/);
  // Ignored whatever the real time: two test clocks with different next actions (Wednesday 08:00 ET premarket,
  // Saturday with the market closed) give the same answer, the live clock's.
  const actionAt = t => (/next action now: (\S+)/.exec(run({ NODE_ENV: 'test', FTH_TEST_NOW: t }).stdout) || [])[1];
  const atPremarket = actionAt('2026-10-07T12:00:00Z');
  assert.ok(atPremarket, 'the runner says its next action');
  assert.strictEqual(actionAt('2026-10-10T15:00:00Z'), atPremarket);
  // An unreadable state file: manage-only for the rest of the replayed day (not a new day's premarket).
  fs.writeFileSync(path.join(dir, 'autotrader-state.json'), '{ broken');
  assert.match(run({ FTH_REPLAY_NOW: '2026-10-07T12:00:00Z' }).stdout, /next action now: manage/);
  fs.unlinkSync(path.join(dir, 'autotrader-state.json'));
  // The long-running loop: refused before the lock, the broker, or a cycle.
  const loop = run({ FTH_REPLAY_NOW: '2026-10-07T12:00:00Z' }, []);
  assert.strictEqual(loop.status, 1);
  assert.match(loop.stderr, /FTH_REPLAY_NOW is set: the runner loop never runs on a replayed clock.*--once or --dry-run/);
  assert.ok(!fs.existsSync(path.join(dir, 'autotrader.lock')) && !fs.existsSync(path.join(dir, 'logs')), 'nothing started');
});

test('opencode: validated, run headless with JSON events in the workspace it names, the model only when set', () => {
  const oc = validateConfig({ harness: 'opencode' });
  assert.deepStrictEqual(buildCommand(oc, 'PROMPT', '/fth'), ['opencode', 'run', '--format', 'json', '--dir', '/fth/workspace', '--agent', 'fth-head-trader', 'PROMPT']);
  const withModel = buildCommand(validateConfig({ harness: 'opencode', model: 'local/some-model', extraArgs: ['--variant', 'high'] }), 'PROMPT', '/fth');
  assert.deepStrictEqual(withModel.slice(8), ['--model', 'local/some-model', '--variant', 'high', 'PROMPT']);
  assert.ok(!buildCommand(oc, 'P', '/fth').some(a => /^--(auto|attach)/.test(a)), 'never auto-approve');
  assert.strictEqual(buildCommand(validateConfig({ harness: 'opencode', workdir: '/srv/ws' }), 'P', '/fth')[5], '/srv/ws');
  assert.throws(() => validateConfig({ harness: 'opencode', model: 'local-model' }), /<provider>\/<model>/);
  for (const extraArgs of [['--auto'], ['--auto=true'], ['--yolo'], ['--dangerously-skip-permissions'], ['--attach', 'http://localhost:4096'], ['--dir', '/x'], ['--agent', 'build']]) {
    assert.throws(() => validateConfig({ harness: 'opencode', extraArgs }), /extraArgs: not --/, extraArgs.join(' '));
  }
  // Another harness's flags of the same name are its own business.
  assert.ok(validateConfig({ harness: 'custom', command: ['x', '{prompt}', '--auto'] }));
});

test('opencode: the run config the runner hands opencode (OPENCODE_CONFIG_CONTENT) caps every role\'s steps but the order role\'s and the head trader\'s, in both modes, live and in a replay', () => {
  const steps = require('../../scripts/lib/tunables').runner().limits.roleSteps;
  for (const extra of [{}, { FTH_ROLE_SKILLS: 'full' }, { FTH_REPLAY_NOW: '2026-10-07T14:03:02Z' }]) {
    const run = JSON.parse(childEnv(validateConfig({ harness: 'opencode', dataDir: '/data/bars' }), path.resolve(__dirname, '..', '..'), { FTH_HOME: '/srv/fth', ...extra }).OPENCODE_CONFIG_CONTENT);
    for (const r of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager']) assert.strictEqual(run.agent[r].steps, steps, `${r} ${JSON.stringify(extra)}`);
    assert.strictEqual(run.agent['trade-executor'].steps, undefined, `the order role is never capped ${JSON.stringify(extra)}`);
    assert.strictEqual(run.agent['fth-head-trader'].steps, undefined, `the head trader is not capped ${JSON.stringify(extra)}`);
  }
});

test('the runner tells the run which roles its cycle must launch (FTH_CYCLE_DESK): a full trade cycle\'s roster less the cached; none for lean, manage-only, paper or another action', () => {
  const full = validateConfig({ harness: 'opencode', dataDir: '/data/bars' });
  const desk = (cfg, context) => childEnv(cfg, '/r', { FTH_HOME: '/srv/fth' }, context).FTH_CYCLE_DESK;
  assert.strictEqual(desk(full, { action: 'trade', symbols: [] }), 'market-structure-analyst,trend-momentum-analyst,volume-liquidity-analyst,risk-manager');
  assert.strictEqual(desk(full, { action: 'trade', cachedRoles: ['risk-manager', 'trend-momentum-analyst'], symbols: [] }), 'market-structure-analyst,volume-liquidity-analyst');
  assert.strictEqual(desk(full, { action: 'trade', manageOnly: true, symbols: [] }), undefined);
  assert.strictEqual(desk(full, { action: 'premarket', symbols: [] }), undefined);
  assert.strictEqual(desk(validateConfig({ harness: 'opencode', cycle: 'lean' }), { action: 'trade', symbols: [] }), undefined);
  assert.strictEqual(desk(validateConfig({ harness: 'opencode', paper: true }), { action: 'trade', symbols: [] }), undefined);
  assert.strictEqual(childEnv(full, '/r', { FTH_HOME: '/srv/fth', FTH_CYCLE_DESK: 'stale' }, { action: 'eod' }).FTH_CYCLE_DESK, undefined, 'a stale value is never inherited');
});

test('the runner gives the head trader its role record (FTH_CYCLE_ROLES): the roles it ran are no launch the cycle owes and no cached report; never inherited', () => {
  const full = validateConfig({ harness: 'opencode', dataDir: '/data/bars' });
  const env = (context, base = {}) => childEnv(full, '/r', { FTH_HOME: '/srv/fth', ...base }, context);
  const ran = { action: 'trade', symbols: [], runnerRoles: ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'], rolesFile: '/srv/fth/logs/cycle-roles-1.jsonl' };
  const e = env(ran);
  assert.strictEqual(e.FTH_CYCLE_ROLES, '/srv/fth/logs/cycle-roles-1.jsonl');
  assert.strictEqual(e.FTH_CYCLE_DESK, undefined, 'the runner ran the whole desk: nothing left to launch');
  assert.strictEqual(e.FTH_CYCLE_CACHED, undefined, 'a role the runner ran is no cached report');
  assert.strictEqual(env({ ...ran, runnerRoles: ['risk-manager'], cachedRoles: ['market-structure-analyst'] }).FTH_CYCLE_DESK, 'trend-momentum-analyst,volume-liquidity-analyst');
  // Without the record the roles aren't credited: the cycle still owes them; a stale file is never inherited.
  assert.strictEqual(env({ ...ran, rolesFile: null }).FTH_CYCLE_DESK, 'market-structure-analyst,trend-momentum-analyst,volume-liquidity-analyst,risk-manager');
  assert.strictEqual(env({ action: 'trade', symbols: [] }, { FTH_CYCLE_ROLES: '/stale' }).FTH_CYCLE_ROLES, undefined);
  const { deniedRoles } = require('../../scripts/lib/autotrader');
  assert.deepStrictEqual(deniedRoles(ran), ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'strategy-researcher'], 'the analysts it ran are not launched again; risk-manager stays, for phase 2');
  assert.deepStrictEqual(deniedRoles({ ...ran, rolesFile: null }), ['strategy-researcher']);
});

test('the runner\'s opencode plugin holds compose_check until the desk reported (a role launch that returned, by the after hook), and holds nothing else', async () => {
  const saved = process.env.FTH_CYCLE_DESK;
  process.env.FTH_CYCLE_DESK = 'market-structure-analyst,risk-manager';
  try {
    delete require.cache[require.resolve('../../scripts/opencode-plugin')];
    const hooks = await require('../../scripts/opencode-plugin').server({}, {});
    const compose = () => hooks['tool.execute.before']({ tool: 'harness_compose_check', sessionID: 'h', callID: 'c' }, { args: { symbol: 'MNQ' } });
    await assert.rejects(compose(), /\[desk\] .*launch market-structure-analyst, risk-manager first/);
    await assert.doesNotReject(hooks['tool.execute.before']({ tool: 'task', sessionID: 'h', callID: 'x' }, { args: { subagent_type: 'trade-executor' } }), 'the executor is never held');
    for (const r of ['market-structure-analyst', 'risk-manager']) await hooks['tool.execute.after']({ tool: 'task', sessionID: 'h', callID: r, args: { subagent_type: r } }, { output: 'report' });
    await assert.doesNotReject(compose());
  } finally {
    if (saved === undefined) delete process.env.FTH_CYCLE_DESK; else process.env.FTH_CYCLE_DESK = saved;
  }
});

test('opencode: the run\'s environment locks it down and lets it read the runner\'s directories', () => {
  const env = childEnv(validateConfig({ harness: 'opencode', dataDir: '/data/bars' }), '/r', { FTH_HOME: '/srv/fth', PWD: '/elsewhere', OPENCODE_PERMISSION: '{"*":"allow"}', OPENCODE_DISABLE_PROJECT_CONFIG: '1' });
  assert.deepStrictEqual([env.FTH_ROOT, env.FTH_AUTONOMOUS, env.PWD], ['/r', '1', '/r/workspace']);
  assert.ok(!('OPENCODE_PERMISSION' in env) && !('OPENCODE_DISABLE_PROJECT_CONFIG' in env));
  for (const k of ['OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_SHARE', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_EXTERNAL_SKILLS']) assert.strictEqual(env[k], '1');
  const run = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepStrictEqual(Object.keys(run.permission.external_directory), ['*', '/r/*', '/data/bars/*', '/srv/fth/logs/*', '/srv/fth/bars-scratch/*']);
  assert.strictEqual(run.permission.bash, 'deny');
  assert.strictEqual(run.agent['risk-manager'].permission.external_directory['/data/bars/*'], 'allow');
  // Index mode (the default) denies the roles holding skill_lookup and the head trader (its skills are in its prompt:
  // head-prompt.js) opencode's skill tool; the head trader reads any other with skill_lookup. Full mode keeps the tool.
  assert.deepStrictEqual([run.agent['risk-manager'].permission.skill, run.agent['fth-head-trader'].permission.skill, run.permission.skill], ['deny', 'deny', 'deny']);
  assert.deepStrictEqual([run.agent['fth-head-trader'].permission.harness_skill_lookup, run.permission.harness_skill_lookup], ['allow', 'allow']);
  const full = JSON.parse(childEnv(validateConfig({ harness: 'opencode', dataDir: '/data/bars' }), '/r', { FTH_HOME: '/srv/fth', FTH_ROLE_SKILLS: 'full' }).OPENCODE_CONFIG_CONTENT);
  assert.deepStrictEqual([full.agent['risk-manager'].permission.skill, full.agent['fth-head-trader'].permission.skill, full.permission.skill], ['allow', 'allow', 'allow']);
  assert.strictEqual(full.agent['fth-head-trader'].permission.harness_skill_lookup, 'deny');
  // Other harnesses get none of it.
  assert.ok(!Object.keys(childEnv(validateConfig({ harness: 'claude' }), '/r', {})).some(k => k.startsWith('OPENCODE_')));
});

test('opencode in index mode: the runner attests the head trader\'s embedded skills from the run\'s opencode.json; never otherwise, never inherited', () => {
  const H = require('../../scripts/lib/head-prompt');
  const home = tmpDir();
  // The repository's own workspace: the committed, index-mode file.
  const env = childEnv(validateConfig({ harness: 'opencode' }), ROOT, { FTH_HOME: home, FTH_HEAD_PROMPT: 'stale' });
  const att = H.parseAttestation(env.FTH_HEAD_PROMPT);
  assert.ok(att, env.FTH_HEAD_PROMPT);
  assert.strictEqual(att.config, path.join(ROOT, 'workspace', 'opencode.json'));
  assert.deepStrictEqual(att.skills, H.CORE);
  assert.strictEqual(att.sha256, H.sha256(JSON.parse(fs.readFileSync(att.config, 'utf8')).agent['fth-head-trader'].prompt));
  // Full mode, a workspace without the file (or with a full-mode one), and every other harness: none, an inherited value dropped.
  assert.ok(!('FTH_HEAD_PROMPT' in childEnv(validateConfig({ harness: 'opencode' }), ROOT, { FTH_HOME: home, FTH_ROLE_SKILLS: 'full', FTH_HEAD_PROMPT: JSON.stringify(att) })));
  assert.ok(!('FTH_HEAD_PROMPT' in childEnv(validateConfig({ harness: 'opencode' }), '/r', { FTH_HOME: home, FTH_HEAD_PROMPT: JSON.stringify(att) })));
  const fullDir = tmpDir();
  fs.mkdirSync(path.join(fullDir, 'workspace'));
  fs.writeFileSync(path.join(fullDir, 'workspace', 'opencode.json'), require('../../scripts/lib/harness-sync').expectedFiles(ROOT, { mode: 'full' })['workspace/opencode.json']);
  assert.ok(!('FTH_HEAD_PROMPT' in childEnv(validateConfig({ harness: 'opencode' }), fullDir, { FTH_HOME: home })), 'a full-mode file embeds nothing for the head trader');
  for (const harness of ['claude', 'codex', 'qwen']) assert.ok(!('FTH_HEAD_PROMPT' in childEnv(validateConfig({ harness }), ROOT, { FTH_HOME: home, FTH_HEAD_PROMPT: JSON.stringify(att) })), harness);
});

test('the cycle prompt: opencode in index mode says the skills are in the head trader\'s prompt; every other harness and full mode load them', () => {
  const { embedsSkills } = require('../../scripts/lib/autotrader');
  const { REQUIRED_FOR_COMPOSED: REQUIRED_FOR_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  const items = [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }];
  const now = new Date('2026-10-07T14:30:00Z');
  const saved = process.env.FTH_ROLE_SKILLS;
  try {
    delete process.env.FTH_ROLE_SKILLS;
    const oc = prompts(validateConfig({ harness: 'opencode' }), now).trade(items);
    assert.strictEqual(embedsSkills(validateConfig({ harness: 'opencode' })), true);
    assert.match(oc, /Your skills trade-session, multi-timeframe-analysis, trade-lifecycle, htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context are in your prompt, already loaded \(don't load them again\): decide by them, then run the trade-session skill for MNQ/);
    assert.doesNotMatch(oc, /With your skill tool, load/);
    for (const s of REQUIRED_FOR_ENTRY) assert.ok(oc.includes(s), s);
    // Only on the attestation the runner gives the gate (headAttestation): a workspace without the file, or whose head
    // prompt leaves out a skill the sentence names, gets the load sentence, never "already loaded".
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'workspace'));
    const loads = /With your skill tool, load trade-session, [^.]* setup-judgment, trade-plan, and day-context before deciding, then run the trade-session skill/;
    assert.match(prompts(validateConfig({ harness: 'opencode' }), now, root).trade(items), loads, 'no opencode.json');
    fs.symlinkSync(path.join(ROOT, 'skills'), path.join(root, 'skills'));
    const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'opencode.json'), 'utf8'));
    fs.writeFileSync(path.join(root, 'workspace', 'opencode.json'), JSON.stringify(json));
    assert.match(prompts(validateConfig({ harness: 'opencode' }), now, root).trade(items), /are in your prompt, already loaded/, 'the same file, another root');
    json.agent['fth-head-trader'].prompt = json.agent['fth-head-trader'].prompt.replace('<skill name="htf-to-ltf">', '<skill name="htf-to-ltf-x">');
    fs.writeFileSync(path.join(root, 'workspace', 'opencode.json'), JSON.stringify(json));
    assert.strictEqual(embedsSkills(validateConfig({ harness: 'opencode' }), root), false, 'htf-to-ltf not embedded');
    assert.match(prompts(validateConfig({ harness: 'opencode' }), now, root).trade(items), loads, 'partial');
    process.env.FTH_ROLE_SKILLS = 'full';
    assert.match(prompts(validateConfig({ harness: 'opencode' }), now).trade(items), /With your skill tool, load trade-session, [^.]* setup-judgment, trade-plan, and day-context before deciding, then run the trade-session skill/);
    delete process.env.FTH_ROLE_SKILLS;
    for (const harness of ['claude', 'qwen']) assert.match(prompts(validateConfig({ harness }), now).trade(items), /With your skill tool, load trade-session, [^.]* setup-judgment, trade-plan, and day-context before deciding, then run/, harness);
    assert.match(prompts(validateConfig({ harness: 'codex' }), now).trade(items), /Read the skills trade-session, [^.]* setup-judgment, trade-plan, and day-context before deciding, then run/);
  } finally {
    if (saved === undefined) delete process.env.FTH_ROLE_SKILLS; else process.env.FTH_ROLE_SKILLS = saved;
  }
});

test('cycleResult: opencode\'s final text counts; one followed by more work, thinking, or a look-alike JSON line does not', () => {
  const ev = (type, part) => JSON.stringify({ type, timestamp: 1, sessionID: 's', part });
  const text = t => ev('text', { type: 'text', text: t, time: { start: 1, end: 2 } });
  const call = ev('tool_use', { type: 'tool', tool: 'harness_strategies_scan', state: { status: 'completed', input: {} } });
  assert.strictEqual(cycleResult([ev('step_start', { type: 'step-start' }), call, text('CYCLE RESULT: no-trade - nothing fired'), ev('step_finish', { type: 'step-finish', reason: 'stop' })].join('\n')), 'CYCLE RESULT: no-trade - nothing fired');
  // Text, then the model went on (a tool call or a new step) and was cut short: no result.
  assert.strictEqual(cycleResult([text('CYCLE RESULT: no-trade - early'), call].join('\n')), null);
  assert.strictEqual(cycleResult([text('CYCLE RESULT: no-trade - early'), ev('step_start', { type: 'step-start' })].join('\n')), null);
  // Reasoning and text opencode added itself are not the model's answer.
  assert.strictEqual(cycleResult([call, ev('reasoning', { type: 'reasoning', text: 'CYCLE RESULT: executed - thinking' })].join('\n')), null);
  assert.strictEqual(cycleResult([call, ev('text', { type: 'text', text: 'CYCLE RESULT: executed - injected', synthetic: true })].join('\n')), null);
  // The prompt's template is no result; an error event alone is a transcript with none.
  assert.strictEqual(cycleResult(text('CYCLE RESULT: <no-trade | planned> - <reason>')), null);
  assert.strictEqual(cycleResult(JSON.stringify({ type: 'error', timestamp: 1, sessionID: 's', error: { name: 'ProviderError' } })), null);
  // A plain-text run's echoed JSON with type "text" (no opencode envelope) never hides its result line.
  assert.strictEqual(cycleResult(`${JSON.stringify({ type: 'text', text: 'echo' })}\nCYCLE RESULT: managed - trailed the stop`), 'CYCLE RESULT: managed - trailed the stop');
  // The final step's text parts together: a whitespace part after the line, or one split around reasoning.
  assert.strictEqual(cycleResult([call, text('CYCLE RESULT: no-trade - quiet'), text('\n\n')].join('\n')), 'CYCLE RESULT: no-trade - quiet');
  assert.strictEqual(cycleResult([call, text('Done.'), ev('reasoning', { type: 'reasoning', text: 'x' }), text('CYCLE RESULT: planned - orb')].join('\n')), 'CYCLE RESULT: planned - orb');
  // Warning lines between events are skipped.
  assert.strictEqual(cycleResult(`INFO starting\n${call}\n! permission requested: webfetch; auto-rejecting\n${text('Done.\nCYCLE RESULT: blocked - gate refused')}`), 'CYCLE RESULT: blocked - gate refused');
});

test('the workspace guard fingerprints opencode\'s config and any .opencode folder (agents, plugins, packages)', () => {
  const { workspaceFingerprint, changedFiles, TRUSTED_WORKSPACE_FILES } = require('../../scripts/lib/harness-run');
  assert.ok(TRUSTED_WORKSPACE_FILES.includes('opencode.json') && TRUSTED_WORKSPACE_FILES.includes('opencode.jsonc'));
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'opencode.json'), '{"permission":{"*":"deny"}}');
  const before = workspaceFingerprint(dir);
  assert.strictEqual(before['.opencode/'], null, 'absent');
  assert.deepStrictEqual(changedFiles(before, workspaceFingerprint(dir)), []);
  fs.writeFileSync(path.join(dir, 'opencode.json'), '{"permission":{"*":"allow"}}');
  assert.deepStrictEqual(changedFiles(before, workspaceFingerprint(dir)), ['opencode.json']);
  fs.writeFileSync(path.join(dir, 'opencode.json'), '{"permission":{"*":"deny"}}');
  fs.writeFileSync(path.join(dir, 'opencode.jsonc'), '{}');
  assert.deepStrictEqual(changedFiles(before, workspaceFingerprint(dir)), ['opencode.jsonc']);
  fs.unlinkSync(path.join(dir, 'opencode.jsonc'));
  // A .opencode folder, and anything changed under it, nested or a link.
  fs.mkdirSync(path.join(dir, '.opencode', 'plugins'), { recursive: true });
  const created = workspaceFingerprint(dir);
  assert.deepStrictEqual(changedFiles(before, created), ['.opencode/']);
  fs.writeFileSync(path.join(dir, '.opencode', 'plugins', 'x.js'), 'export default async () => ({})');
  const plugin = workspaceFingerprint(dir);
  assert.deepStrictEqual(changedFiles(created, plugin), ['.opencode/']);
  fs.writeFileSync(path.join(dir, '.opencode', 'plugins', 'x.js'), 'export default async () => ({ x: 1 })');
  assert.deepStrictEqual(changedFiles(plugin, workspaceFingerprint(dir)), ['.opencode/']);
  fs.symlinkSync('/etc', path.join(dir, '.opencode', 'link'));
  const linked = workspaceFingerprint(dir);
  assert.notStrictEqual(linked['.opencode/'], plugin['.opencode/']);
  fs.rmSync(path.join(dir, '.opencode'), { recursive: true });
  assert.deepStrictEqual(changedFiles(before, workspaceFingerprint(dir)), []);
});

test('runHarness writes the live transcript as the run streams it: a fresh file, stdout only, readable before the run ends, removed after', async () => {
  const { runHarness } = require('../../scripts/lib/harness-run');
  const fs = require('fs');
  const path = require('path');
  const dir = require('../helpers').tmpDir();
  const live = path.join(dir, 'logs', 'cycle-transcript.jsonl');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, 'stale line left at this path\n');
  const seen = path.join(dir, 'seen.txt');
  // The child prints a line, then (still running) copies the live file as a gate would read it, then ends.
  const script = `echo '{"a":1}'; sleep 0.5; cat ${JSON.stringify(live)} > ${JSON.stringify(seen)}; echo oops >&2; echo '{"b":2}'`;
  const r = await runHarness(['bash', '-c', script], { cwd: dir, env: process.env, timeoutMs: 10000, liveFile: live });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(seen, 'utf8'), '{"a":1}\n', 'mid-run: the first line only (stderr is not the transcript), the leftover gone');
  assert.ok(!fs.existsSync(live), 'removed once the run ended (the cycle log keeps the transcript)');
  assert.match(r.output, /\{"b":2\}/);
  // The stdout alone (what the runner records reports from, as the gate reads it): no stderr in it.
  assert.strictEqual(r.stdout, `{"a":1}\n{"b":2}\n`);
  assert.match(r.output, /oops/);
  // Without a live file nothing is written.
  const r2 = await runHarness(['bash', '-c', 'echo x'], { cwd: dir, env: process.env, timeoutMs: 10000 });
  assert.strictEqual(r2.ok, true);
});

test('runHarness with a signal: aborted mid-run, the run is stopped (its group killed) and resolves not ok, cancelled; aborted before it starts, the same; never aborted, as without one', async () => {
  const { runHarness } = require('../../scripts/lib/harness-run');
  const dir = require('../helpers').tmpDir();
  const ac = new AbortController();
  const t0 = Date.now();
  const p = runHarness(['bash', '-c', 'echo started; sleep 30; echo never'], { cwd: dir, env: process.env, timeoutMs: 60000, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  const r = await p;
  assert.deepStrictEqual([r.ok, r.cancelled, r.timedOut], [false, true, false]);
  assert.ok(Date.now() - t0 < 10000, 'stopped, not waited out');
  assert.doesNotMatch(r.output, /never/);
  assert.match(r.output, /run cancelled/);
  const pre = new AbortController();
  pre.abort();
  const r2 = await runHarness(['bash', '-c', 'sleep 30'], { cwd: dir, env: process.env, timeoutMs: 60000, signal: pre.signal });
  assert.deepStrictEqual([r2.ok, r2.cancelled], [false, true]);
  const r3 = await runHarness(['bash', '-c', 'echo x'], { cwd: dir, env: process.env, timeoutMs: 10000, signal: new AbortController().signal });
  assert.deepStrictEqual([r3.ok, r3.cancelled], [true, undefined]);
});

test('cycleOutcome: what a cycle hands the runner - the transcript is the standard output alone, never stderr', () => {
  const res = { ok: true, timedOut: false, code: 0, output: '{"a":1}\nwarning on stderr\nCYCLE RESULT: no-trade - x\n', stdout: '{"a":1}\nCYCLE RESULT: no-trade - x\n' };
  assert.deepStrictEqual(cycleOutcome(res, { result: 'CYCLE RESULT: no-trade - x', intact: true, action: 'trade' }),
    { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x', code: 0, transcript: '{"a":1}\nCYCLE RESULT: no-trade - x\n', lookups: [] });
  assert.strictEqual(cycleOutcome({ ...res, stdout: undefined }, { intact: true, action: 'trade' }).transcript, '');
  // The workspace guard tripped: a trade cycle failed, an end of day that ran still did its job.
  assert.strictEqual(cycleOutcome(res, { intact: false, action: 'trade' }).ok, false);
  assert.strictEqual(cycleOutcome(res, { intact: false, action: 'eod' }).ok, true);
  assert.strictEqual(cycleOutcome({ ...res, ok: false }, { intact: true, action: 'eod' }).ok, false);
});

test('deniedRoles: the analysts served from the cache, and in a trade or manage cycle the roles outside the desk; opencode enforces them per run', () => {
  const { deniedRoles } = require('../../scripts/lib/autotrader');
  const cached = ['market-structure-analyst', 'trend-momentum-analyst', 'risk-manager'];
  assert.deepStrictEqual(deniedRoles({ action: 'trade', cachedRoles: cached }), ['market-structure-analyst', 'trend-momentum-analyst', 'strategy-researcher'], 'risk-manager stays: phase 2 always runs');
  assert.deepStrictEqual(deniedRoles({ action: 'manage', cachedRoles: [] }), ['strategy-researcher']);
  assert.deepStrictEqual(deniedRoles({ action: 'premarket' }), []);
  assert.deepStrictEqual(deniedRoles(null), []);
  // The per-run opencode config: the session and the head trader may not launch the roles off the desk (the task
  // permission, the same every trade cycle); the cached ones are refused by the runner's plugin (FTH_DENIED_ROLES), so
  // the task permission, and the head trader's prompt with it, doesn't change with the cache.
  const root = path.resolve(__dirname, '..', '..');
  const ctx = { action: 'trade', symbols: [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z' } }], cachedRoles: cached };
  const env = childEnv(validateConfig({ harness: 'opencode' }), root, { FTH_HOME: '/srv/fth', FTH_DENIED_ROLES: 'trade-executor' }, ctx);
  const conf = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  for (const task of [conf.permission.task, conf.agent['fth-head-trader'].permission.task]) {
    assert.strictEqual(task['*'], 'deny');
    assert.strictEqual(task['strategy-researcher'], 'deny');
    for (const r of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager', 'trade-executor', 'trade-reviewer', 'news-calendar-analyst']) assert.strictEqual(task[r], 'allow', r);
  }
  assert.deepStrictEqual(env.FTH_DENIED_ROLES.split(',').sort(), ['market-structure-analyst', 'strategy-researcher', 'trend-momentum-analyst'], 'the run\'s own list, never an inherited one');
  // The tool-call layer's denied-role rule (toolcall/rules.js) refuses them, through its pipeline.
  const denied = r => require('../../scripts/lib/toolcall/pipeline').createPipeline({ log: require('../../scripts/lib/toolcall/call-log').createCallLog(), env }).before({ tool: 'task', name: 'task', args: { subagent_type: r }, session: 's' }).refuse;
  for (const r of ['market-structure-analyst', 'trend-momentum-analyst', 'strategy-researcher']) assert.match(denied(r), /\[denied-role\]/, r);
  for (const r of ['volume-liquidity-analyst', 'risk-manager', 'trade-executor']) assert.strictEqual(denied(r), null, r);
  // Another cycle with another cache: the same config (the head trader's tools and prompt), only the plugin's list differs.
  const other = childEnv(validateConfig({ harness: 'opencode' }), root, { FTH_HOME: '/srv/fth' }, { ...ctx, cachedRoles: [] });
  assert.strictEqual(other.OPENCODE_CONFIG_CONTENT, env.OPENCODE_CONFIG_CONTENT);
  assert.strictEqual(other.FTH_DENIED_ROLES, 'strategy-researcher');
  // A premarket run may launch every role: nothing denied, nothing refused.
  const preEnv = childEnv(validateConfig({ harness: 'opencode' }), root, { FTH_HOME: '/srv/fth', FTH_DENIED_ROLES: 'market-structure-analyst' }, { action: 'premarket' });
  const pre = JSON.parse(preEnv.OPENCODE_CONFIG_CONTENT);
  for (const r of ['market-structure-analyst', 'strategy-researcher']) assert.strictEqual(pre.permission.task[r], 'allow', r);
  assert.strictEqual(preEnv.FTH_DENIED_ROLES, undefined);
  assert.deepStrictEqual(require('../../scripts/lib/autotrader').offDeskRoles({ action: 'premarket' }), []);
});

test('scoredResult: a trade cycle\'s `blocked` with no order call in its transcript is scored as no-trade (the line it wrote kept); any order call or executor launch, another outcome, or an unreadable transcript: as written', () => {
  const { scoredResult } = require('../../scripts/lib/autotrader');
  const ev = (tool, input, status = 'completed') => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool, state: { status, input, output: 'ok' } } });
  const quiet = [ev('harness_bar_briefing', { symbol: 'MNQ' }), ev('task', { subagent_type: 'risk-manager' })].join('\n');
  const line = 'CYCLE RESULT: blocked - the trend rule blocks longs';
  assert.deepStrictEqual(scoredResult(line, quiet), { result: 'CYCLE RESULT: no-trade - the trend rule blocks longs', note: 'reported blocked with no order call this cycle (blocked is a refused order): scored as no-trade' });
  assert.strictEqual(scoredResult('**CYCLE RESULT: Blocked** - x', quiet).result, 'CYCLE RESULT: no-trade - x');
  assert.strictEqual(scoredResult('CYCLE RESULT: blocked', quiet).result, 'CYCLE RESULT: no-trade - no order was refused');
  for (const kept of [
    [ev('task', { subagent_type: 'trade-executor' }, 'error')], // a refused executor launch
    [ev('task', { subagent_type: 'trade-executor' })], // its order may have been refused inside it
    [ev('broker_place_order', { side: 'buy' }, 'error')],
    [ev('broker_close_position', {})],
    [ev('broker_modify_order', {})],
    [ev('broker_cancel_order', {})],
    [ev('broker_partial_close_position', {})],
  ]) assert.strictEqual(scoredResult(line, [...kept, quiet].join('\n')), null, kept[0]);
  assert.strictEqual(scoredResult(line, 'plain text, no tool calls'), null, 'unreadable: kept');
  // A skill's text quoting a refusal is no refused call.
  assert.ok(scoredResult(line, [ev('skill', { name: 'order-mechanics' }), quiet].join('\n').replace('"output":"ok"', '"output":"a `Blocked by ...` refusal"')));
  assert.strictEqual(scoredResult(line, ''), null);
  assert.strictEqual(scoredResult('CYCLE RESULT: no-trade - x', quiet), null);
  assert.strictEqual(scoredResult('CYCLE RESULT: blockedx - x', quiet), null);
  // Through scoreRun (what the CLI logs and the cycle log records) and cycleOutcome: a trade or manage cycle of a
  // harness whose launches are parsed (opencode, Claude); the agent's line kept as reportedResult.
  const { scoreRun } = require('../../scripts/lib/autotrader');
  const out = `${quiet}\n${JSON.stringify({ type: 'text', timestamp: 2, sessionID: 's', part: { type: 'text', text: line } })}`;
  const res = { ok: true, timedOut: false, code: 0, output: out, stdout: out };
  const s = scoreRun(res, { action: 'trade', harness: 'opencode' });
  assert.deepStrictEqual(s, { result: 'CYCLE RESULT: no-trade - the trend rule blocks longs', reportedResult: line, resultNote: 'reported blocked with no order call this cycle (blocked is a refused order): scored as no-trade' });
  assert.strictEqual(scoreRun(res, { action: 'manage', harness: 'claude' }).result, 'CYCLE RESULT: no-trade - the trend rule blocks longs');
  for (const [action, harness] of [['premarket', 'opencode'], ['eod', 'opencode'], ['trade', 'codex'], ['trade', 'qwen'], ['trade', undefined]]) {
    assert.deepStrictEqual(scoreRun(res, { action, harness }), { result: line }, `${action} ${harness}`);
  }
  assert.deepStrictEqual(scoreRun({ ...res, ok: false }, { action: 'trade', harness: 'opencode' }), { result: 'CYCLE RESULT: error - exit 0' });
  const r = cycleOutcome(res, { result: s.result, reportedResult: s.reportedResult, resultNote: s.resultNote, intact: true, action: 'trade' });
  assert.strictEqual(r.result, 'CYCLE RESULT: no-trade - the trend rule blocks longs');
  assert.strictEqual(r.reportedResult, line);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(cycleOutcome(res, { result: line, intact: true, action: 'trade' }).reportedResult, undefined);
  // A Codex transcript launching the trade-executor with spawn_agent: neither parser reads it, so Codex is never scored.
  const codex = [JSON.stringify({ type: 'item.completed', item: { id: 'a', type: 'mcp_tool_call', server: 'harness', tool: 'bar_briefing', arguments: {} } }), JSON.stringify({ type: 'item.completed', item: { id: 'b', type: 'collab_tool_call', tool: 'spawn_agent', prompt: 'trade-executor: place the plan' } })].join('\n');
  assert.ok(scoredResult(line, codex), 'the parsers miss the spawn_agent launch: why Codex is left out');
  assert.deepStrictEqual(scoreRun({ ok: true, timedOut: false, code: 0, output: `${codex}\n${line}`, stdout: `${codex}\n${line}` }, { action: 'trade', harness: 'codex' }).reportedResult, undefined);
});

test('childEnv: a Claude Code run waits for every subagent (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1): each role reports in the head trader\'s turn; another harness is left as it is', () => {
  const claude = validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7' });
  assert.strictEqual(childEnv(claude, '/r', {}, { action: 'trade' }).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  // Set even when the user's environment says otherwise: a background launch never reports to the desk.
  assert.strictEqual(childEnv(claude, '/r', { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' }, null).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  for (const harness of ['opencode', 'codex', 'qwen']) {
    const c = validateConfig({ harness, premarketAt: '', timeframe: 3, account: '7' });
    assert.strictEqual(childEnv(c, '/r', {}, { action: 'trade' }).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, undefined, harness);
  }
});

test('childEnv: FTH_CYCLE_CACHED_LOOKUPS is the run\'s own: set only for a cached role with lookups and a key, never inherited', () => {
  const cfg = validateConfig({ harness: 'claude', premarketAt: '', timeframe: 3, account: '7' });
  const stale = { FTH_CYCLE_CACHED_LOOKUPS: JSON.stringify({ 'market-structure-analyst': { skills: ['rejection'], key: 'k' } }) };
  const ms = 'market-structure-analyst';
  // Nothing cached; cached without lookups; lookups without a key; lookups of a role not cached: dropped.
  for (const ctx of [{ action: 'trade' }, { action: 'trade', cachedRoles: [ms] }, { action: 'trade', cachedRoles: [ms], cachedLookups: { [ms]: { skills: ['rejection'] } } },
    { action: 'trade', cachedRoles: ['trend-momentum-analyst'], cachedLookups: { [ms]: { skills: ['rejection'], key: 'k' } } }, null]) {
    assert.strictEqual(childEnv(cfg, '/r', stale, ctx).FTH_CYCLE_CACHED_LOOKUPS, undefined, JSON.stringify(ctx));
  }
  const set = childEnv(cfg, '/r', stale, { action: 'trade', cachedRoles: [ms], cachedLookups: { [ms]: { skills: ['pullback-vs-reversal'], key: 'k2' } } });
  assert.deepStrictEqual(JSON.parse(set.FTH_CYCLE_CACHED_LOOKUPS), { [ms]: { skills: ['pullback-vs-reversal'], key: 'k2' } });
});

test('the cycle log records the result as scored and the agent\'s own line beside it (what replay labels read)', () => {
  const { writeCycleLog } = require('../../scripts/lib/cycle-log');
  const home = require('../helpers').tmpDir();
  const at = new Date('2026-10-07T14:30:00Z');
  const { file } = writeCycleLog(home, { at, action: 'trade', harness: 'opencode', prompt: 'p', output: '', result: 'CYCLE RESULT: no-trade - x', reportedResult: 'CYCLE RESULT: blocked - x' });
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.result, 'CYCLE RESULT: no-trade - x');
  assert.strictEqual(doc.reportedResult, 'CYCLE RESULT: blocked - x');
  const line = JSON.parse(fs.readFileSync(path.join(home, 'logs', 'cycles-2026-10-07.jsonl'), 'utf8').trim().split('\n').pop());
  assert.strictEqual(line.result, 'CYCLE RESULT: no-trade - x');
  assert.strictEqual(line.reportedResult, 'CYCLE RESULT: blocked - x');
  const plain = writeCycleLog(home, { at, action: 'trade', harness: 'opencode', prompt: 'p', output: '', result: 'CYCLE RESULT: no-trade - y' });
  assert.ok(!('reportedResult' in JSON.parse(fs.readFileSync(plain.file, 'utf8'))));
});

test('the runner\'s opencode plugin: loaded by every run config from the harness root, as opencode 1.x takes a CommonJS plugin ({ id, server }); it refuses a task call naming a denied role and nothing else', async () => {
  const root = path.resolve(__dirname, '..', '..');
  const oc = require('../../scripts/lib/opencode');
  const conf = oc.runConfig({ root, dataDir: '/d', stateDir: '/s', agents: [] });
  assert.deepStrictEqual(conf.plugin, [require('url').pathToFileURL(path.join(root, 'scripts', 'opencode-plugin.js')).href]);
  const plugin = require('../../scripts/opencode-plugin');
  assert.deepStrictEqual(Object.keys(plugin).sort(), ['id', 'server']);
  assert.strictEqual(typeof plugin.id, 'string');
  const hooks = await plugin.server({}, {});
  const before = hooks['tool.execute.before'];
  const saved = process.env.FTH_DENIED_ROLES;
  process.env.FTH_DENIED_ROLES = 'market-structure-analyst,strategy-researcher';
  try {
    await assert.rejects(before({ tool: 'task' }, { args: { subagent_type: 'market-structure-analyst' } }), /\[denied-role\] market-structure-analyst/);
    await assert.rejects(before({ tool: 'task' }, { args: { subagent_type: ' strategy-researcher ' } }), /\[denied-role\]/);
    for (const [input, output] of [[{ tool: 'task' }, { args: { subagent_type: 'risk-manager' } }], [{ tool: 'task' }, { args: {} }], [{ tool: 'task' }, {}], [{ tool: 'read' }, { args: { subagent_type: 'market-structure-analyst' } }], [null, null]]) {
      await assert.doesNotReject(before(input, output), JSON.stringify(input));
    }
    delete process.env.FTH_DENIED_ROLES;
    await assert.doesNotReject(before({ tool: 'task' }, { args: { subagent_type: 'market-structure-analyst' } }), 'no list: nothing refused by it');
    // A task_id naming no session is dropped before opencode reads it (it would fail the call); a session id stays.
    const invented = { args: { subagent_type: 'risk-manager', prompt: 'p', task_id: 'rm1' } };
    await before({ tool: 'task' }, invented);
    assert.deepStrictEqual(invented.args, { subagent_type: 'risk-manager', prompt: 'p' });
    const resume = { args: { subagent_type: 'risk-manager', task_id: 'ses_eb993c3b1ffekqL45GDgHQpdeZ' } };
    await before({ tool: 'task' }, resume);
    assert.strictEqual(resume.args.task_id, 'ses_eb993c3b1ffekqL45GDgHQpdeZ');
  } finally {
    if (saved === undefined) delete process.env.FTH_DENIED_ROLES; else process.env.FTH_DENIED_ROLES = saved;
  }
});

test('cycleOutcome: a premarket or trade run that exits 0 without a parseable CYCLE RESULT line, or that reports an error, failed; an end of day is judged by its exit alone', () => {
  for (const output of ['', 'Error: provider returned 500', 'CYCLE RESULT: <no-trade | planned> - <reason>', '{"type":"result","result":"Decision: NO TRADE"}', 'CYCLE RESULT: error - broker down', '**CYCLE RESULT: Error - the tools failed**']) {
    for (const action of ['trade', 'manage', 'premarket']) {
      assert.strictEqual(cycleOutcome({ ok: true, timedOut: false, code: 0, output, stdout: output }, { intact: true, action }).ok, false, `${action}: ${output}`);
    }
    // End of day, live and in replay alike (the replay step reports this ok): its job is the flatten, not the line.
    assert.strictEqual(cycleOutcome({ ok: true, timedOut: false, code: 0, output, stdout: output }, { intact: true, action: 'eod' }).ok, true, `eod: ${output}`);
  }
  // Every other outcome is a result.
  for (const word of ['no-trade', 'planned', 'executed', 'managed', 'flattened', 'blocked']) {
    assert.strictEqual(cycleOutcome({ ok: true, output: `CYCLE RESULT: ${word} - x` }, { intact: true, action: 'trade' }).ok, true, word);
  }
  // "error" only as the outcome word: a reason that mentions an error is not one.
  assert.strictEqual(cycleOutcome({ ok: true, output: 'CYCLE RESULT: no-trade - the scan had an error-free read' }, { intact: true, action: 'trade' }).ok, true);
  // A word the prompt doesn't define is no result either (and no agent error): a failed cycle.
  const odd = cycleOutcome({ ok: true, output: 'CYCLE RESULT: errored-out - x' }, { intact: true, action: 'trade' });
  assert.deepStrictEqual([odd.ok, odd.agentError], [false, undefined]);
});

test('cycleOutcome: only an outcome the prompt defines is a result, from the final result line of the agent\'s standard output alone', () => {
  const { CYCLE_OUTCOMES, outcomeOf } = require('../../scripts/lib/autotrader');
  const run = (stdout, output = stdout) => cycleOutcome({ ok: true, timedOut: false, code: 0, output, stdout }, { intact: true, action: 'trade' });
  for (const bad of ['CYCLE RESULT: failed - x', 'CYCLE RESULT: ??? - x', 'CYCLE RESULT: - x', 'CYCLE RESULT: errors - x', 'CYCLE RESULT: no-trades - x', 'CYCLE RESULT: done']) {
    const o = run(`${bad}\n`);
    assert.deepStrictEqual([o.ok, o.agentError], [false, undefined], bad);
  }
  for (const word of CYCLE_OUTCOMES.filter(w => w !== 'error')) assert.strictEqual(run(`CYCLE RESULT: ${word} - x\n`).ok, true, word);
  // The prompt writes the words lower case; a result in another letter case is the same word (the set is closed).
  assert.match(prompts(validateConfig({ harness: 'custom', command: ['a', '{prompt}'], symbols: ['MNQ'] }), new Date('2026-10-07T14:00:00Z'), '/r').premarket('MNQ'), /Your last line must be exactly: CYCLE RESULT: <no-trade \| planned \| executed \| managed \| flattened \| blocked \| error> - <reason>/);
  assert.strictEqual(run('CYCLE RESULT: Managed - x\n').ok, true, 'any letter case');
  assert.strictEqual(run('CYCLE RESULT: NO-TRADE - x\n').ok, true);
  assert.deepStrictEqual([run('CYCLE RESULT: ERROR - x\n').ok, run('CYCLE RESULT: ERROR - x\n').agentError], [false, true], 'an error in any case is the agent\'s');
  for (const bad of ['CYCLE RESULT: MANAGED2 - x', 'CYCLE RESULT: Errors - x', 'CYCLE RESULT: No-Trades - x']) assert.strictEqual(run(`${bad}\n`).ok, false, bad);
  // Formatting around the word and punctuation after it are tolerated, in plain text and in a transcript's result.
  for (const fine of ['CYCLE RESULT: *no-trade* - reason', 'CYCLE RESULT: _blocked_ - reason', 'CYCLE RESULT: `managed` - reason', '**CYCLE RESULT: executed - reason**', 'CYCLE RESULT: no-trade: reason', 'CYCLE RESULT: no-trade, nothing fired', 'CYCLE RESULT: no-trade.']) {
    assert.strictEqual(run(`${fine}\n`).ok, true, fine);
  }
  const json = `${JSON.stringify({ type: 'result', result: 'Done.\nCYCLE RESULT: _blocked_ - [loss-streak] cooldown' })}\n`;
  assert.strictEqual(run(json).ok, true, 'inside a stream-json result event');
  // Still refused: a longer word, a near miss, a word with a digit.
  for (const bad of ['CYCLE RESULT: no-trades - x', 'CYCLE RESULT: errors - x', 'CYCLE RESULT: blocked2 - x', 'CYCLE RESULT: *no-trades* - x', 'CYCLE RESULT: no_trade - x']) {
    assert.strictEqual(run(`${bad}\n`).ok, false, bad);
  }
  assert.strictEqual(run('CYCLE RESULT: no-trade\n').ok, true, 'the word alone');
  // On stderr only (the combined output has it, the standard output doesn't): no result.
  assert.strictEqual(run('the work, then nothing\n', 'the work\nCYCLE RESULT: no-trade - x\n').ok, false);
  // The final line decides: an echoed example before it never does, and a malformed final line fails.
  assert.strictEqual(run('e.g. CYCLE RESULT: ??? - echoed\nCYCLE RESULT: no-trade - x\n').ok, true);
  assert.strictEqual(run('CYCLE RESULT: no-trade - an early draft\nCYCLE RESULT: failed - x\n').ok, false);
  assert.deepStrictEqual([outcomeOf('CYCLE RESULT: blocked - y'), outcomeOf('CYCLE RESULT: nope'), outcomeOf(null)], ['blocked', null, null]);
  // On a raw line too (a mark right before the word): the marks are dropped, the word kept.
  assert.deepStrictEqual(['CYCLE RESULT: *no-trade* - x', 'CYCLE RESULT: `Managed` - x', 'CYCLE RESULT: _blocked_, x', 'CYCLE RESULT: *no-trades*'].map(outcomeOf), ['no-trade', 'managed', 'blocked', null], 'returned lower case');
});

test('the result line\'s outcomes: the prompt and the autonomous-trading skill list exactly CYCLE_OUTCOMES', () => {
  const { RESULT_TEMPLATE, CYCLE_OUTCOMES } = require('../../scripts/lib/autotrader');
  assert.strictEqual(RESULT_TEMPLATE, `CYCLE RESULT: <${CYCLE_OUTCOMES.join(' | ')}> - <reason>`);
  const skill = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'skills', 'autonomous-trading', 'SKILL.md'), 'utf8');
  const listed = skill.match(/`CYCLE RESULT: <([^>]+)> - <reason>`/);
  assert.ok(listed, 'the skill lists the outcomes');
  assert.deepStrictEqual(listed[1].split('|').map(w => w.trim()), CYCLE_OUTCOMES);
  assert.ok(prompts(validateConfig({ harness: 'custom', command: ['a', '{prompt}'], symbols: ['MNQ'] }), new Date('2026-10-07T14:00:00Z'), '/r').premarket('MNQ').includes(RESULT_TEMPLATE));
});

test('every cycle loads the gate\'s skills-at-entry too (ALSO_LOAD): "before an entry" relied on the head trader remembering, and a Claude Code replay lost 2 of 6 approved orders to [skills-at-entry]', () => {
  const { prompts } = require('../../scripts/lib/autotrader');
  const { REQUIRED_AT_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  assert.deepStrictEqual(REQUIRED_AT_ENTRY, ['setup-judgment', 'trade-plan']);
  const items = [{ symbol: 'MNQ', bar: { t: new Date('2026-04-28T14:00:00Z').getTime(), c: 1, contractId: 'MNQ', file: '/tmp/b.json' } }];
  for (const harness of ['claude', 'qwen']) {
    const t = prompts(validateConfig({ harness, premarketAt: '', timeframe: 3, account: '7' }), new Date('2026-04-28T14:03:02Z')).trade(items);
    assert.match(t, /also load htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context before deciding/, harness);
    assert.doesNotMatch(t, /before an entry, also load/, harness);
  }
});

test('loadList: the gate\'s skills, its parenthetical when the harness is gated, then the skills it does not require', () => {
  const { loadList } = require('../../scripts/lib/autotrader');
  const req = ['a', 'b', 'c'];
  assert.strictEqual(loadList(true, req, []), 'a, b, and c (the order gate refuses an entry without them)');
  assert.strictEqual(loadList(false, req, []), 'a, b, and c');
  assert.strictEqual(loadList(true, req, ['x']), 'a, b, and c (the order gate refuses an entry without them); also load x');
  assert.strictEqual(loadList(false, req, ['x']), 'a, b, and c; also load x');
  assert.strictEqual(loadList(true, req, ['x', 'y']), 'a, b, and c (the order gate refuses an entry without them); also load x and y');
  assert.strictEqual(loadList(false, req, ['x', 'y']), 'a, b, and c; also load x and y');
  // The default is the gate's list for trade_lifecycle, the one entry strategy (skills-loaded.js REQUIRED_FOR_COMPOSED),
  // then htf-to-ltf (trade-session step 0 loads it every cycle: the alignment labels and the reversal rule) and
  // confluence-counting (the count that decides, every cycle too: fix/confluence-not-vetoes).
  const { REQUIRED_FOR_COMPOSED: REQUIRED_FOR_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  assert.strictEqual(loadList(false), `${REQUIRED_FOR_ENTRY.slice(0, -1).join(', ')}, and ${REQUIRED_FOR_ENTRY[REQUIRED_FOR_ENTRY.length - 1]}; also load htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context`);
});

test('childEnv: several lanes, the gate learns each symbol\'s lanes whose bar closed this cycle (FTH_CYCLE_LANE_BARS); one lane or a manual run: none', () => {
  const ctx = { symbols: [
    { symbol: 'MNQ', bar: { t: '2026-10-07T13:57:00.000Z' }, lane: '3m' },
    { symbol: 'MNQ', bar: { t: '2026-10-07T13:59:00.000Z' }, lane: '1m' },
  ] };
  const env = childEnv(cfg, '/r', { FTH_HOME: '/srv/fth', FTH_CYCLE_LANE_BARS: '{"stale":1}' }, ctx);
  assert.deepStrictEqual(JSON.parse(env.FTH_CYCLE_LANE_BARS), { MNQ: { 3: '2026-10-07T13:57:00.000Z', 1: '2026-10-07T13:59:00.000Z' } });
  const { loadConfig } = require('../../scripts/lib/trading/config');
  assert.deepStrictEqual(loadConfig(env).cycleLaneBars, { MNQ: { 1: '2026-10-07T13:59:00.000Z', 3: '2026-10-07T13:57:00.000Z' } });
  // One lane (no lane on the items) or no context: an inherited value is dropped.
  assert.strictEqual(childEnv(cfg, '/r', { FTH_HOME: '/srv/fth', FTH_CYCLE_LANE_BARS: '{"MNQ":{"1":"x"}}' }, { symbols: [{ symbol: 'MNQ', bar: { t: 'x' } }] }).FTH_CYCLE_LANE_BARS, undefined);
  assert.strictEqual(childEnv(cfg, '/r', { FTH_HOME: '/srv/fth', FTH_CYCLE_LANE_BARS: '{"MNQ":{"1":"x"}}' }).FTH_CYCLE_LANE_BARS, undefined);
});

test('the runner\'s opencode plugin answers an unknown tool name with the name meant, refuses a repeated failed call with the reminder, and appends the reminder to a repeated result', async () => {
  const plugin = require('../../scripts/opencode-plugin');
  const hooks = await plugin.server({}, {});
  await assert.rejects(hooks['tool.execute.before']({ tool: 'invalid', sessionID: 's' }, { args: { tool: 'compose_check', error: 'e' } }), /call harness_compose_check with the same arguments/);
  const call = () => hooks['tool.execute.before']({ tool: 'harness_market_snapshot', sessionID: 's' }, { args: { bars: '/workspace/x.json' } });
  // Each retry comes a model step after the last failed (more than limits.repeatSameStepMs): the clock is moved on between them.
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  await call(); t += 5000; await call(); t += 5000;
  try {
    await assert.rejects(call(), /\[repeat\] You are repeating the exact same tool call/);
  } finally {
    Date.now = realNow;
  }
  // An MCP tool's result is its raw content here (opencode joins it after the hook): the reminder is a text item of it.
  const mcp = { content: [{ type: 'text', text: 'briefing' }] };
  for (let i = 0; i < 3; i += 1) {
    await hooks['tool.execute.before']({ tool: 'harness_bar_briefing', sessionID: 't' }, { args: { symbol: 'MNQ' } });
    await hooks['tool.execute.after']({ tool: 'harness_bar_briefing', sessionID: 't', args: { symbol: 'MNQ' } }, mcp);
  }
  assert.deepStrictEqual(mcp.content.map(c => c.type), ['text', 'text']);
  assert.match(mcp.content[1].text, /^\[repeat\] You are repeating/);
  // The same call whose answer moves each time: no reminder.
  for (let i = 0; i < 3; i += 1) {
    const moving = { content: [{ type: 'text', text: `briefing ${i}` }] };
    await hooks['tool.execute.before']({ tool: 'harness_bar_briefing', sessionID: 'v' }, { args: { symbol: 'MNQ' } });
    await hooks['tool.execute.after']({ tool: 'harness_bar_briefing', sessionID: 'v', args: { symbol: 'MNQ' } }, moving);
    assert.strictEqual(moving.content.length, 1, `call ${i + 1}`);
  }
  // A built-in tool's result has its output string.
  const own = { output: 'listing' };
  for (let i = 0; i < 3; i += 1) {
    await hooks['tool.execute.before']({ tool: 'glob', sessionID: 'u' }, { args: { pattern: '*' } });
    await hooks['tool.execute.after']({ tool: 'glob', sessionID: 'u', args: { pattern: '*' } }, own);
  }
  assert.match(own.output, /^listing\n\n\[repeat\] You are repeating/);
});

test('a cycle where the runner runs the entry: FTH_CYCLE_ENTRY for the head trader\'s run (the entry-route rule), its prompt says the route in place of the roster\'s phase 2; a role run after it gets the cycle\'s id (FTH_CYCLE_ID); neither inherited', () => {
  const full = validateConfig({ harness: 'opencode', dataDir: '/data/bars' });
  const env = (context, base = {}) => childEnv(full, '/r', { FTH_HOME: '/srv/fth', ...base }, context);
  assert.strictEqual(env({ action: 'trade', symbols: [], entry: true }).FTH_CYCLE_ENTRY, '1');
  for (const context of [{ action: 'trade', symbols: [] }, { action: 'trade', symbols: [], entry: 'yes' }, { action: 'trade', symbols: [], entry: false }, null]) {
    assert.strictEqual(env(context, { FTH_CYCLE_ENTRY: '1' }).FTH_CYCLE_ENTRY, undefined, JSON.stringify(context));
  }
  // A managed cycle (runner.js managedCycle): FTH_CYCLE_MANAGE only when the runner says so; never inherited.
  assert.strictEqual(env({ action: 'trade', symbols: [], manage: true }).FTH_CYCLE_MANAGE, '1');
  for (const context of [{ action: 'trade', symbols: [] }, { action: 'trade', symbols: [], manage: 'yes' }, null]) {
    assert.strictEqual(env(context, { FTH_CYCLE_MANAGE: '1' }).FTH_CYCLE_MANAGE, undefined, JSON.stringify(context));
  }
  assert.strictEqual(env({ action: 'trade', symbols: [], cycleId: '0123456789abcdef' }).FTH_CYCLE_ID, '0123456789abcdef');
  for (const cycleId of ['0123', 'not hex at all!!', 7, null]) assert.strictEqual(env({ action: 'trade', symbols: [], cycleId }, { FTH_CYCLE_ID: 'ffffffffffffffff' }).FTH_CYCLE_ID, undefined, String(cycleId));
  // A role the runner runs on its own (runRole's roleRun): FTH_ROLE_RUN, its name, for that run only; the head trader's
  // run never inherits it (the stop-review reminder asks only the head trader for its result line).
  for (const harness of ['opencode', 'claude']) {
    const c = validateConfig({ harness, dataDir: '/data/bars' });
    assert.strictEqual(childEnv(c, '/r', { FTH_HOME: '/srv/fth' }, { action: 'trade', symbols: [], roleRun: 'trade-executor' }).FTH_ROLE_RUN, 'trade-executor', harness);
    for (const context of [{ action: 'trade', symbols: [] }, { action: 'trade', symbols: [], roleRun: '' }, { action: 'trade', symbols: [], roleRun: 7 }, null]) {
      assert.strictEqual(childEnv(c, '/r', { FTH_HOME: '/srv/fth', FTH_ROLE_RUN: 'risk-manager' }, context).FTH_ROLE_RUN, undefined, `${harness} ${JSON.stringify(context)}`);
    }
  }
  // The prompt: the route, before the desk's reports; not the roster's own phase 2 and executor.
  const { prompts, ENTRY_TEXT } = require('../../scripts/lib/autotrader');
  const cfg = validateConfig({ harness: 'opencode', cycle: 'full', premarketAt: '', symbols: ['MNQ'] });
  const items = [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00.000Z', c: 21500, file: '/b/MNQ-3m.json', contractId: 'MNQ' } }];
  const served = { roles: ['risk-manager'], reports: [{ role: 'risk-manager', text: '## Risk state', at: '2026-10-07T14:03:00.000Z', source: 'desk' }] };
  const on = prompts(cfg, new Date('2026-10-07T14:03:02Z'), '/r').trade(items, { cached: served, entry: true });
  assert.ok(on.includes(ENTRY_TEXT));
  assert.match(ENTRY_TEXT, /when it says OK, end with CYCLE RESULT: planned/);
  assert.match(ENTRY_TEXT, /don't launch risk-manager or the trade-executor/);
  assert.ok(on.indexOf(ENTRY_TEXT) < on.indexOf('--- risk-manager phase 1 report'), 'the route, then the reports below');
  assert.doesNotMatch(on, /then risk-manager phase 2 on your plan, if any/);
  const off = prompts(cfg, new Date('2026-10-07T14:03:02Z'), '/r').trade(items, { cached: served });
  assert.ok(!off.includes(ENTRY_TEXT));
  assert.match(off, /then risk-manager phase 2 on your plan, if any/);
  // Manage-only or paper: neither.
  assert.ok(!prompts(cfg, new Date('2026-10-07T14:03:02Z'), '/r').trade(items, { cached: served, entry: true, manageOnly: true }).includes(ENTRY_TEXT));
  // A managed cycle whose desk the runner ran (runner.js managedDesk): the desk's reports, no roster, no entry.
  const { MANAGED_DESK_TEXT } = require('../../scripts/lib/autotrader');
  const managed = prompts(cfg, new Date('2026-10-07T14:03:02Z'), '/r').trade(items, { cached: served, managedDesk: true });
  assert.ok(managed.includes(MANAGED_DESK_TEXT) && managed.indexOf(MANAGED_DESK_TEXT) < managed.indexOf('--- risk-manager phase 1 report'));
  assert.match(MANAGED_DESK_TEXT, /Don't launch the analysts or the risk-manager this cycle, and send no new entry/);
  assert.match(MANAGED_DESK_TEXT, /Exits, stop moves, closes and cancels go as always/);
  assert.doesNotMatch(managed, /then risk-manager phase 2 on your plan, if any|as parallel subagents/);
  assert.ok(!managed.includes(ENTRY_TEXT) && !off.includes(MANAGED_DESK_TEXT));
  assert.ok(!prompts(cfg, new Date('2026-10-07T14:03:02Z'), '/r').trade(items, { cached: served, managedDesk: true, manageOnly: true }).includes(MANAGED_DESK_TEXT));
  // A managed cycle whose desk didn't complete: the roster (the head trader runs its desk), and no entry this cycle.
  const { MANAGED_NO_ENTRY_TEXT } = require('../../scripts/lib/autotrader');
  const fallback = prompts(cfg, new Date('2026-10-07T14:03:02Z'), '/r').trade(items, { cached: served, managedCycle: true });
  assert.ok(fallback.includes(MANAGED_NO_ENTRY_TEXT) && !fallback.includes(MANAGED_DESK_TEXT));
  assert.match(fallback, /then risk-manager phase 2 on your plan, if any/);
  assert.match(MANAGED_NO_ENTRY_TEXT, /send no new entry, added size or reversal \(the order gate refuses an entry this cycle\)/);
  assert.ok(!off.includes(MANAGED_NO_ENTRY_TEXT));
});

test('headSkillsInPrompt (this machine\'s runner config): a boolean or absent, for harness claude only', () => {
  assert.strictEqual(validateConfig({ harness: 'claude' }).headSkillsInPrompt, undefined, 'absent stays absent');
  assert.strictEqual(validateConfig({ harness: 'claude', headSkillsInPrompt: true }).headSkillsInPrompt, true);
  assert.strictEqual(validateConfig({ harness: 'claude', headSkillsInPrompt: false }).headSkillsInPrompt, false);
  assert.throws(() => validateConfig({ harness: 'claude', headSkillsInPrompt: 'yes' }), /headSkillsInPrompt: true or false/);
  for (const harness of ['opencode', 'codex', 'qwen']) assert.throws(() => validateConfig({ harness, headSkillsInPrompt: true }), /headSkillsInPrompt: for harness "claude" only/, harness);
  assert.strictEqual(validateConfig({ harness: 'opencode', headSkillsInPrompt: false }).headSkillsInPrompt, false);
});

test('cycleDataInPrompt (this machine\'s runner config): a boolean or absent, for harness claude only', () => {
  assert.strictEqual(validateConfig({ harness: 'claude' }).cycleDataInPrompt, undefined, 'absent stays absent');
  assert.strictEqual(validateConfig({ harness: 'claude', cycleDataInPrompt: true }).cycleDataInPrompt, true);
  assert.strictEqual(validateConfig({ harness: 'claude', cycleDataInPrompt: false }).cycleDataInPrompt, false);
  for (const v of ['yes', 1, null, {}]) assert.throws(() => validateConfig({ harness: 'claude', cycleDataInPrompt: v }), /cycleDataInPrompt: true or false/, JSON.stringify(v));
  for (const harness of ['opencode', 'codex', 'qwen']) assert.throws(() => validateConfig({ harness, cycleDataInPrompt: true }), /cycleDataInPrompt: for harness "claude" only/, harness);
  assert.throws(() => validateConfig({ harness: 'custom', command: ['x', '{prompt}'], cycleDataInPrompt: true }), /cycleDataInPrompt: for harness "claude" only/);
  assert.strictEqual(validateConfig({ harness: 'opencode', cycleDataInPrompt: false }).cycleDataInPrompt, false);
});

test('deskBriefReports (this machine\'s runner config): a boolean or absent, for harness claude only', () => {
  assert.strictEqual(validateConfig({ harness: 'claude' }).deskBriefReports, undefined, 'absent stays absent');
  for (const v of [true, false]) assert.strictEqual(validateConfig({ harness: 'claude', deskBriefReports: v }).deskBriefReports, v);
  for (const v of ['yes', 1, null, {}]) assert.throws(() => validateConfig({ harness: 'claude', deskBriefReports: v }), /deskBriefReports: true or false/, JSON.stringify(v));
  for (const harness of ['opencode', 'codex', 'qwen']) assert.throws(() => validateConfig({ harness, deskBriefReports: true }), /deskBriefReports: for harness "claude" only/, harness);
  assert.strictEqual(validateConfig({ harness: 'opencode', deskBriefReports: false }).deskBriefReports, false);
});

test('HEAD_DELIVERY_KEYS: every head trader delivery key is validated (a boolean or absent, claude only)', () => {
  const { HEAD_DELIVERY_KEYS } = require('../../scripts/lib/autotrader');
  assert.deepStrictEqual([...HEAD_DELIVERY_KEYS], ['headSkillsInPrompt', 'cycleDataInPrompt', 'roleSkillsInPrompt', 'deskBriefReports', 'stableFirstPrompt']);
  for (const k of HEAD_DELIVERY_KEYS) {
    assert.strictEqual(validateConfig({ harness: 'claude', [k]: true })[k], true, k);
    assert.throws(() => validateConfig({ harness: 'claude', [k]: 'yes' }), new RegExp(`${k}: true or false`), k);
    for (const harness of ['opencode', 'codex', 'qwen']) assert.throws(() => validateConfig({ harness, [k]: true }), new RegExp(`${k}: for harness "claude" only`), `${k} ${harness}`);
  }
});

test('stableFirstPrompt: Claude Code\'s default (set when absent, so its config, hashes and decisions name it), false keeps the old order; another harness never has it', () => {
  const { headDeliveryOf } = require('../../scripts/lib/autotrader');
  assert.strictEqual(validateConfig({ harness: 'claude' }).stableFirstPrompt, true, 'absent: set on');
  assert.strictEqual(validateConfig({ harness: 'claude', stableFirstPrompt: false }).stableFirstPrompt, false);
  for (const v of ['yes', 1, null, {}]) assert.throws(() => validateConfig({ harness: 'claude', stableFirstPrompt: v }), /stableFirstPrompt: true or false/, JSON.stringify(v));
  for (const harness of ['opencode', 'codex', 'qwen']) {
    assert.strictEqual(validateConfig({ harness }).stableFirstPrompt, undefined, `${harness}: absent stays absent`);
    assert.throws(() => validateConfig({ harness, stableFirstPrompt: true }), /stableFirstPrompt: for harness "claude" only/, harness);
  }
  // The delivery a run was made under: a run made before the key existed (no cfg.stableFirstPrompt) is none, a new
  // Claude Code run names it, so the two are never pooled.
  assert.strictEqual(headDeliveryOf({ config: {} }, {}), null);
  assert.strictEqual(headDeliveryOf({ config: { 'cfg.stableFirstPrompt': 'true' } }, null), 'stableFirstPrompt');
  assert.strictEqual(headDeliveryOf(null, validateConfig({ harness: 'claude', roleSkillsInPrompt: true })), 'roleSkillsInPrompt,stableFirstPrompt');
  assert.strictEqual(headDeliveryOf(null, validateConfig({ harness: 'claude', stableFirstPrompt: false })), null);
});

test('the trade prompt\'s two orders hold the same parts (nothing added, cut or reworded): the stable-first order puts the stable part, the instructions and the situation first, the result line last', () => {
  const { TRADE_ORDER, TRADE_ORDER_BEFORE, tradeOrder, withCycleData } = require('../../scripts/lib/autotrader');
  assert.deepStrictEqual([...TRADE_ORDER].sort(), [...TRADE_ORDER_BEFORE].sort());
  assert.deepStrictEqual(TRADE_ORDER.slice(0, 3), ['stable', 'instructions', 'situation']);
  for (const o of [TRADE_ORDER, TRADE_ORDER_BEFORE]) assert.strictEqual(o[o.length - 1], 'result');
  assert.strictEqual(tradeOrder(validateConfig({ harness: 'claude' })), TRADE_ORDER);
  for (const cfg of [validateConfig({ harness: 'claude', stableFirstPrompt: false }), validateConfig({ harness: 'opencode' }), validateConfig({ harness: 'qwen' }), { harness: 'opencode', stableFirstPrompt: true }]) assert.strictEqual(tradeOrder(cfg), TRADE_ORDER_BEFORE, JSON.stringify(cfg.harness));
  const now = new Date('2026-10-07T14:03:00Z');
  const item = { symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } };
  const opts = { cycleSkills: ' This cycle\'s situation (x) needs your skills `rejection`: they are below.\n\n<skill name="rejection">\nbody\n</skill>\n', state: { id: '7', at: now.toISOString(), balance: 1, positions: [], workingOrders: 0 } };
  const on = validateConfig({ harness: 'claude', account: '7' });
  const off = validateConfig({ harness: 'claude', account: '7', stableFirstPrompt: false });
  const parts = prompts(on, now, '/fth').trade([item], opts, { raw: true });
  const a = prompts(on, now, '/fth').trade([item], opts);
  const b = prompts(off, now, '/fth').trade([item], opts);
  assert.strictEqual(a, TRADE_ORDER.map(k => parts[k]).join(''));
  assert.strictEqual(b, TRADE_ORDER_BEFORE.map(k => parts[k]).join(''));
  assert.strictEqual(a.length, b.length);
  assert.ok(a.startsWith(`${parts.stable}${parts.instructions}${parts.situation} The cycle's time: `));
  assert.ok(a.endsWith(parts.result) && b.endsWith(parts.result));
  // The pre-collected reads still go just before the result line.
  assert.ok(withCycleData(a, ' DATA').endsWith(` DATA${parts.result}`));
});

test('roleSkillsInPrompt (this machine\'s runner config): a boolean or absent, harness claude only; on, each role\'s own run (never the head trader\'s) gets its prompt addition, the role\'s own tools still allowed', () => {
  const { claudeRolesOn, writeRolePrompt } = require('../../scripts/lib/autotrader');
  const RP = require('../../scripts/lib/role-prompt');
  assert.strictEqual(validateConfig({ harness: 'claude' }).roleSkillsInPrompt, undefined, 'absent stays absent');
  for (const v of ['yes', 1, null, {}]) assert.throws(() => validateConfig({ harness: 'claude', roleSkillsInPrompt: v }), /roleSkillsInPrompt: true or false/, JSON.stringify(v));
  for (const harness of ['opencode', 'codex', 'qwen']) assert.throws(() => validateConfig({ harness, roleSkillsInPrompt: true }), /roleSkillsInPrompt: for harness "claude" only/, harness);
  assert.strictEqual(validateConfig({ harness: 'opencode', roleSkillsInPrompt: false }).roleSkillsInPrompt, false);
  const home = tmpDir();
  const env = { FTH_HOME: home };
  const on = validateConfig({ harness: 'claude', roleSkillsInPrompt: true });
  const off = validateConfig({ harness: 'claude' });
  assert.deepStrictEqual([claudeRolesOn(on), claudeRolesOn(off), claudeRolesOn(validateConfig({ harness: 'claude', roleSkillsInPrompt: false }))], [true, false, false]);
  // Another harness's config (validateConfig refuses it; a caller handing one anyway): never on, nothing written.
  assert.deepStrictEqual([claudeRolesOn({ harness: 'opencode', roleSkillsInPrompt: true }), writeRolePrompt({ harness: 'opencode', roleSkillsInPrompt: true }, ROOT, env, 'risk-manager')], [false, null]);
  // The head trader's own run: unchanged by the key.
  assert.deepStrictEqual(buildCommand(on, 'p', ROOT, env), buildCommand(off, 'p', ROOT, env));
  for (const role of require('../../scripts/lib/opencode').RUNNER_RUN_ROLES()) {
    const argv = buildCommand(on, 'p', ROOT, env, { agent: role });
    const at = argv.indexOf('--append-system-prompt-file');
    assert.strictEqual(argv[at + 1], RP.claudeRoleFile(home, role, RP.claudeRoleText(ROOT, role)), role);
    // The only difference from the key off: the flag and its file, right after --agent.
    assert.deepStrictEqual([...argv.slice(0, at), ...argv.slice(at + 2)], buildCommand(off, 'p', ROOT, env, { agent: role }), role);
    assert.strictEqual(argv[at - 2], '--agent');
    // A role with an index can read it: skill_lookup is in its allowed tools.
    if (RP.rolePlan(ROOT, role).agent.index.length) assert.ok(argv[argv.indexOf('--allowedTools') + 1].split(',').includes('mcp__harness__skill_lookup'), role);
    const w = writeRolePrompt(on, ROOT, env, role);
    assert.strictEqual(w.file, argv[at + 1]);
    assert.strictEqual(require('fs').readFileSync(w.file, 'utf8'), w.text);
  }
  assert.strictEqual(writeRolePrompt(off, ROOT, env, 'risk-manager'), null, 'the key off: nothing written');
  // Nothing attested, the env unchanged: FTH_ROLE_SKILLS full, no FTH_HEAD_PROMPT.
  const ctx = { roleRun: 'risk-manager' };
  const { FTH_CYCLE_TRANSCRIPT: _a, ...envOn } = childEnv(on, ROOT, env, ctx);
  const { FTH_CYCLE_TRANSCRIPT: _b, ...envOff } = childEnv(off, ROOT, env, ctx);
  assert.deepStrictEqual(envOn, envOff);
});

test('headSkillsInPrompt absent or false: the Claude head trader\'s argv, env and prompts are as before (no prompt addition, no attestation, an inherited one dropped, the load sentence)', () => {
  const home = tmpDir();
  const items = [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }];
  const now = new Date('2026-10-07T14:30:00Z');
  const off = validateConfig({ harness: 'claude' });
  const no = validateConfig({ harness: 'claude', headSkillsInPrompt: false });
  const base = { FTH_HOME: home, FTH_HEAD_PROMPT: JSON.stringify({ harness: 'claude', config: '/x/claude-head-0123456789abcdef.md', sha256: 'a'.repeat(64), skills: ['trade-session'], cycle: '0123456789abcdef' }) };
  for (const cfgX of [off, no]) {
    const argv = buildCommand(cfgX, 'p', ROOT, base);
    assert.ok(!argv.includes('--append-system-prompt-file'), 'no prompt addition');
    assert.deepStrictEqual(argv, buildCommand(off, 'p', ROOT, base));
    assert.deepStrictEqual(buildCommand(cfgX, 'p', ROOT, base, { agent: 'trade-executor' }), buildCommand(off, 'p', ROOT, base, { agent: 'trade-executor' }));
    const env = childEnv(cfgX, ROOT, base, { cycleId: '0123456789abcdef', headPrompt: base.FTH_HEAD_PROMPT });
    assert.ok(!('FTH_HEAD_PROMPT' in env), 'an inherited or passed attestation is dropped');
    const { FTH_CYCLE_TRANSCRIPT: _t1, ...rest } = env;
    const { FTH_CYCLE_TRANSCRIPT: _t2, ...restOff } = childEnv(off, ROOT, base, { cycleId: '0123456789abcdef' });
    assert.deepStrictEqual(rest, restOff);
    assert.strictEqual(env.FTH_ROLE_SKILLS, 'full');
    const trade = prompts(cfgX, now).trade(items);
    assert.match(trade, /With your skill tool, load trade-session, multi-timeframe-analysis, and trade-lifecycle \(the order gate refuses an entry without them\); also load htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context before deciding/);
    assert.strictEqual(trade, prompts(off, now).trade(items));
  }
  assert.ok(!fs.existsSync(path.join(home, 'head-prompt')), 'nothing written');
});

test('headSkillsInPrompt true (Claude Code): the head trader gets its index-mode prompt addition as a system-prompt file in the harness home, attested for its cycle; a role\'s run gets no file, the entry\'s carries the head trader\'s attestation only for that cycle', () => {
  const H = require('../../scripts/lib/head-prompt');
  const { cycleId: cycleIdOf } = require('../../scripts/lib/trading/check-order');
  const home = tmpDir();
  const on = validateConfig({ harness: 'claude', headSkillsInPrompt: true });
  const argv = buildCommand(on, 'the cycle prompt', ROOT, { FTH_HOME: home });
  const at = argv.indexOf('--append-system-prompt-file');
  assert.ok(at > 0, JSON.stringify(argv));
  const file = argv[at + 1];
  assert.strictEqual(path.dirname(file), path.join(home, 'head-prompt'));
  assert.match(path.basename(file), /^claude-head-[0-9a-f]{64}\.md$/);
  // The rest of the argv is as before (the prompt still the cycle's, after -p).
  const before = buildCommand(validateConfig({ harness: 'claude' }), 'the cycle prompt', ROOT, { FTH_HOME: home });
  assert.deepStrictEqual([...argv.slice(0, at), ...argv.slice(at + 2)], before);
  assert.deepStrictEqual(argv.slice(0, 3), ['claude', '-p', 'the cycle prompt']);
  // A role run on its own: no prompt addition (its role's prompt is its own).
  assert.ok(!buildCommand(on, 'r', ROOT, { FTH_HOME: home }, { agent: 'trade-executor' }).includes('--append-system-prompt-file'));
  // The run's env: the file written, attested for this run's cycle; FTH_ROLE_SKILLS stays full (its roles load theirs).
  const env = childEnv(on, ROOT, { FTH_HOME: home, FTH_HEAD_PROMPT: 'stale' });
  const att = H.parseAttestation(env.FTH_HEAD_PROMPT);
  assert.ok(att, env.FTH_HEAD_PROMPT);
  assert.deepStrictEqual([att.harness, att.config, att.cycle], ['claude', file, cycleIdOf(env)]);
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual(att.sha256, H.sha256(text));
  assert.deepStrictEqual(att.skills, H.CORE);
  assert.strictEqual(env.FTH_ROLE_SKILLS, 'full');
  // The file: CORE embedded whole (each skill's text as a load returns it), every other skill indexed one line, skill_lookup named.
  for (const s of H.CORE) assert.ok(text.includes(`<skill name="${s}">\n${require('../../scripts/lib/frontmatter').parseFrontmatter(fs.readFileSync(path.join(ROOT, 'skills', s, 'SKILL.md'), 'utf8')).body.trim()}\n</skill>`), s);
  const all = fs.readdirSync(path.join(ROOT, 'skills')).filter(n => fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md')));
  for (const s of all.filter(n => !H.CORE.includes(n))) {
    assert.ok(new RegExp(`^- ${s}: `, 'm').test(text), `indexed: ${s}`);
    assert.ok(!text.includes(`<skill name="${s}">`), `not embedded: ${s}`);
  }
  assert.match(text, /mcp__harness__skill_lookup \{"skill": "<name>"\}/);
  // The cycle's prompt: the skills are in its prompt, already loaded (not the load sentence).
  const items = [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }];
  const trade = prompts(on, new Date('2026-10-07T14:30:00Z')).trade(items);
  assert.match(trade, /Your skills trade-session, multi-timeframe-analysis, trade-lifecycle, htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context are in your prompt, already loaded \(don't load them again\): decide by them/);
  assert.doesNotMatch(trade, /With your skill tool, load/);
  // The entry's role (the head trader's cycle id): the head trader's own attestation when it is that cycle's, else none;
  // never a new one.
  const id = att.cycle;
  assert.strictEqual(childEnv(on, ROOT, { FTH_HOME: home }, { cycleId: id, headPrompt: env.FTH_HEAD_PROMPT }).FTH_HEAD_PROMPT, JSON.stringify(att));
  assert.ok(!('FTH_HEAD_PROMPT' in childEnv(on, ROOT, { FTH_HOME: home }, { cycleId: 'f'.repeat(16), headPrompt: env.FTH_HEAD_PROMPT })), 'another cycle\'s');
  assert.ok(!('FTH_HEAD_PROMPT' in childEnv(on, ROOT, { FTH_HOME: home, FTH_HEAD_PROMPT: env.FTH_HEAD_PROMPT }, { cycleId: id })), 'none passed: an inherited one never counts');
  // A desk role's own run (cycle-run.js runRole: roleRun, no cycle id): no prompt addition, so no attestation.
  assert.ok(!('FTH_HEAD_PROMPT' in childEnv(on, ROOT, { FTH_HOME: home, FTH_HEAD_PROMPT: env.FTH_HEAD_PROMPT }, { roleRun: 'market-structure-analyst' })));
  assert.strictEqual(childEnv(on, ROOT, { FTH_HOME: home }, { roleRun: 'trade-executor', cycleId: id, headPrompt: env.FTH_HEAD_PROMPT }).FTH_HEAD_PROMPT, JSON.stringify(att), 'the entry\'s role: the head trader\'s');
  // Two runs: one file (named by its text's hash), each run its own cycle.
  const env2 = childEnv(on, ROOT, { FTH_HOME: home });
  const att2 = H.parseAttestation(env2.FTH_HEAD_PROMPT);
  assert.strictEqual(att2.config, file);
  assert.notStrictEqual(att2.cycle, att.cycle);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'head-prompt')), [path.basename(file)]);
});

test('headSkillsInPrompt: a new prompt addition (a skill changed) prunes the older ones but the newest of them; an unchanged one prunes nothing', () => {
  const H = require('../../scripts/lib/head-prompt');
  const home = tmpDir();
  const dir = path.join(home, 'head-prompt');
  fs.mkdirSync(dir, { recursive: true });
  const old = (n, ageS) => { const f = path.join(dir, `claude-head-${String(n).repeat(64)}.md`); fs.writeFileSync(f, 'old'); const t = Date.now() / 1000 - ageS; fs.utimesSync(f, t, t); return f; };
  const files = [old(1, 400), old(2, 300), old(3, 200)];
  const other = path.join(dir, 'notes.md');
  fs.writeFileSync(other, 'not a head file');
  const { file } = H.writeClaudeHead(home, ROOT);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [path.basename(file), path.basename(files[2]), 'notes.md'].sort());
  // Written again unchanged: nothing pruned.
  H.writeClaudeHead(home, ROOT);
  assert.ok(fs.existsSync(files[2]));
  // The attested one is never pruned by its own write, and a missing directory is no error.
  assert.ok(fs.existsSync(file));
});

test('historyBars: the whole multi-timeframe window at any timeframe (paged past get_bars\' limit, never capped); recordedBars: the recorded count, else the legacy window', () => {
  const A = require('../../scripts/lib/autotrader');
  const T = require('../../scripts/lib/tunables');
  const m = T.analysis().mtf;
  const B = T.runner().bars;
  const bars = (tf, hours) => Math.max(B.historyMinBars, Math.ceil((B.historyDays * B.historyDayHours * 60) / tf), Math.ceil((hours * 60) / tf));
  const now = m.historyHours + m.historyMarginHours;
  for (const tf of [1, 3, 15]) {
    assert.strictEqual(A.historyBars(tf), bars(tf, now));
    assert.strictEqual(validateConfig({ timeframe: tf }).bars, bars(tf, now), 'the run keeps the whole window');
  }
  assert.ok(A.historyBars(1) > require('../../scripts/lib/bars-fetch').MAX_COUNT, 'a one-minute lane\'s window is over one call: the adapter pages it');
  // A run recorded with its count scores with it; one recorded before the field with the legacy window (the old 240 + 10 hours).
  assert.strictEqual(A.recordedBars({ timeframe: 3, bars: 3000 }), 3000);
  assert.strictEqual(A.recordedBars({ timeframe: 3 }), bars(3, m.legacyHistoryHours + m.historyMarginHours));
  assert.strictEqual(A.recordedBars({ timeframe: 3 }), 5000);
  assert.ok(A.recordedBars({ timeframe: 3 }) < A.historyBars(3));
  assert.strictEqual(A.recordedBars({}), 0);
});
