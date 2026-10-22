'use strict';

// The replay driver's pieces (scripts/lib/replay/): decision times, the run's
// config and isolation, the environment of its processes, the store and
// resume, the driver loop on fake steps, and the report.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir, shippedBroker, FX_STRATEGIES } = require('../helpers');
// The live broker the repo ships (mcp-configs/brokers.json), read, never named.
const SHIPPED = shippedBroker();
const { validateConfig } = require('../../scripts/lib/autotrader');
const { decisionPoints, tradingDays, holidayDates } = require('../../scripts/lib/replay/schedule');
const { resolveReplay, isolationErrors, replayEnv, brokerErrors, configHash, DISABLED } = require('../../scripts/lib/replay/config');
const store = require('../../scripts/lib/replay/store');
const { seedRunHome, runReplay, withEntry, EOD_RETRIES } = require('../../scripts/lib/replay/driver');
const { specFor } = require('../../scripts/lib/trading/contracts');
const { summarize, toMarkdown, toText } = require('../../scripts/lib/replay/report');
const { openRunnerBroker, wireRunner, runnerScan } = require('../../scripts/lib/runner-wiring');

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
    // A pinned replay clock unless a test charges the latency (the default for a learning run: replay/latency.js).
    latency: false,
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
  const env = { PATH: process.env.PATH, FTH_HOME: live, LIVE_API_KEY: 'secret', [SHIPPED.env[0]]: 'secret2', SIM_DATA: '/data', FTH_GATE_LOG: '/live/gate.jsonl', FTH_KILL_SWITCH_FILE: '/live/STOP', FTH_BLACKOUTS_FILE: '/live/b.json', FTH_BROKERS_FILE: path.join(live, 'brokers.json'), FTH_PLAN_MAX_AGE_MIN: '60' };
  const run = resolveReplay(replayConfig(dir, over), { env, home: dir, root: ROOT });
  return { dir, live, env, run };
}

test('the run home is seeded with the user\'s round-number steps, resolved: replay\'s briefing reads what live\'s does', () => {
  const { loadRoundSteps, FILE_NAME } = require('../../scripts/lib/trading/round-numbers');
  const w = userWorld();
  fs.writeFileSync(path.join(w.live, FILE_NAME), JSON.stringify({ steps: { ES: 50, NQ: 0.1 } }));
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const live = loadRoundSteps(w.env);
  const replay = loadRoundSteps({ FTH_HOME: w.run.paths.runHome });
  assert.deepStrictEqual(replay, live, 'the steps and the refusals');
  assert.deepStrictEqual([replay.steps.MES, replay.steps.MNQ, replay.steps.M2K], [50, null, 10], 'override kept, refused family off, default kept');
  // The briefing text is the same: the refused family says why in both.
  const B = require('../../scripts/lib/trading/briefing');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const bars = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv')).slice(0, 300);
  const text = roundSteps => { const b = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3, roundSteps, blackouts: { items: [] } }); return B.renderBriefing(b, { now: new Date(b.closedAt) }); };
  const line = t => (t.match(/^- Round numbers: .*$/m) || [null])[0];
  assert.match(line(text(live)), /MNQ step 0\.1 is not a whole number/);
  assert.strictEqual(line(text(replay)), line(text(live)));
});

test('replay env: the run home, the replay broker and clock; no path overrides; every live broker\'s variables disabled', () => {
  const w = userWorld({ brokerEnv: { clockFile: 'SIM_CLOCK', stateDir: 'SIM_STATE', runId: null, start: 'SIM_START', end: null } });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const env = replayEnv(w.env, w.run, { at: iso('2026-10-07T13:33:02Z') });
  assert.deepStrictEqual([env.FTH_HOME, env.FTH_BROKER, env.FTH_REPLAY_NOW], [w.run.paths.runHome, 'sim', '2026-10-07T13:33:02.000Z']);
  const h = w.run.paths.runHome;
  assert.deepStrictEqual([env.FTH_GATE_LOG, env.FTH_KILL_SWITCH_FILE, env.FTH_BLACKOUTS_FILE, env.FTH_BROKERS_FILE, env.FTH_ENV_FILE],
    [path.join(h, 'logs', 'gate-log.jsonl'), path.join(h, 'STOP'), path.join(h, 'blackouts', 'blackouts.json'), path.join(h, 'brokers.json'), path.join(h, '.env')]);
  // A child loads .env files (its own FTH_HOME's and the repo's) without overriding what is set: a repo .env
  // pointing at the live home, or carrying live credentials, changes nothing.
  const repoEnv = path.join(w.dir, 'repo.env');
  fs.writeFileSync(repoEnv, `FTH_KILL_SWITCH_FILE=${w.live}/STOP\nFTH_GATE_LOG=${w.live}/gate.jsonl\nFTH_BLACKOUTS_FILE=${w.live}/b.json\nFTH_BROKERS_FILE=${w.live}/brokers.json\nFTH_ENV_FILE=${w.live}/.env\nFTH_ORDER_GATE_SKIP=mtf-trend\nFTH_PAPER=1\nLIVE_API_KEY=k\n${SHIPPED.entryEnv}=/live/server.js\n`);
  const child = { ...env };
  require('../../scripts/lib/env-file').loadEnvFiles({ env: child, files: [repoEnv] });
  assert.deepStrictEqual(child, env, 'nothing filled in');
  // Live brokers' variables (the user's and the shipped default's) are set to a dead value, so no .env fills them.
  for (const k of ['LIVE_API_KEY', 'LIVE_ENTRY', 'LIVE_JOURNAL', SHIPPED.entryEnv, SHIPPED.journalEnv, ...SHIPPED.env].filter(Boolean)) assert.strictEqual(env[k], DISABLED, k);
  assert.ok(SHIPPED.env.length > 0, 'the shipped broker reads variables of its own');
  assert.deepStrictEqual([env.SIM_DATA, env.SIM_CLOCK, env.SIM_STATE, env.SIM_START, env.SIM_JOURNAL], ['/data', w.run.paths.clockFile, w.run.paths.brokerDir, '2026-10-07T13:31:00.000Z', w.run.paths.journal]);
  assert.strictEqual(env.FTH_PLAN_MAX_AGE_MIN, '60', 'the gate\'s settings stay');
  assert.deepStrictEqual(brokerErrors(env, w.run), []);
  // Fetched bars: the run home's own scratch directory, never the live home's (nor the shared /tmp/fth), and the tools read
  // only it and the bar directory.
  const { scratchDir } = require('../../scripts/lib/bars-fetch');
  const { barsDirs } = require('../../scripts/lib/harness-tools/paths');
  assert.strictEqual(scratchDir(env), path.join(h, 'bars-scratch'));
  assert.notStrictEqual(scratchDir(env), scratchDir(w.env));
  assert.ok(barsDirs(env).includes(path.join(h, 'bars-scratch')) && !barsDirs(env).some(d => d === scratchDir(w.env) || /^(\/private)?\/tmp\/fth(\/|$)/.test(d)), barsDirs(env).join());
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
  // A long run (more recorded times than a call can take as arguments) still resumes.
  const many = new Set(Array.from({ length: 200000 }, (_, i) => new Date(Date.parse('2025-01-01T00:00:00Z') + i * 60000).toISOString()));
  assert.strictEqual(store.remaining({ daysDone: [], lastT: null }, pts, many).length, 4);
});

test('store: a step\'s cycle logs and gate refusals, from the run home\'s logs', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'logs', 'cycles', 'd'), { recursive: true });
  const file = path.join(home, 'logs', 'cycles', 'd', '1-trade.json');
  fs.writeFileSync(file, JSON.stringify({ prompt: 'hello' }));
  const ago = m => new Date(Date.now() - m * 60000).toISOString();
  fs.writeFileSync(path.join(home, 'logs', 'cycles-2026-10-11.jsonl'), [
    { at: ago(60), action: 'trade', result: 'old', file },
    { at: ago(1), action: 'trade', result: 'CYCLE RESULT: no-trade - x', file, skills: ['trade-session'], tools: { Bash: 1 }, orders: [], promptChars: 5 },
  ].map(l => JSON.stringify(l)).join('\n'));
  fs.writeFileSync(path.join(home, 'logs', 'gate-log.jsonl'), [
    { ts: ago(0.9), source: 'gateway', tool: 'place_order', decision: 'blocked', violations: [{ check: 'plan-required' }, { check: 'mtf-trend' }] },
    { ts: ago(0.8), source: 'gateway', tool: 'place_order', decision: 'allowed', violations: [] },
    { ts: ago(120), source: 'hook', decision: 'blocked', violations: [{ check: 'old' }] },
  ].map(l => JSON.stringify(l)).join('\n'));
  const since = Date.now() - 30 * 60000;
  const cycles = store.cycleLogsSince(home, since).map(store.cycleSummary);
  assert.strictEqual(cycles.length, 1);
  assert.strictEqual(cycles[0].promptHash, require('crypto').createHash('sha256').update('hello').digest('hex'));
  assert.deepStrictEqual(store.refusalsSince(home, since).map(r => r.checks), [['plan-required', 'mtf-trend']]);
  // Whether a step may have acted: any gate decision (an allowed one too), a cycle, or the runner's state saved.
  assert.strictEqual(store.touchedSince(home, since), true);
  assert.strictEqual(store.touchedSince(home, Date.now() + 1000), false);
  fs.writeFileSync(path.join(home, 'autotrader-state.json'), '{}');
  assert.strictEqual(store.touchedSince(home, Date.now() - 1000), true);
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
  assert.strictEqual(store.readRun(w.run.paths.runDir).manifest.finished, undefined, 'stopped by --max-cycles: not finished');
  const second = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.strictEqual(second.done, true);
  assert.strictEqual(store.readRun(w.run.paths.runDir).manifest.finished, true, 'every decision time ran: finished');
  assert.deepStrictEqual(calls.map(c => `${c.kind}@${c.t.slice(11, 19)}`), ['trade@19:42:02', 'trade@19:45:02', 'trade@19:48:02', 'eod@19:50:00', 'eod-retry@19:51:00']);
  assert.ok(calls.every(c => c.now === c.t && c.clock === c.t), 'each step at its own time, the broker clock set first');
  const lines = store.readRun(w.run.paths.runDir).days['2026-10-07'];
  assert.strictEqual(lines.length, 5);
  // Each line's fills are those since the previous time, across the resume.
  assert.deepStrictEqual(lines.map(l => l.since.slice(11, 19)), ['19:40:00', '19:42:02', '19:45:02', '19:48:02', '19:50:00']);
  assert.deepStrictEqual(store.readRun(w.run.paths.runDir).manifest.daysDone, ['2026-10-07']);
  // A replay's line has the live session's shape (session/record.js decisionRecord), field for field, in order.
  for (const l of lines) assert.deepStrictEqual(Object.keys(l), ['v', 't', 'day', 'kind', 'asked', 'ran', 'events', 'step', 'cycles', 'refusals', 'errors', 'bars', 'values', 'trades', 'since']);
  // The manifest says where its decisions came from and which version of the agent made them (R33's fingerprints today).
  const man = store.readRun(w.run.paths.runDir).manifest;
  assert.strictEqual(man.source, 'replay');
  // And the schedule it ran under (config/schedule.json's fingerprint, scripts/lib/schedule.js).
  assert.deepStrictEqual(man.schedule, require('../../scripts/lib/schedule').fingerprint());
  assert.deepStrictEqual(man.configFiles, require('../../scripts/lib/tunables').fingerprints(), 'the config files the run ran under');
  // The exit its composed trades are managed by, recorded at seed time (its experience lines are tagged by it).
  const XL = require('../../scripts/lib/learning/experience-log');
  assert.deepStrictEqual(man.exit, XL.exitRecord(require('../../scripts/lib/learning/run-experience').runExit(ROOT, w.env)));
  assert.strictEqual(man.exit.hash, XL.exitHash(man.exit));
  // plannedExit: the run's manifest once started (a resume), whatever the repository's exit is now.
  const RX = require('../../scripts/lib/learning/run-experience');
  const saved = fs.readFileSync(w.run.paths.manifest, 'utf8');
  fs.writeFileSync(w.run.paths.manifest, JSON.stringify({ ...man, exit: XL.exitRecord(XL.BRACKETS) }));
  assert.strictEqual(RX.plannedExit(w.run, { root: ROOT }).mode, 'brackets');
  fs.writeFileSync(w.run.paths.manifest, saved);
  assert.deepStrictEqual(RX.plannedExit({ paths: { manifest: path.join(w.run.paths.runDir, 'none.json') } }, { root: ROOT }), man.exit, 'a fresh run: what its seed records');
  // With the replay broker's bar-shaping settings (its fingerprintEnv allowlist: none on this one), as live records its broker's.
  assert.deepStrictEqual(man.fingerprints, require('../../scripts/lib/session/record').fingerprints(ROOT, { broker: { name: 'sim', settings: {}, refused: [] } }));
  assert.deepStrictEqual(man.versions.map(v => [v.since, v.hash]), [[lines[0].t, man.hash]], 'one version: the agent didn\'t change across the resume');
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).cycles, 0, 'nothing left');
  // A run left with nothing to do (all ran, its flag lost): marked finished on that pass too.
  const m = JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8'));
  delete m.finished;
  fs.writeFileSync(w.run.paths.manifest, JSON.stringify(m));
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).done, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8')).finished, true);
});

