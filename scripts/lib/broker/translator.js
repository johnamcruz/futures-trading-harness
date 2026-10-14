'use strict';

/**
 * The contract translator: the harness names contracts by standard names, the
 * broker MCP server by its own ids. Translation happens here and nowhere else.
 *
 *   standard name   NQ, MNQ, ES (the front month), or NQ:2026-03 (a given month)
 *   broker id       whatever the selected broker's server uses
 *
 * Lookups go to the selected broker's own server: search_contracts finds the
 * contracts of a root (the one it marks active is the front month), and
 * get_contract describes an id seen in a result. A contract's root and month
 * come from its ticker (`name`), the exchange's form: root + month code + year,
 * e.g. NQZ5 or MNQH26. Answers are cached per broker (contracts-<broker>.json
 * in the harness home). The front month is looked up once per trading day, so
 * a name never changes meaning during a session (the harness is flat overnight):
 * the first one recorded for a day stays for that day, across processes. A
 * contract the broker marks active in a search_contracts answer (the
 * agent's or the translator's own search) sets the day's front month when
 * the one recorded is an earlier day's; get_contract and
 * list_available_contracts answers record contracts but never a front month. Only today's front month names a contract
 * by its root: when today's lookup fails, a result is named by its month.
 * Each contract the broker describes also records its root's tick spec there
 * (`specs`: { tickSize, tickValue, name, description, id, readAt }), the one
 * source of tick specs for live and replay trading (trading/broker-specs.js
 * reads it); a reply without sane numbers records nothing, and a spec that
 * differs from the static table (backtests, training) is reported on stderr.
 * Each get_server_config answer records the server's order limits there too
 * (`server`: { maxOrderSize, readAt }; maxOrderSize null when the answer has no
 * whole number of 1 or more), which the order gate's size check reads.
 *
 * createTranslator({ call, cacheFile, now })
 *   .toBroker(name)               standard name -> broker id (throws when not found)
 *   .toStandard(id)               broker id -> standard name (the id itself when it isn't a futures ticker)
 *   .translateArgs(tool, args)    a tool call's contractId, standard -> broker (a known or
 *                                 non-standard broker id passes through, so a raw id can still be closed)
 *   .translateResult(tool, data)  every contractId (and contract ids) in a result, broker -> standard
 *
 * isStandardName(s), parseStandardName(s), parseTicker(name, now)
 * readCache(file), standardRoot(id, file)  for local readers (hooks): the root of an id, or null
 *
 * Under a replay clock each replayed day has its own file (contracts-<broker>.<YYYY-MM-DD>.json; broker/config.js
 * contractsCacheFile). A day file's front month, tick specs and server limits are that day's alone; its ids also
 * include those its sibling files recorded (the live file, the id index and the days within 30 of it), since a broker id's root and
 * month never change, except a contract whose month is already over on the day. Another day's front month is
 * never read.
 */

const fs = require('fs');
const path = require('path');

