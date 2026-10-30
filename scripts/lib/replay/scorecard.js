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
 *   logs/cycles/<day>/*.json        the cycle's context: the attempt (balance, floor, cushion, entry block), and its
 *                                   compose records (`composed`: the composed setups)
 *   bars/, bars-scratch/ (or --bars) the bars closed by the decision: the briefing rebuilt with the
 *                                   runner's own code (trading/briefing.js) for the room and the
 *                                   multi-timeframe read of each setup, as the model was given them
 *   blackouts/blackouts.json        the news blackouts (the briefing's `blocked`)
 *
 * Expected decision, per setup (a rules candidate or a policy verdict), step by step:
 *   1 hard stops    a no-entry window or news blackout (the briefing's `blocked`), a skip verdict,
 *                   the attempt's entry block  -> no trade
 *   2 trend rule    a trend strategy against it -> no trade; a reversal fading it -> judgment, half
 *   3 room          the first level ahead before the R it aims for -> judgment (a read, never a no trade)
 *   4 mtf read      aligned -> full; mixed -> half; counter (non-reversal) -> no trade; pullback -> judgment
 *   5 skip rules    judgment (the strategy's own text)
 *   6 confluence    a setup on the other side -> no trade
 *   7 secondary     the VWAP on the other side, the lunch lull -> judgment (may halve)
 * The highest step that says no trade decides; else a step it can't compute (no bars, no scan)
 * leaves it `unchecked`; else `take`, at most the verdict's size (halved once, floor; 0 is no trade).
 * With no setup on the bar the expectation is no trade ('no setup').
 *
 * A composed setup (trade_lifecycle: the cycle's latest OK compose record on a side) is judged on its own record
 * (trading/reasons.js composedSetup), not these steps: a no-entry window or news blackout says no trade; else take, at
 * most the record's stated size. An entry on it is right within that size, a bad size over it; a pass on it is right
 * (a good decision by default; a wrong stated reason when a reason is false), and a pass with no OK record is no trade
 * ('no setup'). An entry tagged with a policy that lists a composed strategy is on the composed setup.
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
 * On top of the category (failures.js): its severity, the session-timing misreads among the false claims, the field
 * check of a setup whose rules read broker fields against the values the decision line recorded (R35; an entry the
 * scan did not list whose own field conditions fail is a wrong-side entry or a bad size), the claim checks the cycle
 * recorded (R29) when it did (else "not checked"), and what the record lacks (values absent or failed, the archive
 * failed or pruned): counted, never filled in. The flagged decisions (flagged.jsonl, flagged.md) are what a
 * self-review reads: what the model saw (pointers into the record), what it did, what the code found.
 *
 * Deterministic: the same files give the same scorecard.
 *
 *   SCORES_COMPOSED                      true: composed setups are graded on their record (the training preflight reads it)
 *   scoreRun(runDir, { strategies, accounts, outcomeBars, unfinished })   { records, summary }
 *   writeScorecard(runDir, { root, strategies, accounts, barsFiles, outDir })  scorecard.jsonl, scorecard-summary.json, scorecard.md,
 *                                                                             flagged.jsonl, flagged.md
 *   checkReasons(text, facts), expectedDecision(facts), classify(label, facts, expected, reasons)   the pure steps
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../harness-run');
// A close that gave back most of its best is judgment, not an early close (config/replay.json scorecard).
const GIVE_BACK = require('../tunables').replay().scorecard;
const { readLines, readRun } = require('./store');
const { labelRun, composedTagsAt, countedEntry, loadBars, inside, realDir, unfinishedWhy, configsOf, outcomeBarsFor, outcomeFor } = require('./labels');
const { buildBriefing, sessionWindow, newsState, htfTrendsOf } = require('../trading/briefing');
const { readBlackouts } = require('../trading/check-order');
const { loadRoundSteps } = require('../trading/round-numbers');
const { exitPlan, composedExit } = require('../trading/evaluator');
const { recordedBars } = require('../autotrader');
const { expandHome } = require('../paths');
const { STEPS, NONE, expectedDecision, expectedForEntry, checkReasons, clausesOf, composedSetupsFrom, tagged } = require('../trading/reasons');
const { familyRoot } = require('../trading/contracts');
const { parseStandardName } = require('../broker/translator');
const { STRATEGY: COMPOSED } = require('../trading/trade-lifecycle');
const F = require('./failures');
const { checkLook } = require('../prop/looks');
const { readLedger, appendLook, withLedgerLock } = require('../prop/ledger-file');
const { roleOf } = require('../prop/splits');
const { learningLook } = require('../learning/scorecard-look');
const { setupMoment } = require('../learning/setup-moments');
const { standardPlans } = require('../learning/setup-library');
const { trendRuleOf } = require('../trading/reasons');

const VERSION = 1;
// This scorecard grades composed setups on their own compose record (the training preflight checks for it).
const SCORES_COMPOSED = true;
const CATEGORIES = ['right', 'wrong-side entry', 'bad size', 'early close', 'excessive abstention', 'wrong stated reason', 'risk-rule rejection', 'unchecked'];
// Labels whose flat silence is no skip (labels.js NOT_A_SKIP): the model touched an order, or what it did is unknown.
const NOT_A_DECISION = new Set(['order cancel', 'working-order change', 'exit while flat', 'unattributed order', 'no cycle log', 'cycle failed', 'cycle timed out', 'working order', 'manage-only', 'paper mode', 'policy screen failed']);

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const round = (x, d = 2) => (num(x) === null ? null : Number(x.toFixed(d)));
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const etClock = ms => ET.format(new Date(ms));

// The expectation (the priority order's mechanical steps) and the reason checker: trading/reasons.js, shared with the
// reason_check harness tool, so a cycle's roles check their reasons by the same rules the scorecard scores them.

// ---------------------------------------------------------------------------------------------
// Classification

// Claims that, when true, are grounds to skip (a mechanical step's no trade); no-confluence, mixed and the room
// (a read, never a no trade alone) are not.
const GROUNDS = new Set(['no-entry-window', 'nothing-fired', 'trend-blocks', 'no-attempt', 'no-verdict', 'verdict-skip', 'counter', 'entry-block']);
// The grounds that pass a valid composed setup (an OK record): the hard ones its record doesn't already hold.
const COMPOSED_GROUNDS = new Set(['no-entry-window', 'trend-blocks', 'no-attempt', 'verdict-skip', 'entry-block']);
// The decisive read against the side (confluence-counting): a real HTF reversal, a 1h CHoCH against it, but only while
// the 4h and the 1h do not both trend the side (both its way, the CHoCH is context: the CHoCH study found no edge in
// passing on it). A 15m swing broken is serious (half), never a pass.
const DECISIVE = /\b1h (?:choch|change of character)\b|\b(?:choch|change of character) (?:on|of) the 1h\b/i;

/** Whether the 4h and the 1h both trend the side's way at the decision (facts.htf, briefing.js htfTrendsOf); unknown: false. */
const htfAgrees = (htf, side) => {
  const way = side === 'long' ? 'up' : side === 'short' ? 'down' : null;
  return Boolean(way && isObj(htf) && htf['4h'] === way && htf['1h'] === way);
};

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
    // The entry the label counts (a refused try before it is one decision with it).
    const o = countedEntry(label.teacher.orders) || {};
    if (label.gate && label.gate.decision === 'refused') return why.push(`refused by ${label.gate.by || 'the gate'}${label.gate.checks && label.gate.checks.length ? `: ${label.gate.checks.join(', ')}` : ''}`), out('risk-rule rejection', false);
    const style = facts.styleOf(o.setup);
    // A composed setup is the side an entry on it must take; any other entry's sides are the scan's setups alone.
    const composedTag = o.setup === COMPOSED || (facts.composedTags || []).includes(o.setup) || facts.setups.some(s => s.composed && tagged(s, o.setup));
    const pool = composedTag ? facts.setups.filter(s => s.composed) : facts.setups.filter(s => !s.composed);
    const same = pool.filter(s => s.direction === act && s.candidate);
    const other = pool.filter(s => s.direction !== act && s.candidate);
    // The trend rule for the setup it traded (a policy's component), else for the strategy it named.
    // From the same pool: an entry under a composed tag has no rules setup of its own, and the gate judges it against the
    // trend by its reads (no scan's trend rule).
    const own = pool.find(s => tagged(s, o.setup) && s.direction === act);
    const ownOn = pool.find(s => tagged(s, o.setup) && s.direction !== act);
    const against = own ? own.trendAllows === false : !composedTag && style !== 'manual' && facts.trendRule[act] === false;
    if (style === 'manual') return why.push('a manual strategy: its trigger is the model\'s'), out('unchecked', null);
    if ((!own && ownOn) || (!same.length && other.length) || against) return why.push(against ? `the trend rule blocks ${act}s` : `the setup was ${(ownOn || other[0]).direction}`), out('wrong-side entry', false);
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
  // A composable setup (trend side, a reaction at a key level, the trigger closed) passed without compose_check: the
  // model judged room or R:R itself instead of the plan (confluence-counting: compose first).
  if (expected.decision === 'no-trade' && expected.decidedBy === 'no setup' && facts.composable && facts.composable.valid) {
    // A true hard ground (an entry block, no attempt, a verdict's skip, the window, the trend rule) passes it, as it
    // passes an OK record; so does the attempt's own entry block, stated or not.
    const hard = reasons.claims.filter(x => x.check === true && COMPOSED_GROUNDS.has(x.kind));
    if (hard.length) return why.push(`a true hard ground: ${hard.map(x => x.kind).join(', ')}`), out('unchecked', null);
    if (facts.attempt && facts.attempt.entryBlock) return why.push(`the attempt blocks entries (${facts.attempt.entryBlock})`), out('right', true);
    why.push(`no compose: ${facts.composable.sides.join(' and ')} ${facts.composable.reason}, passed without compose_check`);
    return out(falseReason ? 'wrong stated reason' : 'excessive abstention', false);
  }
  if (expected.decision === 'no-trade') return out(falseReason ? 'wrong stated reason' : 'right', true);
  if (expected.decision === 'unchecked') return why.push(`expected unchecked (${typeof expected.decidedBy === 'number' ? `step ${expected.decidedBy}` : expected.decidedBy})`), out('unchecked', null);
  // A pass on an OK compose record: a valid setup (every read verified, the plan standing) is the trade (the owner's
  // decision, 2026-10-21: confluence-counting); only a decisive reason passes it: a true hard ground the record can't
  // see (an entry block, a verdict's skip, the trend rule), or a 1h CHoCH against stated (which no claim kind checks:
  // unchecked) while the 4h and the 1h do not both trend the side (both its way, or unknown: decisive stands; both its
  // way at the decision, facts.htf: context). Soft reads, or none, are excessive abstention.
  if (expected.composed !== undefined) {
    const hard = reasons.claims.filter(x => x.check === true && COMPOSED_GROUNDS.has(x.kind));
    if (hard.length) return why.push(`a true hard ground: ${hard.map(x => x.kind).join(', ')}`), out('unchecked', null);
    if ([...reasons.judgment, ...reasons.unparsed].some(c => DECISIVE.test(c))) {
      if (!htfAgrees(facts.htf, expected.direction)) return why.push('a decisive reason stated (a 1h CHoCH against): checked by hand'), out('unchecked', null);
      why.push('a 1h CHoCH against stated while the 4h and the 1h both trend the side: context, not decisive');
    }
    why.push(`a valid setup (the verified compose record ${expected.composed}) passed without a decisive reason`);
    return out(falseReason ? 'wrong stated reason' : 'excessive abstention', false);
  }
  if (expected.couldSkip && expected.couldSkip.length) {
    why.push(`step ${expected.couldSkip.join(', ')} is judgment that can say no trade`);
    return out(falseReason ? 'wrong stated reason' : 'unchecked', null);
  }
  // A true claim excuses the skip only when it bears on the setup the order says take: not incidental, and about
  // that setup (a named one, or the setup it was checked against) or its side; the bar-wide ones (window, nothing
  // fired, attempt, verdict, entry block) always do.
  // (An incidental claim is about a side or setup the bar didn't have, so it never matches.)
  const bears = c => {
    if (c.kind === 'trend-blocks') return c.named ? c.named === expected.setup : (c.sides || []).includes(expected.direction);
    if (c.about !== undefined) return c.about === expected.setup;
    return true;
  };
  const grounds = reasons.claims.filter(x => x.check === true && GROUNDS.has(x.kind) && bears(x));
  // An unverifiable claim excuses a skip only when it bears on the expected setup too (an unchecked claim about
  // another setup is no more a ground than a true one); judgment clauses (steps 5, 7) are bar-wide.
  const judged = reasons.judgment.length > 0 || reasons.claims.some(x => x.check === 'unchecked' && bears(x));
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
  if (o.mfeR >= GIVE_BACK.giveBackMinMfeR && o.r <= o.mfeR * GIVE_BACK.giveBackShare) return judged(`gave back most of a ${o.mfeR}R best`);
  const reach = plan.trailActivateR ?? plan.targetR ?? plan.ownTargetR;
  if (reach === null || reach === undefined) return judged('the plan has no R exit to compare');
  if (o.mfeR >= reach) return judged(`the plan's ${reach}R was reached: managing it is judgment`);
  why.push(`closed at ${o.r}R, its best ${o.mfeR}R, before the plan's ${reach}R`);
  return out('early close', false);
}

