'use strict';

/**
 * Displacement, one definition (the `displacement` skill). The owner's separation (2026-11-15): "Displacement measures
 * strength. Structure determines confirmation. Protected swings determine structural invalidation." So this module
 * reads STRENGTH only: a candle is `displaced` or `weak` (with why, from the rule's own parts). It never confirms (a
 * break confirms by structure: bos-vs-choch) and never invalidates (a close through the protected swing does:
 * structure-events.js protectedOf, a close past the tie: protected-status.js); it says how strongly a break, or the close that broke a protected
 * swing, moved. A read the briefing prints, never a setup or a wait: no gate, hook, compose, entry-rule or decision code
 * reads it (tests/plugin/displacement-readers.test.js). Pure and causal: a fact as of candle `at` reads candles 0..at
 * only. Every number is config's (config/analysis.json cisd.minBody, cisd.minRangeAtr and displacement).
 *
 * The rule is cisd.js strongCandle, imported here as candleDisplaced (cisd.js keeps its body, so CISD, the FVG's middle
 * candle and the Market state read it unchanged): the candle closes the way, its body is at least cisd.minBody of its
 * range, its close is in the extreme third, and its range is at least cisd.minRangeAtr x ATR(14) of its own timeframe
 * or its body engulfs the previous candle's. A break's candle reads ATR as known at the candle before (atr[i - 1]),
 * as structure-layers.js does, so its word is the Market state's `(displaced)` for the same break.
 *
 * The other homes of the same rule (tiers or uses, so none reads as a second definition):
 *   candle-facts.js `displacement` label  the large tier: body >= candles.dispBody, range >= candles.dispAtr x ATR of the
 *                                          candle before, in the candle's own colour; a subset of the rule (tested)
 *   market-snapshot.js fvgAt              the gap's middle candle, on ATR at the middle candle itself
 *   cisd.js displacementOf                the CISD's confirming candle (`strong` / `weak`), on ATR at the candle itself
 *   market-behavior.js behavior.disp      the window's candles strong in their own colour, on the window's current ATR
 *   setup-moments.js setupCandleRank      the briefing candle's rank: candle-facts' engulfing (a larger body too) and close
 *                                          third (a 1e-9 tolerance), not strongCandle's: a follow-up
 *   trade-read.js displacementOf          a label-tier candle closing through a confirmed swing against an open trade
 * At cisd.minRangeAtr 1.0 the ATR at the candle and at the candle before give the same word unless the candle gaps
 * (Wilder smoothing; tested).
 *
 *   PARAMS                                   the defaults: cisd.minBody, cisd.minRangeAtr, displacement.*, marketState.equalAtr
 *   candleDisplaced(k, prev, dir, atr, p)    cisd.js strongCandle (dir 1 up, -1 down)
 *   strengthAt(candles, i, dir, atr, p)      { displaced, why } of candle i the dir way, on atr[i - 1]; why: the parts that
 *                                            failed, in order: 'opposite colour', 'wicks' (body under minBody of the
 *                                            range), 'closed mid' (close not in the extreme third), 'small' (range under
 *                                            minRangeAtr x ATR and no engulfing); [] when displaced
 *   breakQuality({ candles, brk, atr, at, minutes, levels, p })   a structure-events break's facts as of candle `at`
 *                                            (null before the break): { displaced, why, cleared (close past the level in
 *                                            ATR), bodyX (body over the mean body of the bodyPrior candles before), leg {
 *                                            bars, eff, overlap } (the leg protectedLevel defines: from the protected swing
 *                                            to the break), origin { side, price, at, sweep } (the protected swing; sweep:
 *                                            structure-events sweeps of `levels` whose close back is in the leg, key
 *                                            levels first), fvg (the latest FVG the break's way, market-snapshot fvgAt,
 *                                            its middle candle in the leg or the break candle, back to back: { side, low,
 *                                            high, at, state 'open' | 'filled to' (to: how far) | 'filled' (traded
 *                                            through, kept: printed `traded through`) } or null), fvgPending (the break's
 *                                            own candle is the last: its gap needs the next candle), status { holding }
 *                                            | { closedBack { at, closedAt, barsAgo }, reclaimed } (the latest close back
 *                                            through the level; reclaimed: the last close is past the level again) }
 *   invalidationQuality(candles, brk, prot, atr, p)   the strength of the close that broke the break's protected swing
 *                                            (protected-status.js: the first close after the break past the tie,
 *                                            equalAtr x ATR of its candle; the record's brokenAt), the break's opposite
 *                                            way: { displaced, why, barsAgo }; { tie: true } when every close through it
 *                                            is within the tie (printed `holds (tested, a tie)`, as the state says
 *                                            holds); or null
 *   qualityOf(candles, lb, { minutes, levels, atr, p })   lastBreaks' { last, previous } with `quality` on last (and on
 *                                            last.protected once a close goes through it; its brokenAt is the record's,
 *                                            banded by the same predicate: structure-events.js protectedOf)
 *   breakLine({ entry, setup }, { p, et })   the summary's Break quality line (entry: { tf, brk, minutes }, setup the same
 *                                            with brk.knownAt), each printed while its break is at most recentEntry /
 *                                            recentSetup candles old; cut to lineBytes: body, then leg, then the setup
 *                                            frame, then the sweep note; null when nothing prints
 */

