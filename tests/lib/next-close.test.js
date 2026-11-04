'use strict';

// "Possible at the next close" (scripts/lib/trading/next-close.js, docs/PREPARE-AHEAD.md): the prepare briefing's list
// of what can fire at the next close, its triggers on the closing candle, and the plans. The at-close truth is always
// the real code: the rules engine's momentum series and the scan for momentum_continuation, the at-close briefing's
// setup moment for a 15m reaction, compose's plan and the Standard plan for the plans.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const NC = require('../../scripts/lib/trading/next-close');
const B = require('../../scripts/lib/trading/briefing');
const CF = require('../../scripts/lib/trading/candle-facts');
const { atr: atrOf, ATR_PERIOD } = require('../../scripts/lib/trading/indicators');
const { loadStrategies, scan } = require('../../scripts/lib/trading/strategies');
const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
const SM = require('../../scripts/lib/learning/setup-moments');
const { standardPlans, composeAt } = require('../../scripts/lib/learning/setup-library');
const FX = require('../fixtures/momentum-continuation');

const ROOT = path.resolve(__dirname, '..', '..');
const REG = loadStrategies(ROOT, {}).strategies;
const S2 = REG.find(s => s.name === 'momentum_continuation');
const TL = REG.find(s => s.name === 'trade_lifecycle');
const POLICY = REG.find(s => s.signal === 'policy' && s.valid && (s.strategies || []).includes('momentum_continuation'));
// The account's sizing facts as PR B passes them: the composed cap, the rulebook's floor, slippage and stretch; MNQ's
// tick value; no fees in this fixture.
const SIZING = { capUsd: TL.risk.max_risk_usd, floor: POLICY.sizing.min_contracts, tickValue: 0.5, slipTicks: POLICY.sizing.stop_slippage_ticks, feePerSide: 0, stretchUsd: POLICY.sizing.floor_stretch_max_usd };
const TICK = 0.25;
const BARS = FX.load();
const at = t => BARS.findIndex(b => b.t === t);
const EV = createEvaluator(BARS);
const MOM = CF.candleSeries(BARS, 3, 3).htfd_momentum;

const briefingOf = (bars, extra = {}) => B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, scan: scan(REG, bars, { symbol: 'MNQ' }), ...extra });
/** The section prepared at bar i's close (for bar i + 1), from the closed bars only. */
const sectionAt = (i, extra = {}) => {
  const bars = BARS.slice(0, i + 1);
  return NC.possibleAtNextClose({ symbol: 'MNQ', bars, minutes: 3, briefing: B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, scan: [] }), flat: true, registry: REG, sizing: SIZING, ...extra });
};
const morning = i => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(BARS[i].t)); const m = Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value); return m >= 576 && m <= 714; };
const FROM = at(FX.CENSUS[0][0]) - 1;

test('next close: the momentum basis excludes the closing candle (ATR(14) as of the candle before, the 20 volumes before it), as the rule reads it', () => {
  const cs = CF.completedSeries(BARS, 3, 3).candles;
  const atr = atrOf(cs, ATR_PERIOD);
  for (const j of [FROM, FROM + 7, cs.length - 1]) {
    const next = CF.nextBasisOf(cs.slice(0, j));
    const own = CF.basisOf(cs, j, atr);
    assert.deepStrictEqual(next, own, `candle ${j}`);
    assert.strictEqual(next.atrPrev, atr[j - 1], 'the ATR as of the candle before it');
    assert.strictEqual(next.avg, cs.slice(j - 20, j).reduce((a, c) => a + c.v, 0) / 20, 'the mean of the 20 volumes before it');
    // factsOf (what the rules engine reads) is factOf on that basis.
    const f = CF.factsOf(cs.slice(0, j + 1))[j];
    const g = CF.factOf(cs[j], own);
    assert.deepStrictEqual([g.rangeAtr, g.volRatio, g.closeLocation], [f.rangeAtr, f.volRatio, f.closeLocation]);
  }
});

