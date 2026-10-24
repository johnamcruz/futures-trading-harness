'use strict';

/**
 * Setup detectors (the owner, 2026-10-23: "writing code to detect manually will help speed it up"; "fix the entry using
 * rejection or breakout"): small, pure rules over one bar briefing's facts (buildBriefing: closed bars only, so none reads
 * ahead) that compose existing primitives (the named levels, the candle relations rejected and broke, the candle-reading
 * engulfing patterns, the stop and target reads, the room rule) into the with-trend plan compose_check would pass on
 * this bar. No new fact, read or skill. Not wired into the briefing: measured first, wired only when approved.
 *
 *   rejection        a 5m or 15m candle rejected a named level the trend's way (the pullback holds); entry: a later
 *                    closed candle the trend's way (a close in its trend-side third or an engulfing); stop: beyond the
 *                    rejection candle (D13's floor), else the nearest true stop
 *   breakout         a 5m or 15m candle broke a named level the trend's way; entry: a later closed 3m candle the
 *                    trend's way that closed beyond the level (it holds); stop: beyond the breakout candle, else nearest
 *   engulf-15m       a 15m engulfing the trend's way that met a named level (its relations), closed in its trend-side
 *                    third; entry: a later 3m directional close; stop: beyond the 15m candle (wide stops: the cap skips)
 *   engulf-15m-3m    the same 15m candle; entry: a later 3m directional close; stop: beyond that 3m candle (tighter)
 *   standard         today's scan: the briefing's standard plan (setup-library.js), the baseline
 * Every target: the first named level at the minimum R or more past the room rule, else `target 2r` (composed-reads.js).
 * Each fires only where the gate would let the side enter (the window open, the trend rule allowing it).
 *
 *   detect(name, briefing, side, { tick, plan })   { fires, capped, setupRead, entryRead, stop, target, rr, reads,
 *                                                  level, tf, why } (capped: a whole that one contract over the cap refuses)
 *   onset(briefing, side)                         the momentum-onset facts the trend's way, existing reads only:
 *                                                  { cisd, engulfing, volume, momentum } (booleans)
 *   RULES                                          the rules' names and descriptions
 *
 * Wired (the owner's approval, 2026-10-23, on the screen-period sample: more legs, earlier, more R left than today's
 * scan, a positive expectancy after costs, no more false fires): WIRED, in order, each with its momentum-onset filter on
 * the bar (ONSET, onsetRules): breakout with any 2 of the 4 onset facts, rejection with a momentum read the trend's way. The opening
 * range's and the initial balance's levels are none of either rule's (negative for both on the sample: a general rule).
 *   wiredPlan(briefing, side, ctx)               the first wired rule that fires with its filter: { ...detect, rule, onset }
 *   wiredContext(symbol)                          { tick, plan } for the briefing: the shipped trade_lifecycle strategy's
 *                                                  risk at one contract (a stop one contract over the cap fits none)
 *   detectedLine(briefing, { et, skip })          the briefing's line: per side not in `skip` (the sides the standard plan
 *                                                  already plans), the wired plan with its reads, as code's fact
 */

const { candidatesOf } = require('../compose-hints');
const { trendRuleOf } = require('../reasons');
const { parseRead, checkRead, checkReads, levelName } = require('../composed-reads');
const { planOf } = require('../trade-lifecycle');
const { standardPlans } = require('../../learning/setup-library');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const m3Of = b => (isObj(b) && isObj(b.sections) && isObj(b.sections.m3) ? b.sections.m3.data : null);
const way = side => (side === 'long' ? 'up' : 'down');
const ENGULF = { long: 'bullish engulfing', short: 'bearish engulfing' };
// The opening range's and the initial balance's levels: none of the rejection's or the breakout's (see the header).
const EXCLUDED_LEVEL = /^(opening range|ib) (high|low)$/;
const onsetRules = Object.freeze({
  momentum: o => o.momentum,
  'any 2 of 4': o => [o.cisd, o.engulfing, o.volume, o.momentum].filter(Boolean).length > 1,
});
const WIRED = Object.freeze([{ rule: 'breakout', onset: 'any 2 of 4' }, { rule: 'rejection', onset: 'momentum' }]);

const RULES = Object.freeze({
  standard: 'the 15m reaction at a key level (the briefing\'s scan and standard plan)',
  rejection: 'a 5m or 15m rejection of a named level the trend\'s way, then a closed candle the trend\'s way',
  breakout: 'a 5m or 15m break of a named level the trend\'s way, then a 3m close that holds beyond it',
  'engulf-15m': 'a 15m engulfing the trend\'s way at a named level, a 3m close after it, the stop beyond the 15m candle',
  'engulf-15m-3m': 'the same 15m engulfing, a 3m close after it, the stop beyond that 3m candle',
});

/** Whether the gate would let the side enter on this bar: the window open and the trend rule allowing it. */
const gateOpen = (m3, side) => m3.windowEntries === 'allowed' && trendRuleOf(m3.trendRule)[side] === true;

