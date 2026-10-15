'use strict';

// The schedule moved from code to config/schedule.json with behaviour unchanged: every day from 2020-01 through
// 2027-01 has the same learning role and look rule, the same prop role, block, part, LLM flag, unit bounds and look
// rule, and the same flow coverage as the code had before (tests/fixtures/schedule/golden-days.json, frozen from it).

const test = require('node:test');
const assert = require('node:assert');
const GOLDEN = require('../fixtures/schedule/golden-days.json');
const schedule = require('../../scripts/lib/schedule');
const propSplits = require('../../scripts/lib/prop/splits');

const DAY = 86400000;
const days = (from, to) => {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/** A day as the golden file holds it, from the resolver. */
function now(d) {
  const l = schedule.resolve(d, 'learning');
  const p = schedule.resolve(d, 'prop');
  return {
    learning: l.role ? { role: l.role, look: l.look } : null,
    prop: p.role ? { role: p.role, block: p.block, part: p.part, llm: p.llm, from: p.from, to: p.to, look: p.look } : null,
    flow: propSplits.isFlowCovered(d),
  };
}

test('every day 2020-01 to 2027-01 resolves to the role and look rule the code gave it before the schedule was config', () => {
  let n = 0;
  for (const run of GOLDEN.runs) {
    const want = { learning: run.learning, prop: run.prop, flow: run.flow };
    for (const d of days(run.from, run.to)) {
      assert.deepStrictEqual(now(d), want, d);
      n += 1;
    }
  }
  assert.strictEqual(n, days('2020-01-01', '2027-01-31').length, 'the golden file covers every day, once');
  // The file covers the roles the schedule has: no role is missing from it.
  const roles = new Set(GOLDEN.runs.flatMap(r => [r.learning && r.learning.role, r.prop && r.prop.role]).filter(Boolean));
  for (const r of ['practice-train', 'practice-validate', 'test', 'final', 'train', 'select', 'oos', 'recent', 'walk-forward', 'reserve']) assert.ok(roles.has(r), r);
});
