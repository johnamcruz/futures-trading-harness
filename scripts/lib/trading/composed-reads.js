'use strict';

/**
 * The trade-lifecycle reads checker (the trade-lifecycle design, its read vocabulary): the model's combination, stated as reads,
 * checked in code against the cycle bar's briefing. Pure: no files, no clock; the caller hands it the briefing
 * (fact-claims.js briefingFor with the cycle bar) and the skill names.
 *
 * A read is { step, skill, read, why }:
 *   step   bias | location | setup | entry | stop | target (the trader process; all six are required, D7)
 *   skill  the skill the model reached for (a skill folder; recorded, never checked against the form)
 *   read   one closed form below (no negation, no brackets, ASCII only, as FACTS items); the model never names a field
 *   why    its reason for the step, at most WHY_MAX characters (recorded, never checked)
 *
 * The forms (tf: 1m, 3m, 5m, 15m, 1h (60m is written 1h), 4h, as each field has it; "<level>" is a level's name as the
 * briefing names it, lower case, brackets dropped: "prior vah", "vwap rth", "1h swing high 21598"):
 *
 *   form                                    briefing field                                direction
 *   <15m|1h|4h> up|down|range               m15.frame.trend, h1.h1.trend, h1.h4.trend     up long, down short
 *   <tf> bos|choch up|down                  m3.lastBreak (the base bars), m15, h1 .last   up long, down short
 *   above|below|inside prior rth range      m3.location.priorRthRange                     above long, below short
 *   above prior rth high, below prior rth low   the same
 *   trend long|short allowed                m3.trendRule for that side                    its side
 *   read long|short <aligned|mixed|pullback|counter>   m15.alignment for that side         its side
 *   vwap above|below|at                     m3.vwap.side                                  none
 *   value inside|above|below                m3.location.priorValue                        none
 *   regime <name>, day type <name>          m3.regime.primary, m3.today.dayType ("trend-up" read as "trend up")   none
 *   at <level>                              the level inside the trigger bar's range (m3.bar), or met by the base
 *                                           timeframe's candle or the next one up and within one ATR(14) of price
 *                                           (m3.candles.<tf>.relations, m3.atr14)         none
 *   at <tf> fvg                             the same with a zone: an unfilled gap (m3.fvgs, what is left of it)
 *                                           overlapping the trigger bar, or overlapped by the base or next candle and
 *                                           within one ATR(14) of price (inside it: 0)     none
 *   <tf> rejected|broke <level> up|down     m3.candles.<tf>.relations (every relation, uncapped)   up long, down short
 *   <tf> touched <level>                    the same                                      none
 *   ... <tf> fvg low|high ...               a gap's edge as the <level> of the two above: m3.candles.<tf>.fvgRelations,
 *                                           the gaps as they stood at the candle's open, the same relation rule (a
 *                                           bounce is a rejection, a failure a break)     as above
 *   <tf> pattern <name>                     m3.candles.<tf>.patterns (or pattern)          engulfing by its colour,
 *                                                                                         displacement by its dir; in
 *                                           the entry step only ENTRY_PATTERNS (hammer and bullish engulfing long,
 *                                           shooting star and bearish engulfing short)
 *   <tf> volume high                        m3.candles.<tf>.volRatio >= VOLUME_HIGH (1.5)  none
 *   participation high                      m3.participation.relVolLast3VsPrior20 >= 1.5   none
 *   <tf> absorption at <level> up|down      m3.candles.<tf> relations (fvgRelations for a gap edge), volRatio,
 *                                           rangeAtr: met the level without closing beyond (rejected the read's way,
 *                                           or touched with open and close on its side), volume >= 1.5x, net move
 *                                           |close - open| <= 0.5 ATR(14)                 up long, down short
 *   <tf> cisd up|down                       m3.cisd.<tf>.dir, a live one (void, expired or weak: false)   up long, down short
 *   [<tf>] in ote                           m3.cisd.<tf>.priceInOte of a live CISD (no tf: any; zones both ways:
 *                                           false)                                        the CISD's way
 *   swept <level>                           m3.sweeps (by name)                           none
 *   <tf> close top|middle|bottom            m3.candles.<tf>.closeLocation                 top long, bottom short
 *   <tf> momentum up|down                   D4's bar read on m3.candles.<tf>: rangeAtr >= 1, volRatio >= 1, close in
 *                                           the far third (top up, bottom down)            up long, down short
 *   stop <source> <price>                   step stop only: <tf> low|high (a completed candle), [<tf>] swing
 *                                           low|high (m3.swings, m3.liquidity, m3.htfLevels), or <level>; the
 *                                           source's price within one tick of <price>    below price long
 *   target <source> <price>                 step target only: <tf> swing [high|low] (m3.swingTargets), prior 1h|4h
 *                                           high|mid|low (m3.rangeTargets: the prior completed candle; an off-tick
 *                                           mid is the price on the tick toward price; a side the candle forming
 *                                           has taken is spent: false), <tf> fvg high|low (m3.fvgs:
 *                                           an unfilled gap's edge, a partly filled one's unfilled part), or <level>;
 *                                           within one tick                              above price long
 *
 * Each read is true, false or 'unchecked' (a form this checker doesn't know, a fact the briefing doesn't hold, a
 * level it doesn't name): never true unless the briefing says so. Side agreement (D12): a read with a direction must
 * be the order's side; a stop or target must be on its side of the reference price (m3.price). The one exception is
 * D2's verified reversal: when the combination also has a true 15m or 1h CHoCH the side's way, a trend or break read
 * against the side stands on a timeframe at or below that CHoCH's. The gate's trend rule is its own (lifecycle-gate.js
 * reversalAllowed, the owner's "CHoCH at or above the trend": a 15m trend faded on a 15m or 1h CHoCH, a 1h trend on a
 * 1h CHoCH, a 4h trend on a 1h CHoCH plus a 4h candle that rejected a level the trade's way). Each step takes its own kinds of read (STEP_KINDS: bias the trend, break, prior-range, trend-rule, alignment,
 * regime and day-type reads; location at, vwap and value; setup the candle relations, patterns, CISD, OTE and sweeps;
 * entry close, momentum, volume, participation, absorption and the confirming pattern), and no read is stated twice
 * (the same pattern in setup and entry counts once). The combination is ok when every read is true and agrees,
 * every step is stated, and there is exactly one stop and one target read.
 *
 *   parseRead(text)                           { kind, ...params, form, slug } | { kind: 'ambiguous' | 'unknown' }
 *   checkRead(parsed, briefing, { side, tick })  { check, fact, field, value, dir, price? }
 *   checkReads({ reads, side, briefing, skills, tick })   { ok, side, reference, reads, problems, missingSteps,
 *                                             stop, target, signature, skillSignature }
 *   readSignature(reads, { targetR }), skillSignature(reads)   the canonical signatures (section 3.8)
 *   contextOf(briefing, side)                 the context keys (section 4.2), read by code, never stated
 *   renderCheck(result)                       the check as text, for the model
 */

