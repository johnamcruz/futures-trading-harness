'use strict';

const { TEST_SIZING, testSizing } = require('../helpers');

// The prop Monte Carlo of the model's replay trades: the model pass and the learning ledger (prop/evaluator.js
// checkModelWindow, learning/looks.js recordScore), the curated reweighting (prop/natural-rate.js) and its diagnostic
// label, the promotion gate's refusal of it, the paired comparison and the risk attribution (the acceptance test:
// a more selective rule near the max loss limit is told apart), the account states (prop/account-states.js), the
// account-policy hook (prop/rulebook-score.js), and the run's score end to end (prop/model-score.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { checkModelWindow, checkWindow, scoreStream, scorePaired } = require('../../scripts/lib/prop/evaluator');
const { PROMOTION_GATE, gateFailures } = require('../../scripts/lib/prop/promotion');
const { reweightStream, naturalRates, validateRates, poisson } = require('../../scripts/lib/prop/natural-rate');
const { sampleAccountStates } = require('../../scripts/lib/prop/account-states');
const { scoreCandidate, validateCandidate } = require('../../scripts/lib/prop/rulebook-score');
const { createAttribution, riskRecord, stateOf } = require('../../scripts/lib/prop/risk-attribution');
const { scoreRun, pairRuns, scoreText, resolveAccount, propScoreSection } = require('../../scripts/lib/prop/model-score');
const looks = require('../../scripts/lib/learning/looks');
const { readLedger } = require('../../scripts/lib/prop/ledger-file');
const { rng } = require('../../scripts/lib/prop/stats');
const combine = require('../../scripts/lib/trading/combine');
const at = require('../../scripts/lib/prop/attempts');
const { ACCOUNT, M3, record, tmpHome, multiDayRun, weekdays, modelTrade, modelStreamOf } = require('../fixtures/prop-model');

const run = (extra = {}) => ({ runId: 'r1', from: '2022-01-03', to: '2022-09-01', learning: true, role: 'practice-train', look: null, hideOutcomes: false, ...extra });
const quick = { account: ACCOUNT, contracts: 'micro', paths: 200, reps: 300, seed: 3, rulebook: { sizing: TEST_SIZING } };
// The policy a scored run sizes by (scoreRun and pairRuns refuse a run with none): a whole test sizing.
const POLICY = { name: 'fx_policy', sizing: TEST_SIZING };
const DAYS = weekdays('2022-01-03', 60);
const steady = () => modelStreamOf(DAYS, (d, k) => [modelTrade(`${d}-0`, k % 3 === 2 ? -40 : 60)]);

test('checkModelWindow: practice-train is free; a held-back run is scored only beside its look; reasoning-fix, a diagnostic or a candidate on a sealed window refused', () => {
  const free = checkModelWindow({ run: run() });
  assert.deepStrictEqual([free.unit.role, free.look, free.diagnostic], ['practice-train', null, null]);
  assert.throws(() => checkModelWindow({ run: run({ hideOutcomes: true }) }), /reasoning-fix look/);
  const sealed = run({ from: '2025-03-03', to: '2025-03-08', role: 'test', look: { evaluation: 'ev1', candidate: 'c1', purpose: 'judging' } });
  assert.throws(() => checkModelWindow({ run: sealed }), /logScore is required/);
  assert.throws(() => checkModelWindow({ run: sealed, diagnostic: 'reweighted', logScore: () => {} }), /sealed/);
  assert.throws(() => checkModelWindow({ run: sealed, candidateRulebook: true, logScore: () => {} }), /candidate rulebook .* never scored on test/);
  assert.throws(() => checkModelWindow({ run: { ...sealed, look: null }, logScore: () => {} }), /carries no look/);
  assert.throws(() => checkModelWindow({ run: run({ role: 'practice-validate' }) }), /started as practice-validate, but its days are practice-train/);
  assert.throws(() => checkModelWindow({ run: run({ learning: false, role: null, from: '2024-08-01', to: '2024-08-05' }) }), /not a learning run but touches/);
  const logged = [];
  const p = checkModelWindow({ run: sealed, logScore: e => logged.push(e) });
  assert.deepStrictEqual([logged.length, logged[0].kind, logged[0].evaluation, logged[0].role, logged[0].rulebook, p.unit.role], [1, 'score', 'ev1', 'test', 'account', 'test']);
  // A model stream never on a schedule pass, a mechanical one never on a model pass.
  assert.throws(() => scoreStream(steady(), { ...quick, pass: checkWindow({ from: '2022-01-03', to: '2022-09-01' }) }), /checkModelWindow/);
  assert.throws(() => scoreStream({ ...steady(), source: undefined }, { ...quick, pass: checkModelWindow({ run: run() }) }), /checkWindow, never checkModelWindow/);
});

test('recordScore: a sealed run\'s score goes beside its look in the learning ledger, refused without it, and never spends a look', () => {
  const file = path.join(tmpHome(), 'learning', 'looks.jsonl');
  const look = { evaluation: 'ev1', candidate: 'c1', purpose: 'judging', runId: 'r1', from: '2025-03-03', to: '2025-03-08', arm: 'without', config: 'abc' };
  looks.recordLook(file, look, { create: true });
  const before = looks.lookUsage(readLedger(file));
  const sealed = run({ from: '2025-03-03', to: '2025-03-08', role: 'test', look });
  checkModelWindow({ run: sealed, logScore: e => looks.recordScore(file, e) });
  checkModelWindow({ run: sealed, logScore: e => looks.recordScore(file, e) });
  const ledger = readLedger(file);
  assert.deepStrictEqual(looks.scoresOf(ledger).map(e => [e.kind, e.runId, e.role]), [['score', 'r1', 'test'], ['score', 'r1', 'test']], 'every score is logged');
  assert.deepStrictEqual(looks.lookUsage(ledger), before, 'a score is not a look');
  assert.ok(looks.checkLook({ ...look, runId: 'r2', evaluation: 'ev2' }, ledger).remaining === 2, 'the budget spent by the look alone');
  assert.throws(() => checkModelWindow({ run: { ...sealed, runId: 'r9' }, logScore: e => looks.recordScore(file, e) }), /no test look of run r9/);
});

