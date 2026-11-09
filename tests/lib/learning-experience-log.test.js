'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../../scripts/lib/learning/experience-log');
const { fromLifecycleRecord } = require('../../scripts/lib/learning/lifecycle-record');
const { writeRunExperience } = require('../../scripts/lib/learning/run-experience');
const { M3, record, bars, runDir, tmpHome } = require('../fixtures/learning');
const { afterTargetStep } = require('../../scripts/lib/trading/exit-trail');

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

// The bars of a long held from 14:01 to 14:20 (100 to 98.5): the 14:03 bar's high 101 its best, the exit its worst.
const TRADE_ROWS = [[100.5, 100.75, 99.75, 100.25], [100.25, 101, 99.5, 100.5], [100.5, 100.75, 99, 99.5], [99.5, 100, 99, 99.5], [99.5, 100, 99, 99.5], [99.5, 100, 99, 99.5], [99.5, 99.5, 98, 98.5]];

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
  // MAE and MFE from the bars wholly inside the trade and its exit: the low 99.5 (-0.25R), the exit 103 (+1.5R).
  assert.deepStrictEqual([entered.outcome.maeR, entered.outcome.mfeR], [-0.25, 1.5]);
  assert.deepStrictEqual([passed.outcome.maeR, passed.outcome.mfeR], [null, null], 'the counterfactual\'s: filled inside the second bar, out inside the third: no bar held whole, unknown');
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

