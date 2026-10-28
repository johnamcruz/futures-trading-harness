'use strict';

/**
 * Pure order-gate rules. Given a place_order request, the journal, the clock,
 * and the config, decide whether the harness lets the order reach the broker MCP server.
 *
 * Orders are classified by the first token of `rationale`:
 *   [exit] ...     closes or reduces a position          -> never gated
 *   [protect] ...  protective stop / target for a fill   -> never gated
 *   anything else  a new entry                           -> every check below
 * An entry's tick specs are the broker's, as the contract translator recorded
 * them (broker-specs.js, local state); an entry on a contract with none is
 * refused (contract-specs). An entry's size must be within the broker
 * server's maxOrderSize as recorded from get_server_config (max-order-size;
 * none recorded, refused) and its dollar risk within the named strategy's
 * risk.max_risk_usd where set (max-risk; order-limits.js). Exits and
 * protective orders never need specs and are never size- or risk-checked.
 * The MCP server still enforces its own size and loss limits on all of them.
 */

const { tradingDayStart, entryClock, inMarketHours, tradingDayKey, EARLY_CLOSE_MIN, MARKET_HOURS_LABEL } = require('./clock');
const { entriesSince, entryTime, hasTag, reviewResult, contractRoot, mayBeRoot, onePerOrder } = require('./journal');
const fs = require('fs');
const { checkStrategyForOrder, citingPolicies, composedOf, citedSetups } = require('./strategies');
const { propViolations, runningAttempts, latestVerdict, carriedLossState } = require('./prop-state');
const { translatorFor, allInRisk, stretchedEntry } = require('../prop/size-translate');
const { feePerSide } = require('./accounts');
const { checkTrend } = require('./mtf-state');
const { checkTrigger, retiredLaneRefusal, retiredLaneRefusalAny, signalMaxAgeMin } = require('./signal-state');
const { readBriefing } = require('./briefing');
const { checkSkillsLoaded, checkSkillsAtEntry, REQUIRED_FOR_ENTRY, REQUIRED_FOR_COMPOSED, SITUATIONAL, situationalSkills, headSituationalSkills, loadedSkills, claudeLookupsInTranscript } = require('./skills-loaded');
const { checkRolesRan, approvedPhase2, sizeRefusal, approvedSize } = require('./roles-ran');
const { readHeadSkills } = require('./runner-roles');
const { lookupRule, briefingFacts, PLUGIN_ROOT: HARNESS_ROOT } = require('./skill-lookups');
const { familyRoot } = require('./contracts');
const { attestedSkills, parseAttestation, claudeAttested } = require('../head-prompt');
const { gateRefusal: factsRefusal } = require('./fact-claims');
const { brokerSpecs, contractsFileFor, whyNoSpec, brokerOrderLimit, dayFrontMissing } = require('./broker-specs');
const { checkOrderSize, checkRiskLimit, entryStopTicks } = require('./order-limits');
const { lockGateRefusal } = require('../account-lock');
const { composedName, composedRefusal, reversalAllowed } = require('./lifecycle-gate');
const { entryRuleOf } = require('./entry-rule');
const { lateEntryCheck, ageLimitOf } = require('./late-entry');
const { protectRefusal, restingExitRefusal } = require('./bracket-rule');
const GATE = require('../tunables').runner().gate; // config/runner.json: the bracket tolerances (tighten-only)

const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;
// The setup tag must open the rationale, so text like "not setup:orb" can't satisfy it.
const SETUP_TAG = /^\s*setup:([a-z0-9][a-z0-9_-]*)\b/i;
// An entry's stop goes with it as its stopLossBracket, or the entry doesn't go (stop-defined).
const STOP_BRACKET_REQUIRED = 'Entry has no stop bracket: every entry carries its stop as stopLossBracket {ticks, type:"stop"}, '
  + 'ticks a whole number above 0 from the fill and type "stop" (or "trailing_stop"); order_plan gives it. A stop stated only in the rationale is not one. '
  + 'A broker that can\'t attach the bracket refuses the entry: never send it again without one, and report the broker\'s message to the user.';
// "stop 21450.25", "stop at 21450", "stop: 21450": the price right after the word; a number followed by a unit (40 ticks, 2R, 10 pts) is not a price.
// Thousands separators are allowed (21,480.25); a ratio (2:1) or an ATR multiple is not a price either.
const PRICE_AFTER = word => new RegExp(`\\b${word}(?:\\s+at)?\\s*[:=@]?\\s*(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\b(?![,.]?\\d)(?!\\s*(?:ticks?|pts?|points?|r\\b|x\\b|%|atr\\b|:\\s*\\d))`, 'i');
const STOP_PRICE = PRICE_AFTER('stop');
const TARGET_PRICE = PRICE_AFTER('target');
// The side named right after the tag: "setup:orb long ...".
const SIDE_WORD = /^\s*setup:[a-z0-9_-]+\s+(long|short|buy|sell)\b/i;

// The order types a stop bracket may take, lowercase as the interface's enum: a stop leg (a limit or market leg is no stop).
const STOP_BRACKET_TYPES = new Set(['stop', 'trailing_stop']);

/**
 * The bar the runner's cycle decides for the root's family, as its bar briefing is on (FTH_CYCLE_BRIEFING_BARS, several
 * lanes; else FTH_CYCLE_BARS), or null outside a cycle: the briefing the lookups are judged by (skill-lookups.js).
 */
function briefingBarOf(config, root) {
  const fam = familyRoot(root);
  return (config.cycleBriefingBars || {})[fam] || (config.cycleBars || {})[fam] || null;
}

/**
 * An autonomous entry on stale data, or null: the bar briefing of the order's root closed more than the signal age
 * limit of its own bars ago (signalMaxAgeMin: 3 of its bars, FTH_SIGNAL_MAX_AGE_BARS, at most 45 min, capped by
 * FTH_SIGNAL_MAX_AGE_MIN), however long the cycle ran. The cycle names its bar but no briefing (or no readable close)
 * is there: refused (fails closed). Outside a runner's cycle with no briefing: nothing to judge. Entries only.
 */
