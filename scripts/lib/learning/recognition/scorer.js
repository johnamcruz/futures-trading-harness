'use strict';

/**
 * The recognition test's scorer (docs/TRAINING.md, "The recognition test"; frozen definitions 2, 3, 4, 8, 10, 11).
 * Read-only measurement, pure: no model, no file, no gate. Nothing that decides reads it.
 *
 * The model's vocabulary is closed (WORDS). Its class word and the fields it cites arrive on the cycle's STATE record as
 * `classWord` and `cites`; they are read by EQUALITY only (wordOf, citesOf), never parsed from the line's text or from
 * prose. A record without the key is `absent` (the run predates the field: "needs the class word in the run"); the key
 * with null is `unstated` (coverage), never filled in from the coded read; anything else outside the list is `invalid`,
 * counted apart and never a naming.
 *
 * A candle, as the scorer reads it: { rel (candles from the setup start), evidence (the class the visible evidence
 * supports at that candle: key.js evidenceWord), coded (the briefing's labels restated: key.js codedWord), model (the
 * model's closed word, or null for no naming) }.
 *
 *   WORDS, CITE_FIELDS
 *   wordOf(stateRead)                      { status: absent | unstated | invalid | stated, word }
 *   citesOf(stateRead)                     { status, cited (on the list, once each), offList }
 *   citedVsIgnored(cites, metFields)       { status, cited, ignored (met, not cited; null when no cites), citedWithoutSignal, offList }
 *   recognise(candles, known, margin)      the evidence candle and each reader's first naming: guess | on | lag | never,
 *                                          the delay, and whether it counts (right class, not before, within the margin)
 *   accuracy(candles)                      confusion (evidence rows, model columns) and the always-trend / always-chop baselines
 *   falseAlarms(candles, known)            spec D: candles naming the opposite KIND / candles naming a trend or chop word;
 *                                          a trend word the other way on a trend leg is `wrongWay`, apart
 *   summary(cases)                         trend vs chop only: n, cases, recall, precision, false-alarm rate, the coded
 *                                          read's recall beside, delay vs accuracy per case, by pace (listed)
 *   entryVsConfirmed(candles)              the entry against the first confirmed candle; in-trade cycles counted apart
 *   maskedChanged(real, masked)            item 11's pure part: the cycle ids whose word changed when dates are masked
 */

const WORDS = Object.freeze(['trend-up', 'trend-down', 'chop', 'unclear']);
// The closed list of fields the model may cite: the briefing fields the present-fact signals read (key.js FIELD_OF),
// plus the two higher frames the trend rule and the coded read read. The class-word change must use this list.
const CITE_FIELDS = Object.freeze(['4h', '1h', '15m', 'regime', 'day-so-far', 'vwap', 'day-type', 'bias', 'declared']);

const has = (o, k) => Boolean(o) && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isTrend = w => w === 'trend-up' || w === 'trend-down';
const kindOf = w => (isTrend(w) ? 'trend' : w === 'chop' ? 'chop' : null);

function wordOf(stateRead) {
  if (!has(stateRead, 'classWord')) return { status: 'absent', word: null };
  const w = stateRead.classWord;
  if (w === null) return { status: 'unstated', word: null };
  return WORDS.includes(w) ? { status: 'stated', word: w } : { status: 'invalid', word: null };
}

function citesOf(stateRead) {
  if (!has(stateRead, 'cites')) return { status: 'absent', cited: [], offList: [] };
  const c = stateRead.cites;
  if (c === null) return { status: 'unstated', cited: [], offList: [] };
  if (!Array.isArray(c)) return { status: 'invalid', cited: [], offList: [] };
  const cited = [...new Set(c.filter(x => CITE_FIELDS.includes(x)))];
  const offList = [...new Set(c.filter(x => !CITE_FIELDS.includes(x)).map(String))];
  return { status: 'stated', cited, offList };
}

function citedVsIgnored(cites, metFields) {
  const met = [...new Set(metFields || [])];
  if (!cites || cites.status !== 'stated') return { status: cites ? cites.status : 'absent', cited: [], ignored: null, citedWithoutSignal: [], offList: [] };
  return { status: 'stated', cited: cites.cited, ignored: met.filter(f => !cites.cited.includes(f)), citedWithoutSignal: cites.cited.filter(f => !met.includes(f)), offList: cites.offList };
}