test('natural rates: a curated run\'s trades rebuilt at each list\'s natural frequency; unknown lists refused; seeded', () => {
  // A curated run: 5 days, 20 composed decisions a day of list "sweep" (8 entered a day), 4 of list "fvg" (2 entered).
  const days = weekdays('2022-03-01', 5);
  const decisions = [];
  const s = modelStreamOf(days, d => {
    const out = [];
    for (let i = 0; i < 20; i += 1) { decisions.push({ id: `${d}-s${i}`, day: d, decision: i < 8 ? 'entered' : 'passed', list: 'sweep', moment: `${d}-s${i}` }); if (i < 8) out.push(modelTrade(`${d}-s${i}`, 60)); }
    for (let i = 0; i < 4; i += 1) { decisions.push({ id: `${d}-f${i}`, day: d, decision: i < 2 ? 'entered' : 'passed', list: 'fvg', moment: `${d}-f${i}` }); if (i < 2) out.push(modelTrade(`${d}-f${i}`, -40)); }
    return out;
  });
  decisions.push({ id: 'none', day: days[0], decision: 'none' });
  // Natural: sweep 0.5 candidates a day (40% taken: 0.2 trades a day), fvg 0.25 (50%: 0.125).
  const rates = { sweep: { candidatesPerDay: 0.5 }, fvg: { candidatesPerDay: 0.25 } };
  const nat = naturalRates(s, decisions, { rates });
  assert.deepStrictEqual([nat.lists.sweep.tradesPerDay, nat.lists.fvg.tradesPerDay], [0.2, 0.125]);
  assert.ok(Math.abs(nat.tradesPerDay - 0.325) < 1e-9);
  const rw = reweightStream(s, decisions, { rates, days: 4000, seed: 5 });
  const perDay = list => rw.trades.filter(t => t.id.includes(list === 'sweep' ? '-s' : '-f')).length / 4000;
  assert.ok(Math.abs(perDay('sweep') - 0.2) < 0.02, `sweep at its natural rate (${perDay('sweep')})`);
  assert.ok(Math.abs(perDay('fvg') - 0.125) < 0.015, `fvg at its natural rate (${perDay('fvg')})`);
  assert.ok(s.trades.length / 5 === 10 && rw.trades.length / 4000 < 0.4, 'far fewer than the curated run\'s 10 a day');
  assert.deepStrictEqual(reweightStream(s, decisions, { rates, days: 50, seed: 5 }).days, reweightStream(s, decisions, { rates, days: 50, seed: 5 }).days, 'seeded');
  assert.throws(() => naturalRates(s, decisions, { rates: { sweep: { candidatesPerDay: 0.5 } } }), /no rate for fvg/);
  assert.deepStrictEqual(validateRates({ a: { candidatesPerDay: -1 } }), ['rates.a.candidatesPerDay: a number of candidates per trading day, 0 or more']);
  const w = reweightStream(s, decisions, { weights: Object.fromEntries(s.trades.map(t => [t.id, 0.1])), days: 2000, seed: 2 });
  assert.ok(Math.abs(w.trades.length / 2000 - 1) < 0.1, 'weights: a tenth as often as the run had them (10 a day -> 1)');
  let n = 0;
  const r = rng(1);
  for (let i = 0; i < 2000; i += 1) n += poisson(r, 45);
  assert.ok(Math.abs(n / 2000 - 45) < 1, 'a large mean in chunks');
});

test('natural rates: the candidates are the moments stepped (plain passes included), the entries the distinct moments entered', () => {
  // The review's case: 10 moments of one list, 2 entered, 8 where the model composed nothing (plain passes, `none`),
  // one entered moment composed twice. The scan finds 1 candidate a day: 2 of 10 taken is 0.2 trades a day, not 1.0.
  const days = weekdays('2022-03-01', 10);
  const decisions = [];
  const s = modelStreamOf(days, (d, k) => {
    const moment = `m${k}`;
    if (k === 0) {
      decisions.push({ id: `${d}-a`, decision: 'entered', moment }, { id: `${d}-b`, decision: 'passed', moment });
      return [modelTrade(`${d}-a`, 60)];
    }
    if (k === 1) {
      // Entered twice in one moment (a re-entry): one candidate taken, its two trades sharing its rate.
      decisions.push({ id: `${d}-a`, decision: 'entered', moment }, { id: `${d}-b`, decision: 'entered', moment });
      return [modelTrade(`${d}-a`, -40), modelTrade(`${d}-b`, 60)];
    }
    decisions.push({ id: `${d}-x`, decision: 'none', moment }, { id: `${d}-y`, decision: 'none', moment });
    return [];
  });
  decisions.push({ id: 'between', decision: 'none' }); // a cycle between the moments: no candidate
  const rates = { trend: { candidatesPerDay: 1 } };
  const nat = naturalRates(s, decisions, { rates });
  assert.deepStrictEqual([nat.lists.trend.moments, nat.lists.trend.candidates, nat.lists.trend.entered, nat.lists.trend.tradesPerDay], [10, 10, 2, 0.2]);
  assert.ok(Math.abs(nat.tradesPerDay - 0.2) < 1e-9, `${nat.tradesPerDay}`);
  assert.ok(Math.abs(nat.perTrade.get(`${days[1]}-a`) - 0.05) < 1e-9, 'a moment entered twice: its trades share its rate');
  const rw = reweightStream(s, decisions, { rates, days: 4000, seed: 3 });
  assert.ok(Math.abs(rw.trades.length / 4000 - 0.2) < 0.02, `rebuilt at 0.2 a day (${rw.trades.length / 4000})`);
  // A composed decision outside every moment can't be counted: refused, never guessed.
  assert.throws(() => naturalRates(s, [...decisions, { id: 'stray', decision: 'passed' }], { rates }), /decision stray lies in no curated moment/);
  // From the lists document's windows (curatedRates): the same count, a window holding several cycles one moment.
  const { curatedRates } = require('../../scripts/lib/prop/natural-rate');
  const win = d => ({ from: `${d}T14:00:00.000Z`, to: `${d}T15:00:00.000Z` });
  const doc = { lists: { trend: days.map((d, k) => ({ id: `m${k}`, day: d, window: win(d) })) }, coverage: { trend: { candidates: 10 } }, mix: days.map((_d, k) => `m${k}`) };
  const c = curatedRates(doc, { scanDays: 10 });
  const placed = decisions.filter(x => x.id !== 'between').map(x => ({ ...x, moment: undefined, cycleAt: `${x.id.slice(0, 10)}T14:${x.id.endsWith('b') || x.id.endsWith('y') ? '30' : '03'}:00.000Z` }));
  placed.push({ id: 'between', decision: 'none', cycleAt: `${days[3]}T16:00:00.000Z` });
  const viaDoc = naturalRates(s, placed, { rates: c.rates, listOf: c.listOf, momentOf: c.momentOf });
  assert.deepStrictEqual([viaDoc.lists.trend.moments, viaDoc.lists.trend.entered, viaDoc.lists.trend.tradesPerDay], [10, 2, 0.2]);
});

test('a curated run\'s score is "diagnostic (reweighted)" and the promotion gate refuses it; the zero-blow gate is untouched', () => {
  const days = weekdays('2022-03-01', 5);
  const decisions = [];
  const s = modelStreamOf(days, d => {
    const out = [];
    for (let i = 0; i < 6; i += 1) { decisions.push({ id: `${d}-${i}`, day: d, decision: 'entered', list: 'sweep', moment: `${d}-${i}` }); out.push(modelTrade(`${d}-${i}`, i % 3 === 2 ? -40 : 60)); }
    return out;
  });
  const rw = reweightStream(s, decisions, { rates: { sweep: { candidatesPerDay: 1 } }, days: 300, seed: 1 });
  assert.throws(() => scoreStream(rw, { ...quick, pass: checkModelWindow({ run: run() }) }), /only as a diagnostic/);
  assert.throws(() => scoreStream(s, { ...quick, pass: checkModelWindow({ run: run(), diagnostic: 'reweighted' }) }), /needs the reweighted stream/);
  const r = scoreStream(rw, { ...quick, pass: checkModelWindow({ run: run(), diagnostic: 'reweighted' }) });
  assert.deepStrictEqual([r.score, r.diagnostic, r.promotion.passes], ['diagnostic (reweighted)', true, false]);
  assert.match(r.promotion.failures[0], /diagnostic \(reweighted\)\) is never a promotion score/);
  // The rebuilt days go through the gate's loss limits too (the env's by default, as live).
  assert.deepStrictEqual(r.inputs.gate, at.gateLimits());
  const strict = scoreStream(rw, { ...quick, pass: checkModelWindow({ run: run(), diagnostic: 'reweighted' }), gate: { maxDailyLosses: 1, maxConsecutiveLosses: 99, lossCooldownMin: 0 } });
  const open = scoreStream(rw, { ...quick, pass: checkModelWindow({ run: run(), diagnostic: 'reweighted' }), gate: null });
  assert.notDeepStrictEqual([strict.resampled.passRate, strict.resampled.medianDaysToPass], [open.resampled.passRate, open.resampled.medianDaysToPass], 'one loss a day: the rebuilt days trade less');
  // The gate's own: a result that would pass, refused only for being diagnostic.
  const good = { attempts: 40, passed: 30, blown: 0, ess: 25, months: { '2024-07': { blown: 0 }, '2024-08': { blown: 0 } } };
  assert.deepStrictEqual(gateFailures(good), []);
  assert.strictEqual(gateFailures({ ...good, diagnostic: true }).length, 1);
  assert.deepStrictEqual(gateFailures({ ...good, diagnostic: false }), []);
  assert.deepStrictEqual(PROMOTION_GATE, { minPassRate: 0.4, maxBlows: 0, minAttempts: 20, minMonths: 2 }, 'the frozen numbers');
  assert.match(gateFailures({ ...good, blown: 1 }).join(), /zero blows is the rule/);
  // A full-day run's score is real, with the p90 days to pass beside the median.
  const real = scoreStream(steady(), { ...quick, pass: checkModelWindow({ run: run() }) });
  assert.deepStrictEqual([real.score, real.diagnostic], ['real', false]);
  assert.ok(real.p90DaysToPass >= real.medianDaysToPass && real.resampled.p90DaysToPass >= real.resampled.medianDaysToPass);
  const sf = scoreStream(steady(), { ...quick, pass: checkModelWindow({ run: run(), diagnostic: 'setup-focused' }) });
  assert.strictEqual(sf.promotion.passes, false);
});