test('next close: the momentum trigger is met exactly when the rules engine reads momentum on the closing candle (every bar, both sides)', () => {
  const cs = CF.completedSeries(BARS, 3, 3).candles;
  const atr = atrOf(cs, ATR_PERIOD);
  let up = 0;
  let down = 0;
  // The base bars are the candles (one per bar on the grid): candle j is bar j.
  assert.strictEqual(cs.length, BARS.length);
  for (let j = FROM; j < cs.length; j += 1) {
    const basis = CF.basisOf(cs, j, atr);
    for (const dir of ['up', 'down']) {
      const cand = { kind: 'momentum', trigger: { dir, basis } };
      const truth = MOM[j] === (dir === 'up' ? 1 : -1);
      assert.strictEqual(NC.triggerMet(cand, BARS[j]), truth, `${BARS[j].t} ${dir}`);
      // The stated thresholds say the same (whole-contract volumes): the range in ticks, the volume, the far third.
      const t = NC.momentumThresholds(basis, dir, TICK, BARS[j - 1].c);
      const b = BARS[j];
      const stated = Math.round((b.h - b.l) / TICK) >= t.ticks && b.v >= t.volume && CF.closeLocation(b) === (dir === 'up' ? 'top' : 'bottom');
      assert.strictEqual(stated, truth, `${b.t} ${dir}: the stated thresholds`);
      if (truth) { if (dir === 'up') up += 1; else down += 1; }
    }
  }
  assert.ok(up > 20 && down > 20, `both sides met on the fixture (${up} up, ${down} down)`);
});

test('next close: synthetic closing candles just below, at and just above each threshold, both sides, against the real rule (and the rounding band)', () => {
  for (const [t, side] of [['2021-05-24T13:45:00.000Z', 'long'], ['2021-05-20T13:39:00.000Z', 'short']]) {
    const i = at(t);
    const sub = BARS.slice(0, i + 1);
    const sec = sectionAt(i);
    const c = sec.candidates.find(x => x.kind === 'momentum' && x.side === side);
    assert.ok(c, `${t}: a ${side} momentum candidate`);
    const up = side === 'long';
    const o = sub[i].c;
    const next = sec.next.t;
    const bar = (ticks, v, back = 0) => {
      const far = o + (up ? 1 : -1) * ticks * TICK;
      const close = far - (up ? 1 : -1) * back * TICK;
      return { t: next, o, h: up ? far : o, l: up ? o : far, c: close, v };
    };
    const rule = b => CF.candleSeries([...sub, b], 3, 3).htfd_momentum[sub.length] === (up ? 1 : -1);
    const { ticks, volume } = c.trigger;
    const cases = [[ticks - 1, volume * 2], [ticks, volume * 2], [ticks + 1, volume * 2], [ticks, volume - 1], [ticks, volume], [ticks, volume + 1]];
    for (const [k, v] of cases) {
      const b = bar(k, v);
      assert.strictEqual(NC.triggerMet(c, b), rule(b), `${t} ${k} ticks vol ${v}`);
      assert.strictEqual(NC.triggerMet(c, b), k >= ticks && v >= volume, `${t} ${k} ticks vol ${v}: the thresholds`);
    }
    // The far third: the close stepped back from the extreme tick by tick, until it leaves the third.
    const wide = ticks * 3;
    let back = 0;
    while (CF.closeLocation(bar(wide, volume, back + 1)) === (up ? 'top' : 'bottom')) back += 1;
    for (const k of [back, back + 1]) assert.strictEqual(NC.triggerMet(c, bar(wide, volume, k)), rule(bar(wide, volume, k)), `${t} close ${k} ticks back`);
    assert.deepStrictEqual([NC.triggerMet(c, bar(wide, volume, back)), NC.triggerMet(c, bar(wide, volume, back + 1))], [true, false]);
    // The rounding band: a volume just under the average reads 1.00x (rounded) in the briefing, momentum shown, but the
    // rule reads the unrounded ratio: no momentum, no trigger.
    let v = volume - 1;
    while (v > 0 && Math.round((v / c.trigger.basis.avg) * 100) / 100 >= 1 && Math.round(((v - 1) / c.trigger.basis.avg) * 100) / 100 >= 1) v -= 1;
    const band = bar(ticks + 2, v);
    if (Math.round((v / c.trigger.basis.avg) * 100) / 100 >= 1) {
      assert.strictEqual(rule(band), false);
      assert.strictEqual(NC.triggerMet(c, band), false);
      const shown = B.buildBriefing({ symbol: 'MNQ', bars: [...sub, band], minutes: 3, scan: [] }).sections.m3.data.candles['3m'].momentum;
      assert.strictEqual(shown, up ? 'up' : 'down', 'the rounded read shows momentum');
    }
    // The scan itself (the at-close Setups line): fires at the threshold, not a tick under.
    const fires = b => { const r = scan([S2], [...sub, b], { symbol: 'MNQ' })[0]; return r.candidate && r.direction === side; };
    assert.deepStrictEqual([fires(bar(ticks - 1, volume)), fires(bar(ticks, volume)), fires(bar(ticks, volume - 1))], [false, true, false], t);
  }
});