const cisd = require('./cisd');
const SE = require('./structure-events');
const PS = require('./protected-status');
const ind = require('./indicators');
const { fvgAt } = require('./market-snapshot');

const AN = require('../tunables').analysis();

// equalAtr: the Market state's tie at a protected level (config marketState.equalAtr), so both lines say one status.
const PARAMS = Object.freeze({ minBody: AN.cisd.minBody, minRangeAtr: AN.cisd.minRangeAtr, ...AN.displacement, equalAtr: AN.marketState.equalAtr });
const candleDisplaced = cisd.strongCandle;

const sgn = d => (d === 'up' ? 1 : -1);
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const range = c => c.h - c.l;

/** The parts of the rule a weak candle failed (strongCandle's own parts), in the rule's order. */
function whyWeak(sc, p) {
  return [
    sc.withDir ? null : 'opposite colour',
    sc.body >= p.minBody ? null : 'wicks',
    sc.extreme ? null : 'closed mid',
    sc.engulfing || (sc.rangeAtr !== null && sc.rangeAtr >= p.minRangeAtr) ? null : 'small',
  ].filter(Boolean);
}

function strengthAt(candles, i, dir, atr, p = PARAMS) {
  const sc = candleDisplaced(candles[i], i > 0 ? candles[i - 1] : null, dir, i > 0 && atr ? atr[i - 1] : NaN, p);
  return { displaced: sc.strong, why: sc.strong ? [] : whyWeak(sc, p) };
}

/** Back to back: each candle opens where the one before it closed (a gap across a break or a feed gap is no FVG). */
const adjacent = (cs, j, minutes) => !minutes || (Date.parse(cs[j].t) - Date.parse(cs[j - 1].t) === minutes * 60000);

/** The latest FVG the break's way with its middle candle in o..i, known by `at`, and what the candles since did to it. */
function fvgOf(cs, o, i, dir, atr, minutes) {
  for (let j = Math.min(i + 1, cs.length - 1); j >= o + 2; j -= 1) {
    if (!adjacent(cs, j, minutes) || !adjacent(cs, j - 1, minutes)) continue;
    const g = fvgAt(cs, j, atr);
    if (!g || (g.side === 'bullish') !== (dir > 0)) continue;
    const later = cs.slice(j + 1);
    const out = { side: g.side, low: g.low, high: g.high, at: g.at };
    if (!later.length) return { ...out, state: 'open' };
    const reach = dir > 0 ? Math.min(...later.map(c => c.l)) : Math.max(...later.map(c => c.h));
    if (dir > 0 ? reach < g.low : reach > g.high) return { ...out, state: 'filled' };
    if (dir > 0 ? reach >= g.high : reach <= g.low) return { ...out, state: 'open' };
    return { ...out, state: 'filled to', to: reach };
  }
  return null;
}

/** The leg o..i: its candles, efficiency (|close - origin| over the sum of ranges) and mean overlap with the candle before. */
function legOf(cs, o, i, origin) {
  let sum = 0; let ov = 0; let n = 0;
  for (let j = o; j <= i; j += 1) {
    sum += range(cs[j]);
    if (j > o && range(cs[j]) > 0) { ov += Math.max(0, Math.min(cs[j].h, cs[j - 1].h) - Math.max(cs[j].l, cs[j - 1].l)) / range(cs[j]); n += 1; }
  }
  return { bars: i - o + 1, eff: sum > 0 ? r2(Math.abs(cs[i].c - origin) / sum) : null, overlap: n ? r2(ov / n) : null };
}

