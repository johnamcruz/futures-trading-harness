'use strict';

/**
 * Two arms' setup capture compared (analysis/setup-capture.js readArm), and the accept check against a criteria file.
 * Pure: arms in, numbers out; no clock, no file.
 *
 * Pairing: a leg pairs when both arms covered it (the census id in both arms' legs: a leg one arm never stepped is
 * unpaired, never a miss). Days pair when both arms ran them; the late refusals are counted on the paired days.
 *
 *   compare(a, b, { level })   { level, days: { paired, aOnly, bOnly }, legs: { all, aligned, unpaired: { a, b } },
 *                              discordant: [{ id, day, side, caughtBy, a: { r, reason, availableR }, b }], netR (b's R on
 *                              the legs only b caught minus a's on those only a caught), caughtAUncaughtB: { reason: n },
 *                              reasons: { a, b } (the paired uncaught legs by reason), late: { a, b } (by kind, paired
 *                              days), overran: { a, b }, entryPaths: { a, b }, arms: { a: { legs, uncaught }, b } }
 *     legs.all / legs.aligned: { pairs, both, aOnly, bOnly, neither, a: { caught, rate, wilson }, b, diff (b - a), lo, hi
 *     (Newcombe's hybrid score interval from each side's Wilson interval at level), mcnemar: { pBetter, pWorse } (b
 *     against a, train/paired.js tally), rCaught: { a, b }, rAvailable: { a, b } }
 *   evaluate(cmp, criteria)    { verdict: PASS | FAIL | INSUFFICIENT, results: [{ id, kind, measured, threshold, verdict,
 *                              why }] sorted by id, lines }: criteria { level, criteria: [{ id, kind, ...}] }, every
 *                              threshold stated in the file (none here); a missing or malformed one refuses the file
 *   EXIT                       the verdicts in exit-code order (PASS 0, FAIL 1, INSUFFICIENT 2)
 *   KINDS                      each criterion kind's required keys
 *   compareLines(cmp, names)   the comparison's text lines
 *
 * Criterion kinds (the thresholds the file states):
 *   caught-rate               legs (all | aligned), margin, minLegs: b not worse than a by more than margin (the
 *                             difference's lower bound >= -margin); fewer than minLegs paired legs: insufficient
 *   late-refusals             lateKind, maxRatio, minA: b's late refusals of that kind at most maxRatio times a's (paired
 *                             days); a has fewer than minA: insufficient
 *   overran-share             arm, max, minDecisions: the decision times skipped while a cycle ran plus the cycles that
 *                             overran their bar, over the decision times
 *   path-share                arm, path, min, minEntries: the share of the arm's entries placed on the prepare path
 *                             (confirm, a fallback:<why>, or 'fallback' for any fallback)
 *   uncaught-reason-share     arm, legs, reason, max, minLegs: the share of the arm's uncaught legs with that reason
 *   discordant-net-r          min, minDiscordant: netR at least min
 *   caught-a-uncaught-b       reason (or 'any'), max: legs a caught and b missed for that reason, at most max
 */

const { wilson, round4 } = require('../prop/stats');
const { tally } = require('../train/paired');
const { bankedR } = require('./setup-capture');
const { tradingDayKey } = require('../trading/clock');

const dayOf = t => tradingDayKey(new Date(t));

const EXIT = Object.freeze(['PASS', 'FAIL', 'INSUFFICIENT']);
const KINDS = Object.freeze({
  'caught-rate': ['legs', 'margin', 'minLegs'],
  'late-refusals': ['lateKind', 'maxRatio', 'minA'],
  'overran-share': ['arm', 'max', 'minDecisions'],
  'path-share': ['arm', 'path', 'min', 'minEntries'],
  'uncaught-reason-share': ['arm', 'legs', 'reason', 'max', 'minLegs'],
  'discordant-net-r': ['min', 'minDiscordant'],
  'caught-a-uncaught-b': ['reason', 'max'],
});
const NUMERIC = new Set(['margin', 'minLegs', 'maxRatio', 'minA', 'max', 'minDecisions', 'min', 'minEntries', 'minDiscordant']);

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const count = (o, k) => { o[k] = (o[k] || 0) + 1; return o; };
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = o => Object.fromEntries(Object.entries(o).sort(([x], [y]) => byKey(x, y)));
const sq = x => x * x;
const sum = xs => round4(xs.reduce((s, x) => s + (num(x) || 0), 0));

const legsOf = arm => new Map(arm.homes.flatMap(h => h.legs).map(l => [l.id, l]));
const daysOf = arm => new Set(arm.homes.flatMap(h => h.days));

