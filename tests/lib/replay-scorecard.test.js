'use strict';

// The adherence scorecard (scripts/lib/replay/scorecard.js): the pure steps on crafted facts, and a whole
// synthetic run home (no real data) through scoreRun and writeScorecard.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const { tmpDir } = require('../helpers');
const { scoreRun, writeScorecard, checkReasons, expectedDecision, classify, clausesOf, CATEGORIES } = require('../../scripts/lib/replay/scorecard');

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
  return { window: WINDOW.drive, scanned: true, setups: [], trendRule: TREND_DOWN, attempt: ACTIVE, styleOf: n => ({ keltner: 'trend', orb: 'trend', cisd_ote: 'reversal', manual_x: 'manual' }[n] || null), ...over };
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
  // A reversal strategy named: the trend rule never blocks it.
  const rev = checkReasons('CYCLE RESULT: no-trade - cisd_ote long blocked by the trend rule', facts({ setups: [setup({ name: 'cisd_ote', component: null, policy: false, direction: 'long', style: 'reversal', verdict: null })] }));
  assert.strictEqual(claim(rev, 'trend-blocks').check, false);
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
  assert.deepStrictEqual(r.claims.map(c => [c.kind, c.check]), [['room', true], ['mixed', true], ['no-confluence', true]]);
  assert.strictEqual(r.status, 'confirmed');
  const roomy = checkReasons('CYCLE RESULT: no-trade - stop is 0.69R away from prior VAL, need 2R minimum', facts({ setups: [setup()] }));
  assert.strictEqual(roomy.claims.length, 1, 'two clauses saying the same claim count once');
  assert.strictEqual(roomy.claims[0].check, false);
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade - counter read', facts({ setups: [setup()] })), 'counter').check, false);
  assert.strictEqual(claim(checkReasons('CYCLE RESULT: no-trade - policy strategy prop_portfolio has no verdict for MNQ', facts({ setups: [setup()] })), 'no-verdict').check, false);
  // A room claim with no room fact, a cooldown with no entry block recorded: unchecked, and the status says so.
  const unknown = checkReasons('CYCLE RESULT: no-trade | Account on 2-loss cooldown until 17:00 CT; insufficient room', facts({ setups: [setup({ room: null })] }));
  assert.deepStrictEqual(unknown.claims.map(c => [c.kind, c.check]), [['entry-block', 'unchecked'], ['room', 'unchecked']]);
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
  assert.deepStrictEqual([go({ room: { inTheWay: { name: 'prior VAL', R: 0.69 }, needR: 2 } }).decision, go({ room: { inTheWay: { name: 'prior VAL', R: 0.69 }, needR: 2 } }).decidedBy], ['no-trade', 3]);
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
  // right: a skip the order agrees with, for true reasons; an entry within the ceiling.
  assert.deepStrictEqual(run(label(), roomless, 'CYCLE RESULT: veto - insufficient room'), { category: 'right', agrees: true, why: [] });
  assert.strictEqual(run(entry('short', 10), take).category, 'right');
  // wrong stated reason: the right skip, a false reason.
  assert.deepStrictEqual(run(label(), roomless, 'CYCLE RESULT: no-trade - no candidate strategies').category, 'wrong stated reason');
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
  assert.deepStrictEqual([run(entry('short', 1), roomless).category, run(entry('short', 1), roomless).why], ['bad size', ['the order says no trade (step 3)']]);
  // early close: an exit the model sent in a trade; a hold is right.
  assert.strictEqual(run(label({ decision: 'in-trade', teacher: { action: 'exit', orders: [] } }), facts()).category, 'early close');
  assert.strictEqual(run(label({ decision: 'in-trade', teacher: { action: 'hold', orders: [] } }), facts()).category, 'right');
  // unchecked: a failed cycle, a manual strategy's entry, facts the steps can't compute.
  assert.deepStrictEqual(run(label({ cycleFailed: 'cycle timed out' }), take), { category: 'unchecked', agrees: null, why: ['cycle timed out'] });
  assert.strictEqual(run(entry('long', 1, undefined, 'manual_x'), facts()).category, 'unchecked');
  assert.strictEqual(run(entry('short', 1), facts({ setups: [setup({ room: null })] })).category, 'unchecked');
  assert.strictEqual(run(label(), facts({ setups: [setup({ room: null })] })).category, 'unchecked');
  assert.deepStrictEqual(CATEGORIES, ['right', 'wrong-side entry', 'bad size', 'early close', 'excessive abstention', 'wrong stated reason', 'risk-rule rejection', 'unchecked']);
});

// ------------------------------------------------------------------------------------------------
// A whole run home

