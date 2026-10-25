'use strict';

/**
 * Fact-checked reasons in risk-manager phase 2 (the learned-rulebook design's R29, #4): the facts phase 2 says its
 * verdict rests on, each checked in code against this cycle's bar briefing before the verdict stands. The model's
 * word is never taken for a fact the code can read.
 *
 * Phase 2 states them on one line under its verdict (agents/risk-manager.md), each item in one of a closed set of
 * forms, separated by ';':
 *
 *   FACTS: window opening drive; entries allowed; trend long allowed; read long aligned; room long enough; vwap above
 *
 *   type     form                                          the briefing fact it is checked against
 *   window   window <window name> | rth | overnight        m3.window (the session-timing windows; rth: 09:30-16:00 ET,
 *                                                         overnight: asia and london)
 *   entries  entries allowed | none                        m3.windowEntries (the gate's entry clock for the window)
 *   news     news clear | blackout                         m3.news.inBlackout
 *   trend    trend <long|short> allowed | blocked          m3.trendRule (the trend rule for that side)
 *   read     read <long|short> aligned|mixed|pullback|counter   m15.alignment for that side
 *   tf       15m | 1h | 4h up | down | range                m15.frame.trend, h1.h1.trend, h1.h4.trend
 *   vwap     vwap above | below | at                       m3.vwap.side (price against the VWAP that applies)
 *   value    value inside | above | below                  m3.location.priorValue (the prior RTH day's value area)
 *   room     room [<strategy>] <long|short> enough | short m3.candidates on that side: the first level in its way
 *                                                         (inTheWay.R) against the R it needs (needR)
 *
 * Each claim is true, false or unchecked. Unchecked, never guessed: an item in no known form ('unknown'), a fact the
 * briefing doesn't hold (no read, no scan, no setup on that side, setups on that side that disagree), or no briefing
 * for the cycle's bar.
 *
 * Where it applies:
 *   - the order gate (order-gate.js): an autonomous entry approved by a phase-2 report whose FACTS the briefing
 *     contradicts is refused, naming each; one whose stated facts can't be checked (no current briefing for the bar,
 *     the check failed) is refused too (fails closed). With a current briefing an approval must state at least
 *     MIN_CHECKED (2) claims it checks (owner's decision); without one, no FACTS line or `FACTS: none` passes. A report
 *     naming another cycle symbol and not the order's is refused (one symbol per report). Exits and protective orders
 *     never reach it.
 *   - the reason_check tool (harness-tools/reasons.js): phase 2 sees each claim checked before it answers, and
 *     decides again on a false one;
 *   - the cycle log (cycle-log.js): every phase-2 report's check, for the scorecard and the labels.
 *
 *   factsLines(text)                    the FACTS items stated (every FACTS line), or null when none
 *   withoutFacts(text)                  the text without its FACTS lines
 *   factsFrom(text)                     the text from its first FACTS line to its end, as written, or null
 *   otherSymbols(text, root, symbols)   the cycle symbols (not the root's family) a report names when it doesn't name
 *                                       the root's: the gate's one-symbol check ([] when none)
 *   dropFactsLabels(text)               the text without any FACTS line (its other lines as written)
 *   parseClaim(item)                    { type, text, side?, value, strategy? } (type 'unknown' when no form fits)
 *   checkClaim(claim, briefing)         the claim with check: true | false | 'unchecked' and fact (what the briefing says)
 *   checkFacts(text, briefing, why)     { stated, status: none|confirmed|false|unchecked, claims, unavailable }
 *   renderFacts(result)                 the check as text, for the roles
 *   briefingFor(home, root, { cycleBar, now })   { briefing } for the cycle's bar (none: current at now), or { why }
 *   gateRefusal({ report, home, root, cycleBars, now })  the order gate's message, or null (cycleBars: { <family root>: <bar open time> })
 *   cycleFactChecks({ home, output, context, now })  the cycle log's record of every phase-2 report's check
 */

