'use strict';

/**
 * A proposal may only tighten a rulebook (docs/LEARNED-RULEBOOK.md R1-R4; the owner: the rulebook stays robust,
 * limits are never loosened). The edited rulebook must be valid (trading/rulebook.js validateRulebook), and then,
 * key by key against the rulebook as it is now:
 *
 * - every limit equal or stricter, by its direction (DIRECTION below); `off` (no limit) never where the current
 *   value is a limit (except floor_stretch_max_usd, whose `off` is no stretch at all: its strictest, OFF_STRICTEST);
 * - multipliers, compared as the verdict applies them (effective): for every value of every fact, including the
 *   values no entry lists (0: the setup is skipped), the effective multiplier never rises, and a fact is never
 *   accepted staler; so a value added above 0 where it was unlisted, a raised value, or a removed entry is refused,
 *   and duplicates are judged on their product;
 * - no policy added or removed; an exit (its mode and trail) unchanged: it is searched (R10), never a limit to loosen;
 * - no item moved out of `enforced`;
 * - no key removed.
 *
 *   loosenings(before, after)    [message naming the key] (empty: as strict or stricter)
 *   rulebookErrors(file, beforeText, afterText)   validateRulebook's problems, then loosenings
 */

const path = require('path');
const { parseFrontmatter } = require('../frontmatter');
const { OFF, validateRulebook } = require('../trading/rulebook');

/** Which way is stricter: 'lower' (a smaller number is stricter) or 'higher'. `off` is no limit: the loosest. */
const DIRECTION = Object.freeze({
  daily_loss_soft: 'lower', // dollars down before entries stop: stopping sooner is stricter
  loss_streak_stop: 'lower', // losing trades in a row before the session stops: stopping sooner is stricter
  cushion_frac: 'lower', // share of the cushion a trade risks
  cap_usd: 'lower', // dollars a trade risks at most
  clock_k: 'lower', // at most k x what the pass still needs per session: a smaller k sizes smaller
  r_per_session: 'higher', // divides the clock's size: a larger value sizes smaller
  min_size_guard: 'lower', // one contract may risk up to this many budgets: lower skips sooner
  drawdown_halve_usd: 'lower', // halve the budget this far below the peak: sooner is stricter
  stop_slippage_ticks: 'higher', // a stop's expected slippage counted in the risk: more is stricter
  min_contracts: 'higher', // the floor of contracts: a higher one skips sooner (never sizes past the budget)
  floor_stretch_max_usd: 'lower', // dollars the floor may risk over a composed cap while healthy: less is stricter
});
/** Limits whose `off` is the strictest value, not the loosest (off: no floor stretch at all): compared as 0. */
const OFF_STRICTEST = Object.freeze(['floor_stretch_max_usd']);

const isMap = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function limitLooser(key, at, was, now, out) {
  if (now === undefined) { out.push(`${at}: removed (a rulebook key is never removed)`); return; }
  if (same(was, now)) return;
  if (OFF_STRICTEST.includes(key)) {
    // `off` is none at all (the strictest); a number is compared as dollars, where less is stricter.
    const n = v => (v === OFF ? 0 : v);
    if (typeof n(was) !== 'number' || typeof n(now) !== 'number') { out.push(`${at}: ${JSON.stringify(was)} -> ${JSON.stringify(now)} is not comparable`); return; }
    if (n(now) > n(was)) out.push(`${at}: ${JSON.stringify(was)} -> ${JSON.stringify(now)} is looser (only a lower value, or off, is stricter)`);
    return;
  }
  if (now === OFF) { if (was !== OFF) out.push(`${at}: ${JSON.stringify(was)} -> off turns a limit off (looser)`); return; }
  if (!DIRECTION[key]) { out.push(`${at}: ${JSON.stringify(was)} -> ${JSON.stringify(now)}: not a limit with a known direction, so never changed`); return; }
  if (was === OFF) return; // a limit where there was none: stricter
  if (typeof was !== 'number' || typeof now !== 'number') { out.push(`${at}: ${JSON.stringify(was)} -> ${JSON.stringify(now)} is not comparable`); return; }
  const looser = DIRECTION[key] === 'higher' ? now < was : now > was;
  if (looser) out.push(`${at}: ${was} -> ${now} is looser (${DIRECTION[key] === 'higher' ? 'only a higher' : 'only a lower'} value is stricter)`);
}

/**
 * The multipliers as the verdict applies them (trading/rulebook.js ceiling), per fact: every entry reading the fact
 * multiplies in, a value an entry doesn't list scores 0 (the setup is skipped), and the youngest max_age_min of its
 * entries decides when the fact is stale. Duplicate entries are normalized this way too.
 */
