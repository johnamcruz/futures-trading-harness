'use strict';

// The replay server's days without source data (scripts/lib/replay/data-gaps.js; get_server_config `dataGaps`, replay
// only): no decision time on them, no session of a combine attempt, pinned per run, a server without the field unchanged;
// the training preflight's data-gaps check; the interface's shape check.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const DG = require('../../scripts/lib/replay/data-gaps');
const { decisionPoints, tradingDays, NO_SOURCE_DATA } = require('../../scripts/lib/replay/schedule');
const prop = require('../../scripts/lib/trading/prop-state');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const { validateResult, dataGapsOk } = require('../../scripts/lib/broker/interface');
const { tmpDir: tmp } = require('../helpers');

const REPO = path.join(__dirname, '..', '..');
const POLICY_ACCOUNT = loadStrategies(REPO, {}).strategies.find(s => s.name === 'prop_portfolio').account;
const ACCOUNT = accountNamed(REPO, POLICY_ACCOUNT, {});
const GAP = '2022-03-04'; // a Friday
// A server's dataGaps entries: a day with no bars at all, and one with bars but no order flow.
const dead = day => ({ day, bars: false, flow: false });
const flowless = day => ({ day, bars: true, flow: false });

function world() {
  const { resolveReplay } = require('../../scripts/lib/replay/config');
  const dir = tmp();
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL' } } }));
  const env = { PATH: process.env.PATH, HOME: dir, FTH_HOME: live, FTH_BROKERS_FILE: path.join(live, 'brokers.json') };
  // Tuesday 2022-03-01 to Friday 2022-03-18 (practice-train): fourteen trading days; a narrow session, four bars a day.
  const raw = o => ({
    runId: 'gap1', workDir: path.join(dir, 'replays'), broker: 'sim', start: '2022-03-01T00:00:00Z', end: '2022-03-19T00:00:00Z', premarket: false, endOfDay: false, stage: 2,
    autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-09:40@America/New_York'], eodAt: '15:50@America/New_York' },
    combine: { account: POLICY_ACCOUNT, attempts: ['2022-03-01'], maxSessions: 10 }, ...o,
  });
  return { dir, env, raw, resolve: o => resolveReplay(raw(o), { baseDir: dir, env, home: dir, root: REPO }) };
}

const daysOf = points => [...new Set(points.map(p => p.day))];

test('decisionPoints and tradingDays: a day of dataGaps has no decision time and says why; none given, nothing changes', () => {
  const run = world().resolve({ combine: undefined, stage: undefined, learning: false });
  const opts = { start: run.start, end: run.end };
  const plain = decisionPoints(run.cfg, opts);
  assert.ok(daysOf(plain).includes(GAP));
  const skipped = decisionPoints(run.cfg, { ...opts, dataGaps: [GAP] });
  assert.deepStrictEqual(daysOf(skipped), daysOf(plain).filter(d => d !== GAP));
  assert.deepStrictEqual(skipped.map(p => p.t.toISOString()), plain.filter(p => p.day !== GAP).map(p => p.t.toISOString()), 'every other day as before');
  assert.strictEqual(tradingDays(run.cfg, { ...opts, dataGaps: [GAP] }).find(d => d.day === GAP).skipped, NO_SOURCE_DATA);
  assert.strictEqual(NO_SOURCE_DATA, 'no source data on the replay server; skipped (not a session)');
  // Absent (an older server), null or empty: the same points as without.
  for (const dataGaps of [undefined, null, []]) assert.deepStrictEqual(decisionPoints(run.cfg, { ...opts, dataGaps }).map(p => p.t.getTime()), plain.map(p => p.t.getTime()));
  // A weekend or holiday keeps its own reason.
  assert.strictEqual(tradingDays(run.cfg, { ...opts, dataGaps: ['2022-03-06'] }).find(d => d.day === '2022-03-06').skipped, 'no session (weekend)');
});