const { readBriefing, current, WINDOWS } = require('./briefing');
const { trendRuleOf } = require('./reasons');
const { verdictOf, verdictProblem, cycleCalls } = require('./roles-ran');
const { familyRoot } = require('./contracts');
const { RTH_OPEN_MIN, RTH_CLOSE_MIN } = require('./clock');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const SIDES = ['long', 'short'];
const WINDOW_NAMES = [...new Set(WINDOWS.map(w => w[2]))];
// The RTH windows (09:30-16:00 ET) and the overnight ones, by their start and end minutes.
const RTH = new Set(WINDOWS.filter(([a, b]) => a >= RTH_OPEN_MIN && b <= RTH_CLOSE_MIN).map(w => w[2]));
const OVERNIGHT = new Set(['asia', 'london']);
const VALUES = {
  entries: ['allowed', 'none'], news: ['clear', 'blackout'], trend: ['allowed', 'blocked'],
  read: ['aligned', 'mixed', 'pullback', 'counter'], tf: ['up', 'down', 'range'], vwap: ['above', 'below', 'at'],
  value: ['inside', 'above', 'below'], room: ['enough', 'short'],
};
const TF = { '15m': ['m15', 'frame'], '1h': ['h1', 'h1'], '4h': ['h1', 'h4'] };
const MAX_ITEMS = require('../tunables').runner().gate.factsMaxItems; // config/runner.json gate (only falls)
const UNKNOWN = 'unknown';
// The checkable claims an approval states when the briefing is current (owner's decision, 2026-10-13).
const MIN_CHECKED = require('../tunables').runner().gate.factsMinChecked; // config/runner.json gate (only rises)
const FORMS = 'window <name>, entries allowed|none, news clear|blackout, trend <long|short> allowed|blocked, read <long|short> <aligned|mixed|pullback|counter>, 15m|1h|4h <up|down|range>, vwap above|below|at, value inside|above|below, room <long|short> enough|short';

// The FACTS line, sound by construction: exactly one canonical line whose first token, after optional whitespace,
// list marks, '>', '#', '*', '_', backticks or table pipes, is the exact ASCII word FACTS, an optional "(MNQ)" symbol,
// then ':'. It runs to the end of the report: every non-empty line from it on is items, each of which must parse, so
// nothing after it escapes the check. Every other line is free text, never parsed for claims (a line that only looks
// like a label is free text too: its claims are unchecked, as any prose's are). No canonical line, or more than one,
// and an approval can't stand (the gate). VERDICT lines are counted as the verdict parser (roles-ran verdictOf) reads
// them; a VERDICT line after the FACTS line is an item of its block and fails to parse.
const FACTS_LABEL = /^[\s>#*_`|+\-\u2022]*(?:\d+[.)][\s>#*_`|]*)?FACTS[*_`]*(?:\s*\(([A-Za-z0-9 ]*)\)[*_`]*)?\s*:(.*)$/;
const BULLET = /^\s*(?:[-*+\u2022>|]+|\d+[.)])\s*/;

// What makes an item ambiguous, refused and recorded false, never read as the claim without it: a negation (not, no,
// never, n't), any parenthesis or bracket (a second claim can hide inside one: "entries allowed (none)"), and any
// character outside printable ASCII (zero-width spaces, lookalike letters, tabs and other control characters) once the
// explicit list below is mapped.
const NEGATION = /\b(?:not|no|never|cannot|cant|dont|doesnt|isnt|arent|wont)\b|n't\b/i;
const BRACKET = /[()[\]{}]/;
const NON_ASCII = /[^\x20-\x7e]/;
// The only characters mapped to ASCII: every Unicode space separator (NBSP, thin space...) to a space, ordinary dashes
// and quotes.
const TO_ASCII = [[/\p{Zs}/gu, ' '], [/[\u2013\u2014\u2212]/g, '-'], [/[\u2018\u2019]/g, "'"], [/[\u201c\u201d]/g, '"']];
const toAscii = x => TO_ASCII.reduce((t, [re, to]) => t.replace(re, to), String(x));

/**
 * The report read: { items: the raw item strings from the first canonical FACTS line to the end (null when there is
 * none), labels: how many canonical FACTS lines, symbols: the "(SYM)" each names,
 * verdictProblem: why its verdicts don't make one approval, or null (roles-ran verdictProblem: the verdict parser's own
 * VERDICT-line matcher), rest: the lines before the FACTS line }.
 */
