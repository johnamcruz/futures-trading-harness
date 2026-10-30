'use strict';

// The curated lists' moments (scripts/lib/learning/curated-moments.js): the scan's splits, its parity with the history
// library's walk, the trend classification and the lists, every read true at its bar and mapped through the
// trade-lifecycle crosswalk, and causality (only facts known at the bar). On the parity MNQ bars moved back 312 weeks
// into practice-train (and 230 weeks into practice-validate).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../fixtures/golden-bars');
const L = require('../../scripts/lib/learning/setup-library');
const M = require('../../scripts/lib/learning/curated-moments');
const { buildBriefing } = require('../../scripts/lib/trading/briefing');
const { checkReads, parseRead } = require('../../scripts/lib/trading/composed-reads');

const WEEK = 7 * 86400000;
const shifted = weeks => G.load(G.SERIES[0]).map(({ t, o, h, l, c, v }) => ({ t: new Date(Date.parse(t) - weeks * WEEK).toISOString(), o, h, l, c, v }));
const BARS = shifted(312);
const CLOCK = L.runnerClock({ from: '2020-04-01', to: '2020-06-01' });
const WINDOW = 700;
const OPTS = { root: 'MNQ', minutes: 3, tick: 0.25, from: '2020-05-01', to: '2020-05-02', eodOf: CLOCK.eodOf, inSession: CLOCK.inSession, validBars: 2 };
const scan = (bars = BARS, over = {}) => M.scanMoments({ bars, use: 'practice', windowBars: WINDOW, ...OPTS, ...over });
const MOMENTS = scan();
const briefAt = (bars, t) => {
  const i = bars.findIndex(b => b.t === t);
  return buildBriefing({ symbol: 'MNQ', bars: bars.slice(Math.max(0, i - WINDOW + 1), i + 1), minutes: 3, now: new Date(Date.parse(t) + 180000) });
};

test('splits: a training scan is practice-train only, a validation scan practice-validate only; test, final and other uses are refused', () => {
  for (const [use, from, to, why] of [
    ['practice', '2024-08-01', '2024-09-01', /practice refused: .*practice-validate/], ['practice', '2024-06-20', '2024-07-10', /practice refused/],
    ['practice', '2025-02-01', '2025-03-01', /sealed/], ['practice', '2026-03-01', '2026-04-01', /sealed/],
    ['validate', '2022-03-01', '2022-04-01', /validate refused: .*practice-train/], ['validate', '2025-02-01', '2025-03-01', /validate refused: .*test/],
    ['test', '2025-02-01', '2025-03-01', /use test refused/], ['final', '2026-03-01', '2026-04-01', /use final refused/],
    ['index', '2022-03-01', '2022-04-01', /use index refused/], [undefined, '2022-03-01', '2022-04-01', /use undefined refused/],
  ]) assert.throws(() => M.scanMoments({ ...OPTS, bars: BARS, use, from, to }), why, `${use} ${from}..${to}`);
  // The same bars moved into practice-validate scan as validate moments.
  const vbars = shifted(82);
  const vclock = L.runnerClock({ from: '2024-11-01', to: '2024-12-01' });
  const day = vbars[1000].t.slice(0, 10);
  const v = M.scanMoments({ ...OPTS, bars: vbars, use: 'validate', from: day, to: new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), eodOf: vclock.eodOf, inSession: vclock.inSession, windowBars: WINDOW });
  assert.ok(v.length > 5 && v.every(m => m.use === 'validate' && m.day >= '2024-07-01' && m.day < '2025-01-01'), `validate moments: ${v.length}`);
});

