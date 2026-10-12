'use strict';

/**
 * The promotion gate: the bar a prop configuration must clear out of sample
 * before it trades live. Zero blows in every out-of-sample month, a pass rate
 * of at least minPassRate, on at least minAttempts attempts over minMonths
 * months. These numbers are frozen code, never part of anything learned or
 * configured: a caller may raise the pass-rate floor, never lower it, and
 * tests/lib/prop-promotion.test.js keeps them from falling.
 */

const PROMOTION_GATE = Object.freeze({ minPassRate: 0.4, maxBlows: 0, minAttempts: 20, minMonths: 2 });

/**
 * Why an out-of-sample result fails the promotion gate (empty = passes): too
 * few attempts or months, any blow in any month, or a pass rate under the
 * gate's minimum (or under a higher `minPassRate`). `minWinRate` adds an
 * optional win-rate floor. A missing or malformed result fails closed.
 * oos: { attempts, passed, blown, trades?, wins?, months: { 'YYYY-MM': { blown, ... } } }.
 */
function gateFailures(oos, minPassRate = PROMOTION_GATE.minPassRate, minWinRate = 0) {
  const G = PROMOTION_GATE;
  const whole = x => Number.isInteger(x) && x >= 0;
  if (!oos || typeof oos !== 'object' || !whole(oos.attempts) || !whole(oos.passed) || !whole(oos.blown) || !oos.months || typeof oos.months !== 'object' || Array.isArray(oos.months)) {
    return ['the out-of-sample result is missing or malformed'];
  }
  const out = [];
  const months = Object.entries(oos.months);
  if (oos.attempts < G.minAttempts || months.length < G.minMonths) {
    out.push(`too small an out-of-sample test (${oos.attempts} attempts over ${months.length} month(s); at least ${G.minAttempts} over ${G.minMonths})`);
  }
  if (months.some(([, m]) => !m || !whole(m.blown))) out.push('a month of the out-of-sample result has no blow count');
  const blownMonths = months.filter(([, m]) => m && m.blown > G.maxBlows).map(([k]) => k);
  if (oos.blown > G.maxBlows || blownMonths.length) out.push(`blows out of sample (${oos.blown}${blownMonths.length ? ` in ${blownMonths.join(', ')}` : ''}); zero blows is the rule`);
  // The exact rate, not the rounded one: 0.3996 is not 0.40. A lower floor never lowers the gate's.
  const floor = Math.max(G.minPassRate, Number(minPassRate) || 0);
  const rate = oos.attempts ? oos.passed / oos.attempts : 0;
  if (!(rate >= floor)) out.push(`pass rate ${Math.floor(rate * 1000) / 1000} (${oos.passed}/${oos.attempts}) is under ${floor}`);
  if (minWinRate > 0) {
    const winRate = whole(oos.trades) && whole(oos.wins) && oos.trades > 0 ? oos.wins / oos.trades : NaN;
    if (!(winRate >= minWinRate)) out.push(`win rate ${Number.isFinite(winRate) ? Math.floor(winRate * 1000) / 1000 : 'unknown'} is under ${minWinRate}`);
  }
  return out;
}

module.exports = { PROMOTION_GATE, gateFailures };
