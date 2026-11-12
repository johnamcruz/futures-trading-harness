'use strict';

/**
 * The recognition test's report as text (docs/TRAINING.md, "The recognition test"): per case, then trend vs chop only,
 * then the pass check apart. Hindsight (the leg's available R) appears only in the PASS CHECK block, never beside a read.
 * Rates carry their Wilson interval [lo, hi] at the definitions' level. SUPPLEMENTARY lines are columns beside the
 * frozen measures, never a change of them: the first naming from the evidence candle on (a word named early and held
 * is a guess and a miss by the frozen rule) and a leg's false alarms inside its window (a right chop word before a late
 * leg is a false alarm over the whole day).
 *
 *   renderReport(doc)   doc: run.js recognitionReport's
 */

const { round4 } = require('../../prop/stats');

const NEEDS = 'needs the class word in the run';
const j = x => JSON.stringify(x);
const n4 = x => (Number.isFinite(x) ? String(round4(x)) : '-');
const at = x => (x === null || x === undefined ? 'none' : `candle ${x}`);
const yes = b => (b === null || b === undefined ? '-' : b ? 'yes' : 'no');
const ci = x => (x && x.lo !== null && x.lo !== undefined ? ` [${x.lo}, ${x.hi}]` : '');
const blank = c => (c.noCandles ? 'no candles (no bars at any cycle)' : NEEDS);
const fa = x => (x ? `${n4(x.rate)} (${x.opposite}/${x.named})` : '-');

const framesText = f => (f ? `4h ${f['4h'] || '-'} | 1h ${f['1h'] || '-'} | 15m ${f['15m'] || '-'}` : 'unstated');
const tallyText = t => `${j(t.byWord)}; word vs frames ${j(t.byWordVsFrames)}`;

function flow(c) {
  if (!c) return 'no side';
  return `${c.side} flow ${c.reqMet}/${c.reqTotal} [${c.met.join(' ')}] confirmed ${yes(c.confirmed)} declaredOf ${c.declared === null ? 'unknown' : yes(c.declared)}${c.blocker ? ` (${c.blocker})` : ''}`;
}
function then(label, e) {
  if (!e) return `${label}: none`;
  const cites = e.basis ? `; cites ${e.basis.status}${e.basis.status === 'stated' ? `: cited [${e.basis.cited.join(' ')}] ignored [${e.basis.ignored.join(' ')}] cited without a signal [${e.basis.citedWithoutSignal.join(' ')}] met but no cite name [${e.basis.uncitable.join(' ')}] off the list [${e.basis.offList.join(' | ')}], dropped by the record ${e.basis.dropped}` : ''}` : '';
  return `${label} candle ${e.rel} (evidence ${e.evidence}, coded ${e.coded}; signals [${e.signals.join(' ')}]; ${flow(e.confluence)}${cites})`;
}
const reader = (r, needs) => (needs ? NEEDS : r.first === null ? 'never' : `candle ${r.first} (${r.timing}${r.delay === null ? '' : `, delay ${r.delay}`}, counts ${yes(r.counts)})`);

function supLine(c) {
  const f = c.supplementary.fromEvidence;
  return `  SUPPLEMENTARY (definitions unchanged): first naming from the evidence candle on: ${at(f.first)}${f.delay === null ? '' : ` (delay ${f.delay}, within the margin ${yes(f.counts)})`}; false alarms in the leg window ${fa(c.supplementary.falseAlarmsInLeg)} beside the whole day ${fa(c.falseAlarms)}`;
}

/** The class word against its own frames over every candle (in-trade apart), the word vs the leg's side, and the flips with the frames unchanged. */
function stabilityText(w) {
  return `candles ${w.candles}, word vs frames ${j(w.byWordVsFrames)} (in trade ${j(w.inTradeByWordVsFrames)})${w.wordVsSide ? `, word vs the leg's side ${j(w.wordVsSide)}` : ''}; word changes with the frames unchanged ${w.flipsSameFrames} of ${w.pairsSameFrames} such pairs; longest run of one word ${w.longestRun}`;
}

