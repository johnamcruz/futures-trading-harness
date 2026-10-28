'use strict';

// The facts at a missed trend leg's start (scripts/lib/train/trend-facts.js) and what the proposer reads of them
// (trend-findings.js, findings.js): built on the scenario-1 bar briefing (tests/fixtures/trade-lifecycle-scenario.js),
// as the compose-hints tests build theirs. A leg is a finding only when a valid with-trend plan existed at one of its
// entry-able bars; the proposer's text names reads, never a date, time or price; nothing reaches a run home.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { scenario1 } = require('../fixtures/trade-lifecycle-scenario');
const { stopRuleOf } = require('../../scripts/lib/trading/trade-lifecycle');
const X = require('../../scripts/lib/train/trend-facts');
const TF = require('../../scripts/lib/train/trend-findings');
const F = require('../../scripts/lib/train/findings');
const P = require('../../scripts/lib/train/proposer');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const PLAN = { size: 1, tickValue: 0.5, minRR: 2, maxRiskUsd: 300, stopRule: stopRuleOf({ stop_buffer_ticks: 1, stop_floor_ticks: 8, stop_floor_atr: 0.25 }), suggestion: false };
const BAR = '2026-04-23T14:57:00.000Z';
const CLOSE = '2026-04-23T15:00:00.000Z';
const brief = (edit = () => {}) => { const b = scenario1(); b.sections.m3.data.windowEntries = 'allowed'; edit(b); return b; };
const facts = (over = {}) => X.barFacts({ briefing: brief(), side: 'long', tick: 0.25, plan: PLAN, ...over });
const cyc = (code, by, extra = {}) => ({ bar: CLOSE, code, by, step: null, reads: [], message: 'why', ...extra });
const legOf = (cycles, over = {}) => ({ id: `d|long|${BAR}`, day: 'd', side: 'long', start: BAR, captured: false, availableR: 2, blocker: { step: null, code: 'no-plan', by: 'head' }, cycles, ...over });
const ctxOf = (b, over = {}) => ({ briefingAt: t => (t === BAR ? b : null), tick: 0.25, plan: PLAN, minutes: 3, ...over });

