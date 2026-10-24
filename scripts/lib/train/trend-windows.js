'use strict';

/**
 * The trend set's stepped windows (Propose-Probe-Compose, docs/TRAINING.md): a trend run steps only around each leg of
 * its batch half, not whole sessions, as a curated run steps its list's windows (replay/step-windows.js, the driver's
 * curatedPoints). Built by code from the census's legs (learning/leg-census.js) before any run; the champion and every
 * edit of a round step the same windows (the same inputs give the same windows).
 *
 *   leg window      the decision bars from leadBars (config/training.json trendWindows) bars before the leg's start bar
 *                   through its catch window (its first catchShare, config/replay.json trendCapture: the span a catch
 *                   counts in, trend-capture.js), clipped to the runner's sessions; legs whose windows touch merge into one
 *   control window  per leg, controlPerLeg windows of the same length from the same session, in the runner's sessions,
 *                   sharing no bar with any census leg's window that day (the batch's or not) or another window; chosen by
 *                   a seeded hash (the loop's seed), so the screen still sees entries where there is no leg to catch
 *   management      a position or working order open after a window is managed bar by bar until flat (the driver's own)
 *
 * The screen's units become the windows (trend-screen.js): a leg pairs only when its window was stepped to its end on
 * both sides (windowStates); net R is per window (each round trip to the window it followed: unitR); first tries and
 * the selection value read only the windows' bars. Nothing of a window's choice reaches the model: the run's runner
 * config, environment and run home are a whole-session run's (replay/step-windows.js); the model reads each bar as there.
 *
 * Windows are bar-close bounds in ms: a bar whose close c has from < c <= to is in the window (curatedPoints' rule).
 *
 *   dayCloses(cfg, day)                         [ms]: the base-timeframe bar closes of the day's trade decision times
 *   windowsFor({ day, legs, others, closes, minutes, seed, leadBars, controlPerLeg, catchShare })
 *                                               { windows: [{ id, day, kind: 'leg' | 'control', legs, from, to }], dropped }
 *   windowStates({ days, windows })             [{ unit, day, kind, complete, why }]: each window stepped to its end or not
 *   unitOfRecord(windows, t)                    the window a record at decision time t follows (its day's last window
 *                                               opened before t), or null
 *   unitOfBar(windows, bar, minutes)            the window holding the bar (by its close), or null
 *   unitR({ days, windows })                    { unit: net R }: every round trip with an R, to the window it followed
 *   asConfig(windows)                           the replay config's stepWindows: { kind: 'trend-set', windows: [{ from, to }] }
 */

const crypto = require('crypto');
const { tradingDayStart, tradingDayKey } = require('../trading/clock');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const iso = ms => new Date(ms).toISOString();
const overlaps = (a, b) => a.from < b.to && b.from < a.to;

/** The day's trade decision times' base bar closes (replay/schedule.js decisionPoints: the runner's sessions). */
function dayCloses(cfg, day) {
  const { decisionPoints, holidayDates } = require('../replay/schedule');
  const start = tradingDayStart(new Date(`${day}T12:00:00Z`));
  const step = cfg.timeframe * 60000;
  const delay = (cfg.barDelaySeconds || 0) * 1000;
  // The session ends where the next one starts: UTC midnight after the date lies in it (after 18:00 New York time).
  const [y, m, d] = day.split('-').map(Number);
  const end = tradingDayStart(new Date(Date.UTC(y, m - 1, d + 1)));
  // The exchange's holidays and early closes, as the run's own config adds them (replay/config.js resolveReplay).
  const hol = holidayDates(start, end);
  const runCfg = { ...cfg, closedDates: [...(cfg.closedDates || []), ...hol.closed], earlyCloseDates: [...(cfg.earlyCloseDates || []), ...hol.early] };
  const out = decisionPoints(runCfg, { start, end }).filter(p => p.kind === 'trade' && p.day === day).map(p => p.t.getTime() - delay).filter(c => c % step === 0);
  return [...new Set(out)].sort((a, b) => a - b);
}

/** A leg's window before clipping: leadBars bars before its start bar through its catch window (whole bars). */
function legSpan(g, { step, leadBars, catchShare }) {
  const t0 = Date.parse(g.start);
  const endClose = Date.parse(g.end) + step;
  const until = t0 + (endClose - t0) * catchShare;
  const to = t0 + step * Math.max(1, Math.floor((until - t0) / step));
  return { from: t0 - leadBars * step, to };
}

