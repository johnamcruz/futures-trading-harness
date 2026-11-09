'use strict';

/**
 * Feedback from how the model's own trades behaved (what it learns from): each reviewed trade tagged with the reads
 * present at its entry and how it then behaved, shown to the model as one compact line in its prompt's reviewed-trades
 * block, and the per-read record held behind a sample floor. Information only: its own past, a record, never a rule,
 * filter, veto or size cut; nothing that decides (the gate, compose_check, order_plan, the trend rule, sizing, exits)
 * reads it. Past trades only: every figure is a closed trade's.
 *
 * The reads at entry (REGISTRY: one entry per read, `of(source)` -> words or null, so a later read is one entry):
 *   bias, location, setup, entry   the trade's compose record's reads of that step, prices dropped (lifecycle-record.js
 *                                  formOf), the record the gateway stamped on its entry order (entry-orders.json)
 *   regime                         the record's context (the briefing's regime at the compose)
 *   state                          its cycle's STATE read (cycle-log.js stateRead, the record's bar): `4h up/1h up/15m range`
 *   pullback, day                  that cycle bar's Pullback and Day so far words (state-read.js stateFacts)
 * Nothing present: nothing tagged, never a guess.
 *
 * The behaviour, from the facts the runner's review records (tripTags: runner-reviews.js writes them with the review)
 * and the lane's bars: size, exit (exitReasonOf: the broker's own word on the closing order: target, stop, trail
 * (a moved or trailing stop), closed (a market close), mixed; else unknown), R (the review's), MAE and MFE in R and
 * the bars to the MFE (experience-log.js tripExcursion, the one definition: the bars wholly inside the trade and the
 * exit; bars that don't cover it: unknown, null, never 0), the share of the MFE kept (R / MFE when MFE > 0), and whether
 * it reached +1R (MFE >= 1) before it closed.
 *
 *   REGISTRY, FRAMING
 *   tripTags({ side, size, fill, exit, openedAt, closedAt, risk, exitReason })   the review's trip-* tags
 *   tripOf(review)                       those tags read back, or null
 *   exitReasonOf({ t, side, orderId, fills, history, stopTicks, tick })        the exit's reason or null
 *   normalizeRecord(raw)                 a compose record as the loop reads it (lifecycle-record.js), or null
 *   readsAt({ record, stateRead }, registry)   { <key>: words } of the reads present
 *   behaviour(facts)                     the behaviour fields: one definition for every consumer (the prompt's line,
 *                                        an experience row; the training loop's round report could read the same)
 *   behaviourOf({ review, bars, tfMs })  { side, size, exit, R, maeR, mfeR, mfeBars, efficiency, reached1R, openMs }
 *   feedbackItem({ review, record, stateRead, bars, tfMs })   the line's facts, or null with nothing to tag
 *   feedbackLine(item)                   the one line
 *   recordText(items, { floor, max })    the per-read record (groups of at least `floor`), or null
 *   fromExperienceRow(row)               an entered experience log line's item (the offline measurement), or null
 *   tradeFeedback({ entries, home, dataDir, timeframe, n, window, floor, max })   { lines, record } for the prompt
 */

const fs = require('fs');
const path = require('path');
const { reviewResult, contractRoot } = require('./journal');
const { reviewR, graded, tradeLine } = require('./instincts');
const { tripExcursion } = require('../learning/experience-log');
const { fromLifecycleRecord, formOf } = require('../learning/lifecycle-record');
const { familyRoot } = require('./contracts');
const { tradingDayKey } = require('./clock');
const { etStamp } = require('./session-context');

const ORDER_TYPE = require('../broker/interface').ENUMS.orderType;

/** How the model is told to read the lines (the prompt, beside them; the journaling rule says the same). */
const FRAMING = 'your own past trades with the reads you entered on and how each behaved: a record, not a rule; weigh each figure by its n';

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const fin = Number.isFinite;
const r2 = x => Math.round(x * 100) / 100;
/** fn's value, or null when it throws (a read that can't be made is unknown, never a failed prompt). */
const safely = fn => { try { return fn(); } catch (_err) { return null; } };
const r6 = x => Math.round(x * 1e6) / 1e6; // a size-weighted fill price, kept to its precision
const signed = x => `${x > 0 ? '+' : ''}${r2(x)}`;

