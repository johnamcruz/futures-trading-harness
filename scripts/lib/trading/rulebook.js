'use strict';

/**
 * The rulebook (docs/LEARNED-RULEBOOK.md, R1-R4): the numbers and context rules the
 * prop policies trade with, one document per account, `accounts/<name>/RULEBOOK.md`
 * beside its ACCOUNT.md. The frontmatter holds the values, the body the evidence that
 * set each one (R3). Nothing else states them: the account loader (accounts.js) takes
 * `daily_loss_soft` and `loss_streak_stop` from it and the strategy loader (strategies.js) each policy's
 * `sizing`, `exit`, `multipliers` and `entry`, so the runner, the verdict, the gate and the
 * backtester all read them from here (R1). Every item is classified (R4): `enforced`
 * (the code or the gate holds it) or `taught` (a skill the agent loads teaches it).
 *
 *   ITEMS                               every rulebook item: its group, what it is, and how
 *                                       it can be held (enforcedBy) or taught (taughtIn)
 *   validateRulebook(data, body, folder) problems (empty = valid)
 *   loadRulebookFile(file)              the parsed rulebook ({ ...data, file, body, valid, errors }), null when none
 *   policyEntry(rulebook, name)         that policy's { sizing, exit, multipliers, entry }, or null (exit as the strategy
 *                                       loader reads it: { mode, trail_activate_r?, trail_giveback_r? }, `off` left out;
 *                                       entry: its entry rule block as written, entry-rule.js)
 *   ceiling(items, facts, now)          the verdict's multiplier from the enforced multiplier items
 *
 * Pure but for reading the file; no network.
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../frontmatter');
const { SIZING_KEYS, MIN_STOP_SLIPPAGE_TICKS } = require('./combine');
const { SWING_TFS } = require('./exit-trail');
const { entryRuleErrors } = require('./entry-rule');

/** The exit keys every policy entry states (its sizing keys: combine.js SIZING_KEYS, each key the sizing reads). */
const EXIT_KEYS = Object.freeze(['mode', 'trail_activate_r', 'trail_giveback_r', 'lock_giveback_r', 'trail_by', 'trail_r', 'swing_tf', 'ratchet']);
/**
 * How a policy's trades exit (every key stated; a key the mode doesn't use is `off`):
 * - `target`: at each trade's own stop and target (a compose record's brackets, a rules component's own exit), with
 *   the trail on top only when trail_activate_r and trail_giveback_r are R;
 * - `target_then_trail`: the original stop until the trade's own target is reached, then no exit there: the stop
 *   holds at the target's R less lock_giveback_r until the latest confirmed swing on swing_tf stands beyond it, then
 *   trails behind it (trail_by structure; trail_r behind the best price only with no swing in the bars at all) or
 *   trail_r behind the best price (trail_by r)
 *   (trading/exit-trail.js); `ratchet: on` (opt in; `off` is the default, today's lock) lifts the lock with the trade:
 *   the best R reached, at least the target's, less lock_giveback_r;
 * - `trail`: the trail replaces the trade's own target (hold its stop until trail_activate_r, then trail_giveback_r
 *   behind the best price).
 */
const EXIT_MODES = Object.freeze(['target', 'target_then_trail', 'trail']);
const TRAIL_BY = Object.freeze(['r', 'structure']);

const FILE = 'RULEBOOK.md';
const KEYS = ['name', 'description', 'learned', 'daily_loss_soft', 'loss_streak_stop', 'policies', 'enforced', 'taught'];
const POLICY_KEYS = ['sizing', 'exit', 'multipliers', 'entry'];
const MULTIPLIER_KEYS = ['item', 'fact', 'values', 'max_age_min'];
const REQUIRED_SECTIONS = ['## When to Use', '## How It Works', '## Examples'];
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

const STEP = n => ({ skill: 'strategy-library', step: n });
/**
 * Every rulebook item. `enforcedBy`: where the code holds it (so it may be classified enforced);
 * `taughtIn`: the skill and its priority-order step that teach it (so it may be classified taught).
 * An item is classified as one of the kinds it has; the classification itself is the rulebook's.
 */
