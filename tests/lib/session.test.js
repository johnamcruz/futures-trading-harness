'use strict';

// The session record (scripts/lib/session/): a live session recorded by the runner exactly as a replay
// run is (replay/store.js layout, the same line shape), with its source and the agent's fingerprints,
// the day's fills at end of day, a broker read that fails tolerated and retried, a manifest per trading
// day, and the scorecard scoring it as it scores a replay.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const { createRunner } = require('../../scripts/lib/runner');
const { validateConfig } = require('../../scripts/lib/autotrader');
const { writeCycleLog } = require('../../scripts/lib/cycle-log');
const { scanRecord, appendJsonl } = require('../../scripts/lib/trading/scan-log');
const { tradingDayKey } = require('../../scripts/lib/trading/clock');
const { historyBars } = require('../../scripts/lib/autotrader');
const { passTap, decisionRecord, fingerprints, noteVersion, versionAt, fillsBetween, gateReader } = require('../../scripts/lib/session/record');
const { createLiveSession, sessionPaths, dayBounds, pointOf, RETRY_MS, RETRY_ALERT_AFTER, BACKOFF_MS, RETRY_TIMEOUT_MS } = require('../../scripts/lib/session/live');
const { decisionPoints, isTradeTime } = require('../../scripts/lib/replay/schedule');
const { wireRunner } = require('../../scripts/lib/runner-wiring');
const { labelRun, unfinishedWhy } = require('../../scripts/lib/replay/labels');

const ROOT = path.resolve(__dirname, '..', '..');
const DAY = Date.UTC(2026, 9, 7); // Wednesday; New York = UTC-4
const et = (h, m, s = 0, d = 0) => DAY + d * 86400000 + ((h + 4) * 60 + m) * 60000 + s * 1000;
const iso = ms => new Date(ms).toISOString();
const LINE_KEYS = ['v', 't', 'day', 'kind', 'asked', 'ran', 'events', 'step', 'cycles', 'refusals', 'errors', 'bars', 'trades', 'since'];
const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

/** A live harness home with a broker whose journal is a file of the home, and a fake market and account. */
function liveHome({ fills = [], failFills = 0, hangFills = false, openUntil = 0 } = {}) {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'fakebroker', brokers: { fakebroker: { command: ['fake-server'], journal: 'broker-journal.jsonl' } } }));
  const journal = [
    { ts: iso(et(15, 0, 0, -1)), kind: 'order_placed', text: 'yesterday' },
    { ts: iso(et(10, 3)), kind: 'order_placed', text: 'MNQ long', data: { result: { success: true, orderId: 9 } } },
  ];
  fs.writeFileSync(path.join(home, 'broker-journal.jsonl'), journal.map(e => `${JSON.stringify(e)}\n`).join(''));
  const env = { FTH_HOME: home, FTH_BROKERS_FILE: path.join(home, 'brokers.json') };
  const clockRef = { t: 0 };
  const calls = { fills: 0, failFills, closes: 0 };
  const client = {
    async activeContract(symbol) { return { id: symbol, tickSize: 0.25 }; },
    async closedBars(contractId, { limit, minutes = 3 }) {
      const step = minutes * 60000;
      const lastOpen = Math.floor((clockRef.t - 1000) / step) * step - step;
      return Array.from({ length: Math.min(limit, 5) }, (_, k) => ({ t: iso(lastOpen - (4 - k) * step), o: 1, h: 2, l: 0, c: 1, v: 1 }));
    },
    // A long MNQ open until openUntil (the clock): end of day finds it, closes it, and reads again.
    async accountState() {
      return { positions: clockRef.t < openUntil ? [{ id: 1, contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500 }] : [], orders: [] };
    },
    async closePosition() { calls.closes += 1; },
    async cancelOrder() {},
    async accountBalance() { return 50000; },
    async fillsSince(account, since) {
      calls.fills += 1;
      calls.lastSince = since.toISOString();
      (calls.sinces = calls.sinces || []).push(since.toISOString());
      if (hangFills && calls.fills === 1) return new Promise(() => {});
      if (calls.fills <= calls.failFills) throw new Error('search_trades: 503 from the broker');
      return fills;
    },
  };
  return { home, env, clockRef, client, calls };
}

/** The live loop (autotrader.js): the wired runner's passes, each recorded by the session, over [from, to). */
async function runLive(w, { from, to, cfg: raw = {}, onPass = null, duringCycle = () => {}, state: initial = null, sessionRoot = ROOT, beforePass = () => {}, scan = [] }) {
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York', ...raw });
  w.clockRef.t = from;
  const tap = passTap();
  const errors = [];
  const said = [];
  // The runner's logger (the session's) and the pass tap's wrap of it (the runner's), as autotrader.js wires them.
  const baseLog = (msg, level) => { said.push({ msg, level: level || 'info', t: w.clockRef.t }); if (level === 'error') errors.push(msg); };
  const log = tap.log(baseLog);
  let state = initial;
  const runner = createRunner({
    cfg, root: ROOT, client: w.client, clock: { now: () => new Date(w.clockRef.t) },
    runCycle: async (action, prompt, limits = {}) => {
      const at = new Date(w.clockRef.t);
      const result = 'CYCLE RESULT: no-trade - nothing fired';
      writeCycleLog(w.home, { at, action, harness: 'custom', prompt, context: limits.context || null, output: result, result, ok: true, durationMs: 1000 });
      duringCycle(at);
      w.clockRef.t += 20000;
      return { ok: true, timedOut: false, result };
    },
    isKillSwitchOn: () => false, createKillSwitch: () => {},
    loadState: () => state, saveState: s => { state = s; },
    writeBars: sym => `/bars/${sym.symbol}.json`, barClosed: tap.bar,
    scanFor: () => scan, log, event: tap.event(() => {}),
    // The decision log, as runner-wiring.js writes it (the labels read what fired from it).
    scanLog: rec => appendJsonl(path.join(w.home, 'logs', `scans-${tradingDayKey(new Date(rec.at))}.jsonl`), scanRecord(rec)),
  });
  const session = createLiveSession({ cfg, root: sessionRoot, home: w.home, env: w.env, client: w.client, now: () => new Date(w.clockRef.t), log: baseLog, tap, killSwitchFile: path.join(w.home, 'STOP') });
  let guard = 0;
  while (w.clockRef.t < to) {
    beforePass(w.clockRef.t);
    const ms = await session.pass(runner);
    if (onPass) onPass(w.clockRef.t);
    w.clockRef.t += ms;
    guard += 1;
    if (guard > 100000) throw new Error('runaway loop');
  }
  return { errors, said, runner, session, cfg };
}

