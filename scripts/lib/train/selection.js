'use strict';

/**
 * Selection value (Propose-Probe-Compose, docs/TRAINING.md): does the model take the better of the scan's reactions?
 * The curated scan's moments (learning/curated-moments.js) are every reaction at a key level with the standard trade's
 * outcome on the bars (`standard.status` traded, `outcome.R`: the mechanical plan's own result, the same whoever looks).
 * On a run's sessions, a reaction is taken when the model placed an entry its side (the run home's entry orders) from
 * the reaction bar's close until its entry window ends (the moment's validBars base bars); else passed. Selection value
 * is the taken reactions' mean R minus the passed ones': about 0 is no selection skill, above it is picking the better
 * ones. Code only, from what the scan and the run recorded; a report, never a gate.
 *
 *   reactionsOf(moments, { days })           [{ day, bar, side, R, minutes, validBars }]: the scan's traded reactions on
 *                                            those session days
 *   entriesOf(orders)                        [{ at, side }] from a run home's entry orders (buy: long, sell: short)
 *   selectionOf(reactions, entries)          { reactions, taken: { n, meanR }, passed: { n, meanR }, value }
 */

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const mean = xs => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10000) / 10000 : null);

function reactionsOf(moments, { days }) {
  const keep = new Set(days || []);
  return (Array.isArray(moments) ? moments : []).filter(m => isObj(m) && keep.has(m.day) && isObj(m.standard) && m.standard.status === 'traded' && isObj(m.outcome) && num(m.outcome.R) !== null && (m.side === 'long' || m.side === 'short'))
    .map(m => ({ day: m.day, bar: m.bar, side: m.side, R: m.outcome.R, minutes: m.minutes, validBars: m.validBars }));
}

function entriesOf(orders) {
  const sideOf = o => (isObj(o.composed) && o.composed.side) || (o.side === 'buy' ? 'long' : o.side === 'sell' ? 'short' : null);
  return (Array.isArray(orders) ? orders : []).filter(o => isObj(o) && Number.isFinite(Date.parse(o.at))).map(o => ({ at: o.at, side: sideOf(o) })).filter(e => e.side);
}

function selectionOf(reactions, entries) {
  const took = r => {
    const step = Number(r.minutes) * 60000;
    const from = Date.parse(r.bar) + step;
    const to = from + step * (Number(r.validBars) || 1);
    return (entries || []).some(e => e.side === r.side && Date.parse(e.at) >= from && Date.parse(e.at) < to);
  };
  const taken = (reactions || []).filter(took).map(r => r.R);
  const passed = (reactions || []).filter(r => !took(r)).map(r => r.R);
  const t = mean(taken);
  const p = mean(passed);
  return { reactions: (reactions || []).length, taken: { n: taken.length, meanR: t }, passed: { n: passed.length, meanR: p }, value: t === null || p === null ? null : Math.round((t - p) * 10000) / 10000 };
}

module.exports = { reactionsOf, entriesOf, selectionOf };