const { trendRuleOf } = require('./reasons');

const STEPS = ['bias', 'location', 'setup', 'entry', 'stop', 'target'];
const SIDES = ['long', 'short'];
// The step each kind of read belongs to (the design's read vocabulary); stop and target are checked on their own.
// A pattern is a setup read, or the entry's confirming candle (ENTRY_PATTERNS only).
const STEP_KINDS = {
  trend: ['bias'], break: ['bias'], priorRth: ['bias'], trendRule: ['bias'], alignment: ['bias'], regime: ['bias'], dayType: ['bias'],
  at: ['location'], vwap: ['location'], value: ['location'],
  relation: ['setup'], pattern: ['setup', 'entry'], cisd: ['setup'], ote: ['setup'], swept: ['setup'],
  close: ['entry'], momentum: ['entry'], volume: ['entry'], participation: ['entry'], absorption: ['entry'],
};
// The confirming candle patterns the entry step takes, and the side each confirms.
const ENTRY_PATTERNS = { hammer: 'long', 'bullish engulfing': 'long', 'shooting star': 'short', 'bearish engulfing': 'short' };
const MAX_READS = 16;
const READ_MAX = 120;
const WHY_MAX = 160;
const SKILL = /^[a-z0-9][a-z0-9-]{0,63}$/;
// D4: the momentum bar read (range at least 1 ATR(14), volume at least the 20-bar average, close in the far third).
const MOMENTUM = { rangeAtr: 1, volRatio: 1 };
// High volume: at least 1.5 times the average (the snapshot's own participation scale, market-snapshot.js: "under 1.0
// is thin participation, 1.5+ strong"; the absorption skill's "about 1.5 times"). Momentum asks only for the average.
const VOLUME_HIGH = 1.5;
// Absorption (the absorption skill): high volume (VOLUME_HIGH) with little progress, the candle's net move |close -
// open| at most half its timeframe's ATR(14), at a level it met without closing beyond (rejected, or touched and held).
const ABSORPTION = { volRatio: VOLUME_HIGH, progressAtr: 0.5 };
// A fair value gap's edge as a level name ('15m fvg low'), and a gap zone as a location ('15m fvg').
const FVG_EDGE = /^(1m|3m|5m|15m|1h|4h) fvg (low|high)$/;
const FVG_ZONE = /^(1m|3m|5m|15m|1h|4h) fvg$/;
const TF_ORDER = ['1m', '3m', '5m', '15m', '1h', '4h'];
const TFS = new Set(TF_ORDER);
const TREND_TF = { '15m': ['m15', 'frame'], '1h': ['h1', 'h1'], '4h': ['h1', 'h4'] };

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const data = (b, name) => (isObj(b) && isObj(b.sections) && isObj(b.sections[name]) && isObj(b.sections[name].data) ? b.sections[name].data : null);
const dirSide = d => (d === 'up' ? 'long' : d === 'down' ? 'short' : null);

const NEGATION = /\b(?:not|no|never|cannot|cant|dont|doesnt|isnt|arent|wont)\b|n't\b/i;
const BRACKET = /[()[\]{}]/;
const NON_ASCII = /[^\x20-\x7e]/;

/** Words in their plain spelling: lower case, "15-min" as 15m, "60m" as 1h, numbers canonical (21598.00 is 21598). */
function words(text) {
  return String(text || '').toLowerCase()
    .replace(/\b(\d+)\s*-?\s*(?:min|mins|minute|minutes)\b/g, '$1m').replace(/\b(\d+)\s*-?\s*(?:hr|hrs|hour|hours)\b/g, '$1h')
    .replace(/[:=,;]/g, ' ').replace(/(?<=[a-z])-(?=[a-z])/g, ' ').replace(/\.$/, '')
    .split(/\s+/).filter(Boolean)
    .map(w => (w === '60m' ? '1h' : w === '240m' ? '4h' : /^-?\d+(\.\d+)?$/.test(w) ? String(Number(w)) : w));
}

/** A level's name as reads write it: lower case, brackets dropped, numbers canonical ("VWAP (rth)" is "vwap rth"). */
const levelName = name => words(String(name || '').replace(/[()[\]{}]/g, ' ')).join(' ');
const isNum = w => /^-?\d+(\.\d+)?$/.test(w);

