'use strict';

// The scorecard's failure taxonomy (scripts/lib/replay/failures.js, R19 and R25): severity, session-timing misreads,
// the field check on recorded values, the cycle's recorded claim checks, the data a record lacks, the per-run,
// per-day and per-type summary, and the flagged decisions; each failure planted, and a correct decision beside it
// that must not be flagged. Then a synthetic run home (no real data) through scoreRun and writeScorecard.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const F = require('../../scripts/lib/replay/failures');
const { scoreRun, writeScorecard, checkReasons, classify, expectedDecision, withChecks, lookAt, takeLook } = require('../../scripts/lib/replay/scorecard');
const { readLedger } = require('../../scripts/lib/prop/ledger-file');

// A strategy whose rules read broker fields (neutral names: the harness knows no field's meaning).
const FIELDS = {
  name: 'fx_fields', valid: true, signal: 'rules', mtf: 'trend', status: 'active',
  rules: { long: ['field("a.b") >= 0.3', 'field("a.c")[1] > 0', 'close > close[1]'], short: ['field("a.b") <= -0.3'] },
  risk: { min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 },
};
const PLAIN = { name: 'plain', valid: true, signal: 'rules', mtf: 'trend', status: 'active', rules: { long: ['close > close[1]'], short: ['close < close[1]'] }, risk: { min_rr: 2 }, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 } };
const byName = new Map([FIELDS, PLAIN].map(s => [s.name, s]));

// ------------------------------------------------------------------------------------------------
// The field check

test('fieldConditions: only the conditions that read broker fields alone; groups count when every part does', () => {
  assert.deepStrictEqual(F.fieldConditions(FIELDS, 'long').map(c => c.text), ['field("a.b") >= 0.3', 'field("a.c")[1] > 0']);
  assert.deepStrictEqual(F.fieldConditions(PLAIN, 'long'), []);
  const grouped = { rules: { long: [{ any: ['field("a.b") > 1', 'field("a.d") > 1'] }, { all: ['field("a.b") > 1', 'close > 0'] }] } };
  assert.deepStrictEqual(F.fieldConditions(grouped, 'long').map(c => c.text), ['any(field("a.b") > 1 | field("a.d") > 1)']);
  assert.deepStrictEqual(F.fieldConditions({ rules: { long: ['not a rule'] } }, 'long'), [], 'an item that does not compile is left out');
});

test('fieldCheck: holds, fails, a null is a false condition, and missing data is named, never guessed', () => {
  const ok = F.fieldCheck({ strategy: FIELDS, side: 'long', values: { fx_fields: { 'a.b': 0.5, 'a.c[1]': 2 } } });
  assert.strictEqual(ok.status, 'holds');
  assert.deepStrictEqual(ok.conditions.map(c => c.ok), [true, true]);
  const fails = F.fieldCheck({ strategy: FIELDS, side: 'long', values: { fx_fields: { 'a.b': 0.1, 'a.c[1]': 2 } } });
  assert.deepStrictEqual([fails.status, fails.conditions.map(c => c.ok)], ['fails', [false, true]]);
  // The look-back is read at its own shift: a value at a.c (shift 0) is not a.c[1].
  assert.strictEqual(F.fieldCheck({ strategy: FIELDS, side: 'long', values: { fx_fields: { 'a.b': 0.5, 'a.c': 2 } } }).status, 'fails');
  const nul = F.fieldCheck({ strategy: FIELDS, side: 'long', values: { fx_fields: { 'a.b': null, 'a.c[1]': 2 } } });
  assert.deepStrictEqual([nul.status, nul.conditions[0].missing], ['fails', true]);
  assert.deepStrictEqual(F.fieldCheck({ strategy: FIELDS, side: 'long', values: null, valuesAbsent: true }), { status: 'absent' });
  assert.deepStrictEqual(F.fieldCheck({ strategy: FIELDS, side: 'long', values: null, valuesError: 'MNQ: strategy scan failed (x)' }), { status: 'error', error: 'MNQ: strategy scan failed (x)' });
  assert.deepStrictEqual(F.fieldCheck({ strategy: FIELDS, side: 'long', values: { other: {} } }), { status: 'not recorded' });
  assert.deepStrictEqual(F.fieldCheck({ strategy: PLAIN, side: 'long', values: {} }), { status: 'none' });
  assert.deepStrictEqual(F.fieldCheck({ strategy: undefined, side: 'long', values: {} }), { status: 'none' });
});

const flowFacts = setups => ({ setups });
const enter = (side, setup, values, extra = {}) => ({ decision: 'flat', teacher: { action: side, setup }, values, valuesAbsent: false, valuesError: null, ...extra });
const listed = (name, direction) => ({ name, component: null, direction, candidate: true });

