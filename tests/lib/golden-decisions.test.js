'use strict';

// Golden regression: trade decisions. On fixed multi-day bars as a broker serves them (two symbols on 3m and one
// on 1m, with the broker's nested flow fields and a neutral field), every rules strategy the runner scans on that
// (no rules strategy ships since 2026-10-14: the fixtures in tests/fixtures/strategies-golden hold the retired ones'
// rules unchanged under fx_ names, so their decisions stay pinned)
// timeframe (runner-wiring.js runnerScan decides which) has its decision on every bar pinned: the bars where it
// fires (side, candidate or not, stop, regime, session, the rules that held, the filters that failed) in full, and
// a digest of its whole result on every bar. At fixed bars the text the model reads is pinned too: the runner's
// compact scan, the market snapshot, and the bar briefing. Without the broker's fields, every strategy that reads
// none decides the same, and no condition on a field holds for the ones that read them (fx_ofi, fx_ofi_absorption,
// fx_value_area's flow branch, the fixture ext_reader).
// Goldens: tests/fixtures/golden/ (tests/golden.js says how to update them on purpose).

const test = require('node:test');
const assert = require('node:assert');
const { assertGolden } = require('../golden');
const G = require('../fixtures/golden-bars');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { runnerScan } = require('../../scripts/lib/runner-wiring');
const { fieldPaths } = require('../../scripts/lib/backtest/bar-fields');
const { scanSummary } = require('../../scripts/lib/harness-tools/compact');
const { sideValuesText } = require('../../scripts/lib/trading/rules');
const { snapshot } = require('../../scripts/lib/trading/market-snapshot');
const { buildBriefing, renderBriefing } = require('../../scripts/lib/trading/briefing');
const { defaultRoundSteps } = require('../../scripts/lib/trading/round-numbers');
const { specFor } = require('../../scripts/lib/trading/contracts');

const { FX_STRATEGIES, FX_GOLDEN } = require('../helpers');
// The shipped strategies (prop_portfolio, with no components) and the retired rules strategies as fixtures.
const SHIPPED = loadStrategies(G.ROOT, { FTH_STRATEGIES_DIRS: FX_GOLDEN }).strategies;
// With the fixtures fx_break and fx_cross (tests/fixtures/strategies-fx): setups with confluence.
const WITH_FX = loadStrategies(G.ROOT, { FTH_STRATEGIES_DIRS: [FX_GOLDEN, FX_STRATEGIES].join(',') }).strategies;
const ALL = loadStrategies(G.ROOT, { FTH_STRATEGIES_DIRS: [FX_GOLDEN, G.EXT_STRATEGIES].join(',') }).strategies;
const FIRST = 100; // the first bar decided
// The goldens, by series, named in full (tests/plugin/golden.test.js maps every golden file to a name here).
// The field values (decisions-values.txt) are pinned apart from the decisions they never change.
const GOLDEN = {
  'MNQ 3m': { decisions: 'decisions-MNQ-3m.txt', views: 'views-MNQ-3m.txt' },
  'M2K 3m': { decisions: 'decisions-M2K-3m.txt', views: 'views-M2K-3m.txt' },
  'MNQ 1m': { decisions: 'decisions-MNQ-1m.txt', views: 'views-MNQ-1m.txt' },
};
const SERIES = G.SERIES.map(s => { const plain = G.load(s); return { ...s, plain, broker: G.broker(plain) }; });
const cfgOf = s => ({ timeframe: s.minutes, symbols: [s.symbol] });

/** The rules strategies the runner scans on this series (its own filter: runner-wiring.js runnerScan). */
function scanned(strategies, s) {
  const names = new Set(runnerScan(strategies, cfgOf(s), s.symbol, s.plain.slice(0, FIRST + 1), new Date(s.plain[FIRST].ms + s.minutes * 60000)).map(r => r.name));
  return strategies.filter(x => names.has(x.name) && x.valid && x.signal === 'rules');
}
const readsFields = s => fieldPaths(s).length > 0;
const held = (r, side) => ((r.rules && r.rules[side]) || []).filter(x => x.ok).map(x => x.rule);

function firedLine(t, r) {
  return [
    t, r.name, r.direction, r.candidate ? 'CANDIDATE' : '-',
    `stop=${r.stopDistance}`, ...(r.targetDistance !== undefined ? [`target=${r.targetDistance}`] : []),
    `regime=${r.regime}`, `session=${r.inSession ? 'in' : 'out'}`,
    `rules[${held(r, r.direction).join(' & ')}]`, `fails[${(r.filtersFailed || []).join('; ')}]`,
  ].join(' ');
}

/** Every strategy's result on every bar from FIRST: { name: [result per bar] }. */
function decide(bars, strategies) {
  const ev = createEvaluator(bars);
  const out = {};
  for (const s of strategies) {
    out[s.name] = [];
    for (let i = FIRST; i < bars.length; i += 1) out[s.name].push(ev.at(s, i, { describe: true }));
  }
  return out;
}

