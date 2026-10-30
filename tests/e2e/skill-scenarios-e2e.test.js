'use strict';

/**
 * Every skill of the trade-lifecycle crosswalk (skills/trade-lifecycle/SKILL.md, its step table), each on real fixture
 * bars (the parity NQ series, tests/fixtures/decision-path.js), through the decision-path world: the live runner at a
 * replayed time, the scripted model (tests/fixtures/scripted-model.js) calling the real compose_check, and its orders
 * through the real order gateway to the mock exchange. For each skill, on a bar where its read is true:
 *
 *   true     the skill's read is TRUE in the bar briefing the runner wrote and agrees with the side (the checker's own
 *            check), it is that skill's by the crosswalk (curated-moments.js skillOfRead), and the whole combination
 *            holding it passes compose_check (an ok record);
 *   trade    the trade goes end to end: the gate allows the limit entry, it fills at the reference, and the broker's
 *            stop and target legs sit at the stop level one tick beyond (D3) and at the target level, with the size;
 *   false    a FALSE read of the same form at the same bar (one word changed) is refused by the checker (FALSE, not
 *            ok) and by the gate ([composed-reads], naming the read); nothing reaches the broker.
 *
 * The size and management steps have no read: position-sizing's true read is a size within the record's cap and its
 * false one a size over it ([max-risk]); manage-position's is a stop tightened on the filled trade and its false one a
 * stop loosened ([modify-protection]). A skill with no true instance on these bars is a test.todo with the reason
 * (TODO); the guard at the end fails when a crosswalk skill has neither, so a new skill can't slip through untested.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const D = require('../fixtures/decision-path');
const TL = require('../../scripts/lib/trading/trade-lifecycle');
const { readBriefing } = require('../../scripts/lib/trading/briefing');
const { checkReads, parseRead } = require('../../scripts/lib/trading/composed-reads');
const { TICK, asReads, expectedPlan, composedCycle } = require('../fixtures/composed-cycle');
const { skillOfRead, shapeOf, READ_SKILL, SHAPE_SKILL } = require('../../scripts/lib/learning/curated-moments');
const { NO_READ_SKILLS } = require('../../scripts/lib/learning/skill-usage');

const BLOCKED = 'CYCLE RESULT: blocked - the order gate refused the entry';

// The combinations, from the bars (each read TRUE at its bar, checked by the checker): A on the 14:00 UTC bar of
// 2026-04-23 (long: the 4h candle broke the 15m gap's high, the 3m bar closed at its top), the others where the skill's
// own read is true. `read` is the skill's read in the combination; `false` the same form, one word changed, FALSE there.
const A_BAR = '2026-04-23T14:00:00.000Z';
const A = [
  ['bias', 'multi-timeframe-analysis', '15m up'], ['location', 'levels-and-reactions', 'at vwap rth'],
  ['setup', 'fair-value-gaps', '4h broke 15m fvg high up'], ['entry', 'candle-reading', '3m close top'],
  ['stop', 'invalidation', 'stop 3m low 26970'], ['target', 'take-profit', 'target day high 27102.75'],
];
/** A's reads with the read at `step` (its first) swapped for [skill, read]. */
const onA = (step, skill, read) => A.map((x, i) => (i === A.findIndex(y => y[0] === step) ? [step, skill, read] : x));
const SCENARIOS = [
  { skill: 'multi-timeframe-analysis', bar: A_BAR, side: 'long', reads: A, read: '15m up', false: '15m down' },
  { skill: 'bos-vs-choch', bar: A_BAR, side: 'long', reads: onA('bias', 'bos-vs-choch', '3m choch up'), read: '3m choch up', false: '3m bos up' },
  { skill: 'trend-vs-range', bar: A_BAR, side: 'long', reads: onA('bias', 'trend-vs-range', 'regime transition'), read: 'regime transition', false: 'regime range' },
  { skill: 'levels-and-reactions', bar: A_BAR, side: 'long', reads: A, read: 'at vwap rth', false: 'at day high' },
  { skill: 'vwap-volume-profile', bar: A_BAR, side: 'long', reads: onA('location', 'vwap-volume-profile', 'vwap below'), read: 'vwap below', false: 'vwap above' },
  { skill: 'fair-value-gaps', bar: A_BAR, side: 'long', reads: onA('setup', 'fair-value-gaps', '4h rejected 15m fvg low up'), read: '4h rejected 15m fvg low up', false: '4h broke 15m fvg low down' },
  { skill: 'candle-reading', bar: A_BAR, side: 'long', reads: A, read: '3m close top', false: '3m close bottom' },
  { skill: 'momentum-and-volume', bar: A_BAR, side: 'long', reads: onA('entry', 'momentum-and-volume', '3m momentum up'), read: '3m momentum up', false: '3m momentum down' },
  { skill: 'invalidation', bar: A_BAR, side: 'long', reads: A, read: 'stop 3m low 26970', false: 'stop 3m low 26960' },
  { skill: 'take-profit', bar: A_BAR, side: 'long', reads: A, read: 'target day high 27102.75', false: 'target day high 27110' },
  {
    skill: 'rejection', bar: '2026-04-23T16:24:00.000Z', side: 'long', read: '15m rejected opening range high up', false: '15m broke opening range high up',
    reads: [A[0], ['location', 'levels-and-reactions', 'at ib high'], ['setup', 'rejection', '15m rejected opening range high up'], A[3], ['stop', 'invalidation', 'stop 3m low 27076'], ['target', 'take-profit', 'target day high 27155.75']],
  },
  {
    skill: 'breakout', bar: '2026-04-23T15:54:00.000Z', side: 'long', read: '1h broke vwap rth up', false: '1h rejected vwap rth up',
    reads: [A[0], ['location', 'levels-and-reactions', 'at opening range high'], ['setup', 'breakout', '1h broke vwap rth up'], A[3], ['stop', 'invalidation', 'stop opening range high 27068'], ['target', 'take-profit', 'target day high 27155.75']],
  },
  {
    skill: 'cisd', bar: '2026-04-23T15:54:00.000Z', side: 'long', read: '15m cisd up', false: '15m cisd down',
    reads: [A[0], ['location', 'levels-and-reactions', 'at opening range high'], ['setup', 'cisd', '15m cisd up'], A[3], ['stop', 'invalidation', 'stop opening range high 27068'], ['target', 'take-profit', 'target day high 27155.75']],
  },
  {
    skill: 'absorption', bar: '2026-04-23T15:57:00.000Z', side: 'long', read: '1h absorption at opening range high up', false: '3m absorption at opening range high up',
    reads: [A[0], ['location', 'levels-and-reactions', 'at ib high'], A[2], ['entry', 'absorption', '1h absorption at opening range high up'], ['stop', 'invalidation', 'stop 3m low 27078.75'], ['target', 'take-profit', 'target day high 27155.75']],
  },
  {
    skill: 'daily-bias', bar: '2026-04-23T22:06:00.000Z', side: 'short', read: 'inside prior rth range', false: 'above prior rth range',
    reads: [['bias', 'daily-bias', 'inside prior rth range'], ['location', 'levels-and-reactions', 'at session high'], ['setup', 'candle-reading', '15m pattern bearish engulfing'], ['entry', 'candle-reading', '3m close bottom'], ['stop', 'invalidation', 'stop 3m high 27042'], ['target', 'take-profit', 'target prior rth close 26926.25']],
  },
  {
    // A 3m expansion candle closed 08:39 UTC above an inside-bar box (its mother's range, on the prior POC), the 1h trend
    // up; the 08:39 bar's close (top third) is the confirmation on a later candle; the stop beyond the box's low.
    skill: 'compression', bar: '2026-04-27T08:39:00.000Z', side: 'long', read: '3m compression break up', false: '3m compression break down',
    reads: [['bias', 'multi-timeframe-analysis', '1h up'], ['location', 'vwap-volume-profile', 'vwap below'], ['setup', 'compression', '3m compression break up'], A[3], ['stop', 'invalidation', 'stop 3m box low 27413'], ['target', 'take-profit', 'target prior rth high 27462.5']],
  },
  {
    // The reversal shape: a true 1h CHoCH the side's way (the trend breaking, not a pullback in it).
    skill: 'pullback-vs-reversal', bar: '2026-04-23T18:06:00.000Z', side: 'short', read: '1h choch down', false: '1h choch up',
    reads: [['bias', 'pullback-vs-reversal', '1h choch down'], ['location', 'levels-and-reactions', 'at previous 4h low'], ['setup', 'breakout', '1h broke opening range high down'], ['entry', 'candle-reading', '3m close bottom'], ['stop', 'invalidation', 'stop 3m high 26939'], ['target', 'take-profit', 'target day low 26681.75']],
  },
];
// The crosswalk's skills with no scenario on these bars, and why (a reason a reader can check).
const TODO = {
  'breakout-vs-fakeout': 'its scenario swept the equal highs of the 3m swings, the entry frame\'s, which are no level any more (the owner: never the entry timeframe as a level); no sweep of a 15m-or-higher or session level the long\'s way on these bars',
  'prop-challenge-pacing': 'sizes against a live prop attempt (its budget, the verdict, prop-state.js); the decision-path world runs no attempt (no account, no prop_portfolio policy), so no fixture bar has a true instance of its size read',
  'prop-pacing-judgment': 'the same: its read is the attempt\'s pacing (the days left, the target, the drawdown room), which only a prop attempt holds; the decision-path world runs none',
};
// Part of a covered skill with no true instance here: the pullback shape (the side's trend, the side's multi-timeframe
// read `pullback` and a rejection its way) never holds on these bars: m15.alignment is never `pullback` on an entry bar.
const PARTIAL_TODO = ['pullback-vs-reversal, the pullback shape: no bar of the parity series reads `pullback` (m15.alignment) on an entry bar, so only the reversal shape has a scenario'];

