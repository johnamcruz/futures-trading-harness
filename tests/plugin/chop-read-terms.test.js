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

test('chop read terms: the owner\'s trending and chop definitions read the same in trade-session and trend-vs-range', () => {
  const DEF = 'Trending: consistent BOS, directional displacement, follow-through. Chop: alternating BOS/CHoCH, overlapping candles, failed continuation';
  for (const s of ['trade-session', 'trend-vs-range']) assert.ok(flat(fs.readFileSync(path.join(ROOT, `skills/${s}/SKILL.md`), 'utf8')).includes(DEF), s);
  // The head prompt embeds trade-session, so the head reads them and the table.
  const H = require('../../scripts/lib/head-prompt');
  const head = flat(H.headPrompt(H.headPlan(ROOT, 'index')));
  assert.ok(head.includes(DEF) && head.includes('| 3m state | 4h + 1h | class | action |'), 'the head prompt carries the table and the definitions');
});
