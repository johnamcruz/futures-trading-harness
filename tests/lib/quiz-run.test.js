'use strict';

// The context quiz's runner (scripts/lib/eval/quiz-run.js): the prompts of one tree asked each question k times through
// an injected `ask` (never a model in a test), graded, written resumably; an errored run re-asked once; a question still
// short of its runs leaves the summary short (the quiz gate then says inconclusive). The CLI (scripts/context-quiz.js
// run) runs the same code with re-asking off, so its behaviour is unchanged.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const Q = require('../../scripts/lib/eval/context-quiz');
const QR = require('../../scripts/lib/eval/quiz-run');

const BASE = Q.loadQuiz().value;
// A small quiz of the file's own settings: two Part A questions on the head prompt and one lookup.
const QUIZ = {
  ...BASE,
  questions: [
    { id: 'a1', layer: 'bias', prompt: 'head', text: 'Is it long?', rule: 'r', anchor: 'LONG RULE', required: ['\\byes\\b'], forbidden: ['\\bno\\b'] },
    { id: 'a2', layer: 'entry', prompt: 'lookup', lookup: ['x'], text: 'Is it short?', rule: 'r', anchor: 'SHORT RULE', required: ['\\byes\\b'], forbidden: [] },
  ],
  partB: [],
};
const PROMPTS = { head: 'head text LONG RULE', 'head+risk': 'head risk', 'lookup:a2': 'head + x: SHORT RULE' };
const CFG = { harness: 'custom', command: ['ask', '{system}', '{prompt}'] };

/** A fake ask: answers from the system file it was given; `script(id, run, n)` may override (n: this call's count). */
function asker(script = () => null) {
  const calls = [];
  const ask = async (argv, opts) => {
    calls.push({ argv, ...opts });
    const said = script(opts.id, opts.run, calls.filter(c => c.id === opts.id && c.run === opts.run).length);
    if (said) return said;
    const system = fs.readFileSync(argv[1], 'utf8');
    return { stdout: /RULE/.test(system) ? 'ANSWER: yes' : 'ANSWER: no' };
  };
  return { ask, calls };
}

test('runQuiz: every question k times against its own prompt file, graded with the quiz it is given, the summary carrying the hash', async () => {
  const dir = tmpDir();
  const { ask, calls } = asker();
  const s = await QR.runQuiz({ quiz: QUIZ, hash: 'H1', cfg: CFG, k: 2, dir, ask, prompts: PROMPTS });
  assert.strictEqual(calls.length, 4);
  // The prompt files are written in the output directory; each question asked against its own (a lookup's: its key's).
  assert.deepStrictEqual([...new Set(calls.map(c => path.basename(c.argv[1])))].sort(), ['head.md', 'lookup-a2.md']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'lookup-a2.md'), 'utf8'), PROMPTS['lookup:a2']);
  // No project, no memory: an empty directory of the output's own.
  assert.ok(calls.every(c => c.cwd === path.join(dir, 'empty')));
  assert.deepStrictEqual(s.partA.per.map(x => [x.id, x.passes, x.n]), [['a1', 2, 2], ['a2', 2, 2]]);
  assert.deepStrictEqual([s.k, s.quizHash, s.asked], [2, 'H1', 4]);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  assert.deepStrictEqual(written.partA, s.partA);
  assert.strictEqual(written.quizHash, 'H1');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'grades.json'), 'utf8')).length, 4);
});

test('runQuiz: resumable (answers recorded without error are never asked again); `only` asks those ids alone', async () => {
  const dir = tmpDir();
  const first = asker((id, run) => (id === 'a2' && run === 2 ? { stdout: '', error: new Error('down') } : null));
  const s1 = await QR.runQuiz({ quiz: QUIZ, hash: 'H', cfg: CFG, k: 2, dir, ask: first.ask, prompts: PROMPTS, reask: 0 });
  assert.deepStrictEqual(s1.partA.per.map(x => [x.id, x.n]), [['a1', 2], ['a2', 1]], 'a question still short of its runs: the summary is short');
  assert.strictEqual(s1.errors, 1);
  const again = asker();
  const s2 = await QR.runQuiz({ quiz: QUIZ, hash: 'H', cfg: CFG, k: 2, dir, ask: again.ask, prompts: PROMPTS });
  assert.deepStrictEqual(again.calls.map(c => [c.id, c.run]), [['a2', 2]], 'only the errored run');
  assert.deepStrictEqual(s2.partA.per.map(x => [x.id, x.n]), [['a1', 2], ['a2', 2]]);
  const done = asker();
  await QR.runQuiz({ quiz: QUIZ, hash: 'H', cfg: CFG, k: 2, dir, ask: done.ask, prompts: PROMPTS });
  assert.strictEqual(done.calls.length, 0, 'a finished directory asks nothing');
  const only = asker();
  const s3 = await QR.runQuiz({ quiz: QUIZ, hash: 'H', cfg: CFG, k: 3, dir: tmpDir(), ask: only.ask, prompts: PROMPTS, only: ['a1'] });
  assert.deepStrictEqual([...new Set(only.calls.map(c => c.id))], ['a1']);
  assert.deepStrictEqual(s3.partA.per.map(x => [x.id, x.n]), [['a1', 3], ['a2', 0]]);
});

