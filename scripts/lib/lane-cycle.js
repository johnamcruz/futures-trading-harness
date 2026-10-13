'use strict';

/**
 * One runner cycle over several timeframe lanes (lanes.js): the bars of every
 * lane that closed on a pass go into ONE cycle (the analysts run once, the
 * risk manager, the executor and the gate decide once). What that cycle needs
 * beyond the one-lane runner:
 *
 *   laneBudgetMin(cfg, lane)            minutes a cycle on that lane may run: the runner's cycleTimeoutMinutes on
 *                                       the first lane (as with one lane), and on another lane its own default,
 *                                       max(3, 2 x timeframe), never over cycleTimeoutMinutes
 *   cycleTimeoutMin(cfg, closed)        a cycle's budget: the fastest closed lane's (the smallest)
 *   policyRank(a, b)                    the order two colliding policy strategies go in (negative: a first): both
 *                                       priorities set and different, the lower number first; otherwise (equal or
 *                                       missing) a policy on 3m and slower before one faster than 3m, then the
 *                                       slower timeframe, then the name
 *   settleCollisions(verdicts, strategyOf)   { winner, skipped: [{ verdict, by }] }: when entry verdicts (action not
 *                                       skip) of more than one policy come in one cycle, only the first policy's
 *                                       stand (the one policyRank puts before every other; when priorities set on
 *                                       some only go round in a circle, the timeframe rule alone); the others' are
 *                                       skipped as "lower priority"
 *   skippedVerdict(v, by, now)          the superseding verdict for a skipped one (action skip, size 0): recorded
 *                                       for the gate, which then refuses an entry on the skipped policy
 *   lanesLine(lanes, closed)            the prompt's sentence naming the lanes that closed (several lanes only)
 *   boundHistory(history, first)        the runner's decision history kept to 10 entries per lane (not 10 in all)
 *   laneHistory(history, { closed, first, open })   the decisions a cycle's prompt shows: each closed lane's last 10,
 *                                       plus the first lane's last 3 when it didn't close and each open trade's lane's
 */

const { tfMinutes } = require('./lanes');

const SLOW_FROM_MIN = 3; // "3m and slower" goes first on a tie
const LOWER_PRIORITY = 'lower priority';

const fallbackBudget = tf => Math.max(3, 2 * tf);

function laneBudgetMin(cfg, lane) {
  const first = (Array.isArray(cfg.lanes) && cfg.lanes.length ? cfg.lanes[0].timeframe : cfg.timeframe);
  if (!lane || lane.timeframe === first) return cfg.cycleTimeoutMinutes;
  return Math.min(cfg.cycleTimeoutMinutes, fallbackBudget(lane.timeframe));
}

/** The budget of a cycle covering the `closed` lanes: the fastest one's; with none, the runner's. */
function cycleTimeoutMin(cfg, closed = []) {
  const budgets = closed.filter(Boolean).map(l => laneBudgetMin(cfg, l));
  return budgets.length ? Math.min(...budgets) : cfg.cycleTimeoutMinutes;
}

const minutesOf = s => (s && tfMinutes(s.timeframe)) || 0; // unknown: the fastest, so it never wins a tie by default

function policyRank(a, b) {
  const pa = a && Number.isInteger(a.priority) ? a.priority : null;
  const pb = b && Number.isInteger(b.priority) ? b.priority : null;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  const ma = minutesOf(a);
  const mb = minutesOf(b);
  const slowA = ma >= SLOW_FROM_MIN;
  const slowB = mb >= SLOW_FROM_MIN;
  if (slowA !== slowB) return slowA ? -1 : 1;
  if (ma !== mb) return mb - ma;
  const na = String((a && a.name) || '');
  const nb = String((b && b.name) || '');
  return na < nb ? -1 : na > nb ? 1 : 0;
}

/**
 * Entry verdicts of more than one policy in one cycle: the policy that goes first (policyRank, from
 * `strategyOf(name)`: its registry entry, or null) keeps its verdicts; every other policy's entry verdicts are
 * skipped. Skip verdicts never collide. Returns { winner: name or null, skipped: [{ verdict, by }] }.
 */