/**
 * The acceptance scenario (the owner's): every day a high-confluence setup (55% at +1.5R) and on most days a
 * low-confluence one (20% at +2R; its losses gap 30 ticks past the stop). A takes everything; B is the same run
 * except that it passed on a low-confluence setup whenever its own replayed account was near the max loss limit.
 */
function acceptance() {
  const days = weekdays('2022-01-03', 160);
  const r = rng(7);
  const script = days.map(() => {
    const list = [{ q: 'high', move: r() < 0.55 ? 60 : -40 }];
    if (r() < 0.6) list.push({ q: 'low', move: r() < 0.2 ? 80 : -71 });
    return list;
  });
  const mk = (d, x, i) => modelTrade(`${d}-${i}`, x.move, { alignment: x.q === 'high' ? 'aligned' : 'counter' },
    x.move === -71 ? { overshootTicks: 30, troughTicks: [-71], noStop: { worstTicks: -200, closeTicks: -150 } } : { noStop: { worstTicks: -60, closeTicks: x.move } });
  const A = modelStreamOf(days, (d, k) => script[k].map((x, i) => mk(d, x, i)));
  const sizing = testSizing({ cushion_frac: 0.4 });
  const legs = at.legsFor(ACCOUNT, 'MNQ', { tickValue: 0.5 });
  const passed = new Set();
  let cs = combine.start(ACCOUNT);
  for (const d of A.days) {
    for (const t of d.trades) {
      if (t.facts.alignment === 'counter' && stateOf(cs) === 'near-mll') { passed.add(t.id); continue; }
      const plan = at.defaultSize({ cs, trade: t, sizing, legs: legs.legs, mode: 'micro', ratio: 10, fraction: 1 });
      if (!plan || combine.entryBlock(cs)) continue;
      cs = combine.applyClose(cs, t.moveTicks * 0.5 * plan.size - 0.74 * plan.size);
    }
    cs = combine.endDay(cs);
    if (cs.status !== 'active') cs = combine.start(ACCOUNT);
  }
  const B = modelStreamOf(days, (d, k) => script[k].map((x, i) => mk(d, x, i)).filter(t => !passed.has(t.id)));
  B.days.forEach((d, k) => { d.passes = script[k].length - d.trades.length; });
  return { A, B, passed, opts: { ...quick, paths: 400, reps: 400, rulebook: { sizing: testSizing({ cushion_frac: 0.4 }) }, faults: { stopFault: 0.02 } } };
}

test('acceptance: the paired comparison tells the more selective rule near the max loss limit (more passes, fewer blows) from taking everything', () => {
  const { A, B, passed, opts } = acceptance();
  assert.ok(passed.size > 20, 'the selective run passed on low-confluence setups near the limit');
  const res = scorePaired(B, A, { ...opts, passA: checkModelWindow({ run: run({ runId: 'selective' }) }), passB: checkModelWindow({ run: run({ runId: 'all' }) }) });
  const d = res.diff.resampled;
  assert.strictEqual(res.verdict, 'A better');
  assert.ok(d.passRate.lo > 0, `more passes within 30 days, the paired interval above 0 (${JSON.stringify(d.passRate)})`);
  assert.ok(d.blowRate.hi < 0, `fewer blows, the paired interval below 0 (${JSON.stringify(d.blowRate)})`);
  assert.ok(res.a.resampled.passRate > res.b.resampled.passRate && res.a.resampled.blowRate < res.b.resampled.blowRate);
  assert.deepStrictEqual(res.paired, { sameDays: true, sameBlocks: true, sameFaults: true, oneRulebook: true });
  assert.ok(Number.isFinite(d.medianDaysToPass.diff));
  // The same run against itself: exactly no difference (the same paths, blocks and faults).
  const same = scorePaired(A, A, { ...opts, passA: checkModelWindow({ run: run() }), passB: checkModelWindow({ run: run({ runId: 'r2' }) }) });
  assert.deepStrictEqual([same.verdict, same.diff.resampled.passRate.diff, same.diff.resampled.passRate.lo, same.diff.resampled.blowRate.hi], ['no significant difference', 0, 0, 0]);
  // Swapped: the other way round.
  assert.strictEqual(scorePaired(A, B, { ...opts, passA: checkModelWindow({ run: run({ runId: 'all' }) }), passB: checkModelWindow({ run: run({ runId: 'selective' }) }) }).verdict, 'B better');
  // Two runs of different days are no pair; one pass for both is refused.
  const p = checkModelWindow({ run: run() });
  assert.throws(() => scorePaired(A, A, { ...opts, passA: p, passB: p }), /one pass per run/);
  const short = modelStreamOf(A.days.slice(1).map(x => x.day), () => []);
  assert.throws(() => scorePaired(A, short, { ...opts, passA: checkModelWindow({ run: run() }), passB: checkModelWindow({ run: run({ runId: 'r3' }) }) }), /same days/);
});

test('scorePaired with a rulebook per side: B sized under its own (a candidate\'s pass), A unchanged; the same draws; the raw start days', () => {
  const { A, opts } = acceptance();
  const one = scorePaired(A, A, { ...opts, passA: checkModelWindow({ run: run() }), passB: checkModelWindow({ run: run({ runId: 'r2' }) }) });
  const tight = { sizing: testSizing({ cushion_frac: 0.1 }), candidate: true };
  const two = scorePaired(A, A, { ...opts, rulebookB: tight, passA: checkModelWindow({ run: run() }), passB: checkModelWindow({ run: run({ runId: 'r2' }), candidateRulebook: true }) });
  assert.deepStrictEqual(two.a, { ...one.a }, 'side A is scored as before');
  assert.notDeepStrictEqual(two.b.resampled, two.a.resampled, 'side B is sized under its own rulebook');
  assert.strictEqual(two.paired.oneRulebook, false);
  assert.strictEqual(one.paired.oneRulebook, true);
  // The raw start days the keep rule pools: one per real attempt, each side's status as its real rates count them.
  assert.strictEqual(two.starts.length, A.days.length - ACCOUNT.sessions);
  assert.strictEqual(two.starts[0].start, A.days[0].day);
  const rate = side => Math.round((two.starts.filter(x => x[side] === 'passed').length / two.starts.length) * 10000) / 10000;
  assert.deepStrictEqual([rate('a'), rate('b')], [two.a.real.passRate, two.b.real.passRate]);
  // A candidate rulebook only on a candidate's pass (refused on test and final by checkModelWindow), and one attempt length.
  assert.throws(() => scorePaired(A, A, { ...opts, rulebookB: tight, passA: checkModelWindow({ run: run() }), passB: checkModelWindow({ run: run({ runId: 'r2' }) }) }), /candidate rulebook is scored only on a pass checked for one/);
  assert.throws(() => scorePaired(A, A, { ...opts, accountB: { ...ACCOUNT, sessions: 20 }, passA: checkModelWindow({ run: run() }), passB: checkModelWindow({ run: run({ runId: 'r2' }) }) }), /same sessions/);
});

