'use strict';

/**
 * The look a scorecard takes at a learning run's days (runs started through learning/run-gate.js, which keep a
 * learning-run.json). They follow the learning split (learning/splits.js) and the learning ledger (learning/looks.js),
 * never the prop schedule (prop/splits.js, replay/scorecard.js lookAt), which has other windows and would refuse a
 * practice-train month in its select block (2023-07 to 2024-06) or in 2020 (before it starts):
 *
 *   practice-train      free: practice, no look
 *   practice-validate   free, and counted: the run's validate look was taken at its start (the gate), and is in the ledger
 *   test, final         the run's look (judging or reasoning-fix) must be in the ledger; a reasoning-fix look hides outcomes
 *
 * Fail closed: a record whose role is not the role of the run's days, a record whose ledger is not the canonical one, a record without a readable ledger, or a
 * validate, test or final run whose look is not in that ledger is refused, never freed. A run with no record, or one
 * declared `"learning": false`, is not a learning run: the prop schedule applies (returns null). Nothing is appended
 * here: the look is the gate's.
 *
 *   learningLook(dir, run, { purpose })   null (not a learning run) | { purpose, learning: true, role, hideOutcomes }; throws when refused
 */

const path = require('path');
const { readLearningRun } = require('./run-gate');
const { rolesBetween } = require('./splits');
const { readLedger } = require('../prop/ledger-file');
const { ledgerPath } = require('./looks');

const nextDay = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

function learningLook(dir, run, { purpose = null, env = process.env } = {}) {
  const rec = readLearningRun(dir) || readLearningRun(path.resolve(dir, '..', '..'));
  if (!rec || rec.learning === false) return null;
  const refuse = why => { throw new Error(`the scorecard's look is refused: ${why}`); };
  if (rec.learning !== true || typeof rec.role !== 'string') refuse('the run\'s learning record is not readable (learning-run.json)');
  const days = Object.keys(run.days).sort();
  if (!days.length) refuse(`learning run ${run.manifest.runId} has no days to score`);
  let roles;
  try { roles = rolesBetween(days[0], nextDay(days[days.length - 1])); } catch (e) { return refuse(e.message); }
  if (roles.length !== 1 || roles[0] !== rec.role) refuse(`the run's days ${days[0]}..${days[days.length - 1]} are ${roles.join(' + ')}, not the ${rec.role} window it started in`);
  if (rec.role === 'practice-train') return { purpose: 'practice', learning: true, role: rec.role, hideOutcomes: false, why: 'practice-train: practice, no look' };
  // practice-validate, test, final: the look the gate took before the first cycle is in the learning ledger.
  if (!rec.look || !rec.ledger) refuse(`a ${rec.role} run has no recorded look (no ledger in its learning record)`);
  // The ledger is the canonical one the gate pins (looks.js ledgerPath), never the record's own say-so: a forged record
  // naming a forged ledger frees nothing.
  const canonical = ledgerPath(env);
  if (rec.ledger !== canonical) refuse(`the run's record names the ledger ${rec.ledger}, not the canonical learning ledger ${canonical}`);
  let ledger;
  try { ledger = readLedger(canonical); } catch (e) { return refuse(`the learning ledger can't be read (${e.message}): no look without it`); }
  const taken = ledger.find(e => e && e.kind === 'look' && e.runId === run.manifest.runId && e.role === rec.role && e.purpose === rec.look.purpose && e.evaluation === rec.look.evaluation);
  if (!taken) refuse(`run ${run.manifest.runId} has no ${rec.look.purpose} look at ${rec.role} in the learning ledger: a ${rec.role} run is read only through its recorded look`);
  const hideOutcomes = Boolean(rec.hideOutcomes) || rec.look.purpose === 'reasoning-fix' || purpose === 'reasoning-fix';
  return { purpose: hideOutcomes ? 'reasoning-fix' : rec.look.purpose, learning: true, role: rec.role, hideOutcomes, evaluation: rec.look.evaluation, candidate: rec.look.candidate };
}

module.exports = { learningLook };
