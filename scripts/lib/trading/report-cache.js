'use strict';

/**
 * The analyst report cache: a role's report is reused, not run again, while what it was built on holds.
 *
 *   - An analyst's report (market structure, trend and momentum, volume and liquidity), in a one-symbol cycle (a
 *     report covers the symbols its cycle gave it, which one call can't show), holds while the bar
 *     briefing's m15, h1 and day parts it names in its Data line are the current ones, for the same symbols and
 *     contracts: until the next 15m close (an h1 or day change comes at a 15m close too). Its 15m-and-up view is
 *     what is reused; the 3m facts (the trigger, the VWAP side, the candidates) come from each bar's briefing.
 *   - An analyst on its own timeframe (lanes.js analystFrames; `frames`: role -> minutes), in a one-symbol cycle,
 *     holds while its timeframe's briefing (trading/briefing.js buildFrameBriefing: its `bar` part) and the runner's
 *     parts it shares are the ones it names, until its own next bar close (a 15m analyst's at most 15 min, a 1h one's
 *     an hour), never past it: judged by bar times alone (its frame bar is the one holding at the cycle's bar's close),
 *     never the clock, so no clock skew stretches or cuts it. An analyst without one keeps the rule above.
 *   - Every analyst's entry is keyed by its instructions (`bodyKeys`: role -> a hash of its agent file and its skills'
 *     files, roleKey) and the cache by its root (`scope`): an edited body or skill, or a home another root or checkout
 *     wrote, serves nothing (the role runs again).
 *   - risk-manager phase 1 (the account's state, limits, budget, streak, cooldown) states live facts: in a one-symbol
 *     cycle it is served only while every one of them is unchanged (`phase1`: the cycle's facts and key, phase1-facts.js:
 *     read fresh each cycle; their key equal to the entry's), under the same role body and root; never from a cycle
 *     that launched a trade-executor, nor a report with a verdict (phase 2's), nor one that doesn't confirm each active
 *     attempt on its Attempt line or says none runs (it would be served every cycle the facts hold). No key (a read
 *     failed or came back empty): nothing served, nothing recorded.
 *   - risk-manager phase 2 reviews this bar's plan: never cached.
 *
 * The runner records the reports from each cycle's transcript (the roles can't write the harness home), serves
 * the valid ones in the next cycle's prompt, and names them to the order gate (FTH_CYCLE_CACHED), whose
 * roles-ran check counts them as returned.
 *
 *   reportVersions(text, current, parts)        { m15, h1, day } (or `parts`: [[key, version prefix]]) from a report's Data line, or null
 *   frameVersions(first, frame, minutes, { closeAt })   an own-timeframe analyst's current versions { bar, ...shared } and until, or null
 *   roleKey(root, role)                         a hash of the role's agent file and its role-skills' and role-index's SKILL.md files, or null
 *   scopeOf(root)                               the cache's scope: a hash of the harness root's real path
 *   serveReports({ cache, briefings, symbols, frames, frameBriefings, bodyKeys, scope, closeAt })  { roles, reports: [{ role, text, at, until, tf? }] }
 *   recordReports({ prev, output, served, fresh, runs, briefings, symbols, now, frames, frameBriefings, lookups, bodyKeys, scope, closeAt })  the new cache
 *                                               (`phase1`: { facts, key } of the cycle; `runs`: the runner's role record
 *                                               of the cycle, runner-roles.js readRoleRuns: a trade-executor it ran ends
 *                                               phase 1's entry as a launch does)
 *   deniesActiveAttempt(text, account), phase1Holds(text, account)   phase 1's attempt line checks
 *   cacheFile(home), readCache(home), writeCache(home, cache)
 */

const fs = require('fs');
const path = require('path');
const { ANALYSTS, roleCalls, verdictOf, withRunnerRuns } = require('./roles-ran');
const { sharedParts, frameHolds } = require('./briefing');

