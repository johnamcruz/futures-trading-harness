'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, TEST_ACCOUNTS, listPolicies } = require('../helpers');
const G = require('../../scripts/lib/train/rulebook-guard');
const { validateProposal } = require('../../scripts/lib/train/proposal');
const { SIZING_KEYS } = require('../../scripts/lib/trading/rulebook');

const FILE = 'accounts/test_50k/RULEBOOK.md';

/** A tree with a fixture rulebook listing one policy (the shipped entry's numbers) and one size multiplier. */
function tree() {
  const root = tmpDir();
  const acct = path.join(root, 'accounts', 'test_50k');
  fs.mkdirSync(acct, { recursive: true });
  fs.copyFileSync(path.join(TEST_ACCOUNTS, 'test_50k', 'RULEBOOK.md'), path.join(acct, 'RULEBOOK.md'));
  listPolicies(acct, ['p1'], { multipliers: ['      - item: trend_rule', '        fact: mtf_read', '        values:', '          aligned: 1', '          mixed: 0.5', '        max_age_min: 30'] });
  return { root, text: fs.readFileSync(path.join(acct, 'RULEBOOK.md'), 'utf8') };
}

const prop = (find, replace) => ({ targets: ['bad size'], expects: 'x', edits: [{ file: FILE, find, replace }] });
const errs = (t, find, replace) => validateProposal(prop(find, replace), { root: t.root }).join('\n');
const line = (t, re) => t.text.match(re)[0];

test('every sizing limit has a direction; the fixture rulebook is valid as written', () => {
  assert.deepStrictEqual([...SIZING_KEYS].sort(), Object.keys(G.DIRECTION).filter(k => k !== 'daily_loss_soft').sort());
  const t = tree();
  assert.deepStrictEqual(errs(t, 'learned: none', 'learned: none '), '', 'a no-op on the numbers passes');
});

test('the soft daily stop: lower passes; higher, off or removed is refused, naming the key', () => {
  const t = tree();
  assert.strictEqual(errs(t, 'daily_loss_soft: 500', 'daily_loss_soft: 400'), '');
  assert.match(errs(t, 'daily_loss_soft: 500', 'daily_loss_soft: 600'), /daily_loss_soft: 500 -> 600 is looser/);
  assert.match(errs(t, 'daily_loss_soft: 500', 'daily_loss_soft: off'), /daily_loss_soft: 500 -> off turns a limit off/);
  assert.match(errs(t, 'daily_loss_soft: 500\n', ''), /daily_loss_soft: missing/, 'removed: invalid, so refused');
});

test('sizing: each key only stricter in its direction; off where a limit stands is refused; a limit where none was passes', () => {
  const t = tree();
  const cap = line(t, /cap_usd: \S+/);
  const v = Number(cap.split(': ')[1]);
  assert.match(errs(t, cap, `cap_usd: ${v + 1}`), /policies\.p1\.sizing\.cap_usd: .* is looser/);
  assert.match(errs(t, cap, 'cap_usd: off'), /policies\.p1\.sizing\.cap_usd: .* -> off turns a limit off/);
  assert.strictEqual(errs(t, cap, `cap_usd: ${v - 1}`), '');
  const frac = line(t, /cushion_frac: \S+/);
  assert.match(errs(t, frac, 'cushion_frac: 0.9'), /cushion_frac: .* is looser/);
  const slip = line(t, /stop_slippage_ticks: \S+/);
  assert.strictEqual(errs(t, slip, 'stop_slippage_ticks: 3'), '', 'more slippage counted is stricter');
  const rps = line(t, /r_per_session: \S+/);
  assert.match(errs(t, rps, 'r_per_session: 0.1'), /r_per_session: .* is looser \(only a higher value is stricter\)/);
  const guard = line(t, /min_size_guard: \S+/);
  assert.match(errs(t, guard, 'min_size_guard: 9'), /min_size_guard: .* is looser/);
  const clock = line(t, /clock_k: \S+/);
  if (clock === 'clock_k: off') assert.strictEqual(errs(t, clock, 'clock_k: 2'), '', 'a limit where there was none');
  const dd = line(t, /drawdown_halve_usd: \S+/);
  if (dd !== 'drawdown_halve_usd: off') assert.match(errs(t, dd, 'drawdown_halve_usd: off'), /drawdown_halve_usd: .* turns a limit off/);
});

test('multipliers: only lower; never removed, a value never removed, max_age_min never raised', () => {
  const t = tree();
  assert.strictEqual(errs(t, '          mixed: 0.5', '          mixed: 0.25'), '');
  assert.match(errs(t, '          mixed: 0.5', '          mixed: 0.75'), /multipliers trend_rule\|mtf_read\.values\.mixed: 0\.5 -> 0\.75 raises a size multiplier/);
  assert.match(errs(t, '          aligned: 1\n', ''), /values\.aligned: removed/);
  assert.match(errs(t, '        max_age_min: 30', '        max_age_min: 60'), /max_age_min: 30 -> 60 accepts staler facts/);
  const all = line(t, / {4}multipliers:\n(?: {6}.*\n)+/);
  assert.match(errs(t, all, '    multipliers: []\n'), /multipliers trend_rule\|mtf_read: removed/);
});

test('exits, policies and the enforced classification: never loosened or changed', () => {
  const t = tree();
  const act = line(t, /trail_activate_r: \S+/);
  assert.match(errs(t, act, 'trail_activate_r: 9'), /policies\.p1\.exit: changed/);
  assert.match(errs(t, '  p1:\n', '  p2:\n'), /policies\.p2: added|policies\.p1: removed/);
  assert.match(errs(t, 'enforced: [daily_loss_soft, ', 'enforced: ['), /daily_loss_soft: classified neither|moved out of enforced/);
  // The guard on its own (a valid edit that moves an item out of enforced is caught here, never only by validity).
  assert.deepStrictEqual(G.loosenings({ enforced: ['a', 'b'] }, { enforced: ['a'] }), ['enforced: b moved out of enforced (the code no longer holds it)']);
  assert.deepStrictEqual(G.loosenings({ learned: 'none', x: 1 }, { learned: 'none' }), ['x: removed (a rulebook key is never removed)']);
  assert.match(G.loosenings({ policies: { p: { sizing: { mystery: 1 } } } }, { policies: { p: { sizing: { mystery: 2 } } } }).join(), /not a limit with a known direction/);
});

test('an invalid rulebook after the edit is refused before any comparison', () => {
  const t = tree();
  assert.match(errs(t, 'daily_loss_soft: 500', 'daily_loss_soft: 0'), /invalid after the edit: daily_loss_soft: 0 is not dollars above 0, or off/);
});