/** The relations a candle met named levels with, the side's way ([{ rel, name, price }]). */
function relationsOf(c, side, rels) {
  return (isObj(c) && Array.isArray(c.relations) ? c.relations : []).filter(r => isObj(r) && rels.includes(r.rel) && (r.dir || null) === way(side))
    .map(r => ({ rel: r.rel, name: levelName(r.name), price: num(r.price) }));
}

/**
 * The whole plan from a setup read, a stop rule and an entry rule: bias the first TRUE one the side's way, location the
 * level (`at <level>`) when TRUE else the first TRUE location, the entry the first allowed on a candle closed after the
 * setup's, the stop the forced read (else the nearest the plan takes), the target the first named at the minimum R or
 * more past the room rule, else the 2R mark. { reads, plan, capped } | null.
 */
function compose(b, side, { tick, plan }, { setup, level, stops, entryOk }) {
  const cand = candidatesOf(b, side, { tick, stopRule: plan.stopRule });
  const m3 = m3Of(b);
  const setupClose = (cand.setup.find(x => x.read === setup) || {}).close;
  if (!setupClose) return null;
  const at = level ? [{ read: `at ${level}` }].filter(x => checkRead(parseRead(x.read), b, { tick }).check === true) : [];
  const bias = cand.bias[0];
  const location = at[0] || cand.location[0];
  if (!bias || !location) return null;
  const entries = cand.entry.filter(x => x.close !== null && x.close > setupClose && entryOk(x, m3));
  let capped = false;
  for (const entry of entries) {
    for (const stop of stops(cand, entry)) {
      const head = [{ step: 'bias', read: bias.read }, { step: 'location', read: location.read }, { step: 'setup', read: setup }, { step: 'entry', read: entry.read }, { step: 'stop', read: stop }];
      for (const target of [...cand.target.map(x => x.read).filter(r => r !== 'target 2r'), 'target 2r']) {
        const reads = [...head, { step: 'target', read: target }].map(r => ({ ...r, skill: 'x' }));
        const ch = checkReads({ reads, side, briefing: b, tick });
        if (!ch.ok) continue;
        const p = planOf({ checked: ch, briefing: b, side, tick, ...plan });
        if (!p.plan || !p.problems.every(x => /^size/.test(x))) continue;
        if (p.plan.maxSize === 0) { capped = true; continue; }
        return { reads, plan: p.plan, capped: false };
      }
    }
  }
  return capped ? { reads: null, plan: null, capped: true } : null;
}

/** The momentum-onset facts the trend's way (existing reads, each checked TRUE on the bar). */
function onset(b, side) {
  const d = way(side);
  const t = read => checkRead(parseRead(read), b, { tick: 1, side }).check === true;
  const pats = [ENGULF[side]];
  return {
    cisd: ['3m', '5m', '15m'].some(tf => t(`${tf} cisd ${d}`)),
    engulfing: ['3m', '15m'].some(tf => pats.some(p => t(`${tf} pattern ${p}`))),
    volume: ['3m', '5m', '15m'].some(tf => t(`${tf} volume high`)),
    momentum: ['3m', '5m'].some(tf => t(`${tf} momentum ${d}`)),
  };
}

