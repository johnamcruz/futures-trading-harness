'use strict';

// The curated lists (scripts/lib/learning/curated-lists.js): selection (year balance, skill minimums, confluence,
// winners and losers, the pass share), the seeded mix, the fingerprint, the split guards, the coverage report, and a
// practice replay of a pinned list (its windows only, its fingerprint in setupHash, the selector inside its windows).
// On synthetic moments in the shape curated-moments.js scans (its own test covers the scan on the fixture bars).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../../scripts/lib/learning/curated-lists');
const { VERSION } = require('../../scripts/lib/learning/curated-moments');

const MARKET = { symbols: ['MNQ'], timeframe: 3, setupTf: 15 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-curated-'));
const BASE_SKILLS = ['bos-vs-choch', 'candle-reading', 'levels-and-reactions', 'multi-timeframe-analysis', 'rejection'];

/** A moment as curated-moments.js scans it (the fields the lists read). */
function moment({ id, day = '2022-03-01', time = '15:00', list = 'trend-up', use = 'practice', skills = BASE_SKILLS, aligned = null, expected = 'take', result = 'win', d2 = null, rel = 'rejected', minutes = 3, setupTf = 15 } = {}) {
  const reactionAt = `${day}T${time}:00.000Z`;
  const r = Date.parse(reactionAt);
  return {
    v: VERSION, use, id: id || `${list}-${day}-${time}`, root: 'MNQ', day, year: day.slice(0, 4), reactionAt, bar: new Date(r + 360000).toISOString(),
    minutes, setupTf, reaction: { kind: 'level', name: 'prior VAH', rel, dir: 'up', price: 100 }, reactionKind: rel === 'broke' ? 'breakout' : 'rejection', side: 'long', list, trend: { state: 'clear', dir: 'up' }, regime: 'trend-up',
    reads: [], skills: [...skills].sort(), aligned: [...(aligned || skills)].sort(),
    standard: { status: ['win', 'loss', 'unfilled'].includes(result) ? 'traded' : result }, outcome: { result, R: result === 'win' ? 2 : result === 'loss' ? -1 : null },
    gate: { trendAllowed: !d2, prevailing: d2 ? '1h' : null, d2 }, expected,
    window: { from: new Date(r - 45 * 60000).toISOString(), to: new Date(r + 60 * 60000).toISOString() },
  };
}

/** n moments of a list in a year, a day each (weekdays of March and April), varied outcomes. */
function series(list, year, n, over = {}) {
  const out = [];
  for (let k = 0; out.length < n; k += 1) {
    const d = new Date(Date.UTC(year, 2, 1) + k * 86400000);
    if ([0, 6].includes(d.getUTCDay())) continue;
    const i = out.length;
    out.push(moment({ list, day: d.toISOString().slice(0, 10), result: i % 3 === 0 ? 'loss' : 'win', ...over, id: `${list}-${year}-${i}` }));
  }
  return out;
}

test('balanced by year: the year with the fewest first, none past its cap (the list short rather than one year filling it)', () => {
  const cands = [...series('trend-up', 2020, 60), ...series('trend-up', 2021, 12), ...series('trend-up', 2023, 4)];
  const picked = C.selectList(cands, { name: 'trend-up', size: 24, seed: 1, minSkill: 0 });
  const years = {};
  for (const m of picked) years[m.year] = (years[m.year] || 0) + 1;
  assert.deepStrictEqual(years, { 2020: 10, 2021: 10, 2023: 4 }, '2023 gives all it has, the others share the rest');
  const even = C.selectList(cands, { name: 'trend-up', size: 12, seed: 1, minSkill: 0 });
  assert.deepStrictEqual(even.reduce((o, m) => ({ ...o, [m.year]: (o[m.year] || 0) + 1 }), {}), { 2020: 4, 2021: 4, 2023: 4 });
  // Two years, one nearly empty: the full one stops at 1.5 times its even share (15 of 20), so the list is short.
  const lopsided = C.selectList([...series('trend-up', 2020, 60), ...series('trend-up', 2022, 2)], { name: 'trend-up', size: 20, seed: 1, minSkill: 0 });
  assert.deepStrictEqual(lopsided.reduce((o, m) => ({ ...o, [m.year]: (o[m.year] || 0) + 1 }), {}), { 2020: 15, 2022: 2 });
  assert.strictEqual(C.YEAR_CAP, 1.5);
});

test('skill minimums: a rare skill reaches its minimum where the data has it; confluence decides among the rest', () => {
  const plain = series('trend-up', 2021, 40, { skills: [...BASE_SKILLS, 'vwap-volume-profile', 'momentum-and-volume'] });
  const rare = [0, 1, 2, 3].map(i => moment({ id: `rare-${i}`, day: `2021-04-${String(12 + i).padStart(2, '0')}`, skills: ['absorption', 'rejection'] }));
  const once = moment({ id: 'once', day: '2021-04-20', skills: ['cisd'] });
  const cands = [...plain, ...rare, once];
  const picked = C.selectList(cands, { name: 'trend-up', size: 10, seed: 3, minSkill: 3 });
  assert.strictEqual(picked.filter(m => m.skills.includes('absorption')).length, 3, 'the rare skill at its minimum, not more');
  assert.ok(picked.some(m => m.id === 'once'), 'a skill the data has once is taken once');
  // The scarcest skill first: one moment with a rare skill and few others beats the ones with many common skills.
  const many = series('chop', 2021, 20, { skills: [...BASE_SKILLS, 'cisd', 'momentum-and-volume', 'vwap-volume-profile'] });
  const gap = moment({ id: 'gap', day: '2021-05-03', list: 'chop', skills: ['fair-value-gaps', 'rejection'] });
  assert.ok(C.selectList([...many, gap], { name: 'chop', size: 2, seed: 1, minSkill: 1 }).some(m => m.id === 'gap'), 'the rare skill is in a list of two');
  const cov = C.coverageOf(picked, cands, { minSkill: 3 });
  assert.deepStrictEqual([cov.skills.absorption.count, cov.skills.absorption.under, cov.skills.cisd.under, cov.skills.cisd.dataShort], [3, false, true, true]);
  assert.ok(cov.under.includes('cisd') && !cov.under.includes('absorption'));
  // Without minimums the low-confluence rare moments lose to the plain ones.
  assert.strictEqual(C.selectList(cands, { name: 'trend-up', size: 10, seed: 3, minSkill: 0 }).filter(m => m.skills.includes('absorption')).length, 0);
  // Confluence: the moments whose reads line up most are favoured.
  const lined = series('trend-up', 2022, 30, { result: 'win' }).map((m, i) => (i % 5 === 0 ? { ...m, aligned: [...m.aligned, 'cisd', 'vwap-volume-profile', 'absorption'] } : m));
  const top = C.selectList(lined, { name: 'trend-up', size: 6, seed: 9, minSkill: 0 });
  assert.ok(top.every(m => m.aligned.length === BASE_SKILLS.length + 3), 'the six most aligned');
});

test('winners and losers both kept; a list with a pass share holds it, then takes the takes it has (D2 reversals)', () => {
  const wins = series('trend-down', 2022, 30, { result: 'win', aligned: [...BASE_SKILLS, 'cisd'] });
  const losses = series('trend-down', 2022, 6, { result: 'loss' }).map(m => ({ ...m, id: `${m.id}-l` }));
  const picked = C.selectList([...wins, ...losses], { name: 'trend-down', size: 10, seed: 2, minSkill: 0 });
  const tally = picked.reduce((o, m) => ({ ...o, [m.outcome.result]: (o[m.outcome.result] || 0) + 1 }), {});
  assert.deepStrictEqual(tally, { win: 5, loss: 5 }, 'level, though the winners line up better');
  const passes = series('counter-trend', 2021, 40, { expected: 'pass', result: 'not-composable' });
  const d2 = series('counter-trend', 2021, 6, { expected: 'take', d2: { against: '1h', allowed: true, why: null }, aligned: [...BASE_SKILLS, 'cisd', 'absorption'] }).map(m => ({ ...m, id: `${m.id}-d2` }));
  const ct = C.selectList([...passes, ...d2], { name: 'counter-trend', size: 10, seed: 4, minSkill: 0, passShare: 0.7 });
  assert.deepStrictEqual([ct.filter(m => m.expected === 'pass').length, ct.filter(m => m.expected === 'take').length], [7, 3]);
});

const world = () => [
  ...series('trend-up', 2020, 30), ...series('trend-up', 2022, 30), ...series('trend-down', 2021, 30), ...series('trend-down', 2023, 30),
  ...series('trend-end', 2022, 10, { expected: 'pass', result: 'no-room' }), ...series('chop', 2020, 12, { expected: 'pass', result: 'not-composable' }),
  ...series('chop', 2024, 6), ...series('counter-trend', 2021, 10, { expected: 'pass', result: 'no-confirmation' }),
];

test('the document: the lists at their mix shares, the mix in time order, seeded, fingerprinted; coverage per list and reaction kind', () => {
  const doc = C.buildLists(world(), { use: 'practice', total: 100, seed: 7, minSkill: 2, now: new Date('2026-10-14T00:00:00Z') });
  assert.deepStrictEqual(Object.fromEntries(Object.entries(doc.lists).map(([k, v]) => [k, v.length])), { 'trend-up': 35, 'trend-down': 35, 'trend-end': 10, chop: 10, 'counter-trend': 10 });
  assert.deepStrictEqual(doc.short, {});
  assert.strictEqual(doc.mix.length, 100);
  assert.deepStrictEqual(new Set(doc.mix), new Set(Object.values(doc.lists).flat().map(m => m.id)));
  const when = id => Object.values(doc.lists).flat().find(m => m.id === id).reactionAt;
  const sorted = [...doc.mix].sort((a, b) => Date.parse(when(a)) - Date.parse(when(b)));
  assert.deepStrictEqual(doc.mix, sorted, 'in time order: a replay plays its windows forward, and the index is walk-forward');
  assert.deepStrictEqual(Object.keys(doc.coverage.mix.years), ['2020', '2021', '2022', '2023', '2024'], 'balanced across years by the selection');
  assert.deepStrictEqual(doc.market, { roots: ['MNQ'], minutes: 3, setupTf: 15 });
  assert.strictEqual(doc.coverage.chop.expected.pass, 7, 'chop: its pass share');
  const ys = doc.coverage['trend-up'].years;
  assert.ok(Object.keys(ys).length === 2 && ys[2020] + ys[2022] === 35 && Math.abs(ys[2020] - ys[2022]) <= 1, JSON.stringify(ys));
  assert.ok(doc.coverage.mix.skills.rejection.count === 100 && doc.coverage.mix.skills.rejection.combinations[[...BASE_SKILLS].sort().join('+')] === 100);
  // Seeded: the same seed, the same document (but its build time) and fingerprint; another seed, another mix.
  const again = C.buildLists(world(), { use: 'practice', total: 100, seed: 7, minSkill: 2, now: new Date('2027-01-01T00:00:00Z') });
  assert.strictEqual(again.fingerprint, doc.fingerprint);
  assert.deepStrictEqual({ ...again, builtAt: null }, { ...doc, builtAt: null });
  const other = C.buildLists(world(), { use: 'practice', total: 100, seed: 8, minSkill: 2 });
  assert.notStrictEqual(other.fingerprint, doc.fingerprint);
  assert.notDeepStrictEqual(other.lists, doc.lists, 'another seed breaks ties another way');
  // Short lists are said, and the configured mix is held to its shares.
  const small = C.buildLists(world(), { use: 'practice', total: 400, seed: 7 });
  assert.deepStrictEqual(small.short, { 'trend-up': 80, 'trend-down': 80, 'trend-end': 30, chop: 22, 'counter-trend': 30 });
  const mixed = C.buildLists(world(), { use: 'practice', total: 100, mix: { 'trend-up': 0.5, 'trend-down': 0.5 } });
  assert.deepStrictEqual([mixed.lists['trend-up'].length, mixed.lists.chop.length], [50, 0]);
  for (const bad of [{ mix: { 'trend-up': 0.5 } }, { mix: { sideways: 1 } }, { total: 0 }, { minSkill: -1 }, { seed: 1.5 }]) assert.throws(() => C.buildLists(world(), { use: 'practice', ...bad }), /curated lists refused/, JSON.stringify(bad));
  // Coverage by reaction kind: rejections and breakouts apart.
  const withBreaks = C.buildLists([...world(), ...series('trend-up', 2021, 10, { rel: 'broke' }).map(m => ({ ...m, id: `${m.id}-b` }))], { use: 'practice', total: 100, seed: 7, minSkill: 0 });
  const rx = withBreaks.coverage['trend-up'].reactions;
  assert.deepStrictEqual(Object.keys(rx), ['breakout', 'rejection']);
  assert.strictEqual(rx.breakout.n + rx.rejection.n, 35);
  assert.ok(rx.breakout.n > 0 && rx.breakout.skills.rejection === rx.breakout.n);
  assert.throws(() => C.buildLists([...world(), moment({ id: 'm5', minutes: 5 })], { use: 'practice' }), /one document is one market's/);
  const text = C.coverageText(doc);
  assert.match(text, /^curated practice lists [0-9a-f]{16} \(practice-train, MNQ 3m bars, 15m setups, seed 7\): mix 100 moment/);
  assert.match(text, /\n {2}by reaction: rejection 35; outcomes /);
  assert.match(text, /\nchop: 10 of 18 candidate\(s\); outcomes .*; expected .*pass 70%/);
  assert.match(text, /UNDER cisd: 0 \(available 0, the data has fewer than the minimum\)/);
});

test('splits: a training document takes practice-train moments only, a validation one practice-validate only; never test or final', () => {
  for (const use of ['test', 'final', 'index', undefined]) assert.throws(() => C.buildLists(world(), { use }), /curated lists refused: use/);
  assert.throws(() => C.buildLists([...world(), moment({ id: 'v', day: '2024-08-01', use: 'validate' })], { use: 'practice' }), /scanned for validate, not practice/);
  assert.throws(() => C.buildLists([moment({ id: 'late', day: '2024-08-01' })], { use: 'practice' }), /practice refused: .*practice-validate/);
  assert.throws(() => C.buildLists([moment({ id: 'sealed', day: '2025-02-03' })], { use: 'practice' }), /practice refused: .*sealed/);
  assert.throws(() => C.buildLists([moment({ id: 'early', day: '2022-03-01', use: 'validate' })], { use: 'validate' }), /validate refused: .*practice-train/);
  const v = C.buildLists(series('trend-up', 2024, 0).concat(['2024-08-05', '2024-09-10', '2024-10-15'].map((day, i) => moment({ id: `v${i}`, day, use: 'validate' }))), { use: 'validate', total: 10 });
  assert.deepStrictEqual([v.use, v.role, v.mix.length], ['validate', 'practice-validate', 3]);
  assert.throws(() => C.buildLists(world(), { use: 'practice', sources: [{ file: 'a', sha256: 'x' }, { file: 'b', sha256: 'x' }] }), /given twice/);
});

test('the file: written by its fingerprint, read back checked; a changed list is refused', () => {
  const dir = tmp();
  const doc = C.buildLists(world(), { use: 'practice', total: 50, seed: 1 });
  const file = C.writeLists(dir, doc);
  assert.strictEqual(path.basename(file), `curated-practice-${doc.fingerprint.slice(0, 16)}.json`);
  assert.deepStrictEqual(C.readLists(file), doc);
  const bad = JSON.parse(fs.readFileSync(file, 'utf8'));
  bad.lists['trend-up'][0].window.to = '2030-01-01T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(bad));
  assert.throws(() => C.readLists(file), /doesn't match its fingerprint/);
});

test('curatedForRun: the list\'s windows inside the run, the document\'s use the run\'s window; the mix\'s windows merged', () => {
  const dir = tmp();
  const train = C.writeLists(dir, C.buildLists(world(), { use: 'practice', total: 50, seed: 1 }));
  const r = C.curatedForRun({ ...MARKET, file: train, list: 'mix', start: new Date('2020-01-01T00:00:00Z'), end: new Date('2024-06-28T00:00:00Z') });
  const doc = C.readLists(train);
  const starts = new Set(Object.values(doc.lists).flat().map(m => m.window.from));
  assert.strictEqual(r.windows.length, starts.size, 'one window per distinct moment time (two lists at the same time merge)');
  assert.ok(starts.size > 40);
  assert.ok(r.windows.every((w, i) => i === 0 || w.from > r.windows[i - 1].to), 'sorted, apart');
  assert.strictEqual(C.curatedForRun({ ...MARKET, file: train, list: 'chop', start: new Date('2020-01-01T00:00:00Z'), end: new Date('2024-06-28T00:00:00Z') }).windows.length, 5);
  assert.throws(() => C.curatedForRun({ ...MARKET, file: train, list: 'mix', start: new Date('2021-01-01T00:00:00Z'), end: new Date('2024-06-28T00:00:00Z') }), /lie outside the run's/);
  assert.throws(() => C.curatedForRun({ ...MARKET, file: train, list: 'mix', start: new Date('2020-01-01T00:00:00Z'), end: new Date('2025-01-01T00:00:00Z') }), /practice refused/);
  const val = C.writeLists(dir, C.buildLists([moment({ id: 'v1', day: '2024-08-05', use: 'validate' })], { use: 'validate', total: 10 }));
  assert.throws(() => C.curatedForRun({ ...MARKET, file: val, list: 'mix', start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-06-01T00:00:00Z') }), /validate refused: .*practice-train/, 'a validation list never runs on practice-train');
  assert.strictEqual(C.curatedForRun({ ...MARKET, file: val, list: 'mix', start: new Date('2024-08-05T00:00:00Z'), end: new Date('2024-08-06T00:00:00Z') }).use, 'validate');
  // Merged: overlapping windows are one.
  const two = { lists: { 'trend-up': [moment({ id: 'a', time: '15:00' }), moment({ id: 'b', time: '15:30' })], 'trend-down': [], 'trend-end': [], chop: [], 'counter-trend': [] }, mix: ['a', 'b'] };
  assert.deepStrictEqual(C.windowsOf(two, 'mix'), [{ from: Date.parse('2022-03-01T14:15:00Z'), to: Date.parse('2022-03-01T16:30:00Z') }]);
  for (const [raw, why] of [[{ list: 'mix' }, /curatedList.file/], [{ file: 'x', list: 'sideways' }, /curatedList.list/], [{ file: 'x', manageTailMin: -1 }, /manageTailMin/], [{ file: 'x', extra: 1 }, /curatedList.extra: unknown/], ['x', /curatedList: \{/]]) {
    assert.match(C.validateCuratedConfig(raw).errors.join(), why);
  }
  assert.deepStrictEqual(C.validateCuratedConfig({ file: 'x' }).curated, { file: 'x', list: 'mix', manageTailMin: 0 });
  // The run's market is the list's.
  const at = { file: train, list: 'mix', start: new Date('2020-01-01T00:00:00Z'), end: new Date('2024-06-28T00:00:00Z') };
  assert.throws(() => C.curatedForRun({ ...at, ...MARKET, symbols: ['MES'] }), /its moments are MNQ; the run trades MES/);
  assert.throws(() => C.curatedForRun({ ...at, ...MARKET, timeframe: 1 }), /3m bars, the run's on 1m/);
  assert.throws(() => C.curatedForRun({ ...at, ...MARKET, setupTf: 5 }), /15m setups, the run's practice.setupTf is 5/);
  assert.strictEqual(C.curatedForRun({ ...at, ...MARKET, symbols: ['MES', 'mnq'] }).market.minutes, 3);
});

test('curatedPoints: a curated run steps only its windows (and their management tails) and those days\' premarket and end of day', () => {
  const { validateConfig } = require('../../scripts/lib/autotrader');
  const { decisionPoints } = require('../../scripts/lib/replay/schedule');
  const cfg = validateConfig({ harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '09:00@America/New_York', eodAt: '15:50@America/New_York', sessions: ['09:30-15:50@America/New_York'] });
  const all = decisionPoints(cfg, { start: new Date('2022-03-01T00:00:00Z'), end: new Date('2022-03-05T00:00:00Z') });
  const windows = [{ from: Date.parse('2022-03-01T15:00:00Z'), to: Date.parse('2022-03-01T15:30:00Z') }, { from: Date.parse('2022-03-03T18:00:00Z'), to: Date.parse('2022-03-03T18:12:00Z') }];
  const delay = (cfg.barDelaySeconds || 0) * 1000;
  const kept = C.curatedPoints(all, { windows, manageTailMin: 6 }, delay);
  const trade = kept.filter(p => p.kind === 'trade' && !p.manage).map(p => p.t.toISOString().slice(5, 16));
  assert.deepStrictEqual(trade, ['03-01T15:03', '03-01T15:06', '03-01T15:09', '03-01T15:12', '03-01T15:15', '03-01T15:18', '03-01T15:21', '03-01T15:24', '03-01T15:27', '03-01T15:30', '03-01T15:33', '03-01T15:36', '03-03T18:03', '03-03T18:06', '03-03T18:09', '03-03T18:12', '03-03T18:15', '03-03T18:18']);
  assert.deepStrictEqual(kept.filter(p => p.kind !== 'trade').map(p => `${p.kind}@${p.day}`), ['premarket@2022-03-01', 'eod@2022-03-01', 'premarket@2022-03-03', 'eod@2022-03-03']);
  // The rest of a window's day after its first window: management times (stepped only while something is open).
  const manage = kept.filter(p => p.manage);
  assert.ok(manage.every(p => p.kind === 'trade' && (p.day === '2022-03-01' || p.day === '2022-03-03')));
  assert.strictEqual(manage[0].t.toISOString().slice(5, 16), '03-01T15:39');
  assert.strictEqual(manage.filter(p => p.day === '2022-03-01').at(-1).t.toISOString().slice(5, 16), '03-01T20:48', 'to end of day');
  assert.ok(!manage.some(p => p.day === '2022-03-03' && p.t.getTime() - delay <= windows[1].from), 'never before the day\'s first window');
  assert.ok(!kept.some(p => ['2022-03-02', '2022-03-04'].includes(p.day)), 'days without a window are not stepped');
  assert.deepStrictEqual(C.emptyWindows(all, { windows: [...windows, { from: Date.parse('2022-03-02T23:00:00Z'), to: Date.parse('2022-03-02T23:30:00Z') }] }, delay).length, 1, 'a window outside the sessions holds no time');
  assert.deepStrictEqual(C.dayChunks('2022-03-01', '2022-03-08', 3), [['2022-03-01', '2022-03-04'], ['2022-03-04', '2022-03-07'], ['2022-03-07', '2022-03-08']]);
  assert.deepStrictEqual(C.dayChunks('2022-03-01', '2022-03-02', 4), [['2022-03-01', '2022-03-02']]);
});

test('curatedSelect: inside the windows setup-focused practice decides; outside, a bar runs only to manage what is open', () => {
  const windows = [{ from: 1000, to: 2000 }];
  const select = () => ({ run: true, why: 'moment' });
  assert.strictEqual(C.curatedSelect({ windows, barClose: 1500, open: false, select }).why, 'moment');
  assert.strictEqual(C.curatedSelect({ windows, barClose: 2000, open: false, select }).why, 'moment', 'the window\'s last close is in it');
  assert.deepStrictEqual([C.curatedSelect({ windows, barClose: 1000, open: false, select }).run, C.curatedSelect({ windows, barClose: 2001, open: false, select }).run], [false, false]);
  assert.strictEqual(C.curatedSelect({ windows, barClose: 5000, open: true, select: () => ({ run: true, why: 'manage' }) }).why, 'manage');
});

test('pin: only a learning practice run of the document\'s role; a run keeps its list; the pinned copy is checked when loaded', () => {
  const dir = tmp();
  const file = C.writeLists(dir, C.buildLists(world(), { use: 'practice', total: 20, seed: 1 }));
  const curated = { file, list: 'mix', manageTailMin: 0, fingerprint: C.readLists(file).fingerprint };
  const home = tmp();
  assert.throws(() => C.pinCurated(home, curated), /no learning-run.json/);
  const run = o => fs.writeFileSync(path.join(home, 'learning-run.json'), JSON.stringify({ learning: true, role: 'practice-train', practice: { mode: 'setup-focus' }, ...o }));
  run({ learning: false });
  assert.throws(() => C.pinCurated(home, curated), /declared not learning/);
  run({ role: 'practice-validate' });
  assert.throws(() => C.pinCurated(home, curated), /runs on practice-train, not on this practice-validate run/);
  run({ practice: null });
  assert.throws(() => C.pinCurated(home, curated), /setup-focused practice/);
  run({});
  assert.strictEqual(C.loadPinnedCurated(home), null);
  const p = C.pinCurated(home, curated);
  const loaded = C.loadPinnedCurated(home);
  assert.deepStrictEqual([loaded.fingerprint, loaded.list, loaded.windows.length], [p.fingerprint, 'mix', 20]);
  assert.doesNotThrow(() => C.pinCurated(home, curated), 'a resume pins the same');
  assert.throws(() => C.pinCurated(home, { ...curated, list: 'chop' }), /a run keeps its list/);
  const other = C.writeLists(dir, C.buildLists(world(), { use: 'practice', total: 20, seed: 2 }));
  assert.throws(() => C.pinCurated(home, { ...curated, file: other }), /changed since the run's config read it/, 'the file is the list the config resolved');
  assert.throws(() => C.pinCurated(home, { ...curated, file: other, fingerprint: C.readLists(other).fingerprint }), /a run keeps its list/);
  // The run's copy holds the windows only: no moment, outcome or expected decision sits in the run home.
  const pinFile = fs.readFileSync(path.join(home, 'experience', 'curated-pinned.json'), 'utf8');
  assert.ok(!/outcome|expected|reads|"R"/.test(pinFile), pinFile.slice(0, 200));
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'experience')), ['curated-pinned.json']);
  const pinned = JSON.parse(pinFile);
  pinned.windows.pop();
  fs.writeFileSync(path.join(home, 'experience', 'curated-pinned.json'), JSON.stringify(pinned));
  assert.throws(() => C.loadPinnedCurated(home), /doesn't match its hash/);
});

/** A user home with a replay broker, and a curated list in practice-train. */
function curatedWorld() {
  const { resolveReplay } = require('../../scripts/lib/replay/config');
  const dir = tmp();
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL' } } }));
  const env = { PATH: process.env.PATH, HOME: dir, FTH_HOME: live, FTH_BROKERS_FILE: path.join(live, 'brokers.json') };
  const lists = (seed, day1 = '2022-03-01') => C.writeLists(path.join(dir, `lists-${seed}`), C.buildLists([moment({ id: 'a', day: day1, time: '15:00' }), moment({ id: 'b', day: '2022-03-03', time: '18:00', list: 'chop', expected: 'pass', result: 'no-room' })], { use: 'practice', total: 10, seed }));
  const raw = o => ({
    runId: 'c1', workDir: path.join(dir, 'replays'), broker: 'sim', start: '2022-03-01T00:00:00Z', end: '2022-03-05T00:00:00Z', premarket: false,
    autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York' },
    practice: { seed: 1 }, curatedList: { file: lists(1), list: 'mix', manageTailMin: 0 }, ...o,
  });
  return { dir, env, lists, raw, resolve: o => resolveReplay(raw(o), { baseDir: dir, env, home: dir, root: null }) };
}

test('setupHash: the curated list is part of the run\'s setup, by its fingerprint; refused without practice or outside the run', () => {
  const { setupHash } = require('../../scripts/lib/replay/config');
  const w = curatedWorld();
  const a = w.lists(1);
  const b = w.lists(1, '2022-03-02');
  const copy = path.join(w.dir, 'copy.json');
  fs.copyFileSync(a, copy);
  const h = o => setupHash(w.resolve(o));
  assert.strictEqual(h({ curatedList: { file: a } }), h({ curatedList: { file: copy } }), 'the same list under another path: the same setup');
  assert.notStrictEqual(h({ curatedList: { file: a } }), h({ curatedList: { file: b } }), 'another list: another setup');
  assert.notStrictEqual(h({ curatedList: { file: a } }), h({ curatedList: { file: a, list: 'chop' } }));
  assert.notStrictEqual(h({ curatedList: { file: a } }), h({ curatedList: undefined }));
  assert.notStrictEqual(h({ curatedList: { file: a } }), h({ curatedList: { file: a, manageTailMin: 30 } }));
  assert.strictEqual(w.resolve({ curatedList: { file: a } }).curated.fingerprint, C.readLists(a).fingerprint);
  // And the run's own hash (a resume under another list is another run).
  const { configHash } = require('../../scripts/lib/replay/config');
  require('../../scripts/lib/replay/driver').seedRunHome(w.resolve({}), { root: path.join(__dirname, '..', '..'), userEnv: w.env });
  const ch = o => configHash(w.resolve(o), w.env);
  assert.strictEqual(ch({ curatedList: { file: a } }), ch({ curatedList: { file: copy } }));
  assert.notStrictEqual(ch({ curatedList: { file: a } }), ch({ curatedList: { file: b } }));
  assert.notStrictEqual(ch({ curatedList: { file: a } }), ch({ curatedList: { file: a, list: 'chop' } }));
  assert.notStrictEqual(ch({ curatedList: { file: a } }), ch({ curatedList: { file: a, manageTailMin: 30 } }));
  assert.throws(() => w.resolve({ practice: undefined }), /curatedList: runs through setup-focused practice/);
  assert.throws(() => w.resolve({ start: '2022-03-02T00:00:00Z' }), /lie outside the run's/);
  // The run's market, every bar, and its sessions holding every window.
  const auto = w.raw({}).autotrader;
  assert.throws(() => w.resolve({ autotrader: { ...auto, symbols: ['MES'] } }), /its moments are MNQ; the run trades MES/);
  assert.throws(() => w.resolve({ practice: { seed: 1, setupTf: 60 } }), /15m setups, the run's practice.setupTf is 60/);
  assert.throws(() => w.resolve({ everyNthBar: 2 }), /every bar of its windows runs/);
  assert.throws(() => w.resolve({ autotrader: { ...auto, sessions: ['09:30-10:30@America/New_York'] } }), /window\(s\) hold no decision time of the run's sessions/);
});

test('a curated practice replay steps the list\'s windows, manages an open position bar by bar after one until flat, and pins the list', async () => {
  const { seedRunHome, runReplay } = require('../../scripts/lib/replay/driver');
  const { startLearningRun } = require('../../scripts/lib/learning/run-gate');
  const w = curatedWorld();
  const run = w.resolve({});
  seedRunHome(run, { root: path.join(__dirname, '..', '..'), userEnv: w.env });
  startLearningRun(run.paths.runHome, { from: run.start, to: run.end, runId: run.runId, practice: run.practice, runDir: run.paths.runDir, env: w.env });
  C.pinCurated(run.paths.runHome, run.curated);
  const steps = [];
  const deps = {
    serverCheck: async () => null,
    async step(point) {
      steps.push(`${point.kind}@${point.t.toISOString().slice(5, 16)}`);
      if (point.kind === 'eod') fs.writeFileSync(path.join(run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: true }));
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [] })}\n` };
    },
    async trades() { return []; },
    // A position opened in the first window stays open to 16:30; the account is flat after.
    async open(env) { opens.push(env.FTH_REPLAY_NOW.slice(5, 16)); return env.FTH_REPLAY_NOW <= '2022-03-01T16:30:59Z'; },
  };
  const opens = [];
  const res = await runReplay({ run, baseEnv: w.env, root: path.join(__dirname, '..', '..'), deps });
  assert.strictEqual(res.done, true);
  const trade = steps.filter(s => s.startsWith('trade@'));
  // Window a: 14:15 to 16:00 (its exit); window b: 17:15 to 19:00. Steps are the closes inside them.
  assert.strictEqual(trade[0], 'trade@03-01T14:30', 'the session opens after the window does');
  // After window a: managed every bar while open (16:03 to 16:30), then flat at 16:33 and skipped to end of day.
  assert.strictEqual(trade.filter(s => s.includes('03-01T')).at(-1), 'trade@03-01T16:30');
  assert.deepStrictEqual(opens.filter(t => t.startsWith('03-01')), ['03-01T16:03', '03-01T16:06', '03-01T16:09', '03-01T16:12', '03-01T16:15', '03-01T16:18', '03-01T16:21', '03-01T16:24', '03-01T16:27', '03-01T16:30', '03-01T16:33']);
  assert.deepStrictEqual(opens.filter(t => t.startsWith('03-03')), ['03-03T19:03'], 'flat after window b: one check');
  assert.strictEqual(trade.filter(s => s.includes('03-03T'))[0], 'trade@03-03T17:18');
  assert.strictEqual(trade.at(-1), 'trade@03-03T19:00');
  assert.ok(!steps.some(s => /03-0[24]T/.test(s)), 'days without a window are not stepped');
  assert.deepStrictEqual(steps.filter(s => s.startsWith('eod')), ['eod@03-01T20:50', 'eod@03-03T20:50']);
  assert.strictEqual(trade.length, 31 + 10 + 35, 'the closes 14:30 to 16:00, the managed 16:03 to 16:30, and 17:18 to 19:00');
  // The runner's practice selector reads the pinned list: inside a window practice decides, outside nothing runs.
  const { practiceSelector } = require('../../scripts/lib/runner-wiring');
  const select = practiceSelector(run.cfg, run.paths.runHome, { FTH_REPLAY_NOW: 'x' });
  const item = t => ({ symbol: 'MNQ', bar: { t }, minutes: 3 });
  assert.strictEqual(select(item('2022-03-01T15:00:00.000Z'), false).why, 'unavailable', 'inside: setup-focused practice (no briefing here: the bar runs)');
  assert.deepStrictEqual(select(item('2022-03-02T15:00:00.000Z'), false), { run: false, why: 'none', moment: null, reason: 'practice: outside the curated list\'s windows; the clock advances' });
  assert.strictEqual(select(item('2022-03-02T15:00:00.000Z'), true).why, 'manage');
});
