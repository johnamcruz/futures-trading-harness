'use strict';

// Prepare ahead, shadow mode (scripts/lib/prepare-ahead.js, docs/PREPARE-AHEAD.md, PR B1): the pure logic the runner's
// shadow runs on. The failure table (docs/PREPARE-AHEAD.md "Shadow mode") one test per row, the version comparison one
// test per input, the plan file, the deadline on the harness clock, the plan and decision parsing, and the agreement
// check (with a test that it can disagree).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PA = require('../../scripts/lib/prepare-ahead');
const B = require('../../scripts/lib/trading/briefing');
const NC = require('../../scripts/lib/trading/next-close');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const FX = require('../fixtures/momentum-continuation');

const ROOT = path.resolve(__dirname, '..', '..');
const REG = loadStrategies(ROOT, {}).strategies;
const BARS = FX.load();
const at = t => BARS.findIndex(b => b.t === t);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-prepare-'));

// A plan for the close of 13:42 UTC's bar (opening 13:42, closing 13:45), made at the 13:39 bar's close.
const T = '2021-05-24T13:39:00.000Z';
const NEXT = { t: '2021-05-24T13:42:00.000Z', closedAt: '2021-05-24T13:45:00.000Z' };
const sec = (name, at0, until) => ({ version: `${name}@${at0}`, validUntil: until });
/** A briefing's parts as versionsOf reads them: section versions and their ends, the trend rule, the window. */
const briefingAt = ({ asOf = T, closedAt = NEXT.t, m3 = closedAt, m15 = '2021-05-24T13:30:00.000Z', m15Until = NEXT.closedAt, h1 = '2021-05-24T13:00:00.000Z', h1Until = '2021-05-24T14:00:00.000Z', day = '2021-05-23T22:00:00.000Z', dayUntil = '2021-05-24T22:00:00.000Z', trendRule = 'Trend rule: long allowed, short refused', windowEntries = 'allowed' } = {}) => ({
  symbol: 'MNQ', minutes: 3, asOf, closedAt,
  sections: {
    m3: { ...sec('m3', m3, new Date(Date.parse(closedAt) + 180000).toISOString()), data: { trendRule, windowEntries } },
    m15: sec('m15', m15, m15Until), h1: sec('h1', h1, h1Until), day: sec('day', day, dayUntil),
  },
});
const DESK = [{ role: 'market-structure-analyst', text: '## ms\nBias: long', until: '2021-05-24T13:45:00.000Z' }, { role: 'trend-momentum-analyst', text: '## tm\nBias: long', until: '2021-05-24T14:00:00.000Z' }, { role: 'risk-manager', text: '## Risk state', until: null }];
const planVersions = (o = {}) => PA.versionsOf({ briefing: briefingAt(o.b), chainSide: 'chainSide' in o ? o.chainSide : 1, factsKey: 'factsKey' in o ? o.factsKey : 'k1', desk: PA.deskKeys(o.desk || DESK), day: o.day || '2021-05-24', news: o.news || { inBlackout: false } });
/** The at-close versions: the next bar's briefing (m3 rolled to the next close), everything else as planned unless said. */
// (The plan's 15m part ends at the next close, a 15m close: there it rolls to the new candle.)
const closeVersions = (o = {}) => PA.versionsOf({ briefing: briefingAt({ asOf: NEXT.t, closedAt: NEXT.closedAt, m15: NEXT.closedAt, m15Until: '2021-05-24T14:00:00.000Z', ...(o.b || {}) }), chainSide: 'chainSide' in o ? o.chainSide : 1, factsKey: 'factsKey' in o ? o.factsKey : 'k1', desk: PA.deskKeys(o.desk || DESK), day: o.day || '2021-05-24', news: o.news || { inBlackout: false } });
const PLAN_TEXT = [
  'Bias long; the 3m momentum is the setup.',
  'SCENARIO 1: P1 momentum_continuation long "momentum_continuation fired up" → TAKE if the 3m closes in its top third with range >= 9.5 and volume >= 1200 | PASS if it closes under the VWAP; reads: "momentum_continuation fired up", "3m momentum up", "stop 3m low", "target 2r"; why: the trend is up and the momentum is with it',
  'SCENARIO 2: P2 15m rejected prior VAH up → TAKE if the 15m closes back above 13650 | PASS if it closes below; reads: "15m rejected prior VAH up"; why: a reclaim of value',
  'STAND DOWN if: the daily room is under one stop, or a news window starts',
  'INVALID if: a fill, or the 15m closes below the overnight low',
].join('\n');
const CANDS = [{ id: 'P1', kind: 'momentum', read: 'momentum_continuation fired up', side: 'long', tf: '3m' }, { id: 'P2', kind: 'reaction', read: '15m rejected prior VAH up', side: 'long', tf: '15m' }];
const makePlan = (o = {}) => PA.makePlan({ symbol: 'MNQ', bar: T, next: NEXT, madeAt: '2021-05-24T13:43:10.000Z', ms: 41000, session: { id: 'ses-prep', transcript: o.transcript === undefined ? null : o.transcript }, versions: planVersions(o), candidates: CANDS, text: PLAN_TEXT, usage: null, ...(o.plan || {}) });

