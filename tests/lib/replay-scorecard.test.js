'use strict';

// The adherence scorecard (scripts/lib/replay/scorecard.js): the pure steps on crafted facts, and a whole
// synthetic run home (no real data) through scoreRun and writeScorecard.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const { tmpDir } = require('../helpers');
const { scoreRun, writeScorecard, checkReasons, expectedDecision, expectedForEntry, classify, clausesOf, CATEGORIES } = require('../../scripts/lib/replay/scorecard');

// ------------------------------------------------------------------------------------------------
// Pure steps

const WINDOW = { opening: { name: 'opening print (no entries)', until: '09:35', et: '09:31', entriesAllowed: false }, drive: { name: 'opening drive', until: '11:00', et: '09:57', entriesAllowed: true } };
const TREND_DOWN = { prevailing: '15m down', long: false, short: true };
const ACTIVE = { account: 'topstep_100k', status: 'active', balance: 100000, floor: 97000, cushion: 3000, dayPnl: 0, entryBlock: null };

/** A policy setup (prop_portfolio from a component) that passes every mechanical step unless told otherwise. */
function setup(over = {}) {
  return {
    name: 'prop_portfolio', component: 'keltner', policy: true, direction: 'short', candidate: true, style: 'trend', stopPoints: 19.8,
    verdict: { action: 'full', maxSize: 22, contract: 'MNQ', stopTicks: 79, reason: null }, trendAllows: true, prevailing: { label: '15m', trend: 'down' },
    room: { inTheWay: { name: 'round number', R: 3 }, needR: 2 }, alignment: 'aligned', confluence: { with: [], against: [] }, blocked: null, vwapSide: 'below', lunch: false, ...over,
  };
}
function facts(over = {}) {
  return {
    t: '2026-06-01T14:30:02.000Z', window: WINDOW.drive, scanned: true, setups: [], trendRule: TREND_DOWN, attempt: ACTIVE,
    styleOf: n => ({ keltner: 'trend', orb: 'trend', cisd_ote: 'reversal', manual_x: 'manual' }[n] || null),
    // prop_portfolio holds to +2R then trails; crt_1h exits at its level or after 40 bars.
    planOf: n => ({ prop_portfolio: { targetR: null, trailActivateR: 2, maxBars: null, minutes: 3 }, crt_1h: { targetR: null, trailActivateR: null, maxBars: 40, minutes: 3 } }[n] || null),
    ...over,
  };
}
const claim = (r, kind) => r.claims.find(c => c.kind === kind);

test('clauses: the outcome word is not a reason, the rest splits into clauses; times alone are dropped', () => {
  assert.deepStrictEqual(clausesOf('CYCLE RESULT: blocked - Opening print window until 10:00 ET and no strategy candidates'), { stated: 'blocked', clauses: ['Opening print window until 10:00 ET and no strategy candidates'] });
  assert.deepStrictEqual(clausesOf('CYCLE RESULT: no-trade | opening blackout and no candidate strategies').stated, 'no-trade');
  // No outcome word: the first word is a reason.
  assert.deepStrictEqual(clausesOf('CYCLE RESULT: No strategy candidates'), { stated: null, clauses: ['No strategy candidates'] });
  assert.deepStrictEqual(clausesOf('CYCLE RESULT: no-trade - no candidates (09:48 ET), ADX falling').clauses, ['no candidates', 'ADX falling']);
});

test('reasons: "Opening print window until 10:00 ET" is false when the window allows entries, and false on a wrong end time', () => {
  const text = 'CYCLE RESULT: blocked - Opening print window until 10:00 ET and no strategy candidates';
  const r = checkReasons(text, facts({ window: WINDOW.drive, setups: [setup()] }));
  assert.strictEqual(claim(r, 'no-entry-window').check, false);
  assert.match(claim(r, 'no-entry-window').why, /opening drive window allows entries/);
  // The verdict on the bar: "no strategy candidates" is false too.
  assert.strictEqual(claim(r, 'nothing-fired').check, false);
  assert.match(claim(r, 'nothing-fired').why, /prop_portfolio short \(verdict full 22\)/);
  assert.strictEqual(r.status, 'false');
  // In the opening print, but it ends at 09:35, not 10:00.
  const early = checkReasons(text, facts({ window: WINDOW.opening }));
  assert.strictEqual(claim(early, 'no-entry-window').check, false);
  assert.match(claim(early, 'no-entry-window').why, /ends at 09:35 ET, not 10:00/);
  // Said right: confirmed.
  const right = checkReasons('CYCLE RESULT: blocked - we\'re in the opening print window (no entries allowed until 09:35 ET), no strategy candidates', facts({ window: WINDOW.opening }));
  assert.deepStrictEqual(right.claims.map(c => [c.kind, c.check]), [['no-entry-window', true], ['nothing-fired', true]]);
  assert.strictEqual(right.status, 'confirmed');
});

test('reasons: "keltner short blocked by 15m down trend rule" is false when the trend rule allows shorts, true when it blocks them', () => {
  const text = 'CYCLE RESULT: no-trade - no candidate strategies (keltner short blocked by 15m down trend rule; other strategies failed rules or are paper)';
  const r = checkReasons(text, facts({ setups: [setup()] }));
  assert.strictEqual(claim(r, 'trend-blocks').check, false);
  assert.match(claim(r, 'trend-blocks').why, /allows short/);
  assert.strictEqual(claim(r, 'nothing-fired').check, false, 'a verdict was on the bar');
  assert.deepStrictEqual(r.unparsed, ['other strategies failed rules or are paper']);
  const blocked = checkReasons(text, facts({ setups: [setup({ trendAllows: false, candidate: false, verdict: null })], trendRule: { prevailing: '15m up', long: true, short: false } }));
  assert.strictEqual(claim(blocked, 'trend-blocks').check, true);
  // A side named without a strategy: the trend rule per side. "blocks all trend-following setups" claims both sides.
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade - 15m down trend blocks trend longs', facts()), 'trend-blocks').check, true);
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade - prevailing 15m down trend blocks all trend-following setups', facts()), 'trend-blocks').check, false);
  // A reversal strategy named: the trend rule never blocks it; fading the prevailing trend, step 2 decides (judgment:
  // only at a higher-timeframe level, half size), so a veto by it is unchecked, never false.
  const rev = checkReasons('CYCLE RESULT: no-trade - cisd_ote long blocked by the trend rule', facts({ setups: [setup({ name: 'cisd_ote', component: null, policy: false, direction: 'long', style: 'reversal', verdict: null })] }));
  assert.strictEqual(claim(rev, 'trend-blocks').check, 'unchecked');
  const withIt = checkReasons('CYCLE RESULT: no-trade - cisd_ote short blocked by the trend rule', facts({ setups: [setup({ name: 'cisd_ote', component: null, policy: false, direction: 'short', style: 'reversal', verdict: null })] }));
  assert.strictEqual(claim(withIt, 'trend-blocks').check, false);
  // "blocked by the trend rule or failed their triggers": a claim that nothing fired, not a trend claim.
  const or = checkReasons('CYCLE RESULT: no-trade - all strategies blocked by prevailing 15m down trend rule or failed their triggers', facts());
  assert.deepStrictEqual(or.claims.map(c => [c.kind, c.check]), [['nothing-fired', true]]);
});

test('reasons: "no candidate strategies" is false with a verdict present, true without; "no reversal strategies" checks reversals only', () => {
  const withVerdict = checkReasons('CYCLE RESULT: no-trade | no candidate strategies', facts({ setups: [setup()] }));
  assert.strictEqual(claim(withVerdict, 'nothing-fired').check, false);
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade | no candidate strategies', facts()), 'nothing-fired').check, true);
  // A skip verdict is no candidate.
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade | no candidate strategies', facts({ setups: [setup({ candidate: false, verdict: { action: 'skip', maxSize: 0 } })] })), 'nothing-fired').check, true);
  const rev = checkReasons('CYCLE RESULT: no-trade | no reversal strategies firing', facts({ setups: [setup()] }));
  assert.deepStrictEqual(rev.claims.map(c => [c.kind, c.check]), [['no-reversal-fired', true]]);
  // No scan for the bar: nothing to check it against.
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade | no candidate strategies', facts({ scanned: false })), 'nothing-fired').check, 'unchecked');
});

test('reasons: "no prop attempt running" is false with an active attempt, true without one, unchecked with no attempt record', () => {
  const text = 'CYCLE RESULT: blocked - no prop attempt running, entries blocked until a prop attempt is started via combine.js start';
  const r = checkReasons(text, facts());
  assert.deepStrictEqual(r.claims.map(c => [c.kind, c.check]), [['no-attempt', false]], 'the restatement is not an entry-block claim');
  assert.match(r.claims[0].why, /topstep_100k attempt is active/);
  assert.strictEqual(checkReasons(text, facts({ attempt: { account: null, status: 'none' } })).claims[0].check, true);
  assert.strictEqual(checkReasons(text, facts({ attempt: null })).claims[0].check, 'unchecked');
});

test('reasons: room, mixed, counter, confluence, verdict and entry block against the setup; unchecked and unparsed are never ok', () => {
  const f = facts({ setups: [setup({ room: { inTheWay: { name: 'round number', R: 0.35 }, needR: 2 }, alignment: 'mixed' })] });
  const r = checkReasons('CYCLE RESULT: veto - keltner short skipped for insufficient room (needs 2R but first level is 0.35R); mixed alignment across timeframes; no confluence', f);
  assert.deepStrictEqual(r.claims.map(c => [c.kind, c.check]), [['no-room', true], ['mixed', true], ['no-confluence', true]], 'the figures (0.35R vs 2R) say the same as the words: one claim');
  assert.strictEqual(r.status, 'confirmed');
  const roomy = checkReasons('CYCLE RESULT: no-trade - insufficient room; not enough room', facts({ setups: [setup()] }));
  assert.strictEqual(roomy.claims.length, 1, 'two clauses saying the same claim count once');
  assert.strictEqual(roomy.claims[0].check, false);
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade - counter read', facts({ setups: [setup()] })), 'counter').check, false);
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade - policy strategy prop_portfolio has no verdict for MNQ', facts({ setups: [setup()] })), 'no-verdict').check, false);
  // A room claim with no room fact, a cooldown with no entry block recorded: unchecked, and the status says so.
  const unknown = checkReasons('CYCLE RESULT: no-trade | Account on 2-loss cooldown until 17:00 CT; insufficient room', facts({ setups: [setup({ room: null })] }));
  assert.deepStrictEqual(unknown.claims.map(c => [c.kind, c.check]), [['entry-block', 'unchecked'], ['no-room', 'unchecked']]);
  assert.strictEqual(unknown.status, 'unchecked');
  assert.strictEqual(checkReasons('CYCLE RESULT: no-trade | daily loss limit', facts({ attempt: { ...ACTIVE, entryBlock: 'the daily soft limit is reached' } })).claims[0].check, true);
  // A clause nothing recognizes is unparsed: the status is unchecked, never confirmed.
  const odd = checkReasons('CYCLE RESULT: no-trade - EMA 9/20 tangled on 3m', facts());
  assert.deepStrictEqual([odd.claims.length, odd.unparsed, odd.status], [0, ['EMA 9/20 tangled on 3m'], 'unchecked']);
  // Judgment (regime, ADX, volume): recognized, not checkable.
  const judged = checkReasons('CYCLE RESULT: no-trade - transition regime with falling ADX, thin volume', facts());
  assert.deepStrictEqual([judged.claims.length, judged.judgment.length, judged.status], [0, 2, 'judgment']);
});

