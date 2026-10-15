'use strict';

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
const { scoreRun, scoreText, resolveAccount, propScoreSection } = require('../../scripts/lib/prop/model-score');
const looks = require('../../scripts/lib/learning/looks');
const { readLedger } = require('../../scripts/lib/prop/ledger-file');
const { rng } = require('../../scripts/lib/prop/stats');
const combine = require('../../scripts/lib/trading/combine');
const at = require('../../scripts/lib/prop/attempts');
const { ACCOUNT, M3, record, tmpHome, multiDayRun, weekdays, modelTrade, modelStreamOf } = require('../fixtures/prop-model');

const run = (extra = {}) => ({ runId: 'r1', from: '2022-01-03', to: '2022-09-01', learning: true, role: 'practice-train', look: null, hideOutcomes: false, ...extra });
const quick = { account: ACCOUNT, contracts: 'micro', paths: 200, reps: 300, seed: 3 };
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
    for (let i = 0; i < 20; i += 1) { decisions.push({ id: `${d}-s${i}`, day: d, decision: i < 8 ? 'entered' : 'passed', list: 'sweep' }); if (i < 8) out.push(modelTrade(`${d}-s${i}`, 60)); }
    for (let i = 0; i < 4; i += 1) { decisions.push({ id: `${d}-f${i}`, day: d, decision: i < 2 ? 'entered' : 'passed', list: 'fvg' }); if (i < 2) out.push(modelTrade(`${d}-f${i}`, -40)); }
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

test('a curated run\'s score is "diagnostic (reweighted)" and the promotion gate refuses it; the zero-blow gate is untouched', () => {
  const days = weekdays('2022-03-01', 5);
  const decisions = [];
  const s = modelStreamOf(days, d => {
    const out = [];
    for (let i = 0; i < 6; i += 1) { decisions.push({ id: `${d}-${i}`, day: d, decision: 'entered', list: 'sweep' }); out.push(modelTrade(`${d}-${i}`, i % 3 === 2 ? -40 : 60)); }
    return out;
  });
  const rw = reweightStream(s, decisions, { rates: { sweep: { candidatesPerDay: 1 } }, days: 300, seed: 1 });
  assert.throws(() => scoreStream(rw, { ...quick, pass: checkModelWindow({ run: run() }) }), /only as a diagnostic/);
  assert.throws(() => scoreStream(s, { ...quick, pass: checkModelWindow({ run: run(), diagnostic: 'reweighted' }) }), /needs the reweighted stream/);
  const r = scoreStream(rw, { ...quick, pass: checkModelWindow({ run: run(), diagnostic: 'reweighted' }) });
  assert.deepStrictEqual([r.score, r.diagnostic, r.promotion.passes], ['diagnostic (reweighted)', true, false]);
  assert.match(r.promotion.failures[0], /diagnostic \(reweighted\)\) is never a promotion score/);
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
  const sizing = { ...combine.DEFAULT_SIZING, cushion_frac: 0.4 };
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
  return { A, B, passed, opts: { ...quick, paths: 400, reps: 400, rulebook: { sizing: { cushion_frac: 0.4 } }, faults: { stopFault: 0.02 } } };
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
  assert.deepStrictEqual(res.paired, { sameDays: true, sameBlocks: true, sameFaults: true });
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
  const one = sampleAccountStates(A, { account: ACCOUNT, sizing: { cushion_frac: 0.4 }, contracts: 'micro', seed: 4, paths: 100, perBucket: 3 });
  const again = sampleAccountStates(A, { account: ACCOUNT, sizing: { cushion_frac: 0.4 }, contracts: 'micro', seed: 4, paths: 100, perBucket: 3 });
  const other = sampleAccountStates(A, { account: ACCOUNT, sizing: { cushion_frac: 0.4 }, contracts: 'micro', seed: 5, paths: 100, perBucket: 3 });
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
  const cand = { sizing: { cushion_frac: 0.4, cap_usd: 'off', drawdown_halve_usd: 'off', min_size_guard: 1.5, stop_slippage_ticks: 1, clock_k: 'off', r_per_session: 0.3 }, daily_loss_soft: 'off', stand_down: 0, multipliers: [] };
  assert.deepStrictEqual(validateCandidate(cand), []);
  assert.match(validateCandidate({ ...cand, sizing: { ...cand.sizing, cap_usd: 0 } }).join(), /sizing.cap_usd/);
  assert.match(validateCandidate({ ...cand, stand_down: 2 }).join(), /stand_down/);
  assert.match(validateCandidate({ ...cand, multipliers: [{ item: 'room', fact: 'alignment', values: { aligned: 1 } }] }).join(), /classified enforced/);
  const opts = { ...quick, paths: 300, faults: { stopFault: 0.02 } };
  assert.throws(() => scoreCandidate(A, cand, { ...opts, pass: checkModelWindow({ run: run() }) }), /candidate rulebook is scored only on a pass checked for one/);
  const base = scoreCandidate(A, cand, { ...opts, pass: checkModelWindow({ run: run(), candidateRulebook: true }) });
  // Skip low-confluence setups: a multiplier on the record's alignment (an enforced item).
  const skipCounter = scoreCandidate(A, { ...cand, multipliers: [{ item: 'multipliers', fact: 'alignment', values: { aligned: 1, counter: 0 } }] }, { ...opts, pass: checkModelWindow({ run: run(), candidateRulebook: true }) });
  assert.ok(skipCounter.resampled.blowRate < base.resampled.blowRate, 'the hook moves the score');
  // A stand-down near the limit: no entry while the cushion is under half the max loss.
  const stand = scoreCandidate(A, { ...cand, stand_down: 0.5 }, { ...opts, pass: checkModelWindow({ run: run(), candidateRulebook: true }) });
  assert.ok(stand.resampled.attempts === base.resampled.attempts && stand.candidate.stand_down === 0.5);
  assert.throws(() => checkModelWindow({ run: run({ from: '2025-03-03', to: '2025-03-08', role: 'test', look: { evaluation: 'e' } }), candidateRulebook: true, logScore: () => {} }), /never scored on test/);
});

