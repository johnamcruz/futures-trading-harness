'use strict';

// The leg ledger (scripts/lib/train/leg-ledger.js): per trend leg of the champion's trend runs, the leg's facts, the
// model's recorded reads over the leg's window (each cycle's class from its recorded code, the reason the model stated,
// the scorecard's own verdict on it), and the outcome; aggregates by class with n beside every figure; unknown R stays
// unknown; priorOnly never reads a later (or the same) day; the round reader picks the half's finished legs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const LL = require('../../scripts/lib/train/leg-ledger');

const MIN3 = 3 * 60000;
const iso = ms => new Date(ms).toISOString();
const at = (day, hhmm) => Date.parse(`${day}T${hhmm}:00.000Z`);

/** A capture cycle (trend-capture.js classifyCycle's shape) on the bar closing at `close`. */
const cyc = (close, code, { by = 'head', step = null, message = '' } = {}) => ({ bar: iso(close), planned: false, side: 'long', step, by, code, message, reads: [], role: null });
/** A scorecard decision (loop.js scorecardDecisions' shape) on the bar opening one step before `close`. */
const dec = (close, { expected = 'no-trade', category = 'right', stated = '', counterfactual } = {}) => ({
  key: `${iso(close + 2000)}|MNQ`, t: iso(close + 2000), day: iso(close).slice(0, 10), barT: iso(close - MIN3), category, expected: { decision: expected, setup: null }, actual: { action: 'none' }, stated, ...(counterfactual ? { counterfactual } : {}),
});
/** A capture leg (trend-capture.js captureReport's leg). */
function leg(day, side, startHHMM, { captured = false, availableR = 2, estimated = false, cycles = [], blocker = null, ride = null, points = 40 } = {}) {
  const start = at(day, startHHMM);
  return { id: `${day}|${side}|${iso(start)}`, day, side, start: iso(start), end: iso(start + 10 * MIN3), move: { points }, availableR, estimated, captured, ride, cycles, blocker };
}

// Day A: a long leg missed to a location refusal (with a no-plan cycle before it that the model said was the trend rule
// on its own side), 3R; a caught leg refused once at the opening print, then entered; a leg missed behind an open position.
const A = '2026-03-02';
const a0 = at(A, '14:30');
const missedLoc = leg(A, 'long', '14:27', {
  availableR: 3,
  cycles: [
    cyc(a0, 'no-plan', { message: 'no-trade - long "15m broke ib high up" is against the trend rule' }),
    cyc(a0 + MIN3, 'location:false', { by: 'compose_check', step: 'location', message: 'at session POC: outside the bar\'s range' }),
    cyc(a0 + 2 * MIN3, 'location:false', { by: 'compose_check', step: 'location', message: 'at session POC again' }),
  ],
  blocker: { step: 'location', code: 'location:false', by: 'compose_check', role: 'head trader', skills: [], cycles: 1 },
});
const b0 = at(A, '15:30');
const caught = leg(A, 'long', '15:27', {
  captured: true, availableR: 4,
  cycles: [cyc(b0, 'opening-print', { by: 'rule', message: 'no-trade - opening print' }), cyc(b0 + MIN3, 'entered', { by: 'executor', step: 'execution', message: 'order placed: abc' }), cyc(b0 + 2 * MIN3, 'position-open', { message: 'managed - held' }), cyc(b0 + 3 * MIN3, 'no-plan', { message: 'no-trade - flat after the exit' })],
  ride: { entryLag: 0.25, captureShare: 0.3, rideShare: 0.4, peakR: 2.5, peakFrom: 'round-trip', givebackR: 1.3, r: 1.2, open: false },
});
const c0 = at(A, '16:00');
const behind = leg(A, 'short', '15:57', { availableR: 1, cycles: [cyc(c0, 'position-open', { message: 'managed - long held' })], blocker: { step: null, code: 'position-open', by: 'head', role: null, skills: [], cycles: 1 } });
const decisionsA = [
  dec(a0, { stated: 'CYCLE RESULT: no-trade - long "15m broke ib high up" is against the trend rule (4h and 1h down)', counterfactual: { simulated: false, R: 9 } }),
  dec(a0 + MIN3, { expected: 'take', category: 'excessive abstention', stated: 'CYCLE RESULT: no-trade - compose refused; the long setup is stale', counterfactual: { simulated: true, R: 1.5 } }),
  dec(b0, { category: 'excessive abstention', stated: 'CYCLE RESULT: no-trade - opening print' }),
];

