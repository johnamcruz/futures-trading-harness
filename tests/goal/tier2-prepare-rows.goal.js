'use strict';

/**
 * The goal regression's tier 2 with prepare ahead, its fallback rows and controls (docs/PREPARE-AHEAD.md "Tier 2 with
 * prepare ahead"; the days' pair is tier2-prepare.goal.js, its own CI part beside this one). On the first of tier 2's
 * days (every row is hit there, and a confirm enters: tests/goal/prepare-pair.js prepareOf), on Claude Code with
 * headSkillsInPrompt: "on" gives exactly "off"'s trades, order calls, gate decisions, compose records, cycle results and
 * R under every fallback row armed (prepare-mock.js FAULTS: the session lost, a corrupt plan, the confirm erring or
 * hanging before a compose, a P&L change voiding every plan), each row hit; and with a confirm that loads nothing again.
 * The check can fail: a confirm that trusts the plan over the at-close facts makes "on" differ, on valid plans (the
 * anchoring risk) and on void plans let through by the runner's validity check broken.
 *
 * Each row and control is its own test, run side by side at tier 2's configured parallel (each one day-run in its own
 * process); the off runs (the day as it is, and with the P&L change) are made once and shared (prepare-pair.js pairRuns).
 */

const { describe, test } = require('node:test');
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
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-prepare-rows-'));
// The day the fallback rows and the controls run on: the first (every row is hit there, and a confirm enters).
const ROW_DAYS = DAYS.slice(0, 1);
const { offFor, onOf, pair, sum } = PP.pairRuns({ runDays: T.runDays, dir: OUT });
const concurrency = require('../../scripts/lib/tunables').training().goalRegression.tier2.parallel;

describe('tier 2 "on": the fallback rows and the controls, on the first day', { skip, concurrency }, () => {
  for (const fault of FAULTS) {
    test(`tier 2 "on", the fallback row armed (${fault}): the same as "off", the row hit`, async () => {
      // (A P&L change is the account's, so the off world has it too.)
      const off = await offFor(ROW_DAYS, fault === 'pnl-change' ? { fault } : {});
      const on = await onOf(ROW_DAYS, { fault });
      const problems = pair(off, on);
      assert.deepStrictEqual(problems, [], `${fault}:\n${problems.join('\n')}`);
      // The row was hit: the confirm fell back (erring, hanging); a plan void by its lost session or the facts; a plan
      // file corrupted.
      const hitOf = r => (fault.startsWith('confirm-') ? r.prepare.fellBack : fault === 'session-missing' ? (r.prepare.paths['void:session-missing'] || 0) : fault === 'pnl-change' ? (r.prepare.paths['void:facts'] || 0) : r.prepare.armed);
      const hit = on.reduce((n, r) => n + hitOf(r), 0);
      assert.ok(hit > 0, `${fault}: the row was never hit (${JSON.stringify(on.map(r => r.prepare))})`);
      if (!fault.startsWith('confirm-')) assert.ok(on.every(r => !r.prepare.paths.confirm), `${fault}: no confirm without its session or plan`);
    });
  }

  test('tier 2 "on": a confirm that loads nothing again (the prepare\'s loads in its context, the head trader\'s skills embedded and attested on the fork) gives the same as "off", and enters', async () => {
    const off = await offFor(ROW_DAYS);
    const on = await onOf(ROW_DAYS, { skipLoads: true });
    const problems = pair(off, on);
    assert.deepStrictEqual(problems, [], problems.join('\n'));
    assert.ok(sum(on, 'confirms') > 0, 'confirms ran');
    assert.ok(sum(on, 'entered') > 0, `no confirm entered without loading again: ${JSON.stringify(on.map(r => r.prepare))}`);
  });

  test('tier 2 "on" (the check can fail): a confirm that trusts the plan over the at-close facts on VALID plans (the anchoring risk) makes "on" differ from "off"', async () => {
    const off = await offFor(ROW_DAYS);
    const on = await onOf(ROW_DAYS, { trusting: true, trustValid: true });
    assert.ok(sum(on, 'confirms') > 0, 'the trusting confirm ran');
    assert.ok(pair(off, on).length > 0, 'a trusting confirm on valid plans went unseen: the comparison cannot fail');
  });

  test('tier 2 "on" (the check can fail): a confirm that trusts the plan, reached only by void plans let through (every plan void by a P&L change), makes "on" differ from "off"', async () => {
    const off = await offFor(ROW_DAYS, { fault: 'pnl-change' });
    const on = await onOf(ROW_DAYS, { fault: 'pnl-change', trusting: true, voidBypass: true });
    assert.ok(sum(on, 'voidConfirms') > 0, `no void plan reached the confirm: ${JSON.stringify(on.map(r => r.prepare))}`);
    assert.ok(pair(off, on).length > 0, 'the trusting confirm went unseen: the comparison cannot fail');
  });
});
