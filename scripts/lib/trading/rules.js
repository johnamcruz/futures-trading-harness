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
 *       - any: [volume >= 2 * vol_sma(20), high - low >= 1.5 * atr(20)]   # confirmed by volume or expansion
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
 *   vol_sma(n)  average volume per bar over n bars
 *   supertrend supertrend_dir (1 up, -1 down)
 *   keltner_upper keltner_mid keltner_lower
 *   vwap_session vwap_rth or_high or_low swing_high swing_low
 *   prior_high prior_low prior_close   last completed RTH day (9:30-16:00 ET)
 *   rth_open    today's 09:30 ET open, from that bar until 16:00 ET
 *   rth_high rth_low   today's RTH high and low so far, this bar included
 *   ib_high ib_low   today's initial balance (09:30-10:30 ET), from the bar that completes it
 *   adr(n)      the average RTH range of the last n complete days (scripts/lib/trading/day-context.js)
 *   overnight_high overnight_low       this Globex session before 9:30 ET, up to
 *                                      the previous bar (so a break can cross it)
 *   minute_et (minutes since midnight New York time at the bar's open, e.g. 9:45 = 585)
 *   htf_open(m) htf_high(m) htf_low(m) htf_close(m)
 *               the previous m-minute candle (m divides a day: 60 = 1 hour,
 *               240 = 4 hours), candles aligned to the 18:00 ET open (4 hours:
 *               18, 22, 02, 06, 10, 14 ET); it changes when a new candle opens
 *   htfc_open(m) htfc_high(m) htfc_low(m)
 *               the m-minute candle in progress, up to and including this bar
 *               (htfc_low(60) < htf_low(60): this hour swept the last hour's low)
 *   htfd_open(m) htfd_high(m) htfd_low(m) htfd_close(m) htfd_volume(m)
 *               the last m-minute candle COMPLETED by this bar's close (d = done;
 *               scripts/lib/trading/candle-facts.js): on the bar that closes a
 *               candle it is that candle (htf_* is still the one before it until
 *               the next candle opens); never the candle forming. m = 3, 5, 15, 60
 *               (any m dividing a day) made of whole bars of the strategy's own
 *               timeframe (the bar size is given, never guessed): 5m from 3m bars
 *               has no value (never approximated)
 *   htfd_prev_high(m) htfd_prev_low(m)   the candle before it
 *   htfd_body(m) htfd_upper_wick(m) htfd_lower_wick(m)   shares of its range (0-1)
 *   htfd_close_loc(m)  where it closed: 1 top third, 0 middle, -1 bottom third
 *   htfd_range_atr(m)  its range in the timeframe's ATR(14) as of the candle before
 *   htfd_vol_ratio(m)  its volume against the 20 candles before it (average)
 *   htfd_doji(m) htfd_hammer(m) htfd_shooting_star(m) htfd_inside(m) htfd_outside(m)
 *               1 when its pattern definition holds (candle-facts.js), else 0
 *   htfd_engulfing(m) htfd_displacement(m)   1 bullish, -1 bearish, 0
 *   htfd_rejected(m, level) htfd_broke(m, level) htfd_touched(m, level)
 *               how it met a level: a fixed level counts when it was complete by
 *               the candle's open (its last bar closed at or before the open), at
 *               its value then (one its own bars made, or one formed later, has
 *               none, so no relation); a moving one (vwap_*, session_*) at the
 *               candle's close:
 *               rejected 1 (traded
 *               below, closed back above) / -1 (above, back below) / 0; broke 1 up /
 *               -1 down / 0 (closed beyond, most of the body beyond); touched 1 when
 *               it traded at the level otherwise, else 0. level (THE vocabulary, LEVEL_ARGS; any other name is refused): prior_high
 *               prior_low prior_close overnight_high overnight_low or_high or_low
 *               ib_high ib_low rth_open vwap_session vwap_rth swing_high swing_low
 *               prior_poc prior_vah prior_val session_poc session_vah session_val,
 *               or previous_high previous_low (the candle before it)
 *   htfd_next_swing_high(m) htfd_next_swing_low(m)   the next swing target: the
 *               nearest confirmed m-minute swing high above (low below) the close
 *               that no bar has traded beyond since
 *   crt_dir(m)  1 / -1 on the bar a Candle Range Theory sweep of the previous
 *               m-minute candle confirms (scripts/lib/trading/crt.js), else 0;
 *               one per candle
 *   crt_risk(m) that setup's stop distance (to the sweep extreme plus a buffer)
 *   crt_target(m) its distance to the far side of the previous candle (the CRT target)
 *   CISD on completed m-minute candles (scripts/lib/trading/cisd.js; m a whole number of
 *   the bars, so on 3m bars 3, 15, 60, never 5; missing otherwise), the latest one as of this bar:
 *   cisd_dir(m)   1 bullish, -1 bearish, 0 none yet
 *   cisd_level(m) its level (the open of the run it closed through)
 *   cisd_sweep(m) 1 when a key level (prior RTH day, overnight, prior session) was swept first, else 0
 *   ote_top(m) ote_bot(m) its displacement leg's OTE zone (fib.OTE of the leg); missing once the
 *               zone is void or expired
 *   in_ote(m)   1 when this bar closed inside that zone, else 0
 *   cisd_entry(m) 1 / -1 on the bar that bounces from the zone (a close back in the CISD's
 *               direction after trading into it), one per CISD, else 0
 *   cisd_risk(m)  that entry's stop distance (beyond the leg's origin, the run's extreme)
 *               With the param cisdHigherMinutes H (e.g. 60), cisd_entry(m) and cisd_risk(m)
 *               also take the H-minute CISD's bounce, H's first when both fire on a bar.
 *   A CISD's zone needs a strong displacement candle (cisd.js; cisdMinBody,
 *   cisdMinRangeAtr): after a weak one, ote_* are missing and no entry fires.
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
 * Broker fields: field("a.b.c") is a number the broker put on the bar, read by
 *   its dotted path (letters, digits, _; a digit segment reads a key such as
 *   "5"), e.g. field("x.y")[1] on the previous bar. The harness gives these
 *   fields no meaning: the strategy document names them. A missing field, a
 *   null, or anything not a number (true/false read as 1/0) has no value, so
 *   its condition is false.
 * A value that doesn't exist yet (indicator warm-up, no opening range or
 * overnight yet, look-back before the first bar) makes its condition false;
 * the result marks it `missing` so a short bar history is visible.
 * Strategy `params` (orbMinutes, swingK, stPeriod, stMult, kcLen, kcMult,
 * kcAtr, crtSweepBars, crtShiftBars, crtMaxDepth, crtMinRangeAtr,
 * crtBufferAtr, crtMinRR for crt_*, and cisdMinRun, cisdMaxWait, cisdExpiry,
 * cisdVoidTol, cisdBufferAtr, cisdMinBody, cisdMinRangeAtr, cisdHigherMinutes for
 * the CISD series) tune the series that use them.
 */