// A look writeScorecard already checked and recorded: a private key, so no other caller of scoreRun can skip the check.
const TAKEN = Symbol('look taken');
const nextDay = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/**
 * The look a scorecard takes at a run's days, checked by the look ledger's rules (prop/looks.js, R16, R17, R32): its
 * purpose (default: reasoning-fix for a run in Recent, a fix to a stated reason the briefing contradicts with no claim
 * about the market, the only look Recent allows, e.g. the June 1-5, 2026 replay; tuning elsewhere), its candidate
 * (default the run), and the ledger (a list; required for a judging look, which a budget counts; tuning and
 * reasoning-fix looks spend none, so without one the recorded looks alone). On a reasoning-fix look the scorecard hides
 * every market outcome (owner, 2026-10-13). A live session is its own split, outside the schedule: no look, all shown.
 * Refused: throws.
 */
function lookAt(run, { purpose = null, candidate = null, ledger = null } = {}) {
  if (run.manifest.source === 'live') return { purpose: null, why: 'a live session: its own split, not a look at the schedule' };
  const days = Object.keys(run.days).sort();
  const inRecent = d => { try { return roleOf(Date.parse(`${d}T00:00:00Z`)).role === 'recent'; } catch (_err) { return false; } };
  purpose = purpose || (days.length && days.every(inRecent) ? 'reasoning-fix' : 'tuning');
  if (ledger === null && purpose === 'judging') throw new Error('a judging look needs the look ledger (--ledger): it counts against a budget (R16, R17)');
  if (!days.length) return { purpose, candidate: null, units: [] };
  const look = { candidate: candidate || `scorecard:${run.manifest.runId}`, purpose, ranges: days.map(d => ({ from: d, to: nextDay(d) })) };
  const res = checkLook(look, ledger === null ? [] : ledger);
  if (!res.ok) throw new Error(`the scorecard's look at ${days[0]}..${days[days.length - 1]} is refused: ${res.refusals.join('; ')}`);
  return { purpose, candidate: look.candidate, ranges: look.ranges, units: [...new Map(res.units.map(u => [u.key, { key: u.key, role: u.role }])).values()] };
}