/** One read parsed into its form: { kind, ...params, form (canonical text), slug (no prices) }. */
function parseRead(text) {
  const raw = String(text === undefined || text === null ? '' : text);
  if (raw.length > READ_MAX) return { kind: 'unknown', text: raw.slice(0, READ_MAX), why: `longer than ${READ_MAX} characters` };
  if (NEGATION.test(raw) || BRACKET.test(raw) || NON_ASCII.test(raw)) return { kind: 'ambiguous', text: raw };
  const w = words(raw);
  const form = w.join(' ');
  const out = (kind, params, slugWords = w) => ({ kind, ...params, form, slug: slugWords.filter(x => !isNum(x)).join('-') });
  const unknown = { kind: 'unknown', text: raw, form };
  if (!w.length) return unknown;
  const [a, b, c] = w;
  const tf = TFS.has(a) ? a : null;
  if (tf && w.length === 2 && ['up', 'down', 'range'].includes(b) && TREND_TF[tf]) return out('trend', { tf, value: b });
  if (tf && w.length === 3 && ['bos', 'choch'].includes(b) && ['up', 'down'].includes(c)) return out('break', { tf, breakKind: b, value: c });
  if (/^(above|below|inside) prior rth range$/.test(form)) return out('priorRth', { value: a });
  if (form === 'above prior rth high' || form === 'below prior rth low') return out('priorRth', { value: a });
  if (a === 'trend' && w.length === 3 && SIDES.includes(b) && c === 'allowed') return out('trendRule', { side: b });
  if (a === 'read' && w.length === 3 && SIDES.includes(b) && ['aligned', 'mixed', 'pullback', 'counter'].includes(c)) return out('alignment', { side: b, value: c });
  if (a === 'vwap' && w.length === 2 && ['above', 'below', 'at'].includes(b)) return out('vwap', { value: b });
  if (a === 'value' && w.length === 2 && ['inside', 'above', 'below'].includes(b)) return out('value', { value: b });
  // A regime's name as the briefing writes it ("trend-up" reads as "trend up", as levelName spells it).
  if (a === 'regime' && w.length >= 2 && w.length <= 3) return out('regime', { value: w.slice(1).join(' ') });
  if (a === 'day' && b === 'type' && w.length >= 3) return out('dayType', { value: w.slice(2).join(' ') });
  if (a === 'at' && w.length >= 2) return out('at', { level: w.slice(1).join(' ') });
  if (tf && ['rejected', 'broke'].includes(b) && w.length >= 4 && ['up', 'down'].includes(w[w.length - 1])) {
    return out('relation', { tf, rel: b, level: w.slice(2, -1).join(' '), value: w[w.length - 1] });
  }
  if (tf && b === 'touched' && w.length >= 3) return out('relation', { tf, rel: 'touched', level: w.slice(2).join(' '), value: null });
  if (tf && b === 'pattern' && w.length >= 3) return out('pattern', { tf, value: w.slice(2).join(' ') });
  if (tf && b === 'cisd' && w.length === 3 && ['up', 'down'].includes(c)) return out('cisd', { tf, value: c });
  if (form === 'in ote' || (tf && w.length === 3 && b === 'in' && c === 'ote')) return out('ote', { tf });
  if (a === 'swept' && w.length >= 2) return out('swept', { level: w.slice(1).join(' ') });
  if (tf && b === 'close' && w.length === 3 && ['top', 'middle', 'bottom'].includes(c)) return out('close', { tf, value: c });
  if (tf && b === 'momentum' && w.length === 3 && ['up', 'down'].includes(c)) return out('momentum', { tf, value: c });
  if (tf && b === 'volume' && c === 'high' && w.length === 3) return out('volume', { tf, value: c });
  if (form === 'participation high') return out('participation', { value: 'high' });
  if (tf && b === 'absorption' && c === 'at' && w.length >= 5 && ['up', 'down'].includes(w[w.length - 1])) {
    return out('absorption', { tf, level: w.slice(3, -1).join(' '), value: w[w.length - 1] });
  }
  if ((a === 'stop' || a === 'target') && w.length >= 3 && isNum(w[w.length - 1])) {
    const source = w.slice(1, -1);
    if (source.some(isNum) && !(source.length >= 3 && source.slice(0, -1).every(x => !isNum(x)))) return unknown;
    return out(a, { source: source.join(' '), price: Number(w[w.length - 1]) }, source);
  }
  return unknown;
}

/** Every level the briefing names, by its read name: [price] (the session's levels, every candle relation, pools). */
function levelIndex(b) {
  const m3 = data(b, 'm3') || {};
  const out = new Map();
  const add = (name, price) => {
    const p = num(price);
    if (p === null || !name) return;
    const k = levelName(name);
    if (!out.has(k)) out.set(k, []);
    if (!out.get(k).includes(p)) out.get(k).push(p);
  };
  for (const x of Array.isArray(b && b.keyLevels) ? b.keyLevels : []) if (Array.isArray(x)) add(x[0], x[1]);
  for (const c of Object.values(isObj(m3.candles) ? m3.candles : {})) {
    for (const r of isObj(c) && Array.isArray(c.relations) ? c.relations : []) if (isObj(r)) add(r.name, r.price);
  }
  const liq = isObj(m3.liquidity) ? m3.liquidity : {};
  for (const x of [...(liq.equalHighs || []), ...(liq.equalLows || [])]) if (isObj(x) && !x.taken) add(x.name, x.price);
  return out;
}

/** The base timeframe's candle and the next available one up (the candles a location read may count). */
function recentFrames(m3, base) {
  const have = Object.entries(isObj(m3.candles) ? m3.candles : {}).filter(([, c]) => isObj(c) && !c.unavailable).map(([tf]) => tf)
    .sort((x, y) => TF_ORDER.indexOf(x) - TF_ORDER.indexOf(y));
  const i = have.indexOf(base);
  return i < 0 ? [] : have.slice(i, i + 2);
}

// A CISD whose zone is gone (cisd.js DEAD): no longer a live read.
const DEAD_CISD = new Set(['void', 'expired', 'weak']);

// What is left of a gap (m3.fvgs): an open gap's low and high, a partly filled one's unfilled part; else null.
const leftOf = g => (!isObj(g) ? null : g.state === 'open' ? [g.low, g.high] : g.state === 'partly' && Array.isArray(g.unfilled) ? g.unfilled : null);

const within = (a, b, tick) => Math.abs(a - b) <= tick + 1e-9;

/** A price on the tick toward the reference (a target rounds toward the entry); a price on the tick is unchanged. */
function towardRef(p, ref, tick) {
  const q = p / tick;
  if (!(tick > 0) || Math.abs(q - Math.round(q)) < 1e-9) return p;
  return Number(((ref !== null && p < ref ? Math.ceil(q) : Math.floor(q)) * tick).toFixed(10));
}

/**
 * The prices a stop or target source names (a source the briefing doesn't hold: none): { field, prices, why?, spent?,
 * note? } (why: what the briefing says instead; spent: the briefing holds it and says it is no target; note: how a
 * price was put on the tick).
 */
