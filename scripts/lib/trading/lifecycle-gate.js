'use strict';

/**
 * The order gate's `composed-reads` check (the composed-entry design section 3.6): a trade_lifecycle entry goes only on
 * the model's compose record (compose_check: trade-lifecycle.js) for this cycle's bar and side, every read of it true
 * and agreeing NOW. A hard check, keyed on the order (its setup tag, or a policy whose latest verdict trades it), run
 * outside the skippable checks and whether or not the strategy document loads; it stands in for trigger-fired. Exits
 * and protective orders never reach it (order-gate.js returns before every entry check).
 *
 * The entry must:
 *   - be in a runner's cycle on a bar (FTH_CYCLE_BARS) whose bar briefing is the one on disk (fact-claims briefingFor);
 *   - have a compose record for that bar, its root and its side (the latest such record is the one judged);
 *   - be on the record's own contract (its symbol: a size stated for MNQ is not one for NQ);
 *   - be before the record's expiry (the next base-bar close) and the first entry on the family and side since the
 *     cycle bar opened (one entry per bar and side, whichever record it came from);
 *   - pass the reads checker (composed-reads.js) run again on the record's reads against that briefing (the record's
 *     own `ok` and checks are never read): every read true, agreeing with the side, every step stated;
 *   - match the plan worked out again from the re-checked reads (trade-lifecycle.js planOf: the D3 buffer, the D13
 *     minimum stop, risk.min_rr, the stated size within risk.max_risk_usd), equal to the record's plan:
 *     stopLossBracket.ticks and takeProfitBracket.ticks are its ticks;
 *   - be a limit at the record's entry price or better for its side;
 *   - be the record's stated size. The ceilings over it are the gate's own checks (max-risk, max-order-size, and in a
 *     prop attempt the policy verdict's size): at or below, never above.
 * Anything missing, unreadable or throwing refuses (fails closed).
 *
 *   isComposed(strategy)            a strategy (or a name) of signal composed, or trade_lifecycle
 *   recordsAt(home, root, bar)      the root's trade_lifecycle records for the bar opened at `bar` (same instant)
 *   readsOf(record)                 the reads as the model stated them: [{ step, skill, read, why }]
 *   composedName({ setupName, named, strategies, home, root })   the composed strategy the order enters by, or null
 *   limitRefusal({ side, type, limitPrice, reference, tick })    why the entry isn't a limit at the reference or better
 *   composedRefusal({ name, strategy, home, root, input, now, cycleBars, entries, specOf, pluginRoot })
 *                                   { message: why it is refused | null, check, record, plan, room }
 *   recordUsed(entries, { since, side }, root)   a successful non-exit entry on the root's family, that side (an entry
 *                                   whose side can't be read counts), placed at or after `since`
 */

const fs = require('fs');
const path = require('path');
const { familyOf, familyRoot } = require('./contracts');
const { contractRoot, entryTime, mayBeRoot } = require('./journal');
const { latestVerdict } = require('./prop-state');
const { briefingFor } = require('./fact-claims');
const { checkReads } = require('./composed-reads');
const { STRATEGY, readRecords, planOf } = require('./trade-lifecycle');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const SIGNAL = 'composed';
const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;
const EPS = 1e-9;
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const fmt = (x, tick) => Number(x).toFixed((String(tick).split('.')[1] || '').length);

const isComposed = s => (typeof s === 'string' ? s === STRATEGY : Boolean(s) && (s.signal === SIGNAL || s.name === STRATEGY));
const sameInstant = (a, b) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
const recordsAt = (home, root, bar) => readRecords(home, root).filter(r => r.strategy === STRATEGY && sameInstant(r.bar, bar));
const readsOf = record => (isObj(record) && Array.isArray(record.reads) ? record.reads : [])
  .map(r => (isObj(r) ? { step: r.step, skill: r.skill, read: r.read, why: r.why } : {}));

function skillFolders(root) {
  try {
    return fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(root, 'skills', e.name, 'SKILL.md'))).map(e => e.name);
  } catch (_err) {
    return [];
  }
}

function composedName({ setupName, named = null, strategies = null, home, root }) {
  if (!setupName) return null;
  if (isComposed(setupName)) return setupName;
  if (named && named.signal === SIGNAL) return named.name;
  if (named && named.signal === 'policy') {
    const v = latestVerdict(home, named.name, root);
    const comp = v && v.component;
    if (comp && (isComposed(comp) || (strategies || []).some(s => s && s.name === comp && s.signal === SIGNAL))) return comp;
  }
  return null;
}

