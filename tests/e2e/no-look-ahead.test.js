'use strict';

/**
 * The no-look-ahead suite: replay equals live, and a replayed decision sees only what existed at its
 * decision time. With the unit tests it names (tests/lib/look-ahead.test.js: the cut and the refusal;
 * tests/lib/no-look-ahead-rules.test.js: every rules series, field() look-back and fixture rules strategy,
 * the backtest engine's fills, the labels' inputs), it proves:
 *
 *   1. The replay driver, against a replay broker that leaks the future (its get_bars serves bars after
 *      its clock): at each decision time every bar the runner wrote, the scan logged, the cycle's context
 *      named, the bar briefing holds, and the agent's own tools read (bars_fetch, strategies_scan,
 *      market_snapshot, mtf_read) closes no later than the replay clock; a file with a later bar is
 *      refused by every bars tool; the decision history's outcomes ("since") read only the bars closed by
 *      the cycle's bar, and the session record keeps them as shown. The replay wiring moves the broker's clock (its clock file), and a
 *      conforming server cuts its bars there.
 *   2. The harness tools under a replay clock refuse a bars file with a bar after it (each tool, the
 *      same way), bars_fetch writes only what had closed, a later bar's briefing is not served; live
 *      (no clock) the same calls are unchanged.
 *   3. The conformance check (scripts/check-broker-mcp.js) dates what it sends at the replay clock and
 *      fails a replay server whose get_bars leaks bars after it; live it uses the wall clock.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, recordBrokerSpecs, FX_GOLDEN } = require('../helpers');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { historyLines } = require('../../scripts/lib/trading/decision-history');
const { createMcpClient } = require('../../scripts/lib/broker/mcp-client');
const exchange = require('../fixtures/mock-exchange');

const ROOT = path.resolve(__dirname, '..', '..');
const MOCK = path.join(ROOT, 'tests', 'fixtures', 'mock-exchange-server.js');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
const HARNESS = path.join(ROOT, 'tests', 'fixtures', 'fake-harness.js');
const TOOLS_SERVER = path.join(ROOT, 'scripts', 'harness-tools-mcp.js');
const MNQ_ID = 'fake:MNQ:Z26';
const STEP = 180000;
// The parity bars moved 23 weeks on (same weekday, same ET times: both dates are in daylight time):
// Wednesday 2026-09-30 evening to Tuesday 2026-10-06 early morning; the replay window is Monday's open.
const SHIFT = 161 * 864e5;
const BARS = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'))
  .map(b => ({ t: new Date(Date.parse(b.t) + SHIFT).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
const closeOf = t => Date.parse(t) + STEP;
const lines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

test('the replay wiring: the broker\'s clock file moves its clock; a conforming server cuts get_bars there, a leaking one does not', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'state.json');
  const clock = path.join(dir, 'clock.json');
  exchange.initState(state, { bars: { [MNQ_ID]: BARS } });
  const at = '2026-10-05T13:36:02.000Z';
  fs.writeFileSync(clock, JSON.stringify({ now: at }));
  const ask = env => exchange.handle(state, 'get_bars', { contractId: MNQ_ID, unit: 'minute', unitNumber: 3, limit: 20000 }, { MOCK_CLOCK_FILE: clock, ...env }).bars;
  const cut = ask({});
  assert.ok(cut.length > 1000);
  assert.ok(cut.every(b => closeOf(b.t) <= Date.parse(at)), 'every bar closed by the clock file\'s time');
  assert.strictEqual(cut.at(-1).t, '2026-10-05T13:33:00.000Z', 'the bar that closed at 13:36');
  // The leaking server the suite replays against: it serves the rest of the file too.
  const leaked = ask({ MOCK_LEAK_BARS: '1' });
  assert.ok(leaked.filter(b => closeOf(b.t) > Date.parse(at)).length > 100, 'bars after the clock: the test below is not vacuous');
});

function replaySetup() {
  const user = tmpDir();
  const live = path.join(user, 'live-home');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({
    brokers: { replaymock: { command: [process.execPath, MOCK], replay: true, journalEnv: 'MOCK_JOURNAL', env: ['MOCK_STATE_DIR', 'MOCK_JOURNAL', 'MOCK_CLOCK_FILE', 'MOCK_REPLAY', 'MOCK_INIT', 'MOCK_LEAK_BARS'] } },
  }));
  const config = path.join(user, 'replay.json');
  fs.writeFileSync(config, JSON.stringify({
    runId: 'nla', workDir: path.join(user, 'replays'), broker: 'replaymock',
    start: '2026-10-05T13:31:00Z', end: '2026-10-05T13:40:00Z', premarket: false,
    autotrader: { harness: 'custom', command: [process.execPath, HARNESS, '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York' },
    brokerEnv: { clockFile: 'MOCK_CLOCK_FILE', stateDir: 'MOCK_STATE_DIR', runId: null, start: null, end: null },
  }));
  // The account is flat, the market is the shifted parity bars, and the server leaks every bar after its clock.
  const init = { nowMs: Date.parse('2026-10-05T13:00:00Z'), prices: { [MNQ_ID]: BARS.at(-1).c, 'fake:MNQ:H27': BARS.at(-1).c, 'fake:MES:Z26': 5800 }, bars: { [MNQ_ID]: BARS.slice(-1400) } };
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: live, MOCK_REPLAY: '1', MOCK_INIT: JSON.stringify(init), MOCK_LEAK_BARS: '1', FAKE_HARNESS_LOOKAHEAD: '1', FTH_STRATEGIES_DIRS: FX_GOLDEN };
  return { user, live, config, env, runHome: path.join(user, 'replays', 'nla'), runDir: path.join(user, 'replays', 'nla', 'replay', 'nla') };
}

test('replay: at each decision time, nothing the runner, the scan, the briefing, the cycle or the agent\'s tools see closes after the replay clock', { timeout: 300000 }, () => {
  const w = replaySetup();
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'replay.js'), 'run', '--config', w.config], { encoding: 'utf8', env: w.env, timeout: 280000 });
  assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const recs = lines(path.join(w.runDir, '2026-10-05.jsonl'));
  assert.deepStrictEqual(recs.map(r => r.t), ['2026-10-05T13:33:02.000Z', '2026-10-05T13:36:02.000Z', '2026-10-05T13:39:02.000Z']);
  for (const r of recs) {
    const at = Date.parse(r.t);
    assert.strictEqual(r.cycles.length, 1, JSON.stringify(r));
    const cycle = JSON.parse(fs.readFileSync(r.cycles[0].file, 'utf8'));
    // The cycle decides the bar that closed at the clock (polled 2 s after), never a later one.
    assert.strictEqual(cycle.context.symbols[0].bar.t, new Date(at - 2000 - STEP).toISOString(), r.t);
    const seen = JSON.parse(/^LOOKAHEAD (.*)$/m.exec(cycle.transcript)[1]);
    assert.strictEqual(seen.clock, r.t);
    // The runner's bars file, as the cycle found it: cut at the clock though the server leaked the rest of the day.
    assert.strictEqual(seen.runnerBarsClose, new Date(at - 2000).toISOString(), `${r.t}: the runner's bars file`);
    // The agent's own fetch: cut at the clock too.
    assert.strictEqual(seen.fetch.error, false, seen.fetch.text);
    assert.ok(Date.parse(seen.fetchedBarsClose) <= at, `${r.t}: bars_fetch wrote a bar closing ${seen.fetchedBarsClose}`);
    // The tools on the runner's file read it; the snapshot's bar is the cycle's.
    for (const k of ['scan', 'snapshot', 'mtf']) assert.strictEqual(seen[k].error, false, `${k}: ${seen[k].text}`);
    assert.strictEqual(seen.snapshot.last, cycle.context.symbols[0].bar.t);
    // The bar briefing is this bar's.
    assert.strictEqual(seen.briefing.error, false, seen.briefing.text);
    assert.ok(Date.parse(seen.briefing.closedAt) <= at, `${r.t}: the briefing's bar closed ${seen.briefing.closedAt}`);
    // A file with the bar after the clock: refused by every bars tool, the same way.
    for (const [name, res] of Object.entries(seen.planted)) {
      assert.strictEqual(res.error, true, `${name} read a bar after the clock: ${res.text}`);
      assert.ok(res.text.includes(`1 bar(s) close after the replay clock (${r.t})`), `${name}: ${res.text}`);
    }
    // The decision history's "since" (decision-history.js): read from the bars closed by this cycle's bar only. The
    // lines the prompt showed are the session record's, and the same entries over every bar the server had (the
    // future too) give the same lines; over the bars a few closes on, different ones (the cut matters).
    const shown = cycle.context.historyLines || [];
    assert.deepStrictEqual(r.ran[0].history || [], shown, `${r.t}: the session record keeps the lines as shown`);
    if (recs.indexOf(r) > 0) {
      assert.ok(shown.length && shown.every(l => /; since [+-]?\d+t/.test(l)), `${r.t}: ${shown.join(' | ')}`);
      const asOf = closeOf(cycle.context.symbols[0].bar.t);
      const lines = upTo => historyLines(cycle.context.history, [{ symbol: 'MNQ', minutes: 3, bars: BARS, asOf: upTo }]);
      assert.deepStrictEqual(lines(asOf), shown, `${r.t}: the same lines from every bar, cut at the cycle's bar`);
      assert.notDeepStrictEqual(lines(asOf + 10 * STEP), shown, `${r.t}: later bars would change the lines (not vacuous)`);
    }
  }
  // Every bar the runner scanned and logged closed by the time it was scanned.
  const scans = lines(path.join(w.runHome, 'logs', 'scans-2026-10-05.jsonl'));
  assert.ok(scans.length >= 3);
  for (const s of scans) assert.ok(closeOf(s.bar.t) <= Date.parse(s.at), JSON.stringify(s).slice(0, 200));
  // The records the order gate reads: the last decision's bar, not a later one.
  const last = Date.parse(recs.at(-1).t);
  const briefing = JSON.parse(fs.readFileSync(path.join(w.runHome, 'briefing', 'MNQ.json'), 'utf8'));
  assert.ok(Date.parse(briefing.closedAt) <= last, briefing.closedAt);
  const mtf = JSON.parse(fs.readFileSync(path.join(w.runHome, 'mtf', 'MNQ.json'), 'utf8'));
  assert.ok(Date.parse(mtf.recordedAt) <= last, JSON.stringify(mtf).slice(0, 200));
  const runnerBars = JSON.parse(fs.readFileSync(path.join(w.runHome, 'bars', 'MNQ-3m.json'), 'utf8')).bars;
  assert.strictEqual(new Date(closeOf(runnerBars.at(-1).t)).toISOString(), new Date(last - 2000).toISOString());
});

/** A harness home whose broker is the fake one: a replay broker (replay: true) or a live one. */
function toolsHome({ replay }) {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, FAKE], replay } } }));
  fs.mkdirSync(path.join(home, 'bars'), { mode: 0o700 });
  recordBrokerSpecs(home, { broker: 'sim' });
  return home;
}

