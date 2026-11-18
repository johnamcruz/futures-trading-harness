'use strict';

// One source for a protected swing's status (swing-holds Build 1): a close past the tie breaks it and it stays broken
// (scripts/lib/trading/protected-status.js). The 3m machine, the break record and the Break quality line require the
// predicate; every other printer reads the record (the Manage read through protectedOf, the Market state, compose_check,
// the scorecards). Under scripts/ a `brokenAt` is assigned only where the record is made (structure-events.js: protectedOf,
// and swingLevels' swings, another object), at the briefing's htfLevels (any 15m/1h swing, another object, by name) and
// where a quiz item states its printed fact (eval/context-quiz.js: parsed from the item's text, never computed).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { codeOnly } = require('./tunable-scan');

const ROOT = path.join(__dirname, '..', '..');
// manage-read.js too: it names a tie (statusOf's `tied`) beside the record's banded brokenAt (review m5).
const REQUIRERS = ['scripts/lib/trading/displacement.js', 'scripts/lib/trading/manage-read.js', 'scripts/lib/trading/structure-events.js', 'scripts/lib/trading/structure-layers.js'];
// File -> the number of `brokenAt` assignments in its code, each named above.
const ASSIGNS = { 'scripts/lib/eval/context-quiz.js': 1, 'scripts/lib/trading/briefing.js': 1, 'scripts/lib/trading/structure-events.js': 2 };

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(rel));
    else if (/\.(c?js|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const ALL = files('scripts');
const REQUIRE = /require\([^)]*\/protected-status['"]\)/;
const ASSIGN = /\bbrokenAt\s*(?::|=(?!=))/g;
const assigns = text => (codeOnly(text).match(ASSIGN) || []).length;

test('protected-status.js is required by the 3m machine, the break record, the Break quality line and the Manage read, and nothing else', () => {
  assert.deepStrictEqual(ALL.filter(f => REQUIRE.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))).sort(), REQUIRERS);
});

test('a brokenAt is assigned only where the record is made, at the htfLevels and in a quiz item\'s stated facts', () => {
  const got = {};
  for (const f of ALL) { const n = assigns(fs.readFileSync(path.join(ROOT, f), 'utf8')); if (n) got[f] = n; }
  assert.deepStrictEqual(got, ASSIGNS);
  const b = fs.readFileSync(path.join(ROOT, 'scripts/lib/trading/briefing.js'), 'utf8').split('\n').filter(l => ASSIGN.test(codeOnly(l)));
  assert.ok(b.length === 1 && /swing \$\{x\.type\}/.test(b[0]), 'the briefing\'s one is the htfLevels swing');
});

test('the scan catches an assignment and passes prose and reads', () => {
  for (const bad of ['const p = { brokenAt: null };', 'x.brokenAt = t;', 'return { ...p, brokenAt: j };']) assert.strictEqual(assigns(bad), 1, bad);
  for (const fine of ['// brokenAt: the first close', 'if (p.brokenAt === null) return;', 'const b = Boolean(p.brokenAt);', "const s = 'brokenAt: x';"]) assert.strictEqual(assigns(fine), 0, fine);
});
