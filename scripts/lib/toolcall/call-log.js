'use strict';

/**
 * The tool-call layer's call log (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "One call log"): what the rules keep between a
 * session's calls, one state per rule and session. In memory for a harness whose rules run in-process (the opencode
 * plugin, one per run); in a file for one whose hooks start a process per call (Claude Code: `file`, under the harness
 * home), read on open and written on `save`. A state is a plain object the rule changes in place.
 *
 *   createCallLog({ file })   { state(rule, session), save() }
 */

const fs = require('fs');
const path = require('path');

function createCallLog({ file = null } = {}) {
  let all = {};
  if (file) {
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_err) { all = {}; }
  }
  return {
    state(rule, session) {
      const key = `${rule}\u0000${String(session || '')}`;
      if (!all[key] || typeof all[key] !== 'object') all[key] = {};
      return all[key];
    },
    save() {
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all));
      fs.renameSync(tmp, file);
    },
  };
}

module.exports = { createCallLog };
