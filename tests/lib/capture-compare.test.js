'use strict';

// Two arms' setup capture compared (scripts/lib/analysis/capture-compare.js): legs paired by census id on the legs both
// arms covered, each side's caught rate with its Wilson interval and the difference's (Newcombe), the discordant legs,
// late refusals by kind on the paired days, and the accept criteria (a file passed in: no threshold lives in the repo).

const test = require('node:test');
const assert = require('node:assert');
const CC = require('../../scripts/lib/analysis/capture-compare');
const { wilson } = require('../../scripts/lib/prop/stats');

const leg = (id, o = {}) => ({ id, day: id.slice(0, 10), side: id.split('|')[1], aligned: true, caught: false, entry: null, availableR: 2, reason: 'no-setup-listed', ...o });
const caught = (id, r, o = {}) => leg(id, { caught: true, entry: { r, at: `${id.slice(0, 10)}T14:00:00.000Z` }, reason: null, ...o });
const home = (name, days, legs, o = {}) => ({ name, days, legs, late: { rows: [] }, decisions: { times: 10, skipped: 0, overran: 0, cycles: 10 }, entryCycles: [], ...o });
const L = d => `${d}|long|${d}T13:30:00.000Z`;
const S = d => `${d}|short|${d}T14:30:00.000Z`;

/** Two arms over the same three days: a catches 1 of 6 legs, b 3 of 6; one leg caught by a only. */
function arms() {
  const a = { homes: [
    home('a1', ['2021-06-14'], [caught(L('2021-06-14'), 1.5), leg(S('2021-06-14'), { reason: 'late-chased' })]),
    home('a2', ['2021-06-15'], [leg(L('2021-06-15'), { reason: 'late-chased' }), leg(S('2021-06-15'))], { late: { rows: [{ at: '2021-06-15T13:40:00Z', kind: 'chased-entry' }, { at: '2021-06-15T13:50:00Z', kind: 'chased-entry' }] } }),
    home('a3', ['2021-06-16'], [leg(L('2021-06-16')), leg(S('2021-06-16'), { aligned: false })]),
  ] };
  const b = { homes: [
    home('b1', ['2021-06-14'], [leg(L('2021-06-14'), { reason: 'cycle-overran' }), caught(S('2021-06-14'), 2)]),
    home('b2', ['2021-06-15'], [caught(L('2021-06-15'), 3), caught(S('2021-06-15'), -1)], { late: { rows: [{ at: '2021-06-15T13:40:00Z', kind: 'chased-entry' }] }, entryCycles: [{ path: 'confirm' }, { path: 'confirm' }, { path: 'fallback:void:stale' }] }),
    home('b3', ['2021-06-16'], [leg(L('2021-06-16')), leg(S('2021-06-16'), { aligned: false })], { decisions: { times: 10, skipped: 2, overran: 1, cycles: 8 } }),
  ] };
  return { a, b };
}

test('capture compare: legs pair by census id; each side\'s rate with its Wilson interval; discordant legs with each side\'s R', () => {
  const { a, b } = arms();
  const c = CC.compare(a, b, { level: 0.9 });
  const all = c.legs.all;
  assert.deepStrictEqual([all.pairs, all.both, all.aOnly, all.bOnly, all.neither], [6, 0, 1, 3, 2]);
  assert.deepStrictEqual(all.a.wilson, wilson(1, 6, 0.9));
  assert.deepStrictEqual(all.b.wilson, wilson(3, 6, 0.9));
  assert.strictEqual(all.diff, 0.3333);
  // Newcombe's hybrid score interval on the difference (b - a): from each side's Wilson bounds.
  const wa = wilson(1, 6, 0.9);
  const wb = wilson(3, 6, 0.9);
  const lo = (3 / 6 - 1 / 6) - Math.sqrt((3 / 6 - wb.lo) ** 2 + (wa.hi - 1 / 6) ** 2);
  assert.ok(Math.abs(all.lo - lo) < 1e-3, `${all.lo} vs ${lo}`);
  assert.ok(all.lo < all.diff && all.diff < all.hi);
  // The other way round (b's rate 1/6: its Wilson interval is not symmetric), each bound from the right side's.
  const rev = CC.compare(b, a, { level: 0.9 }).legs.all;
  const revLo = (1 / 6 - 3 / 6) - Math.sqrt((1 / 6 - wa.lo) ** 2 + (wb.hi - 3 / 6) ** 2);
  const revHi = (1 / 6 - 3 / 6) + Math.sqrt((wa.hi - 1 / 6) ** 2 + (3 / 6 - wb.lo) ** 2);
  assert.ok(Math.abs(rev.lo - revLo) < 1e-3 && Math.abs(rev.hi - revHi) < 1e-3, `${rev.lo} ${rev.hi} vs ${revLo} ${revHi}`);
  // The aligned legs alone: the two unaligned ones (one each side's) leave.
  assert.strictEqual(c.legs.aligned.pairs, 5);
  // The discordant legs: each side's R (a's caught leg: 1.5; b's three: 2, 3, -1), net = b's - a's.
  assert.deepStrictEqual(c.discordant.map(d => [d.id, d.caughtBy, d.a.r, d.b.r]), [
    [L('2021-06-14'), 'a', 1.5, null], [S('2021-06-14'), 'b', null, 2], [L('2021-06-15'), 'b', null, 3], [S('2021-06-15'), 'b', null, -1],
  ]);
  assert.strictEqual(c.netR, 2.5);
  // Caught by a, uncaught by b, by b's reason.
  assert.deepStrictEqual(c.caughtAUncaughtB, { 'cycle-overran': 1 });
  assert.deepStrictEqual(c.late, { a: { 'chased-entry': 2 }, b: { 'chased-entry': 1 } });
  assert.deepStrictEqual(c.entryPaths.b, { confirm: 2, 'fallback:void:stale': 1 });
  assert.deepStrictEqual(c.overran.b, { times: 30, skipped: 2, overran: 1, share: 0.1 });
});

