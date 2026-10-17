'use strict';

/**
 * Did the desk run this cycle? A full trade cycle launches the three analysts and risk-manager phase 1 (the prompt's
 * roster, autotrader.js roster: every one not served from the report cache), whatever it decides. The order gate
 * refuses an entry the roles didn't report for (roles-ran.js), but a no-trade decided by the head trader alone passed
 * unseen: in the PPC run of 2026-10-16 two of four full cycles launched no role that returned (an invented task_id
 * failed every launch; one cycle launched none). The runner records this check in the cycle log and warns when it
 * fails, so a cycle decided without its desk is never mistaken for one decided with it.
 *
 *   expectedRoles({ action, cycle, manageOnly, paper, cachedRoles })  the roles the cycle had to launch: [] for any
 *       other action, a lean cycle (it launches risk-manager only on a candidate), a manage-only or paper cycle (no
 *       roster in the prompt)
 *   deskCheck({ expected, calls, failed, decided })   { expected, ran, missing, failed, complete, decided }: `calls`
 *       are the launches that returned without an error (roles-ran.js roleCalls, as the gate counts them: the report's
 *       content, and the gate's round cut at a trade-executor launch, are not this check's), `failed` the roles whose
 *       launch errored; `decided` false for a run that decided nothing (it timed out or failed) or ended `blocked` (a
 *       kill switch, an account lock, a refused order: no entry to decide)
 *   deskWarning(desk)                        the runner's warning line, or null: the desk complete, or nothing decided
 */

const { ANALYSTS } = require('./roles-ran');

const RISK_MANAGER = 'risk-manager';

function expectedRoles({ action, cycle, manageOnly = false, paper = false, cachedRoles = [] } = {}) {
  if (action !== 'trade' || cycle !== 'full' || manageOnly || paper) return [];
  const cached = Array.isArray(cachedRoles) ? cachedRoles : [];
  return [...ANALYSTS, RISK_MANAGER].filter(r => !cached.includes(r));
}

function deskCheck({ expected = [], calls = [], failed = [], decided = true } = {}) {
  const roles = list => [...new Set((Array.isArray(list) ? list : []).filter(r => typeof r === 'string' && r))];
  const want = roles(expected);
  const returned = roles((Array.isArray(calls) ? calls : []).map(c => c && c.role));
  const ran = want.filter(r => returned.includes(r));
  const missing = want.filter(r => !returned.includes(r));
  return { expected: want, ran, missing, failed: roles(failed), complete: missing.length === 0, decided: decided !== false };
}

function deskWarning(desk) {
  if (!desk || desk.complete || desk.decided === false) return null;
  const failed = desk.failed.length ? `; launches that failed: ${desk.failed.join(', ')}` : '';
  return `[desk] this cycle was decided without ${desk.missing.join(', ')} (no launch returned)${failed}`;
}

module.exports = { RISK_MANAGER, expectedRoles, deskCheck, deskWarning };