test('gapsOf: the run\'s session days every traded root has no bars on, inside its window; bars without flow are traded, noted; absent and malformed fields skip nothing', () => {
  const run = world().resolve({ combine: undefined, stage: undefined, learning: false });
  const none = { days: [], flowOnly: [] };
  assert.deepStrictEqual(DG.gapsOf({ replay: true }, run), { present: false, malformed: false, ...none });
  assert.deepStrictEqual(DG.gapsOf({ dataGaps: { NQ: [dead(GAP)], MNQ: [dead(GAP), dead('2022-03-06'), dead('2022-02-25'), dead('2022-03-25'), dead('2022-03-10'), flowless('2022-03-08')] } }, run),
    { present: true, malformed: false, days: [GAP, '2022-03-10'], flowOnly: ['2022-03-08'] }, 'a weekend and days outside the window are not the run\'s');
  assert.deepStrictEqual(DG.gapsOf({ dataGaps: { NQ: [dead(GAP)] } }, run).days, [], 'a root the list does not name has its data');
  assert.deepStrictEqual(DG.gapsOf({ dataGaps: { MNQ: [flowless(GAP)] } }, run), { present: true, malformed: false, days: [], flowOnly: [GAP] }, 'bars without flow: never skipped');
  assert.deepStrictEqual(DG.gapsOf({ dataGaps: {} }, run), { present: true, malformed: false, ...none });
  // Two symbols: a day is skipped only when both have no bars; one with bars on it trades it.
  const two = { ...run, cfg: { ...run.cfg, symbols: ['MNQ', 'MES:2022-03'] } };
  assert.deepStrictEqual(DG.gapsOf({ dataGaps: { MNQ: [dead(GAP), dead('2022-03-10')], MES: [dead('2022-03-10'), flowless(GAP)] } }, two), { present: true, malformed: false, days: ['2022-03-10'], flowOnly: [GAP] });
  for (const bad of [[GAP], { MNQ: GAP }, { MNQ: [GAP] }, { MNQ: [dead('2022-02-30')] }, { MNQ: [{ day: GAP, bars: 'no', flow: false }] }, { MNQ: [{ day: GAP, bars: false }] }, { 'mnq x': [dead(GAP)] }, null]) {
    assert.deepStrictEqual(DG.gapsOf({ dataGaps: bad }, run), { present: true, malformed: true, ...none }, JSON.stringify(bad));
  }
});

test('the interface: dataGaps is an optional, replay-only field of get_server_config, shape-checked where present', () => {
  const base = { tradingEnabled: true, allowedAccountIds: [1], allowedSymbols: 'any', maxOrderSize: 5, maxPositionSize: 5, maxDailyLoss: 'off', journalPath: '/j', tradingDayStartedAt: 'x', serverTime: 'y' };
  assert.deepStrictEqual(validateResult('get_server_config', base), []);
  assert.deepStrictEqual(validateResult('get_server_config', { ...base, dataGaps: { NQ: [dead(GAP), flowless('2022-03-08')], MNQ: [] } }), []);
  assert.deepStrictEqual(validateResult('get_server_config', { ...base, dataGaps: { NQ: [GAP] } }), ['get_server_config: dataGaps is malformed']);
  assert.strictEqual(dataGapsOk({ NQ: [flowless('2023-08-25'), dead('2023-09-04')] }), true);
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'BROKER-MCP-INTERFACE.md'), 'utf8');
  assert.match(doc, /`dataGaps` \(optional, replay only\)/);
  assert.match(doc, /`bars: true, flow: false` is a day with bars but no order\s+flow/);
});

