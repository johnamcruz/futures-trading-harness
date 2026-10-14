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
const { entriesSince, entryTime, hasTag, reviewResult, contractRoot, mayBeRoot } = require('./journal');
const fs = require('fs');
const { checkStrategyForOrder } = require('./strategies');
const { propViolations, runningAttempts, latestVerdict } = require('./prop-state');
const { checkTrend } = require('./mtf-state');
const { checkTrigger, retiredLaneRefusal } = require('./signal-state');
const { checkSkillsLoaded, REQUIRED_FOR_ENTRY, situationalSkills } = require('./skills-loaded');
const { checkRolesRan, approvedPhase2 } = require('./roles-ran');
const { lookupRule, briefingFacts } = require('./skill-lookups');
const { gateRefusal: factsRefusal } = require('./fact-claims');
const { brokerSpecs, contractsFileFor, whyNoSpec, brokerOrderLimit, dayFrontMissing } = require('./broker-specs');
const { checkOrderSize, checkRiskLimit } = require('./order-limits');
const { lockGateRefusal } = require('../account-lock');

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

/** True when `b` is a stop bracket: {ticks: a whole number above 0, type: "stop" | "trailing_stop"}. */
function isStopBracket(b) {
  return Boolean(b) && typeof b === 'object' && typeof b.ticks === 'number' && Number.isInteger(b.ticks) && b.ticks > 0
    && STOP_BRACKET_TYPES.has(b.type);
}

/**
 * The order's own setup for the facts check (fact-claims.js): { strategy, side } from its setup tag and side; a policy
 * strategy's is the component its latest verdict trades. strategy null when the order names none.
 */
function factsOrder(input, setup, named, home) {
  const side = { buy: 'long', sell: 'short' }[String(input.side || '').toLowerCase()] || null;
  if (!setup) return { strategy: null, side };
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
 * names a different contract doesn't count.
 */
function liveReviews(entries, root = null) {
  return entries.filter(e => e.kind === 'review' && !hasTag(e, 'paper')
    && (reviewResult(e) !== null || hasTag(e, 'result:nofill'))
    && (!root || mayBeRoot(e.contractId, root)));
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
    const near = (ticks, dist) => Math.abs(ticks - dist / tick) <= 1 + 1e-6;
    if (entry !== null) {
      if (sl !== null && stop !== null && !near(sl, Math.abs(entry - stop))) {
        problems.push(`stopLossBracket.ticks ${sl} doesn't match the stop: ${fmtPrice(entry, tick)} to ${fmtPrice(stop, tick)} is ${Math.ceil(Math.abs(entry - stop) / tick - 1e-9)} ticks`);
      }
      if (tp !== null && target !== null && !near(tp, Math.abs(target - entry))) {
        problems.push(`takeProfitBracket.ticks ${tp} doesn't match the target: ${fmtPrice(entry, tick)} to ${fmtPrice(target, tick)} is ${Math.round(Math.abs(target - entry) / tick)} ticks`);
      }
    } else if (sl !== null && tp !== null && stop !== null && target !== null
      && Math.abs(sl + tp - Math.abs(target - stop) / tick) > 2 + 1e-6) {
      problems.push(`the brackets span ${sl + tp} ticks but the rationale's stop ${stop} to target ${target} is ${Math.round(Math.abs(target - stop) / tick)} ticks`);
    }
  }
  return problems.length
    ? `The order doesn't agree with itself: ${problems.join('; ')}. Fix the order or the rationale so both say the same trade.`
    : null;
}

