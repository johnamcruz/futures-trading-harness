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

const EXECUTOR = 'agents/trade-executor.md';
const RISK = 'agents/risk-manager.md';
const ANALYST = 'agents/market-structure-analyst.md';
// A skill the head reads only as needed (a lookup): in no prompt but a lookup question's naming it.
const LOOKUP = 'skills/b/SKILL.md';
const ROLE = name => `---\nname: ${name}\ndescription: a test role\n---\n\nYou are the ${name}.\n\n- role line one\n\n- role line two\n`;
/** A tree holding skill a, and the risk manager and the trade executor. */
function tree(text = TEXT) {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'skills', 'a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, SKILL), text);
  fs.writeFileSync(path.join(dir, RISK), ROLE('risk-manager'));
  fs.writeFileSync(path.join(dir, EXECUTOR), ROLE('trade-executor'));
  fs.writeFileSync(path.join(dir, ANALYST), ROLE('market-structure-analyst'));
  fs.mkdirSync(path.join(dir, 'skills', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, LOOKUP), '---\nname: b\ndescription: a looked-up skill\n---\n\n# B\n\n- b line one\n');
  return dir;
}
/**
 * The prompts as eval/context-quiz.js buildPrompts shapes them: `head` the head trader's skills, `head+risk` that plus
 * the risk manager's body, a situational or lookup question's the head plus its skills. No analyst's or the executor's
 * text is in any of them (the real buildPrompts holds neither).
 */
