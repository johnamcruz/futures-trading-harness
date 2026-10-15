'use strict';

// The correctness labeller (scripts/lib/learning/decision-label.js): by process, never by outcome. A losing trade the
// process made is correct; a winning trade against it is incorrect; everything else is incorrect or unverifiable,
// each with its reason.

const test = require('node:test');
const assert = require('node:assert');
const L = require('../../scripts/lib/learning/decision-label');

const RULES = { minRR: 2, maxRiskUsd: 300 };
const READS = [{ step: 'bias', check: true }, { step: 'setup', check: true, skill: 'fair-value-gaps' }, { step: 'entry', check: 'true' }];
// A long on MNQ: 10 points of risk (40 ticks x $0.50 x 5 = $100), 25 points to target (2.5R).
const RECORD = { ok: true, side: 'long', reads: READS, entry: 21000, stop: 20990, target: 21025, size: 5 };
const take = (over = {}) => ({
  kind: 'take', action: 'long', scorecard: { category: 'right', agrees: true }, gate: { refused: false, checks: [] },
  record: RECORD, attempts: 1, riskUsd: 100, account: null, ...over,
});

test('a take made by the process is correct; a LOSING one is still correct (the outcome is never read)', () => {
  const won = L.labelDecision(take({ outcome: { R: 2.5 }, grade: 'win' }), RULES);
  const lost = L.labelDecision(take({ outcome: { R: -1 }, grade: 'loss', R: -1, trade: { r: -1 } }), RULES);
  assert.strictEqual(lost.label, 'correct', lost.reasons.join('; '));
  assert.deepStrictEqual(lost, won, 'the label never depends on the outcome');
  assert.match(lost.reasons[0], /R:R 2\.50, risk \$100/);
});

