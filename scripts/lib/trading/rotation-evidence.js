'use strict';

/**
 * The briefing's Rotation evidence line: four facts the briefing already computes, restated side by side as VALUES (no
 * verdict, no threshold of its own, nothing decides on it): the RTH VWAP crosses in the last crossBars bars (the VWAP line's count, never the Day so far line's since the open:
 * `m3.vwap.rthCrossesLast30`), the IB day type (`m3.today.dayType`, day-context.js), whether the setup and entry
 * candles are inside or doji (`m3.candles`, candle-facts.js patterns: every pattern that holds, so an inside hidden
 * behind a higher label still counts), and per 3m, 5m and 15m whether the last completed candle swept its previous high
 * or low and closed back inside (a failed break: candle-facts.js `sweep`, closedBack). Closed vocabulary; a value the
 * briefing doesn't hold (missing, unavailable, off the vocabulary) is unknown, never 0 or no. Every input is a
 * closed-bar fact of the briefing, so the line reads no bar after the cycle bar. Pure: no files, no clock.
 *
 *   DAY_TYPES                         day-context.js dayType's words
 *   rotationEvidence(m3, { setup, entry })   { vwapCrosses, dayType, setupCandle, entryCandle, failedBreak: { 3m, 5m, 15m } }
 *                                     (null: unknown; a candle 'inside', 'doji', 'inside and doji' or 'neither'; a
 *                                     failed break 'high', 'low', 'high and low' or 'no')
 *   rotationLine(e, { setup, entry }) the summary's line, or null without evidence
 */

const DAY_TYPES = Object.freeze(['trend up', 'trend down', 'normal variation up', 'normal variation down', 'neutral', 'inside the initial balance']);
// The window of the VWAP line's RTH count (market-snapshot.js rthCrossesLast30: the regime's crossBars); the Day so far
// line counts since the open, so each count says its own window.
const CROSS_BARS = require('./regime').REGIME_PARAMS.crossBars;
const BREAK_FRAMES = Object.freeze(['3m', '5m', '15m']);
const SIDES = new Set(['high', 'low', 'high and low']);

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const candleOf = (m3, tf) => (isObj(m3) && isObj(m3.candles) && isObj(m3.candles[tf]) && !m3.candles[tf].unavailable ? m3.candles[tf] : null);

/** A candle's inside/doji word, or null (no candle, or no pattern). */
function shapeOf(c) {
  if (!c || typeof c.pattern !== 'string') return null;
  const all = Array.isArray(c.patterns) ? c.patterns : [c.pattern];
  const inside = all.includes('inside');
  const doji = all.includes('doji');
  return inside && doji ? 'inside and doji' : inside ? 'inside' : doji ? 'doji' : 'neither';
}

/**
 * A candle's failed break: the side it swept and closed back inside from, 'no' (sweep null: it stayed inside its previous
 * candle), or null (no candle, or no sweep field: candle-facts gives none without a previous candle).
 */
function failedOf(c) {
  if (!c) return null;
  if (c.sweep === null) return 'no';
  if (!isObj(c.sweep) || typeof c.sweep.closedBack !== 'boolean') return null;
  if (!c.sweep.closedBack) return 'no';
  const side = typeof c.sweep.of === 'string' ? c.sweep.of.replace(/^previous \S+ /, '') : null;
  return SIDES.has(side) ? side : null;
}

function rotationEvidence(m3, { setup, entry } = {}) {
  const x = isObj(m3) ? m3 : {};
  const n = isObj(x.vwap) ? x.vwap.rthCrossesLast30 : null;
  const d = isObj(x.today) ? x.today.dayType : null;
  return {
    vwapCrosses: Number.isInteger(n) && n >= 0 ? n : null,
    dayType: DAY_TYPES.includes(d) ? d : null,
    setupCandle: shapeOf(candleOf(x, setup)),
    entryCandle: shapeOf(candleOf(x, entry)),
    failedBreak: Object.fromEntries(BREAK_FRAMES.map(tf => [tf, failedOf(candleOf(x, tf))])),
  };
}

const say = v => (v === null || v === undefined ? 'unknown' : String(v));

function rotationLine(e, { setup, entry } = {}) {
  if (!isObj(e) || !isObj(e.failedBreak)) return null;
  const breaks = BREAK_FRAMES.map(tf => `${tf} ${say(e.failedBreak[tf])}`).join(', ');
  return `- Rotation evidence (values, not a verdict): RTH VWAP crosses in the last ${CROSS_BARS} bars ${say(e.vwapCrosses)} (the VWAP line's count); IB day type ${say(e.dayType)}; `
    + `${setup} setup candle ${say(e.setupCandle)}, ${entry} entry candle ${say(e.entryCandle)}; failed break (swept the previous high or low, closed back inside): ${breaks}.`;
}

module.exports = { DAY_TYPES, BREAK_FRAMES, rotationEvidence, rotationLine };
