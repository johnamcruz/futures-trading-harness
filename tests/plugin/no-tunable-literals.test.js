'use strict';

// Tunables live in config/ (scripts/lib/tunables.js), never as literals in scripts/. This guard scans every .js under
// scripts/ for what looks like a tunable stated in code (tunable-scan.js):
//
// - an UPPER_CASE constant whose value states a numeric literal: allowed only when it is listed in
//   no-tunable-literals.pins.json with why it is no setting (a unit, a format version, an id or enum, a timeframe
//   table, a parse or input limit, an interface fact, a float tolerance, the exchange hours, a schema, a function's
//   local, a definition the skills teach, a document's code ceiling, contract facts) or the frozen promotion gate;
//   A lower-case constant stated as numbers (const half = 0.5) is one too;
// - a numeric literal other than 0 and 1 in a comparison, a default value, a fallback (x || 5, x ?? 5), an object literal's
//   value, a number assigned to a property (this.k = 5), a bare numeric call argument (setTimeout(f, 5000), list.slice(0, 20)),
//   Math.max / Math.min arguments or a fractional factor (x * 0.35): counted per file, and the count may not grow (a new threshold
//   goes into a config file, and the code reads it). A listed mechanical form (`mechanics`: a protocol's code, each with
//   its reason) is not counted.
//
// The pins only shrink: a constant moved to config leaves the list, a file whose count fell lowers its pin, and the
// list is checked against the base branch's (a new name, an edited reason or a higher count there is refused).
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
    const n = S.literalCount(text, { mechanics: Object.keys(PINS.mechanics || {}) });
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
  for (const [form, why] of Object.entries(PINS.mechanics || {})) {
    if (typeof why !== 'string' || why.length < 10) problems.push(`mechanics: ${form}: a reason it is no setting`);
    try { new RegExp(form, 'g'); } catch (e) { problems.push(`mechanics: ${form}: not a regular expression (${e.message})`); continue; }
    const used = S.scriptFiles(REPO).some(f => new RegExp(form).test(S.codeOnly(fs.readFileSync(path.join(REPO, f), 'utf8'))));
    if (!used) problems.push(`mechanics: ${form} is listed but matches no code: remove it from the list (it only shrinks)`);
  }
  for (const f of new Set([...Object.keys(now.literals), ...Object.keys(PINS.literals)])) {
    const have = now.literals[f] || 0;
    const pin = PINS.literals[f] || 0;
    if (have > pin) problems.push(`${f}: ${have} numeric literals in comparisons or defaults (pinned ${pin}): a new threshold goes into a config file and the code reads it`);
    if (have < pin) problems.push(`${f}: ${have} numeric literals in comparisons or defaults, under its pin ${pin}: lower the pin (it only shrinks)`);
  }
  assert.deepStrictEqual(problems, []);
});

/** What the pins change against the base's: a name added, a reason edited, a count raised (each refused). */
function againstBase(pins, base) {
  const problems = [];
  for (const [f, listed] of Object.entries(pins.constants)) {
    for (const [n, why] of Object.entries(listed)) {
      const was = base.constants[f] && base.constants[f][n];
      if (!was) problems.push(`${f}: ${n} is not listed on the base branch: the list may only shrink`);
      else if (was !== why) problems.push(`${f}: ${n}'s reason differs from the base branch's ("${was}"): a reason is not edited in place`);
    }
  }
  for (const [form, why] of Object.entries(pins.mechanics || {})) {
    const was = (base.mechanics || {})[form];
    if (!was) problems.push(`mechanics: ${form} is not listed on the base branch: the list may only shrink`);
    else if (was !== why) problems.push(`mechanics: ${form}'s reason differs from the base branch's ("${was}"): a reason is not edited in place`);
  }
  for (const [f, n] of Object.entries(pins.literals)) if (n > (base.literals[f] || 0)) problems.push(`${f}: pinned at ${n}, above the base's ${base.literals[f] || 0}: the counts may only fall`);
  return problems;
}

test('guard: the pins only shrink against the base branch, and a listed reason is never edited in place', () => {
  const base = basePins();
  if (base === null) return; // the change that brings the guard
  assert.deepStrictEqual(againstBase(PINS, base), []);
});

