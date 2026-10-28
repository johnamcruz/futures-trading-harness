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
 *   said       the model's stated reason: the cycle's CYCLE RESULT line (and, for a refused plan, its reads checked);
 *              shown to the proposer beside the plan that passed, never parsed: the proposer reads the two together
 *
 * A leg is learnable when a valid plan existed at one of its bars; not learnable (a correct pass) when every bar was
 * known and none had one; unknown otherwise (a bar with a missing frame and no valid plan on its known reads is not
 * known: the missing frame's reads might have made one). The owner: the earliest flow step where a read the model
 * composed the leg's way was not verified, and that read's skill (the one it named, else curated-moments.js
 * skillOfRead); none when it composed none (a no-plan leg). A leg the floor refused (min-contracts) is the head's stop
 * choice: flow step `stop`, the skill of its plan's stop read.
 *
 * The control bars (controlFacts): the run's trade cycles in its control windows (trend-windows.js), else every trade
 * cycle on no leg's span; at each, each side on its own, the same plan check (a leg bar is checked on the leg's side, so
 * the base rate counts control bar-sides, like with like). The base rate is the share with a valid plan, and each such
 * plan's outcome on the run's later bars that session: lost (its stop hit before its minimum R:R mark, the stop first
 * when one bar holds both), won, or undecided by the session's end. A plan that lost is a balancing example: never a
 * finding, never shown to the trader.
 *
 *   entryBars(leg)                                the leg's entry-able cycles
 *   barFacts({ briefing, side, tick, plan, said, reads, records, cycle, sizeFits, names, missing })   one bar's facts
 *   legFacts(leg, { briefingAt, cycleAt, recordsAt, tick, plan, sizeFor, names, missing })   { learnable, why, bars, owner }
 *   missingFrames({ minutes, fineBars }), dependsOnMissing(read, briefing, missing)   the frames a rebuild lacks
 *   sizeForCycle(rec, { strategies, accounts, root, composed })   stopTicks -> true | false | null | undefined
 *   outcomeOf({ side, entry, stop, minRR, after })   'lost' | 'won' | null from the bars after a plan's bar
 *   attachFacts(capture, { runDir, home, tree, barsFiles, controls })   the capture's missed legs with `facts`, and
 *                                                 its `controls` (read-only)
 *   controlsOf(captures)                          { legBars, controlBars: { sides, valid, won, lost, undecided }, losers }
 *   scrub(text, { names, words })                 text without dates, months, days, clock times, prices, numbers (in
 *                                                 digits, words or fractions), ids or account names (for the proposer)
 *   exampleLine(leg), loserLine(x)                one example for the proposer (no date, time or price)
 */

const fs = require('fs');
const path = require('path');
const { STEPS, TF_ORDER, TF_MIN, parseRead, checkReads } = require('../trading/composed-reads');
const { candidatesOf, repairOf } = require('../trading/compose-hints');
const { trendRuleOf } = require('../trading/reasons');
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

