'use strict';

// experience_lookup (scripts/lib/harness-tools/experience.js) and its record (scripts/lib/learning/experience-lookups.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('../../scripts/lib/harness-tools/experience');
const L = require('../../scripts/lib/learning/experience-lookups');
const X = require('../../scripts/lib/learning/experience-index');
const { fromLifecycleRecord } = require('../../scripts/lib/learning/lifecycle-record');
const { BY_NAME, listTools } = require('../../scripts/lib/harness-tools/registry');
const { validate } = require('../../scripts/lib/harness-tools/validate');
const { record, tmpHome } = require('../fixtures/learning');

const AT = '2023-03-15T14:00:00.000Z';
const NOW = () => new Date('2023-03-15T14:01:00.000Z');

/** A home with one verified record at AT, and (pin) an index built from `n` past decisions of the same combination. */
function home({ pin = true, n = 24, records = [record({ at: AT })], transcript = true, excursion = () => null, curated = () => false } = {}) {
  const h = tmpHome();
  fs.mkdirSync(path.join(h, 'trade-lifecycle'));
  fs.writeFileSync(path.join(h, 'trade-lifecycle', 'MNQ.jsonl'), records.map(r => `${JSON.stringify(r)}\n`).join(''));
  if (pin) {
    const r = fromLifecycleRecord(record({ at: AT }));
    const days = Array.from({ length: 12 }, (_, i) => `2022-03-${String(i + 1).padStart(2, '0')}`);
    const past = Array.from({ length: n }, (_, i) => ({
      id: `p${i}`, day: days[i % 12], decision: i % 2 ? 'entered' : 'passed', side: 'long', signatures: r.signatures, reads: r.reads,
      context: i % 3 ? r.context : { ...r.context, regime: 'range' }, outcome: { R: i % 2 ? 2 : -1, ...(excursion(i) || {}) }, grade: i % 2 ? 'win' : 'good-pass', ...(curated(i) ? { curated: true, weight: curated(i) === true ? null : curated(i) } : {}),
    }));
    const file = X.writeIndex(path.join(h, 'built'), X.buildIndex(past, { reps: 200 }));
    X.pinIndex(h, file);
  }
  const env = { FTH_HOME: h, ...(transcript ? { FTH_CYCLE_TRANSCRIPT: path.join(h, 'cycle.jsonl') } : {}) };
  return { h, env, ctx: { env, now: NOW, wallNow: () => 1000 } };
}