test('session record: one line shape for replay and live (the driver\'s keys, in its order)', () => {
  const tap = passTap();
  const log = tap.log(() => {});
  const event = tap.event(() => {});
  tap.begin();
  event({ kind: 'cycle_end', action: 'trade', ok: true, timedOut: false, result: 'r', symbols: ['MNQ'] });
  event({ kind: 'account' });
  log('x'.repeat(400), 'error');
  log('fine', 'info');
  tap.bar('MNQ', { bar: '2026-10-07T13:57:00.000Z', stale: false, action: 'trade' });
  const p = tap.summary([{ symbol: 'MNQ', clock: { lastBarT: '2026-10-07T14:00:00.000Z' } }]);
  assert.deepStrictEqual(p.ran, [{ action: 'trade', ok: true, timedOut: false, result: 'r', symbols: ['MNQ'] }]);
  assert.deepStrictEqual(p.events, ['cycle_end', 'account']);
  assert.deepStrictEqual(p.errors, ['x'.repeat(300)]);
  assert.deepStrictEqual(p.closed, [{ symbol: 'MNQ', bar: '2026-10-07T13:57:00.000Z', stale: false, action: 'trade' }]);
  const rec = decisionRecord({ t: 't', day: 'd', kind: 'trade', pass: { ...p, asked: 'trade' }, step: { code: 0, timedOut: false }, cycles: [], refusals: [], trades: null, since: null, killSwitch: null });
  assert.deepStrictEqual(['v', ...Object.keys(rec)], LINE_KEYS, 'no field added, removed or moved (closed is the tap\'s, not the line\'s)');
  assert.strictEqual(decisionRecord({ pass: {}, killSwitch: '' }).killSwitch, 'on');
  assert.deepStrictEqual(decisionRecord({ pass: {}, stale: ['MNQ'] }).stale, ['MNQ']);
  assert.ok(!('stale' in decisionRecord({ pass: {}, stale: [] })), 'a replay line never carries it');
  tap.begin();
  assert.deepStrictEqual(tap.summary([]), { ran: [], events: [], errors: [], bars: [], closed: [] }, 'each pass starts empty');
});

test('session record: versions of the agent, and which one made a decision', () => {
  const fp = fingerprints(ROOT);
  assert.match(fp.code, /^[0-9a-f]{64}$/);
  assert.match(fp.harness, /^[0-9a-f]{64}$/);
  // R33's canonical fingerprints and the rulebook seal don't exist yet.
  assert.deepStrictEqual([fp.strategies, fp.accounts, fp.policy, fp.rulebook], [null, null, null, null]);
  const m = {};
  assert.strictEqual(noteVersion(m, { since: '2026-10-07T14:00:00.000Z', hash: 'a', fingerprints: fp }), true);
  assert.strictEqual(noteVersion(m, { since: '2026-10-07T14:03:00.000Z', hash: 'a', fingerprints: { ...fp } }), false);
  assert.strictEqual(noteVersion(m, { since: '2026-10-07T15:00:00.000Z', hash: 'b', fingerprints: fp }), true);
  assert.deepStrictEqual(m.versions.map(v => v.hash), ['a', 'b']);
  // The same config, another skill or code: a version of its own.
  assert.strictEqual(noteVersion(m, { since: '2026-10-07T15:30:00.000Z', hash: 'b', fingerprints: { ...fp, harness: 'x' } }), true);
  assert.deepStrictEqual(m.versions.map(v => [v.hash, v.fingerprints.harness]), [['a', fp.harness], ['b', fp.harness], ['b', 'x']]);
  assert.strictEqual(m.fingerprints.harness, 'x');
  assert.strictEqual(versionAt(m, '2026-10-07T14:30:00.000Z').hash, 'a');
  assert.strictEqual(versionAt(m, '2026-10-07T15:00:00.000Z').hash, 'b');
});

test('session record: the fills in (since, until], each opening fill with the gateway\'s entry', async () => {
  const fills = [
    { id: 1, orderId: 5, contractId: 'MNQ', creationTimestamp: '2026-10-07T14:00:00.000Z', profitAndLoss: null },
    { id: 2, orderId: 6, contractId: 'MNQ', creationTimestamp: '2026-10-07T15:00:00.000Z', profitAndLoss: 20 },
    { id: 3, orderId: 7, contractId: 'MNQ', creationTimestamp: '2026-10-07T21:00:00.000Z', profitAndLoss: 5 },
  ];
  const out = await fillsBetween({ fillsSince: async () => fills }, '7', new Date('2026-10-07T13:00:00Z'), new Date('2026-10-07T20:00:00Z'), { entries: [{ orderId: 5, setup: 'orb', stopTicks: 20 }], specOf: () => ({ tickValue: 0.5 }) });
  assert.deepStrictEqual(out.map(f => f.id), [1, 2]);
  assert.deepStrictEqual(out[0].entry, { setup: 'orb', stopTicks: 20, tickValue: 0.5 });
  assert.strictEqual(out[1].entry, undefined);
});

