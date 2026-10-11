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
 * a name never changes meaning during a session (the harness is flat overnight).
 * Each contract the broker describes also records its root's tick spec there
 * (`specs`: { tickSize, tickValue, name, description, id, readAt }), the one
 * source of tick specs for live and replay trading (trading/broker-specs.js
 * reads it); a reply without sane numbers records nothing, and a spec that
 * differs from the static table (backtests, training) is reported on stderr.
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

function readCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A file from before specs were recorded has none: every root then has no spec.
    return { ids: plainObject(data.ids), front: plainObject(data.front), specs: plainObject(data.specs) };
  } catch (_err) {
    return { ids: {}, front: {}, specs: {} };
  }
}

/**
 * Merge into the file: the gateway's and the runner's translators share it, and
 * hooks read it, so one process never drops another's ids. Per root, the front
 * month of the later trading day wins.
 */
function mergeCache(into, from) {
  Object.assign(into.ids, from.ids);
  const valid = f => Boolean(f && f.id && typeof f.day === 'string');
  for (const [root, f] of Object.entries(from.front)) {
    if (valid(f) && (!valid(into.front[root]) || f.day >= into.front[root].day)) into.front[root] = f;
  }
  // Per root, the spec read later wins (a process's older read never replaces a newer one).
  const read = sp => Boolean(sp && typeof sp.readAt === 'string');
  for (const [root, sp] of Object.entries(from.specs || {})) {
    if (read(sp) && (!read(into.specs[root]) || sp.readAt >= into.specs[root].readAt)) into.specs[root] = sp;
  }
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
 * month that is the cache's front month becomes its root (MNQ:2026-12 ->
 * MNQ), and a broker id the cache knows becomes its standard name. Anything
 * else comes back as given. Local; no lookup.
 */
function canonicalName(id, cache) {
  if (typeof id !== 'string') return id;
  const std = parseStandardName(id);
  const known = std ? std.month && { root: std.root, month: std.month } : cache.ids[id];
  if (!known) return id;
  const front = cache.front[known.root];
  if (front && (front.month === known.month || front.id === id)) return known.root;
  return `${known.root}:${known.month}`;
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
  const remember = c => {
    const t = c && c.id ? parseTicker(c.name, now()) : null;
    if (!t) return null;
    cache.ids[c.id] = { root: t.root, month: t.month };
    recordSpec(t.root, c);
    return t;
  };
  // The broker's tick spec for the root; a reply without sane numbers records nothing.
  const recordSpec = (root, c) => {
    const { validSpec, specMismatch } = require('../trading/broker-specs');
    const v = validSpec(c);
    if (!v) return;
    const readAt = now().toISOString();
    const active = c.activeContract === true;
    // In one answer listing several months, the front month's spec is the one kept.
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
    const mine = (Array.isArray(list) ? list : []).filter(c => { const t = remember(c); return t && t.root === root; });
    const active = mine.filter(c => c.activeContract);
    // The broker's own front month; without the flag, the nearest month.
    const front = (active.length ? active : mine).slice().sort((a, b) => cache.ids[a.id].month.localeCompare(cache.ids[b.id].month))[0];
    if (front) cache.front[root] = { id: front.id, month: cache.ids[front.id].month, day: tradingDayKey(now()) };
    save();
    return mine;
  }

  const frontFresh = root => Boolean(cache.front[root]) && cache.front[root].day === tradingDayKey(now());

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
      // the search failed: yesterday's front month if there is one, else the month's own name (both translate back)
    }
    const front = cache.front[known.root];
    return front && front.id === id ? known.root : `${known.root}:${known.month}`;
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
    const contractList = CONTRACT_TOOLS.has(tool);
    if (contractList) {
      // Contract lists carry each contract's ticker: learn them all at once, no lookup per id.
      const items = (Array.isArray(data) ? data : [data]).filter(c => c && typeof c.id === 'string' && c.name !== undefined);
      let learned = false;
      for (const c of items) {
        if (remember(c)) learned = true;
        else notTicker.add(c.id);
      }
      if (learned) save();
    }
    return walk(data, contractList);
  }

  return { toBroker, toStandard, translateArgs, translateResult, cache: () => cache };
}

module.exports = {
  CONTRACT_TOOLS, TranslationError,
  isStandardName, parseStandardName, parseTicker, readCache, standardRoot, canonicalName, createTranslator,
};