const ITEMS = Object.freeze({
  daily_loss_soft: { group: 'pacing', what: 'no new entries once the day is down this many dollars', enforcedBy: 'combine.entryBlock: the verdict skips and the gate refuses (combineBlock)' },
  loss_streak_stop: { group: 'pacing', what: 'no new entries for the rest of the session after this many losing trades in a row (a scratch neither ends nor extends the streak)', enforcedBy: "combine.entryBlock on the session's closed trades (live: the broker's closing fills, prop-state snapshot): the verdict skips, the gate refuses (combineBlock), the backtester and the attempt simulator skip" },
  sizing: { group: 'pacing', what: "each policy's size budget: its share of the cushion, the cap, the drawdown halving, the one-contract guard, the stop's expected slippage, the floor of contracts, the floor stretch over a composed cap while the attempt is healthy", enforcedBy: 'combine.budget and contractPlan, prop/size-translate.js floorStretch: the verdict, the size translation, the gate (budgetPlan, min-contracts, max-risk), the backtester and the attempt simulator' },
  exit: { group: 'exits', what: "each policy's exit: the trade's own stop and target (mode target, an optional trail on top), the target then a trail past it with a lock (mode target_then_trail), or the trail in place of the target (mode trail)", enforcedBy: "evaluator.exitPlan and tradeExitPlan: the runner's trail live (none in mode target with the trail off: the entry's own brackets stand), the backtester's broker and the attempt simulator (prop/attempts.js exitAs)" },
  multipliers: { group: 'priority', what: "the enforced size multipliers folded into the verdict's ceiling", enforcedBy: 'rulebook.ceiling: the verdict (prop/verdict.js) and the gate (prop-state verdictMultiplier)' },
  target_stop: { group: 'pacing', what: "no new entries once today's close would pass the attempt", enforcedBy: 'combine.entryBlock' },
  consistency_stop: { group: 'pacing', what: 'past the target with today the best day: no more entries today', enforcedBy: 'combine.entryBlock' },
  one_position: { group: 'pacing', what: 'one position at a time across the account', enforcedBy: 'prop-state combineBlock and entrySinceSnapshot' },
  hard_stops: { group: 'priority', what: 'a news blackout, a no-entry window, a gate refusal: no trade', enforcedBy: 'the order gate (blackout, no-entry window, every refusal)' },
  trend_rule: { group: 'priority', what: 'any strategy against a trending 4h or 1h (with both ranging, against the 15m): no trade', enforcedBy: 'the scan and the order gate (checkTrend)' },
  entry_rule: { group: 'priority', what: "each policy's entry rule on its every entry: the bias frames that set the side (bias_agree on: all of them trend its way; neutral-15m-declared: every one that trends its way, none against, and with all ranging the 15m and the declared trend its way), no entry while the regime trends against it, the leg turned back while it doesn't trend the side's way (each key off: no check)", enforcedBy: 'entry-rule.js entryProblems in the reads checker: compose_check and the order gate\'s re-check (composed-reads); any other entry of the policy on the briefing (the gate\'s entry-rule check, lifecycle-gate.js policyRuleRefusal)' },
  trend_fade: { group: 'priority', what: 'no fade: a reversal strategy or a CHoCH read against a trending 4h or 1h is no trade (never counter)', enforcedBy: 'the trend rule (trendRule) for every strategy style: the scan and the order gate (checkTrend); the reads checker: a read against the side never agrees', taughtIn: STEP(2) },
  room: { group: 'priority', what: 'the first level ahead before the target: a read weighed in the count, never a no trade alone (the R:R to the target stays at least min_rr)', taughtIn: STEP(3) },
  mtf_read: { group: 'priority', what: 'the multi-timeframe read for the side sets the size', taughtIn: STEP(4) },
  skip_rules: { group: 'priority', what: "the strategy's own context filter and skip rules", taughtIn: STEP(5) },
  confluence: { group: 'priority', what: 'another strategy firing the other side: no trade', taughtIn: STEP(6) },
  secondary_context: { group: 'priority', what: 'secondary context is a read, never a veto alone (outside an attempt it may cut the size)', taughtIn: STEP(7) },
  halving: { group: 'priority', what: 'how a cut is rounded, and that cuts do not compound', taughtIn: { skill: 'position-sizing', step: null } },
});