test('the library\'s walk: with the library\'s window every moment is its record (the bar, the standard\'s status, plan and R)', () => {
  const lib = L.scanLibrary({ bars: BARS, ...OPTS });
  assert.ok(lib.length > 20, `records: ${lib.length}`);
  // The standard's limit window is the library's: the strategy's valid_bars, required, kept on each moment.
  assert.ok(MOMENTS.every(m => m.validBars === 2));
  assert.throws(() => M.scanMoments({ ...OPTS, bars: BARS, use: 'practice', validBars: undefined }), /validBars: the trade_lifecycle strategy's valid_bars/);
  assert.deepStrictEqual(MOMENTS.map(m => m.id), lib.map(r => r.id));
  for (const [k, r] of lib.entries()) {
    const m = MOMENTS[k];
    assert.deepStrictEqual([m.bar, m.standard.status, m.side, m.reaction], [r.bar, r.status, r.side, r.reaction], r.id);
    if (r.status === 'traded') {
      assert.deepStrictEqual(m.standard.plan, { entry: r.plan.entry, stop: r.plan.stop, target: r.plan.target, rr: r.plan.rr });
      assert.strictEqual(m.outcome.R, r.outcome.filled ? r.outcome.R : null);
      assert.strictEqual(m.outcome.result, !r.outcome.filled ? 'unfilled' : r.outcome.R > 0 ? 'win' : r.outcome.R < 0 ? 'loss' : 'scratch');
    } else {
      assert.strictEqual(m.outcome.result, r.status);
    }
  }
  assert.ok(new Set(MOMENTS.map(m => m.outcome.result)).size >= 3, 'several outcomes on the fixture');
});

test('reads: every read is true by compose_check\'s checker at the moment\'s bar, and its skill is the crosswalk\'s for its kind', () => {
  let n = 0;
  for (const m of MOMENTS) {
    const b = briefAt(BARS, m.bar);
    assert.ok(m.reads.length >= 5, `${m.id}: ${m.reads.length} reads`);
    for (const step of ['bias', 'location', 'setup', 'entry', 'stop', 'target']) {
      const reads = m.reads.filter(r => r.step === step).map(({ step: s, skill, read }) => ({ step: s, skill, read }));
      if (!reads.length) continue;
      const ch = checkReads({ reads, side: m.side, briefing: b, tick: 0.25 });
      assert.ok(ch.reads.every(r => r.check === true), `${m.id} ${step}: ${ch.reads.filter(r => r.check !== true).map(r => `${r.read}: ${r.fact}`).join('; ')}`);
      assert.deepStrictEqual(ch.reads.map(r => r.agrees === true), m.reads.filter(r => r.step === step).map(r => r.agrees));
      n += reads.length;
    }
    for (const r of m.reads) assert.strictEqual(r.skill, M.skillOfRead(r.step, r.read));
    const shape = m.shape ? ['pullback-vs-reversal'] : [];
    assert.deepStrictEqual(m.skills, [...new Set([...m.reads.map(r => r.skill), ...shape])].sort());
    assert.deepStrictEqual(m.aligned, [...new Set([...m.reads.filter(r => r.agrees).map(r => r.skill), ...shape])].sort());
    assert.deepStrictEqual([m.minutes, m.setupTf], [3, 15]);
    // The reaction itself is always among the reads, and a traded moment carries the standard's stop and target.
    assert.ok(m.reads.some(r => r.step === 'setup' && parseRead(r.read).kind === 'relation' && r.agrees), m.id);
    if (m.standard.status === 'traded') assert.ok(['stop', 'target'].every(s => m.reads.some(r => r.step === s)), m.id);
  }
  assert.ok(n > 300, `reads checked: ${n}`);
  const all = new Set(MOMENTS.flatMap(m => m.skills));
  assert.ok(all.size >= 10, `skills exercised on the fixture day: ${[...all].join(', ')}`);
});

test('the crosswalk: every skill a read maps to is in its step\'s row of the trade-lifecycle skill\'s table', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'trade-lifecycle', 'SKILL.md'), 'utf8');
  for (const [step, kinds] of Object.entries(M.READ_SKILL)) {
    const row = md.split('\n').find(l => new RegExp(`^\\s*\\| ${step} \\|`).test(l));
    assert.ok(row, `the crosswalk has a ${step} row`);
    const skills = (row.split('|')[3].match(/`([a-z0-9-]+)`/g) || []).map(s => s.slice(1, -1));
    for (const [kind, skill] of Object.entries(kinds)) assert.ok(skills.includes(skill), `${step} ${kind}: ${skill} is not in the crosswalk's ${step} row (${skills.join(', ')})`);
  }
  assert.strictEqual(M.skillOfRead('location', 'at 15m fvg'), 'fair-value-gaps');
  assert.strictEqual(M.skillOfRead('location', 'at prior vah'), 'levels-and-reactions');
  assert.strictEqual(M.skillOfRead('setup', '15m rejected 15m fvg low up'), 'fair-value-gaps');
  assert.strictEqual(M.skillOfRead('setup', '15m broke ib high up'), 'breakout');
  assert.strictEqual(M.skillOfRead('setup', '15m touched ib high'), null, 'a touch maps to no skill and is not stated');
  assert.strictEqual(M.skillOfRead('entry', '3m pattern hammer'), 'candle-reading');
  // The library's bias label is the crosswalk's multi-timeframe-analysis; no moment carries the library's own label.
  assert.strictEqual(M.normalSkill('mtf-bias-filter'), 'multi-timeframe-analysis');
  assert.strictEqual(M.normalSkill('rejection'), 'rejection');
  assert.ok(MOMENTS.every(m => !m.skills.includes('mtf-bias-filter')));
  assert.ok(MOMENTS.filter(m => m.standard.status === 'traded').every(m => m.reads.some(r => r.step === 'bias' && r.skill === 'multi-timeframe-analysis')), 'the standard\'s bias read counts as multi-timeframe-analysis');
  // pullback-vs-reversal: in the setup row, counted from the reads when they show one exactly.
  const row = md.split('\n').find(l => /^\s*\| setup \|/.test(l));
  assert.ok(row.includes('`pullback-vs-reversal`'));
});

