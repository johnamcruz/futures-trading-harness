'use strict';

// A data lane (lanes.js trigger "data"): a further lane on 1m bars that only brings its bars to the first lane's
// briefing (5m candles, 5m structure, 5m FVGs). Checked: its config (validation and preflight), the runner (no scan, no
// cycle, no housekeeping, no session-record point, the first lane's budget, its bars noted before the briefing of the
// same close), the replay schedule (no point of its own) and replay equal to live, and the replay config example.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../../scripts/lib/lanes');
const P = require('../../scripts/lib/preflight');
const { createRunner } = require('../../scripts/lib/runner');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { decisionPoints } = require('../../scripts/lib/replay/schedule');
const { resolveReplay } = require('../../scripts/lib/replay/config');
const { cycleTimeoutMin } = require('../../scripts/lib/lane-cycle');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = { harness: 'qwen', premarketAt: '', eodAt: '15:50@America/New_York', account: '7' };
const DATA = [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'data' }];
const invalid = raw => {
  try { validateConfig(raw); } catch (err) { return err.message; }
  return assert.fail(`accepted ${JSON.stringify(raw)}`);
};

test('data lane: config checks: a further lane, 1m, no strategies or policies; no account needed; refused as an analyst\'s timeframe', () => {
  const cfg = validateConfig({ ...BASE, account: '', lanes: DATA });
  assert.deepStrictEqual(L.lanesOf(cfg).map(l => [l.timeframe, l.trigger]), [[3, 'bar'], [1, 'data']]);
  assert.deepStrictEqual(L.tradingLanes(cfg).map(l => l.timeframe), [3]);
  assert.ok(L.isDataLane(L.lanesOf(cfg)[1]) && !L.isDataLane(L.lanesOf(cfg)[0]));
  assert.match(invalid({ ...BASE, lanes: [{ timeframe: 1, trigger: 'data' }] }), /lanes\[0\]\.trigger: "data" only on a further lane/);
  assert.match(invalid({ ...BASE, lanes: [{ timeframe: 3 }, { timeframe: 5, trigger: 'data' }] }), /lanes\[1\]\.timeframe: a data lane's bars are the briefing's 1m source/);
  for (const k of ['strategies', 'policies']) assert.match(invalid({ ...BASE, lanes: [{ timeframe: 3 }, { timeframe: 1, trigger: 'data', [k]: ['a1'] }] }), new RegExp(`lanes\\[1\\]\\.${k}: a data lane scans nothing`));
  assert.match(invalid({ ...BASE, lanes: [{ timeframe: 3 }, { timeframe: 1, trigger: 'data' }, { timeframe: 1, trigger: 'signal' }] }), /timeframe 1 appears in more than one lane/);
  // It scans nothing (whatever strategies trade 1m), so the signal-lane and composed-lane checks never see it.
  const reg = [{ name: 'a1', valid: true, errors: [], status: 'active', signal: 'rules', instruments: ['MNQ'], timeframe: '1m' }];
  assert.deepStrictEqual(L.laneStrategies(reg, L.lanesOf(cfg)[1]), []);
  assert.deepStrictEqual(L.startErrors(cfg, reg, []), []);
  // An analyst can't read 1m from a data lane (its bars feed the first lane's briefing only): refused at start.
  const agents = [{ name: 'market-structure-analyst' }];
  const withAgent = validateConfig({ ...BASE, lanes: DATA, agents: { 'market-structure-analyst': { timeframe: '1m' } } });
  assert.match(L.agentErrors(withAgent, agents).join('\n'), /an analyst's timeframe is a lane's \(3m\)/);
  assert.deepStrictEqual(L.analystFrames(withAgent, agents), []);
});