/**
 * The look checked against the ledger file and, when allowed, appended to it ({ candidate, purpose, ranges, at })
 * before anything is read, so the next look counts it (a budget spent once per look). The file is the evaluator's
 * (prop/ledger-file.js: one format, one lock), so a scorecard's looks and the evaluator's spend one budget. A ledger
 * file that is missing or can't be read refuses the look. A reasoning-fix look without a file is checked against the
 * recorded looks only.
 */
function takeLook(dir, { purpose = null, candidate = null, ledgerFile = null } = {}, now = new Date()) {
  const run = readRun(dir);
  // A learning run (learning-run.json) follows the learning split and its ledger, which the gate already wrote to.
  const learning = learningLook(dir, run, { purpose });
  if (learning) return learning;
  if (!ledgerFile) return lookAt(run, { purpose, candidate, ledger: null });
  const file = path.resolve(expandHome(ledgerFile));
  return withLedgerLock(file, () => {
    let ledger;
    try { ledger = readLedger(file); } catch (e) { throw new Error(`the look ledger ${file} can't be read (${e.message}): no look without it (R16)`, { cause: e }); }
    const taken = lookAt(run, { purpose, candidate, ledger });
    if (taken.purpose && taken.ranges && taken.ranges.length) appendLook(file, { candidate: taken.candidate, purpose: taken.purpose, ranges: taken.ranges, at: now.toISOString() });
    return taken;
  });
}

/**
 * The checks the classification can't see: an entry on a setup the scan did not list whose own field conditions fail
 * on the recorded values (wrong-side entry when the other side's hold, else a bad size: the order says no trade),
 * and a right decision that still states a claim the cycle's own check found false (wrong stated reason).
 */
