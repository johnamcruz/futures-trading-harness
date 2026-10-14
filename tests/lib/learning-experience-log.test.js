'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../../scripts/lib/learning/experience-log');
const { fromLifecycleRecord } = require('../../scripts/lib/learning/lifecycle-record');
const { writeRunExperience } = require('../../scripts/lib/learning/run-experience');
const { M3, record, bars, runDir, tmpHome } = require('../fixtures/learning');

const T0 = '2023-03-15T14:00:00.000Z';
const ms = Date.parse;
const plan = (o = {}) => ({ bars: bars(T0, o.rows), tfMs: M3, side: o.side || 'long', entry: 100, stop: o.stop ?? 98, target: o.target ?? 104, fromMs: ms(T0), expiresMs: ms(T0) + (o.expiry ?? 1) * M3, eodMs: o.eodMs ?? Infinity, tick: 0.25 });

test('limitOutcome: the limit fills at the reference or better, then target, stop (with slippage), stop first, eod', () => {
  const win = E.limitOutcome(plan({ rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 102, 100, 101.75], [101.75, 104.25, 101.5, 104]] }));
  assert.deepStrictEqual([win.filled, win.entryPrice, win.exitPrice, win.exitReason, win.R], [true, 100, 104, 'target', 2]);
  assert.strictEqual(win.exitTime, new Date(ms(T0) + 3 * M3).toISOString());
  // Stop: 98 less one tick of slippage = 97.75: -2.25 / 2.
  const loss = E.limitOutcome(plan({ rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 100.5, 97.5, 98]] }));
  assert.deepStrictEqual([loss.exitPrice, loss.exitReason, loss.R], [97.75, 'stop', -1.125]);
  // A bar reaching both: a loss.
  assert.strictEqual(E.limitOutcome(plan({ rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 97.5, 101]] })).exitReason, 'stop');
  // On the fill bar only the stop counts (the order within the bar is unknown).
  const fillBar = E.limitOutcome(plan({ rows: [[100.5, 104.5, 99.75, 104], [104, 104.25, 103, 103.5]] }));
  assert.deepStrictEqual([fillBar.exitReason, fillBar.R], ['target', 2]);
  // A bar opening through the limit fills at its open (a better price); the brackets are placed from the fill.
  const gap = E.limitOutcome(plan({ rows: [[99.5, 99.75, 99, 99.5], [99.5, 104, 99.25, 103.75]] }));
  assert.deepStrictEqual([gap.entryPrice, gap.exitPrice, gap.R], [99.5, 103.5, 2], 'the brackets from the fill');
  // Never traded before the record expired: unfilled, no R.
  const unfilled = E.limitOutcome(plan({ rows: [[100.5, 101, 100.25, 100.75], [100.75, 101, 99.5, 100]] }));
  assert.deepStrictEqual([unfilled.filled, unfilled.exitReason, unfilled.R], [false, 'unfilled', null]);
  // End of day: out at the close of the bar reaching it.
  const eod = E.limitOutcome(plan({ rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 101, 100, 101]], eodMs: ms(T0) + 2 * M3 }));
  assert.deepStrictEqual([eod.exitReason, eod.exitPrice, eod.R], ['eod', 101, 0.5]);
  // A short, mirrored.
  const short = E.limitOutcome({ ...plan({ rows: [[99.5, 100.25, 99.25, 99.75], [99.75, 100, 95.75, 96]], side: 'short', stop: 102, target: 96 }) });
  assert.deepStrictEqual([short.entryPrice, short.exitReason, short.R], [100, 'target', 2]);
  assert.strictEqual(E.limitOutcome(plan({ rows: [[1, 1, 1, 1]], stop: 101 })).exitReason, 'stop on the wrong side');
  assert.strictEqual(E.limitOutcome({ ...plan({ rows: [] }) }).exitReason, 'no bars after the decision');
});

const trip = (openIso, closeIso, entryPx, exitPx, side = 'buy') => ({
  family: 'MNQ', side, openMs: ms(openIso), closeMs: closeIso ? ms(closeIso) : null,
  opens: [{ price: entryPx, size: 1 }], closes: closeIso ? [{ price: exitPx, size: 1 }] : [],
});

