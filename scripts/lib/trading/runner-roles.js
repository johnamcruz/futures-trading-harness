'use strict';

/**
 * The runner's record of the roles it ran itself this cycle (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "The runner's role
 * record"): the desk's roles today (runner-wiring.js deskFor), each its own harness run, not a call in the head
 * trader's transcript. The order gate learns of them here, and judges them by the same rules as the transcript's calls
 * (roles-ran.js): the same ordering by start and end, the same verdict, the same index-mode lookups.
 *
 * One append-only JSON-lines file per cycle, named by FTH_CYCLE_ROLES (the runner sets it for the head trader's run;
 * under the harness home's logs/, mode 0600, like the cycle transcript), removed when the cycle ends (runner.js). One
 * line per role run: { role, start, end, text, lookups, ok }: `start` and `end` wall-clock ms (Date.now, the clock of
 * opencode's transcript times, never a replay's clock), `text` the role's report, `lookups` the skills its run looked
 * up naming its role (skill_lookup; cycle-run.js runRole), `ok` whether the run counted (the workflow's checks passed).
 *
 *   roleRunsFile(env)              the cycle's file (FTH_CYCLE_ROLES), or null
 *   newRoleRunsFile(home)          a fresh file name for one cycle, under <home>/logs; first removes the records a cycle
 *                                  left behind (this process's earlier ones, or a process that is gone: a crash)
 *   appendRoleRun(file, run)       append one run (throws on a bad run or a failed write: the caller logs it)
 *   readRoleRuns(file)             the runs, [] when there is no file or it can't be read (a torn or foreign line is
 *                                  skipped; a file over the size limit is none: fails closed)
 *   asRoleCalls(runs)              roles-ran's shapes: { calls: the ok runs with a report, as calls ({ role, start, end,
 *                                  text, lookups, source: 'runner' }), launches: every trade-executor run, ok or not,
 *                                  as a launch that ends the round (as a transcript launch does) }
 *   removeRoleRuns(file)           delete it (none: nothing)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV = 'FTH_CYCLE_ROLES';
const EXECUTOR = 'trade-executor';
const SOURCE = 'runner';
// The same ceiling as the transcript the gate reads (config/runner.json limits.rolesRanBytes).
const maxBytes = () => require('../tunables').runner().limits.rolesRanBytes;

const roleRunsFile = env => String((env && env[ENV]) || '').trim() || null;

const PREFIX = 'cycle-roles-';
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};
/** Remove the records no cycle is running with: this process's own (one cycle at a time) and a gone process's. */
function sweepRoleRuns(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_err) { return; }
  for (const n of names) {
    const m = new RegExp(`^${PREFIX}(\\d+)-[0-9a-f]+\\.jsonl$`).exec(n);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || !alive(pid)) removeRoleRuns(path.join(dir, n));
  }
}
function newRoleRunsFile(home) {
  const dir = path.join(home, 'logs');
  sweepRoleRuns(dir);
  return path.join(dir, `${PREFIX}${process.pid}-${crypto.randomBytes(6).toString('hex')}.jsonl`);
}

const isStrings = a => Array.isArray(a) && a.every(s => typeof s === 'string');

/** A run as recorded, or null when it isn't one (a foreign or malformed line). */
function validRun(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const { role, start, end, text, lookups, ok } = r;
  if (typeof role !== 'string' || !role.trim() || role.trim() !== role) return null;
  // Wall-clock ms (the transcript's clock), never a replay's or a line position (skill-lookups.js timed).
  if (!require('./skill-lookups').timed({ start, end }) || end < start) return null;
  if (typeof text !== 'string' || !isStrings(lookups) || typeof ok !== 'boolean') return null;
  return { role, start, end, text, lookups: [...new Set(lookups)].sort(), ok };
}

function appendRoleRun(file, run) {
  if (!file) throw new Error('runner-roles: no record file');
  const r = validRun(run);
  if (!r) throw new Error('runner-roles: not a role run');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(r)}\n`, { mode: 0o600 });
  return r;
}

function readRoleRuns(file) {
  if (!file) return [];
  let text;
  try {
    if (fs.statSync(file).size > maxBytes()) return [];
    text = fs.readFileSync(file, 'utf8');
  } catch (_err) {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = validRun(JSON.parse(line)); } catch (_err) { continue; }
    if (r) out.push(r);
  }
  return out;
}

function asRoleCalls(runs) {
  const calls = [];
  const launches = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    if (r.role === EXECUTOR) launches.push({ start: r.start, end: r.end, background: false, source: SOURCE });
    else if (r.ok && r.text.trim()) calls.push({ role: r.role, start: r.start, end: r.end, text: r.text, lookups: r.lookups, source: SOURCE });
  }
  return { calls, launches };
}

/** A call the runner ran (asRoleCalls), never one read from a transcript. */
const isRunnerCall = c => Boolean(c) && c.source === SOURCE && Array.isArray(c.lookups);

function removeRoleRuns(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (_err) { /* none */ }
}

module.exports = { ENV, roleRunsFile, newRoleRunsFile, appendRoleRun, readRoleRuns, asRoleCalls, isRunnerCall, removeRoleRuns };
