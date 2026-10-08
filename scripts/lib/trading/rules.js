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
 *   ema(n) sma(n) atr(n) adx(n) highest(n) lowest(n)   n = 1..500
 *   supertrend supertrend_dir (1 up, -1 down)
 *   keltner_upper keltner_mid keltner_lower
 *   vwap_session vwap_rth or_high or_low swing_high swing_low
 *   prior_high prior_low prior_close   last completed RTH day (9:30-16:00 ET)
 *   overnight_high overnight_low       this Globex session before 9:30 ET, up to
 *                                      the previous bar (so a break can cross it)
 *   minute_et (minutes since midnight New York time at the bar's open, e.g. 9:45 = 585)
 * A value that doesn't exist yet (indicator warm-up, no opening range or
 * overnight yet, look-back before the first bar) makes its condition false;
 * the result marks it `missing` so a short bar history is visible.
 * Strategy `params` (orbMinutes, swingK, stPeriod, stMult, kcLen, kcMult,
 * kcAtr) tune the series that use them.
 */

const ind = require('./indicators');
const { zonedParts } = require('./clock');

const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const GLOBEX_OPEN = 18 * 60;

const OPS = ['crosses_above', 'crosses_below', '>=', '<=', '>', '<'];
const FUNCS = new Set(['ema', 'sma', 'atr', 'adx', 'highest', 'lowest']);
const NAMES = new Set([
  'open', 'high', 'low', 'close', 'volume', 'supertrend', 'supertrend_dir',
  'keltner_upper', 'keltner_mid', 'keltner_lower', 'vwap_session', 'vwap_rth',
  'or_high', 'or_low', 'swing_high', 'swing_low', 'prior_high', 'prior_low',
  'prior_close', 'overnight_high', 'overnight_low', 'minute_et',
]);
const MAX_RULES_PER_SIDE = 12;

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

/** Compile one condition string into { left, op, right, text }. Throws with a readable message. */
function compileCondition(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('a rule must be a non-empty string');
  try {
    const tokens = tokenize(text);
    const opIdx = tokens.findIndex(t => t.type === 'op');
    if (opIdx === -1) throw new Error(`needs a comparison (${OPS.join(', ')})`);
    if (tokens.slice(opIdx + 1).some(t => t.type === 'op')) throw new Error('only one comparison per rule');
    return { left: parseExpr(tokens.slice(0, opIdx)), op: tokens[opIdx].value, right: parseExpr(tokens.slice(opIdx + 1)), text };
  } catch (err) {
    throw new Error(`"${text}": ${err.message}`, { cause: err });
  }
}

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
    for (const text of list) {
      try {
        compiled[side].push(compileCondition(text));
      } catch (err) {
        errors.push(`rules.${side}: ${err.message}`);
      }
    }
  }
  if (!compiled.long.length && !compiled.short.length && !errors.length) errors.push('rules: define long and/or short conditions');
  return { compiled, errors };
}

/**
 * Prior-RTH and overnight levels as they stood at each bar, so a rule
 * evaluated on bar i never sees later bars. Overnight excludes bar i itself.
 */
