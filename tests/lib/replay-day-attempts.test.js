'use strict';

// The training loop's day attempts (scripts/lib/replay/day-attempts.js; the owner, 2026-10-24: "We should using
// translation on ppc as well as live"; "Remember minimum is 3 cons!!"): every loop run trades inside a fresh combine
// attempt each session day, so a composed entry is sized by the live path of a running attempt (the rulebook's floor, the
// size budget, the cap, the floor stretch), and no day's loss reaches another day's window. The replay config's field,
// both hashes, the driver's start of each day, the loop's runs, the preflight's day-attempts check and the sizing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const DA = require('../../scripts/lib/replay/day-attempts');
const prop = require('../../scripts/lib/trading/prop-state');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const { attemptHealth } = require('../../scripts/lib/prop/size-translate');
const { tmpDir: tmp } = require('../helpers');

const REPO = path.join(__dirname, '..', '..');
// The account the repository's active policy strategy trades (the runner keeps that account's attempt record).
const POLICY = loadStrategies(REPO, {}).strategies.find(s => s.name === 'prop_portfolio');
const ACCOUNT = accountNamed(REPO, POLICY.account, {});

function world() {
  const { resolveReplay } = require('../../scripts/lib/replay/config');
  const dir = tmp();
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL' } } }));
  const env = { PATH: process.env.PATH, HOME: dir, FTH_HOME: live, FTH_BROKERS_FILE: path.join(live, 'brokers.json') };
  // Tuesday 2022-03-01 to Thursday 2022-03-03 (practice-train): three trading days; a narrow session, three bars a day.
  const raw = o => ({
    runId: 'da1', workDir: path.join(dir, 'replays'), broker: 'sim', start: '2022-03-01T00:00:00Z', end: '2022-03-04T00:00:00Z', premarket: false, endOfDay: false, stage: 1,
    autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-09:40@America/New_York'], eodAt: '15:50@America/New_York' },
    dayAttempts: { account: ACCOUNT.name }, ...o,
  });
  return { dir, env, raw, resolve: o => resolveReplay(raw(o), { baseDir: dir, env, home: dir, root: REPO }) };
}

test('dayAttempts: its shape; the replay config resolves it on the policy\'s account, never with prop, account states or a combine', () => {
  assert.deepStrictEqual(DA.validateDayAttempts(undefined), { dayAttempts: null, errors: [] });
  assert.deepStrictEqual(DA.validateDayAttempts({ account: 'a_b' }), { dayAttempts: { account: 'a_b' }, errors: [] });
  for (const bad of [true, 'x', [], { account: 'Bad Name' }, {}, { account: 'a', seed: 1 }]) assert.ok(DA.validateDayAttempts(bad).errors.length, JSON.stringify(bad));
  const w = world();
  const run = w.resolve({});
  assert.deepStrictEqual(run.dayAttempts, { account: ACCOUNT.name });
  // The broker stops the day at the account's own daily limit, as the firm does, and reads the balance schedule.
  assert.strictEqual(run.propDailyLoss, ACCOUNT.daily_loss_limit);
  const { replayEnv, configHash, setupHash } = require('../../scripts/lib/replay/config');
  require('../../scripts/lib/replay/driver').seedRunHome(run, { root: REPO, userEnv: w.env });
  assert.strictEqual(replayEnv(w.env, run, { at: run.start }).BACKTESTER_BALANCE_SCHEDULE, run.paths.balanceSchedule);
  const none = w.resolve({ dayAttempts: undefined });
  assert.strictEqual(none.dayAttempts, null);
  assert.strictEqual(replayEnv(w.env, none, { at: none.start }).BACKTESTER_BALANCE_SCHEDULE, undefined, 'never without them');
  // Both hashes name them: a run with them and one without are two runs and two setups (never pooled).
  assert.notStrictEqual(configHash(run, w.env), configHash(none, w.env));
  assert.notStrictEqual(setupHash(run), setupHash(none));
  const bad = (o, re) => assert.throws(() => w.resolve(o), re, JSON.stringify(o));
  bad({ dayAttempts: { account: 'no_such_profile' } }, /dayAttempts.account: unknown account "no_such_profile"/);
  bad({ dayAttempts: { account: 'Bad' } }, /dayAttempts.account: an account profile name/);
  const other = require('../../scripts/lib/trading/accounts').loadAccounts(REPO, {}).accounts.find(a => a.valid && a.name !== ACCOUNT.name).name;
  bad({ dayAttempts: { account: other } }, new RegExp(`dayAttempts.account: ${other} is not the account the active policy strategy trades \\(${ACCOUNT.name}\\)`));
  bad({ prop: ACCOUNT.name, stage: undefined }, /dayAttempts: not with prop/);
  bad({ combine: { account: ACCOUNT.name, attempts: ['2022-03-01'], maxSessions: 1 }, stage: 2 }, /dayAttempts: not with combine/);
  bad({ accountStates: { file: '/no/states.json' }, stage: 2 }, /dayAttempts: not with accountStates/);
  assert.throws(() => require('../../scripts/lib/replay/config').resolveReplay(w.raw({}), { baseDir: w.dir, env: w.env, home: w.dir }), /dayAttempts: needs the harness root/);
});

