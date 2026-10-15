'use strict';

/**
 * The look ledger's rules (docs/LEARNED-RULEBOOK.md R16, R17, R32, section 10
 * step 2): which looks at the schedule's months (prop/splits.js) are allowed,
 * and which count against a look budget. Pure: the ledger itself (the
 * candidate, the date and the result of each look) is kept with the
 * rulebook's evidence, which the search and promotion (R15-R16) and the
 * training loop (R25) write; this module reads it and refuses misuse before a
 * look is taken. The ledger is required: without it no look is allowed.
 *
 * A look is { candidate, purpose, ranges: [{ from, to }] } (or one
 * { from, to }), each range [from, to) inside one unit of the schedule
 * (splits.unitContaining: a walk-forward quarter, or a whole block). Its
 * purpose is mandatory, one of PURPOSES:
 *
 * - tuning: what the proposer, Optuna or calibration is shown;
 * - judging: what chooses or verifies (Select's ranking, the verifiers, the gate);
 * - reasoning-fix: a fix to a reasoning or fact error (a stated reason the
 *   briefing contradicts), which makes no claim about the market.
 *
 * Per unit (allowed):
 *
 * - train, a walk-forward tuning quarter: any purpose, logged, no budget;
 * - select: judging only, logged, no budget;
 * - out-of-sample: judging only, LOOK_BUDGET looks, then retired;
 * - the walk-forward held-out quarters: judging only (the verifiers), one
 *   budget of LOOK_BUDGET looks shared by every held-out quarter (R17: "only
 *   those looks count against the 3-look budget"). Resetting it at a
 *   promotion (R17: months after the last promotion) belongs to the training
 *   loop, not built; until then it never resets;
 * - Recent: reasoning-fix only (section 10 step 2), logged, no budget; every
 *   other use refused until it becomes the out-of-sample window (R16);
 * - the reserve half-years: refused.
 *
 * A look counts once per budget it touches. The recorded looks
 * (splits.RECORDED_LOOKS) are always in the ledger, first, and always count;
 * a reasoning-fix look spends no budget where every unit it touches allows
 * one; any other look does, tagged or not (a ledger entry mis-tagged
 * reasoning-fix at a budgeted unit spends). An out-of-sample look counts against every window its units share a
 * month with, whatever the window is called, so when Recent becomes the
 * out-of-sample window it keeps the looks already counted there (the June
 * 1-5, 2026 replay).
 */

const splits = require('./splits');
const schedule = require('../schedule');

const { unitContaining } = splits;

/*
 * The ledger file's format, the one every writer uses (the evaluator, prop/evaluate-run.js, and the
 * scorecard, replay/scorecard.js), so their looks count against one budget: JSON lines, one look
 * ({ candidate, purpose, ranges, at, ... }) per line, appended. A file holding one JSON list of looks (the
 * scorecard's earlier format) still reads, every look kept; the next append rewrites it as lines.
 */

/** Whether a ledger file's text is the earlier format, one JSON list of looks. */
const isListFormat = text => String(text).trimStart().startsWith('[');

/**
 * The looks in a ledger file's text (either format), in order. Throws, naming the line, on anything else. An
 * empty (or whitespace-only) text is refused: an existing ledger file with nothing in it may be a truncated one,
 * and reading it as no looks would reset every budget. Only a missing file starts a ledger (on purpose).
 */
function parseLedger(text, where = 'the ledger') {
  const src = String(text);
  if (!src.trim()) throw new Error(`${where} is empty: an existing ledger with no looks may be truncated, so no look is checked against it (start a new ledger only as a new, missing file, on purpose)`);
  if (isListFormat(src)) {
    let list;
    try { list = JSON.parse(src); } catch (e) { throw new Error(`${where}: not a JSON list of looks (${e.message})`, { cause: e }); }
    if (!Array.isArray(list)) throw new Error(`${where}: not a JSON list of looks`);
    list.forEach((e, k) => { if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${where}: entry ${k + 1} is not a look`); });
    return list;
  }
  const out = [];
  src.split('\n').forEach((l, k) => {
    if (!l.trim()) return;
    let e;
    try { e = JSON.parse(l); } catch (err) { throw new Error(`${where}:${k + 1}: not a JSON look (${err.message})`, { cause: err }); }
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${where}:${k + 1}: not a JSON look (not an object)`);
    out.push(e);
  });
  return out;
}

