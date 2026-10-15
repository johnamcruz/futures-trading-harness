'use strict';

/**
 * The correctness label of one decision, by PROCESS, never by outcome (docs/TRAINING.md, "Fine-tuning on verified
 * decisions"): what a fine-tuning dataset keeps (learning/decision-dataset.js) is only what the code verified right.
 * A losing trade made by the process is `correct`; a winning trade made against it is `incorrect`. No outcome field (R,
 * P&L, a grade, a counterfactual) is read: labelDecision drops them before it looks.
 *
 * The decision (learning/decision-examples.js builds it from a run's scorecard record and its cycle's compose record):
 *   kind        'take' (an entry) | 'pass' (flat, no entry) | 'risk' (in a trade: 'hold' or 'exit')
 *   action      take: 'long' | 'short'; pass: 'none'; risk: 'hold' | 'exit'
 *   scorecard   { category, agrees } of the run's scorecard (replay/scorecard.js), or null (not scored)
 *   expected    the scorecard's expectation { decision, decidedBy } (a pass reads it), or null
 *   gate        { refused: bool, checks: [] }: the order gate or the broker refused the entry
 *   record      the cycle's compose record the decision is on (an entry: its side's latest OK record; a pass: the latest
 *               OK record), { ok, reads: [{ check }], entry, stop, target, rr, size }, or null
 *   attempts    how many compose records the cycle wrote for the symbol (OK or not)
 *   policyExit  risk: 'runner-close' | 'runner-trail' when the runner closed the position (prop/model-stream.js
 *               runnerExit), else null
 *   riskUsd     the record's risk in dollars (|entry - stop| in ticks x tick value x size), or null
 *   account     stage 2: the account call (accountCall), or null in stage 1 (no account state)
 * The rules: { minRR, maxRiskUsd } (trade_lifecycle's risk.min_rr and risk.max_risk_usd).
 *
 * A take is correct only if every claimed read is verified true, the scorecard grades it right, the plan's R:R is at
 * least minRR, its risk at most maxRiskUsd, no gate or risk rule refused it and (stage 2) the account state doesn't
 * call for standing down. A pass is correct when no valid setup existed (compose_check refused every plan the cycle
 * tried, or a hard stop said no trade) or when the account state or the rules call for standing down. A risk action is
 * correct when it fits the rules for that account state (an exit the account calls for; a hold the scorecard grades
 * right; the runner's own trail or time-stop exit is the policy's, never the model's, so it is no model decision).
 * The definitions are the measurement's (#208): a decision's reads count as correct only when every one is verified true
 * (replay/stage.js exitTest's correct-read rate, per decision); a size under the ceiling is the model's own share
 * (prop/evaluator.js ownShare), never wrong, and only a size over it is (the scorecard's bad size).
 * Everything else is `incorrect` (a rule broken, with the reason) or `unverifiable` (nothing verifies it either
 * way, with the reason): neither is ever trained on.
 *
 *   LABELS                         ['correct', 'incorrect', 'unverifiable']
 *   OUTCOME_KEYS                   the fields labelDecision drops before it reads a decision
 *   rrOf(record)                   the plan's reward:risk (its own rr, else from entry, stop and target), or null
 *   accountCall(attempt, riskUsd)  { standDown, exitRequired, why }: what the account state calls for (null: unknown)
 *   labelDecision(decision, rules) { label, reasons }
 */

const LABELS = Object.freeze(['correct', 'incorrect', 'unverifiable']);
const OUTCOME_KEYS = Object.freeze(['outcome', 'grade', 'trade', 'counterfactual', 'R', 'r', 'pnl', 'net', 'result']);

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
// A read verified true: the stage-1 exit test's correct-read rule (replay/stage.js exitTest), per decision: every read.
const isTrue = c => c === true || c === 'true';
const isFalse = c => c === false || c === 'false';

