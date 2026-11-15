'use strict';

/**
 * The Market state: what the 3m market is doing at this bar (the owner: "trend, chop, ranging"), computed from facts the
 * briefing already holds with the precedence applied once, printed as one summary line with the Pullback read and the
 * 4h + 1h alignment beside it. The model reads the state and the alignment and follows its row (trade-session's table)
 * instead of weighing two rule sets with exceptions to each other. A read, not a filter: no gate, hook, compose or
 * decision code reads it (tests/plugin/market-state-readers.test.js); it is printed in the summary and restated by the
 * recognition key's coded read. Pure: no files, no clock; the thresholds are passed in: the crosses the line prints a
 * context fact at (the briefing: config/analysis.json regime.rangeCrosses; the recognition key: its frozen
 * signals.crossesChop; a test pins them equal) and the deepest pullback the state counts (config/analysis.json
 * pullbackRead.maxStateDepth, every caller).
 *
 * Inputs, all causal and all already printed:
 *   the 3m breaks   m3.lastBreak last and previous ({ kind BOS | CHoCH, direction, level, at }): the owner's labels,
 *                   relative to the last break, as structure-events.js gives them: BOS the previous break's way (a
 *                   continuation), CHoCH a change of direction (a potential reversal); RTH breaks only: breaks whose
 *                   candle closed at or after 09:30 ET of the decision's trading day (none yet: forming; one: the rules
 *                   on it alone; no close time, a fixture: every break)
 *   the protected   each 3m break's protected swing (the briefing's m3.lastBreak.*.protected, structure-events.js
 *                   protectedOf: the origin of the leg that made it) and the first close through it: the last break a BOS
 *                   whose protected HL (LH) broke: the trend ended (ranging); a CHoCH whose origin broke: failed (printed;
 *                   its CISD turn no longer confirms it; no new chop condition); absent (an older record): as before
 *   the 15m         top-down (the owner: "a 15m BOS could look like a 3m CHoCH followed by another CHoCH"): its last
 *                   break a BOS the way the 3m pair ends, known (knownAt) at or after 09:30 ET and by the close (current
 *                   structure only: no premarket BOS, no frame trend)
 *   the turn        the last break a CHoCH confirmed its way: a live 3m CISD its way (m3.cisd['3m'], not void, expired
 *                   or weak) on a later 3m candle, or this bar's close beyond the initial balance's edge its way with the
 *                   previous break inside the IB (complete from 10:30 ET, so causal); a CHoCH then a BOS is a BOS
 *   the Pullback    pullback-read.js isOpen(m3.pullback): printed, never given back past its origin nor its 15m swing
 *                   broken since the extreme (sticky on the leg), and no deeper than th.maxPullbackDepth (the Depth row)
 *   the early read  the owner's "15min up trend, 3min down trend could mean pullback": the 15m frame trending the
 *                   4h + 1h way and the 3m trending against it (its last break a BOS against), no Pullback read yet
 *   the alignment   the rule's bias frames (4h, 1h) both one way, entry-rule.js trendOf, the trends the gate reads
 *   context         the Day so far `rotational` and its RTH VWAP crosses at or above the threshold: printed on a chop,
 *                   never a condition (the owner: "keep it simple and call it chop if it fails reversal")
 *
 * The state (3m), once:
 *   forming       the clock known and no RTH break yet (no session structure to read)
 *   chop          the last two breaks both CHoCH (a failed reversal: the direction changed, then changed back), no
 *                 pullback read active (no open Pullback line, no early read), the 15m not confirming the way it ends,
 *                 no confirmed turn
 *   trend <way>   the last break a BOS that way (a continuation, or a confirmed transition after a CHoCH; the line
 *                 prints its age), the pair the 15m confirms (the 15m continuation), or a CHoCH that way with its turn
 *                 confirmed
 *   ranging       neither (a CHoCH after a BOS, or the only RTH break a CHoCH: a potential reversal, unconfirmed; the
 *                 CHoCH pair inside a pullback read: the watch; no break printed)
 * The Pullback read is no state (the owner: "just a read, but it's still following the trend or range"): printed under
 * trend or ranging; the open line supersedes the early read.
 *
 *   readingOf(last, previous)     the owner's words for the last two breaks { reading, pair }
 *   turnOf({ last, previous, cisd3m, today, price, minutes })   a CHoCH's confirmed turn { by: 'cisd' | 'range', dir, edge?,
 *                                 price? } or null
 *   stateWord({ last, pair, read, m15, turn, forming })   the state's word and way
 *   m15Confirms(m15data, dir, closedMs, rthOpenMs)   'BOS' | null: the 15m confirming the way a 3m pair ends
 *   readState(b, th)              { state, way, align, frames, m15, pullback, early, last, previous, reading, pair,
 *                                 turn, context, ib, forming, rth, confirm15, age, price, tf } on any briefing (no lane
 *                                 guard: the recognition key's records); th { crossesChop, maxPullbackDepth }, both required
 *   stateOf(b, th)                readState, or null off the chain's entry frame or with no 1h part (as the Bias line)
 *   classWordOf(s)                chop -> chop; not aligned -> unclear; forming -> the 4h + 1h trend class; a pullback read the 4h + 1h way (the open line's
 *                                 leg, or the early read) -> that trend class (a 3m trend against inside it is the
 *                                 pullback); trend the 4h + 1h way, or ranging under them -> that trend class; a trend
 *                                 against them -> unclear
 *   marketStateLine(s)            "Market state (3m): trend up: 3m BOS up (continuation); pullback (long leg 21361.25 ->
 *                                 21437.5, depth 28%); 4h+1h up", "... chop: 3m CHoCH down then CHoCH up (failed
 *                                 reversal); Day so far rotational; 4h range, 1h up (not aligned)"; null for null
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

/** The owner's words for the last two 3m breaks: BOS a continuation, CHoCH a potential reversal; CHoCH then CHoCH back a failed reversal. */
function readingOf(last, previous) {
  if (!isObj(last) || !DIRS[last.direction]) return { reading: '', pair: false };
  const x = last.direction;
  const p = isObj(previous) && DIRS[previous.direction] ? previous : null;
  if (last.kind === 'BOS') {
    if (p && p.kind === 'CHoCH' && p.direction === x) return { reading: `3m CHoCH ${x} then BOS ${x} (confirmed transition ${x})`, pair: false };
    return { reading: `3m BOS ${x} (continuation)`, pair: false };
  }
  if (p && p.kind === 'CHoCH' && p.direction !== x) return { reading: `3m CHoCH ${p.direction} then CHoCH ${x} (failed reversal)`, pair: true };
  return { reading: `3m ${p ? `BOS ${p.direction} then ` : ''}CHoCH ${x} (potential reversal, unconfirmed)`, pair: false };
}