test('flowOf: an entry the scan did not list, its own side failing: inconsistent; the other side holding: wrong side', () => {
  const wrong = F.flowOf(enter('long', 'fx_fields', { fx_fields: { 'a.b': -0.5, 'a.c[1]': 1 } }), flowFacts([listed('plain', 'long')]), byName);
  assert.deepStrictEqual([wrong.status, wrong.otherSide], ['inconsistent', true]);
  const none = F.flowOf(enter('long', 'fx_fields', { fx_fields: { 'a.b': 0.1, 'a.c[1]': 1 } }), flowFacts([]), byName);
  assert.deepStrictEqual([none.status, none.otherSide], ['inconsistent', false]);
  // Planted right: the values agree with the entry.
  assert.strictEqual(F.flowOf(enter('long', 'fx_fields', { fx_fields: { 'a.b': 0.5, 'a.c[1]': 1 } }), flowFacts([]), byName).status, 'consistent');
  // The scan listed it, the values say otherwise: the recording, never the model.
  assert.strictEqual(F.flowOf(enter('long', 'fx_fields', { fx_fields: { 'a.b': 0.1, 'a.c[1]': 1 } }), flowFacts([listed('fx_fields', 'long')]), byName).status, 'mismatch');
  // A policy's entry is checked on its component.
  const pol = F.flowOf(enter('short', 'pol', { fx_fields: { 'a.b': -0.5 } }), flowFacts([{ name: 'pol', component: 'fx_fields', direction: 'short', candidate: true }]), byName);
  assert.deepStrictEqual([pol.status, pol.setups[0].strategy], ['consistent', 'fx_fields']);
  // The other side holds only on its field conditions, its others unread: not called the wrong side (review round 1).
  const half = new Map([['fx_half', { ...FIELDS, name: 'fx_half', rules: { long: ['field("a.b") >= 0.3'], short: ['field("a.b") <= -0.3', 'close < close[1]'] } }]]);
  const partial = F.flowOf(enter('long', 'fx_half', { fx_half: { 'a.b': -0.5 } }), flowFacts([]), half);
  assert.deepStrictEqual([partial.status, partial.otherSide], ['inconsistent', false]);
  // The scan fired it (not tradeable, so not among the setups): the model saw it fire, so a disagreement is the recording.
  assert.strictEqual(F.flowOf(enter('long', 'fx_fields', { fx_fields: { 'a.b': 0.1, 'a.c[1]': 1 } }), { setups: [], fired: ['fx_fields|long'] }, byName).status, 'mismatch');
  // A cross can't be checked on one bar's values: left out.
  assert.deepStrictEqual(F.fieldConditions({ rules: { long: ['field("a.b") crosses_above 0', { any: ['field("a.b") > 1', 'field("a.d") crosses_below 1'] }] } }, 'long'), []);
  // Old sessions and errors: named, never a failure.
  assert.strictEqual(F.flowOf(enter('long', 'fx_fields', null, { valuesAbsent: true }), flowFacts([]), byName).status, 'absent');
  assert.strictEqual(F.flowOf(enter('long', 'fx_fields', null, { valuesError: 'MNQ: no field values recorded (x)' }), flowFacts([]), byName).status, 'error');
  assert.strictEqual(F.flowOf(enter('long', 'plain', {}), flowFacts([]), byName).status, 'none');
  assert.strictEqual(F.flowOf({ decision: 'in-trade', teacher: { action: 'exit' } }, flowFacts([]), byName).status, 'none');
});

test('flowOf: a skip checks each setup the scan listed', () => {
  const skip = (values, extra) => F.flowOf({ decision: 'flat', teacher: { action: 'none' }, values, ...extra }, flowFacts([listed('fx_fields', 'short'), listed('plain', 'long')]), byName);
  assert.strictEqual(skip({ fx_fields: { 'a.b': -0.4 } }).status, 'consistent');
  assert.strictEqual(skip({ fx_fields: { 'a.b': 0.4 } }).status, 'mismatch');
  assert.strictEqual(skip(null, { valuesAbsent: true }).status, 'absent');
  assert.strictEqual(F.flowOf({ decision: 'flat', teacher: { action: 'none' }, values: {} }, flowFacts([listed('plain', 'long')]), byName).status, 'none');
});

// ------------------------------------------------------------------------------------------------
// Claim checks, data, severity, timing

test('claimChecksOf: the cycle\'s own checks when it recorded them, the false ones it still states; else not checked', () => {
  assert.deepStrictEqual(F.claimChecksOf({}, 'x'), { status: 'not checked' });
  assert.deepStrictEqual(F.claimChecksOf(null, 'x'), { status: 'not checked' });
  const doc = { reasonChecks: [{ kind: 'nothing-fired', clause: 'No strategy  candidates', check: false, why: 'fired: a' }, { kind: 'room', clause: 'room 3R', check: true, why: 'ok' }, { clause: 'odd', check: 'maybe' }] };
  const kept = F.claimChecksOf(doc, 'CYCLE RESULT: no-trade - no strategy candidates; room 3R');
  assert.deepStrictEqual([kept.status, kept.false, kept.kept.map(c => c.kind), kept.checks[2].check], ['checked', 1, ['nothing-fired'], 'unchecked']);
  // Dropped after the check: nothing kept.
  assert.deepStrictEqual(F.claimChecksOf(doc, 'CYCLE RESULT: no-trade - room 3R').kept, []);
});

test('dataOf: values absent, error or recorded; the archive pruned, failed or kept; the scan and the briefing', () => {
  const facts = { scanned: true, rebuilt: false, setups: [{}] };
  assert.deepStrictEqual(F.dataOf({ valuesAbsent: true }, facts), { values: 'absent', archive: 'none', scanned: true, rebuilt: false });
  assert.deepStrictEqual(F.dataOf({ valuesError: 'e', archiveError: 'a' }, { scanned: false, setups: [] }), { values: 'error', archive: 'error', scanned: false, rebuilt: null, valuesError: 'e', archiveError: 'a' });
  assert.deepStrictEqual(F.dataOf({ values: {}, archivedBar: { t: 'x' }, archivePruned: false }, facts).archive, 'archived');
  assert.deepStrictEqual(F.dataOf({ values: {}, archivePruned: true, archiveError: 'a' }, facts).archive, 'pruned');
  assert.strictEqual(F.dataOf({ values: {} }, facts).values, 'recorded');
});