function withChecks(verdict, { label, facts, flow, claimChecks }) {
  const act = label.teacher ? label.teacher.action : null;
  // Not when the classification couldn't trust the entry itself: a failed cycle, orders it can't attribute, a manual trigger.
  const notes = (label.clone && label.clone.reasons) || [];
  const untrusted = Boolean(label.cycleFailed) || notes.some(r => r === 'no cycle log' || r === 'unattributed order') || facts.styleOf(label.teacher && label.teacher.setup) === 'manual';
  if (flow.status === 'inconsistent' && !untrusted && (verdict.category === 'unchecked' || verdict.category === 'right')) {
    const s = flow.setups[0];
    const failed = (s.conditions || []).filter(c => !c.ok).map(c => `${c.rule}${c.missing ? ' (no value)' : ''}`);
    const why = flow.otherSide ? `${s.strategy}'s field conditions fail for a ${act} and its ${act === 'long' ? 'short' : 'long'} conditions (all on fields) hold on the recorded values (${failed.join(', ')})`
      : `${s.strategy}'s field conditions fail for a ${act} on the recorded values (${failed.join(', ')}): the order says no trade`;
    return { category: flow.otherSide ? 'wrong-side entry' : 'bad size', agrees: false, why: [...verdict.why, why] };
  }
  if (claimChecks.status === 'checked' && claimChecks.kept.length && verdict.category === 'right') {
    return { category: 'wrong stated reason', agrees: true, why: [...verdict.why, `stated after the cycle's own check found it false: ${claimChecks.kept.map(c => `"${c.clause}"`).join(', ')}`] };
  }
  return verdict;
}

// ---------------------------------------------------------------------------------------------
// Facts

/** The run's own records, read once. */
function runRecords(home, { strategies, outcomeBars }) {
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
  // In file order: the latest verdict per policy is the last one written (labels.js composedTagsAt reads it so too).
  const verdictList = readLines(path.join(home, 'policy-verdicts.jsonl')).filter(isObj);
  for (const v of verdictList) {
    if (!isObj(v) || !v.symbol || !v.bar) continue;
    const k = `${v.symbol}|${v.bar}|${v.strategy}`;
    if (!verdicts.has(k)) verdicts.set(k, []);
    verdicts.get(k).push(v);
  }
  const byName = new Map((strategies || []).filter(x => x && x.name).map(x => [x.name, x]));
  const bars = new Map();
  // By symbol and the line's timeframe (the runner config at its time).
  const barsFor = (sym, tf) => {
    const k = `${sym}|${tf}`;
    const given = outcomeFor(outcomeBars, sym, tf);
    if (!bars.has(k)) bars.set(k, given ? given.map(b => ({ ...b, ms: b.ms ?? Date.parse(b.t) })) : loadBars(home, sym, tf));
    return bars.get(k);
  };
  // The bars the runner hands a cycle under a config.
  const countFor = cfg => recordedBars(cfg);
  // The run's own round-number steps (its home, seeded at its start), never today's user config.
  return { scans, verdicts, verdictList, byName, barsFor, countFor, blackouts: readBlackouts(path.join(home, 'blackouts', 'blackouts.json')), roundSteps: loadRoundSteps({ FTH_HOME: home }) };
}

const before = (list, t) => (list || []).filter(x => Date.parse(x.at) <= t).pop() || null;

/** The briefing's candidates and alignment for the bar, rebuilt from the bars closed by it; null without them. */
/** The bars a cycle on `barT` was handed (the last `count` up to it, its time keys dropped), or null: too few, no tf. */
function barsAt(rec, { symbol, barT, tf, count }) {
  const all = rec.barsFor(symbol, tf);
  const i = all.findIndex(b => b.t === barT || b.ms === Date.parse(barT));
  if (i < 2 || !tf) return null;
  return all.slice(Math.max(0, i + 1 - count), i + 1).map(({ ms: _ms, ...x }) => x);
}

function briefingAt(rec, { symbol, barT, t, scan, tf, count }) {
  const bars = barsAt(rec, { symbol, barT, tf, count });
  if (!bars) return null;
  const style = r => { const s = rec.byName.get(r.name); return s && s.mtf ? s.mtf : null; };
  // The runner's scan results, as far as the log keeps them: a rules candidate's exit and min R:R from its strategy.
  const results = scan.results.filter(isObj).map(r => {
    const s = rec.byName.get(r.name);
    const rules = s && s.signal !== 'policy';
    return { ...r, ...(rules ? { minRR: s.risk ? s.risk.min_rr : undefined, exit: exitPlan(s), status: s.status } : {}), ...(r.mtf ? { mtf: { ...r.mtf, style: style(r) || 'trend' } } : {}) };
  });
  try {
    const b = buildBriefing({ symbol, contractId: scan.contractId || null, bars, minutes: tf, scan: results, blackouts: rec.blackouts, roundSteps: rec.roundSteps, now: new Date(t) });
    return { candidates: b.sections.m3.data.candidates || [], alignment: b.sections.m15.data.alignment || {} };
  } catch (_err) {
    return null;
  }
}

/**
 * A composable setup in a bar briefing (the facts compose_check starts from): the setup timeframe's last completed
 * candle reacted at a key level or FVG (setup-moments.js, the "Setups to check" line), the trigger timeframe closed
 * after it (phase confirmation), on a side the trend rule allows, in a window that allows entries and no news
 * blackout, and the briefing's Standard plan for that side is OK (setup-library.js standardPlans, the same code the
 * briefing's line comes from): a plan the line states refused is a pass the skills prescribe, never abstention.
 * { valid, sides, reason }; never throws (no briefing: not valid).
 */