/** A CHoCH's turn confirmed its way (the owner: a CHoCH followed by a BOS or a same-direction CISD, or a close beyond the range). */
function turnOf({ last, previous, cisd3m, today, price, minutes } = {}) {
  if (!isObj(last) || last.kind !== 'CHoCH') return null;
  const c = isObj(cisd3m) ? cisd3m : null;
  // The briefing's CISD carries its confirming candle's close (cisdBlock confirmedClose); the CHoCH its candle's open.
  if (c && CISD_WAY[c.dir] === last.direction && !DEAD_CISD.has(c.status) && Date.parse(c.confirmedClose) > Date.parse(last.at) + minutes * 60000) return { by: 'cisd', dir: last.direction };
  const t = isObj(today) ? today : {};
  const hi = t.ibHigh;
  const lo = t.ibLow;
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || !Number.isFinite(price) || !isObj(previous) || !Number.isFinite(previous.level)) return null;
  if (previous.level < lo || previous.level > hi) return null;
  if (last.direction === 'up' && price > hi) return { by: 'range', dir: 'up', edge: 'IB high', price: hi };
  if (last.direction === 'down' && price < lo) return { by: 'range', dir: 'down', edge: 'IB low', price: lo };
  return null;
}

/**
 * The state's word, once: forming (the clock known, no RTH break yet), chop (the CHoCH pair, no pullback read, no 15m
 * confirmation, no confirmed turn), trend (a BOS, the pair the 15m confirms, or a confirmed CHoCH), ranging.
 */
function stateWord({ last, pair, read, m15, turn, forming = false, ended = false }) {
  if (forming) return { state: 'forming', way: null };
  if (pair && !read && !m15 && !turn) return { state: 'chop', way: null };
  if (isObj(last) && last.kind === 'BOS' && DIRS[last.direction] && !ended) return { state: 'trend', way: last.direction };
  if (pair && m15) return { state: 'trend', way: last.direction };
  if (turn) return { state: 'trend', way: turn.dir };
  return { state: 'ranging', way: null };
}

/**
 * The 15m confirming the way a 3m CHoCH pair ends (the owner, top-down; round 15: current structure only): its last break
 * a BOS that way, known (knownAt) at or after this trading day's 09:30 ET and by the decision close. A premarket BOS, a
 * missing knownAt or no clock: no confirmation; the 15m frame trend (an EMA/structure vote) never confirms.
 */
