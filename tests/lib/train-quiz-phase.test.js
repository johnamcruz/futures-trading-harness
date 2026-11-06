'use strict';

// The quiz gate in the probe round (scripts/lib/train/quiz-phase.js; docs/TRAINING.md, the probe round): between an
// edit's checks and its replay, its tree is quizzed. Its own question red/green first (the champion fails it, the edit
// passes it), then the whole quiz against the champion's (train/quiz-gate.js decide), a confirm run on fresh runs when
// a question is flagged, a short summary retried once and then blocked (fail closed). Only a pass goes on to the probe
// replay. Fakes only: the quiz's runner with an injected ask (never a model), and the trees' prompts.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const Q = require('../../scripts/lib/eval/context-quiz');
const QR = require('../../scripts/lib/eval/quiz-run');
const QP = require('../../scripts/lib/train/quiz-phase');
const PQ = require('../../scripts/lib/train/probe-question');
const P = require('../../scripts/lib/train/proposal');
const LS = require('../../scripts/lib/train/lessons');
const { phase } = require('../../scripts/lib/train/loop');

const BASE = Q.loadQuiz().value;
const ask3 = id => ({ id, layer: 'entry', prompt: 'head', text: `Question ${id}?`, rule: 'r', anchor: `anchor ${id}`, required: ['\\byes\\b'], forbidden: ['\\bno\\b'] });
// A small quiz of the file's own settings (its gate, its answer format): three questions on the head prompt.
const QUIZ = { ...BASE, k: 3, questions: ['a1', 'a2', 'a3'].map(ask3), partB: [] };
const HASH = 'quiz-hash-1';
const G = QUIZ.gate;
const SKILL = 'skills/a/SKILL.md';
const TEXT = '---\nname: a\ndescription: a test skill\n---\n\n# A\n\n- line one\n\n- line two\n';
const WINDOW = [{ from: '2022-03-07', to: '2022-03-19' }];

/** A tree holding skill a. */
function tree(text = TEXT) {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'skills', 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, SKILL), text);
  return dir;
}
/** The prompts a tree gives every question asked of it: its skill's text (a stand-in for the head prompt). */
const prompts = (root, quiz) => Object.fromEntries(['head', 'head+risk', ...[...quiz.questions, ...quiz.partB].map(Q.promptKey)].map(k => [k, fs.readFileSync(path.join(root, SKILL), 'utf8')]));

/**
 * The quiz's real runner with a fake ask: a question is answered right unless the prompt holds BREAKS-<id> (the edit
 * broke it) or, for an edit's own question (e-...), unless the prompt holds its anchor. script(ctx) may override:
 * return { stdout } or { error }.
 */
function fakeRun(script = () => null) {
  const calls = [];
  const asks = [];
  const run = opts => {
    calls.push({ root: opts.root, dir: path.basename(opts.dir), k: opts.k, only: opts.only, ids: [...opts.quiz.questions, ...opts.quiz.partB].map(q => q.id) });
    return QR.runQuiz({
      ...opts,
      cfg: { harness: 'custom', command: ['ask', '{system}', '{prompt}'] },
      ask: async (argv, o) => {
        const system = fs.readFileSync(o.systemFile, 'utf8');
        const q = opts.quiz.questions.find(x => x.id === o.id);
        const nth = asks.filter(a => a.dir === path.basename(opts.dir) && a.id === o.id && a.run === o.run).length + 1;
        asks.push({ dir: path.basename(opts.dir), id: o.id, run: o.run });
        const said = script({ dir: path.basename(opts.dir), id: o.id, run: o.run, nth, system });
        if (said) return said;
        const right = o.id.startsWith('e-') ? system.includes(q.anchor) : !system.includes(`BREAKS-${o.id}`);
        return { stdout: right ? 'ANSWER: yes, the line' : 'ANSWER: no' };
      },
    });
  };
  return { run, calls, asks };
}

const QUESTION = { layer: 'entry', prompt: 'head', text: 'Does the sweep wait?', rule: 'a sweep closing back inside waits', anchor: 'GOOD → wait for the retest', required: ['\\bline\\b'], forbidden: ['\\bno\\b'] };
const proposal = replace => ({ targets: ['wrong stated reason'], expects: 'fewer early entries', edits: [{ file: SKILL, find: '- line one', replace }] });

