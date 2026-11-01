'use strict';

// Propose-Probe-Compose (docs/TRAINING.md): the probe edit's checks, the findings, the screen, compose, the lessons
// record, the probe prompt, the `probe` config, and a loop iteration end to end with its slow steps stubbed (the
// replay driver's run, the trees, the scorecard, each probe run's data, the proposer and the keep rule's verifier).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const { resolveLoop } = require('../../scripts/lib/train/config');
const L = require('../../scripts/lib/train/loop');
const S = require('../../scripts/lib/train/state');
const store = require('../../scripts/lib/replay/store');
const { readArchive } = require('../../scripts/lib/train/archive');
const PE = require('../../scripts/lib/train/probe-edit');
const F = require('../../scripts/lib/train/findings');
const SC = require('../../scripts/lib/train/screen');
const C = require('../../scripts/lib/train/compose');
const LS = require('../../scripts/lib/train/lessons');
const PR = require('../../scripts/lib/train/probe');
const IR = require('../../scripts/lib/train/iteration-report');
const TS = require('../../scripts/lib/train/trend-set');
const PC = require('../../scripts/lib/train/probe-config');
const proposer = require('../../scripts/lib/train/proposer');
const { DECISION_RULE } = require('../../scripts/lib/train/paired');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILL = 'skills/a/SKILL.md';
const TEXT = '---\nname: a\ndescription: a test skill\n---\n\n# A\n\n- line one\n\n- line two\n\n- line three\n';
// Ten session dates, four decisions each: the overfit guard splits them by date into a probe and a confirm half.
const DAYS = ['2022-03-07', '2022-03-08', '2022-03-09', '2022-03-10', '2022-03-11', '2022-03-14', '2022-03-15', '2022-03-16', '2022-03-17', '2022-03-18'];
const TIMES = Array.from({ length: 40 }, (_, i) => new Date(Date.parse(`${DAYS[Math.floor(i / 4)]}T14:33:02.000Z`) + (i % 4) * 180000).toISOString());
/** Time i of an unbounded series: TIMES, then the same times 100 days later each, and so on. */
const timeAt = i => (i < TIMES.length ? TIMES[i] : new Date(Date.parse(TIMES[i % TIMES.length]) + Math.floor(i / TIMES.length) * 100 * 86400000).toISOString());
const dayOfT = t => t.slice(0, 10);
// The trend set's days in the stub world, and its one regression day (never in the set).
const REG_DAY = '2022-03-17';
const SET_DAYS = DAYS.filter(d => d !== REG_DAY);
// The trend pool: two legs a session, both from 14:30Z to 14:51Z (the census's ids: day|side|start), and the legs a
// round draws. Their windows (trend-windows.js: four bars before the start through the first half) merge into one,
// 14:18Z to 14:42Z, which holds the session's four decision times; each leg's control window lies elsewhere.
const legId = (d, side) => `${d}|${side}|${d}T14:30:00.000Z`;
const POOL = SET_DAYS.flatMap(d => [legId(d, 'long'), legId(d, 'short')]);
// A trend run's id: <side>-t<yyyymmdd>.<its windows' hash>.0 (probe.js); its day.
const TREND_RUN = /-t\d{8}\.[0-9a-f]{8}\.\d+$/;
const dayOfRun = id => /-t(\d{4})(\d{2})(\d{2})\./.exec(id).slice(1).join('-');
const SPANS =Object.fromEntries(DAYS.flatMap(d => ['long', 'short'].map(side => [legId(d, side), { day: d, side, start: `${d}T14:30:00.000Z`, end: `${d}T14:51:00.000Z`, points: 10 }])));
const BATCH = 13; // odd: a batch ends inside a session, whose other leg is not the round's
// Round 1's halves (trend-set.js), the loop's seed 3.
const ROUND1 = require('../../scripts/lib/train/trend-set').splitBatch(require('../../scripts/lib/train/trend-set').drawRound(POOL, { seed: 3, round: 1, per: BATCH }).items, { seed: 3, half: 0.5 });
const WINDOW = [{ from: '2022-03-07', to: '2022-03-19' }];
// The keep rule's tuning windows: disjoint from the probe windows (probe-config.js: an edit is never judged where it was chosen).
const TUNING = [{ from: '2022-06-06', to: '2022-06-18' }];

// --- the screen's sides, built from scripted decisions -------------------------------------------------------------

/** n decisions; state(i) -> 'right' | 'misread' | 'missed' for skill a; category(i); R(i). */
function side({ n = 20, state = () => 'right', category = () => 'right', R = () => 0, blow = () => false, other = () => true, relevant = () => false } = {}) {
  const decisions = [];
  const scorecard = [];
  // The skill-usage report's per-point relevance: skill a had a TRUE read pointing the side's way at the bar.
  const points = Array.from({ length: n }, (_, i) => ({ root: 'MNQ', bar: timeAt(i), relevant: relevant(i) ? ['a'] : [] }));
  for (let i = 0; i < n; i += 1) {
    const s = state(i);
    const reads = [{ step: 'zone', skill: 'b', read: 'x', check: other(i), agrees: true }];
    if (s !== 'missed') reads.push({ step: 'zone', skill: 'a', read: 'y', check: s === 'right', agrees: true });
    decisions.push({ root: 'MNQ', bar: timeAt(i), decision: R(i) === 0 ? 'passed' : 'entered', reads, outcome: { R: R(i) } });
    scorecard.push({ key: `${timeAt(i)}|MNQ`, category: category(i), blow: blow(i) });
  }
  return SC.sideOf({ decisions, scorecard, usage: [{ skill: 'a', used: 1, available: 2, reads: 3, correct: 1, missed: 1, relevant: 2 }], points });
}
const champ = side({ state: i => (i % 2 ? 'right' : 'misread'), category: i => (i % 2 ? 'right' : 'wrong stated reason') });

test('the screen: a scripted helpful edit passes; harmful and neutral ones do not; thresholds in one place, looser than the keep rule on a gain', () => {
  const target = { skill: 'a', kind: 'misread' };
  // Helpful: every misread of skill a now right, nothing else moves.
  const helped = SC.measure(champ, side({ state: () => 'right', category: i => (i % 2 ? 'right' : 'wrong stated reason') }), target);
  assert.deepStrictEqual([helped.target.b, helped.target.c, helped.target.pairs], [10, 0, 20]);
  assert.deepStrictEqual(SC.screen(helped), { verdict: 'helped', pass: true, harms: [], gain: true });
  // Neutral: the same decisions.
  assert.strictEqual(SC.screen(SC.measure(champ, champ, target)).verdict, 'no effect');
  // Harmful on the target: every right read of a now a misread.
  const worse = SC.screen(SC.measure(champ, side({ state: () => 'misread' }), target));
  assert.strictEqual(worse.verdict, 'hurt');
  assert.match(worse.harms.join(), /target: worse/);
  // A gain on the target never excuses a harm elsewhere: process adherence broken, the other skill's reads false, R down, a blow.
  const process = SC.screen(SC.measure(champ, side({ state: () => 'right', category: () => 'wrong-side entry' }), target));
  assert.deepStrictEqual([process.verdict, process.pass], ['hurt', false]);
  assert.match(process.harms.join(), /process: worse/);
  const reads = SC.screen(SC.measure(champ, side({ state: () => 'right', category: i => (i % 2 ? 'right' : 'wrong stated reason'), other: () => false }), target));
  assert.match(reads.harms.join(), /reads: worse/);
  const r = SC.screen(SC.measure(side({ R: () => 1 }), side({ state: () => 'right', R: i => (i % 3 ? -1 : -0.5) }), target));
  assert.match(r.harms.join(), /R per decision: worse/);
  const blow = SC.screen(SC.measure(champ, side({ state: () => 'right', category: i => (i % 2 ? 'right' : 'wrong stated reason'), blow: i => i === 3 }), target));
  assert.match(blow.harms.join(), /1 blow\(s\)/);
  // Dropping the skill is no fix: a misread turned into "no read of a claimed" stays a failure.
  assert.strictEqual(SC.screen(SC.measure(champ, side({ state: i => (i % 2 ? 'right' : 'missed') }), target)).verdict, 'no effect');
  // Not significant: 4 fixed against 2 broken (p 0.34) is no gain, however permissive the screen.
  const mixed = SC.measure(champ, side({ state: i => (i % 2 ? (i < 4 ? 'misread' : 'right') : i < 8 ? 'right' : 'misread') }), target);
  assert.deepStrictEqual([mixed.target.b, mixed.target.c, SC.screen(mixed).verdict], [4, 2, 'no effect']);
  // Noise: 2 fixed, 0 broken is under the screen's minimum.
  assert.strictEqual(SC.screen(SC.measure(champ, side({ state: i => (i % 2 || i < 4 ? 'right' : 'misread') }), target)).verdict, 'no effect');
  // A wrong-reason refusal's target: the champion's wrong stated reasons now right.
  const fixedReasons = SC.measure(champ, side({ state: i => (i % 2 ? 'right' : 'misread'), category: () => 'right' }), { skill: 'a', kind: 'wrong-reason refusal' });
  assert.deepStrictEqual([fixedReasons.target.b, fixedReasons.target.c, SC.screen(fixedReasons).verdict], [10, 0, 'helped']);
  // One place, permissive on a gain, never slower than the keep rule's decision rule to call a harm.
  assert.ok(Object.isFrozen(SC.SCREEN));
  assert.ok(SC.SCREEN.gainAlpha >= DECISION_RULE.alpha && SC.SCREEN.minDiscordant <= DECISION_RULE.minDiscordant);
  assert.ok(SC.SCREEN.harmAlpha >= DECISION_RULE.alpha);
});

test('the screen rewards reading better, never claiming more: "always cite read X" where it is not relevant fixes nothing', () => {
  // The champion never claimed skill a; the probe cites a (verified TRUE) at every bar.
  const silent = side({ state: () => 'missed' });
  const cites = side({ state: () => 'right' });
  for (const kind of ['misread', 'missed']) {
    const m = SC.measure(silent, cites, { skill: 'a', kind });
    assert.deepStrictEqual([m.target.pairs, m.target.b, SC.screen(m).verdict], [0, 0, 'no effect'], `${kind}: no bar where it was relevant, none the champion claimed`);
  }
  // A misread pairs only the decisions the champion claimed the skill at: a new claim elsewhere is not a fix.
  const half = side({ state: i => (i < 10 ? 'misread' : 'missed') });
  const misread = SC.measure(half, cites, { skill: 'a', kind: 'misread' });
  assert.deepStrictEqual([misread.target.pairs, misread.target.b, misread.target.c], [10, 10, 0]);
  // A miss counts only where the skill was relevant at the bar (a TRUE read of it pointing the side's way).
  const relevantSome = side({ state: () => 'missed', relevant: i => i < 6 });
  const missed = SC.measure(relevantSome, cites, { skill: 'a', kind: 'missed' });
  assert.deepStrictEqual([missed.target.pairs, missed.target.b, SC.screen(missed).verdict], [6, 6, 'helped']);
  // A fix counts only when the decision's scorecard pair got no worse: the read claimed, the decision now wrong.
  const worse = SC.measure(relevantSome, side({ state: () => 'right', category: i => (i < 6 ? 'wrong-side entry' : 'right') }), { skill: 'a', kind: 'missed' });
  assert.deepStrictEqual([worse.target.pairs, worse.target.b, SC.screen(worse).verdict], [6, 0, 'hurt']);
  const worseRead = SC.measure(half, side({ state: () => 'right', category: i => (i < 4 ? 'wrong-side entry' : 'right') }), { skill: 'a', kind: 'misread' });
  assert.deepStrictEqual([worseRead.target.b, worseRead.target.c], [6, 0], 'the four decisions made worse are no fix');
});

test('the screen pairs only runs under one exit plan (the run\'s manifest records it): another plan is refused', () => {
  const planned = (plan, n = 20) => SC.sideOf({ decisions: TIMES.slice(0, n).map(t => ({ root: 'MNQ', bar: t, decision: 'passed', exitPlan: plan, reads: [], outcome: { R: 0 } })), scorecard: [] });
  assert.deepStrictEqual(planned('h1').exitPlans, ['h1']);
  assert.doesNotThrow(() => SC.measure(planned('h1'), planned('h1'), { skill: 'a', kind: 'misread' }));
  assert.throws(() => SC.measure(planned('h1'), planned('h2'), { skill: 'a', kind: 'misread' }), /exit plan .* is not the champion's/);
});

test('the screen needs a practical size and significance: each case of fixed/broken on n paired decisions', () => {
  assert.deepStrictEqual([SC.SCREEN.minEffect, SC.SCREEN.gainAlpha, SC.SCREEN.minDiscordant, SC.SCREEN.harmAlpha, SC.SCREEN.minPairs], [0.1, 0.1, 4, 0.2, 10]);
  // The champion misreads the first b decisions; the challenger newly misreads the last c.
  const cases = [[20, 3, 0, 'no effect'], [30, 4, 0, 'helped'], [80, 8, 0, 'helped'], [40, 5, 1, 'no effect'], [30, 3, 0, 'no effect']];
  for (const [n, b, c, verdict] of cases) {
    const m = SC.measure(side({ n, state: i => (i < b ? 'misread' : 'right') }), side({ n, state: i => (i >= n - c ? 'misread' : 'right') }), { skill: 'a', kind: 'misread' });
    assert.deepStrictEqual([m.target.pairs, m.target.b, m.target.c, SC.screen(m).verdict], [n, b, c, verdict], `${b}/${c} on ${n}`);
  }
});

test('the overfit guard: the moments split by session date, by a seeded hash, into a probe half and a confirm half', () => {
  const all = side({ n: 40 });
  const [probe, confirm] = SC.HALVES.map(h => SC.half(all, h, 3));
  assert.strictEqual(probe.decisions.length + confirm.decisions.length, 40);
  assert.strictEqual(probe.scorecard.length + confirm.scorecard.length, 40);
  const days = h => new Set(h.decisions.map(d => d.day));
  assert.ok(days(probe).size > 0 && days(confirm).size > 0);
  assert.ok(![...days(probe)].some(d => days(confirm).has(d)), 'no session date in both halves');
  // A decision and its scorecard line fall in the same half (both by their bar's session date).
  assert.deepStrictEqual(probe.decisions.map(d => d.key), probe.scorecard.map(d => d.at));
  // Deterministic for a seed; another seed splits otherwise.
  assert.deepStrictEqual(DAYS.map(d => SC.halfOf(d, 3)), DAYS.map(d => SC.halfOf(d, 3)));
  assert.notDeepStrictEqual(DAYS.map(d => SC.halfOf(d, 3)), DAYS.map(d => SC.halfOf(d, 1)));
  assert.throws(() => SC.half(all, 'test', 3), /half: one of probe, confirm/);
});

test('the combined change: its parts must not cancel; a harm or a lost target fails it', () => {
  const part = (id, kind = 'misread') => ({ id, tag: { skill: 'a', kind: 'rewording' }, finding: { id: 'F1', kind } });
  const good = side({ state: () => 'right', category: () => 'right' });
  assert.strictEqual(SC.composedScreen(champ, good, [part('x'), part('y', 'wrong-reason refusal')]).verdict, 'helped');
  // Together the reads gain, but the refusals the second part fixed alone are back: cancelled.
  const cancel = SC.composedScreen(champ, side({ state: () => 'right', category: i => (i % 2 ? 'right' : 'wrong stated reason') }), [part('x'), part('y', 'wrong-reason refusal')]);
  assert.deepStrictEqual([cancel.verdict, cancel.pass, cancel.cancelled], ['no effect', false, ['y']]);
  assert.strictEqual(SC.composedScreen(champ, side({ state: () => 'misread' }), [part('x')]).verdict, 'hurt');
});

// --- probe edits ---------------------------------------------------------------------------------------------------

function tree(text = TEXT) {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'skills', 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, SKILL), text);
  return dir;
}
const edit = (find, replace, over = {}) => ({ targets: ['wrong stated reason'], expects: 'fewer misreads', edits: [{ file: SKILL, find, replace }], ...over });
const FINDINGS = [{ id: 'F1', skill: 'a', kind: 'misread' }, { id: 'F2', skill: null, kind: 'wrong-reason refusal' }];

