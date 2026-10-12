'use strict';

/**
 * The analyst report cache: a role's report is reused, not run again, while what it was built on holds.
 *
 *   - An analyst's report (market structure, trend and momentum, volume and liquidity), in a one-symbol cycle (a
 *     report covers the symbols its cycle gave it, which one call can't show), holds while the bar
 *     briefing's m15, h1 and day parts it names in its Data line are the current ones, for the same symbols and
 *     contracts: until the next 15m close (an h1 or day change comes at a 15m close too). Its 15m-and-up view is
 *     what is reused; the 3m facts (the trigger, the VWAP side, the candidates) come from each bar's briefing.
 *   - risk-manager phase 1 (the account's state, limits, budget) holds while the account is unchanged (balance,
 *     positions, working orders, prop attempts) on the same trading day, for at most PHASE1_MAX_AGE_MS; never from
 *     a cycle that launched a trade-executor, nor on an account that wasn't read whole, nor a report that doesn't
 *     confirm each active attempt on its Attempt line or says none is running (a wrong report would be served
 *     every cycle the account stays unchanged).
 *   - risk-manager phase 2 reviews this bar's plan: never cached.
 *
 * The runner records the reports from each cycle's transcript (the roles can't write the harness home), serves
 * the valid ones in the next cycle's prompt, and names them to the order gate (FTH_CYCLE_CACHED), whose
 * roles-ran check counts them as returned.
 *
 *   reportVersions(text, current)               { m15, h1, day } from a report's Data line, or null
 *   accountKey(account)                         the account facts phase 1 rests on, as text
 *   serveReports({ cache, briefings, symbols, account, day, now })  { roles, reports: [{ role, text, at, until }] }
 *   deniesActiveAttempt(text, account)          a report claims no attempt runs, but one is active
 *   phase1Holds(text, account)                  phase 1 confirms every active attempt and denies none
 *   recordReports({ prev, output, served, briefings, symbols, account, day, now })  the new cache
 *   cacheFile(home), readCache(home), writeCache(home, cache)
 */

const fs = require('fs');
const path = require('path');
const { ANALYSTS, roleCalls, verdictOf } = require('./roles-ran');