const B = ({ h1 = 'up', h4 = 'up', b1 = ['BOS', 'up'], b15 = ['BOS', 'up'], regime = 'trend-up' } = {}) => ({
  sections: {
    h1: { data: { h1: { trend: h1 }, h4: { trend: h4 }, lastBreak: { last: b1 ? { kind: b1[0], direction: b1[1] } : null } } },
    m15: { data: { lastBreak: { last: b15 ? { kind: b15[0], direction: b15[1] } : null } } },
    m3: { data: { regime: { primary: regime } } },
  },
});

test('pullback-vs-reversal: a reversal is a true CHoCH the side\'s way; a pullback a trend read, the pullback alignment and a rejection, all the side\'s way', () => {
  const r = (step, read, agrees = true) => ({ step, skill: 'x', read, agrees });
  const pull = [r('bias', '1h up'), r('bias', 'read long pullback'), r('setup', '15m rejected prior vah up')];
  assert.strictEqual(M.shapeOf(pull, 'long'), 'pullback');
  assert.strictEqual(M.shapeOf(pull.slice(1), 'long'), null, 'no trend read');
  assert.strictEqual(M.shapeOf([pull[0], pull[2]], 'long'), null, 'no counter-move (the pullback alignment)');
  assert.strictEqual(M.shapeOf([pull[0], pull[1], r('setup', '15m broke prior vah up')], 'long'), null, 'a breakout is no pullback');
  assert.strictEqual(M.shapeOf([r('bias', '1h up', false), pull[1], pull[2]], 'long'), null, 'a trend read against the side');
  assert.strictEqual(M.shapeOf([r('bias', '15m choch down')], 'short'), 'reversal');
  assert.strictEqual(M.shapeOf([r('bias', '15m choch down', false)], 'long'), null);
  assert.strictEqual(M.shapeOf([r('bias', '15m bos down')], 'short'), null);
  assert.strictEqual(M.shapeOf([r('bias', '15m choch up')], 'short'), null, 'a CHoCH the other way (excused by D2 in the checker) is no reversal of this side');
  for (const m of MOMENTS) {
    assert.strictEqual(m.shape, M.shapeOf(m.reads, m.side), m.id);
    assert.strictEqual(m.skills.includes('pullback-vs-reversal'), Boolean(m.shape), m.id);
  }
  assert.ok(MOMENTS.some(m => m.shape === 'reversal'), 'the fixture day has a reversal');
});

