'use strict';

/**
 * The Market state: what the 3m market is doing at this bar, from the owner's three layers (round 20: internal
 * structure, protected structure, price behavior; market-layers.js computes them into the briefing's m3.layers), the
 * precedence applied once, printed as one summary line with the 4h + 1h beside it and the class at its end. A read, not
 * a filter: no gate, hook, compose or decision code reads it (tests/plugin/market-state-readers.test.js); it is printed
 * in the summary and restated by the recognition key's coded read. Pure: no files, no clock; the thresholds passed in
 * (the crosses the line prints as context: config/analysis.json regime.rangeCrosses; the deepest pullback the state
 * counts: pullbackRead.maxStateDepth; the layers' own thresholds were applied when the briefing computed them).
 *
 * The state (3m), once, in this order (the owner's classes: Trend, Weakening, Transitioning, Chop, Reversal):
 *   forming        no RTH break yet (no session structure to read)
 *   pullback       an open pullback (pullback-read.js isOpen: never given back past its origin nor its 15m swing broken)
 *                  no deeper than maxPullbackDepth since its extreme: never chop (the owner: a pullback is never chop)
 *   rotation       that pullback with rotation evidence now (layers.pbRotation: open rotStale bars without a new extreme
 *                  and rotCross midpoint crossings, or its leg weakening); or an intact leg with no new extreme by close
 *                  for rotStale bars (layers.stale). No trend entry; never chop
 *   transition     the protected level broken by a close with displacement and follow-through, the new leg unconfirmed
 *                  (Transitioning)
 *   chop           the layers' chop (structural AND behavioral evidence, until displacement ends it), no pullback read
 *   weakening      an intact leg with the momentum trigger (a strong countertrend displacement breaking internal
 *                  structure); the protected level holds (Weakening: reduce confidence; wait)
 *   trend          an intact, established leg with the behavior word `trending` (Trend; "reversal confirmed" printed when
 *                  the leg's flip is recent and held: Reversal)
 *   leg            an intact, established leg otherwise ("in the up leg": a pullback or a range inside the trend)
 *   range          no established leg (no chop evidence)
 * The early read (the 15m trending the 4h + 1h way, the 3m in an established leg against them; without layers its last
 * RTH break a BOS against): printed, blocks chop and
 * keeps the trend class, as the pullback does.
 *
 * Without m3.layers (an older record, a quiz item built from printed lines): the printed breaks and protected swings
 * alone, in the same words: forming, pullback, `leg` (the last RTH break a BOS whose protected swing holds, or a CHoCH
 * confirmed by a later live 3m CISD or a close beyond the IB it rotated in), else `range`. No behavior read, so no chop,
 * weakening or rotation there.
 *
 *   readState(b, th)    { state, way, align, frames, m15, pullback, early, layers, last, previous, context, tf, ... } on
 *                       any briefing (no lane guard); th { crossesChop, maxPullbackDepth }, both required; th.lineBytes (optional)
 *                       the line's byte budget: over it the behavior numbers drop, then the chop's "Day so far rotational"
 *   stateThresholds(an) the briefing's and the quiz's th from the analysis config
 *   stateOf(b, th)      readState, or null off the chain's entry frame or with no 1h part (as the Bias line)
 *   classWordOf(s)      chop -> chop; rotation, weakening -> unclear; not aligned -> unclear; a pullback of a leg the
 *                       4h + 1h way, or the early read -> that trend class; forming, range -> the 4h + 1h trend class
 *                       (the alignment default: a range day is tradeable at the edge or on a breakout the side's way);
 *                       trend, leg, transition the 4h + 1h way -> that trend class, against -> unclear
 *   marketStateLine(s)  "Market state (3m): <state>: <structure>; <momentum>; behavior <word> (...), 15m <word>;
 *                       <alignment>; class <c>", the class last (round 18); the behavior word only under rotation,
 *                       weakening and transition (round 20b; elsewhere "overlap x, efficiency y, 15m <word>"); null for null
 */

