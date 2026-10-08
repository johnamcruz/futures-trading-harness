'use strict';

/**
 * Pure scheduling and command-building logic for the autonomous runner.
 * The runner never trades itself: it starts one headless harness run per
 * cycle (Claude Code, Codex, Qwen Code, or any CLI agent), and every order
 * still passes the order gate and the projectx-mcp guardrails.
 */

const { parseWindows, inWindow, minutesOfDay, zonedParts } = require('./trading/clock');

const DEFAULTS = {
  harness: 'qwen',
  command: null,
  symbols: ['MNQ'],
  account: '',
  workdir: 'workspace',
  cycleMinutes: 3,
  sessions: ['09:35-15:00@America/New_York'],
  premarketAt: '09:00@America/New_York',
  eodAt: '15:50@America/New_York',
  weekdaysOnly: true,
  maxCyclesPerDay: 150,
  cycleTimeoutMinutes: 8,
  maxConsecutiveErrors: 3,
  paper: false,
  model: '',
  extraArgs: [],
};
const HARNESSES = ['claude', 'codex', 'qwen', 'custom'];
const SCRIPTS = ['strategies.js', 'market-snapshot.js', 'blackouts.js'];

/**
 * Claude Code tools for an autonomous run: the projectx MCP server, reading,
 * scratch files under /tmp/fth, and only the harness's own read/append scripts
 * by absolute path. No general shell or file writes, so the run can't edit
 * strategies, settings, the kill switch, or the journal file.
 */
function claudeTools(root) {
  return [
    'mcp__projectx', 'Read', 'Glob', 'Grep', 'Skill', 'Agent', 'WebSearch', 'WebFetch',
    'Write(//tmp/fth/**)', 'Bash(mkdir -p /tmp/fth)',
    ...SCRIPTS.map(s => `Bash(node ${root}/scripts/${s}:*)`),
  ];
}

function parseAt(spec) {
  const m = /^(\d{1,2}):(\d{2})@(.+)$/.exec(String(spec || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: m[3] });
  } catch (_err) {
    return null;
  }
  return { minute: Number(m[1]) * 60 + Number(m[2]), timeZone: m[3] };
}

function validateConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  const errors = [];
  if (!HARNESSES.includes(cfg.harness)) errors.push(`harness: one of ${HARNESSES.join(', ')}`);
  if (cfg.harness === 'custom' && !(Array.isArray(cfg.command) && cfg.command.length > 0 && cfg.command.some(a => String(a).includes('{prompt}')))) {
    errors.push('command: for harness "custom", an argv array containing "{prompt}"');
  }
  if (!Array.isArray(cfg.symbols) || cfg.symbols.length === 0 || !cfg.symbols.every(s => /^[A-Z0-9]+$/.test(s))) errors.push('symbols: e.g. ["MNQ"]');
  if (parseWindows((cfg.sessions || []).join(',')).errors.length || !Array.isArray(cfg.sessions)) errors.push('sessions: ["HH:MM-HH:MM@Zone", ...]');
  for (const k of ['premarketAt', 'eodAt']) if (cfg[k] && !parseAt(cfg[k])) errors.push(`${k}: "HH:MM@Zone" or empty`);
  for (const k of ['cycleMinutes', 'maxCyclesPerDay', 'cycleTimeoutMinutes', 'maxConsecutiveErrors']) {
    if (!(Number.isInteger(cfg[k]) && cfg[k] > 0)) errors.push(`${k}: a positive integer`);
  }
  if (!Array.isArray(cfg.extraArgs)) errors.push('extraArgs: an array');
  if (errors.length) throw new Error(`invalid autotrader config:\n- ${errors.join('\n- ')}`);
  return cfg;
}

function prompts(cfg, now, root = '') {
  const acct = cfg.account ? ` on account ${cfg.account}` : '';
  const where = root ? ` Harness root (FTH_ROOT): ${root}; run its scripts as \`node ${root}/scripts/<script>\`.` : '';
  const head = `Autonomous cycle at ${now.toISOString()}. Follow the autonomous-trading skill. No user is present.${where}`;
  return {
    premarket: symbol => `${head} Run the premarket skill for ${symbol}${acct}.`,
    trade: symbol => `${head} Run the trade-session skill for ${symbol}${acct}${cfg.paper ? ' in paper mode (plan only, no orders)' : ''}.`,
    eod: () => `${head} Run the end-of-day skill${acct}: flatten every position and cancel working orders without asking, then review and summarize.`,
  };
}

