'use strict';

// The label dataset (scripts/lib/rl/label-dataset.js), on synthetic run dirs and labels: no real data.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, recordBrokerSpecs } = require('../helpers');
const ds = require('../../scripts/lib/rl/label-dataset');
const live = require('../../scripts/lib/rl/live');
const { buildObservation, marketFeatures, confluence, observationFields, observationVersion, OBSERVATION_SOURCES } = require('../../scripts/lib/rl/observation');
const combine = require('../../scripts/lib/trading/combine');
const { accountNamed } = require('../../scripts/lib/trading/accounts');
const { specFor } = require('../../scripts/lib/trading/contracts');

const ROOT = path.resolve(__dirname, '..', '..');
const ACCOUNT = accountNamed(ROOT, 'topstep_50k', {});
const STRATEGY = {
  name: 'pp', valid: true, signal: 'policy', status: 'paper', timeframe: '3m', strategies: ['orb', 'ema_cross', 'bos'], account: 'topstep_50k',
  sizing: { cushion_frac: 0.3, cap_usd: 1000 }, contracts: 'auto', params: {}, exit: { trail_activate_r: 2, trail_giveback_r: 0.5 },
};
const DAY1 = '2026-03-02';
const DAY2 = '2026-03-03';
const B0 = Date.parse(`${DAY1}T13:00:00Z`);
const TF = 180000;
const iso = ms => new Date(ms).toISOString();
const T_FLAT = Date.parse(`${DAY2}T14:30:02Z`); // the 14:27 bar closed at 14:30
const T_TRADE = Date.parse(`${DAY2}T15:00:02Z`);
const WINDOW = 510; // the bars from B0 through the 14:27 bar of DAY2: the whole history at T_FLAT
const HASH = 'c'.repeat(64);
const q = x => Math.round(x * 4) / 4;

/** 3-minute MNQ bars from B0: a deterministic wave, on ticks. */
function makeBars(n = 620, bump = null) {
  const out = [];
  let prev = 20000;
  for (let k = 0; k < n; k += 1) {
    const c = q(20000 + 30 * Math.sin(k / 7) + 10 * Math.sin(k / 3.1) + k * 0.05);
    const o = prev;
    const b = { t: iso(B0 + k * TF), o, h: q(Math.max(o, c) + 2 + (k % 5)), l: q(Math.min(o, c) - 2 - (k % 3)), c, v: 100 + k };
    out.push(bump ? bump(b, k) : b);
    prev = c;
  }
  return out;
}

const SCAN_RESULTS = [
  { name: 'ema_cross', candidate: true, direction: 'long', stopDistance: 12.3 },
  { name: 'orb', candidate: true, direction: 'short', stopDistance: 8 },
  { name: 'bos', candidate: false, stopDistance: 9 },
  { name: 'other', candidate: true, direction: 'long', stopDistance: 5 },
];
const OPEN_TRADE = { contractId: 'MNQ', side: 'long', sign: 1, size: 2, entry: 20010, openedAt: `${DAY2}T14:36:10.000Z`, setup: 'ema_cross', initialStop: 20000, risk: 10 };

function label(over = {}) {
  const t = over.t || iso(T_FLAT);
  return {
    v: 1, key: over.key || `k-${t}-${over.decision || 'flat'}`, runId: 'r1', t, day: DAY2, kind: 'trade', symbol: 'MNQ', barT: iso(Date.parse(t) - 2000 - TF),
    decision: 'flat', candidates: [{ name: 'orb', direction: 'short' }], teacher: { action: 'none', setup: null, stop: null, size: null },
    gate: { decision: 'none' }, outcome: null, counterfactual: { result: 'loss', R: -1, net: -20, strategy: 'orb' }, counterfactualFor: 'skip',
    clone: { ok: true, reasons: [] }, provenance: { configHash: HASH, cycleFile: 'logs/cycles/2026-10-10/000001-trade.json' }, ...over,
  };
}

