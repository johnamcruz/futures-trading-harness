'use strict';

/**
 * Why a composed decision didn't trade, as a class (the experience log's `passClass`, experience-log.js): the model's
 * own pass, or something after its decision that it didn't choose. A `passed` line covered all of them, so a limit
 * the market never came back to, a veto or a gate refusal read as the model declining; the class keeps them apart.
 *
 *   CLASSES        declined     the head trader passed (its own no-trade on a composed record)
 *                  missed_fill  the runner's entry: price had moved past the plan's entry (late-entry.js missed or
 *                               chased entry): no late entry
 *                  invalidated  the runner's entry: price beyond the plan's stop before the order went
 *                  unfilled     the order went and never filled (it expired, or was cancelled, unfilled); this
 *                               includes the head trader cancelling its own working entry in a later cycle, which
 *                               the entry record (written when the order went) can't tell apart: read that cycle
 *                               for it
 *                  vetoed       risk-manager phase 2 vetoed it (or its approval read as a veto): `vetoBasis` says on what
 *                  blocked      the order gate refused the entry order
 *                  runner_skip  the runner placed nothing for its own reason (the record expired first, no price,
 *                               an approval without a readable size, a failed or interrupted run)
 *   classOfEntry(entry)        the class from the runner's entry record (runner-entry.js outcome, and `late`: the
 *                              late-entry kind), or null when it doesn't tell
 *   classOfResult(text)        the class from the cycle's result line (the runner's own wording for its outcomes;
 *                              the head trader's no-trade: declined), or null
 *   cycleClass(cycle)          { passClass, vetoBasis } of a cycle ({ entry, result }): the entry record first, else
 *                              its result line; vetoBasis (trading/veto-basis.js, or 'misread': an approving
 *                              VERDICT line the reading refused) only for a veto; nothing known: both null
 *   ownPass(d)                 a passed decision the model made itself: declined, or a line from before the class
 */

const { vetoBasis } = require('../trading/veto-basis');

const CLASSES = Object.freeze(['declined', 'missed_fill', 'invalidated', 'unfilled', 'vetoed', 'blocked', 'runner_skip']);
const RUNNER_SKIPS = new Set(['expired', 'no-trade', 'error', 'process-failure', 'aborted']);
const LATE = { 'missed-entry': 'missed_fill', 'chased-entry': 'missed_fill', 'beyond-stop': 'invalidated', 'no-price': 'runner_skip', failed: 'runner_skip', unreadable: 'runner_skip' };

function classOfEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const o = entry.outcome;
  if (o === 'late') return LATE[entry.late] || null;
  if (o === 'vetoed') return 'vetoed';
  if (o === 'blocked') return 'blocked';
  if (o === 'executed') return 'unfilled';
  return RUNNER_SKIPS.has(o) ? 'runner_skip' : null;
}

// The runner's own wording for its entry's outcomes (runner-entry.js, late-entry.js), checked before the outcome word.
const MISREAD = /risk-manager phase 2's report reads as a veto/;
const RUNNER = [
  [/the runner's entry: (?:missed the plan's entry|chased entry)/, 'missed_fill'],
  [/the runner's entry: the setup was invalidated before the order went/, 'invalidated'],
  [/risk-manager vetoed the |risk-manager phase 2's report reads as a veto/, 'vetoed'],
  [/the composed record expired before the order|the runner's entry(?: failed|: )/, 'runner_skip'],
];
const BY_OUTCOME = { 'no-trade': 'declined', executed: 'unfilled', blocked: 'blocked', planned: 'runner_skip', error: 'runner_skip' };

function classOfResult(text) {
  const t = String(text || '');
  const m = /^\s*CYCLE RESULT:\s*([a-z-]+)/i.exec(t.replace(/[*_`]/g, ''));
  if (!m) return null;
  const word = m[1].toLowerCase();
  // Only a no-trade can be the runner's pass (an executed line names "the runner's entry" too).
  const hit = word === 'no-trade' ? RUNNER.find(([re]) => re.test(t)) : null;
  if (hit) return hit[1];
  return BY_OUTCOME[word] || null;
}

function cycleClass(cycle) {
  const c = cycle && typeof cycle === 'object' ? cycle : {};
  const passClass = classOfEntry(c.entry) || classOfResult(c.result);
  let basis = null;
  if (passClass === 'vetoed') {
    const recorded = c.entry && typeof c.entry.vetoBasis === 'string' ? c.entry.vetoBasis : null;
    basis = recorded || (MISREAD.test(String(c.result || '')) ? 'misread' : vetoBasis(String(c.result || '').replace(/^.*?risk-manager vetoed the [^:]*:\s*/, '')));
  }
  return { passClass: passClass || null, vetoBasis: basis };
}

const ownPass = d => Boolean(d) && d.decision === 'passed' && (d.passClass === undefined || d.passClass === null || d.passClass === 'declined');

module.exports = { CLASSES, classOfEntry, classOfResult, cycleClass, ownPass };