test('classify: a clear trend needs the 1h and 4h with it, the 1h structure holding, no 15m CHoCH against, not a range regime', () => {
  assert.deepStrictEqual([M.classify(B()).state, M.classify(B()).trend], ['clear', 'up']);
  const down = B({ h1: 'down', h4: 'down', b1: ['CHoCH', 'down'], b15: ['BOS', 'down'], regime: 'transition' });
  assert.deepStrictEqual([M.classify(down).state, M.classify(down).trend], ['clear', 'down']);
  // Each condition, broken alone.
  assert.strictEqual(M.classify(B({ h4: 'range' })).state, 'chop', 'the 4h in a range');
  assert.strictEqual(M.classify(B({ h4: 'down' })).state, 'mixed', 'the 4h against the 1h');
  assert.strictEqual(M.classify(B({ h1: 'range' })).state, 'chop');
  assert.strictEqual(M.classify(B({ b1: ['BOS', 'down'] })).state, 'mixed', 'the 1h structure broke down without a CHoCH: not holding');
  assert.strictEqual(M.classify(B({ b1: null })).state, 'mixed', 'no 1h break: not holding');
  assert.strictEqual(M.classify(B({ regime: 'range' })).state, 'chop');
  // A CHoCH against the trend: the trend ending.
  assert.deepStrictEqual([M.classify(B({ b15: ['CHoCH', 'down'] })).state, M.classify(B({ b15: ['CHoCH', 'down'] })).trend], ['trend-end', 'up']);
  assert.strictEqual(M.classify(B({ b1: ['CHoCH', 'down'] })).state, 'trend-end');
  assert.strictEqual(M.classify(B({ h1: 'range', b1: ['CHoCH', 'down'] })).state, 'trend-end', 'the 1h gone flat on its CHoCH');
  assert.strictEqual(M.classify(B({ h1: 'down', b1: ['CHoCH', 'down'] })).state, 'mixed', 'the 1h already against the 4h');
  assert.strictEqual(M.classify(B({ b15: ['CHoCH', 'up'] })).state, 'clear', 'a CHoCH with the trend is no end');
  assert.strictEqual(M.classify({}).state, 'mixed', 'nothing known: no list');
});

test('lists: a rejection or a breakout with a clear trend, counter-trend against it, trend-end and chop either side', () => {
  const rej = d => ({ rel: 'rejected', dir: d });
  assert.strictEqual(M.listOf('clear', 'up', 'long', rej('up')), 'trend-up');
  assert.strictEqual(M.listOf('clear', 'down', 'short', rej('down')), 'trend-down');
  // A breakout with the trend is the owner's other entry (a gap's failure through its far edge is one).
  assert.strictEqual(M.listOf('clear', 'up', 'long', { rel: 'broke', dir: 'up' }), 'trend-up');
  assert.strictEqual(M.listOf('clear', 'down', 'short', { kind: 'fvg', rel: 'broke', dir: 'down' }), 'trend-down');
  assert.deepStrictEqual([{ rel: 'rejected' }, { rel: 'broke' }, { kind: 'fvg', rel: 'rejected' }, { kind: 'fvg', rel: 'broke' }].map(M.reactionKindOf), ['rejection', 'breakout', 'fvg rejection', 'fvg breakout']);
  for (const m of MOMENTS) assert.strictEqual(m.reactionKind, M.reactionKindOf(m.reaction), m.id);
  assert.strictEqual(M.listOf('clear', 'up', 'short', rej('down')), 'counter-trend');
  assert.strictEqual(M.listOf('clear', 'down', 'long', { rel: 'broke', dir: 'up' }), 'counter-trend');
  assert.strictEqual(M.listOf('trend-end', 'up', 'short', rej('down')), 'trend-end');
  assert.strictEqual(M.listOf('chop', null, 'long', rej('up')), 'chop');
  assert.strictEqual(M.listOf('mixed', null, 'long', rej('up')), null);
  for (const m of MOMENTS) assert.strictEqual(m.list, M.listOf(m.trend.state, m.trend.dir, m.side, m.reaction), m.id);
  // The trend is the reaction bar's: the briefing as of the reaction candle's close, nothing later.
  for (const m of MOMENTS) {
    const c = M.classify(briefAt(BARS, new Date(Date.parse(m.reactionAt) - 180000).toISOString()));
    assert.deepStrictEqual(m.trend, { state: c.state, dir: c.trend, ...c.facts }, m.id);
  }
});

