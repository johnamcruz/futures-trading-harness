'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, TEST_ACCOUNTS, listPolicies, withExitBlock, exitBlock } = require('../helpers');
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
// A rulebook edit only ever comes from a person (import-proposal): the guard below judges those.
const errs = (t, find, replace) => validateProposal(prop(find, replace), { root: t.root, by: 'person' }).join('\n');
const line = (t, re) => t.text.match(re)[0];

test('every sizing limit has a direction; the fixture rulebook is valid as written', () => {
  assert.deepStrictEqual([...SIZING_KEYS].sort(), Object.keys(G.DIRECTION).filter(k => !['daily_loss_soft', 'loss_streak_stop'].includes(k)).sort());
  const t = tree();
  assert.deepStrictEqual(errs(t, 'learned: none', 'learned: none '), '', 'a no-op on the numbers passes');
});

test('a model never proposes a rulebook: even a tightening is refused unless a person brought it', () => {
  const t = tree();
  for (const by of [undefined, 'model']) {
    assert.match(validateProposal(prop('daily_loss_soft: 500', 'daily_loss_soft: 400'), { root: t.root, ...(by ? { by } : {}) }).join('\n'), /a rulebook is the owner's to change; only a proposal a person brings/);
  }
  assert.strictEqual(errs(t, 'daily_loss_soft: 500', 'daily_loss_soft: 400'), '');
  assert.match(validateProposal(prop('daily_loss_soft: 500', 'daily_loss_soft: 400'), { root: t.root, by: 'anyone' }).join('\n'), /by: one of model, person/);
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

test('multipliers, as the verdict applies them: no effective value rises, unlisted ones (0) included; never staler', () => {
  const t = tree();
  assert.strictEqual(errs(t, '          mixed: 0.5', '          mixed: 0.25'), '');
  assert.match(errs(t, '          mixed: 0.5', '          mixed: 0.75'), /multipliers mtf_read = mixed: the effective size multiplier rises from 0\.5 to 0\.75/);
  // Dropping a listed value lowers it to 0 (skipped): stricter.
  assert.strictEqual(errs(t, '          aligned: 1\n', ''), '');
  // A value no entry listed scored 0: adding it above 0 raises it.
  assert.match(errs(t, '          mixed: 0.5\n', '          mixed: 0.5\n          down: 1\n'), /mtf_read = down: the effective size multiplier rises from 0 to 1/);
  assert.strictEqual(errs(t, '          mixed: 0.5\n', '          mixed: 0.5\n          down: 0\n'), '', 'listed at 0: still skipped');
  assert.match(errs(t, '        max_age_min: 30', '        max_age_min: 60'), /mtf_read\.max_age_min: 30 -> 60 accepts staler facts/);
  const all = line(t, / {4}multipliers:\n(?: {6}.*\n)+/);
  assert.match(errs(t, all, '    multipliers: []\n'), /mtf_read: removed; its unlisted values rise from 0 to 1/);
});

test('multipliers: duplicates are judged on their product (removing one copy of two)', () => {
  const m = (values, extra = {}) => ({ item: 'trend_rule', fact: 'mtf_read', values, ...extra });
  const pol = list => ({ policies: { p: { sizing: {}, exit: {}, multipliers: list } } });
  // Two copies at 0.5 multiply to 0.25; one copy left is 0.5: a rise.
  assert.match(G.loosenings(pol([m({ mixed: 0.5 }), m({ mixed: 0.5 })]), pol([m({ mixed: 0.5 })])).join(), /mtf_read = mixed: the effective size multiplier rises from 0\.25 to 0\.5/);
  // A second copy that only lowers: fine. Another fact added: its unlisted values were 1 (no entry), now 0: fine.
  assert.deepStrictEqual(G.loosenings(pol([m({ mixed: 0.5 })]), pol([m({ mixed: 0.5 }), m({ mixed: 0.8 })])), []);
  assert.deepStrictEqual(G.loosenings(pol([m({ mixed: 0.5 })]), pol([m({ mixed: 0.5 }), { item: 'room', fact: 'room_r', values: { ok: 1 } }])), []);
  // The youngest max_age_min of a fact's entries decides; dropping it is staler.
  assert.match(G.loosenings(pol([m({ mixed: 0.5 }, { max_age_min: 10 }), m({ mixed: 1 })]), pol([m({ mixed: 0.5 }), m({ mixed: 1 })])).join(), /max_age_min: 10 -> Infinity accepts staler facts/);
});

test('every key\'s direction: the looser way is refused and the stricter way passes, for each limit', () => {
  const at = (k, v) => (k === 'daily_loss_soft' ? { daily_loss_soft: v } : { policies: { p: { sizing: { [k]: v }, exit: {}, multipliers: [] } } });
  for (const [k, dir] of Object.entries(G.DIRECTION)) {
    const stricter = dir === 'lower' ? 5 : 20;
    const looser = dir === 'lower' ? 20 : 5;
    assert.deepStrictEqual(G.loosenings(at(k, 10), at(k, stricter)), [], `${k}: ${10} -> ${stricter} is stricter`);
    assert.match(G.loosenings(at(k, 10), at(k, looser)).join(), new RegExp(`${k}: 10 -> ${looser} is looser`), `${k}: 10 -> ${looser}`);
  }
  // Pinned, so a flipped direction fails here.
  assert.deepStrictEqual(G.DIRECTION, { daily_loss_soft: 'lower', loss_streak_stop: 'lower', cushion_frac: 'lower', cap_usd: 'lower', clock_k: 'lower', r_per_session: 'higher', min_size_guard: 'lower', drawdown_halve_usd: 'lower', stop_slippage_ticks: 'higher', min_contracts: 'higher', floor_stretch_max_usd: 'lower', near_target_usd: 'higher', healthy_risk_usd: 'lower' });
});

test('the floor stretch: off is its strictest value (no stretch at all), never the loosest; a stretch turned on or raised is refused', () => {
  const at = v => ({ policies: { p: { sizing: { floor_stretch_max_usd: v }, exit: {}, multipliers: [] } } });
  assert.deepStrictEqual(G.loosenings(at(500), at('off')), [], '500 -> off: no stretch, stricter');
  assert.deepStrictEqual(G.loosenings(at(500), at(400)), [], '500 -> 400: stricter');
  assert.match(G.loosenings(at('off'), at(500)).join(), /floor_stretch_max_usd: "off" -> 500 is looser/, 'off -> 500 turns the stretch on');
  assert.match(G.loosenings(at(500), at(600)).join(), /floor_stretch_max_usd: 500 -> 600 is looser/);
  assert.match(G.loosenings(at(500), at('5')).join(), /not comparable/);
  // Any other limit's off is still the loosest.
  assert.match(G.loosenings({ policies: { p: { sizing: { cap_usd: 1000 }, exit: {}, multipliers: [] } } }, { policies: { p: { sizing: { cap_usd: 'off' }, exit: {}, multipliers: [] } } }).join(), /turns a limit off \(looser\)/);
});

test('exits, policies and the enforced classification: never loosened or changed', () => {
  const t = tree();
  // Any valid change of the exit (its mode, its lock, its trail) is refused: the exit is searched, never a proposal's.
  const block = line(t, / {4}exit:\n(?: {6}.*\n)+/);
  for (const exit of [exitBlock({ mode: 'trail', trail_activate_r: 9, trail_giveback_r: 1 }), exitBlock({ mode: 'target' }),
    exitBlock({ mode: 'target_then_trail', lock_giveback_r: 0.25, trail_by: 'r', trail_r: 1 }),
    exitBlock({ mode: 'target_then_trail', lock_giveback_r: 1.5, trail_by: 'r', trail_r: 1, ratchet: 'on' })]) {
    const now = withExitBlock(block, exit);
    assert.notStrictEqual(now, block);
    assert.match(errs(t, block, now), /policies\.p1\.exit: changed/, JSON.stringify(exit));
  }
  // The ratchet, either way (on keeps more of a winner, off more of a runner: neither is a limit's tightening), is an
  // exit change: a person's, never a proposal's.
  const ttt = r => ({ mode: 'target_then_trail', lock_giveback_r: 1.5, trail_by: 'structure', trail_r: 1, swing_tf: '15m', ratchet: r });
  for (const [was, now] of [['off', 'on'], ['on', 'off']]) {
    assert.match(G.loosenings({ policies: { p: { sizing: {}, exit: ttt(was), multipliers: [] } } }, { policies: { p: { sizing: {}, exit: ttt(now), multipliers: [] } } }).join(), /policies\.p\.exit: changed/, `${was} -> ${now}`);
  }
  assert.match(errs(t, '  p1:\n', '  p2:\n'), /policies\.p2: added|policies\.p1: removed/);
  assert.match(errs(t, 'enforced: [daily_loss_soft, ', 'enforced: ['), /daily_loss_soft: classified neither|moved out of enforced/);
  // The guard on its own (a valid edit that moves an item out of enforced is caught here, never only by validity).
  assert.deepStrictEqual(G.loosenings({ enforced: ['a', 'b'] }, { enforced: ['a'] }), ['enforced: b moved out of enforced (the code no longer holds it)']);
  assert.deepStrictEqual(G.loosenings({ learned: 'none', x: 1 }, { learned: 'none' }), ['x: removed (a rulebook key is never removed)']);
  assert.match(G.loosenings({ policies: { p: { sizing: { mystery: 1 } } } }, { policies: { p: { sizing: { mystery: 2 } } } }).join(), /not a limit with a known direction/);
});

test('the loss streak stop: lower or a stop where it was off passes; higher, off or removed is refused, naming the key', () => {
  const t = tree();
  assert.strictEqual(errs(t, 'loss_streak_stop: off', 'loss_streak_stop: 2'), '', 'a stop where there was none: stricter');
  const at = v => ({ loss_streak_stop: v });
  assert.deepStrictEqual(G.loosenings(at(2), at(1)), []);
  assert.match(G.loosenings(at(2), at(3)).join(), /loss_streak_stop: 2 -> 3 is looser/);
  assert.match(G.loosenings(at(2), at('off')).join(), /loss_streak_stop: 2 -> off turns a limit off/);
  assert.match(G.loosenings(at(2), {}).join(), /loss_streak_stop: removed/);
});

test('an invalid rulebook after the edit is refused before any comparison', () => {
  const t = tree();
  assert.match(errs(t, 'daily_loss_soft: 500', 'daily_loss_soft: 0'), /invalid after the edit: daily_loss_soft: 0 is not dollars above 0, or off/);
});

test('the entry rule: any change, on or off, is refused (the owner\'s switch, never a proposal\'s); loosening the bias is named looser', () => {
  const t = tree();
  for (const [find, replace] of [['regime_against: off', 'regime_against: on'], ['leg_turned: off', 'leg_turned: on'], ['bias_agree: neutral-15m-declared', 'bias_agree: off'], ['bias_agree: neutral-15m-declared', 'bias_agree: on'], ['bias_frames: [4h, 1h]', 'bias_frames: [4h]']]) {
    assert.match(errs(t, find, replace), /policies\.p1\.entry: changed \(the entry rule is the owner's switch/, replace);
  }
  // The shipped BG is bias_agree's loosest mode: off and on are stricter, never called looser (still refused: a change).
  for (const v of ['off', 'on']) assert.doesNotMatch(errs(t, 'bias_agree: neutral-15m-declared', `bias_agree: ${v}`), /bias_agree: .* is looser/, v);
  assert.match(errs(t, 'bias_frames: [4h, 1h]', 'bias_frames: [1h]'), /policies\.p1\.entry\.bias_frames: \["4h","1h"\] -> \["1h"\] is looser \(drops 4h\)/);
  assert.doesNotMatch(errs(t, 'regime_against: off', 'regime_against: on'), /is looser/, 'a tightening is never called looser');
  assert.match(errs(t, 'bias_frames: [4h, 1h]', 'bias_frames: [1h, 4h]'), /entry\.bias_frames: .* is not off/, 'invalid: refused before the comparison');
  // bias_frames off with bias_agree on is invalid; with both turned off it is a loosening of both.
  assert.match(errs(t, 'bias_frames: [4h, 1h]', 'bias_frames: off'), /bias_agree: neutral-15m-declared needs bias_frames listed/);
  const both = G.loosenings({ policies: { p: { entry: { bias_frames: ['4h', '1h'], bias_agree: 'on' } } } }, { policies: { p: { entry: { bias_frames: 'off', bias_agree: 'off' } } } }).join();
  assert.match(both, /bias_agree: on -> off is looser/);
  assert.match(both, /bias_frames: .* -> "off" is looser \(drops 4h, 1h\)/);
  assert.deepStrictEqual(G.entryLooser('e', { bias_frames: ['1h'], bias_agree: 'off' }, { bias_frames: ['4h', '1h'], bias_agree: 'on' }), [], 'stricter: not looser');
  // bias_agree's order, strictest first: on, off, neutral-15m-declared; a later mode, an unknown value or a removed key is looser.
  const ag = (b, a) => G.entryLooser('e', { bias_frames: ['4h', '1h'], bias_agree: b }, { bias_frames: ['4h', '1h'], ...(a === undefined ? {} : { bias_agree: a }) }).join();
  const M = ['on', 'off', 'neutral-15m-declared'];
  for (const [i, b] of M.entries()) for (const [j, a] of M.entries()) {
    if (j > i) assert.match(ag(b, a), new RegExp(`e\\.bias_agree: ${b} -> ${a} is looser`), `${b} -> ${a}`);
    else assert.strictEqual(ag(b, a), '', `${b} -> ${a}: as strict or stricter`);
  }
  assert.match(ag('neutral-15m-declared', undefined), /bias_agree: neutral-15m-declared -> removed is looser/);
  assert.match(ag('neutral-15m-declared', 'any'), /bias_agree: neutral-15m-declared -> any is looser/);
});
