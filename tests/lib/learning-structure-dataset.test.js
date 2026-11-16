'use strict';

// The structure-read dataset (scripts/lib/learning/structure-dataset.js): each recorded bar's briefing with each fixed
// instruction; a model's answer kept only when it verified on every field, else the code-built answer; splits, the code
// digest, duplicates, the balance by case and regime, and the fingerprint.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SD = require('../../scripts/lib/learning/structure-dataset');
const SR = require('../../scripts/lib/learning/structure-read');
const { tmpDir } = require('../helpers');
const { briefing } = require('../fixtures/structure-briefing');

const CODE = 'c'.repeat(64);
const CURRENT = { skills: 'a'.repeat(64), prompt: 'b'.repeat(64), code: CODE };
const SPEC = { structureRead: { seed: 1, maxCaseShare: 0.6, maxRegimeShare: 0.6 } };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const lines = text => text.split('\n').filter(Boolean).map(l => JSON.parse(l));

// The bars' facts vary so the balance has cases and regimes to keep (a continuation trend, a potential reversal in a
// pullback, a failed reversal in chop).
const SHAPES = [
  { last: { kind: 'BOS', direction: 'up', protected: { level: 13990.25, brokenAt: null } }, previous: { kind: 'BOS', direction: 'up' }, pullback: null },
  {},
  { last: { kind: 'CHoCH', direction: 'down' }, previous: { kind: 'CHoCH', direction: 'up' }, pullback: null, marketState: '- Market state (3m): chop; class chop.' },
];

