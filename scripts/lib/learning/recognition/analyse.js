'use strict';

/**
 * The recognition test's per-case analysis (docs/TRAINING.md, "The recognition test"): the five measures for one case
 * over its candles, and the summary over cases. Read-only measurement, pure; nothing that decides reads it.
 *
 * A candle (run.js): { ms (its bar close), trace (trace.js: { key, sides }; null when the bars hold no bar closing
 * there), read: { kind: entry | pass | in-trade, side, word (scorer.wordOf), basis (its cites: scorer.citesOf) } }. rel = candles
 * from rel 0 (config.js startCloseOf). An in-trade cycle is counted (`inTrade`), never a sit-out or an entry decision.
 *
 *   1 first recognition   the model's first candle naming the known class: guess | on | lag against the first candle the
 *                         visible evidence supports it, the delay in candles, whether it counts (the frozen margin); the
 *                         coded read's first candle beside it, by the same rule
 *   2 evidence then       at the evidence's, the coded read's and the model's first candles: the signals met, the
 *                         confluence for the side (required flow steps met, confirmed, declaredOf), and the model's cites
 *                         against the fields carrying a met signal (cited, ignored, cited without a signal, off the list)
 *   3 entry               the entry candle against the first candle barFacts confirms the side (trend legs)
 *   entries              (both kinds) each entry's modelWord, frames and wordVsFrames (the model's word against its own
 *                         stated frames, scorer.wordVsFrames), tallied in summarize's entryWords
 *   4 chop days           names chop? at which candle; the sit rate; every entry with its present class and confluence,
 *                         flagged before the naming or not
 *   5 misses              a trend leg the model never recognised within the margin, with what the evidence showed in it
 * A run without the class word (every candle `absent`) has 1, 2 (the model's), 4 (the naming) and 5 marked as needing
 * it: null, never substituted by the coded read or by prose.
 *
 *   analyse(case, candles, { minutes })   one case (case: config.js's, with startClose and endClose)
 *   summarize(analyses, { level })        scorer.summary (Wilson intervals at level) over the cases whose run carries
 *                                         the class word, the cases needing it, those with no candle (no bars at any
 *                                         cycle: "no candles"), and the entry vs confirmed tally of the trend legs
 */

const { MINUTE } = require('../../backtest/data');
const K = require('./key');
const S = require('./scorer');

const knownOf = c => (c.kind === 'trend' ? (c.side === 'long' ? 'trend-up' : 'trend-down') : 'chop');
const tally = (list, f) => list.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});

/** An entry's own word and frames from its STATE record, and the word against the frames (scorer.wordVsFrames): recorded fields only. */
function ownRead(c) {
  const word = c.read.word.status === 'stated' ? c.read.word.word : null;
  const frames = c.read.frames || null;
  return { modelWord: word, frames, wordVsFrames: S.wordVsFrames(word, frames) };
}

function confl(c, side) {
  if (!side) return null;
  const s = c.trace.sides[side] || {};
  return { side, reqMet: s.reqMet ?? null, reqTotal: s.reqTotal ?? null, met: s.met || [], confirmed: s.confirmed === true, blocker: s.confirmed ? null : s.why || s.error || null, declared: s.declared ?? null };
}

/** Candles with a trace, with rel and the three readers' words (the model's only when stated). */
function prep(candles, startClose, minutes) {
  const step = minutes * MINUTE;
  return candles.filter(c => c.trace).map(c => {
    const evidence = K.evidenceWord(c.trace.key);
    const coded = K.codedWord(c.trace.key);
    // The model's word only when stated: never the coded word (computed beside it, for this candle), never the evidence.
    const model = c.read.word.status === 'stated' ? c.read.word.word : null;
    return { ...c, rel: Math.round((c.ms - startClose) / step), evidence, coded, model, flat: c.read.kind !== 'in-trade' };
  });
}

function coverage(P) {
  const w = tally(P, c => c.read.word.status);
  const k = tally(P, c => c.read.basis.status);
  const of = P.length;
  return {
    // Needs the class word: candles, every one without the key. No candle at all is "no candles" (noCandles), not this.
    wordCoverage: { stated: w.stated || 0, unstated: w.unstated || 0, invalid: w.invalid || 0, absent: w.absent || 0, of, needsClassWord: of > 0 && (w.absent || 0) === of },
    basis: { stated: k.stated || 0, unstated: k.unstated || 0, invalid: k.invalid || 0, absent: k.absent || 0, offList: P.reduce((s, c) => s + c.read.basis.offList.length, 0) },
  };
}

function evidenceAt(P, rel, side, withBasis) {
  const c = rel === null ? null : P.find(x => x.rel === rel);
  if (!c) return null;
  const s = side || c.trace.key.biasSide || null;
  const sig = c.trace.key.signals[s || 'none'];
  return {
    rel, evidence: c.evidence, coded: c.coded, side: s, signals: [...sig.c, ...sig.t], confluence: confl(c, s),
    ...(withBasis ? { basis: S.citedVsIgnored(c.read.basis, K.metFields(c.trace.key, s)) } : {}),
  };
}