const ind = require('./indicators');
const cisd = require('./cisd');
const crt = require('./crt');
const mtf = require('./mtf');
const { zonedParts } = require('./clock');
const vp = require('./volume-profile');
const dayContext = require('./day-context');
const candleFacts = require('./candle-facts');
const { RTH_OPEN_MIN, RTH_CLOSE_MIN, GLOBEX_OPEN_MIN } = require('./clock'); // the session boundaries' one home


const OPS = ['crosses_above', 'crosses_below', '>=', '<=', '>', '<'];
const CISD_FUNCS = ['cisd_dir', 'cisd_level', 'cisd_sweep', 'ote_top', 'ote_bot', 'in_ote', 'cisd_entry', 'cisd_risk'];
// The last completed candle (candle-facts.js): its OHLCV and facts, its relation to a level, the next swing targets.
const HTFD = ['htfd_open', 'htfd_high', 'htfd_low', 'htfd_close', 'htfd_volume', 'htfd_prev_high', 'htfd_prev_low', 'htfd_body', 'htfd_upper_wick',
  'htfd_lower_wick', 'htfd_close_loc', 'htfd_range_atr', 'htfd_vol_ratio', 'htfd_doji', 'htfd_hammer', 'htfd_shooting_star', 'htfd_inside',
  'htfd_outside', 'htfd_engulfing', 'htfd_displacement'];