test('passClass: a pass is the model\'s (declined) only when it passed; a missed fill, a veto, a gate block are graded apart, never good-pass, missed-win or neutral-pass', () => {
  const t = i => new Date(ms(T0) + i * M3).toISOString();
  // Real result lines (the runner's wording): a missed entry, a lesson veto, the head trader's own pass, an order that
  // went and never filled, a gate block, and a cycle from before the record (no result: the line as it was).
  const results = [
    'CYCLE RESULT: no-trade - the runner\'s entry: missed the plan\'s entry 100 (price 100.75 is 0.75 points past it against the long): no late entry',
    'CYCLE RESULT: no-trade - risk-manager vetoed the trade_lifecycle long 1 MNQ: VERDICT: VETO - phase 1 stand-down: prop_portfolio entries stand down until the target-leg cancel cause is journaled; stand aside',
    'CYCLE RESULT: no-trade - compose_check OK, passed: the 3m trend is up against the short',
    'CYCLE RESULT: executed - trade_lifecycle long 1 MNQ (the runner\'s entry: phase 2 approved, the order is working, unfilled: order 4, limit 100)',
    'CYCLE RESULT: blocked - the order gate refused the trade_lifecycle long 1 MNQ: [phase2-facts] an item the gate can\'t read',
    undefined,
  ];
  const cycles = results.map((result, i) => ({ at: t(i * 10), roots: ['MNQ'], ...(result ? { result } : {}) }));
  const records = results.map((_r, i) => fromLifecycleRecord(record({ at: t(i * 10) })));
  // The limit fills and wins at its target in each window.
  const rows = [];
  for (let i = 0; i < 70; i += 1) rows.push(i % 10 === 0 ? [100.25, 100.5, 99.75, 100.25] : i % 10 === 1 ? [100.25, 104.25, 100, 104] : [100.25, 100.5, 100.25, 100.25]);
  const out = E.buildDecisions({ cycles, records, gateRefusals: [{ cycleAt: t(40), root: null, check: 'phase2-facts' }], barsFor: () => bars(T0, rows), tfMs: M3, tickOf: () => 0.25, runId: 'run1' });
  assert.deepStrictEqual(out.map(d => [d.decision, d.passClass, d.vetoBasis, d.grade]), [
    ['passed', 'missed_fill', undefined, 'unplaced-would-win'],
    ['passed', 'vetoed', 'lesson', 'unplaced-would-win'],
    ['passed', 'declined', undefined, 'missed-win'],
    ['passed', 'unfilled', undefined, 'unplaced-would-win'],
    ['refused', 'blocked', undefined, 'refused-would-win'],
    ['passed', undefined, undefined, 'missed-win'],
  ]);
  assert.ok(out.every(d => d.outcome.R === 2), 'the counterfactual stays: a vetoed setup\'s R is still evidence about the setup');
  assert.deepStrictEqual(out.map(d => require('../../scripts/lib/learning/pass-class').ownPass(d)), [false, false, true, false, false, true]);
  assert.deepStrictEqual(['passed'].flatMap(d => [-1, 1, null].map(R => E.gradeOf(d, { R }, 'vetoed'))), ['unplaced-would-lose', 'unplaced-would-win', 'unplaced-neutral']);
  assert.strictEqual(E.gradeOf('passed', { R: -1 }, 'declined'), 'good-pass');
  // Both sides composed in one cycle: the veto is the latest record's (the one planned); the other side the model passed.
  const two = E.buildDecisions({
    cycles: [{ at: t(0), roots: ['MNQ'], result: results[1] }],
    records: [record({ at: t(0) }), record({ at: new Date(ms(t(0)) + 1000).toISOString(), side: 'short', entry: 101, stop: 103, target: 97 })].map(fromLifecycleRecord),
    barsFor: () => bars(T0, rows), tfMs: M3, tickOf: () => 0.25, runId: 'run1',
  });
  assert.deepStrictEqual(two.map(d => [d.side, d.passClass, d.vetoBasis]), [['long', 'declined', undefined], ['short', 'vetoed', 'lesson']]);
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

test('frame: default with a 1h bias, a 15m reaction and a 3m confirmation read; anything else other; on every composed decision', () => {
  const R = (step, read) => ({ step, skill: 's', read });
  const base = [R('bias', '1h bos up'), R('setup', '15m rejected prior VAH up'), R('entry', '3m close top'), R('stop', 'stop 15m low 98')];
  assert.strictEqual(E.frameOf(base), 'default');
  assert.strictEqual(E.frameOf([R('bias', '60m up'), ...base.slice(1)]), 'default', '60m is 1h');
  // The checker's spellings: the normalized form decides, never the raw word.
  assert.strictEqual(E.frameOf([R('bias', '60 min up'), R('setup', '15-min rejected prior VAH up'), R('entry', '3-minute close top')]), 'default');
  assert.strictEqual(E.frameOf([{ ...R('bias', 'whatever'), form: '1h up' }, ...base.slice(1)]), 'default', 'the record\'s own form first');
  assert.strictEqual(E.frameOf([R('bias', '4h up'), ...base.slice(1)]), 'other');
  assert.strictEqual(E.frameOf([base[0], R('setup', '5m rejected prior VAH up'), base[2]]), 'other');
  assert.strictEqual(E.frameOf([base[0], base[1], R('entry', '1m close top')]), 'other');
  assert.strictEqual(E.frameOf([base[0], base[1], R('location', '3m close top')]), 'other', 'the 3m read at the entry step');
  assert.strictEqual(E.frameOf(null), 'other');
  const d = E.buildDecisions({ cycles: [{ at: T0, roots: ['MNQ'] }], records: [fromLifecycleRecord(record({ at: T0 }))], barsFor: () => [], tfMs: M3, tickOf: () => 0.25 })[0];
  assert.strictEqual(d.frame, 'default', 'the fixture: 1h bias, 15m setup, 3m entry');
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

test('a scale-in is its own record\'s entry (legs of a round trip), and a decision is dated by the later of its and its exit\'s session', () => {
  const t = i => new Date(ms(T0) + i * M3).toISOString();
  const A = fromLifecycleRecord(record({ at: t(0), expiresAt: t(1) }));
  const B = fromLifecycleRecord(record({ at: t(1), expiresAt: t(2), skills: ['daily-bias', 'vwap-volume-profile', 'rejection', 'candle-reading', 'invalidation', 'top-down-entry'] }));
  // One position: A's entry at 100, B's add at 101, both closed at 104.
  const joined = { family: 'MNQ', side: 'buy', openMs: ms(t(0)) + 30000, closeMs: ms(t(3)), opens: [{ price: 100, size: 1, ms: ms(t(0)) + 30000 }, { price: 101, size: 1, ms: ms(t(1)) + 30000 }], closes: [{ price: 104, size: 2 }] };
  const legs = E.legsOf([joined]);
  assert.deepStrictEqual(legs.map(l => [l.openMs, l.opens.length, l.closes[0].price]), [[ms(t(0)) + 30000, 1, 104], [ms(t(1)) + 30000, 1, 104]]);
  const out = E.buildDecisions({ cycles: [0, 1].map(i => ({ at: t(i), roots: ['MNQ'] })), records: [A, B], trips: legs, barsFor: () => [], tfMs: M3, tickOf: () => 0.25 });
  assert.deepStrictEqual(out.map(d => [d.decision, d.outcome.entryPrice, d.outcome.R]), [['entered', 100, 2], ['entered', 101, 1.5]]);
  // Settled in the next session (a position carried over): dated by the exit.
  assert.strictEqual(E.settledDay('2023-03-15', { exitTime: '2023-03-16T15:00:00.000Z' }), '2023-03-16');
  assert.strictEqual(E.settledDay('2023-03-15', { exitTime: '2023-03-15T19:00:00.000Z' }), '2023-03-15');
  assert.strictEqual(E.settledDay('2023-03-15', null), '2023-03-15');
  assert.strictEqual(out[0].settledDay, '2023-03-15');
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
  // Every bar of the trade (14:00 to 14:18): its excursions are measured only on bars that cover it.
  const { home, dir } = runDir({ times, fills, records: [record({ at: T0 })], barRows: TRADE_ROWS });
  const r = writeRunExperience(dir, { now: new Date('2026-10-14T00:00:00Z') });
  assert.strictEqual(r.file, path.join(fs.realpathSync(home), 'experience', 'decisions.jsonl'));
  assert.deepStrictEqual([r.role, r.hidden], ['practice-train', false]);
  assert.deepStrictEqual(r.decisions.map(d => [d.decision, d.outcome && d.outcome.R]), [['entered', -0.75], ['none', null]]);
  // From the run's own bars: the 14:03 bar wholly inside the trade (its high 101, +0.5R) and the exit (98.5, -0.75R).
  assert.deepStrictEqual([r.decisions[0].outcome.maeR, r.decisions[0].outcome.mfeR], [-0.75, 0.5]);
  assert.ok(r.decisions.every(d => d.curated === undefined), 'not a curated run');
  assert.deepStrictEqual([r.added, writeRunExperience(dir).added], [2, 0]);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...m, finished: false }));
  assert.throws(() => writeRunExperience(dir), /not finished/);
});

test('writeRunExperience: the head trader\'s delivery keys (runDelivery) on every line only when one is on; a run under two refused', () => {
  const { runDelivery } = require('../../scripts/lib/learning/run-experience');
  const times = [T0, new Date(ms(T0) + M3).toISOString()];
  const fills = [
    { id: 1, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:01:00Z', price: 100, size: 1, side: 0, profitAndLoss: null },
    { id: 2, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:20:00Z', price: 98.5, size: 1, side: 1, profitAndLoss: -3 },
  ];
  const make = () => runDir({ times, fills, records: [record({ at: T0 })], barRows: [[100.5, 100.75, 99.75, 100.25], [100.25, 101, 99.5, 100.5]] });
  const off = make();
  const plain = writeRunExperience(off.dir, { now: new Date('2026-10-14T00:00:00Z') });
  assert.ok(plain.decisions.every(d => !('delivery' in d)));
  assert.ok(E.readDecisions(plain.file).every(d => !('delivery' in d)), 'the log as before');
  assert.strictEqual(runDelivery(off.dir), null);
  const on = make();
  const cfgFile = path.join(on.dir, 'autotrader.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), cycleDataInPrompt: true }));
  const tagged = writeRunExperience(on.dir, { now: new Date('2026-10-14T00:00:00Z') });
  assert.ok(tagged.decisions.length && tagged.decisions.every(d => d.delivery === 'cycleDataInPrompt'));
  assert.ok(E.readDecisions(tagged.file).every(d => d.delivery === 'cycleDataInPrompt'), 'on every logged line');
  assert.deepStrictEqual(tagged.decisions.map(d => d.id), plain.decisions.map(d => d.id), 'the same decisions otherwise');
  // From the setup record too (its config: cfg.<key>, JSON values), and both keys in the list's order.
  const both = make();
  fs.writeFileSync(path.join(both.dir, 'setup.json'), JSON.stringify({ config: { 'cfg.cycleDataInPrompt': 'true', 'cfg.headSkillsInPrompt': 'true' } }));
  assert.strictEqual(runDelivery(both.dir), 'headSkillsInPrompt,cycleDataInPrompt');
  // A resume under another runner config with another delivery: the run can't be given one.
  const resumed = make();
  fs.writeFileSync(path.join(resumed.dir, 'autotrader-v2.json'), JSON.stringify({ timeframe: 3, symbols: ['MNQ'], cycleDataInPrompt: true }));
  const m = JSON.parse(fs.readFileSync(path.join(resumed.dir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(resumed.dir, 'manifest.json'), JSON.stringify({ ...m, versions: [{ config: 'autotrader.json' }, { config: 'autotrader-v2.json' }] }));
  assert.throws(() => runDelivery(resumed.dir, JSON.parse(fs.readFileSync(path.join(resumed.dir, 'manifest.json'), 'utf8'))), /ran under 2 head trader deliveries \(none \| cycleDataInPrompt\)/);
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
  // Held under the exit the run's manifest recorded at seed time (the policy's, as the runner manages composed trades).
  const { runExit } = require('../../scripts/lib/learning/run-experience');
  const exit = E.exitRecord(runExit(null));
  const shownGate = { learning: true, role: 'test', look: { purpose: 'judging' }, hideOutcomes: false };
  const shown = runDir({ day: '2025-03-14', times: [t0], records: [record({ at: t0 })], barRows: rows, gate: shownGate, exit });
  const d0 = writeRunExperience(shown.dir).decisions[0];
  const want = E.limitOutcome({ bars: bars(t0, rows), tfMs: M3, side: 'long', entry: 100, stop: 98, target: 104, fromMs: ms(t0), expiresMs: Date.parse(d0.plan.expiresAt), eodMs: Infinity, tick: 0.25, plan: exit.plan });
  assert.deepStrictEqual([d0.exit, d0.exitPlan, d0.outcome.R], [exit.mode, exit.hash, want.R]);
  assert.notStrictEqual(exit.mode, 'brackets', 'the harness\'s composed exit is a policy\'s');
  // The manifest decides, not the repository when the log is written: a run recorded under its brackets keeps them.
  const brackets = E.exitRecord(E.BRACKETS);
  const kept0 = writeRunExperience(runDir({ day: '2025-03-14', times: [t0], records: [record({ at: t0 })], barRows: rows, gate: shownGate, exit: brackets }).dir).decisions[0];
  assert.deepStrictEqual([kept0.exit, kept0.exitPlan, kept0.outcome.R], ['brackets', brackets.hash, 2]);
  // A run started before the record: its brackets, untagged (no plan hash).
  const legacy = writeRunExperience(runDir({ day: '2025-03-14', times: [t0], records: [record({ at: t0 })], barRows: rows, gate: shownGate }).dir).decisions[0];
  assert.deepStrictEqual([legacy.exit, legacy.exitPlan, legacy.outcome.R], ['brackets', null, 2]);
  // A recorded plan that doesn't match its hash: refused.
  assert.throws(() => writeRunExperience(runDir({ day: '2025-03-14', times: [t0], records: [record({ at: t0 })], barRows: rows, gate: shownGate, exit: { ...exit, mode: 'brackets' } }).dir), /exit plan doesn't match its hash/);
  assert.strictEqual(E.limitOutcome({ bars: bars(t0, rows), tfMs: M3, side: 'long', entry: 100, stop: 98, target: 104, fromMs: ms(t0), expiresMs: Date.parse(d0.plan.expiresAt), tick: 0.25 }).R, 2, 'the brackets alone: 2R');
  // The run record decides, not the run home's copy (the layout of folders never decides what is hidden).
  const kept = runDir({ day: '2025-03-14', times: [t0], records: [record({ at: t0 })], barRows: rows, gate: { learning: true, role: 'test', look: { purpose: 'reasoning-fix' }, hideOutcomes: true } });
  fs.writeFileSync(path.join(kept.home, 'learning-run.json'), JSON.stringify({ learning: true, role: 'test', look: { purpose: 'judging' }, hideOutcomes: false }));
  assert.strictEqual(writeRunExperience(kept.dir).hidden, true);
  const wrong = runDir({ day: '2025-03-14', times: [t0], barRows: rows, gate: { learning: true, role: 'practice-train', look: null, hideOutcomes: false } });
  assert.throws(() => writeRunExperience(wrong.dir), /started in practice-train but holds 2025-03-14 \(test\)/);
});

// The gateway's stamp (entry-orders.json composed.record, by order id) names the record the gate judged at placement:
// the trade is that record's, whatever was composed after it in the cycle.
const stampedTrip = (openIso, closeIso, entryPx, exitPx, orderId, side = 'buy') => {
  const t = trip(openIso, closeIso, entryPx, exitPx, side);
  return { ...t, opens: t.opens.map(f => ({ ...f, orderId })) };
};
const SKILLS_B = ['daily-bias', 'vwap-volume-profile', 'rejection', 'candle-reading', 'invalidation', 'top-down-entry'];
const ROWS_WIN = [[100.5, 100.75, 99.75, 100.25], [100.25, 102, 100, 101.75], [101.75, 104.25, 101.5, 104]];

test('attribution: composed long and entered, then composed short in the same cycle: the long trade is the long record\'s, the short a pass', () => {
  const t = i => new Date(ms(T0) + i * M3).toISOString();
  const at = s => new Date(ms(T0) + s * 1000).toISOString();
  const L = fromLifecycleRecord({ ...record({ at: at(10), expiresAt: t(1) }), id: 'rec-long' });
  const S = fromLifecycleRecord({ ...record({ at: at(60), expiresAt: t(1), side: 'short', entry: 101, stop: 103, target: 97 }), id: 'rec-short' });
  assert.strictEqual(L.id, 'rec-long', 'the record keeps its id');
  // Long filled at 100 (t0+30s), closed at 104: +2R on the record's 2-point stop.
  const args = { cycles: [{ at: t(0), roots: ['MNQ'] }], records: [L, S], barsFor: () => bars(T0, ROWS_WIN), tfMs: M3, tickOf: () => 0.25, runId: 'run1' };
  const out = E.buildDecisions({ ...args, trips: [stampedTrip(at(30), t(3), 100, 104, 7)], stamps: { 7: 'rec-long' } });
  const bySide = Object.fromEntries(out.map(d => [d.side, d]));
  assert.deepStrictEqual(out.map(d => d.side).sort(), ['long', 'short'], 'one decision per side');
  assert.deepStrictEqual([bySide.long.decision, bySide.long.outcome.source, bySide.long.outcome.R, bySide.long.grade], ['entered', 'fills', 2, 'win']);
  assert.deepStrictEqual([bySide.short.decision, bySide.short.outcome.source], ['passed', 'counterfactual']);
  // Without a stamp the long side's own slot still holds the trade (per side, by the time window).
  const plain = E.buildDecisions({ ...args, trips: [trip(at(30), t(3), 100, 104)] });
  assert.deepStrictEqual(plain.map(d => [d.side, d.decision]), [['long', 'entered'], ['short', 'passed']]);
  // A refusal with no side stays with the cycle's latest ok record (the short), never both.
  const refused = E.buildDecisions({ ...args, trips: [], gateRefusals: [{ cycleAt: t(0), root: null, check: 'x' }] });
  assert.deepStrictEqual(refused.map(d => [d.side, d.decision]), [['long', 'passed'], ['short', 'refused']]);
});

test('attribution: a same-side re-compose after the fill: the trade is the stamped record\'s, never the later signature\'s', () => {
  const t = i => new Date(ms(T0) + i * M3).toISOString();
  const at = s => new Date(ms(T0) + s * 1000).toISOString();
  const A = fromLifecycleRecord({ ...record({ at: at(10), expiresAt: t(1) }), id: 'rec-a' });
  const B = fromLifecycleRecord({ ...record({ at: at(60), expiresAt: t(1), skills: SKILLS_B }), id: 'rec-b' });
  assert.notStrictEqual(A.signatures.skill, B.signatures.skill);
  const args = { cycles: [{ at: t(0), roots: ['MNQ'] }], records: [A, B], barsFor: () => bars(T0, ROWS_WIN), tfMs: M3, tickOf: () => 0.25 };
  const out = E.buildDecisions({ ...args, trips: [stampedTrip(at(30), t(3), 100, 104, 9)], stamps: { 9: 'rec-a' } });
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual([out[0].decision, out[0].signatures.skill, out[0].outcome.R, out[0].plan.expiresAt], ['entered', A.signatures.skill, 2, A.expiresAt]);
  // The fill after B, stamped B: B's.
  const b = E.buildDecisions({ ...args, trips: [stampedTrip(at(70), t(3), 100, 104, 9)], stamps: { 9: 'rec-b' } });
  assert.deepStrictEqual([b[0].decision, b[0].signatures.skill], ['entered', B.signatures.skill]);
  // The fill after B but stamped A (A's order, still working): A's, not the later signature's.
  const late = E.buildDecisions({ ...args, trips: [stampedTrip(at(70), t(3), 100, 104, 9)], stamps: { 9: 'rec-a' } });
  assert.deepStrictEqual([late[0].decision, late[0].signatures.skill], ['entered', A.signatures.skill]);
  // A stamp naming no record here: the time window decides.
  const gone = E.buildDecisions({ ...args, trips: [stampedTrip(at(70), t(3), 100, 104, 9)], stamps: { 9: 'rec-gone' } });
  assert.deepStrictEqual([gone[0].decision, gone[0].signatures.skill], ['entered', B.signatures.skill]);
  // Two fills of one stamped order (legs): one trade, both legs.
  const one = E.buildDecisions({ ...args, trips: [stampedTrip(at(30), t(3), 100, 104, 9), stampedTrip(at(40), t(3), 100, 104, 9)], stamps: { 9: 'rec-a' } });
  assert.deepStrictEqual([one.length, one[0].decision, one[0].outcome.R], [1, 'entered', 2]);
  // Two orders stamped with one record: the second isn't folded into the first's trade (the time window decides).
  const two = E.buildDecisions({ ...args, trips: [stampedTrip(at(30), t(3), 100, 104, 9), stampedTrip(at(70), t(3), 101, 97, 10)], stamps: { 9: 'rec-a', 10: 'rec-a' } });
  // (The gate allows one entry per bar and side, so a second order on one record doesn't happen in a gated run.)
  assert.deepStrictEqual([two[0].decision, two[0].outcome.entryPrice, two[0].outcome.R], ['entered', 100, 2], 'not merged');
  // A stamp naming a record composed after the fill can't be that trade's: the time window decides (A's).
  const after = E.buildDecisions({ ...args, trips: [stampedTrip(at(30), t(3), 100, 104, 9)], stamps: { 9: 'rec-b' } });
  assert.deepStrictEqual([after[0].decision, after[0].signatures.skill], ['entered', A.signatures.skill]);
});

test('checked: a cycle\'s records of a side with no ok record count on its latest decision; a run logged by another version is refused', () => {
  const t = i => new Date(ms(T0) + i * M3).toISOString();
  const at = s => new Date(ms(T0) + s * 1000).toISOString();
  const A = fromLifecycleRecord({ ...record({ at: at(10) }), id: 'a' });
  const N = fromLifecycleRecord({ ...record({ at: at(20), side: 'short', ok: false }), id: 'n' });
  const out = E.buildDecisions({ cycles: [{ at: t(0), roots: ['MNQ'] }], records: [A, N], barsFor: () => [], tfMs: M3, tickOf: () => 0.25 });
  assert.deepStrictEqual(out.map(d => [d.side, d.checked]), [['long', 2]]);
  const file = path.join(tmpHome(), 'experience', 'decisions.jsonl');
  E.appendDecisions(file, [{ id: 'old', v: 1, runId: 'r1' }]);
  assert.throws(() => E.appendDecisions(file, [{ id: 'new', v: E.VERSION, runId: 'r1' }]), new RegExp(`run r1's decisions were written by experience log version 1, not ${E.VERSION}: rebuild them \\(replay\\.js experience --rebuild\\)`));
  assert.deepStrictEqual(E.appendDecisions(file, [{ id: 'other', v: E.VERSION, runId: 'r2' }]), { added: 1, kept: 0 });
});

test('writeRunExperience: the run home\'s entry-orders.json stamps credit the judged record', () => {
  const at = s => new Date(ms(T0) + s * 1000).toISOString();
  const fills = [
    // A's order fills after B was composed: the time window alone would credit B.
    { id: 1, orderId: 41, contractId: 'MNQ:2023-06', creationTimestamp: at(70), price: 100, size: 1, side: 0, profitAndLoss: null },
    { id: 2, orderId: 42, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:20:00Z', price: 98.5, size: 1, side: 1, profitAndLoss: -3 },
  ];
  const A = { ...record({ at: at(10) }), id: 'rec-a' };
  const B = { ...record({ at: at(60), skills: SKILLS_B }), id: 'rec-b' };
  const { home, dir } = runDir({ times: [T0], fills, records: [A, B], barRows: [[100.5, 100.75, 99.75, 100.25], [100.25, 101, 99.5, 100.5]] });
  fs.writeFileSync(path.join(home, 'entry-orders.json'), JSON.stringify([{ orderId: 41, contractId: 'MNQ:2023-06', side: 'buy', setup: 'x', composed: { record: 'rec-a', expiresAt: null } }]));
  const r = writeRunExperience(dir);
  assert.deepStrictEqual(r.decisions.map(d => [d.decision, d.signatures.skill.slice(0, 15), d.outcome.R]), [['entered', 'bias:bos-vs-cho', -0.75]]);
});


test('limitOutcome under the run\'s exit (target_then_trail): past the target trailed, not closed; a trailed stop out with slippage', () => {
  const after = { afterTarget: { lockGivebackR: 0.5, trailBy: 'r', trailR: 1, swingMinutes: null } };
  // Entry 100, stop 98 (1R = 2), target 104 (2R). The target bar holds above the lock (103); the next runs to 106 (3R).
  const rows = [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 103.5, 104.25], [104.25, 106, 104.5, 105.5], [105.5, 105.75, 103, 103.5]];
  const brackets = E.limitOutcome(plan({ rows }));
  assert.deepStrictEqual([brackets.exitReason, brackets.R], ['target', 2], 'the brackets: out at the target');
  const trailed = E.limitOutcome({ ...plan({ rows }), plan: after });
  // Locked at 103 on the target bar, 1R behind 106 (104) on the next, through it on the last: 104 less a tick, 103.75.
  assert.deepStrictEqual([trailed.exitReason, trailed.exitPrice, trailed.R], ['trail', 103.75, 1.875]);
  // A bar whose low is already through the new stop: out at its close (the runner's rule).
  const thru = E.limitOutcome({ ...plan({ rows: [rows[0], [100.25, 104.5, 103.5, 104.25], [104.25, 106, 103.75, 105.75]] }), plan: after });
  assert.deepStrictEqual([thru.exitReason, thru.exitPrice], ['trail', 105.75]);
  // Under the target nothing moves: the original stop.
  const stop = E.limitOutcome({ ...plan({ rows: [rows[0], [100.25, 103.5, 100, 103], [103, 103.25, 97.5, 98]] }), plan: after });
  assert.deepStrictEqual([stop.exitReason, stop.exitPrice], ['stop', 97.75]);
  // An R trail (mode trail): from 1R up, 0.5R behind the best; the target bracket still rests.
  // 1.5R on this bar: the stop to 102 (1R), the bar's low (101.5) already through it: out at its close.
  const r = E.limitOutcome({ ...plan({ rows: [rows[0], [100.25, 103, 101.5, 102.75], [102.75, 103, 101.5, 102]] }), plan: { trailActivateR: 1, trailGivebackR: 0.5 } });
  assert.deepStrictEqual([r.exitReason, r.exitPrice], ['trail', 102.75]);
});

test('limitOutcome under target_then_trail with the ratchet: on, the exit afterTargetStep gives on the same bars; off, the plan without the key', () => {
  // Entry 100, stop 98 (1R = 2), target 104 (2R); filled inside the first bar (its prices after the fill unknown: no trail
  // there), then each later bar: the resting stop first (a tick of slippage, or a worse open), then the step at its close.
  const rows = [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 103.5, 104.25], [104.25, 106, 104.5, 105.5], [105.5, 108, 105.25, 107.5], [107.5, 107.75, 104, 104.5]];
  const oracle = afterTarget => {
    const bs = bars(T0, rows);
    let t = { sign: 1, entry: 100, risk: 2, stop: 98, peakR: 0, armed: false, target: 104 };
    for (let j = 1; j < bs.length; j += 1) {
      const b = bs[j];
      if (b.l <= t.stop) return Math.min(t.stop - 0.25, b.o);
      const st = afterTargetStep(t, b, { afterTarget }, 0.25, null);
      if (st.close) return st.close.price;
      t = { ...t, stop: st.stop, peakR: st.peakR, armed: st.armed };
    }
    return null;
  };
  for (const [g, tr] of [[0.5, 1], [1.5, 3]]) {
    const on = { lockGivebackR: g, trailBy: 'r', trailR: tr, swingMinutes: null, ratchet: true };
    const off = { lockGivebackR: g, trailBy: 'r', trailR: tr, swingMinutes: null };
    const got = E.limitOutcome({ ...plan({ rows }), plan: { afterTarget: on } });
    assert.strictEqual(got.exitPrice, oracle(on), `on ${g}/${tr}`);
    assert.deepStrictEqual(E.limitOutcome({ ...plan({ rows }), plan: { afterTarget: { ...off, ratchet: false } } }), E.limitOutcome({ ...plan({ rows }), plan: { afterTarget: off } }), `off ${g}/${tr}`);
    assert.strictEqual(E.limitOutcome({ ...plan({ rows }), plan: { afterTarget: off } }).exitPrice, oracle(off), `off ${g}/${tr}`);
  }
  // The values: 0.5R giveback, 1R trail: on, the target bar's 2.25R best puts the lock at 1.75R (103.5), through its low:
  // out at its close, 104.25; off, the 1.5R lock (103), then the 1R trail: 3R behind the 4R best (106), through the 108
  // bar's low (105.25): out at its close, 107.5. 1.5R giveback, 3R trail: on, the lock 1.5R behind the 4R best (105),
  // stopped on the last bar at 104.75 (a tick of slippage).
  const at = afterTarget => E.limitOutcome({ ...plan({ rows }), plan: { afterTarget: { trailBy: 'r', swingMinutes: null, ...afterTarget } } }).exitPrice;
  assert.deepStrictEqual([at({ lockGivebackR: 0.5, trailR: 1, ratchet: true }), at({ lockGivebackR: 0.5, trailR: 1 }), at({ lockGivebackR: 1.5, trailR: 3, ratchet: true })], [104.25, 107.5, 104.75]);
});

test('buildDecisions: every line tagged with the run\'s exit mode; its passes held under that exit', () => {
  const t = i => new Date(ms(T0) + i * M3).toISOString();
  const rows = [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 103.5, 104.25], [104.25, 106, 104.5, 105.5], [105.5, 105.75, 103, 103.5]];
  const args = { cycles: [{ at: t(0), roots: ['MNQ'] }, { at: t(3), roots: ['MNQ'] }], records: [record({ at: t(0) })].map(fromLifecycleRecord), barsFor: () => bars(T0, rows), tfMs: M3, tickOf: () => 0.25, runId: 'x' };
  const plain = E.buildDecisions(args);
  assert.deepStrictEqual(plain.map(d => d.exit), ['brackets', 'brackets']);
  assert.deepStrictEqual([plain[0].decision, plain[0].outcome.exitReason, plain[0].outcome.R], ['passed', 'target', 2]);
  const exit = { plan: { afterTarget: { lockGivebackR: 0.5, trailBy: 'r', trailR: 1, swingMinutes: null } }, mode: 'target_then_trail' };
  const held = E.buildDecisions({ ...args, exit });
  assert.deepStrictEqual(held.map(d => d.exit), ['target_then_trail', 'target_then_trail'], 'a plain pass too');
  assert.deepStrictEqual([held[0].outcome.exitReason, held[0].outcome.R], ['trail', 1.875]);
});

test('limitOutcome under a structure trail: the stop behind the last confirmed 15m swing low once one is confirmed (the R trail before)', () => {
  // Armed at 104 (2R); five 15m candles then make a swing low at 105, confirmed when the fifth closes; the fall exits.
  const rows = [[100.5, 100.75, 99.75, 100.25], [100.25, 102, 100.25, 101.75], [101.75, 103, 101.5, 102.75], [102.75, 104.5, 102.5, 104.25], [104.25, 105, 104, 104.75]];
  for (const x of [106, 105.5, 105, 106, 107]) for (let k = 0; k < 5; k += 1) rows.push([x + 0.5, x + 1.5, x, x + 1]);
  rows.push([107.5, 107.5, 103, 103.5], [103.5, 103.5, 101, 101.5]);
  const exit = trailBy => E.limitOutcome({ ...plan({ rows }), plan: { afterTarget: { lockGivebackR: 1.5, trailBy, trailR: 3, swingMinutes: 15 } } });
  // Structure: one tick under the swing (104.75), out a tick worse (104.5); the loose 3R trail only at 102.5 (102.25).
  assert.deepStrictEqual([exit('structure').exitReason, exit('structure').exitPrice, exit('structure').R], ['trail', 104.5, 2.25]);
  assert.deepStrictEqual([exit('r').exitPrice, exit('r').R], [102.25, 1.125]);
});

test('MAE and MFE in R: the counterfactual\'s and the fills\' from the bars held whole and the exit; unknown is null', () => {
  // Filled at 100 inside the first bar (left out: the dip before the fill is no MAE), 100 to 102 held (+1R), the 104
  // target inside the third (left out; the exit +2R).
  const win = E.limitOutcome(plan({ rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 102, 99.5, 101.75], [101.75, 104.25, 101.5, 104]] }));
  assert.deepStrictEqual([win.maeR, win.mfeR], [-0.25, 2], 'the held bar\'s low 99.5');
  // Stopped on the bar after the fill: no bar held whole (the fill bar and the stop bar both left out), so the move
  // while held can't be told: unknown, never the exit alone (it was -1.125R and 0).
  const loss = E.limitOutcome(plan({ rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 100.5, 97.5, 98]] }));
  assert.deepStrictEqual([loss.R, loss.maeR, loss.mfeR], [-1.125, null, null]);
  // Held one bar whole, then stopped: that bar and the stop's fill.
  const held = E.limitOutcome(plan({ rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 101, 99.5, 100.5], [100.5, 100.5, 97.5, 98]] }));
  assert.deepStrictEqual([held.maeR, held.mfeR], [-1.125, 0.5]);
  const short = E.limitOutcome({ ...plan({ rows: [[99.5, 100.25, 99.25, 99.75], [99.75, 99.75, 98.5, 99], [99, 99, 95.75, 96]], side: 'short', stop: 102, target: 96 }) });
  assert.deepStrictEqual([short.R, short.maeR, short.mfeR], [2, 0, 2], 'a short, mirrored: the held bar never above the fill, the target');
  const unfilled = E.limitOutcome(plan({ rows: [[100.5, 101, 100.25, 100.75], [100.75, 101, 99.5, 100]] }));
  assert.deepStrictEqual([unfilled.maeR, unfilled.mfeR], [null, null]);
  // A round trip: the bars wholly inside it (99 low: -0.5R; 104 high: +2R) and its exit.
  const rt = { openMs: ms(T0), closeMs: ms(T0) + 3 * M3, opens: [{ price: 100, size: 1 }], closes: [{ price: 103, size: 1 }] };
  const rows = bars(T0, [[100, 101, 99, 100.5], [100.5, 104, 100, 103.5], [103.5, 103.5, 102, 103], [103, 110, 90, 100]]);
  const o = E.tripOutcome(rt, { entry: 100, stop: 98 }, 'long', { bars: rows, tfMs: M3 });
  assert.deepStrictEqual([o.R, o.maeR, o.mfeR], [1.5, -0.5, 2], 'the bar after the exit never counts');
  assert.deepStrictEqual([E.tripOutcome(rt, { entry: 100, stop: 98 }, 'long').maeR, E.tripOutcome(rt, { entry: 100, stop: 98 }, 'long').mfeR], [null, null], 'no bars: unknown, never the exit alone');
  const open = E.tripOutcome({ ...rt, closeMs: null, closes: [] }, { entry: 100, stop: 98 }, 'long', { bars: rows, tfMs: M3 });
  assert.deepStrictEqual([open.R, open.maeR, open.mfeR], [null, null, null]);
  // Held under one bar (in at 14:01, out at 14:02): no bar wholly inside it, so unknown, never the exit alone.
  const sub = E.tripOutcome({ ...rt, openMs: ms(T0) + 60000, closeMs: ms(T0) + 120000, closes: [{ price: 99, size: 1 }] }, { entry: 100, stop: 98 }, 'long', { bars: rows, tfMs: M3 });
  assert.deepStrictEqual([sub.R, sub.maeR, sub.mfeR], [-0.5, null, null]);
});