const isMap = x => x && typeof x === 'object' && !Array.isArray(x);
const nonneg = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const share = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/** Problems with one policy's `multipliers` list (each an enforced item folded into the verdict). */
function multiplierErrors(list, name, enforced) {
  const out = [];
  if (!Array.isArray(list)) return [`policies.${name}.multipliers: a list (empty: none yet)`];
  list.forEach((m, i) => {
    const at = `policies.${name}.multipliers[${i}]`;
    if (!isMap(m)) { out.push(`${at}: a map of ${MULTIPLIER_KEYS.join(', ')}`); return; }
    for (const k of Object.keys(m)) if (!MULTIPLIER_KEYS.includes(k)) out.push(`${at}.${k}: unknown key`);
    if (!Object.hasOwn(ITEMS, m.item)) out.push(`${at}.item: one of the rulebook items (${Object.keys(ITEMS).join(', ')})`);
    else if (!enforced.includes(m.item)) out.push(`${at}.item: ${m.item} folds into the verdict only when it is classified enforced`);
    if (!(typeof m.fact === 'string' && NAME.test(m.fact))) out.push(`${at}.fact: the fact it is computed from`);
    if (!(isMap(m.values) && Object.keys(m.values).length && Object.values(m.values).every(share))) out.push(`${at}.values: { <fact value>: a multiplier from 0 to 1, ... }`);
    if (m.max_age_min !== undefined && !(nonneg(m.max_age_min) && m.max_age_min > 0)) out.push(`${at}.max_age_min: minutes above 0`);
  });
  return out;
}

/** `off`: a limit the rulebook turns off on purpose (0 is refused: a slip of the pen would turn it off unseen). */
const OFF = 'off';
const positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0;
const offOrPositive = x => x === OFF || positive(x);
/** What each value may be, with the message that says so. Every one is required: none falls back to a code default. */
const SIZING_RULES = {
  cushion_frac: [x => share(x), 'a share of the cushion, 0 to 1'],
  cap_usd: [offOrPositive, `dollars above 0, or ${OFF} (no cap)`],
  clock_k: [offOrPositive, `a number above 0, or ${OFF} (no clock sizing)`],
  r_per_session: [positive, 'the R a session makes, above 0'],
  min_size_guard: [nonneg, 'a multiple of the budget, 0 or more'],
  drawdown_halve_usd: [offOrPositive, `dollars above 0, or ${OFF} (no drawdown halving)`],
  stop_slippage_ticks: [x => typeof x === 'number' && Number.isFinite(x) && x >= MIN_STOP_SLIPPAGE_TICKS, `ticks, at least ${MIN_STOP_SLIPPAGE_TICKS}`],
  min_contracts: [x => Number.isInteger(x) && positive(x),'a whole number of contracts, 1 or more (micro-equivalents: a mini counts as its family\'s ratio)'],
  floor_stretch_max_usd: [offOrPositive, `dollars above 0, or ${OFF} (no floor stretch: under the composed cap's floor is a skip)`],
  near_target_usd: [offOrPositive, `dollars above 0, or ${OFF} (no near-target floor: full size up to the target)`],
};
const EXIT_RULE = [x => x === OFF || (positive(x) && x <= 50), `R above 0, at most 50, or ${OFF} (no trail)`];
/** A whole number of losing trades, at least 1, or off: 0 is refused (a slip of the pen would turn the stop off unseen). */
const STREAK_RULE = [x => x === OFF || (Number.isInteger(x) && x >= 1), `a whole number of losing trades, at least 1, or ${OFF} (no loss streak stop)`];
const SOFT_RULE = [offOrPositive, `dollars above 0, or ${OFF} (no soft daily stop)`];
/** A limit's value as the code reads it: `off` is 0 (the code's "no limit"). */
const limit = v => (v === OFF ? 0 : v);