function briefingAgeRefusal(config, root, now) {
  if (!config.autonomous) return null;
  const fam = familyRoot(root);
  const named = briefingBarOf(config, root);
  const b = readBriefing(config.home, root);
  if (!b) return named ? `No bar briefing for ${fam}, though the cycle decides its bar at ${named}: the entry can't be checked against current data, so no entry this cycle.` : null;
  const closed = Date.parse(b.closedAt);
  const minutes = Number.isInteger(b.minutes) && b.minutes > 0 ? b.minutes : null;
  const tf = minutes ? `${minutes}m` : null;
  const limit = signalMaxAgeMin(tf, { bars: config.signalMaxAgeBars, capMin: config.signalMaxAgeCapMin, ceilingMin: config.signalMaxAgeCeilingMin });
  if (!Number.isFinite(closed)) return `The ${fam} bar briefing (bar at ${b.asOf}) has no readable close time: its data's age can't be checked, so no entry this cycle.`;
  const age = (now.getTime() - closed) / 60000;
  if (age <= limit) return null;
  return `Stale data: the ${fam} bar briefing's bar (at ${b.asOf}) closed ${age.toFixed(1)} min ago, over the ${limit} min limit (the signal age limit: ${config.signalMaxAgeBars || GATE.signalMaxAgeBars} bars of ${tf || '1 minute (no readable timeframe)'}, with its ceiling and cap): no entry on it. The cycle took too long; report the block and end the cycle (trade-session step 6). The next bar's cycle decides on fresh data. Exits, stops and closes are never held by this.`;
}

/** True when `b` is a stop bracket: {ticks: a whole number above 0, type: "stop" | "trailing_stop"}. */
function isStopBracket(b) {
  return Boolean(b) && typeof b === 'object' && typeof b.ticks === 'number' && Number.isInteger(b.ticks) && b.ticks > 0
    && STOP_BRACKET_TYPES.has(b.type);
}

/**
 * The order's own setup for the facts check (fact-claims.js): { strategy, side } from its setup tag and side; a policy
 * strategy's is the component its latest verdict trades. strategy null when the order names none. A composed entry's
 * carries its own room (`room`: the record's plan against the briefing's nearest levels, lifecycle-gate.js).
 */
function factsOrder(input, setup, named, home, composedCheck = null) {
  const side = { buy: 'long', sell: 'short' }[String(input.side || '').toLowerCase()] || null;
  if (!setup) return { strategy: null, side };
  // A composed entry: its room fact is about its own plan (the record's target against its stop), never a scan's.
  if (composedCheck && composedCheck.room) return { strategy: setup[1].toLowerCase(), side, room: composedCheck.room };
  if (named && named.signal === 'policy') {
    const v = latestVerdict(home, named.name, contractRoot(input.contractId));
    return { strategy: v && v.component ? v.component : null, side };
  }
  return { strategy: setup[1].toLowerCase(), side };
}

function isRiskReducing(rationale) {
  return RISK_REDUCING.test(String(rationale || ''));
}

/**
 * Reviews that count toward live trading state: not tagged `paper`, and graded
 * with a result tag (result:win|loss|scratch|nofill). With a root, a review that
 * names a different contract doesn't count. At most one per named order (journal.js onePerOrder): a second result
 * review of the same orderId covers no other entry and is no second loss.
 */
function liveReviews(entries, root = null) {
  return onePerOrder(entries.filter(e => e.kind === 'review' && !hasTag(e, 'paper')
    && (reviewResult(e) !== null || hasTag(e, 'result:nofill'))))
    .filter(e => !root || mayBeRoot(e.contractId, root));
}

function successfulEntries(dayEntries) {
  return dayEntries.filter(e =>
    e.kind === 'order_placed'
    && e.data && e.data.result && e.data.result.success === true
    && !isRiskReducing(e.text));
}

/** A plan counts only when it names the contract (contractId) being traded. */
function planMatches(entry, contractId, root) {
  return Boolean(entry.contractId) && (entry.contractId === contractId || contractRoot(entry.contractId) === root);
}

function fmtMin(ms) {
  return `${Math.ceil(ms / 60000)} min`;
}

const onTick = (price, tick) => Math.abs(price / tick - Math.round(price / tick)) < 1e-6;
const fmtPrice = (x, tick) => x.toFixed((String(tick).split('.')[1] || '').length);

/**
 * What the order says about itself must agree: the side named in the
 * rationale and the order's side; the stop and target on the right sides
 * (of the entry price for a limit or stop entry, of each other always);
 * prices on the tick; and brackets the same distance as the rationale's
 * prices. Market entries have no known entry price, so for them the stop and
 * target brackets are checked against the stop-to-target span. Returns a
 * message, or null.
 */
function checkConsistency(input, rationale, specOf = () => null) {
  const problems = [];
  const sign = { buy: 1, sell: -1 }[String(input.side || '').toLowerCase()];
  const said = SIDE_WORD.exec(rationale);
  if (said && sign) {
    const want = /^(long|buy)$/i.test(said[1]) ? 1 : -1;
    if (want !== sign) problems.push(`the rationale says ${said[1].toLowerCase()} but the order side is ${input.side}`);
  }
  const ticksOf = b => (b && b.ticks !== undefined && b.ticks !== null ? Number(b.ticks) : null);
  const sl = ticksOf(input.stopLossBracket);
  const tp = ticksOf(input.takeProfitBracket);
  for (const [name, t] of [['stopLossBracket', sl], ['takeProfitBracket', tp]]) {
    if (t !== null && !(Number.isInteger(t) && t > 0)) problems.push(`${name}.ticks must be a whole number of ticks above 0 (got ${t})`);
  }
  const spec = specOf(contractRoot(input.contractId));
  const stopM = STOP_PRICE.exec(rationale);
  const targetM = TARGET_PRICE.exec(rationale);
  const price = m => (m ? Number(m[1].replace(/,/g, '')) : null);
  const stop = price(stopM);
  const target = price(targetM);
  const type = String(input.type || '').toLowerCase();
  const entryField = type === 'limit' ? 'limitPrice' : type === 'stop' ? 'stopPrice' : null;
  const entry = entryField && input[entryField] !== undefined && input[entryField] !== null ? Number(input[entryField]) : null;
  if (spec) {
    const tick = spec.tickSize;
    for (const [name, x] of [['stop', stop], ['target', target], [entryField, entry]]) {
      if (x !== null && Number.isFinite(x) && !onTick(x, tick)) problems.push(`${name} ${x} is not on the ${tick} tick`);
    }
  }
  if (sign) {
    if (stop !== null && target !== null && Math.sign(target - stop) !== sign) {
      problems.push(`a ${sign > 0 ? 'long' : 'short'} needs the target ${sign > 0 ? 'above' : 'below'} the stop (stop ${stop}, target ${target})`);
    }
    if (entry !== null && stop !== null && Math.sign(entry - stop) !== sign) {
      problems.push(`the stop ${stop} is on the wrong side of the ${sign > 0 ? 'buy' : 'sell'} entry ${entry}`);
    }
    if (entry !== null && target !== null && Math.sign(target - entry) !== sign) {
      problems.push(`the target ${target} is on the wrong side of the ${sign > 0 ? 'buy' : 'sell'} entry ${entry}`);
    }
  }
  // Brackets vs the rationale's prices, within a tick of rounding.
  if (spec && !problems.length) {
    const tick = spec.tickSize;
    const near = (ticks, dist) => Math.abs(ticks - dist / tick) <= GATE.bracketToleranceTicks + 1e-6;
    if (entry !== null) {
      if (sl !== null && stop !== null && !near(sl, Math.abs(entry - stop))) {
        problems.push(`stopLossBracket.ticks ${sl} doesn't match the stop: ${fmtPrice(entry, tick)} to ${fmtPrice(stop, tick)} is ${Math.ceil(Math.abs(entry - stop) / tick - 1e-9)} ticks`);
      }
      if (tp !== null && target !== null && !near(tp, Math.abs(target - entry))) {
        problems.push(`takeProfitBracket.ticks ${tp} doesn't match the target: ${fmtPrice(entry, tick)} to ${fmtPrice(target, tick)} is ${Math.round(Math.abs(target - entry) / tick)} ticks`);
      }
    } else if (sl !== null && tp !== null && stop !== null && target !== null
      && Math.abs(sl + tp - Math.abs(target - stop) / tick) > GATE.bracketSpanToleranceTicks + 1e-6) {
      problems.push(`the brackets span ${sl + tp} ticks but the rationale's stop ${stop} to target ${target} is ${Math.round(Math.abs(target - stop) / tick)} ticks`);
    }
  }
  return problems.length
    ? `The order doesn't agree with itself: ${problems.join('; ')}. Fix the order or the rationale so both say the same trade.`
    : null;
}