const toolsEnv = (home, extra = {}) => ({
  PATH: process.env.PATH, HOME: home, FTH_HOME: home, FTH_AUTONOMOUS: '', FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'), FTH_ENV_FILE: path.join(home, 'none.env'),
  // fx_orb (tests/fixtures/strategies-golden, the retired orb's rules): the strategy order_plan plans with.
  FTH_STRATEGIES_DIRS: FX_GOLDEN, ...extra,
});

async function withTools(env, fn) {
  const client = createMcpClient({ command: process.execPath, args: [TOOLS_SERVER], env, timeoutMs: 60000, clientName: 'no-look-ahead' });
  const call = async (name, args) => {
    const r = await client.request('tools/call', { name, arguments: args });
    return { text: r.content[0].text, isError: r.isError === true };
  };
  try {
    return await fn(call);
  } finally {
    client.close();
  }
}

test('harness tools under a replay clock: a bars file with a later bar is refused by every tool; bars_fetch cuts; live is unchanged', { timeout: 180000 }, async () => {
  const clock = '2026-10-05T13:36:02Z';
  const at = Date.parse(clock);
  const cutIdx = BARS.findIndex(b => closeOf(b.t) > at);
  const write = (home, name, bars) => {
    const f = path.join(home, 'bars', name);
    fs.writeFileSync(f, JSON.stringify({ contractId: 'MNQ', barSize: '3 minute', count: bars.length, bars }));
    return f;
  };
  const replayHome = toolsHome({ replay: true });
  const liveHome = toolsHome({ replay: false });
  // The same files in both homes: one cut at the clock, one with the bar that closes at 13:39 (after it).
  const cases = home => {
    const cut = write(home, 'MNQ-3m-cut.json', BARS.slice(0, cutIdx));
    const ahead = write(home, 'MNQ-3m-ahead.json', BARS.slice(0, cutIdx + 1));
    const daily = write(home, 'MNQ-1d.json', Array.from({ length: 30 }, (_, k) => ({ t: new Date(Date.parse('2026-09-06T00:00:00Z') + k * 864e5).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 1 })));
    return { cut, ahead, daily, calls: [
      ['strategies_scan', { symbol: 'MNQ', detail: true }],
      ['strategies_recent', { symbol: 'MNQ' }],
      ['market_snapshot', {}],
      ['mtf_read', { json: true }],
      ['order_plan', { symbol: 'MNQ', strategy: 'fx_orb', side: 'long' }],
    ] };
  };
  const r = cases(replayHome);
  // The broker serves the shifted parity bars and leaks the hour after the time it is asked for.
  const served = path.join(replayHome, 'served.json');
  fs.writeFileSync(served, JSON.stringify(BARS));
  await withTools(toolsEnv(replayHome, { FTH_REPLAY_NOW: clock, FAKE_BARS: served, FAKE_REPLAY_LEAK: '1' }), async call => {
    for (const [name, args] of r.calls) {
      const ahead = await call(name, { ...args, bars: r.ahead });
      assert.strictEqual(ahead.isError, true, `${name}: ${ahead.text}`);
      assert.match(ahead.text, new RegExp(`the bars file ${r.ahead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: 1 bar\\(s\\) close after the replay clock \\(2026-10-05T13:36:02\\.000Z\\), the first at 2026-10-05T13:39:00\\.000Z`), name);
      const cut = await call(name, { ...args, bars: r.cut });
      assert.ok(!/after the replay clock/.test(cut.text), `${name} on the cut file: ${cut.text.slice(0, 300)}`);
    }
    // The daily file of mtf_read: today's daily bar (opened 2026-10-05) has not closed at 13:36.
    const daily = await call('mtf_read', { bars: r.cut, daily: r.daily });
    assert.strictEqual(daily.isError, true);
    assert.match(daily.text, /the daily bars file .*MNQ-1d\.json: 1 bar\(s\) close after the replay clock/);
    // bars_fetch: the server leaks bars after its clock (FAKE_REPLAY_LEAK); the file holds only those closed by the harness clock.
    const fetched = await call('bars_fetch', { symbol: 'MNQ', timeframe: 3, count: 100 });
    assert.strictEqual(fetched.isError, false, fetched.text);
    const file = path.join(replayHome, 'bars-scratch', 'MNQ-3m.json');
    const got = JSON.parse(fs.readFileSync(file, 'utf8')).bars;
    // The server sent the hour after the clock too (the last 100 bars it had by then); the file keeps those closed by 13:36:02.
    assert.ok(got.length >= 50 && got.every(b => closeOf(b.t) <= at), JSON.stringify(got.map(b => b.t)));
    assert.strictEqual(got.at(-1).t, BARS[cutIdx - 1].t, 'the last bar is the one that closed at 13:36');
    // A briefing whose bar closed after the clock is not served, nor checked against.
    fs.mkdirSync(path.join(replayHome, 'briefing'));
    fs.writeFileSync(path.join(replayHome, 'briefing', 'MNQ.json'), JSON.stringify({ symbol: 'MNQ', minutes: 3, asOf: '2026-10-05T13:36:00.000Z', closedAt: '2026-10-05T13:39:00.000Z', sections: { m3: { validUntil: '2026-10-05T13:42:00.000Z', data: {} } } }));
    const b = await call('bar_briefing', { symbol: 'MNQ' });
    assert.strictEqual(b.isError, false);
    assert.match(b.text, /^The bar briefing for MNQ is not served: its bar closed 2026-10-05T13:39:00\.000Z, after the replay clock \(2026-10-05T13:36:02\.000Z\)/);
  });
  // Live (no replay clock): the same calls on the same files read every bar, as before.
  const l = cases(liveHome);
  await withTools(toolsEnv(liveHome), async call => {
    for (const [name, args] of l.calls.filter(([n]) => n !== 'order_plan')) {
      const ahead = await call(name, { ...args, bars: l.ahead });
      assert.ok(!/after the replay clock/.test(ahead.text), `${name} live: ${ahead.text.slice(0, 300)}`);
      assert.strictEqual(ahead.isError, false, `${name} live: ${ahead.text.slice(0, 300)}`);
    }
    const snap = JSON.parse((await call('market_snapshot', { bars: l.ahead })).text);
    assert.strictEqual(snap.last.t, BARS[cutIdx].t, 'live reads the last bar in the file');
  });
});

