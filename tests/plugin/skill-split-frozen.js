'use strict';

// The split proofs (tests/plugin/*-split.test.js, setup-skills-rename.test.js) prove that an earlier refactor lost
// nothing: every unit of a frozen old skill is in its new homes, byte for byte. A later rewrite of a home (same rules,
// new words) can't pass them, so each proof compares its old skill with the homes as they were when the rewrite came:
// the split as merged; later rewrites are checked by content pins and review.
//
// tests/fixtures/skill-split/<skill>.at-split.txt: skills/<skill>/SKILL.md exactly as main had it at cbb5acc9 (before
// the terse rewrite of the head trader's embedded skills, fb1c48d5), pinned by hash, so a fixture can't be edited
// along with a proof. A home with no fixture here is read from the tree as before.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const AT_SPLIT = {
  'autonomous-trading': '2b31f07729fd17859df2377ab8c8b9c93d645f6008a5a8f3f455e96d68a51dd4',
  'trade-session': '083b9c465f39144aa1bd06ba58376dea57eb99fe63c56cca9514443fb5c26fe3',
  'role-round': 'c45f48a07ea889789d14b09f82bfb1ba0478047b13d83e76ab25b552c05ae84f',
  'setup-judgment': '82be557c4cd2321a1e056cb0ae0e466e8465108f24bf60366cf82539672740ae',
  'day-context': '376fa17b5b41b54a88275355111dbaf8c55e9398f57c4382f6f4e663690bb802',
  'trade-plan': '6bc3ce788ac019e40e56ab3ae85e66a403be8d77c102c83c7504c7d48849404e',
  'bar-briefing': '5f80b4b18f8726f9c0604c12f715e25c9795c2919e566312f289f2609c0e7229',
  'multi-timeframe-analysis': 'f4519b86219ce406e8e561f76386ce1f7fa5477a80184f3e958fae01d286fc13',
  'htf-to-ltf': '158ebd253ac0e5adb6afd9eebaed3b761ad8683c42e463e8d5d8f8321d04b658',
  rejection: '959362308014eb9c2b1c4a58be57041bd6c98e7878e2dfb6f922664d59418449',
  breakout: 'c247ddfadfaf63ac08e96c9e2d21cf679c84ae4ac262d10544f5f98918f4583e',
};

const fixture = name => `tests/fixtures/skill-split/${name}.at-split.txt`;

/** A home as the split proofs read it: its frozen fixture (hash checked: a changed one throws), else the tree's skill. */
function atSplit(name) {
  if (!Object.hasOwn(AT_SPLIT, name)) return fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  const buf = fs.readFileSync(path.join(ROOT, fixture(name)));
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== AT_SPLIT[name]) throw new Error(`${fixture(name)}: the fixture is the skill as merged, unchanged (sha256 ${sha})`);
  return buf.toString('utf8');
}

module.exports = { AT_SPLIT, atSplit, fixture };