/** A run home with its run dir, labels and the records the dataset reads. */
function makeRun({ runId = 'r1', labels: list = [label()], barList = makeBars(), trades = null, bars = WINDOW, base = tmpDir(), scanResults = SCAN_RESULTS } = {}) {
  const home = path.join(base, 'replays', runId);
  const runDir = path.join(home, 'replay', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'logs', 'cycles', '2026-10-10'), { recursive: true });
  fs.mkdirSync(path.join(home, 'bars'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ v: 1, runId, hash: HASH, broker: 'backtester', daysDone: [DAY1, DAY2], finished: true }));
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ symbols: ['MNQ'], timeframe: 3, bars }));
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify({ contractId: 'MNQ', bars: barList }));
  // A round trip on DAY1: +$100 gross, $1.48 fees (net 98.52); a fill after T_FLAT on DAY2 when given.
  const fills = trades || [
    { id: 1, contractId: 'MNQ', creationTimestamp: `${DAY1}T15:00:00Z`, price: 20000, profitAndLoss: null, fees: 0.74, side: 0, size: 2 },
    { id: 2, contractId: 'MNQ', creationTimestamp: `${DAY1}T15:30:00Z`, price: 20025, profitAndLoss: 100, fees: 0.74, side: 1, size: 2 },
  ];
  const line = (t, day, tr) => ({ v: 1, t, day, kind: 'trade', ran: [], cycles: [], bars: [{ symbol: 'MNQ' }], trades: tr });
  fs.writeFileSync(path.join(runDir, `${DAY1}.jsonl`), `${JSON.stringify(line(`${DAY1}T15:30:02Z`, DAY1, fills.filter(f => f.creationTimestamp < `${DAY1}T23:00`)))}\n`);
  fs.writeFileSync(path.join(runDir, `${DAY2}.jsonl`), `${JSON.stringify(line(iso(T_FLAT), DAY2, fills.filter(f => f.creationTimestamp >= `${DAY1}T23:00`)))}\n`);
  fs.writeFileSync(path.join(home, 'logs', `scans-${DAY2}.jsonl`), [
    { at: iso(T_FLAT), symbol: 'MNQ', contractId: 'MNQ', bar: { t: iso(T_FLAT - 2000 - TF), c: 0 }, results: scanResults },
    // A scan logged after its decision time: never read for it.
    { at: iso(T_FLAT + 60000), symbol: 'MNQ', contractId: 'MNQ', bar: { t: iso(T_FLAT - 2000 - TF), c: 0 }, results: [{ name: 'ema_cross', candidate: true, direction: 'long', stopDistance: 3 }] },
  ].map(s => `${JSON.stringify(s)}\n`).join(''));
  fs.writeFileSync(path.join(home, 'logs', 'cycles', '2026-10-10', '000001-trade.json'), JSON.stringify({ context: { openTrades: [] } }));
  fs.writeFileSync(path.join(home, 'logs', 'cycles', '2026-10-10', '000002-trade.json'), JSON.stringify({ context: { openTrades: [OPEN_TRADE] } }));
  fs.writeFileSync(path.join(runDir, 'labels.jsonl'), list.map(l => `${JSON.stringify({ ...l, runId })}\n`).join(''));
  return { home, runDir };
}

const build = (inputs, opts = {}) => ds.buildDataset(inputs, { strategy: STRATEGY, account: ACCOUNT, ...opts });
const closedBy = (bars, t) => bars.filter(b => Date.parse(b.t) + TF <= t);
const tradeLabel = over => label({ t: iso(T_TRADE), decision: 'in-trade', key: 'k-trade', teacher: { action: 'hold' }, provenance: { configHash: HASH, cycleFile: 'logs/cycles/2026-10-10/000002-trade.json' }, counterfactual: null, counterfactualFor: null, outcome: { result: 'win', net: 30, r: 1.5 }, ...over });

/** The attempt as the env and live would hold it at DAY2: DAY1 closed on the round trip's net. */
function expectedCs() {
  let cs = combine.start(ACCOUNT);
  cs = combine.applyClose(cs, 98.52);
  return combine.endDay(cs);
}

test('a flat row: the observation live builds at the policy setup, equal to the engine\'s over the whole series (no lookahead in the features)', () => {
  const barList = makeBars();
  const { runDir } = makeRun({ barList });
  const { rows, header } = build([{ runDir }]);
  assert.strictEqual(rows.length, 1);
  const row = rows[0];
  assert.strictEqual(row.kind, 'flat');
  assert.strictEqual(row.action, 0, 'the teacher stood aside: none');
  assert.strictEqual(row.teacher.pick, 'orb', 'the first of the policy strategies that fired with a stop (live-runner screen order), never the teacher\'s choice');
  assert.strictEqual(row.obs.length, header.obsDim);
  // As live: setupObservation on the runner's window with the attempt's state.
  const cs = expectedCs();
  const window = closedBy(barList, T_FLAT).slice(-WINDOW);
  const s = live.setupObservation({ account: ACCOUNT, cs, strategy: STRATEGY, component: 'orb', symbol: 'MNQ', rawBars: window, spec: specFor('MNQ'), scan: SCAN_RESULTS[1], results: SCAN_RESULTS });
  assert.deepStrictEqual(row.obs, s.obs);
  // As the engine: market features over the whole series (bars after t included), read at the bar's index.
  const i = window.length - 1;
  const book = { bars: barList, tickSize: 0.25, tickValue: 0.5, feats: marketFeatures(barList, STRATEGY.params) };
  const engineObs = buildObservation({
    cs, account: ACCOUNT, book, i, closeAt: new Date(Date.parse(barList[i].t) + TF), components: STRATEGY.strategies,
    setup: { sign: -1, stopTicks: 32, size: s.cp.size, riskUsd: s.cp.size * s.cp.riskPerContract, mini: s.cp.root === 'NQ', strategy: 'orb', confluence: confluence(SCAN_RESULTS.filter(r => STRATEGY.strategies.includes(r.name)), 'orb', -1) },
  });
  assert.deepStrictEqual(row.obs, engineObs, 'bit for bit');
  // The state it read: DAY1's net in the balance, one session done.
  const f = observationFields(STRATEGY.strategies);
  assert.strictEqual(row.obs[f.indexOf('progress')], (50098.52 - 50000) / 3000);
  assert.strictEqual(row.obs[f.indexOf('sessions_left')], 29 / 30);
  assert.strictEqual(row.obs[f.indexOf('side')], -1);
  assert.strictEqual(row.obs[f.indexOf('strategy:orb')], 1);
  assert.strictEqual(row.obs[f.indexOf('confluence_against')], 1 / 3, 'ema_cross fired the other side; "other" is not the policy\'s');
});

