'use strict';

/**
 * Stage 2's two modes end to end (docs/TRAINING.md section 5), each one a learning replay through `scripts/replay.js run`:
 * the training preflight, the real driver, the live runner, the order gate and the replay broker (the mock exchange as a
 * replay server, its P&L scripted: tests/fixtures/mock-exchange.js scriptedFills), with the scripted model as the harness
 * CLI (tests/fixtures/scripted-opencode.js, as the pipeline smoke test runs it). No model, no network.
 *
 *   combine         two attempts on practice-train days. The first: one model entry composed, sized by the policy
 *                   (order_plan's verdict), through the gate to the broker, filled, and taken out a bar later; then a
 *                   scripted loss past the max loss: no trade cycle after it, only that day's end of day, its second day
 *                   never stepped. The second starts fresh at the starting balance (the prompt's attempt line: day 1, no
 *                   profit), goes past the target on its first day, where the gate refuses the model's entry on the
 *                   account's own block (past the target with today the best day; the refusal carries other checks of
 *                   the replayed bar too), and passes at its second close. Then the stage report's attempt lines, and
 *                   the Monte Carlo run on the finished run as a real score, which refuses the scripted fills (no order
 *                   of the model placed them)
 *   accountStates   two curated days, each opening at its drawn balance (the attempt line in the prompt shows it); the run
 *                   finishes, its practice by account state and its Monte Carlo reported (scored)
 * Both finish with no error, refusal or warning in their output, their runner steps or the gate's log, but the one
 * refusal the combine run expects.
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

function world({ scriptedFills = [], scriptedPositions = [] } = {}) {
  const home = tmpDir();
  const live = path.join(home, 'live-home');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(live);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({
    brokers: { replaymock: { command: [process.execPath, SERVER], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_STATE_DIR', 'MOCK_JOURNAL', 'MOCK_CLOCK_FILE', 'MOCK_REPLAY', 'MOCK_INIT_FILE', 'MOCK_PRICE_FROM_BARS', 'MOCK_BALANCE_SCHEDULE', 'MOCK_MAX_ORDER_SIZE', 'MOCK_MAX_POSITION_SIZE', 'MOCK_MAX_DAILY_LOSS', 'MOCK_JOURNAL_CLOCK'], limits: { dailyLoss: 'MOCK_MAX_DAILY_LOSS', maxOrderSize: 'MOCK_MAX_ORDER_SIZE', maxPositionSize: 'MOCK_MAX_POSITION_SIZE' } } },
  }));
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\nexec "${process.execPath}" "${STANDIN}" "$@"\n`, { mode: 0o755 });
  const moved = (bars, monday) => bars.map(b => ({ ...b, t: new Date(Date.parse(b.t) + shiftOf(monday)).toISOString() }));
  const both = bars => MONDAYS.flatMap(m => moved(bars, m)).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const init = path.join(home, 'exchange.json');
  fs.writeFileSync(init, JSON.stringify({ prices: { [D.MNQ_ID]: D.BARS[0].c }, bars: { [D.MNQ_ID]: both(D.BARS), [`${D.MNQ_ID}@1m`]: both(D.MINUTE_BARS) }, scriptedFills, scriptedPositions }));
  const model = path.join(home, 'model-script.json');
  fs.writeFileSync(model, JSON.stringify({ bars: {} }));
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, FTH_HOME: live, NODE_ENV: 'test',
    // The journal stamped at the replay clock, as a replay server's (its entries' times are the run's).
    MOCK_REPLAY: '1', MOCK_PRICE_FROM_BARS: '1', MOCK_JOURNAL_CLOCK: '1', MOCK_INIT_FILE: init, SMOKE_MODEL_SCRIPT: model,
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
      sessions: ['09:30-09:45@America/New_York', '12:15-12:45@America/New_York'], eodAt: '15:50@America/New_York',
    },
    brokerEnv: { clockFile: 'MOCK_CLOCK_FILE', stateDir: 'MOCK_STATE_DIR', runId: null, start: null, end: null, balanceSchedule: 'MOCK_BALANCE_SCHEDULE' },
    ...over,
  }));
  return file;
}

const runHomeOf = (w, runId) => path.join(w.home, 'replays', runId);
const recordsOf = (w, runId) => readRun(path.join(runHomeOf(w, runId), 'replay', runId)).days;

/** No error, refusal or warning anywhere the run writes one: its output, its runner steps, the gate's log. */
function assertClean(w, runId, out, { refused = [] } = {}) {
  const home = runHomeOf(w, runId);
  const steps = fs.readFileSync(path.join(home, 'replay', runId, 'steps.log'), 'utf8');
  // The expected refusal's own lines aside (the gate's block and the model's result naming it).
  const expected = l => refused.length > 0 && /order gate refused the entry|past the profit target|gate refusal/.test(l);
  const bad = re => [...out.split('\n'), ...steps.split('\n')].filter(l => re.test(l) && !expected(l));
  assert.deepStrictEqual(bad(/\b(ERROR|error:|WARN|warning|refused|FAIL\b)/), [], 'no error, refusal or warning in the output or the steps');
  const gateLog = path.join(home, 'logs', 'gate-log.jsonl');
  const gated = fs.existsSync(gateLog) ? fs.readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  assert.strictEqual(gated.filter(e => e.decision !== 'allowed').length, refused.length, 'the gate refused only what the test expects');
  // No failed cycle, and no refusal but the expected ones (`refused`: their bars).
  for (const recs of Object.values(recordsOf(w, runId))) {
    for (const r of recs) {
      assert.deepStrictEqual((r.ran || []).filter(x => !x.ok), [], r.t);
      assert.strictEqual(r.refusals.length, refused.includes(barOf(r)) ? 1 : 0, r.t);
    }
  }
}