function composableSetup(b) {
  try {
    const m3 = b && b.sections && b.sections.m3 ? b.sections.m3.data : null;
    if (!m3 || !m3.bar) return { valid: false, sides: [], reason: 'no bar briefing' };
    const mo = setupMoment(m3.candles, { barClose: Date.parse(m3.bar.t) + b.minutes * 60000 });
    const rule = trendRuleOf(m3.trendRule);
    const allowed = [...new Set(mo.reactions.map(r => (r.dir === 'up' ? 'long' : r.dir === 'down' ? 'short' : null)).filter(x => x && rule[x] === true))];
    const blocked = m3.windowEntries !== 'allowed' ? `the ${m3.window} window allows no entries` : m3.news && m3.news.inBlackout !== false ? 'a news blackout or the news unknown' : null;
    const plans = mo.moment && mo.phase === 'confirmation' && allowed.length && !blocked ? standardPlans(b) || [] : [];
    const sides = allowed.filter(side => plans.some(p => p.side === side && p.status === 'traded'));
    const refused = allowed.map(side => plans.find(p => p.side === side)).filter(Boolean).map(p => `${p.side} plan refused (${p.why})`);
    const valid = sides.length > 0;
    return { valid, sides: valid ? sides : allowed, reason: blocked || (!mo.moment ? mo.reason : mo.phase !== 'confirmation' ? `${mo.reason}: the trigger not closed yet` : !allowed.length ? `${mo.reason}: not the trend rule's side` : !valid ? `${mo.reason}: ${refused.join(', ') || 'no standard plan'}` : `${mo.reason}, plan OK`) };
  } catch (err) {
    return { valid: false, sides: [], reason: `the briefing can't be read (${err.message})` };
  }
}

/** The briefing's 4h and 1h trends at a decision (briefing.js htfTrendsOf on the bars the cycle was handed), or null. */
function htfAt(rec, { symbol, barT, tf, count }) {
  const bars = barsAt(rec, { symbol, barT, tf, count });
  if (!bars) return null;
  try {
    return htfTrendsOf(bars, tf);
  } catch (_err) {
    return null;
  }
}

/** The bar briefing rebuilt at a decision (the runner's own code on the run's bars, no scan), or null. */
function plainBriefingAt(rec, { symbol, barT, t, tf, count }) {
  const bars = barsAt(rec, { symbol, barT, tf, count });
  if (!bars) return null;
  try {
    return buildBriefing({ symbol, contractId: null, bars, minutes: tf, scan: [], blackouts: rec.blackouts, roundSteps: rec.roundSteps, now: new Date(t) });
  } catch (_err) {
    return null;
  }
}

/** The session window at time t as the briefing states it, with whether it allows entries (its own field, never its name). */
function windowAt(t) {
  const win = sessionWindow(new Date(t));
  return { name: win.name, until: etClock(win.until.getTime()), et: etClock(t), entriesAllowed: win.entries === 'allowed' };
}

/**
 * The exit plan a trade under setup `name` is managed by, and its bar size (a max_bars counts its own bars), or null.
 * A composed strategy's trades exit by the policy that lists it, in an attempt or not (evaluator.js composedExit, as the
 * runner manages them), so an entry under either tag is judged the same. An exit at the trade's own target (a policy's
 * mode target or target_then_trail) is at least risk.min_rr away: under it the target is known not reached (ownTargetR).
 */
function planFor(name, byName, tf) {
  const s = byName.get(name);
  if (!s || !s.risk) return null;
  const plan = composedExit(s, [...byName.values()]).plan;
  return { ...plan, ...(plan.own || plan.afterTarget ? { ownTargetR: num(s.risk.min_rr) } : {}), minutes: parseInt(s.timeframe, 10) || tf };
}

/** The facts at one decision: window, setups (with the trend rule, room, read, confluence), trend rule per side, attempt. */
function factsAt(label, rec, { tf, count, accounts, doc = null, strategies = [] }) {
  const t = Date.parse(label.t);
  // The line's own scans and verdicts: up to where its step ended (latency charged: label.endedAt), else its time.
  const ownT = Number.isFinite(Date.parse(label.endedAt)) ? Math.max(t, Date.parse(label.endedAt)) : t;
  const facts = {
    t: label.t, et: etClock(t), window: windowAt(t), news: newsState(rec.blackouts, new Date(t)),
    // The runner config at the decision's time: its bar size and the bars a cycle was handed.
    timeframe: tf, barsHanded: count,
    scanned: false, setups: [], fired: [], trendRule: { prevailing: null, long: null, short: null }, attempt: null, rebuilt: false,
    styleOf: name => { const s = rec.byName.get(name); return s ? (s.signal === 'manual' ? 'manual' : s.mtf || null) : null; },
    // A strategy's exit plan and bar size (its max_bars count in its own bars): planFor.
    planOf: name => planFor(name, rec.byName, tf),
  };
  const scan = before(rec.scans.get(`${label.symbol}|${label.barT}`), ownT);
  if (scan && Array.isArray(scan.results)) {
    facts.scanned = true;
    const results = scan.results.filter(isObj);
    // Every result the scan fired, tradeable or not (name|side): what the model saw fire.
    facts.fired = results.filter(r => r.candidate && r.direction).map(r => `${r.name}|${r.direction}`);
    // The trend rule per side (never counter: every style's record counts): blocked when any record says so.
    for (const r of results.filter(x => isObj(x.mtf))) {
      facts.trendRule.prevailing = facts.trendRule.prevailing || r.mtf.prevailing || null;
      for (const side of ['long', 'short']) {
        const v = r.mtf[`${side}Allowed`];
        if (typeof v === 'boolean') facts.trendRule[side] = facts.trendRule[side] === false ? false : v;
      }
    }
    const tradeable = new Set((label.candidates || []).map(c => `${c.name}|${c.direction}`));
    const briefing = results.some(r => r.direction && (r.candidate || r.verdict)) ? briefingAt(rec, { symbol: label.symbol, barT: label.barT, t, scan, tf, count }) : null;
    facts.rebuilt = Boolean(briefing);
    for (const r of results.filter(x => x.direction && (x.verdict || x.candidate))) {
      const policy = Boolean(r.verdict) || (rec.byName.get(r.name) || {}).signal === 'policy';
      if (!policy && !tradeable.has(`${r.name}|${r.direction}`)) continue;
      const v = policy ? before(rec.verdicts.get(`${label.symbol}|${label.barT}|${r.name}`), ownT) : null;
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
        confluence: conf, blocked: bc ? bc.blocked || null : null, vwapSide: bc ? bc.vwapSide : null, lunch: /lunch/.test(facts.window.name),
        verdictCombine: v && isObj(v.combine) ? v.combine : null,
      });
    }
  }
  // The cycle's compose records for this symbol's bar (the cycle log's `composed`): the latest OK one per side is a
  // composed setup, judged on its own record (the composed-entry design, section 5).
  const tags = [...composedTagsAt(strategies, rec.verdictList, label.symbol, label.barT)];
  // The tags an entry on a composed setup goes under: an entry under one is judged on a composed setup or none.
  facts.composedTags = tags;
  const cycleRoot = label.symbol ? (parseStandardName(String(label.symbol)) || {}).root || null : null;
  const composedSetups = composedSetupsFrom(composedOf(doc, label), { window: facts.window, news: facts.news, aliases: tags, root: entryRoot(label) || cycleRoot });
  // A policy's verdict on a record (prop/composed-verdict.js, `record` its id): the latest is that setup's verdict, so a
  // skip is a hard stop and its size a ceiling, as the gate holds the entry to it.
  for (const s of composedSetups) {
    const v = rec.verdictList.filter(x => isObj(x) && x.record && x.record === s.composed.record).pop();
    if (v) s.verdict = { action: v.action, maxSize: num(v.maxSize), contract: v.contract || null, stopTicks: num(v.stopTicks), reason: v.reason || null };
  }
  facts.setups.push(...composedSetups);
  // The 4h and the 1h at the decision (the briefing's own read): a 1h CHoCH against is decisive only without both its way.
  if (composedSetups.length && rec.barsFor) facts.htf = htfAt(rec, { symbol: label.symbol, barT: label.barT, tf, count });
  facts.attempt = attemptAt(label, facts, { accounts, doc });
  // A pass with no compose call on the bar: whether the briefing held a composable setup (only then rebuilt).
  const act = label.teacher ? label.teacher.action : null;
  if (label.decision !== 'in-trade' && (act === 'none' || act === null) && !composedOf(doc, label).length && !facts.setups.length && rec.barsFor) {
    facts.composable = composableSetup(plainBriefingAt(rec, { symbol: label.symbol, barT: label.barT, t, tf, count }));
  }
  return facts;
}

