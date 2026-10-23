'use strict';

/**
 * Stop hook: if entries were placed this trading day that have no matching
 * review, ask Claude (once) to review them before ending the turn.
 * Uses stop_hook_active to avoid loops. Never blocks twice in a row. In an
 * autonomous cycle's head trader run (FTH_AUTONOMOUS=1, no FTH_ROLE_RUN) it asks
 * for the CYCLE RESULT line again last. A role the runner runs on its own (FTH_ROLE_RUN) is never asked: a role
 * reviews no trade, and its last message is its report (a reminder made it answer the reminder instead).
 */

const { tradingDayStart } = require('../lib/trading/clock');
const { resolveJournalPath, readJournal, entriesSince } = require('../lib/trading/journal');
const { liveReviews, successfulEntries } = require('../lib/trading/order-gate');
const { harnessNow, ReplayClockError } = require('../lib/trading/harness-now');

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
  if (env.FTH_ROLE_RUN) return '';
  let pending;
  try {
    // The gate's clock (harness-now.js): the wall clock, or a replay broker's replayed time.
    pending = unreviewedCount(readJournal(resolveJournalPath(env)), deps.now || harnessNow(env));
  } catch (err) {
    // A refused replay clock is said, not swallowed: the reminder can't run, and entries are refused meanwhile.
    if (err instanceof ReplayClockError) return { stderr: `[replay-clock] ${err.message} The review reminder could not check this trading day; tell the user.`, exitCode: 2 };
    return '';
  }
  if (pending === 0) return '';

  return {
    stderr: `${pending} entr${pending === 1 ? 'y' : 'ies'} this trading day ha${pending === 1 ? 's' : 've'} no review. `
      + 'If the trade is closed, run /trade-review (or journal_add {kind:"review"} with result:* and setup:* tags). '
      + 'If it is still open, confirm the protective stop is working with list_open_orders, then you may stop.'
      // The head trader's run of an autonomous cycle (a role's run returned above): its result is read from the final
      // message (autotrader.js cycleResult).
      + (env.FTH_AUTONOMOUS === '1' ? ' Then end your reply with this cycle\'s CYCLE RESULT line again, as its last line.' : ''),
    exitCode: 2,
  };
}

module.exports = { run, unreviewedCount };