test('buildDecisions: entered from real fills, passed by counterfactual, refused, and plain passes with and without records', () => {
  const t = i => new Date(ms(T0) + i * M3).toISOString();
  const cycles = [0, 1, 2, 3, 4].map(i => ({ at: t(i), roots: ['MNQ'] }));
  const records = [
    record({ at: t(0) }),
    record({ at: t(1), ok: false }), record({ at: t(1) }), // the latest ok record of the cycle decides
    record({ at: t(2), ok: false }),
    record({ at: t(4), side: 'short', entry: 101, stop: 103, target: 97 }),
  ].map(fromLifecycleRecord);
  const rows = [[100.5, 100.75, 99.75, 100.25], [100.25, 101, 99.5, 100.5], [100.5, 104.25, 100.25, 104], [104, 104.5, 103, 103.5], [103.5, 103.75, 101.5, 102], [102, 102.5, 96.5, 97]];
  const out = E.buildDecisions({
    cycles, records, trips: [trip(t(0), t(2), 100, 103)], gateRefusals: [{ cycleAt: t(4), root: null, check: 'trade-lifecycle-reads' }],
    barsFor: () => bars(T0, rows), tfMs: M3, tickOf: () => 0.25, runId: 'run1', now: new Date('2026-10-14T00:00:00Z'),
  });
  assert.deepStrictEqual(out.map(d => d.decision), ['entered', 'passed', 'none', 'none', 'refused']);
  const [entered, passed, tried, nothing, refused] = out;
  assert.deepStrictEqual([entered.outcome.source, entered.outcome.R, entered.grade], ['fills', 1.5, 'win']);
  assert.deepStrictEqual([passed.outcome.source, passed.outcome.entryPrice, passed.outcome.exitReason, passed.outcome.R, passed.grade], ['counterfactual', 100, 'target', 2, 'missed-win']);
  assert.deepStrictEqual([tried.checked, tried.signatures.skill, nothing.checked], [1, null, 0]);
  assert.deepStrictEqual([refused.refusal, refused.side, refused.outcome.exitReason, refused.grade], ['trade-lifecycle-reads', 'short', 'target', 'refused-would-win']);
  assert.strictEqual(entered.role, 'practice-train');
  assert.strictEqual(entered.day, '2023-03-15');
  assert.deepStrictEqual(Object.keys(entered.context), ['regime', 'volatility', 'window', 'biasSide', 'alignment', 'dayType']);
  assert.ok(entered.signatures.skill && entered.signatures.read && entered.reads.length === 6);
  assert.strictEqual(new Set(out.map(d => d.id)).size, 5, 'ids are distinct');
  // A trip on another root or side, or before the record, is not this decision's.
  const other = E.buildDecisions({ cycles: cycles.slice(0, 1), records: records.slice(0, 1), trips: [{ ...trip(t(0), t(2), 100, 103), family: 'MES' }, trip(t(0), t(2), 100, 103, 'sell'), trip('2023-03-15T13:00:00Z', t(2), 100, 103)], barsFor: () => bars(T0, rows), tfMs: M3, tickOf: () => 0.25 });
  assert.strictEqual(other[0].decision, 'passed');
});

test('grades: a pass that would have lost is a good pass; unfilled is neutral', () => {
  assert.strictEqual(E.gradeOf('passed', { R: -1 }), 'good-pass');
  assert.strictEqual(E.gradeOf('passed', { R: null }), 'neutral-pass');
  assert.strictEqual(E.gradeOf('entered', { R: -1 }), 'loss');
  assert.strictEqual(E.gradeOf('none', null), null);
  // The gate's refusals are graded apart from the model's passes.
  assert.deepStrictEqual(['refused'].flatMap(d => [-1, 1, null].map(R => E.gradeOf(d, { R }))), ['refused-would-lose', 'refused-would-win', 'refused-neutral']);
});

test('a round trip is credited to the latest ok record before its fill, not an earlier one still open (A then B)', () => {
  const t = i => new Date(ms(T0) + i * M3).toISOString();
  // A at t0 and B at t1 both long, A valid three bars, B one; the fill comes after B's record: B entered, A passed.
  const A = fromLifecycleRecord(record({ at: t(0), expiresAt: t(3) }));
  const B = fromLifecycleRecord(record({ at: t(1), expiresAt: t(2), skills: ['daily-bias', 'vwap-volume-profile', 'rejection', 'candle-reading', 'invalidation', 'top-down-entry'] }));
  const rows = [[100.5, 100.75, 100.25, 100.5], [100.5, 100.75, 99.75, 100.25], [100.25, 104.25, 100, 104], [104, 104.5, 103, 103.5]];
  const out = E.buildDecisions({
    cycles: [0, 1].map(i => ({ at: t(i), roots: ['MNQ'] })), records: [A, B],
    trips: [trip(new Date(ms(t(1)) + 30000).toISOString(), t(3), 100, 104)], barsFor: () => bars(T0, rows), tfMs: M3, tickOf: () => 0.25,
  });
  assert.deepStrictEqual(out.map(d => [d.cycleAt, d.decision, d.signatures.skill.slice(0, 15)]), [[t(0), 'passed', 'bias:bos-vs-cho'], [t(1), 'entered', 'bias:daily-bias']]);
  // A fill before B's record is A's.
  const early = E.buildDecisions({ cycles: [0, 1].map(i => ({ at: t(i), roots: ['MNQ'] })), records: [A, B], trips: [trip(new Date(ms(t(0)) + 30000).toISOString(), t(3), 100, 104)], barsFor: () => bars(T0, rows), tfMs: M3, tickOf: () => 0.25 });
  assert.deepStrictEqual(early.map(d => d.decision), ['entered', 'passed']);
});