// Day B: a leg whose R is unknown (no stop known), missed to no plan; and an estimated one missed to a head pass.
const B = '2026-03-03';
const d0 = at(B, '14:30');
const unknownR = leg(B, 'long', '14:27', { availableR: null, cycles: [cyc(d0, 'no-plan', { message: 'no-trade - no long setup' })], blocker: { step: null, code: 'no-plan', by: 'head', role: 'head trader', skills: [], cycles: 1 } });
const e0 = at(B, '15:30');
const headPass = leg(B, 'short', '15:27', { availableR: 5, estimated: true, cycles: [cyc(e0, 'head-pass', { step: 'risk', message: 'no-trade - compose_check OK but the 15m reaction is conflicting' })], blocker: { step: 'risk', code: 'head-pass', by: 'head', role: 'head trader', skills: [], cycles: 1 } });

const runA = { capture: { legs: [missedLoc, caught, behind] }, decisions: decisionsA, minutes: 3, half: 'probe' };
const runB = { capture: { legs: [unknownR, headPass] }, decisions: [], minutes: 3, half: 'confirm' };

test('leg ledger: CLASSES are frozen, each said; the code classes map the capture\'s codes', () => {
  assert.ok(Object.isFrozen(LL.CLASSES) && LL.CLASSES.every(c => Object.isFrozen(c) && c.says.length > 10));
  const names = LL.CLASSES.map(c => c.key);
  for (const k of ['trend-rule', 'location', 'entry-reaction', 'htf-choch-against', 'position-open', 'opening-print', 'head-pass', 'executor-blocked', 'unfilled', 'no-plan', 'late-entry-chase']) assert.ok(names.includes(k), k);
  const of = (code, by = 'head', step = null) => LL.codeClass({ code, by, step });
  assert.strictEqual(of('location:false', 'compose_check', 'location'), 'location');
  assert.strictEqual(of('entry:false', 'compose_check', 'entry'), 'entry-reaction');
  assert.strictEqual(of('stop:missing', 'compose_check', 'stop'), 'compose-stop');
  assert.strictEqual(of('refused', 'compose_check', null), 'compose-refused');
  assert.strictEqual(of('opening-print', 'rule'), 'opening-print');
  assert.strictEqual(of('news', 'rule'), 'news');
  assert.strictEqual(of('position-open'), 'position-open');
  assert.strictEqual(of('head-pass', 'head', 'risk'), 'head-pass');
  assert.strictEqual(of('no-plan'), 'no-plan');
  assert.strictEqual(of('blocked', 'executor', 'execution'), 'executor-blocked');
  assert.strictEqual(of('executor-abort', 'executor', 'execution'), 'executor-blocked');
  assert.strictEqual(of('unfilled', 'executor', 'execution'), 'unfilled');
  assert.strictEqual(of('late-entry', 'gate', 'execution'), 'late-entry-chase');
  assert.strictEqual(of('max-risk', 'gate', 'execution'), 'gate-refused');
  assert.strictEqual(of('veto', 'phase2', 'risk'), 'risk-veto');
  assert.strictEqual(of('verdict-unread', 'phase2', 'risk'), 'risk-veto');
  assert.strictEqual(of('min-contracts', 'phase2', 'risk'), 'size-floor');
  assert.strictEqual(of('outside-session', 'rule'), 'outside-session');
  assert.strictEqual(of('entered', 'executor', 'execution'), 'entered');
  assert.strictEqual(of('something-new', 'head'), 'unknown');
});

