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
 *   - be before the record's expiry (the strategy's valid_bars base bars after the bar's close, worked out again from
 *     the bar's briefing; 1 when the strategy can't be read; never past the record's own) and the first entry on the
 *     family and side since the cycle bar opened (one entry per bar and side, whichever record it came from). The
 *     cycle's bar and its briefing don't move while the cycle runs (the runner awaits it), so an entry after the next
 *     close is judged on the facts of the record's own bar; a later cycle has a later bar and composes on it;
 *   - pass the reads checker (composed-reads.js) run again on the record's reads against that briefing (the record's
 *     own `ok` and checks are never read): every read true, agreeing with the side, every step stated, and, under a
 *     policy, its entry rule (`entryRule`: entry-rule.js, the rulebook's `entry`; null: none);
 *   - match the plan worked out again from the re-checked reads (trade-lifecycle.js planOf: the D3 buffer, the D13
 *     minimum stop, risk.min_rr, the stated size within risk.max_risk_usd), equal to the record's plan:
 *     stopLossBracket.ticks and takeProfitBracket.ticks are its ticks;
 *   - be a limit at the record's entry price or better for its side; a cited setup's record (its plan at market:
 *     `cited`, the setups the composed trade may cite, strategies.js citedSetups; none: a fired read can't be cited) a
 *     market order;
 *   - be the record's stated size, or, where phase 2's approved size is known and smaller (`approvedSize`), exactly that
 *     size (its cut). The ceilings over it are the gate's own checks (max-risk, max-order-size, and in a prop attempt
 *     the policy verdict's size): at or below, never above. In a prop attempt (`translate`: prop/size-translate.js,
 *     built from the policy's verdict on the record) the record's size is a suggestion: the order is exactly the
 *     translated size, the rulebook's correct one, or phase 2's smaller cut; a translation that skips refuses.
 * Anything missing, unreadable or throwing refuses (fails closed).
 *
 *   isComposed(strategy)            a strategy (or a name) of signal composed, or trade_lifecycle
 *   recordsAt(home, root, bar)      the root's trade_lifecycle records for the bar opened at `bar` (same instant), read
 *                                   from that bar's day shard alone (trade-lifecycle.js: a record is filed under its
 *                                   bar's trading day); a shard that can't be read throws (the entry refused)
 *   readsOf(record)                 the reads as the model stated them: [{ step, skill, read, why }]
 *   composedName({ setupName, named, strategies, home, root })   the composed strategy the order enters by, or null
 *   limitRefusal({ side, type, limitPrice, reference, tick })    why the entry isn't a limit at the reference or better
 *   marketRefusal({ type, reference, setup })   why a cited setup's entry (its plan: at market) isn't a market order
 *   composedRefusal({ name, strategy, home, root, input, now, cycleBars, entries, specOf, pluginRoot, approvedSize, entryRule })
 *                                   { message: why it is refused | null, check, record, plan, room, expiresAt, briefing }
 *                                   (`briefing`: the cycle bar's, the one the reads were checked on)
 *                                   (`expired: true` when the record's time ran out: the cycle-timing count)
 *   reversalAllowed({ home, root, side, check, now, maxAgeMin })   D2 (the owner's "CHoCH at or above the trend"): whether a composed
 *                                   entry against the prevailing trend (mtf-state's record) stands on the re-checked
 *                                   reads: against 15m, a true agreeing 15m or 1h CHoCH; against 1h, a 1h CHoCH;
 *                                   against 4h, a 1h CHoCH and a 4h candle that rejected a level the trade's way.
 *                                   { ok, against: <frame> | null, why }; nothing against it: ok false (no reversal).
 *                                   The record is held to checkTrend's freshness (its close present, at most maxAgeMin
 *                                   old, not after now) and every frame read: else ok false (the trend rule refuses)
 *   recordUsed(entries, { since, side }, root)   a successful non-exit entry on the root's family, that side (an entry
 *                                   whose side can't be read counts), placed at or after `since`
 */

const fs = require('fs');
const path = require('path');
const { familyOf, familyRoot } = require('./contracts');
const { contractRoot, entryTime, mayBeRoot } = require('./journal');
const { latestVerdict } = require('./prop-state');
const { briefingFor } = require('./fact-claims');
const { readRecord: readMtf, DEFAULT_MAX_AGE_MIN } = require('./mtf-state');
const { RULE_FRAMES, trendRule } = require('./mtf');
const { checkReads, D2_TIERS, d2TierMet } = require('./composed-reads');
const { STRATEGY, readRecords, planOf, stopRuleOf, dayOf, expiryOf } = require('./trade-lifecycle');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const SIGNAL = 'composed';
const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;
const EPS = 1e-9;
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const fmt = (x, tick) => Number(x).toFixed((String(tick).split('.')[1] || '').length);

const isComposed = s => (typeof s === 'string' ? s === STRATEGY : Boolean(s) && (s.signal === SIGNAL || s.name === STRATEGY));
const sameInstant = (a, b) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
const recordsAt = (home, root, bar) => (dayOf(bar) === null ? []
  : readRecords(home, root, { days: [dayOf(bar)] }).filter(r => r.strategy === STRATEGY && sameInstant(r.bar, bar)));
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

/** Why a cited setup's entry (its plan: at market) isn't a market order, or null. */
function marketRefusal({ type, reference, setup } = {}) {
  if (String(type || '').toLowerCase() === 'market') return null;
  return `the entry is ${type ? `a ${String(type).toLowerCase()}` : 'not a market'} order: ${setup || 'the cited setup'}'s entry is at market from the record's ${reference} (its stop and target are brackets in ticks from the fill)`;
}

const quote = r => `"${r.read}"`;

function reversalAllowed({ home, root, side, check, now = new Date(), maxAgeMin = DEFAULT_MAX_AGE_MIN }) {
  const no = (why, against = null) => ({ ok: false, against, why });
  try {
    if (!check || !check.ok || !Array.isArray(check.reads)) return no('no standing record');
    const rec = readMtf(home, root);
    if (!rec || rec.error || !rec.biases || !rec.closedAt) return no('no multi-timeframe read');
    // checkTrend's freshness: a reversal never stands on a stale or future-dated read.
    const age = (now.getTime() - Date.parse(rec.closedAt)) / 60000;
    if (!Number.isFinite(age) || age < -1 || !(age <= maxAgeMin)) return no('the multi-timeframe read is stale or dated after now');
    const biases = Object.fromEntries(RULE_FRAMES.map(m => [m, rec.biases[m] === null || rec.biases[m] === undefined ? NaN : Number(rec.biases[m])]));
    // Every frame read: a tier can't be chosen on a trend that isn't known on all three.
    if (!RULE_FRAMES.every(m => Number.isFinite(biases[m]))) return no('the multi-timeframe read is not ready on every frame');
    const r = trendRule(biases, side, 'trend');
    if (r.allowed || !r.prevailing) return no('not against the trend');
    const tier = D2_TIERS[r.prevailing.minutes];
    if (!tier) return no(`no D2 tier for ${r.prevailing.label}`, r.prevailing.label);
    // The tier, read by the same definition the reads' agreement uses (composed-reads.js D2_TIERS, d2TierMet).
    if (d2TierMet(tier, check.reads, side)) return { ok: true, against: r.prevailing.label, why: null };
    return no(`against the ${r.prevailing.label} trend a verified ${tier.choch.join(' or ')} CHoCH${tier.rejection4h ? ' and a 4h candle that rejected a level' : ''} the trade's way is needed`, r.prevailing.label);
  } catch (err) {
    return no(`the check failed (${err.message})`);
  }
}

/** The room a phase-2 room fact is checked against (fact-claims.js): the plan's first level in the way, in its R, against the R its target needs. */
const roomOf = (p, tick) => ({ stopPoints: p.stop.ticks * tick, needR: p.rr, inTheWay: p.inTheWay ? { name: p.inTheWay.name, R: p.inTheWay.R } : null });

function composedRefusal({ name, strategy = null, home, root, input = {}, now = new Date(), cycleBars = {}, entries = [], specOf = () => null, pluginRoot = PLUGIN_ROOT, approvedSize = null, translate = null, attempt = false, entryRule = null, cited = null }) {
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
    // Valid `valid_bars` base bars after its bar's close (the strategy's; 1, the next close, when it can't be read),
    // worked out again from the bar's own briefing, and never past the record's own stamp.
    const bars = strategy && Number.isInteger(strategy.valid_bars) && strategy.valid_bars >= 1 ? strategy.valid_bars : 1;
    const expiries = [rec.expiresAt, expiryOf(b, bars)].map(x => (typeof x === 'number' ? x : Date.parse(x)));
    if (!expiries.every(Number.isFinite)) return say('the compose record or its bar has no readable expiry');
    const expiry = Math.min(...expiries);
    if (!(now.getTime() < expiry)) return { ...say(`the compose record expired at ${new Date(expiry).toISOString()} (${bars} base bar${bars === 1 ? '' : 's'} after its bar's close): compose again on the new bar`), expired: true };
    if (recordUsed(entries, { since: cycleBar, side }, root)) return say(`a ${side} entry on ${familyRoot(root)} was already placed since this bar opened (${cycleBar}): one entry per bar and side`);
    const spec = specOf(contractRoot(input.contractId));
    const tick = spec && spec.tickSize > 0 ? spec.tickSize : null;
    if (!tick || !(spec.tickValue > 0)) return say('no tick specs for the contract, so the plan can\'t be checked');
    // The checker again, on the reads as stated, against this bar's briefing: never the record's `ok` or checks.
    const check = checkReads({ reads: readsOf(rec), side, briefing: b, skills: skillFolders(pluginRoot), tick, entryRule, cited });
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
    // In a prop attempt (`translate`, or `attempt`: order_plan's own first read) the record's size is a suggestion: never
    // refused over the cap here, which binds on the translated size the order is.
    const planned = planOf({ checked: check, briefing: b, side, size: stated, tick, tickValue: spec.tickValue, minRR: risk.min_rr ?? null, maxRiskUsd: risk.max_risk_usd ?? null, stopRule: stopRuleOf(risk), suggestion: Boolean(translate || attempt) });
    if (!planned.plan || planned.problems.length) return say(`the plan doesn't stand: ${planned.problems.join('; ') || 'it can\'t be worked out'}`, check);
    const p = planned.plan;
    const same = held && isObj(held.entry) && isObj(held.stop) && isObj(held.target) && held.entry.price === p.entry.price && (held.entry.type || 'limit') === p.entry.type && held.stop.ticks === p.stop.ticks && held.target.ticks === p.target.ticks;
    if (!same) {
      const show = x => (x && isObj(x.stop) && isObj(x.target) && isObj(x.entry) ? `${x.stop.ticks}-tick stop, ${x.target.ticks}-tick target from ${x.entry.price}${x.entry.type === 'market' ? ' at market' : ''}` : 'none');
      return say(`the compose record's plan (${show(held)}) is not the plan its reads give now (${show(p)})`, check);
    }
    const limit = p.entry.type === 'market' ? marketRefusal({ type: input.type, reference: p.entry.price, setup: p.setup })
      : limitRefusal({ side, type: input.type, limitPrice: input.limitPrice, reference: p.entry.price, tick });
    if (limit) return say(limit, check);
    const sl = isObj(input.stopLossBracket) ? input.stopLossBracket.ticks : undefined;
    const tp = isObj(input.takeProfitBracket) ? input.takeProfitBracket.ticks : undefined;
    if (sl !== p.stop.ticks) return say(`stopLossBracket.ticks ${JSON.stringify(sl)} is not the record's ${p.stop.ticks} (stop ${p.stop.price}, one tick beyond ${p.stop.level})`, check);
    if (tp !== p.target.ticks) return say(`takeProfitBracket.ticks ${JSON.stringify(tp)} is not the record's ${p.target.ticks} (target ${p.target.price})`, check);
    // Phase 2's approved size, where it is known (the order gate: the approving report, roles-ran.js approvedSize), cuts
    // the record's: the order is exactly the smaller (owner-approved 2026-10-22); unknown, the record's, as before.
    // In a prop attempt (`translate`: prop/size-translate.js, from the same records as order_plan) the base is the
    // translated size, the rulebook's correct one: the record's is a suggestion. A translation that skips refuses.
    const t = typeof translate === 'function' ? translate(p, spec, stated, rec) : undefined;
    // null: no verdict sized on this record, so no translation; the caller's [policy] check refuses the entry.
    if (t === null) return { message: null, check, record: rec, plan: p, room: roomOf(p, tick), expiresAt: new Date(expiry).toISOString(), briefing: b, untranslated: true };
    if (t && t.skip) return say(`no size: ${t.reason} (the record suggested ${stated})`, check);
    const base = t ? t.size : stated;
    const cut = Number.isInteger(approvedSize) && approvedSize >= 1 && approvedSize < base;
    const want = cut ? approvedSize : base;
    if (t && Number(input.size) !== want) return say(cut ? `size ${JSON.stringify(input.size)} is not ${want}, risk-manager phase 2's cut of the translated ${base}: the order is exactly the smaller` : `size ${JSON.stringify(input.size)} is not the translated size ${base} (${t.reason}; the record suggested ${stated}): order_plan gives it`, check);
    if (Number(input.size) !== want) return say(cut ? `size ${JSON.stringify(input.size)} is not ${want}, risk-manager phase 2's cut of the record's ${stated}: the order is exactly the smaller` : `size ${JSON.stringify(input.size)} is not the size the record states (${stated}); the ceilings over it are the risk cap, the broker's max and, in an attempt, the verdict`, check);
    // The room a phase-2 room fact is checked against (fact-claims.js): the plan's first level in the way, in its R,
    // against the R its target needs.
    return { message: null, check, record: rec, plan: p, room: roomOf(p, tick), expiresAt: new Date(expiry).toISOString(), briefing: b };
  } catch (err) {
    return say(`the check failed (${err.message}): no entry (fails closed)`);
  }
}

module.exports = { D2_TIERS, reversalAllowed, isComposed, recordsAt, readsOf, skillFolders, composedName, limitRefusal, marketRefusal, composedRefusal, recordUsed };
