'use strict';

// "Possible at the next close": the standing setups (scripts/lib/trading/next-close.js, docs/PREPARE-AHEAD.md). At a
// close that completes no 15m candle, the setup frame's last completed candle is the same one the close will read, so
// the reactions at a FIXED key level that the at-close "Setups to check" line lists are known now: each is a candidate
// whose trigger is "still standing and unchanged at the next close". The at-close truth is always the real code: the
// at-close briefing's listed reads (setup-moments.js listedReads) on the closed bars plus the closing bar.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const NC = require('../../scripts/lib/trading/next-close');
const B = require('../../scripts/lib/trading/briefing');
const SM = require('../../scripts/lib/learning/setup-moments');
const PA = require('../../scripts/lib/prepare-ahead');
const { trendRuleOf } = require('../../scripts/lib/trading/reasons');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { composeAt } = require('../../scripts/lib/learning/setup-library');
const FX = require('../fixtures/momentum-continuation');

const ROOT = path.resolve(__dirname, '..', '..');
const REG = loadStrategies(ROOT, {}).strategies;
const TICK = 0.25;
const BARS = FX.load();
const at = t => BARS.findIndex(b => b.t === t);
const FROM = at(FX.CENSUS[0][0]) - 1;
const Q = 15 * 60000;
// The moving levels and the gap edges (the test's own statement of them, not the module's): never a standing candidate.
const MOVING = /^(VWAP|session (POC|VAH|VAL))/;

const briefingOf = bars => B.buildBriefing({ symbol: 'MNQ', bars, minutes: 3, scan: [] });
const sectionAt = (i, extra = {}) => {
  const bars = BARS.slice(0, i + 1);
  return NC.possibleAtNextClose({ symbol: 'MNQ', bars, minutes: 3, briefing: briefingOf(bars), flat: true, registry: REG, ...extra });
};
/** The next close (the bar after i) completes a 15m candle. */
const completes15 = i => (Date.parse(BARS[i].t) + 2 * 180000) % Q === 0;
/** What the at-close briefing lists (its Setups to check, as reads), on the closed bars plus `bar`. */
const listedAt = (sub, bar) => SM.listedReads(briefingOf([...sub, bar]));
/** The at-close setup moment's reactions, on the closed bars plus `bar`. */
const reactionsAt = (sub, bar) => SM.setupMoment(briefingOf([...sub, bar]).sections.m3.data.candles, { barClose: Date.parse(bar.t) + 180000 }).reactions;
const readOf = r => `15m ${r.rel} ${require('../../scripts/lib/trading/composed-reads').levelName(r.name)} ${r.dir}`;
const morning = i => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(BARS[i].t)); const m = Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value); return m >= 576 && m <= 714; };

/** A seeded generator (mulberry32): the same closing bars every run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Closing bars at `t`, from the last close: random ranges and closes, huge ones, gaps far through every level, a flat one. */
function closingBars(t, last, rand) {
  const tick = k => Math.round(k) * TICK;
  const out = [];
  for (let k = 0; k < 3; k += 1) {
    const o = last.c + tick((rand() - 0.5) * 40);
    const c = o + tick((rand() - 0.5) * 160);
    out.push({ t, o, h: Math.max(o, c) + tick(rand() * 40), l: Math.min(o, c) - tick(rand() * 40), c, v: Math.round(rand() * 5000) });
  }
  out.push({ t, o: last.c, h: last.c + 400, l: last.c - 400, c: last.c + 399, v: 99999 });
  out.push({ t, o: last.c - 300, h: last.c - 290, l: last.c - 600, c: last.c - 590, v: 1 });
  return out;
}

// The sample: census mornings, closes that complete no 15m candle, every 9th (the same every run).
const SAMPLE = (() => {
  const xs = [];
  for (let i = FROM; i < BARS.length - 1; i += 1) if (morning(i + 1) && !completes15(i)) xs.push(i);
  return xs.filter((_i, k) => k % 9 === 0);
})();