// --- The mode key ---------------------------------------------------------------------------------------------------

test('prepare-ahead: the mode key takes off and shadow on Claude Code; on is refused until B2, anything else is refused, another harness is refused', () => {
  assert.deepStrictEqual([...PA.MODES], ['off', 'shadow']);
  assert.strictEqual(PA.modeProblem(undefined, 'claude'), null);
  assert.strictEqual(PA.modeProblem('off', 'claude'), null);
  assert.strictEqual(PA.modeProblem('shadow', 'claude'), null);
  assert.match(PA.modeProblem('on', 'claude'), /"on" is not built yet .*B2.*shadow/);
  for (const bad of [true, false, 'yes', 1, null]) assert.match(PA.modeProblem(bad, 'claude'), /prepareAhead: "off" or "shadow"/, String(bad));
  assert.match(PA.modeProblem('shadow', 'opencode'), /for harness "claude" only/);
  assert.strictEqual(PA.modeProblem('off', 'opencode'), null, 'off is no delivery on any harness');
  assert.strictEqual(PA.shadowOn({ harness: 'claude', prepareAhead: 'shadow' }), true);
  for (const cfg of [{ harness: 'claude' }, { harness: 'claude', prepareAhead: 'off' }, { harness: 'opencode', prepareAhead: 'shadow' }, null]) assert.strictEqual(PA.shadowOn(cfg), false, JSON.stringify(cfg));
});

// --- The deadline: the next close minus the margin, the end of day, the most a prepare may take; the harness clock -----

test('prepare-ahead: the deadline is the earliest of the next close minus the margin, the end of day and now plus the most a prepare may take', () => {
  const now = Date.parse('2021-05-24T13:42:20.000Z');
  const next = Date.parse(NEXT.closedAt);
  assert.deepStrictEqual(PA.deadlineOf({ nowMs: now, nextCloseMs: next, eodMs: null, marginMs: 20000, maxMs: 600000 }), { atMs: next - 20000, budgetMs: next - 20000 - now, by: 'next-close' });
  assert.deepStrictEqual(PA.deadlineOf({ nowMs: now, nextCloseMs: next, eodMs: null, marginMs: 20000, maxMs: 60000 }), { atMs: now + 60000, budgetMs: 60000, by: 'max' });
  assert.deepStrictEqual(PA.deadlineOf({ nowMs: now, nextCloseMs: next, eodMs: now + 30000, marginMs: 20000, maxMs: 600000 }), { atMs: now + 30000, budgetMs: 30000, by: 'end-of-day' });
  // Past it: no time left (never a negative budget).
  assert.deepStrictEqual(PA.deadlineOf({ nowMs: next - 5000, nextCloseMs: next, eodMs: null, marginMs: 20000, maxMs: 600000 }), { atMs: next - 20000, budgetMs: 0, by: 'next-close' });
  // At the deadline exactly: no time left.
  assert.strictEqual(PA.deadlineOf({ nowMs: next - 20000, nextCloseMs: next, eodMs: null, marginMs: 20000, maxMs: 600000 }).budgetMs, 0);
  assert.strictEqual(PA.deadlineOf({ nowMs: next - 20001, nextCloseMs: next, eodMs: null, marginMs: 20000, maxMs: 600000 }).budgetMs, 1);
  // A clock that can't be read: no time.
  assert.strictEqual(PA.deadlineOf({ nowMs: NaN, nextCloseMs: next, eodMs: null, marginMs: 20000, maxMs: 600000 }).budgetMs, 0);
});

