'use strict';

/**
 * The broker's own bar fields as a briefing fact. A broker may add fields to its bars beyond t, o, h, l, c and v
 * (docs/BROKER-MCP-INTERFACE.md, get_bars); the harness passes them through untouched and gives them no meaning: what
 * a field means is the broker's, stated by the document that reads it. The briefing keeps the last few completed
 * bars' fields as they were served, so a role can read them across bars without the bars file.
 *
 *   brokerFieldsAt(bars, i, { last, maxBytes })   { paths, bars: [{ t, fields }] } for the `last` bars ending at bar i
 *                                                  (oldest first; reads bars 0..i only), or null when none of them
 *                                                  carries a field of its own. `paths`: every dotted path to a value
 *                                                  (not an object) on those bars, sorted. A bar whose fields take more
 *                                                  than `maxBytes` of JSON keeps only their size (`omitted`), so a
 *                                                  broker's large field never floods the briefing.
 *   fieldPathsOf(obj)                              the dotted paths to the values in an object, sorted
 *   barFieldDocsOf(config)                         { docs, dropped }: the server's own words for its bar fields (get_server_config
 *                                                  barFields, docs/BROKER-MCP-INTERFACE.md), the valid entries, at most
 *                                                  brokerFieldsShown, each meaning at most brokerFieldChars; `dropped` says why
 *                                                  any was left out; docs null when the server gives none. Never invented.
 *   brokerFieldsText(f, max)                       the summary's line: each path with its value on each bar, oldest
 *                                                  first ("a.b 0.5/null/0.3"), at most `max` bytes (the rest counted);
 *                                                  null without fields
 */

// A bar's own keys (and their long names, indicators.js BAR_KEYS), and `ms`, the time stamp the harness's bar loaders
// add (backtest/data.js): never the broker's.
const OWN = new Set(['t', 'o', 'h', 'l', 'c', 'v', 'time', 'open', 'high', 'low', 'close', 'volume', 'ms']);
const BF = require('../tunables').runner().prompt; // config/runner.json prompt
const TEXT_MAX = BF.brokerFieldChars;
const valueAt = (obj, p) => p.split('.').reduce((o, k) => (o && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), obj);
const LAST = BF.brokerFieldsKept;
const MAX_BYTES = BF.brokerFieldsBytes;

const SHOWN = BF.brokerFieldsShown;
const { barFieldProblems } = require('../broker/interface');

const isObject = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function fieldPathsOf(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(isObject(obj) ? obj : {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObject(v)) out.push(...fieldPathsOf(v, p)); else out.push(p);
  }
  return out.sort();
}

/** A bar's own fields (the broker's), as served: a copy, or null when it has none. */
function fieldsOf(bar) {
  const own = Object.entries(bar || {}).filter(([k]) => !OWN.has(k));
  return own.length ? JSON.parse(JSON.stringify(Object.fromEntries(own))) : null;
}

function barFieldDocsOf(config, { cap = SHOWN, chars = TEXT_MAX } = {}) {
  const given = config && typeof config === 'object' ? config.barFields : undefined;
  if (given === undefined || given === null) return { docs: null, dropped: [] };
  if (!isObject(given)) return { docs: null, dropped: barFieldProblems(given) };
  const dropped = [];
  const docs = {};
  for (const [path, e] of Object.entries(given)) {
    const bad = barFieldProblems({ [path]: e })[0];
    if (bad) dropped.push(bad);
    else if (e.meaning.length > chars) dropped.push(`${path}: meaning is over ${chars} characters`);
    else if (Object.keys(docs).length >= cap) dropped.push(`${path}: over the ${cap} fields printed`);
    else docs[path] = { meaning: e.meaning, ...(e.per !== undefined ? { per: e.per } : {}), ...(e.digits !== undefined ? { digits: Number(e.digits) } : {}) };
  }
  return { docs: Object.keys(docs).length ? docs : null, dropped };
}

/**
 * One value as the server's entry says to show it: divided by its `per` on the same bar (a ratio of two values the server
 * gave; null when either is missing or the divisor is 0) and rounded to its `digits`. Presentation only: the harness
 * knows neither field's meaning. A value that is not a number is shown as served.
 */
function presented(raw, entry, bar) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return raw;
  let x = raw;
  if (entry.per !== undefined) {
    const d = valueAt(bar, entry.per);
    if (typeof d !== 'number' || !Number.isFinite(d) || d === 0) return null;
    x = raw / d;
  }
  return entry.digits === undefined ? x : Number(x.toFixed(entry.digits));
}

function brokerFieldsAt(bars, i, { last = LAST, maxBytes = MAX_BYTES, docs = null } = {}) {
  if (!(i >= 0 && i < bars.length)) return null;
  const window = bars.slice(Math.max(0, i - last + 1), i + 1);
  const fields = window.map(fieldsOf);
  if (!fields.some(Boolean)) return null;
  const paths = new Set();
  const out = window.map((b, k) => {
    const f = fields[k];
    if (!f) return { t: b.t, fields: null };
    const bytes = Buffer.byteLength(JSON.stringify(f));
    if (bytes > maxBytes) return { t: b.t, omitted: `${bytes} bytes of fields, over ${maxBytes}` };
    for (const p of fieldPathsOf(f)) paths.add(p);
    return { t: b.t, fields: f };
  });
  const result = { paths: [...paths].sort(), bars: out };
  // The server's own words for the fields it described, each with its values as it says to show them (barFieldDocsOf).
  const described = docs ? Object.entries(docs).filter(([p]) => paths.has(p)) : [];
  if (described.length) result.shown = described.map(([path, e]) => ({ path, ...(e.per !== undefined ? { per: e.per } : {}), meaning: e.meaning, values: window.map((b, k) => (fields[k] && !out[k].omitted ? presented(valueAt(fields[k], path), e, b) : null)) }));
  return result;
}
const shown = v => (v === undefined || v === null ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

function brokerFieldsText(f, max = TEXT_MAX) {
  if (!f || !f.paths.length) return null;
  // The server described fields: those, each with its own words, as the server's text, never ours (BROKER-MCP-INTERFACE.md).
  if (Array.isArray(f.shown) && f.shown.length) {
    const head = `- Broker bar fields as the broker describes them (last ${f.bars.length} bars, oldest first; the rest are in the JSON): `;
    return `${head}${f.shown.map(s => `${s.path}${s.per !== undefined ? ` per ${s.per}` : ''} ${s.values.map(shown).join('/')} (${s.meaning})`).join('; ')}.`;
  }
  const head = `- Broker bar fields (last ${f.bars.length} bars, oldest first): `;
  const parts = f.paths.map(p => `${p} ${f.bars.map(b => shown(b.fields ? valueAt(b.fields, p) : null)).join('/')}`);
  let text = `${head}${parts.join('; ')}.`;
  for (let k = parts.length - 1; Buffer.byteLength(text) > max && k > 0; k -= 1) text = `${head}${parts.slice(0, k).join('; ')}; +${parts.length - k} more.`;
  return Buffer.byteLength(text) > max ? `${head}${f.paths.length} field${f.paths.length === 1 ? '' : 's'}, too long for this line; in the JSON.` : text;
}

module.exports = { barFieldDocsOf, LAST, MAX_BYTES, TEXT_MAX, fieldPathsOf, brokerFieldsAt, brokerFieldsText };
