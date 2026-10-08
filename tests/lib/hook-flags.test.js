'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isHookEnabled, getHookProfile, parseProfiles } = require('../../scripts/lib/hook-flags');

test('hooks run by profile and can be disabled by id or globally', () => {
  assert.strictEqual(isHookEnabled('a', { env: {}, profiles: 'standard' }), true);
  assert.strictEqual(isHookEnabled('a', { env: { FTH_HOOK_PROFILE: 'minimal' }, profiles: 'standard,strict' }), false);
  assert.strictEqual(isHookEnabled('A', { env: { FTH_DISABLED_HOOKS: 'x, a' }, profiles: 'standard' }), false);
  assert.strictEqual(isHookEnabled('a', { env: { FTH_HOOKS_ENABLED: 'false' }, profiles: 'standard' }), false);
  assert.strictEqual(isHookEnabled('a', { env: { CLAUDE_PLUGIN_OPTION_HOOKS_ENABLED: '0' }, profiles: 'standard' }), false);
});

test('profile falls back to standard and plugin option is honoured', () => {
  assert.strictEqual(getHookProfile({ FTH_HOOK_PROFILE: 'bogus' }), 'standard');
  assert.strictEqual(getHookProfile({ CLAUDE_PLUGIN_OPTION_HOOK_PROFILE: 'strict' }), 'strict');
  assert.deepStrictEqual(parseProfiles('nope'), ['standard', 'strict']);
});