const PHASE1 = 'risk-manager';
// Phase 1 is cached only by its live facts' key (phase1-facts.js): served while every one of them is unchanged.
const CACHED_ROLES = [...ANALYSTS, PHASE1];
const PARTS = ['m15', 'h1', 'day'];
const MAX_TEXT = require('../tunables').runner().prompt.reportMaxText; // a longer report isn't cached (never served cut): the role runs again


// Denials of a running attempt: "no attempt is running", "no prop attempt running", "Attempt: none", "the attempt
// hasn't started", "wait for a prop attempt to be started". "no attempt restrictions", "no attempt block" and the like
// (the word right after "attempt" says what is absent) are not denials.
const NOT_DENIAL = '(?![-\\s]*(?:restrict|limit|lesson|block|level|rule|breach|blown|was\\s+blown|floor|stop|entry|dll))';
const NO_ATTEMPT = new RegExp([
  `\\bno\\s+(?:prop\\s+|active\\s+|combine\\s+|running\\s+)*attempts?\\b${NOT_DENIAL}`,
  '\\battempts?\\s*:\\s*(?:none|not\\s+started|inactive)',
  '\\battempts?\\s+(?:is|are|has|have)\\s*(?:not|n\'t)\\s+(?:currently\\s+|yet\\s+|been\\s+)*(?:running|started|active)',
  '\\battempts?\\s+(?:isn\'t|hasn\'t|aren\'t|haven\'t)\\s+(?:currently\\s+|yet\\s+|been\\s+)*(?:running|started|active)',
  '\\battempts?\\s+not\\s+(?:currently\\s+|yet\\s+)*(?:running|started|active)',
  '\\bwait\\s+for\\s+an?\\s+(?:prop\\s+)?attempt\\s+to\\s+(?:be\\s+)?start',
  `\\bthere\\s+(?:is\\s+not|isn't|is\\s+no|'s\\s+no)\\s+(?:an?\\s+)?(?:active\\s+|running\\s+|prop\\s+|combine\\s+)*attempts?\\b${NOT_DENIAL}`,
].join('|'), 'i');

