'use strict';

// The size translation (scripts/lib/prop/size-translate.js), the one place a prop entry's size is set: the model's
// size is a suggestion; the result is the largest size the account rulebook's sizing allows at the record's stop.

const test = require('node:test');
const assert = require('node:assert');
const prop = require('../../scripts/lib/trading/prop-state');
const { translateSize, translatorFor } = require('../../scripts/lib/prop/size-translate');
const { trendHome, testSizing, tmpDir: tmpDirOf } = require('../helpers');

const NOW = new Date('2026-10-07T14:00:02Z');
// A $2,000 cushion: 0.2 x = $400 a trade. MNQ $0.50 a tick, $0.37 a side; NQ $5, $1.40.
const MINI = {
  name: 'mini', valid: true, errors: [], starting_balance: 50000, profit_target: 3000, max_loss: 2000, max_loss_mode: 'trailing_eod',
  daily_loss_limit: 1000, daily_loss_soft: 500, consistency_pct: 0, sessions: 30, max_contracts: { MNQ: 50, NQ: 5 }, fees_per_side: { MNQ: 0.37, NQ: 1.4 },
};
const specOf = r => (r === 'MNQ' || r === 'NQ' ? { tickSize: 0.25, tickValue: r === 'NQ' ? 5 : 0.5 } : null);
const policy = (sizing = {}, extra = {}) => ({ name: 'prop_portfolio', valid: true, signal: 'policy', account: 'mini', contracts: 'micro', sizing: testSizing(sizing), multipliers: [], ...extra });
const verdict = (extra = {}) => ({ strategy: 'prop_portfolio', action: 'full', multiplier: 1, contract: 'MNQ', stopTicks: 40, maxSize: 18, ...extra });

// `balance`: the snapshot's, yesterday's close too (no loss today: no entry block).
function home(balance = 50000, account = MINI) {
  const h = trendHome();
  prop.startAttempt(h, account, new Date(NOW.getTime() - 2 * 86400000));
  if (balance !== 50000) prop.recordEndOfDay(h, account, balance, '2026-10-06');
  prop.snapshot(h, account, balance, new Date(NOW.getTime() - 60000));
  return h;
}
// A 40-tick stop: 41 x $0.50 + $0.74 = $21.24 a micro, so the $400 budget is 18 MNQ; the cap $300 at $20 a contract: 15.
const T = (o = {}) => translateSize({ suggested: 1, home: o.home || home(), root: 'MNQ', policy: o.policy || policy(), account: 'account' in o ? o.account : MINI, verdict: o.verdict || verdict(), capUsd: o.capUsd ?? 1000, perContract: o.perContract ?? 20, specOf, selected: ['MNQ'], orderMax: o.orderMax ?? null, ...(o.suggested !== undefined ? { suggested: o.suggested } : {}) });

