'use strict';

/**
 * The reads available at a bar: every read of compose_check's vocabulary (trading/composed-reads.js) the bar briefing
 * can state for a side, checked by the checker itself (checkRead) and kept when TRUE, each with the trade-lifecycle
 * crosswalk's skill (skills/trade-lifecycle/SKILL.md, its step table). Pure: the caller hands it the briefing.
 *
 * The skill-usage report (skill-usage.js) reads it for what was available to the model on a bar; the per-skill
 * decision-path scenarios (tests/e2e/skill-scenarios-e2e.test.js) for which fixture bars hold a true read of a skill.
 * One table for both (READ_SKILL), the same as the curated lists' scanner's (curated-moments.js READ_SKILL, in review
 * apart): when both are in, the scanner reads this one, so a read is the same skill's wherever it is counted.
 *
 * The candidates (candidateReads), per step, for a side (d: up for a long, down for a short):
 *   bias      each trend (15m, 1h, 4h), the latest break of the base bars, 15m and 1h, the regime, the day type, the
 *             prior RTH range, the trend rule for the side, the side's multi-timeframe read
 *   location  at every level the briefing names (its key levels, every candle relation's level, the untaken equal
 *             highs and lows), at each timeframe's gaps, the VWAP side, the prior value area
 *   setup     every candle's relation to a level or a gap's edge (rejected and broke with their way, touched), every
 *             candle's patterns, each live CISD, each OTE zone, each sweep
 *   entry     every candle's close location, its momentum the side's way, its volume, its absorption the side's way
 *             at each level it met, its confirming pattern (ENTRY_PATTERNS); the participation
 *   stop      each candle's low (long) or high (short), the base swing and the swing pools, the higher frames' swings,
 *             the key levels
 *   target    the swing targets, the prior 1h and 4h candles' high, mid and low, each gap's unfilled edges, the key
 *             levels
 * A read agrees with the side as the checker settles it: one with a direction must be the side's (a trend or break
 * against it stands when the true reads hold its frame's D2 tier, composed-reads.js d2TierMet), a stop below a long's
 * price and a target above it; one without a direction (at, vwap, value, touched, volume, participation, OTE's
 * none) supports either side.
 *
 * pullback-vs-reversal has no read of its own: it is available when the true agreeing reads show the shape (shapeOf):
 * a reversal is a true 15m or 1h CHoCH the side's way (D2's CHoCH frames; the curated scanner's shape takes any
 * frame's); a pullback a true trend read the side's way, the side's multi-timeframe read `pullback` and a setup
 * rejection the side's way.
 *
 *   READ_SKILL, SHAPE_SKILL, NO_READ_SKILLS
 *   skillOfRead(step, read)                  the crosswalk's skill for a read at its step, or null
 *   candidateReads(briefing, side)           { bias: [read], location, setup, entry, stop, target }
 *   trueReads(briefing, side, { tick })      [{ step, skill, read, form, kind, dir, agrees }], TRUE only, once each
 *   shapeOf(reads, side)                     'reversal' | 'pullback' | null
 *   availableSkills(briefing, side, { tick })   Map skill -> { reads: the true ones, agreeing: those agreeing }
 */

const { checkRead, parseRead, levelName, ENTRY_PATTERNS, D2_TIERS, d2TierMet } = require('../trading/composed-reads');

const STEP_LIST = ['bias', 'location', 'setup', 'entry', 'stop', 'target'];

