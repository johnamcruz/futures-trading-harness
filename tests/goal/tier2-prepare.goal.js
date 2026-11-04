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
 * Split in two CI parts (each its own goal file, run side by side): this one, every day off and "on" (12 day-runs at
 * the configured parallel); tier2-prepare-rows.goal.js, the fallback rows and the controls on the first day. The days'
 * off runs are made once (prepare-pair.js pairRuns).
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

const SET = (() => { try { return T.set(); } catch (err) { return { missing: err.message }; } })();
const skip = SET.missing ? `skipped: ${SET.missing}` : false;
const DAYS = skip ? [] : T.tier2Days();
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-prepare-'));
const { offFor, onOf, pair, sum } = PP.pairRuns({ runDays: T.runDays, dir: OUT });

test('tier 2 "on": on every day the same trades, order calls, gate decisions, compose records, cycle results and R as "off"; confirms ran, one entered', { skip }, async () => {
  const off = await offFor(DAYS);
  const on = await onOf(DAYS);
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
