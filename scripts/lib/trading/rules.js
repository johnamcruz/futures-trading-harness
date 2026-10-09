'use strict';

/**
 * Declarative trigger rules for STRATEGY.md, so a mechanical strategy is
 * written in Markdown instead of code:
 *
 *   signal: rules
 *   rules:
 *     long:
 *       - close crosses_above or_high
 *       - adx(14) >= 18
 *     short:
 *       - close crosses_below or_low
 *       - adx(14) >= 18
 *
 * Every condition in a side must hold on the last closed bar (AND). A side
 * whose conditions all hold fires that direction; if both fire, nothing fires.
 * An item can also be a group: `any: [...]` holds when one of its items does
 * (OR), `all: [...]` when every one does; groups nest three deep:
 *
 *       - any:                                  # a setup: rejection or breakout
 *           - all: [low <= prior_poc, close > prior_poc, close[1] > prior_poc]
 *           - close crosses_above prior_poc
 *       - any: [ofi(3) >= 0.2, high - low >= 1.5 * atr(20)]   # confirmed by flow or expansion
 *
 * Condition:  <expr> <op> <expr>
 *   op:       >  >=  <  <=  crosses_above  crosses_below
 *             (crosses_* compare the previous bar with the last bar)
 * Expression: terms joined by + or -, each term a factor optionally
 *             multiplied by a number:  close,  vwap_rth + 0.5 * atr(14),  21500
 *             A series may look back n bars with [n]: highest(20)[1] is the
 *             20-bar high as of the previous bar (n = 0..500).
 * Series (value at each bar):
 *   open high low close volume
 *   ema(n) sma(n) atr(n) adx(n) highest(n) lowest(n)   n = 1..500 (adx 1..250)
 *   ofi(n)      order-flow imbalance over n bars, -1 (selling) .. +1 (buying):
 *               each bar's volume signed by where it closed in its range
 *   delta(n)    that signed volume summed over n bars (contracts)
 *   vol_sma(n)  average volume per bar over n bars
 *   supertrend supertrend_dir (1 up, -1 down)
 *   keltner_upper keltner_mid keltner_lower
 *   vwap_session vwap_rth or_high or_low swing_high swing_low
 *   prior_high prior_low prior_close   last completed RTH day (9:30-16:00 ET)
 *   rth_open    today's 09:30 ET open, from that bar until 16:00 ET
 *   rth_high rth_low   today's RTH high and low so far, this bar included
 *   overnight_high overnight_low       this Globex session before 9:30 ET, up to
 *                                      the previous bar (so a break can cross it)
 *   minute_et (minutes since midnight New York time at the bar's open, e.g. 9:45 = 585)
 *   cisd_ote_dir  1 / -1 on a bar where a CISD + OTE zone entry fires (algoTraderBot's
 *                 cisd_ote detector on the trailing window), else 0
 *   cisd_ote_risk that entry's stop distance (to the zone pivot), for risk.stop
 *   htf_open(m) htf_high(m) htf_low(m) htf_close(m)
 *               the previous m-minute candle (m divides a day: 60 = 1 hour,
 *               240 = 4 hours), candles aligned to the 18:00 ET open (4 hours:
 *               18, 22, 02, 06, 10, 14 ET); it changes when a new candle opens
 *   htfc_open(m) htfc_high(m) htfc_low(m)
 *               the m-minute candle in progress, up to and including this bar
 *               (htfc_low(60) < htf_low(60): this hour swept the last hour's low)
 *   crt_dir(m)  1 / -1 on the bar a Candle Range Theory sweep of the previous
 *               m-minute candle confirms (scripts/lib/trading/crt.js), else 0;
 *               one per candle
 *   crt_risk(m) that setup's stop distance (to the sweep extreme plus a buffer)
 *   crt_target(m) its distance to the far side of the previous candle (the CRT target)
 *   mtf_bias(m) the m-minute trend as of the last m-minute candle completed
 *               before this bar: 1 up, -1 down, 0 range (scripts/lib/trading/mtf.js:
 *               close vs EMA20, EMA20 vs EMA50, swing structure; two of three).
 *               mtf_bias(240) >= 0 keeps a long out of a 4-hour downtrend
 *   Volume profile (scripts/lib/trading/volume-profile.js; bar-based, each value
 *   from bars closed by this bar):
 *   prior_poc prior_vah prior_val   the last complete RTH day's point of control
 *                                   and value area (fixed for the day)
 *   session_poc session_vah session_val   the Globex session's (from 18:00 ET), developing
 *   vp_poc(n) vp_vah(n) vp_val(n)   the last n bars' (a rolling profile)
 *   prior_hvn_above prior_hvn_below prior_lvn_above prior_lvn_below
 *   session_hvn_above ... hvn_above(n) hvn_below(n) lvn_above(n) lvn_below(n)
 *               the nearest high / low volume node above or below the close;
 *               for targets and distances (they move when price passes a node,
 *               so don't cross them). Params vpRows, vpRowSize, vpValueArea,
 *               vpNodePct, vpTroughPct, vpThreshold tune the profile.
 * A value that doesn't exist yet (indicator warm-up, no opening range or
 * overnight yet, look-back before the first bar) makes its condition false;
 * the result marks it `missing` so a short bar history is visible.
 * Strategy `params` (orbMinutes, swingK, stPeriod, stMult, kcLen, kcMult,
 * kcAtr, and crtSweepBars, crtShiftBars, crtMaxDepth, crtMinRangeAtr,
 * crtBufferAtr, crtMinRR for crt_*) tune the series that use them.
 */

