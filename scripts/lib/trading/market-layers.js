'use strict';

/**
 * The Market state's three layers at this bar, from the bars (round 20): the briefing computes them into m3.layers and
 * market-state.js reads them from the briefing (the recognition key and the quiz read recorded briefings). Pure, causal:
 * every fact at a bar reads only the bars up to it; the chop memory (decision 6: chop ends only on displacement) is a
 * scan over today's RTH bars inside the function, each bar's facts as of that bar. Thresholds passed in
 * (config/analysis.json marketState; the chop floor daySoFar.minBars; the IB's bars from dayContext.ibMinutes).
 *
 *   marketLayers({ bars, minutes, setupMinutes, closedAt, pullback, p, floor, ibBars })   null without bars or a clock; else
 *     { rthBars, structure (structure-layers.js snapshot, null before the first RTH break), lastBreak (the last RTH break:
 *     { kind, direction, level, barsAgo, strong, failed }), momentum { dispAgainst, breakAgainst, trigger, loss, odf, od },
 *     behavior { word, word15, overlap, eff, netAtr, disp }, chop { now, inChop, S, B, facts { ov, ef, fl, nd },
 *     evidence { bothWays, flip, failed }, ended }, edges { top, bot, atTop, atBot, interior }, pbPhase { bars, crosses },
 *     transition, stale (an intact leg with no new extreme by close for rotStale bars), reversal, pbRotation }; `trace`
 *     (tests and studies only) adds the scan's per-bar chop memory { k, inChop, now, ended }
 *
 * Chop (the owner: "Use CHoCH as structural evidence and overlap, displacement, and failed continuation as behavioral
 * evidence"): S = no leg holds AND, newer than the last end event and within structBars, breaks both ways, a protected
 * break, or a failed break; B = no clean displaced break AND >= chopMinFacts of overlap, low efficiency, failed
 * continuation (a failed break within edgeBars or rejectMin rejections at one edge), no displacement, on at least `floor`
 * RTH bars. It persists until an end event: a displaced break at the bar, a strong 3m CISD confirmed at the bar, a
 * displaced close beyond the IB, or a transition (the protected level broken with displacement and follow-through).
 * The opening-drive failure (the owner's A failed continuation, B rejection or overlap, C opposing displacement, on the
 * day's first leg while bar < odBars) is a printed fact; it changes no class on its own (decision 6).
 */

const C = require('./cisd');
const ind = require('./indicators');
const L = require('./structure-layers');
const MB = require('./market-behavior');
const { completedCandlesAt } = require('./candle-facts');
const { MARKET_TZ, RTH_OPEN_MIN, tradingDayStart, sessionMinuteOf } = require('./clock');

const KEYS = ['behaviorBars', 'edgeBars', 'structBars', 'followBars', 'dispBars', 'm15Bars', 'equalAtr', 'interior', 'overlapHigh', 'effLow', 'rejectMin', 'chopMinFacts',
  'pressBars', 'lossStale', 'rotStale', 'rotCross', 'odStart', 'odBars', 'odStale', 'trendNetAtr', 'earlyBars', 'early15'];

/** The bar index whose candle closes at 09:30 ET of the trading day of `closedMs` (its breaks are RTH breaks), or null. */
function rthFrom(bars, minutes, closedMs) {
  const at = new Date(closedMs);
  const open = tradingDayStart(at).getTime() + sessionMinuteOf({ minute: RTH_OPEN_MIN, timeZone: MARKET_TZ }, at) * 60000;
  if (closedMs < open) return null;
  const i = bars.findIndex(b => Date.parse(b.t) >= open - minutes * 60000);
  return i < 0 ? null : { from: i, open };
}

/** The bars where a 3m CISD with a strong displacement was confirmed (cisd.js, the briefing's own detection, causal). */
function cisdEnds(bars, minutes) {
  const step = C.stepMinutes(bars, minutes);
  const built = C.candlesOf(bars, minutes, step);
  if (built.unavailable) return new Set();
  const cs = built.candles;
  const atrTf = ind.atr(cs);
  const out = new Set();
  for (const ev of C.findCisds(cs, C.PARAMS)) {
    const k = C.knownAt(bars, cs[ev.confirm], minutes, step);
    if (k >= 0 && C.displacementOf(cs, ev.confirm, ev.dir, atrTf, C.PARAMS).strong) out.add(k);
  }
  return out;
}

/** The running-midpoint crossings of the closes after bar e (the phase's high-low so far, recomputed as it extends). */
function crossings(bars, e) {
  let hi = -Infinity; let lo = Infinity; let n = 0; let above = null;
  for (let i = e + 1; i < bars.length; i += 1) {
    hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l);
    const ab = bars[i].c > (hi + lo) / 2;
    if (above !== null && ab !== above) n += 1;
    above = ab;
  }
  return n;
}