test('next close: over the census sessions, a listed momentum candidate fires at the close iff its trigger is met (its preconditions held), and every fire was listed', () => {
  // Every census fire (the bar before it prepares it), and a seeded sample of the morning's other bars.
  const fires = new Set(FX.CENSUS_BG.map(([t]) => at(t)));
  const others = [];
  for (let i = FROM + 1; i < BARS.length; i += 1) if (morning(i) && !fires.has(i)) others.push(i);
  const sample = others.filter((_i, k) => (k * 7919) % 23 === 0);
  assert.ok(sample.length >= 8, `${sample.length} sampled bars`);
  let flips = 0;
  for (const i of [...fires, ...sample]) {
    const sec = sectionAt(i - 1);
    const r = EV.at(S2, i, { describe: false });
    const fired = r.candidate ? r.direction : null;
    for (const side of ['long', 'short']) {
      const c = sec.candidates.find(x => x.kind === 'momentum' && x.side === side);
      const met = c ? NC.triggerMet(c, BARS[i]) : false;
      if (fired === side) assert.ok(c && met, `${BARS[i].t}: fired ${side}, so listed and met`);
      if (c && met && fired !== side) {
        // Only a precondition moving with the closing candle (the side, the window) can stop it.
        const failed = (r.rules && r.rules[side] ? r.rules[side] : []).filter(x => !x.ok).map(x => x.rule);
        assert.ok(failed.length && failed.every(x => c.preconditions.includes(x)), `${BARS[i].t} ${side}: met but not fired (${failed.join(', ') || r.filtersFailed.join('; ')})`);
        flips += 1;
      }
      if (c && !met) assert.notStrictEqual(fired, side);
    }
  }
  assert.strictEqual(flips, 0, 'no precondition flipped on these bars');
});

