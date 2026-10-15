'use strict';

/**
 * Stated reasons checked against the facts, and the decision the priority order's mechanical steps expect from those
 * facts (strategy-library, "The priority order: the rule for every setup"). One checker for two callers:
 *   - the adherence scorecard (replay/scorecard.js), which rebuilds the facts of a replayed decision from the run's
 *     records and scores the reasons the model stated;
 *   - the reason_check harness tool (harness-tools/reasons.js), which the risk manager and the head trader call before
 *     they approve, veto or skip, with the facts of the bar they decide (factsFromBriefing).
 *
 * The facts: { window: { name, until, et, entriesAllowed } | null, news: { inBlackout, until, reason, error } | null, scanned, setups: [{ name, component, policy,
 * direction, candidate, style, verdict, trendAllows, prevailing, room: { inTheWay, needR }, alignment, confluence,
 * blocked, vwapSide, lunch, composed? }], trendRule: { prevailing, long, short }, attempt: { account, status, entryBlock } | null }.
 * Anything unknown is null, and a claim about it is `unchecked`, never confirmed.
 *
 * A composed setup (trade_lifecycle: the cycle's latest OK compose record on a side, `composed` set) is judged on its
 * own record, never the strategy priority order: step 1 (a no-entry window, a news blackout), its verified reads, its
 * plan; take at most the record's stated size (the composed-entry design, section 5).
 *
 *   checkReasons(text, facts)            each clause's claims: true | false | unchecked, judgment, unparsed
 *   expectedDecision(facts), expectedForEntry(facts, setup, side), setupSteps(setup, facts)   the priority order
 *   factsFromBriefing(briefing, { attempts, verdicts, composed, root })   the facts of a live bar: its briefing, the
 *                                                       started attempts, the policy verdicts and the family's compose
 *                                                       records on it (root: the contract the check is for)
 *   composedSetup(record, { window, news, aliases }), composedSetupsFrom(records, ctx)   a compose record (lifecycle-runner.js
 *                                                       recordSummary) as a setup; the latest OK one per side; aliases:
 *                                                       the policies listing the composed strategy (an entry's tag)
 *   tagged(setup, name)                  whether an entry tagged `name` is on the setup
 *   reasonCheck(text, facts)             checkReasons plus every setup's steps, one by one
 *   renderCheck(result)                  the check as text, for the roles
 */

const STEPS = ['hard stops', 'trend rule', 'room', 'multi-timeframe read', 'skip rules', 'confluence', 'secondary context'];

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const etClock = ms => ET.format(new Date(ms));

// ---------------------------------------------------------------------------------------------
// Expected decision

/**
 * A composed setup's steps (the composed-entry design, section 5): not the strategy priority order but its own record.
 * Step 1 (a no-entry window or news blackout) still decides; then each verified read of the record, then its plan (the
 * code's entry, stop, target and the stated size, the ceiling an entry on it is held to).
 */
function composedSteps(s) {
  const c = s.composed;
  // A policy's verdict on the record (prop/composed-verdict.js) that skips it is a hard stop too.
  const skip = s.verdict && s.verdict.action === 'skip' ? `the verdict is skip${s.verdict.reason ? ` (${s.verdict.reason})` : ''}` : null;
  const stop = s.blocked || skip;
  const out = [{ step: 1, name: STEPS[0], result: stop ? 'no-trade' : 'pass', why: stop || 'no hard stop' }];
  for (const r of c.reads) out.push({ step: r.step || 'read', name: r.skill || 'read', result: 'pass', why: `${r.read || ''} (verified by compose_check)`.trim() });
  out.push({ step: 'plan', name: 'plan', result: 'pass', why: `record ${c.record}: limit ${c.entry ?? '?'}, stop ${c.stop ?? '?'}, target ${c.target ?? '?'}, R:R ${c.rr ?? '?'}, size ${c.size ?? '?'}` });
  return out;
}

/**
 * The cycle's composed setup on one side (trade_lifecycle): the latest compose record for the side (the one the gate
 * judges), when it is OK (every read verified, the plan standing); else none. `rec` is a record as the cycle log and the
 * decision history keep it (lifecycle-runner.js recordSummary). A no-entry window or a news blackout blocks it (step 1).
 */
