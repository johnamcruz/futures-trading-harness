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
const { contractRoot } = require('./trading/journal');
const { sessionsText } = require('./trading/combine');
const { loadConfig: loadGateConfig } = require('./trading/config');
const { parseWindows, inWindow, tradingDayKey, tradingDayStart, inMarketHours, sessionMinute, sessionMinuteOf, MARKET_TZ, MARKET_CLOSE_MIN, MARKET_HOURS_LABEL } = require('./trading/clock');

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
  // The whole market session (18:00-16:00 ET) up to end of day; strategies
  // narrow their own hours (orb: sessions [ny]). Named sessions: asia, london, ny.
  sessions: ['18:00-15:50@America/New_York'],
  premarketAt: '18:05@America/New_York', // briefing at the start of the trading day (before the 08:30 ET data)
  eodAt: '15:50@America/New_York', // flatten everything; required, no later than the 16:00 ET close
  weekdaysOnly: true, // kept for old configs: the market session already excludes weekends
  maxCyclesPerDay: null, // default: one per bar of the 22-hour session (+10); after it, cycles only manage
  cycleTimeoutMinutes: null, // default max(3, 2 x timeframe)
  cycle: 'full', // 'full': parallel analysts every cycle; 'lean': no analysts or news, the trader runs the snapshot, scan, and MTF read and calls risk-manager only on a candidate (use for 1m)
  earlyCloseDates: [], // e.g. ["2026-11-27", "2026-12-24"]: CME early-close trading days (YYYY-MM-DD, the date the day ends on)
  closedDates: [], // e.g. ["2026-11-26", "2026-12-25"]: CME holidays with no session (the runner and the gate stay out)
  earlyCloseEodAt: '12:50@America/New_York',
  maxConsecutiveErrors: 3,
  alertWebhook: '', // https URL: runner errors and the kill switch are POSTed there as JSON { text, content } (Slack, Discord, ntfy, ...)
  alertCommand: null, // or an argv array run with the message in FTH_ALERT, e.g. ["osascript", "-e", "display notification (system attribute \"FTH_ALERT\")"]
  orderFlow: 'auto', // record real order flow from the TopstepX market hub: true, false, or 'auto' (when a strategy on this timeframe declares connectors: [order_flow])
  paper: false,
  model: '',
  extraArgs: [],
};
const HARNESSES = ['claude', 'codex', 'qwen', 'custom'];
// The read-only (or append-only) scripts the skills tell an autonomous run to use.
const SCRIPTS = ['strategies.js', 'market-snapshot.js', 'mtf.js', 'blackouts.js', 'bars.js', 'reconcile.js', 'lessons.js'];
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
function claudeTools(root, { home = os.homedir(), dataDir = resolveDataDir({}, home), stateDir = path.join(home, '.futures-trading-harness') } = {}) {
  return [
    'mcp__projectx', 'Skill', 'Agent', 'WebSearch',
    ...NEWS_DOMAINS.map(d => `WebFetch(domain:${d})`),
    // The runner's logs (scans-<day>.jsonl: why each bar did or didn't fire), read-only.
    `Read(${abs(root)}/**)`, `Read(${abs(dataDir)}/**)`, `Read(${abs(stateDir)}/logs/**)`, 'Read(//tmp/fth/**)',
    'Write(//tmp/fth/**)', 'Bash(mkdir -p /tmp/fth)',
    ...SCRIPTS.map(s => `Bash(node ${root}/scripts/${s}:*)`),
    // The prop attempt's state and verdicts, read-only (start/stop/record-day stay the user's).
    `Bash(node ${root}/scripts/combine.js status:*)`,
  ];
}