test('a WINNING take against the process is incorrect, with its reason', () => {
  const falseRead = L.labelDecision(take({ record: { ...RECORD, reads: [...READS, { step: 'target', check: false }] }, outcome: { R: 3 }, grade: 'win' }), RULES);
  assert.strictEqual(falseRead.label, 'incorrect');
  assert.match(falseRead.reasons.join(), /1 claimed read\(s\) false/);
  const cases = [
    [{ scorecard: { category: 'bad size', agrees: false } }, /grades it bad size/],
    [{ gate: { refused: true, checks: ['max-risk'] } }, /refused by the gate or a risk rule: max-risk/],
    [{ record: { ...RECORD, target: 21015, rr: undefined } }, /R:R 1\.50 under 2/],
    [{ record: { ...RECORD, rr: 1.9 } }, /R:R 1\.90 under 2/],
    [{ riskUsd: 300.5 }, /risk \$300\.5 over the cap \$300/],
    [{ account: { standDown: true, why: 'the soft daily stop is reached' } }, /calls for standing down \(the soft daily stop/],
    [{ scorecard: { category: 'wrong stated reason', agrees: true } }, /wrong stated reason/],
  ];
  for (const [over, why] of cases) {
    const l = L.labelDecision(take({ ...over, outcome: { R: 4 }, grade: 'win' }), RULES);
    assert.strictEqual(l.label, 'incorrect', JSON.stringify(over));
    assert.match(l.reasons.join('; '), why);
  }
  // Exactly at the floor and the cap: correct.
  assert.strictEqual(L.labelDecision(take({ record: { ...RECORD, target: 21020 }, riskUsd: 300 }), RULES).label, 'correct');
});

test('a take nothing verifies is unverifiable, never correct', () => {
  const cases = [
    [{ scorecard: null }, /not scored/],
    [{ scorecard: { category: 'unchecked', agrees: null } }, /could not grade/],
    [{ record: null }, /no claimed reads/],
    [{ record: { ...RECORD, reads: [{ step: 'bias', check: 'unchecked' }] } }, /not verified/],
    [{ record: { ...RECORD, entry: null, rr: null } }, /R:R is unknown/],
    [{ riskUsd: null }, /risk in dollars is unknown/],
  ];
  for (const [over, why] of cases) {
    const l = L.labelDecision(take(over), RULES);
    assert.strictEqual(l.label, 'unverifiable', JSON.stringify(over));
    assert.match(l.reasons.join('; '), why);
  }
  // A broken rule outranks what is unknown.
  assert.strictEqual(L.labelDecision(take({ scorecard: null, riskUsd: 900 }), RULES).label, 'incorrect');
});

const pass = (over = {}) => ({ kind: 'pass', action: 'none', scorecard: { category: 'right', agrees: true }, expected: { decision: 'no-trade', decidedBy: 'no setup' }, gate: { refused: false }, record: null, attempts: 0, account: null, ...over });

test('a pass is correct when no valid setup existed or the rules or account call for standing down', () => {
  const noValid = L.labelDecision(pass({ attempts: 2, record: { ok: false, reads: [{ check: false }] } }), RULES);
  assert.strictEqual(noValid.label, 'correct');
  assert.match(noValid.reasons[0], /compose_check refused every plan the cycle tried \(2\)/);
  // ...its refused record's false reads are the checker's refusal, not the pass's claim.
  assert.strictEqual(L.labelDecision(pass({ expected: { decision: 'no-trade', decidedBy: 1 } }), RULES).label, 'correct', 'a hard stop');
  assert.strictEqual(L.labelDecision(pass({ expected: { decision: 'no-trade', decidedBy: 3 } }), RULES).label, 'correct', 'the room step');
  const stand = L.labelDecision(pass({ record: RECORD, attempts: 1, account: { standDown: true, why: 'the risk $100 reaches the max loss limit (cushion $80)' } }), RULES);
  assert.strictEqual(stand.label, 'correct');
  assert.match(stand.reasons[0], /cushion \$80/);
  // A pass on a valid setup with nothing calling for standing down is the model's judgment: never trained on.
  assert.strictEqual(L.labelDecision(pass({ record: RECORD, attempts: 1, account: { standDown: false, why: 'room' } }), RULES).label, 'unverifiable');
  assert.strictEqual(L.labelDecision(pass(), RULES).label, 'unverifiable', 'nothing composed: no setup known either way');
  // A missed winner is never incorrect for its outcome, nor a dodged loser correct for it.
  assert.strictEqual(L.labelDecision(pass({ record: RECORD, attempts: 1, counterfactual: { R: 3 }, grade: 'missed-win' }), RULES).label, 'unverifiable');
});

test('a pass with a false reason or a false read, or flagged by the scorecard, is incorrect', () => {
  assert.strictEqual(L.labelDecision(pass({ scorecard: { category: 'wrong stated reason', agrees: true }, attempts: 2 }), RULES).label, 'incorrect');
  assert.strictEqual(L.labelDecision(pass({ scorecard: { category: 'excessive abstention', agrees: false } }), RULES).label, 'incorrect');
  const r = L.labelDecision(pass({ record: { ok: true, reads: [{ check: 'false' }] }, attempts: 1 }), RULES);
  assert.strictEqual(r.label, 'incorrect');
  assert.match(r.reasons[0], /false read/);
});

test('a risk action is correct when it fits the rules for the account state', () => {
  const risk = (over = {}) => ({ kind: 'risk', action: 'exit', scorecard: { category: 'unchecked', agrees: null }, account: null, ...over });
  assert.strictEqual(L.labelDecision(risk({ account: { exitRequired: true, why: 'no daily room left ($0)' } }), RULES).label, 'correct');
  assert.strictEqual(L.labelDecision(risk(), RULES).label, 'unverifiable', 'an exit the rules don\'t call for is management');
  assert.strictEqual(L.labelDecision(risk({ scorecard: { category: 'early close', agrees: false } }), RULES).label, 'incorrect');
  assert.strictEqual(L.labelDecision(risk({ action: 'hold', scorecard: { category: 'right', agrees: true } }), RULES).label, 'correct');
  assert.strictEqual(L.labelDecision(risk({ action: 'hold', scorecard: { category: 'right' }, account: { exitRequired: true, why: 'x' } }), RULES).label, 'incorrect');
  assert.strictEqual(L.labelDecision(risk({ action: 'hold', scorecard: null }), RULES).label, 'unverifiable');
  assert.strictEqual(L.labelDecision({ kind: 'what' }, RULES).label, 'unverifiable');
  // The runner's own trail or time-stop exit is the policy's (prop/model-stream.js runnerExit): never the model's decision.
  const runner = L.labelDecision(risk({ policyExit: 'runner-close', account: { exitRequired: true, why: 'x' } }), RULES);
  assert.strictEqual(runner.label, 'unverifiable');
  assert.match(runner.reasons[0], /the runner's own exit \(runner-close/);
  assert.throws(() => L.labelDecision(null, RULES), /a decision object/);
});

test('accountCall: what the account state calls for, from the attempt the cycle showed', () => {
  assert.deepStrictEqual(L.accountCall(null), { standDown: null, exitRequired: null, why: 'no account state' });
  const room = { status: 'active', cushion: 2500, dailyHeadroom: 600, softHeadroom: 400, entryBlock: null };
  assert.strictEqual(L.accountCall(room, 100).standDown, false);
  assert.strictEqual(L.accountCall(room, 100).exitRequired, false);
  assert.match(L.accountCall({ ...room, entryBlock: 'daily loss stop' }).why, /entry block: daily loss stop/);
  assert.strictEqual(L.accountCall({ ...room, softHeadroom: 0 }).standDown, true);
  assert.strictEqual(L.accountCall({ ...room, cushion: 250 }, 300).standDown, true, 'the trade would reach the max loss limit');
  assert.strictEqual(L.accountCall({ ...room, dailyHeadroom: 300 }, 300).standDown, true, 'the trade would reach the daily limit');
  assert.strictEqual(L.accountCall({ ...room, dailyHeadroom: 0 }).exitRequired, true);
  assert.strictEqual(L.accountCall({ status: 'active' }).standDown, null, 'no room figures: unknown');
});

test('rrOf: the plan\'s own R:R, else from its prices', () => {
  assert.strictEqual(L.rrOf({ rr: 2.2, entry: 1, stop: 0, target: 9 }), 2.2);
  assert.strictEqual(L.rrOf({ entry: 21000, stop: 20990, target: 21025 }), 2.5);
  assert.strictEqual(L.rrOf({ entry: 21000, stop: 21000, target: 21025 }), null);
  assert.strictEqual(L.rrOf(null), null);
});

test('the correct-read rule is the exit test\'s, per decision: correct only when every read is verified true', () => {
  const { exitTest } = require('../../scripts/lib/replay/stage');
  const sets = [[true, true], [true, 'true'], [true, false], [true, 'unchecked'], ['true'], [true, null]];
  // 20 copies of each, so the exit test's count is over its minimum sample.
  const decisions = sets.flatMap(checks => Array.from({ length: 20 }, () => ({ decision: 'entered', reads: checks.map(check => ({ check })) })));
  const line = exitTest({ decisions, adherence: null }).find(x => x.test === 'correct-reads');
  const theirs = Number(/^([\d.]+) of/.exec(line.detail)[1]);
  const ours = decisions.filter(d => L.labelDecision(take({ record: { ...RECORD, reads: d.reads } }), RULES).label === 'correct').length / decisions.length;
  assert.strictEqual(Math.round(ours * 100) / 100, theirs);
});
