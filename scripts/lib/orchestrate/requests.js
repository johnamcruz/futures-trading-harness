'use strict';

/**
 * The orchestration layer's named request builders (docs/TOOL-CALLS-AND-ORCHESTRATION.md): the one request each role
 * gets, built in code, named in a workflow document (`request:`). A role sees only its request, so it names what the
 * role needs and never says the data is provided.
 *
 *   REQUESTS   name -> (role, ctx) -> text; ctx { symbol, contractId, at, timeframe, bars } (`bars`: the cycle's bars file,
 *              the one the head trader's prompt names, so a role reads the cycle's own bars and never guesses a path)
 */

const RISK_MANAGER = 'risk-manager';

const REQUESTS = Object.freeze({
  desk: (role, { symbol, contractId = null, at, timeframe, bars = null }) => {
    const what = `${symbol}${contractId ? ` (contractId ${contractId})` : ''}`;
    const when = `the ${timeframe}-minute bar that closed by ${at}`;
    const file = bars ? ` Closed ${timeframe}-minute bars, oldest first, are in ${bars} (get_bars format): pass that exact path where a tool takes a bars file; don't fetch ${timeframe}-minute bars.` : '';
    if (role === RISK_MANAGER) return `Phase 1, risk state, for ${what} at ${when}. Read the account and limits yourself (your phase 1 calls); no plan yet.${file} Report in your phase 1 output format.`;
    return `Your report for ${what} at ${when}. Read your own data first (bar_briefing for ${symbol}, then what your method needs).${file} Report in your output format, its Data line first.`;
  },
});

module.exports = { REQUESTS };