test('next close, standing: a listed standing setup fires at the close iff its trigger is met (random, huge and gapping closing bars; another bar never), and every fixed-level setup the close lists on a side the trend rule allows was listed', { timeout: 600000 }, () => {
  const rand = rng(20261104);
  let fires = 0;
  let wrong = 0;
  let movingSeen = 0;
  let extrasSeen = 0;
  const sides = new Set();
  assert.ok(SAMPLE.length >= 15, `${SAMPLE.length} sampled closes`);
  for (const i of SAMPLE) {
    const sub = BARS.slice(0, i + 1);
    const sec = sectionAt(i);
    const standing = sec.candidates.filter(c => c.kind === 'standing');
    // A close that completes no 15m candle lists no v1 reaction: the two kinds never meet.
    assert.ok(!sec.candidates.some(c => c.kind === 'reaction'), `${BARS[i].t}: no reaction at a close that completes no 15m candle`);
    const rule = trendRuleOf(briefingOf(sub).sections.m3.data.trendRule);
    // The actual closing bar: what the close listed at a fixed key level, on an allowed side, is exactly the standing list.
    const actual = BARS[i + 1];
    const listed = listedAt(sub, actual);
    const fixed = reactionsAt(sub, actual).filter(r => r.kind === 'level' && !MOVING.test(r.name) && (r.dir === 'up' || r.dir === 'down'))
      .map(r => ({ read: readOf(r), side: r.dir === 'up' ? 'long' : 'short' })).filter(x => listed.includes(x.read) && rule[x.side] !== false);
    assert.deepStrictEqual(standing.map(c => c.read).sort(), [...new Set(fixed.map(x => x.read))].sort(), `${BARS[i].t}: the standing list is the close's fixed-level setups (${JSON.stringify(listed)})`);
    if (listed.some(r => /\bvwap\b|\bsession (poc|vah|val)\b|\bfvg\b/.test(r))) movingSeen += 1;
    if (listed.some(r => /compression|cisd/.test(r))) extrasSeen += 1;
    for (const c of standing) {
      assert.ok(!/\bvwap\b|\bsession (poc|vah|val)\b|\bfvg\b|compression|cisd/.test(c.read), `${c.read}: never a moving level, a gap edge or another setup`);
      assert.strictEqual(c.tf, '15m');
      sides.add(c.side);
      // Every closing bar at the next bar's open: listed at the close iff the trigger is met.
      for (const bar of [actual, c.threshold.bar, ...closingBars(sec.next.t, sub[i], rand)]) {
        const met = NC.triggerMet(c, bar);
        assert.strictEqual(met, listedAt(sub, bar).includes(c.read), `${BARS[i].t} ${c.read}: ${JSON.stringify(bar)}`);
        if (met) fires += 1;
      }
      // Another bar (a data gap: the bar that closes is a later one): never met.
      const later = { ...actual, t: new Date(Date.parse(sec.next.t) + 180000).toISOString() };
      assert.strictEqual(NC.triggerMet(c, later), false, `${c.read}: another bar`);
      wrong += 1;
    }
  }
  assert.ok(fires >= 40, `${fires} fires checked`);
  assert.ok(wrong >= 8, `${wrong} other bars checked`);
  assert.deepStrictEqual([...sides].sort(), ['long', 'short'], 'both sides');
  assert.ok(movingSeen >= 1, 'a close listing a moving level or a gap edge (left out)');
  assert.ok(extrasSeen >= 1, 'a close listing a compression break or a CISD (left out)');
});

test('next close, standing: none at a close that completes a 15m candle (its reaction is a v1 reaction there, the old candle superseded)', () => {
  for (const t of ['2021-05-24T13:39:00.000Z', '2021-05-20T13:39:00.000Z', '2021-05-17T14:24:00.000Z']) {
    const i = at(t);
    assert.ok(completes15(i), t);
    const sec = sectionAt(i);
    assert.ok(!sec.candidates.some(c => c.kind === 'standing'), `${t}: no standing candidate`);
  }
});

test('next close, standing: a side the trend rule refuses now is left out, with the reason', () => {
  // 2021-05-17 09:42 ET close: the 15m candle closed 09:45 rejected the overnight low up (a long) and the 15m swing high
  // down (a short); the trend rule allows shorts only.
  const i = at('2021-05-17T13:42:00.000Z');
  const sec = sectionAt(i);
  const reads = sec.candidates.filter(c => c.kind === 'standing').map(c => c.read);
  assert.ok(reads.includes('15m rejected 15m swing high 16664 down'), JSON.stringify(reads));
  assert.ok(!reads.includes('15m rejected overnight low up'));
  assert.ok(sec.skipped.some(s => /^15m rejected overnight low up: against the trend rule/.test(s)), sec.skipped.join('; '));
  assert.ok(!reads.some(r => /vwap/.test(r)), 'the VWAP left out');
});

