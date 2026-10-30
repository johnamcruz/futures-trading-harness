'use strict';

/**
 * The fractal chain (the owner: "the bias on the 4h or 1h, the setup 2 timeframe levels below, the entry 2 levels below
 * that"): one ladder of timeframes and the rule that derives every frame of the top-down flow from its top, so every
 * reference to a bias, levels, setup or entry timeframe reads it here. Pure data and arithmetic.
 *
 *   LADDER     ['1m', '3m', '5m', '15m', '1h', '4h'], lowest first
 *   The 2-level rule, on the ladder, from the top timeframe T at index i:
 *     bias    [T, the one below it]      (i, i - 1: BG's two frames)
 *     levels  one level below the top    (i - 1)
 *     setup   two levels below the top   (i - 2)
 *     entry   two levels below the setup (i - 4)
 *   So 4h: bias 4h + 1h, levels 1h, setup 15m, entry 3m (4h/15m/3m); 1h: bias 1h + 15m, levels 15m, setup 5m,
 *   entry 1m (1h/5m/1m). A top whose entry falls off the ladder has no chain.
 *
 *   TOPS                        the tops a chain may have ('4h', '1h'): a RULEBOOK entry's `chain` is one of them
 *   SHIPPED                     the shipped prop_portfolio's chain top ('4h'): the module constants that can't read a
 *                               policy (the trail target, the timing line) use it; tests/plugin/chain.test.js pins it
 *                               equal to the RULEBOOK's
 *   chainOf(top)                { top, name, bias, levels, setup, entry } (frozen), or null for a top that has none
 *   chainError(value, at)       the problem with a RULEBOOK `chain` value, or null
 *   twoLevelErrors(c)           [problem]: the chain against the 2-level rule (empty: it holds)
 */

const LADDER = Object.freeze(['1m', '3m', '5m', '15m', '1h', '4h']);
const SHIPPED = '4h';

const at = i => (i >= 0 && i < LADDER.length ? LADDER[i] : null);

function chainOf(top) {
  const i = LADDER.indexOf(top);
  if (i < 0) return null;
  const [below, levels, setup, entry] = [at(i - 1), at(i - 1), at(i - 2), at(i - 4)];
  if (!below || !setup || !entry) return null;
  return Object.freeze({ top, name: `${top}/${setup}/${entry}`, bias: Object.freeze([top, below]), levels, setup, entry });
}

const TOPS = Object.freeze(LADDER.filter(tf => chainOf(tf)));

function chainError(value, where) {
  if (TOPS.includes(value)) return null;
  return `${where}: ${JSON.stringify(value)} is not a chain top (${TOPS.join(' or ')}: ${TOPS.map(t => chainOf(t).name).join(', ')}; the bias on it and the one below, the setup two ladder levels below the top, the entry two below the setup)`;
}

/** The chain against the 2-level rule on the ladder: each frame where the rule puts it. */
function twoLevelErrors(c) {
  if (!c || typeof c !== 'object') return ['not a chain'];
  const i = LADDER.indexOf(c.top);
  const out = [];
  const want = { bias: [at(i), at(i - 1)], levels: at(i - 1), setup: at(i - 2), entry: at(i - 4) };
  if (i < 0) out.push(`top ${c.top}: not on the ladder ${LADDER.join(', ')}`);
  if (JSON.stringify(c.bias) !== JSON.stringify(want.bias)) out.push(`bias ${JSON.stringify(c.bias)}: the top and the one below it are ${JSON.stringify(want.bias)}`);
  for (const k of ['levels', 'setup', 'entry']) if (c[k] !== want[k]) out.push(`${k} ${c[k]}: the 2-level rule puts it at ${want[k]}`);
  return out;
}

module.exports = { LADDER, TOPS, SHIPPED, chainOf, chainError, twoLevelErrors };
