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
  ['lastBreak...protected', /lastBreak\b[\w.[\]'"]*\.protected\b|\.protected\.(?:brokenAt|level)\b|\.(?:last|previous)\.protected\b/],
  // The review's bypasses: destructuring or bracket access, and the class word matched in the printed text.
  ['layers (any access: destructured, bracketed, a variable)', /\blayers\b/],
  ['protected (destructured, bracketed, as a key or string)', /\bprotected\s*:|['"`]protected['"`]/],
  ['class <word>', /\bclass \(?`?(?:chop|unclear|trend-(?:up|down))\b/],
];
// Comments name the fields freely (a reader is code): a block comment opening its line and a line comment opening its
// line, or after code and a space, are dropped before the scan; a "//" or "/*" inside a string or regex never starts one.
const code = t => t.replace(/^[ \t]*\/\*[^]*?\*\//gm, ' ').replace(/^[ \t]*\/\/[^\n]*/gm, '').replace(/([;,{}()]\s+)\/\/ [^\n]*/g, '$1');
// displacement.js reads the last break's protected swing to print its invalidating close's strength (the Break quality
// line, display only: tests/plugin/displacement-readers.test.js keeps it off every decision path). structure-read.js reads the
// printed briefing (the protected swing, the class word) as the structure-read dataset's truth, offline: no cycle runs it.
const FIELD_READERS = ['scripts/lib/trading/market-state.js', 'scripts/lib/trading/market-layers.js', 'scripts/lib/trading/structure-layers.js', 'scripts/lib/trading/briefing.js',
  'scripts/lib/learning/recognition/key.js', 'scripts/lib/eval/context-quiz.js', 'scripts/lib/trading/displacement.js', 'scripts/lib/learning/structure-read.js'];
const DECIDES = /(^hooks\/|^scripts\/hooks\/|gate|gateway|compose|entry-rule|order-plan|decision|verdict|phase2|autotrader|runner)/;
// The one exception (feat/entry-exit, DECISIONS M4; the owner, 2026-11-15: "I approve your change for trigger
// invalidation"): compose's trigger stop
// (composed-reads.js triggerStopPrices) verifies the price a `stop <tf> bos <price>` read names against the BOS's
// protected swing level, and turns that stop read FALSE (so the record is refused) when the trigger is stale, broken,
// a CHoCH or the other way. It reads no class, chop, layer or behavior field; it is opt-in by the stop form the model
// chooses (the other forms stand), a stop price check as `stop swing low` is. That function's body alone is blanked before the
// scan; the rest of composed-reads.js names no field, and the function must exist (the exception never outlives it).
const STOP_PRICE_EXCEPTION = { file: 'scripts/lib/trading/composed-reads.js', fn: 'triggerStopPrices' };
const withoutException = (f, text) => {
  if (f !== STOP_PRICE_EXCEPTION.file) return text;
  const at = text.indexOf(`function ${STOP_PRICE_EXCEPTION.fn}(`);
  const end = at < 0 ? -1 : text.indexOf('\n}\n', at);
  return at < 0 || end < 0 ? text : text.slice(0, at) + text.slice(end + 3);
};
const fieldsIn = (text, f = null) => STATE_FIELDS.filter(([, re]) => re.test(code(withoutException(f, text)))).map(([name]) => name);

test('round 20c: no script or hook outside the allow-list names the state\'s fields (layers, inChop, pbRotation, classWordOf, "; class", the protected swing)', () => {
  const named = ALL.map(f => [f, fieldsIn(fs.readFileSync(path.join(ROOT, f), 'utf8'), f)]).filter(([f, xs]) => xs.length && !FIELD_READERS.includes(f));
  assert.deepStrictEqual(named, []);
  for (const f of FIELD_READERS) assert.doesNotMatch(f, DECIDES, f);
  // The allow-list never outlives its reason: each file on it still names a field.
  for (const f of FIELD_READERS) assert.ok(fieldsIn(fs.readFileSync(path.join(ROOT, f), 'utf8')).length > 0, `${f}: on the allow-list, names no field`);
});

test('round 20c: the gate, the gateway, compose, the entry rule and the runner name none of the state\'s fields', () => {
  const deciders = ALL.filter(f => DECIDES.test(f));
  for (const want of [/order-gate/, /mcp-gateway/, /compose/, /entry-rule/, /runner/]) assert.ok(deciders.some(f => want.test(f)), `${want} scanned`);
  for (const f of deciders) assert.deepStrictEqual([f, fieldsIn(fs.readFileSync(path.join(ROOT, f), 'utf8'), f)], [f, []]);
  // The exception is the function alone: it exists, it names the protected swing, and nothing else in the file does.
  const cr = fs.readFileSync(path.join(ROOT, STOP_PRICE_EXCEPTION.file), 'utf8');
  assert.ok(cr.includes(`function ${STOP_PRICE_EXCEPTION.fn}(`), 'the exception\'s function exists');
  assert.ok(fieldsIn(cr).length > 0, 'without the exception the file names the field (the exception is needed)');
  assert.deepStrictEqual(fieldsIn(`${cr}\nconst lvl = b.sections.m3.data.lastBreak.last.protected.level;\n`, STOP_PRICE_EXCEPTION.file), ['lastBreak...protected'], 'a read outside the function is still caught');
  // Any other reader, even the same function's text in another file, is still caught: the exception is by file and name.
  const fn = cr.slice(cr.indexOf(`function ${STOP_PRICE_EXCEPTION.fn}(`), cr.indexOf('\n}\n', cr.indexOf(`function ${STOP_PRICE_EXCEPTION.fn}(`)) + 3);
  assert.deepStrictEqual(fieldsIn(fn, 'scripts/lib/trading/order-gate.js'), ['lastBreak...protected'], 'the same reads in a gate file are caught');
});

test('round 20c: the field scan catches a reader that never requires market-state.js (the review\'s two mutations, and each field)', () => {
  const planted = [
    "const inChopOf = b => Boolean(b && b.sections && b.sections.m3 && b.sections.m3.data.layers && b.sections.m3.data.layers.chop.inChop);",
    "const classOf = s => (/; class (\\S+)\\./.exec(String(s)) || [])[1];",
    'const { layers } = b.sections.m3.data;', 'const x = m3["layers"];', 'const { chop } = layers; if (chop.now) refuse();', 'if (/class (chop|unclear)$/.exec(summary)) refuse();',
    'if (line.endsWith("class chop")) refuse();', 'const pr = lb.last.protected; if (pr.brokenAt) refuse();', 'const { protected: pr } = lb.last;',
    'const r = m3.layers.pbRotation;', 'const { last: { protected: pr } } = lb;', "const pr = lb.last['protected'];", "const k = 'protected'; const pr = lb.last[k];",
    "const sep = '//'; if (b.sections.m3.data.layers.chop.now) refuse();", 'const u = `x${1}//`; if (s.inChop) refuse();', "const g = 'scripts/*.js'; const c = m3.layers.chop; const h = '*/';", 'const c = MS.classWordOf(s);', "const lvl = b.sections.m3.data.lastBreak.last.protected.level;", 'if (last.protected.brokenAt) refuse();',
  ];
  for (const s of planted) assert.ok(fieldsIn(s).length > 0, s);
  for (const s of ['// the gate never reads m3.layers or "; class chop"', '/* layers.inChop is the briefing\'s */ const a = 1;', 'const classes = {}; classes[k] = 1;', 'const { lastBreaks, protectedOf } = require("./structure-events");', 'player.layer = 1;'])
    assert.deepStrictEqual(fieldsIn(s), [], s);
});