test('no lookahead: bars, fills, scans and outcomes after t never change a row\'s observation', () => {
  const base = build([{ runDir: makeRun().runDir }]).rows[0];
  const after = b => (Date.parse(b.t) + TF > T_FLAT ? { ...b, o: b.o + 500, h: b.h + 900, l: b.l + 100, c: b.c + 700 } : b);
  const late = [
    { id: 1, contractId: 'MNQ', creationTimestamp: `${DAY1}T15:00:00Z`, price: 20000, profitAndLoss: null, fees: 0.74, side: 0, size: 2 },
    { id: 2, contractId: 'MNQ', creationTimestamp: `${DAY1}T15:30:00Z`, price: 20025, profitAndLoss: 100, fees: 0.74, side: 1, size: 2 },
    // A round trip that closed after t (its fills in the same day file): not in the attempt's balance at t.
    { id: 3, contractId: 'MNQ', creationTimestamp: iso(T_FLAT + 1000), price: 20000, profitAndLoss: null, fees: 0.74, side: 0, size: 1 },
    { id: 4, contractId: 'MNQ', creationTimestamp: iso(T_FLAT + 600000), price: 19000, profitAndLoss: -2000, fees: 0.74, side: 1, size: 1 },
  ];
  const outcome = label({ outcome: { result: 'win', net: 999, r: 9 }, counterfactual: { result: 'win', R: 5, net: 500 } });
  for (const [what, run] of [['bars after t', makeRun({ barList: makeBars(620, after) })], ['fills after t', makeRun({ trades: late })], ['outcome fields', makeRun({ labels: [outcome] })]]) {
    const row = build([{ runDir: run.runDir }]).rows[0];
    assert.deepStrictEqual(row.obs, base.obs, what);
    if (what === 'outcome fields') assert.notDeepStrictEqual(row.targets, base.targets, 'the outcome is a target');
  }
  // A bar at or before t does change it (the test can see a change).
  const before = makeRun({ barList: makeBars(620, (b, k) => (k === WINDOW - 1 ? { ...b, c: b.c + 40, h: b.h + 40 } : b)) });
  assert.notDeepStrictEqual(build([{ runDir: before.runDir }]).rows[0].obs, base.obs);
  // The attempt's closed P&L at or before t does too.
  const lost = makeRun({ trades: late.map(f => (f.id === 2 ? { ...f, profitAndLoss: -900 } : f)) });
  assert.notDeepStrictEqual(build([{ runDir: lost.runDir }]).rows[0].obs, base.obs);
});

test('the setup observed is the live screen\'s pick, never the teacher\'s choice; none fired with a stop: the flat observation', () => {
  const f = observationFields(STRATEGY.strategies);
  // The teacher took ema_cross long: the row still observes orb (the policy's first with a stop), short.
  const took = label({ teacher: { action: 'long', setup: 'ema_cross', stop: { multiple: 1 }, size: { step: 1 } }, gate: { decision: 'allowed' } });
  const a = build([{ runDir: makeRun({ labels: [took] }).runDir }]).rows[0];
  assert.strictEqual(a.teacher.pick, 'orb');
  assert.strictEqual(a.obs[f.indexOf('side')], -1);
  assert.strictEqual(a.obs[f.indexOf('strategy:ema_cross')], 0);
  assert.strictEqual(a.action, ds.studentEntryId('long', 1, 1));
  // orb fired without a stop distance: the pick is ema_cross (as live-runner screens).
  const noStop = SCAN_RESULTS.map(r => (r.name === 'orb' ? { ...r, stopDistance: undefined } : r));
  const b = build([{ runDir: makeRun({ scanResults: noStop }).runDir }]).rows[0];
  assert.strictEqual(b.teacher.pick, 'ema_cross');
  assert.strictEqual(b.obs[f.indexOf('side')], 1);
  // Nothing of the policy's fired: no setup in the observation (side 0, no strategy), still a row in student mode.
  const c = build([{ runDir: makeRun({ scanResults: [{ name: 'other', candidate: true, direction: 'long', stopDistance: 5 }] }).runDir }]);
  assert.strictEqual(c.rows[0].teacher.pick, null);
  assert.strictEqual(c.rows[0].obs[f.indexOf('side')], 0);
  assert.strictEqual(c.rows[0].obs[f.indexOf('risk_of_cushion')], 0);
  assert.deepStrictEqual(build([{ runDir: makeRun({ scanResults: [] }).runDir }], { mode: 'env' }).summary.excluded, { 'no policy setup on the bar (env mode)': 1 });
});

test('what live would observe differently is excluded, never built: a screened scan, a policy\'s trade, a working-stop risk, an untrusted spec', () => {
  // A scan a running policy screened (live-runner screen: components rewritten, the policy's own row).
  const screened = SCAN_RESULTS.map(r => (r.name === 'orb' ? { ...r, candidate: false, note: 'traded through pp' } : r));
  assert.deepStrictEqual(build([{ runDir: makeRun({ scanResults: screened }).runDir }]).summary.excluded, { 'scan screened by a running policy (not read yet)': 1 });
  const policyRow = [...SCAN_RESULTS, { name: 'pp', signal: 'policy', candidate: false }];
  assert.deepStrictEqual(build([{ runDir: makeRun({ scanResults: policyRow }).runDir }], { mode: 'env' }).summary.excluded, { 'scan screened by a running policy (not read yet)': 1 });
  // In a trade: the risk from the working stop (open-trades.js note), no initial stop, or the policy's own trade.
  const tradeWith = over => {
    const run = makeRun({ labels: [tradeLabel()] });
    fs.writeFileSync(path.join(run.home, 'logs', 'cycles', '2026-10-10', '000002-trade.json'), JSON.stringify({ context: { openTrades: [{ ...OPEN_TRADE, ...over }] } }));
    return build([{ runDir: run.runDir }]).summary.excluded;
  };
  assert.deepStrictEqual(tradeWith({ notes: ['initial stop unknown: risk from the working stop'] }), { 'initial stop unknown (risk from the working stop)': 1 });
  assert.deepStrictEqual(tradeWith({ initialStop: null }), { 'initial stop unknown (risk from the working stop)': 1 });
  assert.deepStrictEqual(tradeWith({ setup: 'pp' }), { 'a running policy\'s trade (not read yet)': 1 });
  assert.deepStrictEqual(tradeWith({}), {});
  // A broker spec unlike the table for the family's mini: live skips the setup (no spec it trusts).
  const run = makeRun();
  recordBrokerSpecs(run.home, { broker: 'backtester', specs: { NQ: { tickValue: 4 } } });
  assert.deepStrictEqual(build([{ runDir: run.runDir }]).summary.excluded, { 'no usable tick spec for the symbol or its family (live skips it)': 1 });
  recordBrokerSpecs(run.home, { broker: 'backtester', specs: { NQ: { tickValue: 5 } } });
  assert.strictEqual(build([{ runDir: run.runDir }]).rows.length, 1, 'a broker spec equal to the table is used');
});