function trendLines(c) {
  const e = c.entryVsConfirmed;
  const ec = c.entryConfluence;
  const leg = c.evidenceInLeg;
  return [
    `${c.id} ${c.pace} (${c.legCandles} candles), run ${c.run}${c.alsoIn.length ? ` (also in ${c.alsoIn.join(', ')}: first used)` : ''}: candles ${c.candles}, in-trade ${c.inTrade}, no bars ${c.noBars}`,
    `  evidence-supported first candle: ${at(c.firstEvidenceRel)}; coded read first: ${reader(c.coded, false)}; first recognition (model): ${c.model ? reader(c.model, false) : blank(c)}`,
    `  evidence then: ${then('evidence', c.evidenceThen.evidence)}; ${then('coded', c.evidenceThen.coded)}; ${c.model ? then('model', c.evidenceThen.model) : `model: ${blank(c)}`}`,
    `  harness confirmed first: ${at(e.firstConfirmed)}; entry: ${at(e.entry)} (${e.timing}${e.delta === null ? '' : ` by ${e.delta}`}); sit-outs while confirmed ${e.sitOutsWhileConfirmed}`,
    `  entries ${c.entries.length}: ${c.entries.map(e => `candle ${e.rel} word ${e.modelWord || 'unstated'}, frames ${framesText(e.frames)}, vs frames ${e.wordVsFrames}`).join('; ') || 'none'}`,
    `  class word every candle: ${stabilityText(c.wordStability)}`,
    `  confluence at the entry: ${ec ? `candle ${ec.rel} ${flow(ec)}; evidence ${ec.evidence}, coded ${ec.coded}; inside the leg ${yes(ec.inLeg)}` : 'no entry'}`,
    `  in the leg: candles ${leg.candles}, confirmed ${leg.confirmedCandles}, mean flow steps ${n4(leg.meanReqMet)}; evidence ${j(leg.evidence)}; coded ${j(leg.coded)}`,
    `  miss: ${!c.model ? blank(c) : c.miss ? `not recognised within ${c.margin} candles (first named: ${at(c.miss.namedFirst)}, ${c.miss.timing}); the evidence in the leg as above` : 'no'}`,
    ...(c.supplementary ? [supLine(c)] : []),
  ];
}

function chopLines(c) {
  const lab = c.label && c.label.recomputed;
  const fr = c.label && c.label.frozen;
  return [
    `${c.id}, run ${c.run}: candles ${c.candles}, in-trade ${c.inTrade}, no bars ${c.noBars}; evidence first names chop at ${at(c.firstEvidenceRel)}; coded first ${reader(c.coded, false)}`,
    `  names chop: ${c.namesChop === null ? blank(c) : c.namesChop ? `yes, ${reader(c.model, false)}` : 'no'}; sit rate ${n4(c.sitRate)}; entries ${c.entries.length}${c.entriesBeforeNaming === null ? '' : ` (before the naming ${c.entriesBeforeNaming})`}`,
    `  class word every candle: ${stabilityText(c.wordStability)}`,
    ...c.entries.map(e => `    entry candle ${e.rel}: model's word ${e.modelWord || 'unstated'}, frames ${framesText(e.frames)}, word vs frames ${e.wordVsFrames}; present class ${e.presentClass || '-'}, evidence ${e.evidence}, coded ${e.coded}; ${flow(e.confluence)}; before the naming ${yes(e.beforeNaming)}`),
    `  chop label (bars only) recomputed: ${lab && lab.eligible ? `chop ${yes(lab.chop)}, efficiency ${n4(lab.efficiency)} (max ${n4(lab.erMax)}), net ${n4(lab.netAtr)} ATR, range ${n4(lab.rangeAtr)} ATR, n ${lab.n}` : `not eligible (n ${lab ? lab.n : 0})`}; frozen: ${fr ? j(fr) : 'none'}`,
  ];
}

function scoredLines(s, summary) {
  if (!s && !summary.needsClassWord.length) return ['model scores: none (no case has a candle to score)'];
  if (!s) return [`model scores: ${NEEDS} (no case's run carries it); never substituted by the coded read or by prose`];
  const k = (name, x) => `${name}: n ${x.n} [${x.cases.join('; ')}], recall ${n4(x.recall)}${ci(x.recallInterval)} (${x.recalled}/${x.n}; coded read ${x.codedRecalled}/${x.n}${ci(x.codedRecallInterval)}), precision ${n4(x.precision)}${ci(x.precisionInterval)}, false-alarm rate ${n4(x.falseAlarmRate)}${ci(x.falseAlarmInterval)} (${x.falseAlarmCandles} candles), wrong way ${x.wrongWay}`;
  const sup = (name, x) => `  SUPPLEMENTARY ${name} (definitions unchanged): recalled from the evidence candle on ${x.supplementary.recalledFromEvidence}/${x.n}; false-alarm rate in the leg windows ${n4(x.supplementary.falseAlarmRateInLeg)}${ci(x.supplementary.falseAlarmInLegInterval)}`;
  return [k('trend', s.trend), sup('trend', s.trend), k('chop', s.chop), sup('chop', s.chop),
    `by pace (item 12, listed): ${Object.entries(s.byPace).map(([p, x]) => `${p} recalled ${x.recalled} of [${x.cases.join('; ')}]`).join('; ') || 'none'}`,
    `delay vs accuracy: ${s.delayVsAccuracy.map(r => `${r.id} delay ${r.delay === null ? '-' : r.delay} accuracy ${n4(r.accuracy)}`).join('; ')}`];
}