test('leg ledger: the stated reason is read for the leg\'s own side only; nothing matched is null, never a guess', () => {
  const s = LL.statedClass;
  assert.strictEqual(s('no-trade - long "15m rejected vwap" is against the trend rule (4h and 1h down)', 'long'), 'trend-rule');
  assert.strictEqual(s('no-trade - the trend rule refuses the short here', 'short'), 'trend-rule');
  // The counter-side trap: the other side's setups refused by the trend rule say nothing about this long leg.
  assert.strictEqual(s('no-trade - no long setup on the 15m at a key level; the four 15m shorts are against the trend rule (4h and 1h up, LONG allowed only)', 'long'), null);
  assert.strictEqual(s('no-trade - the only listed setup (long 15m rejected 5m FVG high) is against the SHORT-only trend rule', 'short'), null);
  assert.strictEqual(s('no-trade - the only listed setup (long 15m rejected 5m FVG high) is against the SHORT-only trend rule', 'long'), 'trend-rule');
  assert.strictEqual(s('no-trade - the 1h CHoCH down is against the long', 'long'), 'htf-choch-against');
  assert.strictEqual(s('no-trade - short passed compose_check, but the 15m and 1h CHoCH up are against, and the trend is not declared', 'short'), 'htf-choch-against');
  assert.strictEqual(s('no-trade - the 1h CHoCH up is against the short', 'long'), null);
  assert.strictEqual(s('no-trade - no 1h CHoCH down against it yet, waiting', 'long'), null);
  assert.strictEqual(s('no-trade - the 1h CHoCH up is with the long', 'long'), null);
  // A CHoCH the text says is needed and absent is no CHoCH against.
  assert.strictEqual(s('no-trade - four 15m shorts are against the trend rule (4h and 1h up, LONG allowed only); no long setup fired, and the reversal tier needs a 1h CHoCH down, which is absent.', 'long'), null);
  // The other side's refusal after this side's own (a plan refusal): this side's is the plan's, not the trend rule's.
  assert.strictEqual(s('no-trade - the long is refused by the standard plan (R:R 0.324 under min 2) and both shorts are against the trend rule', 'long'), 'room-rr');
  // The soft reasons: on a no-plan cycle only in a clause naming the leg's side first; on a head-pass (own) anywhere.
  assert.strictEqual(s('no-trade - long "15m rejected prior close" is a conflicting reaction', 'long'), 'entry-reaction');
  assert.strictEqual(s('no-trade - 15m rejected prior close is a conflicting reaction', 'long'), null);
  assert.strictEqual(s('no-trade - 15m rejected prior close is a conflicting reaction', 'long', { own: true }), 'entry-reaction');
  assert.strictEqual(s('no-trade - long setup is stale (price 54 pts above the level, a chase)', 'long'), 'late-entry-chase');
  assert.strictEqual(s('no-trade - "15m broke poc up" long: standard plan refused (R:R 0.11 under min 2)', 'long'), 'room-rr');
  assert.strictEqual(s('no-trade - standard plan refused (R:R 0.11 under min 2)', 'long', { own: true }), 'room-rr');
  // No setup the leg's way is no plan, whatever else the text reads (real wordings, paraphrased).
  assert.strictEqual(s('no-trade - the only listed setup "15m rejected vwap up" is long, against the trend rule; no short setup on the 15m, and price is above VAH with no rejection', 'short'), null);
  assert.strictEqual(s('no-trade - the only listed setup, "15m rejected vwap down" (short), is against the trend rule (LONG allowed, no short against it) and its reaction reads plain', 'long'), null);
  assert.strictEqual(s('no-trade - the short is against the trend rule; no 15m long setup at a level has closed, and the 3m rejection reads plain', 'long'), null);
  // The other side's reaction read is not this side's.
  assert.strictEqual(s('no-trade - the short "15m rejected high" is conflicting', 'long'), null);
  assert.strictEqual(s('no-trade - compose_check short OK, but no size fits: pass', 'short'), 'size-floor');
  assert.strictEqual(s('no-trade - no short setup, and the long "15m broke ib" is against the trend rule', 'short'), null);
  // A rule the text names comes first (the capture's own rule codes miss this wording).
  assert.strictEqual(s('no-trade - loss-streak stop (2 losing trades in a row): entries blocked; the 15m rejections read plain', 'short'), 'loss-streak');
  assert.strictEqual(s('no-trade - flat, nothing to do', 'long'), null);
  assert.strictEqual(s('', 'long'), null);
  assert.strictEqual(s(null, 'long'), null);
});

