'use strict';

// The training-loop skill was split by job: training-loop keeps running the loop (the config, plan, run, what a kept
// edit leaves, held-out judging, status, the tiers and the safety rules); training-verdict takes how each edit is
// judged (the paired verdict, the evaluator, the scorecard the loop plugs in). This test proves nothing was lost,
// doubled, edited, reordered or moved to another home: every sentence (and every code line) of the skill as it was
// (tests/fixtures/skill-split/training-loop.before.txt, frozen) is in the new homes exactly as many times as before,
// byte-for-byte after whitespace is normalised, in its old order within each home, and each home holds exactly the old
// units of its own ranges. Both pieces are the loop's own skills: no proposal may edit either (scripts/lib/train/proposal.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { units, differences } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');
const { sha256, homeErrors } = require('./skill-split-homes');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// skills/training-loop/SKILL.md as main had it before the split (at e7433091): pinned, so a sentence can't be dropped
// from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/training-loop.before.txt';
const BEFORE_SHA256 = '473fa649fb676fecd797c8b6901aba2a89c88ba334037feb8a8a7a83e840edf8';
const HOMES = ['training-loop', 'training-verdict'];
// Each home's old units, by index into the old skill's units (inclusive ranges).
const RANGES = {
  'training-loop': [[0, 15], [20, 34], [43, 49]], // intro, config, plan, run, kept, held-out, status, tiers, safety, examples
  'training-verdict': [[16, 19], [35, 42]], // the verdict, the evaluator, the scorecard
};
const ALLOWED = [
  { old: "**The evaluator** (section 10 step 9) verifies every change mechanically when the config names one (`\"evaluator\": { \"prop\", \"data\": { \"MNQ\": \"<bar file>\" }, ... }`, any `scripts/evaluate.js` setting): the champion and the candidate on the same bar files and seed; a blow, a gate failure the champion lacks, or a pass-rate lower bound that doesn't rise above the champion's rejects (a tie, the 0 of a short window included, shows nothing).",
    copies: 0, reason: "the evaluator passage was rewritten (owner-approved, PR #196): scripts/evaluate.js is deleted; a change is judged by pairRuns" },
  { old: "Only a change that edits nothing the evaluator reads may tie, with identical results.",
    copies: 0, reason: "the evaluator passage was rewritten (owner-approved, PR #196): scripts/evaluate.js is deleted; a change is judged by pairRuns" },
  { old: "Without one, a strategy or rulebook change stays `blocked`, and so does a change to a strategy its streams don't read, or to a rulebook (it reads none yet).",
    copies: 0, reason: "the evaluator passage was rewritten (owner-approved, PR #196): scripts/evaluate.js is deleted; a change is judged by pairRuns" },
  { old: "On held-out windows it scores the candidate alone against the promotion gate, inside the judging's one look; a window too short for the gate's attempts and months fails it, so judge a mechanical change on windows long enough.",
    copies: 0, reason: "the evaluator passage was rewritten (owner-approved, PR #196): scripts/evaluate.js is deleted; a change is judged by pairRuns" },
  { old: "Keep `scripts/evaluate.js --ledger` on the same ledger file and `HOME` the same: the one ledger is where the budget lives.",
    copies: 0, reason: "the evaluator passage was rewritten (owner-approved, PR #196): scripts/evaluate.js is deleted; a change is judged by pairRuns" },
  { old: "The user wants the agent's skills, strategies or rulebook improved from its own replays, or wants to resume, read or judge a loop.",
    copies: 0, reason: 'PPC phase 1 (owner-approved 2026-10-23): a model\'s proposal may edit the desk roles\' bodies and never a rulebook (scripts/lib/train/proposal.js)' },
  { old: "A change to a strategy or the rulebook is `blocked` until the evaluator (section 10 step 9) screens it; a strategy's name, status, account, sizing, contracts, exit, instruments, timeframe, list and regime gate are never a proposal's to change, and a rulebook may only be tightened, key by key (no limit raised or turned `off`, no fact value's effective size multiplier raised, including a value no entry lists, which is 0; no exit changed, no key removed).",
    copies: 0, reason: 'PPC phase 1 (owner-approved 2026-10-23): only a person\'s imported proposal may edit a rulebook, and only to tighten it' },
  { old: "Proposals may edit only skills, strategies (never a `name:` or `status:` line, nor a policy's account, sizing, contracts or exit) and rulebooks (`accounts/<account>/RULEBOOK.md`): never code, account profiles (`ACCOUNT.md`), agents, rules, or the loop's own skills.",
    copies: 0, reason: 'PPC phase 1 (owner-approved 2026-10-23): a model\'s proposal may edit the desk roles\' bodies (agent-edit.js guards) and never a rulebook' },
];

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));

