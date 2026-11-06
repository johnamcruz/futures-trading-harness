'use strict';

// The quiz gate for a proposed skill edit (scripts/lib/train/quiz-gate.js): before any replay, the edited tree's quiz
// summary is held against the champion's. 53 noisy questions at a few runs each make any per-question drop rule falsely
// reject an edit that changes nothing (a multiple-comparisons trap: review found 30 to 80% at 3 runs), so: only a question
// the champion answered on every run can slip (a flaky question has no baseline to lose); a drop of flagDrop or more FLAGS
// any question; a flagged question is re-asked with more runs on both sides and is a regression only when those confirm
// runs ALONE (the flag selected on noise, so the first runs are not reused) are worse by an exact test at alpha shared out
// over the flagged questions; smaller drops of a stable question are slips, counted. Pure: the model calls are the quiz runner's. The thresholds are the quiz file's own
// (config/context-quiz.json `gate`), not a tunable. A Monte Carlo test pins the false-reject and the detection rates.

const test = require('node:test');
const assert = require('node:assert');
const Q = require('../../scripts/lib/eval/context-quiz');
const G = require('../../scripts/lib/train/quiz-gate');

const QUIZ = Q.loadQuiz().value;
const IDS = [...QUIZ.questions, ...QUIZ.partB].map(x => x.id);
const K = QUIZ.k; // the quiz file's runs a question
const HASH = 'h1';

/** A quiz summary where each question passes `passes[id]` of k runs (default all), as Q.summarize reads it, with its quiz hash. */
function summary(passes = {}, { k = K, skip = [], hash = HASH, only = null } = {}) {
  const rows = [];
  for (const id of only || IDS) {
    if (skip.includes(id)) continue;
    const p = id in passes ? passes[id] : k;
    for (let i = 1; i <= k; i += 1) rows.push({ id, k: i, pass: i <= p });
  }
  const s = Q.summarize(QUIZ, rows, k);
  if (only) { for (const part of ['partA', 'partB']) s[part].per = s[part].per.filter(x => only.includes(x.id)); }
  return { ...s, ...(hash ? { quizHash: hash } : {}) };
}
const decide = (c, e, opts = {}) => G.decide(QUIZ, c, e, { quizHash: HASH, ...opts });
const CONFIRM = QUIZ.gate && QUIZ.gate.confirmRuns;

test('the quiz file carries the gate\'s thresholds and the file check names a bad one', () => {
  assert.deepStrictEqual(Q.quizErrors(QUIZ), []);
  const g = QUIZ.gate;
  assert.ok(g && g.flagDrop > 0 && g.flagDrop <= 1 && g.alpha > 0 && g.alpha < 1 && Number.isInteger(g.maxSlips) && g.maxSlips >= 0 && Number.isInteger(g.confirmRuns) && g.confirmRuns >= 1);
  for (const bad of [{ ...g, flagDrop: 0 }, { ...g, flagDrop: 1.5 }, { ...g, alpha: 0 }, { ...g, alpha: 1 }, { ...g, maxSlips: -1 }, { ...g, confirmRuns: 0 }, { flagDrop: 0.4 }, null]) {
    assert.match(Q.quizErrors({ ...QUIZ, gate: bad }).join('\n'), /gate/, JSON.stringify(bad));
  }
});

test('decide: an edit that changes nothing, or answers better, passes; the gains are listed', () => {
  const champ = summary({ q8: 3, q10: 1 });
  assert.strictEqual(decide(champ, summary({ q8: 3, q10: 1 })).verdict, 'pass');
  const better = decide(champ, summary({ q8: 5, q10: 5 }));
  assert.strictEqual(better.verdict, 'pass');
  assert.deepStrictEqual(better.gains.map(g => [g.id, g.from, g.to]), [['q8', `3/${K}`, `${K}/${K}`], ['q10', `1/${K}`, `${K}/${K}`]]);
  assert.deepStrictEqual(better.flagged, []);
});

