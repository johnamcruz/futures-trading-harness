'use strict';

// Setup capture (scripts/lib/analysis/setup-capture.js) on synthetic run homes with known legs: a caught leg, an uncaught
// leg per reason, late refusals by kind, an entry outside any leg, the catch window's edges, two entries on one leg, a
// short leg, a day the census lacks, the setups listed and fired by outcome and prepare path, and the partition property.

const test = require('node:test');
const assert = require('node:assert');
const SC = require('../../scripts/lib/analysis/setup-capture');
const F = require('../fixtures/setup-capture-homes');
const { buildCensus } = require('../../scripts/lib/learning/leg-census');
const { tmpDir } = require('../helpers');

const CENSUS = F.census();
const LONG = F.legId(F.LONG);
const SHORT = F.legId(F.SHORT);
const quiet = is => is.map(i => ({ i }));
const read = (spec, o = {}) => SC.readHome(F.makeHome(tmpDir(), 'h', spec), { census: CENSUS, ...o });
const legOf = (h, id) => h.legs.find(l => l.id === id);
const ok = (id, i, side = 'long', reads = ['15m rejected VWAP (rth) up']) => ({ id, side, i, ok: true, reads });
const late = (record, kind) => ({ record, outcome: 'late', why: 'missed the plan\'s entry', late: { kind, side: 'long', entry: 21508, stop: 21498, target: 21528, price: 21512, movedR: 0.4, record } });

test('setup capture: a caught leg with its R, available R and delay; an uncaught one with its reason', () => {
  const h = read({ cycles: [...quiet([2, 3, 10, 11, 12, 13, 14]), { i: 4, entry: { record: 'r1', outcome: 'executed' } }], records: [ok('r1', 4)], orders: [{ orderId: 7, i: 4, record: 'r1', side: 'long' }], fills: [{ orderId: 7, i: 4, r: 2.5 }] });
  const up = legOf(h, LONG);
  assert.deepStrictEqual([up.caught, up.reason, up.entry.r, up.entry.filled], [true, null, 2.5, true]);
  assert.strictEqual(up.entry.delayMin, 9.0833, 'placed 5 s after the 09:39 close: 9 min 5 s after the leg\'s start');
  assert.strictEqual(up.availableR, 2.83, 'from the first entry bar\'s close 21508 to the leg\'s high 21536.25, on the planned 10-point stop');
  const down = legOf(h, SHORT);
  assert.deepStrictEqual([down.caught, down.reason, down.blocker.code], [false, 'no-setup-listed', 'no-plan']);
  assert.deepStrictEqual(h.entries.map(e => [e.kind, e.leg, e.caughtLeg]), [['in-trend', LONG, true]]);
  assert.strictEqual(h.legs.every(l => l.aligned === false), true, 'the fixture bars hold no 4h or 1h history: no agreement');
  assert.deepStrictEqual(h.missingDays, []);
});

