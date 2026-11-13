'use strict';

// The recognition test over a run (scripts/lib/learning/recognition/run.js, report.js, and the CLI scripts/recognition.js):
// a run home's trade cycle logs on each case's day, the bars the run replayed (--bars SYMBOL=<file>), the frozen case list.
// A synthetic run home on the parity day, built here; the 1m data file is the parity bars' 1m series.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const R = require('../../scripts/lib/learning/recognition/run');
const P = require('../../scripts/lib/learning/recognition/report');
const RC = require('../../scripts/lib/learning/recognition/config');
const { MINUTE_BARS, ROOT } = require('../fixtures/decision-path');

const TF = 3 * 60000;
const DAY = '2026-04-23';
const OPEN = Date.parse('2026-04-23T13:30:00.000Z'); // 09:30 New York
const iso = ms => new Date(ms).toISOString();

/** The frozen-list shape: one trend leg and one chop day on the parity day; its sha256 alongside. */
function casesFile(dir) {
  const doc = { version: 'test', cases: [
    { day: DAY, kind: 'trend', side: 'long', start: iso(OPEN + 10 * TF), end: iso(OPEN + 17 * TF), legCandles: 8, pace: 'slow', margin: 5, selectedBy: 'test', circular: false, circularNote: 'bars only', availableR: 4.5 },
    { day: DAY, kind: 'chop', side: null, start: `${DAY}T09:30 America/New_York`, end: null, legCandles: null, pace: null, margin: 10, selectedBy: 'test', circular: true, circularNote: 'picked with a briefing word' },
    { day: '2026-04-29', kind: 'chop', side: null, start: null, end: null, legCandles: null, pace: null, margin: 10, selectedBy: 'test', circular: false, circularNote: 'x' },
  ] };
  const file = path.join(dir, 'cases.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  return { file, sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

/** A run home: the replay run's manifest and runner config, and one trade cycle log per candle 09:33 to 11:00. */
function runHome({ word = undefined, cites = undefined, frames = undefined } = {}) {
  const home = tmpDir();
  const dir = path.join(home, 'replay', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ v: 1, runId: 'r1' }));
  fs.writeFileSync(path.join(dir, 'autotrader.json'), JSON.stringify({ timeframe: 3, symbols: ['MNQ'], bars: 1400 }));
  const cyc = path.join(home, 'logs', 'cycles', DAY);
  fs.mkdirSync(cyc, { recursive: true });
  for (let i = 1; i <= 30; i += 1) {
    const close = OPEN + i * TF;
    const entry = i === 14;
    const inTrade = i > 14 && i < 18;
    const sr = { status: 'read', line: 'STATE: 4h up | 1h up | 15m up | class trend-up', bar: iso(close - TF) };
    if (word !== undefined) sr.classWord = typeof word === 'function' ? word(i) : word;
    if (frames !== undefined) sr.read = { frames, agree: null };
    if (cites !== undefined) Object.assign(sr, { cites, citesStated: 'names', citesDropped: 1 });
    const rec = {
      action: 'trade', result: entry ? 'CYCLE RESULT: entered long' : inTrade ? 'CYCLE RESULT: managed' : 'CYCLE RESULT: no-trade',
      summary: { orders: entry ? [{ gate: 'allowed', side: 'buy' }] : [] }, timing: { barClose: iso(close) }, stateRead: sr,
      context: { account: { positions: inTrade ? [{ side: 'long', size: 3 }] : [], workingOrders: [] }, attempts: [{ status: 'active' }] },
    };
    fs.writeFileSync(path.join(cyc, `${iso(close).slice(11, 19).replace(/:/g, '')}-trade.json`), JSON.stringify(rec));
  }
  // A manage cycle and a cycle with no bar close: not head trade cycles, never candles.
  fs.writeFileSync(path.join(cyc, '140000-manage.json'), JSON.stringify({ action: 'manage', timing: { barClose: iso(OPEN + TF) } }));
  fs.writeFileSync(path.join(cyc, '140100-trade.json'), JSON.stringify({ action: 'trade', result: 'x' }));
  return home;
}