test('capture compare: a leg only one arm covered is unpaired (never a miss); a day only one arm ran is not a paired day', () => {
  const { a, b } = arms();
  b.homes[2].legs.pop();
  a.homes.push(home('a4', ['2021-06-17'], [caught(L('2021-06-17'), 1)], { late: { rows: [{ at: '2021-06-17T13:40:00Z', kind: 'missed-entry' }] } }));
  const c = CC.compare(a, b, { level: 0.9 });
  assert.strictEqual(c.legs.all.pairs, 5);
  assert.deepStrictEqual(c.legs.unpaired, { a: 2, b: 0 });
  assert.deepStrictEqual(c.days, { paired: ['2021-06-14', '2021-06-15', '2021-06-16'], aOnly: ['2021-06-17'], bOnly: [] });
  assert.deepStrictEqual(c.late.a, { 'chased-entry': 2 }, 'a late refusal on an unpaired day is left out');
});

test('capture compare: property: caught + uncaught = legs, the reasons partition the uncaught, the paired counts add up', () => {
  const R = require('../../scripts/lib/analysis/setup-capture').REASONS;
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < 200; k += 1) {
    const n = 1 + Math.floor(rand() * 12);
    const mk = who => ({ homes: [home(who, ['2021-06-14', '2021-06-15'], Array.from({ length: n }, (_, i) => {
      const id = `2021-06-1${4 + (i % 2)}|${i % 3 ? 'long' : 'short'}|2021-06-1${4 + (i % 2)}T13:${10 + i}:00.000Z`;
      return rand() < 0.4 ? caught(id, Math.round((rand() * 6 - 1) * 4) / 4) : leg(id, { reason: R[Math.floor(rand() * R.length)], aligned: rand() < 0.5 });
    }).filter(() => rand() < 0.9))] });
    const a = mk('a');
    const b = mk('b');
    const c = CC.compare(a, b, { level: 0.95 });
    const p = c.legs.all;
    assert.strictEqual(p.both + p.aOnly + p.bOnly + p.neither, p.pairs);
    assert.strictEqual(p.a.caught, p.both + p.aOnly);
    assert.strictEqual(p.b.caught, p.both + p.bOnly);
    assert.strictEqual(p.pairs + c.legs.unpaired.a, a.homes[0].legs.length);
    assert.strictEqual(p.pairs + c.legs.unpaired.b, b.homes[0].legs.length);
    assert.strictEqual(c.discordant.length, p.aOnly + p.bOnly);
    for (const side of ['a', 'b']) {
      const reasons = Object.values(c.reasons[side]).reduce((x, y) => x + y, 0);
      assert.strictEqual(reasons + p[side].caught, p.pairs, 'every paired uncaught leg has one reason');
      for (const r of Object.keys(c.reasons[side])) assert.ok(R.includes(r), r);
    }
    assert.strictEqual(Object.values(c.caughtAUncaughtB).reduce((x, y) => x + y, 0), p.aOnly);
  }
});

const crit = list => ({ level: 0.9, criteria: list });

