'use strict';

// The replay driver's pieces (scripts/lib/replay/): decision times, the run's
// config and isolation, the environment of its processes, the store and
// resume, the driver loop on fake steps, and the report.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir } = require('../helpers');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { decisionPoints, tradingDays, holidayDates } = require('../../scripts/lib/replay/schedule');
const { resolveReplay, isolationErrors, replayEnv, brokerErrors, configHash, DISABLED } = require('../../scripts/lib/replay/config');
const store = require('../../scripts/lib/replay/store');
const { seedRunHome, runReplay, withEntry } = require('../../scripts/lib/replay/driver');
const { summarize, toMarkdown, toText } = require('../../scripts/lib/replay/report');
const { openRunnerBroker, wireRunner } = require('../../scripts/lib/runner-wiring');

const ROOT = path.resolve(__dirname, '..', '..');
const iso = s => new Date(s);
const cfgOf = over => validateConfig({ harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', timeframe: 3, sessions: ['09:30-15:50@America/New_York'], ...over });

test('decision points: every closed bar in the sessions, polled after the close, before end of day', () => {
  const cfg = cfgOf({ barDelaySeconds: 2 });
  // Wednesday 2026-10-07, New York = UTC-4: 09:30 ET = 13:30Z.
  const pts = decisionPoints(cfg, { start: iso('2026-10-07T13:00:00Z'), end: iso('2026-10-07T21:00:00Z') });
  const trades = pts.filter(p => p.kind === 'trade');
  assert.strictEqual(trades[0].t.toISOString(), '2026-10-07T13:30:02.000Z', 'the 09:27 bar closes at 09:30, inside the session');
  assert.strictEqual(trades.at(-1).t.toISOString(), '2026-10-07T19:48:02.000Z', 'the last bar before 15:50');
  assert.strictEqual(trades.length, (6 * 60 + 18) / 3 + 1, '09:30 to 15:48, every 3 minutes');
  assert.ok(trades.every(p => p.day === '2026-10-07'));
  assert.deepStrictEqual(pts.filter(p => p.kind === 'eod').map(p => p.t.toISOString()), ['2026-10-07T19:50:00.000Z']);
  // Every Nth bar of the day, counted from its first.
  const third = decisionPoints(cfg, { start: iso('2026-10-07T13:00:00Z'), end: iso('2026-10-07T21:00:00Z'), everyNth: 3 }).filter(p => p.kind === 'trade');
  assert.deepStrictEqual(third.slice(0, 2).map(p => p.t.toISOString()), ['2026-10-07T13:30:02.000Z', '2026-10-07T13:39:02.000Z']);
  assert.strictEqual(third.length, Math.ceil(trades.length / 3));
  // Premarket at premarketAt, before the bars at the same minute.
  const pre = decisionPoints(cfgOf({ premarketAt: '08:00@America/New_York', sessions: ['08:00-15:50@America/New_York'], barDelaySeconds: 0 }), { start: iso('2026-10-07T11:59:00Z'), end: iso('2026-10-07T12:04:00Z') });
  assert.deepStrictEqual(pre.map(p => `${p.kind}@${p.t.toISOString()}`), ['premarket@2026-10-07T12:00:00.000Z', 'trade@2026-10-07T12:00:00.000Z', 'trade@2026-10-07T12:03:00.000Z']);
});

test('decision points: holidays, weekends and early closes from the harness calendar', () => {
  const cfg = cfgOf({});
  // Thanksgiving 2026-11-26 (closed) and the day after (early close: end of day 12:50 ET).
  const days = tradingDays(cfg, { start: iso('2026-11-25T12:00:00Z'), end: iso('2026-11-30T00:00:00Z') });
  assert.deepStrictEqual(days.map(d => [d.day, d.skipped]), [
    ['2026-11-25', null], ['2026-11-26', 'exchange closed (holiday)'], ['2026-11-27', null], ['2026-11-28', 'no session (weekend)'], ['2026-11-29', 'no session (weekend)'], ['2026-11-30', null],
  ]);
  const pts = decisionPoints(cfg, { start: iso('2026-11-25T12:00:00Z'), end: iso('2026-11-30T00:00:00Z') });
  assert.ok(!pts.some(p => p.day === '2026-11-26' || p.day === '2026-11-28'));
  assert.deepStrictEqual(pts.filter(p => p.kind === 'eod').map(p => p.t.toISOString()), ['2026-11-25T20:50:00.000Z', '2026-11-27T17:50:00.000Z']);
  assert.ok(pts.filter(p => p.day === '2026-11-27').every(p => p.t.toISOString() <= '2026-11-27T17:50:00.000Z'));
  // A year the built-in calendar lacks gets its holidays from the harness's CME rules.
  const h = holidayDates(iso('2024-01-01T00:00:00Z'), iso('2024-12-31T00:00:00Z'));
  assert.ok(h.closed.includes('2024-07-04') && h.closed.includes('2024-03-29') && h.early.includes('2024-11-29'));
  assert.deepStrictEqual(holidayDates(iso('2026-02-01T00:00:00Z'), iso('2026-03-01T00:00:00Z')), { closed: [], early: [] }, 'built-in years are left to the table');
});

function replayConfig(dir, over = {}) {
  return {
    runId: 'r1', workDir: path.join(dir, 'replays'), broker: 'sim', start: '2026-10-07T13:31:00Z', end: '2026-10-07T13:40:00Z', premarket: false,
    autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York', dataDir: '/live/bars', alertWebhook: 'https://example.com/hook' },
    ...over,
  };
}

test('replay config: the run\'s own home and files; the runner config derived from the user\'s', () => {
  const dir = tmpDir();
  const run = resolveReplay(replayConfig(dir, { endOfDay: false }), { env: { FTH_HOME: path.join(dir, 'live') }, home: dir, root: ROOT });
  assert.strictEqual(run.paths.runHome, path.join(dir, 'replays', 'r1'));
  assert.strictEqual(run.paths.runDir, path.join(dir, 'replays', 'r1', 'replay', 'r1'));
  assert.strictEqual(run.cfg.dataDir, path.join(run.paths.runHome, 'bars'), 'never the live bars');
  assert.strictEqual(run.cfg.workdir, path.join(run.paths.runHome, 'workspace'), 'never the live workspace');
  assert.deepStrictEqual([run.cfg.alertWebhook, run.cfg.alertCommand, run.cfg.premarketAt, run.cfg.eodReview], ['', null, '', false]);
  // The autotrader config by path, relative to the replay config.
  fs.writeFileSync(path.join(dir, 'auto.json'), JSON.stringify(replayConfig(dir).autotrader));
  assert.strictEqual(resolveReplay(replayConfig(dir, { autotrader: 'auto.json' }), { baseDir: dir, env: {}, home: dir, root: ROOT }).autotraderFile, path.join(dir, 'auto.json'));
  for (const [over, why] of [
    [{ runId: '../x' }, /runId/], [{ workDir: 'relative' }, /workDir/], [{ start: '2026-10-07' }, /start/], [{ end: '2026-10-07T13:00:00Z' }, /end: after start/],
    [{ everyNthBar: 0 }, /everyNthBar/], [{ overrides: { dataDir: '/x' } }, /overrides.dataDir: set by the replay driver/], [{ broker: 'Bad Name' }, /broker/],
  ]) assert.throws(() => resolveReplay(replayConfig(dir, over), { env: {}, home: dir, root: ROOT }), why);
});

test('isolation: a run home is never the live home, the caller\'s FTH_HOME, the repository, or a parent of any', () => {
  const home = '/Users/u';
  const env = { FTH_HOME: '/data/fth' };
  assert.deepStrictEqual(isolationErrors('/runs/r1', { env, home, root: '/code/fth' }), []);
  assert.match(isolationErrors('/Users/u/.futures-trading-harness', { env: {}, home, root: '/code/fth' })[0], /overlaps the live harness home/);
  assert.match(isolationErrors('/Users/u/.futures-trading-harness/replays/r1', { env: {}, home, root: '/code/fth' })[0], /overlaps the live harness home/);
  assert.match(isolationErrors('/data/fth/r1', { env, home, root: '/code/fth' })[0], /overlaps the live harness home \/data\/fth/);
  assert.match(isolationErrors('/data', { env, home, root: '/code/fth' })[0], /overlaps the live harness home/, 'a parent of it');
  assert.match(isolationErrors('/code/fth/runs/r1', { env, home, root: '/code/fth' })[0], /overlaps the repository/);
  assert.ok(isolationErrors('/Users', { env, home, root: '/code/fth' }).some(e => /contains your home directory/.test(e)));
  // Through the config: workDir + runId landing on the live home is refused before anything is written.
  const dir = tmpDir();
  assert.throws(() => resolveReplay(replayConfig(dir, { workDir: path.join(dir, '.futures-trading-harness') }), { env: {}, home: dir, root: ROOT }), /replay refused/);
  assert.throws(() => resolveReplay(replayConfig(dir, { workDir: path.join(dir, 'live') }), { env: { FTH_HOME: path.join(dir, 'live') }, home: dir, root: ROOT }), /overlaps the live harness home/);
  assert.ok(!fs.existsSync(path.join(dir, 'live')));
});

/** A user home with a replay broker "sim" and a live broker "live". */
function userWorld(over = {}) {
  const dir = tmpDir();
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: {
    sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL', env: ['SIM_DATA'] },
    live: { command: [process.execPath, '/opt/live/server.js'], env: ['LIVE_API_KEY'], entryEnv: 'LIVE_ENTRY', journalEnv: 'LIVE_JOURNAL' },
  } }));
  const env = { PATH: process.env.PATH, FTH_HOME: live, LIVE_API_KEY: 'secret', PROJECTX_API_KEY: 'secret2', SIM_DATA: '/data', FTH_GATE_LOG: '/live/gate.jsonl', FTH_KILL_SWITCH_FILE: '/live/STOP', FTH_BLACKOUTS_FILE: '/live/b.json', FTH_BROKERS_FILE: path.join(live, 'brokers.json'), FTH_PLAN_MAX_AGE_MIN: '60' };
  const run = resolveReplay(replayConfig(dir, over), { env, home: dir, root: ROOT });
  return { dir, live, env, run };
}