test('prepare-ahead: a run done after its deadline is aborted, judged by the clock given (never the wall clock)', () => {
  const d = { atMs: Date.parse('2021-05-24T13:44:40.000Z') };
  assert.strictEqual(PA.overran(d, Date.parse('2021-05-24T13:44:40.000Z')), false, 'at the deadline: done');
  assert.strictEqual(PA.overran(d, Date.parse('2021-05-24T13:44:40.001Z')), true);
  assert.strictEqual(PA.overran(d, NaN), true, 'an unreadable clock: aborted');
});

test('prepare-ahead: the module never reads the wall clock (no Date.now, no new Date() without a time)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'prepare-ahead.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/Date\.now/.test(src), 'Date.now');
  assert.ok(!/new Date\(\s*\)/.test(src), 'new Date()');
  assert.ok(!/performance\.now/.test(src), 'performance.now');
});

// --- When a prepare runs (the failure table's no-prepare rows) -----------------------------------------------------------

test('prepare-ahead: a prepare runs only flat, with a candidate, in session, with the kill switch off and time left', () => {
  const section = { none: null, candidates: CANDS };
  const ok = { killSwitch: false, flat: true, section, inSession: true, budgetMs: 90000 };
  assert.deepStrictEqual(PA.shouldPrepare(ok), { ok: true, why: null });
  assert.deepStrictEqual(PA.shouldPrepare({ ...ok, killSwitch: true }), { ok: false, why: 'kill-switch' });
  // An open position or a working order (management work is due): no prepare in v1.
  assert.deepStrictEqual(PA.shouldPrepare({ ...ok, flat: false }), { ok: false, why: 'not-flat' });
  assert.deepStrictEqual(PA.shouldPrepare({ ...ok, flat: null }), { ok: false, why: 'not-flat' }, 'an unread account is not flat');
  assert.deepStrictEqual(PA.shouldPrepare({ ...ok, section: { none: 'nothing in reach can fire', candidates: [] } }), { ok: false, why: 'nothing-can-fire' });
  assert.deepStrictEqual(PA.shouldPrepare({ ...ok, section: null }), { ok: false, why: 'no-section' });
  assert.deepStrictEqual(PA.shouldPrepare({ ...ok, inSession: false }), { ok: false, why: 'out-of-session' });
  assert.deepStrictEqual(PA.shouldPrepare({ ...ok, budgetMs: 0 }), { ok: false, why: 'no-time' });
  // The kill switch first: whatever else holds.
  assert.strictEqual(PA.shouldPrepare({ killSwitch: true, flat: false, section: null, inSession: false, budgetMs: 0 }).why, 'kill-switch');
});

// --- The plan file: keyed by symbol and the bar it is for, written atomically ------------------------------------------

test('prepare-ahead: the plan file is keyed by symbol and the bar it is for, written whole (atomic), read back; an earlier bar\'s is never read as this one\'s', () => {
  const home = tmp();
  const plan = makePlan();
  const file = PA.writePlan(home, plan);
  assert.strictEqual(file, PA.planFile(home, 'MNQ', NEXT.t));
  assert.strictEqual(path.dirname(file), path.join(home, 'prepare'));
  assert.deepStrictEqual(PA.readPlan(home, 'MNQ', NEXT.t), plan);
  // No temp file left beside it.
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'prepare')), [path.basename(file)]);
  // Another bar, another symbol: none.
  assert.strictEqual(PA.readPlan(home, 'MNQ', '2021-05-24T13:45:00.000Z'), null);
  assert.strictEqual(PA.readPlan(home, 'MES', NEXT.t), null);
  // A plan file whose own bar isn't the one asked for (renamed, copied): refused, never read as this bar's.
  fs.copyFileSync(file, PA.planFile(home, 'MNQ', '2021-05-24T13:45:00.000Z'));
  assert.strictEqual(PA.readPlan(home, 'MNQ', '2021-05-24T13:45:00.000Z'), null);
  // A torn or unreadable file: none.
  fs.writeFileSync(file, '{"v":1,');
  assert.strictEqual(PA.readPlan(home, 'MNQ', NEXT.t), null);
});

