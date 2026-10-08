'use strict';

/**
 * Pure order-gate rules. Given a place_order request, the journal, the clock,
 * and the config, decide whether the harness lets the order reach projectx-mcp.
 *
 * Orders are classified by the first token of `rationale`:
 *   [exit] ...     closes or reduces a position          -> never gated
 *   [protect] ...  protective stop / target for a fill   -> never gated
 *   anything else  a new entry                           -> every check below
 * The MCP server still enforces its own size and loss limits on all of them.
 */

const { tradingDayStart, parseWindows, inWindow } = require('./clock');
const { entriesSince, entryTime, hasTag, reviewResult, contractRoot } = require('./journal');
const fs = require('fs');
const { checkStrategyForOrder } = require('./strategies');

const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;
// The setup tag must open the rationale, so text like "not setup:orb" can't satisfy it.
const SETUP_TAG = /^\s*setup:([a-z0-9][a-z0-9_-]*)\b/i;
// "stop 21450.25", "stop at 21450", "stop: 21450" - a number right after the word.
const STOP_IN_TEXT = /\bstop(?:\s+at)?\s*[:=@]?\s*\d+(?:\.\d+)?\b/i;

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

function checkPlan(input, dayEntries, now, config) {
  const cutoff = now.getTime() - config.planMaxAgeMin * 60000;
  const root = contractRoot(input.contractId);
  const plan = dayEntries.find(e =>
    e.kind === 'plan' && entryTime(e) >= cutoff && planMatches(e, input.contractId, root));
  return plan ? null
    : `No journal plan for ${root} in the last ${config.planMaxAgeMin} min. `
      + 'Write one with journal_add {kind:"plan", contractId, ...} (thesis, trigger, stop, target, size, $ risk) first.';
}

function checkWindows(now, config) {
  const { windows, errors } = parseWindows(config.noEntryWindows);
  if (errors.length > 0) return `FTH_NO_ENTRY_WINDOWS has invalid entries (${errors.join(', ')}); fix the config.`;
  const hit = windows.find(w => inWindow(now, w));
  return hit ? `New entries are not allowed during ${hit.label}.` : null;
}

function checkBlackouts(now, blackouts) {
  if (blackouts.error) return `Blackout file unreadable (${blackouts.error}); fix or remove it.`;
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
 * MCP gateway always pass it.
 */
function evaluateOrder({ input = {}, entries = [], now = new Date(), config, blackouts = { items: [] }, strategies = null, journalTruncated = false }) {
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
    : 'Rationale must name the strategy as setup:<name> (e.g. setup:orb). '
      + 'If this order exits or protects a position, start the rationale with [exit] or [protect].');
  if (setup && strategies) {
    add('strategy', checkStrategyForOrder(strategies, setup[1].toLowerCase(), contractRoot(input.contractId), now, input.side));
  }

  const bracket = input.stopLossBracket && Number(input.stopLossBracket.ticks) > 0;
  add('stop-defined', bracket || STOP_IN_TEXT.test(rationale) ? null
    : 'Entry has no stop: add stopLossBracket, or state the stop price in the rationale ("stop 21450.25") '
      + 'and place a [protect] stop order right after the fill.');

  add('plan-required', checkPlan(input, dayEntries, now, config));
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
  if (input.size !== undefined && input.size !== null && !skip.has('modify-size') && !isRiskReducing(input.reason)) {
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
  isRiskReducing,
  liveReviews,
  successfulEntries,
  lossState,
  evaluateOrder,
  evaluateModify,
  formatBlock,
};
