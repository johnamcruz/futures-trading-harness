'use strict';

/**
 * The adherence scorecard of a replay run (the learned-policy design's R19,
 * with R25's failure taxonomy): for every decision the model made, the facts
 * it had, the decision the priority order's mechanical steps expect from them
 * (strategy-library, "The priority order: the rule for every setup"), the
 * decision it made and the reasons it stated, each reason checked against the
 * facts, and a failure category. Its per-step deviation rates are what R20
 * later feeds back into the attempt simulation.
 *
 * Built on the labels (labels.js: the decision, orders, gate, outcome and
 * counterfactuals per decision time and symbol), plus what the run recorded
 * at that time (all local, the run home):
 *   logs/scans-<day>.jsonl          the scanned bar: what fired, the trend rule per strategy, confluence
 *   policy-verdicts.jsonl           a policy strategy's verdict on the bar (component, size, the attempt)
 *   logs/cycles/<day>/*.json        the cycle's context: the attempt (balance, floor, cushion, entry block)
 *   bars/, bars-scratch/ (or --bars) the bars closed by the decision: the briefing rebuilt with the
 *                                   runner's own code (trading/briefing.js) for the room and the
 *                                   multi-timeframe read of each setup, as the model was given them
 *   blackouts/blackouts.json        the news blackouts (the briefing's `blocked`)
 *
 * Expected decision, per setup (a rules candidate or a policy verdict), step by step:
 *   1 hard stops    a no-entry window or news blackout (the briefing's `blocked`), a skip verdict,
 *                   the attempt's entry block  -> no trade
 *   2 trend rule    a trend strategy against it -> no trade; a reversal fading it -> judgment, half
 *   3 room          the first level in its way before the R it needs -> no trade
 *   4 mtf read      aligned -> full; mixed -> half; counter (non-reversal) -> no trade; pullback -> judgment
 *   5 skip rules    judgment (the strategy's own text)
 *   6 confluence    a setup on the other side -> no trade
 *   7 secondary     the VWAP on the other side, the lunch lull -> judgment (may halve)
 * The highest step that says no trade decides; else a step it can't compute (no bars, no scan)
 * leaves it `unchecked`; else `take`, at most the verdict's size (halved once, floor; 0 is no trade).
 * With no setup on the bar the expectation is no trade ('no setup').
 *
 * Reasons: the CYCLE RESULT text is split into clauses; each claim a clause makes that the facts can
 * check (a no-entry window, nothing fired, the trend rule blocking a side, no attempt, no verdict,
 * room, a mixed or counter read, no confluence, an entry block) is confirmed or flagged false;
 * a claim without a fact to check is `unchecked`, a clause naming a judgment (regime, ADX, volume,
 * VWAP...) is `judgment`, and a clause nothing recognizes is `unparsed`. Never silently ok.
 *
 * An entry is judged against the setup it traded (its setup tag, a policy by its own name, on its side); a skip
 * against the setup the order lets go furthest. A take whose judgment steps can still say no trade (a reversal
 * fading the trend, a pullback, a halving of a size the record doesn't give) is `couldSkip`: neither a skip nor an
 * entry on it is scored right or wrong, only its reasons.
 *
 * Categories: wrong-side entry, bad size (over the ceiling; entering where it is 0), early close (an exit
 * the model sent in a trade before the plan's exit was reached; a partial exit, one past the time stop or
 * after giving back most of a large best is the plan's management: unchecked), excessive abstention (a
 * skip where the order says take, with no true or judgment ground stated), wrong stated reason (the
 * decision agrees, a decision-relevant reason is false), risk-rule rejection (the gate or the broker
 * refused the entry), right, unchecked. A false claim about a setup the bar didn't have (a side with no
 * setup, a bar with none) is `incidental`: kept and reported apart, never the category.
 *
 * Deterministic: the same files give the same scorecard.
 *
 *   scoreRun(runDir, { strategies, accounts, outcomeBars, unfinished })   { records, summary }
 *   writeScorecard(runDir, { root, strategies, accounts, barsFiles, outDir })  scorecard.jsonl, scorecard-summary.json, scorecard.md
 *   checkReasons(text, facts), expectedDecision(facts), classify(label, facts, expected, reasons)   the pure steps
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../harness-run');
const { readLines, readRun } = require('./store');
const { labelRun, loadBars, outcomeBarsFrom, inside, realDir, unfinishedWhy } = require('./labels');
const { buildBriefing, sessionWindow } = require('../trading/briefing');
const { readBlackouts } = require('../trading/check-order');
const { exitPlan } = require('../trading/evaluator');
const { historyBars } = require('../autotrader');
const { expandHome } = require('../paths');

const VERSION = 1;
const CATEGORIES = ['right', 'wrong-side entry', 'bad size', 'early close', 'excessive abstention', 'wrong stated reason', 'risk-rule rejection', 'unchecked'];
const STEPS = ['hard stops', 'trend rule', 'room', 'multi-timeframe read', 'skip rules', 'confluence', 'secondary context'];
// Labels whose flat silence is no skip (labels.js NOT_A_SKIP): the model touched an order, or what it did is unknown.
const NOT_A_DECISION = new Set(['order cancel', 'working-order change', 'exit while flat', 'unattributed order', 'no cycle log', 'cycle failed', 'cycle timed out', 'working order', 'manage-only', 'paper mode', 'policy screen failed']);

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const round = (x, d = 2) => (num(x) === null ? null : Number(x.toFixed(d)));
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const etClock = ms => ET.format(new Date(ms));
const NO_ENTRY = /\(no entries\)|closed/;

// ---------------------------------------------------------------------------------------------
// Expected decision

/** One setup's steps of the priority order: [{ step, name, result: pass|no-trade|half|judgment|unknown, why }]. */
function setupSteps(s, facts) {
  const out = [];
  const add = (step, result, why) => out.push({ step, name: STEPS[step - 1], result, why });
  const s1 = s.blocked ? s.blocked : s.verdict && s.verdict.action === 'skip' ? `the verdict is skip${s.verdict.reason ? ` (${s.verdict.reason})` : ''}`
    : s.policy && facts.attempt && facts.attempt.entryBlock ? `the attempt blocks entries (${facts.attempt.entryBlock})` : null;
  add(1, s1 ? 'no-trade' : 'pass', s1 || 'no hard stop');
  const fading = s.prevailing && s.prevailing.trend === (s.direction === 'long' ? 'down' : 'up');
  if (s.style === 'reversal') add(2, fading ? 'judgment' : 'pass', fading ? `a reversal fading the ${s.prevailing.label} ${s.prevailing.trend} trend: only at a higher-timeframe level, half size` : 'a reversal, not fading');
  else if (s.trendAllows === false) add(2, 'no-trade', `a trend strategy ${s.direction} against the trend rule`);
  else if (s.trendAllows === true) add(2, 'pass', `the trend rule allows a ${s.direction}`);
  else add(2, 'unknown', 'the trend rule for its side is not recorded');
  if (!s.room) add(3, 'unknown', 'the room is unknown (no bars to rebuild the briefing, or no stop)');
  else if (s.room.inTheWay && s.room.inTheWay.R < s.room.needR) add(3, 'no-trade', `${s.room.inTheWay.name} at ${s.room.inTheWay.R}R before the ${s.room.needR}R it needs`);
  else add(3, 'pass', s.room.inTheWay ? `${s.room.inTheWay.name} at ${s.room.inTheWay.R}R, it needs ${s.room.needR}R` : `no level in its way, it needs ${s.room.needR}R`);
  const al = s.alignment;
  if (al === 'aligned') add(4, 'pass', 'aligned');
  else if (al === 'mixed') add(4, 'half', 'mixed: half');
  else if (al === 'pullback') add(4, 'judgment', 'pullback: no trade until the trigger timeframe turns back');
  else if (al === 'counter') add(4, s.style === 'reversal' ? 'pass' : 'no-trade', s.style === 'reversal' ? 'counter, a reversal (step 2 decides)' : 'counter on a non-reversal setup');
  else add(4, 'unknown', 'the multi-timeframe read for its side is unknown');
  add(5, 'judgment', 'the strategy\'s own context filter and skip rules');
  const against = (s.confluence && s.confluence.against.length ? s.confluence.against : []).concat(facts.setups.filter(x => x !== s && x.candidate && x.direction !== s.direction).map(x => x.name));
  add(6, against.length ? 'no-trade' : 'pass', against.length ? `against: ${[...new Set(against)].join(', ')}` : s.confluence && s.confluence.with.length ? `with ${s.confluence.with.join(', ')}` : 'none');
  const secondary = [s.vwapSide && s.vwapSide !== 'at' && (s.direction === 'long' ? s.vwapSide === 'below' : s.vwapSide === 'above') ? 'the VWAP on the other side' : null, s.lunch ? 'the lunch lull' : null].filter(Boolean);
  add(7, secondary.length ? 'judgment' : 'pass', secondary.length ? `${secondary.join(', ')}: may halve` : 'none against');
  return out;
}