// Latency charged (replay/latency.js): a fake wall clock each step moves on by the minutes the cycle "took".
function chargedWorld(over = {}) {
  const w = userWorld({ end: '2026-10-07T19:53:00Z', start: '2026-10-07T19:40:00Z', latency: true, ...over });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const clock = { wall: 1_800_000_000_000 };
  const clockNow = () => JSON.parse(fs.readFileSync(w.run.paths.clockFile, 'utf8')).now;
  return { w, clock, clockNow, wall: () => clock.wall };
}

test('driver, latency charged: each step\'s replay clock runs with the wall clock; a time the clock passed runs at the clock, a trade time whose next time it passed too runs no step; end of day never skipped; the clock never goes back', async () => {
  const { w, clock, clockNow, wall } = chargedWorld();
  const calls = [];
  const minutes = { '19:42:02': 4, '19:46:02': 5, '19:51:02': 1 };
  // The broker fills during each step, 30 s in (an entry, the end-of-day flatten): after the time the step ran.
  const fills = [];
  const deps = {
    serverCheck: async () => null,
    async step(point, env) {
      const t = point.t.toISOString();
      calls.push({ kind: point.kind, t: t.slice(11, 19), now: env.FTH_REPLAY_NOW === t, clock: clockNow() === t, wallStart: env.FTH_REPLAY_WALL_START === String(clock.wall) });
      fills.push({ id: fills.length, creationTimestamp: new Date(point.t.getTime() + 30000).toISOString() });
      clock.wall += (minutes[t.slice(11, 19)] || 1) * 60000;
      if (point.kind !== 'trade') fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: true }));
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [{ action: point.kind === 'trade' ? 'trade' : 'eod', ok: true, result: 'CYCLE RESULT: no-trade - x' }] })}\n` };
    },
    async trades(env, account, since, until) { return fills.filter(f => Date.parse(f.creationTimestamp) > since.getTime() && Date.parse(f.creationTimestamp) <= until.getTime()); },
  };
  const r = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps, wall });
  assert.strictEqual(r.done, true);
  // 19:42:02 took 4 min: 19:45:02 runs at 19:46:02; it took 5 min (to 19:51:02): 19:48:02 (its next, the 19:50 end of
  // day, passed too) runs no step; end of day runs late at 19:51:02.
  assert.deepStrictEqual(calls.map(c => `${c.kind}@${c.t}`), ['trade@19:42:02', 'trade@19:46:02', 'eod@19:51:02']);
  assert.ok(calls.every(c => c.now && c.clock && c.wallStart), JSON.stringify(calls));
  const lines = store.readRun(w.run.paths.runDir).days['2026-10-07'];
  assert.deepStrictEqual(lines.map(l => [l.t.slice(11, 19), (l.scheduled || '').slice(11, 19), l.ranAt || null, l.skipped || null]), [
    ['19:42:02', '', null, null], ['19:46:02', '19:45:02', null, null], ['19:51:02', '19:50:00', null, ['2026-10-07T19:48:02.000Z']],
  ]);
  // Each line's fills are its own step's (made after the time it ran, up to where it ended), the last step's too.
  assert.deepStrictEqual(lines.map(l => l.trades.map(f => f.creationTimestamp.slice(11, 19))), [['19:42:32'], ['19:46:32'], ['19:51:32']]);
  assert.deepStrictEqual(lines.map(l => [l.since.slice(11, 19), l.endedAt.slice(11, 19)]), [['19:40:00', '19:46:02'], ['19:46:02', '19:51:02'], ['19:51:02', '19:52:02']]);
  // The broker's clock where the last step left it (19:51:02 plus its minute).
  assert.strictEqual(clockNow(), '2026-10-07T19:52:02.000Z');
  assert.deepStrictEqual(store.readRun(w.run.paths.runDir).manifest.daysDone, ['2026-10-07']);
});

test('driver, latency charged: a resume starts from the clock file, never before it; the error limit keeps a late time under its key and a resume folds its attempts in', async () => {
  // A stop after one 7-minute step: the clock is at 19:49:02. The resume skips 19:45:02 (19:48:02 passed too) and runs
  // 19:48:02 at 19:49:02; the server check is at that time, never the 19:45:02 the schedule says.
  let { w, clock, clockNow, wall } = chargedWorld();
  const seen = [];
  const step = (fail = () => false) => async point => {
    seen.push([point.t.toISOString().slice(11, 19), clockNow().slice(11, 19)]);
    clock.wall += (point.t.toISOString().endsWith('42:02.000Z') ? 7 : 1) * 60000;
    if (point.kind !== 'trade') fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: true }));
    const failed = fail(point);
    return { code: failed ? 1 : 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [{ action: point.kind === 'trade' ? 'trade' : 'eod', ok: !failed, result: failed ? 'CYCLE RESULT: (none reported)' : 'CYCLE RESULT: no-trade - x' }] })}\n` };
  };
  const checks = [];
  const deps = { serverCheck: async (env, at) => { checks.push(at.toISOString().slice(11, 19)); return null; }, trades: async () => [], step: step() };
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps, wall, maxCycles: 1 })).done, false);
  assert.strictEqual(clockNow(), '2026-10-07T19:49:02.000Z');
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps, wall })).done, true);
  assert.deepStrictEqual(checks, ['19:42:02', '19:49:02']);
  assert.deepStrictEqual(seen, [['19:42:02', '19:42:02'], ['19:49:02', '19:49:02'], ['19:50:02', '19:50:02']]);
  assert.deepStrictEqual(store.readRun(w.run.paths.runDir).days['2026-10-07'].map(l => [l.t.slice(11, 19), (l.scheduled || '').slice(11, 19), l.skipped || null]),
    [['19:42:02', '', null], ['19:49:02', '19:48:02', ['2026-10-07T19:45:02.000Z']], ['19:50:02', '19:50:00', null]]);
  // A late time (19:48:02 run at 19:49:02) whose cycle fails to the error limit: due under its key, with the time it was
  // scheduled; each try runs at the clock then (never back), and the resume folds the three attempts into its line.
  ({ w, clock, clockNow, wall } = chargedWorld());
  seen.length = 0;
  let fails = 3;
  const failing = { ...deps, step: step(p => p.kind === 'trade' && p.t.toISOString() >= '2026-10-07T19:49' && fails-- > 0) };
  const stopped = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps: failing, wall });
  assert.match(stopped.stopped, /3 failed cycles in a row at 2026-10-07T19:49:02.000Z/);
  assert.deepStrictEqual(store.readRun(w.run.paths.runDir).manifest.cycleRetry, { t: '2026-10-07T19:49:02.000Z', day: '2026-10-07', kind: 'trade', tries: 3, scheduled: '2026-10-07T19:48:02.000Z' });
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps: failing, wall })).done, true);
  assert.deepStrictEqual(seen.map(x => x[0]), ['19:42:02', '19:49:02', '19:50:02', '19:51:02', '19:52:02', '19:53:02']);
  const day = store.readRun(w.run.paths.runDir).days['2026-10-07'];
  assert.deepStrictEqual(day.map(l => [l.t.slice(11, 19), (l.retries || []).length, (l.ranAt || '').slice(11, 19)]), [['19:42:02', 0, ''], ['19:49:02', 3, '19:52:02'], ['19:53:02', 0, '']]);
  // The fills windows run from where each step ended (the retry ended 19:53:02, not its line's 19:49:02).
  assert.deepStrictEqual(day.map(l => l.since.slice(11, 19)), ['19:40:00', '19:49:02', '19:53:02']);
  assert.strictEqual(store.readRun(w.run.paths.runDir).manifest.cycleRetry, undefined);
});

test('driver, latency charged: an end of day not verified flat retries a minute after its step ended, never at or past the close; a run started pinned resumes pinned; a stale wall start never reaches a step', async () => {
  // End of day (15:50 ET) takes 9 minutes and isn't flat: its retry would be 16:00 ET, the close: none.
  const { w, clock, wall } = chargedWorld({ start: '2026-10-07T19:49:00Z', end: '2026-10-07T20:30:00Z' });
  const kinds = [];
  const deps = {
    serverCheck: async () => null, trades: async () => [],
    async step(point, env) {
      kinds.push([point.kind, point.t.toISOString().slice(11, 19), env.FTH_REPLAY_WALL_START === String(clock.wall)]);
      clock.wall += 9 * 60000;
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [{ action: 'eod', ok: true, result: 'CYCLE RESULT: no-trade - x' }] })}\n` };
    },
  };
  await runReplay({ run: w.run, baseEnv: { ...w.env, FTH_REPLAY_WALL_START: '1' }, root: ROOT, deps, wall });
  assert.deepStrictEqual(kinds, [['eod', '19:50:00', true]], 'no retry at or past the close');
  assert.strictEqual(store.readRun(w.run.paths.runDir).manifest.eodRetry, undefined);
  // A shorter end of day (2 minutes): its retry a minute after it ended (19:53), not after its time (19:51).
  const b = chargedWorld({ start: '2026-10-07T19:49:00Z', end: '2026-10-07T20:30:00Z' });
  const seen = [];
  let tries = 0;
  await runReplay({ run: b.w.run, baseEnv: b.w.env, root: ROOT, wall: b.wall, deps: { ...deps, async step(point) {
    seen.push(point.t.toISOString().slice(11, 19));
    b.clock.wall += 2 * 60000;
    tries += 1;
    fs.writeFileSync(path.join(b.w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: tries >= 2 }));
    return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [{ action: 'eod', ok: true, result: 'CYCLE RESULT: no-trade - x' }] })}\n` };
  } } });
  assert.deepStrictEqual(seen, ['19:50:00', '19:53:00']);
  // replayEnv never passes on a wall start it was given (only the charged step sets its own).
  assert.strictEqual(replayEnv({ ...b.w.env, FTH_REPLAY_WALL_START: '123' }, b.w.run, { at: iso('2026-10-07T19:50:00Z') }).FTH_REPLAY_WALL_START, undefined);
  // A run whose manifest predates the setting (no latency: true) and whose config doesn't name it resumes pinned,
  // under the hash it started with; a charged run's manifest keeps it charged.
  const cfg = over => resolveReplay(replayConfig(b.w.dir, { end: '2026-10-07T20:30:00Z', start: '2026-10-07T19:49:00Z', ...over }), { env: b.w.env, home: b.w.dir, root: ROOT });
  const { latency: _drop, ...unnamed } = replayConfig(b.w.dir, { end: '2026-10-07T20:30:00Z', start: '2026-10-07T19:49:00Z' });
  const resolve = raw => resolveReplay(raw, { env: b.w.env, home: b.w.dir, root: ROOT });
  assert.strictEqual(JSON.parse(fs.readFileSync(b.w.run.paths.manifest, 'utf8')).latency, true);
  assert.strictEqual(resolve(unnamed).latency, true, 'started charged: stays charged');
  const m = JSON.parse(fs.readFileSync(b.w.run.paths.manifest, 'utf8'));
  delete m.latency;
  fs.writeFileSync(b.w.run.paths.manifest, JSON.stringify(m));
  assert.strictEqual(resolve(unnamed).latency, false, 'started before the setting: pinned');
  assert.strictEqual(resolve(unnamed).latencyPinnedResume, true, 'the preflight is told (it passes a pinned resume, noted)');
  assert.strictEqual(cfg({ latency: true }).latencyPinnedResume, false);
  assert.strictEqual(cfg({ latency: true }).latency, true, 'named: as named');
});

