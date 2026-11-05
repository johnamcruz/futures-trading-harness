'use strict';

/**
 * Two arms' setup capture compared (analysis/setup-capture.js readArm), and the accept check against a criteria file.
 * Pure: arms in, numbers out; no clock, no file.
 *
 * Pairing: a leg pairs when both arms covered it once (the census id in both arms' legs: a leg one arm never stepped is
 * unpaired, never a miss; a leg either arm's steps served no bar for, not-served, never pairs; a leg twice in one arm,
 * two homes on its day, is left out and flagged in `duplicates`). Days pair when both arms ran them; the late refusals
 * are compared per decision time on the paired days. Nothing an arm lacks is dropped silently: its problems
 * (setup-capture.js armProblems) travel with the comparison, and accept never passes over them.
 *
 *   compare(a, b, { level })   { level, days: { paired, aOnly, bOnly }, legs: { all, aligned, unpaired: { a, b },
 *                              notServed: { a, b }, alignedDiffers }, duplicates: { a, b }, problems: [{ arm, kind,
 *                              detail }], discordant: [{ id, day, side, caughtBy, a: { r, reason, availableR }, b }],
 *                              netR (b's R banked on the legs only b caught minus a's on those only a caught, each entry
 *                              once), caughtAUncaughtB: { reason: n }, reasons: { a, b } (the paired uncaught legs),
 *                              late: { a, b } (counts by kind, paired days), lateRate: { a, b, times: { a, b } } (per
 *                              decision time on the paired days), overran: { a, b }, entryPaths: { a, b }, arms }
 *     legs.all / legs.aligned: { pairs, both, aOnly, bOnly, neither, a: { caught, rate, wilson }, b, diff (b - a), lo, hi
 *     (Newcombe's hybrid score interval from each side's Wilson interval at level: the unpaired form, conservative on
 *     paired legs), mcnemar: { pBetter, pWorse } (b against a, train/paired.js tally), rCaught: { a, b }, rAvailable }
 *     (aligned: both arms' reads aligned; alignedDiffers counts the paired legs whose two reads differ)
 *   evaluate(cmp, criteria)    { verdict: PASS | FAIL | INSUFFICIENT, results: [{ id, kind, measured, threshold, verdict,
 *                              why }] sorted by id, lines }: criteria { level, badHomes?, criteria: [{ id, kind, ...}] }
 *   checkCriteria(criteria)    throws on a malformed file (see below)
 *   EXIT                       the verdicts in exit-code order (PASS 0, FAIL 1, INSUFFICIENT 2)
 *   KINDS                      each criterion kind's required keys
 *   compareLines(cmp, names)   the comparison's text lines
 *
 * The criteria file states every threshold (none here) and its Wilson `level` (required). Each kind's minimum sample
 * (min*) is a whole number of 1 or more, so no data is never a pass: below it, or with nothing measured, a criterion is
 * INSUFFICIENT. Names are checked against their sets: reason (setup-capture.js REASONS; 'any' too for
 * caught-a-uncaught-b), lateKind (chased-entry, missed-entry, beyond-stop), path (confirm, fallback, fallback:<why>). An
 * arm with a problem makes the verdict INSUFFICIENT, or FAIL with `badHomes: "fail"`; FAIL outranks INSUFFICIENT.
 *
 * Criterion kinds (the thresholds the file states):
 *   caught-rate               legs (all | aligned), margin, minLegs: b not worse than a by more than margin (the
 *                             difference's lower bound >= -margin)
 *   late-refusals             lateKind, maxRatio, minA: b's late refusals of that kind per decision time at most
 *                             maxRatio times a's (paired days); a has fewer than minA of them: insufficient
 *   overran-share             arm, max, minDecisions: the bars lost to latency (setup-capture.js decisions.lost: skipped
 *                             while a cycle ran, or after a cycle that overran its bar, each once) over the decision times
 *   path-share                arm, path, min, minEntries: the share of the arm's entries placed on the prepare path
 *   uncaught-reason-share     arm, legs, reason, max, minLegs: the share of the arm's uncaught legs with that reason
 *   discordant-net-r          min, minDiscordant: netR at least min
 *   caught-a-uncaught-b       reason (or 'any'), max, minPairs: legs a caught and b missed for that reason, at most max
 */

const { wilson, round4 } = require('../prop/stats');
const { tally } = require('../train/paired');
const SC = require('./setup-capture');
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
  'caught-a-uncaught-b': ['reason', 'max', 'minPairs'],
});
const MINIMA = new Set(['minLegs', 'minA', 'minDecisions', 'minEntries', 'minDiscordant', 'minPairs']);
const NUMERIC = new Set(['margin', 'maxRatio', 'max', 'min', ...MINIMA]);
const BAD_HOMES = Object.freeze(['insufficient', 'fail']);

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const count = (o, k) => { o[k] = (o[k] || 0) + 1; return o; };
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = o => Object.fromEntries(Object.entries(o).sort(([x], [y]) => byKey(x, y)));
const sq = x => x * x;
const sum = xs => round4(xs.reduce((s, x) => s + (num(x) || 0), 0));