const NONE = { setup: null, steps: [], judgment: [], couldSkip: [] };

/**
 * One setup's expectation: no-trade | take | unchecked, the ceiling, the deciding step, and `couldSkip`: the
 * judgment steps that can still say no trade (a reversal fading the trend: only at a level; a pullback: not until
 * it turns; a halving of a size the record doesn't give: at 1, half is 0).
 */
function setupExpectation(s, facts) {
  const steps = setupSteps(s, facts);
  const stop = steps.find(x => x.result === 'no-trade');
  const unknown = steps.find(x => x.result === 'unknown');
  const halves = steps.filter(x => x.result === 'half' || (x.step === 2 && x.result === 'judgment'));
  const max = s.verdict ? num(s.verdict.maxSize) : null;
  const ceiling = stop ? 0 : max === null ? null : halves.length ? Math.floor(max / 2) : max;
  const decision = stop || ceiling === 0 ? 'no-trade' : unknown ? 'unchecked' : 'take';
  const decidedBy = stop ? stop.step : ceiling === 0 ? halves[0].step : unknown ? unknown.step : 'take';
  const couldSkip = decision !== 'take' ? [] : [...new Set([
    ...steps.filter(x => x.result === 'judgment' && (x.step === 2 || x.step === 4)).map(x => x.step),
    ...(max === null ? halves.map(x => x.step) : []),
  ])].sort((a, b) => a - b);
  return { decision, ceiling: decision === 'unchecked' ? null : ceiling, half: halves.length > 0, decidedBy, setup: s.name, strategy: s.component || s.name, direction: s.direction, steps, judgment: steps.filter(x => x.result === 'judgment').map(x => x.step), couldSkip };
}

/** What the priority order's mechanical steps expect at a decision (a skip is judged against the setup the order lets go furthest). */
function expectedDecision(facts) {
  if (!facts.scanned) return { decision: 'unchecked', ceiling: null, decidedBy: 'no scan', ...NONE };
  if (!facts.setups.length) return { decision: 'no-trade', ceiling: 0, decidedBy: 'no setup', ...NONE };
  const each = facts.setups.map(s => setupExpectation(s, facts));
  // The setup the order lets go furthest: a take, else an unchecked, else the first no-trade.
  const rank = { take: 0, unchecked: 1, 'no-trade': 2 };
  return [...each].sort((a, b) => rank[a.decision] - rank[b.decision])[0];
}

/**
 * The expectation an entry is judged against: the setup it traded (the order's setup tag, a policy strategy by its
 * own name, else a component it names) on the side it took; none such: unchecked (no setup at all: no trade).
 */
function expectedForEntry(facts, setupName, side) {
  if (!facts.scanned || facts.setups.length === 0) return expectedDecision(facts);
  const s = facts.setups.find(x => x.direction === side && x.name === setupName) || facts.setups.find(x => x.direction === side && x.component === setupName);
  return s ? setupExpectation(s, facts) : { decision: 'unchecked', ceiling: null, decidedBy: 'no matching setup', ...NONE, setup: setupName || null, direction: side };
}

// ---------------------------------------------------------------------------------------------
// Reasons

const SIDE = { long: 'long', longs: 'long', short: 'short', shorts: 'short' };
// A judgment the order leaves to the model (steps 5 and 7, the strategy's own filters): a ground no fact here can check.
const JUDGMENT = /regime|\badx\b|volatil|chop|range[- ]bound|consolidat|participation|volume|vwap|lunch|extended|pullback|value area|skip rule|context filter|filter|r:r|risk[- ]?reward|no clear|transition|quality|momentum|liquidity|swing (?:high|low)|session (?:high|low)|structure|weak|thin|conviction|confirmation|disagree|divergen|limited room to work|before .*close|reversal at|trend|veto|analyst|risk[- ]manager|phase 1|stand(?:ing)? aside|no edge|opening drive|wait/i;
// Claim detectors, in order: the first kinds are narrower (a nothing-fired "or failed" clause is not a trend claim).
const CLAIMS = [
  ['nothing-fired', /\bor fail|fail(?:ed)? (?:their |its )?triggers?|all (?:rules |strategies |candidates )?failed/i],
  ['no-reversal-fired', /\bno reversal strateg|reversal strategies (?:have )?(?:no |not |failed)/i],
  ['trend-blocks', /trend\b.*\b(?:blocks?|blocking|prohibits?|violation)|\bblocks? (?:all )?trend|blocked by .*trend|against the prevailing trend/i],
  ['no-entry-window', /opening (?:print|blackout)|no[- ]entry window|no entries (?:allowed )?until \d|entries (?:are )?blocked until \d|outside (?:the )?(?:trading )?session|session opens at|into the close/i],
  ['no-attempt', /no (?:prop )?attempt(?: is)? (?:running|active|started)|no active (?:prop )?attempt|attempt (?:is )?not started|until (?:a )?(?:prop )?attempt is started|until started via combine/i],
  ['no-verdict', /no (?:active )?(?:policy )?(?:strategy )?verdict|has no verdict/i],
  ['nothing-fired', /\bno (?:valid )?(?:strategy |strategies |candidate |rules? )*(?:candidates?|strateg(?:y|ies)(?! verdict)|signals?|setups?)\b|\b0 candidates\b|candidates: \[\]|\bnone fired\b|\bno rules fired\b|trigger(?:s)? (?:not (?:fired|met)|conditions (?:are )?not met)|no valid entry trigger/i],
  // Room: "not enough" only in negative words; numbers ("first level 0.35R", "3R vs 2R needed") are read for what they say.
  ['no-room', /insufficient room|not enough room|\bno room\b|limited (?:upside |downside )?room(?! to work)|room requirement|fails? (?:the )?room|lacks? room/i],
  ['room', /first level (?:is )?(?:at )?\d|\d+(?:\.\d+)?R (?:away|vs)|need(?:s)? \d+(?:\.\d+)?R|\d+(?:\.\d+)?R (?:needed|required)|room (?:of |to )?\d/i],
  ['mixed', /mixed (?:alignment|read|multi-timeframe|timeframe)/i],
  ['counter', /counter(?:-trend)? (?:read|alignment)/i],
  ['no-confluence', /no confluence|lone \w+ candidate|single-strategy/i],
  ['entry-block', /cooldown|daily (?:loss )?limit|stand[- ]?down|entries blocked until (?!\d)/i],
];