test('MAE and MFE: bars that do not cover the trade (another day\'s, or a gap inside it) are unknown, never the exit alone', () => {
  const rt = { openMs: ms(T0), closeMs: ms(T0) + 3 * M3, opens: [{ price: 100, size: 1 }], closes: [{ price: 103, size: 1 }] };
  // The run home's bars file held only a later window (a replay's last snapshot): no bar of the trade.
  const later = bars(new Date(ms(T0) + 86400000).toISOString(), [[100, 101, 99, 100.5], [100.5, 104, 100, 103.5]]);
  const o = E.tripOutcome(rt, { entry: 100, stop: 98 }, 'long', { bars: later, tfMs: M3 });
  assert.deepStrictEqual([o.R, o.maeR, o.mfeR], [1.5, null, null]);
  // A bar missing inside the trade: its excursion can't be told.
  const all = bars(T0, [[100, 101, 99, 100.5], [100.5, 104, 100, 103.5], [103.5, 103.5, 102, 103]]);
  const gap = E.tripOutcome(rt, { entry: 100, stop: 98 }, 'long', { bars: [all[0], all[2]], tfMs: M3 });
  assert.deepStrictEqual([gap.maeR, gap.mfeR], [null, null]);
  // Covered: as before.
  assert.deepStrictEqual([E.tripOutcome(rt, { entry: 100, stop: 98 }, 'long', { bars: all, tfMs: M3 }).maeR], [-0.5]);
});

