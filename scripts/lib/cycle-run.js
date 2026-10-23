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
 *     limits: { timeoutMs, context, entry, precollect } (runner.js; `entry`: the runner's entry, runner-entry.js, run after the
 *             head trader's run inside the cycle's time and before its log: ({ result, output, env, startedWall, budgetMs }) ->
 *             null | { result, entry }: the cycle's result becomes its result, and the cycle log records `entry`;
 *             `precollect`: the cycle's pre-collected reads (cycle-data.js; the runner config's cycleDataInPrompt only):
 *             (runEnv) -> cycle-data collect's result, made with the very environment the head trader's run gets, inside
 *             the cycle's time; its blocks go at the end of the prompt (autotrader.js withCycleData) and the cycle log's
 *             context records them (`precollected`, and `notCollected`). Absent: the cycle runs exactly as without it)
 *     deps:   { root, home, env, run (runHarness), onChild, out(text), err(text), appendLog(now, text),
 *               guard(killSwitchFile, when) (the workspace guard: false when it tripped; required, never defaulted
 *               open), now(), wallNow() (the wall clock in ms the cycle's timing reads: Date.now) }
 */

const path = require('path');
const { buildCommand, childEnv, scoreRun, cycleOutcome, outcomeOf, withCycleData, writeRolePrompt, ROLES_CHECKED, ROLE_RUNS } = require('./autotrader');
const { harnessHome } = require('./paths');
const { roleSkills, withSkillsMissing, missingLine } = require('./role-skills-record');
const CD = require('./cycle-data');
const { runHarness } = require('./harness-run');
const { writeCycleLog } = require('./cycle-log');
const { runTiming } = require('./cycle-timing');
const { loadConfig } = require('./trading/config');
const { roleCalls } = require('./trading/roles-ran');
const { readRoleRuns, roleRunsFile, asRoleCalls } = require('./trading/runner-roles');
const { expectedRoles, deskCheck, deskWarning } = require('./trading/desk-check');

/** One run of the harness with the cycle's environment: its result, the transcript file, the role-skills mode and the env (the cycle log reads its clock and lanes there, as the gate). */
function runOnce(cfg, argv, timeoutMs, context, deps, given = null) {
  const env = given || childEnv(cfg, deps.root, deps.env, context);
  const run = deps.run || runHarness;
  return run(argv, { cwd: path.resolve(deps.root, cfg.workdir), env, timeoutMs, liveFile: env.FTH_CYCLE_TRANSCRIPT, onChild: deps.onChild || (() => {}) })
    .then(r => ({ ...r, transcript: env.FTH_CYCLE_TRANSCRIPT || null, roleSkills: env.FTH_ROLE_SKILLS || null, headPrompt: env.FTH_HEAD_PROMPT || null, env }));
}

// The least of the cycle's limit the head trader's run keeps (config/runner.json cycle.timeoutMinMinutes, the runner's own
// floor for the head trader after its desk): the reads get only what is left above it.
const minHeadMs = () => require('./tunables').runner().cycle.timeoutMinMinutes * 60000;

/**
 * The cycle's reads made before its run (limits.precollect): the run's own environment, the prompt with the reads at its
 * end, the context recording them. They get the cycle's limit above the head trader's floor (minHeadMs): with none
 * left they aren't made, and reads still going when it runs out are dropped; either way the run goes with the
 * "read it yourself" line, never with less than its floor because of them (a slow broker never fails a cycle). A
 * collection that throws, or a prompt it can't go in, gives none; the section is capped (cycle-data.js capped).
 */
async function precollected(cfg, prompt, context, precollect, deps, budgetMs) {
  const runEnv = childEnv(cfg, deps.root, deps.env, context);
  let got;
  if (!(budgetMs > 0)) got = CD.skipped(`too little of the cycle's time is left above the ${minHeadMs() / 60000} min its run keeps`);
  else {
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(CD.failed(new Error(`the reads took longer than the ${Math.round(budgetMs / 1000)} s the cycle could spare`))), budgetMs); });
    try { got = await Promise.race([Promise.resolve().then(() => precollect(runEnv)), late]); } catch (e) { got = CD.failed(e); } finally { clearTimeout(timer); }
  }
  got = CD.capped(got);
  let withData;
  try { withData = withCycleData(prompt, CD.render(got)); } catch (e) { got = { blocks: [], missing: [], note: `none given: ${e.message}` }; withData = prompt; }
  const missing = [...(got.missing || []), ...(got.note ? [{ why: got.note }] : [])];
  return { runEnv, prompt: withData, context: { ...(context || {}), precollected: CD.records(got), ...(missing.length ? { notCollected: missing } : {}) } };
}