function rrOf(record) {
  if (!isObj(record)) return null;
  const own = num(record.rr);
  if (own !== null) return own;
  const [e, s, t] = [num(record.entry), num(record.stop), num(record.target)];
  if (e === null || s === null || t === null || e === s) return null;
  return Math.abs(t - e) / Math.abs(e - s);
}

/**
 * What the account state calls for, from the attempt the cycle showed (replay/scorecard.js attemptAt): standing down
 * when the gate's entry block is on, the soft daily stop is reached, or the trade's risk would reach the max loss limit
 * (cushion) or the daily limit (daily headroom); an exit when the account is at its floor or its daily limit. Null
 * values where the state doesn't say (no attempt: stage 1, every value null).
 */
function accountCall(attempt, riskUsd = null) {
  if (!isObj(attempt) || attempt.status === 'none') return { standDown: null, exitRequired: null, why: 'no account state' };
  const cushion = num(attempt.cushion);
  const daily = num(attempt.dailyHeadroom);
  const soft = num(attempt.softHeadroom);
  const risk = num(riskUsd);
  const why = [];
  if (attempt.entryBlock) why.push(`the entry block: ${String(attempt.entryBlock).slice(0, 120)}`);
  if (soft !== null && soft <= 0) why.push('the soft daily stop is reached');
  if (cushion !== null && cushion <= (risk || 0)) why.push(risk ? `the risk $${risk} reaches the max loss limit (cushion $${cushion})` : `no cushion left ($${cushion})`);
  if (daily !== null && daily <= (risk || 0)) why.push(risk ? `the risk $${risk} reaches the daily limit (room $${daily})` : `no daily room left ($${daily})`);
  const exitRequired = (cushion !== null && cushion <= 0) || (daily !== null && daily <= 0) ? true : cushion === null && daily === null ? null : false;
  if (why.length) return { standDown: true, exitRequired, why: why.join('; ') };
  // Known not to call for standing down only when the state gives its room.
  const known = cushion !== null && daily !== null;
  return { standDown: known ? false : null, exitRequired, why: known ? 'room to trade' : 'the account state gives no room figures' };
}

const out = (label, reasons) => ({ label, reasons });

/** The reads' verdict: every read true, else the first false one, else the unverified ones. */
function readsVerdict(record) {
  const reads = isObj(record) && Array.isArray(record.reads) ? record.reads : [];
  if (!reads.length) return { status: 'none' };
  const bad = reads.filter(r => isFalse(r && r.check));
  if (bad.length) return { status: 'false', why: `${bad.length} claimed read(s) false` };
  const open = reads.filter(r => !isTrue(r && r.check));
  if (open.length) return { status: 'unverified', why: `${open.length} claimed read(s) not verified (unchecked)` };
  return { status: 'true' };
}

function labelTake(d, rules) {
  const bad = [];
  const open = [];
  if (d.gate && d.gate.refused) bad.push(`refused by the gate or a risk rule${d.gate.checks && d.gate.checks.length ? `: ${d.gate.checks.join(', ')}` : ''}`);
  const sc = d.scorecard;
  if (!sc) open.push('not scored');
  else if (sc.category === 'unchecked') open.push('the scorecard could not grade it');
  else if (sc.category !== 'right') bad.push(`the scorecard grades it ${sc.category}`);
  const reads = readsVerdict(d.record);
  if (reads.status === 'none') open.push('no claimed reads (no compose record)');
  else if (reads.status === 'false') bad.push(reads.why);
  else if (reads.status === 'unverified') open.push(reads.why);
  const rr = rrOf(d.record);
  if (rr === null) open.push('the plan\'s R:R is unknown');
  else if (num(rules.minRR) !== null && rr + 1e-9 < rules.minRR) bad.push(`R:R ${rr.toFixed(2)} under ${rules.minRR}`);
  const risk = num(d.riskUsd);
  if (risk === null) open.push('the plan\'s risk in dollars is unknown');
  else if (num(rules.maxRiskUsd) !== null && risk > rules.maxRiskUsd + 1e-9) bad.push(`risk $${risk} over the cap $${rules.maxRiskUsd}`);
  if (d.account && d.account.standDown === true) bad.push(`the account state calls for standing down (${d.account.why})`);
  if (bad.length) return out('incorrect', bad);
  if (open.length) return out('unverifiable', open);
  return out('correct', [`reads verified, scored right, R:R ${rr.toFixed(2)}, risk $${risk}`]);
}

