'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const U = require('../../scripts/lib/learning/skill-usage');
const L = require('../../scripts/lib/learning/learning-report');
const TL = require('../../scripts/lib/trading/trade-lifecycle');
const { checkReads } = require('../../scripts/lib/trading/composed-reads');
const { MIN_N, MIN_DAYS } = require('../../scripts/lib/learning/experience-index');
const { BARS, MINUTE_BARS, ROOT } = require('../fixtures/decision-path');
const { tmpDir } = require('../helpers');

// Records composed on the parity bars (tests/fixtures/parity/NQ-3m.csv), checked by the real checker on the briefing
// rebuilt at their bar, as compose_check writes them (trade-lifecycle.js buildRecord).
const at = U.briefingFrom(BARS, { root: 'MNQ', minutes: 3, count: 1400 });
const A_BAR = '2026-04-23T14:00:00.000Z';
const R_BAR = '2026-04-23T16:24:00.000Z';
const A = [
  ['bias', 'multi-timeframe-analysis', '15m up'], ['location', 'levels-and-reactions', 'at vwap rth'],
  ['setup', 'fair-value-gaps', '4h broke 15m fvg high up'], ['entry', 'candle-reading', '3m close top'],
  ['stop', 'invalidation', 'stop 3m low 26970'], ['target', 'take-profit', 'target 3m swing 27102.75'],
];
function rec(bar, side, reads, { briefing = at('MNQ', bar), size = 1 } = {}) {
  const checked = checkReads({ reads: reads.map(([step, skill, read]) => ({ step, skill, read, why: 'x' })), side, briefing });
  const planned = TL.planOf({ checked, briefing, side, size, tick: 0.25, tickValue: 0.5, minRR: 2, maxRiskUsd: 300 });
  return TL.buildRecord({ at: new Date(Date.parse(bar) + 182000).toISOString(), root: 'MNQ', symbol: 'MNQ', side, briefing, checked, planned });
}
// The bar's ok record; then the same bar again with a FALSE read (named under another skill), an unverifiable one, and
// the ok reads stated again (counted once); then a short at another bar, its 15m trend against it.
const RECORDS = [
  rec(A_BAR, 'long', A),
  rec(A_BAR, 'long', [...A, ['bias', 'daily-bias', '15m down'], ['entry', 'candle-reading', '5m close top']]),
  rec(R_BAR, 'short', [['bias', 'multi-timeframe-analysis', '15m up'], ['location', 'levels-and-reactions', 'at ib high'], ['setup', 'rejection', '15m rejected opening range high up'], ['entry', 'candle-reading', '3m close top'], ['stop', 'invalidation', 'stop 3m high 27100'], ['target', 'take-profit', 'target 3m swing 27155.75']]),
];
const of = (u, skill) => u.skills.find(s => s.skill === skill);

