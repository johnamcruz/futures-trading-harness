'use strict';

// The replay skill was split by job: replay keeps what a replay is, setting one up and running it, its report and
// combine verdict, the prop policy and what a replay can't seal off; replay-resume takes resuming and why a run stops,
// replay-labels the labels, replay-scorecard the adherence scorecard and its looks, live-session-records the live
// runner's session records. This test proves nothing was lost, doubled, edited, reordered or moved to another home:
// every sentence (and every table cell and code line) of the skill as it was is in the new homes exactly as many times
// as before, byte-for-byte after whitespace is normalised, in its old order within each home, and each home holds
// exactly the old units of its own ranges. The only exceptions are listed, each with its reason; an exception that no
// longer differs fails too, so the list can only shrink.
//
// The fixture (tests/fixtures/skill-split/replay.before.txt) is the old skill with a marker for each line the platform
// scan pins (a shipped account's or the firm's name, the firm's time): those lines may live only in
// skills/replay/SKILL.md (tests/plugin/no-platform-specifics.test.js), so they stay there, verbatim, and the old skill is
// rebuilt from them and pinned whole by its sha256. When plan C rewords one of them away, this split is long proven:
// drop the rebuild's sha check with that change.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { units, differences } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');
const { MARKER, pinnedLine, rebuild, sha256, homeErrors } = require('./skill-split-homes');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// skills/replay/SKILL.md as main had it before the split (at e7433091): the fixture file, and the skill it rebuilds.
const BEFORE = 'tests/fixtures/skill-split/replay.before.txt';
const FIXTURE_SHA256 = '0df6a47878bfbbe621aebc7a96c1d13dd739865048a6afe0e29691becee55f1d';
const BEFORE_SHA256 = '6c47a7115f375c5d6281472d413c418566228392391eca76048ed3f45fb3773d';
const HOMES = ['replay', 'replay-resume', 'replay-labels', 'replay-scorecard', 'live-session-records'];
// Each home's old units, by index into the old skill's units (inclusive ranges).
const RANGES = {
  replay: [[0, 31], [34, 41], [51, 56], [89, 100], [102, 102], [106, 111]], // intro, set-up, run, store, report, prop policy, limits
  'replay-resume': [[32, 33], [42, 50], [101, 101]], // Resume, Stops, the resume example
  'replay-labels': [[57, 65], [103, 103]], // Labels, its example
  'replay-scorecard': [[66, 82], [104, 104]], // Scorecard, its example
  'live-session-records': [[83, 88], [105, 105]], // Live sessions, its example
};

// Deliberate differences, each with its reason.
const ALLOWED = [
  // Pointers to a step that is now another skill.
  { old: 'Turning a run into labels: each decision, the gate\'s answer, the outcome and the counterfactuals (step 10).',
    now: 'Turning a run into labels: each decision, the gate\'s answer, the outcome and the counterfactuals (the `replay-labels` skill).',
    reason: 'step 10 is the replay-labels skill' },
  { old: 'Scoring how closely the trader followed its rules: the adherence scorecard (step 11), for a replay run or a live session (step 12), and its flagged decisions, the failures the code found, for review.',
    now: 'Scoring how closely the trader followed its rules: the adherence scorecard (the `replay-scorecard` skill), for a replay run or a live session (the `live-session-records` skill), and its flagged decisions, the failures the code found, for review.',
    reason: 'steps 11 and 12 are the replay-scorecard and live-session-records skills' },
  // A truth fix in kept text: the report's table as scripts/lib/replay/report.js prints it (toText: HEAD ends with a
  // replay-clock column, and a total row follows the months).
  { old: 'month times cycles failed stand-aside trades win rate mean R (n) expectancy net MAE R MFE R refusals by check',
    now: 'month times cycles failed stand-aside trades win rate mean R (n) expectancy net MAE R MFE R refusals by check replay-clock',
    reason: 'the report table has a replay-clock column' },
  { old: '2024-03 2520 2541 0 91.3% 38 44.7% 0.21 (38) $9.42 $357.96 -0.48 1.12 plan-required 6, mtf-trend 3',
    now: '2024-03 2520 2541 0 91.3% 38 44.7% 0.21 (38) $9.42 $357.96 -0.48 1.12 plan-required 6, mtf-trend 3 0',
    reason: 'the month row carries its replay-clock count' },
  // A truth fix: with the run's latency on (replay/latency.js) the replay clock runs during a step (the owner's sentence).
  { old: '**The loop**, one process per decision time (the replay clock is frozen per process): the broker\'s clock moves to the time (fills in between happen in the broker), then `autotrader.js --once` runs one pass of the live loop there with `FTH_REPLAY_NOW`.',
    now: '**The loop**, one process per decision time (the replay clock is frozen per process, or, with the run\'s `latency` on, the default for a learning run, runs with the wall clock from each decision time, so the cycle\'s own time is charged as live): the broker\'s clock moves to the time (fills in between happen in the broker), then `autotrader.js --once` runs one pass of the live loop there with `FTH_REPLAY_NOW`.',
    reason: 'a latency-charged replay runs its clock during a step' },
];

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));
const before = () => rebuild(read(BEFORE), read('skills/replay/SKILL.md'));