test('combine.attemptFacts: the room to the limits, the day, consistency headroom, profit needed; counts passed in', () => {
  const acct = { ...ACCOUNT, daily_loss_soft: 500, consistency_pct: 50 };
  let s = combine.start(acct);
  s = combine.endDay(combine.applyClose(s, 600));
  s = combine.applyClose(s, -200);
  const f = combine.attemptFacts(s, { tradesToday: 2, lossesToday: 1, lossStreak: 3 });
  assert.deepStrictEqual(f, { dailyRoom: 800, softStop: 500, softRoom: 300, tradesToday: 2, lossesToday: 1, lossStreak: 3, day: 2, sessions: 30, sessionsLeft: 29, consistencyCap: 600, needed: 2600 });
  const none = combine.attemptFacts(combine.start(ACCOUNT));
  assert.deepStrictEqual([none.softStop, none.softRoom, none.consistencyCap, none.tradesToday, none.day, none.needed], [null, null, null, null, 1, 3000]);
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
  const r = scoreRun(dir, { account: ACCOUNT, paths: 50, reps: 100 });
  assert.deepStrictEqual([r.score, r.role, r.trades, r.runDays, r.look.kind, r.look.runId], ['real', 'practice-validate', 1, 2, 'score', 'run1']);
  assert.strictEqual(looks.scoresOf(readLedger(ledger)).length, 1);
  const text = scoreText(r);
  for (const want of [/1\. Zero blows \(hard gate\): held/, /2\. Pass within 30 trading days/, /3\. Days to pass: median/, /4\. Blow rate/, /Promotion gate: refused/]) assert.match(text, want);
  assert.ok(text.indexOf('1. Zero') < text.indexOf('2. Pass') && text.indexOf('2. Pass') < text.indexOf('3. Days') && text.indexOf('3. Days') < text.indexOf('4. Blow'), 'the owner\'s order');
  // Natural rates beside the run make it a curated run: diagnostic.
  fs.writeFileSync(path.join(dir, 'natural-rates.json'), JSON.stringify({ sweep: { candidatesPerDay: 0.5 } }));
  const root = path.resolve(__dirname, '..', '..');
  const sec = propScoreSection(dir, { root });
  assert.strictEqual(sec.error, undefined, sec.error);
  assert.deepStrictEqual([sec.result.score, sec.summary.score], ['diagnostic (reweighted)', 'diagnostic (reweighted)']);
  assert.match(sec.text, /Prop Monte Carlo, 30-day attempts .*: diagnostic \(reweighted\), never a promotion score/);
  assert.strictEqual(looks.scoresOf(readLedger(ledger)).length, 2, 'each score logged');
  assert.match(propScoreSection(dir, { root, override: 'no_such_account' }).text, /Prop Monte Carlo: not scored/);
  // No account: not scored, said why.
  assert.deepStrictEqual(resolveAccount({ accounts: [{ name: 'a' }, { name: 'b' }], strategies: [] }).name, null);
  assert.strictEqual(resolveAccount({ attempts: ['a'], accounts: [{ name: 'a' }] }).name, 'a');
  assert.strictEqual(resolveAccount({ strategies: [{ signal: 'policy', account: 'b' }], accounts: [{ name: 'b' }] }).why, 'the policy strategies\' account');
});

test('scoreRun: a real score never leaves an unsettled entry out', () => {
  const t0 = '2023-03-15T14:00:00.000Z';
  const { dir } = multiDayRun({ days: [{ day: '2023-03-15', times: [t0], records: [record({ at: t0 })], rows: [[100.5, 100.75, 99.75, 100.25]],
    fills: [{ id: 1, contractId: 'MNQ:2023-06', creationTimestamp: '2023-03-15T14:01:00Z', price: 100, size: 1, side: 0, profitAndLoss: null }] }] });
  assert.throws(() => scoreRun(dir, { account: ACCOUNT, paths: 10, reps: 10 }), /without a settled outcome .* a real score never leaves one out/);
  void M3;
});