test('the flat observation with no setup reads the policy strategy\'s timeframe for the session clock, as live does', () => {
  const f = observationFields(STRATEGY.strategies);
  const at = strategy => build([{ runDir: makeRun({ scanResults: [] }).runDir }], { strategy }).rows[0].obs[f.indexOf('session_clock')];
  const three = at(STRATEGY);
  const five = at({ ...STRATEGY, timeframe: '5m' });
  // The 14:27 bar: closes 14:30 on 3m bars (09:30 ET, 930 minutes into the session), 14:32 if read as 5m.
  assert.strictEqual(three, 930 / 1320);
  assert.strictEqual(five, 932 / 1320);
});

test('outcomes and counterfactuals are targets, never inputs: the row carries them apart', () => {
  const l = label({ teacher: { action: 'short', setup: 'orb', stop: { multiple: 0.5 }, size: { step: 0.5 } }, gate: { decision: 'allowed' }, outcome: { result: 'win', net: 40, r: 2, maeR: -0.2, mfeR: 2.4 }, counterfactualFor: 'taken' });
  const row = build([{ runDir: makeRun({ labels: [l] }).runDir }]).rows[0];
  assert.deepStrictEqual(row.targets.outcome, { result: 'win', net: 40, r: 2, maeR: -0.2, mfeR: 2.4 });
  assert.deepStrictEqual(row.targets.counterfactual, { result: 'loss', R: -1, net: -20, strategy: 'orb' });
  assert.strictEqual(row.targets.counterfactualFor, 'taken');
  assert.strictEqual(row.targets.gate, 'allowed');
  assert.strictEqual(row.action, ds.studentEntryId('short', 0.5, 0.5));
  assert.strictEqual(row.weight, 1);
});

test('an in-trade row: the observation decidePosition asks with, from the trade the cycle showed and the bars since it opened', () => {
  const barList = makeBars();
  const { runDir } = makeRun({ barList, labels: [tradeLabel()] });
  const { rows } = build([{ runDir }]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'position');
  assert.strictEqual(rows[0].action, ds.FLAT_N, 'hold');
  const window = closedBy(barList, T_TRADE).slice(-WINDOW);
  // As the runner counts them: bars opened at or after the fill (less 30 s), peak and trough from 0.
  const since = window.filter(b => Date.parse(b.t) >= Date.parse(OPEN_TRADE.openedAt) - 30000);
  assert.strictEqual(since[0].t, `${DAY2}T14:36:00.000Z`, 'the bar the fill came 10 s into counts');
  const peakR = Math.max(0, ...since.map(b => (b.h - 20010) / 10));
  const troughR = Math.min(0, ...since.map(b => (b.l - 20010) / 10));
  const obs = live.positionObservation({
    account: ACCOUNT, cs: expectedCs(), strategy: STRATEGY, rawBars: window, spec: specFor('MNQ'),
    pos: { sign: 1, entry: 20010, risk: 10, size: 2, contract: 'MNQ', component: 'ema_cross', peakR, troughR, barsHeld: since.length },
  });
  assert.deepStrictEqual(rows[0].obs, obs);
  assert.deepStrictEqual(ds.tradeProgress(window, OPEN_TRADE), { peakR, troughR, barsHeld: since.length });
  // No open trade in the context (or no initial stop): excluded, counted.
  const none = build([{ runDir: makeRun({ labels: [tradeLabel({ provenance: { configHash: HASH, cycleFile: 'logs/cycles/2026-10-10/000001-trade.json' } })] }).runDir }]);
  assert.strictEqual(none.rows.length, 0);
  assert.match(Object.keys(none.summary.excluded)[0], /trade state unknown/);
});

