'use strict';

/**
 * Natural frequency for a curated practice run. A curated run replays setups picked from lists (the curated scan), so
 * its trades come far more often per day than they would live: scored as they stand, a combine attempt would pass on
 * a trade rate no live day gives. This module rebuilds days at each list's natural rate, so the Monte Carlo
 * (prop/evaluator.js) sees the model's own decisions on those setups at the frequency live would bring them. The
 * score of such a stream is `diagnostic (reweighted)`, never a promotion score (prop/promotion.js refuses it);
 * full-day runs need no weights and are the real score.
 *
 * Input (one of):
 *   rates     { <list>: { candidatesPerDay } }: for each list, the candidates per trading day the curated scan found
 *             over the history it scanned (its candidate count over its trading days). A list's candidates in the
 *             run are its composed decisions (entered, passed, refused); a plain pass composed nothing, so it is no
 *             candidate. Each trade of list L stands for candidatesPerDay(L) / candidates(L) occurrences per natural
 *             day, so a day holds, per list, the model's own take rate on that list's candidates times the natural
 *             candidate rate. Every list the run's decisions name must have a rate (else refused: its frequency is
 *             unknown); a list with a rate and no candidate in the run is reported `unsampled`.
 *   weights   { <decision id>: w }: each trade's natural occurrences per occurrence in the run (1: as often as the run
 *             had it; 0.2: a fifth as often). A trade without a weight is refused.
 * A decision's list: listOf(decision), by default its `list`; with a single list in `rates`, every composed decision
 * without one is that list's.
 *
 * Rebuilt days: `days` days (default 252); on each, the number of trades is Poisson with the stream's natural trades per
 * day, each drawn in proportion to its rate (with its overshoot, adverse and no-stop paths, as filled), in the time
 * order they were filled. Seeded: the same stream, input and seed, the same days. The days are labelled R0001, ...
 * (not session dates: there is no calendar to hold them to), their regime 'normal'.
 *
 *   validateRates(rates)   problems (empty = valid)
 *   naturalRates(stream, decisions, { rates, weights, listOf })   { perTrade: Map id -> rate, tradesPerDay, lists, unsampled }
 *   reweightStream(stream, decisions, { rates, weights, listOf, days, seed })   the reweighted stream (`reweighted` set)
 */

const { streamFor } = require('./stats');

const isMap = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function validateRates(rates) {
  if (!isMap(rates) || !Object.keys(rates).length) return ['rates: { <list>: { candidatesPerDay } }, at least one list'];
  const out = [];
  for (const [k, v] of Object.entries(rates)) {
    if (!isMap(v)) { out.push(`rates.${k}: { candidatesPerDay }`); continue; }
    for (const key of Object.keys(v)) if (key !== 'candidatesPerDay') out.push(`rates.${k}.${key}: unknown key (candidatesPerDay)`);
    if (!(typeof v.candidatesPerDay === 'number' && Number.isFinite(v.candidatesPerDay) && v.candidatesPerDay >= 0)) out.push(`rates.${k}.candidatesPerDay: a number of candidates per trading day, 0 or more`);
  }
  return out;
}