/** Paired stats of one leg scope (see the header). */
function pairStats(ids, A, B, level) {
  const pairs = ids.map(id => ({ a: A.get(id), b: B.get(id) }));
  const n = pairs.length;
  const k = side => pairs.filter(p => p[side].caught).length;
  const both = pairs.filter(p => p.a.caught && p.b.caught).length;
  const wa = wilson(k('a'), n, level);
  const wb = wilson(k('b'), n, level);
  const pa = n ? k('a') / n : null;
  const pb = n ? k('b') / n : null;
  const diff = n ? pb - pa : null;
  const t = tally(pairs.map(p => ({ base: { c: p.a.caught }, cand: { c: p.b.caught } })), r => !r.c);
  const caughtR = side => bankedR(pairs.filter(p => p[side].caught).map(p => p[side]));
  return {
    pairs: n, both, aOnly: k('a') - both, bOnly: k('b') - both, neither: n - k('a') - k('b') + both,
    a: { caught: k('a'), rate: wa.rate, wilson: wa }, b: { caught: k('b'), rate: wb.rate, wilson: wb },
    diff: n ? round4(diff) : null,
    lo: n ? round4(diff - Math.sqrt(sq(pb - wb.lo) + sq(wa.hi - pa))) : null,
    hi: n ? round4(diff + Math.sqrt(sq(wb.hi - pb) + sq(pa - wa.lo))) : null,
    mcnemar: { pBetter: t.pBetter, pWorse: t.pWorse },
    rCaught: { a: caughtR('a'), b: caughtR('b') }, rAvailable: { a: sum(pairs.map(p => p.a.availableR)), b: sum(pairs.map(p => p.b.availableR)) },
  };
}

function compare(a, b, { level }) {
  const A = legsOf(a);
  const B = legsOf(b);
  const ids = [...A.keys()].filter(id => B.has(id)).sort(byKey);
  const da = daysOf(a);
  const db = daysOf(b);
  const paired = [...da].filter(d => db.has(d)).sort(byKey);
  const onPaired = new Set(paired);
  const late = arm => sorted(arm.homes.flatMap(h => h.late.rows).filter(r => onPaired.has(dayOf(r.at))).reduce((o, r) => count(o, r.kind || 'unknown'), {}));
  const discordant = ids.filter(id => A.get(id).caught !== B.get(id).caught).map(id => {
    const x = A.get(id);
    const y = B.get(id);
    const side = l => ({ r: l.caught && l.entry ? num(l.entry.r) : null, reason: l.reason || null, availableR: num(l.availableR) });
    return { id, day: x.day, side: x.side, caughtBy: x.caught ? 'a' : 'b', a: side(x), b: side(y) };
  });
  const reasons = M => sorted(ids.map(id => M.get(id)).filter(l => !l.caught).reduce((o, l) => count(o, l.reason || 'other'), {}));
  const overran = arm => {
    const d = arm.homes.reduce((s, h) => ({ times: s.times + h.decisions.times, skipped: s.skipped + h.decisions.skipped, overran: s.overran + h.decisions.overran }), { times: 0, skipped: 0, overran: 0 });
    return { ...d, share: d.times ? round4((d.skipped + d.overran) / d.times) : null };
  };
  const paths = arm => sorted(arm.homes.flatMap(h => h.entryCycles || []).reduce((o, e) => count(o, e.path || 'n/a'), {}));
  const own = M => ({ legs: { all: [...M.values()], aligned: [...M.values()].filter(l => l.aligned) } });
  return {
    level,
    days: { paired, aOnly: [...da].filter(d => !db.has(d)).sort(byKey), bOnly: [...db].filter(d => !da.has(d)).sort(byKey) },
    legs: { all: pairStats(ids, A, B, level), aligned: pairStats(ids.filter(id => A.get(id).aligned && B.get(id).aligned), A, B, level), unpaired: { a: A.size - ids.length, b: B.size - ids.length } },
    discordant,
    netR: round4(sum(discordant.filter(d => d.caughtBy === 'b').map(d => d.b.r)) - sum(discordant.filter(d => d.caughtBy === 'a').map(d => d.a.r))),
    caughtAUncaughtB: sorted(discordant.filter(d => d.caughtBy === 'a').reduce((o, d) => count(o, d.b.reason || 'other'), {})),
    reasons: { a: reasons(A), b: reasons(B) },
    late: { a: late(a), b: late(b) },
    overran: { a: overran(a), b: overran(b) },
    entryPaths: { a: paths(a), b: paths(b) },
    arms: { a: own(A), b: own(B) },
  };
}

