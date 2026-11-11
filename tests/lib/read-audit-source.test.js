'use strict';

// The read audit over every decision (read-audit.js `coded`, read-audit-source.js): a decision with no STATE line is sorted
// by the coded read (trading/coded-read.js) and labelled so, and the report keeps the model's read and the coded one
// apart, with the adherence rate, the entry classes A-D and the trend signals, each net R with and without its best trade.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const A = require('../../scripts/lib/learning/read-audit');
const R = require('../../scripts/lib/learning/read-audit-source');
const { parseStateLine, scoreState, stateFacts } = require('../../scripts/lib/trading/state-read');

const ROOT = path.resolve(__dirname, '..', '..');
const TF = 3 * 60 * 1000;
const T0 = Date.parse('2021-06-11T13:00:00.000Z');
const T = i => new Date(T0 + i * TF).toISOString();
const CYCLE = 30;
const CFG = { forwardBars: 5, stopAtr: 1 };
const bars = () => Array.from({ length: 60 }, (_, i) => { const c = i > CYCLE ? 100 + 0.5 * (i - CYCLE) : 100; return { t: T(i), o: c, h: c + 1, l: c - 1, c }; });
const briefing = (h4, h1, m15, extra = {}) => ({ asOf: T(CYCLE), sections: {
  h1: { data: { h4: { trend: h4 }, h1: { trend: h1 } } }, m15: { data: { frame: { trend: m15 } } },
  m3: { data: { today: { soFar: { status: 'read', read: 'directional' } }, ...extra } },
} });
function rec(line, b) {
  const p = parseStateLine(line);
  return { status: p.status, line: p.line, read: p.read, missing: p.missing, bad: p.bad, symbol: 'MNQ', bar: T(CYCLE), ...scoreState(p.read, b), facts: stateFacts(b) };
}
const decision = (action, r) => ({ key: `${T(CYCLE + 1)}|MNQ`, t: T(CYCLE + 1), symbol: 'MNQ', barT: T(CYCLE), inTrade: false, actual: { action }, trade: r === undefined ? null : { r } });
const audit = over => A.auditDecision({ day: '2021-06-11', t: T(CYCLE + 1), symbol: 'MNQ', bars: bars(), cfg: CFG, ...over });
const UP = briefing('up', 'up', 'up', { regime: { primary: 'trend-up' } });
const noLine = rec('no line here', UP);

test('without coded: a cycle with no STATE line stays unscorable, as before (the default changes nothing)', () => {
  const r = audit({ stateRead: noLine, decision: decision('long', 1.5) });
  assert.strictEqual(r.class, null);
  assert.strictEqual(r.unscorable, 'no STATE line (status none)');
  assert.ok(!('source' in r));
});

test('coded: a cycle with no STATE line is sorted from the briefing\'s labels and labelled coded; the model\'s own line stays model', () => {
  const coded = audit({ stateRead: noLine, decision: decision('long', 1.5), coded: true });
  assert.deepStrictEqual([coded.class, coded.source, coded.modelStatus], ['acted-right', 'coded', 'none']);
  const lost = audit({ stateRead: noLine, decision: decision('long', -1.2), coded: true });
  assert.deepStrictEqual([lost.class, lost.source], ['market-turned', 'coded']);
  // A coded read is the labels, so never a misread; a pass is `passed`.
  assert.strictEqual(audit({ stateRead: noLine, decision: decision('none'), coded: true }).class, 'passed');
  // The model's line, when written, is used, and says so (here it misreads the 15m).
  const own = audit({ stateRead: rec('STATE: 4h up | 1h up | 15m down | frames disagree', UP), decision: decision('long', 1), coded: true });
  assert.deepStrictEqual([own.class, own.source, own.modelStatus], ['misread', 'model', 'read']);
  // The coded read carries its signals (the entry class by the entry's side).
  assert.deepStrictEqual([coded.coded.cls, coded.coded.trend], ['C', ['S1', 'S2', 'S3']]);
  // No facts (no briefing at the cycle): nothing to restate, unscorable, never a made-up read.
  const bare = audit({ stateRead: { status: 'none', line: null, read: null, symbol: 'MNQ', bar: T(CYCLE), fields: {}, facts: null }, decision: decision('long', 1), coded: true });
  assert.deepStrictEqual([bare.class, bare.source], [null, null]);
  assert.match(bare.unscorable, /no STATE line/);
  // A managed cycle is no decision either way; it keeps its source for the adherence count.
  const managed = audit({ stateRead: noLine, decision: { ...decision('none'), inTrade: true }, coded: true });
  assert.deepStrictEqual([managed.kind, managed.class, managed.source], ['in-trade', null, 'coded']);
});