/** The trade-lifecycle crosswalk's skill for each kind of read, per step (its table). */
const READ_SKILL = Object.freeze({
  bias: Object.freeze({ trend: 'multi-timeframe-analysis', trendRule: 'multi-timeframe-analysis', alignment: 'multi-timeframe-analysis', break: 'bos-vs-choch', priorRth: 'daily-bias', dayType: 'daily-bias', regime: 'trend-vs-range' }),
  location: Object.freeze({ at: 'levels-and-reactions', atFvg: 'fair-value-gaps', vwap: 'vwap-volume-profile', value: 'vwap-volume-profile' }),
  setup: Object.freeze({ rejected: 'rejection', broke: 'breakout', fvg: 'fair-value-gaps', pattern: 'candle-reading', cisd: 'cisd', ote: 'cisd', swept: 'breakout-vs-fakeout' }),
  entry: Object.freeze({ close: 'candle-reading', pattern: 'candle-reading', momentum: 'momentum-and-volume', volume: 'momentum-and-volume', participation: 'momentum-and-volume', absorption: 'absorption' }),
  stop: Object.freeze({ stop: 'invalidation' }),
  target: Object.freeze({ target: 'take-profit' }),
});
/** The skill read from the reads' shape, not a read of its own. */
const SHAPE_SKILL = 'pullback-vs-reversal';
/** The crosswalk's skills with no read form: the size step's and the management step's (no compose read states them). */
const NO_READ_SKILLS = Object.freeze({ size: Object.freeze(['position-sizing', 'prop-challenge-pacing', 'prop-pacing-judgment']), management: Object.freeze(['manage-position']) });

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const sec = (b, name) => (isObj(b) && isObj(b.sections) && isObj(b.sections[name]) && isObj(b.sections[name].data) ? b.sections[name].data : {});
const tfLabel = m => (m % 60 === 0 ? `${m / 60}h` : `${m}m`);
const dirOf = side => (side === 'long' ? 'up' : side === 'short' ? 'down' : null);
const TF_MIN = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '1h': 60, '4h': 240 };
const FVG_EDGE = / fvg (low|high)$/;
const FVG_ZONE = /^(1m|3m|5m|15m|1h|4h) fvg$/;
// The CHoCH frames that make a reversal: D2's (composed-reads.js D2_TIERS), the owner's "CHoCH at or above the trend";
// a base-bar CHoCH is a shift on the trigger frame, not the trend reversing.
const REVERSAL_TFS = [...new Set(Object.values(D2_TIERS).flatMap(t => t.choch))];

/** The crosswalk's skill for a read at its step, or null (a kind the step doesn't take, or no skill of its own). */
function skillOfRead(step, read) {
  const p = parseRead(read);
  const row = READ_SKILL[step] || {};
  if (p.kind === 'at') return FVG_ZONE.test(p.level) ? row.atFvg || null : row.at || null;
  if (p.kind === 'relation') return FVG_EDGE.test(p.level) ? row.fvg || null : row[p.rel] || null;
  return row[p.kind] || null;
}

const lastBreak = x => (isObj(x) && isObj(x.last) ? { kind: String(x.last.kind || '').toLowerCase(), dir: x.last.direction } : null);
// What is left of a gap: an open gap's low and high, a partly filled one's unfilled part.
const leftOf = g => (!isObj(g) ? null : g.state === 'open' ? [g.low, g.high] : g.state === 'partly' && Array.isArray(g.unfilled) ? g.unfilled : null);
const live = c => isObj(c) && !c.unavailable;
const patternsOf = c => [...new Set([...(Array.isArray(c.patterns) ? c.patterns : []), c.pattern].filter(p => typeof p === 'string' && p && p !== 'none'))];