// The outcome word a CYCLE RESULT starts with (no-trade, blocked, ...): not a reason.
const STATED = /^(?:no-trade|blocked|veto|vetoed|executed|managed|planned|error|done|skip|skipped|hold|held|entered|traded|managing|exited)\b/i;

/** The CYCLE RESULT's stated outcome word and its clauses. */
function clausesOf(text) {
  const body = String(text || '').replace(/^\s*CYCLE RESULT:\s*/i, '').trim();
  const m = /^([a-z][a-z-]*)\s*[-|:\u2013]\s+/i.exec(body) || STATED.exec(body);
  const rest = m ? body.slice(m[0].length) : body;
  const clauses = rest.split(/;|,|\(|\)|\s[-\u2013|]\s|\.\s+|\.$/).map(x => x.trim())
    // A clause with no words (a time, a number) says nothing to check.
    .filter(x => /[a-z]{3,}/i.test(x.replace(/\b(?:ET|CT)\b/g, '')));
  return { stated: m ? m[1] ? m[1].toLowerCase() : m[0].toLowerCase() : null, clauses };
}

const sidesIn = c => [...new Set((c.match(/\b(longs?|shorts?)\b/gi) || []).map(x => SIDE[x.toLowerCase()]))];
const setupNamed = (c, facts) => facts.setups.find(s => new RegExp(`\\b${s.name}\\b|\\b${s.component || '\\0'}\\b`, 'i').test(c)) || null;
const mainSetup = facts => facts.setups.find(s => s.candidate) || facts.setups[0] || null;
const hhmm = s => s.replace(/^(\d):/, '0$1:');

/** One claim checked against the facts: { kind, clause, check: true|false|unchecked, why }. */
function checkClaim(kind, clause, facts) {
  const ok = (v, why) => ({ kind, clause, check: v, why });
  const fired = facts.setups.filter(s => s.candidate);
  if (kind === 'no-entry-window') {
    const w = facts.window;
    if (!w) return ok('unchecked', 'no decision time');
    const until = /until (\d{1,2}:\d{2})/i.exec(clause);
    if (w.entriesAllowed) return ok(false, `the ${w.name} window allows entries (${w.et} ET)`);
    if (until && hhmm(until[1]) !== w.until) return ok(false, `the ${w.name} window ends at ${w.until} ET, not ${until[1]}`);
    return ok(true, `${w.name} until ${w.until} ET`);
  }
  if (!facts.scanned && ['nothing-fired', 'no-reversal-fired', 'trend-blocks', 'no-verdict', 'room', 'no-room', 'mixed', 'counter', 'no-confluence'].includes(kind)) return ok('unchecked', 'no scan recorded for the bar');
  if (kind === 'nothing-fired') return fired.length ? ok(false, `fired: ${fired.map(s => `${s.name} ${s.direction}${s.verdict ? ` (verdict ${s.verdict.action}${s.verdict.maxSize ? ` ${s.verdict.maxSize}` : ''})` : ''}`).join(', ')}`) : ok(true, 'no candidate on the bar');
  if (kind === 'no-reversal-fired') {
    const rev = fired.filter(s => s.style === 'reversal');
    return rev.length ? ok(false, `fired: ${rev.map(s => s.name).join(', ')}`) : ok(true, 'no reversal candidate');
  }
  if (kind === 'trend-blocks') {
    const named = setupNamed(clause, facts);
    const sides = sidesIn(clause);
    const rule = named && named.trendAllows !== null && named.trendAllows !== undefined ? { [named.direction]: named.trendAllows } : facts.trendRule;
    const asked = sides.length ? sides : named ? [named.direction] : ['long', 'short'];
    if (named && named.style === 'reversal') return ok(false, `${named.component || named.name} is a reversal strategy: the trend rule allows it`);
    if (asked.some(x => rule[x] === null || rule[x] === undefined)) return ok('unchecked', 'the trend rule for that side is not recorded');
    const allowed = asked.filter(x => rule[x] === true);
    const res = allowed.length ? ok(false, `the trend rule (${facts.trendRule.prevailing || 'no prevailing trend'}) allows ${allowed.join(' and ')}`) : ok(true, `${facts.trendRule.prevailing}: ${asked.join(' and ')} blocked`);
    return { ...res, sides: asked };
  }
  if (kind === 'no-attempt') {
    if (!facts.attempt) return ok('unchecked', 'no attempt state recorded');
    return facts.attempt.status === 'active' ? ok(false, `the ${facts.attempt.account} attempt is active`) : ok(true, `the attempt is ${facts.attempt.status}`);
  }
  if (kind === 'no-verdict') {
    const v = facts.setups.filter(s => s.verdict);
    return v.length ? ok(false, `verdict: ${v.map(s => `${s.name} ${s.direction} ${s.verdict.action}`).join(', ')}`) : ok(true, 'no verdict on the bar');
  }
  if (kind === 'entry-block') {
    if (facts.attempt && facts.attempt.entryBlock) return ok(true, facts.attempt.entryBlock);
    return ok('unchecked', 'no entry block recorded (a gate cooldown is not in the run\'s records)');
  }
  const s = setupNamed(clause, facts) || mainSetup(facts);
  if (!s) return ok('unchecked', 'no setup on the bar to check it against');
  if (kind === 'room' || kind === 'no-room') return roomClaim(kind, clause, s, ok);
  if (kind === 'mixed' || kind === 'counter') {
    if (!s.alignment || s.alignment === 'unknown') return ok('unchecked', 'the read is unknown');
    return ok(s.alignment === kind, `${s.name} ${s.direction}: ${s.alignment}`);
  }
  // no-confluence: a fact check only; none "changes nothing alone" (step 6), so it is never a ground to skip.
  if (!s.confluence) return ok('unchecked', 'confluence not recorded');
  return ok(s.confluence.with.length === 0, s.confluence.with.length ? `${s.name} with ${s.confluence.with.join(', ')}` : `${s.name}: none with it`);
}

const RNUM = '(\\d+(?:\\.\\d+)?)R';
/**
 * A room claim: negative words ("insufficient room") say the room is short; numbers say what they say: a distance and
 * a need ("0.35R vs 2R needed": short when the distance is under the need, else enough), a distance alone (checked
 * against the first level in its way), a need alone (against the R it needs). Nothing readable: unchecked.
 */