test('next close, standing: its plan is the Standard plan of the at-close briefing on the threshold candle (composeAt, as standardPlans calls it), its reads the briefing\'s', () => {
  let checked = 0;
  for (const t of ['2021-05-17T13:42:00.000Z', '2021-05-17T14:57:00.000Z', '2021-05-17T15:42:00.000Z']) {
    const i = at(t);
    const sub = BARS.slice(0, i + 1);
    const sec = sectionAt(i);
    for (const c of sec.candidates.filter(x => x.kind === 'standing')) {
      const pb = briefingOf([...sub, c.threshold.bar]);
      const reaction = SM.setupMoment(pb.sections.m3.data.candles, { barClose: Date.parse(sec.next.closedAt) }).reactions.find(r => readOf(r) === c.read);
      assert.ok(reaction, c.read);
      const expect = composeAt(pb, reaction, { side: c.side, tick: TICK, mark: true });
      if (expect.plan) {
        assert.deepStrictEqual([c.threshold.plan.entry.price, c.threshold.plan.stop.price, c.threshold.plan.target.price, c.threshold.plan.rr], [expect.plan.entry.price, expect.plan.stop.price, expect.plan.target.price, expect.plan.rr], c.read);
        assert.deepStrictEqual(c.threshold.reads, expect.reads.map(r => r.read), c.read);
      } else assert.strictEqual(c.threshold.plan.status, expect.status, c.read);
      assert.strictEqual(c.threshold.bar.t, sec.next.t, 'the threshold candle opens at the next bar\'s open');
      checked += 1;
    }
  }
  assert.ok(checked >= 3, `${checked} plans`);
});

test('next close, standing: the close\'s own list decides: a fixed-level reaction its Setups line leaves out (one per price, its cap) is no candidate; a gap edge never is one', () => {
  // 2021-05-18 01:30 ET: the 15m candle broke the 1h and 15m swing highs at 16699.25, which the line leaves out (its
  // cap), and listed the overnight high and the 15m swing high at 16693: those two only.
  const i = at('2021-05-18T05:27:00.000Z');
  const sub = BARS.slice(0, i + 1);
  const listed = listedAt(sub, BARS[i + 1]);
  const unlisted = reactionsAt(sub, BARS[i + 1]).filter(r => r.kind === 'level' && /swing high 16699\.25/.test(r.name) && !listed.includes(readOf(r)));
  assert.ok(unlisted.length, 'reactions the line leaves out');
  assert.deepStrictEqual(sectionAt(i).candidates.filter(c => c.kind === 'standing').map(c => c.read).sort(), ['15m broke 15m swing high 16693 up', '15m broke overnight high up']);
  // 2021-05-18 03:15 ET: the line lists a gap edge's rejection up, on the side the trend rule allows (longs): no candidate.
  const j = at('2021-05-18T07:12:00.000Z');
  assert.ok(listedAt(BARS.slice(0, j + 1), BARS[j + 1]).includes('15m rejected 15m fvg high up'), 'the close lists a gap edge');
  assert.strictEqual(trendRuleOf(briefingOf(BARS.slice(0, j + 1)).sections.m3.data.trendRule).long, true, 'on an allowed side');
  const sec = sectionAt(j);
  assert.deepStrictEqual(sec.candidates.filter(c => c.kind === 'standing'), []);
  assert.ok(!sec.skipped.some(s => /fvg/.test(s)), 'never even considered');
});

test('next close, standing: its plan is checked with the attempt policy\'s entry rule, as compose_check applies it (composeAt with the rule)', () => {
  const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
  const policy = REG.find(s => s.name === 'prop_portfolio');
  const seen = new Set();
  for (const entry of [{ ...policy.entry, regime_against: 'on' }, { ...policy.entry, bias_agree: 'on' }, { ...policy.entry, leg_turned: 'on' }]) {
    const entryRule = entryRuleOf(entry);
    for (const t of ['2021-05-17T13:42:00.000Z', '2021-05-17T14:57:00.000Z', '2021-05-17T15:42:00.000Z', '2021-05-18T05:27:00.000Z']) {
      const i = at(t);
      const sub = BARS.slice(0, i + 1);
      const sec = sectionAt(i, { entryRule });
      for (const c of sec.candidates.filter(x => x.kind === 'standing')) {
        const pb = briefingOf([...sub, c.threshold.bar]);
        const reaction = SM.setupMoment(pb.sections.m3.data.candles, { barClose: Date.parse(sec.next.closedAt) }).reactions.find(r => readOf(r) === c.read);
        const ruled = composeAt(pb, reaction, { side: c.side, tick: TICK, mark: true, entryRule });
        const open = composeAt(pb, reaction, { side: c.side, tick: TICK, mark: true });
        assert.strictEqual(c.threshold.plan.status === 'ok', Boolean(ruled.plan), `${t} ${c.read}: the section's plan as compose's with the rule (${c.threshold.plan.why || ''})`);
        seen.add(`${Boolean(open.plan)}>${Boolean(ruled.plan)}`);
      }
    }
  }
  assert.ok(seen.has('true>false'), `a plan the rule refuses (${[...seen].join(', ')})`);
});