test('training-loop split: every unit of the old skill is in exactly one new home, its own, in its old order', () => {
  assert.strictEqual(sha256(fs.readFileSync(path.join(ROOT, BEFORE))), BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  const old = read(BEFORE);
  assert.deepStrictEqual(differences(old, homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(orderErrors(old, homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  assert.deepStrictEqual(homeErrors(old, homeTexts(), HOMES, RANGES, ALLOWED), [], 'each home holds its own ranges');
});

test('training-loop split: the comparison catches a lost, a doubled, an edited, a reordered or a moved sentence', () => {
  const old = read(BEFORE);
  const u = units(old);
  assert.ok(u.length > 40, `the units are fine-grained (${u.length})`);
  const S = 'A decision\'s repeats count once (the category most of them gave).';
  assert.ok(u.includes(S), 'a sentence is a unit');
  assert.ok(u.includes('node scripts/train-loop.js run --config ~/fth-train/nq-skills-1.json'), 'a code line is a unit');
  const homes = homeTexts();
  const at = name => HOMES.indexOf(name);
  const swap = (name, text) => homes.map((h, i) => (i === at(name) ? text : h));
  const loose = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  const v = homes[at('training-verdict')];
  assert.match(v, loose(S));
  // Lost, doubled, edited.
  assert.notDeepStrictEqual(differences(old, swap('training-verdict', v.replace(loose(S), '')), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('training-loop', `${homes[at('training-loop')]}\n${S}\n`), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('training-verdict', v.replace('more than 10% left out', 'more than 20% left out')), ALLOWED), []);
  // Reordered: the verdict and scorecard paragraphs swapped (nothing lost, the order changed).
  const EV = /1\. \*\*The verdict is code\*\*[^]*?no key removed\)\.\n/.exec(v)[0];
  const SC = /\*\*The scorecard\*\*[^]*?under a new `loopId`\.\n/.exec(v)[0];
  const swapped = v.replace(EV, '\u0000').replace(SC, EV).replace('\u0000', SC);
  assert.deepStrictEqual(differences(old, swap('training-verdict', swapped), ALLOWED), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap('training-verdict', swapped), HOMES, ALLOWED), [], 'but changes the order');
  // Moved: the verdict paragraph taken to training-loop's end, before its examples (nothing lost, order kept there).
  const moved = homes.map((h, i) => (i === at('training-verdict') ? h.replace(EV, '') : h.replace('## Examples', `${EV}\n## Examples`)));
  assert.deepStrictEqual(differences(old, moved, ALLOWED), [], 'a move loses nothing');
  assert.notDeepStrictEqual(homeErrors(old, moved, HOMES, RANGES, ALLOWED), [], 'but puts it in another home');
  // A section heading dropped.
  assert.notDeepStrictEqual(differences(old, swap('training-verdict', v.replace('## Examples', '## Example')), ALLOWED), []);
});

test('training-loop split: short "Use when" index lines; training-loop points to the verdict; both are the loop\'s own', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
    assert.match(d, /^Use when /, s);
  }
  const tl = read('skills/training-loop/SKILL.md').replace(/\s+/g, ' ');
  assert.match(tl, /the `training-verdict` skill/);
  assert.doesNotMatch(tl, /\*\*The verdict is code\*\*|\*\*The evaluator\*\*|ledger-before\.jsonl/);
  const { LOOP_SKILLS, kindOf } = require('../../scripts/lib/train/proposal');
  for (const s of HOMES) {
    assert.ok(LOOP_SKILLS.includes(s), s);
    assert.strictEqual(kindOf(`skills/${s}/SKILL.md`), null, `a proposal may not edit ${s}`);
  }
});