test('replay env: the run home, the replay broker and clock; no path overrides; every live broker\'s variables disabled', () => {
  const w = userWorld({ brokerEnv: { clockFile: 'SIM_CLOCK', stateDir: 'SIM_STATE', runId: null, start: 'SIM_START', end: null } });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const env = replayEnv(w.env, w.run, { at: iso('2026-10-07T13:33:02Z') });
  assert.deepStrictEqual([env.FTH_HOME, env.FTH_BROKER, env.FTH_REPLAY_NOW], [w.run.paths.runHome, 'sim', '2026-10-07T13:33:02.000Z']);
  for (const k of ['FTH_GATE_LOG', 'FTH_KILL_SWITCH_FILE', 'FTH_BLACKOUTS_FILE', 'FTH_BROKERS_FILE']) assert.strictEqual(env[k], undefined, k);
  // Live brokers' variables (the user's and the shipped topstepx's) are set to a dead value, so no .env fills them.
  for (const k of ['LIVE_API_KEY', 'LIVE_ENTRY', 'LIVE_JOURNAL', 'PROJECTX_API_KEY', 'PROJECTX_MCP_ENTRY']) assert.strictEqual(env[k], DISABLED, k);
  assert.deepStrictEqual([env.SIM_DATA, env.SIM_CLOCK, env.SIM_STATE, env.SIM_START, env.SIM_JOURNAL], ['/data', w.run.paths.clockFile, w.run.paths.brokerDir, '2026-10-07T13:31:00.000Z', w.run.paths.journal]);
  assert.strictEqual(env.FTH_PLAN_MAX_AGE_MIN, '60', 'the gate\'s settings stay');
  assert.deepStrictEqual(brokerErrors(env, w.run), []);
  // A live broker, a broker without its own journal, or one that shares a live server: refused.
  assert.match(brokerErrors({ ...env, FTH_BROKER: 'live' }, w.run).join(' '), /not "sim"[\s\S]*not a replay broker/);
  fs.writeFileSync(path.join(w.run.paths.runHome, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/live/server.js'], replay: true, journalEnv: 'SIM_JOURNAL' }, live: { command: [process.execPath, '/opt/live/server.js'] } } }));
  assert.match(brokerErrors(replayEnv(w.env, w.run, { at: iso('2026-10-07T13:33:02Z') }), w.run).join(' '), /looks live/);
  fs.writeFileSync(path.join(w.run.paths.runHome, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true } } }));
  assert.match(brokerErrors(replayEnv(w.env, w.run, { at: iso('2026-10-07T13:33:02Z') }), w.run).join(' '), /no journalEnv/);
});

