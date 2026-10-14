'use strict';

// The multi-timeframe-analysis skill was split by job: multi-timeframe-analysis keeps the read (each timeframe's
// trend, its three votes) and the trend rule as the scan, the backtester and the order gate enforce it (`mtf`,
// `mtf: reversal`), with how to write it down (the name stays: the order gate requires it, REQUIRED_FOR_ENTRY);
// daily-bias takes the daily read and the bias score, htf-to-ltf the alignment labels and the levels flowing down,
// timeframe-sources the bars and the briefing fields per timeframe, mtf-bias-filter the trend as a rules filter.
// This test proves nothing was lost or doubled: every sentence (and every table cell and code line) of the skill as
// it was (tests/fixtures/skill-split/multi-timeframe-analysis.before.txt, frozen) is in the new homes exactly as many
// times as before, byte-for-byte after whitespace is normalised, in its old order within each home. The only
// exceptions are listed, each with its reason; an exception that no longer differs fails too, so the list can only
// shrink.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { units, differences, STRUCTURE } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// skills/multi-timeframe-analysis/SKILL.md as main had it before the split (at e7433091): pinned, so a sentence can't
// be dropped from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/multi-timeframe-analysis.before.txt';
const BEFORE_SHA256 = '46f4f34cda48ad9f02c528b4d89a66c7577a095a7770552bfeecc8dd69746ada';
const HOMES = ['multi-timeframe-analysis', 'daily-bias', 'htf-to-ltf', 'timeframe-sources', 'mtf-bias-filter'];

// Deliberate differences, each with its reason.
const ALLOWED = [
  { old: 'Each timeframe\'s last completed candle (3m, 5m, 15m, 1h), with the levels it met, its previous candle\'s high and low among them, is in `m3` `candles`; the next swing high and low each side is in `m3` `swingTargets`.',
    now: 'Each timeframe\'s last completed candle and the levels it met, and the next swing each side: the `candle-reading` skill.',
    reason: 'a restatement of what candle-reading teaches (the stack, `m3.candles`, `m3.swingTargets`): now a pointer' },
  { old: '`mtf_bias(m)` is the same trend per bar, causal (each bar sees only candles completed before it): 1 up, -1 down, 0 range.',
    now: '`mtf_bias(m)` is the multi-timeframe trend per bar in strategy rules (the `strategy-authoring` skill defines it).',
    reason: 'a restatement of strategy-authoring\'s definition of mtf_bias (as of the last completed candle; 1 up, -1 down, 0 range): now a pointer' },
];

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));

test('multi-timeframe-analysis split: every unit of the old skill is in exactly one new home, in its old order', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('multi-timeframe-analysis split: the comparison catches a lost, a doubled, an edited or a reordered sentence', () => {
  const old = read(BEFORE);
  const u = units(old);
  assert.ok(u.length > 100, `the units are fine-grained (${u.length})`);
  assert.ok(u.includes('the highest timeframe is against it'), 'a table cell is a unit');
  assert.ok(u.includes('The backtester uses the same scan, so its trades obey it.'), 'a sentence is a unit');
  const homes = homeTexts();
  const at = name => HOMES.indexOf(name);
  const swap = (name, text) => homes.map((h, i) => (i === at(name) ? text : h));
  const S = 'The backtester uses the same scan, so its trades obey it.';
  const core = homes[at('multi-timeframe-analysis')];
  assert.ok(core.includes(S));
  // Lost, doubled, edited.
  assert.notDeepStrictEqual(differences(old, swap('multi-timeframe-analysis', core.replace(S, '')), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('daily-bias', `${homes[at('daily-bias')]}\n${S}\n`), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('multi-timeframe-analysis', core.replace('fewer than 3 completed candles', 'fewer than 2 completed candles')), ALLOWED), []);
  // Reordered: two rows of the alignment table swapped (nothing lost, the order changed).
  const h = homes[at('htf-to-ltf')];
  const R1 = /^\| `aligned` .*\n/m.exec(h)[0];
  const R2 = /^\| `counter` .*\n/m.exec(h)[0];
  const swapped = h.replace(R1, '\u0000').replace(R2, R1).replace('\u0000', R2);
  assert.deepStrictEqual(differences(old, swap('htf-to-ltf', swapped), ALLOWED), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap('htf-to-ltf', swapped), HOMES, ALLOWED), [], 'but changes the order');
  // A changed sentence reverted to its old text (the exception no longer needed) fails: the list only shrinks.
  const f = homes[at('mtf-bias-filter')];
  const reverted = f.replace(/`mtf_bias\(m\)` is the multi-timeframe trend[^]*?defines it\)\./, ALLOWED[1].old);
  assert.notStrictEqual(reverted, f);
  assert.notDeepStrictEqual(differences(old, swap('mtf-bias-filter', reverted), ALLOWED), []);
  // A section heading dropped.
  assert.notDeepStrictEqual(differences(old, swap('daily-bias', homes[at('daily-bias')].replace('## Examples', '## Example')), ALLOWED), []);
});

test('multi-timeframe-analysis split: each skill has a short "Use when" index line, and the core points to the rest', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
    assert.match(d, /^Use when /, s);
    for (const hd of STRUCTURE) assert.ok(read(`skills/${s}/SKILL.md`).includes(`## ${hd}`), `${s}: ## ${hd}`);
  }
  const core = read('skills/multi-timeframe-analysis/SKILL.md').replace(/\s+/g, ' ');
  for (const s of HOMES.slice(1)) assert.match(core, new RegExp(`\\(\`${s}\`\\)`), `multi-timeframe-analysis points to ${s}`);
  // The trend rule stays in the core, the name the order gate requires; the moved jobs left it.
  assert.ok(require('../../scripts/lib/trading/skills-loaded').REQUIRED_FOR_ENTRY.includes('multi-timeframe-analysis'));
  assert.match(core, /### 2\. The trend rule \(enforced, not advice\)[^#]*`mtf: reversal`[^#]*The order gate \(`mtf-trend`, hard/);
  assert.doesNotMatch(core, /### \d\. (Get the bars|Run the read|Read the alignment|Levels flow down|In rules)|```yaml|\| `pullback` \|/);
});

test('multi-timeframe-analysis split: the market-structure analyst loads what its body uses; others point to the new homes', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  const { data } = parseFrontmatter(read('agents/market-structure-analyst.md'));
  assert.ok(data['role-skills'].includes('htf-to-ltf'), 'htf-to-ltf is core: its HTF and Location lines, every report');
  assert.ok(data['role-index'].includes('daily-bias'), 'daily-bias is looked up as needed');
  for (const s of ['timeframe-sources', 'mtf-bias-filter']) assert.ok(![...data['role-skills'], ...data['role-index']].includes(s), s);
  assert.match(read('skills/premarket/SKILL.md').replace(/\s+/g, ' '), /see the `timeframe-sources` and `daily-bias` skills/);
  assert.match(read('skills/trade-session/SKILL.md'), /\(`mtf_read` with the bars file, the `timeframe-sources` skill\)/);
  assert.match(read('skills/trade-session/SKILL.md').replace(/\s+/g, ' '), /the alignment table in `htf-to-ltf`/);
  assert.match(read('skills/pullback-vs-reversal/SKILL.md'), /shift or reclaim of `htf-to-ltf`/);
});
