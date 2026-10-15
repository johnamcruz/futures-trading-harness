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
const PC = require('../../scripts/lib/train/probe-config');
const proposer = require('../../scripts/lib/train/proposer');
const { DECISION_RULE } = require('../../scripts/lib/train/paired');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILL = 'skills/a/SKILL.md';
const TEXT = '---\nname: a\ndescription: a test skill\n---\n\n# A\n\n- line one\n\n- line two\n\n- line three\n';
const TIMES = Array.from({ length: 20 }, (_, i) => new Date(Date.parse('2022-03-09T14:33:02.000Z') + i * 180000).toISOString());
const WINDOW = [{ from: '2022-03-09', to: '2022-03-10' }];

// --- the screen's sides, built from scripted decisions -------------------------------------------------------------

/** n decisions; state(i) -> 'right' | 'misread' | 'missed' for skill a; category(i); R(i). */
function side({ n = 20, state = () => 'right', category = () => 'right', R = () => 0, blow = () => false, other = () => true } = {}) {
  const decisions = [];
  const scorecard = [];
  for (let i = 0; i < n; i += 1) {
    const s = state(i);
    const reads = [{ step: 'zone', skill: 'b', read: 'x', check: other(i), agrees: true }];
    if (s !== 'missed') reads.push({ step: 'zone', skill: 'a', read: 'y', check: s === 'right', agrees: true });
    decisions.push({ root: 'MNQ', bar: TIMES[i], decision: R(i) === 0 ? 'passed' : 'entered', reads, outcome: { R: R(i) } });
    scorecard.push({ key: `${TIMES[i]}|MNQ`, category: category(i), blow: blow(i) });
  }
  return SC.sideOf({ decisions, scorecard, usage: [{ skill: 'a', used: 1, available: 2, reads: 3, correct: 1, missed: 1, relevant: 2 }] });
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
  assert.match(PE.tagErrors(null, ok, { findings: FINDINGS }).join(), /tag: \{ skill, finding, kind \}/);
  assert.match(PE.tagErrors({ skill: 'a', finding: 'F9', kind: 'rule' }, ok, { findings: FINDINGS }).join(), /tag.finding/);
  assert.match(PE.tagErrors({ skill: 'a', finding: 'F1', kind: 'rewrite' }, ok, { findings: FINDINGS }).join(), /tag.kind/);
  assert.match(PE.tagErrors({ skill: 'b', finding: 'F1', kind: 'rule' }, ok, { findings: FINDINGS }).join(), /finding F1 is about a, not b/);
  // An unattributed finding: any skill, still one skill's file.
  assert.match(PE.tagErrors({ skill: 'b', finding: 'F2', kind: 'rule' }, ok, { findings: FINDINGS }).join(), /one skill only, skills\/b\/SKILL\.md/);
  assert.match(PE.styleErrors(edit('- line one', '- wait 3 bars'), { root }).join(), /no numbers: the edit adds 3/);
  assert.deepStrictEqual(PE.styleErrors(edit('- line 2 of 2', '- line 2 of 2, reworded'), { root: tree(TEXT.replace('line two', 'line 2 of 2')) }), [], 'a number the text held is kept');
  assert.match(PE.styleErrors(edit('- line one', `- ${'x'.repeat(PE.MAX_LINE)}`), { root }).join(), /short condition -> action lines/);
  assert.match(PE.styleErrors(edit('- line one', '- line one, longer'), { root, kind: 'removal' }).join(), /a removal shrinks/);
  assert.match(PE.styleErrors(edit('- line one', `- line one\n${'- grow → more\n'.repeat(300)}`), { root }).join(), /over its cap \(3400\)/);
  // Already over the cap: may not grow, may shrink.
  const big = tree(`${TEXT}${'- filler line\n'.repeat(300)}`);
  assert.match(PE.styleErrors(edit('- line one', '- line one, grown'), { root: big }).join(), /already over 3400/);
  assert.deepStrictEqual(PE.styleErrors(edit('- line one\n', ''), { root: big, kind: 'removal' }), []);
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
// SOME fixes 6 of the 10 misreads only, BAD misreads everywhere; anything else is the champion's (every other decision wrong).
// REASON fixes the wrong reasons only; SOME and REASON together cancel (the champion's decisions).
const behaviour = text => (text.includes('BAD') ? 'bad' : text.includes('GOOD') ? 'good'
  : text.includes('SOME') && text.includes('REASON') ? 'champion' : text.includes('SOME') ? 'some' : text.includes('REASON') ? 'reason' : 'champion');
const stateOf = (b, i) => (b === 'bad' ? 'misread' : b === 'good' || i % 2 || (b === 'some' && i < 12) ? 'right' : 'misread');
const categoryOf = (b, i) => (b === 'bad' ? 'wrong-side entry' : b === 'good' || b === 'reason' || i % 2 ? 'right' : 'wrong stated reason');

function world({ proposals, verdict = 'kept', loop: over = {} } = {}) {
  const user = tmpDir();
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'home') };
  fs.mkdirSync(env.FTH_HOME);
  const trader = { harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3, account: '7' };
  const replay = { workDir: path.join(user, 'work'), broker: 'sim', premarket: false, autotrader: trader };
  const loop = resolveLoop({
    loopId: 'l1', replay, tuningWindows: WINDOW, proposer: trader, repeats: 1, seed: 3, maxFlagged: 6, controlPoints: 0, modelScore: MODEL,
    // The config's probe replay is a stage-1 curated practice config; the stub world runs the same replay without a list.
    probe: { replay: { ...replay, stage: 1, curatedList: { file: 'curated.json', list: 'mix' }, practice: { mode: 'setup-focus', setupTf: 15, quietSample: 0.15, seed: 7 } }, windows: WINDOW, k: 4, parallel: 2 },
    limits: { maxIterations: 1, maxModelCalls: 10000, maxWallMinutes: 30 }, ...over,
  });
  loop.probe = { ...loop.probe, replay: { ...replay, practice: { mode: 'setup-focus', setupTf: 15, quietSample: 0.15, seed: 7 } } };
  const calls = { proposeProbes: [], runs: [], probeData: [], verifier: [], branches: [], propose: 0 };
  const textOf = dir => fs.readFileSync(path.join(dir, SKILL), 'utf8');
  const steps = {
    preflight: () => ({ ok: true, results: [], record: () => null }),
    makeTree: dir => { fs.mkdirSync(path.join(dir, 'skills', 'a'), { recursive: true }); fs.writeFileSync(path.join(dir, SKILL), TEXT); fs.mkdirSync(path.join(dir, 'workspace')); return 'c0ffee'; },
    prepareTree: (dir, { proposal }) => { if (proposal) require('../../scripts/lib/train/proposal').applyProposal(proposal, dir); },
    seedRunHome: run => {
      for (const d of [run.paths.runDir, run.paths.workspace, run.paths.bars]) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(run.paths.runHome, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: ['x'], replay: true, journalEnv: 'SIM_JOURNAL', env: [] } } }));
    },
    runReplay: async ({ run, root, deps }) => {
      calls.runs.push({ runId: run.runId, start: run.start.toISOString(), end: run.end.toISOString(), practice: run.practice || null, tree: path.basename(root) });
      const manifest = store.openRun(run.paths, { runId: run.runId, hash: 'h' });
      const done = store.recordedTimes(run.paths.runDir);
      const todo = TIMES.filter(t => !done.has(t));
      for (const t of todo) {
        fs.writeFileSync(run.paths.clockFile, JSON.stringify({ now: t }));
        const res = await deps.step({ t: new Date(t), kind: 'trade', day: '2022-03-09' }, {}, 1000);
        store.appendRecord(run.paths, manifest, { t, day: '2022-03-09', kind: 'trade', ran: store.parseStep(res.output).ran });
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
      return { key: `${l.t}|MNQ`, t: l.t, barT: l.t, day: l.day, symbol: 'MNQ', category: categoryOf(l.ran[0].result, i), actual: { action: 'none' }, falseReasons: [], inTrade: false, blow: false };
    }),
    probeData: ({ runDir, tree: dir }) => {
      calls.probeData.push({ runDir: path.basename(runDir), tree: path.basename(dir) });
      const b = behaviour(textOf(dir));
      const decisions = TIMES.map((t, i) => ({ root: 'MNQ', bar: t, decision: 'passed', outcome: { R: 0 }, reads: [{ step: 'zone', skill: 'a', read: 'y', check: stateOf(b, i) === 'right', agrees: true }] }));
      const wrong = decisions.filter(d => !d.reads[0].check).length;
      return { decisions, usage: { skills: [{ skill: 'a', reads: 20, correct: 20 - wrong, wrong, available: 20, used: 20, relevant: 20, missed: 0, topRefusals: wrong ? [{ what: 'false: y', count: wrong }] : [], topMissed: [] }] }, records: [] };
    },
    proposeProbes: async opts => { calls.proposeProbes.push(opts); return { proposals: proposals.map(p => ({ ...p })) }; },
    propose: async () => { calls.propose += 1; return { proposals: [] }; },
    evaluator: async () => ({ available: false, why: 'stub' }),
    modelVerifier: opts => { calls.verifier.push(opts); return { available: true, verdict, reasons: [`model ${verdict}`], windows: [] }; },
    writeBranch: opts => { calls.branches.push(opts); return 'deadbeef'.repeat(5); },
  };
  return { user, env, loop, steps, calls, paths: S.loopPaths(env, 'l1') };
}

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
  // Every probe replayed the same moments with the same replay config as the champion's probe run.
  const probeRuns = w.calls.runs.filter(r => r.runId.endsWith('-p0'));
  assert.strictEqual(probeRuns.length, 1 + 4 + 1, 'the champion, four probes, one combined change');
  assert.deepStrictEqual([...new Set(probeRuns.map(r => `${r.start}..${r.end}|${JSON.stringify(r.practice)}`))], [`${probeRuns[0].start}..${probeRuns[0].end}|${JSON.stringify(probeRuns[0].practice)}`]);
  assert.strictEqual(probeRuns[0].practice.seed, 7, 'the probe config\'s seed, on every side');
  // The keep rule's runs are the loop's own full-day replay config, never the probes'.
  assert.ok(w.calls.runs.filter(r => r.runId.endsWith('-t0')).every(r => r.practice === null));
  assert.strictEqual(probeRuns[0].tree, 'champion');
  assert.deepStrictEqual(probeRuns.slice(1, 5).map(r => r.runId).sort(), report.probes.map(p => `l1-p-${p.id}-p0`).sort());
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
  // The lessons record: one line per probe and one for the combined change, practice-train windows only.
  const lessons = LS.readLessons(path.join(w.paths.dir, LS.FILE));
  assert.deepStrictEqual(lessons.map(l => [l.verdict, l.composed === true]), [['helped', false], ['helped', false], ['hurt', false], ['no effect', false], ['helped', true]]);
  assert.ok(lessons.every(l => LS.practiceOnly(l.windows) && l.n === 20));
  // The probe look: logged once, tuning, practice-train (no budget).
  assert.deepStrictEqual(S.readLedger(w.paths.ledger).filter(l => l.candidate === 'l1/probe').map(l => l.purpose), ['tuning']);
  // Resumed: nothing re-runs, nothing is written twice.
  const runs = w.calls.runs.length;
  await run(w);
  assert.strictEqual(w.calls.runs.length, runs);
  assert.strictEqual(LS.readLessons(path.join(w.paths.dir, LS.FILE)).length, 5);
});

