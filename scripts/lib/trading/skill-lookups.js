'use strict';

/**
 * The roles' skill lookups in an autonomous cycle, and the order gate's check of the required ones (index mode,
 * FTH_ROLE_SKILLS=index: role-skills.js).
 *
 * The harness tool skill_lookup records each lookup that names its role, while the runner's cycle runs
 * (FTH_CYCLE_TRANSCRIPT set): one JSON line { at (wall-clock ms), role, skill } in
 * `<transcript>.lookups.jsonl`, next to the cycle's transcript. A role's report counts for an entry only
 * if, for every skill its `role-index` lists that the cycle's bar briefing triggers (skills-loaded.js SITUATIONAL),
 * that role looked the skill up between the start and the end of one of its calls this cycle (the opencode
 * transcript's call times; roles-ran.js), in this entry's round. A call without times can't show it and
 * doesn't count (fails closed). With no trigger firing, nothing is required; with no current bar briefing for the
 * order's root, every situational skill of the role's index is (fails closed). A role served from the report cache
 * made no lookup this cycle: the runner doesn't serve it when a lookup is required of it (runner-wiring.js), and the
 * gate doesn't count it either. Exits never reach this check
 * (order-gate.js evaluates entries only).
 *
 * What it can't tell: which session called the tool (an MCP server isn't told), so a lookup is attributed
 * by the role it names and the time it was made, inside that role's call.
 *
 *   lookupsFile(transcript)                     the cycle's lookups file
 *   recordLookup(env, { role, skill }, at)            append one (no cycle, or no role: nothing)
 *   readLookups(transcript)                     the records, [] when none
 *   briefingFacts(home, root, now)              the current bar briefing's m3 facts, or null
 *   unmetLookups(call, { records, required, m3, calls })   the required skills its role didn't look up in its calls
 *   lookupRule({ root, home, transcript, contractId, now })   (call) -> unmet skills, for checkRolesRan
 *   lookupStats({ calls, records, required, m3 })   per cycle: lookups, by role, calls with a requirement, met
 */

const fs = require('fs');
const path = require('path');
const { requiredByRole } = require('../role-skills');
const { fires } = require('./skills-loaded');
const { readBriefing, current } = require('./briefing');
const { contractRoot } = require('./journal');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const MAX_BYTES = 5 * 1024 * 1024;

const lookupsFile = transcript => `${transcript}.lookups.jsonl`;

function recordLookup(env, { role, skill }, at = Date.now()) {
  const transcript = String((env && env.FTH_CYCLE_TRANSCRIPT) || '').trim();
  if (!transcript || !role) return false;
  fs.appendFileSync(lookupsFile(transcript), `${JSON.stringify({ at, role, skill })}\n`);
  return true;
}

function readLookups(transcript) {
  if (!transcript) return [];
  let text;
  try {
    const file = lookupsFile(transcript);
    if (fs.statSync(file).size > MAX_BYTES) return [];
    text = fs.readFileSync(file, 'utf8');
  } catch (_err) {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line);
      if (r && Number.isFinite(r.at) && typeof r.role === 'string' && typeof r.skill === 'string') out.push(r);
    } catch (_err) { /* not a record */ }
  }
  return out;
}

/** The m3 part of the root's bar briefing while it is current at `now`, else null (no facts: no trigger fires). */
function briefingFacts(home, root, now) {
  const b = readBriefing(home, root);
  return b && current(b, now) && b.sections.m3 ? b.sections.m3.data || null : null;
}

/** A call with the opencode transcript's wall-clock times (ms), not line positions. */
const timed = c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start > 1e12;

/** The role's required skills whose trigger fires on m3; with no facts (no current briefing), every one (fails closed). */
const needed = (role, required, m3) => (required.get(role) || []).filter(r => m3 === null || r.when.some(t => fires(t, m3)));

/**
 * The required skills (their triggers firing on m3, every one without m3) the call's role didn't look up during
 * this call or another call of the same role (`calls`: the round's role calls; phase 1 and phase 2 of the risk
 * manager are one role).
 */
function unmetLookups(call, { records = [], required = new Map(), m3 = null, calls = [call] }) {
  const need = needed(call.role, required, m3);
  if (!need.length) return [];
  const windows = [call, ...calls.filter(c => c !== call && c.role === call.role)].filter(timed);
  return need.filter(r => !records.some(x => x.role === call.role && x.skill === r.skill && windows.some(c => x.at >= c.start && x.at <= c.end))).map(r => r.skill);
}

const cache = new Map();
function requiredFor(root) {
  if (!cache.has(root)) cache.set(root, requiredByRole(root, 'index'));
  return cache.get(root);
}

/**
 * The gate's rule for checkRolesRan: (call, calls) -> the skills it should have looked up and didn't; `needs(role)`:
 * the skills required of a role on this bar (a report served from the cache made no lookup this cycle).
 */
function lookupRule({ root = PLUGIN_ROOT, home, transcript, contractId, now = new Date() }) {
  const required = requiredFor(root);
  const records = readLookups(transcript);
  const m3 = briefingFacts(home, contractRoot(contractId || ''), now);
  const rule = (call, calls) => unmetLookups(call, { records, required, m3, calls });
  rule.needs = role => needed(role, required, m3).map(r => r.skill);
  return rule;
}

/** One cycle's lookups for its log: how many, by role, and how many role calls a requirement applied to and met. */
function lookupStats({ calls = [], records = [], required = new Map(), m3 = null }) {
  const byRole = {};
  for (const r of records) byRole[r.role] = (byRole[r.role] || 0) + 1;
  let requiredCalls = 0;
  let met = 0;
  for (const c of calls) {
    if (!needed(c.role, required, m3).length) continue;
    requiredCalls += 1;
    if (!unmetLookups(c, { records, required, m3, calls }).length) met += 1;
  }
  return { lookups: records.length, byRole, requiredCalls, met };
}

module.exports = { PLUGIN_ROOT, lookupsFile, recordLookup, readLookups, briefingFacts, needed, unmetLookups, requiredFor, lookupRule, lookupStats };