const HTFD_TARGETS = { htfd_next_swing_high: 'high', htfd_next_swing_low: 'low' };
const HTFD_REL = { htfd_rejected: 'rejected', htfd_broke: 'broke', htfd_touched: 'touched' };
// The level vocabulary of htfd_rejected/broke/touched(m, level): fixed, listed in the header above (a test keeps the two equal); any other name is refused at compile, so at strategy load.
// The moving ones among them: read at the candle's close; every other is read as it stood when the candle opened.
const MOVING_LEVELS = new Set(['vwap_session', 'vwap_rth', 'session_poc', 'session_vah', 'session_val']);
// A fixed level counts when it was complete by the candle's open (its last bar closed at or before it). These series
// hold a value made of earlier bars only (set on the bar after they complete: the prior day at the first bar past
// 16:00 ET, the overnight range up to the bar before), so they are read on the candle's first bar; every other fixed
// one has its value on its completing bar (or_*, ib_*, swings, rth_open), so it is read on the bar before.
// A session's own levels: at a new session's first candle (18:00 ET, Sunday's open) the last session's are stale and
// give no relation (the prior RTH day is not one: it is the day that just closed).
const SESSION_LEVELS = new Set(['or_high', 'or_low', 'ib_high', 'ib_low', 'overnight_high', 'overnight_low', 'rth_open']);
const FROM_PRIOR_BARS = new Set(['prior_high', 'prior_low', 'prior_close', 'prior_poc', 'prior_vah', 'prior_val', 'overnight_high', 'overnight_low']);
const LEVEL_ARGS = new Set(['prior_high', 'prior_low', 'prior_close', 'overnight_high', 'overnight_low', 'or_high', 'or_low', 'ib_high', 'ib_low',
  'rth_open', 'vwap_session', 'vwap_rth', 'swing_high', 'swing_low', 'prior_poc', 'prior_vah', 'prior_val', 'session_poc', 'session_vah',
  'session_val', 'previous_high', 'previous_low']);
const HTF = new Set(['htf_open', 'htf_high', 'htf_low', 'htf_close', 'htfc_open', 'htfc_high', 'htfc_low', 'crt_dir', 'crt_risk', 'crt_target', 'mtf_bias',
  ...CISD_FUNCS, ...HTFD, ...Object.keys(HTFD_TARGETS), ...Object.keys(HTFD_REL)]);