test('a probe edit: its tag (skill, finding, kind), one skill, and the owner\'s style in code (no numbers, short lines, a removal removes, the byte cap)', () => {
  const root = tree();
  const ok = edit('- line one', '- line one\n- the gap is filled → no gap read');
  assert.deepStrictEqual(PE.tagErrors({ skill: 'a', finding: 'F1', kind: 'rule' }, ok, { findings: FINDINGS }), []);
  assert.deepStrictEqual(PE.styleErrors(ok, { root, kind: 'rule' }), []);
  assert.deepStrictEqual(PE.splitTagged({ tag: { skill: 'a' }, targets: ['x'] }), { tag: { skill: 'a' }, proposal: { targets: ['x'] } });
  assert.match(PE.tagErrors(null, ok, { findings: FINDINGS }).join(), /tag: \{ skill or agent, finding, kind \}/);
  assert.match(PE.tagErrors({ skill: 'a', finding: 'F9', kind: 'rule' }, ok, { findings: FINDINGS }).join(), /tag.finding/);
  assert.match(PE.tagErrors({ skill: 'a', finding: 'F1', kind: 'rewrite' }, ok, { findings: FINDINGS }).join(), /tag.kind/);
  assert.match(PE.tagErrors({ skill: 'b', finding: 'F1', kind: 'rule' }, ok, { findings: FINDINGS }).join(), /finding F1 is about a, not b/);
  // An unattributed finding: any skill, still one skill's file.
  assert.match(PE.tagErrors({ skill: 'b', finding: 'F2', kind: 'rule' }, ok, { findings: FINDINGS }).join(), /one document only, skills\/b\/SKILL\.md/);
  assert.match(PE.styleErrors(edit('- line one', '- wait 3 bars'), { root }).join(), /no numbers: the edit adds 3/);
  assert.deepStrictEqual(PE.styleErrors(edit('- line 2 of 2', '- line 2 of 2, reworded'), { root: tree(TEXT.replace('line two', 'line 2 of 2')) }), [], 'a number the text held is kept');
  assert.match(PE.styleErrors(edit('- line one', `- ${'x'.repeat(PE.MAX_LINE)}`), { root }).join(), /short condition -> action lines/);
  assert.strictEqual(PE.MAX_LINE, 120);
  assert.deepStrictEqual(PE.styleErrors(edit('- line one', `- ${'x'.repeat(PE.MAX_LINE - 2)}`), { root }), []);
  // Numbers in words are numbers: "two", "half", "three bars"; one the found text held is kept.
  for (const added of ['- wait three bars → enter', '- half the range → skip', '- Two closes → confirmed', '- twice the stop → no trade']) {
    assert.match(PE.styleErrors(edit('- line one', added), { root }).join(), /no numbers: the edit adds/, added);
  }
  assert.deepStrictEqual(PE.styleErrors(edit('- line one', '- the one that holds → enter; someone, often → none'), { root }), [], 'words that hold a number word inside them, and "one", are not numbers');
  assert.deepStrictEqual(PE.styleErrors(edit('- line two', '- line two, reworded'), { root: tree(TEXT.replace('line two', 'line two of three')) }).filter(x => /numbers/.test(x)), []);
  assert.deepStrictEqual([...PE.numbers('Wait Three bars, half of 2.5')].sort(), ['2.5', 'half', 'three']);
  // The frontmatter (name, description: what loads the skill) is never edited, whatever the cap.
  assert.match(PE.styleErrors(edit('description: a test skill', 'description: always read a first'), { root }).join(), /the frontmatter is not edited: the find reaches into it/);
  assert.match(PE.styleErrors(edit('---\n\n# A', '---\n\n# A!'), { root }).join(), /the frontmatter is not edited/, 'a find spanning its closing line');
  assert.match(PE.styleErrors(edit('name: a\n', 'name: a\nextra: x\n'), { root }).join(), /the frontmatter is not edited/);
  assert.deepStrictEqual(PE.styleErrors(edit('# A', '# A, reworded'), { root }), [], 'the body right after it is editable');
  assert.match(PE.styleErrors(edit('- line one', '- line one, longer'), { root, kind: 'removal' }).join(), /a removal shrinks/);
  assert.match(PE.styleErrors(edit('- line one', `- line one\n${'- grow → more\n'.repeat(300)}`), { root }).join(), new RegExp(`over its cap \\(3459 \\+ ${PE.GROW_BYTES}\\)`));
  // Already over the cap: may grow at most GROW_BYTES past its size (room for the rule a misread needs), may shrink.
  const big = tree(`${TEXT}${'- filler line\n'.repeat(300)}`);
  assert.deepStrictEqual(PE.styleErrors(edit('- line one', '- line one, grown'), { root: big }), [], 'a few bytes past its size');
  assert.match(PE.styleErrors(edit('- line one', `- line one\n${'- grow → more\n'.repeat(Math.ceil(PE.GROW_BYTES / 14) + 1)}`), { root: big }).join(), new RegExp(`already over 3459: it may grow at most ${PE.GROW_BYTES} past`));
  // The boundary: as many style-valid lines as fit within GROW_BYTES pass; one line more is refused.
  const unit = '- grow → more\n';
  const fit = Math.floor(PE.GROW_BYTES / Buffer.byteLength(unit));
  const pad = n => edit('- line one', `- line one\n${unit.repeat(n)}`.replace(/\n$/, ''));
  assert.deepStrictEqual(PE.styleErrors(pad(fit), { root: big }), []);
  assert.match(PE.styleErrors(pad(fit + 1), { root: big }).join(), /it may grow at most/);
  assert.deepStrictEqual(PE.styleErrors(edit('- line one\n', ''), { root: big, kind: 'removal' }), []);
  // The cap is the skill's own, from the one source the basics-skills test reads (a setup has more room).
  const setup = tmpDir();
  fs.mkdirSync(path.join(setup, 'skills', 'rejection'), { recursive: true });
  fs.writeFileSync(path.join(setup, 'skills', 'rejection', 'SKILL.md'), TEXT);
  const grow = n => ({ ...edit('- line one', `- line one\n${'- grow → more\n'.repeat(n)}`), edits: [{ file: 'skills/rejection/SKILL.md', find: '- line one', replace: `- line one\n${'- grow → more\n'.repeat(n)}` }] });
  assert.deepStrictEqual(PE.styleErrors(grow(220), { root: setup }), [], 'over 3459, within 4000');
  assert.match(PE.styleErrors(grow(300), { root: setup }).join(), new RegExp(`over its cap \\(4000 \\+ ${PE.GROW_BYTES}\\)`));
  // candle-reading's own cap (skill-caps.js PER_SKILL, feat/sweep-candle-control, owner-approved): the probe edit reads it.
  const own = tmpDir();
  fs.mkdirSync(path.join(own, 'skills', 'candle-reading'), { recursive: true });
  fs.writeFileSync(path.join(own, 'skills', 'candle-reading', 'SKILL.md'), TEXT);
  const growCr = n => ({ ...edit('- line one', `- line one\n${'- grow → more\n'.repeat(n)}`), edits: [{ file: 'skills/candle-reading/SKILL.md', find: '- line one', replace: `- line one\n${'- grow → more\n'.repeat(n)}` }] });
  assert.deepStrictEqual(PE.styleErrors(growCr(280), { root: own }), [], 'over 3459 and 4000, within its own 7367');
  assert.match(PE.styleErrors(growCr(500), { root: own }).join(), new RegExp(`over its cap \\(7367 \\+ ${PE.GROW_BYTES}\\)`));
});

test('findings: the skills with the most misreads, misses and wrong-reason refusals first; refusals credited to the reads at their bar', () => {
  const skills = F.mergeUsage([
    { skills: [{ skill: 'a', reads: 10, wrong: 4, missed: 1, relevant: 3, topRefusals: [{ what: 'false: y', count: 4 }], topMissed: [] }, { skill: 'position-sizing', wrong: 9, reads: 9 }] },
    { skills: [{ skill: 'a', reads: 5, wrong: 2, missed: 0, relevant: 1, topRefusals: [{ what: 'false: y', count: 2 }], topMissed: [] }, { skill: 'c', reads: 4, wrong: 1, missed: 0 }] },
  ]);
  assert.deepStrictEqual(skills.find(s => s.skill === 'a').topRefusals, [{ what: 'false: y', count: 6 }]);
  const decisions = [
    { key: 'k1', symbol: 'MNQ', barT: TIMES[0], category: 'wrong stated reason', actual: { action: 'none' }, falseReasons: ['"no gap": a gap holds'] },
    { key: 'k2', symbol: 'MNQ', barT: TIMES[1], category: 'wrong stated reason', actual: { action: 'long' }, falseReasons: [] },
    { key: 'k3', symbol: 'MNQ', barT: TIMES[2], category: 'wrong stated reason', actual: { action: 'none' }, falseReasons: ['"late": not late'] },
  ];
  const records = [{ root: 'MNQ', bar: TIMES[0], reads: [{ step: 'zone', skill: 'c', read: 'not a crosswalk read' }] }];
  const refusals = F.refusalsOf(decisions, records);
  assert.deepStrictEqual(refusals.map(r => [r.key, r.skills]), [['k1', ['c']], ['k3', []]], 'an entry is no refusal; a bar with no read is unattributed');
  const found = F.findingsFrom({ skills, refusals, exists: s => s !== 'gone', max: 8 });
  assert.deepStrictEqual(found.map(f => [f.id, f.skill, f.kind, f.count]), [['F1', 'a', 'misread', 6], ['F2', 'a', 'missed', 1], ['F3', 'c', 'misread', 1], ['F4', 'c', 'wrong-reason refusal', 1], ['F5', null, 'wrong-reason refusal', 1]]);
  assert.ok(!found.some(f => f.skill === 'position-sizing'), 'a size skill has no read: never probed');
  assert.match(F.findingLine(found[0]), /^F1\. a: misread: 6 of 15 claimed reads refused\. Most often: false: y \(6\)/);
  assert.strictEqual(F.findingsFrom({ skills, refusals, max: 2 }).length, 2);
});

test('compose: every passing edit in one change; a conflict on the same lines keeps the larger paired gain; a cap leaves one out', () => {
  const root = tree();
  const part = (id, find, replace, b, c = 0) => ({ id, tag: { skill: 'a', kind: 'rule' }, finding: { id: 'F1', kind: 'misread' }, proposal: edit(find, replace, { expects: `e${id}` }), measures: { target: { b, c, pairs: 20 } } });
  const one = part('p1', '- line one', '- line one\n- x → y', 6);
  const oneBetter = part('p2', '- line one', '- line one, reworded', 10);
  const two = part('p3', '- line two', '- line two\n- z → w', 4);
  const c = C.compose([one, oneBetter, two], { root });
  assert.deepStrictEqual(c.parts.map(p => [p.id, p.gain]), [['p2', 0.5], ['p3', 0.2]]);
  assert.deepStrictEqual(c.conflicts.map(x => [x.kept, x.dropped, x.lines]), [['p2', 'p1', '8-8']]);
  assert.deepStrictEqual(c.proposal.edits.map(e => e.replace), ['- line one, reworded', '- line two\n- z → w']);
  assert.deepStrictEqual(c.proposal.targets, ['wrong stated reason']);
  assert.match(c.proposal.why, /composed by code from 2 edit\(s\)/);
  assert.match(C.compositionLines({ ...c, composed: { verdict: 'helped' } }).join('\n'), /p1 left out for p2: skills\/a\/SKILL\.md lines 8-8/);
  // Lines that touch: a find spanning two lines conflicts with an edit on either.
  const span = part('p4', '- line two\n\n- line three', '- lines two and three', 9);
  assert.deepStrictEqual(C.compose([span, part('p5', '- line three', '- line 3', 3)], { root }).conflicts.map(x => x.dropped), ['p5']);
  // The combined change stays one valid proposal: more than MAX_EDITS edits, the extra one (the smallest gain) left out.
  const four = ['one', 'two', 'three'].map((w, i) => part(`q${i}`, `- line ${w}`, `- line ${w}!`, 9 - i)).concat(part('q3', '# A', '# A!', 1));
  const capped = C.compose(four, { root });
  assert.deepStrictEqual([capped.parts.map(p => p.id), capped.dropped.map(x => x.id)], [['q0', 'q1', 'q2'], ['q3']]);
  assert.match(capped.dropped[0].why.join(), /edits: 1 to 3/);
  // Nothing passes: nothing composed.
  assert.strictEqual(C.compose([], { root }).proposal, null);
});

test('the lessons record: written by code, practice-train only, capped, and what the proposer reads', () => {
  const file = path.join(tmpDir(), LS.FILE);
  const lesson = (over = {}) => ({ proposalId: 'p1', iteration: 1, skill: 'a', kind: 'rewording', findingKind: 'misread', windows: WINDOW, verdict: 'helped', n: 12, ...over });
  LS.appendLesson(file, lesson());
  LS.appendLesson(file, lesson({ proposalId: 'p2', verdict: 'no effect', n: 9 }));
  LS.appendLesson(file, lesson({ proposalId: 'p3', skill: 'b', kind: 'example', verdict: 'hurt', n: 15 }));
  // Never held-back outcomes: a practice-validate, test or final window is refused, as is a window spanning into one.
  for (const w of [{ from: '2024-08-05', to: '2024-08-06' }, { from: '2025-03-03', to: '2025-03-04' }, { from: '2024-06-28', to: '2024-07-03' }]) {
    assert.throws(() => LS.appendLesson(file, lesson({ windows: [w] })), /practice-train only/);
  }
  assert.throws(() => LS.appendLesson(file, lesson({ verdict: 'kept' })), /verdict: one of helped, no effect, hurt/);
  assert.throws(() => LS.appendLesson(file, lesson({ n: undefined })), /n: the paired decisions/);
  const text = LS.summarize(LS.readLessons(file));
  assert.match(text, /^Evidence only, from practice-train probes/);
  assert.match(text, /- a, rewording \(misread\): helped 1 of 2, no effect 1, hurt 0 \(n per probe: 12, 9\)/);
  assert.match(text, /- b, example \(misread\): helped 0 of 1, no effect 0, hurt 1 \(n per probe: 15\)/);
  // A line written by hand on a held-back window is never summarized.
  fs.appendFileSync(file, `${JSON.stringify(lesson({ proposalId: 'x', skill: 'held', windows: [{ from: '2025-03-03', to: '2025-03-04' }] }))}\n`);
  assert.doesNotMatch(LS.summarize(LS.readLessons(file)), /held/);
  // Capped in lines and characters.
  const many = Array.from({ length: 40 }, (_, i) => lesson({ proposalId: `m${i}`, skill: `s${i}` }));
  const capped = LS.summarize(many);
  assert.ok(capped.split('\n').length <= LS.MAX_LINES + 2 && capped.length <= LS.MAX_CHARS, capped);
  assert.match(capped, /more group\(s\) not shown/);
  assert.ok(LS.summarize(many, { maxChars: 200 }).length <= 200);
  assert.strictEqual(LS.summarize([]), 'none yet');
});