test('expected: no scan is unchecked, no setup is no trade, each step decides in order', () => {
  assert.strictEqual(expectedDecision(facts({ scanned: false })).decision, 'unchecked');
  assert.deepStrictEqual([expectedDecision(facts()).decision, expectedDecision(facts()).decidedBy], ['no-trade', 'no setup']);
  const go = s => expectedDecision(facts({ setups: [setup(s)] }));
  // Every mechanical step passes: take, at most the verdict's size; steps 5 (and 7 when it applies) are left to judgment.
  assert.deepStrictEqual([go().decision, go().ceiling, go().decidedBy, go().judgment], ['take', 22, 'take', [5]]);
  assert.deepStrictEqual([go({ blocked: 'no-entry window' }).decision, go({ blocked: 'no-entry window' }).decidedBy], ['no-trade', 1]);
  assert.strictEqual(go({ verdict: { action: 'skip', maxSize: 0 } }).decidedBy, 1);
  assert.strictEqual(expectedDecision(facts({ setups: [setup()], attempt: { ...ACTIVE, entryBlock: 'the daily soft limit is reached' } })).decidedBy, 1);
  assert.deepStrictEqual([go({ trendAllows: false }).decision, go({ trendAllows: false }).decidedBy], ['no-trade', 2]);
  // Two steps say no trade: the higher one (the first in the order) decides.
  assert.strictEqual(go({ trendAllows: false, room: { inTheWay: { name: 'prior VAL', R: 0.5 }, needR: 2 } }).decidedBy, 2);
  // A reversal fading the prevailing trend: judgment, at half size.
  const fade = go({ style: 'reversal', direction: 'long', vwapSide: 'above' });
  assert.deepStrictEqual([fade.decision, fade.ceiling, fade.judgment], ['take', 11, [2, 5]]);
  // The room is a read (step 3 judgment), never a no trade alone: a level ahead before the target leaves the take.
  const near = go({ room: { inTheWay: { name: 'prior VAL', R: 0.69 }, needR: 2 } });
  assert.deepStrictEqual([near.decision, near.decidedBy, near.ceiling, near.judgment, near.couldSkip], ['take', 'take', 22, [3, 5], []]);
  // Mixed halves (floor); at size 1 the half is 0: no trade, decided by step 4.
  assert.deepStrictEqual([go({ alignment: 'mixed' }).decision, go({ alignment: 'mixed' }).ceiling], ['take', 11]);
  const one = go({ alignment: 'mixed', verdict: { action: 'full', maxSize: 1 } });
  assert.deepStrictEqual([one.decision, one.ceiling, one.decidedBy], ['no-trade', 0, 4]);
  assert.deepStrictEqual([go({ alignment: 'counter' }).decision, go({ alignment: 'counter' }).decidedBy], ['no-trade', 4]);
  assert.deepStrictEqual(go({ alignment: 'pullback' }).judgment, [4, 5]);
  // Halvings don't compound: a mixed read on a fading reversal is half once.
  assert.strictEqual(go({ style: 'reversal', direction: 'long', vwapSide: 'above', alignment: 'mixed' }).ceiling, 11);
  assert.deepStrictEqual([go({ confluence: { with: [], against: ['orb'] } }).decision, go({ confluence: { with: [], against: ['orb'] } }).decidedBy], ['no-trade', 6]);
  assert.deepStrictEqual(go({ vwapSide: 'above' }).judgment, [5, 7]);
  // A step it can't compute leaves it unchecked, unless a lower step says no trade (each step only lowers).
  assert.deepStrictEqual([go({ room: null }).decision, go({ room: null }).decidedBy], ['unchecked', 3]);
  assert.deepStrictEqual([go({ room: null, alignment: 'counter' }).decision, go({ room: null, alignment: 'counter' }).decidedBy], ['no-trade', 4]);
  // A setup on the other side is step 6 for both.
  const both = expectedDecision(facts({ setups: [setup(), setup({ name: 'orb', component: null, policy: false, direction: 'long', verdict: null })] }));
  assert.deepStrictEqual([both.decision, both.decidedBy], ['no-trade', 6]);
});

// A label as labels.js gives it, for classify.
function label(over = {}) {
  return { decision: 'flat', teacher: { action: 'none', setup: null, size: null, orders: [] }, gate: { decision: 'none', checks: [] }, clone: { ok: true, reasons: [] }, cycleFailed: null, ...over };
}
const entry = (side, size, gate = { decision: 'allowed', by: null, checks: [] }, setupName = 'prop_portfolio') => label({
  teacher: { action: side, setup: setupName, size: { contracts: size }, orders: [{ tool: 'place_order', riskReducing: false, setup: setupName, size }] }, gate,
});
const run = (l, f, text = 'CYCLE RESULT: done') => classify(l, f, l.decision === 'in-trade' ? { decision: 'hold' } : expectedDecision(f), checkReasons(text, f));

test('categories: each failure in the taxonomy, right, and unchecked', () => {
  const take = facts({ setups: [setup()] });
  const roomless = facts({ setups: [setup({ room: { inTheWay: { name: 'prior VAL', R: 0.5 }, needR: 2 } })] });
  // A skip on the room alone, true or not, is excessive abstention: the room is a read, never a no trade alone.
  assert.deepStrictEqual([run(label(), roomless, 'CYCLE RESULT: veto - insufficient room').category, run(label(), roomless, 'CYCLE RESULT: veto - insufficient room').agrees], ['excessive abstention', false]);
  // right: an entry within the ceiling (a skip for true reasons: the trend-rule cases below).
  assert.strictEqual(run(entry('short', 10), take).category, 'right');
  // wrong stated reason: the right skip, a false reason.
  assert.deepStrictEqual(run(label(), facts({ setups: [setup({ alignment: 'counter' })] }), 'CYCLE RESULT: no-trade - no candidate strategies').category, 'wrong stated reason');
  // excessive abstention: a skip where the order says take, on false grounds or none.
  const abst = run(label(), take, 'CYCLE RESULT: no-trade - no candidate strategies (keltner short blocked by 15m down trend rule)');
  assert.deepStrictEqual([abst.category, abst.agrees], ['excessive abstention', false]);
  assert.strictEqual(run(label(), take, 'CYCLE RESULT: no-trade').category, 'excessive abstention');
  // ...but a skip on judgment (steps 5 and 7 are the model's) or unparsed reasons is unchecked, not a failure.
  assert.deepStrictEqual([run(label(), take, 'CYCLE RESULT: no-trade - ADX falling, thin volume').category, run(label(), take, 'CYCLE RESULT: no-trade - EMA 9/20 tangled').category], ['unchecked', 'unchecked']);
  // ...and "no confluence" alone is no ground (step 6: none changes nothing alone).
  assert.strictEqual(run(label(), take, 'CYCLE RESULT: no-trade - no confluence').category, 'excessive abstention');
  // risk-rule rejection: the gate refused the entry.
  const refused = run(entry('short', 10, { decision: 'refused', by: 'gate', checks: ['combine-verdict'] }), take);
  assert.deepStrictEqual([refused.category, refused.why], ['risk-rule rejection', ['refused by gate: combine-verdict']]);
  // wrong-side entry: against the setup's side, or a side the trend rule blocks for its strategy.
  assert.strictEqual(run(entry('long', 1), take).category, 'wrong-side entry');
  assert.strictEqual(run(entry('long', 1, undefined, 'orb'), facts()).category, 'wrong-side entry');
  // bad size: over the ceiling, or entering where the order says no trade (a ceiling of 0).
  assert.deepStrictEqual(run(entry('short', 30), take).why, ['30 over the ceiling 22']);
  assert.strictEqual(run(entry('short', 30), take).category, 'bad size');
  assert.strictEqual(run(entry('short', 12), facts({ setups: [setup({ alignment: 'mixed' })] })).category, 'bad size', 'mixed halves 22 to 11');
  // An entry with a level ahead before its target: right (the room is a read, never a no trade alone).
  assert.deepStrictEqual([run(entry('short', 1), roomless).category, run(entry('short', 1), roomless).why], ['right', []]);
  // early close: an exit the model sent before the plan's exit was reached (its own test below); a hold is right.
  assert.strictEqual(run(label({ decision: 'in-trade', teacher: { action: 'exit', orders: [] }, outcome: { setup: 'prop_portfolio', r: 0.5, mfeR: 0.8, entryTime: '2026-06-01T14:20:00.000Z' } }), facts()).category, 'early close');
  assert.strictEqual(run(label({ decision: 'in-trade', teacher: { action: 'hold', orders: [] } }), facts()).category, 'right');
  // unchecked: a failed cycle, a manual strategy's entry, facts the steps can't compute.
  assert.deepStrictEqual(run(label({ cycleFailed: 'cycle timed out' }), take), { category: 'unchecked', agrees: null, why: ['cycle timed out'] });
  assert.strictEqual(run(entry('long', 1, undefined, 'manual_x'), facts()).category, 'unchecked');
  assert.strictEqual(run(entry('short', 1), facts({ setups: [setup({ room: null })] })).category, 'unchecked');
  assert.strictEqual(run(label(), facts({ setups: [setup({ room: null })] })).category, 'unchecked');
  assert.deepStrictEqual(CATEGORIES, ['right', 'wrong-side entry', 'bad size', 'early close', 'excessive abstention', 'wrong stated reason', 'risk-rule rejection', 'unchecked']);
});