const sideOfEntry = e => {
  const s = String((e.data && e.data.request && e.data.request.side) || '').toLowerCase();
  return s === 'buy' ? 'long' : s === 'sell' ? 'short' : null;
};

function recordUsed(entries, { since, side = null } = {}, root) {
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return true;
  const fam = r => (familyOf(r) ? familyOf(r).micro : r);
  return (entries || []).some(e => e && e.kind === 'order_placed' && e.data && e.data.result && e.data.result.success === true
    && !RISK_REDUCING.test(String(e.text || '')) && entryTime(e) >= at && (!side || !sideOfEntry(e) || sideOfEntry(e) === side)
    && (mayBeRoot(e.contractId, root) || (Boolean(e.contractId) && fam(contractRoot(e.contractId)) === fam(root))));
}

function limitRefusal({ side, type, limitPrice, reference, tick } = {}) {
  if (String(type || '').toLowerCase() !== 'limit') return `the entry is ${type ? `a ${String(type).toLowerCase()}` : 'not a limit'} order: a trade-lifecycle entry is a limit at the record's entry price ${reference} or better (its stop then lands at the level or beyond it)`;
  const p = limitPrice === undefined || limitPrice === null || limitPrice === '' ? NaN : Number(limitPrice);
  if (!Number.isFinite(p)) return `the limit entry has no limitPrice: it is the record's entry price ${reference} or better`;
  const worse = side === 'long' ? p > reference + EPS : p < reference - EPS;
  if (worse) return `the limit ${fmt(p, tick || 0.25)} is worse than the record's entry price ${reference} for a ${side}: the stop would land short of the level`;
  return null;
}

const quote = r => `"${r.read}"`;