/** The scripted model's script file (scripted-opencode.js): bar open time -> step; a bar with none is quiet. */
const playScript = (w, bars) => fs.writeFileSync(w.env.SMOKE_MODEL_SCRIPT, JSON.stringify({ bars }));
/** The composed scenario of a scanned moment: one true read of each step, as the scan stored them. */
const scenarioOf = m => ({ side: m.side, skill: 'rejection', reads: ['bias', 'location', 'setup', 'entry', 'stop', 'target'].map(step => { const x = m.reads.find(r => r.step === step && r.agrees); return [step, x.skill, x.read]; }) });
/** The setup moments the scan finds on the first week's Thursday and Friday (scripts/curated-lists.js scan). */
function scanMoments(w) {
  const file = path.join(w.home, 'moments.jsonl');
  const scan = sh(script('curated-lists.js'), ['scan', '--bars', w.bars1m, '--root', 'MNQ', '--from', '2022-04-21', '--to', '2022-04-23', '--use', 'practice', '--out', file], w.env);
  assert.strictEqual(scan.code, 0, scan.out);
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}
const iso = ms => new Date(ms).toISOString();
/** The bar a decision record decided: it closed 2 s before the decision time. */
const barOf = x => iso(Date.parse(x.t) - 2000 - D.STEP);

