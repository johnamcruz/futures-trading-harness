'use strict';

/**
 * A policy's entry rule (its account's RULEBOOK.md `policies.<name>.entry`): the owner's top-down flow held in code on
 * a trade_lifecycle entry (the bias frame, the regime, the leg), checked on the cycle bar's briefing by the reads
 * checker (composed-reads.js checkReads, `entryRule`), so compose_check and the order gate's re-check refuse the same
 * entry. Pure: no files, no clock. Each key is `off` (no check) or on; with every key off the entry is checked as
 * before (the trend rule, D2). A fact a key on needs that the briefing doesn't hold refuses (fails closed: the check
 * only ever refuses more).
 *
 *   bias_frames   off, or the frames that set the higher-timeframe bias, highest first ([4h, 1h]): the first of them
 *                 that trends (h1.h4.trend, h1.h1.trend, m15.frame.trend: up or down) is the bias, and the side must
 *                 be its way; none of them may trend against the side (a lower frame never stands in against a listed
 *                 one); none trending: no bias, no entry. The frames are the rulebook's, never the model's pick.
 *   regime_against  on: no entry while the base regime (m3.regime.primary, regime.js) trends against the side
 *                 (trend-down for a long, trend-up for a short).
 *   leg_turned    on: while the base regime does not trend the side's way (range, transition, or a trend against
 *                 it when regime_against is off), the reads must hold the leg turned back the side's way: a true
 *                 base-timeframe break read (`3m bos up`, `3m choch up`) or base compression break
 *                 (`3m compression break up`) pointing the side (pullback-vs-reversal: the pullback ends when its
 *                 minor structure breaks back).
 *
 *   ENTRY_KEYS, BIAS_TFS
 *   entryRuleErrors(x, at)                      problems with a rulebook entry block (every key stated)
 *   entryRuleOf(x)                              the rule as the checker reads it ({ biasFrames, regimeAgainst,
 *                                               legTurned }), or null when every key is off or the block is missing
 *   entryProblems({ briefing, side, reads, rule })   [problem] (empty: the rule holds); reads: checkReads' checked rows
 */

const { label } = require('./mtf');

const ENTRY_KEYS = Object.freeze(['bias_frames', 'regime_against', 'leg_turned']);
const OFF = 'off';
/** The frames a bias may be read on, highest first, and the briefing field each trend is in. */
const BIAS_TFS = Object.freeze({ '4h': ['h1', 'h4'], '1h': ['h1', 'h1'], '15m': ['m15', 'frame'] });
const ORDER = Object.keys(BIAS_TFS);

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
  const f = x.bias_frames;
  if (f !== undefined && f !== OFF) {
    const ok = Array.isArray(f) && f.length >= 1 && f.every(tf => Object.hasOwn(BIAS_TFS, tf)) && new Set(f).size === f.length
      && f.every((tf, i) => i === 0 || ORDER.indexOf(tf) > ORDER.indexOf(f[i - 1]));
    if (!ok) out.push(`${at}.entry.bias_frames: ${JSON.stringify(f)} is not ${OFF} or a list of ${ORDER.join(', ')}, highest first, each once`);
  }
  for (const k of ['regime_against', 'leg_turned']) if (x[k] !== undefined && !onOff(x[k])) out.push(`${at}.entry.${k}: ${JSON.stringify(x[k])} is not on or ${OFF}`);
  return out;
}

/** The rule as the checker reads it, or null (no block, or every key off: no check). */
function entryRuleOf(x) {
  if (!isObj(x)) return null;
  const rule = {
    biasFrames: Array.isArray(x.bias_frames) ? [...x.bias_frames] : null,
    regimeAgainst: x.regime_against === 'on',
    legTurned: x.leg_turned === 'on',
  };
  return rule.biasFrames || rule.regimeAgainst || rule.legTurned ? Object.freeze(rule) : null;
}

/** A frame's trend on the briefing: 'up', 'down', 'range', or null when it doesn't hold one. */
function trendOf(b, tf) {
  const [sec, key] = BIAS_TFS[tf] || [];
  const d = sec ? data(b, sec) : null;
  const t = d && isObj(d[key]) ? d[key].trend : null;
  return ['up', 'down', 'range'].includes(t) ? t : null;
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
  if (rule.biasFrames) {
    const trends = rule.biasFrames.map(tf => [tf, trendOf(briefing, tf)]);
    const unknown = trends.filter(([, t]) => t === null).map(([tf]) => tf);
    if (unknown.length) out.push(`entry rule: the ${unknown.join(' and ')} trend is not in the briefing, so the higher-timeframe bias can't be read: no entry`);
    else {
      const against = trends.filter(([, t]) => t === opposite(d)).map(([tf]) => tf);
      const bias = trends.find(([, t]) => t === 'up' || t === 'down');
      if (against.length) out.push(`entry rule: the ${against.join(' and ')} trend${against.length > 1 ? 's are' : ' is'} ${opposite(d)}, against the ${side}: the bias frames (${rule.biasFrames.join(', ')}) set the side, never a lower frame`);
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

module.exports = { ENTRY_KEYS, BIAS_TFS, entryRuleErrors, entryRuleOf, entryProblems, trendOf, legReads };