test('categories: an entry the gate refused at the loss streak stop is a risk-rule rejection (a mistake to learn from), not a neutral event', () => {
  const prop = require('../../scripts/lib/trading/prop-state');
  const { severityOf } = require('../../scripts/lib/replay/failures');
  // A session at the account's loss_streak_stop, from the broker's closing fills, as the runner snapshots it.
  const home = tmpDir();
  const account = { name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod', daily_loss_limit: 1000, daily_loss_soft: 500, loss_streak_stop: 2, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50 }, fees_per_side: { MNQ: 0.37 } };
  const now = new Date('2026-06-01T15:00:00Z');
  prop.startAttempt(home, account, new Date('2026-05-29T14:00:00Z'));
  prop.snapshot(home, account, 50000, new Date('2026-06-01T14:00:00Z'));
  const fills = [1, 2].flatMap(k => [
    { creationTimestamp: `2026-06-01T14:${10 * k}:00Z`, profitAndLoss: null, fees: 0.37 },
    { creationTimestamp: `2026-06-01T14:${10 * k + 5}:00Z`, profitAndLoss: -20, fees: 0.37 },
  ]);
  prop.snapshot(home, account, 50000 - 2 * 20.74, new Date('2026-06-01T14:59:00Z'), { fills });
  // The gate's own refusal of the next entry, logged as the label reads it (labels.js: the violations' checks).
  const violations = prop.propViolations(home, { strategy: { name: 'prop_portfolio', valid: true, account: 'mini' }, account, input: { contractId: 'MNQ', side: 'buy', size: 1, stopLossBracket: { ticks: 40, type: 'stop' } }, now });
  assert.strictEqual(violations.length, 1, JSON.stringify(violations));
  assert.match(violations[0].message, /2 losing trades in a row this session, at the loss streak stop \(loss_streak_stop 2\)/);
  const gate = { decision: 'refused', by: 'gateway', checks: violations.map(v => v.check) };
  const r = run(entry('short', 1, gate), facts({ setups: [setup()] }));
  assert.deepStrictEqual([r.category, r.agrees, r.why], ['risk-rule rejection', false, ['refused by gateway: combine']]);
  assert.strictEqual(severityOf({ category: r.category }), 'medium', 'graded as a failure the loop learns from');
});

// ------------------------------------------------------------------------------------------------
// A whole run home

const DAY = '2021-03-02'; // a train month: a tuning look, every outcome shown (a Recent run's are hidden)
const RUN = 'sc1';
const iso = ms => new Date(ms).toISOString();
const BAR0 = Date.parse(`${DAY}T14:57:00Z`); // the k-th decision's bar opens at BAR0 + 3k minutes (09:57 ET: EST in March)
const barOf = k => BAR0 + k * 180000;
const tOf = k => barOf(k) + 182000; // the decision: 2 s after the bar closed
const WALL0 = Date.parse('2026-10-11T00:00:00Z');
const ATTEMPT = { account: 'topstep_100k', status: 'active', balance: 100000, floor: 97000, cushion: 3000, profit: 0, target: 6000, dayPnl: -500, sessionsLeft: 30, entryBlock: null };
const STRATS = [
  { name: 'orb', valid: true, signal: 'rules', mtf: 'trend', status: 'active', risk: { min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } },
  { name: 'prop_portfolio', valid: true, signal: 'policy', status: 'active', timeframe: '3m', risk: { min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } },
];
const ACCOUNTS = [{ name: 'topstep_100k', daily_loss_limit: 2000, daily_loss_soft: 1000 }];

/** 3000 3-minute bars to 16:00Z: a slow climb, then from 14:45Z a close at the high every bar, 8 points up (room above: round numbers). */
function bars() {
  const out = [];
  const last = Date.parse(`${DAY}T16:00:00Z`);
  for (let i = 0; i < 3000; i += 1) {
    const t = last - (2999 - i) * 180000;
    if (t < Date.parse(`${DAY}T14:45:00Z`)) {
      const base = 19000 + i * 0.5 + (i % 10 < 5 ? (i % 10) * 2 : (10 - (i % 10)) * 2);
      out.push({ t: iso(t), o: base, h: base + 6, l: base - 4, c: base + 1, v: 100 });
    } else {
      const c = out[out.length - 1].c + 8;
      out.push({ t: iso(t), o: c - 7, h: c, l: c - 8, c, v: 100 });
    }
  }
  return out;
}

const MTF = { prevailing: '4h up', longAllowed: true, shortAllowed: false };
const policyScan = (action = 'full', maxSize = 4) => [
  { name: 'orb', candidate: false, direction: 'long', stopDistance: 10, note: 'traded through prop_portfolio', confluence: { with: [], against: [] }, mtf: MTF },
  { name: 'prop_portfolio', candidate: action !== 'skip', direction: 'long', stopDistance: 10, verdict: { action, maxSize, contract: 'MNQ', ...(action === 'skip' ? { reason: 'the daily soft limit ($1,000) is reached' } : {}) } },
];
const quietScan = [{ name: 'orb', candidate: false, mtf: MTF }];
const LONG = { tool: 'place_order', input: { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 2, stopLossBracket: { ticks: 40, type: 'stop' }, rationale: 'setup:prop_portfolio long breakout, stop 20523.5' } };
const POS = [{ contractId: 'MNQ', side: 'long', size: 2, averagePrice: 20534 }];
const fill = (ms, side, price, pnl, extra = {}) => ({ id: `${ms}-${side}`, contractId: 'MNQ', creationTimestamp: iso(ms), price, profitAndLoss: pnl, fees: 0.74, side, size: 2, voided: false, ...extra });

/** The day: a right entry, a hold, an early close, an excessive abstention, a false window, a skip verdict, a refusal, a judged stand-aside, a failed cycle. */
const STEPS = [
  { k: 0, scan: policyScan(), verdict: true, cycle: { orders: [LONG], result: 'CYCLE RESULT: executed - prop_portfolio long 2 MNQ, aligned and room to 20600' } },
  { k: 1, scan: quietScan, cycle: { positions: POS, result: 'CYCLE RESULT: managed | Position running profitably with protective stop active.' }, trades: [fill(tOf(0) + 28000, 0, 20534, null, { entry: { setup: 'prop_portfolio', stopTicks: 40, tickValue: 0.5 } })] },
  { k: 2, scan: quietScan, cycle: { positions: POS, orders: [{ tool: 'close_position', input: { accountId: 7, contractId: 'MNQ' } }], result: 'CYCLE RESULT: exited - took profit early, +$40' } },
  { k: 3, scan: policyScan(), verdict: true, cycle: { result: 'CYCLE RESULT: no-trade - no candidate strategies (orb long blocked by 15m down trend rule)' }, trades: [fill(tOf(2) + 28000, 1, 20544, 20, { roundTrip: { net: 18.52, r: 0.5, maeR: -0.2, mfeR: 0.8, reason: 'exit' } })] },
  { k: 4, scan: quietScan, cycle: { result: 'CYCLE RESULT: blocked - Opening print window until 10:00 ET and no strategy candidates' } },
  { k: 5, scan: policyScan('skip', 0), verdict: true, cycle: { result: 'CYCLE RESULT: blocked - no prop attempt running' } },
  { k: 6, scan: policyScan(), verdict: true, cycle: { orders: [{ ...LONG, gate: { source: 'gateway', decision: 'blocked', violations: [{ check: 'combine-verdict', message: 'no' }] } }], result: 'CYCLE RESULT: blocked - the gate refused' } },
  { k: 7, scan: quietScan, cycle: { result: 'CYCLE RESULT: no-trade - ADX falling, thin volume; prevailing 4h up trend blocks all trend-following setups' } },
  { k: 8, scan: quietScan, cycle: { ok: false, result: 'CYCLE RESULT: error - exit 1' } },
  { t: Date.parse(`${DAY}T20:50:02Z`), kind: 'eod' },
];

function makeRun({ withBars = true, finished = true, steps = STEPS } = {}) {
  const home = path.join(tmpDir(), 'replays', RUN);
  const runDir = path.join(home, 'replay', RUN);
  for (const d of [runDir, path.join(home, 'logs', 'cycles', '2026-10-11'), path.join(home, 'bars'), path.join(runDir, 'broker')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ v: 1, runId: RUN, hash: 'c'.repeat(64), harness: 'custom', model: 'm-1', daysDone: finished ? [DAY] : [], finished }));
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ symbols: ['MNQ'], timeframe: 3, account: '7', bars: 3000 }));
  if (withBars) fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify({ contractId: 'MNQ', bars: bars() }));
  const lines = [];
  const gate = [];
  const scans = [];
  const verdicts = [];
  for (const [i, s] of steps.entries()) {
    const t = s.t || tOf(s.k);
    const barT = iso(s.t ? t - 182000 : barOf(s.k));
    const wall = WALL0 + i * 60000;
    const rec = { v: 1, t: iso(t), day: DAY, kind: s.kind || 'trade', ran: [], cycles: [], refusals: [], errors: [], bars: [{ symbol: 'MNQ', lastBarT: barT }], trades: s.trades || [], since: iso(t - 180000), ...(s.endedAt ? { endedAt: iso(t + s.endedAt) } : {}) };
    if (s.scan) scans.push({ at: iso(t + (s.lag || 0)), symbol: 'MNQ', contractId: 'MNQ', bar: { t: barT, c: 0 }, decision: { run: true, reason: 'bar closed' }, candidates: s.scan.filter(r => r.candidate).map(r => r.name), results: s.scan });
    if (s.verdict) {
      const v = s.scan.find(r => r.verdict).verdict;
      verdicts.push({ at: iso(t), strategy: 'prop_portfolio', component: 'orb', symbol: 'MNQ', contractId: 'MNQ', bar: barT, direction: 'long', stopTicks: 40, account: 'topstep_100k', combine: ATTEMPT, ...v });
      // A verdict stamped on a running clock, after the line's time (latency charged).
      if (s.lag) verdicts[verdicts.length - 1].at = iso(t + s.lag);
    }
    // A policy's verdict on a compose record (prop/composed-verdict.js), written at the record's bar.
    for (const pv of s.policyVerdict ? [s.policyVerdict] : s.policyVerdicts || []) verdicts.push({ at: iso(t), symbol: 'MNQ', contractId: 'MNQ', bar: barT, direction: 'long', action: 'full', maxSize: 3, contract: 'MNQ', ...pv });
    if (s.cycle) {
      const c = s.cycle;
      const file = path.join(home, 'logs', 'cycles', '2026-10-11', `${String(i).padStart(6, '0')}-trade.json`);
      const transcript = (c.orders || []).map((o, j) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `c${i}-${j}`, name: `mcp__broker__${o.tool}`, input: o.input }] } })).join('\n');
      const account = { id: 7, balance: 100000, positions: c.positions || [], workingOrders: 0 };
      const openTrades = (c.positions || []).map(p => ({ contractId: p.contractId, side: p.side, stop: p.averagePrice - 10 }));
      fs.writeFileSync(file, JSON.stringify({ at: iso(wall), action: 'trade', prompt: `p${i}`, context: { symbols: [{ symbol: 'MNQ', bar: { t: barT, c: 0 } }], account, openTrades, attempts: [ATTEMPT] }, transcript, ...(c.composed ? { composed: c.composed } : {}) }));
      rec.ran.push({ action: 'trade', ok: c.ok !== false, timedOut: false, result: c.result, symbols: ['MNQ'] });
      rec.cycles.push({ action: 'trade', at: iso(wall), ok: c.ok !== false, timedOut: false, durationMs: 30000, result: c.result, promptHash: `h${i}`, file });
      for (const [j, o] of (c.orders || []).entries()) {
        if (o.tool === 'close_position') continue;
        gate.push({ ts: iso(wall + 1000 + j * 100), tool: o.tool, source: 'gateway', decision: 'allowed', violations: [], ...(o.gate || {}), contractId: o.input.contractId, rationale: o.input.rationale });
      }
    }
    lines.push(rec);
  }
  const jsonl = xs => xs.map(x => `${JSON.stringify(x)}\n`).join('');
  fs.writeFileSync(path.join(runDir, `${DAY}.jsonl`), jsonl(lines));
  fs.writeFileSync(path.join(home, 'logs', 'gate-log.jsonl'), jsonl(gate));
  fs.writeFileSync(path.join(home, 'logs', `scans-${DAY}.jsonl`), jsonl(scans));
  fs.writeFileSync(path.join(home, 'policy-verdicts.jsonl'), jsonl(verdicts));
  fs.writeFileSync(path.join(runDir, 'broker', 'journal.jsonl'), '');
  return { home, runDir };
}

test('scoreRun rebuilds the room on the run\'s own round-number steps (its seeded home), never today\'s user config', () => {
  const { seedFile, loadRoundSteps, FILE_NAME } = require('../../scripts/lib/trading/round-numbers');
  const { home, runDir } = makeRun();
  // The run was seeded with the round numbers off for the family; the developer's own home is irrelevant.
  fs.writeFileSync(path.join(home, FILE_NAME), JSON.stringify(seedFile(loadRoundSteps({ FTH_HOME: tmpDir() }))).replace('"MNQ":100', '"MNQ":null'));
  const room = scoreRun(runDir, { strategies: STRATS, accounts: ACCOUNTS }).records[0].facts.setups[0].room;
  assert.notStrictEqual(room.inTheWay && room.inTheWay.name, 'round number', JSON.stringify(room));
});