test('next close: at a 15m close, a listed reaction fires at the close (the at-close setup moment) iff its trigger is met, at the threshold and a tick short', () => {
  let n = 0;
  for (const t of ['2021-05-24T13:39:00.000Z', '2021-05-21T13:54:00.000Z']) {
    const i = at(t);
    const sub = BARS.slice(0, i + 1);
    const sec = sectionAt(i);
    const reactions = sec.candidates.filter(c => c.kind === 'reaction');
    assert.ok(reactions.length, `${t}: reactions in reach`);
    const listed = b => {
      const m3 = B.buildBriefing({ symbol: 'MNQ', bars: [...sub, b], minutes: 3, scan: [] }).sections.m3.data;
      return SM.setupMoment(m3.candles, { barClose: Date.parse(sec.next.closedAt) }).reactions;
    };
    const has = (list, c) => list.some(r => r.name === c.name && r.rel === c.rel && r.dir === c.dir);
    // The actual closing bar.
    const actual = listed(BARS[i + 1]);
    for (const c of reactions) assert.strictEqual(has(actual, c), NC.triggerMet(c, BARS[i + 1]), `${t} ${c.read}: the actual close`);
    // The threshold candle fires it; a tick short of the close does not.
    for (const c of reactions.slice(0, 3)) {
      const th = c.threshold.bar;
      assert.ok(NC.triggerMet(c, th) && has(listed(th), c), `${c.read}: the threshold candle`);
      const away = c.trigger.closeOp === '>=' ? -TICK : TICK;
      const short = { ...th, c: th.c + away, h: Math.max(th.h, th.c + away), l: Math.min(th.l, th.c + away) };
      assert.strictEqual(NC.triggerMet(c, short), false, `${c.read}: a tick short`);
      assert.strictEqual(has(listed(short), c), false, `${c.read}: a tick short, the at-close read`);
      n += 1;
    }
  }
  assert.ok(n >= 3);
});

test('next close: each candidate\'s plan is the at-close plan of a candle meeting its trigger (compose\'s for momentum, the Standard plan\'s for a reaction)', () => {
  const i = at('2021-05-24T13:39:00.000Z');
  const sub = BARS.slice(0, i + 1);
  const sec = sectionAt(i);
  const mom = sec.candidates.find(c => c.kind === 'momentum');
  const bm = briefingOf([...sub, mom.threshold.bar]);
  const setup = bm.sections.m3.data.candidates.find(x => x.name === 'momentum_continuation' && x.direction === mom.side);
  const p = mom.threshold.plan;
  assert.strictEqual(p.status, 'ok');
  // The Setups line's own numbers: entry at the close, its stop (ceil to ticks), its target 2R of it.
  assert.strictEqual(p.entry.price, bm.sections.m3.data.price);
  assert.strictEqual(p.entry.type, 'market');
  assert.strictEqual(p.stop.ticks, Math.ceil(setup.stopPoints / TICK - 1e-9));
  assert.strictEqual(p.target.ticks, setup.exit.targetR * p.stop.ticks);
  assert.ok(p.size && p.size.fits && p.size.capSize >= SIZING.floor, 'the floor fits at $300');
  for (const c of sec.candidates.filter(x => x.kind === 'reaction')) {
    const b = B.buildBriefing({ symbol: 'MNQ', bars: [...sub, c.threshold.bar], minutes: 3, scan: [] });
    const plans = standardPlans(b);
    const mine = plans.find(x => x.side === c.side);
    const reaction = SM.setupMoment(b.sections.m3.data.candles, { barClose: Date.parse(sec.next.closedAt) }).reactions.find(r => r.name === c.name && r.rel === c.rel);
    const expect = mine && mine.reaction.name === c.name ? mine : composeAt(b, reaction, { side: c.side, tick: TICK, mark: true });
    if (expect.plan) {
      assert.deepStrictEqual([c.threshold.plan.entry.price, c.threshold.plan.stop.price, c.threshold.plan.target.price, c.threshold.plan.rr], [expect.plan.entry.price, expect.plan.stop.price, expect.plan.target.price, expect.plan.rr], c.read);
      assert.deepStrictEqual(c.threshold.reads, expect.reads.map(r => r.read), `${c.read}: the reads parse as the Standard plan's`);
    } else assert.strictEqual(c.threshold.plan.status, expect.status, c.read);
  }
});