const { trendOf } = require('./entry-rule');
const { RULE } = require('./bias-line');
const { isOpen, pullbackWord } = require('./pullback-read');
const { label } = require('./mtf');
const { MARKET_TZ, RTH_OPEN_MIN, tradingDayStart, sessionMinuteOf } = require('./clock');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const data = (b, s) => (isObj(b) && isObj(b.sections) && isObj(b.sections[s]) && isObj(b.sections[s].data) ? b.sections[s].data : {});
const DEAD_CISD = new Set(['void', 'expired', 'weak']); // cisd.js DEAD: no zone, no entry
const CISD_WAY = { bullish: 'up', bearish: 'down' };
const LEG_WAY = { long: 'up', short: 'down' };
const DIRS = { up: true, down: true };
const swingName = side => (side === 'up' ? 'HL' : 'LH');

/** A lone RTH CHoCH confirmed its way (the owner: a CHoCH followed by a same-direction CISD, or a close beyond the range). */
function turnOf({ last, previous, cisd3m, today, price, minutes } = {}) {
  if (!isObj(last) || last.kind !== 'CHoCH') return null;
  const c = isObj(cisd3m) ? cisd3m : null;
  if (c && CISD_WAY[c.dir] === last.direction && !DEAD_CISD.has(c.status) && Date.parse(c.confirmedClose) > Date.parse(last.at) + minutes * 60000) return { by: 'cisd', dir: last.direction };
  const t = isObj(today) ? today : {};
  if (!Number.isFinite(t.ibHigh) || !Number.isFinite(t.ibLow) || !Number.isFinite(price) || !isObj(previous) || !Number.isFinite(previous.level)) return null;
  if (previous.level < t.ibLow || previous.level > t.ibHigh) return null;
  if (last.direction === 'up' && price > t.ibHigh) return { by: 'range', dir: 'up', edge: 'IB high', price: t.ibHigh };
  if (last.direction === 'down' && price < t.ibLow) return { by: 'range', dir: 'down', edge: 'IB low', price: t.ibLow };
  return null;
}

/** The state from the layers (round 20), the precedence once. */
function layeredWord(L, { open, read, pb }) {
  const P = isObj(L.structure) ? L.structure : null;
  const legOK = Boolean(P && P.legOK);
  if (!P) return open ? { state: 'pullback', way: LEG_WAY[pb.side] } : { state: 'forming', way: null };
  if (open) return L.pbRotation ? { state: 'rotation', way: LEG_WAY[pb.side], of: 'pullback' } : { state: 'pullback', way: LEG_WAY[pb.side] };
  if (L.transition) return { state: 'transition', way: P.side };
  if (isObj(L.chop) && L.chop.inChop && !read) return { state: 'chop', way: null };
  if (legOK && isObj(L.momentum) && L.momentum.trigger) return { state: 'weakening', way: P.side };
  if (legOK && L.stale && !read) return { state: 'rotation', way: P.side, of: 'leg' };
  if (legOK && isObj(L.behavior) && L.behavior.word === 'trending') return { state: 'trend', way: P.side };
  if (legOK) return { state: 'leg', way: P.side };
  return { state: 'range', way: null };
}

/** The state from the printed breaks alone (no layers: an older record, a quiz item). */
function printedWord({ last, open, pb, forming, broken, turn }) {
  if (forming) return open ? { state: 'pullback', way: LEG_WAY[pb.side] } : { state: 'forming', way: null };
  if (open) return { state: 'pullback', way: LEG_WAY[pb.side] };
  if (isObj(last) && last.kind === 'BOS' && DIRS[last.direction] && !broken) return { state: 'leg', way: last.direction };
  if (turn) return { state: 'leg', way: turn.dir };
  return { state: 'range', way: null };
}