test('leg ledger: a row joins the leg\'s facts, each cycle\'s recorded read with the scorecard\'s verdict, and the outcome', () => {
  const led = LL.buildLedger([runA, runB]);
  assert.strictEqual(led.rows.length, 5);
  const m = led.rows.find(r => r.id === missedLoc.id);
  assert.deepStrictEqual([m.day, m.side, m.half, m.availableR, m.estimated, m.captured], [A, 'long', 'probe', 3, false, false]);
  // The no-plan cycle: its code class no-plan, its stated reason (from the scorecard row's full text) trend-rule.
  assert.deepStrictEqual(m.reads.map(x => [x.class, x.stated, x.reason, x.flat]), [['no-plan', 'trend-rule', 'trend-rule', true], ['location', null, 'location', true], ['location', null, 'location', true]]);
  // The scorecard joins by bar (its barT one step before the cycle's close): its verdict and counterfactual R.
  assert.deepStrictEqual(m.reads[1].scorecard, { expected: 'take', category: 'excessive abstention', counterfactualR: 1.5 });
  assert.deepStrictEqual(m.reads[0].scorecard, { expected: 'no-trade', category: 'right', counterfactualR: null });
  // The leg's blocker: the capture's (its code's class) and that cycle's stated reason; the outcome is the miss.
  // The latest cycle with the blocker's code is the blocker's (the furthest stage, the latest among equals).
  assert.deepStrictEqual(m.blocker, { class: 'location', reason: 'location', code: 'location:false', bar: iso(a0 + 2 * MIN3), cycles: 1 });
  assert.deepStrictEqual(m.outcome, { kind: 'missed', availableR: 3 });
  assert.deepStrictEqual(m.refusals, { 'no-plan': 1, location: 2 });
  // A caught leg: its refusal before the entry counts, the entry and its own position's cycles do not; outcome from its ride.
  const c = led.rows.find(r => r.id === caught.id);
  assert.strictEqual(c.blocker, null);
  assert.deepStrictEqual(c.refusals, { 'opening-print': 1 });
  assert.deepStrictEqual(c.outcome, { kind: 'entered', entryLag: 0.25, peakR: 2.5, bankedR: 1.2, givebackR: 1.3, open: false });
  // A flat read after the leg's own entry (the trade closed) is no refusal of the leg.
  assert.deepStrictEqual(c.reads.map(x => [x.flat, x.beforeEntry]), [[true, true], [false, false], [false, false], [true, false]]);
  // No scorecard row on a bar: unknown (null), never dropped.
  assert.strictEqual(c.reads[2].scorecard, null);
  // Behind an open position: not a flat read, so no refusal; the blocker still says why it was missed.
  const p = led.rows.find(r => r.id === behind.id);
  assert.deepStrictEqual([p.refusals, p.blocker.class, p.reads[0].flat], [{}, 'position-open', false]);
  // A run without the timeframe can't join its scorecard: every read's verdict unknown, counted.
  const noTf = LL.buildLedger([{ ...runA, minutes: null }]);
  assert.ok(noTf.rows.every(r => r.reads.every(x => x.scorecard === null)));
  assert.strictEqual(noTf.totals.scorecard.unjoined, 8);
  assert.strictEqual(led.totals.scorecard.unjoined, 5 + 2);
});

test('leg ledger: a leg id filter keeps only the listed legs; the half is the run\'s', () => {
  const led = LL.buildLedger([{ ...runA, include: [caught.id] }]);
  assert.deepStrictEqual(led.rows.map(r => r.id), [caught.id]);
});