/** Every read the briefing can state for the side, by step (candidates; trueReads keeps the TRUE ones). */
function candidateReads(b, side) {
  const m3 = sec(b, 'm3');
  const m15 = sec(b, 'm15');
  const h1 = sec(b, 'h1');
  const d = dirOf(side);
  const out = { bias: [], location: [], setup: [], entry: [], stop: [], target: [] };
  const base = num(b && b.minutes) ? tfLabel(b.minutes) : null;
  for (const [tf, f] of [['15m', m15.frame], ['1h', h1.h1], ['4h', h1.h4]]) if (isObj(f) && ['up', 'down', 'range'].includes(f.trend)) out.bias.push(`${tf} ${f.trend}`);
  for (const [tf, x] of [[base, m3.lastBreak], ['15m', m15.lastBreak], ['1h', h1.lastBreak]]) {
    const lb = lastBreak(x);
    if (tf && lb && ['bos', 'choch'].includes(lb.kind) && ['up', 'down'].includes(lb.dir)) out.bias.push(`${tf} ${lb.kind} ${lb.dir}`);
  }
  if (isObj(m3.regime) && typeof m3.regime.primary === 'string') out.bias.push(`regime ${levelName(m3.regime.primary)}`);
  if (isObj(m3.today) && typeof m3.today.dayType === 'string') out.bias.push(`day type ${levelName(m3.today.dayType)}`);
  if (isObj(m3.location) && ['above', 'below', 'inside'].includes(m3.location.priorRthRange)) out.bias.push(`${m3.location.priorRthRange} prior rth range`);
  out.bias.push(`trend ${side} allowed`);
  if (isObj(m15.alignment) && typeof m15.alignment[side] === 'string') out.bias.push(`read ${side} ${m15.alignment[side]}`);

  const candles = isObj(m3.candles) ? Object.entries(m3.candles).filter(([, c]) => live(c)) : [];
  const levels = new Set();
  for (const x of Array.isArray(b && b.keyLevels) ? b.keyLevels : []) if (Array.isArray(x) && x[0]) levels.add(levelName(x[0]));
  for (const [, c] of candles) for (const r of Array.isArray(c.relations) ? c.relations : []) if (isObj(r) && r.name) levels.add(levelName(r.name));
  const liq = isObj(m3.liquidity) ? m3.liquidity : {};
  for (const x of [...(liq.equalHighs || []), ...(liq.equalLows || [])]) if (isObj(x) && !x.taken && x.name) levels.add(levelName(x.name));
  for (const l of levels) out.location.push(`at ${l}`);
  for (const [tf, v] of Object.entries(isObj(m3.fvgs) ? m3.fvgs : {})) if (Array.isArray(v) && v.length) out.location.push(`at ${tf} fvg`);
  if (isObj(m3.vwap) && ['above', 'below', 'at'].includes(m3.vwap.side)) out.location.push(`vwap ${m3.vwap.side}`);
  if (isObj(m3.location) && ['above', 'below', 'inside'].includes(m3.location.priorValue)) out.location.push(`value ${m3.location.priorValue}`);

  for (const [tf, c] of candles) {
    for (const r of [...(Array.isArray(c.relations) ? c.relations : []), ...(Array.isArray(c.fvgRelations) ? c.fvgRelations : [])]) {
      if (!isObj(r) || !r.name || !['rejected', 'broke', 'touched'].includes(r.rel)) continue;
      out.setup.push(r.rel === 'touched' ? `${tf} touched ${levelName(r.name)}` : `${tf} ${r.rel} ${levelName(r.name)} ${r.dir}`);
      if (r.rel !== 'broke') out.entry.push(`${tf} absorption at ${levelName(r.name)} ${d}`);
    }
    for (const p of patternsOf(c)) {
      out.setup.push(`${tf} pattern ${levelName(p)}`);
      if (ENTRY_PATTERNS[p]) out.entry.push(`${tf} pattern ${p}`);
    }
    if (['top', 'middle', 'bottom'].includes(c.closeLocation)) out.entry.push(`${tf} close ${c.closeLocation}`);
    out.entry.push(`${tf} momentum ${d}`, `${tf} volume high`);
    if (side === 'long' && num(c.l) !== null) out.stop.push(`stop ${tf} low ${c.l}`);
    if (side === 'short' && num(c.h) !== null) out.stop.push(`stop ${tf} high ${c.h}`);
  }
  out.entry.push('participation high');
  for (const [tf, c] of Object.entries(isObj(m3.cisd) ? m3.cisd : {})) {
    if (!isObj(c)) continue;
    const cd = c.dir === 'bullish' ? 'up' : c.dir === 'bearish' ? 'down' : null;
    if (cd) out.setup.push(`${tf} cisd ${cd}`);
    out.setup.push(`${tf} in ote`);
  }
  for (const s of Array.isArray(m3.sweeps) ? m3.sweeps : []) if (isObj(s) && s.name) out.setup.push(`swept ${levelName(s.name)}`);

  const type = side === 'long' ? 'low' : 'high';
  const sw = isObj(m3.swings) ? num(m3.swings[type]) : null;
  if (sw !== null) out.stop.push(`stop swing ${type} ${sw}`);
  for (const x of Array.isArray(liq[type === 'low' ? 'swingLows' : 'swingHighs']) ? liq[type === 'low' ? 'swingLows' : 'swingHighs'] : []) if (isObj(x) && num(x.price) !== null) out.stop.push(`stop swing ${type} ${x.price}`);
  for (const x of Array.isArray(m3.htfLevels) ? m3.htfLevels : []) if (isObj(x) && x.type === type && num(x.price) !== null && x.name) out.stop.push(`stop ${levelName(x.name)} ${x.price}`);
  const key = (Array.isArray(b && b.keyLevels) ? b.keyLevels : []).filter(x => Array.isArray(x) && x[0] && num(x[1]) !== null);
  for (const [name, price] of key) out.stop.push(`stop ${levelName(name)} ${price}`);

  const st = isObj(m3.swingTargets) ? m3.swingTargets : {};
  for (const x of [...(st.above || []), ...(st.below || [])]) if (isObj(x) && x.frame && num(x.price) !== null) out.target.push(`target ${levelName(x.frame)} swing ${x.price}`);
  for (const [tf, r] of Object.entries(isObj(m3.rangeTargets) ? m3.rangeTargets : {})) {
    if (!isObj(r) || r.unavailable) continue;
    for (const part of ['high', 'mid', 'low']) if (isObj(r[part]) && num(r[part].price) !== null) out.target.push(`target prior ${tf} ${part} ${r[part].price}`);
  }
  for (const [tf, v] of Object.entries(isObj(m3.fvgs) ? m3.fvgs : {})) {
    for (const e of (Array.isArray(v) ? v : []).map(leftOf).filter(Boolean)) {
      if (num(e[0]) !== null) out.target.push(`target ${tf} fvg low ${e[0]}`);
      if (num(e[1]) !== null) out.target.push(`target ${tf} fvg high ${e[1]}`);
    }
  }
  for (const [name, price] of key) out.target.push(`target ${levelName(name)} ${price}`);
  return out;
}