/**
 * The chop rule at one bar (the owner's refinement: "Don't classify a market as chop simply because you see two opposing
 * CHoCHs. Equally, don't require two CHoCHs before recognizing chop."): S (structural) = no leg holds, no transition, and
 * among the breaks newer than the last end event and within structBars: breaks both ways, a protected break, or a failed
 * break (a failed break dated at its failure); B (behavioral) = no clean displaced break AND >= chopMinFacts of the four
 * facts (overlap, low efficiency, failed continuation, no displacement) AND at least `floor` RTH bars. breaks: the RTH
 * breaks by this bar, oldest first, { direction, barsAgo, strong, failed }.
 */
function chopAt({ snap, breaks, beh, edges, rthBars, sinceEnd }, p, floor) {
  const lb = breaks[breaks.length - 1] || null;
  const cleanBreak = Boolean(lb && lb.strong && !lb.failed);
  const ov = Boolean(beh && beh.overlap !== null && beh.overlap >= p.overlapHigh);
  const ef = Boolean(beh && beh.eff !== null && beh.eff < p.effLow);
  const failedIn = breaks.filter(b => b.failed && b.barsAgo < p.edgeBars).length;
  const fl = failedIn >= 1 || Boolean(edges && Math.max(edges.atTop, edges.atBot) >= p.rejectMin);
  const nd = Boolean(beh && beh.disp === 0 && !(lb && lb.strong));
  const count = [ov, ef, fl, nd].filter(Boolean).length;
  const B = !cleanBreak && count >= p.chopMinFacts && rthBars >= floor;
  const trans = Boolean(snap && snap.status === 'broken' && snap.flip && snap.flip.disp && snap.flip.held && snap.flip.barsAgo <= p.structBars);
  const age = (barsAgo, isFailed) => (isFailed ? Math.max(0, barsAgo - p.followBars) : barsAgo);
  const recent = breaks.filter(b => b.barsAgo < p.structBars && age(b.barsAgo, b.failed) < sinceEnd);
  const bothWays = recent.some(b => b.direction === 'up') && recent.some(b => b.direction === 'down');
  const failedRecent = recent.some(b => b.failed);
  const flipRecent = Boolean(snap && snap.flip && snap.flip.barsAgo < p.structBars && age(snap.flip.barsAgo, !snap.flip.held) < sinceEnd);
  const S = Boolean(snap && !snap.legOK && !trans && (bothWays || flipRecent || failedRecent));
  return { S, B, now: S && B, trans, facts: { ov, ef, fl, nd }, count, evidence: { bothWays, flip: flipRecent, failed: failedRecent } };
}

/**
 * Decision 6, chop ends only on displacement: a displaced 3m break at this bar, a strong 3m CISD confirmed at this bar, a
 * displaced close beyond the IB (once complete), or a transition (the protected level broken with displacement and
 * follow-through).
 */
function endedAt({ breakNow, breakStrong, cisd, transition, ib, barStrong, close }) {
  return Boolean((breakNow && breakStrong) || cisd || transition || (ib && barStrong && (close > ib.high || close < ib.low)));
}

/** The chop memory: chop now, or chop before with no end event since; an end event at this bar ends it, fresh evidence or not. */
const chopNext = ({ structure, now, ended, prev }) => Boolean(structure) && !ended && Boolean(now || prev);

