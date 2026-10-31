'use strict';

/**
 * Tier 2's state days (npm run goal:full): the quick day's first entry through the live path from three attempt states
 * (tests/goal/tier2-run.js stateDefs): fresh, a low cushion (the rulebook's cushion_frac binds) and near the target
 * (near_target_usd: the floor size). Each size is main's exactly (tier 2's baseline `states`); near the target it is the
 * floor (min_contracts), and with the cushion low it is smaller than fresh. Mutation checks on a copy of the tree: a
 * cushion share of 0.6 and near_target_usd off each change their state's size, so the check fails.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./tier2-run');
const { tmpDir, treeCopy } = require('../helpers');

const SET = (() => { try { return T.set(); } catch (err) { return { missing: err.message }; } })();
const skip = SET.missing ? `skipped: ${SET.missing}` : false;
const BASE = skip ? null : JSON.parse(fs.readFileSync(SET.baselineFile, 'utf8')).tier2;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-states-'));
const ROOT = path.resolve(__dirname, '..', '..');
const POLICY = require('../../scripts/lib/eval/goal-trades').shippedOf(ROOT, {}).policy;
const RULEBOOK = `accounts/${POLICY.account}/RULEBOOK.md`;
const edit = (file, from, to) => root => {
  const p = path.join(root, file);
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.includes(from), `${file} holds ${from}`);
  fs.writeFileSync(p, text.replace(from, to));
};

test('tier 2 state days: each state\'s size is main\'s; near the target the floor; a low cushion sizes down', { skip }, async () => {
  const sizes = await T.stateSizes(T.quickDay(BASE), { dir: OUT });
  process.stdout.write(`state sizes: ${JSON.stringify(sizes)} (main ${JSON.stringify(BASE.states)})\n`);
  assert.deepStrictEqual(sizes, BASE.states);
  assert.strictEqual(sizes['near-target'], POLICY.sizing.min_contracts, 'near the target: the floor size');
  assert.ok(sizes['low-cushion'] < sizes.fresh, 'the cushion binds');
});

const MUTATIONS = [
  { name: 'cushion_frac 0.3 -> 0.6', change: edit(RULEBOOK, 'cushion_frac: 0.3 ', 'cushion_frac: 0.6 '), state: 'low-cushion' },
  { name: 'near_target_usd 500 -> off', change: edit(RULEBOOK, 'near_target_usd: 500 ', 'near_target_usd: off '), state: 'near-target' },
];

test('tier 2 state days mutation checks: a looser cushion share and no near-target floor each change their size', { skip }, async () => {
  const got = await Promise.all(MUTATIONS.map(m => T.stateSizes(T.quickDay(BASE), { root: treeCopy(tmpDir(), m.change), dir: OUT, names: [m.state] }).then(s => [m, s[m.state]])));
  for (const [m, size] of got) {
    process.stdout.write(`${m.name}: ${m.state} ${BASE.states[m.state]} -> ${size}\n`);
    assert.notStrictEqual(size, BASE.states[m.state], `${m.name}: the ${m.state} size must change (it is main's ${size})`);
  }
});
