'use strict';

// The fractal chain on the shipped tree (scripts/lib/trading/chain.js): every policy's RULEBOOK `chain` is the shipped
// one the code's constants read (chain.SHIPPED), it obeys the 2-level rule, and the references that name a chain
// frame read it from the module or agree with it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../../scripts/lib/trading/chain');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BOOKS = fs.readdirSync(path.join(ROOT, 'accounts')).filter(a => fs.existsSync(path.join(ROOT, 'accounts', a, 'RULEBOOK.md')))
  .map(a => ({ file: `accounts/${a}/RULEBOOK.md`, book: parseFrontmatter(read(`accounts/${a}/RULEBOOK.md`)).data }));

test('every shipped policy states its chain, the shipped one (4h: 4h/15m/3m), and its bias frames are the chain\'s', () => {
  assert.ok(BOOKS.length >= 1);
  for (const { file, book } of BOOKS) for (const [name, p] of Object.entries(book.policies || {})) {
    assert.strictEqual(p.entry.chain, C.SHIPPED, `${file} policies.${name}.entry.chain`);
    assert.deepStrictEqual(p.entry.bias_frames, [...C.chainOf(p.entry.chain).bias], `${file} policies.${name}.entry.bias_frames`);
  }
  assert.strictEqual(C.chainOf(C.SHIPPED).name, '4h/15m/3m');
});

test('the 2-level rule holds for every chain the module derives, and the code reads its frames', () => {
  for (const t of C.TOPS) assert.deepStrictEqual(C.twoLevelErrors(C.chainOf(t)), [], t);
  const { BIAS_FRAMES } = require('../../scripts/lib/trading/entry-rule');
  assert.deepStrictEqual([...BIAS_FRAMES], [...C.chainOf(C.SHIPPED).bias], 'the entry rule\'s bias frames are the shipped chain\'s');
  // The modules that name a chain frame take it from the chain (no frame written into them for the bias or the setup).
  for (const f of ['scripts/lib/trading/entry-rule.js', 'scripts/lib/trading/composed-reads.js']) assert.match(read(f), /require\('\.\/chain'\)|chainOf|BIAS_FRAMES/, f);
});