test('decide: a flaky question can be flagged too (the confirm decides); only a stable question counts as a slip', () => {
  // q7 champion 3/5 -> edit 0/5: a drop of 0.6, flagged for a confirm run, whatever the baseline.
  const f = decide(summary({ q7: 3 }), summary({ q7: 0 }));
  assert.strictEqual(f.verdict, 'confirm');
  assert.deepStrictEqual(f.flagged.map(x => [x.id, x.from, x.to]), [['q7', `3/${K}`, `0/${K}`]]);
  // a small drop of a flaky question is neither a slip nor a flag (it has no clean baseline).
  const r = decide(summary({ q7: 4 }), summary({ q7: 3 }));
  assert.strictEqual(r.verdict, 'pass');
  assert.deepStrictEqual([r.flagged, r.slips], [[], []]);
  // a stable question's small drop is a slip.
  assert.deepStrictEqual(decide(summary(), summary({ q7: K - 1 })).slips.map(x => x.id), ['q7']);
});

test('decide: a stable question that drops by flagDrop or more is FLAGGED for a confirm run; smaller drops are slips', () => {
  // 5/5 -> 3/5 is a drop of 0.4 = flagDrop: flagged. 5/5 -> 4/5 is 0.2: a slip.
  const r = decide(summary(), summary({ q1: 3, q2: 4 }));
  assert.strictEqual(r.verdict, 'confirm');
  assert.deepStrictEqual(r.flagged.map(x => x.id), ['q1']);
  assert.deepStrictEqual(r.slips.map(x => x.id), ['q2']);
  assert.deepStrictEqual(r.confirm, { ids: ['q1'], runs: QUIZ.gate.confirmRuns });
  assert.match(r.why, /confirm.*q1/);
});

test('decide: the confirm runs are tested ALONE, exactly: a drop that holds is a regression (rejects), one that does not is a slip', () => {
  const m = CONFIRM;
  const only = ['q1'];
  const base = decide(summary(), summary({ q1: 1 }));
  assert.strictEqual(base.verdict, 'confirm');
  // confirmed: the edit keeps failing (1 of m) while the champion answers it every time.
  const bad = decide(summary(), summary({ q1: 1 }), { confirm: { champion: summary({}, { k: m, only }), edit: summary({ q1: 1 }, { k: m, only }) } });
  assert.strictEqual(bad.verdict, 'reject');
  assert.deepStrictEqual(bad.regressions.map(x => [x.id, x.from, x.to]), [['q1', `${K + m}/${K + m}`, `${1 + 1}/${K + m}`]], 'the pooled counts are shown');
  assert.ok(bad.regressions[0].p <= QUIZ.gate.alpha, 'the p is the confirm runs\' alone');
  assert.ok(Math.abs(bad.regressions[0].p - G.fisherLess(m, m, 1, m)) < 1e-6, 'the row shows p to six places');
  assert.match(bad.why, /regress.*q1/);
  // not confirmed: it was noise, the edit answers it every time on the extra runs.
  const noise = decide(summary(), summary({ q1: 2 }), { confirm: { champion: summary({}, { k: m, only }), edit: summary({}, { k: m, only }) } });
  assert.strictEqual(noise.verdict, 'pass');
  assert.deepStrictEqual([noise.regressions.length, noise.slips.map(x => x.id)], [0, ['q1']]);
  // the first runs alone never decide: a flagged question whose confirm runs are only a little worse is not a regression
  // however bad the first runs looked (9 of 10 against 10 of 10: p about 0.5).
  const mild = decide(summary(), summary({ q1: 0 }), { confirm: { champion: summary({}, { k: m, only }), edit: summary({ q1: m - 1 }, { k: m, only }) } });
  assert.strictEqual(mild.verdict, 'pass');
  // confirm data that misses a flagged question asks again, never a pass.
  const partial = decide(summary(), summary({ q1: 1, q2: 1 }), { confirm: { champion: summary({}, { k: m, only }), edit: summary({}, { k: m, only }) } });
  assert.strictEqual(partial.verdict, 'confirm');
  assert.deepStrictEqual(partial.confirm.ids, ['q2']);
});

