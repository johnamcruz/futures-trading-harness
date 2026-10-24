'use strict';

// The rulebook module (scripts/lib/trading/rulebook.js): validation, loading, a policy's entry, the verdict's
// multiplier (ceiling), and how the account and strategy loaders take their values from it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RB = require('../../scripts/lib/trading/rulebook');
const { loadAccounts } = require('../../scripts/lib/trading/accounts');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { tmpDir, TEST_ACCOUNTS, listPolicies, withExitBlock, exitBlock } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BODY = '## When to Use\n## How It Works\n## Examples\n';
const KINDS = {
  enforced: Object.keys(RB.ITEMS).filter(k => RB.ITEMS[k].enforcedBy),
  taught: Object.keys(RB.ITEMS).filter(k => !RB.ITEMS[k].enforcedBy),
};
const book = (extra = {}) => ({ name: 'acct', description: 'a rulebook for a test account', learned: 'none', daily_loss_soft: 500, loss_streak_stop: 2, ...KINDS, ...extra });
const errorsOf = (extra, body = BODY) => RB.validateRulebook(book(extra), body, 'acct');
/** A complete policy entry: every sizing key and the trail stated. */
const SIZING = { cushion_frac: 0.1, cap_usd: 500, clock_k: 'off', r_per_session: 0.3, min_size_guard: 1.5, drawdown_halve_usd: 'off', stop_slippage_ticks: 1, min_contracts: 3 };
const OFFS = { trail_activate_r: 'off', trail_giveback_r: 'off', lock_giveback_r: 'off', trail_by: 'off', trail_r: 'off', swing_tf: 'off' };
const ENTRY = { sizing: SIZING, exit: { ...OFFS, mode: 'trail', trail_activate_r: 2, trail_giveback_r: 1 }, multipliers: [] };
const TARGET = { ...OFFS, mode: 'target' };
const AFTER = { ...OFFS, mode: 'target_then_trail', lock_giveback_r: 0.5, trail_by: 'structure', trail_r: 1, swing_tf: '15m' };

