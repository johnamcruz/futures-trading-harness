'use strict';

// The prompt's Size and Min lines for a running prop attempt (scripts/lib/prop/size-line.js), from the code that sizes:
// phase 2's pacing rules (phase2-cut.js rulesHolding) and the floor stretch's health (size-translate.js attemptHealth).

const test = require('node:test');
const assert = require('node:assert');
const { sizeLines, worstRisk } = require('../../scripts/lib/prop/size-line');
const { rulesHolding } = require('../../scripts/lib/prop/phase2-cut');

const HEALTHY = { balance: 100200, start: 100000, peak: 100200, lossesToday: 0, lossStreak: 0, softRoom: 1000, dailyRoom: 2000, needed: 5800, nearTargetUsd: 500 };
// The Size line names rulesHolding's own conditions (phase2-cut.js), not the floor stretch's health (the Min line's).
const FULL = 'Size (prop attempt): the full verdict size; a serious factor against never cuts it. Phase 2 cuts only on a pacing rule; none holds now (no loss today or streak; balance at or above start and peak; room to the soft and daily stops; not near the target)';
const lines = (facts, o = {}) => sizeLines({ facts, riskUsd: 300, minContracts: 3, stretchUsd: 500, capUsd: 300, ...o });

test('a healthy account: the full verdict, the minimum, and the floor stretch it allows', () => {
  assert.deepStrictEqual(rulesHolding(HEALTHY, 300), []);
  assert.deepStrictEqual(lines(HEALTHY), [
    FULL,
    'Min: 3 contracts at the stop, never fewer. Fewer fit under the $300 cap → skip, or exactly 3 by the floor stretch (balance ≥ start, no loss today; up to $500 all in)',
  ]);
  // Never readable as leave to trade fewer than the floor (a model read the old stretch clause as 2 allowed).
  assert.doesNotMatch(lines(HEALTHY)[1], /\b[12] contracts?\b|fewer (are|is) (ok|allowed)/);
});

test('each pacing rule phase 2 may cut on is named, as rulesHolding finds it; the stretch off while not healthy', () => {
  const [size, min] = lines({ ...HEALTHY, lossesToday: 1, lossStreak: 1 });
  assert.strictEqual(size, 'Size (prop attempt): phase 2 may cut (pacing: after-loss, streak)');
  assert.match(min, /^Min: 3 contracts at the stop, never fewer\. Fewer fit under the \$300 cap → skip; no floor stretch now \(1 losing trade today/);
  assert.strictEqual(lines({ ...HEALTHY, balance: 99000 })[0], 'Size (prop attempt): phase 2 may cut (pacing: drawdown)');
  assert.strictEqual(lines({ ...HEALTHY, softRoom: 250 })[0], 'Size (prop attempt): phase 2 may cut (pacing: soft-stop)');
  assert.strictEqual(lines({ ...HEALTHY, needed: 400 })[0], 'Size (prop attempt): phase 2 may cut (pacing: target)');
});

test('the soft stop is judged at the most one entry may risk: with $400 of room, a $500 floor stretch can reach it', () => {
  assert.strictEqual(worstRisk({ capUsd: 300, stretchUsd: 500, budgetUsd: 450 }), 500);
  assert.strictEqual(worstRisk({ capUsd: 300, stretchUsd: 'off', budgetUsd: 450 }), 300);
  assert.strictEqual(worstRisk({ capUsd: null, budgetUsd: 450 }), 450);
  assert.strictEqual(worstRisk({}), null);
  const room = { ...HEALTHY, softRoom: 400 };
  // At the $300 cap the soft stop isn't reached; at the stretch's $500 it is: the line never says full there.
  assert.strictEqual(lines(room, { riskUsd: 300 })[0], FULL);
  assert.strictEqual(lines(room, { riskUsd: worstRisk({ capUsd: 300, stretchUsd: 500 }) })[0], 'Size (prop attempt): phase 2 may cut (pacing: soft-stop)');
  assert.deepStrictEqual(rulesHolding(room, 500), ['soft-stop'], 'the gate\'s check on a stretched entry finds the same');
});

test('facts that can\'t be read are no healthy account (fails closed); no minimum stated, no Min line', () => {
  assert.strictEqual(lines(null)[0], 'Size (prop attempt): phase 2 may cut (the attempt\'s pacing facts can\'t all be read)');
  assert.strictEqual(lines({ ...HEALTHY, lossStreak: null })[0], 'Size (prop attempt): phase 2 may cut (the attempt\'s pacing facts can\'t all be read)');
  assert.strictEqual(lines(HEALTHY, { minContracts: undefined }).length, 1);
  // A room that can't be read never reads as full (phase2-cut.js rulesHolding: unknown, as the other facts).
  for (const room of [{ softRoom: undefined }, { dailyRoom: NaN }]) assert.strictEqual(lines({ ...HEALTHY, ...room })[0], 'Size (prop attempt): phase 2 may cut (the attempt\'s pacing facts can\'t all be read)', JSON.stringify(room));
  // No stretch above the cap (off): the Min line states the floor only.
  assert.strictEqual(lines(HEALTHY, { stretchUsd: null })[1], 'Min: 3 contracts at the stop, never fewer; fewer → skip');
});

test('the prompt prints the Size and Min lines for an active prop attempt only (autotrader.js accountText)', () => {
  const { accountText } = require('../../scripts/lib/autotrader');
  const base = { account: 'acct', status: 'active', balance: 100, floor: 90, cushion: 10, profit: 1, target: 6, dayPnl: 0, sessionsLeft: 3, sessionsDone: 1, asOf: '2026-06-02T14:00:00Z', budgets: [], entryBlock: null, sizing: lines(HEALTHY) };
  const text = a => accountText({ id: 1, at: '2026-06-02T14:00:00Z', balance: 100, positions: [], workingOrders: 0, attempts: [a] });
  assert.match(text(base), /3 sessions left\. Size \(prop attempt\): the full verdict size; a serious factor against never cuts it\. Phase 2 cuts only on a pacing rule; none holds now \([^)]*\)\. Min: 3 contracts at the stop, never fewer\. Fewer fit under the \$300 cap → skip, or exactly 3 by the floor stretch [^\n]*all in\)\.$/);
  assert.doesNotMatch(text({ ...base, status: 'passed' }), /Size \(prop attempt\)|Min:/);
  assert.doesNotMatch(text({ ...base, sizing: undefined }), /Size \(prop attempt\)|Min:/);
  assert.doesNotMatch(accountText({ id: 1, at: '2026-06-02T14:00:00Z', balance: 100, positions: [], workingOrders: 0 }), /Size \(prop attempt\)/, 'no attempt: no Size line');
});