/**
 * Stage-2 risk decisions the keep rule must see. Two setups a day on 160 days, half at +60 ticks, half losers whose
 * second bar gaps through the 40-tick stop (filled at -81), each with its price path, under a policy exit (mode target):
 * re-exited, every trade is the bracket's. hold: every loser rides into the gap. cut: the model takes every loser out
 * at -10 ticks on its first bar (early-exit). size: every entry at a share of the ceiling (sizeFraction).
 */
function riskRuns() {
  const days = weekdays('2022-01-03', 160);
  const r = rng(11);
  const script = days.map(() => Array.from({ length: 2 }, () => r() < 0.5));
  const trade = (d, i, win, extra = {}) => modelTrade(`${d}-${i}`, win ? 60 : -81, {}, {
    path: win ? [[0, -5, 65, 60]] : [[0, -20, 5, -15], [-80, -90, -75, -85]], ownExit: { targetTicks: 60, trailActivateR: null, trailGivebackR: null },
    troughTicks: win ? [-5] : [-20, -81], overshootTicks: null, ...extra,
  });
  const of = f => modelStreamOf(days, (d, k) => script[k].map((win, i) => f(d, i, win)));
  return {
    hold: of((d, i, win) => trade(d, i, win)),
    cut: of((d, i, win) => (win ? trade(d, i, win) : trade(d, i, win, { moveTicks: -10, r: -0.25, troughTicks: [-10], actions: ['early-exit'] }))),
    size: f => of((d, i, win) => trade(d, i, win, { sizeFraction: f, actions: f < 1 ? ['size-down'] : [] })),
    opts: { ...quick, paths: 300, reps: 300, rulebook: { exit: { mode: 'target' }, sizing: testSizing({ cushion_frac: 0.4 }) } },
  };
}
const pair = (A, B, opts) => scorePaired(A, B, { ...opts, passA: checkModelWindow({ run: run({ runId: 'champ' }) }), passB: checkModelWindow({ run: run({ runId: 'chall' }) }) });