test('prepare-ahead: the plan write is atomic: a write that fails leaves the earlier file whole and no temp file', () => {
  const home = tmp();
  const plan = makePlan();
  PA.writePlan(home, plan);
  const cyclic = { ...plan, text: 'second' };
  cyclic.self = cyclic; // JSON.stringify throws
  assert.throws(() => PA.writePlan(home, cyclic));
  assert.deepStrictEqual(PA.readPlan(home, 'MNQ', NEXT.t), plan);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'prepare')).length, 1);
  // The writer renames a temp file over the target (harness-run.js writeJsonAtomic; never the target in place).
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'prepare-ahead.js'), 'utf8');
  assert.match(src, /writeJsonAtomic\(file, plan\)/);
});

test('prepare-ahead: the plan records the session, the input versions and the plan text, with an id of its own', () => {
  const plan = makePlan({ transcript: '/tmp/x.jsonl' });
  assert.match(plan.id, /^[0-9a-f]{12}$/);
  assert.deepStrictEqual(plan.session, { id: 'ses-prep', transcript: '/tmp/x.jsonl' });
  assert.strictEqual(plan.next.t, NEXT.t);
  assert.strictEqual(plan.versions.factsKey, 'k1');
  assert.deepStrictEqual(plan.scenarios.map(s => s.k), [1, 2]);
  assert.strictEqual(plan.text, PLAN_TEXT);
  assert.notStrictEqual(makePlan({ plan: { session: { id: 'ses-other', transcript: null } } }).id, plan.id, 'another session, another id');
});

// --- The version comparison, one test per input ---------------------------------------------------------------------------

test('prepare-ahead: validate: every input as planned (the 3m rolled by exactly one bar) is valid', () => {
  assert.deepStrictEqual(PA.validate(makePlan(), closeVersions()), { status: 'valid' });
});

test('prepare-ahead: validate: no plan, or a stale plan from an earlier bar, is never a valid one', () => {
  assert.deepStrictEqual(PA.validate(null, closeVersions()), { status: 'none', reason: 'no-plan' });
  // The close is a later bar than the plan was for: stale.
  const later = PA.versionsOf({ briefing: briefingAt({ asOf: '2021-05-24T13:45:00.000Z', closedAt: '2021-05-24T13:48:00.000Z' }), chainSide: 1, factsKey: 'k1', desk: PA.deskKeys(DESK), day: '2021-05-24', news: { inBlackout: false } });
  assert.deepStrictEqual(PA.validate(makePlan(), later), { status: 'stale', reason: 'stale', detail: `the plan is for the bar opening ${NEXT.t}, the close is ${'2021-05-24T13:45:00.000Z'}'s` });
});

test('prepare-ahead: validate: a fill, a position or a P&L change (the phase-1 facts key) voids; an unknown key voids', () => {
  assert.deepStrictEqual(PA.validate(makePlan(), closeVersions({ factsKey: 'k2' })), { status: 'void', reason: 'facts', detail: 'the account\'s facts changed (a fill, a position or the P&L)' });
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ factsKey: null })).reason, 'facts-unknown');
  assert.strictEqual(PA.validate(makePlan({ factsKey: null }), closeVersions({ factsKey: null })).reason, 'facts-unknown', 'null equal to null is no match');
});

test('prepare-ahead: validate: the chain side flipping voids; the trend rule changing voids', () => {
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ chainSide: -1 })).reason, 'chain-side');
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ chainSide: 0 })).reason, 'chain-side');
  assert.strictEqual(PA.validate(makePlan({ chainSide: null }), closeVersions({ chainSide: null })).reason, 'chain-side', 'an unknown side is no match');
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ b: { trendRule: 'Trend rule: long refused, short allowed' } })).reason, 'trend-rule');
});

test('prepare-ahead: validate: a news blackout or a stand-down window starting at the close voids', () => {
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ news: { inBlackout: true, reason: 'CPI' } })).reason, 'news');
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ news: { inBlackout: null, error: 'unreadable' } })).reason, 'news', 'unknown is no all-clear');
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ b: { windowEntries: 'none' } })).reason, 'window');
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ b: { windowEntries: null } })).reason, 'window');
});

test('prepare-ahead: validate: the base bars must advance by exactly one bar (a skipped or repeated bar voids)', () => {
  // The close's 3m part not at the planned close: a skipped bar, or the same bar again.
  const skipped = closeVersions({ b: { m3: '2021-05-24T13:48:00.000Z' } });
  assert.strictEqual(PA.validate(makePlan(), skipped).reason, 'bars:m3');
  const same = closeVersions({ b: { m3: NEXT.t } });
  assert.strictEqual(PA.validate(makePlan(), same).reason, 'bars:m3');
});

