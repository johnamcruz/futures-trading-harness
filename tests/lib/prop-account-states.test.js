'use strict';

// Practice with account states (scripts/lib/prop/account-states.js): the states a stage-2 curated practice day starts
// from are drawn from the 30-day Monte Carlo paths of the model's own trades, near-limit states oversampled with their
// sampling weights recorded, so a weighted score restores the natural rates; the run seeds its attempt record (prop-state
// seedAttempt) and the replay broker's balance from the day's draw (replay/driver.js seedDay), the draw is in both
// hashes, and the model sees only the attempt line it would see live.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../scripts/lib/prop/account-states');
const prop = require('../../scripts/lib/trading/prop-state');
const combine = require('../../scripts/lib/trading/combine');
const { stateOf } = require('../../scripts/lib/prop/risk-attribution');
const { naturalRates } = require('../../scripts/lib/prop/natural-rate');
const { tradingDayKey } = require('../../scripts/lib/trading/clock');
const { ACCOUNT, weekdays, modelTrade, modelStreamOf } = require('../fixtures/prop-model');

const REPO = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-states-'));
const GATE = Object.freeze({ maxDailyLosses: 3, maxConsecutiveLosses: 2, lossCooldownMin: 30 });
const DAYS = weekdays('2022-01-03', 60);
// Two trades a day: a mixed stream (three losing days in ten, wins and losses on the rest), so every bucket occurs on the
// paths, near the floor included.
const mixed = () => modelStreamOf(DAYS, (d, k) => (k % 10 < 3 ? [modelTrade(`${d}-0`, -44), modelTrade(`${d}-1`, -44)] : [modelTrade(`${d}-0`, 70), modelTrade(`${d}-1`, k % 3 === 2 ? -44 : 30)]));
const draw = (stream = mixed(), o = {}) => S.drawDocument(stream, { account: ACCOUNT, contracts: 'micro', paths: 150, count: 60, seed: 3, gate: GATE, source: [{ runId: 's', role: 'practice-train' }], ...o });

test('the draws come from the Monte Carlo paths of the model\'s own trades: their buckets and states are the paths\', never uniform', () => {
  const doc = draw();
  assert.deepStrictEqual(Object.keys(doc.population), S.PRACTICE_BUCKETS);
  for (const b of S.PRACTICE_BUCKETS) assert.ok(doc.population[b] > 0, `${b} occurs on the mixed paths`);
  assert.strictEqual(doc.draws.length, 60);
  for (const d of doc.draws) {
    const cs = S.drawState(ACCOUNT, d.state);
    // Each draw is a decision moment of an attempt: its bucket, an entry still allowed, and its balance its days' plus today's.
    assert.strictEqual(S.practiceBucketOf(cs, d.state), d.bucket);
    assert.strictEqual(combine.entryBlock(cs), null);
    assert.ok(d.state.lossesToday < GATE.maxDailyLosses);
    assert.ok(Math.abs(ACCOUNT.starting_balance + d.state.days.reduce((a, x) => a + x, 0) + d.state.dayPnl - d.state.balance) < 0.02);
    assert.deepStrictEqual(d.facts, combine.attemptFacts(cs, { tradesToday: d.state.tradesToday, lossesToday: d.state.lossesToday, lossStreak: d.state.lossStreak }));
    if (d.bucket === 'after-losses') assert.ok(d.state.lossesToday > 0 && d.state.dayPnl !== 0);
    assert.ok(d.state.lossStreak < GATE.maxConsecutiveLosses, 'a streak at the gate limit would still be cooling down at the window start');
    if (d.bucket === 'near-mll') assert.strictEqual(stateOf(cs), 'near-mll');
  }
  // A stream that only wins never shows a loss today nor the floor near: those buckets are empty, so nothing is drawn there.
  const winning = draw(modelStreamOf(DAYS, (d) => [modelTrade(`${d}-0`, 40)]), { count: 10 });
  assert.deepStrictEqual([winning.population['after-losses'], winning.population['near-mll'], winning.sampled['after-losses'], winning.sampled['near-mll']], [0, 0, 0, 0]);
  // Near-limit states are oversampled: drawn more often than their natural share; mid less.
  const share = b => doc.sampled[b] / doc.draws.length;
  assert.ok(share('near-mll') > doc.natural['near-mll'] && share('after-losses') > doc.natural['after-losses'], JSON.stringify([doc.sampled, doc.natural]));
  assert.ok(share('mid') < doc.natural.mid);
});