const DAY = '2026-03-03';
const RUN = 'sc1';
const iso = ms => new Date(ms).toISOString();
const BAR0 = Date.parse(`${DAY}T14:57:00Z`); // the k-th decision's bar opens at BAR0 + 3k minutes (09:57 ET: EST in March)
const barOf = k => BAR0 + k * 180000;
const tOf = k => barOf(k) + 182000; // the decision: 2 s after the bar closed
const WALL0 = Date.parse('2026-10-11T00:00:00Z');
const ATTEMPT = { account: 'topstep_100k', status: 'active', balance: 100000, floor: 97000, cushion: 3000, profit: 0, target: 6000, dayPnl: -500, sessionsLeft: 30, entryBlock: null };
const STRATS = [
  { name: 'orb', valid: true, signal: 'rules', mtf: 'trend', status: 'active', risk: { min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } },
  { name: 'prop_portfolio', valid: true, signal: 'policy', status: 'active', risk: { min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } },
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
  { name: 'prop_portfolio', candidate: action !== 'skip', direction: 'long', stopDistance: 10, verdict: { action, maxSize, contract: 'MNQ', ...(action === 'skip' ? { reason: 'the daily soft limit is reached' } : {}) } },
];
const quietScan = [{ name: 'orb', candidate: false, mtf: MTF }];
const LONG = { tool: 'place_order', input: { accountId: 7, contractId: 'MNQ', side: 'buy', type: 'market', size: 2, stopLossBracket: { ticks: 40, type: 'stop' }, rationale: 'setup:prop_portfolio long breakout, stop 20523.5' } };
const POS = [{ contractId: 'MNQ', side: 'long', size: 2, averagePrice: 20534 }];
const fill = (ms, side, price, pnl, extra = {}) => ({ id: `${ms}-${side}`, contractId: 'MNQ', creationTimestamp: iso(ms), price, profitAndLoss: pnl, fees: 0.74, side, size: 2, voided: false, ...extra });