/** What each exit value may be (every one stated; `off` where the mode doesn't use it). */
const EXIT_VALUE = {
  trail_activate_r: EXIT_RULE,
  trail_giveback_r: EXIT_RULE,
  lock_giveback_r: EXIT_RULE,
  trail_r: EXIT_RULE,
  trail_by: [x => x === OFF || TRAIL_BY.includes(x), `${TRAIL_BY.join(' or ')}, or ${OFF}`],
  swing_tf: [x => x === OFF || Object.hasOwn(SWING_TFS, x), `one of ${Object.keys(SWING_TFS).join(', ')}, or ${OFF}`],
  ratchet: [x => x === OFF || x === 'on', `on, or ${OFF} (the lock stays at the target's R less lock_giveback_r)`],
};

/**
 * Problems with one policy's exit: every key stated and valid, the mode one of EXIT_MODES, and the values the mode
 * uses set while the rest are `off`: target, the trail both off or both R (a trail on top); trail, both R;
 * target_then_trail, the lock, trail_by and trail_r set (trail_r: the R trail, and the structure trail's fallback with no swing in the bars),
 * swing_tf with trail_by structure only, and no 2R-style trail.
 */
function exitErrors(x, at) {
  const out = [];
  for (const k of Object.keys(x)) if (!EXIT_KEYS.includes(k)) out.push(`${at}.exit.${k}: unknown key (${EXIT_KEYS.join(', ')})`);
  if (x.mode === undefined) out.push(`${at}.exit.mode: missing; state it (${EXIT_MODES.join(', ')}: how every trade exits)`);
  else if (!EXIT_MODES.includes(x.mode)) out.push(`${at}.exit.mode: ${JSON.stringify(x.mode)} is not ${EXIT_MODES.join(', ')}`);
  for (const [k, [ok, what]] of Object.entries(EXIT_VALUE)) {
    if (x[k] === undefined) out.push(`${at}.exit.${k}: missing; state it (${OFF} where the mode doesn't use it)`);
    else if (!ok(x[k])) out.push(`${at}.exit.${k}: ${JSON.stringify(x[k])} is not ${what}`);
  }
  if (out.length) return out;
  const on = k => x[k] !== OFF;
  const need = (k, why) => { if (!on(k)) out.push(`${at}.exit.${k}: mode ${x.mode} needs it (${why})`); };
  const offIn = (k, why) => { if (on(k)) out.push(`${at}.exit.${k}: ${OFF} in mode ${x.mode} (${why})`); };
  const trail = ['trail_activate_r', 'trail_giveback_r'];
  const after = ['lock_giveback_r', 'trail_by', 'trail_r', 'swing_tf'];
  if (on(trail[0]) !== on(trail[1])) out.push(`${at}.exit: trail_activate_r and trail_giveback_r are both ${OFF} or both R (a trail needs both)`);
  if (x.mode === 'trail') {
    for (const k of trail) need(k, 'the trail is how every trade exits');
    for (const k of [...after, 'ratchet']) offIn(k, 'only target_then_trail trails after the target');
  } else if (x.mode === 'target') {
    for (const k of [...after, 'ratchet']) offIn(k, 'only target_then_trail trails after the target');
  } else {
    for (const k of trail) offIn(k, 'it trails only once the target is reached');
    need('lock_giveback_r', 'the stop locks at the target\'s R less it');
    need('trail_by', `${TRAIL_BY.join(' or ')}`);
    need('trail_r', 'the R trail, and the structure trail\'s fallback when the bars hold no swing at all');
    if (x.trail_by === 'structure') need('swing_tf', 'the swings the stop trails behind');
    else offIn('swing_tf', 'only a structure trail reads swings');
  }
  return out;
}