const ind = require('./indicators');
const cisd = require('./cisd-ote');
const crt = require('./crt');
const mtf = require('./mtf');
const { zonedParts } = require('./clock');
const vp = require('./volume-profile');

const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const GLOBEX_OPEN = 18 * 60;

const OPS = ['crosses_above', 'crosses_below', '>=', '<=', '>', '<'];
const HTF = new Set(['htf_open', 'htf_high', 'htf_low', 'htf_close', 'htfc_open', 'htfc_high', 'htfc_low', 'crt_dir', 'crt_risk', 'crt_target', 'mtf_bias']);
// Volume profile fields: levels, and the nearest node above/below the close.
const VP_LEVELS = ['poc', 'vah', 'val'];
const VP_NODES = ['hvn_above', 'hvn_below', 'lvn_above', 'lvn_below'];
const VP_FUNCS = [...VP_LEVELS.map(f => `vp_${f}`), ...VP_NODES];
const VP_NAMES = ['prior', 'session'].flatMap(w => [...VP_LEVELS, ...VP_NODES].map(f => `${w}_${f}`));
const FUNCS = new Set(['ema', 'sma', 'atr', 'adx', 'highest', 'lowest', 'ofi', 'delta', 'vol_sma', ...HTF, ...VP_FUNCS]);
const NAMES = new Set([
  'open', 'high', 'low', 'close', 'volume', 'supertrend', 'supertrend_dir',
  'keltner_upper', 'keltner_mid', 'keltner_lower', 'vwap_session', 'vwap_rth',
  'or_high', 'or_low', 'swing_high', 'swing_low', 'prior_high', 'prior_low',
  'prior_close', 'overnight_high', 'overnight_low', 'rth_open', 'rth_high', 'rth_low', 'minute_et',
  'cisd_ote_dir', 'cisd_ote_risk', ...VP_NAMES,
]);
const MAX_RULES_PER_SIDE = 12;
const MAX_GROUP_ITEMS = 8;
const MAX_GROUP_DEPTH = 3;
const MAX_CONDITIONS_PER_SIDE = 24;