/** An arm's legs by id, each once: { map, duplicates (ids twice or more: left out), notServed (count) }. */
function legsOf(arm) {
  const seen = new Map();
  for (const l of arm.homes.flatMap(h => h.legs)) seen.set(l.id, [...(seen.get(l.id) || []), l]);
  const duplicates = [...seen.keys()].filter(id => seen.get(id).length > 1).sort(byKey);
  const map = new Map([...seen].filter(([, ls]) => ls.length === 1).map(([id, ls]) => [id, ls[0]]));
  return { map, duplicates, notServed: [...map.values()].filter(l => l.notServed).length };
}
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
  const caughtR = side => SC.bankedR(pairs.filter(p => p[side].caught).map(p => p[side]));
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
  const la = legsOf(a);
  const lb = legsOf(b);
  const A = la.map;
  const B = lb.map;
  const ids = [...A.keys()].filter(id => B.has(id) && !A.get(id).notServed && !B.get(id).notServed).sort(byKey);
  const da = daysOf(a);
  const db = daysOf(b);
  const paired = [...da].filter(d => db.has(d)).sort(byKey);
  const onPaired = new Set(paired);
  const late = arm => sorted(arm.homes.flatMap(h => h.late.rows).filter(r => onPaired.has(dayOf(r.at))).reduce((o, r) => count(o, r.kind || 'unknown'), {}));
  const timesOn = arm => arm.homes.reduce((s, h) => s + paired.reduce((x, d) => x + ((h.decisions.byDay || {})[d] || 0), 0), 0);
  const lateA = late(a);
  const lateB = late(b);
  const times = { a: timesOn(a), b: timesOn(b) };
  const perTime = (counts, n) => sorted(Object.fromEntries(Object.entries(counts).map(([k, x]) => [k, n ? round4(x / n) : null])));
  const discordant = ids.filter(id => A.get(id).caught !== B.get(id).caught).map(id => {
    const x = A.get(id);
    const y = B.get(id);
    const side = l => ({ r: l.caught && l.entry ? num(l.entry.r) : null, reason: l.reason || null, availableR: num(l.availableR) });
    return { id, day: x.day, side: x.side, caughtBy: x.caught ? 'a' : 'b', a: side(x), b: side(y) };
  });
  const reasons = M => sorted(ids.map(id => M.get(id)).filter(l => !l.caught).reduce((o, l) => count(o, l.reason || 'other'), {}));
  const overran = arm => {
    const d = arm.homes.reduce((s, h) => ({ times: s.times + h.decisions.times, skipped: s.skipped + h.decisions.skipped, overran: s.overran + h.decisions.overran, lost: s.lost + (h.decisions.lost || 0) }), { times: 0, skipped: 0, overran: 0, lost: 0 });
    return { ...d, share: d.times ? round4(d.lost / d.times) : null };
  };
  const paths = arm => sorted(arm.homes.flatMap(h => h.entryCycles || []).reduce((o, e) => count(o, e.path || 'n/a'), {}));
  const own = M => { const all = [...M.values()].filter(l => !l.notServed); return { legs: { all, aligned: all.filter(l => l.aligned) } }; };
  const problems = [
    ...SC.armProblems(a).map(p => ({ arm: 'a', ...p })), ...SC.armProblems(b).map(p => ({ arm: 'b', ...p })),
  ];
  return {
    level,
    days: { paired, aOnly: [...da].filter(d => !db.has(d)).sort(byKey), bOnly: [...db].filter(d => !da.has(d)).sort(byKey) },
    legs: {
      all: pairStats(ids, A, B, level), aligned: pairStats(ids.filter(id => A.get(id).aligned && B.get(id).aligned), A, B, level),
      unpaired: { a: A.size - ids.length, b: B.size - ids.length }, notServed: { a: la.notServed, b: lb.notServed },
      alignedDiffers: ids.filter(id => Boolean(A.get(id).aligned) !== Boolean(B.get(id).aligned)).length,
    },
    duplicates: { a: la.duplicates, b: lb.duplicates },
    problems,
    discordant,
    // Each side's entries banked once (bankedR: one fill can catch two adjacent legs).
    netR: round4(SC.bankedR(discordant.filter(d => d.caughtBy === 'b').map(d => B.get(d.id))) - SC.bankedR(discordant.filter(d => d.caughtBy === 'a').map(d => A.get(d.id)))),
    caughtAUncaughtB: sorted(discordant.filter(d => d.caughtBy === 'a').reduce((o, d) => count(o, d.b.reason || 'other'), {})),
    reasons: { a: reasons(A), b: reasons(B) },
    late: { a: lateA, b: lateB },
    lateRate: { a: perTime(lateA, times.a), b: perTime(lateB, times.b), times },
    overran: { a: overran(a), b: overran(b) },
    entryPaths: { a: paths(a), b: paths(b) },
    arms: { a: own(A), b: own(B) },
  };
}

