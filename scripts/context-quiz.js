#!/usr/bin/env node
'use strict';

/**
 * The context quiz (config/context-quiz.json, scripts/lib/eval/context-quiz.js): ask the head trader's and the risk
 * manager's prompts the quiz's questions, K times each in fresh sessions, and grade the answers. It calls a model, so
 * it is run by hand, never in CI. The model is the one the user's runner config names; output goes to a directory the
 * user chooses, never into the repository.
 *
 *   node scripts/context-quiz.js build --out <dir>
 *   node scripts/context-quiz.js run --config <runner config.json> --out <dir> [--harness <name>] [--k 5] [--only q1,b2]
 *   node scripts/context-quiz.js grade <dir>
 *   node scripts/context-quiz.js compare <dirA> <dirB>
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Q = require('./lib/eval/context-quiz');

const ROOT = path.resolve(__dirname, '..');
const arg = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const FILES = { head: 'head.md', 'head+risk': 'head+risk.md' };
const fileOf = key => FILES[key] || `${key.replace(/[^a-z0-9+]+/gi, '-')}.md`; // a situational question's own prompt

/** The output directory: given, made, and never inside the repository. */
function outDir(dir) {
  if (!dir) throw new Error('--out <dir>: a directory of your own (never inside the repository)');
  const abs = path.resolve(dir);
  const rel = path.relative(ROOT, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`${abs} is inside the repository: write the quiz's output elsewhere`);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

function build(dir) {
  const { value, hash } = Q.loadQuiz();
  const prompts = Q.buildPrompts(ROOT, value);
  for (const [k, text] of Object.entries(prompts)) fs.writeFileSync(path.join(dir, fileOf(k)), text);
  const asked = [...value.questions, ...value.partB].map(q => ({ id: q.id, prompt: Q.promptKey(q), text: Q.questionText(value, q) }));
  fs.writeFileSync(path.join(dir, 'questions.json'), `${JSON.stringify({ quizHash: hash, asked }, null, 1)}\n`);
  const missing = Q.anchorsMissing(value, prompts);
  console.log(`built ${asked.length} questions in ${dir} (head ${prompts.head.length} chars, head+risk ${prompts['head+risk'].length})${missing.length ? `; anchors missing: ${missing.join(', ')}` : ''}`);
  return { value, asked };
}

const readRows = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

function run(argv) {
  const configPath = arg(argv, '--config');
  if (!configPath) throw new Error('run: --config <runner config.json> (the model and the harness are the user\'s own)');
  const { validateConfig } = require('./lib/autotrader');
  const cfg = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  if (arg(argv, '--harness')) cfg.harness = arg(argv, '--harness');
  const dir = outDir(arg(argv, '--out'));
  const { value, asked } = build(dir);
  const k = Number(arg(argv, '--k') || value.k);
  if (!(Number.isInteger(k) && k >= 1)) throw new Error('--k: a whole number, 1 or more');
  const only = arg(argv, '--only') ? arg(argv, '--only').split(',') : null;
  const file = path.join(dir, 'answers.jsonl');
  const done = new Set(readRows(file).filter(r => !r.error).map(r => `${r.id}:${r.k}`));
  // No project, no memory: each question runs in an empty directory of the output's own.
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  for (const q of asked) {
    if (only && !only.includes(q.id)) continue;
    for (let i = 1; i <= k; i += 1) {
      if (done.has(`${q.id}:${i}`)) continue;
      const [bin, ...args] = Q.quizCommand(cfg, q.text, path.join(dir, fileOf(q.prompt)));
      const t = Date.now();
      const r = spawnSync(bin, args, { cwd: empty, encoding: 'utf8' });
      const reply = r.error ? { answer: r.error.message, error: true } : Q.replyOf(cfg, r.stdout);
      fs.appendFileSync(file, `${JSON.stringify({ id: q.id, k: i, ms: Date.now() - t, ...reply })}\n`);
      console.log(q.id, i, reply.error ? 'error' : 'ok');
    }
  }
  grade(dir);
}

function grade(dir) {
  const quiz = Q.loadQuiz().value;
  const all = [...quiz.questions, ...quiz.partB];
  const graded = readRows(path.join(dir, 'answers.jsonl')).filter(r => !r.error).map(r => {
    const q = all.find(x => x.id === r.id);
    return q ? { ...Q.gradeAnswer(quiz, q, r.answer), k: r.k, answer: r.answer } : null;
  }).filter(Boolean);
  fs.writeFileSync(path.join(dir, 'grades.json'), `${JSON.stringify(graded, null, 1)}\n`);
  const k = Math.max(1, ...graded.map(g => g.k));
  const s = Q.summarize(quiz, graded, k);
  fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(s, null, 1)}\n`);
  for (const p of ['partA', 'partB']) {
    for (const x of s[p].per) console.log(`${x.id}\t${x.layer}\t${x.passes}/${x.n}${x.bothWays ? '\tanswered both ways' : ''}`);
    console.log(`${p}: ${s[p].allCorrect} correct on all ${k}, ${s[p].bothWays} answered both ways, ${s[p].total} of ${s[p].asked}`);
  }
  console.log(s.meetsBar ? 'meets the bar' : 'below the bar');
  return s;
}

function compare(a, b) {
  const sum = d => JSON.parse(fs.readFileSync(path.join(path.resolve(d), 'summary.json'), 'utf8'));
  for (const x of Q.compare(sum(a), sum(b))) console.log(`${x.id}\t${x.from} -> ${x.to}${x.delta ? `  ${x.delta > 0 ? '+' : ''}${x.delta}` : ''}`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'build') return build(outDir(arg(rest, '--out')));
  if (cmd === 'run') return run(rest);
  if (cmd === 'grade' && rest[0]) return grade(path.resolve(rest[0]));
  if (cmd === 'compare' && rest[0] && rest[1]) return compare(rest[0], rest[1]);
  throw new Error('usage: context-quiz.js build --out <dir> | run --config <file> --out <dir> [--harness <name>] [--k N] [--only ids] | grade <dir> | compare <a> <b>');
}

if (require.main === module) {
  const [, , ...args] = process.argv;
  try { main(args); } catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { main };