/** Validate a rulebook's frontmatter and body against its account folder. Messages name the key. */
function validateRulebook(data, body, folderName) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };
  for (const k of Object.keys(data)) if (!KEYS.includes(k)) errors.push(`unknown key "${k}"`);
  req(data.name === folderName, `name: "${data.name}" must be its account's folder name, "${folderName}" (a rulebook copied from another account?)`);
  req(typeof data.description === 'string' && data.description.length >= 20, 'description: at least 20 characters');
  req(data.learned === 'none' || (typeof data.learned === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.learned)), 'learned: none (today\'s values) or the date it was learned (YYYY-MM-DD)');
  // Enforced, so stated: never a code default.
  if (data.daily_loss_soft === undefined) errors.push('daily_loss_soft: missing; state it (enforced: no code default)');
  else req(SOFT_RULE[0](data.daily_loss_soft), `daily_loss_soft: ${JSON.stringify(data.daily_loss_soft)} is not ${SOFT_RULE[1]}`);
  if (data.loss_streak_stop === undefined) errors.push('loss_streak_stop: missing; state it (enforced: no code default)');
  else req(STREAK_RULE[0](data.loss_streak_stop), `loss_streak_stop: ${JSON.stringify(data.loss_streak_stop)} is not ${STREAK_RULE[1]}`);
  const list = k => (Array.isArray(data[k]) ? data[k] : null);
  const enforced = list('enforced');
  const taught = list('taught');
  req(enforced && taught, 'enforced and taught: the rulebook items of each kind (lists)');
  if (enforced && taught) {
    for (const k of Object.keys(ITEMS)) {
      const n = enforced.filter(x => x === k).length + taught.filter(x => x === k).length;
      req(n === 1, `${k}: classified ${n ? 'more than once' : 'neither enforced nor taught'} (each item is exactly one)`);
    }
    for (const k of [...enforced, ...taught]) req(Object.hasOwn(ITEMS, k), `${k}: not a rulebook item (${Object.keys(ITEMS).join(', ')})`);
    for (const k of enforced) if (Object.hasOwn(ITEMS, k)) req(Boolean(ITEMS[k].enforcedBy), `${k}: classified enforced, but no code holds it (taught in ${ITEMS[k].taughtIn && ITEMS[k].taughtIn.skill})`);
    for (const k of taught) if (Object.hasOwn(ITEMS, k)) req(Boolean(ITEMS[k].taughtIn), `${k}: classified taught, but no skill teaches it (the code holds it)`);
  }
  if (data.policies !== undefined) {
    if (!isMap(data.policies)) errors.push('policies: a map of policy strategy name -> { sizing, exit, multipliers, entry }');
    else {
      for (const [name, p] of Object.entries(data.policies)) {
        const at = `policies.${name}`;
        if (!NAME.test(name) || !isMap(p)) { errors.push(`${at}: a policy strategy's name and a map of ${POLICY_KEYS.join(', ')}`); continue; }
        for (const k of Object.keys(p)) if (!POLICY_KEYS.includes(k)) errors.push(`${at}.${k}: unknown key (${POLICY_KEYS.join(', ')})`);
        // Every key stated and valid: one left out would take the code's default, and some are off (no cap, no
        // drawdown halving), which would loosen risk without a word in the rulebook.
        if (!isMap(p.sizing)) errors.push(`${at}.sizing: missing or not a map; state every key (${SIZING_KEYS.join(', ')})`);
        else {
          for (const k of Object.keys(p.sizing)) if (!SIZING_KEYS.includes(k)) errors.push(`${at}.sizing.${k}: unknown key (${SIZING_KEYS.join(', ')})`);
          for (const k of SIZING_KEYS) {
            if (p.sizing[k] === undefined) errors.push(`${at}.sizing.${k}: missing; state it (no code default)`);
            else req(SIZING_RULES[k][0](p.sizing[k]), `${at}.sizing.${k}: ${JSON.stringify(p.sizing[k])} is not ${SIZING_RULES[k][1]}`);
          }
        }
        if (!isMap(p.exit)) errors.push(`${at}.exit: missing or not a map; state ${EXIT_KEYS.join(', ')}`);
        else errors.push(...exitErrors(p.exit, at));
        if (p.multipliers === undefined) errors.push(`${at}.multipliers: missing; state it ([] for none)`);
        else errors.push(...multiplierErrors(p.multipliers, name, enforced || []));
        errors.push(...entryRuleErrors(p.entry, at));
      }
    }
  }
  for (const h of REQUIRED_SECTIONS) req(String(body).includes(h), `body: missing section "${h}"`);
  return errors;
}

