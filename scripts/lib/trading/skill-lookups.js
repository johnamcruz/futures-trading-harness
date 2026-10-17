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
 * doesn't count (fails closed). With no trigger firing, nothing is required; with no bar briefing of the cycle's bar for
 * the order's root, every situational skill of the role's index is (fails closed). In a runner's cycle the briefing
 * counts when it is on the bar the cycle decides (FTH_CYCLE_BRIEFING_BARS, else FTH_CYCLE_BARS: `cycleBar`), however
 * long the cycle runs (a delegated cycle outlasts the bar); outside one, while its m3 holds at `now`. Several lanes: the candidates of every
 * other lane whose bar closed this cycle count too (cycleFacts: that lane's briefing on its bar, else its signal record
 * on its bar; neither: fails closed). A role served from the report cache made no lookup this cycle: its report
 * carries the skills the call that produced it looked up (report-cache.js, lookupsInCall), and only those count for it
 * (the runner serves it only when they cover what the bar requires: runner-wiring.js; the gate reads them from
 * FTH_CYCLE_CACHED_LOOKUPS; none recorded: every one still required). Exits never reach this check
 * (order-gate.js evaluates entries only).
 *
 * What it can't tell: which session called the tool (an MCP server isn't told), so a lookup is attributed
 * by the role it names and the time it was made, inside that role's call. The head trader's own calls are in the
 * transcript and left out (rolesOwn: the gate, and the report cache's records, cycle-log.js). A subagent's are not
 * (opencode's transcript holds the main session's tool calls only): an analyst that names ANOTHER role while that
 * role's call runs in parallel is credited to that role. Nothing the harness reads can tell the two apart; the
 * prompts give each role its own name to pass (opencode.js lookupCall), and a role naming another is a misfollow the
 * gate can't see.
 *
 * A role the runner ran itself (its role record, runner-roles.js) is its own session: its run's lookups naming its
 * role are recorded with it (cycle-run.js runRole), and its call counts with those, under the same requirement as a
 * task call's (unmetLookups). Phase 1 and phase 2 of the risk manager are one role, whichever ran them.
 *
 *   lookupsFile(transcript)                     the cycle's lookups file
 *   recordLookup(env, { role, skill }, at)            append one (no cycle, or no role: nothing)
 *   readLookups(transcript)                     the records, [] when none
 *   briefingFacts(home, root, now, laneBars, cycleBar)    the cycle's facts for the root (cycleFacts over the home), or null
 *   cycleFacts({ first, now, cycleBar, lanes, readFrame, readSignal })   the runner's briefing's m3 with the closed lanes' candidates
 *   unmetLookups(call, { records, required, m3, calls })   the required skills its role didn't look up in its calls
 *   sessionLookups(transcript)                  the lookups the session made itself in a role's name
 *   rolesOwn(records, transcript)               the records but the session's own
 *   lookupRule({ root, home, transcript, contractId, now, cycleBar, laneBars, cachedLookups })   (call) -> unmet skills, for checkRolesRan (the session's own lookups left out)
 *   lookupsInCall(records, role, call)          the skills the role looked up inside the call's times, sorted
 *   factsKey(first, now, lanes, cycleBar, composed), briefingFactsKey(home, root, now, laneBars, cycleBar)   what the requirement comes from, one key
 *   composedAt(home, root, bar)                 the head trader's compose records on the bar, as the triggers read them
 *                                               ([{ id, side, kinds, relations }]: m3.composed in cycleFacts)
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
const { recordsAt, readsOf } = require('./lifecycle-gate');
const { parseRead } = require('./composed-reads');
const { isRunnerCall } = require('./runner-roles');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const MAX_BYTES = require('../tunables').runner().limits.skillLookupsBytes; // config/runner.json

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

// A candidate from a lane's signal record written before the records kept their setups' trend rules: every trend rule
// a situational trigger reads, so each lookup such a candidate could require is required (fails closed).
const UNKNOWN_TREND_RULES = ['reversal', 'allows', 'against'];

/**
 * Whether the runner's bar briefing is this cycle's: on the cycle's bar (`cycleBar`, its open time) when the runner names
 * one, however long the cycle runs; else while its m3 holds at `now` (briefing.js current). A briefing of another bar
 * than the named one never is (fails closed), nor is one without its m3.
 */
const briefingHolds = (first, now, cycleBar) => Boolean(first && first.sections && first.sections.m3)
  && (cycleBar ? Date.parse(first.asOf) === Date.parse(cycleBar) && Number.isFinite(Date.parse(cycleBar)) : current(first, now));

/**
 * The facts the situational triggers read for one root this cycle: the runner's bar briefing's m3 while it is this
 * cycle's (briefingHolds: on `cycleBar`, else current at `now`), with the candidates of each other lane whose bar closed this cycle (`lanes`: [{ minutes, t }], t that bar's
 * open). A lane's candidates come from its briefing on that bar (readFrame(minutes), when an analyst reads that
 * timeframe), else from its signal record on that bar (readSignal(minutes): its setups with their trend rules; an
 * older record without them, its candidates under every trend rule). null, so every situational lookup is required
 * (fails closed): no current runner briefing, or a closed lane with neither on its bar.
 */
function cycleFacts({ first, now, cycleBar = null, lanes = [], readFrame = () => null, readSignal = () => null, composed = [] }) {
  const base = briefingHolds(first, now, cycleBar) ? first.sections.m3.data || null : null;
  if (!base) return null;
  // The head trader's compose records on this bar (composedAt): the composed triggers read them (skills-loaded.js).
  const m3 = Array.isArray(composed) && composed.length ? { ...base, composed } : base;
  const extra = [];
  for (const { minutes, t } of lanes) {
    if (!Number.isInteger(minutes) || minutes === first.minutes) continue;
    const f = readFrame(minutes);
    const data = f && f.asOf === t && f.sections && f.sections.bar ? f.sections.bar.data : null;
    if (data && Array.isArray(data.candidates)) { extra.push(...data.candidates); continue; }
    const rec = readSignal(minutes);
    if (!rec || rec.error || rec.asOf !== t) return null;
    // Its setups as the briefing lists them, each with its trend rule (signal-state.js buildSignals); a record from
    // before they were kept: its rules candidates under every trend rule.
    if (Array.isArray(rec.setups)) { extra.push(...rec.setups.map(c => ({ name: c.name, direction: c.direction, trendRule: c.trendRule ?? null }))); continue; }
    if (!Array.isArray(rec.candidates)) return null;
    for (const c of rec.candidates) for (const trendRule of UNKNOWN_TREND_RULES) extra.push({ name: c.name, direction: c.direction, trendRule });
  }
  if (!extra.length) return m3;
  return { ...m3, candidates: [...(Array.isArray(m3.candidates) ? m3.candidates : []), ...extra] };
}

/** The other lanes' bars that closed this cycle for `root` ({ ROOT: { minutes: t } }, config.js cycleLaneBars). */
const lanesFor = (laneBars, root) => Object.entries((laneBars || {})[familyRoot(root)] || {}).map(([m, t]) => ({ minutes: Number(m), t }));

/**
 * cycleFacts over the harness home for `root`: its bar briefing, and its lanes' briefings and signal records.
 * `laneBars` null (FTH_CYCLE_LANE_BARS set but unreadable: config.js): the lanes are unknown, so null (fails closed).
 * `cycleBar`: the bar the runner's cycle decides for the root (briefingHolds), null outside a cycle.
 */
function briefingFacts(home, root, now, laneBars = {}, cycleBar = null) {
  if (laneBars === null) return null;
  const first = readBriefing(home, root);
  return cycleFacts({
    first, now, cycleBar, lanes: lanesFor(laneBars, root),
    readFrame: m => readFrameBriefing(home, root, m), readSignal: m => readSignals(home, root, `${m}m`),
    composed: first ? composedAt(home, root, first.asOf) : [],
  });
}

/**
 * The compose records (trade-lifecycle.js) on the bar opened at `bar` for `root`, as the composed triggers read them:
 * [{ id, side, kinds: the reads' kinds, relations: the relation reads' rel }] (the reads parsed again by the checker,
 * never a field the record states about itself). None: [].
 */
function composedAt(home, root, bar) {
  if (!home || !bar) return [];
  // The bar's day shard unreadable: none here. Only a composed entry's triggers read these, and its own check
  // (lifecycle-gate.js composedRefusal) reads the same shard and refuses it; any other entry doesn't depend on them.
  let records;
  try { records = recordsAt(home, root, bar); } catch (_err) { return []; }
  return records.map(r => {
    const parsed = readsOf(r).map(x => parseRead(x.read));
    return { id: String(r.id || ''), side: r.side, kinds: [...new Set(parsed.map(p => p.kind))].sort(), relations: [...new Set(parsed.filter(p => p.kind === 'relation' && p.rel).map(p => p.rel))].sort() };
  });
}

/**
 * What the cycle's lookup requirement comes from, as one key: the runner's bar briefing's m3 version (the bar its
 * candidates are of) and each other lane's bar that closed this cycle (minutes@bar open): the same key, the same facts
 * (cycleFacts reads nothing else), so the same requirement. A cached report's lookups count only under the key of the
 * cycle that made them (lookupRule, runner-wiring.js): a candidate on a later bar or another lane's bar needs its own.
 * null (nothing counts): no briefing of this cycle (briefingHolds), no m3 version, or unreadable lanes.
 */
function factsKey(first, now, lanes = [], cycleBar = null, composed = []) {
  const v = briefingHolds(first, now, cycleBar) ? first.sections.m3.version : null;
  if (typeof v !== 'string' || !v) return null;
  const others = (lanes || []).filter(l => Number.isInteger(l.minutes) && l.minutes !== first.minutes).map(l => `${l.minutes}@${l.t}`).sort();
  // The compose records on the bar are facts the triggers read too (cycleFacts): another record, another key.
  const ids = (Array.isArray(composed) ? composed : []).map(c => `c:${c.id}`).sort();
  return [v, ...others, ...ids].join('|');
}

/** factsKey over the harness home for `root` (the gate's view, as briefingFacts). */
function briefingFactsKey(home, root, now, laneBars = {}, cycleBar = null) {
  if (laneBars === null) return null;
  const first = readBriefing(home, root);
  return factsKey(first, now, lanesFor(laneBars, root), cycleBar, first ? composedAt(home, root, first.asOf) : []);
}

/** A call with the opencode transcript's wall-clock times (ms), not line positions. */
const timed = c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start > 1e12;

/** The role's required skills whose trigger fires on m3; with no facts (no briefing of this cycle), every one (fails closed). */
const needed = (role, required, m3) => (required.get(role) || []).filter(r => m3 === null || r.when.some(t => fires(t, m3)));

/**
 * The required skills (their triggers firing on m3, every one without m3) the call's role didn't look up during
 * this call or another call of the same role (`calls`: the round's role calls; phase 1 and phase 2 of the risk
 * manager are one role).
 */
function unmetLookups(call, { records = [], required = new Map(), m3 = null, calls = [call] }) {
  const need = needed(call.role, required, m3);
  if (!need.length) return [];
  const same = [call, ...calls.filter(c => c !== call && c.role === call.role)];
  // A run the runner ran itself (runner-roles.js) carries the lookups its own run made naming its role: those, never
  // the lookups file's records inside its times (the head trader's session wasn't running it).
  const ran = new Set(same.filter(isRunnerCall).flatMap(c => c.lookups));
  const windows = same.filter(c => !isRunnerCall(c)).filter(timed);
  return need.filter(r => !ran.has(r.skill) && !records.some(x => x.role === call.role && x.skill === r.skill && windows.some(c => x.at >= c.start && x.at <= c.end))).map(r => r.skill);
}

/**
 * The skill_lookup calls the session itself made naming a role, as [{ role, skill, start, end }] (the call's
 * wall-clock times when the transcript has them): opencode's transcript holds the main session's own tool calls only
 * (a subagent's are not in it), so such a call is the head trader's (it may use the tool in index mode:
 * head-prompt.js), never the role's, whatever role it names. An unreadable or too large transcript, or a malformed
 * event: none (the lookups decide as before; roles-ran refuses a transcript it can't read).
 */
function sessionLookups(transcript) {
  const out = [];
  let text;
  try {
    if (!transcript || fs.statSync(transcript).size > 50 * 1024 * 1024) return out;
    text = fs.readFileSync(transcript, 'utf8');
  } catch (_err) {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('skill_lookup')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    if (!ev || typeof ev !== 'object' || ev.type !== 'tool_use') continue;
    const part = ev.part && typeof ev.part === 'object' ? ev.part : null;
    const state = part && part.state && typeof part.state === 'object' ? part.state : null;
    const input = state && state.input && typeof state.input === 'object' ? state.input : null;
    if (!input || !/(^|_)skill_lookup$/.test(String(part.tool || '')) || typeof input.role !== 'string') continue;
    const time = state.time && typeof state.time === 'object' ? state.time : {};
    out.push({ role: input.role, skill: input.skill, start: Number(time.start), end: Number(time.end) });
  }
  return out;
}

/**
 * The lookups file's records but the session's own (sessionLookups): for each such call, the one record of its role and
 * skill made during it (its times), or, for a call without times, one record of that pair (fails closed). A role's own
 * lookup of the same skill stays.
 */
function rolesOwn(records, transcript) {
  const own = sessionLookups(transcript);
  if (!own.length) return records;
  const left = [...records];
  for (const c of own) {
    const same = left.map((r, i) => [r, i]).filter(([r]) => r.role === c.role && r.skill === c.skill);
    const hit = Number.isFinite(c.start) && Number.isFinite(c.end) ? same.find(([r]) => r.at >= c.start && r.at <= c.end) : same[0];
    if (hit) left.splice(hit[1], 1);
  }
  return left;
}

const cache = new Map();
function requiredFor(root) {
  if (!cache.has(root)) cache.set(root, requiredByRole(root, 'index'));
  return cache.get(root);
}

/**
 * The gate's rule for checkRolesRan: (call, calls) -> the skills it should have looked up and didn't; `needs(role)`:
 * the skills required of a role served from the report cache on this bar that its cached report's own call didn't
 * look up (`cachedLookups`: role -> { skills, key }, the runner's FTH_CYCLE_CACHED_LOOKUPS): they count only when their
 * key is this order's facts key (briefingFactsKey: the same bar and lanes the requirement comes from); none recorded,
 * another key, or no key now: every one required.
 */
function lookupRule({ root = PLUGIN_ROOT, home, transcript, contractId, now = new Date(), cycleBar = null, laneBars = {}, cachedLookups = {} }) {
  const required = requiredFor(root);
  const records = rolesOwn(readLookups(transcript), transcript);
  const orderRoot = contractRoot(contractId || '');
  const m3 = briefingFacts(home, orderRoot, now, laneBars, cycleBar);
  const rule = (call, calls) => unmetLookups(call, { records, required, m3, calls });
  const key = briefingFactsKey(home, orderRoot, now, laneBars, cycleBar);
  const looked = role => {
    const c = cachedLookups && Object.prototype.hasOwnProperty.call(cachedLookups, role) ? cachedLookups[role] : null;
    return key && c && c.key === key && Array.isArray(c.skills) ? c.skills : [];
  };
  rule.needs = role => needed(role, required, m3).map(r => r.skill).filter(s => !looked(role).includes(s));
  return rule;
}

/**
 * The skills `role` looked up during `call` (records inside its wall-clock window: a call without times shows none,
 * fails closed), sorted: what a report recorded in the cache carries (report-cache.js recordReports).
 */
function lookupsInCall(records, role, call) {
  if (!call || !timed(call)) return [];
  return [...new Set((records || []).filter(x => x && x.role === role && Number.isFinite(x.at) && x.at >= call.start && x.at <= call.end).map(x => x.skill))].sort();
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

module.exports = { PLUGIN_ROOT, timed, sessionLookups, rolesOwn, lookupsFile, recordLookup, readLookups, cycleFacts, lanesFor, briefingFacts, composedAt, factsKey, briefingFactsKey, needed, unmetLookups, requiredFor, lookupRule, lookupsInCall, lookupStats };
