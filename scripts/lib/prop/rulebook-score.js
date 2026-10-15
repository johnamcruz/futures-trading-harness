'use strict';

/**
 * The account-policy search hook (docs/LEARNED-RULEBOOK.md R8-R10): score a candidate account layer on the model's
 * trade stream (prop/model-stream.js) through the same Monte Carlo (prop/evaluator.js), so a later search can tune
 * the account layer: the sizing, the soft daily stop, a stand-down near the max loss limit, the pacing, and size
 * multipliers on the record's facts. The search is not built here, and nothing here writes a RULEBOOK.md: a winner
 * is a proposed rulebook diff, adopted only with the owner's approval (R17, R25).
 *
 * A candidate (each value as RULEBOOK.md states it, checked by its own rules, trading/rulebook.js):
 *   sizing           every sizing key (cushion_frac, cap_usd, drawdown_halve_usd, min_size_guard, stop_slippage_ticks,
 *                    clock_k and r_per_session, the pacing), `off` where the rulebook allows it
 *   daily_loss_soft  dollars, or off: no new entries once the day is down this much (combine.entryBlock)
 *   stand_down       a share of the max loss limit, 0 to 1: no new entry while the cushion to the floor is under it
 *                    (0: none)
 *   multipliers      [{ item, fact, values }] as RULEBOOK.md's (item: an enforced rulebook item): each trade's size
 *                    times values[its fact's value] (rulebook.ceiling; a missing fact or value skips it: fails closed);
 *                    the facts are the trade's record context (regime, volatility, window, biasSide, alignment, dayType)
 *
 * The pass comes from checkModelWindow with candidateRulebook: true, which refuses test and final (a candidate is
 * tuned on practice-train and chosen on practice-validate; practice-validate scores are logged beside the run's look).
 *
 *   validateCandidate(candidate)                 problems (empty = valid)
 *   candidateRulebook(candidate, account)        { account (its soft stop the candidate's), rulebook: { sizing, multiplier, candidate } }
 *   scoreCandidate(stream, candidate, { pass, account, contracts, seed, paths, ... })   the evaluator's result, with the candidate
 */

const rb = require('../trading/rulebook');
const combine = require('../trading/combine');
const { scoreStream } = require('./evaluator');

const KEYS = Object.freeze(['sizing', 'daily_loss_soft', 'stand_down', 'multipliers']);
const isMap = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function validateCandidate(c) {
  if (!isMap(c)) return ['a candidate: { sizing, daily_loss_soft, stand_down, multipliers }'];
  const out = [];
  for (const k of Object.keys(c)) if (!KEYS.includes(k)) out.push(`${k}: unknown key (${KEYS.join(', ')})`);
  if (!isMap(c.sizing)) out.push(`sizing: every key stated (${rb.SIZING_KEYS.join(', ')})`);
  else {
    for (const k of Object.keys(c.sizing)) if (!rb.SIZING_KEYS.includes(k)) out.push(`sizing.${k}: unknown key`);
    for (const k of rb.SIZING_KEYS) {
      if (c.sizing[k] === undefined) out.push(`sizing.${k}: missing; state it (no code default)`);
      else if (!rb.SIZING_RULES[k][0](c.sizing[k])) out.push(`sizing.${k}: ${JSON.stringify(c.sizing[k])} is not ${rb.SIZING_RULES[k][1]}`);
    }
  }
  if (c.daily_loss_soft === undefined) out.push('daily_loss_soft: missing; state it (dollars, or off)');
  else if (!rb.SOFT_RULE[0](c.daily_loss_soft)) out.push(`daily_loss_soft: ${JSON.stringify(c.daily_loss_soft)} is not ${rb.SOFT_RULE[1]}`);
  if (!(typeof c.stand_down === 'number' && c.stand_down >= 0 && c.stand_down <= 1)) out.push('stand_down: a share of the max loss limit, 0 to 1 (0: none)');
  const enforced = Object.keys(rb.ITEMS).filter(k => rb.ITEMS[k].enforcedBy);
  out.push(...rb.multiplierErrors(c.multipliers, 'candidate', enforced).map(e => e.replace(/^policies\.candidate\./, '')));
  return out;
}

function candidateRulebook(c, account) {
  const problems = validateCandidate(c);
  if (problems.length) throw new Error(`candidate refused: ${problems.join('; ')}`);
  const sizing = Object.fromEntries(Object.entries(c.sizing).map(([k, v]) => [k, rb.limit(v)]));
  const acct = { ...account, daily_loss_soft: rb.limit(c.daily_loss_soft) };
  const floorRoom = c.stand_down * account.max_loss;
  const multiplier = (t, { cs }) => {
    if (c.stand_down > 0 && combine.cushion(cs) < floorRoom) return 0;
    if (!c.multipliers.length) return 1;
    const at = t.entryTime || new Date(0).toISOString();
    const facts = Object.fromEntries(Object.entries(t.facts || {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, { value: v, at }]));
    return rb.ceiling(c.multipliers, facts, new Date(at)).multiplier;
  };
  return { account: acct, rulebook: { sizing, multiplier, candidate: true } };
}

/** The candidate's Monte Carlo score on the stream; opts as prop/evaluator.js scoreStream (the pass a candidate pass). */
function scoreCandidate(stream, candidate, opts = {}) {
  const { account, rulebook } = candidateRulebook(candidate, opts.account);
  const result = scoreStream(stream, { ...opts, account, rulebook });
  return { ...result, candidate };
}

module.exports = { KEYS, validateCandidate, candidateRulebook, scoreCandidate };
