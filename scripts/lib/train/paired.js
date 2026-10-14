'use strict';

/**
 * The training loop's paired test (docs/LEARNED-RULEBOOK.md R25, R26, R30 item 4): the champion
 * (baseline) and a challenger (candidate) decide the same decision points, from the same reference
 * states, with the same seeds and repeats; each pair is one point decided once by each. A challenger is
 * kept only with:
 *
 * - zero blows on its side (R25: zero blows, no exception);
 * - no failure category significantly worse (R26: a paired test per category, with a minimum count),
 *   and none worse by more than the stated tolerance (R30: McNemar "with a stated tolerance");
 * - a significant gain on what it targets: an exact one-sided McNemar test on the pairs where only one
 *   side failed a targeted category, with at least `minPairs` pairs, `minDiscordant` discordant ones
 *   and an effect of at least `minEffect` (the share of pairs fixed minus the share broken);
 * - every verifier that applies: a change to a strategy or the rulebook is mechanical and is screened
 *   by the evaluator first (R28), so without one (step 9 not built) it is `blocked`, never kept.
 *
 * DECISION_RULE is frozen code, like the promotion gate (prop/promotion.js): a loop's config may only
 * tighten it (ruleFrom), never loosen it. The LLM proposes; this code judges.
 *
 *   DECISION_RULE, ruleFrom(overrides)
 *   mcnemar(b, c)                         exact one-sided p: P(X >= b | n = b + c, 1/2)
 *   pairUp(baseline, candidate)          [{ key, base, cand }] by key and repeat (a missing candidate is a failure)
 *   judge({ pairs, targets, failures, rule, mechanical, evaluator })   { verdict, reasons, tests }
 */

const DECISION_RULE = Object.freeze({ alpha: 0.05, minPairs: 20, minDiscordant: 6, minEffect: 0.1, harmTolerance: 0.02 });
const NO_DECISION = 'no decision';

/** The rule with a config's overrides, each only tighter: alpha and the tolerance lower, the minimums higher. */
function ruleFrom(overrides = {}) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const out = { ...DECISION_RULE };
  const errors = [];
  for (const [k, v] of Object.entries(o)) {
    if (!(k in DECISION_RULE)) { errors.push(`decision.${k}: not a rule setting (${Object.keys(DECISION_RULE).join(', ')})`); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) { errors.push(`decision.${k}: a number`); continue; }
    const looser = k === 'alpha' || k === 'harmTolerance' ? v > DECISION_RULE[k] : v < DECISION_RULE[k];
    if (looser) errors.push(`decision.${k}: ${v} would loosen the frozen rule (${DECISION_RULE[k]}); it may only be tightened`);
    else out[k] = v;
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return Object.freeze(out);
}

/** log of n choose k. */
function logChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i += 1) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** Exact one-sided McNemar: the chance of b or more of the b + c discordant pairs going one way under no effect. */
function mcnemar(b, c) {
  const n = b + c;
  if (!(Number.isInteger(b) && Number.isInteger(c) && b >= 0 && c >= 0)) throw new Error('mcnemar: whole counts');
  if (n === 0) return 1;
  let p = 0;
  for (let x = b; x <= n; x += 1) p += Math.exp(logChoose(n, x) - n * Math.LN2);
  return Math.min(1, p);
}

const keyOf = r => `${r.key}#${r.repeat}`;

/**
 * Pairs by decision key and repeat. A baseline without a decision leaves the pair out (no reference); a candidate
 * without one is a failure (`no decision`): a change that stops the agent deciding never reads as a fix.
 */
function pairUp(baseline, candidate) {
  const cand = new Map((candidate || []).map(r => [keyOf(r), r]));
  return (baseline || []).filter(r => r && r.category && r.category !== NO_DECISION).map(r => ({
    key: keyOf(r), base: r, cand: cand.get(keyOf(r)) || { key: r.key, repeat: r.repeat, category: NO_DECISION, blow: false },
  }));
}