test('leg ledger: aggregates by class carry n beside each figure; unknown R is counted, never summed as 0', () => {
  const led = LL.buildLedger([runA, runB]);
  const t = led.totals;
  assert.deepStrictEqual([t.legs, t.caught, t.missed], [5, 1, 4]);
  // R available: 3 + 4 + 1 + 5 over 4 known legs; one unknown, one estimated.
  assert.deepStrictEqual(t.rAvailable, { n: 4, sum: 13, mean: 3.25, median: 3.5, unknown: 1, estimated: 1 });
  assert.deepStrictEqual(t.rMissed, { n: 3, sum: 9, mean: 3, median: 3, unknown: 1, estimated: 1 });
  assert.deepStrictEqual(t.rCaught, { n: 1, sum: 1.2, unknown: 0 });
  const by = Object.fromEntries(led.byClass.map(x => [x.class, x]));
  // Blocked: the missed legs whose blocker is of the class; no-plan's leg has no R: n 0, unknown 1, mean null (not 0).
  assert.deepStrictEqual(by['no-plan'].blocked, { legs: 1, r: { n: 0, sum: 0, mean: null, median: null, unknown: 1, estimated: 0 } });
  assert.deepStrictEqual(by.location.blocked.r, { n: 1, sum: 3, mean: 3, median: 3, unknown: 0, estimated: 0 });
  assert.deepStrictEqual(by['head-pass'].blocked.r, { n: 1, sum: 5, mean: 5, median: 5, unknown: 0, estimated: 1 });
  // Refused in: the legs a flat read of the class refused that still ran (caught after it, or missed).
  assert.deepStrictEqual(by['opening-print'].refusedIn, { legs: 1, caught: 1, missed: 0, cycles: 1, r: { n: 1, sum: 4, mean: 4, median: 4, unknown: 0, estimated: 0 } });
  assert.strictEqual(by['opening-print'].blocked.legs, 0);
  assert.deepStrictEqual(by['no-plan'].refusedIn, { legs: 2, caught: 0, missed: 2, cycles: 2, r: { n: 1, sum: 3, mean: 3, median: 3, unknown: 1, estimated: 0 } });
  // The scorecard's verdict on the class's refusals: expected take, categories, and counterfactual R where recorded.
  assert.deepStrictEqual(by.location.scorecard, { joined: 1, unjoined: 1, expected: { take: 1 }, categories: { 'excessive abstention': 1 }, counterfactual: { n: 1, sum: 1.5 } });
  assert.deepStrictEqual(by['no-plan'].scorecard, { joined: 1, unjoined: 1, expected: { 'no-trade': 1 }, categories: { right: 1 }, counterfactual: { n: 0, sum: 0 } });
  // The scorecard's own abstention under an expected no-trade (a composable setup passed without compose_check) is
  // tallied as it says, never folded into "take".
  assert.deepStrictEqual(by['opening-print'].scorecard.expected, { 'no-trade': 1 });
  assert.deepStrictEqual(by['opening-print'].scorecard.categories, { 'excessive abstention': 1 });
  // Position-open is a blocker, never a refusal (the model held a position, it did not refuse).
  assert.deepStrictEqual([by['position-open'].blocked.legs, by['position-open'].refusedIn.legs], [1, 0]);
  // By stated reason: the no-plan cycle the model said was the trend rule moves there; the blocker keeps its class.
  const byR = Object.fromEntries(led.byReason.map(x => [x.class, x]));
  assert.deepStrictEqual([byR['trend-rule'].refusedIn.legs, byR['no-plan'].refusedIn.legs], [1, 1]);
  // A head-pass is about the leg's way's own OK record: its reaction reason counts with no side named.
  assert.strictEqual(byR['entry-reaction'].blocked.legs, 1);
  assert.strictEqual(byR['head-pass'], undefined);
});

test('leg ledger: the mean is over the known legs only (a mutation that sums unknown as 0 fails)', () => {
  const rows = [{ ...unknownR, availableR: null }, { ...unknownR, id: 'x', availableR: 4 }];
  const led = LL.buildLedger([{ capture: { legs: rows }, decisions: [], minutes: 3, half: 'probe' }]);
  assert.deepStrictEqual(led.totals.rAvailable, { n: 1, sum: 4, mean: 4, median: 4, unknown: 1, estimated: 0 });
  assert.strictEqual(led.rows[0].availableR, null);
  assert.deepStrictEqual(led.rows[0].outcome, { kind: 'missed', availableR: null });
  assert.ok(LL.ledgerLines(led).some(l => /unknown/.test(l)));
});