test('live session: recorded by the runner in the replay layout, source live, with fingerprints; fills and journal at end of day; scored', { timeout: 120000 }, async () => {
  const fills = [
    { id: 1, orderId: 9, contractId: 'MNQ', creationTimestamp: iso(et(10, 3, 5)), price: 21500, size: 1, side: 0, profitAndLoss: null },
    { id: 2, orderId: 10, contractId: 'MNQ', creationTimestamp: iso(et(10, 30)), price: 21510, size: 1, side: 1, profitAndLoss: 20 },
    { id: 0, orderId: 3, contractId: 'MNQ', creationTimestamp: iso(et(14, 0, 0, -1)), price: 1, size: 1, side: 1, profitAndLoss: 1 },
  ];
  const w = liveHome({ fills });
  // The gate refuses an entry during the 15:00 bar's cycle.
  const duringCycle = at => {
    if (at.getTime() !== et(15, 0, 2)) return;
    fs.appendFileSync(path.join(w.home, 'logs', 'gate-log.jsonl'), `${JSON.stringify({ ts: iso(et(15, 0, 3)), decision: 'blocked', source: 'gateway', tool: 'place_order', contractId: 'MNQ', violations: [{ check: 'plan-required' }] })}\n`);
  };
  await runLive(w, { from: et(14, 50), to: et(16, 5), duringCycle });

  const day = '2026-10-07';
  const p = sessionPaths(w.home, day);
  assert.strictEqual(p.runDir, path.join(w.home, 'sessions', day));
  const recs = lines(path.join(p.runDir, `${day}.jsonl`));
  for (const r of recs) assert.deepStrictEqual(Object.keys(r).filter(k => k !== 'stale'), LINE_KEYS, `the replay line's shape: ${JSON.stringify(r).slice(0, 200)}`);
  const trade = recs.filter(r => r.kind === 'trade');
  // The stale bar the runner found at its start (housekeeping only): a line with no cycle, marked stale.
  assert.deepStrictEqual([trade[0].t, trade[0].ran, trade[0].stale], [iso(et(14, 50)), [], ['MNQ']]);
  // Then every bar that closed from 14:51 to the end of day at 15:50 (20), one line each, with its cycle.
  assert.deepStrictEqual(trade.slice(1).map(r => r.t), Array.from({ length: 20 }, (_, k) => iso(et(14, 51 + 3 * k, 2))));
  assert.strictEqual(new Set(recs.map(r => r.t)).size, recs.length, 'one line per decision point');
  for (const r of trade.slice(1)) {
    assert.ok(!('stale' in r));
    assert.strictEqual(r.asked, 'trade');
    assert.deepStrictEqual(r.ran.map(x => x.action), ['trade']);
    assert.strictEqual(r.cycles.length, 1, 'the pass\'s own cycle, none of another pass\'s');
    assert.match(r.cycles[0].promptHash, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(r.bars.map(b => b.symbol), ['MNQ']);
    assert.strictEqual(r.trades, null, 'fills are read at end of day');
  }
  assert.deepStrictEqual(recs.filter(r => r.refusals.length).map(r => [r.t, r.refusals[0].checks]), [[iso(et(15, 0, 2)), ['plan-required']]]);
  const eod = recs.filter(r => r.kind === 'eod');
  assert.strictEqual(eod.length, 1);
  assert.strictEqual(recs.filter(r => r.kind === 'eod-retry').length, 0, 'verified flat at once: no retry');
  // The day's fills (the trading day's start to end of day), each opening fill with the gateway's entry.
  assert.deepStrictEqual(eod[0].trades.map(f => f.id), [1, 2]);
  assert.strictEqual(eod[0].since, dayBounds(day).start.toISOString());
  assert.strictEqual(w.calls.lastSince, dayBounds(day).start.toISOString());
  assert.strictEqual(eod[0].asked, 'eod');
  // The manifest: the session's id is its trading day, source live, finished once the day is done and its fills known.
  const m = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  assert.deepStrictEqual([m.runId, m.source, m.broker, m.harness, m.finished, m.daysDone], [day, 'live', 'fakebroker', 'custom', true, [day]]);
  assert.strictEqual(m.fillsPending, undefined);
  assert.match(m.hash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(m.fingerprints, fingerprints(ROOT));
  assert.strictEqual(m.versions.length, 1);
  assert.strictEqual(m.versions[0].since, recs[0].t);
  assert.strictEqual(m.lastT, recs[recs.length - 1].t);
  assert.strictEqual(JSON.parse(fs.readFileSync(p.autotrader, 'utf8')).timeframe, 3);
  // The broker's journal for the day, copied from the broker config's journal path.
  assert.deepStrictEqual(lines(p.journal).map(e => e.text), ['MNQ long']);
  assert.strictEqual(m.journal, path.join(w.home, 'broker-journal.jsonl'));

  // Scored as a replay run is: the labels and the scorecard read it in place (it is finished).
  assert.strictEqual(unfinishedWhy(m, { [day]: recs }), null);
  const { summary: ls } = labelRun(p.runDir, {});
  assert.strictEqual(ls.runId, day);
  assert.ok(ls.decisions >= trade.length - 1, JSON.stringify(ls));
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'replay.js'), 'scorecard', p.runDir], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: w.home, FTH_HOME: w.home } });
  assert.strictEqual(res.status, 0, res.stderr);
  const summary = JSON.parse(fs.readFileSync(path.join(p.runDir, 'scorecard-summary.json'), 'utf8'));
  assert.strictEqual(summary.runId, day);
  assert.strictEqual(summary.decisions, lines(path.join(p.runDir, 'scorecard.jsonl')).length);
  assert.ok(summary.decisions >= trade.length - 1, JSON.stringify(summary).slice(0, 300));
  // The session's first runner config, written when it was created; one version.
  assert.deepStrictEqual(m.versions.map(v => v.config), ['autotrader.json']);
});