test('prepare-ahead: validate: the 15m may roll only at a close the plan was made for (its part ending by then); else it must be as planned', () => {
  // The plan's 15m part ends at the next close: it must roll to it there.
  assert.deepStrictEqual(PA.validate(makePlan(), closeVersions()), { status: 'valid' });
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ b: { m15: '2021-05-24T13:30:00.000Z' } })).reason, 'bars:m15', 'expected to roll, but did not');
  // A plan whose 15m part holds past the close: it may not change.
  const holding = makePlan({ b: { m15Until: '2021-05-24T14:00:00.000Z' } });
  assert.deepStrictEqual(PA.validate(holding, closeVersions({ b: { m15: '2021-05-24T13:30:00.000Z' } })), { status: 'valid' });
  assert.strictEqual(PA.validate(holding, closeVersions({ b: { m15: NEXT.closedAt, m15Until: '2021-05-24T14:00:00.000Z' } })).reason, 'bars:m15');
});

test('prepare-ahead: validate: a 1h or day close at the next close voids (no scenario covers it); a changed 1h or day part voids', () => {
  const hourly = makePlan({ b: { h1Until: NEXT.closedAt } });
  assert.strictEqual(PA.validate(hourly, closeVersions({ b: { h1: NEXT.closedAt, h1Until: '2021-05-24T15:00:00.000Z' } })).reason, 'htf-close:h1');
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ b: { h1: '2021-05-24T12:00:00.000Z' } })).reason, 'bars:h1');
  const daily = makePlan({ b: { dayUntil: NEXT.closedAt } });
  assert.strictEqual(PA.validate(daily, closeVersions({ b: { dayUntil: NEXT.closedAt } })).reason, 'htf-close:day');
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ b: { day: '2021-05-22T22:00:00.000Z' } })).reason, 'bars:day');
});

test('prepare-ahead: validate: a desk report expected to hold past the close that changed voids; one ending by the close may change', () => {
  // The market structure report ends at the next close: a fresh one there is expected.
  const fresh = DESK.map(r => (r.role === 'market-structure-analyst' ? { ...r, text: '## ms\nBias: short' } : r));
  assert.deepStrictEqual(PA.validate(makePlan(), closeVersions({ desk: fresh })), { status: 'valid' });
  // The trend report holds past the close: a different one voids.
  const changed = DESK.map(r => (r.role === 'trend-momentum-analyst' ? { ...r, text: '## tm\nBias: short' } : r));
  assert.deepStrictEqual(PA.validate(makePlan(), closeVersions({ desk: changed })), { status: 'void', reason: 'desk', detail: 'trend-momentum-analyst\'s report changed before it was due' });
  // Missing at the close: changed.
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ desk: DESK.filter(r => r.role !== 'trend-momentum-analyst') })).reason, 'desk');
  // Phase 1 (no end of its own) is the facts key's: its text is not compared.
  assert.deepStrictEqual(PA.validate(makePlan(), closeVersions({ desk: DESK.map(r => (r.role === 'risk-manager' ? { ...r, text: 'other' } : r)) })), { status: 'valid' });
});

test('prepare-ahead: validate: the trading day changing voids', () => {
  assert.strictEqual(PA.validate(makePlan(), closeVersions({ day: '2021-05-25' })).reason, 'day');
});

test('prepare-ahead: validate: the prepare session\'s file missing voids (the confirm could not resume it); a plan with no file recorded is checked by the resume', () => {
  const home = tmp();
  const file = path.join(home, 'ses-prep.jsonl');
  assert.strictEqual(PA.validate(makePlan({ transcript: file }), closeVersions()).reason, 'session-missing');
  fs.writeFileSync(file, '{}\n');
  assert.deepStrictEqual(PA.validate(makePlan({ transcript: file }), closeVersions()), { status: 'valid' });
  assert.deepStrictEqual(PA.validate(makePlan({ transcript: null }), closeVersions()), { status: 'valid' });
  // No session id at all: missing.
  assert.strictEqual(PA.validate(makePlan({ plan: { session: { id: null, transcript: null } } }), closeVersions()).reason, 'session-missing');
});

// --- The plan's text and the match at the close ----------------------------------------------------------------------------