function composedSetup(rec, { window = null, news = null, aliases = [] } = {}) {
  if (!isObj(rec) || rec.ok !== true || (rec.side !== 'long' && rec.side !== 'short')) return null;
  const entry = num(rec.entry);
  const stop = num(rec.stop);
  const rr = num(rec.rr);
  const way = isObj(rec.inTheWay) ? { name: rec.inTheWay.name, R: num(rec.inTheWay.R) } : null;
  // As the briefing blocks a candidate: a no-entry window, a news blackout, or news that can't be read (the gate refuses).
  const blocked = isObj(window) && window.entriesAllowed === false ? `the ${window.name} window allows no entries`
    : isObj(news) && news.inBlackout === true ? `a news blackout${news.reason ? ` (${news.reason})` : ''}`
      : isObj(news) && news.inBlackout !== false ? `news unknown${news.error ? ` (${news.error})` : ''}` : null;
  return {
    // trade-lifecycle.js's STRATEGY, required here: it requires composed-reads.js, which requires this module at load.
    name: require('./trade-lifecycle').STRATEGY, component: null, policy: false, direction: rec.side, candidate: true, style: 'composed',
    stopPoints: entry !== null && stop !== null ? Math.abs(entry - stop) : null, verdict: null, trendAllows: null, prevailing: null,
    // The room as the record states it: the first level in the way and its R against the plan's R:R (an older record
    // without the field: unknown).
    room: 'inTheWay' in rec && rr !== null ? { inTheWay: way, needR: rr } : null,
    alignment: null, confluence: null, blocked, vwapSide: null, lunch: false,
    // The setup tags an entry on it goes under besides its own name: a policy listing the composed strategy (in an
    // attempt every entry is tagged with the policy), from the strategies' own lists (lifecycle-runner.js composedSetups).
    aliases: [...new Set((Array.isArray(aliases) ? aliases : []).filter(a => typeof a === 'string' && a))],
    composed: {
      record: rec.id || null, signature: rec.signature || null, entry, stop, target: num(rec.target), rr, size: Number.isInteger(rec.size) ? rec.size : null,
      reads: (Array.isArray(rec.reads) ? rec.reads : []).filter(isObj).map(r => ({ step: r.step || null, skill: r.skill || null, read: r.read || null })),
    },
  };
}

/** Whether an entry tagged `name` is on setup s: its name, its component, or (a composed setup) a policy listing it. */
const tagged = (s, name) => Boolean(name) && (s.name === name || s.component === name || (Boolean(s.composed) && Array.isArray(s.aliases) && s.aliases.includes(name)));

/**
 * The composed setups of a family's records on a bar (recordSummary shape), in record order: the latest per side across
 * the family (the one the gate judges), when OK and, given `root`, on that contract (a size stated for one contract is
 * not one for another of the family: the gate refuses it).
 */
function composedSetupsFrom(records, { root = null, ...ctx } = {}) {
  const latest = new Map();
  for (const r of Array.isArray(records) ? records : []) if (isObj(r) && (r.side === 'long' || r.side === 'short')) latest.set(r.side, r);
  // The record's contract: its symbol, else its contract (as the gate reads it).
  const on = r => { const sym = r.symbol || r.contract; return !root || (Boolean(sym) && String(sym).toUpperCase() === root); };
  return [...latest.values()].filter(on).map(r => composedSetup(r, ctx)).filter(Boolean);
}

