'use strict';

/**
 * The bar briefing (scripts/briefing.js; trading/briefing.js): the analysis of
 * the last closed bar by timeframe, as the autonomous runner built it, each
 * part with its version and how long it holds.
 *
 *   bar_briefing { symbol, json }   symbol: a contract root (MNQ and NQ share one)
 *   briefedThisCycle(env, symbol)   in an autonomous cycle, this bar's briefing for the symbol (null outside one, or
 *                                   when it isn't this bar's): the tools that recompute what it holds point to it
 */

const { readBriefing, renderBriefing, current } = require('../trading/briefing');
const { familyRoot } = require('../trading/contracts');
const { harnessHome } = require('../paths');
const { context } = require('./cli');

const USAGE = 'usage: briefing.js --symbol MNQ [--json]';

function barBriefing({ symbol = null, json = false } = {}, ctx) {
  const c = context(ctx);
  // A contract by month (MNQ:2027-03) reads its root's briefing.
  const root = /^([A-Z0-9]{1,8})(:\d{4}-\d{2})?$/.exec(String(symbol || ''));
  if (!root) throw new Error(`--symbol: a contract root, e.g. MNQ (${USAGE})`);
  const requested = symbol;
  symbol = root[1];
  const b = readBriefing(harnessHome(c.env), symbol);
  const fallback = 'Take the market facts from the bars yourself, with the tools you have (or, without them, the cycle prompt and the analysts\' reports), and say so in your report\'s Data line.';
  if (!b) return { text: `No bar briefing for ${symbol}: the autonomous runner builds it after each closed bar. ${fallback}\n` };
  // An old briefing (an earlier bar's, or yesterday's) is never served as this bar's: in an autonomous cycle, the bar
  // the cycle decides (FTH_CYCLE_BARS, from the runner) is the test, however long the cycle runs; else the clock.
  const cycleBar = cycleBarOf(c.env, symbol);
  if (cycleBar ? cycleBar !== b.asOf : !current(b, c.now())) return { text: `The bar briefing for ${symbol} is old (its bar closed ${b.closedAt}; it held until ${b.sections.m3.validUntil}): no current briefing. ${fallback}\n` };
  // This cycle's bar: rendered as of that bar, so no part reads as expired while the cycle decides it.
  // A month asked for that isn't the briefing's contract's month: say whose levels these are (months differ by carry;
  // a micro and its mini in the same month share prices).
  const month = id => (/:(\d{4}-\d{2})$/.exec(String(id || '')) || [])[1] || null;
  const note = root[2] && b.contractId && month(b.contractId) !== root[2].slice(1) ? `Note: you asked for ${requested}; this briefing is for ${b.contractId} (the runner's contract): its levels are that contract's.\n` : '';
  return { text: json ? `${JSON.stringify(b)}\n` : `${note}${renderBriefing(b, { now: cycleBar ? new Date(b.closedAt) : c.now() })}` };
}

/** The bar this cycle decides for `symbol`'s index family, or null outside a cycle (or a cycle without it). */
function cycleBarOf(env, symbol) {
  try {
    const bars = JSON.parse(env.FTH_CYCLE_BARS || '{}');
    const key = Object.keys(bars).find(k => familyRoot(k) === familyRoot(symbol));
    return key ? bars[key] : null;
  } catch (_err) {
    return null;
  }
}

/** argv to { symbol, json }. */
function parseArgv(argv) {
  const o = { symbol: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '--symbol') o.symbol = inline !== undefined ? inline : argv[++i];
    else if (flag === '--json') o.json = true;
    else throw new Error(`unknown argument: ${argv[i]} (${USAGE})`);
  }
  return o;
}

const OPS = { bar_briefing: barBriefing };

/** This cycle's briefing for the symbol (its family), or null: no cycle bar, no briefing, or another bar's. */
function briefedThisCycle(env, symbol) {
  let sym = symbol;
  if (!sym) {
    // Without a symbol: the cycle's only one, if it has one.
    try { const keys = Object.keys(JSON.parse(env.FTH_CYCLE_BARS || '{}')); sym = keys.length === 1 ? keys[0] : null; } catch (_err) { sym = null; }
  }
  const root = /^([A-Z0-9]{1,8})/.exec(String(sym || ''));
  if (!root) return null;
  const bar = cycleBarOf(env, root[1]);
  const b = bar ? readBriefing(harnessHome(env), root[1]) : null;
  return b && b.asOf === bar ? b : null;
}

module.exports = { OPS, USAGE, barBriefing, briefedThisCycle, parseArgv };
