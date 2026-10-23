'use strict';

/**
 * Stage 2's two modes end to end (docs/TRAINING.md section 5), each one a learning replay through `scripts/replay.js run`:
 * the training preflight, the real driver, the live runner, the order gate and the replay broker (the mock exchange as a
 * replay server, its P&L scripted: tests/fixtures/mock-exchange.js scriptedFills), with the scripted model as the harness
 * CLI (tests/fixtures/scripted-opencode.js, as the pipeline smoke test runs it). No model, no network.
 *
 *   combine         two attempts on practice-train days: the first blows on its first day (no cycle after it, its second
 *                   day never stepped), the second starts fresh at the starting balance and passes at its second close;
 *                   the stage report's attempt lines and the Monte Carlo of the finished run
 *   accountStates   two curated days, each opening at its drawn balance (the attempt line in the prompt shows it); the run
 *                   finishes, its practice by account state and its Monte Carlo reported
 * Both finish with no error, refusal or warning in their output, their runner steps or the gate's log.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const D = require('../fixtures/decision-path');
const PF = require('../fixtures/preflight');
const { readRun } = require('../../scripts/lib/replay/store');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const AS = require('../../scripts/lib/prop/account-states');
const { gateLimits } = require('../../scripts/lib/prop/attempts');
const combineState = require('../../scripts/lib/trading/combine');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js');
const STANDIN = path.join(ROOT, 'tests', 'fixtures', 'scripted-opencode.js');
const script = name => path.join(ROOT, 'scripts', name);
const ACCOUNT = accountNamed(ROOT, loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio').account, {});

// The parity bars (Thursday, Friday and Monday sessions) moved by whole weeks into practice-train, twice: the weeks of
// Monday 2022-04-25 (Thu 04-21, Fri 04-22, Mon 04-25) and 2022-05-02 (Thu 04-28, Fri 04-29, Mon 05-02).
const WEEK = 7 * 86400000;
const MONDAYS = ['2022-04-25', '2022-05-02'];
const shiftOf = monday => Math.round((Date.parse(`${monday}T00:00:00Z`) - PF.PARITY_MONDAY) / WEEK) * WEEK;

const sh = (file, args, env) => {
  const r = spawnSync(process.execPath, [file, ...args], { env, encoding: 'utf8', timeout: 300000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

function world({ scriptedFills = [] } = {}) {
  const home = tmpDir();
  const live = path.join(home, 'live-home');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(live);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({
    brokers: { replaymock: { command: [process.execPath, SERVER], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_STATE_DIR', 'MOCK_JOURNAL', 'MOCK_CLOCK_FILE', 'MOCK_REPLAY', 'MOCK_INIT_FILE', 'MOCK_PRICE_FROM_BARS', 'MOCK_BALANCE_SCHEDULE', 'MOCK_MAX_ORDER_SIZE', 'MOCK_MAX_POSITION_SIZE', 'MOCK_MAX_DAILY_LOSS'], limits: { dailyLoss: 'MOCK_MAX_DAILY_LOSS', maxOrderSize: 'MOCK_MAX_ORDER_SIZE', maxPositionSize: 'MOCK_MAX_POSITION_SIZE' } } },
  }));
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\nexec "${process.execPath}" "${STANDIN}" "$@"\n`, { mode: 0o755 });
  const moved = (bars, monday) => bars.map(b => ({ ...b, t: new Date(Date.parse(b.t) + shiftOf(monday)).toISOString() }));
  const both = bars => MONDAYS.flatMap(m => moved(bars, m)).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const init = path.join(home, 'exchange.json');
  fs.writeFileSync(init, JSON.stringify({ prices: { [D.MNQ_ID]: D.BARS[0].c }, bars: { [D.MNQ_ID]: both(D.BARS), [`${D.MNQ_ID}@1m`]: both(D.MINUTE_BARS) }, scriptedFills }));
  const model = path.join(home, 'model-script.json');
  fs.writeFileSync(model, JSON.stringify({ bars: {} }));
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, FTH_HOME: live, NODE_ENV: 'test',
    MOCK_REPLAY: '1', MOCK_PRICE_FROM_BARS: '1', MOCK_INIT_FILE: init, SMOKE_MODEL_SCRIPT: model,
    FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'),
  };
  return { home, live, env, bars1m: PF.writeMinuteBars(path.join(home, 'MNQ-1m.csv'), MONDAYS[0]) };
}

/** A stage-2 replay config: the trader's runner config, a narrow session (three bars and end of day a day). */
function replayConfig(w, runId, over) {
  const file = path.join(w.home, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    runId, workDir: path.join(w.home, 'replays'), broker: 'replaymock', stage: 2, premarket: false,
    autotrader: {
      harness: 'opencode', model: '', symbols: ['MNQ'], account: '7', timeframe: 3, lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'data' }],
      sessions: ['09:30-09:40@America/New_York'], eodAt: '15:50@America/New_York',
    },
    brokerEnv: { clockFile: 'MOCK_CLOCK_FILE', stateDir: 'MOCK_STATE_DIR', runId: null, start: null, end: null, balanceSchedule: 'MOCK_BALANCE_SCHEDULE' },
    ...over,
  }));
  return file;
}