test('coded: its facts\' bar must still be the cycle\'s base bar (the same refusal as a model line)', () => {
  const r = audit({ stateRead: { ...noLine, bar: T(CYCLE) }, decision: decision('long', 1), coded: true, barClose: T(CYCLE + 1), tfMs: TF });
  assert.strictEqual(r.class, 'acted-right', 'the bar one timeframe before the close: the base bar');
  const other = audit({ stateRead: { ...noLine, bar: T(CYCLE - 5) }, decision: decision('long', 1), coded: true, barClose: T(CYCLE + 1), tfMs: TF });
  assert.match(other.unscorable, /not the cycle's base bar/);
});

const row = (kind, cls, source, R, over = {}) => ({ day: '2021-06-11', kind, class: cls, source, modelStatus: source === 'model' ? 'read' : 'none', outcome: { R, side: null }, coded: { cls: 'C', day: 'trend', trend: ['S2'], chop: [] }, ...over });

test('source report: adherence, each class per source, net R with and without the best trade', () => {
  const rows = [
    row('entry', 'acted-right', 'model', 3), row('entry', 'market-turned', 'model', -1),
    row('entry', 'acted-right', 'coded', 2), row('entry', 'market-turned', 'coded', -1), row('entry', 'market-turned', 'coded', -1.5),
    row('pass', 'passed', 'coded', 0.4), row('pass', null, null, null, { coded: null, unscorable: 'no state record' }),
    { ...row('in-trade', null, 'coded', null), outcome: null },
  ];
  const s = R.sourceReport(rows);
  assert.deepStrictEqual(s.adherence, { decisions: 8, model: 2, coded: 5, none: 1, rate: 0.25 });
  assert.deepStrictEqual(s.bySource.model.classes, { 'acted-right': 1, 'market-turned': 1 });
  assert.deepStrictEqual(s.bySource.coded.classes, { 'acted-right': 1, 'market-turned': 2, passed: 1 });
  // Entries: net, mean, and the net without the single best trade.
  assert.deepStrictEqual(s.bySource.coded.entries, { n: 3, knownR: 3, netR: -0.5, meanR: -0.1667, best: 2, withoutBestR: -2.5 });
  assert.deepStrictEqual(s.bySource.model.entries, { n: 2, knownR: 2, netR: 2, meanR: 1, best: 3, withoutBestR: -1 });
  assert.deepStrictEqual(s.all.entries, { n: 5, knownR: 5, netR: 1.5, meanR: 0.3, best: 3, withoutBestR: -1.5 });
  // The four outcomes the owner reads (the audit's classes grouped; passes and the rest apart).
  assert.deepStrictEqual(s.fourOutcomes, { misread: 0, 'acted-wrong': 0, 'market-turned': 3, 'acted-right': 2, passed: 1, other: 0 });
});

test('source report: no known R is null, never 0; one entry has nothing left without its best', () => {
  const s = R.sourceReport([row('entry', null, 'coded', null)]);
  assert.deepStrictEqual(s.all.entries, { n: 1, knownR: 0, netR: null, meanR: null, best: null, withoutBestR: null });
  const one = R.sourceReport([row('entry', 'acted-right', 'model', 2)]);
  assert.deepStrictEqual([one.all.entries.netR, one.all.entries.withoutBestR], [2, 0]);
  assert.deepStrictEqual(R.sourceReport([]).adherence, { decisions: 0, model: 0, coded: 0, none: 0, rate: null });
});

test('source report: entries by the coded entry class A-D and by each trend signal, with and without the best', () => {
  const at = (cls, trend, chop, R) => row('entry', R > 0 ? 'acted-right' : 'market-turned', 'coded', R, { coded: { cls, trend, chop, day: 'trend' } });
  const s = R.sourceReport([at('C', ['S2'], [], 2), at('C', ['S2', 'S3'], [], -1), at('B', [], ['C2', 'C3'], -1), at('A', [], [], 1), at('D', ['S3'], ['C2'], -1)]);
  assert.deepStrictEqual(Object.keys(s.byEntryClass), ['A', 'B', 'C', 'D']);
  assert.deepStrictEqual(s.byEntryClass.C, { n: 2, knownR: 2, netR: 1, meanR: 0.5, best: 2, withoutBestR: -1 });
  assert.strictEqual(s.byEntryClass.B.netR, -1);
  assert.strictEqual(s.byEntryClass.A.n, 1);
  // A trend signal's entries: each entry counts under every signal it had.
  assert.deepStrictEqual(Object.keys(s.byTrendSignal), ['S1', 'S2', 'S3', 'S7']);
  assert.deepStrictEqual([s.byTrendSignal.S2.n, s.byTrendSignal.S2.netR, s.byTrendSignal.S3.n, s.byTrendSignal.S3.netR], [2, 1, 2, -2]);
  assert.strictEqual(s.byTrendSignal.S1.n, 0);
  // Passes and unscored rows are in no entry class.
  assert.strictEqual(R.sourceReport([row('pass', 'passed', 'coded', 0.4)]).byEntryClass.C.n, 0);
});

test('source report: the coded day class over every decision', () => {
  const day = d => row('pass', 'passed', 'coded', 0.1, { coded: { cls: null, day: d, trend: [], chop: [] } });
  const s = R.sourceReport([day('trend'), day('trend'), day('chop'), day('mixed'), row('pass', null, null, null, { coded: null })]);
  assert.deepStrictEqual(s.dayClass, { trend: 2, chop: 1, mixed: 1, unknown: 1 });
});

test('render: names the source of every figure and says what the coded read is', () => {
  const s = R.sourceReport([row('entry', 'acted-right', 'model', 3), row('entry', 'market-turned', 'coded', -1)]);
  const text = R.renderSourceReport(s);
  assert.match(text, /STATE line on 1 of 2 decisions \(50%\)/);
  assert.match(text, /model:/);
  assert.match(text, /coded:/);
  assert.match(text, /without the best trade/);
  assert.match(text, /entry class A/);
  assert.match(text, /never a misread/);
});

/** A synthetic run: a pass with the model's line, a pass and an entry with none (the cycle's briefing facts recorded). */
function runHome() {
  const runId = 'arm-pc-t20210611.abc.0';
  const home = path.join(tmpDir(), runId);
  const dir = path.join(home, 'replay', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, 'bars'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ v: 1, runId }));
  fs.writeFileSync(path.join(dir, 'autotrader.json'), JSON.stringify({ timeframe: 3, symbols: ['MNQ'] }));
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify({ contractId: 'MNQ', bars: bars() }));
  const at = ms => T(CYCLE + 1).replace('.000Z', `.${ms}Z`);
  const line = (t, result, sr, orders = []) => JSON.stringify({ v: 1, t, day: '2021-06-11', kind: 'trade', ran: [{ action: 'trade', symbols: ['MNQ'], result }], cycles: [{ action: 'trade', result, orders, stateRead: sr }] });
  fs.writeFileSync(path.join(dir, '2021-06-11.jsonl'), `${[
    line(at('000'), 'CYCLE RESULT: no-trade - x', rec('STATE: 4h up | 1h up | 15m up | frames agree', UP)),
    line(at('100'), 'CYCLE RESULT: no-trade - y', noLine),
    line(at('500'), 'CYCLE RESULT: executed - long', noLine, [{ side: 'buy', gate: 'allowed' }]),
  ].join('\n')}\n`);
  const decisions = path.join(home, 'decisions');
  fs.mkdirSync(decisions);
  fs.writeFileSync(path.join(decisions, 'pc-t20210611.abc.-decisions.json'), JSON.stringify([
    { key: `${at('500')}|MNQ`, t: at('500'), symbol: 'MNQ', inTrade: false, actual: { action: 'long' }, trade: { r: 2.4 }, run: runId },
  ]));
  return { home, decisions };
}