function naturalRates(stream, decisions, { rates = null, weights = null, listOf = d => d.list ?? null } = {}) {
  if (Boolean(rates) === Boolean(weights)) throw new Error('natural rates: give rates ({ <list>: { candidatesPerDay } }) or weights ({ <decision id>: w }), one of them');
  const days = stream.days.length;
  if (!days) throw new Error('natural rates: the run has no days');
  const perTrade = new Map();
  if (weights) {
    if (!isMap(weights)) throw new Error('weights: { <decision id>: w }');
    for (const t of stream.trades) {
      const w = weights[t.id];
      if (!(typeof w === 'number' && Number.isFinite(w) && w >= 0)) throw new Error(`weights: trade ${t.id} has no weight (a number, 0 or more)`);
      perTrade.set(t.id, w / days);
    }
    return { perTrade, tradesPerDay: [...perTrade.values()].reduce((a, x) => a + x, 0), lists: null, unsampled: [] };
  }
  const problems = validateRates(rates);
  if (problems.length) throw new Error(`natural rates: ${problems.join('; ')}`);
  const names = Object.keys(rates);
  const only = names.length === 1 ? names[0] : null;
  const listOfD = d => listOf(d) ?? only;
  const composed = decisions.filter(d => d && d.decision !== 'none');
  const unknown = [...new Set(composed.map(listOfD).filter(l => !Object.hasOwn(rates, l)))];
  if (unknown.length) throw new Error(`natural rates: no rate for ${unknown.map(String).join(', ')} (every list the run's decisions name needs its candidatesPerDay)`);
  const lists = {};
  for (const L of names) {
    const cands = composed.filter(d => listOfD(d) === L);
    lists[L] = { candidatesPerDay: rates[L].candidatesPerDay, candidates: cands.length, entered: cands.filter(d => d.decision === 'entered').length };
  }
  const byId = new Map(composed.map(d => [d.id, d]));
  for (const t of stream.trades) {
    const d = byId.get(t.id);
    if (!d) throw new Error(`natural rates: trade ${t.id} has no decision in the run`);
    const L = listOfD(d);
    perTrade.set(t.id, lists[L].candidatesPerDay / lists[L].candidates);
  }
  for (const v of Object.values(lists)) v.tradesPerDay = v.candidates ? Math.round((v.candidatesPerDay * v.entered / v.candidates) * 1e6) / 1e6 : 0;
  return {
    perTrade, tradesPerDay: [...perTrade.values()].reduce((a, x) => a + x, 0), lists,
    unsampled: names.filter(L => lists[L].candidates === 0 && lists[L].candidatesPerDay > 0),
  };
}

/** A Poisson draw (Knuth), in chunks so a large mean never underflows. */
function poisson(rand, mean) {
  let n = 0;
  let left = mean;
  while (left > 0) {
    const m = Math.min(left, 30);
    left -= m;
    const L = Math.exp(-m);
    let p = 1;
    for (;;) { p *= rand(); if (p <= L) break; n += 1; }
  }
  return n;
}

function reweightStream(stream, decisions, { rates = null, weights = null, listOf, days = 252, seed = 1 } = {}) {
  if (!(Number.isInteger(days) && days >= 1)) throw new Error('days: a whole number of rebuilt days, 1 or more');
  if (!Number.isInteger(seed)) throw new Error('seed: a whole number');
  const nat = naturalRates(stream, decisions, { rates, weights, ...(listOf ? { listOf } : {}) });
  const pool = stream.trades.filter(t => nat.perTrade.get(t.id) > 0);
  const cum = [];
  let total = 0;
  for (const t of pool) { total += nat.perTrade.get(t.id); cum.push(total); }
  const rand = streamFor(seed, 'natural-rate');
  const draw = () => {
    const x = rand() * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] > x) hi = mid; else lo = mid + 1; }
    return pool[lo];
  };
  const minuteOf = t => { const ms = Date.parse(t.entryTime); return Number.isFinite(ms) ? ((ms % 86400000) + 86400000 - 22 * 3600000) % 86400000 : 0; };
  const out = [];
  for (let k = 0; k < days; k += 1) {
    const day = `R${String(k + 1).padStart(4, '0')}`;
    const n = total > 0 ? poisson(rand, total) : 0;
    const picked = Array.from({ length: n }, draw).sort((a, b) => minuteOf(a) - minuteOf(b));
    out.push({ day, month: 'reweighted', regime: 'normal', trades: picked.map((t, seq) => ({ ...t, day, seq })) });
  }
  return {
    ...stream, days: out, trades: out.flatMap(d => d.trades),
    reweighted: { days, seed, tradesPerDay: Math.round(total * 1e6) / 1e6, lists: nat.lists, unsampled: nat.unsampled, by: rates ? 'rates' : 'weights', runTrades: stream.trades.length, runDays: stream.days.length },
  };
}

module.exports = { validateRates, naturalRates, reweightStream, poisson };
