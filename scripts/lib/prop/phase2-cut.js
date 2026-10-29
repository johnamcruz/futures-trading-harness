'use strict';

/**
 * Phase 2's cut of a prop entry's translated size (owner-approved, 2026-10-28, "option 2"; the owner: "make sure this
 * sizing update doesn't hurt prop goals", "shouldn't size up if it's on a 3x losing streak"). The translated size
 * (prop/size-translate.js) is the verdict's: sized from the attempt's budget (the cushion above the trailing floor, its
 * cushion_frac share, the cap, the drawdown halving, the floor stretch only while healthy, the composed risk cap, the
 * broker's max). Phase 2 may cut it; a cut stands whenever the account is not healthy by the pacing rules the skills
 * teach (prop-challenge-pacing "Read the attempt line", position-sizing step 6), each a condition code verifies from the
 * attempt's facts (combine.attemptFacts on the runner's latest snapshot: what combine_status and the attempt line show):
 *
 *   after-loss  a losing trade closed today as the snapshot counts it (lossesToday >= 1: prop-state.js dayCounts, the
 *               closing fills since the day's first flat snapshot plus the counts carried into the day; a loss
 *               before that anchor and not carried isn't in it, though its P&L still shows as a drawdown)
 *   streak      a losing streak open (lossStreak >= 1: the session's, prop-state.js recordStreak; one loss short of
 *               loss_streak_stop and past it alike)
 *   drawdown    the balance under the attempt's start or under its peak (near the floor: the cushion is under the
 *               trailing max loss; the verdict's drawdown halving reads the same peak, combine.budget)
 *   soft-stop   one loss at the translated size reaches daily_loss_soft or the daily limit (softRoom or dailyRoom at or
 *               under its risk)
 *   target      near the target: the profit the pass still needs at most the policy's sizing.near_target_usd (the
 *               band the size translation trades the floor in: combine.nearTarget; off: never)
 *
 * Facts that can't be read (no snapshot, today's counts unknown) are no healthy account: the cut stands. Only a cut on a
 * healthy account (no rule holds) is restored to the translated size, never more: it is a process note, never a refusal.
 * A veto is never a cut. The rule phase 2 names on its Size line (`Size: 4 (after-loss)`) is recorded with the outcome.
 *
 *   RULES                         the rule names, in the order above
 *   namedRules(text, size)        the rules named on line-start Size lines stating exactly `size`
 *   cutFacts({ home, account, policy, now })   the facts above (with the policy's near-target band), or null (no
 *                                 attempt or no snapshot)
 *   rulesHolding(facts, riskUsd)  the rules whose condition holds ('unknown' for facts that can't be read)
 *   phase2Cut({ approved, base, facts, riskUsd, named })
 *       { size, cut: false } | { size: approved, cut: true, held, named } | { size: base, cut: true, restored: { from, to, named, note } }
 */

const RULES = Object.freeze(['after-loss', 'streak', 'drawdown', 'soft-stop', 'target']);

// A line-start Size line (as roles-ran.js SIZE_LINE: markup, a bullet or a number before it) stating a whole size, then
// a parenthesis: its first word is the rule named.
const SIZE_RULE = /^[ \t>]*(?:(?:[-*+]|\d+[.)])[ \t]+)?[*_]*Size[*_]*[ \t]*[:=][*_ \t]*0*([1-9]\d*)[*_]*[ \t]*\(\s*([a-z-]+)/i;

function namedRules(text, size) {
  const out = [];
  for (const line of String(text || '').replace(/\r\n|[\r\u2028\u2029\u0085]/g, '\n').split('\n')) {
    const m = SIZE_RULE.exec(line);
    const rule = m ? m[2].toLowerCase() : null;
    if (m && Number(m[1]) === size && RULES.includes(rule) && !out.includes(rule)) out.push(rule);
  }
  return out;
}

const num = x => typeof x === 'number' && Number.isFinite(x);
const count = x => (Number.isInteger(x) && x >= 0 ? x : null);

function cutFacts({ home, account, policy = null, now = new Date() }) {
  if (!home || !account || account.valid === false) return null;
  const prop = require('../trading/prop-state');
  const combine = require('../trading/combine');
  const r = prop.readAttempt(home, account.name);
  if (!r || !r.snapshot || !num(r.snapshot.balance)) return null;
  const cs = prop.stateFrom(account, r, r.snapshot.balance);
  const streak = prop.sessionLossStreak(home, account, now);
  const f = combine.attemptFacts(cs, { ...prop.attemptCounts(r, now), lossStreak: streak ? streak.count : null });
  const band = policy && policy.sizing ? policy.sizing.near_target_usd : null;
  return { balance: cs.balance, start: cs.start, peak: cs.peak, lossesToday: f.lossesToday, lossStreak: f.lossStreak, softRoom: f.softRoom, dailyRoom: f.dailyRoom, needed: f.needed, nearTargetUsd: num(band) ? band : null };
}

function rulesHolding(facts, riskUsd) {
  if (!facts || typeof facts !== 'object' || !(num(riskUsd) && riskUsd > 0)) return ['unknown'];
  const f = facts;
  const losses = count(f.lossesToday);
  const streak = count(f.lossStreak);
  if (losses === null || streak === null || !num(f.balance) || !num(f.start) || !num(f.peak)) return ['unknown'];
  const within = room => num(room) && room <= riskUsd;
  const held = {
    'after-loss': losses >= 1,
    streak: streak >= 1,
    drawdown: f.balance < f.start || f.balance < f.peak,
    'soft-stop': within(f.softRoom) || within(f.dailyRoom),
    target: num(f.needed) && num(f.nearTargetUsd) && f.nearTargetUsd > 0 && f.needed <= f.nearTargetUsd + 1e-9,
  };
  return RULES.filter(k => held[k]);
}

function phase2Cut({ approved, base, facts, riskUsd, named = [] }) {
  if (!(Number.isInteger(approved) && approved >= 1 && Number.isInteger(base) && base >= 1)) return { size: null, cut: false };
  if (approved >= base) return { size: base, cut: false };
  const held = rulesHolding(facts, riskUsd);
  if (held.length) return { size: approved, cut: true, held, named };
  return { size: base, cut: true, restored: { from: approved, to: base, named, note: `phase-2 cut ${approved} -> ${base}: no pacing rule applies` } };
}

module.exports = { RULES, namedRules, cutFacts, rulesHolding, phase2Cut };
