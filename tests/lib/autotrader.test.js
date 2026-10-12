'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { cycleOutcome, validateConfig, buildCommand, decide, recordRun, prompts, cycleResult, parseAt, childEnv, claudeTools, claudeDenied, claudeOrderToolConflicts, signalDecision } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

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

test('prompts name the skill, symbol, account, and paper mode', () => {
  const p = prompts(validateConfig({ account: '123', paper: true }), et(10, 0));
  assert.match(p.trade('MNQ'), /autonomous-trading skill[\s\S]*trade-session skill for MNQ on account 123 in paper mode/);
  assert.match(p.premarket('MES'), /premarket skill for MES/);
  assert.match(p.eod(), /end-of-day skill on account 123 for the trading day ending \d{4}-\d\d-\d\d, on \d+-minute bars \(the reconcile tool with day \d{4}-\d\d-\d\d and timeframe \d+\): flatten/);
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

test('a trade prompt carries the cached reports whole, says not to launch those roles, and that phase 2 runs this cycle', () => {
  const now = new Date('2026-10-07T14:30:00Z');
  const items = [{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 21500, file: '/b/MNQ-3m.json', contractId: 'MNQ' } }];
  const cached = { roles: ['trend-momentum-analyst', 'risk-manager'], reports: [
    { role: 'trend-momentum-analyst', text: 'Data: bar_briefing m15@x\nBias: long (high)', at: '2026-10-07T14:21:00Z', until: '2026-10-07T14:45:00.000Z' },
    { role: 'risk-manager', text: 'Phase 1: 2 trades left', at: '2026-10-07T14:21:00Z', until: null },
  ] };
  const p = prompts(validateConfig({}), now).trade(items, { cached });
  assert.match(p, /Cached reports, still valid this bar[^]*don't launch trend-momentum-analyst, risk-manager \(phase 1\) this cycle; the order gate counts them as returned\. An analyst's 15m-and-up view holds until 10:45 ET; take this bar's 3m facts[^]*then risk-manager phase 2 \(always this cycle\)\./);
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
  assert.match(full, /Full cycle: market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst and risk-manager \(phase 1\) as parallel subagents, plan from their reports, then risk-manager phase 2; the gate refuses an entry until all have reported\./);
  assert.match(prompts(validateConfig({ cycle: 'lean' }), now).trade(items), /Lean cycle: on a candidate, risk-manager phase 1 and 2; the gate refuses an entry until both have reported\./);
  // No entries possible: no roster.
  assert.doesNotMatch(prompts(validateConfig({}), now).trade(items, { manageOnly: true }), /Full cycle:/);
  assert.doesNotMatch(prompts(validateConfig({ paper: true }), now).trade(items), /Full cycle:/);
  // A harness whose gate can't see the roles (Codex, custom) is told the roster, not a refusal it won't get.
  const codex = prompts(validateConfig({ harness: 'codex' }), now).trade(items);
  assert.match(codex, /Full cycle: market-structure-analyst[^]*then risk-manager phase 2\./);
  assert.doesNotMatch(codex, /the gate refuses an entry until all have reported/);
  assert.match(prompts(validateConfig({ harness: 'qwen' }), now).trade(items), /the gate refuses an entry until all have reported/);
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
  const paper = childEnv(validateConfig({ paper: true }), '/r', {});
  assert.deepStrictEqual([paper.FTH_PAPER, paper.PROJECTX_TRADING_ENABLED], ['1', 'false']);
  // The broker server's own off switch comes from the broker config (paperEnv), whatever the broker.
  const home = require('../helpers').tmpDir();
  require('fs').writeFileSync(require('path').join(home, 'brokers.json'), JSON.stringify({ broker: 'other', brokers: { other: { command: ['x'], paperEnv: { OTHER_LIVE: 'no' } } } }));
  const other = childEnv(validateConfig({ paper: true }), '/r', { FTH_HOME: home });
  assert.deepStrictEqual([other.OTHER_LIVE, other.PROJECTX_TRADING_ENABLED], ['no', undefined]);
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
  fs.writeFileSync(config, JSON.stringify({ harness: 'custom', command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js'), '{prompt}'] }));
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
  for (const d of ['scripts', 'strategies', 'accounts', 'mcp-configs', 'agents', 'skills', 'models', 'workspace']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
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
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'replaymock', brokers: { replaymock: { command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js')], replay: true, journalEnv: 'MOCK_JOURNAL' } } }));
  const replayStop = path.join(home, 'STOP');
  const replayEnv = { ...env, FTH_HOME: home, FTH_KILL_SWITCH_FILE: replayStop, FTH_REPLAY_NOW: '2026-10-07T14:00:00Z', MOCK_REPLAY: '1', MOCK_STATE_DIR: home, MOCK_JOURNAL: path.join(home, 'journal.jsonl') };
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
  const r = await runHarness(['bash', '-c', `(while true; do echo x >> ${marker}; sleep 0.2; done) & exit 0`], { cwd: dir, env: process.env, timeoutMs: 10000 });
  assert.strictEqual(r.ok, true);
  await new Promise(res => setTimeout(res, 2600));
  const n = fs.readFileSync(marker, 'utf8').length;
  await new Promise(res => setTimeout(res, 800));
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
    { strategy: 'prop_flow_1m', component: 'ofi', direction: 'short', action: 'skip', reason: 'the policy' },
  ];
  const text = p.trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00Z', c: 21500, file: '/b.json', contractId: 'MNQ' }, verdicts }]);
  assert.match(text, /prop_portfolio: long setup from supertrend, verdict full: enter only as setup:prop_portfolio, NQ buy, at most 3, stopLossBracket.ticks 40/);
  assert.match(text, /prop_flow_1m: the short setup from ofi is skipped \(the policy\); no entry/);
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
  const t = historyText(h);
  assert.match(t, /Your last 6 cycle\(s\), oldest first: 10:00-10:09 ET \(4 cycles\) MNQ: no-trade - nothing fired \| 10:12 ET MNQ: executed - orb long x+… \| 10:15 ET MNQ: no-trade - nothing fired\./);
  assert.ok(t.length < 400, `${t.length} chars`);
  assert.strictEqual(historyText([]), '');
});

test('a busy cycle prompt stays lean: every line is decision context, and the whole fits a budget', () => {
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
  assert.ok(p.length < 4900, `the prompt grew to ${p.length} characters`);
  // The context is there; the noise is not.
  for (const want of [/MNQ day: opened/, /orb long with ema_cross \[orb track record/, /Your last 10 cycle\(s\)/, /\(\d cycles\)/, /Your last 10 reviewed trade/, /Your recurring mistakes and lessons/]) assert.match(p, want);
  assert.doesNotMatch(p, /95% CI|not over|no 10-day average/);
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
  const failedScreen = p.trade([{ symbol: 'MNQ', bar, scan, notEntries: ['orb'] }], { unavailable: ['MNQ policy screen (bundle missing): no verdict, so no entry for orb this bar'] });
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
  const live = at('2026-10-07T12:00:00Z', { FTH_BROKER: 'topstepx' });
  assert.strictEqual(live.status, 1);
  assert.match(live.stderr, /FTH_REPLAY_NOW is set but the selected broker "topstepx" is not a replay broker/);
  // The live loop too: refused before the lock, the broker, or the first cycle.
  const loop = spawnSync(process.execPath, [cli, '--config', config], { encoding: 'utf8', env: { ...env, FTH_BROKER: 'topstepx', FTH_REPLAY_NOW: '2026-10-07T12:00:00Z' }, timeout: 20000 });
  assert.strictEqual(loop.status, 1);
  assert.match(loop.stderr, /FTH_REPLAY_NOW is set but the selected broker "topstepx" is not a replay broker/);
  // --once: the prompt is dated by the replayed clock; end of day still runs, at the wall clock, when the override is refused.
  const once = (now, extra = {}) => spawnSync(process.execPath, [cli, '--config', config, '--once', 'eod', '--dry-run'], { encoding: 'utf8', env: { ...env, FTH_REPLAY_NOW: now, ...extra } });
  const replayedEod = once('2026-03-04T20:30:00Z');
  assert.strictEqual(replayedEod.status, 0, replayedEod.stderr);
  assert.match(replayedEod.stdout, /trading day ending 2026-03-04/);
  const refusedEod = once('2026-03-04T20:30:00Z', { FTH_BROKER: 'topstepx' });
  assert.strictEqual(refusedEod.status, 0, refusedEod.stderr);
  assert.doesNotMatch(refusedEod.stdout, /2026-03-04/, 'the wall clock\'s day');
  const premarketOnce = spawnSync(process.execPath, [cli, '--config', config, '--once', 'premarket', '--symbol', 'MNQ', '--dry-run'], { encoding: 'utf8', env: { ...env, FTH_REPLAY_NOW: '2026-03-04T12:00:00Z' } });
  assert.match(premarketOnce.stdout, /premarket skill for MNQ.*trading day ending 2026-03-04/);
  assert.strictEqual(spawnSync(process.execPath, [cli, '--config', config, '--once', 'trade', '--dry-run'], { encoding: 'utf8', env: { ...env, FTH_REPLAY_NOW: '2026-03-04T20:30:00Z', FTH_BROKER: 'topstepx' } }).status, 1, 'any other run is refused');
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
  assert.throws(() => validateConfig({ harness: 'opencode', model: 'qwen3' }), /<provider>\/<model>/);
  for (const extraArgs of [['--auto'], ['--auto=true'], ['--yolo'], ['--dangerously-skip-permissions'], ['--attach', 'http://localhost:4096'], ['--dir', '/x'], ['--agent', 'build']]) {
    assert.throws(() => validateConfig({ harness: 'opencode', extraArgs }), /extraArgs: not --/, extraArgs.join(' '));
  }
  // Another harness's flags of the same name are its own business.
  assert.ok(validateConfig({ harness: 'custom', command: ['x', '{prompt}', '--auto'] }));
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
  // Other harnesses get none of it.
  assert.ok(!Object.keys(childEnv(validateConfig({ harness: 'claude' }), '/r', {})).some(k => k.startsWith('OPENCODE_')));
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

test('cycleOutcome: what a cycle hands the runner - the transcript is the standard output alone, never stderr', () => {
  const res = { ok: true, timedOut: false, code: 0, output: '{"a":1}\nwarning on stderr\n', stdout: '{"a":1}\n' };
  assert.deepStrictEqual(cycleOutcome(res, { result: 'CYCLE RESULT: no-trade - x', intact: true, action: 'trade' }),
    { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - x', code: 0, transcript: '{"a":1}\n' });
  assert.strictEqual(cycleOutcome({ ...res, stdout: undefined }, { intact: true, action: 'trade' }).transcript, '');
  // The workspace guard tripped: a trade cycle failed, an end of day that ran still did its job.
  assert.strictEqual(cycleOutcome(res, { intact: false, action: 'trade' }).ok, false);
  assert.strictEqual(cycleOutcome(res, { intact: false, action: 'eod' }).ok, true);
  assert.strictEqual(cycleOutcome({ ...res, ok: false }, { intact: true, action: 'eod' }).ok, false);
});