test('replay split: the fixture is the old skill, its pinned lines kept verbatim in the replay skill', () => {
  assert.strictEqual(sha256(fs.readFileSync(path.join(ROOT, BEFORE))), FIXTURE_SHA256, 'the fixture is unchanged');
  assert.strictEqual(read(BEFORE).split('\n').filter(l => l === MARKER).length, 9, 'nine pinned lines');
  assert.strictEqual(sha256(before()), BEFORE_SHA256, 'the rebuilt skill is the old one, byte for byte');
  // A pinned line edited, dropped or moved out of the replay skill breaks the rebuild.
  const r = read('skills/replay/SKILL.md');
  const pinned = `${r.split('\n').filter(pinnedLine)[4]}\n`; // the prop policy's log line
  assert.ok(r.includes(pinned));
  assert.notStrictEqual(sha256(rebuild(read(BEFORE), r.replace(pinned, pinned.replace(' until', ' once')))), BEFORE_SHA256);
  assert.throws(() => rebuild(read(BEFORE), r.replace(pinned, '')), /9 markers, 8 pinned lines/);
});

test('replay split: every unit of the old skill is in exactly one new home, its own, in its old order', () => {
  const old = before();
  assert.deepStrictEqual(differences(old, homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(orderErrors(old, homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  assert.deepStrictEqual(homeErrors(old, homeTexts(), HOMES, RANGES, ALLOWED), [], 'each home holds its own ranges');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('replay split: the comparison catches a lost, a doubled, an edited, a reordered or a moved sentence', () => {
  const old = before();
  const u = units(old);
  assert.ok(u.length > 100, `the units are fine-grained (${u.length})`);
  assert.ok(u.includes('A changed config, harness or model needs a new `runId`.'), 'a sentence is a unit');
  assert.ok(u.includes('node scripts/replay.js run --config replay.json # resumes after the last decision time done'), 'a code line is a unit');
  const homes = homeTexts();
  const at = name => HOMES.indexOf(name);
  const swap = (name, text) => homes.map((h, i) => (i === at(name) ? text : h));
  const S = 'A changed config, harness or model needs a new `runId`.';
  const res = homes[at('replay-resume')];
  assert.ok(res.includes(S));
  // Lost, doubled, edited.
  assert.notDeepStrictEqual(differences(old, swap('replay-resume', res.replace(S, '')), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('replay-labels', `${homes[at('replay-labels')]}\n${S}\n`), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('replay-resume', res.replace('needs a new `runId`', 'needs a fresh `runId`')), ALLOWED), []);
  // Reordered: two sentences of one paragraph swapped (nothing lost, the order changed).
  const A = 'Everything is decided by code from the record, never by a model.';
  const sc = homes[at('replay-scorecard')];
  const pair = /(Every failure carries a severity[^]*?with rates\.)\s+(Everything is decided by code from the record, never by a model\.)/;
  assert.match(sc, pair);
  const swapped = sc.replace(pair, `${A} $1`);
  assert.deepStrictEqual(differences(old, swap('replay-scorecard', swapped), ALLOWED), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap('replay-scorecard', swapped), HOMES, ALLOWED), [], 'but changes the order');
  // Moved: a sentence taken from its home to another, in a place that keeps the order (nothing lost or doubled).
  const moved = homes.map((h, i) => (i === at('replay-resume') ? h.replace(S, '')
    : i === at('replay') ? h.replace('6. **Resume and stops.**', `6. ${S} **Resume and stops.**`) : h));
  assert.deepStrictEqual(differences(old, moved, ALLOWED), [], 'a move loses nothing');
  assert.notDeepStrictEqual(homeErrors(old, moved, HOMES, RANGES, ALLOWED), [], 'but puts it in another home');
  // Ranges that overlap or leave a unit out fail too.
  assert.notDeepStrictEqual(homeErrors(old, homes, HOMES, { ...RANGES, 'replay-resume': [[31, 33], [42, 50], [101, 101]] }, ALLOWED), []);
  assert.notDeepStrictEqual(homeErrors(old, homes, HOMES, { ...RANGES, 'replay-resume': [[33, 33], [42, 50], [101, 101]] }, ALLOWED), []);
  // A changed pointer reverted to its old text (the exception no longer needed) fails: the list only shrinks.
  const rp = homes[at('replay')];
  assert.notDeepStrictEqual(differences(old, swap('replay', rp.replace('counterfactuals (the `replay-labels` skill).', 'counterfactuals (step 10).')), ALLOWED), []);
  // A section heading dropped.
  assert.notDeepStrictEqual(differences(old, swap('replay-labels', homes[at('replay-labels')].replace('## Examples', '## Example')), ALLOWED), []);
});

test('replay split: each skill has a short "Use when" index line, and replay points to the rest', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
    assert.match(d, /^Use when /, s);
  }
  const rp = read('skills/replay/SKILL.md').replace(/\s+/g, ' ');
  for (const s of HOMES.slice(1)) assert.match(rp, new RegExp(`the \`${s}\` skill`), `replay points to ${s}`);
  assert.doesNotMatch(rp, /\*\*(Stops|Labels|Scorecard|Live sessions)\.\*\*|scorecard-summary\.json|labels-summary\.json|fillsPending/);
  // No trading role loads them: they are the user's to run.
  const { parseFrontmatter: pf } = require('../../scripts/lib/frontmatter');
  for (const f of fs.readdirSync(path.join(ROOT, 'agents')).filter(x => x.endsWith('.md'))) {
    const rs = pf(read(`agents/${f}`)).data['role-skills'] || [];
    for (const s of HOMES) assert.ok(!rs.includes(s), `${f} loads ${s}`);
  }
});

test('replay and training-loop splits: the skill index every cycle reads (workspace/AGENTS.md) does not grow', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  const line = (name, text) => `- \`${name}\` (skills/${name}/SKILL.md): ${parseFrontmatter(text).data.description}\n`.length;
  const was = line('replay', before()) + line('training-loop', read('tests/fixtures/skill-split/training-loop.before.txt'));
  const now = [...HOMES, 'training-loop', 'training-verdict'].reduce((n, s) => n + line(s, read(`skills/${s}/SKILL.md`)), 0);
  assert.ok(now <= was, `the index lines are ${now} characters, over the old ${was}`);
  const agents = read('workspace/AGENTS.md');
  for (const s of [...HOMES, 'training-loop', 'training-verdict']) assert.ok(agents.includes(`- \`${s}\` (skills/${s}/SKILL.md): Use when `), s);
});

test('replay: the example report table is the one scripts/lib/replay/report.js prints', () => {
  const R = require('../../scripts/lib/replay/report');
  const row = key => ({ key, points: 2520, cycles: 2541, failed: 0, standAsideRate: 0.913, trades: 38, winRate: 0.447, meanR: 0.21, tradesWithR: 38,
    expectancy: 9.42, net: 357.96, meanMaeR: -0.48, meanMfeR: 1.12, refusals: { 'plan-required': 6, 'mtf-trend': 3 }, replayClockRefusals: 0 });
  assert.ok(read('skills/replay/SKILL.md').includes(R.toText({ months: [row('2024-03')], total: row('total') })));
});
