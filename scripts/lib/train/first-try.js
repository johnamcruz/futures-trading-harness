'use strict';

/**
 * First-try reasoning (Propose-Probe-Compose, docs/TRAINING.md): how the model reads a bar on its own, before
 * compose_check's refusal hints (trading/compose-hints.js: the HINT lines that say what is true on the bar) can carry
 * it. The compose records (trading/trade-lifecycle.js) are append-only, one per call; per decision point (the record's
 * root, bar and side) the first by its `at` is the first try, every later one is after a hint (a refused record shows
 * its hints). Code only, from what the run recorded.
 *
 *   per point    the first try: each read verified (check true) or not, whether it was OK, the flow steps whose reads
 *                failed (and the steps it didn't state); the tries; rescued: the first try refused and a later one OK
 *                (OK only after a hint); finalOk: the last try OK
 *   summary      first-try read accuracy (reads verified of reads stated), first-try decision accuracy (points whose
 *                first reads were all verified), first-try OK rate, hint-rescue rate (points rescued, of all points)
 *   paired       the champion and an edit on the same points: each point's first reads all verified or not, an exact
 *                one-sided McNemar test; worse under the loop's decision rule (train/paired.js DECISION_RULE: at least
 *                minDiscordant changed points, p at most alpha) is a harm: an edit that catches more legs by leaning on
 *                the hints is never better for it. Never a gain on its own
 *
 *   keyOf(record)                     root|bar|side, or null
 *   firstTries(records)               [{ key, root, bar, side, first: { ok, reads, failed }, tries, rescued, finalOk }]
 *   summarize(points)                 { points, reads, readAccuracy, decisionAccuracy, okRate, rescueRate }
 *   pairFirstTries(champion, probe)   { pairs, b, c, n, pBetter, pWorse }
 *   firstTryHarm(t, rule)             the harm line, or null
 */

const { tally, DECISION_RULE } = require('./paired');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const r4 = x => Math.round(x * 10000) / 10000;
const rate = (k, n) => (n ? r4(k / n) : null);

function keyOf(r) {
  if (!isObj(r) || typeof r.bar !== 'string' || typeof r.side !== 'string') return null;
  return `${r.root || ''}|${r.bar}|${r.side}`;
}

/** The steps a try failed: its reads not verified, and the steps it didn't state (the check's own problem line). */
function failedSteps(r) {
  const out = new Set((Array.isArray(r.reads) ? r.reads : []).filter(x => isObj(x) && x.check !== true).map(x => x.step).filter(Boolean));
  for (const p of Array.isArray(r.problems) ? r.problems : []) {
    const m = /^steps not stated: ([a-z, ]+)/.exec(String(p));
    if (m) for (const s of m[1].split(', ').filter(Boolean)) out.add(s);
  }
  return [...out].sort();
}

function firstTries(records) {
  const by = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    const k = keyOf(r);
    if (!k) continue;
    by.set(k, [...(by.get(k) || []), r]);
  }
  return [...by].map(([key, list]) => {
    const tries = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const [first] = tries;
    const later = tries.slice(1);
    return {
      key, root: first.root, bar: first.bar, side: first.side,
      first: { ok: first.ok === true, reads: (first.reads || []).filter(isObj).map(x => ({ step: x.step, skill: x.skill, check: x.check === true })), failed: failedSteps(first) },
      tries: tries.length, rescued: first.ok !== true && later.some(x => x.ok === true), finalOk: tries[tries.length - 1].ok === true,
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

const allTrue = p => p.first.reads.length > 0 && p.first.reads.every(x => x.check);

function summarize(points) {
  const list = Array.isArray(points) ? points : [];
  const reads = list.flatMap(p => p.first.reads);
  return {
    points: list.length, reads: reads.length,
    readAccuracy: rate(reads.filter(x => x.check).length, reads.length),
    decisionAccuracy: rate(list.filter(allTrue).length, list.length),
    okRate: rate(list.filter(p => p.first.ok).length, list.length),
    rescueRate: rate(list.filter(p => p.rescued).length, list.length),
  };
}

function pairFirstTries(champion, probe) {
  const a = new Map((champion || []).map(p => [p.key, p]));
  const pairs = (probe || []).filter(p => a.has(p.key)).map(p => ({ base: { category: allTrue(a.get(p.key)) ? 'right' : 'false read' }, cand: { category: allTrue(p) ? 'right' : 'false read' } }));
  return { pairs: pairs.length, ...tally(pairs, r => r.category !== 'right') };
}

function firstTryHarm(t, rule = DECISION_RULE) {
  if (!(t && t.n >= rule.minDiscordant && t.c > t.b && t.pWorse <= rule.alpha)) return null;
  return `first-try reads worse (broken ${t.c}, fixed ${t.b} of ${t.pairs} points, p ${t.pWorse}): the edit leans on the hints`;
}

module.exports = { keyOf, firstTries, summarize, pairFirstTries, firstTryHarm };