function claudeDenied(root, { home = os.homedir(), stateDir = null } = {}) {
  const h = p => abs(path.join(home, p));
  const state = stateDir && stateDir !== path.join(home, '.futures-trading-harness') ? [`Edit(${abs(stateDir)}/**)`, `Write(${abs(stateDir)}/**)`] : [];
  return [
    ...state,
    'Read(//proc/**)', `Read(${h('.claude')}/**)`, `Read(${h('.claude.json')})`, `Read(${h('.qwen')}/**)`,
    `Read(${h('.codex')}/**)`, `Read(${h('.ssh')}/**)`, `Read(${abs(root)}/**/.env)`,
    // Credentials (.env in the state dir, the default ~/.futures-trading-harness, or the repo).
    `Read(${h('.futures-trading-harness')}/.env)`, ...(stateDir ? [`Read(${abs(stateDir)}/.env)`] : []),
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

/**
 * Hard trading hours (not configurable away): sessions inside the market
 * session (18:00-16:00 ET, closed 16:00-18:00 ET), and an end of day no
 * later than the 16:00 ET close. Checked over a winter and a summer trading
 * day, so other time zones are handled across DST.
 */
function marketHoursErrors(cfg) {
  const errors = [];
  const windows = parseWindows((cfg.sessions || []).join(',')).windows;
  // Wednesday trading days (they start Tuesday 18:00 ET).
  for (const start of [tradingDayStart(new Date(Date.UTC(2026, 0, 7, 15))), tradingDayStart(new Date(Date.UTC(2026, 6, 8, 15)))]) {
    for (let m = 0; m < 1440; m += 1) {
      const t = new Date(start.getTime() + m * 60000);
      if (!inMarketHours(t) && windows.some(w => inWindow(t, w))) {
        errors.push(`sessions: must lie inside the market session (${MARKET_HOURS_LABEL})`);
        return errors;
      }
    }
    const close = sessionMinuteOf({ minute: MARKET_CLOSE_MIN, timeZone: MARKET_TZ }, start);
    for (const k of ['eodAt', 'earlyCloseEodAt']) {
      const at = parseAt(cfg[k]);
      if (!at) continue;
      const m = sessionMinuteOf(at, start);
      if (m === null || m === 0 || m > close) {
        errors.push(`${k}: end of day must be inside the session and no later than 16:00 ET; no position is held past the close`);
        return errors;
      }
    }
  }
  return errors;
}

/** True if a session minute falls at or after eodAt in the trading day (winter and summer). */
function sessionPastEod(cfg) {
  const eod = parseAt(cfg.eodAt);
  const windows = parseWindows(cfg.sessions.join(',')).windows;
  for (const start of [tradingDayStart(new Date(Date.UTC(2026, 0, 7, 15))), tradingDayStart(new Date(Date.UTC(2026, 6, 8, 15)))]) {
    const eodMin = sessionMinuteOf(eod, start);
    for (let m = eodMin; m < 1440; m += 5) {
      const t = new Date(start.getTime() + m * 60000);
      if (inMarketHours(t) && windows.some(w => inWindow(t, w))) return true;
    }
  }
  return false;
}

/** Does a strategy the runner trades on this timeframe declare the order_flow connector? */
function usesOrderFlow(strategies, timeframe) {
  return strategies.some(s => s.valid && s.status !== 'disabled' && s.timeframe === `${timeframe}m`
    && Array.isArray(s.connectors) && s.connectors.includes('order_flow'));
}

/** Closed bars the runner keeps per symbol: three trading days (23 h each), at least 2000. */
function historyBars(timeframe) {
  // At least 2000 bars and three trading days, and the multi-timeframe read's whole window
  // (mtf.HISTORY_HOURS), so the live trend rule reads the same candles as the backtest. ProjectX caps a request at 20000.
  const { HISTORY_HOURS } = require('./trading/mtf');
  return Math.min(20000, Math.max(2000, Math.ceil((3 * 23 * 60) / timeframe), Math.ceil((HISTORY_HOURS * 60) / timeframe)));
}

function validateConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  const errors = [];
  if (!HARNESSES.includes(cfg.harness)) errors.push(`harness: one of ${HARNESSES.join(', ')}`);
  if (cfg.harness === 'custom' && !(Array.isArray(cfg.command) && cfg.command.length > 0 && cfg.command.some(a => String(a).includes('{prompt}')))) {
    errors.push('command: for harness "custom", an argv array containing "{prompt}"');
  }
  if (!Array.isArray(cfg.symbols) || cfg.symbols.length === 0 || !cfg.symbols.every(s => /^[A-Z0-9]+$/.test(s))) errors.push('symbols: e.g. ["MNQ"]');
  else {
    // Micros and minis of one index share bars and positions: poll one of them.
    const { familyRoot } = require('./trading/contracts');
    const fams = cfg.symbols.map(familyRoot);
    if (new Set(fams).size !== fams.length) errors.push('symbols: one contract per index (MNQ or NQ, not both): a policy strategy trades either from the one\'s bars');
  }
  if (parseWindows((cfg.sessions || []).join(',')).errors.length || !Array.isArray(cfg.sessions)) errors.push('sessions: ["HH:MM-HH:MM@Zone", ...]');
  for (const k of ['premarketAt', 'eodAt']) if (cfg[k] && !parseAt(cfg[k])) errors.push(`${k}: "HH:MM@Zone" or empty`);
  if (cfg.cycleTimeoutMinutes === null && Number.isInteger(cfg.timeframe)) cfg.cycleTimeoutMinutes = Math.max(3, 2 * cfg.timeframe);
  if (!['full', 'lean'].includes(cfg.cycle)) errors.push('cycle: "full" or "lean"');
  for (const k of ['earlyCloseDates', 'closedDates']) {
    if (!Array.isArray(cfg[k]) || !cfg[k].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) errors.push(`${k}: ["YYYY-MM-DD", ...]`);
  }
  if (cfg.earlyCloseEodAt && !parseAt(cfg.earlyCloseEodAt)) errors.push('earlyCloseEodAt: "HH:MM@Zone"');
  if (cfg.bars === null && Number.isInteger(cfg.timeframe) && cfg.timeframe > 0) cfg.bars = historyBars(cfg.timeframe);
  if (cfg.maxCyclesPerDay === null && Number.isInteger(cfg.timeframe) && cfg.timeframe > 0) cfg.maxCyclesPerDay = Math.ceil((22 * 60) / cfg.timeframe) + 10;
  // US Eastern or Central time only: they change clocks with the exchange, so
  // end of day can't drift past the close in the weeks other zones differ.
  const zoneOk = z => ['America/New_York', 'America/Chicago'].includes(z);
  const badZone = [...parseWindows((cfg.sessions || []).join(',')).windows.map(w => w.timeZone),
    ...['premarketAt', 'eodAt', 'earlyCloseEodAt'].map(k => parseAt(cfg[k])).filter(Boolean).map(a => a.timeZone)].find(z => !zoneOk(z));
  if (badZone) errors.push(`sessions and times: use America/New_York or America/Chicago (got ${badZone}); they follow the exchange's clock changes`);
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
  if (![true, false, 'auto'].includes(cfg.orderFlow)) errors.push('orderFlow: true, false, or "auto"');
  if (cfg.alertWebhook && !/^https:\/\/\S+$/.test(String(cfg.alertWebhook))) errors.push('alertWebhook: an https:// URL, or "" for none');
  if (cfg.alertCommand !== null && !(Array.isArray(cfg.alertCommand) && cfg.alertCommand.length && cfg.alertCommand.every(a => typeof a === 'string'))) errors.push('alertCommand: an argv array (the message is in FTH_ALERT), or null');
  if (!cfg.eodAt) errors.push('eodAt: required ("HH:MM@Zone", no later than 16:00 ET): every position is flattened before the close');
  if (!errors.length) errors.push(...marketHoursErrors(cfg));
  if (!errors.length && cfg.eodAt && sessionPastEod(cfg)) {
    errors.push('sessions: a session runs past eodAt; end of day flattens at eodAt and nothing trades after it until the 18:00 ET open. End sessions before eodAt.');
  }
  if (errors.length) throw new Error(`invalid autotrader config:\n- ${errors.join('\n- ')}`);
  return cfg;
}

const usd = x => `$${Math.round(x).toLocaleString('en-US')}`;
const signed = x => (Math.round(x) === 0 ? '$0' : `${x < 0 ? '-' : '+'}${usd(Math.abs(x))}`);

/**
 * The account as the runner read it just before the run (accountState in
 * runner.js): balance, open positions, working orders, and each running prop
 * attempt's state. Every decision is made with these numbers in view; when
 * they couldn't be read, the prompt says so and asks for a fresh read first.
 */
function accountText(state) {
  if (!state) return '';
  if (state.error) return ` Account ${state.id}: state unavailable (${state.error}); read get_account_snapshot before deciding anything.`;
  const known = Array.isArray(state.positions);
  const positions = (state.positions || []).map(p => `${p.contractId} ${p.type === 1 ? 'long' : p.type === 2 ? 'short' : '?'} ${p.size} @ ${p.averagePrice}`);
  const book = !known ? 'positions and working orders unknown (read get_account_snapshot)'
    : `${positions.length ? `open: ${positions.join(', ')}` : 'flat'}; ${state.workingOrders || 0} working order${state.workingOrders === 1 ? '' : 's'}`;
  const head = ` Account ${state.id} at ${state.at}: balance ${Number.isFinite(state.balance) ? usd(state.balance) : 'unknown'}; ${book}.`;
  const blocked = a => (a.entryBlock ? `; new entries blocked: ${a.entryBlock}` : '');
  const attempts = (state.attempts || []).map(a => (a.noBalance
    ? ` ${a.account} attempt: no balance read yet, so no floor or cushion to show${blocked(a)}.`
    : ` ${a.account} attempt (${a.status}) as of ${a.asOf}: balance ${usd(a.balance)}, floor ${usd(a.floor)}, cushion ${usd(a.cushion)}, `
    + `profit ${signed(a.profit)} of ${usd(a.target)}, day ${signed(a.dayPnl)}, ${sessionsText(a)}`
    + `${(a.budgets || []).map(b => `; ${b.strategy} size budget ${usd(b.budgetUsd)}`).join('')}${blocked(a)}.`));
  const trades = (state.openTrades || []).map(t => ` ${t}`).join('');
  return head + trades + attempts.join('');
}

const RECENT_IN_PROMPT = 10;

/** The last closed bars, oldest first, compact: "09:33 O 21500.25 H 21504 L 21498.5 C 21503.75 V 1200 (+3.5)". */
function recentBarsText(symbol, bars, timeframe) {
  const list = (bars || []).slice(-RECENT_IN_PROMPT);
  if (!list.length) return '';
  const { zonedParts } = require('./trading/clock');
  const hhmm = t => { const p = zonedParts(new Date(t), 'America/New_York'); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
  const num = x => (Number.isFinite(x) ? Number(x.toFixed(4)) : '?');
  const rows = list.map(b => `${hhmm(b.t)} O ${num(b.o)} H ${num(b.h)} L ${num(b.l)} C ${num(b.c)} V ${b.v ?? '?'} (${b.c >= b.o ? '+' : ''}${num(b.c - b.o)})`);
  return ` ${symbol} last ${list.length} closed ${timeframe}m bars (ET open time, oldest first): ${rows.join('; ')}.`;
}

/** What fired on this bar, with its confluence: "orb long (with ema_cross; against bos)". */
function signalsText(symbol, scan) {
  if (!Array.isArray(scan)) return '';
  const fired = scan.filter(r => r.candidate && r.direction && r.signal === 'rules');
  if (!fired.length) return ` ${symbol}: no rules strategy fired on this bar (the scan's candidates).`;
  const one = r => {
    const c = r.confluence || { with: [], against: [] };
    return `${r.name} ${r.direction}${c.with.length ? ` with ${c.with.join(', ')}` : ''}${c.against.length ? `; against ${c.against.join(', ')}` : ''}${r.record ? ` [${r.name} ${r.record}]` : ''}`;
  };
  const conflict = fired.some(r => r.confluence && r.confluence.against.length);
  return ` ${symbol} fired on this bar (scan candidates, already in session, regime, and the trend rule): ${fired.map(one).join(' | ')}.${conflict ? ' Strategies disagree on the side: stand aside unless one is a reversal at a higher-timeframe level and the plan says why.' : ''}`;
}

/** Your last cycles' results, oldest first: what you decided and why, so this cycle builds on them. */
function historyText(history) {
  const list = (history || []).slice(-RECENT_IN_PROMPT);
  if (!list.length) return '';
  return ` Your last ${list.length} cycle(s), oldest first: ${list.map(h => `${h.at.slice(11, 16)}Z ${(h.symbols || []).join(',')}: ${String(h.result || 'no result').replace(/^CYCLE RESULT:\s*/, '')}`).join(' | ')}. Don't flip-flop without a new reason; say what changed.`;
}

function prompts(cfg, now, root = '') {
  const acct = cfg.account ? ` on account ${cfg.account}` : '';
  const where = root ? ` Harness root (FTH_ROOT): ${root}; run its scripts as \`node ${root}/scripts/<script>\`. Harness home (FTH_HOME): ${harnessHome()}; the runner's logs (scans, events, alerts, gate decisions) are in its logs/ folder.` : '';
  const head = `Autonomous cycle at ${now.toISOString()}. Follow the autonomous-trading skill. No user is present.${where}`;
  return {
    premarket: (symbol, { state = null } = {}) => `${head}${accountText(state)} Run the premarket skill for ${symbol}${acct}, for the trading day ending ${dayKey(now)} (18:00 ET to 16:00 ET): today's calendar means that day's.`,
    /**
     * One cycle for every symbol whose bar just closed. `items` is a symbol
     * string or a list of { symbol, bar } where bar = { t, c, file, contractId }.
     */
    trade: (items, { manageOnly = false, recovered = false, state = null, history = [], lessons = [], trades = [] } = {}) => {
      const list = (Array.isArray(items) ? items : [{ symbol: items }]);
      const bars = list.filter(x => x.bar).map(({ symbol, bar, scan }) =>
        ` ${symbol}: a ${cfg.timeframe}-minute bar just closed (open ${bar.t}, close ${bar.c}); closed ${cfg.timeframe}-minute bars, oldest first, are in ${bar.file} (projectx get_bars format; contractId ${bar.contractId}) - use that file for the ${cfg.timeframe}-minute timeframe instead of fetching it.`
        + (bar.trend ? ` ${symbol} ${bar.trend} (recorded for the order gate, which enforces it).` : ` ${symbol}: no multi-timeframe record this bar, so the gate refuses trend strategies' entries.`)
        + (bar.day ? ` ${bar.day}` : '')
        + recentBarsText(symbol, bar.recent, cfg.timeframe)
        + signalsText(symbol, scan));
      const symbols = list.map(x => x.symbol).join(', ');
      const mode = [
        cfg.paper ? 'paper mode (plan only, no orders)' : '',
        cfg.cycle === 'lean' ? 'lean cycle (see the trade-session skill)' : '',
        manageOnly ? 'manage-only (the daily cycle cap is reached: manage open positions and working orders, no new entries)' : '',
      ].filter(Boolean).join('; ');
      const recover = recovered ? ' The previous cycle was stopped before it finished: first confirm every open position has a working protective stop (list_open_positions, list_open_orders) and fix that before anything else.' : '';
      // A policy strategy's verdicts: the only entries the gate will accept (prop-challenge-pacing skill).
      const verdicts = list.flatMap(x => x.verdicts || []).map(v => (v.action === 'skip'
        ? ` ${v.strategy}: the ${v.direction} setup from ${v.component} is skipped (${v.reason || 'the policy'}); no entry.`
        : ` ${v.strategy}: ${v.direction} setup from ${v.component}, verdict ${v.action}: enter only as setup:${v.strategy}, ${v.contract} ${v.direction === 'long' ? 'buy' : 'sell'}, at most ${v.maxSize}, stopLossBracket.ticks ${v.stopTicks}`
          + `${v.contract && v.contractId && contractRoot(v.contractId) !== v.contract ? ` (the ${v.contract} contractId is not ${v.contractId}: find it with search_contracts, active contract; NQ trades as ENQ, ES as EP; use it for the plan and the order)` : ''} (prop-challenge-pacing skill).`));
      return `${head}${recover}${bars.join('')}${accountText(state)}${verdicts.join('')}${historyText(history)}${trades.length ? ` Your last ${trades.length} reviewed trade(s), oldest first: ${trades.join(' | ')}.` : ''}${lessons.length ? ` Instincts from your reviewed trades (confidence; notes from your own past, not rules): ${lessons.join(' | ')}.` : ''} Load the skills trade-session, multi-timeframe-analysis, and strategy-library before deciding (the order gate refuses an entry without them), then run the trade-session skill for ${symbols}${list.length > 1 ? ' (one symbol at a time, open positions first)' : ''}${acct}${mode ? ` in ${mode}` : ''}.`;
    },
    eod: ({ state = null } = {}) => `${head}${accountText(state)} Run the end-of-day skill${acct}: flatten every position and cancel working orders without asking, then review and summarize.`,
  };
}

/** Environment for a harness run: root, autonomous lock-down, and paper mode. */
function childEnv(cfg, root, base = process.env) {
  // The gate learns the exchange calendar from the runner's config.
  const env = { ...base, FTH_ROOT: root, FTH_AUTONOMOUS: '1', FTH_CLOSED_DATES: cfg.closedDates.join(','), FTH_EARLY_CLOSE_DATES: cfg.earlyCloseDates.join(',') };
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
      // stream-json: every tool call and skill load lands in the cycle log (cycle-log.js).
      return ['claude', '-p', prompt, '--plugin-dir', root, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
        '--allowedTools', claudeTools(root, { dataDir: resolveDataDir(cfg, os.homedir(), env), stateDir: harnessHome(env) }).join(','),
        '--disallowedTools', claudeDenied(root, { stateDir: harnessHome(env) }).join(','),
        ...(model ? ['--model', model] : []), ...extra];
    case 'codex':
      // The sandbox may also write the news-blackouts directory (premarket records FOMC/CPI windows there).
      return ['codex', 'exec', '--json', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"',
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

/**
 * The trading day `now` belongs to, named by the New York date it ends on:
 * the session from Sunday 18:00 ET to Monday 16:00 ET is Monday's.
 */
function dayKey(now) {
  return tradingDayKey(now);
}

/** Today's end of day ({ minute, timeZone }): earlyCloseEodAt on an early-close day. */
function endOfDayAt(cfg, now) {
  return parseAt(cfg.earlyCloseDates.includes(dayKey(now)) && cfg.earlyCloseEodAt ? cfg.earlyCloseEodAt : cfg.eodAt);
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

  // Times are placed in the trading day (18:00 ET to 18:00 ET), so a session
  // that runs through midnight is one day.
  const nowMin = sessionMinute(now);
  const eod = endOfDayAt(cfg, now);
  const eodMin = eod ? sessionMinuteOf(eod, now) : null;
  if (eodMin !== null && nowMin >= eodMin) {
    // Only a trading day with a session has an end of day (not a Saturday).
    const lastMinute = new Date(tradingDayStart(now).getTime() + (sessionMinuteOf({ minute: MARKET_CLOSE_MIN - 1, timeZone: MARKET_TZ }, now) || 0) * 60000);
    return { action: s.eodDone || !inMarketHours(lastMinute) || (cfg.closedDates || []).includes(key) ? null : 'eod', state: s };
  }
  // Hard rule: nothing runs outside the market session (the daily break,
  // weekends, holidays).
  if (!inMarketHours(now) || (cfg.closedDates || []).includes(key)) return { action: null, state: s };
  // After the day has traded and until end of day, keep the runner's
  // housekeeping (trailing stops, leftover orders) going even when no cycle
  // may run: outside the sessions or with the kill switch on.
  const idle = { action: cfg.account && !cfg.paper && s.cycles > 0 ? 'housekeep' : null, state: s };
  if (killSwitch) return idle;

  const pre = parseAt(cfg.premarketAt);
  if (pre && !s.premarketDone && nowMin >= sessionMinuteOf(pre, now)) return { action: 'premarket', state: s };

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
  accountText,
  endOfDayAt,
  marketHoursErrors,
  historyBars,
  usesOrderFlow,
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