test('next close, standing: no look-ahead: the later bars rewritten to anything give the identical section (prepare-ahead.js sectionFor); the same closed bars give the same section', () => {
  const i = at('2021-05-17T14:57:00.000Z');
  const closed = BARS.slice(0, i + 1);
  const briefing = briefingOf(closed);
  const of = bars => PA.sectionFor({ symbol: 'MNQ', bars, minutes: 3, briefing, flat: true, windowBars: closed.length + 1, registry: REG });
  const a = of(closed);
  assert.ok(a.candidates.some(c => c.kind === 'standing'), 'a standing candidate here');
  const rewritten = BARS.map((b, k) => (k > i ? { ...b, o: b.o + 50, h: b.h + 400, l: b.l - 400, c: b.c - 75, v: b.v * 9 } : b));
  assert.deepStrictEqual(of(rewritten), a, 'the later bars never read');
  assert.deepStrictEqual(of(BARS), a);
  assert.deepStrictEqual(of(closed), a, 'deterministic');
});

test('next close, standing: rendered as the other candidates (the prepare mock\'s line shape), its trigger as conditions on the closing candle', () => {
  const i = at('2021-05-17T13:42:00.000Z');
  const sec = sectionAt(i);
  const c = sec.candidates.find(x => x.kind === 'standing');
  const lines = NC.possibleLines(sec);
  const line = lines.find(l => l.includes(`"${c.read}"`));
  assert.match(line, new RegExp(`^ {2}- ${c.id} 15m short "${c.read.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}": fires if `));
  // The closing 3m candle opening 09:45 ET (the next bar), any candle; the 15m candle that closed 09:45 stays the last
  // completed one until 10:00 (the next 15m close).
  assert.match(line, /fires if the closing 3m candle is the one opening 09:45 ET, whatever its range, volume and close: the 15m candle \(opened 09:30, closed 09:45\) stays the last completed 15m candle until 10:00 ET, so its reaction still stands, unchanged/);
  assert.match(line, /preconditions \(code evaluates them again at the close\): the trend rule allows a short/);
});

test('prepare ahead, standing: at a later 3m close the confirm\'s match (matchScenario, confirmPath\'s) finds the standing reaction\'s scenario by its read, never outside the plan', () => {
  const i = at('2021-05-17T14:57:00.000Z');
  const sub = BARS.slice(0, i + 1);
  const sec = sectionAt(i);
  // The plan as the prepare writes it: one SCENARIO line per listed candidate (the tier-2 mock's form).
  const text = sec.candidates.map((c, j) => `SCENARIO ${j + 1}: ${c.id} "${c.read}" → TAKE if it stands | PASS if not; reads: "${c.read}"; why: test`).join('\n');
  const plan = PA.makePlan({ symbol: 'MNQ', bar: sub[i].t, next: sec.next, madeAt: sec.closedAt, ms: 1, session: { id: 's' }, versions: {}, candidates: sec.candidates, text });
  const standing = sec.candidates.find(c => c.kind === 'standing');
  assert.ok(standing, 'a standing candidate');
  // What fired at the real close: the scan's rules setups (none here) and the at-close briefing's listed setups.
  const fired = PA.firedReads({ scan: [], listed: listedAt(sub, BARS[i + 1]) });
  assert.ok(fired.includes(standing.read), JSON.stringify(fired));
  const m = PA.matchScenario(plan, fired);
  assert.strictEqual(m.status, 'matched', JSON.stringify(m));
  assert.deepStrictEqual([m.read, m.id, m.side], [standing.read, standing.id, standing.side]);
  // A moving level that also fired stays outside the plan (its kind in the record).
  assert.ok(m.unplanned.some(r => /vwap/.test(r)), `the VWAP reaction unplanned: ${JSON.stringify(m.unplanned)}`);
  assert.ok(m.unplanned.every(r => /vwap|fvg|session (poc|vah|val)|compression|cisd/.test(r)), JSON.stringify(m.unplanned));
});