function m15Confirms(m15data, dir, closedMs, rthOpenMs) {
  const lb = isObj(m15data) && isObj(m15data.lastBreak) && isObj(m15data.lastBreak.last) ? m15data.lastBreak.last : null;
  if (!lb || lb.kind !== 'BOS' || lb.direction !== dir) return null;
  const known = Date.parse(lb.knownAt);
  if (!Number.isFinite(known) || !Number.isFinite(closedMs) || !Number.isFinite(rthOpenMs)) return null;
  return known >= rthOpenMs && known <= closedMs ? 'BOS' : null;
}

function readState(b, th = {}) {
  if (!Number.isFinite(th.crossesChop)) throw new Error('market-state: crossesChop is required (a config value, never a literal)');
  const frames = Object.fromEntries(RULE.biasFrames.map(tf => [tf, trendOf(b, tf)]));
  const ts = Object.values(frames);
  const align = ts.every(t => t === 'up') ? 'up' : ts.every(t => t === 'down') ? 'down' : null;
  if (!Number.isFinite(th.maxPullbackDepth)) throw new Error('market-state: maxPullbackDepth is required (a config value, never a literal)');
  const m3 = data(b, 'm3');
  // The state's pullback (round 15): open (never invalidated on its leg) and no deeper than the Depth row's bound.
  let open;
  try { open = isOpen(m3.pullback) && !(Number.isFinite(m3.pullback.depth) && m3.pullback.depth > th.maxPullbackDepth); } catch (_err) { open = false; }
  const lb = isObj(m3.lastBreak) ? m3.lastBreak : {};
  const minutes = Number.isInteger(b.minutes) ? b.minutes : 3;
  // The RTH breaks (the structure audit: at 28% of decision bars the previous break was a premarket drift): only breaks
  // whose candle closed at or after 09:30 ET of the decision's trading day; no close time (a fixture): every break. None
  // yet: forming; one: the rules on it alone (a BOS a trend, a CHoCH ranging unless confirmed); two: the full rules.
  const closedMs = Date.parse(b.closedAt);
  const rthOpen = Number.isFinite(closedMs) ? tradingDayStart(new Date(closedMs)).getTime() + sessionMinuteOf({ minute: RTH_OPEN_MIN, timeZone: MARKET_TZ }, new Date(closedMs)) * 60000 : null;
  const closeOf = x => Date.parse(x.at) + minutes * 60000; // a break's candle closes a bar after its open
  const rth = x => isObj(x) && (rthOpen === null || closeOf(x) >= rthOpen);
  const last = rth(lb.last) ? lb.last : null;
  const previous = last && rth(lb.previous) ? lb.previous : null;
  const forming = rthOpen !== null && !last;
  // The owner's invalidation rule: the last break's protected swing (structure-events.js protectedOf, the briefing's) broken
  // by a close at or before this one: a BOS's trend has ended; a CHoCH has failed (no new chop condition).
  const broken = isObj(last) && isObj(last.protected) && Number.isFinite(Date.parse(last.protected.brokenAt))
    && (!Number.isFinite(closedMs) || Date.parse(last.protected.brokenAt) < closedMs);
  const ended = broken && last.kind === 'BOS';
  const failed = broken && last.kind === 'CHoCH';
  const { reading, pair } = readingOf(last, previous);
  const m15 = trendOf(b, RULE.chain.setup);
  // The early read (round 15): the 3m TRENDING against the aligned 15m, its last break a BOS against; a CHoCH is not yet.
  const early = !open && Boolean(align) && m15 === align && isObj(last) && last.kind === 'BOS' && !ended && DIRS[last.direction] === true && last.direction !== align;
  const confirm15 = pair ? m15Confirms(data(b, 'm15'), last.direction, closedMs, rthOpen) : null;
  const today = isObj(m3.today) ? m3.today : {};
  const turn = failed ? null : turnOf({ last, previous, cisd3m: isObj(m3.cisd) ? m3.cisd['3m'] : null, today, price: m3.price, minutes });
  const { state, way } = stateWord({ last, pair, read: open || early, m15: confirm15, turn, forming, ended });
  const age = last && last.kind === 'BOS' && Number.isFinite(closedMs) ? Math.round((closedMs - (Date.parse(last.at) + minutes * 60000)) / 60000) : null;
  const d = isObj(today.soFar) ? today.soFar : {};
  const crosses = Number.isFinite(d.vwapCrosses) ? d.vwapCrosses : null;
  const context = { rotational: d.status === 'read' && d.read === 'rotational', crosses: crosses !== null && crosses >= th.crossesChop ? crosses : null };
  const ib = Number.isFinite(today.ibHigh) && Number.isFinite(today.ibLow) ? { high: today.ibHigh, low: today.ibLow } : null;
  return {
    state, way, align, frames, m15, pullback: open ? m3.pullback : null, early, last, previous, reading, pair, turn, context, ib, forming, rth: rthOpen !== null, confirm15, age, broken,
    price: Number.isFinite(m3.price) ? m3.price : null, tf: label(Number.isInteger(b.minutes) ? b.minutes : 3),
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
  if (!s.align) return 'unclear';
  // A pullback the 4h + 1h way follows their trend, whatever the 3m shows inside it (coordinator decision (b)).
  if ((isObj(s.pullback) && LEG_WAY[s.pullback.side] === s.align) || s.early === true) return `trend-${s.align}`;
  if (s.state === 'ranging' || s.state === 'forming' || (s.state === 'trend' && s.way === s.align)) return `trend-${s.align}`;
  return 'unclear';
}

function marketStateLine(s) {
  if (!isObj(s)) return null;
  const align = s.align ? `4h+1h ${s.align}` : `${Object.entries(s.frames).map(([tf, t]) => `${tf} ${t || 'unknown'}`).join(', ')} (not aligned)`;
  const ctx = [s.context && s.context.rotational ? 'Day so far rotational' : null, s.context && s.context.crosses !== null ? `RTH VWAP crosses ${s.context.crosses}` : null].filter(Boolean);
  let state;
  if (s.state === 'chop') state = `chop: ${s.reading}${ctx.length ? `; ${ctx.join(', ')}` : ''}`;
  else if (s.state === 'trend' && s.pair && s.confirm15) {
    state = `trend ${s.way}: 3m CHoCH ${s.previous.direction} then CHoCH ${s.last.direction} = the 15m ${s.confirm15} ${s.way} (continuation)`;
  } else if (s.state === 'trend') {
    const t = s.last && s.last.kind === 'CHoCH' ? s.turn : null;
    const base = Number.isFinite(s.age) ? `${s.reading}, ${s.age} min ago` : s.reading;
    const turn = !t ? base : t.by === 'cisd' ? `${s.reading}, then a 3m CISD ${t.dir} (confirmed)` : `${s.reading}, then a close ${t.dir === 'up' ? 'above' : 'below'} the ${t.edge} ${t.price} (confirmed)`;
    state = `trend ${s.way}: ${turn}${t && s.pair ? '; the chop ended' : ''}`;
  } else if (s.state === 'forming') {
    state = 'forming (no RTH structure yet)';
  } else if (s.rth && s.last && !s.previous) {
    state = `ranging: ${s.reading}, the only RTH break`;
  } else {
    const inside = s.ib && Number.isFinite(s.price) && s.price >= s.ib.low && s.price <= s.ib.high ? `inside the IB ${s.ib.low}-${s.ib.high}` : '';
    // The CHoCH pair inside a pullback read: the watch (#338), in the table's word, never "failed reversal" (which is chop).
    const read = s.pair ? `3m CHoCH ${s.previous.direction} then CHoCH ${s.last.direction} (inside the pullback: the watch)` : s.reading || 'no 3m break printed';
    state = `ranging: ${[read, inside].filter(Boolean).join('; ')}`;
  }
  const pr = isObj(s.last) && isObj(s.last.protected) && Number.isFinite(s.last.protected.level) ? s.last.protected : null;
  const up = isObj(s.last) && s.last.direction === 'up';
  const prot = !pr || s.state === 'forming' ? ''
    : s.last.kind === 'BOS' ? `; protected ${up ? 'HL' : 'LH'} ${pr.level} ${s.broken ? 'broken by a close (the trend ended)' : 'holding'}`
      : s.broken ? `; failed: a close ${up ? 'below' : 'above'} its origin ${pr.level}` : `; holds ${up ? 'above' : 'below'} ${pr.level} (origin)`;
  const p = s.pullback;
  const pb = p ? `; pullback (${p.side} leg ${p.leg.origin} -> ${p.leg.extreme}, ${String(pullbackWord(p) || 'depth unknown').split(',')[0]})`
    : s.early === true ? `; ${RULE.chain.setup} ${s.align}: a pullback in the ${RULE.chain.setup} trend` : '';
  return `Market state (${s.tf}): ${state}${prot}${pb}; ${align}`;
}

module.exports = { readingOf, turnOf, stateWord, m15Confirms, readState, stateOf, classWordOf, marketStateLine };
