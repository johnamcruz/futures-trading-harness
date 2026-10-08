'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateConfig, buildCommand, decide, recordRun, prompts, cycleResult, parseAt } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = validateConfig({ harness: 'qwen' });
const et = (h, m, day = 7) => new Date(Date.UTC(2026, 9, day, h + 4, m)); // October: ET = UTC-4; 7th is a Wednesday

test('config defaults validate and bad configs list every problem', () => {
  assert.strictEqual(cfg.symbols[0], 'MNQ');
  assert.throws(() => validateConfig({ harness: 'gpt', symbols: [], sessions: ['bad'], eodAt: '25:00@UTC', cycleMinutes: 0 }),
    /harness[\s\S]*symbols[\s\S]*sessions[\s\S]*eodAt[\s\S]*cycleMinutes/);
  assert.throws(() => validateConfig({ harness: 'custom', command: ['agent'] }), /\{prompt\}/);
  assert.deepStrictEqual(parseAt('09:05@America/New_York'), { minute: 545, timeZone: 'America/New_York' });
  assert.strictEqual(parseAt('9am'), null);
});

test('commands for each harness put the prompt where the CLI expects it', () => {
  const p = 'PROMPT';
  const claude = buildCommand(validateConfig({ harness: 'claude', model: 'sonnet' }), p, '/fth');
  assert.deepStrictEqual(claude.slice(0, 5), ['claude', '-p', 'PROMPT', '--plugin-dir', '/fth']);
  assert.ok(claude.includes('dontAsk') && claude.includes('--model'));
  assert.match(claude[claude.indexOf('--allowedTools') + 1], /mcp__projectx/);
  const codex = buildCommand(validateConfig({ harness: 'codex' }), p, '/fth');
  assert.deepStrictEqual([codex[0], codex[1], codex[codex.length - 1]], ['codex', 'exec', 'PROMPT']);
  const qwen = buildCommand(cfg, p, '/fth');
  assert.deepStrictEqual(qwen.slice(0, 3), ['qwen', '-p', 'PROMPT']);
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
  assert.strictEqual(decide(cfg, state, et(9, 41)).action, null); // interval
  assert.strictEqual(decide(cfg, state, et(9, 43)).action, 'trade');
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
  const yesterday = { ...capped, day: '2026-10-06' };
  assert.strictEqual(decide(cfg, yesterday, et(9, 1)).action, 'premarket'); // new day resets state
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
  assert.match(text, /trade-session skill for MES/);
  fs.writeFileSync(path.join(dir, 'STOP'), '');
  const blocked = spawnSync(process.execPath, [cli, '--config', config, '--once', 'trade'], { encoding: 'utf8', env });
  assert.strictEqual(blocked.status, 1);
  assert.match(blocked.stderr, /kill switch is on/);
  const eod = spawnSync(process.execPath, [cli, '--config', config, '--once', 'eod', '--dry-run'], { encoding: 'utf8', env });
  assert.strictEqual(eod.status, 0, eod.stderr);
  assert.match(eod.stdout, /end-of-day skill/);
});
