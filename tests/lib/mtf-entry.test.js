'use strict';

// P1 (feat/p1-mtf-entries): the MTF entry arm's one home (scripts/lib/trading/mtf-entry.js): the arm's mode from
// config/runner.json mtfEntry, refused outside a replay until the owner opts in; the candidates per side from each of
// the arm's hierarchies (the 1h side, never against it; one per side, the earliest), ranked in the 1h leg; readyOf, the
// fail-closed check an MTF entry passes on the cycle bar's briefing; the entry-mode refusals; the size hint; the lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const ME = require('../../scripts/lib/trading/mtf-entry');
const M = require('../../scripts/lib/trading/mtf-structure');
const { analysis } = require('../../scripts/lib/tunables');
const W = require('../fixtures/mtf-structure/world');

const AN = analysis();
const OPTS = { tick: 0.25, bufferTicks: 1, equalAtr: AN.marketState.equalAtr, k: AN.indicators.swingK, depth: AN.mtfStructure.depth, warmBars: 0, hierarchy: 'intraday' };
const CFG = (arm, over = {}) => ({ arm, exitMode: 'trail', entryPullback: 'any', minStage: 'established', ...over });
const REPLAY = { isReplay: () => true };
const LIVE = { isReplay: () => false };
const mode = (arm = 'A', over = {}) => ME.modeOf(CFG(arm, over), {}, REPLAY);
const A = W.world({ keys: W.KEYS, events: W.EVENTS });
const recsOf = (m, o = {}) => M.recordsOf({ ...OPTS, bars: A.bars, minutes: A.base, levels: [A.level, A.below], sideMode: 'parent', prims: A.prims, mode: ME.recordMode(m), ...o });
const J = A.at(25, 1); // aggressive ready LONG (WEAKENING), stop 129.75, trigger CHoCH
const close = j => new Date(Date.parse(A.bars[j].t) + A.base * 60000).toISOString();
// An execution record (arm B's 1m one) stands in as the same world's record, its side the 1h's (sideMode rule).
const execOf = (m, j, o = {}) => M.recordsOf({ ...OPTS, bars: A.bars, minutes: A.base, levels: [A.level, A.below], sideMode: 'rule', side: 'long', prims: A.prims, mode: ME.recordMode(m, { execution: true }), ...o })[j];
// The bar's close at the trigger's (drift 0): the world's 3m CHoCH at (25, 1) closed at 131.5 (the stop 129.75 a 1.75-point R).
const PX = 131.5;
const trigOf = rec => { const p = rec && rec.levels ? rec.levels.find(l => l.role === 'primary') : null; const e = p && p.entry; return e && Number.isFinite(e.triggerClose) ? e.triggerClose : PX; };
// The bar's close: the record's own (its entry's trigger time plus its age), as the briefing's closedAt.
const closeOfRec = rec => { const p = rec && rec.levels ? rec.levels.find(l => l.role === 'primary') : null; const e = p && p.entry; return e && e.since ? new Date(Date.parse(e.since.at) + e.since.minAgo * 60000).toISOString() : '2022-01-04T09:21:00.000Z'; };
const briefingOf = rec => ({ symbol: 'MNQ', minutes: 3, closedAt: closeOfRec(rec), sections: { m3: { data: { price: trigOf(rec), mtfStructure: rec } } } });
const withExec = (m, j, rec = recsOf(m)[j], x = {}) => ({ ...rec, execution: { record: execOf(m, j), since: close(j - 1), ...x } });

test('modeOf: the five arms; D is today; an MTF arm outside a replay is refused (live is the owner\'s call), never a silent fallback', () => {
  assert.deepEqual(Object.keys(ME.ARMS), ['A', 'B', 'AB', 'D']);
  assert.deepEqual(ME.ARMS.A.hierarchies, ['intraday']);
  assert.deepEqual(ME.ARMS.B.hierarchies, ['execution']);
  assert.deepEqual(ME.ARMS.AB.hierarchies, ['intraday', 'execution']);
  const d = ME.modeOf(CFG('D'), {}, LIVE);
  assert.deepEqual([d.entryMode, d.mtf, d.refused, d.sideMode], ['today', false, null, 'rule']);
  const a = mode('A');
  assert.deepEqual([a.entryMode, a.mtf, a.refused, a.sideMode], ['mtf_only', true, null, 'parent']);
  for (const arm of ['A', 'B', 'AB']) assert.match(ME.modeOf(CFG(arm), {}, LIVE).refused, new RegExp(`arm ${arm} runs only in a replay until the owner opts in`));
  for (const bad of [null, {}, CFG('E'), CFG('A', { minStage: 'weakening' }), CFG('A', { exitMode: 'x' }), CFG('A', { entryPullback: 'x' }), CFG('D', { minStage: 'potential' })]) {
    const m = ME.modeOf(bad, {}, REPLAY);
    assert.ok(m.refused && m.mtf, JSON.stringify(bad));
  }
  assert.equal(ME.replayRun({}), false, 'no replay clock: live');
  assert.deepEqual(ME.recordMode(a), { arm: 'A', entryMode: 'mtf_only', hierarchies: ['intraday'], exitMode: 'trail', entryPullback: 'any', minStage: 'established' });
  assert.equal(ME.recordMode(mode('A', { entryPullback: 'first' }), { execution: true }).entryPullback, 'any', 'the execution record: first applied on the 1h rank');
});

