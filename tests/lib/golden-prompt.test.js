'use strict';

// Golden regression: the prompts the runner gives the model. Each cycle prompt (trade, in every mode, for
// each harness; premarket; end of day) is rendered for one fixed state - real scan results on fixture bars,
// an account with a position and a prop attempt, history, lessons, cached reports, a policy verdict, the
// sections that could not be built - and pinned whole, so any change to what the model is told (a new line,
// a reworded instruction, a value shown or dropped) is a deliberate golden diff. The scans are the runner's
// (runner-wiring.js runnerScan). A broker field no strategy reads never reaches the prompt.
// Goldens: tests/fixtures/golden/ (tests/golden.js says how to update them on purpose).

const test = require('node:test');
const assert = require('node:assert');
const { assertGolden } = require('../golden');
const G = require('../fixtures/golden-bars');
const { prompts, validateConfig, RESULT_TEMPLATE, CYCLE_OUTCOMES, outcomeOf } = require('../../scripts/lib/autotrader');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { runnerScan } = require('../../scripts/lib/runner-wiring');

const SHIPPED = loadStrategies(G.ROOT, {}).strategies;
const MNQ = G.load(G.SERIES[0]);
const M2K = G.load(G.SERIES[1]);
const I = 1244; // MNQ bar 1244 (2026-04-27 10:30 ET): bos, keltner and orb fire
const NOW = new Date(Date.parse(MNQ[I].t) + 3 * 60000 + 5000);

/** The fixed state a trade cycle's prompt is built from (as runner.js passes it). */
function state({ ext = false } = {}) {
  const mnq = ext ? G.withExt(MNQ) : MNQ;
  const m2k = ext ? G.withExt(M2K) : M2K;
  const scanMnq = runnerScan(SHIPPED, { timeframe: 3, symbols: ['MNQ', 'M2K'] }, 'MNQ', mnq.slice(0, I + 1), new Date(Date.parse(MNQ[I].t) + 180000))
    .map(r => (r.candidate && r.direction ? { ...r, record: 'backtest 52% win, E +0.21R (n 140); live 3W/2L' } : r));
  const scanM2k = runnerScan(SHIPPED, { timeframe: 3, symbols: ['MNQ', 'M2K'] }, 'M2K', m2k.slice(0, 1300), new Date(Date.parse(M2K[1299].t) + 180000));
  const items = [
    {
      symbol: 'MNQ', scan: scanMnq, verdicts: [], notEntries: [],
      bar: {
        t: mnq[I].t, c: mnq[I].c, file: '/bars/MNQ-3m.json', contractId: 'MNQ', recent: mnq.slice(I - 9, I + 1),
        trend: '4h range, 1h up, 15m up: longs with the trend, shorts need mtf: reversal.',
        day: 'Today: open 27412.5, gap +18.25 above the prior close; opening range 27398.25-27431.75; IB not complete',
        plan: 'Premarket plan: long above 27431.75 on volume, short below 27398.25; avoid 10:00 ET data',
      },
    },
    {
      symbol: 'M2K', scan: scanM2k, notEntries: [],
      verdicts: [{ strategy: 'prop_portfolio', component: 'bos', direction: 'long', action: 'full', contract: 'M2K', contractId: 'M2K', maxSize: 4, stopTicks: 36 }],
      bar: { t: m2k[1299].t, c: m2k[1299].c, file: '/bars/M2K-3m.json', contractId: 'M2K', recent: m2k.slice(1290, 1300), trend: null, day: null },
    },
  ];
  const account = {
    id: '7', at: NOW.toISOString(), balance: 50412.5,
    positions: [{ contractId: 'MNQ', type: 1, size: 2, averagePrice: 27420.25 }], workingOrders: 2,
    orders: [{ id: 9, contractId: 'MNQ', type: 4, side: 1, size: 2, stopPrice: 27410.25 }, { id: 10, contractId: 'MNQ', type: 1, side: 1, size: 2, limitPrice: 27440.25 }],
    openTrades: ['MNQ long 2 from 27420.25 (setup:orb, 14:21 ET), stop 27410.25 (1R = 10 pts), target 27440.25 (2R); now +0.4R, best +0.9R, worst -0.2R, 3 bars.'],
    attempts: [{ account: 'mini', status: 'active', asOf: NOW.toISOString(), balance: 50412.5, floor: 48412.5, cushion: 2000, profit: 412.5, target: 3000, dayPnl: 112.5, sessionsLeft: 26, sessionsDone: 4, budgets: [{ strategy: 'prop_portfolio', budgetUsd: 400 }], entryBlock: null }],
  };
  return { items, account };
}

/** A history entry for the cycle on MNQ bar k (its close 5 s after the bar closed). */
const decided = (k, result, facts) => ({
  at: new Date(Date.parse(MNQ[k].t) + 3 * 60000 + 5000).toISOString(), symbols: ['MNQ'], result,
  symbol: 'MNQ', tf: 3, bar: MNQ[k].t, price: MNQ[k].c, tick: 0.25, ...facts,
});

