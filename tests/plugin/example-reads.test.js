'use strict';

// The skills' examples write a composed trade's reads after "Reads:", in compose_check's closed forms
// (scripts/lib/trading/composed-reads.js). Each such read must parse as one of those forms: a read the checker can't
// parse (a retired strategy's name, a level form it doesn't have, prose) would teach a read that never verifies.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseRead } = require('../../scripts/lib/trading/composed-reads');

const ROOT = path.resolve(__dirname, '..', '..');
const skills = fs.readdirSync(path.join(ROOT, 'skills')).filter(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md')));

/** Every "Reads: a, b, c" list in a skill's Examples, as the reads (a list ends at ". ", ";", " (" or "->"). */
function exampleReads(text) {
  const at = text.indexOf('## Examples');
  if (at < 0) return [];
  const flat = text.slice(at).replace(/\s+/g, ' ');
  const out = [];
  for (const m of flat.matchAll(/Reads: (.+?)(?:\. |;| \(| ->| →|\.$)/g)) out.push(...m[1].split(', ').map(s => s.trim()).filter(Boolean));
  return out;
}

test('example reads: every read a skill example lists parses as one of compose_check\'s forms', () => {
  let n = 0;
  for (const s of skills) {
    for (const r of exampleReads(fs.readFileSync(path.join(ROOT, 'skills', s, 'SKILL.md'), 'utf8'))) {
      n += 1;
      const p = parseRead(r);
      assert.ok(!['unknown', 'ambiguous'].includes(p.kind), `${s}: "${r}" is no read form (${p.kind})`);
    }
  }
  assert.ok(n >= 20, `${n} reads checked`);
  // The check sees what it is for: a strategy's name in a list is no read.
  assert.deepStrictEqual(exampleReads('## Examples\n\nTake: Reads: 1h up, vwap_reclaim long. Priority order -> take.\n').map(r => parseRead(r).kind), ['trend', 'unknown']);
});