/** The day: a right entry, a hold, an early close, an excessive abstention, a false window, a skip verdict, a refusal, a judged stand-aside, a failed cycle. */
const STEPS = [
  { k: 0, scan: policyScan(), verdict: true, cycle: { orders: [LONG], result: 'CYCLE RESULT: executed - prop_portfolio long 2 MNQ, aligned and room to 20600' } },
  { k: 1, scan: quietScan, cycle: { positions: POS, result: 'CYCLE RESULT: managed | Position running profitably with protective stop active.' }, trades: [fill(tOf(0) + 28000, 0, 20534, null)] },
  { k: 2, scan: quietScan, cycle: { positions: POS, orders: [{ tool: 'close_position', input: { accountId: 7, contractId: 'MNQ' } }], result: 'CYCLE RESULT: exited - took profit early' } },
  { k: 3, scan: policyScan(), verdict: true, cycle: { result: 'CYCLE RESULT: no-trade - no candidate strategies (orb long blocked by 15m down trend rule)' }, trades: [fill(tOf(2) + 28000, 1, 20544, 20, { roundTrip: { net: 18.52, r: 0.5, reason: 'exit' } })] },
  { k: 4, scan: quietScan, cycle: { result: 'CYCLE RESULT: blocked - Opening print window until 10:00 ET and no strategy candidates' } },
  { k: 5, scan: policyScan('skip', 0), verdict: true, cycle: { result: 'CYCLE RESULT: blocked - no prop attempt running' } },
  { k: 6, scan: policyScan(), verdict: true, cycle: { orders: [{ ...LONG, gate: { source: 'gateway', decision: 'blocked', violations: [{ check: 'combine-verdict', message: 'no' }] } }], result: 'CYCLE RESULT: blocked - the gate refused' } },
  { k: 7, scan: quietScan, cycle: { result: 'CYCLE RESULT: no-trade - ADX falling, thin volume' } },
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
    const rec = { v: 1, t: iso(t), day: DAY, kind: s.kind || 'trade', ran: [], cycles: [], refusals: [], errors: [], bars: [{ symbol: 'MNQ', lastBarT: barT }], trades: s.trades || [], since: iso(t - 180000) };
    if (s.scan) scans.push({ at: iso(t), symbol: 'MNQ', contractId: 'MNQ', bar: { t: barT, c: 0 }, decision: { run: true, reason: 'bar closed' }, candidates: s.scan.filter(r => r.candidate).map(r => r.name), results: s.scan });
    if (s.verdict) {
      const v = s.scan.find(r => r.verdict).verdict;
      verdicts.push({ at: iso(t), strategy: 'prop_portfolio', component: 'orb', symbol: 'MNQ', contractId: 'MNQ', bar: barT, direction: 'long', stopTicks: 40, account: 'topstep_100k', combine: ATTEMPT, ...v });
    }
    if (s.cycle) {
      const c = s.cycle;
      const file = path.join(home, 'logs', 'cycles', '2026-10-11', `${String(i).padStart(6, '0')}-trade.json`);
      const transcript = (c.orders || []).map((o, j) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `c${i}-${j}`, name: `mcp__broker__${o.tool}`, input: o.input }] } })).join('\n');
      const account = { id: 7, balance: 100000, positions: c.positions || [], workingOrders: 0 };
      const openTrades = (c.positions || []).map(p => ({ contractId: p.contractId, side: p.side, stop: p.averagePrice - 10 }));
      fs.writeFileSync(file, JSON.stringify({ at: iso(wall), action: 'trade', prompt: `p${i}`, context: { symbols: [{ symbol: 'MNQ', bar: { t: barT, c: 0 } }], account, openTrades, attempts: [ATTEMPT] }, transcript }));
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
  assert.deepStrictEqual([R[2].category, R[2].agrees], ['early close', false]);
  // 3: the order says take; skipped on false grounds, with what the setup would have done.
  assert.deepStrictEqual([R[3].expected.decision, R[3].category], ['take', 'excessive abstention']);
  assert.deepStrictEqual(R[3].reasons.claims.map(c => [c.kind, c.check]), [['nothing-fired', false], ['trend-blocks', false]]);
  assert.ok(R[3].counterfactual, 'a skipped setup carries its counterfactual');
  assert.strictEqual(R[3].counterfactual.strategy, 'prop_portfolio');
  // 4: nothing to take, but the stated window is false.
  assert.deepStrictEqual([R[4].expected.decidedBy, R[4].category], ['no setup', 'wrong stated reason']);
  assert.match(R[4].reasons.claims.find(c => c.kind === 'no-entry-window').why, /opening drive window allows entries/);
  // 5: a skip verdict (step 1); "no prop attempt running" while it runs.
  assert.deepStrictEqual([R[5].expected.decision, R[5].expected.decidedBy, R[5].category], ['no-trade', 1, 'wrong stated reason']);
  // 6: the gate refused the entry; the room (1.85R before the 2R it needs) said no trade anyway.
  assert.deepStrictEqual([R[6].category, R[6].expected.decidedBy], ['risk-rule rejection', 3]);
  // 7: no setup, judgment reasons; 8: a failed cycle.
  assert.deepStrictEqual([R[7].category, R[7].reasons.judgment.length], ['right', 2]);
  assert.deepStrictEqual([R[8].category, R[8].agrees], ['unchecked', null]);

  // The summary.
  assert.deepStrictEqual(summary.categories, { right: 3, 'wrong-side entry': 0, 'bad size': 0, 'early close': 1, 'excessive abstention': 1, 'wrong stated reason': 2, 'risk-rule rejection': 1, unchecked: 1 });
  assert.deepStrictEqual(summary.agreement.overall, { decisions: 9, agree: 5, disagree: 3, unchecked: 1, rate: 0.625 });
  assert.deepStrictEqual(Object.keys(summary.agreement.byStep), ['1 hard stops', '3 room', 'in a trade', 'no setup', 'take']);
  assert.deepStrictEqual(summary.agreement.byStep.take, { decisions: 2, agree: 1, disagree: 1, unchecked: 0, rate: 0.5 });
  assert.strictEqual(summary.agreement.byStrategy.orb.decisions, 4);
  assert.deepStrictEqual([summary.trades.n, summary.trades.wins, summary.trades.sumR, summary.trades.net], [1, 1, 0.5, 18.52]);
  assert.strictEqual(summary.skipped.n, 1);
  assert.strictEqual(summary.reasons.byKind['no-attempt'].false, 1);
  assert.deepStrictEqual(summary.days, [{ day: DAY, decisions: 9, agree: 5, disagree: 3, balance: 100000, dayPnl: -500, floor: 97000, cushion: 3000, dailyHeadroom: 1500, balanceCheck: 'ok' }]);
  // Deterministic.
  assert.deepStrictEqual(scoreRun(runDir, { strategies: STRATS, accounts: ACCOUNTS }), { records, summary });
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
  assert.match(md, /\| excessive abstention \| take prop_portfolio \| none \|/);
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
  assert.match(out, /wrote .*scorecard\.jsonl, scorecard-summary\.json and scorecard\.md/);
  assert.ok(fs.existsSync(path.join(runDir, 'scorecard.md')));
});