const OPTIONS = ({ account }) => ({
  state: account,
  // The decisions on MNQ's last bars (decision-history.js entries; the first in the old format, from before the
  // decision facts): what happened since is read from the item's closed bars.
  history: [
    { at: '2026-04-27T14:15:05Z', symbols: ['MNQ'], result: 'CYCLE RESULT: no-trade - nothing fired' },
    decided(I - 4, 'CYCLE RESULT: no-trade - against the 15m trend', { action: 'skipped', setup: 'keltner', side: 'short', stop: 6 }),
    decided(I - 3, 'CYCLE RESULT: executed - orb long 2 MNQ at 27420.25', { action: 'entered', setup: 'orb', side: 'long', stop: 10 }),
    decided(I - 2, 'CYCLE RESULT: managed - stop held', { action: 'managed' }),
    decided(I - 1, 'CYCLE RESULT: managed - stop held', { action: 'managed' }),
  ],
  lessons: ['skip keltner in a range (0.7)', 'wait for the 15m close at a level (0.6)'],
  trades: ['orb long +1.2R', 'bos short -1R', 'keltner long +2R'],
  tradesSummary: '2W/1L, E +0.73R',
  news: 'News: none in force; next CPI 2026-04-28 08:30 ET (blackout 08:25-08:45 ET).',
  unavailable: ['the M2K day context (the bars don\'t hold today\'s open or a whole prior day)'],
  cyclesLeft: 3,
  manageAlso: [],
  cached: {
    roles: ['market-structure-analyst', 'risk-manager'],
    reports: [
      { role: 'market-structure-analyst', text: 'Data: bar_briefing m3@2026-04-27T14:33:00.000Z, m15@2026-04-27T14:30:00.000Z, h1@2026-04-27T14:00:00.000Z, day@2026-04-26T20:03:00.000Z\nBias: long (high)', at: '2026-04-27T14:30:05Z', until: '2026-04-27T14:45:00.000Z' },
      { role: 'risk-manager', text: 'Phase 1: Attempt: mini active, cushion $2,000; budget $400', at: '2026-04-27T14:27:05Z', until: null },
    ],
  },
  unreviewed: 'Unreviewed: none.',
});

const CFG = over => validateConfig({ harness: 'opencode', premarketAt: '', timeframe: 3, account: '7', symbols: ['MNQ', 'M2K'], ...over });

/** Every prompt for the fixed state, labelled. */
function render(ext = false) {
  const st = state({ ext });
  const opts = OPTIONS(st);
  const p = cfg => prompts(cfg, NOW, '');
  const out = [
    ['trade: opencode, full cycle, two symbols, cached reports', p(CFG()).trade(st.items, opts)],
    ['trade: claude, lean cycle', p(CFG({ harness: 'claude', cycle: 'lean' })).trade(st.items, opts)],
    ['trade: qwen, full, no cache', p(CFG({ harness: 'qwen' })).trade(st.items, { ...opts, cached: null })],
    ['trade: codex, manage-only', p(CFG({ harness: 'codex' })).trade(st.items, { ...opts, manageOnly: true })],
    ['trade: paper mode, recovered', p(CFG({ paper: true })).trade(st.items, { ...opts, recovered: true })],
    ['trade: no account configured, no journal read', p(CFG({ account: '' })).trade([st.items[0]], { ...opts, state: null, journalRead: false, trades: [], lessons: [] })],
    ['trade: the account unreadable', p(CFG()).trade([st.items[0]], { ...opts, state: { id: '7', error: 'HTTP 502' } })],
    ['trade: a failed scan', p(CFG()).trade([{ ...st.items[0], scan: null }], { ...opts, unavailable: ['MNQ strategy scan (need at least 3 bars, got 2): what fired is unknown'] })],
    ['premarket', p(CFG()).premarket('MNQ', { state: st.account })],
    ['eod', p(CFG()).eod({ state: st.account })],
    ['eod catch-up', p(CFG()).eod({ state: st.account, day: '2026-04-24' })],
  ];
  // One sentence per line, continuation lines indented (". " -> ".\n  "), so a changed word shows as its sentence.
  return out.map(([label, text]) => `=== ${label} ===\n${text.split('. ').join('.\n  ')}`).join('\n');
}

test('every cycle prompt for a fixed state is pinned, and a broker\'s bar fields never reach it', () => {
  const text = render(false);
  assert.strictEqual(render(true), text, 'the same prompts with the broker\'s fields on the bars');
  assertGolden('prompts.txt', text);
});

test('the outcome-word template every prompt ends with, and how a result line\'s outcome is read, are pinned', () => {
  const text = render(false);
  const sections = text.split('\n=== ').length;
  // Every prompt (trade, premarket, end of day) ends with the template, whole.
  assert.strictEqual(text.split(`Your last line must be exactly: ${RESULT_TEMPLATE}.`).length - 1, sections);
  const lines = [
    'CYCLE RESULT: no-trade - nothing fired', 'CYCLE RESULT: *managed* - stop held', 'CYCLE RESULT: Blocked: the gate refused', 'CYCLE RESULT: error - a tool failed',
    'CYCLE RESULT: no-trades - x', 'CYCLE RESULT: done - x', 'CYCLE RESULT: (none reported)', 'no result line',
  ];
  assertGolden('prompt-outcomes.txt', [
    `template: ${RESULT_TEMPLATE}`,
    `outcomes: ${CYCLE_OUTCOMES.join(', ')}`,
    ...lines.map(l => `${JSON.stringify(l)} -> ${outcomeOf(l)}`),
  ].join('\n'));
});
