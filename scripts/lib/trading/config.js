'use strict';

/**
 * Harness discipline settings, read from the hook environment. Set them in the
 * `env` block of ~/.claude/settings.json (or the project's .claude/settings.json).
 * These sit on top of the projectx-mcp server guardrails; they never loosen them.
 */

const path = require('path');
const { harnessHome } = require('../paths');

// Empty: the whole market session (18:00-16:00 ET, a hard limit in the gate).
// Strategies narrow their own hours with `sessions` (e.g. [ny]).
const DEFAULT_ENTRY_HOURS = '';
const DEFAULT_NO_ENTRY_WINDOWS = [
  '09:30-09:35@America/New_York', // opening print: first 5 minutes of the New York cash session
  '15:45-16:00@America/New_York', // into end of day and the 16:00 ET close
].join(',');

const GATE_CHECKS = [
  'paper-mode',
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
];

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

const STARTED_AT = Date.now();

/**
 * The gate's clock. The test suite (NODE_ENV=test) may shift it with
 * FTH_TEST_NOW (an ISO time the process starts at); never otherwise, and
 * never in autonomous runs, where the gate is locked.
 */
function gateNow(env = process.env) {
  const t = Date.parse(String(env.FTH_TEST_NOW || ''));
  if (env.NODE_ENV !== 'test' || env.FTH_AUTONOMOUS === '1' || !Number.isFinite(t)) return new Date();
  return new Date(Date.now() + (t - STARTED_AT));
}

function loadConfig(env = process.env) {
  return {
    planMaxAgeMin: intEnv(env, 'FTH_PLAN_MAX_AGE_MIN', 120, { min: 1 }),
    maxConsecutiveLosses: intEnv(env, 'FTH_MAX_CONSECUTIVE_LOSSES', 2, { min: 1 }),
    lossCooldownMin: intEnv(env, 'FTH_LOSS_COOLDOWN_MIN', 30),
    maxDailyLosses: intEnv(env, 'FTH_MAX_DAILY_LOSSES', 3, { min: 1 }),
    maxEntriesPerDay: intEnv(env, 'FTH_MAX_ENTRIES_PER_DAY', 6), // 0 = off
    // How old the multi-timeframe record may be (minutes after its last bar closed).
    mtfMaxAgeMin: intEnv(env, 'FTH_MTF_MAX_AGE_MIN', 15, { min: 1 }),
    // Open equity-index positions in one direction across indexes (MNQ, MES, MYM, M2K and minis), the new one included.
    maxCorrelatedPositions: intEnv(env, 'FTH_MAX_CORRELATED_POSITIONS', 1, { min: 1 }),
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
    // Paper mode: every new entry is refused (plans, reviews, and exits still work).
    paper: env.FTH_PAPER === '1',
    skipChecks: env.FTH_AUTONOMOUS === '1' ? new Set() : listEnv(env, 'FTH_ORDER_GATE_SKIP'),
    // Exchange calendar (trading days, YYYY-MM-DD of the day they end on):
    // holidays with no session, and early closes at 13:00 ET.
    closedDates: new Set(String(env.FTH_CLOSED_DATES || '').split(',').map(s => s.trim()).filter(Boolean)),
    earlyCloseDates: new Set(String(env.FTH_EARLY_CLOSE_DATES || '').split(',').map(s => s.trim()).filter(Boolean)),
  };
}

module.exports = {
  gateNow,
  DEFAULT_NO_ENTRY_WINDOWS,
  DEFAULT_ENTRY_HOURS,
  GATE_CHECKS,
  loadConfig,
};
