'use strict';

// The chop read's terms are defined once (feat/chop-read, owner: "make sure it's clear and not ambiguous"): an open
// `Pullback` line is "printed and its leg not given back past its origin", stated in trade-session's class rule. Every other
// home that says "open `Pullback` line" carries that definition in the same paragraph or points to trade-session.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OPEN = /open `?Pullback`?( line)?/i;
const DEFINED = /not given back past its origin/;
const DEFINITION = 'Open `Pullback` line: the `Pullback` line is printed and its leg is not given back past its origin.';

function homes() {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const r = path.join(d, e.name); if (e.isDirectory()) walk(r); else if (r.endsWith('.md')) out.push(r); } };
  for (const d of ['skills', 'rules', 'agents']) walk(d);
  return [...out, 'docs/TRAINING.md'];
}
const flat = t => t.replace(/\s+/g, ' ');
// Paragraphs and list items (a bullet or a numbered step starts a new one).
const units = text => text.split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+[.)])\s)/);
// A unit that says "open Pullback" is clear when it holds the definition or points to trade-session; the home (the file
// stating the definition verbatim) is clear throughout.
const unclear = text => (flat(text).includes(DEFINITION) ? [] : units(text).filter(p => OPEN.test(flat(p)) && !DEFINED.test(flat(p)) && !p.includes('`trade-session`')));

test('chop read terms: every home that says "open `Pullback` line" defines it or points to trade-session, where it is defined once', () => {
  const bad = homes().flatMap(f => unclear(fs.readFileSync(path.join(ROOT, f), 'utf8')).map(p => `${f}: ${flat(p).slice(0, 120)}`));
  assert.deepStrictEqual(bad, []);
  const withDef = homes().filter(f => flat(fs.readFileSync(path.join(ROOT, f), 'utf8')).includes(DEFINITION));
  assert.deepStrictEqual(withDef, ['skills/trade-session/SKILL.md'], 'the definition stated once, in trade-session');
  // The head trader's prompt embeds trade-session, so the definition reaches the head.
  const H = require('../../scripts/lib/head-prompt');
  const head = flat(H.headPrompt(H.headPlan(ROOT, 'index')));
  assert.ok(head.includes('<skill name="trade-session">') && head.includes(DEFINITION), 'the head prompt carries the definition');
});

test('chop read terms: the check catches a home using "open `Pullback` line" with neither the definition nor the pointer', () => {
  assert.strictEqual(unclear('Intro.\n\nInside an open `Pullback` line a pause is the watch.\n').length, 1);
  assert.strictEqual(unclear('- An open Pullback holds the watch.\n').length, 1, 'no backticks, no "line": still caught');
  assert.strictEqual(unclear('- Pointer (`trade-session`).\n- Inside an open `Pullback` line a pause is the watch.\n').length, 1, 'a pointer in another bullet does not cover this one');
  assert.strictEqual(unclear('1. Steps (`trade-session`).\n2. Inside an open `Pullback` line, wait.\n').length, 1, 'numbered steps split too');
  assert.strictEqual(unclear('Inside an open `Pullback` line (`trade-session`) a pause is the watch.\n').length, 0);
  assert.strictEqual(unclear('An open `Pullback` line: printed, its leg not given back past its origin.\n').length, 0);
});