test('setup capture: every uncaught reason, from the run\'s own logs', () => {
  const R = 'CYCLE RESULT: ';
  const gate = [{ tool: 'place_order', decision: 'refused', rationale: 'setup:trade_lifecycle long record r1', violations: [{ check: 'max-risk', message: 'over the limit' }] }];
  const cases = {
    'late-chased': { cycles: [{ i: 3, entry: late('r1', 'chased-entry') }], records: [ok('r1', 3)] },
    'late-missed': { cycles: [{ i: 3, entry: late('r1', 'missed-entry') }], records: [ok('r1', 3)] },
    'late-beyond-stop': { cycles: [{ i: 3, entry: late('r1', 'beyond-stop') }], records: [ok('r1', 3)] },
    'gate-refusal': { cycles: quiet([3]), records: [ok('r1', 3)], gate },
    'risk-veto': { cycles: [{ i: 3, entry: { record: 'r1', outcome: 'vetoed', why: 'VERDICT: VETO - serious against' } }], records: [ok('r1', 3)] },
    // Phase 2 approved but the runner could not read it: not the risk manager saying no.
    'verdict-unread': { cycles: [{ i: 3, entry: { record: 'r1', outcome: 'vetoed', why: '## Phase 2 verdict: MNQ long, size 6' } }], records: [ok('r1', 3)] },
    'min-contracts': { cycles: [{ i: 3, entry: { record: 'r1', outcome: 'vetoed', why: 'VERDICT: VETO - min-contracts: size 2 under the floor of 3' } }], records: [ok('r1', 3)] },
    execution: { cycles: [{ i: 3, entry: { record: 'r1', outcome: 'blocked', why: 'ABORTED Orders: none sent' } }], records: [ok('r1', 3)] },
    'passed-by-head': { cycles: quiet([3]), records: [ok('r1', 3)] },
    'compose-refused': { cycles: quiet([3]), records: [{ ...ok('r1', 3), ok: false }] },
    // A position held through the catch window: the leg's own side (already riding the move), the other side, or none seen.
    'position-open-own-side': { cycles: [{ i: 3, action: 'manage', result: `${R}managed - a long open`, positions: ['long'] }] },
    'position-open-opposite': { cycles: [{ i: 3, result: `${R}managed - a short open`, positions: ['short'] }] },
    'position-open-unknown': { cycles: [{ i: 3, result: `${R}managed - a long open` }] },
    'account-blocked': { cycles: [{ i: 3, blocked: true }] },
    'account-blocked ': { cycles: [{ i: 3, blocked: true, result: `${R}no-trade - entries not allowed now (news blackout)` }] },
    // An entry block that only says a position is open is the position's, not the attempt's.
    'no-setup-listed  ': { cycles: [{ i: 3, blocked: 'a position is open on the account (MNQ); manage it first' }] },
    rule: { cycles: [{ i: 3, result: `${R}no-trade - entries not allowed now (news blackout)` }] },
    'cycle-overran': { cycles: quiet([2, 5]), skipped: [3, 4] },
    'cycle-overran ': { cycles: [{ i: 3, overran: true }] },
    'setup-passed': { cycles: [{ i: 3, listed: ['15m rejected VWAP (rth) up'] }] },
    'setup-passed ': { cycles: [{ i: 3, fired: [{ name: 'momentum_continuation', direction: 'long' }] }] },
    'no-setup-listed': { cycles: [{ i: 3, listed: ['15m rejected VWAP (rth) down'] }] },
    'no-cycle': { cycles: [] },
  };
  for (const [want, spec] of Object.entries(cases)) {
    const up = legOf(read(spec), LONG);
    assert.strictEqual(up.caught, false, want);
    assert.strictEqual(up.reason, want.trim(), `${want}: ${JSON.stringify(up.blocker)}`);
    assert.ok(SC.REASONS.includes(up.reason));
  }
  const lk = legOf(read(cases['late-chased']), LONG);
  assert.deepStrictEqual([lk.lateKind, lk.blocker.code], ['chased-entry', 'late-entry']);
  // A late refusal the gate logged (no runner record of it in the cycle): its kind from the late report's rows.
  const viaGate = read({ cycles: quiet([3]), records: [ok('r1', 3)], gate: [{ tool: 'place_order', source: 'gateway', decision: 'refused', ts: F.plus(F.closeT(3), 30), contractId: 'MNQ', rationale: 'record r1', violations: [{ check: 'late-entry', message: 'late', late: { kind: 'missed-entry', side: 'long', entry: 21508, stop: 21498, target: 21528, price: 21500, record: 'r1' } }] }] });
  assert.deepStrictEqual([legOf(viaGate, LONG).reason, legOf(viaGate, LONG).lateKind], ['late-missed', 'missed-entry']);
  assert.deepStrictEqual(viaGate.late.byKind, { 'missed-entry': 1 });
});

test('setup capture: a leg the run never stepped is not-run, out of scope (never a miss)', () => {
  const h = read({ times: [10, 11, 12, 13, 14], cycles: quiet([10, 11]) });
  assert.deepStrictEqual(h.legs.map(l => l.id), [SHORT]);
  assert.deepStrictEqual(h.notRun.map(l => [l.id, l.reason]), [[LONG, 'not-run']]);
  assert.strictEqual(h.decisions.times, 5);
  // One decision time in the catch window puts it in scope; one passed while a cycle ran too.
  assert.ok(read({ times: [5] }).legs.some(l => l.id === LONG));
  assert.ok(!read({ times: [6] }).legs.some(l => l.id === LONG), 'the 09:45 close is past the catch window (its first half: to 09:43:30)');
  // Its only catch bar's decision time skipped (the 09:30 cycle still running): in scope, and missed for it.
  const only = read({ times: [1, 5], skipped: [5], cycles: quiet([1]) });
  assert.deepStrictEqual(only.legs.filter(l => l.id === LONG).map(l => [l.skippedInSpan, l.reason]), [[true, 'cycle-overran']]);
  const sk = read({ times: [2, 5], skipped: [5], cycles: quiet([2]) });
  assert.ok(sk.legs.some(l => l.id === LONG && l.skippedInSpan));
  assert.deepStrictEqual([sk.decisions.ran, sk.decisions.skipped], [1, 1]);
});