test('severityOf: by category and its evidence; right and unchecked have none', () => {
  const r = (category, over = {}) => ({ category, expected: { ceiling: null }, reasons: { claims: [] }, ...over });
  assert.strictEqual(F.severityOf(r('wrong-side entry')), 'high');
  assert.strictEqual(F.severityOf(r('bad size', { expected: { ceiling: 0 } })), 'high');
  assert.strictEqual(F.severityOf(r('bad size', { expected: { ceiling: 2 } })), 'medium');
  assert.strictEqual(F.severityOf(r('bad size', { flow: { status: 'inconsistent' } })), 'high');
  for (const c of ['early close', 'excessive abstention', 'risk-rule rejection']) assert.strictEqual(F.severityOf(r(c)), 'medium');
  assert.strictEqual(F.severityOf(r('wrong stated reason', { reasons: { claims: [{ kind: 'no-confluence', check: false }] } })), 'low');
  assert.strictEqual(F.severityOf(r('wrong stated reason', { reasons: { claims: [{ kind: 'no-entry-window', check: false }] } })), 'medium');
  assert.strictEqual(F.severityOf(r('wrong stated reason', { reasons: { claims: [{ kind: 'no-entry-window', check: false, incidental: true }] } })), 'low');
  assert.strictEqual(F.severityOf(r('wrong stated reason', { claimChecks: { kept: [{ kind: 'trend-blocks' }] } })), 'medium');
  assert.strictEqual(F.severityOf(r('right')), null);
  assert.strictEqual(F.severityOf(r('unchecked')), null);
  assert.deepStrictEqual(F.TYPES, ['wrong-side entry', 'bad size', 'early close', 'excessive abstention', 'wrong stated reason', 'risk-rule rejection']);
});

// The session-timing misreads the June replays showed, as the reason checker reads them.
const DRIVE = { name: 'opening drive', until: '11:00', et: '10:48', entriesAllowed: true };
const BREAK = { name: 'market closed', until: '18:00', et: '16:30', entriesAllowed: false };
const noSetup = window => ({ window, scanned: true, setups: [], trendRule: { prevailing: null, long: null, short: null }, attempt: null, styleOf: () => null, planOf: () => null });

test('session timing: "session closed", "still in premarket", "opens 18:00", "< 18:00 ET open" are window claims, false while entries are allowed', () => {
  for (const text of ['CYCLE RESULT: blocked - Session closed (10:48 ET < 18:00 ET open), no strategy candidates', 'CYCLE RESULT: blocked - Session still in premarket (opens 18:00 ET)', 'CYCLE RESULT: no-trade - before 18:00 ET session open', 'CYCLE RESULT: blocked - market closed']) {
    const r = checkReasons(text, noSetup(DRIVE));
    const timing = F.timingOf(r);
    assert.ok(timing.length >= 1, text);
    assert.match(timing[0].why, /opening drive window allows entries/);
  }
  // Planted right: true statements about levels and the past are no window claims (review round 1).
  for (const text of ['CYCLE RESULT: executed - prior session closed above VAH', 'CYCLE RESULT: executed - market closed higher yesterday', 'CYCLE RESULT: executed - retest of the high made in the premarket',
    'CYCLE RESULT: executed - London open 03:00 low held', 'CYCLE RESULT: executed - rejected the RTH open 9:30 print', 'CYCLE RESULT: executed - above the overnight low set before the 9:30 open',
    'CYCLE RESULT: executed - still in premarket high range', 'CYCLE RESULT: executed - the prior session closed', 'CYCLE RESULT: executed - yesterday\'s market closed']) {
    assert.deepStrictEqual(checkReasons(text, noSetup(DRIVE)).claims.filter(c => c.kind === 'no-entry-window'), [], text);
  }
  // Round 2: more true descriptions, on a skip too, are no window claims.
  for (const text of ['CYCLE RESULT: no-trade - the session closed strong yesterday', 'CYCLE RESULT: no-trade - Friday session closed bullish', 'CYCLE RESULT: no-trade - NQ session closed, gapped up overnight',
    'CYCLE RESULT: no-trade - the RTH session opens 9:30 and price held the OR', 'CYCLE RESULT: no-trade - Asian session opens 20:00 low swept', 'CYCLE RESULT: no-trade - opens 9:30 range broke higher']) {
    assert.deepStrictEqual(checkReasons(text, noSetup(DRIVE)).claims.filter(c => c.kind === 'no-entry-window'), [], text);
  }
  // The misread's other spellings are caught.
  for (const text of ['CYCLE RESULT: blocked - session is closed at this time', 'CYCLE RESULT: blocked - markets closed', 'CYCLE RESULT: blocked - still premarket']) {
    assert.strictEqual(F.timingOf(checkReasons(text, noSetup(DRIVE))).length, 1, text);
  }
  // On an entry's result a window claim is no ground: unchecked, never false (a level described, not a misread).
  const entered = checkReasons('CYCLE RESULT: executed - long; session closed above the high', noSetup(DRIVE));
  assert.deepStrictEqual(F.timingOf(entered), []);
  assert.ok(checkReasons('CYCLE RESULT: executed - market is closed', noSetup(DRIVE)).claims.every(c => c.check !== false));
  // Round 3: the entry known from the orders, not the first word; "RTH session closed" at 10:48 is the misread.
  assert.deepStrictEqual(F.timingOf(checkReasons('CYCLE RESULT: long MNQ - session closed', noSetup(DRIVE), { entered: true })), []);
  assert.strictEqual(F.timingOf(checkReasons('CYCLE RESULT: executed - session closed', noSetup(DRIVE), { entered: false })).length, 1);
  assert.strictEqual(F.timingOf(checkReasons('CYCLE RESULT: blocked - RTH session closed', noSetup(DRIVE))).length, 1);
  assert.strictEqual(F.timingOf(checkReasons('CYCLE RESULT: blocked - trades session closed', noSetup(DRIVE))).length, 1, 'a word ending in "es" is not the ES qualifier');
  // No window known (no decision time): the claim is unchecked, never counted as a misread.
  const unknown = checkReasons('CYCLE RESULT: blocked - Session closed', noSetup(null));
  assert.deepStrictEqual([unknown.claims[0].check, F.timingOf(unknown)], ['unchecked', []]);
  // Planted right: said at the daily break, it is true; and a plain reason is no timing claim.
  assert.deepStrictEqual(F.timingOf(checkReasons('CYCLE RESULT: blocked - Session closed, opens 18:00 ET', noSetup(BREAK))), []);
  assert.strictEqual(checkReasons('CYCLE RESULT: blocked - Session closed, opens 18:00 ET', noSetup(BREAK)).claims[0].check, true);
  assert.deepStrictEqual(F.timingOf(checkReasons('CYCLE RESULT: no-trade - no strategy candidates', noSetup(DRIVE))), []);
});