/** One setup's steps of the priority order: [{ step, name, result: pass|no-trade|half|judgment|unknown, why }]. */
function setupSteps(s, facts) {
  if (s.composed) return composedSteps(s);
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
  const against = (s.confluence && s.confluence.against.length ? s.confluence.against : []).concat(facts.setups.filter(x => x !== s && x.candidate && !x.composed && x.direction !== s.direction).map(x => x.name));
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
  if (s.composed) {
    // Judged on its own plan: a hard stop says no trade; else take, at most the record's stated size (and the policy
    // verdict's size, when one sized it).
    const stop = steps.find(x => x.result === 'no-trade');
    const max = s.verdict ? num(s.verdict.maxSize) : null;
    const size = s.composed.size;
    return {
      decision: stop ? 'no-trade' : 'take', ceiling: stop ? 0 : size !== null && max !== null ? Math.min(size, max) : size, half: false, decidedBy: stop ? stop.step : 'take', setup: s.name, strategy: s.name,
      direction: s.direction, steps, judgment: [], couldSkip: [], composed: s.composed.record,
    };
  }
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
  // No scan: the rules setups are unknown, so a pass can't be judged (an entry on a composed setup still is: expectedForEntry).
  if (!facts.scanned) return { decision: 'unchecked', ceiling: null, decidedBy: 'no scan', ...NONE };
  if (!facts.setups.length) return { decision: 'no-trade', ceiling: 0, decidedBy: 'no setup', ...NONE };
  const each = facts.setups.map(s => setupExpectation(s, facts));
  // The setup the order lets go furthest: a clean take (no judgment step can turn it down), else a take a judgment
  // step can turn down, else an unchecked, else the first no-trade. A couldSkip excuses a skip only when every take has one.
  // A composed take ranks after a rules take a judgment step can turn down: a pass is excused on the rules setup's own
  // terms first, never made right by the model's composing beside it.
  // ...and after an unchecked rules setup: knowing less about the scan never makes a pass more surely right.
  const rank = e => (e.decision === 'take' ? (e.composed !== undefined ? 2.5 : e.couldSkip.length ? 1 : 0) : e.decision === 'unchecked' ? 2 : 3);
  return [...each].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * The expectation an entry is judged against: the setup it traded (the order's setup tag, a policy strategy by its
 * own name, else a component it names) on the side it took; none such: unchecked (no setup at all: no trade).
 */
function expectedForEntry(facts, setupName, side) {
  // A composed entry is judged on its own record, whether or not the bar's scan was logged.
  const composed = facts.setups.find(x => x.composed && x.direction === side && tagged(x, setupName));
  if (composed) return setupExpectation(composed, facts);
  // An entry under a composed tag (facts.composedTags, the scorecard's) with no OK record on its side has no setup.
  if (setupName === require('./trade-lifecycle').STRATEGY || (facts.composedTags || []).includes(setupName)) return { decision: 'no-trade', ceiling: 0, decidedBy: 'no setup', ...NONE, setup: setupName, direction: side };
  // Any other entry is judged on the scan's setups alone: a compose record beside it is no setup of its own.
  const rules = facts.setups.filter(x => !x.composed);
  if (!facts.scanned || rules.length === 0) return expectedDecision({ ...facts, setups: rules });
  const s = rules.find(x => x.direction === side && x.name === setupName) || rules.find(x => x.direction === side && x.component === setupName);
  return s ? setupExpectation(s, facts) : { decision: 'unchecked', ceiling: null, decidedBy: 'no matching setup', ...NONE, setup: setupName || null, direction: side };
}

// ---------------------------------------------------------------------------------------------
// Reasons

const SIDE = { long: 'long', longs: 'long', short: 'short', shorts: 'short' };
// A judgment the order leaves to the model (steps 5 and 7, the strategy's own filters): a ground no fact here can check.
const JUDGMENT = /regime|\badx\b|volatil|chop|range[- ]bound|consolidat|participation|volume|vwap|lunch|extended|pullback|value area|skip rule|context filter|filter|r:r|risk[- ]?reward|no clear|transition|quality|momentum|liquidity|swing (?:high|low)|session (?:high|low)|structure|weak|thin|conviction|confirmation|disagree|divergen|limited room to work|before .*close|reversal at|trend|veto|analyst|risk[- ]manager|phase 1|stand(?:ing)? aside|no edge|opening drive|wait/i;
// Session timing (the June replays' misreads), as present-tense claims about the window only: the session or market
// "is closed" (not "the prior session closed above", "market closed higher"), "still in premarket" (not "the premarket
// high"), a clause that starts "opens 18:00" or a session or market that opens at a time, "10:48 ET < 18:00 ET open",
// "before the 18:00 session open" (not "before the 9:30 open", a level's time). On an entry's result (executed, entered)
// a window claim is never a ground: it is unchecked there (checkReasons), so a level's description is never called false.
const TIMING = String.raw`(?<!\b(?:prior|previous|yesterday's|last|overnight|asia|london|friday|monday|thursday|wednesday|tuesday|nq|es|mnq|mes|eth|globex|asian|european) )\b(?:session|markets?) (?:is |are |still )?closed\b(?! (?:above|below|near|higher|lower|up|down|strong|weak|bullish|bearish|flat|\d))|(?:still|we're|we are|(?:session|markets?)(?: is| are)?(?: still)?)(?: in)? (?:the )?pre-?market\b(?! (?:high|low|range|level))|^\s*(?:re)?opens (?:at )?\d{1,2}:\d{2}(?!\s*(?:ET\s*)?(?:range|high|low|print|open))|(?<!(?:rth|eth|asian?|london|european|globex|overnight|ny|new york|cash|futures) )\b(?:the )?(?:session|markets?) (?:re)?opens (?:at )?\d{1,2}:\d{2}|<\s*\d{1,2}:\d{2}(?:\s*ET)?\s*open|before (?:the )?\d{1,2}:\d{2}(?:\s*ET)? session open`;
// Claim detectors, in order: the first kinds are narrower (a nothing-fired "or failed" clause is not a trend claim).
const CLAIMS = [
  ['nothing-fired', /\bor fail|fail(?:ed)? (?:their |its )?triggers?|all (?:rules |strategies |candidates )?failed/i],
  ['no-reversal-fired', /\bno reversal strateg|reversal strategies (?:have )?(?:no |not |failed)/i],
  ['trend-blocks', /trend\b.*\b(?:blocks?|blocking|prohibits?|violation)|\bblocks? (?:all )?trend|blocked by .*trend|against the prevailing trend/i],
  ['no-entry-window', new RegExp(String.raw`opening (?:print|blackout)|no[- ]entry window|no entries (?:allowed )?until \d|entries (?:are )?blocked until \d|outside (?:the )?(?:trading )?session|session opens at|${TIMING}|into the close|news blackout|in a (?:news )?blackout`, 'i')],
  ['verdict-skip', /verdict (?:is |was |says |action (?:is )?)?:?\s*skip|skip verdict|(?:policy|verdict) skipped|skipped by (?:the )?(?:policy|verdict)/i],
  ['no-attempt', /no (?:prop )?attempt(?: is)? (?:running|active|started)|\bno [a-z0-9]+_[a-z0-9_]+ attempt\b|no active (?:prop )?attempt|attempt (?:is )?not started|until (?:a )?(?:prop )?attempt is started|until started via combine/i],
  ['no-verdict', /no (?:active )?(?:policy )?(?:strategy )?verdict|has no verdict/i],
  ['nothing-fired', /\bno (?:valid )?(?:strategy |strategies |candidate |rules? )*(?:candidates?|strateg(?:y|ies)(?! verdict)|signals?|setups?)\b|\b0 candidates\b|candidates: \[\]|\bnone fired\b|\bno rules fired\b|trigger(?:s)? (?:not (?:fired|met)|conditions (?:are )?not met)|no valid entry trigger/i],
  // Room: "not enough" only in negative words; numbers ("first level 0.35R", "3R vs 2R needed") are read for what they say.
  ['no-room', /insufficient room|not enough room|\bno room\b(?! (?:concerns?|issues?|problems?|worries|constraints?|for concern))|limited (?:upside |downside )?room(?! to work)|room requirement|fails? (?:the )?room|lacks? room/i],
  ['room', /first level (?:is )?(?:at )?\d|\d+(?:\.\d+)?R (?:away|vs)|need(?:s)? \d+(?:\.\d+)?R|\d+(?:\.\d+)?R (?:needed|required)|room (?:of |to )?\d/i],
  ['mixed', /mixed (?:alignment|read|multi-timeframe|timeframe)/i],
  ['counter', /counter(?:-trend)? (?:read|alignment)/i],
  ['no-confluence', /no confluence|lone \w+ candidate|single-strategy/i],
  ['entry-block', /cooldown|daily (?:loss )?limit|stand[- ]?down|entries blocked until (?!\d)/i],
];

// The outcome words of an entry.
const ENTERED = /^(?:executed|entered|traded)$/i;
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

const WINDOW_NAMED = new RegExp(String.raw`opening (?:print|blackout)|no[- ]entry window|outside (?:the )?(?:trading )?session|session opens at|${TIMING}|into the close|daily break`, 'i');
const OTHER_GROUND = /news|blackout|\bcpi\b|fomc|\bnfp\b|cooldown|loss[- ]streak|daily (?:loss )?limit|stand[- ]?down/i;
const sidesIn = c => [...new Set((c.match(/\b(longs?|shorts?)\b/gi) || []).map(x => SIDE[x.toLowerCase()]))];
const setupNamed = (c, facts) => facts.setups.find(s => new RegExp(`\\b${s.name}\\b|\\b${s.component || '\\0'}\\b`, 'i').test(c)) || null;
const mainSetup = facts => facts.setups.find(s => s.candidate) || facts.setups[0] || null;
const hhmm = s => s.replace(/^(\d):/, '0$1:');

/** One claim checked against the facts: { kind, clause, check: true|false|unchecked, why }. */
function checkClaim(kind, clause, facts, text = clause) {
  const ok = (v, why) => ({ kind, clause, check: v, why });
  // What fired: the scan's candidates and the policy verdicts; a composed setup is the model's own record, never a
  // strategy that fired (the runner's "no rules strategy fired" stays true beside one).
  const fired = facts.setups.filter(s => s.candidate && !s.composed);
  if (kind === 'no-entry-window') {
    const w = facts.window;
    const news = isObj(facts.news) ? facts.news : null;
    // A clause naming a session window is about the window; any other no-entry ground (news, a cooldown, a limit),
    // named in the clause or beside it in the same result ("entries blocked until 10:30 (cooldown)"), the window
    // can't refute.
    const window = WINDOW_NAMED.test(clause);
    const other = !window && OTHER_GROUND.test(text);
    if (!window && news && news.inBlackout === true) return ok(true, `a news blackout is in force${news.until ? ` until ${etClock(Date.parse(news.until))} ET` : ''}${news.reason ? ` (${news.reason})` : ''}`);
    if (!window && news && news.inBlackout === null && news.error) return ok(true, news.error);
    if (!w) return ok('unchecked', 'no decision time');
    const until = /until (\d{1,2}:\d{2})/i.exec(clause);
    if (w.entriesAllowed && other) return ok('unchecked', `the ${w.name} window allows entries (${w.et} ET)${news && news.inBlackout === false ? ' and no news blackout is in force' : ''}; a gate cooldown or limit isn't among these facts`);
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
    const tag = res => ({ ...res, named: named ? named.name : null });
    const sides = sidesIn(clause);
    const rule = named && named.trendAllows !== null && named.trendAllows !== undefined ? { [named.direction]: named.trendAllows } : facts.trendRule;
    const asked = sides.length ? sides : named ? [named.direction] : ['long', 'short'];
    if (named && named.style === 'reversal') {
      // A reversal fading the prevailing trend: step 2 allows it only at a higher-timeframe level, at half size (judgment).
      const p = named.prevailing;
      if (p && p.trend === (named.direction === 'long' ? 'down' : 'up')) return tag(ok('unchecked', `${named.component || named.name} is a reversal fading the ${p.label} ${p.trend} trend: step 2 decides it (only at a higher-timeframe level, half size)`));
      return tag(ok(false, `${named.component || named.name} is a reversal strategy, not fading the trend: the trend rule allows it`));
    }
    if (asked.some(x => rule[x] === null || rule[x] === undefined)) return tag({ ...ok('unchecked', 'the trend rule for that side is not recorded'), sides: asked });
    const allowed = asked.filter(x => rule[x] === true);
    const res = allowed.length ? ok(false, `the trend rule (${facts.trendRule.prevailing || 'no prevailing trend'}) allows ${allowed.join(' and ')}`) : ok(true, `${facts.trendRule.prevailing}: ${asked.join(' and ')} blocked`);
    return tag({ ...res, sides: asked });
  }
  if (kind === 'no-attempt') {
    if (!facts.attempt) return ok('unchecked', 'no attempt state recorded');
    // An account named ("no topstep_100k attempt"): that account's attempt, from the started ones when the facts list them.
    const named = (/\bno ([a-z0-9]+_[a-z0-9_]+) attempt\b/i.exec(clause) || [])[1];
    if (named && named !== facts.attempt.account) {
      if (!Array.isArray(facts.attempts)) return ok('unchecked', `the facts hold the ${facts.attempt.account || 'no'} attempt, not ${named}'s`);
      const a = facts.attempts.find(x => x.account === named);
      return a && a.status === 'active' ? ok(false, `the ${named} attempt is active`) : ok(true, `no ${named} attempt is running${a ? ` (it is ${a.status})` : ''}`);
    }
    return facts.attempt.status === 'active' ? ok(false, `the ${facts.attempt.account} attempt is active`) : ok(true, `the attempt is ${facts.attempt.status}`);
  }
  if (kind === 'no-verdict') {
    const v = facts.setups.filter(s => s.verdict);
    return v.length ? ok(false, `verdict: ${v.map(s => `${s.name} ${s.direction} ${s.verdict.action}`).join(', ')}`) : ok(true, 'no verdict on the bar');
  }
  if (kind === 'verdict-skip') {
    const named = setupNamed(clause, facts);
    const v = facts.setups.filter(x => x.verdict && (!named || x.name === named.name || x.component === named.name));
    // None found: unchecked, never false (a verdict the facts don't hold may still be the one the model was shown).
    if (!v.length) return ok('unchecked', 'no verdict on the bar in these facts');
    const skip = v.filter(x => x.verdict.action === 'skip');
    return skip.length ? ok(true, `verdict: ${skip.map(x => `${x.name} ${x.direction} skip${x.verdict.reason ? ` (${x.verdict.reason})` : ''}`).join(', ')}`)
      : ok(false, `verdict: ${v.map(x => `${x.name} ${x.direction} ${x.verdict.action}${x.verdict.maxSize ? ` ${x.verdict.maxSize}` : ''}`).join(', ')}`);
  }
  if (kind === 'entry-block') {
    if (facts.attempt && facts.attempt.entryBlock) return ok(true, facts.attempt.entryBlock);
    return ok('unchecked', 'the attempt blocks no entries; a gate cooldown or limit isn\'t among these facts');
  }
  const s = setupNamed(clause, facts) || mainSetup(facts);
  if (!s) return ok('unchecked', 'no setup on the bar to check it against');
  // Which setup the claim was checked against (named in the clause, else the bar's main one).
  const about = { about: s.name };
  if (kind === 'room' || kind === 'no-room') return { ...roomClaim(kind, clause, s, ok), ...about };
  if (kind === 'mixed' || kind === 'counter') {
    if (!s.alignment || s.alignment === 'unknown') return { ...ok('unchecked', 'the read is unknown'), ...about };
    return { ...ok(s.alignment === kind, `${s.name} ${s.direction}: ${s.alignment}`), ...about };
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

/**
 * Every clause of the result checked: { stated, claims, judgment, unparsed, status: none|confirmed|false|unchecked }.
 * `entered`: whether the decision was an entry (the scorecard knows it from the orders); null reads it from the outcome word.
 */
function checkReasons(text, facts, { entered = null } = {}) {
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
      const y1 = checkClaim(k, c, facts, text);
      // An entry's result: a window claim is no ground for it (only for not trading), so it is never scored false.
      const y0 = k === 'no-entry-window' && (entered === null ? ENTERED.test(stated || '') : entered) && y1.check === false ? { ...y1, check: 'unchecked', why: `an entry's result: a window claim is no ground for it (${y1.why})` } : y1;
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
// The facts of a live bar

const sectionData = (b, name) => (isObj(b) && isObj(b.sections) && isObj(b.sections[name]) && isObj(b.sections[name].data) ? b.sections[name].data : {});

/** The trend rule per side from the briefing's `Trend rule:` line (mtf.js ruleLine); unknown sides null. */
function trendRuleOf(line) {
  const text = String(line || '');
  const m = /prevailing trend (\S+ (?:up|down)); trend strategies may not go (long|short)/.exec(text);
  if (m) return { prevailing: m[1], long: m[2] !== 'long', short: m[2] !== 'short' };
  if (/no trend on /.test(text)) return { prevailing: null, long: true, short: true };
  if (/trend strategies can't enter yet/.test(text)) return { prevailing: null, long: false, short: false };
  return { prevailing: null, long: null, short: null };
}

/** A briefing candidate's facts as a setup (the scorecard's shape). */
function setupOf(c, { prevailing, rule, alignment, lunch }) {
  const pm = /^(\S+) (up|down)$/.exec(String(prevailing || ''));
  const conf = isObj(c.confluence) ? { with: c.confluence.with || [], against: c.confluence.against || [] } : null;
  return {
    name: c.name, component: null, policy: false, direction: c.direction, candidate: true,
    style: c.trendRule === 'reversal' ? 'reversal' : c.trendRule ? 'trend' : null, stopPoints: num(c.stopPoints), verdict: null,
    trendAllows: c.trendRule === 'allows' ? true : c.trendRule === 'against' ? false : rule[c.direction] ?? null,
    prevailing: pm ? { label: pm[1], trend: pm[2] } : null,
    room: c.needR !== undefined && c.needR !== null && num(c.stopPoints) > 0 ? { inTheWay: c.inTheWay ? { name: c.inTheWay.name, R: c.inTheWay.R } : null, needR: c.needR } : null,
    alignment: c.alignment || alignment[c.direction] || 'unknown',
    confluence: conf, blocked: c.blocked || null, vwapSide: c.vwapSide ?? null, lunch,
  };
}

/**
 * The facts of the bar a cycle decides, as the roles were given them: the bar briefing (the window and whether it
 * allows entries, the trend rule, the candidates with their room and read, the alignment), the policy verdicts on
 * that bar, and the started attempts (combine_status's rows: { account, started, status, entryBlock }; null: unknown).
 * A verdict joins its own setup when the briefing lists it, else takes its component's facts on its side.
 */
function factsFromBriefing(b, { attempts = null, verdicts = [], composed = [], root = null } = {}) {
  const m3 = sectionData(b, 'm3');
  const alignment = isObj(sectionData(b, 'm15').alignment) ? sectionData(b, 'm15').alignment : {};
  const rule = trendRuleOf(m3.trendRule);
  const until = Number.isFinite(Date.parse(m3.windowUntil)) ? etClock(Date.parse(m3.windowUntil)) : null;
  const window = m3.window && until && (m3.windowEntries === 'allowed' || m3.windowEntries === 'none')
    ? { name: m3.window, until, et: m3.et || null, entriesAllowed: m3.windowEntries === 'allowed' } : null;
  const ctx = { prevailing: rule.prevailing, rule, alignment, lunch: /lunch/.test(String(m3.window || '')) };
  const scanned = Array.isArray(m3.candidates);
  const setups = scanned ? m3.candidates.filter(c => isObj(c) && c.name && c.direction).map(c => setupOf(c, ctx)) : [];
  // Fill a side the line leaves unknown from what the candidates say for it.
  for (const s of setups) if (rule[s.direction] === null && s.style === 'trend') rule[s.direction] = s.trendAllows;
  // The compose records on the bar (recordSummary shape): the latest OK one per side is a composed setup.
  const composedSetups = composedSetupsFrom(composed, { window, news: isObj(m3.news) ? m3.news : null, root });
  for (const v of (verdicts || []).filter(x => isObj(x) && x.strategy && x.direction)) {
    const verdict = { action: v.action, maxSize: num(v.maxSize), contract: v.contract || null, stopTicks: num(v.stopTicks), reason: v.reason || null };
    // A policy's verdict on a compose record (prop/composed-verdict.js: its component the composed strategy, or the
    // record named) is that composed setup's verdict, never a setup of its own (nothing fired for it).
    if (v.record || v.component === require('./trade-lifecycle').STRATEGY) {
      const c = composedSetups.find(s => s.direction === v.direction && (!v.record || s.composed.record === v.record));
      if (c) Object.assign(c, { verdict, aliases: [...new Set([...c.aliases, v.strategy])] });
      continue;
    }
    const own = setups.find(s => s.name === v.strategy && s.direction === v.direction);
    // A verdict is the policy's setup on the bar (a skip too: step 1 decides it), as the scan lists it.
    const comp = setups.find(s => s.name === v.component && s.direction === v.direction && !s.policy);
    if (own) Object.assign(own, { policy: true, component: v.component || null, verdict, candidate: true });
    else {
      setups.push({ ...(comp || { style: null, stopPoints: null, trendAllows: rule[v.direction], prevailing: null, room: null, alignment: alignment[v.direction] || 'unknown', confluence: null, blocked: null, vwapSide: null, lunch: ctx.lunch }),
        name: v.strategy, component: v.component || null, policy: true, direction: v.direction, candidate: true, verdict });
    }
    // The briefing holds the scan before the runner's screen: a component a policy owns trades only through its verdict.
    if (comp) Object.assign(comp, { candidate: false, blocked: `traded through ${v.strategy} (its verdict decides)` });
  }
  setups.push(...composedSetups);
  const rows = Array.isArray(attempts) ? attempts.filter(r => isObj(r) && r.started) : null;
  const a = rows ? rows.find(r => r.status === 'active') || rows[0] || null : null;
  const attempt = !rows ? null : a ? { account: a.account || null, status: a.status || 'unknown', entryBlock: a.entryBlock || null } : { account: null, status: 'none', entryBlock: null };
  const started = rows ? rows.map(r => ({ account: r.account || null, status: r.status || 'unknown' })) : null;
  return { t: b && b.closedAt ? b.closedAt : null, et: m3.et || null, window, news: isObj(m3.news) ? m3.news : null, scanned, setups, trendRule: rule, attempt, attempts: started };
}

// ---------------------------------------------------------------------------------------------
// The check a role runs

/** checkReasons on a stated decision (a CYCLE RESULT line, a VERDICT line, or the reasons alone), and every setup's steps. */
function reasonCheck(text, facts) {
  const r = checkReasons(String(text || '').replace(/^\s*VERDICT:\s*/i, ''), facts);
  const steps = (facts.setups || []).map(s => ({ setup: s.name, direction: s.direction, ...(s.composed ? { composed: s.composed.record } : {}), steps: setupSteps(s, facts).map(({ step, name, result, why }) => ({ step, name, result, why })) }));
  return { ...r, steps, falseCount: r.claims.filter(c => c.check === false).length };
}

const WORD = { true: 'TRUE', false: 'FALSE', unchecked: 'UNCHECKED' };

/** The check as text: each claim with its fact, the clauses it can't check, each setup's steps, and what to do. */
function renderCheck(r) {
  const out = ['Reasons checked against this bar\'s facts:'];
  for (const c of r.claims) out.push(`- ${WORD[String(c.check)]} ${c.kind}: "${c.clause}" - ${c.why}${c.incidental ? ' (about a setup or side the bar doesn\'t have)' : ''}`);
  for (const c of r.judgment) out.push(`- JUDGMENT "${c}": yours to weigh (no fact here checks it)`);
  for (const c of r.unparsed) out.push(`- UNPARSED "${c}": no fact recognized; check it yourself against the briefing`);
  if (!r.claims.length && !r.judgment.length && !r.unparsed.length) out.push('- no reason stated to check');
  out.push(r.steps.length ? 'The priority order, step by step, as the facts answer it:' : 'The priority order: no setup on this bar (no candidate, no verdict).');
  for (const s of r.steps) out.push(`- ${s.setup} ${s.direction}${s.composed !== undefined ? ` (composed: its record's reads and plan, not a strategy's priority order)` : ''}: ${s.steps.map(x => `${x.step} ${x.name} ${x.result} (${x.why})`).join('; ')}`);
  out.push(r.falseCount ? `${r.falseCount} reason${r.falseCount === 1 ? '' : 's'} FALSE: ${r.falseCount === 1 ? 'name it, drop it' : 'name each, drop them'}, and make the decision again from the facts.`
    : 'No reason is false by these facts; an UNCHECKED or UNPARSED one is still yours to check.');
  return `${out.join('\n')}\n`;
}

module.exports = {
  STEPS, NONE, setupSteps, setupExpectation, composedSetup, composedSetupsFrom, tagged, expectedDecision, expectedForEntry, clausesOf, checkClaim, checkReasons,
  trendRuleOf, factsFromBriefing, reasonCheck, renderCheck,
};
