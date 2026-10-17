'use strict';

/**
 * The orchestration layer's named acceptance checks (docs/TOOL-CALLS-AND-ORCHESTRATION.md): what a role's result must
 * pass to count, named in a workflow document (`accept:`), each `(role, result) -> null | why`. A result is the
 * engine's: { text, tools } (its final message, the tools its run completed). Harness-neutral: the engine adapter reads
 * the tools from its harness's own output.
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
});

module.exports = { CHECKS, READS_NO_DATA, readData };