test('applyGaps: a 10-session combine attempt over a window with one gap day runs 10 replayable sessions, its window a day longer', () => {
  const w = world();
  const run = w.resolve({});
  const before = run.combine.attempts[0];
  assert.deepStrictEqual([before.days.length, before.days.includes(GAP), before.last], [10, true, '2022-03-14']);
  DG.applyGaps(run, [GAP], { root: REPO, env: w.env });
  const a = run.combine.attempts[0];
  assert.deepStrictEqual([a.days.length, a.days.includes(GAP), a.last], [10, false, '2022-03-15']);
  assert.deepStrictEqual(run.dataGaps, [GAP]);
  // An attempt that starts on a gap day, or no longer fits the run once a gap is skipped: refused, naming why.
  assert.throws(() => DG.applyGaps(w.resolve({}), ['2022-03-01'], { root: REPO, env: w.env }), /days without source data skipped \(2022-03-01\).*\n- combine.attempts\[0\] 2022-03-01: not a trading day of the run/s);
  const tight = w.resolve({ end: '2022-03-15T00:00:00Z' });
  assert.throws(() => DG.applyGaps(tight, [GAP], { root: REPO, env: w.env }), /its 10 sessions run past the run's end/);
  // No days: nothing re-derived.
  const same = w.resolve({});
  const attempts = same.combine.attempts;
  DG.applyGaps(same, [], { root: REPO, env: w.env });
  assert.strictEqual(same.combine.attempts, attempts);
});

test('gapsForRun: read once at a fresh start; a run already started keeps what its manifest pinned (none when it names none)', async () => {
  const w = world();
  const dir = tmp();
  const manifestFile = path.join(dir, 'manifest.json');
  let reads = 0;
  const read = async () => { reads += 1; return [GAP]; };
  const logs = [];
  const fresh = w.resolve({});
  assert.deepStrictEqual(await DG.gapsForRun(fresh, { manifestFile, read, root: REPO, env: w.env, log: m => logs.push(m) }), [GAP]);
  assert.deepStrictEqual([reads, logs], [1, [`${GAP}: no source data on the replay server; skipped (not a session)`]]);
  // Again on the same run object (a resume in one process): not read again.
  await DG.gapsForRun(fresh, { manifestFile, read, root: REPO, env: w.env });
  assert.strictEqual(reads, 1);
  // A started run: its manifest's list, never the server's now.
  fs.writeFileSync(manifestFile, JSON.stringify({ runId: 'gap1', ...DG.manifestPart(fresh) }));
  const resumed = w.resolve({});
  assert.deepStrictEqual(await DG.gapsForRun(resumed, { manifestFile, read: async () => assert.fail('read on a resume'), root: REPO, env: w.env }), [GAP]);
  assert.strictEqual(resumed.combine.attempts[0].last, '2022-03-15');
  // A run started without any (an older server, or before the list existed): none, whatever the server says now.
  fs.writeFileSync(manifestFile, JSON.stringify({ runId: 'gap1' }));
  const old = w.resolve({});
  assert.deepStrictEqual(await DG.gapsForRun(old, { manifestFile, read: async () => assert.fail('read on a resume'), root: REPO, env: w.env }), []);
  assert.deepStrictEqual(DG.manifestPart(old), {});
  // No reader (a driver's deps without one): none.
  const bare = w.resolve({});
  assert.deepStrictEqual(await DG.gapsForRun(bare, { manifestFile: path.join(dir, 'none.json'), root: REPO, env: w.env }), []);
});

test('readGaps: a server that can\'t be read refuses the run; one without the field skips nothing; a malformed list refuses', () => {
  const w = world();
  const run = w.resolve({});
  const server = body => {
    const file = path.join(w.dir, `server-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(file, `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;let result;if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'s',version:'0'}};else if(m.method==='tools/list')result={tools:[]};else result={content:[{type:'text',text:JSON.stringify(${JSON.stringify(body)})}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`);
    fs.writeFileSync(w.env.FTH_BROKERS_FILE, JSON.stringify({ brokers: { sim: { command: [process.execPath, file], replay: true, journalEnv: 'SIM_JOURNAL' } } }));
  };
  server({ replay: true, serverTime: '2022-03-01T00:00:00Z' });
  assert.deepStrictEqual(DG.readGaps(run, REPO, w.env), []);
  server({ replay: true, dataGaps: { NQ: [dead(GAP)], MNQ: [dead(GAP), flowless('2022-03-08')] } });
  assert.deepStrictEqual(DG.readGaps(run, REPO, w.env), [GAP]);
  server({ replay: true, dataGaps: { MNQ: ['2022-03-04'] } });
  assert.throws(() => DG.readGaps(run, REPO, w.env), /dataGaps is malformed/);
  fs.writeFileSync(w.env.FTH_BROKERS_FILE, JSON.stringify({ brokers: { sim: { command: [process.execPath, path.join(w.dir, 'no-such-server.js')], replay: true, journalEnv: 'SIM_JOURNAL' } } }));
  assert.throws(() => DG.readGaps(run, REPO, w.env), /replay refused: the replay server's configuration could not be read/);
  // The plan (replay.js points) logs it and skips nothing.
  const logs = [];
  assert.deepStrictEqual(DG.withServerGaps(w.resolve({}), { root: REPO, env: w.env, log: m => logs.push(m) }).dataGaps, []);
  assert.match(logs[0], /could not be read .*no day skipped in this plan/);
});

async function combineRun(w, { gaps = null, run = null } = {}) {
  const { seedRunHome, runReplay } = require('../../scripts/lib/replay/driver');
  const r = run || w.resolve({});
  if (!run) seedRunHome(r, { root: REPO, userEnv: w.env });
  const steps = [];
  const deps = {
    serverCheck: async () => null,
    async step(point) {
      steps.push(`${point.day} ${point.kind}`);
      if (point.kind === 'eod') {
        prop.recordEndOfDay(r.paths.runHome, ACCOUNT, ACCOUNT.starting_balance, point.day);
        fs.writeFileSync(path.join(r.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: true }));
      }
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [] })}\n` };
    },
    async trades() { return []; },
    async open() { return false; },
    async openPnl() { return 0; },
    async balance() { return ACCOUNT.starting_balance; },
    ...(gaps ? { dataGaps: gaps } : {}),
  };
  const logs = [];
  const res = await runReplay({ run: r, baseEnv: w.env, root: REPO, deps, log: m => logs.push(m) });
  return { run: r, res, steps, logs, log: require('../../scripts/lib/replay/combine-run').readLog(r.paths.runDir) };
}

test('the driver: a gap day is never stepped and never a session; the attempt runs its 10 sessions on replayable days; pinned in the manifest', async () => {
  const w = world();
  let reads = 0;
  const { run, res, steps, logs, log } = await combineRun(w, { gaps: async () => { reads += 1; return [GAP]; } });
  assert.strictEqual(res.done, true);
  assert.strictEqual(reads, 1);
  const days = [...new Set(steps.map(s => s.split(' ')[0]))];
  assert.deepStrictEqual(days, ['2022-03-01', '2022-03-02', '2022-03-03', '2022-03-07', '2022-03-08', '2022-03-09', '2022-03-10', '2022-03-11', '2022-03-14', '2022-03-15']);
  const end = log.find(x => x.kind === 'end');
  assert.deepStrictEqual([end.outcome, end.sessions], ['unfinished', 10]);
  assert.ok(logs.includes(`${GAP}: no source data on the replay server; skipped (not a session)`), logs.join('\n'));
  const manifest = JSON.parse(fs.readFileSync(run.paths.manifest, 'utf8'));
  assert.deepStrictEqual(manifest.dataGaps, [GAP]);
  assert.ok(!(manifest.daysDone || []).includes(GAP));
});

test('the driver: a server without dataGaps (or no reader) runs as before, the gap day a session; the manifest names none', async () => {
  const w = world();
  const { run, steps, log } = await combineRun(w, { gaps: async () => [] });
  assert.ok(steps.some(s => s.startsWith(GAP)));
  assert.deepStrictEqual([...new Set(steps.map(s => s.split(' ')[0]))].length, 10);
  assert.strictEqual(log.find(x => x.kind === 'end').sessions, 10);
  assert.ok(!('dataGaps' in JSON.parse(fs.readFileSync(run.paths.manifest, 'utf8'))));
  const v = world();
  const bare = await combineRun(v);
  assert.ok(bare.steps.some(s => s.startsWith(GAP)));
});

test('the driver: a resume skips the days the run started with and never asks the server again', async () => {
  const w = world();
  const { seedRunHome, runReplay } = require('../../scripts/lib/replay/driver');
  const first = w.resolve({});
  seedRunHome(first, { root: REPO, userEnv: w.env });
  const ok = { serverCheck: async () => null, async step(point) { return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [] })}\n` }; }, async trades() { return []; }, async open() { return false; }, async openPnl() { return 0; }, async balance() { return ACCOUNT.starting_balance; } };
  const r1 = await runReplay({ run: first, baseEnv: w.env, root: REPO, deps: { ...ok, dataGaps: async () => [GAP] }, maxCycles: 2 });
  assert.strictEqual(r1.done, false);
  // A fresh process: a new run object, and a reader that must not be called.
  const again = w.resolve({});
  const { steps } = await combineRun(w, { run: again, gaps: async () => assert.fail('read on a resume') });
  assert.ok(!steps.some(s => s.startsWith(GAP)));
  assert.deepStrictEqual(again.dataGaps, [GAP]);
});

test('the training preflight: data-gaps warns listing the window\'s gap days; passes with none; N/A without the field or live; fails a combine that no longer fits', () => {
  const P = require('../../scripts/lib/learning/preflight');
  const w = world();
  const run = w.resolve({});
  const unfit = (r, days) => { try { DG.applyGaps({ ...r }, days, { root: REPO, env: w.env }); return null; } catch (err) { return err.message; } };
  const ctx = (config, o = {}, entry = { name: 'sim', replay: true }) => ({ run: { ...run, ...o }, gate: {}, read: { brokerEntry: () => entry, brokerConfig: () => config, gapsUnfit: unfit } });
  const warn = P.dataGapsCheck(ctx({ replay: true, dataGaps: { NQ: [dead(GAP)], MNQ: [dead(GAP), dead('2022-03-10'), flowless('2022-03-08')] } }));
  assert.strictEqual(warn.status, P.WARN, warn.detail);
  assert.strictEqual(warn.detail, `2 trading day(s) of the run's window have no bars on the replay server: ${GAP}, 2022-03-10; the driver skips them (no decision time, not a session: each combine attempt runs its sessions on replayable days); 1 day(s) have bars but no flow, traded as any minute without flow (the flow facts absent): 2022-03-08`);
  assert.strictEqual(P.dataGapsCheck(ctx({ replay: true, dataGaps: { MNQ: [] } })).status, P.PASS);
  // Bars without flow only: a pass, noted.
  const noted = P.dataGapsCheck(ctx({ replay: true, dataGaps: { MNQ: [flowless(GAP)] } }));
  assert.deepStrictEqual([noted.status, noted.detail], [P.PASS, `the replay server has bars on every trading day of the run's window; 1 day(s) have bars but no flow, traded as any minute without flow (the flow facts absent): ${GAP}`]);
  assert.match(P.dataGapsCheck(ctx({ replay: true })).detail, /no dataGaps\): no day is skipped/);
  assert.strictEqual(P.dataGapsCheck(ctx({ replay: true })).status, P.NA);
  assert.strictEqual(P.dataGapsCheck(ctx({ error: 'down' })).status, P.NA);
  assert.strictEqual(P.dataGapsCheck(ctx({}, {}, { name: 'live', replay: false })).status, P.NA);
  assert.strictEqual(P.dataGapsCheck(ctx({ replay: true, dataGaps: { MNQ: 1 } })).status, P.WARN);
  const starts = P.dataGapsCheck(ctx({ replay: true, dataGaps: { MNQ: [dead('2022-03-01')] } }));
  assert.strictEqual(starts.status, P.FAIL, starts.detail);
  assert.match(starts.detail, /2022-03-01; skipped, with the replay server's days without source data skipped .*not a trading day of the run/);
  // Not a combine: a warning only.
  const plain = P.dataGapsCheck(ctx({ replay: true, dataGaps: { MNQ: [dead('2022-03-01')] } }, { combine: null }));
  assert.strictEqual(plain.status, P.WARN);
  assert.match(plain.detail, /the driver skips them \(no decision time, not a session\)$/);
  assert.ok(P.CHECKS.includes(P.dataGapsCheck));
});