test('driver: a time whose step started but whose line was never written is recorded as interrupted, never run twice', async () => {
  const w = userWorld();
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const ran = [];
  const ok = { serverCheck: async () => null, trades: async () => [] };
  const step = async p => { ran.push(p.t.toISOString()); return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: 'trade', ok: true }] })}` }; };
  // A step that couldn't start (nothing ran): the time is left to run again.
  await assert.rejects(runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps: { ...ok, step: async () => ({ code: 1, output: 'no broker' }) } }));
  assert.strictEqual(JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8')).pending, undefined);
  // The driver stopped mid-step (the step had started a cycle): the next run records it from the logs and goes on.
  const m = JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8'));
  m.pending = { t: '2026-10-07T13:33:02.000Z', day: '2026-10-07', kind: 'trade', startedMs: Date.now() - 1000 };
  fs.writeFileSync(w.run.paths.manifest, JSON.stringify(m));
  await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps: { ...ok, step } });
  assert.deepStrictEqual(ran, ['2026-10-07T13:36:02.000Z', '2026-10-07T13:39:02.000Z']);
  const lines = store.readRun(w.run.paths.runDir).days['2026-10-07'];
  assert.deepStrictEqual(lines.map(l => [l.t.slice(11, 19), Boolean(l.interrupted)]), [['13:33:02', true], ['13:36:02', false], ['13:39:02', false]]);
  assert.strictEqual(lines[1].since, '2026-10-07T13:31:00.000Z', 'the interrupted time\'s fills go to the next line');
});

test('driver: with the run\'s kill switch on, the day under way runs to its end of day (as live: no trade cycle, flat at the close); a new day stops, saying why', async () => {
  const w = userWorld({ start: '2026-10-07T19:44:00Z', end: '2026-10-08T13:40:00Z' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const stop = path.join(w.run.paths.runHome, 'STOP');
  const state = path.join(w.run.paths.runHome, 'autotrader-state.json');
  const ran = [];
  let eods = 0;
  const deps = {
    serverCheck: async () => null,
    trades: async () => [],
    async step(p, env) {
      assert.strictEqual(env.FTH_KILL_SWITCH_FILE, stop, 'the run\'s own kill switch');
      ran.push(`${p.kind}@${p.t.toISOString().slice(5, 16)}`);
      // The first pass's cycle tripped the runner's workspace guard; a later alarm was appended.
      if (ran.length === 1) fs.writeFileSync(stop, 'workspace files changed during a trade run: AGENTS.md. Review the change\n3 failed runs in a row\n');
      // The runner, with the kill switch on: no trade cycle; end of day flattens (verified flat on its second try).
      if (p.kind !== 'trade') { eods += 1; fs.writeFileSync(state, JSON.stringify({ day: p.day, eodDone: eods >= 2 })); }
      const cycle = p.kind === 'trade' && !fs.existsSync(stop) ? [{ action: 'trade', ok: true, result: 'CYCLE RESULT: no-trade - x' }] : [];
      const ranNow = ran.length === 1 ? [{ action: 'trade', ok: true, result: 'CYCLE RESULT: no-trade - x' }] : p.kind === 'trade' ? cycle : [{ action: 'eod', ok: true }];
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: ranNow })}` };
    },
  };
  const first = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.deepStrictEqual(ran, ['trade@10-07T19:45', 'trade@10-07T19:48', 'eod@10-07T19:50', 'eod-retry@10-07T19:51'], 'the day under way, its end of day and retry included');
  assert.strictEqual(first.done, false);
  assert.strictEqual(first.stopped, `the run's kill switch is on (${stop}: 3 failed runs in a row (and 1 earlier line)); review it, then remove the file`, 'the latest line');
  const lines = store.readRun(w.run.paths.runDir).days['2026-10-07'];
  assert.deepStrictEqual(lines.map(l => l.killSwitch || null), [null, '3 failed runs in a row (and 1 earlier line)', '3 failed runs in a row (and 1 earlier line)', '3 failed runs in a row (and 1 earlier line)']);
  assert.deepStrictEqual(store.readRun(w.run.paths.runDir).manifest.daysDone, ['2026-10-07']);
  assert.strictEqual(store.readRun(w.run.paths.runDir).manifest.finished, undefined, 'stopped at a day\'s boundary: every day so far done, the run not finished');
  // Still on: stopped again before the new day; an empty file is on too.
  fs.writeFileSync(stop, '');
  assert.match((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).stopped, /kill switch is on \([^:]*STOP\); review/);
  assert.strictEqual(ran.length, 4);
  fs.unlinkSync(stop);
  const resumed = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.strictEqual(resumed.done, true);
  assert.strictEqual(store.readRun(w.run.paths.runDir).manifest.finished, true);
  assert.ok(ran.slice(4).length > 0 && ran.slice(4).every(r => r.startsWith('trade@10-08')), ran.join(' '));
});

test('driver: a queued end-of-day retry survives a stop (--max-cycles) and runs first on resume', async () => {
  const w = userWorld({ start: '2026-10-07T19:44:00Z', end: '2026-10-07T19:59:00Z' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const ran = [];
  const deps = {
    serverCheck: async () => null,
    trades: async () => [],
    async step(p) {
      ran.push(`${p.kind}@${p.t.toISOString().slice(11, 16)}`);
      // Not verified flat on the first end of day; flat on the retry.
      if (p.kind !== 'trade') fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: p.day, eodDone: p.kind === 'eod-retry' }));
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: p.kind === 'trade' ? 'trade' : 'eod', ok: true }] })}` };
    },
  };
  const first = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps, maxCycles: 3 });
  assert.match(first.stopped, /--max-cycles/);
  assert.deepStrictEqual(ran, ['trade@19:45', 'trade@19:48', 'eod@19:50']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8')).eodRetry, { t: '2026-10-07T19:51:00.000Z', day: '2026-10-07', tries: 1 });
  const second = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.strictEqual(second.done, true);
  assert.deepStrictEqual(ran, ['trade@19:45', 'trade@19:48', 'eod@19:50', 'eod-retry@19:51'], 'the retry, not lost');
  const m = JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8'));
  assert.strictEqual(m.eodRetry, undefined);
  assert.deepStrictEqual(m.daysDone, ['2026-10-07']);
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).cycles, 0, 'nothing left');
  assert.strictEqual(ran.length, 4);
  // A retry saved for a day already done (a stale manifest) never runs, and is cleared.
  fs.writeFileSync(w.run.paths.manifest, JSON.stringify({ ...m, eodRetry: { t: '2026-10-07T19:55:00.000Z', day: '2026-10-07', tries: 2 } }));
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).cycles, 0);
  assert.strictEqual(ran.length, 4);
  assert.strictEqual(JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8')).eodRetry, undefined);
});

test('driver: a retry interrupted after acting, or whose line was written before a crash, never runs that time again', async () => {
  for (const crashAfterLine of [false, true]) {
    const w = userWorld({ start: '2026-10-07T19:44:00Z', end: '2026-10-07T19:59:00Z' });
    seedRunHome(w.run, { root: ROOT, userEnv: w.env });
    const ran = [];
    let crash = true;
    const deps = {
      serverCheck: async () => null,
      trades: async () => [],
      async step(p) {
        ran.push(`${p.kind}@${p.t.toISOString().slice(11, 16)}`);
        if (p.kind !== 'trade') fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: p.day, eodDone: p.kind === 'eod-retry' && !crash }));
        if (p.kind === 'eod-retry' && crash && !crashAfterLine) return { code: 1, output: 'killed' }; // acted (wrote state), then died
        return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: p.kind === 'trade' ? 'trade' : 'eod', ok: true }] })}` };
      },
    };
    if (crashAfterLine) {
      // The retry's line is written, then the driver dies before its manifest says so.
      const real = store.appendRecord;
      store.appendRecord = (paths, manifest, rec) => {
        if (rec.kind !== 'eod-retry') return real(paths, manifest, rec);
        fs.appendFileSync(store.dayFile(paths.runDir, rec.day), `${JSON.stringify({ v: store.VERSION, ...rec })}\n`);
        throw new Error('crash');
      };
      await assert.rejects(runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps }), /crash/);
      store.appendRecord = real;
    } else {
      await assert.rejects(runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps }), /could not run at 2026-10-07T19:51/);
    }
    crash = false;
    const resumed = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
    assert.strictEqual(resumed.done, true);
    assert.deepStrictEqual(ran, ['trade@19:45', 'trade@19:48', 'eod@19:50', 'eod-retry@19:51', 'eod-retry@19:52'], `the next try, not 19:51 again (crash after line: ${crashAfterLine})`);
    const times = Object.values(store.readRun(w.run.paths.runDir).days).flat().map(l => l.t);
    assert.strictEqual(new Set(times).size, times.length, 'one line per decision time');
    const m = JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8'));
    assert.strictEqual(m.eodRetry, undefined);
  }
});

test('driver: end of day under crashes - a crashed first end of day gets its retry; crashing retries stop at EOD_RETRIES; one that ran nothing runs again in order', async () => {
  const stepDeps = (w, ran, crashKinds, touch = true) => ({
    serverCheck: async () => null,
    trades: async () => [],
    async step(p) {
      ran.push(`${p.kind}@${p.t.toISOString().slice(11, 16)}`);
      if (p.kind !== 'trade' && touch) fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: p.day, eodDone: false }));
      if (crashKinds.includes(p.kind)) return { code: 1, output: 'killed' };
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: p.kind === 'trade' ? 'trade' : 'eod', ok: true }] })}` };
    },
  });
  const resumeUntilDone = async (w, deps) => {
    for (let i = 0; i < 20; i += 1) {
      try {
        if ((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).done) return;
      } catch (_err) { /* the crash: resume */ }
    }
    assert.fail('never done');
  };
  // Every end of day acts, then dies: the first end of day and EOD_RETRIES retries, each time once.
  const w = userWorld({ start: '2026-10-07T19:44:00Z', end: '2026-10-07T20:30:00Z' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const ran = [];
  await resumeUntilDone(w, stepDeps(w, ran, ['eod', 'eod-retry']));
  assert.deepStrictEqual(ran.filter(r => r !== 'trade@19:45' && r !== 'trade@19:48'),
    ['eod@19:50', ...Array.from({ length: EOD_RETRIES }, (_, i) => `eod-retry@19:5${i + 1}`)]);
  const times = Object.values(store.readRun(w.run.paths.runDir).days).flat().map(l => l.t);
  assert.strictEqual(new Set(times).size, times.length, 'one line per decision time');

  // An end of day that failed without running anything: it runs again, before its retry.
  const w2 = userWorld({ start: '2026-10-07T19:44:00Z', end: '2026-10-07T20:30:00Z' });
  seedRunHome(w2.run, { root: ROOT, userEnv: w2.env });
  const ran2 = [];
  await assert.rejects(runReplay({ run: w2.run, baseEnv: w2.env, root: ROOT, deps: stepDeps(w2, ran2, ['eod'], false) }), /could not run at 2026-10-07T19:50/);
  assert.strictEqual(JSON.parse(fs.readFileSync(w2.run.paths.manifest, 'utf8')).eodRetry, undefined, 'no retry saved for an end of day that never ran');
  await runReplay({ run: w2.run, baseEnv: w2.env, root: ROOT, deps: stepDeps(w2, ran2, []) });
  assert.deepStrictEqual(ran2.slice(2, 5), ['eod@19:50', 'eod@19:50', 'eod-retry@19:51']);
});

test('driver: a saved retry runs only when due - kept by a retry that ran nothing; not run once verified flat or already recorded', async () => {
  const world = () => {
    const w = userWorld({ start: '2026-10-07T19:44:00Z', end: '2026-10-07T19:59:00Z' });
    seedRunHome(w.run, { root: ROOT, userEnv: w.env });
    return w;
  };
  const deps = (w, ran, { failRetryUntouched = false, flatOn = 'eod-retry' } = {}) => ({
    serverCheck: async () => null,
    trades: async () => [],
    async step(p) {
      ran.push(`${p.kind}@${p.t.toISOString().slice(11, 16)}`);
      if (p.kind === 'eod-retry' && failRetryUntouched) return { code: 1, output: 'no harness' };
      const state = path.join(w.run.paths.runHome, 'autotrader-state.json');
      if (p.kind !== 'trade') fs.writeFileSync(state, JSON.stringify({ day: p.day, eodDone: p.kind === flatOn }));
      // Older than the next step (touchedSince allows a second for whole-second filesystems).
      if (failRetryUntouched && fs.existsSync(state)) fs.utimesSync(state, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: p.kind === 'trade' ? 'trade' : 'eod', ok: true }] })}` };
    },
  });
  const manifestOf = w => JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8'));
  // A retry whose step ran nothing keeps its time: it runs again on resume.
  const a = world();
  const ranA = [];
  await assert.rejects(runReplay({ run: a.run, baseEnv: a.env, root: ROOT, deps: deps(a, ranA, { failRetryUntouched: true }) }), /could not run at 2026-10-07T19:51/);
  assert.deepStrictEqual(manifestOf(a).eodRetry, { t: '2026-10-07T19:51:00.000Z', day: '2026-10-07', tries: 1 });
  await runReplay({ run: a.run, baseEnv: a.env, root: ROOT, deps: deps(a, ranA) });
  assert.deepStrictEqual(ranA.slice(3), ['eod-retry@19:51', 'eod-retry@19:51']);
  // Verified flat but the manifest still holds a retry (a crash before its write): it never runs.
  const b = world();
  const ranB = [];
  await runReplay({ run: b.run, baseEnv: b.env, root: ROOT, deps: deps(b, ranB), maxCycles: 3 });
  fs.writeFileSync(path.join(b.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: '2026-10-07', eodDone: true }));
  assert.strictEqual((await runReplay({ run: b.run, baseEnv: b.env, root: ROOT, deps: deps(b, ranB) })).done, true);
  assert.deepStrictEqual(ranB, ['trade@19:45', 'trade@19:48', 'eod@19:50']);
  // A saved retry at a time already recorded never runs that time again.
  const c = world();
  const ranC = [];
  await runReplay({ run: c.run, baseEnv: c.env, root: ROOT, deps: deps(c, ranC), maxCycles: 3 });
  fs.writeFileSync(c.run.paths.manifest, JSON.stringify({ ...manifestOf(c), eodRetry: { t: '2026-10-07T19:50:00.000Z', day: '2026-10-07', tries: 1 } }));
  assert.strictEqual((await runReplay({ run: c.run, baseEnv: c.env, root: ROOT, deps: deps(c, ranC) })).done, true);
  assert.deepStrictEqual(ranC, ['trade@19:45', 'trade@19:48', 'eod@19:50']);
});