/** Every read TRUE at the briefing for the side, once each: [{ step, skill, read, form, kind, dir, agrees }]. */
function trueReads(b, side, { tick = 0.25 } = {}) {
  const out = [];
  const seen = new Set();
  const cands = candidateReads(b, side);
  for (const step of STEP_LIST) {
    for (const read of cands[step]) {
      const p = parseRead(read);
      if (!p.form || p.kind === 'unknown' || p.kind === 'ambiguous' || seen.has(p.form)) continue;
      seen.add(p.form);
      const c = checkRead(p, b, { tick });
      if (c.check !== true) continue;
      out.push({ step, skill: skillOfRead(step, read), read, form: p.form, kind: p.kind, dir: c.dir || null, agrees: step === 'stop' || step === 'target' ? c.dir === side : !c.dir || c.dir === side });
    }
  }
  // D2: a trend or break read against the side agrees when the true reads hold its frame's tier the side's way.
  const checked = out.map(r => ({ ...r, check: true }));
  for (const r of out) {
    if (r.agrees || !['trend', 'break'].includes(r.kind)) continue;
    const tier = TF_MIN[r.form.split(' ')[0]] ? D2_TIERS[Math.max(15, TF_MIN[r.form.split(' ')[0]])] || null : null;
    if (d2TierMet(tier, checked, side)) r.agrees = true;
  }
  return out;
}

/** 'reversal' or 'pullback' when the reads (true, agreeing) show one exactly, else null. */
function shapeOf(reads, side) {
  const d = dirOf(side);
  const good = (reads || []).filter(r => r && r.agrees !== false && (r.check === undefined || r.check === true || r.check === 'true')).map(r => ({ step: r.step, p: parseRead(r.read) }));
  if (good.some(({ p }) => p.kind === 'break' && p.breakKind === 'choch' && p.value === d && REVERSAL_TFS.includes(p.tf))) return 'reversal';
  const trend = good.some(({ p }) => p.kind === 'trend' && p.value === d);
  const pullback = good.some(({ p }) => p.kind === 'alignment' && p.side === side && p.value === 'pullback');
  const rejection = good.some(({ step, p }) => step === 'setup' && p.kind === 'relation' && p.rel === 'rejected' && p.value === d);
  return trend && pullback && rejection ? 'pullback' : null;
}

/** Map skill -> { reads: the TRUE reads of that skill, agreeing: those agreeing with the side }. */
function availableSkills(b, side, { tick = 0.25 } = {}) {
  const reads = trueReads(b, side, { tick });
  const out = new Map();
  const add = (skill, r) => {
    if (!out.has(skill)) out.set(skill, { reads: [], agreeing: [] });
    out.get(skill).reads.push(r);
    if (r.agrees) out.get(skill).agreeing.push(r);
  };
  for (const r of reads) if (r.skill) add(r.skill, r);
  const shape = shapeOf(reads.filter(r => r.agrees), side);
  if (shape) add(SHAPE_SKILL, { step: 'bias', skill: SHAPE_SKILL, read: shape, form: shape, kind: 'shape', dir: side, agrees: true });
  return out;
}

module.exports = { READ_SKILL, SHAPE_SKILL, NO_READ_SKILLS, skillOfRead, candidateReads, trueReads, shapeOf, availableSkills };
