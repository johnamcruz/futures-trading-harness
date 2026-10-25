'use strict';

/**
 * The facts at a missed trend leg's start (Propose-Probe-Compose, docs/TRAINING.md, "The trend findings"): for each
 * missed or refused leg of a trend run, at each of its entry-able bars, what code verified TRUE on the leg's side and
 * whether a valid with-trend plan existed, next to what the model said. Analysis after the run only, for the proposer's
 * findings (trend-findings.js); never written to a run home, never in a role, cycle or tool prompt.
 *
 * The bars: the leg's catch window's trade cycles (trend-capture.js: the bars it classifies, from the leg's start bar's
 * close), less those outside the session, behind an open position or blocked by a rule. The briefing at each bar is
 * rebuilt from the run's bars closed by its close (learning/skill-usage.js briefingFrom, the runner's buildBriefing; a
 * timeframe it can't rebuild, the 5m without the run's 1m bars, is listed `unknown`, its reads never counted). Where
 * the run recorded compose_check calls on the bar, their reads are checked again on the rebuilt briefing: any read the
 * record and the rebuild check differently (a frame known on both) makes the bar `unknown`, never guessed.
 *
 * At each bar (barFacts), by the same machinery compose_check and its hints use, never a copy of it:
 *   verified   per flow step, the reads TRUE on the bar for the side (compose-hints.js candidatesOf), names only
 *   valid      a with-trend plan passes: the window allows entries, the trend rule allows the side (reasons.js
 *              trendRuleOf: true, never only as a reversal), and the briefing's standard plan for the side is OK
 *              (setup-library.js standardPlans) or a combination of the verified reads passes the check and the plan
 *              (compose-hints.js repairOf, from no reads: R:R, the room rule, the stop floor); under a prop attempt
 *              (the cycle's own attempt line) a size fits too (prop-state.js sizeWithin at the attempt's budget and
 *              room, the rulebook's floor). A bar whose cycle had an OK record the leg's way (passed on, vetoed, late,
 *              refused at the gate, unfilled) had one too, but for the floor's own refusal (min-contracts)
 *   said       the model's stated reason: the cycle's CYCLE RESULT line (and, for a refused plan, its reads checked)
 *   contradictions   a stated claim about a step that the same facts show false: "no setup" / "no rejection" against
 *              a verified setup read; "no entry" against a verified confirmation on a candle closed after it; "not at a
 *              level" against a verified `at` read; "against the trend" when the trend rule allows the side; "no
 *              target" against a verified target; a 15m/1h/4h direction the checker finds FALSE; and every claim the
 *              reason check (reasons.js checkReasons on the bar's facts) finds FALSE. Nothing else is flagged.
 *
 * A leg is learnable when a valid plan existed at one of its bars; not learnable (a correct pass) when every bar was
 * known and none had one; unknown otherwise. A no-plan leg's owner: the first flow step where a stated claim and the
 * verified reads disagree, and the skill of that read (curated-moments.js skillOfRead, the crosswalk); none without.
 *
 *   entryBars(leg)                                the leg's entry-able cycles
 *   statedClaims(text, side)                      [{ step, clause, test }] the step-claims a reason states for the side
 *   barFacts({ briefing, side, tick, plan, said, reads, records, cycle, sizeFits })   one bar's facts (see above)
 *   legFacts(leg, { briefingAt, cycleAt, recordsAt, tick, plan, sizeFor })   { learnable, why, bars, owner }
 *   attachFacts(capture, { runDir, home, tree, barsFiles })   the capture's missed legs with `facts` (read-only)
 *   scrub(text)                                   text without dates, clock times, prices or ids (for the proposer)
 *   exampleLine(leg, { perStep })                 one example leg for the proposer: side, verified reads, said, contradictions
 */

const fs = require('fs');
const path = require('path');
const { STEPS, TF_ORDER, TF_MIN, parseRead, checkRead, checkReads, candleClose } = require('../trading/composed-reads');
const { candidatesOf, repairOf } = require('../trading/compose-hints');
const { trendRuleOf, checkReasons, factsFromBriefing, clausesOf } = require('../trading/reasons');
const { standardPlans } = require('../learning/setup-library');
const { skillOfRead } = require('../learning/curated-moments');

