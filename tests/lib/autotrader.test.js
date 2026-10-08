'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateConfig, buildCommand, decide, recordRun, prompts, cycleResult, parseAt, childEnv, claudeTools, signalDecision } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = validateConfig({ harness: 'qwen' });
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
  assert.strictEqual(decide(cfg, capped, et(10, 0)).action, null);
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
  const p = prompts(validateConfig({ timeframe: 1 }), et(10, 1), '/r').trade('MNQ', { t: '2026-10-07T14:00:00Z', c: 21503.25, file: '/tmp/fth/MNQ-1m.json', contractId: 'CON.F.US.MNQ.Z26' });
  assert.match(p, /A 1-minute MNQ bar just closed \(open 2026-10-07T14:00:00Z, close 21503.25\)/);
  assert.match(p, /\/tmp\/fth\/MNQ-1m\.json .*contractId CON\.F\.US\.MNQ\.Z26/);
});

test('signal trigger runs on an open position or a mechanical candidate only', () => {
  assert.deepStrictEqual(signalDecision([], -1), { run: true, reason: 'position open (net -1)' });
  assert.strictEqual(signalDecision([{ name: 'orb', candidate: true, signal: 'orb', direction: 'long' }], 0).reason, 'strategy candidate: orb long');
  assert.strictEqual(signalDecision([{ name: 'cisd_ote', candidate: true, signal: 'manual' }, { name: 'orb', candidate: false, signal: 'orb' }], 0).run, false);
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
