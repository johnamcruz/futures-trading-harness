'use strict';

/**
 * The probe round's trend pool (Propose-Probe-Compose, docs/TRAINING.md): every trend leg of a practice-train screen
 * period (replay/trend-capture.js legsOf, the capture report's own detector), built once from the period's base bars and
 * pinned to a file with a fingerprint. Each round takes the next batch of legs (drawRound: without replacement across
 * rounds, reshuffled by the loop's seed once the pool is used up), so over the rounds every leg is screened; the batch
 * splits by session date into a probe half and a confirm half of about the configured share each (splitBatch: no day in
 * both), and each side replays the batch's sessions in full in the runner's session, the champion and every edit the
 * same ones.
 *
 * The regression days (the trend-move set's: tests/fixtures/trend-moves) are left out of the pool: they judge only harm,
 * never a gain (trend-screen.js), so a skill is never tuned to them.
 *
 *   VERSION, KIND
 *   sessionDays(bars, session)                 the trading days the bars hold a bar in the session (sorted)
 *   buildTrendSet({ bars, session, from, to, exclude })   the pool: { v, kind, detector, from, to, exclude, sessions,
 *                                              days: [{ day, legs }], legs: [{ id, day, side, start }], fingerprint };
 *                                              from..to session dates (to exclusive)
 *   writeTrendSet(dir, doc), readTrendSet(file)   <dir>/trend-set-<fingerprint>.json; read checks its kind, version (v)
 *                                              and fingerprint
 *   drawRound(items, { seed, round, per })     round n's batch: per items without replacement across rounds,
 *                                              reshuffled when the pool is used up: { items, cycles }
 *   dayOfLeg(id)                               a leg id's session date (its first field: day|side|start)
 *   splitBatch(ids, { seed, half })            { probe: { days, legs }, confirm: { days, legs } }: whole days, ordered by a
 *                                              seeded hash, to the probe half until it holds half of the legs
 *   dayWindows(days)                           [{ from, to }] session-date windows (to exclusive), consecutive dates merged
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { legsOf, DETECTOR } = require('../replay/trend-capture');
const { parseWindows, inWindow, tradingDayKey } = require('../trading/clock');

const VERSION = 'v2';
const KIND = 'trend-set';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const nextDate = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().split('T')[0];
const dayOfLeg = id => String(id).split('|')[0];

function sessionDays(bars, session) {
  const { windows } = parseWindows(session);
  const out = new Set();
  for (const b of Array.isArray(bars) ? bars : []) {
    const t = Date.parse(b && b.t);
    if (!Number.isFinite(t)) continue;
    const at = new Date(t);
    if (windows.length && windows.some(w => inWindow(at, w))) out.add(tradingDayKey(at));
  }
  return [...out].sort();
}

const fingerprintOf = doc => {
  const { fingerprint: _f, ...rest } = doc;
  return hash(JSON.stringify(rest));
};

function buildTrendSet({ bars, session, from, to, exclude = [] }) {
  const errors = [];
  if (!(DATE.test(String(from)) && DATE.test(String(to)) && from < to)) errors.push('from, to: YYYY-MM-DD session dates, from before to');
  if (!(typeof session === 'string' && parseWindows(session).windows.length)) errors.push('session: a runner session spec (e.g. 09:30-12:00@America/New_York)');
  if (!Array.isArray(exclude) || !exclude.every(d => DATE.test(String(d)))) errors.push('exclude: YYYY-MM-DD dates');
  if (errors.length) throw new Error(`trend set refused:\n- ${errors.join('\n- ')}`);
  const days = sessionDays(bars, session).filter(d => d >= from && d < to && !exclude.includes(d));
  if (!days.length) throw new Error(`trend set refused: no session of ${from}..${to} in the bars (outside the excluded days)`);
  const keep = new Set(days);
  // The capture report's own leg ids (day|side|start), so a run's report pairs with the pool leg by leg.
  const legs = legsOf(bars, { session }).filter(l => keep.has(l.day)).map(l => ({ id: `${l.day}|${l.side}|${l.start}`, day: l.day, side: l.side, start: l.start }));
  const doc = {
    v: VERSION, kind: KIND, detector: { version: DETECTOR, minMoveAtr: require('../tunables').replay().trendCapture.minMoveAtr, session },
    from, to, exclude: [...exclude].sort(), sessions: days.length,
    days: days.map(day => ({ day, legs: legs.filter(l => l.day === day).length })), legs,
  };
  return { ...doc, fingerprint: fingerprintOf(doc) };
}

function writeTrendSet(dir, doc) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `trend-set-${doc.fingerprint}.json`);
  fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
  return file;
}

function readTrendSet(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObj(doc) || doc.kind !== KIND) throw new Error(`${file}: not a trend set (scripts/trend-set.js build)`);
  if (doc.v !== VERSION) throw new Error(`${file}: a trend set of version ${doc.v}, not ${VERSION}: rebuild it`);
  if (fingerprintOf(doc) !== doc.fingerprint) throw new Error(`${file}: its content doesn't match its fingerprint (changed after it was built)`);
  if (!Array.isArray(doc.legs) || !doc.legs.every(l => isObj(l) && typeof l.id === 'string' && DATE.test(dayOfLeg(l.id)))) throw new Error(`${file}: legs: [{ id: day|side|start }]`);
  return doc;
}

/** Cycle c's order of the pool: a seeded shuffle (by hash), the same for the same seed and cycle. */
const orderOf = (pool, seed, c) => [...pool].sort((a, b) => hash(`${seed}|${c}|${a}`).localeCompare(hash(`${seed}|${c}|${b}`)) || a.localeCompare(b));

/**
 * Round n's batch (n from 1): per items of the pool, without replacement until the pool is used up, then a fresh
 * shuffle. The rounds read one sequence, the pool's cycles one after another (each a seeded shuffle), per items a round:
 * every item once a cycle, a round never twice the same item. A round that spans two cycles takes the next cycle's first
 * items among those it doesn't hold yet (that cycle's order moves its own copies of them later).
 */
function drawRound(pool, { seed, round, per }) {
  const items = [...new Set(pool)].sort();
  const N = items.length;
  if (!(Number.isInteger(per) && per >= 1 && per <= N)) throw new Error(`drawRound: per is 1 to the pool's ${N}, not ${per}`);
  if (!(Number.isInteger(round) && round >= 1)) throw new Error(`drawRound: round is 1 or more, not ${round}`);
  const from = (round - 1) * per;
  const to = from + per;
  const seq = [];
  for (let c = 0; seq.length < to; c += 1) {
    let order = orderOf(items, seed, c);
    // The round that spans this cycle's start: the items it already took from the cycle before stay out of its slots.
    const at = seq.length;
    const b = Math.floor(at / per) * per;
    const taken = new Set(seq.slice(b, at));
    if (taken.size) {
      const head = order.filter(d => !taken.has(d)).slice(0, b + per - at);
      order = [...head, ...order.filter(d => !head.includes(d))];
    }
    seq.push(...order);
  }
  const out = seq.slice(from, to);
  return { items: [...out].sort(), cycles: [...new Set(out.map((_d, i) => Math.floor((from + i) / N)))].sort((a, b) => a - b) };
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

module.exports = { VERSION, KIND, sessionDays, buildTrendSet, writeTrendSet, readTrendSet, drawRound, dayOfLeg, splitBatch, dayWindows, fingerprintOf };