// ------------------------------------------------------------------------------------------------
// Each failure type through classify and the field and claim checks, with a planted right decision beside it

const label = (over = {}) => ({ decision: 'flat', teacher: { action: 'none', setup: null, size: null, orders: [] }, gate: { decision: 'none', checks: [] }, clone: { ok: true, reasons: [] }, cycleFailed: null, ...over });
const policy = (over = {}) => ({
  name: 'pol', component: 'plain', policy: true, direction: 'short', candidate: true, style: 'trend', stopPoints: 10,
  verdict: { action: 'full', maxSize: 4, contract: 'MNQ', stopTicks: 40, reason: null }, trendAllows: true, prevailing: { label: '15m', trend: 'down' },
  room: { inTheWay: null, needR: 2 }, alignment: 'aligned', confluence: { with: [], against: [] }, blocked: null, vwapSide: 'below', lunch: false, ...over,
});
const facts = (setups, over = {}) => ({ ...noSetup(DRIVE), t: '2026-03-03T15:48:02.000Z', setups, trendRule: { prevailing: '15m down', long: false, short: true }, ...over });
const entry = (side, size, gate = { decision: 'allowed', checks: [] }) => label({ teacher: { action: side, setup: 'pol', size: { contracts: size }, orders: [{ tool: 'place_order', riskReducing: false, setup: 'pol', size }] }, gate });
const cat = (l, f, text = 'CYCLE RESULT: done') => classify(l, f, expectedDecision(f), checkReasons(text, f)).category;

test('each failure type planted, and its correct twin not flagged', () => {
  const f = facts([policy()]);
  assert.strictEqual(cat(entry('long', 2), f), 'wrong-side entry');
  assert.strictEqual(cat(entry('short', 2), f), 'right', 'the side the setup is on');
  assert.strictEqual(cat(entry('short', 6), f), 'bad size');
  assert.strictEqual(cat(entry('short', 4), f), 'right', 'at the ceiling');
  assert.strictEqual(cat(entry('short', 2, { decision: 'refused', by: 'gateway', checks: ['order-pending'] }), f), 'risk-rule rejection');
  assert.strictEqual(cat(label(), f, 'CYCLE RESULT: no-trade - no strategy candidates'), 'excessive abstention');
  assert.strictEqual(cat(label(), facts([policy({ room: { inTheWay: { name: 'prior high', R: 0.5 }, needR: 2 } })]), 'CYCLE RESULT: no-trade - insufficient room'), 'excessive abstention', 'the room alone is a read, never a skip');
  assert.strictEqual(cat(label(), facts([]), 'CYCLE RESULT: blocked - Session closed (10:48 ET < 18:00 ET open)'), 'wrong stated reason');
  assert.strictEqual(cat(label(), facts([]), 'CYCLE RESULT: no-trade - no strategy candidates'), 'right');
  const plan = { planOf: () => ({ targetR: null, trailActivateR: 2, maxBars: null, minutes: 3 }) };
  const exit = o => label({ decision: 'in-trade', teacher: { action: 'exit', orders: [] }, outcome: { setup: 'pol', r: o.r, mfeR: o.mfeR, entryTime: '2026-03-03T15:30:00.000Z' } });
  const inTrade = l => classify(l, facts([], plan), { decision: 'hold' }, checkReasons('CYCLE RESULT: exited', facts([], plan))).category;
  assert.strictEqual(inTrade(exit({ r: 0.4, mfeR: 0.8 })), 'early close');
  assert.strictEqual(inTrade(exit({ r: 1.8, mfeR: 2.4 })), 'unchecked', 'past the plan\'s 2R: management is judgment');
});

test('withChecks: the field check overrides only an entry the classification trusts; a kept false claim only a right decision', () => {
  const flow = { status: 'inconsistent', otherSide: false, setups: [{ strategy: 'fx_fields', conditions: [{ rule: 'field("a.b") >= 0.3', ok: false }] }] };
  const l = (over = {}) => ({ teacher: { action: 'long', setup: 'fx_fields' }, clone: { reasons: [] }, cycleFailed: null, ...over });
  const f = { styleOf: n => (n === 'by_hand' ? 'manual' : 'trend') };
  const none = { status: 'not checked' };
  const un = { category: 'unchecked', agrees: null, why: [] };
  assert.strictEqual(withChecks(un, { label: l(), facts: f, flow, claimChecks: none }).category, 'bad size');
  assert.strictEqual(withChecks(un, { label: l({ cycleFailed: 'cycle failed' }), facts: f, flow, claimChecks: none }).category, 'unchecked');
  assert.strictEqual(withChecks(un, { label: l({ clone: { reasons: ['unattributed order'] } }), facts: f, flow, claimChecks: none }).category, 'unchecked');
  assert.strictEqual(withChecks(un, { label: l({ teacher: { action: 'long', setup: 'by_hand' } }), facts: f, flow, claimChecks: none }).category, 'unchecked');
  assert.strictEqual(withChecks({ category: 'risk-rule rejection', agrees: false, why: [] }, { label: l(), facts: f, flow, claimChecks: none }).category, 'risk-rule rejection');
  const kept = { status: 'checked', kept: [{ kind: 'trend-blocks', clause: 'x' }] };
  assert.strictEqual(withChecks({ category: 'right', agrees: true, why: [] }, { label: l(), facts: f, flow: { status: 'none' }, claimChecks: kept }).category, 'wrong stated reason');
  assert.strictEqual(withChecks(un, { label: l(), facts: f, flow: { status: 'none' }, claimChecks: kept }).category, 'unchecked');
});