// Month and weekday names and their abbreviations, any case (a verb "may" goes too: the proposer loses nothing by it).
const MONTHS = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b\.?/gi;
const DAYS = /\b(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\b\.?/gi;
// probe-edit.js's number words and the ones it leaves out (a count or an order in words: "one", "fifteen", "first").
const MORE_WORDS = ['zero', 'one', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'sixty', 'seventy', 'eighty', 'ninety',
  'first', 'second', 'million'];
const WORDS = new RegExp(`\\b(?:${[...NUMBER_WORDS, ...MORE_WORDS].join('|')})\\b`, 'gi');
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
    // An ordinal (4th, 21st) whole, so no stub is left.
    .replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ')
    // A timeframe or a whole R multiple stays (15m, 1h, 2r: read names; "15m-1h" whole); every other number goes.
    .replace(/(?<![\w-])\$?-?\d+(?:[.,]\d+)*(?:%|x\b|[mhr]\b)?|(?<=\w-)\d+(?:[.,]\d+)*(?:%|x\b|[mhr]\b)?/gi, m => (/^\d+[mhr]$/i.test(m) ? m : ' '));
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

// --- one bar ---------------------------------------------------------------------------------------------------------

/**
 * The frames a rebuild can't make that the run had: the 5m, built from 1m bars, when the
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
  const base = { said: String(said || ''), shown: scrub(String(said || '').replace(/^\s*CYCLE RESULT:\s*/i, ''), { names }), reads: (reads || []).map(r => ({ step: r.step, read: r.read, verified: r.verified === true })) };
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
  // No plan on the known reads while a frame is missing (the window and the trend rule aside, which no frame decides):
  // the missing frame's reads might have made one, so the bar is not known.
  const framesUnknown = !valid && unknown.length > 0 && m3.windowEntries === 'allowed' && rule === true;
  if (framesUnknown) why = `${why}, on the known reads (${unknown.join(', ')} unknown)`;
  const sizeUnknown = !valid && /the attempt's size can't be worked out/.test(why);
  return {
    ...base, known: !sizeUnknown && !framesUnknown, valid, why, via: chosen ? chosen.via : null, planReads: chosen ? chosen.reads : null,
    entry: chosen ? chosen.entry ?? null : null, stop: chosen ? chosen.stop ?? null : null, stopTicks: chosen ? chosen.stopTicks ?? null : null, unknown,
    verified: Object.fromEntries(STEPS.map(s => [s, cand[s].map(x => x.read)])),
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
    // The earliest flow step a read the model composed the leg's way was not verified at, and that read's skill (the
    // one it named, else the crosswalk's); none when it composed none.
    const unverified = entryBars(leg).flatMap(c => (Array.isArray(c.reads) ? c.reads : [])).filter(r => isObj(r) && r.verified !== true && STEPS.includes(r.step));
    const first = STEPS.map(s => unverified.find(r => r.step === s)).find(Boolean) || null;
    const skill = first ? first.skill || skillOfRead(first.step, first.read) || null : null;
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

/**
 * The control bars' facts, one entry a bar and side (each side checked on its own, as a leg bar is on its leg's):
 * [{ bar, side, known, valid, planReads?, shown?, outcome? }], a valid plan's outcome 'lost' | 'won' | null (undecided).
 */
function controlFacts(cycles, { briefingAt, tick, plan, minutes, sizeFor, names, laterBars, missing = [] }) {
  const out = [];
  for (const rec of cycles) {
    const close = Date.parse(rec.timing.barClose);
    const barT = new Date(close - minutes * 60000).toISOString();
    const b = (() => { try { return briefingAt(barT); } catch (_err) { return null; } })();
    for (const side of ['long', 'short']) {
      if (!m3Of(b)) { out.push({ bar: barT, side, known: false, valid: false }); continue; }
      const f = barFacts({ briefing: b, side, tick, plan, said: rec.result || '', sizeFits: sizeFor(rec), names, missing });
      out.push({
        bar: barT, side, known: f.known, valid: f.valid,
        ...(f.valid ? { planReads: f.planReads, shown: f.shown, outcome: outcomeOf({ side, entry: f.entry, stop: f.stop, minRR: plan.minRR, after: laterBars(close) }) } : {}),
      });
    }
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
  const { recordedBars } = require('../autotrader');
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
  const count = recordedBars({ ...cfg, timeframe: minutes });
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
 * A round's base rate and balancing examples over its captures: { legBars: { bars, valid } (each on its leg's side),
 * controlBars: { sides, valid, won, lost, undecided } (each bar's sides on their own), losers: [control bar-side] }
 * (only those whose facts are known; losers: valid plans that lost, a day each in turn, at most `examples`).
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
  const valid = ctl.filter(x => x.valid);
  const controlBars = { sides: ctl.length, valid: valid.length, won: valid.filter(x => x.outcome === 'won').length, lost: lost.length, undecided: valid.filter(x => x.outcome !== 'won' && x.outcome !== 'lost').length };
  return { legBars: { bars: legBars.length, valid: legBars.filter(x => x.valid).length }, controlBars, losers };
}

// --- the proposer's text ---------------------------------------------------------------------------------------------

const quote = list => list.map(x => `"${scrub(x, { words: false })}"`).join(', ');
// The runner's own words (its entry step's late or unfilled entry, an order placed), not the model's.
const RUNNER = /^\s*(?:CYCLE RESULT:\s*)?(?:[a-z-]+\s+-\s+)?(?:the runner'?s?\b|order placed|missed the plan'?s entry|the setup was invalidated)/i;

/**
 * One example leg: the bar a valid plan existed at (else the first known one); what was said (the runner's own words
 * labelled so), the plan composed there, and the passing plan's reads or why none passed: the proposer reads what was
 * said beside what passed. Never the whole list of TRUE reads: a plan exists on many bars, legs or not (the base rate
 * beside the findings).
 */
function exampleLine(leg, { saidChars = TUN.saidChars } = {}) {
  const f = isObj(leg) && isObj(leg.facts) ? leg.facts : null;
  if (!f || !f.bars.length) return null;
  const x = f.bars.find(b => b.valid) || f.bars.find(b => b.known) || f.bars[0];
  const who = RUNNER.test(x.said) ? 'the runner' : 'what you said';
  // Scrubbed again here: what reaches the proposer is scrubbed whatever the facts were built with.
  const said = clip(scrub(x.shown || x.said), saidChars);
  const tried = (x.reads || []).length ? `; you composed ${x.reads.map(r => `${r.step} "${scrub(r.read, { words: false })}" ${r.verified ? 'TRUE' : 'not verified'}`).join(', ')}` : '';
  const unknown = x.unknown && x.unknown.length ? ` (${x.unknown.join(', ')} reads unknown)` : '';
  const plan = x.valid ? (x.planReads && x.planReads.length ? `A plan that passed there${unknown}: ${quote(x.planReads)}` : `${scrub(x.why).replace(/^./, ch => ch.toUpperCase())}`) : `No valid plan (${scrub(x.why)})`;
  return `${leg.side}: ${who}: "${said}"${tried}. ${plan}`;
}

/** One balancing example: a control bar's valid plan that lost, and what was said there. */
function loserLine(x, { saidChars = TUN.saidChars } = {}) {
  return `${x.side}: valid plan, it lost: ${quote(x.planReads || [])}. What you said: "${clip(scrub(x.shown || ''), saidChars)}"`;
}

/** The base rate and the balancing examples as the proposer's text, or '' without control bars. */
function controlsText(c, { exampleChars = TUN.exampleChars } = {}) {
  if (!isObj(c) || !c.controlBars || !c.controlBars.sides) return '';
  const pct = (v, n) => (n ? `${Math.round((v / n) * 100)}%` : 'n/a');
  const k = c.controlBars;
  const head = `Base rate: a valid with-trend plan existed on ${pct(c.legBars.valid, c.legBars.bars)} of the missed legs' entry bars (the leg's side, n=${c.legBars.bars}) and on ${pct(k.valid, k.sides)} of the control bars with no leg (each side on its own, n=${k.sides}); of those control plans ${k.won} won, ${k.lost} lost, ${k.undecided} undecided by the session's end: a valid plan alone does not tell a leg.`;
  const lines = (c.losers || []).map(x => `   - ${clip(loserLine(x), exampleChars)}`);
  return `${head}${lines.length ? `\nValid plan, it lost (control bars, no leg): what tells these apart from the legs?\n${lines.join('\n')}` : ''}`;
}

module.exports = { entryBars, barFacts, legFacts, sizeForCycle, outcomeOf, controlFacts, attachFacts, controlsOf, controlsText, scrub, clip, exampleLine, loserLine, missingFrames, dependsOnMissing };
