'use strict';

/**
 * The trade-lifecycle reads checker (docs/COMPOSED-ENTRY.md section 3.2): the model's combination, stated as reads,
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
 *   regime <name>, day type <name>          m3.regime.primary, m3.today.dayType           none
 *   at <level>                              the level inside the trigger bar's range (m3.bar), or a completed
 *                                           candle's relation to it (m3.candles.<tf>.relations)   none
 *   <tf> rejected|broke <level> up|down     m3.candles.<tf>.relations (every relation, uncapped)   up long, down short
 *   <tf> touched <level>                    the same                                      none
 *   <tf> pattern <name>                     m3.candles.<tf>.patterns (or pattern)          engulfing by its colour,
 *                                                                                         displacement by its dir
 *   <tf> cisd up|down                       m3.cisd.<tf>.dir                              up long, down short
 *   [<tf>] in ote                           m3.cisd.<tf>.priceInOte (no tf: any timeframe)                      none
 *   swept <level>                           m3.sweeps (by name)                           none
 *   <tf> close top|middle|bottom            m3.candles.<tf>.closeLocation                 top long, bottom short
 *   <tf> momentum up|down                   D4's bar read on m3.candles.<tf>: rangeAtr >= 1, volRatio >= 1, close in
 *                                           the far third (top up, bottom down)            up long, down short
 *   stop <source> <price>                   step stop only: <tf> low|high (a completed candle), [<tf>] swing
 *                                           low|high (m3.swings, m3.liquidity, m3.htfLevels), or <level>; the
 *                                           source's price within one tick of <price>    below price long
 *   target <source> <price>                 step target only: <tf> swing [high|low] (m3.swingTargets), or <level>;
 *                                           within one tick                              above price long
 *
 * Each read is true, false or 'unchecked' (a form this checker doesn't know, a fact the briefing doesn't hold, a
 * level it doesn't name): never true unless the briefing says so. Side agreement (D12): a read with a direction must
 * be the order's side; a stop or target must be on its side of the reference price (m3.price). The one exception is
 * D2's verified reversal: when the combination also has a true 15m or 1h CHoCH the side's way, a trend read against
 * the side stands, and so does a break read against it on a lower timeframe than that CHoCH. The combination is ok when every read is true and agrees, every step is stated, and there
 * is exactly one stop and one target read.
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
const MAX_READS = 16;
const READ_MAX = 120;
const WHY_MAX = 160;
const SKILL = /^[a-z0-9][a-z0-9-]{0,63}$/;
// D4: the momentum bar read (range at least 1 ATR(14), volume at least the 20-bar average, close in the far third).
const MOMENTUM = { rangeAtr: 1, volRatio: 1 };
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
  if (a === 'regime' && w.length === 2) return out('regime', { value: b });
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

const within = (a, b, tick) => Math.abs(a - b) <= tick + 1e-9;

/** The prices a stop or target source names (a source the briefing doesn't hold: none). */
function sourcePrices(kind, source, b, base) {
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
  }
  return { field: 'the briefing\'s levels', prices: levelIndex(b).get(source) || [] };
}

/**
 * One parsed read checked against the briefing: { check: true | false | 'unchecked', fact, field, value, dir }. dir:
 * the side the read points to (null: none). A stop or target carries the briefing's price for it (`price`).
 */