function tokenize(text) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([a-z_][a-z0-9_]*)\s*\(\s*(\d+)\s*\)(?:\[(\d+)\])?|([a-z_][a-z0-9_]*)(?:\[(\d+)\])?|(>=|<=|>|<)|([+\-*]))/gy;
  let pos = 0;
  const src = String(text).trim();
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m.index !== pos) throw new Error(`cannot read "${src.slice(pos)}"`);
    pos = re.lastIndex;
    if (m[1]) tokens.push({ type: 'num', value: Number(m[1]) });
    else if (m[2]) tokens.push({ type: 'func', name: m[2], arg: Number(m[3]), shift: Number(m[4] || 0) });
    else if (m[5]) {
      if (OPS.includes(m[5]) && m[6] === undefined) tokens.push({ type: 'op', value: m[5] });
      else tokens.push({ type: 'name', name: m[5], shift: Number(m[6] || 0) });
    } else if (m[7]) tokens.push({ type: 'op', value: m[7] });
    else tokens.push({ type: 'arith', value: m[8] });
  }
  return tokens;
}

function parseFactor(tok) {
  if (!tok) throw new Error('expected a value');
  if (tok.type === 'num') return { kind: 'num', value: tok.value };
  if (tok.shift > 500) throw new Error(`[${tok.shift}]: look-back must be 0-500`);
  if (tok.type === 'name') {
    if (!NAMES.has(tok.name)) throw new Error(`unknown series "${tok.name}"`);
    return { kind: 'series', key: tok.name, shift: tok.shift };
  }
  if (tok.type === 'func') {
    if (!FUNCS.has(tok.name)) throw new Error(`unknown function "${tok.name}(...)"`);
    if (!(tok.arg >= 1 && tok.arg <= 500)) throw new Error(`${tok.name}(${tok.arg}): length must be 1-500`);
    // ADX needs 2n bars; keep it inside the 500-bar look-back.
    if (tok.name === 'adx' && tok.arg > 250) throw new Error(`adx(${tok.arg}): length must be 1-250 (ADX needs 2n bars; look-backs stop at 500)`);
    if (HTF.has(tok.name) && 1440 % tok.arg !== 0) throw new Error(`${tok.name}(${tok.arg}): minutes must divide a day (e.g. 60, 120, 240)`);
    return { kind: 'series', key: `${tok.name}(${tok.arg})`, shift: tok.shift };
  }
  throw new Error(`unexpected "${tok.value}"`);
}

/** expr := term (('+'|'-') term)* ; term := factor ('*' factor)? */
function parseExpr(tokens) {
  const terms = [];
  let i = 0;
  let sign = 1;
  if (tokens[0] && tokens[0].type === 'arith' && tokens[0].value === '-') {
    sign = -1;
    i = 1;
  }
  while (i < tokens.length) {
    const factor = parseFactor(tokens[i]);
    i += 1;
    let term = { sign, factors: [factor] };
    if (tokens[i] && tokens[i].type === 'arith' && tokens[i].value === '*') {
      term = { sign, factors: [factor, parseFactor(tokens[i + 1])] };
      if (term.factors.filter(f => f.kind === 'series').length > 1) throw new Error('multiply a series by a number, not by another series');
      i += 2;
    }
    terms.push(term);
    if (i >= tokens.length) break;
    if (tokens[i].type !== 'arith' || tokens[i].value === '*') throw new Error(`unexpected "${tokens[i].value || tokens[i].name}"`);
    sign = tokens[i].value === '-' ? -1 : 1;
    i += 1;
    if (i >= tokens.length) throw new Error('expression ends with an operator');
  }
  if (terms.length === 0) throw new Error('empty expression');
  return terms;
}

/** Compile an expression (e.g. a stop distance: "0.5 * atr(20)"). Throws with a readable message. */
function compileExpression(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('an expression must be a non-empty string');
  try {
    const tokens = tokenize(text);
    if (tokens.some(t => t.type === 'op')) throw new Error('an expression has no comparison');
    return parseExpr(tokens);
  } catch (err) {
    throw new Error(`"${text}": ${err.message}`, { cause: err });
  }
}