test('run rows and the CLI: --coded sorts the unlined cycles and prints the source report; without it the old report, unchanged', () => {
  const { home, decisions } = runHome();
  const D = A.loadDecisions([decisions]);
  const plain = A.runRows(home, { decisions: D, cfg: CFG }).rows;
  assert.deepStrictEqual(plain.map(r => r.class), ['passed', null, null], 'without coded: the unlined cycles stay unscorable');
  const coded = A.runRows(home, { decisions: D, cfg: CFG, coded: true }).rows;
  assert.deepStrictEqual(coded.map(r => [r.class, r.source]), [['passed', 'model'], ['passed', 'coded'], ['acted-right', 'coded']]);
  const cli = args => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'read-audit.js'), ...args], { encoding: 'utf8' });
  const j = cli(['--run', home, '--decisions', decisions, '--coded', '--json']);
  assert.strictEqual(j.status, 0, j.stderr);
  const out = JSON.parse(j.stdout);
  assert.deepStrictEqual(out.source.adherence, { decisions: 3, model: 1, coded: 2, none: 0, rate: 0.3333 });
  assert.strictEqual(out.source.bySource.coded.entries.netR, 2.4);
  assert.strictEqual(out.source.byEntryClass.C.n, 1);
  const text = cli(['--run', home, '--decisions', decisions, '--coded']);
  assert.match(text.stdout, /STATE line on 1 of 3 decisions/);
  assert.match(text.stdout, /OUTCOME/, 'the audit report is still printed first');
  // Without --coded: no source section.
  assert.ok(!('source' in JSON.parse(cli(['--run', home, '--decisions', decisions, '--json']).stdout)));
  assert.match(cli(['--run', home, '--bogus']).stderr, /unknown argument --bogus/);
});
