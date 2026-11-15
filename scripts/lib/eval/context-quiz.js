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
 *   questionErrors(q, { part, at, ids, gate })   [problem] for one question, as quizErrors names them (a probe edit's
 *                                      own question); gate: the quiz file's, whose minChoices and maxChoices bound a
 *                                      choice question (none given: a choice question is refused)
 *   buildPrompts(root, quiz)           { head, 'head+risk', 'situational:<id>', 'lookup:<id>' }: the head trader's index-mode
 *                                      prompt (head-prompt.js claudeHeadText) and that plus the risk manager's (role-prompt.js
 *                                      claudeRoleText) with its agent body; a lookup question's: the head prompt plus the
 *                                      skills it names (`lookup`) as skill_lookup returns them, whole (a skill the head
 *                                      reads as needed, not embedded: candle-reading's reaction read)
 *   excerptOf(excerpt)                 Part B's briefing excerpt: the Bias line (bias-line.js), the Size and Min lines, or per
 *                                      case its Bias line and compose_check's REACTION line (reaction-echo.js)
 *                                      (prop/size-line.js), from the code that writes them
 *   questionText(quiz, q)              the text asked: the excerpt (Part B), the question, the answer format (a
 *                                      question's own `format`, or a choice question's naming its choices)
 *   answerLine(answer)                 { line, fmt }: the ANSWER line (fmt false: the first line, no ANSWER label)
 *   negated(line, index, negations, window)   a match at `index` negated within its clause (a negation word in the
 *                                      `window` words before it: the quiz file's negationWindow). A line-leading verdict
 *                                      ("No," "No -" "Not yet:" "Yes,": VERDICT) answers the question; it never negates
 *                                      the explanation after it
 *   gradeAnswer(quiz, q, answer)       { id, line, fmt, pass, miss, forb, unsure }: by its required and forbidden regexes,
 *                                      or a choice question (`choices`, `answer`) by the ANSWER line equal to its answer
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
const PROMPTS = Object.freeze(['head', 'head+risk', 'situational', 'lookup']);
// The roles whose text the prompts carry (buildPrompts): the head trader's, and the risk manager's in head+risk.
const PROMPT_ROLES = Object.freeze(['head-trader', 'risk-manager']);
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
  if (!(Array.isArray(v.polar) && v.polar.length && v.polar.every(w => typeof w === 'string' && /^[a-z']+$/.test(w)))) out.push('polar: a list of lower-case words (above, below, long, short, ...)');
  if (!(Array.isArray(v.conditions) && v.conditions.length && v.conditions.every(w => typeof w === 'string' && /^[a-z']+$/.test(w)))) out.push('conditions: a list of lower-case words (while, if, least, both, ...)');
  // The words whose change makes a probe edit teach (train/probe-question.js isConsolidation): it needs a question.
  if (!(Array.isArray(v.restrictions) && v.restrictions.length && v.restrictions.every(w => typeof w === 'string' && /^[a-z']+$/.test(w)))) out.push('restrictions: a list of lower-case words ("only", "must", "unless")');
  out.push(...regexErrors([v.unsure], 'unsure'));
  // The gate a proposed skill edit passes before any replay (train/quiz-gate.js): a question the champion answered every time
  // whose share drops by flagDrop or more is asked again (confirmRuns more); a regression needs an exact test at alpha; up to
  // maxSlips smaller drops are noise. A probe edit's own question (train/quiz-phase.js): the champion's share of passing
  // answers at most redMaxShare (it fails it), the edit's at least greenMinShare (it passes it), questionRuns runs a side;
  // the proposer's patterns at most maxPatternChars each, each required one holding a literal run of minLiteralRun letters
  // or digits (train/probe-question.js).
  const g = v.gate;
  const share = (x, lo, hi) => typeof x === 'number' && x >= lo && x <= hi;
  if (!isObj(g) || !(typeof g.flagDrop === 'number' && g.flagDrop > 0 && g.flagDrop <= 1) || !(typeof g.alpha === 'number' && g.alpha > 0 && g.alpha < 1) || !(Number.isInteger(g.maxSlips) && g.maxSlips >= 0) || !(Number.isInteger(g.confirmRuns) && g.confirmRuns >= 1)
    || !(share(g.redMaxShare, 0, 1) && g.redMaxShare < 1) || !(share(g.greenMinShare, 0, 1) && g.greenMinShare > 0) || !(g.redMaxShare < g.greenMinShare) || !(Number.isInteger(g.questionRuns) && g.questionRuns >= 1)
    || !(Number.isInteger(g.maxPatternChars) && g.maxPatternChars >= 1) || !(Number.isInteger(g.minLiteralRun) && g.minLiteralRun >= 1)
    || ![g.maxGaps, g.maxGapChars, g.maxOptionals, g.maxGroups].every(x => Number.isInteger(x) && x >= 0) || !(Number.isInteger(g.maxGradedLineChars) && g.maxGradedLineChars >= 1)
    || !(Number.isInteger(g.minChoices) && g.minChoices > 1 && Number.isInteger(g.maxChoices) && g.maxChoices >= g.minChoices)) {
    out.push('gate: { flagDrop: a share in (0, 1], alpha: in (0, 1), maxSlips: a whole number, 0 or more, confirmRuns: a whole number, 1 or more, redMaxShare: a share in [0, 1), greenMinShare: a share in (0, 1] above redMaxShare, questionRuns: a whole number, 1 or more, maxPatternChars: a whole number, 1 or more, minLiteralRun: a whole number, 1 or more, maxGaps, maxGapChars, maxOptionals, maxGroups: whole numbers, 0 or more, maxGradedLineChars: a whole number, 1 or more, minChoices: a whole number, 2 or more, maxChoices: a whole number, minChoices or more }');
  }
  const bar = v.passBar;
  if (!isObj(bar) || !['partA', 'partB'].every(p => isObj(bar[p]) && Number.isInteger(bar[p].allCorrect) && Number.isInteger(bar[p].bothWays))) out.push('passBar: { partA, partB } each { allCorrect, bothWays }');
  const ids = new Set();
  for (const [part, list] of [['questions', v.questions], ['partB', v.partB]]) {
    if (!Array.isArray(list) || !list.length) { out.push(`${part}: a list of questions`); continue; }
    list.forEach((q, i) => out.push(...questionErrors(q, { part, at: `${part}[${i}]`, ids, gate: g })));
  }
  return out;
}

/**
 * One question's problems, as the quiz file's check names them (`at` the name it is given). part: 'questions' (Part A:
 * an anchor) or 'partB' (an excerpt). ids: the ids seen so far (a repeated id is refused); its own id is added.
 */
function questionErrors(q, { part = 'questions', at = 'question', ids = new Set(), gate = null } = {}) {
  const out = [];
  if (!isObj(q)) return [`${at}: an object`];
  if (!str(q.id) || ids.has(q.id)) out.push(`${at}.id: unique, given`);
  ids.add(q.id);
  if (!LAYERS.includes(q.layer)) out.push(`${at}.layer: one of ${LAYERS.join(', ')}`);
  if (!PROMPTS.includes(q.prompt)) out.push(`${at}.prompt: one of ${PROMPTS.join(', ')}`);
  if (q.prompt === 'situational' && !(isObj(q.state) && Array.isArray(q.state.positions))) out.push(`${at}.state: the account state its situational skills are chosen for ({ positions, workingOrders, ... })`);
  if (q.prompt === 'lookup' && !(Array.isArray(q.lookup) && q.lookup.length && q.lookup.every(s => typeof s === 'string' && /^[a-z0-9-]+$/.test(s)))) out.push(`${at}.lookup: the skills the head trader looks up for it (skill names)`);
  for (const k of ['text', 'rule']) if (!str(q[k])) out.push(`${at}.${k}: given`);
  if ('layers' in q) {
    if (!(isObj(q.layers) && isObj(q.layers.structure))) out.push(`${at}.layers: the layer facts its text states ({ rthBars, structure: { side, level, ... }, behavior, chop, ... })`);
    else out.push(...layersErrors(q.layers).map(e => `${at}.${e}`));
  }
  if (part === 'questions' && !str(q.anchor)) out.push(`${at}.anchor: the phrase of the prompt that states the rule`);
  const caseOk = x => isObj(x) && isObj(x.bias) && ['tf', 'rel', 'dir', 'level', 'reaction'].every(k => str(x[k]));
  if (part === 'partB' && !(isObj(q.excerpt) && (isObj(q.excerpt.bias) || (isObj(q.excerpt.size) && isObj(q.excerpt.size.facts)) || (Array.isArray(q.excerpt.cases) && q.excerpt.cases.length && q.excerpt.cases.every(caseOk))))) out.push(`${at}.excerpt: { bias: { h4, h1, t15, declared } }, { size: { facts, riskUsd, minContracts, stretchUsd, capUsd } } or { cases: [{ bias, tf, rel, dir, level, reaction }] }`);
  // A closed-choice question (choices, answer, an optional format) is graded by equality, never by a regex; any other by
  // its required and forbidden regexes.
  if ('choices' in q) {
    // Its bounds are the quiz file's gate (minChoices, maxChoices): none given, none made up here.
    const lo = isObj(gate) ? gate.minChoices : undefined;
    const hi = isObj(gate) ? gate.maxChoices : undefined;
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return [...out, `${at}.choices: checked against the quiz file's gate.minChoices and gate.maxChoices (none given)`];
    const c = q.choices;
    const okList = Array.isArray(c) && c.length >= lo && c.length <= hi && c.every(str) && new Set(c.map(norm)).size === c.length;
    if (!okList) out.push(`${at}.choices: ${lo} to ${hi} distinct phrases`);
    if (!(okList && str(q.answer) && c.includes(q.answer))) out.push(`${at}.answer: one of its choices`);
    if ('format' in q && !str(q.format)) out.push(`${at}.format: the text appended to the question`);
    for (const k of ['required', 'forbidden']) if (k in q) out.push(`${at}.${k}: never with choices`);
    return out;
  }
  for (const k of ['answer', 'format']) if (k in q) out.push(`${at}.${k}: only with choices`);
  out.push(...regexErrors(q.required, `${at}.required`), ...regexErrors(q.forbidden, `${at}.forbidden`));
  if (Array.isArray(q.required) && !q.required.length) out.push(`${at}.required: at least one`);
  return out;
}

/**
 * A choice answer as compared: lower case, the markdown, quotes or brackets around it (` _ " ( ) *) and a trailing period
 * or ! dropped; never a character inside it ('F4, F3' and 'chop evidence (I think)' stay what they are). A number reads
 * by its value (round 17): 21462.50, 21462.5 and 21462.500 are one price; 21462.25 stays another.
 */
// A leading article (a, an, the) is ignored on both sides, every item alike (round 18, PREREG addendum 22).
const ARTICLE = /^(?:a|an|the)\s+/;
const norm = s => String(s).toLowerCase().replace(/^[\s`_"(*]+/, '').replace(/[\s`_")*.!]+$/, '').replace(ARTICLE, '')
  .replace(/\d+(?:\.\d+)?/g, n => String(Number(n)));
/** The line with its leading article dropped (markdown and quotes before it kept out), for free-text patterns. */
const dropArticle = line => String(line).replace(/^([\s`_"(*]*)(?:a|an|the)\s+/i, '$1');
/** The format line a choice question is asked with: its own, or its choices named. */
const choiceFormat = q => q.format || ` Answer from your instructions only. First line: ANSWER: <one of: ${q.choices.join(' | ')}>, nothing else. Second line: one short sentence why.`;

const loadQuiz = ({ file = null } = {}) => loadConfigFile({ name: 'context-quiz', validate: quizErrors }, { file });

/** The agent body (its frontmatter dropped). */
const agentBody = (root, name) => fs.readFileSync(path.join(root, 'agents', `${name}.md`), 'utf8').replace(/^---\n[^]*?\n---\n/, '');

/** The prompt a question is asked against: its `prompt`, or for a situational one its own (`situational:<id>`). */
const promptKey = q => (q.prompt === 'situational' || q.prompt === 'lookup' ? `${q.prompt}:${q.id}` : q.prompt);

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
  // A lookup question: the head prompt plus the skills it reads as needed, whole, as skill_lookup returns them.
  const HP = require('../head-prompt');
  for (const q of quiz ? [...quiz.questions, ...quiz.partB].filter(x => x.prompt === 'lookup') : []) {
    out[promptKey(q)] = `${head}\n\nYou looked up ${HP.andList(q.lookup)} (skill_lookup):\n\n${q.lookup.map(s => HP.block(s, HP.skillBody(root, s))).join('\n\n')}\n`;
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

// An item's synthetic briefing as the facts the Market state reads (quiz realism, feat/chop-read): the Bias line's 4h and
// 1h (neutral and no side yet: both range), the Pullback line, m3.lastBreak (each break's candle placed by the clock and
// its barsAgo), the Day so far line, the 3m CISD (its confirming candle's close), the initial balance, the price, the 15m
// frame's trend and its last break (the quiz's prose for the JSON fields, `m15.frame.trend: up`, `m15.lastBreak: last BOS
// up at 21500.00 (barsAgo 0)`), and the clock as the close.
const NUM = '(-?\\d+(?:\\.\\d+)?)';
const minOf = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
// The item's clock is New York time on a winter (EST) day, so the RTH pair (09:30 ET) and the ages read as live.
const MIDNIGHT_ET = Date.parse('2026-01-06T05:00:00.000Z');
const isoAt = min => new Date(MIDNIGHT_ET + min * 60000).toISOString();
// An item without bar data states its layer facts (round 20b, quiz realism): what its text describes (no leg holds,
// overlap high, efficiency low, a failed continuation, a broken protected level), as market-layers.js's m3.layers shape; every
// fact not stated is absent (false, null), so the line is built by the same code (market-state.js) as the live one.
const NO_FACTS = { ov: false, ef: false, fl: false, nd: false };
const NO_EVIDENCE = { bothWays: false, flip: false, failed: false };
// The facts that need another fact the line prints (a broken leg its flip, a behavior its words, a chop fact its number, a
// stale leg its bars): refused, never a crash or an "undefined" in the line.
function layersErrors(spec) {
  const out = [];
  const P = spec.structure;
  if (!(['up', 'down'].includes(P.side) && Number.isFinite(P.level))) out.push('layers.structure: side up or down and a level');
  const f = P.flip;
  if ((P.status === 'broken' || spec.transition) && !(isObj(f) && ['up', 'down'].includes(f.oldSide) && Number.isFinite(f.oldLevel))) out.push('layers.structure.flip: a broken leg or a transition states its flip ({ oldSide, oldLevel, barsAgo })');
  const b = spec.behavior;
  if (b !== undefined && b !== null && !(isObj(b) && str(b.word) && str(b.word15))) out.push('layers.behavior: its word and word15');
  const facts = isObj(spec.chop) && isObj(spec.chop.facts) ? spec.chop.facts : {};
  if ((facts.ov && !(isObj(b) && Number.isFinite(b.overlap))) || (facts.ef && !(isObj(b) && Number.isFinite(b.eff)))) out.push('layers.chop.facts: overlap and efficiency need the behavior\'s numbers');
  if (spec.stale && !Number.isInteger(P.sinceProgress)) out.push('layers.stale: needs the structure\'s sinceProgress (bars)');
  return out;
}

function layersOf(spec) {
  if (!isObj(spec) || !isObj(spec.structure)) throw new Error('context-quiz: layers needs its structure ({ side, level, ... })');
  const errs = layersErrors(spec);
  if (errs.length) throw new Error(`context-quiz: ${errs.join('; ')}`);
  const P = spec.structure;
  const c = isObj(spec.chop) ? spec.chop : {};
  const flip = isObj(P.flip) ? { barsAgo: 0, strong: false, disp: false, held: true, byRule: 'close', ...P.flip } : null;
  return {
    rthBars: Number.isInteger(spec.rthBars) ? spec.rthBars : 20,
    structure: { status: 'intact', legOK: false, sinceProgress: null, internal: 0, resumed: false, lastInternal: null, lastWay: null, flipsIn: 0, ...P, origin: Number.isFinite(P.origin) ? P.origin : P.level, flip },
    lastBreak: null,
    momentum: { dispAgainst: null, breakAgainst: null, trigger: false, loss: false, odf: false, od: null, ...(isObj(spec.momentum) ? spec.momentum : {}) },
    behavior: isObj(spec.behavior) ? spec.behavior : null,
    chop: { now: false, inChop: false, S: false, B: false, count: 0, ended: false, ...c, facts: { ...NO_FACTS, ...(isObj(c.facts) ? c.facts : {}) }, evidence: { ...NO_EVIDENCE, ...(isObj(c.evidence) ? c.evidence : {}) } },
    edges: isObj(spec.edges) ? spec.edges : null,
    pbPhase: null, transition: Boolean(spec.transition), stale: Boolean(spec.stale), reversal: false, pbRotation: false,
  };
}

function briefingOfText(text, layers = null) {
  const t = String(text || '');
  const bias = /\n- Bias: ([^\n]*)/.exec(t);
  if (!bias) return null;
  const fr = /\(4h (up|down|range), 1h (up|down|range)/.exec(bias[1]);
  const [h4, h1] = fr ? [fr[1], fr[2]] : /^(neutral|no side yet)/.test(bias[1]) ? ['range', 'range'] : [null, null];
  const clock = /synthetic, (\d{1,2}:\d{2}) ET/.exec(t);
  const now = clock ? minOf(clock[1]) : null;
  const m3 = {};
  const pb = new RegExp(`\\n- Pullback \\((\\w+), (long|short) leg ${NUM} -> ${NUM}\\): ([^\\n]*)`).exec(t);
  if (pb) {
    const small = new RegExp(`leg ${NUM}x ATR\\(14\\), under the`).exec(pb[5]);
    const depth = /depth (\d+)% of the leg/.exec(pb[5]);
    m3.pullback = { frame: pb[1], side: pb[2], leg: { origin: +pb[3], extreme: +pb[4], ...(small ? { atr: +small[1] } : {}) },
      depth: depth ? +depth[1] / 100 : null, pastOrigin: /given back past its origin/.test(pb[5]),
      // The leg's structure-frame swing as printed (holds / broken by a close): a broken one invalidates the leg.
      swing: Object.fromEntries([...pb[5].matchAll(new RegExp(`(\\w+) ${NUM} (holds|broken by a close)`, 'g'))].map(m => [m[1], { price: +m[2], holds: m[3] === 'holds' }])) };
  }
  const brk = (kind, dir, level, ago) => ({ kind, direction: dir, level: +level, barsAgo: +ago, ...(now !== null ? { at: isoAt(now - 3 * (+ago + 1)) } : {}) });
  // The last break's protected swing in the quiz's prose (`; protected low 21480.25[, broken at 10:39]`; the live briefing
  // prints m3.lastBreak.last.protected as JSON): its level and the first close through it.
  const lb = new RegExp(`\\n- m3\\.lastBreak: last (BOS|CHoCH) (up|down) at ${NUM} \\(barsAgo (\\d+)(?:; protected (low|high) ${NUM}(?:, broken at (\\d{1,2}:\\d{2}))?)?\\)(?:, previous (BOS|CHoCH) (up|down) at ${NUM} \\(barsAgo (\\d+)\\))?`).exec(t);
  if (lb) {
    const prot = lb[5] ? { protected: { side: lb[5], level: +lb[6], at: null, brokenAt: lb[7] ? isoAt(minOf(lb[7])) : null } } : {};
    m3.lastBreak = { last: { ...brk(lb[1], lb[2], lb[3], lb[4]), ...prot }, previous: lb[8] ? brk(lb[8], lb[9], lb[10], lb[11]) : null };
  }
  // `m3.lastBreak: none since the RTH open` (round 17, q95): the item states its RTH breaks, none (the live JSON's breaks
  // all premarket, or none).
  const none = /\n- m3\.lastBreak: none since the RTH open/.test(t);
  if (none && !lb) m3.lastBreak = { last: null, previous: null };
  const day = /\n- Day so far \([^\n]*?\): (rotational|mixed|directional|too early)[^\n]*?RTH VWAP crosses (\d+)/.exec(t);
  const today = {};
  if (day) today.soFar = day[1] === 'too early' ? { status: 'too early', vwapCrosses: +day[2] } : { status: 'read', read: day[1], vwapCrosses: +day[2] };
  const ib = new RegExp(`initial balance ${NUM}-${NUM}`).exec(t);
  if (ib) Object.assign(today, { ibLow: +ib[1], ibHigh: +ib[2] });
  if (Object.keys(today).length) m3.today = today;
  const cisd = /\n- CISD \([^\n]*?: 3m (bullish|bearish) at [\d.]+ \(closed (\d{1,2}:\d{2}), (strong|weak)\)[^;\n]*?(waiting|touched|bounced|void|expired|no zone)/.exec(t);
  if (cisd) m3.cisd = { '3m': { dir: cisd[1], confirmedClose: isoAt(minOf(cisd[2])), status: cisd[3] === 'weak' || cisd[4] === 'no zone' ? 'weak' : cisd[4] } };
  const price = new RegExp(`\\n- Price ${NUM}`).exec(t);
  if (price) m3.price = +price[1];
  const h1Data = { ...(h4 ? { h4: { trend: h4 } } : {}), ...(h1 ? { h1: { trend: h1 } } : {}) };
  const t15 = /\n- m15\.frame\.trend: (up|down|range)/.exec(t);
  const lb15 = new RegExp(`\\n- m15\\.lastBreak: last (BOS|CHoCH) (up|down) at ${NUM} \\(barsAgo (\\d+)\\)`).exec(t);
  const m15 = {
    ...(t15 ? { frame: { trend: t15[1] } } : {}),
    // A 15m break's knownAt is its candle's close: barsAgo 0 closed by this clock, each one before a 15m candle earlier.
    ...(lb15 && now !== null ? { lastBreak: { last: { kind: lb15[1], direction: lb15[2], level: +lb15[3], knownAt: isoAt(now - 15 * +lb15[4]) }, previous: null } } : {}),
  };
  return {
    minutes: 3,
    // The clock as the close only where the item states its RTH breaks: both 3m breaks printed (the RTH pair reads them),
    // or none since the RTH open (forming); an item that leaves the line or the previous break out shows less, never
    // "not enough RTH structure".
    ...(now !== null && ((lb && lb[8]) || (none && !lb)) ? { closedAt: isoAt(now) } : {}),
    sections: { h1: { data: h1Data }, m3: { data: layers ? { ...m3, layers: layersOf(layers) } : m3 }, ...(Object.keys(m15).length ? { m15: { data: m15 } } : {}) },
  };
}

/**
 * The Market state line the live briefing would print for an item's synthetic lines (market-state.js; the briefing's
 * thresholds), with the item's layer facts when it states them (layersOf).
 */
function marketStateOfText(text, layers = null) {
  const b = briefingOfText(text, layers);
  if (!b) return null;
  const M = require('../trading/market-state');
  const an = require('../tunables').analysis();
  return M.marketStateLine(M.stateOf(b, M.stateThresholds(an)));
}

function excerptOf(excerpt) {
  if (isObj(excerpt.bias)) return [`${require('../trading/bias-line').biasLine(biasBriefing(excerpt.bias))}.`];
  // The attempt's facts and sizing are the quiz file's (the lines are the code's on them).
  if (isObj(excerpt.size)) return require('../prop/size-line').sizeLines(excerpt.size).map(l => `${l}.`);
  // Live context (round 8): per case its Bias line and the REACTION line compose_check gives for its read
  // (reaction-echo.js on a briefing holding that candle's relation and reaction): the lines the head sees.
  if (Array.isArray(excerpt.cases)) {
    const { echoLines } = require('../trading/reaction-echo');
    return excerpt.cases.map((x, i) => {
      const briefing = { sections: { m3: { data: { candles: { [x.tf]: { relations: [{ name: x.level, price: 0, rel: x.rel, dir: x.dir, reaction: x.reaction }] } } } } } };
      const echo = echoLines([{ read: `${x.tf} ${x.rel} ${x.level} ${x.dir}` }], briefing)[0] || '';
      return `Case ${i + 1}: ${require('../trading/bias-line').biasLine(biasBriefing(x.bias))}. compose_check on "${x.tf} ${x.rel} ${x.level} ${x.dir}": ${echo.replace(/^- /, '')}`;
    });
  }
  throw new Error('excerpt: { bias }, { size } or { cases }');
}

function questionText(quiz, q) {
  const head = q.excerpt ? `Briefing excerpt:\n${excerptOf(q.excerpt).join('\n')}\n\n` : '';
  return `${head}${q.text}${q.choices ? choiceFormat(q) : q.format || quiz.answerFormat}`;
}

function answerLine(answer) {
  const a = String(answer || '');
  const m = /^\s*\**\s*ANSWER\**\s*:?\**\s*(.*)$/mi.exec(a);
  return m ? { line: m[1].trim(), fmt: true } : { line: a.split('\n')[0].trim(), fmt: false };
}

// A line-leading verdict and its punctuation ("No," "No -" "Not yet:" "Not now," "**No**," "Yes."): the answer to the question, not a negation
// of what follows it ("No, go short now" is a short). "Not the same read" has no punctuation after it: a negation still.
const VERDICT = /^[\W_]*(?:no|nope|not(?: yet| now)?|yes|yep)\b[*_]*\s*[-–—,:;.!]+\s*/i; // markdown bold too: **No**,

function negated(line, index, negations, window) {
  const before = line.slice(0, index).replace(VERDICT, '');
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
  // A line past the gate's maxGradedLineChars is never graded (no pattern runs on it, nor on a cut of it, where a
  // forbidden phrase past the cut would hide): a fail, said so.
  const cap = quiz.gate.maxGradedLineChars;
  if (line.length > cap) return { id: q.id, line, fmt, pass: false, miss: q.choices ? [q.answer] : [...q.required], forb: [], unsure: false, why: `the answer line is longer than gate.maxGradedLineChars (${cap}): not graded, a fail` };
  // A choice question: the line equal to its answer (markdown, case and a trailing period aside), nothing else on it.
  if (q.choices) {
    const ok = norm(line) === norm(q.answer);
    return { id: q.id, line, fmt, pass: ok, miss: ok ? [] : [q.answer], forb: [], unsure: re(quiz.unsure).test(line) };
  }
  // Free text: a required pattern passes on the line with or without its leading article; a forbidden one fails on either.
  const lines = [...new Set([line, dropArticle(line)])];
  const miss = q.required.filter(src => !lines.some(l => re(src).test(l)));
  const forb = q.forbidden.filter(src => lines.some(l => matchesUnnegated(l, src, quiz.negations, quiz.negationWindow)));
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
    // An empty answer is no answer: an error (asked again), never graded as a wrong one.
    return { answer: String(d.result || ''), error: Boolean(d.is_error) || !String(d.result || '').trim() };
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

module.exports = { normChoice: norm, VERDICT, LAYERS, PROMPTS, PROMPT_ROLES, loadQuiz, quizErrors, questionErrors, promptKey, buildPrompts, excerptOf, briefingOfText, layersOf, marketStateOfText, questionText, answerLine, negated, gradeAnswer, summarize, compare, quizCommand, replyOf, anchorsMissing };