test('prepare-ahead: parsePlan reads each SCENARIO line (its candidate, TAKE and PASS conditions, reads, why), STAND DOWN and INVALID', () => {
  const p = PA.parsePlan(PLAN_TEXT);
  assert.deepStrictEqual(p.scenarios[0], {
    k: 1, id: 'P1', candidate: 'P1 momentum_continuation long "momentum_continuation fired up"',
    take: 'the 3m closes in its top third with range >= 9.5 and volume >= 1200', pass: 'it closes under the VWAP',
    reads: ['momentum_continuation fired up', '3m momentum up', 'stop 3m low', 'target 2r'], why: 'the trend is up and the momentum is with it',
    line: PLAN_TEXT.split('\n')[1],
  });
  assert.strictEqual(p.scenarios[1].id, 'P2');
  assert.deepStrictEqual(p.scenarios[1].reads, ['15m rejected prior VAH up']);
  assert.strictEqual(p.standDown, 'the daily room is under one stop, or a news window starts');
  assert.strictEqual(p.invalid, 'a fill, or the 15m closes below the overnight low');
  // ASCII arrows, list markers and bold are read the same; prose that only mentions SCENARIO is not a scenario.
  const q = PA.parsePlan('- **SCENARIO 3:** P1 x -> TAKE if a | PASS if b; reads: "r"; why: w\nI will write SCENARIO lines later.');
  assert.deepStrictEqual(q.scenarios.map(s => [s.k, s.id, s.take, s.pass]), [[3, 'P1', 'a', 'b']]);
  assert.deepStrictEqual(PA.parsePlan('').scenarios, []);
  assert.deepStrictEqual(PA.parsePlan(null), { scenarios: [], standDown: null, invalid: null });
});

test('prepare-ahead: what fired at the close is the real at-close scan (rules fired) and the at-close briefing\'s setups to check', () => {
  const scan = [{ name: 'momentum_continuation', candidate: true, direction: 'long', signal: 'rules' }, { name: 'x', candidate: false, direction: null, signal: 'rules' }, { name: 'p', candidate: true, direction: 'short', signal: 'policy' }];
  assert.deepStrictEqual(PA.firedReads({ scan, listed: ['15m rejected prior VAH up', '15m rejected prior VAH up'] }), ['momentum_continuation fired up', '15m rejected prior VAH up']);
  assert.deepStrictEqual(PA.firedReads({ scan: null, listed: null }), []);
});

test('prepare-ahead: match: a fired read that is a scenario\'s candidate is matched (by its id\'s read); one that is not is outside the plan; nothing fired is said', () => {
  const plan = makePlan();
  assert.deepStrictEqual(PA.matchScenario(plan, ['momentum_continuation fired up']), { status: 'matched', k: 1, id: 'P1', read: 'momentum_continuation fired up', side: 'long', unplanned: [] });
  assert.deepStrictEqual(PA.matchScenario(plan, ['15m  Rejected prior VAH up']), { status: 'matched', k: 2, id: 'P2', read: '15m rejected prior VAH up', side: 'long', unplanned: [] }, 'case and spaces');
  assert.deepStrictEqual(PA.matchScenario(plan, ['15m rejected VWAP up', 'momentum_continuation fired up']).unplanned, ['15m rejected VWAP up']);
  assert.deepStrictEqual(PA.matchScenario(plan, ['15m rejected VWAP up']), { status: 'outside', fired: ['15m rejected VWAP up'] });
  assert.deepStrictEqual(PA.matchScenario(plan, []), { status: 'nothing-fired', fired: [] });
  // A candidate the section listed but the plan wrote no scenario for: outside the plan.
  const one = makePlan({ plan: { text: PLAN_TEXT.split('\n').filter(l => !/SCENARIO 2/.test(l)).join('\n') } });
  assert.strictEqual(PA.matchScenario(one, ['15m rejected prior VAH up']).status, 'outside');
  // A scenario with no section id names its candidate by the read in quotes.
  const byRead = makePlan({ plan: { text: 'SCENARIO 1: "15m rejected prior VAH up" → TAKE if a | PASS if b; reads: "x"; why: y' } });
  assert.strictEqual(PA.matchScenario(byRead, ['15m rejected prior VAH up']).k, 1);
});

