'use strict';

// Curated runs weighted back to natural rates (scripts/lib/learning/curated-weights.js) and the experience index's
// weighted statistics (scripts/lib/learning/experience-index.js cellStats).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const W = require('../../scripts/lib/learning/curated-weights');
const X = require('../../scripts/lib/learning/experience-index');
const { tmpHome } = require('../fixtures/learning');

const SKILL = 'bias:bos-vs-choch+entry:candle-reading';
const READ = 'bias:1h-bos-up+entry:3m-close-top';
const ALL = X.cellKey('skill', SKILL);
const CTX = { regime: 'trend-up', volatility: 'normal', window: 'ny-am', biasSide: 'with', alignment: 'aligned', dayType: 'normal' };

/** Weekdays from a date. */
function weekdays(from, count) {
  const out = [];
  for (let t = Date.parse(from); out.length < count; t += 86400000) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * A curated lists document of one list: `n` chosen moments half wins and half losses, one a day at 15:00 (a window
 * from 14:45 to 15:15), over candidates whose outcomes are `natural` ({ win, loss }); `old` leaves the candidates'
 * outcomes out (a document built before they were recorded).
 */
function listsDoc({ n = 40, natural = { win: 300, loss: 700 }, list = 'trend-up', old = false } = {}) {
  const days = weekdays('2022-03-01T00:00:00Z', n);
  const moments = days.map((d, i) => ({ id: `m${i}`, day: d, outcome: { result: i % 2 ? 'loss' : 'win' }, window: { from: `${d}T14:45:00.000Z`, to: `${d}T15:15:00.000Z` } }));
  const outcomes = { win: Math.ceil(n / 2), loss: Math.floor(n / 2) };
  return {
    fingerprint: `fp-${list}-${n}-${old}`, market: { minutes: 3 }, lists: { [list]: moments }, mix: moments.map(m => m.id),
    coverage: { [list]: { n, candidates: natural.win + natural.loss, outcomes, ...(old ? {} : { candidateOutcomes: natural }) } },
  };
}

/** The curated run's decisions on the document's moments: each on its moment's 15:00 bar, R 2 on a win, -1 on a loss. */
const decisionsOf = (doc, { tag = 'c', mae = [-0.2, -1], mfe = [2.4, 0.4] } = {}) => doc.lists['trend-up'].map((m, i) => ({
  id: `${tag}${i}`, runId: 'r1', bar: `${m.day}T15:00:00.000Z`, day: m.day, decision: 'entered', side: 'long',
  signatures: { skill: SKILL, read: READ }, context: CTX,
  outcome: { R: m.outcome.result === 'win' ? 2 : -1, maeR: m.outcome.result === 'win' ? mae[0] : mae[1], mfeR: m.outcome.result === 'win' ? mfe[0] : mfe[1] },
}));

const weighed = (doc, ds) => {
  const w = W.weigher(doc, 'trend-up');
  return ds.map(d => ({ ...d, curated: true, weight: w.weightOf(d) }));
};

test('weigher: each list and outcome weighs its natural share over its share as built; a decision placed by its moment\'s window', () => {
  const doc = listsDoc();
  const w = W.weigher(doc, 'trend-up');
  // Natural 30% wins, 70% losses; built 50/50: a win weighs 0.6, a loss 1.4.
  assert.deepStrictEqual(Object.fromEntries(Object.entries(w.weights).map(([k, v]) => [k, Number(v.toFixed(6))])), { 'trend-up|win': 0.6, 'trend-up|loss': 1.4 });
  assert.strictEqual(Number(w.weightOf({ bar: '2022-03-01T15:00:00.000Z' }).toFixed(6)), 0.6);
  assert.strictEqual(Number(w.weightOf({ bar: '2022-03-02T15:00:00.000Z' }).toFixed(6)), 1.4);
  assert.strictEqual(w.weightOf({ bar: '2022-03-01T16:00:00.000Z' }), null, 'in no window: no weight');
  assert.strictEqual(w.weightOf({}), null);
  // Two windows of two strata hold it: ambiguous, no weight.
  const two = listsDoc();
  two.lists['trend-up'][1].window = { ...two.lists['trend-up'][0].window };
  assert.strictEqual(W.weigher(two, 'trend-up').weightOf({ bar: '2022-03-01T15:00:00.000Z' }), null);
  // A document built before the candidates' outcomes were recorded: no weigher, never a guess.
  assert.strictEqual(W.weigher(listsDoc({ old: true }), 'trend-up'), null);
});

test('weigher (mix): the lists\' natural shares restored too, the weights averaging 1 over the chosen', () => {
  const a = listsDoc({ n: 10, natural: { win: 50, loss: 50 } });
  const doc = { ...a, lists: { ...a.lists, chop: [{ id: 'z', day: '2022-06-01', outcome: { result: 'loss' }, window: { from: '2022-06-01T14:45:00.000Z', to: '2022-06-01T15:15:00.000Z' } }] },
    mix: [...a.mix, 'z'], coverage: { ...a.coverage, chop: { n: 1, candidates: 900, outcomes: { loss: 1 }, candidateOutcomes: { loss: 900 } } } };
  const w = W.weigher(doc, 'mix').weights;
  // 1000 candidates, 11 chosen: chop's one loss stands for 900 of them.
  assert.strictEqual(Number(w['chop|loss'].toFixed(6)), Number(((900 / 1000) / (1 / 11)).toFixed(6)));
  const mean = (5 * w['trend-up|win'] + 5 * w['trend-up|loss'] + w['chop|loss']) / 11;
  assert.strictEqual(Number(mean.toFixed(9)), 1);
});

test('the index weighted: a balanced 50/50 curated sample of a list whose natural win rate is 30% shows 0.30; mean R and MAE/MFE medians too', () => {
  const doc = listsDoc();
  const c = X.cellAt(X.buildIndex(weighed(doc, decisionsOf(doc)), { reps: 500 }), ALL);
  assert.deepStrictEqual([c.n, c.wins, c.curated, c.unweighted, c.enough], [40, 20, 40, 0, true]);
  assert.strictEqual(c.winRate.rate, 0.3, 'the win rate at natural rates, not the list\'s 0.50');
  assert.strictEqual(c.meanR.mean, -0.1, '0.3 x 2R + 0.7 x -1R, not 0.50');
  assert.ok(c.winRate.lo < 0.3 && c.winRate.hi > 0.3 && c.winRate.by === 'day', JSON.stringify(c.winRate));
  // The losers weigh 70%: the weighted medians are theirs (balanced, the upper middle would be the winners').
  assert.deepStrictEqual([c.mae.median, c.mfe.median], [-1, 0.4]);
  assert.ok(c.mae.lo <= c.mae.median && c.mae.hi >= c.mae.median);
  // The effective n (Kish): (40)^2 / (20 x 0.36 + 20 x 1.96).
  assert.strictEqual(c.nEff, Number(((40 * 40) / (20 * 0.36 + 20 * 1.96)).toFixed(4)));
  assert.strictEqual(c.weighted, true);
});

test('the index weighted: non-curated decisions weigh 1, their statistics exactly as unweighted; mixed, each weighs its own', () => {
  const doc = listsDoc();
  const plain = decisionsOf(doc, { tag: 'p' });
  const c = X.cellAt(X.buildIndex(plain, { reps: 500 }), ALL);
  assert.deepStrictEqual([c.winRate.rate, c.meanR.mean, c.nEff, c.weighted, c.mae.median], [0.5, 0.5, 40, false, -0.2]);
  // The same rows without a weight column (another caller's: setup-library, skill-usage) give the same statistics.
  const rows = X.buildIndex(plain, { reps: 500 }).cells[ALL];
  const four = X.cellStats(rows.map(r => r.slice(0, 4)), { reps: 500, key: ALL });
  const eight = X.cellStats(rows, { reps: 500, key: ALL });
  assert.deepStrictEqual([four.winRate, four.meanR, four.n, four.nEff], [eight.winRate, eight.meanR, eight.n, eight.nEff]);
  // 40 natural (weight 1, half wins) with 40 curated (weighted to 30%): (20 + 12) / (40 + 40) wins by weight.
  const both = X.cellAt(X.buildIndex([...plain, ...weighed(doc, decisionsOf(doc))], { reps: 500 }), ALL);
  assert.strictEqual(both.winRate.rate, Number(((20 + 20 * 0.6) / 80).toFixed(4)));
});

test('the index weighted: MIN_N on the effective n; a curated decision without a weight is counted, never rated', () => {
  // 22 decisions over 22 days, one weighing 10: n 22, n_eff under 20, so no rate.
  const doc = listsDoc({ n: 22 });
  const ds = decisionsOf(doc).map((d, i) => ({ ...d, curated: true, weight: i === 0 ? 10 : 1 }));
  const c = X.cellAt(X.buildIndex(ds, { reps: 100 }), ALL);
  assert.ok(c.nEff < X.MIN_N && c.n === 22, JSON.stringify([c.n, c.nEff]));
  assert.deepStrictEqual([c.enough, c.winRate, c.mae.median], [false, null, null]);
  assert.match(c.note, /^too few samples \(n=22, n_eff \d+\.\d, 22 days\)$/);
  // The fallback: an old document (no candidates' outcomes) gives no weight; rated only the weighted ones.
  const old = listsDoc({ old: true });
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'experience'), { recursive: true });
  const pin = { fingerprint: old.fingerprint, list: 'trend-up', windows: [] };
  fs.writeFileSync(path.join(home, 'experience', 'curated-pinned.json'), JSON.stringify({ kind: 'curated-pin', ...pin, hash: crypto.createHash('sha256').update(JSON.stringify(pin)).digest('hex') }));
  const lines = W.weighCurated(decisionsOf(old), { home, docs: [old] });
  assert.ok(lines.every(d => d.curated === true && d.weight === null));
  const f = X.cellAt(X.buildIndex(lines, { reps: 100 }), ALL);
  assert.deepStrictEqual([f.n, f.unweighted, f.nEff, f.enough, f.winRate, f.mae.median, f.mae.n], [40, 40, 0, false, null, null, 40]);
  // With a document that records them (matched by fingerprint), the weights; a non-curated home's lines as given.
  const fresh = listsDoc();
  const pin2 = { fingerprint: fresh.fingerprint, list: 'trend-up', windows: [] };
  fs.writeFileSync(path.join(home, 'experience', 'curated-pinned.json'), JSON.stringify({ kind: 'curated-pin', ...pin2, hash: crypto.createHash('sha256').update(JSON.stringify(pin2)).digest('hex') }));
  assert.ok(W.weighCurated(decisionsOf(fresh), { home, docs: [old, fresh] }).every(d => d.curated && Number.isFinite(d.weight)));
  assert.ok(W.weighCurated(decisionsOf(fresh), { home, docs: [old] }).every(d => d.weight === null), 'not its document: no weight');
  const ds2 = decisionsOf(fresh);
  assert.deepStrictEqual(W.weighCurated(ds2, { home: tmpHome(), docs: [fresh] }), ds2);
});

