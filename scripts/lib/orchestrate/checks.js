'use strict';

/**
 * The orchestration layer's named acceptance checks (docs/TOOL-CALLS-AND-ORCHESTRATION.md): what a role's result must
 * pass to count, named in a workflow document (`accept:`), each `(role, result, ctx) -> null | why`. A result is the
 * engine's: { text, tools, lookups } (its final message, the tools its run completed, the skills it looked up naming its
 * role). `ctx` the workflow's (`lookups`: role -> the skills the bar requires it to look up, the runner's from the gate's
 * own source, runner-wiring.js lookupNeeds). Harness-neutral: the engine adapter reads the tools from its harness's own
 * output.
 *
 *   CHECKS                     name -> check
 *   READS_NO_DATA              the harness tools that read no market or account data (skills, past decisions)
 *   readData(tools, servers)   true when one of them read market or account data
 */

const { ANALYSTS } = require('../trading/roles-ran');

const READS_NO_DATA = Object.freeze(['skill_lookup', 'experience_lookup']);
const RISK_MANAGER = 'risk-manager';

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
});

module.exports = { CHECKS, READS_NO_DATA, readData };