test('action mapping: every teacher action in both modes, and what has no action is excluded with its reason', () => {
  const flat = teacher => label({ teacher });
  const inTrade = action => tradeLabel({ teacher: { action } });
  const entry = (action, multiple, step, setup = 'orb') => flat({ action, setup, stop: { multiple }, size: { step } });
  const pick = { name: 'orb', direction: 'short' };
  // student
  assert.deepStrictEqual(ds.mapAction(flat({ action: 'none' }), 'student'), { kind: 'flat', action: 0 });
  assert.deepStrictEqual(ds.mapAction(entry('long', 0.5, 0.25), 'student'), { kind: 'flat', action: 1 });
  assert.deepStrictEqual(ds.mapAction(entry('long', 3, 1), 'student'), { kind: 'flat', action: 24 });
  assert.deepStrictEqual(ds.mapAction(entry('short', 0.5, 0.25), 'student'), { kind: 'flat', action: 25 });
  assert.deepStrictEqual(ds.mapAction(entry('short', 1.5, 0.75), 'student'), { kind: 'flat', action: 1 + 24 + 3 * 4 + 2 });
  assert.deepStrictEqual(ds.mapAction(entry('short', 3, 1), 'student'), { kind: 'flat', action: 48 });
  assert.strictEqual(ds.STUDENT.actions[1 + 24 + 3 * 4 + 2], 'short:1.5atr:0.75');
  assert.deepStrictEqual(ds.mapAction(inTrade('hold'), 'student'), { kind: 'position', action: 49 });
  assert.deepStrictEqual(ds.mapAction(inTrade('tighten'), 'student'), { kind: 'position', action: 50 });
  assert.deepStrictEqual(ds.mapAction(inTrade('exit'), 'student'), { kind: 'position', action: 51 });
  assert.deepStrictEqual(ds.mapAction(entry('long', null, 0.5), 'student'), { excluded: 'stop not mapped to an ATR multiple' });
  assert.deepStrictEqual(ds.mapAction(entry('long', 4, 0.5), 'student'), { excluded: 'stop not mapped to an ATR multiple' });
  assert.deepStrictEqual(ds.mapAction(flat({ action: 'long', setup: 'orb', stop: null, size: null }), 'student'), { excluded: 'stop not mapped to an ATR multiple' });
  assert.deepStrictEqual(ds.mapAction(entry('long', 1, null), 'student'), { excluded: 'size step unknown (label the run with --budget)' });
  assert.match(ds.mapAction(flat({ action: null }), 'student').excluded, /unknown teacher action/);
  assert.match(ds.mapAction(inTrade('none'), 'student').excluded, /unknown teacher action/);
  // env
  assert.deepStrictEqual(ds.mapAction(flat({ action: 'none' }), 'env', { pick }), { kind: 'setup', action: 0 });
  // half and full: the policy's own plans at the setup, in micros; the teacher's size goes to the nearer (a tie to half).
  const sz = teacher => ({ teacher, half: 10, full: 20 });
  assert.deepStrictEqual(ds.mapAction(entry('short', 1, 0.25), 'env', { pick, sized: sz(1) }), { kind: 'setup', action: 1 });
  assert.deepStrictEqual(ds.mapAction(entry('short', 1, 1), 'env', { pick, sized: sz(15) }), { kind: 'setup', action: 1 }, 'a tie is half');
  assert.deepStrictEqual(ds.mapAction(entry('short', 1, 0.25), 'env', { pick, sized: sz(16) }), { kind: 'setup', action: 2 }, 'the step of the labeler\'s budget is not the plan');
  assert.deepStrictEqual(ds.mapAction(entry('short', 1, 1), 'env', { pick, sized: sz(40) }), { kind: 'setup', action: 2 });
  assert.deepStrictEqual(ds.mapAction(entry('short', null, null), 'env', { pick, sized: sz(20) }), { kind: 'setup', action: 2 }, 'env mode has no stop or step choice');
  assert.deepStrictEqual(ds.mapAction(entry('short', 1, 1), 'env', { pick, sized: { teacher: 3, half: 0, full: 20 } }), { kind: 'setup', action: 2 }, 'no half plan fits: full');
  assert.deepStrictEqual(ds.mapAction(entry('long', 1, 1), 'env', { pick, sized: sz(1) }), { excluded: 'entry not on the policy setup (env mode)' });
  assert.deepStrictEqual(ds.mapAction(entry('short', 1, 1, 'ema_cross'), 'env', { pick, sized: sz(1) }), { excluded: 'entry not on the policy setup (env mode)' });
  assert.deepStrictEqual(ds.mapAction(entry('short', 1, 1), 'env', { pick }), { excluded: 'entry size unknown against the policy plan (env mode)' });
  assert.deepStrictEqual(ds.mapAction(entry('short', 1, 1), 'env', { pick, sized: sz(null) }), { excluded: 'entry size unknown against the policy plan (env mode)' });
  assert.deepStrictEqual(ds.mapAction(flat({ action: 'none' }), 'env', { pick: null }), { excluded: 'no policy setup on the bar (env mode)' });
  assert.deepStrictEqual(ds.mapAction(inTrade('hold'), 'env', { pastRatchet: true }), { kind: 'position', action: 0 });
  assert.deepStrictEqual(ds.mapAction(inTrade('exit'), 'env', { pastRatchet: true }), { kind: 'position', action: 1 });
  assert.deepStrictEqual(ds.mapAction(inTrade('hold'), 'env', { pastRatchet: false }), { excluded: 'before the ratchet (env mode asks only past it)' });
  assert.deepStrictEqual(ds.mapAction(inTrade('tighten'), 'env', { pastRatchet: true }), { excluded: 'tighten (env mode has none)' });
  // The teacher's size in micros: the entry order its size came from (a mini counts its family's ratio).
  const rootOf = id => String(id).split(':')[0];
  const sized = (orders, contracts = 1, setup = 'orb') => ds.teacherMicros(label({ teacher: { action: 'short', setup, size: { contracts }, orders } }), rootOf);
  assert.strictEqual(sized([{ tool: 'place_order', side: 'sell', size: 1, setup: 'orb', contractId: 'NQ:2026-03' }]), 10);
  assert.strictEqual(sized([{ tool: 'place_order', side: 'sell', size: 3, setup: 'orb', contractId: 'MNQ' }], 3), 3);
  assert.strictEqual(sized([{ tool: 'place_order', side: 'buy', size: 1, setup: 'orb', contractId: 'NQ' }]), null, 'not the entry (other side)');
  assert.strictEqual(sized([{ tool: 'place_order', side: 'sell', size: 1, setup: 'orb', contractId: 'NQ', riskReducing: true }]), null, 'a protective order is no entry');
  assert.strictEqual(sized([]), null);
  assert.strictEqual(ds.microEq('ES', 2), 20);
  assert.strictEqual(ds.microEq('MES', 2), 2);
  // Every student id names its own action, and the masks split flat from in-trade.
  for (const side of ['long', 'short']) for (const m of [0.5, 0.75, 1, 1.5, 2, 3]) for (const z of [0.25, 0.5, 0.75, 1]) assert.strictEqual(ds.STUDENT.actions[ds.studentEntryId(side, m, z)], `${side}:${m}atr:${z}`);
  assert.strictEqual(new Set(ds.STUDENT.actions).size, 52);
  assert.deepStrictEqual(ds.STUDENT.masks.flat.map((v, k) => v + ds.STUDENT.masks.position[k]), Array(52).fill(1));
});

