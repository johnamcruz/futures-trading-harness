'use strict';

// The prop sizing floor (the rulebook's sizing.min_contracts, the owner's 2026-10-23 decision) as the documents the
// model acts on teach it: the examples size at full, tick-correct sizes (never size 1, which anchored the head trader to
// 1-micro trades), a cut example stays at or over the floor, and the floor's refusal and skip are taught where the
// trader sizes and where the gate's refusals are explained.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = s => s.replace(/\n\s*/g, ' ');
// MNQ: $0.50 a tick; the examples' 111-tick stop is $55.50 a contract.
const MNQ_TICK = 0.5;

test('prop floor content: the examples size at full, tick-correct sizes, never size 1', () => {
  const tp = read('skills/trader-process/SKILL.md');
  const risk = /^7 Risk: stop 111.*$/m.exec(tp)[0];
  assert.match(risk, /stop 111 ticks, .*size 5 \(\$277\.50\)/);
  assert.doesNotMatch(risk, /size 1\b/);
  assert.strictEqual(5 * 111 * MNQ_TICK, 277.5);
  assert.match(read('skills/trade-session/SKILL.md'), /111 ticks = \$55\.50\),\ntarget 21598\.00 \(231 ticks, 2\.08R\), 5 MNQ \(\$277\.50\)\./);
  assert.match(read('skills/trade-plan/SKILL.md'), /^plan: trade_lifecycle long, stop 111 ticks, target 231 ticks, size 5 \(\$277\.50\) from the compose record$/m);
  assert.match(read('skills/trade-lifecycle/SKILL.md'), /compose-check\.js --symbol MNQ --side long --size 5 --reads/);
  assert.strictEqual(111 * MNQ_TICK, 55.5);
});

test('prop floor content: the risk manager\'s cut example stays at or over the floor; a cut under it is a veto', () => {
  const rm = flat(read('agents/risk-manager.md'));
  const size = /e\.g\. `Size: (\d+) \(record (\d+) cut to (\d+)/.exec(rm);
  assert.ok(size, 'a Size line example with a cut');
  const floor = require('../../scripts/lib/trading/strategies').loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio').sizing.min_contracts;
  assert.ok(Number(size[1]) >= floor && Number(size[3]) === Number(size[1]) && Number(size[2]) > Number(size[3]), size[0]);
  assert.ok(rm.includes("In a prop attempt, never under the rulebook's `min_contracts` (a cut under it is no trade: veto instead)."));
  assert.doesNotMatch(rm, /cut to size 1\b|cut to 1\b/);
});

test('prop floor content: the floor is taught where the trader sizes and where the gate\'s refusals are explained', () => {
  const ps = flat(read('skills/position-sizing/SKILL.md'));
  assert.ok(ps.includes("**The floor:** a prop entry is at least the rulebook's `min_contracts`"));
  assert.ok(ps.includes('never a tighter stop, never a size under the floor (the gate refuses it, `[min-contracts]`)'));
  assert.ok(ps.includes("a full verdict's size is the verdict's, never 1 by habit"));
  const lim = read('skills/gate-refusals-limits/SKILL.md');
  assert.match(lim, /^\| `\[min-contracts\] setup:<policy>: size <n> <ROOT> is under the floor of <m> contracts` \| .* \| .*skip\. Never a tighter stop, never split\./m);
  assert.match(flat(read('skills/prop-challenge-pacing/SKILL.md')), /`\[min-contracts\]`.*under the rulebook's `min_contracts` \(fewer fit: skip, never a tighter stop\)/);
  assert.match(flat(read('rules/trading/risk-management.md')), /never trade under the rulebook's `min_contracts` \(fewer fit: skip\)/);
  // The gate's own message names the tag the skill row explains.
  const prop = require('../../scripts/lib/trading/prop-state');
  const msg = prop.minContractsRefusal({ name: 'prop_portfolio', sizing: { min_contracts: 3 } }, null, 'MNQ', 2);
  assert.match(msg, /^setup:prop_portfolio: size 2 MNQ is under the floor of 3 contracts/);
});