test('skill usage: used of available, correct, wrong with its reasons, missed with the reads missed, mislabeled', () => {
  const u = U.skillUsage({ records: RECORDS, briefingAt: at });
  assert.deepStrictEqual([u.records, u.recordsOk, u.points, u.briefings], [3, 1, 2, 2]);
  // multi-timeframe-analysis: claimed at both points (15m up long: true; 15m down long: false; 15m up short: against).
  const mtf = of(u, 'multi-timeframe-analysis');
  assert.deepStrictEqual([mtf.claimed, mtf.available, mtf.used, mtf.reads, mtf.correct, mtf.wrong, mtf.mislabeled], [2, 2, 2, 3, 1, 2, 1]);
  assert.deepStrictEqual(mtf.topRefusals, [{ what: 'against the short: 15m up', count: 1 }, { what: 'false: 15m down', count: 1 }]);
  // candle-reading: the 5m close is unverifiable on a 3m lane (no 5m candle).
  const cr = of(u, 'candle-reading');
  assert.deepStrictEqual([cr.reads, cr.correct, cr.wrong], [3, 1, 2]);
  assert.ok(cr.topRefusals.some(x => x.what === 'unverifiable: 5m close top'));
  // bos-vs-choch: true and agreeing at the long (3m CHoCH up), never claimed: missed, with the read.
  const bc = of(u, 'bos-vs-choch');
  assert.deepStrictEqual([bc.claimed, bc.reads, bc.missed >= 1, bc.used], [0, 0, true, 0]);
  assert.ok(bc.topMissed.some(x => x.what === '3m choch up'), JSON.stringify(bc.topMissed));
  // A skill claimed where it is available counts as used; a claimed one's relevant point is never missed.
  const lv = of(u, 'levels-and-reactions');
  assert.ok(lv.used >= 1 && lv.missed === 0, JSON.stringify(lv));
  assert.strictEqual(lv.usedRate, Math.round((lv.used / lv.available) * 10000) / 10000);
  // A read filed under the shape skill counts for it and for its own, and is no mislabel.
  const shape = U.skillUsage({ records: [rec('2026-04-23T18:06:00.000Z', 'short', [['bias', 'pullback-vs-reversal', '1h choch down']])], briefingAt: at });
  assert.deepStrictEqual([of(shape, 'bos-vs-choch').reads, of(shape, 'bos-vs-choch').mislabeled, of(shape, 'pullback-vs-reversal').claimed, of(shape, 'pullback-vs-reversal').used], [1, 0, 1, 1]);
  // The no-read skills are listed, not measured.
  assert.deepStrictEqual(u.noRead.map(x => x.step), ['size', 'management']);
  assert.ok(!u.skills.some(s => s.skill === 'position-sizing'));
});

test('skill usage: available counts only TRUE reads, missed only those agreeing with the side; no briefing, no availability', () => {
  // The short at 16:24: the 15m trend is up (TRUE, against the short): multi-timeframe-analysis is available there, but
  // its reads there don't agree with the short unless one does.
  const shortOnly = U.skillUsage({ records: [RECORDS[2]], briefingAt: at });
  const avail = U.availableAt(at('MNQ', R_BAR), 'short');
  for (const s of shortOnly.skills) {
    const a = avail.get(s.skill);
    assert.strictEqual(s.available, a && a.reads.length ? 1 : 0, s.skill);
    assert.strictEqual(s.relevant, a && a.agreeing.length ? 1 : 0, s.skill);
  }
  const none = U.skillUsage({ records: RECORDS, briefingAt: () => null });
  assert.strictEqual(none.briefings, 0);
  assert.ok(none.skills.every(s => s.available === 0 && s.missed === 0 && s.relevant === 0));
  assert.strictEqual(of(none, 'multi-timeframe-analysis').correct, 1, 'correct and wrong come from the records alone');
});

test('skill usage: available is the curated scanner\'s readsAt over every reaction the bar shows, once each; a bar with none still counts its other reads', () => {
  const { readsAt } = require('../../scripts/lib/learning/curated-moments');
  const b = at('MNQ', A_BAR);
  const avail = U.availableAt(b, 'long');
  const forms = new Set([...avail.values()].flatMap(a => a.reads.map(r => r.form)));
  // The 4h candle broke the 15m gap's high up (a reaction): the scanner's reads on it are all here.
  for (const r of readsAt(b, { side: 'long', reaction: { name: '15m fvg high', kind: 'fvg', rel: 'broke', dir: 'up' }, setupTf: 240 })) assert.ok(forms.has(require('../../scripts/lib/trading/composed-reads').parseRead(r.read).form), r.read);
  assert.ok(avail.get('fair-value-gaps').agreeing.some(r => r.form === '4h broke 15m fvg high up'));
  // Every read kept is TRUE (the scanner keeps the checker's TRUE ones), once each.
  const all = [...avail.entries()].filter(([s]) => s !== 'pullback-vs-reversal').flatMap(([, a]) => a.reads);
  assert.strictEqual(new Set(all.map(r => r.form)).size, all.length);
  for (const r of all) assert.strictEqual(checkReads({ reads: [{ step: r.step, skill: r.skill, read: r.read }], side: 'long', briefing: b }).reads[0].check, true, r.read);
  // A TRUE read against the side is available, not relevant: the 15m trend up for a short.
  const mtfShort = U.availableAt(b, 'short').get('multi-timeframe-analysis');
  assert.ok(mtfShort.reads.some(r => r.form === '15m up') && !mtfShort.agreeing.some(r => r.form === '15m up'));
  // No reaction on any candle: the bias and location reads still count.
  const bare = JSON.parse(JSON.stringify(b));
  for (const c of Object.values(bare.sections.m3.data.candles)) if (c && !c.unavailable) { c.relations = []; c.fvgRelations = []; }
  const none = U.availableAt(bare, 'long');
  assert.ok(none.get('multi-timeframe-analysis').agreeing.some(r => r.form === '15m up'));
  assert.ok(!none.has('fair-value-gaps') || !none.get('fair-value-gaps').reads.some(r => r.step === 'setup'));
});