test('trend facts: scrub leaves no date, month, weekday, clock time, price, number, id or account name; keeps timeframes and R marks', () => {
  const t = X.scrub('no-trade - 3m rejected session POC 21530.13 at 09:35 ET (2026-04-23T14:57:00.000Z) R:R 1.33 under the min 2, 1.5R, target 2r, 15m and 1h, 0.75x volume, $142.50, record 440961915c28a35f, acct_100k floor');
  assert.strictEqual(t, 'no-trade - 3m rejected session POC at R:R under the min, target 2r, 15m and 1h, volume, record, the account floor');
  assert.doesNotMatch(t, /\d{2}:\d{2}|\d{4}-\d{2}|\d+\.\d+/);
  const w = X.scrub('Tuesday, May 4: two bars ago, ½ size, #F4, eval_plain floor; it may hold', { names: ['eval_plain'] });
  assert.doesNotMatch(w, /Tuesday|May|\btwo\b|½|#F4|eval_plain/i);
  assert.match(w, /the account floor; it hold$/, 'the account named goes (and "may", with the month)');
  // Months and weekdays in any case and abbreviated, ordinals whole, every number word; "15m-1h" kept whole.
  const m = X.scrub('the 15m-1h trend on tue, sept. 3, the 4th bar, one of fifteen, first touch, THURSDAY, mar 2, sixty points, zero room, 2r');
  assert.strictEqual(m, 'the 15m-1h trend on, the bar, of, touch,, points, room, 2r'.replace(',,', ','));
  assert.strictEqual(X.scrub('3m pattern double top', { words: false }), '3m pattern double top', 'a read\'s own name keeps its words');
  assert.strictEqual(X.clip('a b c, d e f; g h', 12), 'a b c...', 'clipped at a clause boundary');
});

test('trend facts: a bar with a valid with-trend plan (the standard plan); the verified reads per step, names only', () => {
  const f = facts();
  assert.deepStrictEqual([f.known, f.valid, f.via, f.why], [true, true, 'standard', 'the standard plan passes']);
  assert.ok(f.verified.setup.includes('15m rejected prior vah up'), f.verified.setup.join());
  assert.ok(f.verified.bias.includes('trend long allowed'));
  assert.deepStrictEqual(f.unknown, [], 'no frame missing: the scenario\'s briefing lacks no frame the run had');
  assert.ok(f.planReads.includes('15m rejected prior vah up') && Number.isInteger(f.stopTicks));
});

test('trend facts: no valid plan when the window allows no entries, or the trend rule allows the side only as a reversal', () => {
  const closed = facts({ briefing: brief(b => { b.sections.m3.data.windowEntries = 'none'; }) });
  assert.deepStrictEqual([closed.known, closed.valid, closed.why], [true, false, 'the window allows no entries']);
  const against = facts({ side: 'short' });
  assert.deepStrictEqual([against.known, against.valid, against.why], [true, false, 'the trend rule allows the short only as a reversal']);
  const rule = facts({ briefing: brief(b => { b.sections.m3.data.trendRule = ''; }) });
  assert.deepStrictEqual([rule.valid, rule.why], [false, 'the trend rule for the side is unknown']);
});

test('trend facts: with the policy\'s entry rule on, a bar it refuses has no valid plan (the finding counts only entries the gate allows)', () => {
  const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
  const off = { bias_frames: 'off', regime_against: 'off', leg_turned: 'off' };
  assert.strictEqual(facts({ entryRule: entryRuleOf(off) }).valid, true, 'every key off: as before');
  const down = brief(b => { b.sections.h1.data.h1.trend = 'down'; });
  assert.strictEqual(facts({ briefing: down }).valid, true, 'no rule: the same bar has a plan');
  const f = facts({ briefing: down, entryRule: entryRuleOf({ ...off, bias_frames: ['4h', '1h'] }) });
  assert.deepStrictEqual([f.known, f.valid], [true, false]);
  const regime = brief(b => { b.sections.m3.data.regime = { primary: 'trend-down', volatility: 'normal' }; });
  assert.strictEqual(facts({ briefing: regime, entryRule: entryRuleOf({ ...off, regime_against: 'on' }) }).valid, false);
});

test('trend facts: under a prop attempt a size must fit; unknown when it can\'t be worked out; the floor\'s refusal is no plan', () => {
  const asked = [];
  const none = facts({ sizeFits: t => { asked.push(t); return false; } });
  assert.deepStrictEqual([none.known, none.valid], [true, false]);
  assert.match(none.why, /no size fits/);
  assert.ok(asked.length >= 1 && asked.every(t => Number.isInteger(t) && t > 0), 'asked with each plan\'s stop ticks');
  const unknown = facts({ sizeFits: () => undefined });
  assert.deepStrictEqual([unknown.known, unknown.valid], [false, false]);
  assert.strictEqual(facts({ sizeFits: () => true }).valid, true);
  // The standard plan's stop fits no size: a combination of the verified reads with another stop that fits is tried.
  const std = facts().stopTicks;
  const other = facts({ sizeFits: t => t !== std });
  assert.ok(other.valid ? other.via === 'together' && other.stopTicks !== std : /no size fits/.test(other.why), JSON.stringify([other.via, other.why]));
  // The model's own OK record the leg's way counts (it passed compose_check); the floor's own refusal does not.
  const b = brief(x => { x.sections.m3.data.trendRule = ''; });
  assert.strictEqual(facts({ briefing: b, cycle: cyc('head-pass', 'head') }).valid, true);
  assert.strictEqual(facts({ briefing: b, cycle: cyc('veto', 'phase2') }).why, 'your own plan passed compose_check');
  assert.strictEqual(facts({ briefing: b, cycle: cyc('min-contracts', 'phase2') }).valid, false);
  assert.strictEqual(facts({ briefing: b, cycle: cyc('min-contracts', 'gate') }).valid, false);
  // A missing frame and no plan on the known reads: not known (its reads might have made one); the window and the
  // trend rule decide whatever the frames.
  const gap = facts({ missing: ['5m'], sizeFits: () => false });
  assert.deepStrictEqual([gap.known, gap.valid], [false, false]);
  assert.match(gap.why, /on the known reads \(5m unknown\)$/);
  assert.strictEqual(facts({ missing: ['5m'], side: 'short' }).known, true, 'the trend rule refuses the short whatever the 5m');
  assert.strictEqual(facts({ missing: ['5m'], briefing: brief(x => { x.sections.m3.data.windowEntries = 'none'; }) }).known, true);
  // The own OK record first: a bar whose briefing can't be rebuilt, or whose rebuild disagrees, still had its plan.
  const own = X.barFacts({ briefing: null, side: 'long', tick: 0.25, plan: PLAN, cycle: cyc('late-entry', 'gate') });
  assert.deepStrictEqual([own.known, own.valid, own.via], [true, true, 'own']);
  const off = facts({ cycle: cyc('unfilled', 'executor'), records: [{ side: 'long', reads: [{ step: 'setup', read: '15m rejected prior vah up', check: false }] }] });
  assert.deepStrictEqual([off.known, off.valid], [true, true]);
});

test('sizeForCycle: the entry\'s own size chain at the cycle\'s budget: the risk cap at the all-in risk, then the floor on the capped size', () => {
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  const { loadAccounts, feePerSide } = require('../../scripts/lib/trading/accounts');
  const { allInRisk } = require('../../scripts/lib/prop/size-translate');
  const strategies = loadStrategies(ROOT, {}).strategies;
  const accounts = loadAccounts(ROOT, {}).accounts;
  const policy = strategies.find(s => s.valid && s.signal === 'policy' && (s.strategies || []).includes('trade_lifecycle'));
  const account = accounts.find(a => a.name === policy.account);
  const cap = strategies.find(s => s.name === 'trade_lifecycle').risk.max_risk_usd;
  const rec = budgetUsd => ({ context: { attempts: [{ account: account.name, status: 'active', cushion: 5000, facts: { dailyRoom: 5000 }, budgets: [{ strategy: policy.name, budgetUsd }] }] } });
  const fits = X.sizeForCycle(rec(1500), { strategies, accounts, root: 'MNQ', composed: 'trade_lifecycle' });
  // A wide stop the budget alone sizes past the floor, but whose floor of contracts all in is over the risk cap: none.
  const wide = 371;
  const perContract = allInRisk({ stopTicks: wide, tickValue: 0.5, slipTicks: policy.sizing.stop_slippage_ticks, feePerSide: feePerSide(account, 'MNQ') });
  assert.ok(policy.sizing.min_contracts * perContract > cap && Math.floor(1500 / perContract) >= policy.sizing.min_contracts, 'the case: budget fits the floor, the cap does not');
  assert.strictEqual(fits(wide), false);
  assert.strictEqual(fits(40), true);
  assert.strictEqual(X.sizeForCycle(rec(5), { strategies, accounts, root: 'MNQ', composed: 'trade_lifecycle' })(40), false, 'a budget under the floor');
  assert.strictEqual(X.sizeForCycle({ context: { attempts: [] } }, { strategies, accounts, root: 'MNQ', composed: 'trade_lifecycle' })(40), null, 'no attempt: no constraint');
  assert.strictEqual(X.sizeForCycle({ context: { attempts: [{ account: account.name, status: 'active', budgets: [] }] } }, { strategies, accounts, root: 'MNQ', composed: 'trade_lifecycle' })(40), undefined, 'no budget recorded: unknown');
  assert.strictEqual(fits(0), undefined);
});

test('trend facts: unknown, never guessed: no briefing, a frame the rebuild lacks (and the at reads that lean on it), a recorded check the rebuild disagrees with', () => {
  const none = X.barFacts({ briefing: null, side: 'long', tick: 0.25, plan: PLAN, said: 'x' });
  assert.deepStrictEqual([none.known, none.valid, none.why], [false, false, 'no briefing for the bar']);
  assert.deepStrictEqual([X.missingFrames({ minutes: 3, fineBars: null }), X.missingFrames({ minutes: 3, fineBars: [{}] }), X.missingFrames({ minutes: 1, fineBars: null })], [['5m'], [], []]);
  const b = brief();
  assert.deepStrictEqual(['at prior vah', '5m momentum up', '15m up', 'stop 5m low 1', '15m rejected 5m fvg low up', '15m rejected prior vah up'].map(r => X.dependsOnMissing(r, b, ['5m'])), [true, true, false, true, true, false]);
  assert.strictEqual(X.dependsOnMissing('at prior vah', b, []), false);
  // The 5m missing: no `at` read (its check would fall back past the 5m to the 15m), so not the standard plan.
  const no5 = facts({ missing: ['5m'] });
  assert.deepStrictEqual(no5.unknown, ['5m']);
  assert.ok(Object.values(no5.verified).flat().every(r => !/^at /.test(r) && !/\b5m\b/.test(r)), JSON.stringify(no5.verified));
  assert.ok(!(no5.planReads || []).some(r => /^at /.test(r)), 'no plan on an at read the rebuild can\'t check');
  assert.notStrictEqual(no5.via, 'standard');
  const rec = (check, read = '15m rejected prior vah up') => [{ side: 'long', reads: [{ step: 'setup', skill: 'rejection', read, check }] }];
  assert.strictEqual(facts({ records: rec(true) }).known, true, 'the record and the rebuild agree');
  const off = facts({ records: rec(false) });
  assert.deepStrictEqual([off.known, off.valid, off.parity], [false, false, '15m rejected prior vah up']);
  assert.match(off.why, /checks the run's compose record differently/);
  assert.strictEqual(facts({ missing: ['5m'], records: rec(false, 'at prior vah') }).known, true, 'a read leaning on a missing frame is not compared');
});

test('trend facts: a leg is learnable at any bar with a valid plan; a correct pass when every bar is known and none; else unknown', () => {
  const b = brief();
  const yes = X.legFacts(legOf([cyc('no-plan', 'head')]), ctxOf(b));
  assert.deepStrictEqual([yes.learnable, yes.why, yes.bars.length], [true, 'the standard plan passes', 1]);
  const short = X.legFacts(legOf([cyc('no-plan', 'head')], { side: 'short' }), ctxOf(b));
  assert.deepStrictEqual([short.learnable, short.why], [false, 'no valid plan at the time (a correct pass)']);
  const unknown = X.legFacts(legOf([cyc('no-plan', 'head')]), ctxOf(b, { briefingAt: () => null }));
  assert.deepStrictEqual([unknown.learnable, unknown.why], [null, 'facts unknown at a bar']);
  // Rule-blocked, outside-session and position-open bars are no entry bars.
  const none = X.legFacts(legOf([cyc('opening-print', 'rule'), cyc('outside-session', 'rule'), cyc('position-open', 'head')]), ctxOf(b));
  assert.deepStrictEqual([none.learnable, none.why, none.bars.length], [null, 'no entry-able bar', 0]);
  // The stated reason: the cycle's own CYCLE RESULT line when the run recorded it, else the capture's message.
  const said = X.legFacts(legOf([cyc('no-plan', 'head')]), ctxOf(b, { cycleAt: bar => (bar === CLOSE ? { result: 'CYCLE RESULT: no-trade - no long setup' } : null) }));
  assert.strictEqual(said.bars[0].said, 'CYCLE RESULT: no-trade - no long setup');
});

test('trend facts: a leg\'s owner is the earliest step a read it composed the leg\'s way was unverified; none for a no-plan leg; a floor refusal is flow step stop\'s', () => {
  const b = brief();
  const at = (result, leg = legOf([cyc('no-plan', 'head')]), over = {}) => X.legFacts(leg, ctxOf(b, { cycleAt: () => ({ result }), ...over }));
  // A no-plan leg composed nothing: no owner, whatever it said (what it said is never parsed).
  assert.strictEqual(at('no-trade - the long has no rejection at a key level; the long is against the trend').owner, null);
  const leg = legOf([cyc('no-plan', 'head')]);
  leg.facts = at('no-trade - no long rejection at a key level');
  assert.deepStrictEqual([TF.ownerOf(leg), TF.stepOfLeg(leg)], [{}, null]);
  // A refused plan the leg's way: the earliest unverified read's step and its skill (the one named, else the crosswalk's).
  const read = (step, readText, verified, skill) => ({ step, read: readText, verified, ...(skill ? { skill } : {}) });
  const refused = legOf([cyc('entry:false', 'compose_check', { reads: [read('bias', '1h up', true, 'mtf-bias-filter'), read('entry', '3m close top', false, 'candle-reading'), read('setup', '15m rejected prior vah up', false)] })], { blocker: { step: 'entry', code: 'entry:false', by: 'compose_check' } });
  assert.deepStrictEqual(at('no-trade - refused', refused).owner, { step: 'setup', skill: 'rejection' });
  const noPlanWithReads = legOf([cyc('no-plan', 'head', { reads: [read('location', 'at prior vah', false, 'vwap-volume-profile')] })]);
  noPlanWithReads.facts = at('x', noPlanWithReads);
  assert.deepStrictEqual([TF.ownerOf(noPlanWithReads), TF.stepOfLeg(noPlanWithReads)], [{ skill: 'vwap-volume-profile' }, 'location']);
  assert.deepStrictEqual(TF.ownerOf(noPlanWithReads, { exists: () => false }), {}, 'a skill the tree lacks owns nothing');
  // The floor refused the model's stop: its stop choice, owned by its stop read's skill, never the risk manager.
  const floor = legOf([cyc('min-contracts', 'phase2')], { blocker: { step: 'risk', code: 'min-contracts', by: 'phase2' } });
  const rec = [{ side: 'long', ok: true, reads: [{ step: 'stop', skill: 'invalidation', read: 'stop 15m low 21512.75', check: true }] }];
  floor.facts = at('no-trade - veto: no size fits', floor, { recordsAt: () => rec });
  assert.deepStrictEqual(floor.facts.owner, { step: 'stop', skill: 'invalidation' });
  assert.deepStrictEqual([TF.ownerOf(floor), TF.stepOfLeg(floor)], [{ skill: 'invalidation' }, 'stop']);
  const gate = { ...floor, blocker: { step: 'execution', code: 'min-contracts', by: 'gate' } };
  assert.deepStrictEqual([TF.ownerOf(gate), TF.stepOfLeg(gate)], [{ skill: 'invalidation' }, 'stop']);
});

/** A capture of missed legs with their facts on the scenario's bar: learnable, a correct pass, unknown, and rules. */
function capture() {
  const b = brief();
  const said = 'CYCLE RESULT: no-trade - the long at 10:45 ET on 2026-04-23: no rejection at a key level, price 21540.25';
  const withFacts = l => ({ ...l, facts: X.legFacts(l, ctxOf(b, { cycleAt: () => ({ result: said }) })) });
  return { legs: [
    withFacts(legOf([cyc('no-plan', 'head')], { id: 'a', availableR: 3 })),
    withFacts(legOf([cyc('no-plan', 'head')], { id: 'b', availableR: 1 })),
    withFacts(legOf([cyc('no-plan', 'head')], { id: 'c', side: 'short', availableR: 5 })),
    { ...legOf([cyc('no-plan', 'head')], { id: 'd', availableR: 4 }), facts: { learnable: null, why: 'facts unknown at a bar', bars: [], owner: null } },
    legOf([cyc('no-plan', 'head')], { id: 'e', availableR: 4 }),
    legOf([cyc('news', 'rule')], { id: 'f', blocker: { step: null, code: 'news', by: 'rule' } }),
    { ...legOf([], { id: 'g' }), captured: true, blocker: null },
  ] };
}

test('trend findings: learnable legs only; the others counted as a correct pass or unknown, never findings', () => {
  const doc = capture();
  assert.deepStrictEqual(TF.missedTally([doc]), { missed: 5, learnable: 2, noValidPlan: 1, unknown: 2 });
  const found = TF.trendFindings([doc]);
  assert.deepStrictEqual(found.map(f => [f.step, f.skill, f.count, f.cost, f.code, f.of]), [[null, null, 2, 4, 'no-plan', 7]]);
  // Up to the configured examples, the costliest leg first: what was said beside the plan that passed.
  const EX = require('../../scripts/lib/tunables').training().trendFindings;
  assert.strictEqual(found[0].examples.length, Math.min(2, EX.examples));
  assert.ok(found[0].examples.every(x => x.length <= EX.exampleChars));
  assert.match(found[0].examples[0], /^long: what you said: "no-trade - the long at on: no rejection at a key level, price"\. A plan that passed there: "1h up", "at prior vah", "15m rejected prior vah up", "3m close top", "stop 15m low", "target 1h swing high"$/);
  assert.doesNotMatch(found[0].examples[0], /15m bos up|3m bos up/, 'never the whole list of TRUE reads');
  assert.doesNotMatch(found[0].examples[0], /Contradiction/, 'what was said is never parsed');
  // A late or unfilled entry's legs (the runner's execution) give no example.
  const late = { legs: [{ ...doc.legs[0], blocker: { step: 'execution', code: 'late-entry', by: 'gate' } }] };
  assert.deepStrictEqual(TF.trendFindings([late])[0].examples, []);
  assert.deepStrictEqual(TF.missedTally([]), { missed: 0, learnable: 0, noValidPlan: 0, unknown: 0 });
});

test('trend facts: the runner\'s words are labelled the runner\'s', () => {
  const leg = { side: 'long', facts: { bars: [{ valid: true, known: true, said: 'CYCLE RESULT: no-trade - the runner\'s entry: missed the plan\'s entry', shown: 'no-trade - the runner\'s entry: missed 21530.25 at 10:45', planReads: ['1h up'] }] } };
  assert.match(X.exampleLine(leg), /^long: the runner: "no-trade - the runner's entry: missed at"\. A plan that passed there: "1h up"$/);
});

test('trend facts: a plan\'s outcome on the later bars: its stop before its R:R mark lost (the stop first on one bar), the mark first won', () => {
  const o = after => X.outcomeOf({ side: 'long', entry: 100, stop: 90, minRR: 2, after });
  assert.strictEqual(o([{ h: 110, l: 95 }, { h: 121, l: 100 }]), 'won');
  assert.strictEqual(o([{ h: 110, l: 95 }, { h: 111, l: 89 }]), 'lost');
  assert.strictEqual(o([{ h: 125, l: 89 }]), 'lost', 'one bar holding both: the stop first');
  assert.strictEqual(o([{ h: 110, l: 95 }]), null, 'neither by the session\'s end');
  assert.strictEqual(X.outcomeOf({ side: 'short', entry: 100, stop: 110, minRR: 2, after: [{ h: 105, l: 79 }] }), 'won');
  assert.strictEqual(X.outcomeOf({ side: 'long', entry: null, stop: 90, minRR: 2, after: [] }), null);
});

test('the base rate and the balancing examples: control bars with a valid plan, and those plans that lost, scrubbed, a day each in turn', () => {
  const lost = (bar, side) => ({ bar, known: true, valid: true, side, planReads: ['15m up', 'stop 15m low 21512.75'], shown: 'no-trade - waited at 10:45 on 2026-04-23 near 21530', outcome: 'lost' });
  const doc = { legs: capture().legs, controls: [lost('2026-04-23T14:00:00.000Z', 'long'), lost('2026-04-23T14:03:00.000Z', 'short'), lost('2026-04-24T14:00:00.000Z', 'long'),
    { ...lost('2026-04-24T14:03:00.000Z', 'long'), outcome: 'won' }, { ...lost('2026-04-24T14:06:00.000Z', 'short'), outcome: null }, { bar: 'x', side: 'long', known: true, valid: false }, { bar: 'y', side: 'short', known: false, valid: false }] };
  const c = X.controlsOf([doc], { examples: 2 });
  assert.deepStrictEqual([c.controlBars, c.legBars], [{ sides: 6, valid: 5, won: 1, lost: 3, undecided: 1 }, { bars: 3, valid: 2 }]);
  assert.deepStrictEqual(c.losers.map(x => x.bar), ['2026-04-23T14:00:00.000Z', '2026-04-24T14:00:00.000Z'], 'a day each first');
  const text = X.controlsText(c);
  assert.match(text, /^Base rate: a valid with-trend plan existed on 67% of the missed legs' entry bars \(the leg's side, n=3\) and on 83% of the control bars with no leg \(each side on its own, n=6\); of those control plans 1 won, 3 lost, 1 undecided by the session's end: a valid plan alone does not tell a leg\.\nThose control plans by setup type, from this round's control windows \(small n: a hint, never a rate\):\n {3}- other: n=5, 1 won, 3 lost, 1 undecided\nValid plan, it lost \(control bars, no leg\): what tells these apart from the legs\?\n {3}- long: valid plan, it lost: "15m up", "stop 15m low"\. What you said: "no-trade - waited at on near"$/m);
  assert.doesNotMatch(text, /21512|10:45|2026/);
  assert.strictEqual(X.controlsText(X.controlsOf([{ legs: [] }])), '', 'no control bars: nothing');
  // In the proposer's prompt after the findings.
  const findings = F.mergeFindings(TF.trendFindings([doc]), [], { max: 8 });
  const prompt = P.probePrompt({ template: P.readProbeTemplate(ROOT), findings, controls: text, lessons: null, files: ['skills/rejection/SKILL.md'], k: 2 });
  assert.ok(prompt.includes(text) && prompt.indexOf(text) > prompt.indexOf('F1.'), 'after the findings');
});

test('a setup read\'s type: its kind and level, no timeframe, side or number', () => {
  assert.strictEqual(X.setupTypeOf('15m rejected overnight low up'), 'rejected overnight low');
  assert.strictEqual(X.setupTypeOf('3m rejected overnight low down'), 'rejected overnight low', 'one type whatever the frame and side');
  assert.strictEqual(X.setupTypeOf('15m compression break up'), 'compression break');
  assert.strictEqual(X.setupTypeOf('momentum_continuation fired up'), 'momentum_continuation');
  assert.strictEqual(X.setupTypeOf('15m touched round 21500'), 'touched round', 'no number');
  assert.strictEqual(X.setupTypeOf('swept prior day high'), 'swept prior day high');
  assert.strictEqual(X.setupTypeOf('15m cisd up'), 'cisd');
  for (const r of ['1h up', 'stop 15m low 21512.75', '', null, 'not a read']) assert.strictEqual(X.setupTypeOf(r), 'other', String(r));
});

test('the control plans by setup type: grouped, sorted by n, the n floor and the cap folded into other, empty without plans', () => {
  const plan = (setup, outcome, extra = {}) => ({ bar: '2026-04-23T14:00:00.000Z', side: 'long', known: true, valid: true, planReads: ['1h up', setup, 'stop 15m low 21512.75'], planSetup: setup, outcome, ...extra });
  const controls = [
    ...['won', 'lost', 'lost', null].map(o => plan('15m rejected overnight low up', o)), plan('3m rejected overnight low down', 'won'),
    ...['lost', 'lost', 'won'].map(o => plan('15m compression break up', o)),
    ...['won', 'won', 'lost'].map(o => plan('momentum_continuation fired up', o)),
    plan('swept prior day high', 'lost'), plan('15m cisd up', null),
    { bar: 'x', side: 'short', known: true, valid: false }, { ...plan('15m cisd up', 'won'), known: false },
  ];
  const c = X.controlsOf([{ legs: [], controls }], { setupTypes: 2, setupMinN: 2 });
  assert.deepStrictEqual(c.bySetup, [
    { type: 'rejected overnight low', n: 5, won: 2, lost: 2, undecided: 1 },
    { type: 'compression break', n: 3, won: 1, lost: 2, undecided: 0 },
    { type: 'other', n: 5, won: 2, lost: 2, undecided: 1 },
  ], 'the third type is past the cap, the two singles under the floor: all in other; invalid and unknown bars not counted');
  assert.strictEqual(c.bySetup.reduce((n, r) => n + r.n, 0), c.controlBars.valid, 'every valid control plan in one row');
  assert.deepStrictEqual(X.controlsOf([{ legs: [], controls }], { setupTypes: 5, setupMinN: 1 }).bySetup.map(r => r.type), ['rejected overnight low', 'compression break', 'momentum_continuation', 'cisd', 'swept prior day high']);
  // A capture from before planSetup: the plan's first setup-only read.
  assert.deepStrictEqual(X.controlsOf([{ legs: [], controls: [{ ...plan('15m compression break up', 'won'), planSetup: undefined }] }], { setupMinN: 1 }).bySetup, [{ type: 'compression break', n: 1, won: 1, lost: 0, undecided: 0 }]);
  assert.deepStrictEqual(X.controlsOf([{ legs: [], controls: [] }]).bySetup, []);
  assert.deepStrictEqual(X.setupRates([]), []);
  const text = X.controlsText(c);
  assert.match(text, /\nThose control plans by setup type, from this round's control windows \(small n: a hint, never a rate\):\n {3}- rejected overnight low: n=5, 2 won, 2 lost, 1 undecided\n {3}- compression break: n=3, 1 won, 2 lost, 0 undecided\n {3}- other: n=5, 2 won, 2 lost, 1 undecided(\n|$)/);
  assert.match(text, /^Base rate: a valid with-trend plan existed on n\/a of the missed legs' entry bars \(the leg's side, n=0\) and on 93% of the control bars with no leg \(each side on its own, n=14\); of those control plans 5 won, 6 lost, 2 undecided by the session's end: a valid plan alone does not tell a leg\.\n/, 'the pooled line unchanged');
  assert.doesNotMatch(text, /21512|2026/);
});

test('the control plans by setup type read only the round\'s own control outcomes, never a census\'s or a moment\'s', () => {
  const plan = { bar: '2026-04-23T14:00:00.000Z', side: 'long', known: true, valid: true, planReads: ['15m compression break up'], planSetup: '15m compression break up', outcome: 'lost' };
  const base = X.controlsOf([{ legs: [], controls: [plan] }], { setupMinN: 1 }).bySetup;
  // Outcomes a census or a moment might carry, beside the capture's controls: none counted.
  const noisy = { legs: [], controls: [{ ...plan, census: { outcome: 'won', r: 3 }, moment: { outcome: 'won' } }], census: [{ setup: 'compression break', outcome: 'won' }], moments: [{ outcome: 'won' }] };
  assert.deepStrictEqual(X.controlsOf([noisy], { setupMinN: 1 }).bySetup, base);
  assert.deepStrictEqual(base, [{ type: 'compression break', n: 1, won: 0, lost: 1, undecided: 0 }]);
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'train', 'trend-facts.js'), 'utf8');
  assert.doesNotMatch(src, /require\([^)]*(?:leg-census|setup-moments|edge-census)/, 'no census or moments module');
});

