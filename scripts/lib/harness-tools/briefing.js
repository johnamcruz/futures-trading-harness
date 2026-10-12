'use strict';

/**
 * The bar briefing (scripts/briefing.js; trading/briefing.js): the analysis of
 * the last closed bar by timeframe, as the autonomous runner built it, each
 * part with its version and how long it holds.
 *
 *   bar_briefing { symbol, json }   symbol: a contract root (MNQ and NQ share one)
 */

const { readBriefing, renderBriefing, current } = require('../trading/briefing');
const { harnessHome } = require('../paths');
const { context } = require('./cli');

const USAGE = 'usage: briefing.js --symbol MNQ [--json]';

function barBriefing({ symbol = null, json = false } = {}, ctx) {
  const c = context(ctx);
  if (!symbol || !/^[A-Z0-9]{1,8}$/.test(symbol)) throw new Error(`--symbol: a contract root, e.g. MNQ (${USAGE})`);
  const b = readBriefing(harnessHome(c.env), symbol);
  const fallback = 'Read the bars yourself (market_snapshot, mtf_read and strategies_scan on the bars file) and say so in your report\'s Data line.';
  if (!b) return { text: `No bar briefing for ${symbol}: the autonomous runner builds it after each closed bar. ${fallback}\n` };
  // An old briefing (an earlier bar's, or yesterday's) is never served as this bar's.
  if (!current(b, c.now())) return { text: `The bar briefing for ${symbol} is old (its bar closed ${b.closedAt}; it held until ${b.sections.m3.validUntil}): no current briefing. ${fallback}\n` };
  return { text: json ? `${JSON.stringify(b)}\n` : renderBriefing(b, { now: c.now() }) };
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

module.exports = { OPS, USAGE, barBriefing, parseArgv };