test('skill usage: missed counts only a TRUE read pointing the side\'s way: one against it, or one with no direction, is available only', () => {
  // The long at 14:00: the 3m CHoCH up is TRUE and points long, never claimed: missed. The VWAP side, the regime and the
  // day type have no direction: available, never missed.
  const long = U.skillUsage({ records: RECORDS.slice(0, 2), briefingAt: at });
  assert.deepStrictEqual([of(long, 'bos-vs-choch').missed, of(long, 'bos-vs-choch').relevant], [1, 1]);
  assert.ok(of(long, 'bos-vs-choch').topMissed.some(x => x.what === '3m choch up'));
  for (const sk of ['vwap-volume-profile', 'trend-vs-range']) assert.deepStrictEqual([of(long, sk).available, of(long, sk).relevant, of(long, sk).missed, of(long, sk).topMissed], [1, 0, 0, []], sk);
  // The short at 16:24: the 3m CHoCH up and the 15m and 1h BOS up are TRUE but against the short: not missed.
  const short = U.skillUsage({ records: [RECORDS[2]], briefingAt: at });
  const bc = of(short, 'bos-vs-choch');
  assert.deepStrictEqual([bc.available, bc.relevant, bc.missed, bc.topMissed], [1, 0, 0, []]);
  assert.ok(U.availableAt(at('MNQ', R_BAR), 'short').get('bos-vs-choch').reads.some(r => r.form === '3m choch up' && r.dir === 'long'));
  for (const sk of ['vwap-volume-profile', 'trend-vs-range', 'daily-bias', 'cisd', 'breakout']) assert.strictEqual(of(short, sk).missed, 0, sk);
});

test('skill usage: a 1m lane: the run\'s 1m bars closed by the bar\'s close are the fine bars (the 5m facts), as the live briefing has them', () => {
  const plain = at('MNQ', R_BAR);
  assert.ok(plain.sections.m3.data.candles['5m'].unavailable);
  const fine = U.briefingFrom(BARS, { root: 'MNQ', minutes: 3, count: 1400, fineBars: MINUTE_BARS });
  const b = fine('MNQ', R_BAR);
  const c5 = b.sections.m3.data.candles['5m'];
  assert.ok(!c5.unavailable && Date.parse(c5.closedAt) <= Date.parse(R_BAR) + 180000, JSON.stringify(c5).slice(0, 200));
  assert.ok([...U.availableAt(b, 'short').values()].some(a => a.reads.some(r => /^5m /.test(r.form))), 'a 5m read counts');
  // A later 1m bar changes nothing.
  const end = Date.parse(R_BAR) + 180000;
  const later = MINUTE_BARS.map(x => (Date.parse(x.t) + 60000 > end ? { ...x, h: x.h + 300, c: x.c + 200 } : x));
  assert.deepStrictEqual(U.briefingFrom(BARS, { root: 'MNQ', minutes: 3, count: 1400, fineBars: later })('MNQ', R_BAR).sections.m3.data, b.sections.m3.data);
  // Read from the run home's 1m bars file.
  const { home, dir } = runHome();
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-1m.json'), JSON.stringify({ bars: MINUTE_BARS }));
  const withLane = U.readSkillUsage(dir);
  fs.unlinkSync(path.join(home, 'bars', 'MNQ-1m.json'));
  assert.notDeepStrictEqual(withLane.skills, U.readSkillUsage(dir).skills);
});