test('stage 2, combine: two attempts from zero; a model entry fills, the first attempt blows (no trade cycle after it), the second passes; an entry at the target is refused; report and Monte Carlo', { timeout: 600000 }, () => {
  // Two session windows a day (09:30-09:45 and 12:15-12:36 ET). Attempt 1 (Thu 04-21, Fri 04-22): the model composes a
  // long on the 12:21 ET bar, through the gate to the broker, takes it out a bar later and reviews it; then a loss past
  // the max loss at 12:40 ET. Attempt 2 (Thu 04-28, Fri 04-29): the whole target and more at 09:34 ET of its first day, so the gate
  // refuses the model's entry on the same 12:21 bar a week later (past the target with today the best day: more today
  // can't meet consistency); as much again the next day, so its second close passes under the consistency rule.
  const big = ACCOUNT.profit_target + 200;
  const blowAt = '2022-04-21T16:40:00Z';
  const w = world({ scriptedFills: [{ at: blowAt, pnl: -(ACCOUNT.max_loss + 1000) }, { at: '2022-04-28T13:34:00Z', pnl: big }, { at: '2022-04-29T13:34:00Z', pnl: big }] });
  const moments = scanMoments(w);
  const entry = moments.find(m => m.bar === '2022-04-21T16:21:00.000Z');
  assert.ok(entry, moments.map(m => m.bar).join(', '));
  const exitBar = iso(Date.parse(entry.bar) + D.STEP);
  const refusedBar = iso(Date.parse(entry.bar) + 7 * 86400000); // the same bar a week later (the second week's Thursday)
  // The model suggests 1 (as a small model does); the size is translated at entry to the rulebook's
  // (prop/size-translate.js): order_plan builds the order at it, phase 2 approves it and the executor sends it.
  const compose = m => ({ do: 'compose', scenario: scenarioOf(m), size: 1, policy: 'prop_portfolio', planned: true, rationale: `setup:prop_portfolio ${m.side}, composed from its reads` });
  playScript(w, {
    [entry.bar]: compose(entry),
    [exitBar]: { do: 'exit', side: entry.side, size: 'position', review: { result: 'win', setup: 'prop_portfolio', r: 1 } },
    [refusedBar]: { ...compose(entry), result: 'CYCLE RESULT: blocked - the order gate refused the entry' },
  });
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
  // The model's entry went through the gate and filled, and its exit closed it.
  const entered = days['2022-04-21'].find(x => barOf(x) === entry.bar);
  assert.match(entered.ran[0].result, new RegExp(`^CYCLE RESULT: executed - trade_lifecycle ${entry.side} MNQ`), JSON.stringify(entered.ran));
  assert.deepStrictEqual(entered.refusals, []);
  // The record suggested 1; the order the gate allowed is the translated size, at or over the floor (min_contracts 3).
  const gateLog = fs.readFileSync(path.join(runHomeOf(w, 'combine-e2e'), 'logs', 'gate-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const allowed = gateLog.filter(e => e.decision === 'allowed' && e.tool === 'place_order' && /^setup:prop_portfolio/.test(String(e.rationale || '')));
  assert.strictEqual(allowed.length, 1, JSON.stringify(allowed));
  assert.ok(allowed[0].size >= 3, `the translated size ${allowed[0].size}`);
  const recs = require('../../scripts/lib/trading/trade-lifecycle').readRecords(runHomeOf(w, 'combine-e2e'), 'MNQ').filter(x => x.bar === entry.bar);
  assert.deepStrictEqual(recs.map(x => x.plan.size), [1], 'the record keeps the suggestion');
  assert.match(entered.ran[0].result, new RegExp(`MNQ ${allowed[0].size}$`));
  const out = days['2022-04-21'].find(x => barOf(x) === exitBar);
  assert.match(out.ran[0].result, /^CYCLE RESULT: managed - out/);
  const fills = days['2022-04-21'].flatMap(x => x.trades || []).filter(f => !(f.creationTimestamp || '').startsWith(blowAt.slice(0, 16)));
  assert.strictEqual(fills.length, 2, JSON.stringify(fills));
  // Attempt 1: every bar up to the blow, then only its end of day (the runner's flatten and close), never its second day.
  assert.deepStrictEqual(Object.keys(days).sort(), ['2022-04-21', '2022-04-28', '2022-04-29']);
  assert.deepStrictEqual(days['2022-04-21'].filter(x => x.t > blowAt).map(x => x.kind), ['eod'], 'no trade cycle of attempt 1 after its blow');
  for (const d of ['2022-04-28', '2022-04-29']) assert.strictEqual(days[d].filter(x => x.kind === 'eod').length, 1, d);
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
  // Each attempt's prompt history is its own (prop/attempt-scope.js): attempt 1's cycles after its review show it and
  // its earlier decisions; attempt 2's first prompt shows nothing of attempt 1 (no reviewed trade, no earlier cycle).
  const promptOf = x => JSON.parse(fs.readFileSync(x.cycles[0].file, 'utf8')).prompt;
  const later1 = days['2022-04-21'].filter(x => x.kind === 'trade' && x.t > iso(Date.parse(exitBar) + D.STEP + 2000) && x.t < blowAt);
  assert.ok(later1.length >= 2, later1.map(x => x.t).join(', '));
  for (const x of later1) {
    assert.match(promptOf(x), /Your last 1 reviewed trade\(s\)/, x.t);
    assert.match(promptOf(x), /Your last \d+ cycle\(s\)/, x.t);
  }
  assert.doesNotMatch(prompt, /Your last \d+ reviewed trade|Your last \d+ cycle/, 'attempt 2 starts with no history');
  assert.match(prompt, /No reviewed trades in the journal yet/);
  // Past the target (before the close that passes it), the gate refused the model's entry on the account's own block.
  const refused = days['2022-04-28'].find(x => barOf(x) === refusedBar);
  assert.strictEqual(refused.refusals.length, 1, JSON.stringify(refused.refusals));
  const gated = fs.readFileSync(path.join(runHomeOf(w, 'combine-e2e'), 'logs', 'gate-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.decision !== 'allowed');
  assert.strictEqual(gated.length, 1, JSON.stringify(gated));
  assert.match(gated[0].violations.find(v => v.check === 'combine').message, /past the profit target with today the best day .*more today can't meet consistency/);
  // order_plan refused it (the attempt blocks entries), so the executor sent the record's suggested 1: refused on the
  // floor and on the translation too, never sized up.
  const floor = gated[0].violations.find(v => v.check === 'min-contracts');
  assert.ok(floor, JSON.stringify(gated[0].violations));
  assert.match(floor.message, /size 1 MNQ is under the floor of 3 contracts/);
  // The stage report's attempt lines, then the Monte Carlo of the finished run.
  assert.match(r.out, /stage 2 \(pass prop\) report:/);
  assert.match(r.out, /continuous combine: 2 attempt\(s\), each from zero at the starting balance/);
  assert.match(r.out, /attempt 1 from 2022-04-21: blown after 1 session\(s\); profit -\$\d+\.\d\d of .*2 trade\(s\)/);
  assert.match(r.out, /attempt 2 from 2022-04-28: passed after 2 session\(s\); profit \$\d+\.00 of .*2 trade\(s\), win rate 100\.0%/);
  assert.match(r.out, /totals: 2 attempt\(s\) ended: 1 passed \(pass rate 50\.0%\), 1 blown, 0 unfinished; median sessions to pass 2/);
  assert.match(r.out, /promotion gate numbers \(prop\/promotion\.js, frozen.*practice \(practice-train\), never a promotion score/);
  // The Monte Carlo reads the finished run as a real (full-day) score: it refuses only the scripted fills, which no
  // order of the model placed (a real score never leaves an entry out).
  assert.match(r.out, /Prop Monte Carlo: not scored \(3 entries without a settled outcome \(MNQ 2022-04-21T16:40:00\.000Z: a fill no record placed;.*a real score never leaves one out\)/);
  const report = sh(script('replay.js'), ['report', path.join(runHomeOf(w, 'combine-e2e'), 'replay', 'combine-e2e')], w.env);
  assert.strictEqual(report.code, 0, report.out);
  assert.match(report.out, /continuous combine: 2 attempt\(s\)/);
  assertClean(w, 'combine-e2e', r.out, { refused: [refusedBar] });
});

test('stage 2, combine: an open loss through the floor between two steps blows the attempt, though the position closes whole', { timeout: 600000 }, () => {
  // A long of 10 MNQ opened at 09:31 ET, priced 151 points above the lowest 1-minute low before the 09:33 step (equity
  // $3,020 and the exit fees down at its worst: past the $3,000 cushion; at those bars' highs it would not be), closed by
  // the script at its entry price at 10:00 ET (no loss).
  const openAt = '2022-04-21T13:31:00.000Z';
  const shift = shiftOf(MONDAYS[0]);
  const lows = D.MINUTE_BARS.map(b => ({ ...b, t: iso(Date.parse(b.t) + shift) })).filter(b => b.t >= openAt && Date.parse(b.t) + 60000 <= Date.parse('2022-04-21T13:33:02Z'));
  assert.strictEqual(lows.length, 2);
  const averagePrice = Math.min(...lows.map(b => b.l)) + 151;
  assert.ok(Math.max(...lows.map(b => b.h)) - Math.min(...lows.map(b => b.l)) > 2, 'only the worst price touches the floor');
  const w = world({ scriptedPositions: [{ at: openAt, until: '2022-04-21T14:00:00.000Z', type: 1, size: 10, averagePrice, pnl: 0 }] });
  const config = replayConfig(w, 'touch-e2e', { start: '2022-04-21T13:30:00Z', end: '2022-04-23T00:00:00Z', combine: { account: ACCOUNT.name, attempts: ['2022-04-21'], maxSessions: 2 } });
  const r = sh(script('replay.js'), ['run', '--config', config, '--bars', `MNQ=${w.bars1m}`], w.env);
  assert.strictEqual(r.code, 0, r.out);
  const days = recordsOf(w, 'touch-e2e');
  // The 09:30 step, then (the touch seen before the 09:33 step) only the day's end of day; the second day never stepped.
  assert.deepStrictEqual(Object.keys(days), ['2022-04-21']);
  assert.deepStrictEqual(days['2022-04-21'].map(x => [x.t, x.kind]), [['2022-04-21T13:30:02.000Z', 'trade'], ['2022-04-21T19:50:00.000Z', 'eod']]);
  const end = fs.readFileSync(path.join(runHomeOf(w, 'touch-e2e'), 'replay', 'touch-e2e', 'combine.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(x => x.kind === 'end');
  assert.deepStrictEqual([end.outcome, end.profit, end.sessions], ['blown', 0, 1]);
  assert.ok(end.lowCushion < 0 && end.worstDay < -ACCOUNT.max_loss, JSON.stringify(end));
  assert.match(r.out, /attempt 1 from 2022-04-21: blown after 1 session\(s\); profit \$0\.00 of/);
  assertClean(w, 'touch-e2e', r.out);
});

test('stage 2, combine: a trade opened and closed inside one decision interval that dips through the floor and closes at a gain blows the attempt', { timeout: 600000 }, () => {
  // A long of 10 MNQ from 09:31 to 09:32:30 ET, between the 09:30 and 09:33 steps, priced 149.75 points above its minutes'
  // lowest low, closed +$100: at its worst, from the balance before it, equity was $2,995 plus its fees ($7.40) down, past
  // the $3,000 cushion only with the fees (never assumed). The 09:33 check finds it in the fills and blows the attempt.
  const openAt = '2022-04-21T13:31:00.000Z';
  const until = '2022-04-21T13:32:30.000Z';
  const shift = shiftOf(MONDAYS[0]);
  const bars = D.MINUTE_BARS.map(b => ({ ...b, t: iso(Date.parse(b.t) + shift) })).filter(b => b.t >= openAt && b.t <= until);
  assert.strictEqual(bars.length, 2);
  const averagePrice = Math.min(...bars.map(b => b.l)) + 149.75;
  const w = world({ scriptedPositions: [{ at: openAt, until, type: 1, size: 10, averagePrice, pnl: 100 }] });
  const config = replayConfig(w, 'dip-e2e', { start: '2022-04-21T13:30:00Z', end: '2022-04-23T00:00:00Z', combine: { account: ACCOUNT.name, attempts: ['2022-04-21'], maxSessions: 2 } });
  const r = sh(script('replay.js'), ['run', '--config', config, '--bars', `MNQ=${w.bars1m}`], w.env);
  assert.strictEqual(r.code, 0, r.out);
  const days = recordsOf(w, 'dip-e2e');
  assert.deepStrictEqual(days['2022-04-21'].map(x => [x.t, x.kind]), [['2022-04-21T13:30:02.000Z', 'trade'], ['2022-04-21T19:50:00.000Z', 'eod']]);
  const end = fs.readFileSync(path.join(runHomeOf(w, 'dip-e2e'), 'replay', 'dip-e2e', 'combine.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(x => x.kind === 'end');
  assert.deepStrictEqual([end.outcome, end.profit], ['blown', 100]);
  assert.ok(end.lowCushion < 0, JSON.stringify(end));
  assertClean(w, 'dip-e2e', r.out);
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
