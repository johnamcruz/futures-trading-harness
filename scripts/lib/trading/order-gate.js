'use strict';

/**
 * Pure order-gate rules. Given a place_order request, the journal, the clock,
 * and the config, decide whether the harness lets the order reach the broker MCP server.
 *
 * Orders are classified by the first token of `rationale`:
 *   [exit] ...     closes or reduces a position          -> never gated
 *   [protect] ...  protective stop / target for a fill   -> never gated
 *   anything else  a new entry                           -> every check below
 * The MCP server still enforces its own size and loss limits on all of them.
 */

const { tradingDayStart, parseWindows, inWindow, inMarketHours, tradingDayKey, EARLY_CLOSE_MIN, MARKET_HOURS_LABEL } = require('./clock');
const { entriesSince, entryTime, hasTag, reviewResult, contractRoot } = require('./journal');
const fs = require('fs');
const { checkStrategyForOrder } = require('./strategies');
const { propViolations, runningAttempts, latestVerdict } = require('./prop-state');
const { checkTrend } = require('./mtf-state');
const { checkTrigger } = require('./signal-state');
const { checkSkillsLoaded } = require('./skills-loaded');
const { specFor } = require('./contracts');

const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;
// The setup tag must open the rationale, so text like "not setup:orb" can't satisfy it.
const SETUP_TAG = /^\s*setup:([a-z0-9][a-z0-9_-]*)\b/i;
// "stop 21450.25", "stop at 21450", "stop: 21450" - a number right after the word.
const STOP_IN_TEXT = /\bstop(?:\s+at)?\s*[:=@]?\s*\d+(?:\.\d+)?\b/i;
// The same, capturing the price; a number followed by a unit (40 ticks, 2R, 10 pts) is not a price.
// Thousands separators are allowed (21,480.25); a ratio (2:1) or an ATR multiple is not a price either.
const PRICE_AFTER = word => new RegExp(`\\b${word}(?:\\s+at)?\\s*[:=@]?\\s*(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\b(?![,.]?\\d)(?!\\s*(?:ticks?|pts?|points?|r\\b|x\\b|%|atr\\b|:\\s*\\d))`, 'i');
const STOP_PRICE = PRICE_AFTER('stop');
const TARGET_PRICE = PRICE_AFTER('target');
// The side named right after the tag: "setup:orb long ...".
const SIDE_WORD = /^\s*setup:[a-z0-9_-]+\s+(long|short|buy|sell)\b/i;

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
    && (!root || !e.contractId || contractRoot(e.contractId) === root));
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
function checkConsistency(input, rationale) {
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
  const spec = specFor(contractRoot(input.contractId));
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
  const until = config.earlyCloseDates && config.earlyCloseDates.has(day) ? EARLY_CLOSE_MIN : undefined;
  if (!inMarketHours(now, { until })) {
    return `New entries only during market hours (${MARKET_HOURS_LABEL}${until ? '; early close at 13:00 ET today' : ''}); no position may be held outside them.`;
  }
  return null;
}

function checkWindows(now, config) {
  const hours = parseWindows(config.entryHours || '');
  if (hours.errors.length > 0) return `FTH_ENTRY_HOURS has invalid entries (${hours.errors.join(', ')}); fix the config.`;
  if (hours.windows.length && !hours.windows.some(w => inWindow(now, w))) {
    return `New entries only during ${hours.windows.map(w => w.label).join(', ')} (FTH_ENTRY_HOURS).`;
  }
  const { windows, errors } = parseWindows(config.noEntryWindows);
  if (errors.length > 0) return `FTH_NO_ENTRY_WINDOWS has invalid entries (${errors.join(', ')}); fix the config.`;
  const hit = windows.find(w => inWindow(now, w));
  return hit ? `New entries are not allowed during ${hit.label}.` : null;
}

function checkBlackouts(now, blackouts) {
  if (blackouts.error) return `Blackout file unreadable (${blackouts.error}); fix or remove it.`;
  const bad = blackouts.items.find(b => !(b && Number.isFinite(Date.parse(b.start)) && Number.isFinite(Date.parse(b.end))));
  if (bad) return `Blackout file unreadable (an entry without a valid start and end: ${JSON.stringify(bad).slice(0, 80)}); fix it with scripts/blackouts.js.`;
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
  add('setup-tag', setup ? null
    : 'Rationale must start with the strategy as setup:<name> (e.g. "setup:orb long ..."); the tag goes first. '
      + 'If this order exits or protects a position, start the rationale with [exit] or [protect].');
  if (setup && strategies) {
    add('strategy', checkStrategyForOrder(strategies, setup[1].toLowerCase(), contractRoot(input.contractId), now, input.side));
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
    const msg = checkTrend(config.home, { root, side: input.side, style: judge.mtf || 'trend', strategy: judge.name, now, maxAgeMin: config.mtfMaxAgeMin });
    if (msg) violations.push({ check: 'mtf-trend', message: msg });
    // Hard rule: a rules strategy enters only on its own trigger, fired on the side ordered on a
    // recent bar (signal-state.js): no relabelled setup tag, no stale signal.
    if (named.signal === 'rules') {
      const fired = checkTrigger(config.home, { root, side: input.side, strategy: named.name, style: named.mtf || 'trend', timeframe: named.timeframe, now, maxAgeMin: config.signalMaxAgeMin, minConfluence: config.minConfluence });
      if (fired) violations.push({ check: 'trigger-fired', message: fired });
    }
  }
  if (named && named.account) {
    violations.push(...propViolations(config.home, { strategy: named, account: accounts.find(a => a.name === named.account), input, now, entries: dayEntries }));
  } else {
    // While an attempt runs, every entry (tagged or not) must come from a
    // policy strategy that trades it, so none skips the floor, the daily
    // limits, or the size budget.
    const running = runningAttempts(config.home);
    if (running.length) {
      violations.push({ check: 'combine', message: `A ${running.join(', ')} attempt is running: only a policy strategy that trades it (account: ${running[0]}) may enter. Stand aside: whether to end the attempt (node scripts/combine.js stop --account ${running[0]}) is the user's decision, never an agent's.` });
    }
  }

  const bracket = input.stopLossBracket && Number(input.stopLossBracket.ticks) > 0;
  add('stop-defined', bracket || STOP_IN_TEXT.test(rationale) ? null
    : 'Entry has no stop: add stopLossBracket, or state the stop price in the rationale ("stop 21450.25") '
      + 'and place a [protect] stop order right after the fill.');

  add('order-consistency', checkConsistency(input, rationale));
  // The model read how to trade before trading (Claude Code transcripts; skills-loaded.js).
  add('skills-loaded', checkSkillsLoaded(transcriptPath));
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
  const entered = successfulEntries(dayEntries).filter(e => !e.contractId || contractRoot(e.contractId) === root).length;
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
};