/** The ledger file's text for these looks (JSON lines). */
const formatLedger = looks => looks.map(e => `${JSON.stringify(e)}\n`).join('');

/** Looks per budget (an out-of-sample window; the held-out quarters together) before it is retired (R16): the schedule's prop.sealed.lookBudget. */
const lookBudget = () => schedule.current().prop.lookBudget;
const PURPOSES = Object.freeze(['tuning', 'judging', 'reasoning-fix']);
const HELD_OUT = 'walk-forward held-out';

/** The purposes a unit allows. */
function allowed(u) {
  if (u.role === 'train' || u.part === 'tuning') return PURPOSES;
  if (u.role === 'select' || u.role === 'oos' || u.part === 'held-out') return ['judging'];
  if (u.role === 'recent') return ['reasoning-fix'];
  return [];
}

/**
 * The look a unit requires (schedule.js resolve): { purposes (allowed), budget ('walk-forward held-out' for a held-out
 * quarter, 'window' for an out-of-sample window, null for none), budgetLooks (its size, or null) }.
 */
function lookRule(u) {
  const b = u.part === 'held-out' ? 'walk-forward held-out' : u.role === 'oos' ? 'window' : null;
  return { purposes: [...allowed(u)], budget: b, budgetLooks: b ? lookBudget() : null };
}

const keyOf = u => `${u.block}${u.part ? ` ${u.part}` : ''} [${u.from}, ${u.to})`;

function rangesOf(look) {
  if (!look || typeof look !== 'object') throw new Error('a look: { candidate, purpose, ranges: [{ from, to }] }');
  const ranges = Array.isArray(look.ranges) ? look.ranges : [{ from: look.from, to: look.to }];
  if (!ranges.length) throw new Error('a look needs at least one range');
  return ranges;
}

/** The schedule units a look touches, each once, in order: [{ key, unit }]. Throws on a range outside one unit. */
function unitsOf(look) {
  const out = new Map();
  const given = v => v !== undefined && v !== null;
  for (const r of rangesOf(look)) {
    if (!r || !given(r.from) || !given(r.to)) throw new Error('a range needs from and to');
    let unit;
    try {
      unit = unitContaining(r.from, r.to);
    } catch (e) {
      throw new Error(`range ${r.from}..${r.to}: ${e.message}`, { cause: e });
    }
    if (!unit) throw new Error(`range ${r.from}..${r.to} is empty or crosses a unit boundary: every look lies inside one unit`);
    out.set(keyOf(unit), unit);
  }
  return [...out].map(([key, unit]) => ({ key, unit }));
}

const shares = (a, b) => a.from < b.to && b.from < a.to; // ISO dates compare as strings

/** The budget a unit's looks spend: { key, touches(unit) }, or null where there is none. */
function budgetOf(unit) {
  if (unit.part === 'held-out') return { key: HELD_OUT, touches: u => u.part === 'held-out' };
  if (unit.role === 'oos') return { key: keyOf(unit), touches: u => shares(u, unit) };
  return null;
}

/**
 * The ledger as { units, spends } per look, the recorded looks first (they always spend). Throws on a ledger
 * that is missing or not a list, or an entry that doesn't resolve.
 */