test('driver: end-of-day retries never run at or past the run\'s end or the close', async () => {
  const notFlat = (w, ran) => ({
    serverCheck: async () => null,
    trades: async () => [],
    async step(p) {
      ran.push(`${p.kind}@${p.t.toISOString().slice(11, 16)}`);
      if (p.kind !== 'trade') fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: p.day, eodDone: false }));
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: p.kind === 'trade' ? 'trade' : 'eod', ok: true }] })}` };
    },
  });
  // The run ends at 19:52: one retry (19:51), none at 19:52.
  const w = userWorld({ start: '2026-10-07T19:49:00Z', end: '2026-10-07T19:52:00Z' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const ran = [];
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps: notFlat(w, ran) })).done, true);
  assert.deepStrictEqual(ran, ['eod@19:50', 'eod-retry@19:51']);
  // End of day at 15:57 ET (19:57Z): retries at 15:58 and 15:59, none at the 16:00 close.
  const base = replayConfig('/x').autotrader;
  const w2 = userWorld({ start: '2026-10-07T19:56:00Z', end: '2026-10-07T21:00:00Z', autotrader: { ...base, eodAt: '15:57@America/New_York' } });
  seedRunHome(w2.run, { root: ROOT, userEnv: w2.env });
  const ran2 = [];
  assert.strictEqual((await runReplay({ run: w2.run, baseEnv: w2.env, root: ROOT, deps: notFlat(w2, ran2) })).done, true);
  assert.deepStrictEqual(ran2, ['eod@19:57', 'eod-retry@19:58', 'eod-retry@19:59']);
});

test('driver: the kill switch\'s day under way comes from the last recorded time (a line written just before a crash)', async () => {
  const w = userWorld({ start: '2026-10-07T19:49:00Z', end: '2026-10-07T19:59:00Z' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const ran = [];
  const deps = {
    serverCheck: async () => null,
    trades: async () => [],
    async step(p) {
      ran.push(`${p.kind}@${p.t.toISOString().slice(11, 16)}`);
      fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: p.day, eodDone: p.kind === 'eod-retry' }));
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: 'eod', ok: true }] })}` };
    },
  };
  const real = store.appendRecord;
  store.appendRecord = (paths, manifest, rec) => {
    fs.mkdirSync(paths.runDir, { recursive: true });
    fs.appendFileSync(store.dayFile(paths.runDir, rec.day), `${JSON.stringify({ v: store.VERSION, ...rec })}\n`);
    fs.writeFileSync(path.join(w.run.paths.runHome, 'STOP'), 'workspace changed\n');
    throw new Error('crash');
  };
  try {
    await assert.rejects(runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps }), /crash/);
  } finally {
    store.appendRecord = real;
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8')).lastT, null, 'the manifest never said so');
  const resumed = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.deepStrictEqual(ran, ['eod@19:50', 'eod-retry@19:51'], 'the day under way still runs its retry with the switch on');
  assert.strictEqual(resumed.done, true);
});

test('driver: the error-limit stop keeps a queued end-of-day retry; it runs first on resume', async () => {
  const w = userWorld({ start: '2026-10-07T19:44:00Z', end: '2026-10-07T19:59:00Z' });
  w.run.cfg.maxConsecutiveErrors = 1;
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const ran = [];
  const deps = {
    serverCheck: async () => null,
    trades: async () => [],
    async step(p) {
      ran.push(`${p.kind}@${p.t.toISOString().slice(11, 16)}`);
      if (p.kind !== 'trade') fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: p.day, eodDone: p.kind === 'eod-retry' }));
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: p.kind === 'trade' ? 'trade' : 'eod', ok: p.kind !== 'eod' }] })}` };
    },
  };
  const first = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.match(first.stopped, /failed cycles in a row/);
  assert.strictEqual(JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8')).finished, undefined, 'the error limit: not finished');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8')).eodRetry, { t: '2026-10-07T19:51:00.000Z', day: '2026-10-07', tries: 1 });
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).done, true);
  assert.deepStrictEqual(ran, ['trade@19:45', 'trade@19:48', 'eod@19:50', 'eod-retry@19:51']);
});

test('driver: a run stopped right after a day\'s last time (the error limit at end of day) marks that day done when it finishes', async () => {
  const w = userWorld({ start: '2026-10-07T19:44:00Z', end: '2026-10-08T14:00:00Z' });
  w.run.cfg.maxConsecutiveErrors = 1;
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  let eodRuns = 0;
  const deps = {
    serverCheck: async () => null,
    trades: async () => [],
    async step(p) {
      // End of day is verified flat at once, but its first pass reports a failed cycle: the error limit stops the run there.
      if (p.kind !== 'trade') { eodRuns += 1; fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: p.day, eodDone: true })); }
      const ok = p.kind === 'trade' || eodRuns > 1;
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [{ action: p.kind === 'trade' ? 'trade' : 'eod', ok }] })}` };
    },
  };
  assert.match((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).stopped, /failed cycles in a row/);
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).done, true);
  const m = JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8'));
  assert.deepStrictEqual([m.finished, [...m.daysDone].sort()], [true, ['2026-10-07', '2026-10-08']]);
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
  assert.notStrictEqual(configHash(w.run, w.env), configHash(w.run, { ...w.env, SIM_DATA: '/other' }), 'the replay broker\'s settings are part of the run');
  assert.strictEqual(configHash(w.run, w.env), configHash(w.run, { ...w.env, FTH_ROOT: '/x', FTH_AUTONOMOUS: '1', PATH: '/other/bin' }), 'where it was started from is not');
  assert.notStrictEqual(configHash(w.run, w.env), configHash(w.run, { ...w.env, FTH_HOOK_PROFILE: 'minimal' }), 'the hook profile is part of the run');
  // The role-skills mode: a full run is another run than an index one; unset, blank and index are the same (the default).
  const { FTH_ROLE_SKILLS: _mode, ...noMode } = w.env;
  assert.notStrictEqual(configHash(w.run, noMode), configHash(w.run, { ...noMode, FTH_ROLE_SKILLS: 'full' }), 'the role-skills mode is part of the run');
  assert.strictEqual(configHash(w.run, { ...noMode, FTH_ROLE_SKILLS: 'full' }), configHash(w.run, { ...noMode, FTH_ROLE_SKILLS: ' full ' }));
  for (const v of ['', ' ', 'index', ' index ']) assert.strictEqual(configHash(w.run, { ...noMode, FTH_ROLE_SKILLS: v }), configHash(w.run, noMode), `"${v}" is the default`);
  // The node binary that starts an entry-based broker is not part of the run.
  const brokers = path.join(w.run.paths.runHome, 'brokers.json');
  const b = JSON.parse(fs.readFileSync(brokers, 'utf8'));
  b.brokers.sim.command = [process.execPath, '/opt/sim/server.js'];
  fs.writeFileSync(brokers, JSON.stringify(b));
  const withExec = configHash(w.run, w.env);
  b.brokers.sim.command = ['node', '/opt/sim/server.js'];
  fs.writeFileSync(brokers, JSON.stringify(b));
  assert.strictEqual(configHash(w.run, w.env), withExec, 'this node\'s path counts as any node');
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
      { ran: [{ action: 'manage', ok: false, result: null }], refusals: [{ checks: ['plan-required'] }], trades: [withEntry({ contractId: 'MNQ', orderId: 5, profitAndLoss: null, size: 1, fees: 0.37 }, [{ orderId: 5, setup: 'orb', stopTicks: 20 }], specFor)] },
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
  const fake = (cfgOver, extra = {}) => ({ verify: async () => {}, serverConfig: async () => ({ apiUrl: 'https://api.example.test', tradingEnabled: cfgOver, allowedAccountIds: [7], ...extra }), close: () => closed.push(1) });
  const broker = { name: 'live', allowedAccountsEnv: 'LIVE_ALLOWED', apiUrlEnv: 'LIVE_API_URL', env: ['LIVE_ALLOWED', 'LIVE_API_URL'] };
  const env = { LIVE_ALLOWED: '7', LIVE_API_URL: 'https://api.example.test', FTH_LOCK_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fth-locks-')), FTH_TEST_LOCKS: '1' }; // never the user's lock directory
  await assert.rejects(openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env, broker, open: () => fake(false) }), /trading disabled/);
  assert.strictEqual(closed.length, 1, 'closed when refused');
  // Live: the allow-list must name the account, and the server must not take any account.
  await assert.rejects(openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: { FTH_LOCK_DIR: env.FTH_LOCK_DIR, FTH_TEST_LOCKS: '1', LIVE_API_URL: env.LIVE_API_URL }, broker, open: () => fake(true) }), /LIVE_ALLOWED is empty/);
  await assert.rejects(openRunnerBroker({ cfg: { account: '8', paper: false }, root: ROOT, env, broker, open: () => fake(true, { allowedAccountIds: [8] }) }), /account 8 is not in LIVE_ALLOWED/);
  await assert.rejects(openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env, broker, open: () => fake(true, { allowedAccountIds: 'any' }) }), /allows any account/);
  await assert.rejects(openRunnerBroker({ cfg: { account: '', paper: false }, root: ROOT, env, broker, open: () => fake(true) }), /names its account/);
  assert.strictEqual(closed.length, 5);
  // Paper and a confirmed replay (the broker config and its server both say replay) need no allow-list.
  for (const [cfg, b, extra] of [[{ account: '7', paper: true }, broker, {}], [{ account: '7', paper: false }, { ...broker, replay: true }, { replay: true, allowedAccountIds: [] }]]) {
    (await openRunnerBroker({ cfg, root: ROOT, env: {}, broker: b, open: () => fake(true, extra) })).close();
  }
  // A broker labelled replay whose server doesn't say so is live.
  await assert.rejects(openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: {}, broker: { ...broker, replay: true }, open: () => fake(true) }), /LIVE_ALLOWED/);
  const client = await openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env, broker, open: () => fake(true) });
  assert.ok(client.verify);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-wire-'));
  const runner = wireRunner({ cfg: cfgOf({}), root: ROOT, home, env: { FTH_HOME: home }, client, dataDir: path.join(home, 'bars'), now: () => new Date('2026-10-10T15:00:00Z'), runCycle: async () => ({ ok: true }), loadState: () => null, saveState: () => {}, killSwitchFile: path.join(home, 'STOP'), log: () => {}, event: () => {} });
  assert.strictEqual(typeof runner.step, 'function');
  assert.strictEqual(typeof (await runner.step()), 'number', 'a Saturday: nothing to do');
});