test('experience_lookup: the candidate\'s signatures and context, its cells exact first, similar decisions, the index; under 4 KB', () => {
  const { ctx, env } = home();
  const { text } = H.experienceLookup({ symbol: 'MNQ', role: 'risk-manager' }, ctx);
  const lines = text.split('\n');
  assert.match(lines[0], /^Experience for MNQ long, bar 2023-03-15T13:57:00.000Z:/);
  assert.match(text, /skill signature: bias:bos-vs-choch\+location:vwap-volume-profile/);
  assert.match(text, /context: regime=trend-up;volatility=normal;window=ny-am;biasSide=with;alignment=aligned;dayType=normal/);
  const cells = lines.filter(l => l.startsWith('- ') && /signature|alternative/.test(l));
  assert.match(cells[0], /^- read signature, this context: too few samples \(n=16, 8 days\)/);
  assert.match(cells.find(l => l.includes('skill signature, any context')), /n 24 \(12 days; 12 entered, 12 passed\), win 0\.50 \[0\.\d+, 0\.\d+\], mean R 0\.50 \[/);
  assert.match(text, /Similar past decisions \(same skills, closest context\):\n- 2022-03-12 long entered, 2\.00R win: bias 1h bos up \(broke the last swing\)/);
  assert.strictEqual(lines.filter(l => /^- 2022-/.test(l)).length, 3);
  assert.match(text, /Index [0-9a-f]{16}: practice-train days before 2023-03-15 only; 90% intervals, each cell one of many/);
  assert.ok(Buffer.byteLength(text) <= H.MAX_BYTES);
  assert.doesNotMatch(text, /\b(should|enter|take it|avoid)\b/i, 'it never says what to do');
  // Recorded: who asked, the record and the index.
  const rec = L.readExperienceLookups(env.FTH_CYCLE_TRANSCRIPT);
  assert.deepStrictEqual(rec.map(r => [r.at, r.role, r.root, r.bar, r.side]), [[1000, 'risk-manager', 'MNQ', '2023-03-15T13:57:00.000Z', 'long']]);
  assert.match(rec[0].index, /^[0-9a-f]{64}$/);
});

test('experience_lookup: an alternative swaps one step\'s skill; at most two; a step the candidate lacks is refused', () => {
  const { ctx } = home();
  const { text } = H.experienceLookup({ symbol: 'MNQ', alternative: [{ step: 'setup', skill: 'breakout-vs-fakeout' }] }, ctx);
  assert.match(text, /- alternative setup:breakout-vs-fakeout, any context: no record/);
  assert.strictEqual(H.swapStep('bias:a,b+setup:c', 'setup', 'd'), 'bias:a,b+setup:d');
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ', alternative: [{ step: 'exit', skill: 'x' }] }, ctx), /no step "exit"/);
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ', alternative: [1, 2, 3] }, ctx), /at most two/);
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ', alternative: [{ step: 'setup', skill: '../x' }] }, ctx), /alternative: \{ step, skill \}/);
});

test('experience_lookup: two calls a bar, the third refused; a new bar starts again; outside a cycle no budget and no record', () => {
  const { ctx, env } = home();
  H.experienceLookup({ symbol: 'MNQ' }, ctx);
  H.experienceLookup({ symbol: 'MNQ' }, ctx);
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ' }, ctx), /2 calls on this bar already/);
  assert.strictEqual(L.callsOnBar(env, 'MNQ', '2023-03-15T13:57:00.000Z'), 2);
  const next = home({ records: [record({ at: AT }), record({ at: '2023-03-15T14:03:00.000Z' })] });
  fs.copyFileSync(env.FTH_CYCLE_TRANSCRIPT + '.experience.jsonl', next.env.FTH_CYCLE_TRANSCRIPT + '.experience.jsonl');
  assert.ok(H.experienceLookup({ symbol: 'MNQ' }, { ...next.ctx, now: () => new Date('2023-03-15T14:04:00.000Z') }).text);
  const loose = home({ transcript: false });
  for (let i = 0; i < 3; i += 1) H.experienceLookup({ symbol: 'MNQ' }, loose.ctx);
  assert.strictEqual(L.recordExperienceLookup({}, { root: 'MNQ' }), false);
  assert.strictEqual(L.reserveLookup({}, { root: 'MNQ', bar: 'b' }), true, 'outside a cycle: nothing counted');
});

test('the budget is counted and recorded under a lock: a held lock is waited on, then refused, never broken', () => {
  const { env } = home({ pin: false });
  const lock = `${L.lookupsFile(env.FTH_CYCLE_TRANSCRIPT)}.lock`;
  fs.writeFileSync(lock, '');
  const t0 = Date.now();
  assert.throws(() => L.reserveLookup(env, { root: 'MNQ', bar: 'b' }), /its record is locked/);
  assert.ok(Date.now() - t0 >= 1500, 'waited for it');
  assert.ok(fs.existsSync(lock), 'never broken');
  fs.rmSync(lock);
  assert.deepStrictEqual([L.reserveLookup(env, { root: 'MNQ', bar: 'b' }), L.reserveLookup(env, { root: 'MNQ', bar: 'b' }), L.reserveLookup(env, { root: 'MNQ', bar: 'b' })], [true, true, false]);
  assert.ok(!fs.existsSync(lock), 'released');
  assert.strictEqual(L.readExperienceLookups(env.FTH_CYCLE_TRANSCRIPT).length, 2);
});

test('walk-forward: the record shown is only from days before the candidate bar\'s session, never its own day or later', () => {
  const h = tmpHome();
  const bar = '2022-03-10T15:00:00.000Z';
  const rec = record({ at: '2022-03-10T15:03:00.000Z' });
  rec.bar = bar;
  fs.mkdirSync(path.join(h, 'trade-lifecycle'));
  fs.writeFileSync(path.join(h, 'trade-lifecycle', 'MNQ.jsonl'), `${JSON.stringify(rec)}\n`);
  const r = fromLifecycleRecord(rec);
  const days = ['2022-02-01', '2022-02-02', '2022-02-03', '2022-02-04', '2022-02-07', '2022-02-08', '2022-02-09', '2022-02-10', '2022-02-11', '2022-02-14', '2022-02-15'];
  const past = Array.from({ length: 22 }, (_, i) => ({ id: `p${i}`, bar: `${days[i % 11]}T15:00:00.000Z`, decision: 'passed', side: 'long', signatures: r.signatures, reads: r.reads, context: r.context, outcome: { R: -1 }, grade: 'good-pass' }));
  const sameDay = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, bar: bar, decision: 'entered', side: 'long', signatures: r.signatures, reads: r.reads, context: r.context, outcome: { R: 3 }, grade: 'win' }));
  const future = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, bar: `2023-0${1 + (i % 9)}-1${i % 7}T15:00:00.000Z`, decision: 'entered', side: 'long', signatures: r.signatures, reads: r.reads, context: r.context, outcome: { R: 5 }, grade: 'win' }));
  X.pinIndex(h, X.writeIndex(path.join(h, 'built'), X.buildIndex([...past, ...sameDay, ...future], { reps: 100 })));
  const { text } = H.experienceLookup({ symbol: 'MNQ' }, { env: { FTH_HOME: h }, now: () => new Date('2022-03-10T15:04:00.000Z') });
  assert.match(text, /skill signature, any context: n 22 \(11 days; 0 entered, 22 passed\), win 0\.00 .*mean R -1\.00/);
  assert.doesNotMatch(text, /2022-03-10 long|2023-|5\.00R|3\.00R/, 'nothing of its own day or later');
  assert.match(text, /days before 2022-03-10 only/);
});