test('env mode rows: the setup the env asks about, a trade past the ratchet, and the rest excluded by reason', () => {
  const barList = makeBars();
  const skip = label();
  // The policy's own half and full plans at this setup (live: plan(0.5), plan(1)), as the env sizes them.
  const s = live.setupObservation({ account: ACCOUNT, cs: expectedCs(), strategy: STRATEGY, component: 'orb', symbol: 'MNQ', rawBars: closedBy(barList, T_FLAT).slice(-WINDOW), spec: specFor('MNQ'), scan: SCAN_RESULTS[1], results: SCAN_RESULTS });
  const h = s.plan(0.5);
  assert.ok(h && s.cp && h.size * (h.root === 'NQ' ? 10 : 1) < s.cp.size * (s.cp.root === 'NQ' ? 10 : 1), 'the fixture has a half plan under the full one');
  const entry = (key, root, size, step) => label({ key, teacher: { action: 'short', setup: 'orb', stop: { multiple: 1 }, size: { step, contracts: size }, orders: [{ tool: 'place_order', side: 'sell', size, setup: 'orb', contractId: root, riskReducing: false }] }, gate: { decision: 'allowed' } });
  // The labeler's step (of --budget) says 1 for the half plan and 0.25 for the full one: the plan decides.
  const half = entry('k2', h.root, h.size, 1);
  const full = entry('k3', s.cp.root, s.cp.size, 0.25);
  const r1 = build([{ runDir: makeRun({ barList, labels: [skip, half, full, tradeLabel()] }).runDir }], { mode: 'env' });
  assert.deepStrictEqual(r1.rows.map(r => [r.key, r.kind, r.action]), [['k-2026-03-03T14:30:02.000Z-flat', 'setup', 0], ['k2', 'setup', 1], ['k3', 'setup', 2]]);
  assert.strictEqual(r1.header.actionN, 3);
  assert.deepStrictEqual(r1.header.masks, { setup: [1, 1, 1], position: [1, 1, 0] });
  // The trade is at peakR under 2 (the ratchet): the env wouldn't ask.
  assert.strictEqual(r1.summary.excluded['before the ratchet (env mode asks only past it)'], 1);
  assert.deepStrictEqual(r1.summary.actionCounts, { 'setup:full': 1, 'setup:half': 1, 'setup:skip': 1 });
  assert.deepStrictEqual(r1.rows.map(r => r.teacher.onPick), [false, true, true]);
  // Past the ratchet (a bar since the fill reaches +2R): hold is the env's hold.
  const up = makeRun({ barList: makeBars(620, b => (b.t === `${DAY2}T14:45:00.000Z` ? { ...b, h: 20040 } : b)), labels: [tradeLabel()] });
  assert.deepStrictEqual(build([{ runDir: up.runDir }], { mode: 'env' }).rows.map(r => [r.kind, r.action]), [['position', 0]]);
});

test('exclusions are counted by reason and never become rows: not a decision, not cloneable, refused (unless asked), duplicates, short history', () => {
  const list = [
    label({ key: 'a', decision: 'no-cycle', teacher: null }),
    label({ key: 'b', decision: 'housekeeping', teacher: null }),
    label({ key: 'c', clone: { ok: false, reasons: ['limit entry'] } }),
    label({ key: 'd', teacher: { action: 'short', setup: 'orb', stop: { multiple: 1 }, size: { step: 1 } }, gate: { decision: 'refused' } }),
    label({ key: 'e' }),
    label({ key: 'f', decision: 'kill-switch', teacher: null }),
    label({ key: 'g', clone: { ok: true, reasons: [] }, teacher: null }),
  ];
  const { runDir } = makeRun({ labels: list });
  const r = build([{ runDir }]);
  assert.deepStrictEqual(r.rows.map(x => x.key), ['e']);
  assert.deepStrictEqual(r.summary.excluded, {
    'no teacher action': 1, 'not a teacher decision (housekeeping)': 1, 'not a teacher decision (kill-switch)': 1, 'not a teacher decision (no-cycle)': 1,
    'not cloneable (limit entry)': 1, 'refused intent': 1,
  });
  assert.strictEqual(r.summary.labels, list.length);
  const withRefused = build([{ runDir }], { includeRefused: true });
  assert.deepStrictEqual(withRefused.rows.map(x => x.key), ['d', 'e']);
  assert.strictEqual(withRefused.rows[0].targets.gate, 'refused');
  assert.strictEqual(withRefused.header.includeRefused, true);
  // The same run twice: its labels count once.
  const twice = build([{ runDir }, { runDir }]);
  assert.strictEqual(twice.rows.length, 1);
  assert.strictEqual(twice.summary.excluded['duplicate label'], list.length);
  // Fewer bars closed by t than the runner reads: not live's observation, excluded.
  const short = build([{ runDir: makeRun({ bars: WINDOW + 1 }).runDir }]);
  assert.strictEqual(short.rows.length, 0);
  assert.strictEqual(short.summary.excluded['short bar history (fewer bars closed by t than the runner reads)'], 1);
  // The runner's window is capped by what its bars file holds (a broker that returns fewer).
  assert.strictEqual(build([{ runDir: makeRun({ bars: 5000, barList: makeBars(WINDOW) }).runDir }]).rows.length, 1);
});