test('limitOutcome: no bar at the decision (the bars are another day\'s) is unknown, never unfilled; its pass is ungraded', () => {
  const later = new Date(ms(T0) + 86400000).toISOString();
  const o = E.limitOutcome({ ...plan({ rows: [] }), bars: bars(later, [[100.5, 100.75, 99.75, 100.25], [99, 99, 98, 98.5]]) });
  assert.deepStrictEqual([o.filled, o.exitReason, o.R, o.maeR, o.mfeR], [null, 'no bars at the decision', null, null, null]);
  assert.strictEqual(E.gradeOf('passed', o), null, 'no outcome known: no grade');
  // The bar in progress at the decision is there: an ordinary unfilled limit, as before.
  const end = E.limitOutcome(plan({ rows: [[100.5, 101, 100.25, 100.75]], expiry: 1 }));
  assert.deepStrictEqual([end.filled, end.exitReason], [false, 'unfilled']);
});

test('writeRunExperience: the run\'s archived bars (bars-<day>.jsonl.gz), not only the home\'s last snapshot, score its decisions', () => {
  const A = require('../../scripts/lib/session/bars-archive');
  const times = [T0, new Date(ms(T0) + M3).toISOString()];
  const fills = [
    { id: 1, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:01:00Z', price: 100, size: 1, side: 0, profitAndLoss: null },
    { id: 2, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:20:00Z', price: 98.5, size: 1, side: 1, profitAndLoss: -3 },
  ];
  // The home's bars file: a later day's window only (the runner rewrites it every bar).
  const { home, dir } = runDir({ times, fills, records: [record({ at: T0 })], barRows: [[1, 1, 1, 1]], barsStart: '2023-03-17T14:00:00.000Z' });
  A.appendBars(dir, '2023-03-15', { symbol: 'MNQ', contractId: 'MNQ', minutes: 3, bars: bars(T0, TRADE_ROWS) });
  const r = writeRunExperience(dir, { now: new Date('2026-10-14T00:00:00Z') });
  assert.ok(fs.realpathSync(home));
  // The 14:03 bar wholly inside the trade (its high 101, +0.5R) and the exit (98.5, -0.75R): from the archive.
  assert.deepStrictEqual([r.decisions[0].decision, r.decisions[0].outcome.maeR, r.decisions[0].outcome.mfeR], ['entered', -0.75, 0.5]);
});

test('writeRunExperience: each pass\'s class from the store line\'s entry record (or its result line), in the log', () => {
  const t1 = new Date(ms(T0) + 10 * M3).toISOString();
  const { dir } = runDir({
    times: [T0, t1], records: [record({ at: T0 }), record({ at: t1 })], barRows: TRADE_ROWS,
    cycleOf: {
      [T0]: { result: 'CYCLE RESULT: no-trade - the runner\'s entry: ...', entry: { outcome: 'late', late: 'missed-entry' } },
      [t1]: { result: 'CYCLE RESULT: no-trade - risk-manager vetoed the trade_lifecycle long 1 MNQ: VERDICT: VETO - stand aside', entry: { outcome: 'vetoed', vetoBasis: 'unstated' } },
    },
  });
  const r = writeRunExperience(dir, { now: new Date('2026-10-14T00:00:00Z') });
  assert.deepStrictEqual(E.readDecisions(r.file).map(d => [d.decision, d.passClass, d.vetoBasis]), [['passed', 'missed_fill', undefined], ['passed', 'vetoed', 'unstated']]);
});

test('stateRead: the cycle\'s STATE read and its score on each of its lines (plain passes too), from the store line to the log; a cycle without one, none', () => {
  const t1 = new Date(ms(T0) + 10 * M3).toISOString();
  const t2 = new Date(ms(T0) + 20 * M3).toISOString();
  const read = { status: 'read', line: 'STATE: 4h up | 1h down', read: { frames: { '4h': 'up', '1h': 'down' }, day: null, agree: null }, missing: ['15m', 'day', 'frames'], bad: [], symbol: 'MNQ', bar: T0, briefing: null, fields: { '4h': { read: 'up', fact: 'up', field: 'h1.h4.trend', result: 'match' }, '1h': { read: 'down', fact: 'up', field: 'h1.h1.trend', result: 'mismatch' } }, counts: { match: 1, mismatch: 1, unknown: 0 }, facts: null };
  const none = { status: 'none', line: null, read: null, missing: [], bad: [], symbol: 'MNQ', bar: t1, briefing: null, fields: {}, counts: { match: 0, mismatch: 0, unknown: 0 }, facts: null };
  const { dir } = runDir({
    times: [T0, t1, t2], records: [record({ at: T0 })], barRows: TRADE_ROWS,
    cycleOf: { [T0]: { result: 'CYCLE RESULT: no-trade - x', stateRead: read }, [t1]: { result: 'CYCLE RESULT: no-trade - y', stateRead: none } },
  });
  const r = writeRunExperience(dir, { now: new Date('2026-10-14T00:00:00Z') });
  const lines = E.readDecisions(r.file);
  assert.deepStrictEqual(lines.map(d => [d.decision, d.stateRead ? d.stateRead.status : undefined]), [['passed', 'read'], ['none', 'none'], ['none', undefined]]);
  assert.deepStrictEqual(lines[0].stateRead, read, 'kept as recorded: the read, each field\'s score, the counts');
  // Another symbol's read is not this root's: left off its line.
  const other = E.buildDecisions({ cycles: [{ at: T0, roots: ['MNQ'], stateRead: { ...read, symbol: 'MES' } }], records: [], runId: 'run1' });
  assert.strictEqual(other[0].stateRead, undefined);
  // The same family (NQ for MNQ) is the root's.
  assert.ok(E.buildDecisions({ cycles: [{ at: T0, roots: ['MNQ'], stateRead: { ...read, symbol: 'NQ' } }], records: [], runId: 'run1' })[0].stateRead);
  // An additive field: the version stays, so a run's older lines still append alongside.
  assert.strictEqual(E.VERSION, 3);
});

test('VERSION 3: grades name the model\'s passes apart (passClass); an older log still reads; a run logged by an older version is refused unless rebuilt', () => {
  assert.strictEqual(E.VERSION, 3);
  const file = path.join(tmpHome(), 'experience', 'decisions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = { v: 2, id: 'old', runId: 'r1', decision: 'passed', grade: 'neutral-pass' };
  fs.writeFileSync(file, `${JSON.stringify(old)}\n${JSON.stringify({ v: 2, id: 'keep', runId: 'r2' })}\n`);
  assert.deepStrictEqual(E.readDecisions(file).map(d => [d.id, d.v]), [['old', 2], ['keep', 2]], 'old lines read as written');
  assert.throws(() => E.appendDecisions(file, [{ id: 'new', v: 3, runId: 'r1' }]), /version 2, not 3/);
  // Replaced: that run's lines (any version) out, the new ones in; every other run's line kept as written.
  assert.deepStrictEqual(E.replaceDecisions(file, 'r1', [{ id: 'new', v: 3, runId: 'r1' }]), { removed: 1, added: 1 });
  assert.deepStrictEqual(E.readDecisions(file).map(d => [d.id, d.runId]), [['keep', 'r2'], ['new', 'r1']]);
  assert.throws(() => E.replaceDecisions(file, 'r1', [{ id: 'x', v: 3, runId: 'r9' }]), /another run/);
});

test('writeRunExperience --rebuild: a log written before a fix is rewritten (append-only keeps it), and indexes built from it set aside', () => {
  const X = require('../../scripts/lib/learning/experience-index');
  const { home, dir } = runDir({ times: [T0], records: [record({ at: T0 })], barRows: TRADE_ROWS });
  const file = E.logFile(home);
  // The log as an older writer left it: the same ids, other grades (version 2).
  const first = writeRunExperience(dir, { now: new Date('2026-10-14T00:00:00Z') });
  const lines = fs.readFileSync(first.file, 'utf8').trim().split('\n').map(JSON.parse);
  fs.writeFileSync(first.file, lines.map(l => `${JSON.stringify({ ...l, v: 2, grade: 'neutral-pass', outcome: { ...l.outcome, maeR: -9 } })}\n`).join(''));
  assert.throws(() => writeRunExperience(dir), /version 2, not 3/, 'appending never fixes it');
  // An index built from the run's log, one from another run, and the same index pinned by this run's home and by
  // another run's (pinIndex: a frozen index-<hash>.json beside pinned.json, which names it).
  const idxDir = path.join(tmpHome(), 'experience');
  fs.mkdirSync(idxDir, { recursive: true });
  const built = X.writeIndex(idxDir, X.buildIndex(E.readDecisions(file).map(d => ({ ...d, v: 3 })), { runs: [{ runId: 'run1', file, sha256: 'a' }] }));
  const other = path.join(idxDir, 'index-0000.json');
  fs.writeFileSync(other, JSON.stringify({ v: 3, runs: [{ runId: 'run9' }] }));
  const homeB = tmpHome();
  X.pinIndex(home, built);
  X.pinIndex(homeB, built);
  // A copy set aside by an earlier rebuild: never overwritten.
  fs.writeFileSync(`${built}.stale`, 'earlier');
  const r = writeRunExperience(dir, { rebuild: true, indexDirs: [idxDir, path.join(homeB, 'experience')], now: new Date('2026-10-15T00:00:00Z') });
  assert.deepStrictEqual([r.added, r.rebuilt.removed], [lines.length, lines.length]);
  assert.ok(E.readDecisions(file).every(d => d.v === 3 && !(d.outcome && d.outcome.maeR === -9)), 'every line the fixed writer\'s');
  assert.deepStrictEqual(r.rebuilt.staleIndexes, [built]);
  assert.ok(!fs.existsSync(built) && fs.existsSync(`${built}.stale.1`), 'set aside, never deleted');
  assert.strictEqual(fs.readFileSync(`${built}.stale`, 'utf8'), 'earlier', 'the earlier set-aside copy kept');
  assert.ok(fs.existsSync(other), 'another run\'s index untouched');
  assert.strictEqual(X.loadPinned(home).hash, X.loadPinned(homeB).hash, 'both runs\' pinned copies still load');
  assert.match(require('../../scripts/lib/learning/run-experience').experienceLine(r), /rebuilt run run1: 1 line\(s\) replaced by 1 \(practice-train\) in .*; 1 index\(es\) built from it set aside \(rebuild them\): index-/);
});

test('replaceDecisions: a rebuild that finds no line for a run that had some is refused (a pruned store would erase it), unless allowed', () => {
  const file = path.join(tmpHome(), 'experience', 'decisions.jsonl');
  E.appendDecisions(file, [{ id: 'a', v: E.VERSION, runId: 'r1' }, { id: 'b', v: E.VERSION, runId: 'r2' }]);
  assert.throws(() => E.replaceDecisions(file, 'r1', []), /run r1 had 1 line\(s\) and the rebuild computed none: refused \(--allow-empty to erase them\)/);
  assert.deepStrictEqual(E.readDecisions(file).map(d => d.id), ['a', 'b'], 'nothing written');
  assert.deepStrictEqual(E.replaceDecisions(file, 'r1', [], { allowEmpty: true }), { removed: 1, added: 0 });
  assert.deepStrictEqual(E.replaceDecisions(file, 'r3', []), { removed: 0, added: 0 }, 'a run with none: nothing to lose');
});

test('writeRunExperience: a curated run\'s lines are tagged curated (outcome-balanced: the experience index labels them)', () => {
  const C = require('../../scripts/lib/learning/curated-lists');
  const X = require('../../scripts/lib/learning/experience-index');
  const { home, dir } = runDir({ times: [T0], fills: [], records: [record({ at: T0 })], barRows: [[100.5, 100.75, 99.75, 100.25], [100.25, 101, 99.5, 100.5]] });
  const pin = { fingerprint: 'f', list: 'mix', windows: [] };
  const hash = require('crypto').createHash('sha256').update(JSON.stringify(pin)).digest('hex');
  fs.mkdirSync(path.join(home, 'experience'), { recursive: true });
  fs.writeFileSync(path.join(home, 'experience', 'curated-pinned.json'), JSON.stringify({ kind: 'curated-pin', ...pin, hash }));
  assert.ok(C.loadPinnedCurated(home), 'a valid pin');
  const r = writeRunExperience(dir, { now: new Date('2026-10-14T00:00:00Z') });
  assert.ok(r.decisions.length && r.decisions.every(d => d.curated === true));
  assert.ok(E.readDecisions(r.file).every(d => d.curated === true), 'in the log');
  assert.strictEqual(X.buildIndex(E.readDecisions(r.file)).curated, r.decisions.filter(d => d.signatures.skill && d.decision !== 'none').length);
});

test('MAE and MFE: an entered trade and its counterfactual twin on the same bars measure the same', () => {
  // A long limit at 100 filled inside the first bar, held two bars whole, out inside the fourth: at its target (104), or
  // stopped (97.75). The twin: the same fill and exit as real fills, at times inside those bars.
  const rows = [[100.5, 100.75, 99, 100.25], [100.25, 101.5, 99.25, 101], [101, 103, 100.5, 102.5]];
  for (const [last, exit] of [[[102.5, 104.5, 102, 104], 104], [[100.5, 100.75, 97, 97.5], 97.75]]) {
    const cf = E.limitOutcome({ ...plan({ rows: [...rows, last], expiry: 1 }) });
    assert.strictEqual(cf.exitPrice, exit);
    const rt = { openMs: ms(T0) + 60000, closeMs: ms(T0) + 3 * M3 + 60000, opens: [{ price: 100, size: 1 }], closes: [{ price: exit, size: 1 }] };
    const real = E.tripOutcome(rt, { entry: 100, stop: 98 }, 'long', { bars: bars(T0, [...rows, last]), tfMs: M3 });
    assert.deepStrictEqual([real.R, real.maeR, real.mfeR], [cf.R, cf.maeR, cf.mfeR], `exit ${exit}`);
  }
  // Their values: the held bars' low 99.25 (-0.375R) and high 103 (+1.5R), the exit's +2R or -1.125R.
  assert.deepStrictEqual([E.limitOutcome({ ...plan({ rows: [...rows, [102.5, 104.5, 102, 104]] }) }).maeR], [-0.375]);
});

test('limitOutcome, market (a cited setup\'s record): fills at once at the open of the bar it was sent in, never waits for the reference; the brackets from that fill', () => {
  // Sent 20 s into the first bar: filled at its open 100.5 (above the 100 reference a limit would wait for), the stop
  // and target the record's distances (2 and 4 points) from the fill: target 104.5 on the second bar.
  const sent = { ...plan({ rows: [[100.5, 100.75, 100.25, 100.5], [100.5, 104.75, 100.25, 104.5]] }), fromMs: ms(T0) + 20000, market: true };
  const m = E.limitOutcome(sent);
  assert.deepStrictEqual([m.filled, m.entryPrice, m.entryTime, m.exitPrice, m.exitReason, m.R], [true, 100.5, T0, 104.5, 'target', 2]);
  // The same as a limit: never traded back to 100 before it expired, unfilled.
  assert.strictEqual(E.limitOutcome({ ...sent, market: false }).filled, false);
  // Sent after the window: no fill; at the end of day: none either.
  assert.strictEqual(E.limitOutcome({ ...sent, expiresMs: ms(T0) }).filled, false);
  assert.strictEqual(E.limitOutcome({ ...sent, eodMs: ms(T0) + M3 - 1 }).filled, false);
  // The record's market entry reaches the line: fromLifecycleRecord keeps its type (only when market).
  const rec = fromLifecycleRecord({ id: 'x', side: 'long', root: 'MNQ', bar: T0, plan: { entry: { type: 'market', price: 100 }, stop: { price: 98 }, target: { price: 104 } } });
  assert.deepStrictEqual([rec.plan.entry, rec.plan.entryType], [100, 'market']);
  assert.strictEqual('entryType' in fromLifecycleRecord({ id: 'y', side: 'long', root: 'MNQ', bar: T0, plan: { entry: { type: 'limit', price: 100 } } }).plan, false);
});

test('trip excursion: tripOutcome\'s one definition of MAE and MFE, with the bars to the best move (the trade feedback reads it)', () => {
  const rows = bars(T0, [[100, 101, 99, 100.5], [100.5, 104, 100, 103.5], [103.5, 103.5, 102, 103], [103, 110, 90, 100]]);
  const x = { side: 'long', entryPrice: 100, exitPrice: 103, openMs: ms(T0), closeMs: ms(T0) + 3 * M3, risk: 2, bars: rows, tfMs: M3 };
  // The best (104) on the fill's bar + 1; tripOutcome reports the same MAE and MFE.
  assert.deepStrictEqual(E.tripExcursion(x), { maeR: -0.5, mfeR: 2, mfeBars: 1 });
  const rt = { openMs: x.openMs, closeMs: x.closeMs, opens: [{ price: 100, size: 1 }], closes: [{ price: 103, size: 1 }] };
  const o = E.tripOutcome(rt, { entry: 100, stop: 98 }, 'long', { bars: rows, tfMs: M3 });
  assert.deepStrictEqual([o.maeR, o.mfeR], [-0.5, 2]);
  assert.ok(!('mfeBars' in o), 'the experience line keeps its fields');
  // The exit beyond every bar held whole: the best is the exit's, on its bar.
  assert.deepStrictEqual(E.tripExcursion({ ...x, exitPrice: 105 }), { maeR: -0.5, mfeR: 2.5, mfeBars: 2 });
  // A tie keeps the first bar that reached it.
  assert.deepStrictEqual(E.tripExcursion({ ...x, exitPrice: 104 }).mfeBars, 1);
  // Nothing in its favour: no bar to name.
  const down = bars(T0, [[100, 100, 98.5, 99], [99, 99.5, 98.5, 99]]);
  assert.deepStrictEqual(E.tripExcursion({ ...x, exitPrice: 98.5, closeMs: ms(T0) + 2 * M3, bars: down }), { maeR: -0.75, mfeR: 0, mfeBars: null });
  // A short, mirrored.
  const sh = bars(T0, [[100, 100.5, 99, 99.5], [99.5, 99.5, 97, 97.5]]);
  assert.deepStrictEqual(E.tripExcursion({ ...x, side: 'short', exitPrice: 98, closeMs: ms(T0) + 2 * M3, bars: sh }), { maeR: -0.25, mfeR: 1.5, mfeBars: 1 });
  // Unknown, never the exit alone: no bars, a gap, held under one bar, no risk.
  const none = { maeR: null, mfeR: null, mfeBars: null };
  assert.deepStrictEqual(E.tripExcursion({ ...x, bars: [] }), none);
  assert.deepStrictEqual(E.tripExcursion({ ...x, bars: [rows[0], rows[2]] }), none);
  assert.deepStrictEqual(E.tripExcursion({ ...x, openMs: ms(T0) + 60000, closeMs: ms(T0) + 120000 }), none);
  assert.deepStrictEqual(E.tripExcursion({ ...x, risk: 0 }), none);
  assert.deepStrictEqual(E.tripExcursion({ ...x, side: 'flat' }), none);
});