const MONTHS = 'FGHJKMNQUVXZ';
// A root has a letter (6E, M2K, MNQ); an all-digit string is a broker id, never a name.
const STANDARD = /^((?=[A-Z0-9]*[A-Z])[A-Z0-9]{1,6})(?::(\d{4})-(\d{2}))?$/;
const TICKER = /^((?=[A-Z0-9]*?[A-Z])[A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{1,2})$/;
const { tradingDayKey } = require('../trading/clock');
// Tools whose result lists contracts: their `id` is a contract id too.
const CONTRACT_TOOLS = new Set(['search_contracts', 'get_contract', 'list_available_contracts']);
// The one contract answer that may set the day's front month from its activeContract flags: a search of the root,
// the agent's or the translator's own. A get_contract answer (one contract, possibly a stale flag) never does.
const FRONT_TOOLS = new Set(['search_contracts']);
// Tools whose contractId input is the agent's own label, never a broker id (the journal).
const KEEP_ARGS = new Set(['journal_add', 'journal_read']);

class TranslationError extends Error {}

const isStandardName = s => STANDARD.test(String(s || ''));

/** { root, month } for a standard name (month 'YYYY-MM' or null for the front month), or null. */
function parseStandardName(s) {
  const m = STANDARD.exec(String(s || ''));
  if (!m) return null;
  const month = m[2] ? `${m[2]}-${m[3]}` : null;
  if (month && !(Number(m[3]) >= 1 && Number(m[3]) <= 12)) return null;
  return { root: m[1], month };
}

/**
 * { root, month } from an exchange ticker (NQZ5, MNQH26), or null. A one-digit
 * year is the nearest such year from two years back.
 */
function parseTicker(name, now = new Date()) {
  const m = TICKER.exec(String(name || '').toUpperCase());
  if (!m || !STANDARD.test(m[1])) return null; // the root must be a standard root (a letter, at most 6)
  const monthNum = MONTHS.indexOf(m[2]) + 1;
  let year;
  if (m[3].length === 2) year = 2000 + Number(m[3]);
  else {
    const base = now.getUTCFullYear() - 2;
    year = base + ((Number(m[3]) - (base % 10) + 10) % 10);
  }
  return { root: m[1], month: `${year}-${String(monthNum).padStart(2, '0')}` };
}

const plainObject = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const DAY_FILE = /^(contracts-[a-z0-9_-]+)\.(\d{4}-\d{2}-\d{2})\.json$/i; // broker/config.js contractsCacheFile
const SIBLING_DAYS = 30; // a day file reads the ids of the days this near it (and the live file's)
const dayMs = d => Date.parse(`${d}T00:00:00Z`);
const idEntry = v => Boolean(v) && typeof v === 'object' && typeof v.root === 'string' && typeof v.month === 'string';

/** The ids a day file's siblings recorded (the live file, the id index, the days near it), or {} for any other file. */
function siblingIds(file) {
  const m = DAY_FILE.exec(path.basename(String(file || '')));
  if (!m) return {};
  const dir = path.dirname(file);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_err) {
    return {};
  }
  const out = {};
  const month = m[2].slice(0, 7); // a contract whose month is over on this day is expired: its id isn't reused
  const mine = path.basename(file);
  const near = n => { const d = DAY_FILE.exec(n); return Boolean(d) && d[1] === m[1] && Math.abs(dayMs(d[2]) - dayMs(m[2])) <= SIBLING_DAYS * 86400000; };
  // By name, exactly: the live file, the id index (the ids of the day files pruned) and the days near it; no other file is read.
  const siblings = names.filter(n => n !== mine && (n === `${m[1]}.json` || n === `${m[1]}.ids.json` || near(n))).sort();
  for (const n of siblings) {
    try {
      for (const [id, v] of Object.entries(plainObject(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).ids))) if (idEntry(v) && v.month >= month) out[id] = { root: v.root, month: v.month };
    } catch (_err) { /* unreadable: no ids from it */ }
  }
  return out;
}

function readCache(file) {
  const shared = siblingIds(file);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A file from before specs (or the server's limits) were recorded has none: every root then has no spec.
    const server = data.server && typeof data.server === 'object' && !Array.isArray(data.server) ? data.server : null;
    return { ids: { ...shared, ...plainObject(data.ids) }, front: plainObject(data.front), specs: plainObject(data.specs), server };
  } catch (_err) {
    return { ids: shared, front: {}, specs: {}, server: null };
  }
}

/**
 * The server's own order limits from a get_server_config answer, as recorded: { maxOrderSize, readAt }.
 * A maxOrderSize that is not a whole number of 1 or more is recorded as null (the gate then refuses
 * entries until a valid answer), never left at an older, larger value.
 */
function serverLimits(data, readAt) {
  const n = data && typeof data === 'object' ? data.maxOrderSize : undefined;
  return { maxOrderSize: typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null, readAt };
}

/**
 * Merge into the file: the gateway's and the runner's translators share it, and
 * hooks read it, so one process never drops another's ids. Per root, the front
 * month of the later trading day wins; within one trading day the first one
 * recorded (`into`, the file's) stays, so every process names one front month
 * for the whole day even if the broker's active flag moves during it.
 */
function mergeCache(into, from) {
  Object.assign(into.ids, from.ids);
  const valid = f => Boolean(f && f.id && typeof f.day === 'string');
  for (const [root, f] of Object.entries(from.front)) {
    if (valid(f) && (!valid(into.front[root]) || f.day > into.front[root].day)) into.front[root] = f;
  }
  // Per root, the spec read later wins (a process's older read never replaces a newer one).
  const read = sp => Boolean(sp && typeof sp.readAt === 'string');
  for (const [root, sp] of Object.entries(from.specs || {})) {
    if (read(sp) && (!read(into.specs[root]) || sp.readAt >= into.specs[root].readAt)) into.specs[root] = sp;
  }
  // The server's limits: the answer read later wins.
  if (read(from.server) && (!read(into.server) || from.server.readAt >= into.server.readAt)) into.server = from.server;
  return into;
}

function writeCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const merged = mergeCache(readCache(file), cache);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return merged;
}

/**
 * The one standard name for a contract the caller may name several ways: a
 * month that is the cache's front month of trading day `day` becomes its root
 * (MNQ:2026-12 -> MNQ), and a broker id the cache knows becomes its standard
 * name. A front month recorded on another trading day (yesterday's, before a
 * roll) names nothing: its month keeps its own name, so a month is never taken
 * for whatever the root means today. Anything else comes back as given. Local;
 * no lookup.
 */