test('live session: a broker read that fails is recorded unknown, never stops the runner, and is retried until known', { timeout: 120000 }, async () => {
  const fills = [{ id: 2, orderId: 10, contractId: 'MNQ', creationTimestamp: iso(et(10, 30)), profitAndLoss: 20 }];
  const w = liveHome({ fills, failFills: 2 });
  const day = '2026-10-07';
  const p = sessionPaths(w.home, day);
  const seen = [];
  const { errors, said, runner } = await runLive(w, {
    from: et(15, 40), to: et(15, 58),
    onPass: t => {
      const m = fs.existsSync(p.manifest) ? JSON.parse(fs.readFileSync(p.manifest, 'utf8')) : null;
      if (m && m.daysDone.length) seen.push({ t, finished: m.finished, pending: Boolean(m.fillsPending), unfinished: unfinishedWhy(m, { [day]: [] }) });
    },
  });
  // End of day still flattened and was verified (the runner's state), whatever the fills read did.
  assert.strictEqual(runner.state.eodDone, true);
  assert.ok(errors.some(e => /fills are unknown \(search_trades: 503/.test(e)), errors.join('\n'));
  // First unknown: recorded as such, the session unfinished and saying why.
  assert.deepStrictEqual([seen[0].finished, seen[0].pending], [false, true]);
  assert.match(seen[0].unfinished, /fills/);
  // Retried a minute apart (the second try fails too), then known: the end-of-day line gets them, the session is finished.
  assert.strictEqual(w.calls.fills, 3);
  const last = seen[seen.length - 1];
  assert.deepStrictEqual([last.finished, last.pending, last.unfinished], [true, false, null]);
  const firstKnown = seen.find(s => s.finished);
  assert.ok(firstKnown.t - seen[0].t >= RETRY_MS, 'not hammered: at most once a minute');
  // Only the first failure is an error (an alert); the retry's failure is said, not alerted.
  assert.strictEqual(errors.filter(e => /fills are/.test(e)).length, 1, errors.join('\n'));
  assert.ok(said.some(x => x.level === 'info' && /still unknown/.test(x.msg)), 'the retry\'s failure goes to the runner\'s log');
  const eod = lines(path.join(p.runDir, `${day}.jsonl`)).filter(r => r.kind === 'eod');
  assert.strictEqual(eod.length, 1);
  assert.deepStrictEqual(eod[0].trades.map(f => f.id), [2]);
  assert.deepStrictEqual(Object.keys(eod[0]), LINE_KEYS, 'rewritten in place, its shape kept');
});

test('live session: a broker read that never answers times out as unknown; the pass returns', { timeout: 120000 }, async () => {
  const w = liveHome({ fills: [], hangFills: true });
  const day = '2026-10-07';
  const p = sessionPaths(w.home, day);
  const { session } = await runLive(w, { from: et(15, 49), to: et(15, 51), cfg: {} });
  assert.ok(session);
  const eod = lines(path.join(p.runDir, `${day}.jsonl`)).filter(r => r.kind === 'eod');
  assert.match(eod[0].trades.error, /no answer within/);
});

test('live session: one session per trading day, each manifest its own across two days; a restart keeps the day\'s session', { timeout: 300000 }, async () => {
  const fills = [
    { id: 1, orderId: 1, contractId: 'MNQ', creationTimestamp: iso(et(10, 0)), profitAndLoss: 10 },
    { id: 2, orderId: 2, contractId: 'MNQ', creationTimestamp: iso(et(10, 0, 0, 1)), profitAndLoss: -5 },
  ];
  const w = liveHome({ fills });
  await runLive(w, { from: et(15, 40), to: et(9, 45, 0, 1) });
  // A restart on day two (a new runner and session recorder): the same session, a version noted only if the agent changed.
  await runLive(w, { from: et(15, 40, 0, 1), to: et(16, 0, 0, 1) });
  const days = ['2026-10-07', '2026-10-08'];
  assert.deepStrictEqual(fs.readdirSync(path.join(w.home, 'sessions')).sort(), days);
  for (const [i, day] of days.entries()) {
    const p = sessionPaths(w.home, day);
    const m = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
    const recs = lines(path.join(p.runDir, `${day}.jsonl`));
    assert.deepStrictEqual(fs.readdirSync(p.runDir).filter(n => n.endsWith('.jsonl')), [`${day}.jsonl`], 'a session holds its own day only');
    assert.ok(recs.every(r => r.day === day));
    assert.deepStrictEqual([m.runId, m.source, m.daysDone, m.finished], [day, 'live', [day], true]);
    assert.strictEqual(m.start, dayBounds(day).start.toISOString());
    assert.strictEqual(m.end, dayBounds(day).end.toISOString());
    assert.strictEqual(m.lastT, recs[recs.length - 1].t);
    assert.strictEqual(m.versions.length, 1, 'the same agent: one version');
    const eod = recs.filter(r => r.kind === 'eod');
    assert.strictEqual(eod.length, 1);
    assert.deepStrictEqual(eod[0].trades.map(f => f.id), [i + 1], 'each day\'s fills on its own day');
  }
  // Day two holds the morning (before the restart) and the afternoon (after it), in order.
  const two = lines(path.join(sessionPaths(w.home, days[1]).runDir, `${days[1]}.jsonl`));
  assert.ok(two.some(r => Date.parse(r.t) < et(9, 45, 0, 1)) && two.some(r => Date.parse(r.t) > et(15, 40, 0, 1)));
  assert.deepStrictEqual(two.map(r => r.t), [...two.map(r => r.t)].sort());
  assert.strictEqual(dayBounds(days[0]).end.getTime(), dayBounds(days[1]).start.getTime());
});

test('live session: a bar the runner passes over (nothing fired) is a decision point too, as a replay\'s trade time is', { timeout: 120000 }, async () => {
  const w = liveHome();
  await runLive(w, { from: et(10, 0), to: et(10, 20), cfg: { trigger: 'signal' } });
  const day = '2026-10-07';
  const recs = lines(path.join(sessionPaths(w.home, day).runDir, `${day}.jsonl`));
  // The stale bar at the start, then every bar that closed from 10:00 to 10:18: no cycle on any (the labels' no-cycle).
  assert.deepStrictEqual(recs[0].stale, ['MNQ']);
  assert.deepStrictEqual(recs.slice(1).map(r => [r.t, r.kind, r.ran.length]), Array.from({ length: 7 }, (_, k) => [iso(et(10, 3 * k, 2)), 'trade', 0]));
  assert.ok(recs.slice(1).every(r => r.bars[0].lastBarT === iso(Date.parse(r.t) - 2000 - 180000)));
  const { labels } = labelRun(sessionPaths(w.home, day).runDir, { unfinished: true });
  assert.deepStrictEqual([...new Set(labels.map(l => l.decision))], ['no-cycle']);
});

test('live session: trade lines only at replay\'s trade times - a bar outside the sessions (housekeeping) is none', { timeout: 120000 }, async () => {
  const w = liveHome();
  const raw = { sessions: ['10:00-10:10@America/New_York'] };
  const { cfg } = await runLive(w, { from: et(10, 0), to: et(10, 30), cfg: raw });
  const day = '2026-10-07';
  const recs = lines(path.join(sessionPaths(w.home, day).runDir, `${day}.jsonl`));
  const points = decisionPoints(cfg, { start: new Date(et(10, 0)), end: new Date(et(10, 30)) }).filter(x => x.kind === 'trade');
  // The bars after 10:10 were polled (the day traded: housekeeping), but no line: replay has no time there.
  assert.ok(points.length >= 3);
  assert.strictEqual(recs.filter(r => r.kind === 'trade').length, points.length, JSON.stringify(recs.map(r => r.t)));
  assert.ok(recs.every(r => isTradeTime(cfg, new Date(Date.parse(r.bars[0].lastBarT) + 180000 + cfg.barDelaySeconds * 1000))));
});

test('schedule: isTradeTime is decisionPoints\' rule, minute by minute over a day', () => {
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 1, premarketAt: '', eodAt: '15:50@America/New_York', sessions: ['09:30-11:00@America/New_York', '14:00-15:50@America/New_York'], barDelaySeconds: 0, closedDates: ['2026-10-08'] });
  // Two trading days, the second an exchange holiday: none there.
  const start = new Date(et(18, 0, 0, -1));
  const end = new Date(et(17, 0, 0, 1));
  const pts = new Set(decisionPoints(cfg, { start, end, delayMs: 0 }).filter(x => x.kind === 'trade').map(x => x.t.getTime()));
  for (let t = start.getTime(); t < end.getTime(); t += 60000) assert.strictEqual(isTradeTime(cfg, new Date(t)), pts.has(t), iso(t));
});