test('validateRulebook: a complete one is valid; every item is classified exactly once, as a kind it has', () => {
  assert.deepStrictEqual(errorsOf({}), []);
  assert.deepStrictEqual(errorsOf({ learned: '2026-10-13', daily_loss_soft: 'off' }), []);
  assert.match(errorsOf({ name: 'other' }).join(), /name: "other" must be its account's folder name, "acct" \(a rulebook copied from another account\?\)/);
  assert.match(errorsOf({ learned: 'yesterday' }).join(), /learned: none/);
  // The soft stop is enforced: stated, and turned off only by `off` (0, empty, negative or text is refused).
  assert.match(errorsOf({ daily_loss_soft: undefined }).join(), /daily_loss_soft: missing; state it \(enforced: no code default\)/);
  for (const v of [0, -1, '', 'none', null]) assert.match(errorsOf({ daily_loss_soft: v }).join(), /daily_loss_soft: .* is not dollars above 0, or off/, String(v));
  // The loss streak stop too: a whole number of losing trades from 1, or `off`; never a code default.
  assert.deepStrictEqual(errorsOf({ loss_streak_stop: 'off' }), []);
  assert.deepStrictEqual(errorsOf({ loss_streak_stop: 1 }), []);
  assert.match(errorsOf({ loss_streak_stop: undefined }).join(), /loss_streak_stop: missing; state it \(enforced: no code default\)/);
  for (const v of [0, -1, 1.5, '', 'none', '2', null, true]) assert.match(errorsOf({ loss_streak_stop: v }).join(), /loss_streak_stop: .* is not a whole number of losing trades, at least 1, or off/, String(v));
  assert.match(errorsOf({ surprise: 1 }).join(), /unknown key "surprise"/);
  assert.match(errorsOf({}, '## When to Use\n').join(), /missing section "## How It Works"/);
  assert.match(errorsOf({ enforced: undefined }).join(), /enforced and taught: the rulebook items of each kind/);
  // Unclassified, twice, unknown, or a kind no code or skill provides.
  assert.match(errorsOf({ taught: KINDS.taught.slice(1) }).join(), new RegExp(`${KINDS.taught[0]}: classified neither enforced nor taught`));
  assert.match(errorsOf({ taught: [...KINDS.taught, 'sizing'] }).join(), /sizing: classified more than once/);
  assert.match(errorsOf({ taught: [...KINDS.taught, 'vibes'] }).join(), /vibes: not a rulebook item/);
  assert.match(errorsOf({ taught: [...KINDS.taught, 'toString'] }).join(), /toString: not a rulebook item/);
  const moved = { enforced: [...KINDS.enforced, 'mtf_read'], taught: KINDS.taught.filter(k => k !== 'mtf_read') };
  assert.match(errorsOf(moved).join(), /mtf_read: classified enforced, but no code holds it \(taught in strategy-library\)/);
  const back = { enforced: KINDS.enforced.filter(k => k !== 'sizing'), taught: [...KINDS.taught, 'sizing'] };
  assert.match(errorsOf(back).join(), /sizing: classified taught, but no skill teaches it/);
});

test('validateRulebook: a policy entry states every sizing key, the trail and its multiplier items; nothing falls back to a code default', () => {
  const p = (x = {}) => ({ policies: { prop_a: { ...ENTRY, ...x } } });
  assert.deepStrictEqual(errorsOf(p()), []);
  assert.match(errorsOf({ policies: [] }).join(), /policies: a map/);
  assert.match(errorsOf(p({ sizing: undefined })).join(), /policies.prop_a.sizing: missing or not a map; state every key/);
  assert.match(errorsOf(p({ exit: 5 })).join(), /policies.prop_a.exit: missing or not a map/);
  assert.match(errorsOf(p({ multipliers: undefined })).join(), /policies.prop_a.multipliers: missing; state it \(\[\] for none\)/);
  assert.match(errorsOf(p({ account: 'x' })).join(), /policies.prop_a.account: unknown key/);
  // Each sizing key: left out, refused (the code's default would apply, some of them off: no cap, no halving).
  for (const k of RB.SIZING_KEYS) {
    const { [k]: _drop, ...rest } = SIZING;
    assert.match(errorsOf(p({ sizing: rest })).join(), new RegExp(`policies.prop_a.sizing.${k}: missing; state it \\(no code default\\)`), k);
  }
  for (const k of RB.EXIT_KEYS) {
    for (const exit of [ENTRY.exit, TARGET, AFTER]) {
      const { [k]: _drop, ...rest } = exit;
      assert.match(errorsOf(p({ exit: rest })).join(), new RegExp(`policies.prop_a.exit.${k}: missing`), k);
    }
  }
  // The exit mode: target (the trade's own stop and target, a trail on top only with both in R) or trail (both in R).
  assert.deepStrictEqual(errorsOf(p({ exit: TARGET })), []);
  assert.deepStrictEqual(errorsOf(p({ exit: { ...TARGET, trail_activate_r: 3, trail_giveback_r: 1 } })), []);
  for (const mode of ['trailing', 'own', '', 0, null]) assert.match(errorsOf(p({ exit: { ...TARGET, mode } })).join(), /exit.mode: .* is not target, target_then_trail, trail/, String(mode));
  // target_then_trail: the lock, trail_by and trail_r set; swing_tf with a structure trail only; no R trail before the target.
  assert.deepStrictEqual(errorsOf(p({ exit: AFTER })), []);
  assert.deepStrictEqual(errorsOf(p({ exit: { ...AFTER, trail_by: 'r', swing_tf: 'off' } })), []);
  for (const k of ['lock_giveback_r', 'trail_by', 'trail_r', 'swing_tf']) assert.match(errorsOf(p({ exit: { ...AFTER, [k]: 'off' } })).join(), new RegExp(`exit.${k}: mode target_then_trail needs it`), k);
  assert.match(errorsOf(p({ exit: { ...AFTER, trail_by: 'r' } })).join(), /exit.swing_tf: off in mode target_then_trail \(only a structure trail reads swings\)/);
  assert.match(errorsOf(p({ exit: { ...AFTER, trail_activate_r: 2, trail_giveback_r: 0.5 } })).join(), /exit.trail_activate_r: off in mode target_then_trail/);
  for (const v of ['4h', '15', 'abc', 0]) assert.match(errorsOf(p({ exit: { ...AFTER, swing_tf: v } })).join(), /exit.swing_tf: .* is not one of 5m, 15m, 1h, or off/, String(v));
  for (const v of ['atr', 'R', 0]) assert.match(errorsOf(p({ exit: { ...AFTER, trail_by: v } })).join(), /exit.trail_by: .* is not r or structure, or off/, String(v));
  for (const v of [0, -1, 51, 'x']) assert.match(errorsOf(p({ exit: { ...AFTER, lock_giveback_r: v } })).join(), /exit.lock_giveback_r: .* is not R above 0/, String(v));
  // The modes' own keys stay off elsewhere.
  for (const mode of ['target', 'trail']) {
    const base = mode === 'trail' ? ENTRY.exit : TARGET;
    assert.match(errorsOf(p({ exit: { ...base, lock_giveback_r: 0.5 } })).join(), new RegExp(`exit.lock_giveback_r: off in mode ${mode}`), mode);
  }
  assert.match(errorsOf(p({ exit: { ...TARGET, trail_activate_r: 2 } })).join(), /exit: trail_activate_r and trail_giveback_r are both off or both R/);
  assert.match(errorsOf(p({ exit: { ...TARGET, mode: 'trail' } })).join(), /exit.trail_activate_r: mode trail needs it \(the trail is how every trade exits\)/);
  assert.match(errorsOf(p({ exit: { ...ENTRY.exit, trail_giveback_r: 'off' } })).join(), /both off or both R/);
  for (const v of [0, -1, '', 'none', null]) assert.match(errorsOf(p({ exit: { ...TARGET, trail_activate_r: v } })).join(), /exit.trail_activate_r: .* is not R above 0, at most 50, or off/, String(v));
  // As the strategy loader reads it: the mode, and the trail only when it is in R.
  assert.deepStrictEqual(RB.policyEntry({ policies: { prop_a: { ...ENTRY, exit: TARGET } } }, 'prop_a').exit, { mode: 'target' });
  assert.deepStrictEqual(RB.policyEntry({ policies: { prop_a: ENTRY } }, 'prop_a').exit, { mode: 'trail', trail_activate_r: 2, trail_giveback_r: 1 });
  assert.deepStrictEqual(RB.policyEntry({ policies: { prop_a: { ...ENTRY, exit: AFTER } } }, 'prop_a').exit, { mode: 'target_then_trail', lock_giveback_r: 0.5, trail_by: 'structure', trail_r: 1, swing_tf: '15m' });
  // A limit is off only by `off`: 0 would turn the cap or the halving off unseen, so it is refused.
  for (const k of ['cap_usd', 'drawdown_halve_usd', 'clock_k']) {
    for (const v of [0, -5, '', 'none', null]) assert.match(errorsOf(p({ sizing: { ...SIZING, [k]: v } })).join(), new RegExp(`sizing.${k}: .* is not .*or off`), `${k} ${v}`);
  }
  assert.match(errorsOf(p({ sizing: { ...SIZING, cushion_frac: 1.5 } })).join(), /sizing.cushion_frac: 1.5 is not a share of the cushion, 0 to 1/);
  assert.match(errorsOf(p({ sizing: { ...SIZING, r_per_session: 0 } })).join(), /sizing.r_per_session: 0 is not the R a session makes, above 0/);
  assert.match(errorsOf(p({ sizing: { ...SIZING, stop_slippage_ticks: 0 } })).join(), /sizing.stop_slippage_ticks: 0 is not ticks, at least 1/);
  assert.match(errorsOf(p({ sizing: { ...SIZING, min_size_guard: -1 } })).join(), /sizing.min_size_guard: -1 is not a multiple of the budget/);
  assert.match(errorsOf(p({ sizing: { ...SIZING, cushion: 0.1 } })).join(), /sizing.cushion: unknown key/);
  // The floor (min_contracts): a whole number of contracts, 1 or more; 0, a fraction, a negative, text or off refused.
  for (const v of [0, -1, 2.5, '3', null, true]) assert.match(errorsOf(p({ sizing: { ...SIZING, min_contracts: v } })).join(), /sizing.min_contracts: .* is not a whole number of contracts, 1 or more/, String(v));
  for (const v of [1, 3, 10]) assert.deepStrictEqual(errorsOf(p({ sizing: { ...SIZING, min_contracts: v } })), [], String(v));
  assert.match(errorsOf(p({ exit: { ...ENTRY.exit, trail_activate_r: 0 } })).join(), /exit.trail_activate_r: 0 is not R above 0, at most 50/);
  assert.match(errorsOf(p({ exit: { ...ENTRY.exit, target_r: 3 } })).join(), /exit.target_r: unknown key/);
  // The bounds at their edges: a trail up to 50R, `off` only where a limit can be off, a policy's name as a strategy's.
  assert.deepStrictEqual(errorsOf(p({ exit: { ...ENTRY.exit, trail_activate_r: 50 } })), []);
  assert.match(errorsOf(p({ exit: { ...ENTRY.exit, trail_activate_r: 51 } })).join(), /exit.trail_activate_r: 51 is not R above 0, at most 50/);
  for (const k of ['cushion_frac', 'min_size_guard', 'r_per_session', 'stop_slippage_ticks', 'min_contracts']) {
    assert.match(errorsOf(p({ sizing: { ...SIZING, [k]: 'off' } })).join(), new RegExp(`sizing.${k}: "off" is not`), k);
  }
  for (const name of ['Prop_A', 'prop a', '-prop', '']) {
    assert.match(errorsOf({ policies: { [name]: ENTRY } }).join(), /: a policy strategy's name and a map of sizing, exit, multipliers/, JSON.stringify(name));
  }
  // `off` is read as the code's 0 ("no limit") only once stated.
  const book2 = { ...book(), policies: { prop_a: ENTRY } };
  assert.deepStrictEqual(RB.policyEntry(book2, 'prop_a').sizing, { ...SIZING, clock_k: 0, drawdown_halve_usd: 0 });
  const m = (x = {}) => p({ multipliers: [{ item: 'multipliers', fact: 'mtf', values: { aligned: 1, mixed: 0.5 }, max_age_min: 10, ...x }] });
  assert.deepStrictEqual(errorsOf(m()), []);
  assert.match(errorsOf(p({ multipliers: {} })).join(), /multipliers: a list/);
  // Only an enforced item folds into the verdict: a taught one never does.
  assert.match(errorsOf(m({ item: 'mtf_read' })).join(), /mtf_read folds into the verdict only when it is classified enforced/);
  assert.match(errorsOf(m({ item: 'nope' })).join(), /item: one of the rulebook items/);
  assert.match(errorsOf(m({ fact: '' })).join(), /fact: the fact it is computed from/);
  for (const values of [{}, { aligned: 1.5 }, { aligned: -0.1 }, { aligned: 'half' }, null]) {
    assert.match(errorsOf(m({ values })).join(), /values: \{ <fact value>: a multiplier from 0 to 1/, JSON.stringify(values));
  }
  assert.match(errorsOf(m({ max_age_min: 0 })).join(), /max_age_min: minutes above 0/);
  assert.match(errorsOf(m({ extra: 1 })).join(), /\.extra: unknown key/);
});

test('loadRulebookFile and policyEntry: parsed and validated against its folder; none when there is no file', () => {
  const dir = path.join(tmpDir(), 'acct');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, RB.FILE);
  assert.strictEqual(RB.loadRulebookFile(file), null);
  fs.writeFileSync(file, `---\nname: acct\n---\n${BODY}`);
  assert.strictEqual(RB.loadRulebookFile(file).valid, false);
  fs.writeFileSync(file, '---\nname: [unclosed\n---\n');
  assert.strictEqual(RB.loadRulebookFile(file).valid, false);
  const shipped = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio');
  const real = RB.loadRulebookFile(path.join(ROOT, 'accounts', shipped.account, RB.FILE));
  assert.strictEqual(real.valid, true, real.errors.join());
  assert.deepStrictEqual(Object.keys(RB.policyEntry(real, 'prop_portfolio')), ['sizing', 'exit', 'multipliers']);
  assert.strictEqual(RB.policyEntry(real, 'nope'), null);
  assert.strictEqual(RB.policyEntry(null, 'prop_portfolio'), null);
  assert.strictEqual(RB.policyEntry({ policies: { toString: 1 } }, 'hasOwnProperty'), null);
});

test('ceiling: the product of the enforced multiplier items; a missing, stale, timeless or unmapped fact is 0', () => {
  const now = new Date('2026-10-07T15:00:00Z');
  const at = min => new Date(now.getTime() - min * 60000).toISOString();
  const items = [
    { item: 'multipliers', fact: 'mtf', values: { aligned: 1, mixed: 0.5 }, max_age_min: 10 },
    { item: 'multipliers', fact: 'room', values: { ok: 0.5 } },
  ];
  assert.deepStrictEqual(RB.ceiling([], {}, now), { multiplier: 1, why: [] });
  assert.deepStrictEqual(RB.ceiling(undefined, undefined, now), { multiplier: 1, why: [] });
  assert.strictEqual(RB.ceiling(items, { mtf: { value: 'mixed', at: at(1) }, room: { value: 'ok' } }, now).multiplier, 0.25);
  const zero = facts => RB.ceiling(items, facts, now);
  assert.match(zero({ room: { value: 'ok' } }).why.join(), /no mtf fact/);
  assert.match(zero({ mtf: { value: 'aligned', at: at(11) }, room: { value: 'ok' } }).why.join(), /mtf fact is stale or has no time/);
  assert.match(zero({ mtf: { value: 'aligned' }, room: { value: 'ok' } }).why.join(), /stale or has no time/);
  assert.match(zero({ mtf: { value: 'aligned', at: 'never' }, room: { value: 'ok' } }).why.join(), /stale or has no time/);
  assert.match(zero({ mtf: { value: 'toString', at: at(1) }, room: { value: 'ok' } }).why.join(), /mtf "toString" has no multiplier/);
  assert.match(zero({ mtf: { value: null, at: at(1) }, room: { value: 'ok' } }).why.join(), /no mtf fact/);
  assert.match(zero({ mtf: 'aligned', room: { value: 'ok' } }).why.join(), /no mtf fact/);
  for (const facts of [{}, { room: { value: 'ok' } }, { mtf: { value: 'aligned', at: at(11) }, room: { value: 'ok' } }]) assert.strictEqual(zero(facts).multiplier, 0);
  // A mapped 0 says so; nothing ever raises the size above 1.
  assert.match(RB.ceiling([{ item: 'multipliers', fact: 'f', values: { x: 0 } }], { f: { value: 'x' } }, now).why.join(), /allows no size/);
  assert.strictEqual(RB.ceiling([{ item: 'multipliers', fact: 'f', values: { x: 3 } }], { f: { value: 'x' } }, now).multiplier, 0);
});

/** A plugin root with a copy of the shipped accounts (and rulebooks) and the shipped strategies linked. */
function rootCopy() {
  const root = tmpDir();
  fs.cpSync(path.join(ROOT, 'accounts'), path.join(root, 'accounts'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'strategies'), path.join(root, 'strategies'));
  const policy = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio');
  return { root, file: path.join(root, 'accounts', policy.account, RB.FILE), account: policy.account };
}

test('the account loader takes daily_loss_soft from the rulebook beside it, never from the profile, and refuses a missing, invalid or foreign rulebook naming the file and key', () => {
  const { root, file, account } = rootCopy();
  const acct = () => loadAccounts(root, {}).accounts.find(a => a.name === account);
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual(acct().valid, true);
  fs.writeFileSync(file, text.replace(/^daily_loss_soft: \d+/m, 'daily_loss_soft: 123'));
  assert.strictEqual(acct().daily_loss_soft, 123);
  fs.writeFileSync(file, text.replace(/^daily_loss_soft: \d+/m, 'daily_loss_soft: off'));
  assert.strictEqual(acct().daily_loss_soft, 0, '`off`, stated, is the code\'s "none"');
  // Stated in the account profile: never read from there (one place).
  const profile = path.join(path.dirname(file), 'ACCOUNT.md');
  const prof = fs.readFileSync(profile, 'utf8');
  fs.writeFileSync(file, text);
  fs.writeFileSync(profile, prof.replace(/^consistency_pct:/m, 'daily_loss_soft: 123\nconsistency_pct:'));
  assert.match(acct().errors.join(), /daily_loss_soft: it lives in RULEBOOK\.md beside this file, not here \(one place\)/);
  fs.writeFileSync(profile, prof);
  // Missing: the account is refused, never left without its soft stop. The message names the file.
  fs.rmSync(file);
  assert.strictEqual(acct().valid, false);
  assert.ok(acct().errors.some(e => e.startsWith(`${file}: missing; every account has its rulebook beside its ACCOUNT.md`)), acct().errors.join());
  // Invalid (each error names the file and the key), malformed, or another account's copied in: refused.
  const bad = [
    [text.replace(/^daily_loss_soft: .*\n/m, ''), /daily_loss_soft: missing; state it/],
    [text.replace(/^daily_loss_soft: \d+/m, 'daily_loss_soft: 0'), /daily_loss_soft: 0 is not dollars above 0, or off/],
    [text.replace(/^learned: .*$/m, 'learned: maybe'), /learned: none/],
    [text.slice(0, text.indexOf('policies:') + 40), /missing YAML frontmatter/],
    [text.replace(/^learned: none.*$/m, 'learned: none\nlearned: none'), /duplicate key "learned"/],
    [text.replace(/^name: .*$/m, 'name: someone_else'), /name: "someone_else" must be its account's folder name/],
    [text.replace(/^daily_loss_soft: \d+/m, 'daily_loss_soft: 999999'), /daily_loss_soft: below max_loss/],
  ];
  for (const [t, re] of bad) {
    fs.writeFileSync(file, t);
    assert.strictEqual(acct().valid, false, String(re));
    assert.match(acct().errors.join('\n'), re);
    if (!/below max_loss/.test(re.source)) assert.ok(acct().errors.some(e => e.startsWith(`${file}: `)), `names the file: ${acct().errors.join()}`);
  }
  // Another account's rulebook copied in whole.
  const other = fs.readdirSync(path.join(root, 'accounts')).find(d => d !== account);
  fs.copyFileSync(path.join(root, 'accounts', other, RB.FILE), file);
  assert.match(acct().errors.join(), new RegExp(`name: "${other}" must be its account's folder name, "${account}"`));
  // The fixture accounts carry rulebooks too.
  assert.strictEqual(loadAccounts(ROOT, { FTH_ACCOUNTS_DIRS: TEST_ACCOUNTS }).accounts.find(a => a.name === 'test_50k').daily_loss_soft, 500);
});

test('the strategy loader sizes a policy only from its account\'s rulebook: never its own values, never unlisted, never on a bad rulebook', () => {
  const { root, file } = rootCopy();
  const policy = n => loadStrategies(root, {}).strategies.find(s => s.name === n);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, withExitBlock(text.replace(/^( {6}cushion_frac: )0\.3\b/m, '$10.25'), exitBlock({ trail_activate_r: 3, trail_giveback_r: 1 })));
  assert.strictEqual(policy('prop_portfolio').sizing.cushion_frac, 0.25);
  assert.deepStrictEqual(policy('prop_portfolio').exit, { mode: 'target', trail_activate_r: 3, trail_giveback_r: 1 });
  assert.deepStrictEqual(policy('prop_portfolio').multipliers, []);
  // `off` reaches the code as 0 ("no limit"): a policy listed with the retired prop_flow_1m's entry (its limits off).
  const flowDir = path.join(tmpDir(), 'strategies');
  fs.mkdirSync(path.join(flowDir, 'prop_fx_flow'), { recursive: true });
  fs.writeFileSync(path.join(flowDir, 'prop_fx_flow', 'STRATEGY.md'), fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8').replace(/^name: prop_portfolio$/m, 'name: prop_fx_flow'));
  listPolicies(path.dirname(file), ['prop_fx_flow'], { from: 'prop_flow_1m' });
  assert.match(fs.readFileSync(file, 'utf8'), /^ {2}prop_fx_flow:\n {4}sizing:\n(?: {6}.*\n)*? {6}cap_usd: off\n/m, 'its entry says off');
  const flow = loadStrategies(root, { FTH_STRATEGIES_DIRS: flowDir }).strategies.find(s => s.name === 'prop_fx_flow');
  assert.strictEqual(flow.valid, true, flow.errors && flow.errors.join());
  assert.deepStrictEqual([flow.sizing.cap_usd, flow.sizing.clock_k, flow.sizing.drawdown_halve_usd], [0, 0, 0]);
  fs.writeFileSync(file, text.replace(/^( {6}cushion_frac: )0\.3\b/m, '$10.25').replace(/^( {6}trail_activate_r: )2\b/m, '$13'));
  // A bad value or a missing key: the policy is refused, naming the file and the key.
  for (const [t, re] of [
    [text.replace(/^( {6}cushion_frac: )0\.3\b/m, '$12'), /policies\.prop_portfolio\.sizing\.cushion_frac: 2 is not a share of the cushion/],
    [text.replace(/^ {6}cap_usd: 1000.*\n/m, ''), /policies\.prop_portfolio\.sizing\.cap_usd: missing; state it/],
    [text.replace(/^learned: .*$/m, 'learned: maybe'), /learned: none/],
  ]) {
    fs.writeFileSync(file, t);
    assert.strictEqual(policy('prop_portfolio').valid, false);
    assert.match(policy('prop_portfolio').errors.join(), new RegExp(`account: ${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} is invalid \\(.*${re.source}`));
  }
  fs.writeFileSync(file, text);
  // A policy that states its own sizing or exit: refused (one place), listed or not.
  const own = fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8').replace(/^contracts: .*$/m, m => `${m}\nsizing:\n  cushion_frac: 0.3\nexit:\n  trail_activate_r: 2\n  trail_giveback_r: 0.5`);
  fs.rmSync(path.join(root, 'strategies'));
  fs.mkdirSync(path.join(root, 'strategies'));
  for (const d of fs.readdirSync(path.join(ROOT, 'strategies'))) if (d !== 'prop_portfolio') fs.symlinkSync(path.join(ROOT, 'strategies', d), path.join(root, 'strategies', d));
  fs.mkdirSync(path.join(root, 'strategies', 'prop_portfolio'));
  fs.writeFileSync(path.join(root, 'strategies', 'prop_portfolio', 'STRATEGY.md'), own);
  const errs = policy('prop_portfolio').errors.join();
  assert.match(errs, /sizing: it lives in .*RULEBOOK\.md \(policies\.prop_portfolio\.sizing\), not here \(one place\)/);
  assert.match(errs, /exit: it lives in .*RULEBOOK\.md \(policies\.prop_portfolio\.exit\)/);
  // A policy its account's rulebook doesn't list: refused, even carrying its own values (one place, strictly).
  fs.renameSync(path.join(root, 'strategies', 'prop_portfolio'), path.join(root, 'strategies', 'prop_mine'));
  fs.writeFileSync(path.join(root, 'strategies', 'prop_mine', 'STRATEGY.md'), own.replace(/^name: prop_portfolio$/m, 'name: prop_mine').replace(/^sizing:[^]*?(?=^risk:)/m, ''));
  const mine = policy('prop_mine');
  assert.strictEqual(mine.valid, false);
  assert.match(mine.errors.join(), /account: .*RULEBOOK\.md doesn't list prop_mine \(policies\.prop_mine: its sizing, exit and multipliers\)/);
  // Its own `multipliers` in its STRATEGY.md: refused too (one place), even when listed.
  fs.renameSync(path.join(root, 'strategies', 'prop_mine'), path.join(root, 'strategies', 'prop_portfolio'));
  fs.writeFileSync(path.join(root, 'strategies', 'prop_portfolio', 'STRATEGY.md'), fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8')
    .replace(/^contracts: .*$/m, m => `${m}\nmultipliers: []`));
  assert.match(policy('prop_portfolio').errors.join(), /multipliers: it lives in .*RULEBOOK\.md \(policies\.prop_portfolio\.multipliers\), not here \(one place\)/);
  fs.renameSync(path.join(root, 'strategies', 'prop_portfolio'), path.join(root, 'strategies', 'prop_mine'));
  // Its account without a rulebook: refused.
  fs.rmSync(file);
  assert.match(policy('prop_mine').errors.join(), /account: [a-z0-9_]+ has no rulebook/);
});

test('the rulebook is the first account directory\'s: a user-local copy of a shipped account never supplies a policy\'s numbers', () => {
  const { root, account } = rootCopy();
  // A user's folder (FTH_ACCOUNTS_DIRS) with a copy of the same account whose rulebook would size prop_portfolio
  // looser and list a policy of its own.
  const user = path.join(tmpDir(), 'accounts');
  fs.cpSync(path.join(root, 'accounts', account), path.join(user, account), { recursive: true });
  const userBook = path.join(user, account, RB.FILE);
  fs.writeFileSync(userBook, fs.readFileSync(userBook, 'utf8').replace(/^( {6}cushion_frac: )0\.3\b/m, '$10.9').replace(/^policies:\n/m, 'policies:\n  prop_mine:\n'
    + fs.readFileSync(userBook, 'utf8').match(/^ {2}prop_portfolio:\n((?: {4}.*\n)+)/m)[1]));
  const strategies = path.join(tmpDir(), 'strategies');
  fs.mkdirSync(path.join(strategies, 'prop_mine'), { recursive: true });
  fs.writeFileSync(path.join(strategies, 'prop_mine', 'STRATEGY.md'), fs.readFileSync(path.join(ROOT, 'strategies', 'prop_portfolio', 'STRATEGY.md'), 'utf8').replace(/^name: prop_portfolio$/m, 'name: prop_mine'));
  const env = { FTH_ACCOUNTS_DIRS: user, FTH_STRATEGIES_DIRS: strategies };
  assert.strictEqual(RB.loadRulebookFile(userBook).valid, true, 'the user copy is itself a valid rulebook');
  const all = loadStrategies(root, env).strategies;
  assert.strictEqual(all.find(s => s.name === 'prop_portfolio').sizing.cushion_frac, 0.3, 'the shipped (first) rulebook sizes it');
  const mine = all.find(s => s.name === 'prop_mine');
  assert.strictEqual(mine.valid, false);
  assert.match(mine.errors.join(), /doesn't list prop_mine/);
  assert.ok(mine.errors.join().includes(path.join(root, 'accounts', account, RB.FILE)), 'the refusal names the first directory\'s rulebook');
});
