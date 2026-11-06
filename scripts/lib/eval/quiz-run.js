'use strict';

/**
 * The context quiz's runner (config/context-quiz.json, eval/context-quiz.js): one tree's prompts asked each question k
 * times in fresh sessions, graded, and written into a directory of the caller's, resumably. The CLI
 * (scripts/context-quiz.js run) and the training loop's quiz gate (train/quiz-phase.js) both run it. It calls a model
 * only through `ask`: the default spawns the argv the user's runner config gives (Q.quizCommand); a test injects a fake.
 *
 *   runQuiz({ root, quiz, hash, cfg, k, only, dir, ask, prompts, reask, env, timeoutMs, log })
 *        the prompts of the tree at `root` (Q.buildPrompts, unless `prompts` are given) written into `dir`; each question
 *        of `quiz` (or of `only`) asked k times through ask(argv, { cwd, env, timeoutMs, systemFile, id, run }) ->
 *        { stdout, error }, in an empty directory of `dir`'s own. answers.jsonl is appended row by row; a run recorded
 *        without error is never asked again. An errored run is recorded and asked again up to `reask` times (default 1;
 *        the CLI passes 0). Then grades.json and summary.json, graded with the quiz given (never the file's: a probe
 *        edit's own question is in no file), and the summary returned: Q.summarize's, with `quizHash` (as `grade`
 *        writes it), `asked` (the asks this call made) and `errors` (those that errored). A question still short of its
 *        runs leaves its row short: the quiz gate says inconclusive, never pass.
 *   fileOf(key)          the prompt's file name in the directory (head.md, head+risk.md, lookup-q31.md, ...)
 *   defaultAsk(argv, { cwd, env, timeoutMs })   spawnSync: { stdout, error }; a non-zero exit is an error
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Q = require('./context-quiz');

const FILES = Object.freeze({ head: 'head.md', 'head+risk': 'head+risk.md' });
const fileOf = key => FILES[key] || `${key.replace(/[^a-z0-9+]+/gi, '-')}.md`; // a situational or lookup question's own prompt

const readRows = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

function defaultAsk([bin, ...args], { cwd, env = null, timeoutMs = null } = {}) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', ...(env ? { env } : {}), ...(timeoutMs ? { timeout: timeoutMs } : {}) });
  // A non-zero exit (or none: killed) is an error even with output: a crashed harness's text is no answer.
  return { stdout: r.stdout, error: r.error || (r.status !== 0 ? new Error(`${bin} exited ${r.status === null ? `on ${r.signal}` : r.status}`) : null) };
}

/** The rows of `dir` graded by `quiz`: its questions only, runs 1..k, each run once (the first answer recorded without error). */
function gradeDir(quiz, dir, k) {
  const all = [...quiz.questions, ...quiz.partB];
  const seen = new Set();
  const graded = [];
  for (const r of readRows(path.join(dir, 'answers.jsonl'))) {
    const q = all.find(x => x.id === r.id);
    if (r.error || !q || !(Number.isInteger(r.k) && r.k >= 1 && r.k <= k) || seen.has(`${r.id}:${r.k}`)) continue;
    seen.add(`${r.id}:${r.k}`);
    graded.push({ ...Q.gradeAnswer(quiz, q, r.answer), k: r.k, answer: r.answer });
  }
  return graded;
}

async function runQuiz({ root = null, quiz, hash, cfg, k, only = null, dir, ask = defaultAsk, prompts = null, reask = 1, env = null, timeoutMs = null, log = () => {} }) {
  if (!hash) throw new Error('runQuiz: the quiz hash its summary is graded with (a summary without it can never pass the gate)');
  if (!(Number.isInteger(k) && k >= 1)) throw new Error('runQuiz: k: a whole number, 1 or more');
  const asked = [...quiz.questions, ...quiz.partB].filter(q => !only || only.includes(q.id));
  const texts = prompts || Q.buildPrompts(root, quiz);
  for (const q of asked) if (typeof texts[Q.promptKey(q)] !== 'string') throw new Error(`runQuiz: no prompt for ${Q.promptKey(q)}`);
  // The argv of every question first: a harness that takes no system file is refused before any model call.
  const systemOf = q => path.join(dir, fileOf(Q.promptKey(q)));
  const argvOf = q => Q.quizCommand(cfg, Q.questionText(quiz, q), systemOf(q));
  for (const q of asked) argvOf(q);
  fs.mkdirSync(dir, { recursive: true });
  for (const key of new Set(asked.map(Q.promptKey))) fs.writeFileSync(path.join(dir, fileOf(key)), texts[key]);
  const file = path.join(dir, 'answers.jsonl');
  const done = new Set(readRows(file).filter(r => !r.error).map(r => `${r.id}:${r.k}`));
  // No project, no memory: each question runs in an empty directory of the output's own.
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  let calls = 0;
  let errors = 0;
  for (const q of asked) {
    for (let i = 1; i <= k; i += 1) {
      if (done.has(`${q.id}:${i}`)) continue;
      const argv = argvOf(q);
      for (let attempt = 0; attempt <= reask; attempt += 1) {
        const t = Date.now();
        let r;
        try { r = await ask(argv, { cwd: empty, env, timeoutMs, systemFile: systemOf(q), id: q.id, run: i }); } catch (err) { r = { error: err }; }
        calls += 1;
        const reply = r && r.error ? { answer: String(r.error.message || r.error), error: true } : Q.replyOf(cfg, r ? r.stdout : '');
        fs.appendFileSync(file, `${JSON.stringify({ id: q.id, k: i, ms: Date.now() - t, ...reply })}\n`);
        log(q.id, i, reply.error ? 'error' : 'ok');
        if (!reply.error) break;
        errors += 1;
      }
    }
  }
  const graded = gradeDir(quiz, dir, k);
  fs.writeFileSync(path.join(dir, 'grades.json'), `${JSON.stringify(graded, null, 1)}\n`);
  const summary = { ...Q.summarize(quiz, graded, k), quizHash: hash };
  fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  return { ...summary, asked: calls, errors };
}

module.exports = { FILES, fileOf, defaultAsk, runQuiz };