// A report's Attempt line: "Attempt: ...", "**Attempts:** ...", "Prop attempt: ...", "| Attempt | ... |".
const ATTEMPT_LINE = /^[\s*_>|-]*(?:prop\s+|combine\s+)?attempts?\b/i;
// "none" denies only as the line's status ("Attempt: none") or "none running", not "entry block: none".
const LINE_DENIAL = /\b(?:not|n't|never)\s+(?:currently\s+|yet\s+|been\s+)*(?:running|started|active)\b|^[\s*_>|-]*(?:prop\s+|combine\s+)?attempts?\b[\s*_:|]*none\b|\bnone\s+(?:currently\s+|yet\s+|been\s+)*(?:running|started|active)\b|\binactive\b|\bwas\s+active\b/i;
const activeAttempts = account => (account && Array.isArray(account.attempts) ? account.attempts.filter(x => x && x.status === 'active') : []);
const escapeRe = t => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A report that says no attempt is running while the account's attempts list an active one. */
function deniesActiveAttempt(text, account) {
  return activeAttempts(account).length > 0 && NO_ATTEMPT.test(String(text || ''));
}

/**
 * Phase 1 may be cached and served only if it states every active attempt as combine_status lists it (its
 * "Attempt: <account> active" line, risk-manager's output) and denies none: phrasing can't be enumerated, so a
 * report that doesn't confirm the attempt is simply read again (fails closed; the cost is a phase-1 run).
 */
function phase1Holds(text, account) {
  const t = String(text || '');
  // The account's Attempt line, its status right after the name ("Attempt: <account> active, cushion ..."), and
  // nothing on that line saying it isn't running ("... active but not running", "none").
  const lines = t.split('\n').filter(l => ATTEMPT_LINE.test(l));
  const confirmed = activeAttempts(account).every(x => lines.some(l => new RegExp(`(?<![\\w-])${escapeRe(x.account)}(?![\\w-])[\\s\`*_:()|]*active\\b`, 'i').test(l) && !LINE_DENIAL.test(l)));
  return confirmed && !deniesActiveAttempt(t, account);
}

/**
 * The briefing versions a report names in its Data line (`Data: bar_briefing m3@..., m15@..., h1@..., day@...`). A
 * role may shorten a version to its clock time (`m15@14:00`, the version's own UTC time): with `current` (this bar's
 * versions, when the report is recorded right after its cycle) that names the current version and is stored in full.
 */
function reportVersions(text, current = null, parts = PARTS.map(p => [p, p])) {
  const line = String(text || '').split('\n').find(l => /^\s*\**Data:?\**/i.test(l) && /bar_briefing/.test(l));
  if (!line) return null;
  const out = {};
  for (const [p, prefix] of parts) {
    const m = new RegExp(`\\b${prefix}@(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z|\\d{2}:\\d{2}\\b)`).exec(line);
    if (!m) return null;
    if (m[1].length > 5) out[p] = `${prefix}@${m[1]}`;
    else if (current && current[p] && current[p].slice(prefix.length + 12, prefix.length + 17) === m[1]) out[p] = current[p];
    else return null;
  }
  return out;
}

/** An own-timeframe analyst's parts: its briefing's `bar` (versions `bar15m@...`) and the runner's parts it shares. */
const frameParts = minutes => [['bar', `bar${minutes}m`], ...sharedParts(minutes).map(p => [p, p])];

/**
 * An analyst on `minutes`-minute bars: the versions its report must name (its briefing's `bar` part and the runner's
 * parts it shares) and until when they hold (the earliest of their ends), or null when there is no current one: its
 * briefing missing, of another symbol or contract, or not the bar holding at the cycle's latest bar close (the runner's
 * briefing's, or `closeAt`, a later lane bar's that closed this cycle): bar times only, the clock is never read.
 */
function frameVersions(first, frame, minutes, opts = null) {
  // Only `closeAt`, a bar time, is read: a clock (a Date) or nothing given is no bar time.
  const closeAt = opts && typeof opts === 'object' && !(opts instanceof Date) ? opts.closeAt : null;
  if (!first || !first.sections || !frame || frame.minutes !== minutes || frame.symbol !== first.symbol) return null;
  // The bar time it is judged at: the cycle's latest bar close (the runner's briefing's bar's, or a later lane bar's that
  // closed this cycle: `closeAt`), never the clock.
  const lane = Date.parse(closeAt);
  const at = Math.max(Date.parse(first.closedAt), Number.isFinite(lane) ? lane : -Infinity);
  if (!Number.isFinite(at) || (frame.contractId || null) !== (first.contractId || null) || !frameHolds(frame, new Date(at))) return null;
  const parts = frameParts(minutes);
  const secs = parts.map(([p]) => (p === 'bar' ? frame.sections.bar : first.sections[p]));
  if (secs.some(x => !x || !x.version || !Number.isFinite(Date.parse(x.validUntil)))) return null;
  const until = Math.min(...secs.map(x => Date.parse(x.validUntil)));
  if (until <= at) return null;
  return { versions: Object.fromEntries(parts.map(([p], i) => [p, secs[i].version])), until: new Date(until).toISOString() };
}

const sameVersions = (a, b) => Boolean(a && b) && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(k => a[k] === b[k]);

/** An own-timeframe analyst's current versions in a one-symbol cycle on this bar's runner briefing, or null. */
function frameNow({ briefings, frameBriefings, symbols, minutes, closeAt = null }) {
  if (symbols.length !== 1) return null;
  const s = symbols[0];
  const b = briefings[s.symbol];
  if (!b || !b.sections || b.asOf !== s.bar) return null;
  return frameVersions(b, ((frameBriefings || {})[s.symbol] || {})[minutes] || null, minutes, { closeAt });
}

/** The current m15, h1 and day versions, the same for every symbol (else null: nothing is reusable across them). */
function briefingVersions(briefings, symbols) {
  let v = null;
  for (const s of symbols) {
    const b = briefings[s.symbol];
    // The briefing must be this cycle's bar's (the runner records it before the cycle).
    if (!b || !b.sections || b.asOf !== s.bar) return null;
    const cur = Object.fromEntries(PARTS.map(p => [p, (b.sections[p] || {}).version || null]));
    if (PARTS.some(p => !cur[p])) return null;
    if (v && PARTS.some(p => v[p] !== cur[p])) return null;
    v = cur;
  }
  return v;
}

/** When the reused analysis expires: the earliest validUntil of the parts it rests on. */
function untilOf(briefings, symbols) {
  const t = symbols.flatMap(s => PARTS.map(p => Date.parse(((briefings[s.symbol] || {}).sections || {})[p]?.validUntil)));
  const ok = t.filter(Number.isFinite);
  return ok.length ? new Date(Math.min(...ok)).toISOString() : null;
}

const sameSymbols = (cache, symbols) => JSON.stringify(cache.symbols || []) === JSON.stringify(symbols.map(s => [s.symbol, s.contractId || null]));

const keyOf = (keys, role) => (keys && typeof keys[role] === 'string' && keys[role] ? keys[role] : null);
/**
 * A key the runner gave as unreadable (null: an agent or skill file it couldn't read, a root it couldn't resolve) keys
 * nothing: that role, or with no scope the whole cache, is neither served nor recorded (never served unkeyed). A key
 * not given at all (undefined) is a caller without keys (as before them).
 */
const unreadable = (keys, role) => Boolean(keys) && Object.prototype.hasOwnProperty.call(keys, role) && keyOf(keys, role) === null;
const sha = text => require('crypto').createHash('sha256').update(text).digest('hex');

/**
 * A role's instructions as one hash: its agent file and the SKILL.md of every skill its role-skills and role-index
 * name, in order. Any edit of them is another key (its cached report is not served). Unreadable: null.
 */
function roleKey(root, role) {
  try {
    const { parseFrontmatter } = require('../frontmatter');
    const agent = fs.readFileSync(path.join(root, 'agents', `${role}.md`), 'utf8');
    const { data } = parseFrontmatter(agent);
    const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean);
    const skills = [...list(data['role-skills']), ...list(data['role-index'])];
    return sha(JSON.stringify([agent, ...skills.map(n => [n, fs.readFileSync(path.join(root, 'skills', n, 'SKILL.md'), 'utf8')])]));
  } catch (_err) {
    return null;
  }
}