test('the proposer\'s prompt: a trend finding\'s example legs, no date, clock time or price from the legs', () => {
  const findings = F.mergeFindings(TF.trendFindings([capture()]), [], { max: 8 });
  const line = F.findingLine(findings[0]);
  assert.match(line, /^F1\. \(no skill or role named\): trend-blocker at no step: blocked 2 of 7 trend legs, each with a valid plan at the time\. Most often: no-plan \(2\)\n {3}- leg long: /);
  const prompt = P.probePrompt({ template: P.readProbeTemplate(ROOT), findings, lessons: null, files: ['skills/rejection/SKILL.md'], k: 2 });
  assert.ok(prompt.includes('a plan code verified there'), 'the template\'s words for the facts');
  // A placeholder's text is put in as written: "$&" or "$`" in a finding or a lesson is no replacement pattern.
  const odd = P.probePrompt({ template: P.readProbeTemplate(ROOT), findings: [{ ...findings[0], detail: 'cost $& and $` here' }], lessons: 'a $\' lesson', files: ['skills/rejection/SKILL.md'], k: 2 });
  assert.ok(odd.includes('cost $& and $` here') && odd.includes('a $\' lesson'), 'literal');
  const flagged = P.selfReviewPrompt({ template: P.readTemplate(ROOT), flagged: [{ day: 'd', t: 't', category: 'x', stated: 'paid $& for it' }], files: ['f'], maxProposals: 1 });
  assert.ok(flagged.includes('paid $& for it'));
  assert.ok(prompt.includes('- leg long: what you said'));
  for (const bad of ['2026-04-23', '10:45', '14:57', '15:00', '21530', '21540', '21512', '21598']) assert.ok(!prompt.includes(bad), bad);
  assert.doesNotMatch(prompt.replace(/\{\{[A-Z]+\}\}/g, ''), /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b|\b\d{4,}(?:\.\d+)?\b/);
});

