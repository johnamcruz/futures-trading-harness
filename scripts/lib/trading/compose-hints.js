'use strict';

/**
 * compose_check's refusal hints: when a combination is refused, what would be right on this bar, from facts code
 * already computes (composed-reads.js checkRead on the bar briefing). Pure: no files, no clock. The hints never change
 * a verdict (the check refuses exactly what it refused before); they only list reads code verified TRUE on this bar,
 * per flow step (bias, location, setup, entry, stop, target), and, when one exists, a whole combination that passes
 * the same check and plan (checkReads, then trade-lifecycle.js planOf) on this bar. No read is invented: every listed
 * read is one of the closed forms, checked against the briefing before it is shown.
 *
 *   candidatesOf(briefing, side, { tick, stopRule })   { bias, location, setup, entry, stop, target }: each [{ read, close?, tf? }],
 *                                            the reads TRUE on the bar and agreeing with the side (setup and entry:
 *                                            pointing the side; close: when its candle closed, ms)
 *   repairOf({ reads, side, briefing, tick, plan })   { reads, checked, planned } | null: the model's TRUE agreeing reads
 *                                            kept, each failing step filled from the candidates, the first combination
 *                                            the check and the plan both pass (plan: planOf's arguments but checked)
 *   hintsFor({ checked, planned, briefing, side, tick, plan, standard })   [line]: the hints for a refused record
 *                                            (none for an OK one); standard: the briefing's standard plan for the side
 *                                            (setup-library.js standardPlans), when it passes
 *
 * Limits (config/analysis.json composeHints): perStep reads listed a step, maxTries combinations tried.
 */

const { STEPS, ENTRY_PATTERNS, SETUP_CANDLE, TF_ORDER, TF_MIN, targetsAhead, levelIndex, candleClose, setupClose, levelName, parseRead, checkRead, checkReads } = require('./composed-reads');
const { planOf } = require('./trade-lifecycle');
const { trendRuleOf } = require('./reasons');
const { MARKET_TZ } = require('./clock');