test('runner wiring: a live run holds its account\'s lock across harness homes until its adapter closes; paper and a confirmed replay never take or check it', async () => {
  const { lockFileFor, serverIdentities } = require('../../scripts/lib/account-lock');
  const closed = [];
  const fake = (extra = {}) => ({ verify: async () => {}, serverConfig: async () => ({ apiUrl: 'https://api.example.test', tradingEnabled: true, allowedAccountIds: [7, 8], ...extra }), close: () => closed.push(1) });
  const broker = { name: 'live', allowedAccountsEnv: 'LIVE_ALLOWED', apiUrlEnv: 'LIVE_API_URL', env: ['LIVE_ALLOWED', 'LIVE_API_URL'] };
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-locks-'));
  const envOf = home => ({ LIVE_ALLOWED: '7,8', LIVE_API_URL: 'https://api.example.test', FTH_LOCK_DIR: locks, FTH_TEST_LOCKS: '1', FTH_HOME: home });
  const file = lockFileFor({ env: envOf('/a'), server: serverIdentities({ broker })[0], accountId: '7' });
  const logs = [];
  const first = await openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: envOf('/homes/a'), broker, open: () => fake(), log: m => logs.push(m) });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).home, path.resolve('/homes/a'), 'taken once the account is known');
  // Another harness home, the same account (as the gate normalizes it): refused, its adapter closed.
  await assert.rejects(openRunnerBroker({ cfg: { account: '007', paper: false }, root: ROOT, env: envOf('/homes/b'), broker, open: () => fake() }),
    new RegExp(`account 7 on broker "live" is already traded by another runner \\(pid ${process.pid} on host .*, harness home ${path.resolve('/homes/a')}, started `));
  assert.strictEqual(closed.length, 1);
  // Another account: both run.
  const other = await openRunnerBroker({ cfg: { account: '8', paper: false }, root: ROOT, env: envOf('/homes/b'), broker, open: () => fake() });
  // Paper and a confirmed replay, on the held account: run, and take nothing.
  for (const [cfg, b, extra] of [[{ account: '7', paper: true }, broker, {}], [{ account: '7', paper: false }, { ...broker, replay: true }, { replay: true }]]) {
    (await openRunnerBroker({ cfg, root: ROOT, env: envOf('/homes/r'), broker: b, open: () => fake(extra) })).close();
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).home, path.resolve('/homes/a'), 'the live lock stands');
  // A broker labelled replay whose server doesn't confirm it is live: refused.
  await assert.rejects(openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: envOf('/homes/r'), broker: { ...broker, replay: true }, open: () => fake() }), /already traded by another runner/);
  first.close();
  other.close();
  assert.deepStrictEqual(fs.readdirSync(locks), [], 'closing the adapter releases the lock');
  assert.deepStrictEqual(logs, []);
  // A replay with the account held by a live runner still runs: replays never block live, nor live replays.
  const live = await openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: envOf('/homes/a'), broker, open: () => fake() });
  (await openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: envOf('/homes/r'), broker: { ...broker, replay: true }, open: () => fake({ replay: true }) })).close();
  live.close();
  // One server under two broker names (the same entry, or the same apiUrl): one lock, the second refused.
  const entry = path.join(locks, '..', path.basename(locks) + '-server.js');
  fs.writeFileSync(entry, '');
  const named = (name, command) => ({ ...broker, name, command });
  const one = await openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: envOf('/homes/a'), broker: named('live', [process.execPath, entry]), open: () => fake() });
  await assert.rejects(openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: envOf('/homes/b'), broker: named('live2', ['node', entry]), open: () => fake() }), /account 7 on broker "live2" is already traded by another runner/);
  one.close();
  const api = { apiUrl: 'https://api.example.test' };
  const viaApi = await openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: envOf('/homes/a'), broker: named('live', ['server-a']), open: () => fake(api) });
  await assert.rejects(openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: envOf('/homes/b'), broker: named('other', ['server-b']), open: () => fake(api) }), /already traded by another runner/);
  viaApi.close();
  fs.rmSync(entry);
  assert.deepStrictEqual(fs.readdirSync(locks), []);
});

test('runner wiring: a manual run that can place live orders takes the account lock; end of day, paper, and no account take none', async () => {
  const { manualRunBroker } = require('../../scripts/lib/runner-wiring');
  const fake = () => ({ verify: async () => {}, serverConfig: async () => ({ apiUrl: 'https://api.example.test', tradingEnabled: true, allowedAccountIds: [7] }), close: () => {} });
  const broker = { name: 'live', allowedAccountsEnv: 'LIVE_ALLOWED', apiUrlEnv: 'LIVE_API_URL', env: ['LIVE_ALLOWED', 'LIVE_API_URL'] };
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-locks-'));
  const env = { LIVE_ALLOWED: '7', LIVE_API_URL: 'https://api.example.test', FTH_LOCK_DIR: locks, FTH_TEST_LOCKS: '1' };
  const opened = [];
  const open = () => { opened.push(1); return fake(); };
  for (const [cfg, once] of [[{ account: '7', paper: false }, 'eod'], [{ account: '', paper: false }, 'eod'], [{ account: '7', paper: true }, 'trade'], [{ account: '', paper: true }, 'trade']]) {
    assert.strictEqual(await manualRunBroker({ cfg, once, root: ROOT, env, broker, open }), null, `${once} ${JSON.stringify(cfg)}`);
  }
  // A live manual run that names no account has no lock to take: refused, as the loop is.
  for (const once of ['trade', 'premarket']) {
    await assert.rejects(manualRunBroker({ cfg: { account: ' ', paper: false }, once, root: ROOT, env, broker, open }), new RegExp(`a live manual run \\(--once ${once}, paper: false\\) names its account`));
  }
  assert.strictEqual(opened.length, 0);
  // Held by another live runner: refused before the server is started (a refused run never logs in).
  const L = require('../../scripts/lib/account-lock');
  const runner = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/x/scripts/autotrader.js'], { stdio: 'ignore' });
  const lockFile = L.lockFileFor({ env, server: L.serverIdentities({ broker })[0], accountId: '7' });
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: runner.pid, host: os.hostname(), home: '/homes/other', startedAt: 't', token: 'x' }));
    await assert.rejects(openRunnerBroker({ cfg: { account: '007', paper: false }, root: ROOT, env, broker, open }), new RegExp(`already traded by another runner \\(pid ${runner.pid}`));
    assert.strictEqual(opened.length, 0, 'no server started for the refused run');
  } finally {
    runner.kill();
    fs.rmSync(lockFile, { force: true });
  }
  for (const once of ['trade', 'premarket']) {
    const held = await manualRunBroker({ cfg: { account: '7', paper: false }, once, root: ROOT, env, broker, open });
    assert.strictEqual(fs.readdirSync(locks).length, 2, `${once} holds the lock (its command and its API)`);
    await assert.rejects(manualRunBroker({ cfg: { account: '7', paper: false }, once: 'trade', root: ROOT, env, broker, open }), /already traded by another runner/);
    held.close();
    assert.deepStrictEqual(fs.readdirSync(locks), []);
  }
  // A live manual run is checked as the loop is: an account off the allow-list is refused.
  await assert.rejects(manualRunBroker({ cfg: { account: '8', paper: false }, once: 'trade', root: ROOT, env, broker, open }), /account 8 is not in LIVE_ALLOWED/);
});

test('runner wiring: the runner scans with its symbols as the selected contracts - NQ selected, the micro-listed rules strategies scan NQ; MNQ selected, they don\'t', () => {
  const { loadStrategies } = require('../../scripts/lib/trading/strategies');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const bars = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv')).filter(x => Date.parse(x.t) <= Date.parse('2026-04-28T04:09:00.000Z'));
  // With the fixture fx_break (tests/fixtures/strategies-fx): it fires long on that bar.
  const { strategies } = loadStrategies(ROOT, { FTH_STRATEGIES_DIRS: FX_STRATEGIES });
  const at = new Date(Date.parse(bars.at(-1).t) + 180000);
  const names = rs => rs.map(r => r.name).sort();
  const nq = runnerScan(strategies, cfgOf({ symbols: ['NQ'] }), 'NQ', bars, at);
  assert.ok(nq.find(r => r.name === 'fx_break').candidate, 'fx_break (listing MNQ) scans the selected NQ and fired');
  assert.deepStrictEqual(names(nq), names(runnerScan(strategies, cfgOf({ symbols: ['MNQ'] }), 'MNQ', bars, at)));
  // Only the runner timeframe's strategies (3m here), and none of the micro-listed rules ones on the leg not selected.
  assert.ok(nq.every(r => r.timeframe === undefined || r.timeframe === '3m'));
  assert.ok(runnerScan(strategies, cfgOf({ symbols: ['MNQ'] }), 'NQ', bars, at).every(r => r.signal === 'policy'));
});

test('replay config: brokerEnv names the replay server\'s own variables only; a live broker\'s is refused', () => {
  const dir = tmpDir();
  for (const v of ['FTH_MAX_ENTRIES_PER_DAY', 'FTH_HOME', 'PATH', 'NODE_OPTIONS']) {
    assert.throws(() => resolveReplay(replayConfig(dir, { brokerEnv: { runId: v } }), { env: {}, home: dir, root: ROOT }), /brokerEnv.runId/, v);
  }
  const w = userWorld({ brokerEnv: { runId: 'LIVE_API_KEY' } });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  assert.throws(() => replayEnv(w.env, w.run, { at: iso('2026-10-07T13:33:02Z') }), /LIVE_API_KEY is a live broker's variable/);
});

test('isolation: a symlink or another letter case to the live home or the repo is the same place', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.symlinkSync(live, path.join(dir, 'alias'));
  assert.match(isolationErrors(path.join(dir, 'alias', 'r1'), { env: { FTH_HOME: live }, home: '/nonexistent-home', root: '/nonexistent-root' }).join(' '), /overlaps the live harness home/);
  fs.symlinkSync(ROOT, path.join(dir, 'repo-alias'));
  assert.match(isolationErrors(path.join(dir, 'repo-alias', 'runs', 'r1'), { env: {}, home: '/nonexistent-home', root: ROOT }).join(' '), /overlaps the repository/);
  if (process.platform === 'darwin') assert.match(isolationErrors(path.join(ROOT.toUpperCase(), 'runs'), { env: {}, home: '/nonexistent-home', root: ROOT }).join(' '), /overlaps the repository/);
});

test('seed: brokers.json is written resolved (relative entries keep pointing where they did)', () => {
  const w = userWorld();
  const file = path.join(w.live, 'brokers.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.brokers.sim = { ...cfg.brokers.sim, command: undefined, entry: 'servers/sim.js' };
  fs.writeFileSync(file, JSON.stringify(cfg));
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const copy = JSON.parse(fs.readFileSync(path.join(w.run.paths.runHome, 'brokers.json'), 'utf8'));
  assert.strictEqual(copy.brokers.sim.entry, path.join(w.live, 'servers', 'sim.js'));
  assert.strictEqual(fs.readFileSync(path.join(w.run.paths.runHome, '.env'), 'utf8'), '');
});

test('driver: refuses while the live runner runs or another driver holds the run; a pass with no bar read and errors is a failure', async () => {
  const w = userWorld();
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const ok = { serverCheck: async () => null, trades: async () => [] };
  // A live autotrader (a stand-in whose command line names it) holds the live lock: refused.
  const runner = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'scripts/autotrader.js'], { stdio: 'ignore' });
  try {
    // Right after spawn, Linux's /proc/<pid>/cmdline can still be empty (the child mid-exec): wait for its command line.
    const { processCommand } = require('../../scripts/lib/runner-lock');
    for (let i = 0; i < 200 && !/autotrader\.js/.test(processCommand(runner.pid) || ''); i += 1) await new Promise(r => setTimeout(r, 25));
    fs.writeFileSync(path.join(w.live, 'autotrader.lock'), JSON.stringify({ pid: runner.pid }));
    await assert.rejects(runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps: { ...ok, step: async () => assert.fail('no step') } }), new RegExp(`the live runner is running \\(pid ${runner.pid}`));
  } finally {
    runner.kill();
  }
  const lock = path.join(w.run.paths.runDir, 'driver.lock');
  const sleeper = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    // A live lock whose pid is another program (a reused pid) is not a runner: the replay goes on to its own lock.
    fs.writeFileSync(path.join(w.live, 'autotrader.lock'), JSON.stringify({ pid: process.pid }));
    fs.writeFileSync(lock, JSON.stringify({ pid: sleeper.pid }));
    await assert.rejects(runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps: { ...ok, step: async () => assert.fail('no step') } }), /another replay driver/);
  } finally {
    sleeper.kill();
    fs.unlinkSync(path.join(w.live, 'autotrader.lock'));
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999 })); // a dead holder: taken over
  const broken = { ...ok, step: async p => ({ code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: p.kind, ran: [], errors: ['MNQ: HTTP 503'], bars: [{ symbol: 'MNQ', lastBarT: null }] })}` }) };
  const r = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps: broken });
  assert.match(r.stopped, /3 failed cycles in a row/);
  assert.ok(!fs.existsSync(lock), 'released');
  const s = summarize(store.readRun(w.run.paths.runDir).days);
  assert.strictEqual(s.total.failed, 3, 'the report counts them failed, not as a quiet trader');
  // A line written whose manifest update was lost: its time is not run again.
  const m = JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8'));
  assert.strictEqual(store.remaining({ ...m, lastT: null }, [{ t: iso('2026-10-07T13:36:02Z'), day: '2026-10-07' }, { t: iso('2026-10-07T13:39:02Z'), day: '2026-10-07' }], store.recordedTimes(w.run.paths.runDir)).length, 0);
});

test('runner wiring under replay: the server must attest the replayed time; bars closing after it are dropped', async () => {
  const { replayUnattested, closedBarsOnly } = require('../../scripts/lib/runner-wiring');
  const at = iso('2026-10-07T13:33:02Z');
  assert.strictEqual(replayUnattested({ replay: true, serverTime: '2026-10-07T13:33:02.000Z' }, at), null);
  assert.match(replayUnattested({ serverTime: '2026-10-07T13:33:02.000Z' }, at), /not report itself a replay server/);
  assert.match(replayUnattested({ replay: true, serverTime: '2026-10-07T14:33:02.000Z' }, at), /not the replayed time/);
  assert.match(replayUnattested(null, at), /replay server/);
  const client = { closedBars: async () => ['13:27', '13:30', '13:33'].map(m => ({ t: `2026-10-07T${m}:00.000Z` })), other: 1 };
  const wrapped = closedBarsOnly(client, () => at);
  assert.deepStrictEqual((await wrapped.closedBars('MNQ', { minutes: 3 })).map(b => b.t), ['2026-10-07T13:27:00.000Z', '2026-10-07T13:30:00.000Z']);
  assert.strictEqual(wrapped.other, 1);
});

test('driver: a run with prop starts that attempt at the window\'s first moment, before the first decision, once', async () => {
  const { readAttempt } = require('../../scripts/lib/trading/prop-state');
  const w = userWorld({ end: '2026-10-07T19:47:00Z', start: '2026-10-07T19:40:00Z', prop: 'topstep_100k' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const seen = [];
  const deps = {
    serverCheck: async () => null,
    async step(point) {
      seen.push(readAttempt(w.run.paths.runHome, 'topstep_100k'));
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [{ action: 'trade', ok: true, result: 'CYCLE RESULT: no-trade - x' }] })}\n` };
    },
    async trades() { return []; },
  };
  await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps, maxCycles: 1 });
  assert.ok(seen[0], 'the attempt exists at the first decision');
  assert.strictEqual(seen[0].startedAt, '2026-10-07T19:40:00.000Z', 'started at the window\'s start (the replayed time)');
  // Resumed: the same attempt with what it recorded, never restarted.
  const { combineFile, endAttempt } = require('../../scripts/lib/trading/prop-state');
  const file = combineFile(w.run.paths.runHome, 'topstep_100k');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.days.push({ day: '2026-10-06', balance: 100250 });
  fs.writeFileSync(file, JSON.stringify(rec));
  await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps, maxCycles: 1 });
  assert.deepStrictEqual(readAttempt(w.run.paths.runHome, 'topstep_100k').days, [{ day: '2026-10-06', balance: 100250 }], 'a recorded day survives the resume');
  // Ended by the user mid-run: a resume doesn't start a new one.
  endAttempt(w.run.paths.runHome, 'topstep_100k');
  await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.strictEqual(readAttempt(w.run.paths.runHome, 'topstep_100k'), null);
  assert.ok(seen.slice(0, 2).every(a => a && a.startedAt === '2026-10-07T19:40:00.000Z'));
  // Without prop, none; an unknown account or a bad name is a config error.
  const plain = userWorld({ end: '2026-10-07T19:47:00Z', start: '2026-10-07T19:40:00Z' });
  seedRunHome(plain.run, { root: ROOT, userEnv: plain.env });
  await runReplay({ run: plain.run, baseEnv: plain.env, root: ROOT, deps: { ...deps, async step(point) { seen.push('plain'); return deps.step(point); } }, maxCycles: 1 });
  assert.strictEqual(readAttempt(plain.run.paths.runHome, 'topstep_100k'), null);
  assert.throws(() => userWorld({ prop: 'Not A Name' }), /prop: an account profile name/);
  // An unknown profile is refused with the config, before any run state exists.
  assert.throws(() => userWorld({ prop: 'test_7k' }), /prop: unknown account "test_7k"/);
});