let BARS_FILE;
function barsFile() {
  if (BARS_FILE) return BARS_FILE;
  BARS_FILE = path.join(tmpDir(), 'MNQ-1m.csv');
  fs.writeFileSync(BARS_FILE, `datetime,open,high,low,close,volume\n${MINUTE_BARS.map(b => `${b.t.replace('T', ' ').replace('.000Z', '+00:00')},${b.o},${b.h},${b.l},${b.c},${b.v}`).join('\n')}\n`);
  return BARS_FILE;
}
const report = (home, dir, o = {}) => {
  const c = casesFile(dir);
  return R.recognitionReport({ targets: [home], barsFiles: { MNQ: barsFile() }, tree: ROOT, ...RC.load({ casesFile: c.file, casesSha: c.sha }), ...o });
};

test('readOf: entry, pass and in-trade from the cycle (the read audit\'s kindOf, and an open position or working order); the class word and cites by equality', () => {
  const base = { action: 'trade', result: 'CYCLE RESULT: no-trade', summary: { orders: [] }, context: { account: { positions: [], workingOrders: [] } } };
  assert.deepStrictEqual(R.readOf(base), { kind: 'pass', side: null, word: { status: 'absent', word: null }, frames: null, basis: { status: 'absent', cited: [], offList: [], dropped: 0 } });
  assert.deepStrictEqual(R.readOf({ ...base, stateRead: { status: 'read', read: { frames: { '4h': 'range', '1h': 'up', '15m': 'range' } } } }).frames, { '4h': 'range', '1h': 'up', '15m': 'range' });
  assert.deepStrictEqual(R.readOf({ ...base, summary: { orders: [{ gate: 'allowed', side: 'sell' }] } }).kind, 'entry');
  assert.strictEqual(R.readOf({ ...base, summary: { orders: [{ gate: 'allowed', side: 'sell' }] } }).side, 'short');
  assert.strictEqual(R.readOf({ ...base, summary: { orders: [{ gate: 'refused', side: 'sell' }] } }).kind, 'pass', 'a refused order is no entry');
  assert.strictEqual(R.readOf({ ...base, result: 'CYCLE RESULT: managed' }).kind, 'in-trade');
  assert.strictEqual(R.readOf({ ...base, context: { account: { positions: [{ size: 1 }], workingOrders: [] } } }).kind, 'in-trade');
  assert.strictEqual(R.readOf({ ...base, context: { account: { positions: [], workingOrders: [{ id: 1 }] } } }).kind, 'in-trade', 'a working order: in the trade, not flat');
  assert.deepStrictEqual(R.readOf({ ...base, stateRead: { classWord: 'chop', cites: ['regime'] } }).word, { status: 'stated', word: 'chop' });
  assert.deepStrictEqual(R.readOf({ ...base, stateRead: { classWord: 'chop', cites: ['regime'], citesStated: 'names' } }).basis.cited, ['regime']);
});

test('kindOf and replayDirs are the read audit\'s rules (restated: nothing in scripts/ requires the read audit but its CLI)', () => {
  const RA = require('../../scripts/lib/learning/read-audit');
  const results = ['CYCLE RESULT: managed', 'CYCLE RESULT: **managed** the long', 'CYCLE RESULT: entered long', 'CYCLE RESULT: no-trade', 'nothing', null];
  const orders = [[], [{ gate: 'allowed', side: 'buy' }], [{ gate: 'allowed', side: 'sell' }], [{ gate: 'refused', side: 'buy' }], [{ side: 'buy' }], [{ gate: 'held', side: 'sell' }], [{ gate: 'allowed', side: 'flat' }], null];
  for (const result of results) for (const o of orders) assert.deepStrictEqual(R.kindOf({ orders: o, result }), RA.kindOf({ decision: null, orders: o, result }), `${result} ${JSON.stringify(o)}`);
  const home = runHome();
  const runs = tmpDir();
  fs.symlinkSync(home, path.join(runs, 'h1'));
  for (const t of [home, path.join(home, 'replay', 'r1'), runs, tmpDir()]) assert.deepStrictEqual(R.replayDirs(t), RA.replayDirs(t), t);
});

