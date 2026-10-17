'use strict';

/**
 * The orchestration layer's named acceptance checks (docs/TOOL-CALLS-AND-ORCHESTRATION.md): what a role's result must
 * pass to count, named in a workflow document (`accept:`), each `(role, result, ctx) -> null | why`. A result is the
 * engine's: { text, tools, lookups } (its final message, the tools its run completed, the skills it looked up naming its
 * role). `ctx` the workflow's (`lookups`: role -> the skills the bar requires it to look up, the runner's from the gate's
 * own source, runner-wiring.js lookupNeeds). Harness-neutral: the engine adapter reads the tools from its harness's own
 * output.
 *
 *   CHECKS                     name -> check (`verdict-facts`: risk-manager phase 2's report, a verdict and its FACTS
 *                              line, read by the order gate's own readers; `order-sent`: the trade-executor's run called
 *                              the order tool, or reported a refusal)
 *   ORDER_REFUSED              a report's refusal line (agents/trade-executor.md output: BLOCKED or ABORTED first)
 *   READS_NO_DATA              the harness tools that read no market or account data (skills, past decisions)
 *   readData(tools, servers)   true when one of them read market or account data
 */

const { ANALYSTS, verdictOf } = require('../trading/roles-ran');
const { factsLines } = require('../trading/fact-claims');

const READS_NO_DATA = Object.freeze(['skill_lookup', 'experience_lookup']);
const RISK_MANAGER = 'risk-manager';

// The trade-executor's own word that nothing was opened (its output format's first line: BLOCKED or ABORTED).
const ORDER_REFUSED = /^[\s*_`#>]*(BLOCKED|ABORTED)\b/m;

function readData(tools, { harnessServer = 'harness', brokerServer = 'broker' } = {}) {
  return (Array.isArray(tools) ? tools : []).some(t => typeof t === 'string' && (t.startsWith(`${brokerServer}_`) || t === 'read'
    || (t.startsWith(`${harnessServer}_`) && !READS_NO_DATA.includes(t.slice(harnessServer.length + 1)))));
}

const CHECKS = Object.freeze({
  // Its own run read data (a subagent sees only its request: a report from no read is empty or invented).
  'read-data': (role, r) => (readData(r && r.tools) ? null : 'read no data'),
  // Its role's report shape: an analyst's names what it rests on; phase 1 is a risk state.
  'report-shape': (role, r) => {
    const text = r && typeof r.text === 'string' ? r.text : '';
    if (!text.trim()) return 'no report';
    if (ANALYSTS.includes(role) && !/^\s*Data:/m.test(text)) return 'no Data line (its report names what it rests on)';
    if (role === RISK_MANAGER && !/Risk state/i.test(text)) return 'not a phase 1 risk state';
    return null;
  },
  // Index mode: it looked up every skill its bar requires of its role (the order gate counts its report only then:
  // roles-ran.js, skill-lookups.js unmetLookups, which reads the same recorded lookups). None required: nothing to check.
  lookups: (role, r, ctx) => {
    const need = ctx && ctx.lookups && Array.isArray(ctx.lookups[role]) ? ctx.lookups[role] : [];
    const have = r && Array.isArray(r.lookups) ? r.lookups : [];
    const missing = need.filter(s => !have.includes(s));
    return missing.length ? `didn't look up ${missing.join(', ')} (this bar requires it of its role)` : null;
  },
  // Risk-manager phase 2 (agents/risk-manager.md): its verdict and the FACTS line it rests on, read by the order gate's
  // own readers (roles-ran.js verdictOf, fact-claims.js factsLines), never a second definition. A VETO is a report.
  'verdict-facts': (role, r) => {
    const text = r && typeof r.text === 'string' ? r.text : '';
    if (!text.trim()) return 'no report';
    if (verdictOf(text) === null) return 'no VERDICT line (phase 2 ends with "VERDICT: APPROVE ..." or "VERDICT: VETO ...")';
    if (factsLines(text) === null) return 'no FACTS line (the facts its verdict rests on, last)';
    return null;
  },
  // The trade-executor's run sent the order (its place_order call completed: the gate let it through), or it reported
  // the refusal (a gate or broker refusal fails the call, so it shows only in its report).
  'order-sent': (role, r, ctx) => {
    const broker = (ctx && ctx.brokerServer) || require('../broker/config').SERVER_NAME;
    const tools = r && Array.isArray(r.tools) ? r.tools : [];
    if (tools.includes(`${broker}_place_order`)) return null;
    const text = r && typeof r.text === 'string' ? r.text : '';
    return ORDER_REFUSED.test(text) ? null : 'no order call and no refusal reported';
  },
});

module.exports = { CHECKS, READS_NO_DATA, ORDER_REFUSED, readData };
