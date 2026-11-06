'use strict';

/**
 * The quiz gate for a proposed skill edit: before any replay, the edited tree's quiz summary (eval/context-quiz.js
 * summarize) is held against the champion's. The quiz is a cheap, fast proxy for what the model reads from its skills;
 * trades decide, so this only filters: an edit that makes the model answer a rule worse is not worth the hours of a replay.
 * Pure: the model calls are the quiz runner's (scripts/context-quiz.js).
 *
 * 53 noisy questions at a few runs each make any per-question drop rule falsely reject an edit that changes nothing (a
 * multiple-comparisons trap: 30 to 80% in review at 3 runs). So, with the quiz file's `gate`:
 *   flagged    ANY question whose share dropped by flagDrop or more: asked again, `confirmRuns` more times on both sides
 *   regression a flagged question whose confirm runs ALONE (the flag selected on noise, so the first runs are not reused)
 *              are worse by an exact one-sided test at alpha shared out over the flagged questions (alpha / flagged), and
 *              whose pooled runs are worse by flagDrop or more: the edit is rejected
 *   slip       a smaller drop of a STABLE question (one the champion answered k of k; a flaky one has no baseline to lose),
 *              or a flagged one that did not confirm: noise, but more than maxSlips of them rejects
 *   gain       a question the edit answers better (listed)
 * Missing or corrupt input is inconclusive, never a pass; a rejection (a confirmed regression, too many slips) still wins.
 * Summaries, the confirm runs' too, must carry the quiz hash they were graded with, equal to the current quiz's
 * (`quizHash` is required: a stale pair can never pass), and the confirm runs must be at least confirmRuns a side.
 *
 *   decide(quiz, champion, edit, { confirm: { champion, edit } | null, quizHash })   quizHash: the current quiz's, required
 *        { verdict: 'pass' | 'reject' | 'confirm' | 'inconclusive', regressions, flagged, slips, gains, problems, confirm, why }
 *        each row { id, from: 'passes/n', to: 'passes/n', drop[, p] }; `confirm` { ids, runs } is what to ask next
 *   fisherLess(cPass, cN, ePass, eN)   P(the edit passes this few of its runs | the pooled rate), exact (hypergeometric)
 */

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const label = (passes, n) => `${passes}/${n}`;
const round3 = x => Math.round(x * 1000) / 1000;
const whole = x => Number.isInteger(x) && x >= 0;

function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  let s = 0;
  for (let i = 1; i <= k; i += 1) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

function fisherLess(cPass, cN, ePass, eN) {
  if (![cPass, cN, ePass, eN].every(whole) || cPass > cN || ePass > eN) throw new Error('fisherLess: whole counts, passes within runs');
  const total = cN + eN, passTotal = cPass + ePass;
  let p = 0;
  for (let x = Math.max(0, passTotal - cN); x <= ePass; x += 1) p += Math.exp(logChoose(passTotal, x) + logChoose(total - passTotal, eN - x) - logChoose(total, eN));
  return Math.min(1, p);
}

/** A summary's per-question rows, or null, plus what is wrong with them. */
function rowsOf(s, who, problems) {
  if (!isObj(s) || !isObj(s.partA) || !isObj(s.partB) || !Array.isArray(s.partA.per) || !Array.isArray(s.partB.per)) { problems.push(`no quiz summary for the ${who}`); return null; }
  const rows = [...s.partA.per, ...s.partB.per];
  const seen = new Set();
  for (const x of rows) {
    if (!isObj(x) || typeof x.id !== 'string' || !whole(x.passes) || !whole(x.n) || x.passes > x.n) { problems.push(`${who}: a corrupt row (${isObj(x) ? x.id : '?'})`); return null; }
    if (seen.has(x.id)) { problems.push(`${who}: ${x.id} twice`); return null; }
    seen.add(x.id);
  }
  return new Map(rows.map(x => [x.id, x]));
}