test('seed: a fresh home of its own (brokers, workspace copy, journal); a non-replay folder is refused', () => {
  const w = userWorld();
  assert.strictEqual(seedRunHome(w.run, { root: ROOT, userEnv: w.env }), true);
  assert.ok(fs.existsSync(path.join(w.run.paths.runHome, 'brokers.json')));
  assert.strictEqual(fs.readFileSync(path.join(w.run.paths.workspace, 'AGENTS.md'), 'utf8'), fs.readFileSync(path.join(ROOT, 'workspace', 'AGENTS.md'), 'utf8'));
  assert.ok(fs.existsSync(w.run.paths.journal));
  const other = userWorld();
  fs.mkdirSync(other.run.paths.runHome, { recursive: true });
  fs.writeFileSync(path.join(other.run.paths.runHome, 'notes.txt'), 'mine');
  assert.throws(() => seedRunHome(other.run, { root: ROOT, userEnv: other.env }), /not a replay run home/);
});

test('store: the manifest, one line per decision time, resume after the last one, refusal of a changed run', () => {
  const dir = tmpDir();
  const paths = { runDir: dir, manifest: path.join(dir, 'manifest.json') };
  const m = store.openRun(paths, { runId: 'r1', hash: 'a'.repeat(64), info: { broker: 'sim' } });
  const pts = ['13:33', '13:36', '13:39'].map(t => ({ t: iso(`2026-10-07T${t}:02Z`), kind: 'trade', day: '2026-10-07' })).concat([{ t: iso('2026-10-08T13:33:02Z'), kind: 'trade', day: '2026-10-08' }]);
  assert.strictEqual(store.remaining(m, pts).length, 4);
  store.appendRecord(paths, m, { t: pts[0].t.toISOString(), day: '2026-10-07', kind: 'trade' });
  const again = store.openRun(paths, { runId: 'r1', hash: 'a'.repeat(64) });
  assert.deepStrictEqual(store.remaining(again, pts).map(p => p.t.toISOString()), pts.slice(1).map(p => p.t.toISOString()));
  store.markDayDone(paths, again, '2026-10-07');
  assert.deepStrictEqual(store.remaining(again, pts).map(p => p.day), ['2026-10-08']);
  assert.throws(() => store.openRun(paths, { runId: 'r1', hash: 'b'.repeat(64) }), /another config, harness or model/);
  assert.throws(() => store.openRun(paths, { runId: 'r2', hash: 'a'.repeat(64) }), /belongs to run r1/);
  fs.appendFileSync(store.dayFile(dir, '2026-10-07'), '{"torn":');
  assert.strictEqual(store.readRun(dir).days['2026-10-07'].length, 1, 'a torn last line is skipped');
  assert.deepStrictEqual(store.parseStep('x\nREPLAY STEP {"asked":"trade","ran":[]}\n'), { asked: 'trade', ran: [] });
  assert.strictEqual(store.parseStep('no step'), null);
});

