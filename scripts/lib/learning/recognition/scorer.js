'use strict';

/**
 * The recognition test's scorer (docs/TRAINING.md, "The recognition test"; frozen definitions 2, 3, 4, 8, 10, 11).
 * Read-only measurement, pure: no model, no file, no gate. Nothing that decides reads it.
 *
 * The model's vocabulary is closed (WORDS). Its class word and the fields it cites arrive on the cycle's STATE record
 * (trading/state-read.js, the class-word change) as `classWord` (a closed word, or null when unstated) and `cites` (a
 * list of the record's closed cite names, CITE_FIELDS; names off the list dropped and counted in `citesDropped`). This
 * module is the only one here that names those keys; they are read by EQUALITY only (wordOf, citesOf), never parsed
 * from the line's text or from prose. A record without the key is `absent` (the run predates the field: "needs the
 * class word in the run"); null is `unstated` (coverage), never filled in from the coded read; anything else is
 * `invalid`, counted apart and never a naming.
 *
 * A candle, as the scorer reads it: { rel (candles from the setup start), evidence (the class the visible evidence
 * supports at that candle: key.js evidenceWord), coded (the briefing's labels restated: key.js codedWord), model (the
 * model's closed word, or null for no naming) }.
 *
 *   WORDS, CITE_FIELDS
 *   wordOf(record)                         { status: absent | unstated | invalid | stated, word }
 *   citesOf(record)                        { status, cited (on the list, once each), offList, dropped (the record's count) }
 *   citedVsIgnored(basis, metFields)       metFields: key.js field names of the met signals, mapped to cite names
 *                                          (CITE_OF; a field with none is `uncitable`, listed apart) -> { status, cited,
 *                                          ignored (met, citable, not cited; null when no cites), citedWithoutSignal,
 *                                          uncitable, offList, dropped }
 *   recognise(candles, known, margin)      the evidence candle and each reader's first naming: guess | on | lag | never,
 *                                          (fromEvidence, SUPPLEMENTARY: the first naming at or after the evidence candle)
 *                                          the delay, and whether it counts (right class, not before, within the margin)
 *   accuracy(candles)                      confusion (evidence rows, model columns) and the always-trend / always-chop baselines
 *   falseAlarms(candles, known)            spec D: candles naming the opposite KIND / candles naming a trend or chop word;
 *                                          a trend word the other way on a trend leg is `wrongWay`, apart
 *   interval(k, n, level)                  a Wilson interval (prop/stats.js wilson)
 *   summary(cases, { level })              trend vs chop only: n, cases, recall, precision, false-alarm rate (each with a
 *                                          Wilson interval at level), the coded read's recall beside, SUPPLEMENTARY columns
 *                                          (recalled from the evidence candle on; the false-alarm rate in the leg windows,
 *                                          case.inLeg), delay vs accuracy per case, by pace (listed)
 *   framesOf(record)                       the record's stated frame words ({ '4h', '1h', '15m' }, each a closed word or null), or null
 *   wordVsFrames(word, frames)             the model's word against its own frames: agrees | contradicts | unstated (the rule
 *                                          at the constant below; docs/TRAINING.md "The recognition test"; pinned by a test)
 *   tallyEntryWords(entries)               { n, byWord (trend-up, trend-down, chop, unclear, unstated), byWordVsFrames }
 *   entryVsConfirmed(candles)              the entry against the first confirmed candle; in-trade cycles counted apart
 *   maskedChanged(real, masked)            item 11's pure part: the cycle ids whose word changed when dates are masked
 */

const { wilson } = require('../../prop/stats');

const WORDS = Object.freeze(['trend-up', 'trend-down', 'chop', 'unclear']);
// The record's closed cite names (trading/state-read.js CITES on the class-word change; a test holds them equal once it
// exports them), and the cite name of each field a present-fact signal reads (key.js): none for the VWAP crosses and the
// declared trend, which the record's list doesn't name (uncitable: met, never counted as ignored).
const CITE_FIELDS = Object.freeze(['4h-trend', '1h-trend', '15m-trend', 'trend-rule', 'regime', 'day-type', 'day-so-far', 'pullback', '1h-break', '15m-break', '3m-break']);
const CITE_OF = Object.freeze({ '15m': '15m-trend', regime: 'regime', 'day-so-far': 'day-so-far', 'day-type': 'day-type', bias: 'trend-rule', vwap: null, declared: null });