test('the probe template: its placeholders and the facts lines (the proposer reads it from the skill)', () => {
  const t = P.readProbeTemplate(ROOT);
  for (const k of ['{{FLOW}}', '{{FINDINGS}}', '{{LESSONS}}', '{{FILES}}', '{{CATEGORIES}}', '{{KINDS}}', '{{K}}']) assert.ok(t.includes(k), k);
  assert.match(t, /^- A trend leg shows what you said and a plan code verified there → fix the read or rule that hid the plan\.$/m);
  assert.doesNotMatch(t, /contradiction/i, 'the proposer reads what was said beside what passed');
  assert.match(t, /^- Plans that lost sit beside the legs → tell the legs from the losers; never just enter more\.$/m);
  assert.match(t, /It never makes you take a trade the facts don't support\./, 'the rule the trend lines stand under');
});

test('the iteration\'s status line counts the probe half\'s missed legs and the base rate', () => {
  const IR = require('../../scripts/lib/train/iteration-report');
  const trend = { set: 'fp', batch: { index: 0, size: 4, trigger: 'start', why: '' }, probe: { days: ['d'], legs: ['a'] }, confirm: { days: ['e'], legs: ['b'] }, missed: { missed: 5, learnable: 2, noValidPlan: 1, unknown: 2 }, baseRate: { legBars: { bars: 10, valid: 6 }, controlBars: { sides: 20, valid: 11, won: 3, lost: 4, undecided: 4 } } };
  const rec = IR.build({ probeReport: { iteration: 1, trend, findings: [], edits: [], probes: [] } });
  assert.deepStrictEqual([rec.trend.missed, rec.trend.baseRate], [trend.missed, trend.baseRate]);
  assert.match(IR.line(rec), /; probe missed legs 5: learnable 2, no valid plan 1 \(a correct pass\), unknown 2, valid plan on 60% \(n 10\) of leg bars vs 55% \(n 20\) of control bar-sides \(won 3, lost 4, undecided 4\)/);
  assert.doesNotMatch(IR.line(IR.build({ probeReport: { iteration: 1, trend: { ...trend, missed: undefined, baseRate: undefined }, findings: [], edits: [], probes: [] } })), /probe missed legs|control bars/);
});

// --- the run home, read only -----------------------------------------------------------------------------------------

/** Every file under a folder with its bytes: a snapshot to compare after a read. */
function snapshot(dir) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
}