function composedRefusal({ name, strategy = null, home, root, input = {}, now = new Date(), cycleBars = {}, entries = [], specOf = () => null, pluginRoot = PLUGIN_ROOT }) {
  const say = (why, check = null) => ({ message: `setup:${name}: ${why}. Exits, protective stops and stop moves still go.`, check });
  try {
    const side = { buy: 'long', sell: 'short' }[String(input.side || '').toLowerCase()];
    if (!side) return say(`the order's side ${JSON.stringify(input.side)} is not buy or sell`);
    const cycleBar = isObj(cycleBars) ? cycleBars[familyRoot(root)] || null : null;
    if (!cycleBar) return say(`no cycle bar for ${familyRoot(root)} (FTH_CYCLE_BARS): a composed entry is judged only in the runner's cycle, on its bar`);
    const got = briefingFor(home, root, { cycleBar, now });
    if (!got.briefing) return say(`the cycle bar's briefing can't be read (${got.why}), so the record's reads can't be checked`);
    const b = got.briefing;
    const atBar = recordsAt(home, root, cycleBar);
    if (!atBar.length) return say(`no compose record for the ${familyRoot(root)} bar opened ${cycleBar}: call compose_check with your reads on this bar first`);
    const mine = atBar.filter(r => r.side === side);
    if (!mine.length) return say(`the compose record for this bar is for a ${atBar[atBar.length - 1].side}, not this ${side}`);
    const rec = mine[mine.length - 1];
    if (familyRoot(String(rec.root || '')) !== familyRoot(root)) return say(`the compose record is for ${rec.root}, not ${familyRoot(root)}`);
    // The stated size is a number of the record's own contract (its symbol): never another leg of the family.
    const recSymbol = String(rec.symbol || rec.contract || '').toUpperCase();
    if (recSymbol !== String(contractRoot(input.contractId) || '').toUpperCase()) return say(`the compose record is for ${recSymbol || 'no named contract'}, not ${contractRoot(input.contractId)}: its size is a number of its own contract; compose on the contract you trade`);
    const expiries = [rec.expiresAt, b.sections.m3 && b.sections.m3.validUntil].map(x => Date.parse(x)).filter(Number.isFinite);
    if (!expiries.length) return say('the compose record has no expiry');
    const expiry = Math.min(...expiries);
    if (!(now.getTime() < expiry)) return say(`the compose record expired at ${new Date(expiry).toISOString()} (the next bar's close): compose again on the new bar`);
    if (recordUsed(entries, { since: cycleBar, side }, root)) return say(`a ${side} entry on ${familyRoot(root)} was already placed since this bar opened (${cycleBar}): one entry per bar and side`);
    const spec = specOf(contractRoot(input.contractId));
    const tick = spec && spec.tickSize > 0 ? spec.tickSize : null;
    if (!tick || !(spec.tickValue > 0)) return say('no tick specs for the contract, so the plan can\'t be checked');
    // The checker again, on the reads as stated, against this bar's briefing: never the record's `ok` or checks.
    const check = checkReads({ reads: readsOf(rec), side, briefing: b, skills: skillFolders(pluginRoot), tick });
    const wrong = check.reads.filter(r => r.check === false);
    const unchecked = check.reads.filter(r => r.check === 'unchecked');
    const against = check.reads.filter(r => r.check === true && !r.agrees);
    const bad = [
      wrong.length ? `false by the briefing: ${wrong.map(r => `${quote(r)} (${r.fact})`).join('; ')}` : null,
      unchecked.length ? `unverifiable: ${unchecked.map(r => `${quote(r)} (${r.fact})`).join('; ')}` : null,
      against.length ? `against the ${side}: ${against.map(quote).join('; ')}` : null,
      ...check.problems.filter(p => !wrong.concat(unchecked).some(r => p.includes(`"${r.read}"`))),
    ].filter(Boolean);
    if (bad.length || !check.ok) return say(`the record's reads do not stand on this bar: ${bad.join('; ') || 'the checker refused the combination'}`, check);
    const held = isObj(rec.plan) ? rec.plan : null;
    const stated = held && Number.isInteger(held.size) && held.size >= 1 ? held.size : null;
    if (stated === null) return say('the compose record states no size (a whole number of contracts, 1 or more)', check);
    const risk = strategy && strategy.risk ? strategy.risk : {};
    const planned = planOf({ checked: check, briefing: b, side, size: stated, tick, tickValue: spec.tickValue, minRR: risk.min_rr ?? null, maxRiskUsd: risk.max_risk_usd ?? null });
    if (!planned.plan || planned.problems.length) return say(`the plan doesn't stand: ${planned.problems.join('; ') || 'it can\'t be worked out'}`, check);
    const p = planned.plan;
    const same = held && isObj(held.entry) && isObj(held.stop) && isObj(held.target) && held.entry.price === p.entry.price && held.stop.ticks === p.stop.ticks && held.target.ticks === p.target.ticks;
    if (!same) {
      const show = x => (x && isObj(x.stop) && isObj(x.target) && isObj(x.entry) ? `${x.stop.ticks}-tick stop, ${x.target.ticks}-tick target from ${x.entry.price}` : 'none');
      return say(`the compose record's plan (${show(held)}) is not the plan its reads give now (${show(p)})`, check);
    }
    const limit = limitRefusal({ side, type: input.type, limitPrice: input.limitPrice, reference: p.entry.price, tick });
    if (limit) return say(limit, check);
    const sl = isObj(input.stopLossBracket) ? input.stopLossBracket.ticks : undefined;
    const tp = isObj(input.takeProfitBracket) ? input.takeProfitBracket.ticks : undefined;
    if (sl !== p.stop.ticks) return say(`stopLossBracket.ticks ${JSON.stringify(sl)} is not the record's ${p.stop.ticks} (stop ${p.stop.price}, one tick beyond ${p.stop.level})`, check);
    if (tp !== p.target.ticks) return say(`takeProfitBracket.ticks ${JSON.stringify(tp)} is not the record's ${p.target.ticks} (target ${p.target.price})`, check);
    if (Number(input.size) !== stated) return say(`size ${JSON.stringify(input.size)} is not the size the record states (${stated}); the ceilings over it are the risk cap, the broker's max and, in an attempt, the verdict`, check);
    // The room a phase-2 room fact is checked against (fact-claims.js): the plan's first level in the way, in its R,
    // against the R its target needs.
    const room = { stopPoints: p.stop.ticks * tick, needR: p.rr, inTheWay: p.inTheWay ? { name: p.inTheWay.name, R: p.inTheWay.R } : null };
    return { message: null, check, record: rec, plan: p, room };
  } catch (err) {
    return say(`the check failed (${err.message}): no entry (fails closed)`);
  }
}

module.exports = { isComposed, recordsAt, readsOf, skillFolders, composedName, limitRefusal, composedRefusal, recordUsed };
