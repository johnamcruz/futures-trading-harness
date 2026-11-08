'use strict';

/**
 * The head trader's market-state read in a closed form (the context-gap report's gap 5): one STATE line it writes
 * once per cycle with its PLAN (the trade-session skill, step 3), read here and scored field by field against the bar
 * briefing's own labels. A record for measurement and for what the model learns from, nothing more: no check, tool,
 * runner step or order path reads it, and a cycle without the line (or with a broken one) runs exactly as before.
 *
 *   STATE: 4h up | 1h up | 15m range | day trending | frames disagree
 *
 *   field    values                                    scored against (the briefing's label)
 *   4h       up | down | range | transition | unknown   h1.h4.trend
 *   1h       up | down | range | transition | unknown   h1.h1.trend
 *   15m      up | down | range | transition | unknown   m15.frame.trend
 *   day      trending | rotating | mixed | unknown       m3.today.dayType: trend up|down -> trending; neutral, inside
 *                                                        the initial balance -> rotating; normal variation -> mixed
 *   frames   agree | disagree | unknown (or agree yes|no|unknown)   the three frame labels: all known and equal -> yes;
 *                                                        two known that differ -> no; else unknown
 *
 * Items are separated by '|', ';' or ','; case, spacing, markdown marks and spellings like "15-min" or "4 hour" are
 * read as the canonical words. Anything else (free text, a negation, a bracket, a word outside the field's values) is
 * a bad item, listed and never guessed.
 *
 * Each field scores match, mismatch or unknown. Unknown, never a mismatch: a read the briefing has no label for (a
 * frame's transition: the frame labels are up, down or range), a label the briefing doesn't have (unknown, missing,
 * no day type before the initial balance), or a read the model itself left unknown. The score is the read's agreement
 * with the code's label, not a verdict on the read: the label can be stale (its own last break against it), so a
 * mismatch can be the better read. The labels' context (the trend rule, the regime, each frame's last break) is kept
 * with the record (stateFacts), never scored.
 *
 * The vocabulary is a registry (REGISTRY): one entry per field ({ key, slot, values, alias?, fact(briefing) ->
 * { value, field, ... } }), so a later read (the State, Day so far and Pullback lines) is one entry; the parser and
 * the scorer read only it.
 *
 *   parseStateLine(text, registry)   { status: read | none | unparsable | conflicting, read, missing, bad, lines, line }
 *   parseState(text, registry)       the read ({ frames, day, agree, ... }) or null
 *   scoreState(read, briefing, registry)   { fields: { <key>: { read, fact, field, result, why? } }, counts }
 *   stateFacts(briefing)             the labels and their context as the briefing had them, or null
 *   cycleStateRead({ home, text, context, now })   the cycle log's record (the cycle's first symbol, its bar's
 *                                    briefing: fact-claims.js briefingFor); never throws ({ error } on a failure)
 */

const FRAME_VALUES = ['up', 'down', 'range', 'transition', 'unknown'];
const LABELS = ['up', 'down', 'range'];
const UNKNOWN = 'unknown';

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const data = (b, name) => (isObj(b) && isObj(b.sections) && isObj(b.sections[name]) && isObj(b.sections[name].data) ? b.sections[name].data : null);
/** A frame's trend label as the briefing has it: up, down or range; null for anything else (unknown, missing). */
function trendOf(b, section, key) {
  const s = data(b, section);
  const t = s && isObj(s[key]) ? s[key].trend : null;
  return LABELS.includes(t) ? t : null;
}
const FRAMES = { '4h': ['h1', 'h4', 'h1.h4.trend'], '1h': ['h1', 'h1', 'h1.h1.trend'], '15m': ['m15', 'frame', 'm15.frame.trend'] };
const frameFact = key => b => ({ value: trendOf(b, FRAMES[key][0], FRAMES[key][1]), field: FRAMES[key][2], missing: `no ${key} trend in the briefing` });

/** The day type so far (day-context.js dayType) in the read's words; null before the initial balance or for a new type. */
function dayWord(dayType) {
  if (typeof dayType !== 'string') return null;
  if (/^trend (?:up|down)$/.test(dayType)) return 'trending';
  if (dayType === 'neutral' || dayType === 'inside the initial balance') return 'rotating';
  if (/^normal variation (?:up|down)$/.test(dayType)) return 'mixed';
  return null;
}
function dayFact(b) {
  const m3 = data(b, 'm3');
  const dayType = m3 && isObj(m3.today) && typeof m3.today.dayType === 'string' ? m3.today.dayType : null;
  return { value: dayWord(dayType), field: 'm3.today.dayType', dayType, missing: 'no day type in the briefing (none before the initial balance completes)' };
}