/** One detector on one bar for one side (see the header). */
function detect(name, b, side, ctx) {
  const none = why => ({ fires: false, capped: false, setupRead: null, entryRead: null, stop: null, target: null, rr: null, reads: [], level: null, tf: null, why });
  if (!RULES[name]) throw new Error(`no detector ${name}`);
  const m3 = m3Of(b);
  if (!m3 || !m3.bar || !isObj(m3.candles)) return none('no bar briefing');
  if (!gateOpen(m3, side)) return none('the window or the trend rule refuses the side');
  const fired = (r, setup, level, tf) => {
    const of = step => (r.reads.find(x => x.step === step) || {}).read || null;
    return { fires: true, capped: false, setupRead: setup, entryRead: of('entry'), stop: of('stop'), target: of('target'), rr: r.plan.rr, reads: r.reads, level, tf, why: RULES[name] };
  };
  if (name === 'standard') {
    const p = (standardPlans(b) || []).find(x => x.side === side && x.status === 'traded');
    const s = p ? p.reads.find(x => x.step === 'setup') : null;
    return p ? fired({ reads: p.reads, plan: p.plan }, s.read, (/^\S+ \S+ (.+) (up|down)$/.exec(s.read) || [])[1] || null, s.read.split(' ')[0]) : none('no standard plan OK');
  }
  const lowHigh = side === 'long' ? 'low' : 'high';
  const directional = e => /close (top|bottom)$|pattern (bullish|bearish) engulfing$/.test(e.read);
  let capped = false;
  const tries = [];
  if (name === 'rejection' || name === 'breakout') {
    const rel = name === 'rejection' ? 'rejected' : 'broke';
    for (const tf of ['15m', '5m']) {
      for (const r of relationsOf(m3.candles[tf], side, [rel]).filter(x => !EXCLUDED_LEVEL.test(x.name))) {
        const holds = (e, m) => name === 'rejection' || (r.price !== null && (side === 'long' ? m.candles['3m'].c > r.price : m.candles['3m'].c < r.price) && e.tf === '3m');
        tries.push({ setup: `${tf} ${rel} ${r.name} ${way(side)}`, level: r.name, tf, stops: c => [`stop ${tf} ${lowHigh} ${m3.candles[tf][side === 'long' ? 'l' : 'h']}`, ...c.stop.map(x => x.read)], entryOk: e => directional(e) && holds(e, m3) });
      }
    }
  } else {
    const c = m3.candles['15m'];
    const pats = isObj(c) && Array.isArray(c.patterns) ? c.patterns : [];
    const atLevel = relationsOf(c, side, ['rejected', 'broke', 'touched']).concat((isObj(c) && Array.isArray(c.relations) ? c.relations : []).filter(r => isObj(r) && r.rel === 'touched').map(r => ({ name: levelName(r.name) })));
    const third = isObj(c) && c.closeLocation === (side === 'long' ? 'top' : 'bottom');
    if (pats.includes(ENGULF[side]) && third && atLevel.length) {
      const stops = name === 'engulf-15m' ? () => [`stop 15m ${lowHigh} ${c[side === 'long' ? 'l' : 'h']}`]
        : (_c, e) => [`stop ${e.tf} ${lowHigh} ${m3.candles[e.tf][side === 'long' ? 'l' : 'h']}`];
      tries.push({ setup: `15m pattern ${ENGULF[side]}`, level: atLevel[0].name, tf: '15m', stops, entryOk: e => directional(e) && e.tf === '3m' });
    }
  }
  if (!tries.length) return none('no setup of its kind');
  for (const t of tries) {
    const r = compose(b, side, ctx, t);
    if (r && r.capped) { capped = true; continue; }
    if (r) return fired(r, t.setup, t.level, t.tf);
  }
  return { ...none(capped ? 'a whole that one contract over the cap refuses' : `no whole plan (${tries.length} setup(s) tried)`), capped };
}

/** The first wired rule that fires on the bar with its onset filter (see the header), or null. */
function wiredPlan(b, side, ctx) {
  for (const w of WIRED) {
    const d = detect(w.rule, b, side, ctx);
    if (d.fires && onsetRules[w.onset](onset(b, side))) return { ...d, rule: w.rule, onset: w.onset };
  }
  return null;
}

let shipped = null;
/** The briefing's plan context for a symbol (see the header); null for a root without contract facts. */
function wiredContext(symbol) {
  const { specFor } = require('../contracts');
  const spec = specFor(String(symbol || '').split(':')[0]);
  if (!spec) return null;
  if (!shipped) {
    const path = require('path');
    const { stopRuleOf, STRATEGY } = require('../trade-lifecycle');
    const doc = require('../strategies').loadStrategies(path.resolve(__dirname, '..', '..', '..', '..'), {}).strategies.find(x => x.name === STRATEGY);
    if (!doc || !doc.valid) return null;
    shipped = { minRR: doc.risk.min_rr, maxRiskUsd: doc.risk.max_risk_usd, stopRule: stopRuleOf(doc.risk) };
  }
  return { tick: spec.tickSize, plan: { size: 1, tickValue: spec.tickValue, suggestion: false, ...shipped } };
}

/** The briefing's line of wired plans (see the header), or null when none fires. Never throws. */
function detectedLine(b, { et = x => x, skip = [] } = {}) {
  try {
    const ctx = wiredContext(b.symbol);
    if (!ctx) return null;
    const parts = [];
    for (const side of ['long', 'short']) {
      if (skip.includes(side)) continue;
      const w = wiredPlan(b, side, ctx);
      if (!w) continue;
      const ch = checkReads({ reads: w.reads.map(r => ({ ...r, skill: r.skill || 'x' })), side, briefing: b, tick: ctx.tick });
      const p = planOf({ checked: ch, briefing: b, side, tick: ctx.tick, ...ctx.plan }).plan;
      parts.push(`${side} "${w.setupRead}" (${w.rule}, ${w.onset === 'momentum' ? 'momentum' : 'momentum onset'} the trend's way): plan OK: entry ${p.entry.price}, stop ${p.stop.price} (${p.stop.ticks}t), target ${p.target.price}, R:R ${p.rr}; reads ${w.reads.map(r => `"${r.read}"`).join(', ')}`);
    }
    return parts.length ? `- Trend setups (code, at a named level, the trend's way, as compose_check plans them; closed ${et(b.closedAt)}): ${parts.join('; ')}. OK -> compose_check with its reads; never estimate R:R.` : null;
  } catch (_err) {
    return null;
  }
}

module.exports = { RULES, WIRED, ONSET: onsetRules, detect, onset, gateOpen, wiredPlan, wiredContext, detectedLine };
