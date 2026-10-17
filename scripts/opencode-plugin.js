'use strict';

/**
 * The runner's opencode plugin, loaded by every autonomous run's config (opencode.js runConfig): before a tool runs,
 * it refuses a task call naming a role the run denies (FTH_DENIED_ROLES, set by the runner: opencode.js runEnv), so
 * the task permission, and with it the head trader's prompt, stays the same from cycle to cycle. The check is
 * opencode.js deniedTaskRefusal; a refusal is the tool call's error, and the session goes on. It also drops a task_id
 * that names no session (opencode.js dropInventedTaskId), so a role launched with an invented one still runs; answers
 * a call to an unknown tool name with the name meant (toolNameHint); and guards repeated identical calls (repeatGuard).
 */

const { deniedTaskRefusal, dropInventedTaskId, toolNameHint, repeatGuard } = require('./lib/opencode');

async function DeniedRoles() {
  const repeats = repeatGuard();
  return {
    'tool.execute.before': async (input, output) => {
      const tool = input && input.tool;
      const args = output && output.args;
      dropInventedTaskId(tool, args);
      const why = deniedTaskRefusal(tool, args, process.env) || toolNameHint(tool, args) || repeats.before(tool, args, input && input.sessionID);
      if (why) throw new Error(why);
    },
    // A call that returned: the repeat guard's reminder after its result, at a reminder count (opencode.js repeatGuard).
    'tool.execute.after': async (input, output) => {
      const note = input ? repeats.after(input.tool, input.args, input.sessionID) : null;
      if (note && output && typeof output.output === 'string') output.output += note;
    },
  };
}

// opencode 1.x loads a CommonJS plugin file as { id, server } (a bare function or a named export is refused: "Plugin
// export is not a function"; a server without an id: "must export id"), and logs a load failure without stopping.
module.exports = { id: 'fth-denied-roles', server: DeniedRoles };