test('scorePaired sized "own": a challenger that cuts its losers early scores apart from one that holds; at the ceiling the policy exit erased it', () => {
  const { hold, cut, opts } = riskRuns();
  const own = pair(hold, cut, { ...opts, sized: 'own' });
  assert.strictEqual(own.sizedAs, 'own');
  assert.ok(own.blows.a > 0 && own.blows.b === 0, `the holder blows, the cutter never (${JSON.stringify(own.blows)})`);
  assert.strictEqual(own.verdict, 'B better');
  // Beside it, labelled: the ceiling under the policy exit, where both runs are the same trades.
  assert.match(own.ceiling.label, /code's ceiling .* never judged/);
  assert.deepStrictEqual(own.ceiling.a, own.ceiling.b, 'at the ceiling every exit is the bracket\'s: no difference');
  assert.ok(own.ceiling.blows.b > 0, 'at the ceiling the cutter rides into the gap too');
  assert.strictEqual(own.ceiling.verdict, 'no significant difference');
  // The default (the ceiling) is unchanged and carries no own line.
  const ceil = pair(hold, cut, opts);
  assert.deepStrictEqual([ceil.sizedAs, ceil.ceiling, ceil.verdict], ['ceiling', undefined, 'no significant difference']);
  assert.throws(() => pair(hold, cut, { ...opts, sized: 'model' }), /sized is one of ceiling, own/);
});

test('scoreArms sized "own": the model\'s early exits aren\'t re-exited under the policy exit in the base', () => {
  const { scoreArms, ownShare } = require('../../scripts/lib/prop/evaluator');
  const { hold, cut, opts } = riskRuns();
  const go = (stream, sized) => scoreArms(stream, { ...opts, base: ownShare, ...(sized ? { sized } : {}), pass: checkModelWindow({ run: run({ runId: 'arms' }) }) });
  assert.deepStrictEqual(go(cut).base, go(hold).base, 'at the ceiling every exit is the bracket\'s: the cut is erased');
  assert.deepStrictEqual(go(hold, 'own').base, go(hold).base, 'no early-exit action: unchanged');
  const own = go(cut, 'own').base;
  assert.notDeepStrictEqual(own, go(cut).base, 'the model\'s own exits stand in the base');
  assert.ok(own.blowRate < go(hold, 'own').base.blowRate, 'cutting the losers before the gap blows less');
  assert.throws(() => go(cut, 'model'), /sized is one of ceiling, own/);
  // The risk-action scoring uses it: its base is the model as it traded.
  const sr = require('../../scripts/lib/prop/risk-actions').scoreRiskActions(cut, { ...opts, pass: checkModelWindow({ run: run({ runId: 'ra' }) }) });
  assert.deepStrictEqual(sr.base, own);
});

test('scorePaired sized "own": a challenger that sizes up is penalized for it; a policy-exited trade keeps the policy exit', () => {
  const { size, opts } = riskRuns();
  // The champion sized a tenth of the ceiling, the challenger the whole of it: only the challenger blows.
  const own = pair(size(0.1), size(1), { ...opts, sized: 'own' });
  assert.ok(own.blows.a === 0 && own.blows.b > 0, `full size blows (${JSON.stringify(own.blows)})`);
  assert.strictEqual(own.verdict, 'A better');
  assert.deepStrictEqual(own.ceiling.a, own.ceiling.b, 'at the ceiling both are the same');
  // A loser the bracket closed (no early exit of the model's) is still re-exited under the policy exit: the holder's
  // recorded -81 and a version recorded at -10 without the action score alike.
  const { hold } = riskRuns();
  const relabel = modelStreamOf(hold.days.map(d => d.day), (_d, k) => hold.days[k].trades.map(t => (t.moveTicks < 0 ? { ...t, moveTicks: -10, troughTicks: [-10] } : t)));
  const same = pair(hold, relabel, { ...opts, sized: 'own' });
  assert.deepStrictEqual(same.a, same.b, 'no early-exit action: the policy exit decides, whatever was recorded');
});

test('scorePaired: side B is exited under its own rulebook exit (A\'s unchanged), so B\'s result changes', () => {
  // Each trade recorded a +60 win, but its path hits the 40-tick stop on the first bar: only a re-exit (exit.mode) shows it.
  const trade = d => [modelTrade(`${d}-0`, 60, {}, { path: [[0, -45, 10, -40], [-40, -45, 70, 60]] })];
  const S = modelStreamOf(DAYS, trade);
  const pa = () => checkModelWindow({ run: run({ runId: 'ea' }) });
  const pb = () => checkModelWindow({ run: run({ runId: 'eb' }) });
  const same = scorePaired(S, S, { ...quick, passA: pa(), passB: pb() });
  const exited = scorePaired(S, S, { ...quick, rulebookB: { sizing: TEST_SIZING, exit: { mode: 'target' } }, passA: pa(), passB: pb() });
  assert.deepStrictEqual(exited.a, same.a, 'side A keeps its own exit (the recorded one)');
  assert.notDeepStrictEqual(exited.b.real, same.b.real, 'side B was re-exited under its own rulebook');
  assert.ok(exited.b.real.passRate < same.b.real.passRate, 'every B trade stops out on its path: B passes less');
});

test('policyRulebook: a policy\'s whole entry as the Monte Carlo applies it; its multipliers on the trade\'s facts fail closed', () => {
  const { policyRulebook } = require('../../scripts/lib/prop/model-score');
  const t = modelTrade('t1', 60, { volatility: 'high' });
  const items = [{ item: 'x', fact: 'volatility', values: { normal: 1, high: 0.5 } }];
  const rb = policyRulebook({ sizing: { cap_usd: 500 }, exit: { mode: 'target' }, multipliers: items }, { candidate: true });
  assert.deepStrictEqual([rb.sizing, rb.exit, rb.candidate], [{ cap_usd: 500 }, { mode: 'target' }, true]);
  assert.strictEqual(rb.multiplier(t), 0.5);
  assert.strictEqual(rb.multiplier(modelTrade('t2', 60, { volatility: null })), 0, 'a missing fact skips the trade');
  assert.strictEqual(policyRulebook({ sizing: null, multipliers: [] }).multiplier(t), 1);
  assert.strictEqual(policyRulebook(null).candidate, undefined);
  assert.strictEqual(policyRulebook({ sizing: {} }).exit, undefined);
});

test('risk attribution: by account state, with the decisions that cost attempts flagged; the risk record under 4 KB with its sample sizes', () => {
  const { A, B, opts } = acceptance();
  const r = scoreStream(A, { ...opts, pass: checkModelWindow({ run: run() }), attribution: true });
  const s = r.attribution.states;
  assert.deepStrictEqual(Object.keys(s), ['fresh', 'mid', 'near-target', 'near-mll']);
  assert.strictEqual(r.attribution.attempts, r.resampled.paths);
  const taken = Object.values(s).reduce((a, x) => a + x.taken, 0);
  assert.ok(taken > 0 && s['near-mll'].taken > 0);
  assert.ok(s['near-mll'].blowShare > s['near-target'].blowShare, 'near the limit, a trade sits in more blown attempts');
  assert.ok(s['near-mll'].meanR < 0);
  const blownTrades = Object.values(s).reduce((a, x) => a + x.blewHere, 0);
  assert.ok(blownTrades > 0 && blownTrades <= r.blows.resampled, 'each blow is one trade');
  const kinds = new Set(r.attribution.flagged.map(f => f.kind));
  for (const k of ['near-mll-blown', 'daily-stop-extra']) assert.ok(kinds.has(k), `${k} flagged`);
  // The model's passes counted by state (the selective run passed near the limit).
  const rb = scoreStream(B, { ...opts, pass: checkModelWindow({ run: run({ runId: 'b' }) }), attribution: true });
  assert.ok(Object.values(rb.attribution.states).reduce((a, x) => a + x.passed, 0) > 0);
  const rec = riskRecord(r.attribution, { minN: 40 });
  assert.ok(Buffer.byteLength(rec.text) <= 4096);
  assert.match(rec.text, /near the max loss limit, alignment=counter: n \d+, \d+ in attempts that blew, \d+ that passed, mean R -?[\d.]+/);
  assert.ok(rec.cells.every(c => c.n >= 40));
  assert.ok(Buffer.byteLength(riskRecord(r.attribution, { minN: 1, maxBytes: 300 }).text) <= 300, 'the cap holds');
  // Without attribution the result carries none.
  assert.strictEqual(scoreStream(A, { ...opts, pass: checkModelWindow({ run: run() }) }).attribution, undefined);
  const a = createAttribution();
  a.end('passed');
  assert.strictEqual(a.result().attempts, 1);
});

test('account states: drawn from the Monte Carlo\'s own attempt paths, bucketed, seeded and hashed; each record reads back to its state', () => {
  const { A } = acceptance();
  const one = sampleAccountStates(A, { account: ACCOUNT, sizing: testSizing({ cushion_frac: 0.4 }), contracts: 'micro', seed: 4, paths: 100, perBucket: 3 });
  const again = sampleAccountStates(A, { account: ACCOUNT, sizing: testSizing({ cushion_frac: 0.4 }), contracts: 'micro', seed: 4, paths: 100, perBucket: 3 });
  const other = sampleAccountStates(A, { account: ACCOUNT, sizing: testSizing({ cushion_frac: 0.4 }), contracts: 'micro', seed: 5, paths: 100, perBucket: 3 });
  assert.strictEqual(one.hash, again.hash, 'the same seed, the same draw');
  assert.notStrictEqual(one.hash, other.hash, 'another seed, another draw');
  assert.match(one.hash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual([...new Set(one.states.map(s => s.bucket))].sort(), ['fresh', 'mid', 'near-mll', 'near-target']);
  const { stateFrom } = require('../../scripts/lib/trading/prop-state');
  for (const s of one.states) {
    const cs = stateFrom(ACCOUNT, s.record, s.balance);
    assert.deepStrictEqual([cs.balance, cs.floor, cs.days.length + 1], [s.balance, s.floor, s.day], 'the record seeds the same account');
    assert.strictEqual(s.facts.day, s.day);
  }
});

test('the account-policy hook: a candidate rulebook scored through the same Monte Carlo; its values checked by the rulebook\'s rules; never on a sealed run', () => {
  const { A } = acceptance();
  const cand = { sizing: testSizing({ cushion_frac: 0.4, cap_usd: 'off', drawdown_halve_usd: 'off', min_size_guard: 1.5, stop_slippage_ticks: 1, clock_k: 'off', r_per_session: 0.3 }), daily_loss_soft: 'off', stand_down: 0, multipliers: [] };
  assert.deepStrictEqual(validateCandidate(cand), []);
  assert.match(validateCandidate({ ...cand, sizing: testSizing({ ...cand.sizing, cap_usd: 0 }) }).join(), /sizing.cap_usd/);
  assert.match(validateCandidate({ ...cand, stand_down: 2 }).join(), /stand_down/);
  assert.match(validateCandidate({ ...cand, multipliers: [{ item: 'room', fact: 'alignment', values: { aligned: 1 } }] }).join(), /classified enforced/);
  const opts = { ...quick, paths: 300, faults: { stopFault: 0.02 } };
  assert.throws(() => scoreCandidate(A, cand, { ...opts, pass: checkModelWindow({ run: run() }) }), /candidate rulebook is scored only on a pass checked for one/);
  const base = scoreCandidate(A, cand, { ...opts, pass: checkModelWindow({ run: run(), candidateRulebook: true }) });
  // Skip low-confluence setups: a multiplier on the record's alignment (an enforced item).
  const skipCounter = scoreCandidate(A, { ...cand, multipliers: [{ item: 'multipliers', fact: 'alignment', values: { aligned: 1, counter: 0 } }] }, { ...opts, pass: checkModelWindow({ run: run(), candidateRulebook: true }) });
  assert.ok(skipCounter.resampled.blowRate < base.resampled.blowRate, 'the hook moves the score');
  // A stand-down: no entry while the cushion is under 90% of the max loss.
  const stand = scoreCandidate(A, { ...cand, stand_down: 0.9 }, { ...opts, pass: checkModelWindow({ run: run(), candidateRulebook: true }) });
  assert.ok(stand.resampled.blowRate < base.resampled.blowRate && stand.candidate.stand_down === 0.9, 'standing down near the limit blows less');
  assert.throws(() => checkModelWindow({ run: run({ from: '2025-03-03', to: '2025-03-08', role: 'test', look: { evaluation: 'e' } }), candidateRulebook: true, logScore: () => {} }), /never scored on test/);
});

test('scoreRun: a finished practice-validate run scored end to end, logged beside its look; the section never throws', () => {
  const home = tmpHome('fth-pmc-');
  const ledger = path.join(home, 'ledger', 'looks.jsonl');
  const t0 = '2024-07-15T14:00:00.000Z';
  const look = { evaluation: 'v1', candidate: 'v1', purpose: 'validate', runId: 'run1', from: '2024-07-15', to: '2024-07-17' };
  looks.recordLook(ledger, look, { create: true });
  const { dir } = multiDayRun({
    home,
    gate: { learning: true, role: 'practice-validate', look: { evaluation: 'v1', candidate: 'v1', purpose: 'validate' }, hideOutcomes: false, ledger },
    days: [
      { day: '2024-07-15', times: [t0], records: [record({ at: t0 })], rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 100, 104.25]],
        fills: [{ id: 1, contractId: 'MNQ:2024-09', creationTimestamp: '2024-07-15T14:01:00Z', price: 100, size: 1, side: 0, profitAndLoss: null }, { id: 2, contractId: 'MNQ:2024-09', creationTimestamp: '2024-07-15T14:05:00Z', price: 104, size: 1, side: 1, profitAndLoss: 8 }] },
      { day: '2024-07-16', times: ['2024-07-16T14:00:00.000Z'], rows: [] },
    ],
  });
  // No policy (no rulebook sizing): refused before any look is spent, never scored on a code default.
  for (const policy of [null, { name: 'p', sizing: { cushion_frac: 0.2 } }]) {
    assert.throws(() => scoreRun(dir, { account: ACCOUNT, policy, paths: 50, reps: 100 }), /no policy strategy with a whole rulebook sizing trades it/);
    assert.throws(() => pairRuns(dir, dir, { account: ACCOUNT, policy, paths: 50, reps: 100 }), /no policy strategy with a whole rulebook sizing trades it/);
  }
  assert.strictEqual(looks.scoresOf(readLedger(ledger)).length, 0, 'no look spent on a refused score');
  const r = scoreRun(dir, { account: ACCOUNT, policy: POLICY, paths: 50, reps: 100 });
  assert.deepStrictEqual([r.score, r.role, r.trades, r.runDays, r.look.kind, r.look.runId], ['real', 'practice-validate', 1, 2, 'score', 'run1']);
  assert.strictEqual(looks.scoresOf(readLedger(ledger)).length, 1);
  const text = scoreText(r);
  for (const want of [/1\. Zero blows \(hard gate\): held/, /2\. Pass within 30 trading days/, /3\. Days to pass: median/, /4\. Blow rate/, /Promotion gate: n\/a \(practice-validate is not out of sample; it would refuse: /]) assert.match(text, want);
  assert.ok(text.indexOf('1. Zero') < text.indexOf('2. Pass') && text.indexOf('2. Pass') < text.indexOf('3. Days') && text.indexOf('3. Days') < text.indexOf('4. Blow'), 'the owner\'s order');
  // Two days hold no whole attempt: the first line says the resampled numbers are not evidence, and the resampled
  // interval is labelled conditional on the run's days, never a count of independent attempts.
  assert.match(text.split('\n')[0], /^0 independent attempts: resampled only, not evidence\. Prop Monte Carlo/);
  assert.match(text.split('\n')[0], /2 distinct day\(s\), 0 independent attempt\(s\); every entry sized at the code's ceiling \(the verdict's\), not the model's own size/);
  assert.match(text, /resampled [\d.]+% of 50 paths \(Wilson \[[^\]]+\], conditional on these 2 days\)/);
  const long = scoreText({ ...r, runDays: 75, real: { ...r.real, attempts: 45 } });
  assert.match(long.split('\n')[0], /^Prop Monte Carlo, .*75 distinct day\(s\), 2 independent attempt\(s\)/, 'real attempts: no warning, floor(75 / 30) independent');
  const { learningText } = require('../../scripts/lib/learning/learning-report');
  const { scoreSummary } = require('../../scripts/lib/prop/model-score');
  const line = learningText({ decisions: { composed: 0, entered: 0, passed: 0, refused: 0, none: 0 }, steps: {}, reads: {}, diversity: {}, passes: { good: 0, missed: 0 }, lookups: {}, record: { all: {} }, prop: scoreSummary(r) });
  assert.match(line, /; 0 independent attempts: resampled only, not evidence; prop Monte Carlo \(real, 2 distinct days, 0 independent attempts, sized at the code's ceiling\)/);
  assert.match(line, /resampled \(conditional on these days\)/);
  // Rates given by hand reweight a curated run only: its candidates are the moments its lists document places.
  const ratesFile = path.join(home, 'rates.json');
  fs.writeFileSync(ratesFile, JSON.stringify({ sweep: { candidatesPerDay: 0.5 } }));
  const root = path.resolve(__dirname, '..', '..');
  assert.match(propScoreSection(dir, { root, ratesFile }).text, /not scored \(rates by hand reweight a curated run: its candidates are the curated moments it stepped/);
  assert.strictEqual(looks.scoresOf(readLedger(ledger)).length, 1, 'nothing scored, nothing logged');
  assert.match(propScoreSection(dir, { root, override: 'no_such_account' }).text, /Prop Monte Carlo: not scored/);
  // The run's section sizes as the live entry does (liveSizing): the shipped policy's composed cap and the run's contract.
  const sec = propScoreSection(dir, { root });
  assert.ok(sec.result, sec.text);
  assert.strictEqual(sec.result.sizedWith.limits.capUsd, require('../../scripts/lib/trading/strategies').loadStrategies(root, {}).strategies.find(s => s.name === 'trade_lifecycle').risk.max_risk_usd);
  // No account: not scored, said why.
  assert.deepStrictEqual(resolveAccount({ accounts: [{ name: 'a' }, { name: 'b' }], strategies: [] }).name, null);
  assert.strictEqual(resolveAccount({ attempts: ['a'], accounts: [{ name: 'a' }] }).name, 'a');
  assert.strictEqual(resolveAccount({ strategies: [{ signal: 'policy', account: 'b' }], accounts: [{ name: 'b' }] }).why, 'the policy strategies\' account');
});

test('liveSizing: the run\'s Monte Carlo sizes with the broker\'s max from the run home, the contract the runner traded, and the composed cap', () => {
  const { liveSizing } = require('../../scripts/lib/prop/model-score');
  const { recordBrokerSpecs } = require('../helpers');
  const { brokerOrderLimit, contractsFileFor } = require('../../scripts/lib/trading/broker-specs');
  const pol = { name: 'prop_portfolio', strategies: ['trade_lifecycle'] };
  const comp = { name: 'trade_lifecycle', signal: 'composed', risk: { max_risk_usd: 300 } };
  // The run home's recorded broker max, as the gate reads it; a home with none: no broker limit.
  const home = tmpHome('fth-ls-');
  recordBrokerSpecs(home);
  const orderMax = brokerOrderLimit(contractsFileFor(home, {})).maxOrderSize;
  assert.ok(Number.isInteger(orderMax) && orderMax >= 1, 'the fixture records one');
  const live = (o = {}) => liveSizing({ policy: pol, strategies: [pol, comp], home, runner: {}, env: {}, ...o });
  assert.strictEqual(live().limits.orderMax, orderMax);
  assert.strictEqual(live({ home: tmpHome('fth-ls0-') }).limits.orderMax, null);
  // The composed component's cap; none: the broker's max alone (never dropped with the cap); neither: no limits.
  assert.strictEqual(live().limits.capUsd, 300);
  assert.deepStrictEqual(live({ strategies: [pol, { ...comp, risk: {} }] }).limits, { capUsd: null, orderMax });
  assert.strictEqual(live({ strategies: [pol], home: tmpHome('fth-ls1-') }).limits, null);
  // The contract the runner traded: every symbol a micro, micro; every one a mini, mini; mixed or none, the policy's.
  assert.strictEqual(live({ runner: { symbols: ['MNQ'] } }).contracts, 'micro');
  assert.strictEqual(live({ runner: { symbols: ['MNQ', 'MES'] } }).contracts, 'micro');
  assert.strictEqual(live({ runner: { symbols: ['NQ'] } }).contracts, 'mini');
  assert.strictEqual(live({ runner: { symbols: ['MNQ', 'ES'] } }).contracts, null);
  assert.strictEqual(live().contracts, null);
});

test('scoreRun: a real score never leaves an unsettled entry out', () => {
  const t0 = '2023-03-15T14:00:00.000Z';
  const { dir } = multiDayRun({ days: [{ day: '2023-03-15', times: [t0], records: [record({ at: t0 })], rows: [[100.5, 100.75, 99.75, 100.25]],
    fills: [{ id: 1, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:01:00Z', price: 100, size: 1, side: 0, profitAndLoss: null }] }] });
  assert.throws(() => scoreRun(dir, { account: ACCOUNT, policy: POLICY, paths: 10, reps: 10 }), /without a settled outcome .* a real score never leaves one out/);
  void M3;
});

test('pairRuns: two replay runs of the same days through the same paths; a fault rate a real score\'s trades can\'t take is refused', () => {
  const days = weekdays('2023-03-06', 4);
  const mk = loses => multiDayRun({
    days: days.map((day, k) => {
      const t0 = `${day}T14:00:00.000Z`;
      const exit = loses && k % 2 ? 98.5 : 103;
      return {
        day, times: [t0], records: [record({ at: t0 })], rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 103.5, 98.25, 103]],
        fills: [{ id: 1, contractId: 'MNQ:2023-06', creationTimestamp: `${day}T14:01:00Z`, price: 100, size: 1, side: 0, profitAndLoss: null },
          { id: 2, contractId: 'MNQ:2023-06', creationTimestamp: `${day}T14:05:00Z`, price: exit, size: 1, side: 1, profitAndLoss: (exit - 100) * 2 }],
      };
    }),
  });
  const good = mk(false);
  const bad = mk(true);
  const res = pairRuns(good.dir, bad.dir, { account: ACCOUNT, policy: POLICY, paths: 200, reps: 200 });
  assert.deepStrictEqual(res.runs, { a: 'run1', b: 'run1' });
  // Judged as the model traded (its own sizes and exits), the ceiling-sized line beside it, labelled.
  assert.deepStrictEqual([res.sizedAs, res.ceiling.sizedAs], ['own', 'ceiling']);
  assert.match(res.ceiling.label, /never judged/);
  assert.ok(res.diff.resampled.passRate.diff >= 0, JSON.stringify(res.diff.resampled.passRate));
  assert.ok(res.a.resampled.passRate >= res.b.resampled.passRate);
  // policyB: each side under its own policy; candidateB: B's a candidate rulebook, its pass checked for one.
  const cand = pairRuns(good.dir, good.dir, { account: ACCOUNT, policy: { sizing: testSizing({ cushion_frac: 0.3 }) }, policyB: { sizing: testSizing({ cushion_frac: 0.1 }) }, candidateB: true, paths: 50, reps: 50 });
  assert.strictEqual(cand.paired.oneRulebook, false);
  assert.strictEqual(pairRuns(good.dir, good.dir, { account: ACCOUNT, policy: POLICY, paths: 50, reps: 50 }).paired.oneRulebook, true);
  // rootB: run B's records read with its own tree (the training loop's challenger), run A's with root.
  assert.throws(() => pairRuns(good.dir, bad.dir, { account: ACCOUNT, policy: POLICY, paths: 10, reps: 10, rootB: path.resolve(bad.dir, '..', '..', '..') }), new RegExp(`${path.resolve(bad.dir, '..', '..').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is inside the repository`));
  // No bars after a fill: no no-stop path, so a stop fault rate is refused for a real score.
  const t0 = '2023-03-15T14:00:00.000Z';
  const bare = multiDayRun({ days: [{ day: '2023-03-15', times: [t0], records: [record({ at: t0 })], rows: [],
    fills: [{ id: 1, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:01:00Z', price: 100, size: 1, side: 0, profitAndLoss: null },
      { id: 2, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:05:00Z', price: 101, size: 1, side: 1, profitAndLoss: 2 }] }] });
  assert.throws(() => scoreRun(bare.dir, { account: ACCOUNT, policy: POLICY, paths: 10, reps: 10, faults: { stopFault: 0.01 } }), /without a no-stop path .* silently drop out/);
  assert.strictEqual(scoreRun(bare.dir, { account: ACCOUNT, policy: POLICY, paths: 10, reps: 10 }).score, 'real');
});

test('scorePaired: zero blows first: a run with a blow never beats one without, however fast it passes', () => {
  // A wins more on every day but carries one gap loss through the floor; B never blows.
  const days = weekdays('2022-01-03', 300);
  const A = modelStreamOf(days, (d, k) => [k === 150 ? modelTrade(`${d}-0`, -900, {}, { troughTicks: [-900], overshootTicks: 859 }) : modelTrade(`${d}-0`, k % 3 === 2 ? -40 : 120)]);
  // B's losses close a tick inside the stop (no stop exit, so no overshoot drawn from A's gap).
  const B = modelStreamOf(days, (d, k) => [modelTrade(`${d}-0`, k % 3 === 2 ? -39 : 60)]);
  const res = scorePaired(A, B, { ...quick, contracts: 'micro', rulebook: { sizing: testSizing({ cushion_frac: 0.4 }) }, passA: checkModelWindow({ run: run({ runId: 'a', to: '2023-03-01' }) }), passB: checkModelWindow({ run: run({ runId: 'b', to: '2023-03-01' }) }) });
  assert.ok(res.blows.a > 0 && res.blows.b === 0, JSON.stringify(res.blows));
  assert.ok(res.a.resampled.medianDaysToPass < res.b.resampled.medianDaysToPass, 'A passes faster');
  assert.strictEqual(res.verdict, 'B better');
});

test('scoreRun: trades open at the same time (a scale-in) are refused in a real score', () => {
  const t0 = '2023-03-15T14:00:00.000Z';
  const t1 = '2023-03-15T14:03:00.000Z';
  const { dir } = multiDayRun({ days: [{ day: '2023-03-15', times: [t0, t1], records: [record({ at: t0 }), record({ at: t1 })],
    rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 101, 99.5, 100.5], [100.5, 101.5, 100, 101]],
    fills: [
      { id: 1, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:01:00Z', price: 100, size: 1, side: 0, profitAndLoss: null },
      { id: 2, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:04:00Z', price: 100, size: 1, side: 0, profitAndLoss: null },
      { id: 3, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:08:00Z', price: 101, size: 2, side: 1, profitAndLoss: 4 },
    ] }] });
  assert.throws(() => scoreRun(dir, { account: ACCOUNT, policy: POLICY, paths: 10, reps: 10 }), /open at the same time .* a real score refuses them/);
});

test('a curated run is reweighted at its lists\' natural rates from the curated scan\'s candidate counts; without its document it is not scored', () => {
  const CL = require('../../scripts/lib/learning/curated-lists');
  const { curatedRates } = require('../../scripts/lib/prop/natural-rate');
  const home = tmpHome('fth-pmc-');
  const ledger = path.join(home, 'ledger', 'looks.jsonl');
  // The decision on the window's last bar: its close (14:00) plus the runner's default 2 s poll delay.
  const t0 = '2024-07-15T14:00:02.000Z';
  looks.recordLook(ledger, { evaluation: 'v2', candidate: 'v2', purpose: 'validate', runId: 'run1', from: '2024-07-15', to: '2024-07-17' }, { create: true });
  const gate = { learning: true, role: 'practice-validate', look: { evaluation: 'v2', candidate: 'v2', purpose: 'validate' }, hideOutcomes: false, ledger, practice: { mode: 'setup-focus', setupTf: 15 } };
  const { dir } = multiDayRun({
    home, gate,
    days: [
      { day: '2024-07-15', times: [t0], records: [record({ at: t0 })], rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 100, 104.25]],
        fills: [{ id: 1, contractId: 'MNQ:2024-09', creationTimestamp: '2024-07-15T14:01:00Z', price: 100, size: 1, side: 0, profitAndLoss: null }, { id: 2, contractId: 'MNQ:2024-09', creationTimestamp: '2024-07-15T14:05:00Z', price: 104, size: 1, side: 1, profitAndLoss: 8 }] },
      { day: '2024-07-16', times: ['2024-07-16T14:00:00.000Z'], rows: [] },
    ],
  });
  // A lists document: one trend-up moment whose window holds the decision; the scan found 60 trend-up candidates.
  // A second moment (07-16) where the model composed nothing: a plain pass, still a candidate it let go.
  const moment = { id: 'm1', list: 'trend-up', day: '2024-07-15', window: { from: '2024-07-15T13:30:00.000Z', to: '2024-07-15T14:00:00.000Z' } };
  const quiet = { id: 'm2', list: 'trend-up', day: '2024-07-16', window: { from: '2024-07-16T13:30:00.000Z', to: '2024-07-16T14:00:00.000Z' } };
  const lists = Object.fromEntries(CL.LISTS.map(n => [n, n === 'trend-up' ? [moment, quiet] : []]));
  const coverage = Object.fromEntries([...CL.LISTS.map(n => [n, { candidates: n === 'trend-up' ? 60 : 0 }]), ['mix', { candidates: 60 }]]);
  const body = { v: CL.VERSION, kind: CL.KIND, builtAt: 'x', use: 'validate', role: 'practice-validate', market: { roots: ['MNQ'], minutes: 3, setupTf: 15 }, seed: 1, options: {}, sources: [], lists, mix: ['m1', 'm2'], short: {}, coverage };
  const doc = { ...body, fingerprint: CL.fingerprintOf(body) };
  const file = path.join(home, 'curated.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  CL.pinCurated(home, { file, list: 'mix', fingerprint: doc.fingerprint });
  const c = curatedRates(doc, { list: 'mix', scanDays: 120, delayMs: 2000 });
  assert.deepStrictEqual(c.rates['trend-up'], { candidatesPerDay: 0.5 });
  assert.deepStrictEqual([c.listOf({ cycleAt: t0 }), c.listOf({ cycleAt: '2024-07-16T14:00:00.000Z' })], ['trend-up', 'trend-up']);
  assert.deepStrictEqual([c.momentOf({ cycleAt: t0 }), c.momentOf({ cycleAt: '2024-07-16T14:00:02.000Z' }), c.momentOf({ cycleAt: '2024-07-16T15:00:00.000Z' })], [['m1'], ['m2'], []]);
  assert.match(curatedRates(doc).scanDaysFrom, /an estimate/);
  const root = path.resolve(__dirname, '..', '..');
  const sec = propScoreSection(dir, { root, curated: { file, list: 'mix' } });
  assert.strictEqual(sec.error, undefined, sec.error);
  assert.strictEqual(sec.result.score, 'diagnostic (reweighted)');
  assert.match(sec.text, /rebuilt at natural rates .* from mix of [0-9a-f]{16}, \d+ scan days/);
  // One of the two moments stepped entered (the plain pass counts): the scan's candidates a day x 1/2 taken.
  const L = sec.result.reweighted.lists['trend-up'];
  assert.deepStrictEqual([L.moments, L.entered, sec.result.reweighted.tradesPerDay], [2, 1, L.candidatesPerDay / 2]);
  assert.strictEqual(sec.result.promotion.passes, false);
  assert.match(propScoreSection(dir, { root }).text, /not scored \(a curated run is scored at its lists' natural rates/);
  // The keep rule's paired judge never reads a curated run (outcome-balanced moments, drawn days): refused before any score.

  const before = looks.scoresOf(readLedger(ledger)).length;
  assert.throws(() => pairRuns(dir, dir, { account: ACCOUNT, policy: POLICY, paths: 10, reps: 10 }), /run1 is a curated run: a paired judge never reads one .* replay full-day windows/);
  assert.strictEqual(looks.scoresOf(readLedger(ledger)).length, before, 'refused before any score is logged');
  assert.match(propScoreSection(dir, { root, curated: { file, list: 'trend-up' } }).text, /not scored \(the run pinned curated list/);
});

test('curatedRates: a decision is placed by its bar close (the poll delay taken off), among the mix\'s own moments; two lists\' windows at once is refused', () => {
  const { curatedRates } = require('../../scripts/lib/prop/natural-rate');
  const w = (from, to) => ({ from: `2024-07-15T${from}:00.000Z`, to: `2024-07-15T${to}:00.000Z` });
  const doc = {
    lists: { 'trend-up': [{ id: 'a', day: '2024-07-15', window: w('14:00', '14:30') }], chop: [{ id: 'b', day: '2024-07-15', window: w('14:30', '15:00') }, { id: 'x', day: '2024-07-15', window: w('14:00', '14:30') }] },
    coverage: { 'trend-up': { candidates: 10 }, chop: { candidates: 5 } }, mix: ['a', 'b'],
  };
  const c = curatedRates(doc, { scanDays: 10, delayMs: 5000 });
  // The window's last bar closes at 14:30; its decision runs at 14:30:05: still trend-up's, not chop's next window.
  assert.strictEqual(c.listOf({ cycleAt: '2024-07-15T14:30:05.000Z' }), 'trend-up');
  assert.strictEqual(c.listOf({ cycleAt: '2024-07-15T14:33:05.000Z' }), 'chop');
  // Moment x (chop, not in the mix) overlaps a: the run never stepped it, so it never claims a decision.
  assert.strictEqual(c.listOf({ cycleAt: '2024-07-15T14:10:05.000Z' }), 'trend-up');
  const both = curatedRates({ ...doc, mix: ['a', 'b', 'x'] }, { scanDays: 10, delayMs: 5000 });
  assert.throws(() => both.listOf({ cycleAt: '2024-07-15T14:10:05.000Z' }), /windows of trend-up and chop: its list is ambiguous/);
});

test('keepOne takes one micro, never a whole mini; the risk record refuses an attribution of a sealed role on its own', () => {
  const { scoreArms } = require('../../scripts/lib/prop/evaluator');
  const { riskRecord: rr } = require('../../scripts/lib/prop/risk-attribution');
  const days = weekdays('2022-01-03', 35);
  // A ceiling of many micros (auto would trade minis), the model's share 1% of it: rounds to none, so one micro.
  const stream = modelStreamOf(days, d => [modelTrade(`${d}-0`, 200, {}, { entryTime: `${d}T14:00:00.000Z`, sizeFraction: 0.01 })]);
  const run = { runId: 'r', from: '2022-01-03', to: '2022-03-01', learning: true, role: 'practice-train' };
  const r = scoreArms(stream, { account: ACCOUNT, contracts: 'auto', paths: 20, reps: 20, seed: 1, rulebook: { sizing: testSizing({ cushion_frac: 1 }) }, pass: checkModelWindow({ run }), base: () => ({ fraction: 0.01, keepOne: true }) });
  // One micro: +200 ticks x $0.50 = $100 a day, under the $3,000 target in 30 days: never a pass (one mini would pass in 3).
  assert.strictEqual(r.base.passRate, 0);
  assert.throws(() => rr({ states: {}, cells: [], role: 'test' }), /judged, never shown/);
});

test('pairRuns never reads a stepped-windows run (the training loop\'s trend set: stretches of days, never whole ones)', () => {
  const home = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'fth-stepped-'));
  const dir = path.join(home, 'replay', 'run1');
  require('fs').mkdirSync(dir, { recursive: true });
  require('fs').writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId: 'run1', stepWindows: { kind: 'trend-set', hash: 'h', windows: 2 } }));
  assert.throws(() => pairRuns(dir, dir, { account: ACCOUNT, policy: POLICY, paths: 10, reps: 10 }), /run1 steps windows of its sessions only \(the training loop's trend set\): a paired judge reads full-day runs only/);
});