/**
 * `record`: a composed entry's compose record (composed-reads passed): the plan is anchored to its bar, the setup
 * lane's (its briefing's closedAt), never to the bar of another lane that closed this cycle.
 * In a runner's cycle (autonomous, the cycle names its bar for the root's family: FTH_CYCLE_BARS), the time a plan for
 * this entry must be written at or after: the cycle bar's close (its bar briefing's closedAt when the briefing is on the
 * cycle's briefing bar), never before the bar opened. A plan from an earlier cycle (written while this bar was still
 * forming) is not this bar's. Outside a runner's cycle: null (planMaxAgeMin alone, as before). Entries only.
 */
function cyclePlanSince(config, root, { record = null } = {}) {
  if (!config.autonomous) return null;
  // A composed entry: anchored to its own record's bar (the setup lane's, the briefing's), never to another lane's bar
  // that closed with it (a 1m lane's): written since that bar's close.
  if (record) {
    const recBar = Date.parse(record.bar);
    if (!Number.isFinite(recBar)) return NaN;
    // Its close: the briefing's closedAt on that bar, else the bar's open plus its minutes (the briefing's, or the
    // record's lane: "3m"); neither readable, its open.
    let b = null;
    try { b = readBriefing(config.home, root); } catch (_err) { /* no briefing */ }
    const on = b && Date.parse(b.asOf) === recBar ? b : null;
    if (on && Number.isFinite(Date.parse(on.closedAt))) return Math.max(recBar, Date.parse(on.closedAt));
    const lane = /^(\d+)m$/.exec(String(record.lane || ''));
    const minutes = on && Number.isInteger(on.minutes) && on.minutes > 0 ? on.minutes : lane ? Number(lane[1]) : null;
    return minutes ? recBar + minutes * 60000 : recBar;
  }
  const bar = (config.cycleBars || {})[familyRoot(root)] || null;
  if (!bar) return null;
  const open = Date.parse(bar);
  // An unreadable bar time: no plan can be shown to be this bar's (NaN refuses every plan: fails closed).
  if (!Number.isFinite(open)) return NaN;
  let closed = NaN;
  try {
    const b = readBriefing(config.home, root);
    const on = briefingBarOf(config, root);
    if (b && on && Date.parse(b.asOf) === Date.parse(on)) closed = Date.parse(b.closedAt);
  } catch (_err) { /* no briefing: the bar's open */ }
  return Number.isFinite(closed) ? Math.max(open, closed) : open;
}

function checkPlan(input, dayEntries, now, config, record = null) {
  const cutoff = now.getTime() - config.planMaxAgeMin * 60000;
  const root = contractRoot(input.contractId);
  // A runner's cycle: the plan is this cycle's bar's (written since the bar closed; a composed entry's, its record's
  // bar), and within planMaxAgeMin.
  const since = cyclePlanSince(config, root, { record });
  const plan = dayEntries.find(e =>
    e.kind === 'plan' && entryTime(e) >= cutoff && (since === null || entryTime(e) >= since) && planMatches(e, input.contractId, root));
  if (plan) return null;
  const write = 'Write one with journal_add {kind:"plan", contractId, ...} (thesis, trigger, stop, target, size, $ risk) first.';
  if (since !== null) return `No journal plan for ${root} written for this cycle's bar (since ${Number.isFinite(since) ? new Date(since).toISOString() : 'its close, which can\'t be read'}) in the last ${config.planMaxAgeMin} min: a plan from an earlier bar is not this entry's. ${write}`;
  return `No journal plan for ${root} in the last ${config.planMaxAgeMin} min. ${write}`;
}

/** Why the market is closed for entries at `now`, or null: the session, holidays, early closes. */
function marketClosed(now, config = {}) {
  const day = tradingDayKey(now);
  if (config.closedDates && config.closedDates.has(day)) return `The exchange is closed for the trading day ${day} (FTH_CLOSED_DATES); no entries.`;
  if (config.calendarEnds && day > config.calendarEnds) {
    return `The exchange calendar ends ${config.calendarEnds}: no entries on later trading days until their CME holidays and early closes are added (FTH_CLOSED_DATES / FTH_EARLY_CLOSE_DATES, or scripts/lib/trading/exchange-calendar.js).`;
  }
  const until = config.earlyCloseDates && config.earlyCloseDates.has(day) ? EARLY_CLOSE_MIN : undefined;
  if (!inMarketHours(now, { until })) {
    return `New entries only during market hours (${MARKET_HOURS_LABEL}${until ? '; early close at 13:00 ET today' : ''}); no position may be held outside them.`;
  }
  return null;
}

function checkWindows(now, config) {
  return entryClock(config)(now);
}

