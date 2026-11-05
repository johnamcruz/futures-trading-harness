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
const home = (name, days, legs, o = {}) => {
  const decisions = { times: 10, skipped: 0, overran: 0, lost: 0, cycles: 10, byDay: Object.fromEntries(days.map(d => [d, 10])), ...(o.decisions || {}) };
  return { name, days, legs, late: { rows: [] }, entryCycles: [], missingDays: [], ...o, decisions };
};
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
    home('b3', ['2021-06-16'], [leg(L('2021-06-16')), leg(S('2021-06-16'), { aligned: false })], { decisions: { times: 10, skipped: 2, overran: 1, lost: 3, cycles: 8 } }),
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
  assert.deepStrictEqual(c.overran.b, { times: 30, skipped: 2, overran: 1, lost: 3, share: 0.1 });
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
    { id: 's-ab', kind: 'caught-a-uncaught-b', reason: 'cycle-overran', max: 1, minPairs: 4 },
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
  assert.strictEqual(one({ kind: 'caught-a-uncaught-b', reason: 'cycle-overran', max: 0, minPairs: 1 }).verdict, 'FAIL');
  assert.strictEqual(one({ kind: 'caught-a-uncaught-b', reason: 'any', max: 0, minPairs: 1 }).verdict, 'FAIL');
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

test('capture compare: the criteria file is refused on a missing level, a minimum under 1, or a name outside its vocabulary', () => {
  const { a, b } = arms();
  const c = CC.compare(a, b, { level: 0.9 });
  const refuses = (x, re, doc = null) => assert.throws(() => CC.evaluate(c, doc || crit([{ id: 'x', ...x }])), re, JSON.stringify(x));
  refuses(null, /level: required/, { criteria: [{ id: 'x', kind: 'discordant-net-r', min: 0, minDiscordant: 1 }] });
  for (const [x, key] of [
    [{ kind: 'caught-rate', legs: 'all', margin: 0, minLegs: 0 }, 'minLegs'], [{ kind: 'late-refusals', lateKind: 'chased-entry', maxRatio: 1, minA: 0 }, 'minA'],
    [{ kind: 'overran-share', arm: 'b', max: 0, minDecisions: -1 }, 'minDecisions'], [{ kind: 'path-share', arm: 'b', path: 'confirm', min: 0, minEntries: 0.5 }, 'minEntries'],
    [{ kind: 'uncaught-reason-share', arm: 'a', legs: 'all', reason: 'rule', max: 0, minLegs: 0 }, 'minLegs'], [{ kind: 'discordant-net-r', min: 0, minDiscordant: 0 }, 'minDiscordant'],
    [{ kind: 'caught-a-uncaught-b', reason: 'any', max: 0, minPairs: 0 }, 'minPairs'],
  ]) refuses(x, new RegExp(`${key}: a whole number of 1 or more`));
  refuses({ kind: 'caught-a-uncaught-b', reason: 'any', max: 0 }, /needs minPairs/);
  // Misspelled names (the late kinds are chased-entry...; the reasons late-chased...): refused, never measured as 0.
  refuses({ kind: 'caught-a-uncaught-b', reason: 'cycle-overrun', max: 0, minPairs: 1 }, /reason cycle-overrun: one of .*cycle-overran/);
  refuses({ kind: 'uncaught-reason-share', arm: 'a', legs: 'all', reason: 'cycle_overran', max: 0, minLegs: 1 }, /reason cycle_overran/);
  refuses({ kind: 'uncaught-reason-share', arm: 'a', legs: 'all', reason: 'any', max: 0, minLegs: 1 }, /reason any/);
  refuses({ kind: 'late-refusals', lateKind: 'late-chased', maxRatio: 1, minA: 1 }, /lateKind late-chased: one of chased-entry, missed-entry, beyond-stop/);
  refuses({ kind: 'path-share', arm: 'b', path: 'confirmed', min: 0, minEntries: 1 }, /path confirmed: confirm, fallback or fallback:<why>/);
  assert.doesNotThrow(() => CC.evaluate(c, crit([{ id: 'x', kind: 'path-share', arm: 'b', path: 'fallback:void:stale', min: 0, minEntries: 1 }])));
  refuses(null, /badHomes: insufficient or fail/, { ...crit([{ id: 'x', kind: 'discordant-net-r', min: 0, minDiscordant: 1 }]), badHomes: 'ignore' });
});

