'use strict';

/**
 * The policy verdicts of phase 2 started at the head trader's compose (runner-entry.js overlapFor), staged: while the
 * head trader's run goes on, nothing it reads may change because phase 2 started early (the owner's "the head sees
 * nothing earlier than today"). So the early run's verdicts (its own order_plan, prop/composed-verdict.js, and the
 * runner's size step for its request) go to a stage file of that run's, read back only by that run, and reach the real
 * verdicts file (prop-state.js) only when the entry adopts the run (prop-state.js promoteVerdicts); a run dropped
 * drops its stage.
 *
 * A stage is named for a process by FTH_VERDICT_STAGE (the early run's environment: autotrader.js childEnv
 * `verdictStage`, never inherited), or in the runner's own process for one synchronous call (withStage). It must be a
 * stage file under the harness home's logs/ (newStage's name); any other value stages nothing and reads nothing
 * (stageOf throws: prop-state.js appends refuse, reads see no verdicts: fails closed).
 *
 *   ENV                       the variable
 *   newStage(home)            a fresh stage file name for one early run (first removes the stages this process or a
 *                             process that is gone left behind)
 *   stageOf(home)             the stage in force here, or null; throws when one is named that isn't a stage file
 *   withStage(file, fn)       fn() with `file` the stage in this process (synchronous fn only)
 *   dropStage(file)           remove it (none: nothing)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV = 'FTH_VERDICT_STAGE';
const PREFIX = 'verdict-stage-';
const NAME = new RegExp(`^${PREFIX}(\\d+)-[0-9a-f]{12}\\.jsonl$`);
let scoped = null;

const isStage = (home, f) => typeof f === 'string' && path.isAbsolute(f) && path.dirname(path.resolve(f)) === path.resolve(home, 'logs') && NAME.test(path.basename(f));

function stageOf(home) {
  const f = scoped !== null ? scoped : String(process.env[ENV] || '').trim();
  if (!f) return null;
  if (!isStage(home, f)) throw new Error(`${ENV} names no verdict stage under the harness home's logs (${f}): nothing is staged or read`);
  return f;
}

function withStage(file, fn) {
  const was = scoped;
  scoped = file;
  try {
    return fn();
  } finally {
    scoped = was;
  }
}

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

function dropStage(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (_err) { /* none */ }
}

function newStage(home) {
  const dir = path.join(home, 'logs');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_err) { /* none yet */ }
  for (const n of names) {
    const m = NAME.exec(n);
    if (m && (Number(m[1]) === process.pid || !alive(Number(m[1])))) dropStage(path.join(dir, n));
  }
  return path.join(path.resolve(dir), `${PREFIX}${process.pid}-${crypto.randomBytes(6).toString('hex')}.jsonl`);
}

module.exports = { ENV, newStage, stageOf, withStage, dropStage, isStage };