function readState(b, th = {}) {
  if (!Number.isFinite(th.crossesChop)) throw new Error('market-state: crossesChop is required (a config value, never a literal)');
  if (!Number.isFinite(th.maxPullbackDepth)) throw new Error('market-state: maxPullbackDepth is required (a config value, never a literal)');
  const frames = Object.fromEntries(RULE.biasFrames.map(tf => [tf, trendOf(b, tf)]));
  const ts = Object.values(frames);
  const align = ts.every(t => t === 'up') ? 'up' : ts.every(t => t === 'down') ? 'down' : null;
  const m3 = data(b, 'm3');
  // The state's pullback: open and no deeper than the Depth row's bound since its extreme (sticky maxDepth), any side.
  let open;
  try {
    const deepest = Number.isFinite(m3.pullback.maxDepth) ? m3.pullback.maxDepth : m3.pullback.depth;
    open = isOpen(m3.pullback) && !(Number.isFinite(deepest) && deepest > th.maxPullbackDepth);
  } catch (_err) { open = false; }
  const pb = open ? m3.pullback : null;
  const lb = isObj(m3.lastBreak) ? m3.lastBreak : {};
  const minutes = Number.isInteger(b.minutes) ? b.minutes : 3;
  // The RTH breaks: only breaks whose candle closed at or after 09:30 ET of the decision's trading day (no close time: every break).
  const closedMs = Date.parse(b.closedAt);
  const rthOpen = Number.isFinite(closedMs) ? tradingDayStart(new Date(closedMs)).getTime() + sessionMinuteOf({ minute: RTH_OPEN_MIN, timeZone: MARKET_TZ }, new Date(closedMs)) * 60000 : null;
  const closeOf = x => Date.parse(x.at) + minutes * 60000; // a break's candle closes a bar after its open
  const rth = x => isObj(x) && (rthOpen === null || closeOf(x) >= rthOpen);
  const last = rth(lb.last) ? lb.last : null;
  const previous = last && rth(lb.previous) ? lb.previous : null;
  const broken = isObj(last) && isObj(last.protected) && Number.isFinite(Date.parse(last.protected.brokenAt))
    && (!Number.isFinite(closedMs) || Date.parse(last.protected.brokenAt) < closedMs);
  const m15 = trendOf(b, RULE.chain.setup);
  const L = isObj(m3.layers) && Number.isInteger(m3.layers.rthBars) ? m3.layers : null;
  // The early read: the 3m trending against the aligned 15m: from the layers, an established 3m leg against them; without
  // layers, the last RTH break a BOS against, its protected swing holding (a CHoCH against is no early read there).
  const P3 = L && isObj(L.structure) ? L.structure : null;
  const early = !open && Boolean(align) && m15 === align && (L ? Boolean(P3 && P3.legOK && P3.side !== align)
    : isObj(last) && last.kind === 'BOS' && !broken && DIRS[last.direction] === true && last.direction !== align);
  const today = isObj(m3.today) ? m3.today : {};
  let w;
  let turn = null;
  if (L) w = layeredWord(L, { open, read: open || early, pb });
  else {
    turn = broken ? null : turnOf({ last, previous, cisd3m: isObj(m3.cisd) ? m3.cisd['3m'] : null, today, price: m3.price, minutes });
    w = printedWord({ last, open, pb, forming: rthOpen !== null && !last, broken, turn });
  }
  const d = isObj(today.soFar) ? today.soFar : {};
  const crosses = Number.isFinite(d.vwapCrosses) ? d.vwapCrosses : null;
  const context = { rotational: d.status === 'read' && d.read === 'rotational', crosses: crosses !== null && crosses >= th.crossesChop ? crosses : null };
  const age = last && Number.isFinite(closedMs) ? Math.round((closedMs - (Date.parse(last.at) + minutes * 60000)) / 60000) : null;
  return {
    state: w.state, way: w.way, of: w.of || null, align, frames, m15, pullback: pb, early, layers: L, last, previous, broken, turn, context, age,
    price: Number.isFinite(m3.price) ? m3.price : null, minutes, tf: label(minutes), lineBytes: Number.isFinite(th.lineBytes) ? th.lineBytes : null,
  };
}

function stateOf(b, th) {
  if (!isObj(b) || !isObj(b.sections) || !b.sections.h1) return null;
  if (!(Number.isInteger(b.minutes) && label(b.minutes) === RULE.chain.entry)) return null;
  return readState(b, th);
}

