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
 *     positions, working orders, prop attempts) on the same trading day; never from a cycle that launched a
 *     trade-executor, nor on an account that wasn't read whole.
 *   - risk-manager phase 2 reviews this bar's plan: never cached.
 *
 * The runner records the reports from each cycle's transcript (the roles can't write the harness home), serves
 * the valid ones in the next cycle's prompt, and names them to the order gate (FTH_CYCLE_CACHED), whose
 * roles-ran check counts them as returned.
 *
 *   reportVersions(text)                        { m15, h1, day } from a report's Data line, or null
 *   accountKey(account)                         the account facts phase 1 rests on, as text
 *   serveReports({ cache, briefings, symbols, account, day })  { roles, reports: [{ role, text, at, until }] }
 *   recordReports({ prev, output, served, briefings, symbols, account, day, now })  the new cache
 *   cacheFile(home), readCache(home), writeCache(home, cache)
 */

const fs = require('fs');
const path = require('path');
const { ANALYSTS, roleCalls } = require('./roles-ran');

const PHASE1 = 'risk-manager';
const CACHED_ROLES = [...ANALYSTS, PHASE1];
const PARTS = ['m15', 'h1', 'day'];
const MAX_TEXT = 8000; // a longer report isn't cached (never served cut): the role runs again

/** The briefing versions a report names in its Data line (`Data: bar_briefing m3@..., m15@..., h1@..., day@...`). */
function reportVersions(text) {
  const line = String(text || '').split('\n').find(l => /^\s*\**Data:?\**/i.test(l) && /bar_briefing/.test(l));
  if (!line) return null;
  const out = {};
  for (const p of PARTS) {
    const m = new RegExp(`\\b${p}@(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z)`).exec(line);
    if (!m) return null;
    out[p] = `${p}@${m[1]}`;
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
function serveReports({ cache, briefings, symbols, account, day }) {
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
  if (p1 && key && p1.account === key && p1.day === day) reports.push({ role: PHASE1, text: p1.text, at: p1.at, until: null });
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
    const versions = last ? reportVersions(last.text) : null;
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
    if (rm && key && fits(rm.text)) cache.phase1 = { text: rm.text, account: key, day, at: now.toISOString() };
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

module.exports = { CACHED_ROLES, PHASE1, reportVersions, accountKey, serveReports, recordReports, cacheFile, readCache, writeCache, removeCache };
