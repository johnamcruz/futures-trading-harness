'use strict';

// The Market state is a read, not a filter (MARKET-STATE-SPEC, feat/chop-read): it is printed in the briefing's summary
// and restated by the recognition key's coded read (measurement), and no gate, hook, gateway, compose, entry-rule or
// decision code reads it. Every file under scripts/ and hooks/ that requires market-state.js, or names the printed line,
// is on this allow-list; anything else fails.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REQUIRERS = ['scripts/lib/trading/briefing.js', 'scripts/lib/learning/recognition/key.js', 'scripts/lib/eval/context-quiz.js'];
const NAMERS = ['scripts/lib/trading/market-state.js', ...REQUIRERS];

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(rel));
    else if (/\.(c?js|mjs|json)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const ALL = [...files('scripts'), ...files('hooks')];

test('only the briefing, the recognition key and the quiz lib require market-state.js', () => {
  const req = ALL.filter(f => /require\([^)]*market-state['"]\)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepStrictEqual(req.sort(), [...REQUIRERS].sort());
});

test('no other script or hook names the Market state line or the module', () => {
  const named = ALL.filter(f => /Market state \(|\/market-state['"]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepStrictEqual(named.filter(f => !NAMERS.includes(f)), []);
});

test('the decision paths are not among the readers (the gate, hooks, gateway, compose, entry rule, decision parsers)', () => {
  const decides = /(^hooks\/|^scripts\/hooks\/|gate|gateway|compose|entry-rule|order-plan|decision|verdict|phase2|autotrader|runner)/;
  for (const f of REQUIRERS) assert.doesNotMatch(f, decides, f);
  // The test sees the files it guards: the gate and the gateway exist where it scans.
  assert.ok(ALL.some(f => /order-gate/.test(f)) && ALL.includes('scripts/mcp-gateway.js'), 'the decision files are scanned');
});

// Round 20: the layers' modules feed the read only: market-layers.js is required by the briefing alone (it computes
// m3.layers), structure-layers.js and market-behavior.js by market-layers.js alone; no gate, hook, compose, entry-rule or
// decision code reads them.
test('the Market state\'s layer modules are required only by the briefing (market-layers) and market-layers (the two parts)', () => {
  const by = mod => ALL.filter(f => new RegExp(`require\\([^)]*/${mod}['"]\\)`).test(fs.readFileSync(path.join(ROOT, f), 'utf8'))).sort();
  assert.deepStrictEqual(by('market-layers'), ['scripts/lib/trading/briefing.js']);
  assert.deepStrictEqual(by('structure-layers'), ['scripts/lib/trading/market-layers.js']);
  assert.deepStrictEqual(by('market-behavior'), ['scripts/lib/trading/market-layers.js']);
});

// Round 20c (the final review, item 3): a reader that reaches the state without requiring its modules (the briefing's
// m3.layers, the chop memory, the pullback's rotation, the class function, the printed "; class <word>", or the 3m last
// break's protected swing) is a reader too. Only these files may name them; the decision files name none.
const STATE_FIELDS = [
  ['.layers', /\.layers\b/],
  ['inChop', /\binChop\b/],
  ['pbRotation', /\bpbRotation\b/],
  ['classWordOf', /\bclassWordOf\b/],
  ['; class', /; class\b/],
  ['lastBreak...protected', /lastBreak\b[\w.[\]'"]*\.protected\b|\.protected\.(?:brokenAt|level)\b/],
];
const FIELD_READERS = ['scripts/lib/trading/market-state.js', 'scripts/lib/trading/market-layers.js', 'scripts/lib/trading/briefing.js',
  'scripts/lib/learning/recognition/key.js', 'scripts/lib/eval/context-quiz.js'];
const DECIDES = /(^hooks\/|^scripts\/hooks\/|gate|gateway|compose|entry-rule|order-plan|decision|verdict|phase2|autotrader|runner)/;
const fieldsIn = text => STATE_FIELDS.filter(([, re]) => re.test(text)).map(([name]) => name);

test('round 20c: no script or hook outside the allow-list names the state\'s fields (layers, inChop, pbRotation, classWordOf, "; class", the protected swing)', () => {
  const named = ALL.map(f => [f, fieldsIn(fs.readFileSync(path.join(ROOT, f), 'utf8'))]).filter(([f, xs]) => xs.length && !FIELD_READERS.includes(f));
  assert.deepStrictEqual(named, []);
  for (const f of FIELD_READERS) assert.doesNotMatch(f, DECIDES, f);
});

test('round 20c: the gate, the gateway, compose, the entry rule and the runner name none of the state\'s fields', () => {
  const deciders = ALL.filter(f => DECIDES.test(f));
  for (const want of [/order-gate/, /mcp-gateway/, /compose/, /entry-rule/, /runner/]) assert.ok(deciders.some(f => want.test(f)), `${want} scanned`);
  for (const f of deciders) assert.deepStrictEqual([f, fieldsIn(fs.readFileSync(path.join(ROOT, f), 'utf8'))], [f, []]);
});

test('round 20c: the field scan catches a reader that never requires market-state.js (the review\'s two mutations, and each field)', () => {
  const planted = [
    "const inChopOf = b => Boolean(b && b.sections && b.sections.m3 && b.sections.m3.data.layers && b.sections.m3.data.layers.chop.inChop);",
    "const classOf = s => (/; class (\\S+)\\./.exec(String(s)) || [])[1];",
    'const r = m3.layers.pbRotation;', 'const c = MS.classWordOf(s);', "const lvl = b.sections.m3.data.lastBreak.last.protected.level;", 'if (last.protected.brokenAt) refuse();',
  ];
  for (const s of planted) assert.ok(fieldsIn(s).length > 0, s);
  for (const s of ['const classes = {}; classes[k] = 1;', 'const { lastBreaks, protectedOf } = require("./structure-events");', 'player.layer = 1;'])
    assert.deepStrictEqual(fieldsIn(s), [], s);
});