/** The criteria file checked (see the header); throws on the first problem. */
function checkCriteria(doc) {
  if (!isObj(doc) || !Array.isArray(doc.criteria)) throw new Error('criteria: { level, criteria: [{ id, kind, ... }] }');
  if (doc.level === undefined) throw new Error('criteria: level: required (the Wilson level, one prop/stats.js wilson takes)');
  try { wilson(0, 1, doc.level); } catch (err) { throw new Error(`criteria: level ${JSON.stringify(doc.level)}: one Wilson takes (prop/stats.js wilson)`, { cause: err }); }
  if (doc.badHomes !== undefined && !BAD_HOMES.includes(doc.badHomes)) throw new Error(`criteria: badHomes: ${BAD_HOMES.join(' or ')}, not ${JSON.stringify(doc.badHomes)}`);
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
      if (MINIMA.has(k) && !(Number.isInteger(c[k]) && c[k] >= 1)) throw new Error(`criteria: ${c.id}: ${k}: a whole number of 1 or more (the sample a verdict needs), not ${JSON.stringify(c[k])}`);
    }
    if (keys.includes('arm') && !['a', 'b'].includes(c.arm)) throw new Error(`criteria: ${c.id}: arm a or b, not ${JSON.stringify(c.arm)}`);
    if (keys.includes('legs') && !['all', 'aligned'].includes(c.legs)) throw new Error(`criteria: ${c.id}: legs all or aligned, not ${JSON.stringify(c.legs)}`);
    const reasons = c.kind === 'caught-a-uncaught-b' ? [...SC.REASONS, 'any'] : SC.REASONS;
    if (keys.includes('reason') && !reasons.includes(c.reason)) throw new Error(`criteria: ${c.id}: reason ${c.reason}: one of ${reasons.join(', ')}`);
    if (keys.includes('lateKind') && !SC.LATE_KINDS.includes(c.lateKind)) throw new Error(`criteria: ${c.id}: lateKind ${c.lateKind}: one of ${SC.LATE_KINDS.join(', ')}`);
    if (keys.includes('path') && !(c.path === 'confirm' || c.path === 'fallback' || /^fallback:\S+$/.test(String(c.path)))) throw new Error(`criteria: ${c.id}: path ${c.path}: confirm, fallback or fallback:<why> (prepare-shadow-report.js pathKey)`);
  }
}

// A verdict from a check; nothing measured is never compared (JavaScript reads null as 0): insufficient.
const result = (c, measured, threshold, ok, why = null) => {
  const none = measured === null || measured === undefined;
  return { id: c.id, kind: c.kind, measured: none ? null : measured, threshold, verdict: ok === null || none ? 'INSUFFICIENT' : ok ? 'PASS' : 'FAIL', why: none && ok !== null ? 'nothing measured' : why };
};
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
    const { a: ta, b: tb } = cmp.lateRate.times;
    const rb = tb ? round4(nb / tb) : null;
    const cap = ta ? round4((c.maxRatio * na) / ta) : null;
    if (na < c.minA) return result(c, rb, `<= ${cap}`, null, short(na, `${c.lateKind} refusals in a`, 'minA', c.minA));
    if (!tb) return result(c, rb, `<= ${cap}`, null, short(tb, 'decision times of b on the paired days', 'a sample of', 1));
    // Per decision time, cross-multiplied (no rounding at the bound): nb / tb <= maxRatio x na / ta.
    return result(c, rb, `<= ${cap}`, nb * ta <= c.maxRatio * na * tb, `a ${na} of ${ta} decision times, b ${nb} of ${tb}, on ${cmp.days.paired.length} paired days`);
  }
  if (c.kind === 'overran-share') {
    const o = cmp.overran[c.arm];
    if (o.times < c.minDecisions) return result(c, o.share, `<= ${c.max}`, null, short(o.times, 'decision times', 'minDecisions', c.minDecisions));
    return result(c, o.share, `<= ${c.max}`, o.share <= c.max, `${o.lost} bars lost (${o.skipped} skipped, ${o.overran} overran) of ${o.times}`);
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
  const pairs = cmp.legs.all.pairs;
  if (pairs < c.minPairs) return result(c, n, `<= ${c.max}`, null, short(pairs, 'paired legs', 'minPairs', c.minPairs));
  return result(c, n, `<= ${c.max}`, n <= c.max, `legs a caught and b missed (${c.reason}) of ${pairs} paired`);
}