const stepReads = step => s => {
  const reads = s.record && Array.isArray(s.record.reads) ? s.record.reads.filter(r => r && r.step === step) : [];
  const words = [...new Set(reads.map(r => formOf(r)).filter(Boolean))];
  return words.length ? words.join(' + ') : null;
};
const stateFact = key => s => (s.stateRead && isObj(s.stateRead.facts) && typeof s.stateRead.facts[key] === 'string' ? s.stateRead.facts[key] : null);

const REGISTRY = Object.freeze([
  { key: 'bias', of: stepReads('bias') },
  { key: 'location', of: stepReads('location') },
  { key: 'setup', of: stepReads('setup') },
  { key: 'entry', of: stepReads('entry') },
  { key: 'regime', of: s => (s.record && isObj(s.record.context) && typeof s.record.context.regime === 'string' ? s.record.context.regime : null) },
  { key: 'state', of: s => {
    const r = s.stateRead && s.stateRead.status === 'read' && isObj(s.stateRead.read) && isObj(s.stateRead.read.frames) ? s.stateRead.read.frames : null;
    const words = r ? ['4h', '1h', '15m'].filter(k => typeof r[k] === 'string').map(k => `${k} ${r[k]}`) : [];
    return words.length ? words.join('/') : null;
  } },
  { key: 'pullback', of: stateFact('pullback') },
  { key: 'day', of: stateFact('daySoFar') },
]);

/** The reads present at entry: { <key>: words }, the absent left out. */
function readsAt(source = {}, registry = REGISTRY) {
  const out = {};
  for (const e of registry) {
    const v = safely(() => e.of(source || {}));
    if (typeof v === 'string' && v.trim()) out[e.key] = v.trim();
  }
  return out;
}

const normalizeRecord = raw => fromLifecycleRecord(raw);

// ---- The facts the runner's review records (runner-reviews.js) ----

const TRIP = { side: 'trip-side', size: 'trip-size', fill: 'trip-fill', exit: 'trip-out', openedAt: 'trip-open', closedAt: 'trip-close', risk: 'trip-risk', exitReason: 'trip-exit' };

