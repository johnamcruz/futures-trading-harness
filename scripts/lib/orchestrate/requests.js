'use strict';

/**
 * The orchestration layer's named request builders (docs/TOOL-CALLS-AND-ORCHESTRATION.md): the one request each role
 * gets, built in code, named in a workflow document (`request:`). A role sees only its request, so it names what the
 * role needs and never says the data is provided.
 *
 *   REQUESTS   name -> (role, ctx) -> text; ctx { symbol, contractId, at, timeframe, bars, lookups } (`bars`: the cycle's
 *              bars file, the one the head trader's prompt names, so a role reads the cycle's own bars and never guesses a
 *              path; `lookups`: role -> the skills this bar requires it to look up, named so it does: checks.js lookups)
 *     desk     the desk's roles (the analysts, risk-manager phase 1)
 *     review   risk-manager phase 2 on the head trader's composed plan (the entry workflow); ctx adds { strategy, side,
 *              accountId, record (the compose record as text: trade-lifecycle.js renderRecord), reports: [{ role, text }]
 *              (the desk's and the cached reports, phase 1 among them) }
 *     execute  the trade-executor on the approved plan; ctx adds { args (order_plan's place_order arguments, built in
 *              code: runner-entry.js), verdict (phase 2's VERDICT line) }
 */

const RISK_MANAGER = 'risk-manager';

const what = (symbol, contractId) => `${symbol}${contractId ? ` (contractId ${contractId})` : ''}`;
const when = (timeframe, at) => `the ${timeframe}-minute bar that closed by ${at}`;
const barsFile = (bars, timeframe) => (bars ? ` Closed ${timeframe}-minute bars, oldest first, are in ${bars} (get_bars format): pass that exact path where a tool takes a bars file; don't fetch ${timeframe}-minute bars.` : '');
const lookupsOf = (role, lookups) => {
  const need = lookups && Array.isArray(lookups[role]) ? lookups[role] : [];
  return need.length ? ` This bar requires you to look up ${need.map(s => `\`${s}\``).join(', ')} before your report: \`skill_lookup {"skill": "<skill>", "role": "${role}"}\` for each (without them your report doesn't count).` : '';
};
const block = (name, text) => `\n--- ${name} ---\n${String(text || '').trim()}\n--- end of ${name} ---`;
const reportName = role => (role === RISK_MANAGER ? 'risk-manager phase 1 report' : `${role} report`);

const REQUESTS = Object.freeze({
  desk: (role, { symbol, contractId = null, at, timeframe, bars = null, lookups = {} }) => {
    const file = barsFile(bars, timeframe);
    const look = lookupsOf(role, lookups);
    if (role === RISK_MANAGER) return `Phase 1, risk state, for ${what(symbol, contractId)} at ${when(timeframe, at)}. Read the account and limits yourself (your phase 1 calls); no plan yet.${file}${look} Report in your phase 1 output format.`;
    return `Your report for ${what(symbol, contractId)} at ${when(timeframe, at)}. Read your own data first (bar_briefing for ${symbol}, then what your method needs).${file}${look} Report in your output format, its Data line first.`;
  },
  // Phase 2 on the composed plan: the record is the plan; its checks are the role's own (agents/risk-manager.md).
  review: (role, { symbol, contractId = null, at, timeframe, bars = null, lookups = {}, strategy, side, accountId = null, record = '', reports = [] }) => {
    const plan = { bars: bars || '<the cycle\'s bars file>', symbol, strategy, side, ...(Number.isInteger(accountId) ? { accountId } : {}) };
    return `Phase 2, plan verdict, for ${what(symbol, contractId)} at ${when(timeframe, at)}. The head trader's plan is its compose record for this bar (compose_check said OK), below: ${strategy} ${side}, its stop, target and size as the record states them.${barsFile(bars, timeframe)} Check it by your phase 2 steps: \`order_plan ${JSON.stringify(plan)}\` for its numbers, the bar briefing for the facts, then \`reason_check\` with your VERDICT and FACTS lines.${lookupsOf(role, lookups)} The desk's reports this cycle (phase 1's among them) are below; don't ask for them again. End with your VERDICT line, then your FACTS line last (your phase 2 output).`
      + block(`compose record (${symbol} ${side})`, record)
      + (Array.isArray(reports) ? reports : []).filter(r => r && typeof r.text === 'string' && r.text.trim()).map(r => block(reportName(r.role), r.text)).join('');
  },
  // The executor sends what code built: order_plan's arguments, with phase 2's line (agents/trade-executor.md).
  execute: (role, { symbol, contractId = null, at, timeframe, args, verdict }) => `Execute the approved plan for ${what(symbol, contractId)} at ${when(timeframe, at)}. The risk manager's line: ${String(verdict || '').trim()}. The place_order arguments from the harness tool order_plan, built by the runner from this bar's compose record: ${JSON.stringify(args)}. Send them as given (your Entry steps: the account read, then place_order with exactly these arguments, once; never resize, reprice or relabel them), read the reply, check the entry once, and report in your output format (EXECUTED, BLOCKED or ABORTED first).`,
});

module.exports = { REQUESTS };