function settleCollisions(verdicts, strategyOf = () => null) {
  const entries = (verdicts || []).filter(v => v && v.strategy && v.action !== 'skip');
  const names = [...new Set(entries.map(v => v.strategy))];
  if (names.length < 2) return { winner: names[0] || null, skipped: [] };
  const list = names.map(n => ({ ...(strategyOf(n) || {}), name: n }));
  // The policy that goes before every other one. With three or more, priorities set on some only can go round in a
  // circle (a before b by priority, b before c by timeframe, c before a): then the timeframe rule alone decides.
  const first = list.find(a => list.every(b => b === a || policyRank(a, b) < 0));
  const winner = (first || [...list].sort((a, b) => policyRank({ ...a, priority: null }, { ...b, priority: null }))[0]).name;
  return { winner, skipped: entries.filter(v => v.strategy !== winner).map(verdict => ({ verdict, by: winner })) };
}

/** The verdict that supersedes a skipped one: the same setup and bar, skipped, size 0, saying why. */
function skippedVerdict(v, by, now = new Date()) {
  return { ...v, at: now.toISOString(), action: 'skip', maxSize: 0, reason: `skipped: ${LOWER_PRIORITY} (${by} goes first when both have a setup in one cycle)`, skippedBy: by };
}

/** "Lanes closed this cycle: 3m (every bar), 1m (on a signal)." for the lanes that closed (`closed`: lane objects). */
function lanesLine(closed) {
  const list = (closed || []).filter(Boolean);
  if (!list.length) return '';
  const one = l => `${l.timeframe}m (${l.trigger === 'signal' ? 'on a signal: a strategy fired or a position is open' : 'every bar'})`;
  return ` Lanes closed this cycle: ${list.map(one).join(', ')}; one cycle covers them all (decide once for every lane's setups).`;
}

const HISTORY_PER_LANE = 10;
const SLOWER_CONTEXT = 3;
// An entry's lanes ("3m"); one from before lanes were tagged counts as the first lane's.
const entryLanes = (h, first) => (Array.isArray(h && h.lanes) && h.lanes.length ? h.lanes : [first]);

/**
 * The runner's own decision history with several lanes, bounded per lane: the newest entries kept while any of
 * their lanes has fewer than `keep` newer ones, so a fast lane's cycles never evict a slower lane's decisions.
 * `history`: oldest first; returns the kept entries, oldest first.
 */
function boundHistory(history, first, keep = HISTORY_PER_LANE) {
  const counts = new Map();
  const kept = [];
  for (const h of [...(history || [])].reverse()) {
    const lanes = entryLanes(h, first);
    if (!lanes.some(l => (counts.get(l) || 0) < keep)) continue;
    for (const l of lanes) counts.set(l, (counts.get(l) || 0) + 1);
    kept.push(h);
  }
  return kept.reverse();
}

/**
 * The decisions a cycle's prompt shows: the last `keep` of each lane that closed (`closed`, e.g. ["1m"]); when the
 * first lane didn't close, its last `context` too (the first lane's view); and the last `context` of each lane an
 * open trade was entered on (`open`). Oldest first, each once.
 */
function laneHistory(history, { closed = [], first, open = [], keep = HISTORY_PER_LANE, context = SLOWER_CONTEXT } = {}) {
  const list = history || [];
  const of = lanes => list.filter(h => entryLanes(h, first).some(l => lanes.includes(l)));
  // Each closed lane's own last `keep` (a 3m close that is also a 1m close shows the 3m decisions too, never only the
  // flood of 1m ones).
  const picked = new Set(closed.flatMap(l => of([l]).slice(-keep)));
  const extra = [...(closed.includes(first) ? [] : [first]), ...open.filter(l => !closed.includes(l))];
  for (const l of [...new Set(extra)]) for (const h of of([l]).slice(-context)) picked.add(h);
  return list.filter(h => picked.has(h));
}

module.exports = { HISTORY_PER_LANE, SLOWER_CONTEXT, boundHistory, laneHistory, LOWER_PRIORITY, laneBudgetMin, cycleTimeoutMin, policyRank, settleCollisions, skippedVerdict, lanesLine };
