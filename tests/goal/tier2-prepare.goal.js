'use strict';

/**
 * The goal regression's tier 2 with prepare ahead (PR B2; docs/PREPARE-AHEAD.md "Tier 2 with prepare ahead"): tier 2's
 * days through the live path on Claude Code (the world's `claude` option: tests/fixtures/goal-world.js, every Claude
 * Code run played by the fake CLI that keeps sessions, tests/fixtures/prepare-mock.js), each day run with prepareAhead
 * off and "on". The deterministic mock plays both phases: the prepare writes its plan from "Possible at the next close";
 * at a close the confirm (a real fork of the prepare's session, through the runner's own atClose and runCycle) decides on
 * the at-close briefing as the full head trader does. So "on" must give exactly "off"'s trades, order calls, gate
 * decisions, compose records, cycle results and R (tests/goal/prepare-pair.js), on every day and under every fallback
 * row armed (prepare-mock.js FAULTS: the session lost, a corrupt plan, the confirm erring or hanging before a compose),
 * with confirms actually run and one entering. With headSkillsInPrompt, a confirm that loads nothing again is still "off".
 * And the check can fail: on a day where every plan is void (a P&L change before each close), a confirm that trusts the
 * plan over the at-close facts (it decides on the briefing the prepare was made on), reached only through the runner's
 * validity check broken, makes "on" differ from "off".
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
// The days the fallback rows and the negative control are armed on: the first two (a day each costs an off and an on run).
const FAULT_DAYS = DAYS.slice(0, 2);

let OFF = null;
const offRuns = () => (OFF = OFF || T.runDays(DAYS, { claude: { on: false }, dir: OUT }));
const byDay = rs => Object.fromEntries(rs.map(r => [r.day, r]));

test('tier 2 "on": on every day the same trades, order calls, gate decisions, compose records, cycle results and R as "off"; confirms ran', { skip }, async () => {
  const off = byDay(await offRuns());
  const on = await T.runDays(DAYS, { claude: { prepareAhead: 'on' }, dir: OUT });
  const problems = on.flatMap(r => PP.pairProblems(off[r.day], r));
  const paths = on.map(r => `${r.day}: ${JSON.stringify(r.prepare)}`);
  process.stdout.write(`${paths.join('\n')}\n`);
  assert.deepStrictEqual(problems, [], `"on" moved away from "off":\n${problems.join('\n')}`);
  // Not vacuous: plans were made, the confirm decided closes on the fork of its prepare's session, and at least one of
  // those closes entered (compose, phase 2, the executor and the gateway after a confirm).
  const sum = k => on.reduce((n, r) => n + r.prepare[k], 0);
  assert.ok(sum('made') > 0, 'prepares made');
  assert.ok(sum('confirms') > 0, `no confirm ran:\n${paths.join('\n')}`);
  assert.ok(sum('entered') > 0, `no confirm entered a trade:\n${paths.join('\n')}`);
  // Off is the old path: no prepare field at all.
  assert.ok(Object.values(off).every(r => r.prepare.made === 0 && Object.keys(r.prepare.paths).length === 0));
});

test('tier 2 "on", every fallback row armed (the session lost, a corrupt plan, the confirm erring or hanging before a compose): the same as "off"', { skip }, async () => {
  const off = byDay(await offRuns());
  for (const fault of FAULTS) {
    // (A P&L change is the account's, so the off world has it too.)
    const base = fault === 'pnl-change' ? byDay(await T.runDays(FAULT_DAYS, { claude: { on: false, fault }, dir: OUT })) : off;
    const on = await T.runDays(FAULT_DAYS, { claude: { prepareAhead: 'on', fault }, dir: OUT });
    const problems = on.flatMap(r => PP.pairProblems(base[r.day], r));
    assert.deepStrictEqual(problems, [], `${fault}:\n${problems.join('\n')}`);
    // The row was hit: the confirm fell back (erring, hanging); a plan void by its lost session; a plan file corrupted.
    const hitOf = r => (fault.startsWith('confirm-') ? r.prepare.fellBack : fault === 'session-missing' ? (r.prepare.paths['void:session-missing'] || 0) : fault === 'pnl-change' ? (r.prepare.paths['void:facts'] || 0) : r.prepare.armed);
    const hit = on.reduce((n, r) => n + hitOf(r), 0);
    assert.ok(hit > 0, `${fault}: the row was never hit (${JSON.stringify(on.map(r => r.prepare))})`);
    if (!fault.startsWith('confirm-')) assert.ok(on.every(r => !r.prepare.paths.confirm), `${fault}: no confirm without its session or plan`);
  }
});

test('tier 2 "on" with headSkillsInPrompt: a confirm that loads nothing again (the prepare\'s loads in its context, the head trader\'s skills embedded and attested on the fork) gives the same as "off"', { skip }, async () => {
  const off = byDay(await T.runDays(FAULT_DAYS, { claude: { on: false, headSkillsInPrompt: true }, dir: OUT }));
  const on = await T.runDays(FAULT_DAYS, { claude: { prepareAhead: 'on', headSkillsInPrompt: true, skipLoads: true }, dir: OUT });
  const problems = on.flatMap(r => PP.pairProblems(off[r.day], r));
  assert.deepStrictEqual(problems, [], problems.join('\n'));
  assert.ok(on.reduce((n, r) => n + r.prepare.confirms, 0) > 0, 'confirms ran');
});

test('tier 2 "on" (the check can fail): a confirm that trusts the plan over the at-close facts, reached only by void plans let through (every plan void by a P&L change), makes "on" differ from "off"', { skip }, async () => {
  const off = byDay(await T.runDays(FAULT_DAYS, { claude: { on: false, fault: 'pnl-change' }, dir: OUT }));
  const on = await T.runDays(FAULT_DAYS, { claude: { prepareAhead: 'on', fault: 'pnl-change', trusting: true, voidBypass: true }, dir: OUT });
  const problems = on.flatMap(r => PP.pairProblems(off[r.day], r));
  assert.ok(on.reduce((n, r) => n + r.prepare.voidConfirms, 0) > 0, `no void plan reached the confirm: ${JSON.stringify(on.map(r => r.prepare))}`);
  assert.ok(problems.length > 0, 'the trusting confirm went unseen: the comparison cannot fail');
});
