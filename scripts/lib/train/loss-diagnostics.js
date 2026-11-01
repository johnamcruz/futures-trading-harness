'use strict';

/**
 * The round report's loss diagnostics (docs/TRAINING.md, "The mastery read"): whether losers stay at -1R, whether the
 * win rate clears its break-even line, which entry kinds drag it (chop), and the exits that cut a trend or gave one
 * back, side by side. Report only: no screen, keep rule, promotion, proposer or model prompt reads them (a test keeps the
 * decision modules from importing this one); the pass rate with 0 blows still decides.
 *
 *   losersPastOne(exits, { toleranceR })   the losing trades past -1R, on one side's scored exits (exit-scorecard.js
 *                          decisions as probe.js keeps them: { side, entryAt, exitBy, r, fill }), or null when unknown:
 *     n, losers           the exits with a known R; those below 0
 *     past, share         the losers with R < -1 - tolerance; past / losers (null with no loser)
 *     worstR              the lowest loser's R (null with no loser)
 *     byTick, byConfig    how many losers' tolerance was one tick in R (fill.tickR), how many the config's
 *                         (config/training.json trendReport.loserToleranceR: the tick unknown)
 *     causes              { cause: n } over the past ones; trades: each past one { entryAt, side, exitBy, r, toleranceR, cause }
 *   causeOf(exit, toleranceR)   why a loser went past -1R, from its fill facts only (exit-scorecard.js fill: in R):
 *     'stop beyond the initial risk'   a stop exit whose working stop was itself past -1R (moved away from the entry)
 *     'gap through the stop'           a stop exit whose fill bar opened beyond the stop
 *     'stop slippage'                  a stop exit filled beyond the stop, its bar opening inside it
 *     'exit not at the stop'           the model's or the runner's close, or the target
 *     'unknown'                        anything the facts can't tell (an unattributed exit, a price or bar unknown, a fill
 *                                      at the stop whose R is still past -1R): never guessed
 *   breakEven(risk)        the win rate against its break-even line, from risk-stats.js riskStats: with the average loss as
 *                          one unit, a trade wins payoff units or loses one, so the line is 1 / (1 + payoff); { winRate,
 *                          payoff, breakEven, marginPp: (winRate - breakEven) in percentage points, below: margin < 0 }
 *                          (nulls where the payoff is unknown: no win or no loss), or null without the stats
 *   chopDrag(entries, { falseStartPeakR, smallN })   the filled entries (probe.js entryRowsOf) split by their entry read
 *                          (entry-reaction.js): byReaction { label: bucket } and byLevel { key, 'not key', 'no level':
 *                          bucket }, each bucket { n, meanR, winRate, falseStarts, of, falseStartShare, legsCaught,
 *                          small }: R and the win rate over the known R; a false start a loser whose peak R never rose
 *                          above falseStartPeakR (curriculum.js's definition), of the entries with both known; legs caught
 *                          the distinct legs entered their way (kind in-trend); small when n < smallN (no conclusion).
 *                          coverage { entries, recorded (a compose record joined), reaction (the briefing's label known) };
 *                          null when unknown
 *   exitTotals(summary)    the exit scorecard's cut-a-trend and late totals over every exit kind (exit-scorecard.js
 *                          summarize): { n, cut, leftR, late, givebackR }, or null
 *   diagnostics({ exits, entries, risk })   { losers, breakEven, chop, exits } of one side (the config's values)
 *   lossLines(loss, label)  the report's lines of one side
 */