test('scoreRun, latency charged: a line\'s own scan and verdict, stamped after its time on the running clock, count up to where its step ended', () => {
  const steps = (lag, endedAt) => [{ ...STEPS[0], lag, ...(endedAt ? { endedAt } : {}) }, STEPS.at(-1)];
  const first = (lag, endedAt) => scoreRun(makeRun({ steps: steps(lag, endedAt) }).runDir, { strategies: STRATS, accounts: ACCOUNTS }).records[0].facts;
  const f = first(5000, 240000);
  assert.deepStrictEqual([f.scanned, f.setups[0] && f.setups[0].verdict && f.setups[0].verdict.maxSize], [true, 4]);
  // The verdicts file's record (its component and stop), stamped after the line's time, is the line's too.
  const p = f.setups.find(x => x.name === 'prop_portfolio');
  assert.deepStrictEqual([p.component, p.verdict.stopTicks], ['orb', 40]);
  assert.strictEqual(first(5000, null).scanned, false, 'pinned (no endedAt): only up to the line\'s time');
  assert.strictEqual(first(241000, 240000).scanned, false, 'past the step\'s end: not the line\'s');
  assert.strictEqual(f.et, '10:00', 'the decision\'s own time still sets the facts\' clock');
});

test('scoreRun: every decision of a run scored from its own records', () => {
  const { runDir } = makeRun();
  const { records, summary } = scoreRun(runDir, { strategies: STRATS, accounts: ACCOUNTS });
  assert.strictEqual(records.length, 9);
  assert.deepStrictEqual(summary.notScored, { housekeeping: 1 });
  const R = Object.fromEntries(records.map((r, i) => [i, r]));

  // 0: the facts the model had: the window, the verdict from its component, the trend rule, the rebuilt room and read, the attempt.
  const f = R[0].facts;
  assert.deepStrictEqual([f.et, f.window.name, f.window.entriesAllowed], ['10:00', 'opening drive', true]);
  assert.deepStrictEqual(f.trendRule, { prevailing: '4h up', long: true, short: false });
  const s = f.setups[0];
  assert.deepStrictEqual([s.name, s.component, s.direction, s.style, s.trendAllows, s.verdict.maxSize, s.alignment], ['prop_portfolio', 'orb', 'long', 'trend', true, 4, 'aligned']);
  assert.deepStrictEqual(s.room, { inTheWay: { name: 'round number', R: 6.65 }, needR: 2 });
  assert.deepStrictEqual([R[0].expected.decision, R[0].expected.ceiling, R[0].expected.decidedBy], ['take', 4, 'take']);
  assert.deepStrictEqual([R[0].actual.action, R[0].actual.size, R[0].category, R[0].agrees], ['long', 2, 'right', true]);
  // The trade's result in R and dollars; the account pacing.
  assert.deepStrictEqual([R[0].trade.result, R[0].trade.r, R[0].trade.net], ['win', 0.5, 18.52]);
  assert.deepStrictEqual([R[0].pacing.cushion, R[0].pacing.dailyHeadroom, R[0].pacing.softHeadroom, R[0].pacing.balanceCheck], [3000, 1500, 500, 'ok']);

  // 1, 2: in the trade, a hold, then an exit the model sent.
  assert.deepStrictEqual([R[1].decision, R[1].category], ['in-trade', 'right']);
  assert.deepStrictEqual([R[2].category, R[2].agrees, R[2].why], ['early close', false, ['closed at 0.5R, its best 0.8R, before the plan\'s 2R']]);
  // 3: the order says take; skipped on false grounds, with what the setup would have done.
  assert.deepStrictEqual([R[3].expected.decision, R[3].category], ['take', 'excessive abstention']);
  assert.deepStrictEqual(R[3].reasons.claims.map(c => [c.kind, c.check]), [['nothing-fired', false], ['trend-blocks', false]]);
  assert.ok(R[3].counterfactual, 'a skipped setup carries its counterfactual');
  assert.strictEqual(R[3].counterfactual.strategy, 'prop_portfolio');
  // 4: nothing to take, but the stated window is false.
  assert.deepStrictEqual([R[4].expected.decidedBy, R[4].category], ['no setup', 'wrong stated reason']);
  // ...and the briefing held a composable setup (a 15m break at a key level, the trigger closed, the trend rule's side)
  // the model passed without compose_check: the pass disagrees (fix/confluence-not-vetoes: compose first).
  assert.deepStrictEqual([R[4].agrees, R[4].facts.composable.valid, R[4].why[0]], [false, true, 'no compose: long 15m broke overnight high (+2), confirmation, passed without compose_check']);
  assert.match(R[4].reasons.claims.find(c => c.kind === 'no-entry-window').why, /opening drive window allows entries/);
  // 5: a skip verdict (step 1); "no prop attempt running" while it runs.
  assert.deepStrictEqual([R[5].expected.decision, R[5].expected.decidedBy, R[5].category], ['no-trade', 1, 'wrong stated reason']);
  // 6: the gate refused the entry; the room (1.85R ahead of the 2R it aims for) is a read: the order said take.
  assert.deepStrictEqual([R[6].category, R[6].expected.decidedBy, R[6].expected.judgment], ['risk-rule rejection', 'take', [3, 5]]);
  // 7: no setup, judgment reasons, and a false claim about trend setups the bar didn't have: incidental, still right.
  assert.deepStrictEqual([R[7].category, R[7].reasons.judgment.length, R[7].incidentalFalse], ['right', 2, 1]);
  assert.deepStrictEqual(R[7].reasons.claims.map(c => [c.kind, c.check, c.incidental]), [['trend-blocks', false, true]]);
  assert.deepStrictEqual([R[8].category, R[8].agrees], ['unchecked', null]);

  // The summary.
  assert.deepStrictEqual(summary.categories, { right: 3, 'wrong-side entry': 0, 'bad size': 0, 'early close': 1, 'excessive abstention': 1, 'wrong stated reason': 2, 'risk-rule rejection': 1, unchecked: 1 });
  assert.deepStrictEqual(summary.agreement.overall, { decisions: 9, agree: 4, disagree: 4, unchecked: 1, rate: 0.5 });
  assert.deepStrictEqual(Object.keys(summary.agreement.byStep), ['1 hard stops', 'in a trade', 'no setup', 'take']);
  assert.deepStrictEqual(summary.agreement.byStep.take, { decisions: 3, agree: 1, disagree: 2, unchecked: 0, rate: 0.3333 });
  assert.strictEqual(summary.agreement.byStrategy.orb.decisions, 4);
  assert.deepStrictEqual([summary.trades.n, summary.trades.wins, summary.trades.sumR, summary.trades.net], [1, 1, 0.5, 18.52]);
  assert.strictEqual(summary.skipped.n, 1);
  assert.strictEqual(summary.reasons.byKind['no-attempt'].false, 1);
  assert.deepStrictEqual([summary.reasons.falseIncidental, summary.reasons.byKind['trend-blocks'].incidentalFalse, summary.reasons.incidentalWrongRate], [1, 1, 1]);
  assert.deepStrictEqual(summary.days, [{ day: DAY, decisions: 9, agree: 4, disagree: 4, balance: 100000, dayPnl: -500, floor: 97000, cushion: 3000, dailyHeadroom: 1500, balanceCheck: 'ok' }]);
  // Deterministic.
  assert.deepStrictEqual(scoreRun(runDir, { strategies: STRATS, accounts: ACCOUNTS }), { records, summary });
});

test('a reasoning-fix look hides every market outcome: no P&L, no counterfactual, no account money, no early close from the excursion', () => {
  const { runDir } = makeRun();
  const shown = scoreRun(runDir, { strategies: STRATS, accounts: ACCOUNTS });
  assert.strictEqual(shown.summary.outcomes, 'shown');
  const { records, summary } = scoreRun(runDir, { strategies: STRATS, accounts: ACCOUNTS, look: { purpose: 'reasoning-fix' } });
  assert.match(summary.outcomes, /hidden on a reasoning-fix look/);
  // The reasoning and fact failures stay; the exit judged without its excursion is unchecked, not early close.
  assert.deepStrictEqual(records.map(r => r.category), shown.records.map(r => (r.category === 'early close' ? 'unchecked' : r.category)));
  assert.deepStrictEqual(records[2].why, ['the plan or the trade\'s excursion is unknown']);
  assert.deepStrictEqual([summary.trades, summary.skipped, summary.days[0], summary.labels], [{ n: 1 }, { n: 1 }, { day: DAY, decisions: 9, agree: 4, disagree: 3 }, { noCycleWithCandidates: summary.labels.noCycleWithCandidates }]);
  assert.deepStrictEqual(records[0].facts.attempt, { account: ATTEMPT.account, status: 'active', entryBlock: null });
  // Nothing in what it writes carries an outcome field.
  const out = path.join(tmpDir(), 'sc-hidden');
  writeScorecard(runDir, { strategies: STRATS, accounts: ACCOUNTS, outDir: out, look: { purpose: 'reasoning-fix' } });
  const OUTCOME = /"(?:trade|counterfactual|counterfactuals|pacing|outcome|net|sumR|wins|losses|wouldWin|wouldLose|simulated|mfeR|maeR|balance|dayPnl|floor|cushion|profit|dailyHeadroom|softHeadroom|noCycleWouldWin|noCycleWouldLose)"\s*:/;
  for (const f of ['scorecard.jsonl', 'scorecard-summary.json', 'flagged.jsonl', 'flagged.md', 'scorecard.md']) {
    const text = fs.readFileSync(path.join(out, f), 'utf8');
    assert.doesNotMatch(text, OUTCOME, f);
    assert.doesNotMatch(text, /\$\s?-?\d/, `${f}: no dollar amount, not even in a reason or the model's own words`);
  }
  assert.match(fs.readFileSync(path.join(out, 'scorecard.jsonl'), 'utf8'), /the daily soft limit \(\$…\) is reached/, 'the kind of reason stays');
  const md = fs.readFileSync(path.join(out, 'scorecard.md'), 'utf8');
  assert.doesNotMatch(md, /would have won|\$-?\d|## Account by day|day P&L/);
  assert.match(md, /1 trades, 1 skipped setups; their outcomes and the account are hidden/);
});

test('scoreRun: without bars the room and read are unknown, so the expectation is unchecked, never guessed', () => {
  const { runDir } = makeRun({ withBars: false });
  const { records } = scoreRun(runDir, { strategies: STRATS, accounts: ACCOUNTS });
  assert.deepStrictEqual([records[0].facts.setups[0].room, records[0].facts.setups[0].alignment], [null, null]);
  assert.deepStrictEqual([records[0].expected.decision, records[0].category], ['unchecked', 'unchecked']);
  // The skip verdict (step 1) still decides without them.
  assert.deepStrictEqual([records[5].expected.decision, records[5].expected.decidedBy], ['no-trade', 1]);
});

test('writeScorecard: writes the records, the summary and the report; an unfinished run only outside its run home', () => {
  const { runDir, home } = makeRun();
  const { file, summary } = writeScorecard(runDir, { strategies: STRATS, accounts: ACCOUNTS });
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 9);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'scorecard-summary.json'), 'utf8')), JSON.parse(JSON.stringify(summary)));
  const md = fs.readFileSync(path.join(runDir, 'scorecard.md'), 'utf8');
  for (const h of ['# Adherence scorecard: sc1', '## Agreement by priority-order step', '## Agreement by strategy', '## Failure categories', '## Stated reasons', '## Trades and skipped setups', '## Account by day', '## Flagged decisions']) assert.ok(md.includes(h), h);
  assert.match(md, /\| excessive abstention \| medium \| take prop_portfolio \| none \|/);
  assert.strictEqual(fs.readFileSync(path.join(runDir, 'flagged.jsonl'), 'utf8').trim().split('\n').length, 5, 'the flagged decisions: one per failure');
  assert.throws(() => writeScorecard(runDir, { root: home }), /inside the repository/);

  const open = makeRun({ finished: false });
  assert.throws(() => writeScorecard(open.runDir, { strategies: STRATS }), /is not finished .*write the scorecard outside the run home with --out/);
  assert.throws(() => writeScorecard(open.runDir, { strategies: STRATS, outDir: path.join(open.home, 'x') }), /inside the run home/);
  const out = path.join(tmpDir(), 'sc-out');
  const res = writeScorecard(open.runDir, { strategies: STRATS, accounts: ACCOUNTS, outDir: out });
  assert.ok(res.summary.unfinished);
  assert.ok(fs.existsSync(path.join(out, 'scorecard.md')));
  assert.ok(!fs.existsSync(path.join(open.runDir, 'scorecard.jsonl')));
});

