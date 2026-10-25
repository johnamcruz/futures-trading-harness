'use strict';

// The floor stretch (scripts/lib/prop/size-translate.js floorStretch; owner-approved 2026-10-24): in a running prop
// attempt, where the composed cap fits fewer than the rulebook's floor at the stop, exactly the floor goes when it
// risks at most sizing.floor_stretch_max_usd all in and the attempt is healthy (no deficit, no losing trade today; this
// session); every other limit still holds. The live translation, the simulator, compose_check and the gate's read.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const prop = require('../../scripts/lib/trading/prop-state');
const { translateSize, allInRisk, attemptHealth, floorStretch, stretchedEntry, limitPlan, noSizeFits } = require('../../scripts/lib/prop/size-translate');
const { trendHome, testSizing } = require('../helpers');

const NOW = new Date('2026-10-07T14:00:02Z');
// A 100K-style account: a $3,000 cushion, 0.3 x = $900 a trade, so the budget never binds before the stretch cap.
const BIG = {
  name: 'big', valid: true, errors: [], starting_balance: 100000, profit_target: 6000, max_loss: 3000, max_loss_mode: 'trailing_eod',
  daily_loss_limit: 2000, daily_loss_soft: 1000, loss_streak_stop: 2, consistency_pct: 0, sessions: 30,
  max_contracts: { MNQ: 100, NQ: 10, MES: 100 }, fees_per_side: { MNQ: 0.37, NQ: 1.4, MES: 0.37 },
};
const SPECS = { MNQ: { tickSize: 0.25, tickValue: 0.5 }, NQ: { tickSize: 0.25, tickValue: 5 }, MES: { tickSize: 0.25, tickValue: 1.25 }, ES: { tickSize: 0.25, tickValue: 12.5 } };
const specOf = r => SPECS[r] || null;
const FEE = { MNQ: 0.37, MES: 0.37, NQ: 1.4 };
const policy = (sizing = {}, extra = {}) => ({
  name: 'prop_portfolio', valid: true, signal: 'policy', account: 'big', contracts: 'micro', multipliers: [],
  sizing: testSizing({ cushion_frac: 0.3, min_contracts: 3, floor_stretch_max_usd: 500, ...sizing }), ...extra,
});
const verdict = (extra = {}) => ({ strategy: 'prop_portfolio', action: 'full', multiplier: 1, contract: 'MNQ', stopTicks: 198, maxSize: 50, ...extra });

// The attempt as the runner records it: `eod` yesterday's close (none: the start), the day's first (anchor) snapshot at
// `balance`; `trades`: today's round trips by their P&L (an opening and a closing fill each, $0.37 a fill), read by a
// later flat snapshot from the broker's fills (prop-state.js snapshot: the balance reconciled, the day's counts and loss
// streak from them); `counts: 'missing'`: the snapshot's day counts left out (unreadable).
const FILL_FEE = 0.37;
function home(balance = 100000, { eod = null, trades = [], counts = null } = {}) {
  const h = trendHome();
  prop.startAttempt(h, BIG, new Date(NOW.getTime() - 2 * 86400000));
  if (eod !== null) prop.recordEndOfDay(h, BIG, eod, '2026-10-06');
  const anchor = NOW.getTime() - 20 * 60000;
  prop.snapshot(h, BIG, balance, new Date(anchor));
  if (trades.length) {
    const fills = trades.flatMap((pnl, i) => [
      { creationTimestamp: new Date(anchor + (2 * i + 1) * 60000).toISOString(), profitAndLoss: null, fees: FILL_FEE },
      { creationTimestamp: new Date(anchor + (2 * i + 2) * 60000).toISOString(), profitAndLoss: pnl, fees: FILL_FEE },
    ]);
    const after = Math.round((balance + trades.reduce((a, p) => a + p, 0) - 2 * FILL_FEE * trades.length) * 100) / 100;
    prop.snapshot(h, BIG, after, new Date(NOW.getTime() - 60000), { fills });
  }
  if (counts === 'missing') {
    const file = prop.combineFile(h, BIG.name);
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete r.snapshot.counts;
    fs.writeFileSync(file, JSON.stringify(r));
  }
  return h;
}
const per = (root, t) => allInRisk({ stopTicks: t, tickValue: SPECS[root].tickValue, slipTicks: 1, feePerSide: FEE[root] });
const S = (root, t, o = {}) => translateSize({
  suggested: 1, home: o.home || home(), root, policy: o.policy || policy({}, root === 'NQ' ? { contracts: 'mini' } : {}), account: BIG,
  verdict: verdict({ contract: root, stopTicks: t, maxSize: o.maxSize ?? 50 }), capUsd: 300, perContract: per(root, t), specOf, selected: [root], orderMax: o.orderMax ?? null,
});