test('the combined change still needs the full keep rule: a screen pass with a rejected or inconclusive keep rule is never kept', async () => {
  for (const verdict of ['rejected', 'inconclusive']) {
    const w = world({ proposals: [tagged('a', 'F1', 'rule', '- line one', '- line one\n- GOOD → read it')], verdict });
    await run(w, { dryRun: false });
    const [e] = readArchive(w.paths.archive);
    assert.strictEqual(e.verdict, verdict);
    assert.strictEqual(w.calls.branches.length, 0);
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

test('nothing passes the screen: no proposal reaches the keep rule; the next round\'s proposer reads the lessons, never held-out data', async () => {
  const w = world({ proposals: [tagged('a', 'F1', 'example', '- line two', '- line two\n- BAD → no read', 'harm')], loop: { limits: { maxIterations: 2, maxModelCalls: 10000, maxWallMinutes: 30 } } });
  await run(w);
  assert.strictEqual(w.calls.verifier.length, 0);
  assert.deepStrictEqual(readArchive(w.paths.archive), []);
  assert.strictEqual(w.calls.proposeProbes.length, 2);
  const second = w.calls.proposeProbes[1].lessons;
  assert.match(second, /^Evidence only, from practice-train probes/);
  assert.match(second, /- a, example \(misread\): helped 0 of 1, no effect 0, hurt 1 \(n per probe: 20\)/);
  // The same edit again is not re-probed.
  const report = JSON.parse(fs.readFileSync(path.join(w.paths.iter(2), 'probe-report.json'), 'utf8'));
  assert.deepStrictEqual(report.edits.map(x => x.probedBefore), [true]);
  assert.strictEqual(report.probes.length, 0);
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
  assert.deepStrictEqual(PC.resolveProbe(ok, { read, modelScore: MODEL }), { replay, windows: WINDOW, k: 4, parallel: 1 });
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
  const raw = over => ({ loopId: 'l1', replay: base.replay, proposer: base.proposer, tuningWindows: WINDOW, modelScore: MODEL, probe: ok, ...over });
  assert.notStrictEqual(resolveLoop(raw()).hash, resolveLoop({ ...raw(), probe: undefined }).hash);
  assert.throws(() => resolveLoop(raw({ modelScore: undefined })), /set modelScore/);
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
