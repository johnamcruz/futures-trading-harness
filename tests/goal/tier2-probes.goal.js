'use strict';

/**
 * Tier 2's negative probes (npm run goal:full): the plan-following mock alone can't see a gate that fails open, so on
 * a probe day the mock also sends what the gate must refuse (tests/fixtures/goal-world.js entryProbes, openProbes), each
 * through the real gateway, and each refusal is asserted by its tag (or compose_check's problem):
 *   an entry under the policy against the Bias line, before any verdict   [entry-rule]
 *   a combination whose setup is a 3m read                               compose: NOT OK, a setup problem
 *   the side against the record and the trend rule                       [mtf-trend]
 *   a size above the verdict's / below the rulebook's floor              [phase2-size] / [min-contracts]
 *   the entry without a bracket stop                                     [stop-defined]
 *   a second position while one is open                                  [prop-one-position]
 *   the bracket stop moved to loosen the risk                            [modify-protection]
 * (An expired record is the order-latency self-test's: tier2-breaks.goal.js.) Mutation check: the policy's entry rule
 * turned off in the order gate (a copy of the tree: `if (false && why)`) must fail the entry-rule probe.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./tier2-run');
const GP = require('../../scripts/lib/eval/goal-path');
const { tmpDir, treeCopy } = require('../helpers');

const SET = (() => { try { return T.set(); } catch (err) { return { missing: err.message }; } })();
const skip = SET.missing ? `skipped: ${SET.missing}` : false;
const GOLDEN = skip ? null : T.readGolden();
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-probes-'));
// The probe day: the move day whose trade stays open longest past its fill (the open probes need a managed pass).
const DAY = skip ? null : GOLDEN.scenarios.filter(s => s.layers && s.layers.exit.moves.length).sort((a, b) => Date.parse(a.layers.exit.time) - Date.parse(b.layers.exit.time))[0].day;
const EXPECTED = {
  'counter-bias, no verdict': { tag: 'entry-rule' },
  'no 15m setup': { says: 'PROBLEM: [^\\n]*setup' },
  'counter-bias': { tag: 'mtf-trend' },
  'size above the verdict': { tag: 'phase2-size' },
  'size below the floor': { tag: 'min-contracts' },
  'no bracket stop': { tag: 'stop-defined' },
  'a second position while one is open': { tag: 'prop-one-position' },
  'the stop moved to loosen the risk': { tag: 'modify-protection' },
};
const run = root => T.runDays([DAY], { probe: true, root, parallel: 1, dir: OUT }).then(r => r[0]);

// Its checks at once (each its own processes): the job's time is the slowest one's.
test.describe('tier 2 negative probes', { concurrency: true }, () => {
  test('tier 2 negative probes: every order the gate must refuse is refused, by its own tag', { skip }, async () => {
    const d = await run();
    process.stdout.write(`${d.probes.map(p => `${p.name}: ${[...String(p.text).matchAll(/\[([a-z0-9-]+)\]/g)].map(m => m[1]).join(', ') || String(p.text).slice(0, 80)}`).join('\n')}\n`);
    assert.deepStrictEqual(GP.probeProblems(d.probes, EXPECTED), []);
  });

  test('tier 2 negative probes mutation check: the policy\'s entry rule off in the gate fails the entry-rule probe', { skip }, async () => {
    const root = treeCopy(tmpDir(), r => {
      const f = path.join(r, 'scripts', 'lib', 'trading', 'order-gate.js');
      const text = fs.readFileSync(f, 'utf8');
      const from = "if (why) violations.push({ check: 'entry-rule', message: why });";
      assert.ok(text.includes(from), 'the gate\'s entry-rule check');
      fs.writeFileSync(f, text.replace(from, "if (false && why) violations.push({ check: 'entry-rule', message: why });"));
    });
    const problems = GP.probeProblems((await run(root)).probes, EXPECTED);
    assert.ok(problems.some(p => /^counter-bias, no verdict: not refused by \[entry-rule\]/.test(p)), `the mutation must fail the probe; it said: ${problems.join('; ') || 'nothing'}`);
  });
});
