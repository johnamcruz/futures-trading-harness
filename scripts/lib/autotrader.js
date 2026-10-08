'use strict';

/**
 * Pure scheduling and command-building logic for the autonomous runner.
 * The runner never trades itself: on every closed bar of the configured
 * timeframe (see bar-clock.js) it starts one headless harness run (Claude
 * Code, Codex, Qwen Code, or any CLI agent), and every order still passes the
 * order gate and the projectx-mcp guardrails.
 */

const os = require('os');
const path = require('path');
const { harnessHome } = require('./paths');
const { loadConfig: loadGateConfig } = require('./trading/config');
const { parseWindows, inWindow, minutesOfDay, zonedParts } = require('./trading/clock');

const DEFAULTS = {
  harness: 'qwen',
  command: null,
  symbols: ['MNQ'],
  account: '',
  workdir: 'workspace',
  timeframe: 3, // minutes per bar; a cycle runs after each closed bar
  trigger: 'bar', // 'bar': every closed bar; 'signal': only when a strategy fires or a position is open
  bars: null, // closed bars written to dataDir and scanned each bar; default max(2000, 3 trading days), so
  // prior-day and overnight levels and long indicators match a backtest (cisd_ote still uses the last 500)
  dataDir: null, // default ~/.futures-trading-harness/bars (runner-owned; agents can read it but not write it)
  barDelaySeconds: 2, // wait after the scheduled close before polling
  barPollSeconds: 2, // between polls while waiting for the closed bar
  barTimeoutSeconds: 60, // give up on a bar (daily break, halt) and resync
  sessions: ['09:35-15:00@America/New_York'],
  premarketAt: '09:00@America/New_York',
  eodAt: '15:50@America/New_York',
  weekdaysOnly: true,
  maxCyclesPerDay: 400, // after this, cycles only manage open positions and working orders
  cycleTimeoutMinutes: null, // default max(3, 2 x timeframe)
  cycle: 'full', // 'full': parallel analysts every cycle; 'lean': snapshot + scan, analysts only to confirm a candidate (use for 1m)
  earlyCloseDates: [], // e.g. ["2026-11-27", "2026-12-24"]: CME early-close sessions (YYYY-MM-DD, New York date)
  earlyCloseEodAt: '12:50@America/New_York',
  maxConsecutiveErrors: 3,
  paper: false,
  model: '',
  extraArgs: [],
};
const HARNESSES = ['claude', 'codex', 'qwen', 'custom'];
const SCRIPTS = ['strategies.js', 'market-snapshot.js', 'blackouts.js'];
/** Economic-calendar and exchange sites the news analyst may fetch; nothing else. */
const NEWS_DOMAINS = ['bls.gov', 'bea.gov', 'federalreserve.gov', 'eia.gov', 'treasurydirect.gov', 'cmegroup.com', 'census.gov', 'dol.gov'];

/** Where the runner writes closed bars (runner-owned; agents read it). */
function resolveDataDir(cfg, home = os.homedir(), env = process.env) {
  return cfg.dataDir ? cfg.dataDir.replace(/^~(?=\/)/, home) : path.join(harnessHome(env, home), 'bars');
}

/** Claude rule for an absolute path ("//abs/path"). */
const abs = p => `/${p}`;

/**
 * Claude Code permissions for an autonomous run. Allowed: the projectx MCP
 * server, reading the harness, the bar data, and /tmp/fth, writing /tmp/fth,
 * the harness's own read/append scripts by absolute path, skills, subagents,
 * web search, and fetching calendar sites. Denied explicitly (deny beats any
 * broader allow in the user's settings): reading credentials and other
 * agents' configs, and writing the harness, its state, or Claude settings.
 */
function claudeTools(root, { home = os.homedir(), dataDir = resolveDataDir({}, home) } = {}) {
  return [
    'mcp__projectx', 'Skill', 'Agent', 'WebSearch',
    ...NEWS_DOMAINS.map(d => `WebFetch(domain:${d})`),
    `Read(${abs(root)}/**)`, `Read(${abs(dataDir)}/**)`, 'Read(//tmp/fth/**)',
    'Write(//tmp/fth/**)', 'Bash(mkdir -p /tmp/fth)',
    ...SCRIPTS.map(s => `Bash(node ${root}/scripts/${s}:*)`),
  ];
}

