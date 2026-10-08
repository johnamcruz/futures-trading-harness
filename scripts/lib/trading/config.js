'use strict';

/**
 * Harness discipline settings, read from the hook environment. Set them in the
 * `env` block of ~/.claude/settings.json (or the project's .claude/settings.json).
 * These sit on top of the projectx-mcp server guardrails; they never loosen them.
 */

const os = require('os');
const path = require('path');

const DEFAULT_NO_ENTRY_WINDOWS = [
  '09:30-09:35@America/New_York', // opening print: first 5 minutes of RTH
  '15:00-18:00@America/Chicago', // into Topstep's 15:10 CT flatten, through the daily break
].join(',');

const GATE_CHECKS = [
  'setup-tag',
  'stop-defined',
  'plan-required',
  'time-window',
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

function loadConfig(env = process.env) {
  return {
    planMaxAgeMin: intEnv(env, 'FTH_PLAN_MAX_AGE_MIN', 120, { min: 1 }),
    maxConsecutiveLosses: intEnv(env, 'FTH_MAX_CONSECUTIVE_LOSSES', 2, { min: 1 }),
    lossCooldownMin: intEnv(env, 'FTH_LOSS_COOLDOWN_MIN', 30),
    maxDailyLosses: intEnv(env, 'FTH_MAX_DAILY_LOSSES', 3, { min: 1 }),
    maxEntriesPerDay: intEnv(env, 'FTH_MAX_ENTRIES_PER_DAY', 6), // 0 = off
    noEntryWindows: env.FTH_NO_ENTRY_WINDOWS !== undefined
      ? String(env.FTH_NO_ENTRY_WINDOWS)
      : DEFAULT_NO_ENTRY_WINDOWS,
    blackoutsFile: String(env.FTH_BLACKOUTS_FILE || '').trim()
      || path.join(os.homedir(), '.futures-trading-harness', 'blackouts.json'),
    skipChecks: listEnv(env, 'FTH_ORDER_GATE_SKIP'),
  };
}

module.exports = {
  DEFAULT_NO_ENTRY_WINDOWS,
  GATE_CHECKS,
  loadConfig,
};