function causalLevels(bars) {
  const n = bars.length;
  const out = {
    prior_high: new Array(n).fill(NaN), prior_low: new Array(n).fill(NaN), prior_close: new Array(n).fill(NaN),
    overnight_high: new Array(n).fill(NaN), overnight_low: new Array(n).fill(NaN),
  };
  let rthDay = null; // RTH day in progress
  let rth = null;
  let prior = null; // last completed RTH day
  let onSession = null;
  let onHigh = NaN;
  let onLow = NaN;
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    const p = zonedParts(new Date(b.t), 'America/New_York');
    const day = `${p.year}-${p.month}-${p.day}`;
    const minute = p.hour * 60 + p.minute;
    const session = ind.sessionKey(b.t, GLOBEX_OPEN);
    if (rth && (day !== rthDay || minute >= RTH_CLOSE)) { prior = rth; rth = null; rthDay = null; }
    if (session !== onSession) { onSession = session; onHigh = NaN; onLow = NaN; }
    if (prior) { out.prior_high[i] = prior.high; out.prior_low[i] = prior.low; out.prior_close[i] = prior.close; }
    out.overnight_high[i] = onHigh;
    out.overnight_low[i] = onLow;
    if (minute >= RTH_OPEN && minute < RTH_CLOSE) {
      if (!rth) { rth = { high: b.h, low: b.l, close: b.c }; rthDay = day; }
      rth.high = Math.max(rth.high, b.h); rth.low = Math.min(rth.low, b.l); rth.close = b.c;
    } else if (!(minute >= RTH_CLOSE && minute < GLOBEX_OPEN)) {
      onHigh = Number.isNaN(onHigh) ? b.h : Math.max(onHigh, b.h);
      onLow = Number.isNaN(onLow) ? b.l : Math.min(onLow, b.l);
    }
  }
  return out;
}

/** Lazily computed series over normalized bars; values are aligned to bars, NaN in warm-up. */
function seriesSource(bars, params) {
  const cache = new Map();
  let lv = null;
  const level = k => { lv = lv || causalLevels(bars); return lv[k]; };
  const field = f => bars.map(b => b[f]);
  const rolling = (vals, len, fn) => vals.map((_, i) => (i + 1 < len ? NaN : fn(vals.slice(i + 1 - len, i + 1))));
  const make = key => {
    const fn = /^([a-z]+)\((\d+)\)$/.exec(key);
    if (fn) {
      const len = Number(fn[2]);
      switch (fn[1]) {
        case 'ema': return ind.ema(field('c'), len).map((v, i) => (i + 1 < len ? NaN : v));
        case 'sma': return rolling(field('c'), len, w => w.reduce((a, b) => a + b, 0) / len);
        case 'atr': return ind.atr(bars, len);
        case 'adx': return ind.adx(bars, len);
        case 'highest': return rolling(field('h'), len, w => Math.max(...w));
        case 'lowest': return rolling(field('l'), len, w => Math.min(...w));
        default: break;
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
      case 'or_high': return ind.openingRange(bars, params.orbMinutes).high;
      case 'or_low': return ind.openingRange(bars, params.orbMinutes).low;
      case 'swing_high': return ind.swings(bars, params.swingK).high;
      case 'swing_low': return ind.swings(bars, params.swingK).low;
      case 'prior_high': case 'prior_low': case 'prior_close':
      case 'overnight_high': case 'overnight_low': return level(key);
      case 'minute_et': return bars.map(b => {
        const p = zonedParts(new Date(b.t), 'America/New_York');
        return p.hour * 60 + p.minute;
      });
      default: throw new Error(`unknown series "${key}"`);
    }
  };
  return key => {
    if (!cache.has(key)) cache.set(key, make(key));
    return cache.get(key);
  };
}

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
function evaluateRules(compiled, bars, params) {
  const get = seriesSource(bars, params);
  const i = bars.length - 1;
  const missing = c => [c.left, c.right].some(e => valueAt(e, get, i) === null)
    || (c.op.startsWith('crosses_') && [c.left, c.right].some(e => valueAt(e, get, i - 1) === null));
  const side = conds => conds.map(c => {
    const ok = holds(c, get, i);
    return ok || !missing(c) ? { rule: c.text, ok } : { rule: c.text, ok, missing: true };
  });
  const long = side(compiled.long);
  const short = side(compiled.short);
  const longFires = long.length > 0 && long.every(r => r.ok);
  const shortFires = short.length > 0 && short.every(r => r.ok);
  return { direction: longFires && !shortFires ? 'long' : shortFires && !longFires ? 'short' : null, long, short };
}

module.exports = { OPS, FUNCS, NAMES, MAX_RULES_PER_SIDE, compileCondition, compileRules, evaluateRules, seriesSource, causalLevels };