function canonicalName(id, cache, day) {
  if (typeof id !== 'string') return id;
  const std = parseStandardName(id);
  const known = std ? std.month && { root: std.root, month: std.month } : cache.ids[id];
  if (!known) return id;
  if (frontMonth(cache, known.root, day) === known.month) return known.root;
  return `${known.root}:${known.month}`;
}

/**
 * The month (YYYY-MM) of a root's front month recorded for trading day `day`, from the id the translator sends the
 * root to (cache.ids[front.id]), or null: none recorded that day, its id unknown, or a file whose front month says
 * another root or month than its id (a corrupt file never merges two months).
 */
function frontMonth(cache, root, day) {
  const front = cache.front[root];
  if (!front || front.day !== day) return null;
  const known = cache.ids[front.id];
  if (!idEntry(known) || known.root !== root || (front.month !== undefined && front.month !== known.month)) return null;
  return known.month;
}

/**
 * The month name (ROOT:YYYY-MM) of a contract named any way: a root is the front month recorded for trading day
 * `day` (as it is when the name is resolved), a broker id the cache knows is its month. Anything else comes back as
 * given. What the gateway's ledger and order records keep, so a root never changes meaning under them. Local.
 */
function monthName(id, cache, day) {
  if (typeof id !== 'string') return id;
  const std = parseStandardName(id);
  if (std && !std.month) {
    const m = frontMonth(cache, std.root, day);
    return m ? `${std.root}:${m}` : id;
  }
  const known = std || cache.ids[id];
  return idEntry(known) ? `${known.root}:${known.month}` : id;
}

/** The root of a broker id, from the cache (local; no lookup), or null. */
function standardRoot(id, file) {
  const known = readCache(file).ids[String(id || '')];
  return known ? known.root : null;
}

const parseJson = result => {
  if (!result || result.isError) {
    const text = result && result.content && result.content[0] ? result.content[0].text : 'no result';
    throw new TranslationError(String(text).slice(0, 200));
  }
  return JSON.parse(result.content[0].text);
};