test('decide: confirm data is held to the same standards as the first runs: its quiz hash, and at least confirmRuns a side', () => {
  const m = CONFIRM;
  const only = ['q1'];
  const edit = summary({ q1: 0 });
  const good = { champion: summary({}, { k: m, only }), edit: summary({ q1: 0 }, { k: m, only }) };
  assert.strictEqual(decide(summary(), edit, { confirm: good }).verdict, 'reject');
  // another quiz's summaries, none, or one run a side: inconclusive, never a pass or a reject
  const other = { champion: summary({}, { k: m, only, hash: 'other' }), edit: summary({ q1: 0 }, { k: m, only }) };
  assert.strictEqual(decide(summary(), edit, { confirm: other }).verdict, 'inconclusive');
  const nohash = { champion: summary({}, { k: m, only }), edit: summary({ q1: 0 }, { k: m, only, hash: null }) };
  assert.strictEqual(decide(summary(), edit, { confirm: nohash }).verdict, 'inconclusive');
  const one = { champion: summary({}, { k: 1, only }), edit: summary({}, { k: 1, only }) };
  assert.strictEqual(decide(summary(), edit, { confirm: one }).verdict, 'inconclusive', 'one run a side proves nothing');
  const oneBad = { champion: summary({}, { k: 1, only }), edit: summary({ q1: 0 }, { k: 1, only }) };
  assert.strictEqual(decide(summary(), edit, { confirm: oneBad }).verdict, 'inconclusive');
  assert.strictEqual(decide(summary(), edit, { confirm: { champion: null, edit: null } }).verdict, 'inconclusive');
});

test('decide: the alpha is shared out over the flagged questions (Bonferroni), so many flags need stronger evidence each', () => {
  const m = CONFIRM, a = QUIZ.gate.alpha;
  // one flagged question: edit 7/10 against 10/10 passes at alpha; with many flagged questions it must not.
  const p7 = G.fisherLess(m, m, 7, m);
  assert.ok(p7 > a / 2 || p7 <= a, 'sanity');
  const ids = ['q1', 'q2', 'q3', 'q4', 'q5'];
  const flaggedAll = summary(Object.fromEntries(ids.map(i => [i, 0])));
  // every confirm shows the edit at the single-flag threshold; with 5 flagged the bar is alpha/5
  let lo = 0;
  while (lo <= m && G.fisherLess(m, m, lo, m) <= a) lo += 1; // the largest edit passes count that is still significant alone is lo - 1
  const edgePasses = lo - 1;
  assert.ok(edgePasses >= 0 && G.fisherLess(m, m, edgePasses, m) <= a && G.fisherLess(m, m, edgePasses, m) > a / ids.length, 'the edge case is significant alone but not at alpha/5');
  const conf = (k) => ({ champion: summary({}, { k: m, only: ids.slice(0, k) }), edit: summary(Object.fromEntries(ids.slice(0, k).map(i => [i, edgePasses])), { k: m, only: ids.slice(0, k) }) });
  assert.strictEqual(decide(summary(), summary({ q1: 0 }), { confirm: conf(1) }).verdict, 'reject', 'alone: significant');
  assert.strictEqual(decide(summary(), flaggedAll, { confirm: conf(5) }).verdict, 'pass', 'among five flagged: not enough');
});

test('decide: a flaky question\'s unconfirmed flag is not a slip; a stable one\'s is', () => {
  const m = CONFIRM;
  const flakyFlag = decide(summary({ q7: 4 }), summary({ q7: 1 }), { confirm: { champion: summary({}, { k: m, only: ['q7'] }), edit: summary({}, { k: m, only: ['q7'] }) } });
  assert.strictEqual(flakyFlag.verdict, 'pass');
  assert.deepStrictEqual(flakyFlag.slips, [], 'a flaky question has no baseline to lose');
  const stableFlag = decide(summary(), summary({ q7: 1 }), { confirm: { champion: summary({}, { k: m, only: ['q7'] }), edit: summary({}, { k: m, only: ['q7'] }) } });
  assert.deepStrictEqual(stableFlag.slips.map(x => x.id), ['q7']);
});