test('build CLI: --lists weights a curated run\'s log by its document (matched by fingerprint); without it, counted only', () => {
  const C = require('../../scripts/lib/learning/curated-lists');
  const { spawnSync } = require('child_process');
  const { fingerprint: _f, ...body } = listsDoc();
  const doc = { v: C.VERSION, kind: C.KIND, use: 'practice', role: C.ROLE.practice, ...body };
  doc.fingerprint = C.fingerprintOf(doc);
  const docFile = path.join(tmpHome(), 'lists.json');
  fs.writeFileSync(docFile, JSON.stringify(doc));
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'experience'), { recursive: true });
  const pin = { fingerprint: doc.fingerprint, list: 'trend-up', windows: [] };
  fs.writeFileSync(path.join(home, 'experience', 'curated-pinned.json'), JSON.stringify({ kind: 'curated-pin', ...pin, hash: crypto.createHash('sha256').update(JSON.stringify(pin)).digest('hex') }));
  fs.writeFileSync(path.join(home, 'experience', 'decisions.jsonl'), decisionsOf(doc).map(d => `${JSON.stringify(d)}\n`).join(''));
  const cli = path.join(__dirname, '..', '..', 'scripts', 'experience-index.js');
  const build = (...extra) => spawnSync(process.execPath, [cli, 'build', home, '--out', path.join(tmpHome(), 'o'), ...extra], { encoding: 'utf8' });
  const without = build();
  assert.strictEqual(without.status, 0, without.stderr);
  assert.match(without.stdout, /40 curated-run decision\(s\) weighted to natural rates, 40 without a weight \(counted, never rated/);
  const withDoc = build('--lists', docFile);
  assert.strictEqual(withDoc.status, 0, withDoc.stderr);
  assert.match(withDoc.stdout, /40 curated-run decision\(s\) weighted to natural rates; hash/);
  const file = withDoc.stdout.match(/wrote (\S+)/)[1];
  assert.strictEqual(X.cellAt(X.readIndex(file), ALL).winRate.rate, 0.3);
  assert.notStrictEqual(build('--lists').status, 0, '--lists without its file');
});