function createTranslator({ call, cacheFile, now = () => new Date() }) {
  let cache = readCache(cacheFile);
  const save = () => {
    try {
      cache = writeCache(cacheFile, cache);
    } catch (err) {
      // A cache that can't be written costs lookups, never an answer.
      process.stderr.write(`[contract-translator] could not write ${cacheFile}: ${err.message}\n`);
    }
  };
  const notTicker = new Set(); // ids the broker described with a name that is no futures ticker

  const warned = new Set();
  // `readAt`: one time for every contract of one answer, so the answer's front month is the spec kept.
  const remember = (c, readAt = now().toISOString()) => {
    const t = c && c.id ? parseTicker(c.name, now()) : null;
    if (!t) return null;
    cache.ids[c.id] = { root: t.root, month: t.month };
    recordSpec(t.root, c, readAt);
    return t;
  };
  // The broker's tick spec for the root; a reply without sane numbers records nothing.
  const recordSpec = (root, c, readAt) => {
    const { validSpec, specMismatch } = require('../trading/broker-specs');
    const v = validSpec(c);
    if (!v) return;
    const active = c.activeContract === true;
    // In one answer listing several months (one readAt, however long the answer takes to record), the front month's
    // spec is the one kept.
    const had = cache.specs[root];
    if (had && had.readAt === readAt && had.active && !active) return;
    cache.specs[root] = {
      ...v, name: String(c.name), description: typeof c.description === 'string' ? c.description : null, id: String(c.id), active, readAt,
    };
    const why = specMismatch(root, v);
    if (why && !warned.has(why)) {
      warned.add(why);
      process.stderr.write(`[contract-translator] WARNING ${why}\n`);
    }
  };

  /** The contracts of a root, from search_contracts; refreshes its front month. */
  async function lookUpRoot(root) {
    const list = parseJson(await call('search_contracts', { searchText: root, live: false }));
    const at = now().toISOString();
    const mine = (Array.isArray(list) ? list : []).filter(c => { const t = remember(c, at); return t && t.root === root; });
    const active = mine.filter(c => c.activeContract);
    // The broker's own front month; without the flag, the nearest month.
    const front = (active.length ? active : mine).slice().sort((a, b) => cache.ids[a.id].month.localeCompare(cache.ids[b.id].month))[0];
    // Today's front month, once recorded, stays for the day (a lookup by month never moves it).
    if (front && !frontFresh(root)) cache.front[root] = { id: front.id, month: cache.ids[front.id].month, day: tradingDayKey(now()) };
    save();
    return mine;
  }

  const frontFresh = root => Boolean(cache.front[root]) && cache.front[root].day === tradingDayKey(now());
  // A contract a search_contracts answer marks active is its root's front month: it replaces one recorded on an
  // earlier day (yesterday's, before a roll). Within a trading day the front month stays fixed.
  const refreshFront = (root, id, month) => {
    if (!frontFresh(root)) cache.front[root] = { id, month, day: tradingDayKey(now()) };
  };

  /**
   * Today's front month of a root. Another process (gateway or runner) may have
   * looked it up today already: adopt its answer, so "MNQ" names one contract in
   * both, and search only when nobody has.
   */
  async function ensureFront(root) {
    if (frontFresh(root)) return;
    cache = mergeCache(readCache(cacheFile), cache);
    if (!frontFresh(root)) await lookUpRoot(root);
  }

  async function toBroker(name) {
    const std = parseStandardName(name);
    if (!std) throw new TranslationError(`"${name}" is not a contract name: use a root such as MNQ, NQ, ES (the front month) or MNQ:2026-12`);
    if (!std.month) {
      await ensureFront(std.root);
      if (!cache.front[std.root]) throw new TranslationError(`no ${std.root} contract found at this broker`);
      return cache.front[std.root].id;
    }
    const cached = () => Object.keys(cache.ids).find(id => cache.ids[id].root === std.root && cache.ids[id].month === std.month);
    let id = cached();
    if (!id) {
      await lookUpRoot(std.root);
      id = cached();
    }
    if (!id) throw new TranslationError(`no ${std.root} contract for ${std.month} at this broker`);
    return id;
  }

  async function toStandard(id) {
    if (id === null || id === undefined || id === '') return id;
    let known = cache.ids[id];
    if (!known && !notTicker.has(id)) {
      let c;
      try {
        c = parseJson(await call('get_contract', { contractId: id }));
      } catch (_err) {
        c = null; // a failed lookup is tried again next time
      }
      known = c ? remember(c) : null;
      if (known) save();
      else if (c) notTicker.add(id);
    }
    if (!known) return id; // not a futures ticker: left as the broker's id
    try {
      await ensureFront(known.root);
    } catch (_err) {
      // the search failed: the month's own name, which translates back without one. Never yesterday's front month
      // by the root: after a roll the root means another month today, and the gate would match the two.
    }
    const front = cache.front[known.root];
    return frontFresh(known.root) && front.id === id ? known.root : `${known.root}:${known.month}`;
  }

  async function translateArgs(tool, args = {}) {
    if (KEEP_ARGS.has(tool) || !args || typeof args.contractId !== 'string') return args;
    const id = args.contractId;
    // A broker id (seen in a result the translator could not name) goes through as is.
    if (cache.ids[id] || notTicker.has(id)) return args;
    if (!isStandardName(id) && isStandardName(id.trim().toUpperCase())) {
      throw new TranslationError(`"${id}" is not a contract name: write it as ${id.trim().toUpperCase()}`);
    }
    if (!isStandardName(id)) return args;
    return { ...args, contractId: await toBroker(id) };
  }

  /** Every contractId in a result (and the ids of contract tools' results), broker -> standard. */
  async function translateResult(tool, data) {
    const walk = async (v, contractList) => {
      if (Array.isArray(v)) {
        const out = [];
        for (const x of v) out.push(await walk(x, contractList));
        return out;
      }
      if (!v || typeof v !== 'object') return v;
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'contractId' && typeof x === 'string') out[k] = await toStandard(x);
        else if (k === 'id' && contractList && typeof x === 'string' && v.name !== undefined) out[k] = await toStandard(x);
        else out[k] = await walk(x, contractList);
      }
      return out;
    };
    if (tool === 'get_server_config') {
      // The server's order limits, for the gate's size check (local state for hooks and the gateway).
      cache.server = serverLimits(data, now().toISOString());
      save();
    }
    const contractList = CONTRACT_TOOLS.has(tool);
    if (contractList) {
      // Contract lists carry each contract's ticker: learn them all at once, no lookup per id.
      const items = (Array.isArray(data) ? data : [data]).filter(c => c && typeof c.id === 'string' && c.name !== undefined);
      let learned = false;
      const at = now().toISOString(); // one read time for the whole answer: its front month's spec is kept
      const active = {};
      for (const c of items) {
        const t = remember(c, at);
        if (t) learned = true;
        else notTicker.add(c.id);
        if (t && FRONT_TOOLS.has(tool) && c.activeContract === true && (!active[t.root] || t.month < active[t.root].month)) active[t.root] = { id: c.id, month: t.month };
      }
      // Only the answers whose activeContract the interface defines refresh a front month: a root's nearest active
      // month, as a lookup takes it.
      for (const [root, f] of Object.entries(active)) refreshFront(root, f.id, f.month);
      if (learned) save();
    }
    return walk(data, contractList);
  }

  return { toBroker, toStandard, translateArgs, translateResult, cache: () => cache };
}

module.exports = {
  CONTRACT_TOOLS, TranslationError,
  isStandardName, parseStandardName, parseTicker, readCache, serverLimits, standardRoot, canonicalName, frontMonth, monthName, createTranslator,
};