/** The criteria file checked: every kind's keys stated, numbers as numbers, ids unique, a level wilson takes. */
function checkCriteria(doc) {
  if (!isObj(doc) || !Array.isArray(doc.criteria)) throw new Error('criteria: { level, criteria: [{ id, kind, ... }] }');
  try { wilson(0, 1, doc.level); } catch (err) { throw new Error(`criteria: level ${JSON.stringify(doc.level)}: one Wilson takes (prop/stats.js wilson)`, { cause: err }); }
  if (!doc.criteria.length) throw new Error('criteria: no criteria listed');
  const seen = new Set();
  for (const c of doc.criteria) {
    if (!isObj(c) || typeof c.id !== 'string' || !c.id) throw new Error('criteria: each criterion has an id');
    if (seen.has(c.id)) throw new Error(`criteria: ${c.id} twice`);
    seen.add(c.id);
    const keys = KINDS[c.kind];
    if (!keys) throw new Error(`criteria: ${c.id}: kind ${c.kind}; one of ${Object.keys(KINDS).join(', ')}`);
    for (const k of keys) {
      if (c[k] === undefined) throw new Error(`criteria: ${c.id}: ${c.kind} needs ${k}`);
      if (NUMERIC.has(k) && num(c[k]) === null) throw new Error(`criteria: ${c.id}: ${k}: a number, not ${JSON.stringify(c[k])}`);
    }
    if (keys.includes('arm') && !['a', 'b'].includes(c.arm)) throw new Error(`criteria: ${c.id}: arm a or b, not ${JSON.stringify(c.arm)}`);
    if (keys.includes('legs') && !['all', 'aligned'].includes(c.legs)) throw new Error(`criteria: ${c.id}: legs all or aligned, not ${JSON.stringify(c.legs)}`);
  }
}

const result = (c, measured, threshold, ok, why = null) => ({ id: c.id, kind: c.kind, measured, threshold, verdict: ok === null ? 'INSUFFICIENT' : ok ? 'PASS' : 'FAIL', why });
const short = (n, what, key, min) => `${n} ${what} under ${key} ${min}`;

/** One criterion's result (see the header). */
function judge(cmp, c) {
  if (c.kind === 'caught-rate') {
    const p = cmp.legs[c.legs];
    if (p.pairs < c.minLegs) return result(c, p.lo, `>= ${-c.margin}`, null, short(p.pairs, `paired ${c.legs} legs`, 'minLegs', c.minLegs));
    return result(c, p.lo, `>= ${-c.margin}`, p.lo >= -c.margin, `rate a ${p.a.rate}, b ${p.b.rate}, diff ${p.diff} [${p.lo}, ${p.hi}]`);
  }
  if (c.kind === 'late-refusals') {
    const na = cmp.late.a[c.lateKind] || 0;
    const nb = cmp.late.b[c.lateKind] || 0;
    const cap = round4(c.maxRatio * na);
    if (na < c.minA) return result(c, nb, `<= ${cap}`, null, short(na, `${c.lateKind} refusals in a`, 'minA', c.minA));
    return result(c, nb, `<= ${cap}`, nb <= cap, `a ${na}, b ${nb} on ${cmp.days.paired.length} paired days`);
  }
  if (c.kind === 'overran-share') {
    const o = cmp.overran[c.arm];
    if (o.times < c.minDecisions) return result(c, o.share, `<= ${c.max}`, null, short(o.times, 'decision times', 'minDecisions', c.minDecisions));
    return result(c, o.share, `<= ${c.max}`, o.share <= c.max, `${o.skipped} skipped, ${o.overran} overran of ${o.times}`);
  }
  if (c.kind === 'path-share') {
    const paths = cmp.entryPaths[c.arm];
    const n = Object.values(paths).reduce((s, x) => s + x, 0);
    const on = Object.entries(paths).filter(([k]) => k === c.path || (c.path === 'fallback' && k.startsWith('fallback:'))).reduce((s, [, x]) => s + x, 0);
    const share = n ? round4(on / n) : null;
    if (n < c.minEntries) return result(c, share, `>= ${c.min}`, null, short(n, 'entries', 'minEntries', c.minEntries));
    return result(c, share, `>= ${c.min}`, share >= c.min, `${on} of ${n} entries on ${c.path}`);
  }
  if (c.kind === 'uncaught-reason-share') {
    const legs = cmp.arms[c.arm].legs[c.legs];
    const un = legs.filter(l => !l.caught);
    const k = un.filter(l => l.reason === c.reason).length;
    const share = un.length ? round4(k / un.length) : 0;
    if (legs.length < c.minLegs) return result(c, share, `<= ${c.max}`, null, short(legs.length, `${c.legs} legs`, 'minLegs', c.minLegs));
    return result(c, share, `<= ${c.max}`, share <= c.max, `${k} of ${un.length} uncaught ${c.legs} legs`);
  }
  if (c.kind === 'discordant-net-r') {
    const n = cmp.discordant.length;
    if (n < c.minDiscordant) return result(c, cmp.netR, `>= ${c.min}`, null, short(n, 'discordant legs', 'minDiscordant', c.minDiscordant));
    return result(c, cmp.netR, `>= ${c.min}`, cmp.netR >= c.min, `${n} discordant legs`);
  }
  const n = c.reason === 'any' ? Object.values(cmp.caughtAUncaughtB).reduce((s, x) => s + x, 0) : cmp.caughtAUncaughtB[c.reason] || 0;
  return result(c, n, `<= ${c.max}`, n <= c.max, `legs a caught and b missed (${c.reason})`);
}