test('lookAt: scoring a run is a look at its days, checked by the look ledger\'s rules before anything is read', () => {
  const runOf = (days, source) => ({ manifest: { runId: 'r1', ...(source ? { source } : {}) }, days: Object.fromEntries(days.map(d => [d, []])) });
  // Recent (the June 1-5, 2026 replay): a reasoning-fix look, the only one it allows; no ledger needed (no budget spent).
  const june = lookAt(runOf(['2026-06-01', '2026-06-02']));
  assert.deepStrictEqual([june.purpose, june.candidate, june.units.map(u => u.role)], ['reasoning-fix', 'scorecard:r1', ['recent']]);
  assert.throws(() => lookAt(runOf(['2026-06-01']), { purpose: 'judging', ledger: [] }), /refused: .*only a reasoning-fix look/);
  assert.throws(() => lookAt(runOf(['2026-06-01']), { purpose: 'tuning' }), /only a reasoning-fix look/);
  assert.throws(() => lookAt(runOf(['2026-11-02']), { purpose: 'judging' }), /needs the look ledger/);
  // Outside Recent the default is a tuning look (no budget, no ledger needed): every outcome shown.
  assert.deepStrictEqual(lookAt(runOf(['2021-06-14'])).purpose, 'tuning');
  // A reserve half-year: refused for every purpose; a held-out quarter: judging only.
  assert.throws(() => lookAt(runOf(['2027-03-01'])), /reserved for a later out-of-sample window/);
  assert.throws(() => lookAt(runOf(['2026-11-02'])), /allows judging looks only/);
  assert.strictEqual(lookAt(runOf(['2026-11-02']), { purpose: 'judging', ledger: [], candidate: 'c1' }).units[0].role, 'walk-forward');
  // Train: any purpose; a live session: its own split, no look.
  assert.strictEqual(lookAt(runOf(['2021-06-14']), { purpose: 'tuning', ledger: [] }).units[0].role, 'train');
  assert.deepStrictEqual(lookAt(runOf(['2027-03-01'], 'live')).purpose, null);
});