// The model's own frames, read from the STATE record's read.frames by equality (state-read.js FRAME_VALUES words).
const FRAME_KEYS = Object.freeze(['4h', '1h', '15m']);
const FRAME_WORDS = Object.freeze(['up', 'down', 'range', 'transition', 'unknown']);
const VS_FRAMES = Object.freeze(['agrees', 'contradicts', 'unstated']);
// THE rule for a word against the model's own frames (measurement only; a fixed equality rule, never the briefing's labels):
//   no word, or no frame stated                     unstated
//   trend-up / trend-down                           contradicts when the 4h and 1h are both `range`, or the 4h or the 1h is
//                                                   the opposite way (a 15m against is a pullback: agrees)
//   chop                                            contradicts when the 4h, 1h and 15m are the same way, up or down
//   anything else (incl. unclear)                   agrees
const OPPOSITE = Object.freeze({ 'trend-up': 'down', 'trend-down': 'up' });

const has = (o, k) => Boolean(o) && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isTrend = w => w === 'trend-up' || w === 'trend-down';
const kindOf = w => (isTrend(w) ? 'trend' : w === 'chop' ? 'chop' : null);

function wordOf(rec) {
  if (!has(rec, 'classWord')) return { status: 'absent', word: null };
  const w = rec.classWord;
  if (w === null) return { status: 'unstated', word: null };
  return WORDS.includes(w) ? { status: 'stated', word: w } : { status: 'invalid', word: null };
}

function framesOf(rec) {
  const fr = has(rec, 'read') && has(rec.read, 'frames') && rec.read.frames && typeof rec.read.frames === 'object' ? rec.read.frames : null;
  if (!fr) return null;
  const out = Object.fromEntries(FRAME_KEYS.map(k => [k, FRAME_WORDS.includes(fr[k]) ? fr[k] : null]));
  return FRAME_KEYS.some(k => out[k] !== null) ? out : null;
}

function wordVsFrames(word, frames) {
  if (!WORDS.includes(word) || !frames) return 'unstated';
  const { '4h': h4, '1h': h1, '15m': m15 } = frames;
  if (isTrend(word)) return (h4 === 'range' && h1 === 'range') || h4 === OPPOSITE[word] || h1 === OPPOSITE[word] ? 'contradicts' : 'agrees';
  if (word === 'chop') return (h4 === 'up' || h4 === 'down') && h1 === h4 && m15 === h4 ? 'contradicts' : 'agrees';
  return 'agrees';
}

function tallyEntryWords(entries) {
  const byWord = { 'trend-up': 0, 'trend-down': 0, chop: 0, unclear: 0, unstated: 0 };
  const byWordVsFrames = { agrees: 0, contradicts: 0, unstated: 0 };
  for (const e of entries) {
    byWord[WORDS.includes(e.modelWord) ? e.modelWord : 'unstated'] += 1;
    byWordVsFrames[VS_FRAMES.includes(e.wordVsFrames) ? e.wordVsFrames : 'unstated'] += 1;
  }
  return { n: entries.length, byWord, byWordVsFrames };
}

// The record's citesStated: absent (no cites item written: unstated), none (`cites none`: stated, nothing cited),
// names (a name written, kept or dropped: stated, the list). Read by equality; a record without it is absent.
const CITES_STATED = Object.freeze({ absent: 'unstated', none: 'stated', names: 'stated' });
function citesOf(rec) {
  const dropped = has(rec, 'citesDropped') && Number.isInteger(rec.citesDropped) ? rec.citesDropped : 0;
  if (!has(rec, 'citesStated')) return { status: 'absent', cited: [], offList: [], dropped };
  const status = Object.prototype.hasOwnProperty.call(CITES_STATED, rec.citesStated) ? CITES_STATED[rec.citesStated] : 'invalid';
  const c = rec.cites;
  if (status === 'invalid' || !Array.isArray(c)) return { status: 'invalid', cited: [], offList: [], dropped };
  if (status === 'unstated') return { status, cited: [], offList: [], dropped };
  const cited = [...new Set(c.filter(x => CITE_FIELDS.includes(x)))];
  const offList = [...new Set(c.filter(x => !CITE_FIELDS.includes(x)).map(String))];
  return { status: 'stated', cited, offList, dropped };
}