test('decide: single-answer slips are noise up to maxSlips; one more rejects', () => {
  const slips = ids => Object.fromEntries(ids.map(i => [i, K - 1]));
  const max = QUIZ.gate.maxSlips;
  const names = IDS.slice(0, max + 1);
  const ok = decide(summary(), summary(slips(names.slice(0, max))));
  assert.strictEqual(ok.verdict, 'pass');
  assert.strictEqual(ok.slips.length, max);
  const over = decide(summary(), summary(slips(names)));
  assert.strictEqual(over.verdict, 'reject');
  assert.match(over.why, new RegExp(`${max + 1} questions slipped`));
});

test('decide: missing, short, mismatched or corrupt input is inconclusive, never a pass; a rejection still wins', () => {
  const inc = (c, e, opts) => decide(c, e, opts).verdict;
  assert.strictEqual(inc(summary(), summary({}, { skip: ['q3'] })), 'inconclusive');
  assert.strictEqual(inc(summary({}, { skip: ['q3'] }), summary()), 'inconclusive');
  assert.strictEqual(inc(summary(), summary({}, { k: K - 1 })), 'inconclusive', 'a different k');
  assert.strictEqual(inc(summary({}, { k: 1 }), summary({}, { k: 1 })), 'inconclusive', 'fewer runs than the quiz file\'s k');
  assert.strictEqual(inc(summary(), null), 'inconclusive');
  assert.strictEqual(inc(undefined, summary()), 'inconclusive');
  // a quiz hash that is missing, differs between the two, or differs from the current quiz: graded by other regexes
  assert.strictEqual(inc(summary({}, { hash: null }), summary()), 'inconclusive');
  assert.strictEqual(inc(summary(), summary({}, { hash: 'other' })), 'inconclusive');
  assert.strictEqual(inc(summary(), summary()), 'pass');
  assert.strictEqual(G.decide(QUIZ, summary(), summary(), { quizHash: 'a-newer-quiz' }).verdict, 'inconclusive');
  assert.throws(() => G.decide(QUIZ, summary(), summary()), /quiz hash/, 'the current quiz hash is required, so a stale pair can never pass');
  assert.throws(() => G.decide(QUIZ, summary(), summary(), {}), /quiz hash/);
  // corrupt rows: not whole counts, more passes than runs, a question twice
  const rows = (mut) => { const s = summary(); mut(s.partA.per); return s; };
  assert.strictEqual(inc(summary(), rows(per => { per[3].n = NaN; })), 'inconclusive');
  assert.strictEqual(inc(summary(), rows(per => { per[3].passes = per[3].n + 1; })), 'inconclusive');
  assert.strictEqual(inc(summary(), rows(per => { per[3].passes = -1; })), 'inconclusive');
  assert.strictEqual(inc(summary(), rows(per => { per[4].id = per[3].id; })), 'inconclusive');
  // a flagged question is still flagged beside a missing one, and slips over the limit still reject beside a problem
  const slips = Object.fromEntries(IDS.slice(0, QUIZ.gate.maxSlips + 1).map(i => [i, K - 1]));
  assert.strictEqual(inc(summary(), summary({ ...slips }, { skip: ['q40'] })), 'reject');
});

test('decide: the drop is rounded, so an exact-limit drop is not lost to float error', () => {
  // 10 runs: 10/10 -> 6/10 is a drop of 0.4 (1 - 0.6 = 0.4 exactly after rounding; the float is 0.4 or 0.39999999999999997).
  const c = summary({}, { k: 10 }), e = summary({ q1: 6 }, { k: 10 });
  const r = G.decide({ ...QUIZ, k: 10 }, c, e, { quizHash: HASH });
  assert.deepStrictEqual(r.flagged.map(x => x.id), ['q1']);
  // 7/10 -> 3/10 on a flaky question is not able to regress at all; 10/10 -> 7/10 is a slip (0.3 < flagDrop 0.4)
  assert.deepStrictEqual(G.decide({ ...QUIZ, k: 10 }, c, summary({ q1: 7 }, { k: 10 }), { quizHash: HASH }).slips.map(x => x.id), ['q1']);
});