const PHASE1 = 'risk-manager';
const CACHED_ROLES = [...ANALYSTS, PHASE1];
const PARTS = ['m15', 'h1', 'day'];
const MAX_TEXT = 8000; // a longer report isn't cached (never served cut): the role runs again
// Phase 1 is read again at least this often, even on an unchanged account: a cached report is a claim, not a fact.
const PHASE1_MAX_AGE_MS = 30 * 60000;

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
const LINE_DENIAL = /\b(?:not|n't|never)\s+(?:currently\s+|yet\s+|been\s+)*(?:running|started|active)\b|\bnone\b|\binactive\b|\bwas\s+active\b/i;
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
  // The account's Attempt line, its status right after the name ("Attempt: topstep_100k active, cushion ..."), and
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
function reportVersions(text, current = null) {
  const line = String(text || '').split('\n').find(l => /^\s*\**Data:?\**/i.test(l) && /bar_briefing/.test(l));
  if (!line) return null;
  const out = {};
  for (const p of PARTS) {
    const m = new RegExp(`\\b${p}@(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z|\\d{2}:\\d{2}\\b)`).exec(line);
    if (!m) return null;
    if (m[1].length > 5) out[p] = `${p}@${m[1]}`;
    else if (current && current[p] && current[p].slice(p.length + 12, p.length + 17) === m[1]) out[p] = current[p];
    else return null;
  }
  return out;
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

/** The account facts phase 1 rests on: any change (a fill, an order, a balance, an attempt) makes it stale. */
function accountKey(a) {
  if (!a || a.error || !Number.isFinite(a.balance) || !Array.isArray(a.positions) || !Array.isArray(a.orders)) return null;
  return JSON.stringify({
    id: a.id ?? null,
    balance: a.balance ?? null,
    positions: (a.positions || []).map(p => [p.contractId, p.type, p.size, p.averagePrice]),
    workingOrders: a.workingOrders ?? null,
    orders: (a.orders || []).map(o => [o.id, o.contractId, o.type, o.side, o.size, o.limitPrice ?? null, o.stopPrice ?? null]),
    attempts: (a.attempts || []).map(x => [x.account, x.status, x.balance, x.floor, x.profit, x.dayPnl, x.entryBlock || null]),
  });
}

const sameSymbols = (cache, symbols) => JSON.stringify(cache.symbols || []) === JSON.stringify(symbols.map(s => [s.symbol, s.contractId || null]));

/** The cached reports still valid for this cycle, and the roles they stand for. */
function serveReports({ cache, briefings, symbols, account, day, now = null }) {
  const none = { roles: [], reports: [] };
  if (!cache || !Array.isArray(symbols) || !symbols.length || !sameSymbols(cache, symbols)) return none;
  const reports = [];
  const v = symbols.length === 1 ? briefingVersions(briefings, symbols) : null;
  const until = untilOf(briefings, symbols);
  for (const role of ANALYSTS) {
    const r = (cache.analysts || {})[role];
    if (v && r && r.versions && PARTS.every(p => r.versions[p] === v[p])) reports.push({ role, text: r.text, at: r.at, until });
  }
  const p1 = cache.phase1;
  const key = accountKey(account);
  // Without the clock its age can't be known: not served (fails closed, the role runs).
  const age = now ? now.getTime() - Date.parse(p1 && p1.at) : NaN;
  if (p1 && key && p1.account === key && p1.day === day && age >= 0 && age < PHASE1_MAX_AGE_MS && phase1Holds(p1.text, account)) {
    reports.push({ role: PHASE1, text: p1.text, at: p1.at, until: null });
  }
  return { roles: reports.map(r => r.role), reports };
}

/**
 * The cache after a cycle: each analyst's last report this cycle that names this bar's briefing versions, and
 * phase 1's report (the cycle's first risk-manager call, when phase 1 wasn't served from the cache) with the
 * account the cycle was given. Roles served from the cache keep their entry.
 */
function recordReports({ prev, output, served = [], briefings, symbols, account, day, now }) {
  const keep = prev && sameSymbols(prev, symbols) ? prev : null;
  const cache = { symbols: symbols.map(s => [s.symbol, s.contractId || null]), analysts: {}, phase1: null, at: now.toISOString() };
  const v = symbols.length === 1 ? briefingVersions(briefings, symbols) : null;
  const { calls, launches } = roleCalls(output);
  const fits = t => typeof t === 'string' && t.length <= MAX_TEXT;
  for (const role of ANALYSTS) {
    const mine = calls.filter(c => c.role === role);
    const last = mine.sort((a, b) => a.end - b.end)[mine.length - 1];
    const versions = last ? reportVersions(last.text, v) : null;
    // Built on this bar's briefing (its Data line names the current versions): reusable while they hold.
    if (v && versions && fits(last.text) && PARTS.every(p => versions[p] === v[p])) cache.analysts[role] = { text: last.text, versions, at: now.toISOString() };
    else if (served.includes(role) && keep && keep.analysts && keep.analysts[role]) cache.analysts[role] = keep.analysts[role];
  }
  const key = accountKey(account);
  // A cycle that launched a trade-executor changed (or may have changed) the account: no phase 1 from it.
  if (launches.length) cache.phase1 = null;
  else if (served.includes(PHASE1)) cache.phase1 = keep ? keep.phase1 : null;
  else {
    const rm = calls.filter(c => c.role === PHASE1).sort((a, b) => a.start - b.start)[0];
    // A report with a verdict is a plan's review (phase 2), never the account's state: not cached as phase 1.
    // Nor one that doesn't confirm an active attempt (or denies it): served on every unchanged bar, it would block the day.
    if (rm && key && fits(rm.text) && verdictOf(rm.text) === null && phase1Holds(rm.text, account)) cache.phase1 = { text: rm.text, account: key, day, at: now.toISOString() };
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

module.exports = { CACHED_ROLES, PHASE1, PHASE1_MAX_AGE_MS, deniesActiveAttempt, phase1Holds, reportVersions, accountKey, serveReports, recordReports, cacheFile, readCache, writeCache, removeCache };