test('replay env: a combine replay\'s broker stops the day at the account\'s own daily loss limit; without prop the server keeps its own', () => {
  for (const [prop, want] of [['topstep_100k', '2000'], ['topstep_50k', '1000'], ['topstep_150k', '3000']]) {
    const w = userWorld({ prop, brokerEnv: { maxDailyLoss: 'SIM_MAX_DAILY_LOSS' } });
    seedRunHome(w.run, { root: ROOT, userEnv: w.env });
    assert.strictEqual(replayEnv(w.env, w.run, { at: iso('2026-10-07T13:33:02Z') }).SIM_MAX_DAILY_LOSS, want, prop);
  }
  const plain = userWorld({ brokerEnv: { maxDailyLoss: 'SIM_MAX_DAILY_LOSS' } });
  seedRunHome(plain.run, { root: ROOT, userEnv: plain.env });
  assert.strictEqual(replayEnv(plain.env, plain.run, { at: iso('2026-10-07T13:33:02Z') }).SIM_MAX_DAILY_LOSS, undefined);
  // The default names the backtester's own variable; null leaves it to the server.
  const def = userWorld({ prop: 'topstep_100k' });
  assert.strictEqual(def.run.brokerEnv.maxDailyLoss, 'BACKTESTER_MAX_DAILY_LOSS');
  const off = userWorld({ prop: 'topstep_100k', brokerEnv: { maxDailyLoss: null } });
  seedRunHome(off.run, { root: ROOT, userEnv: off.env });
  assert.ok(!Object.values(replayEnv(off.env, off.run, { at: iso('2026-10-07T13:33:02Z') })).includes('2000'));
});

test('config hash: a run\'s daily loss setting is part of it unless the replay sets it from the account', () => {
  const { configHash } = require('../../scripts/lib/replay/config');
  // The sim broker declares SIM_DATA as its setting; here it is also the variable the driver's maxDailyLoss names.
  const world = over => {
    const w = userWorld({ ...over, brokerEnv: { maxDailyLoss: 'SIM_DATA' } });
    seedRunHome(w.run, { root: ROOT, userEnv: w.env });
    return value => configHash(w.run, { ...w.env, SIM_DATA: value });
  };
  const plain = world({});
  assert.strictEqual(plain('500'), plain('500'));
  assert.notStrictEqual(plain('500'), plain('0'), 'no prop: the user\'s setting is the run\'s');
  const combine = world({ prop: 'topstep_100k' });
  assert.strictEqual(combine('500'), combine('0'), 'prop: the account sets it');
});

test('driver: a step whose cycle made no decision (exit 1: no result line, a failed or timed-out harness) is an attempt: its time runs again, never skipped; the error limit stops the run with it due, and a resume runs it first', async () => {
  const w = userWorld({ end: '2026-10-07T19:47:00Z', start: '2026-10-07T19:40:00Z' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const calls = [];
  let failNext = 0;
  const deps = {
    serverCheck: async () => null,
    async step(point) {
      calls.push(point.t.toISOString().slice(11, 19));
      const failed = failNext > 0;
      if (failed) failNext -= 1;
      const ran = [{ action: 'trade', ok: !failed, result: failed ? 'CYCLE RESULT: (none reported)' : 'CYCLE RESULT: no-trade - x' }];
      return { code: failed ? 1 : 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran })}\n` };
    },
    async trades(env, account, since, until) { return [{ id: calls.length, creationTimestamp: until.toISOString(), since: since.toISOString() }]; },
  };
  // Two failures, then the same time succeeds: one decision, after two attempts.
  failNext = 2;
  const first = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.strictEqual(first.done, true);
  assert.deepStrictEqual(calls, ['19:42:02', '19:42:02', '19:42:02', '19:45:02']);
  const day = store.readRun(w.run.paths.runDir).days['2026-10-07'];
  assert.deepStrictEqual(day.map(l => [l.t.slice(11, 19), (l.retries || []).length, l.ran[0].ok]), [['19:42:02', 2, true], ['19:45:02', 0, true]], 'one line per time; the attempts folded in');
  assert.strictEqual(day[0].since.slice(11, 19), '19:40:00', 'the retry reads the same fills window: no fill is lost or counted twice');
  // The error limit: three failed attempts in a row stop the run, the time still due (the manifest says so).
  const v = userWorld({ end: '2026-10-07T19:47:00Z', start: '2026-10-07T19:40:00Z' });
  seedRunHome(v.run, { root: ROOT, userEnv: v.env });
  calls.length = 0;
  failNext = 3;
  const stopped = await runReplay({ run: v.run, baseEnv: v.env, root: ROOT, deps });
  assert.match(stopped.stopped, /3 failed cycles in a row at 2026-10-07T19:42:02.000Z \(it runs again on resume\)/);
  assert.strictEqual(stopped.done, false);
  const man = store.readRun(v.run.paths.runDir).manifest;
  assert.deepStrictEqual(man.cycleRetry, { t: '2026-10-07T19:42:02.000Z', day: '2026-10-07', kind: 'trade', tries: 3 });
  assert.strictEqual(man.lastT, null, 'no decision done');
  // Labels and the scorecard wait for it: the run isn't finished while a time is due.
  const { unfinishedWhy } = require('../../scripts/lib/replay/labels');
  assert.match(unfinishedWhy(man, store.readRun(v.run.paths.runDir).days), /the cycle at 2026-10-07T19:42:02.000Z failed and that time is still to run again/);
  assert.deepStrictEqual(man.daysDone, []);
  assert.deepStrictEqual(store.readRun(v.run.paths.runDir).days['2026-10-07'], [], 'attempts alone are no decision');
  assert.strictEqual(store.recordedTimes(v.run.paths.runDir).size, 0);
  const second = await runReplay({ run: v.run, baseEnv: v.env, root: ROOT, deps });
  assert.strictEqual(second.done, true);
  assert.deepStrictEqual(calls, ['19:42:02', '19:42:02', '19:42:02', '19:42:02', '19:45:02'], 'the resume runs the due time first');
  const after = store.readRun(v.run.paths.runDir);
  assert.strictEqual(after.manifest.cycleRetry, undefined);
  assert.deepStrictEqual(after.days['2026-10-07'].map(l => (l.retries || []).length), [3, 0]);
  // The report counts each time once and every failed attempt's cycle.
  const total = summarize(after.days).total;
  assert.deepStrictEqual([total.points, total.cycles, total.failed], [2, 5, 3]);
});

test('driver: an end of day whose review fails to the error limit keeps its retry state as it was; the resume runs it again, the clock never going back', async () => {
  const w = userWorld({ end: '2026-10-07T19:53:00Z', start: '2026-10-07T19:40:00Z' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const clocks = [];
  let eodFails = 3;
  const deps = {
    serverCheck: async () => null,
    async step(point) {
      clocks.push([point.kind, JSON.parse(fs.readFileSync(w.run.paths.clockFile, 'utf8')).now]);
      if (point.kind === 'trade') return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: 'trade', ran: [{ action: 'trade', ok: true, result: 'CYCLE RESULT: no-trade - x' }] })}\n` };
      const failed = eodFails > 0;
      if (failed) eodFails -= 1;
      else fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: true }));
      return { code: failed ? 1 : 0, output: `REPLAY STEP ${JSON.stringify({ asked: 'eod', ran: [{ action: 'eod', ok: !failed, result: failed ? 'CYCLE RESULT: error - exit 1' : 'CYCLE RESULT: flattened - day done' }] })}\n` };
    },
    trades: async () => [],
  };
  const first = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.match(first.stopped, /3 failed cycles in a row at 2026-10-07T19:50:00.000Z/);
  const man = store.readRun(w.run.paths.runDir).manifest;
  assert.strictEqual(man.eodRetry, undefined, 'no end-of-day retry queued by the failed tries: the end of day itself is due');
  assert.deepStrictEqual(man.cycleRetry, { t: '2026-10-07T19:50:00.000Z', day: '2026-10-07', kind: 'eod', tries: 3 });
  const second = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.strictEqual(second.done, true);
  assert.deepStrictEqual(clocks.map(c => `${c[0]}@${c[1].slice(11, 19)}`), ['trade@19:42:02', 'trade@19:45:02', 'trade@19:48:02', 'eod@19:50:00', 'eod@19:50:00', 'eod@19:50:00', 'eod@19:50:00']);
  for (let i = 1; i < clocks.length; i += 1) assert.ok(clocks[i][1] >= clocks[i - 1][1], `the clock went back at ${i}`);
});

