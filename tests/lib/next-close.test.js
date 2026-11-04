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
  const symbol = extra.symbol || 'MNQ';
  return NC.possibleAtNextClose({ symbol, bars, minutes: 3, briefing: B.buildBriefing({ symbol, bars, minutes: 3, scan: [] }), flat: true, registry: REG, sizing: SIZING, ...extra });
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
      const cand = { kind: 'momentum', trigger: { dir, basis, at: BARS[j].t } };
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
    const v = volume - 1;
    assert.ok(v / c.trigger.basis.avg < 1 && Math.round((v / c.trigger.basis.avg) * 100) / 100 >= 1, `${t}: one contract under the threshold is in the rounding band`);
    const band = bar(ticks + 2, v);
    assert.strictEqual(rule(band), false);
    assert.strictEqual(NC.triggerMet(c, band), false);
    const shown = B.buildBriefing({ symbol: 'MNQ', bars: [...sub, band], minutes: 3, scan: [] }).sections.m3.data.candles['3m'];
    assert.deepStrictEqual([shown.volRatio, shown.momentum], [1, up ? 'up' : 'down'], 'the rounded read shows 1x and momentum');
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

test('next close: at a 15m close, a listed reaction fires at the close (the at-close setup moment) iff its trigger is met: both sides, just short, at and past each threshold', () => {
  const sides = new Set();
  let extremes = 0;
  for (const t of ['2021-05-24T13:39:00.000Z', '2021-05-21T13:54:00.000Z', '2021-05-20T13:39:00.000Z']) {
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
    for (const c of reactions) {
      sides.add(c.side);
      const th = c.threshold.bar;
      const closeAt = (b, x) => ({ ...b, c: x, h: Math.max(b.h, x), l: Math.min(b.l, x) });
      const way = c.trigger.closeOp === '>=' ? TICK : -TICK;
      const variants = [['at', th, true], ['a tick short of the close', closeAt(th, th.c - way), false], ['a tick past the close', closeAt(th, th.c + way), true]];
      // A rejection not traded beyond yet: its extreme a tick short of the level's far side.
      if (c.rel === 'rejected' && !c.trigger.tradedBeyond) {
        const ext = c.trigger.extreme;
        const shortOf = c.trigger.extremeOp === '<=' ? { ...th, l: Math.min(th.o, th.c, ext + TICK) } : { ...th, h: Math.max(th.o, th.c, ext - TICK) };
        variants.push(['its extreme a tick short', shortOf, false]);
        extremes += 1;
      }
      for (const [what, b, expect] of variants) {
        assert.strictEqual(NC.triggerMet(c, b), expect, `${c.read}: ${what}`);
        assert.strictEqual(has(listed(b), c), expect, `${c.read}: ${what}, the at-close read`);
      }
    }
  }
  assert.deepStrictEqual([...sides].sort(), ['long', 'short'], 'both sides');
  assert.ok(extremes >= 1, 'a rejection that has not traded beyond yet');
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

test('next close: no look-ahead: a bundle holding the forming or later bars is refused (fail closed), whatever they hold; the same closed bars give the same section', () => {
  const i = at('2021-05-24T13:39:00.000Z');
  const closed = BARS.slice(0, i + 1);
  const briefing = B.buildBriefing({ symbol: 'MNQ', bars: closed, minutes: 3, scan: [] });
  const call = bars => () => NC.possibleAtNextClose({ symbol: 'MNQ', bars, minutes: 3, briefing, flat: true, registry: REG, sizing: SIZING });
  // The runner's whole series (the forming bar and later ones in it), as served and rewritten to anything: never read.
  const rewritten = BARS.map((b, k) => (k > i ? { ...b, o: b.o + 50, h: b.h + 400, l: b.l - 400, c: b.c - 75, v: b.v * 9 } : b));
  for (const bars of [BARS, rewritten, BARS.slice(0, i + 2), rewritten.slice(0, i + 2)]) assert.throws(call(bars), /built from these closed bars/);
  // The closed bars alone: the section; again, the same section.
  const a = call(closed)();
  assert.ok(a.candidates.length);
  assert.deepStrictEqual(call(closed)(), a, 'deterministic');
  // Every threshold candle opens at the next bar's open (the bar forming), never later.
  for (const c of a.candidates) assert.strictEqual(c.threshold.bar.t, a.next.t, c.read);
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

test('next close: the scan is the runner\'s: the selected contract (a mini) and the next close as its time', () => {
  // The runner's scan: the lane's strategies, its symbols selected (runner-wiring.js runnerScan). A selected NQ lists the
  // same momentum candidate an MNQ run does.
  const i = at('2021-05-24T13:45:00.000Z');
  const mnq = sectionAt(i);
  const nq = sectionAt(i, { symbol: 'NQ', selected: ['NQ'], sizing: { ...SIZING, tickValue: 5 } });
  const m = mnq.candidates.find(c => c.kind === 'momentum');
  const q = nq.candidates.find(c => c.kind === 'momentum');
  assert.ok(m, 'MNQ lists it');
  assert.ok(q, `a selected NQ lists it too (${nq.none || nq.skipped.join('; ')})`);
  assert.deepStrictEqual([q.side, q.trigger.ticks, q.trigger.volume, q.threshold.plan.stop.ticks], [m.side, m.trigger.ticks, m.trigger.volume, m.threshold.plan.stop.ticks]);
  // The lane's strategies only: without momentum_continuation in them, nothing of it.
  const lane = sectionAt(i, { strategies: REG.filter(s => s.name !== 'momentum_continuation') });
  assert.ok(!lane.candidates.some(c => c.kind === 'momentum'));
});

test('next close: the momentum window\'s edges, by the next bar\'s open (minute_et) and the gate\'s clock at the next close', () => {
  const listed = t => sectionAt(at(t)).candidates.some(c => c.kind === 'momentum');
  // The next bar opens 09:33 (no), 09:36 (yes), 11:54 (yes), 11:57 (no): the prepare runs at the close before it.
  assert.deepStrictEqual(['2021-05-21T13:30:00.000Z', '2021-05-21T13:33:00.000Z', '2021-05-21T15:51:00.000Z', '2021-05-21T15:54:00.000Z'].map(listed), [false, true, true, false]);
  // A gate window ending exactly at the next close allows the entry there (its end is open); a minute later, none.
  const i = at('2021-05-24T13:45:00.000Z');
  const ends = end => sectionAt(i, { clock: { entryHours: '', noEntryWindows: `09:48-${end}@America/New_York` } });
  assert.strictEqual(ends('09:51').none, null, 'the window ends at the 09:51 close');
  assert.match(ends('09:52').none, /no entries at the next close/);
});

test('next close: the momentum plan is compose_check\'s, with the attempt policy\'s entry rule (on and off) and the attempt flag', () => {
  const fs = require('fs');
  const prop = require('../../scripts/lib/trading/prop-state');
  const { accountNamed } = require('../../scripts/lib/trading/accounts');
  const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
  const { composeCheck } = require('../../scripts/lib/harness-tools/compose');
  const { readRecords } = require('../../scripts/lib/trading/trade-lifecycle');
  const { tmpDir, recordBrokerSpecs } = require('../helpers');
  const acct = POLICY.account;
  const rootWith = key => {
    const r = tmpDir();
    for (const s of ['trade_lifecycle', 'prop_portfolio', 'momentum_continuation']) fs.cpSync(path.join(ROOT, 'strategies', s), path.join(r, 'strategies', s), { recursive: true });
    fs.cpSync(path.join(ROOT, 'accounts', acct), path.join(r, 'accounts', acct), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'skills'), path.join(r, 'skills'));
    const book = path.join(r, 'accounts', acct, 'RULEBOOK.md');
    const text = fs.readFileSync(book, 'utf8');
    if (key) { assert.match(text, new RegExp(`^ {6}${key}: off `, 'm')); fs.writeFileSync(book, text.replace(new RegExp(`^( {6}${key}: )off`, 'm'), '$1on')); }
    return r;
  };
  const seen = new Set();
  for (const key of [null, 'regime_against', 'leg_turned']) {
    const r = rootWith(key);
    const reg = loadStrategies(r, {}).strategies;
    const policy = reg.find(s => s.name === 'prop_portfolio');
    const entryRule = entryRuleOf(policy.entry);
    for (const t of ['2021-05-18T13:42:00.000Z', '2021-05-24T13:45:00.000Z', '2021-05-21T13:51:00.000Z']) {
      const i = at(t);
      const sub = BARS.slice(0, i + 1);
      const sec = sectionAt(i, { registry: reg, entryRule, inAttempt: true });
      const c = sec.candidates.find(x => x.kind === 'momentum');
      assert.ok(c, `${t}: listed`);
      // compose_check itself on the threshold candle's briefing, in a running attempt of that policy.
      const w = [...sub, c.threshold.bar];
      const pb = B.buildBriefing({ symbol: 'MNQ', bars: w, minutes: 3, scan: scan(reg, w, { symbol: 'MNQ' }) });
      const home = tmpDir();
      recordBrokerSpecs(home);
      B.writeBriefing(home, pb);
      const account = accountNamed(r, acct, {});
      prop.startAttempt(home, account, new Date(Date.parse(pb.closedAt) - 3600000));
      prop.snapshot(home, account, account.starting_balance, new Date(Date.parse(pb.closedAt) - 3500000));
      const h = pb.sections.h1.data;
      const way = c.side === 'long' ? 'up' : 'down';
      const bias = h.h4.trend === way ? `4h ${way}` : `1h ${h.h1.trend}`;
      const reads = [{ step: 'bias', skill: 'mtf-bias-filter', read: bias }, { step: 'location', skill: 'levels-and-reactions', read: `vwap ${pb.sections.m3.data.vwap.side}` },
        ...c.threshold.reads.map((read, k) => ({ step: ['setup', 'entry', 'stop', 'target'][k], skill: ['trade-lifecycle', 'candle-reading', 'invalidation', 'take-profit'][k], read }))];
      const ctx = { env: { FTH_HOME: home, FTH_CYCLE_BARS: JSON.stringify({ MNQ: pb.asOf }) }, now: () => new Date(Date.parse(pb.closedAt) + 5000), root: r };
      composeCheck({ symbol: 'MNQ', side: c.side, reads, size: SIZING.floor }, ctx);
      const rec = readRecords(home, 'MNQ').pop();
      const entryProblem = rec.problems.find(p => /^entry rule:/.test(p));
      assert.strictEqual(c.threshold.plan.status === 'ok', rec.ok, `${key || 'off'} ${t}: the section's plan OK iff compose's (${rec.problems.join('; ')} | ${c.threshold.plan.why || ''})`);
      if (entryProblem) assert.strictEqual(c.threshold.plan.why, entryProblem, 'the same refusal');
      seen.add(rec.ok ? 'ok' : 'refused');
    }
  }
  assert.deepStrictEqual([...seen].sort(), ['ok', 'refused'], 'both outcomes exercised');
});

test('next close: a cited setup in paper status is a candidate only in a paper run (citedSetups { paper })', () => {
  const i = at('2021-05-24T13:45:00.000Z');
  const paperReg = REG.map(s => (s.name === 'momentum_continuation' ? { ...s, status: 'paper' } : s));
  assert.ok(!sectionAt(i, { registry: paperReg }).candidates.some(c => c.kind === 'momentum'), 'a live run: not cited');
  assert.ok(sectionAt(i, { registry: paperReg, paper: true }).candidates.some(c => c.kind === 'momentum'), 'a paper run: cited');
});

test('next close: a reaction\'s edges: a level exactly at the high or low so far, an open exactly on the level, the open-time levels', () => {
  // A level exactly at the high so far: not traded above it yet (relation's rejection needs a high beyond).
  const f = { t: '2021-05-24T13:30:00.000Z', o: 100, h: 110, l: 95 };
  const rej = NC.reactionKinds(f, 110, NaN, TICK).find(k => k.rel === 'rejected');
  assert.deepStrictEqual([rej.dir, rej.facts.tradedBeyond, rej.facts.extreme], ['down', false, 110.25]);
  const rejLow = NC.reactionKinds(f, 95, NaN, TICK).find(k => k.rel === 'rejected');
  assert.deepStrictEqual([rejLow.dir, rejLow.facts.tradedBeyond, rejLow.facts.extreme], ['up', false, 94.75]);
  // In reach: a level exactly at the high or the low so far is inside the range; the nearest beyond each side too.
  const levels = [['a', 95], ['b', 110], ['c', 120], ['d', 130], ['e', 90], ['f', 80]];
  assert.deepStrictEqual(NC.reachOf(levels, f).map(([n]) => n), ['a', 'b', 'c', 'e']);
  // An open exactly on the level: where price came from is the previous candle's close (relation's rule).
  const on = { kind: 'reaction', trigger: { rel: 'broke', dir: 'up', level: 100, candle: { o: 100, h: 101, l: 99 }, prevClose: 99, at: 'x' } };
  assert.strictEqual(NC.triggerMet(on, { t: 'x', h: 102, l: 100, c: 101.5 }), true);
  assert.strictEqual(NC.triggerMet({ ...on, trigger: { ...on.trigger, prevClose: 101 } }, { t: 'x', h: 102, l: 100, c: 101.5 }), false, 'from above, no break up');
  // The levels as they stood at the candle's open: a 15m swing low its own bars broke still counts (2021-05-17 09:30).
  const s = sectionAt(at('2021-05-17T13:39:00.000Z'));
  const named = [...s.candidates.map(c => c.read), ...s.skipped].join('\n');
  assert.match(named, /15m swing low 16637\.25/);
});

test('next close: hardening: absurd prints end at once with a reason; a zero average says so; a trigger tests only its own bar', { timeout: 10000 }, () => {
  const prev = { o: 1, h: 2, l: 1, c: 2, v: 1 };
  for (const [basis, why] of [[{ prev, atrPrev: 1e300, avg: 1e300, n: 20 }, /no range reads as momentum/], [{ prev, atrPrev: Infinity, avg: 100, n: 20 }, /the ATR\(14\) of the candles before it is unknown/],
    [{ prev, atrPrev: 10, avg: Infinity, n: 20 }, /the average volume of the candles before it is unknown/]]) {
    assert.match(NC.momentumThresholds(basis, 'up', TICK, 100).reason || '', why, JSON.stringify(basis));
  }
  assert.match(NC.momentumThresholds({ prev, atrPrev: 10, avg: 0, n: 20 }, 'up', TICK, 100).reason, /average volume of the candles before it is 0/);
  // A data gap: the bar that closes next isn't the one the trigger was prepared for.
  const sec = sectionAt(at('2021-05-24T13:39:00.000Z'));
  for (const c of sec.candidates) {
    assert.strictEqual(NC.triggerMet(c, c.threshold.bar), true, c.read);
    assert.strictEqual(NC.triggerMet(c, { ...c.threshold.bar, t: new Date(Date.parse(c.threshold.bar.t) + 180000).toISOString() }), false, `${c.read}: another bar`);
  }
});

test('next close: the threshold candle is scanned at the next close (a strategy session ending exactly there leaves it out, as the close\'s scan does)', () => {
  const i = at('2021-05-24T13:45:00.000Z');
  const withSession = end => REG.map(s => (s.name === 'momentum_continuation' ? { ...s, sessions: [`09:30-${end}@America/New_York`] } : s));
  const listed = end => sectionAt(i, { registry: withSession(end) }).candidates.some(c => c.kind === 'momentum');
  // The next bar 09:48-09:51: its scan at 09:51 is out of a session ending 09:51 (its end is open), in one ending 09:52.
  assert.deepStrictEqual([listed('09:51'), listed('09:52')], [false, true]);
  const w = [...BARS.slice(0, i + 1), sectionAt(i).candidates.find(c => c.kind === 'momentum').threshold.bar];
  const atClose = scan(withSession('09:51'), w, { symbol: 'MNQ', now: new Date('2021-05-24T13:51:00.000Z') }).find(r => r.name === 'momentum_continuation');
  assert.strictEqual(atClose.candidate, false, 'the at-close scan agrees');
});