/** Compile one condition string into { left, op, right, text }. Throws with a readable message. */
function compileCondition(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('a rule must be a non-empty string');
  try {
    const tokens = tokenize(text);
    const opIdx = tokens.findIndex(t => t.type === 'op');
    if (opIdx === -1) throw new Error(`needs a comparison (${OPS.join(', ')})`);
    if (tokens.slice(opIdx + 1).some(t => t.type === 'op')) throw new Error('only one comparison per rule');
    const cond = { left: parseExpr(tokens.slice(0, opIdx)), op: tokens[opIdx].value, right: parseExpr(tokens.slice(opIdx + 1)), text };
    // The nearest node above/below the close moves whenever price passes one: a cross of it is meaningless.
    const node = [...cond.left, ...cond.right].flatMap(t => t.factors).find(f => f.kind === 'series' && /(hvn|lvn)_(above|below)/.test(f.key));
    if (node && cond.op.startsWith('crosses_')) throw new Error(`${node.key} moves as price passes a node; compare it (>, <), don't cross it`);
    return cond;
  } catch (err) {
    throw new Error(`"${text}": ${err.message}`, { cause: err });
  }
}

/** Compile a rule item: a condition string, or { any: [items] } / { all: [items] } (nested up to MAX_GROUP_DEPTH). */
function compileItem(item, depth = 0) {
  if (typeof item === 'string') return compileCondition(item);
  const keys = item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : [];
  if (keys.length !== 1 || !['any', 'all'].includes(keys[0])) throw new Error(`${JSON.stringify(item)}: a condition, or a group { any: [...] } or { all: [...] }`);
  const group = keys[0];
  const list = item[group];
  if (depth >= MAX_GROUP_DEPTH) throw new Error(`${group}: groups nest at most ${MAX_GROUP_DEPTH} deep`);
  if (!Array.isArray(list) || list.length < 2 || list.length > MAX_GROUP_ITEMS) throw new Error(`${group}: a list of 2 to ${MAX_GROUP_ITEMS} items`);
  const items = list.map(x => compileItem(x, depth + 1));
  return { group, items, text: `${group}(${items.map(x => x.text).join(group === 'any' ? ' | ' : ' & ')})` };
}

const leaves = item => (item.group ? item.items.reduce((n, x) => n + leaves(x), 0) : 1);

/** Validate a `rules` frontmatter block. Returns { compiled, errors }. */
function compileRules(rules) {
  const errors = [];
  const compiled = { long: [], short: [] };
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    return { compiled, errors: ['rules: a map with long and/or short lists of conditions'] };
  }
  for (const key of Object.keys(rules)) if (!['long', 'short'].includes(key)) errors.push(`rules.${key}: only long and short are allowed`);
  for (const side of ['long', 'short']) {
    const list = rules[side];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`rules.${side}: a non-empty list of conditions`);
      continue;
    }
    if (list.length > MAX_RULES_PER_SIDE) errors.push(`rules.${side}: at most ${MAX_RULES_PER_SIDE} conditions`);
    for (const item of list) {
      try {
        compiled[side].push(compileItem(item));
      } catch (err) {
        errors.push(`rules.${side}: ${err.message}`);
      }
    }
    const n = compiled[side].reduce((a, x) => a + leaves(x), 0);
    if (n > MAX_CONDITIONS_PER_SIDE) errors.push(`rules.${side}: at most ${MAX_CONDITIONS_PER_SIDE} conditions in all, groups included`);
  }
  if (!compiled.long.length && !compiled.short.length && !errors.length) errors.push('rules: define long and/or short conditions');
  return { compiled, errors };
}

/**
 * Prior-RTH and overnight levels as they stood at each bar, so a rule
 * evaluated on bar i never sees later bars. Overnight excludes bar i itself.
 * A session the bars start in the middle of is partial: its levels are
 * missing (the scan's bars often start mid-session), never wrong.
 */