function checkBlackouts(now, blackouts) {
  if (blackouts.error) return `Blackout file unreadable (${blackouts.error}); fix or remove it.`;
  const bad = blackouts.items.find(b => !(b && Number.isFinite(Date.parse(b.start)) && Number.isFinite(Date.parse(b.end))));
  if (bad) return `Blackout file unreadable (an entry without a valid start and end: ${JSON.stringify(bad).slice(0, 80)}); the user fixes the file (the blackouts_add tool only adds windows).`;
  const t = now.getTime();
  const hit = blackouts.items.find(b => {
    const s = Date.parse(b && b.start);
    const e = Date.parse(b && b.end);
    return Number.isFinite(s) && Number.isFinite(e) && t >= s && t < e;
  });
  return hit ? `News blackout until ${hit.end}${hit.reason ? ` (${hit.reason})` : ''}.` : null;
}

/**
 * The day's losing trades and losing streak from its reviews, on top of `carried` (prop-state.js carriedLossState: the
 * losses and streak an attempt carried into the day from before its first snapshot; null: none). lastLossMs: the last
 * loss's time (a review's, else the carried one's), from which the cooldown runs. Carried counts only ever add.
 */
function lossState(dayEntries, carried = null) {
  const reviews = liveReviews(dayEntries)
    .filter(e => reviewResult(e) !== null)
    .sort((a, b) => entryTime(a) - entryTime(b));
  const n = x => (Number.isInteger(x) && x > 0 ? x : 0);
  let streak = carried ? n(carried.streak) : 0;
  let lastLoss = null;
  let lastLossMs = carried && Number.isFinite(carried.lastLossMs) ? carried.lastLossMs : null;
  let losses = carried ? n(carried.losses) : 0;
  for (const r of reviews) {
    const result = reviewResult(r);
    if (result === 'loss') {
      streak += 1;
      losses += 1;
      lastLoss = r;
      lastLossMs = entryTime(r);
    } else if (result === 'win') {
      streak = 0;
    }
  }
  return { streak, losses, lastLoss, lastLossMs };
}

/** The managed-cycle refusal (a managed cycle: FTH_CYCLE_MANAGE). */
const MANAGED_CYCLE_REFUSAL = 'A managed cycle (it started with a position or working order open): manage only, no new entry, add or reversal; a new entry waits for a cycle that starts flat. Exits, stop moves, closes and cancels ([exit] or [protect]) still go.';

/**
 * `strategies` is the registry from strategies.js (loadStrategies). When it is
 * null the strategy check is skipped (tests of other checks); the hook and the
 * MCP gateway always pass it. `accounts` (accounts.js loadAccounts) are the
 * account profiles: a strategy that trades an account gets the hard `combine`
 * and `policy` checks (prop-state.js), which no setting can skip.
 */