test('guard: the base comparison catches a name added, a reason edited and a count raised', () => {
  const base = { constants: { 'a.js': { X: 'a unit (milliseconds in a minute)' } }, literals: { 'a.js': 3 } };
  assert.deepStrictEqual(againstBase(base, base), []);
  assert.deepStrictEqual(againstBase({ constants: {}, literals: { 'a.js': 2 } }, base), [], 'shrinking is fine');
  assert.match(againstBase({ ...base, constants: { 'a.js': { ...base.constants['a.js'], Y: 'a unit, honestly' } } }, base).join(), /Y is not listed on the base branch/);
  assert.match(againstBase({ ...base, constants: { 'a.js': { X: 'a unit, and a threshold now' } } }, base).join(), /X's reason differs from the base branch's/);
  assert.match(againstBase({ ...base, literals: { 'a.js': 4 } }, base).join(), /pinned at 4, above the base's 3/);
  const withForm = { ...base, mechanics: { 'exitCode:\\s*2\\b': 'the hook protocol\'s block exit code' } };
  assert.deepStrictEqual(againstBase(withForm, withForm), []);
  assert.match(againstBase(withForm, base).join(), /mechanics: .* is not listed on the base branch/);
  assert.match(againstBase({ ...withForm, mechanics: { 'exitCode:\\s*2\\b': 'any exit code we like' } }, withForm).join(), /mechanics: .*'s reason differs from the base branch's/);
});

test('guard: the scan catches what it claims (planted tunables) and passes what it should (config reads, mechanics)', () => {
  const caught = [
    'const MAX_FOO = 7;', 'const NEAR = 0.35; // a cutoff', 'const LIMITS = { a: [1, 1, 100] };', 'const T = Object.freeze({\n  x: 2,\n});', 'let RETRY_MS = 30 * 1000;',
  ];
  for (const line of caught) assert.strictEqual(S.constantsIn(line).length, 1, line);
  // Lower-case constants stated as numbers are caught too (any indentation); a computation or 0 and 1 is not one.
  for (const line of ['const lower = 5;', '  let tries = 3;', 'const half = 0.5;', 'const windowMs = 30 * 1000;', 'var eps = 1e-9;']) assert.strictEqual(S.constantsIn(line).length, 1, line);
  const passed = [
    "const X = require('./tunables').runner().gate.x;", "const NAME = 'v2 of 3';", 'const RE = /^\\d{4}-\\d{2}$/;', "const Y = `${a} 25 bars`;",
    '// const MAX_FOO = 7;', 'const ITEMS = Object.keys(foo);', 'let i = 0;', 'const one = 1;', 'const half = x / 2;', 'const n = list.length;',
  ];
  for (const line of passed) assert.deepStrictEqual(S.constantsIn(line), [], line);
  for (const [line, n] of [
    ['if (x >= 0.35) return;', 1], ['if (n < 20 && m > 1) go();', 1], ['function f({ minN = 10, seed = 1 }) {}', 1], ['const g = (bars, k = 2) => k;', 1],
    ['if (x > 0 || y === 1) return;', 0], ["const s = 'x >= 30';", 0], ['// if (x >= 30) return;', 0], ['const ok = /a{3}/.test(s) && i < n;', 0], ['if (30 <= n) go();', 1],
    // An object literal's numeric values (a key quoted or not), not 0 or 1, and not a ternary.
    ['const o = { minN: 20, level: 0.9, off: 0, on: 1 };', 2], ["run({ 'max-depth': 8 });", 1], ['const v = a ? 5 : b;', 0],
    // Math.max / Math.min with numeric literals, wherever they stand in the call.
    ['const floor = Math.max(8, ticks);', 1], ['const c = Math.min(x, 0.25 * atr);', 1], ['const z = Math.max(0, Math.min(1, x));', 0], ['const w = Math.min(a, Math.max(b, 3), 40);', 2],
    // A fractional factor either side of a multiplication; an exponent is not one.
    ['const stop = atr * 0.35;', 1], ['const t = 1.5 * range;', 1], ['const p = 2 ** 0.5;', 0], ['const q = x * 2;', 0], ['const r = x * .5;', 1],
    // One literal two patterns see counts once.
    ['f({ k: 0.5 * x });', 1],
    // A fallback default (x || 5, x ?? 0.5), a number assigned to a property, a bare numeric call argument.
    ['const n = opts.n || 5;', 1], ['const w = cfg.w ?? 0.5;', 1], ['const z = a || 0;', 0], ['const o = a ?? 1;', 0],
    ['this.limit = 40;', 1], ['state.retries = 3;', 1], ['state.flags[k] = 9;', 1], ['this.n = 0;', 0], ['state.on = 1;', 0], ['this.n += 4;', 0],
    ['setTimeout(done, 5000);', 1], ['const top = list.slice(0, 20);', 1], ['const tail = list.slice(-4);', 1], ['go(f(0), 1);', 0], ['if (ready) setTimeout(g, 0);', 0],
  ]) assert.strictEqual(S.literalCount(line), n, line);
  // A listed mechanical form (with its reason in the pins) is not counted; any other number on the line still is.
  const mechanics = ['exitCode:\\s*2\\b'];
  assert.strictEqual(S.literalCount('return { stderr: m, exitCode: 2 };'), 1);
  assert.strictEqual(S.literalCount('return { stderr: m, exitCode: 2 };', { mechanics }), 0);
  assert.strictEqual(S.literalCount('return { exitCode: 2, retries: 5 };', { mechanics }), 1);
  assert.strictEqual(S.literalCount('return { exitCode: 3 };', { mechanics }), 1, 'only the listed form');
  // The reasoned mechanics are the pins' (PINS.mechanics: digits of a printed number, a timestamp's field positions, a
  // process exit code, ...): each listed form passes, its neighbour that states a count does not.
  const real = Object.keys(PINS.mechanics);
  for (const [line, n] of [['x.toFixed(2);', 0], ['x.padStart(2, "0");', 0], ['JSON.stringify(v, null, 2);', 0], ['d.toISOString().slice(0, 10);', 0], ['process.exit(2);', 0], ['argv.slice(2);', 0],
    ['round(x, 3);', 0], ['list.slice(0, 10);', 1], ['setTimeout(f, 30);', 1], ['x.toFixed(2) + (y || 30);', 1]]) assert.strictEqual(S.literalCount(line, { mechanics: real }), n, line);
  // A named constant's own statement is not counted (the constant is listed with its reason instead).
  assert.strictEqual(S.literalCount('const T = Object.freeze({\n  a: 7,\n  b: x * 0.5,\n});\nif (y > 9) z();'), 1);
  // A planted threshold in a real file raises its count past the pin.
  const f = 'scripts/lib/trading/regime.js';
  const text = fs.readFileSync(path.join(REPO, f), 'utf8');
  assert.strictEqual(S.literalCount(`${text}\nif (adx >= 25) trend = true;\n`), S.literalCount(text) + 1);
  assert.ok(S.constantsIn(`${text}\nconst TREND_ADX = 25;\n`).some(c => c.name === 'TREND_ADX'));
  // Each new pattern, planted in the real file, raises its count too.
  for (const planted of ['const cut = { trendAdx: 25 };', 'const lo = Math.max(18, adx);', 'const slope = atr * 0.3;', 'const a = opts.adx || 25;', 'const b = opts.adx ?? 25;',
    'this.adxCut = 25;', 'cfg.adxCut = 25;', 'setTimeout(check, 2500);', 'const first = list.slice(0, 25);']) {
    assert.strictEqual(S.literalCount(`${text}\n${planted}\n`), S.literalCount(text) + 1, planted);
  }
  assert.ok(S.constantsIn(`${text}\nconst trendAdx = 25;\n`).some(c => c.name === 'trendAdx'));
});

test('guard: the frozen promotion gate is the one trading-value constant listed, as frozen', () => {
  assert.match(PINS.constants['scripts/lib/prop/promotion.js'].PROMOTION_GATE, /^frozen by design/);
  const frozen = Object.entries(PINS.constants).flatMap(([f, o]) => Object.entries(o).filter(([, why]) => /^frozen/.test(why)).map(([n]) => `${f}:${n}`));
  assert.deepStrictEqual(frozen, ['scripts/lib/prop/promotion.js:PROMOTION_GATE']);
});