test('data lane: preflight reports it as bars only, never a failure', () => {
  const rows = P.laneChecks(validateConfig({ ...BASE, lanes: DATA }), []);
  assert.deepStrictEqual(rows.map(r => [r.check, r.status]), [['lane 3m', 'ok'], ['lane 1m', 'ok']]);
  assert.match(rows[1].detail, /^1m bars, trigger data: bars only, for the first lane's briefing \(5m candles, 5m structure, 5m FVGs\); no strategy, no cycle, no role$/);
});

test('data lane: never sets a cycle\'s budget', () => {
  const cfg = validateConfig({ ...BASE, lanes: DATA });
  assert.strictEqual(cycleTimeoutMin(cfg, L.lanesOf(cfg)), cfg.cycleTimeoutMinutes);
  assert.strictEqual(cfg.cycleTimeoutMinutes, 6);
});

// The runner under a simulated clock and a fake market (as tests/lib/runner-lanes.test.js).
const DAY = Date.UTC(2026, 9, 7); // Wednesday; New York = UTC-4
const et = (h, m, s = 0) => DAY + ((h + 4) * 60 + m) * 60000 + s * 1000;
const iso = ms => new Date(ms).toISOString();
const START = et(9, 59, 50);

function market({ publishMs = () => 1000 } = {}) {
  const requests = [];
  const reads = { account: 0 };
  return {
    requests,
    reads,
    client: clockRef => ({
      async activeContract() { return { id: 'MNQ', tickSize: 0.25 }; },
      async closedBars(contractId, { minutes, limit }) {
        requests.push([minutes, clockRef.t]);
        const step = minutes * 60000;
        const lastOpen = Math.floor((clockRef.t - publishMs(minutes)) / step) * step - step;
        return Array.from({ length: Math.min(limit, 5) }, (_, k) => ({ t: iso(lastOpen - (4 - k) * step), o: 1, h: 2, l: 0, c: 1, v: 1 }));
      },
      async accountState() { reads.account += 1; return { positions: [], orders: [] }; },
      async netPosition() { return 0; },
      async workingOrders() { return 0; },
    }),
  };
}

function runnerFor({ lanes, clockRef, mkt, cycles, seen, state, more = {} }) {
  const cfg = validateConfig({ ...BASE, lanes, ...more });
  return createRunner({
    cfg, root: '/r', client: mkt.client(clockRef), clock: { now: () => new Date(clockRef.t) },
    runCycle: async (action, prompt, limits = {}) => {
      cycles.push({ action, prompt, context: limits.context || null, start: clockRef.t, timeoutMs: limits.timeoutMs });
      clockRef.t += 20000;
      return { ok: true, timedOut: false };
    },
    isKillSwitchOn: () => false, createKillSwitch: () => {},
    loadState: () => state.value, saveState: s => { state.value = JSON.parse(JSON.stringify(s)); },
    writeBars: sym => `/bars/${sym.symbol}-${sym.minutes}m.json`,
    scanFor: (symbol, bars, lane) => { seen.push(['scan', lane ? lane.timeframe : 3, bars.at(-1).t]); return []; },
    recordFineBars: item => seen.push(['fine', item.minutes, item.bar.t]),
    recordBriefing: item => seen.push(['brief', item.minutes, item.bar.t]),
    barClosed: (symbol, info) => seen.push(['closed', info.minutes || 3, info.bar]),
  });
}

async function simulate({ lanes, to, mkt = market(), more }) {
  const clockRef = { t: START };
  const cycles = [];
  const seen = [];
  const state = { value: null };
  const runner = runnerFor({ lanes, clockRef, mkt, cycles, seen, state, more });
  while (clockRef.t < to) clockRef.t += await runner.step();
  return { cycles: cycles.filter(c => c.action === 'trade'), seen, state, mkt };
}

test('data lane, live: its 1m bars are polled and noted every minute, but only the 3m bars scan, brief, cycle and reach the session record', async () => {
  const one = await simulate({ lanes: [{ timeframe: 3, trigger: 'bar' }], to: et(10, 15, 30) });
  const data = await simulate({ lanes: DATA, to: et(10, 15, 30) });
  // The same cycles, at the same times, with the same prompts, contexts and budgets: the data lane adds none.
  assert.strictEqual(data.cycles.length, 6);
  assert.deepStrictEqual(data.cycles.map(c => [c.start, c.timeoutMs, c.prompt.replace(/\d+ s/g, '')]), one.cycles.map(c => [c.start, c.timeoutMs, c.prompt.replace(/\d+ s/g, '')]));
  for (const c of data.cycles) assert.ok(!('lanes' in c.context) && c.context.symbols.every(x => !('lane' in x)) && c.timeoutMs === 6 * 60000);
  assert.ok(data.mkt.requests.filter(([m]) => m === 1).length >= 15, 'the 1m bars are polled every minute');
  const kinds = k => data.seen.filter(x => x[0] === k);
  assert.ok(kinds('fine').length >= 15 && kinds('fine').every(x => x[1] === 1));
  for (const k of ['scan', 'brief', 'closed']) assert.ok(kinds(k).length > 0 && kinds(k).every(x => x[1] === 3), `${k}: ${JSON.stringify(kinds(k))}`);
  // Every 3m briefing comes after the 1m bar of the same close (coalesced into its pass).
  for (const [i, x] of data.seen.entries()) {
    if (x[0] !== 'brief') continue;
    const close = Date.parse(x[2]) + 180000;
    assert.ok(data.seen.slice(0, i).some(y => y[0] === 'fine' && Date.parse(y[2]) + 60000 === close), `the 1m bar closing at ${iso(close)} before its briefing`);
  }
  // No account read for a data-only pass: housekeeping, the prop snapshot and the cycle are the 3m bars' only.
  assert.strictEqual(data.mkt.reads.account, one.mkt.reads.account);
  // Its clock is kept with the 3m one (a replay pass is a new process).
  assert.ok(data.state.value.laneClocks['MNQ|1m'] && data.state.value.laneClocks['MNQ|3m']);
});

test('data lane: a late 3m bar holds the pass a few seconds so the 1m bar of that close is in it; a late 1m bar never costs the cycle', async () => {
  const late1 = await simulate({ lanes: DATA, to: et(10, 6, 30), mkt: market({ publishMs: m => (m === 1 ? 6000 : 1000) }) });
  assert.strictEqual(late1.cycles.length, 3);
  for (const [i, x] of late1.seen.entries()) {
    if (x[0] === 'brief') assert.ok(late1.seen.slice(0, i).some(y => y[0] === 'fine' && Date.parse(y[2]) + 60000 === Date.parse(x[2]) + 180000), x[2]);
  }
  const never1 = await simulate({ lanes: DATA, to: et(10, 6, 30), mkt: market({ publishMs: m => (m === 1 ? 50000 : 1000) }) });
  assert.strictEqual(never1.cycles.length, 3, 'past the hold the 3m bar cycles without it');
});

test('data lane, replay: no decision point of its own; a fresh runner per point (as replay runs passes) cycles exactly the live runner\'s bars, briefed with that close\'s 1m bar', async () => {
  const raw = { barDelaySeconds: 2, sessions: ['10:00-10:30@America/New_York'] };
  const cfg = validateConfig({ ...BASE, lanes: DATA, ...raw });
  const plain = validateConfig({ ...BASE, timeframe: 3, ...raw });
  const span = { start: new Date(START), end: new Date(et(10, 30, 30)) };
  const points = decisionPoints(cfg, span);
  assert.deepStrictEqual(points.map(p => [p.t.getTime(), p.kind, 'lanes' in p]), decisionPoints(plain, span).map(p => [p.t.getTime(), p.kind, false]));
  const live = await simulate({ lanes: DATA, more: raw, to: et(10, 30, 30) });
  const state = { value: null };
  const cycles = [];
  const seen = [];
  const mkt = market();
  for (const p of points.filter(x => x.kind === 'trade')) {
    const clockRef = { t: p.t.getTime() };
    await runnerFor({ lanes: DATA, clockRef, mkt, cycles, seen, state, more: raw }).step();
  }
  const bars = list => list.map(c => c.context.symbols.map(x => x.bar.t).join(','));
  assert.deepStrictEqual(bars(cycles.filter(c => c.action === 'trade')), bars(live.cycles));
  // Each replay briefing has the 1m bar of its own close (causal: none later was served).
  for (const [i, x] of seen.entries()) {
    if (x[0] !== 'brief') continue;
    const close = Date.parse(x[2]) + 180000;
    const fine = seen.slice(0, i).filter(y => y[0] === 'fine').at(-1);
    assert.strictEqual(Date.parse(fine[2]) + 60000, close, `${x[2]}: the latest 1m bar noted closes with it`);
  }
});

test('data lane: the replay config example carries one, and resolves to a runner config whose schedule is the 3m lane\'s', () => {
  const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp-configs', 'replay.example.json'), 'utf8'));
  assert.deepStrictEqual(ex.autotrader.lanes, DATA);
  const dir = tmpDir();
  const { prop: _prop, ...rest } = ex;
  const run = resolveReplay({ ...rest, workDir: path.join(dir, 'replays'), start: '2026-10-07T13:00:00Z', end: '2026-10-07T15:00:00Z' }, { env: { FTH_HOME: path.join(dir, 'live') }, home: dir, root: ROOT });
  assert.deepStrictEqual(L.lanesOf(run.cfg).map(l => l.trigger), ['bar', 'data']);
  const pts = decisionPoints(run.cfg, { start: run.start, end: run.end }).filter(p => p.kind === 'trade');
  assert.ok(pts.length > 0 && pts.every(p => p.t.getUTCMinutes() % 3 === 0 && !('lanes' in p)));
});