test('prepare-ahead: the outside-plan reads are told apart by the level kind v1 does not list (VWAP, profile, FVG, other)', () => {
  assert.strictEqual(PA.readKind('15m rejected VWAP up'), 'vwap');
  assert.strictEqual(PA.readKind('15m broke session VAH down'), 'profile');
  assert.strictEqual(PA.readKind('15m rejected developing POC up'), 'profile');
  assert.strictEqual(PA.readKind('15m rejected 15m FVG top up'), 'fvg');
  assert.strictEqual(PA.readKind('15m compression break up'), 'other');
  assert.strictEqual(PA.readKind('momentum_continuation fired up'), 'momentum');
});

// --- The shadow confirm's decision, the full cycle's, and the agreement -------------------------------------------------

test('prepare-ahead: parseDecision reads the last line-start DECISION line: TAKE k or PASS; anything else is none', () => {
  assert.deepStrictEqual(PA.parseDecision('The candle met it.\nDECISION: TAKE 1'), { decision: 'take', k: 1 });
  assert.deepStrictEqual(PA.parseDecision('DECISION: TAKE 1\nOn reflection no.\nDECISION: PASS - the volume fell short'), { decision: 'pass', k: null });
  assert.deepStrictEqual(PA.parseDecision('**DECISION: take 2**'), { decision: 'take', k: 2 });
  assert.strictEqual(PA.parseDecision('I would say DECISION: TAKE 1 if it closed higher'), null, 'not at a line start');
  assert.strictEqual(PA.parseDecision('DECISION: TAKE'), null, 'TAKE needs its scenario');
  assert.strictEqual(PA.parseDecision(''), null);
  assert.strictEqual(PA.parseDecision(null), null);
});

test('prepare-ahead: the full cycle\'s decision: executed is a take (its side), a head trader\'s no-trade a pass; blocked, vetoed, error or no result is none', () => {
  assert.deepStrictEqual(PA.fullDecisionOf({ result: 'CYCLE RESULT: executed - trade_lifecycle long 3', entry: { outcome: 'executed' } }), { decision: 'take', side: 'long', why: null });
  assert.deepStrictEqual(PA.fullDecisionOf({ result: 'CYCLE RESULT: no-trade - nothing met', entry: null }), { decision: 'pass', side: null, why: null });
  assert.deepStrictEqual(PA.fullDecisionOf({ result: 'CYCLE RESULT: no-trade - phase 2 vetoed it', entry: { outcome: 'vetoed' } }), { decision: null, side: null, why: 'vetoed' });
  assert.deepStrictEqual(PA.fullDecisionOf({ result: 'CYCLE RESULT: blocked - [late-entry]', entry: { outcome: 'blocked' } }), { decision: null, side: null, why: 'blocked' });
  assert.deepStrictEqual(PA.fullDecisionOf({ result: 'CYCLE RESULT: error - x', entry: null }), { decision: null, side: null, why: 'error' });
  assert.deepStrictEqual(PA.fullDecisionOf({ result: null, entry: null }), { decision: null, side: null, why: 'no result' });
  // A planned head trader whose entry didn't run to an order: not a pass, not a take.
  assert.deepStrictEqual(PA.fullDecisionOf({ result: 'CYCLE RESULT: planned - trade_lifecycle long 3', entry: { outcome: 'not-run' } }), { decision: null, side: null, why: 'planned' });
});

test('prepare-ahead: agreement: the same decision (a take on the same side) agrees; a deliberately wrong shadow decision is reported as a disagreement', () => {
  const take = { decision: 'take', side: 'long' };
  const pass = { decision: 'pass', side: null };
  assert.strictEqual(PA.agreement(take, take), true);
  assert.strictEqual(PA.agreement(pass, pass), true);
  // The honesty check: it can fail.
  assert.strictEqual(PA.agreement(take, pass), false);
  assert.strictEqual(PA.agreement(pass, take), false);
  assert.strictEqual(PA.agreement({ decision: 'take', side: 'short' }, take), false, 'the other side');
  // Unknown on either side: no verdict.
  assert.strictEqual(PA.agreement(null, take), null);
  assert.strictEqual(PA.agreement(take, { decision: null, side: null, why: 'blocked' }), null);
});

// --- The prompts: closed bars only in; at-close facts first in the confirm -----------------------------------------------

