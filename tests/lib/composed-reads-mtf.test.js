'use strict';

// P1 (feat/p1-mtf-entries): the MTF entry's reads in the reads checker (composed-reads.js checkReads), what compose_check
// and the order gate both run: `mtf ready <model> long|short` (setup step) is TRUE only when mtf-entry.js readyOf passes
// on the briefing; `stop mtf <price>` is the chosen candidate's structural stop (its origin, the plan adds the D3 buffer
// once: the printed stop); `target trail` on an MTF entry needs the 1h structure's side, not the 4h+1h rule; and on an MTF
// entry the policy's entry rule (the 4h+1h bias) gives way to the MTF side check. Every other entry keeps today's rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkReads, parseRead } = require('../../scripts/lib/trading/composed-reads');
const { planOf } = require('../../scripts/lib/trading/trade-lifecycle');
const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
const ME = require('../../scripts/lib/trading/mtf-entry');
const F = require('../fixtures/mtf-entry');
const LC = require('../fixtures/lifecycle');
const { lifecycleStopRule } = require('../helpers');

const RULE = entryRuleOf({ chain: '4h', bias_frames: ['4h', '1h'], bias_agree: 'neutral-15m-declared', regime_against: 'off', leg_turned: 'off' });
const DOWN4H = { h4: { trend: 'down' } }; // the EMA 4h against the long: today's rule refuses it
const run = (o = {}) => checkReads({ reads: F.READS, side: 'long', briefing: F.briefing(o.b || {}), tick: 0.25, entryRule: RULE, mtfMode: F.MODE('A'), ...o.x });
const problems = r => [...r.problems, ...r.reads.filter(x => x.check !== true).map(x => x.fact)].join(' | ');

test('parse: the two MTF forms', () => {
  assert.deepEqual([parseRead('mtf ready aggressive long').kind, parseRead('mtf ready aggressive long').model, parseRead('mtf ready conservative short').value], ['mtf', 'aggressive', 'short']);
  assert.equal(parseRead('mtf ready eager long').kind, 'unknown');
  const s = parseRead('stop mtf 21528.75');
  assert.deepEqual([s.kind, s.source, s.price], ['stop', 'mtf', 21528.75]);
});

test('an MTF long under arm A: every read true, the 4h EMA down does not refuse it (the 1h structure sets the side), and the plan\'s stop is the printed structural stop', () => {
  const r = run({ b: { h1: DOWN4H } });
  assert.equal(r.ok, true, problems(r));
  assert.equal(r.stop.level, 21529, 'the stop read\'s level: the origin');
  assert.equal(r.mtf.instanceId, 'intraday|2026-10-07T13:15:00.000Z|2026-10-07T14:00:00.000Z|aggressive', 'the candidate\'s key (the trade record joins it offline)');
  const { plan, problems: pp } = planOf({ checked: r, briefing: F.briefing({ h1: DOWN4H }), side: 'long', size: 1, tick: 0.25, tickValue: 0.5, minRR: 2, maxRiskUsd: 300, stopRule: lifecycleStopRule() });
  assert.deepEqual(pp, []);
  assert.deepEqual([plan.stop.price, plan.stop.ticks, plan.target.price], [21528.75, 46, 21563.25]);
  // The model citing the origin itself gives the same plan (the buffer is added once).
  const o = checkReads({ reads: F.READS.map(x => (x.step === 'stop' ? { ...x, read: 'stop mtf 21529' } : x)), side: 'long', briefing: F.briefing(), tick: 0.25, entryRule: RULE, mtfMode: F.MODE('A') });
  assert.equal(o.ok, true, problems(o));
  assert.equal(o.stop.level, 21529);
});

