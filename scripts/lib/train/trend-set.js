'use strict';

/**
 * The probe round's trend pool (Propose-Probe-Compose, docs/TRAINING.md): the trend-leg census's legs (learning/
 * leg-census.js: every leg of practice-train by the capture report's detector, in one seeded, hashed order) whose session
 * day lies in the loop's screen period, every leg with a moment or not (the round replays whole sessions). Each round
 * takes the next batch in that order (drawBatches: the census's order first; once the pool is used up, a fresh shuffle
 * by the loop's seed), so over the rounds every leg is screened; the batch splits by session date into a probe half and
 * a confirm half of about the configured share each (splitBatch: no day in both), and each side replays the batch's
 * sessions in full in the runner's session, the champion and every edit the same ones.
 *
 * The regression days (the trend-move set's: tests/fixtures/trend-moves) are left out of the pool: they judge only harm,
 * never a gain (trend-screen.js), so a skill is never tuned to them.
 *
 *   poolOf(census, { from, to, exclude })      [leg id] in the census's order: the legs of [from, to) (session dates),
 *                                              none of an excluded day
 *   drawBatches(pool, { seed, sizes })         every round's batch, sizes[i] legs for round i + 1, from one sequence (the
 *                                              pool's order, then seeded shuffles): [{ items, cycles, from }]
 *   drawRound(pool, { seed, round, per })      round n's batch when every round draws per: { items, cycles }
 *   dayOfLeg(id)                               a leg id's session date (its first field: day|side|start)
 *   splitBatch(ids, { seed, half })            { probe: { days, legs }, confirm: { days, legs } }: whole days, ordered by a
 *                                              seeded hash, to the probe half until it holds half of the legs
 *   dayWindows(days)                           [{ from, to }] session-date windows (to exclusive), consecutive dates merged
 */

const crypto = require('crypto');
const LC = require('../learning/leg-census');

const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const nextDate = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().split('T')[0];
const dayOfLeg = id => String(id).split('|')[0];

/** The pool: the census's legs of the screen period, in its order (its reader, every leg: none needs a moment here). */
function poolOf(census, { from, to, exclude = [] }) {
  const out = new Set(exclude);
  return LC.batch(census, 0, { from, to, size: Infinity, withMoment: false }).filter(x => !out.has(x.day)).map(x => x.id);
}

/** Cycle c's order: the pool's own (the census's) first, then seeded shuffles (by hash), the same for the same seed. */
const orderOf = (pool, seed, c) => (c === 0 ? [...pool] : [...pool].sort((a, b) => hash(`${seed}|${c}|${a}`).localeCompare(hash(`${seed}|${c}|${b}`)) || a.localeCompare(b)));

/**
 * The rounds' batches, round by round (sizes[i]: round i + 1's), from one sequence: the pool's cycles one after another,
 * so every leg comes once a cycle, without replacement until the pool is used up. A round never holds a leg twice: a
 * round that spans two cycles takes the next cycle's first legs among those it doesn't hold yet (that cycle's order
 * moves its own copies of them later). [{ items, cycles, from }].
 */
function drawBatches(pool, { seed, sizes }) {
  const items = [...new Set(pool)];
  const N = items.length;
  if (!Array.isArray(sizes) || !sizes.length) throw new Error('drawBatches: sizes, one a round');
  for (const per of sizes) if (!(Number.isInteger(per) && per >= 1 && per <= N)) throw new Error(`drawBatches: a batch is 1 to the pool's ${N}, not ${per}`);
  const bounds = [];
  let at = 0;
  for (const per of sizes) { bounds.push([at, at + per]); at += per; }
  const total = at;
  const seq = [];
  for (let c = 0; seq.length < total; c += 1) {
    let order = orderOf(items, seed, c);
    const start = seq.length;
    const spanning = bounds.find(([x, y]) => x < start && start < y);
    if (spanning) {
      const taken = new Set(seq.slice(spanning[0], start));
      const head = order.filter(d => !taken.has(d)).slice(0, spanning[1] - start);
      order = [...head, ...order.filter(d => !head.includes(d))];
    }
    seq.push(...order);
  }
  return bounds.map(([x, y]) => ({ items: seq.slice(x, y).sort(), cycles: [...new Set(seq.slice(x, y).map((_d, i) => Math.floor((x + i) / N)))].sort((p, q) => p - q), from: x }));
}

/** Round n's batch (n from 1) when every round draws per legs: drawBatches with equal sizes. { items, cycles }. */
function drawRound(pool, { seed, round, per }) {
  if (!(Number.isInteger(round) && round >= 1)) throw new Error(`drawRound: round is 1 or more, not ${round}`);
  const N = new Set(pool).size;
  if (!(Number.isInteger(per) && per >= 1 && per <= N)) throw new Error(`drawRound: per is 1 to the pool's ${N}, not ${per}`);
  const { items, cycles } = drawBatches(pool, { seed, sizes: Array.from({ length: round }, () => per) })[round - 1];
  return { items, cycles };
}

/** A batch split by session date: whole days, in a seeded hash order, to the probe half until it holds half the legs. */
function splitBatch(ids, { seed, half }) {
  if (!(typeof half === 'number' && half > 0 && half < 1)) throw new Error(`splitBatch: half is a share between 0 and 1, not ${half}`);
  const byDay = new Map();
  for (const id of [...new Set(ids)].sort()) byDay.set(dayOfLeg(id), [...(byDay.get(dayOfLeg(id)) || []), id]);
  const days = [...byDay.keys()].sort((a, b) => hash(`${seed}|half|${a}`).localeCompare(hash(`${seed}|half|${b}`)) || a.localeCompare(b));
  const target = half * [...byDay.values()].flat().length;
  const out = { probe: { days: [], legs: [] }, confirm: { days: [], legs: [] } };
  for (const d of days) {
    // The probe half until it holds its share; never every day (the confirm half judges the combined change).
    const which = out.probe.legs.length < target && out.probe.days.length < days.length - 1 ? 'probe' : 'confirm';
    out[which].days.push(d);
    out[which].legs.push(...byDay.get(d));
  }
  for (const h of Object.values(out)) { h.days.sort(); h.legs.sort(); }
  return out;
}

function dayWindows(days) {
  const out = [];
  for (const d of [...new Set(days)].sort()) {
    const last = out[out.length - 1];
    if (last && last.to === d) last.to = nextDate(d);
    else out.push({ from: d, to: nextDate(d) });
  }
  return out;
}

module.exports = { poolOf, drawBatches, drawRound, dayOfLeg, splitBatch, dayWindows };
