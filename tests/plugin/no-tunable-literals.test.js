'use strict';

// Tunables live in config/ (scripts/lib/tunables.js), never as literals in scripts/. This guard scans every .js under
// scripts/ for what looks like a tunable stated in code (tunable-scan.js):
//
// - an UPPER_CASE constant whose value states a numeric literal: allowed only when it is listed in
//   no-tunable-literals.pins.json with why it is no setting (a unit, a format version, an id or enum, a timeframe
//   table, a parse or input limit, an interface fact, a float tolerance, the exchange hours, a schema, a function's
//   local, a definition the skills teach, a document's code ceiling, contract facts) or the frozen promotion gate;
// - a numeric literal other than 0 and 1 in a comparison or a default value: counted per file, and the count may not
//   grow (a new threshold goes into a config file, and the code reads it).
//
// The pins only shrink: a constant moved to config leaves the list, a file whose count fell lowers its pin, and the
// list is checked against the base branch's (a new name or a higher count there is refused).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./tunable-scan');

const REPO = path.resolve(__dirname, '..', '..');
const PINS_REL = 'tests/plugin/no-tunable-literals.pins.json';
const PINS = JSON.parse(fs.readFileSync(path.join(REPO, PINS_REL), 'utf8'));

function current() {
  const constants = {};
  const literals = {};
  for (const f of S.scriptFiles(REPO)) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    const names = [...new Set(S.constantsIn(text).map(c => c.name))];
    if (names.length) constants[f] = names.sort();
    const n = S.literalCount(text);
    if (n) literals[f] = n;
  }
  return { constants, literals };
}

/** The base branch's pins (git merge-base HEAD origin/main), or null when the base has no such file yet. */
function basePins() {
  const git = args => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  const mb = git(['merge-base', 'HEAD', 'origin/main']);
  if (mb.status !== 0) throw new Error(`the base branch can't be read (git merge-base HEAD origin/main): fetch origin/main (CI: actions/checkout fetch-depth: 0)`);
  const shown = git(['show', `${mb.stdout.trim()}:${PINS_REL}`]);
  if (shown.status !== 0) {
    const listed = git(['ls-tree', '--name-only', mb.stdout.trim(), 'tests/plugin/no-tunable-literals.test.js']);
    if (listed.stdout.trim()) throw new Error(`the base has the guard but not ${PINS_REL}: renamed or removed; the pins can't be checked`);
    return null;
  }
  return JSON.parse(shown.stdout);
}

test('guard: no new tunable literal in scripts/ (named constants listed with a reason; per-file literal counts pinned)', () => {
  const now = current();
  const problems = [];
  for (const [f, names] of Object.entries(now.constants)) {
    for (const n of names) if (!(PINS.constants[f] && PINS.constants[f][n])) problems.push(`${f}: ${n} states a numeric literal: move it to a config file (scripts/lib/tunables.js), or list it with why it is no setting`);
  }
  for (const [f, listed] of Object.entries(PINS.constants)) {
    for (const n of Object.keys(listed)) if (!(now.constants[f] || []).includes(n)) problems.push(`${f}: ${n} is listed but no longer a literal: remove it from the list (it only shrinks)`);
    for (const [n, why] of Object.entries(listed)) if (typeof why !== 'string' || why.length < 10) problems.push(`${f}: ${n}: a reason it is no setting`);
  }
  for (const f of new Set([...Object.keys(now.literals), ...Object.keys(PINS.literals)])) {
    const have = now.literals[f] || 0;
    const pin = PINS.literals[f] || 0;
    if (have > pin) problems.push(`${f}: ${have} numeric literals in comparisons or defaults (pinned ${pin}): a new threshold goes into a config file and the code reads it`);
    if (have < pin) problems.push(`${f}: ${have} numeric literals in comparisons or defaults, under its pin ${pin}: lower the pin (it only shrinks)`);
  }
  assert.deepStrictEqual(problems, []);
});

test('guard: the pins only shrink against the base branch', () => {
  const base = basePins();
  if (base === null) return; // the change that brings the guard
  const problems = [];
  for (const [f, listed] of Object.entries(PINS.constants)) for (const n of Object.keys(listed)) if (!(base.constants[f] && base.constants[f][n])) problems.push(`${f}: ${n} is not listed on the base branch: the list may only shrink`);
  for (const [f, n] of Object.entries(PINS.literals)) if (n > (base.literals[f] || 0)) problems.push(`${f}: pinned at ${n}, above the base's ${base.literals[f] || 0}: the counts may only fall`);
  assert.deepStrictEqual(problems, []);
});

test('guard: the scan catches what it claims (planted tunables) and passes what it should (config reads, mechanics)', () => {
  const caught = [
    'const MAX_FOO = 7;', 'const NEAR = 0.35; // a cutoff', 'const LIMITS = { a: [1, 1, 100] };', 'const T = Object.freeze({\n  x: 2,\n});', 'let RETRY_MS = 30 * 1000;',
  ];
  for (const line of caught) assert.strictEqual(S.constantsIn(line).length, 1, line);
  const passed = [
    "const X = require('./tunables').runner().gate.x;", "const NAME = 'v2 of 3';", 'const RE = /^\\d{4}-\\d{2}$/;', "const Y = `${a} 25 bars`;", 'const lower = 5;',
    '// const MAX_FOO = 7;', 'const ITEMS = Object.keys(foo);',
  ];
  for (const line of passed) assert.deepStrictEqual(S.constantsIn(line), [], line);
  for (const [line, n] of [
    ['if (x >= 0.35) return;', 1], ['if (n < 20 && m > 1) go();', 1], ['function f({ minN = 10, seed = 1 }) {}', 1], ['const g = (bars, k = 2) => k;', 1],
    ['if (x > 0 || y === 1) return;', 0], ["const s = 'x >= 30';", 0], ['// if (x >= 30) return;', 0], ['const ok = /a{3}/.test(s) && i < n;', 0], ['if (30 <= n) go();', 1],
  ]) assert.strictEqual(S.literalCount(line), n, line);
  // A planted threshold in a real file raises its count past the pin.
  const f = 'scripts/lib/trading/regime.js';
  const text = fs.readFileSync(path.join(REPO, f), 'utf8');
  assert.strictEqual(S.literalCount(`${text}\nif (adx >= 25) trend = true;\n`), S.literalCount(text) + 1);
  assert.ok(S.constantsIn(`${text}\nconst TREND_ADX = 25;\n`).some(c => c.name === 'TREND_ADX'));
});

test('guard: the frozen promotion gate is the one trading-value constant listed, as frozen', () => {
  assert.match(PINS.constants['scripts/lib/prop/promotion.js'].PROMOTION_GATE, /^frozen by design/);
  const frozen = Object.entries(PINS.constants).flatMap(([f, o]) => Object.entries(o).filter(([, why]) => /^frozen/.test(why)).map(([n]) => `${f}:${n}`));
  assert.deepStrictEqual(frozen, ['scripts/lib/prop/promotion.js:PROMOTION_GATE']);
});
