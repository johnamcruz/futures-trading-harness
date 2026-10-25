'use strict';

/**
 * The facts at a missed trend leg's start (Propose-Probe-Compose, docs/TRAINING.md, "The trend findings"): for each
 * missed or refused leg of a trend run, at each of its entry-able bars, what code verified TRUE on the leg's side and
 * whether a valid with-trend plan existed, next to what the model said; and the same plan check on the run's control
 * bars (no leg), for the base rate and the plans that lost. Analysis after the run only, for the proposer's findings
 * (trend-findings.js); never written to a run home, never in a role, cycle or tool prompt.
 *
 * The bars: the leg's catch window's trade cycles (trend-capture.js: the bars it classifies, from the leg's start bar's
 * close), less those outside the session, behind an open position or blocked by a rule. The briefing at each bar is
 * rebuilt from the run's bars closed by its close (learning/skill-usage.js briefingFrom, the runner's buildBriefing).
 * A timeframe the rebuild can't make though the run had it (`missing`: the 5m without the run's 1m bars, which the
 * runner's 1m lane built it from) is `unknown`: a read of it, and an `at` read when it is the frame above the base (the
 * check's met-by candles: composed-reads.js recentFrames would fall back past it to a higher candle the live check never
 * used), is never counted, neither in the reads listed nor in a plan. A frame the live briefing lacked too is no gap. Where the run recorded compose_check calls on the bar, their
 * reads (but those) are checked again on the rebuilt briefing: one the record and the rebuild check differently makes the
 * bar `unknown`, never guessed (`parity` names the read).
 *
 * At each bar (barFacts), by the same machinery compose_check and its hints use, never a copy of it:
 *   verified   per flow step, the reads TRUE on the bar for the side (compose-hints.js candidatesOf), names only
 *   valid      a with-trend plan passes: the window allows entries, the trend rule allows the side (reasons.js
 *              trendRuleOf: true, never only as a reversal), and the briefing's standard plan for the side is OK
 *              (setup-library.js standardPlans), else a combination of the verified reads passes the check and the plan
 *              (compose-hints.js repairOf, from no reads: R:R, the room rule, the stop floor); under a prop attempt (the
 *              cycle's own attempt line) a size fits too, by the entry's own size chain (sizeForCycle). A bar whose
 *              cycle had an OK record the leg's way (passed on, vetoed, late, refused at the gate, unfilled) had one,
 *              whatever the rebuild, but for the floor's refusal (min-contracts)
 *   said       the model's stated reason: the cycle's CYCLE RESULT line (and, for a refused plan, its reads checked)
 *   contradictions   a stated claim about a step that the same facts show false (statedClaims, refute): "no setup" /
 *              "no rejection" (at a timeframe it names) against a verified setup read there; "no entry" against a
 *              verified confirmation on a candle closed after the setup, only when the reason states no other failing
 *              step; "not at a level" against a verified `at` read; "against the trend" when the trend rule allows the
 *              side; "no target" against a verified target; a 15m/1h/4h direction the checker finds FALSE; and every
 *              claim the reason check (reasons.js checkReasons on the bar's facts) finds FALSE. A clause takes its
 *              sentence's side when it names none; one about the other side, the runner's entry, or R:R says nothing
 *
 * A leg is learnable when a valid plan existed at one of its bars; not learnable (a correct pass) when every bar was
 * known and none had one; unknown otherwise. A no-plan leg's owner: the first flow step where a stated claim and the
 * verified reads disagree, and the skill of that read (curated-moments.js skillOfRead, the crosswalk); none without. A
 * leg the floor refused (min-contracts) is the head's stop choice: flow step `stop`, the skill of its plan's stop read.
 *
 * The control bars (controlFacts): the run's trade cycles in its control windows (trend-windows.js), else every trade
 * cycle on no leg's span; at each, either side, the same plan check. The base rate is the share with a valid plan; a
 * valid plan that lost (its stop hit before its minimum R:R mark on the run's later bars that session, the stop first
 * when one bar holds both) is a balancing example: never a finding, never shown to the trader.
 *
 *   entryBars(leg)                                the leg's entry-able cycles
 *   statedClaims(text, side)                      [{ step, clause, test }] the step-claims a reason states for the side
 *   barFacts({ briefing, side, tick, plan, said, reads, records, cycle, sizeFits, names, missing })   one bar's facts
 *   legFacts(leg, { briefingAt, cycleAt, recordsAt, tick, plan, sizeFor, names, missing })   { learnable, why, bars, owner }
 *   missingFrames({ minutes, fineBars }), dependsOnMissing(read, briefing, missing)   the frames a rebuild lacks
 *   sizeForCycle(rec, { strategies, accounts, root, composed })   stopTicks -> true | false | null | undefined
 *   outcomeOf({ side, entry, stop, minRR, after })   'lost' | 'won' | null from the bars after a plan's bar
 *   attachFacts(capture, { runDir, home, tree, barsFiles, controls })   the capture's missed legs with `facts`, and
 *                                                 its `controls` (read-only)
 *   controlsOf(captures)                          { legBars, controlBars, losers } over a round's captures
 *   scrub(text, { names, words })                 text without dates, months, days, clock times, prices, numbers (in
 *                                                 digits, words or fractions), ids or account names (for the proposer)
 *   exampleLine(leg), loserLine(x)                one example for the proposer (no date, time or price)
 */

