'use strict';

// The multi-timeframe-analysis skill was split by job: multi-timeframe-analysis keeps the read (each timeframe's
// trend, its three votes) and the trend rule as the scan, the backtester and the order gate enforce it (`mtf`,
// `mtf: reversal`), with how to write it down (the name stays: the order gate requires it, REQUIRED_FOR_ENTRY);
// daily-bias takes the daily read and the bias score, htf-to-ltf the alignment labels and the levels flowing down,
// timeframe-sources the bars and the briefing fields per timeframe, mtf-bias-filter the trend as a rules filter.
// This test proves nothing was lost, doubled or misplaced: every sentence (and every table cell and code line) of the
// skill as it was (tests/fixtures/skill-split/multi-timeframe-analysis.before.txt, frozen) is in the new homes exactly
// as many times as before, byte-for-byte after whitespace is normalised, in the home its old section maps to, in its
// old order within each home. The only exceptions are listed, each with its reason; an exception that no longer
// differs fails too, so the list can only shrink.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { units, count, differences, STRUCTURE } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// skills/multi-timeframe-analysis/SKILL.md as main had it before the split (at e7433091): pinned, so a sentence can't
// be dropped from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/multi-timeframe-analysis.before.txt';
const BEFORE_SHA256 = '46f4f34cda48ad9f02c528b4d89a66c7577a095a7770552bfeecc8dd69746ada';
const HOMES = ['multi-timeframe-analysis', 'daily-bias', 'htf-to-ltf', 'timeframe-sources', 'mtf-bias-filter'];

// Each moved home and the fixture's units it takes (units(BEFORE) indices, inclusive ranges); every other unit stays
// in multi-timeframe-analysis (HOMES[0]).
const MOVED = {
  // When to Use's premarket line, the daily fallback and fetch, the daily as context, the bias score, the daily swings.
  'daily-bias': [[4, 4], [29, 30], [35, 35], [81, 81], [87, 87]],
  // When to Use's disagreement line, "Read the alignment" (table, policy ceiling, reversals), "Levels flow down".
  'htf-to-ltf': [[6, 6], [63, 80], [82, 85], [88, 88]],
  // "Get the bars" and its table, "Run the read" (briefing fields, mtf_read calls, the bars path), the briefing levels.
  'timeframe-sources': [[8, 28], [31, 34], [36, 39], [86, 86]],
  // "In rules (mechanical strategies)".
  'mtf-bias-filter': [[93, 102]],
};

// Deliberate differences, each with its reason.
const ALLOWED = [
  { old: 'Every trade plan, before risk-manager phase 1: is this setup with the higher timeframes, a pullback inside them, or against them?',
    now: 'Every trade plan, before risk-manager phase 1: each timeframe\'s trend, and whether the trend rule allows the side (with them, a pullback or against them: `htf-to-ltf`).',
    reason: 'with, pullback or against is the alignment, now htf-to-ltf: the core\'s line asks what the core answers and points there' },
  { old: 'Each timeframe\'s last completed candle (3m, 5m, 15m, 1h), with the levels it met, its previous candle\'s high and low among them, is in `m3` `candles`; the next swing high and low each side is in `m3` `swingTargets`.',
    now: 'Each timeframe\'s last completed candle and the levels it met, and the next swing each side: the `candle-reading` skill.',
    reason: 'a restatement of what candle-reading teaches (the stack, `m3.candles`, `m3.swingTargets`): now a pointer' },
  { old: '`mtf_bias(m)` is the same trend per bar, causal (each bar sees only candles completed before it): 1 up, -1 down, 0 range.',
    now: '`mtf_bias(m)` is the multi-timeframe trend per bar in strategy rules (the `strategy-authoring` skill defines it).',
    reason: 'a restatement of strategy-authoring\'s definition of mtf_bias (as of the last completed candle; 1 up, -1 down, 0 range): now a pointer' },
];

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));

/** The old units each home must hold: Map home -> Map unit -> count (HOMES[0] takes every unit not moved). */
function expectedHomes(beforeText) {
  const old = units(beforeText);
  const home = old.map(() => HOMES[0]);
  for (const [h, ranges] of Object.entries(MOVED)) for (const [a, b] of ranges) for (let i = a; i <= b; i++) home[i] = h;
  const out = new Map(HOMES.map(h => [h, new Map()]));
  old.forEach((u, i) => { if (!STRUCTURE.includes(u)) out.get(home[i]).set(u, (out.get(home[i]).get(u) || 0) + 1); });
  return out;
}

/** Old units in a home their old section doesn't map to (or missing from the one it does): [] when each is home. */
function homeErrors(beforeText, texts) {
  const expected = expectedHomes(beforeText);
  const old = new Set(units(beforeText));
  const nowToOld = new Map(ALLOWED.flatMap(a => [a.now || []].flat().map(n => [n, a.old])));
  const bad = [];
  HOMES.forEach((h, i) => {
    const got = count(units(texts[i]).map(u => nowToOld.get(u) || u).filter(u => old.has(u) && !STRUCTURE.includes(u)));
    const want = expected.get(h);
    for (const u of new Set([...got.keys(), ...want.keys()])) {
      if ((got.get(u) || 0) !== (want.get(u) || 0)) bad.push(`${h}: ${JSON.stringify(u)} ${got.get(u) || 0} time(s), its old section maps ${want.get(u) || 0} here`);
    }
  });
  return bad;
}