function claudeDenied(root, { home = os.homedir(), stateDir = null } = {}) {
  const h = p => abs(path.join(home, p));
  const state = stateDir && stateDir !== path.join(home, '.futures-trading-harness') ? [`Edit(${abs(stateDir)}/**)`, `Write(${abs(stateDir)}/**)`] : [];
  return [
    ...state,
    'Read(//proc/**)', `Read(${h('.claude')}/**)`, `Read(${h('.claude.json')})`, `Read(${h('.qwen')}/**)`,
    `Read(${h('.codex')}/**)`, `Read(${h('.ssh')}/**)`, `Read(${abs(root)}/**/.env)`,
    `Edit(${abs(root)}/**)`, `Write(${abs(root)}/**)`,
    `Edit(${h('.futures-trading-harness')}/**)`, `Write(${h('.futures-trading-harness')}/**)`,
    `Edit(${h('.projectx-mcp')}/**)`, `Write(${h('.projectx-mcp')}/**)`,
    `Edit(${h('.claude')}/**)`, `Write(${h('.claude')}/**)`,
  ];
}

const ORDER_TOOL_NAMES = ['place_order', 'modify_order', 'cancel_order', 'close_position', 'partial_close_position'];

/**
 * Claude settings rules that would stop an autonomous run from using order
 * tools: "ask" beats "allow" and is refused without a user, and "deny" wins.
 * Returns the offending rules from the given settings objects.
 */