test('decide: reads the thresholds from the quiz it is given, so a tighter file is a tighter gate', () => {
  const strict = { ...QUIZ, gate: { ...QUIZ.gate, flagDrop: 0.2 } };
  const edit = summary({ q1: K - 1 });
  assert.strictEqual(decide(summary(), edit).verdict, 'pass');
  assert.strictEqual(G.decide(strict, summary(), edit, { quizHash: HASH }).verdict, 'confirm');
  assert.throws(() => G.decide({ ...QUIZ, gate: null }, summary(), summary(), { quizHash: HASH }), /gate/);
});

test('fisherLess: the exact one-sided test that the edit passes less often than the champion', () => {
  // champion 15/15, edit 2/15: very unlikely by chance; equal rates: p near 1; the usual 2x2 values.
  assert.ok(G.fisherLess(15, 15, 2, 15) < 1e-6);
  assert.ok(G.fisherLess(10, 15, 10, 15) > 0.5);
  assert.ok(Math.abs(G.fisherLess(3, 3, 0, 3) - 0.05) < 1e-12, '3/3 against 0/3: 1 of 20 tables');
  assert.strictEqual(G.fisherLess(5, 5, 5, 5), 1);
  assert.throws(() => G.fisherLess(6, 5, 1, 5), /counts/);
});

// The reason for the design: a noisy quiz must not reject an edit that changes nothing. Seeded Monte Carlo of the whole
// procedure (the first run, then a confirm run on what it flags), 53 questions with a realistic mix of stable and
// flaky ones; both sides draw from the same per-question pass rates.
test('Monte Carlo: an unchanged edit is rarely rejected, one that breaks a stable question usually is', () => {
  let seed = 20260805;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const probs = (mix) => IDS.map((id, i) => ({ id, p: mix(i) }));
  const stable = probs(i => (i % 20 === 0 ? 0.55 : i % 10 === 3 ? 0.9 : 1)); // 85% at 1.0, ~10% at .9, ~5% flaky
  const flaky = probs(i => (i % 10 < 2 ? 0.85 : i % 10 === 9 ? 0.6 : 1)); // 70% at 1.0, 20% at .85, 10% at .6
  const draw = (p, n) => { let c = 0; for (let i = 0; i < n; i += 1) if (rand() < p) c += 1; return c; };
  const sumOf = (qs, k, only = null) => summary(Object.fromEntries(qs.map(q => [q.id, draw(q.p, k)])), { k, only });
  const trial = (qsChamp, qsEdit) => {
    const c = sumOf(qsChamp, K), e = sumOf(qsEdit, K);
    const first = decide(c, e);
    if (first.verdict !== 'confirm') return first.verdict;
    const ids = first.confirm.ids, m = first.confirm.runs;
    const sub = qs => qs.filter(q => ids.includes(q.id));
    return decide(c, e, { confirm: { champion: sumOf(sub(qsChamp), m, ids), edit: sumOf(sub(qsEdit), m, ids) } }).verdict;
  };
  const N = 600;
  for (const [name, qs, maxFalse] of [['stable', stable, 0.04], ['flaky', flaky, 0.06]]) {
    let rej = 0;
    for (let t = 0; t < N; t += 1) if (trial(qs, qs) === 'reject') rej += 1;
    assert.ok(rej / N <= maxFalse, `${name} mix: ${rej} of ${N} unchanged edits rejected (${(100 * rej / N).toFixed(1)}%), over ${100 * maxFalse}%`);
  }
  // an edit that breaks one stable question (pass rate 1.0 -> 0.3): caught most of the time
  const broken = stable.map(q => (q.id === 'q2' ? { ...q, p: 0.3 } : q));
  let caught = 0;
  for (let t = 0; t < N; t += 1) if (trial(stable, broken) === 'reject') caught += 1;
  assert.ok(caught / N >= 0.9, `a broken stable question caught ${caught} of ${N}`);
  // a flaky question (0.8) that the edit drops to 0 is caught too
  let flakyCaught = 0;
  const flakyBase = stable.map(q => (q.id === 'q2' ? { ...q, p: 0.8 } : q)), flakyBroken = stable.map(q => (q.id === 'q2' ? { ...q, p: 0 } : q));
  for (let t = 0; t < N; t += 1) if (trial(flakyBase, flakyBroken) === 'reject') flakyCaught += 1;
  assert.ok(flakyCaught / N >= 0.9, `a flaky question dropped to 0 caught ${flakyCaught} of ${N}`);
});