// Volume profile fields: levels, and the nearest node above/below the close.
const VP_LEVELS = ['poc', 'vah', 'val'];
const VP_NODES = ['hvn_above', 'hvn_below', 'lvn_above', 'lvn_below'];
const VP_FUNCS = [...VP_LEVELS.map(f => `vp_${f}`), ...VP_NODES];
const VP_NAMES = ['prior', 'session'].flatMap(w => [...VP_LEVELS, ...VP_NODES].map(f => `${w}_${f}`));
const FUNCS = new Set(['ema', 'sma', 'atr', 'adx', 'highest', 'lowest', 'vol_sma', 'adr', ...HTF, ...VP_FUNCS]);
const NAMES = new Set([
  'open', 'high', 'low', 'close', 'volume', 'supertrend', 'supertrend_dir',
  'keltner_upper', 'keltner_mid', 'keltner_lower', 'vwap_session', 'vwap_rth',
  'or_high', 'or_low', 'swing_high', 'swing_low', 'prior_high', 'prior_low',
  'prior_close', 'overnight_high', 'overnight_low', 'rth_open', 'rth_high', 'rth_low', 'ib_high', 'ib_low', 'minute_et',
  ...VP_NAMES,
]);
const MAX_RULES_PER_SIDE = 12;
const MAX_GROUP_ITEMS = 8;
const MAX_GROUP_DEPTH = 3;
const MAX_CONDITIONS_PER_SIDE = 24;
// field("a.b.c")[n]: a broker's field on the bar, by dotted path.
const FIELD_RE = /\s*field\s*\(\s*(["'])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\1\s*\)(?:\[(\d+)\])?/y;
const MAX_FIELD_SEGMENTS = 8;
const FIELD_PREFIX = 'field:';

/** Every field() path in a rule's text, in either quote style, as the tokenizer reads them. */
function fieldPathsIn(text) {
  return [...String(text).matchAll(new RegExp(FIELD_RE.source, 'g'))].map(m => m[2]);
}

/** The number at a dotted path in a bar (own properties only), else NaN: missing, null, or not a number. */
function readField(bar, path) {
  let v = bar;
  for (const seg of path.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, seg) || (Array.isArray(v) && !/^\d+$/.test(seg))) return NaN;
    v = v[seg];
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

/** A field's value `shift` bars before bar i, as readField reads it; null when missing (or before the first bar). */
function fieldAt(bars, path, shift, i) {
  const j = i - shift;
  const v = j >= 0 && j < bars.length ? readField(bars[j], path) : NaN;
  return Number.isFinite(v) ? v : null;
}

/**
 * The broker field values a rule reads at bar i (the decision bar): each field() it names, by its path (a
 * look-back by "path[n]", read n bars earlier), as readField reads it, a missing one null. `rule` is the
 * rule's text, a compiled condition or group (its text), or a { any | all: [...] } group.
 */
function valuesFor(rule, bars, i = bars.length - 1) {
  const out = {};
  const texts = r => (typeof r === 'string' ? [r] : r && typeof r.text === 'string' ? [r.text]
    : r && typeof r === 'object' ? Object.values(r).flatMap(v => (Array.isArray(v) ? v.flatMap(texts) : texts(v))) : []);
  for (const text of texts(rule)) {
    for (const m of text.matchAll(new RegExp(FIELD_RE.source, 'g'))) {
      const shift = Number(m[3] || 0);
      out[shift ? `${m[2]}[${shift}]` : m[2]] = fieldAt(bars, m[2], shift, i);
    }
  }
  return out;
}

function tokenize(text) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([a-z_][a-z0-9_]*)\s*\(\s*(\d+)\s*(?:,\s*([a-z_][a-z0-9_]*)\s*)?\)(?:\[(\d+)\])?|([a-z_][a-z0-9_]*)(?:\[(\d+)\])?|(>=|<=|>|<)|([+\-*]))/gy;
  let pos = 0;
  const src = String(text).trim();
  while (pos < src.length) {
    FIELD_RE.lastIndex = pos;
    const f = FIELD_RE.exec(src);
    if (f) {
      pos = FIELD_RE.lastIndex;
      tokens.push({ type: 'field', path: f[2], shift: Number(f[3] || 0) });
      continue;
    }
    if (/^\s*field\s*\(/.test(src.slice(pos))) throw new Error('field("a.b.c"): a quoted dotted path of letters, digits and _');
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m.index !== pos) throw new Error(`cannot read "${src.slice(pos)}"`);
    pos = re.lastIndex;
    if (m[1]) tokens.push({ type: 'num', value: Number(m[1]) });
    else if (m[2]) tokens.push({ type: 'func', name: m[2], arg: Number(m[3]), level: m[4] || null, shift: Number(m[5] || 0) });
    else if (m[6]) {
      if (OPS.includes(m[6]) && m[7] === undefined) tokens.push({ type: 'op', value: m[6] });
      else tokens.push({ type: 'name', name: m[6], shift: Number(m[7] || 0) });
    } else if (m[8]) tokens.push({ type: 'op', value: m[8] });
    else tokens.push({ type: 'arith', value: m[9] });
  }
  return tokens;
}

function parseFactor(tok) {
  if (!tok) throw new Error('expected a value');
  if (tok.type === 'num') return { kind: 'num', value: tok.value };
  if (tok.shift > 500) throw new Error(`[${tok.shift}]: look-back must be 0-500`);
  if (tok.type === 'field') {
    if (tok.path.split('.').length > MAX_FIELD_SEGMENTS) throw new Error(`field("${tok.path}"): at most ${MAX_FIELD_SEGMENTS} path segments`);
    return { kind: 'series', key: `${FIELD_PREFIX}${tok.path}`, shift: tok.shift };
  }
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
    if (HTFD_REL[tok.name]) {
      if (!tok.level) throw new Error(`${tok.name}(${tok.arg}, level): name the level, e.g. ${tok.name}(${tok.arg}, prior_high)`);
      if (!LEVEL_ARGS.has(tok.level)) throw new Error(`${tok.name}(${tok.arg}, ${tok.level}): the level is one of ${[...LEVEL_ARGS].join(', ')}`);
      return { kind: 'series', key: `${tok.name}(${tok.arg},${tok.level})`, shift: tok.shift };
    }
    if (tok.level) throw new Error(`${tok.name}(${tok.arg}, ${tok.level}): only ${Object.keys(HTFD_REL).join(', ')} take a level`);
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
    if (tokens[i].type !== 'arith' || tokens[i].value === '*') throw new Error(`unexpected "${tokens[i].value || tokens[i].name || `field("${tokens[i].path}")`}"`);
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
    const session = ind.sessionKey(b.t, GLOBEX_OPEN_MIN);
    if (rth && (day !== rthDay || minute >= RTH_CLOSE_MIN)) { prior = rth.complete ? rth : null; rth = null; rthDay = null; }
    if (session !== onSession) { onSession = session; onHigh = NaN; onLow = NaN; onComplete = i > 0; }
    if (prior) { out.prior_high[i] = prior.high; out.prior_low[i] = prior.low; out.prior_close[i] = prior.close; }
    if (onComplete) { out.overnight_high[i] = onHigh; out.overnight_low[i] = onLow; }
    if (minute >= RTH_OPEN_MIN && minute < RTH_CLOSE_MIN) {
      // Complete only when the bars before it were seen (not cut off mid-session).
      if (!rth) { rth = { open: b.o, high: b.h, low: b.l, close: b.c, complete: i > 0 }; rthDay = day; }
      rth.high = Math.max(rth.high, b.h); rth.low = Math.min(rth.low, b.l); rth.close = b.c;
      if (rth.complete) { out.rth_open[i] = rth.open; out.rth_high[i] = rth.high; out.rth_low[i] = rth.low; }
    } else if (!(minute >= RTH_CLOSE_MIN && minute < GLOBEX_OPEN_MIN)) {
      onHigh = Number.isNaN(onHigh) ? b.h : Math.max(onHigh, b.h);
      onLow = Number.isNaN(onLow) ? b.l : Math.min(onLow, b.l);
    }
  }
  return out;
}