const body = t => t.replace(/^---[\s\S]*?\n---\n/, '');
function realPrompts(root, quiz) {
  const head = fs.readFileSync(path.join(root, SKILL), 'utf8');
  const out = { head, 'head+risk': `${head}\n${body(fs.readFileSync(path.join(root, RISK), 'utf8'))}` };
  for (const q of [...quiz.questions, ...quiz.partB]) if (q.prompt === 'situational') out[Q.promptKey(q)] = `${head}\n(situational)`;
  for (const q of [...quiz.questions, ...quiz.partB]) if (q.prompt === 'lookup') out[Q.promptKey(q)] = `${head}\n${q.lookup.map(k => fs.readFileSync(path.join(root, 'skills', k, 'SKILL.md'), 'utf8')).join('\n')}`;
  return out;
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
  w.ctx.steps.quizPrompts = realPrompts;
  // An executor edit needs no quiz: under a harness the quiz cannot ask it is not quizzed and goes on, as anywhere.
  const exec = roleEdit(EXECUTOR, '- role line one', '- role line one\n- EXEC → confirm the fill', { ...QUESTION, anchor: 'EXEC → confirm the fill' });
  const { passed, report } = await w.go(1, [...w.edits, exec]);
  assert.deepStrictEqual(passed.map(e => e.id), [exec.id]);
  assert.strictEqual(report.edits[exec.id].verdict, QP.NOT_QUIZZED);
  for (const e of w.edits) assert.match(report.edits[e.id].why, /the quiz could not run: context quiz: the codex harness takes no system-prompt file.* \(the loop config's quizGate: false turns the gate off\)/);
  assert.deepStrictEqual(w.f.calls, [], 'no model asked');
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

test('a deletion is judged by the quiz\'s own gate: stable questions that wobble within maxSlips pass it, as for any edit', async () => {
  // A no-op deletion; each stable question slips one run on the edit (noise, never confirmed): the gate's maxSlips,
  // never zero (zero rejects most no-op edits on the per-question rates a real quiz has).
  assert.ok(G.maxSlips >= QUIZ.questions.length, 'the quiz file allows at least this many slips');
  const wobble = ({ dir, run }) => (dir === 'edit' && run === 1 ? { stdout: 'ANSWER: no' } : null);
  const one = ({ dir, id, run }) => (dir === 'edit' && id === 'a1' && run === 1 ? { stdout: 'ANSWER: no' } : null);
  for (const script of [one, wobble]) {
    const del = await gate({ consolidation: true, find: '- line two\n', replace: '', script });
    assert.strictEqual(del.r.verdict, 'pass', del.r.why);
    assert.strictEqual(del.r.redGreen, 'skipped (removal)');
    // The same wobble on an edit with its own question: the same verdict (one gate for both).
    assert.strictEqual((await gate({ script })).r.verdict, del.r.verdict);
  }
  // More slips than maxSlips still reject a deletion, as any edit: a quiz with more stable questions than maxSlips.
  const many = Array.from({ length: G.maxSlips + 1 }, (_, i) => `m${i}`);
  const big = { ...QUIZ, questions: many.map(ask3) };
  const champ = tree();
  const edited = tree(TEXT.replace('- line two\n', ''));
  const dir = tmpDir();
  const f = fakeRun(({ dir: d, run }) => (d === 'edit' && run === 1 ? { stdout: 'ANSWER: no' } : null));
  const champion = async () => f.run({ root: champ, quiz: big, hash: HASH, k: big.k, dir: path.join(dir, 'champion'), prompts: prompts(champ, big) });
  const r = await QP.gateEdit({ quiz: big, hash: HASH, question: null, consolidation: true, championRoot: champ, editRoot: edited, dir: path.join(dir, 'edit'), run: f.run, prompts, champion });
  assert.strictEqual(r.verdict, 'reject');
  assert.match(r.why, new RegExp(`${G.maxSlips + 1} questions slipped \\(more than the ${G.maxSlips} the gate allows\\)`));
});

test('a deletion that makes the model read a rule worse is rejected', async () => {
  const worse = ({ dir, id }) => ((dir === 'edit' || dir === 'confirm-edit') && id === 'a2' ? { stdout: 'ANSWER: no' } : null);
  const { r } = await gate({ consolidation: true, find: '- line two\n', replace: '', script: worse });
  assert.strictEqual(r.verdict, 'reject');
  assert.deepStrictEqual(r.regressions.map(x => x.id), ['a2']);
  assert.strictEqual(r.redGreen, 'skipped (removal)');
});

test('quizRound: a removal (or a trim: a pure deletion) needs no question; the report and its lessons line say red/green was skipped', async () => {
  const w = round();
  const del = w.edit('', null, { kind: 'removal', find: '- line two\n' });
  const merge = w.edit('- line two', null, { find: '- line one\n\n- line two' });
  const { passed, report } = await w.go(1, [del, merge]);
  assert.deepStrictEqual(passed.map(e => e.id), [del.id, merge.id]);
  for (const e of [del, merge]) assert.strictEqual(report.edits[e.id].redGreen, 'skipped (removal)');
  assert.ok(!w.f.calls.some(c => c.dir === 'red' || c.dir === 'green'));
  // One stopped (a confirmed regression of a3): its lessons line records the skip.
  const s = round({ script: ({ dir, id }) => ((dir === 'edit' || dir === 'confirm-edit') && id === 'a3' ? { stdout: 'ANSWER: no' } : null) });
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

// --- a target no quiz prompt holds (an analyst's or the executor's text): not quizzed, no model call ----------------

/** A role edit, tagged as the proposer tags one ("agent"), on agents/<role>.md. */
function roleEdit(file, find, replace, question, kind = 'rule') {
  const p = { targets: ['wrong stated reason'], expects: 'fewer early entries', edits: [{ file, find, replace }] };
  return { id: P.proposalId(p), tag: { agent: path.basename(file, '.md'), finding: 'F1', kind }, finding: { id: 'F1', kind: 'misread' }, proposal: p, question, errors: [] };
}

/** A proposal over several files, tagged by its first. */
function multiEdit(edits, question, tag) {
  const p = { targets: ['wrong stated reason'], expects: 'fewer early entries', edits };
  return { id: P.proposalId(p), tag: { ...tag, finding: 'F1', kind: 'rule' }, finding: { id: 'F1', kind: 'misread' }, proposal: p, question, errors: [] };
}

test('quizRound: a skill the head reads only as needed, asked of the head prompt, is still quizzed (a skills/ file always is)', async () => {
  // The quiz holds no lookup of b, and the question asks the head prompt: every prompt is byte-identical on both trees.
  const w = round();
  w.ctx.steps.quizPrompts = realPrompts;
  const e = multiEdit([{ file: LOOKUP, find: '- b line one', replace: '- b line one\n- LOOK → wait for the retest' }], { ...QUESTION, prompt: 'head', anchor: 'LOOK → wait for the retest' }, { skill: 'b' });
  const { passed, report } = await w.go(1, [e]);
  assert.notStrictEqual(report.edits[e.id].verdict, QP.NOT_QUIZZED);
  assert.deepStrictEqual(passed, []);
  assert.match(report.edits[e.id].why, /question\.anchor: not in the edited tree's head prompt/);
  // Asked as the lookup of b it names: gated (red/green run on its own prompt).
  const v = round();
  v.ctx.steps.quizPrompts = realPrompts;
  const l = multiEdit(e.proposal.edits, { ...QUESTION, prompt: 'lookup', lookup: ['b'], anchor: 'LOOK → wait for the retest', required: ['\\bline\\b'] }, { skill: 'b' });
  const out = await v.go(1, [l]);
  assert.strictEqual(out.report.edits[l.id].verdict, 'pass', out.report.edits[l.id].why);
  assert.ok(v.f.calls.some(c => c.dir === 'red'));
});

test('quizRound: an analyst edit is not quizzed; a proposal touching a skill and an analyst file is quizzed', async () => {
  const w = round();
  w.ctx.steps.quizPrompts = realPrompts;
  const q = { ...QUESTION, anchor: 'MS → mark the swing' };
  const analyst = roleEdit(ANALYST, '- role line one', '- role line one\n- MS → mark the swing', q);
  const mixed = multiEdit([{ file: LOOKUP, find: '- b line one', replace: '- b line one\n- b line one, again' }, { file: ANALYST, find: '- role line two', replace: '- role line two\n- MS → mark the swing' }], q, { skill: 'b' });
  const { report } = await w.go(1, [analyst, mixed]);
  assert.strictEqual(report.edits[analyst.id].verdict, QP.NOT_QUIZZED);
  assert.notStrictEqual(report.edits[mixed.id].verdict, QP.NOT_QUIZZED);
  assert.match(report.edits[mixed.id].why, /question\.anchor: not in the edited tree's head prompt/);
});

test('quizRound: an analyst edit whose own question\'s prompt holds the analyst\'s text is quizzed (the prompts compared include it)', async () => {
  // A prompt kind that carries a role's text for the question it asks (none does today): its prompt differs between the
  // trees, so the quiz can measure the edit, and it is gated.
  const w = round();
  w.ctx.steps.quizPrompts = (root, quiz) => {
    const out = realPrompts(root, { ...quiz, questions: quiz.questions.filter(q => !(q.lookup || []).includes('desk')) });
    for (const q of quiz.questions.filter(x => (x.lookup || []).includes('desk'))) out[Q.promptKey(q)] = `${out.head}\n${body(fs.readFileSync(path.join(root, ANALYST), 'utf8'))}`;
    return out;
  };
  const q = { ...QUESTION, prompt: 'lookup', lookup: ['desk'], anchor: 'MS → mark the swing' };
  const e = roleEdit(ANALYST, '- role line one', '- role line one\n- MS → mark the swing', q);
  const { report } = await w.go(1, [e]);
  assert.notStrictEqual(report.edits[e.id].verdict, QP.NOT_QUIZZED);
  assert.ok(w.f.calls.some(c => c.dir === 'red'), JSON.stringify(report.edits[e.id]));
});

test('quizTarget: only agents/<role>.md files of a role no quiz prompt carries; anything else (fails closed) is quizzed', () => {
  const p = (...files) => ({ edits: files.map(file => ({ file, find: 'x', replace: 'y' })) });
  assert.strictEqual(QP.unquizzedTarget(p(ANALYST)), true);
  assert.strictEqual(QP.unquizzedTarget(p(EXECUTOR, 'agents/volume-liquidity-analyst.md')), true);
  for (const bad of [p(RISK), p('agents/head-trader.md'), p(SKILL), p(LOOKUP, ANALYST), p('agents/../skills/a/SKILL.md'), p('agents/trade-reviewer.md'), p(), { edits: null }, null]) {
    assert.strictEqual(QP.unquizzedTarget(bad), false, JSON.stringify(bad));
  }
});

test('quizRound: an executor edit is in no quiz prompt: not quizzed (no model call, never blocked by its anchor), it goes on to the replay', async () => {
  const w = round();
  w.ctx.steps.quizPrompts = realPrompts;
  const q = { ...QUESTION, prompt: 'head', anchor: 'EXEC → confirm the fill' };
  const rule = roleEdit(EXECUTOR, '- role line one', '- role line one\n- EXEC → confirm the fill', q);
  const removal = roleEdit(EXECUTOR, '- role line two\n', '', null, 'removal');
  const skill = w.edit('- line one\n- GOOD → wait for the retest');
  const { passed, report } = await w.go(1, [rule, removal, skill]);
  // Both role edits go on; the skill edit is quizzed as before (and passes).
  assert.deepStrictEqual(passed.map(e => e.id), [rule.id, removal.id, skill.id]);
  for (const e of [rule, removal]) {
    const r = report.edits[e.id];
    assert.deepStrictEqual([r.verdict, r.why, r.asked, r.quizHash], [QP.NOT_QUIZZED, 'no quiz prompt holds this target: not quizzed', 0, HASH]);
  }
  assert.strictEqual(report.edits[skill.id].verdict, 'pass');
  // No ask for the role edits: no quiz run is on a tree whose executor text was edited.
  assert.ok(w.f.calls.length > 0, 'the skill edit is quizzed');
  assert.strictEqual(w.f.calls.filter(c => c.root && fs.readFileSync(path.join(c.root, EXECUTOR), 'utf8') !== ROLE('trade-executor')).length, 0);
  // Never a lessons line (it is replayed), and the round's record counts it apart: no pass, not stopped.
  assert.deepStrictEqual(LS.readLessons(path.join(w.loopDir, LS.FILE)), []);
  const IR = require('../../scripts/lib/train/iteration-report');
  const rec = IR.build({ probeReport: { iteration: 1, edits: [rule, removal, skill].map(e => ({ id: e.id, tag: e.tag, errors: [] })), probes: [], quiz: report } });
  assert.deepStrictEqual(rec.quiz, { off: false, pass: 1, reject: 0, blocked: 0, notQuizzed: 2, stopped: [] });
  assert.match(IR.line(rec), /proposed 3 \(0 refused, 2 not quizzed: no quiz prompt holds their target\)/);
  // A resume asks nothing and keeps the verdicts.
  const before = w.f.asks.length;
  const again = await w.go(1, [rule, removal, skill]);
  assert.strictEqual(w.f.asks.length, before);
  assert.strictEqual(again.report.edits[rule.id].verdict, QP.NOT_QUIZZED);
});

test('quizRound: a round of executor edits alone asks the model nothing at all (not even the champion\'s quiz)', async () => {
  const w = round();
  w.ctx.steps.quizPrompts = realPrompts;
  const removal = roleEdit(EXECUTOR, '- role line two\n', '', null, 'removal');
  const { passed } = await w.go(1, [removal]);
  assert.deepStrictEqual(passed.map(e => e.id), [removal.id]);
  assert.deepStrictEqual([w.f.calls, w.f.asks], [[], []]);
});

test('quizRound: a risk-manager edit is in the head+risk prompt: quizzed as a skill edit is (its anchor checked, red/green run)', async () => {
  const w = round();
  w.ctx.steps.quizPrompts = realPrompts;
  const q = { ...QUESTION, prompt: 'head+risk', anchor: 'RISK → size from the stop' };
  const e = roleEdit(RISK, '- role line one', '- role line one\n- RISK → size from the stop', q);
  const { report } = await w.go(1, [e]);
  const r = report.edits[e.id];
  assert.notStrictEqual(r.verdict, QP.NOT_QUIZZED);
  assert.ok(w.f.calls.some(c => c.dir === 'red') && w.f.calls.some(c => c.dir === 'green'), JSON.stringify(w.f.calls));
  // A risk-manager edit whose anchor is not in its new text: blocked by the anchor check, as before.
  const v = round();
  v.ctx.steps.quizPrompts = realPrompts;
  const bad = roleEdit(RISK, '- role line one', '- role line one\n- RISK → size from the stop', { ...q, anchor: 'never written' });
  const out = await v.go(1, [bad]);
  assert.match(out.report.edits[bad.id].why, /question\.anchor: not in the edited tree's head\+risk prompt/);
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

test('quizRound: every quiz ask is charged to the loop\'s model calls, stopped at the limit mid-run; a resume charges only new asks', async () => {
  const S = require('../../scripts/lib/train/state');
  // The loop's own budget (train/loop.js open: ctx.call = check, then spend one), the real budgetLeft and spend.
  const budgeted = (w, limit) => {
    w.ctx.state.modelCalls = 0;
    w.ctx.state.iterations = [];
    const limits = { maxIterations: 1, maxModelCalls: limit, maxWallMinutes: 60 };
    w.ctx.check = () => { const why = S.budgetLeft(w.ctx.state, limits, { startedMs: Date.now() }); if (why) throw new Error(why); };
    w.ctx.call = () => { w.ctx.check(); S.spend(w.ctx.state, 1); };
    w.limits = limits;
  };
  // The whole round, unlimited: what it asks in all.
  const all = round();
  budgeted(all, 1e6);
  await all.go();
  const total = all.f.asks.length;
  assert.ok(total > 2 * G.questionRuns, String(total));
  assert.strictEqual(all.ctx.state.modelCalls, total, 'one model call per ask');
  // Limited mid-way through the first edit's red/green: the round stops at the limit, inside a quiz run.
  const w = round();
  const limit = G.questionRuns + 2;
  budgeted(w, limit);
  await assert.rejects(w.go(), /max model calls reached/);
  assert.deepStrictEqual([w.ctx.state.modelCalls, w.f.asks.length], [limit, limit]);
  // Resumed with more budget: the answers stored are never asked or charged again.
  w.limits.maxModelCalls = 1e6;
  await w.go();
  assert.strictEqual(w.ctx.state.modelCalls, w.f.asks.length);
  assert.strictEqual(w.f.asks.length, total, 'no ask repeated across the stop');
});

test('quizRound: the question\'s pattern limits are the run\'s quiz file\'s (its gate), never the repo file\'s', async () => {
  // A gap in a forbidden pattern (the grammar holds for both).
  const q = { ...QUESTION, forbidden: ['nope.{0,9}line'] };
  const go = async gate => {
    const w = round();
    w.ctx.steps.loadQuiz = () => ({ value: { ...QUIZ, gate: { ...G, ...gate } }, hash: HASH });
    const e = w.edit('- line one\n- GOOD → wait for the retest', q);
    return (await w.go(1, [e])).report.edits[e.id];
  };
  assert.match((await go({ maxGaps: 0 })).why, /question\.forbidden\[0\]: at most 0 wildcard gaps/);
  assert.strictEqual((await go({})).verdict, 'pass');
  assert.match((await go({ maxGradedLineChars: 3 })).why, /question\.required\[0\]: matches nothing in the champion's head prompt/);
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
  assert.deepStrictEqual(rec.quiz, { off: false, pass: 1, reject: 0, blocked: 1, notQuizzed: 0, stopped: [{ id: 'e2', verdict: 'blocked', why: 'the edit does not teach its own question' }] });
  assert.match(IR.line(rec), /^iteration 1: proposed 2 \(0 refused, 1 stopped by the quiz gate\), screened none;/);
  const off = IR.build({ probeReport: { iteration: 1, edits, probes: [], quiz: { off: true, why: QP.OFF } } });
  assert.deepStrictEqual(off.quiz, { off: true });
  assert.match(IR.line(off), /proposed 2 \(0 refused, the quiz gate off\)/);
  const none = IR.build({ probeReport: { iteration: 1, edits, probes: [], quiz: { ...quiz, edits: { e1: quiz.edits.e1 } } } });
  assert.match(IR.line(none), /proposed 2 \(0 refused\), screened none/);
  assert.strictEqual(IR.build({ probeReport: { iteration: 1, edits, probes: [] } }).quiz, null, 'a round from before the gate');
});

test('the lessons record: each refused probe\'s id, stage and first reason reach the proposer, one line each of at most 160 characters', async () => {
  const file = path.join(tmpDir(), LS.FILE);
  LS.appendQuiz(file, { proposalId: 'e1', iteration: 1, skill: 'a', kind: 'rule', windows: WINDOW, quiz: 'blocked', stage: 'question', why: 'question.required[0]: a group at 0: no repeat after it (at most ?): a repeated group backtracks without end; write plain phrases; question.anchor: not in the edited tree' });
  LS.appendQuiz(file, { proposalId: 'e2', iteration: 1, skill: 'a', kind: 'rule', windows: WINDOW, quiz: 'reject', stage: 'regression', why: `regressed: a2 ${'x'.repeat(300)}` });
  const text = LS.summarize(LS.readLessons(file));
  const lines = text.split('\n').filter(l => l.startsWith('- refused '));
  assert.deepStrictEqual(lines.map(l => l.slice(0, 36)), ['- refused e2 (regression, reject): r', '- refused e1 (question, blocked): qu']);
  assert.match(lines[1], /^- refused e1 \(question, blocked\): question\.required\[0\]: a group at 0: no repeat after it \(at most \?\): a repeated group backtracks without end$/);
  assert.ok(lines.every(l => l.length <= LS.REFUSED_CHARS), lines.map(l => l.length).join());
  // The quiz gate writes the stage of each edit it stopped.
  const w = round();
  const bad = w.edit('- line one\n- GOOD → wait for the retest', { ...QUESTION, anchor: 'never written anywhere' });
  await w.go(1, [bad]);
  const [line] = LS.readLessons(path.join(w.loopDir, LS.FILE));
  assert.deepStrictEqual([line.stage, line.quiz], ['question', 'blocked']);
  assert.match(LS.summarize([line]), new RegExp(`- refused ${bad.id} \\(question, blocked\\): question\\.anchor: not in the edited tree's head prompt`));
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
