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

async function replay(bars, { end = END, state = null, lanes = null, timeframe = 3 } = {}) {
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
    FTH_BLACKOUTS_FILE: path.join(home, 'blackouts.json'), FTH_ACCOUNTS_DIRS: path.join(home, 'no-accounts'),
  };
  // `lanes`: the same runner configured as one lane instead of the legacy timeframe (lanes.js).
  const { timeframe: _tf, ...noTimeframe } = { harness: 'opencode', cycle: 'full', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ'], dataDir: path.join(home, 'bars'), bars: 700 };
  const cfg = validateConfig(lanes ? { ...noTimeframe, lanes } : { ...noTimeframe, timeframe });
  const broker = {
    async activeContract(symbol) { return { id: symbol, name: `${symbol}M6`, tickSize: 0.25, tickValue: 0.5 }; },
    // The replay server's bars up to its clock (the pass drops any that close later: closedBarsOnly).
    async closedBars(contractId, { limit }) { return JSON.parse(JSON.stringify(bars.filter(b => Date.parse(b.t) < clockRef.t).slice(-limit))); },
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
    cycles.push({ at: now().toISOString(), action, prompt: paths(prompt), served, fired: (ctx.symbols || []).flatMap(s => s.fired.map(f => `${f.name} ${f.direction}`)), before: cache });
    clockRef.t += 20000;
    return { ok: true, timedOut: false, result: 'CYCLE RESULT: no-trade - golden replay', transcript: output };
  };
  const runner = wireRunner({
    cfg, root: G.ROOT, home, env, client: closedBarsOnly(broker, now), dataDir: cfg.dataDir, now, runCycle,
    loadState: () => state, saveState: () => {}, killSwitchFile: path.join(home, 'STOP'), log: () => {}, event: () => {},
  });
  const keysAfter = [];
  let guard = 0;
  try {
    while (clockRef.t < end) {
      const before = cycles.length;
      clockRef.t += await runner.step();
      if (cycles.length > before) {
        const c = RC.readCache(home);
        keysAfter.push(c ? { analysts: Object.fromEntries(Object.entries(c.analysts).map(([r, x]) => [r, x.versions])), phase1: c.phase1 && { account: c.phase1.account, day: c.phase1.day }, symbols: c.symbols } : null);
        written.push(JSON.parse(fs.readFileSync(path.join(cfg.dataDir, `MNQ-${cfg.timeframe}m.json`), 'utf8')).bars);
      }
      if ((guard += 1) > 10000) throw new Error('runaway loop');
    }
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