// The CLI: `context-quiz.js gate <champion dir> <edit dir> [--confirm <champion dir> <edit dir>]` reads each directory's
// summary.json (what `run` and `grade` write, with the quiz hash) and prints the verdict; exit 0 pass, 1 reject,
// 2 inconclusive (a summary or the quiz file that cannot be read too), 3 confirm needed, 4 usage.
test('context-quiz.js gate: the verdict from two summaries, as an exit code', () => {
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { tmpDir } = require('../helpers');
  const hash = Q.loadQuiz().hash;
  const CLI = path.join(__dirname, '..', '..', 'scripts', 'context-quiz.js');
  const dir = (name, s) => { const d = path.join(tmpDir(), name); fs.mkdirSync(d, { recursive: true }); if (s) fs.writeFileSync(path.join(d, 'summary.json'), typeof s === 'string' ? s : JSON.stringify(s)); return d; };
  const run = (...args) => spawnSync(process.execPath, [CLI, 'gate', ...args], { encoding: 'utf8' });
  const real = (p, o = {}) => summary(p, { hash, ...o });
  const champ = dir('champ', real());
  const same = run(champ, dir('same', real()));
  assert.strictEqual(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /^pass: /m);
  const flagged = run(champ, dir('flag', real({ q1: 0 })));
  assert.strictEqual(flagged.status, 3, flagged.stdout + flagged.stderr);
  assert.match(flagged.stdout, /^confirm: /m);
  assert.doesNotMatch(flagged.stdout, /confirm: confirm/, 'the verdict is not said twice');
  assert.match(flagged.stdout, /q1/);
  const m = QUIZ.gate.confirmRuns;
  const only = ['q1'];
  const rej = run(champ, dir('flag2', real({ q1: 0 })), '--confirm', dir('cc', real({}, { k: m, only })), dir('ce', real({ q1: 0 }, { k: m, only })));
  assert.strictEqual(rej.status, 1, rej.stdout + rej.stderr);
  assert.match(rej.stdout, /^reject: /m);
  assert.match(rej.stdout, /q1\s+/);
  assert.strictEqual(run(champ, dir('short', real({}, { skip: ['q3'] }))).status, 2);
  assert.strictEqual(run(champ, dir('nohash', summary())).status, 2, 'a summary graded with no quiz hash');
  assert.strictEqual(run(champ, dir('none')).status, 2, 'a directory with no summary.json is inconclusive');
  assert.strictEqual(run(champ, dir('broken', '{bad')).status, 2, 'an unreadable summary.json is inconclusive, never a reject');
  assert.strictEqual(run(champ).status, 4);
  // extra or misplaced arguments are a usage error, not silently ignored
  assert.strictEqual(run(champ, dir('x1', real()), dir('x2', real())).status, 4, 'a third directory without --confirm');
  const cd = dir('xc', real({}, { k: m, only })), ed = dir('xe', real({}, { k: m, only }));
  assert.strictEqual(run(champ, dir('x3', real()), '--confirm', cd, ed, dir('x4', real())).status, 4, 'a fifth after --confirm');
  assert.strictEqual(run(champ, '--confirm', cd, ed).status, 4, '--confirm in place of the edit dir');
  assert.strictEqual(run(champ, dir('x5', real()), '--confirm', cd).status, 4, '--confirm with one dir');
});