test('setup capture: the catch window\'s edges: composed on its last bar caught; one bar later only in the leg', () => {
  const at = (i, wall = null) => read({ cycles: [...quiet([2, 3, 4, 5]), { i, entry: { record: 'r1', outcome: 'executed' } }], records: [ok('r1', i)], orders: [{ orderId: 7, i, record: 'r1', side: 'long', ...(wall ? { at: wall } : {}) }], fills: [{ orderId: 7, i, r: 1 }] });
  const last = at(5, F.plus(F.closeT(5), 100));
  assert.strictEqual(legOf(last, LONG).caught, true, 'composed on the 09:42 close, the window\'s last (to 09:43:30), placed after it by wall time: the record\'s bar counts');
  const after = at(6);
  assert.deepStrictEqual([legOf(after, LONG).caught, legOf(after, LONG).inLegEntries, legOf(after, LONG).reason], [false, 1, 'no-setup-listed']);
  assert.deepStrictEqual(after.entries.map(e => [e.kind, e.caughtLeg]), [['in-trend', false]]);
  // An order placed before the leg's start that filled in its window caught it (the fill, not the order).
  const early = read({ cycles: quiet([3]), records: [ok('r1', 1)], orders: [{ orderId: 7, i: 1, record: 'r1', side: 'long', at: F.plus(F.barT(2), -20) }], fills: [{ orderId: 7, i: 2, r: 1 }] });
  assert.strictEqual(legOf(early, LONG).caught, true);
});

test('setup capture: two entries on one leg: caught once, both in the leg; an entry outside any leg is in none', () => {
  const h = read({
    cycles: quiet([2, 3, 4, 5, 6, 24]), records: [ok('r1', 3), ok('r2', 5), { ...ok('r3', 24), side: 'short', reads: ['15m rejected VWAP (rth) down'] }],
    orders: [{ orderId: 7, i: 3, record: 'r1', side: 'long' }, { orderId: 8, i: 5, record: 'r2', side: 'long' }, { orderId: 9, i: 24, record: 'r3', side: 'short' }],
    fills: [{ orderId: 7, i: 3, r: 1 }, { orderId: 8, i: 5, r: -1 }, { orderId: 9, i: 24, r: -1 }],
  });
  const up = legOf(h, LONG);
  assert.deepStrictEqual([up.caught, up.inLegEntries, up.entry.r], [true, 2, 1]);
  assert.deepStrictEqual(h.entries.map(e => [e.kind, e.caughtLeg]), [['in-trend', true], ['in-trend', false], ['none', false]]);
  const s = SC.armSummary({ homes: [h] });
  assert.deepStrictEqual(s.totals.entries, { filled: 3, onCaughtLeg: 1, inLeg: 2, counter: 0, none: 1 });
});

test('setup capture: a short leg (one catch bar) and a day the census lacks', () => {
  const two = { day: F.DAY, side: 'short', start: F.barT(22), end: F.barT(23), points: 10 };
  const census = buildCensus([], { legs: [two] }, { use: 'practice', seed: 1, now: new Date(0) });
  assert.deepStrictEqual(SC.readHome(F.makeHome(tmpDir(), 'h', { times: [22], cycles: quiet([22]) }), { census }).legs.map(l => l.id), [F.legId(two)]);
  assert.deepStrictEqual(SC.readHome(F.makeHome(tmpDir(), 'h', { times: [21, 23], cycles: quiet([21, 23]) }), { census }).notRun.map(l => l.id), [F.legId(two)]);
  const other = buildCensus([], { legs: [{ ...F.LONG, day: '2021-06-15', start: '2021-06-15T13:30:00.000Z', end: '2021-06-15T13:54:00.000Z' }] }, { use: 'practice', seed: 1, now: new Date(0) });
  const h = SC.readHome(F.makeHome(tmpDir(), 'h', { cycles: quiet([3]) }), { census: other });
  assert.deepStrictEqual([h.legs, h.notRun, h.missingDays], [[], [], [F.DAY]]);
  assert.deepStrictEqual(SC.armSummary({ homes: [h] }).missingDays, [F.DAY]);
  assert.deepStrictEqual(SC.armProblems({ homes: [h] }), [{ kind: 'missing-census-day', detail: `h: ${F.DAY}` }]);
});

