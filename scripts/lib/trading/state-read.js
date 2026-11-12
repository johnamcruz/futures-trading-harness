'use strict';

/**
 * The head trader's market-state read in a closed form (the context-gap report's gap 5): one STATE line it writes
 * once per cycle with its PLAN (the trade-session skill, step 3), read here and scored field by field against the bar
 * briefing's own labels. A record for measurement and for what the model learns from, nothing more: no check, tool,
 * runner step or order path reads it, and a cycle without the line (or with a broken one) runs exactly as before.
 *
 *   STATE: 4h up | 1h up | 15m range | frames disagree
 *
 *   field       values                                    scored against
 *   4h          up | down | range | transition | unknown   h1.h4.trend
 *   1h          up | down | range | transition | unknown   h1.h1.trend
 *   15m         up | down | range | transition | unknown   m15.frame.trend
 *   frames      agree | disagree | unknown (or agree yes|no|unknown)   the three frame labels: all known and equal ->
 *                                                          yes; two known that differ -> no; else unknown
 *   frames-own  (derived, never written) the same word     the read's own three frame words (transition among them):
 *                                                          its internal consistency, scored without a briefing
 *
 *   class       trend-up | trend-down | chop | unclear      never scored: the model's own present read at this candle
 *   cites       a comma list of CITES names (the record's   never scored: the facts the class word rests on; a name
 *               own stateFacts fields)                      outside the list is dropped and counted (citesDropped)
 *
 *   citesStated names | none | absent                       names: a name written (kept or dropped); none: only `none`
 *                                                           or `n/a` written; absent: no cites field, or a bare label
 *
 * The class word and cites are read by equality only (case and markdown marks aside): `class chop` is the word, `class
 * choppy` or `class trend up` a bad item and no class. A line without the word, no line, or a conflicting or unparsable
 * one records the class `unstated` (classWord null); nothing fills it in from the briefing. Written last in the PLAN
 * (trader-process's template, trade-session step 3's words), `STATE: ... | class chop | cites 15m-trend, day-so-far`.
 *
 * No day field (the owner's decision): a day word would measure a mapping, not the read; it returns as one registry
 * entry with the Day so far line's own words. The day type is kept with the record's context (stateFacts).
 *
 * Items are separated by '|', ';', ',' or an en or em dash between spaces; case, spacing, markdown marks, any dash
 * inside an item and spellings like "15-min" or "4 hour" are read as the canonical words. Anything else (free text, a
 * negation, a bracket, a word outside the field's values) is a bad item, listed and never guessed. The label needs its
 * colon. Two lines that read the same are one read; a line whose items are a strict prefix of the other's gives way
 * to the complete one; any other two are conflicting (no read).
 *
 * A known blind spot: under prepare ahead "on", a confirmed cycle's run (a resumed session) logs only its new turns, and
 * the prepare run writes its own plan format, not the PLAN: such a cycle records `none` unless the confirm writes the line.
 *
 * Each field scores match, mismatch or unknown. Unknown, never a mismatch: a read the briefing has no label for (a
 * frame's transition: the frame labels are up, down or range), a label the briefing doesn't have (unknown, missing),
 * or a read the model itself left unknown. The score is the read's agreement
 * with the code's label, not a verdict on the read: the label can be stale (its own last break against it), so a
 * mismatch can be the better read. The labels' context (the trend rule, the regime, each frame's last break) is kept
 * with the record (stateFacts), never scored.
 *
 * The vocabulary is a registry (REGISTRY): one entry per field ({ key, slot, values, alias?, fact(briefing) ->
 * { value, field, ... } }), so a later read (the State, Day so far and Pullback lines) is one entry; the parser and
 * the scorer read only it.
 *
 *   parseStateLine(text, registry)   { status: read | none | unparsable | conflicting, read, missing, bad, lines, line }
 *   parseState(text, registry)       the read ({ frames, agree, ... }) or null
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

/** The day type so far as the briefing has it (recorded context, not scored: no day field until the Day so far line). */
function dayTypeOf(b) {
  const m3 = data(b, 'm3');
  return m3 && isObj(m3.today) && typeof m3.today.dayType === 'string' ? m3.today.dayType : null;
}