test('the sampling weights restore the natural rates exactly: of the buckets, and of any outcome by bucket', () => {
  const doc = draw();
  for (const b of S.PRACTICE_BUCKETS) {
    assert.strictEqual(doc.weights[b], Math.round((doc.natural[b] / (doc.sampled[b] / doc.draws.length)) * 1e6) / 1e6, b);
    const w = S.weightedRates(doc.draws, d => (d.bucket === b ? 1 : 0));
    assert.ok(Math.abs(w.weighted - doc.natural[b]) < 1e-4, `${b}: weighted ${w.weighted}, natural ${doc.natural[b]}`);
    if (['near-mll', 'after-losses'].includes(b)) assert.ok(w.raw > doc.natural[b] + 0.01, `${b} raw is oversampled`);
  }
  // An outcome whose rate depends on the state (blown 60% near the floor, 20% after losses, 2% elsewhere): the raw mean
  // over the draws is biased up; the weighted one is the natural mix's.
  const rate = { 'near-mll': 0.6, 'after-losses': 0.2, fresh: 0.02, mid: 0.02, 'near-target': 0.02 };
  const natural = S.PRACTICE_BUCKETS.reduce((a, b) => a + doc.natural[b] * rate[b], 0);
  const w = S.weightedRates(doc.draws, d => rate[d.bucket]);
  assert.ok(Math.abs(w.weighted - natural) < 1e-4, `${w.weighted} vs ${natural}`);
  assert.ok(w.raw > natural + 0.02, 'unweighted, the oversampling inflates it');
  // A run's own days: the weights from the days each bucket got, so the run's days restore the natural shares too.
  const windows = weekdays('2022-03-01', 23).map(d => ({ from: Date.parse(`${d}T14:15:00Z`), to: Date.parse(`${d}T16:00:00Z`) }));
  const a = S.assignStates(doc, windows);
  assert.strictEqual(a.days.length, 23);
  for (const b of S.PRACTICE_BUCKETS.filter(x => a.sampledDays[x])) {
    assert.ok(Math.abs(S.weightedRates(a.days, d => (d.bucket === b ? 1 : 0)).weighted - doc.natural[b]) < 1e-4, b);
  }
  assert.deepStrictEqual(a.days.slice(0, 3).map(d => d.draw), [0, 1, 2], 'day k takes draw k');
  // Too few days for every bucket: said (the preflight refuses it).
  assert.ok(S.assignStates(doc, windows.slice(0, 2)).unsampled.length > 0);
  assert.deepStrictEqual(S.weightedRates([], () => 1), { n: 0, raw: null, weighted: null });
});

test('allocate: proportional to population x oversample, at least one per bucket the paths have, largest remainders', () => {
  const pop = { fresh: 30, mid: 500, 'near-target': 100, 'near-mll': 50, 'after-losses': 120 };
  // Masses 30, 500, 100, 150, 360 (x3 near the limits) over 1140; 5 seeded with one each, 45 by mass, the rest by the
  // largest remainders.
  assert.deepStrictEqual(S.allocate(pop, 50, null), { fresh: 2, mid: 21, 'near-target': 5, 'near-mll': 7, 'after-losses': 15 });
  assert.deepStrictEqual(S.allocate(pop, 50, { 'near-mll': 1, 'after-losses': 1 }), { fresh: 3, mid: 29, 'near-target': 6, 'near-mll': 4, 'after-losses': 8 });
  assert.deepStrictEqual(S.allocate({ ...pop, fresh: 0 }, 4, null), { fresh: 0, mid: 1, 'near-target': 1, 'near-mll': 1, 'after-losses': 1 });
  assert.throws(() => S.allocate(pop, 4, null), /at least one per bucket/);
  assert.throws(() => S.allocate(pop, 10, { sideways: 2 }), /not a practice bucket/);
  assert.throws(() => S.allocate(pop, 10, { mid: 0 }), /a factor above 0/);
});