function sourcePrices(kind, source, b, base, { tick = 0.25, ref = null } = {}) {
  const m3 = data(b, 'm3') || {};
  const w = source.split(' ');
  const candles = isObj(m3.candles) ? m3.candles : {};
  if (kind === 'stop') {
    if (w.length === 2 && TFS.has(w[0]) && ['low', 'high'].includes(w[1])) {
      const c = candles[w[0]];
      return { field: `m3.candles.${w[0]}.${w[1] === 'low' ? 'l' : 'h'}`, prices: isObj(c) && !c.unavailable && num(c[w[1] === 'low' ? 'l' : 'h']) !== null ? [c[w[1] === 'low' ? 'l' : 'h']] : [] };
    }
    const swing = /^(?:(\S+) )?swing (low|high)$/.exec(source);
    if (swing && (!swing[1] || TFS.has(swing[1]))) {
      const [, tf = base, type] = swing;
      if (tf === base) {
        const sw = isObj(m3.swings) ? m3.swings[type] : null;
        const liq = isObj(m3.liquidity) ? m3.liquidity[type === 'low' ? 'swingLows' : 'swingHighs'] : null;
        return { field: `m3.swings.${type}, m3.liquidity`, prices: [sw, ...(Array.isArray(liq) ? liq.map(x => (isObj(x) ? x.price : null)) : [])].map(num).filter(x => x !== null) };
      }
      const htf = Array.isArray(m3.htfLevels) ? m3.htfLevels : [];
      return { field: 'm3.htfLevels', prices: htf.filter(x => isObj(x) && levelName(x.name) === `${tf} swing ${type}`).map(x => num(x.price)).filter(x => x !== null) };
    }
  } else {
    const swing = /^(\S+) swing(?: (high|low))?$/.exec(source);
    if (swing && TFS.has(swing[1])) {
      const t = isObj(m3.swingTargets) ? m3.swingTargets : {};
      const list = [...(t.above || []), ...(t.below || [])].filter(x => isObj(x) && levelName(x.frame) === swing[1]);
      return { field: 'm3.swingTargets', prices: list.map(x => num(x.price)).filter(x => x !== null) };
    }
    // The prior completed 1h or 4h candle's high, mid or low (m3.rangeTargets); an off-tick mid on the tick toward price.
    const range = /^prior (1h|4h) (high|mid|low)$/.exec(source);
    if (range) {
      const [, tf, part] = range;
      const r = isObj(m3.rangeTargets) ? m3.rangeTargets[tf] : null;
      const field = `m3.rangeTargets.${tf}.${part}`;
      if (isObj(r) && r.unavailable) return { field, prices: [], why: `the prior ${tf} candle is unavailable (${r.unavailable})` };
      const exact = isObj(r) && isObj(r[part]) ? num(r[part].price) : null;
      if (exact === null) return { field, prices: [] };
      // A side the candle forming has already traded beyond is spent as a target (the take-profit skill).
      if (part !== 'mid' && isObj(r.taken) && r.taken.side === part) return { field, prices: [], spent: `the prior ${tf} ${part} ${exact} is taken by the candle forming: spent as a target` };
      const p = part === 'mid' ? towardRef(exact, ref, tick) : exact;
      return { field, prices: [p], note: p === exact ? '' : ` (the mid ${exact} on the tick toward price)` };
    }
    // A fair value gap's edge on a timeframe (m3.fvgs): the edges of what is left of it (an open gap's low and high, a
    // partly filled one's unfilled part; a filled gap is gone).
    const fvg = /^(\S+) fvg (high|low)$/.exec(source);
    if (fvg && TFS.has(fvg[1])) {
      const [, tf, edge] = fvg;
      const v = isObj(m3.fvgs) ? m3.fvgs[tf] : undefined;
      const field = `m3.fvgs.${tf}`;
      if (typeof v === 'string') return { field, prices: [], why: `the ${tf} gaps are ${v}` };
      const prices = (Array.isArray(v) ? v : []).map(leftOf).filter(Boolean).map(e => num(e[edge === 'low' ? 0 : 1])).filter(x => x !== null);
      return { field, prices, ...(Array.isArray(v) && !prices.length ? { why: `no unfilled ${tf} gap in the briefing` } : {}) };
    }
  }
  return { field: 'the briefing\'s levels', prices: levelIndex(b).get(source) || [] };
}

/**
 * At a timeframe's fair value gap now (m3.fvgs[tf], what is left of each unfilled gap): the trigger bar's range overlaps
 * one, or the base timeframe's candle or the next one up overlapped it and it lies within one ATR(14) of price (inside
 * it: 0). The `at <level>` rule with a zone for the level.
 */
function atZone(tf, m3, base, res) {
  const v = isObj(m3.fvgs) ? m3.fvgs[tf] : undefined;
  const field = `m3.fvgs.${tf}, m3.bar, m3.candles.<base|next>`;
  if (typeof v === 'string') return res('unchecked', `the ${tf} gaps are ${v}`, { field });
  if (!Array.isArray(v)) return res('unchecked', `no ${tf} gaps in the briefing`, { field });
  const zones = v.map(leftOf).filter(z => Array.isArray(z) && z.length === 2 && z.every(x => num(x) !== null));
  if (!zones.length) return res(false, `no unfilled ${tf} gap in the briefing`, { field });
  const overlaps = (c, [lo, hi]) => isObj(c) && num(c.l) !== null && num(c.h) !== null && c.l <= hi && c.h >= lo;
  const bar = isObj(m3.bar) ? m3.bar : {};
  const price = num(m3.price);
  const atr = num(m3.atr14);
  const dist = ([lo, hi]) => (price === null ? null : price < lo ? lo - price : price > hi ? price - hi : 0);
  const frames = recentFrames(m3, base);
  const inBar = zones.find(z => overlaps(bar, z));
  const met = zones.find(z => frames.some(t => overlaps(m3.candles[t], z)) && dist(z) !== null && atr > 0 && dist(z) <= atr);
  const z = inBar || met;
  const name = ([lo, hi]) => `the ${tf} gap ${lo}-${hi}`;
  const fact = inBar ? `${name(inBar)} is inside the bar's range ${bar.l}-${bar.h}`
    : met ? `${name(met)} was met by the ${frames.join(' or ')} candle and is ${dist(met)} from price ${price}, within one ATR(14) ${atr}`
      : `${zones.map(name).join(', ')}: outside the bar's range ${bar.l}-${bar.h}, and not met by the ${frames.join(', ') || 'base'} candle within one ATR(14) ${atr === null ? 'unknown' : atr} of price ${price}`;
  return res(Boolean(z), fact, { field, value: z ? z.join('-') : null });
}

/**
 * The relations a level read is checked in: a gap edge ('<tf> fvg low|high') the candle's fvgRelations (the gaps as they
 * stood at its open), any other level its relations. list null: the briefing doesn't hold them.
 */
function relationsOf(c, tf, level) {
  const key = FVG_EDGE.test(level) ? 'fvgRelations' : 'relations';
  return { list: Array.isArray(c[key]) ? c[key] : null, field: `m3.candles.${tf}.${key}` };
}

/**
 * One parsed read checked against the briefing: { check: true | false | 'unchecked', fact, field, value, dir }. dir:
 * the side the read points to (null: none). A stop or target carries the briefing's price for it (`price`).
 */