test('runQuiz: onCall before every ask (a re-ask too); one that throws stops the run, nothing recorded for that ask', async () => {
  const dir = tmpDir();
  const events = [];
  const { ask } = asker((id, run, n) => (id === 'a1' && run === 1 && n === 1 ? { error: new Error('busy') } : null));
  const traced = async (argv, o) => { events.push(`ask ${o.id}:${o.run}`); return ask(argv, o); };
  await QR.runQuiz({ quiz: QUIZ, hash: 'H', cfg: CFG, k: 2, dir, ask: traced, prompts: PROMPTS, onCall: () => events.push('call') });
  // a1 run 1 errs and is re-asked: five asks, each right after its own onCall.
  assert.deepStrictEqual(events, ['call', 'ask a1:1', 'call', 'ask a1:1', 'call', 'ask a1:2', 'call', 'ask a2:1', 'call', 'ask a2:2']);
  // A budget stop on the third ask: it propagates (never an errored answer row), the two asks before it stay recorded.
  const stop = tmpDir();
  let n = 0;
  const { ask: ok, calls } = asker();
  await assert.rejects(QR.runQuiz({ quiz: QUIZ, hash: 'H', cfg: CFG, k: 2, dir: stop, ask: ok, prompts: PROMPTS, onCall: () => { n += 1; if (n === 3) throw new Error('max model calls reached'); } }), /max model calls reached/);
  assert.strictEqual(calls.length, 2);
  const rows = fs.readFileSync(path.join(stop, 'answers.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(rows.map(r => [r.id, r.k, Boolean(r.error)]), [['a1', 1, false], ['a1', 2, false]]);
});

test('runQuiz: an errored run is recorded and re-asked once; still errored, the summary is short', async () => {
  const dir = tmpDir();
  // a1 run 1 fails once, then answers; a2 run 1 always fails (a thrown spawn, an is_error reply).
  const { ask, calls } = asker((id, run, n) => (id === 'a1' && run === 1 && n === 1 ? { error: new Error('spawn x ENOENT') } : id === 'a2' && run === 1 ? { stdout: '' } : null));
  const s = await QR.runQuiz({ quiz: QUIZ, hash: 'H', cfg: CFG, k: 1, dir, ask, prompts: PROMPTS });
  assert.deepStrictEqual(calls.map(c => [c.id, c.run]), [['a1', 1], ['a1', 1], ['a2', 1], ['a2', 1]], 'each error re-asked once, no more');
  assert.deepStrictEqual(s.partA.per.map(x => [x.id, x.passes, x.n]), [['a1', 1, 1], ['a2', 0, 0]]);
  const rows = fs.readFileSync(path.join(dir, 'answers.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(rows.map(r => [r.id, r.k, Boolean(r.error)]), [['a1', 1, true], ['a1', 1, false], ['a2', 1, true], ['a2', 1, true]], 'every error recorded');
  assert.match(rows[0].answer, /ENOENT/);
  assert.strictEqual(s.errors, 3);
});

test('runQuiz: rows of another quiz\'s questions or of runs past k are never graded; a duplicate run counts once', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'answers.jsonl'), [{ id: 'a1', k: 1, answer: 'ANSWER: yes' }, { id: 'a1', k: 1, answer: 'ANSWER: no' }, { id: 'zz', k: 1, answer: 'ANSWER: yes' }, { id: 'a2', k: 5, answer: 'ANSWER: yes' }].map(r => JSON.stringify(r)).join('\n').concat('\n'));
  const { ask, calls } = asker();
  const s = await QR.runQuiz({ quiz: QUIZ, hash: 'H', cfg: CFG, k: 1, dir, ask, prompts: PROMPTS });
  assert.deepStrictEqual(calls.map(c => c.id), ['a2']);
  assert.deepStrictEqual(s.partA.per.map(x => [x.id, x.passes, x.n]), [['a1', 1, 1], ['a2', 1, 1]]);
});

test('runQuiz: a harness that takes no system file is refused before any ask; k and the quiz are checked', async () => {
  const { ask, calls } = asker();
  await assert.rejects(QR.runQuiz({ quiz: QUIZ, hash: 'H', cfg: { harness: 'codex' }, k: 1, dir: tmpDir(), ask, prompts: PROMPTS }), /takes no system-prompt file/);
  assert.strictEqual(calls.length, 0);
  await assert.rejects(QR.runQuiz({ quiz: QUIZ, hash: 'H', cfg: CFG, k: 0, dir: tmpDir(), ask, prompts: PROMPTS }), /k: a whole number/);
  await assert.rejects(QR.runQuiz({ quiz: QUIZ, hash: null, cfg: CFG, k: 1, dir: tmpDir(), ask, prompts: PROMPTS }), /hash/);
  await assert.rejects(QR.runQuiz({ quiz: QUIZ, hash: 'H', cfg: CFG, k: 1, dir: tmpDir(), ask, prompts: { head: 'x' } }), /no prompt for lookup:a2/);
});

test('fileOf: the head prompts by name, any other prompt key a file of its own', () => {
  assert.deepStrictEqual(['head', 'head+risk', 'lookup:q31', 'situational:q9'].map(QR.fileOf), ['head.md', 'head+risk.md', 'lookup-q31.md', 'situational-q9.md']);
});

test('the default ask runs the argv in the given directory, its stdout read; a missing binary is an error', () => {
  const dir = tmpDir();
  const ok = QR.defaultAsk([process.execPath, '-e', 'process.stdout.write(process.cwd())'], { cwd: dir });
  assert.strictEqual(fs.realpathSync(ok.stdout), fs.realpathSync(dir));
  assert.ok(!ok.error);
  assert.ok(QR.defaultAsk(['/nonexistent/binary-x'], { cwd: dir }).error);
  assert.ok(QR.defaultAsk([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], { cwd: dir, timeoutMs: 100 }).error, 'past its timeout: an error');
  // A non-zero exit is an error even with output on stdout: a crashed harness's text is no answer.
  const failed = QR.defaultAsk([process.execPath, '-e', "process.stdout.write('ANSWER: yes'); process.exit(3)"], { cwd: dir });
  assert.match(String(failed.error && failed.error.message), /exited 3/);
});

test('the CLI `run`: the same runner, a fake custom harness, each run once (no re-ask), then graded as before', () => {
  const dir = tmpDir();
  const bin = path.join(tmpDir(), 'fake-ask.js');
  // Answers q6 (a levels question) correctly; prints its own count so a re-ask would show.
  fs.writeFileSync(bin, "process.stdout.write('ANSWER: No: only where the stop goes.');\n");
  const cfgFile = path.join(tmpDir(), 'runner.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ harness: 'custom', command: [process.execPath, bin, '{system}', '{prompt}'], symbols: ['MNQ'], timeframe: 3 }));
  const cli = path.join(__dirname, '..', '..', 'scripts', 'context-quiz.js');
  const r = spawnSync(process.execPath, [cli, 'run', '--config', cfgFile, '--out', dir, '--k', '2', '--only', 'q6'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^q6 1 ok$/m);
  assert.match(r.stdout, /^q6 2 ok$/m);
  assert.match(r.stdout, /^q6\tlevels\t2\/2$/m);
  const rows = fs.readFileSync(path.join(dir, 'answers.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(rows.length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'questions.json')) && fs.existsSync(path.join(dir, 'head.md')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')).quizHash, Q.loadQuiz().hash);
  // A failing harness: the CLI records the error and does not re-ask (its behaviour before the runner moved to the library).
  const failDir = tmpDir();
  fs.writeFileSync(cfgFile, JSON.stringify({ harness: 'custom', command: ['/nonexistent/binary-x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 }));
  const f = spawnSync(process.execPath, [cli, 'run', '--config', cfgFile, '--out', failDir, '--k', '1', '--only', 'q6'], { encoding: 'utf8' });
  assert.strictEqual(f.status, 0, f.stderr);
  assert.match(f.stdout, /^q6 1 error$/m);
  assert.strictEqual(fs.readFileSync(path.join(failDir, 'answers.jsonl'), 'utf8').trim().split('\n').length, 1);
});
