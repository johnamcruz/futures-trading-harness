'use strict';

/**
 * The bar briefing (scripts/briefing.js; trading/briefing.js): the analysis of
 * the last closed bar by timeframe, as the autonomous runner built it, each
 * part with its version and how long it holds.
 *
 *   bar_briefing { symbol, timeframe, json }   symbol: a contract root (MNQ and NQ share one); timeframe ("15m",
 *                                   "1h"): an analyst's own timeframe's briefing (the runner builds one for each analyst
 *                                   configured on it), with the runner's parts it shares; none or the runner's: its own
 *   briefedThisCycle(env, symbol, clockAt)   (clockAt: the replay clock, default replayAt(env)) in an autonomous cycle, this bar's briefing for the symbol (null outside one, or
 *                                   when it isn't this bar's): the tools that recompute what it holds point to it
 */

const { readBriefing, renderBriefing, current, readFrameBriefing, renderFrameBriefing, frameHolds, sharedParts } = require('../trading/briefing');
const { familyRoot } = require('../trading/contracts');
const { harnessHome } = require('../paths');
const { context } = require('./cli');
const { briefingAfterClock } = require('../trading/look-ahead');
const { replayAt } = require('../trading/harness-now');

const USAGE = 'usage: briefing.js --symbol MNQ [--timeframe 15m] [--json]';
const TIMEFRAME = /^([1-9]\d*)(m|h)$/;

function barBriefing({ symbol = null, json = false, timeframe = null } = {}, ctx) {
  const c = context(ctx);
  // A contract by month (MNQ:2027-03) reads its root's briefing.
  const root = /^([A-Z0-9]{1,8})(:\d{4}-\d{2})?$/.exec(String(symbol || ''));
  if (!root) throw new Error(`--symbol: a contract root, e.g. MNQ (${USAGE})`);
  const requested = symbol;
  symbol = root[1];
  const b = readBriefing(harnessHome(c.env), symbol);
  const fallback = 'Take the market facts from the bars yourself, with the tools you have (or, without them, the cycle prompt and the analysts\' reports), and say so in your report\'s Data line.';
  if (!b) return { text: `No bar briefing for ${symbol}: the autonomous runner builds it after each closed bar. ${fallback}\n` };
  // Under a replay clock, never a briefing of a bar that closed after it (no look-ahead: trading/look-ahead.js).
  const later = briefingAfterClock(b, c.replayAt());
  if (later) return { text: `The bar briefing for ${symbol} is not served: ${later}. ${fallback}\n` };
  // An old briefing (an earlier bar's, or yesterday's) is never served as this bar's: in an autonomous cycle, the bar
  // the cycle decides (FTH_CYCLE_BARS, from the runner) is the test, however long the cycle runs; else the clock.
  // Several lanes: the runner names the bar the briefing is on (FTH_CYCLE_BRIEFING_BARS, the first lane's).
  const cycleBar = cycleBarOf(c.env, symbol, 'FTH_CYCLE_BRIEFING_BARS') || cycleBarOf(c.env, symbol);
  if (cycleBar ? cycleBar !== b.asOf : !current(b, c.now())) return { text: `The bar briefing for ${symbol} is old (its bar closed ${b.closedAt}; it held until ${b.sections.m3.validUntil}): no current briefing. ${fallback}\n` };
  const tf = timeframe === null || timeframe === undefined ? null : TIMEFRAME.exec(String(timeframe));
  if (timeframe !== null && timeframe !== undefined && !tf) throw new Error(`--timeframe: e.g. 15m or 1h (${USAGE})`);
  const minutes = tf ? Number(tf[1]) * (tf[2] === 'h' ? 60 : 1) : b.minutes;
  if (minutes !== b.minutes) return frameText(c, symbol, minutes, b, { json, fallback });
  // This cycle's bar: rendered as of that bar, so no part reads as expired while the cycle decides it.
  // A month asked for that isn't the briefing's contract's month: say whose levels these are (months differ by carry;
  // a micro and its mini in the same month share prices).
  const month = id => (/:(\d{4}-\d{2})$/.exec(String(id || '')) || [])[1] || null;
  const note = root[2] && b.contractId && month(b.contractId) !== root[2].slice(1) ? `Note: you asked for ${requested}; this briefing is for ${b.contractId} (the runner's contract): its levels are that contract's.\n` : '';
  return { text: json ? `${JSON.stringify(b)}\n` : `${note}${renderBriefing(b, { now: cycleBar ? new Date(b.closedAt) : c.now() })}` };
}

