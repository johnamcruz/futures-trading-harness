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
const { validateConfig } = require('../../scripts/lib/autotrader');
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

async function replay(bars, { end = END, state = null, lanes = null, timeframe = 3, bars1 = null, inspect = null, extraEnv = {}, restart = false } = {}) {
  const home = tmpDir();
  // The prompt names the harness home from the process's environment (autotrader.js prompts): this run's home.
  const savedHome = process.env.FTH_HOME;
  process.env.FTH_HOME = home;
  const real = fs.realpathSync(home);
  const paths = text => text.split(real).join('<home>').split(home).join('<home>').split(G.ROOT).join('<root>');
  const clockRef = { t: START };
  const now = () => new Date(clockRef.t);
  const env = {
    HOME: home, FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_JOURNAL: path.join(home, 'journal.jsonl'),
    FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'), FTH_ACCOUNTS_DIRS: path.join(home, 'no-accounts'), ...extraEnv,
  };
  // `lanes`: the same runner configured as one lane instead of the legacy timeframe (lanes.js).
  const { timeframe: _tf, ...noTimeframe } = { harness: 'opencode', cycle: 'full', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], dataDir: path.join(home, 'bars'), bars: 700 };
  const cfg = validateConfig(lanes ? { ...noTimeframe, lanes } : { ...noTimeframe, timeframe });
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
    const served = ctx.cachedRoles || [];
    const b = readBriefing(home, 'MNQ');
    const versions = b ? ['m3', 'm15', 'h1', 'day'].map(p => b.sections[p].version).join(', ') : 'none';
    // The roles not served from the cache run: two analysts build on the briefing; the third reads the bars itself (never cacheable).
    const output = [
      ...ANALYSTS.filter(r => !served.includes(r)).map((r, k) => task(r, k === 2 || r === ANALYSTS[2] ? 'Data: get_bars, market_snapshot\nBias: neutral' : `Data: bar_briefing ${versions}\nBias: long`, [10, 20 + k])),
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
  try {
    while (clockRef.t < end) {
      const before = cycles.length;
      clockRef.t += await (restart ? make() : runner).step();
      if (cycles.length > before) {
        const c = RC.readCache(home);
        keysAfter.push(c ? { analysts: Object.fromEntries(Object.entries(c.analysts).map(([r, x]) => [r, x.versions])), phase1: c.phase1 && { account: c.phase1.account, day: c.phase1.day }, symbols: c.symbols } : null);
        written.push(JSON.parse(fs.readFileSync(path.join(cfg.dataDir, `MNQ-${cfg.timeframe}m.json`), 'utf8')).bars);
      }
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