test('a measurement only: nothing in scripts/ requires the recognition test but itself and its CLI', () => {
  const out = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => (e.isDirectory() ? walk(path.join(d, e.name))
    : e.name.endsWith('.js') && /require\([^)]*recognition\//.test(fs.readFileSync(path.join(d, e.name), 'utf8')) && out.push(path.relative(ROOT, path.join(d, e.name)))));
  walk(path.join(ROOT, 'scripts'));
  assert.deepStrictEqual(out.filter(f => !f.startsWith('scripts/lib/learning/recognition/')), ['scripts/recognition.js']);
});

test('a run without the class word: entry vs confirmation and the confluence computed; the model\'s measures say they need the class word', () => {
  const dir = tmpDir();
  const doc = report(runHome(), dir);
  assert.strictEqual(doc.cases.length, 3);
  const [leg, chop, absentDay] = doc.cases;
  assert.strictEqual(leg.candles, 30, 'the 30 trade cycles with a bar close; the manage cycle and the one with no close are none');
  assert.strictEqual(leg.wordCoverage.needsClassWord, true);
  assert.strictEqual(leg.model, null);
  assert.strictEqual(leg.inTrade, 3);
  assert.strictEqual(leg.entryVsConfirmed.entry, 3, 'the entry at the 14th candle, rel 0 the 11th');
  assert.ok(['on', 'before', 'after', 'never-confirmed'].includes(leg.entryVsConfirmed.timing));
  assert.ok(leg.entryConfluence && Number.isInteger(leg.entryConfluence.reqMet));
  assert.strictEqual(chop.namesChop, null);
  assert.strictEqual(chop.entries.length, 1);
  assert.ok(chop.label && chop.label.recomputed, 'the bars-only label recomputed on the run\'s bars beside the frozen values');
  assert.strictEqual(absentDay.notInRuns, true);
  assert.deepStrictEqual(doc.summary.needsClassWord, [leg.id, chop.id]);
  assert.strictEqual(doc.summary.scored, null);
  assert.deepStrictEqual(doc.pass, [{ id: leg.id, availableR: 4.5 }]);
  const text = P.renderReport(doc);
  assert.match(text, /needs the class word in the run/);
  assert.match(text, /never substituted by the coded read or by prose/);
  assert.match(text, /CIRCULAR.*2026-04-23 chop/);
  assert.match(text, /PASS CHECK \(hindsight/);
  assert.ok(!/NaN|undefined/.test(text), text);
  assert.ok(text.indexOf('availableR') > text.indexOf('PASS CHECK'), 'R appears only in the pass check');
});

test('a run with the class word and cites: first recognition, evidence then with cites, the summary over the cases', () => {
  const dir = tmpDir();
  const doc = report(runHome({ word: i => (i < 12 ? 'unclear' : i === 20 ? null : 'trend-up'), cites: ['regime'] }), dir);
  const [leg, chop] = doc.cases;
  assert.strictEqual(leg.wordCoverage.needsClassWord, false);
  assert.strictEqual(leg.wordCoverage.unstated, 1);
  assert.strictEqual(leg.model.first, 1, 'the 12th candle, rel 1');
  assert.ok(['guess', 'on', 'lag'].includes(leg.model.timing));
  assert.strictEqual(leg.evidenceThen.model.basis.dropped, 1, 'the record\'s dropped names counted');
  assert.deepStrictEqual(leg.evidenceThen.model.basis.cited, ['regime']);
  assert.strictEqual(chop.namesChop, false, 'never said chop');
  assert.strictEqual(chop.entriesBeforeNaming, 1);
  assert.strictEqual(doc.summary.scored.trend.n, 1);
  assert.strictEqual(doc.summary.scored.chop.recall, 0);
  const text = P.renderReport(doc);
  assert.match(text, /first recognition \(model\): candle 1/);
  assert.match(text, /SUPPLEMENTARY \(definitions unchanged\): first naming from the evidence candle on/, 'the per-case supplementary columns, labelled');
  assert.match(text, /SUPPLEMENTARY trend \(definitions unchanged\): recalled from the evidence candle on \d\/1; false-alarm rate in the leg windows/);
  assert.match(text, /trend: n 1 \[[^\]]*\], recall [\d.]+ \[[\d.]+, [\d.]+\]/, 'recall with its Wilson interval');
  assert.match(text, /precision [\d.-]+( \[[\d.]+, [\d.]+\])?, false-alarm rate [\d.]+ \[[\d.]+, [\d.]+\]/);
  assert.ok(!/NaN|undefined/.test(text), text);
});

test('the CLI: a frozen list checked, --bars and --run read, text or JSON; bad arguments refused with the usage', () => {
  const dir = tmpDir();
  const c = casesFile(dir);
  const home = runHome();
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'recognition.js'), ...a], { encoding: 'utf8' });
  const ok = run('--run', home, '--bars', `MNQ=${barsFile()}`, '--cases', c.file, '--cases-sha', c.sha, '--tree', ROOT);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /needs the class word in the run/);
  assert.doesNotMatch(ok.stdout, /No 1m bars/, '1m data: the 1m lane is there');
  const threeMin = path.join(dir, 'MNQ-3m.csv');
  fs.copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'), threeMin);
  const no1m = run('--run', home, '--bars', `MNQ=${threeMin}`, '--cases', c.file, '--cases-sha', c.sha);
  assert.strictEqual(no1m.status, 0, no1m.stderr);
  assert.match(no1m.stdout, /No 1m bars \(the briefing's 5m facts missing[^\n]*2026-04-23 trend long/, 'never silent');
  const js = run('--run', home, '--bars', `MNQ=${barsFile()}`, '--cases', c.file, '--cases-sha', c.sha, '--json');
  assert.strictEqual(js.status, 0, js.stderr);
  assert.strictEqual(JSON.parse(js.stdout).cases.length, 3);
  assert.match(run('--run', home, '--cases', c.file).stderr, /sha256/);
  assert.match(run('--run', home, '--cases', c.file, '--cases-sha', 'ab'.repeat(32)).stderr, /sha256/);
  assert.match(run('--nope').stderr, /unknown argument --nope[\s\S]*usage/);
  assert.match(run('--bars', 'MNQ').stderr, /SYMBOL=<file>/);
  assert.match(run().stderr, /no --run/);
  assert.match(run('--run', path.join(dir, 'none')).stderr, /no such path/);
  assert.strictEqual(run('--nope').status, 1);
});