test('setup capture: the setups listed and fired, by kind and outcome, and by prepare path on an "on" run', () => {
  const h = read({
    cycles: [
      { i: 3, listed: ['15m rejected VWAP (rth) up', '15m broke opening range high up'], fired: [{ name: 'momentum_continuation', direction: 'long' }], entry: late('m1', 'chased-entry'), skips: [{ setup: '15m broke opening range high up', reason: null }], on: { path: 'confirm', confirm: { fellBack: false } } },
      { i: 4, listed: ['1h cisd up', '15m compression break up'], entry: { record: 'c1', outcome: 'executed' }, on: { path: 'void', reason: 'stale' } },
      { i: 11, listed: ['15m rejected VWAP rth down', '15m broke IB low down'], fired: [{ name: 'momentum_continuation', direction: 'short' }], skips: [{ setup: '15m broke ib low down', reason: 'no room to the target' }] },
      { i: 12, listed: ['15m rejected VWAP rth down'], entry: { record: 'e1', outcome: 'vetoed', why: 'VERDICT: VETO - serious against' } },
      { i: 13, listed: ['15m rejected VWAP rth down'] },
    ],
    // x1: the other side's record with the breakout's read: never the long setup's.
    records: [{ ...ok('m1', 3), reads: ['momentum_continuation fired up'] }, { ...ok('v1', 3), ok: false }, { id: 'x1', side: 'short', i: 3, ok: false, reads: ['15m broke opening range high up'] }, ok('c1', 4, 'long', ['1h cisd up']), { ...ok('d1', 11), side: 'short', reads: ['15m rejected VWAP (rth) down'] },
      { ...ok('e1', 12), side: 'short', reads: ['15m rejected VWAP (rth) down'] }, { ...ok('o1', 13), side: 'short', reads: ['15m rejected VWAP (rth) down'] }],
    gate: [{ tool: 'place_order', decision: 'refused', rationale: 'record d1', violations: [{ check: 'max-risk' }] }],
  });
  const got = h.setups.map(s => [s.bar.slice(11, 16), s.kind, s.side, s.source, s.outcome, s.path]);
  assert.deepStrictEqual(got, [
    ['13:36', 'rejection', 'long', 'listed', 'compose-refused', 'confirm'],
    ['13:36', 'breakout', 'long', 'listed', 'passed-no-reason', 'confirm'],
    ['13:36', 'momentum_continuation', 'long', 'fired', 'late-chased', 'confirm'],
    ['13:39', 'cisd', 'long', 'listed', 'taken', 'fallback:void:stale'],
    // Listed, never composed, and no row for it in the cycle's setup skips: nothing recorded either way.
    ['13:39', 'compression', 'long', 'listed', 'unrecorded', 'fallback:void:stale'],
    ['14:00', 'rejection', 'short', 'listed', 'gate-refusal', null],
    ['14:00', 'breakout', 'short', 'listed', 'passed', null],
    // A fired scan setup never composed: the setup skips list listed setups only, so none says why.
    ['14:00', 'momentum_continuation', 'short', 'fired', 'fired-not-composed', null],
    ['14:03', 'rejection', 'short', 'listed', 'risk-veto', null],
    ['14:06', 'rejection', 'short', 'listed', 'passed-by-head', null],
  ]);
  assert.ok(h.setups.every(s => SC.SETUP_OUTCOMES.includes(s.outcome)));
  const s = SC.armSummary({ homes: [h] });
  assert.deepStrictEqual(s.totals.setups.byKind.momentum_continuation, { 'fired-not-composed': 1, 'late-chased': 1 });
  assert.deepStrictEqual(s.totals.setups.byPath, { confirm: { 'compose-refused': 1, 'late-chased': 1, 'passed-no-reason': 1 }, 'fallback:void:stale': { taken: 1, unrecorded: 1 } });
  assert.deepStrictEqual(s.totals.entryPaths, { 'fallback:void:stale': 1 });
  // An uncaught leg on an "on" run carries the path of the cycle that blocked it (the latest at the furthest stage: c1's
  // entry, placed and never filled).
  assert.deepStrictEqual([legOf(h, LONG).reason, legOf(h, LONG).path], ['execution', 'fallback:void:stale']);
});