test('skill usage: the briefing at a bar reads no later bar: changing every bar after it changes nothing', () => {
  const i = BARS.findIndex(b => b.t === A_BAR);
  const later = BARS.map((b, j) => (j > i ? { ...b, o: b.o + 500, h: b.h + 600, l: b.l + 400, c: b.c + 550, v: b.v * 9 } : b));
  const a = U.skillUsage({ records: RECORDS.slice(0, 2), briefingAt: at });
  const b = U.skillUsage({ records: RECORDS.slice(0, 2), briefingAt: U.briefingFrom(later, { root: 'MNQ', minutes: 3, count: 1400 }) });
  assert.deepStrictEqual(b, a);
  // The bar itself does change it (the check reads the bar): the test above can fail.
  const moved = BARS.map((b2, j) => (j === i ? { ...b2, c: b2.l } : b2));
  assert.notDeepStrictEqual(U.skillUsage({ records: RECORDS.slice(0, 2), briefingAt: U.briefingFrom(moved, { root: 'MNQ', minutes: 3, count: 1400 }) }).skills, a.skills);
  assert.strictEqual(U.briefingFrom(BARS, { root: 'MNQ', minutes: 3, count: 1400 })('MES', A_BAR), null, 'another root: none');
});

/** A composed decision of the experience log (its reads as lifecycle-record.js normalizes them). */
function decision(day, i, R, { decision: kind = 'entered', reads = A, sig = 'bias:multi-timeframe-analysis+setup:fair-value-gaps' } = {}) {
  return {
    id: `${day}-${i}`, day, bar: `${day}T14:${String(i).padStart(2, '0')}:00.000Z`, decision: kind, side: 'long', root: 'MNQ',
    reads: reads.map(([step, skill, read]) => ({ step, skill, read, check: 'true', agrees: true })), signatures: { skill: sig }, context: { regime: 'trend-up' },
    outcome: R === null ? { filled: false, R: null } : { R, exitTime: `${day}T15:00:00.000Z` },
  };
}