test('candidatesOf, arm A: the intraday primary\'s ready (stage, trigger, rank in the 1h leg, stop, age); the side the 1h structure\'s', () => {
  const m = mode('A');
  const c = ME.candidatesOf(recsOf(m)[J], m, { price: trigOf(recsOf(m)[J]) });
  assert.equal(c.side1h, 'long');
  assert.equal(c.list.length, 1);
  const x = c.list[0];
  assert.deepEqual([x.hierarchy, x.timing, x.side, x.model, x.stage, x.early, x.trigger.kind, x.trigger.frame, x.rank, x.stop, x.withheld],
    ['intraday', '3m', 'long', 'aggressive', 'WEAKENING', null, 'CHoCH', '3m', 1, 129.75, null]);
  assert.equal(x.age.barsAgo, 0);
  assert.equal(c.chosen.long, x);
  assert.equal(c.chosen.short, null);
});

test('candidatesOf, arm AB: one per side, the earliest; a tie goes to the intraday; the execution candidate is ranked in the 1h leg and must be fresh (a 1m trigger since the previous close)', () => {
  const m = mode('AB');
  const rec = withExec(m, J);
  const c = ME.candidatesOf(rec, m, { price: trigOf(rec) });
  assert.deepEqual(c.list.map(x => x.hierarchy), ['intraday', 'execution']);
  assert.equal(c.chosen.long.hierarchy, 'intraday', 'equal times: the intraday');
  assert.equal(c.list[1].timing, '1m');
  assert.equal(c.list[1].trigger.frame, '1m');
  assert.equal(c.list[1].rank, 1, 'its rank: its pullbacks since the 1h leg\'s break');
  // The intraday one later: the execution one is the earliest.
  const later = JSON.parse(JSON.stringify(rec));
  later.levels.find(l => l.role === 'primary').entry.since.at = close(J + 1);
  assert.equal(ME.candidatesOf(later, m, { price: trigOf(later) }).chosen.long.hierarchy, 'execution');
  // Stale (fired before the previous close): withheld, the intraday chosen.
  const stale = withExec(m, J, undefined, { since: close(J) });
  const cs = ME.candidatesOf(stale, m, { price: trigOf(stale) });
  assert.equal(cs.list[1].withheld, 'no 1m trigger since the previous close');
  assert.equal(cs.chosen.long.hierarchy, 'intraday');
});

test('candidatesOf: first-only uses the 1h-leg rank (the intraday record\'s own rule; the execution one counted here); a rank not known is withheld', () => {
  const m = mode('B', { entryPullback: 'first' });
  const rec = withExec(m, J);
  const x = ME.candidatesOf(rec, m, { price: trigOf(rec) }).list[0];
  assert.deepEqual([x.rank, x.withheld], [1, null]);
  const two = JSON.parse(JSON.stringify(rec));
  const pb = two.execution.record.levels.find(l => l.role === 'primary').pullbacks;
  pb.unshift({ at: pb[0].at, way: 'down' });
  assert.deepEqual([ME.candidatesOf(two, m, { price: trigOf(two) }).list[0].rank, ME.candidatesOf(two, m, { price: trigOf(two) }).list[0].withheld], [2, 'not first']);
  const noLeg = JSON.parse(JSON.stringify(rec));
  noLeg.levels.find(l => l.role === 'primary').parent.leg = null;
  assert.equal(ME.candidatesOf(noLeg, m, { price: trigOf(noLeg) }).list[0].withheld, 'rank unknown');
});