test('experience_lookup: a long run\'s record (thousands of records over hundreds of days) is read only near the clock', () => {
  const TL = require('../../scripts/lib/trading/trade-lifecycle');
  const { h, ctx } = home({ records: [] });
  fs.rmSync(path.join(h, 'trade-lifecycle', 'MNQ.jsonl'));
  // 3,000 verified records, 10 a day over 300 days before the candidate's.
  const start = Date.parse('2022-05-02T14:00:00.000Z');
  for (let d = 0; d < 300; d += 1) {
    for (let i = 0; i < 10; i += 1) TL.appendRecord(h, record({ at: new Date(start + d * 86400000 + i * 600000).toISOString() }));
  }
  TL.appendRecord(h, record({ at: AT }));
  // Every shard but the clock's days (before, of, after) over the cap: a read of any of them would throw.
  const near = TL.daysNear(NOW());
  const days = fs.readdirSync(path.join(h, 'trade-lifecycle', 'MNQ')).map(n => n.slice(0, 10)).filter(d => !near.includes(d));
  assert.ok(days.length >= 200, `${days.length} shards`);
  for (const d of days) fs.truncateSync(TL.recordFile(h, 'MNQ', d), TL.MAX_BYTES + 1);
  const { text } = H.experienceLookup({ symbol: 'MNQ', role: 'risk-manager' }, ctx);
  assert.match(text, /^Experience for MNQ long, bar 2023-03-15T13:57:00.000Z:/);
  // The clock's own day unreadable: the lookup says so, never answers on no record.
  fs.rmSync(TL.recordFile(h, 'MNQ', '2023-03-15'));
  fs.mkdirSync(TL.recordFile(h, 'MNQ', '2023-03-15'));
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ' }, ctx), /can't be read \(EISDIR\)/);
});

