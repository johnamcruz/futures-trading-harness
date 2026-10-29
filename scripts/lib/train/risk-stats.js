'use strict';

/**
 * The round report's risk and return diagnostics (docs/TRAINING.md, "The mastery read"): on one side's trades, in the
 * order they were opened, each trade's R as the scorecard records it (replay/scorecard.js: a flat decision's filled
 * trade, `trade.r`): the broker's round-trip R when it sends one, else P&L over the initial risk before fees; a win here
 * is R > 0, which can differ from the scorecard's net result. Report only: no screen, keep rule, promotion, proposer or model prompt reads them (a test keeps
 * the decision modules from importing this one); the pass rate with 0 blows still decides.
 *
 *   tradesOf(decisions)      [{ t, r }] the trades among a run's scorecard decisions (train/loop.js scorecardDecisions:
 *                            `trade` null or { r }), in time order; null (unknown) when there are none to read or a decision predates the field
 *   riskStats(trades)        { n, unknown, expectancy, winRate, avgWin, avgLoss, payoff, profitFactor, maxDrawdownR,
 *                            longestLosingStreak, sortino, sharpe }, or null when the trades are unknown. n counts the
 *                            trades with a known R; unknown those without (an open trade). A win is R above 0, a loss
 *                            R below 0 (a scratch is neither, and ends a losing streak).
 *     expectancy             the mean R a trade (null with no trade)
 *     winRate                wins / n
 *     avgWin, avgLoss        the mean R of the wins, of the losses (negative); null with none
 *     payoff                 avgWin / |avgLoss|; null without both
 *     profitFactor           gross win R / gross loss R; null with no loss (never Infinity)
 *     maxDrawdownR           the largest fall of the cumulative R from its running peak (0 at the start), as a size
 *     longestLosingStreak    the most losses in a row
 *     sortino                mean R / downside deviation (sqrt of the mean over all n of min(R, 0)^2); null with
 *                            n < 2 or no loss
 *     sharpe                 mean R / standard deviation of R (the sample's, n - 1); null with n < 2 or every R equal
 *                            Both per trade, not annualized.
 *   riskText(s)              one line of it ("n/a" where a value is null, never Infinity or NaN)
 */

const { round4 } = require('../prop/stats');

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = xs => xs.reduce((a, b) => a + b, 0);

function tradesOf(decisions) {
  if (!Array.isArray(decisions)) return null;
  const list = decisions;
  if (list.some(d => !d || !Object.prototype.hasOwnProperty.call(d, 'trade'))) return null;
  const out = list.map((d, i) => ({ d, i })).filter(x => x.d.trade && typeof x.d.trade === 'object');
  // Time order (a run's decisions, several runs' concatenated); the given order breaks a tie.
  out.sort((a, b) => (String(a.d.t) < String(b.d.t) ? -1 : String(a.d.t) > String(b.d.t) ? 1 : a.i - b.i));
  return out.map(x => ({ t: x.d.t === undefined ? null : x.d.t, r: num(x.d.trade.r) }));
}

function riskStats(trades) {
  if (!Array.isArray(trades)) return null;
  const rs = trades.map(x => num(x && typeof x === 'object' ? x.r : x)).filter(r => r !== null);
  const n = rs.length;
  const wins = rs.filter(r => r > 0);
  const losses = rs.filter(r => r < 0);
  const m = mean(rs);
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  const grossLoss = -sum(losses);
  let peak = 0;
  let cum = 0;
  let dd = 0;
  let streak = 0;
  let longest = 0;
  for (const r of rs) {
    cum += r;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
    streak = r < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  // Every R equal: no deviation (said exactly, never a rounding residue's huge ratio).
  const sd = n > 1 && rs.some(r => r !== rs[0]) ? Math.sqrt(rs.reduce((a, r) => a + (r - m) ** 2, 0) / (n - 1)) : null;
  const down = n > 1 && losses.length ? Math.sqrt(rs.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / n) : null;
  return {
    n, unknown: trades.length - n,
    expectancy: round4(m), winRate: n ? round4(wins.length / n) : null,
    avgWin: round4(avgWin), avgLoss: round4(avgLoss),
    payoff: avgWin !== null && avgLoss !== null ? round4(avgWin / -avgLoss) : null,
    profitFactor: grossLoss > 0 ? round4(sum(wins) / grossLoss) : null,
    maxDrawdownR: n ? round4(dd) : null,
    longestLosingStreak: n ? longest : null,
    sortino: down ? round4(m / down) : null,
    sharpe: sd ? round4(m / sd) : null,
  };
}

const show = x => (num(x) === null ? 'n/a' : String(x));
const showR = x => (num(x) === null ? 'n/a' : `${x}R`);
const pct = x => (num(x) === null ? 'n/a' : `${round4(x * 100)}%`);

function riskText(s) {
  if (!s) return 'n/a (trades unknown)';
  return `n ${s.n}${s.unknown ? ` (${s.unknown} without an R)` : ''}, expectancy ${showR(s.expectancy)} a trade, win rate ${pct(s.winRate)}, avg win ${showR(s.avgWin)}, avg loss ${showR(s.avgLoss)}, payoff ${show(s.payoff)}, profit factor ${show(s.profitFactor)}, max drawdown ${showR(s.maxDrawdownR)}, longest losing streak ${show(s.longestLosingStreak)}, Sortino ${show(s.sortino)}, Sharpe ${show(s.sharpe)} (per trade, not annualized; R: the broker's round-trip R when it sends one, else P&L over the initial risk before fees; a win here is R > 0, which can differ from the scorecard's net result)`;
}

module.exports = { tradesOf, riskStats, riskText };
