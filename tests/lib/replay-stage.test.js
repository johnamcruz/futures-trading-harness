'use strict';

// Training stages (scripts/lib/replay/stage.js): the presets' defaults and refusals, `stage` in both run hashes, the
// stage-1 exit test (owner-confirmed thresholds, a minimum sample before any PASS), R by setup, and the end-of-run
// report of each stage.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../scripts/lib/replay/stage');
const { resolveReplay, setupHash, configHash } = require('../../scripts/lib/replay/config');
const { MIN_N, MIN_DAYS } = require('../../scripts/lib/learning/experience-index');
const PF = require('../fixtures/preflight');

const ROOT = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-stage-'));

test('the exit test thresholds: the owner-confirmed values, in one place, with the index\'s minimum sample', () => {
  assert.deepStrictEqual({ ...S.EXIT_TEST }, { plannedRR: 2, avgWinnerR: 1.8, expectancyR: 0.3, expectancyLoAbove: 0, correctReadRate: 0.8, processAdherence: 0.8, minN: MIN_N, minDays: MIN_DAYS });
  assert.ok(Object.isFrozen(S.EXIT_TEST));
});

test('applyStage: the preset\'s defaults under the config\'s own values; a contradiction is refused, never overridden', () => {
  assert.deepStrictEqual(S.applyStage({ runId: 'a' }), { raw: { runId: 'a' }, stage: null, errors: [] });
  const one = S.applyStage({ stage: 1 });
  assert.deepStrictEqual([one.stage, one.raw.latency, one.raw.libraryDisplay, one.errors], [1, true, false, []]);
  assert.deepStrictEqual(S.applyStage({ stage: 1, latency: true, libraryDisplay: false, learning: true }).errors, [], 'agreeing values are fine');
  for (const [over, why] of [[{ learning: false }, /learning: false contradicts stage 1/], [{ latency: false }, /latency: false contradicts/], [{ libraryDisplay: true }, /libraryDisplay: true contradicts/], [{ prop: 'acct' }, /prop: "acct" contradicts stage 1 .*account states are stage 2's/]]) {
    const r = S.applyStage({ stage: 1, ...over });
    assert.strictEqual(r.errors.length, 1, JSON.stringify(over));
    assert.match(r.errors[0], why);
  }
  assert.deepStrictEqual(S.applyStage({ stage: 2, prop: 'acct' }).errors, [], 'stage 2 takes a prop account');
  assert.match(S.applyStage({ stage: 2, learning: false }).errors[0], /contradicts stage 2/);
  for (const bad of [3, 0, '1', true]) assert.match(S.applyStage({ stage: bad }).errors[0], /stage: 1 \(learn to trade\) or 2 \(pass prop\)/);
});

function raw(over = {}) {
  const user = tmp();
  return { user, raw: { runId: 'a', workDir: path.join(user, 'replays'), broker: 'replaymock', start: '2022-03-07T14:30:00Z', end: '2022-03-07T15:00:00Z', premarket: false, autotrader: PF.AUTOTRADER, practice: PF.PRACTICE, ...over } };
}
const env = user => ({ PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'live') });

test('resolveReplay: stage is kept, refused when contradicted, and part of both hashes (absent: the hash it had)', () => {
  const a = raw();
  fs.mkdirSync(path.join(a.user, 'live'));
  fs.writeFileSync(path.join(a.user, 'live', 'brokers.json'), JSON.stringify({ brokers: { replaymock: { command: ['true'], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_JOURNAL'] } } }));
  const res = over => resolveReplay({ ...a.raw, ...over }, { baseDir: a.user, env: env(a.user), root: ROOT });
  assert.strictEqual(res({}).stage, null);
  assert.strictEqual(res({ stage: 1 }).stage, 1);
  assert.throws(() => res({ stage: 1, learning: false }), /invalid replay config:\n- learning: false contradicts stage 1/);
  assert.throws(() => res({ stage: 7 }), /stage: 1 \(learn to trade\) or 2/);
  const none = res({});
  const one = res({ stage: 1 });
  const two = res({ stage: 2 });
  assert.notStrictEqual(setupHash(none), setupHash(one));
  assert.notStrictEqual(setupHash(one), setupHash(two));
  // configHash reads the run home's brokers.json (FTH_BROKERS_FILE), as a seeded run's.
  fs.mkdirSync(none.paths.runHome, { recursive: true });
  fs.copyFileSync(path.join(a.user, 'live', 'brokers.json'), path.join(none.paths.runHome, 'brokers.json'));
  assert.notStrictEqual(configHash(none, env(a.user)), configHash(one, env(a.user)));
  assert.notStrictEqual(configHash(one, env(a.user)), configHash(two, env(a.user)));
  assert.strictEqual(setupHash(none), setupHash({ ...one, stage: null }), 'no stage: the body it had');
});

const entry = (day, R, rr = 2.5, skill = 'bias:daily-bias+setup:rejection+entry:candle-reading') => ({ decision: 'entered', settledDay: day, day, plan: { rr }, outcome: { R }, signatures: { skill }, context: { regime: 'trend' } });
/** n entries over `days` days: 3 winners of 2R for each loser of -1R (mean 1.25R, winners 2R). */
function sample(n = 40, days = 20) {
  return Array.from({ length: n }, (_x, i) => entry(`2024-08-${String(1 + (i % days)).padStart(2, '0')}`, i % 4 === 3 ? -1 : 2));
}
const measures = (reads, verified) => ({ reads: { reads, verified } });
const agreement = (agree, disagree) => ({ decisions: agree + disagree, agree, disagree, unchecked: 0, rate: agree / (agree + disagree) });
const status = list => Object.fromEntries(list.map(x => [x.test, x.status]));

test('exitTest: PASS on a good sample; each threshold fails on its own; under the minimum sample: insufficient, never PASS', () => {
  const good = { decisions: sample(), measures: measures(100, 90), adherence: agreement(45, 5) };
  assert.deepStrictEqual(status(S.exitTest(good)), { 'planned-rr': 'PASS', 'avg-winner': 'PASS', expectancy: 'PASS', 'correct-reads': 'PASS', 'process-adherence': 'PASS' });
  const exp = S.exitTest(good).find(x => x.test === 'expectancy');
  assert.match(exp.detail, /1\.25R per entry, 90% day-bootstrap interval/);
  // planned R:R: one entry under 2R (or without one) fails.
  const under = sample();
  under[5] = entry('2024-08-06', 2, 1.9);
  assert.strictEqual(status(S.exitTest({ ...good, decisions: under }))['planned-rr'], 'FAIL');
  under[5] = { ...entry('2024-08-06', 2), plan: {} };
  assert.strictEqual(status(S.exitTest({ ...good, decisions: under }))['planned-rr'], 'FAIL', 'no planned R:R: fails closed');
  // Average winner under 1.8R.
  const small = sample().map(d => (d.outcome.R > 0 ? { ...d, outcome: { R: 1.7 } } : d));
  assert.strictEqual(status(S.exitTest({ ...good, decisions: small }))['avg-winner'], 'FAIL');
  // Expectancy: a mean under 0.3R, and a mean above it whose interval reaches 0.
  const flat = sample().map((d, i) => ({ ...d, outcome: { R: i % 2 ? 2 : -1.6 } }));
  assert.strictEqual(status(S.exitTest({ ...good, decisions: flat })).expectancy, 'FAIL');
  // A mean of 0.3R from two big days among eighteen losing ones: its interval's lower bound is under 0.
  const wide = Array.from({ length: 40 }, (_x, i) => entry(`2024-08-${String(1 + (i % 20)).padStart(2, '0')}`, i % 20 < 2 ? 12 : -1));
  const w = S.exitTest({ ...good, decisions: wide }).find(x => x.test === 'expectancy');
  assert.match(w.detail, /^0\.30R per entry, 90% day-bootstrap interval -/);
  assert.strictEqual(w.status, 'FAIL', 'the lower bound must be above 0');
  // Reads and adherence under 0.8.
  assert.strictEqual(status(S.exitTest({ ...good, measures: measures(100, 79) }))['correct-reads'], 'FAIL');
  assert.strictEqual(status(S.exitTest({ ...good, adherence: agreement(39, 11) }))['process-adherence'], 'FAIL');
  // Under the minimum sample: insufficient (n), never PASS.
  const few = S.exitTest({ decisions: sample(MIN_N - 1, 15), measures: measures(MIN_N - 1, MIN_N - 1), adherence: agreement(MIN_N - 1, 0) });
  for (const x of few) {
    assert.strictEqual(x.status, 'INSUFFICIENT', x.test);
    assert.match(x.detail, /insufficient sample \(\d+/);
  }
  // Enough entries but too few days: the expectancy's interval needs MIN_DAYS.
  assert.strictEqual(status(S.exitTest({ ...good, decisions: sample(40, MIN_DAYS - 1) })).expectancy, 'INSUFFICIENT');
  // No composed scorecard: process adherence N/A (not a PASS).
  assert.strictEqual(status(S.exitTest({ ...good, adherence: { unavailable: 'needs fix/scorecard-composed' } }))['process-adherence'], 'N/A');
});

test('rBySetup: composed decisions with an R, by their setup step\'s skills', () => {
  const ds = [entry('2024-08-01', 2), entry('2024-08-02', -1), { ...entry('2024-08-02', 1, 2, 'bias:x+setup:breakout'), decision: 'passed' }, { decision: 'none' }, { ...entry('2024-08-03', null) }];
  assert.deepStrictEqual(S.rBySetup(ds), [{ setup: 'rejection', n: 2, entered: 2, meanR: 0.5 }, { setup: 'breakout', n: 1, entered: 0, meanR: 1 }]);
});

/** A stage report's readers: a finished run's log, measures, scorecard and role, and the merged features. */
function read({ role = 'practice-validate', decisions = sample(), features = {}, statesLog = [] } = {}) {
  return {
    learning: () => ({ decisions }),
    measures: () => measures(100, 95),
    adherence: () => agreement(45, 5),
    role: () => role,
    features: () => ({ skillUsage: false, scorecardComposed: true, monteCarlo: false, ...features }),
    statesLog: () => statesLog,
  };
}

test('stageReport: stage 1 prints skill usage (N/A until merged), the scorecard, R by setup; the exit test on validate only', () => {
  assert.deepStrictEqual(S.stageReport({ stage: null }, {}), []);
  const v = S.stageReport({ stage: 1 }, { read: read() }).join('\n');
  assert.match(v, /^stage 1 \(learn to trade\) report:/);
  assert.match(v, /skill usage: N\/A \(needs feat\/skill-usage\)/);
  // Merged: the run's real report (skillUsageFor), its text; no records and a refused read are said, never N/A.
  const withUsage = skillUsage => S.stageReport({ stage: 1 }, { read: { ...read({ features: { skillUsage: true } }), skillUsage } }).join('\n');
  assert.match(withUsage(() => null), /skill usage: no compose records in the run/);
  assert.match(withUsage(() => ({ error: 'bad ledger' })), /skill usage: not read \(bad ledger\)/);
  assert.match(withUsage(() => { throw new Error('boom\nmore'); }), /skill usage: not read \(boom\)/);
  assert.match(withUsage(() => require('../../scripts/lib/learning/skill-usage').skillUsage({})), /^stage 1[^]*skill/mi);
  assert.match(v, /scorecard: 50 decisions, 45 agree, 5 disagree/);
  assert.match(v, /R by setup:\n {2}rejection: 40 decision\(s\), 40 entered, mean 1\.25R/);
  assert.match(v, /stage-1 exit test: PASS\n {2}PASS planned-rr/);
  const p = S.stageReport({ stage: 1 }, { read: read({ role: 'practice-train' }) }).join('\n');
  assert.doesNotMatch(p, /exit test/);
  // Under the minimum sample the exit test can't pass.
  assert.match(S.stageReport({ stage: 1 }, { read: read({ decisions: sample(5, 5) }) }).join('\n'), /stage-1 exit test: FAIL\n {2}INSUFFICIENT planned-rr: insufficient sample \(5/);
  // Without a composed scorecard, process adherence is N/A and the exit test doesn't pass.
  assert.match(S.stageReport({ stage: 1 }, { read: read({ features: { scorecardComposed: false } }) }).join('\n'), /stage-1 exit test: FAIL[^]*N\/A process-adherence: needs fix\/scorecard-composed/);
  // A scorecard that can't be scored is said, not thrown.
  const broken = { ...read(), adherence: () => { throw new Error('look refused'); } };
  assert.match(S.stageReport({ stage: 1 }, { read: broken }).join('\n'), /scorecard: not scored \(look refused\)/);
});

test('stageReport: stage 2 adds the 30-day Monte Carlo, and the promotion gate on validate (N/A until merged); a reader that throws is said', () => {
  const v = S.stageReport({ stage: 2 }, { read: read() }).join('\n');
  assert.match(v, /^stage 2 \(pass prop\) report:/);
  assert.match(v, /30-day Monte Carlo by account state: N\/A \(phase 2, needs feat\/prop-mc-model\)/);
  assert.match(v, /promotion gate \(prop\/promotion.js\): N\/A/);
  assert.doesNotMatch(v, /stage-1 exit test/);
  assert.doesNotMatch(S.stageReport({ stage: 2 }, { read: read({ role: 'practice-train' }) }).join('\n'), /promotion gate/);
  assert.match(v, /practice by account state: no day started from a drawn state/);
  assert.match(S.stageReport({ stage: 2 }, { read: read({ features: { monteCarlo: true } }) }).join('\n'), /30-day Monte Carlo by account state: see the prop report\npromotion gate: see the prop report/);
  const bad = { ...read(), learning: () => { throw new Error('unreadable log'); } };
  assert.deepStrictEqual(S.stageReport({ stage: 1 }, { read: bad }), ['stage 1 report not written: unreadable log']);
});

test('stageReport: stage 2 prints the practice by account state, each attempt\'s end as practised and reweighted to the natural mix', () => {
  // Three near-mll days (oversampled: weight 1/3), one blown; one mid day (weight 3), not blown. As practised: 1 of 4
  // blown (25%); reweighted: (1/3) / (3 x 1/3 + 3) = 1/12 (8.3%), the natural mix's.
  const day = (d, bucket, weight, outcome, balance, end) => [
    { kind: 'start', day: d, draw: d, bucket, weight, balance },
    { kind: 'end', day: d, draw: d, bucket, weight, end: { balance: end, outcome } },
  ];
  const log = [...day('2022-01-03', 'near-mll', 1 / 3, 'blown', 48700, 48000), ...day('2022-01-04', 'near-mll', 1 / 3, 'open', 48700, 48800),
    ...day('2022-01-05', 'near-mll', 1 / 3, 'open', 48700, 48600), ...day('2022-01-06', 'mid', 3, 'target', 50500, 51000)];
  const v = S.stageReport({ stage: 2 }, { read: read({ role: 'practice-train', statesLog: log }) }).join('\n');
  assert.match(v, /practice by account state: 4 day\(s\) from drawn states, 4 ended/);
  assert.match(v, / {2}all: 4 attempt\(s\); blown 25\.0% as practised, 8\.3% reweighted; stopped for the day 0\.0% as practised, 0\.0% reweighted; at the target 25\.0% as practised, 75\.0% reweighted/);
  assert.match(v, / {2}near-mll: 3 attempt\(s\); blown 33\.3% as practised, 33\.3% reweighted/);
});

test('stageRequirements: what the preflight checks for each preset', () => {
  assert.deepStrictEqual(S.stageRequirements(1), { roles: ['practice-train', 'practice-validate'], curatedOn: 'practice-train', latency: true, libraryDisplay: false, prop: 'none', accountStates: 'none', phase2: false });
  assert.strictEqual(S.stageRequirements(2).prop, 'allowed');
  assert.strictEqual(S.stageRequirements(2).accountStates, 'practice-train');
  assert.strictEqual(S.stageRequirements(2).phase2, false);
  assert.strictEqual(S.stageRequirements(3), null);
});

test('scripts/replay.js: the preflight before the learning gate, recorded after seeding; the stage report once the run is done', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'replay.js'), 'utf8');
  const at = s => src.indexOf(s);
  assert.ok(at('preflightForRun(r, gate') > 0 && at('preflightForRun(r, gate') < at('checkLearningRun(gate)'), 'the preflight before the gate');
  assert.ok(at('pre.record(r.paths.runHome)') > at('seedRunHome('), 'recorded after seeding');
  assert.ok(at('stageReport(r') > at('if (res.done) {'), 'the stage report once the run is done');
});

test('scripts/replay.js run: a finished stage-1 validate run prints its stage report and its exit test', { timeout: 240000 }, () => {
  const { spawnSync } = require('child_process');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const user = tmp();
  const live = path.join(user, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { replaymock: { command: [process.execPath, path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js')], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_STATE_DIR', 'MOCK_JOURNAL', 'MOCK_CLOCK_FILE', 'MOCK_REPLAY', 'MOCK_INIT_FILE'] } } }));
  // The parity week moved onto Monday 2024-08-05 (practice-validate), served by the mock exchange at 3m and 1m, and given
  // to the preflight as one-minute bars.
  const minute = PF.writeMinuteBars(path.join(user, 'MNQ-1m.csv'), '2024-08-05');
  const one = readBarsArg(minute).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const shift = Math.round((Date.parse('2024-08-05T00:00:00Z') - PF.PARITY_MONDAY) / (7 * 864e5)) * 7 * 864e5;
  const three = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv')).map(b => ({ t: new Date(Date.parse(b.t) + shift).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  const ID = 'fake:MNQ:Z26';
  const init = { nowMs: Date.parse('2024-08-05T13:00:00Z'), prices: { [ID]: three.at(-1).c }, bars: { [ID]: three, [`${ID}@1m`]: one } };
  const config = path.join(user, 'replay.json');
  fs.writeFileSync(config, JSON.stringify({
    runId: 's1', workDir: path.join(user, 'replays'), broker: 'replaymock', stage: 1, start: '2024-08-05T13:31:00Z', end: '2024-08-05T13:37:00Z', premarket: false,
    autotrader: { ...PF.AUTOTRADER, command: [process.execPath, '-e', "process.stdout.write('CYCLE RESULT: no-trade - quiet\\n')", '{prompt}'], sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York' },
    brokerEnv: { clockFile: 'MOCK_CLOCK_FILE', stateDir: 'MOCK_STATE_DIR', runId: null, start: null, end: null },
  }));
  // The state goes by file: it is over 500 KB, and one env string past ~128 KB fails to spawn on Linux (E2BIG, status null).
  const initFile = path.join(user, 'init.json');
  fs.writeFileSync(initFile, JSON.stringify(init));
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: live, MOCK_REPLAY: '1', MOCK_INIT_FILE: initFile };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'replay.js'), 'run', '--config', config, '--validate', '--bars', `MNQ=${minute}`], { encoding: 'utf8', env, timeout: 220000 });
  assert.strictEqual(r.error, undefined, String(r.error));
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /preflight PASS stage: stage 1 on practice-validate/);
  assert.match(r.stdout, /\[replay\] done: /);
  assert.match(r.stdout, /\[replay\] stage 1 \(learn to trade\) report:\n/);
  assert.match(r.stdout, /\[replay\] stage-1 exit test: FAIL\n\[replay\] {3}INSUFFICIENT planned-rr: insufficient sample \(0; at least 20\)/);
});
