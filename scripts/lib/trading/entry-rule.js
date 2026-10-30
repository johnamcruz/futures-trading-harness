'use strict';

/**
 * A policy's entry rule (its account's RULEBOOK.md `policies.<name>.entry`): the owner's top-down flow held in code on
 * a trade_lifecycle entry (the bias frame, the regime, the leg), checked on the cycle bar's briefing by the reads
 * checker (composed-reads.js checkReads, `entryRule`), so compose_check and the order gate's re-check refuse the same
 * entry. Pure: no files, no clock. Each key is `off` (no check) or on; with every key off the entry is checked as
 * before (the trend rule, D2). A fact a key on needs that the briefing doesn't hold refuses (fails closed: the check
 * only ever refuses more).
 *
 *   chain         the fractal chain's top (chain.js: 4h -> 4h/15m/3m, 1h -> 1h/5m/1m): its bias frames bound bias_frames,
 *                 its setup frame is the composed setup's minimum and the neutral path's trend frame, its entry frame
 *                 must be the briefing's base timeframe (the runner's base lane), else no entry (fails closed).
 *   bias_frames   off, or the frames that set the higher-timeframe bias, highest first ([4h, 1h]): the first of them
 *                 that trends (h1.h4.trend, h1.h1.trend, m15.frame.trend: up or down) is the bias, and the side must
 *                 be its way; none of them may trend against the side (a lower frame never stands in against a listed
 *                 one); none trending: no bias, no entry. The frames are the rulebook's, never the model's pick.
 *   bias_agree    how the listed frames agree (with bias_frames listed), strictest first (AGREE_MODES):
 *                 on: the owner's "no trade if there is no agreement between the two": every listed frame must trend
 *                 the side's way (a long needs the 4h and the 1h both up); a range, a trend against or a trend the
 *                 briefing doesn't hold on any of them: no entry.
 *                 off: bias_frames as above (the first trending one sets the side, none against; none trending: no
 *                 entry).
 *                 neutral-15m-declared (BG, the alignment study's pick, 2026-10-29): when a listed frame trends, the
 *                 side is the way of every listed frame that trends and none trends against it (off's check); when
 *                 every listed frame ranges, the 15m trend (m15.frame.trend) must be the side's way and the day's
 *                 trend declared the side's way (declaredOf). A fact it needs the briefing doesn't hold: no entry.
 *                 on and neutral-15m-declared hold the top-down chain (topDown): a composed setup on the 15m or higher.
 *   regime_against  on: no entry while the base regime (m3.regime.primary, regime.js) trends against the side
 *                 (trend-down for a long, trend-up for a short).
 *   leg_turned    on: while the base regime does not trend the side's way (range, transition, or a trend against
 *                 it when regime_against is off), the reads must hold the leg turned back the side's way: a true
 *                 base-timeframe break read (`3m bos up`, `3m choch up`) or base compression break
 *                 (`3m compression break up`) pointing the side (pullback-vs-reversal: the pullback ends when its
 *                 minor structure breaks back).
 *
 *   ENTRY_KEYS, BIAS_FRAMES, TREND_TF (the briefing field each frame's trend is in; composed-reads takes it from here)
 *   entryRuleErrors(x, at)                      problems with a rulebook entry block (every key stated)
 *   entryRuleOf(x)                              the rule as the checker reads it ({ biasFrames, biasAgree (on),
 *                                               biasNeutral (neutral-15m-declared), regimeAgainst, legTurned }), or null
 *                                               when every key is off or the block is missing
 *   topDown(rule)                               the rule holds the top-down chain (bias_agree on or neutral-15m-declared)
 *   declaredOf(briefing, side)                  the day's trend declared the side's way (true / false), null when the
 *                                               briefing holds no Trend declared? facts (outside RTH, a frame briefing)
 *   entryProblems({ briefing, side, reads, rule })   [problem] (empty: the rule holds); reads: checkReads' checked rows
 */

const { label } = require('./mtf');
const { chainOf, chainError, SHIPPED } = require('./chain');

const ENTRY_KEYS = Object.freeze(['chain', 'bias_frames', 'bias_agree', 'regime_against', 'leg_turned']);
const OFF = 'off';
/** bias_agree's values, strictest first (the rulebook guard's order: a later one is looser). */
const NEUTRAL = 'neutral-15m-declared';
const AGREE_MODES = Object.freeze(['on', OFF, NEUTRAL]);
/** The frames a bias may be read on, highest first, and the briefing field each trend is in. */
const TREND_TF = Object.freeze({ '15m': ['m15', 'frame'], '1h': ['h1', 'h1'], '4h': ['h1', 'h4'] });
/** The shipped chain's bias frames, highest first (chain.js: the top and the one below it; the 4h chain: 4h, 1h): the
 * frames the module constants that read no policy use (the trail target, the timing line, the PPC trend set). */