function roomClaim(kind, clause, s, ok) {
  const pick = res => res.map(r => new RegExp(r, 'i').exec(clause)).find(Boolean);
  const x = kind === 'room' ? pick([`first level (?:is )?(?:at )?${RNUM}`, `${RNUM} (?:away|vs)`, `room (?:of |to )?${RNUM}`]) : null;
  const y = kind === 'room' ? pick([`need(?:s)? ${RNUM}`, `vs ${RNUM}`, `${RNUM} (?:needed|required)`]) : null;
  const dist = x ? Number(x[1]) : null;
  const need = y ? Number(y[1]) : null;
  const asserts = kind === 'no-room' || (dist !== null && need !== null && dist < need) ? 'short' : dist !== null && need !== null ? 'enough' : dist !== null ? 'distance' : need !== null ? 'need' : null;
  const res = (check, why) => ({ ...ok(check, why), kind: asserts === 'short' ? 'no-room' : 'room', asserts });
  if (!asserts) return res('unchecked', 'no room figure to read');
  if (!s.room) return res('unchecked', 'the room is unknown');
  const way = s.room.inTheWay;
  const fact = way ? `${s.name}: ${way.name} at ${way.R}R, it needs ${s.room.needR}R` : `${s.name}: no level in its way, it needs ${s.room.needR}R`;
  const short = Boolean(way && way.R < s.room.needR);
  if (asserts === 'short') return res(short, fact);
  if (asserts === 'enough') return res(!short, fact);
  if (asserts === 'need') return res(need === s.room.needR, fact);
  return way ? res(Math.abs(dist - way.R) <= Math.max(0.05, 0.1 * way.R), fact) : res('unchecked', fact);
}

// Claims about a setup: on a bar with none (or about a side none is on) they had no bearing on the decision.
const SETUP_KINDS = new Set(['trend-blocks', 'no-reversal-fired', 'room', 'no-room', 'mixed', 'counter', 'no-confluence']);
function incidental(c, facts) {
  if (!facts.scanned || !SETUP_KINDS.has(c.kind)) return false;
  if (!facts.setups.length) return true;
  if (c.kind === 'trend-blocks' && c.sides) return !c.sides.some(x => facts.setups.some(st => st.direction === x));
  return c.kind === 'no-reversal-fired' && !facts.setups.some(st => st.style === 'reversal');
}

/** Every clause of the result checked: { stated, claims, judgment, unparsed, status: none|confirmed|false|unchecked }. */
function checkReasons(text, facts) {
  const { stated, clauses } = clausesOf(text);
  const claims = [];
  const judgment = [];
  const unparsed = [];
  for (const c of clauses) {
    const kinds = [];
    for (const [kind, re] of CLAIMS) if (re.test(c) && !kinds.includes(kind)) kinds.push(kind);
    // A clause the narrower kinds explain is not also a trend or nothing-fired claim.
    // (an "or failed" clause is not a trend claim, "no reversal strategies" not a nothing-fired one, "until an
    // attempt is started" not an entry block).
    const drop = new Set([...(kinds[0] === 'nothing-fired' ? ['trend-blocks'] : []), ...(kinds.includes('no-reversal-fired') ? ['nothing-fired'] : []), ...(kinds.includes('no-attempt') ? ['entry-block'] : []), ...(kinds.includes('no-room') ? ['room'] : [])]);
    const list = kinds.filter(k => !drop.has(k));
    for (const k of list) {
      const y0 = checkClaim(k, c, facts);
      const x = { ...y0, incidental: incidental(y0, facts) };
      // The same claim twice (two clauses saying it) counts once.
      if (!claims.some(y => y.kind === x.kind && y.check === x.check && y.why === x.why)) claims.push(x);
    }
    if (list.length) continue;
    if (JUDGMENT.test(c)) judgment.push(c);
    else unparsed.push(c);
  }
  const status = claims.some(x => x.check === false) ? 'false' : claims.some(x => x.check === 'unchecked') || unparsed.length ? 'unchecked'
    : claims.length ? 'confirmed' : judgment.length ? 'judgment' : 'none';
  return { stated, claims, judgment, unparsed, status };
}

// ---------------------------------------------------------------------------------------------
// Classification

// Claims that, when true, are grounds to skip (a mechanical step's no trade); no-confluence and mixed alone are not.
const GROUNDS = new Set(['no-entry-window', 'nothing-fired', 'trend-blocks', 'no-attempt', 'no-verdict', 'no-room', 'counter', 'entry-block']);

/** The failure category of a scored decision, and whether it agrees with the expectation (true | false | null). */
function classify(label, facts, expected, reasons) {
  const act = label.teacher ? label.teacher.action : null;
  const why = [];
  const out = (category, agrees) => ({ category, agrees, why });
  // A false claim that had no bearing on the decision (incidental) is reported, never the category.
  const falseReason = reasons.claims.some(x => x.check === false && !x.incidental);
  const notes = (label.clone && label.clone.reasons) || [];
  if (label.cycleFailed || notes.some(r => r === 'no cycle log' || r === 'unattributed order')) return why.push(label.cycleFailed || 'the cycle\'s orders are unknown'), out('unchecked', null);
  if (label.decision === 'in-trade') {
    if (act === 'exit') return earlyClose(label, facts, why, out);
    if (act === 'hold') return why.push('held to the plan'), out(falseReason ? 'wrong stated reason' : 'right', true);
    return why.push(`${act} in a trade: judgment`), out('unchecked', null);
  }
  if (act === 'long' || act === 'short') {
    const o = (label.teacher.orders || []).find(x => x.tool === 'place_order' && !x.riskReducing) || {};
    if (label.gate && label.gate.decision === 'refused') return why.push(`refused by ${label.gate.by || 'the gate'}${label.gate.checks && label.gate.checks.length ? `: ${label.gate.checks.join(', ')}` : ''}`), out('risk-rule rejection', false);
    const style = facts.styleOf(o.setup);
    const same = facts.setups.filter(s => s.direction === act && s.candidate);
    const other = facts.setups.filter(s => s.direction !== act && s.candidate);
    // The trend rule for the setup it traded (a policy's component), else for the strategy it named.
    const own = facts.setups.find(s => (s.name === o.setup || s.component === o.setup) && s.direction === act);
    const ownOther = facts.setups.some(s => (s.name === o.setup || s.component === o.setup) && s.direction !== act);
    const against = own ? own.style !== 'reversal' && own.trendAllows === false : style === 'trend' && facts.trendRule[act] === false;
    if (style === 'manual') return why.push('a manual strategy: its trigger is the model\'s'), out('unchecked', null);
    if ((!own && ownOther) || (!same.length && other.length) || against) return why.push(against ? `the trend rule blocks ${act}s` : `the setup was ${other[0].direction}`), out('wrong-side entry', false);
    if (expected.decision === 'unchecked') return why.push(`expected unchecked (${typeof expected.decidedBy === 'number' ? `step ${expected.decidedBy}` : expected.decidedBy})`), out('unchecked', null);
    const size = num((label.teacher.size || {}).contracts) || num(o.size);
    if (expected.ceiling === 0) return why.push(`the order says no trade (${expected.decidedBy === 'no setup' ? 'no setup' : `step ${expected.decidedBy}`})`), out('bad size', false);
    if (expected.ceiling !== null && size !== null && size > expected.ceiling) return why.push(`${size} over the ceiling ${expected.ceiling}`), out('bad size', false);
    if (expected.couldSkip && expected.couldSkip.length) return why.push(`step ${expected.couldSkip.join(', ')} is judgment that can say no trade`), out('unchecked', null);
    if (expected.ceiling === null || size === null) why.push('the size ceiling is unknown (no verdict size): side checked only');
    return out(falseReason ? 'wrong stated reason' : 'right', true);
  }
  if (act !== 'none' || notes.some(r => NOT_A_DECISION.has(r))) return why.push(notes.join(', ') || 'not an entry or a skip'), out('unchecked', null);
  // A skip (or standing aside with nothing to take).
  if (expected.decision === 'no-trade') return out(falseReason ? 'wrong stated reason' : 'right', true);
  if (expected.decision === 'unchecked') return why.push(`expected unchecked (${typeof expected.decidedBy === 'number' ? `step ${expected.decidedBy}` : expected.decidedBy})`), out('unchecked', null);
  if (expected.couldSkip && expected.couldSkip.length) {
    why.push(`step ${expected.couldSkip.join(', ')} is judgment that can say no trade`);
    return out(falseReason ? 'wrong stated reason' : 'unchecked', null);
  }
  const grounds = reasons.claims.filter(x => x.check === true && GROUNDS.has(x.kind));
  const judged = reasons.judgment.length > 0 || reasons.claims.some(x => x.check === 'unchecked');
  if (grounds.length) return why.push(`a true ground the facts missed: ${grounds.map(x => x.kind).join(', ')}`), out('unchecked', null);
  if (judged) return why.push('skipped on judgment (steps 5 and 7 are the model\'s)'), out('unchecked', null);
  if (reasons.unparsed.length && !falseReason) return why.push('its reasons are not parsed'), out('unchecked', null);
  why.push(falseReason ? 'its grounds are false' : 'no ground stated');
  return out('excessive abstention', false);
}

