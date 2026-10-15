'use strict';

/**
 * Harness discipline settings, read from the hook environment. Set them in the
 * `env` block of ~/.claude/settings.json (or the project's .claude/settings.json).
 * These sit on top of the broker MCP server's guardrails; they never loosen them.
 */

const { MAX_AGE_CEILING_MIN } = require('./signal-state');
// The gate's defaults (config/runner.json `gate`, tighten-only there; tests/lib/tunables.test.js holds each).
const G = require('../tunables').runner().gate;
const path = require('path');
const { harnessHome } = require('../paths');
const { exchangeCalendar, calendarEnd } = require('./exchange-calendar');
const { selectionOf, familyRoot } = require('./contracts');
const { loadRoundSteps } = require('./round-numbers');

// The roles whose report the runner may serve from its cache (report-cache.js): the analysts and risk-manager phase 1.
const CACHEABLE = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'];

// Empty: the whole market session (18:00-16:00 ET, a hard limit in the gate).
// Strategies narrow their own hours with `sessions` (e.g. [ny]).
const DEFAULT_ENTRY_HOURS = '';
// The opening print (the first 5 minutes of the New York cash session) and into end of day and the 16:00 ET close.
const DEFAULT_NO_ENTRY_WINDOWS = G.noEntryWindows.join(',');

const GATE_CHECKS = [
  'paper-mode',
  'roles-ran',
  'journal-window',
  'kill-switch',
  'setup-tag',
  'strategy',
  'stop-defined',
  'plan-required',
  'time-window',
  'modify-entry',
  'modify-protection',
  'blackout',
  'loss-streak',
  'daily-loss-count',
  'review-before-next-entry',
  'max-entries',
  'replay-clock', // hard: listed for completeness, never skippable
  'account-lock', // hard: listed for completeness, never skippable
];

/** FTH_CYCLE_BARS as { <family root>: <bar open time> } ({} when unset or unreadable). */
function cycleBarsOf(raw) {
  try {
    const o = JSON.parse(raw || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([, t]) => typeof t === 'string').map(([k, t]) => [familyRoot(k), t])) : {};
  } catch (_err) {
    return {};
  }
}

/**
 * FTH_CYCLE_LANE_BARS ({"MNQ": {"1": "<bar open>"}}): the lanes' bars that closed this cycle, by family root and
 * minutes. Unset or blank: {} (one lane). Set but not that shape: null, which the lookups read as unknown lanes, so
 * every situational lookup is required (fails closed).
 */
function cycleLaneBarsOf(raw) {
  if (raw === undefined || String(raw).trim() === '') return {};
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const out = {};
    for (const [k, lanes] of Object.entries(o)) {
      if (!lanes || typeof lanes !== 'object' || Array.isArray(lanes)) return null;
      const entries = Object.entries(lanes);
      if (entries.some(([m, t]) => !/^[1-9]\d{0,3}$/.test(m) || typeof t !== 'string')) return null;
      out[familyRoot(k)] = { ...(out[familyRoot(k)] || {}), ...Object.fromEntries(entries) };
    }
    return out;
  } catch (_err) {
    return null;
  }
}

/**
 * FTH_CYCLE_CACHED_LOOKUPS ({"market-structure-analyst": {"skills": ["breakout"], "key": "<facts key>"}}, set by the
 * runner): for each role served from the report cache, the skills its cached report's own call looked up and the facts
 * key they were required under (report-cache.js, skill-lookups.js factsKey). Only roles in `cached`, skill names and a
 * key; anything else, or an unreadable value, is none (every required lookup stays required: fails closed).
 */
function cycleCachedLookupsOf(raw, cached = []) {
  if (raw === undefined || String(raw).trim() === '') return {};
  let o;
  try { o = JSON.parse(raw); } catch (_err) { return {}; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out = {};
  for (const role of cached) {
    const e = Object.prototype.hasOwnProperty.call(o, role) ? o[role] : null;
    if (!e || typeof e !== 'object' || !Array.isArray(e.skills) || typeof e.key !== 'string' || !e.key) continue;
    out[role] = { skills: e.skills.filter(s => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s)), key: e.key };
  }
  return out;
}