const ES = require('../replay/exit-scorecard');
const { round4 } = require('../prop/stats');

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const mean = xs => (xs.length ? round4(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

// The owner's order for the reaction buckets (candle-reaction.js REACTIONS), then the reads without one.
const REACTION_ORDER = ['confirmed rejection', 'breakout', 'engulfing rejection', 'long-wick rejection', 'conflicting', 'stall', 'plain', 'none', 'unknown', 'not recorded'];
const LEVEL_ORDER = ['key', 'not key', 'no level'];
const CLOSES = new Set(['model-exit', 'runner-exit', 'target']);

function causeOf(e, toleranceR) {
  if (!isObj(e)) return 'unknown';
  if (CLOSES.has(e.exitBy)) return 'exit not at the stop';
  if (!ES.STOP_EXITS.includes(e.exitBy)) return 'unknown';
  const f = isObj(e.fill) ? e.fill : {};
  const stop = num(f.stopR);
  if (stop === null) return 'unknown';
  if (stop < -1 - toleranceR) return 'stop beyond the initial risk';
  const price = num(f.priceR);
  const open = num(f.openR);
  if (price === null || price >= stop) return 'unknown';
  if (open === null) return 'unknown';
  return open < stop ? 'gap through the stop' : 'stop slippage';
}

function losersPastOne(exits, { toleranceR }) {
  if (num(toleranceR) === null) throw new Error('losersPastOne: toleranceR (config/training.json trendReport.loserToleranceR)');
  if (!Array.isArray(exits)) return null;
  const known = exits.filter(e => isObj(e) && num(e.r) !== null);
  const losers = known.filter(e => e.r < 0);
  let byTick = 0;
  const tolOf = e => {
    const t = num(isObj(e.fill) ? e.fill.tickR : null);
    if (t !== null && t > 0) { byTick += 1; return t; }
    return toleranceR;
  };
  const marked = losers.map(e => ({ e, tol: tolOf(e) }));
  const past = marked.filter(x => x.e.r < -1 - x.tol);
  const trades = past.map(({ e, tol }) => ({ entryAt: e.entryAt || null, side: e.side || null, exitBy: e.exitBy || null, r: e.r, toleranceR: round4(tol), cause: causeOf(e, tol) }));
  const causes = {};
  for (const t of trades) causes[t.cause] = (causes[t.cause] || 0) + 1;
  return {
    n: known.length, unknown: exits.length - known.length, losers: losers.length, past: past.length,
    share: losers.length ? round4(past.length / losers.length) : null,
    worstR: losers.length ? Math.min(...losers.map(e => e.r)) : null,
    byTick, byConfig: losers.length - byTick, toleranceR, causes, trades,
  };
}

function breakEven(risk) {
  if (!isObj(risk)) return null;
  const winRate = num(risk.winRate);
  const payoff = num(risk.payoff);
  const be = payoff !== null && payoff > 0 ? round4(1 / (1 + payoff)) : null;
  const margin = be !== null && winRate !== null ? round4((winRate - be) * 100) : null;
  return { winRate, payoff, breakEven: be, marginPp: margin, below: margin === null ? null : margin < 0 };
}

function bucketOf(list, { falseStartPeakR, smallN }) {
  const rs = list.map(e => num(e.r)).filter(r => r !== null);
  const both = list.filter(e => num(e.r) !== null && num(e.peakR) !== null);
  const fs = both.filter(e => e.r < 0 && e.peakR <= falseStartPeakR).length;
  return {
    n: list.length, meanR: mean(rs), winRate: rs.length ? round4(rs.filter(r => r > 0).length / rs.length) : null,
    falseStarts: fs, of: both.length, falseStartShare: both.length ? round4(fs / both.length) : null,
    legsCaught: new Set(list.filter(e => e.kind === 'in-trend' && e.leg).map(e => e.leg)).size,
    small: list.length < smallN,
  };
}

function groupBy(list, keyOf, order, opts) {
  const groups = new Map();
  for (const e of list) { const k = keyOf(e); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  const keys = [...groups.keys()].sort((a, b) => (order.indexOf(a) < 0 ? order.length : order.indexOf(a)) - (order.indexOf(b) < 0 ? order.length : order.indexOf(b)));
  return Object.fromEntries(keys.map(k => [k, bucketOf(groups.get(k), opts)]));
}

function chopDrag(entries, { falseStartPeakR, smallN }) {
  if (num(falseStartPeakR) === null || num(smallN) === null) throw new Error('chopDrag: falseStartPeakR and smallN (config/training.json trendReport)');
  if (!Array.isArray(entries)) return null;
  const list = entries.filter(isObj);
  const readOf = e => (isObj(e.read) ? e.read : { reaction: 'not recorded', keyLevel: null });
  const opts = { falseStartPeakR, smallN };
  return {
    coverage: { entries: list.length, recorded: list.filter(e => readOf(e).reaction !== 'not recorded').length, reaction: list.filter(e => !['not recorded', 'unknown'].includes(readOf(e).reaction)).length },
    byReaction: groupBy(list, e => readOf(e).reaction || 'unknown', REACTION_ORDER, opts),
    byLevel: groupBy(list, e => (readOf(e).keyLevel === true ? 'key' : readOf(e).keyLevel === false ? 'not key' : 'no level'), LEVEL_ORDER, opts),
  };
}

function exitTotals(summary) {
  if (!isObj(summary) || !isObj(summary.byExit)) return null;
  const rows = Object.values(summary.byExit).filter(isObj);
  const add = k => round4(rows.reduce((a, x) => a + (num(x[k]) || 0), 0));
  return { n: add('n'), cut: add('cut'), leftR: add('leftR'), late: add('late'), givebackR: add('givebackR') };
}

function diagnostics({ exits = null, entries = null, risk = null } = {}) {
  const T = require('../tunables').training().trendReport;
  return {
    losers: losersPastOne(exits, { toleranceR: T.loserToleranceR }),
    breakEven: breakEven(risk),
    chop: chopDrag(entries, { falseStartPeakR: T.falseStartPeakR, smallN: T.smallN }),
    // The exit scorecard's own totals on this side's scored exits (cut a trend with R left; late past the lock).
    exits: Array.isArray(exits) ? exitTotals(ES.summarize({ decisions: exits.filter(e => isObj(e) && ES.CLASSES.includes(e.cls)).map(e => ({ ...e, leftR: num(e.leftR), lateR: num(e.lateR) })) })) : null,
  };
}

const show = x => (num(x) === null ? 'n/a' : String(x));
const pct = x => (num(x) === null ? 'n/a' : `${round4(x * 100)}%`);

function losersText(l) {
  if (!l) return 'n/a (exits unknown)';
  if (!l.losers) return `none of ${l.n} trade(s) lost`;
  const causes = Object.entries(l.causes).map(([k, v]) => `${k} ${v}`).join(', ');
  return `${l.past} of ${l.losers} loser(s) (${pct(l.share)}) past -1R, worst ${l.worstR}R (tolerance one tick in R on ${l.byTick}, ${l.toleranceR}R on ${l.byConfig}: tick unknown)${causes ? `; cause: ${causes}` : ''}${l.trades.length ? `; ${l.trades.map(t => `${t.entryAt || '?'} ${t.side || '?'} ${t.r}R ${t.cause}`).join(', ')}` : ''}`;
}

function breakEvenText(b) {
  if (!b) return 'n/a (trades unknown)';
  if (b.breakEven === null) return `win rate ${pct(b.winRate)}, break-even n/a (payoff ${show(b.payoff)}: needs a win and a loss)`;
  return `win rate ${pct(b.winRate)} vs break-even ${pct(b.breakEven)} (1 / (1 + payoff ${b.payoff}), |avg loss| = 1 unit): margin ${b.marginPp >= 0 ? '+' : ''}${b.marginPp}pp${b.below ? ', BELOW BREAK-EVEN' : ''}`;
}

const bucketText = (k, b) => `${k} n ${b.n}: ${show(b.meanR)}R a trade, win ${pct(b.winRate)}, false starts ${b.falseStarts}/${b.of}, legs caught ${b.legsCaught}${b.small ? ' (small n, no conclusion)' : ''}`;

function lossLines(loss, label) {
  if (!isObj(loss)) return [];
  const c = loss.chop;
  const e = loss.exits;
  return [
    `    ${label}, losers past -1R: ${losersText(loss.losers)}`,
    `    ${label}, win rate vs break-even: ${breakEvenText(loss.breakEven)}`,
    ...(c ? [
      `    ${label}, chop drag by reaction (${c.coverage.recorded} of ${c.coverage.entries} entries joined to a compose record, ${c.coverage.reaction} read: the briefing's reaction, or no reaction read): ${Object.entries(c.byReaction).map(([k, b]) => bucketText(k, b)).join('; ') || 'no entry'}`,
      `    ${label}, chop drag by level: ${Object.entries(c.byLevel).map(([k, b]) => bucketText(k, b)).join('; ') || 'no entry'}`,
    ] : [`    ${label}, chop drag: n/a (entries unknown)`]),
    `    ${label}, exits: ${e ? `cut a trend ${e.cut} of ${e.n} (${e.leftR}R left), late ${e.late} (${e.givebackR}R given back past the lock)` : 'n/a (exits unknown)'}`,
  ];
}

module.exports = { REACTION_ORDER, LEVEL_ORDER, causeOf, losersPastOne, breakEven, chopDrag, exitTotals, diagnostics, lossLines };