const fs = require('fs');
const path = require('path');
const { STEPS, TF_ORDER, TF_MIN, parseRead, checkRead, checkReads, candleClose } = require('../trading/composed-reads');
const { candidatesOf, repairOf } = require('../trading/compose-hints');
const { trendRuleOf, checkReasons, factsFromBriefing } = require('../trading/reasons');
const { standardPlans } = require('../learning/setup-library');
const { skillOfRead } = require('../learning/curated-moments');
const { NUMBER_WORDS, FRACTIONS } = require('./probe-edit');

const TUN = require('../tunables').training().trendFindings; // config/training.json: examples, exampleChars, saidChars
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const m3Of = b => (isObj(b) && isObj(b.sections) && isObj(b.sections.m3) && isObj(b.sections.m3.data) ? b.sections.m3.data : null);
// The codes of trend-capture.js classifyCycle after an OK record the leg's way (its plan passed compose_check), by
// the head trader's pass, phase 2, the gate or the executor; the floor's own refusal (min-contracts) is no size fitting.
const OK_CODES = new Set(['head-pass', 'veto', 'verdict-unread', 'late-entry', 'executor-abort', 'blocked', 'unfilled', 'entered']);
const ownOk = c => isObj(c) && c.code !== 'min-contracts' && (OK_CODES.has(c.code) || c.by === 'gate');
const FLOOR = 'min-contracts';

/** The leg's entry-able cycles: its catch window's, less outside the session, a position open, a rule's block. */
const entryBars = leg => (isObj(leg) && Array.isArray(leg.cycles) ? leg.cycles : []).filter(c => isObj(c) && c.bar && c.by !== 'rule' && !['outside-session', 'position-open'].includes(c.code));

// --- the proposer's words --------------------------------------------------------------------------------------------