function renderReport(doc) {
  const cases = doc.cases.filter(c => !c.notInRuns);
  const cov = doc.coverage;
  const out = [
    `Recognition test over runs ${doc.runs.join(', ') || 'none'} (read-only measurement: nothing that decides reads it; the model is asked nothing). Frozen case list sha256 ${doc.casesSha256}; definitions version ${doc.definitions.version}.`,
    'Candles = the runner\'s head trade cycles; rel 0 = the first candle after the setup start (a trend leg\'s census start bar, a chop day\'s window open).',
    `Class word in the runs: stated ${cov.stated}, unstated ${cov.unstated}, invalid ${cov.invalid}, absent ${cov.absent} of ${cov.of} candles.`,
  ];
  if (doc.summary.needsClassWord.length) out.push(`Each of these cases ${NEEDS} (${doc.summary.needsClassWord.join('; ')}): first recognition (model), evidence then (model, cites), chop-day naming, misses, false alarms, precision and recall are not computed; never substituted by the coded read or by prose.`);
  const circ = doc.cases.filter(c => c.circular);
  out.push(`CIRCULAR (picked using words the model sees; reported apart): ${circ.map(c => `${c.id} (${c.circularNote})`).join('; ') || 'none'}`);
  const noFine = cases.filter(c => !c.fineLane);
  if (noFine.length) out.push(`No 1m bars (the briefing's 5m facts missing, unlike a run with a 1m lane; give 1m data with --bars): ${noFine.map(c => c.id).join('; ')}`);
  if ((doc.summary.noCandles || []).length) out.push(`No candles (no bars at any of the day's cycles; give the data with --bars): ${doc.summary.noCandles.join('; ')}`);
  const missing = doc.cases.filter(c => c.notInRuns);
  if (missing.length) out.push(`Not in the runs (no trade cycle on the day): ${missing.map(c => c.id).join('; ')}`);
  out.push('', '== TREND LEGS');
  for (const c of cases.filter(x => x.kind === 'trend')) out.push(...trendLines(c));
  out.push('', '== CHOP DAYS');
  for (const c of cases.filter(x => x.kind === 'chop')) out.push(...chopLines(c));
  out.push('', '== AGGREGATE (trend vs chop only; n small, the cases listed above)',
    `Entries by the model's own word (its STATE record at the entry candle; vs frames: contradicts = a trend word with the 4h and 1h both range or either the opposite way to the word, chop with 4h, 1h and 15m all one way; else agrees; unstated = no word or no frame): chop days ${doc.summary.entryWords.chop.n} entries: ${tallyText(doc.summary.entryWords.chop)}; trend legs ${doc.summary.entryWords.trend.n} entries: ${tallyText(doc.summary.entryWords.trend)}`,
    `The class word against its own frames, every candle (in-trade candles included, also counted apart; a word change with the frames unchanged is the read's instability, not a grade of the market; the word vs the leg's side is a report against the answer key): chop days ${stabilityText(doc.summary.wordStability.chop)} over ${doc.summary.wordStability.chop.cases} cases; trend legs ${stabilityText(doc.summary.wordStability.trend)} over ${doc.summary.wordStability.trend.cases} cases`,
    `entry vs confirmed on the legs: ${j(doc.summary.entryVsConfirmed)}`,
    `coded read vs the evidence word per candle: ${cases.map(c => `${c.id} ${n4(c.accuracyCoded.accuracy)} (always-trend ${n4(c.accuracyCoded.alwaysTrend)}, always-chop ${n4(c.accuracyCoded.alwaysChop)})`).join('; ')}`,
    ...scoredLines(doc.summary.scored, doc.summary));
  out.push('', `PASS CHECK (hindsight, separate; never a grade of the read): ${doc.pass.map(p => `${p.id} availableR ${p.availableR}`).join('; ') || 'none'}`);
  return out.join('\n');
}

module.exports = { renderReport };