test('store: setTrades sets the fills of a time\'s line, never of a failed attempt at that time', () => {
  const dir = tmpDir();
  const paths = { runDir: dir, manifest: path.join(dir, 'manifest.json') };
  const m = { lastT: null, daysDone: [] };
  const t = '2026-10-07T14:00:02.000Z';
  store.appendAttempt(paths, m, { t, day: '2026-10-07', kind: 'trade', ran: [{ action: 'trade', ok: false }], trades: [], since: 'a' }, 1);
  store.appendRecord(paths, m, { t, day: '2026-10-07', kind: 'trade', ran: [{ action: 'trade', ok: true }], trades: [], since: 'a' });
  assert.strictEqual(store.setTrades(paths, '2026-10-07', t, [{ id: 1 }], 'b'), true);
  const raw = fs.readFileSync(path.join(dir, '2026-10-07.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(raw.map(r => [Boolean(r.retried), r.trades, r.since]), [[true, [], 'a'], [false, [{ id: 1 }], 'b']]);
});

test('driver: the agent\'s own CYCLE RESULT: error is a decision - recorded as live records it and never retried; three in a row stop the run as live trips its kill switch', async () => {
  const { cycleOutcome, runResult } = require('../../scripts/lib/autotrader');
  const { passTap } = require('../../scripts/lib/session/record');
  // What a replay step reports for it: the runner's cycle_end through the session tap (as live records it).
  const res = { ok: true, timedOut: false, code: 0, output: 'CYCLE RESULT: error - the account read failed\n', stdout: 'CYCLE RESULT: error - the account read failed\n' };
  const out = cycleOutcome(res, { result: runResult(res), intact: true, action: 'trade' });
  assert.deepStrictEqual([out.ok, out.agentError], [false, true]);
  const tap = passTap();
  tap.event(() => {})({ kind: 'cycle_end', action: 'trade', ok: out.ok, timedOut: false, result: out.result, agentError: out.agentError });
  const ran = tap.summary([]).ran;
  assert.deepStrictEqual(ran, [{ action: 'trade', ok: false, timedOut: false, result: 'CYCLE RESULT: error - the account read failed', symbols: null, agentError: true }]);
  const w = userWorld({ end: '2026-10-07T19:53:00Z', start: '2026-10-07T19:40:00Z' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const calls = [];
  const deps = {
    serverCheck: async () => null,
    // The step exits 0 for it (autotrader.js replayStep: only a cycle with no decision exits 1).
    // (Judged by what ran, not the exit: a step that exits 1 with only an agent's error still made its decision.)
    async step(point) { calls.push(point.t.toISOString().slice(11, 19)); return { code: calls.length === 2 ? 1 : 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran })}\n` }; },
    trades: async () => [],
  };
  const r = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.match(r.stopped, /3 failed cycles in a row at 2026-10-07T19:48:02.000Z/);
  assert.deepStrictEqual(calls, ['19:42:02', '19:45:02', '19:48:02'], 'each time once: no retry');
  const raw = fs.readFileSync(path.join(w.run.paths.runDir, '2026-10-07.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(raw.map(l => [Boolean(l.retried), l.ran[0].agentError, l.ran[0].ok]), [[false, true, false], [false, true, false], [false, true, false]]);
  const man = store.readRun(w.run.paths.runDir).manifest;
  assert.deepStrictEqual([man.cycleRetry, man.lastT], [undefined, '2026-10-07T19:48:02.000Z']);
});

test('driver: a decision with no premarket plan (the day\'s premarket failed until the session opened) says so on its line', async () => {
  const w = userWorld({ end: '2026-10-07T19:47:00Z', start: '2026-10-07T19:40:00Z' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const missing = { at: '2026-10-07T13:30:00.000Z', tries: 4 };
  const deps = {
    serverCheck: async () => null,
    async step(point) { return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [{ action: 'trade', ok: true, result: 'CYCLE RESULT: no-trade - x' }], state: { day: point.day, premarketUnavailable: missing, premarketRetryStarved: 3 } })}\n` }; },
    trades: async () => [],
  };
  await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  const day = store.readRun(w.run.paths.runDir).days['2026-10-07'];
  assert.ok(day.length && day.every(l => JSON.stringify(l.premarketUnavailable) === JSON.stringify(missing)));
  assert.ok(day.every(l => l.premarketRetryStarved === 3), 'the starved retries counted on the line');
});

test('noDecision: only a cycle with no decision runs its time again - never the agent\'s error result or a premarket\'s failure', () => {
  const { noDecision } = require('../../scripts/lib/session/record');
  assert.strictEqual(noDecision([{ action: 'trade', ok: false }]), true);
  assert.strictEqual(noDecision([{ action: 'trade', ok: true }, { action: 'premarket', ok: false, timedOut: true }]), false, 'a premarket\'s failure never, as live');
  assert.strictEqual(noDecision([{ action: 'manage', ok: false, timedOut: true }]), true);
  assert.strictEqual(noDecision([{ action: 'trade', ok: false, agentError: true }]), false);
  assert.strictEqual(noDecision([{ action: 'trade', ok: true }, { action: 'premarket', ok: false, premarketRetry: true }]), false);
  assert.strictEqual(noDecision([]), false);
});

test('driver: a premarket retry that fails after a pass\'s trade cycle is no failed cycle - recorded, never retried, never toward the error limit', async () => {
  const w = userWorld({ end: '2026-10-07T19:53:00Z', start: '2026-10-07T19:40:00Z' });
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const calls = [];
  const ran = [{ action: 'trade', ok: true, result: 'CYCLE RESULT: no-trade - x' }, { action: 'premarket', ok: false, result: 'CYCLE RESULT: (none reported)', premarketRetry: true }];
  const deps = {
    serverCheck: async () => null,
    async step(point) {
      calls.push(point.kind);
      if (point.kind !== 'trade') fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: true }));
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: point.kind === 'trade' ? ran : [] })}\n` };
    },
    trades: async () => [],
  };
  const r = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
  assert.deepStrictEqual([r.done, r.stopped], [true, null], 'three such passes in a row stop nothing');
  assert.deepStrictEqual(calls, ['trade', 'trade', 'trade', 'eod']);
  assert.ok(store.readRun(w.run.paths.runDir).days['2026-10-07'].every(l => !l.retries));
});

test('driver: a failing premarket (no result line, or the agent\'s own error) is no failed cycle, as live - never stops the run, never runs its time again', async () => {
  const { failedRun } = require('../../scripts/lib/session/record');
  for (const pre of [{ action: 'premarket', ok: false, result: 'CYCLE RESULT: (none reported)' }, { action: 'premarket', ok: false, result: 'CYCLE RESULT: error - no calendar', agentError: true }]) {
    assert.strictEqual(failedRun(pre), false);
    const w = userWorld({ end: '2026-10-07T19:53:00Z', start: '2026-10-07T19:40:00Z' });
    seedRunHome(w.run, { root: ROOT, userEnv: w.env });
    const calls = [];
    const deps = {
      serverCheck: async () => null,
      async step(point) {
        calls.push(point.kind);
        if (point.kind !== 'trade') fs.writeFileSync(path.join(w.run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: true }));
        // Each pass ran a failing premarket (the first try, or the agent's error), alone: the step exits 0 for it.
        return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: point.kind === 'trade' ? [pre] : [] })}\n` };
      },
      trades: async () => [],
    };
    const r = await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps });
    assert.deepStrictEqual([r.done, r.stopped], [true, null], pre.result);
    assert.deepStrictEqual(calls, ['trade', 'trade', 'trade', 'eod'], 'each time once');
    assert.strictEqual(summarize(store.readRun(w.run.paths.runDir).days).total.failed, 3, 'the report still counts the failed runs');
  }
  const { noDecision } = require('../../scripts/lib/session/record');
  assert.strictEqual(noDecision([{ action: 'premarket', ok: false }]), false, 'the step exits 0 for it');
});

