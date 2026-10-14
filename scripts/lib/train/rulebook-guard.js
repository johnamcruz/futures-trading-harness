'use strict';

/**
 * A proposal may only tighten a rulebook (docs/LEARNED-RULEBOOK.md R1-R4; the owner: the rulebook stays robust,
 * limits are never loosened). The edited rulebook must be valid (trading/rulebook.js validateRulebook), and then,
 * key by key against the rulebook as it is now:
 *
 * - every limit equal or stricter, by its direction (DIRECTION below); `off` (no limit) never where the current
 *   value is a limit;
 * - multipliers: none removed, none of their values removed or raised, max_age_min never raised; new ones only
 *   lower sizes (a multiplier is at most 1), so they may be added;
 * - no policy added or removed; an exit (the trail) unchanged: it is searched (R10), never a limit to loosen;
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
  cushion_frac: 'lower', // share of the cushion a trade risks
  cap_usd: 'lower', // dollars a trade risks at most
  clock_k: 'lower', // at most k x what the pass still needs per session: a smaller k sizes smaller
  r_per_session: 'higher', // divides the clock's size: a larger value sizes smaller
  min_size_guard: 'lower', // one contract may risk up to this many budgets: lower skips sooner
  drawdown_halve_usd: 'lower', // halve the budget this far below the peak: sooner is stricter
  stop_slippage_ticks: 'higher', // a stop's expected slippage counted in the risk: more is stricter
});

const isMap = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function limitLooser(key, at, was, now, out) {
  if (now === undefined) { out.push(`${at}: removed (a rulebook key is never removed)`); return; }
  if (same(was, now)) return;
  if (now === OFF) { if (was !== OFF) out.push(`${at}: ${JSON.stringify(was)} -> off turns a limit off (looser)`); return; }
  if (!DIRECTION[key]) { out.push(`${at}: ${JSON.stringify(was)} -> ${JSON.stringify(now)}: not a limit with a known direction, so never changed`); return; }
  if (was === OFF) return; // a limit where there was none: stricter
  if (typeof was !== 'number' || typeof now !== 'number') { out.push(`${at}: ${JSON.stringify(was)} -> ${JSON.stringify(now)} is not comparable`); return; }
  const looser = DIRECTION[key] === 'higher' ? now < was : now > was;
  if (looser) out.push(`${at}: ${was} -> ${now} is looser (${DIRECTION[key] === 'higher' ? 'only a higher' : 'only a lower'} value is stricter)`);
}

function multipliersLooser(at, was, now, out) {
  if (!Array.isArray(now)) { out.push(`${at}: removed or not a list`); return; }
  const id = m => `${m && m.item}|${m && m.fact}`;
  for (const m of Array.isArray(was) ? was : []) {
    const n = now.find(x => id(x) === id(m));
    if (!n) { out.push(`${at} ${id(m)}: removed (a size multiplier is never removed)`); continue; }
    for (const [k, v] of Object.entries(m.values || {})) {
      const nv = n.values ? n.values[k] : undefined;
      if (nv === undefined) out.push(`${at} ${id(m)}.values.${k}: removed`);
      else if (nv > v) out.push(`${at} ${id(m)}.values.${k}: ${v} -> ${nv} raises a size multiplier (only lower)`);
    }
    if (m.max_age_min !== undefined && (n.max_age_min === undefined || n.max_age_min > m.max_age_min)) {
      out.push(`${at} ${id(m)}.max_age_min: ${m.max_age_min} -> ${n.max_age_min} accepts staler facts (only lower)`);
    }
  }
}

function loosenings(before, after) {
  const out = [];
  for (const k of Object.keys(before)) if (after[k] === undefined) out.push(`${k}: removed (a rulebook key is never removed)`);
  if (before.daily_loss_soft !== undefined) limitLooser('daily_loss_soft', 'daily_loss_soft', before.daily_loss_soft, after.daily_loss_soft, out);
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
    if (!same(p.exit, q.exit)) out.push(`${at}.exit: changed (the trail is searched, R10; never a proposal's to change)`);
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