test('leg ledger: by half (the probe and confirm halves apart), the same aggregate', () => {
  const led = LL.buildLedger([runA, runB]);
  assert.deepStrictEqual(Object.keys(led.byHalf).sort(), ['confirm', 'probe']);
  assert.deepStrictEqual([led.byHalf.probe.totals.legs, led.byHalf.confirm.totals.legs], [3, 2]);
  assert.deepStrictEqual(led.byHalf.confirm.totals.rAvailable, { n: 1, sum: 5, mean: 5, median: 5, unknown: 1, estimated: 1 });
});

test('leg ledger: priorOnly reads only days strictly before the day (later and same-day rows poisoned change nothing)', () => {
  const C = '2026-03-04';
  const f0 = at(C, '14:30');
  const later = leg(C, 'long', '14:27', { availableR: 99, cycles: [cyc(f0, 'location:false', { by: 'compose_check', step: 'location' })], blocker: { step: 'location', code: 'location:false', by: 'compose_check', cycles: 1 } });
  const base = LL.buildLedger([runA, runB, { capture: { legs: [later] }, decisions: [dec(f0, { expected: 'take', category: 'excessive abstention', counterfactual: { simulated: true, R: 7 } })], minutes: 3, half: 'probe' }]);
  const before = LL.priorOnly(base, B);
  // Only day A's legs: day B (the same day) and day C (later) never enter.
  assert.strictEqual(before.totals.legs, 3);
  assert.deepStrictEqual(before.totals.rAvailable, { n: 3, sum: 8, mean: 2.67, median: 3, unknown: 0, estimated: 0 });
  // Poison every row on or after B: the view is identical.
  const poisoned = { ...base, rows: base.rows.map(r => (r.day >= B ? { ...r, availableR: 1e6, captured: !r.captured, blocker: { class: 'location', reason: 'location', code: 'x', bar: null, cycles: 9 }, reads: r.reads.map(x => ({ ...x, class: 'location', reason: 'location', flat: true, scorecard: { expected: 'take', category: 'poison', counterfactualR: 1e6 } })), refusals: { location: 9 }, outcome: { kind: 'missed', availableR: 1e6 } } : r)) };
  assert.deepStrictEqual(LL.priorOnly(poisoned, B), before);
  // Rows dropped on or after the day: identical too (nothing of theirs leaks).
  assert.deepStrictEqual(LL.priorOnly({ ...base, rows: base.rows.filter(r => r.day < B) }, B), before);
  // The day after B includes B.
  assert.strictEqual(LL.priorOnly(base, C).totals.legs, 5);
  assert.throws(() => LL.priorOnly(base, 'not a day'), /day/);
});

test('leg ledger: the report lines carry n beside each class and label the leg R apart from the scorecard\'s', () => {
  const lines = LL.ledgerLines(LL.buildLedger([runA, runB]));
  const text = lines.join('\n');
  assert.match(text, /5 leg\(s\)/);
  assert.match(text, /location/);
  assert.match(text, /not tradeable/i);
  assert.match(text, /scorecard/i);
  assert.match(text, /outcome/i);
});