const swap = (list, from, to) => list.map(([step, skill, read]) => [step, skill, read === from ? to : read]);
/** The gate's last place_order decision: { decision, checks, messages }. */
function lastEntry(w) {
  const e = D.gateLog(w).filter(x => /place_order/.test(String(x.tool || ''))).at(-1);
  return e ? { decision: e.decision, checks: (e.violations || []).map(v => v.check), messages: (e.violations || []).map(v => v.message).join('\n') } : null;
}

/** The trade at the broker: filled at the reference, its stop and target legs where the plan puts them, its size. */
function assertTrade(w, s, plan, size) {
  assert.deepStrictEqual(lastEntry(w), { decision: 'allowed', checks: [], messages: '' });
  const rec = TL.readRecords(w.home, 'MNQ').at(-1);
  assert.deepStrictEqual([rec.ok, rec.bar, rec.side], [true, s.bar, s.side], JSON.stringify(rec.problems));
  assert.deepStrictEqual([rec.plan.entry.price, rec.plan.stop.price, rec.plan.stop.ticks, rec.plan.target.price, rec.plan.target.ticks, rec.plan.size],
    [plan.ref, plan.stop, plan.stopTicks, plan.target, plan.targetTicks, size], 'the record\'s plan is the reads\' levels');
  const pos = D.position(w);
  assert.deepStrictEqual([pos.type, pos.size, pos.averagePrice], [s.side === 'long' ? 1 : 2, size, plan.ref]);
  const legs = D.working(w);
  assert.strictEqual(legs.find(o => o.type === 4).stopPrice, plan.stop, 'the stop leg one tick beyond the stop level');
  assert.strictEqual(legs.find(o => o.type === 1 && o.parentId).limitPrice, plan.target, 'the target leg at the target level');
  assert.ok(legs.every(o => o.size === size));
}