function labelPass(d) {
  const sc = d.scorecard;
  if (sc && sc.category !== 'right' && sc.category !== 'unchecked') return out('incorrect', [`the scorecard grades the pass ${sc.category}`]);
  // The reads of the valid record it passes on (a refused record's false reads are the checker doing its job: the
  // model was told, and stood aside).
  const reads = isObj(d.record) && d.record.ok === true ? readsVerdict(d.record) : { status: 'none' };
  if (reads.status === 'false') return out('incorrect', [`the pass states a false read (${reads.why})`]);
  if (d.account && d.account.standDown === true) return out('correct', [`the account state calls for standing down (${d.account.why})`]);
  const ex = d.expected || {};
  // A mechanical step of the priority order (trading/reasons.js: 1 a hard stop, 2 the trend rule, 3 room, ...) says no
  // trade: the rules call for standing aside. 'no setup' (a string) is not one: nothing was found, not ruled out.
  if (ex.decision === 'no-trade' && typeof ex.decidedBy === 'number') return out('correct', [`the rules say no trade (the priority order's step ${ex.decidedBy})`]);
  if (!sc) return out('unverifiable', ['not scored']);
  const valid = isObj(d.record) && d.record.ok === true;
  if (!valid && Number(d.attempts) > 0) return out('correct', [`no valid setup: compose_check refused every plan the cycle tried (${d.attempts})`]);
  if (valid) return out('unverifiable', ['a pass on a valid setup with no rule calling for standing down: the model\'s judgment, which no rule verifies']);
  return out('unverifiable', ['no setup was composed or checked: whether a valid one existed is unverified']);
}

function labelRisk(d) {
  const sc = d.scorecard;
  if (sc && sc.category !== 'right' && sc.category !== 'unchecked') return out('incorrect', [`the scorecard grades it ${sc.category}`]);
  if (d.action === 'exit') {
    if (d.policyExit) return out('unverifiable', [`the runner's own exit (${d.policyExit}: its trail or time stop, prop/model-stream.js runnerExit): the policy's, never the model's`]);
    if (d.account && d.account.exitRequired === true) return out('correct', [`the account state calls for the exit (${d.account.why})`]);
    return out('unverifiable', ['an exit the rules don\'t call for: the plan\'s management, which no rule verifies']);
  }
  if (d.action === 'hold') {
    if (d.account && d.account.exitRequired === true) return out('incorrect', [`held where the account state calls for the exit (${d.account.why})`]);
    if (!sc) return out('unverifiable', ['not scored']);
    if (sc.category === 'right') return out('correct', ['held to the plan']);
    return out('unverifiable', ['the scorecard could not grade it']);
  }
  return out('unverifiable', [`${d.action || 'an action'} in a trade: judgment`]);
}

/** The label (see the head). The decision's outcome fields are dropped first: the label never depends on them. */
function labelDecision(decision, rules = {}) {
  if (!isObj(decision)) throw new Error('labelDecision: a decision object');
  const d = Object.fromEntries(Object.entries(decision).filter(([k]) => !OUTCOME_KEYS.includes(k)));
  if (d.kind === 'take') return labelTake(d, rules);
  if (d.kind === 'pass') return labelPass(d, rules);
  if (d.kind === 'risk') return labelRisk(d, rules);
  return out('unverifiable', [`unknown decision kind ${JSON.stringify(d.kind)}`]);
}

module.exports = { LABELS, OUTCOME_KEYS, rrOf, accountCall, labelDecision };