test('experience_lookup: no verified unexpired record is refused (nothing recorded); no pinned index says no record', () => {
  const stale = home({ records: [record({ at: AT })] });
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ' }, { ...stale.ctx, now: () => new Date('2023-03-15T14:03:00.000Z') }), /no verified trade_lifecycle record for MNQ/);
  const unverified = home({ records: [record({ at: AT, ok: false })] });
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ' }, unverified.ctx), /call it first/);
  assert.throws(() => H.experienceLookup({ symbol: 'MES' }, unverified.ctx), /no verified/);
  assert.deepStrictEqual(L.readExperienceLookups(unverified.env.FTH_CYCLE_TRANSCRIPT), []);
  const bare = home({ pin: false });
  assert.match(H.experienceLookup({ symbol: 'MNQ' }, bare.ctx).text, /No experience index is pinned for this run: no record\.\n$/);
  assert.throws(() => H.experienceLookup({ symbol: 'mnq' }, bare.ctx), /--symbol/);
  assert.throws(() => H.experienceLookup({ symbol: 'MNQ', role: 'Bad Role' }, bare.ctx), /--role/);
});

test('experience_lookup: the output is capped at 4 KB, dropping whole lines', () => {
  const long = record({ at: AT });
  long.reads = long.reads.map(r => ({ ...r, why: 'w'.repeat(160) }));
  const { ctx } = home({ records: [long] });
  const { text } = H.experienceLookup({ symbol: 'MNQ', alternative: [{ step: 'setup', skill: 'a' }, { step: 'entry', skill: 'b' }] }, ctx);
  assert.ok(Buffer.byteLength(text) <= 4096, String(Buffer.byteLength(text)));
  assert.match(text, /Index [0-9a-f]{16}/, 'the index line is kept');
});

test('the tool: schema, arguments, a short description (its listing under 1 KB), and the CLI', () => {
  const tool = BY_NAME.get('experience_lookup');
  assert.deepStrictEqual(validate(tool.inputSchema, { symbol: 'MNQ', alternative: [{ step: 'setup', skill: 'rejection' }], role: 'risk-manager' }), []);
  assert.match(validate(tool.inputSchema, {}).join(), /symbol/);
  assert.match(validate(tool.inputSchema, { symbol: 'MNQ', alternative: [{ step: 'setup', skill: 'x', extra: 1 }] }).join(), /unknown argument/);
  assert.match(validate(tool.inputSchema, { symbol: 'MNQ', alternative: [{}, {}, {}] }).join(), /at most 2/);
  assert.deepStrictEqual(tool.args({ symbol: 'MNQ' }), { symbol: 'MNQ', alternative: [] });
  const listing = listTools().find(t => t.name === 'experience_lookup');
  assert.ok(Buffer.byteLength(JSON.stringify(listing)) < 1024, 'the tool listing stays under 1 KB');
  assert.deepStrictEqual(H.parseArgv(['--symbol', 'MNQ', '--alternative', 'setup:rejection', '--role=risk-manager']), { symbol: 'MNQ', alternative: [{ step: 'setup', skill: 'rejection' }], role: 'risk-manager' });
  assert.throws(() => H.parseArgv(['--symbol']), /give its value/);
  assert.throws(() => H.parseArgv(['--x']), /unknown argument/);
  const { env } = home({ pin: false, transcript: false });
  // The CLI at the real clock: the 2023 record has expired, so it is refused, nothing printed but the reason.
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'experience-lookup.js'), '--symbol', 'MNQ'], { encoding: 'utf8', env: { ...process.env, FTH_REPLAY_NOW: '', ...env } });
  assert.strictEqual(cli.status, 1);
  assert.match(cli.stderr, /^\[experience-lookup\] no verified trade_lifecycle record for MNQ/);
});