test('attachFacts: the run home\'s bars, cycles and records, read only; the capture in the run\'s folder never changed; its control bars', () => {
  const { load } = require('../fixtures/trend-moves');
  const { bars, legs } = load();
  const home = tmpDir();
  const runDir = path.join(home, 'replay', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'bars'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify(bars.m3));
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-1m.json'), JSON.stringify(bars.m1));
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ timeframe: 3, symbols: ['MNQ'], sessions: ['09:30-12:00@America/New_York'] }));
  // A leg with a valid plan at a bar the set records (trend-moves legs.json), its cycle logged there; one cycle after it.
  const leg = legs.legs.find(l => l.moments.some(m => m.validPlan));
  const m = leg.moments.find(x => x.validPlan);
  const close = new Date(Date.parse(m.bar) + 180000).toISOString();
  const later = new Date(Date.parse(leg.extreme) + 30 * 60000).toISOString();
  const day = path.join(home, 'logs', 'cycles', leg.day);
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, '000000-trade.json'), JSON.stringify({ action: 'trade', result: `CYCLE RESULT: no-trade - no ${leg.side} setup`, timing: { barClose: close } }));
  fs.writeFileSync(path.join(day, '000001-trade.json'), JSON.stringify({ action: 'trade', result: 'CYCLE RESULT: no-trade - waiting', timing: { barClose: later } }));
  fs.writeFileSync(path.join(day, '000002-trade.json'), JSON.stringify({ action: 'trade', result: 'CYCLE RESULT: managed - holding', timing: { barClose: new Date(Date.parse(later) + 180000).toISOString() } }));
  const doc = { legs: [{ id: leg.id, day: leg.day, side: leg.side, start: leg.start, end: leg.extreme, captured: false, availableR: 1, blocker: { step: null, code: 'no-plan', by: 'head' }, cycles: [{ bar: close, code: 'no-plan', by: 'head', step: null, reads: [], message: 'x' }] }] };
  fs.writeFileSync(path.join(runDir, 'trend-capture.json'), JSON.stringify(doc));
  const before = snapshot(home);
  const got = X.attachFacts(doc, { runDir, home, tree: ROOT });
  assert.deepStrictEqual(snapshot(home), before, 'nothing in the run home written or changed');
  assert.strictEqual(doc.legs[0].facts, undefined, 'the given capture untouched');
  assert.deepStrictEqual([got.legs[0].facts.learnable, got.legs[0].facts.bars[0].said], [true, `CYCLE RESULT: no-trade - no ${leg.side} setup`]);
  assert.deepStrictEqual(got.legs[0].facts.bars[0].unknown, [], 'the 1m bars give the 5m facts');
  // The control bars: every trade cycle on no leg's span (a managed one is none), or those in the windows given.
  const ctlBar = new Date(Date.parse(later) - 180000).toISOString();
  assert.deepStrictEqual(got.controls.map(x => [x.bar, x.side]), [[ctlBar, 'long'], [ctlBar, 'short']], 'each side on its own');
  assert.ok(got.controls.every(x => x.known), JSON.stringify(got.controls));
  assert.deepStrictEqual(X.attachFacts(doc, { runDir, home, tree: ROOT, controls: [] }).controls, []);
  assert.strictEqual(X.attachFacts(doc, { runDir, home, tree: ROOT, controls: [{ from: Date.parse(later) - 1, to: Date.parse(later) }] }).controls.length, 2);
  // Without the 1m bars the 5m is missing: listed unknown.
  fs.rmSync(path.join(home, 'bars', 'MNQ-1m.json'));
  assert.deepStrictEqual(X.attachFacts(doc, { runDir, home, tree: ROOT }).legs[0].facts.bars[0].unknown, ['5m']);
  // No timeframe or symbol in the run's config: every missed leg's facts unknown, never guessed.
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), '{}');
  assert.deepStrictEqual(X.attachFacts(doc, { runDir, home, tree: ROOT }).legs[0].facts.learnable, null);
});

