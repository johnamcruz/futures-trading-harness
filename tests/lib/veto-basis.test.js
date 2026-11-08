'use strict';

// What a risk-manager phase-2 veto rests on (scripts/lib/trading/veto-basis.js): a hard step it names, or only a
// lesson, a journal note or a phase-1 restriction (agents/risk-manager.md: those are advice, never a veto). The lines
// are real phase-2 vetoes from replay runs (the account name replaced).

const test = require('node:test');
const assert = require('node:assert');
const { vetoBasis, BASES } = require('../../scripts/lib/trading/veto-basis');

const LESSON = [
  'VERDICT: VETO - 7 Risk and 2 Context: the lessons restrict prop_portfolio entries on both sides until the target-leg cancel cause is journaled, and phase 1\'s stand-down says prop_portfolio entries stand down: stand aside until that cause is journaled',
  'VERDICT: VETO - phase 1 stand-down: prop_portfolio entries stand down until the target-leg cancel cause is journaled, and it is still open; stand aside',
  '8 Decision: pass. The phase 1 restriction on prop_portfolio entries stands and phase 2 approval cannot lift it. Nothing else fails the hard steps.',
  'VERDICT: VETO - stand-down: prop_portfolio restriction stands (no lift journaled, target-leg cancel cause unjournaled); breakout limit 2.11 ATR above RTH VWAP exceeds the 2-ATR lesson: stand aside until the restriction is lifted in the journal.',
  'VERDICT: VETO - prop_portfolio restriction (phase 1): entries stay restricted until the target-leg cancel cause is journaled, and this entry carries a target bracket (49-tick stop, 98-tick target) with no bracket-role target shown working; phase 2 approval doesn\'t lift it. Stand aside',
  'VERDICT: VETO - phase-1 hard stop: the open prop_portfolio restriction (target-leg cancel cause not journaled, no lift in today\'s journal) blocks this entry; stand aside until the cause is journaled. The trade itself is otherwise sound: the composed short is in-trend and in-window',
  'VERDICT: VETO - setup restricted by lesson: a 3m close-top after a 3m CHoCH down (09:15) is the restricted long pattern, and structure, 3m CISD and the 5m engulfing read against; stand aside until a long trigger has no 3m CHoCH down ahead of it',
  'VERDICT: VETO - step 7 setup restricted by lesson: trade_lifecycle entries on MNQ are 0W/4L and all off-scan (lesson:off-scan, skip until a scan-backed entry shows positive expectancy); this 3m bar has no scan candidate, so stand aside until a scan-backed entry',
  'PLAN 8 Decision: the trade fails the restriction check (step 7), so no entry.',
  'Phase 2 verdict for MNQ long, 3m bar 10:45 ET: veto on the standing prop_portfolio restriction.',
];
const HARD = [
  'VERDICT: VETO - 1h CHoCH against the short: the last 1h break is a CHoCH up at 13069.25 (known 09:00), a decisive against for a short under confluence-counting. Stand aside until the 1h structure turns down with a 1h CHoCH down.',
  'VERDICT: VETO - policy skip: prop_portfolio\'s trade_lifecycle short was skipped on this bar (3 MNQ at $215.22 is over the $209.35 budget; min_contracts is 3), so there is no entry to approve; stand aside until the next verdict.',
  '7 Risk: order_plan refused the record\'s trade_lifecycle long. Its stop is 160 ticks, and at 3 MNQ it risks $243.72, over the $178.61 budget.',
  'VERDICT: VETO - restriction: the prop_portfolio entry restriction has no lift in the journal, and the requested 7 MNQ at a 47-tick stop is over the live verdict\'s up to 5 MNQ at 64 ticks; stand aside',
  'VERDICT: VETO - min-contracts: the record\'s size 2 is under the prop floor of 3 MNQ, and 3 contracts would risk $408.72 over trade_lifecycle\'s $300 cap; no trade, stand aside.',
  '8 Decision: stand aside. The trigger and the compose record are sound, but the size floor and the risk cap can\'t both be met at this stop.',
  'VERDICT: VETO - R:R contradiction: the bar briefing\'s Standard plan refuses "15m broke overnight high up" (no level at 2:1 or more, R:R 0.118)',
  '5 Confluence: the trade is composed (record f718e20b3b797636), but the policy verdict is skip. Analysts: short bias with low confidence, read mixed on both sides.',
  'VERDICT: VETO - room: stand aside',
  'VERDICT: VETO - blackout: CPI at 08:30 ET, the news window holds entries',
  'VERDICT: VETO - loss-streak stop: 2 losses in a row this session',
  'VERDICT: VETO - trend rule: the long is counter to the prevailing 4h down',
];

test('vetoBasis: a veto naming a hard step is hard-step, even beside a lesson; a lesson, journal note or phase-1 restriction alone is lesson', () => {
  for (const t of HARD) assert.strictEqual(vetoBasis(t), 'hard-step', t);
  for (const t of LESSON) assert.strictEqual(vetoBasis(t), 'lesson', t);
});

test('vetoBasis: a hard-step word in passing (budget, cap, floor, room, size) never makes a lesson veto hard-step; as the failed check it does', () => {
  for (const t of [
    'VERDICT: VETO - restriction: prop_portfolio entries stay restricted (lesson 2024-05-24); the room, the budget and the cap are fine otherwise; stand aside',
    'VERDICT: VETO - phase-1 stand-down: the lesson bars entries; size 3 is above the floor, but no lift is journaled',
    'VERDICT: VETO - restricted size by lesson: the 2024-05-24 lesson keeps prop_portfolio at size 1; stand aside',
  ]) assert.strictEqual(vetoBasis(t), 'lesson', t);
  for (const t of ['VERDICT: VETO - budget: 3 MNQ at $221 is over it', 'VERDICT: VETO - floor: 2 MNQ under it', 'VERDICT: VETO - size: no size fits at this stop']) assert.strictEqual(vetoBasis(t), 'hard-step', t);
});

test('vetoBasis on a replay run\'s 36 phase-2 vetoes (their result lines): 27 on a lesson alone, 6 on a hard step, 3 approvals misread', () => {
  const { cycleClass } = require('../../scripts/lib/learning/pass-class');
  const lines = require('../fixtures/phase2-vetoes-replay.json');
  const count = {};
  for (const result of lines) { const b = cycleClass({ result }).vetoBasis; count[b] = (count[b] || 0) + 1; }
  assert.deepStrictEqual(count, { lesson: 27, 'hard-step': 6, misread: 3 });
});

test('vetoBasis: a veto naming neither is unstated; nothing to read is null; the bases are the module\'s', () => {
  assert.strictEqual(vetoBasis('risk-manager vetoed the trade_lifecycle long 1 MNQ: Phase 2 verdict for MNQ long, 3m bar 14:00Z. I\'m standing aside.'), 'unstated');
  assert.strictEqual(vetoBasis('PLAN 5 Confluence: the compose record for trade_lifecycle short is OK. Its reads hold.'), 'unstated');
  assert.strictEqual(vetoBasis(''), null);
  assert.strictEqual(vetoBasis(null), null);
  assert.deepStrictEqual(BASES, ['hard-step', 'lesson', 'unstated']);
});