test('capture compare: accept: one line per criterion, sorted by id, with the measured value, the threshold and the verdict', () => {
  const { a, b } = arms();
  const c = CC.compare(a, b, { level: 0.9 });
  const doc = crit([
    { id: 'z-net', kind: 'discordant-net-r', min: 0, minDiscordant: 2 },
    { id: 'a-rate', kind: 'caught-rate', legs: 'all', margin: 0.5, minLegs: 4 },
    { id: 'm-late', kind: 'late-refusals', lateKind: 'chased-entry', maxRatio: 0.5, minA: 1 }, // b 1 = 0.5 x a's 2: at the bound passes
    { id: 'n-overran', kind: 'overran-share', arm: 'b', max: 0.2, minDecisions: 5 },
    { id: 'p-path', kind: 'path-share', arm: 'b', path: 'confirm', min: 0.5, minEntries: 2 },
    { id: 'q-fallback', kind: 'path-share', arm: 'b', path: 'fallback', min: 0.3, minEntries: 2 },
    { id: 'r-reason', kind: 'uncaught-reason-share', arm: 'a', legs: 'all', reason: 'late-chased', max: 0.5, minLegs: 4 },
    { id: 's-ab', kind: 'caught-a-uncaught-b', reason: 'cycle-overran', max: 1 },
  ]);
  const r = CC.evaluate(c, doc);
  assert.strictEqual(r.verdict, 'PASS', r.lines.join('\n'));
  assert.deepStrictEqual(r.results.map(x => x.id), ['a-rate', 'm-late', 'n-overran', 'p-path', 'q-fallback', 'r-reason', 's-ab', 'z-net']);
  assert.deepStrictEqual(r.results.map(x => x.verdict), Array(8).fill('PASS'));
  const line = r.lines.find(l => l.startsWith('n-overran'));
  assert.match(line, /measured 0\.1\b.*threshold <= 0\.2.*PASS/);
  assert.deepStrictEqual(r.results.find(x => x.id === 'r-reason').measured, 0.4, '2 of a\'s 5 uncaught legs were refused late as chased');
  assert.strictEqual(r.results.find(x => x.id === 'q-fallback').measured, 0.3333);
  assert.strictEqual(CC.EXIT.indexOf(r.verdict), 0);
});

test('capture compare: accept: each kind fails past its threshold; a FAIL outranks insufficient data', () => {
  const { a, b } = arms();
  const c = CC.compare(a, b, { level: 0.9 });
  const one = x => CC.evaluate(c, crit([{ id: 'x', ...x }])).results[0];
  // b worse than a by more than the margin: a vs b swapped.
  const swapped = CC.compare(b, a, { level: 0.9 });
  assert.strictEqual(CC.evaluate(swapped, crit([{ id: 'x', kind: 'caught-rate', legs: 'all', margin: 0.05, minLegs: 4 }])).results[0].verdict, 'FAIL');
  assert.strictEqual(one({ kind: 'late-refusals', lateKind: 'chased-entry', maxRatio: 0.25, minA: 1 }).verdict, 'FAIL');
  assert.strictEqual(one({ kind: 'overran-share', arm: 'b', max: 0.05, minDecisions: 5 }).verdict, 'FAIL');
  assert.strictEqual(one({ kind: 'path-share', arm: 'b', path: 'confirm', min: 0.9, minEntries: 2 }).verdict, 'FAIL');
  assert.strictEqual(one({ kind: 'uncaught-reason-share', arm: 'a', legs: 'all', reason: 'late-chased', max: 0.3, minLegs: 4 }).verdict, 'FAIL');
  assert.strictEqual(one({ kind: 'discordant-net-r', min: 3, minDiscordant: 2 }).verdict, 'FAIL');
  assert.strictEqual(one({ kind: 'caught-a-uncaught-b', reason: 'cycle-overran', max: 0 }).verdict, 'FAIL');
  assert.strictEqual(one({ kind: 'caught-a-uncaught-b', reason: 'any', max: 0 }).verdict, 'FAIL');
  const mixed = CC.evaluate(c, crit([{ id: 'f', kind: 'overran-share', arm: 'b', max: 0.05, minDecisions: 5 }, { id: 'i', kind: 'discordant-net-r', min: 0, minDiscordant: 50 }]));
  assert.deepStrictEqual([mixed.verdict, CC.EXIT.indexOf(mixed.verdict)], ['FAIL', 1]);
});