function recognise(candles, known, margin) {
  const ev = candles.find(c => c.evidence === known);
  const evidenceFirst = ev ? ev.rel : null;
  const reader = key => {
    const f = candles.find(c => c[key] === known);
    const first = f ? f.rel : null;
    const timing = first === null ? 'never' : evidenceFirst === null || first < evidenceFirst ? 'guess' : first === evidenceFirst ? 'on' : 'lag';
    const delay = first === null || evidenceFirst === null ? null : first - evidenceFirst;
    return { first, timing, delay, counts: delay !== null && delay >= 0 && delay <= margin, named: candles.filter(c => kindOf(c[key])).length };
  };
  return { known, margin, evidenceFirst, model: reader('model'), coded: reader('coded') };
}

function accuracy(candles) {
  const confusion = {};
  let right = 0;
  let named = 0;
  for (const c of candles) {
    if (c.model === null || c.model === undefined) continue;
    named += 1;
    if (c.model === c.evidence) right += 1;
    const row = (confusion[c.evidence] = confusion[c.evidence] || {});
    row[c.model] = (row[c.model] || 0) + 1;
  }
  const n = candles.length;
  return {
    confusion, named, right, accuracy: named ? right / named : null,
    alwaysTrend: n ? candles.filter(c => isTrend(c.evidence)).length / n : null,
    alwaysChop: n ? candles.filter(c => c.evidence === 'chop').length / n : null,
  };
}

function falseAlarms(candles, known) {
  const own = kindOf(known);
  const named = candles.filter(c => kindOf(c.model));
  const opposite = named.filter(c => kindOf(c.model) !== own).length;
  const wrongWay = own === 'trend' ? named.filter(c => isTrend(c.model) && c.model !== known).length : 0;
  return { named: named.length, opposite, rate: named.length ? opposite / named.length : null, wrongWay };
}

function summary(cases) {
  const rows = cases.map(c => ({ c, r: recognise(c.candles, c.known, c.margin), a: accuracy(c.candles), f: falseAlarms(c.candles, c.known) }));
  const out = {};
  for (const k of ['trend', 'chop']) {
    const mine = rows.filter(x => kindOf(x.c.known) === k);
    const tp = mine.reduce((s, x) => s + x.c.candles.filter(c => c.model === x.c.known).length, 0);
    const named = rows.reduce((s, x) => s + x.c.candles.filter(c => kindOf(c.model) === k).length, 0);
    const recalled = mine.filter(x => x.r.model.counts).length;
    const faNamed = mine.reduce((s, x) => s + x.f.named, 0);
    const faOpp = mine.reduce((s, x) => s + x.f.opposite, 0);
    out[k] = {
      n: mine.length, cases: mine.map(x => x.c.id), recalled, recall: mine.length ? recalled / mine.length : null, precision: named ? tp / named : null,
      falseAlarmCandles: faOpp, falseAlarmRate: faNamed ? faOpp / faNamed : null, wrongWay: mine.reduce((s, x) => s + x.f.wrongWay, 0),
      codedRecalled: mine.filter(x => x.r.coded.counts).length,
    };
  }
  out.delayVsAccuracy = rows.map(x => ({ id: x.c.id, known: x.c.known, delay: x.r.model.delay, accuracy: x.a.accuracy }));
  out.byPace = {};
  for (const x of rows.filter(y => y.c.pace)) {
    const p = (out.byPace[x.c.pace] = out.byPace[x.c.pace] || { cases: [], recalled: 0 });
    p.cases.push(x.c.id);
    if (x.r.model.counts) p.recalled += 1;
  }
  return out;
}

function entryVsConfirmed(candles) {
  const fc = candles.find(x => x.confirmed);
  const en = candles.find(x => x.flat && x.action === 'enter');
  const firstConfirmed = fc ? fc.rel : null;
  const entry = en ? en.rel : null;
  const timing = entry === null ? 'no-entry' : firstConfirmed === null ? 'never-confirmed' : entry < firstConfirmed ? 'before' : entry === firstConfirmed ? 'on' : 'after';
  return {
    firstConfirmed, entry, timing, delta: entry !== null && firstConfirmed !== null ? entry - firstConfirmed : null,
    sitOutsWhileConfirmed: candles.filter(x => x.flat && x.confirmed && x.action === 'sit' && (entry === null || x.rel < entry)).length,
    inTrade: candles.filter(x => !x.flat).length,
  };
}

function maskedChanged(real, masked) {
  const m = new Map(masked.map(x => [x.id, x.word]));
  const both = real.filter(x => m.has(x.id));
  return { compared: both.length, changed: both.filter(x => m.get(x.id) !== x.word).map(x => x.id) };
}

module.exports = { WORDS, CITE_FIELDS, wordOf, citesOf, citedVsIgnored, recognise, accuracy, falseAlarms, summary, entryVsConfirmed, maskedChanged };