/**
 * An exit the model sent in a trade. Early close only when the plan's exit is known not reached: the trade's best was
 * under the trail's activation (else the target) and it was neither a partial exit (a scale-out), past the time stop,
 * nor a give-back of most of a large best (1R or more): those are the plan's management, judgment.
 */
function earlyClose(label, facts, why, out) {
  const o = label.outcome || {};
  const notes = (label.clone && label.clone.reasons) || [];
  const judged = msg => (why.push(msg), out('unchecked', null));
  if (notes.includes('partial exit') || (label.teacher.orders || []).some(x => x.tool === 'partial_close_position')) return judged('a partial exit (scale-out): judgment');
  const plan = facts.planOf ? facts.planOf(o.setup) : null;
  if (!plan || num(o.mfeR) === null || num(o.r) === null) return judged('the plan or the trade\'s excursion is unknown');
  const held = o.entryTime ? (Date.parse(facts.t) - Date.parse(o.entryTime)) / 60000 : null;
  if (plan.maxBars && held !== null && held >= plan.maxBars * plan.minutes) return judged(`past the time stop (${plan.maxBars} bars)`);
  if (o.mfeR >= 1 && o.r <= o.mfeR / 2) return judged(`gave back most of a ${o.mfeR}R best`);
  const reach = plan.trailActivateR ?? plan.targetR;
  if (reach === null || reach === undefined) return judged('the plan has no R exit to compare');
  if (o.mfeR >= reach) return judged(`the plan's ${reach}R was reached: managing it is judgment`);
  why.push(`closed at ${o.r}R, its best ${o.mfeR}R, before the plan's ${reach}R`);
  return out('early close', false);
}

// ---------------------------------------------------------------------------------------------
// Facts

/** The run's own records, read once. */
function runRecords(home, { strategies, outcomeBars, tf, cfg }) {
  const scans = new Map();
  let files = [];
  try { files = fs.readdirSync(path.join(home, 'logs')).filter(n => /^scans-.*\.jsonl$/.test(n)).sort(); } catch (_err) { /* none */ }
  for (const f of files) {
    for (const s of readLines(path.join(home, 'logs', f))) {
      if (!isObj(s) || !isObj(s.bar) || !s.symbol) continue;
      const k = `${s.symbol}|${s.bar.t}`;
      if (!scans.has(k)) scans.set(k, []);
      scans.get(k).push(s);
    }
  }
  const verdicts = new Map();
  for (const v of readLines(path.join(home, 'policy-verdicts.jsonl'))) {
    if (!isObj(v) || !v.symbol || !v.bar) continue;
    const k = `${v.symbol}|${v.bar}|${v.strategy}`;
    if (!verdicts.has(k)) verdicts.set(k, []);
    verdicts.get(k).push(v);
  }
  const byName = new Map((strategies || []).filter(x => x && x.name).map(x => [x.name, x]));
  const bars = new Map();
  const barsFor = sym => {
    if (!bars.has(sym)) bars.set(sym, outcomeBars && Array.isArray(outcomeBars[sym]) ? outcomeBars[sym].map(b => ({ ...b, ms: b.ms ?? Date.parse(b.t) })) : loadBars(home, sym, tf));
    return bars.get(sym);
  };
  return { scans, verdicts, byName, barsFor, blackouts: readBlackouts(path.join(home, 'blackouts', 'blackouts.json')), count: Number(cfg.bars) > 0 ? Number(cfg.bars) : tf ? historyBars(tf) : 0 };
}

const before = (list, t) => (list || []).filter(x => Date.parse(x.at) <= t).pop() || null;

/** The briefing's candidates and alignment for the bar, rebuilt from the bars closed by it; null without them. */
function briefingAt(rec, { symbol, barT, t, scan, tf }) {
  const all = rec.barsFor(symbol);
  const i = all.findIndex(b => b.t === barT || b.ms === Date.parse(barT));
  if (i < 2 || !tf) return null;
  const style = r => { const s = rec.byName.get(r.name); return s && s.mtf ? s.mtf : null; };
  // The runner's scan results, as far as the log keeps them: a rules candidate's exit and min R:R from its strategy.
  const results = scan.results.filter(isObj).map(r => {
    const s = rec.byName.get(r.name);
    const rules = s && s.signal !== 'policy';
    return { ...r, ...(rules ? { minRR: s.risk ? s.risk.min_rr : undefined, exit: exitPlan(s), status: s.status } : {}), ...(r.mtf ? { mtf: { ...r.mtf, style: style(r) || 'trend' } } : {}) };
  });
  try {
    const b = buildBriefing({ symbol, contractId: scan.contractId || null, bars: all.slice(Math.max(0, i + 1 - rec.count), i + 1).map(({ ms: _ms, ...x }) => x), minutes: tf, scan: results, blackouts: rec.blackouts, now: new Date(t) });
    return { candidates: b.sections.m3.data.candidates || [], alignment: b.sections.m15.data.alignment || {} };
  } catch (_err) {
    return null;
  }
}

