'use strict';

/**
 * The shadow record: what every verified composed plan (compose_check's ok record, trade-lifecycle.js) would have done,
 * taken or not, walked forward on the bars model-free (experience-log.js limitOutcome: a limit at the entry reference
 * until the record expires, then its stop and target, the stop first). It keeps measuring a setup a lesson advises
 * against, so a lesson can't seal itself: its record (lesson-advice.js) counts what the skipped setups did.
 *
 * The runner records it each bar (recordShadow, the first lane's bars), only outcomes settled by the bar's close
 * (the bars are cut at `now`: never a later bar), each record once, to <FTH_HOME>/lessons/shadow.jsonl, one line
 * { id, root, side, at, bar, entryTime, exitTime, exitReason, R }. A plan that never filled is recorded too (R null):
 * it is no outcome, and it is not walked again. Readers take only the lines settled at or before their own clock.
 *
 *   shadowFile(home)
 *   readShadow(home, now)                          the lines settled at or before now (exitTime), oldest first
 *   recordShadow(home, { root, bars, minutes, tick, now })   append the newly settled; returns how many
 */

const fs = require('fs');
const path = require('path');
const { limitOutcome } = require('../learning/experience-log');
const { readRecords } = require('./trade-lifecycle');
const { tradingDayKey } = require('./clock');

const shadowFile = home => path.join(home, 'lessons', 'shadow.jsonl');

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch (_err) { return []; } });
}

function readShadow(home, now) {
  const at = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(at)) return [];
  return readLines(shadowFile(home)).filter(x => Number.isFinite(Date.parse(x.exitTime)) && Date.parse(x.exitTime) <= at);
}

const priceOf = x => (x && typeof x === 'object' ? x.price ?? x.limit ?? x.ref : x);

function recordShadow(home, { root, bars, minutes, tick, now }) {
  const at = now instanceof Date ? now.getTime() : NaN;
  const tfMs = minutes * 60000;
  if (!Number.isFinite(at) || !(tfMs > 0) || !Array.isArray(bars) || !bars.length) return 0;
  // The bars closed by now, only: an outcome is never read from a later bar.
  const closed = bars.map(b => ({ ms: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c })).filter(b => Number.isFinite(b.ms) && b.ms + tfMs <= at);
  if (!closed.length) return 0;
  const days = [...new Set(closed.map(b => tradingDayKey(new Date(b.ms))))];
  const file = shadowFile(home);
  const seen = new Set(readLines(file).map(x => x.id));
  const fresh = [];
  for (const r of readRecords(home, root, { days })) {
    if (!r || r.ok !== true || !r.id || seen.has(r.id) || !r.plan) continue;
    const barMs = Date.parse(r.bar);
    if (!Number.isFinite(barMs) || barMs + tfMs > at) continue;
    const o = limitOutcome({
      bars: closed, tfMs, side: r.side, entry: priceOf(r.plan.entry), stop: priceOf(r.plan.stop), target: priceOf(r.plan.target),
      fromMs: barMs + tfMs, expiresMs: Date.parse(r.expiresAt), tick: Number(r.plan.tick) || tick,
    });
    // Settled: filled and out by now, or never filled (its window closed by now). Otherwise it waits for a later bar.
    const unfilled = !o.filled && o.exitReason === 'unfilled' && Date.parse(r.expiresAt) <= at;
    if (!unfilled && !(o.filled && Number.isFinite(o.R))) continue;
    seen.add(r.id);
    fresh.push({ id: r.id, root: r.root, side: r.side, at: r.at, bar: r.bar, entryTime: o.entryTime || null, exitTime: o.exitTime || new Date(at).toISOString(), exitReason: o.exitReason, R: unfilled ? null : o.R });
  }
  if (fresh.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, fresh.map(x => `${JSON.stringify(x)}\n`).join(''));
  }
  return fresh.length;
}

module.exports = { shadowFile, readShadow, recordShadow };
