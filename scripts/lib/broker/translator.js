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

function readCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ids: data.ids || {}, front: data.front || {} };
  } catch (_err) {
    return { ids: {}, front: {} };
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

  const remember = c => {
    const t = c && c.id ? parseTicker(c.name, now()) : null;
    if (!t) return null;
    cache.ids[c.id] = { root: t.root, month: t.month };
    return t;
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
  isStandardName, parseStandardName, parseTicker, readCache, standardRoot, createTranslator,
};