function claudeOrderToolConflicts(settingsList) {
  const hits = [];
  for (const s of settingsList) {
    const perms = (s && s.permissions) || {};
    for (const kind of ['ask', 'deny']) {
      for (const rule of perms[kind] || []) {
        const r = String(rule);
        if (r === 'mcp__projectx' || ORDER_TOOL_NAMES.some(t => r === `mcp__projectx__${t}`)) hits.push(`${kind}: ${r}`);
      }
    }
  }
  return hits;
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

/** True if any session minute falls at or after eodAt (checked on a winter and a summer day). */
function sessionPastEod(cfg) {
  const eod = parseAt(cfg.eodAt);
  const windows = parseWindows(cfg.sessions.join(',')).windows;
  for (const day of [Date.UTC(2026, 0, 7), Date.UTC(2026, 6, 7)]) {
    for (let m = 0; m < 1440; m += 5) {
      const t = new Date(day + m * 60000);
      if (minutesOfDay(t, eod.timeZone) >= eod.minute && windows.some(w => inWindow(t, w))) return true;
    }
  }
  return false;
}

/** Closed bars the runner keeps per symbol: three trading days (23 h each), at least 2000. */
function historyBars(timeframe) {
  return Math.max(2000, Math.ceil((3 * 23 * 60) / timeframe));
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
  if (cfg.cycleTimeoutMinutes === null && Number.isInteger(cfg.timeframe)) cfg.cycleTimeoutMinutes = Math.max(3, 2 * cfg.timeframe);
  if (!['full', 'lean'].includes(cfg.cycle)) errors.push('cycle: "full" or "lean"');
  if (!Array.isArray(cfg.earlyCloseDates) || !cfg.earlyCloseDates.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) errors.push('earlyCloseDates: ["YYYY-MM-DD", ...]');
  if (cfg.earlyCloseEodAt && !parseAt(cfg.earlyCloseEodAt)) errors.push('earlyCloseEodAt: "HH:MM@Zone"');
  if (cfg.bars === null && Number.isInteger(cfg.timeframe) && cfg.timeframe > 0) cfg.bars = historyBars(cfg.timeframe);
  for (const k of ['timeframe', 'bars', 'maxCyclesPerDay', 'cycleTimeoutMinutes', 'maxConsecutiveErrors', 'barPollSeconds', 'barTimeoutSeconds']) {
    if (!(Number.isInteger(cfg[k]) && cfg[k] > 0)) errors.push(`${k}: a positive integer`);
  }
  if (Number.isInteger(cfg.timeframe) && cfg.timeframe > 60) errors.push('timeframe: minutes per bar, 1 to 60');
  if (!(Number.isInteger(cfg.barDelaySeconds) && cfg.barDelaySeconds >= 0)) errors.push('barDelaySeconds: 0 or more');
  if (!['bar', 'signal'].includes(cfg.trigger)) errors.push('trigger: "bar" or "signal"');
  if (cfg.trigger === 'signal' && !cfg.account) errors.push('account: required with trigger "signal" (to see open positions)');
  if (cfg.dataDir !== null && !(typeof cfg.dataDir === 'string' && /^(\/|~\/)/.test(cfg.dataDir))) errors.push('dataDir: an absolute path or ~/...');
  if ('cycleMinutes' in (raw || {})) errors.push('cycleMinutes was replaced by timeframe (cycles now follow bar closes)');
  if (!Array.isArray(cfg.extraArgs)) errors.push('extraArgs: an array');
  if (!errors.length && cfg.eodAt && sessionPastEod(cfg)) {
    errors.push('sessions: a session runs past eodAt; end of day flattens at eodAt and nothing trades after it until midnight. End sessions before eodAt.');
  }
  if (errors.length) throw new Error(`invalid autotrader config:\n- ${errors.join('\n- ')}`);
  return cfg;
}

function prompts(cfg, now, root = '') {
  const acct = cfg.account ? ` on account ${cfg.account}` : '';
  const where = root ? ` Harness root (FTH_ROOT): ${root}; run its scripts as \`node ${root}/scripts/<script>\`.` : '';
  const head = `Autonomous cycle at ${now.toISOString()}. Follow the autonomous-trading skill. No user is present.${where}`;
  return {
    premarket: symbol => `${head} Run the premarket skill for ${symbol}${acct}.`,
    /**
     * One cycle for every symbol whose bar just closed. `items` is a symbol
     * string or a list of { symbol, bar } where bar = { t, c, file, contractId }.
     */
    trade: (items, { manageOnly = false, recovered = false } = {}) => {
      const list = (Array.isArray(items) ? items : [{ symbol: items }]);
      const bars = list.filter(x => x.bar).map(({ symbol, bar }) =>
        ` ${symbol}: a ${cfg.timeframe}-minute bar just closed (open ${bar.t}, close ${bar.c}); closed ${cfg.timeframe}-minute bars, oldest first, are in ${bar.file} (projectx get_bars format; contractId ${bar.contractId}) - use that file for the ${cfg.timeframe}-minute timeframe instead of fetching it.`);
      const symbols = list.map(x => x.symbol).join(', ');
      const mode = [
        cfg.paper ? 'paper mode (plan only, no orders)' : '',
        cfg.cycle === 'lean' ? 'lean cycle (see the trade-session skill)' : '',
        manageOnly ? 'manage-only (the daily cycle cap is reached: manage open positions and working orders, no new entries)' : '',
      ].filter(Boolean).join('; ');
      const recover = recovered ? ' The previous cycle was stopped before it finished: first confirm every open position has a working protective stop (list_open_positions, list_open_orders) and fix that before anything else.' : '';
      return `${head}${recover}${bars.join('')} Run the trade-session skill for ${symbols}${list.length > 1 ? ' (one symbol at a time, open positions first)' : ''}${acct}${mode ? ` in ${mode}` : ''}.`;
    },
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
function buildCommand(cfg, prompt, root, env = process.env) {
  const extra = cfg.extraArgs.map(String);
  const model = cfg.model ? String(cfg.model) : '';
  switch (cfg.harness) {
    case 'claude':
      return ['claude', '-p', prompt, '--plugin-dir', root, '--output-format', 'json', '--permission-mode', 'dontAsk',
        '--allowedTools', claudeTools(root, { dataDir: resolveDataDir(cfg, os.homedir(), env) }).join(','),
        '--disallowedTools', claudeDenied(root, { stateDir: harnessHome(env) }).join(','),
        ...(model ? ['--model', model] : []), ...extra];
    case 'codex':
      // The sandbox may also write the news-blackouts directory (premarket records FOMC/CPI windows there).
      return ['codex', 'exec', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"',
        '-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(path.dirname(loadGateConfig(env).blackoutsFile))}]`,
        ...(model ? ['-m', model] : []), ...extra, prompt];
    case 'qwen':
      // Default approval mode: only tools allowed in workspace/.qwen/settings.json
      // permissions (written by the installer and refreshed by the runner) run headless.
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
 * Decide the next clock action. Returns { action: 'premarket' | 'trade' | 'eod' | null, state }.
 * 'trade' means trade cycles are allowed now (in session, under the cap); the
 * bar clock decides when each one starts. `killSwitch` true suppresses
 * premarket and trade cycles; end of day still runs because it only reduces risk.
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

  const eod = parseAt(cfg.earlyCloseDates.includes(key) && cfg.earlyCloseEodAt ? cfg.earlyCloseEodAt : cfg.eodAt);
  const afterEod = eod && minutesOfDay(now, eod.timeZone) >= eod.minute;
  if (afterEod) return { action: s.eodDone ? null : 'eod', state: s };
  // After the day has traded and until end of day, keep the runner's
  // housekeeping (trailing stops, leftover orders) going even when no cycle
  // may run: outside the sessions or with the kill switch on.
  const idle = { action: cfg.account && !cfg.paper && s.cycles > 0 ? 'housekeep' : null, state: s };
  if (killSwitch) return idle;

  const pre = parseAt(cfg.premarketAt);
  if (pre && !s.premarketDone && minutesOfDay(now, pre.timeZone) >= pre.minute) return { action: 'premarket', state: s };

  const windows = parseWindows(cfg.sessions.join(',')).windows;
  if (!windows.some(w => inWindow(now, w))) return idle;
  // Past the cap, keep managing positions and working orders; just no new entries.
  return { action: s.cycles >= cfg.maxCyclesPerDay ? 'manage' : 'trade', state: s };
}

/** Record a finished action in the day state. */
function recordRun(state, action, now) {
  const s = { ...state };
  if (action === 'premarket') s.premarketDone = true;
  if (action === 'eod') s.eodDone = true;
  if (action === 'trade' || action === 'manage') {
    s.cycles += 1;
    s.lastCycleAt = now.toISOString();
  }
  return s;
}

/**
 * trigger "signal": run a cycle on this bar only when the position needs
 * managing or a mechanical strategy is a candidate (from strategies.js scan).
 * Manual strategies need the LLM, so they only run in trigger "bar" mode.
 */
function signalDecision(scanResults, netPosition, workingOrders = 0, { paper = false } = {}) {
  if (netPosition !== 0) return { run: true, reason: `position open (net ${netPosition})` };
  if (workingOrders > 0) return { run: true, reason: `${workingOrders} working order(s)` };
  // A paper strategy can't place live entries, so it only starts a cycle in paper mode.
  const fired = (scanResults || []).filter(r => r.candidate && r.signal !== 'manual' && (paper || r.status === 'active')).map(r => `${r.name} ${r.direction}`);
  return fired.length ? { run: true, reason: `strategy candidate: ${fired.join(', ')}` } : { run: false, reason: 'no strategy fired and flat' };
}

/** Last "CYCLE RESULT: ..." line in a run's output, if any. */
function cycleResult(output) {
  const matches = String(output || '').match(/CYCLE RESULT:[^\n"\\]*/g);
  return matches ? matches[matches.length - 1].trim() : null;
}

module.exports = {
  historyBars,
  DEFAULTS,
  HARNESSES,
  claudeTools,
  claudeDenied,
  claudeOrderToolConflicts,
  resolveDataDir,
  NEWS_DOMAINS,
  childEnv,
  parseAt,
  validateConfig,
  prompts,
  buildCommand,
  dayKey,
  decide,
  recordRun,
  cycleResult,
  signalDecision,
};