/** Whether three frame words agree: yes (all known, equal), no (two known differ), else null. */
function agreeOf(words) {
  const known = words.filter(Boolean);
  return new Set(known).size > 1 ? 'no' : known.length === Object.keys(FRAMES).length ? 'yes' : null;
}
/** The labels' agreement. */
const agreeFact = b => ({ value: agreeOf(Object.keys(FRAMES).map(k => frameFact(k)(b).value)), field: '4h, 1h and 15m trend labels', missing: 'not every frame label in the briefing, and the known ones agree' });
/** The read's own agreement: its three frame words (transition among them), unknown when one is unstated or unknown. */
function ownAgreeFact(_b, read) {
  const words = Object.keys(FRAMES).map(k => (isObj(read.frames) ? read.frames[k] : undefined));
  const value = words.every(w => w && w !== UNKNOWN) ? agreeOf(words) : null;
  return { value, field: 'the read\'s own 4h, 1h and 15m', missing: 'a frame of the read unstated or unknown' };
}

const REGISTRY = Object.freeze([
  ...Object.keys(FRAMES).map(key => Object.freeze({ key, slot: `frames.${key}`, values: FRAME_VALUES, checkable: v => LABELS.includes(v), fact: frameFact(key) })),
  // `frames agree|disagree` and `agree yes|no` are one field: the read's yes, no or unknown, against the labels.
  Object.freeze({ key: 'frames', slot: 'agree', values: ['yes', 'no', UNKNOWN], alias: { agree: 'yes', disagree: 'no' }, also: 'agree', fact: agreeFact }),
  // The same word against the read's own frames (its internal consistency): derived, never written, scored without a
  // briefing.
  Object.freeze({ key: 'frames-own', slot: 'agree', values: ['yes', 'no', UNKNOWN], derived: true, fact: ownAgreeFact }),
]);

// The model's own present read of the market at this candle, in closed words, and the facts it names as its basis (the
// record's own fields, stateFacts). Read by equality, recorded, never scored, never filled in from a briefing word.
const CLASS_WORDS = Object.freeze(['trend-up', 'trend-down', 'chop', 'unclear']);
const CITES = Object.freeze({
  '4h-trend': 'frames.4h', '1h-trend': 'frames.1h', '15m-trend': 'frames.15m', 'trend-rule': 'trendRule', regime: 'regime',
  'day-type': 'dayType', 'day-so-far': 'daySoFar', pullback: 'pullback', '1h-break': 'breaks.1h', '15m-break': 'breaks.15m', '3m-break': 'breaks.3m',
});
// `cites none` / `cites n/a`: no name cited, an empty list (not a dropped name).
const NO_NAME = Object.freeze(['none', 'n/a']);
// A class word in the regime's spelling (chop is a range; trend-up and trend-down are regime tags too; unclear has none):
// for a report or a test to tell a class word copied from the regime label. Never a check on a decision.
const AS_REGIME = Object.freeze({ 'trend-up': 'trend-up', 'trend-down': 'trend-down', chop: 'range' });
/** Whether a class word is the regime word in another spelling. */
const classIsRegime = (classWord, regime) => Object.prototype.hasOwnProperty.call(AS_REGIME, classWord) && AS_REGIME[classWord] === regime;