function marketLayers({ bars, minutes, setupMinutes, closedAt, pullback = null, p, floor, ibBars, trace = false }) {
  for (const k of KEYS) if (!Number.isFinite((p || {})[k])) throw new Error(`market-layers: ${k} is required (config/analysis.json marketState)`);
  if (!Number.isFinite(floor) || !Number.isFinite(ibBars) || !Number.isFinite(setupMinutes)) throw new Error('market-layers: floor, ibBars and setupMinutes are required (config)');
  const closedMs = Date.parse(closedAt);
  if (!Array.isArray(bars) || bars.length <= 1 || !Number.isFinite(closedMs)) return null;
  const r = rthFrom(bars, minutes, closedMs);
  const n = bars.length;
  if (!r || r.from >= n - 1) return { rthBars: 0, structure: null };
  const { from } = r;
  const atr = ind.atr(bars);
  const breaks = L.rthBreaks(bars, from, atr, p);
  const series = L.structureSeries(bars, breaks, from, atr, p);
  const ends = cisdEnds(bars, minutes);
  const rth = bars.slice(from + 1);
  let inChop = false; let lastEnd = null; let firstLeg = null; let cur = null;
  const rows = [];
  for (let k = from + 1; k < n; k += 1) {
    const ri = k - from - 1;
    const snap = series[k];
    if (snap && !firstLeg) firstLeg = { bar: ri, side: snap.side };
    const seen = breaks.filter(b => b.i <= k);
    const failed = b => L.failedAt(bars, b, k, p);
    const lb = seen[seen.length - 1] || null;
    const upto = rth.slice(0, ri + 1);
    const beh = MB.behavior(upto, p.behaviorBars, atr[k]);
    const edges = MB.rejections(upto, p.edgeBars, p.equalAtr * atr[k], p);
    const c = chopAt({ snap, breaks: seen.map(b => ({ direction: b.direction, barsAgo: k - b.i, strong: b.strong, failed: failed(b) })), beh, edges, rthBars: ri + 1, sinceEnd: lastEnd === null ? Infinity : ri - lastEnd }, p, floor);
    const { S, B, now, trans } = c;
    const ib = ri >= ibBars - 1 ? { high: Math.max(...rth.slice(0, ibBars).map(x => x.h)), low: Math.min(...rth.slice(0, ibBars).map(x => x.l)) } : null;
    const strongBar = L.barStrong(bars, k, atr);
    const ended = endedAt({ breakNow: Boolean(lb && lb.i === k), breakStrong: Boolean(lb && lb.strong), cisd: ends.has(k), transition: trans, ib, barStrong: strongBar, close: bars[k].c });
    inChop = chopNext({ structure: Boolean(snap), now, ended, prev: inChop });
    if (ended) lastEnd = ri;
    if (trace) rows.push({ k, inChop, now, ended });
    if (k === n - 1) cur = { ri, snap, lb, beh, edges, facts: c.facts, bCount: c.count, S, B, now, ended, evidence: c.evidence, failed, trans };
  }
  const { ri, snap, lb, beh, edges } = cur;
  const z = n - 1;
  const mom = L.momentumAt(bars, breaks, snap, z, from, atr, p);
  // The opening-drive failure: the day's first leg (its first RTH break by bar odStart) while bar < odBars.
  const drive = Boolean(snap && snap.status === 'intact' && firstLeg && firstLeg.bar <= p.odStart && firstLeg.side === snap.side && ri < p.odBars);
  const lastWayFailed = Boolean(snap && snap.lastWay && snap.lastWay.failed);
  const od = drive ? {
    a: (snap.sinceProgress !== null && snap.sinceProgress >= p.odStale) || lastWayFailed,
    b: cur.facts.ov || Boolean(edges && (snap.side === 'up' ? edges.atTop : edges.atBot) >= p.rejectMin),
    c: Boolean(mom.dispAgainst),
  } : null;
  const word = MB.word3({ rthBars: ri + 1, beh, side: snap && snap.legOK ? snap.side : null, sinceProgress: snap ? snap.sinceProgress : null, loss: mom.loss, atr: atr[z] }, p);
  // The 15m beside it: today's completed 15m RTH candles, the last m15Bars, on the 15m candles' own ATR(14).
  let word15 = 'early';
  const c15 = completedCandlesAt({ bars, base: minutes, minutes: setupMinutes });
  if (!c15.unavailable) {
    const all15 = c15.candles.slice(0, c15.j + 1);
    const atr15 = ind.atr(all15)[all15.length - 1];
    word15 = MB.word15(MB.behavior(all15.filter(c => Date.parse(c.t) >= r.open), p.m15Bars, atr15), atr15, p);
  }
  let pbPhase = null;
  const e = pullback && pullback.leg && pullback.leg.at ? bars.findIndex(b => b.t === pullback.leg.at) : -1;
  if (e >= 0) pbPhase = { bars: z - e, crosses: crossings(bars, e) };
  const intact = Boolean(snap && snap.status === 'intact');
  // Decision 2: an open pullback with rotation evidence now (open rotStale bars with no new extreme and rotCross midpoint
  // crossings since its extreme, or the leg it belongs to weakening) is no longer read as the trend's pullback.
  const pbRotation = Boolean(pbPhase && ((pbPhase.bars >= p.rotStale && pbPhase.crosses >= p.rotCross)
    || (intact && snap.side === ({ long: 'up', short: 'down' })[pullback.side] && mom.trigger)));
  return {
    rthBars: ri + 1,
    structure: snap,
    lastBreak: lb ? { kind: lb.kind, direction: lb.direction, level: lb.level, barsAgo: z - lb.i, strong: lb.strong, failed: cur.failed(lb) } : null,
    momentum: { ...mom, odf: Boolean(od && od.a && od.b && od.c), od },
    behavior: { word, word15, overlap: beh ? beh.overlap : null, eff: beh ? beh.eff : null, netAtr: beh ? beh.netAtr : null, disp: beh ? beh.disp : null },
    chop: { now: cur.now, inChop, S: cur.S, B: cur.B, facts: cur.facts, count: cur.bCount, evidence: cur.evidence, ended: cur.ended },
    edges,
    pbPhase,
    transition: cur.trans,
    stale: Boolean(intact && snap.legOK && snap.sinceProgress !== null && snap.sinceProgress >= p.rotStale),
    reversal: Boolean(intact && snap.flip && snap.flip.held && snap.flip.barsAgo <= p.structBars && !snap.resumed),
    pbRotation,
    ...(trace ? { trace: rows } : {}),
  };
}

module.exports = { marketLayers, chopAt, endedAt, chopNext, rthFrom, cisdEnds, crossings, KEYS };
