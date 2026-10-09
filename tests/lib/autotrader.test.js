'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateConfig, buildCommand, decide, recordRun, prompts, cycleResult, parseAt, childEnv, claudeTools, claudeDenied, claudeOrderToolConflicts, signalDecision } = require('../../scripts/lib/autotrader');
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
  assert.ok(tools.includes('mcp__projectx'));
  assert.ok(tools.includes('Bash(node /fth/scripts/strategies.js:*)'));
  assert.ok(!tools.some(t => t === 'Write' || t === 'Bash' || /^Bash\(node:/.test(t)), 'no general write or shell access');
  assert.deepStrictEqual(claudeTools('/r').filter(t => t.startsWith('Write')), ['Write(//tmp/fth/**)']);
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
  assert.match(p.eod(), /end-of-day skill on account 123: flatten/);
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
});

test('child env locks the gate and paper mode disables trading', () => {
  const live = childEnv(validateConfig({}), '/r', { PATH: '/bin' });
  assert.deepStrictEqual([live.FTH_ROOT, live.FTH_AUTONOMOUS, live.FTH_PAPER], ['/r', '1', undefined]);
  const paper = childEnv(validateConfig({ paper: true }), '/r', {});
  assert.deepStrictEqual([paper.FTH_PAPER, paper.PROJECTX_TRADING_ENABLED], ['1', 'false']);
  assert.match(prompts(cfg, et(10, 0), '/r').trade('MNQ'), /Harness root \(FTH_ROOT\): \/r; run its scripts as `node \/r\/scripts/);
});

test('trade prompt carries the closed bar and its data file', () => {
  const bar = sym => ({ t: '2026-10-07T14:00:00Z', c: 21503.25, file: `/b/${sym}-1m.json`, contractId: `CON.F.US.${sym}.Z26` });
  const p = prompts(validateConfig({ timeframe: 1 }), et(10, 1), '/r').trade([{ symbol: 'MNQ', bar: bar('MNQ') }, { symbol: 'MES', bar: bar('MES') }], { recovered: true });
  assert.match(p, /MNQ: a 1-minute bar just closed \(open 2026-10-07T14:00:00Z, close 21503.25\)/);
  assert.match(p, /\/b\/MES-1m\.json .*contractId CON\.F\.US\.MES\.Z26/);
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
  assert.deepStrictEqual(claudeOrderToolConflicts([{ permissions: { ask: ['mcp__projectx__place_order', 'Bash'], allow: ['mcp__projectx__get_bars'] } }, { permissions: { deny: ['mcp__projectx'] } }]),
    ['ask: mcp__projectx__place_order', 'deny: mcp__projectx']);
  assert.deepStrictEqual(claudeOrderToolConflicts([{}, null]), []);
});

test('cycleResult finds the last reported result', () => {
  assert.strictEqual(cycleResult('x\nCYCLE RESULT: planned - a\nCYCLE RESULT: executed - b\n'), 'CYCLE RESULT: executed - b');
  assert.strictEqual(cycleResult('{"result":"done. CYCLE RESULT: no-trade - quiet"}'), 'CYCLE RESULT: no-trade - quiet');
  assert.strictEqual(cycleResult('nothing'), null);
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
  const env = childEnv(validateConfig({ harness: 'qwen', closedDates: ['2026-12-25'], earlyCloseDates: ['2026-11-27'] }), '/r', {});
  assert.deepStrictEqual([env.FTH_CLOSED_DATES, env.FTH_EARLY_CLOSE_DATES], ['2026-12-25', '2026-11-27']);
  const closed = validateConfig({ harness: 'qwen', premarketAt: '', closedDates: ['2026-12-25'] });
  assert.strictEqual(decide(closed, null, new Date('2026-12-25T15:00:00Z')).action, null, 'no cycles on a holiday');
});

test('a policy strategy\'s verdicts go into the cycle prompt as the only allowed entry', () => {
  const p = prompts(validateConfig({ account: '123' }), et(10, 0));
  const verdicts = [
    { strategy: 'prop_portfolio_3m', component: 'supertrend', direction: 'long', action: 'full', contract: 'NQ', maxSize: 3, stopTicks: 40 },
    { strategy: 'prop_flow_1m', component: 'ofi', direction: 'short', action: 'skip', reason: 'the policy' },
  ];
  const text = p.trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:00:00Z', c: 21500, file: '/b.json', contractId: 'CON.F.US.MNQ.Z26' }, verdicts }]);
  assert.match(text, /prop_portfolio_3m: long setup from supertrend, verdict full: enter only as setup:prop_portfolio_3m, NQ buy, at most 3, stopLossBracket.ticks 40/);
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
    budgets: [{ strategy: 'prop_portfolio_3m', budgetUsd: 975 }], entryBlock: null,
  }];
  const state = { id: '123', at: '2026-10-07T14:00:01.000Z', balance: 101250, positions: [{ contractId: 'CON.F.US.ENQ.Z26', type: 1, size: 2, averagePrice: 21500.25 }], workingOrders: 1, attempts };
  const text = p.trade([{ symbol: 'MNQ' }], { state });
  assert.match(text, /Account 123 at 2026-10-07T14:00:01.000Z: balance \$101,250; open: CON.F.US.ENQ.Z26 long 2 @ 21500.25; 1 working order\./);
  assert.match(text, /topstep_100k attempt \(active\) as of 2026-10-07T14:00:01.000Z: balance \$101,250, floor \$98,000, cushion \$3,250, profit \+\$1,250 of \$6,000, day -\$250, 26 sessions left; prop_portfolio_3m size budget \$975\./);
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
  assert.doesNotMatch(unknown, /flat|NaN|undefined/);
  const attempt = {
    account: 'topstep_50k', status: 'active', asOf: '2026-10-07T13:57:00.000Z', balance: 49750, floor: 48000, cushion: 1750, profit: -250, target: 3000, dayPnl: 0.3, sessionsLeft: 1, budgets: [],
  };
  const one = p.trade([{ symbol: 'MNQ' }], { state: { ...base, positions: [], attempts: [attempt] } });
  assert.match(one, /topstep_50k attempt \(active\) as of 2026-10-07T13:57:00.000Z: balance \$49,750, floor \$48,000, cushion \$1,750, profit -\$250 of \$3,000, day \$0, 1 session left\./);
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
  assert.match(t, /Your last 6 cycle\(s\), oldest first: 14:00-14:09Z \(4 cycles\) MNQ: no-trade - nothing fired \| 14:12Z MNQ: executed - orb long x+… \| 14:15Z MNQ: no-trade - nothing fired\./);
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
      t: bars[9].t, c: 21505.25, file: '/root/.fth/bars/MNQ-3m.json', contractId: 'CON.F.US.MNQ.Z26', recent: bars,
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
  assert.ok(p.length < 4500, `the prompt grew to ${p.length} characters`);
  // The context is there; the noise is not.
  for (const want of [/MNQ day: opened/, /orb long with ema_cross \[orb track record/, /Your last 10 cycle\(s\)/, /\(\d cycles\)/, /Your last 10 reviewed trade/, /Instincts from your reviewed trades/]) assert.match(p, want);
  assert.doesNotMatch(p, /95% CI|not over|no 10-day average/);
});