const MONTHS = /\b(?:January|February|March|April|June|July|August|September|October|November|December|May|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b\.?/g;
const DAYS = /\b(?:Mon|Tues?|Wed(?:nes)?|Thu(?:rs)?|Fri|Sat(?:ur)?|Sun)(?:day)?\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g;
const WORDS = new RegExp(`\\b(?:${NUMBER_WORDS.join('|')})\\b`, 'gi');
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Text for the proposer: no date, month or weekday, clock time, price or number (digits, words, fractions), id, `#`
 * tag or account name (names: the tree's accounts; any snake_case token with a digit too). Timeframes (15m, 1h) and
 * whole R marks (2r) stay: read names. words: false keeps number words (a read's own name, e.g. a pattern's).
 */
function scrub(text, { names = [], words = true } = {}) {
  let t = String(text || '');
  for (const n of names.filter(Boolean)) t = t.replace(new RegExp(`\\b${escape(n)}\\b`, 'gi'), 'the account');
  t = t.replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:ET|CT|UTC))?\b/gi, ' ')
    .replace(MONTHS, ' ').replace(DAYS, ' ')
    .replace(/\b[0-9a-f]{12,}\b/gi, ' ')
    .replace(/#\w+/g, ' ')
    .replace(/\b[a-z]+_[a-z0-9_]*\d[a-z0-9_]*\b/gi, 'the account')
    .replace(FRACTIONS, ' ')
    // A timeframe or a whole R multiple stays (15m, 1h, 2r: read names); every other number goes.
    .replace(/\$?-?\d+(?:[.,]\d+)*(?:%|x\b|[mhr]\b)?/gi, m => (/^\d+[mhr]$/i.test(m) ? m : ' '));
  if (words) t = t.replace(WORDS, ' ');
  return t.replace(/\(\s*[-,;:/\s]*\)/g, ' ')
    .replace(/([,;])(?:\s*[,;])+/g, '$1')
    .replace(/[,;:]\s*\)/g, ')')
    .replace(/\s+([,;:.)])/g, '$1')
    .replace(/([(])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Text clipped to n characters at a clause boundary (a ';', ',' or '. ' before it), else at a word. */
function clip(t, n) {
  if (t.length <= n) return t;
  const head = t.slice(0, n - 3);
  const at = Math.max(head.lastIndexOf('; '), head.lastIndexOf(', '), head.lastIndexOf('. '));
  const cut = at > 0 ? head.slice(0, at) : head.slice(0, Math.max(0, head.lastIndexOf(' ')));
  return `${cut || head}...`;
}

// --- the stated reason's claims --------------------------------------------------------------------------------------

/** The sides a text names: 'long', 'short' (bullish and bearish describe candles, never the side the clause is about). */
const sidesIn = c => [...new Set((String(c).match(/\b(longs?|shorts?)\b/gi) || []).map(x => (/^long/i.test(x) ? 'long' : 'short')))];
// A clause about the runner's entry (a late or missed entry): the execution step's, never a claim about the reads.
const EXECUTION = /late entry|runner'?s entry|missed the plan'?s entry|invalidated before the order/i;
// R:R phrasings ("no level reaches 2R", "no target at 2R"): about the plan's arithmetic, never a location or target claim.
const RR = /\bR:R\b|risk[- ]reward|\b\d+(?:\.\d+)?R\b|\breach(?:es)?\b|\bmin(?:imum)? (?:of )?\d/i;
// A failing step other than the entry, stated anywhere in the reason: an entry claim beside it is not the ground.
const OTHER_FAIL = /\bR:R\b|risk[- ]reward|\b\d+(?:\.\d+)?R\b|\broom\b|\bcap\b|max[_ ]risk|\bsize\b|\bfloor\b|\bstop\b|\btarget\b/i;
const TF_WORD = /\b(1m|3m|5m|15m|1h|4h)\b/g;

// The step-claims a stated reason makes, each with what would show it false. Claims only of absence or opposition: a
// stated fact ("closed bottom third") is never read as a claim about the step.
const CLAIMS = [
  { step: 'bias', re: /against (?:the )?(?:trend(?: rule)?|prevailing|(?:15m|1h|4h)(?:\/(?:15m|1h|4h))* (?:up|down|trend))|counter[- ]?trend|trend rule (?:refuses|blocks|bars|forbids)|only as a reversal/i, test: 'rule' },
  { step: 'location', re: /not at (?:a |any )?(?:key )?level|\bno (?:key )?level\b(?! (?:ahead|below|above|on the winning))|location not at|mid-?range/i, test: 'at', rr: true },
  // "no entry candle closed after the rejection" is an entry claim (the rejection is granted), never a setup one.
  { step: 'setup', re: /\bno (?:(?!entry|trigger|confirm|candle|close)[\w/-]+ ){0,6}?(setup|rejection|reaction|breakout|break|sweep|cisd|reclaim)s?\b/i, test: 'setup' },
  { step: 'entry', re: /\bno (?:[\w/-]+ ){0,5}?(?:entry|trigger|confirm\w*)\b|\bunconfirmed\b|not confirmed/i, test: 'entry' },
  { step: 'target', re: /\bno (?:named )?(?:level|target)s? (?:below|above|ahead|on the winning side)|\bno target\b/i, test: 'target', rr: true },
];
// A timeframe's direction ("15m bearish", "1h up"), never a candle or a structure named by it ("15m bearish CISD").
const DIRECTION = /\b(15m|1h|4h) (?:trend )?(?:is )?(bullish|bearish|up|down|uptrend|downtrend)\b(?!-|\s+(?:displacement|candle|cisd|engulfing|fvg|bar|close|choch|bos|rejection|reaction|break|sweep|pattern|momentum|move|leg|wick))/i;

/**
 * The reason's sentences, each split into clauses; a clause naming no side takes the last side its sentence named
 * before it ("no short trigger, and the long is against the trend, so the trend rule refuses it": the long's), and
 * keeps its sentence (for the sentence's own R:R).
 */
function clausesWithSide(text) {
  const body = String(text || '').replace(/^\s*CYCLE RESULT:\s*/i, '').replace(/^\s*[a-z][a-z-]*\s+[-–]\s+/i, '');
  const out = [];
  for (const sentence of body.split(/;|\.\s+|\s[-–]\s/)) {
    let last = null;
    for (const clause of sentence.split(/,|\(|\)|:|\bbut\b|\band\b(?= (?:no|the|a|its)\b)|\bso\b(?= the\b)/).map(x => x.trim()).filter(x => /[a-z]{3,}/i.test(x))) {
      const own = sidesIn(clause);
      out.push({ clause, sentence, own, sides: own.length ? own : last ? [last] : [] });
      if (own.length) last = own[own.length - 1];
    }
  }
  return out;
}

// What the model did, not what the market showed ("no composed setup", "no setup composed"); the tool's verdict
// reported ("per the tool", a read FALSE): neither is a claim about the facts.
const ACTION = /\bcompos(?:ed?|ing)\b/i;
const TOOL = /per the tool|\bthe tool\b|\bFALSE\b|refused by/;
// A setup word that names no kind ("setup", "reaction"): a claim only with the timeframe it is about.
const GENERIC_SETUP = new Set(['setup', 'reaction']);

/**
 * The step-claims a reason states that bear on the side, the high-confidence ones only: a clause about the other side
 * (or both), the runner's entry, the model's own action or the tool's verdict says nothing; a location, target or setup
 * claim in a sentence about R:R, a setup claim of no kind and no timeframe, and an entry claim that names no side or sits
 * beside another failing step are left out (too often the model's shorthand for something else).
 */
function statedClaims(text, side) {
  const out = [];
  const other = OTHER_FAIL.test(String(text || ''));
  for (const { clause, sentence, own, sides } of clausesWithSide(text)) {
    if (EXECUTION.test(clause) || TOOL.test(clause)) continue;
    // A timeframe's direction is a claim of fact whatever side it favours ("15m bullish" under a short).
    const d = DIRECTION.exec(clause);
    if (d) out.push({ step: 'bias', clause, test: 'direction', read: `${d[1].toLowerCase()} ${/bull|up/i.test(d[2]) ? 'up' : 'down'}` });
    if (sides.length !== 1 || sides[0] !== side || ACTION.test(clause)) continue;
    const rr = RR.test(sentence);
    for (const c of CLAIMS) {
      const m = c.re.exec(clause);
      if (!m) continue;
      const word = (m[1] || '').toLowerCase();
      const tfs = [...new Set(clause.match(TF_WORD) || [])];
      if ((c.rr || c.test === 'setup') && rr) continue;
      if (c.test === 'setup' && GENERIC_SETUP.has(word) && !tfs.length) continue;
      // "no rejection of <a price>": about that one level, which a read of another level never refutes.
      if (c.test === 'setup' && /\d{3,}/.test(clause)) continue;
      if (c.test === 'entry' && (other || !own.includes(side))) continue;
      out.push({ step: c.step, clause, test: c.test, word, tfs });
    }
  }
  return out;
}

/** A read's frame (its first word when a timeframe, else its second: `stop 15m low`), or null. */
const frameOf = read => { const w = String(read || '').split(' '); return TF_MIN[w[0]] ? w[0] : TF_MIN[w[1]] ? w[1] : null; };

/** The verified read (if any) that shows a stated claim false on this bar, or null. */
function refute(claim, { verified, briefing, side, tick, rule }) {
  if (claim.test === 'rule') return rule === true ? `trend ${side} allowed` : null;
  if (claim.test === 'at') return (verified.location.find(x => x.kind === 'at') || {}).read || null;
  if (claim.test === 'target') return (verified.target[0] || {}).read || null;
  if (claim.test === 'direction') {
    const c = checkRead(parseRead(claim.read), briefing, { tick });
    return c.check === false ? `"${claim.read}" is false` : null;
  }
  if (claim.test === 'setup') {
    const fit = { rejection: x => / rejected /.test(x.read), breakout: x => / broke /.test(x.read), break: x => / broke /.test(x.read), reclaim: x => / broke /.test(x.read), cisd: x => x.kind === 'cisd', sweep: x => x.kind === 'swept' }[claim.word] || (() => true);
    // "no 4h rejection": only a 4h one refutes it.
    const onTf = x => !claim.tfs || !claim.tfs.length || claim.tfs.includes(frameOf(x.read));
    return (verified.setup.find(x => fit(x) && onTf(x)) || {}).read || null;
  }
  // An entry: a confirmation pointing the side on a candle closed after the latest verified setup's.
  const s = verified.setup[0];
  if (!s || num(s.close) === null) return null;
  const m3 = m3Of(briefing);
  const e = verified.entry.find(x => { const t = candleClose(m3, frameOf(x.read)); return t !== null && t > s.close; });
  return e ? e.read : null;
}

// --- one bar ---------------------------------------------------------------------------------------------------------

/**
 * The frames a rebuild can't make that the run had: the 5m (and any frame under the base's next) from 1m bars, when the
 * run's 1m bars are not at hand and the base is under 5m. [] otherwise.
 */
const missingFrames = ({ minutes, fineBars }) => (Number(minutes) < TF_MIN['5m'] && Number(minutes) !== TF_MIN['1m'] && !fineBars ? ['5m'] : []);

/**
 * Whether a read depends on a frame the rebuild lacks: a read of it, or an `at` read when it is the frame above the
 * base (the `at` check's met-by candles are the base's and the next one the briefing holds: a missing frame would let
 * it fall back to a higher candle the live check never used).
 */
function dependsOnMissing(read, b, unknown) {
  if (!unknown.length) return false;
  // A read on a missing frame's candle, or of a level the missing frame makes ("15m rejected 5m fvg low up").
  if (String(read || '').split(' ').some(w => unknown.includes(w))) return true;
  const base = Object.keys(TF_MIN).find(tf => TF_MIN[tf] === Number(b.minutes));
  const next = TF_ORDER[TF_ORDER.indexOf(base) + 1];
  return parseRead(read).kind === 'at' && unknown.includes(next);
}

/** The first of the run's compose reads on this bar the rebuild checks differently (missing frames aside), or null. */
function parityMiss(records, b, tick, unknown) {
  for (const rec of records || []) {
    const reads = (rec.reads || []).filter(r => isObj(r) && typeof r.read === 'string' && (r.check === true || r.check === false) && !dependsOnMissing(r.read, b, unknown));
    if (!reads.length) continue;
    const again = checkReads({ reads: reads.map(r => ({ step: r.step, skill: r.skill, read: r.read, why: r.why || null })), side: rec.side, briefing: b, tick });
    for (const r of reads) {
      const x = again.reads.find(y => y.step === r.step && y.read === r.read);
      if (!x || (x.check === true) !== (r.check === true)) return r.read;
    }
  }
  return null;
}

/** A passing plan's entry and stop prices, its stop ticks and reads, from the standard plan or a repaired combination. */
const planOfStandard = s => ({ via: 'standard', reads: (s.reads || []).map(r => (isObj(r) ? r.read : r)), stopTicks: s.plan && s.plan.stop ? num(s.plan.stop.ticks) : null, entry: s.plan && s.plan.entry ? num(s.plan.entry.price) : null, stop: s.plan && s.plan.stop ? num(s.plan.stop.price) : null });
const planOfRepair = f => ({ via: 'together', reads: f.reads.map(r => r.read), stopTicks: num(f.planned.plan.stop.ticks), entry: num(f.planned.plan.entry.price), stop: num(f.planned.plan.stop.price) });

/**
 * One bar's facts (see the header). plan: compose_check's plan arguments (size, tickValue, minRR, maxRiskUsd, stopRule,
 * suggestion); sizeFits(stopTicks) -> true | false | null (null: no attempt constrains; undefined: can't be worked out).
 */
function barFacts({ briefing, side, tick, plan, said = '', reads = [], records = [], cycle = null, sizeFits = () => null, names = [], missing = [] }) {
  const own = ownOk(cycle);
  const base = { said: String(said || ''), shown: scrub(String(said || '').replace(/^\s*CYCLE RESULT:\s*/i, ''), { names }), reads: (reads || []).map(r => ({ step: r.step, read: r.read, verified: r.verified === true })), contradictions: [] };
  const ownWhy = 'your own plan passed compose_check';
  const m3 = m3Of(briefing);
  if (!m3) return { ...base, known: own, valid: own, why: own ? ownWhy : 'no briefing for the bar', via: own ? 'own' : null };
  const unknown = missing;
  const miss = parityMiss(records, briefing, tick, unknown);
  if (miss) return { ...base, known: own, valid: own, why: own ? ownWhy : 'the rebuilt briefing checks the run\'s compose record differently', parity: miss, via: own ? 'own' : null, unknown };
  const all = candidatesOf(briefing, side, { tick, stopRule: plan.stopRule });
  const cand = Object.fromEntries(STEPS.map(s => [s, all[s].filter(x => !dependsOnMissing(x.read, briefing, unknown))]));
  const rule = trendRuleOf(m3.trendRule)[side];
  let valid = false;
  let why;
  let chosen = null;
  if (m3.windowEntries !== 'allowed') why = 'the window allows no entries';
  else if (rule === false) why = `the trend rule allows the ${side} only as a reversal`;
  else if (rule !== true) why = 'the trend rule for the side is unknown';
  else {
    // The standard plan, unless it rests on a read of a missing frame; then a combination of the known reads.
    const standard = (standardPlans(briefing) || []).find(p => p.side === side && p.status === 'traded' && !(p.reads || []).some(r => dependsOnMissing(isObj(r) ? r.read : r, briefing, unknown))) || null;
    const fixed = repairOf({ reads: [], side, briefing, tick, plan, candidates: cand });
    const tried = [standard && planOfStandard(standard), fixed && planOfRepair(fixed)].filter(Boolean);
    if (!tried.length) why = 'no combination of the verified reads passes the check and the plan';
    for (const p of tried) {
      const fits = sizeFits(p.stopTicks);
      if (fits === false) { why = why || 'no size fits at its stop (the size chain: budget, risk cap, the rulebook\'s floor)'; continue; }
      if (fits === undefined) { why = 'the attempt\'s size can\'t be worked out'; continue; }
      valid = true; chosen = p; why = p.via === 'standard' ? 'the standard plan passes' : 'these reads pass together';
      break;
    }
  }
  if (!valid && own) { valid = true; why = ownWhy; chosen = { via: 'own', reads: [] }; }
  const sizeUnknown = !valid && why === 'the attempt\'s size can\'t be worked out';
  const ctx = { verified: cand, briefing, side, tick, rule };
  const contradictions = [];
  for (const c of statedClaims(said, side)) {
    const read = refute(c, ctx);
    if (read && !contradictions.some(x => x.step === c.step && x.clause === c.clause)) contradictions.push({ step: c.step, clause: c.clause, read });
  }
  try {
    for (const c of checkReasons(String(said || ''), factsFromBriefing(briefing)).claims.filter(x => x.check === false)) contradictions.push({ step: null, clause: c.clause, read: c.why });
  } catch (_err) { /* the reason check can't read it: none flagged */ }
  return {
    ...base, known: !sizeUnknown, valid, why, via: chosen ? chosen.via : null, planReads: chosen ? chosen.reads : null,
    entry: chosen ? chosen.entry ?? null : null, stop: chosen ? chosen.stop ?? null : null, stopTicks: chosen ? chosen.stopTicks ?? null : null, unknown,
    verified: Object.fromEntries(STEPS.map(s => [s, cand[s].map(x => x.read)])), contradictions,
  };
}

// --- one leg ---------------------------------------------------------------------------------------------------------

/**
 * A leg's facts (see the header). briefingAt(barT) -> the briefing at a bar (its open time), or null; cycleAt(barClose)
 * -> the run's cycle record ({ result, context }) or null; recordsAt(barT) -> the compose records on the bar; sizeFor(rec)
 * -> sizeFits for barFacts; names: account names the text never shows.
 */
function legFacts(leg, { briefingAt, cycleAt = () => null, recordsAt = () => [], tick, plan, minutes, sizeFor = () => () => null, names = [], missing = [] }) {
  const bars = [];
  for (const c of entryBars(leg)) {
    const barT = new Date(Date.parse(c.bar) - minutes * 60000).toISOString();
    const b = (() => { try { return briefingAt(barT); } catch (_err) { return null; } })();
    const rec = cycleAt(c.bar);
    const said = rec && rec.result ? String(rec.result) : String(c.message || '');
    const records = recordsAt(barT);
    // The plan's stop read at a bar the floor refused: the head's stop choice (its record's stop read and skill).
    const stopRead = c.code === FLOOR ? ((records.filter(r => r && r.side === leg.side && r.ok).pop() || {}).reads || []).find(r => r && r.step === 'stop') || null : null;
    bars.push({ bar: barT, code: c.code, ...(stopRead ? { stopRead: { read: stopRead.read, skill: stopRead.skill || null } } : {}), ...barFacts({ briefing: b, side: leg.side, tick, plan, said, reads: c.reads, records, cycle: c, sizeFits: sizeFor(rec), names, missing }) });
  }
  const learnable = bars.some(x => x.valid) ? true : bars.length && bars.every(x => x.known) ? false : null;
  const why = !bars.length ? 'no entry-able bar' : learnable === true ? bars.find(x => x.valid).why : learnable === false ? 'no valid plan at the time (a correct pass)' : 'facts unknown at a bar';
  let owner;
  if (leg.blocker && leg.blocker.code === FLOOR) {
    // No size fit the model's stop: its stop choice, owned by the skill of that stop read (none known: unowned).
    const s = bars.find(x => x.stopRead);
    const skill = s ? skillOfRead('stop', s.stopRead.read) || s.stopRead.skill || null : null;
    owner = { step: 'stop', ...(skill ? { skill } : {}) };
  } else {
    // The earliest flow step a stated claim and a verified read disagree at, and that read's skill.
    const all = bars.flatMap(x => x.contradictions || []).filter(x => x.step);
    const first = STEPS.map(s => all.find(x => x.step === s)).find(Boolean) || null;
    const skill = first ? skillOfRead(first.step, first.read) || null : null;
    owner = first ? { step: first.step, ...(skill ? { skill } : {}) } : null;
  }
  return { learnable, why, bars, owner };
}

// --- the size chain --------------------------------------------------------------------------------------------------

/**
 * The size a cycle's attempt allows a plan with a `stopTicks` stop, by the entry's own chain (prop/size-translate.js
 * translateSize, at the attempt line's recorded budget and room instead of today's snapshot): the policy's budget plan
 * (prop-state.js sizeWithin, the full multiplier: an upper bound on the verdict's), the composed strategy's
 * risk.max_risk_usd at the contract's all-in risk (capsOf, allInRisk), then the rulebook's floor on that capped size
 * (prop-state.js minContractsRefusal). stopTicks -> true (a size fits), false (none), null outside an attempt,
 * undefined when it can't be worked out.
 */
function sizeForCycle(rec, { strategies, accounts, root, composed, specOf = null }) {
  const prop = require('../trading/prop-state');
  const { capsOf, allInRisk } = require('../prop/size-translate');
  const { feePerSide } = require('../trading/accounts');
  const { familyRoot, specFor } = require('../trading/contracts');
  const spec = specOf || specFor;
  const a = rec && isObj(rec.context) && Array.isArray(rec.context.attempts) ? rec.context.attempts.find(x => isObj(x) && x.status === 'active') : null;
  if (!a) return () => null;
  const policy = strategies.find(s => s.valid && s.signal === 'policy' && s.account === a.account && (s.strategies || []).includes(composed) && (s.instruments || []).some(x => familyRoot(x) === familyRoot(root)));
  const account = accounts.find(x => x.name === a.account);
  const doc = strategies.find(s => s.name === composed);
  const budget = policy ? (a.budgets || []).find(x => x.strategy === policy.name) : null;
  if (!policy || !account || !doc || !doc.risk || !budget || num(budget.budgetUsd) === null) return () => undefined;
  const room = Math.max(0, Math.min(num(a.cushion) ?? Infinity, isObj(a.facts) && num(a.facts.dailyRoom) !== null ? a.facts.dailyRoom : Infinity));
  return stopTicks => {
    if (!(Number.isInteger(stopTicks) && stopTicks > 0)) return undefined;
    const b = prop.sizeWithin({ dollars: budget.budgetUsd, room }, account, policy, root, stopTicks, 1, spec);
    if (b.error) return undefined;
    if (!(b.size >= 1)) return false;
    const s = spec(b.root);
    const perContract = s ? allInRisk({ stopTicks, tickValue: s.tickValue, slipTicks: policy.sizing ? policy.sizing.stop_slippage_ticks : null, feePerSide: feePerSide(account, b.root) }) : NaN;
    if (!(perContract > 0)) return undefined;
    const size = Math.min(b.size, ...capsOf({ capUsd: doc.risk.max_risk_usd, perContract }).map(c => c[0]));
    return size >= 1 && !prop.minContractsRefusal(policy, account, b.root, size, spec);
  };
}

// --- the control bars ------------------------------------------------------------------------------------------------

/**
 * A plan's outcome on the bars after its bar (`after`: that session's later base bars, by time): 'lost' when its stop
 * is hit before its minRR mark (the stop first when one bar holds both), 'won' when the mark is reached first, null when
 * neither is (or the plan has no prices).
 */
function outcomeOf({ side, entry, stop, minRR, after }) {
  if (num(entry) === null || num(stop) === null || !(minRR > 0)) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const mark = side === 'long' ? entry + minRR * risk : entry - minRR * risk;
  for (const b of after || []) {
    const hitStop = side === 'long' ? b.l <= stop : b.h >= stop;
    if (hitStop) return 'lost';
    if (side === 'long' ? b.h >= mark : b.l <= mark) return 'won';
  }
  return null;
}

/** The control bars' facts: each bar's either-side plan check and, for a valid plan, its outcome. */
function controlFacts(cycles, { briefingAt, tick, plan, minutes, sizeFor, names, laterBars, missing = [] }) {
  const out = [];
  for (const rec of cycles) {
    const close = Date.parse(rec.timing.barClose);
    const barT = new Date(close - minutes * 60000).toISOString();
    const b = (() => { try { return briefingAt(barT); } catch (_err) { return null; } })();
    if (!m3Of(b)) { out.push({ bar: barT, known: false, valid: false }); continue; }
    const sides = ['long', 'short'].map(side => ({ side, ...barFacts({ briefing: b, side, tick, plan, said: rec.result || '', sizeFits: sizeFor(rec), names, missing }) }));
    const v = sides.find(x => x.valid) || null;
    out.push({
      bar: barT, known: sides.every(x => x.known) || Boolean(v), valid: Boolean(v),
      ...(v ? { side: v.side, planReads: v.planReads, shown: v.shown, outcome: outcomeOf({ side: v.side, entry: v.entry, stop: v.stop, minRR: plan.minRR, after: laterBars(close) }) } : {}),
    });
  }
  return out;
}

// --- the run home (read only) ----------------------------------------------------------------------------------------

/** A run's bars at a timeframe: the given data files, else the home's bars files, else the run folder's archive. */
function barsOf(home, runDir, root, minutes, barsFiles) {
  const labels = require('../replay/labels');
  const given = barsFiles && Object.keys(barsFiles).length ? labels.outcomeFor(labels.outcomeBarsFor(runDir, barsFiles), root, minutes) : null;
  let list = given || labels.loadBars(home, root, minutes);
  if (!list.length) {
    const { readArchive } = require('../session/bars-archive');
    const byT = new Map();
    let names = [];
    try { names = fs.readdirSync(runDir).filter(n => /^bars-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(n)).sort(); } catch (_err) { /* none */ }
    for (const n of names) for (const x of readArchive(path.join(runDir, n))) if (x && x.minutes === minutes && isObj(x.bar) && !byT.has(x.bar.t)) byT.set(x.bar.t, x.bar);
    list = [...byT.values()];
  }
  return list.slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

/**
 * The capture's missed legs, each with `facts` (legFacts), and its `controls` (controlFacts), from the run's own files:
 * its bars, cycle logs and compose records; tree: the harness tree the run traded (its strategies and accounts);
 * controls: the run's control windows ([{ from, to }], ms; a bar is in one when its close is in (from, to]), none: every
 * trade cycle on no leg's span. Returns a new document: nothing in the run home is written or changed.
 */
function attachFacts(capture, { runDir, home = path.resolve(runDir, '..', '..'), tree, barsFiles = {}, controls = null }) {
  if (!isObj(capture) || !Array.isArray(capture.legs)) return capture;
  const { readJson } = require('../harness-run');
  const cfg = readJson(path.join(runDir, 'autotrader.json'), {}) || {};
  const minutes = Number(cfg.timeframe) || null;
  const root = Array.isArray(cfg.symbols) && cfg.symbols.length ? String(cfg.symbols[0]).toUpperCase() : null;
  const unknownAll = why => ({ ...capture, legs: capture.legs.map(l => (l.captured ? l : { ...l, facts: { learnable: null, why, bars: [], owner: null } })), controls: [] });
  if (!minutes || !root) return unknownAll('the run states no timeframe or symbol');
  const { specFor } = require('../trading/contracts');
  const { loadStrategies } = require('../trading/strategies');
  const { loadAccounts } = require('../trading/accounts');
  const { STRATEGY, stopRuleOf, readRecords } = require('../trading/trade-lifecycle');
  const { briefingFrom } = require('../learning/skill-usage');
  const { historyBars } = require('../autotrader');
  const { cyclesOf } = require('../replay/trend-capture');
  const { tradingDayKey } = require('../trading/clock');
  const spec = specFor(root);
  const strategies = loadStrategies(tree, {}).strategies;
  const doc = strategies.find(s => s.name === STRATEGY);
  if (!spec || !doc || !doc.valid) return unknownAll(`no ${spec ? STRATEGY : 'contract spec'} to check plans with`);
  let accounts = [];
  try { accounts = loadAccounts(tree, {}).accounts || []; } catch (_err) { accounts = []; }
  const names = accounts.map(a => a.name);
  const bars = barsOf(home, runDir, root, minutes, barsFiles);
  const fine = minutes !== 1 ? barsOf(home, runDir, root, 1, barsFiles) : [];
  const count = Number(cfg.bars) > 0 ? Number(cfg.bars) : historyBars(minutes);
  const build = briefingFrom(bars, { root, minutes, count, roundSteps: require('../trading/round-numbers').loadRoundSteps({ FTH_HOME: home }), fineBars: fine.length ? fine : null, blackouts: require('../trading/check-order').readBlackouts(path.join(home, 'blackouts', 'blackouts.json')) });
  const all = cyclesOf(home);
  const cycles = new Map(all.map(c => [Date.parse(c.timing.barClose), c]));
  const records = new Map();
  for (const r of readRecords(home)) { const k = Date.parse(r.bar); if (!records.has(k)) records.set(k, []); records.get(k).push(r); }
  const inAttempt = all.some(c => isObj(c.context) && Array.isArray(c.context.attempts) && c.context.attempts.some(a => a && a.status === 'active'));
  const plan = { size: 1, tickValue: spec.tickValue, minRR: doc.risk.min_rr, maxRiskUsd: doc.risk.max_risk_usd, stopRule: stopRuleOf(doc.risk), suggestion: inAttempt };
  const sizeFor = rec => sizeForCycle(rec, { strategies, accounts, root, composed: STRATEGY });
  const missing = missingFrames({ minutes, fineBars: fine.length ? fine : null });
  const ctx = { briefingAt: t => build(root, t), cycleAt: bar => cycles.get(Date.parse(bar)) || null, recordsAt: t => records.get(Date.parse(t)) || [], tick: spec.tickSize, plan, minutes, sizeFor, names, missing };
  // The control bars: in the given windows, else on no leg's span (start to end bar's close); trade cycles only.
  const stepMs = minutes * 60000;
  const spans = capture.legs.map(l => [Date.parse(l.start), Date.parse(l.end) + stepMs]);
  const inControl = ms => (Array.isArray(controls) ? controls.some(w => ms > w.from && ms <= w.to) : !spans.some(([a, b]) => ms > a && ms <= b));
  // A cycle that managed an open position is no control bar (no entry could be on it), as trend-capture reads it.
  const ctl = all.filter(c => c.action === 'trade' && !/^(?:CYCLE RESULT:\s*)?managed\b/i.test(String(c.result || '')) && inControl(Date.parse(c.timing.barClose)));
  const laterBars = close => { const day = tradingDayKey(new Date(close - 1)); return bars.filter(x => Date.parse(x.t) >= close && tradingDayKey(new Date(Date.parse(x.t))) === day); };
  return {
    ...capture,
    legs: capture.legs.map(l => (l.captured ? l : { ...l, facts: legFacts(l, ctx) })),
    controls: controlFacts(ctl, { ...ctx, laterBars }),
  };
}

/**
 * A round's base rate and balancing examples over its captures: { legBars: { bars, valid }, controlBars: { bars,
 * valid }, losers: [control bar] } (bars: those whose facts are known; losers: valid plans that lost, a day each in
 * turn, at most `examples`).
 */
function controlsOf(captures, { examples = TUN.examples } = {}) {
  const docs = (Array.isArray(captures) ? captures : []).filter(isObj);
  const legBars = docs.flatMap(d => (d.legs || []).filter(l => !l.captured && isObj(l.facts)).flatMap(l => l.facts.bars || [])).filter(x => x.known);
  const ctl = docs.flatMap(d => (Array.isArray(d.controls) ? d.controls : [])).filter(x => x.known);
  const lost = ctl.filter(x => x.valid && x.outcome === 'lost').sort((a, b) => a.bar.localeCompare(b.bar));
  // A day each in turn, so the examples spread over the round's sessions.
  const byDay = new Map();
  for (const x of lost) { const d = x.bar.split('T')[0]; byDay.set(d, [...(byDay.get(d) || []), x]); }
  const losers = [];
  for (let i = 0; losers.length < examples && [...byDay.values()].some(l => l.length > i); i += 1) for (const l of byDay.values()) if (l[i] && losers.length < examples) losers.push(l[i]);
  return { legBars: { bars: legBars.length, valid: legBars.filter(x => x.valid).length }, controlBars: { bars: ctl.length, valid: ctl.filter(x => x.valid).length, lost: lost.length }, losers };
}

// --- the proposer's text ---------------------------------------------------------------------------------------------

const quote = list => list.map(x => `"${scrub(x, { words: false })}"`).join(', ');
// The runner's own words (its entry step's late or unfilled entry, an order placed), not the model's.
const RUNNER = /^\s*(?:CYCLE RESULT:\s*)?(?:[a-z-]+\s+-\s+)?(?:the runner'?s?\b|order placed|missed the plan'?s entry|the setup was invalidated)/i;

/**
 * One example leg: the bar a valid plan existed at (else the first known one); what was said (the runner's own words
 * labelled so), the plan composed there, the contradiction, and the passing plan's reads or why none passed. Never the
 * whole list of TRUE reads: a plan exists on most bars, legs or not (the base rate beside the findings).
 */
function exampleLine(leg, { saidChars = TUN.saidChars } = {}) {
  const f = isObj(leg) && isObj(leg.facts) ? leg.facts : null;
  if (!f || !f.bars.length) return null;
  const x = f.bars.find(b => b.valid) || f.bars.find(b => b.known) || f.bars[0];
  const who = RUNNER.test(x.said) ? 'the runner' : 'what you said';
  // Scrubbed again here: what reaches the proposer is scrubbed whatever the facts were built with.
  const said = clip(scrub(x.shown || x.said), saidChars);
  const tried = (x.reads || []).length ? `; you composed ${x.reads.map(r => `${r.step} "${scrub(r.read, { words: false })}" ${r.verified ? 'TRUE' : 'not verified'}`).join(', ')}` : '';
  // One contradiction a step (the first): the read the facts show, beside the claim.
  const contra = (x.contradictions || []).filter((c, i, list) => list.findIndex(y => y.step === c.step) === i)
    .map(c => `${c.step || 'rule'}: you said "${clip(scrub(c.clause), saidChars)}", the facts: ${/^".*" is false$/.test(c.read) ? scrub(c.read, { words: false }) : `"${scrub(c.read, { words: false })}" TRUE`}`);
  const unknown = x.unknown && x.unknown.length ? ` (${x.unknown.join(', ')} reads unknown)` : '';
  const plan = x.valid ? (x.planReads && x.planReads.length ? `A plan that passed there${unknown}: ${quote(x.planReads)}` : `${scrub(x.why).replace(/^./, ch => ch.toUpperCase())}`) : `No valid plan (${scrub(x.why)})`;
  return `${leg.side}: ${who}: "${said}"${tried}${contra.length ? `. Contradiction: ${contra.join('; ')}` : ''}. ${plan}`;
}

/** One balancing example: a control bar's valid plan that lost, and what was said there. */
function loserLine(x, { saidChars = TUN.saidChars } = {}) {
  return `${x.side}: valid plan, it lost: ${quote(x.planReads || [])}. What you said: "${clip(scrub(x.shown || ''), saidChars)}"`;
}

/** The base rate and the balancing examples as the proposer's text, or '' without control bars. */
function controlsText(c, { exampleChars = TUN.exampleChars } = {}) {
  if (!isObj(c) || !c.controlBars || !c.controlBars.bars) return '';
  const pct = (v, n) => (n ? `${Math.round((v / n) * 100)}%` : 'n/a');
  const head = `Base rate: a valid with-trend plan existed on ${pct(c.legBars.valid, c.legBars.bars)} of the missed legs' entry bars (n=${c.legBars.bars}) and on ${pct(c.controlBars.valid, c.controlBars.bars)} of the control bars with no leg (n=${c.controlBars.bars}): a valid plan alone does not tell a leg.`;
  const lines = (c.losers || []).map(x => `   - ${clip(loserLine(x), exampleChars)}`);
  return `${head}${lines.length ? `\nValid plan, it lost (control bars, no leg): what tells these apart from the legs?\n${lines.join('\n')}` : ''}`;
}

module.exports = { entryBars, statedClaims, barFacts, legFacts, sizeForCycle, outcomeOf, controlFacts, attachFacts, controlsOf, controlsText, scrub, clip, exampleLine, loserLine, missingFrames, dependsOnMissing };
