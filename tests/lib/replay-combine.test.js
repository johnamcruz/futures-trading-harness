'use strict';

// Stage 2's continuous combine (scripts/lib/replay/combine-run.js): the replay config's `combine` (every refusal and the
// accepted shapes), its attempts' windows, the driver's sequencing (each attempt from zero; no step after a pass or a
// blow; unfinished after maxSessions; the next attempt's start; a resume), the report's math, both hashes, the training
// preflight's combine check and the pools that never mix the stage-2 modes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../../scripts/lib/replay/combine-run');
const prop = require('../../scripts/lib/trading/prop-state');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { accountNamed } = require('../../scripts/lib/trading/accounts');

const REPO = path.join(__dirname, '..', '..');
const { tmpDir: tmp } = require('../helpers');
// The account the active policy strategy trades (the runner keeps that account's attempt record): the attempts'.
const POLICY_ACCOUNT = loadStrategies(REPO, {}).strategies.find(s => s.name === 'prop_portfolio').account;
const ACCOUNT = accountNamed(REPO, POLICY_ACCOUNT, {});

function world() {
  const { resolveReplay } = require('../../scripts/lib/replay/config');
  const dir = tmp();
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL' } } }));
  const env = { PATH: process.env.PATH, HOME: dir, FTH_HOME: live, FTH_BROKERS_FILE: path.join(live, 'brokers.json') };
  // Tuesday 2022-03-01 to Friday 2022-03-11 (practice-train): nine trading days; a narrow session, three bars a day.
  const raw = o => ({
    runId: 'cb1', workDir: path.join(dir, 'replays'), broker: 'sim', start: '2022-03-01T00:00:00Z', end: '2022-03-12T00:00:00Z', premarket: false, endOfDay: false, stage: 2,
    autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-09:40@America/New_York'], eodAt: '15:50@America/New_York' },
    combine: { account: POLICY_ACCOUNT, attempts: ['2022-03-01', '2022-03-07'], maxSessions: 3 }, ...o,
  });
  return { dir, env, raw, resolve: o => resolveReplay(raw(o), { baseDir: dir, env, home: dir, root: REPO }) };
}

test('the replay config: a combine resolves each attempt\'s window on the run\'s trading days; narrower sessions are fine', () => {
  const w = world();
  const run = w.resolve({});
  require('../../scripts/lib/replay/driver').seedRunHome(run, { root: REPO, userEnv: w.env });
  assert.deepStrictEqual(run.combine.attempts.map(a => [a.n, a.start, a.days, a.last]), [
    [1, '2022-03-01', ['2022-03-01', '2022-03-02', '2022-03-03'], '2022-03-03'],
    [2, '2022-03-07', ['2022-03-07', '2022-03-08', '2022-03-09'], '2022-03-09'],
  ]);
  assert.strictEqual(run.combine.account, POLICY_ACCOUNT);
  assert.strictEqual(run.combine.maxSessions, 3);
  // The broker runs with the account's own daily limit and limits; it reads the balance schedule (each attempt's start).
  assert.strictEqual(run.propDailyLoss, ACCOUNT.daily_loss_limit);
  assert.ok(run.limits);
  const { replayEnv } = require('../../scripts/lib/replay/config');
  assert.strictEqual(replayEnv(w.env, run, { at: run.start }).BACKTESTER_BALANCE_SCHEDULE, run.paths.balanceSchedule);
  // maxSessions defaults to the profile's sessions (a window of that many days must fit the run).
  const long = w.resolve({ end: '2022-04-30T00:00:00Z', combine: { account: POLICY_ACCOUNT, attempts: ['2022-03-01'] } });
  assert.strictEqual(long.combine.maxSessions, ACCOUNT.sessions);
  assert.strictEqual(long.combine.attempts[0].days.length, ACCOUNT.sessions);
  // A drawn-state run, a stage-1 run, a run with no combine: no combine, no balance schedule from it.
  assert.strictEqual(w.resolve({ combine: undefined }).combine, null);
});

