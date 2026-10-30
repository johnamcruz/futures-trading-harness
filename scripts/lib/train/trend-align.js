'use strict';

/**
 * Which census legs enter a trend pool (Propose-Probe-Compose, docs/TRAINING.md, "The trend curriculum"), by the loop's
 * probe.trend settings (probe-config.js resolveTrend), each off by default (config/training.json trendSet):
 *
 *   align 'htf'      only legs the owner's top-down rule could trade: at the leg's start the 4h and the 1h both trend the
 *                    leg's way, read by the policy's own check (entry-rule.js entryProblems with bias_frames [4h, 1h] and
 *                    bias_agree on: the hard rule the gate holds, never a copy of it), on the 4h and 1h trends the
 *                    briefing of the bar before the leg's start bar gives (briefing.js htfTrendsOf: the read as of the
 *                    last 1h close, from the bars closed by the start bar's open, the runner's kept history: causal);
 *                    a trend the bars can't read yet (too little history) is no agreement: the leg is dropped.
 *                    'all': every leg, as before
 *   opening 'drop'   no leg inside the opening print (the runner's first no-entry window, config/runner.json
 *                    gate.noEntryWindows, the one holding the cash open, in the market's time zone): one that starts and ends in it, or one of
 *                    openingMaxBars base bars or fewer that starts in it (no entry could catch it). 'keep': as before
 *
 *   ALIGN, OPENING
 *   htfSeries(bars, minutes)                    { bars, times, minutes }: the base bars, indexed by their open time
 *   trendsAt(series, start)                     { '4h', '1h': 'up' | 'down' | 'range' | null }: the briefing's, as of the
 *                                               bars closed by start (the bar before it, and the history before that)
 *   aligned(side, trends, frames)               whether the frames all trend the side's way (entry-rule.js, bias_agree)
 *   openingWindow(spec)                         the no-entry window holding the cash open ({ start, end, timeZone },
 *                                               minutes of the day), from spec (config/runner.json gate.noEntryWindows by default)
 *   inOpening(span, { window, minutes, maxBars })   whether a leg is the opening print's (see opening above)
 *   filterLegs(ids, spans, { align, opening, series, minutes, window, maxBars })
 *                                               { kept: [id], dropped: { align: [id], opening: [id] } } in the ids' order
 */

const { HISTORY_HOURS } = require('../trading/mtf');
const { htfTrendsOf } = require('../trading/briefing');
const { BIAS_FRAMES, entryRuleOf, entryProblems } = require('../trading/entry-rule');
const { parseWindows, inWindow, MARKET_TZ, RTH_OPEN_MIN } = require('../trading/clock');

const ALIGN = Object.freeze(['all', 'htf']);
const OPENING = Object.freeze(['keep', 'drop']);
/** The base bars, by their open time, for trendsAt. */
function htfSeries(bars, minutes) {
  return { bars, times: bars.map(b => Date.parse(b.t)), minutes };
}

/** The last index whose bar opened before ms (its close at or before ms), or -1. */
function lastBefore(times, ms) {
  let lo = 0;
  let hi = times.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < ms) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}

/**
 * The 4h and 1h trends the briefing of the bar before the leg's start bar gives: its bars, those closed by the start
 * bar's open within the runner's kept history (mtf.js HISTORY_HOURS), never the leg's own.
 */
function trendsAt(series, start) {
  const i = lastBefore(series.times, Date.parse(start));
  if (i < 0) return { '4h': null, '1h': null };
  const from = series.times[i] - HISTORY_HOURS * 3600000;
  const j = lastBefore(series.times, from) + 1;
  return htfTrendsOf(series.bars.slice(j, i + 1), series.minutes);
}

/** The policy's top-down check (bias_frames with bias_agree on) on a briefing holding only these trends. */
function aligned(side, trends, frames = BIAS_FRAMES) {
  const rule = entryRuleOf({ bias_frames: [...frames], bias_agree: 'on', regime_against: 'off', leg_turned: 'off' });
  const data = { h1: { trend: trends['1h'] }, h4: { trend: trends['4h'] } };
  return entryProblems({ briefing: { sections: { h1: { data } } }, side, reads: [], rule }).length === 0;
}

/** The runner's no-entry window that holds the cash open (09:30 New York time), or null when it lists none. */
function openingWindow(spec = require('../tunables').runner().gate.noEntryWindows) {
  const { windows } = parseWindows(Array.isArray(spec) ? spec.join(',') : spec);
  return windows.find(w => w.timeZone === MARKET_TZ && w.start <= RTH_OPEN_MIN && RTH_OPEN_MIN < w.end) || null;
}

const inside = (ms, w) => inWindow(new Date(ms), w);

/** Whether a leg is the opening print's: it starts and ends in the window, or it starts there and is maxBars bars or fewer. */
function inOpening(span, { window, minutes, maxBars }) {
  if (!window) return false;
  const s = Date.parse(span.start);
  const e = Date.parse(span.end);
  if (!inside(s, window)) return false;
  const bars = Math.round((e - s) / (minutes * 60000)) + 1;
  return inside(e, window) || bars <= maxBars;
}

function filterLegs(ids, spans, { align = 'all', opening = 'keep', series = null, minutes, window = null, maxBars } = {}) {
  if (!ALIGN.includes(align)) throw new Error(`align: ${ALIGN.join(' or ')}, not ${JSON.stringify(align)}`);
  if (!OPENING.includes(opening)) throw new Error(`opening: ${OPENING.join(' or ')}, not ${JSON.stringify(opening)}`);
  if (align === 'htf' && !series) throw new Error('align htf: the bars to read the 4h and 1h trend at each leg\'s start (probe.trend.bars)');
  const kept = [];
  const dropped = { align: [], opening: [] };
  for (const id of ids) {
    const g = spans[id];
    if (!g) throw new Error(`no span for leg ${id}`);
    if (opening === 'drop' && inOpening(g, { window, minutes, maxBars })) { dropped.opening.push(id); continue; }
    if (align === 'htf' && !aligned(g.side, trendsAt(series, g.start))) { dropped.align.push(id); continue; }
    kept.push(id);
  }
  return { kept, dropped };
}

module.exports = { ALIGN, OPENING, htfSeries, trendsAt, aligned, openingWindow, inOpening, filterLegs, lastBefore };