function checkRead(p, b, { tick = 0.25 } = {}) {
  const res = (check, fact, extra = {}) => ({ check, fact, field: null, value: null, dir: null, ...extra });
  if (p.kind === 'ambiguous') return res(false, 'a negation, a bracket or a character outside plain ASCII: state each read plainly');
  if (p.kind === 'unknown') return res('unchecked', p.why || 'not a form this check knows (the forms: trading/composed-reads.js)');
  const m3 = data(b, 'm3');
  if (!m3) return res('unchecked', 'no bar briefing');
  const base = num(b.minutes) ? (b.minutes % 60 === 0 ? `${b.minutes / 60}h` : `${b.minutes}m`) : null;
  const candleOf = tf => {
    const c = isObj(m3.candles) ? m3.candles[tf] : null;
    if (!isObj(c)) return { why: `no ${tf} candle in the briefing` };
    if (c.unavailable) return { why: `the ${tf} candle is unavailable (${c.unavailable})` };
    return { c };
  };
  switch (p.kind) {
    case 'trend': {
      const [section, key] = TREND_TF[p.tf];
      const s = data(b, section);
      const trend = s && isObj(s[key]) ? s[key].trend : null;
      if (!['up', 'down', 'range'].includes(trend)) return res('unchecked', `the ${p.tf} trend is unknown`);
      return res(trend === p.value, `the ${p.tf} trend is ${trend}`, { field: `${section}.${key}.trend`, value: trend, dir: dirSide(p.value) });
    }
    case 'break': {
      const section = p.tf === '15m' ? 'm15' : p.tf === '1h' ? 'h1' : p.tf === base ? 'm3' : null;
      if (!section) return res('unchecked', `no ${p.tf} structure break in the briefing (it has ${base || 'the base bars'}, 15m and 1h)`);
      const s = data(b, section);
      const lb = s && isObj(s.lastBreak) ? s.lastBreak.last : undefined;
      if (lb === undefined) return res('unchecked', `the ${p.tf} structure break is unknown`);
      const fact = lb ? `the last ${p.tf} break is a ${lb.kind} ${lb.direction} through ${lb.level}` : `no ${p.tf} break yet`;
      return res(Boolean(lb) && String(lb.kind).toLowerCase() === p.breakKind && lb.direction === p.value, fact,
        { field: `${section}.lastBreak.last`, value: lb ? `${String(lb.kind).toLowerCase()} ${lb.direction}` : null, dir: dirSide(p.value) });
    }
    case 'priorRth': {
      const where = isObj(m3.location) ? m3.location.priorRthRange : null;
      if (!['above', 'below', 'inside'].includes(where)) return res('unchecked', 'the prior RTH range is unknown');
      return res(where === p.value, `price is ${where} the prior RTH range`, { field: 'm3.location.priorRthRange', value: where, dir: p.value === 'above' ? 'long' : p.value === 'below' ? 'short' : null });
    }
    case 'trendRule': {
      const rule = trendRuleOf(m3.trendRule);
      if (rule[p.side] !== true && rule[p.side] !== false) return res('unchecked', 'the trend rule for that side is not in the briefing');
      return res(rule[p.side], String(m3.trendRule), { field: 'm3.trendRule', value: rule[p.side] ? 'allowed' : 'blocked', dir: p.side });
    }
    case 'alignment': {
      const m15 = data(b, 'm15');
      const al = m15 && isObj(m15.alignment) ? m15.alignment[p.side] : null;
      if (typeof al !== 'string') return res('unchecked', 'the multi-timeframe read for that side is unknown');
      return res(al === p.value, `the ${p.side} read is ${al}`, { field: `m15.alignment.${p.side}`, value: al, dir: p.side });
    }
    case 'vwap': {
      const s = isObj(m3.vwap) ? m3.vwap.side : null;
      if (!['above', 'below', 'at'].includes(s)) return res('unchecked', 'the VWAP side is unknown');
      return res(s === p.value, `price ${s} the VWAP`, { field: 'm3.vwap.side', value: s });
    }
    case 'value': {
      const s = isObj(m3.location) ? m3.location.priorValue : null;
      if (!['above', 'below', 'inside'].includes(s)) return res('unchecked', 'the prior value area is unknown');
      return res(s === p.value, `price ${s} the prior value area`, { field: 'm3.location.priorValue', value: s });
    }
    case 'regime': {
      const r = isObj(m3.regime) && typeof m3.regime.primary === 'string' ? m3.regime.primary : null;
      if (!r) return res('unchecked', 'the regime is unknown');
      return res(levelName(r) === p.value, `the regime is ${r}`, { field: 'm3.regime.primary', value: r });
    }
    case 'dayType': {
      const d = isObj(m3.today) && typeof m3.today.dayType === 'string' ? m3.today.dayType : null;
      if (!d) return res('unchecked', 'the day type is unknown');
      return res(levelName(d) === p.value, `the day type is ${d}`, { field: 'm3.today.dayType', value: d });
    }
    case 'at': {
      if (FVG_ZONE.test(p.level)) return atZone(p.level.split(' ')[0], m3, base, res);
      // At a level now: inside the trigger bar's range, or met by the base timeframe's last completed candle or the next
      // one up and still within one ATR(14) of price. A higher timeframe's candle that met it an hour ago, or a level
      // far from price, is not "at" it.
      const prices = levelIndex(b).get(p.level) || [];
      const bar = isObj(m3.bar) ? m3.bar : {};
      const price = num(m3.price);
      const atr = num(m3.atr14);
      const inBar = prices.filter(x => num(bar.l) !== null && num(bar.h) !== null && x >= bar.l && x <= bar.h);
      const near = prices.filter(x => price !== null && atr > 0 && Math.abs(x - price) <= atr);
      const frames = recentFrames(m3, base);
      const met = frames.filter(tf => isObj(m3.candles[tf]) && Array.isArray(m3.candles[tf].relations)
        && m3.candles[tf].relations.some(r => isObj(r) && levelName(r.name) === p.level));
      if (!prices.length) return res('unchecked', `the briefing names no level "${p.level}"`);
      const ok = inBar.length > 0 || (met.length > 0 && near.length > 0);
      const fact = inBar.length ? `${p.level} ${inBar[0]} is inside the bar's range ${bar.l}-${bar.h}`
        : ok ? `${p.level} ${near[0]} was met by the ${met.join(', ')} candle and is within one ATR(14) ${atr} of price ${price}`
          : `${p.level} ${prices.join(', ')} is outside the bar's range ${bar.l}-${bar.h}${met.length ? `, ${atr > 0 ? `more than one ATR(14) ${atr} from price ${price}` : 'ATR(14) unknown'}` : ` and the ${frames.join(', ') || 'base'} candle didn't meet it`}`;
      return res(ok, fact, { field: 'm3.bar, m3.candles.<base|next>.relations', value: prices[0] });
    }
    case 'relation': {
      const got = candleOf(p.tf);
      if (!got.c) return res('unchecked', got.why);
      const { list, field } = relationsOf(got.c, p.tf, p.level);
      if (!list) return res('unchecked', `the ${p.tf} candle's ${field.endsWith('fvgRelations') ? 'gap' : 'level'} relations are not in the briefing`);
      // A gap edge's name can stand for more than one gap: the read holds when one of them met the candle so.
      const named = list.filter(x => isObj(x) && levelName(x.name) === p.level);
      const r = named.find(x => x.rel === p.rel && (x.dir || null) === p.value) || named[0];
      const fact = r ? `the ${p.tf} candle ${r.rel}${r.dir ? ` ${r.dir}` : ''} ${r.name}${FVG_EDGE.test(p.level) ? ` ${r.price}` : ''}` : `the ${p.tf} candle didn't meet ${p.level}`;
      return res(Boolean(r) && r.rel === p.rel && (r.dir || null) === p.value, fact,
        { field, value: r ? `${r.rel}${r.dir ? ` ${r.dir}` : ''}` : null, dir: dirSide(p.value) });
    }
    case 'volume': {
      const got = candleOf(p.tf);
      if (!got.c) return res('unchecked', got.why);
      const v = num(got.c.volRatio);
      if (v === null) return res('unchecked', `the ${p.tf} candle's volume against its average is unknown`);
      return res(v >= VOLUME_HIGH, `the ${p.tf} candle's volume is ${v}x its average (high: >= ${VOLUME_HIGH}x)`, { field: `m3.candles.${p.tf}.volRatio`, value: v });
    }
    case 'participation': {
      const v = isObj(m3.participation) ? num(m3.participation.relVolLast3VsPrior20) : null;
      if (v === null) return res('unchecked', 'the participation (the last 3 bars against the 20 before) is unknown');
      return res(v >= VOLUME_HIGH, `the last 3 bars' volume is ${v}x the 20 before (high: >= ${VOLUME_HIGH}x)`, { field: 'm3.participation.relVolLast3VsPrior20', value: v });
    }
    case 'absorption': {
      // High volume with little progress at a level the candle met without closing beyond: rejected the read's way, or
      // touched with its open and close on the read's side (up: a push down held at support; down: up held at resistance).
      const got = candleOf(p.tf);
      if (!got.c) return res('unchecked', got.why);
      const c = got.c;
      const { list, field } = relationsOf(c, p.tf, p.level);
      if (!list) return res('unchecked', `the ${p.tf} candle's level relations are not in the briefing`);
      const vals = [c.o, c.h, c.l, c.c, c.rangeAtr, c.volRatio].map(num);
      if (vals.some(x => x === null)) return res('unchecked', `the ${p.tf} candle's prices, range or volume are unknown`);
      const [o, h, l, cl, rangeAtr, volRatio] = vals;
      const held = x => (x.rel === 'rejected' && x.dir === p.value)
        || (x.rel === 'touched' && num(x.price) !== null && (p.value === 'up' ? Math.min(o, cl) >= x.price : Math.max(o, cl) <= x.price));
      const named = list.filter(x => isObj(x) && levelName(x.name) === p.level);
      const r = named.find(held) || named[0];
      // The net move in ATR(14): |close - open| over the ATR the range was measured against (range / rangeAtr).
      const progress = h > l && rangeAtr > 0 ? Math.round((Math.abs(cl - o) * rangeAtr / (h - l)) * 100) / 100 : 0;
      const ok = Boolean(r) && held(r) && volRatio >= ABSORPTION.volRatio && progress <= ABSORPTION.progressAtr;
      const met = r ? `${r.rel}${r.dir ? ` ${r.dir}` : ''} ${r.name}` : `didn't meet ${p.level}`;
      return res(ok, `the ${p.tf} candle ${met}, volume ${volRatio}x, net move ${progress} ATR (absorption ${p.value}: held at the level, volume >= ${ABSORPTION.volRatio}x, net move <= ${ABSORPTION.progressAtr} ATR)`,
        { field: `${field}, m3.candles.${p.tf}`, value: `${r ? r.rel : 'none'}, ${volRatio}x, ${progress} ATR`, dir: dirSide(p.value) });
    }
    case 'pattern': {
      const got = candleOf(p.tf);
      if (!got.c) return res('unchecked', got.why);
      const list = Array.isArray(got.c.patterns) ? got.c.patterns : typeof got.c.pattern === 'string' ? [got.c.pattern] : null;
      if (!list) return res('unchecked', `the ${p.tf} candle's pattern is unknown`);
      const dir = p.value === 'bullish engulfing' ? 'long' : p.value === 'bearish engulfing' ? 'short' : p.value === 'displacement' ? dirSide(got.c.dir) : null;
      return res(list.map(levelName).includes(p.value) && p.value !== 'none', `the ${p.tf} candle: ${list.join(', ')}`, { field: `m3.candles.${p.tf}.patterns`, value: list.join(', '), dir });
    }
    case 'cisd': {
      const x = isObj(m3.cisd) ? m3.cisd[p.tf] : undefined;
      if (typeof x === 'string' && /^none/.test(x)) return res(false, `no ${p.tf} CISD in these bars`, { field: `m3.cisd.${p.tf}`, dir: dirSide(p.value) });
      if (!isObj(x)) return res('unchecked', `the ${p.tf} CISD is unknown${typeof x === 'string' ? ` (${x})` : ''}`);
      const d = x.dir === 'bullish' ? 'up' : x.dir === 'bearish' ? 'down' : null;
      const dead = DEAD_CISD.has(x.status);
      return res(d === p.value && !dead, `the latest ${p.tf} CISD is ${x.dir} at ${x.level}, status ${x.status}${dead ? ' (dead: no longer a read)' : ''}`,
        { field: `m3.cisd.${p.tf}`, value: `${d} ${x.status}`, dir: dirSide(p.value) });
    }
    case 'ote': {
      // The OTE zone is the CISD's pullback zone: it points the CISD's way (a bearish zone is a short's location).
      const all = Object.entries(isObj(m3.cisd) ? m3.cisd : {}).filter(([tf, x]) => isObj(x) && (!p.tf || tf === p.tf));
      if (!all.length) return res('unchecked', `no ${p.tf ? `${p.tf} ` : ''}CISD zone in the briefing`);
      const inIt = all.filter(([, x]) => x.priceInOte === true && !DEAD_CISD.has(x.status));
      const dirs = [...new Set(inIt.map(([, x]) => (x.dir === 'bullish' ? 'long' : x.dir === 'bearish' ? 'short' : null)))];
      const fact = inIt.length ? `price is in the ${inIt.map(([tf, x]) => `${tf} ${x.dir}`).join(', ')} OTE zone` : 'price is in no live OTE zone';
      if (dirs.length > 1) return res(false, `${fact}: they point both ways, name the timeframe (<tf> in ote)`, { field: 'm3.cisd.<tf>.priceInOte' });
      return res(inIt.length > 0 && dirs[0] !== null, fact, { field: 'm3.cisd.<tf>.priceInOte', value: inIt.map(([tf]) => tf).join(', ') || null, dir: dirs[0] || null });
    }
    case 'swept': {
      if (!Array.isArray(m3.sweeps)) return res('unchecked', 'the sweeps are unknown');
      const s = m3.sweeps.find(x => isObj(x) && levelName(x.name) === p.level);
      return res(Boolean(s), s ? `${s.name} ${s.price} swept (${s.side})` : `no sweep of ${p.level} in the last bars${m3.sweeps.length ? ` (swept: ${m3.sweeps.map(x => x.name).join(', ')})` : ''}`, { field: 'm3.sweeps', value: s ? s.name : null });
    }
    case 'close': {
      const got = candleOf(p.tf);
      if (!got.c) return res('unchecked', got.why);
      const loc = got.c.closeLocation;
      if (!['top', 'middle', 'bottom'].includes(loc)) return res('unchecked', `the ${p.tf} close location is unknown`);
      return res(loc === p.value, `the ${p.tf} candle closed in its ${loc} third`, { field: `m3.candles.${p.tf}.closeLocation`, value: loc, dir: p.value === 'top' ? 'long' : p.value === 'bottom' ? 'short' : null });
    }
    case 'momentum': {
      const got = candleOf(p.tf);
      if (!got.c) return res('unchecked', got.why);
      const { rangeAtr, volRatio, closeLocation: loc } = got.c;
      if (num(rangeAtr) === null || num(volRatio) === null || !['top', 'middle', 'bottom'].includes(loc)) return res('unchecked', `the ${p.tf} candle's range, volume or close is unknown`);
      const far = p.value === 'up' ? 'top' : 'bottom';
      const ok = rangeAtr >= MOMENTUM.rangeAtr && volRatio >= MOMENTUM.volRatio && loc === far;
      return res(ok, `the ${p.tf} candle: range ${rangeAtr} ATR, volume ${volRatio}x, close ${loc} third (momentum ${p.value}: range >= ${MOMENTUM.rangeAtr} ATR, volume >= ${MOMENTUM.volRatio}x, close ${far} third)`,
        { field: `m3.candles.${p.tf}`, value: `${rangeAtr} ATR, ${volRatio}x, ${loc}`, dir: dirSide(p.value) });
    }
    case 'stop':
    case 'target': {
      const ref = num(m3.price);
      const { field, prices, why, spent, note = '' } = sourcePrices(p.kind, p.source, b, base, { tick, ref });
      if (spent) return res(false, spent, { field });
      if (!prices.length) return res('unchecked', why || `the briefing has no ${p.source} for a ${p.kind}`, { field });
      const hit = prices.find(x => within(x, p.price, tick));
      if (hit === undefined) return res(false, `${p.source} is ${prices.join(', ')}${note}, not ${p.price} (within one tick, ${tick})`, { field, value: prices[0] });
      const dir = ref === null || hit === ref ? null : (p.kind === 'stop') === (hit < ref) ? 'long' : 'short';
      return res(true, `${p.source} is ${hit}${note}; price ${ref}`, { field, value: hit, price: hit, dir });
    }
    default:
      return res('unchecked', 'not a form this check knows');
  }
}