const PER_STEP = require('../tunables').analysis().composeHints.perStep; // config/analysis.json: the reads a hint lists a step
// What the model said, as an example shows it, clipped (config/training.json trendFindings).
const SAID_CHARS = require('../tunables').training().trendFindings.saidChars;
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const m3Of = b => (isObj(b) && isObj(b.sections) && isObj(b.sections.m3) && isObj(b.sections.m3.data) ? b.sections.m3.data : null);
// The codes of trend-capture.js classifyCycle after an OK record the leg's way (its plan passed compose_check), by
// the head trader's pass, phase 2, the gate or the executor; the floor's own refusal (min-contracts) is no size fitting.
const OK_CODES = new Set(['head-pass', 'veto', 'verdict-unread', 'late-entry', 'executor-abort', 'blocked', 'unfilled', 'entered']);
const ownOk = c => isObj(c) && c.code !== 'min-contracts' && (OK_CODES.has(c.code) || c.by === 'gate');

/** The leg's entry-able cycles: its catch window's, less outside the session, a position open, a rule's block. */
const entryBars = leg => (isObj(leg) && Array.isArray(leg.cycles) ? leg.cycles : []).filter(c => isObj(c) && c.bar && c.by !== 'rule' && !['outside-session', 'position-open'].includes(c.code));

/** Text for the proposer: no date, clock time, price, number or id (timeframes such as 15m and 1h kept). */
function scrub(text) {
  return String(text || '')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:ET|CT|UTC))?\b/gi, ' ')
    .replace(/\b[0-9a-f]{12,}\b/gi, ' ')
    .replace(/\b[a-z]+_[a-z0-9_]*\d[a-z0-9_]*\b/gi, 'the account')
    // A timeframe or a whole R multiple stays (15m, 1h, 2r: read names); every other number goes.
    .replace(/\$?-?\d+(?:[.,]\d+)*(?:%|x\b|[mhr]\b)?/gi, m => (/^\d+[mhr]$/i.test(m) ? m : ' '))
    .replace(/\(\s*[-,;:/\s]*\)/g, ' ')
    .replace(/([,;])(?:\s*[,;])+/g, '$1')
    .replace(/[,;:]\s*\)/g, ')')
    .replace(/\s+([,;:.)])/g, '$1')
    .replace(/([(])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Which sides a clause names ('long', 'short', or bullish, bearish); none: it is about whatever side the reason is about. */
const sidesIn = c => [...new Set((String(c).match(/\b(longs?|shorts?|bull(?:ish)?|bear(?:ish)?)\b/gi) || []).map(x => (/^(long|bull)/i.test(x) ? 'long' : 'short')))];
// A clause about the runner's entry (a late or missed entry): the execution step's, never a claim about the reads.
const EXECUTION = /late entry|runner'?s entry|missed the plan'?s entry|invalidated before the order/i;

// The step-claims a stated reason makes, each with what would show it false (see the header). Claims only of absence
// or opposition: a stated fact ("closed bottom third") is never read as a claim about the step.
const CLAIMS = [
  { step: 'bias', re: /against (?:the )?(?:trend(?: rule)?|prevailing|(?:15m|1h|4h)(?:\/(?:15m|1h|4h))* (?:up|down|trend))|counter[- ]?trend|trend rule (?:refuses|blocks|bars|forbids)|only as a reversal/i, test: 'rule' },
  { step: 'location', re: /not at (?:a |any )?(?:key )?level|\bno (?:key )?level\b(?! (?:ahead|below|above|on the winning))|location not at|mid-?range/i, test: 'at' },
  // "no entry candle closed after the rejection" is an entry claim (the rejection is granted), never a setup one.
  { step: 'setup', re: /\bno (?:(?!entry|trigger|confirm|candle|close)[\w/-]+ ){0,6}?(setup|rejection|reaction|breakout|break|sweep|cisd|reclaim)s?\b/i, test: 'setup' },
  { step: 'entry', re: /\bno (?:[\w/-]+ ){0,5}?(?:entry|trigger|confirm\w*)\b|\bunconfirmed\b|not confirmed/i, test: 'entry' },
  { step: 'target', re: /\bno (?:named )?(?:level|target)s? (?:below|above|ahead|on the winning side)|\bno target\b/i, test: 'target' },
];
// A timeframe's direction ("15m bearish", "1h up"), never a candle or a structure named by it ("15m bearish CISD").
const DIRECTION = /\b(15m|1h|4h) (?:trend )?(?:is )?(bullish|bearish|up|down|uptrend|downtrend)\b(?!-|\s+(?:displacement|candle|cisd|engulfing|fvg|bar|close|choch|bos|rejection|reaction|break|sweep|pattern|momentum|move|leg|wick))/i;

/** The step-claims a reason states that bear on the side (a clause naming only the other side says nothing of it). */
function statedClaims(text, side) {
  const out = [];
  for (const clause of clausesOf(text).clauses) {
    if (EXECUTION.test(clause)) continue;
    // A timeframe's direction is a claim of fact whatever side it favours ("15m bullish" under a short).
    const d = DIRECTION.exec(clause);
    const sides = sidesIn(d ? clause.replace(d[0], '') : clause);
    if (!sides.length || sides.includes(side)) {
      for (const c of CLAIMS) {
        const m = c.re.exec(clause);
        if (m) out.push({ step: c.step, clause, test: c.test, word: (m[1] || '').toLowerCase() });
      }
    }
    if (d) out.push({ step: 'bias', clause, test: 'direction', read: `${d[1].toLowerCase()} ${/bull|up/i.test(d[2]) ? 'up' : 'down'}` });
  }
  return out;
}

/** The verified read (if any) that shows a stated claim false on this bar (see the header), or null. */
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
    return (verified.setup.find(fit) || {}).read || null;
  }
  // An entry: a confirmation pointing the side on a candle closed after the latest verified setup's.
  const s = verified.setup[0];
  if (!s || num(s.close) === null) return null;
  const m3 = m3Of(briefing);
  const e = verified.entry.find(x => { const t = candleClose(m3, String(x.read).split(' ')[0]); return t !== null && t > s.close; });
  return e ? e.read : null;
}