function windowsFor({ day, legs = [], others = [], closes = [], minutes, seed, leadBars, controlPerLeg, catchShare }) {
  const step = minutes * 60000;
  const set = new Set(closes);
  const inside = w => closes.filter(c => c > w.from && c <= w.to);
  const dropped = [];
  // Each batch leg's window, clipped to the runner's sessions (its first and last decision close inside it).
  const own = [];
  for (const g of [...legs].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const w = legSpan(g, { step, leadBars, catchShare });
    const cs = inside(w);
    if (!cs.length) { dropped.push({ id: g.id, why: 'no decision time of the runner\'s sessions (outside them, or an exchange holiday)' }); continue; }
    own.push({ leg: g.id, from: cs[0] - step, to: cs[cs.length - 1] });
  }
  // Touching leg windows merge: one window, its legs listed.
  const merged = [];
  for (const w of [...own].sort((a, b) => a.from - b.from || (a.leg < b.leg ? -1 : 1))) {
    const last = merged[merged.length - 1];
    if (last && w.from <= last.to) { last.to = Math.max(last.to, w.to); last.legs.push(w.leg); } else merged.push({ from: w.from, to: w.to, legs: [w.leg] });
  }
  // Every census leg's window that day (the batch's or not): no control window shares a bar with one.
  const busy = [...merged, ...others.map(g => legSpan(g, { step, leadBars, catchShare }))];
  const controls = [];
  for (const w of own) {
    const len = Math.round((w.to - w.from) / step);
    for (let k = 0; k < controlPerLeg; k += 1) {
      const fits = closes.filter(c => {
        const cand = { from: c - len * step, to: c };
        for (let i = 0; i < len; i += 1) if (!set.has(c - i * step)) return false;
        return ![...busy, ...controls].some(b => overlaps(b, cand));
      });
      if (!fits.length) { dropped.push({ id: `${w.leg}|control${k}`, why: 'no free stretch of the same length in the session' }); continue; }
      const c = fits.sort((a, b) => hash(`${seed}|control|${w.leg}|${k}|${a}`).localeCompare(hash(`${seed}|control|${w.leg}|${k}|${b}`)) || a - b)[0];
      controls.push({ from: c - len * step, to: c, for: w.leg });
    }
  }
  const windows = [
    ...merged.map(w => ({ id: `${day}|leg|${iso(w.from)}`, day, kind: 'leg', legs: w.legs.sort(), from: w.from, to: w.to })),
    ...controls.map(w => ({ id: `${day}|control|${iso(w.from)}`, day, kind: 'control', legs: [], for: w.for, from: w.from, to: w.to })),
  ].sort((a, b) => a.from - b.from);
  return { windows, dropped };
}

const recsOf = (days, day) => (isObj(days) && Array.isArray(days[day]) ? days[day] : []).filter(r => isObj(r) && Number.isFinite(Date.parse(r.t)));

/** Each window stepped to its end (a record of its day at or after its last bar's close) or not, and why. */
function windowStates({ days = {}, windows = [] } = {}) {
  return windows.map(w => {
    const recs = recsOf(days, w.day);
    const reached = recs.some(r => Date.parse(r.t) >= w.to);
    // Its own records: the window's and the management after it, up to the next window (unitOfRecord).
    const own = recs.filter(r => unitOfRecord(windows, r.t) === w.id && r.kind !== 'eod');
    const failed = own.length && Array.isArray(own[own.length - 1].errors) && own[own.length - 1].errors.length;
    const complete = reached && !failed;
    const why = complete ? null : failed ? 'failed cycles (a crash or errors)' : 'stopped before the window ended (a call limit or an interruption)';
    return { unit: w.id, day: w.day, kind: w.kind, complete, why };
  });
}

function unitOfRecord(windows, t) {
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const day = tradingDayKey(new Date(ms));
  const before = windows.filter(w => w.day === day && w.from < ms);
  return before.length ? before[before.length - 1].id : null;
}

function unitOfBar(windows, bar, minutes) {
  const c = Date.parse(bar) + minutes * 60000;
  if (!Number.isFinite(c)) return null;
  const w = windows.find(x => c > x.from && c <= x.to);
  return w ? w.id : null;
}

function unitR({ days = {}, windows = [] } = {}) {
  const out = Object.fromEntries(windows.map(w => [w.id, 0]));
  for (const day of new Set(windows.map(w => w.day))) {
    for (const rec of recsOf(days, day)) {
      const u = unitOfRecord(windows, rec.t);
      if (u === null) continue;
      for (const t of Array.isArray(rec.trades) ? rec.trades : []) if (isObj(t) && isObj(t.roundTrip) && num(t.roundTrip.r) !== null) out[u] += t.roundTrip.r;
    }
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 10000) / 10000;
  return out;
}

const asConfig = windows => ({ kind: 'trend-set', windows: windows.map(w => ({ from: iso(w.from), to: iso(w.to) })) });

module.exports = { dayCloses, legSpan, windowsFor, windowStates, unitOfRecord, unitOfBar, unitR, asConfig };