test('capture compare: no data is never a PASS: arms with no common leg, no entry and no decision are insufficient on every kind', () => {
  const a = { homes: [home('a', ['2021-06-14'], [caught(L('2021-06-14'), 1)], { decisions: { times: 0, cycles: 0, byDay: {} } })] };
  const b = { homes: [home('b', ['2021-06-15'], [leg(L('2021-06-15'))], { decisions: { times: 0, cycles: 0, byDay: {} } })] };
  const c = CC.compare(a, b, { level: 0.9 });
  const r = CC.evaluate(c, crit([
    { id: 'k1', kind: 'caught-rate', legs: 'all', margin: 1, minLegs: 1 }, { id: 'k2', kind: 'late-refusals', lateKind: 'chased-entry', maxRatio: 9, minA: 1 },
    { id: 'k3', kind: 'overran-share', arm: 'b', max: 1, minDecisions: 1 }, { id: 'k4', kind: 'path-share', arm: 'b', path: 'confirm', min: 0, minEntries: 1 },
    { id: 'k5', kind: 'uncaught-reason-share', arm: 'b', legs: 'aligned', reason: 'rule', max: 1, minLegs: 2 }, { id: 'k6', kind: 'discordant-net-r', min: -9, minDiscordant: 1 },
    { id: 'k7', kind: 'caught-a-uncaught-b', reason: 'any', max: 9, minPairs: 1 },
  ]));
  assert.deepStrictEqual(r.results.map(x => x.verdict), Array(7).fill('INSUFFICIENT'), r.lines.join('\n'));
  assert.match(r.results.find(x => x.id === 'k7').why, /0 paired legs under minPairs 1/);
  assert.strictEqual(r.verdict, 'INSUFFICIENT');
  // A value missing past the sample check (an arm's summary without it) is never compared as 0.
  const { a: x, b: y } = arms();
  const cmp = CC.compare(x, y, { level: 0.9 });
  cmp.overran.b.share = null;
  const n = CC.evaluate(cmp, crit([{ id: 'o', kind: 'overran-share', arm: 'b', max: 0.5, minDecisions: 1 }])).results[0];
  assert.deepStrictEqual([n.verdict, n.measured, n.why], ['INSUFFICIENT', null, 'nothing measured']);
});

test('capture compare: late refusals compare per decision time on the paired days (a shorter arm cannot pass by running less)', () => {
  const rows = n => ({ late: { rows: Array.from({ length: n }, (_, i) => ({ at: `2021-06-14T13:${30 + i}:00Z`, kind: 'chased-entry' })) } });
  const a = { homes: [home('a', ['2021-06-14'], [leg(L('2021-06-14'))], { ...rows(4), decisions: { times: 40, byDay: { '2021-06-14': 40 } } })] };
  const b = { homes: [home('b', ['2021-06-14'], [leg(L('2021-06-14'))], { ...rows(3), decisions: { times: 10, byDay: { '2021-06-14': 10 } } })] };
  const c = CC.compare(a, b, { level: 0.9 });
  assert.deepStrictEqual(c.lateRate, { a: { 'chased-entry': 0.1 }, b: { 'chased-entry': 0.3 }, times: { a: 40, b: 10 } });
  const r = CC.evaluate(c, crit([{ id: 'x', kind: 'late-refusals', lateKind: 'chased-entry', maxRatio: 1, minA: 1 }])).results[0];
  assert.deepStrictEqual([r.verdict, r.measured], ['FAIL', 0.3], 'b refused 3 of 10 decision times, a 4 of 40: three times the rate, though fewer refusals');
  // b's decision times on a day a never ran don't dilute its rate (the paired days' alone count).
  const b2 = { homes: [home('b', ['2021-06-14', '2021-06-15'], [leg(L('2021-06-14'))], { ...rows(3), decisions: { times: 1010, byDay: { '2021-06-14': 10, '2021-06-15': 1000 } } })] };
  const c2 = CC.compare(a, b2, { level: 0.9 });
  assert.deepStrictEqual(c2.lateRate.times, { a: 40, b: 10 });
  assert.strictEqual(CC.evaluate(c2, crit([{ id: 'x', kind: 'late-refusals', lateKind: 'chased-entry', maxRatio: 1, minA: 1 }])).results[0].verdict, 'FAIL');
});