test('takeLook: an allowed look is appended to the ledger file before anything is read, so a fourth held-out look is refused', () => {
  const dir = path.join(tmpDir(), 'look-run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ v: 1, runId: 'h1' }));
  fs.writeFileSync(path.join(dir, '2026-11-02.jsonl'), '');
  const ledgerFile = path.join(path.dirname(dir), 'ledger.json');
  assert.throws(() => takeLook(dir, { purpose: 'judging', ledgerFile }), /can't be read .*no look without it/);
  fs.writeFileSync(ledgerFile, '{}');
  assert.throws(() => takeLook(dir, { purpose: 'judging', ledgerFile }), /refused: the ledger can't be read/);
  fs.writeFileSync(ledgerFile, '');
  assert.throws(() => takeLook(dir, { purpose: 'judging', ledgerFile }), /can't be read .*is empty/, 'an empty (maybe truncated) ledger is refused');
  assert.ok(!fs.existsSync(`${ledgerFile}.lock`));
  fs.writeFileSync(ledgerFile, '"x"');
  assert.throws(() => takeLook(dir, { purpose: 'judging', ledgerFile }), /can't be read .*not a JSON look/);
  // The earlier format (one JSON list) still reads; the first append rewrites it as the evaluator's JSON lines.
  fs.writeFileSync(ledgerFile, '[]');
  for (let i = 1; i <= 3; i += 1) takeLook(dir, { purpose: 'judging', candidate: `c${i}`, ledgerFile }, new Date('2026-12-01T00:00:00Z'));
  const ledger = readLedger(ledgerFile);
  assert.strictEqual(fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).length, 3, 'one look per line');
  assert.deepStrictEqual(ledger.map(e => [e.candidate, e.purpose, e.ranges, e.at]).slice(0, 1), [['c1', 'judging', [{ from: '2026-11-02', to: '2026-11-03' }], '2026-12-01T00:00:00.000Z']]);
  assert.throws(() => takeLook(dir, { purpose: 'judging', candidate: 'c4', ledgerFile }), /budget has used its 3 looks/);
  assert.strictEqual(readLedger(ledgerFile).length, 3, 'a refused look is not recorded');
  assert.ok(!fs.existsSync(`${ledgerFile}.lock`), 'the lock is released after a refusal');
  // A run holding the ledger's lock (the evaluator) refuses the scorecard's look rather than racing it.
  fs.writeFileSync(`${ledgerFile}.lock`, '');
  assert.throws(() => takeLook(dir, { purpose: 'judging', candidate: 'c5', ledgerFile }), /locked by another run/);
  fs.rmSync(`${ledgerFile}.lock`);
  // An unfinished run written without --out is refused before its look is recorded.
  const fresh = path.join(path.dirname(dir), 'ledger2.json');
  fs.writeFileSync(fresh, '[]');
  assert.throws(() => writeScorecard(dir, { look: { purpose: 'judging', candidate: 'c5', ledgerFile: fresh } }), /is not finished/);
  assert.strictEqual(fs.readFileSync(fresh, 'utf8'), '[]');
  // Without a file only a reasoning-fix look is taken, and here (a held-out quarter) it is refused.
  assert.throws(() => takeLook(dir, {}), /allows judging looks only/);
});

// ------------------------------------------------------------------------------------------------
// Summary and flagged decisions

const rec = (day, category, over = {}) => ({
  key: `${day}-${category}`, t: `${day}T15:00:02.000Z`, day, symbol: 'MNQ', barT: `${day}T14:57:00.000Z`, category, severity: F.severityOf({ category, expected: { ceiling: 0 }, reasons: { claims: [] } }),
  facts: { et: '10:00', window: DRIVE, news: null, trendRule: { prevailing: null }, setups: [], attempt: null },
  expected: { decision: 'no-trade', setup: null, ceiling: 0, decidedBy: 'no setup' }, actual: { action: 'none', setup: null, size: null, result: 'CYCLE RESULT: no-trade - x', gate: null },
  reasons: { claims: [] }, why: [], flow: { status: 'none', setups: [] }, claimChecks: { status: 'not checked' }, data: { values: 'absent', archive: 'none', scanned: true, rebuilt: null },
  provenance: { cycleFile: 'logs/cycles/x/1.json', promptHash: 'h' }, ...over,
});

test('failureSummary: counts and rates per run, per day and per type, with severities, timing, field checks and data', () => {
  const timing = { claims: [{ kind: 'no-entry-window', check: false, clause: 'session closed', why: 'allows' }] };
  const records = [
    rec('2026-03-03', 'right'), rec('2026-03-03', 'wrong-side entry'), rec('2026-03-03', 'wrong stated reason', { severity: 'medium', reasons: timing }),
    rec('2026-03-04', 'unchecked', { data: { values: 'error', archive: 'pruned', scanned: false, rebuilt: false } }), rec('2026-03-04', 'risk-rule rejection', { severity: 'medium', flow: { status: 'consistent' }, claimChecks: { status: 'checked' } }),
  ];
  const s = F.failureSummary(records);
  assert.deepStrictEqual([s.decisions, s.failures, s.failureRate], [5, 3, 0.6]);
  assert.deepStrictEqual(s.types['wrong-side entry'], { n: 1, rate: 0.2, high: 1, medium: 0, low: 0 });
  assert.deepStrictEqual(s.types['wrong stated reason'], { n: 1, rate: 0.2, high: 0, medium: 1, low: 0 });
  assert.deepStrictEqual(s.severity, { high: 1, medium: 2, low: 0 });
  assert.deepStrictEqual(s.days.map(d => [d.day, d.decisions, d.failures, d.failureRate, d.sessionTiming]), [['2026-03-03', 3, 2, 0.6667, 1], ['2026-03-04', 2, 1, 0.5, 0]]);
  assert.deepStrictEqual(s.days[1].types['risk-rule rejection'], { n: 1, rate: 0.5 });
  assert.deepStrictEqual(s.sessionTiming, { decisions: 1, claims: 1, rate: 0.2 });
  assert.deepStrictEqual(s.fields, { consistent: 1 });
  assert.deepStrictEqual(s.claimChecks, { checked: 1, notChecked: 4 });
  assert.deepStrictEqual(s.data, { valuesAbsent: 4, valuesError: 1, valuesNone: 0, archiveError: 0, archivePruned: 1, archiveNone: 4, notScanned: 1, notRebuilt: 1 });
  assert.deepStrictEqual(F.failureSummary([]).failureRate, null);
  const md = F.failureMarkdown(s);
  for (const h of ['## Failures by type', '## Failures by session day', '## Session timing, field checks, claim checks, data']) assert.ok(md.includes(h), h);
  assert.match(md, /\| 2026-03-03 \| 3 \| 2 \| 66\.7% \| 1 \| 0 \| 0 \| 0 \| 1 \| 0 \| 1 \|/);
});

test('flaggedEntry: what the model saw (pointers), what it did, what the code found, and the sentence a review reads', () => {
  const r = rec('2026-03-03', 'wrong stated reason', { severity: 'medium', actual: { action: 'none', setup: null, size: null, result: 'CYCLE RESULT: blocked - Session closed.', gate: null }, reasons: { claims: [{ kind: 'no-entry-window', check: false, clause: 'Session closed', why: 'the opening drive window allows entries (10:00 ET)' }] } });
  const e = F.flaggedEntry(r, { runId: 'run1', decisionFile: 'replay/run1/2026-03-03.jsonl' });
  assert.deepStrictEqual(e.failure, { category: 'wrong stated reason', severity: 'medium', step: 'no setup', sessionTiming: true });
  assert.deepStrictEqual(e.saw.decisionLine, { file: 'replay/run1/2026-03-03.jsonl', t: r.t });
  assert.deepStrictEqual([e.saw.cycleFile, e.saw.promptHash, e.saw.scanLog.file], ['logs/cycles/x/1.json', 'h', 'logs/scans-2026-03-03.jsonl']);
  assert.deepStrictEqual(e.found.sessionTiming, [{ clause: 'Session closed', fact: 'the opening drive window allows entries (10:00 ET)' }]);
  assert.strictEqual(e.review, 'At 10:00 ET on 2026-03-03 (MNQ), you took no trade and stated: "blocked - Session closed". The code scored it wrong stated reason (medium). False by the facts: "Session closed" (the opening drive window allows entries (10:00 ET)). This is a session-timing misread: the window and whether it allows entries are in the briefing.');
  const md = F.flaggedMarkdown('run1', [e]);
  assert.match(md, /^# Flagged decisions: run1/);
  assert.match(md, /## 2026-03-03 10:00 ET MNQ: wrong stated reason \(medium\)/);
  assert.match(md, /- Record: replay\/run1\/2026-03-03\.jsonl at 2026-03-03T15:00:02\.000Z; cycle logs\/cycles\/x\/1\.json/);
});

// ------------------------------------------------------------------------------------------------
// End to end: a synthetic run home, two days, with recorded field values on the new lines and none on the old

const RUN = 'fx1';
const D1 = '2026-03-03';
const D2 = '2026-03-04';
const iso = ms => new Date(ms).toISOString();
// 10:00 ET in March before the clocks change (EST): 15:00Z; the decision 2 s after its 3-minute bar closes.
const at = (day, hh, mm) => Date.parse(`${day}T${String(hh + 5).padStart(2, '0')}:${String(mm).padStart(2, '0')}:02Z`);
const MTF = { prevailing: '4h up', longAllowed: true, shortAllowed: false };
const ACCOUNTS = [{ name: 'acct_a', daily_loss_limit: 2000, daily_loss_soft: 1000 }];
const ATTEMPT = { account: 'acct_a', status: 'active', balance: 100000, floor: 97000, cushion: 3000, profit: 0, target: 6000, dayPnl: 0, sessionsLeft: 30, entryBlock: null };
const order = (setup, side) => ({ tool: 'place_order', input: { accountId: 7, contractId: 'MNQ', side: side === 'long' ? 'buy' : 'sell', type: 'market', size: 1, stopLossBracket: { ticks: 40, type: 'stop' }, rationale: `setup:${setup} ${side}` } });
const vals = (barT, v) => [{ symbol: 'MNQ', contractId: 'MNQ', barT, strategies: { fx_fields: v } }];

const STEPS = [
  // Day 1 (the old lines, no values): a session-timing misread, a right skip at the daily break.
  { day: D1, t: at(D1, 10, 48), oldLine: true, scan: [{ name: 'plain', candidate: false, mtf: MTF }], cycle: { result: 'CYCLE RESULT: blocked - Session closed (10:48 ET < 18:00 ET open), no strategy candidates' } },
  { day: D1, t: at(D1, 16, 30), oldLine: true, scan: [{ name: 'plain', candidate: false, mtf: MTF }], cycle: { result: 'CYCLE RESULT: blocked - Session closed, opens 18:00 ET' } },
  // Day 2 (values recorded): an entry on a field setup the scan did not list whose values say short: wrong side.
  { day: D2, t: at(D2, 10, 0), values: { 'a.b': -0.6, 'a.c[1]': 1 }, scan: [{ name: 'plain', candidate: true, direction: 'long', stopDistance: 10, mtf: MTF }, { name: 'fx_fields', candidate: false, mtf: MTF }], cycle: { orders: [order('fx_fields', 'long')], result: 'CYCLE RESULT: executed - fx_fields long' } },
  // The same entry, the values agreeing: not flagged (planted right).
  { day: D2, t: at(D2, 10, 3), values: { 'a.b': 0.6, 'a.c[1]': 1 }, scan: [{ name: 'plain', candidate: true, direction: 'long', stopDistance: 10, mtf: MTF }, { name: 'fx_fields', candidate: false, mtf: MTF }], cycle: { orders: [order('fx_fields', 'long')], result: 'CYCLE RESULT: executed - fx_fields long' } },
  // Values neither side holds: bad size (the order says no trade).
  { day: D2, t: at(D2, 10, 6), values: { 'a.b': 0.1, 'a.c[1]': 1 }, scan: [{ name: 'plain', candidate: true, direction: 'long', stopDistance: 10, mtf: MTF }], cycle: { orders: [order('fx_fields', 'long')], result: 'CYCLE RESULT: executed - fx_fields long' } },
  // Taking the values failed on this line: an error, counted, never a failure.
  { day: D2, t: at(D2, 10, 9), values: null, errors: ['MNQ: strategy scan failed (boom)', 'MNQ: could not archive the bars (disk full)'], scan: [{ name: 'plain', candidate: true, direction: 'long', stopDistance: 10, mtf: MTF }], cycle: { orders: [order('fx_fields', 'long')], result: 'CYCLE RESULT: executed - fx_fields long' } },
  // The gate refused an entry.
  { day: D2, t: at(D2, 10, 12), values: {}, scan: [{ name: 'plain', candidate: true, direction: 'long', stopDistance: 10, mtf: MTF }], cycle: { orders: [{ ...order('plain', 'long'), gate: { decision: 'blocked', violations: [{ check: 'order-pending', message: 'no' }] } }], result: 'CYCLE RESULT: blocked - the gate refused' } },
  // A right decision whose stated reason the cycle's own check had found false: still stated.
  { day: D2, t: at(D2, 10, 15), values: {}, scan: [{ name: 'plain', candidate: false, mtf: MTF }], cycle: { reasonChecks: [{ kind: 'trend-blocks', clause: 'EMA tangled', check: false, why: 'the trend rule allows long' }], result: 'CYCLE RESULT: no-trade - EMA tangled' } },
  // An entry whose result starts with no outcome word: a window claim is still no ground for it, never a misread.
  { day: D2, t: at(D2, 10, 18), values: {}, scan: [{ name: 'plain', candidate: true, direction: 'long', stopDistance: 10, mtf: MTF }], cycle: { orders: [order('plain', 'long')], result: 'CYCLE RESULT: long MNQ - market closed' } },
];

function makeRun() {
  const home = path.join(tmpDir(), 'replays', RUN);
  const runDir = path.join(home, 'replay', RUN);
  for (const d of [runDir, path.join(home, 'logs', 'cycles', '2026-10-11'), path.join(runDir, 'broker')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ v: 1, runId: RUN, hash: 'd'.repeat(64), harness: 'custom', model: 'm-1', daysDone: [D1, D2], finished: true }));
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ symbols: ['MNQ'], timeframe: 3, account: '7', bars: 3000 }));
  const lines = { [D1]: [], [D2]: [] };
  const gate = [];
  const scans = { [D1]: [], [D2]: [] };
  for (const [i, s] of STEPS.entries()) {
    const barT = iso(s.t - 182000);
    const wall = Date.parse('2026-10-11T00:00:00Z') + i * 60000;
    const rec = { v: 1, t: iso(s.t), day: s.day, kind: 'trade', ran: [], cycles: [], refusals: [], errors: s.errors || [], bars: [{ symbol: 'MNQ', lastBarT: barT }], trades: [], since: iso(s.t - 180000) };
    if (!s.oldLine) rec.values = s.values ? vals(barT, s.values) : [];
    scans[s.day].push({ at: iso(s.t), symbol: 'MNQ', contractId: 'MNQ', bar: { t: barT, c: 0 }, decision: { run: true, reason: 'bar closed' }, candidates: s.scan.filter(r => r.candidate).map(r => r.name), results: s.scan });
    const c = s.cycle;
    const file = path.join(home, 'logs', 'cycles', '2026-10-11', `${String(i).padStart(6, '0')}-trade.json`);
    const transcript = (c.orders || []).map((o, j) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `c${i}-${j}`, name: `mcp__broker__${o.tool}`, input: o.input }] } })).join('\n');
    fs.writeFileSync(file, JSON.stringify({ at: iso(wall), action: 'trade', prompt: `p${i}`, context: { symbols: [{ symbol: 'MNQ', bar: { t: barT, c: 0 } }], account: { id: 7, balance: 100000, positions: [], workingOrders: 0 }, openTrades: [], attempts: [ATTEMPT] }, transcript, ...(c.reasonChecks ? { reasonChecks: c.reasonChecks } : {}) }));
    rec.ran.push({ action: 'trade', ok: true, timedOut: false, result: c.result, symbols: ['MNQ'] });
    rec.cycles.push({ action: 'trade', at: iso(wall), ok: true, timedOut: false, durationMs: 30000, result: c.result, promptHash: `h${i}`, file });
    for (const [j, o] of (c.orders || []).entries()) gate.push({ ts: iso(wall + 1000 + j * 100), tool: o.tool, source: 'gateway', decision: 'allowed', violations: [], ...(o.gate || {}), contractId: o.input.contractId, rationale: o.input.rationale });
    lines[s.day].push(rec);
  }
  const jsonl = xs => xs.map(x => `${JSON.stringify(x)}\n`).join('');
  for (const d of [D1, D2]) {
    fs.writeFileSync(path.join(runDir, `${d}.jsonl`), jsonl(lines[d]));
    fs.writeFileSync(path.join(home, 'logs', `scans-${d}.jsonl`), jsonl(scans[d]));
  }
  fs.writeFileSync(path.join(home, 'logs', 'gate-log.jsonl'), jsonl(gate));
  fs.writeFileSync(path.join(runDir, 'broker', 'journal.jsonl'), '');
  return { home, runDir };
}