test('readyOf: an MTF long on the chosen candidate goes; the record carries the candidate', () => {
  const m = mode('A');
  const r = ME.readyOf({ briefing: briefingOf(recsOf(m)[J]), side: 'long', mode: m, model: 'aggressive' });
  assert.equal(r.problem, null);
  assert.equal(r.ok, true);
  assert.deepEqual([r.candidate.model, r.candidate.stop, r.candidate.rank, r.side1h], ['aggressive', 129.75, 1, 'long']);
});

test('readyOf fails closed: refused mode, today, no record, unavailable, another arm\'s record, against the 1h, no 1h side, no candidate, withheld, wrong model, bad side', () => {
  const m = mode('A');
  const rec = recsOf(m)[J];
  const no = (o, re) => { const r = ME.readyOf({ briefing: briefingOf(rec), side: 'long', mode: m, model: 'aggressive', ...o }); assert.equal(r.ok, false, JSON.stringify(o)); assert.match(r.problem, re); };
  no({ mode: ME.modeOf(CFG('A'), {}, LIVE) }, /runs only in a replay/);
  no({ mode: ME.modeOf(CFG('D'), {}, LIVE) }, /not an MTF entry arm/);
  no({ briefing: briefingOf(undefined) }, /no MTF structure record/);
  no({ briefing: { sections: {} } }, /no MTF structure record/);
  no({ briefing: briefingOf({ unavailable: 'no stop rule' }) }, /MTF structure unavailable: no stop rule/);
  no({ briefing: briefingOf({ ...rec, mode: undefined }) }, /built under another entry arm/);
  no({ mode: mode('A', { entryPullback: 'first' }) }, /built under another entry arm/);
  no({ mode: mode('A', { minStage: 'potential' }) }, /built under another entry arm/);
  no({ side: 'short' }, /against the 1h structure \(long only\): never against the 1h/);
  no({ side: 'up' }, /side must be long or short/);
  no({ briefing: briefingOf({ ...rec, sides: { ...rec.sides, parent: null } }) }, /no 1h structure/);
  const lv = x => ({ ...rec, levels: rec.levels.map(l => (l.role === 'primary' ? { ...l, ...x } : l)) });
  no({ briefing: briefingOf(lv({ partial: true, entry: null })) }, /no ready MTF candidate the 1h's way \(long\)/);
  no({ briefing: briefingOf(lv({ entry: null })) }, /no ready MTF candidate the 1h's way \(long\)/);
  for (const w of ['warning', 'stop traded', 'not first', 'rank unknown', 'against the side', 'no side']) no({ briefing: briefingOf(lv({ entryWithheld: w })) }, new RegExp(`withheld: ${w}`));
  no({ model: 'balanced' }, /the ready candidate is aggressive, not balanced/);
  no({ model: undefined }, /the ready candidate is aggressive, not undefined/);
  no({ briefing: briefingOf({ ...rec, levels: rec.levels.filter(l => l.role !== 'primary') }) }, /no ready MTF candidate/);
  // Arm B: no execution record, or one unavailable (no 1m bars): refused with the reason.
  const mb = mode('B');
  const rb = recsOf(mb)[J];
  const noB = (br, re) => { const r = ME.readyOf({ briefing: br, side: 'long', mode: mb, model: 'aggressive' }); assert.equal(r.ok, false); assert.match(r.problem, re); };
  noB(briefingOf(rb), /arm B needs its 1m execution record/);
  noB(briefingOf({ ...rb, execution: { unavailable: 'no 1m data lane' } }), /1m execution: unavailable \(no 1m data lane\)/);
  assert.equal(ME.readyOf({ briefing: briefingOf(withExec(mb, J, rb)), side: 'long', mode: mb, model: 'aggressive' }).ok, true);
});

test('minStage: an early candidate (POTENTIAL, DEVELOPING) is a candidate only under its mode; its stage and trigger named', () => {
  const EARLY = W.world({ keys: W.KEYS, events: W.EVENTS.concat([{ f: 'timing', at: [19, 1], kind: 'CHoCH', dir: 1, swing: [18, 3], level: 140 }]) });
  const recs = m => M.recordsOf({ ...OPTS, bars: EARLY.bars, minutes: EARLY.base, levels: [EARLY.level, EARLY.below], sideMode: 'parent', prims: EARLY.prims, mode: ME.recordMode(m) });
  const j = EARLY.at(19, 1);
  const m0 = mode('A');
  assert.deepEqual(ME.candidatesOf(recs(m0)[j], m0, { price: trigOf(recs(m0)[j]) }).list, []);
  const md = mode('A', { minStage: 'developing' });
  const x = ME.candidatesOf(recs(md)[j], md, { price: trigOf(recs(md)[j]) }).list[0];
  assert.deepEqual([x.stage, x.early, x.trigger.kind, x.model], ['DEVELOPING', 'DEVELOPING', 'CHoCH', 'aggressive']);
  assert.equal(ME.readyOf({ briefing: briefingOf(recs(md)[j]), side: 'long', mode: md, model: 'aggressive' }).ok, true);
});

test('entryModeProblems: mtf_only refuses a non-MTF entry; today refuses the MTF reads; a refused mode every entry', () => {
  assert.deepEqual(ME.entryModeProblems({ mtf: true, mode: mode('A') }), []);
  assert.match(ME.entryModeProblems({ mtf: false, mode: mode('AB') })[0], /entry mode mtf_only \(arm AB\): only an MTF ready entry/);
  const d = ME.modeOf(CFG('D'), {}, LIVE);
  assert.deepEqual(ME.entryModeProblems({ mtf: false, mode: d }), []);
  assert.match(ME.entryModeProblems({ mtf: true, mode: d })[0], /the MTF entry reads are not in this entry mode \(arm D, today\)/);
  assert.match(ME.entryModeProblems({ mtf: false, mode: ME.modeOf(CFG('A'), {}, LIVE) })[0], /runs only in a replay/);
  assert.match(ME.entryModeProblems({ mtf: true, mode: ME.modeOf(null, {}, REPLAY) })[0], /mtfEntry/);
});

test('sizeHint: the stop in points and dollars all in, the contracts the cap fits, and the floor with its stretch (tick-correct, MNQ $0.50 a tick)', () => {
  // 12.25 points = 49 ticks; all in: (49 + 1 slip) x $0.50 + 2 x $0.37 fees = $25.74 a contract; $300 fits 11.
  const h = ME.sizeHint({ stopPts: 12.25, tick: 0.25, tickValue: 0.5, capUsd: 300, minContracts: 3, stretchUsd: 500, slipTicks: 1, feePerSide: 0.37 });
  assert.deepEqual([h.ticks, h.perContract, h.fits], [49, 25.74, 11]);
  assert.equal(h.text, '12.25 pts, $25.74 a contract all in; the $300 cap fits 11');
  // 50 points = 200 ticks: $101.24 a contract; $300 fits 2, under the floor of 3: 3 = $303.72 (within the $500 stretch while healthy).
  const w = ME.sizeHint({ stopPts: 50, tick: 0.25, tickValue: 0.5, capUsd: 300, minContracts: 3, stretchUsd: 500, slipTicks: 1, feePerSide: 0.37 });
  assert.equal(w.text, '50 pts, $101.24 a contract all in; the $300 cap fits 2, under the floor of 3: 3 = $303.72 (the $500 floor stretch only while the attempt is healthy, else skip)');
  const x = ME.sizeHint({ stopPts: 90, tick: 0.25, tickValue: 0.5, capUsd: 300, minContracts: 3, stretchUsd: 500, slipTicks: 1, feePerSide: 0.37 });
  assert.match(x.text, /under the floor of 3: 3 = \$543\.72, over the \$500 floor stretch: skip/);
  assert.equal(ME.sizeHint({ stopPts: 12.25, tick: 0.25, tickValue: null }).text, '12.25 pts (its dollars unknown: no contract specs)');
});

test('candidateLines: one line per READY candidate (side, model, stage, trigger, its age and drift, the context: turn, impulse, rank, structural depth; stop and its size, the 4h); none ready: one line saying why', () => {
  const m = mode('AB', { minStage: 'potential' });
  const rec = { ...withExec(m, J), context: { frame: '4h', way: 'down' } };
  const ls = ME.candidateLines(rec, m, { level: x => x, sizing: { tick: 0.25, tickValue: 0.5, capUsd: 300, minContracts: 3, stretchUsd: 500, slipTicks: 1, feePerSide: 0.37 }, price: PX });
  const cands = ls.filter(l => l.startsWith('- MTF candidate LONG'));
  assert.equal(cands.length, 2);
  assert.match(cands[0], /^- MTF candidate LONG \(chosen\): aggressive at stage WEAKENING, trigger 3m CHoCH up \d\d:\d\d \(new this bar\); drift 0R past the trigger; context: no turn: trend since \d\d:\d\d, 1 BOS; impulse /);
  // Tick-checked (MNQ $0.50 a tick): 131.5 - 129.75 = 1.75 pts = 7 ticks; all in (7 + 1 slippage) x $0.50 + 2 x $0.37 = $4.74; $300 fits 63.
  assert.match(cands[0], /; pullback #1 of this 1h leg; depth 40% \(moderate\): the stop 1\.75 pts away, the impulse extreme 18\.5 pts away; structural stop 129\.75: 1\.75 pts, \$4\.74 a contract all in; the \$300 cap fits 63; 4h structure DOWN \(context\)\.$/);
  // The owner's decision (2026-11-18): the three entries and the structure only: no draw, no premium or discount, no fib
  // zone, no ATR facts, no last break against, no trigger-candle label.
  assert.ok(!/zone|golden|room to the next|premium|discount|ATR\)|break against|displaced;/.test(cands[0]), cands[0]);
  assert.match(cands[1], /^- MTF candidate LONG: aggressive at stage WEAKENING, trigger 1m CHoCH up/);
  // The waiting models: one short clause, never a candidate line.
  assert.deepEqual(ls.filter(l => l.startsWith('- MTF waiting')), ['- MTF waiting: 3m balanced needs a 3m BOS up; 1m balanced needs a 1m BOS up.']);
  assert.ok(!ls.some(l => /NOT ready/.test(l)));
  const none = ME.candidateLines(recsOf(m)[A.end(20)], mode('A', { minStage: 'potential' }), { level: x => x, sizing: null, price: PX });
  assert.deepEqual(none, ['- MTF candidate: none ready the 1h\'s way (LONG).', '- MTF waiting: 3m aggressive needs a 3m CHoCH or CISD up.']);
  const noSide = ME.candidateLines({ ...recsOf(mode('A'))[J], sides: { rule: null, parent: null } }, mode('A'), { level: x => x, sizing: null, price: PX });
  assert.deepEqual(noSide, ['- MTF candidate: none (no 1h structure: no MTF entry).']);
});

test('candidateLines: a withheld candidate is void, said plainly, one word for every reason ("candidate void (<reason>)"), never printed as a candidate', () => {
  const m = mode('A');
  const lv = x => { const r = recsOf(m)[J]; return { ...r, levels: r.levels.map(l => (l.role === 'primary' ? { ...l, ...x } : l)) }; };
  assert.deepEqual(ME.candidateLines(lv({ entryWithheld: 'stop traded', stopTraded: { et: '10:05' } }), m, { level: x => x, price: PX }).slice(0, 1), ['- MTF candidate: none ready the 1h\'s way (LONG); 3m aggressive: candidate void (stop traded).']);
  assert.match(ME.candidateLines(lv({ entryWithheld: 'not first' }), m, { level: x => x, price: PX })[0], /3m aggressive: candidate void \(not first: #1 of this 1h leg\)\./);
});

test('candidateLines: over the budget the context\'s cleanness goes first, then the turn\'s times; the facts that decide stay', () => {
  const m = mode('A');
  const rec = recsOf(m)[J];
  const full = ME.candidateLines(rec, m, { level: x => x, price: PX })[0];
  const cut1 = ME.candidateLines(rec, m, { level: x => x, price: PX, bytes: Buffer.byteLength(full) - 1 })[0];
  assert.ok(!/cleanness/.test(cut1) && /impulse /.test(cut1) && /pullback #1/.test(cut1) && /structural stop 129\.75/.test(cut1), cut1);
  const cut2 = ME.candidateLines(rec, m, { level: x => x, price: PX, bytes: 50 })[0];
  assert.ok(/no turn, 1 BOS/.test(cut2) && /structural stop 129\.75/.test(cut2) && /drift 0R/.test(cut2) && /depth 40% \(moderate\)/.test(cut2), cut2);
});

test('candidatesOf, execution: a POTENTIAL (not developed) takes the rank it would have, the next in the 1h leg', () => {
  const m = mode('B', { minStage: 'potential', entryPullback: 'first' });
  const rec = withExec(m, J);
  const p = rec.execution.record.levels.find(l => l.role === 'primary');
  p.instance = { ...p.instance, developing: null };
  p.pullbacks = [];
  assert.deepEqual([ME.candidatesOf(rec, m, { price: trigOf(rec) }).list[0].rank, ME.candidatesOf(rec, m, { price: trigOf(rec) }).list[0].withheld], [1, null]);
  p.pullbacks = [{ at: rec.levels.find(l => l.role === 'primary').parent.leg.at, way: 'down' }];
  assert.deepEqual([ME.candidatesOf(rec, m, { price: trigOf(rec) }).list[0].rank, ME.candidatesOf(rec, m, { price: trigOf(rec) }).list[0].withheld], [2, 'not first']);
});

test('startProblems: an MTF arm outside a replay refuses to start; an arm reading the execution hierarchy needs the 1m data lane; today and arm A need nothing', () => {
  assert.deepEqual(ME.startProblems({ mode: ME.modeOf(CFG('D'), {}, LIVE), minuteDataLane: false }), []);
  assert.deepEqual(ME.startProblems({ mode: mode('A'), minuteDataLane: false }), []);
  for (const arm of ['B', 'AB']) {
    assert.match(ME.startProblems({ mode: mode(arm), minuteDataLane: false })[0], new RegExp(`arm ${arm} reads the 1m execution frame: add a 1m data lane`));
    assert.deepEqual(ME.startProblems({ mode: mode(arm), minuteDataLane: true }), []);
  }
  assert.match(ME.startProblems({ mode: ME.modeOf(CFG('A'), {}, LIVE), minuteDataLane: true })[0], /runs only in a replay/);
});

test('replayRun : true only under a replay clock the harness accepts; FTH_REPLAY_NOW with a live or no broker, or a refused wall start, is live; loadConfig judges the arm on its caller\'s env', () => {
  const fs = require('fs');
  const path = require('path');
  const { tmpDir } = require('../helpers');
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { description: 'replayed history', command: ['node', 'sim.js'], replay: true } } }));
  const at = '2026-03-02T15:30:00Z';
  assert.equal(ME.replayRun({ FTH_HOME: home, FTH_REPLAY_NOW: at }), true);
  const live = tmpDir();
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ broker: 'sim', brokers: { sim: { description: 'live', command: ['node', 'sim.js'] } } }));
  assert.equal(ME.replayRun({ FTH_HOME: live, FTH_REPLAY_NOW: at }), false, 'a live broker: no replay clock');
  assert.equal(ME.replayRun({ FTH_BROKERS_FILE: '/nonexistent/brokers.json', FTH_REPLAY_NOW: at }), false, 'no broker config');
  assert.equal(ME.replayRun({ FTH_HOME: home, FTH_REPLAY_NOW: at, FTH_REPLAY_WALL_START: 'soon' }), false, 'a refused wall start');
  assert.equal(ME.replayRun({ FTH_HOME: home }), false, 'no FTH_REPLAY_NOW');
  const { loadConfig } = require('../../scripts/lib/trading/config');
  assert.equal(loadConfig({ FTH_HOME: home }).mtfMode.arm, 'D', 'the committed arm (today)');
});

