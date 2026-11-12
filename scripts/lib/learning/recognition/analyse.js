'use strict';

/**
 * The recognition test's per-case analysis (docs/TRAINING.md, "The recognition test"): the five measures for one case
 * over its candles, and the summary over cases. Read-only measurement, pure; nothing that decides reads it.
 *
 * A candle (run.js): { ms (its bar close), trace (trace.js: { key, sides }; null when the bars hold no bar closing
 * there), read: { kind: entry | pass | in-trade, side, word (scorer.wordOf), cites (scorer.citesOf) } }. rel = candles
 * from rel 0 (config.js startCloseOf). An in-trade cycle is counted (`inTrade`), never a sit-out or an entry decision.
 *
 *   1 first recognition   the model's first candle naming the known class: guess | on | lag against the first candle the
 *                         visible evidence supports it, the delay in candles, whether it counts (the frozen margin); the
 *                         coded read's first candle beside it, by the same rule
 *   2 evidence then       at the evidence's, the coded read's and the model's first candles: the signals met, the
 *                         confluence for the side (required flow steps met, confirmed, declaredOf), and the model's cites
 *                         against the fields carrying a met signal (cited, ignored, cited without a signal, off the list)
 *   3 entry               the entry candle against the first candle barFacts confirms the side (trend legs)
 *   4 chop days           names chop? at which candle; the sit rate; every entry with its present class and confluence,
 *                         flagged before the naming or not
 *   5 misses              a trend leg the model never recognised within the margin, with what the evidence showed in it
 * A run without the class word (every candle `absent`) has 1, 2 (the model's), 4 (the naming) and 5 marked as needing
 * it: null, never substituted by the coded read or by prose.
 *
 *   analyse(case, candles, { minutes })   one case (case: config.js's, with startClose and endClose)
 *   summarize(analyses)                   scorer.summary over the cases whose run carries the class word, the cases
 *                                         needing it, and the entry vs confirmed tally of the trend legs
 */

const { MINUTE } = require('../../backtest/data');
const K = require('./key');
const S = require('./scorer');

const knownOf = c => (c.kind === 'trend' ? (c.side === 'long' ? 'trend-up' : 'trend-down') : 'chop');
const tally = (list, f) => list.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});

function confl(c, side) {
  if (!side) return null;
  const s = c.trace.sides[side] || {};
  return { side, reqMet: s.reqMet ?? null, reqTotal: s.reqTotal ?? null, met: s.met || [], confirmed: s.confirmed === true, blocker: s.confirmed ? null : s.why || s.error || null, declared: s.declared ?? null };
}

/** Candles with a trace, with rel and the three readers' words (the model's only when stated). */
function prep(candles, startClose, minutes) {
  const step = minutes * MINUTE;
  return candles.filter(c => c.trace).map(c => ({
    ...c, rel: Math.round((c.ms - startClose) / step), evidence: K.evidenceWord(c.trace.key), coded: K.codedWord(c.trace.key),
    model: c.read.word.status === 'stated' ? c.read.word.word : null, flat: c.read.kind !== 'in-trade',
  }));
}

function coverage(P) {
  const w = tally(P, c => c.read.word.status);
  const k = tally(P, c => c.read.cites.status);
  const of = P.length;
  return {
    classWord: { stated: w.stated || 0, unstated: w.unstated || 0, invalid: w.invalid || 0, absent: w.absent || 0, of, needsClassWord: (w.absent || 0) === of },
    cites: { stated: k.stated || 0, unstated: k.unstated || 0, invalid: k.invalid || 0, absent: k.absent || 0, offList: P.reduce((s, c) => s + c.read.cites.offList.length, 0) },
  };
}

function evidenceAt(P, rel, side, withCites) {
  const c = rel === null ? null : P.find(x => x.rel === rel);
  if (!c) return null;
  const s = side || c.trace.key.biasSide || null;
  const sig = c.trace.key.signals[s || 'none'];
  return {
    rel, evidence: c.evidence, coded: c.coded, side: s, signals: [...sig.c, ...sig.t], confluence: confl(c, s),
    ...(withCites ? { cites: S.citedVsIgnored(c.read.cites, K.metFields(c.trace.key, s)) } : {}),
  };
}

function analyse(cse, candles, { minutes }) {
  const P = prep(candles, cse.startClose, minutes);
  const known = knownOf(cse);
  const side = cse.kind === 'trend' ? cse.side : null;
  const cov = coverage(P);
  const needs = cov.classWord.needsClassWord;
  const rec = S.recognise(P, known, cse.margin);
  const out = {
    id: cse.id, kind: cse.kind, known, side, pace: cse.pace || null, margin: cse.margin,
    candles: P.length, noBars: candles.length - P.length, inTrade: P.filter(c => !c.flat).length, ...cov,
    firstEvidenceRel: rec.evidenceFirst, firstCodedRel: rec.coded.first, coded: rec.coded, model: needs ? null : rec.model,
    evidenceThen: { evidence: evidenceAt(P, rec.evidenceFirst, side, false), coded: evidenceAt(P, rec.coded.first, side, false), model: needs ? null : evidenceAt(P, rec.model.first, side, true) },
    accuracyCoded: S.accuracy(P.map(c => ({ ...c, model: c.coded }))), accuracy: needs ? null : S.accuracy(P), falseAlarms: needs ? null : S.falseAlarms(P, known),
  };
  if (side) {
    const action = c => (c.read.kind === 'entry' ? (c.read.side && c.read.side !== side ? 'other' : 'enter') : c.read.kind === 'pass' ? 'sit' : 'manage');
    out.entryVsConfirmed = S.entryVsConfirmed(P.map(c => ({ rel: c.rel, confirmed: confl(c, side).confirmed, flat: c.flat, action: action(c) })));
    const en = P.find(c => c.flat && action(c) === 'enter');
    out.entryConfluence = en ? { rel: en.rel, ...confl(en, side), evidence: en.evidence, coded: en.coded, inLeg: en.ms <= cse.endClose } : null;
    const w = P.filter(c => c.ms >= cse.startClose && c.ms <= cse.endClose);
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
      return { rel: c.rel, side: s, evidence: c.evidence, coded: c.coded, presentClass: s ? c.trace.key.cls[s] : null, confluence: confl(c, s), beforeNaming: needs ? null : first === null || c.rel < first };
    });
    out.entriesBeforeNaming = needs ? null : out.entries.filter(e => e.beforeNaming).length;
    const flat = P.filter(c => c.flat);
    out.sitRate = flat.length ? flat.filter(c => c.read.kind === 'pass').length / flat.length : null;
  }
  return { ...out, _candles: P };
}

function summarize(analyses) {
  const scored = analyses.filter(a => !a.classWord.needsClassWord);
  const legs = analyses.filter(a => a.kind === 'trend');
  return {
    scored: scored.length ? S.summary(scored.map(a => ({ id: a.id, known: a.known, margin: a.margin, pace: a.pace, candles: a._candles }))) : null,
    needsClassWord: analyses.filter(a => a.classWord.needsClassWord).map(a => a.id),
    entryVsConfirmed: { on: 0, before: 0, after: 0, 'no-entry': 0, 'never-confirmed': 0, ...tally(legs, a => a.entryVsConfirmed.timing) },
  };
}

module.exports = { analyse, summarize, knownOf };