/** A target's R bucket (section 4.2): under 1.5R, 1.5-2.5R, over 2.5R. */
const rBucket = r => (num(r) === null ? 'r-unknown' : r < 1.5 ? 'under-1.5r' : r <= 2.5 ? '1.5-2.5r' : 'over-2.5r');

/** The R of the target against the stop from the reference price (null when it can't be told). */
function targetROf(reference, stop, target) {
  if (num(reference) === null || num(stop) === null || num(target) === null) return null;
  const risk = Math.abs(reference - stop);
  return risk > 0 ? Math.round((Math.abs(target - reference) / risk) * 100) / 100 : null;
}

const stepOrder = (x, y) => STEPS.indexOf(x.step) - STEPS.indexOf(y.step) || String(x.skill).localeCompare(String(y.skill));

/**
 * The read signature (section 3.8): the reads in step order, sorted within a step by skill then form, prices
 * dropped; a target carries its R bucket (`targetR`, else the R of the checked reads).
 */
function readSignature(reads, { targetR = null, reference = null } = {}) {
  const stop = reads.find(r => r.step === 'stop' && r.kind === 'stop');
  const target = reads.find(r => r.step === 'target' && r.kind === 'target');
  const R = num(targetR) !== null ? targetR : targetROf(reference, stop && stop.price, target && target.price);
  const slug = r => (r.kind === 'target' ? `${r.slug}-${rBucket(R)}` : r.slug || levelName(r.read).replace(/ /g, '-'));
  const items = reads.map(r => ({ step: r.step, skill: r.skill, key: `${r.step}:${slug(r)}` }))
    .sort((x, y) => stepOrder(x, y) || x.key.localeCompare(y.key));
  return [...new Set(items.map(x => x.key))].join('+');
}