test('an execution candidate whose 1h leg began before the 1m window has no rank (its earlier pullbacks unseen); under first it is withheld', () => {
  const m = mode('B', { entryPullback: 'first' });
  const rec = withExec(m, J);
  const legAt = rec.levels.find(l => l.role === 'primary').parent.leg.at;
  rec.execution.record.windowStart = new Date(Date.parse(legAt) + 60000).toISOString();
  const x = ME.candidatesOf(rec, m, { price: trigOf(rec) }).list[0];
  assert.deepEqual([x.rank, x.withheld], [null, 'rank unknown']);
  rec.execution.record.windowStart = new Date(Date.parse(legAt) - 60000).toISOString();
  assert.equal(ME.candidatesOf(rec, m, { price: trigOf(rec) }).list[0].rank, 1);
  // The module records its window's start in an MTF arm.
  const r = recsOf(m)[J];
  assert.equal(r.windowStart, A.bars[0].t);
});

// ---- the stale void (coordinator 2026-11-18: void at a drift over 0.5R). The stop is the structural one, never moved.
test('the stale void: a ready whose price ran past voidDriftR (config, 0.5) of its own stop beyond the trigger is void, said with the drift; no price or no trigger close: void (fails closed); readyOf refuses with no briefing price', () => {
  const m = mode('A');
  const rec = recsOf(m)[J];
  const unit = PX - 129.75; // 1.75
  const cases = [[PX, 0, null], [PX + 0.5 * unit, 0.5, null], [PX + 0.75 * unit, 0.75, 'ran past'], [PX - unit, -1, null]];
  for (const [price, drift, withheld] of cases) {
    const x = ME.candidatesOf(rec, m, { price }).list[0];
    assert.deepEqual([x.driftR, x.withheld], [drift, withheld], String(price));
  }
  assert.equal(ME.candidatesOf(rec, m, {}).list[0].withheld, 'drift unknown');
  const noTrig = { ...rec, levels: rec.levels.map(l => (l.role === 'primary' ? { ...l, entry: { ...l.entry, triggerClose: undefined } } : l)) };
  assert.equal(ME.candidatesOf(noTrig, m, { price: PX }).list[0].withheld, 'drift unknown');
  const line = ME.candidateLines(rec, m, { level: x => x, price: PX + 0.75 * unit })[0];
  assert.equal(line, '- MTF candidate: none ready the 1h\'s way (LONG); 3m aggressive: candidate void (price ran 0.75R past the trigger).');
  const b = briefingOf(rec);
  assert.equal(ME.readyOf({ briefing: b, side: 'long', mode: m, model: 'aggressive' }).ok, true);
  b.sections.m3.data.price = PX + unit;
  assert.match(ME.readyOf({ briefing: b, side: 'long', mode: m, model: 'aggressive' }).problem, /withheld: ran past/);
  delete b.sections.m3.data.price;
  assert.match(ME.readyOf({ briefing: b, side: 'long', mode: m, model: 'aggressive' }).problem, /no price \(m3\.price\): the drift past the trigger is unknown/);
  assert.equal(require('../../scripts/lib/tunables').analysis().mtfStructure.voidDriftR, 0.5, 'the approved threshold (PARITY.md)');
});

