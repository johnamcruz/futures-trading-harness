'use strict';

/**
 * The reason check (scripts/reason-check.js; trading/reasons.js): the reasons a role states for a decision, each
 * checked against the facts of the bar it decides, before it approves, vetoes or skips. Read-only; it decides
 * nothing. The facts: this cycle's bar briefing (as bar_briefing serves it: never an older bar's), the policy
 * verdicts recorded for that bar, and the started prop attempts (as combine_status lists them).
 *
 *   reason_check { symbol, reasons, json }   symbol: a contract root; reasons: the stated decision (a CYCLE RESULT
 *                                            line, a VERDICT line, or the reasons alone)
 */

const { readBriefing, current } = require('../trading/briefing');
const { familyRoot } = require('../trading/contracts');
const prop = require('../trading/prop-state');
const { contractRoot } = require('../trading/journal');
const { loadAccounts } = require('../trading/accounts');
const { loadStrategies } = require('../trading/strategies');
const { factsFromBriefing, reasonCheck, renderCheck } = require('../trading/reasons');
const { harnessHome } = require('../paths');
const { cycleBarOf } = require('./briefing');
const { statusOf } = require('./combine');
const { context, say } = require('./cli');

const USAGE = 'usage: reason-check.js --symbol MNQ --reasons "<the stated decision>" [--json]';
const MAX_REASONS = 2000;

/** This cycle's briefing for the root (else, outside a cycle, the current one), or null. */
function briefingNow(c, root) {
  const b = readBriefing(harnessHome(c.env), root);
  if (!b) return null;
  const cycleBar = cycleBarOf(c.env, root);
  return (cycleBar ? cycleBar === b.asOf : current(b, c.now())) ? b : null;
}

/**
 * The policy verdicts recorded for the briefing's bar and family, not expired: filtered first, then the latest per
 * strategy, as the gate keys them (prop-state latestVerdict: strategy and contract family), so one family's verdict
 * never hides another's.
 */
function verdictsFor(home, b, now) {
  const bar = Date.parse(b.asOf);
  const latest = new Map();
  for (const v of prop.readVerdicts(home)) {
    if (familyRoot(v.contract || contractRoot(v.contractId || v.symbol || '')) !== familyRoot(b.symbol) || Date.parse(v.bar) !== bar || !(Date.parse(v.expiresAt) > now.getTime())) continue;
    latest.set(v.strategy, v);
  }
  return [...latest.values()];
}

function check({ symbol = null, reasons = null, json = false } = {}, ctx) {
  const c = context(ctx);
  const root = /^([A-Z0-9]{1,8})$/.exec(String(symbol || ''));
  if (!root) throw new Error(`--symbol: a contract root, e.g. MNQ (${USAGE})`);
  const text = String(reasons || '').trim();
  if (!text) throw new Error(`--reasons: the decision and reasons you stated (${USAGE})`);
  if (text.length > MAX_REASONS) throw new Error(say(c, `--reasons: at most ${MAX_REASONS} characters`, `reasons: at most ${MAX_REASONS} characters`));
  const b = briefingNow(c, root[1]);
  if (!b) return { text: `No current bar briefing for ${root[1]}: no facts here to check the reasons against. Check each reason yourself against the facts you were given (the prompt, the plan, the analysts' reports); a reason none supports is false.\n` };
  const home = harnessHome(c.env);
  const now = c.now();
  const { strategies } = loadStrategies(c.root, c.env);
  const accounts = loadAccounts(c.root, c.env).accounts.filter(a => a.valid);
  const attempts = accounts.map(a => statusOf(home, a, now, strategies));
  const r = reasonCheck(text, factsFromBriefing(b, { attempts, verdicts: verdictsFor(home, b, now) }));
  return { text: json ? `${JSON.stringify(r)}\n` : renderCheck(r) };
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

module.exports = { OPS, USAGE, check, parseArgv, briefingNow, verdictsFor };
