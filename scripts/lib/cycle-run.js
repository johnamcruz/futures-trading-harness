'use strict';

/**
 * One headless harness cycle as the runner runs it (scripts/autotrader.js): the harness's command, the cycle's
 * environment (autotrader.js childEnv: FTH_CYCLE_TRANSCRIPT, FTH_CYCLE_BARS, FTH_CYCLE_CACHED, ...), the run (the
 * transcript streamed to FTH_CYCLE_TRANSCRIPT as it goes, harness-run.js runHarness), the cycle log (cycle-log.js)
 * and the outcome the runner counts (autotrader.js cycleOutcome). The run is injected (`deps.run`), so a test drives
 * a scripted model through this same glue in place of the spawned harness.
 *
 *   runCycle(cfg, action, prompt, opts, limits, deps)   the runner's cycle result ({ ok, timedOut, result, ... })
 *     opts:   { dryRun }: print the argv only
 *     limits: { timeoutMs, context } (runner.js)
 *     deps:   { root, home, env, run (runHarness), onChild, out(text), err(text), appendLog(now, text),
 *               guard(killSwitchFile, when) (the workspace guard: false when it tripped; required, never defaulted
 *               open), now(), wallNow() (the wall clock in ms the cycle's timing reads: Date.now) }
 */

const path = require('path');
const { buildCommand, childEnv, scoreRun, cycleOutcome, outcomeOf, ROLES_CHECKED } = require('./autotrader');
const { runHarness } = require('./harness-run');
const { writeCycleLog } = require('./cycle-log');
const { runTiming } = require('./cycle-timing');
const { loadConfig } = require('./trading/config');
const { roleCalls } = require('./trading/roles-ran');
const { expectedRoles, deskCheck, deskWarning } = require('./trading/desk-check');

/** One run of the harness with the cycle's environment: its result, the transcript file, the role-skills mode and the env (the cycle log reads its clock and lanes there, as the gate). */
function runOnce(cfg, argv, timeoutMs, context, deps) {
  const env = childEnv(cfg, deps.root, deps.env, context);
  const run = deps.run || runHarness;
  return run(argv, { cwd: path.resolve(deps.root, cfg.workdir), env, timeoutMs, liveFile: env.FTH_CYCLE_TRANSCRIPT, onChild: deps.onChild || (() => {}) })
    .then(r => ({ ...r, transcript: env.FTH_CYCLE_TRANSCRIPT || null, roleSkills: env.FTH_ROLE_SKILLS || null, headPrompt: env.FTH_HEAD_PROMPT || null, env }));
}

async function runCycle(cfg, action, prompt, opts, { timeoutMs = cfg.cycleTimeoutMinutes * 60000, context = null } = {}, deps = {}) {
  // The workspace guard is the caller's to give: a missing one would let a run that changed the instructions go on.
  if (typeof deps.guard !== 'function') throw new Error('cycle-run: deps.guard (the workspace guard) is required');
  const { guard } = deps;
  const env = deps.env || process.env;
  const out = deps.out || (() => {});
  const err = deps.err || (() => {});
  const now = (deps.now || (() => new Date()))();
  const argv = buildCommand(cfg, prompt, deps.root, env);
  if (opts && opts.dryRun) {
    out(`${JSON.stringify(argv)}\n`);
    return { ok: true, timedOut: false };
  }
  const killSwitchFile = loadConfig(env).killSwitchFile;
  if (!guard(killSwitchFile, 'between runs') && action !== 'eod') return { ok: false, timedOut: false };
  out(`[autotrader] ${now.toISOString()} ${action}: ${argv[0]} ...\n`);
  const wallNow = deps.wallNow || Date.now;
  const startedMs = wallNow();
  const res = await runOnce(cfg, argv, timeoutMs, context, { ...deps, env });
  const endedMs = wallNow();
  // The result as scored (autotrader.js scoreRun: a `blocked` with no order call is no-trade), the agent's own kept.
  const { result, reportedResult, resultNote } = scoreRun(res, { action, harness: cfg.harness });
  // When it acted against its bar (cycle-timing.js): measurement only.
  const timing = runTiming({ res, cfg, context, env, startedMs, endedMs, now, result });
  // Did the desk run (desk-check.js)? Only where the transcript shows the roles' calls (ROLES_CHECKED).
  const desk = ROLES_CHECKED.has(cfg.harness) ? deskCheck({
    expected: expectedRoles({ action, cycle: cfg.cycle, manageOnly: Boolean(context && context.manageOnly), paper: Boolean(cfg.paper), cachedRoles: (context && context.cachedRoles) || [] }),
    calls: roleCalls(res.output).calls,
    failed: ((timing && timing.roles) || []).filter(r => r && r.ok === false).map(r => r.role),
    decided: Boolean(res.ok) && !res.timedOut && outcomeOf(result) !== 'blocked',
  }) : null;
  // What the model saw and did: the prompt, every tool call, skills loaded, orders sent (logs/cycles/).
  const { summary, file: cycleFile, lookups } = writeCycleLog(deps.home, { at: now, action, harness: cfg.harness, prompt, context, argv, output: res.output, result, reportedResult, ok: res.ok, timedOut: res.timedOut, durationMs: Date.now() - now.getTime(), transcript: res.transcript, roleSkills: res.roleSkills, headPrompt: res.headPrompt, env: res.env || null, timing, desk });
  out(`[autotrader] cycle log ${cycleFile}: skills ${summary.skills.join(', ') || 'none seen'}; ${Object.entries(summary.tools).map(([k, n]) => `${k} x${n}`).join(', ') || 'no tool calls seen'}\n`);
  const deskWarn = deskWarning(desk);
  if (deskWarn) err(`[autotrader] ${deskWarn}\n`);
  if (summary.missingSkills.length) err(`[autotrader] an entry was sent without loading ${summary.missingSkills.join(', ')}\n`);
  if (deps.appendLog) deps.appendLog(now, `\n===== ${now.toISOString()} ${action} ${cfg.harness}\n$ ${argv.map(a => JSON.stringify(a)).join(' ')}\n${res.output}\n`);
  out(`[autotrader] ${result}\n`);
  const intact = guard(killSwitchFile, `during a ${action} run`);
  // End of day did its job if the run succeeded; the guard's verdict is in the kill switch.
  // lookups: the cycle's skill_lookup records, for the report cache (runner-wiring.js record).
  return cycleOutcome(res, { result, intact, action, lookups, reportedResult, resultNote });
}

module.exports = { runCycle, runOnce };
