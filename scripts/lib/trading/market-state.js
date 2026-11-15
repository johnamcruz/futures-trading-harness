'use strict';

/**
 * The Market state: what the 3m market is doing at this bar (the owner: "trend, chop, ranging"), computed from facts the
 * briefing already holds with the precedence applied once, printed as one summary line with the Pullback read and the
 * 4h + 1h alignment beside it. The model reads the state and the alignment and follows its row (trade-session's table)
 * instead of weighing two rule sets with exceptions to each other. A read, not a filter: no gate, hook, compose or
 * decision code reads it (tests/plugin/market-state-readers.test.js); it is printed in the summary and restated by the
 * recognition key's coded read. Pure: no files, no clock; the chop threshold is passed in (the briefing:
 * config/analysis.json regime.rangeCrosses; the recognition key: its frozen signals.crossesChop; a test pins them equal).
 *
 * Inputs, all causal and all already printed:
 *   the 3m breaks   m3.lastBreak last and previous ({ kind BOS | CHoCH, direction, level, at })
 *   the sequence    the owner's reading of the last breaks (sequenceOf; m3.lastBreak last, previous and before): a
 *                   trend way, a failed reversal (the trend continues), an unconfirmed reversal, or repeated CHoCH
 *   the chop facts  the last two breaks both CHoCH (a back-and-forth) AND (the Day so far `rotational` OR its RTH
 *                   VWAP crosses at or above crossesChop); never one fact alone
 *   the turn        the last break a CHoCH confirmed its way: a live 3m CISD its way (m3.cisd['3m'], not void, expired
 *                   or weak) on a later 3m candle, or this bar's close beyond the initial balance's edge its way with the
 *                   previous break inside the IB (complete from 10:30 ET, so causal); a CHoCH then a BOS is a BOS
 *   the Pullback    pullback-read.js isOpen(m3.pullback): printed and not given back past its origin
 *   the alignment   the rule's bias frames (4h, 1h) both one way, entry-rule.js trendOf, the trends the gate reads
 *
 * The state (3m), once:
 *   chop          the chop facts, no open Pullback line, no confirmed turn
 *   trend <way>   the sequence's way (a BOS that way, or a failed reversal), or a CHoCH that way with its turn confirmed
 *   ranging       neither (one CHoCH, an unconfirmed CHoCH after a BOS, no break printed)
 * The Pullback read is no state (the owner: "just a read, but it's still following the trend or range"): printed
 * whenever its line is open, under trend or ranging (never chop). Before the line opens (it needs completed 15m candles
 * after the extreme), the owner's "15min up trend, 3min down trend could mean pullback": the 15m trending the 4h + 1h
 * way and the 3m state a trend against it prints "15m <way>: a pullback in the 15m trend" (never chop; the open line
 * supersedes it).
 *
 *   sequenceOf(last, previous, before, align)   the owner's structure-sequence reading { reading, way, pair }
 *   chopMet({ bothWays, rotational, crosses }, { crossesChop })   the chop facts' rule (bothWays: the last two both CHoCH)
 *   turnOf({ last, previous, cisd3m, today, price })   a CHoCH's confirmed turn { by: 'cisd' | 'range', dir, edge?,
 *                                 price? } or null
 *   stateWord({ last, chop, open, turn })   the state's word and way
 *   chopFacts({ lastBreak, soFar, cisd3m, today, price }, th)   the facts the state reads
 *   readState(b, th)              { state, way, align, frames, m15, pullback, early, chop, ib, price, tf } on any briefing (no lane
 *                                 guard: the recognition key's records)
 *   stateOf(b, { crossesChop })   readState, or null off the chain's entry frame or with no 1h part (as the Bias line)
 *   classWordOf(s)                chop -> chop; not aligned -> unclear; an open Pullback leg the 4h + 1h way, or the
 *                                 early 15m pullback, -> that trend class (a 3m trend against inside it is the
 *                                 pullback); trend the 4h + 1h way or
 *                                 ranging under them -> that trend class; a trend against them -> unclear
 *   marketStateLine(s)            "Market state (3m): trend up: 3m BOS up (continuation); pullback (long leg 21361.25 ->
 *                                 21437.5, depth 28%); 4h+1h up", "... ranging: 3m BOS down then CHoCH up (potential
 *                                 reversal, unconfirmed); inside the IB 21480-21560; 4h+1h up", "... chop: 3m CHoCH
 *                                 down then CHoCH up (back and forth); Day so far rotational; 4h range, 1h up (not
 *                                 aligned)"; null for a null state
 */

