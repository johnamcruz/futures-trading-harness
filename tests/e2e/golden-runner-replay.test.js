'use strict';

// Golden regression end to end: the live runner as wired for the harness (runner-wiring.js wireRunner, the one a
// replay pass runs) drives a scripted sequence of cycles over fixture bars served by a replay-style broker
// client: the bars file, the multi-timeframe and signal records, the bar briefing, the strategy scan, the
// report cache, and the prompt, cycle by cycle. Pinned: each cycle's served (cached) roles and what fired, the
// cache's keys after each cycle, and the prompts. The same run with a broker's extra nested field on every bar
// gives the same prompts, the same cache hits and keys, and bars files that keep the field with the same OHLCV.
// Goldens: tests/fixtures/golden/ (tests/golden.js says how to update them on purpose).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { assertGolden } = require('../golden');
const G = require('../fixtures/golden-bars');
const { FAKE_BROKERS, tmpDir } = require('../helpers');
const { validateConfig, childEnv } = require('../../scripts/lib/autotrader');
const { barBriefing } = require('../../scripts/lib/harness-tools/briefing');
const { decisionPoints } = require('../../scripts/lib/replay/schedule');
const { tfLabel } = require('../../scripts/lib/lanes');
const { wireRunner, closedBarsOnly } = require('../../scripts/lib/runner-wiring');
const { readBriefing } = require('../../scripts/lib/trading/briefing');
const RC = require('../../scripts/lib/trading/report-cache');

const MNQ = G.served(G.load(G.SERIES[0]));
const START = Date.parse('2026-04-27T14:36:01Z'); // 10:36 ET: the cycles cross the 10:45 15m close and the 11:00 1h close
const END = Date.parse('2026-04-27T15:06:30Z');
const BALANCE_DROP_AT = Date.parse('2026-04-27T14:51:00Z'); // a closed trade: the account changes, phase 1 is read again
const ANALYSTS = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'];

// opencode's task events, as a cycle's output carries them (report-cache.test.js).
const task = (role, report, [s, e]) => JSON.stringify({ type: 'tool_use', part: { tool: 'task', state: { status: 'completed', input: { subagent_type: role }, output: `<task id="s" state="completed">\n<task_result>\n${report}\n</task_result>\n</task>`, time: { start: s, end: e } } } });

