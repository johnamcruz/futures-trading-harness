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
  assert.deepStrictEqual([passed.outcome.maeR, passed.outcome.mfeR], [0, 2], 'the counterfactual\'s: filled inside the second bar (left out), out at its target');
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
  const { home, dir } = runDir({ times, fills, records: [record({ at: T0 })], barRows: [[100.5, 100.75, 99.75, 100.25], [100.25, 101, 99.5, 100.5]] });
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
  assert.throws(() => E.appendDecisions(file, [{ id: 'new', v: E.VERSION, runId: 'r1' }]), /run r1's decisions were written by experience log version 1, not 2: delete that run's lines/);
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
  // Stopped: the stop's fill with slippage (97.75, -1.125R); the stop bar itself left out.
  const loss = E.limitOutcome(plan({ rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 100.5, 97.5, 98]] }));
  assert.deepStrictEqual([loss.maeR, loss.mfeR], [-1.125, 0]);
  const short = E.limitOutcome({ ...plan({ rows: [[99.5, 100.25, 99.25, 99.75], [99.75, 100, 95.75, 96]], side: 'short', stop: 102, target: 96 }) });
  assert.deepStrictEqual([short.maeR, short.mfeR], [0, 2], 'a short, mirrored');
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