test('the attempt at t: the run\'s closed round trips through prop-state stateFrom; an attempt that is over has no rows', () => {
  const a = ds.attemptAt(ACCOUNT, [DAY1, DAY2], [{ ms: Date.parse(`${DAY1}T15:30:00Z`), day: DAY1, net: 98.52 }, { ms: T_FLAT + 1, day: DAY2, net: -50 }], T_FLAT, DAY2);
  assert.deepStrictEqual(a, { record: { days: [{ day: DAY1, balance: 50098.52, pnl: 98.52 }], peak: 50098.52 }, balance: 50098.52 });
  const cs = live.stateFrom(ACCOUNT, a.record, a.balance);
  const want = expectedCs();
  for (const k of ['balance', 'floor', 'eodHigh', 'dayPnl', 'days', 'peak', 'status']) assert.deepStrictEqual(cs[k], want[k], k);
  // A loss through the floor before t: blown, every later label excluded.
  const blown = [
    { id: 1, contractId: 'MNQ', creationTimestamp: `${DAY1}T15:00:00Z`, price: 20000, profitAndLoss: null, fees: 0, side: 0, size: 1 },
    { id: 2, contractId: 'MNQ', creationTimestamp: `${DAY1}T15:30:00Z`, price: 18000, profitAndLoss: -2100, fees: 0, side: 1, size: 1 },
  ];
  const r = build([{ runDir: makeRun({ trades: blown }).runDir }]);
  assert.strictEqual(r.rows.length, 0);
  assert.deepStrictEqual(r.summary.excluded, { 'attempt over (blown)': 1 });
  // Down past the soft daily limit today: no entries, so no flat row (the env wouldn't ask).
  const soft = [
    { id: 1, contractId: 'MNQ', creationTimestamp: `${DAY2}T14:00:00Z`, price: 20000, profitAndLoss: null, fees: 0, side: 0, size: 1 },
    { id: 2, contractId: 'MNQ', creationTimestamp: `${DAY2}T14:10:00Z`, price: 19000, profitAndLoss: -600, fees: 0, side: 1, size: 1 },
  ];
  assert.deepStrictEqual(build([{ runDir: makeRun({ trades: soft }).runDir }]).summary.excluded, { 'the attempt blocks entries': 1 });
});

test('several runs merge in time order; the same inputs give the same bytes', () => {
  const base = tmpDir();
  const r2 = makeRun({ runId: 'r2', base, labels: [label({ key: 'x', t: iso(T_FLAT) }), tradeLabel({ key: 'y' })] });
  const r1 = makeRun({ runId: 'r1', base, labels: [label({ key: 'z' })] });
  const a = build([{ runDir: r2.runDir }, { runDir: r1.runDir }]);
  assert.deepStrictEqual(a.rows.map(r => [r.runId, r.key]), [['r1', 'z'], ['r2', 'x'], ['r2', 'y']]);
  assert.deepStrictEqual(a.header.runs.map(r => r.runId), ['r1', 'r2']);
  const out = tmpDir();
  ds.writeDataset(path.join(out, 'a.jsonl'), a);
  ds.writeDataset(path.join(out, 'b.jsonl'), build([{ runDir: r2.runDir }, { runDir: r1.runDir }]));
  assert.strictEqual(fs.readFileSync(path.join(out, 'a.jsonl'), 'utf8'), fs.readFileSync(path.join(out, 'b.jsonl'), 'utf8'));
  const lines = fs.readFileSync(path.join(out, 'a.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines[0].header.format, ds.FORMAT);
  assert.strictEqual(lines[0].header.rows, 3);
  assert.strictEqual(lines[0].header.obsVersion, observationVersion(STRATEGY.strategies, STRATEGY.params));
  assert.deepStrictEqual(lines.slice(1).map(l => l.key), ['z', 'x', 'y']);
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'a.summary.json'), 'utf8'));
  assert.deepStrictEqual(summary.actionCounts, { 'flat:none': 2, 'position:hold': 1 });
  assert.match(ds.summaryText(summary), /3 rows \(student mode\) from 3 labels of 2 run\(s\)/);
});