function causalLevels(bars) {
  const n = bars.length;
  const out = {
    prior_high: new Array(n).fill(NaN), prior_low: new Array(n).fill(NaN), prior_close: new Array(n).fill(NaN),
    overnight_high: new Array(n).fill(NaN), overnight_low: new Array(n).fill(NaN), rth_open: new Array(n).fill(NaN),
    rth_high: new Array(n).fill(NaN), rth_low: new Array(n).fill(NaN),
  };
  let rthDay = null; // RTH day in progress
  let rth = null;
  let prior = null; // last completed RTH day
  let onSession = null;
  let onHigh = NaN;
  let onLow = NaN;
  let onComplete = false;
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    const p = zonedParts(new Date(b.t), 'America/New_York');
    const day = `${p.year}-${p.month}-${p.day}`;
    const minute = p.hour * 60 + p.minute;
    const session = ind.sessionKey(b.t, GLOBEX_OPEN);
    if (rth && (day !== rthDay || minute >= RTH_CLOSE)) { prior = rth.complete ? rth : null; rth = null; rthDay = null; }
    if (session !== onSession) { onSession = session; onHigh = NaN; onLow = NaN; onComplete = i > 0; }
    if (prior) { out.prior_high[i] = prior.high; out.prior_low[i] = prior.low; out.prior_close[i] = prior.close; }
    if (onComplete) { out.overnight_high[i] = onHigh; out.overnight_low[i] = onLow; }
    if (minute >= RTH_OPEN && minute < RTH_CLOSE) {
      // Complete only when the bars before it were seen (not cut off mid-session).
      if (!rth) { rth = { open: b.o, high: b.h, low: b.l, close: b.c, complete: i > 0 }; rthDay = day; }
      rth.high = Math.max(rth.high, b.h); rth.low = Math.min(rth.low, b.l); rth.close = b.c;
      if (rth.complete) { out.rth_open[i] = rth.open; out.rth_high[i] = rth.high; out.rth_low[i] = rth.low; }
    } else if (!(minute >= RTH_CLOSE && minute < GLOBEX_OPEN)) {
      onHigh = Number.isNaN(onHigh) ? b.h : Math.max(onHigh, b.h);
      onLow = Number.isNaN(onLow) ? b.l : Math.min(onLow, b.l);
    }
  }
  return out;
}

