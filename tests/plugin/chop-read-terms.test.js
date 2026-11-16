'use strict';

// The chop read's terms are defined once (feat/chop-read, owner: "make sure it's clear and not ambiguous"). Since the
// Market state redesign (MARKET-STATE-SPEC) the code settles the order once (market-state.js): an open `Pullback` line
// (pullback-read.js isOpen: printed, its leg not given back past its origin) is a fact the state reads, so the taught text
// names the printed state (`pullback`, `chop`, `trending`, `not aligned`), never the rule it settles. The owner's
// trending and chop definitions read the same in the head core's table and in trend-vs-range.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OPEN = /open `?Pullback`?( line)?/i;
const flat = t => t.replace(/\s+/g, ' ');

function homes() {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const r = path.join(d, e.name); if (e.isDirectory()) walk(r); else if (r.endsWith('.md')) out.push(r); } };
  for (const d of ['skills', 'rules', 'agents']) walk(d);
  return out;
}

test('chop read terms: no skill, rule or agent restates the open `Pullback` line: they name the Market state', () => {
  const bad = homes().filter(f => OPEN.test(flat(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
  assert.deepStrictEqual(bad, []);
  // Its one definition for the measurement: TRAINING.md, pointing to the code.
  const tr = flat(fs.readFileSync(path.join(ROOT, 'docs/TRAINING.md'), 'utf8'));
  assert.ok(tr.includes('pullback-read.js `isOpen`'), 'TRAINING.md defines it by the code');
});

test('chop read terms: the owner\'s trending and chop definitions have one home, trend-vs-range; the head core carries the table and points there', () => {
  // Round 17 (one authority for the class word): the definitions are reference, never always loaded beside the table,
  // where a picture ("overlapping candles") outranked the printed state (q118).
  const DEF = 'Trending: consistent BOS, directional displacement, follow-through. Chop: alternating BOS/CHoCH, overlapping candles, failed continuation';
  const holders = homes().filter(f => flat(fs.readFileSync(path.join(ROOT, f), 'utf8')).includes(DEF));
  assert.deepStrictEqual(holders, ['skills/trend-vs-range/SKILL.md']);
  const H = require('../../scripts/lib/head-prompt');
  const head = flat(H.headPrompt(H.headPlan(ROOT, 'index')));
  assert.ok(!head.includes(DEF) && head.includes('| class printed | action |'), 'the head prompt carries the table, not the definitions');
  assert.ok(head.includes('The trend and chop definitions, for reference only: `trend-vs-range`.'));
});

test('chop read terms: htf-to-ltf\'s side rule decides the side only; the class is the Market state line\'s (round 18, q119)', () => {
  const t = flat(fs.readFileSync(path.join(ROOT, 'skills/htf-to-ltf/SKILL.md'), 'utf8'));
  assert.ok(t.includes("**The side rule** (side only; the class is the Market state line's; in an attempt): each trending 4h or 1h your way, neither against; both ranging: the 15m and `Trend declared?` your way; else no trade."));
  assert.ok(t.includes('Then the class is the one the Market state line prints after `class`'));
});

// Round 20c (the final review, items 4 and 5): one rule in every home. A leg is invalidated only by a close through its
// protected level; a CHoCH then BOS against it confirms a transition (the owner's table: "confirmed transition"), a
// reversal only once that level is closed through. Chop is structural AND behavioral evidence, never a CHoCH pair.
const read = f => flat(fs.readFileSync(path.join(ROOT, f), 'utf8'));
test('round 20c: CHoCH then BOS confirms a transition; only a close through the protected level invalidates the leg (bos-vs-choch, trend-vs-range, structure-layers.js agree)', () => {
  const bc = read('skills/bos-vs-choch/SKILL.md');
  const tv = read('skills/trend-vs-range/SKILL.md');
  const sl = read('scripts/lib/trading/structure-layers.js');
  for (const [f, t] of [['bos-vs-choch', bc], ['structure-layers.js', sl]]) {
    assert.match(t, /the only invalidation of the leg/, `${f}: the close through the protected level is the only invalidation`);
    assert.match(t, /CHoCH then BOS[^.]*confirms a transition/i, `${f}: CHoCH then BOS confirms a transition`);
  }
  assert.ok(bc.includes('`CHoCH then BOS: transition confirmed`') && tv.includes('`CHoCH then BOS: transition confirmed`'), 'the printed words named');
  for (const [f, t] of [['bos-vs-choch', bc], ['trend-vs-range', tv]]) {
    assert.doesNotMatch(t, /CHoCH then BOS: confirmed|confirms the transition too|CHoCH then BOS[^.]{0,40}reversal confirmed/, `${f}: no CHoCH then BOS reversal`);
  }
  assert.match(tv, /`CHoCH then BOS: transition confirmed` prints under `trend`, `in the leg` or `weakening`, never the `transition` state: the new leg, its old protected level unbroken; a reversal once a close goes through that level\./, 'a reversal only through the old level');
});

test('round 20c: TRAINING.md and README state the round-20 Market state (three layers, chop = structural AND behavioral evidence, the classes, the pullback guard); no CHoCH-pair chop', () => {
  for (const f of ['docs/TRAINING.md', 'README.md']) {
    const t = read(f);
    for (const old of [/a 3m CHoCH then a CHoCH back/, /the last two breaks both CHoCH/, /bare CHoCH pair[^.]*reads `chop`/, /`ranging`/, /chop = (?:a )?CHoCH pair/i])
      assert.doesNotMatch(t, old, `${f}: ${old}`);
    for (const now of [/three layers/i, /structural AND behavioral/, /protected (?:level|swing)/, /`chop`/, /`unclear`/, /pullback guard/])
      assert.match(t, now, `${f}: ${now}`);
  }
});