test('limitOutcome: a target on the fill bar is never credited; the limit never fills across the session or past end of day', () => {
  // The fill bar reaches the target, the next bar the stop: a loss, the fill bar's target not counted.
  const fillBarTarget = E.limitOutcome(plan({ rows: [[100.5, 104.5, 99.75, 104], [104, 104.25, 97.5, 98]], expiry: 1 }));
  assert.deepStrictEqual([fillBarTarget.exitReason, fillBarTarget.R], ['stop', -1.125]);
  // Expiry after end of day: the bar reaching end of day doesn't fill; nothing after it does.
  const eod = ms(T0) + M3;
  const late = E.limitOutcome({ ...plan({ rows: [[100.5, 101, 100.25, 100.75], [100.75, 101, 99, 99.5]], expiry: 3, eodMs: eod }) });
  assert.deepStrictEqual([late.filled, late.exitReason], [false, 'unfilled']);
  // A record whose expiry reaches into the next session: no fill in it.
  const evening = '2023-03-15T19:57:00.000Z';
  const cross = E.limitOutcome({ bars: bars(evening, [[100.5, 101, 100.25, 100.75], [100.75, 101, 99, 99.5]]).map((b, i) => (i ? { ...b, ms: Date.parse('2023-03-15T22:00:00Z'), t: '2023-03-15T22:00:00Z' } : b)), tfMs: M3, side: 'long', entry: 100, stop: 98, target: 104, fromMs: ms(evening), expiresMs: Date.parse('2023-03-16T00:00:00Z'), tick: 0.25 });
  assert.deepStrictEqual([cross.filled, cross.exitReason], [false, 'unfilled']);
});

test('appendDecisions: append-only, each id once; readDecisions skips a torn line', () => {
  const file = path.join(tmpHome(), 'experience', 'decisions.jsonl');
  assert.deepStrictEqual(E.appendDecisions(file, [{ id: 'a', x: 1 }, { id: 'b' }]), { added: 2, kept: 0 });
  fs.appendFileSync(file, '{torn');
  assert.deepStrictEqual(E.appendDecisions(file, [{ id: 'a', x: 2 }, { id: 'c' }]), { added: 1, kept: 1 });
  assert.deepStrictEqual(E.readDecisions(file).map(d => [d.id, d.x]), [['a', 1], ['b', undefined], ['c', undefined]]);
  assert.strictEqual(E.logFile('/h'), path.join('/h', 'experience', 'decisions.jsonl'));
});

test('writeRunExperience: a finished practice run\'s log in its home; an unfinished run refused; written twice, kept once', () => {
  const times = [T0, new Date(ms(T0) + M3).toISOString()];
  const fills = [
    { id: 1, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:01:00Z', price: 100, size: 1, side: 0, profitAndLoss: null },
    { id: 2, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:20:00Z', price: 98.5, size: 1, side: 1, profitAndLoss: -3 },
  ];
  const { home, dir } = runDir({ times, fills, records: [record({ at: T0 })], barRows: [[100.5, 100.75, 99.75, 100.25], [100.25, 101, 99.5, 100.5]] });
  const r = writeRunExperience(dir, { now: new Date('2026-10-14T00:00:00Z') });
  assert.strictEqual(r.file, path.join(fs.realpathSync(home), 'experience', 'decisions.jsonl'));
  assert.deepStrictEqual([r.role, r.hidden], ['practice-train', false]);
  assert.deepStrictEqual(r.decisions.map(d => [d.decision, d.outcome && d.outcome.R]), [['entered', -0.75], ['none', null]]);
  assert.deepStrictEqual([r.added, writeRunExperience(dir).added], [2, 0]);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...m, finished: false }));
  assert.throws(() => writeRunExperience(dir), /not finished/);
});

test('writeRunExperience: only a learning run that passed the gate; a reasoning-fix look hides the outcomes', () => {
  const t0 = '2025-03-14T14:00:00.000Z';
  const rows = [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 100, 104.25]];
  const none = runDir({ day: '2025-03-14', times: [t0], records: [record({ at: t0 })], barRows: rows, gate: null });
  assert.throws(() => writeRunExperience(none.dir), /not a learning run \(no learning-run.json/);
  const off = runDir({ day: '2025-03-14', times: [t0], records: [record({ at: t0 })], barRows: rows, gate: { learning: false } });
  assert.throws(() => writeRunExperience(off.dir), /declared not learning/);
  const fix = runDir({ day: '2025-03-14', times: [t0], records: [record({ at: t0 })], barRows: rows, gate: { learning: true, role: 'test', look: { purpose: 'reasoning-fix' }, hideOutcomes: true } });
  const r = writeRunExperience(fix.dir);
  assert.deepStrictEqual([r.hidden, r.decisions[0].decision, r.decisions[0].outcome, r.decisions[0].grade, r.decisions[0].hidden], [true, 'passed', null, null, true]);
  const shown = runDir({ day: '2025-03-14', times: [t0], records: [record({ at: t0 })], barRows: rows, gate: { learning: true, role: 'test', look: { purpose: 'judging' }, hideOutcomes: false } });
  assert.strictEqual(writeRunExperience(shown.dir).decisions[0].outcome.R, 2);
  const wrong = runDir({ day: '2025-03-14', times: [t0], barRows: rows, gate: { learning: true, role: 'practice-train', look: null, hideOutcomes: false } });
  assert.throws(() => writeRunExperience(wrong.dir), /started in practice-train but holds 2025-03-14 \(test\)/);
});