function analyse(cse, candles, { minutes }) {
  const P = prep(candles, cse.startClose, minutes);
  const known = knownOf(cse);
  const side = cse.kind === 'trend' ? cse.side : null;
  const cov = coverage(P);
  const noCandles = P.length === 0;
  const needs = cov.wordCoverage.needsClassWord || noCandles; // the model's measures: none to give
  const rec = S.recognise(P, known, cse.margin);
  const legW = side ? P.filter(c => c.ms >= cse.startClose && c.ms <= cse.endClose) : null;
  const out = {
    id: cse.id, kind: cse.kind, known, side, pace: cse.pace || null, margin: cse.margin,
    candles: P.length, noCandles, noBars: candles.length - P.length, inTrade: P.filter(c => !c.flat).length, ...cov,
    firstEvidenceRel: rec.evidenceFirst, firstCodedRel: rec.coded.first, coded: rec.coded, model: needs ? null : rec.model,
    evidenceThen: { evidence: evidenceAt(P, rec.evidenceFirst, side, false), coded: evidenceAt(P, rec.coded.first, side, false), model: needs ? null : evidenceAt(P, rec.model.first, side, true) },
    accuracyCoded: S.accuracy(P.map(c => ({ ...c, model: c.coded }))), accuracy: needs ? null : S.accuracy(P), falseAlarms: needs ? null : S.falseAlarms(P, known),
    // SUPPLEMENTARY (no definition changes): the first naming from the evidence candle on, and a leg's false alarms
    // inside its window (a right chop word before a late leg is a false alarm over the whole day).
    supplementary: needs ? null : { fromEvidence: rec.model.fromEvidence, falseAlarmsInLeg: legW ? S.falseAlarms(legW, known) : null },
  };
  if (side) {
    const action = c => (c.read.kind === 'entry' ? (c.read.side && c.read.side !== side ? 'other' : 'enter') : c.read.kind === 'pass' ? 'sit' : 'manage');
    out.entryVsConfirmed = S.entryVsConfirmed(P.map(c => ({ rel: c.rel, confirmed: confl(c, side).confirmed, flat: c.flat, action: action(c) })));
    const en = P.find(c => c.flat && action(c) === 'enter');
    out.entryConfluence = en ? { rel: en.rel, ...confl(en, side), evidence: en.evidence, coded: en.coded, inLeg: en.ms <= cse.endClose } : null;
    out.entries = P.filter(c => c.flat && action(c) === 'enter').map(c => ({ rel: c.rel, side, evidence: c.evidence, coded: c.coded, ...ownRead(c) }));
    const w = legW;
    out.evidenceInLeg = {
      candles: w.length, evidence: tally(w, c => c.evidence), coded: tally(w, c => c.coded),
      confirmedCandles: w.filter(c => confl(c, side).confirmed).length, meanReqMet: w.length ? w.reduce((s, c) => s + (confl(c, side).reqMet || 0), 0) / w.length : null,
    };
    out.miss = needs || rec.model.counts ? null : { namedFirst: rec.model.first, timing: rec.model.timing, evidence: out.evidenceInLeg };
  } else {
    const first = needs ? null : rec.model.first;
    out.namesChop = needs ? null : first !== null;
    out.firstChopRel = first;
    out.entries = P.filter(c => c.flat && c.read.kind === 'entry').map(c => {
      const s = c.read.side || c.trace.key.biasSide || null;
      return { rel: c.rel, side: s, evidence: c.evidence, coded: c.coded, ...ownRead(c), presentClass: s ? c.trace.key.cls[s] : null, confluence: confl(c, s), beforeNaming: needs ? null : first === null || c.rel < first };
    });
    out.entriesBeforeNaming = needs ? null : out.entries.filter(e => e.beforeNaming).length;
    const flat = P.filter(c => c.flat);
    out.sitRate = flat.length ? flat.filter(c => c.read.kind === 'pass').length / flat.length : null;
  }
  return { ...out, _candles: P, _inLeg: legW };
}

function summarize(analyses, { level = null } = {}) {
  const scored = analyses.filter(a => !a.wordCoverage.needsClassWord && !a.noCandles);
  const legs = analyses.filter(a => a.kind === 'trend');
  return {
    scored: scored.length ? S.summary(scored.map(a => ({ id: a.id, known: a.known, margin: a.margin, pace: a.pace, candles: a._candles, ...(a._inLeg ? { inLeg: a._inLeg } : {}) })), { level }) : null,
    needsClassWord: analyses.filter(a => a.wordCoverage.needsClassWord).map(a => a.id),
    noCandles: analyses.filter(a => a.noCandles).map(a => a.id),
    // Every entry's own word and frames (not scored, not a grade), by kind of case.
    entryWords: Object.fromEntries(['trend', 'chop'].map(k => [k, S.tallyEntryWords(analyses.filter(a => a.kind === k && !a.notInRuns).flatMap(a => a.entries || []))])),
    entryVsConfirmed: { on: 0, before: 0, after: 0, 'no-entry': 0, 'never-confirmed': 0, ...tally(legs, a => a.entryVsConfirmed.timing) },
  };
}

module.exports = { analyse, summarize, knownOf };
