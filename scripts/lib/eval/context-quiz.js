'use strict';

/**
 * The context quiz (config/context-quiz.json): questions the head trader, and with it the risk manager, must answer from
 * their prompts alone, built as the runner builds them, so a skill, rule or agent edit that leaves a rule unclear shows
 * up as a wrong or unstable answer. It calls a model, so it runs on demand (scripts/context-quiz.js), never in CI; CI
 * checks offline that each question's anchor phrase is in the prompt it is asked against. Pure, but for reading the repo
 * and the quiz file.
 *
 *   loadQuiz({ file })                 the quiz file, checked (config-files.js: fail closed): { value, hash }
 *   quizErrors(value)                  [problem] for a quiz document
 *   buildPrompts(root, quiz)           { head, 'head+risk', 'situational:<id>' }: the head trader's index-mode prompt (head-prompt.js
 *                                      claudeHeadText) and that plus the risk manager's (role-prompt.js claudeRoleText)
 *                                      with its agent body
 *   excerptOf(excerpt)                 Part B's briefing excerpt: the Bias line (bias-line.js) or the Size and Min lines
 *                                      (prop/size-line.js), from the code that writes them
 *   questionText(quiz, q)              the text asked: the excerpt (Part B), the question, the answer format
 *   answerLine(answer)                 { line, fmt }: the ANSWER line (fmt false: the first line, no ANSWER label)
 *   negated(line, index, negations, window)   a match at `index` negated within its clause (a negation word in the
 *                                      `window` words before it: the quiz file's negationWindow)
 *   gradeAnswer(quiz, q, answer)       { id, line, fmt, pass, miss, forb, unsure }
 *   summarize(quiz, rows, k)           per question { id, passes, n, allCorrect, bothWays }, per part totals, meetsBar
 *   compare(a, b)                      per question the change between two summaries: { id, from, to, delta }
 *   anchorsMissing(quiz, prompts)      the questions whose anchor is not in their prompt (CI, offline)
 *   quizCommand(cfg, text, file)       the argv asking one question headless, from the user's runner config
 *   replyOf(cfg, stdout)               { answer, error } from one reply
 */

const fs = require('fs');
const path = require('path');
const { loadConfigFile } = require('../config-files');

const LAYERS = Object.freeze(['bias', 'levels', 'setup', 'entry', 'stop', 'exit', 'size', 'approval']);
const PROMPTS = Object.freeze(['head', 'head+risk', 'situational']);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const str = x => typeof x === 'string' && x.length > 0;
const re = src => new RegExp(src, 'i');

function regexErrors(list, at) {
  if (!Array.isArray(list)) return [`${at}: a list of regex sources`];
  const out = [];
  list.forEach((src, i) => { try { re(src); } catch (e) { out.push(`${at}[${i}]: not a regex (${e.message})`); } if (!str(src)) out.push(`${at}[${i}]: empty`); });
  return out;
}

function quizErrors(v) {
  const out = [];
  if (!str(v.version)) out.push('version: a string');
  if (!(Number.isInteger(v.k) && v.k >= 1)) out.push('k: a whole number, 1 or more');
  if (!str(v.answerFormat)) out.push('answerFormat: the text appended to each question');
  if (!Array.isArray(v.negations) || !v.negations.every(str)) out.push('negations: a list of words');
  if (!(Number.isInteger(v.negationWindow) && v.negationWindow >= 1)) out.push('negationWindow: the words before a match a negation reaches');
  out.push(...regexErrors([v.unsure], 'unsure'));
  const bar = v.passBar;
  if (!isObj(bar) || !['partA', 'partB'].every(p => isObj(bar[p]) && Number.isInteger(bar[p].allCorrect) && Number.isInteger(bar[p].bothWays))) out.push('passBar: { partA, partB } each { allCorrect, bothWays }');
  const ids = new Set();
  for (const [part, list] of [['questions', v.questions], ['partB', v.partB]]) {
    if (!Array.isArray(list) || !list.length) { out.push(`${part}: a list of questions`); continue; }
    list.forEach((q, i) => {
      const at = `${part}[${i}]`;
      if (!isObj(q)) { out.push(`${at}: an object`); return; }
      if (!str(q.id) || ids.has(q.id)) out.push(`${at}.id: unique, given`);
      ids.add(q.id);
      if (!LAYERS.includes(q.layer)) out.push(`${at}.layer: one of ${LAYERS.join(', ')}`);
      if (!PROMPTS.includes(q.prompt)) out.push(`${at}.prompt: one of ${PROMPTS.join(', ')}`);
      if (q.prompt === 'situational' && !(isObj(q.state) && Array.isArray(q.state.positions))) out.push(`${at}.state: the account state its situational skills are chosen for ({ positions, workingOrders, ... })`);
      for (const k of ['text', 'rule']) if (!str(q[k])) out.push(`${at}.${k}: given`);
      if (part === 'questions' && !str(q.anchor)) out.push(`${at}.anchor: the phrase of the prompt that states the rule`);
      if (part === 'partB' && !(isObj(q.excerpt) && (isObj(q.excerpt.bias) || (isObj(q.excerpt.size) && isObj(q.excerpt.size.facts))))) out.push(`${at}.excerpt: { bias: { h4, h1, t15, declared } } or { size: { facts, riskUsd, minContracts, stretchUsd, capUsd } }`);
      out.push(...regexErrors(q.required, `${at}.required`), ...regexErrors(q.forbidden, `${at}.forbidden`));
      if (Array.isArray(q.required) && !q.required.length) out.push(`${at}.required: at least one`);
    });
  }
  return out;
}