function checkPlan(input, dayEntries, now, config) {
  const cutoff = now.getTime() - config.planMaxAgeMin * 60000;
  const root = contractRoot(input.contractId);
  const plan = dayEntries.find(e =>
    e.kind === 'plan' && entryTime(e) >= cutoff && planMatches(e, input.contractId, root));
  return plan ? null
    : `No journal plan for ${root} in the last ${config.planMaxAgeMin} min. `
      + 'Write one with journal_add {kind:"plan", contractId, ...} (thesis, trigger, stop, target, size, $ risk) first.';
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

function lossState(dayEntries) {
  const reviews = liveReviews(dayEntries)
    .filter(e => reviewResult(e) !== null)
    .sort((a, b) => entryTime(a) - entryTime(b));
  let streak = 0;
  let lastLoss = null;
  let losses = 0;
  for (const r of reviews) {
    const result = reviewResult(r);
    if (result === 'loss') {
      streak += 1;
      losses += 1;
      lastLoss = r;
    } else if (result === 'win') {
      streak = 0;
    }
  }
  return { streak, losses, lastLoss };
}

/**
 * `strategies` is the registry from strategies.js (loadStrategies). When it is
 * null the strategy check is skipped (tests of other checks); the hook and the
 * MCP gateway always pass it. `accounts` (accounts.js loadAccounts) are the
 * account profiles: a strategy that trades an account gets the hard `combine`
 * and `policy` checks (prop-state.js), which no setting can skip.
 */
function evaluateOrder({ input = {}, entries = [], now = new Date(), config, blackouts = { items: [] }, strategies = null, accounts = [], journalTruncated = false, transcriptPath = null }) {
  if (isRiskReducing(input.rationale)) return { intent: 'risk-reducing', violations: [] };

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
  add('setup-tag', setup ? null
    : 'Rationale must start with the strategy as setup:<name> (e.g. "setup:orb long ..."); the tag goes first. '
      + 'If this order exits or protects a position, start the rationale with [exit] or [protect].');
  if (setup && strategies) {
    add('strategy', checkStrategyForOrder(strategies, setup[1].toLowerCase(), contractRoot(input.contractId), now, input.side, config.selection));
  }
  // Hard rules, outside the skippable checks: the prop challenge's account and policy.
  const named = setup && strategies ? strategies.find(x => x.name === setup[1].toLowerCase()) : null;
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
    const msg = checkTrend(config.home, { root, side: input.side, style: judge.mtf || 'trend', strategy: judge.name, now, maxAgeMin: config.mtfMaxAgeMin });
    if (msg) violations.push({ check: 'mtf-trend', message: msg });
    // Hard rule: a rules strategy enters only on its own trigger, fired on the side ordered on a
    // recent bar (signal-state.js): no relabelled setup tag, no stale signal (age in bars of its own timeframe).
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
  const transcript = transcriptPath || config.cycleTranscript;
  // In index mode (the default, FTH_ROLE_SKILLS not full) the situational skills this bar's briefing triggers too (skills-loaded.js).
  const situational = config.autonomous && config.roleSkills === 'index' ? situationalSkills(briefingFacts(config.home, contractRoot(input.contractId), now)) : [];
  add('skills-loaded', checkSkillsLoaded(transcript, [...REQUIRED_FOR_ENTRY, ...situational.filter(s => !REQUIRED_FOR_ENTRY.includes(s))]));
  // An autonomous cycle's roles reported before its entry: the analysts' and risk-manager's skills reached the plan.
  // In index mode (the default, FTH_ROLE_SKILLS not full), a role's report counts only with the lookups this bar requires of it.
  const lookups = config.autonomous && config.roleSkills === 'index' ? lookupRule({ home: config.home, transcript, contractId: input.contractId, now }) : null;
  add('roles-ran', config.autonomous ? checkRolesRan(transcript, config.cycle, config.cycleCached || [], lookups) : null);
  // Hard rule: the facts phase 2 approved on, checked against this cycle's bar briefing (fact-claims.js, R29): a
  // false one, or stated ones that can't be checked, refuse the entry. The report is the one roles-ran approves on:
  // the same selection (roles-ran assessRound), the same cached list and the same lookups.
  const factsMsg = config.autonomous ? factsRefusal({ report: () => approvedPhase2(transcript, config.cycle, config.cycleCached || [], lookups), home: config.home, root: contractRoot(input.contractId), cycleBars: config.cycleBars, now, order: factsOrder(input, setup, named, config.home) }) : null;
  if (factsMsg) violations.push({ check: 'phase2-facts', message: factsMsg });
  add('plan-required', checkPlan(input, dayEntries, now, config));
  // Hard rule, outside the skippable checks: entries only during market hours.
  const closed = marketClosed(now, config);
  if (closed) violations.push({ check: 'market-hours', message: closed });
  add('time-window', checkWindows(now, config));
  add('blackout', checkBlackouts(now, blackouts));

  const { streak, losses, lastLoss } = lossState(dayEntries);
  if (streak >= config.maxConsecutiveLosses && lastLoss) {
    const remaining = entryTime(lastLoss) + config.lossCooldownMin * 60000 - now.getTime();
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

  return { intent: 'entry', violations };
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
  return { intent: 'modify', violations };
}

function formatBlock(violations) {
  return [
    'Blocked by trading harness (order gate). Do not work around this; fix the cause or stand aside:',
    ...violations.map(v => `- [${v.check}] ${v.message}`),
  ].join('\n');
}

module.exports = {
  STOP_PRICE,
  marketClosed,
  isRiskReducing,
  checkConsistency,
  liveReviews,
  successfulEntries,
  lossState,
  evaluateOrder,
  evaluateModify,
  formatBlock,
  factsOrder,
};