/** One edit's gate, its champion's summary run (as quizRound memoizes it) in the same work directory. */
async function gate({ replace = '- line one\n- GOOD → wait for the retest', find = '- line one', question = QUESTION, script, championText = TEXT, consolidation = false } = {}) {
  const champ = tree(championText);
  const edited = tree(championText.replace(find, replace));
  const dir = tmpDir();
  const f = fakeRun(script);
  let memo = null;
  const champion = async ({ retry = false } = {}) => (memo && !retry ? memo : (memo = await f.run({ root: champ, quiz: QUIZ, hash: HASH, k: QUIZ.k, dir: path.join(dir, 'champion'), prompts: prompts(champ, QUIZ) })));
  const id = P.proposalId(proposal(replace));
  const r = await QP.gateEdit({ quiz: QUIZ, hash: HASH, question: consolidation ? null : PQ.questionOf(question, id), consolidation, championRoot: champ, editRoot: edited, dir: path.join(dir, 'edit'), run: f.run, prompts, champion });
  return { r, f };
}

test('a good edit: its question red on the champion, green on the edit, no regression: pass; no confirm run', async () => {
  const { r, f } = await gate();
  assert.strictEqual(r.verdict, 'pass', r.why);
  assert.deepStrictEqual(r.redGreen, { champion: `0/${G.questionRuns}`, edit: `${G.questionRuns}/${G.questionRuns}`, red: true, green: true });
  // Red/green first (its own question alone, questionRuns a side), then the whole quiz: the champion's and the edit's.
  assert.deepStrictEqual(f.calls.map(c => [c.dir, c.k, c.ids.length]), [['red', G.questionRuns, 1], ['green', G.questionRuns, 1], ['champion', QUIZ.k, 3], ['edit', QUIZ.k, 3]]);
  // The edit's own asks: its question on both trees and the whole quiz on its tree (the champion's whole quiz is the round's).
  assert.strictEqual(r.asked, 2 * G.questionRuns + 3 * QUIZ.k);
  assert.deepStrictEqual([r.regressions, r.flagged], [[], []]);
});

test('a regressing edit: a question it breaks is flagged, confirmed on fresh runs of both trees alone, then rejected', async () => {
  const { r, f } = await gate({ replace: '- line one\n- GOOD → wait for the retest BREAKS-a2' });
  assert.strictEqual(r.verdict, 'reject', r.why);
  assert.deepStrictEqual(r.regressions.map(x => [x.id, x.from, x.to]), [['a2', `${QUIZ.k + G.confirmRuns}/${QUIZ.k + G.confirmRuns}`, `0/${QUIZ.k + G.confirmRuns}`]]);
  assert.deepStrictEqual(r.flagged.map(x => x.id), ['a2']);
  // The confirm runs: their own directories (never the first runs reused), the flagged ids only, confirmRuns each.
  const confirm = f.calls.filter(c => c.dir.startsWith('confirm'));
  assert.deepStrictEqual(confirm.map(c => [c.dir, c.k, c.only]), [['confirm-champion', G.confirmRuns, ['a2']], ['confirm-edit', G.confirmRuns, ['a2']]]);
  assert.match(r.why, /^regressed: a2/);
});

test('a flagged question that does not confirm is noise: the edit passes (the confirm runs alone decide)', async () => {
  // The edit's first three runs of a1 come out wrong by chance; its confirm runs answer it right.
  const { r, f } = await gate({ script: ({ dir, id }) => (dir === 'edit' && id === 'a1' ? { stdout: 'ANSWER: no' } : null) });
  assert.strictEqual(r.verdict, 'pass', r.why);
  assert.deepStrictEqual(f.calls.filter(c => c.dir.startsWith('confirm')).map(c => c.only), [['a1'], ['a1']]);
  assert.deepStrictEqual(r.flagged.map(x => x.id), ['a1']);
  assert.deepStrictEqual(r.regressions, []);
});

test('inconclusive: a run that keeps failing is retried once, then the edit is BLOCKED (fail closed), never passed', async () => {
  // The harness fails every ask of a3 on the edit: re-asked by the runner, retried once by the gate, still short.
  const { r, f } = await gate({ script: ({ dir, id }) => (dir === 'edit' && id === 'a3' ? { error: new Error('spawn x ENOENT') } : null) });
  assert.strictEqual(r.verdict, 'blocked');
  assert.match(r.why, /^inconclusive after one retry: .*a3/);
  assert.deepStrictEqual(f.calls.filter(c => c.dir === 'edit').length, 2, 'the edit\'s quiz asked again once');
  assert.deepStrictEqual(f.calls.filter(c => c.dir === 'champion').length, 2, 'and the champion\'s (only its missing runs: none)');
  // A failure that clears on the retry: the edit is judged as usual.
  const ok = await gate({ script: ({ dir, id, nth }) => (dir === 'edit' && id === 'a3' && nth <= 2 ? { error: new Error('busy') } : null) });
  assert.strictEqual(ok.r.verdict, 'pass', ok.r.why);
});