function ledgerEntries(ledger) {
  if (!Array.isArray(ledger)) throw new Error('the ledger is required, a list of looks');
  return [
    ...splits.RECORDED_LOOKS.map(e => ({ units: unitsOf(e).map(x => x.unit), spends: true })),
    ...ledger.map(e => {
      const units = unitsOf(e).map(x => x.unit);
      // Waived only for a reasoning-fix look where every unit allows one: a mis-tagged entry at a budget spends.
      const waived = e.purpose === 'reasoning-fix' && units.every(u => allowed(u).includes('reasoning-fix'));
      return { units, spends: !waived };
    }),
  ];
}

/** Looks so far at a unit: { looks (every look touching it), budgeted, budget, spent, remaining } (null without one). */
function usageAt(unit, entries) {
  const looks = entries.filter(e => e.units.some(u => shares(u, unit))).length;
  const budget = budgetOf(unit);
  if (!budget) return { looks, budgeted: false, budget: null, spent: null, remaining: null };
  const spent = entries.filter(e => e.spends && e.units.some(budget.touches)).length;
  return { looks, budgeted: true, budget: budget.key, spent, remaining: Math.max(0, lookBudget() - spent) };
}

/**
 * Looks per unit so far, the recorded looks first, then `ledger`: Map key -> { unit, looks, budgeted, budget,
 * spent, remaining }. A ledger that is missing or can't be read throws.
 */
function lookUsage(ledger) {
  const entries = ledgerEntries(ledger);
  const usage = new Map();
  for (const unit of entries.flatMap(e => e.units)) usage.set(keyOf(unit), { unit, ...usageAt(unit, entries) });
  return usage;
}

function refusalFor(u, purpose) {
  const ok = allowed(u);
  if (!ok.includes(purpose)) {
    if (u.role === 'reserve') return `${u.key} is reserved for a later out-of-sample window: nothing looks at it until the current window is retired (R16)`;
    if (u.role === 'recent') return `${u.key} is reserved for a later out-of-sample window: only a reasoning-fix look (no market claim, section 10 step 2) until the current window is retired (R16)`;
    return `${u.key} allows ${ok.join(', ')} looks only, not ${purpose}`;
  }
  if (u.budgeted && purpose !== 'reasoning-fix' && u.remaining === 0) {
    return `${u.key}: the ${u.budget} budget has used its ${lookBudget()} looks and is retired (R16, R17)`;
  }
  return null;
}

/**
 * Whether a look may be taken now: { ok, refusals, units }. units lists each unit the look touches with
 * { key, role, block, part, looks, budgeted, budget, spent, remaining } (before this look). Refused: no candidate,
 * no purpose or an unknown one, no ledger, a range outside one unit, a purpose the unit doesn't allow, or a
 * budget with no look left.
 */
function checkLook(look, ledger) {
  const refusals = [];
  let units = [];
  if (!look || typeof look.candidate !== 'string' || !look.candidate.trim()) refusals.push('a look names its candidate (R16)');
  const purpose = look ? look.purpose : undefined;
  if (!PURPOSES.includes(purpose)) refusals.push(`a look names its purpose, one of ${PURPOSES.join(', ')}; not ${String(purpose)}`);
  let entries;
  try {
    entries = ledgerEntries(ledger);
  } catch (e) {
    return { ok: false, refusals: [...refusals, `the ledger can't be read: ${e.message}`], units };
  }
  // The sealed rule (schedule.js): no look under a schedule whose sealed prop windows changed after a look.
  refusals.push(...schedule.sealedRefusals('prop', ledger));
  try {
    units = unitsOf(look).map(({ key, unit }) => ({ key, role: unit.role, block: unit.block, part: unit.part, ...usageAt(unit, entries) }));
  } catch (e) {
    return { ok: false, refusals: [...refusals, e.message], units };
  }
  if (PURPOSES.includes(purpose)) {
    for (const u of units) {
      const r = refusalFor(u, purpose);
      if (r) refusals.push(r);
    }
  }
  return { ok: refusals.length === 0, refusals, units };
}

module.exports = {
  get LOOK_BUDGET() { return lookBudget(); },
  PURPOSES, lookRule, lookUsage, checkLook, parseLedger, formatLedger, isListFormat,
};
