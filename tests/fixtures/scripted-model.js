'use strict';

/**
 * A scripted model in place of the spawned harness (scripts/lib/cycle-run.js `deps.run`, the runHarness shape): it
 * plays one cycle from a script and writes the cycle's transcript as opencode 1.x prints it (`run --format json`,
 * tests/fixtures/opencode-cycle-transcript.jsonl), streamed to FTH_CYCLE_TRANSCRIPT event by event as the runner's
 * live writer does, so the order gate reads it mid-cycle exactly as it reads a real one. Every tool goes to the real
 * thing with the cycle's environment (the runner's childEnv): the harness tools server (scripts/harness-tools-mcp.js:
 * bar_briefing, order_plan, skill_lookup, which records a role's lookup for the gate) and the order gateway
 * (scripts/mcp-gateway.js) in front of the configured broker. Nothing here decides: the script does.
 *
 * A script is a list of steps, played in order:
 *
 *   { load: '<skill>' }                       the head trader loads a skill (opencode's skill tool)
 *   { lookup: '<skill>', as? }                the head trader reads one with skill_lookup (no role: not recorded; `as`
 *                                             a role: recorded for that role, outside any call of its)
 *   { role, lookups: [skills], report }       a subagent call (opencode's task tool): its lookups made through the
 *                                             real skill_lookup naming the role, inside the call's wall-clock window;
 *                                             `report` its reply (a function of ctx allowed). `timed: false`: the
 *                                             event carries no times (an opencode build that doesn't print them)
 *   { harness: '<tool>', args }               the head trader calls a harness tool (harness_<tool>); its reply
 *                                             parsed into ctx.results[<tool>] when JSON
 *   { broker: '<tool>', args }                the head trader calls a broker tool through the gateway (broker_<tool>);
 *                                             its reply in ctx.results[<tool>]
 *   { executor: [{ broker, args }, ...] }     the trade-executor subagent: its broker calls through the gateway (a
 *                                             subagent's own calls are not in opencode's main transcript), then its
 *                                             task event, printed when it ends, as opencode prints it
 *   { act: async ctx => {} }                  the test acting mid-cycle (a stale briefing, an unreadable transcript)
 *   { result: '<CYCLE RESULT line>' }         the final message
 *
 * `args` may be a function of ctx. ctx: { env, prompt, results, calls: [{ tool, args, ok, text }] } where every
 * gateway and harness-tool call lands; `scripted.last` is the last cycle's ctx.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SESSION = 'ses_scripted';
const { createMcpClient } = require(path.join(ROOT, 'scripts', 'lib', 'broker', 'mcp-client'));

const val = (x, ctx) => (typeof x === 'function' ? x(ctx) : x);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A run (argv, { env, liveFile }) -> { ok, timedOut, code, output, stdout } that plays `script(prompt, env)`. */
function scriptedModel(script) {
  const scripted = async (argv, { env, liveFile }) => {
    const prompt = String(argv[argv.length - 1] || '');
    const steps = typeof script === 'function' ? script(prompt, env) : script;
    const ctx = { env, prompt, results: {}, calls: [], liveFile };
    scripted.last = ctx;
    let out = '';
    // As the runner's live writer: a new file of this run's own, each event appended as it is printed.
    if (liveFile) {
      fs.mkdirSync(path.dirname(liveFile), { recursive: true });
      try { fs.unlinkSync(liveFile); } catch (_err) { /* none */ }
      fs.writeFileSync(liveFile, '');
    }
    let id = 0;
    let last = 0;
    // Wall-clock ms, strictly increasing: a call's window starts after the one before it ended.
    const tick = async () => { await sleep(2); last = Math.max(Date.now(), last + 1); return last; };
    const emit = ev => {
      const line = `${JSON.stringify({ ...ev, timestamp: Date.now(), sessionID: SESSION })}\n`;
      out += line;
      if (liveFile) try { fs.appendFileSync(liveFile, line); } catch (_err) { /* removed by the test: the gate reads none */ }
    };
    const toolEvent = (tool, input, state) => emit({ type: 'tool_use', part: { type: 'tool', tool, callID: `call_${(id += 1)}`, sessionID: SESSION, state: { input, ...state } } });
    let gateway = null;
    let tools = null;
    const gw = () => (gateway = gateway || createMcpClient({ command: process.execPath, args: [path.join(ROOT, 'scripts', 'mcp-gateway.js')], env, cwd: ROOT, timeoutMs: 30000 }));
    const ht = () => (tools = tools || createMcpClient({ command: process.execPath, args: [path.join(ROOT, 'scripts', 'harness-tools-mcp.js')], env, cwd: ROOT, timeoutMs: 60000 }));
    const callGateway = async (tool, args) => {
      // The whole reply, as the model reads it (a refusal names every check).
      let ok;
      let text;
      try {
        const r = await gw().request('tools/call', { name: tool, arguments: args });
        ok = !r.isError;
        text = (r.content || []).map(c => c.text).join('\n');
      } catch (err) {
        ok = false;
        text = err.message;
      }
      let value = null;
      try { value = JSON.parse(text); } catch (_err) { /* text */ }
      ctx.calls.push({ tool, args, ok, text });
      return { ok, text, value };
    };
    const callTool = async (tool, args) => {
      const r = await ht().request('tools/call', { name: tool, arguments: args });
      const text = (r.content || []).map(c => c.text).join('\n');
      ctx.calls.push({ tool, args, ok: !r.isError, text });
      return { ok: !r.isError, text };
    };
    try {
      emit({ type: 'step_start', part: { type: 'step-start', sessionID: SESSION } });
      for (const step of steps) {
        if (step.load) {
          const t = { start: await tick(), end: await tick() };
          toolEvent('skill', { name: step.load }, { status: 'completed', output: `<skill_content name="${step.load}">...</skill_content>`, title: `Loaded skill: ${step.load}`, time: t });
        } else if (step.lookup) {
          const start = await tick();
          const input = { skill: step.lookup, ...(step.as ? { role: step.as } : {}) };
          const r = await callTool('skill_lookup', input);
          toolEvent('harness_skill_lookup', input, r.ok ? { status: 'completed', output: r.text, time: { start, end: await tick() } } : { status: 'error', error: r.text, time: { start, end: await tick() } });
        } else if (step.role) {
          const start = await tick();
          for (const skill of step.lookups || []) {
            const r = await callTool('skill_lookup', { skill, role: step.role });
            if (!r.ok) throw new Error(`skill_lookup ${skill} for ${step.role}: ${r.text}`);
          }
          const end = await tick();
          const report = val(step.report, ctx) || `${step.role} report`;
          toolEvent('task', { description: step.role, prompt: 'the cycle', subagent_type: step.role }, {
            status: 'completed', output: `<task id="ses_${step.role}" state="completed">\n<task_result>\n${report}\n</task_result>\n</task>`,
            ...(step.timed === false ? {} : { time: { start, end } }),
          });
        } else if (step.harness) {
          const start = await tick();
          const args = val(step.args, ctx) || {};
          const r = await callTool(step.harness, args);
          try { ctx.results[step.harness] = JSON.parse(r.text); } catch (_err) { ctx.results[step.harness] = r.text; }
          toolEvent(`harness_${step.harness}`, args, r.ok ? { status: 'completed', output: r.text, time: { start, end: await tick() } } : { status: 'error', error: r.text, time: { start, end: await tick() } });
        } else if (step.broker) {
          const start = await tick();
          const args = val(step.args, ctx);
          const r = await callGateway(step.broker, args);
          if (r.ok) ctx.results[step.broker] = r.value;
          toolEvent(`broker_${step.broker}`, args, r.ok ? { status: 'completed', output: r.text, time: { start, end: await tick() } } : { status: 'error', error: r.text, time: { start, end: await tick() } });
        } else if (step.executor) {
          const start = await tick();
          const said = [];
          for (const c of step.executor) {
            const r = await callGateway(c.broker, val(c.args, ctx));
            said.push(`${c.broker}: ${r.ok ? 'ok' : `refused ${r.text.slice(0, 300)}`}`);
          }
          const end = await tick();
          toolEvent('task', { description: 'execute', prompt: 'the plan and the verdict line', subagent_type: 'trade-executor' }, {
            status: 'completed', output: `<task id="ses_exec" state="completed">\n<task_result>\n${said.join('\n')}\n</task_result>\n</task>`, time: { start, end },
          });
        } else if (step.act) {
          await step.act(ctx);
        } else if (step.result) {
          emit({ type: 'text', part: { type: 'text', sessionID: SESSION, text: val(step.result, ctx), time: { start: Date.now(), end: Date.now() } } });
        }
      }
      emit({ type: 'step_finish', part: { type: 'step-finish', sessionID: SESSION, reason: 'stop' } });
    } finally {
      if (gateway) gateway.close();
      if (tools) tools.close();
      // As the live writer's done(): the run's file is removed once it ends (the cycle log keeps the transcript).
      if (liveFile) try { fs.unlinkSync(liveFile); } catch (_err) { /* gone already */ }
    }
    return { ok: true, timedOut: false, code: 0, output: out, stdout: out };
  };
  scripted.last = null;
  return scripted;
}

module.exports = { scriptedModel };