test('live session: an end of day not verified flat has no fills and the day isn\'t done; eod-retry until it is', { timeout: 120000 }, async () => {
  const w = liveHome({ fills: [{ id: 5, contractId: 'MNQ', creationTimestamp: iso(et(15, 50, 30)), profitAndLoss: -10 }], openUntil: et(15, 51) });
  const day = '2026-10-07';
  const p = sessionPaths(w.home, day);
  const seen = [];
  await runLive(w, {
    from: et(15, 49, 30), to: et(15, 53),
    onPass: () => { if (fs.existsSync(p.manifest)) seen.push(JSON.parse(fs.readFileSync(p.manifest, 'utf8'))); },
  });
  const eod = lines(path.join(p.runDir, `${day}.jsonl`)).filter(r => r.kind === 'eod' || r.kind === 'eod-retry');
  assert.ok(w.calls.closes >= 1, 'end of day closed the position');
  assert.strictEqual(eod[0].kind, 'eod');
  assert.strictEqual(eod[0].trades, null, 'not verified flat: no fills read');
  assert.ok(eod.length >= 2 && eod.slice(1).every(r => r.kind === 'eod-retry' && r.asked === 'eod'), JSON.stringify(eod.map(r => r.kind)));
  assert.ok(eod.slice(0, -1).every(r => r.trades === null));
  assert.deepStrictEqual(eod[eod.length - 1].trades.map(f => f.id), [5]);
  const first = seen.find(m => (m.lastT || '') === eod[0].t);
  assert.deepStrictEqual([first.daysDone, first.finished], [[], undefined], 'not done until verified flat');
  assert.deepStrictEqual([seen[seen.length - 1].daysDone, seen[seen.length - 1].finished], [[day], true]);
});

test('live session: a catch-up end of day on the next day is recorded in the day it closes', { timeout: 120000 }, async () => {
  const fills = [{ id: 1, contractId: 'MNQ', creationTimestamp: iso(et(10, 0)), profitAndLoss: 10 }, { id: 2, contractId: 'MNQ', creationTimestamp: iso(et(9, 0, 0, 1)), profitAndLoss: 1 }];
  const w = liveHome({ fills });
  // The runner went down on the 7th after trading, before its end of day.
  const state = { day: '2026-10-07', premarketDone: false, eodDone: false, cycles: 3, lastCycleAt: iso(et(14, 0)) };
  await runLive(w, { from: et(9, 40, 0, 1), to: et(9, 41, 0, 1), state, cfg: { sessions: ['10:00-15:00@America/New_York'] } });
  const p = sessionPaths(w.home, '2026-10-07');
  const recs = lines(path.join(p.runDir, '2026-10-07.jsonl'));
  assert.deepStrictEqual(recs.map(r => [r.kind, r.day]), [['eod', '2026-10-07']]);
  assert.deepStrictEqual(recs[0].trades.map(f => f.id), [1], 'the 7th\'s fills only');
  assert.ok(!fs.existsSync(sessionPaths(w.home, '2026-10-08').manifest), 'nothing decided on the 8th yet');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p.manifest, 'utf8')).daysDone, ['2026-10-07']);
});

test('live session: fills still unknown after a restart are retried, only between passes and never at a trade time; alerted once, then backed off', { timeout: 300000 }, async () => {
  const fills = [{ id: 1, contractId: 'MNQ', creationTimestamp: iso(et(10, 0)), profitAndLoss: 10 }];
  const w = liveHome({ fills, failFills: 1000 });
  const day = '2026-10-07';
  const p = sessionPaths(w.home, day);
  // First run: end of day at 15:50, then a minute apart, RETRY_ALERT_AFTER failures, then every BACKOFF_MS.
  const first = await runLive(w, { from: et(15, 49), to: et(16, 30) });
  assert.strictEqual(w.calls.fills, RETRY_ALERT_AFTER + 1, 'five a minute apart, then one after the back-off');
  assert.ok(BACKOFF_MS >= 30 * 60000);
  assert.strictEqual(first.errors.filter(e => /fills are/.test(e)).length, 2, `the first failure and the alert: ${first.errors.join('\n')}`);
  assert.ok(JSON.parse(fs.readFileSync(p.manifest, 'utf8')).fillsPending);
  // A restart the next morning: trade times, so no retry (a bar's cycle is never held up by it).
  const before = w.calls.fills;
  w.calls.failFills = 0;
  await runLive(w, { from: et(10, 0, 0, 1), to: et(10, 5, 0, 1) });
  assert.strictEqual(w.calls.fills, before, 'no retry at a trade time');
  // Another restart in the break: the pending day is found (scanPending) and recorded (and the 8th's own end of day read).
  const third = await runLive(w, { from: et(16, 0, 0, 1), to: et(16, 1, 0, 1) });
  assert.strictEqual(w.calls.fills, before + 2);
  const m = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  assert.deepStrictEqual([m.finished, m.fillsPending], [true, undefined]);
  assert.deepStrictEqual(lines(path.join(p.runDir, `${day}.jsonl`)).find(r => r.kind === 'eod').trades.map(f => f.id), [1]);
  assert.ok(third.said.some(x => /2026-10-07: the day's fills are recorded/.test(x.msg)));
});

test('live session: the code fingerprint is the code this process loaded (scripts, hooks, lib), taken once', { timeout: 120000 }, async () => {
  const root = tmpDir();
  for (const d of ['scripts', 'scripts/hooks', 'scripts/lib', 'skills']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'cli.js'), '1');
  fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'hook.js'), '1');
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'x.js'), '1');
  const fp0 = fingerprints(root).code;
  fs.writeFileSync(path.join(root, 'scripts', 'cli.js'), '2');
  const fp1 = fingerprints(root).code;
  fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'hook.js'), '2');
  const fp2 = fingerprints(root).code;
  assert.ok(fp0 !== fp1 && fp1 !== fp2, 'a CLI and a hook are part of the code');
  assert.strictEqual(fingerprints(root, { code: 'given' }).code, 'given');
  // A live session: an edit on disk mid-session isn't the code running, so no new version.
  const w = liveHome();
  await runLive(w, {
    from: et(10, 0), to: et(10, 12), sessionRoot: root,
    beforePass: t => { if (t >= et(10, 5)) fs.writeFileSync(path.join(root, 'scripts', 'lib', 'x.js'), String(t)); },
  });
  const m = JSON.parse(fs.readFileSync(sessionPaths(w.home, '2026-10-07').manifest, 'utf8'));
  assert.strictEqual(m.versions.length, 1);
  assert.strictEqual(m.fingerprints.code, fp2);
});