function citedVsIgnored(basis, metFields) {
  const fields = [...new Set(metFields || [])];
  const met = [...new Set(fields.map(f => CITE_OF[f]).filter(Boolean))];
  const uncitable = fields.filter(f => !CITE_OF[f]);
  if (!basis || basis.status !== 'stated') return { status: basis ? basis.status : 'absent', cited: [], ignored: null, citedWithoutSignal: [], uncitable, offList: [], dropped: basis ? basis.dropped || 0 : 0 };
  return { status: 'stated', cited: basis.cited, ignored: met.filter(f => !basis.cited.includes(f)), citedWithoutSignal: basis.cited.filter(f => !met.includes(f)), uncitable, offList: basis.offList, dropped: basis.dropped || 0 };
}

function recognise(candles, known, margin) {
  const ev = candles.find(c => c.evidence === known);
  const evidenceFirst = ev ? ev.rel : null;
  const reader = key => {
    const f = candles.find(c => c[key] === known);
    const first = f ? f.rel : null;
    const timing = first === null ? 'never' : evidenceFirst === null || first < evidenceFirst ? 'guess' : first === evidenceFirst ? 'on' : 'lag';
    const delay = first === null || evidenceFirst === null ? null : first - evidenceFirst;
    // Supplementary (no definition changes): the first naming at or after the evidence candle, so a word named early
    // and held (a guess by the frozen rule) shows whether it was also named from the evidence candle on.
    const g = evidenceFirst === null ? null : candles.find(c => c.rel >= evidenceFirst && c[key] === known);
    const gDelay = g ? g.rel - evidenceFirst : null;
    return {
      first, timing, delay, counts: delay !== null && delay >= 0 && delay <= margin, named: candles.filter(c => kindOf(c[key])).length,
      fromEvidence: { first: g ? g.rel : null, delay: gDelay, counts: gDelay !== null && gDelay <= margin },
    };
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

/** A Wilson interval for k of n at the level (prop/stats.js wilson, the harness's own). */
const interval = (k, n, level) => wilson(k, n, level);

function summary(cases, { level = null } = {}) {
  const iv = (k, n) => (level ? interval(k, n, level) : null);
  const rows = cases.map(c => ({ c, r: recognise(c.candles, c.known, c.margin), a: accuracy(c.candles), f: falseAlarms(c.candles, c.known), leg: Array.isArray(c.inLeg) ? falseAlarms(c.inLeg, c.known) : null }));
  const out = {};
  for (const k of ['trend', 'chop']) {
    const mine = rows.filter(x => kindOf(x.c.known) === k);
    const tp = mine.reduce((s, x) => s + x.c.candles.filter(c => c.model === x.c.known).length, 0);
    const named = rows.reduce((s, x) => s + x.c.candles.filter(c => kindOf(c.model) === k).length, 0);
    const recalled = mine.filter(x => x.r.model.counts).length;
    const faNamed = mine.reduce((s, x) => s + x.f.named, 0);
    const faOpp = mine.reduce((s, x) => s + x.f.opposite, 0);
    const legs = mine.filter(x => x.leg);
    const legNamed = legs.reduce((s, x) => s + x.leg.named, 0);
    const legOpp = legs.reduce((s, x) => s + x.leg.opposite, 0);
    out[k] = {
      n: mine.length, cases: mine.map(x => x.c.id), recalled, recall: mine.length ? recalled / mine.length : null, recallInterval: iv(recalled, mine.length),
      precision: named ? tp / named : null, precisionInterval: iv(tp, named),
      falseAlarmCandles: faOpp, falseAlarmRate: faNamed ? faOpp / faNamed : null, falseAlarmInterval: iv(faOpp, faNamed), wrongWay: mine.reduce((s, x) => s + x.f.wrongWay, 0),
      codedRecalled: mine.filter(x => x.r.coded.counts).length, codedRecallInterval: iv(mine.filter(x => x.r.coded.counts).length, mine.length),
      // Supplementary columns (no definition changes; the frozen ones above decide): a word named early and held scores a
      // guess/miss above, and a right chop word before a late leg counts as a false alarm over the whole day.
      supplementary: {
        recalledFromEvidence: mine.filter(x => x.r.model.fromEvidence.counts).length,
        falseAlarmRateInLeg: legNamed ? legOpp / legNamed : null, falseAlarmInLegInterval: legs.length ? iv(legOpp, legNamed) : null,
      },
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

module.exports = { FRAME_KEYS, framesOf, wordVsFrames, tallyEntryWords, WORDS, CITE_FIELDS, CITE_OF, wordOf, citesOf, citedVsIgnored, recognise, accuracy, falseAlarms, interval, summary, entryVsConfirmed, maskedChanged };