for (const s of SCENARIOS) {
  test(`skill scenario, ${s.skill}: "${s.read}" is TRUE at ${s.bar} (${s.side}) and passes compose_check; the trade goes end to end with its stop, target and size`, async () => {
    const w = D.world();
    const r = await D.pass(w, D.decisionAt(s.bar), composedCycle(w, s));
    const b = readBriefing(w.home, 'MNQ');
    assert.strictEqual(b.asOf, s.bar);
    // TRUE in the briefing the runner wrote and agreeing with the side, the skill's by the crosswalk (the shape skill:
    // the reads show its shape).
    const checked = checkReads({ reads: asReads(s.reads), side: s.side, briefing: b, tick: TICK });
    assert.ok(checked.ok, checked.problems.join('; '));
    const own = checked.reads.find(x => x.read === s.read);
    assert.deepStrictEqual([own.check, own.agrees], [true, true], own.fact);
    if (s.skill === SHAPE_SKILL) assert.strictEqual(shapeOf(checked.reads, s.side), 'reversal');
    else assert.strictEqual(skillOfRead(own.step, s.read), s.skill);
    assert.match(r.ctx.results.compose_check, new RegExp(`^compose_check MNQ ${s.side}[\\s\\S]*\\nOK: every read verified`));
    assertTrade(w, s, expectedPlan(s.reads, s.side, b.sections.m3.data.price), 1);
    assert.strictEqual(r.state.history.at(-1).action, D.RESULT_ACTION.executed);
  });

  test(`skill scenario, ${s.skill}: the FALSE "${s.false}" at ${s.bar} is refused by the checker and by the gate ([composed-reads]); nothing reaches the broker`, async () => {
    const w = D.world();
    const reads = swap(s.reads, s.read, s.false);
    const r = await D.pass(w, D.decisionAt(s.bar), composedCycle(w, s, { reads, result: BLOCKED }));
    const checked = checkReads({ reads: asReads(reads), side: s.side, briefing: readBriefing(w.home, 'MNQ'), tick: TICK });
    assert.strictEqual(checked.ok, false);
    assert.strictEqual(checked.reads.find(x => x.read === s.false).check, false, 'FALSE, not unverifiable');
    assert.match(r.ctx.results.compose_check, /\nNOT OK: no entry on this record/);
    const e = lastEntry(w);
    assert.strictEqual(e.decision, 'blocked');
    assert.ok(e.checks.includes('composed-reads'), e.messages);
    assert.ok(e.messages.includes(`"${s.false}"`), e.messages);
    assert.deepStrictEqual(D.placedAtBroker(w), []);
    assert.strictEqual(D.position(w), null);
  });
}