test('store: a step\'s cycle logs and gate refusals, from the run home\'s logs', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'logs', 'cycles', 'd'), { recursive: true });
  const file = path.join(home, 'logs', 'cycles', 'd', '1-trade.json');
  fs.writeFileSync(file, JSON.stringify({ prompt: 'hello' }));
  fs.writeFileSync(path.join(home, 'logs', 'cycles-2026-10-11.jsonl'), [
    { at: '2026-10-11T06:00:00.000Z', action: 'trade', result: 'old', file },
    { at: '2026-10-11T07:00:00.000Z', action: 'trade', result: 'CYCLE RESULT: no-trade - x', file, skills: ['trade-session'], tools: { Bash: 1 }, orders: [], promptChars: 5 },
  ].map(l => JSON.stringify(l)).join('\n'));
  fs.writeFileSync(path.join(home, 'logs', 'gate-log.jsonl'), [
    { ts: '2026-10-11T07:00:01.000Z', source: 'gateway', tool: 'place_order', decision: 'blocked', violations: [{ check: 'plan-required' }, { check: 'mtf-trend' }] },
    { ts: '2026-10-11T07:00:02.000Z', source: 'gateway', tool: 'place_order', decision: 'allowed', violations: [] },
    { ts: '2026-10-11T05:00:00.000Z', source: 'hook', decision: 'blocked', violations: [{ check: 'old' }] },
  ].map(l => JSON.stringify(l)).join('\n'));
  const since = Date.parse('2026-10-11T06:30:00Z');
  const cycles = store.cycleLogsSince(home, since).map(store.cycleSummary);
  assert.strictEqual(cycles.length, 1);
  assert.strictEqual(cycles[0].promptHash, require('crypto').createHash('sha256').update('hello').digest('hex'));
  assert.deepStrictEqual(store.refusalsSince(home, since).map(r => r.checks), [['plan-required', 'mtf-trend']]);
});