test('the gate\'s view: take only when the standard traded and the trend rule allows the side (never counter: no D2 reversal)', () => {
  assert.ok(MOMENTS.some(m => m.expected === 'take') && MOMENTS.some(m => m.expected === 'pass'));
  // The fixture day has standards traded against the trend rule (once D2's reversals): each is a pass now.
  assert.ok(MOMENTS.some(m => m.standard.status === 'traded' && !m.gate.trendAllowed && m.expected === 'pass'), 'a traded standard the rule refuses');
  for (const m of MOMENTS) {
    assert.strictEqual(m.gate.d2, null, m.id);
    assert.strictEqual(m.expected, m.standard.status === 'traded' && m.gate.trendAllowed ? 'take' : 'pass', m.id);
  }
});

test('the window: from two setup candles before the reaction candle to the end of its confirmation window, never the standard\'s exit, never past end of day', () => {
  for (const m of MOMENTS) {
    const from = Date.parse(m.window.from);
    const to = Date.parse(m.window.to);
    assert.strictEqual(from, Date.parse(m.reactionAt) - 3 * 15 * 60000, m.id);
    assert.ok(to >= Date.parse(m.bar) + 180000 || to === CLOCK.eodOf(Date.parse(m.bar) + 180000), m.id);
    assert.ok(to <= CLOCK.eodOf(Date.parse(m.bar) + 180000), m.id);
    assert.strictEqual(to, Math.min(Math.max(Date.parse(m.reactionAt) + 15 * 60000, Date.parse(m.bar) + 180000), CLOCK.eodOf(Date.parse(m.bar) + 180000)), `${m.id}: the window says nothing of the outcome`);
  }
  const w = M.windowOf({ reactionAt: '2022-03-01T15:00:00.000Z', setupTf: 15, eodMs: Date.parse('2022-03-01T20:50:00Z'), decisionClose: Date.parse('2022-03-01T15:06:00Z') });
  assert.deepStrictEqual(w, { from: '2022-03-01T14:15:00.000Z', to: '2022-03-01T15:15:00.000Z' });
  assert.strictEqual(M.windowOf({ reactionAt: '2022-03-01T20:45:00.000Z', setupTf: 15, eodMs: Date.parse('2022-03-01T20:50:00Z'), decisionClose: Date.parse('2022-03-01T20:48:00Z') }).to, '2022-03-01T20:50:00.000Z', 'capped at end of day');
});

test('causal: changing the bars after a moment\'s decision changes nothing known at it (only its outcome and window look ahead)', () => {
  const cut = Date.parse('2020-05-01T15:30:00Z');
  const later = BARS.map(b => (Date.parse(b.t) >= cut ? { ...b, o: b.o + 300, h: b.h + 340, l: b.l + 260, c: b.c + 310 } : b));
  const again = scan(later);
  const known = m => ({ id: m.id, bar: m.bar, side: m.side, list: m.list, trend: m.trend, reads: m.reads, skills: m.skills, standard: m.standard, gate: m.gate, expected: m.expected, year: m.year, regime: m.regime });
  // Every moment whose confirmation window closed before the change.
  const before = MOMENTS.filter(m => Date.parse(m.reactionAt) + 15 * 60000 <= cut);
  assert.ok(before.length >= 5, `moments before the change: ${before.length}`);
  for (const m of before) assert.deepStrictEqual(known(again.find(x => x.id === m.id)), known(m), m.id);
  assert.ok(again.some(m => Date.parse(m.reactionAt) > cut && !MOMENTS.some(x => x.id === m.id && JSON.stringify(known(x)) === JSON.stringify(known(m)))), 'the change did change later moments (the test can see a change)');
});