test('a non-MTF entry under today\'s arm (D) keeps today\'s rule: the 4h down refuses the scenario-1 long; under arm A it is refused for the mode', () => {
  const b = F.briefing({ h1: DOWN4H });
  const c = checkReads({ reads: LC.READS, side: 'long', briefing: b, tick: 0.25, entryRule: RULE });
  assert.equal(c.ok, false);
  assert.match(problems(c), /entry rule: the 4h trend is down, against the long/);
  const a = checkReads({ reads: LC.READS, side: 'long', briefing: F.briefing(), tick: 0.25, entryRule: RULE, mtfMode: F.MODE('A') });
  assert.equal(a.ok, false);
  assert.match(problems(a), /entry mode mtf_only \(arm A\): only an MTF ready entry/);
});

test('fails closed: no mode (today) refuses the MTF reads; a refused (live) mode; against the 1h; withheld; another model; a stop off the structural stop; no record', () => {
  const no = (o, re) => { const r = run(o); assert.equal(r.ok, false, JSON.stringify(o)); assert.match(problems(r), re); };
  no({ x: { mtfMode: undefined } }, /the MTF entry reads are not in this entry mode \(arm D, today\)/);
  no({ x: { mtfMode: ME.modeOf({ arm: 'D', exitMode: 'trail', minStage: 'established' }, {}, { isReplay: () => false }) } }, /the MTF entry reads are not in this entry mode \(arm D, today\)/);
  no({ x: { mtfMode: ME.modeOf({ arm: 'A', exitMode: 'trail', minStage: 'established' }, {}, { isReplay: () => false }) } }, /runs only in a replay/);
  no({ b: { mtf: { side1h: 'short', entry: { side: 'short' } } } }, /against the 1h structure \(short only\)/);
  no({ b: { mtf: { withheld: 'stop traded' } } }, /withheld: stop traded/);
  no({ x: { reads: F.READS.map(r => (r.step === 'setup' ? { ...r, read: 'mtf ready balanced long' } : r)) } }, /the ready candidate is aggressive, not balanced/);
  no({ x: { reads: F.READS.map(r => (r.step === 'stop' ? { ...r, read: 'stop mtf 21520' } : r)) } }, /mtf is 21529 \(its structural stop 21528\.75\), not 21520/);
  no({ b: { m3: { mtfStructure: undefined } } }, /no MTF structure record/);
  // `stop mtf` without the MTF setup read is still the candidate's stop only in an MTF arm.
  const d = checkReads({ reads: LC.READS.map(r => (r.step === 'stop' ? { ...r, read: 'stop mtf 21528.75' } : r)), side: 'long', briefing: F.briefing(), tick: 0.25, entryRule: RULE });
  assert.equal(d.ok, false);
});

test('`target trail` on an MTF entry: the 1h structure\'s side (the 4h+1h rule not read); on any other entry: today\'s TRAIL_RULE', () => {
  const ok = run({ b: { h1: { h4: { trend: 'down' }, h1: { trend: 'down' } } } });
  assert.equal(ok.reads.find(r => r.step === 'target').check, true, problems(ok));
  const today = checkReads({ reads: LC.READS.map(r => (r.step === 'target' ? { ...r, read: 'target trail' } : r)), side: 'long', briefing: F.briefing({ h1: { h4: { trend: 'down' } } }), tick: 0.25, mtfMode: F.MODE('C') });
  assert.equal(today.reads.find(r => r.step === 'target').check, false);
});

test('arm D (no mode, the default): every existing combination checks exactly as before (scenario 1 and the cited setup)', () => {
  for (const [reads, b, cited] of [[LC.READS, LC.briefing(), null], [LC.S2_READS, LC.s2Briefing(), ['momentum_continuation']]]) {
    const before = checkReads({ reads, side: 'long', briefing: b, tick: 0.25, entryRule: RULE, cited });
    const d = checkReads({ reads, side: 'long', briefing: b, tick: 0.25, entryRule: RULE, cited, mtfMode: ME.modeOf({ arm: 'D', exitMode: 'trail', minStage: 'established' }, {}, { isReplay: () => false }) });
    assert.deepEqual(d, before);
  }
});

