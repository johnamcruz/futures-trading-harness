'use strict';

const crypto = require('crypto');

/**
 * Pure scheduling and command-building logic for the autonomous runner.
 * The runner never trades itself: on every closed bar of the configured
 * timeframe (see bar-clock.js) it starts one headless harness run (Claude
 * Code, Codex, Qwen Code, opencode, or any CLI agent), and every order still passes the
 * order gate and the broker MCP server's guardrails.
 */

const os = require('os');
const path = require('path');
const { harnessHome } = require('./paths');
const { scratchDir } = require('./bars-fetch');
const { SERVER_NAME, activeBroker } = require('./broker/config');
const { SERVER_NAME: HARNESS_SERVER } = require('./harness-tools/registry');
const { contractRoot } = require('./trading/journal');
const { candidateTrendRule } = require('./trading/signal-state');
const { sessionsText } = require('./trading/combine');
const { loadConfig: loadGateConfig } = require('./trading/config');
const { parseWindows, inWindow, tradingDayKey, tradingDayStart, inMarketHours, sessionMinute, sessionMinuteOf, MARKET_TZ, MARKET_CLOSE_MIN, MARKET_HOURS_LABEL } = require('./trading/clock');
const { et: etTime, etStamp } = require('./trading/session-context');
const { historyLines, marketOf } = require('./trading/decision-history');
const { documents, isOpencodeEvent } = require('./transcript');
const opencode = require('./opencode');
const { parseLanes, agentOverrideErrors } = require('./lanes');
const { sideValuesText } = require('./trading/rules');
const { REQUIRED_FOR_ENTRY } = require('./trading/skills-loaded');