test('scoreRun: a candidate the model could not trade (a paper strategy) is no setup', () => {
  const strategies = [...STRATS, { name: 'ofi', valid: true, signal: 'rules', mtf: 'trend', status: 'paper', risk: { min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } }];
  const { runDir } = makeRun({ steps: [{ k: 0, scan: [{ name: 'ofi', candidate: true, direction: 'long', stopDistance: 10, mtf: MTF }], cycle: { result: 'CYCLE RESULT: no-trade - no candidate strategies' } }] });
  const { records } = scoreRun(runDir, { strategies, accounts: ACCOUNTS });
  assert.deepStrictEqual([records[0].facts.setups, records[0].expected.decidedBy, records[0].category], [[], 'no setup', 'right']);
});

test('replay.js scorecard: the CLI writes the scorecard and prints its summary', () => {
  const { runDir } = makeRun();
  const env = { PATH: process.env.PATH, HOME: path.dirname(runDir), FTH_HOME: path.dirname(runDir) };
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'replay.js'), 'scorecard', runDir], { env, encoding: 'utf8' });
  assert.match(out, /9 decisions: agreement/);
  assert.match(out, /wrote .*scorecard\.jsonl, scorecard-summary\.json, scorecard\.md, flagged\.jsonl and flagged\.md/);
  assert.ok(fs.existsSync(path.join(runDir, 'scorecard.md')));
});

// ------------------------------------------------------------------------------------------------
// Review findings

test('an entry is judged against the setup it traded, not the best setup on the bar', () => {
  const orb = setup({ name: 'orb', component: null, policy: false, verdict: null });
  const keltner = setup({ name: 'keltner', component: null, policy: false, verdict: null, alignment: 'counter', room: { inTheWay: { name: 'prior day low', R: 0.3 }, needR: 2 } });
  const f = facts({ setups: [orb, keltner] });
  const enter = name => { const l = entry('short', 1, undefined, name); return classify(l, f, expectedForEntry(f, name, 'short'), checkReasons('CYCLE RESULT: executed', f)); };
  // keltner's counter read says no trade, though orb's setup passes.
  assert.deepStrictEqual([expectedForEntry(f, 'keltner', 'short').decidedBy, enter('keltner').category], [4, 'bad size']);
  // Its room alone (a level 0.3R ahead) never says no trade: the entry on it is right.
  const near = facts({ setups: [orb, { ...keltner, alignment: 'aligned' }] });
  assert.deepStrictEqual([expectedForEntry(near, 'keltner', 'short').decidedBy, classify(entry('short', 1, undefined, 'keltner'), near, expectedForEntry(near, 'keltner', 'short'), checkReasons('CYCLE RESULT: executed', near)).category], ['take', 'right']);
  assert.strictEqual(enter('orb').category, 'right');
  // A setup tag the bar has no setup for: unchecked.
  assert.deepStrictEqual([expectedForEntry(f, 'vwap_reclaim', 'short').decidedBy, enter('vwap_reclaim').category], ['no matching setup', 'unchecked']);
  // A policy strategy is matched by its own name, and its verdict's size is the ceiling.
  const p = facts({ setups: [setup(), setup({ name: 'orb', component: null, policy: false, verdict: null, direction: 'short', room: { inTheWay: { name: 'x', R: 0.1 }, needR: 2 } })] });
  assert.strictEqual(expectedForEntry(p, 'prop_portfolio', 'short').ceiling, 22);
  // The setup it named exists only on the other side: wrong side.
  assert.strictEqual(classify(entry('long', 1, undefined, 'keltner'), facts({ setups: [keltner, setup({ name: 'orb', component: null, policy: false, verdict: null, direction: 'long', style: 'trend', trendAllows: true })] }), expectedForEntry(f, 'keltner', 'long'), checkReasons('', f)).category, 'wrong-side entry');
});

test('an exit in a trade is early close only when the plan\'s exit is known not reached', () => {
  const exit = (outcome, extra = {}) => classify(label({ decision: 'in-trade', teacher: { action: 'exit', orders: extra.orders || [] }, clone: { ok: false, reasons: extra.reasons || [] }, outcome }), facts(), { decision: 'hold' }, checkReasons('', facts()));
  const base = { setup: 'prop_portfolio', r: 0.5, mfeR: 0.8, entryTime: '2026-06-01T14:20:00.000Z' };
  assert.strictEqual(exit(base).category, 'early close');
  // A partial exit (scale-out), by the label's reason or its tool.
  assert.strictEqual(exit(base, { reasons: ['partial exit'] }).category, 'unchecked');
  assert.strictEqual(exit(base, { orders: [{ tool: 'partial_close_position' }] }).category, 'unchecked');
  // The trail's activation reached: managing it is the plan's.
  assert.strictEqual(exit({ ...base, mfeR: 2.4, r: 1.9 }).category, 'unchecked');
  // Gave back most of a large best.
  assert.deepStrictEqual(exit({ ...base, mfeR: 1.6, r: 0.4 }).why, ['gave back most of a 1.6R best']);
  // Past the time stop: crt_1h's 40 bars of 3 minutes (120 minutes) before 14:30.
  assert.deepStrictEqual(exit({ ...base, setup: 'crt_1h', entryTime: '2026-06-01T12:20:00.000Z' }).why, ['past the time stop (40 bars)']);
  // Unknown plan or excursion: unchecked, never early close.
  assert.strictEqual(exit({ ...base, setup: 'unknown_x' }).category, 'unchecked');
  assert.strictEqual(exit({ ...base, mfeR: null }).category, 'unchecked');
});

test('room figures are read for what they say: enough room is not a no-room claim', () => {
  const f = facts({ setups: [setup()] }); // round number at 3R, needs 2R
  const enough = checkReasons('CYCLE RESULT: executed - short MNQ 11, room 3R vs 2R needed', f);
  assert.deepStrictEqual(enough.claims.map(c => [c.kind, c.check, c.asserts]), [['room', true, 'enough']]);
  const tight = facts({ setups: [setup({ room: { inTheWay: { name: 'prior VAL', R: 0.5 }, needR: 2 } })] });
  assert.strictEqual(checkReasons('CYCLE RESULT: executed - room 3R vs 2R needed', tight).claims[0].check, false);
  assert.deepStrictEqual(checkReasons('CYCLE RESULT: no-trade - 0.03R vs 2R needed', tight).claims.map(c => [c.kind, c.check]), [['no-room', true]]);
  // A distance alone against the first level in its way; a need alone against what it needs.
  assert.strictEqual(checkReasons('CYCLE RESULT: executed - first level 3R away', f).claims[0].check, true);
  assert.strictEqual(checkReasons('CYCLE RESULT: executed - first level 1R away', f).claims[0].check, false);
  assert.strictEqual(checkReasons('CYCLE RESULT: executed - it needs 2R', f).claims[0].check, true);
  // A true "enough room" is no ground to skip.
  assert.strictEqual(classify(label(), f, expectedDecision(f), checkReasons('CYCLE RESULT: no-trade - room 3R vs 2R needed', f)).category, 'excessive abstention');
});

test('a take whose judgment steps can still say no trade is never scored right or wrong on the decision', () => {
  // A rules candidate (no verdict size) with a mixed read: half of an unknown size could be 0.
  const unknownHalf = facts({ setups: [setup({ name: 'keltner', component: null, policy: false, verdict: null, alignment: 'mixed' })] });
  const e = expectedDecision(unknownHalf);
  assert.deepStrictEqual([e.decision, e.couldSkip], ['take', [4]]);
  assert.deepStrictEqual(classify(label(), unknownHalf, e, checkReasons('CYCLE RESULT: no-trade', unknownHalf)), { category: 'unchecked', agrees: null, why: ['step 4 is judgment that can say no trade'] });
  // With a false decision-relevant reason, the reason is still wrong.
  assert.deepStrictEqual(classify(label(), unknownHalf, e, checkReasons('CYCLE RESULT: no-trade - no candidate strategies', unknownHalf)).category, 'wrong stated reason');
  // A known size halves without a judgment: a skip there is still abstention.
  assert.deepStrictEqual(expectedDecision(facts({ setups: [setup({ alignment: 'mixed' })] })).couldSkip, []);
  // A pullback (step 4) and a reversal fading the trend (step 2): a skip and an entry are unchecked on that step.
  const pull = facts({ setups: [setup({ alignment: 'pullback' })] });
  assert.deepStrictEqual(expectedDecision(pull).couldSkip, [4]);
  assert.strictEqual(classify(label(), pull, expectedDecision(pull), checkReasons('CYCLE RESULT: no-trade', pull)).category, 'unchecked');
  assert.deepStrictEqual(classify(entry('short', 5), pull, expectedForEntry(pull, 'prop_portfolio', 'short'), checkReasons('', pull)).category, 'unchecked');
  const fade = facts({ setups: [setup({ style: 'reversal', direction: 'long', vwapSide: 'above' })] });
  assert.deepStrictEqual(expectedDecision(fade).couldSkip, [2]);
  assert.strictEqual(classify(entry('long', 5), fade, expectedForEntry(fade, 'prop_portfolio', 'long'), checkReasons('', fade)).category, 'unchecked');
  // Over the ceiling is bad size even so.
  assert.strictEqual(classify(entry('long', 12), fade, expectedForEntry(fade, 'prop_portfolio', 'long'), checkReasons('', fade)).category, 'bad size');
});

test('a false claim about a setup the bar did not have is incidental: reported, never the category', () => {
  const none = facts();
  const r = checkReasons('CYCLE RESULT: no-trade - no candidate strategies, prevailing 15m down trend blocks all trend-following setups', none);
  assert.deepStrictEqual(r.claims.map(c => [c.kind, c.check, c.incidental]), [['nothing-fired', true, false], ['trend-blocks', false, true]]);
  assert.strictEqual(classify(label(), none, expectedDecision(none), r).category, 'right');
  // About a side no setup is on: incidental too; about the setup's own side: relevant.
  const shortOnly = facts({ setups: [setup({ room: { inTheWay: { name: 'x', R: 0.2 }, needR: 2 } })], trendRule: { prevailing: '15m up', long: true, short: false } });
  assert.strictEqual(checkReasons('CYCLE RESULT: no-trade - 15m up trend blocks longs', shortOnly).claims[0].incidental, true);
  const own = checkReasons('CYCLE RESULT: no-trade - keltner short blocked by 15m down trend rule', facts({ setups: [setup({ room: { inTheWay: { name: 'x', R: 0.2 }, needR: 2 } })] }));
  assert.deepStrictEqual([own.claims[0].check, own.claims[0].incidental], [false, false]);
});

