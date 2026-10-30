'use strict';

// The owner's chain (2026-10-29, "Yes enforce 15min setup"): the 4h and 1h set the side, the setup is the 15m or
// higher the side's way, the 3m only times the entry (composed-reads.js checkReads, under an entry rule with
// bias_agree). compose_check and the gate's re-check read it from the same check.

const test = require('node:test');
const assert = require('node:assert');
const LC = require('../fixtures/lifecycle');
const { checkReads } = require('../../scripts/lib/trading/composed-reads');
const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
const { composedRefusal } = require('../../scripts/lib/trading/lifecycle-gate');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { tmpDir } = require('../helpers');
const path = require('path');

const OFF = { chain: '4h', bias_frames: 'off', bias_agree: 'off', regime_against: 'off', leg_turned: 'off' };
const AGREE = entryRuleOf({ ...OFF, bias_frames: ['4h', '1h'], bias_agree: 'on' });
const FRAMES_ONLY = entryRuleOf({ ...OFF, bias_frames: ['4h', '1h'] });
const BG = entryRuleOf({ ...OFF, bias_frames: ['4h', '1h'], bias_agree: 'neutral-15m-declared' });
const MSG = /^entry rule: the setup must be on the 15m or higher \(a 3m read only times the entry\)/;
const REL = dir => [{ name: 'prior VAH', price: 21530.13, rel: 'rejected', dir }];

/** Scenario 1 with the 3m, 5m and 1h candles also rejecting the prior VAH (`dir`, up unless said). */
function briefing({ dir = 'up' } = {}) {
  const b = LC.briefing();
  const c = b.sections.m3.data.candles;
  c['3m'].relations = REL(dir);
  c['5m'] = { t: '2026-10-07T13:50:00.000Z', closedAt: '2026-10-07T13:55:00.000Z', o: 21525, h: 21541, l: 21520, c: 21538, closeLocation: 'top', relations: REL(dir) };
  c['1h'] = { t: '2026-10-07T12:00:00.000Z', closedAt: '2026-10-07T13:00:00.000Z', o: 21500, h: 21545, l: 21490, c: 21535, closeLocation: 'top', relations: REL(dir) };
  return b;
}
const withSetup = read => LC.READS.map(x => (x.step === 'setup' ? { ...x, read } : x));
const problemsOf = (read, rule = AGREE, b = briefing(), side = 'long') => checkReads({ reads: withSetup(read), side, briefing: b, entryRule: rule }).problems;

test('the setup frame: a 3m or 5m setup alone is refused under the HTF agreement; 15m, 1h are taken; without bias_agree, unchanged', () => {
  // Each read TRUE and pointing the side on this briefing (the frame alone decides).
  for (const read of ['3m rejected prior vah up', '15m rejected prior vah up', '1h rejected prior vah up', '5m rejected prior vah up']) {
    const r = checkReads({ reads: withSetup(read), side: 'long', briefing: briefing() }).reads.find(x => x.step === 'setup');
    assert.deepStrictEqual([r.check, r.dir], [true, 'long'], read);
  }
  assert.ok(problemsOf('3m rejected prior vah up').some(p => MSG.test(p)), 'a 3m-only setup');
  assert.ok(problemsOf('5m rejected prior vah up').some(p => MSG.test(p)), 'a 5m setup: under the 15m');
  assert.ok(!problemsOf('15m rejected prior vah up').some(p => MSG.test(p)), 'a 15m setup');
  assert.deepStrictEqual(checkReads({ reads: withSetup('15m rejected prior vah up'), side: 'long', briefing: briefing(), entryRule: AGREE }).problems, [], 'scenario 1 stands whole');
  assert.ok(!problemsOf('1h rejected prior vah up').some(p => MSG.test(p)), 'a 1h setup');
  // One 15m setup read beside a 3m one: the setup is the 15m's.
  const both = [...withSetup('15m rejected prior vah up'), { step: 'setup', skill: 'rejection', read: '3m rejected prior vah up', why: 'x' }];
  assert.ok(!checkReads({ reads: both, side: 'long', briefing: briefing(), entryRule: AGREE }).problems.some(p => MSG.test(p)));
  // bias_agree neutral-15m-declared holds the same chain (topDown): a 3m setup refused, the 15m taken.
  assert.ok(problemsOf('3m rejected prior vah up', BG).some(p => MSG.test(p)), 'BG: a 3m-only setup');
  assert.ok(problemsOf('5m rejected prior vah up', BG).some(p => MSG.test(p)), 'BG: a 5m setup');
  assert.ok(!problemsOf('15m rejected prior vah up', BG).some(p => MSG.test(p)), 'BG: a 15m setup');
  // Only under bias_agree on or neutral-15m-declared: the frames alone (bias_agree off), or no rule, leave a 3m setup as before.
  assert.ok(!problemsOf('3m rejected prior vah up', FRAMES_ONLY).some(p => MSG.test(p)));
  assert.ok(!problemsOf('3m rejected prior vah up', null).some(p => MSG.test(p)));
});

test('the setup frame: a 15m setup against the side is no setup the side\'s way (refused); a 15m trend against the side is untouched', () => {
  const against = problemsOf('15m rejected prior vah down', AGREE, briefing({ dir: 'down' }));
  assert.ok(against.some(p => /the setup has no read pointing up \(long\)|AGAINST|against/i.test(p)), against.join('\n'));
  // The 15m frame's trend down (a pullback under the 4h and 1h up) with a 15m setup up: taken.
  const b = briefing();
  b.sections.m15.data.frame = { trend: 'down' };
  assert.ok(!problemsOf('15m rejected prior vah up', AGREE, b).some(p => MSG.test(p) || /entry rule/.test(p)));
});

test('the setup frame: a cited setup\'s fired read is the stated exemption', () => {
  const r = checkReads({ reads: LC.S2_READS, side: 'long', briefing: LC.s2Briefing(), entryRule: AGREE, cited: ['momentum_continuation'] });
  assert.deepStrictEqual(r.problems, [], 'momentum_continuation fired: its setup is the HTF trend and its momentum candle');
  assert.strictEqual(r.reads.find(x => x.step === 'setup').kind, 'fired');
});

test('the setup frame: the gate\'s re-check refuses what compose_check refuses (the same check on the record\'s reads)', () => {
  const DOC = loadStrategies(path.resolve(__dirname, '..', '..'), {}).strategies.find(s => s.name === 'trade_lifecycle');
  const judge = read => {
    const home = tmpDir();
    LC.writeScenario(home, { b: briefing(), reads: withSetup(read) });
    return composedRefusal({ name: 'trade_lifecycle', strategy: DOC, home, root: 'MNQ', input: LC.order(), now: new Date('2026-10-07T14:00:02Z'), cycleBars: { MNQ: LC.BAR }, entries: [], specOf: () => ({ tickSize: 0.25, tickValue: 0.5 }), entryRule: AGREE }).message;
  };
  assert.match(judge('3m rejected prior vah up') || '', /the setup must be on the 15m or higher \(a 3m read only times the entry\)/);
  assert.strictEqual(judge('15m rejected prior vah up'), null);
  assert.strictEqual(judge('1h rejected prior vah up'), null);
});
