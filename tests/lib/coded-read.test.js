'use strict';

// The coded read (trading/coded-read.js): a day class and an entry class from the briefing's own labels as the cycle
// recorded them (state-read.js stateFacts), pure, for measurement tools only: a cycle whose model left its STATE line out
// can still be sorted. It is the labels restated, so it is never a misread; it is labelled `coded`, never `model`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../../scripts/lib/trading/coded-read');
const { parseStateLine, scoreState } = require('../../scripts/lib/trading/state-read');

const facts = (over = {}) => ({
  frames: { '4h': 'up', '1h': 'up', '15m': 'up' }, dayType: null, regime: null, trendRule: null, breaks: {}, daySoFar: null, pullback: null, ...over,
});
const keys = r => [r.chop, r.trend];

test('day class: trend signals only is trend, chop signals only is chop, both is mixed, none is unknown', () => {
  // The 15m frame, the 3m regime and the IB day type trending one way: trend (up).
  const t = C.codedRead(facts({ regime: 'trend-up', dayType: 'trend up' }));
  assert.deepStrictEqual([t.day, t.dir, ...keys(t)], ['trend', 'up', [], ['T2', 'T3', 'T7']]);
  // Ranging frame, regime and an IB day: chop; Day so far rotational adds C1.
  const c = C.codedRead(facts({ frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, regime: 'range', dayType: 'inside the initial balance', daySoFar: 'rotational' }));
  assert.deepStrictEqual([c.day, c.dir, ...keys(c)], ['chop', null, ['C1', 'C2', 'C3', 'C8'], []]);
  // A chop signal beside a trend one: mixed.
  assert.strictEqual(C.codedRead(facts({ regime: 'range' })).day, 'mixed');
  // Trend signals that disagree on the way: mixed, no direction.
  const x = C.codedRead(facts({ regime: 'trend-down' }));
  assert.deepStrictEqual([x.day, x.dir], ['mixed', null]);
  // `directional` carries no way (T1): trend on its own, the direction from the other signals.
  const d = C.codedRead(facts({ frames: { '4h': 'up', '1h': 'up', '15m': 'transition' }, daySoFar: 'directional' }));
  assert.deepStrictEqual([d.day, d.dir, ...keys(d)], ['trend', null, [], ['T1']]);
  // Nothing the facts can say (too early, unknown labels, a transition): unknown. `mixed` and `too early` Day so far are no signal.
  for (const f of [facts({ frames: { '4h': 'up', '1h': 'up', '15m': 'transition' } }), facts({ frames: { '4h': null, '1h': null, '15m': null }, daySoFar: 'too early' }), facts({ daySoFar: 'mixed', frames: { '4h': 'up', '1h': 'up', '15m': 'unknown' } }), null, {}]) {
    assert.strictEqual(C.codedRead(f).day, 'unknown', JSON.stringify(f));
  }
  assert.deepStrictEqual(C.codedRead(null).chop, []);
});

test('entry class A-D by side: A no signal, C trend only, B chop outnumbers trend, D the rest; against the side is chop (C9)', () => {
  const cls = (f, side) => C.codedRead(f, { side }).cls;
  assert.strictEqual(cls(facts({ frames: { '4h': 'up', '1h': 'up', '15m': 'transition' } }), 'long'), 'A');
  assert.strictEqual(cls(facts({ regime: 'trend-up' }), 'long'), 'C');
  assert.strictEqual(cls(facts({ frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, regime: 'range' }), 'long'), 'B');
  // One of each: chop does not outnumber trend: D.
  assert.strictEqual(cls(facts({ frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, regime: 'trend-up' }), 'long'), 'D');
  // The 15m trending against the entry is C9, chop; the regime with it is T3: one each, D.
  const against = C.codedRead(facts({ frames: { '4h': 'up', '1h': 'up', '15m': 'down' }, regime: 'trend-up' }), { side: 'long' });
  assert.deepStrictEqual([against.cls, ...keys(against)], ['D', ['C9'], ['T3']]);
  // For a short the same 15m is T2 and the up regime and up IB day are against it (two C9): B.
  const short = C.codedRead(facts({ frames: { '4h': 'up', '1h': 'up', '15m': 'down' }, regime: 'trend-up', dayType: 'trend up' }), { side: 'short' });
  assert.deepStrictEqual([short.cls, ...keys(short)], ['B', ['C9', 'C9'], ['T2']]);
  // The Day so far `directional` is a trend signal for either side (it names no way).
  assert.strictEqual(cls(facts({ frames: { '4h': 'up', '1h': 'up', '15m': 'transition' }, daySoFar: 'directional' }), 'long'), 'C');
  // No side: no entry class.
  assert.strictEqual(C.codedRead(facts({ regime: 'trend-up' })).cls, null);
});

test('coded state: the labels restated as a read, every scored field a match (never a mismatch), labelled coded', () => {
  const rec = { status: 'none', line: null, read: null, symbol: 'MNQ', bar: '2021-06-11T13:27:00.000Z', fields: {}, facts: facts({ frames: { '4h': 'up', '1h': 'up', '15m': 'range' } }) };
  const c = C.codedState(rec);
  assert.strictEqual(c.status, 'read');
  assert.strictEqual(c.source, 'coded');
  assert.deepStrictEqual([c.symbol, c.bar], ['MNQ', rec.bar]);
  assert.deepStrictEqual(c.read, { frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, agree: 'no' });
  for (const k of ['4h', '1h', '15m', 'frames']) assert.strictEqual(c.fields[k].result, 'match', k);
  assert.strictEqual(c.fields['frames-own'].result, 'match');
  // A frame the briefing had no label for is unknown, never a mismatch; a read with every field unknown has nothing to score.
  const u = C.codedState({ ...rec, facts: facts({ frames: { '4h': 'up', '1h': null, '15m': 'up' } }) });
  assert.deepStrictEqual([u.read.frames['1h'], u.fields['1h'].result, u.read.agree], ['unknown', 'unknown', 'unknown']);
  // No facts (no briefing at the cycle): no coded state, never a made-up one.
  assert.strictEqual(C.codedState({ ...rec, facts: null }), null);
  assert.strictEqual(C.codedState(null), null);
  assert.strictEqual(C.codedState({ error: 'boom' }), null);
  // Its read is one the parser's own grammar would have written: the same words the model's line uses.
  const words = `STATE: 4h ${c.read.frames['4h']} | 1h ${c.read.frames['1h']} | 15m ${c.read.frames['15m']} | frames disagree`;
  assert.deepStrictEqual(parseStateLine(words).read, { frames: c.read.frames, agree: 'no' });
  assert.strictEqual(scoreState(parseStateLine(words).read, null).counts.mismatch, 0);
});

test('coded read: pure and for measurement only (no check, tool, write or order path)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'lib', 'trading', 'coded-read.js'), 'utf8');
  assert.doesNotMatch(src, /writeFileSync|appendFileSync|renameSync|place_order|order_plan|compose_check|require\('fs'\)/);
  // Nothing that decides reads it: only the measurement tools do.
  const readers = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js') && /require\([^)]*coded-read/.test(fs.readFileSync(p, 'utf8'))) readers.push(path.relative(path.join(__dirname, '..', '..'), p)); } };
  walk(path.join(__dirname, '..', '..', 'scripts'));
  assert.deepStrictEqual(readers.sort(), ['scripts/lib/learning/read-audit-source.js', 'scripts/lib/learning/read-audit.js']);
});