test('capture compare: late refusals with no decision time on the paired days in either arm are insufficient, never PASS', () => {
  const rows = n => ({ late: { rows: Array.from({ length: n }, (_, i) => ({ at: `2021-06-14T13:${30 + i}:00Z`, kind: 'chased-entry' })) } });
  const arm = (who, n, times) => ({ homes: [home(who, ['2021-06-14'], [leg(L('2021-06-14'))], { ...rows(n), decisions: { times, byDay: times ? { '2021-06-14': times } : {} } })] });
  const x = { id: 'x', kind: 'late-refusals', lateKind: 'chased-entry', maxRatio: 0.5, minA: 2 };
  for (const [a, b, who] of [[arm('a', 2, 0), arm('b', 3, 27), 'a'], [arm('a', 2, 27), arm('b', 3, 0), 'b']]) {
    const r = CC.evaluate(CC.compare(a, b, { level: 0.9 }), crit([x])).results[0];
    assert.strictEqual(r.verdict, 'INSUFFICIENT', `${who}: ${JSON.stringify(r)}`);
    assert.match(r.why, new RegExp(`0 decision times of ${who} on the paired days`));
    assert.doesNotMatch(String(r.threshold), /null/);
  }
});

test('capture compare: uncaught-reason-share with nothing uncaught measures nothing (insufficient); minLegs counts the uncaught legs', () => {
  const all = who => ({ homes: [home(who, ['2021-06-14'], Array.from({ length: 20 }, (_, i) => caught(`2021-06-14|long|2021-06-14T13:${10 + i}:00.000Z`, 1)))] });
  const doc = crit([{ id: 'late-not-the-reason', kind: 'uncaught-reason-share', arm: 'b', legs: 'aligned', reason: 'late-chased', max: 0.1, minLegs: 20 }]);
  const r = CC.evaluate(CC.compare(all('a'), all('b'), { level: 0.9 }), doc).results[0];
  assert.deepStrictEqual([r.verdict, r.measured], ['INSUFFICIENT', null], JSON.stringify(r));
  assert.match(r.why, /0 uncaught aligned legs under minLegs 20/);
  // 3 uncaught of 25 legs: the 3 are the sample, under a minimum of 4.
  const some = { homes: [home('b', ['2021-06-14'], [...all('b').homes[0].legs, ...[1, 2, 3].map(i => leg(`2021-06-14|long|2021-06-14T14:0${i}:00.000Z`, { reason: 'rule' }))])] };
  const s = CC.evaluate(CC.compare(all('a'), some, { level: 0.9 }), crit([{ id: 'y', kind: 'uncaught-reason-share', arm: 'b', legs: 'all', reason: 'rule', max: 1, minLegs: 4 }])).results[0];
  assert.deepStrictEqual([s.verdict, s.why], ['INSUFFICIENT', '3 uncaught all legs under minLegs 4']);
});

test('capture compare: a criteria file with an unknown key, a fractional minimum, a string level or a loose path is refused', () => {
  const { a, b } = arms();
  const c = CC.compare(a, b, { level: 0.9 });
  const refuses = (doc, re) => assert.throws(() => CC.evaluate(c, doc), re, JSON.stringify(doc));
  const one = x => crit([{ id: 'x', ...x }]);
  refuses({ ...one({ kind: 'discordant-net-r', min: 0, minDiscordant: 1 }), badhomes: 'fail' }, /criteria: unknown key badhomes/);
  refuses(one({ kind: 'caught-rate', legs: 'all', margin: 0, minLegs: 2, minLeg: 9 }), /x: unknown key minLeg/);
  refuses(one({ kind: 'caught-a-uncaught-b', reason: 'any', max: 0, minPairs: 1, legs: 'aligned' }), /x: unknown key legs/);
  refuses(one({ kind: 'caught-rate', legs: 'all', margin: 0, minLegs: 1.5 }), /minLegs: a whole number of 1 or more/);
  refuses({ ...one({ kind: 'discordant-net-r', min: 0, minDiscordant: 1 }), level: '0.9' }, /level "0.9"/);
  for (const p of ['fallbacks', 'fallback:', 'Confirm']) refuses(one({ kind: 'path-share', arm: 'b', path: p, min: 0, minEntries: 1 }), /path .*: confirm, fallback or fallback:<why>/);
});

