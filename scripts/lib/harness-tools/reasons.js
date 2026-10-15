'use strict';

/**
 * The reason check (scripts/reason-check.js; trading/reasons.js): the reasons a role states for a decision, each
 * checked against the facts of the bar it decides, before it approves, vetoes or skips. Read-only; it decides
 * nothing. The facts: this cycle's bar briefing (as bar_briefing serves it: never an older bar's), the policy
 * verdicts recorded for that bar, the started prop attempts (as combine_status lists them), and the bar's compose
 * records (a composed setup: its own reads and plan, not a strategy's priority order).
 *
 *   reason_check { symbol, reasons, json }   symbol: a contract root; reasons: the stated decision (a CYCLE RESULT
 *                                            line, a VERDICT line, or the reasons alone), with phase 2's FACTS line
 *                                            when it has one (each claim checked as the order gate checks it)
 */

const { readBriefing, current } = require('../trading/briefing');
const { briefingAfterClock } = require('../trading/look-ahead');
const { familyRoot } = require('../trading/contracts');
const prop = require('../trading/prop-state');
const { contractRoot } = require('../trading/journal');
const { loadAccounts } = require('../trading/accounts');
const { loadStrategies } = require('../trading/strategies');
const { factsFromBriefing, reasonCheck, renderCheck } = require('../trading/reasons');
const { factsLines, withoutFacts, checkFacts, renderFacts } = require('../trading/fact-claims');
const { recordsAt } = require('../trading/lifecycle-gate');
const { recordSummary } = require('../trading/lifecycle-runner');
const { harnessHome } = require('../paths');
const { cycleBarOf } = require('./briefing');
const { statusOf } = require('./combine');
const { context, say } = require('./cli');

const USAGE = 'usage: reason-check.js --symbol MNQ --reasons "<the stated decision>" [--json]';
const MAX_REASONS = 2000;

/** This cycle's briefing for the root (else, outside a cycle, the current one), or null. */
function briefingNow(c, root) {
  const b = readBriefing(harnessHome(c.env), root);
  // Never a briefing whose bar closed after a replay clock (no look-ahead).
  if (!b || briefingAfterClock(b, c.replayAt())) return null;
  const cycleBar = cycleBarOf(c.env, root);
  return (cycleBar ? cycleBar === b.asOf : current(b, c.now())) ? b : null;
}

/**
 * The policy verdicts recorded for the briefing's bar and family, not expired (or the runner's bar-less skip written in
 * the bar's close window): filtered first, then the latest per
 * strategy, as the gate keys them (prop-state latestVerdict: strategy and contract family), so one family's verdict
 * never hides another's.
 */
function verdictsFor(home, b, now) {
  const bar = Date.parse(b.asOf);
  const closed = Date.parse(b.closedAt);
  const next = closed + (Number(b.minutes) > 0 ? Number(b.minutes) : 0) * 60000;
  // The runner's skip with no bar (no attempt, a contract without specs: prop/live-runner.js screen) expires as it is
  // written, yet it is the verdict the model was shown: kept when it was written in this bar's close window.
  const barless = v => !v.bar && v.action === 'skip' && Date.parse(v.at) >= closed && Date.parse(v.at) < next;
  const latest = new Map();
  for (const v of prop.readVerdicts(home)) {
    if (familyRoot(v.contract || contractRoot(v.contractId || v.symbol || '')) !== familyRoot(b.symbol)) continue;
    if (!barless(v) && (Date.parse(v.bar) !== bar || !(Date.parse(v.expiresAt) > now.getTime()))) continue;
    latest.set(v.strategy, v);
  }
  return [...latest.values()];
}

/**
 * The compose records on the briefing's bar for this contract's family (compose_check's, as the gate reads them:
 * lifecycle-gate.js recordsAt), as the cycle log keeps them; the latest per side counts only when it is this contract's
 * (reasons.js composedSetupsFrom). A composed setup is judged on its own record's reads and plan.
 */
function composedFor(home, root, b) {
  try {
    return recordsAt(home, root, b.asOf).map(recordSummary);
  } catch (_err) {
    return [];
  }
}

function check({ symbol = null, reasons = null, json = false } = {}, ctx) {
  const c = context(ctx);
  const root = /^([A-Z0-9]{1,8})$/.exec(String(symbol || ''));
  if (!root) throw new Error(`--symbol: a contract root, e.g. MNQ (${USAGE})`);
  const text = String(reasons || '').trim();
  if (!text) throw new Error(`--reasons: the decision and reasons you stated (${USAGE})`);
  if (text.length > MAX_REASONS) throw new Error(say(c, `--reasons: at most ${MAX_REASONS} characters`, `reasons: at most ${MAX_REASONS} characters`));
  const b = briefingNow(c, root[1]);
  // A FACTS line (risk-manager phase 2, trading/fact-claims.js): each claim checked as the order gate checks it.
  const stated = factsLines(text) !== null;
  if (!b) return { text: `No current bar briefing for ${root[1]}: no facts here to check the reasons against. Check each reason yourself against the facts you were given (the prompt, the plan, the analysts' reports); a reason none supports is false.\n${stated ? renderFacts(checkFacts(text, null, `no current bar briefing for ${root[1]}`)) : ''}` };
  const home = harnessHome(c.env);
  const now = c.now();
  const { strategies } = loadStrategies(c.root, c.env);
  const accounts = loadAccounts(c.root, c.env).accounts.filter(a => a.valid);
  const attempts = accounts.map(a => statusOf(home, a, now, strategies));
  const r = reasonCheck(stated ? withoutFacts(text) : text, factsFromBriefing(b, { attempts, verdicts: verdictsFor(home, b, now), composed: composedFor(home, root[1], b), root: root[1] }));
  const f = stated ? checkFacts(text, b) : null;
  if (json) return { text: `${JSON.stringify(f ? { ...r, factsLine: f } : r)}\n` };
  return { text: `${renderCheck(r)}${f ? renderFacts(f) : ''}` };
}

/** argv to { symbol, reasons, json }. */
function parseArgv(argv) {
  const o = { symbol: null, reasons: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '--symbol') o.symbol = inline !== undefined ? inline : argv[++i];
    else if (flag === '--reasons') o.reasons = inline !== undefined ? inline : argv[++i];
    else if (flag === '--json') o.json = true;
    else throw new Error(`unknown argument: ${argv[i]} (${USAGE})`);
  }
  return o;
}

const OPS = { reason_check: check };

module.exports = { OPS, USAGE, check, parseArgv, briefingNow, verdictsFor, composedFor };