test('entries carry the model\'s word, its stated frames and the word against them, end to end; the report and the aggregate say so', () => {
  const dir = tmpDir();
  const doc = report(runHome({ word: 'trend-up', frames: { '4h': 'range', '1h': 'range', '15m': 'up' } }), dir);
  const [leg, chop] = doc.cases;
  assert.deepStrictEqual(leg.entries.map(e => [e.modelWord, e.frames, e.wordVsFrames]), [['trend-up', { '4h': 'range', '1h': 'range', '15m': 'up' }, 'contradicts']]);
  assert.strictEqual(chop.entries[0].wordVsFrames, 'contradicts');
  assert.strictEqual(doc.summary.entryWords.chop.byWord['trend-up'], 1);
  const text = P.renderReport(doc);
  assert.match(text, /Entries by the model's own word[^\n]*chop days 1 entries: \{"trend-up":1,[^\n]*"contradicts":1[^\n]*trend legs 1 entries/);
  assert.match(text, /model's word trend-up, frames 4h range \| 1h range \| 15m up, word vs frames contradicts/);
  assert.match(text, /The class word against its own frames, every candle[^\n]*chop days candles \d+, word vs frames \{"agrees":\d+,"contradicts":\d+,"unstated":\d+\} \(in trade[^\n]*word changes with the frames unchanged \d+ of \d+ such pairs; longest run of one word \d+ over 1 cases; trend legs[^\n]*word vs the leg's side \{"same":\d+,"opposite":\d+/);
  assert.match(text, /class word every candle: candles/);
  assert.strictEqual(doc.summary.wordStability.trend.cases, 1);
  const none = P.renderReport(report(runHome({ word: 'chop' }), tmpDir()));
  assert.match(none, /word chop, frames unstated, vs frames unstated/, 'no frames stated: unstated, never guessed');
  assert.ok(!/NaN|undefined/.test(text + none));
});