// The line's label: the word STATE (any case) at the line's start after markdown marks, a list mark or a table pipe,
// then ':'. Never inside prose ("the state: ..."), never another word ending in it.
const LABEL = /^[\s>#*_`|+\-\u2022]*(?:\d+[.)][\s>#*_`|]*)?STATE[*_`]*\s*:(.*)$/i;
// Every space separator to a space; every dash (U+2010-U+2015, the minus sign) inside an item to a hyphen.
const TO_ASCII = [[/\p{Zs}/gu, ' '], [/[\u2010-\u2015\u2212]/g, '-']];
// An en or em dash with space on both sides separates items, as '|' does.
const DASH_SEPARATOR = /\s[\u2013\u2014]\s/gu;

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
  for (const e of registry.filter(x => !x.derived)) {
    // `frames agree` / `agree yes`: the alias maps the first form's word to the value.
    if (key === e.key) {
      const v = e.alias && e.alias[word] !== undefined ? e.alias[word] : word;
      if (e.values.includes(v) && (!e.alias || e.alias[word] !== undefined || v === UNKNOWN)) return { entry: e, value: v };
    }
    if (e.also && key === e.also && e.values.includes(word)) return { entry: e, value: word };
  }
  return null;
}

/** One STATE line's items: { values: { key: value }, order: the key=value of each new item in order, bad, conflict, dropped }. */
function readLine(rest, registry) {
  const values = {};
  const order = [];
  const bad = [];
  const cites = [];
  let citesAt = null;
  let dropped = 0;
  let conflict = false;
  const set = (key, value) => {
    if (values[key] !== undefined && values[key] !== value) conflict = true;
    if (values[key] === undefined) order.push(`${key}=${value}`);
    values[key] = value;
  };
  const citeItems = [];
  let citesStated = 'absent';
  // An item that reads as a field (readItem) or a two-word `class <x>` item ends the cites list (`class bullish` then a bad
  // item, never a dropped name); any other item after `cites` (`15m break`, `class chop now`) is a name, dropped and
  // counted when it is none of CITES.
  const ends = (raw, [key, word, ...more]) => Boolean(readItem(raw, registry)) || (key === 'class' && word !== undefined && !more.length);
  // '|' and ';' (and a spaced dash) end a segment; ',' separates items, and inside a segment every item from `cites` on
  // is its names (a comma list): each kept only when it is a name of CITES, else dropped and counted; `none` and `n/a`
  // are no name (an empty list).
  for (const segment of rest.replace(DASH_SEPARATOR, ' | ').split(/[|;]/)) {
    let inCites = false;
    for (const raw of segment.split(',').map(x => x.trim()).filter(x => x && !/^[`*_.\s]*$/.test(x))) {
      const words = normalize(raw).split(' ').filter(Boolean);
      if (inCites && ends(raw, words)) inCites = false;
      if (!inCites && words[0] === 'cites') {
        inCites = true;
        words.shift();
        if (citesAt === null) citesAt = order.length;
      }
      if (inCites) {
        citeItems.push(normalize(raw));
        // `none` (or `n/a`) written, and no name, states that nothing cited supports the read; any other word is a name
        // written. A bare `cites` label states neither: absent.
        const named = words.filter(x => !NO_NAME.includes(x));
        if (named.length) citesStated = 'names';
        else if (citesStated === 'absent' && words.some(x => NO_NAME.includes(x))) citesStated = 'none';
        for (const w of named) if (!Object.prototype.hasOwnProperty.call(CITES, w)) dropped += 1; else if (!cites.includes(w)) cites.push(w);
        continue;
      }
      // `class <word>`: one of CLASS_WORDS by equality, else a bad item (never mapped).
      const [key, word, ...more] = words;
      if (key === 'class' && !more.length && CLASS_WORDS.includes(word)) { set('class', word); continue; }
      const got = readItem(raw, registry);
      if (!got) { bad.push(normalize(raw)); continue; }
      set(got.entry.key, got.value);
    }
  }
  if (cites.length) {
    values.cites = cites.join(',');
    order.splice(citesAt, 0, `cites=${values.cites}`);
  }
  return { values, order, bad, conflict, dropped, citeItems, citesStated };
}

/** Whether one line's items are a strict prefix of the other's (a short draft and the complete line). */
const strictPrefix = (a, b) => a.order.length < b.order.length && a.order.every((x, i) => x === b.order[i]);

/** The read in its shape ({ frames, agree, ... }), from the values by key, through each entry's slot. */
function shape(values, registry) {
  const read = { frames: {}, agree: null };
  for (const e of registry.filter(x => !x.derived)) {
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
  const out = (status, extra = {}) => ({ status, read: null, missing: [], bad: [], lines: found.length, line: found.length ? found[0].l.trim() : null, ...classOf(null), ...extra });
  if (!found.length) return out('none');
  const read = found.map(x => readLine(x.m[1], registry));
  // A line with only cites states no read (cites are what a read rests on): never the read, its cite items listed as bad
  // so a written cite leaves a trace; with no other line, unparsable.
  const isRead = r => Object.keys(r.values).some(k => k !== 'cites');
  const stated = read.filter(isRead);
  const bad = [...new Set([...read.flatMap(r => r.bad), ...read.filter(r => !isRead(r)).flatMap(r => r.citeItems)])];
  if (!stated.length) return out('unparsable', { bad });
  if (read.some(r => r.conflict)) return out('conflicting', { bad });
  // The same read, or one line strictly extending the other (its items a prefix): the complete one; else conflicting.
  let chosen = stated[0];
  for (const r of stated.slice(1)) {
    if (sameValues(r.values, chosen.values) || strictPrefix(r, chosen)) continue;
    if (strictPrefix(chosen, r)) { chosen = r; continue; }
    return out('conflicting', { bad });
  }
  const { values } = chosen;
  return out('read', { read: shape(values, registry), missing: registry.filter(e => !e.derived && values[e.key] === undefined).map(e => e.key), bad, ...classOf(chosen) });
}

/** The chosen line's class word and cites as written; without a read line, unstated (null, no cites). */
function classOf(line) {
  const v = line ? line.values : {};
  return { classWord: v.class || null, classStatus: v.class ? 'stated' : 'unstated', cites: v.cites ? v.cites.split(',') : [], citesStated: line ? line.citesStated : 'absent', citesDropped: line ? line.dropped : 0 };
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
    // A derived field reads the read itself (its own consistency): no briefing needed.
    const { value = null, field = null, missing = 'no label in the briefing', ...more } = briefing || e.derived ? e.fact(briefing, read) : {};
    const res = (result, why) => {
      counts[result] += 1;
      fields[e.key] = { read: v, fact: value, field, ...more, result, ...(why ? { why } : {}) };
    };
    if (v === UNKNOWN) res('unknown', 'read unknown');
    else if (!briefing && !e.derived) res('unknown', 'no bar briefing');
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
    dayType: dayTypeOf(b), regime: isObj(m3.regime) && typeof m3.regime.primary === 'string' ? m3.regime.primary : null,
    trendRule: typeof m3.trendRule === 'string' ? m3.trendRule : null,
    breaks: { '1h': breakOf('h1'), '15m': breakOf('m15'), '3m': breakOf('m3') },
    // The Day so far and Pullback lines' words at this bar (day-so-far.js, pullback-read.js pullbackWord): recorded so a
    // trade can be tagged with the reads present at its entry (trade-feedback.js), never scored.
    daySoFar: daySoFarWord(m3), pullback: 'pullback' in m3 ? require('./pullback-read').pullbackWord(m3.pullback) : null,
  };
}

/** The Day so far line's word at this bar: its read (directional, rotational, mixed), `too early`, else null. */
function daySoFarWord(m3) {
  const d = isObj(m3.today) && isObj(m3.today.soFar) ? m3.today.soFar : null;
  if (!d) return null;
  if (d.status === 'read' && typeof d.read === 'string') return d.read;
  return d.status === 'too early' ? 'too early' : null;
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
    return { status: parsed.status, line: parsed.line, read: parsed.read, missing: parsed.missing, bad: parsed.bad, classWord: parsed.classWord, classStatus: parsed.classStatus, cites: parsed.cites, citesStated: parsed.citesStated, citesDropped: parsed.citesDropped, symbol: s ? s.symbol : null, bar, briefing: b ? null : got.why, ...score, facts: stateFacts(b) };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { REGISTRY, FRAME_VALUES, CLASS_WORDS, CITES, AS_REGIME, classIsRegime, parseStateLine, parseState, scoreState, stateFacts, cycleStateRead };