test('driver: one step per decision time at its time, a line each, end of day retried until flat, resume', async () => {
  const w = userWorld({ end: '2026-10-07T19:53:00Z', start: '2026-10-07T19:40:00Z' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const calls = [];
  let eodTries = 0;
  const deps = {
    serverCheck: async () => null,
    async step(point, env) {
      const clock = JSON.parse(fs.readFileSync(w.run.paths.clockFile, 'utf8')).now;
      calls.push({ kind: point.kind, t: point.t.toISOString(), now: env.FTH_REPLAY_NOW, clock });
      const action = point.kind === 'trade' ? 'trade' : 'eod';
      if (action === 'eod') {
        eodTries += 1;
        fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: eodTries >= 2 }));
      }
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [{ action, ok: true, result: 'CYCLE RESULT: no-trade - x' }] })}\n` };
    },
    async trades(env, account, since, until) { return [{ id: calls.length, creationTimestamp: until.toISOString(), profitAndLoss: 10, fees: 0.37, contractId: 'MNQ', size: 1, since: since.toISOString() }]; },
  };
  const first = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps, maxCycles: 2 });
  assert.deepStrictEqual([first.cycles, first.done], [2, false]);
  const second = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.strictEqual(second.done, true);
  assert.deepStrictEqual(calls.map(c => `${c.kind}@${c.t.slice(11, 19)}`), ['trade@19:42:02', 'trade@19:45:02', 'trade@19:48:02', 'eod@19:50:00', 'eod-retry@19:51:00']);
  assert.ok(calls.every(c => c.now === c.t && c.clock === c.t), 'each step at its own time, the broker clock set first');
  const lines = store.readRun(w.run.paths.runDir).days['2026-10-07'];
  assert.strictEqual(lines.length, 5);
  // Each line's fills are those since the previous time, across the resume.
  assert.deepStrictEqual(lines.map(l => l.since.slice(11, 19)), ['19:40:00', '19:42:02', '19:45:02', '19:48:02', '19:50:00']);
  assert.deepStrictEqual(store.readRun(w.run.paths.runDir).manifest.daysDone, ['2026-10-07']);
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).cycles, 0, 'nothing left');
});

test('driver: a step that can\'t run stops the run; failed cycles in a row stop it; the broker must attest the replay', async () => {
  const w = userWorld();
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const ok = { serverCheck: async () => null, trades: async () => [] };
  await assert.rejects(runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps: { ...ok, step: async () => ({ code: 1, output: 'broker: can\'t start' }) } }), /could not run at 2026-10-07T13:33:02.000Z/);
  const failing = { ...ok, step: async p => ({ code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: 'trade', ok: false }] })}` }) };
  const r = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps: failing });
  assert.match(r.stopped, /3 failed cycles in a row/);
  const v = userWorld();
  seedRunHome(v.run, { root: ROOT, userEnv: v.env });
  await assert.rejects(runReplay({ run: v.run, baseEnv: v.env, root: ROOT, deps: { ...ok, serverCheck: async () => 'not a replay server', step: async () => assert.fail('no step') } }), /replay refused: not a replay server/);
  // A live broker selected: refused before any step.
  const live = userWorld({ broker: 'live' });
  seedRunHome(live.run, { root: ROOT, userEnv: live.env });
  await assert.rejects(runReplay({ run: live.run, baseEnv: live.env, root: ROOT, deps: { ...ok, step: async () => assert.fail('no step') } }), /not a replay broker/);
  assert.notStrictEqual(configHash(w.run, w.env), configHash(w.run, { ...w.env, FTH_PLAN_MAX_AGE_MIN: '30' }), 'a gate setting is part of the run');
});