test('multi-timeframe-analysis split: every unit of the old skill is in exactly one new home, its own, in its old order', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(homeErrors(read(BEFORE), homeTexts()), [], 'each unit is in the home its old section maps to');
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('multi-timeframe-analysis split: the comparison catches a lost, a doubled, an edited, a misplaced or a reordered sentence', () => {
  const old = read(BEFORE);
  const u = units(old);
  assert.ok(u.length > 100, `the units are fine-grained (${u.length})`);
  assert.ok(u.includes('the highest timeframe is against it'), 'a table cell is a unit');
  assert.ok(u.includes('The backtester uses the same scan, so its trades obey it.'), 'a sentence is a unit');
  // The pins name the sections they say: a range's first and last units.
  assert.strictEqual(u[63], 'Read the alignment');
  assert.strictEqual(u[93], 'In rules (mechanical strategies)');
  assert.strictEqual(u[8], 'Get the bars (one request per timeframe at most)');
  assert.match(u[82], /^Reversal strategies/);
  const homes = homeTexts();
  const at = name => HOMES.indexOf(name);
  const swap = (...pairs) => homes.map((h, i) => { const p = pairs.find(([n]) => at(n) === i); return p ? p[1] : h; });
  const S = 'The backtester uses the same scan, so its trades obey it.';
  const core = homes[at('multi-timeframe-analysis')];
  assert.ok(core.includes(S));
  // Lost, doubled, edited.
  assert.notDeepStrictEqual(differences(old, swap(['multi-timeframe-analysis', core.replace(S, '')]), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap(['daily-bias', `${homes[at('daily-bias')]}\n${S}\n`]), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap(['multi-timeframe-analysis', core.replace('fewer than 3 completed candles', 'fewer than 2 completed candles')]), ALLOWED), []);
  // Misplaced: the trend-rule bullet moved into mtf-bias-filter, or the reversal paragraph out of htf-to-ltf into the
  // core: nothing is lost or doubled, but it left its home.
  const BULLET = /- \*\*Trend strategies\*\*[^]*?both sides are open\.\n/.exec(core)[0];
  const f = homes[at('mtf-bias-filter')];
  const moved1 = swap(['multi-timeframe-analysis', core.replace(BULLET, '')], ['mtf-bias-filter', `${f}\n${BULLET}`]);
  assert.deepStrictEqual(differences(old, moved1, ALLOWED), [], 'the move loses nothing');
  assert.notDeepStrictEqual(homeErrors(old, moved1), [], 'but the trend rule left the core');
  const h = homes[at('htf-to-ltf')];
  const REV = /Reversal strategies \(`crt_1h`[^]*?size, target\)\.\n/.exec(h)[0];
  const moved2 = swap(['htf-to-ltf', h.replace(REV, '')], ['multi-timeframe-analysis', `${core}\n${REV}`]);
  assert.deepStrictEqual(differences(old, moved2, ALLOWED), [], 'the move loses nothing');
  assert.notDeepStrictEqual(homeErrors(old, moved2), [], 'but the reversal paragraph left htf-to-ltf');
  // Reordered: two rows of the alignment table swapped (nothing lost, the order changed).
  const R1 = /^\| `aligned` .*\n/m.exec(h)[0];
  const R2 = /^\| `counter` .*\n/m.exec(h)[0];
  const swapped = h.replace(R1, '\u0000').replace(R2, R1).replace('\u0000', R2);
  assert.deepStrictEqual(differences(old, swap(['htf-to-ltf', swapped]), ALLOWED), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap(['htf-to-ltf', swapped]), HOMES, ALLOWED), [], 'but changes the order');
  // A changed sentence reverted to its old text (the exception no longer needed) fails: the list only shrinks.
  const reverted = f.replace(/`mtf_bias\(m\)` is the multi-timeframe trend[^]*?defines it\)\./, ALLOWED[2].old);
  assert.notStrictEqual(reverted, f);
  assert.notDeepStrictEqual(differences(old, swap(['mtf-bias-filter', reverted]), ALLOWED), []);
  // A section heading dropped.
  assert.notDeepStrictEqual(differences(old, swap(['daily-bias', homes[at('daily-bias')].replace('## Examples', '## Example')]), ALLOWED), []);
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
  // The /mtf command promises the alignment and names the skill that has it.
  assert.match(read('commands/mtf.md').replace(/\s+/g, ' '), /Use the `multi-timeframe-analysis` skill for: \$ARGUMENTS \(with the `htf-to-ltf` skill for each side's alignment, and `timeframe-sources` for the bars\)/);
});

/** The skills trade-session step 0 tells the head trader to load every cycle (its backticked skill names). */
function headTraderLoads() {
  const ts = read('skills/trade-session/SKILL.md');
  const step0 = ts.slice(ts.indexOf('### 0. Load the skills'), ts.indexOf('### 1.'));
  const names = [...step0.matchAll(/`([a-z][a-z-]+)`/g)].map(m => m[1]).filter(n => fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md')));
  return [...new Set(names)];
}

test('multi-timeframe-analysis split: the head trader loads htf-to-ltf every cycle, so it still reads the alignment rule', () => {
  const loads = headTraderLoads();
  for (const s of [...require('../../scripts/lib/trading/skills-loaded').REQUIRED_FOR_ENTRY, 'trader-process', 'htf-to-ltf']) assert.ok(loads.includes(s), `trade-session step 0 loads ${s}`);
  // Every unit of the old alignment section (the table, the policy ceiling) and its reversal paragraph is in a skill the
  // head trader loads every cycle.
  const old = units(read(BEFORE));
  const loaded = new Set(loads.flatMap(s => units(read(`skills/${s}/SKILL.md`))));
  for (let i = 63; i <= 83; i++) if (i !== 81) assert.ok(loaded.has(old[i]), `the head trader reads: ${old[i]}`);
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