test('refused: labels of another config or version, a non-policy strategy, the wrong account, a dataset inside the repository', () => {
  assert.throws(() => build([{ runDir: makeRun({ labels: [label({ provenance: { configHash: 'd'.repeat(64) } })] }).runDir }]), /labels of config d+, not run r1's/);
  assert.throws(() => build([{ runDir: makeRun({ labels: [label({ v: 2 })] }).runDir }]), /labels version 2/);
  const { runDir } = makeRun();
  assert.throws(() => build([{ runDir }], { strategy: { ...STRATEGY, signal: 'rules' } }), /a policy strategy/);
  assert.throws(() => build([{ runDir }], { account: accountNamed(ROOT, 'topstep_100k', {}) }), /the policy strategy's account/);
  assert.throws(() => build([{ runDir }], { mode: 'other' }), /mode: one of student, env/);
  assert.throws(() => build([]), /no labelled runs/);
  const inRepo = path.join(ROOT, '.tmp-label-dataset-test');
  try {
    assert.throws(() => ds.writeDataset(path.join(inRepo, 'd.jsonl'), build([{ runDir }]), { root: ROOT }), /inside the repository/);
    assert.ok(!fs.existsSync(inRepo), 'nothing written');
  } finally {
    fs.rmSync(inRepo, { recursive: true, force: true });
  }
  // Nor inside a run home it read (where a resumed teacher would find what came after its decisions).
  const home = path.resolve(runDir, '..', '..');
  assert.throws(() => ds.writeDataset(path.join(home, 'datasets', 'd.jsonl'), build([{ runDir }])), /inside the run home/);
  assert.ok(!fs.existsSync(path.join(home, 'datasets')));
});

test('the env server reports the observation version a dataset of its policy strategy carries', () => {
  const { serve } = require('../../scripts/lib/rl/env-server');
  const strategy = { ...STRATEGY, params: { vpRows: 40 } };
  const env = { prop: { strategy, components: strategy.strategies, contracts: 'auto' }, reward: {}, account: ACCOUNT, days: [] };
  const lines = [JSON.stringify({ cmd: 'info' })];
  const out = [];
  serve({ env, readLine: () => (lines.length ? lines.shift() : null), writeLine: s => out.push(JSON.parse(s)) });
  const { header } = build([{ runDir: makeRun().runDir }], { strategy });
  assert.strictEqual(out[0].obsVersion, header.obsVersion);
  assert.notStrictEqual(header.obsVersion, observationVersion(STRATEGY.strategies, STRATEGY.params), 'the profile settings are part of it');
});

test('the observation version follows the fields, the profile settings and the code', () => {
  const v = observationVersion(['a', 'b']);
  assert.match(v, /^[0-9a-f]{64}$/);
  assert.strictEqual(observationVersion(['a', 'b'], {}), v);
  assert.notStrictEqual(observationVersion(['a']), v);
  assert.notStrictEqual(observationVersion(['a', 'b'], { vpRows: 99 }), v);
  // The code that computes the observation is part of it: an edited formula with the same fields is another version.
  const { optionsFromParams } = require('../../scripts/lib/trading/volume-profile');
  const lib = path.join(ROOT, 'scripts', 'lib');
  const recipe = edit => require('crypto').createHash('sha256').update(JSON.stringify({ fields: observationFields(['a', 'b']), profile: optionsFromParams({}),
    code: OBSERVATION_SOURCES.map(f => [f, (edit || (x => x))(fs.readFileSync(path.join(lib, f), 'utf8'), f)]) })).digest('hex');
  assert.strictEqual(v, recipe());
  // Every module that feeds the observation's values is in it: an edit to any one is another version.
  for (const f of ['rl/observation.js', 'rl/live.js', 'rl/label-dataset.js', 'trading/indicators.js', 'trading/mtf.js', 'trading/volume-profile.js', 'trading/combine.js', 'trading/prop-state.js']) {
    assert.ok(OBSERVATION_SOURCES.includes(f), f);
    assert.notStrictEqual(recipe((text, g) => (g === f ? `${text}// edit\n` : text)), v, f);
  }
});

test('rl-dataset.js build: writes the dataset and its summary from a run dir or a labels dir with --run', () => {
  const base = tmpDir();
  const { runDir } = makeRun({ base, labels: [label()] });
  const labelsDir = path.join(base, 'labels-out');
  fs.mkdirSync(labelsDir);
  fs.copyFileSync(path.join(runDir, 'labels.jsonl'), path.join(labelsDir, 'labels.jsonl'));
  fs.writeFileSync(path.join(labelsDir, 'labels-summary.json'), JSON.stringify({ runId: 'r1' }));
  const out = path.join(base, 'ds', 'd.jsonl');
  const cli = args => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'rl-dataset.js'), ...args], { encoding: 'utf8', env: { ...process.env, FTH_STRATEGIES_DIRS: '' } });
  // prop_portfolio's account is topstep_100k; the run's attempt starts there.
  let r = cli(['build', runDir, '--out', out]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /rows \(student mode\) from 1 labels of 1 run/);
  assert.ok(fs.existsSync(out) && fs.existsSync(path.join(base, 'ds', 'd.summary.json')));
  r = cli(['build', labelsDir, '--out', out, '--mode', 'env']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /give its run dir with --run/);
  r = cli(['build', labelsDir, '--run', runDir, '--out', out, '--mode', 'env']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(env mode\)/);
  for (const [args, msg] of [[['build', runDir], /usage/], [['build', runDir, '--out'], /--out: a value/], [['build', runDir, '--out', out, '--mode', 'x'], /--mode: one of/], [['build', runDir, '--out', out, '--bogus'], /unknown option/], [['build', runDir, '--out', out, '--strategy', 'nope'], /no valid strategy/], [['build', runDir, '--out', out, '--bars', 'x'], /SYMBOL=file/], [['nope'], /usage/]]) {
    r = cli(args);
    assert.notStrictEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, msg);
  }
});
