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
 *   node scripts/context-quiz.js gate <champion dir> <edit dir> [--confirm <champion dir> <edit dir>]
 *       a proposed edit against the champion (train/quiz-gate.js): exit 0 pass, 1 reject, 2 inconclusive, 3 confirm run needed, 4 usage
 */

const fs = require('fs');
const path = require('path');
const Q = require('./lib/eval/context-quiz');
const QR = require('./lib/eval/quiz-run');

const ROOT = path.resolve(__dirname, '..');
const arg = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const { fileOf } = QR; // a situational or lookup question's own prompt file

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

/** The runner is the library's (eval/quiz-run.js); here each run is asked once: an error is recorded, not asked again. */
async function run(argv) {
  const configPath = arg(argv, '--config');
  if (!configPath) throw new Error('run: --config <runner config.json> (the model and the harness are the user\'s own)');
  const { validateConfig } = require('./lib/autotrader');
  const cfg = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  if (arg(argv, '--harness')) cfg.harness = arg(argv, '--harness');
  const dir = outDir(arg(argv, '--out'));
  const { value } = build(dir);
  const k = Number(arg(argv, '--k') || value.k);
  if (!(Number.isInteger(k) && k >= 1)) throw new Error('--k: a whole number, 1 or more');
  const only = arg(argv, '--only') ? arg(argv, '--only').split(',') : null;
  await QR.runQuiz({ root: ROOT, quiz: value, hash: Q.loadQuiz().hash, cfg, k, only, dir, reask: 0, log: (id, i, how) => console.log(id, i, how) });
  grade(dir);
}

function grade(dir) {
  const { value: quiz, hash } = Q.loadQuiz();
  const all = [...quiz.questions, ...quiz.partB];
  const graded = readRows(path.join(dir, 'answers.jsonl')).filter(r => !r.error).map(r => {
    const q = all.find(x => x.id === r.id);
    return q ? { ...Q.gradeAnswer(quiz, q, r.answer), k: r.k, answer: r.answer } : null;
  }).filter(Boolean);
  fs.writeFileSync(path.join(dir, 'grades.json'), `${JSON.stringify(graded, null, 1)}\n`);
  const k = Math.max(1, ...graded.map(g => g.k));
  const s = { ...Q.summarize(quiz, graded, k), quizHash: hash };
  fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(s, null, 1)}\n`);
  for (const p of ['partA', 'partB']) {
    for (const x of s[p].per) console.log(`${x.id}\t${x.layer}\t${x.passes}/${x.n}${x.bothWays ? '\tanswered both ways' : ''}${x.pending ? '\tpending (not in the bar)' : ''}`);
    console.log(`${p}: ${s[p].allCorrect} correct on all ${k}, ${s[p].bothWays} answered both ways, ${s[p].total} of ${s[p].asked}`);
  }
  console.log(s.meetsBar ? 'meets the bar' : 'below the bar');
  return s;
}

function compare(a, b) {
  const sum = d => JSON.parse(fs.readFileSync(path.join(path.resolve(d), 'summary.json'), 'utf8'));
  for (const x of Q.compare(sum(a), sum(b))) console.log(`${x.id}\t${x.from} -> ${x.to}${x.delta ? `  ${x.delta > 0 ? '+' : ''}${x.delta}` : ''}`);
}

/** The gate's verdicts in exit-code order: 0 pass, 1 reject, 2 inconclusive, 3 confirm; a usage error is the next code after them. */
const VERDICTS = Object.freeze(['pass', 'reject', 'inconclusive', 'confirm']);

/** A proposed skill edit's quiz against the champion's, by the quiz file's gate; the exit code is the verdict. */
function gate(rest) {
  const at = rest.indexOf('--confirm');
  // exactly <champion dir> <edit dir>, or those and --confirm <champion dir> <edit dir>: a pair of directories, twice
  const pair = ['champion dir', 'edit dir'];
  const shape = at < 0 ? rest.length === pair.length : at === pair.length && rest.length === pair.length * 2 + 1;
  if (!shape) { console.error('usage: context-quiz.js gate <champion dir> <edit dir> [--confirm <champion dir> <edit dir>]'); process.exitCode = VERDICTS.length; return; }
  const [a, b] = rest;
  const more = at >= 0 ? rest.slice(at + 1) : [];
  // An unreadable summary.json, or a quiz file that does not load, is no verdict (inconclusive), never a reject.
  const sum = d => { try { return JSON.parse(fs.readFileSync(path.join(path.resolve(d), 'summary.json'), 'utf8')); } catch (_e) { return null; } };
  let r;
  try {
    const { value, hash } = Q.loadQuiz();
    const confirm = more.length ? { champion: sum(more[0]), edit: sum(more[1]) } : null;
    r = require('./lib/train/quiz-gate').decide(value, sum(a), sum(b), { confirm, quizHash: hash });
  } catch (e) {
    console.error(`inconclusive: the gate could not run: ${e.message}`);
    process.exitCode = VERDICTS.indexOf('inconclusive');
    return;
  }
  console.log(`${r.verdict}: ${r.why}`);
  for (const [name, list] of [['regressions', r.regressions], ['flagged', r.flagged], ['slips', r.slips], ['gains', r.gains]]) {
    if (list.length) console.log(`${name}:\n${list.map(x => `  ${x.id}\t${x.from} -> ${x.to}${x.p !== undefined ? `  p ${x.p}` : ''}`).join('\n')}`);
  }
  if (r.confirm) console.log(`next: on both trees, run --only ${r.confirm.ids.join(',')} --k ${r.confirm.runs} into a new dir each, then gate again with --confirm <champion dir> <edit dir>`);
  process.exitCode = VERDICTS.indexOf(r.verdict);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'build') return build(outDir(arg(rest, '--out')));
  if (cmd === 'run') return run(rest);
  if (cmd === 'grade' && rest[0]) return grade(path.resolve(rest[0]));
  if (cmd === 'compare' && rest[0] && rest[1]) return compare(rest[0], rest[1]);
  if (cmd === 'gate') return gate(rest);
  throw new Error('usage: context-quiz.js build --out <dir> | run --config <file> --out <dir> [--harness <name>] [--k N] [--only ids] | grade <dir> | compare <a> <b> | gate <champion dir> <edit dir> [--confirm <champion dir> <edit dir>]');
}

if (require.main === module) {
  const [, , ...args] = process.argv;
  Promise.resolve().then(() => main(args)).catch(e => { console.error(e.message); process.exitCode = 1; });
}

module.exports = { main };