test('live session: a restart on another runner config keeps the first config and records the new one with its version', { timeout: 120000 }, async () => {
  const w = liveHome();
  const day = '2026-10-07';
  const p = sessionPaths(w.home, day);
  await runLive(w, { from: et(10, 0), to: et(10, 7) });
  await runLive(w, { from: et(10, 10), to: et(10, 17), cfg: { maxCyclesPerDay: 40 } });
  const m = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  assert.strictEqual(m.versions.length, 2);
  assert.strictEqual(m.versions[0].config, 'autotrader.json');
  assert.match(m.versions[1].config, /^autotrader-2026-10-07T14-1\d-\d\d-\d{3}Z\.json$/);
  assert.notStrictEqual(m.versions[0].hash, m.versions[1].hash);
  assert.notStrictEqual(JSON.parse(fs.readFileSync(p.autotrader, 'utf8')).maxCyclesPerDay, 40, 'the first config kept');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(p.runDir, m.versions[1].config), 'utf8')).maxCyclesPerDay, 40);
  assert.strictEqual(versionAt(m, iso(et(10, 3))).config, 'autotrader.json');
});

test('session record: the gate log is read on from where it left off, never whole again', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'gate-log.jsonl');
  const entry = (s, decision = 'blocked') => `${JSON.stringify({ ts: iso(et(10, 0, s)), decision, source: 'gateway', tool: 'place_order', violations: [{ check: `c${s}` }] })}\n`;
  fs.writeFileSync(file, entry(1));
  const r = gateReader(file);
  assert.deepStrictEqual(r.refusalsSince(0), [], 'what was logged before the reader is no pass\'s');
  fs.appendFileSync(file, entry(2) + entry(3, 'allowed') + entry(4).slice(0, 20));
  assert.deepStrictEqual(r.refusalsSince(0).map(x => x.checks), [['c2']]);
  fs.appendFileSync(file, entry(4).slice(20) + entry(5));
  assert.deepStrictEqual(r.refusalsSince(0).map(x => x.checks), [['c4'], ['c5']], 'the line read mid-write is kept and completed; earlier ones not read again');
  fs.appendFileSync(file, entry(7));
  assert.deepStrictEqual(r.refusalsSince(et(10, 0, 8)).map(x => x.checks), [], 'older than the pass: not its refusal');
  assert.deepStrictEqual(r.refusalsSince(0), []);
  fs.writeFileSync(file, entry(6));
  assert.deepStrictEqual(r.refusalsSince(0).map(x => x.checks), [['c6']], 'a rotated log is read from its start');
});

test('runner wiring: onBarClosed hears each closed bar the runner polls, with the pass\'s action', async () => {
  const home = tmpDir();
  const t = et(10, 3, 2);
  const step = 180000;
  const client = {
    async activeContract(symbol) { return { id: symbol, tickSize: 0.25 }; },
    async closedBars() { return [0, 1, 2].map(k => ({ t: iso(et(10, 0) - (2 - k) * step), o: 1, h: 2, l: 0, c: 1, v: 1 })); },
  };
  const heard = [];
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York', trigger: 'bar' });
  const runner = wireRunner({ cfg, root: ROOT, home, env: { FTH_HOME: home }, client, dataDir: path.join(home, 'bars'), now: () => new Date(t), runCycle: async () => ({ ok: true }), loadState: () => null, saveState: () => {}, killSwitchFile: path.join(home, 'STOP'), log: () => {}, event: () => {}, onBarClosed: (symbol, info) => heard.push([symbol, info]) });
  await runner.step();
  assert.deepStrictEqual(heard, [['MNQ', { bar: iso(et(10, 0)), stale: false, action: 'trade' }]]);
});

test('autotrader: the live loop records each pass through the session and hears closed bars through the pass tap', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'autotrader.js'), 'utf8');
  const loop = src.slice(src.indexOf('for (;;)'));
  assert.match(loop, /const ms = await session\.pass\(runner\);/);
  assert.ok(!/runner\.step\(\)/.test(loop), 'the loop never steps the runner unrecorded');
  assert.match(src, /onBarClosed: tap\.bar/);
  assert.match(src, /createLiveSession\(\{[^)]*log: baseLog, tap/);
});

