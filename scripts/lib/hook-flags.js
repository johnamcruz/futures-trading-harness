'use strict';

/**
 * Hook enable/disable controls (ported from the ECC hook runtime).
 *
 * - FTH_HOOKS_ENABLED=true|false   (default true; plugin option hooks_enabled)
 * - FTH_HOOK_PROFILE=minimal|standard|strict (default standard; plugin option hook_profile)
 * - FTH_DISABLED_HOOKS=comma,separated,hook,ids
 * - FTH_DRY_RUN=1                   log what would run, run nothing
 */

const VALID_PROFILES = new Set(['minimal', 'standard', 'strict']);

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function areHooksEnabled(env = process.env) {
  const raw = env.FTH_HOOKS_ENABLED !== undefined
    ? env.FTH_HOOKS_ENABLED
    : env.CLAUDE_PLUGIN_OPTION_HOOKS_ENABLED;
  return parseBoolean(raw, true);
}

function getHookProfile(env = process.env) {
  const selected = env.FTH_HOOK_PROFILE !== undefined
    ? env.FTH_HOOK_PROFILE
    : env.CLAUDE_PLUGIN_OPTION_HOOK_PROFILE;
  const raw = String(selected ?? 'standard').trim().toLowerCase();
  return VALID_PROFILES.has(raw) ? raw : 'standard';
}

function getDisabledHookIds(env = process.env) {
  return new Set(
    String(env.FTH_DISABLED_HOOKS || '')
      .split(',')
      .map(normalizeId)
      .filter(Boolean)
  );
}

function parseProfiles(rawProfiles, fallback = ['standard', 'strict']) {
  if (!rawProfiles) return [...fallback];
  const list = Array.isArray(rawProfiles) ? rawProfiles : String(rawProfiles).split(',');
  const parsed = list
    .map(v => String(v || '').trim().toLowerCase())
    .filter(v => VALID_PROFILES.has(v));
  return parsed.length > 0 ? parsed : [...fallback];
}

function isDryRun(env = process.env) {
  return env.FTH_DRY_RUN === '1';
}

function isHookEnabled(hookId, options = {}) {
  const env = options.env || process.env;
  if (!areHooksEnabled(env)) return false;

  const id = normalizeId(hookId);
  if (!id) return true;
  if (getDisabledHookIds(env).has(id)) return false;

  return parseProfiles(options.profiles).includes(getHookProfile(env));
}

module.exports = {
  VALID_PROFILES,
  normalizeId,
  parseBoolean,
  areHooksEnabled,
  getHookProfile,
  getDisabledHookIds,
  parseProfiles,
  isHookEnabled,
  isDryRun,
};
