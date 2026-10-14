'use strict';

/**
 * The runner's opencode plugin, loaded by every autonomous run's config (opencode.js runConfig): before a tool runs,
 * it refuses a task call naming a role the run denies (FTH_DENIED_ROLES, set by the runner: opencode.js runEnv), so
 * the task permission, and with it the head trader's prompt, stays the same from cycle to cycle. The check is
 * opencode.js deniedTaskRefusal; a refusal is the tool call's error, and the session goes on.
 */

const { deniedTaskRefusal } = require('./lib/opencode');

async function DeniedRoles() {
  return {
    'tool.execute.before': async (input, output) => {
      const why = deniedTaskRefusal(input && input.tool, output && output.args, process.env);
      if (why) throw new Error(why);
    },
  };
}

// opencode 1.x loads a CommonJS plugin file as { id, server } (a bare function or a named export is refused: "Plugin
// export is not a function"; a server without an id: "must export id"), and logs a load failure without stopping.
module.exports = { id: 'fth-denied-roles', server: DeniedRoles };