test('a position open: no candidate is a pick (the line says so); the configured entry models only (mtfEntry.models): a model not listed never becomes a candidate', () => {
  const m = mode('A');
  const rec = recsOf(m)[J];
  const open = ME.candidateLines(rec, m, { level: x => x, price: PX, positionOpen: true })[0];
  assert.match(open, /^- MTF candidate LONG \(position open: not a pick\): /);
  assert.ok(!/\(chosen\)/.test(open));
  // The aggressive candidate at J: listed, it is a candidate; with balanced and conservative only, it is none (not void).
  assert.equal(ME.candidatesOf(rec, m, { price: PX, at: close(J) }).list[0].model, 'aggressive');
  const noAgg = mode('A', { models: ['balanced', 'conservative'] });
  assert.deepEqual(noAgg.models, ['balanced', 'conservative']);
  assert.deepEqual(ME.candidatesOf(recsOf(noAgg)[J], noAgg, { price: PX, at: close(J) }).list, []);
  assert.equal(ME.readyOf({ briefing: briefingOf(recsOf(noAgg)[J]), side: 'long', mode: noAgg, anyModel: true }).ok, false);
  assert.deepEqual(mode('A').models, ['aggressive', 'balanced', 'conservative'], 'a caller without the key: all three');
  for (const bad of [[], ['eager'], ['balanced', 'balanced'], 'balanced']) assert.match(ME.modeOf(CFG('A', { models: bad }), {}, REPLAY).refused, /models .* must list some of aggressive, balanced, conservative/, JSON.stringify(bad));
});

