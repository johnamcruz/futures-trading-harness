'use strict';

// The tier-2 prepare mock's void bypass (tests/fixtures/prepare-mock.js beforePass, the negative control's broken
// runner): a void plan it lets through must reach the confirm as a real confirm path does (confirmPath's shape, every
// matched scenario included), or the confirm's message cannot be built and the control never runs its trusting confirm.

const test = require('node:test');
const assert = require('node:assert');
const PA = require('../../scripts/lib/prepare-ahead');
const PM = require('../fixtures/prepare-mock');

test('prepare mock: the void bypass gives a void, matched plan the confirm path as confirmPath does (matched, scenario, kind), so its message builds', () => {
  const orig = PA.confirmPath;
  try {
    const w = { claude: { voidBypass: true }, home: '/nonexistent-home', state: null };
    PM.beforePass(w);
    assert.notStrictEqual(PA.confirmPath, orig, 'the bypass installed');
    const cands = [{ id: 'P1', kind: 'momentum', read: 'm fired up', side: 'long', tf: '3m' }, { id: 'P2', kind: 'standing', read: 's up', side: 'long', tf: '15m', fires: 'FIRES' }];
    const text = 'SCENARIO 1: P1 "m fired up" → TAKE if a | PASS if b; reads: "m fired up"; why: w\nSCENARIO 2: P2 "s up" → TAKE if a wick | PASS if not; reads: "s up"; why: w';
    // Void by its lost session (the plan's own transcript gone).
    const plan = { next: { t: 'T' }, session: { id: 's', transcript: '/gone/s.jsonl' }, candidates: cands, ...PA.parsePlan(text), base: { uuids: ['u'] } };
    const p = PA.confirmPath({ plan, at: { asOf: 'T' }, fired: ['m fired up', 's up', 'x up'], killSwitch: false, flat: true });
    assert.strictEqual(p.path, 'confirm');
    assert.strictEqual(w.claude.bypassNow, true);
    assert.deepStrictEqual(p.match, { k: 1, id: 'P1', read: 'm fired up', side: 'long' });
    assert.deepStrictEqual(p.matched.map(x => [x.scenario.k, x.kind]), [[1, 'momentum'], [2, 'standing']]);
    assert.strictEqual(p.scenario, plan.scenarios[0]);
    assert.strictEqual(p.kind, 'momentum');
    assert.deepStrictEqual(p.unplanned, ['x up']);
    // The confirm's message, as prepare-shadow.js atClose builds it: it builds, names both, the standing one by code.
    const suffix = PA.confirmSuffix({ matched: p.matched, unplanned: p.unplanned });
    assert.ok(suffix.includes('Your plan said: scenario 1:') && suffix.includes(`scenario 2:\n${PA.standingScenarioLine(plan.scenarios[1], cands[1])}\n`), suffix);
  } finally {
    PA.confirmPath = orig;
  }
});