/**
 * The run to its end through the real driver, the broker faked: the balance schedule's latest balance at or before the
 * clock, plus the day's own P&L (`pnl(day)`, after the day's first step); each trade step acts as the runner does: a
 * snapshot of the attempt at the broker's balance, and at the day's last step its close (recordEndOfDay).
 */
async function dayRun(w, { open = () => false, applies = true, pnl = () => 0, run = null, maxCycles = Infinity, balanceErr = false } = {}) {
  const { seedRunHome, runReplay } = require('../../scripts/lib/replay/driver');
  const r = run || w.resolve({});
  if (!run) seedRunHome(r, { root: REPO, userEnv: w.env });
  const seen = [];
  const stepped = new Map();
  const balanceAt = env => {
    if (!applies) return 123;
    const day = require('../../scripts/lib/trading/clock').tradingDayKey(new Date(env.FTH_REPLAY_NOW));
    let list = [];
    try { list = JSON.parse(fs.readFileSync(env.BACKTESTER_BALANCE_SCHEDULE, 'utf8')).filter(e => e.at <= env.FTH_REPLAY_NOW); } catch (_err) { /* none yet */ }
    // As a broker's: the last schedule entry's balance, plus every P&L since (a day's own after its first step).
    const last = list.length ? list[list.length - 1] : { day: '0000-00-00', balance: 99999 };
    return last.balance + [...stepped.keys()].filter(d => d >= last.day && (d < day || stepped.get(d) > 0)).reduce((sum, d) => sum + pnl(d), 0);
  };
  const deps = {
    serverCheck: async () => null,
    async step(point, env) {
      const rec = prop.readAttempt(r.paths.runHome, ACCOUNT.name);
      const day = point.day;
      stepped.set(day, (stepped.get(day) || 0) + 1);
      const bal = balanceAt(env || { FTH_REPLAY_NOW: point.t.toISOString(), BACKTESTER_BALANCE_SCHEDULE: r.paths.balanceSchedule });
      if (rec) {
        prop.snapshot(r.paths.runHome, ACCOUNT, bal, point.t, { open: 0 });
        if (stepped.get(day) === 3) prop.recordEndOfDay(r.paths.runHome, ACCOUNT, bal, day);
      }
      const after = prop.readAttempt(r.paths.runHome, ACCOUNT.name);
      seen.push({ t: point.t.toISOString(), day, startDay: after && after.startDay, closed: after ? after.days.length : null, state: after ? prop.stateFrom(ACCOUNT, after, bal) : null });
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [] })}\n` };
    },
    async trades() { return []; },
    async open(env) { return open(env.FTH_REPLAY_NOW); },
    async balance(env) {
      if (balanceErr) throw new Error('broker down');
      return balanceAt(env);
    },
  };
  const res = await runReplay({ run: r, baseEnv: w.env, root: REPO, deps, maxCycles });
  return { run: r, res, seen };
}

test('the driver: each session day starts a fresh attempt at the starting balance; one day\'s loss never reaches the next window', async () => {
  const w = world();
  // Day one loses $600 after its first step; the other days are flat.
  const { run, res, seen } = await dayRun(w, { pnl: day => (day === '2022-03-01' ? -600 : 0) });
  assert.strictEqual(res.done, true);
  const log = DA.readLog(run.paths.runDir);
  assert.deepStrictEqual(log.map(x => [x.kind, x.day, x.balance]), ['2022-03-01', '2022-03-02', '2022-03-03'].map(d => ['start', d, ACCOUNT.starting_balance]));
  const sched = JSON.parse(fs.readFileSync(run.paths.balanceSchedule, 'utf8'));
  assert.deepStrictEqual(sched.map(e => [e.day, e.balance, e.dayPnl]), log.map(x => [x.day, ACCOUNT.starting_balance, 0]));
  // Every step trades on its own day's attempt: started that day, no closed day before it.
  for (const s of seen) assert.deepStrictEqual([s.startDay, s.closed === 0 || s.closed === 1], [s.day, true], s.t);
  // Day one's loss is in day one's attempt only: its last step shows it, unhealthy for the floor stretch (a loss today).
  const d1 = seen.filter(s => s.day === '2022-03-01');
  assert.strictEqual(d1[2].state.balance, ACCOUNT.starting_balance - 600);
  assert.strictEqual(attemptHealth({ balance: d1[2].state.balance, start: ACCOUNT.starting_balance, lossesToday: 1 }).healthy, false);
  // Day two opens from the starting balance, today's P&L 0, nothing closed, the floor the fresh attempt's.
  const d2 = seen.find(s => s.day === '2022-03-02');
  assert.deepStrictEqual([d2.state.balance, d2.state.dayPnl, d2.closed, d2.state.floor], [ACCOUNT.starting_balance, 0, 0, ACCOUNT.starting_balance - ACCOUNT.max_loss]);
  assert.strictEqual(attemptHealth({ balance: d2.state.balance, start: ACCOUNT.starting_balance, lossesToday: 0 }).healthy, true);
  // The earlier days' records are kept, renamed (ended), never reused.
  const ended = fs.readdirSync(path.join(run.paths.runHome, 'combine')).filter(f => f.includes('.ended-'));
  assert.strictEqual(ended.length, 2);
  const first = JSON.parse(fs.readFileSync(path.join(run.paths.runHome, 'combine', ended.sort()[0]), 'utf8'));
  assert.deepStrictEqual([first.startDay, first.days.map(d => d.balance)], ['2022-03-01', [ACCOUNT.starting_balance - 600]]);
  // No history scope: the prompt's history is what a live attempt shows (prop/attempt-scope.js).
  assert.strictEqual(prop.readAttempt(run.paths.runHome, ACCOUNT.name).historyFrom, undefined);
});

test('the driver: a resume starts no day twice; a day that opens with a position open keeps its attempt (carried)', async () => {
  const w = world();
  const part = await dayRun(w, { maxCycles: 4 });
  assert.strictEqual(part.res.done, false);
  await dayRun(w, { run: part.run });
  assert.deepStrictEqual(DA.readLog(part.run.paths.runDir).map(x => [x.kind, x.day]), [['start', '2022-03-01'], ['start', '2022-03-02'], ['start', '2022-03-03']]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(part.run.paths.balanceSchedule, 'utf8')).map(e => e.day), ['2022-03-01', '2022-03-02', '2022-03-03']);
  // Open at 03-02's first step (still from 03-01): carried, no schedule entry, the same record.
  const v = world();
  const { run, seen } = await dayRun(v, { open: now => now.startsWith('2022-03-02T14:3') });
  assert.deepStrictEqual(DA.readLog(run.paths.runDir).map(x => [x.kind, x.day]), [['start', '2022-03-01'], ['carried', '2022-03-02'], ['start', '2022-03-03']]);
  assert.strictEqual(seen.find(s => s.day === '2022-03-02').startDay, '2022-03-01');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(run.paths.balanceSchedule, 'utf8')).map(e => e.day), ['2022-03-01', '2022-03-03']);
});

test('the driver refuses a day it can\'t start: an account it can\'t read, open with no attempt, a broker that doesn\'t apply the schedule', async () => {
  await assert.rejects(dayRun(world(), { open: () => { throw new Error('broker down'); } }), /replay refused: can't read the account to start the day's attempt \(broker down\)/);
  await assert.rejects(dayRun(world(), { open: () => true }), /replay refused: 2022-03-01 opens with a position or working order but the run has no attempt to carry/);
  await assert.rejects(dayRun(world(), { applies: false }), new RegExp(`replay refused: the replay broker reports a balance of 123, not ${ACCOUNT.name}'s starting ${ACCOUNT.starting_balance}: it doesn't apply the balance schedule \\(BACKTESTER_BALANCE_SCHEDULE\\)`));
  await assert.rejects(dayRun(world(), { balanceErr: true }), /replay refused: can't read the account's balance for the day's attempt \(broker down\)/);
  const w = world();
  const r = w.resolve({ autotrader: { ...w.raw({}).autotrader, account: undefined } });
  await assert.rejects(dayRun(w, { run: (require('../../scripts/lib/replay/driver').seedRunHome(r, { root: REPO, userEnv: w.env }), r) }), /a run with day attempts needs the replay broker's account/);
});

// --- the loop's runs, the preflight and the sizing ---------------------------------------------------------------

const L = require('../../scripts/lib/train/loop');
const { resolveLoop } = require('../../scripts/lib/train/config');
const P = require('../../scripts/lib/learning/preflight');
const TRADER = { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York' };

function loopCtx() {
  const user = tmp();
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'home') };
  fs.mkdirSync(env.FTH_HOME);
  const replay = { workDir: path.join(user, 'work'), broker: 'backtester', autotrader: TRADER, noWeb: true };
  const loop = resolveLoop({ loopId: 'da', replay, tuningWindows: [{ from: '2022-09-01', to: '2023-02-01' }], proposer: TRADER, modelScore: { account: 'acct_a' } }, { baseDir: user });
  return { loop, root: REPO, env, user };
}

test('the loop: every run (keep rule, trend set, a curated probe) trades in day attempts on the tree\'s policy account; a config never sets them; in the loop\'s hash', () => {
  const ctx = loopCtx();
  const window = { from: '2022-03-07', to: '2022-03-08' };
  const keep = L.windowRun(ctx, { label: 'champion-t0', window: ctx.loop.tuningWindows[0], tree: REPO, look: {} });
  const trend = L.windowRun(ctx, { label: 'pc-t1', window, tree: REPO, look: {}, replay: { ...ctx.loop.replay, stage: 1 }, role: 'trend-set' });
  const probe = L.windowRun(ctx, { label: 'p', window, tree: REPO, look: {}, replay: { ...ctx.loop.replay, stage: 1 } });
  for (const x of [keep, trend, probe]) {
    assert.deepStrictEqual(x.run.dayAttempts, { account: ACCOUNT.name }, x.run.runId);
    assert.deepStrictEqual([x.gate.loopRun, x.gate.mode], [true, 'day-attempts'], x.run.runId);
  }
  // A replay config with an attempt of its own (prop: never stage 1's) keeps it, sized in it; no day attempts with it.
  const owned = L.windowRun(ctx, { label: 'o', window, tree: REPO, look: {}, replay: { ...ctx.loop.replay, prop: ACCOUNT.name } });
  assert.deepStrictEqual([owned.run.prop, owned.run.dayAttempts, owned.gate.loopRun, owned.gate.mode], [ACCOUNT.name, null, true, undefined]);
  // A tree whose policy names no account (no active policy): none, and the preflight refuses the run (below).
  const bare = tmp();
  for (const d of ['strategies', 'accounts']) fs.mkdirSync(path.join(bare, d));
  assert.strictEqual(require('../../scripts/lib/replay/config').policyAccount(bare, ctx.env), null);
  // The loop's replay configs never set them (the loop does, for each run).
  const cfg = o => () => resolveLoop({ loopId: 'da', replay: { ...ctx.loop.replay, ...o }, tuningWindows: [{ from: '2022-09-01', to: '2023-02-01' }], proposer: TRADER }, { baseDir: ctx.user });
  assert.throws(cfg({ dayAttempts: { account: ACCOUNT.name } }), /replay.dayAttempts: set by the loop for each run/);
  // In the loop's identity: a loop started before them is another loop (a resume of it is refused: state.js openState).
  assert.strictEqual(ctx.loop.dayAttempts, true);
  const { dayAttempts: _d, limits: _l, hash: _h, ...rest } = ctx.loop;
  assert.notStrictEqual(require('crypto').createHash('sha256').update(JSON.stringify(rest)).digest('hex'), ctx.loop.hash);
});

test('the probe config refuses day attempts in its replay configs (the loop sets them)', () => {
  const PC = require('../../scripts/lib/train/probe-config');
  const replay = { stage: 1, curatedList: { file: 'c.json', list: 'mix' }, practice: { mode: 'setup-focus' } };
  const o = { read: x => x, modelScore: { account: 'acct_a' }, tuningWindows: [{ from: '2022-09-01', to: '2023-02-01' }] };
  const ok = { replay, windows: [{ from: '2022-03-07', to: '2022-03-12' }] };
  assert.ok(PC.resolveProbe(ok, o));
  assert.throws(() => PC.resolveProbe({ ...ok, replay: { ...replay, dayAttempts: { account: ACCOUNT.name } } }, o), /probe\.replay\.dayAttempts: set by the loop for each run/);
  assert.throws(() => PC.resolveProbe({ ...ok, trend: { replay: { stage: 1, dayAttempts: { account: ACCOUNT.name } } } }, o), /probe\.trend\.replay\.dayAttempts: set by the loop for each run/);
});

test('the loop refuses what would trade outside a day\'s attempt: a model-scored loop\'s replay with an attempt across days; a run declared not learning with no policy account', async () => {
  const ctx = loopCtx();
  const cfg = o => () => resolveLoop({ loopId: 'da', replay: { ...ctx.loop.replay, ...o }, tuningWindows: [{ from: '2022-09-01', to: '2023-02-01' }], proposer: TRADER, modelScore: { account: 'acct_a' } }, { baseDir: ctx.user });
  assert.throws(cfg({ prop: ACCOUNT.name }), /replay\.prop: the model-scored loop's runs trade inside a fresh attempt each session day/);
  assert.throws(cfg({ combine: { account: ACCOUNT.name, attempts: ['2022-09-01'] } }), /replay\.combine: the model-scored loop's runs/);
  assert.throws(cfg({ accountStates: { file: 'x.json' } }), /replay\.accountStates: the model-scored loop's runs/);
  // A tree with no policy account: a learning run resolves (the preflight refuses it); one declared not learning is refused here.
  const bare = tmp();
  for (const d of ['strategies', 'accounts', 'skills', 'agents']) fs.mkdirSync(path.join(bare, d));
  const window = { from: '2022-03-07', to: '2022-03-08' };
  assert.strictEqual(L.windowRun(ctx, { label: 'nl', window, tree: bare, look: {}, replay: { ...ctx.loop.replay, learning: false } }).run.dayAttempts, null);
  let replayed = false;
  const run = { ...ctx, state: { done: {}, modelCalls: 0 }, save() {}, log() {}, paths: { dir: ctx.user, ledger: path.join(ctx.user, 'ledger.jsonl') }, steps: { preflight: () => null, seedRunHome: () => {}, startLearningRun: () => ({}), runReplay: async () => { replayed = true; return { done: true }; } } };
  await assert.rejects(L.windowRuns(run, { side: 'x', tag: 'n', windows: [window], tree: bare, look: {}, replay: { ...ctx.loop.replay, learning: false } }), /x-n0: no active policy strategy in the tree names an account, so the run can't trade inside the day's attempt/);
  assert.strictEqual(replayed, false, 'refused before any step');
});

test('startDay: a start cut short today is started again, never ending (and overwriting) the earlier day\'s record', async () => {
  const H = require('../helpers');
  const home = H.trendHome();
  const sched = path.join(home, 'balance-schedule.json');
  const run = { paths: { runHome: home, runDir: home, balanceSchedule: sched }, cfg: { account: '1' }, dayAttempts: { account: ACCOUNT.name }, brokerEnv: {}, root: REPO };
  const at = new Date('2022-03-02T14:30:02Z');
  let fail = true;
  const deps = { open: async () => false, balance: async () => { if (fail) throw new Error('lost reply'); return ACCOUNT.starting_balance; } };
  // The earlier day's attempt, with a closed day.
  prop.startAttempt(home, ACCOUNT, new Date('2022-03-01T14:30:02Z'));
  prop.recordEndOfDay(home, ACCOUNT, ACCOUNT.starting_balance - 400, '2022-03-01');
  await assert.rejects(DA.startDay(run, { day: '2022-03-02' }, at, {}, deps, { root: REPO }), /can't read the account's balance for the day's attempt \(lost reply\)/);
  fail = false;
  assert.strictEqual(await DA.startDay(run, { day: '2022-03-02' }, at, {}, deps, { root: REPO }), 'start');
  const ended = fs.readdirSync(path.join(home, 'combine')).filter(f => f.includes('.ended-'));
  assert.strictEqual(ended.length, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'combine', ended[0]), 'utf8')).days.map(d => d.balance), [ACCOUNT.starting_balance - 400], 'the earlier day kept');
  assert.strictEqual(prop.readAttempt(home, ACCOUNT.name).startDay, '2022-03-02');
});

/** The real training preflight on a run; only the replay broker server's own reply is given (limits the account's). */
function preflight(ctx, { run, gate }) {
  const read = P.defaultReaders(REPO, ctx.env);
  read.brokerConfig = r => ({ replay: true, maxOrderSize: r.limits.maxOrderSize, maxPositionSize: r.limits.maxPositionSize, maxDailyLoss: r.limits.dailyLoss > 0 ? r.limits.dailyLoss : 'off' });
  try {
    return { ok: true, results: P.preflightForRun(run, gate, { root: REPO, env: ctx.env, noBars: 'no bars given', read }).results };
  } catch (err) {
    return { ok: false, fails: err.message.split('\n').filter(l => /^FAIL/.test(l)) };
  }
}

test('the preflight: day attempts pass on a loop run, are required on every loop run, and are refused on any other learning run', () => {
  const ctx = loopCtx();
  const keep = L.windowRun(ctx, { label: 'champion-t0', window: ctx.loop.tuningWindows[0], tree: REPO, look: {} });
  const k = preflight(ctx, keep);
  assert.ok(k.ok, (k.fails || []).join('\n'));
  assert.match(k.results.find(x => x.check === 'day-attempts').detail, new RegExp(`a fresh ${ACCOUNT.name} attempt each session day at its starting balance`));
  // The check alone: a loop run without them, a run of its own with them, another account: FAIL; neither: N/A.
  const c = (run, gate) => P.dayAttemptsCheck({ run, gate, read: P.defaultReaders(REPO, ctx.env) });
  assert.strictEqual(c({ dayAttempts: null }, { loopRun: true }).status, P.FAIL);
  assert.match(c({ dayAttempts: null }, { loopRun: true }).detail, /a training-loop run trades inside a fresh attempt each session day/);
  assert.strictEqual(c(keep.run, {}).status, P.FAIL);
  assert.match(c(keep.run, {}).detail, /day attempts \(dayAttempts\) are the training loop's runs only/);
  assert.strictEqual(c({ dayAttempts: { account: 'elsewhere' } }, { loopRun: true }).status, P.FAIL);
  assert.strictEqual(c({}, {}).status, P.NA);
  assert.strictEqual(c({ dayAttempts: null, prop: ACCOUNT.name }, { loopRun: true }).status, P.PASS, 'an attempt of its own');
  assert.match(c({ dayAttempts: null, combine: { account: ACCOUNT.name } }, { loopRun: true }).detail, /an attempt of its own \(combine\)/);
  assert.strictEqual(c(keep.run, keep.gate).status, P.PASS);
  // The real preflight on the same run with a gate not the loop's (a replay config of its own): refused.
  const own = preflight(ctx, { run: keep.run, gate: { ...keep.gate, loopRun: undefined, loopRole: undefined } });
  assert.ok(!own.ok);
  assert.ok(own.fails.some(l => l.startsWith('FAIL day-attempts')), own.fails.join('\n'));
  // A loop run without them (as a tree with no policy account would be): refused.
  const { dayAttempts: _x, ...noDays } = keep.run;
  const missing = preflight(ctx, { run: { ...noDays, dayAttempts: null }, gate: keep.gate });
  assert.ok(!missing.ok);
  assert.ok(missing.fails.some(l => l.startsWith('FAIL day-attempts')), missing.fails.join('\n'));
});

test('sizing: a composed entry the model suggests at 1 MNQ in a loop run\'s day attempt is the rulebook\'s size (at least its floor of 3), and the gate takes only that', async () => {
  const H = require('../helpers');
  const LC = require('../fixtures/lifecycle');
  const LCP = require('../fixtures/lifecycle-prop');
  const { composedOrder } = require('../../scripts/lib/trading/lifecycle-order');
  const { evaluateOrder } = require('../../scripts/lib/trading/order-gate');
  const { loadConfig } = require('../../scripts/lib/trading/config');
  const floor = prop.minContractsIn(POLICY, ACCOUNT, REPO, 'MNQ');
  assert.ok(floor >= 3, `the rulebook's floor is ${floor}`);
  // The day's attempt as the driver starts it (day-attempts.js startDay), in the scenario's home at the scenario's day.
  const home = H.trendHome();
  const sched = path.join(home, 'balance-schedule.json');
  const run = { paths: { runHome: home, runDir: home, balanceSchedule: sched }, cfg: { account: '1' }, dayAttempts: { account: ACCOUNT.name }, brokerEnv: {}, root: REPO };
  const startedAt = new Date(LCP.NOW.getTime() - 30 * 60000);
  const deps = { open: async () => false, balance: async () => JSON.parse(fs.readFileSync(sched, 'utf8')).pop().balance };
  assert.strictEqual(await DA.startDay(run, { day: '2026-10-07' }, startedAt, {}, deps, { root: REPO }), 'start');
  // The runner's snapshot at the bar, as live.
  prop.snapshot(home, ACCOUNT, ACCOUNT.starting_balance, new Date(LCP.NOW.getTime() - 60000), { open: 0 });
  LC.writeScenario(home, { size: 1 });
  const SPEC = r => (/^(M?NQ)$/.test(r) ? { tickSize: 0.25, tickValue: r === 'NQ' ? 5 : 0.5 } : null);
  const registry = [POLICY, LCP.LC_DOC];
  const plan = composedOrder({ home, root: 'MNQ', side: 'long', now: LCP.NOW, cycleBars: { MNQ: LC.BAR }, strategy: LCP.LC_DOC, strategies: registry, accounts: [ACCOUNT], specOf: SPEC, accountId: 1, selected: ['MNQ'] });
  assert.strictEqual(plan.policy.name, 'prop_portfolio');
  assert.strictEqual(plan.plan.suggestedSize, 1);
  assert.ok(plan.args.size >= floor, `ordered ${plan.args.size}`);
  assert.strictEqual(plan.args.size, plan.plan.translatedSize);
  // The gate: the translated size goes; the model's 1, or anything else, is refused.
  const config = { ...loadConfig({ FTH_ROLE_SKILLS: 'full' }), killSwitchFile: '/nonexistent/fth/STOP', home, mtfMaxAgeMin: 1e9, signalMaxAgeBars: 1e9, signalMaxAgeCeilingMin: 1e9, cycleBars: { MNQ: LC.BAR }, selection: { symbols: ['MNQ'] } };
  const ev = input => evaluateOrder({ input, entries: [H.plan(1, { ts: '2026-10-07T13:59:30Z' })], now: LCP.NOW, strategies: registry, accounts: [ACCOUNT], specOf: SPEC, config });
  assert.deepStrictEqual(ev(plan.args).violations, []);
  for (const size of [1, plan.args.size - 1, plan.args.size + 1]) assert.ok(ev({ ...plan.args, size }).violations.some(v => v.check === 'composed-reads'), String(size));
  // Outside an attempt (a loop run before day attempts): the model's 1 went as stated, under the floor.
  const free = H.trendHome();
  LC.writeScenario(free, { size: 1 });
  assert.strictEqual(composedOrder({ home: free, root: 'MNQ', side: 'long', now: LCP.NOW, cycleBars: { MNQ: LC.BAR }, strategy: LCP.LC_DOC, strategies: registry, accounts: [ACCOUNT], specOf: SPEC, accountId: 1, selected: ['MNQ'] }).args.size, 1);
});