// `agents`: the runner config's per-role timeframes; `analyst(role, run)`: an analyst's report (default: two build on the
// briefing file, the third reads the bars); `fresh`: one fresh runner per decision point, the state kept between
// them, under the replay clock (as replay runs passes), instead of the live loop; `restart`: the live loop, a new runner every pass from its saved state.
async function replay(bars, { end = END, state = null, lanes = null, timeframe = 3, bars1 = null, inspect = null, extraEnv = {}, agents = null, analyst = null, fresh = false, start = START, restart = false } = {}) {
  const home = tmpDir();
  // The prompt names the harness home from the process's environment (autotrader.js prompts): this run's home.
  const savedHome = process.env.FTH_HOME;
  process.env.FTH_HOME = home;
  const real = fs.realpathSync(home);
  const paths = text => text.split(real).join('<home>').split(home).join('<home>').split(G.ROOT).join('<root>');
  const clockRef = { t: start };
  const now = () => new Date(clockRef.t);
  const env = {
    HOME: home, FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_JOURNAL: path.join(home, 'journal.jsonl'),
    FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'), FTH_ACCOUNTS_DIRS: path.join(home, 'no-accounts'), ...extraEnv,
  };
  // `lanes`: the same runner configured as one lane instead of the legacy timeframe (lanes.js).
  const { timeframe: _tf, ...noTimeframe } = { harness: 'opencode', cycle: 'full', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], dataDir: path.join(home, 'bars'), bars: 700 };
  const cfg = validateConfig({ ...(lanes ? { ...noTimeframe, lanes } : { ...noTimeframe, timeframe }), ...(agents ? { agents } : {}) });
  const broker = {
    async activeContract(symbol) { return { id: symbol, name: `${symbol}M6`, tickSize: 0.25, tickValue: 0.5 }; },
    // The replay server's bars up to its clock (the pass drops any that close later: closedBarsOnly).
    // `bars1`: a 1m lane's bars (several lanes); the request's minutes pick the series.
    async closedBars(contractId, { limit, minutes }) { return JSON.parse(JSON.stringify((minutes === 1 && bars1 ? bars1 : bars).filter(b => Date.parse(b.t) < clockRef.t).slice(-limit))); },
    async accountState() { return { positions: [], orders: [] }; },
    async accountBalance() { return clockRef.t >= BALANCE_DROP_AT ? 49950 : 50000; },
    async netPosition() { return 0; },
    async workingOrders() { return 0; },
  };
  const cycles = [];
  const written = [];
  const runCycle = async (action, prompt, limits = {}) => {
    const ctx = limits.context || {};
    // The cycle's environment as the runner hands it to the harness (FTH_CYCLE_BARS, FTH_CYCLE_AT): what a role's tools read.
    const runEnv = analyst ? childEnv({ ...cfg, harness: 'claude' }, G.ROOT, env, ctx) : null;
    const served = ctx.cachedRoles || [];
    const b = readBriefing(home, 'MNQ');
    const versions = b ? ['m3', 'm15', 'h1', 'day'].map(p => b.sections[p].version).join(', ') : 'none';
    // The roles not served from the cache run: two analysts build on the briefing; the third reads the bars itself (never cacheable).
    const output = [
      ...ANALYSTS.filter(r => !served.includes(r)).map((r, k) => task(r, analyst ? analyst(r, { ctx, cfg, env: runEnv, now }) : k === 2 || r === ANALYSTS[2] ? 'Data: get_bars, market_snapshot\nBias: neutral' : `Data: bar_briefing ${versions}\nBias: long`, [10, 20 + k])),
      ...(served.includes('risk-manager') ? [] : [task('risk-manager', 'Phase 1: flat, budget 2 trades', [10, 15])]),
      task('risk-manager', 'Phase 2: VETO - no plan', [30, 40]),
    ].join('\n');
    const cache = RC.readCache(home);
    // `lanes`: several lanes, the lanes this cycle covers (the context the cycle log records).
    cycles.push({ at: now().toISOString(), action, prompt: paths(prompt), history: ctx.historyLines || [], served, fired: (ctx.symbols || []).flatMap(s => s.fired.map(f => `${f.name} ${f.direction}`)), before: cache, ...(ctx.lanes ? { lanes: ctx.lanes } : {}) });
    clockRef.t += 20000;
    return { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - golden replay', transcript: output };
  };
  // `restart`: a new runner every pass from the state it saved (as JSON), as a replay runs one pass per process.
  let saved = state;
  const make = () => wireRunner({
    cfg, root: G.ROOT, home, env, client: closedBarsOnly(broker, now), dataDir: cfg.dataDir, now, runCycle,
    loadState: () => (restart ? saved : state), saveState: s => { if (restart) saved = JSON.parse(JSON.stringify(s)); }, killSwitchFile: path.join(home, 'STOP'), log: () => {}, event: () => {},
  });
  const runner = make();
  const keysAfter = [];
  let guard = 0;
  const after = before => {
    if (cycles.length > before) {
      const c = RC.readCache(home);
      keysAfter.push(c ? { analysts: Object.fromEntries(Object.entries(c.analysts).map(([r, x]) => [r, x.tf ? { ...x.versions, tf: x.tf } : x.versions])), phase1: c.phase1 && { account: c.phase1.account, day: c.phase1.day }, symbols: c.symbols } : null);
      written.push(JSON.parse(fs.readFileSync(path.join(cfg.dataDir, `MNQ-${cfg.timeframe}m.json`), 'utf8')).bars);
    }
  };
  try {
    if (fresh) {
      // Replay: a new runner (a new process) per decision point, at the point, the state saved between passes.
      let saved = state;
      for (const p of decisionPoints(cfg, { start: new Date(start), end: new Date(end) }).filter(x => x.kind === 'trade')) {
        clockRef.t = p.t.getTime();
        const pass = wireRunner({
          cfg, root: G.ROOT, home, env: { ...env, FTH_REPLAY_NOW: p.t.toISOString() }, client: closedBarsOnly(broker, now), dataDir: cfg.dataDir, now, runCycle,
          loadState: () => (saved ? JSON.parse(JSON.stringify(saved)) : null), saveState: x => { saved = JSON.parse(JSON.stringify(x)); },
          killSwitchFile: path.join(home, 'STOP'), log: () => {}, event: () => {},
        });
        const before = cycles.length;
        await pass.step();
        after(before);
      }
    }
    while (!fresh && clockRef.t < end) {
      const before = cycles.length;
      clockRef.t += await (restart ? make() : runner).step();
      after(before);
      if ((guard += 1) > 10000) throw new Error('runaway loop');
    }
    if (inspect) inspect(home, cfg);
  } finally {
    if (savedHome === undefined) delete process.env.FTH_HOME;
    else process.env.FTH_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { cycles, keysAfter, written };
}

const short = r => (r === 'risk-manager' ? 'phase1' : r.replace('-analyst', ''));
function sequenceText({ cycles, keysAfter }) {
  return cycles.map((c, k) => {
    const hit = ['risk-manager', ...ANALYSTS].map(r => `${short(r)} ${c.served.includes(r) ? 'HIT' : 'miss'}`).join(', ');
    const keys = keysAfter[k];
    const after = keys ? `cached after: ${Object.entries(keys.analysts).map(([r, v]) => `${short(r)} ${v.m15} ${v.h1} ${v.day}`).join('; ') || 'no analyst'}; phase1 ${keys.phase1 ? `${keys.phase1.day} ${keys.phase1.account}` : 'none'}; symbols ${JSON.stringify(keys.symbols)}` : 'no cache';
    return `${c.at} ${c.action}: ${hit}; fired [${c.fired.join(', ')}]\n  ${after}`;
  }).join('\n');
}

test('the runner\'s scripted replay: the report cache\'s hits, misses and keys per cycle and the prompts are pinned; a broker\'s extra bar field changes none of it', async () => {
  const plain = await replay(MNQ);
  const ext = await replay(G.withExt(MNQ));
  assert.ok(plain.cycles.length >= 10, `cycles: ${plain.cycles.length}`);
  // Hits happen and misses happen: an analyst's report holds within a 15m candle, phase 1 while the account holds.
  const hits = plain.cycles.flatMap(c => c.served);
  assert.ok(hits.includes(ANALYSTS[0]) && hits.includes('risk-manager'), 'cache hits');
  assert.ok(!hits.includes(ANALYSTS[2]), 'a report not built on the briefing is never served');
  assert.ok(plain.cycles.some((c, k) => k > 0 && !c.served.includes(ANALYSTS[0])), 'a new 15m candle is a miss');
  const drop = plain.cycles.findIndex(c => Date.parse(c.at) >= BALANCE_DROP_AT);
  assert.ok(drop > 0 && !plain.cycles[drop].served.includes('risk-manager') && plain.cycles[drop - 1].served.includes('risk-manager'), 'the account changed: phase 1 misses');
  // The broker's field: the same sequence, keys and prompts; the bars files keep it, with the same OHLCV.
  assert.strictEqual(sequenceText(ext), sequenceText(plain));
  assert.deepStrictEqual(ext.cycles.map(c => c.prompt), plain.cycles.map(c => c.prompt));
  assert.deepStrictEqual(ext.written.map(G.ohlcv), plain.written.map(G.ohlcv));
  assert.ok(ext.written.every(f => f.every(b => b.ext && typeof b.ext.a === 'number')), 'the bars file keeps the broker\'s field');
  assert.ok(plain.written.every(f => f.every(b => !('ext' in b))));
  assertGolden('runner-replay-cache.txt', sequenceText(plain));
  assertGolden('runner-replay-prompts.txt', plain.cycles.map(c => `=== ${c.at} ${c.action} ===\n${c.prompt.split('. ').join('.\n  ')}`).join('\n'));
});

test('one lane is the legacy timeframe: the same scripted replay gives the same cycles, cache keys and prompts, against the same goldens', async () => {
  const legacy = await replay(MNQ);
  const laned = await replay(MNQ, { lanes: [{ timeframe: 3, trigger: 'bar' }] });
  assert.ok(laned.cycles.length >= 10);
  assert.strictEqual(sequenceText(laned), sequenceText(legacy));
  assert.deepStrictEqual(laned.cycles.map(c => c.prompt), legacy.cycles.map(c => c.prompt));
  assert.deepStrictEqual(laned.written, legacy.written);
  assertGolden('runner-replay-cache.txt', sequenceText(laned));
  assertGolden('runner-replay-prompts.txt', laned.cycles.map(c => `=== ${c.at} ${c.action} ===\n${c.prompt.split('. ').join('.\n  ')}`).join('\n'));
});

test('one lane on 1-minute bars is the legacy 1-minute timeframe (not the default 3): the same cycles, cache keys, prompts and bars files', async () => {
  const m1 = G.served(G.load(G.SERIES[2]));
  const end = START + 8 * 60000;
  const legacy = await replay(m1, { end, timeframe: 1 });
  const laned = await replay(m1, { end, lanes: [{ timeframe: 1, trigger: 'bar' }] });
  assert.ok(legacy.cycles.length >= 5, `cycles: ${legacy.cycles.length}`);
  assert.match(legacy.cycles[0].prompt, /a 1-minute bar just closed/);
  assert.strictEqual(sequenceText(laned), sequenceText(legacy));
  assert.deepStrictEqual(laned.cycles.map(c => c.prompt), legacy.cycles.map(c => c.prompt));
  assert.deepStrictEqual(laned.written, legacy.written);
});

test('the runner\'s prompt after a failed premarket says the plan is unavailable (pinned)', async () => {
  // Today's premarket failed twice; its next try is tomorrow, so the cycles trade without a plan and say so.
  const state = { day: '2026-04-27', premarketDone: false, eodDone: false, cycles: 0, lastCycleAt: null, premarketTries: 2, premarketUnavailable: { at: '2026-04-27T13:25:00.000Z', tries: 2 }, premarketRetryAt: '2026-04-28T13:00:00.000Z' };
  const run = await replay(MNQ, { end: START + 60000, state });
  assert.strictEqual(run.cycles.length, 1);
  assert.match(run.cycles[0].prompt, /premarket plan unavailable \(today's premarket run failed 2 time\(s\)/);
  assertGolden('runner-replay-premarket-unavailable.txt', run.cycles.map(c => `=== ${c.at} ${c.action} ===\n${c.prompt.split('. ').join('.\n  ')}`).join('\n'));
});

test('two lanes wired for the harness: each lane\'s bars file and signal record, the first lane\'s multi-timeframe record and briefing, the cache keyed on the first lane\'s bar', async () => {
  // 1m bars inside each golden 3m bar (the 3m bar's open, high, low and close spread over three minutes).
  const bars1 = MNQ.flatMap(b => [0, 1, 2].map(k => ({ t: new Date(Date.parse(b.t) + k * 60000).toISOString(), o: k ? b.c : b.o, h: b.h, l: b.l, c: b.c, v: Math.round(b.v / 3) })));
  const seen = {};
  const run = await replay(MNQ, {
    lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'bar' }], bars1, end: Date.parse('2026-04-27T14:46:30Z'),
    inspect: (home, cfg) => {
      const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
      seen.bars3 = read(path.join(cfg.dataDir, 'MNQ-3m.json'));
      seen.bars1 = read(path.join(cfg.dataDir, 'MNQ-1m.json'));
      seen.sig3 = read(path.join(home, 'signals', 'MNQ-3m.json'));
      seen.sig1 = read(path.join(home, 'signals', 'MNQ-1m.json'));
      seen.mtf = read(path.join(home, 'mtf', 'MNQ.json'));
      seen.briefing = readBriefing(home, 'MNQ');
    },
  });
  // One cycle per minute's close (10:37 .. 10:46), the 3m closes with both lanes.
  const lanesOf = c => (c.prompt.match(/Lanes closed this cycle: ([^;]+);/) || [])[1];
  assert.ok(run.cycles.length >= 8, `cycles: ${run.cycles.length}`);
  const both = run.cycles.filter(c => /3m \(every bar\), 1m \(every bar\)/.test(lanesOf(c) || ''));
  const oneMin = run.cycles.filter(c => lanesOf(c) === '1m (every bar)');
  assert.ok(both.length >= 3 && oneMin.length >= 5 && both.length + oneMin.length === run.cycles.length, run.cycles.map(lanesOf).join(' | '));
  // Each lane its own bars file and signal record, on its own bar.
  assert.strictEqual(seen.bars3.barSize, '3 minute');
  assert.strictEqual(seen.bars1.barSize, '1 minute');
  assert.strictEqual(seen.sig3.timeframe, '3m');
  assert.strictEqual(seen.sig1.timeframe, '1m');
  assert.strictEqual(Date.parse(seen.sig1.closedAt) - Date.parse(seen.sig1.asOf), 60000);
  // The multi-timeframe record and the briefing: the first lane's (3m) bars only.
  assert.strictEqual(seen.mtf.asOf, seen.bars3.bars.at(-1).t);
  assert.strictEqual(seen.briefing.minutes, 3);
  assert.strictEqual(seen.briefing.asOf, seen.bars3.bars.at(-1).t);
  // The cache: a 1m-only cycle is keyed on the first lane's last bar (the briefing it rests on), so it reuses the
  // analysts' reports cached at that 3m bar.
  for (const c of oneMin) assert.ok(c.served.includes(ANALYSTS[0]) && c.served.includes(ANALYSTS[1]), `${c.at}: ${c.served}`);
  // A 1m-only cycle names the 3m trend record the gate reads (written at the last 3m bar).
  for (const c of oneMin) assert.match(c.prompt, /MNQ: a 1-minute bar just closed .* MNQ [^.]*\(recorded for the order gate, which enforces it\)/);
});

test('the report cache with a 3m bar lane and a 1m signal lane: the hit/miss sequence and keys are pinned; 1m cycles reuse the 3m reports, no extra misses', async () => {
  // A 1m rules strategy (a reversal: no trend rule) firing on a 1m bar that closes off the last one: in these bars,
  // the first minute of each 3m bar (1m-only closes), so the signal lane cycles between the 3m closes.
  const dir = path.join(tmpDir(), 'strategies', 'tick_up');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'STRATEGY.md'), [
    '---', 'name: tick_up', 'description: Test rules strategy on 1-minute bars, a close above or below the last one, for the lanes cache test.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 1m', 'signal: rules', 'mtf: reversal', 'rules:', '  long:', '    - close > close[1]', '  short:', '    - close < close[1]',
    'risk:', '  stop: atr:0.5', '  min_rr: 2', '---', '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  const extraEnv = { FTH_STRATEGIES_DIRS: path.dirname(dir) };
  const bars1 = MNQ.flatMap(b => [0, 1, 2].map(k => ({ t: new Date(Date.parse(b.t) + k * 60000).toISOString(), o: k ? b.c : b.o, h: b.h, l: b.l, c: b.c, v: Math.round(b.v / 3) })));
  const single = await replay(MNQ, { extraEnv });
  const laned = await replay(MNQ, { lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal' }], bars1, extraEnv });
  const isOneMin = c => Array.isArray(c.lanes) && c.lanes.length === 1 && c.lanes[0] === '1m';
  const threes = laned.cycles.filter(c => !isOneMin(c));
  const ones = laned.cycles.filter(isOneMin);
  assert.ok(ones.length >= 3, `1m signal cycles: ${ones.length}`);
  // The 3m closes cycle as the single lane does: the same number, and the same roles served at each.
  assert.deepStrictEqual(threes.map(c => c.served), single.cycles.map(c => c.served));
  // Every 1m-only cycle reuses the cacheable analysts' reports of the last 3m bar: no extra analyst miss.
  const misses = list => list.reduce((n, c) => n + ANALYSTS.slice(0, 2).filter(r => !c.served.includes(r)).length, 0);
  for (const c of ones) assert.ok(c.served.includes(ANALYSTS[0]) && c.served.includes(ANALYSTS[1]), `${c.at}: ${c.served}`);
  assert.strictEqual(misses(laned.cycles), misses(single.cycles), 'no analyst misses beyond the single lane\'s');
  // Phase 1 misses only where the account changed (the balance drop), as in the single lane.
  const phase1Misses = list => list.filter(c => !c.served.includes('risk-manager')).map(c => c.at);
  assert.ok(phase1Misses(ones).every(at => Date.parse(at) >= BALANCE_DROP_AT && Date.parse(at) < BALANCE_DROP_AT + 4 * 60000), phase1Misses(ones).join(','));
  // The slower parts' keys (m15, h1, day) don't move across a 1m-only cycle.
  laned.cycles.forEach((c, k) => {
    if (!isOneMin(c) || k === 0) return;
    const keys = x => Object.fromEntries(Object.entries(x.analysts).map(([r, v]) => [r, [v.m15, v.h1, v.day]]));
    assert.deepStrictEqual(keys(laned.keysAfter[k]), keys(laned.keysAfter[k - 1]), c.at);
  });
  const rate = list => {
    const hits = list.reduce((n, c) => n + ['risk-manager', ...ANALYSTS.slice(0, 2)].filter(r => c.served.includes(r)).length, 0);
    return `${hits}/${list.length * 3} (${Math.round((100 * hits) / (list.length * 3))}%)`;
  };
  const lanesText = laned.cycles.map((c, k) => `${(c.lanes || []).join('+')} ${sequenceText({ cycles: [c], keysAfter: [laned.keysAfter[k]] })}`).join('\n');
  assertGolden('runner-replay-lanes-cache.txt', `hit rate (phase 1 and the two cacheable analysts): single 3m lane ${rate(single.cycles)}; 3m bar + 1m signal lanes ${rate(laned.cycles)}\n${lanesText}`);
  // The prompts of the two lanes, the decision history of each (lane-cycle.js laneHistory) included.
  assertGolden('runner-replay-lanes-prompts.txt', laned.cycles.map(c => `=== ${c.at} ${c.action} ${(c.lanes || []).join('+')} ===\n${c.prompt.split('. ').join('.\n  ')}`).join('\n'));
});

test('the decision history: a runner restarted every pass (as a replay runs, one pass per process, its state from the file) shows the same history text as one live runner over the same bars; the text is in every prompt it names', async () => {
  // Two lanes: a restarted runner keeps each lane's clock in its state (laneClocks), as a replay pass reads it.
  const bars1 = MNQ.flatMap(b => [0, 1, 2].map(k => ({ t: new Date(Date.parse(b.t) + k * 60000).toISOString(), o: k ? b.c : b.o, h: b.h, l: b.l, c: b.c, v: Math.round(b.v / 3) })));
  const opts = { lanes: [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'bar' }], bars1, end: Date.parse('2026-04-27T14:50:30Z') };
  const live = await replay(MNQ, opts);
  const replayed = await replay(MNQ, { ...opts, restart: true });
  assert.ok(live.cycles.length >= 10, `cycles: ${live.cycles.length}`);
  assert.deepStrictEqual(replayed.cycles.map(c => c.history), live.cycles.map(c => c.history));
  // Not vacuous: the later cycles show their decisions with the price and what happened since.
  assert.ok(live.cycles.slice(1).every(c => c.history.length && c.history.every(l => /@[\d.]+: .*; since [+-]?\d+t/.test(l))), live.cycles.map(c => c.history.join(' | ')).join('\n'));
  // The recorded lines are exactly the prompt's: all of them, in order, and nothing else.
  for (const c of live.cycles) if (c.history.length) assert.ok(c.prompt.includes(`): ${c.history.join(' | ')}. Don't flip-flop`), `${c.at}: the prompt shows ${c.history.join(' | ')}`);
});

// Per-agent timeframes (lanes.js analystFrames): an analyst reads bar_briefing as a role would, through the cycle's
// environment (childEnv), with its own timeframe when the prompt gives it one, and names the versions it read.
const AGENT_TFS = { 'market-structure-analyst': { timeframe: '3m' }, 'trend-momentum-analyst': { timeframe: '15m' }, 'volume-liquidity-analyst': { timeframe: '1h' } };
const MULTI_END = Date.parse('2026-04-27T16:06:30Z'); // 10:36 .. 12:06 ET: two 1h closes (11:00, 12:00), six 15m closes
function toolAnalyst(role, { ctx, env, now }) {
  const tf = ((ctx.frames || []).find(f => f.role === role) || {}).timeframe;
  const out = barBriefing({ symbol: 'MNQ', json: true, ...(tf ? { timeframe: tf } : {}) }, { env, now, replayAt: () => null }).text;
  let b;
  try { b = JSON.parse(out); } catch (_err) { return `Data: no current briefing; get_bars (${out.trim().slice(0, 80)})\nBias: neutral`; }
  const parts = tf ? [b.sections.bar, ...Object.values(b.shared)] : ['m3', 'm15', 'h1', 'day'].map(p => b.sections[p]);
  return `Data: bar_briefing ${tf ? `${tf} ` : ''}${parts.map(x => x.version).join(', ')}\nBias: long`;
}
const tickUp = () => {
  const dir = path.join(tmpDir(), 'strategies', 'tick_up');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'STRATEGY.md'), [
    '---', 'name: tick_up', 'description: Test rules strategy on 1-minute bars, a close above or below the last one, for the lanes cache test.',
    'status: active', 'instruments: [MNQ]', 'timeframe: 1m', 'signal: rules', 'mtf: reversal', 'rules:', '  long:', '    - close > close[1]', '  short:', '    - close < close[1]',
    'risk:', '  stop: atr:0.5', '  min_rr: 2', '---', '## When to Use', '## How It Works', '## Examples', '',
  ].join('\n'));
  return { FTH_STRATEGIES_DIRS: path.dirname(dir) };
};
const BARS1 = MNQ.flatMap(b => [0, 1, 2].map(k => ({ t: new Date(Date.parse(b.t) + k * 60000).toISOString(), o: k ? b.c : b.o, h: b.h, l: b.l, c: b.c, v: Math.round(b.v / 3) })));
const TWO_LANES = [{ timeframe: 3, trigger: 'bar' }, { timeframe: 1, trigger: 'signal' }];
// Hits over cycles, and the runs (misses: the role launched) it took.
const hitRate = (cycles, role) => { const n = cycles.filter(c => c.served.includes(role)).length; return `${n}/${cycles.length} (${Math.round((100 * n) / cycles.length)}%, ${cycles.length - n} runs)`; };
function framesText({ cycles, keysAfter }) {
  return cycles.map((c, k) => {
    const hit = ['risk-manager', ...ANALYSTS].map(r => `${short(r)} ${c.served.includes(r) ? 'HIT' : 'miss'}`).join(', ');
    const keys = keysAfter[k];
    const after = keys ? Object.entries(keys.analysts).map(([r, v]) => `${short(r)}${v.tf ? ` ${tfLabel(v.tf)}` : ''} ${['bar', 'm15', 'h1', 'day'].filter(p => v[p]).map(p => v[p]).join(' ')}`).join('; ') || 'no analyst' : 'no cache';
    return `${c.at} ${(c.lanes || []).join('+')}: ${hit}\n  cached after: ${after}`;
  }).join('\n');
}