test('experience_lookup: each cell with enough samples shows its median MAE and MFE in R and n; too few, so said; the sign once; past decisions their own', () => {
  // Winners ran clean (MAE -0.25R, MFE 2R), the passes that would have lost went deep (MAE -1.05R, MFE 0.5R).
  const { ctx } = home({ excursion: i => (i % 2 ? { maeR: -0.25, mfeR: 2 } : { maeR: -1.05, mfeR: 0.5 }) });
  const { text } = H.experienceLookup({ symbol: 'MNQ' }, ctx);
  const any = text.split('\n').find(l => l.startsWith('- skill signature, any context:'));
  assert.match(any, /mean R 0\.50 \[-?\d\.\d\d, \d\.\d\d\], MAE -0\.25 MFE 2\.00 \(n 24\), last 2022-03-12$/);
  assert.match(text, /per statistic; MAE <= 0 worst against, MFE >= 0 best for, while held \(R\)\.\n/, 'the sign, once');
  assert.match(text, /- read signature, this context: too few samples \(n=16, 8 days\)\n/, 'a cell under the minimum: no median');
  assert.match(text, /- 2022-03-12 long entered, 2\.00R win, MAE -0\.25 MFE 2\.00: bias 1h/);
  assert.match(text, /- 2022-03-11 long passed, -1\.00R good-pass, MAE -1\.05 MFE 0\.50: /);
  assert.ok(Buffer.byteLength(text) <= H.MAX_BYTES);
  assert.doesNotMatch(text, /\b(should|enter|take it|avoid)\b/i, 'it never says what to do');
  // Enough decisions, fewer than the minimum with an excursion (lines written before they were recorded): insufficient.
  const { ctx: c2 } = home({ excursion: i => (i < X.MIN_N - 1 ? { maeR: -0.5, mfeR: 1 } : null) });
  const t2 = H.experienceLookup({ symbol: 'MNQ' }, c2).text;
  assert.match(t2, /- skill signature, any context: n 24 .*, MAE\/MFE too few \(n 19\), last 2022-03-12/);
  // None at all: no median, no excursion on a past decision, never invented.
  const t3 = H.experienceLookup({ symbol: 'MNQ' }, home().ctx).text;
  assert.match(t3, /MAE\/MFE too few \(n 0\)/);
  assert.doesNotMatch(t3, /, MAE -/);
});