function evaluate(cmp, criteria) {
  checkCriteria(criteria);
  const results = criteria.criteria.map(c => judge(cmp, c)).sort((x, y) => byKey(x.id, y.id));
  const verdict = results.some(r => r.verdict === 'FAIL') ? 'FAIL' : results.some(r => r.verdict === 'INSUFFICIENT') ? 'INSUFFICIENT' : 'PASS';
  const lines = results.map(r => `${r.id} [${r.kind}]: measured ${r.measured === null ? 'n/a' : r.measured}, threshold ${r.threshold}: ${r.verdict}${r.why ? ` (${r.why})` : ''}`);
  return { verdict, results, lines: [...lines, `verdict: ${verdict}`] };
}

const rateText = s => `${s.caught}/${s.wilson.n} (${s.rate === null ? '-' : s.rate}, ${Math.round(s.wilson.level * 100)}% [${s.wilson.lo}, ${s.wilson.hi}])`;

function compareLines(cmp, { a = 'a', b = 'b' } = {}) {
  const L = [`days: ${cmp.days.paired.length} paired; only ${a} ${cmp.days.aOnly.length}, only ${b} ${cmp.days.bOnly.length}`];
  for (const scope of ['all', 'aligned']) {
    const p = cmp.legs[scope];
    L.push(`legs caught (${scope}): ${a} ${rateText(p.a)}, ${b} ${rateText(p.b)}; diff ${p.diff} [${p.lo}, ${p.hi}]; both ${p.both}, only ${a} ${p.aOnly}, only ${b} ${p.bOnly}, neither ${p.neither}; McNemar p(${b} better) ${p.mcnemar.pBetter}, p(worse) ${p.mcnemar.pWorse}; R caught/available ${a} ${p.rCaught.a}/${p.rAvailable.a}, ${b} ${p.rCaught.b}/${p.rAvailable.b}`);
  }
  L.push(`unpaired legs (one arm only covered them): ${a} ${cmp.legs.unpaired.a}, ${b} ${cmp.legs.unpaired.b}`);
  L.push(`discordant legs ${cmp.discordant.length}, net R (${b}'s only minus ${a}'s only) ${cmp.netR}`);
  for (const d of cmp.discordant) L.push(`  ${d.id} caught by ${d.caughtBy === 'a' ? a : b}: ${a} R ${d.a.r ?? '-'} (${d.a.reason || 'caught'}), ${b} R ${d.b.r ?? '-'} (${d.b.reason || 'caught'}), available ${d.a.availableR ?? '-'}R`);
  L.push(`caught by ${a}, missed by ${b}, by ${b}'s reason: ${JSON.stringify(cmp.caughtAUncaughtB)}`);
  L.push(`uncaught paired legs by reason: ${a} ${JSON.stringify(cmp.reasons.a)}; ${b} ${JSON.stringify(cmp.reasons.b)}`);
  L.push(`late refusals by kind (paired days): ${a} ${JSON.stringify(cmp.late.a)}; ${b} ${JSON.stringify(cmp.late.b)}`);
  L.push(`decision times skipped or overran: ${a} ${JSON.stringify(cmp.overran.a)}; ${b} ${JSON.stringify(cmp.overran.b)}`);
  L.push(`entries by prepare path: ${a} ${JSON.stringify(cmp.entryPaths.a)}; ${b} ${JSON.stringify(cmp.entryPaths.b)}`);
  return L;
}

module.exports = { EXIT, KINDS, compare, evaluate, compareLines, checkCriteria };
