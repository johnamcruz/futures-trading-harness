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

const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;
const SETUP_TAG = /\bsetup:[a-z0-9][a-z0-9_-]*/i;
const STOP_IN_TEXT = /\bstop\b[^\d\n]{0,25}\d/i;

function isRiskReducing(rationale) {
  return RISK_REDUCING.test(String(rationale || ''));
}

/** Paper-trade reviews (tag `paper`) never count toward real trading state. */
function liveReviews(entries) {
  return entries.filter(e => e.kind === 'review' && !hasTag(e, 'paper'));
}

function successfulEntries(dayEntries) {
  return dayEntries.filter(e =>
    e.kind === 'order_placed'
    && e.data && e.data.result && e.data.result.success === true
    && !isRiskReducing(e.text));
}

function planMatches(entry, contractId, root) {
  if (entry.contractId) {
    return entry.contractId === contractId || contractRoot(entry.contractId) === root;
  }
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(String(entry.text || ''));
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

function evaluateOrder({ input = {}, entries = [], now = new Date(), config, blackouts = { items: [] } }) {
  if (isRiskReducing(input.rationale)) return { intent: 'risk-reducing', violations: [] };

  const rationale = String(input.rationale || '');
  const dayEntries = entriesSince(entries, tradingDayStart(now));
  const skip = config.skipChecks || new Set();
  const violations = [];
  const add = (check, message) => {
    if (message && !skip.has(check)) violations.push({ check, message });
  };

  add('setup-tag', SETUP_TAG.test(rationale) ? null
    : 'Rationale must name the playbook as setup:<name> (e.g. setup:orb). '
      + 'If this order exits or protects a position, start the rationale with [exit] or [protect].');

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

  const entered = successfulEntries(dayEntries).length;
  const reviewed = liveReviews(dayEntries).length;
  add('review-before-next-entry', entered > reviewed
    ? `${entered - reviewed} earlier entr${entered - reviewed === 1 ? 'y has' : 'ies have'} no review. `
      + 'Manage or close it, then journal_add {kind:"review", tags:["result:win|loss|scratch|nofill", "setup:<name>"]}.'
    : null);
  add('max-entries', config.maxEntriesPerDay > 0 && entered >= config.maxEntriesPerDay
    ? `${entered} entries this trading day (limit ${config.maxEntriesPerDay}).`
    : null);

  return { intent: 'entry', violations };
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
  formatBlock,
};