const cache = new Map();
function decided(s, which) {
  const key = `${s.label}|${which}`;
  if (!cache.has(key)) cache.set(key, decide(s[which], scanned(ALL, s)));
  return cache.get(key);
}

// A decision's digest leaves out the field values its rules read (text for the model, pinned on their own below),
// so a change to the values alone never reads as a changed decision.
const withoutValues = x => JSON.parse(JSON.stringify(x, (k, v) => (k === 'values' ? undefined : v)));

function decisionText(s, results) {
  const lines = [`${s.label}: ${s.broker.length} bars as the broker serves them, decided from bar ${FIRST} (${s.broker[FIRST].t}) to ${s.broker.at(-1).t}`];
  for (const [name, list] of Object.entries(results)) {
    lines.push(`${name}: fired ${list.filter(r => r.direction).length}, candidates ${list.filter(r => r.candidate).length}, every result sha256:${G.digest(withoutValues(list))}`);
  }
  lines.push('Fired (bar open, strategy, side, candidate, stop, target, regime, session, rules held, filters failed):');
  for (let k = 0; k < s.broker.length - FIRST; k += 1) {
    for (const list of Object.values(results)) if (list[k].direction) lines.push(firedLine(s.broker[FIRST + k].t, list[k]));
  }
  return lines.join('\n');
}

for (const s of SERIES) {
  test(`${s.label}: every strategy the runner scans on it has its decision on every bar pinned`, () => {
    const names = Object.keys(decided(s, 'broker'));
    assert.ok(names.length > 0 && scanned(ALL, s).every(x => x.timeframe === `${s.minutes}m`), `${s.label}: only ${s.minutes}m strategies`);
    assertGolden(GOLDEN[s.label].decisions, decisionText(s, decided(s, 'broker')));
  });

  test(`${s.label}: without the broker's fields a strategy that reads none decides the same, and no field condition holds`, () => {
    const plain = decided(s, 'plain');
    const broker = decided(s, 'broker');
    for (const st of scanned(ALL, s)) {
      if (!readsFields(st)) assert.deepStrictEqual(broker[st.name], plain[st.name], `${s.label} ${st.name}: the same on every bar`);
      // No field, no condition on one holds (a composite such as fx_value_area's any(flow | price) may hold on its price branch).
      else assert.ok(plain[st.name].every(r => !held(r, r.direction || 'long').some(x => x.startsWith('field(')) && !held(r, 'short').some(x => x.startsWith('field('))), `${s.label} ${st.name}: a field condition held without the field`);
    }
  });
}

/** The field values each strategy that reads fields saw: a digest of every bar's, and the fired side's in full where it fired. */
function valuesText(s, results, strategies) {
  const lines = [`${s.label}: the field values of the strategies that read fields, from bar ${FIRST}`];
  const readers = strategies.filter(readsFields).map(x => x.name);
  for (const name of readers) {
    const per = results[name].map(r => ['long', 'short'].map(side => ((r.rules && r.rules[side]) || []).map(x => x.values ?? null)));
    lines.push(`${name}: every bar's values sha256:${G.digest(per)}`);
  }
  for (let k = 0; k < s.broker.length - FIRST; k += 1) {
    for (const name of readers) {
      const r = results[name][k];
      if (r.direction) lines.push(`${s.broker[FIRST + k].t} ${name} ${r.direction} ${sideValuesText(r.rules[r.direction], Infinity) || '(none)'}`);
    }
  }
  return lines.join('\n');
}

test('the field values the strategies that read fields saw, on every series, are pinned apart from the decisions', () => {
  assertGolden('decisions-values.txt', SERIES.map(s => valuesText(s, decided(s, 'broker'), scanned(ALL, s))).join('\n'));
});

test('without describe (a backtest) no field values are computed; with it, the same decision plus the values', () => {
  const s = SERIES.find(x => x.label === 'MNQ 1m');
  const readers = scanned(ALL, s).filter(readsFields);
  assert.ok(readers.length > 0);
  const ev = createEvaluator(s.broker);
  let shown = 0;
  for (const st of readers) {
    for (let i = FIRST; i < s.broker.length; i += 97) {
      const lean = ev.at(st, i, { describe: false });
      const full = ev.at(st, i, { describe: true });
      assert.ok(!JSON.stringify(lean.rules).includes('"values"'), `${st.name} @${i}: values computed without describe`);
      assert.deepStrictEqual(withoutValues(full.rules), lean.rules, `${st.name} @${i}`);
      assert.strictEqual(full.direction, lean.direction);
      if (JSON.stringify(full.rules).includes('"values"')) shown += 1;
    }
  }
  assert.ok(shown > 0, 'describe computes them');
});