/** The timeframes the rebuilt briefing lacks (at or above its base): their reads unknown, never counted either way. */
function unknownFrames(b) {
  const m3 = m3Of(b);
  const candles = m3 && isObj(m3.candles) ? m3.candles : {};
  return TF_ORDER.filter(tf => TF_MIN[tf] >= (Number(b.minutes) || 0) && (!isObj(candles[tf]) || candles[tf].unavailable));
}

/** A read's frame (its first word when a timeframe), or null. */
const frameOf = read => { const w = String(read || '').split(' '); return TF_MIN[w[0]] ? w[0] : TF_MIN[w[1]] ? w[1] : null; };

/** Whether the run's compose records on this bar check the same on the rebuilt briefing (frames unknown left out). */
function sameAsRecorded(records, b, tick, unknown) {
  for (const rec of records || []) {
    const reads = (rec.reads || []).filter(r => isObj(r) && typeof r.read === 'string' && (r.check === true || r.check === false) && !unknown.includes(frameOf(r.read)));
    if (!reads.length) continue;
    const again = checkReads({ reads: reads.map(r => ({ step: r.step, skill: r.skill, read: r.read, why: r.why || null })), side: rec.side, briefing: b, tick });
    for (const r of reads) {
      const x = again.reads.find(y => y.step === r.step && y.read === r.read);
      if (!x || (x.check === true) !== (r.check === true)) return false;
    }
  }
  return true;
}

/**
 * One bar's facts (see the header). plan: compose_check's plan arguments (size, tickValue, minRR, maxRiskUsd, stopRule,
 * suggestion); sizeFits(stopTicks) -> true | false | null (null: no attempt constrains, or unknown: `undefined`).
 */