test('an MTF entry\'s stop is its structural stop only (another level refused); its record carries the candidate (rank, trigger, target)', () => {
  const r = run({ x: { reads: F.READS.map(x => (x.step === 'stop' ? { ...x, skill: 'invalidation', read: 'stop 15m low 21512.75' } : x)) } });
  assert.equal(r.ok, false);
  assert.match(problems(r), /an MTF entry's stop is its candidate's structural stop: state "stop mtf <price>"/);
  const ok = run();
  assert.equal(ok.ok, true, problems(ok));
  assert.deepEqual([ok.mtf.arm, ok.mtf.model, ok.mtf.rank, ok.mtf.trigger.kind, ok.mtf.target, ok.mtf.stop, ok.mtf.side1h], ['A', 'aggressive', 1, 'CHoCH', 21598, 21528.75, 'long']);
  const { buildRecord } = require('../../scripts/lib/trading/trade-lifecycle');
  const b = F.briefing();
  const planned = planOf({ checked: ok, briefing: b, side: 'long', size: 1, tick: 0.25, tickValue: 0.5, minRR: 2, maxRiskUsd: 300, stopRule: lifecycleStopRule() });
  const rec = buildRecord({ at: LC.CLOSE, root: 'MNQ', symbol: 'MNQ', side: 'long', briefing: b, checked: ok, planned, validBars: 2 });
  assert.equal(rec.ok, true);
  assert.equal(rec.mtf.target, 21598);
  // A record without an MTF candidate has no mtf key (every existing record unchanged).
  const plain = buildRecord({ at: LC.CLOSE, root: 'MNQ', symbol: 'MNQ', side: 'long', briefing: LC.briefing(), checked: checkReads({ reads: LC.READS, side: 'long', briefing: LC.briefing(), tick: 0.25 }), planned: null, validBars: 2 });
  assert.equal('mtf' in plain, false);
});

// ---- an MTF entry cites no setup ([mtf-cited]), takes only `target trail` ([mtf-target]), and its
// plan's stop is the candidate's structural stop ([mtf-stop], mtf-entry.js mtfPlanProblems): never a fallback to non-MTF.
test('[mtf-cited]: a `fired` read beside the `mtf ready` read is refused by name; no MTF candidate is recorded', () => {
  const b = F.briefing({ m3: { candidates: [{ ...LC.S2_CANDIDATE, trendRule: 'refuses' }] } });
  Object.assign(b.sections.m3.data.candles['3m'], { rangeAtr: 1.2, volRatio: 1.3 });
  const reads = F.READS.concat([{ step: 'setup', skill: 'momentum-and-volume', read: 'momentum_continuation fired up', why: 'x' }]);
  const r = checkReads({ reads, side: 'long', briefing: b, tick: 0.25, entryRule: RULE, mtfMode: F.MODE('A'), cited: ['momentum_continuation'] });
  assert.equal(r.ok, false);
  // The message (the reading lesson: the model read the old one as a requirement to cite): what was wrong and what to do.
  assert.ok(problems(r).includes('[mtf-cited] you cited a setup beside an MTF entry: an MTF entry cites no setup (the candidate line is the setup). Remove the "<strategy> fired" read and compose again with the MTF reads only; no entry'), problems(r));
  assert.equal(r.mtf, undefined);
});