/** A run home with one cycle file per bar (its prompt holds the briefing; its timing the bar's close). */
function writeRun(home, { runId = 'r1', days = ['2022-03-07', '2022-03-08', '2022-03-09'], code = CODE, start = '2022-03-07T00:00:00Z', end = '2022-03-12T00:00:00Z', extra = [] } = {}) {
  const runDir = path.join(home, 'replay', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ runId, start, end, hash: `h-${runId}` }));
  fs.writeFileSync(path.join(runDir, 'setup.json'), JSON.stringify({ runId, code }));
  const bars = [];
  days.forEach((day, i) => SHAPES.forEach((shape, k) => {
    const t = `${day}T${15 + k}:00:00.000Z`;
    const b = briefing({ t, ...shape });
    bars.push({ t, b });
    const dir = path.join(home, 'logs', 'cycles', day);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${i}${k}-trade.json`), JSON.stringify({ action: 'trade', timing: { barClose: t }, prompt: `Cycle prompt.\n\n${b}\nThe account.\n` }));
  }));
  for (const [name, doc] of extra) fs.writeFileSync(path.join(home, 'logs', 'cycles', days[0], name), JSON.stringify(doc));
  return { runDir, bars };
}

const build = (o = {}) => SD.buildStructureDataset({ spec: SPEC, current: CURRENT, ...o });

test('sourceFromRun: each bar\'s briefing once (the first cycle at its close), its trading day; a cycle without one skipped', () => {
  const home = tmpDir();
  const b = briefing({ t: '2022-03-07T15:00:00.000Z' });
  const { runDir, bars } = writeRun(home, { extra: [
    ['zz-again.json', { timing: { barClose: '2022-03-07T15:00:00.000Z' }, prompt: `again ${b}` }],
    ['zz-none.json', { timing: { barClose: '2022-03-07T18:00:00.000Z' }, prompt: 'no briefing' }],
    ['zz-notime.json', { prompt: b }],
  ] });
  const s = SD.sourceFromRun(runDir);
  assert.strictEqual(s.bars.length, bars.length);
  assert.deepStrictEqual(s.bars[0], { t: '2022-03-07T15:00:00.000Z', day: '2022-03-07', symbol: 'MNQ', briefing: bars[0].b });
  assert.deepStrictEqual(s.digest, { code: CODE });
  assert.throws(() => SD.sourceFromRun(tmpDir()), /no manifest\.json/);
});

test('build: a verified answer is kept byte for byte (source model); a wrong one never, the code\'s answer in its place (source code)', () => {
  const home = tmpDir();
  const { runDir, bars } = writeRun(home);
  const src = SD.sourceFromRun(runDir);
  const p0 = SR.promptOf(bars[0].b, 'sequence');
  const t0 = SR.truthOf(bars[0].b).sequence;
  const good = ` ${JSON.stringify(t0)}\n`;
  const p1 = SR.promptOf(bars[1].b, 'sequence');
  const wrong = JSON.stringify({ ...SR.truthOf(bars[1].b).sequence, seq: 'failed reversal' });
  const answers = SD.readAnswers([`${JSON.stringify({ id: sha(p0), text: good })}\n${JSON.stringify({ id: sha(p0), text: good })}\n${JSON.stringify({ id: sha(p1), text: wrong })}\n${JSON.stringify({ id: 'f'.repeat(64), text: 'x' })}\n`]);
  const built = build({ train: [src], answers });
  const train = lines(built.files['train.jsonl']);
  const meta = lines(built.files['meta.jsonl']);
  const at = id => train[meta.findIndex(m => m.id === id)];
  assert.deepStrictEqual(at(sha(p0)).messages, [{ role: 'user', content: p0 }, { role: 'assistant', content: good }]);
  assert.strictEqual(meta.find(m => m.id === sha(p0)).source, 'model');
  assert.strictEqual(at(sha(p1)).messages[1].content, SR.goldAnswer('sequence', SR.truthOf(bars[1].b).sequence));
  assert.strictEqual(meta.find(m => m.id === sha(p1)).source, 'code');
  assert.ok(!train.some(x => x.messages[1].content === wrong), 'the wrong answer never trained on');
  const c = built.dataset.counts.train;
  assert.deepStrictEqual(c.answers, { seen: 3, verified: 1, rejected: 1, extraVerified: 1 });
  assert.deepStrictEqual(c.wrongFields, { 'sequence.seq': 1 });
  assert.strictEqual(built.dataset.counts.unmatchedAnswers, 1);
  assert.strictEqual(train.length, bars.length * 2, 'one example per bar and instruction');
  // --no-gold: verified answers only (three bars of different cases and regimes answered right, one wrong).
  const right = bars.slice(0, 3).map(x => ({ id: sha(SR.promptOf(x.b, 'sequence')), text: SR.goldAnswer('sequence', SR.truthOf(x.b).sequence) }));
  const noGold = build({ train: [src], answers: SD.readAnswers([[...right, { id: sha(p1), text: wrong }].map(r => JSON.stringify(r)).join('\n')]), gold: false });
  assert.deepStrictEqual(lines(noGold.files['meta.jsonl']).map(m => `${m.kind}:${m.source}`), ['sequence:model', 'sequence:model', 'sequence:model']);
  assert.throws(() => build({ train: [src], answers, gold: false }), /balance can't be met/, 'one verified bar: one case only');
});

test('splits: train only from practice-train, validate only from practice-validate; a run touching test or final refused', () => {
  const home = tmpDir();
  const tr = SD.sourceFromRun(writeRun(path.join(home, 'a')).runDir);
  assert.throws(() => build({ train: [tr], validate: [tr] }), /refused for the validate set/);
  const sealed = SD.sourceFromRun(writeRun(path.join(home, 'b'), { days: ['2025-03-03'], start: '2025-03-01T00:00:00Z', end: '2025-03-08T00:00:00Z' }).runDir);
  assert.throws(() => build({ train: [sealed] }), /refused for the train set/);
  // A bar outside the run's declared window (a forged or stale manifest) is refused, never moved to a set.
  const outside = { ...tr, bars: [...tr.bars, { ...tr.bars[0], t: '2025-03-03T15:00:00.000Z', day: '2025-03-03' }] };
  assert.throws(() => build({ train: [outside] }), /outside the train set's window/);
  assert.throws(() => build({ train: [] }), /no train sources/);
});

test('the code digest: bars made under other code are dropped and counted, kept only by name and marked', () => {
  const home = tmpDir();
  const cur = SD.sourceFromRun(writeRun(path.join(home, 'a')).runDir);
  const old = SD.sourceFromRun(writeRun(path.join(home, 'b'), { runId: 'old', days: ['2022-03-10'], code: 'e'.repeat(64) }).runDir);
  const built = build({ train: [cur, old] });
  assert.strictEqual(built.dataset.counts.train.stale, 3);
  assert.ok(lines(built.files['meta.jsonl']).every(m => m.run === 'r1' && m.current === true));
  const inc = build({ train: [cur, old], include: ['eeeeeeee'] });
  assert.ok(lines(inc.files['meta.jsonl']).some(m => m.run === 'old' && m.current === false));
  assert.throws(() => build({ train: [old] }), /no train bar gives an example/);
  assert.throws(() => build({ train: [cur], include: ['xyz'] }), /include/);
  assert.throws(() => build({ train: [cur], current: { code: 'short' } }), /current/);
  assert.strictEqual(SD.codeStatus({ code: null }, CURRENT, []), 'stale', 'a run whose code changed mid-run');
});

test('duplicates and unreadable facts: the same prompt from two runs once; a bar whose facts can\'t be read gives no example of that instruction', () => {
  const home = tmpDir();
  const a = SD.sourceFromRun(writeRun(path.join(home, 'a')).runDir);
  const b = SD.sourceFromRun(writeRun(path.join(home, 'b'), { runId: 'r2' }).runDir);
  const built = build({ train: [a, b] });
  assert.strictEqual(built.dataset.counts.train.duplicates, a.bars.length * 2);
  const bad = { ...a, bars: [{ ...a.bars[0], briefing: briefing({ t: a.bars[0].t, pullback: '- Pullback (15m, long leg 1 -> 2): 4 bars since the extreme.' }) }, ...a.bars.slice(1)] };
  const r = build({ train: [bad] });
  assert.deepStrictEqual(r.dataset.counts.train.unreadable, { structure: 1, sequence: 0 });
});

test('balance: no case or regime over the spec\'s share (seeded draws dropped, a bar\'s instructions together); unmeetable refuses', () => {
  const home = tmpDir();
  const src = SD.sourceFromRun(writeRun(home, { days: ['2022-03-07', '2022-03-08', '2022-03-09', '2022-03-10'] }).runDir);
  const skew = { ...src, bars: [...src.bars, ...src.bars.filter((_b, i) => i % 3 === 0).map((b, j) => ({ ...b, t: `2022-03-11T1${j}:00:00.000Z`, day: '2022-03-11', briefing: briefing({ t: `2022-03-11T1${j}:00:00.000Z`, ...SHAPES[0] }) }))] };
  const spec = { structureRead: { seed: 1, maxCaseShare: 0.4, maxRegimeShare: 0.4 } };
  const built = build({ train: [skew], spec });
  const after = built.dataset.balance.after;
  for (const k of ['case', 'regime']) for (const n of Object.values(after[k])) assert.ok(n / after.n <= 0.4 + 1e-9, `${k} within its cap`);
  assert.ok(built.dataset.balance.before.n > after.n);
  const meta = lines(built.files['meta.jsonl']);
  const perBar = new Map();
  for (const m of meta) perBar.set(m.t, (perBar.get(m.t) || 0) + 1);
  assert.ok([...perBar.values()].every(n => n === 2), 'both instructions of a kept bar');
  assert.deepStrictEqual(build({ train: [skew], spec }).files, built.files, 'deterministic');
  const one = { ...src, bars: src.bars.filter((_b, i) => i % 3 === 0) };
  assert.throws(() => build({ train: [one], spec }), /balance can't be met/);
  assert.throws(() => build({ train: [src], spec: {} }), /structureRead/);
});

test('the fingerprint: written and read back; a changed file is refused; a new folder only', () => {
  const home = tmpDir();
  const built = build({ train: [SD.sourceFromRun(writeRun(home).runDir)] });
  const dir = path.join(tmpDir(), 'ds');
  SD.writeDataset(dir, built);
  assert.strictEqual(SD.readDataset(dir).fingerprint, built.dataset.fingerprint);
  assert.throws(() => SD.writeDataset(dir, built), /already holds a dataset/);
  fs.appendFileSync(path.join(dir, 'train.jsonl'), '{"messages":[]}\n');
  assert.throws(() => SD.readDataset(dir), /don't match its fingerprint/);
  assert.notStrictEqual(SD.fingerprintOf({ 'train.jsonl': 'a' }), SD.fingerprintOf({ 'train.jsonl': 'b' }));
  assert.ok(built.dataset.coverage.train.kind.structure > 0 && built.dataset.coverage.train.kind.sequence > 0);
});

test('promptLines and readAnswers: each bar\'s prompts with their ids; a bad answers line throws', () => {
  const home = tmpDir();
  const src = SD.sourceFromRun(writeRun(home).runDir);
  const ps = SD.promptLines([src]);
  assert.strictEqual(ps.length, src.bars.length * 2);
  assert.ok(ps.every(p => p.id === sha(p.prompt) && SR.KINDS.includes(p.kind)));
  assert.throws(() => SD.readAnswers(['not json']), /not JSON/);
  assert.throws(() => SD.readAnswers(['{"id":"x","text":"y"}']), /\{ id/);
  assert.deepStrictEqual([...SD.readAnswers([`{"id":"${'a'.repeat(64)}","text":"y"}\n\n`]).entries()], [['a'.repeat(64), ['y']]]);
});

test('sourceFromRun: a cycle whose briefing is not as of its bar close is skipped (not that bar\'s read)', () => {
  const home = tmpDir();
  const { runDir, bars } = writeRun(home, { extra: [['zz-late.json', { timing: { barClose: '2022-03-07T18:00:00.000Z' }, prompt: briefing({ t: '2022-03-07T18:03:00.000Z' }) }]] });
  assert.strictEqual(SD.sourceFromRun(runDir).bars.length, bars.length);
});