test('the draw is hashed: the same seed the same document; another seed or oversampling another; a changed document is refused', () => {
  const a = draw();
  assert.strictEqual(draw().hash, a.hash);
  assert.notStrictEqual(draw(mixed(), { seed: 4 }).hash, a.hash);
  assert.notStrictEqual(draw(mixed(), { oversample: { 'near-mll': 5 } }).hash, a.hash);
  const dir = tmp();
  const file = S.writeDocument(dir, a);
  assert.strictEqual(S.readDocument(file).hash, a.hash);
  const bent = JSON.parse(fs.readFileSync(file, 'utf8'));
  bent.draws[0].weight = 1;
  fs.writeFileSync(file, JSON.stringify(bent));
  assert.throws(() => S.readDocument(file), /doesn't match its hash/);
  assert.match(S.documentText(a), /near-mll: \d+ moments on the paths \(natural [\d.]+%\); drawn \d+ \(x3\), weight/);
});

test('seedAttempt: the record reads back to the drawn account (balance, floor, day), and the first snapshot shows today\'s counts and streak', () => {
  const doc = draw();
  const day = '2022-03-08';
  for (const d of doc.draws) {
    const home = tmp();
    const at = '2022-03-08T13:00:00.000Z';
    const { record, balance } = prop.seedAttempt(home, ACCOUNT, { day, at, state: d.state });
    const want = S.drawState(ACCOUNT, d.state);
    const cs = prop.stateFrom(ACCOUNT, record, balance);
    assert.deepStrictEqual([cs.balance, cs.floor, cs.days.length + 1, cs.dayPnl, cs.status], [want.balance, want.floor, d.state.sessionsDone + 1, d.state.dayPnl, 'active']);
    // Its closed days are the exchange sessions before the day, in order; it started on the first.
    assert.ok(record.days.every((x, k) => x.day < day && (k === 0 || x.day > record.days[k - 1].day)));
    assert.strictEqual(record.startDay, record.days.length ? record.days[0].day : day);
    // The runner's first snapshot (flat, the day's anchor): today's trades, losses and streak are the state's.
    const now = new Date('2022-03-08T14:31:00Z');
    prop.snapshot(home, ACCOUNT, balance, now, { open: 0 });
    const r = prop.readAttempt(home, ACCOUNT.name);
    const counts = { ...prop.attemptCounts(r, now), lossStreak: prop.sessionLossStreak(home, ACCOUNT, now).count };
    assert.deepStrictEqual(counts, { tradesToday: d.state.tradesToday, lossesToday: d.state.lossesToday, lossStreak: d.state.lossStreak });
    assert.deepStrictEqual(combine.attemptFacts(prop.stateFrom(ACCOUNT, r, balance), counts), d.facts, 'the attempt line\'s facts are the draw\'s');
    // Nothing in the record says it was drawn.
    assert.doesNotMatch(JSON.stringify(r), /bucket|weight|draw|sampl|seed/i);
  }
  assert.throws(() => prop.seedAttempt(tmp(), ACCOUNT, { day, at: '2022-03-08T13:00:00Z', state: { days: [100], peak: 50100, dayPnl: -50, balance: 50000 } }), /is not its last close/);
});

test('a seeded day\'s later fills add to the carried counts: the streak goes on from it, a win ends it', () => {
  const home = tmp();
  const account = { ...ACCOUNT, loss_streak_stop: 3 };
  const state = { days: [200], peak: 50200, dayPnl: -100, balance: 50100, tradesToday: 2, lossesToday: 2, lossStreak: 2 };
  prop.seedAttempt(home, account, { day: '2022-03-08', at: '2022-03-08T13:00:00Z', state });
  prop.snapshot(home, account, 50100, new Date('2022-03-08T14:00:00Z'));
  const fill = (min, pnl) => ({ creationTimestamp: new Date(Date.parse('2022-03-08T14:00:00Z') + min * 60000).toISOString(), profitAndLoss: pnl, fees: 0.37 });
  prop.snapshot(home, account, 50079.26, new Date('2022-03-08T14:20:00Z'), { fills: [fill(5, null), fill(10, -20)] });
  let r = prop.readAttempt(home, account.name);
  assert.deepStrictEqual([r.lossStreak.count, r.snapshot.counts.trades, r.snapshot.counts.losses], [3, 3, 3]);
  assert.match(r.snapshot.block, /3 losing trades in a row this session, at the loss streak stop/);
  // The next trading day: nothing carried.
  prop.snapshot(home, account, 50079.26, new Date('2022-03-09T14:20:00Z'));
  r = prop.readAttempt(home, account.name);
  assert.strictEqual(prop.carriedOf(r, '2022-03-09'), null);
  assert.deepStrictEqual([r.lossStreak.count, r.snapshot.counts.losses], [0, 0]);
  // A win after the carried losses ends the streak; the day's losses keep them.
  const h2 = tmp();
  prop.seedAttempt(h2, account, { day: '2022-03-08', at: '2022-03-08T13:00:00Z', state });
  prop.snapshot(h2, account, 50100, new Date('2022-03-08T14:00:00Z'));
  prop.snapshot(h2, account, 50129.26, new Date('2022-03-08T14:20:00Z'), { fills: [fill(5, null), fill(10, 30)] });
  const r2 = prop.readAttempt(h2, account.name);
  assert.deepStrictEqual([r2.lossStreak.count, r2.snapshot.counts.trades, r2.snapshot.counts.losses], [0, 3, 2]);
});

test('natural rates: each decision weighted by its day\'s account-state weight (the take rate at the natural mix of states)', () => {
  const stream = modelStreamOf(['2022-03-01', '2022-03-02'], d => (d === '2022-03-01' ? [modelTrade('a', 40)] : []));
  // Two candidates: one entered on a near-mll day (weight 1/3), one passed on a mid day (weight 3).
  const decisions = [{ id: 'a', decision: 'entered', list: 'L', cycleAt: '2022-03-01T15:00:00Z' }, { id: 'b', decision: 'passed', list: 'L', cycleAt: '2022-03-02T15:00:00Z' }];
  const rates = { L: { candidatesPerDay: 2 } };
  const plain = naturalRates(stream, decisions, { rates });
  assert.strictEqual(plain.lists.L.tradesPerDay, 1, 'unweighted: half the candidates taken');
  const log = [{ kind: 'start', day: '2022-03-01', draw: 0, bucket: 'near-mll', weight: 1 / 3 }, { kind: 'start', day: '2022-03-02', draw: 1, bucket: 'mid', weight: 3 }];
  const w = naturalRates(stream, decisions, { rates, stateWeightOf: S.decisionWeight(log) });
  // Take rate (1/3) / (1/3 + 3) = 0.1: two candidates a day, 0.2 trades a day.
  assert.strictEqual(w.lists.L.tradesPerDay, 0.2);
  assert.ok(Math.abs(w.perTrade.get('a') - 0.2) < 1e-9);
  assert.throws(() => naturalRates(stream, decisions, { rates, stateWeightOf: () => undefined }), /no account-state weight/);
  // A carried day takes its attempt's weight.
  assert.strictEqual(S.dayWeights([...log, { kind: 'carried', day: '2022-03-03' }]).get('2022-03-03').weight, 3);
});

// --- A curated replay with account states ------------------------------------------------------------------------

const BASE_SKILLS = ['bos-vs-choch', 'candle-reading', 'levels-and-reactions', 'multi-timeframe-analysis', 'rejection'];
function moment(id, day, time, list = 'trend-up') {
  const r = Date.parse(`${day}T${time}:00.000Z`);
  const { VERSION } = require('../../scripts/lib/learning/curated-moments');
  return {
    v: VERSION, use: 'practice', id, root: 'MNQ', day, year: day.slice(0, 4), reactionAt: new Date(r).toISOString(), bar: new Date(r + 360000).toISOString(), minutes: 3, setupTf: 15,
    reaction: { kind: 'level', name: 'prior VAH', rel: 'rejected', dir: 'up', price: 100 }, reactionKind: 'rejection', side: 'long', list, trend: { state: 'clear', dir: 'up' }, regime: 'trend-up',
    reads: [], skills: BASE_SKILLS, aligned: BASE_SKILLS, standard: { status: 'traded' }, outcome: { result: 'win', R: 2 }, gate: { trendAllowed: true, prevailing: null, d2: null }, expected: 'take',
    window: { from: new Date(r - 45 * 60000).toISOString(), to: new Date(r + 60 * 60000).toISOString() },
  };
}

function statesWorld({ count = 5 } = {}) {
  const C = require('../../scripts/lib/learning/curated-lists');
  const { resolveReplay } = require('../../scripts/lib/replay/config');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const dir = tmp();
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL' } } }));
  const env = { PATH: process.env.PATH, HOME: dir, FTH_HOME: live, FTH_BROKERS_FILE: path.join(live, 'brokers.json'), FTH_ACCOUNTS_DIRS: path.join(REPO, 'tests', 'fixtures', 'accounts') };
  const lists = C.writeLists(path.join(dir, 'lists'), C.buildLists([moment('a', '2022-03-01', '15:00'), moment('b', '2022-03-03', '15:00'), moment('c', '2022-03-03', '18:00', 'chop')], { use: 'practice', total: 10, seed: 1 }));
  const account = accountNamed(REPO, 'test_50k', env);
  const docOf = (o = {}) => S.writeDocument(path.join(dir, 'states'), S.drawDocument(mixed(), { account, contracts: 'micro', paths: 100, count, seed: 3, gate: GATE, source: [{ runId: 's', role: 'practice-train' }], ...o }));
  const file = docOf();
  const raw = o => ({
    runId: 'st1', workDir: path.join(dir, 'replays'), broker: 'sim', start: '2022-03-01T00:00:00Z', end: '2022-03-05T00:00:00Z', premarket: false, stage: 2,
    autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York' },
    practice: { seed: 1 }, curatedList: { file: lists, list: 'mix' }, accountStates: { file }, ...o,
  });
  return { dir, env, account, file, docOf, raw, resolve: o => resolveReplay(raw(o), { baseDir: dir, env, home: dir, root: REPO }) };
}

test('the replay config: account states need a curated list and never prop; the draw and its assignment are in both hashes; stage 1 refuses them', () => {
  const w = statesWorld();
  const run = w.resolve({});
  assert.strictEqual(run.accountStates.account, 'test_50k');
  assert.deepStrictEqual(run.accountStates.assignment.days.map(d => d.day), ['2022-03-01', '2022-03-03']);
  assert.strictEqual(run.propDailyLoss, 1000, 'the broker stops the day at the account\'s daily limit');
  assert.throws(() => w.resolve({ curatedList: undefined, practice: undefined }), /accountStates: each curated window day starts from a drawn state; set curatedList too/);
  assert.throws(() => w.resolve({ prop: 'test_50k' }), /accountStates: not with prop/);
  assert.throws(() => w.resolve({ accountStates: { file: w.file, seed: 2 } }), /accountStates.seed: unknown/);
  assert.throws(() => w.resolve({ stage: 1 }), /accountStates: .* contradicts stage 1 .*account states are stage 2's/);
  const { setupHash, configHash, replayEnv } = require('../../scripts/lib/replay/config');
  const other = w.docOf({ seed: 9 });
  assert.notStrictEqual(setupHash(w.resolve({ accountStates: { file: other } })), setupHash(run), 'another draw: another setup');
  assert.notStrictEqual(setupHash(w.resolve({ accountStates: undefined })), setupHash(run));
  assert.strictEqual(setupHash(w.resolve({})), setupHash(run));
  require('../../scripts/lib/replay/driver').seedRunHome(run, { root: REPO, userEnv: w.env });
  assert.notStrictEqual(configHash(w.resolve({ accountStates: { file: other } }), w.env), configHash(run, w.env), 'a resume can\'t change the draw: another run');
  // The replay broker reads the run's balance schedule (replay-only).
  assert.strictEqual(replayEnv(w.env, run, { at: run.start }).BACKTESTER_BALANCE_SCHEDULE, run.paths.balanceSchedule);
  assert.strictEqual(replayEnv({ ...w.env, BACKTESTER_BALANCE_SCHEDULE: '/elsewhere.json' }, w.resolve({ accountStates: undefined }), { at: run.start }).BACKTESTER_BALANCE_SCHEDULE, undefined, 'never inherited');
  // A changed document, or an account whose rules changed since the draw, is refused.
  const bent = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  const tampered = path.join(w.dir, 'tampered.json');
  fs.writeFileSync(tampered, JSON.stringify({ ...bent, natural: { ...bent.natural, mid: 0.99 } }));
  assert.throws(() => w.resolve({ accountStates: { file: tampered } }), /doesn't match its hash/);
  const renamed = { ...bent, accountDigest: 'x'.repeat(32) };
  const { hash: _h, ...body } = renamed;
  const crypto = require('crypto');
  fs.writeFileSync(tampered, JSON.stringify({ ...body, hash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') }));
  assert.throws(() => w.resolve({ accountStates: { file: tampered } }), /rules changed since the states were drawn/);
});

/** The run to its end with a replay broker that applies the balance schedule (or not: `applies` false). */
async function statesRun(w, { open = () => false, applies = true, run = null, resolved = null, maxCycles = Infinity } = {}) {
  const { seedRunHome, runReplay } = require('../../scripts/lib/replay/driver');
  const { startLearningRun } = require('../../scripts/lib/learning/run-gate');
  const C = require('../../scripts/lib/learning/curated-lists');
  const r = run || resolved || w.resolve({});
  if (!run) {
    seedRunHome(r, { root: REPO, userEnv: w.env });
    startLearningRun(r.paths.runHome, { from: r.start, to: r.end, runId: r.runId, practice: r.practice, runDir: r.paths.runDir, env: w.env });
    C.pinCurated(r.paths.runHome, r.curated);
  }
  const seen = [];
  const deps = {
    serverCheck: async () => null,
    async step(point) {
      const rec = prop.readAttempt(r.paths.runHome, 'test_50k');
      seen.push({ kind: point.kind, t: point.t.toISOString(), balance: rec && rec.days.length, carried: rec && rec.carried });
      if (point.kind === 'eod') fs.writeFileSync(path.join(r.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: true }));
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [] })}\n` };
    },
    async trades() { return []; },
    async open(env) { return open(env.FTH_REPLAY_NOW); },
    // The patched replay broker: the schedule's latest balance at or before the clock (the server's own rule).
    async balance(env) {
      if (!applies) return 50000;
      const file = env.BACKTESTER_BALANCE_SCHEDULE;
      const list = JSON.parse(fs.readFileSync(file, 'utf8')).filter(e => e.at <= env.FTH_REPLAY_NOW);
      return list.length ? list[list.length - 1].balance : 50000;
    },
  };
  const res = await runReplay({ run: r, baseEnv: w.env, root: REPO, deps, maxCycles });
  return { run: r, res, seen };
}

test('the driver seeds each window day before its first step: the balance schedule, the attempt record, the broker\'s balance checked; logged for the scores', async () => {
  const w = statesWorld();
  const { run, res, seen } = await statesRun(w);
  assert.strictEqual(res.done, true);
  const doc = S.readDocument(w.file);
  const schedule = JSON.parse(fs.readFileSync(run.paths.balanceSchedule, 'utf8'));
  assert.deepStrictEqual(schedule.map(e => [e.day, e.balance, e.dayPnl]), run.accountStates.assignment.days.map(a => [a.day, doc.draws[a.draw].state.balance, doc.draws[a.draw].state.dayPnl]));
  // Every step of a window day ran on its day's seeded attempt (the carried counts are that day's).
  for (const s of seen.filter(x => x.kind === 'trade')) assert.strictEqual(s.carried.day, tradingDayKey(new Date(s.t)), s.t);
  const log = S.readStatesLog(run.paths.runDir);
  assert.deepStrictEqual(log.map(x => [x.kind, x.day]), [['start', '2022-03-01'], ['end', '2022-03-01'], ['start', '2022-03-03'], ['end', '2022-03-03']]);
  assert.ok(log.filter(x => x.kind === 'start').every((x, k) => x.weight === run.accountStates.assignment.days[k].weight && x.bucket === run.accountStates.assignment.days[k].bucket));
  assert.ok(log.filter(x => x.kind === 'end').every(x => x.end && typeof x.end.outcome === 'string'));
  // The drawn state is the record's at the day's first step: balance, floor and day as drawn.
  const last = run.accountStates.assignment.days[1];
  const rec = prop.readAttempt(run.paths.runHome, 'test_50k');
  const cs = prop.stateFrom(w.account, rec, doc.draws[last.draw].state.balance);
  assert.strictEqual(cs.floor, S.drawState(w.account, doc.draws[last.draw].state).floor);
  // A replay broker that doesn't apply the schedule: refused before the day's first step (never the wrong account).
  const bad = statesWorld();
  await assert.rejects(statesRun(bad, { applies: false }), /replay refused: the replay broker reports a balance of 50000, not the day's .*it doesn't apply the balance schedule \(BACKTESTER_BALANCE_SCHEDULE\)/);
});

test('the driver: a day that opens with a position still open keeps its attempt (carried); a resume seeds no day twice', async () => {
  const w = statesWorld();
  // Open from 03-01's window until the next day: 03-03's first step finds it flat again, 03-01 is seeded.
  const { run } = await statesRun(w, { open: now => now >= '2022-03-03T00:00:00Z' && now <= '2022-03-03T14:30:59Z' });
  const log = S.readStatesLog(run.paths.runDir);
  assert.deepStrictEqual(log.filter(x => x.kind !== 'end').map(x => [x.kind, x.day]), [['start', '2022-03-01'], ['carried', '2022-03-03']]);
  assert.strictEqual(S.dayWeights(log).get('2022-03-03').weight, log[0].weight, 'a carried day is its attempt\'s');
  // Stopped part way and resumed: the same schedule, each day seeded once.
  const v = statesWorld();
  const first = await statesRun(v, { maxCycles: 5 });
  assert.strictEqual(first.res.done, false);
  await statesRun(v, { run: first.run });
  const sched = JSON.parse(fs.readFileSync(first.run.paths.balanceSchedule, 'utf8'));
  assert.deepStrictEqual(sched.map(e => e.day), ['2022-03-01', '2022-03-03']);
  assert.deepStrictEqual(S.readStatesLog(first.run.paths.runDir).filter(x => x.kind === 'start').map(x => x.day), ['2022-03-01', '2022-03-03']);
});

test('the driver refuses a day it can\'t seed: a broker error reading the open state, a carried day with no attempt, a day outside the assignment', async () => {
  const w = statesWorld();
  await assert.rejects(statesRun(w, { open: () => { throw new Error('broker down'); } }), /replay refused: can't read the account to seed the day \(broker down\)/);
  assert.deepStrictEqual(S.readStatesLog(w.resolve({}).paths.runDir).filter(x => x.kind === 'carried'), []);
  const v = statesWorld();
  await assert.rejects(statesRun(v, { open: () => true }), /replay refused: 2022-03-01 opens with a position or working order but the run has no attempt to carry/);
  const u = statesWorld();
  const r = u.resolve({});
  r.accountStates.assignment.days = r.accountStates.assignment.days.filter(d => d.day !== '2022-03-03');
  await assert.rejects(statesRun(u, { run: null, resolved: r }), /replay refused: 2022-03-03 has no drawn account state/);
});

test('scripts/account-states.js: show prints a document\'s buckets; a usage error or a refused draw exits 1', () => {
  const { spawnSync } = require('child_process');
  const cli = path.join(REPO, 'scripts', 'account-states.js');
  const file = S.writeDocument(tmp(), draw());
  const shown = spawnSync(process.execPath, [cli, 'show', file], { encoding: 'utf8' });
  assert.strictEqual(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /^account states [0-9a-f]{16} on unit_50k: 60 draws from 150 paths/);
  assert.strictEqual(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).status, 1);
  // A run that isn't practice-train is never a source.
  const run = path.join(tmp(), 'replay', 'r1');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'learning-run.json'), JSON.stringify({ learning: true, role: 'test' }));
  const acct = require('../../scripts/lib/trading/strategies').loadStrategies(REPO, {}).strategies.find(x => x.name === 'prop_portfolio').account;
  const refused = spawnSync(process.execPath, [cli, 'draw', '--run', run, '--account', acct], { encoding: 'utf8' });
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /practice-train runs only \(this one is test\)/);
});

test('an attempt\'s end after its close is recorded: a day stopped at the daily limit or the soft stop is stopped, never open', () => {
  const { attemptEnd } = require('../../scripts/lib/replay/driver');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const env = { FTH_ACCOUNTS_DIRS: path.join(REPO, 'tests', 'fixtures', 'accounts') };
  const account = accountNamed(REPO, 'test_50k', env);
  const dayOf = (pnl, { streak = 0 } = {}) => {
    const home = tmp();
    const at = '2022-03-01T15:00:00Z';
    prop.seedAttempt(home, account, { day: '2022-03-01', at, state: { days: [200], peak: 50200, dayPnl: 0, balance: 50200, tradesToday: 0, lossesToday: 0, lossStreak: streak } });
    // The runner's last snapshot of the day, at the day's loss, then end of day records the close.
    prop.snapshot(home, account, 50200 + pnl, new Date(at), { open: 0 });
    prop.recordEndOfDay(home, account, 50200 + pnl, '2022-03-01');
    return attemptEnd(home, account);
  };
  // The daily loss limit ($1,000) hit: stopped for the day, the day's P&L its loss (the recorded close would read 0).
  const hit = dayOf(-1000);
  assert.deepStrictEqual([hit.outcome, hit.dayPnl, hit.status], ['stopped', -1000, 'active']);
  assert.match(hit.block, /daily loss limit/);
  // The soft stop (the rulebook's daily_loss_soft) the same.
  const soft = account.daily_loss_soft;
  assert.ok(soft > 0 && soft < 1000, 'the fixture rulebook has a soft stop under the daily limit');
  const atSoft = dayOf(-soft);
  assert.deepStrictEqual([atSoft.outcome, atSoft.dayPnl], ['stopped', -soft]);
  // A small loss, or a winning day: open (the next day trades as usual).
  assert.deepStrictEqual([dayOf(-100).outcome, dayOf(-100).dayPnl], ['open', -100]);
  assert.strictEqual(dayOf(300).outcome, 'open');
});