/** Whether the three frame labels agree: yes (all known, equal), no (two known differ), else null. */
function agreeFact(b) {
  const known = Object.keys(FRAMES).map(k => frameFact(k)(b).value).filter(Boolean);
  const value = new Set(known).size > 1 ? 'no' : known.length === Object.keys(FRAMES).length ? 'yes' : null;
  return { value, field: '4h, 1h and 15m trend labels', missing: 'not every frame label in the briefing, and the known ones agree' };
}

const REGISTRY = Object.freeze([
  ...Object.keys(FRAMES).map(key => Object.freeze({ key, slot: `frames.${key}`, values: FRAME_VALUES, checkable: v => LABELS.includes(v), fact: frameFact(key) })),
  Object.freeze({ key: 'day', slot: 'day', values: ['trending', 'rotating', 'mixed', UNKNOWN], fact: dayFact }),
  // `frames agree|disagree` and `agree yes|no` are one field: the read's yes, no or unknown.
  Object.freeze({ key: 'frames', slot: 'agree', values: ['yes', 'no', UNKNOWN], alias: { agree: 'yes', disagree: 'no' }, also: 'agree', fact: agreeFact }),
]);

// The line's label: the word STATE (any case) at the line's start after markdown marks, a list mark or a table pipe,
// then ':'. Never inside prose ("the state: ..."), never another word ending in it.
const LABEL = /^[\s>#*_`|+\-\u2022]*(?:\d+[.)][\s>#*_`|]*)?STATE[*_`]*\s*:(.*)$/i;
const TO_ASCII = [[/\p{Zs}/gu, ' '], [/[\u2013\u2014\u2212]/g, '-']];

/** An item in its plain words: lower case, marks and quotes dropped, "15-min" / "4 hour" read as 15m / 4h. */
function normalize(item) {
  return TO_ASCII.reduce((t, [re, to]) => t.replace(re, to), String(item)).toLowerCase().replace(/[`*"']/g, '')
    .replace(/\b(\d+)\s*-?\s*(?:min|mins|minute|minutes)\b/g, '$1m').replace(/\b(\d+)\s*-?\s*(?:hr|hrs|hour|hours)\b/g, '$1h')
    .replace(/[:=]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s_]+|[\s_.]+$/g, '');
}

/** One item read against the registry: { entry, value } or null (a bad item). */
function readItem(item, registry) {
  // An item is two words: the field, its value.
  const [key, word, ...more] = normalize(item).split(' ').filter(Boolean);
  if (word === undefined || more.length) return null;
  for (const e of registry) {
    // `frames agree` / `agree yes`: the alias maps the first form's word to the value.
    if (key === e.key) {
      const v = e.alias && e.alias[word] !== undefined ? e.alias[word] : word;
      if (e.values.includes(v) && (!e.alias || e.alias[word] !== undefined || v === UNKNOWN)) return { entry: e, value: v };
    }
    if (e.also && key === e.also && e.values.includes(word)) return { entry: e, value: word };
  }
  return null;
}

/** One STATE line's items: { values: { key: value }, bad, conflict }. */
function readLine(rest, registry) {
  const items = rest.split(/[|;,]/).map(x => x.trim()).filter(x => x && !/^[`*_.\s]*$/.test(x));
  const values = {};
  const bad = [];
  let conflict = false;
  for (const raw of items) {
    const got = readItem(raw, registry);
    if (!got) { bad.push(normalize(raw)); continue; }
    if (values[got.entry.key] !== undefined && values[got.entry.key] !== got.value) conflict = true;
    values[got.entry.key] = got.value;
  }
  return { values, bad, conflict };
}

/** The read in its shape ({ frames, day, agree, ... }), from the values by key, through each entry's slot. */
function shape(values, registry) {
  const read = { frames: {}, day: null, agree: null };
  for (const e of registry) {
    if (values[e.key] === undefined) continue;
    const [a, b] = e.slot.split('.');
    if (b) { read[a] = isObj(read[a]) ? read[a] : {}; read[a][b] = values[e.key]; } else read[a] = values[e.key];
  }
  return read;
}

const sameValues = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function parseStateLine(text, registry = REGISTRY) {
  const lines = String(text === null || text === undefined ? '' : text).replace(/\r\n|[\r\u2028\u2029\u0085]/g, '\n').split('\n');
  const found = lines.map(l => ({ l, m: LABEL.exec(l) })).filter(x => x.m);
  const out = (status, extra = {}) => ({ status, read: null, missing: [], bad: [], lines: found.length, line: found.length ? found[0].l.trim() : null, ...extra });
  if (!found.length) return out('none');
  const read = found.map(x => readLine(x.m[1], registry));
  const bad = [...new Set(read.flatMap(r => r.bad))];
  const stated = read.filter(r => Object.keys(r.values).length);
  if (!stated.length) return out('unparsable', { bad });
  if (read.some(r => r.conflict) || stated.some(r => !sameValues(r.values, stated[0].values))) return out('conflicting', { bad });
  const values = stated[0].values;
  return out('read', { read: shape(values, registry), missing: registry.filter(e => values[e.key] === undefined).map(e => e.key), bad });
}

const parseState = (text, registry = REGISTRY) => parseStateLine(text, registry).read;

/** The read's value for an entry (through its slot), or undefined when it isn't stated. */
function valueOf(read, e) {
  const [a, b] = e.slot.split('.');
  const v = b ? (isObj(read[a]) ? read[a][b] : undefined) : read[a];
  return v === null ? undefined : v;
}

function scoreState(read, briefing, registry = REGISTRY) {
  const fields = {};
  const counts = { match: 0, mismatch: 0, unknown: 0 };
  if (!isObj(read)) return { fields, counts };
  for (const e of registry) {
    const v = valueOf(read, e);
    if (v === undefined) continue;
    const { value = null, field = null, missing = 'no label in the briefing', ...more } = briefing ? e.fact(briefing) : {};
    const res = (result, why) => {
      counts[result] += 1;
      fields[e.key] = { read: v, fact: value, field, ...more, result, ...(why ? { why } : {}) };
    };
    if (v === UNKNOWN) res('unknown', 'read unknown');
    else if (!briefing) res('unknown', 'no bar briefing');
    else if (value === null) res('unknown', missing);
    // A read the briefing has no label for (a frame's transition) can't be checked against it.
    else if (e.checkable && !e.checkable(v)) res('unknown', `the briefing has no ${v} label for ${e.key}`);
    else res(v === value ? 'match' : 'mismatch');
  }
  return { fields, counts };
}

/** The labels the read is scored against and their context (recorded, not scored), as the briefing had them. */
function stateFacts(b) {
  if (!isObj(b) || !isObj(b.sections)) return null;
  const m3 = data(b, 'm3') || {};
  const breakOf = section => { const s = data(b, section); return s && isObj(s.lastBreak) && isObj(s.lastBreak.last) ? s.lastBreak.last.direction || null : null; };
  return {
    frames: Object.fromEntries(Object.keys(FRAMES).map(k => [k, frameFact(k)(b).value])),
    dayType: dayFact(b).dayType, regime: isObj(m3.regime) && typeof m3.regime.primary === 'string' ? m3.regime.primary : null,
    trendRule: typeof m3.trendRule === 'string' ? m3.trendRule : null,
    breaks: { '1h': breakOf('h1'), '15m': breakOf('m15'), '3m': breakOf('m3') },
  };
}

function cycleStateRead({ home, text, context = null, now = new Date() }) {
  try {
    const parsed = parseStateLine(String(text === null || text === undefined ? '' : text));
    const s = (isObj(context) && Array.isArray(context.symbols) ? context.symbols : []).find(x => isObj(x) && x.symbol) || null;
    const bar = s && isObj(s.bar) && s.bar.t ? s.bar.t : null;
    let got = { why: 'no cycle symbol' };
    if (s) {
      try { got = require('./fact-claims').briefingFor(home, s.symbol, { cycleBar: bar, now }); } catch (err) { got = { why: err.message }; }
    }
    const b = got.briefing || null;
    const score = scoreState(parsed.read, b);
    // An unscored field names why the briefing was unavailable.
    if (!b) for (const f of Object.values(score.fields)) if (f.why === 'no bar briefing') f.why = `no bar briefing (${got.why})`;
    return { status: parsed.status, line: parsed.line, read: parsed.read, missing: parsed.missing, bad: parsed.bad, symbol: s ? s.symbol : null, bar, briefing: b ? null : got.why, ...score, facts: stateFacts(b) };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { REGISTRY, FRAME_VALUES, parseStateLine, parseState, scoreState, stateFacts, cycleStateRead, dayWord };