test('translateSize: the suggestion is translated to the rulebook\'s size (the largest the verdict, the budget, the cap and the broker allow); it never changes the result', () => {
  const one = T();
  assert.deepStrictEqual([one.size, one.contract, one.suggested, one.skip], [18, 'MNQ', 1, undefined]);
  assert.strictEqual(one.reason, 'the rulebook\'s size at this stop: 18 MNQ (the verdict\'s 18, the size budget\'s 18)');
  for (const suggested of [null, 3, 18, 50]) assert.strictEqual(T({ suggested }).size, 18, String(suggested));
  assert.strictEqual(T({ suggested: 50 }).suggested, 50, 'kept beside the result');
  // The composed cap binds: $300 at $20 a contract is 15.
  assert.match(T({ capUsd: 300 }).reason, /15 MNQ \(risk.max_risk_usd \$300.00 at \$20.00 a contract all in\)/);
  // The broker's max order size binds: 5.
  assert.deepStrictEqual([T({ orderMax: 5 }).size, /the broker's max order size 5/.test(T({ orderMax: 5 }).reason)], [5, true]);
  // The verdict's own size binds (a smaller verdict): 7.
  assert.strictEqual(T({ verdict: verdict({ maxSize: 7 }) }).size, 7);
  // The budget now binds (the balance fell since the verdict): a $1,000 cushion, $200: 9.
  assert.strictEqual(T({ home: home(49000) }).size, 9);
});

test('translateSize: the verdict\'s multiplier sizes the budget; a mini verdict sizes minis; the floor counts micro-equivalents', () => {
  // A multiplier of 0.5: the budget at half, floor(18 x 0.5) = 9.
  assert.strictEqual(T({ verdict: verdict({ multiplier: 0.5 }) }).size, 9);
  // A mini verdict (mini mode): $400 at $207.80 an NQ (41 x $5 + $2.80): 1 NQ, a mini clearing a floor of 3.
  const nq = translateSize({ suggested: 1, home: home(), root: 'NQ', policy: policy({ min_contracts: 3 }, { contracts: 'mini' }), account: MINI, verdict: verdict({ contract: 'NQ', maxSize: 1 }), capUsd: 1000, perContract: 200, specOf, selected: ['NQ'] });
  assert.deepStrictEqual([nq.size, nq.contract], [1, 'NQ']);
  // A floor of 12: the one NQ (10) is under it: a skip with the floor's reason.
  const nq12 = translateSize({ suggested: 1, home: home(), root: 'NQ', policy: policy({ min_contracts: 12 }, { contracts: 'mini' }), account: MINI, verdict: verdict({ contract: 'NQ', maxSize: 1 }), capUsd: 1000, perContract: 200, specOf, selected: ['NQ'] });
  assert.ok(nq12.skip && /the size budget now allows nothing|under the floor of 12/.test(nq12.reason), nq12.reason);
  // auto with nothing selected: the budget is sized in the verdict's own contract, as the runner's verdict is (its run's
  // contract), never a mini the entry doesn't trade: 18 MNQ (before 2026-10-30 a budget that reached a mini sized 1 NQ, and
  // the MNQ verdict skipped: a wider stop sized, a narrower one didn't).
  const auto = translateSize({ suggested: 1, home: home(), root: 'MNQ', policy: policy({}, { contracts: 'auto' }), account: MINI, verdict: verdict(), capUsd: 1000, perContract: 20, specOf, selected: null });
  assert.deepStrictEqual([auto.size, auto.contract], [18, 'MNQ'], auto.reason);
});

test('translateSize: under the floor is a skip (never sized up); a skip verdict, no verdict, another contract, no account or no cap skips', () => {
  // The cap at $50: 2 contracts, under a floor of 3: a skip that names the floor and the size the rules give.
  const under = T({ policy: policy({ min_contracts: 3 }), capUsd: 50 });
  assert.deepStrictEqual([under.skip, under.size, under.contract], [true, 0, null]);
  assert.match(under.reason, /^setup:prop_portfolio: size 2 MNQ is under the floor of 3 contracts .*\(the correct size at this stop is 2: risk.max_risk_usd \$50.00 at \$20.00 a contract all in\)$/);
  assert.strictEqual(T({ policy: policy({ min_contracts: 3 }), capUsd: 60 }).size, 3, 'at the floor it goes');
  // A budget under the floor: the budget sizes nothing (contractPlan's floor), with its reason.
  assert.match(T({ policy: policy({ min_contracts: 3 }), home: home(48250, MINI) }).reason, /the size budget now allows nothing at a 40-tick stop \(3 MNQ at this stop risk \$63\.72, over the \$50\.00 budget/);
  assert.match(T({ verdict: verdict({ action: 'skip', maxSize: 0, multiplier: 0, reason: 'cushion' }) }).reason, /prop_portfolio skipped the setup \(cushion\)/);
  assert.match(translateSize({ suggested: 1, home: home(), root: 'MNQ', policy: policy(), account: MINI, verdict: null, capUsd: 1000, perContract: 20, specOf }).reason, /no verdict on this record/);
  assert.match(T({ verdict: verdict({ contract: 'NQ' }) }).reason, /verdict trades NQ, not MNQ/);
  assert.match(T({ verdict: verdict({ multiplier: 2 }) }).reason, /no size multiplier above 0 and at most 1/);
  assert.match(T({ account: null }).reason, /no valid account to size from/);
  assert.match(T({ capUsd: 0 }).reason, /states no risk.max_risk_usd/);
  // No snapshot (an attempt not sized yet): the budget can't be read, a skip.
  const bare = trendHome();
  prop.startAttempt(bare, MINI, new Date(NOW.getTime() - 86400000));
  assert.match(T({ home: bare }).reason, /no mini snapshot to size from/);
});

test('translatorFor: the plan\'s stop ticks and the contract\'s tick value price a contract; the same result as translateSize', () => {
  const h = home();
  const tr = translatorFor({ home: h, root: 'MNQ', policy: policy(), account: MINI, strategy: { risk: { max_risk_usd: 300 } }, verdict: verdict(), specOf, selected: ['MNQ'] });
  const plan = { stop: { ticks: 40 } };
  // A contract all in: (40 + 1 slippage tick) x $0.50 + 2 x $0.37 = $21.24; the $300 cap: floor(300 / 21.24) = 14.
  assert.deepStrictEqual(tr(plan, specOf('MNQ'), 1), T({ home: h, capUsd: 300, perContract: 21.24 }));
  assert.strictEqual(tr(plan, specOf('MNQ'), 1).size, 14);
  // The live smoke's 22-tick stop: $300 / ((22 + 1) x $0.50 + $0.74 = $12.24) = 24, all in $293.76 (never 27 at $11.00 a
  // contract, whose all-in loss would be $330.48, over the cap).
  // (Its verdict and budget at 22 ticks are floor(400 / 12.24) = 32: the cap binds.)
  const t22 = translatorFor({ home: h, root: 'MNQ', policy: policy(), account: MINI, strategy: { risk: { max_risk_usd: 300 } }, verdict: verdict({ stopTicks: 22, maxSize: 32 }), specOf, selected: ['MNQ'] })({ stop: { ticks: 22 } }, specOf('MNQ'), 1);
  assert.strictEqual(t22.size, 24);
  assert.ok(t22.size * ((22 + 1) * 0.5 + 2 * 0.37) <= 300, 'the all-in loss at the stop within the cap');
  // No fee in the profile: none is assumed, no size.
  assert.ok(translatorFor({ home: h, root: 'MNQ', policy: policy(), account: { ...MINI, fees_per_side: {} }, strategy: { risk: { max_risk_usd: 300 } }, verdict: verdict(), specOf, selected: ['MNQ'] })(plan, specOf('MNQ'), 1).skip);
  assert.ok(tr(null, specOf('MNQ'), 1).skip, 'no plan: no size');
});

test('parity: the simulator (prop/attempts.js defaultSize with the live limits) sizes as translateSize does, stop by stop', () => {
  const at = require('../../scripts/lib/prop/attempts');
  const { decideSetup } = require('../../scripts/lib/prop/verdict');
  const h = home();
  const r = prop.readAttempt(h, MINI.name);
  const cs = prop.stateFrom(MINI, r, r.snapshot.balance);
  const { legs, ratio } = at.legsFor(MINI, 'MNQ', { tickValue: 0.5 });
  const bars = [{ t: '2026-10-07T13:57:00.000Z', o: 21500, h: 21502, l: 21498, c: 21500, v: 1 }];
  let compared = 0;
  for (const min of [1, 3]) {
    const pol = policy({ min_contracts: min });
    for (const stopTicks of [8, 40, 111, 150, 199, 201, 400]) {
      for (const [capUsd, orderMax] of [[300, null], [300, 5], [1000, null], [50, null]]) {
        const v = decideSetup({ account: MINI, cs, strategy: { ...pol, timeframe: '3m' }, component: 'trade_lifecycle', symbol: 'MNQ', contractId: 'MNQ', rawBars: bars, spec: specOf('MNQ'), scan: { direction: 'long', stopDistance: stopTicks * 0.25 }, now: NOW, specOf, selected: ['MNQ'] });
        // A contract all in, by hand: (stop + 1 slippage tick) x $0.50 + 2 x $0.37.
        const live = translateSize({ suggested: 1, home: h, root: 'MNQ', policy: pol, account: MINI, verdict: v, capUsd, perContract: (stopTicks + 1) * 0.5 + 0.74, specOf, selected: ['MNQ'], orderMax });
        const sim = at.defaultSize({ cs, trade: { stopTicks }, sizing: pol.sizing, legs, mode: 'micro', ratio, fraction: 1, limits: { capUsd, orderMax } });
        assert.strictEqual(sim ? sim.size : 0, live.skip ? 0 : live.size, `floor ${min}, ${stopTicks} ticks, cap ${capUsd}, max ${orderMax}`);
        if (sim) assert.strictEqual(sim.root, 'MNQ', 'the contract live trades');
        compared += 1;
      }
    }
  }
  assert.strictEqual(compared, 56);
  // Without the limits the simulator sized past the live entry: the cap is what live binds on.
  assert.ok(at.defaultSize({ cs, trade: { stopTicks: 40 }, sizing: policy().sizing, legs, mode: 'micro', ratio, fraction: 1 }).size > 15);
});

// The shipped policy, its account and the composed cap (the probe the owner's fix came from): a fresh, healthy attempt.
const shipped = () => {
  const path = require('path');
  const ROOT = path.resolve(__dirname, '..', '..');
  const all = require('../../scripts/lib/trading/strategies').loadStrategies(ROOT, {}).strategies;
  const pol = all.find(s => s.name === 'prop_portfolio');
  const account = require('../../scripts/lib/trading/accounts').accountNamed(ROOT, pol.account, {});
  const combine = require('../../scripts/lib/trading/combine');
  const { legs, ratio } = require('../../scripts/lib/prop/attempts').legsFor(account, 'MNQ', { tickValue: 0.5 });
  return { pol, account, combine, legs, ratio, cap: all.find(s => s.name === 'trade_lifecycle').risk.max_risk_usd, cs: combine.start(account) };
};
const planArgs = (S, stopTicks, extra = {}) => ({
  dollars: S.combine.budget(S.cs, S.pol.sizing), room: S.combine.room(S.cs), stopTicks, legs: S.legs, mode: 'auto', guard: S.pol.sizing.min_size_guard,
  fraction: 1, ratio: S.ratio, slipTicks: S.pol.sizing.stop_slippage_ticks, minContracts: S.pol.sizing.min_contracts, ...extra,
});
const planOpts = (S, extra = {}) => ({ limits: { capUsd: S.cap, orderMax: null }, healthyUsd: S.pol.sizing.healthy_risk_usd, stretchUsd: S.pol.sizing.floor_stretch_max_usd, state: { ...S.cs, lossesToday: 0 }, nearTargetUsd: S.pol.sizing.near_target_usd, ...extra });

test('entryPlan: the size is the most the $300 cap fits all in; the budget only lowers it; auto trades minis only when whole minis carry the same size (the old rule skipped 26-44 points)', () => {
  const { entryPlan, limitPlan } = require('../../scripts/lib/prop/size-translate');
  const S = shipped();
  assert.strictEqual(S.pol.contracts, 'auto', 'the shipped policy sizes in auto mode with no contract selected');
  assert.ok(S.cap > 0 && S.pol.sizing.min_contracts === 3 && S.pol.sizing.floor_stretch_max_usd > S.cap, 'the case: a cap, a floor of 3, a stretch over the cap');
  // 30 points (120 ticks): one MNQ is (120 + 1) x $0.50 + $0.74 = $61.24, so the cap fits 4 ($244.96). The budget alone
  // would pick 1 NQ ((120 + 1) x $5 + $2.80 = $607.80), which the old rule then cut to nothing.
  const args = planArgs(S, 120);
  const mini = S.combine.contractPlan(args);
  assert.deepStrictEqual(mini, { root: 'NQ', size: 1, riskPerContract: 607.8 });
  assert.strictEqual(limitPlan(mini, { ...planOpts(S), minContracts: 3, ratio: S.ratio, miniRoot: 'NQ' }), null, 'the old rule: no size');
  assert.deepStrictEqual(entryPlan(args, planOpts(S)), { root: 'MNQ', size: 4, riskPerContract: 61.24 });
  // 10 points (40 ticks): the cap fits 14 MNQ at $21.24 ($297.36); 1 NQ ($207.80) is 10 micro-equivalents, not 14: micros.
  assert.deepStrictEqual(entryPlan(planArgs(S, 40), planOpts(S)), { root: 'MNQ', size: 14, riskPerContract: 21.24 });
  // 14.25 points (57 ticks): the cap fits 10 MNQ at $29.74 ($297.40) and 1 NQ at $292.80 is the same 10: the mini.
  assert.deepStrictEqual(entryPlan(planArgs(S, 57), planOpts(S)), { root: 'NQ', size: 1, riskPerContract: 292.8 });
  // 20 points: 7 MNQ at $41.24 ($288.68); never the mini's floor stretched (1 NQ at $407.80).
  assert.deepStrictEqual(entryPlan(planArgs(S, 80), planOpts(S)), { root: 'MNQ', size: 7, riskPerContract: 41.24 });
  // The budget lowers it: a $100 budget at 10 points is 4 MNQ ($84.96), never the cap's 14.
  assert.deepStrictEqual(entryPlan(planArgs(S, 40, { dollars: 100 }), planOpts(S)), { root: 'MNQ', size: 4, riskPerContract: 21.24 });
});

test('entryPlan: the healthy cap (sizing.healthy_risk_usd) takes the composed cap\'s place for every size, only while healthy; off is the composed cap', () => {
  const { entryPlan, riskCapOf } = require('../../scripts/lib/prop/size-translate');
  const S = shipped();
  assert.strictEqual(S.pol.sizing.healthy_risk_usd, 0, 'off in the shipped rulebook');
  const on = extra => planOpts(S, { healthyUsd: 500, ...extra });
  // 30 points: $500 fits 8 MNQ at $61.24 ($489.92) while healthy; a loss today or a deficit: the composed cap's 4.
  assert.strictEqual(entryPlan(planArgs(S, 120), on()).size, 8);
  assert.strictEqual(entryPlan(planArgs(S, 120), on({ state: { ...S.cs, lossesToday: 1 } })).size, 4);
  assert.strictEqual(entryPlan(planArgs(S, 120), on({ state: { ...S.cs, balance: S.cs.start - 1, lossesToday: 0 } })).size, 4);
  assert.deepStrictEqual(riskCapOf({ capUsd: 300, healthyUsd: 200, state: { ...S.cs, lossesToday: 0 } }), { capUsd: 300, healthy: false }, 'never under the composed cap');
  assert.deepStrictEqual(riskCapOf({ capUsd: 300, healthyUsd: 0, state: { ...S.cs, lossesToday: 0 } }), { capUsd: 300, healthy: false }, 'off');
});

test('entryPlan: every other limit only lowers it: the floor stretch only while healthy, near the target the floor, the broker\'s max, the selected leg, no cap the budget alone', () => {
  const { entryPlan } = require('../../scripts/lib/prop/size-translate');
  const S = shipped();
  // 60 points (240 ticks): 3 MNQ at $121.24 = $363.72, over the cap, within the $500 stretch: only while healthy.
  assert.deepStrictEqual(entryPlan(planArgs(S, 240), planOpts(S)), { root: 'MNQ', size: 3, riskPerContract: 121.24 });
  assert.strictEqual(entryPlan(planArgs(S, 240), planOpts(S, { state: { ...S.cs, lossesToday: 1 } })), null, 'a loss today: the cap holds');
  assert.strictEqual(entryPlan(planArgs(S, 240), planOpts(S, { state: { ...S.cs, balance: S.cs.start - 1, lossesToday: 0 } })), null, 'a deficit: the cap holds');
  // 83 points: 3 MNQ at $167.24 = $501.72, over the stretch too: none, as before.
  assert.strictEqual(entryPlan(planArgs(S, 332), planOpts(S)), null);
  // Near the target: the floor in micros, never more.
  const near = { ...S.cs, balance: S.cs.start + S.cs.target - 1, lossesToday: 0 };
  assert.strictEqual(entryPlan(planArgs(S, 120), planOpts(S, { state: near })).size, 3);
  // The broker's max order size binds the micros: 2 is under the floor and the stretch can't pass it: none.
  assert.strictEqual(entryPlan(planArgs(S, 120), planOpts(S, { limits: { capUsd: S.cap, orderMax: 3 } })).size, 3);
  assert.strictEqual(entryPlan(planArgs(S, 120), planOpts(S, { limits: { capUsd: S.cap, orderMax: 2 } })), null);
  // A selected leg is never swapped: mini mode stays minis (none fits), micro mode was micros already.
  assert.strictEqual(entryPlan(planArgs(S, 120, { mode: 'mini' }), planOpts(S)), null);
  assert.deepStrictEqual(entryPlan(planArgs(S, 120, { mode: 'micro' }), planOpts(S)), { root: 'MNQ', size: 4, riskPerContract: 61.24 });
  // No limits (no composed cap): the size budget's plan alone, as before (its mini).
  assert.strictEqual(entryPlan(planArgs(S, 120), planOpts(S, { limits: null })).root, 'NQ');
  // An account that can't trade micros: the mini's result as before (here none).
  const noMicro = { ...S.legs, micro: { ...S.legs.micro, max: 0 } };
  assert.strictEqual(entryPlan(planArgs(S, 120, { legs: noMicro }), planOpts(S)), null);
  // The verdict's multiplier sizes the micros too: half of 16 is 8 micros, the cap 4.
  assert.strictEqual(entryPlan(planArgs(S, 120, { fraction: 0.5 }), planOpts(S)).size, 4);
});

test('property: across stops of 1 to 120 points at a healthy state, the risk never passes the cap (or the stretch, exactly the floor), never under the floor, and the size never rises as the stop widens', () => {
  const { entryPlan } = require('../../scripts/lib/prop/size-translate');
  const at = require('../../scripts/lib/prop/attempts');
  const S = shipped();
  const z = S.pol.sizing;
  let prev = Infinity;
  let sized = 0;
  let ended = false;
  for (let ticks = 4; ticks <= 480; ticks += 1) {
    const p = entryPlan(planArgs(S, ticks), planOpts(S));
    // The simulator's own size is this one.
    assert.deepStrictEqual(at.defaultSize({ cs: S.cs, trade: { stopTicks: ticks }, sizing: z, legs: S.legs, mode: 'auto', ratio: S.ratio, fraction: 1, limits: planOpts(S).limits, lossesToday: 0 }), p, `${ticks} ticks`);
    if (!p) { ended = true; prev = 0; continue; }
    assert.ok(!ended, `${ticks} ticks sizes ${p.size} ${p.root} but a narrower stop sized nothing: a gap`);
    sized += 1;
    const each = p.root === S.legs.mini.root ? S.ratio : 1;
    const risk = p.size * p.riskPerContract;
    const micros = p.size * each;
    assert.ok(micros >= z.min_contracts, `${ticks} ticks: ${micros} micro-equivalents, under the floor`);
    assert.ok(risk <= S.cap + 1e-9 || (micros === z.min_contracts && p.root === S.legs.micro.root && risk <= z.floor_stretch_max_usd + 1e-9), `${ticks} ticks: ${p.size} ${p.root} risk $${risk.toFixed(2)}, over the cap and not the stretched floor`);
    assert.ok(micros <= prev, `${ticks} ticks: ${micros} micro-equivalents, more than the narrower stop's ${prev}`);
    prev = micros;
  }
  assert.ok(sized > 300 && ended, `the range sizes most stops and ends past the stretch (${sized})`);
});

test('parity: translateSize (live) is entryPlan (the rule) in the selected leg, stop by stop: micro and mini, healthy and drawn, the stretch and the healthy cap on and off, the broker\'s max', () => {
  const { entryPlan } = require('../../scripts/lib/prop/size-translate');
  const { decideSetup } = require('../../scripts/lib/prop/verdict');
  const combine = require('../../scripts/lib/trading/combine');
  const bars = [{ t: '2026-10-07T13:57:00.000Z', o: 21500, h: 21502, l: 21498, c: 21500, v: 1 }];
  let compared = 0;
  let healthyBound = 0;
  for (const [state, balance] of [['healthy', 50000], ['drawn', 49200]]) {
    const h = home(balance);
    const r = prop.readAttempt(h, MINI.name);
    const cs = prop.stateFrom(MINI, r, r.snapshot.balance);
    for (const [root, tv, fee] of [['MNQ', 0.5, 0.37], ['NQ', 5, 1.4]]) {
      for (const [stretch, healthy] of [[0, 0], [500, 0], [500, 450], [0, 500]]) {
        const pol = policy({ min_contracts: 3, floor_stretch_max_usd: stretch, healthy_risk_usd: healthy, cushion_frac: 0.5 });
        const { legs, ratio, mode } = prop.legsFor(MINI, root, specOf, [root]);
        for (let stopTicks = 20; stopTicks <= 400; stopTicks += 4) {
          for (const orderMax of [null, 5]) {
            const v = decideSetup({ account: MINI, cs, strategy: { ...pol, timeframe: '3m' }, component: 'trade_lifecycle', symbol: root, contractId: root, rawBars: bars, spec: specOf(root), scan: { direction: 'long', stopDistance: stopTicks * 0.25 }, now: NOW, specOf, selected: [root] });
            const live = translateSize({ suggested: 1, home: h, root, policy: pol, account: MINI, verdict: v, capUsd: 300, perContract: (stopTicks + 1) * tv + 2 * fee, specOf, selected: [root], orderMax });
            const rule = v.action === 'full' ? entryPlan({ dollars: combine.budget(cs, pol.sizing), room: combine.room(cs), stopTicks, legs, mode, guard: pol.sizing.min_size_guard, fraction: 1, ratio, slipTicks: 1, minContracts: 3 },
              { limits: { capUsd: 300, orderMax, sizeMax: v.maxSize }, healthyUsd: healthy, stretchUsd: stretch, state: { ...cs, lossesToday: 0 }, nearTargetUsd: 0 }) : null;
            assert.strictEqual(live.skip ? 0 : live.size, rule ? rule.size : 0, `${state} ${root} stretch ${stretch} healthy ${healthy} ${stopTicks} ticks max ${orderMax}: ${live.reason}`);
            if (rule && rule.size * rule.riskPerContract > 300 + 1e-9 && healthy > 300) healthyBound += 1;
            compared += 1;
          }
        }
      }
    }
  }
  assert.ok(compared > 3000 && healthyBound > 0, `${compared} compared, ${healthyBound} on the healthy cap`);
});

test('tick specs: live sizing takes the tick value from the broker\'s specs it is passed, never the table; none, or one that differs from the table, refuses', () => {
  const { brokerSpecs } = require('../../scripts/lib/trading/broker-specs');
  const { recordBrokerSpecs } = require('../helpers');
  // A server spec with another tick value (a test-only contract set): the size follows it. $0.25 a tick on MNQ: a
  // 40-tick stop is 41 x $0.25 + $0.74 = $11.99 a contract, $400 / 11.99 = 33 (the table's $0.50 would be 18).
  const quarter = r => (r === 'MNQ' || r === 'NQ' ? { tickSize: 0.25, tickValue: r === 'NQ' ? 2.5 : 0.25 } : null);
  const t = translateSize({ suggested: 1, home: home(), root: 'MNQ', policy: policy(), account: MINI, verdict: verdict({ maxSize: 50 }), capUsd: 1000, perContract: 10.99, specOf: quarter, selected: ['MNQ'] });
  assert.strictEqual(t.size, 36, t.reason);
  // The server's recorded spec that differs from the table: the spec source refuses it (docs/BROKER-MCP-INTERFACE.md,
  // "Tick specs"), and so does the translation.
  const h = home();
  const odd = brokerSpecs(recordBrokerSpecs(h, { roots: ['MNQ', 'NQ'], specs: { MNQ: { tickSize: 0.25, tickValue: 0.25 } } }));
  assert.strictEqual(odd('MNQ'), null);
  const refused = translateSize({ suggested: 1, home: h, root: 'MNQ', policy: policy(), account: MINI, verdict: verdict(), capUsd: 1000, perContract: 20, specOf: odd, selected: ['MNQ'] });
  assert.ok(refused.skip && /MNQ/.test(refused.reason), refused.reason);
  // No server spec at all: refused; and no spec source passed: refused, never the table.
  const none = translateSize({ suggested: 1, home: home(), root: 'MNQ', policy: policy(), account: MINI, verdict: verdict(), capUsd: 1000, perContract: 20, specOf: () => null, selected: ['MNQ'] });
  assert.ok(none.skip, none.reason);
  const unpassed = translateSize({ suggested: 1, home: home(), root: 'MNQ', policy: policy(), account: MINI, verdict: verdict(), capUsd: 1000, perContract: 20, selected: ['MNQ'] });
  assert.ok(unpassed.skip && /no broker tick specs/.test(unpassed.reason), unpassed.reason);
});

test('liveSizing: the run\'s Monte Carlo takes the composed cap, the broker\'s max and the contract the run traded', () => {
  const { liveSizing } = require('../../scripts/lib/prop/model-score');
  const pol = { name: 'prop_portfolio', strategies: ['trade_lifecycle'] };
  const comp = { name: 'trade_lifecycle', signal: 'composed', risk: { max_risk_usd: 300 } };
  const h = trendHome();
  // The broker's max order size as this home recorded it (the gate's own read).
  const { brokerOrderLimit, contractsFileFor } = require('../../scripts/lib/trading/broker-specs');
  const orderMax = brokerOrderLimit(contractsFileFor(h, {})).maxOrderSize;
  assert.ok(Number.isInteger(orderMax), 'the fixture home records one');
  assert.deepStrictEqual(liveSizing({ policy: pol, strategies: [pol, comp], home: h, runner: { symbols: ['MNQ'] }, env: {} }), { limits: { capUsd: 300, orderMax }, contracts: 'micro' });
  assert.strictEqual(liveSizing({ policy: pol, strategies: [pol, comp], home: tmpDirOf(), runner: {}, env: {} }).limits.orderMax, null, 'none recorded: no limit');
  assert.strictEqual(liveSizing({ policy: pol, strategies: [pol, comp], home: h, runner: { symbols: ['NQ'] }, env: {} }).contracts, 'mini');
  assert.strictEqual(liveSizing({ policy: pol, strategies: [pol, comp], home: h, runner: { symbols: ['MNQ', 'ES'] }, env: {} }).contracts, null, 'mixed legs: the policy\'s own');
  // No composed cap: the broker's max still applies (live translateSize takes it whatever the cap); neither: no limits.
  assert.deepStrictEqual(liveSizing({ policy: pol, strategies: [pol], home: h, runner: {}, env: {} }), { limits: { capUsd: null, orderMax }, contracts: null });
  assert.deepStrictEqual(liveSizing({ policy: pol, strategies: [pol], home: tmpDirOf(), runner: {}, env: {} }), { limits: null, contracts: null });
});

test('floorFit: the floor at the stop under the cap, counted as translateSize counts it; the widest stop that fits, worked by hand', () => {
  const { floorFit } = require('../../scripts/lib/prop/size-translate');
  // MNQ ($0.50 a tick, $0.37 a side, 1 tick of slippage): 197 ticks is (197 + 1) x $0.50 + $0.74 = $99.74 a contract,
  // 3 of them $299.22 under $300; 198 ticks is $100.24, 3 of them $300.72 over it. 197 ticks = 49.25 points.
  const mnq = t => floorFit({ capUsd: 300, floor: 3, stopTicks: t, tickValue: 0.5, slipTicks: 1, feePerSide: 0.37 });
  assert.deepStrictEqual(mnq(197), { fits: true, floor: 3, perContract: 99.74, capSize: 3, maxStopTicks: 197 });
  assert.deepStrictEqual(mnq(198), { fits: false, floor: 3, perContract: 100.24, capSize: 2, maxStopTicks: 197 });
  assert.strictEqual(mnq(267).perContract, 134.74, 'the replay\'s 267-tick stop: $134.74 a contract all in, as order_plan said');
  // MES ($1.25 a tick): 78 ticks is 79 x $1.25 + $0.74 = $99.49 (3: $298.47); 79 ticks $100.74 (3: $302.22). 19.5 points.
  const mes = t => floorFit({ capUsd: 300, floor: 3, stopTicks: t, tickValue: 1.25, slipTicks: 1, feePerSide: 0.37 });
  assert.deepStrictEqual([mes(78).fits, mes(79).fits, mes(79).maxStopTicks], [true, false, 78]);
  // Two ticks of slippage: (196 + 2) x $0.50 + $0.74 = $99.74; 197 ticks is $100.24. Under the minimum of 1, 1 counts.
  assert.strictEqual(floorFit({ capUsd: 300, floor: 3, stopTicks: 1, tickValue: 0.5, slipTicks: 2, feePerSide: 0.37 }).maxStopTicks, 196);
  assert.strictEqual(floorFit({ capUsd: 300, floor: 3, stopTicks: 1, tickValue: 0.5, slipTicks: 0, feePerSide: 0.37 }).maxStopTicks, 197);
  // A floor of 1: (597 + 1) x $0.50 + $0.74 = $299.74.
  assert.strictEqual(floorFit({ capUsd: 300, floor: 1, stopTicks: 1, tickValue: 0.5, slipTicks: 1, feePerSide: 0.37 }).maxStopTicks, 597);
  // A cap no stop fits: 0.
  assert.strictEqual(floorFit({ capUsd: 3, floor: 3, stopTicks: 10, tickValue: 0.5, slipTicks: 1, feePerSide: 0.37 }).maxStopTicks, 0);
  // Can't be priced: null (no fee is never assumed; no cap; no whole floor; no tick value).
  for (const o of [{ feePerSide: null }, { capUsd: 0 }, { floor: null }, { floor: 1.5 }, { tickValue: 0 }]) {
    assert.strictEqual(floorFit({ capUsd: 300, floor: 3, stopTicks: 100, tickValue: 0.5, slipTicks: 1, feePerSide: 0.37, ...o }), null, JSON.stringify(o));
  }
});

test('parity: noSizeFits refuses exactly the stops translateSize skips under the floor at the cap (MNQ and MES, stop by stop)', () => {
  const { noSizeFits, allInRisk } = require('../../scripts/lib/prop/size-translate');
  const acct = { ...MINI, max_contracts: { MNQ: 50, NQ: 5, MES: 50 }, fees_per_side: { MNQ: 0.37, NQ: 1.4, MES: 0.37 } };
  const spec = r => ({ MES: { tickSize: 0.25, tickValue: 1.25 }, ES: { tickSize: 0.25, tickValue: 12.5 } })[r] || specOf(r);
  const p = policy({ min_contracts: 3 });
  const h = home(50000, acct);
  for (const [root, lo, hi] of [['MNQ', 185, 205], ['MES', 70, 85]]) {
    let refusals = 0;
    for (let t = lo; t <= hi; t += 1) {
      const perContract = allInRisk({ stopTicks: t, tickValue: spec(root).tickValue, slipTicks: 1, feePerSide: 0.37 });
      const tr = translateSize({ suggested: 1, home: h, root, policy: p, account: acct, verdict: verdict({ contract: root, stopTicks: t, maxSize: 50 }), capUsd: 300, perContract, specOf: spec, selected: [root] });
      const refused = noSizeFits({ policy: p, account: acct, capUsd: 300, stop: { ticks: t, floorTicks: 1 }, spec: spec(root), root, strategy: 'trade_lifecycle', specOf: spec });
      assert.strictEqual(Boolean(refused), Boolean(tr.skip), `${root} ${t} ticks: ${tr.reason}`);
      if (refused) assert.match(tr.reason, /under the floor of 3 contracts/, `${root} ${t}`);
      refusals += refused ? 1 : 0;
    }
    assert.ok(refusals > 0 && refusals < hi - lo + 1, `${root}: both sides of the boundary are covered`);
  }
});

test('noSizeFits: the problem and the one hint, in ticks and points of the order\'s own contract; a floor that fits, or no attempt\'s sizing, is none', () => {
  const { noSizeFits } = require('../../scripts/lib/prop/size-translate');
  const p = policy({ min_contracts: 3 });
  const one = (root, ticks, o = {}) => noSizeFits({ policy: p, account: MINI, capUsd: 300, stop: { ticks, floorTicks: o.floorTicks ?? 40 }, spec: specOf(root), root, strategy: 'trade_lifecycle', specOf, ...o });
  // The replay's 267-tick MNQ stop: (267 + 1) x $0.50 + $0.74 = $134.74; 3 of them $404.22.
  assert.deepStrictEqual(one('MNQ', 267), {
    problem: 'no size fits: the floor of 3 MNQ (prop_portfolio\'s rulebook, sizing.min_contracts) at $134.74 a contract all in (the 267-tick stop with its slippage, and fees both ways) is $404.22, over trade_lifecycle\'s risk.max_risk_usd $300',
    hint: 'size: no size fits: 3 MNQ need a stop of 197 ticks (49.25 points) or less under the $300 cap; use a closer structural stop or skip',
  });
  assert.strictEqual(one('MNQ', 197), null, 'at the widest stop: it fits');
  assert.match(one('MNQ', 198).hint, /197 ticks \(49\.25 points\)/);
  // NQ: the floor of 3 micro-equivalents is 1 NQ ($5 a tick, $1.40 a side): (58 + 1) x $5 + $2.80 = $297.80; 59 ticks $302.80.
  assert.strictEqual(one('NQ', 58), null);
  assert.strictEqual(one('NQ', 59).hint, 'size: no size fits: 1 NQ need a stop of 58 ticks (14.5 points) or less under the $300 cap; use a closer structural stop or skip');
  // The widest stop that fits is under the record's minimum stop: skip, never a stop the plan refuses.
  assert.strictEqual(one('MNQ', 267, { floorTicks: 200 }).hint, 'size: no size fits: 3 MNQ fit under the $300 cap only at a stop of 197 ticks or less, under the minimum stop of 200: skip');
  // No policy, account, stop or spec, or an account with no fee: none (order_plan sizes or refuses the entry itself).
  for (const o of [{ policy: null }, { account: null }, { stop: null }, { spec: null }, { account: { ...MINI, fees_per_side: {} } }]) assert.strictEqual(one('MNQ', 267, o), null, JSON.stringify(Object.keys(o)));
});