/** The skill signature: which skills at each step, steps in the fixed order, skills sorted within a step. */
function skillSignature(reads) {
  return STEPS.filter(s => reads.some(r => r.step === s))
    .map(s => `${s}:${[...new Set(reads.filter(r => r.step === s).map(r => r.skill))].sort().join(',')}`).join('+');
}

/** The context keys (section 4.2) for a side, read from the briefing by code. */
function contextOf(b, side) {
  const m3 = data(b, 'm3') || {};
  const m15 = data(b, 'm15') || {};
  const rule = trendRuleOf(m3.trendRule);
  const allows = rule[side];
  return {
    regime: isObj(m3.regime) ? m3.regime.primary ?? null : null,
    volatility: isObj(m3.regime) ? m3.regime.volatility ?? null : null,
    window: typeof m3.window === 'string' ? m3.window : null,
    trendSide: allows === true ? (rule.prevailing ? 'with' : 'none') : allows === false ? 'against' : null,
    alignment: isObj(m15.alignment) ? m15.alignment[side] ?? null : null,
    dayType: isObj(m3.today) ? m3.today.dayType ?? null : null,
  };
}

/**
 * The combination checked: { ok, side, reference, reads: [{ step, skill, read, why, kind, form, check, fact, field,
 * value, dir, agrees }], problems, missingSteps, stop, target, signature, skillSignature, context }. skills: the skill
 * folders that exist (a read naming another is refused); tick: the contract's (0.25 when not given).
 */