test('scoreRun: an entry\'s expectation is the setup it traded, though another setup on the bar ranks higher', () => {
  const strategies = [...STRATS, { name: 'ema_cross', valid: true, signal: 'rules', mtf: 'trend', status: 'active', risk: { min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } }];
  const order = { tool: 'place_order', input: { ...LONG.input, size: 1, rationale: 'setup:ema_cross long breakout, stop 20523.5' } };
  const scan = [...policyScan(), { name: 'ema_cross', candidate: true, direction: 'long', stopDistance: 10, mtf: MTF }];
  const { runDir } = makeRun({ steps: [{ k: 0, scan, verdict: true, cycle: { orders: [order], result: 'CYCLE RESULT: executed - ema_cross long 1' } }] });
  const { records } = scoreRun(runDir, { strategies, accounts: ACCOUNTS });
  assert.deepStrictEqual([records[0].expected.setup, records[0].expected.ceiling, records[0].category], ['ema_cross', null, 'right']);
});

// ------------------------------------------------------------------------------------------------
// Review round 2

test('a skip is judged against a clean take when the bar has one, whatever the scan order', () => {
  const keltner = setup({ name: 'keltner', component: null, policy: false, verdict: null, alignment: 'mixed' }); // unknown size, halved: couldSkip [4]
  const orb = setup({ name: 'orb', component: null, policy: false, verdict: null }); // a clean take
  for (const setups of [[keltner, orb], [orb, keltner]]) {
    const f = facts({ setups });
    const e = expectedDecision(f);
    assert.deepStrictEqual([e.setup, e.couldSkip], ['orb', []]);
    assert.strictEqual(classify(label(), f, e, checkReasons('CYCLE RESULT: no-trade', f)).category, 'excessive abstention');
  }
  // Every take can be turned down: the skip is unchecked, in either order.
  const keltner2 = setup({ name: 'orb', component: null, policy: false, verdict: null, alignment: 'pullback' });
  for (const setups of [[keltner, keltner2], [keltner2, keltner]]) {
    const f = facts({ setups });
    assert.strictEqual(classify(label(), f, expectedDecision(f), checkReasons('CYCLE RESULT: no-trade', f)).category, 'unchecked');
  }
});

test('a true claim excuses a skip only when it bears on the setup the order says take', () => {
  const keltner = setup({ name: 'keltner', component: null, policy: false, verdict: null });
  // True but incidental: the trend rule blocks longs; the take is short.
  const f = facts({ setups: [keltner] });
  const longs = checkReasons('CYCLE RESULT: no-trade - 15m down trend blocks longs', f);
  assert.deepStrictEqual(longs.claims.map(c => [c.check, c.incidental]), [[true, true]]);
  assert.strictEqual(classify(label(), f, expectedDecision(f), longs).category, 'excessive abstention');
  // True, about another setup: orb short has no room; keltner short has.
  const g = facts({ setups: [keltner, setup({ name: 'orb', component: null, policy: false, verdict: null, room: { inTheWay: { name: 'prior VAL', R: 0.4 }, needR: 2 } })] });
  const other = checkReasons('CYCLE RESULT: no-trade - orb short has insufficient room', g);
  assert.deepStrictEqual(other.claims.map(c => [c.kind, c.check, c.about]), [['no-room', true, 'orb']]);
  assert.strictEqual(classify(label(), g, expectedDecision(g), other).category, 'excessive abstention');
  // True and not incidental (a long setup is on the bar, its verdict skip), but about the other side: no ground.
  const sides = facts({ setups: [keltner, setup({ name: 'orb', component: null, policy: false, candidate: false, direction: 'long', verdict: { action: 'skip', maxSize: 0 } })] });
  const blocks = checkReasons('CYCLE RESULT: no-trade - 15m down trend blocks longs', sides);
  assert.deepStrictEqual(blocks.claims.map(c => [c.check, c.incidental]), [[true, false]]);
  assert.strictEqual(classify(label(), sides, expectedDecision(sides), blocks).category, 'excessive abstention');
  // About the setup itself, or its side: a ground (the facts missed it: unchecked).
  const own = facts({ setups: [setup({ name: 'keltner', component: null, policy: false, verdict: null, trendAllows: true })], trendRule: { prevailing: '15m up', long: true, short: false } });
  assert.strictEqual(classify(label(), own, expectedDecision(own), checkReasons('CYCLE RESULT: no-trade - 15m up trend blocks shorts', own)).category, 'unchecked');
  // keltner's own room, stated short while its record says enough: a false reason, not a ground.
  assert.strictEqual(classify(label(), g, expectedDecision(g), checkReasons('CYCLE RESULT: no-trade - keltner insufficient room', g)).category, 'excessive abstention');  // Unverifiable, about another setup (orb's room unknown): no more a ground than a true one.
  const unknown = facts({ setups: [keltner, setup({ name: 'orb', component: null, policy: false, verdict: null, room: null })] });
  const vague = checkReasons('CYCLE RESULT: no-trade - orb short insufficient room', unknown);
  assert.ok(vague.claims.some(c => c.check === 'unchecked'), JSON.stringify(vague.claims));
  assert.strictEqual(classify(label(), unknown, expectedDecision(unknown), vague).category, 'excessive abstention');
});

test('"no room concerns" is not a room shortage', () => {
  const f = facts({ setups: [setup()] });
  for (const text of ['no room concerns', 'no room issue', 'no room problems']) assert.deepStrictEqual(checkReasons(`CYCLE RESULT: executed - short, ${text}`, f).claims, [], text);
  assert.strictEqual(checkReasons('CYCLE RESULT: no-trade - no room to the level', f).claims[0].kind, 'no-room');
});

test('the window at a decision allows entries only by its own field: the opening print, into the close and the daily break never do', () => {
  const { windowAt, checkReasons } = require('../../scripts/lib/replay/scorecard');
  const at = iso => Date.parse(iso);
  assert.deepStrictEqual([windowAt(at('2026-06-01T13:32:02Z')).name, windowAt(at('2026-06-01T13:32:02Z')).entriesAllowed], ['opening print', false]);
  assert.strictEqual(windowAt(at('2026-06-01T13:36:02Z')).entriesAllowed, true, 'the opening drive');
  assert.strictEqual(windowAt(at('2026-06-01T19:47:02Z')).entriesAllowed, false, 'into the close');
  assert.strictEqual(windowAt(at('2026-06-01T21:30:00Z')).entriesAllowed, false, 'the daily break');
  // A true "opening print, no entries" reason at 09:32 is true, not false.
  const f = { window: windowAt(at('2026-06-01T13:32:02Z')), scanned: true, setups: [], trendRule: { prevailing: null, long: null, short: null }, attempt: null, styleOf: () => null };
  const r = checkReasons('CYCLE RESULT: no-trade - opening print window until 09:35 ET', f);
  assert.ok(r.claims.length && r.claims.every(c => c.check === true), JSON.stringify(r.claims));
});

test('scoreRun: the news at each decision is a fact, so a true "no entries until" a blackout\'s end is not scored false', () => {
  const { home, runDir } = makeRun();
  const t0 = Date.parse(scoreRun(runDir, { strategies: STRATS, accounts: ACCOUNTS }).records[0].facts.t);
  fs.mkdirSync(path.join(home, 'blackouts'), { recursive: true });
  fs.writeFileSync(path.join(home, 'blackouts', 'blackouts.json'), JSON.stringify([{ start: new Date(t0 - 60000).toISOString(), end: new Date(t0 + 300000).toISOString(), reason: 'CPI' }]));
  const f = scoreRun(runDir, { strategies: STRATS, accounts: ACCOUNTS }).records[0].facts;
  assert.deepStrictEqual([f.news.inBlackout, f.news.reason], [true, 'CPI']);
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade - no entries until the CPI blackout ends', f), 'no-entry-window'), undefined, 'no time: not a window claim');
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade - in a news blackout', f), 'no-entry-window').check, true);
});

// ------------------------------------------------------------------------------------------------
// A composed setup (trade_lifecycle): judged on its own compose record, never the strategy priority order

/** A compose record as the cycle log keeps it (lifecycle-runner.js recordSummary): MNQ long, 111-tick stop, 231-tick target, size 1. */
const composedRec = (over = {}) => ({
  id: 'rec1', side: 'long', bar: iso(barOf(0)), ok: true, signature: 'bias:1h-bos-up', skillSignature: 'bias:bos-vs-choch', symbol: 'MNQ', contract: 'MNQ', lane: '3m', context: null,
  entry: 20540.25, tick: 0.25, tickValue: 0.5, size: 1, stop: 20512.5, target: 20598, rr: 2.08, inTheWay: null,
  reads: [{ step: 'bias', skill: 'bos-vs-choch', read: '1h bos up', check: true, agrees: true }], problems: 0, ...over,
});

test('the scorecard says it grades composed setups (the training preflight reads it)', () => {
  assert.strictEqual(require('../../scripts/lib/replay/scorecard').SCORES_COMPOSED, true);
});

