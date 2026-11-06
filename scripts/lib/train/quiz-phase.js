'use strict';

/**
 * The quiz gate in the probe round (Propose-Probe-Compose, docs/TRAINING.md): between an edit's checks and its replay,
 * its tree is quizzed (config/context-quiz.json, eval/quiz-run.js), so a weak edit dies in minutes, before hours of
 * replay. Per edit, in order, each step failing closed:
 *
 *   question   its own question (probe-question.js) against both trees' prompts: the anchor in the edit's, not the
 *              champion's, no new number; checked before any model call
 *   red/green  that question alone, questionRuns runs a side: the champion's share of right answers at most
 *              redMaxShare (it must fail it: else no edit is needed or the question is too easy), the edit's at least
 *              greenMinShare (else the edit does not teach its own question)
 *   regression the whole quiz on the edit's tree against the champion's (train/quiz-gate.js decide, its statistics
 *              unchanged): a `confirm` asks the flagged ids again, confirmRuns more on BOTH trees, in fresh directories
 *              (never the first runs: the flag selected on them), then decides again
 * A summary short of its runs (a run that kept failing) is retried once, then the edit is blocked: inconclusive is never
 * a pass. A consolidation (probe-question.js isConsolidation) has no question and no red/green, and is judged by the
 * quiz's own gate. An edit whose target no quiz prompt holds (an analyst's or the executor's text: every prompt the quiz
 * and its question are asked of byte-identical on both trees) is NOT_QUIZZED: no model call, replayed as before the gate,
 * never counted a pass. Only `pass` and NOT_QUIZZED go on to the replay. The champion's quiz runs once a round, in a
 * directory keyed by its tree's digest and the quiz's hash, so a resumed or later round asks it nothing new. Every model
 * call is the quiz runner's (`run`, the loop's `quizRun` step), each ask charged to the loop's model calls first
 * (ctx.call, the runner's onCall: the budget stops a quiz mid-run); the verdicts are code's.
 *
 *   gateEdit({ quiz, hash, question, championRoot, editRoot, dir, run, prompts, champion })
 *        { verdict: 'pass' | 'reject' | 'blocked', stage, why, regressions, flagged, slips, gains, redGreen, asked }
 *        run(opts) -> a quiz summary (eval/quiz-run.js runQuiz); prompts(root, quiz) -> the tree's prompts;
 *        champion({ retry }) -> the champion's whole-quiz summary
 *   redGreen(gate, champion, edit, id)       { red, green, champion: 'p/n', edit: 'p/n', problems }
 *   samePrompts(a, b)                        [bool] two trees' prompts the same keys, each text byte-equal
 *   quizRound(ctx, { n, champion, edits, api, work, dir, lessonsFile, lessonWindows, seed, cfg })
 *        { passed, report }: the round's phases (`${n}:quiz-champion`, `${n}:quiz:<id>`), each a file in the round's
 *        directory; a stopped edit (reject, blocked) gets a lessons line (lessons.js appendQuiz), a NOT_QUIZZED one none.
 *        The loop config's quizGate: false (only explicitly) passes every edit, and the report says so
 */

const crypto = require('crypto');
const path = require('path');
const Q = require('../eval/context-quiz');
const { decide } = require('./quiz-gate');
const PQ = require('./probe-question');
const LS = require('./lessons');
const AE = require('./agent-edit');
const { dirDigest, writeJsonAtomic, readJson } = require('../harness-run');

const OFF = 'the quiz gate is off (the loop config\'s quizGate: false): no edit was quizzed';
const SWITCH = '(the loop config\'s quizGate: false turns the gate off)';
const label = s => `${s.passes}/${s.n}`;
// An edit whose target no quiz prompt holds: replayed unquizzed, counted apart from the gate's verdicts.
const NOT_QUIZZED = 'not-quizzed';
const NOT_HELD = 'no quiz prompt holds this target: not quizzed';
/**
 * Whether a proposal's target is one no quiz prompt carries: every file it edits an agents/<role>.md of an editable role
 * whose text no prompt holds (an analyst's, the executor's; never the head trader's or the risk manager's, never a
 * skills/ file). Anything else, or a malformed proposal: false (quizzed).
 */
