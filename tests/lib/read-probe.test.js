'use strict';

// The read probe (scripts/lib/eval/read-probe.js): the moment probe's read mode. The old arm is the recorded prompt, the
// new one the prompt patched (briefing patches, the State line, optionally a skill tree); each answer is scored for
// its reads (read-score.js) and its decision word, counted per set (change: a recorded 1h/15m disagreement; hold: the
// frames agree). Data only: no pass or fail on the decision. `ask` is a fake here: no model.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../../scripts/lib/eval/read-probe');
const { PROBE_SUFFIX } = require('../../scripts/lib/eval/moment-probe');

const BRIEF = labels => ['--- bar_briefing {"symbol":"MNQ"} ---', 'Summary (MNQ 3m, 10:03 ET):', '- Trend rule: SHORT allowed (prevailing 1h down).',
  '- Alignment: long mixed, short mixed.', '- 1h (closed 10:00): bullish engulfing, close top third, range 3.55 ATR; traded beyond the previous 1h high, closed above its high.',
  'Detail by timeframe:', '[m3] version m3@2021-05-11T14:03:00.000Z, valid until 10:06 ET', '  et: 10:03', '  windowEntries: allowed',
  '[m15] version m15@2021-05-11T14:00:00.000Z', `  frame: {"trend":"${labels['15m']}"}`, '[h1] version h1@2021-05-11T14:00:00.000Z',
  `  h1: {"trend":"${labels['1h']}"}`, `  h4: {"trend":"${labels['4h']}"}`, '--- end of bar_briefing ---'].join('\n');
const LOG = (labels = { '4h': 'range', '1h': 'down', '15m': 'range' }, result = 'CYCLE RESULT: no-trade - x') => ({ prompt: `Cycle.\n${BRIEF(labels)}\n`, result, argv: ['claude', '--model', 'm1', '--append-system-prompt-file', '/sys.md'] });

const LINE = '- State (x): 4h range | 1h down: DISAGREE - last candle bullish engulfing closed above its high (closed 10:00, range 3.55 ATR) -> label and price disagree: transition | 15m range.';

test('momentForRead: a moment from a recorded cycle: labels, recorded outcome, system file (argv or the override)', () => {
  const m = P.momentForRead(LOG(), { id: 'c1', set: 'change' });
  assert.deepStrictEqual({ ...m, prompt: undefined }, { id: 'c1', set: 'change', prompt: undefined, system: '/sys.md', model: 'm1', recorded: 'no-trade', labels: { '4h': 'range', '1h': 'down', '15m': 'range' } });
  assert.ok(m.prompt.endsWith(PROBE_SUFFIX));
  assert.strictEqual(P.momentForRead(LOG(), { id: 'c1', set: 'hold' }, { system: '/other.md' }).system, '/other.md', 'the override wins (both arms)');
  const noSys = { ...LOG(), argv: ['claude', '--plugin-dir', '/p'] };
  assert.throws(() => P.momentForRead(noSys, { id: 'c2', set: 'change' }), /--system/);
  assert.strictEqual(P.momentForRead(noSys, { id: 'c2', set: 'change' }, { system: '/s.md' }).system, '/s.md');
  assert.throws(() => P.momentForRead(LOG(), { id: 'c3', set: 'flip' }), /set: one of change, hold/);
  assert.throws(() => P.momentForRead({ ...LOG(), prompt: '' }, { id: 'c4', set: 'hold' }), /no prompt/);
  assert.strictEqual(P.momentForRead({ ...LOG(), result: 'no line' }, { id: 'c5', set: 'hold' }).recorded, null, 'a hold moment need not have entered (read mode)');
});

test('armOf: patches and the State line applied to the moment prompt; changed names each; a missing State line is untestable', () => {
  const m = P.momentForRead(LOG(), { id: 'c1', set: 'change' });
  const a = P.armOf(m, { stateLine: () => LINE });
  assert.deepStrictEqual(a.changed, ['state-line']);
  assert.strictEqual(a.line, LINE);
  assert.ok(a.prompt.includes(`- Trend rule: SHORT allowed (prevailing 1h down).\n${LINE}\n- Alignment:`));
  assert.deepStrictEqual(P.armOf(m, { stateLine: () => null }).changed, []);
  const b = P.armOf(m, { patches: [{ name: 'p', within: { from: '--- bar_briefing', to: '--- end of bar_briefing' }, match: 'long mixed', op: 'replace', text: 'long aligned' }] });
  assert.deepStrictEqual(b.changed, ['p']);
  assert.ok(b.prompt.includes('long aligned, short mixed'));
  assert.strictEqual(b.line, null);
  const c = P.armOf({ ...m, prompt: `<skill name="candle-reading">\nOLD\n</skill>\n${m.prompt}` }, { bodyOf: n => (n === 'candle-reading' ? 'NEW' : null) });
  assert.deepStrictEqual(c.changed, ['skill candle-reading']);
});