const DEFAULTS = {
  harness: 'qwen',
  command: null,
  symbols: ['MNQ'],
  account: '',
  workdir: 'workspace',
  timeframe: 3, // minutes per bar; a cycle runs after each closed bar
  trigger: 'bar', // 'bar': every closed bar; 'signal': only when a strategy fires or a position is open
  bars: null, // closed bars written to dataDir and scanned each bar; default max(2000, 3 trading days), so
  // prior-day and overnight levels and long indicators match a backtest
  dataDir: null, // default ~/.futures-trading-harness/bars (runner-owned; agents can read it but not write it)
  barDelaySeconds: 2, // wait after the scheduled close before polling
  barPollSeconds: 2, // between polls while waiting for the closed bar
  barTimeoutSeconds: 60, // give up on a bar (daily break, halt) and resync
  // The whole market session (18:00-16:00 ET) up to end of day; strategies
  // narrow their own hours (orb: sessions [ny]). Named sessions: asia, london, ny.
  sessions: ['18:00-15:50@America/New_York'],
  premarketAt: '18:05@America/New_York', // briefing at the start of the trading day (before the 08:30 ET data)
  eodAt: '15:50@America/New_York', // flatten everything; required, no later than the 16:00 ET close
  eodReview: true, // false: end of day flattens and records the close without the agents' review run (replay uses it)
  weekdaysOnly: true, // kept for old configs: the market session already excludes weekends
  maxCyclesPerDay: null, // default: one per bar of the 22-hour session (+10); after it, cycles only manage
  cycleTimeoutMinutes: null, // default max(3, 2 x timeframe)
  cycle: 'full', // 'full': parallel analysts every cycle; 'lean': no analysts or news, the trader runs the snapshot, scan, and MTF read and calls risk-manager only on a candidate (use for 1m)
  // Added to the built-in CME calendar (trading/exchange-calendar.js), which covers 2026-2027:
  // Added to the built-in CME calendar (trading days, YYYY-MM-DD of the date they end on). To trade past its end,
  // add a whole year: every holiday and every early close (exchange-calendar.js cmeHolidays lists the rules).
  earlyCloseDates: [], // e.g. ["2028-07-03", "2028-11-24"]: early closes (13:00 ET)
  closedDates: [], // e.g. ["2028-01-17", ...]: holidays and other closures (the runner and the gate stay out)
  earlyCloseEodAt: '12:50@America/New_York',
  maxConsecutiveErrors: 3,
  alertWebhook: '', // https URL: runner errors and the kill switch are POSTed there as JSON { text, content } (Slack, Discord, ntfy, ...)
  alertCommand: null, // or an argv array run with the message in FTH_ALERT, e.g. ["osascript", "-e", "display notification (system attribute \"FTH_ALERT\")"]
  paper: false,
  model: '',
  extraArgs: [],
};
const HARNESSES = ['claude', 'codex', 'qwen', 'opencode', 'custom'];
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
 * Claude Code permissions for an autonomous run. Allowed: the broker MCP
 * server, reading the harness, the bar data, and the home's bars scratch
 * directory (<state>/bars-scratch, where bars_fetch writes; nothing to write by hand),
 * the harness's own read/append scripts by absolute path, skills, subagents,
 * web search, and fetching calendar sites. Denied explicitly (deny beats any
 * broader allow in the user's settings): reading credentials and other
 * agents' configs, and writing the harness, its state, or Claude settings.
 */
function claudeTools(root, { home = os.homedir(), dataDir = resolveDataDir({}, home), stateDir = path.join(home, '.futures-trading-harness') } = {}) {
  return [
    `mcp__${SERVER_NAME}`, `mcp__${HARNESS_SERVER}`, 'Skill', 'Agent', 'WebSearch',
    ...NEWS_DOMAINS.map(d => `WebFetch(domain:${d})`),
    // The runner's logs (scans-<day>.jsonl: why each bar did or didn't fire), read-only.
    `Read(${abs(root)}/**)`, `Read(${abs(dataDir)}/**)`, `Read(${abs(stateDir)}/logs/**)`, `Read(${abs(scratchDir({ FTH_HOME: stateDir }))}/**)`,
    ...SCRIPTS.map(s => `Bash(node ${root}/scripts/${s}:*)`),
    // The prop attempt's state and verdicts, read-only (start/stop/record-day stay the user's).
    `Bash(node ${root}/scripts/combine.js status:*)`,
  ];
}

function claudeDenied(root, { home = os.homedir(), stateDir = null, journal = null } = {}) {
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
    // The broker server's journal file (the order gate reads it).
    ...(journal ? [`Edit(${abs(journal)})`, `Write(${abs(journal)})`] : []),
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
        if (r === 'mcp__broker' || ORDER_TOOL_NAMES.some(t => r === `mcp__broker__${t}`)) hits.push(`${kind}: ${r}`);
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

/** Closed bars the runner keeps per symbol: three trading days (23 h each), at least 2000. */
function historyBars(timeframe) {
  // At least 2000 bars and three trading days, and the multi-timeframe read's whole window
  // (mtf.HISTORY_HOURS), so the live trend rule reads the same candles as the backtest. get_bars caps a request at 20000.
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
  // Timeframe lanes (lanes.js): with `lanes`, the first lane's timeframe and trigger are the runner's.
  const laneSpec = parseLanes(cfg, raw);
  errors.push(...laneSpec.errors);
  if (raw && raw.lanes !== undefined && laneSpec.lanes.length) Object.assign(cfg, { lanes: laneSpec.lanes, timeframe: laneSpec.lanes[0].timeframe, trigger: laneSpec.lanes[0].trigger });
  // Per-role timeframes (lanes.js): their shape here; the roles and which may leave the first lane's, at start (agentErrors).
  errors.push(...agentOverrideErrors(cfg.agents));
  if (laneSpec.lanes.slice(1).some(l => l.trigger === 'signal') && !cfg.account) errors.push('account: required with a lane on trigger "signal" (to see open positions)');
  if (cfg.cycleTimeoutMinutes === null && Number.isInteger(cfg.timeframe)) cfg.cycleTimeoutMinutes = Math.max(3, 2 * cfg.timeframe);
  if (!['full', 'lean'].includes(cfg.cycle)) errors.push('cycle: "full" or "lean"');
  for (const k of ['earlyCloseDates', 'closedDates']) {
    if (!Array.isArray(cfg[k]) || !cfg[k].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) errors.push(`${k}: ["YYYY-MM-DD", ...]`);
  }
  if (cfg.earlyCloseEodAt && !parseAt(cfg.earlyCloseEodAt)) errors.push('earlyCloseEodAt: "HH:MM@Zone"');
  if (Array.isArray(cfg.closedDates) && Array.isArray(cfg.earlyCloseDates)) {
    const { exchangeCalendar } = require('./trading/exchange-calendar');
    const cal = exchangeCalendar({ closed: cfg.closedDates, early: cfg.earlyCloseDates });
    cfg.closedDates = [...cal.closedDates].sort();
    cfg.earlyCloseDates = [...cal.earlyCloseDates].sort();
  }
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
  if (cfg.harness === 'opencode') {
    // opencode names a model provider/model (the provider is the user's own opencode config).
    if (cfg.model && !/^[^/\s]+\/\S+$/.test(String(cfg.model))) errors.push('model: for harness "opencode", "<provider>/<model>" from your opencode config, or "" for its default');
    // Only a model variant and logging: --auto (and its aliases) approves every permission not denied,
    // --attach runs on a server the runner didn't configure, --dir or --agent run elsewhere or as another agent.
    const unsafe = opencode.badExtraArgs(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []);
    if (unsafe.length) errors.push(`extraArgs: not ${unsafe.join(', ')} for opencode (only ${Object.keys(opencode.EXTRA_ARGS).join(', ')}: an unattended run gets only what the workspace config and the runner allow)`);
  }
  if (cfg.alertWebhook && !/^https:\/\/\S+$/.test(String(cfg.alertWebhook))) errors.push('alertWebhook: an https:// URL, or "" for none');
  if (cfg.alertCommand !== null && !(Array.isArray(cfg.alertCommand) && cfg.alertCommand.length && cfg.alertCommand.every(a => typeof a === 'string'))) errors.push('alertCommand: an argv array (the message is in FTH_ALERT), or null');
  if (typeof cfg.eodReview !== 'boolean') errors.push('eodReview: true or false');
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
  // Positions are listed once: as trades (open-trades.js), or, when those couldn't be built, on their own line below.
  const described = positions.length > 0 && ((Array.isArray(state.openTrades) && state.openTrades.length === positions.length) || Boolean(state.openTradesError));
  const book = !known ? 'positions and working orders unknown (read get_account_snapshot)'
    : `${positions.length ? (described ? `${positions.length} open position${positions.length === 1 ? '' : 's'} (below)` : `open: ${positions.join(', ')}`) : 'flat'}; ${state.workingOrders || 0} working order${state.workingOrders === 1 ? '' : 's'}`;
  const head = ` Account ${state.id} at ${etTime(state.at)}: balance ${Number.isFinite(state.balance) ? usd(state.balance) : 'unknown'}; ${book}.`;
  const blocked = a => (a.entryBlock ? `; new entries blocked: ${a.entryBlock}` : '');
  const attempts = (state.attempts || []).map(a => (a.noBalance
    ? ` ${a.account} attempt: no balance read yet, so no floor or cushion to show${blocked(a)}.`
    : ` ${a.account} attempt (${a.status})${a.asOf && a.asOf === state.at ? '' : ` as of ${a.asOf ? (tradingDayKey(new Date(a.asOf)) === tradingDayKey(new Date(state.at)) ? etTime(a.asOf) : etStamp(a.asOf)) : '?'}, balance ${usd(a.balance)}`}: floor ${usd(a.floor)}, cushion ${usd(a.cushion)}, `
    + `profit ${signed(a.profit)} of ${usd(a.target)}, day ${signed(a.dayPnl)}, ${sessionsText(a)}`
    + `${(a.budgets || []).map(b => `; ${b.strategy} size budget ${usd(b.budgetUsd)}`).join('')}${blocked(a)}.`));
  const trades = (state.openTrades || []).map(t => ` ${t}`).join('');
  // Positions whose trade details couldn't be built: the model reads them itself.
  const unbuilt = state.openTradesError && positions.length ? ` Open positions: ${positions.join(', ')} (trade details unavailable this cycle: ${state.openTradesError}; read list_open_positions and list_open_orders).` : '';
  return head + trades + unbuilt + attempts.join('');
}

const RECENT_IN_PROMPT = 10;

/** The last closed bars, oldest first, compact: "09:33 O 21500.25 H 21504 L 21498.5 C 21503.75 V 1200 c-o +3.5" (close minus open). */
function recentBarsText(symbol, bars, timeframe) {
  const list = (bars || []).slice(-RECENT_IN_PROMPT);
  if (!list.length) return '';
  const { zonedParts } = require('./trading/clock');
  const hhmm = t => { const p = zonedParts(new Date(t), 'America/New_York'); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
  const num = x => (Number.isFinite(x) ? Number(x.toFixed(4)) : '?');
  const rows = list.map(b => `${hhmm(b.t)} O ${num(b.o)} H ${num(b.h)} L ${num(b.l)} C ${num(b.c)} V ${b.v ?? '?'} c-o ${b.c >= b.o ? '+' : ''}${num(b.c - b.o)}`);
  return ` ${symbol} last ${list.length} closed ${timeframe}m bars (ET open time, oldest first): ${rows.join('; ')}.`;
}

/**
 * What fired on this bar, with its confluence and track record: "orb long
 * with cisd_ote [orb track record: ...]". A paper strategy is marked (the
 * gate refuses its live entry); in a manage-only cycle nothing new may be
 * entered, so nothing is listed; under a policy strategy's verdict the fired
 * strategies are its components, entered only as the verdict says.
 */
function signalsText(symbol, scan, { manageOnly = false, verdicts = [], notEntries = [], lane = false } = {}) {
  // Manage-only is stated once, in the instruction's mode.
  if (manageOnly) return '';
  // No scan: the reason is in the "Context unavailable" line.
  if (!Array.isArray(scan)) return '';
  const fired = scan.filter(r => r.candidate && r.direction && r.signal === 'rules');
  if (!fired.length) return ` ${symbol}: no rules strategy fired on this bar (the scan's candidates).`;
  const one = r => {
    const c = r.confluence || { with: [], against: [] };
    // Another lane's setup: its trend rule, which the roles' required lookups read as the briefing's (runner-lanes skill).
    const rule = lane ? candidateTrendRule(r) : null;
    return `${r.name} ${r.direction}${rule ? ` (trend rule: ${rule})` : ''}${r.status === 'paper' ? ' (paper: plan only, the gate refuses a live entry)' : ''}${notEntries.includes(r.name) ? ' (its policy has no verdict this bar: not an entry)' : ''}${c.with.length ? ` with ${c.with.join(', ')}` : ''}${c.against.length ? `; against ${c.against.join(', ')}` : ''}${(v => (v ? ` (${v})` : ''))(sideValuesText(r.rules && r.rules[r.direction]))}${r.record ? ` [${r.name} ${r.record}]` : ''}`;
  };
  const conflict = fired.some(r => r.confluence && r.confluence.against.length);
  // A failed screen is named once, in the "Context unavailable" line; the strategies it owns are marked above.
  const policy = notEntries.length ? ''
    : verdicts.length ? ` These are ${verdicts[0].strategy}'s components: enter only as its verdict below says (setup:${verdicts[0].strategy}), never as setup:<component>.` : '';
  return ` ${symbol} fired on this bar (scan candidates, already in session, regime, and the trend rule): ${fired.map(one).join(' | ')}.${conflict ? ' Strategies disagree on the side: stand aside unless one is a reversal at a higher-timeframe level and the plan says why.' : ''}${policy}`;
}

/** The decisions a prompt shows: the last RECENT_IN_PROMPT, or (`all`: several lanes, chosen per lane) every one. */
const shownDecisions = (history, all = false) => (all ? (history || []) : (history || []).slice(-RECENT_IN_PROMPT));

/** The history lines a prompt shows (historyText's), for the session record. */
const historyShownLines = (history, all = false, market = []) => historyLines(shownDecisions(history, all), market);

/**
 * Your last cycles' decisions, oldest first, one compact line each (trading/decision-history.js): the time, symbol
 * and lane, the action, the setup and side, the price, the reason, and what happened since, from the bars closed by
 * this cycle (`market`: decision-history marketOf). Repeated no-trades collapse into one line.
 * `all`: several lanes, the runner already chose the entries (lane-cycle.js laneHistory): every one is shown.
 */
function historyText(history, all = false, market = []) {
  const list = shownDecisions(history, all);
  if (!list.length) return '';
  let lines;
  try {
    lines = historyLines(list, market);
  } catch (err) {
    // A corrupt entry never costs the cycle its prompt: the section is named as unavailable.
    return ` Your last cycles: unavailable this cycle (${err.message}).`;
  }
  // Past conclusions, not facts (autonomous-trading skill): a wrong one must not steer later cycles against the facts.
  return ` Your last ${list.length} cycle(s)${all ? ' on the lanes that closed (with the first lane\'s last few, and those of the lane an open trade was entered on)' : ''}, oldest first, ET (not facts; "since" is from bars closed by now): ${lines.join(' | ')}. Don't flip-flop without a new reason.`;
}

// The roles a cycle runs before an entry (trade-session skill), which the order gate checks (roles-ran.js): each
// carries its skills (structure and liquidity, trend and momentum, VWAP and volume profile, sizing and pacing).
const ANALYST_ROLES = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'];
/**
 * The roles a cycle launches before an entry (trade-session skill), which the order gate checks (roles-ran.js): each
 * carries its skills (structure and liquidity, trend and momentum, VWAP and volume profile, sizing and pacing). Only
 * the roles still to run are named (a cached report is that role's report); phase 2 reviews a plan, so it runs only
 * when there is one.
 */
function roster(cfg, cachedRoles = [], frames = []) {
  const gate = ROLES_CHECKED.has(cfg.harness);
  const p1 = cachedRoles.includes('risk-manager') ? [] : ['risk-manager (phase 1)'];
  const p2 = 'then risk-manager phase 2 on your plan, if any';
  const tail = gate ? `; the gate refuses an entry until all report and phase 2 approves.` : '.';
  if (cfg.cycle === 'lean') return ` Lean cycle: on a candidate, ${p1.length ? 'risk-manager phase 1, ' : ''}${p2}${tail}`;
  if (cfg.cycle !== 'full') return '';
  const launch = [...ANALYST_ROLES.filter(r => !cachedRoles.includes(r)), ...p1];
  const list = launch.length > 1 ? `${launch.slice(0, -1).join(', ')} and ${launch[launch.length - 1]}` : launch[0];
  return ` Full cycle: ${launch.length ? `${list} as parallel subagents, ` : ''}plan from their reports, ${p2}${tail}${framesText(cfg, frames.filter(f => launch.includes(f.role)))}`;
}

/**
 * The analysts launched this cycle that read a timeframe of their own (runner config agents, lanes.js analystFrames):
 * the caller gives each its timeframe; it reads that timeframe's bar briefing and bars, and its report may be reused
 * until that timeframe's next bar close.
 */
function framesText(cfg, frames) {
  if (!frames.length) return '';
  const list = frames.map(f => `${f.role} on ${f.timeframe} (bar_briefing with "timeframe": "${f.timeframe}"; its bars file is named there)`).join(', ');
  return ` Each analyst reads its own timeframe: give it that timeframe with the symbol: ${list}; the others read the ${cfg.timeframe}-minute bars below. A report on an analyst's own timeframe holds until that timeframe's next bar close, so it may be up to one of its bars old.`;
}

/**
 * The reports the runner served from its report cache (report-cache.js): those roles aren't launched again this
 * cycle, and the order gate counts them as returned (FTH_CYCLE_CACHED).
 */
function cachedText(cached) {
  if (!cached || !Array.isArray(cached.reports) || !cached.reports.length) return '';
  const roles = cached.reports.map(r => (r.role === 'risk-manager' ? 'risk-manager (phase 1)' : r.role));
  // An analyst on its own timeframe (`tf`) holds until that timeframe's next bar close, said with its report.
  const until = cached.reports.filter(r => !r.tf).map(r => r.until).filter(Boolean).sort()[0];
  const own = cached.reports.filter(r => r.tf);
  const ownText = own.length ? ` A report on an analyst's own timeframe (${own.map(r => `${r.role} ${r.tf}`).join(', ')}) holds until that timeframe's next bar close, so it may be up to one of its bars old; take this bar's facts (the trigger, the VWAP side, the candidates) from the bar briefing.` : '';
  const from = r => (r.tf ? `${r.tf}, from ${etTime(r.at)}, holds until ${etTime(r.until)}` : `from ${etTime(r.at)}`);
  return ` Cached reports, still valid this bar (the runner's report cache: an analyst's report built on the bar briefing parts still current, risk-manager phase 1 on this account unchanged): don't launch ${roles.join(', ')} this cycle; the order gate counts them as returned.${until ? ` An analyst's 15m-and-up view holds until ${etTime(until)}; take this bar's 3m facts (the trigger, the VWAP side, the candidates) from the bar briefing.` : ''}${ownText} A cached report is that role's report this cycle: never send it back to a role to read, summarize or redo.`
    + cached.reports.map(r => `\n--- ${r.role === 'risk-manager' ? 'risk-manager phase 1' : r.role} report (${from(r)}) ---\n${String(r.text).trim()}\n--- end of ${r.role} report ---`).join('') + '\n';
}

// How the skills are loaded: Claude, opencode and Qwen Code have a skill tool (which the gate sees, skills-loaded.js);
// Codex reads them (it carries them in AGENTS.md); a custom harness, either.
const loadSkills = cfg => ({ codex: 'Read the skills', custom: 'Load the skills' }[cfg.harness] || 'With your skill tool, load');
// The skills an entry needs loaded (the order gate's skills-loaded check, REQUIRED_FOR_ENTRY), then the ones the head
// trader loads every cycle that the gate does not require (ALSO_LOAD: htf-to-ltf, the alignment labels and the reversal rule,
// trade-session step 0).
const ALSO_LOAD = ['htf-to-ltf'];
const andList = xs => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`);
/** The skills a cycle loads, as the prompt names them: "a, b, and c (the order gate refuses an entry without them); also load d and e". */
const loadList = (gated, required = REQUIRED_FOR_ENTRY, also = ALSO_LOAD) =>
  `${andList(required)}${gated ? ' (the order gate refuses an entry without them)' : ''}${also.length ? `; also load ${andList(also)}` : ''}`;

// Every cycle's prompt ends with what the runner reads back (cycleResult): the autonomous-trading skill's step 6.
// The outcomes a cycle may report (its result line's first word): the prompt and the autonomous-trading skill list
// these, and only these are a result (cycleOutcome); "error" is the agent's own failed cycle.
const CYCLE_OUTCOMES = ['no-trade', 'planned', 'executed', 'managed', 'flattened', 'blocked', 'error'];
const RESULT_TEMPLATE = `CYCLE RESULT: <${CYCLE_OUTCOMES.join(' | ')}> - <reason>`;
// The trader-process skill's checklist (its PLAN block, one line per step), named in every trade cycle's prompt by
// its first and last step only (the prompt's size budget; trade-session step 0 loads the skill with the block).
const PLAN_STEPS = ['HTF', 'Context', 'Location', 'Setup', 'Confluence', 'Entry', 'Risk', 'Decision', 'Manage'];
const PLAN_TEXT = ` Write the trader-process skill's PLAN (1 ${PLAN_STEPS[0]} to ${PLAN_STEPS.length} ${PLAN_STEPS[PLAN_STEPS.length - 1]}) before the result line.`;
const RESULT_LINE = ` End with the cycle result as plain text in your final message, never as a tool call. Your last line must be exactly: ${RESULT_TEMPLATE}.`;

/**
 * The start of every cycle's prompt (premarket, trade, end of day): what the cycle is and where the harness is, the
 * same every cycle of a run, so it is the shared prefix of consecutive prompts. Nothing that changes between cycles
 * (the time, the bar, the account) belongs in it.
 */
function stableHead(root = '') {
  const where = root ? ` Harness root (FTH_ROOT): ${root}; its operations are the \`${HARNESS_SERVER}\` MCP server's tools, not scripts. Harness home (FTH_HOME): ${harnessHome()}; the runner's logs (scans, events, alerts, gate decisions) are in its logs/ folder.` : '';
  return `Autonomous cycle. Follow the autonomous-trading skill. No user is present.${where}`;
}

function prompts(cfg, now, root = '') {
  const acct = cfg.account ? ` on account ${cfg.account}` : '';
  // What every cycle's prompt starts with, the same each cycle (stableHead), then the cycle's time: consecutive prompts
  // share this prefix, which a local model server's prompt cache reuses (nothing that changes between cycles before it).
  // New York time, as the bars, sessions, and strategies read it; UTC once, for tools that take it.
  const head = `${stableHead(root)} The cycle's time: ${etStamp(now)} (${now.toISOString()}).`;
  return {
    premarket: (symbol, { state = null } = {}) => `${head}${accountText(state)} Run the premarket skill for ${symbol}${acct}, for the trading day ending ${dayKey(now)} (from 18:00 ET the evening before until 16:00 ET that day): today's calendar means that day's.${RESULT_LINE}`,
    /**
     * One cycle for every symbol whose bar just closed. `items` is a symbol
     * string or a list of { symbol, bar } where bar = { t, c, file, contractId }.
     */
    trade: (items, { manageOnly = false, recovered = false, state = null, history = [], lessons = [], trades = [], tradesSummary = null, news = null, unavailable = [], cyclesLeft = null, manageAlso = [], journalRead = true, cached = null, unreviewed = null, lanes = '', frames = [] } = {}) => {
      const list = (Array.isArray(items) ? items : [{ symbol: items }]);
      const sentence = t => { const x = String(t).trim(); return /[.!?…]$/.test(x) ? x : `${x}.`; };
      // `minutes`: the lane whose bar closed (none: the runner's timeframe); `repeat`: a further lane of a symbol
      // already described this cycle, which adds only its own bars and signals.
      const bars = list.filter(x => x.bar).map(({ symbol, bar, scan, verdicts, notEntries, minutes = cfg.timeframe, repeat = false }) =>
        // The bar's close is the last of the recent bars below; the trend line is one sentence.
        ` ${symbol}: a ${minutes}-minute bar just closed (opened ${etTime(bar.t)}); closed ${minutes}-minute bars, oldest first, are in ${bar.file} (get_bars format; contractId ${bar.contractId}) - use that file for the ${minutes}-minute timeframe instead of fetching it.`
        + (repeat ? '' : bar.trend ? ` ${symbol} ${String(bar.trend).trim().replace(/\.$/, '')} (recorded for the order gate, which enforces it).` : ` ${symbol}: no multi-timeframe record this bar, so the gate refuses trend strategies' entries.`)
        + (bar.plan && !repeat ? ` ${sentence(bar.plan)}` : '')
        + (bar.day && !repeat ? ` ${sentence(bar.day)}` : '')
        + recentBarsText(symbol, bar.recent, minutes)
        + signalsText(repeat ? `${symbol} ${minutes}m` : symbol, scan, { manageOnly, verdicts: verdicts || [], notEntries: notEntries || [], lane: minutes !== cfg.timeframe }));
      const symbols = [...new Set(list.map(x => x.symbol))].join(', ');
      const mode = [
        cfg.paper ? 'paper mode (plan only, no orders)' : '',
        cfg.cycle === 'lean' ? 'lean cycle (see the trade-session skill)' : '',
        manageOnly ? 'manage-only (the daily cycle cap is reached: manage open positions and working orders, no new entries)' : '',
      ].filter(Boolean).join('; ');
      const recover = recovered ? ' The previous cycle was stopped before it finished: first confirm every open position has a working protective stop (list_open_positions, list_open_orders) and fix that before anything else.' : '';
      // A policy strategy's verdicts: the only entries the gate will accept (prop-challenge-pacing skill).
      const verdicts = list.flatMap(x => (x.verdicts || []).map(v => ({ ...v, symbol: x.symbol }))).map(v => (v.action === 'skip'
        ? ` ${v.symbol} ${v.strategy}: the ${v.direction} setup from ${v.component} is skipped (${v.reason || 'the policy'}); no entry.`
        : ` ${v.symbol} ${v.strategy}: ${v.direction} setup from ${v.component}, verdict ${v.action}: enter only as setup:${v.strategy}, ${v.contract} ${v.direction === 'long' ? 'buy' : 'sell'}, at most ${v.maxSize}, stopLossBracket {ticks: ${v.stopTicks}, type: "stop"}`
          + `${v.contract && v.contractId && contractRoot(v.contractId) !== v.contract ? ` (the contract is ${v.contract}, not ${v.contractId}: use contractId "${v.contract}" for the plan and the order)` : ''} (prop-challenge-pacing skill).`));
      // When the runner flattens, and how many trade cycles are left before manage-only (when few).
      const eod = endOfDayAt(cfg, now);
      const eodMs = eod ? tradingDayStart(now).getTime() + sessionMinuteOf(eod, now) * 60000 : null;
      const eodText = eodMs ? ` End of day: the runner flattens every position at ${etTime(eodMs)} (in ${Math.max(0, Math.round((eodMs - now.getTime()) / 60000))} min); a trade must have room to work before then.` : '';
      const capText = manageOnly || !Number.isInteger(cyclesLeft) || cyclesLeft > 10 ? ''
        : cyclesLeft === 0 ? ' This is the last trade cycle today; after it, cycles only manage.'
          : ` ${cyclesLeft} more trade cycle${cyclesLeft === 1 ? '' : 's'} today after this one, then manage-only.`;
      const account = cfg.account ? accountText(state) : ' No account is configured: the runner reads no positions or orders (read get_account_snapshot if you need them).';
      // "None yet" only when the journal was read and holds neither (a failed read is named instead).
      const ownFailed = unavailable.some(u => /reviewed trades|mistakes and lessons/.test(u));
      const own = trades.length ? ` Your last ${trades.length} reviewed trade(s)${tradesSummary ? ` (${tradesSummary})` : ''}, oldest first: ${trades.join(' | ')}.`
        : !journalRead || ownFailed ? ''
          : lessons.length ? ' No reviewed trades in the journal yet.'
            : ' No reviewed trades in the journal yet, so no record of your own results, mistakes, or lessons.';
      // A section that couldn't be built is named, so its absence isn't read as "nothing to say".
      const missing = unavailable.length ? ` Context unavailable this cycle (not "none"): ${unavailable.join('; ')}.` : '';
      const also = manageAlso.length ? `, and manage the open ${manageAlso.join(', ')} position${manageAlso.length === 1 ? '' : 's'} (no bar closed for ${manageAlso.length === 1 ? 'it' : 'them'} this cycle)` : '';
      return `${head}${recover}${lanes}${bars.join('')}${news ? ` ${news}` : ''}${eodText}${capText}${account}${verdicts.join('')}${historyText(history, Boolean(lanes), marketOf(list, cfg.timeframe))}${unreviewed ? ` ${unreviewed}` : ''}${own}${lessons.length ? ` Your recurring mistakes and lessons (confidence; notes from your own past, not rules): ${lessons.join(' | ')}.` : ''}${missing} ${loadSkills(cfg)} ${loadList(ROLES_CHECKED.has(cfg.harness))} before deciding, then run the trade-session skill for ${symbols}${new Set(list.map(x => x.symbol)).size > 1 ? ' (one symbol at a time, open positions first)' : ''}${also}${acct}${mode ? ` in ${mode}` : ''}.${PLAN_TEXT}${manageOnly || cfg.paper ? '' : `${roster(cfg, (cached && cached.roles) || [], frames)}${cachedText(cached)}`}${RESULT_LINE}`;
    },
    eod: ({ state = null, day = null } = {}) => {
      const d = day || dayKey(now);
      const catchUp = d !== dayKey(now) ? ` (a catch-up: that day's end of day did not run; review and reconcile ${d}, not today)` : '';
      return `${head}${accountText(state)} Run the end-of-day skill${acct} for the trading day ending ${d}${catchUp}, on ${cfg.timeframe}-minute bars (the reconcile tool with day ${d} and timeframe ${cfg.timeframe}): flatten every position and cancel working orders without asking, then review and summarize.${RESULT_LINE}`;
    },
  };
}

// Harnesses whose headless output streams the session as it happens (Claude stream-json, opencode JSON events).
const STREAMED_TRANSCRIPT = new Set(['claude', 'opencode']);
// Harnesses whose order gate sees the cycle's roles: the streamed transcript, or Qwen Code's hook (its chat file).
const ROLES_CHECKED = new Set([...STREAMED_TRANSCRIPT, 'qwen']);

// Roles outside the trading desk: a trade or manage cycle never launches them (the trade-session skill's roles only).
const OFF_DESK = ['strategy-researcher'];

/**
 * The roles a cycle may not launch, which the harness enforces where it can (opencode: per-run permissions): the
 * analysts whose report the runner served from its cache (their report is in the prompt; risk-manager stays, for
 * phase 2), and in a trade or manage cycle the roles outside the trading desk.
 */
function deniedRoles(context) {
  const c = context || {};
  const cached = (c.cachedRoles || []).filter(r => typeof r === 'string' && r !== 'risk-manager');
  return [...cached, ...(['trade', 'manage'].includes(c.action) ? OFF_DESK : [])];
}

/** Environment for a harness run: root, autonomous lock-down, the bar directory, and paper mode. */
function childEnv(cfg, root, base = process.env, context = null) {
  // The gate learns the exchange calendar from the runner's config.
  const env = { ...base, FTH_ROOT: root, FTH_AUTONOMOUS: '1', FTH_CLOSED_DATES: cfg.closedDates.join(','), FTH_EARLY_CLOSE_DATES: cfg.earlyCloseDates.join(',') };
  // The selected contracts (its symbols, one per index): the gate, order_plan and the scan trade only these legs.
  env.FTH_SYMBOLS = cfg.symbols.join(',');
  // The harness tools read bars files from the runner's bar directory (harness-tools/paths.js).
  env.FTH_BARS_DIR = resolveDataDir(cfg, os.homedir(), base);
  // The cycle's kind and, for a harness that streams its transcript, where the runner writes it as it
  // streams: the gateway reads which skills loaded and which roles ran from it (roles-ran.js).
  env.FTH_CYCLE = cfg.cycle;
  // A file of this run's own (a concurrent --once run never shares it), removed when the run ends (harness-run.js).
  if (STREAMED_TRANSCRIPT.has(cfg.harness)) env.FTH_CYCLE_TRANSCRIPT = path.join(harnessHome(base), 'logs', `cycle-transcript-${process.pid}-${crypto.randomBytes(6).toString('hex')}.jsonl`);
  else delete env.FTH_CYCLE_TRANSCRIPT;
  // The bar each symbol's cycle decides ({"MNQ": "<bar open time>"}): the bar briefing for that bar is this cycle's,
  // however long the cycle runs (harness-tools/briefing.js).
  const bars = ((context && context.symbols) || []).filter(x => x && x.symbol && x.bar && x.bar.t).map(x => [x.symbol, x.bar.t]);
  if (bars.length) env.FTH_CYCLE_BARS = JSON.stringify(Object.fromEntries(bars));
  else delete env.FTH_CYCLE_BARS;
  // Several lanes: the bar each symbol's bar briefing is on (cycleBars: the first lane's), whichever lane's bar closed,
  // so bar_briefing serves it as this cycle's (the other tools' read-once checks keep FTH_CYCLE_BARS).
  const briefed = context && context.cycleBars ? Object.entries(context.cycleBars).filter(([s, t]) => s && typeof t === 'string') : [];
  if (briefed.length) env.FTH_CYCLE_BRIEFING_BARS = JSON.stringify(Object.fromEntries(briefed));
  else delete env.FTH_CYCLE_BRIEFING_BARS;
  // Several lanes: each symbol's lanes whose bar closed this cycle ({"MNQ": {"1": "<bar open>"}}): in index mode the
  // gate reads their candidates for the required lookups (trading/skill-lookups.js cycleFacts).
  const laneBars = {};
  for (const x of ((context && context.symbols) || [])) {
    const m = x && x.symbol && x.bar && typeof x.bar.t === 'string' ? /^(\d+)m$/.exec(String(x.lane || '')) : null;
    if (m) laneBars[x.symbol] = { ...(laneBars[x.symbol] || {}), [m[1]]: x.bar.t };
  }
  if (Object.keys(laneBars).length) env.FTH_CYCLE_LANE_BARS = JSON.stringify(laneBars);
  else delete env.FTH_CYCLE_LANE_BARS;
  // An analyst on its own timeframe reads the briefing of that timeframe's bar holding at the cycle's start.
  if (context && typeof context.cycleAt === 'string') env.FTH_CYCLE_AT = context.cycleAt;
  else delete env.FTH_CYCLE_AT;
  // The roles served from the report cache this cycle (their reports are in the prompt): roles-ran counts them.
  const cachedRoles = ((context && context.cachedRoles) || []).filter(r => typeof r === 'string');
  if (cachedRoles.length) env.FTH_CYCLE_CACHED = cachedRoles.join(',');
  else delete env.FTH_CYCLE_CACHED;
  // How the roles' prompts carry their skills (role-skills.js), which the gate reads (index mode enforces the lookups):
  // only opencode embeds skills in its roles (its mode, index by default, below); every other harness's roles load
  // all their skills as their body says, which is full.
  env.FTH_ROLE_SKILLS = 'full';
  if (cfg.paper) {
    env.FTH_PAPER = '1';
    // The broker server's own switch, from the broker config (paperEnv): it refuses every order too.
    Object.assign(env, activeBroker(env).paperEnv);
  }
  // opencode: reading the runner's directories (the committed workspace/opencode.json can't name them) and its lock-down.
  if (cfg.harness === 'opencode') {
    // How its roles' prompts carry their skills (role-skills.js; index by default): the gate enforces index mode's lookups.
    env.FTH_ROLE_SKILLS = require('./role-skills').modeOf(base);
    const agents = require('./harness-sync').loadAgents(path.resolve(__dirname, '..', '..'));
    return opencode.runEnv(env, { root, dataDir: env.FTH_BARS_DIR, stateDir: harnessHome(base), agents, dir: path.resolve(root, cfg.workdir), deniedRoles: deniedRoles(context) });
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
        '--disallowedTools', claudeDenied(root, { stateDir: harnessHome(env), journal: activeBroker(env).journalPath }).join(','),
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
    case 'opencode':
      // JSON events (cycle-log.js). Headless, anything workspace/opencode.json doesn't allow is refused;
      // the model is the user's opencode default unless the config names one (provider/model).
      // --dir: opencode takes its project directory from PWD, not the working directory the runner sets.
      // --agent: the harness's head trader, whose permissions no user config for opencode's own agents changes.
      return ['opencode', 'run', '--format', 'json', '--dir', path.resolve(root, cfg.workdir), '--agent', opencode.HEAD_AGENT, ...(model ? ['--model', model] : []), ...extra, prompt];
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
  // A previous trading day that traded, or whose end of day was tried, but
  // never finished end of day (runner down, crash, not verified flat):
  // flatten first, whatever the time.
  if (state && state.day !== key && !state.eodDone && (state.cycles > 0 || state.premarketDone || state.eodAttempted)) {
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

// A harness transcript's event types (Claude stream-json and Qwen JSON; Codex --json; opencode's by its whole
// envelope, transcript.js isOpencodeEvent): any other JSON line (an echoed order, a stderr warning) is plain
// text, so it never hides a plain-text run's result line.
const TRANSCRIPT_EVENT = /^(?:system|assistant|user|result|(?:item|turn|thread)\.[a-z_.]+)$/;

/**
 * The run's final message: { structured, final }. `structured`: the output is a harness transcript
 * (Claude stream-json, Qwen JSON, Codex --json events, opencode JSON events); `final`: its final message
 * (Claude's and Qwen's { type: 'result', result }, Codex's last agent message, opencode's text parts after
 * its last step start or tool call), or null when it has none (a run cut short).
 */
function finalMessage(output) {
  let final = null;
  let structured = false;
  let texts = []; // opencode: the text parts since its last step start or tool call
  for (const doc of documents(output)) {
    for (const ev of Array.isArray(doc) ? doc : [doc]) {
      if (isOpencodeEvent(ev)) {
        structured = true;
        // The model's own text (not one opencode added); a later step or tool call means it went on after it.
        if (ev.type === 'text' && typeof ev.part.text === 'string' && !ev.part.synthetic && !ev.part.ignored) texts.push(ev.part.text);
        else if (ev.type === 'tool_use' || ev.type === 'step_start') texts = [];
        final = texts.length ? texts.join('\n') : null;
        continue;
      }
      if (!ev || typeof ev !== 'object' || !TRANSCRIPT_EVENT.test(ev.type)) continue;
      structured = true;
      if (ev.type === 'result' && typeof ev.result === 'string') final = ev.result;
      const item = ev.type === 'item.completed' && ev.item;
      if (item && (item.type === 'agent_message' || item.type === 'assistant_message') && typeof item.text === 'string') final = item.text;
    }
  }
  return { structured, final };
}

/** A result line's body without markdown emphasis or code marks; '' when nothing is left. */
const resultBody = raw => String(raw).replace(/\*\*|__|`/g, '').replace(/^[*_\s]+|[*_\s]+$/g, '').trim();

/**
 * The last "CYCLE RESULT: <outcome> - <reason>" line the model reported, if any: in its final message
 * when the output is a transcript (so a prompt, skill text, or tool output echoed earlier never counts;
 * a transcript without a final message, a run cut short, reported none), else anywhere in a plain-text
 * run's output. Trivial formatting is tolerated (leading spaces, markdown bold, italics or code around
 * the line, the label, or the body); the label is exact, and a line with no body or the template
 * ("CYCLE RESULT: <no-trade | ...> - <reason>") is not a result.
 */
function cycleResult(output) {
  const { structured, final } = finalMessage(output);
  if (structured && final === null) return null;
  // In raw text a line ends at a newline, or (JSON text) at an escaped newline or a closing quote.
  const found = final === null
    ? [...String(output || '').matchAll(/CYCLE RESULT:[*_` \t]*([^\n"\\]*)/g)]
    : [...final.matchAll(/CYCLE RESULT:[*_` \t]*([^\n]*)/g)];
  const results = found.map(m => resultBody(m[1])).filter(body => body && !body.startsWith('<'));
  return results.length ? `CYCLE RESULT: ${results[results.length - 1]}` : null;
}

/**
 * What a cycle returns to the runner: ok, its result line and exit code, and its transcript, the standard output
 * alone (what the gate reads), that the runner records the roles' reports from (report-cache.js).
 * A premarket or trade run failed (in every harness) when it exited non-zero, when it changed the workspace (the
 * guard), when it exited 0 without a parseable CYCLE RESULT line (a provider error, a model that stopped early),
 * when its final result line's outcome isn't one of CYCLE_OUTCOMES (read from its standard output alone: never
 * stderr), or when it reported "CYCLE RESULT: error": it counts toward maxConsecutiveErrors once, as a failed exit does.
 * An agent-reported error is marked agentError: a decision, which a replay records as live does and never retries.
 * An end-of-day run is judged by its exit alone, live and in replay alike: the day is judged by the runner's own
 * flatten (verified flat), never by the agents' result line or the workspace guard (its verdict is in the kill switch).
 */
function cycleOutcome(res, { result, intact, action }) {
  const line = cycleResult(agentOutput(res));
  const word = outcomeOf(line);
  const reported = word !== null && word !== 'error';
  // The agent's own error result: a decision (counted as live counts it), not an infrastructure failure.
  const agentError = Boolean(res.ok && word === 'error');
  return { ok: res.ok && (action === 'eod' || (reported && intact)), timedOut: res.timedOut, result, code: res.code ?? null, transcript: res.stdout || '', ...(agentError ? { agentError: true } : {}) };
}

/** What the agent said: its standard output alone when the run kept it apart (never stderr), else its output. */
const agentOutput = res => (typeof res.stdout === 'string' ? res.stdout : res.output);

/**
 * The outcome word of a result line ("no-trade") when it is exactly one of CYCLE_OUTCOMES, else null. Markdown
 * marks around it (*no-trade*, _blocked_, `managed`) and the punctuation after it (":", ",", ".") are tolerated;
 * the word is matched in any letter case (the set is closed: "Managed" is managed), returned as the prompt writes
 * it (lower case), never a longer one (no-trades, blocked2).
 */
function outcomeOf(line) {
  const m = /^CYCLE RESULT:\s*([A-Za-z-]+)(?![A-Za-z0-9-])/.exec(String(line || '').replace(/[*_`]/g, ''));
  const word = m ? m[1].toLowerCase() : null;
  return CYCLE_OUTCOMES.includes(word) ? word : null;
}

/** The result a run is logged with: a failed run's error (whatever it wrote), else its line, else "(none reported)". */
function runResult(res) {
  if (!res.ok) return `CYCLE RESULT: error - ${res.timedOut ? 'timed out' : `exit ${res.code}`}`;
  return cycleResult(agentOutput(res)) || 'CYCLE RESULT: (none reported)';
}

const RUNNER_VALUE_FLAGS = ['--config', '--once', '--symbol', '--stale-minutes'];
const RUNNER_BOOL_FLAGS = ['--dry-run', '--status'];
const RUNNER_USAGE = 'usage: autotrader.js --config <file.json> [--once premarket|trade|eod] [--symbol X] [--dry-run] | --status [--stale-minutes N]';

/**
 * The runner's argv, checked: only its own flags (--flag value or --flag=value), each once, nothing else.
 * A typo (--dryrun, --ONCE, --dry-run=true) must never fall through to the live autonomous loop.
 * Returns the argv in the --flag value form.
 */
function runnerArgv(argv) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = String(argv[i]).split(/=(.*)/s);
    const twice = () => new Error(`${flag} given twice (${RUNNER_USAGE})`);
    if (RUNNER_VALUE_FLAGS.includes(flag)) {
      const value = inline !== undefined ? inline : argv[i + 1];
      if (inline === undefined) i += 1;
      if (value === undefined || value === '' || String(value).startsWith('--')) throw new Error(`${flag} needs a value (${RUNNER_USAGE})`);
      if (seen.has(flag)) throw twice();
      seen.add(flag);
      out.push(flag, String(value));
    } else if (RUNNER_BOOL_FLAGS.includes(flag) && inline === undefined) {
      if (seen.has(flag)) throw twice();
      seen.add(flag);
      out.push(flag);
    } else {
      throw new Error(`unknown argument: ${String(argv[i]).slice(0, 60)} (${RUNNER_USAGE})`);
    }
  }
  const once = out[out.indexOf('--once') + 1];
  if (seen.has('--once') && !['premarket', 'trade', 'eod'].includes(once)) throw new Error('--once must be premarket, trade, or eod');
  // Flags that only mean something with another: alone they would be ignored and the live loop would start.
  if (seen.has('--symbol') && !seen.has('--once')) throw new Error(`--symbol goes with --once (one manual cycle) (${RUNNER_USAGE})`);
  if (seen.has('--stale-minutes') && !seen.has('--status')) throw new Error(`--stale-minutes goes with --status (${RUNNER_USAGE})`);
  const others = ['--config', '--once', '--symbol', '--dry-run'].filter(f => seen.has(f));
  if (seen.has('--status') && others.length) throw new Error(`--status checks the running runner and takes only --stale-minutes, not ${others.join(', ')} (${RUNNER_USAGE})`);
  return out;
}

module.exports = {
  loadList,
  stableHead,
  CYCLE_OUTCOMES,
  RESULT_TEMPLATE,
  outcomeOf,
  runnerArgv,
  deniedRoles,
  cycleOutcome,
  accountText,
  historyText,
  historyShownLines,
  endOfDayAt,
  marketHoursErrors,
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
  PLAN_STEPS,
  buildCommand,
  dayKey,
  decide,
  recordRun,
  cycleResult,
  runResult,
  signalDecision,
};
