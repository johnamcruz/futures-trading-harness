'use strict';

/**
 * The in-prompt history of a fresh combine attempt (stage 2's continuous combine, replay/combine-run.js): an attempt the
 * combine replay starts carries `historyFrom` (its start) in its record, and from then on the prompt's own history shows
 * only what happened since: the last reviewed trades and their record (the journal's reviews, by their time) and the
 * last cycles' decisions (the runner's decision history, by their time). Read scoping only: the journal and the history
 * stay whole (reviews, labels, the experience log and lessons read them as before). An attempt without `historyFrom`
 * (a live attempt, `scripts/combine.js start`; a drawn account state's seeded attempt; no attempt at all) shows its
 * history unchanged.
 *
 *   historyFrom(home)                 the latest `historyFrom` (ms) of the home's running attempts, or null
 *   since(list, fromMs, timeOf)       the items whose time (timeOf(item): ms) is at or after fromMs; all when fromMs is null
 *   journalSince(entries, fromMs)     the journal's entries at or after fromMs (their `ts`)
 *   historySince(history, fromMs)     the decision history's entries at or after fromMs (their `at`)
 */

const { runningAttempts, readAttempt } = require('../trading/prop-state');

function historyFrom(home) {
  let out = null;
  for (const name of runningAttempts(home)) {
    const ms = Date.parse((readAttempt(home, name) || {}).historyFrom);
    if (Number.isFinite(ms) && (out === null || ms > out)) out = ms;
  }
  return out;
}

/** An item without a readable time is shown only when nothing is scoped (it can't be placed in the attempt). */
function since(list, fromMs, timeOf) {
  const items = Array.isArray(list) ? list : [];
  if (fromMs === null || fromMs === undefined) return items;
  return items.filter(x => { const t = timeOf(x); return Number.isFinite(t) && t >= fromMs; });
}

const journalSince = (entries, fromMs) => since(entries, fromMs, e => Date.parse(e && e.ts));
const historySince = (history, fromMs) => since(history, fromMs, e => Date.parse(e && e.at));

module.exports = { historyFrom, since, journalSince, historySince };