test('red/green: the champion already answers the question, or the edit does not teach it: blocked before the whole quiz', async () => {
  // The champion's prompt holds the anchor's answer (it answers right anyway): not red.
  const red = await gate({ script: ({ dir, id }) => (dir === 'red' && id.startsWith('e-') ? { stdout: 'ANSWER: yes, the line' } : null) });
  assert.deepStrictEqual([red.r.verdict, red.r.why], ['blocked', 'the champion already answers the question: no edit is needed or the question is too easy']);
  assert.ok(!red.f.calls.some(c => c.dir === 'edit' || c.dir === 'champion'), 'no regression quiz is run');
  const green = await gate({ script: ({ dir, id }) => (dir === 'green' && id.startsWith('e-') ? { stdout: 'ANSWER: no' } : null) });
  assert.deepStrictEqual([green.r.verdict, green.r.why], ['blocked', 'the edit does not teach its own question']);
  // At the shares: redMaxShare of the champion's runs right is still red; under greenMinShare of the edit's is not green.
  const n = G.questionRuns;
  const atRed = Math.floor(G.redMaxShare * n);
  const edge = await gate({ script: ({ dir, id, run }) => (dir === 'red' && id.startsWith('e-') && run <= atRed ? { stdout: 'ANSWER: yes, the line' } : null) });
  assert.strictEqual(edge.r.verdict, 'pass', edge.r.why);
  const under = Math.ceil(G.greenMinShare * n) - 1;
  const weak = await gate({ script: ({ dir, id, run }) => (dir === 'green' && id.startsWith('e-') && run > under ? { stdout: 'ANSWER: no' } : null) });
  assert.strictEqual(weak.r.verdict, 'blocked');
  // Short on its own question (every ask fails): retried once, then blocked as inconclusive.
  const short = await gate({ script: ({ dir }) => (dir === 'green' ? { error: new Error('down') } : null) });
  assert.match(short.r.why, /^inconclusive after one retry: the edit's question/);
  assert.strictEqual(short.f.calls.filter(c => c.dir === 'green').length, 2);
});

test('the question\'s anchor: in the edited tree\'s prompt and not the champion\'s, checked before any quiz call', async () => {
  const missing = await gate({ question: { ...QUESTION, anchor: 'never written anywhere' } });
  assert.strictEqual(missing.r.verdict, 'blocked');
  assert.match(missing.r.why, /question\.anchor: not in the edited tree's head prompt/);
  assert.deepStrictEqual(missing.f.calls, [], 'no model call');
  const known = await gate({ question: { ...QUESTION, anchor: 'line two' } });
  assert.match(known.r.why, /the champion's head prompt already states it/);
  assert.deepStrictEqual(known.f.calls, []);
  const numbered = await gate({ question: { ...QUESTION, text: 'Wait three bars?' } });
  assert.match(numbered.r.why, /no numbers: it adds three/);
});

// --- quizRound: the round's phases (probe.js calls it between the edits' checks and their replays) ---------------

function round({ gateOn = true, script, edits: given, cfg = { harness: 'custom', command: ['ask', '{system}', '{prompt}'] } } = {}) {
  const loopDir = tmpDir();
  const champion = { dir: tree(), baseCommit: 'c0ffee' };
  const f = fakeRun(script);
  const logs = [];
  const ctx = {
    state: { done: {} }, save() {}, checks: 0, log: m => logs.push(m), loop: { quizGate: gateOn }, paths: { dir: loopDir, iter: n => path.join(loopDir, `iter-${n}`) },
    steps: { quizRun: f.run, quizPrompts: prompts, loadQuiz: () => ({ value: QUIZ, hash: HASH }) },
  };
  ctx.check = () => { ctx.checks += 1; };
  const built = [];
  const api = {
    phase,
    candidateTree: async (_ctx, { id, proposal: p }) => { built.push(id); const dir = tree(); P.applyProposal(p, dir); return { dir, files: [SKILL] }; },
  };
  const edit = (replace, question = QUESTION, { kind = 'rule', find = '- line one' } = {}) => {
    const p = { ...proposal(replace), edits: [{ file: SKILL, find, replace }] };
    return { id: P.proposalId(p), tag: { skill: 'a', finding: 'F1', kind }, finding: { id: 'F1', kind: 'misread' }, proposal: p, question, errors: [] };
  };
  const edits = given || [edit('- line one\n- GOOD → wait for the retest'), edit('- line one\n- GOOD → wait for the retest BREAKS-a2')];
  const go = (n = 1, list = edits) => QP.quizRound(ctx, { n, champion, edits: list, api, work: path.join(loopDir, 'work'), dir: ctx.paths.iter(n), lessonsFile: path.join(loopDir, LS.FILE), lessonWindows: WINDOW, seed: 3, cfg });
  return { ctx, f, go, edits, edit, built, logs, loopDir, champion };
}

test('quizRound: only a pass goes on; the rest in the report and the lessons record, before any replay', async () => {
  const w = round();
  const { passed, report } = await w.go();
  assert.deepStrictEqual(passed.map(e => e.id), [w.edits[0].id]);
  assert.deepStrictEqual(Object.keys(report.edits), w.edits.map(e => e.id));
  const bad = report.edits[w.edits[1].id];
  assert.deepStrictEqual([bad.verdict, bad.regressions.map(x => x.id), bad.flagged.map(x => x.id)], ['reject', ['a2'], ['a2']]);
  assert.ok(['why', 'regressions', 'flagged', 'slips', 'gains', 'redGreen', 'asked'].every(k => k in bad), Object.keys(bad).join());
  assert.strictEqual(report.edits[w.edits[0].id].verdict, 'pass');
  assert.strictEqual(report.quizHash, HASH);
  // Each edit's tree is built for its quiz (the probe's id, so its replay builds the same tree).
  assert.deepStrictEqual(w.built, w.edits.map(e => `p-${e.id}`));
  // The champion's quiz once a round, whatever the edits.
  assert.strictEqual(w.f.calls.filter(c => c.dir.startsWith('champion-')).length, 1);
  // A rejected edit: one lessons line, evidence the next proposer reads (and it counts as probed before).
  const lines = LS.readLessons(path.join(w.loopDir, LS.FILE));
  assert.deepStrictEqual(lines.map(l => [l.proposalId, l.quiz, l.iteration]), [[w.edits[1].id, 'reject', 1]]);
  assert.match(LS.summarize(lines), /- a, rule \(misread\): stopped by the quiz gate before any replay: reject 1/);
  assert.ok(w.ctx.checks >= 3, 'the budget and the live-runner check before each tree\'s quiz');
});

test('quizRound: resumable; a crash after an edit\'s quiz never asks it again; a later round reuses the champion\'s quiz', async () => {
  const w = round();
  // The second edit's quiz dies mid-way: its first edit's phase is recorded.
  let die = true;
  const run = w.ctx.steps.quizRun;
  w.ctx.steps.quizRun = opts => { if (die && path.basename(opts.dir) === 'edit' && opts.root && fs.readFileSync(path.join(opts.root, SKILL), 'utf8').includes('BREAKS')) { die = false; throw new Error('killed'); } return run(opts); };
  await assert.rejects(w.go(), /killed/);
  assert.ok(w.ctx.state.done[`1:quiz:${w.edits[0].id}`]);
  const asked = w.f.asks.length;
  const { passed } = await w.go();
  assert.deepStrictEqual(passed.map(e => e.id), [w.edits[0].id]);
  assert.ok(!w.f.asks.slice(asked).some(a => a.dir === 'green' && a.id === `e-${w.edits[0].id}`), 'the first edit is never quizzed again');
  // Done: a resume asks nothing, writes no lessons line twice.
  const before = w.f.asks.length;
  await w.go();
  assert.strictEqual(w.f.asks.length, before);
  assert.strictEqual(LS.readLessons(path.join(w.loopDir, LS.FILE)).length, 1);
  // A later round, the same champion tree and quiz: its champion quiz is the cached directory's, asked nothing.
  const fresh = w.edit('- line two\n- GOOD → wait for the retest', { ...QUESTION });
  const at = w.f.asks.length;
  const r2 = await w.go(2, [fresh]);
  assert.deepStrictEqual(r2.passed.map(e => e.id), [fresh.id]);
  assert.ok(!w.f.asks.slice(at).some(a => a.dir.startsWith('champion-')), 'the champion\'s quiz is not asked again');
});

test('quizRound: an edit without a question (a round recorded before questions) is blocked, never quizzed or replayed', async () => {
  const w = round();
  const old = { ...w.edits[0], question: undefined };
  const { passed, report } = await w.go(1, [old]);
  assert.deepStrictEqual(passed, []);
  assert.match(report.edits[old.id].why, /^question: the quiz question the edit teaches/);
  assert.deepStrictEqual(w.built, []);
});

test('quizRound: a harness the quiz cannot ask is blocked with the reason and the off switch named; a broken prompt build blocks too', async () => {
  const w = round({ cfg: { harness: 'codex' } });
  const { passed, report } = await w.go();
  assert.deepStrictEqual(passed, []);
  for (const e of w.edits) assert.match(report.edits[e.id].why, /the quiz could not run: context quiz: the codex harness takes no system-prompt file.* \(the loop config's quizGate: false turns the gate off\)/);
  assert.deepStrictEqual([w.f.calls, w.built], [[], []], 'no tree built, no model asked');
  // A run that throws is a crash, never a verdict: the phase is not recorded, a resume runs it again.
  const c = round();
  c.ctx.steps.quizRun = () => { throw new Error('killed'); };
  await assert.rejects(c.go(), /killed/);
  assert.ok(!Object.keys(c.ctx.state.done).some(k => /^1:quiz:/.test(k)));
  const p = round();
  p.ctx.steps.quizPrompts = () => { throw new Error('no agents/risk-manager.md'); };
  const r = await p.go();
  assert.deepStrictEqual(r.passed, []);
  assert.match(r.report.edits[p.edits[0].id].why, /the prompts could not be built: no agents\/risk-manager\.md/);
});

test('quizRound with the gate off (the loop config\'s quizGate: false, only explicitly): every edit goes on, and the report says so', async () => {
  const w = round({ gateOn: false });
  const { passed, report } = await w.go();
  assert.deepStrictEqual(passed.map(e => e.id), w.edits.map(e => e.id));
  assert.deepStrictEqual(report, { off: true, why: 'the quiz gate is off (the loop config\'s quizGate: false): no edit was quizzed' });
  assert.deepStrictEqual(w.f.calls, []);
  // Anything but an explicit false is the gate on.
  const on = round({ gateOn: undefined });
  assert.strictEqual((await on.go()).passed.length, 1);
});

// --- a consolidation (a removal, or new text in the document's own words): no question; no slip at all -------------

test('a pure deletion: no question, red/green skipped; it passes the whole quiz when nothing falls', async () => {
  const { r, f } = await gate({ consolidation: true, find: '- line two\n', replace: '' });
  assert.strictEqual(r.verdict, 'pass', r.why);
  assert.strictEqual(r.redGreen, 'skipped (removal)');
  assert.deepStrictEqual(f.calls.map(c => c.dir), ['champion', 'edit'], 'only the whole quiz, both trees');
});

test('a deletion: one slip of a stable question blocks it (no slip allowed), where an edit that teaches may slip', async () => {
  const slip = ({ dir, id, run }) => (dir === 'edit' && id === 'a1' && run === 1 ? { stdout: 'ANSWER: no' } : null);
  const del = await gate({ consolidation: true, find: '- line two\n', replace: '', script: slip });
  assert.strictEqual(del.r.verdict, 'reject');
  assert.match(del.r.why, /1 questions slipped \(more than the 0 the gate allows\): a1/);
  assert.deepStrictEqual(del.r.slips.map(x => x.id), ['a1']);
  // The same slip on an edit with its own question: within the quiz file's maxSlips.
  assert.ok(G.maxSlips > 0);
  assert.strictEqual((await gate({ script: slip })).r.verdict, 'pass');
});

test('a deletion that makes the model read a rule worse is rejected', async () => {
  const worse = ({ dir, id }) => ((dir === 'edit' || dir === 'confirm-edit') && id === 'a2' ? { stdout: 'ANSWER: no' } : null);
  const { r } = await gate({ consolidation: true, find: '- line two\n', replace: '', script: worse });
  assert.strictEqual(r.verdict, 'reject');
  assert.deepStrictEqual(r.regressions.map(x => x.id), ['a2']);
  assert.strictEqual(r.redGreen, 'skipped (removal)');
});

test('quizRound: a removal (or a merge in the document\'s own words) needs no question; the report and its lessons line say red/green was skipped', async () => {
  const w = round();
  const del = w.edit('', null, { kind: 'removal', find: '- line two\n' });
  const merge = w.edit('- line one, line two', null);
  const { passed, report } = await w.go(1, [del, merge]);
  assert.deepStrictEqual(passed.map(e => e.id), [del.id, merge.id]);
  for (const e of [del, merge]) assert.strictEqual(report.edits[e.id].redGreen, 'skipped (removal)');
  assert.ok(!w.f.calls.some(c => c.dir === 'red' || c.dir === 'green'));
  // One stopped: its lessons line records the skip.
  const s = round({ script: ({ dir, id, run }) => (dir === 'edit' && id === 'a3' && run === 1 ? { stdout: 'ANSWER: no' } : null) });
  const d = s.edit('', null, { kind: 'removal', find: '- line two\n' });
  const out = await s.go(1, [d]);
  assert.deepStrictEqual(out.passed, []);
  const [line] = LS.readLessons(path.join(s.loopDir, LS.FILE));
  assert.deepStrictEqual([line.quiz, line.redGreen], ['reject', 'skipped (removal)']);
  // An edit that teaches something new still needs its question.
  const t = round();
  const r = await t.go(1, [t.edit('- line one\n- GOOD → wait for the retest', null)]);
  assert.match(Object.values(r.report.edits)[0].why, /^question: the quiz question the edit teaches/);
});

// --- the mutants review found surviving -----------------------------------------------------------------------------

test('green at exactly greenMinShare passes; a champion short of its questionRuns is inconclusive, never red', async () => {
  const n = G.questionRuns;
  const at = Math.ceil(G.greenMinShare * n);
  assert.strictEqual(at / n >= G.greenMinShare && (at - 1) / n < G.greenMinShare, true);
  const edge = await gate({ script: ({ dir, id, run }) => (dir === 'green' && id.startsWith('e-') && run > at ? { stdout: 'ANSWER: no' } : null) });
  assert.strictEqual(edge.r.verdict, 'pass', edge.r.why);
  assert.strictEqual(edge.r.redGreen.edit, `${at}/${n}`);
  // The champion's side short (its runs past the second keep failing): 0 of 2 is no red.
  const short = await gate({ script: ({ dir, id, run }) => (dir === 'red' && id.startsWith('e-') && run > 2 ? { error: new Error('down') } : null) });
  assert.strictEqual(short.r.verdict, 'blocked');
  assert.match(short.r.why, /^inconclusive after one retry: the edit's question has 0\/2 runs on the champion/);
});

test('the inconclusive retry asks the confirm runs again too', async () => {
  // a1 flagged on the edit; its confirm runs fail on the first pass (each run asked twice), then answer.
  const { r, f } = await gate({ script: ({ dir, id, nth }) => (dir === 'edit' && id === 'a1' ? { stdout: 'ANSWER: no' } : dir === 'confirm-edit' && nth <= 2 ? { error: new Error('busy') } : null) });
  assert.strictEqual(r.verdict, 'pass', r.why);
  assert.strictEqual(f.calls.filter(c => c.dir === 'confirm-edit').length, 2);
  assert.strictEqual(f.calls.filter(c => c.dir === 'confirm-champion').length, 2);
});

test('quizRound: the budget and live-runner check runs before every quiz run, and a refusal stops the round', async () => {
  const w = round();
  const events = [];
  const check = w.ctx.check;
  w.ctx.check = () => { events.push('check'); check(); };
  const run = w.ctx.steps.quizRun;
  w.ctx.steps.quizRun = opts => { events.push('run'); return run(opts); };
  await w.go();
  assert.ok(events.includes('run'));
  events.forEach((e, i) => { if (e === 'run') assert.strictEqual(events[i - 1], 'check', `run ${i} without a check before it`); });
  // A check that refuses (the budget spent, a live runner started) stops the round: nothing more is asked.
  const s = round();
  let calls = 0;
  s.ctx.check = () => { calls += 1; if (calls > 2) throw new Error('budget spent'); };
  await assert.rejects(s.go(), /budget spent/);
  assert.ok(s.f.calls.length <= 2, String(s.f.calls.length));
});

test('quizRound: the gate is off only for an explicit false; a missing or null setting is on', async () => {
  for (const loop of [{}, { quizGate: null }, { quizGate: undefined }, { quizGate: 'false' }]) {
    const w = round();
    w.ctx.loop = loop;
    const { passed, report } = await w.go();
    assert.strictEqual(passed.length, 1, JSON.stringify(loop));
    assert.ok(!report.off);
  }
});

test('quizRound: each verdict records its quiz hash; a changed quiz redoes the verdict on fresh runs, never the old phase file', async () => {
  const w = round();
  const first = await w.go();
  for (const r of Object.values(first.report.edits)) assert.strictEqual(r.quizHash, HASH);
  const asked = w.f.asks.length;
  w.ctx.steps.loadQuiz = () => ({ value: QUIZ, hash: 'quiz-hash-2' });
  const again = await w.go();
  for (const r of Object.values(again.report.edits)) assert.strictEqual(r.quizHash, 'quiz-hash-2');
  assert.ok(w.f.asks.length > asked, 'asked again');
  // Its runs are new ones: the edit's quiz directory is keyed by the quiz's hash too.
  assert.ok(w.f.asks.slice(asked).some(a => a.dir === 'green'));
  // The same quiz again: nothing redone.
  const n = w.f.asks.length;
  await w.go();
  assert.strictEqual(w.f.asks.length, n);
});

test('the iteration\'s record and line: the edits the quiz gate stopped, or the gate off; silent when it stopped none', () => {
  const IR = require('../../scripts/lib/train/iteration-report');
  const edits = [{ id: 'e1', tag: { skill: 'a', finding: 'F1', kind: 'rule' }, errors: [] }, { id: 'e2', tag: { skill: 'a', finding: 'F1', kind: 'rule' }, errors: [] }];
  const quiz = { quizHash: 'h', champion: null, edits: { e1: { verdict: 'pass', why: 'no regression' }, e2: { verdict: 'blocked', why: 'the edit does not teach its own question' } } };
  const rec = IR.build({ probeReport: { iteration: 1, edits, probes: [], quiz } });
  assert.deepStrictEqual(rec.quiz, { off: false, pass: 1, reject: 0, blocked: 1, stopped: [{ id: 'e2', verdict: 'blocked', why: 'the edit does not teach its own question' }] });
  assert.match(IR.line(rec), /^iteration 1: proposed 2 \(0 refused, 1 stopped by the quiz gate\), screened none;/);
  const off = IR.build({ probeReport: { iteration: 1, edits, probes: [], quiz: { off: true, why: QP.OFF } } });
  assert.deepStrictEqual(off.quiz, { off: true });
  assert.match(IR.line(off), /proposed 2 \(0 refused, the quiz gate off\)/);
  const none = IR.build({ probeReport: { iteration: 1, edits, probes: [], quiz: { ...quiz, edits: { e1: quiz.edits.e1 } } } });
  assert.match(IR.line(none), /proposed 2 \(0 refused\), screened none/);
  assert.strictEqual(IR.build({ probeReport: { iteration: 1, edits, probes: [] } }).quiz, null, 'a round from before the gate');
});

test('the lessons record: a quiz-gate line, practice-train only, named; the proposer reads it apart from the replays\' verdicts', () => {
  const file = path.join(tmpDir(), LS.FILE);
  LS.appendQuiz(file, { proposalId: 'e1', iteration: 1, skill: 'a', kind: 'rule', findingKind: 'misread', windows: WINDOW, quiz: 'blocked', why: 'the edit does not teach its own question' });
  assert.throws(() => LS.appendQuiz(file, { proposalId: 'e2', iteration: 1, skill: 'a', kind: 'rule', windows: WINDOW, quiz: 'pass' }), /quiz: reject or blocked/);
  assert.throws(() => LS.appendQuiz(file, { proposalId: 'e2', iteration: 1, skill: 'a', kind: 'rule', windows: [{ from: '2025-03-03', to: '2025-03-04' }], quiz: 'reject' }), /practice-train only/);
  assert.throws(() => LS.appendQuiz(file, { proposalId: 'e2', iteration: 1, kind: 'rule', windows: WINDOW, quiz: 'reject' }), /skill \(or agent\)/);
  const text = LS.summarize(LS.readLessons(file));
  assert.match(text, /- a, rule \(misread\): stopped by the quiz gate before any replay: blocked 1/);
  assert.doesNotMatch(text, /helped 0 of/, 'never counted as a replay verdict');
});
