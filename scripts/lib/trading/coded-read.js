'use strict';

/**
 * The coded read: what the briefing's own labels say about the day, as code computes it, for the cycles where the model
 * left its STATE line out (the measurement of what the model learns needs every decision scored, not the ~1 in 10 that
 * wrote the line). Pure: it reads the facts a cycle recorded (state-read.js stateFacts: the frame labels, the 3m regime,
 * the IB day type, the Day so far word), restates them, and sorts them into signals. MEASUREMENT ONLY: nothing that
 * decides (the gate, the entry check, sizing, the stop, the exits, the runner, the briefing, a prompt, a skill) reads it; the
 * read audit and its report do. It is the labels restated, so it can never be a misread of them: a decision scored from
 * it says `coded`, never `model`, and the report keeps the two apart.
 *
 * The signals (the chop-class study's, kept to what the recorded facts hold; each names the label it reads):
 *   chop    C1 Day so far `rotational`; C2 the 15m frame `range`; C3 the 3m regime `range`; C8 the IB day type
 *           `inside the initial balance`; C9 (with a side) a trend label against the side
 *   trend   S1 Day so far `directional` (names no way); S2 the 15m frame up or down; S3 the 3m regime trend-up or
 *           trend-down; S7 the IB day type `trend up` or `trend down`
 * Not in the recorded facts, so not read: the declared-trend line, the session VWAP's crosses, the bias line, the open
 * against the prior value area (so C8 is the IB word alone). A `mixed` or `too early` Day so far and a `transition` label
 * are no signal.
 *
 * The day class (no side): trend (trend signals only, one way), chop (chop signals only), mixed (both, or trend signals
 * that disagree on the way), unknown (no signal). The entry class (a side): A no signal, C trend only, B chop outnumbers
 * trend, D the rest (chop at least as many as trend, both present).
 *
 *   codedRead(facts, { side })   { day, dir, chop: [key], trend: [key], cls }  (cls: null without a side)
 *   codedState(record)           the cycle's STATE record rebuilt from the labels as a read ({ status: 'read',
 *                                source: 'coded', read, fields, ... }), or null when it has no facts
 */

const WAYS = ['up', 'down'];
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const FRAME_KEYS = ['4h', '1h', '15m'];
const OPPOSITE = { up: 'down', down: 'up' };
const SIDE_WAY = { long: 'up', short: 'down' };
const way = w => (WAYS.includes(w) ? w : null);

/** Each signal: { key, kind, at(facts) -> null | { dir } } (dir: its way, null for none). */
const SIGNALS = Object.freeze([
  { key: 'C1', kind: 'chop', at: f => (f.daySoFar === 'rotational' ? { dir: null } : null) },
  { key: 'C2', kind: 'chop', at: f => (isObj(f.frames) && f.frames['15m'] === 'range' ? { dir: null } : null) },
  { key: 'C3', kind: 'chop', at: f => (f.regime === 'range' ? { dir: null } : null) },
  { key: 'C8', kind: 'chop', at: f => (f.dayType === 'inside the initial balance' ? { dir: null } : null) },
  { key: 'S1', kind: 'trend', at: f => (f.daySoFar === 'directional' ? { dir: null } : null) },
  { key: 'S2', kind: 'trend', at: f => (isObj(f.frames) && way(f.frames['15m']) ? { dir: f.frames['15m'] } : null) },
  { key: 'S3', kind: 'trend', at: f => { const [, d] = /^trend-(up|down)$/.exec(String(f.regime)) || []; return d ? { dir: d } : null; } },
  { key: 'S7', kind: 'trend', at: f => { const [, d] = /^trend (up|down)$/.exec(String(f.dayType)) || []; return d ? { dir: d } : null; } },
].map(Object.freeze));

function codedRead(facts, { side = null } = {}) {
  const f = isObj(facts) ? facts : {};
  const hit = SIGNALS.map(s => ({ s, got: s.at(f) })).filter(x => x.got);
  const chop = hit.filter(x => x.s.kind === 'chop').map(x => x.s.key);
  const trendHits = hit.filter(x => x.s.kind === 'trend');
  const dirs = trendHits.map(x => x.got.dir).filter(Boolean);
  const split = dirs.includes('up') && dirs.includes('down'); // trend labels that disagree on the way
  const dir = split ? null : dirs[0] || null;
  const day = !hit.length ? 'unknown' : !chop.length && !split ? 'trend' : chop.length && !trendHits.length ? 'chop' : 'mixed';
  const out = { day, dir, chop, trend: trendHits.map(x => x.s.key), cls: null };
  const sideWay = SIDE_WAY[side];
  if (sideWay) {
    // A trend label against the side is chop for it (C9); the rest of the trend signals (and S1, which names no way) count.
    const against = trendHits.filter(x => x.got.dir === OPPOSITE[sideWay]);
    const c = [...chop, ...against.map(() => 'C9')];
    const t = trendHits.filter(x => !against.includes(x)).map(x => x.s.key);
    out.chop = c;
    out.trend = t;
    out.cls = !c.length && !t.length ? 'A' : !c.length ? 'C' : c.length > t.length ? 'B' : 'D';
  }
  return out;
}

/** The three frame words' agreement as the state line states it: yes (all known, equal), no (two known differ), else unknown. */
function agreeOf(words) {
  const known = words.filter(w => w !== 'unknown');
  return !known.every(w => w === known[0]) ? 'no' : known.length === words.length ? 'yes' : 'unknown';
}

function codedState(record) {
  if (!isObj(record) || !isObj(record.facts) || !isObj(record.facts.frames)) return null;
  const frames = Object.fromEntries(FRAME_KEYS.map(k => [k, typeof record.facts.frames[k] === 'string' ? record.facts.frames[k] : 'unknown']));
  const agree = agreeOf(FRAME_KEYS.map(k => frames[k]));
  const fields = {};
  // The read is the label, so a stated frame matches it; a frame with no label is unknown, never a mismatch.
  for (const k of FRAME_KEYS) fields[k] = { read: frames[k], fact: frames[k] === 'unknown' ? null : frames[k], field: `the briefing's ${k} trend label`, result: frames[k] === 'unknown' ? 'unknown' : 'match' };
  fields.frames = { read: agree, fact: agree === 'unknown' ? null : agree, field: '4h, 1h and 15m trend labels', result: agree === 'unknown' ? 'unknown' : 'match' };
  fields['frames-own'] = { read: agree, fact: agree === 'unknown' ? null : agree, field: 'the read\'s own 4h, 1h and 15m', result: agree === 'unknown' ? 'unknown' : 'match' };
  return { ...record, status: 'read', source: 'coded', line: null, read: { frames, agree }, missing: [], bad: [], fields };
}

module.exports = { SIGNALS, codedRead, codedState };