test('[mtf-target]: an MTF entry\'s target is `target trail` only (the exit option manages the rest)', () => {
  const r = run({ x: { reads: F.READS.map(x => (x.step === 'target' ? { ...x, read: 'target 1h swing 21598.00' } : x)) } });
  assert.equal(r.ok, false);
  assert.match(problems(r), /\[mtf-target\] an MTF entry's target is "target trail"/);
  assert.equal(r.mtf, undefined);
});

test('mtfPlanProblems ([mtf-stop]): the plan\'s stop must be the candidate\'s structural stop (the buffer added once); none for a non-MTF check', () => {
  const ME2 = require('../../scripts/lib/trading/mtf-entry');
  const ok = run();
  assert.deepEqual(ME2.mtfPlanProblems(ok, { stop: { price: 21528.75 } }), []);
  assert.match(ME2.mtfPlanProblems(ok, { stop: { price: 21528.5 } })[0], /\[mtf-stop\] the plan's stop 21528.5 is not the MTF candidate's structural stop 21528.75/);
  assert.match(ME2.mtfPlanProblems(ok, null)[0], /\[mtf-stop\] no plan/);
  assert.deepEqual(ME2.mtfPlanProblems({ ok: true }, { stop: { price: 1 } }), []);
});

// The owner's rule (2026-11-18, "stop placement locked"): the stop is the trigger structure's invalidation point (the
// CISD's, BOS's or CHoCH's origin, a tick beyond: the D3 buffer once). For every trading arm and every trigger type the
// plan's stop is the printed structural stop, from `stop mtf` only; the stop's ATR on the line is display only.
test('the plan\'s stop is the printed structural stop for every arm (A, B, AB) and trigger type (aggressive CHoCH and CISD, early, balanced BOS, conservative BOS); `stop mtf` is its only source', () => {
  const kinds = [
    { model: 'aggressive', by: 'CHoCH', stage: 'WEAKENING' },
    { model: 'aggressive', by: 'CISD', stage: 'WEAKENING' },
    { model: 'aggressive', by: 'CHoCH', stage: 'POTENTIAL', early: 'POTENTIAL' },
    { model: 'balanced', by: 'BOS', stage: 'REVERSING' },
    { model: 'conservative', by: 'BOS', stage: 'CONFIRMED REVERSAL' },
  ];
  const since = new Date(Date.parse(LC.CLOSE) - 180000).toISOString();
  for (const arm of ['A', 'B', 'AB']) {
    for (const k of kinds) {
      const mode = F.MODE(arm, { minStage: k.early ? 'potential' : 'established' });
      const entry = { model: k.model, by: k.by, ...(k.early ? { early: k.early } : {}) };
      const rec = F.record({ mode, stage: k.stage, entry });
      if (arm !== 'A') {
        const ex = F.record({ mode, stage: k.stage, entry });
        ex.hierarchy = 'execution';
        ex.mode = ME.recordMode(mode, { execution: true });
        ex.windowStart = '2026-10-06T00:00:00.000Z';
        rec.execution = { record: ex, since };
      }
      const b = F.briefing({ m3: { mtfStructure: rec } });
      const reads = F.READS.map(x => (x.step === 'setup' ? { ...x, read: `mtf ready ${k.model} long` } : x));
      const r = checkReads({ reads, side: 'long', briefing: b, tick: 0.25, entryRule: RULE, mtfMode: mode });
      const tag = `${arm} ${k.model} ${k.by}${k.early ? ' early' : ''}`;
      assert.equal(r.ok, true, `${tag}: ${problems(r)}`);
      const { plan } = planOf({ checked: r, briefing: b, side: 'long', size: 1, tick: 0.25, tickValue: 0.5, minRR: 2, maxRiskUsd: 300, stopRule: lifecycleStopRule() });
      const printed = /structural stop ([\d.]+)/.exec(ME.candidateLines(rec, mode, { price: 21540.25 }).find(l => l.startsWith('- MTF candidate LONG')))[1];
      assert.deepEqual([plan.stop.price, plan.stop.source], [Number(printed), 'mtf'], tag);
      assert.equal(plan.stop.price, 21528.75, `${tag}: the origin 21529 a tick beyond`);
      assert.deepEqual([r.mtf && r.mtf.stop, ME.mtfPlanProblems(r, plan)], [21528.75, []], tag);
    }
  }
  // Any other stop read on an MTF entry is refused: the structural stop is the only source.
  for (const read of ['stop swing low', 'stop 3m bos 21520', 'stop mtf 21520']) {
    const r = run({ x: { reads: F.READS.map(x => (x.step === 'stop' ? { ...x, read } : x)) } });
    assert.equal(r.ok, false, read);
  }
});