async function runCycle(cfg, action, prompt, opts, { timeoutMs = cfg.cycleTimeoutMinutes * 60000, context = null, entry: entryHook = null, precollect = null } = {}, deps = {}) {
  // The workspace guard is the caller's to give: a missing one would let a run that changed the instructions go on.
  if (typeof deps.guard !== 'function') throw new Error('cycle-run: deps.guard (the workspace guard) is required');
  const { guard } = deps;
  const env = deps.env || process.env;
  const out = deps.out || (() => {});
  const err = deps.err || (() => {});
  const now = (deps.now || (() => new Date()))();
  let argv = buildCommand(cfg, prompt, deps.root, env);
  if (opts && opts.dryRun) {
    out(`${JSON.stringify(argv)}\n`);
    return { ok: true, timedOut: false };
  }
  const killSwitchFile = loadConfig(env).killSwitchFile;
  if (!guard(killSwitchFile, 'between runs') && action !== 'eod') return { ok: false, timedOut: false };
  out(`[autotrader] ${now.toISOString()} ${action}: ${argv[0]} ...\n`);
  const wallNow = deps.wallNow || Date.now;
  const startedMs = wallNow();
  // This machine's opt-in only (cycleDataInPrompt): the cycle's reads made first, in its time, with the run's own environment.
  const pre = typeof precollect === 'function' ? await precollected(cfg, prompt, context, precollect, { ...deps, env }, timeoutMs - minHeadMs()) : null;
  if (pre) {
    prompt = pre.prompt;
    context = pre.context;
    argv = buildCommand(cfg, prompt, deps.root, env);
  }
  // The run gets what is left of the cycle's limit after the reads (none made: the whole limit, as without them).
  // (Never under its floor because of them: a deadline's lag aside, as the runner's desk leaves it.)
  const res = await runOnce(cfg, argv, pre ? Math.max(timeoutMs - (wallNow() - startedMs), Math.min(minHeadMs(), timeoutMs)) : timeoutMs, context, { ...deps, env }, pre ? pre.runEnv : null);
  // The result as scored (autotrader.js scoreRun: a `blocked` with no order call is no-trade), the agent's own kept.
  const scored = scoreRun(res, { action, harness: cfg.harness });
  const { reportedResult, resultNote } = scored;
  let { result } = scored;
  // The runner's entry (runner-entry.js) after a head trader's run that finished, within what is left of the cycle's
  // limit, and never once the kill switch is on: its result is the cycle's, its time the cycle's.
  let entry = null;
  if (typeof entryHook === 'function' && res.ok && !res.timedOut) {
    if (!guard(killSwitchFile, 'before the runner\'s entry')) entry = { outcome: 'not-run', why: 'the kill switch is on' };
    else {
      try {
        const e = await entryHook({ result, output: typeof res.stdout === 'string' ? res.stdout : (res.output || ''), env: res.env || {}, startedWall: startedMs, budgetMs: Math.max(0, timeoutMs - (wallNow() - startedMs)) });
        if (e) { entry = e.entry || null; if (typeof e.result === 'string' && e.result) result = e.result; }
      } catch (e2) {
        err(`[autotrader] the runner's entry failed (${e2.message}): no order\n`);
        entry = { outcome: 'error', why: e2.message };
      }
    }
  }
  // The entry's roles that ran without some of their skills (role-skills-record.js): its record says so, as the desk's.
  if (entry && Array.isArray(entry.ran)) entry = { ...entry, ...withSkillsMissing(entry.ran) };
  // One runner log line a cycle when any role the runner ran lacked a skill (detection only: no report is refused).
  for (const [what, m] of [['desk', context && context.desk && context.desk.skillsMissing], ['entry', entry && entry.skillsMissing]]) if (m) err(`[autotrader] ${missingLine(m, what)}\n`);
  const endedMs = wallNow();
  // When it acted against its bar (cycle-timing.js): measurement only.
  // The runner's desk ran before this run (runner.js): its time counts in the cycle's (context.desk.ms).
  const deskMs = context && context.desk && Number.isFinite(context.desk.ms) ? context.desk.ms : 0;
  const timing = runTiming({ res, cfg, context, env, startedMs: startedMs - deskMs, endedMs, now, result });
  // Did the desk run (desk-check.js)? Only where the transcript shows the roles' calls (ROLES_CHECKED). The roster less
  // the roles served from the cache; a role ran when the runner's record (runner-roles.js) or the transcript has it.
  const ranByRunner = readRoleRuns(roleRunsFile(res.env || {}));
  const desk = ROLES_CHECKED.has(cfg.harness) ? deskCheck({
    expected: expectedRoles({ action, cycle: cfg.cycle, manageOnly: Boolean(context && context.manageOnly), paper: Boolean(cfg.paper), cachedRoles: (context && context.cachedRoles) || [] }),
    calls: [...asRoleCalls(ranByRunner).calls, ...roleCalls(res.output).calls],
    failed: [...((timing && timing.roles) || []).filter(r => r && r.ok === false).map(r => r.role), ...ranByRunner.filter(r => !r.ok).map(r => r.role)],
    decided: Boolean(res.ok) && !res.timedOut && outcomeOf(result) !== 'blocked',
  }) : null;
  // What the model saw and did: the prompt, every tool call, skills loaded, orders sent (logs/cycles/).
  const { summary, file: cycleFile, lookups } = writeCycleLog(deps.home, { at: now, action, harness: cfg.harness, prompt, context, argv, output: res.output, result, reportedResult, resultNote, ok: res.ok, timedOut: res.timedOut, durationMs: Date.now() - now.getTime(), transcript: res.transcript, roleSkills: res.roleSkills, headPrompt: res.headPrompt, env: res.env || null, timing, desk, entry });
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

/**
 * One desk role's run, as the runner's orchestration engine runs it (orchestrate/engine.js; the desk workflow): the
 * role as its own harness run (`buildCommand`'s `agent`), with the cycle's environment (its bars, cached roles, the
 * transcript live), within `timeoutMs`. Its result for the engine: { ok, timedOut, output, transcript, text, tools,
 * lookups } (`text` its final message, `tools` the tools it completed, `lookups` the skills it looked up naming its
 * role: what the order gate credits its report with, in the runner's role record, runner-roles.js). Only on a harness
 * that runs a role on its own (autotrader.js ROLE_RUNS), each read the same way (runResultOf); any other throws.
 */
async function runRole(cfg, role, request, { timeoutMs, context = null } = {}, deps = {}) {
  if (!ROLE_RUNS.has(cfg.harness)) throw new Error(`cycle-run: the runner runs a role on its own on ${[...ROLE_RUNS].join(' and ')} only (harness ${cfg.harness}: its head trader launches its roles)`);
  const env = deps.env || process.env;
  // The run is the role's (`roleRun`): the head trader's prompt addition is never attested for it (autotrader.js).
  const roleContext = { ...(context || {}), roleRun: role };
  const runEnv = childEnv(cfg, deps.root, env, roleContext);
  // roleSkillsInPrompt (this machine's opt-in, Claude Code): the role's prompt addition written for its argv (role-prompt.js).
  const added = writeRolePrompt(cfg, deps.root, runEnv, role);
  const argv = buildCommand(cfg, request, deps.root, runEnv, { agent: role });
  const res = await runOnce(cfg, argv, timeoutMs, roleContext, { ...deps, env });
  const { text, tools } = runResultOf(cfg.harness, typeof res.stdout === 'string' ? res.stdout : res.output);
  let lookups;
  try {
    const { readLookups, lookupsFile } = require('./trading/skill-lookups');
    // Its own lookups naming its role (a lookup naming another role is no lookup of this one's, as in the gate's rule).
    lookups = [...new Set(readLookups(res.transcript).filter(r => r && r.role === role).map(r => r.skill).filter(s => typeof s === 'string'))].sort();
    try { require('fs').unlinkSync(lookupsFile(res.transcript)); } catch (_err) { /* none */ }
  } catch (_err) { lookups = []; }
  // Which skills it had (role-skills-record.js), for the cycle log's desk and entry records: detection only.
  const skills = roleSkills({ root: deps.root, role, output: typeof res.stdout === 'string' ? res.stdout : (res.output || ''), home: harnessHome(runEnv), embedded: embeddedFor(cfg, deps.root, role, added) });
  return { ok: Boolean(res.ok), timedOut: Boolean(res.timedOut), output: res.output || '', transcript: res.transcript || null, text, tools, lookups, skills };
}

/** The skills a role's prompt held whole: its prompt addition (Claude Code, roleSkillsInPrompt), or opencode's role prompt; else none. */
function embeddedFor(cfg, root, role, added) {
  const { embeddedSkills } = require('./head-prompt');
  if (added) return embeddedSkills(added.text, root);
  if (cfg.harness !== 'opencode') return [];
  try {
    const conf = JSON.parse(require('fs').readFileSync(path.join(path.resolve(root, cfg.workdir), 'opencode.json'), 'utf8'));
    const a = conf && conf.agent && conf.agent[role];
    return a && typeof a.prompt === 'string' ? embeddedSkills(a.prompt, root) : [];
  } catch (_err) {
    return [];
  }
}

/** A role's run as the engine reads it, { text, tools }: Claude Code's stream-json (transcript.js), opencode's events (opencode.js). */
const runResultOf = (harness, output) => (harness === 'claude' ? require('./transcript').claudeRunResult(output) : require('./opencode').runResult(output));

module.exports = { runCycle, runOnce, runRole, runResultOf };