/** Lazily computed series over normalized bars; values are aligned to bars, NaN in warm-up. */
function seriesSource(bars, params, { window = 500 } = {}) {
  const cache = new Map();
  // algoTraderBot's cisd_ote detector, run on the trailing window at every bar.
  const cisdSeries = () => {
    const atr = ind.atr(bars, params.atrStop || 20);
    const withMs = bars.map(b => ({ ...b, ms: Date.parse(b.t) }));
    const dir = new Array(n).fill(0);
    const risk = new Array(n).fill(NaN);
    const info = new Array(n).fill(null);
    for (let i = 0; i < n; i += 1) {
      const from = Math.max(0, i - window + 1);
      const sig = cisd.detect(withMs.slice(from, i + 1), atr.slice(from, i + 1));
      if (sig) { dir[i] = sig.direction === 'long' ? 1 : -1; risk[i] = sig.risk; info[i] = { direction: sig.direction, entry: sig.entry, stop: sig.stop, hadSweep: sig.hadSweep, disp: sig.disp }; }
    }
    cache.set('cisd_ote_dir', dir);
    cache.set('cisd_ote_risk', risk);
    cache.set('cisd_ote_info', info);
  };
  const n = bars.length;
  let lv = null;
  const level = k => { lv = lv || causalLevels(bars); return lv[k]; };
  const field = f => bars.map(b => b[f]);
  const htfs = new Map();
  const htf = m => { if (!htfs.has(m)) htfs.set(m, ind.htfCandles(bars, m)); return htfs.get(m); };
  const crts = new Map();
  const crtOf = m => {
    if (!crts.has(m)) {
      crts.set(m, crt.crtSeries(bars, m, ind.atr(bars, params.atrStop || 20), {
        sweepBars: params.crtSweepBars, shiftBars: params.crtShiftBars, maxDepth: params.crtMaxDepth,
        minRangeAtr: params.crtMinRangeAtr, bufferAtr: params.crtBufferAtr, minRR: params.crtMinRR,
      }));
    }
    return crts.get(m);
  };
  const profiles = new Map();
  const profileOf = (kind, length = 0) => {
    const key = `${kind}:${length}`;
    if (!profiles.has(key)) profiles.set(key, vp.profileSeries(bars, kind === 'prior' ? 'prior_rth' : kind, { length, options: vp.optionsFromParams(params) }));
    return profiles.get(key);
  };
  const rolling = (vals, len, fn) => vals.map((_, i) => (i + 1 < len ? NaN : fn(vals.slice(i + 1 - len, i + 1))));
  const make = key => {
    const fn = /^([a-z_]+)\((\d+)\)$/.exec(key);
    if (fn) {
      const len = Number(fn[2]);
      switch (fn[1]) {
        case 'ema': return ind.ema(field('c'), len).map((v, i) => (i + 1 < len ? NaN : v));
        case 'sma': return rolling(field('c'), len, w => w.reduce((a, b) => a + b, 0) / len);
        case 'atr': return ind.atr(bars, len);
        case 'adx': return ind.adx(bars, len);
        case 'highest': return rolling(field('h'), len, w => Math.max(...w));
        case 'lowest': return rolling(field('l'), len, w => Math.min(...w));
        case 'ofi': return ind.ofi(bars, len);
        case 'delta': return rolling(ind.barDelta(bars), len, w => w.reduce((a, b) => a + b, 0));
        // No volume at all (a file without a volume column) is unknown, not 0.
        case 'vol_sma': return rolling(field('v'), len, w => { const t = w.reduce((a, b) => a + (Number(b) || 0), 0); return t > 0 ? t / len : NaN; });
        case 'htf_open': return htf(len).prevO;
        case 'htf_high': return htf(len).prevH;
        case 'htf_low': return htf(len).prevL;
        case 'htf_close': return htf(len).prevC;
        case 'htfc_open': return htf(len).curO;
        case 'htfc_high': return htf(len).curH;
        case 'htfc_low': return htf(len).curL;
        case 'crt_dir': return crtOf(len).dir;
        case 'crt_risk': return crtOf(len).risk;
        case 'crt_target': return crtOf(len).target;
        case 'mtf_bias': return mtf.biasSeries(bars, len);
        default:
          if (VP_FUNCS.includes(fn[1])) return profileOf('rolling', len)[fn[1].replace(/^vp_/, '')];
          break;
      }
    }
    switch (key) {
      case 'open': return field('o');
      case 'high': return field('h');
      case 'low': return field('l');
      case 'close': return field('c');
      case 'volume': return field('v');
      case 'supertrend': return ind.supertrend(bars, params.stPeriod, params.stMult).line;
      case 'supertrend_dir': return ind.supertrend(bars, params.stPeriod, params.stMult).direction;
      case 'keltner_upper': return ind.keltner(bars, params.kcLen, params.kcMult, params.kcAtr).upper;
      case 'keltner_mid': return ind.keltner(bars, params.kcLen, params.kcMult, params.kcAtr).mid;
      case 'keltner_lower': return ind.keltner(bars, params.kcLen, params.kcMult, params.kcAtr).lower;
      case 'vwap_session': return ind.anchoredVwap(bars, 18 * 60);
      case 'vwap_rth': return ind.anchoredVwap(bars, 9 * 60 + 30, 16 * 60);
      case 'or_high': return completeRange(ind.openingRange(bars, params.orbMinutes).high, 'h');
      case 'or_low': return completeRange(ind.openingRange(bars, params.orbMinutes).low, 'l');
      case 'swing_high': return ind.swings(bars, params.swingK).high;
      case 'swing_low': return ind.swings(bars, params.swingK).low;
      case 'prior_high': case 'prior_low': case 'prior_close':
      case 'overnight_high': case 'overnight_low': case 'rth_open': case 'rth_high': case 'rth_low': return level(key);
      case 'cisd_ote_dir': case 'cisd_ote_risk': cisdSeries(); return cache.get(key);
      case 'minute_et': return bars.map(b => {
        const p = zonedParts(new Date(b.t), 'America/New_York');
        return p.hour * 60 + p.minute;
      });
      default: {
        const w = /^(prior|session)_(.+)$/.exec(key);
        if (w && VP_NAMES.includes(key)) return profileOf(w[1])[w[2]];
        throw new Error(`unknown series "${key}"`);
      }
    }
  };
  // The range is known when its last bar closes: give that bar the value too,
  // so a break on the very next bar is a cross. Causal: the bar whose close
  // reaches the range's end gets the range of the bars up to and including
  // it, without looking at the next bar (live, there is none yet).
  const completeRange = (s, side) => {
    const out = s.slice();
    let step = Infinity;
    for (let i = 1; i < n; i += 1) {
      const d = Date.parse(bars[i].t) - Date.parse(bars[i - 1].t);
      if (d > 0 && d < step) step = d;
    }
    const stepMin = Number.isFinite(step) ? step / 60000 : 1;
    const open = 9 * 60 + 30;
    const end = open + params.orbMinutes;
    let day = null;
    let acc = NaN;
    let whole = false;
    for (let i = 0; i < n; i += 1) {
      const p = zonedParts(new Date(bars[i].t), 'America/New_York');
      const minute = p.hour * 60 + p.minute;
      if (etDay(i) !== day) { day = etDay(i); acc = NaN; whole = false; }
      if (minute < open || minute >= end) continue;
      if (minute === open) whole = true; // the range's first bar is in the data
      acc = Number.isNaN(acc) ? bars[i][side] : side === 'h' ? Math.max(acc, bars[i][side]) : Math.min(acc, bars[i][side]);
      if (whole && minute + stepMin >= end) out[i] = acc;
    }
    return out;
  };
  const days = new Array(n);
  const etDay = i => {
    if (days[i] === undefined) {
      const p = zonedParts(new Date(bars[i].t), 'America/New_York');
      days[i] = `${p.year}-${p.month}-${p.day}`;
    }
    return days[i];
  };
  const get = key => {
    if (!cache.has(key)) cache.set(key, make(key));
    return cache.get(key);
  };
  /** What each detector this source has run says about bar i ({ 'crt(60)': {...} }), for logs and scan output. */
  get.explain = i => {
    const out = {};
    for (const [m, c] of crts) { const x = c.explain(i); if (x) out[`crt(${m})`] = x; }
    if (cache.has('cisd_ote_info') && cache.get('cisd_ote_info')[i]) out.cisd_ote = cache.get('cisd_ote_info')[i];
    return out;
  };
  /** True when a level series starts over between bars i-1 and i (a jump, not a price cross). */
  get.resets = (key, i) => {
    if (i < 1) return false;
    if (key === 'vwap_session') return ind.sessionKey(bars[i].t, GLOBEX_OPEN) !== ind.sessionKey(bars[i - 1].t, GLOBEX_OPEN);
    // A developing profile level (session_poc, vp_vah(n), ...) that moves jumps past price: a cross
    // counts only through a level that stayed put.
    if (/^session_(poc|vah|val)$/.test(key) || /^vp_(poc|vah|val)\(\d+\)$/.test(key)) {
      const s = get(key);
      return ind.sessionKey(bars[i].t, GLOBEX_OPEN) !== ind.sessionKey(bars[i - 1].t, GLOBEX_OPEN) || !(s[i - 1] === s[i]);
    }
    // A higher-timeframe candle level starts over when a new candle opens.
    const h = /^(htfc?_[a-z]+)\((\d+)\)$/.exec(key);
    if (h && HTF.has(h[1]) && !h[1].startsWith('crt_') && h[1] !== 'mtf_bias') { const k = htf(Number(h[2])).key; return k[i] !== k[i - 1]; }
    if (LEVELS.has(key)) {
      const s = get(key);
      return Number.isFinite(s[i - 1]) && Number.isFinite(s[i]) && s[i - 1] !== s[i];
    }
    return false;
  };
  return get;
}