function classWordOf(s) {
  if (!isObj(s)) return null;
  if (s.state === 'chop') return 'chop';
  if (s.state === 'rotation' || s.state === 'weakening') return 'unclear';
  if (!s.align) return 'unclear';
  if (s.state === 'pullback') return s.way === s.align ? `trend-${s.align}` : 'unclear';
  if (s.early === true || s.state === 'range' || s.state === 'forming') return `trend-${s.align}`;
  return s.way === s.align ? `trend-${s.align}` : 'unclear';
}

// ---- the printed line ----

const pbText = p => `pullback (${p.side} leg ${p.leg.origin} -> ${p.leg.extreme}, ${String(pullbackWord(p) || 'depth unknown').split(',')[0]})`;
const mins = (bars, m) => bars * m;
const ago = n => (n === 0 ? 'this bar' : n === 1 ? '1 bar ago' : `${n} bars ago`);
const minsAgo = (n, m) => (n === 0 ? 'this bar' : `${n * m} min ago`);
// A break against at the protected level itself: a close through it that came back (this break's own protected break, at
// this level and bar, failed: the leg resumed), or a close within the tie tolerance (decision 8: no break). Never
// "internal". `resumed` is the leg's flag, so the flip decides it per break (re-review of fe35c98b8, finding 1).
const closedBack = (P, barsAgo) => Boolean(P.resumed && isObj(P.flip) && !P.flip.held && P.flip.byRule === 'close' && P.flip.oldLevel === P.level && P.flip.barsAgo === barsAgo);
const atLevelText = (P, barsAgo) => (closedBack(P, barsAgo) ? `through the ${swingName(P.side)}, closed back` : `tested the ${swingName(P.side)} (a tie)`);

/** The protected structure clause from the layers' snapshot. */
function structureText(P, s, { brief = false } = {}) {
  if (!P) return '';
  if (P.status === 'broken') {
    const f = P.flip;
    return `${swingName(f.oldSide)} ${f.oldLevel} broken by a ${f.disp ? 'displaced ' : ''}close ${minsAgo(f.barsAgo, s.minutes)}, the new leg unconfirmed`;
  }
  const parts = [`${swingName(P.side)} ${P.level} holds`];
  if (brief) return parts[0];
  const w = P.lastWay;
  if (w && (!P.lastInternal || w.barsAgo <= P.lastInternal.barsAgo)) parts.push(`${w.kind} ${w.direction} ${minsAgo(w.barsAgo, s.minutes)}${w.strong ? ' (displaced)' : ''}`);
  else if (P.lastInternal && !(s.layers.momentum && s.layers.momentum.trigger)) parts.push(P.lastInternal.level === P.level ? atLevelText(P, P.lastInternal.barsAgo) : `internal ${P.lastInternal.direction === 'up' ? 'high' : 'low'} ${P.lastInternal.level} broken`);
  if (P.flip && P.flip.byRule === 'choch-bos' && P.flip.barsAgo === (w ? w.barsAgo : -1)) parts.push('CHoCH then BOS');
  if (s.layers.reversal) parts.push('reversal confirmed');
  return parts.join(', ');
}

/** The momentum clause (the owner's second read beside the structure): pressure, the weakening trigger, loss of control, the opening drive. */
function momentumText(L, P, s) {
  const m = L.momentum;
  if (!isObj(m) || !P || P.status !== 'intact') return '';
  const out = [];
  const against = P.side === 'up' ? 'down' : 'up';
  const brk = m.breakAgainst;
  // A break against at the protected level itself is no internal break (design review section 5): atLevelText.
  const atLevel = brk && brk.level === P.level;
  if (m.trigger && brk && atLevel) out.push(`${m.dispAgainst || brk.strong ? 'displacement' : 'a move'} ${against} ${ago(brk.barsAgo)} ${atLevelText(P, brk.barsAgo)}`);
  else if (m.trigger && brk) out.push(`${m.dispAgainst || brk.strong ? 'displacement' : 'a move'} ${against} ${ago(brk.barsAgo)} broke internal ${against === 'down' ? 'low' : 'high'} ${brk.level}`);
  else if (m.dispAgainst) out.push(`displacement ${against} ${ago(m.dispAgainst.barsAgo)}`);
  if (m.loss) out.push(P.lastWay && P.lastWay.failed ?`the last ${P.lastWay.kind} ${P.side} failed` : `no new ${P.side === 'up' ? 'high' : 'low'} for ${mins(P.sinceProgress, s.minutes)} min`);
  if (m.odf) out.push('potential failed opening drive');
  return out.filter(Boolean).join(', ');
}

