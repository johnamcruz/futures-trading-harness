'use strict';

/**
 * The roles' skill lookups in an autonomous cycle, and the order gate's check of the required ones (index mode,
 * the default, FTH_ROLE_SKILLS not full: role-skills.js).
 *
 * The harness tool skill_lookup records each lookup that names its role, while the runner's cycle runs
 * (FTH_CYCLE_TRANSCRIPT set): one JSON line { at (wall-clock ms), role, skill } in
 * `<transcript>.lookups.jsonl`, next to the cycle's transcript. A role's report counts for an entry only
 * if, for every skill its `role-index` lists that the cycle's bar briefing triggers (skills-loaded.js SITUATIONAL),
 * that role looked the skill up between the start and the end of one of its calls this cycle (the opencode
 * transcript's call times; roles-ran.js), in this entry's round. A call without times can't show it and
 * doesn't count (fails closed). With no trigger firing, nothing is required; with no current bar briefing for the
 * order's root, every situational skill of the role's index is (fails closed). Several lanes: the candidates of every
 * other lane whose bar closed this cycle count too (cycleFacts: that lane's briefing on its bar, else its signal record
 * on its bar; neither: fails closed). A role served from the report cache
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
 *   briefingFacts(home, root, now, laneBars)    the cycle's facts for the root (cycleFacts over the home), or null
 *   cycleFacts({ first, now, lanes, readFrame, readSignal })   the runner's briefing's m3 with the closed lanes' candidates
 *   unmetLookups(call, { records, required, m3, calls })   the required skills its role didn't look up in its calls
 *   lookupRule({ root, home, transcript, contractId, now, laneBars })   (call) -> unmet skills, for checkRolesRan
 *   lookupStats({ calls, records, required, m3 })   per cycle: lookups, by role, calls with a requirement, met
 */

const fs = require('fs');
const path = require('path');
const { requiredByRole } = require('../role-skills');
const { fires } = require('./skills-loaded');
const { readBriefing, readFrameBriefing, current } = require('./briefing');
const { readSignals } = require('./signal-state');
const { contractRoot } = require('./journal');
const { familyRoot } = require('./contracts');

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

// A candidate whose trend rule a lane's signal record doesn't carry: every trend rule a situational trigger reads, so
// each lookup such a candidate could require is required (fails closed).
const UNKNOWN_TREND_RULES = ['reversal', 'allows', 'against'];

/**
 * The facts the situational triggers read for one root this cycle: the runner's bar briefing's m3 while current at
 * `now`, with the candidates of each other lane whose bar closed this cycle (`lanes`: [{ minutes, t }], t that bar's
 * open). A lane's candidates come from its briefing on that bar (readFrame(minutes), when an analyst reads that
 * timeframe), else from its signal record on that bar (readSignal(minutes); its candidates carry no trend rule, so
 * every trend rule counts). null, so every situational lookup is required (fails closed): no current runner briefing,
 * or a closed lane with neither on its bar.
 */
function cycleFacts({ first, now, lanes = [], readFrame = () => null, readSignal = () => null }) {
  const m3 = first && current(first, now) && first.sections.m3 ? first.sections.m3.data || null : null;
  if (!m3) return null;
  const extra = [];
  for (const { minutes, t } of lanes) {
    if (!Number.isInteger(minutes) || minutes === first.minutes) continue;
    const f = readFrame(minutes);
    const data = f && f.asOf === t && f.sections && f.sections.bar ? f.sections.bar.data : null;
    if (data && Array.isArray(data.candidates)) { extra.push(...data.candidates); continue; }
    const rec = readSignal(minutes);
    if (!rec || rec.error || rec.asOf !== t || !Array.isArray(rec.candidates)) return null;
    for (const c of rec.candidates) for (const trendRule of UNKNOWN_TREND_RULES) extra.push({ name: c.name, direction: c.direction, trendRule });
  }
  if (!extra.length) return m3;
  return { ...m3, candidates: [...(Array.isArray(m3.candidates) ? m3.candidates : []), ...extra] };
}

/** The other lanes' bars that closed this cycle for `root` ({ ROOT: { minutes: t } }, config.js cycleLaneBars). */
const lanesFor = (laneBars, root) => Object.entries((laneBars || {})[familyRoot(root)] || {}).map(([m, t]) => ({ minutes: Number(m), t }));

/** cycleFacts over the harness home for `root`: its bar briefing, and its lanes' briefings and signal records. */
function briefingFacts(home, root, now, laneBars = {}) {
  return cycleFacts({
    first: readBriefing(home, root), now, lanes: lanesFor(laneBars, root),
    readFrame: m => readFrameBriefing(home, root, m), readSignal: m => readSignals(home, root, `${m}m`),
  });
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
function lookupRule({ root = PLUGIN_ROOT, home, transcript, contractId, now = new Date(), laneBars = {} }) {
  const required = requiredFor(root);
  const records = readLookups(transcript);
  const m3 = briefingFacts(home, contractRoot(contractId || ''), now, laneBars);
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

module.exports = { PLUGIN_ROOT, lookupsFile, recordLookup, readLookups, cycleFacts, lanesFor, briefingFacts, needed, unmetLookups, requiredFor, lookupRule, lookupStats };