const BIAS_FRAMES = chainOf(SHIPPED).bias;

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const onOff = x => x === OFF || x === 'on';
const data = (b, name) => (isObj(b) && isObj(b.sections) && isObj(b.sections[name]) && isObj(b.sections[name].data) ? b.sections[name].data : null);
const way = side => (side === 'long' ? 'up' : side === 'short' ? 'down' : null);
const opposite = d => (d === 'up' ? 'down' : 'up');

/** Problems with a rulebook's `entry` block at `at` (policies.<name>): every key stated, each valid. */
function entryRuleErrors(x, at) {
  if (!isObj(x)) return [`${at}.entry: missing or not a map; state ${ENTRY_KEYS.join(', ')} (${OFF}: no check)`];
  const out = [];
  for (const k of Object.keys(x)) if (!ENTRY_KEYS.includes(k)) out.push(`${at}.entry.${k}: unknown key (${ENTRY_KEYS.join(', ')})`);
  for (const k of ENTRY_KEYS) if (x[k] === undefined) out.push(`${at}.entry.${k}: missing; state it (${OFF}: no check)`);
  const cerr = x.chain === undefined ? null : chainError(x.chain, `${at}.entry.chain`);
  if (cerr) out.push(cerr);
  // The bias frames are the chain's (its top and the one below it), highest first: never a frame below them.
  const order = (chainOf(x.chain) || chainOf(SHIPPED)).bias;
  const f = x.bias_frames;
  if (f !== undefined && f !== OFF) {
    const ok = Array.isArray(f) && f.length >= 1 && f.every(tf => order.includes(tf)) && new Set(f).size === f.length
      && f.every((tf, i) => i === 0 || order.indexOf(tf) > order.indexOf(f[i - 1]));
    if (!ok) out.push(`${at}.entry.bias_frames: ${JSON.stringify(f)} is not ${OFF} or a list of ${order.join(', ')}, highest first, each once (the chain's bias frames)`);
  }
  for (const k of ['regime_against', 'leg_turned']) if (x[k] !== undefined && !onOff(x[k])) out.push(`${at}.entry.${k}: ${JSON.stringify(x[k])} is not on or ${OFF}`);
  if (x.bias_agree !== undefined && !AGREE_MODES.includes(x.bias_agree)) out.push(`${at}.entry.bias_agree: ${JSON.stringify(x.bias_agree)} is not on, ${OFF} or ${NEUTRAL}`);
  if ((x.bias_agree === 'on' || x.bias_agree === NEUTRAL) && !Array.isArray(f)) out.push(`${at}.entry.bias_agree: ${x.bias_agree} needs bias_frames listed (the frames that must agree)`);
  return out;
}

/** The rule as the checker reads it, or null (no block, or every key off: no check). */
function entryRuleOf(x) {
  if (!isObj(x)) return null;
  const rule = {
    chain: chainOf(x.chain) || chainOf(SHIPPED),
    // A policy's stated chain holds the base lane to its entry frame; a check built in code with none (the trail target,
    // the timing line, the PPC trend set) reads the shipped chain's frames and no lane.
    entryLane: x.chain !== undefined,
    biasFrames: Array.isArray(x.bias_frames) ? [...x.bias_frames] : null,
    biasAgree: x.bias_agree === 'on' && Array.isArray(x.bias_frames),
    biasNeutral: x.bias_agree === NEUTRAL && Array.isArray(x.bias_frames),
    regimeAgainst: x.regime_against === 'on',
    legTurned: x.leg_turned === 'on',
  };
  return rule.biasFrames || rule.regimeAgainst || rule.legTurned ? Object.freeze(rule) : null;
}

/** A frame's trend on the briefing: 'up', 'down', 'range', or null when it doesn't hold one. */
function trendOf(b, tf) {
  const [sec, key] = TREND_TF[tf] || [];
  const d = sec ? data(b, sec) : null;
  const t = d && isObj(d[key]) ? d[key].trend : null;
  return ['up', 'down', 'range'].includes(t) ? t : null;
}

/** Whether the rule holds the top-down chain (bias_agree on or neutral-15m-declared). */
const topDown = rule => Boolean(rule && (rule.biasAgree || rule.biasNeutral));

/**
 * The day's trend declared the side's way at this bar: the alignment study's DECLARED (PREREG-C), on the briefing's own
 * trend-declared.js facts (m3.declared[side]): the regime with the side, and the close past the RTH VWAP, the EMA20
 * and the RTH open the side's way, each side-signed in ATR and above 0. A fact null (no VWAP or no open): false. The
 * overnight-range place is not part of it. No facts at all: null.
 */
function declaredOf(b, side) {
  const m3 = data(b, 'm3');
  const f = m3 && isObj(m3.declared) && isObj(m3.declared[side]) ? m3.declared[side] : null;
  if (!f) return null;
  const pos = x => typeof x === 'number' && Number.isFinite(x) && x > 0;
  return f.regime === 'with' && pos(f.vwapAtr) && pos(f.ema20Atr) && pos(f.dayMoveAtr);
}