/**
 * The contract root an entry was placed on (its order's contract, a standard name), as the gate checks the record's
 * contract against it; null for no entry, or a broker id no standard name gives (the cycle's symbol then).
 */
function entryRoot(label) {
  const act = label.teacher ? label.teacher.action : null;
  if (act !== 'long' && act !== 'short') return null;
  const o = countedEntry(label.teacher.orders);
  const std = o && o.contractId ? parseStandardName(String(o.contractId)) : null;
  return std ? std.root : null;
}

/** The compose records (recordSummary shape) the cycle log kept for the label's symbol family and bar, in order. */
function composedOf(doc, label) {
  const list = isObj(doc) && Array.isArray(doc.composed) ? doc.composed.filter(isObj) : [];
  const fam = label.symbol ? familyRoot(String(label.symbol).toUpperCase()) : null;
  const bar = Date.parse(label.barT);
  return list.filter(r => (!fam || !r.symbol || familyRoot(String(r.symbol).toUpperCase()) === fam)
    // The bar exactly, as the gate's recordsAt: a record with none (a refused call) is on no bar.
    && Number.isFinite(bar) && Date.parse(r.bar) === bar);
}

/** The attempt as the cycle's context showed it (else the verdict's), with the daily-limit headroom and the balance check. */
function attemptAt(label, facts, { accounts, doc }) {
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

function scoreRun(runDir, { strategies = [], accounts = [], outcomeBars = null, unfinished = false, look = {} } = {}) {
  const dir = realDir(runDir);
  const home = path.resolve(dir, '..', '..');
  const run = readRun(dir);
  // Scoring a run looks at its days: the look ledger's rules decide first (refused: nothing is read); a look already
  // checked and recorded (writeScorecard with a ledger file) is not checked twice.
  const taken = look[TAKEN] || learningLook(dir, run, look) || lookAt(run, look);
  const hide = taken.purpose === 'reasoning-fix';
  // The runner config at each decision's time (a live session restarted on another config: labels.js configsOf).
  const cfgAt = configsOf(dir, run.manifest);
  const why = unfinishedWhy(run.manifest, run.days);
  if (why && !unfinished) throw new Error(`run ${run.manifest.runId} is not finished (${why}): run it to its end first, or write the scorecard outside the run home with --out <dir> (it holds what came after each decision, which a resumed run could read)`);
  const { labels, summary: ls } = labelRun(dir, { strategies, accounts, outcomeBars, unfinished });
  const rec = runRecords(home, { strategies, outcomeBars });
  const records = [];
  const notScored = {};
  for (const label of labels) {
    if (label.decision !== 'flat' && label.decision !== 'in-trade') {
      notScored[label.decision] = (notScored[label.decision] || 0) + 1;
      continue;
    }
    const cfg = cfgAt(label.t);
    const cycleFile = label.provenance && label.provenance.cycleFile;
    const doc = cycleFile && cycleFile.startsWith('logs/cycles/') ? readJson(path.join(home, cycleFile), null) : null;
    const facts = factsAt(label, rec, { tf: Number(cfg.timeframe) || null, count: rec.countFor(cfg), accounts, doc, strategies });
    const act = label.teacher ? label.teacher.action : null;
    const expected = label.decision === 'in-trade' ? { decision: 'hold', ceiling: null, decidedBy: 'in a trade', ...NONE }
      : act === 'long' || act === 'short' ? expectedForEntry(facts, label.teacher.setup, act) : expectedDecision(facts);
    // An entry is known from its orders, whatever the result's first word: a window claim is no ground for it.
    const reasons = checkReasons(label.result, facts, { entered: act === 'long' || act === 'short' });
    const flow = F.flowOf(label, facts, rec.byName);
    const claimChecks = F.claimChecksOf(doc, label.result);
    // On a reasoning-fix look no outcome is read: an exit is judged without the trade's excursion (early close: unchecked).
    const seen = hide ? { ...label, outcome: null } : label;
    const verdict = withChecks(classify(seen, facts, expected, reasons), { label, facts, flow, claimChecks });
    const o = label.outcome;
    const { styleOf: _styleOf, planOf: _planOf, composedTags: _tags, ...plainFacts } = facts;
    records.push({
      v: VERSION, key: label.key, t: label.t, day: label.day, symbol: label.symbol, barT: label.barT, decision: label.decision,
      facts: { ...plainFacts, setups: facts.setups.map(({ verdictCombine: _vc, ...s }) => s) },
      expected,
      actual: { action: label.teacher ? label.teacher.action : null, setup: label.teacher ? label.teacher.setup : null, size: label.teacher && label.teacher.size ? label.teacher.size.contracts : null, gate: label.gate, result: label.result },
      reasons, incidentalFalse: reasons.claims.filter(c => c.check === false && c.incidental).length, agrees: verdict.agrees, category: verdict.category, why: verdict.why,
      severity: null, flow, claimChecks, data: F.dataOf(label, facts), provenance: { cycleFile: cycleFile || null, promptHash: label.provenance ? label.provenance.promptHash : null },
      trade: o && o.filled ? { result: o.result, r: o.r, net: o.net, side: o.side, size: o.size, exitReason: o.exitReason, ...(o.rBasis ? { rBasis: o.rBasis } : {}) } : null,
      counterfactual: label.counterfactualFor === 'skip' && label.counterfactual ? { strategy: label.counterfactual.strategy, direction: label.counterfactual.direction, simulated: label.counterfactual.simulated, result: label.counterfactual.result, R: label.counterfactual.R, net: label.counterfactual.net, reason: label.counterfactual.reason } : null,
      pacing: facts.attempt,
    });
    const r = records[records.length - 1];
    r.severity = F.severityOf(r);
  }
  const summary = { ...summarize(records, { runId: ls.runId, unfinished: ls.unfinished, notScored, labels: ls }), look: taken };
  return hide ? hideOutcomes(records, summary) : { records, summary: { ...summary, outcomes: 'shown' } };
}

const HIDDEN = 'hidden on a reasoning-fix look (owner, 2026-10-13)';
const ATTEMPT_SEEN = ['account', 'status', 'entryBlock'];
// Dollar amounts in any text (an entry block "down $X today", a verdict reason "cushion of $Y", the model's own result
// line): the account's money is an outcome too, so each becomes "$…" (the kind of block or reason stays). An amount
// written with neither "$" nor a currency word ("down 400 today") can't be told from any other number: it stays.
const MONEY = /\$\s?-?[\d,]+(?:\.\d+)?[kKmM]?\b|-?[\d,]+(?:\.\d+)?[kKmM]?\s?(?:USD|dollars)\b/gi;
const redactMoney = x => (typeof x === 'string' ? x.replace(MONEY, '$…') : Array.isArray(x) ? x.map(redactMoney)
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, redactMoney(v)])) : x);
/**
 * A reasoning-fix look's scorecard: the reasoning and fact failures only. Every market outcome is dropped: each trade's
 * result, what a skipped setup would have returned, the account's balance, P&L, cushion and headroom, and what the
 * no-cycle bars would have done. The counts of trades and skips stay (what the model did, not what the market did).
 */
