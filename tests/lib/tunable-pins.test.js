'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanHash, counts, regen } = require('../../scripts/lib/tunable-pins');

const REPO = path.resolve(__dirname, '..', '..');

/** A tiny repo: the real scanner, one script with a tunable literal and a listed mechanic. */
function fixture(script) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tunable-pins-'));
  fs.mkdirSync(path.join(dir, 'tests', 'plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(REPO, 'tests', 'plugin', 'tunable-scan.js'), path.join(dir, 'tests', 'plugin', 'tunable-scan.js'));
  fs.writeFileSync(path.join(dir, 'scripts', 'a.js'), script);
  return dir;
}

test('scanHash follows the scanner\'s source and nothing else', () => {
  const dir = fixture('const x = 1;\n');
  const h = scanHash(dir);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.strictEqual(h, scanHash(REPO), 'the same scanner, the same hash');
  fs.writeFileSync(path.join(dir, 'scripts', 'a.js'), 'if (x > 9) y();\n');
  assert.strictEqual(scanHash(dir), h, 'a script is not the scanner');
  fs.appendFileSync(path.join(dir, 'tests', 'plugin', 'tunable-scan.js'), '// changed\n');
  assert.notStrictEqual(scanHash(dir), h);
});

test('counts: per-file literals and constants as the scanner sees them, listed mechanics skipped', () => {
  const dir = fixture('const MAX_FOO = 7;\nif (n > 9) go();\nprocess.exit(2);\n');
  assert.deepStrictEqual(counts(dir, []), { constants: { 'scripts/a.js': ['MAX_FOO'] }, literals: { 'scripts/a.js': 2 } });
  assert.deepStrictEqual(counts(dir, ['\\bprocess\\.exit\\(\\s*\\d+\\s*\\)']).literals, { 'scripts/a.js': 1 });
});

test('regen: counts set to the scanner\'s, dead mechanics and gone constants dropped, new constants only noted, scan raised only when the scanner changed', () => {
  const dir = fixture('const MAX_FOO = 7;\nconst NEW_ONE = 5;\nif (n > 9) go();\nprocess.exit(2);\n');
  const pins = {
    scan: 2, scanHash: scanHash(dir),
    constants: { 'scripts/a.js': { MAX_FOO: 'a limit, not a setting', GONE: 'a limit that left the code' } },
    mechanics: { '\\bprocess\\.exit\\(\\s*\\d+\\s*\\)': 'a process exit code', 'neverMatches\\(': 'a form no code has' },
    literals: { 'scripts/a.js': 99, 'scripts/gone.js': 4 },
  };
  const { pins: out, notes } = regen(dir, pins);
  assert.strictEqual(out.scan, 2, 'the scanner is the pinned one');
  assert.deepStrictEqual(out.literals, { 'scripts/a.js': 1 }, 'padded and stale counts replaced');
  assert.deepStrictEqual(Object.keys(out.mechanics), ['\\bprocess\\.exit\\(\\s*\\d+\\s*\\)']);
  assert.deepStrictEqual(out.constants, { 'scripts/a.js': { MAX_FOO: 'a limit, not a setting' } }, 'GONE dropped, NEW_ONE not added');
  assert.ok(notes.some(n => /GONE is no longer a literal/.test(n)));
  assert.ok(notes.some(n => /NEW_ONE states a numeric literal and is not listed/.test(n)));
  assert.ok(notes.some(n => /neverMatches/.test(n)));
  // A scanner whose hash differs from the pinned one raises scan; with no hash pinned yet it does not.
  fs.appendFileSync(path.join(dir, 'tests', 'plugin', 'tunable-scan.js'), '// wider\n');
  assert.strictEqual(regen(dir, pins).pins.scan, 3);
  assert.strictEqual(regen(dir, pins).pins.scanHash, scanHash(dir));
  assert.strictEqual(regen(dir, { ...pins, scanHash: undefined }).pins.scan, 2);
});

test('regen on the committed pins changes nothing (they are what the scanner gives)', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'plugin', 'no-tunable-literals.pins.json'), 'utf8'));
  const { pins } = regen(REPO, committed);
  assert.deepStrictEqual(pins, committed);
});
