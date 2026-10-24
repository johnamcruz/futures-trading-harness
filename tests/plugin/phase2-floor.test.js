'use strict';

// Phase 2's cut floors at min_contracts, never a veto under it (the owner, 2026-10-23: "Default is 3 minimum floor";
// "Skip if 3 is expensive"): the risk manager's teaching, the request the runner sends it, and the floored approval read
// by the code as the size it states. Code is as strict as before: an approval under the floor is still no trade
// ([min-contracts], tests/lib/runner-entry.test.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { verdictOf, approvedSize, decisiveLine } = require('../../scripts/lib/trading/roles-ran');
const { REQUESTS } = require('../../scripts/lib/orchestrate/requests');

const ROOT = path.resolve(__dirname, '..', '..');
const flat = s => s.replace(/\s+/g, ' ');

test('phase 2 floor: the risk manager cut floors at min_contracts, never a veto under it (an untradable translation is code\'s skip)', () => {
  const rm = flat(fs.readFileSync(path.join(ROOT, 'agents', 'risk-manager.md'), 'utf8'));
  assert.ok(rm.includes('In a prop attempt, full is the translated size your request names, half its cut, floored at min_contracts.'));
  assert.ok(rm.includes('(never the record\'s; floored at min_contracts)'));
  assert.ok(!/under min_contracts: VETO/.test(rm), 'no veto under the floor');
});

test('phase 2 floor: the request names the floor as where a cut stops, never a veto', () => {
  const req = REQUESTS.review('risk-manager', { symbol: 'MNQ', at: '2026-10-07T14:27:00.000Z', timeframe: 3, strategy: 'prop_portfolio', side: 'long', entrySize: { size: 5, contract: 'MNQ', suggested: 1, reason: 'the rulebook\'s size at this stop', floor: 3 } });
  assert.match(req, /Approve that size \(your VERDICT line's size 5\), or cut it, never under 3 \(a cut below it is 3, never a veto\); the record's size is a suggestion/);
  assert.ok(!/veto instead/.test(req));
});

test('phase 2 floor: a halving floored at 3 reads as an approval of 3 (the report format\'s own readers)', () => {
  const text = 'Size: 3 (the translated 5 halved to 2 on serious against, floored at min_contracts 3)\nVERDICT: APPROVE - size 3, risk $166.50, trade_lifecycle long, serious against halved, floored\nFACTS: window opening drive; trend long allowed';
  assert.strictEqual(verdictOf(text), 'APPROVE');
  assert.deepStrictEqual(approvedSize(text), { size: 3 });
  assert.match(decisiveLine(text), /^VERDICT: APPROVE - size 3/);
});