const { trendOf } = require('./entry-rule');
const { RULE } = require('./bias-line');
const { isOpen, pullbackWord } = require('./pullback-read');
const { label } = require('./mtf');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const data = (b, s) => (isObj(b) && isObj(b.sections) && isObj(b.sections[s]) && isObj(b.sections[s].data) ? b.sections[s].data : {});
const DEAD_CISD = new Set(['void', 'expired', 'weak']); // cisd.js DEAD: no zone, no entry
const CISD_WAY = { bullish: 'up', bearish: 'down' };
const LEG_WAY = { long: 'up', short: 'down' };

const DIRS = { up: true, down: true };
/**
 * The owner's structure-sequence reading of the last 3m breaks, his labels relative to the LAST break (structure-events.js
 * as it stands): BOS a break the previous break's way (continuation), CHoCH a break that changes direction (a potential
 * reversal). On last, previous and before (the break before previous, when printed) and the 4h + 1h alignment:
 *   BOS x after CHoCH x                        a confirmed transition x (trend x)
 *   BOS x otherwise                            continuation x (trend x)
 *   CHoCH x after a BOS (or alone)             a potential reversal, unconfirmed (no way)
 *   CHoCH x after CHoCH, the break before a BOS x (the trend before: x)   one back-and-forth: a failed reversal (trend
 *                                              x); with the chop facts it is chop (stateWord)
 *   CHoCH x after CHoCH, the break before a CHoCH   repeated, no BOS: unconfirmed (no way; chop with its facts)
 *   CHoCH x after CHoCH, the break before not printed   the trend before taken as the 4h + 1h way: x the aligned way: a
 *                                              failed reversal; else unconfirmed
 * { reading, way, pair } (pair: the last two both CHoCH, the back-and-forth the chop facts weigh) or null with no break.
 */
function sequenceOf(last, previous, before, align = null) {
  if (!isObj(last) || !DIRS[last.direction]) return null;
  const x = last.direction;
  const p = isObj(previous) && DIRS[previous.direction] ? previous : null;
  if (last.kind === 'BOS') {
    if (p && p.kind === 'CHoCH' && p.direction === x) return { reading: `3m CHoCH ${x} then BOS ${x} (confirmed transition ${x})`, way: x, pair: false };
    return { reading: `3m BOS ${x} (continuation)`, way: x, pair: false };
  }
  if (p && p.kind === 'CHoCH' && p.direction !== x) {
    const known = isObj(before) && DIRS[before.direction];
    const failed = known ? before.kind === 'BOS' && before.direction === x : align === x;
    if (failed) return { reading: `3m CHoCH ${p.direction} then CHoCH ${x} back (failed reversal; continuation ${x})`, way: x, pair: true };
    return { reading: `3m breaks alternating ${p.direction}, ${x} (repeated potential reversals, none confirmed)`, way: null, pair: true };
  }
  return { reading: `3m ${p ? `BOS ${p.direction} then ` : ''}CHoCH ${x} (potential reversal, unconfirmed)`, way: null, pair: false };
}

function chopMet({ bothWays, rotational, crosses } = {}, { crossesChop } = {}) {
  if (!Number.isFinite(crossesChop)) throw new Error('market-state: crossesChop is required (a config value, never a literal)');
  return bothWays === true && (rotational === true || (Number.isFinite(crosses) && crosses >= crossesChop));
}

/** A CHoCH's turn confirmed its way (the owner: a CHoCH followed by a BOS or a same-direction CISD, or a close beyond the range). */
function turnOf({ last, previous, cisd3m, today, price } = {}) {
  if (!isObj(last) || last.kind !== 'CHoCH') return null;
  const c = isObj(cisd3m) ? cisd3m : null;
  if (c && CISD_WAY[c.dir] === last.direction && !DEAD_CISD.has(c.status) && Date.parse(c.confirmedAt) > Date.parse(last.at)) return { by: 'cisd', dir: last.direction };
  const t = isObj(today) ? today : {};
  const hi = t.ibHigh;
  const lo = t.ibLow;
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || !Number.isFinite(price) || !isObj(previous) || !Number.isFinite(previous.level)) return null;
  if (previous.level < lo || previous.level > hi) return null;
  if (last.direction === 'up' && price > hi) return { by: 'range', dir: 'up', edge: 'IB high', price: hi };
  if (last.direction === 'down' && price < lo) return { by: 'range', dir: 'down', edge: 'IB low', price: lo };
  return null;
}

/** The state's word, once: chop (no open Pullback line, no confirmed turn), trend (the sequence's way, or a confirmed turn), ranging. */
function stateWord({ seq, chop, open, turn }) {
  if (chop && !open && !turn) return { state: 'chop', way: null };
  if (seq && seq.way) return { state: 'trend', way: seq.way };
  if (turn) return { state: 'trend', way: turn.dir };
  return { state: 'ranging', way: null };
}