function hideOutcomes(records, summary) {
  const recs = records.map(({ trade: _t, counterfactual: _c, pacing: _p, ...r }) => redactMoney({
    ...r, facts: { ...r.facts, attempt: r.facts.attempt ? Object.fromEntries(ATTEMPT_SEEN.map(k => [k, r.facts.attempt[k] ?? null])) : null },
  }));
  const { trades, skipped, days, labels, ...rest } = summary;
  return {
    records: recs,
    summary: {
      ...rest, outcomes: HIDDEN, trades: { n: trades.n }, skipped: { n: skipped.n },
      days: days.map(d => ({ day: d.day, decisions: d.decisions, agree: d.agree, disagree: d.disagree })),
      labels: { noCycleWithCandidates: labels.noCycleWithCandidates },
    },
  };
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
    failures: F.failureSummary(records),
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
    F.failureMarkdown(s.failures),
    '## Stated reasons', '',
    `${s.reasons.claims} checkable claims: ${s.reasons.true} true, ${s.reasons.false} false (${s.reasons.falseIncidental} incidental: about a setup the bar didn't have), ${s.reasons.unchecked} unchecked; ${s.reasons.judgmentClauses} judgment clauses, ${s.reasons.unparsedClauses} unparsed. Wrong-reason rate ${pct(s.reasons.wrongReasonRate)} of the decisions with a decision-relevant checked claim; incidental ${pct(s.reasons.incidentalWrongRate)}.`, '',
    '| claim | true | false | of which incidental | unchecked |', '| --- | ---: | ---: | ---: | ---: |', ...Object.entries(s.reasons.byKind).map(([k, x]) => `| ${k} | ${x.true} | ${x.false} | ${x.incidentalFalse} | ${x.unchecked} |`), '',
    '## Trades and skipped setups', '',
    s.outcomes !== 'shown' ? `${s.trades.n} trades, ${s.skipped.n} skipped setups; their outcomes and the account are ${s.outcomes}.\n` : `${s.trades.n} trades: ${s.trades.wins} won, ${s.trades.losses} lost, ${s.trades.sumR}R, $${s.trades.net}. ${s.skipped.n} skipped setups: ${s.skipped.simulated} simulated, ${s.skipped.wouldWin} would have won, ${s.skipped.wouldLose} lost, ${s.skipped.sumR}R, $${s.skipped.net}.`, '',
    ...(s.outcomes !== 'shown' ? [] : ['## Account by day', '', '| day | decisions | agree | disagree | balance | day P&L | floor | cushion | daily headroom | balance check |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
      ...s.days.map(d => `| ${d.day} | ${d.decisions} | ${d.agree} | ${d.disagree} | ${cell(d.balance)} | ${cell(d.dayPnl)} | ${cell(d.floor)} | ${cell(d.cushion)} | ${cell(d.dailyHeadroom)} | ${cell(d.balanceCheck)} |`), '']),
    '## Flagged decisions', '', flagged.length ? 'Each in full, for review: flagged.md and flagged.jsonl.\n\n| time (ET) | category | severity | expected | actual | why | false reasons |\n| --- | --- | --- | --- | --- | --- | --- |' : 'None.',
    ...flagged.map(r => `| ${r.day} ${r.facts.et} | ${r.category} | ${r.severity} | ${r.expected.decision}${r.expected.setup ? ` ${r.expected.setup}` : ''} | ${r.actual.action}${r.actual.size ? ` ${r.actual.size}` : ''} | ${cell(r.why.join('; '))} | ${cell(r.reasons.claims.filter(c => c.check === false).map(c => `"${c.clause}": ${c.why}${c.incidental ? ' (incidental)' : ''}`).join('; '))} |`),
    '',
  ].filter(x => x !== null).join('\n');
}