const LEVELS = new Set(['prior_high', 'prior_low', 'prior_close', 'or_high', 'or_low', 'rth_open', 'prior_poc', 'prior_vah', 'prior_val']);

function valueAt(terms, get, i) {
  let total = 0;
  for (const term of terms) {
    let v = 1;
    for (const f of term.factors) {
      const j = i - (f.shift || 0);
      v *= f.kind === 'num' ? f.value : j >= 0 ? get(f.key)[j] : NaN;
    }
    total += term.sign * v;
  }
  return Number.isFinite(total) ? total : null;
}

function holds(cond, get, i) {
  const r1 = valueAt(cond.right, get, i);
  const l1 = valueAt(cond.left, get, i);
  if (l1 === null || r1 === null) return false;
  switch (cond.op) {
    case '>': return l1 > r1;
    case '>=': return l1 >= r1;
    case '<': return l1 < r1;
    case '<=': return l1 <= r1;
    default: {
      if (i < 1) return false;
      // A level that starts over (session VWAP at 18:00 ET, a new prior day or
      // opening range) jumps past price; that is not a cross.
      const series = [...cond.left, ...cond.right].flatMap(t => t.factors).filter(f => f.kind === 'series');
      if (get.resets && series.some(f => get.resets(f.key, i - (f.shift || 0)))) return false;
      const l0 = valueAt(cond.left, get, i - 1);
      const r0 = valueAt(cond.right, get, i - 1);
      if (l0 === null || r0 === null) return false;
      return cond.op === 'crosses_above' ? l0 <= r0 && l1 > r1 : l0 >= r0 && l1 < r1;
    }
  }
}