function chopFacts({ lastBreak, soFar, cisd3m, today, price, align = null } = {}, th = {}) {
  const lb = isObj(lastBreak) ? lastBreak : {};
  const last = isObj(lb.last) ? lb.last : null;
  const previous = isObj(lb.previous) ? lb.previous : null;
  const seq = sequenceOf(last, previous, isObj(lb.before) ? lb.before : null, align);
  // The chop fact "breaks both ways": the last two both CHoCH (a back-and-forth; with the chop facts it is chop, else a
  // failed reversal or unconfirmed).
  const bothWays = Boolean(seq && seq.pair);
  const d = isObj(soFar) ? soFar : {};
  const rotational = d.status === 'read' && d.read === 'rotational';
  const crosses = Number.isFinite(d.vwapCrosses) ? d.vwapCrosses : null;
  const met = chopMet({ bothWays, rotational, crosses }, th);
  // A confirmed turn: a CISD or the IB close after the last CHoCH (any CHoCH: it can end a chop).
  const turn = turnOf({ last, previous, cisd3m, today, price });
  return { last, previous, seq, bothWays, rotational, crosses, crossesMet: crosses !== null && crosses >= th.crossesChop, met, turn };
}

function readState(b, th) {
  const frames = Object.fromEntries(RULE.biasFrames.map(tf => [tf, trendOf(b, tf)]));
  const ts = Object.values(frames);
  const align = ts.every(t => t === 'up') ? 'up' : ts.every(t => t === 'down') ? 'down' : null;
  const m3 = data(b, 'm3');
  let open;
  try { open = isOpen(m3.pullback); } catch (_err) { open = false; }
  const today = isObj(m3.today) ? m3.today : {};
  const cisd3m = isObj(m3.cisd) ? m3.cisd['3m'] : null;
  const chop = chopFacts({ lastBreak: m3.lastBreak, soFar: today.soFar, cisd3m, today, price: m3.price, align }, th);
  const { state, way } = stateWord({ seq: chop.seq, chop: chop.met, open, turn: chop.turn });
  const m15 = trendOf(b, RULE.chain.setup);
  const early = !open && Boolean(align) && state === 'trend' && way !== align && m15 === align;
  const ib = Number.isFinite(today.ibHigh) && Number.isFinite(today.ibLow) ? { high: today.ibHigh, low: today.ibLow } : null;
  return { state, way, align, frames, m15, pullback: open ? m3.pullback : null, early, chop, ib, price: Number.isFinite(m3.price) ? m3.price : null, tf: label(Number.isInteger(b.minutes) ? b.minutes : 3) };
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
  if (s.state === 'ranging' || (s.state === 'trend' && s.way === s.align)) return `trend-${s.align}`;
  return 'unclear';
}

function marketStateLine(s) {
  if (!isObj(s)) return null;
  const c = isObj(s.chop) ? s.chop : {};
  const align = s.align ? `4h+1h ${s.align}` : `${Object.entries(s.frames).map(([tf, t]) => `${tf} ${t || 'unknown'}`).join(', ')} (not aligned)`;
  const pair = c.seq ? c.seq.reading : '';
  let state;
  if (s.state === 'chop') {
    const why = [c.rotational ? 'Day so far rotational' : null, c.crossesMet ? `RTH VWAP crosses ${c.crosses}` : null].filter(Boolean).join(', ');
    state = `chop: 3m CHoCH ${c.previous.direction} then CHoCH ${c.last.direction} (back and forth); ${why}`;
  } else if (s.state === 'trend') {
    const t = c.turn;
    const turn = !t ? pair : t.by === 'cisd' ? `${pair}, then a 3m CISD ${t.dir} (confirmed)` : `${pair}, then a close ${t.dir === 'up' ? 'above' : 'below'} the ${t.edge} ${t.price} (confirmed)`;
    state = `trend ${s.way}: ${turn}${t && c.met ? '; the chop ended' : ''}`;
  } else {
    const inside = s.ib && Number.isFinite(s.price) && s.price >= s.ib.low && s.price <= s.ib.high ? `inside the IB ${s.ib.low}-${s.ib.high}` : '';
    state = `ranging: ${[pair || 'no 3m break printed', inside].filter(Boolean).join('; ')}`;
  }
  const p = s.pullback;
  const pb = p ? `; pullback (${p.side} leg ${p.leg.origin} -> ${p.leg.extreme}, ${String(pullbackWord(p) || 'depth unknown').split(',')[0]})`
    : s.early === true ? `; ${RULE.chain.setup} ${s.align}: a pullback in the ${RULE.chain.setup} trend` : '';
  return `Market state (${s.tf}): ${state}${pb}; ${align}`;
}

module.exports = { sequenceOf, chopMet, turnOf, stateWord, chopFacts, readState, stateOf, classWordOf, marketStateLine };