/** The cache's scope: the harness root it was written under (its real path), so another root's or checkout's never serves. */
function scopeOf(root) {
  try { return sha(fs.realpathSync(root)); } catch (_err) { return null; }
}

// The skills a cached report's own call looked up (an entry recorded before they were kept: none).
const lookupsOf = r => (Array.isArray(r.lookups) ? r.lookups.filter(s => typeof s === 'string') : []);

/**
 * The cached reports still valid for this cycle, and the roles they stand for; each analyst's with the skills its
 * own call looked up (`lookups`: index mode serves it only when they cover what this bar requires, runner-wiring.js).
 */
function serveReports({ cache, briefings, symbols, account = null, day: _day = null, now: _now = null, frames = {}, frameBriefings = {}, bodyKeys = {}, scope = undefined, closeAt = null, phase1 = null }) {
  const none = { roles: [], reports: [] };
  if (!cache || !Array.isArray(symbols) || !symbols.length || !sameSymbols(cache, symbols) || scope === null) return none;
  // Another root's or checkout's cache (a home it wrote): nothing of it.
  if ((cache.scope ?? null) !== (scope ?? null)) return none;
  // Written under this role's instructions (its agent file and skills as they are now), else it runs again.
  const sameBody = (role, r) => !unreadable(bodyKeys, role) && (r.body ?? null) === (keyOf(bodyKeys, role));
  const reports = [];
  const v = symbols.length === 1 ? briefingVersions(briefings, symbols) : null;
  const until = untilOf(briefings, symbols);
  for (const role of ANALYSTS) {
    const r = (cache.analysts || {})[role];
    const m = (frames || {})[role];
    if (m) {
      // On its own timeframe: its versions now, and never past their time.
      const f = r && r.tf === m ? frameNow({ briefings, frameBriefings, symbols, minutes: m, closeAt }) : null;
      if (f && sameBody(role, r) && sameVersions(r.versions, f.versions)) reports.push({ role, text: r.text, at: r.at, until: f.until, tf: m % 60 === 0 ? `${m / 60}h` : `${m}m`, lookups: lookupsOf(r), lookupsKey: typeof r.lookupsKey === 'string' ? r.lookupsKey : null });
      continue;
    }
    if (v && r && !r.tf && sameBody(role, r) && r.versions && PARTS.every(p => r.versions[p] === v[p])) reports.push({ role, text: r.text, at: r.at, until, lookups: lookupsOf(r), lookupsKey: typeof r.lookupsKey === 'string' ? r.lookupsKey : null });
  }
  // Phase 1: only while its live facts are what they were (their key, read fresh this cycle), in a one-symbol cycle, under
  // its body; and only a report that still confirms each active attempt.
  const p1 = cache.phase1;
  const key = phase1 && typeof phase1.key === 'string' ? phase1.key : null;
  if (p1 && key && symbols.length === 1 && p1.factsKey === key && sameBody(PHASE1, p1) && phase1Holds(p1.text, account)) {
    reports.push({ role: PHASE1, text: p1.text, at: p1.at, until: null });
  }
  return { roles: reports.map(r => r.role), reports };
}

