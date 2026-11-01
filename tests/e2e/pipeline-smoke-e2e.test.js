'use strict';

/**
 * The training pipeline's smoke test: every piece the owner's training runs chain, connected once on a tiny curated list,
 * fast (docs/TRAINING.md). No model and no network: the scripted model (tests/fixtures/scripted-model.js) stands in for the
 * harness CLI (tests/fixtures/scripted-opencode.js, `opencode` by name on PATH, so the real opencode head-prompt and no-web
 * checks run) and the mock exchange is the replay broker, serving the parity bars moved by whole weeks into the learning
 * windows (tests/fixtures/preflight.js). Each step asserts a concrete output, so the test fails when one piece disconnects
 * from the next:
 *
 *   1  the curated lists, scanned from the bars with three moments pinned (practice) and two (validate)
 *   2  the training preflight: every check PASS, or N/A where the feature isn't present
 *   3  stage 1, `scripts/replay.js run`: latency charged, the list pinned; the model passes on one moment, composes a trade
 *      on another and takes it out on the third; the order goes through the gate to the broker, and fills
 *   4  the end-of-run stage report: the scorecard, the skill usage and (on a validate run) the exit test, well formed
 *      (INSUFFICIENT is fine on a sample this small)
 *   5  the experience log and the experience index built from the run
 *   6  the 30-day Monte Carlo of the run, a few paths, its first line
 *   7  stage 2, one practice day seeded from an account state: the attempt line reaches the model's prompt (nothing says it
 *      was drawn) and the gate refuses an entry the seeded state blocks
 *
 * Large JSON state is in files, not environment variables (one variable is limited to about 128 KB on Linux); the HOME is a
 * temporary directory.
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
const { loadAccounts } = require('../../scripts/lib/trading/accounts');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { loadPinnedCurated } = require('../../scripts/lib/learning/curated-lists');
const { scoreRun, scoreText, policyFor } = require('../../scripts/lib/prop/model-score');
const AS = require('../../scripts/lib/prop/account-states');
const { gateLimits } = require('../../scripts/lib/prop/attempts');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js');
const STANDIN = path.join(ROOT, 'tests', 'fixtures', 'scripted-opencode.js');
const script = name => path.join(ROOT, 'scripts', name);

// The parity week moved by whole weeks (every bar keeps its New York clock time: daylight time in all three): into
// practice-train (the week of Monday 2022-04-25) and into practice-validate (2024-07-15). The scenario day is the Thursday
// before each Monday: the parity series' 2026-04-23.
const WEEK = 7 * 86400000;
const SERIES = {
  train: { monday: '2022-04-25', use: 'practice', day: '2022-04-21' },
  validate: { monday: '2024-07-15', use: 'validate', day: '2024-07-11' },
};
const shiftOf = monday => Math.round((Date.parse(`${monday}T00:00:00Z`) - PF.PARITY_MONDAY) / WEEK) * WEEK;
const nextDay = day => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

// The moments each list is curated to (decision bars, UTC time of day on the series' day): the model passes the first,
// composes a trade on the second and takes it out on the next bar. Pinned: a scan that finds others fails here.
const MOMENTS = { train: ['16:00', '17:27', '17:54'], validate: ['16:18'] };

/** A command's result: { code, out } (stdout and stderr). */
const sh = (file, args, env) => {
  const r = spawnSync(process.execPath, [file, ...args], { env, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

/** One series of the world: its bars moved into place, the broker's init file (the served 3m and 1m bars), the 1m bars as a file. */
function series(w, name) {
  const s = SERIES[name];
  const shift = shiftOf(s.monday);
  const until = Date.parse(`${s.day}T18:00:00Z`);
  const moved = bars => bars.map(b => ({ ...b, t: new Date(Date.parse(b.t) + shift).toISOString() })).filter(b => Date.parse(b.t) < until);
  const init = path.join(w.home, `exchange-${name}.json`);
  fs.writeFileSync(init, JSON.stringify({ prices: { [D.MNQ_ID]: D.BARS[0].c }, bars: { [D.MNQ_ID]: moved(D.BARS), [`${D.MNQ_ID}@1m`]: moved(D.MINUTE_BARS) } }));
  return { ...s, init, bars1m: PF.writeMinuteBars(path.join(w.home, `MNQ-1m-${name}.csv`), s.monday), bars: MOMENTS[name].map(t => `${s.day}T${t}:00.000Z`) };
}

function world() {
  const home = tmpDir();
  const live = path.join(home, 'live-home');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(live);
  fs.mkdirSync(bin);
  // The replay broker: the mock exchange as a replay server (its clock the driver's clock file), its prices following the bars.
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({
    brokers: { replaymock: { command: [process.execPath, SERVER], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_STATE_DIR', 'MOCK_JOURNAL', 'MOCK_CLOCK_FILE', 'MOCK_REPLAY', 'MOCK_INIT_FILE', 'MOCK_PRICE_FROM_BARS', 'MOCK_BALANCE_SCHEDULE', 'MOCK_MAX_ORDER_SIZE', 'MOCK_MAX_POSITION_SIZE', 'MOCK_MAX_DAILY_LOSS'], limits: { dailyLoss: 'MOCK_MAX_DAILY_LOSS', maxOrderSize: 'MOCK_MAX_ORDER_SIZE', maxPositionSize: 'MOCK_MAX_POSITION_SIZE' } } },
  }));
  // The harness CLI by name: the scripted model, playing the script file.
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\nexec "${process.execPath}" "${STANDIN}" "$@"\n`, { mode: 0o755 });
  const w = { home, live, model: path.join(home, 'model-script.json') };
  fs.writeFileSync(w.model, JSON.stringify({ bars: {} }));
  w.series = { train: series(w, 'train'), validate: series(w, 'validate') };
  w.env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, FTH_HOME: live, NODE_ENV: 'test',
    MOCK_REPLAY: '1', MOCK_PRICE_FROM_BARS: '1', MOCK_INIT_FILE: w.series.train.init, SMOKE_MODEL_SCRIPT: w.model,
    FTH_ENTRY_HOURS: '', FTH_NO_ENTRY_WINDOWS: '', FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'),
  };
  return w;
}

/**
 * Step 1: scan the series' day for setup moments (scripts/curated-lists.js), keep the pinned ones, build the lists. A tiny
 * list is curated by hand where the scan can't give it what the preflight asks of a list: five days of bars have no clear
 * trend, so the moments are labelled by side (a long one trend-up, a short one trend-down, the middle one chop), and each
 * window is cut to a few bars around its decision (the scan's is an hour), which is what keeps the run fast.
 */
function curate(w, s, name) {
  const env = { ...w.env, MOCK_INIT_FILE: s.init };
  const file = path.join(w.home, `moments-${name}.jsonl`);
  const scan = sh(script('curated-lists.js'), ['scan', '--bars', s.bars1m, '--root', 'MNQ', '--from', s.day, '--to', nextDay(s.day), '--use', s.use, '--out', file], env);
  assert.strictEqual(scan.code, 0, scan.out);
  const label = { long: 'trend-up', short: 'trend-down' };
  const iso = ms => new Date(ms).toISOString();
  const found = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(m => s.bars.includes(m.bar)).map((m, i) => ({
    ...m, list: i === 1 && s.bars.length === 3 ? 'chop' : label[m.side],
    window: { from: iso(Date.parse(m.bar) - D.STEP), to: iso(Date.parse(m.bar) + 3 * D.STEP) },
  }));
  assert.deepStrictEqual(found.map(m => m.bar), s.bars, 'the pinned moments are still on the scan');
  // One moment (the validate list) stands on both trend lists, which the preflight asks of a list: twice, with another id.
  const kept = found.length === 1 ? [{ ...found[0], list: 'trend-up' }, { ...found[0], id: `${found[0].id}-twin`, list: 'trend-down' }] : found;
  fs.writeFileSync(file, kept.map(m => `${JSON.stringify(m)}\n`).join(''));
  const out = path.join(w.home, `lists-${name}`);
  const mix = kept.length === 3 ? 'trend-up=0.34,trend-down=0.33,chop=0.33' : 'trend-up=0.5,trend-down=0.5';
  const built = sh(script('curated-lists.js'), ['build', file, '--use', s.use, '--total', String(kept.length), '--mix', mix, '--pass-share', 'trend-up=0.5,trend-down=0.5,chop=0.5', '--min-skill', '0', '--out', out], env);
  assert.strictEqual(built.code, 0, built.out);
  const listFile = path.join(out, fs.readdirSync(out)[0]);
  return { file: listFile, doc: JSON.parse(fs.readFileSync(listFile, 'utf8')), moments: kept };
}

/** A practice replay's config (docs/TRAINING.md sections 4 and 5): the series' day, the trader's runner config with its 1m data lane. */
function replayConfig(w, runId, s, over = {}) {
  const file = path.join(w.home, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    runId, workDir: path.join(w.home, 'replays'), broker: 'replaymock', stage: 1,
    start: `${s.day}T13:30:00Z`, end: `${nextDay(s.day)}T00:00:00Z`, premarket: false,
    practice: { mode: 'setup-focus', setupTf: 15, quietSample: 0, seed: 1, levels: 'key', reactions: ['rejected', 'broke'] },
    autotrader: {
      harness: 'opencode', model: '', symbols: ['MNQ'], account: '7', timeframe: 3, lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'data' }],
      sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York',
    },
    brokerEnv: { clockFile: 'MOCK_CLOCK_FILE', stateDir: 'MOCK_STATE_DIR', runId: null, start: null, end: null, balanceSchedule: 'MOCK_BALANCE_SCHEDULE' },
    ...over,
  }));
  return file;
}

/** The scripted model's script file: bar open time -> step (scripted-opencode.js); a bar with none is quiet. */
const playScript = (w, bars) => fs.writeFileSync(w.model, JSON.stringify({ bars }));

/** The composed scenario of a curated moment: one true read of each step, as the scan stored them. */
// The entry read is optional (the setup is the entry): a moment stored without one composes without one.
const scenarioOf = m => ({ side: m.side, skill: 'rejection', reads: ['bias', 'location', 'setup', 'entry', 'stop', 'target'].flatMap(step => { const x = m.reads.find(r => r.step === step && r.agrees); return x ? [[step, x.skill, x.read]] : []; }) });

/** `replay.js run` or `training-preflight.js` on a config: the run's bars given, as its facts check reads them. */
const withBars = (s, flags = []) => ['--bars', `MNQ=${s.bars1m}`, ...flags];

/** The bar a decision record decided: it closed 2 s before the decision time. */
const barOf = r => new Date(Date.parse(r.t) - 2000 - D.STEP).toISOString();

/** The run's decision records (the store's day files) and the lines of its refusals. */
const recordsOf = (w, runId, day) => readRun(path.join(w.home, 'replays', runId, 'replay', runId)).days[day];

test('pipeline smoke: curated lists, preflight, stage 1, its report, experience, Monte Carlo and a stage 2 day connect', { timeout: 240000 }, async t => {
  const t0 = Date.now();
  const w = world();
  const train = w.series.train;
  const valid = w.series.validate;
  const lists = {};
  const out = {};
  const stage = { n: 0 };
  const step = (name, fn) => t.test(`${++stage.n} ${name}`, fn);

  await step('the curated lists: the pinned moments, fingerprinted', () => {
    lists.train = curate(w, train, 'train');
    lists.validate = curate(w, valid, 'validate');
    for (const k of ['train', 'validate']) {
      assert.match(lists[k].doc.fingerprint, /^[0-9a-f]{16,}$/);
      assert.deepStrictEqual([...new Set(Object.values(lists[k].doc.lists).flat().map(m => m.bar))].sort(), w.series[k].bars);
      assert.strictEqual(lists[k].doc.mix.length, k === 'train' ? 3 : 2);
      assert.strictEqual(lists[k].doc.use, SERIES[k].use);
    }
  });

  await step('the training preflight: every check passes (N/A only where the feature is absent), the opencode checks among them', () => {
    out.config = replayConfig(w, 'smoke-s1', train, { curatedList: { file: lists.train.file, list: 'mix' } });
    const r = sh(script('training-preflight.js'), ['--config', out.config, ...withBars(train)], w.env);
    assert.strictEqual(r.code, 0, r.out);
    const lines = r.out.split('\n').filter(l => /^(PASS|FAIL|WARN|N\/A) /.test(l));
    assert.ok(lines.length >= 20, r.out);
    assert.deepStrictEqual(lines.filter(l => !/^(PASS|N\/A) /.test(l)), [], r.out);
    for (const check of ['head-prompt', 'head-composed-reads', 'no-web-in-replay', 'facts', 'curated-list', 'curated-source', 'latency', 'practice-mode', 'split-window']) {
      assert.ok(lines.some(l => l.startsWith(`PASS ${check}:`)), `${check}\n${r.out}`);
    }
    assert.match(lines.find(l => l.startsWith('PASS no-web-in-replay')), /opencode: no agent may search or fetch the web/);
    assert.match(r.out, /training preflight passed/);
  });

  const [passed, composed] = lists.train ? lists.train.moments : [];
  // The exit: the bar after the composed moment, inside its window (the setup is the entry since CONF3M, so the trade
  // goes in on the moment's own bar and a later moment can find it already out).
  const leaving = composed ? { bar: new Date(Date.parse(composed.bar) + D.STEP).toISOString() } : null;
  await step('stage 1 (practice-train): latency charged, the list pinned; a pass, a composed trade through the gate to the broker, its exit', () => {
    playScript(w, {
      [passed.bar]: { do: 'pass', why: 'the rejection has no room' },
      [composed.bar]: { do: 'compose', scenario: scenarioOf(composed), size: 1 },
      [leaving.bar]: { do: 'exit', side: composed.side },
    });
    out.s1 = sh(script('replay.js'), ['run', '--config', out.config, ...withBars(train)], w.env);
    assert.strictEqual(out.s1.code, 0, out.s1.out);
    assert.match(out.s1.out, /new run smoke-s1 .*learning: practice-train/);
    const home = path.join(w.home, 'replays', 'smoke-s1');
    // The list is pinned in the run home, and latency was charged (the preflight line, and the run's record of it).
    assert.strictEqual(loadPinnedCurated(home).fingerprint, lists.train.doc.fingerprint);
    assert.match(out.s1.out, /preflight PASS latency: charged/);
    const recs = recordsOf(w, 'smoke-s1', train.day);
    const result = bar => recs.find(r => barOf(r) === bar).ran;
    assert.match(result(passed.bar)[0].result, /^CYCLE RESULT: no-trade - the rejection has no room/);
    assert.match(result(composed.bar)[0].result, new RegExp(`^CYCLE RESULT: executed - trade_lifecycle ${composed.side} MNQ 1`));
    assert.match(result(leaving.bar)[0].result, /^CYCLE RESULT: managed - out/);
    // The order reached the broker through the gate (nothing refused), and the position went in and out: two fills.
    assert.deepStrictEqual(recs.flatMap(r => r.refusals), []);
    const fills = recs.flatMap(r => r.trades);
    assert.deepStrictEqual(fills.map(f => f.size), [1, 1], JSON.stringify(fills));
    const broker = JSON.parse(fs.readFileSync(path.join(home, 'replay', 'smoke-s1', 'broker', 'state.json'), 'utf8'));
    assert.strictEqual(broker.calls.filter(c => c.tool === 'place_order').length, 2);
  });

  await step('the end-of-run stage report: the scorecard and the skill usage, well formed', () => {
    assert.match(out.s1.out, /stage 1 \(learn to trade\) report:/);
    assert.match(out.s1.out, /skill usage: 1 decision points \(1 compose records, 1 ok\); 6 skills claimed; reads wrong 0 of 6/);
    assert.match(out.s1.out, /scorecard: \d+ decisions, \d+ agree, \d+ disagree, \d+ unchecked \(agreement [\d.]+\)/);
    assert.match(out.s1.out, /R by setup:/);
  });

  await step('the validate run: the exit test lines, well formed (insufficient is fine)', () => {
    playScript(w, {});
    const config = replayConfig(w, 'smoke-v1', valid, { curatedList: { file: lists.validate.file, list: 'mix' } });
    const r = sh(script('replay.js'), ['run', '--config', config, '--validate', '--candidate', 'smoke-v', ...withBars(valid)], { ...w.env, MOCK_INIT_FILE: valid.init });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /learning: practice-validate/);
    const report = r.out.split('\n').filter(l => /^\[replay\] /.test(l)).map(l => l.slice(9));
    const at = report.findIndex(l => /exit test/i.test(l));
    assert.ok(at >= 0, r.out.slice(-3000));
    const lines = report.slice(at);
    // Each criterion: its test, a status (PASS, FAIL, SANITY or insufficient/N/A) and its value.
    for (const name of ['planned-rr', 'avg-winner', 'expectancy', 'correct-reads', 'process-adherence']) {
      assert.ok(lines.some(l => l.includes(name)), `${name}\n${lines.join('\n')}`);
    }
    assert.ok(lines.some(l => /insufficient|INSUFFICIENT|N\/A|FAIL/.test(l)), lines.join('\n'));
  });

  await step('the experience log and the experience index built from the run', () => {
    const home = path.join(w.home, 'replays', 'smoke-s1');
    assert.match(out.s1.out, /experience: \d+ decision\(s\) added, 0 already logged \(practice-train\)/);
    const log = fs.readFileSync(path.join(home, 'experience', 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(log.length > 0 && log.some(d => d.decision === 'entered'), JSON.stringify([...new Set(log.map(d => d.decision))]));
    const built = sh(script('experience-index.js'), ['build', home, '--seed', '1'], w.env);
    assert.strictEqual(built.code, 0, built.out);
    const dir = path.join(w.live, 'experience');
    const file = fs.readdirSync(dir).filter(f => /^index-.*\.json$/.test(f))[0];
    assert.ok(file, built.out);
    const shown = sh(script('experience-index.js'), ['show', path.join(dir, file)], w.env);
    assert.strictEqual(shown.code, 0, shown.out);
    assert.match(shown.out, new RegExp(`^index [0-9a-f]+: ${log.filter(d => d.decision !== 'none').length} decisions, ${train.day} to ${train.day}`));
  });

  await step('the 30-day Monte Carlo of the run: a few paths, its first line', () => {
    const strategies = loadStrategies(ROOT, w.env).strategies;
    const policy = strategies.find(s => s.name === 'prop_portfolio');
    const account = loadAccounts(ROOT, w.env).accounts.find(a => a.name === policy.account);
    const result = scoreRun(path.join(w.home, 'replays', 'smoke-s1', 'replay', 'smoke-s1'), { root: ROOT, env: w.env, account, policy: policyFor(strategies, account.name), paths: 15, reps: 15, riskActions: false });
    const first = scoreText(result).split('\n').find(l => /Prop Monte Carlo/.test(l));
    assert.match(first, new RegExp(`Prop Monte Carlo, 30-day attempts \\(${account.name}, prop_portfolio's rulebook\\)`));
    out.account = account;
  });

  await step('stage 2: one day seeded from an account state; its attempt line reaches the prompt; the gate refuses what the state blocks', () => {
    const account = out.account;
    // A tiny states document, authored: one state, three losing days and a loss today, $60 above the max loss limit's floor,
    // which one contract's stop risk exceeds; the natural mix is that state's bucket alone, so the one day samples every
    // bucket there is. (Its hash is recomputed over the body, as readDocument checks it.)
    const days = [-800, -700, -600];
    const dayPnl = -840;
    const state = { sessionsDone: 3, balance: account.starting_balance - 2100 + dayPnl, peak: account.starting_balance, dayPnl, days, tradesToday: 1, lossesToday: 1, lossStreak: 1 };
    const counters = { tradesToday: 1, lossesToday: 1, lossStreak: 1 };
    const combine = require('../../scripts/lib/trading/combine');
    const bucket = AS.practiceBucketOf(AS.drawState(account, state), counters);
    assert.strictEqual(bucket, 'near-mll');
    const none = Object.fromEntries(AS.PRACTICE_BUCKETS.map(b => [b, 0]));
    const one = { ...none, [bucket]: 1 };
    const body = {
      kind: AS.KIND, v: AS.VERSION, account: account.name, accountDigest: AS.accountDigest(account), gate: gateLimits(w.env), seed: 1, paths: 1, count: 1, meanBlock: 7, oversample: { fresh: 1, mid: 1, 'near-target': 1, 'near-mll': 3, 'after-losses': 3 },
      population: one, natural: one, sampled: one, weights: { [bucket]: 1 },
      draws: [{ id: 0, bucket, weight: 1, state, facts: combine.attemptFacts(AS.drawState(account, state), counters) }],
      source: [{ runId: 'smoke-s1', role: 'practice-train' }],
    };
    const doc = { ...body, hash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') };
    const file = path.join(w.home, 'account-states.json');
    fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
    assert.strictEqual(AS.readDocument(file).hash, doc.hash);
    // The entry the model composes on the middle moment, naming the policy that trades the account, sized as the first would be.
    playScript(w, { [composed.bar]: { do: 'compose', scenario: scenarioOf(composed), size: 1, policy: 'prop_portfolio', rationale: `setup:prop_portfolio ${composed.side}, composed from its reads`, result: 'CYCLE RESULT: blocked - the order gate refused the entry' } });
    const config = replayConfig(w, 'smoke-s2', train, { stage: 2, curatedList: { file: lists.train.file, list: 'chop' }, accountStates: { file } });
    const pre = sh(script('training-preflight.js'), ['--config', config, ...withBars(train)], w.env);
    assert.strictEqual(pre.code, 0, pre.out);
    assert.match(pre.out, /PASS account-states: /);
    assert.match(pre.out, /PASS account-facts: /);
    const r = sh(script('replay.js'), ['run', '--config', config, ...withBars(train)], w.env);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /the attempt starts the day at its drawn state/);
    const recs = recordsOf(w, 'smoke-s2', train.day);
    const entry = recs.find(x => barOf(x) === composed.bar);
    const cycle = JSON.parse(fs.readFileSync(entry.cycles[0].file, 'utf8'));
    // The seeded attempt line, as the runner words it, with the state's numbers and nothing that says it was drawn.
    assert.match(cycle.prompt, new RegExp(`${account.name} attempt \\(active\\)`));
    assert.match(cycle.prompt, new RegExp(`balance \\$${String(state.balance).replace(/(\d)(?=\d{3}$)/, '$1,?')}`));
    assert.match(cycle.prompt, /cushion \$60,/);
    assert.match(cycle.prompt, /day 4/);
    assert.match(cycle.prompt, /today 1 trade, 1 loss, losing streak 1/);
    assert.doesNotMatch(cycle.prompt, /\b(drawn|draws?|sampl\w*|bucket\w*|seed\w*)\b/i);
    // The gate refused the entry, on the account's budget, and nothing reached the broker.
    assert.ok(entry.refusals.length >= 1 && entry.refusals.every(x => x.tool === 'place_order'), JSON.stringify(entry.refusals));
    const refused = fs.readFileSync(path.join(w.home, 'replays', 'smoke-s2', 'logs', 'gate-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.tool === 'place_order');
    assert.deepStrictEqual(refused.map(e => e.decision), ['blocked']);
    const budget = refused[0].violations.find(v => v.check === 'combine');
    assert.match(budget.message, new RegExp(`^${account.name}: 1 MNQ is not within the account's .*size budget for a \\d+-tick stop`));
    const broker = JSON.parse(fs.readFileSync(path.join(w.home, 'replays', 'smoke-s2', 'replay', 'smoke-s2', 'broker', 'state.json'), 'utf8'));
    assert.strictEqual(broker.calls.filter(c => c.tool === 'place_order').length, 0);
  });

  console.log(`pipeline smoke: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
});