function unquizzedTarget(proposal) {
  const edits = proposal && Array.isArray(proposal.edits) ? proposal.edits : [];
  return edits.length > 0 && edits.every(x => {
    const role = x && typeof x.file === 'string' ? AE.roleOfFile(x.file) : null;
    return Boolean(role) && !Q.PROMPT_ROLES.includes(role);
  });
}
/** Two trees' prompts the same, key by key (the same keys, each text byte-equal). */
function samePrompts(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => typeof a[k] === 'string' && a[k] === b[k]);
}
// A consolidation's red/green, as the report and the lessons record say it.
const SKIPPED = 'skipped (removal)';
/** A directory's tag from a text: its digest, its length capped. */
const tagOf = text => crypto.createHash('sha256').update(String(text)).digest('hex').match(/^[0-9a-f]{12}/)[0];

function rowOf(summary, id) {
  const rows = summary && summary.partA && Array.isArray(summary.partA.per) ? summary.partA.per : [];
  return rows.find(x => x.id === id) || { passes: 0, n: 0 };
}

function redGreen(g, champion, edit, id) {
  const c = rowOf(champion, id);
  const e = rowOf(edit, id);
  const problems = [];
  if (c.n < g.questionRuns) problems.push(`the edit's question has ${label(c)} runs on the champion, under questionRuns ${g.questionRuns}`);
  if (e.n < g.questionRuns) problems.push(`the edit's question has ${label(e)} runs on the edit, under questionRuns ${g.questionRuns}`);
  return { champion: label(c), edit: label(e), red: c.n > 0 && c.passes / c.n <= g.redMaxShare, green: e.n > 0 && e.passes / e.n >= g.greenMinShare, problems };
}

async function gateEdit({ quiz, hash, question, consolidation = false, championRoot, editRoot, dir, run, prompts, champion }) {
  const g = quiz.gate || {};
  if (![g.redMaxShare, g.greenMinShare, g.questionRuns].every(x => typeof x === 'number')) throw new Error('quiz gate: the quiz file has no red/green thresholds (config/context-quiz.json "gate")');
  // A consolidation teaches nothing new: no question and no red/green; the whole quiz under the quiz's own gate (a
  // stricter copy would reject most edits that change nothing, on the noise of the questions' own rates).
  const out = { verdict: 'blocked', stage: consolidation ? 'regression' : 'question', why: '', quizHash: hash, regressions: [], flagged: [], slips: [], gains: [], redGreen: consolidation ? SKIPPED : null, asked: 0 };
  const done = (verdict, why) => Object.assign(out, { verdict, why });
  const side = async (root, texts, sub, doc, k, only = null) => {
    const s = await run({ root, quiz: doc, hash, k, only, dir: path.join(dir, sub), prompts: texts });
    out.asked += s.asked || 0;
    return s;
  };
  const built = (root, doc) => { try { return prompts(root, doc); } catch (err) { throw Object.assign(new Error(`the prompts could not be built: ${err.message}`), { blocked: true }); } };
  try {
    if (!consolidation) {
      // The question, against both trees' prompts, before any model call.
      const mini = PQ.miniQuiz(quiz, question);
      const ep = built(editRoot, mini);
      const cp = built(championRoot, mini);
      const errs = PQ.anchorErrors(question, { editPrompts: ep, championPrompts: cp, maxLineChars: g.maxGradedLineChars });
      if (errs.length) return done('blocked', errs.join('; '));
      // Red/green: the champion fails it, the edit passes it.
      out.stage = 'red-green';
      const rg = async () => redGreen(g, await side(championRoot, cp, 'red', mini, g.questionRuns), await side(editRoot, ep, 'green', mini, g.questionRuns), question.id);
      let r = await rg();
      if (r.problems.length) r = await rg();
      const { problems, ...shown } = r;
      out.redGreen = shown;
      if (problems.length) return done('blocked', `inconclusive after one retry: ${problems.join('; ')}`);
      if (!r.red) return done('blocked', 'the champion already answers the question: no edit is needed or the question is too easy');
      if (!r.green) return done('blocked', 'the edit does not teach its own question');
    }
    // The whole quiz against the champion's.
    out.stage = 'regression';
    const full = built(editRoot, quiz);
    let c = await champion({ retry: false });
    let e = await side(editRoot, full, 'edit', quiz, quiz.k);
    let confirm = null;
    let ids = null;
    let retried = false;
    const confirmRuns = async () => {
      const cf = built(championRoot, quiz);
      return { champion: await side(championRoot, cf, 'confirm-champion', quiz, g.confirmRuns, ids), edit: await side(editRoot, full, 'confirm-edit', quiz, g.confirmRuns, ids) };
    };
    let d = decide(quiz, c, e, { quizHash: hash });
    for (;;) {
      if (d.verdict === 'confirm' && !confirm) {
        ids = d.confirm.ids;
        confirm = await confirmRuns();
      } else if (d.verdict === 'inconclusive' && !retried) {
        // The missing runs asked once more (a finished run is never asked again), both trees, the confirm runs too.
        retried = true;
        c = await champion({ retry: true });
        e = await side(editRoot, full, 'edit', quiz, quiz.k);
        if (confirm) confirm = await confirmRuns();
      } else break;
      d = decide(quiz, c, e, { quizHash: hash, confirm });
    }
    Object.assign(out, { regressions: d.regressions, flagged: d.flagged, slips: d.slips, gains: d.gains });
    if (d.verdict === 'pass' || d.verdict === 'reject') return done(d.verdict, d.why);
    return done('blocked', `${d.verdict === 'inconclusive' ? 'inconclusive after one retry' : 'a confirm run is still needed'}: ${d.why}`);
  } catch (err) {
    if (!err.blocked) throw err;
    return done('blocked', err.message);
  }
}