test('the lessons record: the keep rule\'s verdict on a combined change, so a screen "helped" the keep rule rejected shows as such', () => {
  const file = path.join(tmpDir(), LS.FILE);
  LS.appendLesson(file, { proposalId: 'e1', iteration: 1, skill: 'a', kind: 'rule', findingKind: 'misread', windows: WINDOW, verdict: 'helped', n: 28 });
  LS.appendLesson(file, { proposalId: 'e2', iteration: 1, skill: 'b', kind: 'example', findingKind: 'missed', windows: WINDOW, verdict: 'helped', n: 28 });
  LS.appendLesson(file, { proposalId: 'c1', iteration: 1, composed: true, parts: 1, partIds: ['e1'], windows: WINDOW, verdict: 'helped', n: 12 });
  const before = LS.summarize(LS.readLessons(file));
  assert.doesNotMatch(before, /keep rule:/);
  LS.appendKeep(file, { proposalId: 'c1', iteration: 1, keep: 'rejected', windows: WINDOW });
  const text = LS.summarize(LS.readLessons(file));
  assert.match(text, /- a, rule \(misread\): helped 1 of 1, no effect 0, hurt 0 \(n per probe: 28\); then the keep rule: rejected 1/);
  assert.match(text, /- combined changes \(1 parts\): helped 1 of 1, no effect 0, hurt 0 \(n per probe: 12\); then the keep rule: rejected 1/);
  assert.match(text, /- b, example \(missed\): helped 1 of 1, no effect 0, hurt 0 \(n per probe: 28\)$/m, 'an edit not in the combined change: no keep verdict');
  // Never a held-out window, never without a verdict.
  assert.throws(() => LS.appendKeep(file, { proposalId: 'c1', iteration: 1, keep: 'kept', windows: [{ from: '2025-03-03', to: '2025-03-04' }] }), /practice-train only/);
  assert.throws(() => LS.appendKeep(file, { proposalId: 'c1', iteration: 1, windows: WINDOW }), /keep: the keep rule's verdict/);
});

test('the probe prompt: the skill\'s text block, its placeholders filled; proposeProbes reads tagged PROPOSAL lines in one call', async () => {
  const t = proposer.readProbeTemplate(ROOT);
  for (const k of ['{{FINDINGS}}', '{{LESSONS}}', '{{FILES}}', '{{CATEGORIES}}', '{{KINDS}}', '{{K}}']) assert.ok(t.includes(k), k);
  assert.ok(t.length < 2500, `${t.length} characters`);
  assert.match(t, /You propose\. Code tests each edit/);
  const prompt = proposer.probePrompt({ template: t, findings: [{ id: 'F1', skill: 'a', kind: 'misread', count: 3, of: 9, detail: '' }], lessons: 'LESSONS-HERE', files: ['skills/a/SKILL.md'], k: 3 });
  assert.match(prompt, /F1\. a: misread: 3 of 9 claimed reads refused/);
  assert.match(prompt, /LESSONS-HERE/);
  assert.match(prompt, /at most 3 small edits/);
  assert.match(prompt, /rewording, example, rule, removal/);
  assert.doesNotMatch(prompt, /\{\{/);
  const line = JSON.stringify({ tag: { skill: 'a', finding: 'F1', kind: 'rule' }, ...edit('- line one', '- line one\n- x → y') });
  let calls = 0;
  const run = async (argv, opts) => { calls += 1; assert.ok(argv.some(a => String(a).includes('LESSONS-HERE'))); assert.strictEqual(opts.env.FTH_PAPER, '1'); return { code: 0, output: `PROPOSAL ${line}\nPROPOSAL {broken}\n` }; };
  const cfg = require('../../scripts/lib/autotrader').validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 });
  const res = await proposer.proposeProbes({ cfg, tree: ROOT, findings: [{ id: 'F1', skill: 'a', kind: 'misread', count: 1, of: 1 }], lessons: 'LESSONS-HERE', home: path.join(tmpDir(), 'home'), baseEnv: { PATH: process.env.PATH }, k: 3, run });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(res.proposals[0].tag, { skill: 'a', finding: 'F1', kind: 'rule' });
  assert.ok(!('tag' in res.proposals[0].proposal));
  assert.match(res.proposals[1].error, /not JSON/);
});

test('the default probeData on a finished run: the real experience decisions, skill usage (per-point relevance) and compose reads; the keys join', () => {
  const { M3, record, runDir } = require('../fixtures/learning');
  const { BARS } = require('../fixtures/decision-path');
  const BAR = '2026-04-23T14:00:00.000Z';
  const at = new Date(Date.parse(BAR) + M3).toISOString();
  const { dir, home } = runDir({ day: '2026-04-23', times: [at], records: [record({ at })], barRows: [[1, 1, 1, 1]] });
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify({ bars: BARS }));
  fs.writeFileSync(path.join(dir, 'autotrader.json'), JSON.stringify({ timeframe: 3, bars: 1400, symbols: ['MNQ'] }));
  const data = PR.probeData({ runDir: dir, tree: ROOT });
  assert.deepStrictEqual(data.decisions.map(d => [d.bar, d.decision]), [[BAR, 'passed']]);
  assert.deepStrictEqual(data.records.map(r => [r.root, r.bar, r.reads.length]), [['MNQ', BAR, 6]]);
  assert.strictEqual(data.usage.points, 1);
  assert.strictEqual(data.usage.perPoint, undefined, 'the per-point list goes to `points`, not the usage report');
  // The real availableAt relevance (a TRUE read pointing the side's way) at the bar, joined to the decision by its key.
  assert.deepStrictEqual(data.points.map(p => [p.root, p.bar]), [['MNQ', BAR]]);
  assert.ok(data.points[0].relevant.includes('bos-vs-choch'), JSON.stringify(data.points));
  // The scorecard line: its cycle's time and symbol as key, its bar as barT (another ISO spelling of the same moment).
  const scorecard = [
    { key: `${at}|MNQ`, t: at, barT: '2026-04-23T14:00:00Z', symbol: 'MNQ', category: 'wrong stated reason', actual: { action: 'none' }, falseReasons: ['"no gap": a gap holds'] },
    { key: `${new Date(Date.parse(at) + M3).toISOString()}|MNQ`, t: at, barT: at, symbol: 'MNQ', category: 'wrong stated reason', actual: { action: 'none' }, falseReasons: [] },
  ];
  const sided = SC.sideOf({ decisions: data.decisions, scorecard, usage: F.mergeUsage([data.usage]), points: data.points });
  assert.deepStrictEqual(sided.decisions.map(d => [d.key, d.day]), [[SC.momentKey('MNQ', BAR), '2026-04-23']]);
  assert.ok(sided.decisions[0].relevant.includes('bos-vs-choch'));
  assert.strictEqual(sided.scorecard[0].at, sided.decisions[0].key, 'the scorecard line and the decision: one moment');
  // refusalsOf: the refusal credited to the skills of the reads composed at its bar; a refusal at another bar to none.
  const refusals = F.refusalsOf(scorecard, data.records);
  // (Each read's skill is the crosswalk's for its form, not the label filed with it: "at prior VAH" is levels-and-reactions'.)
  assert.deepStrictEqual(refusals[0].skills, ['bos-vs-choch', 'candle-reading', 'invalidation', 'levels-and-reactions', 'rejection', 'take-profit']);
  assert.deepStrictEqual(refusals[1].skills, []);
  // keep: the points outside it are not counted, and their relevance is still listed.
  const none = PR.probeData({ runDir: dir, tree: ROOT, keep: () => false });
  assert.deepStrictEqual([none.usage.points, none.points.length], [0, 1]);
  assert.ok(data.usage.skills.some(x => x.reads > 0 && x.available > 0));
  assert.ok(none.usage.skills.every(x => x.reads === 0 && x.available === 0 && x.missed === 0), 'nothing outside keep is counted');
  assert.strictEqual(PR.probeData({ runDir: dir, tree: ROOT, keep: PR.inHalf(SC.halfOf('2026-04-23', 3), 3) }).usage.points, 1);
});

test('pool: at most `limit` at once; every started one finishes; the first error is thrown after', async () => {
  let now = 0;
  let peak = 0;
  const done = [];
  const fn = async i => { now += 1; peak = Math.max(peak, now); await new Promise(r => setTimeout(r, 5)); now -= 1; done.push(i); if (i === 2) throw new Error('boom'); return i * 2; };
  assert.deepStrictEqual(await PR.pool([0, 1, 3], 2, fn), [0, 2, 6]);
  assert.strictEqual(peak, 2);
  peak = 0;
  assert.deepStrictEqual(await PR.pool([0, 1, 3], 1, fn), [0, 2, 6]);
  assert.strictEqual(peak, 1, 'one at a time');
  done.length = 0;
  await assert.rejects(PR.pool([0, 1, 2, 3, 4], 2, fn), /boom/);
  assert.ok(now === 0, 'nothing left running');
  assert.ok(!done.includes(4), 'nothing new starts after an error');
});

// --- the loop, end to end with stubs -------------------------------------------------------------------------------

const MODEL = { account: 'acct_a', paths: 500 };
// The tree's skill text decides each side's decisions: GOOD fixes every misread of skill a and every wrong reason,
// SOME fixes the misreads of the first four session dates only (i < 16), BAD misreads everywhere; anything else is the champion's (every other decision wrong).
// REASON fixes the wrong reasons only; SOME and REASON together cancel (the champion's decisions).
// LUCKY fixes the misreads on the probe half's session dates only (seed 3): a gain found by chance there.
const behaviour = text => (text.includes('LUCKY') ? 'lucky' : text.includes('BAD') ? 'bad' : text.includes('GOOD') ? 'good'
  : text.includes('SOME') && text.includes('REASON') ? 'champion' : text.includes('SOME') ? 'some' : text.includes('REASON') ? 'reason' : 'champion');
const stateOf = (b, i) => (b === 'lucky' ? (i % 2 || SC.halfOf(dayOfT(TIMES[i]), 3) === 'probe' ? 'right' : 'misread') : b === 'bad' ? 'misread' : b === 'good' || i % 2 || (b === 'some' && i < 16) ? 'right' : 'misread');
const categoryOf = (b, i) => (b === 'bad' ? 'wrong-side entry' : b === 'good' || b === 'reason' || i % 2 ? 'right' : 'wrong stated reason');