test('the replay config refuses every combine misconfiguration, naming the field', () => {
  const w = world();
  const bad = (o, re) => assert.throws(() => w.resolve(o), re, JSON.stringify(o));
  const A = { account: POLICY_ACCOUNT, attempts: ['2022-03-01'], maxSessions: 3 };
  bad({ combine: { ...A }, stage: 1 }, /combine: stage 2's continuous combine \(stage: 2\); refused in stage 1/);
  bad({ combine: { ...A }, stage: undefined }, /combine: stage 2's continuous combine/);
  bad({ accountStates: { file: '/no/states.json' } }, /combine: not with accountStates .*one stage-2 mode per replay config/);
  bad({ curatedList: { file: '/no/lists.json', list: 'mix' }, practice: { seed: 1 } }, /combine: not with curatedList/);
  bad({ prop: POLICY_ACCOUNT }, /combine: not with prop/);
  bad({ practice: { seed: 1 } }, /combine: not with practice/);
  bad({ everyNthBar: 2 }, /combine: every bar of an attempt's days runs \(everyNthBar 1\)/);
  bad({ combine: 'yes' }, /combine: \{ "account"/);
  bad({ combine: { ...A, seed: 1 } }, /combine.seed: unknown/);
  bad({ combine: { ...A, account: 'Bad Name' } }, /combine.account: an account profile name/);
  bad({ combine: { ...A, account: 'no_such_profile' } }, /combine.account: unknown account "no_such_profile"/);
  bad({ combine: { ...A, attempts: [] } }, /combine.attempts: a list of each attempt's first trading day/);
  bad({ combine: { ...A, attempts: ['2022-02-30'] } }, /combine.attempts: a list/);
  bad({ combine: { ...A, attempts: ['2022-03-07', '2022-03-01'] } }, /combine.attempts: in order/);
  bad({ combine: { ...A, maxSessions: 0 } }, /combine.maxSessions: a whole number/);
  bad({ combine: { ...A, maxSessions: 2.5 } }, /combine.maxSessions: a whole number/);
  // The windows: a start on no trading day (a Saturday), past the run's end, overlapping, across two split windows.
  bad({ combine: { ...A, attempts: ['2022-03-05'] } }, /combine.attempts\[0\] 2022-03-05: not a trading day of the run/);
  bad({ combine: { ...A, attempts: ['2022-02-25'] } }, /combine.attempts\[0\] 2022-02-25: not a trading day of the run/);
  bad({ combine: { ...A, attempts: ['2022-03-10'] } }, /combine.attempts\[0\] 2022-03-10: its 3 sessions run past the run's end \(2 trading day\(s\) left from it\)/);
  bad({ combine: { ...A, attempts: ['2022-03-01', '2022-03-03'] } }, /combine.attempts\[1\] 2022-03-03: overlaps attempt 1 \(2022-03-01..2022-03-03, its 3 sessions\)/);
  const W = require('../../scripts/lib/schedule').current().learning.windows;
  const edge = W['practice-validate'][0];
  const before = new Date(Date.parse(`${edge}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  const days = (from, n) => { const out = []; for (let t = Date.parse(`${from}T00:00:00Z`); out.length < n; t += 86400000) { const d = new Date(t); if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10)); } return out; };
  const start = days(before, 1)[0];
  bad({ start: `${start}T00:00:00Z`, end: `${days(edge, 10).pop()}T23:00:00Z`, combine: { ...A, attempts: [start], maxSessions: 9 } }, /combine.attempts\[0\] .*: spans practice-train \+ practice-validate; an attempt lies inside one split window/);
  // Not the account the active policy strategy trades: the runner would keep no attempt record for it.
  const env = { ...w.env, FTH_ACCOUNTS_DIRS: path.join(REPO, 'tests', 'fixtures', 'accounts') };
  const { resolveReplay } = require('../../scripts/lib/replay/config');
  assert.throws(() => resolveReplay(w.raw({ combine: { ...A, account: 'test_50k' } }), { baseDir: w.dir, env, home: w.dir, root: REPO }), /combine.account: test_50k is not the account the active policy strategy trades/);
});

test('both hashes name the combine: another attempt list, length or mode is another run and another setup', () => {
  const w = world();
  const { setupHash, configHash } = require('../../scripts/lib/replay/config');
  const run = w.resolve({});
  require('../../scripts/lib/replay/driver').seedRunHome(run, { root: REPO, userEnv: w.env });
  const same = w.resolve({});
  assert.strictEqual(setupHash(same), setupHash(run));
  assert.strictEqual(configHash(same, w.env), configHash(run, w.env));
  for (const o of [{ combine: { account: POLICY_ACCOUNT, attempts: ['2022-03-01', '2022-03-08'], maxSessions: 3 } }, { combine: { account: POLICY_ACCOUNT, attempts: ['2022-03-01', '2022-03-07'], maxSessions: 2 } }, { combine: undefined }]) {
    const other = w.resolve(o);
    assert.notStrictEqual(setupHash(other), setupHash(run), JSON.stringify(o));
    assert.notStrictEqual(configHash(other, w.env), configHash(run, w.env), JSON.stringify(o));
  }
});

test('a learning run\'s look names its stage-2 mode, and the validate pool reads one mode only: combine, drawn states and stage 1 never pool', () => {
  const { trainingMode } = require('../../scripts/lib/learning/preflight');
  assert.deepStrictEqual(trainingMode({ combine: { attempts: [] } }), { mode: 'combine' });
  assert.deepStrictEqual(trainingMode({ accountStates: { hash: 'x' } }), { mode: 'account-states' });
  assert.deepStrictEqual(trainingMode({}), {});
  const looks = require('../../scripts/lib/learning/looks');
  const ledger = path.join(tmp(), 'looks.jsonl');
  const W = require('../../scripts/lib/schedule').current().learning.windows;
  const from = W['practice-validate'][0];
  const to = new Date(Date.parse(`${from}T00:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10);
  const look = (runId, mode) => looks.recordLook(ledger, { evaluation: runId, candidate: 'cand', purpose: 'validate', runId, from, to, arm: 'without', config: `c-${runId}`, ...(mode ? { mode } : {}) }, { create: true });
  look('s1', null);
  look('cb', 'combine');
  look('as', 'account-states');
  look('s1b', null);
  const lines = require('../../scripts/lib/prop/ledger-file').readLedger(ledger);
  assert.deepStrictEqual(lines.map(l => [l.runId, l.mode || null]), [['s1', null], ['cb', 'combine'], ['as', 'account-states'], ['s1b', null]]);
  assert.deepStrictEqual(looks.validateRuns(lines, 'cand').counted, ['s1', 's1b'], 'stage 1 pools stage-1 runs only');
  assert.deepStrictEqual(looks.validateRuns(lines, 'cand', 'combine').counted, ['cb']);
  assert.deepStrictEqual(looks.validateRuns(lines, 'cand', 'account-states').counted, ['as']);
  // The gate passes the mode into the look (run-gate.js).
  const gate = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'learning', 'run-gate.js'), 'utf8');
  assert.strictEqual((gate.match(/mode: opts\.mode \|\| null/g) || []).length, 2, 'checked and recorded with its mode');
});

/**
 * The run to its end against a scripted replay broker: its balance the latest balance-schedule entry the clock reached
 * plus every scripted P&L after it up to the clock (`pnl`: [{ at, usd }]); end of day records the close (as the runner
 * does). `open(now)` says whether a position is open.
 */
async function combineRun(w, { pnl = [], open = () => false, openLoss = () => 0, applies = true, run = null, resolved = null, maxCycles = Infinity, failAfter = null } = {}) {
  const { seedRunHome, runReplay } = require('../../scripts/lib/replay/driver');
  const r = run || resolved || w.resolve({});
  if (!run) seedRunHome(r, { root: REPO, userEnv: w.env });
  const balanceAt = now => {
    if (!applies) return 50000;
    let sched = [];
    try { sched = JSON.parse(fs.readFileSync(r.paths.balanceSchedule, 'utf8')).filter(e => e.at <= now); } catch (_e) { /* none */ }
    const base = sched.length ? sched[sched.length - 1] : { at: '', balance: 50000 };
    return Math.round((base.balance + pnl.filter(p => p.at > base.at && p.at <= now).reduce((a, p) => a + p.usd, 0)) * 100) / 100;
  };
  const steps = [];
  let failing = false;
  const deps = {
    serverCheck: async () => null,
    async step(point, env) {
      const now = env.FTH_REPLAY_NOW;
      const rec = prop.readAttempt(r.paths.runHome, POLICY_ACCOUNT);
      steps.push({ kind: point.kind, day: point.day, t: point.t.toISOString(), balance: balanceAt(now), startedAt: rec && rec.startedAt, days: rec ? rec.days.length : null });
      // The broker goes down right after this step (`failAfter`: its time): the run stops before it ends its attempt.
      if (failAfter && point.t.toISOString() === failAfter) failing = true;
      if (point.kind === 'eod') {
        prop.recordEndOfDay(r.paths.runHome, ACCOUNT, balanceAt(now), point.day);
        fs.writeFileSync(path.join(r.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: true }));
      }
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [] })}\n` };
    },
    async trades() { return []; },
    async open(env) { return open(env.FTH_REPLAY_NOW); },
    // The open position's P&L at its worst since the last check (scripted: `openLoss(now)`), 0 when flat.
    async openPnl(env) { return openLoss(env.FTH_REPLAY_NOW); },
    async balance(env) {
      if (failing) throw new Error('broker down');
      return balanceAt(env.FTH_REPLAY_NOW);
    },
  };
  const logs = [];
  const res = await runReplay({ run: r, baseEnv: w.env, root: REPO, deps, maxCycles, log: m => logs.push(m) });
  return { run: r, res, steps, logs, log: C.readLog(r.paths.runDir) };
}

const S0 = ACCOUNT.starting_balance;
// A blow: one loss past the max loss, on the attempt's second day, between its first and second bar.
const BLOW = { at: '2022-03-02T14:34:00Z', usd: -(ACCOUNT.max_loss + 100) };
// A pass under the consistency rule: two equal days, the profit just past the target.
const HALF = Math.ceil(ACCOUNT.profit_target / 2) + 100;
const PASS = [{ at: '2022-03-07T14:34:00Z', usd: HALF }, { at: '2022-03-08T14:34:00Z', usd: HALF }];

test('the driver: each attempt from zero; no step after a blow or a pass; the next attempt starts fresh at the starting balance', async () => {
  const w = world();
  const { run, res, steps, log, logs } = await combineRun(w, { pnl: [BLOW, ...PASS] });
  assert.strictEqual(res.done, true);
  // Attempt 1: day 1 whole (four bars, end of day), day 2 up to the blow (its first two bars), then only that day's end
  // of day (the runner's flatten and close): no trade cycle after the blow, and 03-03 never stepped.
  assert.deepStrictEqual(steps.filter(s => s.day <= '2022-03-03').map(s => `${s.day} ${s.kind}`), [...Array(4).fill('2022-03-01 trade'), '2022-03-01 eod', '2022-03-02 trade', '2022-03-02 trade', '2022-03-02 eod']);
  assert.ok(steps.every(s => s.t < BLOW.at || s.kind === 'eod' || s.day >= '2022-03-07'), 'no trade step of attempt 1 after its blow');
  // Attempt 2 starts fresh: the broker at the starting balance, a new record (no closed days), started on its first day.
  const first2 = steps.find(s => s.day === '2022-03-07');
  assert.deepStrictEqual([first2.balance, first2.days, first2.startedAt.slice(0, 10)], [S0, 0, '2022-03-07']);
  // It passes at the second day's close: the third day (03-09) is never stepped.
  assert.deepStrictEqual([...new Set(steps.filter(s => s.day >= '2022-03-07').map(s => s.day))], ['2022-03-07', '2022-03-08']);
  assert.deepStrictEqual(log.map(x => [x.kind, x.attempt, x.outcome || null]), [['start', 1, null], ['end', 1, 'blown'], ['start', 2, null], ['end', 2, 'passed']]);
  const [e1, e2] = log.filter(x => x.kind === 'end');
  assert.deepStrictEqual([e1.sessions, e1.days, e1.profit, e1.lowCushion, e1.worstDay, e1.dailyLimit], [2, ['2022-03-01', '2022-03-02'], BLOW.usd, ACCOUNT.max_loss + BLOW.usd, BLOW.usd, ACCOUNT.daily_loss_limit]);
  assert.deepStrictEqual([e2.sessions, e2.profit, e2.worstDay, e2.closedDays], [2, 2 * HALF, 0, 2]);
  assert.strictEqual(e2.lowCushion, ACCOUNT.max_loss, 'never below the starting cushion');
  // The balance schedule: one entry per attempt, at the starting balance; the first attempt's record kept, renamed.
  const sched = JSON.parse(fs.readFileSync(run.paths.balanceSchedule, 'utf8'));
  assert.deepStrictEqual(sched.map(e => [e.attempt, e.day, e.balance, e.dayPnl]), [[1, '2022-03-01', S0, 0], [2, '2022-03-07', S0, 0]]);
  assert.strictEqual(fs.readdirSync(path.join(run.paths.runHome, 'combine')).filter(f => f.includes('.ended-')).length, 1);
  assert.ok(logs.some(l => /combine attempt 1 \(2022-03-01\) blown after 2 session\(s\)/.test(l)), logs.join('\n'));
  assert.ok(logs.some(l => /combine attempt 2 \(2022-03-07\) passed after 2 session\(s\)/.test(l)), logs.join('\n'));
  const manifest = JSON.parse(fs.readFileSync(run.paths.manifest, 'utf8'));
  assert.deepStrictEqual([manifest.finished, manifest.combine.current, manifest.combine.ended], [true, null, [0, 1]]);
});

test('the driver: an attempt still active after maxSessions ends unfinished; ended with a position open, only a day\'s end of day runs', async () => {
  const w = world();
  const quiet = await combineRun(w);
  assert.deepStrictEqual(quiet.log.filter(x => x.kind === 'end').map(x => [x.attempt, x.outcome, x.sessions, x.profit]), [[1, 'unfinished', 3, 0], [2, 'unfinished', 3, 0]]);
  assert.strictEqual(quiet.steps.length, 2 * 3 * 5, 'every decision time of both attempts\' days (four bars and end of day), none between');
  const v = world();
  const openUntil = '2022-03-02T20:51:00Z';
  const held = await combineRun(v, { pnl: [BLOW], open: now => now >= BLOW.at && now < openUntil });
  const a1 = held.steps.filter(s => s.day <= '2022-03-03').map(s => `${s.day} ${s.kind}`);
  assert.deepStrictEqual(a1, [...Array(4).fill('2022-03-01 trade'), '2022-03-01 eod', '2022-03-02 trade', '2022-03-02 trade', '2022-03-02 eod'], 'the end of day flattens; no trade cycle after the blow');
  assert.deepStrictEqual(held.log.filter(x => x.kind === 'end').map(x => [x.attempt, x.outcome]), [[1, 'blown'], [2, 'unfinished']]);
  assert.ok(held.logs.some(l => /combine attempt 1 blown: no trade cycle after it; only the day's end of day runs/.test(l)), held.logs.join('\n'));
  // Passed at 03-08's close with a position still open the next morning: 03-09 runs only its end of day, then it ends.
  const u = world();
  const late = await combineRun(u, { pnl: PASS, open: now => now >= '2022-03-09T00:00:00Z' && now < '2022-03-09T20:51:00Z' });
  assert.deepStrictEqual(late.steps.filter(s => s.day === '2022-03-09').map(s => s.kind), ['eod']);
  // Its sessions count to the close that passed it (03-08), not the next day's flatten.
  assert.deepStrictEqual(late.log.filter(x => x.kind === 'end').map(x => [x.attempt, x.outcome, x.sessions]), [[1, 'unfinished', 3], [2, 'passed', 2]]);
  assert.deepStrictEqual(late.log.find(x => x.kind === 'end' && x.attempt === 2).days, ['2022-03-07', '2022-03-08']);
});

test('the driver: a resume keeps the attempt under way and starts none twice; it refuses a broker that ignores the schedule or an attempt that would start open', async () => {
  const w = world();
  const first = await combineRun(w, { pnl: [BLOW, ...PASS], maxCycles: 7 });
  assert.strictEqual(first.res.done, false);
  const again = await combineRun(w, { pnl: [BLOW, ...PASS], run: first.run });
  assert.strictEqual(again.res.done, true);
  assert.deepStrictEqual(again.log.map(x => [x.kind, x.attempt, x.outcome || null]), [['start', 1, null], ['end', 1, 'blown'], ['start', 2, null], ['end', 2, 'passed']]);
  assert.strictEqual(JSON.parse(fs.readFileSync(first.run.paths.balanceSchedule, 'utf8')).length, 2);
  // Stopped right after the run's last step, before its attempt under way ended: the resume ends it, stepping nothing.
  const v = world();
  await assert.rejects(combineRun(v, { failAfter: '2022-03-09T20:50:00.000Z' }), /replay refused: can't read the account's balance for the combine attempt \(broker down\)/);
  assert.deepStrictEqual(C.readLog(v.resolve({}).paths.runDir).map(x => [x.kind, x.attempt]), [['start', 1], ['end', 1], ['start', 2]]);
  const resumed = await combineRun(v, { run: v.resolve({}) });
  assert.deepStrictEqual([resumed.res.done, resumed.steps.length], [true, 0]);
  assert.deepStrictEqual(resumed.log.filter(x => x.kind === 'end').map(x => [x.attempt, x.outcome, x.sessions]), [[1, 'unfinished', 3], [2, 'unfinished', 3]]);
  await assert.rejects(combineRun(world(), { applies: false }), /replay refused: the replay broker reports a balance of 50000, not .*'s starting \d+: it doesn't apply the balance schedule/);
  await assert.rejects(combineRun(world(), { open: () => true }), /replay refused: combine attempt 1 \(2022-03-01\) would start with a position or working order open/);
  await assert.rejects(combineRun(world(), { open: () => { throw new Error('broker down'); } }), /replay refused: can't read the account to start combine attempt 1 \(broker down\)/);
});

test('equity: an open loss that touches the floor between steps blows the attempt, even after the trade recovers', async () => {
  const w = world();
  // A position open on 03-02 from 14:31; at the 14:36 check its worst price since the last check put equity $100 under
  // the floor; it recovers (0) by the next check; the balance never moves.
  // After it, the position can't be valued (the broker's bars gone): an ended attempt reads nothing more, so no refusal.
  const touch = now => {
    if (now > '2022-03-02T14:37:00Z' && now < '2022-03-02T20:00:00Z') throw new Error('no bars');
    return now >= '2022-03-02T14:36:00Z' && now < '2022-03-02T14:37:00Z' ? -(ACCOUNT.max_loss + 100) : 0;
  };
  const r = await combineRun(w, { openLoss: touch, open: now => now >= '2022-03-02T14:31:00Z' && now < '2022-03-02T20:51:00Z' });
  assert.deepStrictEqual(r.steps.filter(s => s.day === '2022-03-02').map(s => s.kind), ['trade', 'trade', 'eod'], 'no trade cycle after the touch; its day\'s end of day');
  const e1 = r.log.find(x => x.kind === 'end' && x.attempt === 1);
  assert.deepStrictEqual([e1.outcome, e1.profit, e1.lowCushion, e1.worstDay], ['blown', 0, -100, -(ACCOUNT.max_loss + 100)]);
  // An open position it can't value refuses the step: never assumed whole.
  await assert.rejects(combineRun(world(), { openLoss: now => { if (now >= '2022-03-02T14:36:00Z') throw new Error('no bars'); return 0; } }), /replay refused: can't value the open position for the combine attempt \(no bars\): the step waits, never assuming no loss/);
  await assert.rejects(combineRun(world(), { openLoss: () => NaN }), /the open position's P&L is not a number/);
  // Blown on its last session with a position open, then flattened at a gain at that day's end: still blown (the
  // attempt's end at the next attempt's start keeps the blow).
  const v = world();
  const last = await combineRun(v, {
    openLoss: now => (now >= '2022-03-03T14:36:00Z' && now < '2022-03-03T14:37:00Z' ? -(ACCOUNT.max_loss + 100) : 0),
    open: now => now >= '2022-03-03T14:31:00Z' && now < '2022-03-03T20:50:00Z',
    pnl: [{ at: '2022-03-03T20:49:00Z', usd: 100 }],
  });
  const e = last.log.find(x => x.kind === 'end' && x.attempt === 1);
  assert.deepStrictEqual([e.outcome, e.profit, e.sessions], ['blown', 100, 3]);
});

test('fails closed: a blow found before the day\'s first step, the open check throwing, runs only that day\'s end of day, then ends', async () => {
  const w = world();
  // Blown overnight (after 03-01's close); on 03-02 the account can't be read: counted open.
  const r = await combineRun(w, { pnl: [{ at: '2022-03-01T21:00:00Z', usd: -(ACCOUNT.max_loss + 100) }], open: now => { if (now.startsWith('2022-03-02')) throw new Error('broker down'); return false; } });
  assert.deepStrictEqual(r.steps.filter(s => s.day === '2022-03-02').map(s => s.kind), ['eod']);
  assert.deepStrictEqual(r.steps.filter(s => s.day === '2022-03-03'), []);
  assert.deepStrictEqual(r.log.filter(x => x.kind === 'end').map(x => [x.attempt, x.outcome]), [[1, 'blown'], [2, 'unfinished']]);
});

test('openPnlAt and worstPrice: each open position at its worst price, less its exit fee; anything unreadable throws', () => {
  const specOf = () => ({ tickSize: 0.25, tickValue: 0.5 });
  assert.strictEqual(C.worstPrice([{ l: 99, h: 105 }, { l: 97, h: 102 }], true), 97);
  assert.strictEqual(C.worstPrice([{ l: 99, h: 105 }, { l: 97, h: 102 }], false), 105);
  assert.strictEqual(C.worstPrice([], true), null);
  assert.strictEqual(C.worstPrice([{ l: null, h: null }], true), null, 'a bar without the price is no price (never 0)');
  assert.throws(() => C.openPnlAt([{ contractId: 'MNQ', type: 2, size: 1, averagePrice: null }], { worstOf: () => 100, specOf }), /no entry or market price/);
  // Long 2 MNQ from 100 at a worst of 97: -3 points x $2 x 2 = -$12, less a $0.37 fee each.
  const long = { contractId: 'MNQ', type: 1, size: 2, averagePrice: 100 };
  assert.strictEqual(C.openPnlAt([long], { worstOf: () => 97, specOf, feeOf: () => 0.37 }), -12.74);
  assert.strictEqual(C.openPnlAt([{ ...long, type: 2 }], { worstOf: () => 105, specOf }), -20);
  assert.strictEqual(C.openPnlAt([], { worstOf: () => null, specOf }), 0);
  assert.throws(() => C.openPnlAt([long], { worstOf: () => null, specOf }), /no entry or market price/);
  assert.throws(() => C.openPnlAt([long], { worstOf: () => 97, specOf: () => null }), /no tick spec/);
  assert.throws(() => C.openPnlAt([{ ...long, type: 9 }], { worstOf: () => 97, specOf }), /unknown type/);
  assert.throws(() => C.openPnlAt([{ ...long, size: 'x' }], { worstOf: () => 97, specOf }), /no valid size/);
  assert.strictEqual(C.passedOn(ACCOUNT, { days: [{ day: 'a', balance: S0 + HALF, pnl: HALF }, { day: 'b', balance: S0 + 2 * HALF, pnl: HALF }] }), 'b');
  assert.strictEqual(C.passedOn(ACCOUNT, { days: [{ day: 'a', balance: S0 + 2 * HALF, pnl: 2 * HALF }] }), null, 'consistency: one day can\'t pass');
});

test('maxSessions: at most the profile\'s sessions (fewer stops a smoke early); a combine without the harness root is refused', () => {
  const w = world();
  assert.throws(() => w.resolve({ end: '2022-06-30T00:00:00Z', combine: { account: POLICY_ACCOUNT, attempts: ['2022-03-01'], maxSessions: ACCOUNT.sessions + 1 } }), new RegExp(`combine.maxSessions: ${ACCOUNT.sessions + 1} is more than .*'s sessions \\(${ACCOUNT.sessions}\\)`));
  assert.strictEqual(w.resolve({ end: '2022-06-30T00:00:00Z', combine: { account: POLICY_ACCOUNT, attempts: ['2022-03-01'], maxSessions: ACCOUNT.sessions } }).combine.maxSessions, ACCOUNT.sessions);
  const { resolveReplay } = require('../../scripts/lib/replay/config');
  assert.throws(() => resolveReplay(w.raw({}), { baseDir: w.dir, env: w.env, home: w.dir }), /combine: needs the harness root/);
});

test('a stage-2 look recorded without a mode never pools with stage 1: its run home shows the attempt, and the pool can\'t pass', () => {
  const S = require('../../scripts/lib/replay/stage');
  const dir = tmp();
  const mk = (id, files = []) => { const home = path.join(dir, id); fs.mkdirSync(path.join(home, 'replay', id), { recursive: true }); for (const f of files) { fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }); fs.writeFileSync(path.join(home, f), '{}'); } return home; };
  assert.strictEqual(S.stageTwoHome(mk('s1'), 's1'), false);
  assert.strictEqual(S.stageTwoHome(mk('cb', ['replay/cb/combine.jsonl']), 'cb'), true);
  assert.strictEqual(S.stageTwoHome(mk('as', ['replay/as/account-states.jsonl']), 'as'), true);
  assert.strictEqual(S.stageTwoHome(mk('pp', ['combine/acct.json']), 'pp'), true);
  const pool = { candidate: 'cand', named: true, runId: 's1', counted: [{ runId: 's1', decisions: [], adherence: { agree: 0, disagree: 0 } }], missing: [], foreign: ['as'], windows: [], beyond: [], all: { runs: 2, candidates: 1 } };
  const r = S.pooledExitTest(pool);
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual([r.tests[0].test, r.tests[0].status], ['pool', 'INSUFFICIENT']);
  assert.match(r.tests[0].detail, /as are stage-2 runs .*never pool with stage 1/);
});

