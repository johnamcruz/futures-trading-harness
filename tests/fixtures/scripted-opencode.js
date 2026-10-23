'use strict';

/**
 * The scripted model as the harness CLI (the pipeline smoke test, tests/e2e/pipeline-smoke-e2e.test.js): a stand-in for
 * `opencode run --format json ... <prompt>` that the replay driver's runner starts by name from PATH, in place of the
 * model. It plays one cycle with the scripted model (scripted-model.js) and prints the cycle's events as opencode prints
 * them, which the runner's live writer streams to the gate. Nothing here decides: the script file does.
 *
 *   SMOKE_MODEL_SCRIPT  a JSON file { bars: { "<bar open time>": step } }, the bar the cycle decides (FTH_CYCLE_BARS) its key;
 *                       a bar with no step is a quiet one: the model answers at once. A step is one of
 *       { do: 'compose', scenario: { side, skill, reads: [[step, skill, read], ...] }, size, order?, rationale?, policy?, planned?, result? }   the composed
 *            entry (composed-cycle.js); `order`: place_order's arguments instead of the plan's, `rationale` the plan order's, `policy` the
 *            policy strategy whose order_plan sizes it (an attempt's account layer), `planned` phase 2 and the order at order_plan's size
 *       { do: 'exit', side, size?, review? }      closes the position (size: its size, 'position' the broker's, 1 by default) with a market order; review:
 *                                                 { result, setup, r? }, the trade's review journaled after it
 *       { do: 'pass', why }                       the model reads the bar (the roles' round) and passes
 */

const fs = require('fs');

/** The steps for the cycle on `bar`, from the script. */
function stepsFor(script, bar, w) {
  const D = require('./decision-path');
  const C = require('./composed-cycle');
  const step = (script.bars || {})[bar];
  if (step.do === 'compose') {
    const cycle = C.composedCycle(w, step.scenario, { size: step.size || 1, order: step.order || null, rationale: step.rationale || null, policy: step.policy || null, result: step.result || null, planned: Boolean(step.planned) });
    // A live cycle takes minutes before its order; the replay broker's clock moves in ticks of a second (latency.js TICK_MS),
    // so a scripted one waits for a tick: the order fills after the compose record it follows, as the experience log reads it.
    const steps = cycle();
    steps.splice(steps.findIndex(s => s.executor), 0, { act: () => new Promise(resolve => setTimeout(resolve, 900)) });
    return steps;
  }
  if (step.do === 'exit') {
    const side = step.side === 'long' ? 'sell' : 'buy';
    // size 'position': the open position's own size, read from the broker first (an entry the code sized).
    const held = ctx => {
      const c = ctx.calls.filter(x => x.tool === 'list_open_positions').at(-1);
      let list = [];
      try { list = JSON.parse(c.text); } catch (_err) { /* none */ }
      const p = (Array.isArray(list) ? list : list.positions || []).find(x => /MNQ/.test(String(x.contractId)));
      return p ? Math.abs(p.size) : 1;
    };
    return [
      ...(step.size === 'position' ? [{ broker: 'list_open_positions', args: { accountId: 7 } }] : []),
      { executor: [{ broker: 'place_order', args: ctx => ({ accountId: 7, contractId: 'MNQ', side, type: 'market', size: step.size === 'position' ? held(ctx) : step.size || 1, rationale: '[exit] the composed trade out' }) }] },
      // `review`: the trade's review journaled after it (its result and setup tags), as the head trader writes one.
      ...(step.review ? [{ broker: 'journal_add', args: { kind: 'review', contractId: 'MNQ', tags: [`result:${step.review.result}`, `setup:${step.review.setup}`, ...(step.review.r !== undefined ? [`r:${step.review.r}`] : [])], text: `${step.side} out: ${step.review.result}` } }] : []),
      { result: 'CYCLE RESULT: managed - out' },
    ];
  }
  return [...D.roundSteps(w, { lookups: C.roleLookups(w) }), ...D.entryLoads(w).map(x => ({ load: x })), { result: `CYCLE RESULT: no-trade - ${step.why || 'pass'}` }];
}

/**
 * A desk role's own run (the runner's desk: `--agent <role>`, any role but the head trader): one data read and its
 * report, as a role's run prints them (the read the desk's read-data check counts, the report shape report-shape does).
 */
function roleRun(role) {
  const ev = (type, part) => process.stdout.write(`${JSON.stringify({ type, timestamp: Date.now(), sessionID: `ses_${role}`, part: { sessionID: `ses_${role}`, ...part } })}\n`);
  const risk = role === 'risk-manager';
  ev('tool_use', { type: 'tool', tool: risk ? 'broker_get_account_snapshot' : 'harness_bar_briefing', state: { status: 'completed', input: {}, output: '{}' } });
  ev('text', { type: 'text', text: risk ? '## Risk state: account 7 @ the bar\nTradable: yes' : `## ${role}: MNQ\nData: bar_briefing m3@the bar\nBias: neutral`, time: { start: Date.now(), end: Date.now() } });
}

async function main() {
  const env = process.env;
  const agent = process.argv[process.argv.indexOf('--agent') + 1];
  if (process.argv.includes('--agent') && agent && agent !== 'fth-head-trader') { roleRun(agent); return; }
  const script = JSON.parse(fs.readFileSync(env.SMOKE_MODEL_SCRIPT, 'utf8'));
  const bar = (JSON.parse(env.FTH_CYCLE_BARS || '{}')).MNQ || null;
  // A bar with no step is quiet: the model answers at once, as opencode prints a final message (nothing else loads).
  if (!(script.bars || {})[bar]) {
    const ev = part => process.stdout.write(`${JSON.stringify({ type: part.type === 'text' ? 'text' : part.type === 'step-start' ? 'step_start' : 'step_finish', timestamp: Date.now(), sessionID: 'ses_scripted', part: { sessionID: 'ses_scripted', ...part } })}\n`);
    ev({ type: 'step-start' });
    ev({ type: 'text', text: 'CYCLE RESULT: no-trade - nothing here the reads support', time: { start: Date.now(), end: Date.now() } });
    ev({ type: 'step-finish', reason: 'stop' });
    return;
  }
  const w = { home: env.FTH_HOME, env, mode: env.FTH_ROLE_SKILLS === 'full' ? 'full' : 'index' };
  const model = require('./scripted-model').scriptedModel(() => stepsFor(script, bar, w));
  await model(process.argv.slice(2), { env, liveFile: null, stream: line => process.stdout.write(line) });
}

main().catch(err => {
  process.stderr.write(`scripted opencode: ${err.stack || err.message}\n`);
  process.exit(4);
});