function breakQuality({ candles, brk, atr = ind.atr(candles), at = candles.length - 1, minutes = null, levels = [], p = PARAMS }) {
  if (!brk || !['up', 'down'].includes(brk.direction) || !Array.isArray(candles)) return null;
  const cs = candles.slice(0, at + 1);
  const i = cs.findIndex(c => c.t === brk.at);
  if (i < 1) return null;
  const dir = sgn(brk.direction);
  const a = atr[i - 1];
  const s = strengthAt(cs, i, dir, atr, p);
  const prior = cs.slice(Math.max(0, i - p.bodyPrior), i).map(c => Math.abs(c.c - c.o));
  const mean = prior.length ? prior.reduce((x, y) => x + y, 0) / prior.length : 0;
  // The origin as known at the break: the protected swing (protectedLevel on the candles up to it).
  const prot = SE.protectedLevel(cs.slice(0, i + 1), brk);
  const o = prot ? cs.findIndex(c => c.t === prot.at) : -1;
  const side = dir > 0 ? 'low' : 'high';
  const swept = o >= 0 ? SE.sweeps(cs.slice(0, i + 1), levels.filter(x => x.side === side), i + 1)
    .filter(x => Date.parse(x.back) >= Date.parse(cs[o].t)) : [];
  let closedBack = null;
  const closeOf = c => (minutes ? new Date(Date.parse(c.t) + minutes * 60000).toISOString() : null);
  // The latest close back through the level (a close through it after one that was not), so its age is the current spell's.
  for (let j = i + 1; j < cs.length; j += 1) {
    if (dir * (cs[j].c - brk.level) < 0 && dir * (cs[j - 1].c - brk.level) >= 0) closedBack = { at: cs[j].t, closedAt: closeOf(cs[j]), barsAgo: cs.length - 1 - j };
  }
  return {
    ...s,
    cleared: Number.isFinite(a) && a > 0 ? r2(dir * (cs[i].c - brk.level) / a) : null,
    bodyX: mean > 0 ? r2(Math.abs(cs[i].c - cs[i].o) / mean) : null,
    leg: o >= 0 ? legOf(cs, o, i, prot.level) : null,
    origin: prot ? { side, price: prot.level, at: prot.at, sweep: swept.length ? { name: swept[0].name, price: swept[0].price } : null } : null,
    fvg: o >= 0 ? fvgOf(cs, o, i, dir, atr, minutes) : null,
    fvgPending: i === cs.length - 1,
    status: closedBack ? { closedBack, reclaimed: dir * (cs[cs.length - 1].c - brk.level) > 0 } : { holding: true },
  };
}

function invalidationQuality(candles, brk, prot, atr, p = PARAMS, minutes = null) {
  if (!brk || !prot || !Number.isFinite(prot.level) || !['up', 'down'].includes(brk.direction)) return null;
  // The one predicate (protected-status.js, the Market state's and the record's): a close through the level by no more
  // than equalAtr x ATR(14) of its candle is a tie, not a break, so the line says `holds` as the state does; the
  // invalidating close is the first past it, after the break (the whole series when the break's candle is not given).
  const after = brk.at ? candles.findIndex(c => c.t === brk.at) : -1;
  if (brk.at && after < 0) return null;
  const st = PS.statusOf(candles, { level: prot.level, legSide: brk.direction, after, atr: Array.isArray(atr) ? atr : [], equalAtr: p.equalAtr });
  if (!st.broken) return st.tied ? { tie: true } : null;
  const j = st.brokenI;
  if (j < 1) return null;
  const closedAt = minutes ? new Date(Date.parse(candles[j].t) + minutes * 60000).toISOString() : null;
  return { ...strengthAt(candles, j, -sgn(brk.direction), atr, p), barsAgo: candles.length - 1 - j, closedAt };
}

function qualityOf(candles, lb, { minutes = cisd.stepMinutes(candles), levels = [], atr = ind.atr(candles), p = PARAMS } = {}) {
  if (!lb || !lb.last) return lb;
  const last = lb.last;
  const quality = breakQuality({ candles, brk: last, atr, minutes, levels, p });
  // The record's brokenAt is already the first close past the tie (structure-events.js protectedOf, protected-status.js),
  // the same candle this read's close is (tests/lib/displacement-real.test.js): the detail's field says what the line says.
  const inv = last.protected ? invalidationQuality(candles, last, last.protected, atr, p, minutes) : null;
  return { ...lb, last: { ...last, ...(quality ? { quality } : {}), ...(inv ? { protected: { ...last.protected, quality: inv } } : {}) } };
}