function checkRead(p, b, { tick = 0.25 } = {}) {
  const res = (check, fact, extra = {}) => ({ check, fact, field: null, value: null, dir: null, ...extra });
  if (p.kind === 'ambiguous') return res(false, 'a negation, a bracket or a character outside plain ASCII: state each read plainly');
  if (p.kind === 'unknown') return res('unchecked', p.why || 'not a form this check knows (docs/COMPOSED-ENTRY.md section 3.2)');
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
      const prices = levelIndex(b).get(p.level) || [];
      const bar = isObj(m3.bar) ? m3.bar : {};
      const inBar = prices.filter(x => num(bar.l) !== null && num(bar.h) !== null && x >= bar.l && x <= bar.h);
      const met = Object.entries(isObj(m3.candles) ? m3.candles : {}).filter(([, c]) => isObj(c) && Array.isArray(c.relations)
        && c.relations.some(r => isObj(r) && levelName(r.name) === p.level)).map(([tf]) => tf);
      if (!prices.length && !met.length) return res('unchecked', `the briefing names no level "${p.level}"`);
      const ok = inBar.length > 0 || met.length > 0;
      const fact = ok ? `${p.level} ${inBar.length ? `${inBar[0]} is inside the bar's range ${bar.l}-${bar.h}` : `was met by the ${met.join(', ')} candle`}`
        : `${p.level} ${prices.join(', ')} is outside the bar's range ${bar.l}-${bar.h} and no completed candle met it`;
      return res(ok, fact, { field: 'm3.bar, m3.candles.<tf>.relations', value: prices[0] ?? null });
    }
    case 'relation': {
      const got = candleOf(p.tf);
      if (!got.c) return res('unchecked', got.why);
      if (!Array.isArray(got.c.relations)) return res('unchecked', `the ${p.tf} candle's level relations are not in the briefing`);
      const r = got.c.relations.find(x => isObj(x) && levelName(x.name) === p.level);
      const fact = r ? `the ${p.tf} candle ${r.rel}${r.dir ? ` ${r.dir}` : ''} ${r.name}` : `the ${p.tf} candle didn't meet ${p.level}`;
      return res(Boolean(r) && r.rel === p.rel && (r.dir || null) === p.value, fact,
        { field: `m3.candles.${p.tf}.relations`, value: r ? `${r.rel}${r.dir ? ` ${r.dir}` : ''}` : null, dir: dirSide(p.value) });
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
      return res(d === p.value, `the latest ${p.tf} CISD is ${x.dir} at ${x.level} (${x.status})`, { field: `m3.cisd.${p.tf}.dir`, value: d, dir: dirSide(p.value) });
    }
    case 'ote': {
      const all = Object.entries(isObj(m3.cisd) ? m3.cisd : {}).filter(([tf, x]) => isObj(x) && (!p.tf || tf === p.tf));
      if (!all.length) return res('unchecked', `no ${p.tf ? `${p.tf} ` : ''}CISD zone in the briefing`);
      const inIt = all.filter(([, x]) => x.priceInOte === true).map(([tf]) => tf);
      return res(inIt.length > 0, inIt.length ? `price is in the ${inIt.join(', ')} OTE zone` : 'price is in no OTE zone', { field: 'm3.cisd.<tf>.priceInOte', value: inIt.join(', ') || null });
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
      const { field, prices } = sourcePrices(p.kind, p.source, b, base);
      if (!prices.length) return res('unchecked', `the briefing has no ${p.source} for a ${p.kind}`, { field });
      const hit = prices.find(x => within(x, p.price, tick));
      if (hit === undefined) return res(false, `${p.source} is ${prices.join(', ')}, not ${p.price} (within one tick, ${tick})`, { field, value: prices[0] });
      const dir = ref === null || hit === ref ? null : (p.kind === 'stop') === (hit < ref) ? 'long' : 'short';
      return res(true, `${p.source} is ${hit}; price ${ref}`, { field, value: hit, price: hit, dir });
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
  const checked = list.slice(0, MAX_READS).map((r, i) => {
    const x = isObj(r) ? r : {};
    const step = typeof x.step === 'string' ? x.step.toLowerCase() : null;
    const skill = typeof x.skill === 'string' ? x.skill : null;
    const why = typeof x.why === 'string' ? x.why.slice(0, WHY_MAX) : null;
    const p = parseRead(x.read);
    const row = { step, skill, read: typeof x.read === 'string' ? x.read : null, why, kind: p.kind, form: p.form || null, slug: p.slug || null };
    const bad = msg => { problems.push(`read ${i + 1} ("${row.read}"): ${msg}`); return { ...row, check: false, fact: msg, field: null, value: null, dir: null, agrees: false }; };
    if (!STEPS.includes(step)) return bad(`step must be one of ${STEPS.join(', ')}`);
    if (!skill || !SKILL.test(skill)) return bad('skill must be a skill folder name');
    if (known && !known.has(skill)) return bad(`no skill named ${skill}`);
    if ((step === 'stop') !== (p.kind === 'stop') && (p.kind === 'stop' || step === 'stop')) return bad('a stop read is "stop <source> <price>", in the stop step only');
    if ((step === 'target') !== (p.kind === 'target') && (p.kind === 'target' || step === 'target')) return bad('a target read is "target <source> <price>", in the target step only');
    const c = checkRead(p, briefing, { tick });
    return { ...row, ...c, agrees: true };
  });
  // Side agreement (D12), with D2's verified reversal: a true 15m or 1h CHoCH the side's way lets a trend read against
  // the side stand, and a break read against it on a lower timeframe than that CHoCH.
  const rank = tf => TF_ORDER.indexOf(tf);
  const choch = Math.max(-1, ...checked.filter(r => r.kind === 'break' && r.check === true && r.dir === side && r.form
    && r.form.split(' ')[1] === 'choch' && ['15m', '1h'].includes(r.form.split(' ')[0])).map(r => rank(r.form.split(' ')[0])));
  for (const r of checked) {
    if (r.check !== true) continue;
    if (r.kind === 'stop' || r.kind === 'target') r.agrees = r.dir === side;
    else if (r.dir && r.dir !== side) {
      r.agrees = choch >= 0 && (r.kind === 'trend' || (r.kind === 'break' && rank(r.form.split(' ')[0]) < choch));
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

module.exports = { STEPS, MAX_READS, WHY_MAX, MOMENTUM, parseRead, checkRead, checkReads, readSignature, skillSignature, contextOf, targetROf, rBucket, levelName, renderCheck };
