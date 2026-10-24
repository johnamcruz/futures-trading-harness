'use strict';

/**
 * The trading flow as the training loop's frame (Propose-Probe-Compose, docs/TRAINING.md): every finding is placed on
 * the step of the flow it blocks, so the proposer reads its problems in the order a trade is built and fixes the
 * earliest one first. The read steps are the compose crosswalk's own (learning/curated-moments.js READ_SKILL: bias,
 * location, setup, entry, stop, target), then the two the desk owns after the plan: risk (risk-manager phase 2) and
 * execution (the trade-executor).
 *
 *   FLOW_STEPS                     the steps, in flow order
 *   ROLE_STEP                      the step each editable desk role owns (agent-edit.js EDITABLE_ROLES)
 *   stepsOfSkill(skill)            the read steps whose reads map to the skill, in flow order
 *   stepOf(finding)                its own `step` when one of FLOW_STEPS; else its skill's first step; else its role's;
 *                                  else null (no step: listed last)
 *   byStep(findings)               [{ step, findings }] in flow order, findings kept in their rank order inside a step
 *   flowLine()                     'bias -> location -> ...' for the prompt
 */

const { READ_SKILL } = require('../learning/curated-moments');
const { EDITABLE_ROLES } = require('./agent-edit');

const READ_STEPS = Object.freeze(Object.keys(READ_SKILL));
const FLOW_STEPS = Object.freeze([...READ_STEPS, 'risk', 'execution']);
const ROLE_STEP = Object.freeze({
  'market-structure-analyst': 'bias', 'trend-momentum-analyst': 'bias', 'volume-liquidity-analyst': 'location', 'risk-manager': 'risk', 'trade-executor': 'execution',
});
if (EDITABLE_ROLES.some(r => !ROLE_STEP[r])) throw new Error('flow.js: every editable role owns a step (ROLE_STEP)');

function stepsOfSkill(skill) {
  return READ_STEPS.filter(s => Object.values(READ_SKILL[s]).includes(skill));
}

function stepOf(f) {
  if (!f) return null;
  if (FLOW_STEPS.includes(f.step)) return f.step;
  if (f.skill) {
    const [first] = stepsOfSkill(f.skill);
    if (first) return first;
  }
  return f.agent && ROLE_STEP[f.agent] ? ROLE_STEP[f.agent] : null;
}

function byStep(findings) {
  const groups = new Map([...FLOW_STEPS, null].map(s => [s, []]));
  for (const f of findings || []) groups.get(stepOf(f)).push(f);
  return [...groups].filter(([, list]) => list.length).map(([step, list]) => ({ step, findings: list }));
}

const flowLine = () => FLOW_STEPS.join(' -> ');

module.exports = { FLOW_STEPS, ROLE_STEP, stepsOfSkill, stepOf, byStep, flowLine };