test('experience_lookup: curated runs\' decisions weighted to natural rates: each cell its effective n, unrated ones named, one line saying so', () => {
  const plain = H.experienceLookup({ symbol: 'MNQ' }, home().ctx).text;
  assert.doesNotMatch(plain, /curated|n_eff/, 'no curated decision: no label');
  // The 12 winners curated, each weighing 0.6 (a list whose natural win share is below its built one): win 7.2 / 19.2.
  const { text } = H.experienceLookup({ symbol: 'MNQ' }, home({ curated: i => (i % 2 === 1 ? 0.6 : false) }).ctx);
  assert.match(text, /- skill signature, any context: n 24 \(12 days; 12 entered, 12 passed; n_eff 22\.\d\), win 0\.38 \[/);
  assert.match(text, /- 2022-03-12 long entered \(curated\), 2\.00R win: /);
  assert.match(text, /- 2022-03-11 long passed, -1\.00R good-pass: /);
  assert.match(text, /\nn_eff: curated runs reweighted to natural rates; unrated: not weighable, never rated\.\n/);
  assert.ok(Buffer.byteLength(text) <= H.MAX_BYTES);
  // Without a weight (no document with the candidates' outcomes): counted, never rated; too few rated, no rate.
  const un = H.experienceLookup({ symbol: 'MNQ' }, home({ curated: i => i % 2 === 1 }).ctx).text;
  assert.match(un, /- skill signature, any context: too few samples \(n=24, n_eff 12\.0, 6 days\)/);
  assert.match(un, /\nn_eff: curated runs reweighted/);
});

/** A mature index: 85 decisions over 30 days for the candidate's skills and for two alternatives, every cell enough. */
function matureHome({ curated = false } = {}) {
  const h = tmpHome();
  fs.mkdirSync(path.join(h, 'trade-lifecycle'));
  fs.writeFileSync(path.join(h, 'trade-lifecycle', 'MNQ.jsonl'), `${JSON.stringify(record({ at: AT }))}\n`);
  const r = fromLifecycleRecord(record({ at: AT }));
  const days = [];
  for (let t = Date.parse('2022-03-01T00:00:00Z'); days.length < 30; t += 86400000) if (![0, 6].includes(new Date(t).getUTCDay())) days.push(new Date(t).toISOString().slice(0, 10));
  const sigs = [r.signatures, ...ALTS.map(a => ({ ...r.signatures, skill: H.swapStep(r.signatures.skill, a.step, a.skill) }))];
  const past = sigs.flatMap((sg, k) => Array.from({ length: 85 }, (_, i) => ({
    id: `p${k}-${i}`, day: days[i % 30], decision: i % 2 ? 'entered' : 'passed', side: 'long', signatures: sg, reads: r.reads, context: r.context,
    outcome: { R: i % 2 ? 2 : -1, maeR: i % 2 ? -0.25 : -1.05, mfeR: i % 2 ? 2 : 0.5 }, grade: i % 2 ? 'win' : 'good-pass',
    ...(curated && i % 3 === 0 ? { curated: true, weight: 0.8 } : {}),
  })));
  X.pinIndex(h, X.writeIndex(path.join(h, 'built'), X.buildIndex(past, { reps: 200 })));
  return { env: { FTH_HOME: h }, now: NOW };
}
const ALTS = [{ step: 'setup', skill: 'breakout-vs-fakeout' }, { step: 'entry', skill: 'momentum' }];

test('experience_lookup under the cap: a mature index (every cell enough, two recorded alternatives) still shows all its similar past decisions', () => {
  for (const curated of [false, true]) {
    const { text } = H.experienceLookup({ symbol: 'MNQ', alternative: ALTS }, matureHome({ curated }));
    const lines = text.split('\n');
    assert.ok(Buffer.byteLength(text) <= H.MAX_BYTES, `${Buffer.byteLength(text)} bytes`);
    const cells = lines.filter(l => /^- (read|skill) signature|^- alternative/.test(l));
    assert.strictEqual(cells.length, 14, 'every cell kept');
    assert.ok(cells.every(l => / MAE -1\.05 MFE 0\.50 \(n \d+\), last /.test(l)), 'each with its MAE and MFE');
    assert.ok(lines.includes('Similar past decisions (same skills, closest context):'), curated ? 'curated' : 'plain');
    assert.strictEqual(lines.filter(l => /^- 2022-/.test(l)).length, 3, `all three examples (curated: ${curated})`);
    assert.match(text, /MAE <= 0 worst against, MFE >= 0 best for/);
  }
});

test('capped: the least specific evidence goes first: library, then examples down to the closest, then cells from the end; never the two "this context" cells', () => {
  const { capped, MAX_BYTES } = require('../../scripts/lib/harness-tools/experience');
  const fill = (tag, n) => Array.from({ length: n }, (_, i) => `- ${tag} ${i} ${'x'.repeat(300)}`);
  const cells = ['- read signature, this context: n 30', '- skill signature, this context: n 30', ...fill('cell', 8)];
  const similar = ['Similar past decisions (same skills, closest context):', ...fill('example', 3)];
  const library = ['History library (code-measured):', ...fill('library', 4)];
  const text = capped(['Your record:'], cells.slice(), similar.slice(), ['tail'], library.slice(), []);
  assert.ok(Buffer.byteLength(text) <= MAX_BYTES);
  // Library lines go before any example: here dropping library lines alone makes it fit, so every example stays.
  assert.doesNotMatch(text, /library 3/);
  for (const k of ['example 0', 'example 1', 'example 2', 'read signature, this context', 'skill signature, this context']) assert.match(text, new RegExp(k));
  // Over the cap with no library: examples down to the closest one, then cells from the end; "this context" cells stay.
  const tight = capped(['Your record:'], [...cells.slice(0, 2), ...fill('cell', 14)], similar.slice(), ['tail'], [], []);
  assert.ok(Buffer.byteLength(tight) <= MAX_BYTES);
  assert.match(tight, /example 0/);
  assert.doesNotMatch(tight, /example 2/);
  assert.match(tight, /cell 0 /);
  assert.doesNotMatch(tight, /cell 13 /);
  assert.match(tight, /skill signature, this context/);
});