/** The facts at one decision: window, setups (with the trend rule, room, read, confluence), trend rule per side, attempt. */
function factsAt(label, rec, { home, tf, accounts }) {
  const t = Date.parse(label.t);
  const win = sessionWindow(new Date(t));
  const facts = {
    t: label.t, et: etClock(t), window: { name: win.name, until: etClock(win.until.getTime()), et: etClock(t), entriesAllowed: !NO_ENTRY.test(win.name) },
    scanned: false, setups: [], trendRule: { prevailing: null, long: null, short: null }, attempt: null, rebuilt: false,
    styleOf: name => { const s = rec.byName.get(name); return s ? (s.signal === 'manual' ? 'manual' : s.mtf || null) : null; },
    // A strategy's exit plan and bar size (its max_bars count in its own bars).
    planOf: name => { const s = rec.byName.get(name); return s && s.risk ? { ...exitPlan(s), minutes: parseInt(s.timeframe, 10) || tf } : null; },
  };
  const scan = before(rec.scans.get(`${label.symbol}|${label.barT}`), t);
  if (scan && Array.isArray(scan.results)) {
    facts.scanned = true;
    const results = scan.results.filter(isObj);
    // The trend rule per side, for trend strategies: blocked when any trend strategy's record says so.
    for (const r of results.filter(x => isObj(x.mtf) && facts.styleOf(x.name) !== 'reversal')) {
      facts.trendRule.prevailing = facts.trendRule.prevailing || r.mtf.prevailing || null;
      for (const side of ['long', 'short']) {
        const v = r.mtf[`${side}Allowed`];
        if (typeof v === 'boolean') facts.trendRule[side] = facts.trendRule[side] === false ? false : v;
      }
    }
    const tradeable = new Set((label.candidates || []).map(c => `${c.name}|${c.direction}`));
    const briefing = results.some(r => r.direction && (r.candidate || r.verdict)) ? briefingAt(rec, { symbol: label.symbol, barT: label.barT, t, scan, tf }) : null;
    facts.rebuilt = Boolean(briefing);
    for (const r of results.filter(x => x.direction && (x.verdict || x.candidate))) {
      const policy = Boolean(r.verdict) || (rec.byName.get(r.name) || {}).signal === 'policy';
      if (!policy && !tradeable.has(`${r.name}|${r.direction}`)) continue;
      const v = policy ? before(rec.verdicts.get(`${label.symbol}|${label.barT}|${r.name}`), t) : null;
      const component = v ? v.component : null;
      const own = component ? results.find(x => x.name === component) || {} : r;
      const mtf = isObj(own.mtf) ? own.mtf : {};
      const pm = /^(\S+) (up|down)$/.exec(String(mtf.prevailing || facts.trendRule.prevailing || ''));
      const bc = briefing ? briefing.candidates.find(x => x.name === r.name && x.direction === r.direction) : null;
      const conf = isObj(own.confluence) ? { with: own.confluence.with || [], against: own.confluence.against || [] } : null;
      facts.setups.push({
        name: r.name, component, policy, direction: r.direction, candidate: Boolean(r.candidate) && (policy || tradeable.has(`${r.name}|${r.direction}`)),
        style: facts.styleOf(component || r.name), stopPoints: num(r.stopDistance),
        verdict: r.verdict || v ? { action: (v || r.verdict).action, maxSize: num((v || r.verdict).maxSize), contract: (v || r.verdict).contract || null, stopTicks: v ? num(v.stopTicks) : null, reason: (v || r.verdict).reason || null } : null,
        trendAllows: typeof mtf[`${r.direction}Allowed`] === 'boolean' ? mtf[`${r.direction}Allowed`] : facts.trendRule[r.direction],
        prevailing: pm ? { label: pm[1], trend: pm[2] } : null,
        room: bc && bc.needR !== undefined && num(bc.stopPoints) > 0 ? { inTheWay: bc.inTheWay ? { name: bc.inTheWay.name, R: bc.inTheWay.R } : null, needR: bc.needR } : null,
        alignment: briefing ? briefing.alignment[r.direction] || 'unknown' : null,
        confluence: conf, blocked: bc ? bc.blocked || null : null, vwapSide: bc ? bc.vwapSide : null, lunch: /lunch/.test(win.name),
        verdictCombine: v && isObj(v.combine) ? v.combine : null,
      });
    }
  }
  facts.attempt = attemptAt(label, facts, { home, accounts });
  return facts;
}

/** The attempt as the cycle's context showed it (else the verdict's), with the daily-limit headroom and the balance check. */
function attemptAt(label, facts, { home, accounts }) {
  const file = label.provenance && label.provenance.cycleFile;
  const doc = file && file.startsWith('logs/cycles/') ? readJson(path.join(home, file), null) : null;
  const ctx = isObj(doc) && isObj(doc.context) ? doc.context : null;
  const a = (ctx && Array.isArray(ctx.attempts) && ctx.attempts.find(isObj)) || (facts.setups.find(s => s.verdictCombine) || {}).verdictCombine || null;
  if (!a) return ctx && Array.isArray(ctx.attempts) ? { account: null, status: 'none' } : null;
  const profile = (accounts || []).find(x => x.name === a.account) || null;
  const limit = profile && profile.daily_loss_limit > 0 ? profile.daily_loss_limit : null;
  const soft = profile && profile.daily_loss_soft > 0 ? profile.daily_loss_soft : null;
  const block = a.entryBlock || null;
  return {
    account: a.account || null, status: a.status || 'unknown', balance: num(a.balance), floor: num(a.floor), cushion: num(a.cushion), profit: num(a.profit), target: num(a.target),
    dayPnl: num(a.dayPnl), sessionsLeft: num(a.sessionsLeft), entryBlock: block,
    dailyHeadroom: limit !== null && num(a.dayPnl) !== null ? round(limit + a.dayPnl) : null,
    softHeadroom: soft !== null && num(a.dayPnl) !== null ? round(soft + a.dayPnl) : null,
    balanceCheck: !('entryBlock' in a) ? 'unknown' : /doesn't reconcile/.test(block || '') ? 'mismatch' : /couldn't be checked/.test(block || '') ? 'error' : /snapshot is missing or older/.test(block || '') ? 'stale' : 'ok',
  };
}

// ---------------------------------------------------------------------------------------------
// Run and summary

