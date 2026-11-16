'use strict';

// Displacement is a read, never a setup or a wait (the owner, 2026-11-15: "Displacement measures strength. Structure
// determines confirmation. Protected swings determine structural invalidation."): the briefing computes a break's
// `quality` (displacement.js) and prints it on the Break quality line, and no gate, hook, gateway, compose, entry-rule,
// sizing, exit or decision code reads it. Every file under scripts/ and hooks/ that requires displacement.js, names its
// functions, or reads a `quality` field in code (comments and strings aside) is on this allow-list; anything else fails.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { codeOnly } = require('./tunable-scan');

const ROOT = path.join(__dirname, '..', '..');
const HOME = 'scripts/lib/trading/displacement.js';
const REQUIRERS = ['scripts/lib/trading/briefing.js'];

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(rel));
    else if (/\.(c?js|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const ALL = [...files('scripts'), ...files('hooks')];
const code = f => codeOnly(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const REQUIRE = /require\([^)]*\/displacement['"]\)/;
const NAMES = /\b(?:breakQuality|breakLine|qualityOf|invalidationQuality|strengthAt|candleDisplaced)\b/;
// A `quality` field read or written: the identifier anywhere in code (x.quality, { quality }, quality: 1), or the bare
// string 'quality' (x['quality'], omit(x, ['quality'])) in the raw text.
const IDENT = /\bquality\b/;
const STRING = /(['"`])quality\1/;
const reads = text => IDENT.test(codeOnly(text)) || STRING.test(text);

test('only the briefing requires displacement.js', () => {
  assert.deepStrictEqual(ALL.filter(f => REQUIRE.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))).sort(), REQUIRERS);
});

test('no other script or hook names the displacement functions or reads a `quality` field', () => {
  const allowed = new Set([HOME, ...REQUIRERS]);
  assert.deepStrictEqual(ALL.filter(f => !allowed.has(f) && NAMES.test(code(f))), []);
  assert.deepStrictEqual(ALL.filter(f => !allowed.has(f) && reads(fs.readFileSync(path.join(ROOT, f), 'utf8'))), []);
});

test('the decision paths are not among the readers, and the scan sees them and would catch a reader', () => {
  const decides = /(^hooks\/|^scripts\/hooks\/|gate|gateway|compose|entry-rule|order-plan|decision|verdict|phase2|autotrader|runner|skills-loaded|lifecycle|sizing|exit)/;
  for (const f of REQUIRERS) assert.doesNotMatch(f, decides, f);
  assert.ok(ALL.some(f => /order-gate/.test(f)) && ALL.includes('scripts/mcp-gateway.js') && ALL.some(f => /composed-reads/.test(f)), 'the decision files are scanned');
  // The patterns catch what they guard (a gate line reading the break's quality), and pass prose and comments.
  for (const bad of ["if (b.m3.lastBreak.last.quality.displaced) return 'ok';", 'const { quality } = lb;', 'const x = { quality: 1 };', "lb['quality']", "omit(x, ['quality'])"]) {
    assert.ok(reads(bad), bad);
  }
  for (const fine of ['// the quality of the read', "const s = 'Pass quality';", '/* quality */ const q = 1;']) assert.ok(!reads(fine), fine);
  assert.ok(NAMES.test(codeOnly('const { breakQuality } = require(\'./displacement\');')));
});