function evaluateOrder({ input = {}, entries = [], now = new Date(), config, blackouts = { items: [] }, strategies = null, accounts = [], journalTruncated = false, transcriptPath = null }) {
  if (isRiskReducing(input.rationale)) {
    // The bracket rule (bracket-rule.js): a [protect] limit is a stand-alone target, refused here from the order alone;
    // a second [protect] stop is judged by the gateway, which reads the working stops. Hard: never skippable.
    const why = protectRefusal({ rationale: input.rationale, type: input.type }) || restingExitRefusal({ rationale: input.rationale, type: input.type });
    return { intent: 'risk-reducing', violations: why ? [{ check: 'bracket-only', message: why }] : [] };
  }

  const rationale = String(input.rationale || '');
  // The broker's tick specs: the translator's file of the selected broker under this harness home.
  const contractsFile = config.contractsFile !== undefined ? config.contractsFile : contractsFileFor(config.home);
  const specOf = brokerSpecs(contractsFile);
  const dayStart = tradingDayStart(now);
  const dayEntries = entriesSince(entries, dayStart);
  const skip = config.skipChecks || new Set();
  const violations = [];
  const add = (check, message) => {
    if (message && !skip.has(check)) violations.push({ check, message });
  };

  const setup = SETUP_TAG.exec(rationale);
  add('paper-mode', config.paper ? 'Paper mode (FTH_PAPER=1): no live entries. Journal the plan tagged paper instead.' : null);
  const oldest = entries.length ? entryTime(entries[0]) : NaN;
  add('journal-window', journalTruncated && !(oldest <= dayStart.getTime())
    ? 'The journal is too large to read back to the start of the trading day, so the gate cannot see today\'s history. Archive old journal entries.'
    : null);
  add('kill-switch', config.killSwitchFile && fs.existsSync(config.killSwitchFile)
    ? `Kill switch is on (${config.killSwitchFile}). No new entries until the user removes it.`
    : null);
  // Hard rule: a runner's cycle enters only while the runner holds its account's lock (one runner per account).
  const lockMsg = lockGateRefusal(config.accountLock, input.accountId);
  if (lockMsg) violations.push({ check: 'account-lock', message: lockMsg });
  // Hard rule: a managed cycle (FTH_CYCLE_MANAGE: the runner's, on this machine's opt-in) manages only. Risk-reducing
  // orders returned above, so exits, stop moves, closes and cancels go as always.
  if (config.cycleManage) violations.push({ check: 'managed-cycle', message: MANAGED_CYCLE_REFUSAL });
  add('setup-tag', setup ? null
    : 'Rationale must start with the strategy as setup:<name> (e.g. "setup:orb long ..."); the tag goes first. '
      + 'If this order exits or protects a position, start the rationale with [exit] or [protect].');
  if (setup && strategies) {
    add('strategy', checkStrategyForOrder(strategies, setup[1].toLowerCase(), contractRoot(input.contractId), now, input.side, config.selection));
  }
  // Hard rules, outside the skippable checks: the prop challenge's account and policy.
  const named = setup && strategies ? strategies.find(x => x.name === setup[1].toLowerCase()) : null;
  // Hard rule: an entry naming no known, valid strategy (an unknown or retired name, or none) has no timeframe of its
  // own, so it is checked against every lane of its contract: the skippable `strategy` check is not its only refusal.
  if (strategies && !(named && named.valid !== false)) {
    const anyLane = retiredLaneRefusalAny(config.home, { root: contractRoot(input.contractId), label: setup ? setup[1].toLowerCase() : null });
    if (anyLane) violations.push({ check: 'retired-lane', message: anyLane });
  }
  // Hard rule, keyed on the order (its tag, or a policy whose verdict trades it), outside the skippable checks and
  // whether or not the strategy document loads: a trade_lifecycle entry goes only on its compose record for this
  // cycle's bar and side, every read re-checked now (lifecycle-gate.js). It stands in for trigger-fired.
  const transcript = transcriptPath || config.cycleTranscript;
  // The briefing counts on the bar the runner's cycle decides, however long the cycle runs (a delegated cycle outlasts
  // its bar's validUntil); outside a cycle, while it holds at now (skill-lookups.js briefingHolds).
  const factsBar = briefingBarOf(config, contractRoot(input.contractId));
  // In index mode, a role's report counts only with the lookups this bar requires of it (see roles-ran below).
  const lookups = config.autonomous && config.roleSkills === 'index' ? lookupRule({ home: config.home, transcript, contractId: input.contractId, now, cycleBar: factsBar, laneBars: config.cycleLaneBars, cachedLookups: config.cycleCachedLookups || {} }) : null;
  // The approving report, read once for the facts and the size checks (a read that throws: the facts check refuses).
  let p2 = null;
  const p2Report = () => (p2 || (p2 = { r: approvedPhase2(transcript, config.cycle, config.cycleCached || [], lookups, config.cycleRoles || null) })).r;
  // Phase 2's approved size, where an approving report is known (roles-ran.js approvedSize; none readable: unknown here,
  // the phase2-size check refuses it): a composed entry is exactly the smaller of it and the record's (composed-reads).
  const p2Size = () => { try { const r = config.autonomous ? p2Report() : null; const a = r && !r.error ? approvedSize(r.text) : null; return a && !a.error ? a.size : null; } catch (_err) { return null; } };
  const composed = setup ? composedName({ setupName: setup[1].toLowerCase(), named, strategies, home: config.home, root: contractRoot(input.contractId) }) : null;
  let composedCheck = null;
  if (composed) {
    const doc = strategies ? strategies.find(x => x.name === composed && x.valid !== false) || null : null;
    // The bar the briefing is on (several lanes: FTH_CYCLE_BRIEFING_BARS over FTH_CYCLE_BARS), as compose_check reads it.
    // Inside a policy (a prop attempt's account layer), the record's size is a suggestion: the order is the translated
    // size (prop/size-translate.js, the one place), from the policy's latest verdict and the attempt's snapshot, as
    // order_plan built it; any other size is refused. Only the verdict sized on this record translates it: none (null),
    // and the [policy] check below refuses the entry.
    const translate = named && named.signal === 'policy' && named.account && doc ? (plan, spec, stated, rec) => {
      const v = latestVerdict(config.home, named.name, contractRoot(input.contractId));
      if (!v || !rec || v.record !== rec.id) return null;
      return translatorFor({
        home: config.home, root: contractRoot(input.contractId), policy: named, account: accounts.find(a => a.name === named.account) || null, strategy: doc,
        verdict: v, specOf, selected: config.selection ? config.selection.symbols : null, orderMax: brokerOrderLimit(contractsFile).maxOrderSize,
      })(plan, spec, stated);
    } : null;
    // Under a policy, its entry rule (its rulebook's `entry`, entry-rule.js) joins the re-check, as compose_check held it.
    const entryRule = named && named.signal === 'policy' ? entryRuleOf(named.entry) : null;
    composedCheck = composedRefusal({ name: composed, strategy: doc, home: config.home, root: contractRoot(input.contractId), input, now, cycleBars: { ...(config.cycleBars || {}), ...(config.cycleBriefingBars || {}) }, entries, specOf, approvedSize: p2Size(), translate, entryRule,
      // The setups its record may cite (strategies.js citedSetups): no registry, none (a cited record is refused).
      cited: strategies ? citedSetups(strategies, composed) : null });
    // `expired`: the record's time ran out (the cycle-timing count of entries lost to expiry: cycle-timing.js).
    if (composedCheck.message) violations.push({ check: 'composed-reads', message: composedCheck.message, ...(composedCheck.expired ? { expired: true } : {}) });
    // Inside a policy (the prop attempt's account layer): its verdict is the one sized on this very record.
    else if (named && named.signal === 'policy') {
      const v = latestVerdict(config.home, named.name, contractRoot(input.contractId));
      if (!v || v.record !== composedCheck.record.id) violations.push({ check: 'policy', message: `setup:${named.name}: the latest verdict is not the one sized on the compose record of ${composedCheck.record.at} (order_plan records it): plan the entry again.` });
    }
    // Hard rule (the owner's "if you miss the move don't enter late"): a composed entry goes only while the market is
    // still at its plan, by the latest local price (late-entry.js): beyond the plan's stop, or past its entry against
    // it by more than the configured share of the stop distance, it is a pass; no current price, refused (fails closed).
    if (!composedCheck.message) {
      const p = composedCheck.plan;
      const late = lateEntryCheck({ home: config.home, root: contractRoot(input.contractId), side: { buy: 'long', sell: 'short' }[String(input.side || '').toLowerCase()], entry: p.entry.price, stop: p.stop.price, target: p.target.price, briefing: composedCheck.briefing, now, share: GATE.lateEntryDriftShare, maxAgeMin: ageLimitOf(config), market: p.entry.type === 'market' });
      // `late`: the skip as logged (the plan's prices, the price at the skip): the replay report's counterfactual reads it.
      if (late) violations.push({ check: 'late-entry', message: `setup:${composed}: ${late.message}. Exits, protective stops and stop moves still go.`, late: { ...late.late, record: composedCheck.record ? composedCheck.record.id : null } });
    }
  }
  // D2 (the owner's "CHoCH at or above the trend"): a trade_lifecycle entry against the prevailing trend stands only on
  // the tier its frame needs among the record's re-checked reads (lifecycle-gate.js reversalAllowed); then the trend
  // rule is judged as a reversal's. Anything else (no record standing, a tier short): the trend rule as before.
  const composedSide = { buy: 'long', sell: 'short' }[String(input.side || '').toLowerCase()] || null;
  const composedReversal = Boolean(composedCheck && !composedCheck.message && composedSide
    && reversalAllowed({ home: config.home, root: contractRoot(input.contractId), side: composedSide, check: composedCheck.check, now, maxAgeMin: config.mtfMaxAgeMin }).ok);
  // Hard rule: a trend strategy never enters against the prevailing higher-timeframe trend
  // (mtf-state.js; the runner records the read every bar). A policy strategy's entry is judged
  // by the strategy whose setup its verdict trades.
  if (named && named.valid !== false) {
    const root = contractRoot(input.contractId);
    let judge = named;
    if (named.signal === 'policy') {
      const v = latestVerdict(config.home, named.name, root);
      judge = (v && strategies.find(x => x.name === v.component)) || { name: named.name, mtf: 'trend' };
    }
    // Hard rule: no entry, under any setup tag, on a timeframe whose runner lane lists a retired strategy (lanes.js
    // retireLanes: that lane enters nothing). A policy's entry is checked on its own timeframe.
    const retiredMsg = retiredLaneRefusal(config.home, { root, strategy: named.name, timeframe: named.timeframe });
    if (retiredMsg) violations.push({ check: 'retired-lane', message: retiredMsg });
    const msg = checkTrend(config.home, { root, side: input.side, style: composedReversal ? 'reversal' : judge.mtf || 'trend', strategy: judge.name, now, maxAgeMin: config.mtfMaxAgeMin });
    if (msg) violations.push({ check: 'mtf-trend', message: msg });
    // Hard rule: a rules strategy enters only on its own trigger, fired on the side ordered on a
    // recent bar (signal-state.js): no relabelled setup tag, no stale signal (age in bars of its own timeframe).
    // Hard rule: a setup a composed trade cites (strategies.js citingPolicies) enters only through that trade's compose
    // record (setup:trade_lifecycle, or its policy's tag), never under its own tag.
    const citing = named.signal === 'rules' ? citingPolicies(strategies, named.name) : [];
    if (citing.length) violations.push({ check: 'cited-setup', message: `setup:${named.name} is a setup ${composedOf(citing[0], strategies).join(', ')} cites (${citing.map(x => x.name).join(', ')}): compose it with compose_check (the setup read "${named.name} fired up|down") and enter on that record, never under setup:${named.name}. Exits and protective stops still go.` });
    if (named.signal === 'rules') {
      const fired = checkTrigger(config.home, { root, side: input.side, strategy: named.name, style: named.mtf || 'trend', timeframe: named.timeframe, now, maxAgeBars: config.signalMaxAgeBars, maxAgeCapMin: config.signalMaxAgeCapMin, maxAgeCeilingMin: config.signalMaxAgeCeilingMin, minConfluence: config.minConfluence });
      if (fired) violations.push({ check: 'trigger-fired', message: fired });
    }
  }
  // Hard rule: an entry is checked and sized with the broker's tick specs; none recorded (or unlike the table), no entry.
  const specRoot = contractRoot(input.contractId);
  if (!specOf(specRoot)) violations.push({ check: 'contract-specs', message: `${whyNoSpec(specOf, specRoot)}.` });
  else if (dayFrontMissing(contractsFile, specRoot)) violations.push({ check: 'contract-specs', message: `${dayFrontMissing(contractsFile, specRoot)}.` });
  // Hard rules: the size within the broker server's own max order size (its get_server_config answer, as the
  // translator recorded it; none recorded, no entry), and the dollar risk within the named strategy's
  // risk.max_risk_usd where it sets one (for a policy strategy, its own; order-limits.js).
  const sizeMsg = checkOrderSize(input, brokerOrderLimit(contractsFile));
  if (sizeMsg) violations.push({ check: 'max-order-size', message: sizeMsg });
  const stopPrices = [...rationale.matchAll(new RegExp(STOP_PRICE.source, 'gi'))].map(m => Number(m[1].replace(/,/g, '')));
  const riskMsg = checkRiskLimit({ input, stopPrices, strategy: named, specOf });
  if (riskMsg) violations.push({ check: 'max-risk', message: riskMsg });
  // A composed entry under a policy (setup:prop_portfolio): the composed strategy's own risk.max_risk_usd binds on the
  // size ordered too (the translation's cap, checked again here: defence in depth).
  const composedDoc = composed && strategies ? strategies.find(x => x.name === composed && x.valid !== false) || null : null;
  // Under a policy the cap is measured all in, as the translation sizes it (prop/size-translate.js allInRisk: the stop
  // plus the rulebook's slippage ticks at the tick value, plus the account's fees both ways, per contract).
  const policyCap = Boolean(!riskMsg && composedDoc && named && named.signal === 'policy' && composedDoc.risk && composedDoc.risk.max_risk_usd > 0);
  const capSpec = policyCap ? specOf(contractRoot(input.contractId)) : null;
  const capAcct = policyCap ? accounts.find(a => a.name === named.account) || null : null;
  const per = capSpec && capAcct && input.stopLossBracket ? allInRisk({ stopTicks: Number(input.stopLossBracket.ticks), tickValue: capSpec.tickValue, slipTicks: named.sizing ? named.sizing.stop_slippage_ticks : null, feePerSide: feePerSide(capAcct, contractRoot(input.contractId)) }) : NaN;
  // The floor stretch (prop/size-translate.js stretchedEntry, the translation's own rule): exactly the floor may go over
  // the composed cap, at most the rulebook's floor_stretch_max_usd all in, while the attempt is healthy (its snapshot);
  // any other size over the cap, or the floor when the attempt isn't healthy or it costs more, is refused as before.
  // Only on a whole-tick stop bracket (anything else: no stretch, the cap's own checks refuse it), priced at the farther
  // of the bracket and any `stop <price>` in the rationale, as the cap's own check counts it (order-limits.js
  // entryStopTicks: risk is never under-counted).
  const stretchTicks = policyCap && capSpec && Number.isInteger(Number(input.stopLossBracket && input.stopLossBracket.ticks)) ? entryStopTicks(input, stopPrices, capSpec).ticks : null;
  const stretchPer = Number.isInteger(stretchTicks) && capAcct ? allInRisk({ stopTicks: stretchTicks, tickValue: capSpec.tickValue, slipTicks: named.sizing ? named.sizing.stop_slippage_ticks : null, feePerSide: feePerSide(capAcct, contractRoot(input.contractId)) }) : NaN;
  const stretched = Number.isInteger(stretchTicks)
    ? stretchedEntry({ home: config.home, policy: named, account: capAcct, root: contractRoot(input.contractId), size: input.size, perContract: stretchPer, capUsd: composedDoc.risk.max_risk_usd, specOf }) : null;
  const stretchOk = Boolean(stretched && stretched.ok);
  const stretchWhy = stretched && stretched.why ? ` (${stretched.why})` : '';
  const composedRisk = !riskMsg && composedDoc && composedDoc !== named && !stretchOk ? checkRiskLimit({ input, stopPrices, strategy: composedDoc, specOf }) : null;
  if (composedRisk) violations.push({ check: 'max-risk', message: `${composedRisk}${stretchWhy}` });
  else if (policyCap && !stretchOk) {
    const all = Number(input.size) * per;
    if (!(all <= composedDoc.risk.max_risk_usd + 1e-9)) {
      violations.push({ check: 'max-risk', message: `setup:${composed}: ${input.size} ${contractRoot(input.contractId)} risk ${Number.isFinite(all) ? `$${all.toFixed(2)} all in (the stop, a tick of slippage and fees both ways)` : 'an all-in loss that can\'t be worked out'}, over its risk.max_risk_usd $${composedDoc.risk.max_risk_usd}${stretchWhy}: order_plan gives the size.` });
    }
  }
  if (named && named.account) {
    violations.push(...propViolations(config.home, { strategy: named, account: accounts.find(a => a.name === named.account), input, now, entries: dayEntries, journal: entries, specOf, selected: config.selection ? config.selection.symbols : null, strategies }));
  } else {
    // While an attempt runs, every entry (tagged or not) must come from a
    // policy strategy that trades it, so none skips the floor, the daily
    // limits, or the size budget.
    const running = runningAttempts(config.home);
    if (running.length) {
      violations.push({ check: 'combine', message: `A ${running.join(', ')} attempt is running: only a policy strategy that trades it (account: ${running[0]}) may enter. Stand aside: whether to end the attempt (node scripts/combine.js stop --account ${running[0]}) is the user's decision, never an agent's.` });
    }
  }

  // Every entry carries its stop as its stopLossBracket: a stop stated only in the rationale isn't one.
  add('stop-defined', isStopBracket(input.stopLossBracket) ? null : STOP_BRACKET_REQUIRED);

  add('order-consistency', checkConsistency(input, rationale, specOf));
  // The model read how to trade before trading (Claude Code transcripts; skills-loaded.js).
  // In index mode (the default, FTH_ROLE_SKILLS not full) the situational skills this bar's briefing triggers too (skills-loaded.js).
  // The cycle's lanes unreadable (FTH_CYCLE_LANE_BARS set but not readable): every one marked for the head trader.
  // Claude Code's head trader in index mode (the runner config's headSkillsInPrompt): the skills its prompt addition
  // embeds, only on the runner's attestation for this cycle, checked now against that file, the skills' current text and
  // this run's own transcript (head-prompt.js claudeAttested; a hook's, that run's session). Then the head trader's
  // index mode applies as opencode's: its situational skills are required, and its skill_lookup reads count as loads.
  // Its roles load their skills as before (FTH_ROLE_SKILLS full). No attestation, or anything off: none, as before.
  const att = config.autonomous && config.headPromptAttestation ? parseAttestation(config.headPromptAttestation) : null;
  const claudeHead = att && att.harness === 'claude'
    ? claudeAttested(att, HARNESS_ROOT, { stream: config.cycleTranscript, hook: transcriptPath, cycle: require('./check-order').cycleId({ FTH_CYCLE_ID: config.cycleIdGiven || '', FTH_CYCLE_TRANSCRIPT: config.cycleTranscript || '' }) }) : [];
  const claudeLooked = claudeHead.length ? [...(loadedSkills(transcript, claudeLookupsInTranscript) || [])] : [];
  // The composed triggers (the head trader's own reads) apply to a composed entry only.
  const table = composed ? SITUATIONAL : SITUATIONAL.filter(e => !e.taughtIn);
  const situational = !(config.autonomous && (config.roleSkills === 'index' || claudeHead.length)) ? []
    : config.cycleLaneBars === null ? headSituationalSkills(table)
      : situationalSkills(briefingFacts(config.home, contractRoot(input.contractId), now, config.cycleLaneBars, factsBar), table);
  // A composed entry reads trade-lifecycle in place of the strategy skills (no scan fired for it).
  const required = composed ? REQUIRED_FOR_COMPOSED : REQUIRED_FOR_ENTRY;
  // opencode's head trader in index mode: the skills its prompt embeds count as loaded, only on the runner's attestation
  // (FTH_HEAD_PROMPT) checked now against the run's config file and the skills' current text (head-prompt.js), and only
  // for the runner's own cycle transcript (a hook's transcript is another harness's session). Anything off: none.
  const embedded = config.autonomous && config.roleSkills === 'index' && !transcriptPath && config.headPromptAttestation
    ? attestedSkills(parseAttestation(config.headPromptAttestation), HARNESS_ROOT, { transcript }) : [];
  // The skills the head trader loaded in its own run, as the runner recorded them after it in the cycle's role record
  // (runner-roles.js readHeadSkills: derived in code from that run's transcript). The runner's entry runs the
  // trade-executor as a session of its own (runner-entry.js), whose transcript loads none: the cycle's decider's loads
  // count from the record. Only for the runner's own cycle transcript (a hook's is another harness's session); no
  // record, or none recorded: the transcript alone decides, as before.
  const headLoaded = config.autonomous && !transcriptPath && config.cycleRoles ? readHeadSkills(config.cycleRoles) : [];
  const counted = [...new Set([...embedded, ...headLoaded, ...claudeHead, ...claudeLooked])];
  add('skills-loaded', checkSkillsLoaded(transcript, [...required, ...situational.filter(s => !required.includes(s))], counted));
  // And, read before an entry only, how to judge the setup and write its plan (REQUIRED_AT_ENTRY; unreadable: refused).
  add('skills-at-entry', checkSkillsAtEntry(transcript, undefined, counted));
  // An autonomous cycle's roles reported before its entry: the analysts' and risk-manager's skills reached the plan.
  // In index mode (the default, FTH_ROLE_SKILLS not full), a role's report counts only with the lookups this bar requires of it.
  // A role served from the report cache: the lookups its cached report's own call made count (cycleCachedLookups).
  // The roles the runner ran itself (its role record, FTH_CYCLE_ROLES: runner-roles.js) are judged with the transcript's.
  add('roles-ran', config.autonomous ? checkRolesRan(transcript, config.cycle, config.cycleCached || [], lookups, config.cycleRoles || null) : null);
  // Hard rule: the facts phase 2 approved on, checked against this cycle's bar briefing (fact-claims.js, R29): a
  // false one, or stated ones that can't be checked, refuse the entry. The report is the one roles-ran approves on:
  // the same selection (roles-ran assessRound), the same cached list and the same lookups.
  // The cycle's bar per root as the briefing is on it (several lanes: FTH_CYCLE_BRIEFING_BARS, the first lane's, over
  // FTH_CYCLE_BARS, which names the lane bar that closed): the briefing the facts are checked against.
  const factsBars = { ...(config.cycleBars || {}), ...(config.cycleBriefingBars || {}) };
  const factsMsg = config.autonomous ? factsRefusal({ report: p2Report, home: config.home, root: contractRoot(input.contractId), cycleBars: factsBars, now, order: factsOrder(input, setup, named, config.home, composedCheck) }) : null;
  if (factsMsg) violations.push({ check: 'phase2-facts', message: factsMsg });
  // Hard rule, tighten-only: the entry's size at most the size that report approved (roles-ran.js sizeRefusal: none
  // readable refuses); no approval required (not a cycle), none checked.
  let p2SizeMsg = null;
  if (config.autonomous) {
    try { p2SizeMsg = sizeRefusal(p2Report(), input.size); } catch (err) { p2SizeMsg = `the phase-2 size check failed (${err.message}): no entry (fails closed)`; }
  }
  if (p2SizeMsg) violations.push({ check: 'phase2-size', message: p2SizeMsg });
  // Hard rule: no entry on stale data (the owner's "data accurate and not stale"): the briefing's bar closed more than
  // the signal age limit of its own bars ago, however long the cycle ran (briefingAgeRefusal).
  const staleMsg = briefingAgeRefusal(config, contractRoot(input.contractId), now);
  if (staleMsg) violations.push({ check: 'briefing-age', message: staleMsg });
  add('plan-required', checkPlan(input, dayEntries, now, config, composedCheck && !composedCheck.message ? composedCheck.record : null));
  // Hard rule, outside the skippable checks: entries only during market hours.
  const closed = marketClosed(now, config);
  if (closed) violations.push({ check: 'market-hours', message: closed });
  add('time-window', checkWindows(now, config));
  add('blackout', checkBlackouts(now, blackouts));

  // With the losses a running attempt carried into the day (prop-state.js carriedLossState): they only add.
  const { streak, losses, lastLossMs } = lossState(dayEntries, carriedLossState(config.home, now));
  if (streak >= config.maxConsecutiveLosses && lastLossMs !== null) {
    const remaining = lastLossMs + config.lossCooldownMin * 60000 - now.getTime();
    add('loss-streak', remaining > 0
      ? `${streak} losses in a row. Cooling down for ${fmtMin(remaining)} more; use the time to write a lesson.`
      : null);
  }
  add('daily-loss-count', losses >= config.maxDailyLosses
    ? `${losses} losing trades this trading day (limit ${config.maxDailyLosses}). Done until 17:00 CT.`
    : null);

  const root = contractRoot(input.contractId);
  const entered = successfulEntries(dayEntries).filter(e => mayBeRoot(e.contractId, root)).length;
  const reviewed = liveReviews(dayEntries, root).length;
  const enteredAll = successfulEntries(dayEntries).length;
  add('review-before-next-entry', entered > reviewed
    ? `${entered - reviewed} earlier entr${entered - reviewed === 1 ? 'y has' : 'ies have'} no review. `
      + 'Manage or close it, then journal_add {kind:"review", tags:["result:win|loss|scratch|nofill", "setup:<name>"]}.'
    : null);
  add('max-entries', config.maxEntriesPerDay > 0 && enteredAll >= config.maxEntriesPerDay
    ? `${enteredAll} entries this trading day (limit ${config.maxEntriesPerDay}).`
    : null);

  // A composed entry the gate let through: the record it judged, its expiry, its entry, stop and target prices (the
  // runner re-anchors a fill's stop to the plan's and flattens a fill beyond it: lifecycle-runner.js fillGuard), for
  // the gateway's stamp.
  const composedOut = composedCheck && !composedCheck.message ? { composed: { record: composedCheck.record.id, expiresAt: composedCheck.expiresAt, entry: composedCheck.plan.entry.price, stop: composedCheck.plan.stop.price, target: composedCheck.plan.target.price, side: { buy: 'long', sell: 'short' }[String(input.side || '').toLowerCase()] || null } } : {};
  return { intent: 'entry', violations, ...composedOut };
}