test('live session: a bar is decided at its close plus barDelaySeconds, as the replay schedule places it, at a window\'s edge', { timeout: 120000 }, async () => {
  const base = { harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York', sessions: ['10:00-11:00@America/New_York'] };
  const cfg7 = validateConfig({ ...base, barDelaySeconds: 7 });
  assert.strictEqual(pointOf(cfg7, iso(et(10, 57))).getTime(), et(11, 0, 7), 'the close (open + timeframe) plus the delay');
  assert.strictEqual(isTradeTime(cfg7, pointOf(cfg7, iso(et(10, 54)))), true);
  assert.strictEqual(isTradeTime(cfg7, pointOf(cfg7, iso(et(10, 57)))), false, 'the bar closing at 11:00 is past the window');
  // A delay that crosses a minute: the bar closing 10:57 is decided at 10:58 (window to 10:58: past it).
  const cfg60 = validateConfig({ ...base, sessions: ['10:00-10:58@America/New_York'], barDelaySeconds: 60 });
  assert.strictEqual(isTradeTime(cfg60, pointOf(cfg60, iso(et(10, 54)))), false);
  // Live against the schedule: the same trade times, the edge's bar left out.
  const w = liveHome();
  const { cfg } = await runLive(w, { from: et(10, 30), to: et(11, 10), cfg: { sessions: ['10:00-11:00@America/New_York'], barDelaySeconds: 7 } });
  const recs = lines(path.join(sessionPaths(w.home, '2026-10-07').runDir, '2026-10-07.jsonl')).filter(r => r.kind === 'trade');
  const points = decisionPoints(cfg, { start: new Date(et(10, 30)), end: new Date(et(11, 10)) }).filter(x => x.kind === 'trade');
  assert.strictEqual(recs.length, points.length + 1, 'the schedule\'s times plus the stale bar at the start');
  assert.ok(!recs.some(r => r.bars[0].lastBarT === iso(et(10, 57))), 'no line for the bar closing at the window\'s end');
});

/** A harness home with pending fills for the given days, as a runner that stopped before they were known leaves it. */
function pendingHome(days) {
  const w = liveHome({ fills: [{ id: 1, contractId: 'MNQ', creationTimestamp: iso(et(10, 0)), profitAndLoss: 10 }] });
  for (const day of days) {
    const p = sessionPaths(w.home, day);
    fs.mkdirSync(p.runDir, { recursive: true });
    const t = `${day}T19:50:20.000Z`;
    fs.writeFileSync(path.join(p.runDir, `${day}.jsonl`), `${JSON.stringify({ v: 1, t, day, kind: 'eod', trades: { error: 'x' }, since: null })}\n`);
    fs.writeFileSync(p.manifest, JSON.stringify({ v: 1, runId: day, hash: 'h', source: 'live', daysDone: [day], finished: false, fillsPending: { t }, versions: [] }));
  }
  return w;
}

/** A session over a fake runner: each pass returns `ms`, with the runner's state and flatness as given. */
function fakeRun(w, { at, ms = 5000, flat = true, state = { day: '2026-10-08', eodDone: true }, events = [] }) {
  const cfg = validateConfig({ harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '', eodAt: '15:50@America/New_York' });
  const tap = passTap();
  const ev = tap.event(() => {});
  w.clockRef.t = at;
  const runner = { step: async () => { for (const e of events) ev(e); return ms; }, state, symbols: [], verifiedFlat: flat };
  const session = createLiveSession({ cfg, root: ROOT, home: w.home, env: w.env, client: w.client, now: () => new Date(w.clockRef.t), log: () => {}, tap, killSwitchFile: path.join(w.home, 'STOP') });
  return { pass: () => session.pass(runner), runner };
}

test('live session: a fills retry runs only while the runner is idle - flat, its day done or the market closed, no end of day, a long wait', async () => {
  const day = '2026-10-07';
  const evening = et(16, 30, 0, 1); // the 8th, in the 16:00-18:00 ET break
  const tries = [
    ['a position open (not verified flat)', { flat: false }],
    ['an end of day under way', { events: [{ kind: 'eod', day: '2026-10-08' }] }],
    ['the next pass due within the read', { ms: RETRY_TIMEOUT_MS }],
    ['in market hours, its end of day not done', { at: et(15, 55, 0, 1), state: { day: '2026-10-08', eodDone: false } }],
  ];
  // The pending day's reads (an end of day in the pass reads its own day's, which is no retry).
  const retries = w => (w.calls.sinces || []).filter(x => x === dayBounds(day).start.toISOString()).length;
  for (const [why, over] of tries) {
    const w = pendingHome([day]);
    const r = fakeRun(w, { at: evening, ...over });
    await r.pass();
    assert.strictEqual(retries(w), 0, why);
  }
  const w = pendingHome([day]);
  const r = fakeRun(w, { at: evening });
  await r.pass();
  assert.strictEqual(w.calls.fills, 1, 'idle: retried');
  assert.strictEqual(JSON.parse(fs.readFileSync(sessionPaths(w.home, day).manifest, 'utf8')).finished, true);
  // The market closed, whatever the runner's day says (a day with no end of day of its own): idle.
  const w3 = pendingHome([day]);
  await fakeRun(w3, { at: evening, state: { day: '2026-10-07', eodDone: false } }).pass();
  assert.strictEqual(retries(w3), 1);
  // In market hours with its end of day done and flat, outside the sessions: idle too.
  const w2 = pendingHome([day]);
  await fakeRun(w2, { at: et(15, 55, 0, 1), state: { day: '2026-10-08', eodDone: true } }).pass();
  assert.strictEqual(w2.calls.fills, 1);
});

test('live session: after a restart the pending days are due a minute apart, and one is read a pass', async () => {
  const days = ['2026-10-05', '2026-10-06', '2026-10-07'];
  const w = pendingHome(days);
  const r = fakeRun(w, { at: et(16, 30, 0, 1) });
  await r.pass();
  assert.strictEqual(w.calls.fills, 1, 'one day a pass');
  w.clockRef.t += 5000;
  await r.pass();
  assert.strictEqual(w.calls.fills, 1, 'the next day isn\'t due yet: staggered');
  // Both others due by now: still one a pass.
  w.clockRef.t = et(16, 40, 0, 1);
  await r.pass();
  assert.strictEqual(w.calls.fills, 2, 'one day a pass, even with two due');
  await r.pass();
  assert.strictEqual(w.calls.fills, 3);
  assert.ok(days.every(d => JSON.parse(fs.readFileSync(sessionPaths(w.home, d).manifest, 'utf8')).finished === true));
});

test('labels: a day started in paper mode and restarted live is labelled with the config in force at each line', { timeout: 120000 }, async () => {
  const w = liveHome();
  const day = '2026-10-07';
  // A paper strategy fires on every bar: a candidate only while the session runs in paper mode.
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'paper', signal: 'rules' }];
  await runLive(w, { from: et(10, 0), to: et(10, 10), cfg: { paper: true }, scan });
  await runLive(w, { from: et(10, 20), to: et(10, 30), scan });
  const dir = sessionPaths(w.home, day).runDir;
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(m.versions.map(v => Boolean(JSON.parse(fs.readFileSync(path.join(dir, v.config), 'utf8')).paper)), [true, false]);
  // The strategy's status from the strategies the labels are given (the scan log keeps its name and verdict).
  const { labels } = labelRun(dir, { unfinished: true, strategies: [{ name: 'orb', status: 'paper' }] });
  const flat = labels.filter(l => l.decision === 'flat');
  const paperHalf = flat.filter(l => Date.parse(l.t) < et(10, 15));
  const liveHalf = flat.filter(l => Date.parse(l.t) > et(10, 15));
  assert.ok(paperHalf.length >= 2 && liveHalf.length >= 2, JSON.stringify(labels.map(l => [l.t, l.decision])));
  assert.ok(paperHalf.every(l => l.clone.reasons.includes('paper mode')), 'the paper half: no skip');
  assert.ok(liveHalf.every(l => !l.clone.reasons.includes('paper mode')), 'the live half: its decisions count');
  assert.ok(paperHalf.every(l => l.candidates.some(c => c.name === 'orb')), 'paper mode: the paper strategy\'s setup is a candidate');
  assert.ok(liveHalf.every(l => !l.candidates.length), 'live: a paper strategy is no candidate');
  // A run without versions (a replay) reads its one config.
  const { configsOf } = require('../../scripts/lib/replay/labels');
  fs.writeFileSync(path.join(dir, 'autotrader.json'), JSON.stringify({ timeframe: 5 }));
  assert.strictEqual(configsOf(dir, { daysDone: [] })(iso(et(10, 25))).timeframe, 5);
});