function barFacts({ briefing, side, tick, plan, said = '', reads = [], records = [], cycle = null, sizeFits = () => null }) {
  const m3 = m3Of(briefing);
  if (!m3) return { known: false, valid: false, why: 'no briefing for the bar', said: String(said || '') };
  const unknown = unknownFrames(briefing);
  if (!sameAsRecorded(records, briefing, tick, unknown)) return { known: false, valid: false, why: 'the rebuilt briefing checks the run\'s compose record differently', said: String(said || '') };
  const cand = candidatesOf(briefing, side, { tick, stopRule: plan.stopRule });
  const drop = list => list.filter(x => !unknown.includes(frameOf(x.read)));
  const verified = Object.fromEntries(STEPS.map(s => [s, drop(cand[s])]));
  const rule = trendRuleOf(m3.trendRule)[side];
  let valid = false;
  let why;
  let planReads = null;
  let via = null;
  let stopTicks = null;
  if (m3.windowEntries !== 'allowed') why = 'the window allows no entries';
  else if (rule === false) why = `the trend rule allows the ${side} only as a reversal`;
  else if (rule !== true) why = 'the trend rule for the side is unknown';
  else {
    const standard = (standardPlans(briefing) || []).find(p => p.side === side && p.status === 'traded') || null;
    const fixed = standard ? null : repairOf({ reads: [], side, briefing, tick, plan, candidates: cand });
    if (standard) { via = 'standard'; planReads = (standard.reads || []).map(r => (isObj(r) ? r.read : r)); stopTicks = standard.plan && standard.plan.stop ? num(standard.plan.stop.ticks) : null; }
    if (fixed) { via = 'together'; planReads = fixed.reads.map(r => r.read); stopTicks = num(fixed.planned.plan.stop.ticks); }
    if (!via) why = 'no combination of the verified reads passes the check and the plan';
    else {
      const fits = sizeFits(stopTicks);
      if (fits === false) why = 'no size fits the attempt\'s budget at the rulebook\'s floor';
      else if (fits === undefined) why = 'the attempt\'s size can\'t be worked out';
      else { valid = true; why = via === 'standard' ? 'the standard plan passes' : 'these reads pass together'; }
    }
  }
  // The model's own OK record the leg's way on this bar: a plan that passed compose_check (the floor's refusal aside).
  if (!valid && ownOk(cycle)) { valid = true; why = 'your own plan passed compose_check'; }
  const sizeUnknown = !valid && why === 'the attempt\'s size can\'t be worked out';
  const ctx = { verified, briefing, side, tick, rule };
  const contradictions = [];
  for (const c of statedClaims(said, side)) {
    const read = refute(c, ctx);
    if (read && !contradictions.some(x => x.step === c.step && x.clause === c.clause)) contradictions.push({ step: c.step, clause: c.clause, read });
  }
  try {
    for (const c of checkReasons(String(said || ''), factsFromBriefing(briefing)).claims.filter(x => x.check === false)) contradictions.push({ step: null, clause: c.clause, read: c.why });
  } catch (_err) { /* the reason check can't read it: none flagged */ }
  return {
    known: !sizeUnknown, valid, why, via, planReads, unknown, said: String(said || ''),
    reads: (reads || []).map(r => ({ step: r.step, read: r.read, verified: r.verified === true })),
    verified: Object.fromEntries(STEPS.map(s => [s, verified[s].map(x => x.read)])), contradictions,
  };
}

/**
 * A leg's facts (see the header). briefingAt(barT) -> the briefing at a bar (its open time), or null; cycleAt(barClose)
 * -> the run's cycle record ({ result, context }) or null; recordsAt(barT) -> the compose records on the bar the leg's
 * way or not; sizeFor(cycle) -> sizeFits for barFacts.
 */
function legFacts(leg, { briefingAt, cycleAt = () => null, recordsAt = () => [], tick, plan, minutes, sizeFor = () => () => null }) {
  const bars = [];
  for (const c of entryBars(leg)) {
    const close = Date.parse(c.bar);
    const barT = new Date(close - minutes * 60000).toISOString();
    const b = (() => { try { return briefingAt(barT); } catch (_err) { return null; } })();
    const rec = cycleAt(c.bar);
    const said = rec && rec.result ? String(rec.result) : String(c.message || '');
    bars.push({ bar: barT, code: c.code, ...barFacts({ briefing: b, side: leg.side, tick, plan, said, reads: c.reads, records: recordsAt(barT), cycle: c, sizeFits: sizeFor(rec) }) });
  }
  const learnable = bars.some(x => x.valid) ? true : bars.length && bars.every(x => x.known) ? false : null;
  const why = learnable === true ? (bars.find(x => x.valid) || {}).why : learnable === false ? (bars.length ? 'no valid plan at the time (a correct pass)' : 'no entry-able bar') : 'facts unknown at a bar';
  // The no-plan leg's owner: the earliest flow step a stated claim and a verified read disagree at, and that read's skill.
  const all = bars.flatMap(x => x.contradictions || []).filter(x => x.step);
  const first = STEPS.map(s => all.find(x => x.step === s)).find(Boolean) || null;
  const skill = first ? skillOfRead(first.step, first.read) || null : null;
  return { learnable, why: learnable === null && !bars.length ? 'no entry-able bar' : why, bars, owner: first ? { step: first.step, ...(skill ? { skill } : {}) } : null };
}