/** The lessons line of an edit the gate stopped (once: a resume finds it by iteration, id and its quiz verdict). */
function quizLesson(file, e, r, { n, windows, seed }) {
  if (LS.readLessons(file).some(l => l.iteration === n && l.proposalId === e.id && typeof l.quiz === 'string')) return;
  const tag = e.tag || {};
  LS.appendQuiz(file, {
    proposalId: e.id, iteration: n, ...(tag.agent ? { agent: tag.agent } : { skill: tag.skill }), kind: tag.kind,
    ...(e.finding ? { finding: { id: e.finding.id, kind: e.finding.kind }, findingKind: e.finding.kind } : {}), windows, seed, quiz: r.verdict, why: r.why,
    ...(typeof r.redGreen === 'string' ? { redGreen: r.redGreen } : {}),
  });
}

async function quizRound(ctx, { n, champion, edits, api, work, dir, lessonsFile, lessonWindows, seed, cfg }) {
  if (ctx.loop.quizGate === false) {
    ctx.log(`iteration ${n}: ${OFF}`);
    return { passed: edits, report: { off: true, why: OFF } };
  }
  const report = { quizHash: null, champion: null, edits: {} };
  if (!edits.length) return { passed: [], report };
  const { value: quiz, hash } = (ctx.steps.loadQuiz || Q.loadQuiz)();
  report.quizHash = hash;
  // Every ask charged to the loop's model calls (ctx.call: the budget checked first), so the limit stops a quiz mid-run.
  const run = opts => ctx.steps.quizRun({ ...opts, cfg, onCall: ctx.call });
  const prompts = ctx.steps.quizPrompts || Q.buildPrompts;
  // A runner config the quiz cannot ask (a harness that takes no system-prompt file): every edit blocked, said so.
  let refused = null;
  try { Q.quizCommand(cfg, 'check', 'check.md'); } catch (err) { refused = `the quiz could not run: ${err.message} ${SWITCH}`; }
  // The champion's quiz: one directory per tree and quiz, so a resumed or later round asks it nothing new.
  const key = tagOf(JSON.stringify([dirDigest(champion.dir), hash, quiz.k]));
  const champDir = path.join(ctx.paths.dir, 'quiz', `champion-${key}`);
  const champFile = path.join(dir, 'quiz-champion.json');
  let memo = null;
  const championQuiz = async ({ retry = false } = {}) => {
    if (memo && !retry) return memo;
    const once = async () => { ctx.check(); return run({ root: champion.dir, quiz, hash, k: quiz.k, dir: champDir, prompts: prompts(champion.dir, quiz) }); };
    if (!retry) memo = await api.phase(ctx, `${n}:quiz-champion`, champFile, once);
    else { memo = await once(); writeJsonAtomic(champFile, memo); }
    report.champion = { dir: path.relative(ctx.paths.dir, champDir), asked: memo.asked || 0 };
    return memo;
  };
  // A verdict recorded under another quiz is redone (its phase file is never reused across quizzes).
  const fresh = (phaseKey, file) => {
    const old = ctx.state.done[phaseKey] ? readJson(file, null) : null;
    if (old && old.quizHash !== hash) { ctx.state.done[phaseKey] = false; ctx.save(); }
  };
  fresh(`${n}:quiz-champion`, champFile);
  const passed = [];
  for (const e of edits) {
    const phaseKey = `${n}:quiz:${e.id}`;
    const file = path.join(dir, `quiz-${e.id}.json`);
    fresh(phaseKey, file);
    const r = await api.phase(ctx, phaseKey, file, async () => {
      // A consolidation (a pure deletion: probe-question.js isConsolidation) has no question of its own.
      const consolidation = PQ.isConsolidation(e, champion.dir, { negations: quiz.negations, restrictions: quiz.restrictions, polar: quiz.polar });
      const blocked = why => ({ verdict: 'blocked', stage: 'question', why, quizHash: hash, regressions: [], flagged: [], slips: [], gains: [], redGreen: consolidation ? SKIPPED : null, asked: 0 });
      const qe = consolidation ? [] : PQ.questionErrors(e.question, quiz.gate);
      if (qe.length) return blocked(qe.join('; '));
      ctx.check();
      const tree = await api.candidateTree(ctx, { dir: work, id: `p-${e.id}`, proposal: e.proposal, champion });
      // A target no quiz prompt holds (an analyst's or the executor's text): both conditions, failing closed: every file
      // it edits such a role's (unquizzedTarget; a skills/ file is always quizzed, a skill the head reads as needed too),
      // and every prompt the quiz (and the edit's own question) is asked of the same on both trees: not quizzed.
      const asked = consolidation ? quiz : { ...quiz, questions: [...quiz.questions, PQ.questionOf(e.question, e.id)] };
      let same;
      try { same = unquizzedTarget(e.proposal) && samePrompts(prompts(champion.dir, asked), prompts(tree.dir, asked)); } catch (err) { return blocked(`the prompts could not be built: ${err.message}`); }
      if (same) return { verdict: NOT_QUIZZED, stage: 'target', why: NOT_HELD, quizHash: hash, regressions: [], flagged: [], slips: [], gains: [], redGreen: null, asked: 0 };
      // A harness the quiz cannot ask: an edit it would quiz is blocked (an unquizzed one above needs no quiz).
      if (refused) return blocked(refused);
      // The edit's runs keyed by the quiz's hash too: a changed quiz never regrades old answers.
      return gateEdit({ quiz, hash, question: consolidation ? null : PQ.questionOf(e.question, e.id), consolidation, championRoot: champion.dir, editRoot: tree.dir, dir: path.join(dir, 'quiz', e.id, tagOf(hash)), run: async o => { ctx.check(); return run(o); }, prompts, champion: championQuiz });
    });
    report.edits[e.id] = r;
    ctx.log(`iteration ${n}: quiz gate ${e.id}: ${r.verdict}${r.why ? `: ${r.why}` : ''}`);
    // Not quizzed goes on to the replay as before the gate (its probe's lessons line is the replay's); never a pass.
    if (r.verdict === 'pass' || r.verdict === NOT_QUIZZED) passed.push(e);
    else quizLesson(lessonsFile, e, r, { n, windows: lessonWindows, seed });
  }
  if (memo && !report.champion) report.champion = { dir: path.relative(ctx.paths.dir, champDir), asked: memo.asked || 0 };
  return { passed, report };
}

module.exports = { OFF, NOT_QUIZZED, NOT_HELD, gateEdit, redGreen, samePrompts, unquizzedTarget, quizRound };