const round = x => Math.round(x * 10000) / 10000;

/** b (fixed), c (broken) and the test for one measure: `fails(record)` true when the record fails it. */
function tally(pairs, fails) {
  let b = 0;
  let c = 0;
  for (const p of pairs) {
    const fb = fails(p.base);
    const fc = fails(p.cand);
    if (fb && !fc) b += 1;
    else if (!fb && fc) c += 1;
  }
  return { b, c, n: b + c, effect: pairs.length ? round((b - c) / pairs.length) : 0, pBetter: round(mcnemar(b, c)), pWorse: round(mcnemar(c, b)) };
}

/**
 * The verdict: kept, rejected, blocked (a verifier that applies isn't available) or inconclusive (too few pairs
 * or discordant pairs to decide). `failures`: the failure categories (the scorecard's, without right/unchecked).
 * `mechanical`: the change touches a strategy or the rulebook. `evaluator`: { available, blows, failures } or null.
 */
function judge({ pairs, targets, failures, rule = DECISION_RULE, mechanical = false, evaluator = null }) {
  const reasons = [];
  const targetSet = new Set(targets || []);
  if (!targetSet.size) throw new Error('judge: a proposal names the failure categories it targets');
  const target = tally(pairs, r => targetSet.has(r.category) || r.category === NO_DECISION);
  const harm = {};
  const tol = Math.max(1, Math.floor(rule.harmTolerance * pairs.length));
  for (const k of [...new Set([...(failures || []), NO_DECISION])]) harm[k] = tally(pairs, r => r.category === k);
  const blows = pairs.filter(p => p.cand.blow === true).length;
  const tests = { pairs: pairs.length, target, harm, harmTolerance: tol, blows, rule };
  if (blows) reasons.push(`${blows} blow(s) on the candidate's side: zero blows, no exception`);
  for (const [k, t] of Object.entries(harm)) {
    if (t.c - t.b > tol) reasons.push(`${k}: ${t.c} decision(s) broken against ${t.b} fixed, worse by more than the tolerance (${tol})`);
    else if (t.n >= rule.minDiscordant && t.pWorse <= rule.alpha) reasons.push(`${k}: significantly worse (p ${t.pWorse})`);
  }
  if (reasons.length) return { verdict: 'rejected', reasons, tests };
  if (evaluator && evaluator.available) {
    if ((evaluator.blows || 0) > 0) return { verdict: 'rejected', reasons: [`the evaluator found ${evaluator.blows} blow(s)`], tests };
    if ((evaluator.failures || []).length) return { verdict: 'rejected', reasons: evaluator.failures.map(f => `evaluator: ${f}`), tests };
  } else if (mechanical) {
    return { verdict: 'blocked', reasons: [`a strategy or rulebook change is screened by the evaluator first (R28): ${(evaluator && evaluator.why) || 'none available'}`], tests };
  }
  if (pairs.length < rule.minPairs) return { verdict: 'inconclusive', reasons: [`${pairs.length} pairs; at least ${rule.minPairs}`], tests };
  if (target.n < rule.minDiscordant) return { verdict: 'inconclusive', reasons: [`${target.n} discordant pairs on the targeted measure; at least ${rule.minDiscordant}`], tests };
  if (target.effect < rule.minEffect) reasons.push(`effect ${target.effect} is under ${rule.minEffect}`);
  if (target.pBetter > rule.alpha) reasons.push(`no significant gain on the targeted measure (p ${target.pBetter} > ${rule.alpha})`);
  if (reasons.length) return { verdict: 'rejected', reasons, tests };
  return { verdict: 'kept', reasons: [`fixed ${target.b}, broke ${target.c} of ${pairs.length} pairs (effect ${target.effect}, p ${target.pBetter})`], tests };
}

module.exports = { DECISION_RULE, NO_DECISION, ruleFrom, mcnemar, pairUp, tally, judge };