// The round reader: a training home's champion probe docs, its scorecard decisions, the round's halves.
function home() {
  const h = tmpDir();
  const runs = tmpDir();
  fs.mkdirSync(path.join(h, 'probes', 'trend'), { recursive: true });
  fs.mkdirSync(path.join(h, 'iter-1'), { recursive: true });
  const half = { probe: { days: [A], legs: [missedLoc.id, caught.id, behind.id] }, confirm: { days: [B, '2026-03-05'], legs: [unknownR.id, headPass.id] } };
  fs.writeFileSync(path.join(h, 'iter-1', 'probe-report.json'), JSON.stringify({ trend: half }));
  const doc = (day, legs, units) => ({
    legs: legs.map((l, i) => [l.id, { day, captured: l.captured, availableR: l.availableR, unit: units[i] }]),
    sessions: [...new Set(units)].map(u => ({ unit: u, day, complete: u !== 'unfinished' })),
    capture: { runId: `fx-pc-t${day.replace(/-/g, '')}.aaaa1111.0`, legs },
  });
  // Day A: the position-open leg's window never finished (dropped, as the screens drop it).
  fs.writeFileSync(path.join(h, 'probes', 'trend', `pc-${A}-aaaa1111.json`), JSON.stringify(doc(A, [missedLoc, caught, behind], ['w1', 'w1', 'unfinished'])));
  fs.writeFileSync(path.join(h, 'probes', 'trend', `pc-${B}-bbbb2222.json`), JSON.stringify({ ...doc(B, [unknownR, headPass], ['w2', 'w2']), capture: { runId: `fx-pc-t${B.replace(/-/g, '')}.bbbb2222.0`, legs: [unknownR, headPass] } }));
  // A second champion doc of day A (another round's windows) holding the same leg: kept once, the duplicate listed.
  fs.writeFileSync(path.join(h, 'probes', 'trend', `pc-${A}-cccc3333.json`), JSON.stringify(doc(A, [missedLoc], ['w9'])));
  // An edit's probe doc (another side) and another day's decisions: never read.
  fs.writeFileSync(path.join(h, 'probes', 'trend', `pe-${A}-aaaa1111.json`), JSON.stringify(doc(A, [missedLoc], ['w1'])));
  fs.writeFileSync(path.join(h, `pc-t${A.replace(/-/g, '')}.aaaa1111.-decisions.json`), JSON.stringify(decisionsA));
  fs.writeFileSync(path.join(h, `pc-t${A.replace(/-/g, '')}.ffff0000.-decisions.json`), JSON.stringify([dec(a0 + MIN3, { expected: 'take', category: 'poison' })]));
  // The run's timeframe from its autotrader.json (day A's run only; day B's unknown).
  const runId = `fx-pc-t${A.replace(/-/g, '')}.aaaa1111.0`;
  fs.mkdirSync(path.join(runs, runId, 'replay', runId), { recursive: true });
  fs.writeFileSync(path.join(runs, runId, 'replay', runId, 'autotrader.json'), JSON.stringify({ timeframe: 3 }));
  return { h, runs };
}

test('leg ledger: readRound picks each half\'s listed legs on finished units, the champion\'s docs, the matching decisions', () => {
  const { h, runs } = home();
  const r = LL.readRound(h, { iteration: 1, runs });
  const led = LL.buildLedger(r.runs);
  assert.deepStrictEqual(led.rows.map(x => [x.id, x.half]).sort(), [[missedLoc.id, 'probe'], [caught.id, 'probe'], [unknownR.id, 'confirm'], [headPass.id, 'confirm']].sort());
  // The decisions joined are the run's own (its hash), never another run's of the same day.
  const m = led.rows.find(x => x.id === missedLoc.id);
  assert.strictEqual(m.reads[1].scorecard.category, 'excessive abstention');
  // A listed day with no probe doc, and a leg on an unfinished unit: reported, never silently dropped.
  assert.deepStrictEqual(r.missingDays, [{ half: 'confirm', day: '2026-03-05' }]);
  assert.deepStrictEqual(r.unfinished, [{ half: 'probe', id: behind.id }]);
  assert.deepStrictEqual(r.duplicates, [{ half: 'probe', id: missedLoc.id, file: `pc-${A}-cccc3333.json` }]);
  assert.strictEqual(led.rows.filter(x => x.id === missedLoc.id).length, 1);
  // Day B's run has no timeframe: its decisions unjoined; --minutes gives it.
  assert.strictEqual(r.runs.find(x => x.half === 'confirm').minutes, null);
  assert.strictEqual(LL.readRound(h, { iteration: 1, minutes: 3 }).runs.every(x => x.minutes === 3), true);
  assert.throws(() => LL.readRound(h, { iteration: 2 }), /probe-report/);
});