// --- the run home (read only) ----------------------------------------------------------------------------------------

/** A run's bars at a timeframe: the home's bars files, else the run folder's served-bars archive, by time. */
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
 * The sizeFits of a cycle's attempt (its context's attempt line: the size budget and room it stated), for the policy
 * that trades the composed strategy on the account; null outside an attempt; undefined when it can't be worked out.
 */
function sizeForCycle(rec, { strategies, accounts, root, composed }) {
  const prop = require('../trading/prop-state');
  const { familyRoot } = require('../trading/contracts');
  const a = rec && isObj(rec.context) && Array.isArray(rec.context.attempts) ? rec.context.attempts.find(x => isObj(x) && x.status === 'active') : null;
  if (!a) return () => null;
  const policy = strategies.find(s => s.valid && s.signal === 'policy' && s.account === a.account && (s.strategies || []).includes(composed) && (s.instruments || []).some(x => familyRoot(x) === familyRoot(root)));
  const account = accounts.find(x => x.name === a.account);
  const budget = policy ? (a.budgets || []).find(x => x.strategy === policy.name) : null;
  if (!policy || !account || !budget || num(budget.budgetUsd) === null) return () => undefined;
  const room = Math.max(0, Math.min(num(a.cushion) ?? Infinity, isObj(a.facts) && num(a.facts.dailyRoom) !== null ? a.facts.dailyRoom : Infinity));
  return stopTicks => {
    if (!(Number.isInteger(stopTicks) && stopTicks > 0)) return undefined;
    const p = prop.sizeWithin({ dollars: budget.budgetUsd, room }, account, policy, root, stopTicks);
    return p.error ? undefined : p.size >= 1;
  };
}

/**
 * The capture's missed legs, each with `facts` (legFacts), from the run's own files: its bars, cycle logs and compose
 * records; tree: the harness tree the run traded (its strategies and accounts). Returns a new document: the capture
 * written to the run's folder is never changed (nothing here reaches a run home).
 */