// The sticky void, on a real record after its trigger, both sides: the drift is
// read from the TRIGGER's close (never the current one), signed the trade's way, and the largest drift since the trigger
// voids it for good; a trigger from an earlier session never carries over; a trigger past maxAgeMin is void.
test('the sticky void on a real record: 0.57R past the trigger one bar after it is void, and stays void when the close comes back; the same for the mirrored SHORT', () => {
  const m = mode('A');
  for (const mirror of [false, true]) {
    // The bar after the 3m CHoCH at (25, 1) closes 1 point past the trigger's close 131.5 (the stop 129.75: 1.75 a R), the
    // next one back at 131.5.
    const Wv = W.world({ keys: W.KEYS, events: W.EVENTS, mirror, overrides: { [J + 1]: { c: 132.5 } } });
    const rs = M.recordsOf({ ...OPTS, bars: Wv.bars, minutes: Wv.base, levels: [Wv.level, Wv.below], sideMode: 'parent', prims: Wv.prims, mode: ME.recordMode(m) });
    const at = j => new Date(Date.parse(Wv.bars[j].t) + Wv.base * 60000).toISOString();
    const side = mirror ? 'short' : 'long';
    const trig = mirror ? 300 - 131.5 : 131.5;
    const one = ME.candidatesOf(rs[J + 1], m, { price: Wv.bars[J + 1].c, at: at(J + 1) }).list[0];
    assert.deepEqual([one.side, one.trigger.price, one.driftR, one.withheld], [side, trig, 0.57, 'ran past'], `mirror ${mirror}`);
    const two = ME.candidatesOf(rs[J + 2], m, { price: Wv.bars[J + 2].c, at: at(J + 2) }).list[0];
    assert.deepEqual([two.driftR, two.maxDriftR, two.withheld], [0, 0.57, 'ran past'], `mirror ${mirror}: once void, always void`);
    assert.match(ME.candidateLines(rs[J + 2], m, { level: x => x, price: Wv.bars[J + 2].c, at: at(J + 2) })[0], /candidate void \(price ran 0\.57R past the trigger\)/);
    // A retrace toward the stop is never a void by drift.
    const back = W.world({ keys: W.KEYS, events: W.EVENTS, mirror, overrides: { [J + 1]: { c: 130.5 } } });
    const rb = M.recordsOf({ ...OPTS, bars: back.bars, minutes: back.base, levels: [back.level, back.below], sideMode: 'parent', prims: back.prims, mode: ME.recordMode(m) });
    const b1 = ME.candidatesOf(rb[J + 1], m, { price: back.bars[J + 1].c, at: at(J + 1) }).list[0];
    assert.deepEqual([b1.driftR, b1.withheld], [-0.57, null], `mirror ${mirror}: a retrace`);
  }
});

