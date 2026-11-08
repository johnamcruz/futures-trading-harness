'use strict';

// Why a composed decision didn't trade (scripts/lib/learning/pass-class.js): the model's own pass, or the runner's,
// the risk manager's, the gate's or the market's. The result lines are real ones from replay runs (the account name
// replaced): run 05 counted 16 missed entries, 10 unfilled, 4 invalidated, 6 vetoes and 4 gate blocks as `passed`.

const test = require('node:test');
const assert = require('node:assert');
const P = require('../../scripts/lib/learning/pass-class');

const R = {
  missed: 'CYCLE RESULT: no-trade - the runner\'s entry: missed the plan\'s entry 13879.75 (price 13876.25 is 3.5 points past it against the long: 29% of the 12-point risk toward the stop, over 0.25R; the setup\'s premise is in question): the limit would fill away from the plan: no late entry (the 1m price at 2021-05-03T13:39:00.000Z). Pass; the next bar composes on its own facts',
  invalidated: 'CYCLE RESULT: no-trade - the runner\'s entry: the setup was invalidated before the order went (price 13540 beyond the plan\'s stop 13541.5): no late entry (the 1m price at 2021-05-06T14:50:00.000Z). Pass; the next bar composes on its own facts',
  vetoed: 'CYCLE RESULT: no-trade - risk-manager vetoed the trade_lifecycle short 1 MNQ: VERDICT: VETO - phase 1 stand-down: prop_portfolio entries stand down until the target-leg cancel cause is journaled, and it is still open; stand aside',
  vetoedHard: 'CYCLE RESULT: no-trade - risk-manager vetoed the trade_lifecycle short 5 MNQ: VERDICT: VETO - 1h CHoCH against the short: the last 1h break is a CHoCH up at 13069.25 (known 09:00), a decisive against for a short',
  misread: 'CYCLE RESULT: no-trade - risk-manager phase 2\'s report reads as a veto (a verdict line decides 66, not APPROVE): VERDICT: APPROVE - size 4, risk $132, trade_lifecycle long on the prop_portfolio verdict (66-tick stop, 3.65R target)',
  blocked: 'CYCLE RESULT: blocked - the order gate refused the trade_lifecycle short 3 MNQ: [phase2-facts] Risk-manager phase 2\'s FACTS line holds an item the gate can\'t read',
  unsized: 'CYCLE RESULT: no-trade - the runner\'s entry: risk-manager phase 2 approved without a size the runner can read (no Size line): no order',
  expired: 'CYCLE RESULT: no-trade - the composed record expired before the order',
  executed: 'CYCLE RESULT: executed - trade_lifecycle long 9 MNQ (the runner\'s entry: phase 2 approved, the order is working, unfilled: order 159, limit 13653)',
  declined: 'CYCLE RESULT: no-trade - compose_check OK for MNQ short 2 (18609.5 to stop 18655, target 18511.25, 2.16R), passed: the 3m trend is up against the short',
  planned: 'CYCLE RESULT: planned - trade_lifecycle long 3',
};

test('classOfResult: each runner, risk-manager and gate outcome by its result line; the head trader\'s own no-trade is declined', () => {
  assert.strictEqual(P.classOfResult(R.missed), 'missed_fill');
  assert.strictEqual(P.classOfResult(R.invalidated), 'invalidated');
  assert.strictEqual(P.classOfResult(R.vetoed), 'vetoed');
  assert.strictEqual(P.classOfResult(R.vetoedHard), 'vetoed');
  assert.strictEqual(P.classOfResult(R.misread), 'vetoed');
  assert.strictEqual(P.classOfResult(R.blocked), 'blocked');
  assert.strictEqual(P.classOfResult(R.unsized), 'runner_skip');
  assert.strictEqual(P.classOfResult(R.expired), 'runner_skip');
  assert.strictEqual(P.classOfResult(R.planned), 'runner_skip', 'planned with no entry run: the runner never placed it');
  assert.strictEqual(P.classOfResult(R.executed), 'unfilled', 'sent, never filled');
  assert.strictEqual(P.classOfResult(R.declined), 'declined');
  assert.strictEqual(P.classOfResult('CYCLE RESULT: error - timed out'), 'runner_skip', 'the cycle failed');
  assert.strictEqual(P.classOfResult('CYCLE RESULT: managed - holding the long'), null, 'a managed cycle enters nothing: unknown');
  assert.strictEqual(P.classOfResult('no result line'), null);
  assert.strictEqual(P.classOfResult(null), null);
});