function intEnv(env, name, fallback, { min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

function listEnv(env, name) {
  return new Set(
    String(env[name] || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Two loss-streak mechanisms, both kept, documented here (the one place that says how they differ):
 * - the order gate's cooldown: after MAX_CONSECUTIVE_LOSSES losing trades in a row in a trading day (FTH_MAX_CONSECUTIVE_LOSSES
 *   overrides), no new entry for FTH_LOSS_COOLDOWN_MIN minutes, on every account and every strategy (order-gate.js,
 *   account-gate.js; the backtester and the attempt simulator apply it as the gate does);
 * - an account's session stop: after its rulebook's loss_streak_stop losing trades in a row in a session, no new entry
 *   until the next session (accounts/<name>/RULEBOOK.md, combine.js entryBlock).
 * MAX_CONSECUTIVE_LOSSES is the cooldown's default, its one home. Tighten-only: it may only go down, and no shipped
 * rulebook's loss_streak_stop may be above it, so the session stop never waits for more losses than the cooldown
 * (tests/lib/one-home.test.js holds both). A loss extends both streaks, a win ends them, a scratch does neither.
 */
const MAX_CONSECUTIVE_LOSSES = G.maxConsecutiveLosses;

function loadConfig(env = process.env) {
  return {
    planMaxAgeMin: intEnv(env, 'FTH_PLAN_MAX_AGE_MIN', G.planMaxAgeMin, { min: 1 }),
    // Tighten-only here too: the env may lower the streak, never raise it past the config's (pinned) value.
    maxConsecutiveLosses: Math.min(intEnv(env, 'FTH_MAX_CONSECUTIVE_LOSSES', MAX_CONSECUTIVE_LOSSES, { min: 1 }), MAX_CONSECUTIVE_LOSSES),
    lossCooldownMin: intEnv(env, 'FTH_LOSS_COOLDOWN_MIN', G.lossCooldownMin),
    maxDailyLosses: intEnv(env, 'FTH_MAX_DAILY_LOSSES', G.maxDailyLosses, { min: 1 }),
    maxEntriesPerDay: intEnv(env, 'FTH_MAX_ENTRIES_PER_DAY', G.maxEntriesPerDay), // 0 = off
    // How old the multi-timeframe record may be (minutes after its last bar closed).
    mtfMaxAgeMin: intEnv(env, 'FTH_MTF_MAX_AGE_MIN', G.mtfMaxAgeMin, { min: 1 }),
    // How long after its bar closed a rules strategy's signal may still be entered, in bars of the signal's own
    // timeframe (signal-state.js signalMaxAgeMin: 3 bars is 3 min on 1m, 9 min on 3m, 45 min on 15m).
    signalMaxAgeBars: intEnv(env, 'FTH_SIGNAL_MAX_AGE_BARS', G.signalMaxAgeBars, { min: 1 }),
    // A cap in minutes over that, only when set (the flat limit this replaced): it only ever shortens the age.
    signalMaxAgeCapMin: intEnv(env, 'FTH_SIGNAL_MAX_AGE_MIN', null, { min: 1 }),
    // The owner's ceiling over the bars, whatever the timeframe (signal-state.js MAX_AGE_CEILING_MIN): no setting.
    signalMaxAgeCeilingMin: MAX_AGE_CEILING_MIN,
    // Strategies that must fire the same side for a rules entry (the entry's own included), as the backtest's minConfluence.
    minConfluence: intEnv(env, 'FTH_MIN_CONFLUENCE', G.minConfluence, { min: 1 }),
    // Open equity-index positions in one direction across indexes (MNQ, MES, MYM, M2K and minis), the new one included.
    maxCorrelatedPositions: intEnv(env, 'FTH_MAX_CORRELATED_POSITIONS', G.maxCorrelatedPositions, { min: 1 }),
    // Entries only inside these windows (empty = any time). Default: the
    // runner's default session, so a strategy without its own sessions still
    // can't open trades overnight.
    entryHours: env.FTH_ENTRY_HOURS !== undefined ? String(env.FTH_ENTRY_HOURS) : DEFAULT_ENTRY_HOURS,
    noEntryWindows: env.FTH_NO_ENTRY_WINDOWS !== undefined
      ? String(env.FTH_NO_ENTRY_WINDOWS)
      : DEFAULT_NO_ENTRY_WINDOWS,
    blackoutsFile: String(env.FTH_BLACKOUTS_FILE || '').trim()
      // Its own directory, so a sandboxed harness (Codex) can be given write
      // access to blackouts without access to the kill switch or the gate log.
      || path.join(harnessHome(env), 'blackouts', 'blackouts.json'),
    // Prop-challenge state (combine/<account>.json, policy-verdicts.jsonl).
    home: harnessHome(env),
    killSwitchFile: String(env.FTH_KILL_SWITCH_FILE || '').trim()
      || path.join(harnessHome(env), 'STOP'),
    // Set by the autonomous runner for the harness it launches. In autonomous
    // runs nothing may switch gate checks off from inside the session.
    autonomous: env.FTH_AUTONOMOUS === '1',
    // The autonomous cycle's kind (FTH_CYCLE, set by the runner): which roles must report before an entry (roles-ran.js).
    cycle: ['full', 'lean'].includes(env.FTH_CYCLE) ? env.FTH_CYCLE : null,
    // The cycle's transcript as the harness streams it (FTH_CYCLE_TRANSCRIPT, set by the runner): the gateway's
    // view of which skills loaded and which roles ran (a hook passes its own transcript_path instead).
    cycleTranscript: String(env.FTH_CYCLE_TRANSCRIPT || '').trim() || null,
    // The runner's attestation of the skills opencode's head trader has embedded in its prompt (FTH_HEAD_PROMPT, index
    // mode only; head-prompt.js), as given: the gate parses and checks it against the run's config file per entry.
    headPromptAttestation: String(env.FTH_HEAD_PROMPT || '').trim() || null,
    // How the roles' prompts carry their skills (FTH_ROLE_SKILLS, role-skills.js; the runner sets it for every harness:
    // opencode's mode, full for the others, whose roles load every skill as their body says): in index mode, the
    // default, a role's report counts only with the lookups the bar requires (skill-lookups.js). Only an explicit
    // full is full: unset, blank or a value that isn't a mode is read as index, the strictest.
    roleSkills: String(env.FTH_ROLE_SKILLS || '').trim() === 'full' ? 'full' : 'index',
    // The roles the runner served from its report cache this cycle (FTH_CYCLE_CACHED, report-cache.js): roles-ran
    // counts them as returned. Only role names the cache can hold; anything else is ignored.
    cycleCached: String(env.FTH_CYCLE_CACHED || '').split(',').map(x => x.trim()).filter(x => CACHEABLE.includes(x)),
    // Index mode: the skills each cached role's report looked up in the call that produced it (FTH_CYCLE_CACHED_LOOKUPS,
    // set by the runner from the cache): they count as this cycle's lookups for that role (skill-lookups.js lookupRule).
    cycleCachedLookups: cycleCachedLookupsOf(env.FTH_CYCLE_CACHED_LOOKUPS, String(env.FTH_CYCLE_CACHED || '').split(',').map(x => x.trim()).filter(x => CACHEABLE.includes(x))),
    // The bar each symbol's cycle decides (FTH_CYCLE_BARS, set by the runner: {"MNQ": "<bar open time>"}), keyed by
    // family root: phase 2's facts are checked against that bar's briefing (fact-claims.js). Unreadable: none.
    cycleBars: cycleBarsOf(env.FTH_CYCLE_BARS),
    // Several lanes: the bar each symbol's bar briefing is on (FTH_CYCLE_BRIEFING_BARS, the first lane's), whichever
    // lane's bar closed: the briefing the cycle's lookups are judged by (skill-lookups.js briefingHolds). Unreadable: none.
    cycleBriefingBars: cycleBarsOf(env.FTH_CYCLE_BRIEFING_BARS),
    // Several lanes (FTH_CYCLE_LANE_BARS, set by the runner): each symbol's lanes whose bar closed this cycle, by minutes,
    // { ROOT: { minutes: "<bar open>" } }: in index mode their candidates trigger lookups too (skill-lookups.js).
    cycleLaneBars: cycleLaneBarsOf(env.FTH_CYCLE_LANE_BARS),
    // The contracts the user selected (FTH_SYMBOLS; the runner sets it from its symbols): a rules
    // strategy trades only the selected leg of a micro/mini family (strategies.js rootRefusal).
    // Unset in an autonomous run, the selection is lost: an error, every entry refused.
    selection: selectionOf(env),
    // Paper mode: every new entry is refused (plans, reviews, and exits still work).
    paper: env.FTH_PAPER === '1',
    // The runner's account lock (FTH_ACCOUNT_LOCK, account-lock.js lockSpec): its files and token, or 'none' for a
    // cycle that runs without it. Unset outside the runner. A hard check: entries only while the runner holds it.
    accountLock: String(env.FTH_ACCOUNT_LOCK || '').trim() || null,
    skipChecks: env.FTH_AUTONOMOUS === '1' ? new Set() : listEnv(env, 'FTH_ORDER_GATE_SKIP'),
    // Exchange calendar (trading days, YYYY-MM-DD of the day they end on): holidays with no
    // session, and early closes at 13:00 ET. The built-in CME calendar (exchange-calendar.js)
    // plus any configured dates: configuration can add days, never remove one.
    ...exchangeCalendar({ closed: env.FTH_CLOSED_DATES, early: env.FTH_EARLY_CLOSE_DATES }),
    // The last trading day the calendar covers: no entries after it (holidays unknown).
    calendarEnds: calendarEnd({ closed: env.FTH_CLOSED_DATES, early: env.FTH_EARLY_CLOSE_DATES }),
    // The bar briefing's round-number steps per contract family (round-numbers.js): config/round-numbers.json
    // under <FTH_HOME>/round-numbers.json; { steps, errors }, a refused entry's family off.
    roundSteps: loadRoundSteps(env),
    // A refused config file (tunables.js critical()): its CRITICAL error text, or null. Every new entry is refused with
    // it (check-order.js, account-gate.js); exits, protective stops, cancels and closes still go. Never skippable.
    configCritical: (c => (c ? c.message : null))(require('../tunables').critical()),
  };
}

module.exports = {
  DEFAULT_NO_ENTRY_WINDOWS,
  DEFAULT_ENTRY_HOURS,
  GATE_CHECKS,
  MAX_CONSECUTIVE_LOSSES,
  cycleLaneBarsOf,
  loadConfig,
};