test('config hash: the replay broker\'s fingerprint allowlist is part of the run, a credential never', () => {
  const w = userWorld();
  const file = path.join(w.live, 'brokers.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.brokers.sim = { ...doc.brokers.sim, env: ['SIM_DATA', 'SIM_BARS_A', 'SIM_API_KEY'], fingerprintEnv: ['SIM_BARS_A', 'SIM_API_KEY'] };
  fs.writeFileSync(file, JSON.stringify(doc));
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const env = { ...w.env, SIM_BARS_A: 'true', SIM_API_KEY: 'k1' };
  assert.notStrictEqual(configHash(w.run, env), configHash(w.run, { ...env, SIM_BARS_A: 'false' }), 'a bar setting on the allowlist is part of the run');
  assert.strictEqual(configHash(w.run, env), configHash(w.run, { ...env, SIM_API_KEY: 'k2' }), 'a credential is not, listed or read');
  assert.notStrictEqual(configHash(w.run, env), configHash(w.run, { ...env, SIM_DATA: '/other' }), 'its other settings still are');
  // A run started before the allowlist existed keeps its hash: the list itself is no part of it (its values are).
  const runBrokers = path.join(w.run.paths.runHome, 'brokers.json');
  const seeded = JSON.parse(fs.readFileSync(runBrokers, 'utf8'));
  const withList = configHash(w.run, env);
  delete seeded.brokers.sim.fingerprintEnv;
  fs.writeFileSync(runBrokers, JSON.stringify(seeded));
  assert.strictEqual(configHash(w.run, env), withList, 'the same hash with and without fingerprintEnv on the entry');
});

test('driver: a run home salt that can\'t be read is logged once and recorded as fingerprintError, never a silent null', async () => {
  const w = userWorld({ end: '2026-10-07T19:50:00Z', start: '2026-10-07T19:40:00Z', endOfDay: false });
  const file = path.join(w.live, 'brokers.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.brokers.sim = { ...doc.brokers.sim, env: ['SIM_DATA', 'SIM_BARS_A'], fingerprintEnv: ['SIM_BARS_A'] };
  fs.writeFileSync(file, JSON.stringify(doc));
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  fs.writeFileSync(path.join(w.run.paths.runHome, 'fingerprint.salt'), 'corrupt');
  const deps = {
    serverCheck: async () => null,
    async step(point) { return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [{ action: 'trade', ok: true, result: 'CYCLE RESULT: no-trade - x' }] })}\n` }; },
    async trades() { return []; },
  };
  const said = [];
  const res = await runReplay({ run: w.run, baseEnv: { ...w.env, SIM_BARS_A: 'true' }, root: ROOT, deps, log: msg => said.push(msg) });
  assert.ok(res.cycles >= 2, String(res.cycles));
  const man = store.readRun(w.run.paths.runDir).manifest;
  assert.strictEqual(man.fingerprints.broker, null);
  assert.match(man.fingerprints.fingerprintError, /broker sim: its bar settings can't be fingerprinted \(.*not a fingerprint salt/);
  assert.strictEqual(said.filter(m => /ERROR .*fingerprintError/.test(m)).length, 1, 'logged once for the run');
});

test('runner wiring: a live run needs the server\'s apiUrl; its cycles carry FTH_ACCOUNT_LOCK; a manual end of day runs with "none"; the configured API is checked before the server starts', async () => {
  const L = require('../../scripts/lib/account-lock');
  const { manualRunBroker } = require('../../scripts/lib/runner-wiring');
  const broker = { name: 'live', allowedAccountsEnv: 'LIVE_ALLOWED', apiUrlEnv: 'LIVE_API_URL', env: ['LIVE_ALLOWED', 'LIVE_API_URL'], command: ['srv-a'] };
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-locks-'));
  const envOf = () => ({ LIVE_ALLOWED: '7', FTH_LOCK_DIR: locks, FTH_TEST_LOCKS: '1', LIVE_API_URL: 'https://api.example.test' });
  const opened = [];
  const fake = cfg => () => { opened.push(1); return { verify: async () => {}, serverConfig: async () => ({ tradingEnabled: true, allowedAccountIds: [7], ...cfg }), close: () => {} }; };
  const noApi = envOf();
  await assert.rejects(openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: noApi, broker, open: fake({}) }), /reports no apiUrl .*a live run refuses/);
  await assert.rejects(openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: envOf(), broker, open: fake({ apiUrl: 'not a url' }) }), /reports no apiUrl that is a URL with a host \(get_server_config: "not a url"\)/);
  assert.deepStrictEqual(fs.readdirSync(locks), [], 'no lock taken');
  assert.strictEqual(noApi.FTH_ACCOUNT_LOCK, undefined);
  const env = envOf();
  const client = await openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env, broker, open: fake({ apiUrl: 'https://api.example.test' }) });
  const spec = JSON.parse(env.FTH_ACCOUNT_LOCK);
  assert.strictEqual(spec.files.length, 2);
  assert.strictEqual(L.lockGateRefusal(env.FTH_ACCOUNT_LOCK, '7'), null, 'held');
  assert.strictEqual(spec.account, '7');
  assert.strictEqual(await client.ensureLock({ stableMs: 0 }), 'held');
  client.close();
  assert.deepStrictEqual(fs.readdirSync(locks), []);
  // Another install of the server (another command) on the same configured API, while a live runner holds that
  // API's lock: refused before it is started.
  const runner = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/x/scripts/autotrader.js'], { stdio: 'ignore' });
  const apiFile = L.lockFileFor({ env: envOf(), server: 'api:https://api.example.test', accountId: '7' });
  try {
    fs.writeFileSync(apiFile, JSON.stringify({ pid: runner.pid, host: os.hostname(), home: '/homes/a', api: 'https://api.example.test', token: 't' }));
    const before = opened.length;
    await assert.rejects(openRunnerBroker({ cfg: { account: '7', paper: false }, root: ROOT, env: envOf(), broker: { ...broker, name: 'copy', command: ['srv-b'] }, open: fake({ apiUrl: 'https://api.example.test' }) }), new RegExp(`account 7 on broker "copy" is already traded by another runner \\(pid ${runner.pid}`));
    assert.strictEqual(opened.length, before, 'never started');
  } finally {
    runner.kill();
    fs.rmSync(apiFile, { force: true });
  }
  const eod = envOf();
  assert.strictEqual(await manualRunBroker({ cfg: { account: '7', paper: false }, once: 'eod', root: ROOT, env: eod, broker, open: fake({}) }), null);
  assert.strictEqual(eod.FTH_ACCOUNT_LOCK, 'none');
  assert.match(L.lockGateRefusal(eod.FTH_ACCOUNT_LOCK), /without its account's runner lock/);
  const paper = envOf();
  assert.strictEqual(await manualRunBroker({ cfg: { account: '7', paper: true }, once: 'eod', root: ROOT, env: paper, broker, open: fake({}) }), null);
  assert.strictEqual(paper.FTH_ACCOUNT_LOCK, undefined, 'paper: the gate refuses entries anyway');
});


test('replay config: setup-focused practice is the replay config\'s own field, validated, carried into the runner config and the run\'s hash', () => {
  const plain = userWorld();
  seedRunHome(plain.run, { root: ROOT, userEnv: plain.env });
  assert.strictEqual(plain.run.practice, null);
  assert.ok(!('practice' in plain.run.cfg), 'none: the runner config is as before');
  const w = { env: plain.env, run: resolveReplay(replayConfig(plain.dir, { practice: { seed: 4, quietSample: 0.2 } }), { env: plain.env, home: plain.dir, root: ROOT }) };
  const want = { mode: 'setup-focus', setupTf: 15, quietSample: 0.2, seed: 4, levels: 'key', reactions: ['rejected', 'broke'] };
  assert.deepStrictEqual(w.run.practice, want);
  assert.deepStrictEqual(w.run.cfg.practice, want, 'the runner reads it from its config');
  assert.notStrictEqual(configHash(w.run, w.env), configHash(plain.run, plain.env), 'a setup-focused run is another run');
  const dir = tmpDir();
  assert.throws(() => resolveReplay(replayConfig(dir, { practice: { setupTf: 4 } }), { env: {}, home: dir, root: ROOT }), /practice.setupTf/);
  assert.throws(() => resolveReplay(replayConfig(dir, { overrides: { practice: {} } }), { env: {}, home: dir, root: ROOT }), /practice: set in the replay config/);
  const auto = { ...replayConfig(dir).autotrader, practice: {} };
  assert.throws(() => resolveReplay(replayConfig(dir, { autotrader: auto }), { env: {}, home: dir, root: ROOT }), /practice: set in the replay config/);
});

test('replay env: the account\'s limits go into the variables the replay broker\'s brokers.json entry names; a live broker and a run with no account get none', () => {
  const at = iso('2026-10-07T13:33:02Z');
  const ACCT = require('../../scripts/lib/trading/accounts').loadAccounts(ROOT, {}).accounts.find(a => a.valid && a.daily_loss_limit > 0).name;
  const names = { dailyLoss: 'SIM_DAILY', maxOrderSize: 'SIM_ORDER', maxPositionSize: 'SIM_POSITION' };
  const withLimits = w => fs.writeFileSync(path.join(w.live, 'brokers.json'), JSON.stringify({ brokers: {
    sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL', env: ['SIM_DATA'], limits: names },
    live: { command: [process.execPath, '/opt/live/server.js'], env: ['LIVE_API_KEY'], entryEnv: 'LIVE_ENTRY', journalEnv: 'LIVE_JOURNAL', limits: names },
  } }));
  const w = userWorld({ prop: ACCT });
  withLimits(w);
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const { accountLimits, accountNamed } = require('../../scripts/lib/trading/accounts');
  const want = accountLimits(accountNamed(ROOT, ACCT, w.env), w.run.cfg.symbols);
  assert.ok(want.maxOrderSize > 1 && want.dailyLoss > 0, JSON.stringify(want));
  const env = replayEnv(w.env, w.run, { at });
  assert.deepStrictEqual([env.SIM_DAILY, env.SIM_ORDER, env.SIM_POSITION], [String(want.dailyLoss), String(want.maxOrderSize), String(want.maxPositionSize)]);
  // No prop account: the policy strategy's account (a learning run's own) gives them.
  const plain = userWorld();
  withLimits(plain);
  seedRunHome(plain.run, { root: ROOT, userEnv: plain.env });
  const own = replayEnv(plain.env, plain.run, { at });
  assert.ok(Number(own.SIM_DAILY) > 0 && Number(own.SIM_ORDER) > 1 && own.SIM_ORDER === own.SIM_POSITION, JSON.stringify(own));
  // No mapping in the broker's entry: nothing is set.
  const unmapped = userWorld({ prop: ACCT });
  seedRunHome(unmapped.run, { root: ROOT, userEnv: unmapped.env });
  const bare = replayEnv(unmapped.env, unmapped.run, { at });
  assert.deepStrictEqual([bare.SIM_DAILY, bare.SIM_ORDER, bare.SIM_POSITION], [undefined, undefined, undefined]);
  // A live broker is unaffected: the account's limits are never put into its variables (the driver refuses a live broker).
  const liveEnv = replayEnv(w.env, { ...w.run, broker: 'live' }, { at });
  assert.deepStrictEqual([liveEnv.SIM_DAILY, liveEnv.SIM_ORDER, liveEnv.SIM_POSITION], [undefined, undefined, undefined]);
});

test('replay config: the limits are the run\'s account\'s (prop, else the policy\'s), taken once; per-symbol caps give the strictest', () => {
  const { accountLimits, loadAccounts } = require('../../scripts/lib/trading/accounts');
  const accounts = loadAccounts(ROOT, {}).accounts.filter(a => a.valid && a.daily_loss_limit > 0);
  const policy = require('../../scripts/lib/trading/strategies').loadStrategies(ROOT, {}).strategies.find(s => s.signal === 'policy' && s.status === 'active');
  const mine = accounts.find(a => a.name === policy.account);
  const other = accounts.find(a => a.name !== mine.name && a.daily_loss_limit !== mine.daily_loss_limit);
  assert.ok(mine && other);
  // --prop X with a policy on account Y: X's limits, not Y's.
  const viaProp = userWorld({ prop: other.name }).run;
  assert.deepStrictEqual(viaProp.limits, accountLimits(other, viaProp.cfg.symbols));
  assert.strictEqual(viaProp.limits.dailyLoss, other.daily_loss_limit);
  // No prop: the policy's account.
  const plain = userWorld().run;
  assert.strictEqual(plain.limits.dailyLoss, mine.daily_loss_limit);
  assert.notStrictEqual(plain.limits.dailyLoss, viaProp.limits.dailyLoss);
});

test('replay config: more than one active policy naming different accounts is refused, so load order never decides', () => {
  const root = tmpDir();
  fs.cpSync(path.join(ROOT, 'accounts'), path.join(root, 'accounts'), { recursive: true });
  const src = path.join(ROOT, 'strategies', 'prop_portfolio');
  fs.cpSync(src, path.join(root, 'strategies', 'prop_portfolio'), { recursive: true });
  fs.cpSync(src, path.join(root, 'strategies', 'prop_portfolio_two'), { recursive: true });
  const two = path.join(root, 'strategies', 'prop_portfolio_two', 'STRATEGY.md');
  const first = fs.readFileSync(path.join(src, 'STRATEGY.md'), 'utf8');
  const acct = /^account:\s*(\S+)/m.exec(first)[1];
  const another = fs.readdirSync(path.join(ROOT, 'accounts')).find(n => n !== acct && fs.existsSync(path.join(ROOT, 'accounts', n, 'ACCOUNT.md')));
  fs.writeFileSync(two, first.replace(/^name:.*$/m, 'name: prop_portfolio_two').replace(/^account:.*$/m, `account: ${another}`));
  const dir = tmpDir();
  const env = { FTH_HOME: path.join(dir, 'live') };
  assert.throws(() => resolveReplay(replayConfig(dir), { env, home: dir, root }), /more than one active policy strategy names an account/);
  // The run's own account settles it: the policies are not consulted.
  assert.doesNotThrow(() => resolveReplay(replayConfig(dir, { prop: another }), { env, home: dir, root }));
  // The same account on both is not a conflict.
  fs.writeFileSync(two, first.replace(/^name:.*$/m, 'name: prop_portfolio_two'));
  assert.strictEqual(resolveReplay(replayConfig(dir), { env, home: dir, root }).limits.dailyLoss > 0, true);
});

test('config hash: the limits mapping in brokers.json and the account file (accounts/) are part of the run', () => {
  const w = userWorld({ prop: require('../../scripts/lib/trading/accounts').loadAccounts(ROOT, {}).accounts.find(a => a.valid && a.daily_loss_limit > 0).name });
  const names = { dailyLoss: 'SIM_DAILY', maxOrderSize: 'SIM_ORDER', maxPositionSize: 'SIM_POSITION' };
  const write = limits => fs.writeFileSync(path.join(w.live, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL', env: ['SIM_DATA'], limits } } }));
  write(names);
  seedRunHome(w.run, { root: ROOT, userEnv: w.env });
  const runBrokers = path.join(w.run.paths.runHome, 'brokers.json');
  const before = configHash(w.run, w.env);
  const seeded = JSON.parse(fs.readFileSync(runBrokers, 'utf8'));
  seeded.brokers.sim.limits = { ...names, maxOrderSize: 'SIM_ORDER_2' };
  fs.writeFileSync(runBrokers, JSON.stringify(seeded));
  assert.notStrictEqual(configHash(w.run, w.env), before, 'a different variable for a limit is another run');
  seeded.brokers.sim.limits = names;
  fs.writeFileSync(runBrokers, JSON.stringify(seeded));
  assert.strictEqual(configHash(w.run, w.env), before);
  // The limits come from the account file, which accounts/ puts in the hash: an edit there is another run.
  const root = tmpDir();
  fs.cpSync(path.join(ROOT, 'accounts'), path.join(root, 'accounts'), { recursive: true });
  const file = path.join(root, 'accounts', fs.readdirSync(path.join(root, 'accounts'))[0], 'ACCOUNT.md');
  const run = { ...w.run, root };
  const h = configHash(run, w.env);
  fs.appendFileSync(file, '\n<!-- edited -->\n');
  assert.notStrictEqual(configHash(run, w.env), h, 'the account file is in the hash');
});

test('a fresh run with an opt-in Claude head prompt (headSkillsInPrompt) starts: the preflight\'s probe, then the seed of its fresh home (the order scripts/replay.js runs them), as a learning run would', () => {
  const dir = tmpDir();
  const base = replayConfig(dir).autotrader;
  const w = userWorld({ autotrader: { ...base, harness: 'claude', command: undefined, headSkillsInPrompt: true } });
  assert.strictEqual(w.run.cfg.headSkillsInPrompt, true);
  // The training preflight's no-web check builds the step's env and argv first (web-access.js replayStep).
  require('../../scripts/lib/replay/web-access').replayStep(w.run, { root: ROOT, env: w.env });
  assert.strictEqual(fs.existsSync(w.run.paths.runHome), false, 'the preflight wrote into the run home');
  // Then the run home is seeded: it must still be fresh (a non-empty folder without a manifest is refused).
  assert.doesNotThrow(() => seedRunHome(w.run, { root: ROOT, userEnv: w.env }));
});

test('cycleDataInPrompt is part of what makes a run a run: absent, nothing is added; on, every hash and the setup record tell it apart', () => {
  const RC = require('../../scripts/lib/replay/config');
  const AB = require('../../scripts/lib/train/ab-compare');
  const base = replayConfig(tmpDir()).autotrader;
  const world = extra => userWorld({ autotrader: { ...base, harness: 'claude', command: undefined, ...extra } });
  const off = world({});
  seedRunHome(off.run, { root: ROOT, userEnv: off.env });
  const on = world({ cycleDataInPrompt: true });
  assert.ok(!('cycleDataInPrompt' in off.run.cfg), 'absent stays absent (no default written)');
  assert.strictEqual(on.run.cfg.cycleDataInPrompt, true);
  // The same run but for the key (two worlds differ in their folders, so one run is compared with the key added).
  const withKey = run => ({ ...run, cfg: { ...run.cfg, cycleDataInPrompt: true } });
  for (const [name, fn] of [['configHash', x => RC.configHash(x, off.env)], ['setupHash', RC.setupHash], ['setupBase', RC.setupBase], ['setupFixed', RC.setupFixed]]) {
    assert.notStrictEqual(fn(withKey(off.run)), fn(off.run), name);
    assert.strictEqual(fn({ ...off.run, cfg: { ...off.run.cfg } }), fn(off.run), `${name}: stable`);
  }
  // The setup record names it (cfg.cycleDataInPrompt): an A/B comparison refuses the pair unless it is the declared field.
  const recOff = AB.setupRecord(off.run, { env: off.env });
  const recOn = AB.setupRecord(withKey(off.run), { env: off.env });
  assert.ok(!('cfg.cycleDataInPrompt' in recOff.config));
  assert.strictEqual(recOn.config['cfg.cycleDataInPrompt'], 'true');
  const cmp = AB.compareSetups(recOff, recOn, {});
  assert.strictEqual(cmp.ok, false);
  assert.ok(cmp.refusals.some(x => /cfg\.cycleDataInPrompt/.test(x)), JSON.stringify(cmp.refusals));
});