test('skill usage: outcome by skill and by combination, taken and all, with n and the experience index\'s sample-size label', () => {
  const days = Array.from({ length: MIN_DAYS + 2 }, (_, k) => `2022-03-${String(k + 1).padStart(2, '0')}`);
  const many = days.flatMap(d => [decision(d, 1, 2), decision(d, 2, -1)]);
  assert.ok(many.length >= MIN_N);
  const few = [decision('2022-04-01', 1, 1, { reads: [['setup', 'rejection', '15m rejected prior vah up']], sig: 'setup:rejection' }), decision('2022-04-01', 2, null, { decision: 'passed', reads: [['setup', 'rejection', '15m rejected prior vah up']], sig: 'setup:rejection' })];
  const o = U.skillUsage({ records: [], decisions: [...many, ...few, { ...decision('2022-04-02', 1, 5), decision: 'none' }, { ...decision('2022-04-02', 2, 9), hidden: true }] }).outcome;
  assert.strictEqual(o.decisions, many.length + few.length);
  const mtf = o.bySkill.find(s => s.skill === 'multi-timeframe-analysis');
  assert.deepStrictEqual([mtf.taken.n, mtf.taken.days, mtf.taken.meanR, mtf.taken.winRate, mtf.taken.enough], [many.length, days.length, 0.5, 0.5, true]);
  assert.match(mtf.taken.label, /^enough \(n=24, 12 days; mean R /);
  const rej = o.bySkill.find(s => s.skill === 'rejection');
  assert.deepStrictEqual([rej.taken.n, rej.all.n, rej.all.unfilled, rej.taken.enough, rej.taken.label], [1, 1, 1, false, 'too few samples (n=1, 1 days)']);
  assert.deepStrictEqual(o.byCombo.map(c => [c.combo, c.all.n]), [['bias:multi-timeframe-analysis+setup:fair-value-gaps', 24], ['setup:rejection', 1]]);
  // A read not verified counts for no skill's outcome.
  const unverified = { ...decision('2022-05-01', 1, 3), reads: [{ step: 'setup', skill: 'cisd', read: '15m cisd up', check: 'false', agrees: true }] };
  assert.ok(!U.skillUsage({ records: [], decisions: [unverified] }).outcome.bySkill.some(s => s.skill === 'cisd'));
  // Hidden outcomes (a reasoning-fix look): none shown.
  assert.deepStrictEqual(U.skillUsage({ records: [], decisions: many, hideOutcomes: true }).outcome, { hidden: true });
});

/** A replay run's home: its run dir, the runner config, its bars, the compose records, the cycle log, and `o` extras. */
function runHome({ gate = { learning: true, role: 'final', look: { purpose: 'judging' }, hideOutcomes: false }, shards = false, decisions = null } = {}) {
  const home = tmpDir();
  const dir = path.join(home, 'replay', 'run1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'autotrader.json'), JSON.stringify({ timeframe: 3, bars: 1400, symbols: ['MNQ'] }));
  if (gate) fs.writeFileSync(path.join(dir, 'learning-run.json'), JSON.stringify(gate));
  fs.mkdirSync(path.join(home, 'bars'));
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify({ bars: BARS }));
  const tl = path.join(home, 'trade-lifecycle');
  fs.mkdirSync(path.join(tl, 'MNQ'), { recursive: true });
  // The older single file holds the first record; the day shard the others (and the first again: counted once).
  fs.writeFileSync(path.join(tl, 'MNQ.jsonl'), `${JSON.stringify(RECORDS[0])}\n`);
  if (shards) fs.writeFileSync(path.join(tl, 'MNQ', '2026-04-23.jsonl'), `${RECORDS.map(r => JSON.stringify(r)).join('\n')}\nnot json\n`);
  else fs.appendFileSync(path.join(tl, 'MNQ.jsonl'), `${RECORDS.slice(1).map(r => JSON.stringify(r)).join('\n')}\n`);
  fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(path.join(home, 'logs', 'cycles-2026-04-23.jsonl'), [
    { action: 'trade', composed: { calls: 2, ok: 1 } }, { action: 'trade', composed: { calls: 1, ok: 0 } }, { action: 'trade' }, { action: 'premarket' },
  ].map(x => JSON.stringify(x)).join('\n'));
  if (decisions) {
    fs.mkdirSync(path.join(home, 'experience'));
    fs.writeFileSync(path.join(home, 'experience', 'decisions.jsonl'), decisions.map(x => JSON.stringify(x)).join('\n'));
  }
  return { home, dir };
}

test('skill usage: readComposeRecords reads the single file and the day shards, a record in both once, oldest first', () => {
  for (const shards of [false, true]) {
    const { home } = runHome({ shards });
    const got = U.readComposeRecords(home);
    assert.deepStrictEqual(got.map(r => r.id), RECORDS.map(r => r.id), `shards ${shards}`);
  }
  assert.deepStrictEqual(U.readComposeRecords(tmpDir()), []);
});

test('skill usage: a replay run read from what it recorded: records, the cycle log, its bars, its experience log', () => {
  const dec = [decision('2026-04-23', 1, 2.59)];
  const { home, dir } = runHome({ shards: true, decisions: dec });
  const u = U.readSkillUsage(dir);
  // The briefing rebuilt with the run home's round-number steps, as the scorecard rebuilds it.
  const roundSteps = require('../../scripts/lib/trading/round-numbers').loadRoundSteps({ FTH_HOME: home });
  const inHome = U.briefingFrom(BARS, { root: 'MNQ', minutes: 3, count: 1400, roundSteps });
  assert.deepStrictEqual(u, U.skillUsage({ records: RECORDS, briefingAt: inHome, decisions: dec, cycles: [{ action: 'trade', composed: { calls: 2, ok: 1 } }, { action: 'trade', composed: { calls: 1, ok: 0 } }, { action: 'trade' }, { action: 'premarket' }] }));
  assert.deepStrictEqual(u.cycles, { trade: 3, composed: 2, calls: 3 });
  assert.strictEqual(u.outcome.decisions, 1);
  // A reasoning-fix look: the outcomes hidden, the usage shown.
  const hidden = U.readSkillUsage(runHome({ gate: { learning: true, role: 'final', hideOutcomes: true }, decisions: dec }).dir);
  assert.deepStrictEqual([hidden.outcome, hidden.points], [{ hidden: true }, 2]);
});

test('skill usage: the ledger: records on a held-back day with no learning decision are refused; practice-train ones are read', () => {
  const { dir } = runHome({ gate: null });
  assert.throws(() => U.readSkillUsage(dir), /held-back days \(2026-04-23\) and no learning decision/);
  assert.doesNotThrow(() => U.checkLedger([{ bar: '2022-03-01T14:00:00.000Z' }], null));
  assert.throws(() => U.checkLedger([{ bar: '2024-08-01T14:00:00.000Z' }], null), /held-back/);
  assert.doesNotThrow(() => U.checkLedger([{ bar: '2024-08-01T14:00:00.000Z' }], { learning: true, role: 'practice-validate' }));
  // In the learning report: the refusal is said, not hidden.
  assert.match(L.usageMarkdown(L.skillUsageFor(dir)), /## Skill usage\n\n- Not read: skill usage refused: this run has records on held-back days/);
});

test('skill usage: in the learning report (Markdown and text), and as the CLI prints it', () => {
  const dec = [decision('2026-04-23', 1, 2.59)];
  const { dir } = runHome({ decisions: dec });
  const u = L.skillUsageFor(dir);
  const m = L.learningMeasures({ decisions: [], skillUsage: u });
  const md = L.learningMarkdown(m);
  assert.match(md, /## Skill usage\n\n- An operator report: never shown to the model\./);
  assert.match(md, /\| multi-timeframe-analysis \| bias \| 2 of 2 \(1\.00\); claimed 2 \| 3 \| 1 \| 2 \| against the short: 15m up \(1\); false: 15m down \(1\) \|/);
  assert.match(L.learningText(m), /skill usage: 2 decision points \(3 compose records, 1 ok\)/);
  assert.strictEqual(L.learningMarkdown(L.learningMeasures({ decisions: [] })).includes('Skill usage'), false);
  assert.strictEqual(L.skillUsageFor(path.join(tmpDir(), 'replay', 'none')), null, 'no records: no section');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-usage.js'), dir], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.strictEqual(cli.stdout, U.skillUsageMarkdown(u));
  const json = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-usage.js'), dir, '--json'], { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(json.stdout), JSON.parse(JSON.stringify(u)));
  assert.strictEqual(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-usage.js')], { encoding: 'utf8' }).status, 2);
  assert.strictEqual(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-usage.js'), dir, '--bars', 'nofile'], { encoding: 'utf8' }).status, 2);
  const refused = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-usage.js'), runHome({ gate: null }).dir], { encoding: 'utf8' });
  assert.deepStrictEqual([refused.status, /held-back/.test(refused.stderr)], [1, true]);
});

test('skill usage: never shown to the model: only the replay report (and the stage report it ends a run with), its own CLI and the operator A/B comparison reach it, no harness tool, prompt or runner code', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const users = walk(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.js') && /(learning-report|skill-usage)'\)/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(ROOT, f).split(path.sep).join('/')).sort();
  assert.deepStrictEqual(users, [
    'scripts/lib/learning/learning-report.js',
    'scripts/lib/replay/stage.js', // the stage report a finished replay run prints to the operator
    'scripts/lib/train/ab-compare.js', // the operator A/B comparison of two finished runs (its CLI scripts/ab-compare.js requires only it): a report, never a prompt or tool
    // Propose-Probe-Compose: the probe round's findings (a skill's wrong and missed read counts and their forms, no
    // outcome) go to the design-time proposer, never to a trading cycle; probe.js reads each probe run's report for the code screen.
    'scripts/lib/train/findings.js',
    'scripts/lib/train/probe.js',
    'scripts/replay.js',
    'scripts/skill-usage.js',
  ]);
  // The comparison is required only by its CLI and by run-pins.js (the replay driver's setup record, scripts/replay.js alone requires it): no tool, prompt, runner or skill_lookup path.
  const abUsers = walk(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.js') && /train\/ab-compare'\)|\.\/ab-compare'\)/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(ROOT, f).split(path.sep).join('/')).sort();
  // And by the training loop's model-scoring verifier, for decisionsByKey alone (the correct-read keying): a code judge
  // whose verdicts go to the archive and the owner's PR body, never to the proposer's prompt (train/loop.js proposalsFor).
  // And by an adapter's validation (learning/adapter-validation.js deriveValidation), required by its operator CLI
  // alone (scripts/adapter.js validated): the result it records is the A/B's verdict, never shown to the model.
  // And by the probe screen (train/screen.js), for decisionsByKey and the paired interval: a code judge as well.
  assert.deepStrictEqual(abUsers, ['scripts/ab-compare.js', 'scripts/lib/learning/adapter-validation.js', 'scripts/lib/learning/run-pins.js', 'scripts/lib/train/model-verifier.js', 'scripts/lib/train/screen.js']);
  const validationUsers = walk(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.js') && /adapter-validation'\)/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(ROOT, f).split(path.sep).join('/'));
  assert.deepStrictEqual(validationUsers, ['scripts/adapter.js']);
  // The findings the proposer reads carry no outcome: findings.js never reads the report's outcome section.
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'train', 'findings.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /outcome|bySkill|byCombo|meanR|winRate/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'train', 'model-verifier.js'), 'utf8'), /skillRows|skill-usage|learning-report/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'train', 'proposer.js'), 'utf8'), /model-verifier|ab-compare/);
  const pinUsers = walk(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.js') && /run-pins'\)/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(ROOT, f).split(path.sep).join('/'));
  // And the decision sampler's base run (learning/decision-sampler.js runBase), started as scripts/replay.js run starts one.
  assert.deepStrictEqual(pinUsers.sort(), ['scripts/lib/learning/decision-sampler.js', 'scripts/replay.js']);
});

test('skill usage: the A/B comparison reads the real report: per-skill rows, not N/A', () => {
  const AB = require('../../scripts/lib/train/ab-compare');
  const { dir } = runHome({ decisions: [decision('2026-04-23', 1, 2.59)] });
  const u = U.readSkillUsage(dir);
  assert.ok(u.skills.length > 0);
  const rows = AB.skillRows(u, u);
  assert.strictEqual(rows.length, u.skills.length);
  const mtf = u.skills.find(s => s.skill === 'multi-timeframe-analysis');
  const row = rows.find(r => r.measure.startsWith('  skill multi-timeframe-analysis:'));
  assert.ok(row && row.verdict === 'descriptive');
  assert.match(row.measure, /used 0, correct 0, missed 0/);
  assert.strictEqual(row.test, `used ${mtf.used}/${mtf.available} -> ${mtf.used}/${mtf.available}, correct ${mtf.correct}/${mtf.reads} -> ${mtf.correct}/${mtf.reads}`);
});