/**
 * modify_order can resize a working order, which would add exposure without
 * any entry check. Price changes (moving a stop or target) stay allowed so
 * positions can always be managed; size changes must go through cancel_order
 * plus a new, gated place_order (or partial_close_position to reduce).
 */
function evaluateModify({ input = {}, config }) {
  const skip = (config && config.skipChecks) || new Set();
  const violations = [];
  // A size change labelled [exit]/[protect] (cutting a protective order after
  // a partial exit) goes to the MCP gateway, which checks it is a decrease.
  const size = input.size;
  const badSize = size !== undefined && size !== null && !(Number.isInteger(Number(size)) && Number(size) >= 1);
  if (size !== undefined && size !== null && !skip.has('modify-size') && (badSize || !isRiskReducing(input.reason))) {
    violations.push({
      check: 'modify-size',
      message: 'modify_order may change prices only, unless the reason starts with [exit] or [protect] (cutting a '
        + 'protective order after a partial exit; the gateway checks it is a decrease). To add size, place a new order.',
    });
  }
  // Hard rule: a working composed entry (the gateway stamped it with its record's entry price) is never repriced worse
  // than that price for its side: its stop would land short of the level the reads named. Stops and targets (other
  // orders) and a better price move freely; exits never reach this (a modify of an exit order isn't in entry-orders).
  const stamped = composedEntryStamp(config && config.home, input.orderId);
  const price = input.limitPrice === undefined || input.limitPrice === null || input.limitPrice === '' ? null : Number(input.limitPrice);
  if (stamped && price !== null) {
    const worse = !Number.isFinite(price) || (stamped.side === 'long' ? price > stamped.entry + 1e-9 : stamped.side === 'short' ? price < stamped.entry - 1e-9 : true);
    if (worse) violations.push({ check: 'composed-reprice', message: `order ${input.orderId} is a trade_lifecycle entry at its record's ${stamped.entry} (${stamped.side || 'unknown side'}): a limit of ${input.limitPrice} is worse for it, and its stop would land short of the level its reads named. Keep it, improve it, or cancel it.` });
  }
  return { intent: 'modify', violations };
}

/** The gateway's stamp on a working composed entry (entry-orders.json): { entry, side }, or null. */
function composedEntryStamp(home, orderId) {
  if (!home || orderId === undefined || orderId === null) return null;
  try {
    const e = require('../harness-run').entryOrders(home).find(x => String(x.orderId) === String(orderId));
    return e && e.composed && Number.isFinite(e.composed.entry) ? { entry: e.composed.entry, side: e.composed.side || null } : null;
  } catch (_err) {
    return null;
  }
}

function formatBlock(violations) {
  return [
    'Blocked by trading harness (order gate). Do not work around this; fix the cause or stand aside:',
    ...violations.map(v => `- [${v.check}] ${v.message}`),
  ].join('\n');
}

module.exports = {
  STOP_PRICE,
  SETUP_TAG,
  marketClosed,
  isRiskReducing,
  checkConsistency,
  liveReviews,
  successfulEntries,
  lossState,
  evaluateOrder,
  evaluateModify,
  MANAGED_CYCLE_REFUSAL,
  formatBlock,
  factsOrder,
  cyclePlanSince,
};
