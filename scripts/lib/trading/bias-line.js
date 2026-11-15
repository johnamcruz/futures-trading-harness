'use strict';

/**
 * The briefing's Bias line: the side the shipped entry rule (BG, bias_agree neutral-15m-declared on the chain's bias
 * frames) allows on this bar, said as a fact the model reads instead of working it out. It is computed by the entry
 * rule's own check (entry-rule.js entryProblems, the function compose_check and the order gate's re-check run), so the
 * line and the gate can't disagree. Pure: no files, no clock.
 *
 *   RULE                 the shipped rule as the line reads it (the trail target's: composed-reads.js TRAIL_RULE; a test
 *                        pins it to the rulebook's prop_portfolio entry)
 *   biasSides(b)         { long, short }: true when the rule allows that side on this briefing
 *   biasLine(b)          "Bias: short only (4h down, 1h down; long refused)", "Bias: neutral → 15m down + declared short
 *                        → short only", "Bias: no side (4h up, 1h down) → no entry", "Bias: no side yet (15m down,
 *                        declared short: no)"; "Bias: no prop entry on this lane" off the chain's entry frame; null when
 *                        the briefing holds no 1h part (a frame's own briefing)
 *   classSideLine(b)     the side a trend class may take (trade-session: the strict 4h + 1h), from the same trends:
 *                        "Class side (4h + 1h): up (4h up, 1h up)", "... none (4h range, 1h up): no trend class; the Bias
 *                        line above is the gate's floor, not your class", "... unknown (the 4h trend not in the
 *                        briefing)"; null where biasLine says no prop entry or has no line. Taught only: no gate reads it,
 *                        and it names no class word (choppy movement is still chop)
 */

const { entryRuleOf, entryProblems, trendOf, declaredOf, BIAS_FRAMES, NEUTRAL } = require('./entry-rule');
const { label } = require('./mtf');

const RULE = entryRuleOf({ bias_frames: [...BIAS_FRAMES], bias_agree: NEUTRAL, regime_against: 'off', leg_turned: 'off' });
const SIDES = ['long', 'short'];
const sideOf = t => (t === 'up' ? 'long' : t === 'down' ? 'short' : null);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function biasSides(b) {
  const out = {};
  for (const side of SIDES) out[side] = entryProblems({ briefing: b, side, reads: [], rule: RULE }).length === 0;
  return out;
}

function biasLine(b) {
  if (!isObj(b) || !isObj(b.sections) || !b.sections.h1) return null;
  // Off the chain's entry frame (the 3m) the gate refuses every prop entry (the lane check): no side to say.
  if (!(Number.isInteger(b.minutes) && label(b.minutes) === RULE.chain.entry)) return `Bias: no prop entry on this lane (the chain enters on the ${RULE.chain.entry})`;
  const trends = RULE.biasFrames.map(tf => [tf, trendOf(b, tf)]);
  const frames = trends.map(([tf, t]) => `${tf} ${t || 'unknown'}`).join(', ');
  const unknown = trends.filter(([, t]) => t === null).map(([tf]) => tf);
  if (unknown.length) return `Bias: no side (the ${unknown.join(' and ')} trend not in the briefing) → no entry`;
  const sides = biasSides(b);
  const allowed = SIDES.filter(s => sides[s]);
  const one = allowed.length === 1 ? allowed[0] : null;
  const trending = trends.some(([, t]) => t === 'up' || t === 'down');
  if (trending) return one ? `Bias: ${one} only (${frames}; ${one === 'long' ? 'short' : 'long'} refused)` : `Bias: no side (${frames}) → no entry`;
  const setup = RULE.chain.setup;
  const t15 = trendOf(b, setup);
  if (one) return `Bias: neutral → ${setup} ${t15} + declared ${one} → ${one} only`;
  const side = sideOf(t15);
  const dec = side ? declaredOf(b, side) : null;
  return `Bias: no side yet (${setup} ${t15 || 'unknown'}${side ? `, declared ${side}: ${dec === null ? 'unknown' : 'no'}` : ''})`;
}

function classSideLine(b) {
  if (!isObj(b) || !isObj(b.sections) || !b.sections.h1) return null;
  if (!(Number.isInteger(b.minutes) && label(b.minutes) === RULE.chain.entry)) return null;
  const trends = RULE.biasFrames.map(tf => [tf, trendOf(b, tf)]);
  const unknown = trends.filter(([, t]) => t === null).map(([tf]) => tf);
  const head = `Class side (${RULE.biasFrames.join(' + ')})`;
  if (unknown.length) return `${head}: unknown (the ${unknown.join(' and ')} trend not in the briefing)`;
  const frames = trends.map(([tf, t]) => `${tf} ${t}`).join(', ');
  const ways = new Set(trends.map(([, t]) => t));
  const way = ways.size === 1 && (ways.has('up') || ways.has('down')) ? trends[0][1] : null;
  return way ? `${head}: ${way} (${frames})` : `${head}: none (${frames}): no trend class; the Bias line above is the gate's floor, not your class`;
}

module.exports = { RULE, biasSides, biasLine, classSideLine };
