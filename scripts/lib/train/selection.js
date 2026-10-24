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
 * Only reactions the model could have acted on count: their bar closed inside the runner's sessions (the loop's runner
 * config's `sessions`: the scan covers wider hours, and a reaction outside them could only count as passed), and the run
 * stepped that close (a decision time from the close until the next bar: a windowed run steps only its windows).
 *
 *   reactionsOf(moments, { days, sessions })   [{ day, bar, side, R, minutes, validBars }]: the scan's traded reactions on
 *                                            those session days whose bar closed in sessions (a runner session spec, a
 *                                            string or a list; none: every hour)
 *   entriesOf(orders)                        [{ at, side }] from a run home's entry orders (buy: long, sell: short)
 *   selectionOf(reactions, entries, { stepped })   { reactions, taken: { n, meanR }, passed: { n, meanR }, value }; stepped:
 *                                            the run's recorded decision times (ISO): only the reactions whose close it
 *                                            stepped (none given: every reaction)
 */

const { parseWindows, inWindow } = require('../trading/clock');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const mean = xs => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10000) / 10000 : null);
const closeOf = r => Date.parse(r.bar) + Number(r.minutes) * 60000;

function reactionsOf(moments, { days, sessions = null }) {
  const keep = new Set(days || []);
  const spec = Array.isArray(sessions) ? sessions.join(',') : sessions;
  const windows = spec ? parseWindows(spec).windows : null;
  if (spec && !windows.length) throw new Error(`reactionsOf: no session in ${spec}`);
  const inSession = m => !windows || windows.some(w => inWindow(new Date(closeOf(m)), w));
  return (Array.isArray(moments) ? moments : []).filter(m => isObj(m) && keep.has(m.day) && isObj(m.standard) && m.standard.status === 'traded' && isObj(m.outcome) && num(m.outcome.R) !== null && (m.side === 'long' || m.side === 'short') && Number.isFinite(closeOf(m)) && inSession(m))
    .map(m => ({ day: m.day, bar: m.bar, side: m.side, R: m.outcome.R, minutes: m.minutes, validBars: m.validBars }));
}

function entriesOf(orders) {
  const sideOf = o => (isObj(o.composed) && o.composed.side) || (o.side === 'buy' ? 'long' : o.side === 'sell' ? 'short' : null);
  return (Array.isArray(orders) ? orders : []).filter(o => isObj(o) && Number.isFinite(Date.parse(o.at))).map(o => ({ at: o.at, side: sideOf(o) })).filter(e => e.side);
}

function selectionOf(reactions, entries, { stepped = null } = {}) {
  const times = Array.isArray(stepped) ? stepped.map(t => Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b) : null;
  // Stepped: a decision time from the reaction bar's close until the next bar's.
  const wasStepped = r => {
    const c = closeOf(r);
    return times.some(t => t >= c && t < c + Number(r.minutes) * 60000);
  };
  const counted = (reactions || []).filter(r => !times || wasStepped(r));
  const took = r => {
    const step = Number(r.minutes) * 60000;
    const from = Date.parse(r.bar) + step;
    const to = from + step * (Number(r.validBars) || 1);
    return (entries || []).some(e => e.side === r.side && Date.parse(e.at) >= from && Date.parse(e.at) < to);
  };
  const taken = counted.filter(took).map(r => r.R);
  const passed = counted.filter(r => !took(r)).map(r => r.R);
  const t = mean(taken);
  const p = mean(passed);
  return { reactions: counted.length, taken: { n: taken.length, meanR: t }, passed: { n: passed.length, meanR: p }, value: t === null || p === null ? null : Math.round((t - p) * 10000) / 10000 };
}

module.exports = { reactionsOf, entriesOf, selectionOf };