test('setup capture: property: caught + uncaught + not-run = the day\'s census legs; the reasons partition the uncaught', () => {
  let seed = 11;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pick = xs => xs[Math.floor(rand() * xs.length)];
  for (let k = 0; k < 24; k += 1) {
    const span = Array.from({ length: 27 }, (_, i) => i + 2);
    const times = span.filter(() => rand() < 0.7);
    const skipped = times.filter(() => rand() < 0.1);
    const cycles = times.filter(i => !skipped.includes(i) && rand() < 0.8).map(i => ({ i, result: pick(['CYCLE RESULT: no-trade - x', 'CYCLE RESULT: managed - open', 'CYCLE RESULT: no-trade - news blackout']), listed: rand() < 0.3 ? [pick(['15m rejected VWAP (rth) up', '15m broke IB high down'])] : [], overran: rand() < 0.05, blocked: rand() < 0.05 }));
    const records = cycles.filter(() => rand() < 0.3).map((c, j) => ({ id: `r${j}`, side: pick(['long', 'short']), i: c.i, ok: rand() < 0.5, reads: ['15m rejected VWAP (rth) up'] }));
    for (const r of records) if (r.ok && rand() < 0.5) cycles.find(c => c.i === r.i).entry = rand() < 0.5 ? { record: r.id, outcome: 'executed' } : late(r.id, pick(['chased-entry', 'missed-entry']));
    const orders = records.filter(r => cycles.some(c => c.i === r.i && c.entry && c.entry.record === r.id && c.entry.outcome === 'executed')).map((r, j) => ({ orderId: 100 + j, i: r.i, record: r.id, side: r.side }));
    const fills = orders.filter(() => rand() < 0.8).map(o => ({ orderId: o.orderId, i: o.i, r: pick([-1, 0.5, 2]) }));
    const h = read({ times, skipped, cycles, records, orders, fills });
    assert.strictEqual(h.legs.length + h.notRun.length, CENSUS.order.length, `case ${k}`);
    const caught = h.legs.filter(l => l.caught);
    const un = h.legs.filter(l => !l.caught);
    assert.ok(caught.every(l => l.reason === null && l.entry && l.entry.filled));
    assert.ok(un.every(l => SC.REASONS.includes(l.reason)), `case ${k}: ${un.map(l => l.reason)}`);
    const t = SC.legTotals(h.legs);
    assert.strictEqual(t.caught + Object.values(t.reasons).reduce((a, b) => a + b, 0), t.legs);
    assert.ok(h.setups.every(s => SC.SETUP_OUTCOMES.includes(s.outcome)));
  }
});

test('setup capture: a setup listed or fired on the other side is no setup the leg\'s way', () => {
  const down = spec => legOf(read(spec), SHORT);
  assert.strictEqual(down({ cycles: [{ i: 11, listed: ['15m rejected VWAP (rth) up'], fired: [{ name: 'momentum_continuation', direction: 'long' }] }] }).reason, 'no-setup-listed');
  assert.strictEqual(down({ cycles: [{ i: 11, listed: ['15m rejected VWAP (rth) down'] }] }).reason, 'setup-passed');
  assert.strictEqual(down({ cycles: [{ i: 11, fired: [{ name: 'momentum_continuation', direction: 'short' }] }] }).reason, 'setup-passed');
});

test('setup capture: a leg whose catch steps served no new bar is not-served: no-cycle, out of the default rate', () => {
  const h = read({ stale: [2, 3, 4, 5], cycles: quiet([10, 11]) });
  const up = legOf(h, LONG);
  assert.deepStrictEqual([up.reason, up.notServed], ['no-cycle', true]);
  assert.strictEqual(legOf(h, SHORT).notServed, false);
  const t = SC.legTotals(h.legs);
  assert.deepStrictEqual([t.legs, t.notServed, t.caught, t.withNotServed.legs], [1, 1, 0, 2]);
  assert.deepStrictEqual(t.reasons, { 'no-setup-listed': 1 }, 'the not-served leg is no miss of the default count');
  // One step of the window served its bar: in scope as before; a manage-only step (no cycle, a new bar) is served too.
  assert.strictEqual(legOf(read({ stale: [2, 3], cycles: quiet([10]) }), LONG).notServed, false);
  assert.strictEqual(legOf(read({ stale: [2, 3, 4, 5], cycles: quiet([3]) }), LONG).notServed, false, 'a step that ran a cycle served its bar');
  assert.strictEqual(legOf(read({ cycles: [] }), LONG).notServed, false);
});