test('CLI: scan (practice-train only), build and show on fixture bars; the list document equals the library function\'s', () => {
  const { spawnSync } = require('child_process');
  const C = require('../../scripts/lib/learning/curated-lists');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fth-curated-cli-'));
  const bars = path.join(dir, 'MNQ-3m.json');
  fs.writeFileSync(bars, JSON.stringify(BARS));
  // The fixture bars are from 2020, before the committed data start: the scan reads a schedule whose data starts earlier.
  const sched = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'schedule.json'), 'utf8'));
  sched.data.start = '2020-01-01';
  sched.data.sessionsFrom = '2020-01-01';
  const early = path.join(dir, 'schedule-early.json');
  fs.writeFileSync(early, JSON.stringify(sched));
  const useFile = path.join(__dirname, '..', 'fixtures', 'schedule', 'use-file.js');
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'curated-lists.js'), ...args], { encoding: 'utf8', env: { ...process.env, FTH_HOME: dir, NODE_OPTIONS: `--require "${useFile}"`, FTH_TEST_SCHEDULE_SOURCE: early } });
  const plain = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'curated-lists.js'), 'scan', '--bars', bars, '--root', 'MNQ', '--from', '2020-05-01', '--to', '2020-05-02', '--use', 'practice', '--out', path.join(dir, 'x.jsonl')], { encoding: 'utf8', env: { ...process.env, FTH_HOME: dir } });
  assert.notStrictEqual(plain.status, 0);
  assert.match(plain.stderr, /before the data's start 2021-04-01/);
  const out = path.join(dir, 'moments.jsonl');
  let r = cli('scan', '--bars', bars, '--root', 'MNQ', '--from', '2020-05-01', '--to', '2020-05-02', '--use', 'practice', '--window-bars', String(WINDOW), '--out', out);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /moment\(s\) of MNQ 2020-05-01\.\.2020-05-02 \(practice\)/);
  assert.match(r.stdout, /\d+ briefing\(s\), \d+ ms each/);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(lines, MOMENTS);
  // In processes of whole session dates: the same moments as one scan, in order.
  const jobs = path.join(dir, 'jobs.jsonl');
  r = cli('scan', '--bars', bars, '--root', 'MNQ', '--from', '2020-04-30', '--to', '2020-05-02', '--use', 'practice', '--window-bars', String(WINDOW), '--out', jobs, '--jobs', '2');
  assert.strictEqual(r.status, 0, r.stderr);
  const both = fs.readFileSync(jobs, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(both, scan(BARS, { from: '2020-04-30', to: '2020-05-02' }));
  assert.deepStrictEqual(both.filter(m => m.day === '2020-05-01'), MOMENTS);
  assert.ok(both.some(m => m.day === '2020-04-30'));
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => /\.part\d+$/.test(f)), [], 'its parts removed');
  r = cli('scan', '--bars', bars, '--root', 'MNQ', '--from', '2024-06-28', '--to', '2024-07-03', '--use', 'practice', '--out', jobs, '--jobs', '2');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /practice refused/, 'a part refused is the scan refused');
  for (const [args, why] of [[['--use', 'validate'], /validate refused/], [['--use', 'test'], /use test refused/], [['--from', '2025-01-02', '--to', '2025-01-03'], /practice refused/]]) {
    const base = ['scan', '--bars', bars, '--root', 'MNQ', '--from', '2020-05-01', '--to', '2020-05-02', '--use', 'practice', '--out', path.join(dir, 'x.jsonl')];
    for (let k = 0; k < args.length; k += 2) base[base.indexOf(args[k]) + 1] = args[k + 1];
    r = cli(...base);
    assert.strictEqual(r.status, 1, args.join(' '));
    assert.match(r.stderr, why);
  }
  r = cli('build', out, '--use', 'practice', '--total', '20', '--seed', '3', '--out', path.join(dir, 'lists'));
  assert.strictEqual(r.status, 0, r.stderr);
  const file = path.join(dir, 'lists', fs.readdirSync(path.join(dir, 'lists'))[0]);
  const doc = C.readLists(file);
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(out, 'utf8')).digest('hex');
  assert.deepStrictEqual({ ...doc, builtAt: null }, { ...C.buildLists(MOMENTS, { use: 'practice', total: 20, seed: 3, sources: [{ file: out, sha256: sha }] }), builtAt: null, fingerprint: doc.fingerprint });
  assert.strictEqual(doc.fingerprint, C.fingerprintOf(doc));
  assert.match(r.stdout, /^curated practice lists [0-9a-f]{16}/);
  assert.strictEqual(cli('build', out, out, '--use', 'practice').status, 1, 'the same file twice is refused');
  assert.match(cli('build', out, '--use', 'validate').stderr, /scanned for practice, not validate/);
  r = cli('show', file);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, C.coverageText(doc));
});