/** The rulebook at `file`, parsed and validated against its folder; null when there is no file. */
function loadRulebookFile(file) {
  if (!fs.existsSync(file)) return null;
  const folderName = path.basename(path.dirname(file));
  let parsed;
  try {
    parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { name: folderName, file, valid: false, errors: [err.message] };
  }
  const errors = validateRulebook(parsed.data, parsed.body, folderName);
  return { ...parsed.data, file, body: parsed.body, valid: errors.length === 0, errors };
}

/**
 * A policy's entry in a valid rulebook ({ sizing, exit, multipliers, entry }, a sizing `off` read as 0), or null when it has
 * none. The exit as the strategy loader reads it: its mode, and the trail's two values only when they are R (`off`: no trail).
 */
function policyEntry(rulebook, name) {
  const p = rulebook && isMap(rulebook.policies) && Object.hasOwn(rulebook.policies, name) ? rulebook.policies[name] : null;
  if (!p) return null;
  const sizing = Object.fromEntries(Object.entries(p.sizing || {}).map(([k, v]) => [k, limit(v)]));
  const x = isMap(p.exit) ? p.exit : {};
  const exit = { mode: x.mode, ...Object.fromEntries(EXIT_KEYS.filter(k => k !== 'mode' && x[k] !== OFF && x[k] !== undefined).map(k => [k, x[k]])) };
  return { sizing, exit, multipliers: p.multipliers, entry: isMap(p.entry) ? { ...p.entry } : null };
}

/**
 * The verdict's multiplier (R4): the product of the enforced multiplier items, each the value its
 * fact maps to. Fails closed: a missing fact, one older than the item's max_age_min (or with no
 * time when it has one), or a value the item doesn't map, sets that item to 0, so the setup is
 * skipped. `facts`: { <fact>: { value, at } }. Returns { multiplier, why } (why: the zeroed items).
 */
function ceiling(items = [], facts = {}, now = new Date()) {
  let multiplier = 1;
  const why = [];
  for (const m of items || []) {
    const f = facts && isMap(facts[m.fact]) ? facts[m.fact] : null;
    const age = f ? (now.getTime() - Date.parse(f.at)) / 60000 : NaN;
    let v;
    if (!f || f.value === undefined || f.value === null) { v = 0; why.push(`${m.item}: no ${m.fact} fact`); }
    else if (m.max_age_min !== undefined && !(age <= m.max_age_min)) { v = 0; why.push(`${m.item}: the ${m.fact} fact is stale or has no time`); }
    else if (!(isMap(m.values) && Object.hasOwn(m.values, String(f.value)) && share(m.values[String(f.value)]))) { v = 0; why.push(`${m.item}: ${m.fact} ${JSON.stringify(f.value)} has no multiplier`); }
    else {
      v = m.values[String(f.value)];
      if (v === 0) why.push(`${m.item}: ${m.fact} ${JSON.stringify(f.value)} allows no size`);
    }
    multiplier *= v;
  }
  return { multiplier: Math.max(0, Math.min(1, multiplier)), why };
}

module.exports = { FILE, OFF, ITEMS, KEYS, SIZING_KEYS, EXIT_KEYS, EXIT_MODES, TRAIL_BY, SIZING_RULES, SOFT_RULE, limit, validateRulebook, multiplierErrors, loadRulebookFile, policyEntry, ceiling };