function checkReads({ reads, side, briefing, skills = null, tick = 0.25 } = {}) {
  const problems = [];
  if (!SIDES.includes(side)) problems.push('side must be long or short');
  const list = Array.isArray(reads) ? reads : [];
  if (!Array.isArray(reads) || !list.length) problems.push('no reads: state one per step at least (bias, location, setup, entry, stop, target)');
  if (list.length > MAX_READS) problems.push(`${list.length} reads, more than ${MAX_READS}`);
  const known = skills ? new Set(skills) : null;
  const m3 = data(briefing, 'm3');
  const reference = m3 ? num(m3.price) : null;
  const seen = new Set();
  const checked = list.slice(0, MAX_READS).map((r, i) => {
    const x = isObj(r) ? r : {};
    // Every stored field bounded (the CLI takes any JSON): the step and skill to their forms' length, the read to READ_MAX.
    const step = typeof x.step === 'string' ? x.step.toLowerCase().slice(0, 16) : null;
    const skill = typeof x.skill === 'string' ? x.skill.slice(0, 64) : null;
    const why = typeof x.why === 'string' ? x.why.slice(0, WHY_MAX) : null;
    const p = parseRead(x.read);
    const row = { step, skill, read: typeof x.read === 'string' ? x.read.slice(0, READ_MAX) : null, why, kind: p.kind, form: p.form || null, slug: p.slug || null };
    const bad = msg => { problems.push(`read ${i + 1} ("${row.read}"): ${msg}`); return { ...row, check: false, fact: msg, field: null, value: null, dir: null, agrees: false }; };
    if (!STEPS.includes(step)) return bad(`step must be one of ${STEPS.join(', ')}`);
    if (!skill || !SKILL.test(skill)) return bad('skill must be a skill folder name');
    if (known && !known.has(skill)) return bad(`no skill named ${skill}`);
    // A stop or target read only in its own step, and that step holds only its own form.
    const own = ['stop', 'target'].find(k => (step === k) !== (p.kind === k));
    if (own) return bad(`a ${own} read is "${own} <source> <price>", in the ${own} step only`);
    // Each step takes its own kinds of read (the skill and the form within them are the model's choice).
    if (STEP_KINDS[p.kind] && !STEP_KINDS[p.kind].includes(step)) return bad(`a ${p.kind} read belongs to the ${STEP_KINDS[p.kind].join(' or ')} step, not ${step}`);
    // The entry's confirming candle: one of ENTRY_PATTERNS, and it points to its side.
    const entryPattern = step === 'entry' && p.kind === 'pattern';
    if (entryPattern && !ENTRY_PATTERNS[p.value]) return bad(`an entry pattern is one of ${Object.keys(ENTRY_PATTERNS).join(', ')}`);
    if (p.form && seen.has(p.form)) return bad('the same read twice: each read is stated once, in one step');
    if (p.form) seen.add(p.form);
    const c = checkRead(p, briefing, { tick });
    return { ...row, ...c, ...(entryPattern ? { dir: ENTRY_PATTERNS[p.value] } : {}), agrees: true };
  });
  // Side agreement (D12), with D2's verified reversal: a true 15m or 1h CHoCH the side's way lets a trend or break read
  // against the side stand on a timeframe at or below the CHoCH's (a 15m CHoCH never excuses a 1h or 4h trend; a 3m
  // CHoCH excuses nothing). This is the reads' agreement only: the gate judges its trend rule on its own tiers
  // (lifecycle-gate.js reversalAllowed).
  const rank = tf => TF_ORDER.indexOf(tf);
  const choch = Math.max(-1, ...checked.filter(r => r.kind === 'break' && r.check === true && r.dir === side && r.form
    && r.form.split(' ')[1] === 'choch' && ['15m', '1h'].includes(r.form.split(' ')[0])).map(r => rank(r.form.split(' ')[0])));
  for (const r of checked) {
    if (r.check !== true) continue;
    if (r.kind === 'stop' || r.kind === 'target') r.agrees = r.dir === side;
    else if (r.dir && r.dir !== side) {
      r.agrees = choch >= 0 && (r.kind === 'trend' || r.kind === 'break') && rank(r.form.split(' ')[0]) <= choch;
      if (r.agrees) r.reversal = true;
    }
  }
  const missingSteps = STEPS.filter(s => !checked.some(r => r.step === s));
  if (missingSteps.length) problems.push(`steps not stated: ${missingSteps.join(', ')} (every step needs a read, D7)`);
  for (const k of ['stop', 'target']) {
    const n = checked.filter(r => r.kind === k && r.step === k).length;
    if (n > 1) problems.push(`${n} ${k} reads: state exactly one`);
  }
  const stopRead = checked.find(r => r.kind === 'stop' && r.check === true);
  const targetRead = checked.find(r => r.kind === 'target' && r.check === true);
  const ok = !problems.length && checked.length > 0 && checked.every(r => r.check === true && r.agrees);
  const signed = checked.filter(r => STEPS.includes(r.step) && r.skill);
  return {
    ok, side, reference, reads: checked, problems, missingSteps,
    stop: stopRead ? { source: stopRead.slug, level: stopRead.price } : null,
    target: targetRead ? { source: targetRead.slug, level: targetRead.price } : null,
    signature: readSignature(signed, { reference }), skillSignature: skillSignature(signed),
    context: SIDES.includes(side) ? contextOf(briefing, side) : null,
  };
}

const WORD = { true: 'TRUE', false: 'FALSE', unchecked: 'UNCHECKED' };

/** The check as text: each read with the briefing's fact and its side agreement, then what stands. */
function renderCheck(r) {
  const out = [`Reads checked against the bar briefing (${r.side || 'no side'}):`];
  for (const x of r.reads) {
    const agree = x.check === true && !x.agrees ? ` - AGAINST the ${r.side}` : x.reversal ? ' - against, allowed by the verified CHoCH (D2)' : '';
    out.push(`- ${WORD[String(x.check)]} ${x.step} (${x.skill}): "${x.read}" - ${x.fact}${agree}`);
  }
  for (const p of r.problems) out.push(`- PROBLEM: ${p}`);
  out.push(r.ok ? `Every read is true and agrees with the ${r.side}. Signature: ${r.signature}`
    : 'The combination does not stand: fix or drop each read named above (a FALSE or UNCHECKED read, or one against the side), or pass.');
  return `${out.join('\n')}\n`;
}

module.exports = { STEPS, STEP_KINDS, ENTRY_PATTERNS, MAX_READS, WHY_MAX, MOMENTUM, VOLUME_HIGH, ABSORPTION, parseRead, checkRead, checkReads, readSignature, skillSignature, contextOf, targetROf, rBucket, levelName, renderCheck };