function attachFacts(capture, { runDir, home = path.resolve(runDir, '..', '..'), tree, barsFiles = {} }) {
  if (!isObj(capture) || !Array.isArray(capture.legs)) return capture;
  const { readJson } = require('../harness-run');
  const cfg = readJson(path.join(runDir, 'autotrader.json'), {}) || {};
  const minutes = Number(cfg.timeframe) || null;
  const root = Array.isArray(cfg.symbols) && cfg.symbols.length ? String(cfg.symbols[0]).toUpperCase() : null;
  const unknownAll = why => ({ ...capture, legs: capture.legs.map(l => (l.captured ? l : { ...l, facts: { learnable: null, why, bars: [], owner: null } })) });
  if (!minutes || !root) return unknownAll('the run states no timeframe or symbol');
  const { specFor } = require('../trading/contracts');
  const { loadStrategies } = require('../trading/strategies');
  const { loadAccounts } = require('../trading/accounts');
  const { STRATEGY, stopRuleOf, readRecords } = require('../trading/trade-lifecycle');
  const { briefingFrom } = require('../learning/skill-usage');
  const { historyBars } = require('../autotrader');
  const { cyclesOf } = require('../replay/trend-capture');
  const spec = specFor(root);
  const strategies = loadStrategies(tree, {}).strategies;
  const doc = strategies.find(s => s.name === STRATEGY);
  if (!spec || !doc || !doc.valid) return unknownAll(`no ${spec ? STRATEGY : 'contract spec'} to check plans with`);
  let accounts = [];
  try { accounts = loadAccounts(tree, {}).accounts || []; } catch (_err) { accounts = []; }
  const bars = barsOf(home, runDir, root, minutes, barsFiles);
  const fine = minutes !== 1 ? barsOf(home, runDir, root, 1, barsFiles) : [];
  const count = Number(cfg.bars) > 0 ? Number(cfg.bars) : historyBars(minutes);
  const build = briefingFrom(bars, { root, minutes, count, roundSteps: require('../trading/round-numbers').loadRoundSteps({ FTH_HOME: home }), fineBars: fine.length ? fine : null, blackouts: require('../trading/check-order').readBlackouts(path.join(home, 'blackouts', 'blackouts.json')) });
  const cycles = new Map(cyclesOf(home).map(c => [Date.parse(c.timing.barClose), c]));
  const records = new Map();
  for (const r of readRecords(home)) { const k = Date.parse(r.bar); if (!records.has(k)) records.set(k, []); records.get(k).push(r); }
  const inAttempt = [...cycles.values()].some(c => isObj(c.context) && Array.isArray(c.context.attempts) && c.context.attempts.some(a => a && a.status === 'active'));
  const plan = { size: 1, tickValue: spec.tickValue, minRR: doc.risk.min_rr, maxRiskUsd: doc.risk.max_risk_usd, stopRule: stopRuleOf(doc.risk), suggestion: inAttempt };
  const ctx = {
    briefingAt: t => build(root, t), cycleAt: bar => cycles.get(Date.parse(bar)) || null, recordsAt: t => records.get(Date.parse(t)) || [], tick: spec.tickSize, plan, minutes,
    sizeFor: rec => sizeForCycle(rec, { strategies, accounts, root, composed: STRATEGY }),
  };
  return { ...capture, legs: capture.legs.map(l => (l.captured ? l : { ...l, facts: legFacts(l, ctx) })) };
}

// --- the proposer's text ---------------------------------------------------------------------------------------------

const quote = list => list.map(x => `"${scrub(x)}"`).join(', ');

/** One example leg (see the header): the bar a valid plan existed at (else the first), never a date, time or price. */
function exampleLine(leg, { perStep = PER_STEP, saidChars = SAID_CHARS } = {}) {
  const f = isObj(leg) && isObj(leg.facts) ? leg.facts : null;
  if (!f || !f.bars.length) return null;
  const x = f.bars.find(b => b.valid) || f.bars.find(b => b.known) || f.bars[0];
  // The reads that make the plan (bias to entry); a stop and target show in the passing plan's own reads.
  const steps = x.verified ? STEPS.slice(0, STEPS.indexOf('stop')).filter(s => x.verified[s] && x.verified[s].length).map(s => `${s} ${quote(x.verified[s].slice(0, perStep))}`) : [];
  const plan = x.valid ? (x.via === 'standard' ? 'the standard plan passed' : x.via === 'together' ? `these passed together: ${quote(x.planReads || [])}` : scrub(x.why)) : `no valid plan (${scrub(x.why)})`;
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 3)}...` : t);
  const said = clip(scrub(String(x.said || '').replace(/^\s*CYCLE RESULT:\s*/i, '')), saidChars);
  const tried = (x.reads || []).length ? `; you composed ${x.reads.map(r => `${r.step} "${scrub(r.read)}" ${r.verified ? 'TRUE' : 'not verified'}`).join(', ')}` : '';
  // One contradiction a step (the first): the read the facts show, beside the claim.
  const contra = (x.contradictions || []).filter((c, i, all) => all.findIndex(y => y.step === c.step) === i).map(c => `${c.step || 'rule'}: you said "${clip(scrub(c.clause), saidChars)}", the facts: ${/^".*" is false$/.test(c.read) ? scrub(c.read) : `"${scrub(c.read)}" TRUE`}`);
  const unknown = x.unknown && x.unknown.length ? ` (${x.unknown.join(', ')} reads unknown)` : '';
  return `${leg.side}: what you said: "${said}"${tried}${contra.length ? `. Contradiction: ${contra.join('; ')}` : ''}. The facts code verified at its start${unknown}: ${steps.join('; ') || 'none'}; ${plan}`;
}

module.exports = { entryBars, statedClaims, barFacts, legFacts, attachFacts, sizeForCycle, scrub, exampleLine, unknownFrames };