test('a trigger never carries across a session boundary, and one older than maxAgeMin (config, 60) is void, said plainly', () => {
  const m = mode('A');
  const rec = recsOf(m)[J];
  const nextDay = new Date(Date.parse(close(J)) + 86400000).toISOString();
  assert.equal(ME.candidatesOf(rec, m, { price: PX, at: nextDay }).list[0].withheld, 'previous session');
  assert.equal(require('../../scripts/lib/tunables').analysis().mtfStructure.maxAgeMin, 60);
  const aged = mins => ({ ...rec, levels: rec.levels.map(l => (l.role === 'primary' ? { ...l, entry: { ...l.entry, since: { ...l.entry.since, minAgo: mins } } } : l)) });
  assert.equal(ME.candidatesOf(aged(60), m, { price: PX, at: close(J) }).list[0].withheld, null);
  assert.equal(ME.candidatesOf(aged(61), m, { price: PX, at: close(J) }).list[0].withheld, 'too old');
  assert.match(ME.candidateLines(aged(61), m, { level: x => x, price: PX, at: close(J) })[0], /candidate void \(its trigger 61 min old, over the 60-minute cap\)/);
  assert.match(ME.candidateLines(rec, m, { level: x => x, price: PX, at: nextDay })[0], /candidate void \(its trigger was in an earlier session\)/);
  // readyOf: no close time refuses; a position open refuses.
  const b = briefingOf(rec);
  delete b.closedAt;
  assert.match(ME.readyOf({ briefing: b, side: 'long', mode: m, model: 'aggressive' }).problem, /no close time/);
  assert.match(ME.readyOf({ briefing: briefingOf({ ...rec, positionOpen: true }), side: 'long', mode: m, model: 'aggressive' }).problem, /a position is open/);
});

