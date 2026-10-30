'use strict';

// The prompt's Size and Min lines for a running prop attempt (scripts/lib/prop/size-line.js), from the code that sizes:
// phase 2's pacing rules (phase2-cut.js rulesHolding) and the floor stretch's health (size-translate.js attemptHealth).

const test = require('node:test');
const assert = require('node:assert');
const { sizeLines } = require('../../scripts/lib/prop/size-line');
const { rulesHolding } = require('../../scripts/lib/prop/phase2-cut');

const HEALTHY = { balance: 100200, start: 100000, peak: 100200, lossesToday: 0, lossStreak: 0, softRoom: 1000, dailyRoom: 2000, needed: 5800, nearTargetUsd: 500 };
const lines = (facts, o = {}) => sizeLines({ facts, riskUsd: 300, minContracts: 3, stretchUsd: 500, capUsd: 300, ...o });

test('a healthy account: the full verdict, the minimum, and the floor stretch it allows', () => {
  assert.deepStrictEqual(rulesHolding(HEALTHY, 300), []);
  assert.deepStrictEqual(lines(HEALTHY), [
    'Size: full verdict (healthy: balance ≥ start, no loss streak); phase 2 cuts only on a pacing rule',
    'Min: 3 contracts at the stop, else skip; where the $300 cap fits fewer, code stretches to $500 all in for exactly 3',
  ]);
});

test('each pacing rule phase 2 may cut on is named, as rulesHolding finds it; the stretch off while not healthy', () => {
  const [size, min] = lines({ ...HEALTHY, lossesToday: 1, lossStreak: 1 });
  assert.strictEqual(size, 'Size: phase 2 may cut (pacing: after-loss, streak)');
  assert.match(min, /^Min: 3 contracts at the stop, else skip; no floor stretch now \(1 losing trade today/);
  assert.strictEqual(lines({ ...HEALTHY, balance: 99000 })[0], 'Size: phase 2 may cut (pacing: drawdown)');
  assert.strictEqual(lines({ ...HEALTHY, softRoom: 250 })[0], 'Size: phase 2 may cut (pacing: soft-stop)');
  assert.strictEqual(lines({ ...HEALTHY, needed: 400 })[0], 'Size: phase 2 may cut (pacing: target)');
});

test('facts that can\'t be read are no healthy account (fails closed); no minimum stated, no Min line', () => {
  assert.strictEqual(lines(null)[0], 'Size: phase 2 may cut (the attempt\'s pacing facts can\'t all be read)');
  assert.strictEqual(lines({ ...HEALTHY, lossStreak: null })[0], 'Size: phase 2 may cut (the attempt\'s pacing facts can\'t all be read)');
  assert.strictEqual(lines(HEALTHY, { minContracts: undefined }).length, 1);
  // No stretch above the cap (off): the Min line states the floor only.
  assert.strictEqual(lines(HEALTHY, { stretchUsd: null })[1], 'Min: 3 contracts at the stop, else skip');
});

test('the prompt prints the Size and Min lines for an active prop attempt only (autotrader.js accountText)', () => {
  const { accountText } = require('../../scripts/lib/autotrader');
  const base = { account: 'acct', status: 'active', balance: 100, floor: 90, cushion: 10, profit: 1, target: 6, dayPnl: 0, sessionsLeft: 3, sessionsDone: 1, asOf: '2026-06-02T14:00:00Z', budgets: [], entryBlock: null, sizing: lines(HEALTHY) };
  const text = a => accountText({ id: 1, at: '2026-06-02T14:00:00Z', balance: 100, positions: [], workingOrders: 0, attempts: [a] });
  assert.match(text(base), /3 sessions left\. Size: full verdict \(healthy: balance ≥ start, no loss streak\); phase 2 cuts only on a pacing rule\. Min: 3 contracts at the stop, else skip; /);
  assert.doesNotMatch(text({ ...base, status: 'passed' }), /Size:|Min:/);
  assert.doesNotMatch(text({ ...base, sizing: undefined }), /Size:|Min:/);
  assert.doesNotMatch(accountText({ id: 1, at: '2026-06-02T14:00:00Z', balance: 100, positions: [], workingOrders: 0 }), /Size:/, 'no attempt: no Size line');
});