function world({ proposals, verdict = 'kept', loop: over = {}, trend = false, trendBatch = {}, exits = false, incompleteDay = null, claimed = null, curriculum = undefined, entered = false, trades = false } = {}) {
  const user = tmpDir();
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'home') };
  fs.mkdirSync(env.FTH_HOME);
  const trader = { harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3, account: '7' };
  const replay = { workDir: path.join(user, 'work'), broker: 'sim', premarket: false, autotrader: trader };
  const loop = resolveLoop({
    loopId: 'l1', replay, tuningWindows: TUNING, proposer: trader, repeats: 1, seed: 3, maxFlagged: 6, controlPoints: 0, modelScore: MODEL,
    // The config's probe replay is a stage-1 curated practice config; the stub world runs the same replay without a list.
    // parallel 2: no latency charged, so the probes queued together are charged as the champion's run alone (none).
    probe: { replay: { ...replay, latency: false, stage: 1, curatedList: { file: 'curated.json', list: 'mix' }, practice: { mode: 'setup-focus', setupTf: 15, quietSample: 0.15, seed: 7 } }, windows: WINDOW, k: 4, parallel: 2 },
    limits: { maxIterations: 1, maxModelCalls: 10000, maxWallMinutes: 30 }, ...over,
  });
  loop.probe = { ...loop.probe, replay: { ...replay, latency: false, practice: { mode: 'setup-focus', setupTf: 15, quietSample: 0.15, seed: 7 } } };
  const calls = { proposeProbes: [], runs: [], probeData: [], verifier: [], branches: [], propose: 0, halves: [], trendData: [], preflight: [] };
  const trees = new Map();
  const textOf = dir => fs.readFileSync(path.join(dir, SKILL), 'utf8');
  const steps = {
    // The preflight's own tests run it for real (train-trend-windows.test.js); here each run's loop role is recorded.
    preflight: (run, gate) => { calls.preflight.push({ runId: run.runId, loopRole: gate.loopRole || null }); return { ok: true, results: [], record: () => null }; },
    makeTree: dir => {
      fs.mkdirSync(path.join(dir, 'skills', 'a'), { recursive: true }); fs.writeFileSync(path.join(dir, SKILL), TEXT); fs.mkdirSync(path.join(dir, 'workspace'));
      // With exits: an exit finding's owner in the tree (exit-findings.js OWNERS), the skill its edit changes.
      if (exits) { fs.mkdirSync(path.join(dir, 'skills', 'manage-position'), { recursive: true }); fs.writeFileSync(path.join(dir, MP), TEXT.replace('name: a', 'name: manage-position')); }
      return 'c0ffee';
    },
    prepareTree: (dir, { proposal }) => { if (proposal) require('../../scripts/lib/train/proposal').applyProposal(proposal, dir); },
    seedRunHome: run => {
      for (const d of [run.paths.runDir, run.paths.workspace, run.paths.bars]) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(run.paths.runHome, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['x'], replay: true, journalEnv: 'SIM_JOURNAL', env: [] } } }));
    },
    runReplay: async ({ run, root, deps }) => {
      calls.runs.push({ runId: run.runId, start: run.start.toISOString(), end: run.end.toISOString(), practice: run.practice || null, tree: path.basename(root) });
      const manifest = store.openRun(run.paths, { runId: run.runId, hash: 'h' });
      const done = store.recordedTimes(run.paths.runDir);
      // A probe half's run (its label: -p0 the probe half, -q0 the confirm half) steps that half's moments only, as the
      // half's curated list does (probe-halves.js); every other run steps them all.
      const half = /-p\d+$/.test(run.runId) ? 'probe' : /-q\d+$/.test(run.runId) ? 'confirm' : null;
      // A trend run (one a day: -t<yyyymmdd>.<windows hash>.0) steps its own day's stepped windows only, as the driver
      // does (curatedPoints: a time whose bar closed in a window).
      const sw = run.stepWindows;
      const inRun = t => !sw || sw.windows.some(x => Date.parse(t) - 2000 > x.from && Date.parse(t) - 2000 <= x.to);
      const todo = TIMES.filter(t => !done.has(t) && inRun(t) && (!half || SC.halfOf(dayOfT(t), w.loop.seed) === half));
      trees.set(run.paths.runDir, root);
      for (const t of todo) {
        fs.writeFileSync(run.paths.clockFile, JSON.stringify({ now: t }));
        const res = await deps.step({ t: new Date(t), kind: 'trade', day: dayOfT(t) }, {}, 1000);
        store.appendRecord(run.paths, manifest, { t, day: dayOfT(t), kind: 'trade', ran: store.parseStep(res.output).ran });
      }
      return { cycles: todo.length, stopped: null, done: true };
    },
    stepDeps: (run, dir) => ({
      serverCheck: async () => null,
      trades: async () => [],
      step: async () => ({ code: 0, output: `REPLAY STEP ${JSON.stringify({ ran: [{ action: 'trade', ok: true, result: behaviour(textOf(dir)) }] })}` }),
    }),
    scorecard: ({ runDir }) => Object.values(store.readRun(runDir).days).flat().map(l => {
      const i = TIMES.indexOf(l.t);
      // trades: a filled trade's R on two of every four moments (+2R, then -1R; a challenger's run, c- or k-, +3R), as
      // scorecardDecisions says it, so a side read from the other side's runs shows.
      const win = /^[^-]+-[ck]-/.test(path.basename(runDir)) ? 3 : 2;
      return { key: `${l.t}|MNQ`, t: l.t, barT: l.t, day: l.day, symbol: 'MNQ', category: categoryOf(l.ran[0].result, i), actual: { action: 'none' }, falseReasons: [], inTrade: false, blow: false, ...(trades ? { trade: i % 4 === 0 ? { r: win } : i % 4 === 1 ? { r: -1 } : null } : {}) };
    }),
    probeData: ({ runDir, tree: dir }) => {
      calls.probeData.push({ runDir: path.basename(runDir), tree: path.basename(dir) });
      const b = behaviour(textOf(dir));
      // A trend run (read under curriculum trend): only the moments it stepped, as the real step reads its own log.
      const stepped = TREND_RUN.test(path.basename(runDir)) ? store.recordedTimes(runDir) : null;
      // claimed: only the first that many moments carry a read of skill a (none: every one).
      // entered: every moment an entry (long), its R the exit stub's (EXITFIX in manage-position banks 1.5R, else 0.5R).
      const fixR = exits && /EXITFIX/.test(fs.readFileSync(path.join(dir, MP), 'utf8')) ? 1.5 : 0.5;
      const decisions = TIMES.map((t, i) => ({ root: 'MNQ', bar: t, ...(entered ? { decision: 'entered', side: 'long', outcome: { R: fixR } } : { decision: 'passed', outcome: { R: 0 } }), reads: claimed !== null && i >= claimed ? [] : [{ step: 'zone', skill: 'a', read: 'y', check: stateOf(b, i) === 'right', agrees: true }] })).filter(d => !stepped || stepped.has(d.bar));
      const wrong = decisions.filter(d => d.reads.length && !d.reads[0].check).length;
      return { decisions, usage: { skills: [{ skill: 'a', reads: 20, correct: 20 - wrong, wrong, available: 20, used: 20, relevant: 20, missed: 0, topRefusals: wrong ? [{ what: 'false: y', count: wrong }] : [], topMissed: [] }] }, records: [] };
    },
    // Each half: the same replay config (the stub replays no list), its session dates and moments, as the real step reads them.
    halfReplay: ({ replay: r, which, seed }) => { calls.halves.push(which); const days = DAYS.filter(d => SC.halfOf(d, seed) === which); return { replay: r, days, moments: days.length * 4, fingerprint: `f-${which}` }; },
    // A trend run's capture: two legs a session (long, short). The champion catches the long legs of the even dates;
    // TREND catches every leg; GREEDY catches every leg and loses 1R a session; REGLOSE catches every leg but the
    // regression day's. A missed leg: blocked at entry by a
    // refused read of skill a.
    // The step reads the legs and windows the loop gives it (the census's legs, trend-windows.js), as the real one does.
    trendData: ({ runDir, legs: given, windows, context = [] }) => {
      const text = textOf(trees.get(runDir));
      calls.trendData.push({ run: path.basename(runDir), legs: given.map(g => g.id), windows, context: context.map(g => g.id) });
      const recorded = store.readRun(runDir).days;
      const days = Object.keys(recorded).sort();
      const legs = given.filter(g => days.includes(g.day)).map(({ id, day, side }) => {
        const lucky = /LUCKYLEGS/.test(text) && (ROUND1.probe.days.includes(day) || day === REG_DAY);
        const caught = lucky || (/TREND|GREEDY|SLOPPY/.test(text) || (/REGLOSE/.test(text) && day !== REG_DAY)) || (!/REGLOSE/.test(text) && side === 'long' && DAYS.indexOf(day) % 2 === 0);
        // Its catch & ride (replay/trend-ride.js): a caught leg's trade banked half the leg; GREEDY's lost.
        const ride = caught ? { entryLag: 0.25, captureShare: /GREEDY/.test(text) ? -0.25 : 0.5, rideShare: /GREEDY/.test(text) ? -0.33 : 0.67, peakR: 2, peakFrom: 'round-trip', givebackR: /GREEDY/.test(text) ? 3 : 1, r: /GREEDY/.test(text) ? -1 : 1, open: false } : null;
        return { id, day, side, captured: caught, availableR: 2, size: { x: 2.5, bucket: '2-4x' }, ride, blocker: caught ? null : { step: 'entry', code: 'entry:momentum', by: 'compose_check' }, cycles: caught ? [] : [{ code: 'entry:momentum', by: 'compose_check', step: 'entry', message: 'momentum: weak', reads: [{ step: 'entry', read: 'x', skill: 'a', verified: false }] }] };
      });
      // The first tries: one decision point a side a session; SLOPPY reads wrong first and is rescued by the hint.
      const first = days.flatMap(day => ['long', 'short'].map(side => ({ key: `MNQ|${day}T14:33:00.000Z|${side}`, root: 'MNQ', bar: `${day}T14:33:00.000Z`, side, first: { ok: !/SLOPPY/.test(text), reads: [{ step: 'entry', skill: 'a', check: !/SLOPPY/.test(text) }], failed: /SLOPPY/.test(text) ? ['entry'] : [] }, tries: /SLOPPY/.test(text) ? 2 : 1, rescued: /SLOPPY/.test(text), finalOk: true })));
      // Entries: the champion takes each session's long reaction (14:33Z); TREND takes both.
      const entries = days.flatMap(day => [{ at: `${day}T14:36:30.000Z`, side: 'long' }, ...(/TREND/.test(text) ? [{ at: `${day}T14:36:30.000Z`, side: 'short' }] : [])]);
      // Each window stepped to its end or not, from the run's own records (the leg window's last time is 14:42:02Z).
      // incompleteDay: the exit edit's run of that day leaves its windows unfinished (only the champion finished them).
      const cut = incompleteDay && days.includes(incompleteDay) && exits && /EXITFIX/.test(fs.readFileSync(path.join(trees.get(runDir), MP), 'utf8'));
      const sessions = require('../../scripts/lib/train/trend-windows').windowStates({ days: recorded, windows, minutes: 3 }).map(s => ({ ...s, rollMonth: false, ...(cut ? { complete: false, why: 'stopped' } : {}) }));
      // With exits: EXIT_TRADES scored model exits a session, a minute apart (the champion cuts each at 0.5R; manage-position's
      // EXITFIX rides it to 1.5R).
      const fix = exits && /EXITFIX/.test(fs.readFileSync(path.join(trees.get(runDir), MP), 'utf8'));
      // exits 'old': scored by code from before they named their trades (no root, no entry time).
      const named = (x, at) => (exits === 'old' ? x : { root: 'MNQ', entryAt: at, ...x });
      const scored = exits ? { exits: { decisions: days.flatMap(day => Array.from({ length: EXIT_TRADES }, (_, i) => named({ side: 'long', exitBy: 'model-exit', cls: fix ? 'right' : 'cut', leftR: 2, late: false, r: fix ? 1.5 : 0.5, peakR: 2, facts: null }, new Date(Date.parse(`${day}T14:36:30.000Z`) + i * 60000).toISOString()))), tightens: [] } } : {};
      return { capture: { legs, entries: entries.map(e => ({ ...e, kind: e.side === 'long' ? 'in-trend' : 'counter', leg: null, r: /GREEDY/.test(text) ? -1 : 0 })), ...scored }, days: Object.fromEntries(days.map(d => [d, [{ t: `${d}T14:42:02.000Z`, trades: [{ roundTrip: { r: /GREEDY/.test(text) ? -1 : 0 } }] }]])), first, entries, sessions, stepped: Object.values(recorded).flat().map(l => l.t), minutes: 3 };
    },
    // The trend facts (trend-facts.js attachFacts on the run's files): every missed leg here had a valid plan (learnable).
    // Its control bars: one a run, a valid plan that lost (the balancing example the proposer reads).
    trendFacts: (capture, { runDir, controls }) => {
      calls.trendFacts = [...(calls.trendFacts || []), path.basename(runDir)];
      calls.trendControls = [...(calls.trendControls || []), controls];
      const lost = { bar: '2022-03-07T15:00:00.000Z', known: true, valid: true, side: 'long', planReads: ['15m up'], shown: 'no-trade - waiting', outcome: 'lost' };
      return { ...capture, legs: capture.legs.map(l => (l.captured ? l : { ...l, facts: { learnable: true, why: 'the standard plan passes', bars: [{ known: true, valid: true }], owner: null } })), controls: [lost] };
    },
    // proposals: a list, or a function of the round (1, 2, ...) giving that round's list.
    proposeProbes: async opts => { calls.proposeProbes.push(opts); return { proposals: (typeof proposals === 'function' ? proposals(calls.proposeProbes.length) : proposals).map(p => ({ ...p })) }; },
    propose: async () => { calls.propose += 1; return { proposals: [] }; },
    evaluator: async () => ({ available: false, why: 'stub' }),
    modelVerifier: opts => { calls.verifier.push(opts); return { available: true, verdict, reasons: [`model ${verdict}`], windows: [] }; },
    writeBranch: opts => { calls.branches.push(opts); return 'deadbeef'.repeat(5); },
  };
  // The scan's reactions: a long that won and a short that lost, each session at 14:33Z.
  const momentsFile = path.join(user, 'moments.jsonl');
  // And one after the runner's session (21:00Z, 16:00 New York time), which no run could act on: never counted.
  fs.writeFileSync(momentsFile, DAYS.flatMap(day => [[`${day}T14:33:00.000Z`, 'long', 2], [`${day}T14:33:00.000Z`, 'short', -1], [`${day}T21:00:00.000Z`, 'long', 9]].map(([bar, side, R]) => JSON.stringify({ day, bar, side, minutes: 3, validBars: 2, standard: { status: 'traded' }, outcome: { R } }))).join('\n'));
  // curriculum: the probe setting's (probe-config.js); 'trend' has no curated replay or windows.
  if (curriculum === 'trend') loop.probe = { ...loop.probe, curriculum, replay: null, windows: [] };
  else if (curriculum !== undefined) loop.probe = { ...loop.probe, curriculum };
  if (trend) loop.probe = { ...loop.probe, trend: { moments: momentsFile, replay: { ...replay, latency: false }, set: { file: 'set.json', fingerprint: 'f', days: SET_DAYS, legs: POOL, spans: SPANS }, batch: { ...require('../../scripts/lib/tunables').training().trendBatch, start: BATCH, max: POOL.length, half: 0.5, ...trendBatch }, regression: { days: [REG_DAY] } } };
  const w = { user, env, loop, steps, calls, paths: S.loopPaths(env, 'l1') };
  return w;
}

const MP = 'skills/manage-position/SKILL.md';
const EXIT_TRADES = 6;
const tagged = (skill, finding, kind, find, replace, expects = 'fewer misreads') => ({ tag: { skill, finding, kind }, proposal: edit(find, replace, { expects }) });
const run = (w, opts = {}) => L.runLoop({ loop: w.loop, env: w.env, root: ROOT, steps: w.steps, dryRun: true, ...opts });

test('the loop with `probe`: k edits probed on the champion\'s moments and seed; the passing ones composed, re-probed, then the full keep rule decides', async () => {
  const w = world({
    proposals: [
      tagged('a', 'F1', 'rule', '- line one', '- line one\n- GOOD → read it'),
      tagged('a', 'F1', 'rewording', '- line one', '- line one, SOME', 'some'),
      tagged('a', 'F1', 'example', '- line two', '- line two\n- BAD → no read', 'harm'),
      tagged('a', 'F1', 'rewording', '- line three', '- line three, plain', 'neutral'),
      tagged('a', 'F1', 'rule', '- line one', '- wait 5 bars', 'numbers'),
    ],
  });
  await run(w);
  // One model call proposed them all (the screen and compose call none).
  assert.strictEqual(w.calls.proposeProbes.length, 1);
  assert.strictEqual(w.calls.propose, 0, 'the single-shot proposer is not used');
  assert.strictEqual(w.calls.proposeProbes[0].k, 4);
  assert.deepStrictEqual(w.calls.proposeProbes[0].findings.map(f => [f.id, f.skill, f.kind]), [['F1', 'a', 'misread'], ['F2', null, 'wrong-reason refusal']]);
  assert.strictEqual(w.calls.proposeProbes[0].lessons, 'none yet');
  const dir = w.paths.iter(1);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'probe-report.json'), 'utf8'));
  // The fifth is past k; nothing of it runs.
  assert.strictEqual(report.edits.length, 4);
  assert.deepStrictEqual(report.probes.map(p => p.verdict), ['helped', 'helped', 'hurt', 'no effect']);
  // Every probe replayed the same moments with the same replay config as the champion's probe run: each half a run
  // of its own (probe-halves.js), the champion each half, each edit the probe half only, the combined change the
  // confirm half only.
  const probeRuns = w.calls.runs.filter(r => /-[pq]0$/.test(r.runId));
  assert.strictEqual(probeRuns.length, 1 + 4 + 1 + 1, 'the champion\'s two halves, four probes, one combined change');
  assert.deepStrictEqual(probeRuns.filter(r => r.runId.endsWith('-q0')).map(r => r.runId), ['l1-pc-q0', `l1-k-${report.composed.id}-q0`], 'only the champion and the combined change replay the confirm half');
  assert.deepStrictEqual(w.calls.halves, ['probe', 'confirm'], 'each half is written once');
  // The cycles each side cost, from its recorded steps: 7 probe-half dates and 3 confirm-half dates, 4 times each.
  assert.deepStrictEqual(report.cycles, { champion: { probe: 28, confirm: 12 }, edits: Object.fromEntries(report.probes.map(p => [p.id, 28])), composed: 12 });
  assert.deepStrictEqual([...new Set(probeRuns.map(r => `${r.start}..${r.end}|${JSON.stringify(r.practice)}`))], [`${probeRuns[0].start}..${probeRuns[0].end}|${JSON.stringify(probeRuns[0].practice)}`]);
  assert.strictEqual(probeRuns[0].practice.seed, 7, 'the probe config\'s seed, on every side');
  // The keep rule's runs are the loop's own full-day replay config, never the probes'.
  assert.ok(w.calls.runs.filter(r => r.runId.endsWith('-t0')).every(r => r.practice === null));
  // Probes first: the champion's tuning replays run once, after every probe, only because a proposal reached the keep rule.
  const at = id => w.calls.runs.findIndex(r => r.runId === id);
  assert.strictEqual(w.calls.runs.filter(r => r.runId === 'l1-champion-t0').length, 1);
  assert.ok(at('l1-champion-t0') > Math.max(...probeRuns.map(r => at(r.runId))), w.calls.runs.map(r => r.runId).join(', '));
  assert.strictEqual(probeRuns[0].tree, 'champion');
  assert.deepStrictEqual(probeRuns.slice(1, 5).map(r => r.runId).sort(), report.probes.map(p => `l1-p-${p.id}-p0`).sort());
  // The iteration in one record: what was proposed, screened, composed and kept, the deltas and the cycles.
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'iteration-report.json'), 'utf8'));
  assert.deepStrictEqual([rec.proposed.length, rec.screened.map(x => x.verdict), rec.composed.verdict, rec.kept.verdict], [4, ['helped', 'helped', 'hurt', 'no effect'], 'helped', 'kept']);
  assert.deepStrictEqual(rec.deltas.target, { fixed: rec.deltas.target.fixed, broken: 0, pairs: 12 });
  assert.strictEqual(rec.deltas.capture, null, 'no trend set screened yet');
  assert.match(IR.line(rec), /^iteration 1: proposed 4 \(0 refused\), screened helped 2, hurt 1, no effect 1; combined \w+ helped; keep rule kept; confirm deltas: .*; cycles: champion 40, edits 112, combined 12$/);
  // The two helpful edits touch the same line: the larger gain (GOOD) kept, the conflict reported.
  const [good, some] = report.probes;
  assert.deepStrictEqual(report.composition.parts, [good.id]);
  assert.deepStrictEqual(report.composition.conflicts.map(c => [c.kept, c.dropped]), [[good.id, some.id]]);
  assert.strictEqual(report.composed.verdict, 'helped');
  // The combined change went through the full keep rule: the challenger's own full-day runs of the tuning windows.
  assert.strictEqual(w.calls.verifier.length, 1);
  assert.strictEqual(w.calls.verifier[0].pairs[0].champion.runDir.includes('l1-champion-t0'), true);
  const [e] = readArchive(w.paths.archive);
  assert.deepStrictEqual([e.verdict, e.source, e.composition.parts.map(p => p.id)], ['kept', 'propose-probe-compose', [good.id]]);
  assert.deepStrictEqual(e.proposal.edits, [{ file: SKILL, find: '- line one', replace: '- line one\n- GOOD → read it' }]);
  const body = fs.readFileSync(path.join(dir, 'promotion', e.proposalId, 'pr-body.md'), 'utf8');
  assert.match(body, /### Propose-Probe-Compose/);
  assert.match(body, /left out for/);
  assert.match(body, /The keep rule on the model's own trades/);
  // Edits only in the probe trees: the repository's skill is never touched, and dry run makes no branch.
  assert.strictEqual(w.calls.branches.length, 0);
  // The lessons record: one line per probe, one for the combined change, then the keep rule's verdict on it; practice-train only.
  const all = LS.readLessons(path.join(w.paths.dir, LS.FILE));
  const lessons = all.slice(0, 5);
  assert.deepStrictEqual(lessons.map(l => [l.verdict, l.composed === true]), [['helped', false], ['helped', false], ['hurt', false], ['no effect', false], ['helped', true]]);
  // n: each probe on the probe half's 28 decisions (seven session dates), the combined change on the confirm half's 12.
  assert.deepStrictEqual(lessons.map(l => [l.n, l.half]), [[28, 'probe'], [28, 'probe'], [28, 'probe'], [28, 'probe'], [12, 'confirm']]);
  assert.ok(lessons.every(l => LS.practiceOnly(l.windows) && l.seed === 3));
  assert.deepStrictEqual([all.length, all[5].proposalId, all[5].keep, LS.practiceOnly(all[5].windows)], [6, e.proposalId, 'kept', true]);
  // The split: by session date, seeded, recorded; the confirm half's dates never screened an edit.
  assert.deepStrictEqual(report.split, { seed: 3, by: 'session date', probe: ['2022-03-07', '2022-03-08', '2022-03-10', '2022-03-11', '2022-03-15', '2022-03-17', '2022-03-18'], confirm: ['2022-03-09', '2022-03-14', '2022-03-16'] });
  // The probe look: logged once, tuning, practice-train (no budget).
  assert.deepStrictEqual(S.readLedger(w.paths.ledger).filter(l => l.candidate === 'l1/probe').map(l => l.purpose), ['tuning']);
  // Resumed: nothing re-runs, nothing is written twice.
  const runs = w.calls.runs.length;
  await run(w);
  assert.strictEqual(w.calls.runs.length, runs);
  assert.strictEqual(LS.readLessons(path.join(w.paths.dir, LS.FILE)).length, 6);
});