test('scorecard and --bars: a session restarted on another timeframe and bar count is scored, and its data read, at each line\'s', { timeout: 120000 }, async () => {
  const w = liveHome();
  const day = '2026-10-07';
  await runLive(w, { from: et(10, 0), to: et(10, 10) });
  await runLive(w, { from: et(10, 30), to: et(10, 45), cfg: { timeframe: 5, bars: 120 } });
  const dir = sessionPaths(w.home, day).runDir;
  const { scoreRun } = require('../../scripts/lib/replay/scorecard');
  const { records } = scoreRun(dir, { unfinished: true });
  const first = records.filter(r => Date.parse(r.t) < et(10, 15));
  const second = records.filter(r => Date.parse(r.t) > et(10, 15));
  assert.ok(first.length && second.length, JSON.stringify(records.map(r => r.t)));
  assert.ok(first.every(r => r.facts.timeframe === 3 && r.facts.barsHanded === historyBars(3)), JSON.stringify(first[0].facts).slice(0, 200));
  assert.ok(second.every(r => r.facts.timeframe === 5 && r.facts.barsHanded === 120));
  // One-minute --bars data, aggregated at each timeframe the session used, picked by each line's.
  const { outcomeBarsFor, outcomeFor, timeframesOf } = require('../../scripts/lib/replay/labels');
  assert.deepStrictEqual(timeframesOf(dir), [3, 5]);
  const csv = path.join(w.home, 'MNQ-1m.csv');
  const rows = Array.from({ length: 60 }, (_, k) => `${iso(et(10, 0) + k * 60000).replace('T', ' ').replace('.000Z', '+00:00')},1,2,0,1,1`);
  fs.writeFileSync(csv, `datetime,open,high,low,close,volume\n${rows.join('\n')}\n`);
  const ob = outcomeBarsFor(dir, { MNQ: csv });
  assert.deepStrictEqual(Object.keys(ob.byTf).map(Number), [3, 5]);
  assert.strictEqual(outcomeFor(ob, 'MNQ', 3).length, 20);
  assert.strictEqual(outcomeFor(ob, 'MNQ', 5).length, 12);
  assert.strictEqual(outcomeFor({ MNQ: [1] }, 'MNQ', 5).length, 1, 'the older { SYMBOL: bars } form still reads');
  assert.strictEqual(outcomeBarsFor(dir, {}), null);
});

test('labels and scorecard with one-minute --bars on a 3m-then-5m session: each line walks and rebuilds at its own timeframe', { timeout: 120000 }, async () => {
  const w = liveHome();
  const day = '2026-10-07';
  const { strategies } = require('../../scripts/lib/trading/strategies').loadStrategies(ROOT, {});
  const orb = strategies.find(s => s.name === 'orb');
  // A setup fires on every bar and the trader stands aside: each line gets the setup's counterfactual.
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', signal: orb.signal, stopDistance: 5, targetDistance: 2 }];
  await runLive(w, { from: et(10, 0), to: et(10, 10), scan });
  await runLive(w, { from: et(10, 30), to: et(10, 45), cfg: { timeframe: 5 }, scan });
  const dir = sessionPaths(w.home, day).runDir;
  // One-minute data rising half a point a minute from 09:00, then falling three a minute from 11:01 (the trail stops it out).
  const csv = path.join(w.home, 'MNQ-1m.csv');
  const rows = Array.from({ length: 180 }, (_, k) => {
    const o = k <= 121 ? 20000 + k * 0.5 : 20060.5 - (k - 121) * 3;
    return `${iso(et(9, 0) + k * 60000).replace('T', ' ').replace('.000Z', '+00:00')},${o},${o + 0.75},${o - 0.25},${o + 0.5},10`;
  });
  fs.writeFileSync(csv, `datetime,open,high,low,close,volume\n${rows.join('\n')}\n`);
  const { outcomeBarsFor, labelRun: run } = require('../../scripts/lib/replay/labels');
  const outcomeBars = outcomeBarsFor(dir, { MNQ: csv });
  const { labels } = run(dir, { unfinished: true, strategies, outcomeBars });
  const cf = l => (l.counterfactuals || []).find(c => c.strategy === 'orb' && c.simulated && c.exitTime);
  const at = (from, to) => labels.filter(l => l.decision === 'flat' && Date.parse(l.t) >= from && Date.parse(l.t) < to && cf(l));
  const three = at(et(10, 0), et(10, 15));
  const five = at(et(10, 30), et(11, 0));
  assert.ok(three.length && five.length, JSON.stringify(labels.map(l => [l.t, l.decision, (l.counterfactuals || []).map(c => c.reason)])).slice(0, 600));
  // A walk on 5m bars exits at a 5-minute close; on 3m bars at a 3-minute one.
  const minuteOf = l => new Date(cf(l).exitTime).getUTCMinutes();
  assert.ok(five.every(l => minuteOf(l) % 5 === 0), JSON.stringify(five.map(l => cf(l).exitTime)));
  assert.ok(three.every(l => minuteOf(l) % 3 === 0), JSON.stringify(three.map(l => cf(l).exitTime)));
  // Its entry is the open of the next bar at the line's timeframe (plus a tick of slippage at most).
  const openAt = ms => 20000 + ((ms - et(9, 0)) / 60000) * 0.5;
  for (const [ls, tf] of [[three, 3], [five, 5]]) {
    for (const l of ls) {
      const next = Date.parse(l.barT) + tf * 60000;
      const d = cf(l).entry - openAt(next);
      assert.ok(d >= 0 && d <= 0.25, `${l.t} (${tf}m): entry ${cf(l).entry}, next ${tf}m bar opens ${openAt(next)}`);
    }
  }
  // The scorecard rebuilds each 5m line's briefing from the 5m set (the bar the line decided on is in it).
  const { scoreRun } = require('../../scripts/lib/replay/scorecard');
  const { records } = scoreRun(dir, { unfinished: true, strategies, outcomeBars });
  const late = records.filter(r => Date.parse(r.t) >= et(10, 30) && r.barT && new Date(r.barT).getUTCMinutes() % 15 !== 0);
  assert.ok(late.length, JSON.stringify(records.map(r => [r.t, r.barT])));
  assert.ok(late.every(r => r.facts.timeframe === 5 && r.facts.rebuilt === true), JSON.stringify(late.map(r => [r.t, r.barT, r.facts.rebuilt])));
});