// The size step: position-sizing's read is the size the record's cap allows (risk.max_risk_usd over the stop).
const SIZED = SCENARIOS[0];
test('skill scenario, position-sizing: the most the cap allows (4 x 148 ticks x $0.50 = $296) passes compose_check and fills 4; one more ($370) is refused by the checker and by the gate ([max-risk])', async () => {
  let w = D.world();
  await D.pass(w, D.decisionAt(SIZED.bar), composedCycle(w, SIZED, { size: 4 }));
  const b = readBriefing(w.home, 'MNQ');
  const plan = expectedPlan(SIZED.reads, SIZED.side, b.sections.m3.data.price);
  assert.deepStrictEqual([plan.stopTicks, Math.floor(300 / (plan.stopTicks * 0.5))], [148, 4]);
  assert.strictEqual(TL.readRecords(w.home, 'MNQ').at(-1).plan.maxSize, 4);
  assertTrade(w, SIZED, plan, 4);
  w = D.world();
  const r = await D.pass(w, D.decisionAt(SIZED.bar), composedCycle(w, SIZED, { size: 5, result: BLOCKED }));
  assert.match(r.ctx.results.compose_check, /size 5 risks \$370, over the strategy's risk\.max_risk_usd \$300 \(at most 4 at this stop\)/);
  const e = lastEntry(w);
  assert.ok(e.decision === 'blocked' && e.checks.includes('composed-reads') && e.checks.includes('max-risk'), JSON.stringify(e));
  assert.deepStrictEqual(D.placedAtBroker(w), []);
});

// The management step: manage-position's read is the stop tightened toward price on the filled trade; loosened, refused.
test('skill scenario, manage-position: on the filled composed long, the stop tightened goes and the exit goes; the stop loosened is refused ([modify-protection])', async () => {
  const w = D.world();
  await D.pass(w, D.decisionAt(SIZED.bar), composedCycle(w, SIZED));
  const stop = D.working(w).find(o => o.type === 4);
  assert.strictEqual(stop.stopPrice, expectedPlan(SIZED.reads, 'long', D.m3Of(w).price).stop);
  const next = new Date(Date.parse(SIZED.bar) + D.STEP).toISOString();
  const r = await D.pass(w, D.decisionAt(next), [
    { executor: [
      { broker: 'modify_order', args: { accountId: 7, orderId: stop.id, stopPrice: stop.stopPrice + 1 } },
      { broker: 'modify_order', args: { accountId: 7, orderId: stop.id, stopPrice: stop.stopPrice - 5 } },
      { broker: 'place_order', args: { accountId: 7, contractId: 'MNQ', side: 'sell', type: 'market', size: 1, rationale: '[exit] the composed long out' } },
    ] },
    { result: 'CYCLE RESULT: managed - stop tightened, then out' },
  ]);
  assert.deepStrictEqual(r.ctx.calls.map(c => [c.tool, c.ok]), [['modify_order', true], ['modify_order', false], ['place_order', true]]);
  assert.match(r.ctx.calls[1].text, /\[modify-protection\]/);
  assert.strictEqual(D.position(w), null, 'flat');
});

for (const [skill, why] of Object.entries(TODO)) test.todo(`skill scenario, ${skill}: ${why}`);
for (const t of PARTIAL_TODO) test.todo(`skill scenario, ${t}`);

/** The crosswalk's skills by step (skills/trade-lifecycle/SKILL.md, its step table: the backticked names, third column). */
function crosswalk() {
  const text = fs.readFileSync(path.join(D.ROOT, 'skills', 'trade-lifecycle', 'SKILL.md'), 'utf8');
  const rows = text.split('\n').filter(l => /^\s*\| [a-z]+ \|/.test(l) && !/\| Step \|/.test(l));
  return Object.fromEntries(rows.map(l => {
    const cells = l.split('|').map(c => c.trim());
    return [cells[1], [...cells[3].matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1])];
  }));
}