/** Lazily computed series over normalized bars; values are aligned to bars, NaN in warm-up. */
function seriesSource(bars, params, { barMinutes = null } = {}) {
  const cache = new Map();
  const n = bars.length;
  let lv = null;
  const level = k => { lv = lv || causalLevels(bars); return k === null ? lv : lv[k]; };
  const field = f => bars.map(b => b[f]);
  const htfs = new Map();
  const htf = m => { if (!htfs.has(m)) htfs.set(m, ind.htfCandles(bars, m)); return htfs.get(m); };
  const crts = new Map();
  const crtOf = m => {
    if (!crts.has(m)) {
      crts.set(m, crt.crtSeries(bars, m, ind.atr(bars, params.atrStop || ind.STOP_ATR_PERIOD), {
        sweepBars: params.crtSweepBars, shiftBars: params.crtShiftBars, maxDepth: params.crtMaxDepth,
        minRangeAtr: params.crtMinRangeAtr, bufferAtr: params.crtBufferAtr, minRR: params.crtMinRR,
      }));
    }
    return crts.get(m);
  };
  // CISD on completed m-minute candles (cisd.js), once per m.
  const cisds = new Map();
  const oneCisd = m => cisd.cisdSeries(bars, m, { levels: level(null), atr: ind.atr(bars, params.atrStop || ind.STOP_ATR_PERIOD), params: cisd.paramsFrom(params) });
  // With params.cisdHigherMinutes H (a whole number of m, above it), cisd_entry(m) and cisd_risk(m) also take the
  // H-minute CISD's bounce, the higher one first when both fire on a bar (cisd.combineHigher); the rest stay m's own.
  const cisdOf = m => {
    if (!cisds.has(m)) {
      const H = Number(params.cisdHigherMinutes) || 0;
      const own = oneCisd(m);
      cisds.set(m, H > m && H % m === 0 && 1440 % H === 0 ? cisd.combineHigher(own, oneCisd(H), H) : own);
    }
    return cisds.get(m);
  };
  const cisdField = (m, k) => { const c = cisdOf(m); return c.unavailable ? new Array(n).fill(NaN) : c[k]; };
  const dayCtx = new Map();
  const dayOf = adrDays => {
    if (!dayCtx.has(adrDays)) dayCtx.set(adrDays, dayContext.dayContextSeries(bars, { adrDays, params }));
    return dayCtx.get(adrDays);
  };
  const profiles = new Map();
  const profileOf = (kind, length = 0) => {
    const key = `${kind}:${length}`;
    if (!profiles.has(key)) profiles.set(key, vp.profileSeries(bars, kind === 'prior' ? 'prior_rth' : kind, { length, options: vp.optionsFromParams(params) }));
    return profiles.get(key);
  };
  const rolling = (vals, len, fn) => vals.map((_, i) => (i + 1 < len ? NaN : fn(vals.slice(i + 1 - len, i + 1))));
  const make = key => {
    if (key.startsWith(FIELD_PREFIX)) { const p = key.slice(FIELD_PREFIX.length); return bars.map(b => readField(b, p)); }
    const rel = /^([a-z_]+)\((\d+),([a-z_]+)\)$/.exec(key);
    if (rel && HTFD_REL[rel[1]] && LEVEL_ARGS.has(rel[3])) {
      const m = Number(rel[2]);
      const own = rel[3] === 'previous_high' || rel[3] === 'previous_low';
      const lvl = own ? get(`htfd_prev_${rel[3].slice('previous_'.length)}(${m})`) : get(rel[3]);
      // A key level as it stood at the candle's close (a level formed later has no value then: no relation).
      // A fixed level as it stood when the candle opened (never one its own bars made), a moving one (VWAP, the
      // developing session profile) at its close, the candle's previous candle on this bar.
      const at = own ? 'now' : MOVING_LEVELS.has(rel[3]) ? 'close' : FROM_PRIOR_BARS.has(rel[3]) ? 'first' : 'open';
      return candleFacts.relationSeries(bars, m, barMinutes, lvl, { at, session: SESSION_LEVELS.has(rel[3]) })[HTFD_REL[rel[1]]];
    }
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
        case 'cisd_dir': return cisdField(len, 'dir');
        case 'cisd_level': return cisdField(len, 'level');
        case 'cisd_sweep': return cisdField(len, 'sweep');
        case 'ote_top': return cisdField(len, 'top');
        case 'ote_bot': return cisdField(len, 'bottom');
        case 'in_ote': return cisdField(len, 'inOte');
        case 'cisd_entry': return cisdField(len, 'entry');
        case 'cisd_risk': return cisdField(len, 'risk');
        case 'htfd_next_swing_high': case 'htfd_next_swing_low': return candleFacts.swingTargetSeries(bars, len, barMinutes)[HTFD_TARGETS[fn[1]]];
        case 'adr': return dayOf(len).adr;
        default:
          if (HTFD.includes(fn[1])) return candleFacts.candleSeries(bars, len, barMinutes)[fn[1]];
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
      case 'vwap_session': return ind.anchoredVwap(bars, GLOBEX_OPEN_MIN);
      case 'vwap_rth': return ind.anchoredVwap(bars, RTH_OPEN_MIN, RTH_CLOSE_MIN);
      case 'or_high': return completeRange(ind.openingRange(bars, params.orbMinutes).high, 'h');
      case 'or_low': return completeRange(ind.openingRange(bars, params.orbMinutes).low, 'l');
      case 'swing_high': return ind.swings(bars, params.swingK).high;
      case 'swing_low': return ind.swings(bars, params.swingK).low;
      case 'prior_high': case 'prior_low': case 'prior_close':
      case 'overnight_high': case 'overnight_low': case 'rth_open': case 'rth_high': case 'rth_low': return level(key);
      case 'ib_high': case 'ib_low': return dayOf(10)[key];
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
    const open = RTH_OPEN_MIN;
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
  /**
   * What each detector this source has run says about bar i ({ 'crt(60)': {...} }), for logs and scan output. `text`
   * (a strategy's rules, stop and target as text): only the detectors it names (crt_*(m), cisd_*(m) / ote_*(m) /
   * in_ote(m)), never another strategy's that shares this source.
   */
  get.explain = (i, text = null) => {
    const names = (kind, m) => text === null || new RegExp(`\\b(?:${kind === 'crt' ? 'crt_[a-z]+' : 'cisd_[a-z]+|ote_[a-z]+|in_ote'})\\(\\s*${m}\\s*\\)`).test(text);
    const out = {};
    for (const [m, c] of crts) { const x = names('crt', m) && c.explain(i); if (x) out[`crt(${m})`] = x; }
    for (const [m, c] of cisds) { const x = names('cisd', m) && !c.unavailable && c.entries.get(i); if (x) out[`cisd(${m})`] = x; }
    return out;
  };
  /** True when a level series starts over between bars i-1 and i (a jump, not a price cross). */
  get.resets = (key, i) => {
    if (i < 1) return false;
    if (key === 'vwap_session') return ind.sessionKey(bars[i].t, GLOBEX_OPEN_MIN) !== ind.sessionKey(bars[i - 1].t, GLOBEX_OPEN_MIN);
    // A developing profile level (session_poc, vp_vah(n), ...) that moves jumps past price: a cross
    // counts only through a level that stayed put.
    if (/^session_(poc|vah|val)$/.test(key) || /^vp_(poc|vah|val)\(\d+\)$/.test(key)) {
      const s = get(key);
      return ind.sessionKey(bars[i].t, GLOBEX_OPEN_MIN) !== ind.sessionKey(bars[i - 1].t, GLOBEX_OPEN_MIN) || !(s[i - 1] === s[i]);
    }
    // A higher-timeframe candle level starts over when a new candle opens.
    const h = /^(htfc?_[a-z]+)\((\d+)\)$/.exec(key);
    if (h && HTF.has(h[1]) && !h[1].startsWith('crt_') && h[1] !== 'mtf_bias') { const k = htf(Number(h[2])).key; return k[i] !== k[i - 1]; }
    // A CISD level or OTE edge moves when a new CISD replaces the last or its leg extends: a jump, not a price cross.
    if (/^(cisd_level|ote_top|ote_bot)\(\d+\)$/.test(key)) {
      const s = get(key);
      return Number.isFinite(s[i - 1]) && Number.isFinite(s[i]) && s[i - 1] !== s[i];
    }
    // A completed-candle value (or a swing target) starts over when the next candle completes (or a swing is taken or
    // confirmed): a jump, never a cross.
    const d = /^(htfd_[a-z_]+)\((\d+)(?:,[a-z_]+)?\)$/.exec(key);
    if (d) {
      if (HTFD_TARGETS[d[1]]) { const s = get(key); return !(s[i - 1] === s[i]); }
      const k = candleFacts.completedSeries(bars, Number(d[2]), barMinutes).lastAt;
      return k[i] !== k[i - 1];
    }
    if (LEVELS.has(key)) {
      const s = get(key);
      return Number.isFinite(s[i - 1]) && Number.isFinite(s[i]) && s[i - 1] !== s[i];
    }
    return false;
  };
  return get;
}

const LEVELS = new Set(['prior_high', 'prior_low', 'prior_close', 'or_high', 'or_low', 'rth_open', 'ib_high', 'ib_low', 'prior_poc', 'prior_vah', 'prior_val']);

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

/** The field() factors a compiled condition or group reads, in order: [{ path, shift }]. */
function fieldReads(c) {
  if (c.group) return c.items.flatMap(fieldReads);
  const reads = [...c.left, ...c.right].flatMap(t => t.factors)
    .filter(f => f.kind === 'series' && f.key.startsWith(FIELD_PREFIX))
    .map(f => ({ path: f.key.slice(FIELD_PREFIX.length), shift: f.shift || 0 }));
  // A cross compares this bar with the one before: both are what it read.
  return c.op.startsWith('crosses_') ? reads.flatMap(r => [r, { ...r, shift: r.shift + 1 }]) : reads;
}

/**
 * What a condition's fields were on bar i (its look-back [n] read n bars back), keyed as the rule writes them
 * (`field("a.b")`, `field("a.b")[1]`): the number, a flag as 1 or 0, null when missing. null for a rule that reads none.
 * What the scan shows; valuesFor (above) is the session record's, by a strategy's rule text and keyed by path.
 * Both read through fieldAt.
 */
function fieldValues(c, bars, i) {
  const reads = fieldReads(c);
  if (!reads.length) return null;
  const out = {};
  for (const { path, shift } of reads) out[`field("${path}")${shift ? `[${shift}]` : ''}`] = fieldAt(bars, path, shift, i);
  return out;
}

// What the model is shown of a strategy's field values on a bar: at most this many (the rest counted).
const VALUES_PER_STRATEGY = 6;

/** A value as the scan shows it: 4 significant digits, 'missing' when it has none. */
const valueText = v => (Number.isFinite(v) ? String(Number(v.toPrecision(4))) : 'missing');

/**
 * A rule result's field values as text, `field("a.b")=0.42, field("a.b")[1]=missing` ('' when it has none), at most `cap`
 * of them (the rest counted): what a strategy's own document says the field means is its meaning.
 */
function valuesText(values, cap = Infinity) {
  const list = values && typeof values === 'object' ? Object.entries(values) : [];
  const shown = list.slice(0, cap).map(([k, v]) => `${k}=${valueText(v)}`);
  return list.length > shown.length ? [...shown, `+${list.length - shown.length} more`].join(', ') : shown.join(', ');
}

/** The values of a held group's parts that held, merged (each once); null when none of them reads a field. */
function heldValues(parts) {
  const held = parts.filter(x => x.ok && x.values);
  return held.length ? Object.assign({}, ...held.map(x => x.values)) : null;
}

/** The field values a side's rule results read, merged (each once), as valuesText: what a fired side saw. */
const sideValuesText = (results, cap = VALUES_PER_STRATEGY) => valuesText(Object.assign({}, ...(Array.isArray(results) ? results : []).map(r => (r && r.values) || {})), cap);

/**
 * Evaluate compiled rules on the last bar. Returns { direction, long, short }
 * where long/short list each condition with its result (for explanations): { rule, ok }, plus `missing` when a
 * value isn't there yet, `parts` for a group, and `values` (fieldValues) for one that reads a broker's field
 * (`values: false` leaves them out; they never change a result's direction or ok).
 */
function evaluateRules(compiled, bars, params, { index = bars.length - 1, get: source = null, values: withValues = true, barMinutes = null } = {}) {
  // barMinutes: the bars' size (the completed-candle series need it; never guessed).
  const get = source || seriesSource(bars, params, { barMinutes });
  const i = index;
  const missing = c => [c.left, c.right].some(e => valueAt(e, get, i) === null)
    || (c.op.startsWith('crosses_') && [c.left, c.right].some(e => valueAt(e, get, i - 1) === null));
  // A group reports each of its items too, so a scan shows which branch held.
  const result = c => {
    if (c.group) {
      const parts = c.items.map(result);
      const ok = c.group === 'any' ? parts.some(x => x.ok) : parts.every(x => x.ok);
      // Failing with a part that has no value yet: say so, as for a single condition.
      const out = !ok && parts.some(x => x.missing) ? { rule: c.text, ok, missing: true, parts } : { rule: c.text, ok, parts };
      // A group that holds shows what its holding parts read (an any's failed branch decided nothing); one that
      // fails, every field it reads.
      const values = withValues && (ok ? heldValues(parts) : fieldValues(c, bars, i));
      return values ? { ...out, values } : out;
    }
    const ok = holds(c, get, i);
    const out = ok || !missing(c) ? { rule: c.text, ok } : { rule: c.text, ok, missing: true };
    const values = withValues && fieldValues(c, bars, i);
    return values ? { ...out, values } : out;
  };
  const side = conds => conds.map(result);
  const long = side(compiled.long);
  const short = side(compiled.short);
  const longFires = long.length > 0 && long.every(r => r.ok);
  const shortFires = short.length > 0 && short.every(r => r.ok);
  return { direction: longFires && !shortFires ? 'long' : shortFires && !longFires ? 'short' : null, long, short };
}

module.exports = { OPS, FUNCS, NAMES, LEVEL_ARGS, HTFD_REL, readField, fieldPathsIn, valuesFor, fieldValues, valuesText, sideValuesText, VALUES_PER_STRATEGY, MAX_RULES_PER_SIDE, compileCondition, compileItem, compileExpression, valueAt, compileRules, evaluateRules, seriesSource, causalLevels };
