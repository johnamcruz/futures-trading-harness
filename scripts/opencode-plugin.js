'use strict';

/**
 * The runner's opencode plugin, loaded by every autonomous run's config (opencode.js runConfig): before a tool runs,
 * it refuses a task call naming a role the run denies (FTH_DENIED_ROLES, set by the runner: opencode.js runEnv), so
 * the task permission, and with it the head trader's prompt, stays the same from cycle to cycle. The check is
 * opencode.js deniedTaskRefusal; a refusal is the tool call's error, and the session goes on. It also drops a task_id
 * that names no session (opencode.js dropInventedTaskId), so a role launched with an invented one still runs; answers
 * a call to an unknown tool name with the name meant (toolNameHint); guards repeated identical calls (repeatGuard); and
 * holds the head trader's compose_check until the cycle's desk reported (deskGate).
 */

const { deniedTaskRefusal, dropInventedTaskId, toolNameHint, repeatGuard, deskGate } = require('./lib/opencode');

async function DeniedRoles() {
  const repeats = repeatGuard();
  const desk = deskGate(process.env);
  return {
    'tool.execute.before': async (input, output) => {
      const tool = input && input.tool;
      const args = output && output.args;
      dropInventedTaskId(tool, args);
      desk.saw(tool, input && input.sessionID);
      const why = deniedTaskRefusal(tool, args, process.env) || toolNameHint(tool, args) || desk.before(tool, input && input.sessionID)
        || repeats.before(tool, args, input && input.sessionID, input && input.callID);
      if (why) throw new Error(why);
    },
    // A call that returned: the repeat guard's reminder after its result, at a reminder count (opencode.js repeatGuard).
    'tool.execute.after': async (input, output) => {
      // A role launch that returned counts for the desk (opencode.js deskGate).
      if (input) desk.returned(input.tool, input.args, input.sessionID, output);
      // The result's text, for the guard's same-answer check: an MCP result's text items, a built-in tool's output.
      const text = output && Array.isArray(output.content)
        ? output.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n')
        : (output && typeof output.output === 'string' ? output.output : undefined);
      const note = input ? repeats.after(input.tool, input.args, input.sessionID, input.callID, text) : null;
      if (!note || !output) return;
      // An MCP tool's result is its raw { content: [...] } here (opencode joins the text items into the output after
      // this hook); a built-in tool's has its output string.
      if (Array.isArray(output.content)) output.content.push({ type: 'text', text: note.trim() });
      else if (typeof output.output === 'string') output.output += note;
    },
  };
}

// opencode 1.x loads a CommonJS plugin file as { id, server } (a bare function or a named export is refused: "Plugin
// export is not a function"; a server without an id: "must export id"), and logs a load failure without stopping.
module.exports = { id: 'fth-denied-roles', server: DeniedRoles };