// The behavior word is printed only where it is the state's evidence (round 20b: it reads `trending` on a minority of a
// running leg's bars, so beside a trend, a leg, a pullback or a range it misleads); there the numbers and the 15m word stay.
const WORD_STATES = new Set(['rotation', 'weakening', 'transition']);
function behaviorText(L, state) {
  const b = L.behavior;
  if (!isObj(b)) return '';
  const nums = [Number.isFinite(b.overlap) ? `overlap ${b.overlap}` : null, Number.isFinite(b.eff) ? `efficiency ${b.eff}` : null].filter(Boolean);
  if (!WORD_STATES.has(state)) return `${nums.length ? `${nums.join(', ')}, ` : ''}15m ${b.word15}`;
  return `behavior ${b.word}${nums.length ? ` (${nums.join(', ')})` : ''}, 15m ${b.word15}`;
}

/** The chop's evidence, structural then behavioral (the owner's checklist answered by what was yes). */
function chopText(L) {
  const c = L.chop || {};
  const ev = c.evidence || {};
  const st = [ev.bothWays ? 'breaks both ways' : null, ev.flip ? 'a protected break' : null, ev.failed ? 'a failed break' : null].filter(Boolean);
  const f = c.facts || {};
  const b = L.behavior || {};
  const be = [f.ov ? `overlap ${b.overlap}` : null, f.ef ? `efficiency ${b.eff}` : null, f.fl ? 'failed continuation' : null, f.nd ? 'no displacement' : null].filter(Boolean);
  return `no leg holds${st.length ? ` (${st.join(', ')})` : ''}; ${be.join(', ')}; 15m ${b.word15 || 'early'}`;
}

function layeredLine(s) {
  const L = s.layers;
  const P = isObj(L.structure) ? L.structure : null;
  const parts = [];
  if (s.state === 'forming') parts.push('forming (no RTH structure yet)');
  else if (s.state === 'pullback') parts.push(`${pbText(s.pullback)}${P ? `: 3m ${P.side} leg, ${structureText(P, s, { brief: true })}` : ''}`);
  else if (s.state === 'rotation' && s.of === 'pullback') {
    const ph = L.pbPhase || {};
    parts.push(`rotation: ${pbText(s.pullback)}, ${ph.bars} bars, ${ph.crosses} midpoint crosses${L.momentum && L.momentum.trigger && P && P.side === s.way ? `, the ${s.way} leg weakening` : ''}`);
  } else if (s.state === 'chop') parts.push(`chop: ${chopText(L)}`);
  else if (s.state === 'range') {
    const e = L.edges;
    const broken = P && P.status === 'broken' ? `, ${swingName(P.flip.oldSide)} ${P.flip.oldLevel} broken ${minsAgo(P.flip.barsAgo, s.minutes)}` : '';
    parts.push(`range: no leg holds${broken}${e ? `, edges ${e.bot}-${e.top} (${e.interior === 0 ? 'travel edge to edge' : 'fails mid-range'})` : ''}`);
  } else {
    const word = { transition: `transition ${s.way}`, weakening: `weakening ${s.way}`, rotation: `rotation ${s.way}`, trend: `trend ${s.way}`, leg: `in the ${s.way} leg` }[s.state];
    parts.push(`${word}: ${structureText(P, s, { brief: s.state === 'rotation' })}${s.state === 'rotation' ? `, no new ${s.way === 'up' ? 'high' : 'low'} for ${mins(P.sinceProgress, s.minutes)} min` : ''}`);
    const mo = s.state === 'rotation' ? '' : momentumText(L, P, s);
    if (mo) parts.push(mo);
  }
  if (s.state !== 'forming' && s.state !== 'chop') { const bt = behaviorText(L, s.state); if (bt) parts.push(bt); }
  return parts;
}