function evaluate(cmp, criteria) {
  checkCriteria(criteria);
  const results = criteria.criteria.map(c => judge(cmp, c)).sort((x, y) => byKey(x.id, y.id));
  const problems = cmp.problems || [];
  const failed = results.some(r => r.verdict === 'FAIL') || (problems.length > 0 && criteria.badHomes === 'fail');
  const verdict = failed ? 'FAIL' : problems.length || results.some(r => r.verdict === 'INSUFFICIENT') ? 'INSUFFICIENT' : 'PASS';
  const lines = results.map(r => `${r.id} [${r.kind}]: measured ${r.measured === null ? 'n/a' : r.measured}, threshold ${r.threshold}: ${r.verdict}${r.why ? ` (${r.why})` : ''}`);
  const told = problems.map(p => `problem: ${p.arm} ${p.kind}: ${p.detail}`);
  return { verdict, results, problems, lines: [...lines, ...told, `verdict: ${verdict}${problems.length ? ` (${problems.length} input problem(s): ${criteria.badHomes === 'fail' ? 'badHomes fail' : 'insufficient'})` : ''}`] };
}

const rateText = s => `${s.caught}/${s.wilson.n} (${s.rate === null ? '-' : s.rate}, ${Math.round(s.wilson.level * 100)}% [${s.wilson.lo}, ${s.wilson.hi}])`;

function compareLines(cmp, { a = 'a', b = 'b' } = {}) {
  const who = x => (x === 'a' ? a : b);
  const L = [`days: ${cmp.days.paired.length} paired; only ${a} ${cmp.days.aOnly.length}, only ${b} ${cmp.days.bOnly.length}`, ...cmp.problems.map(p => `problem: ${who(p.arm)} ${p.kind}: ${p.detail}`)];
  for (const scope of ['all', 'aligned']) {
    const p = cmp.legs[scope];
    L.push(`legs caught (${scope}): ${a} ${rateText(p.a)}, ${b} ${rateText(p.b)}; diff ${p.diff} [${p.lo}, ${p.hi}]; both ${p.both}, only ${a} ${p.aOnly}, only ${b} ${p.bOnly}, neither ${p.neither}; McNemar p(${b} better) ${p.mcnemar.pBetter}, p(worse) ${p.mcnemar.pWorse}; R caught/available ${a} ${p.rCaught.a}/${p.rAvailable.a}, ${b} ${p.rCaught.b}/${p.rAvailable.b}`);
  }
  L.push(`unpaired legs (one arm only covered them): ${a} ${cmp.legs.unpaired.a}, ${b} ${cmp.legs.unpaired.b}; not served (no bar, never paired): ${a} ${cmp.legs.notServed.a}, ${b} ${cmp.legs.notServed.b}; paired legs whose aligned read differs ${cmp.legs.alignedDiffers}`);
  if (cmp.duplicates.a.length || cmp.duplicates.b.length) L.push(`legs twice in one arm (two homes on a day; left out): ${a} ${cmp.duplicates.a.length}, ${b} ${cmp.duplicates.b.length}`);
  L.push(`discordant legs ${cmp.discordant.length}, net R (${b}'s only minus ${a}'s only) ${cmp.netR}`);
  for (const d of cmp.discordant) L.push(`  ${d.id} caught by ${who(d.caughtBy)}: ${a} R ${d.a.r ?? '-'} (${d.a.reason || 'caught'}), ${b} R ${d.b.r ?? '-'} (${d.b.reason || 'caught'}), available ${d.a.availableR ?? '-'}R`);
  L.push(`caught by ${a}, missed by ${b}, by ${b}'s reason: ${JSON.stringify(cmp.caughtAUncaughtB)}`);
  L.push(`uncaught paired legs by reason: ${a} ${JSON.stringify(cmp.reasons.a)}; ${b} ${JSON.stringify(cmp.reasons.b)}`);
  L.push(`late refusals by kind (paired days): ${a} ${JSON.stringify(cmp.late.a)} of ${cmp.lateRate.times.a} decision times, ${b} ${JSON.stringify(cmp.late.b)} of ${cmp.lateRate.times.b}; per decision time ${a} ${JSON.stringify(cmp.lateRate.a)}, ${b} ${JSON.stringify(cmp.lateRate.b)}`);
  L.push(`bars lost to latency: ${a} ${JSON.stringify(cmp.overran.a)}; ${b} ${JSON.stringify(cmp.overran.b)}`);
  L.push(`entries by prepare path: ${a} ${JSON.stringify(cmp.entryPaths.a)}; ${b} ${JSON.stringify(cmp.entryPaths.b)}`);
  return L;
}

module.exports = { EXIT, KINDS, compare, evaluate, compareLines, checkCriteria };