test('the report: per attempt and totals (pass rate, blows, median sessions to pass), the promotion gate\'s numbers labelled practice', async () => {
  const w = world();
  const { run } = await combineRun(w, { pnl: [BLOW, ...PASS] });
  // Each attempt's trades from the run's closing fills (report.js tradesOf): one winner on attempt 2's second day.
  const days = { '2022-03-01': [], '2022-03-02': [{ trades: [{ profitAndLoss: -50, fees: 1, contractId: 'x' }] }], '2022-03-07': [], '2022-03-08': [{ trades: [{ roundTrip: { net: 100, r: 2 } }, { roundTrip: { net: -40, r: -1 } }] }] };
  const rep = C.combineReport(run.paths.runDir, { days, role: 'practice-train' });
  assert.deepStrictEqual(rep.attempts.map(a => [a.attempt, a.outcome, a.sessions, a.trades, a.winRate, a.meanR]), [[1, 'blown', 2, 1, 0, null], [2, 'passed', 2, 2, 0.5, 0.5]]);
  assert.deepStrictEqual(rep.totals, { attempts: 2, running: 0, passed: 1, blown: 1, unfinished: 0, passRate: 0.5, medianSessionsToPass: 2 });
  const lines = C.reportLines(rep);
  assert.match(lines[0], /^continuous combine: 2 attempt\(s\), each from zero at the starting balance/);
  assert.match(lines[1], new RegExp(`attempt 1 from 2022-03-01: blown after 2 session\\(s\\); profit -\\$${-BLOW.usd}\\.00 of \\$${ACCOUNT.profit_target}\\.00; lowest cushion -\\$100\\.00 to the floor; worst day -\\$${-BLOW.usd}\\.00 \\(daily limit \\$${ACCOUNT.daily_loss_limit}\\.00\\); 1 trade\\(s\\), win rate 0\\.0%, mean R -`));
  assert.match(lines[2], /attempt 2 from 2022-03-07: passed after 2 session\(s\); .*2 trade\(s\), win rate 50\.0%, mean R 0\.50/);
  assert.match(lines[3], /totals: 2 attempt\(s\) ended: 1 passed \(pass rate 50\.0%\), 1 blown, 0 unfinished; median sessions to pass 2/);
  assert.match(lines[4], /promotion gate numbers \(prop\/promotion\.js, frozen: at least 20 independent attempts over 2 months, at most 0 blows, pass rate at least 40%\): practice \(practice-train\), never a promotion score; short of them: too small an out-of-sample test \(2 independent of 2 attempts over 1 month\(s\).*blows out of sample \(1/);
  // report.js: the same lines in the terminal table and report.md, only for a combine run.
  const R = require('../../scripts/lib/replay/report');
  const summary = R.summarize(days, { runDir: run.paths.runDir });
  assert.match(R.toText(summary), /continuous combine: 2 attempt\(s\)/);
  assert.match(R.toMarkdown(summary, {}), /## Continuous combine\n\n- continuous combine: 2 attempt\(s\)/);
  assert.strictEqual(R.summarize(days, { runDir: tmp() }).combine, undefined);
  assert.strictEqual(C.combineReport(tmp()), null);
});

test('attemptSummary: the lowest cushion over every close and the balance now; the worst day over closes, today and what the driver saw', () => {
  const rec = { days: [{ day: 'd1', balance: S0 + 1000, pnl: 1000 }, { day: 'd2', balance: S0 + 400, pnl: -600 }] };
  const s = C.attemptSummary(ACCOUNT, rec, S0 + 100, { low: null, worst: -900 });
  // After d1 the floor trails to S0 + 1000 - max_loss: d2's close leaves max_loss - 600 of cushion, now max_loss - 900.
  assert.strictEqual(s.floor, S0 + 1000 - ACCOUNT.max_loss);
  assert.strictEqual(s.lowCushion, ACCOUNT.max_loss - 900);
  assert.strictEqual(s.worstDay, -900);
  assert.strictEqual(s.profit, 100);
  assert.strictEqual(C.attemptSummary(ACCOUNT, rec, S0 + 100, { low: 5, worst: null }).lowCushion, 5);
  assert.strictEqual(C.attemptSummary(ACCOUNT, rec, S0 + 100, {}).worstDay, -600);
  assert.strictEqual(C.attemptOf({ attempts: [{ days: ['a'] }, { days: ['b'] }] }, 'b'), 1);
  assert.strictEqual(C.attemptOf({ attempts: [{ days: ['a'] }] }, 'z'), -1);
});

test('the stage report of a combine run: its attempts, then the Monte Carlo of its own trades; a drawn-state run keeps its practice lines', async () => {
  const S = require('../../scripts/lib/replay/stage');
  const w = world();
  const { run } = await combineRun(w, { pnl: [BLOW, ...PASS] });
  const read = role => ({ features: () => ({ skillUsage: false, monteCarlo: true }), adherence: () => ({ decisions: 0, agree: 0, disagree: 0, unchecked: 0 }), learning: () => ({ decisions: [] }), role: () => role });
  const lines = S.stageReport(run, { root: REPO, read: read('practice-train') });
  assert.ok(lines.includes('stage 2 (pass prop) report:'), lines.join('\n'));
  assert.ok(lines.some(l => /^continuous combine: 2 attempt/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /totals: 2 attempt\(s\) ended: 1 passed/.test(l)));
  assert.ok(lines.some(l => /30-day Monte Carlo of the run's own trades \(continuous days, their natural rate\)/.test(l)));
  assert.ok(!lines.some(l => /practice by account state/.test(l)), 'no drawn-state lines');
  assert.ok(S.stageReport(run, { root: REPO, read: read('practice-validate') }).includes('promotion gate: see the prop report'));
  const drawn = S.stageReport({ ...run, combine: null }, { root: REPO, read: { ...read('practice-train'), statesLog: () => [] } });
  assert.ok(drawn.some(l => /practice by account state/.test(l)), drawn.join('\n'));
});

test('the training preflight: a combine run passes with its mode and windows shown; a wrong account or window fails, naming the field', () => {
  const P = require('../../scripts/lib/learning/preflight');
  const w = world();
  const run = w.resolve({});
  const ctx = (o = {}, strategies = [{ name: 'prop_portfolio', account: POLICY_ACCOUNT }]) => ({ run: { ...run, ...o }, gate: { from: run.start, to: run.end }, read: { strategies: () => strategies, features: () => ({ lossStreakStop: true, exitMode: true, monteCarlo: true }) } });
  const ok = P.combineCheck(ctx());
  assert.strictEqual(ok.status, P.PASS, ok.detail);
  assert.match(ok.detail, new RegExp(`continuous combine on ${POLICY_ACCOUNT}, up to 3 session\\(s\\) an attempt, each from zero: 1 2022-03-01..2022-03-03, 2 2022-03-07..2022-03-09`));
  assert.strictEqual(P.combineCheck(ctx({ combine: null })).status, P.NA);
  assert.match(P.combineCheck(ctx({}, [{ name: 'prop_portfolio', account: 'other' }])).detail, /combine.account .*: prop_portfolio trades other/);
  const overlapping = { ...run.combine, attempts: [run.combine.attempts[0], { ...run.combine.attempts[1], start: '2022-03-03' }] };
  assert.match(P.combineCheck(ctx({ combine: overlapping })).detail, /combine.attempts 2022-03-03: overlaps attempt 1/);
  const W = require('../../scripts/lib/schedule').current().learning.windows;
  const far = { ...run.combine, attempts: [{ n: 1, start: W.test[0], days: [W.test[0]], last: W.test[0] }] };
  const f = P.combineCheck(ctx({ combine: far }));
  assert.deepStrictEqual([f.status, /combine.attempts .*practice refused/.test(f.detail)], [P.FAIL, true], f.detail);
  // The stage and practice-mode checks take the combine as stage 2's practice mode (no curated list, no account states, no setup focus).
  assert.strictEqual(P.practiceMode(ctx()).status, P.PASS);
  assert.match(P.practiceMode(ctx()).detail, /continuous combine/);
  const st = P.stage({ ...ctx(), read: { ...ctx().read } });
  assert.strictEqual(st.status, P.PASS, st.detail);
  assert.match(st.detail, new RegExp(`stage 2 on practice-train: continuous combine \\(2 attempt\\(s\\) on ${POLICY_ACCOUNT}\\)`));
  assert.match(P.stage(ctx({ stage: 1 })).detail, /no continuous combine in stage 1/);
  assert.match(P.stage(ctx({ combine: null })).detail, /a stage 2 practice run is a continuous combine \(combine\) or starts its days from drawn account states/);
});