function factsParts(text) {
  // Every line ending to \n first (CRLF, CR, U+2028, U+2029, U+0085); every space separator to a space, dashes and
  // quotes to ASCII.
  const lines = toAscii(String(text || '').replace(/\r\n|[\r\u2028\u2029\u0085]/g, '\n')).split('\n');
  const raw = [];
  const rest = [];
  const symbols = [];
  let labels = 0;
  for (const line of lines) {
    const m = FACTS_LABEL.exec(line);
    if (m) {
      labels += 1;
      if (m[1] !== undefined) symbols.push(m[1].trim().toUpperCase());
      if (m[2].trim()) raw.push(m[2]);
      continue;
    }
    if (!labels) { rest.push(line); continue; }
    const item = line.replace(BULLET, '');
    if (item.replace(/[\s`*|]+/g, '')) raw.push(item);
  }
  return { items: labels ? raw : null, labels, symbols, verdictProblem: verdictProblem(text), rest };
}

/** The items of the FACTS block (raw strings) as claims' texts: split on ';', ',' or '|', cleaned. */
const splitItems = items => items.map(l => l.replace(/[`*]+/g, '')).flatMap(l => l.split(/[;,|]/))
  .map(x => x.toLowerCase().replace(/ +/g, ' ').replace(/^ +| +$/g, '').replace(/^_+|_+$/g, '').replace(/^ +| +$/g, '').replace(/\.$/, '').replace(/ +$/, ''))
  .filter(x => x && x !== 'none');

/**
 * The FACTS items stated (lower case; split on ';', ',' or '|'; backticks and asterisks dropped, underscores kept
 * (strategy names have them) except around an item; only ASCII spaces trimmed, so any other character stays for
 * parseClaim to refuse), or null when the text has no FACTS line.
 */
function factsLines(text) {
  const { items } = factsParts(text);
  return items === null ? null : splitItems(items);
}

/** The text without its FACTS lines (the free-text reasons alone). */
const withoutFacts = text => factsParts(text).rest.join('\n').trim();

const linesOf = text => String(text || '').replace(/\r\n|[\r\u2028\u2029\u0085]/g, '\n').split('\n');
/**
 * The text from its first FACTS line to its end, as written, trimmed, or null when there is none: every line the gate's
 * reading (factsParts) takes as the FACTS block, carried whole when the runner composes phase 2's decisive record
 * (phase2-restate.js), so the gate checks the same items.
 */
function factsFrom(text) {
  const lines = linesOf(text);
  const at = lines.findIndex(l => FACTS_LABEL.test(toAscii(l)));
  return at < 0 ? null : lines.slice(at).join('\n').trim();
}

/** The text without any FACTS line (every other line as written), trimmed. */
const dropFactsLabels = text => linesOf(text).filter(l => !FACTS_LABEL.test(toAscii(l))).join('\n').trim();

/**
 * An item in its plain words: quotes dropped, "15-min", "15 min" read as 15m (and "1-hour" as 1h), colons, '=' and
 * hyphens as spaces. Only spelling changes: the item still has to fit a closed form.
 */
function normalize(item) {
  return String(item || '').toLowerCase().replace(/["']/g, '')
    .replace(/\b(\d+)\s*-?\s*(?:min|mins|minute|minutes)\b/g, '$1m').replace(/\b(\d+)\s*-?\s*(?:hr|hrs|hour|hours)\b/g, '$1h')
    .replace(/[:=]/g, ' ').replace(/(?<=[a-z])-(?=[a-z])/g, ' ').replace(/\s+/g, ' ').replace(/\.$/, '').trim();
}

/** One item read in its form: { type, text, value, side?, strategy?, frame? }, or type 'unknown'. */
function parseClaim(item) {
  const text = toAscii(item || '').toLowerCase().replace(/ +/g, ' ').replace(/^ | $/g, '');
  const unknown = { type: 'unknown', text };
  if (NEGATION.test(text) || BRACKET.test(text) || NON_ASCII.test(text)) return { type: 'ambiguous', text };
  const plain = normalize(text);
  const m = /^([a-z0-9]+)\s*(.*)$/.exec(plain);
  if (!m) return unknown;
  const [, key, rest] = m;
  const words = rest.split(' ').filter(Boolean);
  // `<thing> unknown`: the model says the briefing doesn't hold it (true only when it indeed doesn't).
  const ok = (type, v) => v === UNKNOWN || VALUES[type].includes(v);
  if (key === 'window') {
    const v = rest.trim();
    return v === 'rth' || v === 'overnight' || v === UNKNOWN || WINDOW_NAMES.includes(v) ? { type: 'window', text, value: v } : unknown;
  }
  if (['entries', 'news', 'vwap', 'value'].includes(key)) return words.length === 1 && ok(key, words[0]) ? { type: key, text, value: words[0] } : unknown;
  if (TF[key]) return words.length === 1 && ok('tf', words[0]) ? { type: 'tf', text, frame: key, value: words[0] } : unknown;
  if (key === 'trend' || key === 'read') {
    return words.length === 2 && SIDES.includes(words[0]) && ok(key, words[1]) ? { type: key, text, side: words[0], value: words[1] } : unknown;
  }
  if (key === 'room') {
    const [strategy, side, value] = words.length === 3 ? words : [null, ...words];
    return words.length >= 2 && words.length <= 3 && SIDES.includes(side) && ok('room', value) && (strategy === null || /^[a-z0-9][a-z0-9_-]*$/.test(strategy))
      ? { type: 'room', text, side, value, ...(strategy ? { strategy } : {}) } : unknown;
  }
  return unknown;
}

const data = (b, name) => (isObj(b) && isObj(b.sections) && isObj(b.sections[name]) && isObj(b.sections[name].data) ? b.sections[name].data : null);

/** The room a candidate has: 'enough' | 'short', or null when its room is unknown (no stop, no need). */
function roomOf(c) {
  if (!isObj(c) || !(num(c.stopPoints) > 0) || num(c.needR) === null) return null;
  const way = isObj(c.inTheWay) ? num(c.inTheWay.R) : null;
  return way !== null && way < c.needR ? 'short' : 'enough';
}

/**
 * The claim checked against the briefing: { ...claim, check: true | false | 'unchecked', fact }. `order`: the order's own
 * setup ({ strategy, side }, the gate), which every room claim resolves to; a room claim about another strategy or side,
 * or any room claim when the order names no setup, can't be matched (unmatched: false, refused). Without an order (the
 * reason_check tool, the cycle log), a room claim is about the strategy it names, else the only setup on its side.
 * A `<thing> unknown` claim is true when the briefing indeed doesn't hold it, false when it does.
 */
function checkClaim(claim, b, order = null) {
  if (claim.value === UNKNOWN && claim.type !== 'ambiguous' && claim.type !== 'unknown') {
    const probe = checkClaim({ ...claim, value: claim.type === 'window' ? 'rth' : VALUES[claim.type][0] }, b, order);
    if (probe.unmatched) return { ...probe, value: UNKNOWN, text: claim.text };
    return probe.check === 'unchecked' ? { ...claim, check: true, fact: `the briefing doesn't hold it (${probe.fact})`, unknownValue: true }
      : { ...claim, check: false, fact: `the briefing holds it: ${probe.fact}` };
  }
  const res = (check, fact) => ({ ...claim, check, fact });
  if (claim.type === 'ambiguous') return res(false, 'a negation, a parenthesis or bracket, or a character outside plain ASCII: state each fact plainly, in its own form');
  if (claim.type === 'unknown') return res('unchecked', 'not a form this check knows (agents/risk-manager.md lists them)');
  const m3 = data(b, 'm3');
  if (!m3) return res('unchecked', 'no bar briefing');
  if (claim.type === 'window') {
    if (typeof m3.window !== 'string') return res('unchecked', 'the briefing has no session window');
    const fact = `the window is ${m3.window}`;
    if (claim.value === 'rth') return res(RTH.has(m3.window), `${fact} (${RTH.has(m3.window) ? 'RTH' : 'not RTH'})`);
    if (claim.value === 'overnight') return res(OVERNIGHT.has(m3.window), `${fact} (${OVERNIGHT.has(m3.window) ? 'overnight' : 'not overnight'})`);
    return res(m3.window === claim.value, fact);
  }
  if (claim.type === 'entries') {
    if (!VALUES.entries.includes(m3.windowEntries)) return res('unchecked', 'the briefing doesn\'t say whether the window allows entries');
    return res(m3.windowEntries === claim.value, m3.windowText || `the window's entries: ${m3.windowEntries}`);
  }
  if (claim.type === 'news') {
    const n = isObj(m3.news) ? m3.news.inBlackout : null;
    if (n !== true && n !== false) return res('unchecked', `the news state is unknown${isObj(m3.news) && m3.news.error ? ` (${m3.news.error})` : ''}`);
    return res((claim.value === 'blackout') === n, n ? `in a news blackout${m3.news.reason ? ` (${m3.news.reason})` : ''}` : 'no news blackout in force');
  }
  if (claim.type === 'trend') {
    const rule = trendRuleOf(m3.trendRule);
    const allows = rule[claim.side];
    if (allows !== true && allows !== false) return res('unchecked', 'the trend rule for that side is not in the briefing');
    return res((claim.value === 'allowed') === allows, String(m3.trendRule));
  }
  if (claim.type === 'vwap') {
    const side = isObj(m3.vwap) ? m3.vwap.side : null;
    if (!VALUES.vwap.includes(side)) return res('unchecked', 'the VWAP side is unknown');
    return res(side === claim.value, `price ${side} the VWAP${m3.vwap.applies ? ` (${m3.vwap.applies})` : ''}`);
  }
  if (claim.type === 'value') {
    const where = isObj(m3.location) ? m3.location.priorValue : null;
    if (!VALUES.value.includes(where)) return res('unchecked', 'the prior value area is unknown');
    return res(where === claim.value, `price ${where === 'inside' ? 'inside' : where} the prior value area`);
  }
  if (claim.type === 'read') {
    const m15 = data(b, 'm15');
    const al = m15 && isObj(m15.alignment) ? m15.alignment[claim.side] : null;
    if (!VALUES.read.includes(al)) return res('unchecked', 'the multi-timeframe read for that side is unknown');
    return res(al === claim.value, `the ${claim.side} read is ${al}`);
  }
  if (claim.type === 'tf') {
    const [section, key] = TF[claim.frame];
    const s = data(b, section);
    const trend = s && isObj(s[key]) ? s[key].trend : null;
    if (!VALUES.tf.includes(trend)) return res('unchecked', `the ${claim.frame} trend is unknown`);
    return res(trend === claim.value, `the ${claim.frame} trend is ${trend}`);
  }
  // room: the order's own setup (the gate), else the strategy named, else the only setup on that side.
  const unmatched = why => ({ ...res(false, why), unmatched: true });
  let strategy = claim.strategy || null;
  if (order) {
    if (!order.strategy || !order.side) return unmatched(`the order names no setup (setup:<strategy> <side>) for a room fact to be about`);
    if (claim.side !== order.side || (strategy && strategy !== order.strategy)) return unmatched(`it is about ${strategy ? `${strategy} ` : ''}${claim.side}, the order is ${order.strategy} ${order.side}`);
    strategy = order.strategy;
  }
  // A composed entry (trade_lifecycle): its own plan's room (order-gate.js factsOrder), never a scan candidate's.
  const own = order && isObj(order.room) ? [{ name: order.strategy, direction: order.side, ...order.room }] : null;
  if (!own && !Array.isArray(m3.candidates)) return res('unchecked', 'what fired is unknown (no scan for the bar)');
  const side = (own || m3.candidates).filter(c => isObj(c) && c.direction === claim.side);
  const on = strategy ? side.filter(c => c.name === strategy) : side;
  if (!strategy && on.length > 1) return unmatched(`${on.length} ${claim.side} setups (${on.map(c => c.name).join(', ')}): name the strategy, room <strategy> ${claim.side} ...`);
  if (!on.length) return res('unchecked', `no ${strategy ? `${strategy} ` : ''}setup on the ${claim.side} side`);
  const rooms = on.map(roomOf);
  const fact = on.map(c => (c.inTheWay ? `${c.name}: ${c.inTheWay.name} at ${c.inTheWay.R}R, it aims for ${c.needR}R` : `${c.name}: no level ahead, it aims for ${c.needR}R`)).join('; ');
  if (rooms.some(r => r === null)) return res('unchecked', `the room is unknown (${on.map(c => c.name).join(', ')})`);
  // The setup the claim is about, so the same fact counts once.
  return { ...res(rooms[0] === claim.value, fact), about: on[0].name };
}

/**
 * Every FACTS item in the text checked against the briefing (null briefing: `why` it is unavailable, each claim
 * unchecked). status: none (no FACTS line, or nothing on it), false (any claim false), unchecked (any unchecked),
 * confirmed (all true).
 */
function checkFacts(text, briefing, why = null, order = null) {
  const parts = factsParts(text);
  const { verdictProblem, labels, symbols } = parts;
  if (parts.items === null) return { stated: false, status: 'none', claims: [], unavailable: null, verdictProblem, labels, symbols };
  const unavailable = briefing ? null : (why || 'no bar briefing for the cycle\'s bar');
  const items = splitItems(parts.items);
  // An ambiguous item is false whatever the briefing holds.
  const claims = items.map(parseClaim).map(c => (briefing || c.type === 'ambiguous' ? checkClaim(c, briefing, order) : { ...c, check: 'unchecked', fact: unavailable }));
  const status = claims.some(c => c.check === false) ? 'false' : claims.some(c => c.check === 'unchecked') ? 'unchecked' : claims.length ? 'confirmed' : 'none';
  return { stated: true, status, claims, unavailable, verdictProblem, labels, symbols, ...(items.length > MAX_ITEMS ? { tooMany: items.length } : {}) };
}

const WORD = { true: 'TRUE', false: 'FALSE', unchecked: 'UNCHECKED' };

/** The check as text: each FACTS claim with the briefing's fact, and what a false one means. */
function renderFacts(r) {
  if (!r.stated) return 'FACTS: none stated (state the facts your verdict rests on: agents/risk-manager.md).\n';
  const out = [`FACTS checked against the bar briefing${r.unavailable ? ` (unavailable: ${r.unavailable})` : ''}:`];
  for (const c of r.claims) out.push(`- ${WORD[String(c.check)]} ${c.type}: "${c.text}" - ${c.fact}`);
  if (!r.claims.length) out.push('- none stated');
  const n = r.claims.filter(c => c.check === false).length;
  out.push(n ? `${n} FACT${n === 1 ? '' : 'S'} FALSE: name ${n === 1 ? 'it' : 'each'}, drop ${n === 1 ? 'it' : 'them'} and decide again from the briefing; the order gate refuses an entry approved on a false fact.`
    : r.unavailable && r.claims.length ? 'These facts can\'t be checked: the order gate refuses an entry approved on facts it can\'t check (write FACTS: none when there is no briefing).'
      : 'No fact is false by the briefing; an UNCHECKED one is still yours to check.');
  return `${out.join('\n')}\n`;
}

/**
 * The briefing field a claim is checked against: two claims from one field (trend long allowed and trend short blocked,
 * both from the trend-rule line) are one fact toward the two an approval needs.
 */
function sourceOf(c) {
  if (c.type === 'trend') return 'm3.trendRule';
  if (c.type === 'read') return `m15.alignment.${c.side}`;
  if (c.type === 'tf') return `tf.${c.frame}`;
  if (c.type === 'room') return `room.${c.about || c.side}`;
  return [c.type, c.side, c.frame].join('|');
}

/**
 * This cycle's briefing for the root: { briefing } when it is the cycle's bar's (cycleBar: its open time), or, with no
 * cycle bar, when it is current at `now` (its m3 still holds, as bar_briefing and reason_check judge it); else { why }.
 */
function briefingFor(home, root, { cycleBar = null, now = new Date() } = {}) {
  const b = readBriefing(home, root);
  if (!b || !isObj(b.sections)) return { why: `no bar briefing for ${familyRoot(root)}` };
  if (cycleBar && Date.parse(b.asOf) !== Date.parse(cycleBar)) return { why: `the ${familyRoot(root)} briefing is for the bar at ${b.asOf}, not the cycle's ${cycleBar}` };
  if (!cycleBar && !current(b, now)) return { why: `the ${familyRoot(root)} briefing (bar at ${b.asOf}) is no longer current` };
  return { briefing: b };
}

const word = x => String(x).replace(/[^A-Za-z0-9]/g, '');
/** Whether the text names the symbol (its root or its family's) as a word. */
const names = (text, sym) => new RegExp(`\\b(?:${word(sym)}|${word(familyRoot(sym))})\\b`, 'i').test(String(text || ''));
/** The cycle symbols (not the root's family) a report names, when it doesn't name the root's: about another plan. */
function otherSymbols(text, root, symbols) {
  const others = (Array.isArray(symbols) ? symbols : []).filter(k => k && familyRoot(k) !== familyRoot(root) && names(text, k));
  return others.length && !names(text, root) ? others : [];
}

/**
 * The order gate's check of an autonomous entry: the phase-2 report that approved it (roles-ran approvedPhase2:
 * { text } | { error } | null) and its FACTS against the briefing of the order's root. A message when an approved
 * fact is false or the stated facts can't be checked (fails closed), else null. Never throws.
 */
function gateRefusal({ report, home, root, cycleBars = null, now = new Date(), order = null }) {
  try {
    // report: the report, or a function reading it (its failure fails closed here too).
    if (typeof report === 'function') report = report();
    if (!report) return null;
    if (report.error) return `The cycle's transcript can't be read (${report.error}), so the gate can't check the facts phase 2 approved on: no entry this cycle.`;
    const tail = 'The approval doesn\'t stand. This refused trade-executor call ends the round: report the block, naming the false fact, and end the cycle (trade-session step 6); the next entry needs risk-manager phase 2 to decide again from the briefing.';
    // One symbol per report (agents/risk-manager.md): a report naming another cycle symbol and not the order's is about
    // another plan, so its facts can't be this order's.
    const others = otherSymbols(report.text, root, Object.keys(isObj(cycleBars) ? cycleBars : {}));
    if (others.length) return `The phase-2 report that approved this ${familyRoot(root)} entry names ${others.join(', ')}, not ${familyRoot(root)}: its facts can't be checked for this order (one symbol per report): no entry this cycle. ${tail}`;
    const cycleBar = (isObj(cycleBars) && cycleBars[familyRoot(root)]) || null;
    const got = briefingFor(home, root, { cycleBar, now });
    // The order's own setup: every room fact is about it (none named: no room fact can be matched).
    const r = checkFacts(report.text, got.briefing || null, got.why, order || { strategy: null, side: null });
    if (r.tooMany) return `The phase-2 report that approved this entry states ${r.tooMany} facts, more than ${MAX_ITEMS}: state the few your verdict rests on (at least ${MIN_CHECKED}): no entry this cycle. ${tail}`;
    if (r.labels > 1) return `The phase-2 report that approved this entry has ${r.labels} FACTS lines: one FACTS line per report, the last: no entry this cycle. ${tail}`;
    const otherSym = (r.symbols || []).filter(x => x && x !== String(root).toUpperCase());
    if (otherSym.length) return `The FACTS line names ${otherSym.join(', ')}, not this order's ${String(root).toUpperCase()}: its facts aren't this order's: no entry this cycle. ${tail}`;
    if (r.verdictProblem) return `The phase-2 report that approved this entry is no single approval: ${r.verdictProblem}. One verdict per report, then its FACTS line last: no entry this cycle. ${tail}`;
    const ambiguous = r.claims.filter(c => c.type === 'ambiguous');
    if (ambiguous.length) return `Risk-manager phase 2 approved on facts that can't be read plainly: ${ambiguous.map(c => `"${c.text}"`).join('; ')} (a negation, a parenthesis or bracket, or a character outside plain ASCII). State each fact plainly, in its own form, with no "not" and nothing in parentheses: no entry this cycle. ${tail}`;
    // With a current briefing every item must be a known form: one that isn't can't be checked, so the report isn't.
    const unknown = got.briefing ? r.claims.filter(c => c.type === 'unknown') : [];
    if (unknown.length) return `Risk-manager phase 2 approved on facts in no known form: ${unknown.map(c => `"${c.text}"`).join('; ')}. Write each fact exactly in one of the forms ${FORMS}, nothing else on the line: no entry this cycle. ${tail}`;
    const unmatched = r.claims.filter(c => c.unmatched);
    if (unmatched.length) return `Risk-manager phase 2 approved on room facts that can't be matched to this order${order && order.strategy ? ` (setup:${order.strategy} ${order.side})` : ''}: ${unmatched.map(c => `"${c.text}" (${c.fact})`).join('; ')}. A room fact is about the order's own setup: no entry this cycle. ${tail}`;
    const wrong = r.claims.filter(c => c.check === false);
    if (wrong.length) return `Risk-manager phase 2 approved on ${wrong.length === 1 ? 'a fact' : 'facts'} the bar briefing contradicts: ${wrong.map(c => `"${c.text}" (the briefing: ${c.fact})`).join('; ')}. ${tail}`;
    // The runner pinned this cycle's bar and its briefing is missing, corrupt or another bar's: an anomaly, refused
    // whatever was stated. No bar pinned and no current briefing: stated facts are refused, none (or FACTS: none) passes.
    if (!got.briefing && cycleBar) return `The bar briefing for this cycle's ${familyRoot(root)} bar (${cycleBar}) can't be read (${got.why}), so the facts phase 2 approved on can't be checked: no entry this cycle. ${tail}`;
    if (!got.briefing) return r.claims.length ? `The facts risk-manager phase 2 approved on can't be checked (${got.why}): no entry this cycle. ${tail}` : null;
    // A current briefing: a claim in a known form it can't confirm refuses (the model writes `<thing> unknown` instead).
    const unconfirmed = r.claims.filter(c => c.check === 'unchecked');
    if (unconfirmed.length) return `Risk-manager phase 2 approved on facts the bar briefing can't confirm: ${unconfirmed.map(c => `"${c.text}" (${c.fact})`).join('; ')}. Write \`<thing> unknown\` for what the briefing doesn't hold: no entry this cycle. ${tail}`;
    // An approval states at least MIN_CHECKED claims the briefing checks (owner's decision): distinct facts, by kind and
    // the setup or side they are about (the same fact twice counts once), `<thing> unknown` never among them.
    const checked = new Set(r.claims.filter(c => c.check === true && !c.unknownValue).map(sourceOf)).size;
    if (checked < MIN_CHECKED) return `Risk-manager phase 2 approved with ${checked} checkable fact${checked === 1 ? '' : 's'} (at least ${MIN_CHECKED} needed, in a FACTS line under the verdict, in the forms ${FORMS}, e.g. "FACTS: window opening drive; trend long allowed"): no entry this cycle. ${tail}`;
    return null;
  } catch (err) {
    return `The check of the facts risk-manager phase 2 approved on failed (${err.message}): no entry this cycle (fails closed).`;
  }
}

/** The cycle symbol a report is about: the only one, else the only one it names; null when that can't be told. */
function symbolOf(text, symbols) {
  if (symbols.length === 1) return symbols[0];
  const named = symbols.filter(s => names(text, s.symbol));
  return named.length === 1 ? named[0] : null;
}

/**
 * The cycle log's record (cycle-log.js): every risk-manager report with a verdict line (phase 2) in the cycle's
 * transcript, and in the runner's role record (context.rolesFile, runner-roles.js: phase 2 the runner ran itself, the
 * entry workflow's), its FACTS checked against the briefing of its symbol's cycle bar (context.symbols: [{ symbol, bar:
 * { t } }]). { reports: [{ verdict, symbol, stated, status, claims, unavailable }], counts: { reports, claims, true,
 * false, unchecked } }. Never throws: a failure is recorded as { error }.
 */
function cycleFactChecks({ home, output, context = null, now = new Date() }) {
  try {
    const symbols = (isObj(context) && Array.isArray(context.symbols) ? context.symbols : []).filter(s => isObj(s) && s.symbol);
    const rolesFile = isObj(context) && typeof context.rolesFile === 'string' && context.rolesFile ? context.rolesFile : null;
    const reports = cycleCalls(output, rolesFile).calls.filter(c => c.role === 'risk-manager' && verdictOf(c.text) !== null).map(c => {
      const s = symbolOf(c.text, symbols);
      const got = s ? briefingFor(home, s.symbol, { cycleBar: isObj(s.bar) ? s.bar.t : null, now }) : { why: symbols.length ? 'the report names no single cycle symbol' : 'no cycle symbol' };
      return { verdict: verdictOf(c.text), symbol: s ? s.symbol : null, ...checkFacts(c.text, got.briefing || null, got.why) };
    });
    const claims = reports.flatMap(r => r.claims);
    const count = v => claims.filter(c => c.check === v).length;
    return { reports, counts: { reports: reports.length, claims: claims.length, true: count(true), false: count(false), unchecked: count('unchecked') } };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { MIN_CHECKED, VALUES, factsLines, withoutFacts, factsFrom, dropFactsLabels, otherSymbols, parseClaim, checkClaim, checkFacts, renderFacts, briefingFor, gateRefusal, cycleFactChecks };
