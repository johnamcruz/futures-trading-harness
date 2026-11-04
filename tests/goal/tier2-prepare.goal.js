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
 * with confirms actually run. And the check can fail: a confirm that trusts the plan over the at-close facts (it decides
 * on the briefing the prepare was made on), with the runner's validity check broken so a void plan reaches it, makes
 * "on" differ from "off".
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
  // Not vacuous: the confirm decided at some close, on the fork of its prepare's session, and plans were made.
  assert.ok(on.reduce((n, r) => n + r.prepare.confirms, 0) > 0, `no confirm ran:\n${paths.join('\n')}`);
  assert.ok(on.every(r => r.prepare.made > 0), 'a prepare on every day');
  // Off is the old path: no prepare field at all.
  assert.ok(Object.values(off).every(r => r.prepare.made === 0 && Object.keys(r.prepare.paths).length === 0));
});

test('tier 2 "on", every fallback row armed (the session lost, a corrupt plan, the confirm erring or hanging before a compose): the same as "off"', { skip }, async () => {
  const off = byDay(await offRuns());
  for (const fault of FAULTS) {
    const on = await T.runDays(FAULT_DAYS, { claude: { prepareAhead: 'on', fault }, dir: OUT });
    const problems = on.flatMap(r => PP.pairProblems(off[r.day], r));
    assert.deepStrictEqual(problems, [], `${fault}:\n${problems.join('\n')}`);
    // The row was hit: the confirm fell back (erring, hanging), or no close reached the confirm (no session, no plan).
    const hit = on.reduce((n, r) => n + (fault.startsWith('confirm-') ? r.prepare.fellBack : (r.prepare.paths.void || 0) + (r.prepare.paths['no-plan'] || 0)), 0);
    assert.ok(hit > 0, `${fault}: the row was never hit (${JSON.stringify(on.map(r => r.prepare))})`);
    if (!fault.startsWith('confirm-')) assert.ok(on.every(r => !r.prepare.paths.confirm), `${fault}: no confirm without its session or plan`);
  }
});

test('tier 2 "on" (the check can fail): a confirm that trusts the plan over the at-close facts, a void plan let through, makes "on" differ from "off"', { skip }, async () => {
  const off = byDay(await offRuns());
  const on = await T.runDays(FAULT_DAYS, { claude: { prepareAhead: 'on', trusting: true, voidBypass: true }, dir: OUT });
  const problems = on.flatMap(r => PP.pairProblems(off[r.day], r));
  assert.ok(on.reduce((n, r) => n + r.prepare.voidConfirms, 0) > 0, `no void plan reached the confirm: ${JSON.stringify(on.map(r => r.prepare))}`);
  assert.ok(problems.length > 0, 'the trusting confirm went unseen: the comparison cannot fail');
});