/**
 * The briefing on an analyst's own timeframe, with the runner's parts it shares (the runner's briefing is this
 * cycle's: checked by the caller). Its bar must be the one holding at the cycle's start (FTH_CYCLE_AT, from the
 * runner, however long the cycle runs), else at the clock; under a replay clock never one closed after it.
 */
function frameText(c, symbol, minutes, first, { json, fallback }) {
  const f = readFrameBriefing(harnessHome(c.env), symbol, minutes);
  if (!f) return { text: `No ${minutes}m bar briefing for ${symbol}: the runner builds one only for an analyst configured on ${minutes}m (the runner config's agents). ${fallback}\n` };
  const later = briefingAfterClock(f, c.replayAt());
  if (later) return { text: `The ${minutes}m bar briefing for ${symbol} is not served: ${later}. ${fallback}\n` };
  const at = Number.isFinite(Date.parse(c.env.FTH_CYCLE_AT)) ? new Date(c.env.FTH_CYCLE_AT) : c.now();
  if (!frameHolds(f, at)) return { text: `The ${minutes}m bar briefing for ${symbol} is old (its bar closed ${f.closedAt}; it held until ${f.sections.bar.validUntil}): no current ${minutes}m briefing. ${fallback}\n` };
  if (json) return { text: `${JSON.stringify({ ...f, shared: Object.fromEntries(sharedParts(minutes).filter(p => first.sections[p]).map(p => [p, first.sections[p]])) })}\n` };
  return { text: renderFrameBriefing(f, first, { now: new Date(Math.max(at.getTime(), Date.parse(f.closedAt))) }) };
}

/** The bar this cycle decides for `symbol`'s index family, or null outside a cycle (or a cycle without it). */
function cycleBarOf(env, symbol, name = 'FTH_CYCLE_BARS') {
  try {
    const bars = JSON.parse(env[name] || '{}');
    const key = Object.keys(bars).find(k => familyRoot(k) === familyRoot(symbol));
    return key ? bars[key] : null;
  } catch (_err) {
    return null;
  }
}

/** argv to { symbol, json }. */
function parseArgv(argv) {
  const o = { symbol: null, json: false, timeframe: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '--symbol') o.symbol = inline !== undefined ? inline : argv[++i];
    else if (flag === '--json') o.json = true;
    else if (flag === '--timeframe') o.timeframe = inline !== undefined ? inline : argv[++i];
    else throw new Error(`unknown argument: ${argv[i]} (${USAGE})`);
  }
  return o;
}

const OPS = { bar_briefing: barBriefing };

/** This cycle's briefing for the symbol (its family), or null: no cycle bar, no briefing, or another bar's. */
function briefedThisCycle(env, symbol, clockAt = () => replayAt(env)) {
  let sym = symbol;
  if (!sym) {
    // Without a symbol: the cycle's only one, if it has one.
    try { const keys = Object.keys(JSON.parse(env.FTH_CYCLE_BARS || '{}')); sym = keys.length === 1 ? keys[0] : null; } catch (_err) { sym = null; }
  }
  const root = /^([A-Z0-9]{1,8})/.exec(String(sym || ''));
  if (!root) return null;
  const bar = cycleBarOf(env, root[1]);
  const b = bar ? readBriefing(harnessHome(env), root[1]) : null;
  return b && b.asOf === bar && !afterReplayClock(clockAt, b) ? b : null;
}

/** A briefing whose bar closed after the replay clock (or a refused clock: then the caller reads the bars, and is refused there). */
function afterReplayClock(clockAt, b) {
  try {
    return Boolean(briefingAfterClock(b, clockAt()));
  } catch (_err) {
    return true;
  }
}

module.exports = { OPS, USAGE, barBriefing, briefedThisCycle, cycleBarOf, parseArgv };
