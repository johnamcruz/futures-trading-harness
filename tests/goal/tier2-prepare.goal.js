'use strict';

/**
 * The goal regression's tier 2 with prepare ahead (PR B2; docs/PREPARE-AHEAD.md "Tier 2 with prepare ahead"): tier 2's
 * days through the live path on Claude Code (the world's `claude` option: tests/fixtures/goal-world.js, every Claude
 * Code run played by the fake CLI that keeps sessions, tests/fixtures/prepare-mock.js), with headSkillsInPrompt (which
 * "on" requires), each day run with prepareAhead off and "on". The deterministic mock plays both phases: the prepare
 * writes its plan from "Possible at the next close"; at a close the confirm (a real fork of the prepare's session,
 * through the runner's own atClose and runCycle) decides on the at-close briefing as the full head trader does. So "on"
 * must give exactly "off"'s trades, order calls, gate decisions, compose records, cycle results and R
 * (tests/goal/prepare-pair.js) on every day, with confirms run and one entering; under every fallback row armed
 * (prepare-mock.js FAULTS: the session lost, a corrupt plan, the confirm erring or hanging before a compose, a P&L change
 * voiding every plan); and with a confirm that loads nothing again. The check can fail: a confirm that trusts the plan
 * over the at-close facts (it decides on the briefing the prepare was made on) makes "on" differ, on valid plans (the
 * anchoring risk) and on void plans let through by the runner's validity check broken.
 *
 * Its runtime (CI's goal part, timeout 30 min): the days' off runs are made once and shared; the rows and the controls
 * run on the first day only (each was hit there: tests/goal/prepare-pair.js prepareOf). About 21 day-runs at the
 * configured parallel (2): ~7 off (~26 s) and ~14 on (~50 s), about 7 to 9 minutes on a 2-vCPU runner.
 *
 * The opencode world, main's tier 2 baseline and the move goldens are untouched (tier2.goal.js runs the key absent).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./tier2-run');
const PP = require('./prepare-pair');
const { FAULTS } = require('../fixtures/prepare-mock');

const SET = (() => { try { return T.set(); } catch (err) { return { missing: err.message }; } })();
const skip = SET.missing ? `skipped: ${SET.missing}` : false;
const DAYS = skip ? [] : T.tier2Days();
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-prepare-'));
// The day the fallback rows and the controls run on: the first (every row is hit there, and a confirm enters).
const ROW_DAYS = DAYS.slice(0, 1);

// The off runs, each made once and shared by every test: the days as they are, and the rows' day with the P&L change.
const memo = new Map();
const offOf = (days, extra = {}) => {
  const k = JSON.stringify([days, extra]);
  if (!memo.has(k)) memo.set(k, T.runDays(days, { claude: { on: false, ...extra }, dir: OUT }).then(rs => Object.fromEntries(rs.map(r => [r.day, r]))));
  return memo.get(k);
};
const offFor = async (days, extra = {}) => {
  // The whole days' off run serves any of its days (no P&L change).
  if (!Object.keys(extra).length) { const all = await offOf(DAYS); return Object.fromEntries(days.map(d => [d, all[d]])); }
  return offOf(days, extra);
};
const pair = (off, on) => on.flatMap(r => PP.pairProblems(off[r.day], r));
const sum = (rs, k) => rs.reduce((n, r) => n + r.prepare[k], 0);

test('tier 2 "on": on every day the same trades, order calls, gate decisions, compose records, cycle results and R as "off"; confirms ran, one entered', { skip }, async () => {
  const off = await offFor(DAYS);
  const on = await T.runDays(DAYS, { claude: { prepareAhead: 'on' }, dir: OUT });
  const problems = pair(off, on);
  const paths = on.map(r => `${r.day}: ${JSON.stringify(r.prepare)}`);
  process.stdout.write(`${paths.join('\n')}\n`);
  assert.deepStrictEqual(problems, [], `"on" moved away from "off":\n${problems.join('\n')}`);
  // Not vacuous: plans were made, the confirm decided closes on the fork of its prepare's session, and at least one of
  // those closes entered (compose, phase 2, the executor and the gateway after a confirm).
  assert.ok(sum(on, 'made') > 0, 'prepares made');
  assert.ok(sum(on, 'confirms') > 0, `no confirm ran:\n${paths.join('\n')}`);
  assert.ok(sum(on, 'entered') > 0, `no confirm entered a trade:\n${paths.join('\n')}`);
  // Off is the old path: no prepare field at all.
  assert.ok(Object.values(off).every(r => r.prepare.made === 0 && Object.keys(r.prepare.paths).length === 0));
});

test('tier 2 "on", every fallback row armed (the session lost, a corrupt plan, the confirm erring or hanging before a compose, a P&L change voiding every plan): the same as "off", each row hit', { skip }, async () => {
  for (const fault of FAULTS) {
    // (A P&L change is the account's, so the off world has it too.)
    const off = await offFor(ROW_DAYS, fault === 'pnl-change' ? { fault } : {});
    const on = await T.runDays(ROW_DAYS, { claude: { prepareAhead: 'on', fault }, dir: OUT });
    const problems = pair(off, on);
    assert.deepStrictEqual(problems, [], `${fault}:\n${problems.join('\n')}`);
    // The row was hit: the confirm fell back (erring, hanging); a plan void by its lost session or the facts; a plan
    // file corrupted.
    const hitOf = r => (fault.startsWith('confirm-') ? r.prepare.fellBack : fault === 'session-missing' ? (r.prepare.paths['void:session-missing'] || 0) : fault === 'pnl-change' ? (r.prepare.paths['void:facts'] || 0) : r.prepare.armed);
    const hit = on.reduce((n, r) => n + hitOf(r), 0);
    assert.ok(hit > 0, `${fault}: the row was never hit (${JSON.stringify(on.map(r => r.prepare))})`);
    if (!fault.startsWith('confirm-')) assert.ok(on.every(r => !r.prepare.paths.confirm), `${fault}: no confirm without its session or plan`);
  }
});

test('tier 2 "on": a confirm that loads nothing again (the prepare\'s loads in its context, the head trader\'s skills embedded and attested on the fork) gives the same as "off", and enters', { skip }, async () => {
  const off = await offFor(ROW_DAYS);
  const on = await T.runDays(ROW_DAYS, { claude: { prepareAhead: 'on', skipLoads: true }, dir: OUT });
  const problems = pair(off, on);
  assert.deepStrictEqual(problems, [], problems.join('\n'));
  assert.ok(sum(on, 'confirms') > 0, 'confirms ran');
  assert.ok(sum(on, 'entered') > 0, `no confirm entered without loading again: ${JSON.stringify(on.map(r => r.prepare))}`);
});

test('tier 2 "on" (the check can fail): a confirm that trusts the plan over the at-close facts on VALID plans (the anchoring risk) makes "on" differ from "off"', { skip }, async () => {
  const off = await offFor(ROW_DAYS);
  const on = await T.runDays(ROW_DAYS, { claude: { prepareAhead: 'on', trusting: true, trustValid: true }, dir: OUT });
  assert.ok(sum(on, 'confirms') > 0, 'the trusting confirm ran');
  assert.ok(pair(off, on).length > 0, 'a trusting confirm on valid plans went unseen: the comparison cannot fail');
});

test('tier 2 "on" (the check can fail): a confirm that trusts the plan, reached only by void plans let through (every plan void by a P&L change), makes "on" differ from "off"', { skip }, async () => {
  const off = await offFor(ROW_DAYS, { fault: 'pnl-change' });
  const on = await T.runDays(ROW_DAYS, { claude: { prepareAhead: 'on', fault: 'pnl-change', trusting: true, voidBypass: true }, dir: OUT });
  assert.ok(sum(on, 'voidConfirms') > 0, `no void plan reached the confirm: ${JSON.stringify(on.map(r => r.prepare))}`);
  assert.ok(pair(off, on).length > 0, 'the trusting confirm went unseen: the comparison cannot fail');
});