/** neutral-15m-declared with every listed frame ranging: the 15m trend and the declared trend, both the side's way. */
function neutralProblems(b, side, d, frames, setupTf = '15m') {
  const ranging = frames.map(tf => `${tf} range`).join(', ');
  const st = setupTf;
  const t15 = trendOf(b, st);
  if (t15 === null) return [`entry rule: no higher-timeframe trend (${ranging}) and the ${st} trend is not in the briefing: no entry`];
  if (t15 !== d) return [`entry rule: no higher-timeframe trend (${ranging}) and the ${st} is ${t15}, not ${d}: with the higher frames ranging, the ${st} sets the side`];
  const dec = declaredOf(b, side);
  if (dec === null) return [`entry rule: no higher-timeframe trend (${ranging}), the ${st} ${d}: the Trend declared? facts are not in the briefing, so it can't be read: no entry`];
  if (!dec) return [`entry rule: no higher-timeframe trend (${ranging}), the ${st} ${d}, but the day's trend is not declared ${d} (the regime with the ${side} and the close past the RTH VWAP, EMA20 and RTH open its way): no entry`];
  return [];
}

/** The briefing's base timeframe as reads name it ('3m', mtf.js label), or null. */
const baseOf = b => (isObj(b) && Number.isInteger(b.minutes) && b.minutes > 0 ? label(b.minutes) : null);

/** The checked reads that turn the leg the side's way: a true base break or compression break pointing the side. */
function legReads(reads, base, side) {
  return (Array.isArray(reads) ? reads : []).filter(r => isObj(r) && r.check === true && r.agrees === true && r.dir === side
    && (r.kind === 'break' || r.kind === 'compression') && String(r.form || '').split(' ')[0] === base);
}

/** The rule's problems on this bar (see the header); none without a rule. */
function entryProblems({ briefing, side, reads, rule }) {
  if (!rule) return [];
  const d = way(side);
  if (!d) return ['the entry rule needs the side (long or short)'];
  const out = [];
  const base = baseOf(briefing);
  if (rule.entryLane && base !== rule.chain.entry) {
    out.push(base ? `entry rule: the chain ${rule.chain.name} enters on the ${rule.chain.entry}, and this briefing's base timeframe is the ${base}: no entry (the runner's base lane must be the chain's entry timeframe)`
      : `entry rule: the briefing's base timeframe is unknown, so the chain ${rule.chain.name}'s entry frame can't be checked: no entry`);
    return out;
  }
  if (rule.biasFrames) {
    const trends = rule.biasFrames.map(tf => [tf, trendOf(briefing, tf)]);
    const unknown = trends.filter(([, t]) => t === null).map(([tf]) => tf);
    if (unknown.length) out.push(`entry rule: the ${unknown.join(' and ')} trend is not in the briefing, so the higher-timeframe bias can't be read: no entry`);
    else {
      const against = trends.filter(([, t]) => t === opposite(d)).map(([tf]) => tf);
      const bias = trends.find(([, t]) => t === 'up' || t === 'down');
      const notWith = trends.filter(([, t]) => t !== d);
      if (rule.biasAgree && notWith.length) out.push(`entry rule: the ${rule.biasFrames.join(' and ')} must each trend ${d} for a ${side} (${trends.map(([tf, t]) => `${tf} ${t}`).join(', ')}): no agreement, no trade`);
      else if (against.length) out.push(`entry rule: the ${against.join(' and ')} trend${against.length > 1 ? 's are' : ' is'} ${opposite(d)}, against the ${side}: the bias frames (${rule.biasFrames.join(', ')}) set the side, never a lower frame`);
      else if (!bias && rule.biasNeutral) out.push(...neutralProblems(briefing, side, d, rule.biasFrames, rule.chain.setup));
      else if (!bias) out.push(`entry rule: no higher-timeframe bias (${rule.biasFrames.map(tf => `${tf} range`).join(', ')}): sit out until one of them trends`);
    }
  }
  if (rule.regimeAgainst || rule.legTurned) {
    const m3 = data(briefing, 'm3');
    const regime = m3 && isObj(m3.regime) && typeof m3.regime.primary === 'string' ? m3.regime.primary : null;
    if (!regime) out.push('entry rule: the base regime (m3.regime) is not in the briefing: no entry');
    else {
      const withIt = regime === `trend-${d}`;
      if (rule.regimeAgainst && regime === `trend-${opposite(d)}`) out.push(`entry rule: the regime is ${regime}, against the ${side}: wait until it stops trending against it`);
      else if (rule.legTurned && !withIt) {
        const base = baseOf(briefing);
        if (!base) out.push('entry rule: the briefing\'s base timeframe is unknown, so the leg can\'t be read: no entry');
        else if (!legReads(reads, base, side).length) out.push(`entry rule: the regime is ${regime}, not trending the ${side}'s way: state the leg turned back, a true "${base} choch ${d}", "${base} bos ${d}" or "${base} compression break ${d}" (pullback-vs-reversal), or pass`);
      }
    }
  }
  return out;
}

module.exports = { chainOf, ENTRY_KEYS, BIAS_FRAMES, TREND_TF, AGREE_MODES, NEUTRAL, entryRuleErrors, entryRuleOf, entryProblems, trendOf, legReads, topDown, declaredOf };