/** Environment for a harness run: root, autonomous lock-down, and paper mode. */
function childEnv(cfg, root, base = process.env) {
  const env = { ...base, FTH_ROOT: root, FTH_AUTONOMOUS: '1' };
  if (cfg.paper) {
    env.FTH_PAPER = '1';
    env.PROJECTX_TRADING_ENABLED = 'false';
  }
  return env;
}

/** argv for one headless run. */
function buildCommand(cfg, prompt, root) {
  const extra = cfg.extraArgs.map(String);
  const model = cfg.model ? String(cfg.model) : '';
  switch (cfg.harness) {
    case 'claude':
      return ['claude', '-p', prompt, '--plugin-dir', root, '--output-format', 'json', '--permission-mode', 'dontAsk',
        '--allowedTools', claudeTools(root).join(','), ...(model ? ['--model', model] : []), ...extra];
    case 'codex':
      return ['codex', 'exec', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', ...(model ? ['-m', model] : []), ...extra, prompt];
    case 'qwen':
      // Default approval mode: only tools allowed in ~/.qwen/settings.json
      // permissions (written by scripts/install.js --target qwen) run headless.
      return ['qwen', '-p', prompt, '--approval-mode', 'default', '--output-format', 'json', '--max-session-turns', '80',
        ...(model ? ['--model', model] : []), ...extra];
    default:
      return cfg.command.map(a => String(a).replace('{prompt}', prompt));
  }
}

function dayKey(now, timeZone = 'America/New_York') {
  const p = zonedParts(now, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function isWeekend(now) {
  return ['Sat', 'Sun'].includes(zonedParts(now, 'America/New_York').weekday);
}

function freshDay(key) {
  return { day: key, premarketDone: false, eodDone: false, cycles: 0, lastCycleAt: null };
}

/**
 * Decide the next action. Returns { action: 'premarket' | 'trade' | 'eod' | null, state }.
 * `killSwitch` true suppresses premarket and trade cycles; end of day still runs
 * because it only reduces risk.
 */
function decide(cfg, state, now, { killSwitch = false } = {}) {
  const key = dayKey(now);
  // A previous trading day that traded but never finished end of day (runner
  // down, crash): flatten first, whatever the time.
  if (state && state.day !== key && !state.eodDone && (state.cycles > 0 || state.premarketDone)) {
    return { action: 'eod', state: { ...state } };
  }
  const s = state && state.day === key ? { ...state } : freshDay(key);
  if (cfg.weekdaysOnly && isWeekend(now)) return { action: null, state: s };

  const eod = parseAt(cfg.eodAt);
  const afterEod = eod && minutesOfDay(now, eod.timeZone) >= eod.minute;
  if (afterEod) return { action: s.eodDone ? null : 'eod', state: s };
  if (killSwitch) return { action: null, state: s };

  const pre = parseAt(cfg.premarketAt);
  if (pre && !s.premarketDone && minutesOfDay(now, pre.timeZone) >= pre.minute) return { action: 'premarket', state: s };

  const windows = parseWindows(cfg.sessions.join(',')).windows;
  if (!windows.some(w => inWindow(now, w))) return { action: null, state: s };
  if (s.cycles >= cfg.maxCyclesPerDay) return { action: null, state: s };
  if (s.lastCycleAt && now.getTime() - Date.parse(s.lastCycleAt) < cfg.cycleMinutes * 60000) return { action: null, state: s };
  return { action: 'trade', state: s };
}

/** Record a finished action in the day state. */
function recordRun(state, action, now) {
  const s = { ...state };
  if (action === 'premarket') s.premarketDone = true;
  if (action === 'eod') s.eodDone = true;
  if (action === 'trade') {
    s.cycles += 1;
    s.lastCycleAt = now.toISOString();
  }
  return s;
}

/** Last "CYCLE RESULT: ..." line in a run's output, if any. */
function cycleResult(output) {
  const matches = String(output || '').match(/CYCLE RESULT:[^\n"\\]*/g);
  return matches ? matches[matches.length - 1].trim() : null;
}

module.exports = {
  DEFAULTS,
  HARNESSES,
  claudeTools,
  childEnv,
  parseAt,
  validateConfig,
  prompts,
  buildCommand,
  dayKey,
  decide,
  recordRun,
  cycleResult,
};