function scoreRun(runDir, { strategies = [], accounts = [], outcomeBars = null, unfinished = false } = {}) {
  const dir = realDir(runDir);
  const home = path.resolve(dir, '..', '..');
  const cfg = readJson(path.join(dir, 'autotrader.json'), {}) || {};
  const tf = Number(cfg.timeframe) || null;
  const run = readRun(dir);
  const why = unfinishedWhy(run.manifest, run.days);
  if (why && !unfinished) throw new Error(`run ${run.manifest.runId} is not finished (${why}): run it to its end first, or write the scorecard outside the run home with --out <dir> (it holds what came after each decision, which a resumed run could read)`);
  const { labels, summary: ls } = labelRun(dir, { strategies, outcomeBars, unfinished });
  const rec = runRecords(home, { strategies, outcomeBars, tf, cfg });
  const records = [];
  const notScored = {};
  for (const label of labels) {
    if (label.decision !== 'flat' && label.decision !== 'in-trade') {
      notScored[label.decision] = (notScored[label.decision] || 0) + 1;
      continue;
    }
    const facts = factsAt(label, rec, { home, tf, accounts });
    const act = label.teacher ? label.teacher.action : null;
    const expected = label.decision === 'in-trade' ? { decision: 'hold', ceiling: null, decidedBy: 'in a trade', ...NONE }
      : act === 'long' || act === 'short' ? expectedForEntry(facts, label.teacher.setup, act) : expectedDecision(facts);
    const reasons = checkReasons(label.result, facts);
    const verdict = classify(label, facts, expected, reasons);
    const o = label.outcome;
    const { styleOf: _styleOf, planOf: _planOf, ...plainFacts } = facts;
    records.push({
      v: VERSION, key: label.key, t: label.t, day: label.day, symbol: label.symbol, barT: label.barT, decision: label.decision,
      facts: { ...plainFacts, setups: facts.setups.map(({ verdictCombine: _vc, ...s }) => s) },
      expected,
      actual: { action: label.teacher ? label.teacher.action : null, setup: label.teacher ? label.teacher.setup : null, size: label.teacher && label.teacher.size ? label.teacher.size.contracts : null, gate: label.gate, result: label.result },
      reasons, incidentalFalse: reasons.claims.filter(c => c.check === false && c.incidental).length, agrees: verdict.agrees, category: verdict.category, why: verdict.why,
      trade: o && o.filled ? { result: o.result, r: o.r, net: o.net, side: o.side, size: o.size, exitReason: o.exitReason } : null,
      counterfactual: label.counterfactualFor === 'skip' && label.counterfactual ? { strategy: label.counterfactual.strategy, direction: label.counterfactual.direction, simulated: label.counterfactual.simulated, result: label.counterfactual.result, R: label.counterfactual.R, net: label.counterfactual.net, reason: label.counterfactual.reason } : null,
      pacing: facts.attempt,
    });
  }
  return { records, summary: summarize(records, { runId: ls.runId, unfinished: ls.unfinished, notScored, labels: ls }) };
}

const rate = (a, b) => (b ? round(a / b, 4) : null);
function tally(records, keyOf) {
  const out = {};
  for (const r of records) {
    const k = String(keyOf(r));
    const row = out[k] || (out[k] = { decisions: 0, agree: 0, disagree: 0, unchecked: 0 });
    row.decisions += 1;
    if (r.agrees === true) row.agree += 1; else if (r.agrees === false) row.disagree += 1; else row.unchecked += 1;
  }
  for (const row of Object.values(out)) row.rate = rate(row.agree, row.agree + row.disagree);
  return Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
}

const stepKey = r => (typeof r.expected.decidedBy === 'number' ? `${r.expected.decidedBy} ${STEPS[r.expected.decidedBy - 1]}`
  : r.expected.decidedBy === 'take' && r.expected.couldSkip && r.expected.couldSkip.length ? `take or judgment (step ${r.expected.couldSkip.join(', ')})` : r.expected.decidedBy);

function summarize(records, { runId, unfinished, notScored, labels }) {
  const categories = Object.fromEntries(CATEGORIES.map(c => [c, records.filter(r => r.category === c).length]));
  const claims = records.flatMap(r => r.reasons.claims);
  const byKind = {};
  for (const c of claims) {
    const row = byKind[c.kind] || (byKind[c.kind] = { true: 0, false: 0, unchecked: 0, incidentalFalse: 0 });
    row[c.check === true ? 'true' : c.check === false ? 'false' : 'unchecked'] += 1;
    if (c.check === false && c.incidental) row.incidentalFalse += 1;
  }
  // Decision-relevant claims, and the incidental ones (about a setup the bar didn't have), rated apart.
  const relevant = c => !c.incidental && (c.check === true || c.check === false);
  const checkable = records.filter(r => r.reasons.claims.some(relevant));
  const checkableInc = records.filter(r => r.reasons.claims.some(x => x.incidental && (x.check === true || x.check === false)));
  const trades = records.filter(r => r.trade && r.decision === 'flat').map(r => ({ t: r.t, setup: r.actual.setup, side: r.trade.side, size: r.trade.size, result: r.trade.result, r: r.trade.r, net: r.trade.net, category: r.category }));
  const skipped = records.filter(r => r.decision === 'flat' && r.actual.action === 'none' && r.facts.setups.some(s => s.candidate))
    .map(r => ({ t: r.t, setup: r.expected.setup, expected: r.expected.decision, category: r.category, counterfactual: r.counterfactual }));
  const sum = (xs, k) => round(xs.reduce((a, x) => a + (num(x[k]) || 0), 0), 4);
  const cfs = skipped.map(s => s.counterfactual).filter(c => c && c.simulated);
  const days = {};
  for (const r of records) {
    const d = days[r.day] || (days[r.day] = { day: r.day, decisions: 0, agree: 0, disagree: 0, balance: null, dayPnl: null, floor: null, cushion: null, dailyHeadroom: null, balanceCheck: null });
    d.decisions += 1;
    if (r.agrees === true) d.agree += 1; else if (r.agrees === false) d.disagree += 1;
    if (r.pacing && r.pacing.balance !== null && r.pacing.balance !== undefined) Object.assign(d, { balance: r.pacing.balance, dayPnl: r.pacing.dayPnl, floor: r.pacing.floor, cushion: r.pacing.cushion, dailyHeadroom: r.pacing.dailyHeadroom, balanceCheck: r.pacing.balanceCheck });
  }
  const all = tally(records, () => 'all').all || { decisions: 0, agree: 0, disagree: 0, unchecked: 0, rate: null };
  return {
    v: VERSION, runId, unfinished: unfinished || null, decisions: records.length, notScored,
    agreement: { overall: all, byStep: tally(records, stepKey), byStrategy: tally(records, r => r.expected.strategy || r.actual.setup || 'none') },
    categories,
    reasons: {
      claims: claims.length, true: claims.filter(c => c.check === true).length, false: claims.filter(c => c.check === false).length, unchecked: claims.filter(c => c.check === 'unchecked').length,
      judgmentClauses: records.reduce((a, r) => a + r.reasons.judgment.length, 0), unparsedClauses: records.reduce((a, r) => a + r.reasons.unparsed.length, 0),
      falseIncidental: claims.filter(c => c.check === false && c.incidental).length,
      wrongReasonRate: rate(checkable.filter(r => r.reasons.claims.some(x => x.check === false && !x.incidental)).length, checkable.length),
      incidentalWrongRate: rate(checkableInc.filter(r => r.reasons.claims.some(x => x.check === false && x.incidental)).length, checkableInc.length), byKind: Object.fromEntries(Object.keys(byKind).sort().map(k => [k, byKind[k]])),
    },
    trades: { list: trades, n: trades.length, wins: trades.filter(x => x.result === 'win').length, losses: trades.filter(x => x.result === 'loss').length, sumR: sum(trades, 'r'), net: sum(trades, 'net') },
    skipped: { list: skipped, n: skipped.length, simulated: cfs.length, wouldWin: cfs.filter(c => c.result === 'win').length, wouldLose: cfs.filter(c => c.result === 'loss').length, sumR: sum(cfs, 'R'), net: sum(cfs, 'net') },
    days: Object.keys(days).sort().map(k => days[k]),
    labels: { noCycleWithCandidates: labels.noCycleWithCandidates, noCycleWouldWin: labels.noCycleWouldWin, noCycleWouldLose: labels.noCycleWouldLose },
  };
}