function printedLine(s) {
  const pr = isObj(s.last) && isObj(s.last.protected) && Number.isFinite(s.last.protected.level) ? s.last.protected : null;
  const l = s.last;
  if (s.state === 'forming') return ['forming (no RTH structure yet)'];
  const pair = l && isObj(s.previous) && DIRS[s.previous.direction] ? `${s.previous.kind} ${s.previous.direction} then ` : '';
  const brk = l ? `3m ${pair}${l.kind} ${l.direction}` : '';
  if (s.state === 'pullback') return [`${pbText(s.pullback)}${l ? `: ${brk}` : ''}`];
  if (!l) return ['range: no 3m break printed'];
  const up = l.direction === 'up';
  if (s.state === 'leg' && l.kind === 'BOS') return [`in the ${s.way} leg: ${brk}${Number.isFinite(s.age) ? `, ${s.age} min ago` : ''}${pr ? `, ${swingName(l.direction)} ${pr.level} holds` : ''}`];
  if (s.state === 'leg') return [`in the ${s.way} leg: ${brk}, then ${s.turn.by === 'cisd' ? `a 3m CISD ${s.turn.dir}` : `a close ${s.turn.dir === 'up' ? 'above' : 'below'} the ${s.turn.edge} ${s.turn.price}`} (confirmed)`];
  if (l.kind === 'BOS') return [`range: ${brk}${pr ? `, ${swingName(l.direction)} ${pr.level} broken by a close` : ''}`];
  const status = !pr ? 'unconfirmed' : s.broken ? `failed: a close ${up ? 'below' : 'above'} its origin ${pr.level}` : `unconfirmed, holds ${up ? 'above' : 'below'} ${pr.level} (origin)`;
  return [`range: ${brk} (${status})`];
}

function marketStateLine(s) {
  if (!isObj(s)) return null;
  const align = s.align ? `4h+1h ${s.align}` : `${Object.entries(s.frames).map(([tf, t]) => `${tf} ${t || 'unknown'}`).join(', ')} (not aligned)`;
  const parts = s.layers ? layeredLine(s) : printedLine(s);
  if (s.early === true) parts.push(`${RULE.chain.setup} ${s.align}: a pullback in the ${RULE.chain.setup} trend`);
  const ctx = s.state === 'chop' ? [s.context.rotational ? 'Day so far rotational' : null, s.context.crosses !== null ? `RTH VWAP crosses ${s.context.crosses}` : null].filter(Boolean) : [];
  if (ctx.length) parts.push(ctx.join(', '));
  // The class code computes (round 18, owner): printed at the end, one source (classWordOf), on every line.
  const full = `Market state (${s.tf}): ${[...parts, align].join('; ')}; class ${classWordOf(s)}`;
  // The line's budget (th.lineBytes, config/analysis.json marketState): over it, cut in order until it fits.
  return fitLine(full, s.lineBytes);
}

// Over the budget, in order: the behavior clause's numbers drop; the chop's "Day so far rotational" drops (the chop line
// says it; its numbers are its evidence and stay).
const CUTS = [
  l => l.replace(/ \((?:overlap [\d.]+(?:, efficiency [\d.]+)?|efficiency [\d.]+)\)/, '').replace(/; (?:overlap [\d.]+, )?(?:efficiency [\d.]+, )?(?=15m )/, '; '),
  l => l.replace('; Day so far rotational, ', '; ').replace('; Day so far rotational;', ';'),
];
function fitLine(full, budget) {
  let out = full;
  for (const cut of CUTS) { if (!Number.isFinite(budget) || Buffer.byteLength(out) <= budget) break; out = cut(out); }
  return out;
}

/** The Market state thresholds from the analysis config (config/analysis.json): the briefing's and the quiz's one set. */
const stateThresholds = an => ({ crossesChop: an.regime.rangeCrosses, maxPullbackDepth: an.pullbackRead.maxStateDepth, lineBytes: an.marketState.lineBytes });

module.exports = { turnOf, readState, stateOf, classWordOf, marketStateLine, stateThresholds };