/** The review's trip tags: what is known, nothing unknown written. */
function tripTags({ side, size, fill, exit, openedAt, closedAt, risk = null, exitReason = null }) {
  const iso = t => { const m = Date.parse(t); return fin(m) ? new Date(m).toISOString() : null; };
  const pairs = [['side', side === 'long' || side === 'short' ? side : null], ['size', fin(Number(size)) && Number(size) > 0 ? Number(size) : null],
    ['fill', fin(Number(fill)) ? r6(Number(fill)) : null], ['exit', fin(Number(exit)) ? r6(Number(exit)) : null], ['openedAt', iso(openedAt)], ['closedAt', iso(closedAt)],
    ['risk', fin(Number(risk)) && Number(risk) > 0 ? Number(risk) : null], ['exitReason', typeof exitReason === 'string' && exitReason ? exitReason : null]];
  return pairs.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${TRIP[k]}:${v}`);
}

/** The trip tags read back: { side, size, fill, exit, openMs, closeMs, risk, exitReason }, or null when it has none. */
function tripOf(review) {
  const tags = review && Array.isArray(review.tags) ? review.tags.map(String) : [];
  const get = name => { const t = tags.find(x => x.startsWith(`${name}:`)); return t ? t.slice(name.length + 1) : null; };
  if (!tags.some(x => x.startsWith('trip-'))) return null;
  const num = name => { const v = get(name); return v !== null && fin(Number(v)) ? Number(v) : null; };
  const ms = name => { const v = get(name); const t = v ? Date.parse(v) : NaN; return fin(t) ? t : null; };
  const side = get(TRIP.side);
  return { side: side === 'long' || side === 'short' ? side : null, size: num(TRIP.size), fill: num(TRIP.fill), exit: num(TRIP.exit), openMs: ms(TRIP.openedAt), closeMs: ms(TRIP.closedAt), risk: num(TRIP.risk), exitReason: get(TRIP.exitReason) };
}

/**
 * The exit's reason from the broker's own word on the orders that closed it (search_orders, `history`): a bracket's
 * target leg `target`; a trailing stop, or a stop away from the planned one (the brackets are placed from the fill:
 * fill -/+ stopTicks x tick, within half a tick) `trail`; a stop at it `stop`; a market order `closed` (the runner's or
 * the model's close); closing orders that say different things `mixed`. Null when it can't be told: the orders
 * unread, a closing order not listed, a stop with no planned stop, another order type.
 */
function exitReasonOf({ t, side, orderId, fills, history, stopTicks = null, tick = null }) {
  if (!t || !Array.isArray(history) || !Array.isArray(fills)) return null;
  const from = Date.parse(t.openedAt);
  const to = Date.parse(t.closedAt);
  const s = side === 'long' ? 1 : side === 'short' ? -1 : 0;
  if (!s || !fin(from) || !fin(to)) return null;
  const closing = fills.filter(f => f && f.voided !== true && f.contractId === t.contractId && String(f.orderId) !== String(orderId)
    && fin(Date.parse(f.creationTimestamp)) && Date.parse(f.creationTimestamp) >= from && Date.parse(f.creationTimestamp) <= to);
  if (!closing.length) return null;
  const reasons = [...new Set(closing.map(f => f.orderId)).values()].map(id => {
    const o = history.find(x => x && String(x.id) === String(id));
    if (!o) return null;
    const type = Number(o.type);
    const role = isObj(o.bracket) ? o.bracket.role : null;
    if (role === 'target') return 'target';
    if (type === ORDER_TYPE.trailing_stop) return 'trail';
    if (role === 'stop' || type === ORDER_TYPE.stop) {
      const planned = Number(stopTicks) > 0 && Number(tick) > 0 && fin(Number(t.fill)) ? Number(t.fill) - s * Number(stopTicks) * Number(tick) : null;
      if (planned === null || !fin(Number(o.stopPrice))) return null;
      return Math.abs(Number(o.stopPrice) - planned) <= Number(tick) / 2 ? 'stop' : 'trail';
    }
    return type === ORDER_TYPE.market ? 'closed' : null;
  });
  if (reasons.some(x => x === null)) return null;
  return new Set(reasons).size === 1 ? reasons[0] : 'mixed';
}

// ---- The line ----

/** How the trade behaved: the review's facts and its excursion on the bars. */
function behaviourOf({ review, bars = [], tfMs = 0 }) {
  const trip = tripOf(review);
  const R = reviewR(review || {});
  const timed = (Array.isArray(bars) ? bars : []).map(b => (fin(b.ms) ? b : { ...b, ms: Date.parse(b.t) })).filter(b => fin(b.ms)).sort((a, b) => a.ms - b.ms);
  const x = trip ? tripExcursion({ side: trip.side, entryPrice: trip.fill, exitPrice: trip.exit, openMs: trip.openMs, closeMs: trip.closeMs, risk: trip.risk, bars: timed, tfMs }) : { maeR: null, mfeR: null, mfeBars: null };
  return behaviour({ side: trip ? trip.side : null, size: trip ? trip.size : null, exit: trip ? trip.exitReason : null, R, ...x, openMs: trip ? trip.openMs : null });
}

/**
 * The behaviour fields, the one definition every consumer reads (the prompt's line, the offline experience rows; a
 * later reader such as the training loop's round report): the facts in, efficiency (R / MFE when MFE > 0) and +1R
 * reached (MFE >= 1) derived; anything unknown null, never 0.
 */
function behaviour({ side = null, size = null, exit = null, R = null, maeR = null, mfeR = null, mfeBars = null, openMs = null }) {
  const n = x => (fin(x) ? x : null);
  const mfe = n(mfeR);
  return {
    side: side === 'long' || side === 'short' ? side : null, size: n(size), exit: typeof exit === 'string' && exit ? exit : null, R: n(R),
    maeR: n(maeR), mfeR: mfe, mfeBars: n(mfeBars),
    efficiency: mfe !== null && mfe > 0 && fin(R) ? r2(R / mfe) : null,
    reached1R: mfe === null ? null : mfe >= 1,
    openMs: n(openMs),
  };
}

/** The line's facts: { at, root, result, reads, behaviour, setup, mistakes }, or null with nothing to tag. */
function feedbackItem({ review, record = null, stateRead = null, bars = [], tfMs = 0 }) {
  if (!review || (!tripOf(review) && !record)) return null;
  const behaviour = behaviourOf({ review, bars, tfMs });
  const at = behaviour.openMs ?? (record && fin(Date.parse(record.at)) ? Date.parse(record.at) : Date.parse(review.ts));
  return {
    at: fin(at) ? at : null, root: contractRoot(review.contractId || (record && record.root) || '') || null, result: reviewResult(review),
    side: behaviour.side || (record ? record.side : null),
    reads: readsAt({ record, stateRead }), behaviour,
    mistakes: (review.tags || []).map(String).filter(t => t.toLowerCase().startsWith('mistake:')),
  };
}

function feedbackLine(item) {
  const b = item.behaviour;
  const { setup, ...rest } = item.reads;
  const order = REGISTRY.map(e => e.key).filter(k => k !== 'setup' && rest[k]);
  const reads = order.map(k => (['bias', 'location', 'entry'].includes(k) ? rest[k] : `${k} ${rest[k]}`));
  const when = item.at !== null ? etStamp(new Date(item.at)).replace(/^\d{4}-(\d\d-\d\d \d\d:\d\d).*$/, '$1') : 'time unknown'; // "06-04 10:42" ET
  const mfe = b.mfeR === null ? 'MAE unknown, MFE unknown'
    : `MAE ${signed(b.maeR)}, MFE ${signed(b.mfeR)}${b.mfeBars !== null ? ` at bar ${b.mfeBars}` : ''}${b.R !== null && b.R > 0 && b.efficiency !== null ? `, kept ${b.efficiency} of it` : ''} (${b.reached1R ? 'reached +1R' : 'never reached +1R'})`;
  return `${when} ${item.side || 'side unknown'}${setup ? `, setup ${setup}` : ''}; reads: ${reads.length ? reads.join(', ') : 'unknown'}; `
    + `${b.size !== null ? b.size : '?'} ${item.root || '?'}; exit ${b.exit || 'unknown'}; ${item.result || 'result unknown'} R ${b.R === null ? 'unknown' : signed(b.R)}; ${mfe}`
    + `${item.mistakes.length ? ` [${item.mistakes.join(', ')}]` : ''}`;
}

/**
 * The per-read record over `items`: per read and its words, n trades, average R, MAE and MFE (each with its own n:
 * the known ones), only groups of at least `floor` trades, the largest `max`. Null when none reaches the floor.
 */
function recordText(items, { floor, max, of = null }) {
  const groups = new Map();
  const keys = REGISTRY.map(e => e.key);
  for (const it of items) {
    for (const k of keys) {
      if (!it.reads || !it.reads[k] || !fin(it.behaviour.R)) continue;
      const g = `${k} ${it.reads[k]}`;
      if (!groups.has(g)) groups.set(g, { order: keys.indexOf(k), list: [] });
      groups.get(g).list.push(it.behaviour);
    }
  }
  const avg = xs => xs.reduce((a, x) => a + x, 0) / xs.length;
  const shown = [...groups].filter(([, g]) => g.list.length >= floor).sort((a, b) => b[1].list.length - a[1].list.length || a[1].order - b[1].order).slice(0, max);
  if (!shown.length) return null;
  const part = (name, xs) => (xs.length ? `${name} ${signed(avg(xs))} (n ${xs.length})` : `${name} unknown (n 0)`);
  const body = shown.map(([g, { list }]) => `${g}: n ${list.length}, avg R ${signed(avg(list.map(x => x.R)))}, ${part('MAE', list.map(x => x.maeR).filter(fin))}, ${part('MFE', list.map(x => x.mfeR).filter(fin))}`);
  return `Record per read (${of && of > items.length ? `${items.length} of your last ${of}` : `your last ${items.length}`} reviewed trades; groups of ${floor} or more; MAE/MFE from bar extremes, bar-granular, overstated): ${body.join('; ')}`;
}

/** An entered experience log line (v3) as an item: its reads, context and STATE read; its outcome (no exit reason there). */
function fromExperienceRow(row) {
  if (!row || row.decision !== 'entered' || !isObj(row.outcome)) return null;
  const o = row.outcome;
  const at = Date.parse(o.entryTime || row.bar);
  // The row's exitReason is `closed` or `open` for a real trade (tripOutcome): no stop, target or trail word there.
  const b = behaviour({ side: row.side, size: o.size, exit: ['stop', 'target', 'trail'].includes(o.exitReason) ? o.exitReason : null, R: o.R, maeR: o.maeR, mfeR: o.mfeR, openMs: fin(at) ? at : null });
  return {
    at: fin(at) ? at : null, root: row.root || null, result: ['win', 'loss', 'scratch'].includes(row.grade) ? row.grade : null, side: b.side,
    reads: readsAt({ record: { reads: row.reads || [], context: row.context || {} }, stateRead: row.stateRead || null }), behaviour: b, mistakes: [],
  };
}

// ---- The prompt's trades, from local files ----

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return null; } };
const readLines = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch (_err) { return []; } }); } catch (_err) { return []; } };

/** The joins for the reviews: the stamped record, its cycle's STATE read, the lane's bars; each read once. */
function joiner({ home, env, dataDir, timeframe }) {
  const stamps = new Map((Array.isArray(readJson(path.join(home, 'entry-orders.json'))) ? readJson(path.join(home, 'entry-orders.json')) : [])
    .filter(e => isObj(e) && isObj(e.composed) && e.composed.record).map(e => [String(e.orderId), e]));
  const cache = new Map();
  const once = (key, fn) => { if (!cache.has(key)) cache.set(key, safely(fn)); return cache.get(key); };
  const tfMs = Number(timeframe) * 60000;
  return review => {
    const stamp = review.orderId !== undefined && review.orderId !== null ? stamps.get(String(review.orderId)) : null;
    const root = familyRoot(contractRoot(review.contractId || (stamp && stamp.contractId) || ''));
    let record = null;
    let stateRead = null;
    if (stamp && root) {
      const day = tradingDayKey(new Date(Date.parse(stamp.at)));
      const recs = once(`r|${root}|${day}`, () => require('./trade-lifecycle').readRecords(home, root, { days: [day] }).map(normalizeRecord).filter(Boolean)) || [];
      record = recs.find(r => r.id === String(stamp.composed.record)) || null;
      if (record) {
        const cycles = once(`c|${day}`, () => readLines(path.join(home, 'logs', `cycles-${day}.jsonl`))) || [];
        const hit = cycles.filter(c => isObj(c.stateRead) && Date.parse(c.stateRead.bar) === Date.parse(record.bar) && (!c.stateRead.symbol || familyRoot(c.stateRead.symbol) === root));
        stateRead = hit.length ? hit[hit.length - 1].stateRead : null;
      }
    }
    // The run's bars as the experience log reads them (run-experience.js): the archive of the trade's day (every bar
    // the session polled: session/bars-archive.js) with the lane's bars file (rewritten each bar: its last window only).
    const trip = tripOf(review);
    const day = trip && fin(trip.openMs) ? tradingDayKey(new Date(trip.openMs)) : null;
    const file = dataDir && root ? once(`b|${root}`, () => {
      const f = readJson(path.join(dataDir, `${root}-${timeframe}m.json`));
      return (f && Array.isArray(f.bars) ? f.bars : []).map(b => ({ ...b, ms: Date.parse(b.t) }));
    }) || [] : [];
    const bars = root && day ? once(`a|${root}|${day}`, () => {
      const A = require('../session/bars-archive');
      const archived = A.archivedBars(A.recordDirFor(home, env, day)).series(root, Number(timeframe));
      return require('../learning/run-experience').mergeBars(archived, file);
    }) || file : file;
    return { record, stateRead, bars, tfMs };
  };
}

/**
 * The prompt's reviewed trades: the last `n` of the scoped journal `entries` as lines (the feedback line, else the
 * plain one: instincts.js), and the per-read record over the last `window` (recordText at `floor`, `max`).
 */
function tradeFeedback({ entries, home, env = process.env, dataDir = null, timeframe, n, window, floor, max }) {
  const reviews = graded(Array.isArray(entries) ? entries : []);
  if (!reviews.length) return { lines: [], record: null, tagged: 0 };
  const join = joiner({ home, env, dataDir, timeframe });
  const items = new Map();
  const itemOf = r => { if (!items.has(r)) items.set(r, feedbackItem({ review: r, ...join(r) })); return items.get(r); };
  const shown = reviews.slice(-n).map(r => ({ r, it: itemOf(r) }));
  const lines = shown.map(({ r, it }) => (it ? feedbackLine(it) : tradeLine(r)));
  const recent = reviews.slice(-window).map(itemOf).filter(Boolean);
  return { lines, record: recent.length ? recordText(recent, { floor, max, of: reviews.slice(-window).length }) : null, tagged: shown.filter(x => x.it).length };
}

module.exports = { REGISTRY, FRAMING, tripTags, tripOf, exitReasonOf, normalizeRecord, readsAt, behaviour, behaviourOf, feedbackItem, feedbackLine, recordText, fromExperienceRow, tradeFeedback };