/**
 * The cache after a cycle: each analyst's last report this cycle that names this bar's briefing versions, and
 * phase 1's report (the cycle's first risk-manager call, when phase 1 wasn't served from the cache) with the
 * account the cycle was given. Roles served from the cache keep their entry. Each analyst's entry carries the skills
 * that role looked up during the call whose report it holds (`lookups`: the cycle's skill_lookup records,
 * skill-lookups.js; a call without times shows none), and `lookupsKey`, the facts key of the cycle that made them
 * (skill-lookups.js factsKey): they count again only under that key.
 */
function recordReports({ prev, output, served = [], fresh = [], runs = [], briefings, symbols, account = null, day: _day = null, now, frames = {}, frameBriefings = {}, lookups = [], lookupsKey = null, bodyKeys = {}, scope = undefined, closeAt = null, phase1 = null }) {
  const { lookupsInCall } = require('./skill-lookups');
  // No root resolved: nothing recorded (an empty cache).
  if (scope === null) return { symbols: symbols.map(s => [s.symbol, s.contractId || null]), analysts: {}, phase1: null, at: now.toISOString() };
  const keep = prev && sameSymbols(prev, symbols) && (prev.scope ?? null) === (scope ?? null) ? prev : null;
  const cache = { symbols: symbols.map(s => [s.symbol, s.contractId || null]), ...(scope ? { scope } : {}), analysts: {}, phase1: null, at: now.toISOString() };
  const body = role => { const k = keyOf(bodyKeys, role); return k ? { body: k } : {}; };
  // A served entry is kept only while it is still this role's (its body unchanged).
  const kept = role => (keep && keep.analysts && keep.analysts[role] && (keep.analysts[role].body ?? null) === keyOf(bodyKeys, role) ? keep.analysts[role] : null);
  const v = symbols.length === 1 ? briefingVersions(briefings, symbols) : null;
  // With the runner's own runs (its role record): the entry workflow's trade-executor is a launch (the account changed).
  const { calls, launches } = withRunnerRuns(roleCalls(output), Array.isArray(runs) ? runs : []);
  const fits = t => typeof t === 'string' && t.length <= MAX_TEXT;
  // The desk's reports this cycle (the runner ran those roles): each is that role's report, with its own run's lookups.
  const ran = role => (Array.isArray(fresh) ? fresh : []).find(f => f && f.role === role && typeof f.text === 'string') || null;
  const ownLookups = (role, call) => { const f = ran(role); return f ? [...new Set(f.lookups || [])].sort() : lookupsInCall(lookups, role, call); };
  for (const role of ANALYSTS.filter(r => !unreadable(bodyKeys, r))) {
    const mine = calls.filter(c => c.role === role);
    const last = ran(role) ? { text: ran(role).text } : mine.sort((a, b) => a.end - b.end)[mine.length - 1];
    const m = (frames || {})[role];
    if (m) {
      // On its own timeframe: built on its briefing's bar and the shared parts current now, reusable while they hold.
      const f = frameNow({ briefings, frameBriefings, symbols, minutes: m, closeAt });
      const named = f && last ? reportVersions(last.text, f.versions, frameParts(m)) : null;
      if (named && fits(last.text) && sameVersions(named, f.versions)) cache.analysts[role] = { text: last.text, versions: named, tf: m, ...body(role), at: now.toISOString(), lookups: ownLookups(role, last), lookupsKey };
      else if (served.includes(role) && kept(role) && kept(role).tf === m) cache.analysts[role] = kept(role);
      continue;
    }
    const versions = last ? reportVersions(last.text, v) : null;
    // Built on this bar's briefing (its Data line names the current versions): reusable while they hold.
    if (v && versions && fits(last.text) && PARTS.every(p => versions[p] === v[p])) cache.analysts[role] = { text: last.text, versions, ...body(role), at: now.toISOString(), lookups: ownLookups(role, last), lookupsKey };
    else if (served.includes(role) && kept(role) && !kept(role).tf) cache.analysts[role] = kept(role);
  }
  // Phase 1 under this cycle's facts key: a cycle that launched a trade-executor changed (or may have changed) the account,
  // so none from it; a served one is kept while its key still holds; a fresh one (the cycle's first risk-manager call)
  // recorded with the key, unless it is phase 2's (a verdict) or doesn't confirm an active attempt. No key: none.
  const key = phase1 && typeof phase1.key === 'string' ? phase1.key : null;
  const p1Body = keyOf(bodyKeys, PHASE1);
  if (!key || symbols.length !== 1 || launches.length || unreadable(bodyKeys, PHASE1)) cache.phase1 = null;
  else if (served.includes(PHASE1)) cache.phase1 = keep && keep.phase1 && keep.phase1.factsKey === key && (keep.phase1.body ?? null) === p1Body ? keep.phase1 : null;
  else {
    const rm = ran(PHASE1) ? { text: ran(PHASE1).text } : calls.filter(c => c.role === PHASE1).sort((a, b) => a.start - b.start)[0];
    if (rm && fits(rm.text) && verdictOf(rm.text) === null && phase1Holds(rm.text, account)) cache.phase1 = { text: rm.text, factsKey: key, ...(p1Body ? { body: p1Body } : {}), at: now.toISOString() };
    else cache.phase1 = null;
  }
  return cache;
}

const cacheFile = home => path.join(home, 'report-cache.json');

function readCache(home) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(home), 'utf8'));
  } catch (_err) {
    return null;
  }
}

function writeCache(home, cache) {
  const file = cacheFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

function removeCache(home) {
  try { fs.unlinkSync(cacheFile(home)); } catch (_err) { /* none */ }
}

module.exports = { CACHED_ROLES, PHASE1, roleKey, scopeOf, deniesActiveAttempt, phase1Holds, reportVersions, frameVersions, serveReports, recordReports, cacheFile, readCache, writeCache, removeCache };
