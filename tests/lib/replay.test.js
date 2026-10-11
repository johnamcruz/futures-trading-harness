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
const { seedRunHome, runReplay, withEntry, EOD_RETRIES } = require('../../scripts/lib/replay/driver');
const { specFor } = require('../../scripts/lib/trading/contracts');
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
  const h = w.run.paths.runHome;
  assert.deepStrictEqual([env.FTH_GATE_LOG, env.FTH_KILL_SWITCH_FILE, env.FTH_BLACKOUTS_FILE, env.FTH_BROKERS_FILE, env.FTH_ENV_FILE],
    [path.join(h, 'logs', 'gate-log.jsonl'), path.join(h, 'STOP'), path.join(h, 'blackouts', 'blackouts.json'), path.join(h, 'brokers.json'), path.join(h, '.env')]);
  // A child loads .env files (its own FTH_HOME's and the repo's) without overriding what is set: a repo .env
  // pointing at the live home, or carrying live credentials, changes nothing.
  const repoEnv = path.join(w.dir, 'repo.env');
  fs.writeFileSync(repoEnv, `FTH_KILL_SWITCH_FILE=${w.live}/STOP\nFTH_GATE_LOG=${w.live}/gate.jsonl\nFTH_BLACKOUTS_FILE=${w.live}/b.json\nFTH_BROKERS_FILE=${w.live}/brokers.json\nFTH_ENV_FILE=${w.live}/.env\nFTH_ORDER_GATE_SKIP=mtf-trend\nFTH_PAPER=1\nLIVE_API_KEY=k\nPROJECTX_MCP_ENTRY=/live/server.js\n`);
  const child = { ...env };
  require('../../scripts/lib/env-file').loadEnvFiles({ env: child, files: [repoEnv] });
  assert.deepStrictEqual(child, env, 'nothing filled in');
  // Live brokers' variables (the user's and the shipped topstepx's) are set to a dead value, so no .env fills them.
  for (const k of ['LIVE_API_KEY', 'LIVE_ENTRY', 'LIVE_JOURNAL', 'PROJECTX_API_KEY', 'PROJECTX_MCP_ENTRY']) assert.strictEqual(env[k], DISABLED, k);
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
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).cycles, 0, 'nothing left');
  // A run left with nothing to do (all ran, its flag lost): marked finished on that pass too.
  const m = JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8'));
  delete m.finished;
  fs.writeFileSync(w.run.paths.manifest, JSON.stringify(m));
  assert.strictEqual((await runReplay({ run: w.run, baseEnv: w.env, root: ROOT, deps })).done, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(w.run.paths.manifest, 'utf8')).finished, true);
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