test('next close: no look-ahead (the forming and later bars rewritten, the section is identical) and deterministic', () => {
  const i = at('2021-05-24T13:39:00.000Z');
  const a = sectionAt(i);
  const rewritten = BARS.map((b, k) => (k > i ? { ...b, o: b.o + 50, h: b.h + 400, l: b.l - 400, c: b.c - 75, v: b.v * 9 } : b));
  const bars = rewritten.slice(0, i + 1);
  const b = NC.possibleAtNextClose({ symbol: 'MNQ', bars, minutes: 3, briefing: B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, scan: [] }), flat: true, registry: REG, sizing: SIZING });
  assert.deepStrictEqual(b, a);
  assert.deepStrictEqual(sectionAt(i), a, 'the same inputs, the same section');
  // A briefing that isn't these bars' is refused, never read as the bars'.
  assert.throws(() => NC.possibleAtNextClose({ symbol: 'MNQ', bars: BARS.slice(0, i + 2), minutes: 3, briefing: B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, scan: [] }), flat: true }), /built from these closed bars/);
});

test('next close: only for a flat account; no entries at the next close or nothing that can fire is the NONE marker', () => {
  const i = at('2021-05-24T13:45:00.000Z');
  const bars = BARS.slice(0, i + 1);
  const briefing = B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, scan: [] });
  for (const flat of [false, undefined, 'yes']) assert.strictEqual(NC.possibleAtNextClose({ symbol: 'MNQ', bars, minutes: 3, briefing, flat, registry: REG }), null, String(flat));
  // The opening print: the next close (09:33) allows no entry.
  const op = sectionAt(at('2021-05-24T13:27:00.000Z'));
  assert.deepStrictEqual(op.candidates, []);
  assert.match(op.none, /no entries at the next close: opening print/);
  assert.match(NC.possibleLines(op).join('\n'), /^- Possible at the next close: NONE \(/);
  // A news blackout over the next close.
  const nb = sectionAt(i, { blackouts: { items: [{ start: '2021-05-24T13:50:00.000Z', end: '2021-05-24T14:00:00.000Z', reason: 'test event' }] } });
  assert.match(nb.none, /a news blackout at the next close \(test event\)/);
  // After the momentum window, at a close that completes no 15m candle: nothing can fire.
  const late = sectionAt(at('2021-05-21T16:03:00.000Z'));
  assert.deepStrictEqual(late.candidates, []);
  assert.match(late.none, /momentum_continuation long: its rules don't fire long with the threshold candle \(minute_et <= 714\)/);
  assert.strictEqual(NC.NONE, 'NONE');
});

test('next close: the prepare briefing is the briefing\'s text with the section after the summary; the at-close briefing is untouched', () => {
  const i = at('2021-05-24T13:39:00.000Z');
  const bars = BARS.slice(0, i + 1);
  const b = B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, scan: [] });
  const now = new Date(b.closedAt);
  const plain = B.renderBriefing(b, { now });
  assert.strictEqual(NC.renderPrepareBriefing(b, null, { now }), plain, 'no section: the briefing as it is');
  const sec = NC.possibleAtNextClose({ symbol: 'MNQ', bars, minutes: 3, briefing: b, flat: true, registry: REG, sizing: SIZING });
  const text = NC.renderPrepareBriefing(b, sec, { now });
  const lines = NC.possibleLines(sec);
  assert.strictEqual(text.replace(`\n${lines.join('\n')}`, ''), plain, 'only the section added');
  assert.ok(text.indexOf(lines[0]) < text.indexOf('Detail by timeframe:') && text.indexOf(lines[0]) > text.indexOf('Summary ('));
  assert.ok(!plain.includes(NC.SECTION), 'the at-close briefing never has it');
  assert.match(lines[0], /^- Possible at the next close \(the 3m bar 09:42-09:45 ET, from the bars closed by 09:42 ET;/);
  assert.match(text, /P1 momentum_continuation long "momentum_continuation fired up": fires if the closing 3m candle has range >= /);
  assert.match(text, /15m long "15m broke overnight high up": fires if the 15m candle \(opened 09:30, open 16845\.25, so far high 16916 low 16829\.75\) closes at or above 16868/);
});