test('report: month by month, trades from round trips or closing fills, R, stand-aside, refusals by check', () => {
  const rt = (net, r, maeR, mfeR) => ({ id: 1, profitAndLoss: net, roundTrip: { net, r, maeR, mfeR, reason: 'stop' } });
  const days = {
    '2026-03-31': [
      { ran: [{ action: 'trade', ok: true, result: 'CYCLE RESULT: no-trade - quiet' }], refusals: [{ checks: ['plan-required', 'mtf-trend'] }, { checks: ['replay-clock'] }], trades: [rt(100, 1, -0.2, 1.5)] },
      { ran: [{ action: 'trade', ok: true, result: 'CYCLE RESULT: executed - orb' }], refusals: [], trades: [rt(-50, -0.5, -1, 0.3)] },
    ],
    '2026-04-01': [
      // A broker without round trips: the opening fill's entry gives 1R = 20 ticks x $0.50 = $10.
      { ran: [{ action: 'manage', ok: false, result: null }], refusals: [{ checks: ['plan-required'] }], trades: [withEntry({ contractId: 'MNQ', orderId: 5, profitAndLoss: null, size: 1, fees: 0.37 }, [{ orderId: 5, setup: 'orb', stopTicks: 20 }])] },
      { ran: [], refusals: [], trades: [{ contractId: 'MNQ', profitAndLoss: 20, fees: 0.37, size: 1 }] },
    ],
  };
  const s = summarize(days);
  const [mar, apr] = s.months;
  assert.deepStrictEqual([mar.key, mar.points, mar.cycles, mar.tradeCycles, mar.standAsideRate, mar.trades, mar.winRate, mar.meanR, mar.expectancy], ['2026-03', 2, 2, 2, 0.5, 2, 0.5, 0.25, 25]);
  assert.deepStrictEqual([mar.meanMaeR, mar.meanMfeR, mar.refusals, mar.replayClockRefusals], [-0.6, 0.9, { 'plan-required': 1, 'mtf-trend': 1 }, 1]);
  assert.deepStrictEqual([apr.trades, apr.meanR, apr.failed, apr.net], [1, 2, 1, 19.63]);
  assert.deepStrictEqual([s.total.trades, s.total.refusals['plan-required']], [3, 2]);
  assert.match(toMarkdown(s, { runId: 'r1', broker: 'sim' }), /# Replay r1[\s\S]*\| 2026-03 \| 2 \| 2 \| 0 \| 50\.0% \| 2 \| 50\.0% \| 0\.25 \(2\) \| \$25\.00 /);
  assert.match(toText(s), /^month +times/);
});

test('runner wiring: the broker must trade for a live account; the runner is built from the harness home', async () => {
  const closed = [];
  const fake = cfgOver => ({ verify: async () => {}, serverConfig: async () => ({ tradingEnabled: cfgOver }), close: () => closed.push(1) });
  await assert.rejects(openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, open: () => fake(false) }), /trading disabled/);
  assert.strictEqual(closed.length, 1, 'closed when refused');
  const client = await openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, open: () => fake(true) });
  assert.ok(client.verify);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-wire-'));
  const runner = wireRunner({ cfg: cfgOf({}), root: ROOT, home, env: { FTH_HOME: home }, client, dataDir: path.join(home, 'bars'), now: () => new Date('2026-10-10T15:00:00Z'), runCycle: async () => ({ ok: true }), loadState: () => null, saveState: () => {}, killSwitchFile: path.join(home, 'STOP'), log: () => {}, event: () => {} });
  assert.strictEqual(typeof runner.step, 'function');
  assert.strictEqual(typeof (await runner.step()), 'number', 'a Saturday: nothing to do');
});