test('capture compare: accept: too few legs, entries, decisions or refusals to judge is insufficient data, saying which', () => {
  const { a, b } = arms();
  const c = CC.compare(a, b, { level: 0.9 });
  const one = x => CC.evaluate(c, crit([{ id: 'x', ...x }])).results[0];
  for (const x of [
    { kind: 'caught-rate', legs: 'all', margin: 0.1, minLegs: 7 },
    { kind: 'late-refusals', lateKind: 'missed-entry', maxRatio: 1, minA: 1 },
    { kind: 'overran-share', arm: 'b', max: 0.2, minDecisions: 31 },
    { kind: 'path-share', arm: 'a', path: 'confirm', min: 0.5, minEntries: 1 },
    { kind: 'uncaught-reason-share', arm: 'a', legs: 'aligned', reason: 'late-chased', max: 0.5, minLegs: 6 },
    { kind: 'discordant-net-r', min: 0, minDiscordant: 5 },
  ]) {
    const r = one(x);
    assert.strictEqual(r.verdict, 'INSUFFICIENT', `${x.kind}: ${r.why}`);
    assert.match(r.why, /\d+ .*(?:under|below) .*\d+/, r.why);
  }
  const r = CC.evaluate(c, crit([{ id: 'x', kind: 'discordant-net-r', min: 0, minDiscordant: 5 }]));
  assert.deepStrictEqual([r.verdict, CC.EXIT.indexOf(r.verdict)], ['INSUFFICIENT', 2]);
});

test('capture compare: a criteria file states every threshold: a missing one, an unknown kind or level refuses the file', () => {
  const { a, b } = arms();
  const c = CC.compare(a, b, { level: 0.9 });
  assert.throws(() => CC.evaluate(c, crit([{ id: 'x', kind: 'caught-rate', legs: 'all', minLegs: 4 }])), /x: caught-rate needs margin/);
  assert.throws(() => CC.evaluate(c, crit([{ id: 'x', kind: 'nope' }])), /x: kind nope/);
  assert.throws(() => CC.evaluate(c, crit([{ kind: 'overran-share', arm: 'b', max: 0.1, minDecisions: 1 }])), /an id/);
  assert.throws(() => CC.evaluate(c, crit([{ id: 'x', kind: 'overran-share', arm: 'c', max: 0.1, minDecisions: 1 }])), /arm a or b/);
  assert.throws(() => CC.evaluate(c, { level: 0.7, criteria: [] }), /level/);
  assert.throws(() => CC.evaluate(c, { level: 0.9, criteria: [] }), /no criteria/);
  assert.throws(() => CC.evaluate(c, crit([{ id: 'x', kind: 'discordant-net-r', min: 0, minDiscordant: 1 }, { id: 'x', kind: 'discordant-net-r', min: 0, minDiscordant: 1 }])), /x twice/);
  assert.throws(() => CC.evaluate(c, crit([{ id: 'x', kind: 'discordant-net-r', min: '0', minDiscordant: 1 }])), /min: a number/);
});

test('capture compare: one entry that caught two legs banks its R once on each side\'s R caught', () => {
  const at = '2021-06-14T14:03:30.000Z';
  const x = id => caught(id, 2, { entry: { at, r: 2 } });
  // Two adjacent long legs (the zigzag split one move), one fill in both.
  const L2 = '2021-06-14|long|2021-06-14T13:45:00.000Z';
  const a = { homes: [home('a', ['2021-06-14'], [x(L('2021-06-14')), x(L2)])] };
  const b = { homes: [home('b', ['2021-06-14'], [x(L('2021-06-14')), leg(L2)])] };
  assert.deepStrictEqual(CC.compare(a, b, { level: 0.9 }).legs.all.rCaught, { a: 2, b: 2 });
  // Two discordant legs a caught with that one entry: the net R counts its R once (the rows keep each leg's).
  const c = CC.compare(a, { homes: [home('b', ['2021-06-14'], [leg(L('2021-06-14')), leg(L2)])] }, { level: 0.9 });
  assert.deepStrictEqual([c.discordant.map(d => d.a.r), c.netR], [[2, 2], -2]);
});

test('capture compare: the report lines are deterministic (same input, same text) and name both arms', () => {
  const { a, b } = arms();
  const t1 = CC.compareLines(CC.compare(a, b, { level: 0.9 }), { a: 'control', b: 'on' });
  const t2 = CC.compareLines(CC.compare(arms().a, arms().b, { level: 0.9 }), { a: 'control', b: 'on' });
  assert.deepStrictEqual(t1, t2);
  assert.match(t1.join('\n'), /legs caught \(all\): control 1\/6 .* on 3\/6/);
});