const loadQuiz = ({ file = null } = {}) => loadConfigFile({ name: 'context-quiz', validate: quizErrors }, { file });

/** The agent body (its frontmatter dropped). */
const agentBody = (root, name) => fs.readFileSync(path.join(root, 'agents', `${name}.md`), 'utf8').replace(/^---\n[^]*?\n---\n/, '');

/** The prompt a question is asked against: its `prompt`, or for a situational one its own (`situational:<id>`). */
const promptKey = q => (q.prompt === 'situational' ? `situational:${q.id}` : q.prompt);

function buildPrompts(root, quiz = null) {
  const head = require('../head-prompt').claudeHeadText(root);
  const risk = `${agentBody(root, 'risk-manager')}\n${require('../role-prompt').claudeRoleText(root, 'risk-manager')}`;
  const out = { head, 'head+risk': `${head}\n${risk}` };
  // A situational question: the head prompt plus the situational skills the runner delivers for its state
  // (situational-skills.js, as a cycle of that state gets them; the head's every-cycle skills counted as loaded).
  const situational = quiz ? [...quiz.questions, ...quiz.partB].filter(q => q.prompt === 'situational') : [];
  if (situational.length) {
    const SS = require('../situational-skills');
    const A = require('../autotrader');
    const loaded = A.cycleLoaded(A.validateConfig({ harness: 'claude' }));
    for (const q of situational) out[promptKey(q)] = `${head}\n${SS.situationText(root, SS.choose(root, SS.factsOf({ state: q.state }), { loaded }))}`;
  }
  return out;
}

/** A briefing holding only the bias facts the Bias line reads. */
function biasBriefing({ h4, h1, t15, declared = false }) {
  const t = s => (s === 1 ? 'up' : s === -1 ? 'down' : 'range');
  const side = t15 === 1 ? 'long' : 'short';
  const facts = { regime: declared ? 'with' : 'against', vwapAtr: 1, ema20Atr: 1, dayMoveAtr: 1 };
  return {
    minutes: 3,
    sections: {
      m3: { data: { declared: { [side]: facts, [side === 'long' ? 'short' : 'long']: { ...facts, regime: 'against' } } } },
      m15: { data: { frame: { trend: t(t15) } } },
      h1: { data: { h4: { trend: t(h4) }, h1: { trend: t(h1) } } },
    },
  };
}

function excerptOf(excerpt) {
  if (isObj(excerpt.bias)) return [`${require('../trading/bias-line').biasLine(biasBriefing(excerpt.bias))}.`];
  // The attempt's facts and sizing are the quiz file's (the lines are the code's on them).
  if (isObj(excerpt.size)) return require('../prop/size-line').sizeLines(excerpt.size).map(l => `${l}.`);
  throw new Error('excerpt: { bias } or { size }');
}

function questionText(quiz, q) {
  const head = q.excerpt ? `Briefing excerpt:\n${excerptOf(q.excerpt).join('\n')}\n\n` : '';
  return `${head}${q.text}${quiz.answerFormat}`;
}

function answerLine(answer) {
  const a = String(answer || '');
  const m = /^\s*\**\s*ANSWER\s*:?\**\s*(.*)$/mi.exec(a);
  return m ? { line: m[1].trim(), fmt: true } : { line: a.split('\n')[0].trim(), fmt: false };
}