test('a composed entry is graded on its own record: right at its size, bad size over it, no setup without an OK record', () => {
  const { composedSetup, composedSetupsFrom } = require('../../scripts/lib/trading/reasons');
  const s = composedSetup(composedRec(), { window: WINDOW.drive });
  const f = facts({ setups: [s] });
  const enter = (side, size, fx = f, tag = 'trade_lifecycle') => classify(entry(side, size, undefined, tag), fx, expectedForEntry(fx, tag, side), checkReasons('CYCLE RESULT: executed', fx));
  const e = expectedForEntry(f, 'trade_lifecycle', 'long');
  assert.deepStrictEqual([e.decision, e.ceiling, e.decidedBy, e.composed, e.couldSkip], ['take', 1, 'take', 'rec1', []]);
  assert.deepStrictEqual(e.steps.map(x => x.name), ['hard stops', 'bos-vs-choch', 'plan'], 'its reads and plan, no strategy priority step');
  assert.deepStrictEqual(enter('long', 1), { category: 'right', agrees: true, why: [] });
  assert.deepStrictEqual(enter('long', 2), { category: 'bad size', agrees: false, why: ['2 over the ceiling 1'] });
  assert.strictEqual(enter('short', 1).category, 'wrong-side entry');
  // Judged on its record though the scan was not logged; a no-entry window is step 1's no trade.
  assert.strictEqual(enter('long', 1, facts({ scanned: false, setups: [s] })).category, 'right');
  const opening = facts({ window: WINDOW.opening, setups: [composedSetup(composedRec(), { window: WINDOW.opening })] });
  assert.deepStrictEqual([enter('long', 1, opening).category, enter('long', 1, opening).why], ['bad size', ['the order says no trade (step 1)']]);
  // A record that is not OK is no setup: an entry on it is a bad size, a pass right.
  assert.strictEqual(composedSetup(composedRec({ ok: false })), null);
  const none = facts({ setups: [] });
  assert.deepStrictEqual([enter('long', 1, none).category, enter('long', 1, none).why], ['bad size', ['the order says no trade (no setup)']]);
  // An entry tagged with a policy that lists it is on it: its own setup, so a scan's trend rule for the policy's style
  // never makes it a wrong side (the gate judges a composed entry against the trend by its reads).
  const viaPolicy = facts({ trendRule: { prevailing: '15m down', long: false, short: true }, styleOf: n => (n === 'prop_composed' ? 'trend' : null), setups: [composedSetup(composedRec(), { window: WINDOW.drive, aliases: ['prop_composed'] })] });
  assert.deepStrictEqual(enter('long', 1, viaPolicy, 'prop_composed'), { category: 'right', agrees: true, why: [] });
  assert.strictEqual(enter('short', 1, viaPolicy, 'prop_composed').category, 'wrong-side entry');
  // A rules entry beside a compose record is judged on the scan's setups alone: no scan, unchecked; none fired, no setup
  // (never the record's side or size).
  assert.deepStrictEqual([expectedForEntry(facts({ scanned: false, setups: [s] }), 'orb', 'long').decidedBy, expectedForEntry(f, 'orb', 'long').decidedBy], ['no scan', 'no setup']);
  assert.deepStrictEqual(enter('short', 1, f, 'orb').why, ['the order says no trade (no setup)']);
  // A pass beside a rules take a judgment step can turn down is judged on that take first (unchecked), not made right
  // by the record.
  const pull = facts({ setups: [setup({ alignment: 'pullback' }), s] });
  assert.strictEqual(expectedDecision(pull).setup, 'prop_portfolio');
  // A policy verdict that sized the record lowers the ceiling to its size.
  const sized = facts({ setups: [{ ...composedSetup(composedRec({ size: 3 })), verdict: { action: 'full', maxSize: 2 } }] });
  assert.strictEqual(expectedForEntry(sized, 'trade_lifecycle', 'long').ceiling, 2);
  // An entry under a composed tag with no OK record on its side has no setup, whatever rules setups the scan has.
  const rulesOnly = facts({ setups: [setup({ name: 'orb', component: null, policy: false, verdict: null, direction: 'short' })], composedTags: ['trade_lifecycle', 'prop_composed'] });
  assert.deepStrictEqual(enter('long', 1, rulesOnly).why, ['the order says no trade (no setup)']);
  assert.deepStrictEqual(enter('short', 1, rulesOnly, 'prop_composed').why, ['the order says no trade (no setup)']);
  // A rules setup named after a policy the entry's tag maps to the composed setup is not its own: on the other side it
  // never makes the entry a wrong side (nor throws), on its side its trend rule is not the entry's.
  const policyRules = over => setup({ name: 'prop_composed', component: 'keltner', ...over });
  const crossed = facts({ composedTags: ['trade_lifecycle', 'prop_composed'], setups: [policyRules({ direction: 'short' })] });
  assert.deepStrictEqual(enter('long', 1, crossed, 'prop_composed').why, ['the order says no trade (no setup)']);
  const beside = facts({ composedTags: ['trade_lifecycle', 'prop_composed'], setups: [policyRules({ direction: 'long', trendAllows: false }), composedSetup(composedRec(), { aliases: ['prop_composed'] })] });
  assert.deepStrictEqual(enter('long', 1, beside, 'prop_composed'), { category: 'right', agrees: true, why: [] });
  // The scan's trend rule is not a composed entry's (the gate judges it by its reads): with no record, no setup.
  const trendDown = facts({ trendRule: { prevailing: '15m down', long: false, short: true }, styleOf: () => 'trend', setups: [] });
  assert.deepStrictEqual(enter('long', 1, trendDown).why, ['the order says no trade (no setup)']);
  // A record naming no contract is on none.
  assert.deepStrictEqual(composedSetupsFrom([composedRec({ symbol: null, contract: null })], { root: 'MNQ' }), []);
  // A composed setup is no confluence against a rules setup on the other side.
  const both = facts({ setups: [setup(), s] });
  assert.strictEqual(expectedForEntry(both, 'prop_portfolio', 'short').decision, 'take');
});

test('a composed pass: right with no OK record; on one (a valid setup) excessive abstention without a decisive reason; a wrong stated reason when false', () => {
  const { composedSetup, composedSetupsFrom } = require('../../scripts/lib/trading/reasons');
  // The latest record per side is the one that counts (the gate judges it): an OK one then a failed one is no setup.
  assert.deepStrictEqual(composedSetupsFrom([composedRec(), composedRec({ id: 'rec2', ok: false })]), []);
  assert.deepStrictEqual(composedSetupsFrom([composedRec({ ok: false }), composedRec({ id: 'rec2' })]).map(x => x.composed.record), ['rec2']);
  // Its room is the record's: the first level in the way against the plan's R:R (an older record without it: unknown).
  assert.deepStrictEqual(composedSetup(composedRec({ inTheWay: { name: 'prior 1h high', price: 20560, R: 0.71 } })).room, { inTheWay: { name: 'prior 1h high', R: 0.71 }, needR: 2.08 });
  const { inTheWay: _w, ...older } = composedRec();
  assert.strictEqual(composedSetup(older).room, null);
  const none = facts();
  assert.deepStrictEqual(run(label(), none, 'CYCLE RESULT: no-trade - compose record not OK'), { category: 'right', agrees: true, why: [] });
  const f = facts({ setups: [composedSetup(composedRec(), { window: WINDOW.drive })] });
  // A valid setup is the trade (fix/confluence-not-vetoes): a pass on soft reads is excessive abstention; a decisive one
  // (a reversal, which no claim checks) is unchecked; a false reason stays a wrong stated reason.
  assert.deepStrictEqual(run(label(), f, 'CYCLE RESULT: no-trade - the reads are thin, passing'), { category: 'excessive abstention', agrees: false, why: ['a valid setup (the verified compose record rec1) passed without a decisive reason'] });
  assert.deepStrictEqual(run(label(), f, 'CYCLE RESULT: no-trade - the 3m close broke the 15m swing low: a reversal').category, 'unchecked');
  assert.strictEqual(run(label(), f, 'CYCLE RESULT: no-trade - opening print window until 10:00 ET').category, 'wrong stated reason');
  // "No rules strategy fired" (the runner's own words) stays true beside a composed setup: it is no strategy that fired.
  // ...but it is no reason to pass the composed setup beside it.
  assert.deepStrictEqual(run(label(), f, 'CYCLE RESULT: no-trade - no rules strategy fired, passing').category, 'excessive abstention');
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade - no candidate strategies', f), 'nothing-fired').check, true);
  // No scan logged: the rules setups are unknown, so a pass beside a record is not judged (an entry on it still is).
  assert.deepStrictEqual(run(label(), facts({ scanned: false, setups: f.setups }), 'CYCLE RESULT: no-trade - passing').category, 'unchecked');
  // An unknown rules setup ranks before the record: the pass is not made right by knowing less.
  assert.strictEqual(run(label(), facts({ setups: [setup({ room: null }), ...f.setups] }), 'CYCLE RESULT: no-trade - passing').category, 'unchecked');
  assert.strictEqual(run(label(), facts({ scanned: false }), 'CYCLE RESULT: no-trade - passing').category, 'unchecked');
  // News that can't be read blocks it as it blocks a candidate; a record on another contract (by its contract when it
  // names no symbol) is no setup for this one.
  assert.match(composedSetup(composedRec(), { news: { inBlackout: null, error: 'the blackouts file can\'t be read' } }).blocked, /^news unknown/);
  assert.strictEqual(composedSetup(composedRec(), { news: { inBlackout: false } }).blocked, null);
  assert.deepStrictEqual(composedSetupsFrom([composedRec({ symbol: null, contract: 'NQ' })], { root: 'MNQ' }), []);
  assert.strictEqual(composedSetupsFrom([composedRec({ symbol: null, contract: 'MNQ' })], { root: 'MNQ' }).length, 1);
});