test('the trend facts reach no trading prompt: only the training loop requires them', () => {
  const users = [];
  const walk = d => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js') && /require\([^)]*trend-facts['"]\)/.test(fs.readFileSync(path.join(ROOT, p), 'utf8'))) users.push(p); } };
  walk('scripts');
  walk('hooks');
  assert.deepStrictEqual(users.sort(), ['scripts/lib/train/probe.js', 'scripts/lib/train/trend-findings.js']);
});

test('sizeWithin: budgetPlan\'s sizing at a budget and room given; budgetPlan works them out only after its checks pass', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { loadAccounts } = require('../../scripts/lib/trading/accounts');
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  const policy = loadStrategies(ROOT, {}).strategies.find(s => s.valid && s.signal === 'policy' && s.sizing);
  const account = loadAccounts(ROOT, {}).accounts.find(a => a.name === policy.account);
  const big = prop.sizeWithin({ dollars: 600, room: 2000 }, account, policy, 'MNQ', 40);
  assert.ok(big.size >= 1 && !big.error, JSON.stringify(big));
  const small = prop.sizeWithin({ dollars: 5, room: 2000 }, account, policy, 'MNQ', 40);
  assert.strictEqual(small.size, 0, 'under the floor: none fits');
  assert.match(prop.sizeWithin({ dollars: 600, room: 2000 }, account, policy, 'MNQ', 0).error, /stopLossBracket\.ticks/);
  // A corrupt snapshot (its days no list, a clock that reads them): a check that fails first still answers with its
  // error, never a throw (the budget is worked out only once every check passes, as before the split).
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'combine'), { recursive: true });
  const state = { days: 5, balance: 100000, start: 100000, floor: 97000, peak: 100000, dayPnl: 0, target: 6000, sessions: 30, status: 'active', dailyLimit: 2000 };
  fs.writeFileSync(path.join(home, 'combine', `${account.name}.json`), JSON.stringify({ account: account.name, days: [], snapshot: { state } }));
  const clocked = { ...policy, sizing: { ...policy.sizing, clock_k: 1 } };
  assert.throws(() => require('../../scripts/lib/trading/combine').budget(state, clocked.sizing), /not iterable/, 'the case: working out this budget throws');
  assert.match(prop.budgetPlan(home, account, clocked, 'MNQ', 0).error, /stopLossBracket\.ticks/);
});