test('check-broker-mcp: against a replay server the dates it sends are the replay clock\'s, and a server leaking bars after it fails; live, the wall clock', { timeout: 120000 }, () => {
  const run = (env, extra = []) => {
    const home = tmpDir();
    const args = path.join(home, 'args.jsonl');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-broker-mcp.js'), '--account', '7', ...extra, '--', process.execPath, FAKE], {
      encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: home, FTH_HOME: home, FTH_ENV_FILE: path.join(home, 'none.env'), FAKE_ARGS: args, ...env },
    });
    const since = lines(args).filter(c => c.name === 'search_trades' && c.args.startTimestamp).map(c => c.args.startTimestamp);
    return { ...r, since };
  };
  // The server reports replay mode at 2026-03-04 15:00: a week back from then, not from today.
  const replay = run({ FAKE_REPLAY_NOW: '2026-03-04T15:00:00.000Z' });
  assert.strictEqual(replay.status, 0, replay.stdout + replay.stderr);
  assert.match(replay.stdout, /ok {3}replay clock: every date sent is at the replay server's time \(2026-03-04T15:00:00\.000Z\)/);
  assert.match(replay.stdout, /ok {3}get_bars: no bar closes after the replay clock/);
  assert.strictEqual(replay.since.length, 1);
  assert.ok(Date.parse(replay.since[0]) < Date.parse('2026-02-26T00:00:00Z') && Date.parse(replay.since[0]) > Date.parse('2026-02-24T00:00:00Z'), replay.since[0]);
  // A replay server whose get_bars serves bars after its clock: look-ahead, a failure.
  const leak = run({ FAKE_REPLAY_NOW: '2026-10-07T13:02:30.000Z', FAKE_REPLAY_LEAK: '1' });
  assert.strictEqual(leak.status, 1, leak.stdout);
  assert.match(leak.stdout, /FAIL get_bars: no bar closes after the replay clock \(2026-10-07T13:02:30\.000Z\)\n {7}3 of 5 bar\(s\) close after it \(the first opened 2026-10-07T13:02:00\.000Z\): look-ahead/);
  // A configured replay clock (FTH_REPLAY_NOW with a replay broker) dates the requests even before the server answers.
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { command: [process.execPath, FAKE], replay: true } } }));
  const configured = run({ FTH_HOME: home, FTH_REPLAY_NOW: '2026-03-04T15:00:00Z', FAKE_REPLAY_NOW: '2026-03-04T15:00:00.000Z' });
  assert.strictEqual(configured.status, 0, configured.stdout + configured.stderr);
  assert.match(configured.stdout, /replay clock: every date sent is at the configured replay clock \(2026-03-04T15:00:00\.000Z\)/);
  assert.strictEqual(configured.since[0], replay.since[0]);
  // A replay clock that is refused (no replay broker configured) stops the check: nothing is sent.
  const refused = run({ FTH_REPLAY_NOW: '2026-03-04T15:00:00Z' });
  assert.strictEqual(refused.status, 2);
  assert.match(refused.stderr, /not a replay broker/);
  assert.deepStrictEqual(refused.since, []);
  // Live: the wall clock, as before.
  const live = run({});
  assert.strictEqual(live.status, 0, live.stdout);
  assert.doesNotMatch(live.stdout, /replay clock/);
  assert.ok(Math.abs(Date.parse(live.since[0]) - (Date.now() - 7 * 864e5)) < 2 * 864e5, live.since[0]);
});