function decide(quiz, champion, edit, { confirm = null, quizHash = null } = {}) {
  if (!quizHash) throw new Error('quiz gate: decide needs the current quiz hash (a pair graded by an older quiz must never pass)');
  const g = quiz && quiz.gate;
  if (!isObj(g) || !(g.flagDrop > 0) || !(g.alpha > 0) || !Number.isInteger(g.maxSlips) || !Number.isInteger(g.confirmRuns)) throw new Error('quiz gate: the quiz file has no gate thresholds (config/context-quiz.json "gate")');
  const out = { verdict: 'inconclusive', regressions: [], flagged: [], slips: [], gains: [], problems: [], confirm: null, why: '' };
  const a = rowsOf(champion, 'champion', out.problems), b = rowsOf(edit, 'edit', out.problems);
  const finish = verdict => { out.verdict = verdict; return out; };
  if (!a || !b) { out.why = out.problems.join('; '); return out; }
  for (const [who, s] of [['champion', champion], ['edit', edit]]) {
    if (!s.quizHash) out.problems.push(`the ${who}'s summary has no quiz hash (grade it again)`);
    else if (s.quizHash !== quizHash) out.problems.push(`the ${who}'s summary was graded by another quiz than the current one`);
    if (!(s.k >= quiz.k)) out.problems.push(`the ${who}'s summary has k ${s.k}, under the quiz file's ${quiz.k}`);
  }
  if (champion.quizHash && edit.quizHash && champion.quizHash !== edit.quizHash) out.problems.push('the two summaries were graded by different quizzes');
  if (champion.k !== edit.k) out.problems.push(`the runs differ: champion k ${champion.k}, edit k ${edit.k}`);
  for (const id of a.keys()) if (!b.has(id)) out.problems.push(`${id}: not answered for the edit`);
  for (const id of b.keys()) if (!a.has(id)) out.problems.push(`${id}: not answered for the champion`);

  // The confirm runs, by question, held to the same standards: this quiz's hash, rows that add up.
  let cc = confirm ? rowsOf(confirm.champion, 'confirm champion', out.problems) : null;
  let ce = confirm ? rowsOf(confirm.edit, 'confirm edit', out.problems) : null;
  if (confirm) {
    for (const [who, s] of [['confirm champion', confirm.champion], ['confirm edit', confirm.edit]]) {
      if (isObj(s) && s.quizHash !== quizHash) { out.problems.push(`the ${who}'s summary ${s.quizHash ? 'was graded by another quiz than the current one' : 'has no quiz hash (grade it again)'}`); cc = null; ce = null; }
    }
  }

  // Stage 1: the flagged, the slips, the gains.
  const candidates = [];
  for (const x of a.values()) {
    const y = b.get(x.id);
    if (!y) continue;
    if (x.n < quiz.k || y.n < quiz.k) { out.problems.push(`${x.id}: ${label(x.passes, x.n)} against ${label(y.passes, y.n)}, under k ${quiz.k}`); continue; }
    // Rounded to three places, so a drop of exactly flagDrop (4 of 10) is not lost to float error.
    const drop = round3(x.passes / x.n - y.passes / y.n);
    const row = { id: x.id, from: label(x.passes, x.n), to: label(y.passes, y.n), drop };
    if (drop >= g.flagDrop) { out.flagged.push(row); candidates.push({ x, y, row }); }
    else if (drop > 0 && x.passes === x.n) out.slips.push(row);
    else if (drop < 0) out.gains.push(row);
  }

  // Stage 2: the confirm runs alone decide a flagged question; alpha is shared out over them.
  const alphaEach = g.alpha / Math.max(1, candidates.length);
  const pending = [];
  for (const { x, y, row } of candidates) {
    const px = cc && cc.get(x.id), py = ce && ce.get(x.id);
    if (!px || !py) { pending.push(x.id); continue; }
    if (px.n < g.confirmRuns || py.n < g.confirmRuns) { out.problems.push(`${x.id}: the confirm runs are ${label(px.passes, px.n)} and ${label(py.passes, py.n)}, under confirmRuns ${g.confirmRuns}`); continue; }
    const cp = x.passes + px.passes, cn = x.n + px.n, ep = y.passes + py.passes, en = y.n + py.n;
    const pooled = { id: x.id, from: label(cp, cn), to: label(ep, en), drop: round3(cp / cn - ep / en), p: Math.round(fisherLess(px.passes, px.n, py.passes, py.n) * 1e6) / 1e6 };
    // A flagged question that did not confirm is noise; it counts as a slip only for a stable question (a flaky one has no baseline to lose).
    if (pooled.drop >= g.flagDrop && pooled.p <= alphaEach) out.regressions.push(pooled); else if (x.passes === x.n) out.slips.push({ ...pooled, first: row });
  }

  if (out.regressions.length) { out.why = `regressed: ${out.regressions.map(r => `${r.id} ${r.from} -> ${r.to} (p ${r.p})`).join('; ')}`; return finish('reject'); }
  if (out.slips.length > g.maxSlips) { out.why = `${out.slips.length} questions slipped (more than the ${g.maxSlips} the gate allows): ${out.slips.map(r => r.id).join(', ')}`; return finish('reject'); }
  if (out.problems.length) { out.why = out.problems.join('; '); return finish('inconclusive'); }
  if (pending.length) { out.confirm = { ids: pending, runs: g.confirmRuns }; out.why = `a confirm run is needed for ${pending.join(', ')}: ask each ${g.confirmRuns} more times on both sides`; return finish('confirm'); }
  out.why = `no regression${out.slips.length ? `, ${out.slips.length} slip${out.slips.length === 1 ? '' : 's'}` : ''}${out.gains.length ? `, ${out.gains.length} gain${out.gains.length === 1 ? '' : 's'}` : ''}`;
  return finish('pass');
}

module.exports = { decide, fisherLess };