const answers = {
  oldPlanned: 'PLAN: short with the 1h down.\nCYCLE RESULT: planned - short',
  newConflict: 'The 1h down label vs its bullish engulfing closed above its high: a transition, I weigh both.\nCYCLE RESULT: no-trade - unresolved',
  newEcho: 'label and price disagree: transition.\nCYCLE RESULT: no-trade - x',
};

test('probeReads: both arms asked k times; per-arm read counts, majorities, calibration and the decision change', async () => {
  const moments = [P.momentForRead(LOG(undefined, 'CYCLE RESULT: planned - short'), { id: 'c1', set: 'change' }), P.momentForRead(LOG({ '4h': 'up', '1h': 'up', '15m': 'up' }, 'CYCLE RESULT: planned - long'), { id: 'h1', set: 'hold' })];
  const asked = [];
  const ask = async (prompt, { id, arm }) => {
    asked.push(`${id}/${arm}`);
    if (arm === 'old') return { text: id === 'h1' ? 'CYCLE RESULT: planned - long' : answers.oldPlanned };
    if (id === 'h1') return { text: 'The frames all agree.\nCYCLE RESULT: planned - long' };
    return { text: asked.filter(x => x === 'c1/new').length === 1 ? answers.newConflict : answers.newEcho };
  };
  const { rows, summary } = await P.probeReads({ moments, arm: m => P.armOf(m, { stateLine: x => (x.id === 'c1' ? LINE : '- State (x): 4h up: agree | 1h up: agree | 15m up: agree.') }), ask, k: 2 });
  assert.deepStrictEqual(asked.filter(x => x.startsWith('c1')).sort(), ['c1/new', 'c1/new', 'c1/old', 'c1/old']);
  const c1 = rows.find(r => r.id === 'c1');
  assert.deepStrictEqual(c1.old, { asks: 2, answered: 2, errors: 0, namesConflict: 0, ownConflict: 0, calledLabelStale: 0, echoesState: 0, planned: 2, 'no-trade': 0, other: 0, none: 0 });
  assert.deepStrictEqual(c1.new, { asks: 2, answered: 2, errors: 0, namesConflict: 2, ownConflict: 1, calledLabelStale: 0, echoesState: 1, planned: 0, 'no-trade': 2, other: 0, none: 0 });
  assert.strictEqual(c1.oldDecision, 'planned');
  assert.strictEqual(c1.newDecision, 'no-trade');
  assert.strictEqual(c1.calibrated, true);
  assert.strictEqual(c1.decisionChanged, true);
  const h1 = rows.find(r => r.id === 'h1');
  assert.strictEqual(h1.new.namesConflict, 0, 'agreeing frames: no conflict named');
  assert.strictEqual(h1.decisionChanged, false);
  assert.strictEqual(summary.change.moments, 1);
  assert.strictEqual(summary.change.decisionChanged, 1);
  assert.strictEqual(summary.change.new.namesConflict, 2);
  assert.strictEqual(summary.change.old.namesConflict, 0);
  assert.strictEqual(summary.hold.new.namesConflict, 0);
  assert.strictEqual(summary.hold.calibrated, 1);
  assert.ok(!('ok' in summary), 'no pass or fail: data');
});

test('probeReads: a moment the arm cannot change is untestable and never asked; a failed ask is counted, not scored', async () => {
  const moments = [P.momentForRead(LOG(), { id: 'u', set: 'change' }), P.momentForRead(LOG(), { id: 'e', set: 'change' })];
  const asked = [];
  const ask = async (p, { id, arm }) => { asked.push(id); if (arm === 'new') throw new Error('rate limit\nmore'); return { text: 'no result line' }; };
  const { rows, summary } = await P.probeReads({ moments, arm: m => (m.id === 'u' ? { prompt: m.prompt, changed: [], line: null } : P.armOf(m, { stateLine: () => LINE })), ask, k: 1 });
  assert.ok(!asked.includes('u'));
  assert.strictEqual(rows[0].verdict, 'untestable');
  assert.deepStrictEqual(rows[1].errors, ['rate limit']);
  assert.strictEqual(rows[1].new.errors, 1);
  assert.strictEqual(rows[1].new.answered, 0);
  assert.strictEqual(rows[1].old.none, 1);
  assert.strictEqual(rows[1].oldDecision, null);
  assert.strictEqual(rows[1].calibrated, false, 'no old answer: not calibrated');
  assert.strictEqual(rows[1].decisionChanged, null, 'no majority on an arm: not comparable');
  assert.strictEqual(summary.change.untestable, 1);
  assert.strictEqual(summary.change.comparable, 0);
});