const runHomeOf = (w, runId) => path.join(w.home, 'replays', runId);
const recordsOf = (w, runId) => readRun(path.join(runHomeOf(w, runId), 'replay', runId)).days;

/** No error, refusal or warning anywhere the run writes one: its output, its runner steps, the gate's log. */
function assertClean(w, runId, out) {
  const home = runHomeOf(w, runId);
  const steps = fs.readFileSync(path.join(home, 'replay', runId, 'steps.log'), 'utf8');
  const bad = re => [...out.split('\n'), ...steps.split('\n')].filter(l => re.test(l));
  assert.deepStrictEqual(bad(/\b(ERROR|error:|WARN|warning|refused|FAIL\b)/), [], 'no error, refusal or warning in the output or the steps');
  const gateLog = path.join(home, 'logs', 'gate-log.jsonl');
  const gated = fs.existsSync(gateLog) ? fs.readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  assert.deepStrictEqual(gated.filter(e => e.decision !== 'allowed'), [], 'the gate refused nothing');
  for (const recs of Object.values(recordsOf(w, runId))) for (const r of recs) assert.deepStrictEqual([r.refusals, (r.ran || []).filter(x => !x.ok)], [[], []], r.t);
}

test('stage 2, combine: two attempts from zero; the first blows (no cycle after it), the second passes; report and Monte Carlo', { timeout: 600000 }, () => {
  // Attempt 1 (Thu 04-21, Fri 04-22): a loss past the max loss at 09:34 ET of its first day. Attempt 2 (Thu 04-28, Fri
  // 04-29): half the target and a little more on each day, so its second close passes under the consistency rule.
  const half = Math.ceil(ACCOUNT.profit_target / 2) + 100;
  const blowAt = '2022-04-21T13:34:00Z';
  const w = world({ scriptedFills: [{ at: blowAt, pnl: -(ACCOUNT.max_loss + 100) }, { at: '2022-04-28T13:34:00Z', pnl: half }, { at: '2022-04-29T13:34:00Z', pnl: half }] });
  const config = replayConfig(w, 'combine-e2e', {
    start: '2022-04-21T13:30:00Z', end: '2022-04-30T00:00:00Z',
    combine: { account: ACCOUNT.name, attempts: ['2022-04-21', '2022-04-28'], maxSessions: 2 },
  });
  const pre = sh(script('training-preflight.js'), ['--config', config, '--bars', `MNQ=${w.bars1m}`], w.env);
  assert.strictEqual(pre.code, 0, pre.out);
  assert.match(pre.out, new RegExp(`PASS combine: continuous combine on ${ACCOUNT.name}, up to 2 session\\(s\\) an attempt, each from zero: 1 2022-04-21..2022-04-22, 2 2022-04-28..2022-04-29`));
  assert.match(pre.out, /PASS stage: stage 2 on practice-train: continuous combine/);
  assert.match(pre.out, /PASS practice-mode: continuous combine/);
  const r = sh(script('replay.js'), ['run', '--config', config, '--bars', `MNQ=${w.bars1m}`], w.env);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /new run combine-e2e .*learning: practice-train/);
  const days = recordsOf(w, 'combine-e2e');
  // Attempt 1: its first day up to the blow and then only its end of day (the runner's flatten and close), never its
  // second day; attempt 2: both its days, every decision time.
  assert.deepStrictEqual(Object.keys(days).sort(), ['2022-04-21', '2022-04-28', '2022-04-29']);
  assert.deepStrictEqual(days['2022-04-21'].map(x => x.kind), ['trade', 'trade', 'eod']);
  assert.ok(days['2022-04-21'].filter(x => x.kind === 'trade').every(x => x.t < blowAt), 'no trade cycle of attempt 1 after its blow');
  for (const d of ['2022-04-28', '2022-04-29']) assert.deepStrictEqual(days[d].map(x => x.kind), ['trade', 'trade', 'trade', 'trade', 'eod'], d);
  // No end of day caught up for a skipped day: every step ran its own day's action.
  for (const recs of Object.values(days)) for (const x of recs) assert.deepStrictEqual((x.ran || []).map(c => c.action), [x.kind], x.t);
  const log = fs.readFileSync(path.join(runHomeOf(w, 'combine-e2e'), 'replay', 'combine-e2e', 'combine.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(log.map(x => [x.kind, x.attempt, x.outcome || null]), [['start', 1, null], ['end', 1, 'blown'], ['start', 2, null], ['end', 2, 'passed']]);
  // The second attempt started fresh: at the starting balance, its first cycle's attempt line day 1 with no profit.
  assert.strictEqual(log[2].balance, ACCOUNT.starting_balance);
  const first2 = days['2022-04-28'].find(x => x.kind === 'trade');
  const prompt = JSON.parse(fs.readFileSync(first2.cycles[0].file, 'utf8')).prompt;
  assert.match(prompt, new RegExp(`${ACCOUNT.name} attempt \\(active\\)`));
  assert.match(prompt, /profit \+?\$0 of /);
  assert.match(prompt, /\bday 1\b/);
  // The stage report's attempt lines, then the Monte Carlo of the finished run.
  assert.match(r.out, /stage 2 \(pass prop\) report:/);
  assert.match(r.out, /continuous combine: 2 attempt\(s\), each from zero at the starting balance/);
  assert.match(r.out, /attempt 1 from 2022-04-21: blown after 1 session\(s\); profit -\$\d+\.00 of .*1 trade\(s\), win rate 0\.0%/);
  assert.match(r.out, /attempt 2 from 2022-04-28: passed after 2 session\(s\); profit \$\d+\.00 of .*2 trade\(s\), win rate 100\.0%/);
  assert.match(r.out, /totals: 2 attempt\(s\) ended: 1 passed \(pass rate 50\.0%\), 1 blown, 0 unfinished; median sessions to pass 2/);
  assert.match(r.out, /promotion gate numbers \(prop\/promotion\.js, frozen.*practice \(practice-train\), never a promotion score/);
  // The Monte Carlo reads the finished run as a real (full-day) score: it refuses only the scripted fills, which no
  // order of the model placed (a real score never leaves an entry out).
  assert.match(r.out, /Prop Monte Carlo: not scored \(3 entries without a settled outcome \(MNQ 2022-04-21T13:34:00\.000Z: a fill no record placed;.*a real score never leaves one out\)/);
  const report = sh(script('replay.js'), ['report', path.join(runHomeOf(w, 'combine-e2e'), 'replay', 'combine-e2e')], w.env);
  assert.strictEqual(report.code, 0, report.out);
  assert.match(report.out, /continuous combine: 2 attempt\(s\)/);
  assertClean(w, 'combine-e2e', r.out);
});

test('stage 2, accountStates: two curated days, each opening at its drawn balance shown in the prompt; finished and scored', { timeout: 600000 }, () => {
  const w = world();
  // The curated lists: one moment on each of two days, scanned from the bars (scripts/curated-lists.js).
  const env = w.env;
  const scanned = path.join(w.home, 'moments.jsonl');
  const scan = sh(script('curated-lists.js'), ['scan', '--bars', w.bars1m, '--root', 'MNQ', '--from', '2022-04-21', '--to', '2022-04-23', '--use', 'practice', '--out', scanned], env);
  assert.strictEqual(scan.code, 0, scan.out);
  const all = fs.readFileSync(scanned, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  // A moment inside the day's cash session (its bar between 09:40 and 15:00 ET: the run's sessions hold its window).
  const pick = day => all.find(m => m.day === day && m.bar >= `${day}T13:40` && m.bar <= `${day}T19:00`);
  const iso = ms => new Date(ms).toISOString();
  const kept = ['2022-04-21', '2022-04-22'].map(pick).map((m, i) => ({ ...m, list: i ? 'trend-down' : 'trend-up', window: { from: iso(Date.parse(m.bar) - D.STEP), to: iso(Date.parse(m.bar) + 2 * D.STEP) } }));
  assert.strictEqual(kept.length, 2, all.map(m => m.day).join(','));
  fs.writeFileSync(scanned, kept.map(m => `${JSON.stringify(m)}\n`).join(''));
  const out = path.join(w.home, 'lists');
  const built = sh(script('curated-lists.js'), ['build', scanned, '--use', 'practice', '--total', '2', '--mix', 'trend-up=0.5,trend-down=0.5', '--pass-share', 'trend-up=0.5,trend-down=0.5', '--min-skill', '0', '--out', out], env);
  assert.strictEqual(built.code, 0, built.out);
  const listFile = path.join(out, fs.readdirSync(out)[0]);
  // The account states: two draws, a mid state and one near the max loss limit (authored; hashed as readDocument checks).
  const st = (days, dayPnl) => ({ sessionsDone: days.length, balance: ACCOUNT.starting_balance + days.reduce((a, b) => a + b, 0) + dayPnl, peak: ACCOUNT.starting_balance + Math.max(0, ...days), dayPnl, days, tradesToday: 0, lossesToday: 0, lossStreak: 0 });
  const states = [st([400, 300], 0), st([-1100, -900], 0)];
  const counters = { tradesToday: 0, lossesToday: 0, lossStreak: 0 };
  const buckets = states.map(s => AS.practiceBucketOf(AS.drawState(ACCOUNT, s), counters));
  const none = Object.fromEntries(AS.PRACTICE_BUCKETS.map(b => [b, 0]));
  const counts = { ...none };
  for (const b of buckets) counts[b] += 1;
  const body = {
    kind: AS.KIND, v: AS.VERSION, account: ACCOUNT.name, accountDigest: AS.accountDigest(ACCOUNT), gate: gateLimits(env), seed: 1, paths: 1, count: 2, meanBlock: 7, oversample: { fresh: 1, mid: 1, 'near-target': 1, 'near-mll': 3, 'after-losses': 3 },
    population: counts, natural: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, n / 2])), sampled: counts, weights: Object.fromEntries(buckets.map(b => [b, 1])),
    draws: states.map((state, id) => ({ id, bucket: buckets[id], weight: 1, state, facts: combineState.attemptFacts(AS.drawState(ACCOUNT, state), counters) })),
    source: [{ runId: 'prior', role: 'practice-train' }],
  };
  const doc = { ...body, hash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  const file = path.join(w.home, 'account-states.json');
  fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
  const config = replayConfig(w, 'states-e2e', {
    start: '2022-04-21T13:30:00Z', end: '2022-04-23T00:00:00Z', practice: { mode: 'setup-focus', setupTf: 15, quietSample: 0, seed: 1, levels: 'key', reactions: ['rejected', 'broke'] },
    curatedList: { file: listFile, list: 'mix' }, accountStates: { file },
    autotrader: {
      harness: 'opencode', model: '', symbols: ['MNQ'], account: '7', timeframe: 3, lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'data' }],
      sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York',
    },
  });
  const pre = sh(script('training-preflight.js'), ['--config', config, '--bars', `MNQ=${w.bars1m}`], env);
  assert.strictEqual(pre.code, 0, pre.out);
  assert.match(pre.out, /PASS account-states: /);
  assert.match(pre.out, /N\/A +combine: not a continuous combine run/);
  const r = sh(script('replay.js'), ['run', '--config', config, '--bars', `MNQ=${w.bars1m}`], env);
  assert.strictEqual(r.code, 0, r.out);
  const runDir = path.join(runHomeOf(w, 'states-e2e'), 'replay', 'states-e2e');
  const log = AS.readStatesLog(runDir);
  assert.deepStrictEqual(log.filter(x => x.kind === 'start').map(x => x.day), ['2022-04-21', '2022-04-22']);
  const days = recordsOf(w, 'states-e2e');
  for (const s of log.filter(x => x.kind === 'start')) {
    const drawn = doc.draws[s.draw].state;
    assert.strictEqual(s.balance, drawn.balance, s.day);
    // The day's first cycle shows its drawn balance in the attempt line.
    const rec = days[s.day].find(x => x.cycles && x.cycles.length);
    const prompt = JSON.parse(fs.readFileSync(rec.cycles[0].file, 'utf8')).prompt;
    assert.match(prompt, new RegExp(`balance \\$${String(drawn.balance).replace(/(\d)(?=(\d{3})+$)/g, '$1,?')}`), s.day);
    assert.match(prompt, new RegExp(`\\bday ${drawn.sessionsDone + 1}\\b`), s.day);
  }
  assert.match(r.out, /stage 2 \(pass prop\) report:/);
  assert.match(r.out, /practice by account state: 2 day\(s\) from drawn states, 2 ended/);
  assert.match(r.out, /mid: 1 attempt\(s\)/);
  assert.match(r.out, /near-mll: 1 attempt\(s\)/);
  assert.match(r.out, /Prop Monte Carlo, 30-day attempts \(/);
  assertClean(w, 'states-e2e', r.out);
});