test('classOfEntry: the runner\'s entry record decides first: late by its kind, vetoed with its basis, misread apart', () => {
  assert.strictEqual(P.classOfEntry({ outcome: 'late', late: 'missed-entry' }), 'missed_fill');
  assert.strictEqual(P.classOfEntry({ outcome: 'late', late: 'chased-entry' }), 'missed_fill');
  assert.strictEqual(P.classOfEntry({ outcome: 'late', late: 'beyond-stop' }), 'invalidated');
  assert.strictEqual(P.classOfEntry({ outcome: 'late', late: 'no-price' }), 'runner_skip');
  assert.strictEqual(P.classOfEntry({ outcome: 'late' }), null, 'no kind: the result line decides');
  for (const o of ['expired', 'no-trade', 'error', 'process-failure', 'aborted']) assert.strictEqual(P.classOfEntry({ outcome: o }), 'runner_skip', o);
  assert.strictEqual(P.classOfEntry({ outcome: 'vetoed' }), 'vetoed');
  assert.strictEqual(P.classOfEntry({ outcome: 'blocked' }), 'blocked');
  assert.strictEqual(P.classOfEntry({ outcome: 'executed' }), 'unfilled');
  assert.strictEqual(P.classOfEntry(null), null);
});

test('cycleClass: { passClass, vetoBasis } from the entry record, else the result line; the veto\'s basis from its line', () => {
  assert.deepStrictEqual(P.cycleClass({ entry: { outcome: 'late', late: 'missed-entry' }, result: R.declined }), { passClass: 'missed_fill', vetoBasis: null });
  assert.deepStrictEqual(P.cycleClass({ result: R.missed }), { passClass: 'missed_fill', vetoBasis: null });
  assert.deepStrictEqual(P.cycleClass({ result: R.vetoed }), { passClass: 'vetoed', vetoBasis: 'lesson' });
  assert.deepStrictEqual(P.cycleClass({ result: R.vetoedHard }), { passClass: 'vetoed', vetoBasis: 'hard-step' });
  assert.deepStrictEqual(P.cycleClass({ result: R.misread }), { passClass: 'vetoed', vetoBasis: 'misread' }, 'an approval the reading refused: never the model\'s veto');
  assert.deepStrictEqual(P.cycleClass({ entry: { outcome: 'vetoed', vetoBasis: 'hard-step' }, result: R.vetoed }), { passClass: 'vetoed', vetoBasis: 'hard-step' }, 'the record\'s basis first');
  assert.deepStrictEqual(P.cycleClass({}), { passClass: null, vetoBasis: null }, 'a cycle before the record: unknown');
});

test('wiring: the cycle log line and the replay store keep the entry\'s outcome, its late-entry kind and a veto\'s basis', () => {
  const fs = require('fs');
  const path = require('path');
  const { writeCycleLog } = require('../../scripts/lib/cycle-log');
  const store = require('../../scripts/lib/replay/store');
  const { tmpDir } = require('../helpers');
  const home = tmpDir();
  const at = new Date('2026-10-07T14:00:02Z');
  writeCycleLog(home, { at, action: 'trade', harness: 'x', prompt: 'p', result: R.missed, ok: true, entry: { outcome: 'late', ran: [], late: { kind: 'missed-entry', price: 1 }, why: 'missed' } });
  writeCycleLog(home, { at: new Date(at.getTime() + 180000), action: 'trade', harness: 'x', prompt: 'p', result: R.vetoed, ok: true, entry: { outcome: 'vetoed', ran: [], vetoBasis: 'lesson', why: 'x' } });
  writeCycleLog(home, { at: new Date(at.getTime() + 360000), action: 'trade', harness: 'x', prompt: 'p', result: R.executed, ok: true });
  const file = fs.readdirSync(path.join(home, 'logs')).find(f => /^cycles-.*\.jsonl$/.test(f));
  const lines = fs.readFileSync(path.join(home, 'logs', file), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines.map(l => l.entry && [l.entry.outcome, l.entry.late, l.entry.vetoBasis]), [['late', 'missed-entry', undefined], ['vetoed', undefined, 'lesson'], undefined]);
  const kept = lines.map(store.cycleSummary);
  assert.deepStrictEqual(kept.map(c => c.entry), [{ outcome: 'late', late: 'missed-entry' }, { outcome: 'vetoed', vetoBasis: 'lesson' }, undefined]);
  assert.deepStrictEqual(kept.map(P.cycleClass), [{ passClass: 'missed_fill', vetoBasis: null }, { passClass: 'vetoed', vetoBasis: 'lesson' }, { passClass: 'unfilled', vetoBasis: null }]);
});

test('ownPass: the model\'s own pass is declined, or a line from before the class (no passClass) as it was', () => {
  assert.strictEqual(P.ownPass({ decision: 'passed', passClass: 'declined' }), true);
  assert.strictEqual(P.ownPass({ decision: 'passed' }), true, 'an old line keeps its meaning');
  for (const c of ['missed_fill', 'invalidated', 'unfilled', 'vetoed', 'blocked', 'runner_skip']) assert.strictEqual(P.ownPass({ decision: 'passed', passClass: c }), false, c);
  assert.strictEqual(P.ownPass({ decision: 'entered' }), false);
  assert.deepStrictEqual(P.CLASSES, ['declined', 'missed_fill', 'invalidated', 'unfilled', 'vetoed', 'blocked', 'runner_skip']);
});