test('probeReads: every arm is built before any ask, so a patch whose anchor is missing fails the run with no model call', async () => {
  const moments = [P.momentForRead(LOG(), { id: 'a', set: 'change' }), P.momentForRead(LOG(), { id: 'b', set: 'change' })];
  let asks = 0;
  const bad = [{ name: 'x', line: '^- Nowhere:', op: 'before', text: 'y' }];
  await assert.rejects(P.probeReads({ moments, arm: m => P.armOf(m, { patches: bad }), ask: async () => { asks += 1; return { text: '' }; }, k: 1 }), /a: .*not found[\s\S]*b: .*not found/);
  assert.strictEqual(asks, 0);
  await assert.rejects(P.probeReads({ moments: [moments[0], { ...moments[1], id: 'a' }], arm: m => P.armOf(m, {}), ask: async () => ({ text: '' }), k: 1 }), /duplicate id/);
});

test('readTable: one row per moment and a summary per set, old -> new', async () => {
  const moments = [P.momentForRead(LOG(), { id: 'c1', set: 'change' })];
  const res = await P.probeReads({ moments, arm: m => P.armOf(m, { stateLine: () => LINE }), ask: async (p, { arm }) => ({ text: arm === 'new' ? answers.newConflict : answers.oldPlanned }), k: 1 });
  const t = P.readTable(res);
  const lines = t.split('\n');
  assert.match(lines[0], /^set\s+id\s+recorded\s+old\s+new\s+conflict old>new\s+own new\s+echo new\s+stale old>new\s+changed$/);
  assert.match(t, /\nchange\s+c1\s+no-trade\s+planned\s+no-trade\s+0\/1 > 1\/1\s+1\/1\s+0\/1\s+0\/1 > 0\/1\s+state-line\n/);
  assert.match(t, /\nchange: 1 moments \(0 untestable\), calibrated 0, decision changed 1 of 1; namesConflict 0\/1 -> 1\/1 \(own words 1\/1, echo 0\/1\); calledLabelStale 0\/1 -> 0\/1; planned 1 -> 0, no-trade 0 -> 1\n/);
  assert.match(t, /hold: no moments/);
});

test('momentsFromCycles: change = a 1h or 15m disagreement, hold = the frames agree on the same days; flat entry-window cycles only', () => {
  const st = (a, b, c) => ({ '4h': { state: a }, '1h': { state: b }, '15m': { state: c } });
  const by = {
    'c.json': st('range', 'disagree', 'range'), 'c15.json': st('agree', 'agree', 'disagree'), 'c4h.json': st('disagree', 'agree', 'agree'),
    'h.json': st('agree', 'agree', 'range'), 'hr.json': st('range', 'range', 'range'), 'hu.json': st('unknown', 'agree', 'agree'),
    'other-day.json': st('agree', 'agree', 'agree'), 'managed.json': st('range', 'disagree', 'range'), 'closed.json': st('range', 'disagree', 'range'),
  };
  const log = (result = 'CYCLE RESULT: no-trade - x', entries = 'allowed') => ({ result, prompt: `[m3] version m3@x\n  windowEntries: ${entries}\n` });
  const cycles = Object.keys(by).map(f => ({ run: 'r1', day: f === 'other-day.json' ? 'd2' : 'd1', file: f, path: `/h/${f}`,
    log: f === 'managed.json' ? log('CYCLE RESULT: managed - x') : f === 'closed.json' ? log(undefined, 'closed') : log() }));
  const out = P.momentsFromCycles(cycles, { statesOf: c => by[c.file] });
  assert.deepStrictEqual(out.map(m => [m.set, m.cycle]), [['change', '/h/c.json'], ['change', '/h/c15.json'], ['hold', '/h/h.json']]);
  assert.strictEqual(out[0].id, 'change-r1-d1-c');
  assert.strictEqual(out[0].frames, '4h range | 1h disagree | 15m range');
  assert.deepStrictEqual(P.momentsFromCycles(cycles, { statesOf: c => by[c.file], sameDays: false }).map(m => m.cycle).filter(c => /other/.test(c)), ['/h/other-day.json']);
});

test('collectCycles: every *-trade.json under each home\'s logs/cycles, days filtered', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [day, f] of [['2021-05-11', '140314-trade.json'], ['2021-05-11', '140314-manage.json'], ['2021-05-12', '140000-trade.json']]) {
    fs.mkdirSync(path.join(dir, 'run-a', 'logs', 'cycles', day), { recursive: true });
    fs.writeFileSync(path.join(dir, 'run-a', 'logs', 'cycles', day, f), JSON.stringify({ prompt: day }));
  }
  const all = P.collectCycles([path.join(dir, 'run-a')]);
  assert.deepStrictEqual(all.map(c => [c.run, c.day, c.file]), [['run-a', '2021-05-11', '140314-trade.json'], ['run-a', '2021-05-12', '140000-trade.json']]);
  assert.strictEqual(all[0].log.prompt, '2021-05-11');
  assert.deepStrictEqual(P.collectCycles([path.join(dir, 'run-a')], ['2021-05-12']).map(c => c.day), ['2021-05-12']);
  assert.throws(() => P.collectCycles([path.join(dir, 'nope')]), /logs\/cycles/);
});