test('analysts on 3m, 15m and 1h with a 1m signal lane: each reads its own timeframe\'s briefing; the hit/miss sequence and keys are pinned; slower analysts hit far more often', async () => {
  // Role skills full: the own-timeframe rule alone. In index mode, the default, a role a lookup is required of also
  // runs on a bar where a setup fired (runner-wiring lookupRoles), pinned in runner-replay-cache.txt and
  // runner-replay-lanes-cache.txt.
  const extraEnv = { ...tickUp(), FTH_ROLE_SKILLS: 'full' };
  const one = await replay(MNQ, { lanes: TWO_LANES, bars1: BARS1, extraEnv, end: MULTI_END, analyst: toolAnalyst });
  const multi = await replay(MNQ, { lanes: TWO_LANES, bars1: BARS1, extraEnv, end: MULTI_END, analyst: toolAnalyst, agents: AGENT_TFS });
  assert.ok(multi.cycles.length >= 40, `cycles: ${multi.cycles.length}`);
  // The same cycles (the agents' timeframes add no decision time), the same phase-1 hits.
  assert.deepStrictEqual(multi.cycles.map(c => `${c.at} ${c.lanes}`), one.cycles.map(c => `${c.at} ${c.lanes}`));
  assert.deepStrictEqual(multi.cycles.map(c => c.served.includes('risk-manager')), one.cycles.map(c => c.served.includes('risk-manager')));
  const [ms, tm, vl] = ANALYSTS;
  const hits = (run, r) => run.cycles.filter(c => c.served.includes(r)).length;
  // One timeframe: every analyst reads the 3m briefing and holds to the next 15m close, so all three alike; on 3m, 15m
  // and 1h the 3m one keeps that rule, the 15m one holds within its 15m bar, the 1h one within its hour.
  assert.strictEqual(hits(one, ms), hits(one, vl));
  assert.strictEqual(hits(multi, ms), hits(one, ms), 'an analyst on the first lane\'s timeframe is cached as before');
  assert.ok(hits(multi, vl) > hits(multi, tm) && hits(multi, vl) >= multi.cycles.length - 3, `1h ${hits(multi, vl)} vs 15m ${hits(multi, tm)} of ${multi.cycles.length}`);
  // Each own-timeframe report is a miss exactly at its own bar's close (the first cycle at or after it), and hits otherwise.
  const missAt = (run, r) => run.cycles.map((c, k) => (k > 0 && !c.served.includes(r) ? c.at : null)).filter(Boolean);
  const closesAt = m => multi.cycles.filter((c, k) => k > 0 && Math.floor(Date.parse(c.at) / (m * 60000)) !== Math.floor(Date.parse(multi.cycles[k - 1].at) / (m * 60000))).map(c => c.at);
  assert.deepStrictEqual(missAt(multi, vl), closesAt(60));
  assert.deepStrictEqual(missAt(multi, tm), closesAt(15));
  // The 1h analyst's key holds its 1h bar, the shared h1 and day (never the m15, which changes faster).
  const lastKeys = multi.keysAfter.at(-1).analysts;
  assert.deepStrictEqual(Object.keys(lastKeys[vl]).sort(), ['bar', 'day', 'h1', 'tf']);
  assert.match(lastKeys[vl].bar, /^bar60m@/);
  assert.deepStrictEqual(Object.keys(lastKeys[tm]).sort(), ['bar', 'day', 'h1', 'm15', 'tf']);
  assert.ok(!('tf' in lastKeys[ms]), 'the 3m analyst keeps the legacy key');
  // The prompt gives each launched analyst its timeframe; cached ones say how long they hold.
  assert.match(multi.cycles[0].prompt, /Each analyst reads its own timeframe: give it that timeframe with the symbol: trend-momentum-analyst on 15m \(bar_briefing with "timeframe": "15m"; its bars file is named there\), volume-liquidity-analyst on 1h/);
  assert.doesNotMatch(one.cycles.map(c => c.prompt).join('\n'), /own timeframe/);
  const cachedOwn = multi.cycles.find(c => c.served.includes(vl) && c.served.includes(tm));
  assert.match(cachedOwn.prompt, /--- volume-liquidity-analyst report \(1h, from \d\d:\d\d ET, holds until \d\d:00 ET\) ---\nData: bar_briefing 1h bar60m@/);
  const rates = `hit rate per analyst (cycles): one timeframe (3m) ${ANALYSTS.map(r => `${short(r)} ${hitRate(one.cycles, r)}`).join(', ')}; 3m/15m/1h ${ANALYSTS.map(r => `${short(r)} ${hitRate(multi.cycles, r)}`).join(', ')}`;
  assertGolden('runner-replay-frames-cache.txt', `${rates}\n${framesText(multi)}`);
  assertGolden('runner-replay-frames-prompts.txt', [0, multi.cycles.indexOf(cachedOwn)].map(k => multi.cycles[k]).map(c => `=== ${c.at} ${c.action} ${(c.lanes || []).join('+')} ===\n${c.prompt.split('. ').join('.\n  ')}`).join('\n'));
});

test('replay equals live with analysts on their own timeframes: a fresh runner per decision point gives the same reports, cache hits, keys and prompts', async () => {
  const extraEnv = tickUp();
  const end = Date.parse('2026-04-27T15:21:30Z'); // across the 11:00 1h close
  // Both from the first decision point (a 3m close plus the poll delay), where the live loop's first poll cycles too.
  const start = Date.parse('2026-04-27T14:36:02Z');
  const live = await replay(MNQ, { lanes: TWO_LANES, bars1: BARS1, extraEnv, end, start, analyst: toolAnalyst, agents: AGENT_TFS });
  const passes = await replay(MNQ, { lanes: TWO_LANES, bars1: BARS1, extraEnv, end, start, analyst: toolAnalyst, agents: AGENT_TFS, fresh: true });
  assert.ok(live.cycles.length >= 20, `cycles: ${live.cycles.length}`);
  assert.strictEqual(framesText(passes), framesText(live));
  assert.deepStrictEqual(passes.cycles.map(c => c.prompt), live.cycles.map(c => c.prompt));
});