/**
 * Evaluate compiled rules on the last bar. Returns { direction, long, short }
 * where long/short list each condition with its result (for explanations).
 */
function evaluateRules(compiled, bars, params, { index = bars.length - 1, get: source = null } = {}) {
  const get = source || seriesSource(bars, params);
  const i = index;
  const missing = c => [c.left, c.right].some(e => valueAt(e, get, i) === null)
    || (c.op.startsWith('crosses_') && [c.left, c.right].some(e => valueAt(e, get, i - 1) === null));
  // A group reports each of its items too, so a scan shows which branch held.
  const result = c => {
    if (c.group) {
      const parts = c.items.map(result);
      const ok = c.group === 'any' ? parts.some(x => x.ok) : parts.every(x => x.ok);
      // Failing with a part that has no value yet: say so, as for a single condition.
      return !ok && parts.some(x => x.missing) ? { rule: c.text, ok, missing: true, parts } : { rule: c.text, ok, parts };
    }
    const ok = holds(c, get, i);
    return ok || !missing(c) ? { rule: c.text, ok } : { rule: c.text, ok, missing: true };
  };
  const side = conds => conds.map(result);
  const long = side(compiled.long);
  const short = side(compiled.short);
  const longFires = long.length > 0 && long.every(r => r.ok);
  const shortFires = short.length > 0 && short.every(r => r.ok);
  return { direction: longFires && !shortFires ? 'long' : shortFires && !longFires ? 'short' : null, long, short };
}

module.exports = { OPS, FUNCS, NAMES, MAX_RULES_PER_SIDE, compileCondition, compileItem, compileExpression, valueAt, compileRules, evaluateRules, seriesSource, causalLevels };
