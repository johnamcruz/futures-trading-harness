'use strict';

/**
 * The scripted model as the harness CLI (the pipeline smoke test, tests/e2e/pipeline-smoke-e2e.test.js): a stand-in for
 * `opencode run --format json ... <prompt>` that the replay driver's runner starts by name from PATH, in place of the
 * model. It plays one cycle with the scripted model (scripted-model.js) and prints the cycle's events as opencode prints
 * them, which the runner's live writer streams to the gate. Nothing here decides: the script file does.
 *
 *   SMOKE_MODEL_SCRIPT  a JSON file { bars: { "<bar open time>": step } }, the bar the cycle decides (FTH_CYCLE_BARS) its key;
 *                       a bar with no step is a quiet one: the model answers at once. A step is one of
 *       { do: 'compose', scenario: { side, skill, reads: [[step, skill, read], ...] }, size, order?, rationale?, policy?, result? }   the composed
 *            entry (composed-cycle.js); `order`: place_order's arguments instead of the plan's, `rationale` the plan order's, `policy` the
 *            policy strategy whose order_plan sizes it (an attempt's account layer)
 *       { do: 'exit', side }                      closes the position with a market order (manage-position)
 *       { do: 'pass', why }                       the model reads the bar (the roles' round) and passes
 */

const fs = require('fs');

/** The steps for the cycle on `bar`, from the script. */
function stepsFor(script, bar, w) {
  const D = require('./decision-path');
  const C = require('./composed-cycle');
  const step = (script.bars || {})[bar];
  if (step.do === 'compose') {
    const cycle = C.composedCycle(w, step.scenario, { size: step.size || 1, order: step.order || null, rationale: step.rationale || null, policy: step.policy || null, result: step.result || null });
    // A live cycle takes minutes before its order; the replay broker's clock moves in ticks of a second (latency.js TICK_MS),
    // so a scripted one waits for a tick: the order fills after the compose record it follows, as the experience log reads it.
    const steps = cycle();
    steps.splice(steps.findIndex(s => s.executor), 0, { act: () => new Promise(resolve => setTimeout(resolve, 900)) });
    return steps;
  }
  if (step.do === 'exit') {
    const side = step.side === 'long' ? 'sell' : 'buy';
    return [
      { executor: [{ broker: 'place_order', args: { accountId: 7, contractId: 'MNQ', side, type: 'market', size: 1, rationale: '[exit] the composed trade out' } }] },
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