test('with a trend set: its missed legs are findings first; an edit that catches them passes on the trend set, a greedy one never', async () => {
  const w = world({ trend: true, proposals: [
    tagged('a', 'F1', 'rule', '- line one', '- line one\n- TREND → enter on the pullback', 'more legs'),
    tagged('a', 'F1', 'rule', '- line two', '- line two\n- GREEDY → enter every leg', 'more legs, more losses'),
    tagged('a', 'F2', 'rule', '- line three', '- line three\n- GOOD → read it', 'fewer misreads'),
    tagged('a', 'F1', 'example', '- line two', '- line two\n- REGLOSE → enter late', 'more legs, not the regression day'),
  ] });
  await run(w);
  // Round 1's batch: BATCH legs of the pool, split by session date into about half each.
  const draw = TS.drawRound(POOL, { seed: 3, round: 1, per: BATCH });
  const split = TS.splitBatch(draw.items, { seed: 3, half: 0.5 });
  const probeLegs = split.probe.legs;
  const caughtByChampion = id => id.includes('|long|') && DAYS.indexOf(id.slice(0, 10)) % 2 === 0;
  const missed = probeLegs.filter(id => !caughtByChampion(id)).length;
  const f = w.calls.proposeProbes[0].findings;
  assert.deepStrictEqual([f[0].kind, f[0].skill, f[0].step, f[0].count, f[0].cost, f[0].of], ['trend-blocker', 'a', 'entry', missed, missed * 2, probeLegs.length], 'the champion\'s probe half: the batch\'s legs only, 2R each');
  assert.deepStrictEqual(f.slice(1).map(x => x.kind), ['misread', 'wrong-reason refusal']);
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  assert.deepStrictEqual(report.trend.batch, { index: 0, size: BATCH, from: 0, cycles: [0], trigger: 'start', why: `the loop's first round: ${BATCH} legs` });
  assert.deepStrictEqual([report.trend.probe.legs, report.trend.confirm.legs], [split.probe.legs, split.confirm.legs]);
  // The probe half's missed legs counted (every one learnable here: the trendFacts step's), the facts worked out only
  // for the champion's probe-half runs (the findings' half), never a confirm, regression or edit run.
  assert.deepStrictEqual(report.trend.missed, { missed, learnable: missed, noValidPlan: 0, unknown: 0 });
  const probeDay = r => split.probe.days.some(d => r.includes(`t${d.replace(/-/g, '')}.`));
  assert.ok(w.calls.trendFacts.length && w.calls.trendFacts.every(r => r.startsWith('l1-pc') && probeDay(r)), w.calls.trendFacts.join());
  // Given the day's control windows; the base rate in the report; the base rate and the plan that lost in the prompt.
  assert.ok(w.calls.trendControls.every(c => Array.isArray(c) && c.every(x => Number.isFinite(x.from) && Number.isFinite(x.to))), JSON.stringify(w.calls.trendControls));
  assert.deepStrictEqual(report.trend.baseRate.controlBars, { sides: w.calls.trendFacts.length, valid: w.calls.trendFacts.length, won: 0, lost: w.calls.trendFacts.length, undecided: 0 });
  assert.match(w.calls.proposeProbes[0].controls, /^Base rate: .*\nThose control plans by setup type, from this round's control windows .*\n {3}- other: n=\d+, .*\nValid plan, it lost .*\n {3}- long: valid plan, it lost: "15m up"/);
  assert.deepStrictEqual(report.trend.probe.days.filter(d => report.trend.confirm.days.includes(d)), [], 'no day in both halves');
  assert.deepStrictEqual(report.trend.regression, [REG_DAY]);
  assert.deepStrictEqual(report.probes.map(p => p.verdict), ['helped', 'no effect', 'helped', 'hurt'], 'the greedy edit\'s catches on losing sessions never count; a leg lost on the regression day hurts');
  assert.match(report.probes[3].harms.join(), /regression days: 1 leg\(s\) the champion caught lost, net/);
  assert.deepStrictEqual(report.probes.map(p => p.target.pairs), [probeLegs.length, probeLegs.length, 28, probeLegs.length], 'a trend edit judged on the batch\'s probe-half legs, the curated one on its decisions');
  // Runs, one a session: the champion's probe half, regression day and confirm half; each edit its probe half and the
  // regression day; the combined change the confirm half and the regression day. Never an edit on a confirm day.
  const trendRuns = w.calls.runs.filter(r => TREND_RUN.test(r.runId)).map(r => ({ side: r.runId.replace(TREND_RUN, ''), day: dayOfRun(r.runId) }));
  const daysOf = side => trendRuns.filter(r => r.side === side).map(r => r.day).sort();
  assert.deepStrictEqual(daysOf('l1-pc'), [...split.probe.days, REG_DAY, ...split.confirm.days].sort());
  for (const p of report.probes) assert.deepStrictEqual(daysOf(`l1-p-${p.id}`), [...split.probe.days, REG_DAY].sort(), p.id);
  assert.deepStrictEqual(daysOf(`l1-k-${report.composed.id}`), [...split.confirm.days, REG_DAY].sort());
  assert.strictEqual(report.composed.verdict, 'helped');
  // The keep rule's runs (the champion's tuning replays and the challenger's) carry the loop's keep-rule role; the trend runs trend-set.
  const roles = re => [...new Set(w.calls.preflight.filter(p => re.test(p.runId)).map(p => p.loopRole))];
  assert.deepStrictEqual([roles(/-(champion|c-[0-9a-f]+)-t\d+$/), roles(TREND_RUN)], [['keep-rule'], ['trend-set']]);
  assert.strictEqual(report.composition.parts.length, 2, 'the trend edit and the curated one, on different lines');
  const rec = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'iteration-report.json'), 'utf8'));
  assert.deepStrictEqual([rec.deltas.capture.broken, rec.deltas.capture.rate.probe, rec.deltas.capture.pairs], [0, 1, split.confirm.legs.length]);
  assert.ok(rec.deltas.capture.fixed > 0);
  assert.match(IR.line(rec), /legs caught \+\d+\/-0 of \d+ \([\d.]+ -> 1\)/);
  // The round's catch & ride (trend-ride.js), report only: the champion's confirm half over the same finished legs as its
  // curve point, its probe half, each edit's probe half, the combined change's confirm half; the status block.
  const ride = report.trend.champion.ride;
  // Each run's capture is given the day's other census legs to classify its entries, never its own legs.
  assert.ok(w.calls.trendData.some(c => c.context.length), "some day holds legs outside the run's windows");
  assert.ok(w.calls.trendData.every(c => c.context.every(id => !c.legs.includes(id) && c.legs.every(l => l.split('|')[0] === id.split('|')[0]))), JSON.stringify(w.calls.trendData.map(c => c.context)));
  assert.deepStrictEqual([ride.legs, ride.caught], [report.trend.champion.legs, report.trend.champion.caught]);
  assert.ok(ride.caught > 0 && ride.captureShare.median === 0.5 && ride.entries.filled > 0 && ride.entries.inTrendShare === 1, JSON.stringify(ride));
  assert.ok(report.trend.probeRide && report.trend.probeRide.legs === split.probe.legs.length, JSON.stringify(report.trend.probeRide));
  assert.ok(report.probes.every(p => p.ride && p.ride.legs === split.probe.legs.length), 'every edit\'s probe half');
  assert.ok(report.composed.trend.ride && report.composed.trend.ride.legs === split.confirm.legs.length);
  assert.deepStrictEqual(rec.ride.champion, ride);
  const TR = require('../../scripts/lib/replay/trend-ride');
  assert.deepStrictEqual(IR.rideLines(rec), [
    '  Trend catch & ride (iteration 1):', `    champion confirm: ${TR.rideLine(ride)}`, `    champion probe: ${TR.rideLine(report.trend.probeRide)}`,
    ...report.probes.map(p => `    edit ${p.id} probe: ${TR.rideLine(p.ride)}`), `    combined ${report.composed.id} confirm: ${TR.rideLine(report.composed.trend.ride)}`,
  ]);
  assert.match(IR.rideLines(rec)[1], /^ {4}champion confirm: \d+ leg\(s\), \d+ caught \(\d+%\), R caught [\d.-]+ \/ R available [\d.]+, median capture share 0.5, ride share 0.67, entry lag 0.25, giveback 1R, in-trend entries \d+ of \d+ \(100%\)$/);
  // Without a trend set: no block.
  assert.deepStrictEqual(IR.rideLines({ ...rec, ride: null }), []);
  // Each side's share of skipped bars (latency; none in the stub world), the champion's, each edit's and the combined change's.
  assert.deepStrictEqual(rec.skipped.champion, { skipped: 0, bars: rec.skipped.champion.bars, share: 0, legWindows: 0 });
  assert.ok(rec.skipped.champion.bars > 0 && Object.keys(rec.skipped.edits).length === report.probes.length && rec.skipped.composed);
  assert.match(IR.line(rec), new RegExp(`; skipped bars: champion 0, ${report.probes[0].id} 0, .*combined 0`));
  // Selection value on the confirm half: the champion took the winning longs and passed the losing shorts.
  const n = split.confirm.days.length;
  assert.deepStrictEqual(report.trend.champion.selection, { reactions: n * 2, taken: { n, meanR: 2 }, passed: { n, meanR: -1 }, value: 3 });
  // The kept change took every reaction: its taken mean 0.5, none passed, so no value to compare (never a guess).
  assert.deepStrictEqual(rec.curvePoint.selection, { reactions: n * 2, taken: { n: n * 2, meanR: 0.5 }, passed: { n: 0, meanR: null }, value: null });
  assert.match(IR.line(rec), new RegExp(`trend batch 0 \\(probe ${split.probe.legs.length} legs on ${split.probe.days.length} day\\(s\\), confirm ${split.confirm.legs.length} on ${split.confirm.days.length}\\)`));
  // The lessons: the trend edits' lines carry their n on the batch's legs, and the batch they were judged on.
  const lessons = LS.readLessons(path.join(w.paths.dir, LS.FILE)).filter(l => !l.composed);
  assert.deepStrictEqual(lessons.map(l => [l.findingKind, l.n]), [['trend-blocker', probeLegs.length], ['trend-blocker', probeLegs.length], ['misread', 28], ['trend-blocker', probeLegs.length]]);
  assert.ok(lessons.every(l => l.trendBatch && l.trendBatch.index === 0 && l.trendBatch.probe === probeLegs.length));
});

test('an exit finding\'s edit is screened on the trades both sides opened (the trend set\'s scored exits), never on read claims', async () => {
  let w = null;
  const exitEdit = () => {
    const f = w.calls.proposeProbes[0].findings.find(x => x.kind === 'exit-decision');
    return [{ tag: { skill: 'manage-position', finding: f.id, kind: 'rule' }, proposal: edit('- line one', '- line one\n- EXITFIX → hold the healthy pullback', { expects: 'fewer cut trends', edits: [{ file: MP, find: '- line one', replace: '- line one\n- EXITFIX → hold the healthy pullback' }] }) }];
  };
  w = world({ trend: true, exits: true, proposals: exitEdit });
  await run(w);
  const f = w.calls.proposeProbes[0].findings.find(x => x.kind === 'exit-decision');
  assert.deepStrictEqual([f.code, f.skills], ['cut-trend', ['manage-position']]);
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  const [p] = report.probes;
  const days = TS.splitBatch(TS.drawRound(POOL, { seed: 3, round: 1, per: BATCH }).items, { seed: 3, half: 0.5 }).probe.days;
  assert.strictEqual(p.target.measure, 'exit: R banked on the trades both sides opened');
  const n = days.length * EXIT_TRADES;
  assert.ok(n >= SC.SCREEN.minPairs, `enough trades for the gain path (${n})`);
  assert.deepStrictEqual([p.target.pairs, p.target.b, p.target.c, p.target.enough], [n, n, 0, true], 'every probe-half trade 1R better');
  assert.deepStrictEqual(p.target.classes, { 'cut->right (model-exit)': n });
  assert.strictEqual(p.verdict, 'helped', JSON.stringify(p));
  // The combined change: its exit part judged on the confirm half's trades both sides opened.
  const ct = report.composed.measures.target;
  assert.ok(ct && ct.measure === p.target.measure && ct.runners && ct.pairs > 0, JSON.stringify(report.composed));
  assert.strictEqual(report.composed.verdict, 'helped');
  // A window the edit's run left unfinished: that day's trades never pair (only the units both sides finished).
  let q = null;
  const [first] = [...days].sort();
  q = world({ trend: true, exits: true, incompleteDay: first, proposals: () => { const g = q.calls.proposeProbes[0].findings.find(x => x.kind === 'exit-decision'); return [{ tag: { skill: 'manage-position', finding: g.id, kind: 'rule' }, proposal: edit('- line one', '- line one\n- EXITFIX → hold', { expects: 'fewer cut trends', edits: [{ file: MP, find: '- line one', replace: '- line one\n- EXITFIX → hold' }] }) }]; } });
  await run(q);
  const short = JSON.parse(fs.readFileSync(path.join(q.paths.iter(1), 'probe-report.json'), 'utf8')).probes[0];
  assert.deepStrictEqual([short.target.pairs, short.target.unmatched, short.target.unfinished], [n - EXIT_TRADES, { champion: 0, probe: 0 }, { champion: EXIT_TRADES, probe: EXIT_TRADES }], 'the unfinished day\'s trades left out, counted apart');
});

