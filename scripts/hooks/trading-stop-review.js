'use strict';

/**
 * Stop hook: if entries were placed this trading day that have no matching
 * review, ask Claude (once) to review them before ending the turn.
 * Uses stop_hook_active to avoid loops. Never blocks twice in a row.
 */

const { tradingDayStart } = require('../lib/trading/clock');
const { resolveJournalPath, readJournal, entriesSince } = require('../lib/trading/journal');
const { liveReviews, successfulEntries } = require('../lib/trading/order-gate');
const { gateNow } = require('../lib/trading/config');

function unreviewedCount(entries, now) {
  const today = entriesSince(entries, tradingDayStart(now));
  return Math.max(0, successfulEntries(today).length - liveReviews(today).length);
}

function run(rawInput, _ctx = {}, deps = {}) {
  let payload;
  try {
    payload = JSON.parse(rawInput || '{}');
  } catch (_err) {
    return '';
  }
  if (payload.stop_hook_active) return '';

  const env = deps.env || process.env;
  let pending;
  try {
    // The gate's clock: the wall clock, shifted only in the test suite (FTH_TEST_NOW).
    pending = unreviewedCount(readJournal(resolveJournalPath(env)), deps.now || gateNow(env));
  } catch (_err) {
    return '';
  }
  if (pending === 0) return '';

  return {
    stderr: `${pending} entr${pending === 1 ? 'y' : 'ies'} this trading day ha${pending === 1 ? 's' : 've'} no review. `
      + 'If the trade is closed, run /trade-review (or journal_add {kind:"review"} with result:* and setup:* tags). '
      + 'If it is still open, confirm the protective stop is working with list_open_orders, then you may stop.',
    exitCode: 2,
  };
}

module.exports = { run, unreviewedCount };