test('prepare-ahead: the prepare prompt holds the prepare briefing, the desk\'s reports and the plan format, and asks for no compose, order or role', () => {
  const p = PA.preparePrompt({ head: 'Autonomous cycle.', account: ' Account 7: flat.', reports: [{ role: 'trend-momentum-analyst', text: 'Bias: long' }], briefingText: 'BRIEFING-TEXT', next: NEXT });
  assert.ok(p.startsWith('Autonomous cycle.'));
  for (const s of ['BRIEFING-TEXT', 'Account 7: flat.', 'Bias: long', 'SCENARIO k:', 'STAND DOWN if:', 'INVALID if:', 'TAKE if', 'PASS if', 'reads:', 'why:', 'PLAN END']) assert.ok(p.includes(s), s);
  assert.match(p, /no compose_check, no order and no role/);
  assert.ok(!/CYCLE RESULT:/.test(p), 'no cycle result asked of a prepare');
});

test('prepare-ahead: the confirm prompt gives the at-close facts first, then "your plan said: scenario k", the candle-decides rule, and the shadow DECISION line', () => {
  const plan = makePlan();
  const s = plan.scenarios[0];
  const p = PA.confirmPrompt({ atCloseText: 'AT-CLOSE-FACTS', fired: ['momentum_continuation fired up'], scenario: s, next: NEXT });
  const facts = p.indexOf('AT-CLOSE-FACTS');
  const said = p.indexOf('Your plan said: scenario 1');
  assert.ok(facts >= 0 && said > facts, 'facts first');
  assert.ok(p.includes(s.line), 'the scenario as written');
  assert.match(p, /The candle decides: confirm a scenario only if the closed candle meets its TAKE conditions; else pass\./);
  assert.match(p, /DECISION: TAKE 1 \| DECISION: PASS/);
  assert.match(p, /do not call compose_check/);
});

test('prepare-ahead: the section adapter reads only the closed bars up to the briefing\'s bar, in the window the close will read (rewriting later bars gives an identical input)', () => {
  const i = at('2021-05-24T13:39:00.000Z');
  const bars = BARS.slice(0, i + 1);
  const briefing = B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, scan: [] });
  const input = { symbol: 'MNQ', minutes: 3, briefing, flat: true, registry: REG, windowBars: bars.length };
  const a = PA.sectionFor({ ...input, bars });
  // The forming and later bars, rewritten: not read.
  const later = BARS.map((b, k) => (k > i ? { ...b, h: b.h + 400, l: b.l - 400, c: b.c - 75, v: b.v * 9 } : b)).slice(0, i + 4);
  assert.deepStrictEqual(PA.sectionFor({ ...input, bars: later }), a);
  // The window: the last windowBars - 1 bars (the close reads them plus the new one).
  assert.deepStrictEqual(PA.windowOf(bars, 100).length, 99);
  assert.strictEqual(PA.windowOf(bars, 100).at(-1).t, bars.at(-1).t);
  assert.strictEqual(PA.windowOf(bars, bars.length + 5).length, bars.length, 'fewer than the window: all of them');
  // The same section PR A's function gives for that window.
  const w = PA.windowOf(bars, bars.length);
  assert.deepStrictEqual(a, NC.possibleAtNextClose({ symbol: 'MNQ', bars: w, minutes: 3, briefing, flat: true, registry: REG }));
  assert.ok(a.candidates.length > 0, 'the fixture bar has a candidate');
  // Not flat: none.
  assert.strictEqual(PA.sectionFor({ ...input, bars, flat: false }), null);
  // A briefing that is not the last closed bar's: refused, never a section of other bars.
  assert.throws(() => PA.sectionFor({ ...input, bars: BARS.slice(0, i), briefing }), /closed bar/);
});

test('prepare-ahead: deskKeys keys each report by its role and text, with its end', () => {
  const k = PA.deskKeys(DESK);
  assert.deepStrictEqual(Object.keys(k), ['market-structure-analyst', 'trend-momentum-analyst', 'risk-manager']);
  assert.match(k['market-structure-analyst'].key, /^[0-9a-f]{16}$/);
  assert.strictEqual(k['market-structure-analyst'].until, '2021-05-24T13:45:00.000Z');
  assert.notStrictEqual(PA.deskKeys([{ ...DESK[0], text: 'other' }])['market-structure-analyst'].key, k['market-structure-analyst'].key);
  assert.deepStrictEqual(PA.deskKeys(null), {});
});