test('the broker\'s fields fire every strategy that reads them: fx_ofi and fx_ofi_absorption (1m, deep paths), fx_value_area\'s flow branch, ext_reader (a look-back and a flag)', () => {
  const fired = (label, name, which = 'broker') => decided(SERIES.find(x => x.label === label), which)[name].filter(r => r.direction).length;
  assert.ok(fired('MNQ 1m', 'fx_ofi') > 0, 'fx_ofi');
  assert.ok(fired('MNQ 1m', 'fx_ofi_absorption') > 0, 'fx_ofi_absorption');
  // fx_value_area's setup holds without flow (its price branch) or with it: the broker's flow adds bars.
  const va = ['MNQ 3m', 'M2K 3m'].reduce((n, l) => n + fired(l, 'fx_value_area') - fired(l, 'fx_value_area', 'plain'), 0);
  assert.ok(va > 0, 'fx_value_area fires on its flow branch');
  for (const label of ['MNQ 3m', 'M2K 3m']) {
    const s = SERIES.find(x => x.label === label);
    const list = decided(s, 'broker').ext_reader;
    assert.ok(list.filter(r => r.direction).length > 5, `${label} ext_reader fires`);
    list.forEach((r, k) => {
      const i = FIRST + k;
      const [a, prev, flag] = [G.extOf(i).a, G.extOf(i - 1).a, G.extOf(i).b.flag];
      const up = s.plain[i].c > s.plain[i - 1].c;
      const down = s.plain[i].c < s.plain[i - 1].c;
      const want = a >= 0.5 && prev < 0.5 && flag && up ? 'long' : a <= -0.5 && prev > -0.5 && !flag && down ? 'short' : null;
      assert.strictEqual(r.direction, want, `${label} ${s.plain[i].t}: ext.a ${a} (bar before ${prev}), flag ${flag}`);
    });
  }
});

// Bars (by index in the series) where the scan, snapshot and briefing text is pinned: candidates of several
// strategies, session-bound ones (fx_orb, a value area, crt), a quiet bar; on 1m, flow setups.
const VIEWS = { 'MNQ 3m': [589, 1244, 1299, 1400], 'M2K 3m': [671, 791, 1195, 1200], 'MNQ 1m': [] };
const specOf = root => specFor(root);

/** What the model reads on bar i: the runner's scan (compact), the market snapshot, the bar briefing. */
function viewAt(s, bars, i, strategies = SHIPPED) {
  const upTo = bars.slice(0, i + 1);
  const t = upTo.at(-1).t;
  const closedAt = new Date(Date.parse(t) + s.minutes * 60000);
  const results = runnerScan(strategies, cfgOf(s), s.symbol, upTo, closedAt);
  const b = buildBriefing({ symbol: s.symbol, contractId: s.symbol, bars: upTo, minutes: s.minutes, scan: results, blackouts: { items: [] }, roundSteps: defaultRoundSteps(), now: closedAt });
  return [
    `=== ${s.label} bar ${i} (opened ${t}) ===`,
    '--- strategies_scan (the runner\'s, compact) ---',
    scanSummary(results, { symbol: s.symbol, bar: t, specOf }).trimEnd(),
    '--- market_snapshot ---',
    JSON.stringify(snapshot({ bars: upTo })),
    '--- bar_briefing ---',
    renderBriefing(b, { now: closedAt }).trimEnd(),
  ].join('\n');
}

/** On 1m: the first bars where fx_ofi and fx_ofi_absorption fire, and where neither does. */
function minuteViews(s) {
  const d = decided(s, 'broker');
  const at = name => FIRST + d[name].findIndex(r => r.candidate || r.direction);
  return [at('fx_ofi'), at('fx_ofi_absorption'), 3000];
}

for (const s of SERIES) {
  test(`${s.label}: the runner's compact scan, the market snapshot and the bar briefing the model reads are pinned; the neutral field changes none of it`, () => {
    const idx = s.label === 'MNQ 1m' ? minuteViews(s) : VIEWS[s.label];
    const text = idx.map(i => viewAt(s, s.broker, i)).join('\n');
    assert.strictEqual(idx.map(i => viewAt(s, G.withFlow(s.plain), i)).join('\n'), text, 'the same without the field no strategy reads');
    assertGolden(GOLDEN[s.label].views, text);
  });
}

// Confluence as the model reads it (a candidate's "with:" list, the briefing's "confluence: with ..."): no shipped
// pair fires together at a pinned bar since the 2026-10-13 retirement, so the fixtures stand in. MNQ 3m bar 589:
// fx_break and fx_cross long together; bar 1244: fx_break and fx_orb short together.
test('MNQ 3m with the fx fixtures: the compact scan, snapshot and briefing of setups with confluence are pinned', () => {
  const s = SERIES.find(x => x.label === 'MNQ 3m');
  const text = [589, 1244].map(i => viewAt(s, s.broker, i, WITH_FX)).join('\n');
  assert.match(text, /fx_break long \| .*\| with: fx_cross; against: none/);
  assert.match(text, /fx_orb short \| .*\| with: fx_break; against: none/);
  assert.match(text, /confluence: with fx_cross/);
  assertGolden('views-confluence.txt', text);
});