function effective(list) {
  const groups = new Map();
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m.fact !== 'string') continue;
    if (!groups.has(m.fact)) groups.set(m.fact, []);
    groups.get(m.fact).push(m);
  }
  const at = (entries, v) => entries.reduce((p, e) => {
    const x = isMap(e.values) && Object.hasOwn(e.values, v) && typeof e.values[v] === 'number' ? e.values[v] : 0;
    return p * x;
  }, 1);
  const maxAge = entries => Math.min(...entries.map(e => (typeof e.max_age_min === 'number' ? e.max_age_min : Infinity)));
  return { groups, at, maxAge };
}

const EPS = 1e-12;

/** Any fact value whose effective multiplier rises, or a fact accepted staler, is a loosening. */
function multipliersLooser(at, was, now, out) {
  if (!Array.isArray(now)) { out.push(`${at}: removed or not a list`); return; }
  const b = effective(was);
  const a = effective(now);
  for (const fact of new Set([...b.groups.keys(), ...a.groups.keys()])) {
    const before = b.groups.get(fact) || [];
    const after = a.groups.get(fact) || [];
    const keys = new Set([...before, ...after].flatMap(e => (isMap(e.values) ? Object.keys(e.values) : [])));
    for (const v of keys) {
      const x = before.length ? b.at(before, v) : 1;
      const y = after.length ? a.at(after, v) : 1;
      if (y > x + EPS) out.push(`${at} ${fact} = ${v}: the effective size multiplier rises from ${x} to ${y} (only lower)`);
    }
    // A value no entry lists: 0 while any entry reads the fact, 1 once none does.
    if (before.length && !after.length) out.push(`${at} ${fact}: removed; its unlisted values rise from 0 to 1 (a size multiplier is never removed)`);
    if (before.length && after.length && a.maxAge(after) > b.maxAge(before)) {
      out.push(`${at} ${fact}.max_age_min: ${b.maxAge(before)} -> ${a.maxAge(after)} accepts staler facts (only lower)`);
    }
  }
}

function loosenings(before, after) {
  const out = [];
  for (const k of Object.keys(before)) if (after[k] === undefined) out.push(`${k}: removed (a rulebook key is never removed)`);
  for (const k of ['daily_loss_soft', 'loss_streak_stop']) if (before[k] !== undefined) limitLooser(k, k, before[k], after[k], out);
  const enforcedNow = new Set(Array.isArray(after.enforced) ? after.enforced : []);
  for (const k of Array.isArray(before.enforced) ? before.enforced : []) if (!enforcedNow.has(k)) out.push(`enforced: ${k} moved out of enforced (the code no longer holds it)`);
  const pb = isMap(before.policies) ? before.policies : {};
  const pa = isMap(after.policies) ? after.policies : {};
  for (const name of Object.keys(pa)) if (!Object.hasOwn(pb, name)) out.push(`policies.${name}: added (a policy is sized only from a rulebook the owner wrote)`);
  for (const [name, p] of Object.entries(pb)) {
    const at = `policies.${name}`;
    const q = pa[name];
    if (!isMap(q)) { out.push(`${at}: removed`); continue; }
    for (const k of Object.keys(p)) if (q[k] === undefined) out.push(`${at}.${k}: removed`);
    for (const [k, v] of Object.entries(isMap(p.sizing) ? p.sizing : {})) limitLooser(k, `${at}.sizing.${k}`, v, isMap(q.sizing) ? q.sizing[k] : undefined, out);
    if (!same(p.exit, q.exit)) out.push(`${at}.exit: changed (the exit mode and trail are searched, R10; never a proposal's to change)`);
    multipliersLooser(`${at}.multipliers`, p.multipliers, q.multipliers, out);
  }
  return out;
}

/** The edited rulebook's problems: invalid (validateRulebook), else every loosening against the current one. */
function rulebookErrors(file, beforeText, afterText) {
  let before;
  let after;
  try {
    before = parseFrontmatter(beforeText);
    after = parseFrontmatter(afterText);
  } catch (err) {
    return [`${file}: the frontmatter no longer parses after the edit (${err.message})`];
  }
  const invalid = validateRulebook(after.data, after.body, path.basename(path.dirname(file)));
  if (invalid.length) return invalid.map(e => `${file}: invalid after the edit: ${e}`);
  return loosenings(before.data, after.data).map(e => `${file}: ${e}; a proposal only tightens a rulebook`);
}

module.exports = { DIRECTION, loosenings, rulebookErrors };