test('scoreRun and labels: a composed limit entry at its record is right with no clone reason; over its size is bad size; a pass without an OK record is right', () => {
  const { labelRun } = require('../../scripts/lib/replay/labels');
  const order = (limitPrice, size, tag = 'trade_lifecycle') => ({ tool: 'place_order', input: { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'limit', limitPrice, size, stopLossBracket: { ticks: 111, type: 'stop' }, takeProfitBracket: { ticks: 231, type: 'limit' }, rationale: `setup:${tag} long composed` } });
  const steps = [
    { k: 0, scan: quietScan, cycle: { composed: [composedRec()], orders: [order(20540.25, 1)], result: 'CYCLE RESULT: executed - trade_lifecycle long 1 MNQ' } },
    { k: 1, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec2', bar: iso(barOf(1)) })], orders: [order(20541, 2)], result: 'CYCLE RESULT: executed - trade_lifecycle long 2 MNQ' } },
    { k: 2, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec3', bar: iso(barOf(2)), ok: false })], result: 'CYCLE RESULT: no-trade - compose record not OK' } },
    { k: 3, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec4', bar: iso(barOf(3)) })], result: 'CYCLE RESULT: no-trade - passing' } },
    // Another bar's record is not this bar's setup.
    { k: 4, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec5', bar: iso(barOf(3)) })], result: 'CYCLE RESULT: no-trade - passing' } },
    // In an attempt the entry is tagged with the policy that lists trade_lifecycle: the composed setup, by the policy's own list.
    { k: 5, scan: quietScan, policyVerdict: { strategy: 'prop_composed', component: 'trade_lifecycle', record: 'rec6' }, cycle: { composed: [composedRec({ id: 'rec6', bar: iso(barOf(5)) })], orders: [order(20540.25, 1, 'prop_composed')], result: 'CYCLE RESULT: executed - prop_composed long 1 MNQ' } },
    { k: 6, scan: quietScan, policyVerdict: { strategy: 'prop_composed', component: 'trade_lifecycle', record: 'rec7' }, cycle: { composed: [composedRec({ id: 'rec7', bar: iso(barOf(6)) })], orders: [order(20540.25, 2, 'prop_composed')], result: 'CYCLE RESULT: executed - prop_composed long 2 MNQ' } },
    // A policy that doesn't list it is no tag of it.
    { k: 7, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec8', bar: iso(barOf(7)) })], orders: [order(20540.25, 1, 'prop_portfolio')], result: 'CYCLE RESULT: executed - prop_portfolio long 1 MNQ' } },
    // Another family's later record is not this one's; another contract of the family's later record is the latest (the
    // gate's), on another contract: no setup. A limit better than the record's entry is the plan's own order type.
    { k: 8, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec9', bar: iso(barOf(8)) }), composedRec({ id: 'mes', symbol: 'MES', contract: 'MES', bar: iso(barOf(8)) })], orders: [order(20540.25, 1)], result: 'CYCLE RESULT: executed' } },
    { k: 9, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec10', bar: iso(barOf(9)) }), composedRec({ id: 'nq', symbol: 'NQ', contract: 'NQ', bar: iso(barOf(9)) })], orders: [order(20540.25, 1)], result: 'CYCLE RESULT: executed' } },
    { k: 10, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec11', bar: iso(barOf(10)) })], orders: [order(20539.5, 1)], result: 'CYCLE RESULT: executed' } },
    // The policy's verdict on this bar trades another component: its entry is not the composed one (the gate's rule).
    { k: 11, scan: quietScan, policyVerdict: { strategy: 'prop_composed', component: 'orb' }, cycle: { composed: [composedRec({ id: 'rec12', bar: iso(barOf(11)) })], orders: [order(20540.25, 1, 'prop_composed')], result: 'CYCLE RESULT: executed' } },
    // A refused compose call (no bar) after the OK record is on no bar: the OK record still stands.
    { k: 12, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec13', bar: iso(barOf(12)) }), composedRec({ id: 'refused', bar: null, ok: false })], orders: [order(20540.25, 1)], result: 'CYCLE RESULT: executed' } },
    // An entry on another contract of the family, on its own record: graded on it (the gate checks the order's contract).
    { k: 14, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec15', symbol: 'NQ', contract: 'NQ', bar: iso(barOf(14)) })], orders: [{ ...order(20540.25, 1), input: { ...order(20540.25, 1).input, contractId: 'NQ' } }], result: 'CYCLE RESULT: executed' } },
    // The policy's verdict on the record skips it: a hard stop, so the entry is a bad size.
    { k: 15, scan: quietScan, policyVerdict: { strategy: 'prop_composed', component: 'trade_lifecycle', record: 'rec16', action: 'skip', maxSize: 0 }, cycle: { composed: [composedRec({ id: 'rec16', bar: iso(barOf(15)) })], orders: [order(20540.25, 1, 'prop_composed')], result: 'CYCLE RESULT: executed' } },
    // A refused try (on another contract, or under another tag) before the allowed entry: the counted entry is the one graded.
    { k: 16, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec17', bar: iso(barOf(16)) })], orders: [{ ...order(20540.25, 1), input: { ...order(20540.25, 1).input, contractId: 'NQ' }, gate: { decision: 'blocked', violations: [{ check: 'composed-reads', message: 'the record is for MNQ' }] } }, order(20540.25, 1)], result: 'CYCLE RESULT: executed' } },
    { k: 17, scan: [{ name: 'orb', candidate: true, direction: 'short', stopDistance: 10, mtf: MTF }], cycle: { composed: [composedRec({ id: 'rec18', bar: iso(barOf(17)) })], orders: [{ ...order(20540.25, 1, 'orb'), gate: { decision: 'blocked', violations: [{ check: 'trigger-fired', message: 'no' }] } }, order(20540.25, 1)], result: 'CYCLE RESULT: executed' } },
    // The latest of the policy's verdicts on the bar and family, in the order written (MNQ, NQ, MNQ again): composed.
    { k: 18, scan: quietScan, policyVerdicts: [{ strategy: 'prop_composed', component: 'trade_lifecycle', record: 'rec19' }, { strategy: 'prop_composed', component: 'orb', symbol: 'NQ', contractId: 'NQ', contract: 'NQ' }, { strategy: 'prop_composed', component: 'trade_lifecycle', record: 'rec19' }], cycle: { composed: [composedRec({ id: 'rec19', bar: iso(barOf(18)) })], orders: [order(20540.25, 1, 'prop_composed')], result: 'CYCLE RESULT: executed' } },
    // A limit off the tick and worse than the record's entry (the gate refuses it) is no plan's own order type.
    { k: 13, scan: quietScan, cycle: { composed: [composedRec({ id: 'rec14', bar: iso(barOf(13)) })], orders: [order(20540.3, 1)], result: 'CYCLE RESULT: executed' } },
    { t: Date.parse(`${DAY}T20:50:02Z`), kind: 'eod' },
  ];
  const strategies = [...STRATS, { name: 'trade_lifecycle', valid: true, signal: 'composed', status: 'active', timeframe: '3m', risk: { min_rr: 2, max_risk_usd: 200 } },
    { name: 'prop_composed', valid: true, signal: 'policy', status: 'active', timeframe: '3m', strategies: ['trade_lifecycle'] }];
  const { runDir } = makeRun({ steps });
  const { records } = scoreRun(runDir, { strategies, accounts: ACCOUNTS });
  // k 3: a pass on its OK record (a valid setup) with no decisive reason is excessive abstention (fix/confluence-not-vetoes).
  // k 4: another bar's record is no setup of this bar, but its briefing holds a composable setup it passed without
  // compose_check: excessive abstention too (no compose).
  assert.deepStrictEqual(records.map(r => r.category), ['right', 'bad size', 'right', 'excessive abstention', 'excessive abstention', 'right', 'bad size', 'bad size', 'right', 'bad size', 'right', 'bad size', 'right', 'right', 'right', 'bad size', 'right', 'right', 'right']);
  assert.deepStrictEqual(records[18].expected.composed, 'rec19');
  assert.deepStrictEqual([records[16].expected.composed, records[17].expected.composed], ['rec17', 'rec18']);
  assert.deepStrictEqual([records[14].expected.composed, records[15].expected.decidedBy, records[15].why], ['rec15', 1, ['the order says no trade (step 1)']]);
  assert.deepStrictEqual([records[11].expected.decidedBy, records[12].expected.composed], ['no setup', 'rec13']);
  assert.deepStrictEqual([records[8].expected.composed, records[9].expected.decidedBy], ['rec9', 'no setup']);
  // A bar whose only setup is composed needs no rebuilt briefing.
  assert.strictEqual(records[0].data.rebuilt, null);
  assert.deepStrictEqual([records[5].expected.composed, records[6].why, records[7].expected.decidedBy], ['rec6', ['2 over the ceiling 1'], 'no setup']);
  // Without the policy's list nothing maps it.
  const bare = scoreRun(runDir, { strategies: strategies.filter(x => x.name !== 'prop_composed'), accounts: ACCOUNTS }).records;
  assert.deepStrictEqual([bare[5].category, bare[5].expected.decidedBy], ['bad size', 'no setup']);
  assert.deepStrictEqual([records[0].expected.composed, records[0].expected.ceiling, records[0].facts.setups.map(s => `${s.name} ${s.direction}`)], ['rec1', 1, ['trade_lifecycle long']]);
  assert.deepStrictEqual(records[1].why, ['2 over the ceiling 1']);
  assert.deepStrictEqual([records[2].expected.decidedBy, records[4].expected.decidedBy], ['no setup', 'no setup']);
  // The labels: the record's limit and target are the plan's own; a limit off the record's entry still is a reason.
  const { labels } = labelRun(runDir, { strategies });
  const flat = labels.filter(l => l.decision === 'flat');
  const trade = flat.slice(0, 2);
  assert.deepStrictEqual([flat[5].teacher.setup, flat[5].teacher.target], ['prop_composed', { ticks: 231, from: 'record' }]);
  assert.ok(!flat[5].clone.reasons.includes('limit entry'), flat[5].clone.reasons.join(', '));
  assert.deepStrictEqual([8, 9, 10, 11, 12, 13].map(i => flat[i].clone.reasons.includes('limit entry')), [false, true, false, true, false, true]);
  assert.deepStrictEqual(trade[0].teacher.target, { ticks: 231, from: 'record' });
  assert.ok(!trade[0].clone.reasons.includes('limit entry') && !trade[0].clone.reasons.includes('explicit target'), trade[0].clone.reasons.join(', '));
  assert.ok(trade[1].clone.reasons.includes('limit entry'), trade[1].clone.reasons.join(', '));
});

test('a composed trade\'s exit is judged by the exit it trades: the same with or without an attempt (its own tag or the policy\'s)', () => {
  const { planFor } = require('../../scripts/lib/replay/scorecard');
  const repo = path.resolve(__dirname, '..', '..');
  const all = require('../../scripts/lib/trading/strategies').loadStrategies(repo, {}).strategies;
  const byName = new Map(all.map(s => [s.name, s]));
  const lifecycle = all.find(s => s.signal === 'composed');
  const policy = all.find(s => s.signal === 'policy' && (s.strategies || []).includes(lifecycle.name));
  const own = planFor(lifecycle.name, byName, 3);
  const inAttempt = planFor(policy.name, byName, 3);
  assert.deepStrictEqual(own.afterTarget, inAttempt.afterTarget, 'the policy\'s exit, outside an attempt too');
  assert.deepStrictEqual([own.ownTargetR, inAttempt.ownTargetR], [lifecycle.risk.min_rr, policy.risk.min_rr]);
  const f = facts({ planOf: n => planFor(n, byName, 3) });
  const exit = outcome => classify(label({ decision: 'in-trade', teacher: { action: 'exit', orders: [] }, clone: { ok: false, reasons: [] }, outcome }), f, { decision: 'hold' }, checkReasons('', f));
  for (const setup of [lifecycle.name, policy.name]) {
    // Closed under its own target (at least min_rr away): early close; past it, the trail is the plan's management.
    const early = exit({ setup, r: 0.5, mfeR: 0.8, entryTime: '2026-06-01T14:20:00.000Z' });
    assert.deepStrictEqual([early.category, early.why], ['early close', [`closed at 0.5R, its best 0.8R, before the plan's ${lifecycle.risk.min_rr}R`]], setup);
    assert.strictEqual(exit({ setup, r: 2.1, mfeR: 2.4, entryTime: '2026-06-01T14:20:00.000Z' }).category, 'unchecked', setup);
  }
});

test('no compose: a pass on a composable setup (trend side, a key-level reaction, the trigger closed) without compose_check is excessive abstention; anything less is not composable', () => {
  const { composableSetup } = require('../../scripts/lib/replay/scorecard');
  const BAR = '2026-04-28T14:30:00.000Z';
  const b = (o = {}) => ({ minutes: 3, sections: { m3: { data: {
    bar: { t: BAR }, window: 'opening drive', windowEntries: 'allowed', news: { inBlackout: false },
    trendRule: 'Trend rule: LONG allowed (prevailing 1h up); short only as a reversal (mtf: reversal).',
    // The 15m candle that closed before this 3m bar rejected the prior VAH up: the trigger timeframe closed after it.
    candles: { '15m': { t: '2026-04-28T14:15:00.000Z', closedAt: '2026-04-28T14:30:00.000Z', relations: [{ name: 'prior VAH', price: 21500, rel: 'rejected', dir: 'up' }] } },
    ...o,
  } } } });
  assert.deepStrictEqual(composableSetup(b()), { valid: true, sides: ['long'], reason: '15m rejected prior VAH, confirmation' });
  // The reaction bar itself (the setup candle closed with this bar): the trigger not closed yet.
  assert.strictEqual(composableSetup(b({ bar: { t: '2026-04-28T14:27:00.000Z' } })).valid, false);
  // Against the trend rule's side; no entries in the window; a news blackout; no key level met; no briefing.
  assert.strictEqual(composableSetup(b({ trendRule: 'Trend rule: SHORT allowed (prevailing 1h down); long only as a reversal (mtf: reversal).' })).valid, false);
  assert.strictEqual(composableSetup(b({ windowEntries: 'none' })).valid, false);
  assert.strictEqual(composableSetup(b({ news: { inBlackout: true } })).valid, false);
  assert.strictEqual(composableSetup(b({ candles: { '15m': { t: '2026-04-28T14:15:00.000Z', closedAt: '2026-04-28T14:30:00.000Z', relations: [] } } })).valid, false);
  assert.deepStrictEqual(composableSetup(null), { valid: false, sides: [], reason: 'no bar briefing' });
  // The classification: a pass with nothing to take but a composable setup disagrees (no compose); none, it is right.
  const quiet = facts();
  const label = { decision: 'flat', teacher: { action: 'none', setup: null, size: null, orders: [] }, gate: { decision: 'none', checks: [] }, clone: { ok: true, reasons: [] }, cycleFailed: null };
  const cls = f => classify(label, f, expectedDecision(f), checkReasons('CYCLE RESULT: no-trade - only 1.17R to the VAH ahead, wait for a pullback', f));
  assert.deepStrictEqual(cls({ ...quiet, composable: composableSetup(b()) }), { category: 'excessive abstention', agrees: false, why: ['no compose: long 15m rejected prior VAH, confirmation, passed without compose_check'] });
  assert.strictEqual(cls({ ...quiet, composable: composableSetup(b({ windowEntries: 'none' })) }).category, 'right');
  assert.strictEqual(cls(quiet).category, 'right');
});