/** Writes scorecard.jsonl, scorecard-summary.json and scorecard.md: the run's folder (finished), else --out outside the run home. */
function writeScorecard(runDir, { root = null, strategies = [], accounts = [], barsFiles = {}, outDir = null, look = {} } = {}) {
  const dir = realDir(runDir);
  const out = outDir ? path.resolve(expandHome(outDir)) : dir;
  const home = path.resolve(dir, '..', '..');
  if (root && (inside(dir, root) || inside(out, root))) throw new Error(`${inside(out, root) ? out : dir} is inside the repository (${root}): the scorecard is written to the run's own folder or --out, never the repository`);
  if (outDir && inside(out, home)) throw new Error(`--out ${out} is inside the run home (${home}): write the scorecard of an unfinished run outside it`);
  // Every other refusal first (an unfinished run without --out), so a look is recorded only when it is taken; then the
  // look, before anything else is read.
  const run = readRun(dir);
  const why = unfinishedWhy(run.manifest, run.days);
  if (why && !outDir) throw new Error(`run ${run.manifest.runId} is not finished (${why}): run it to its end first, or write the scorecard outside the run home with --out <dir> (it holds what came after each decision, which a resumed run could read)`);
  const taken = takeLook(dir, look);
  const outcomeBars = outcomeBarsFor(dir, barsFiles);
  // What came after each decision (outcomes, counterfactuals) never goes where a resumed run could read it.
  const { records, summary } = scoreRun(dir, { strategies, accounts, outcomeBars, unfinished: Boolean(outDir), look: { [TAKEN]: taken } });
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'scorecard.jsonl');
  fs.writeFileSync(`${file}.${process.pid}.tmp`, records.map(r => `${JSON.stringify(r)}\n`).join(''));
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
  writeJsonAtomic(path.join(out, 'scorecard-summary.json'), summary);
  fs.writeFileSync(path.join(out, 'scorecard.md'), toMarkdown(summary, records));
  // The flagged decisions, for the self-review: each failure with what the model saw, did, and what the code found.
  const flagged = records.filter(r => F.TYPES.includes(r.category)).map(r => F.flaggedEntry(r, { runId: summary.runId, home, decisionFile: path.relative(home, path.join(dir, `${r.day}.jsonl`)) }));
  fs.writeFileSync(path.join(out, 'flagged.jsonl'), flagged.map(x => `${JSON.stringify(x)}\n`).join(''));
  fs.writeFileSync(path.join(out, 'flagged.md'), F.flaggedMarkdown(summary.runId, flagged));
  return { file, summary, flagged: flagged.length };
}

const summaryText = s => `${s.decisions} decisions: agreement ${pct(s.agreement.overall.rate)} (${s.agreement.overall.agree} agree, ${s.agreement.overall.disagree} disagree, ${s.agreement.overall.unchecked} unchecked)\n`
  + `categories: ${Object.entries(s.categories).map(([k, v]) => `${k} ${v}`).join(', ')}\n`
  + `failures: ${s.failures.failures} (${pct(s.failures.failureRate)}; high ${s.failures.severity.high}, medium ${s.failures.severity.medium}, low ${s.failures.severity.low}); session-timing misreads ${s.failures.sessionTiming.decisions}; values absent ${s.failures.data.valuesAbsent}, values error ${s.failures.data.valuesError}, archive error ${s.failures.data.archiveError}, pruned ${s.failures.data.archivePruned}\n`
  + `reasons: ${s.reasons.claims} claims, ${s.reasons.false} false (${s.reasons.falseIncidental} incidental); wrong-reason rate ${pct(s.reasons.wrongReasonRate)} (incidental ${pct(s.reasons.incidentalWrongRate)})\n`
  + (s.outcomes !== 'shown' ? `trades ${s.trades.n}, skipped setups ${s.skipped.n}; outcomes ${s.outcomes}\n`
    : `trades ${s.trades.n} (${s.trades.sumR}R, ${s.trades.net}); skipped setups ${s.skipped.n} (would win ${s.skipped.wouldWin}, lose ${s.skipped.wouldLose})\n`);

module.exports = { VERSION, SCORES_COMPOSED, CATEGORIES, STEPS, withChecks, lookAt, takeLook, scoreRun, writeScorecard, summaryText, toMarkdown, checkReasons, expectedDecision, expectedForEntry, classify, clausesOf, windowAt, planFor, composableSetup };