// The scenarios' own skills, the size and management ones, and the todos.
const COVERED = new Set([...SCENARIOS.map(s => s.skill), 'position-sizing', 'manage-position']);
/** The crosswalk's skills with neither a scenario nor a todo (the guard: none). */
const uncovered = steps => [...new Set(Object.values(steps).flat())].filter(s => !COVERED.has(s) && !TODO[s]).sort();

test('skill scenarios: every skill the trade-lifecycle crosswalk names has a scenario on real bars or a todo with its reason; none names a skill the crosswalk doesn\'t', () => {
  const steps = crosswalk();
  assert.deepStrictEqual(Object.keys(steps), ['bias', 'location', 'setup', 'entry', 'stop', 'target', 'size', 'management']);
  const all = [...new Set(Object.values(steps).flat())].sort();
  const missing = uncovered(steps);
  assert.deepStrictEqual(missing, [], `crosswalk skills with no scenario and no todo: ${missing.join(', ')}`);
  for (const s of [...COVERED, ...Object.keys(TODO)]) assert.ok(all.includes(s), `${s} is not in the crosswalk`);
  for (const [s, why] of Object.entries(TODO)) assert.ok(!COVERED.has(s) && why.length > 40, `${s}: a todo states why`);
  // The read skills (curated-moments.js READ_SKILL, the report's table) are each in their step's row; the no-read
  // skills are the size and management rows; the shape skill a setup skill.
  for (const [step, kinds] of Object.entries(READ_SKILL)) for (const skill of Object.values(kinds)) assert.ok(steps[step].includes(skill), `${skill} (${step})`);
  assert.deepStrictEqual(NO_READ_SKILLS, { size: steps.size, management: steps.management });
  assert.ok(steps.setup.includes(SHAPE_SKILL));
  // Every read skill has a scenario whose read is that skill's (the scenario tests it, not a neighbour).
  for (const s of SCENARIOS) {
    const row = s.reads.find(r => r[2] === s.read);
    assert.ok(row && row[1] === s.skill, `${s.skill}: its read "${s.read}" is stated under its own skill`);
    if (s.skill !== SHAPE_SKILL) assert.strictEqual(skillOfRead(row[0], s.read), s.skill, `${s.skill}: "${s.read}" is its read by the crosswalk`);
    assert.notStrictEqual(s.read, s.false);
    assert.strictEqual(parseRead(s.read).kind, parseRead(s.false).kind, `${s.skill}: the false read is the same form`);
  }
});

// The guard's own check: a crosswalk with one more skill fails it.
test('skill scenarios: the guard fails on a crosswalk skill with no scenario', () => {
  const steps = crosswalk();
  assert.deepStrictEqual(uncovered({ ...steps, entry: [...steps.entry, 'order-blocks'] }), ['order-blocks']);
  assert.deepStrictEqual(uncovered({ ...steps, setup: steps.setup.filter(s => s !== 'cisd'), size: [...steps.size, 'cisd'] }), []);
});