test('capture compare: an arm with a bad home is insufficient (or FAIL when the file says so), and its problems are printed', () => {
  const { a, b } = arms();
  b.homes.push({ ...home('b9', [], []), error: 'no replay run in this home' });
  const c = CC.compare(a, b, { level: 0.9 });
  assert.deepStrictEqual(c.problems.map(p => [p.arm, p.kind]), [['b', 'error']]);
  const doc = crit([{ id: 'x', kind: 'overran-share', arm: 'b', max: 0.5, minDecisions: 1 }]);
  const r = CC.evaluate(c, doc);
  assert.deepStrictEqual([r.results[0].verdict, r.verdict], ['PASS', 'INSUFFICIENT']);
  assert.ok(r.lines.some(l => /^problem: b error: b9: no replay run in this home/.test(l)), r.lines.join('\n'));
  assert.strictEqual(CC.evaluate(c, { ...doc, badHomes: 'fail' }).verdict, 'FAIL');
});

test('capture compare: two homes on one day in an arm: their legs are left out of the pairing and flagged, never one kept silently', () => {
  const { a, b } = arms();
  a.homes.push(home('a1-rerun', ['2021-06-14'], [leg(L('2021-06-14')), leg(S('2021-06-14'))]));
  const c = CC.compare(a, b, { level: 0.9 });
  assert.deepStrictEqual(c.duplicates, { a: [L('2021-06-14'), S('2021-06-14')], b: [] });
  assert.strictEqual(c.legs.all.pairs, 4);
  assert.deepStrictEqual(c.problems.map(p => [p.arm, p.kind]), [['a', 'duplicate-day']]);
  assert.strictEqual(CC.evaluate(c, crit([{ id: 'x', kind: 'discordant-net-r', min: -9, minDiscordant: 1 }])).verdict, 'INSUFFICIENT');
});

test('capture compare: the equality bounds pass (overran share, discordant net R); Newcombe from both sides\' asymmetric bounds', () => {
  const { a, b } = arms();
  const c = CC.compare(a, b, { level: 0.9 });
  const one = x => CC.evaluate(c, crit([{ id: 'x', ...x }])).results[0].verdict;
  assert.strictEqual(one({ kind: 'overran-share', arm: 'b', max: 0.1, minDecisions: 1 }), 'PASS');
  assert.strictEqual(one({ kind: 'discordant-net-r', min: 2.5, minDiscordant: 1 }), 'PASS');
  // a 1 of 6, b 2 of 6: neither rate is 0.5, so each bound's terms differ.
  const six = (who, k) => ({ homes: [home(who, ['2021-06-14'], Array.from({ length: 6 }, (_, i) => (i < k ? caught : leg)(`2021-06-14|long|2021-06-14T13:${10 + i}:00.000Z`, 1)))] });
  const p = CC.compare(six('a', 1), six('b', 2), { level: 0.9 }).legs.all;
  const wa = wilson(1, 6, 0.9);
  const wb = wilson(2, 6, 0.9);
  const d = 2 / 6 - 1 / 6;
  assert.ok(Math.abs(p.lo - (d - Math.sqrt((2 / 6 - wb.lo) ** 2 + (wa.hi - 1 / 6) ** 2))) < 1e-3, String(p.lo));
  assert.ok(Math.abs(p.hi - (d + Math.sqrt((wb.hi - 2 / 6) ** 2 + (1 / 6 - wa.lo) ** 2))) < 1e-3, String(p.hi));
});

test('capture compare: the aligned scope needs both arms\' read aligned (a difference is counted); not-served legs never pair', () => {
  const { a, b } = arms();
  b.homes[0].legs[0].aligned = false; // a reads L 06-14 aligned, b not
  a.homes[1].legs[1].notServed = true;
  const c = CC.compare(a, b, { level: 0.9 });
  assert.strictEqual(c.legs.aligned.pairs, 3, 'S 06-16 aligned in neither, L 06-14 in a only, S 06-15 not served in a');
  assert.strictEqual(c.legs.alignedDiffers, 1);
  assert.strictEqual(c.legs.all.pairs, 5);
  assert.deepStrictEqual(c.legs.notServed, { a: 1, b: 0 });
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