const pct = x => (x === null || x === undefined ? '-' : `${Math.round(x * 1000) / 10}%`);
const cell = x => (x === null || x === undefined ? '-' : String(x).replace(/\|/g, '\\|'));
const row = (k, x) => `| ${cell(k)} | ${x.decisions} | ${x.agree} | ${x.disagree} | ${x.unchecked} | ${pct(x.rate)} |`;

/** The short Markdown report. */
function toMarkdown(s, records) {
  const head = '| | decisions | agree | disagree | unchecked | agreement |\n| --- | ---: | ---: | ---: | ---: | ---: |';
  const flagged = records.filter(r => r.category !== 'right' && r.category !== 'unchecked');
  return [
    `# Adherence scorecard: ${s.runId}`, '',
    s.unfinished ? `The run is not finished (${s.unfinished}): this covers what it has done.\n` : '',
    `${s.decisions} decisions scored; agreement ${pct(s.agreement.overall.rate)} of those the facts decide (${s.agreement.overall.unchecked} unchecked). Not scored: ${Object.entries(s.notScored).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`, '',
    '## Agreement by priority-order step', '', head, ...Object.entries(s.agreement.byStep).map(([k, x]) => row(k, x)), '',
    '## Agreement by strategy', '', head, ...Object.entries(s.agreement.byStrategy).map(([k, x]) => row(k, x)), '',
    '## Failure categories', '', '| category | decisions |', '| --- | ---: |', ...Object.entries(s.categories).map(([k, v]) => `| ${k} | ${v} |`), '',
    '## Stated reasons', '',
    `${s.reasons.claims} checkable claims: ${s.reasons.true} true, ${s.reasons.false} false (${s.reasons.falseIncidental} incidental: about a setup the bar didn't have), ${s.reasons.unchecked} unchecked; ${s.reasons.judgmentClauses} judgment clauses, ${s.reasons.unparsedClauses} unparsed. Wrong-reason rate ${pct(s.reasons.wrongReasonRate)} of the decisions with a decision-relevant checked claim; incidental ${pct(s.reasons.incidentalWrongRate)}.`, '',
    '| claim | true | false | of which incidental | unchecked |', '| --- | ---: | ---: | ---: | ---: |', ...Object.entries(s.reasons.byKind).map(([k, x]) => `| ${k} | ${x.true} | ${x.false} | ${x.incidentalFalse} | ${x.unchecked} |`), '',
    '## Trades and skipped setups', '',
    `${s.trades.n} trades: ${s.trades.wins} won, ${s.trades.losses} lost, ${s.trades.sumR}R, $${s.trades.net}. ${s.skipped.n} skipped setups: ${s.skipped.simulated} simulated, ${s.skipped.wouldWin} would have won, ${s.skipped.wouldLose} lost, ${s.skipped.sumR}R, $${s.skipped.net}.`, '',
    '## Account by day', '', '| day | decisions | agree | disagree | balance | day P&L | floor | cushion | daily headroom | balance check |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...s.days.map(d => `| ${d.day} | ${d.decisions} | ${d.agree} | ${d.disagree} | ${cell(d.balance)} | ${cell(d.dayPnl)} | ${cell(d.floor)} | ${cell(d.cushion)} | ${cell(d.dailyHeadroom)} | ${cell(d.balanceCheck)} |`), '',
    '## Flagged decisions', '', flagged.length ? '| time (ET) | category | expected | actual | why | false reasons |\n| --- | --- | --- | --- | --- | --- |' : 'None.',
    ...flagged.map(r => `| ${r.day} ${r.facts.et} | ${r.category} | ${r.expected.decision}${r.expected.setup ? ` ${r.expected.setup}` : ''} | ${r.actual.action}${r.actual.size ? ` ${r.actual.size}` : ''} | ${cell(r.why.join('; '))} | ${cell(r.reasons.claims.filter(c => c.check === false).map(c => `"${c.clause}": ${c.why}${c.incidental ? ' (incidental)' : ''}`).join('; '))} |`),
    '',
  ].filter(x => x !== null).join('\n');
}

/** Writes scorecard.jsonl, scorecard-summary.json and scorecard.md: the run's folder (finished), else --out outside the run home. */
function writeScorecard(runDir, { root = null, strategies = [], accounts = [], barsFiles = {}, outDir = null } = {}) {
  const dir = realDir(runDir);
  const out = outDir ? path.resolve(expandHome(outDir)) : dir;
  const home = path.resolve(dir, '..', '..');
  if (root && (inside(dir, root) || inside(out, root))) throw new Error(`${inside(out, root) ? out : dir} is inside the repository (${root}): the scorecard is written to the run's own folder or --out, never the repository`);
  if (outDir && inside(out, home)) throw new Error(`--out ${out} is inside the run home (${home}): write the scorecard of an unfinished run outside it`);
  const tf = Number((readJson(path.join(dir, 'autotrader.json'), {}) || {}).timeframe) || null;
  if (Object.keys(barsFiles).length && !tf) throw new Error(`${dir}: no runner timeframe (autotrader.json) to read the bars at`);
  const outcomeBars = Object.fromEntries(Object.entries(barsFiles).map(([sym, f]) => [sym, outcomeBarsFrom(f, tf)]));
  // What came after each decision (outcomes, counterfactuals) never goes where a resumed run could read it.
  const { records, summary } = scoreRun(dir, { strategies, accounts, outcomeBars: Object.keys(outcomeBars).length ? outcomeBars : null, unfinished: Boolean(outDir) });
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'scorecard.jsonl');
  fs.writeFileSync(`${file}.${process.pid}.tmp`, records.map(r => `${JSON.stringify(r)}\n`).join(''));
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
  writeJsonAtomic(path.join(out, 'scorecard-summary.json'), summary);
  fs.writeFileSync(path.join(out, 'scorecard.md'), toMarkdown(summary, records));
  return { file, summary };
}

const summaryText = s => `${s.decisions} decisions: agreement ${pct(s.agreement.overall.rate)} (${s.agreement.overall.agree} agree, ${s.agreement.overall.disagree} disagree, ${s.agreement.overall.unchecked} unchecked)\n`
  + `categories: ${Object.entries(s.categories).map(([k, v]) => `${k} ${v}`).join(', ')}\n`
  + `reasons: ${s.reasons.claims} claims, ${s.reasons.false} false (${s.reasons.falseIncidental} incidental); wrong-reason rate ${pct(s.reasons.wrongReasonRate)} (incidental ${pct(s.reasons.incidentalWrongRate)})\n`
  + `trades ${s.trades.n} (${s.trades.sumR}R, $${s.trades.net}); skipped setups ${s.skipped.n} (would win ${s.skipped.wouldWin}, lose ${s.skipped.wouldLose})\n`;

module.exports = { VERSION, CATEGORIES, STEPS, scoreRun, writeScorecard, summaryText, toMarkdown, checkReasons, expectedDecision, expectedForEntry, classify, clausesOf };
