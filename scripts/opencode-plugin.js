'use strict';

/**
 * The tool-call layer's adapter for opencode (docs/TOOL-CALLS-AND-ORCHESTRATION.md), loaded by every autonomous run's
 * config (opencode.js runConfig): every tool call runs the layer's rules (toolcall/rules.js, through the pipeline) on
 * the events hooks/hooks.json declares (toolcall/hooks.js). Before a call: a repair changes its arguments, a refusal is
 * the call's error (the session goes on). After it returned: a note joins its result. Its call log is in memory, one
 * per run. opencode names a server's tool `<server>_<tool>`; the rules match canonical names (toolcall/names.js).
 */

const path = require('path');
const { createPipeline } = require('./lib/toolcall/pipeline');
const { createCallLog } = require('./lib/toolcall/call-log');
const { fromOpencode, toOpencode } = require('./lib/toolcall/names');
const { declaredEvents } = require('./lib/toolcall/hooks');

async function ToolCalls() {
  const events = declaredEvents(path.resolve(__dirname, '..'));
  const pipeline = createPipeline({ log: createCallLog(), env: process.env, native: toOpencode });
  const call = (input, args) => ({ tool: fromOpencode(input && input.tool), name: input && input.tool, args, session: input && input.sessionID, id: input && input.callID });
  return {
    'tool.execute.before': async (input, output) => {
      if (!events.has('pre') || !input) return;
      const { refuse } = pipeline.before(call(input, output && output.args));
      if (refuse) throw new Error(refuse);
    },
    'tool.execute.after': async (input, output) => {
      if (!events.has('post') || !input) return;
      // An MCP tool's result is its raw { content: [...] } here (opencode joins the text items into the output after
      // this hook: v1.19 session/tools.ts); a built-in tool's has its output string.
      const text = output && Array.isArray(output.content)
        ? output.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n')
        : (output && typeof output.output === 'string' ? output.output : undefined);
      const { note } = pipeline.after(call(input, input.args), { text });
      if (!note || !output) return;
      if (Array.isArray(output.content)) output.content.push({ type: 'text', text: note });
      else if (typeof output.output === 'string') output.output += `\n\n${note}`;
    },
  };
}

// opencode 1.x loads a CommonJS plugin file as { id, server } (a bare function or a named export is refused: "Plugin
// export is not a function"; a server without an id: "must export id"), and logs a load failure without stopping.
module.exports = { id: 'fth-tool-calls', server: ToolCalls };