const minsAgo = (n, m) => (n === 0 ? 'this bar' : `${n * m} min ago`);
const word = (dir, back) => ((dir === 'up') === back ? 'below' : 'above');

// What the line leaves out over lineBytes, in this order (`cleared`, the strength and the status are never cut).
const CUTS = Object.freeze(['body', 'leg', 'setup', 'sweep']);

/** One frame's clause; `cut`: the CUTS left out. */
function clause({ tf, brk, minutes }, cut, et) {
  const x = brk.quality;
  // The entry frame says how long ago (its bars are the briefing's); the setup frame (brk.knownAt) the candle's close time.
  // A setup clause without a close time (none given) says none, never a 3m age.
  const ago = (n, closedAt) => (brk.knownAt ? (closedAt ? `at ${et(closedAt)}` : '').trim() : minsAgo(n, minutes));
  const sp = t => (t ? ` ${t}` : '');
  const when = brk.knownAt ? `(closed ${et(brk.knownAt)})` : minsAgo(brk.barsAgo, minutes);
  const cb = x.status && x.status.closedBack;
  const st = cb ? `closed back ${word(brk.direction, true)} ${brk.level}${sp(ago(cb.barsAgo, cb.closedAt))}${x.status.reclaimed ? `, back ${word(brk.direction, false)} it since` : ''}` : 'holding';
  const fvg = x.fvg ? `FVG ${x.fvg.low}-${x.fvg.high} ${x.fvg.state === 'filled' ? 'traded through' : x.fvg.state === 'filled to' ? `filled to ${x.fvg.to}` : 'open'}`
    : x.fvgPending ? 'no FVG yet' : 'no FVG';
  const pr = brk.protected && brk.protected.quality;
  const held = pr && pr.tie ? 'holds (tested, a tie)' : pr ? `broken by a ${pr.displaced ? 'displaced' : 'weak'} close${pr.displaced ? '' : ` (${pr.why.join(', ')})`}${sp(ago(pr.barsAgo, pr.closedAt))}` : 'holds';
  const origin = x.origin ? `from protected ${x.origin.side} ${x.origin.price}${x.origin.sweep && !cut.has('sweep') ? ` (a sweep of ${x.origin.sweep.name} ${x.origin.sweep.price})` : ''}: ${held}` : null;
  const agrees = Number.isFinite(x.bodyX) && (x.displaced ? x.bodyX >= 1 : x.bodyX < 1);
  return [
    `${tf} ${brk.kind} ${brk.direction} ${brk.level} ${when}: ${x.displaced ? 'displaced' : `weak (${x.why.join(', ')})`}, ${st}`,
    x.cleared !== null && x.cleared !== undefined ? `cleared ${x.cleared} ATR` : null,
    fvg,
    origin,
    agrees && !cut.has('body') ? `body ${x.bodyX}x prior` : null,
    x.leg && !cut.has('leg') ? `leg ${x.leg.bars} bars, efficiency ${x.leg.eff}, overlap ${x.leg.overlap}` : null,
  ].filter(Boolean).join('; ');
}

const HEAD = '- Break quality (strength, not a forecast; `displacement`): ';

function breakLine({ entry = null, setup = null } = {}, { p = PARAMS, et = x => x } = {}) {
  const shown = (f, recent) => Boolean(f && f.brk && f.brk.quality && Number.isInteger(f.brk.barsAgo) && f.brk.barsAgo <= recent);
  const frames = [shown(entry, p.recentEntry) ? entry : null, shown(setup, p.recentSetup) ? setup : null].filter(Boolean);
  if (!frames.length) return null;
  let line = '';
  for (let n = 0; n <= CUTS.length; n += 1) {
    const cut = new Set(CUTS.slice(0, n));
    const fs = cut.has('setup') ? frames.slice(0, 1) : frames;
    line = `${HEAD}${fs.map(f => clause(f, cut, et)).join('; ')}.`;
    if (Buffer.byteLength(line) <= p.lineBytes) return line;
  }
  return line;
}

module.exports = { PARAMS, CUTS, candleDisplaced, strengthAt, breakQuality, invalidationQuality, qualityOf, breakLine };