test('the floor stretch, by hand: MNQ, MES and NQ on both sides of the $300 cap and of the $500 stretch (all in: the stop, 1 tick of slippage, fees both ways)', () => {
  const h = home();
  const row = (root, t) => { const r = S(root, t, { home: h }); return [r.size, Boolean(r.stretched), Boolean(r.skip)]; };
  // MNQ $0.50 a tick, $0.37 a side: 197 ticks (197 + 1) x $0.50 + $0.74 = $99.74, 3 = $299.22: under the cap, no stretch.
  assert.deepStrictEqual(row('MNQ', 197), [3, false, false]);
  assert.strictEqual(S('MNQ', 197, { home: h }).reason, 'the rulebook\'s size at this stop: 3 MNQ (risk.max_risk_usd $300.00 at $99.74 a contract all in)');
  // 198 ticks: $100.24, 3 = $300.72 over $300 (the cap fits 2): the floor, stretched, within $500.
  assert.deepStrictEqual(row('MNQ', 198), [3, true, false]);
  assert.strictEqual(S('MNQ', 198, { home: h }).reason, 'the rulebook\'s size at this stop: 3 MNQ (the floor, stretched: $300.72 all in, over risk.max_risk_usd $300.00, within sizing.floor_stretch_max_usd $500.00, the attempt healthy)');
  // The stretch's boundary: 3 x ((t + 1) x $0.50 + $0.74) <= $500 -> t + 1 <= 331.85 -> t <= 330: 330 ticks $166.24,
  // 3 = $498.72; 331 ticks $166.74, 3 = $500.22, over: a skip; 332 ($167.24, 3 = $501.72) too.
  assert.deepStrictEqual(row('MNQ', 330), [3, true, false]);
  assert.match(S('MNQ', 330, { home: h }).reason, /\(the floor, stretched: \$498\.72 all in/);
  assert.deepStrictEqual(row('MNQ', 331), [0, false, true]);
  assert.match(S('MNQ', 331, { home: h }).reason, /under the floor of 3 contracts .*; the floor of 3 at \$166\.74 all in is \$500\.22, over the floor stretch's \$500\.00 too \(sizing\.floor_stretch_max_usd\)\)$/);
  assert.deepStrictEqual(row('MNQ', 332), [0, false, true]);
  // MES $1.25 a tick: 78 ticks 79 x $1.25 + $0.74 = $99.49 (3: $298.47) fits; 79 ticks $100.74 (3: $302.22) stretched;
  // 131 ticks 132 x $1.25 + $0.74 = $165.74 (3: $497.22) stretched; 132 ticks $166.99 (3: $500.97) a skip.
  assert.deepStrictEqual([78, 79, 131, 132].map(t => row('MES', t)), [[3, false, false], [3, true, false], [3, true, false], [0, false, true]]);
  assert.match(S('MES', 79, { home: h }).reason, /\$302\.22 all in/);
  assert.match(S('MES', 131, { home: h }).reason, /\$497\.22 all in/);
  // NQ (a mini counts as 10: the floor of 3 is 1 NQ), $5 a tick, $1.40 a side: 58 ticks 59 x $5 + $2.80 = $297.80 fits;
  // 59 ticks $302.80 stretched; 98 ticks 99 x $5 + $2.80 = $497.80 stretched; 99 ticks $502.80 a skip.
  assert.deepStrictEqual([58, 59, 98, 99].map(t => row('NQ', t)), [[1, false, false], [1, true, false], [1, true, false], [0, false, true]]);
  assert.match(S('NQ', 98, { home: h }).reason, /1 NQ \(the floor, stretched: \$497\.80 all in/);
});

test('the floor stretch needs a healthy attempt: a deficit, any losing trade today (a win after it too) or an unreadable state skip as before; a new day allows it again; where the cap fits the floor it is never needed', () => {
  // A deficit: the balance $99,900 under the $100,000 start (yesterday closed there, so no loss today).
  const deficit = S('MNQ', 198, { home: home(99900, { eod: 99900 }) });
  assert.ok(deficit.skip);
  assert.match(deficit.reason, /; the floor stretch to \$500\.00 applies only while the attempt is healthy \(no deficit, no loss today\): the balance \$99900\.00 is under the attempt's starting \$100000\.00\)$/);
  // At the start exactly, or above it: healthy.
  assert.strictEqual(S('MNQ', 198, { home: home(100000, { eod: 100000 }) }).size, 3);
  assert.strictEqual(S('MNQ', 198, { home: home(100400, { eod: 100400 }) }).size, 3);
  // One loss today (under loss_streak_stop's 2, so entries still go): not healthy. The snapshot read the fills:
  // -$25 and fees: $99,974.26, under the start too, so the gain day below isolates the loss.
  const lost = S('MNQ', 198, { home: home(100400, { eod: 100400, trades: [-25] }) });
  assert.ok(lost.skip);
  assert.match(lost.reason, /: 1 losing trade today: the cap holds for the rest of the day\)$/);
  // A loss then a win the same day: the streak is 0 again, but the day had a loss: no stretch for the rest of the day.
  const h2 = home(100400, { eod: 100400, trades: [-25, 40] });
  const r2 = prop.readAttempt(h2, BIG.name);
  assert.deepStrictEqual([r2.snapshot.state.lossStreak, r2.snapshot.counts.losses, r2.snapshot.balanceCheck.diff], [0, 1, 0], 'as the runner recorded it');
  assert.match(S('MNQ', 198, { home: h2 }).reason, /: 1 losing trade today: the cap holds for the rest of the day\)$/);
  // Winning trades only: healthy.
  assert.strictEqual(S('MNQ', 198, { home: home(100400, { eod: 100400, trades: [40, 10] }) }).size, 3);
  // The next trading day (yesterday's loss recorded at the close, no deficit): its first snapshot counts no loss: allowed again.
  const next = home(100400, { eod: 100400, trades: [-25, 40] });
  const close = prop.readAttempt(next, BIG.name).snapshot.balance;
  prop.recordEndOfDay(next, BIG, close, '2026-10-07');
  const tomorrow = new Date(NOW.getTime() + 86400000);
  prop.snapshot(next, BIG, close, new Date(tomorrow.getTime() - 60000));
  assert.strictEqual(prop.readAttempt(next, BIG.name).snapshot.counts.losses, 0);
  assert.strictEqual(S('MNQ', 198, { home: next }).size, 3);
  // Today's counts unreadable (left out of the snapshot): not healthy (fails closed).
  assert.match(S('MNQ', 198, { home: home(100000, { counts: 'missing' }) }).reason, /: today's losing trades are unreadable\)$/);
  // Where the cap fits the floor, health doesn't matter: sized as before (150 ticks: $76.24 a contract, the cap's 3).
  assert.strictEqual(S('MNQ', 197, { home: home(99900, { eod: 99900 }) }).size, 3);
  assert.strictEqual(S('MNQ', 150, { home: home(100400, { eod: 100400, trades: [-25] }) }).size, 3);
});

test('the floor stretch never goes past another limit: the verdict, the size budget (its halving), the broker\'s max; off or not above the cap: as before, word for word; never more than the floor', () => {
  // The verdict's 2: a skip.
  const v2 = S('MNQ', 198, { maxSize: 2 });
  assert.ok(v2.skip);
  assert.match(v2.reason, /the floor stretch never goes past another limit \(they allow 2\)/);
  assert.strictEqual(S('MNQ', 198, { maxSize: 3 }).size, 3);
  // The broker's max order size 2: a skip; 3: the floor.
  assert.match(S('MNQ', 198, { orderMax: 2 }).reason, /\(they allow 2\)/);
  assert.strictEqual(S('MNQ', 198, { orderMax: 3 }).size, 3);
  // The size budget allows 2: 0.08 x $3,000 = $240 at $100.24 a contract: contractPlan's floor sizes nothing: a skip.
  const thin = S('MNQ', 198, { policy: policy({ cushion_frac: 0.08 }) });
  assert.ok(thin.skip);
  assert.match(thin.reason, /the size budget now allows nothing at a 198-tick stop \(3 MNQ at this stop risk \$300\.72, over the \$240\.00 budget/);
  // The drawdown halving: yesterday $100,200, now $100,100 ($100 under the peak, no deficit): at drawdown_halve_usd 100
  // 0.3 x $2,900 / 2 = $435 fits 2 at 330 ticks ($166.24): a skip; not halved, $870: 3.
  const halved = home(100100, { eod: 100200 });
  assert.match(S('MNQ', 330, { home: halved, policy: policy({ drawdown_halve_usd: 100 }) }).reason, /the size budget now allows nothing at a 330-tick stop/);
  assert.strictEqual(S('MNQ', 330, { home: halved }).size, 3);
  // Off (0), or a stretch not above the cap: the skip as before, word for word.
  const before = 'setup:prop_portfolio: size 2 MNQ is under the floor of 3 contracts (its account\'s rulebook, sizing.min_contracts): trade 3 or more within the size budget, or no trade; never a tighter stop. Exits, protective stops, stop moves, cancels and closes still go. (the correct size at this stop is 2: risk.max_risk_usd $300.00 at $100.24 a contract all in)';
  assert.strictEqual(S('MNQ', 198, { policy: policy({ floor_stretch_max_usd: 0 }) }).reason, before);
  assert.strictEqual(S('MNQ', 198, { policy: policy({ floor_stretch_max_usd: 300 }) }).reason, before);
  // Never more than the floor: a $1,000 stretch at 198 ticks is still 3, never 4 (4 x $100.24 = $400.96 is within it).
  assert.strictEqual(S('MNQ', 198, { policy: policy({ floor_stretch_max_usd: 1000 }) }).size, 3);
});

test('attemptHealth and floorStretch: the definition; every unreadable state is not healthy; null where no stretch is in question', () => {
  const st = (x = {}) => ({ balance: 100000, start: 100000, lossesToday: 0, ...x });
  assert.deepStrictEqual(attemptHealth(st()), { healthy: true });
  assert.deepStrictEqual(attemptHealth(st({ balance: 100000.01 })), { healthy: true });
  for (const bad of [null, undefined, 5, st({ balance: '100000' }), st({ balance: NaN }), st({ start: undefined }), st({ lossesToday: -1 }), st({ lossesToday: 1.5 }), st({ lossesToday: null }), st({ lossesToday: undefined }), st({ lossesToday: '0' })]) {
    assert.strictEqual(attemptHealth(bad).healthy, false, JSON.stringify(bad));
  }
  assert.match(attemptHealth(st({ balance: 99999.99 })).why, /the balance \$99999\.99 is under the attempt's starting \$100000\.00/);
  assert.match(attemptHealth(st({ lossesToday: 2 })).why, /2 losing trades today/);
  // The streak isn't what decides: a streak of 0 with a loss today is not healthy; a streak alone (no count) is unreadable.
  assert.strictEqual(attemptHealth(st({ lossStreak: 0, lossesToday: 1 })).healthy, false);
  assert.strictEqual(attemptHealth({ balance: 100000, start: 100000, lossStreak: 0 }).healthy, false);
  const f = (x = {}) => floorStretch({ floor: 3, perContract: 100.24, capUsd: 300, stretchUsd: 500, state: st(), ...x });
  assert.deepStrictEqual(f(), { size: 3, risk: 300.72 });
  assert.strictEqual(f({ perContract: 99.74 }), null, 'the cap fits the floor');
  assert.strictEqual(f({ stretchUsd: 0 }), null, 'off');
  assert.strictEqual(f({ stretchUsd: 300 }), null, 'not above the cap');
  assert.strictEqual(f({ capUsd: 0 }), null);
  assert.strictEqual(f({ floor: null }), null);
  assert.match(f({ perContract: 166.74 }).why, /over the floor stretch/);
  assert.deepStrictEqual(f({ perContract: 500 / 3 }), { size: 3, risk: 500 }, 'at the stretch exactly');
  assert.match(f({ allows: 2 }).why, /they allow 2/);
  assert.match(f({ state: st({ lossesToday: 1 }) }).why, /only while the attempt is healthy/);
  assert.match(f({ state: null }).why, /the attempt state is unreadable/);
});

test('limitPlan (the attempt simulator and the backtester): the same stretch on the plan\'s own contract and the simulated attempt\'s health', () => {
  const healthy = { balance: 100000, start: 100000, lossesToday: 0 };
  const L = (plan, o = {}) => limitPlan(plan, { limits: { capUsd: 300, orderMax: null, ...(o.limits || {}) }, minContracts: 3, ratio: 10, miniRoot: 'NQ', stretchUsd: 500, state: healthy, ...(o.opts || {}) });
  const mnq = { root: 'MNQ', size: 8, riskPerContract: 100.24 };
  assert.deepStrictEqual(L(mnq), { ...mnq, size: 3 });
  assert.strictEqual(L(mnq, { opts: { state: { ...healthy, lossesToday: 1 } } }), null);
  assert.strictEqual(L(mnq, { opts: { state: { ...healthy, balance: 99000 } } }), null);
  assert.strictEqual(L(mnq, { opts: { stretchUsd: 0 } }), null, 'off: as before');
  assert.strictEqual(L(mnq, { limits: { orderMax: 2 } }), null, 'the broker\'s max 2');
  assert.strictEqual(L({ ...mnq, size: 2 }), null, 'the budget\'s 2');
  assert.strictEqual(L({ ...mnq, riskPerContract: 166.74 }), null, 'over the stretch');
  assert.deepStrictEqual(L({ ...mnq, riskPerContract: 99.74 }), { ...mnq, size: 3, riskPerContract: 99.74 }, 'the cap fits 3: as before');
  // A mini: the floor of 3 micro-equivalents is 1 NQ; $302.80 all in at 59 ticks: stretched to 1; $502.80 over.
  assert.deepStrictEqual(L({ root: 'NQ', size: 1, riskPerContract: 302.8 }), { root: 'NQ', size: 1, riskPerContract: 302.8 });
  assert.strictEqual(L({ root: 'NQ', size: 1, riskPerContract: 502.8 }), null);
});

test('stretchedEntry (the gate\'s [max-risk]): exactly the floor within the stretch on a healthy attempt; any other size, an unhealthy attempt or over the stretch refused; null where the cap binds as before', () => {
  const E = (o = {}) => stretchedEntry({ home: 'home' in o ? o.home : home(), policy: 'policy' in o ? o.policy : policy(), account: 'account' in o ? o.account : BIG, root: 'MNQ', size: o.size ?? 3, perContract: per('MNQ', o.ticks ?? 198), capUsd: 300, specOf });
  assert.deepStrictEqual(E(), { ok: true });
  assert.deepStrictEqual(E({ ticks: 330 }), { ok: true });
  assert.match(E({ size: 4 }).why, /only exactly the floor of 3 MNQ may go over the cap/);
  assert.strictEqual(E({ size: '3' }).ok, false, 'a size that isn\'t a number: refused');
  assert.match(E({ ticks: 331 }).why, /over the floor stretch's \$500\.00 too/);
  assert.match(E({ home: home(99900, { eod: 99900 }) }).why, /applies only while the attempt is healthy .*under the attempt's starting/);
  assert.match(E({ home: home(100400, { eod: 100400, trades: [-25, 40] }) }).why, /1 losing trade today/);
  assert.strictEqual(E({ ticks: 197 }), null, 'the cap fits the floor');
  assert.strictEqual(E({ policy: policy({ floor_stretch_max_usd: 0 }) }), null, 'off');
  // No stretch at all (the cap binds as before) without a policy, a valid account and a running attempt.
  const h = home();
  assert.strictEqual(E({ home: trendHome() }), null, 'no attempt running');
  assert.strictEqual(E({ home: null }), null, 'no home');
  assert.strictEqual(E({ home: h, account: { ...BIG, valid: false } }), null, 'an invalid account');
  assert.strictEqual(E({ home: h, account: null }), null, 'no account');
  assert.strictEqual(E({ home: h, policy: null }), null, 'no policy');
  assert.deepStrictEqual(E({ home: h }), { ok: true }, 'the same home, healthy');
  // A running attempt whose snapshot state is gone: not healthy, refused.
  const bare = trendHome();
  prop.startAttempt(bare, BIG, new Date(NOW.getTime() - 86400000));
  assert.match(E({ home: bare }).why, /the attempt state is unreadable/);
});

test('parity: the floor stretch in the simulator (prop/attempts.js defaultSize), compose_check (noSizeFits) and the live translation, stop by stop, healthy and not', () => {
  const at = require('../../scripts/lib/prop/attempts');
  const { decideSetup } = require('../../scripts/lib/prop/verdict');
  const bars = [{ t: '2026-10-07T13:57:00.000Z', o: 21500, h: 21502, l: 21498, c: 21500, v: 1 }];
  let compared = 0;
  let stretched = 0;
  const pol = policy();
  for (const [label, h] of [['healthy', home()], ['deficit', home(99900, { eod: 99900 })], ['a loss then a win today', home(100400, { eod: 100400, trades: [-25, 40] })]]) {
    const r = prop.readAttempt(h, BIG.name);
    const cs = prop.stateFrom(BIG, r, r.snapshot.balance);
    for (const [root, lo, hi] of [['MNQ', 190, 340], ['MES', 74, 136]]) {
      const { legs, ratio } = at.legsFor(BIG, root, { tickValue: SPECS[root].tickValue });
      for (let t = lo; t <= hi; t += 1) {
        const v = decideSetup({ account: BIG, cs, strategy: { ...pol, timeframe: '3m' }, component: 'trade_lifecycle', symbol: root, contractId: root, rawBars: bars, spec: specOf(root), scan: { direction: 'long', stopDistance: t * 0.25 }, now: NOW, specOf, selected: [root] });
        for (const orderMax of [null, 2]) {
          const live = translateSize({ suggested: 1, home: h, root, policy: pol, account: BIG, verdict: v, capUsd: 300, perContract: per(root, t), specOf, selected: [root], orderMax });
          const sim = at.defaultSize({ cs, trade: { stopTicks: t }, sizing: pol.sizing, legs, mode: 'micro', ratio, fraction: 1, limits: { capUsd: 300, orderMax }, lossesToday: r.snapshot.counts.losses });
          assert.strictEqual(sim ? sim.size : 0, live.skip ? 0 : live.size, `${label} ${root} ${t} ticks, max ${orderMax}: ${live.reason}`);
          if (orderMax === null) {
            const refused = noSizeFits({ policy: pol, account: BIG, capUsd: 300, stop: { ticks: t, floorTicks: 1 }, spec: specOf(root), root, strategy: 'trade_lifecycle', specOf, home: h });
            assert.strictEqual(Boolean(refused), Boolean(live.skip), `compose_check, ${label} ${root} ${t}: ${live.reason}`);
          }
          stretched += live.stretched ? 1 : 0;
          compared += 1;
        }
      }
    }
  }
  assert.strictEqual(compared, 3 * 2 * (151 + 63));
  // Healthy and no broker max only: MNQ 198..330 (133 stops), MES 79..131 (53).
  assert.strictEqual(stretched, 133 + 53);
});

test('noSizeFits with a stretch: OK while it takes the floor; else the problem says why and the hint names the widest stop for the cap and, only while healthy, for the stretch', () => {
  const pol = policy();
  const one = (t, h, floorTicks = 40) => noSizeFits({ policy: pol, account: BIG, capUsd: 300, stop: { ticks: t, floorTicks }, spec: specOf('MNQ'), root: 'MNQ', strategy: 'trade_lifecycle', specOf, home: h });
  assert.strictEqual(one(198, home()), null, 'healthy, within the stretch: OK');
  assert.strictEqual(one(330, home()), null);
  // Not healthy: NOT OK with why; the hint: 197 ticks (49.25 points) under the cap, 330 (82.5 points) up to $500, only while healthy.
  const sick = one(198, home(100400, { eod: 100400, trades: [-25, 40] }));
  assert.strictEqual(sick.problem, 'no size fits: the floor of 3 MNQ (prop_portfolio\'s rulebook, sizing.min_contracts) at $100.24 a contract all in (the 198-tick stop with its slippage, and fees both ways) is $300.72, over trade_lifecycle\'s risk.max_risk_usd $300; the floor stretch to $500.00 applies only while the attempt is healthy (no deficit, no loss today): 1 losing trade today: the cap holds for the rest of the day');
  assert.strictEqual(sick.hint, 'size: no size fits: 3 MNQ need a stop of 197 ticks (49.25 points) or less under the $300 cap; the floor at up to $500 (a stop of 330 ticks, 82.5 points, or less) only while the attempt is healthy (no deficit, no loss today); use a closer structural stop or skip');
  // Over the stretch, healthy: NOT OK, the same hint.
  const wide = one(331, home());
  assert.match(wide.problem, /is \$500\.22, over trade_lifecycle's risk\.max_risk_usd \$300; the floor of 3 at \$166\.74 all in is \$500\.22, over the floor stretch's \$500\.00 too/);
  assert.strictEqual(wide.hint, sick.hint);
  // The cap's widest stop under the record's minimum stop: skip, the stretch's widest named the same way.
  assert.strictEqual(one(331, home(), 200).hint, 'size: no size fits: 3 MNQ fit under the $300 cap only at a stop of 197 ticks or less, under the minimum stop of 200; the floor at up to $500 (a stop of 330 ticks, 82.5 points, or less) only while the attempt is healthy (no deficit, no loss today): skip');
  // No attempt in the home (its state unreadable): not healthy, NOT OK.
  assert.match(one(198, trendHome()).problem, /the attempt state is unreadable$/);
});

test('the attempt simulator: a loss then a win today keeps the stretch off for the rest of the day; the next day takes it again', () => {
  const at = require('../../scripts/lib/prop/attempts');
  const pol = policy();
  const day = (d, trades) => ({ day: d, trades: trades.map((x, i) => ({ symbol: 'MNQ', tickValue: 0.5, day: d, entryTime: `${d}T14:${10 + 10 * i}:00.000Z`, exitTime: `${d}T14:${15 + 10 * i}:00.000Z`, troughTicks: x.move < 0 ? [x.move] : [], ...x })) });
  // 40-tick stops ($21.24 all in: the cap's 14): a loss of 40 ticks, then a win of 80; then a 198-tick setup (the stretch).
  const lossWin = [{ stopTicks: 40, moveTicks: -40, move: -40 }, { stopTicks: 40, moveTicks: 80, move: 80 }, { stopTicks: 198, moveTicks: 10, move: 10 }];
  const run = days => {
    const taken = [];
    const skipped = [];
    at.runAttempt(days, { account: BIG, sizing: pol.sizing, mode: 'micro', gate: null, limits: { capUsd: 300, orderMax: null }, legsOf: () => at.legsFor(BIG, 'MNQ', { tickValue: 0.5 }),
      onTrade: ({ trade, after }) => taken.push([trade.day, trade.stopTicks, after.balance >= after.start]), onSkip: ({ trade, why }) => skipped.push([trade.day, trade.stopTicks, why]) });
    return { taken, skipped };
  };
  const r = run([day('2026-10-06', lossWin), day('2026-10-07', [{ stopTicks: 198, moveTicks: 10, move: 10 }])]);
  // Day 1: the 198-tick setup skips (a loss today, though the streak is 0 again and the balance above the start).
  assert.deepStrictEqual(r.skipped, [['2026-10-06', 198, 'no-size']]);
  // Day 2: taken (no loss yet today, no deficit).
  assert.deepStrictEqual(r.taken.map(t => t.slice(0, 2)), [['2026-10-06', 40], ['2026-10-06', 40], ['2026-10-07', 198]]);
  assert.ok(r.taken[1][2], 'above the start after the win');
  // Wins only: the 198-tick setup goes the same day.
  assert.deepStrictEqual(run([day('2026-10-06', [lossWin[1], lossWin[2]])]).skipped, []);
});