test('under prev_high_or_trail a previous high already behind the price says so (no exit target: the trail); one ahead prints its R', () => {
  const m = mode('A', { exitMode: 'prev_high_or_trail' });
  const rec = recsOf(m)[J];
  assert.match(ME.candidateLines(rec, m, { level: x => x, price: PX, at: close(J) })[0], /; previous high 150 \(the exit target\), 10\.57R\.$/);
  const behind = { ...rec, levels: rec.levels.map(l => (l.role === 'primary' ? { ...l, entry: { ...l.entry, target: 131, targetR: null } } : l)) };
  assert.match(ME.candidateLines(behind, m, { level: x => x, price: PX, at: close(J) })[0], /; previous high 131 already past \(no exit target: the trail\)/);
});

test('the candidate id is STABLE across cycles (the instance\'s opening time, the trigger\'s bar time, the model): the same candidate on the next bar keeps it, so a WAIT carries', () => {
  const m = mode('A');
  const rs = recsOf(m);
  const at = j => new Date(Date.parse(A.bars[j].t) + A.base * 60000).toISOString();
  const a = ME.candidatesOf(rs[J], m, { price: PX, at: at(J) }).list[0];
  const b = ME.candidatesOf(rs[J + 1], m, { price: A.bars[J + 1].c, at: at(J + 1) }).list[0];
  assert.match(a.instanceId, /^intraday\|\S+Z\|\S+Z\|aggressive$/);
  assert.equal(b.instanceId, a.instanceId);
  // No per-window sequence in it: the same instance under another sequence number keeps the id.
  const renum = { ...rs[J], levels: rs[J].levels.map(l => (l.role === 'primary' ? { ...l, instance: { ...l.instance, id: 99 } } : l)) };
  assert.equal(ME.candidatesOf(renum, m, { price: PX, at: at(J) }).list[0].instanceId, a.instanceId);
});