function negated(line, index, negations, window) {
  const before = line.slice(0, index);
  const clause = before.split(/[.;:!?]|,\s+(?:but|so|and)\b/).pop();
  const words = clause.toLowerCase().match(/[a-z']+/g) || [];
  return words.slice(-window).some(w => negations.includes(w) || w.endsWith("n't"));
}

/** Whether `src` matches `line` outside a negation (every match negated: no match). */
function matchesUnnegated(line, src, negations, window) {
  const g = new RegExp(src, 'gi');
  let m;
  while ((m = g.exec(line)) !== null) {
    if (!negated(line, m.index, negations, window)) return true;
    if (m[0] === '') g.lastIndex += 1;
  }
  return false;
}

function gradeAnswer(quiz, q, answer) {
  const { line, fmt } = answerLine(answer);
  const miss = q.required.filter(src => !re(src).test(line));
  const forb = q.forbidden.filter(src => matchesUnnegated(line, src, quiz.negations, quiz.negationWindow));
  return { id: q.id, line, fmt, pass: !miss.length && !forb.length, miss, forb, unsure: re(quiz.unsure).test(line) };
}

function summarize(quiz, rows, k = quiz.k) {
  const part = (list, bar) => {
    const per = list.map(q => {
      const g = rows.filter(r => r.id === q.id);
      const passes = g.filter(r => r.pass).length;
      return { id: q.id, layer: q.layer, passes, n: g.length, allCorrect: g.length >= k && passes === g.length, bothWays: passes > 0 && passes < g.length };
    });
    const allCorrect = per.filter(x => x.allCorrect).length;
    const bothWays = per.filter(x => x.bothWays).length;
    return { per, allCorrect, bothWays, total: per.reduce((n, x) => n + x.passes, 0), asked: per.reduce((n, x) => n + x.n, 0), meetsBar: allCorrect >= bar.allCorrect && bothWays <= bar.bothWays };
  };
  const a = part(quiz.questions, quiz.passBar.partA);
  const b = part(quiz.partB, quiz.passBar.partB);
  return { k, partA: a, partB: b, meetsBar: a.meetsBar && b.meetsBar };
}

/**
 * The argv that asks one question headless, from the user's runner config (its harness, model and extra arguments; no
 * model is named here): the prompt file as a system-prompt addition, no tools, no project settings, no session kept.
 * The custom harness: its own command with {prompt} and {system} filled in. Others: refused (they take no system file).
 */
function quizCommand(cfg, text, systemFile) {
  const model = cfg.model ? ['--model', String(cfg.model)] : [];
  const extra = (cfg.extraArgs || []).map(String);
  if (cfg.harness === 'claude') {
    return ['claude', '-p', text, '--append-system-prompt-file', systemFile, '--output-format', 'json', '--tools', '',
      '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', ...model, ...extra];
  }
  if (cfg.harness === 'custom' && Array.isArray(cfg.command) && cfg.command.length) return cfg.command.map(a => String(a).replace('{prompt}', text).replace('{system}', systemFile));
  throw new Error(`context quiz: the ${cfg.harness} harness takes no system-prompt file; use claude or the custom harness (its command with {prompt} and {system})`);
}

/** One reply as { answer, error }: claude's JSON result, or a command's stdout. */
function replyOf(cfg, stdout) {
  if (cfg.harness !== 'claude') return { answer: String(stdout || '').trim(), error: !String(stdout || '').trim() };
  try {
    const d = JSON.parse(stdout);
    return { answer: String(d.result || ''), error: Boolean(d.is_error) };
  } catch (_e) { return { answer: String(stdout || ''), error: true }; }
}

/** The questions whose anchor phrase is not in the prompt they are asked against (whitespace collapsed): [id]. */
function anchorsMissing(quiz, prompts) {
  const flat = t => String(t).replace(/\s+/g, ' ');
  const texts = Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, flat(v)]));
  return quiz.questions.filter(q => !texts[promptKey(q)] || !texts[promptKey(q)].includes(flat(q.anchor))).map(q => q.id);
}

function compare(a, b) {
  const of = s => [...s.partA.per, ...s.partB.per];
  const before = new Map(of(a).map(x => [x.id, x]));
  return of(b).map(x => {
    const y = before.get(x.id);
    const share = z => (z && z.n ? z.passes / z.n : null);
    return { id: x.id, from: y ? `${y.passes}/${y.n}` : '-', to: `${x.passes}/${x.n}`, delta: y ? Math.round((share(x) - share(y)) * 100) / 100 : null };
  });
}

module.exports = { LAYERS, PROMPTS, loadQuiz, quizErrors, promptKey, buildPrompts, excerptOf, questionText, answerLine, negated, gradeAnswer, summarize, compare, quizCommand, replyOf, anchorsMissing };
