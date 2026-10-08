'use strict';

/**
 * Harness discipline settings, read from the hook environment. Set them in the
 * `env` block of ~/.claude/settings.json (or the project's .claude/settings.json).
 * These sit on top of the projectx-mcp server guardrails; they never loosen them.
 */

const path = require('path');
const { harnessHome } = require('../paths');

const DEFAULT_ENTRY_HOURS = '09:35-15:00@America/New_York';
const DEFAULT_NO_ENTRY_WINDOWS = [
  '09:30-09:35@America/New_York', // opening print: first 5 minutes of RTH
  '15:00-18:00@America/Chicago', // into Topstep's 15:10 CT flatten, through the daily break
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
 * The gate's clock. Tests may shift it with FTH_TEST_NOW (an ISO time the
 * process starts at); never in autonomous runs, where the gate is locked.
 */
function gateNow(env = process.env) {
  const t = Date.parse(String(env.FTH_TEST_NOW || ''));
  if (env.FTH_AUTONOMOUS === '1' || !Number.isFinite(t)) return new Date();
  return new Date(Date.now() + (t - STARTED_AT));
}

function loadConfig(env = process.env) {
  return {
    planMaxAgeMin: intEnv(env, 'FTH_PLAN_MAX_AGE_MIN', 120, { min: 1 }),
    maxConsecutiveLosses: intEnv(env, 'FTH_MAX_CONSECUTIVE_LOSSES', 2, { min: 1 }),
    lossCooldownMin: intEnv(env, 'FTH_LOSS_COOLDOWN_MIN', 30),
    maxDailyLosses: intEnv(env, 'FTH_MAX_DAILY_LOSSES', 3, { min: 1 }),
    maxEntriesPerDay: intEnv(env, 'FTH_MAX_ENTRIES_PER_DAY', 6), // 0 = off
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
    killSwitchFile: String(env.FTH_KILL_SWITCH_FILE || '').trim()
      || path.join(harnessHome(env), 'STOP'),
    // Set by the autonomous runner for the harness it launches. In autonomous
    // runs nothing may switch gate checks off from inside the session.
    autonomous: env.FTH_AUTONOMOUS === '1',
    // Paper mode: every new entry is refused (plans, reviews, and exits still work).
    paper: env.FTH_PAPER === '1',
    skipChecks: env.FTH_AUTONOMOUS === '1' ? new Set() : listEnv(env, 'FTH_ORDER_GATE_SKIP'),
  };
}

module.exports = {
  gateNow,
  DEFAULT_NO_ENTRY_WINDOWS,
  DEFAULT_ENTRY_HOURS,
  GATE_CHECKS,
  loadConfig,
};