const LIMITS = require('../tunables').analysis().composeHints; // config/analysis.json
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const m3Of = b => (isObj(b) && isObj(b.sections) && isObj(b.sections.m3) && isObj(b.sections.m3.data) ? b.sections.m3.data : null);
const ET = new Intl.DateTimeFormat('en-US', { timeZone: MARKET_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const et = ms => (Number.isFinite(ms) ? `${ET.format(new Date(ms))} ET` : 'unknown');
const way = side => (side === 'long' ? 'up' : 'down');
// The default skill a listed read is stated with when the model's step has none (the model keeps its own otherwise).
const SKILL = { bias: 'mtf-bias-filter', location: 'levels-and-reactions', setup: 'rejection', entry: 'candle-reading', stop: 'invalidation', target: 'take-profit' };

/** The briefing's base timeframe as reads name it ('3m', '1h'), or null. */
const baseOf = b => (isObj(b) ? Object.keys(TF_MIN).find(tf => TF_MIN[tf] === b.minutes) || null : null);

/** The candle timeframes the briefing holds (completed, available), in timeframe order. */
function framesOf(m3) {
  const c = isObj(m3.candles) ? m3.candles : {};
  return TF_ORDER.filter(tf => isObj(c[tf]) && !c[tf].unavailable);
}

/** Each read form checked on the bar: the TRUE ones agreeing with the side (pointing it, when `pointing`). */
function verified(forms, b, side, tick, pointing) {
  const out = [];
  const seen = new Set();
  for (const f of forms) {
    const read = typeof f === 'string' ? f : f.read;
    if (seen.has(read)) continue;
    seen.add(read);
    const p = parseRead(read);
    if (p.kind === 'unknown' || p.kind === 'ambiguous') continue;
    const c = checkRead(p, b, { tick });
    if (c.check !== true) continue;
    if (pointing ? c.dir !== side : c.dir && c.dir !== side) continue;
    out.push({ ...(typeof f === 'string' ? {} : f), read, kind: p.kind, form: p.form, price: c.price, dir: c.dir || null });
  }
  return out;
}

/** The reads TRUE on the bar for the side, per step (see the header). */
function candidatesOf(b, side, { tick, stopRule = null } = {}) {
  const m3 = m3Of(b);
  const empty = Object.fromEntries(STEPS.map(s => [s, []]));
  if (!m3 || !['long', 'short'].includes(side) || !(tick > 0)) return empty;
  const d = way(side);
  const frames = framesOf(m3);
  const candles = m3.candles;
  const bias = [...['15m', '1h', '4h'].map(tf => `${tf} ${d}`), ...['15m', '1h', ...frames.slice(0, 1)].flatMap(tf => [`${tf} choch ${d}`, `${tf} bos ${d}`]),
    `trend ${side} allowed`, `regime trend ${d}`, side === 'long' ? 'above prior rth range' : 'below prior rth range', `regime ${levelName(isObj(m3.regime) ? m3.regime.primary : '')}`];
  const loc = [...levelIndex(b).keys()].map(k => `at ${k}`);
  // The compression boxes' key levels (compression.js), each as a location read on its box.
  const comp = isObj(m3.compression) ? Object.entries(m3.compression).filter(([, x]) => isObj(x) && isObj(x.box)) : [];
  const boxAt = comp.flatMap(([tf, x]) => (Array.isArray(x.box.levels) ? x.box.levels : []).map(l => `${tf} box at ${levelName(l.name)}`));
  const location = [...frames.map(tf => `at ${tf} fvg`), ...loc, ...boxAt, ...(isObj(m3.vwap) && m3.vwap.side ? [`vwap ${m3.vwap.side}`] : []),
    ...(isObj(m3.location) && m3.location.priorValue ? [`value ${m3.location.priorValue}`] : [])];
  // Setups on the candles above the base, each with its candle's close: a base candle's reaction is this bar's own
  // candle, which no later close in a briefing can confirm (on the next bar its reads are of the next candle).
  const setups = [];
  for (const tf of frames.filter(x => x !== baseOf(b))) {
    const c = candles[tf];
    for (const key of ['relations', 'fvgRelations']) {
      for (const r of Array.isArray(c[key]) ? c[key] : []) {
        if (isObj(r) && ['rejected', 'broke'].includes(r.rel) && r.dir === d) setups.push({ read: `${tf} ${r.rel} ${levelName(r.name)} ${d}`, tf, close: candleClose(m3, tf) });
      }
    }
    for (const pat of Array.isArray(c.patterns) ? c.patterns : []) setups.push({ read: `${tf} pattern ${levelName(pat)}`, tf, close: candleClose(m3, tf) });
    if (isObj(m3.cisd) && isObj(m3.cisd[tf])) setups.push({ read: `${tf} cisd ${d}`, tf, close: setupClose(m3, { kind: 'cisd', form: `${tf} cisd ${d}` }) });
  }
  // The compression breaks (compression.js), timed from their expansion candle: on the base too when that candle closed
  // before the base's last one (a later base close can confirm it; the base's own last candle can't).
  const baseClose = candleClose(m3, baseOf(b));
  for (const [tf] of comp) {
    const close = setupClose(m3, { kind: 'compression', form: `${tf} compression break ${d}` });
    if (tf !== baseOf(b) || (close !== null && baseClose !== null && close < baseClose)) setups.push({ read: `${tf} compression break ${d}`, tf, close });
  }
  const pats = Object.keys(ENTRY_PATTERNS).filter(p => ENTRY_PATTERNS[p] === side);
  const entries = frames.flatMap(tf => [...pats.map(p => `${tf} pattern ${p}`), `${tf} momentum ${d}`, `${tf} close ${side === 'long' ? 'top' : 'bottom'}`]
    .map(read => ({ read, tf, close: candleClose(m3, tf) })));
  const lowHigh = side === 'long' ? 'low' : 'high';
  const stops = [...[...frames].reverse().map(tf => ({ read: `stop ${tf} ${lowHigh} ${candles[tf][side === 'long' ? 'l' : 'h']}`, tf })),
    ...(isObj(m3.swings) && num(m3.swings[lowHigh]) !== null ? [{ read: `stop swing ${lowHigh} ${m3.swings[lowHigh]}` }] : []),
    // A live box's far side (compression.js): the compression setup's natural stop.
    ...comp.filter(([, x]) => num(x.box[lowHigh]) !== null).map(([tf, x]) => ({ read: `stop ${tf} box ${lowHigh} ${x.box[lowHigh]}`, tf }))];
  return {
    bias: verified(bias, b, side, tick, false),
    location: verified(location, b, side, tick, false),
    // The most recent reaction first (the one ending the pullback), the higher candle first at the same close.
    setup: verified(setups, b, side, tick, true).filter(x => x.kind !== 'ote')
      .sort((x, y) => (y.close ?? -Infinity) - (x.close ?? -Infinity) || TF_ORDER.indexOf(y.tf) - TF_ORDER.indexOf(x.tf)),
    entry: verified(entries, b, side, tick, true),
    stop: nearestStops(verified(stops, b, side, tick, true), b, side, tick, stopRule),
    target: targetsOf(b, side, tick),
  };
}

/**
 * The stops a plan can take, nearest first: with the strategy's stop rule, only those the plan doesn't refuse as under
 * D13's floor (trade-lifecycle.js planOf, its own arithmetic: a closer one is refused, never widened).
 */
function nearestStops(list, b, side, tick, rule) {
  const ref = num(m3Of(b).price);
  if (ref === null) return list;
  const floored = x => isObj(rule) && planOf({ checked: { reference: ref, stop: { source: 'x', level: x.price }, target: { source: 'x', level: ref } }, briefing: b, side, size: 1, tick, tickValue: tick, stopRule: rule })
    .problems.some(p => /^the stop is \d+ ticks, under the minimum|^ATR\(20\) is unknown/.test(p));
  return list.filter(x => num(x.price) !== null && !floored(x)).sort((x, y) => Math.abs(ref - x.price) - Math.abs(ref - y.price));
}

/**
 * The targets a plan can take the side's way: the named ones (composed-reads.js targetsAhead), else the 2R mark
 * (`target 2r`, TRUE then: checkRead with the side).
 */
function targetsOf(b, side, tick, riskPts = null) {
  const named = targetsAhead(b, side, { tick, riskPts });
  if (named.length) return named;
  const c = checkRead(parseRead('target 2r'), b, { tick, side, riskPts });
  return c.check === true ? [{ read: 'target 2r', price: null, mark: true }] : [];
}

/** What fails in each step of a checked combination: { step: [reason] } (missing, a read not TRUE or against, none pointing, timing). */
function failingSteps(checked, planned) {
  const out = {};
  const add = (s, why) => { (out[s] = out[s] || []).push(why); };
  for (const s of checked.missingSteps || []) add(s, 'missing');
  for (const r of checked.reads || []) if (STEPS.includes(r.step) && !(r.check === true && r.agrees)) add(r.step, r.check === true ? 'against' : 'false');
  for (const p of checked.problems || []) {
    const m = /^the (setup|entry) has no read pointing/.exec(p);
    if (m) add(m[1], 'pointing');
    if (/^no entry read pointing .* closed after the setup/.test(p)) add('entry', 'timing');
    if (/^\d+ (stop|target) reads/.test(p)) add(p.split(' ')[1], 'twice');
  }
  for (const p of (planned && planned.problems) || []) {
    if (/^R:R .* under the strategy's min/.test(p)) add('target', 'rr');
    if (/^the stop is \d+ ticks, under the minimum|^the stop .* not on the losing side/.test(p)) add('stop', 'floor');
    if (/^the target .* not on the winning side/.test(p)) add('target', 'side');
  }
  return out;
}

// The model's TRUE agreeing reads in a step (kept as they are).
const goodOf = (checked, step) => (checked.reads || []).filter(r => r.step === step && r.check === true && r.agrees);

/** The plan's R:R for a stop and a target read on the bar (planOf's arithmetic), or null. */
function rrOf(stop, target, checked, b, side, tick, plan) {
  const r = planOf({ checked: { reference: checked.reference, stop: { source: 'x', level: stop.price }, target: target.mark ? { source: '2r', level: null, mark: true } : { source: 'x', level: target.price } }, briefing: b, side, size: 1, tick, tickValue: plan.tickValue, minRR: plan.minRR, maxRiskUsd: plan.maxRiskUsd, stopRule: plan.stopRule, suggestion: true });
  return r.plan ? { rr: r.plan.rr, price: r.plan.target.price, ok: !r.problems.some(p => !/^size/.test(p)), stopTicks: r.plan.stop.ticks, problems: r.problems } : null;
}

/**
 * The first combination that passes the check and the plan: the model's TRUE agreeing reads kept in each step that
 * has one and no other failing reason; a step that fails filled from the candidates (setup and entry each pointing
 * the side, the entry on a candle closed after the setup's). null when none passes within maxTries.
 */
function repairOf({ reads, side, briefing, tick, plan, candidates = null }) {
  const m3 = m3Of(briefing);
  if (!m3 || !isObj(plan) || !(tick > 0)) return null;
  const checked = checkReads({ reads, side, briefing, tick });
  if (checked.ok && planOkFor(checked, briefing, side, tick, plan)) return null;
  const planned = checked.stop && checked.target ? planOf(planArgs(checked, briefing, side, tick, plan)) : null;
  const fail = failingSteps(checked, planned);
  const cand = candidates || candidatesOf(briefing, side, { tick, stopRule: plan.stopRule });
  const skillOf = step => { const r = (reads || []).find(x => isObj(x) && x.step === step && typeof x.skill === 'string'); return r ? r.skill : SKILL[step]; };
  const asRead = (step, x) => ({ step, skill: x.skill || skillOf(step), read: x.read, why: x.why || null });
  const pool = step => {
    const good = goodOf(checked, step).map(r => ({ read: r.read, skill: r.skill, why: r.why, price: r.price }));
    const listed = cand[step].map(x => [{ ...x, skill: skillOf(step) }]);
    // A step with no failing reason keeps the model's reads first (bias and location only those: one each is used);
    // a failing one keeps its TRUE agreeing reads only where a false one beside them is what failed (bias, location).
    if (!fail[step] && good.length) return ['bias', 'location'].includes(step) ? [good] : [good, ...listed];
    const keep = ['bias', 'location'].includes(step) && good.length && fail[step].every(w => w === 'false' || w === 'against') ? [good] : [];
    return [...keep, ...listed];
  };
  const [bias, location, setups, entries, stops, targets] = STEPS.map(pool);
  // The 2R mark last: the check decides it with each combination's own stop (the room rule's R).
  if (!targets.some(t => t[0] && t[0].mark)) targets.push([{ read: 'target 2r', price: null, mark: true, skill: skillOf('target') }]);
  const closesAfter = (e, after) => e.some(x => { const t = candleClose(m3, parseRead(x.read).form.split(' ')[0]); return t !== null && t > after; });
  let tries = 0;
  // The first bias and location (the model's own when TRUE), the most recent setups, then every stop and the nearest
  // target at the strategy's R:R from it (a target short of it is skipped before the whole check).
  for (const s of setups) {
    const after = Math.max(...s.map(x => { const p = parseRead(x.read); return setupClose(m3, { kind: p.kind, form: p.form }); }).filter(t => t !== null), -Infinity);
    for (const e of entries.filter(x => closesAfter(x, after))) {
      for (const st of stops) {
        const stopAt = st[0] && num(st[0].price) !== null ? { price: st[0].price } : null;
        for (const tg of targets) {
          const r = stopAt && tg[0] && num(tg[0].price) !== null ? rrOf(stopAt, tg[0], checked, briefing, side, tick, plan) : null;
          if (stopAt && tg[0] && num(tg[0].price) !== null && !(r && r.ok)) continue;
          tries += 1;
          if (tries > LIMITS.maxTries) return null;
          const list = [['bias', bias[0] || []], ['location', location[0] || []], ['setup', s], ['entry', e], ['stop', st], ['target', tg]].flatMap(([step, xs]) => xs.map(x => asRead(step, x)));
          const ch = checkReads({ reads: list, side, briefing, tick });
          if (!ch.ok || !planOkFor(ch, briefing, side, tick, plan)) continue;
          return { reads: list, checked: ch, planned: planOf(planArgs(ch, briefing, side, tick, plan)) };
        }
      }
    }
  }
  return null;
}

const planArgs = (checked, briefing, side, tick, plan) => ({ checked, briefing, side, size: plan.size, tick, tickValue: plan.tickValue, minRR: plan.minRR, maxRiskUsd: plan.maxRiskUsd, stopRule: plan.stopRule, suggestion: plan.suggestion });
// The plan stands but for the size (the model's own number: a size problem is stated by the plan, never fixed here).
function planOkFor(checked, briefing, side, tick, plan) {
  if (!checked.stop || !checked.target) return false;
  const p = planOf(planArgs(checked, briefing, side, tick, plan));
  // A stop one contract of which already risks more than the cap fits no size: no plan to offer.
  return Boolean(p.plan) && p.problems.every(x => /^size/.test(x)) && !(p.plan.maxSize === 0);
}

const quote = list => list.map(x => `"${x.read}"`).join(', ');

/** The hints for a refused record (see the header): one line a failing step, then a whole combination when one passes. */
function hintsFor({ checked, planned = null, briefing, side, tick, plan = null, standard = null }) {
  const m3 = m3Of(briefing);
  if (!m3 || !checked || !['long', 'short'].includes(side) || !(tick > 0)) return [];
  if (checked.ok && planned && planned.plan && !planned.problems.length) return [];
  const fail = failingSteps(checked, planned);
  const cand = candidatesOf(briefing, side, { tick, stopRule: isObj(plan) ? plan.stopRule : null });
  const n = LIMITS.perStep;
  const out = [];
  const rule = trendRuleOf(m3.trendRule)[side];
  for (const step of STEPS.filter(s => fail[s])) {
    // Only the reads pointing the side: a direction-less one (a range regime) is no bias for it.
    const sided = cand.bias.filter(x => x.dir === side);
    if (step === 'bias') out.push(sided.length ? `bias: true for the ${side} here: ${quote(sided.slice(0, n))}` : `bias: no bias read for the ${side} is true on this bar`);
    if (step === 'location') out.push(cand.location.length ? `location: true here: ${quote(cand.location.slice(0, n))}` : 'location: no location read is true on this bar');
    if (step === 'setup') {
      const s = cand.setup.slice(0, n).map(x => `"${x.read}" (closed ${et(x.close)})`).join(', ');
      out.push(s ? `setup: the reaction your way (${way(side)}), true here: ${s}` : `setup: no candle reacted ${way(side)} on this bar: no setup for the ${side}`);
    }
    if (step === 'entry') out.push(entryHint(checked, cand, briefing, side));
    if (step === 'stop') {
      const s = cand.stop.slice(0, n).map(x => `"${x.read}"`).join(', ');
      out.push(s ? `stop: true on the losing side here: ${s} (the stop goes beyond it; a closer one than the minimum is refused)` : 'stop: no stop source on the losing side is true at the minimum distance or more on this bar');
    }
    if (step === 'target') out.push(targetHint(checked, cand, briefing, side, tick, plan));
  }
  if (standard && standard.status === 'traded' && Array.isArray(standard.reads) && standard.reads.length) {
    out.push(`the standard plan passes: compose_check with its reads: ${quote(standard.reads)} (R:R ${standard.plan ? standard.plan.rr : '?'})`);
  } else if (plan && rule !== false && m3.windowEntries === 'allowed') {
    const fixed = repairOf({ reads: checked.reads.map(r => ({ step: r.step, skill: r.skill, read: r.read, why: r.why })), side, briefing, tick, plan, candidates: cand });
    if (fixed) out.push(`these reads pass together (code-checked on this bar): ${quote(fixed.reads)} (R:R ${fixed.planned.plan.rr})`);
  }
  if (rule === false) out.push(`the trend rule allows the ${side} only as a reversal (a verified CHoCH tier among the bias reads)`);
  return out;
}

/** The entry step's hint: a confirmation the side's way on a candle closed after the setup's, or wait a bar. */
function entryHint(checked, cand, b, side) {
  const n = LIMITS.perStep;
  const m3 = m3Of(b);
  const pointing = (checked.reads || []).filter(r => r.step === 'setup' && r.check === true && r.dir === side && SETUP_CANDLE.has(r.kind));
  const setupAt = pointing.length ? Math.max(...pointing.map(r => setupClose(m3, r)).filter(t => t !== null), -Infinity) : null;
  const first = cand.setup[0];
  const after = setupAt !== null && setupAt > -Infinity ? setupAt : first ? first.close : null;
  const later = cand.entry.filter(x => after === null || (x.close !== null && x.close > after));
  const directionless = (checked.reads || []).some(r => r.step === 'entry' && ['volume', 'participation'].includes(r.kind));
  const lead = directionless ? 'volume and participation point no side, so they never confirm alone; ' : '';
  const since = after !== null ? ` on a candle closed after the setup's (${et(after)})` : '';
  // No setup read yet: a confirmation counts only on a candle closed after the setup's, so name the order.
  if (after === null) return `entry: ${lead}no setup read for the ${side} is true yet; a confirmation counts only on a candle closed after the setup's: the setup first`;
  if (later.length) return `entry: ${lead}the confirmation your way${since}, true here: ${quote(later.slice(0, n))}`;
  const base = baseOf(b);
  // A setup read on the base candle is this bar's own candle: no later candle is in the briefing, and on the next bar
  // its reads are of the next candle. Its confirmation needs the reaction read on a higher candle.
  const onBase = pointing.length && pointing.every(r => String(r.form || '').split(' ')[0] === base);
  const higher = cand.setup.filter(x => x.tf !== base && cand.entry.some(e => e.close !== null && x.close !== null && e.close > x.close));
  if (onBase) return `entry: ${lead}a ${base} setup is this bar's own candle, so no later candle can confirm it${higher.length ? `; a reaction on a higher candle that a later close confirms, true here: ${quote(higher.slice(0, n))}` : ': read the reaction on a higher candle, or pass'}`;
  return `entry: ${lead}no candle closed after the setup's${after !== null ? ` (${et(after)})` : ''} confirms the ${side} yet: wait for the next ${base || 'base'} close, or pass`;
}

/** The target step's hint: the named levels on the winning side with their R:R from the stop, those at the minimum first. */
function targetHint(checked, cand, b, side, tick, plan) {
  const n = LIMITS.perStep;
  const stopRead = (checked.reads || []).find(r => r.kind === 'stop' && r.check === true && r.agrees);
  const stop = stopRead ? { price: stopRead.price } : cand.stop[0] ? { price: cand.stop[0].price } : null;
  // With a stop, the room rule's R is its distance: the levels within the room band of the entry (composed-reads.js
  // targetsAhead: roomIgnoreR of it, at most roomIgnoreTicks) are none of the candidates.
  const ref = num(checked.reference);
  const targets = stop && ref !== null ? targetsOf(b, side, tick, Math.abs(ref - stop.price)) : cand.target;
  if (!targets.length) return `target: the briefing names no level on the winning side: no target for the ${side}`;
  if (!stop || !isObj(plan)) return `target: named levels on the winning side: ${quote(targets.slice(0, n))}`;
  const rated = targets.map(x => ({ ...x, r: rrOf(stop, x, checked, b, side, tick, plan) })).filter(x => x.r);
  const min = plan.minRR;
  const enough = rated.filter(x => x.r.ok);
  const from = `from the stop at ${stop.price}`;
  if (enough.length && enough[0].mark) return `target: no named level the trade's way: "target 2r", the ${min}R mark ${enough[0].r.price} ${from}; past it the runner trails`;
  if (enough.length) return `target: named levels at ${min}R or more ${from}: ${enough.slice(0, n).map(x => `"${x.read}" (${x.r.rr}R)`).join(', ')}`;
  return `target: no named level reaches ${min}R ${from} (nearest: ${rated.slice(0, n).map(x => `"${x.read}" ${x.r.rr}R`).join(', ') || 'none'}): pass, or a setup with a nearer stop`;
}

/** The hints as text lines for the model. */
const renderHints = lines => lines.map(l => `- HINT ${l}`).join('\n');

module.exports = { candidatesOf, repairOf, hintsFor, renderHints, failingSteps, targetsOf };