test('e2e: a run scored, its failures typed with severity, counted per day, and written as flagged decisions', () => {
  const { runDir } = makeRun();
  const { records, summary } = scoreRun(runDir, { strategies: [FIELDS, PLAIN], accounts: ACCOUNTS });
  assert.deepStrictEqual(records.map(r => [r.facts.et, r.category, r.severity]), [
    ['10:48', 'wrong stated reason', 'medium'],
    ['16:30', 'right', null],
    ['10:00', 'wrong-side entry', 'high'],
    ['10:03', 'unchecked', null],
    ['10:06', 'bad size', 'high'],
    ['10:09', 'unchecked', null],
    ['10:12', 'risk-rule rejection', 'medium'],
    ['10:15', 'wrong stated reason', 'medium'],
    ['10:18', 'unchecked', null],
  ]);
  assert.match(records[2].why.join(' '), /fx_fields's field conditions fail for a long and its short conditions \(all on fields\) hold/);
  assert.deepStrictEqual(records.map(r => r.flow.status), ['none', 'none', 'inconsistent', 'consistent', 'inconsistent', 'error', 'none', 'none', 'none']);
  assert.deepStrictEqual(records[8].reasons.claims.map(c => [c.kind, c.check]), [['no-entry-window', 'unchecked']]);
  assert.deepStrictEqual(records.map(r => r.data.values), ['absent', 'absent', 'recorded', 'recorded', 'recorded', 'error', 'recorded', 'recorded', 'recorded']);
  assert.strictEqual(records[5].data.archive, 'error');
  assert.deepStrictEqual(records.map(r => r.claimChecks.status), ['not checked', 'not checked', 'not checked', 'not checked', 'not checked', 'not checked', 'not checked', 'checked', 'not checked']);
  const f = summary.failures;
  assert.deepStrictEqual([f.decisions, f.failures, f.severity], [9, 5, { high: 2, medium: 3, low: 0 }]);
  assert.deepStrictEqual(f.days.map(d => [d.day, d.decisions, d.failures, d.sessionTiming]), [[D1, 2, 1, 1], [D2, 7, 4, 0]]);
  assert.deepStrictEqual(f.sessionTiming, { decisions: 1, claims: 1, rate: 0.1111 });
  assert.deepStrictEqual(f.fields, { consistent: 1, error: 1, inconsistent: 2 });
  assert.deepStrictEqual([f.data.valuesAbsent, f.data.valuesError, f.data.archiveError], [2, 1, 1]);
  assert.match(summary.outcomes, /hidden/, 'a Recent run: a reasoning-fix look, outcomes hidden');
  assert.ok(records.every(r => !('trade' in r) && !('counterfactual' in r) && !('pacing' in r)));
  assert.deepStrictEqual(summary.look, { purpose: 'reasoning-fix', candidate: 'scorecard:fx1', ranges: [{ from: D1, to: D2 }, { from: D2, to: '2026-03-05' }], units: [{ key: 'recent [2025-07-01, 2026-07-01)', role: 'recent' }] });

  const out = path.join(tmpDir(), 'fx-out');
  const res = writeScorecard(runDir, { strategies: [FIELDS, PLAIN], accounts: ACCOUNTS, outDir: out });
  assert.strictEqual(res.flagged, 5);
  const flagged = fs.readFileSync(path.join(out, 'flagged.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(flagged.map(e => e.failure.category), ['wrong stated reason', 'wrong-side entry', 'bad size', 'risk-rule rejection', 'wrong stated reason']);
  assert.deepStrictEqual(flagged[0].saw.decisionLine, { file: `replay/${RUN}/${D1}.jsonl`, t: records[0].t });
  assert.match(flagged[0].saw.cycleFile, /^logs\/cycles\/2026-10-11\/000000-trade\.json$/);
  // Every pointer leads to a file in the run home.
  for (const e of flagged) for (const p of [e.saw.decisionLine.file, e.saw.cycleFile, e.saw.scanLog.file]) assert.ok(fs.existsSync(path.join(path.dirname(path.dirname(runDir)), p)), p);
  assert.match(flagged[1].review, /you entered long on fx_fields with 1/);
  const md = fs.readFileSync(path.join(out, 'scorecard.md'), 'utf8');
  for (const h of ['## Failures by type', '## Failures by session day', '## Flagged decisions']) assert.ok(md.includes(h), h);
  assert.ok(fs.readFileSync(path.join(out, 'flagged.md'), 'utf8').includes('## 2026-03-04 10:00 ET MNQ: wrong-side entry (high)'));
  // Deterministic.
  assert.deepStrictEqual(scoreRun(runDir, { strategies: [FIELDS, PLAIN], accounts: ACCOUNTS }), { records, summary });
});