test('setup capture: an overrun is counted once: the overran cycle and the decision time it swallowed are one lost bar', () => {
  const h = read({ cycles: [{ i: 3, overran: true }, ...quiet([5, 6])], skipped: [4] });
  assert.deepStrictEqual([h.decisions.skipped, h.decisions.overran, h.decisions.lost], [1, 1, 1]);
  const s = SC.armSummary({ homes: [h] });
  assert.strictEqual(s.totals.decisions.overranShare, Math.round((1 / h.decisions.times) * 10000) / 10000);
  // An overrun with no time skipped (the next bar outside the run's steps) still loses its next bar.
  const o = read({ cycles: [{ i: 3, overran: true }] });
  assert.deepStrictEqual([o.decisions.skipped, o.decisions.lost], [0, 1]);
  assert.strictEqual(SC.armSummary({ homes: [o] }).totals.decisions.overranShare, Math.round((1 / o.decisions.times) * 10000) / 10000);
});

test('setup capture: R share of the caught legs; an arm\'s problems: errors, skipped folders, missing days, no cycle logs, duplicate days', () => {
  const t = SC.legTotals([{ id: 'a', day: F.DAY, side: 'long', caught: true, entry: { at: 'x', r: 1 }, availableR: 2, reason: null }, { id: 'b', day: F.DAY, side: 'long', caught: false, availableR: 2, reason: 'rule' }]);
  assert.deepStrictEqual([t.rate, t.rCaught, t.rAvailable, t.share], [0.5, 1, 4, 0.25]);
  const root = tmpDir();
  F.makeHome(root, 'day-a', { cycles: quiet([3]) });
  F.makeHome(root, 'day-b', {}); // no cycle logs at all
  require('fs').mkdirSync(require('path').join(root, 'notes'));
  const arm = SC.readArm([root], { census: CENSUS });
  assert.deepStrictEqual(arm.skipped, ['notes']);
  const p = SC.armProblems(arm);
  assert.deepStrictEqual(p.map(x => x.kind), ['duplicate-day', 'no-cycle-logs', 'not-a-home']);
  assert.match(p[0].detail, /2021-06-14: day-a, day-b/);
  assert.deepStrictEqual(SC.armSummary(arm).problems, p);
});

test('setup capture: the same home given twice (another spelling) is read once', () => {
  const root = tmpDir();
  const h = F.makeHome(root, 'day-a', { cycles: quiet([3]) });
  assert.strictEqual(SC.homesOf([h, `${h}${require('path').sep}`, root]).length, 1);
});

test('setup capture: one entry that caught two legs (adjacent, the same side) banks its R once', () => {
  const at = '2021-06-14T14:03:30.000Z';
  const two = [
    { id: 'a', day: F.DAY, side: 'long', caught: true, entry: { at, r: 1 }, availableR: 2, reason: null },
    { id: 'b', day: F.DAY, side: 'long', caught: true, entry: { at, r: 1 }, availableR: 3, reason: null },
    { id: 'c', day: F.DAY, side: 'long', caught: true, entry: { at: '2021-06-14T15:00:00.000Z', r: -1 }, availableR: 1, reason: null },
  ];
  assert.deepStrictEqual(SC.legTotals(two), { legs: 3, caught: 3, rate: 1, rCaught: 0, rAvailable: 6, share: 0, reasons: {}, notServed: 0, withNotServed: { legs: 3, caught: 3, rate: 1 } });
});

test('setup capture: homes from run homes or folders of them, sorted; a folder of neither refuses; several runs in one home refuse', () => {
  const root = tmpDir();
  F.makeHome(root, 'b-day', {});
  F.makeHome(root, 'a-day', {});
  assert.deepStrictEqual(SC.homesOf([root]).map(p => require('path').basename(p)), ['a-day', 'b-day']);
  assert.throws(() => SC.homesOf([tmpDir()]), /not a run home/);
  const two = F.makeHome(tmpDir(), 'h', {});
  require('fs').mkdirSync(require('path').join(two, 'replay', 'other'));
  require('fs').writeFileSync(require('path').join(two, 'replay', 'other', 'manifest.json'), '{}');
  assert.throws(() => SC.readHome(two, { census: CENSUS }), /2 replay runs in one home/);
  // alignedOf overrides the served-bars read (the summary's aligned scope).
  const h = SC.readHome(F.makeHome(tmpDir(), 'h', { cycles: quiet([3]) }), { census: CENSUS, alignedOf: g => g.side === 'long' });
  assert.deepStrictEqual(h.legs.map(l => [l.id, l.aligned]), [[LONG, true], [SHORT, false]]);
  assert.strictEqual(SC.armSummary({ homes: [h] }).totals.aligned.legs, 1);
});