test('a read finding whose skill has under minPairs judged decisions on the probe half is left out (said in the report); at minPairs it is kept', async () => {
  // The probe half's moments in order: the first k of them claimed (the moments before the k-th probe one carry the read).
  const probeIdx = TIMES.map((t, i) => (SC.halfOf(dayOfT(t), 3) === 'probe' ? i : -1)).filter(i => i >= 0);
  const min = SC.SCREEN.minPairs;
  const round = async k => {
    const w = world({ claimed: probeIdx[k - 1] + 1, proposals: [] });
    await run(w);
    return { w, report: JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8')) };
  };
  const under = await round(min - 1);
  assert.ok(!under.report.findings.some(f => f.kind === 'misread'), JSON.stringify(under.report.findings));
  assert.deepStrictEqual(under.report.readFindingsOmitted.map(x => [x.skill, x.kind, x.judged]), [['a', 'misread', min - 1]]);
  assert.match(under.report.readFindingsOmitted[0].why, new RegExp(`under the screen's minPairs ${min}: no edit of it could show a gain`));
  const at = await round(min);
  assert.ok(at.report.findings.some(f => f.kind === 'misread' && f.skill === 'a'), JSON.stringify(at.report.findings));
  assert.ok(!(at.report.readFindingsOmitted || []).some(x => x.kind === 'misread'));
});

test('scored exits that name no trade (older code): the round shows no exit finding, so no edit is spent on one', async () => {
  let o = null;
  o = world({ trend: true, exits: 'old', proposals: () => (o.calls.proposeProbes[0].findings.some(x => x.kind === 'exit-decision') ? [{ tag: { skill: 'manage-position', finding: 'F1', kind: 'rule' }, proposal: edit('- line one', '- line one\n- EXITFIX → hold', { edits: [{ file: MP, find: '- line one', replace: '- line one\n- EXITFIX → hold' }] }) }] : []) });
  await run(o);
  assert.deepStrictEqual(o.calls.proposeProbes[0].findings.filter(x => x.kind === 'exit-decision'), []);
  const report = JSON.parse(fs.readFileSync(path.join(o.paths.iter(1), 'probe-report.json'), 'utf8'));
  assert.match(report.trend.exitFindings, /^none: the champion's scored exits name no trade/);
  assert.ok(report.trend.exits.byExit['model-exit'].n > 0, 'the exits are still scored and reported');
  // With exits that name their trades, the same round has its exit finding.
  const k = world({ trend: true, exits: true, proposals: () => [] });
  await run(k);
  assert.ok(k.calls.proposeProbes[0].findings.some(x => x.kind === 'exit-decision'));
});

test('with a trend pool: a trend edit gains only on the trend batch; one that gains on the probe half alone never reaches the keep rule', async () => {
  const w = world({ trend: true, proposals: [
    tagged('a', 'F1', 'rule', '- line one', '- line one\n- GOOD → read it', 'a curated gain for a trend finding'),
    tagged('a', 'F1', 'rule', '- line two', '- line two\n- LUCKYLEGS → enter', 'legs on some days'),
  ] });
  await run(w);
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  assert.deepStrictEqual(report.probes.map(p => p.verdict), ['no effect', 'helped'], 'a curated gain is no trend finding\'s gain');
  assert.deepStrictEqual([report.composed.verdict, report.composed.cancelled.length], ['no effect', 1], 'its trend gain must hold on the confirm half');
  assert.strictEqual(w.calls.verifier.length, 0);
});

test('the trend batch adapts: it doubles after two rounds without an improvement, to its cap; a rejected edit never grows it', async () => {
  // Each round a new neutral edit (no effect anywhere): no improvement, round after round.
  const w = world({ trend: true, trendBatch: { start: 4, max: 10 }, proposals: r => [tagged('a', 'F1', 'rule', '- line three', `- line three, plain ${'x'.repeat(r)}`, `neutral ${r}`)], loop: { limits: { maxIterations: 5, maxModelCalls: 10000, maxWallMinutes: 30 } } });
  await run(w);
  const reps = [1, 2, 3, 4, 5].map(n => JSON.parse(fs.readFileSync(path.join(w.paths.iter(n), 'probe-report.json'), 'utf8')).trend.batch);
  assert.deepStrictEqual(reps.map(b => [b.size, b.trigger]), [[4, 'start'], [4, 'keep'], [8, 'grow'], [8, 'keep'], [10, 'grow']], reps.map(b => b.why).join(' | '));
  // The batches read one sequence: each round's from is where the one before ended.
  assert.deepStrictEqual(reps.map(b => b.from), [0, 4, 8, 16, 24]);
  const recs = [1, 2, 3, 4, 5].map(n => JSON.parse(fs.readFileSync(path.join(w.paths.iter(n), 'iteration-report.json'), 'utf8')));
  assert.deepStrictEqual(recs.map(r => r.trend.outcome), ['no-improvement', 'no-improvement', 'no-improvement', 'no-improvement', 'no-improvement']);
  // The learning curve: each round's champion confirm half, pooled across rounds.
  assert.deepStrictEqual(recs.map(r => r.curve.points.length), [1, 2, 3, 4, 5]);
  assert.ok(recs.every(r => r.curvePoint.source === 'champion' && r.curvePoint.legs > 0));
  assert.strictEqual(recs[4].curve.pooled.legs, recs.reduce((s, r) => s + r.curvePoint.legs, 0));
  assert.match(IR.line(recs[4]), /confirm capture [\d.]+ \[[\d.]+, [\d.]+\] net R\/window 0, first-try reads 1 OK 1 hint-rescued 0, selection value 3 \(taken \d+ at 2R, passed \d+ at -1R\) \(champion\), pooled [\d.]+ over 5 round\(s\)/);
});

test('first-try reasoning is a harm check: an edit that catches every leg only after the hints is hurt, never a gain', async () => {
  const w = world({ trend: true, proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- SLOPPY → retry until OK', 'more legs, on the hints')] });
  await run(w);
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  assert.strictEqual(report.probes[0].verdict, 'hurt');
  assert.match(report.probes[0].harms.join(), /trend set: first-try reads worse \(broken \d+, fixed 0 of \d+ points, p [\d.]+\): the edit leans on the hints/);
  assert.deepStrictEqual(report.trend.champion.firstTry, { points: report.trend.confirm.days.length * 2, reads: report.trend.confirm.days.length * 2, readAccuracy: 1, decisionAccuracy: 1, okRate: 1, rescueRate: 0 });
  assert.strictEqual(w.calls.verifier.length, 0);
});

test('a kept change resets the trend batch to its start; the curve then reads the kept change', async () => {
  const w = world({ trend: true, trendBatch: { start: 6, max: 18 }, proposals: r => (r === 3 ? [tagged('a', 'F1', 'rule', '- line one', '- line one\n- TREND → enter on the pullback', 'more legs')] : [tagged('a', 'F1', 'rule', '- line three', `- line three, plain ${'x'.repeat(r)}`, `neutral ${r}`)]), loop: { limits: { maxIterations: 4, maxModelCalls: 10000, maxWallMinutes: 30 } } });
  await run(w);
  const reps = [1, 2, 3, 4].map(n => JSON.parse(fs.readFileSync(path.join(w.paths.iter(n), 'probe-report.json'), 'utf8')).trend.batch);
  assert.deepStrictEqual(reps.map(b => [b.size, b.trigger]), [[6, 'start'], [6, 'keep'], [12, 'grow'], [6, 'restart']], reps.map(b => b.why).join(' | '));
  const rec = JSON.parse(fs.readFileSync(path.join(w.paths.iter(3), 'iteration-report.json'), 'utf8'));
  assert.deepStrictEqual([rec.trend.outcome, rec.kept.verdict, rec.curvePoint.source, rec.curvePoint.rate], ['kept', 'kept', 'kept change', 1]);
});

test('with a trend pool, each round draws the next batch; the champion replays a session once a loop; edits share the round\'s days', async () => {
  const w = world({ trend: true, proposals: [tagged('a', 'F1', 'example', '- line two', '- line two\n- BAD → no read', 'harm')], loop: { limits: { maxIterations: 3, maxModelCalls: 10000, maxWallMinutes: 30 } } });
  await run(w);
  const reports = [1, 2, 3].map(n => JSON.parse(fs.readFileSync(path.join(w.paths.iter(n), 'probe-report.json'), 'utf8')));
  assert.deepStrictEqual(reports.map(r => r.trend.batch.index), [0, 1, 2]);
  const legsOf = r => [...r.trend.probe.legs, ...r.trend.confirm.legs].sort();
  for (const [i, r] of reports.entries()) assert.deepStrictEqual(legsOf(r), TS.drawRound(POOL, { seed: 3, round: i + 1, per: BATCH }).items, `round ${i + 1}`);
  assert.notDeepStrictEqual(legsOf(reports[0]), legsOf(reports[1]), 'the draw changes with the round');
  // Rounds 1 and 2 hold 24 draws of an 18-leg pool: every leg once before any twice.
  assert.deepStrictEqual([...new Set([...legsOf(reports[0]), ...legsOf(reports[1])])].sort(), [...POOL].sort());
  // The champion's day runs: each (day, windows) replayed once in the loop, however many rounds stepped it.
  const champ = w.calls.runs.filter(r => TREND_RUN.test(r.runId) && r.runId.startsWith('l1-pc-')).map(r => r.runId);
  assert.strictEqual(champ.length, new Set(champ).size);
  // A round's champion cost counts only the days it replayed fresh (4 decision times each in the stub world): a day's
  // windows are its legs' of the round's half, so a day drawn again with the same legs (the regression day) is reused.
  const legsByDay = r => new Map([...r.trend.probe.days, ...r.trend.confirm.days].map(d => [d, [...r.trend.probe.legs, ...r.trend.confirm.legs].filter(id => id.startsWith(d)).join()]));
  const before = legsByDay(reports[0]);
  const fresh = [...legsByDay(reports[1])].filter(([d, legs]) => before.get(d) !== legs);
  assert.strictEqual(reports[1].cycles.champion.trend, fresh.length * 4);
  // Each round's edit replays that round's probe half (and the regression day), never another round's.
  for (const [i, r] of reports.entries()) {
    const id = r.edits[0].id;
    if (r.edits[0].probedBefore) continue;
    const days = w.calls.runs.filter(x => x.runId.startsWith(`l1-p-${id}-t`)).map(x => dayOfRun(x.runId)).sort();
    assert.deepStrictEqual(days, [...r.trend.probe.days, REG_DAY].sort(), `round ${i + 1}`);
  }
});

test('a half with no session dates is inconclusive, never a pass: the report and a lessons line say so, no edit is proposed', async () => {
  const seed = 348;
  assert.strictEqual(new Set(DAYS.map(d => SC.halfOf(d, seed))).size, 1, 'this seed puts every session date in one half');
  const w = world({ proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- GOOD → read it')], loop: { seed } });
  await run(w, { dryRun: false });
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  assert.strictEqual(report.why, 'inconclusive: a half has no session dates');
  assert.strictEqual(w.calls.proposeProbes.length, 0, 'nothing is proposed or probed');
  assert.strictEqual(w.calls.branches.length, 0);
  assert.strictEqual(readArchive(w.paths.archive).length, 0, 'never a kept change');
  assert.deepStrictEqual(Object.values(report.split.moments).sort(), [0, 40]);
  assert.deepStrictEqual(w.calls.runs, [], 'the split is read from the list: nothing is replayed');
  const lessons = LS.readLessons(path.join(w.paths.dir, LS.FILE));
  assert.deepStrictEqual(lessons.map(l => [l.why, l.n, l.moments]), [[report.why, 0, report.split.moments]]);
  assert.match(LS.summarize(lessons), /none yet/, 'it is no evidence for the proposer');
});

test('the combined change still needs the full keep rule: a screen pass with a rejected or inconclusive keep rule is never kept', async () => {
  for (const verdict of ['rejected', 'inconclusive']) {
    const w = world({ proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- GOOD → read it')], verdict });
    await run(w, { dryRun: false });
    const [e] = readArchive(w.paths.archive);
    assert.strictEqual(e.verdict, verdict);
    assert.strictEqual(w.calls.branches.length, 0);
    // The lessons record says so: the next round's proposer reads a screen "helped" the keep rule did not keep.
    const lessons = LS.readLessons(path.join(w.paths.dir, LS.FILE));
    assert.deepStrictEqual(lessons.filter(l => l.keep).map(l => [l.proposalId, l.keep]), [[e.proposalId, verdict]]);
    assert.match(LS.summarize(lessons), new RegExp(`then the keep rule: ${verdict} 1`));
  }
});

test('compose re-probes the combined change: two edits that each helped but cancel together never reach the keep rule', async () => {
  const w = world({ proposals: [tagged('a', 'F1', 'rewording', '- line one', '- line one, SOME', 'some'), tagged('a', 'F2', 'rule', '- line two', '- line two\n- REASON → say it', 'reasons')] });
  await run(w);
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  assert.deepStrictEqual(report.probes.map(p => [p.finding, p.verdict]), [['F1', 'helped'], ['F2', 'helped']]);
  assert.strictEqual(report.composition.parts.length, 2);
  assert.deepStrictEqual([report.composed.verdict, report.composed.cancelled.length], ['no effect', 2]);
  assert.strictEqual(w.calls.verifier.length, 0, 'never to the keep rule');
  assert.deepStrictEqual(readArchive(w.paths.archive), []);
  const last = LS.readLessons(path.join(w.paths.dir, LS.FILE)).pop();
  assert.deepStrictEqual([last.composed, last.parts, last.verdict], [true, 2, 'no effect']);
});

test('the overfit guard in the loop: an edit that helps on the probe half only passes the screen and fails on the confirm half', async () => {
  const w = world({ proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- LUCKY → read it', 'lucky')] });
  await run(w);
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  assert.deepStrictEqual(report.probes.map(p => [p.verdict, p.target.b, p.target.pairs]), [['helped', 14, 28]]);
  assert.deepStrictEqual([report.composed.verdict, report.composed.cancelled.length], ['no effect', 1]);
  assert.strictEqual(w.calls.verifier.length, 0, 'never to the keep rule');
  assert.deepStrictEqual(readArchive(w.paths.archive), []);
});

test('nothing passes the screen: no proposal reaches the keep rule; the next round\'s proposer reads the lessons, never held-out data', async () => {
  const w = world({ proposals: [tagged('a', 'F1', 'example', '- line two', '- line two\n- BAD → no read', 'harm')], loop: { limits: { maxIterations: 2, maxModelCalls: 10000, maxWallMinutes: 30 } } });
  await run(w);
  assert.strictEqual(w.calls.verifier.length, 0);
  assert.deepStrictEqual(readArchive(w.paths.archive), []);
  // Nothing to judge: the champion's tuning replays (the costly full-day windows) never ran, in either round.
  assert.deepStrictEqual(w.calls.runs.filter(r => /-champion-t\d+$/.test(r.runId)), []);
  assert.strictEqual(w.calls.proposeProbes.length, 2);
  const second = w.calls.proposeProbes[1].lessons;
  assert.match(second, /^Evidence only, from practice-train probes/);
  assert.match(second, /- a, example \(misread\): helped 0 of 1, no effect 0, hurt 1 \(n per probe: 28\)/);
  // The same edit again is not re-probed.
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(2), 'probe-report.json'), 'utf8'));
  assert.deepStrictEqual(report.edits.map(x => x.probedBefore), [true]);
  assert.strictEqual(report.probes.length, 0);
});

test('probes first, the panel still stops the loop early: once the champion has run, nothing flagged left stops a round before its probes', async () => {
  const w = world({
    proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- GOOD → read it')],
    loop: { maxFlagged: 40, limits: { maxIterations: 3, maxModelCalls: 10000, maxWallMinutes: 30 } },
  });
  await run(w);
  // Round 1 probed, kept, and targeted every flagged decision; round 2 found none left before any probe or model call.
  assert.strictEqual(w.calls.proposeProbes.length, 1);
  const st = JSON.parse(fs.readFileSync(w.paths.state, 'utf8'));
  assert.deepStrictEqual(st.iterations.map(x => [x.n, x.done, Boolean(x.nothing)]), [[1, true, false], [2, true, true]]);
  assert.match(st.stopped, /nothing flagged left to work on/);
  assert.strictEqual(w.calls.runs.filter(r => r.runId === 'l1-champion-t0').length, 1);
  // A resume stops at once too: no probe round runs again.
  await run(w);
  assert.strictEqual(w.calls.proposeProbes.length, 1);
});

test('probes first: a runnable proposal the champion\'s first replays leave no panel to judge is archived as blocked, never dropped', async () => {
  const w = world({ proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- GOOD → read it')] });
  // The champion's tuning decisions all right: its panel has nothing flagged.
  const score = w.steps.scorecard;
  w.steps.scorecard = opts => score(opts).map(d => (/champion-t\d+$/.test(opts.runDir) ? { ...d, category: 'right' } : d));
  await run(w);
  assert.strictEqual(w.calls.verifier.length, 0, 'never judged');
  const [e] = readArchive(w.paths.archive);
  assert.strictEqual(e.verdict, 'blocked');
  assert.match(e.reasons[0], /^not judged: nothing flagged left to work on/);
  assert.strictEqual(e.source, 'propose-probe-compose');
  const keep = LS.readLessons(path.join(w.paths.dir, LS.FILE)).filter(l => typeof l.keep === 'string');
  assert.deepStrictEqual(keep.map(l => [l.proposalId, l.keep]), [[e.proposalId, 'blocked']]);
  const st = JSON.parse(fs.readFileSync(w.paths.state, 'utf8'));
  assert.match(st.stopped, /nothing flagged left to work on/);
  assert.deepStrictEqual(st.iterations.map(x => [x.done, Boolean(x.nothing)]), [[true, true]]);
});

test('probes first: a crash after the champion\'s first replays and before the archive never drops the round\'s proposal on resume', async () => {
  const w = world({ proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- GOOD → read it')] });
  const score = w.steps.scorecard;
  w.steps.scorecard = opts => score(opts).map(d => (/champion-t\d+$/.test(opts.runDir) ? { ...d, category: 'right' } : d));
  // The panel's first build dies once: the champion's scorecard is done, the round's proposals are recorded, nothing archived.
  const D = require('../../scripts/lib/train/decision-points');
  const choose = D.choosePanel;
  let failed = false;
  D.choosePanel = (...a) => { if (!failed) { failed = true; throw new Error('killed'); } return choose(...a); };
  try {
    await assert.rejects(run(w), /killed/);
    const mid = JSON.parse(fs.readFileSync(w.paths.state, 'utf8'));
    assert.deepStrictEqual([mid.done['scorecard:t'], mid.done['1:propose']], [true, true]);
    assert.deepStrictEqual(readArchive(w.paths.archive), []);
    await run(w);
  } finally {
    D.choosePanel = choose;
  }
  const [e] = readArchive(w.paths.archive);
  assert.deepStrictEqual([e && e.verdict, e && e.source], ['blocked', 'propose-probe-compose']);
  assert.strictEqual(w.calls.proposeProbes.length, 1, 'the resume proposes nothing new');
});

test('a probe edit that breaks its tag or the owner\'s style never runs', async () => {
  const w = world({ proposals: [tagged('a', 'F7', 'rule', '- line one', '- line one\n- GOOD'), tagged('a', 'F1', 'rule', '- line one', '- wait 5 bars GOOD'), { error: 'not JSON', line: 'PROPOSAL {' }] });
  await run(w);
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  assert.match(report.edits[0].errors.join(), /tag.finding/);
  assert.match(report.edits[1].errors.join(), /no numbers/);
  assert.deepStrictEqual(report.edits[2].errors, ['not JSON']);
  assert.strictEqual(w.calls.runs.filter(r => r.runId.endsWith('-p0')).length, 1, 'only the champion\'s probe run');
});

test('the `probe` config: needs modelScore; stage-1 curated practice; practice-train windows; k and parallel bounded', () => {
  const read = x => x;
  const replay = { stage: 1, curatedList: { file: 'c.json', list: 'mix' }, practice: { mode: 'setup-focus' } };
  const ok = { replay, windows: WINDOW };
  const trader = { harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 };
  // The probes run the loop's own model and runner config: left out, the loop's; given, it must be the loop's.
  assert.deepStrictEqual(PC.resolveProbe(ok, { read, modelScore: MODEL, autotrader: trader }), { replay: { ...replay, autotrader: trader }, windows: WINDOW, k: 4, parallel: 1 });
  const reordered = { timeframe: 3, symbols: ['MNQ'], command: ['x', '{prompt}'], harness: 'custom' };
  assert.deepStrictEqual(PC.resolveProbe({ ...ok, replay: { ...replay, autotrader: reordered } }, { read, modelScore: MODEL, autotrader: trader }).replay.autotrader, reordered);
  assert.throws(() => PC.resolveProbe({ ...ok, replay: { ...replay, autotrader: { ...trader, timeframe: 1 } } }, { read, modelScore: MODEL, autotrader: trader }), /probe.replay.autotrader: the loop's replay.autotrader/);
  // parallel > 1 only with no latency charged (the champion's probe run runs alone: charged latency would differ).
  assert.throws(() => PC.resolveProbe({ ...ok, parallel: 2 }, { read, modelScore: MODEL, autotrader: trader }), /probe.parallel: more than 1 only with probe.replay.latency false/);
  assert.throws(() => PC.resolveProbe({ ...ok, replay: { ...replay, latency: true }, parallel: 2 }, { read, modelScore: MODEL, autotrader: trader }), /probe.replay.latency false/);
  assert.strictEqual(PC.resolveProbe({ ...ok, replay: { ...replay, latency: false }, parallel: 2 }, { read, modelScore: MODEL, autotrader: trader }).parallel, 2);
  assert.strictEqual(PC.resolveProbe(undefined, { read }), null);
  assert.throws(() => PC.resolveProbe(ok, { read }), /set modelScore/);
  assert.throws(() => PC.resolveProbe({ ...ok, windows: [{ from: '2024-08-05', to: '2024-08-06' }] }, { read, modelScore: MODEL }), /practice-train only \(this touches practice-validate\)/);
  assert.throws(() => PC.resolveProbe({ ...ok, replay: { ...replay, stage: 2 } }, { read, modelScore: MODEL }), /probe.replay.stage: 1/);
  assert.throws(() => PC.resolveProbe({ ...ok, replay: { stage: 1 } }, { read, modelScore: MODEL }), /probe.replay.curatedList/);
  assert.throws(() => PC.resolveProbe({ ...ok, k: 9 }, { read, modelScore: MODEL }), /probe.k: a whole number from 1 to 8/);
  assert.throws(() => PC.resolveProbe({ ...ok, parallel: 0 }, { read, modelScore: MODEL }), /probe.parallel/);
  assert.throws(() => PC.resolveProbe({ ...ok, judge: 'model' }, { read, modelScore: MODEL }), /probe.judge: not a setting/);
  // Through the loop's config: in its hash; refused without modelScore.
  const base = world({ proposals: [] }).loop;
  const raw = over => ({ loopId: 'l1', replay: base.replay, proposer: base.proposer, tuningWindows: TUNING, modelScore: MODEL, probe: ok, ...over });
  // Disjoint from the keep rule's windows: a probe window sharing a session date with a tuning window is refused.
  assert.throws(() => resolveLoop(raw({ tuningWindows: WINDOW })), /probe.windows 2022-03-07..2022-03-19: shares session dates with the tuning window 2022-03-07..2022-03-19/);
  assert.throws(() => resolveLoop(raw({ tuningWindows: [{ from: '2022-03-18', to: '2022-04-01' }] })), /shares session dates/, 'one shared date is enough');
  assert.doesNotThrow(() => resolveLoop(raw({ tuningWindows: [{ from: '2022-03-19', to: '2022-04-01' }] })), 'to is exclusive: adjacent windows are disjoint');
  assert.strictEqual(PC.overlaps({ from: '2022-03-01', to: '2022-03-05' }, { from: '2022-03-04', to: '2022-03-09' }), true);
  assert.strictEqual(PC.overlaps({ from: '2022-03-01', to: '2022-03-05' }, { from: '2022-03-05', to: '2022-03-09' }), false);
  assert.notStrictEqual(resolveLoop(raw()).hash, resolveLoop({ ...raw(), probe: undefined }).hash);
  assert.throws(() => resolveLoop(raw({ modelScore: undefined })), /set modelScore/);
  assert.throws(() => resolveLoop(raw({ probe: { ...ok, replay: { ...replay, autotrader: { ...base.replay.autotrader, timeframe: 1 } } } })), /probe.replay.autotrader/);
  assert.deepStrictEqual(resolveLoop(raw()).probe.replay.autotrader, base.replay.autotrader);
});

test('no model judges: the screen, compose and the lessons record load no harness runner and no proposer', () => {
  for (const f of ['screen.js', 'compose.js', 'lessons.js', 'findings.js', 'probe-edit.js', 'probe-config.js']) {
    const code = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'train', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /require\([^)]*(proposer|harness-run|autotrader|child_process)[^)]*\)/, f);
  }
  // The probe round calls the proposer once and never hands a model a verdict to give.
  const probe = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'train', 'probe.js'), 'utf8');
  assert.strictEqual((probe.match(/ctx\.steps\.proposeProbes\(/g) || []).length, 1);
  assert.doesNotMatch(probe, /require\([^)]*proposer[^)]*\)/);
});

test('review: a trend step that reports no session state pairs nothing (fail closed); a one-day batch is inconclusive', async () => {
  const w = world({ trend: true, proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- TREND → enter on the pullback', 'more legs')] });
  const step = w.steps.trendData;
  w.steps.trendData = opts => { const { sessions: _s, ...rest } = step(opts); return rest; };
  await run(w);
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  assert.deepStrictEqual([report.probes[0].verdict, report.probes[0].target.pairs], ['no effect', 0], 'no leg pairs: no catch, no miss');
  assert.ok(report.probes[0].trend.sides.probe.dropped.every(x => x.why === 'the step reported no session state'));
  // A batch of one session: no confirm (or probe) half, so nothing is replayed and nothing proposed.
  const one = world({ trend: true, trendBatch: { start: 2, max: 2 }, proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- TREND → x', 'x')] });
  one.loop.probe.trend.set = { ...one.loop.probe.trend.set, legs: POOL.filter(id => id.startsWith(SET_DAYS[0])) };
  await run(one);
  const r1 = JSON.parse(fs.readFileSync(path.join(one.paths.iter(1), 'probe-report.json'), 'utf8'));
  assert.match(r1.why, /^inconclusive: no (probe|confirm) days in the trend batch \(2 leg\(s\) on 1 day\(s\)\)$/);
  assert.strictEqual(one.calls.proposeProbes.length, 0);
  assert.deepStrictEqual(one.calls.runs.filter(r => TREND_RUN.test(r.runId)), [], 'no trend session replayed');
});

test('the learning curve reads only the windows the champion finished; the champion and every edit step the same windows', async () => {
  const w = world({ trend: true, proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- TREND → enter on the pullback', 'more legs')] });
  const step = w.steps.trendData;
  // The champion leaves its first confirm day's windows unfinished (a call limit, say).
  const left = ROUND1.confirm.days[0];
  w.steps.trendData = opts => {
    const got = step(opts);
    if (!/^l1-pc-t/.test(path.basename(opts.runDir))) return got;
    return { ...got, sessions: got.sessions.map(s => (s.day === left ? { ...s, complete: false, why: 'stopped before the window ended' } : s)) };
  };
  await run(w);
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  const finishedLegs = ROUND1.confirm.legs.filter(id => !id.startsWith(left));
  assert.ok(finishedLegs.length < ROUND1.confirm.legs.length);
  assert.strictEqual(report.trend.champion.legs, finishedLegs.length, 'the unfinished day\'s legs are no part of the curve');
  assert.strictEqual(report.trend.champion.caught, finishedLegs.filter(id => id.includes('|long|') && DAYS.indexOf(id.slice(0, 10)) % 2 === 0).length);
  assert.ok(report.trend.champion.windows > report.trend.champion.sessions, 'the unfinished windows counted, not curved');
  // Its first tries: the finished windows' only (one a side a day in the stub world).
  assert.strictEqual(report.trend.champion.firstTry.points, (ROUND1.confirm.days.length - 1) * 2);
  // Pairing: on each probe day the champion's run and the edit's step the same windows.
  const edit = report.probes[0].id;
  for (const day of ROUND1.probe.days) {
    const of = side => w.calls.trendData.find(c => c.run.startsWith(`l1-${side}`) && c.legs.some(id => id.startsWith(day)));
    assert.deepStrictEqual(of(`p-${edit}-t`).windows, of('pc-t').windows, day);
  }
  // Each run's loop role, set by the loop: the trend runs trend-set, the curated probe runs none (they need their
  // practice mode and curated list as any stage-1 run); the keep rule's runs: the trend set's test above.
  const roleOf = re => [...new Set(w.calls.preflight.filter(p => re.test(p.runId)).map(p => p.loopRole))];
  assert.deepStrictEqual(roleOf(TREND_RUN), ['trend-set']);
  assert.deepStrictEqual(roleOf(/-[pq]\d+$/), [null]);
  // The round's reactions: inside the runner's sessions only (the 21:00Z ones, after 15:50 New York time, never).
  const reactions = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'trend-reactions.json'), 'utf8'));
  assert.ok(reactions.length > 0 && reactions.every(r => r.bar.endsWith('T14:33:00.000Z')));
});

test('a day whose legs have no window is never run, and the report and the log say so; never a silent skip', async () => {
  const w = world({ trend: true, proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- TREND → enter on the pullback', 'more legs')] });
  // The first probe day's legs after the runner's session (16:30 New York time): no decision time in their windows.
  const day = ROUND1.probe.days[0];
  const spans = { ...w.loop.probe.trend.set.spans };
  for (const side of ['long', 'short']) spans[legId(day, side)] = { ...spans[legId(day, side)], start: `${day}T21:30:00.000Z`, end: `${day}T21:51:00.000Z` };
  w.loop.probe.trend.set = { ...w.loop.probe.trend.set, spans };
  const lines = [];
  await run(w, { log: m => lines.push(m) });
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  assert.deepStrictEqual(report.trend.windows.probe.noWindows, [day]);
  assert.deepStrictEqual(report.trend.windows.probe.dropped.filter(d => d.id.startsWith(day)).map(d => d.why), ['no decision time of the runner\'s sessions (outside them, or an exchange holiday)', 'no decision time of the runner\'s sessions (outside them, or an exchange holiday)']);
  assert.deepStrictEqual([report.trend.windows.confirm.noWindows, report.trend.windows.regression.noWindows], [[], []]);
  assert.ok(lines.some(l => l.includes(`trend probe: no windows on ${day} (never run)`)), lines.join('\n'));
  assert.ok(!w.calls.runs.some(r => TREND_RUN.test(r.runId) && dayOfRun(r.runId) === day), 'never run');
});

// --- the trend curriculum (curriculum.js): the trend set only ----------------------------------------------------------

const CURATED_RUN = /-[pq]\d+$/;
const trendCurriculum = () => [
  tagged('a', 'F1', 'rule', '- line one', '- line one\n- TREND → enter on the pullback', 'more legs'),
  tagged('a', 'F2', 'rule', '- line three', '- line three\n- GOOD → read it', 'fewer misreads'),
];

test('curriculum trend: a round runs no curated replay; findings and screens from the trend set only; the keep rule unchanged', async () => {
  const w = world({ trend: true, curriculum: 'trend', proposals: trendCurriculum() });
  await run(w);
  const dir = w.paths.iter(1);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'probe-report.json'), 'utf8'));
  // The stub replayer's calls: no curated half written, no curated run (a -p/-q half or a practice config) on any side.
  assert.deepStrictEqual(w.calls.halves, [], 'no curated half is written');
  assert.deepStrictEqual(w.calls.runs.filter(r => CURATED_RUN.test(r.runId) || r.practice), [], 'no curated replay');
  assert.ok(w.calls.runs.filter(r => TREND_RUN.test(r.runId)).length > 0);
  // Every run is a trend run or a keep-rule run (the champion's and the challenger's tuning windows).
  assert.deepStrictEqual(w.calls.runs.filter(r => !TREND_RUN.test(r.runId)).map(r => r.runId), ['l1-champion-t0', `l1-c-${report.composed.id}-t0`]);
  assert.strictEqual(report.curriculum, 'trend');
  assert.strictEqual(report.split, undefined, 'no curated split');
  assert.deepStrictEqual(Object.keys(report.cycles.champion), ['trend'], 'no curated cycles');
  // The findings: the trend set's, then the read findings from the trend probe half's own runs (never a regression day's).
  const probeDays = ROUND1.probe.days;
  assert.ok(w.calls.probeData.length && w.calls.probeData.every(x => TREND_RUN.test(x.runDir) && dayOfRun(x.runDir) !== REG_DAY), JSON.stringify(w.calls.probeData));
  assert.deepStrictEqual([...new Set(w.calls.probeData.filter(x => x.runDir.startsWith('l1-pc-')).map(x => dayOfRun(x.runDir)))].sort(), [...probeDays, ...ROUND1.confirm.days].sort(), 'the champion: its probe half (findings) and confirm half (the combined change)');
  const missed = ROUND1.probe.legs.filter(id => !(id.includes('|long|') && DAYS.indexOf(id.slice(0, 10)) % 2 === 0)).length;
  // Each probe day steps its 4 moments; the champion misreads every other one (and refuses for a false reason there).
  const moments = probeDays.length * 4;
  assert.deepStrictEqual(report.findings.map(f => [f.kind, f.count]), [['trend-blocker', missed], ['misread', moments / 2], ['wrong-reason refusal', moments / 2]]);
  // The screens: the trend edit on the probe half's legs; the read edit on the trend runs' decisions (not the curated 28).
  assert.deepStrictEqual(report.probes.map(p => [p.verdict, p.target.pairs]), [['helped', ROUND1.probe.legs.length], ['helped', moments]]);
  assert.ok(report.probes.every(p => p.trend && p.regression), 'the trend measures and the regression days on every edit');
  for (const p of report.probes) assert.deepStrictEqual([...new Set(w.calls.runs.filter(r => r.runId.startsWith(`l1-p-${p.id}-`)).map(r => dayOfRun(r.runId)))].sort(), [...probeDays, REG_DAY].sort(), p.id);
  // The combined change: on the trend confirm half (and the regression day) only.
  assert.deepStrictEqual(w.calls.runs.filter(r => r.runId.startsWith(`l1-k-${report.composed.id}-`)).map(r => dayOfRun(r.runId)).sort(), [...ROUND1.confirm.days, REG_DAY].sort());
  assert.strictEqual(report.composed.verdict, 'helped');
  // The keep rule: invoked once, as ever: the loop's model scoring on its tuning windows' full-day runs, the champion's and the challenger's.
  assert.strictEqual(w.calls.verifier.length, 1);
  const v = w.calls.verifier[0];
  assert.deepStrictEqual([v.cfg, v.seed, v.heldOut, v.rule], [w.loop.modelScore, w.loop.seed, false, w.loop.rule]);
  assert.deepStrictEqual(v.pairs.map(x => [x.label, path.basename(x.champion.runDir), path.basename(x.candidate.runDir)]), [[`${TUNING[0].from}..${TUNING[0].to}`, 'l1-champion-t0', `l1-c-${report.composed.id}-t0`]]);
  const [e] = readArchive(w.paths.archive);
  assert.deepStrictEqual([e.verdict, e.source], ['kept', 'propose-probe-compose']);
  // The lessons: practice-train, the round's trend days (never curated windows).
  const lessons = LS.readLessons(path.join(w.paths.dir, LS.FILE));
  const days = [...new Set([...probeDays, ...ROUND1.confirm.days, REG_DAY])].sort();
  assert.deepStrictEqual(lessons.filter(l => typeof l.keep !== 'string').map(l => l.windows), Array(3).fill(TS.dayWindows(days)));
  assert.ok(lessons.every(l => LS.practiceOnly(l.windows)));
  // The probe look: the trend pool alone.
  assert.deepStrictEqual(S.readLedger(w.paths.ledger).filter(l => l.candidate === 'l1/probe').map(l => l.what), ['training loop: probes of skill and role edits on the trend set\'s sessions (curriculum trend)']);
  // Resumed: nothing re-runs.
  const runs = w.calls.runs.length;
  await run(w);
  assert.strictEqual(w.calls.runs.length, runs);
});

test('curriculum trend: a read finding under minPairs of the trend runs\' judged decisions is left out; at minPairs it is kept', async () => {
  // claimed: the moments before it carry the read; the probe days' first two (8 moments) or three (12).
  const probeDays = [...ROUND1.probe.days].sort();
  const round = async k => {
    const w = world({ trend: true, curriculum: 'trend', claimed: DAYS.indexOf(probeDays[k - 1]) * 4 + 4, proposals: [] });
    await run(w);
    return JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  };
  const two = await round(2);
  assert.ok(SC.SCREEN.minPairs > 8 && SC.SCREEN.minPairs <= 12, 'the fixture straddles minPairs');
  assert.deepStrictEqual(two.readFindingsOmitted.map(x => [x.skill, x.kind, x.judged]), [['a', 'misread', 8]]);
  assert.ok(!two.findings.some(f => f.kind === 'misread'));
  const three = await round(3);
  assert.strictEqual(three.readFindingsOmitted, undefined);
  assert.deepStrictEqual(three.findings.filter(f => f.kind === 'misread').map(f => f.count), [6]);
});

test('curriculum all (the default, or said): today\'s round, unchanged: the curated windows and the trend set', async () => {
  const runOf = async curriculum => {
    const w = world({ trend: true, curriculum, proposals: trendCurriculum() });
    await run(w);
    return { w, report: JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8')), rec: JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'iteration-report.json'), 'utf8')) };
  };
  const a = await runOf(undefined);
  const b = await runOf('all');
  assert.deepStrictEqual(b.report, a.report, 'the same report');
  assert.deepStrictEqual(b.rec, a.rec);
  assert.deepStrictEqual(b.w.calls.runs, a.w.calls.runs, 'the same runs, in the same order');
  assert.deepStrictEqual([b.w.calls.halves, b.w.calls.probeData], [a.w.calls.halves, a.w.calls.probeData]);
  // Today's round: both curated halves written, the curated runs replayed, the curated split and cycles reported.
  assert.deepStrictEqual(a.w.calls.halves, ['probe', 'confirm']);
  assert.deepStrictEqual(a.w.calls.runs.filter(r => CURATED_RUN.test(r.runId)).map(r => r.runId).sort(), ['l1-pc-p0', 'l1-pc-q0', ...a.report.probes.map(p => `l1-p-${p.id}-p0`), `l1-k-${a.report.composed.id}-q0`].sort());
  assert.ok(a.w.calls.probeData.every(x => CURATED_RUN.test(x.runDir)), 'read data from the curated runs only');
  assert.strictEqual(a.report.curriculum, undefined);
  assert.deepStrictEqual([a.report.split.seed, Object.keys(a.report.cycles.champion).sort()], [3, ['confirm', 'probe', 'trend']]);
  // The read edit judged on the curated probe half's 28 decisions, as before.
  assert.deepStrictEqual(a.report.probes.map(p => p.target.pairs), [ROUND1.probe.legs.length, 28]);
  assert.strictEqual(a.rec.mastery.curriculum, 'all');
});

test('the round report: the mastery read (legs caught, R caught / available, control false starts, blows) for status', async () => {
  const w = world({ trend: true, curriculum: 'trend', proposals: trendCurriculum() });
  await run(w);
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  const rec = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'iteration-report.json'), 'utf8'));
  const c = report.trend.champion;
  assert.deepStrictEqual([c.blows, Object.keys(c.controls).sort()], [0, ['entries', 'falseStarts', 'share', 'unknown', 'windows']]);
  const m = rec.mastery.champion;
  assert.deepStrictEqual([m.legs, m.caught, m.caughtShare, m.rCaught, m.rAvailable, m.floorBreaches, m.keepRuleBlows], [c.ride.legs, c.ride.caught, c.ride.catchRate, c.ride.rCaught, c.ride.rAvailable, 0, null]);
  assert.strictEqual(m.rShare, Math.round((c.ride.rCaught / c.ride.rAvailable) * 10000) / 10000);
  assert.deepStrictEqual(m.controls, c.controls);
  // The stub keep rule scores no window: its combine blows unknown (n/a), never the trend runs' floor breaches.
  assert.deepStrictEqual([rec.mastery.composed.id, rec.mastery.composed.kept, rec.mastery.composed.keepRuleBlows, rec.mastery.composed.floorBreaches], [report.composed.id, true, null, 0]);
  assert.strictEqual(rec.mastery.composed.combinePass, null, 'the stub keep rule scores no window');
  assert.deepStrictEqual(rec.mastery.composed.controls, report.composed.trend.controls);
  const lines = IR.masteryLines(rec);
  assert.strictEqual(lines[0], '  Mastery read (iteration 1, curriculum trend, confirm half: held-out trend legs):');
  assert.match(lines[1], /^ {4}champion: legs caught \d+(\.\d+)?% \(\d+ of \d+\), R caught \/ available [\d.]+% \([\d.-]+ \/ [\d.]+\), control false starts .*, combine pass rate n\/a \(not judged by the keep rule\), keep rule's combine blows n\/a \(not judged by the keep rule\), floor breaches in the trend runs 0$/);
  assert.match(lines[2], new RegExp(`^ {4}combined ${report.composed.id} \\(kept\\): legs caught 100% `));
  assert.deepStrictEqual(IR.masteryLines({ ...rec, mastery: null }), []);
});

test('the round report: risk and return on the trend confirm half\'s trades and the keep rule\'s runs, per trade', async () => {
  const RS = require('../../scripts/lib/train/risk-stats');
  for (const curriculum of ['trend', 'all']) {
    const w = world({ trend: true, curriculum, proposals: trendCurriculum(), trades: true });
    await run(w);
    const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
    const rec = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'iteration-report.json'), 'utf8'));
    // The side's trend confirm half: its runs' scored decisions (one run a confirm day), never the probe half's days.
    const files = side => fs.readdirSync(w.paths.dir).filter(f => f.startsWith(`${side}-t`) && f.endsWith('-decisions.json') && report.trend.confirm.days.some(d => f.startsWith(`${side}-t${d.replace(/-/g, '')}.`))).sort();
    const tradesOf = side => RS.tradesOf(files(side).flatMap(f => JSON.parse(fs.readFileSync(path.join(w.paths.dir, f), 'utf8'))));
    assert.ok(files('pc').length >= 1, curriculum);
    assert.deepStrictEqual(report.trend.champion.trades, tradesOf('pc'), curriculum);
    assert.deepStrictEqual(report.composed.trend.trades, tradesOf(`k-${report.composed.id}`), curriculum);
    const r = rec.mastery.risk;
    assert.ok(r.champion.trend.n > 0 && r.champion.trend.n === report.trend.champion.trades.length, curriculum);
    // Two trades of every four moments, +2R then -1R: the champion's expectancy 0.5R, win rate 50%, payoff 2; the
    // combined change's (k- runs) +3R then -1R: 1R, payoff 3. Each side read from its own runs, never the other's.
    assert.deepStrictEqual([r.champion.trend.expectancy, r.champion.trend.winRate, r.champion.trend.payoff, r.champion.trend.profitFactor], [0.5, 0.5, 2, 2], curriculum);
    assert.deepStrictEqual([r.composed.trend.expectancy, r.composed.trend.payoff, r.composed.trend.profitFactor], [1, 3, 3], curriculum);
    assert.notDeepStrictEqual(report.composed.trend.trades, report.trend.champion.trades);
    assert.deepStrictEqual(r.champion.trend, RS.riskStats(report.trend.champion.trades));
    assert.deepStrictEqual(r.composed.trend, RS.riskStats(report.composed.trend.trades));
    // The stub keep rule judged the combined change: the keep rule's runs (the tuning windows) read, each side its own.
    const keep = side => RS.riskStats(RS.tradesOf(JSON.parse(fs.readFileSync(path.join(w.paths.dir, `${side}-t-decisions.json`), 'utf8'))));
    assert.strictEqual(r.judged, true);
    assert.deepStrictEqual(r.champion.keepRule, keep('champion'));
    assert.deepStrictEqual(r.composed.keepRule, keep(`c-${report.composed.id}`));
    assert.ok(r.composed.keepRule.n > 0);
    // The keep rule's runs: the champion's +2R, the challenger's (its c- file) +3R.
    assert.deepStrictEqual([r.champion.keepRule.payoff, r.composed.keepRule.payoff], [2, 3], curriculum);
    assert.notDeepStrictEqual(r.composed.keepRule, r.champion.keepRule);
    const lines = IR.masteryLines(rec);
    assert.ok(lines.includes(`    combined ${report.composed.id}, keep rule's runs: ${RS.riskText(r.composed.keepRule)}`), curriculum);
    assert.ok(lines.every(l => !/Infinity|NaN/.test(l)));
  }
  // A scorecard without the trades' R (the stub's default): unknown, said so, never zero trades.
  const w = world({ trend: true, curriculum: 'trend', proposals: trendCurriculum() });
  await run(w);
  const rec = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'iteration-report.json'), 'utf8'));
  assert.deepStrictEqual([rec.mastery.risk.champion.trend, rec.mastery.risk.champion.keepRule], [null, null]);
  assert.match(IR.masteryLines(rec).find(l => l.startsWith('    champion, trend confirm half')), /: n\/a \(trades unknown\)$/);
});

test('curriculum trend: an exit edit\'s trades pair once, by their scored exits, never also by the same runs\' entered moments', async () => {
  let w = null;
  const exitEdit = () => {
    const f = w.calls.proposeProbes[0].findings.find(x => x.kind === 'exit-decision');
    return [{ tag: { skill: 'manage-position', finding: f.id, kind: 'rule' }, proposal: edit('- line one', '- line one\n- EXITFIX → hold the healthy pullback', { expects: 'fewer cut trends', edits: [{ file: MP, find: '- line one', replace: '- line one\n- EXITFIX → hold the healthy pullback' }] }) }];
  };
  w = world({ trend: true, exits: true, entered: true, curriculum: 'trend', proposals: exitEdit });
  await run(w);
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(1), 'probe-report.json'), 'utf8'));
  const [p] = report.probes;
  assert.strictEqual(p.target.measure, 'exit: R banked on the trades both sides opened');
  // The trend runs' read sides hold entered moments (4 a probe day) beside the scored exits (EXIT_TRADES a day): only the exits pair.
  const n = ROUND1.probe.days.length * EXIT_TRADES;
  assert.deepStrictEqual([p.target.pairs, p.target.b, p.target.c], [n, n, 0], JSON.stringify(p.target));
  assert.deepStrictEqual(p.target.unmatched, { champion: 0, probe: 0 });
  // The combined change, on the confirm half: its trades pair once too.
  assert.strictEqual(report.composed.measures.target.pairs, ROUND1.confirm.days.length * EXIT_TRADES, JSON.stringify(report.composed.measures.target));
});
